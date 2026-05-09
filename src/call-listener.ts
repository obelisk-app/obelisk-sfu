/**
 * Listens for kind 25052 control events addressed to the SFU.
 *
 * Filter: `{ kinds: [KIND_SFU_CONTROL], "#p": [SFU_PUBKEY], since: now-60 }`.
 * Each event runs through the validation pipeline in docs/sfu-system.md §3.2:
 *
 *   1. Signature already verified by SimplePool.
 *   2. NIP-40 expiration not in the past.
 *   3. allow-list / operator / host check (action-specific).
 *   4. dispatch to RoomManager.
 *
 * Validation failures are silent drops. No reply events. The user finds
 * out by observing the absence of a kind 31314 update.
 */
import type { Event } from 'nostr-tools';

import { KIND_SFU_CONTROL } from './nip-kinds.js';
import { createLogger } from './log.js';
import { isAllowedToStart, canManageRoom, isTrustedAuthorRelay } from './auth.js';
import type { Config } from './config.js';
import type { RelayPool } from './relay.js';
import type { RoomManager } from './room-manager.js';
import type { Hex, RoomRules, SfuControlPayload, SfuControlAction } from './types.js';

const log = createLogger('call-listener');

const STARTING_RULES: RoomRules = {
  video: true,
  screen: true,
  allow: null,
  deny: [],
  maxParticipants: null,
  endsAt: null,
};

export class CallListener {
  /**
   * url → unsubscribe function for that relay's individual subscription.
   * The watchdog rebuilds entries here on a per-relay basis when the
   * underlying stream goes silent, without disturbing peer relays.
   */
  private subscriptions = new Map<string, () => void>();
  /**
   * Filter we re-use on every (re)subscribe. Captured at start() time so
   * `since` reflects boot, not the moment of the resubscribe — otherwise
   * a watchdog rebuild would skip events the original subscription was
   * already filtering for.
   */
  private filter: { kinds: number[]; since: number } | null = null;
  private watchdogTimer: NodeJS.Timeout | null = null;
  /**
   * Event-id → expiry timestamp (unix seconds). We subscribe per relay
   * (so we can distinguish trusted vs untrusted sources), so an event
   * published to multiple relays will be delivered multiple times.
   * Dedupe so the action runs at most once per event id.
   */
  private seenEventIds = new Map<string, number>();

  /** How often the watchdog checks each relay's last-seen timestamp. */
  static readonly WATCHDOG_INTERVAL_MS = 30_000;
  /**
   * If a relay hasn't delivered an event OR an EOSE in this window,
   * the watchdog tears down its subscription and rebuilds it. Five minutes
   * is long enough to ride out a quiet but live relay (control traffic is
   * sparse) and short enough that recovery happens within one user attempt.
   */
  static readonly WATCHDOG_STALENESS_MS = 5 * 60_000;

  constructor(
    private readonly cfg: Config,
    private readonly relay: RelayPool,
    private readonly rooms: RoomManager,
  ) {}

  start(): void {
    if (this.subscriptions.size > 0) return;
    const since = Math.floor(Date.now() / 1000) - 60;
    this.filter = { kinds: [KIND_SFU_CONTROL], since };
    // Subscribe per-relay so we know which relay delivered each event.
    // Events seen on a trusted-author relay bypass the allow.json check
    // (the relay's own write-whitelist authorized the publisher).
    //
    // We also drop the `#p` filter — some relays don't index `#p` on
    // ephemeral kinds — and gate by p-tag in `handle()`.
    const allRelays = Array.from(
      new Set([...this.cfg.relays, ...this.cfg.trustedAuthorRelays]),
    );
    for (const url of allRelays) this.subscribeRelay(url);

    log.info('listening for control events', {
      pubkey: this.relay.pubkey.slice(0, 12) + '…',
      relays: allRelays.length,
      trusted: this.cfg.trustedAuthorRelays.length,
    });

    // Watchdog: detect silently-dead per-relay subscriptions and rebuild
    // them. Without this, a relay disconnect leaves the SFU appearing alive
    // (HTTP up, process running) but deaf to incoming `start` events — the
    // pre-fix failure mode that forced the operator to mash the Restart
    // button before every call.
    this.watchdogTimer = setInterval(() => this.tickWatchdog(), CallListener.WATCHDOG_INTERVAL_MS);
    this.watchdogTimer.unref?.();
  }

  stop(): void {
    if (this.watchdogTimer) {
      clearInterval(this.watchdogTimer);
      this.watchdogTimer = null;
    }
    for (const unsub of this.subscriptions.values()) {
      try { unsub(); } catch { /* best effort */ }
    }
    this.subscriptions.clear();
    this.filter = null;
  }

