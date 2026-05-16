/**
 * Publish + refresh the SFU's kind 31313 advertisement.
 *
 * This is what users (and other clients) discover when they search for
 * available SFUs. Publishing is idempotent — kind 31313 is parameterized
 * replaceable on `d="obelisk-sfu"`, so re-publishing simply overwrites.
 *
 * We re-publish when:
 *   - the process boots
 *   - the allow-list reloads (SIGHUP)
 *   - every REFRESH_INTERVAL_MS as a heartbeat (in case the relay forgot)
 */
import { randomBytes } from 'node:crypto';

import type { Config } from './config.js';
import { KIND_SFU_ADVERTISEMENT } from './nip-kinds.js';
import { createLogger } from './log.js';
import type { RelayPool } from './relay.js';

const log = createLogger('advertise');

/**
 * How often we re-publish kind 31313. Pre-fix this was 6 h, which meant a
 * relay losing the parameterized-replaceable event left clients unable to
 * discover the SFU for hours. Five minutes is short enough that any
 * forgetful relay catches the next refresh within one user attempt, and
 * cheap enough (12 publishes/h × N relays) that bandwidth is a non-issue.
 */
const REFRESH_INTERVAL_MS = 5 * 60 * 1000;

export class Advertiser {
  private timer: NodeJS.Timeout | null = null;
  /**
   * Per-process session id. Re-rolled on every boot so clients comparing
   * the advertised value to a cached one can detect "the SFU restarted,
   * drop all in-flight transport state and rejoin." Without this, clients
   * keep their WebRTC transports open after a restart while the SFU has
   * no record of them — the dex's only signal today is the absence of
   * the kind 20078 beacon, which races a watchdog timeout. See bug #5.
   */
  private readonly sessionId: string = randomBytes(8).toString('hex');
  private readonly bootedAt: number = Math.floor(Date.now() / 1000);
  /**
   * Unix-seconds timestamp of the last advertise publish that resolved
   * (any relay accepting it counts). Surfaced via {@link getStatus} so
   * the admin UI can show "last advertised X ago" — a more useful health
   * signal than uptime alone, since a relay-deaf SFU can have great uptime
   * and a stale advertisement at the same time.
   */
  private lastPublishAt: number | null = null;
  /** Same as {@link lastPublishAt} but for failures. */
  private lastPublishErrAt: number | null = null;

  constructor(
    private readonly cfg: Config,
    private readonly relay: RelayPool,
  ) {}

  async start(): Promise<void> {
    // Kind 0 first so any subscriber that fetches the advertisement (kind
    // 31313) and then resolves the operator's profile gets a real avatar
    // + display name instead of a bare hex pubkey. Best-effort — failure
    // here doesn't stop the SFU from serving.
    await this.publishProfile().catch((err) =>
      log.warn('profile publish failed', { err: (err as Error).message }),
    );
    await this.publishOnce();
    this.timer = setInterval(() => {
      void this.publishOnce().catch((err) =>
        log.warn('refresh failed', { err: (err as Error).message }),
      );
    }, REFRESH_INTERVAL_MS);
    // Don't keep the event loop alive solely for the heartbeat.
    this.timer.unref?.();
  }

  getStatus(): {
    sessionId: string;
    bootedAt: number;
    lastPublishAt: number | null;
    lastPublishErrAt: number | null;
    refreshIntervalMs: number;
  } {
    return {
      sessionId: this.sessionId,
      bootedAt: this.bootedAt,
      lastPublishAt: this.lastPublishAt,
      lastPublishErrAt: this.lastPublishErrAt,
      refreshIntervalMs: REFRESH_INTERVAL_MS,
    };
  }

