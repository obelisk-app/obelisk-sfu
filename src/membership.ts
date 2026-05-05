/**
 * NIP-29 admin/member tracking per channel. The SFU joins many channels
 * over its lifetime; for each, it needs the kind 39001 / 39002 lists to
 * gate dial-ins.
 *
 * `created_at`-newest-wins. We keep one subscription per channel; the
 * pool manages relay reconnect underneath so a relay blip doesn't lose
 * us the lists permanently.
 */
import type { Event } from 'nostr-tools';

import { KIND_NIP29_GROUP_ADMINS, KIND_NIP29_GROUP_MEMBERS } from './nip-kinds.js';
import { createLogger } from './log.js';
import type { RelayPool } from './relay.js';
import type { Hex } from './types.js';

const log = createLogger('membership');

interface ChannelState {
  members: Set<Hex>;
  membersAt: number;
  admins: Set<Hex>;
  adminsAt: number;
  /** Resolved when EITHER list arrives — we don't block on both. */
  ready: Promise<void>;
  resolveReady: () => void;
  unsub: () => void;
  refcount: number;
}

const READY_TIMEOUT_MS = 8000;

function pubkeysFromTags(tags: string[][]): Hex[] {
  return tags
    .filter((t) => t[0] === 'p' && typeof t[1] === 'string' && /^[0-9a-f]{64}$/i.test(t[1]))
    .map((t) => (t[1] as string).toLowerCase());
}

export class MembershipTracker {
  private readonly channels = new Map<string, ChannelState>();

  constructor(private readonly relay: RelayPool) {}

  /**
   * Subscribe (or refcount up) to a channel's admin/member lists. Returns
   * a release fn — when the last caller releases, the subscription is
   * torn down.
   *
   * The returned `ready` promise resolves when the first list (admins or
   * members) arrives, or rejects after `READY_TIMEOUT_MS`. Callers should
   * use it to gate dial-time decisions: better to refuse a `start` than
   * to admit dials with an empty member set.
   */
  watch(channelId: string): { release: () => void; ready: Promise<void> } {
    const existing = this.channels.get(channelId);
    if (existing) {
      existing.refcount++;
      return {
        release: () => this.release(channelId),
        ready: existing.ready,
      };
    }

    let resolveReady: () => void = () => undefined;
    let rejectReady: (err: Error) => void = () => undefined;
    const ready = new Promise<void>((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });

    const state: ChannelState = {
      members: new Set(),
      membersAt: 0,
      admins: new Set(),
      adminsAt: 0,
      ready,
      resolveReady,
      unsub: () => undefined,
      refcount: 1,
    };
    this.channels.set(channelId, state);

    const timeout = setTimeout(() => {
      if (state.members.size === 0 && state.admins.size === 0) {
        log.warn('membership lists never arrived', { channelId, timeout: READY_TIMEOUT_MS });
        rejectReady(new Error('membership lists timeout'));
      }
    }, READY_TIMEOUT_MS);

    state.unsub = this.relay.subscribe(
      {
        kinds: [KIND_NIP29_GROUP_ADMINS, KIND_NIP29_GROUP_MEMBERS],
        '#d': [channelId],
      },
      (ev) => this.ingest(channelId, ev),
    );

    // Clear the timeout once we hear from either list, regardless of which.
    void ready.finally(() => clearTimeout(timeout)).catch(() => undefined);

    log.info('watching channel', { channelId: shortId(channelId) });
    return {
      release: () => this.release(channelId),
      ready,
    };
  }

  private ingest(channelId: string, ev: Event): void {
    const state = this.channels.get(channelId);
    if (!state) return;

    const pubkeys = pubkeysFromTags(ev.tags);

    if (ev.kind === KIND_NIP29_GROUP_MEMBERS) {
      if (ev.created_at < state.membersAt) return;
      state.members = new Set(pubkeys);
      state.membersAt = ev.created_at;
      log.debug('members updated', { channelId: shortId(channelId), count: pubkeys.length });
    } else if (ev.kind === KIND_NIP29_GROUP_ADMINS) {
      if (ev.created_at < state.adminsAt) return;
      state.admins = new Set(pubkeys);
      state.adminsAt = ev.created_at;
      log.debug('admins updated', { channelId: shortId(channelId), count: pubkeys.length });
    }

    state.resolveReady();
  }

  private release(channelId: string): void {
    const state = this.channels.get(channelId);
    if (!state) return;
    state.refcount--;
    if (state.refcount > 0) return;
    state.unsub();
    this.channels.delete(channelId);
    log.info('released channel', { channelId: shortId(channelId) });
  }

  getMembers(channelId: string): ReadonlySet<Hex> {
    return this.channels.get(channelId)?.members ?? new Set();
  }

  getAdmins(channelId: string): ReadonlySet<Hex> {
    return this.channels.get(channelId)?.admins ?? new Set();
  }
}

function shortId(id: string): string {
  return id.length > 8 ? `${id.slice(0, 8)}…` : id;
}