  /**
   * Per-relay snapshot for the admin UI. Pairs the RelayPool's
   * lastEventAt with whether we currently hold a subscription on this
   * URL — `subscribed=false` means the listener never wired this relay
   * (e.g., the URL was added at runtime but not yet picked up).
   */
  getRelayStatus(): Array<{ url: string; subscribed: boolean }> {
    return [...this.subscriptions.keys()].map((url) => ({ url, subscribed: true }));
  }

  private subscribeRelay(url: string): void {
    if (!this.filter) return;
    // Tear down any existing subscription for this URL first so a watchdog
    // rebuild doesn't leak the previous nostr-tools sub object.
    const prev = this.subscriptions.get(url);
    if (prev) {
      try { prev(); } catch { /* best effort */ }
    }
    const unsub = this.relay.subscribeOneRelay(
      url,
      this.filter,
      (ev, source) => this.handle(ev, source),
    );
    this.subscriptions.set(url, unsub);
  }

  private tickWatchdog(): void {
    const nowSec = Math.floor(Date.now() / 1000);
    const stalenessSec = Math.floor(CallListener.WATCHDOG_STALENESS_MS / 1000);
    for (const url of this.subscriptions.keys()) {
      const last = this.relay.getLastEventAt(url);
      const ageSec = last == null ? Infinity : nowSec - last;
      if (ageSec > stalenessSec) {
        log.warn('subscription stale, resubscribing', { relay: url, ageSec });
        this.subscribeRelay(url);
        // Grace window: subscribeOneRelay touches lastEventAt to "now",
        // so the next watchdog tick won't immediately re-flag this URL
        // even if the underlying socket is still wedged. By the time the
        // grace window elapses we'll either have seen an EOSE/event (good)
        // or we'll resubscribe again (still better than the pre-fix coma).
      }
    }
  }

  /** Returns true if this is the first time we see the event id. */
  private rememberEvent(id: string): boolean {
    this.gcSeen();
    if (this.seenEventIds.has(id)) return false;
    // 5-minute TTL — control events are ephemeral and short-lived.
    this.seenEventIds.set(id, Math.floor(Date.now() / 1000) + 300);
    return true;
  }

  private gcSeen(): void {
    if (this.seenEventIds.size < 256) return;
    const now = Math.floor(Date.now() / 1000);
    for (const [id, exp] of this.seenEventIds) {
      if (exp < now) this.seenEventIds.delete(id);
    }
  }

  private handle(ev: Event, sourceRelay: string): void {
    // Gate by p-tag — we subscribe broadly to work around relays that
    // don't index `#p` on ephemeral kinds.
    const targetedAtUs = ev.tags.some(
      (t) => t[0] === 'p' && t[1] === this.relay.pubkey,
    );
    if (!targetedAtUs) return;

    // Per-relay subscriptions can deliver the same event multiple times.
    // First-write wins; subsequent deliveries are dropped at this gate.
    if (!this.rememberEvent(ev.id)) return;

    // Defensive: SimplePool already verifies sigs but we check the tag set.
    const channelTag = ev.tags.find((t) => t[0] === 'e')?.[1];
    if (!channelTag) {
      log.debug('drop control: missing #e', { id: ev.id.slice(0, 8) });
      return;
    }

    if (isExpired(ev)) {
      log.debug('drop control: expired', { id: ev.id.slice(0, 8) });
      return;
    }

    let payload: SfuControlPayload;
    try {
      payload = JSON.parse(ev.content) as SfuControlPayload;
    } catch {
      log.debug('drop control: bad json', { id: ev.id.slice(0, 8) });
      return;
    }

    const action = payload.action as SfuControlAction;
    const fromTrustedRelay = isTrustedAuthorRelay(this.cfg, sourceRelay);
    log.info('control received', {
      action,
      from: ev.pubkey.slice(0, 8),
      channel: channelTag.slice(0, 8),
      via: sourceRelay,
      trusted: fromTrustedRelay,
    });

    switch (action) {
      case 'start':
        return void this.handleStart(ev.pubkey, channelTag, payload, fromTrustedRelay);
      case 'end':
        return void this.handleEnd(ev.pubkey, channelTag);
      case 'kick':
        return void this.handleKick(ev.pubkey, channelTag, payload);
      case 'update':
        return void this.handleUpdate(ev.pubkey, channelTag, payload);
      default:
        log.debug('drop control: unknown action', { action });
    }
  }