  /**
   * Publish a kind 0 metadata event so the SFU shows up in clients with
   * a real name + avatar. Same shape as `src/scripts/price-bot.mjs`.
   * Refreshed on SIGHUP via {@link Advertiser.republish}.
   */
  async publishProfile(): Promise<void> {
    const name = 'Obelisk SFU';
    const about = 'Mediasoup-backed selective forwarding unit for Obelisk voice/video rooms. '
      + `Capacity ${this.cfg.maxParticipantsPerRoom}/room, ${this.cfg.maxRooms} concurrent rooms. `
      + (this.cfg.publicUrl ? `Reachable at ${this.cfg.publicUrl}.` : '');
    const profile = {
      name,
      display_name: name,
      about,
      // Public-domain "satellite dish" icon — a recognisable "this account
      // is infrastructure, not a person" cue in the dex's profile popover.
      picture: 'https://upload.wikimedia.org/wikipedia/commons/thumb/4/4d/OOjs_UI_icon_play.svg/240px-OOjs_UI_icon_play.svg.png',
      bot: true,
    };
    await this.relay.publish({
      kind: 0,
      content: JSON.stringify(profile),
      tags: [],
      created_at: Math.floor(Date.now() / 1000),
    });
    log.info('profile published', { pubkey: this.relay.pubkey.slice(0, 12) + '…', name });
  }

  /**
   * Force a re-publish — call this after any operator-driven config change
   * that should be reflected publicly (allow-list edit, capacity bump).
   */
  async republish(): Promise<void> {
    await this.publishOnce();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async publishOnce(): Promise<void> {
    const tags: string[][] = [
      ['d', 'obelisk-sfu'],
      ['t', 'obelisk-sfu-advertisement'],
      ['cap', String(this.cfg.maxParticipantsPerRoom)],
      ['max_rooms', String(this.cfg.maxRooms)],
      ['version', '1'],
      // Session id changes on every restart. Clients cache the value
      // alongside their transport state; if they observe a different
      // value on the next advertisement, the SFU has been restarted
      // and any in-memory peer/transport assumptions are stale —
      // drop them and rejoin.
      ['session', this.sessionId],
      ['booted_at', String(this.bootedAt)],
    ];

    if (this.cfg.publicUrl) tags.push(['url', this.cfg.publicUrl]);
    for (const r of this.cfg.relays) tags.push(['relay', r]);
    // Trusted-author relays — clients should send their kind 25052
    // `start` events here. The relay's write-whitelist authorizes
    // them automatically; no per-user allow-list maintenance.
    for (const r of this.cfg.trustedAuthorRelays) tags.push(['trusted_relay', r]);

    // Codecs the SFU forwards. Keep this aligned with
    // ROUTER_MEDIA_CODECS in mediasoup-server.ts.
    tags.push(['codec', 'opus']);
    tags.push(['codec', 'vp8']);

    for (const pk of this.cfg.allowedPubkeys) tags.push(['allow', pk]);

    const operator = this.cfg.operatorPubkey ?? this.relay.pubkey;
    tags.push(['operator', operator]);

    if (this.cfg.region) tags.push(['region', this.cfg.region]);

    // Capture the second-precision timestamp BEFORE awaiting so we can
    // tell, after the fact, whether any relay's lastPublishOk advanced
    // during this attempt. RelayPool.publish() doesn't surface success/
    // failure (it logs and resolves regardless, by design — many callers
    // rely on the swallow-failures contract for non-critical events), but
    // its per-relay maps record both outcomes; we read from those.
    const startedAt = Math.floor(Date.now() / 1000);
    await this.relay.publish({
      kind: KIND_SFU_ADVERTISEMENT,
      content: '',
      tags,
      created_at: Math.floor(Date.now() / 1000),
    });
    const health = this.relay.getRelayHealth();
    const ackedRelay = health.find((h) => h.lastPublishOk != null && h.lastPublishOk >= startedAt);
    if (ackedRelay) {
      this.lastPublishAt = Math.floor(Date.now() / 1000);
    } else {
      this.lastPublishErrAt = Math.floor(Date.now() / 1000);
    }
    log.info('advertisement published', {
      pubkey: this.relay.pubkey.slice(0, 12) + '…',
      allowed: this.cfg.allowedPubkeys.size,
      cap: this.cfg.maxParticipantsPerRoom,
      url: this.cfg.publicUrl ?? '(unset)',
      ack: ackedRelay?.url ?? null,
    });
  }
}