  private async handleStart(
    sender: Hex,
    channelId: string,
    payload: SfuControlPayload,
    fromTrustedRelay: boolean,
  ): Promise<void> {
    // Two-layer auth.
    //
    // Default (back-compat): trusted-relay event-source is enough — the
    // relay's write-whitelist already proved the sender is authorized.
    // The local allow.json / SFU_ALLOWED_PUBKEYS is the manual fallback.
    //
    // requireAllowedPubkey=1: every `start` MUST also pass the local
    // allow-list (or be the operator). Use this when you don't fully
    // trust the relay's ACL — e.g., a relay whose write rules accidentally
    // went open authorizes the world unless this flag is set. Multiple
    // operators sharing one SFU also want this on so per-channel control
    // stays meaningful.
    const passesAllowList = isAllowedToStart(this.cfg, this.relay.pubkey, sender);
    const authorized = this.cfg.requireAllowedPubkey
      ? passesAllowList
      : fromTrustedRelay || passesAllowList;
    if (!authorized) {
      log.warn('start rejected: sender not authorized', {
        sender: sender.slice(0, 8),
        viaTrustedRelay: fromTrustedRelay,
        passesAllowList,
        strict: this.cfg.requireAllowedPubkey,
      });
      return;
    }

    const existing = this.rooms.get(channelId);
    if (existing) {
      log.info('start ignored: room already active', { channelId: channelId.slice(0, 8) });
      return;
    }

    if (this.rooms.size() >= this.cfg.maxRooms) {
      log.warn('start rejected: max_rooms reached', { max: this.cfg.maxRooms });
      return;
    }

    const rules = mergeRules(STARTING_RULES, payload.params);

    try {
      await this.rooms.start(channelId, sender, rules);
      log.info('start accepted', {
        host: sender.slice(0, 8),
        channelId: channelId.slice(0, 8),
        rules: { video: rules.video, screen: rules.screen, allow: rules.allow?.length ?? 'any' },
      });
    } catch (err) {
      log.error('start failed', {
        channelId: channelId.slice(0, 8),
        err: (err as Error).message,
      });
    }
  }

  private async handleEnd(sender: Hex, channelId: string): Promise<void> {
    const room = this.rooms.get(channelId);
    if (!room) {
      log.debug('end ignored: no active room', { channelId: channelId.slice(0, 8) });
      return;
    }
    if (!canManageRoom(this.cfg, this.relay.pubkey, sender, room.hostPubkey)) {
      log.warn('end rejected: sender not host or operator', { sender: sender.slice(0, 8) });
      return;
    }
    await this.rooms.end(channelId);
  }

  private async handleKick(
    sender: Hex,
    channelId: string,
    payload: SfuControlPayload,
  ): Promise<void> {
    const room = this.rooms.get(channelId);
    if (!room) return;
    if (!canManageRoom(this.cfg, this.relay.pubkey, sender, room.hostPubkey)) {
      log.warn('kick rejected: sender not host or operator', { sender: sender.slice(0, 8) });
      return;
    }
    const target = payload.params?.target;
    if (!target || !/^[0-9a-f]{64}$/i.test(target)) {
      log.debug('kick: invalid target', { target });
      return;
    }
    await room.kick(target.toLowerCase(), payload.params?.reason);
  }

  private async handleUpdate(
    sender: Hex,
    channelId: string,
    payload: SfuControlPayload,
  ): Promise<void> {
    const room = this.rooms.get(channelId);
    if (!room) return;
    if (!canManageRoom(this.cfg, this.relay.pubkey, sender, room.hostPubkey)) {
      log.warn('update rejected: sender not host or operator', { sender: sender.slice(0, 8) });
      return;
    }
    room.updateRules(mergeRules(room.rules, payload.params));
  }
}

function isExpired(ev: Event): boolean {
  const tag = ev.tags.find((t) => t[0] === 'expiration')?.[1];
  if (!tag) return false;
  const ts = parseInt(tag, 10);
  if (!Number.isFinite(ts)) return false;
  return ts < Math.floor(Date.now() / 1000);
}

function mergeRules(base: RoomRules, params: SfuControlPayload['params']): RoomRules {
  if (!params) return base;
  return {
    video: params.video ?? base.video,
    screen: params.screen ?? base.screen,
    allow: params.allow !== undefined ? params.allow : base.allow,
    deny: params.deny ?? base.deny,
    maxParticipants: params.maxParticipants !== undefined ? params.maxParticipants : base.maxParticipants,
    endsAt: params.endsAt !== undefined ? params.endsAt : base.endsAt,
  };
}
