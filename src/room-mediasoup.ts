/**
 * Mediasoup-backed Room. One per active SFU call.
 *
 * Holds:
 *   - Exactly one mediasoup Router for the channel (lazy-allocated).
 *   - Per-pubkey RecvTransport + SendTransport pair (created on first
 *     `createWebRtcTransport` request from that peer).
 *   - The producer table: every track ingressed from any peer, indexed
 *     by Producer.id. New consumers get an auto-`consume()` for each
 *     existing producer (that isn't their own) on next request.
 *
 * Differences from the werift Room:
 *   - No `forwardTrack()` — the engine pushes Producers and clients pull
 *     them via `consume`. The bridge sends `newProducer` notifications
 *     so clients know to call back.
 *   - No m-line ordering / glare hacks — mediasoup negotiates per-transport
 *     once and then runs RPC for producer/consumer add/remove without
 *     touching SDP.
 *   - No PT remap, no codec preference shimming. The Router advertises a
 *     fixed codec list (audio/opus + video/VP8|VP9|H264) and the client
 *     `Device.load(rtpCapabilities)` agrees ahead of time.
 */
import type { types as ms } from 'mediasoup';

import { canDialRoom } from './auth.js';
import { KIND_SFU_ACTIVE_CALL, KIND_VOICE_SIGNAL } from './nip-kinds.js';
import { createLogger } from './log.js';
import { publishSfuBeacon } from './signaling.js';
import { dispatchRequest, parseEnvelope, RpcError } from './nostr-rpc.js';
import type { RpcContext, RpcHandlerMap, RpcNotification } from './nostr-rpc.js';
import type { Config } from './config.js';
import type { MediasoupEngine } from './mediasoup-server.js';
import type { MembershipTracker } from './membership.js';
import type { RelayPool } from './relay.js';
import type { Hex, RoomRules, RoomSnapshot, RoomStatus } from './types.js';

const log = createLogger('room-ms');

/**
 * Voice kinds the dex publishes. Bug #8 — keep this list explicit so
 * any future appData sanitization layer doesn't accidentally drop
 * `screen-audio` (which the dex uses for system-audio of a screenshare,
 * e.g. browser tab audio). If a producer's appData carries an unknown
 * kind, fall back to the safe default for the underlying media kind.
 */
const VALID_VOICE_KINDS: ReadonlyArray<'audio' | 'camera' | 'screen' | 'screen-audio'> = [
  'audio',
  'camera',
  'screen',
  'screen-audio',
];

function sanitizeVoiceKind(
  raw: unknown,
  mediaKind: 'audio' | 'video',
): 'audio' | 'camera' | 'screen' | 'screen-audio' {
  if (typeof raw === 'string'
    && (VALID_VOICE_KINDS as ReadonlyArray<string>).includes(raw)) {
    return raw as 'audio' | 'camera' | 'screen' | 'screen-audio';
  }
  return mediaKind === 'audio' ? 'audio' : 'camera';
}

const BEACON_INTERVAL_MS = 15_000;
const ACTIVE_CALL_INTERVAL_MS = 60_000;
const ACTIVE_CALL_TTL_SECONDS = 90;
/**
 * How long ICE or DTLS may stay disconnected/failed before we drop the
 * peer (bug #6). 15 s — long enough to ride a typical wifi blip, short
 * enough that a real disconnect doesn't leave a stale tile up.
 */
const TRANSPORT_UNHEALTHY_TIMEOUT_MS = 15_000;
/**
 * Activity-based reaper (bug #7) — how often to walk the peer table
 * looking for stale entries.
 */
const REAPER_INTERVAL_MS = 5_000;
/**
 * Drop a peer whose latest inbound RTP packet (across any producer) was
 * older than this. Long enough to ride a normal mute + brief jitter,
 * short enough that a frozen tab clears within ~30 s.
 */
const RTP_INACTIVITY_TIMEOUT_MS = 30_000;
/**
 * For peers that joined but never published — still reap them after
 * this many seconds of no RTP at all. Keeps zombie joins from holding
 * a roster slot indefinitely.
 */
const NO_PRODUCER_TIMEOUT_MS = 45_000;

/**
 * Per-peer map key. Composed from pubkey + clientId so two devices
 * sharing a Nostr pubkey produce distinct entries — the pre-multi-device
 * code keyed on pubkey alone, which made the second device's
 * `createWebRtcTransport` reuse + close the first device's transports.
 */
function peerKey(pubkey: Hex, clientId: string): string {
  return `${pubkey}|${clientId}`;
}

/**
 * Synthetic / test producers (admin-injected via /test/inject) don't have
 * a real RPC connection, so they don't carry a clientId. We park them
 * under this stable id so the peers map stays well-formed without
 * colliding with any real client (clientIds are random hex strings).
 */
const SYNTHETIC_CLIENT_ID = '_synthetic';

/**
 * Stable clientId for legacy clients (pre-multi-device build) that don't
 * include a `clientId` in their RPC envelopes. Two legacy devices for
 * the same pubkey will still collide on the same slot — same as the old
 * behavior — but we don't intentionally break them.
 */
const LEGACY_CLIENT_ID = '_legacy';

export interface MediasoupRoomOptions {
  channelId: string;
  hostPubkey: Hex;
  rules: RoomRules;
  cfg: Config;
  engine: MediasoupEngine;
  relay: RelayPool;
  membership: MembershipTracker;
  onClosed: (channelId: string) => void;
}

interface PeerState {
  pubkey: Hex;
  /**
   * Per-connection id minted by the client (a fresh hex string per
   * SfuClient construction). Two devices sharing a Nostr pubkey produce
   * two distinct PeerStates so transports/producers/consumers don't
   * collide. Falls back to `'_legacy'` for old clients that didn't
   * send the field — those keep the pre-multi-device behavior of
   * collapsing onto one slot per pubkey.
   */
  clientId: string;
  /** WebRTC transport the peer publishes to (browser → SFU media). */
  sendTransport?: ms.WebRtcTransport;
  /** WebRTC transport the SFU pushes media on (SFU → browser). */
  recvTransport?: ms.WebRtcTransport;
  /** Producers this peer has open on its sendTransport. */
  producers: Map<string, ms.Producer>;
  /** Consumers we created on the peer's recvTransport (key: producerId). */
  consumers: Map<string, ms.Consumer>;
  /** Voice-level metadata per producer (camera vs screen, origin, etc.). */
  producerAppData: Map<string, { kind: 'audio' | 'camera' | 'screen' | 'screen-audio'; originPubkey: Hex }>;
  /**
   * Per-transport sweep timers — armed when ICE/DTLS goes bad, cancelled
   * when it recovers. If still bad after `TRANSPORT_UNHEALTHY_TIMEOUT_MS`
   * the peer is dropped via `handlePeerLeft`. Keyed by transport id.
   */
  unhealthyTimers: Map<string, ReturnType<typeof setTimeout>>;
  /**
   * Most recent time the reaper observed packetCount across all
   * producers increase (ms since epoch). Drives the activity-based
   * reaper (bug #7) — independent of ICE/DTLS health, since mobile
   * background-throttle and OS suspend can keep a transport "healthy"
   * while no actual RTP flows.
   */
  lastInboundPacketAt: number;
  /** Sum of packetCount across producers as of `lastInboundPacketAt`. */
  lastSeenPacketCount: number;
  /** Created-at — used by the reaper as a fallback for joined-but-silent peers. */
  joinedAt: number;
}

export class MediasoupRoom {
  private readonly channelId: string;
  readonly hostPubkey: Hex;
  // Mutable so `updateRules` can swap in a new ruleset while the room is
  // alive (host changes camera/screen permission mid-call).
  private _rules: RoomRules;
  private readonly cfg: Config;
  private readonly engine: MediasoupEngine;
  private readonly relay: RelayPool;
  private readonly membership: MembershipTracker;
  private readonly onClosed: (channelId: string) => void;

  private router: ms.Router | null = null;
  /**
   * Active peers keyed by `peerKey(pubkey, clientId)` so two devices
   * sharing a pubkey get distinct slots. Use {@link peerKey} for any
   * map mutation; iteration via `.values()` continues to give back
   * `PeerState`s and is unaffected by the keying change.
   */
  private readonly peers = new Map<string, PeerState>();

  private signalUnsub: (() => void) | null = null;
  private membershipRelease: (() => void) | null = null;

  private beaconTimer: ReturnType<typeof setInterval> | null = null;
  private activeCallTimer: ReturnType<typeof setInterval> | null = null;
  /**
   * Periodically walks `this.peers`, calls getStats() on each producer,
   * and reaps peers whose packet count hasn't moved for
   * `RTP_INACTIVITY_TIMEOUT_MS`. See bug #7 — only RTP flow is the
   * ground truth for "is this peer actually doing anything."
   */
  private reaperTimer: ReturnType<typeof setInterval> | null = null;
  /**
   * Empty-room grace timer. Closes the room {@link Config.emptyGraceSeconds}
   * after the last peer leaves; cleared the moment a new peer joins. Pre-fix
   * the mediasoup room had no empty-grace at all (only the legacy werift
   * room did) so a room with everyone gone stayed `active` forever and
   * kept publishing kind 31314 status='active' — clients would see a phantom
   * "live call" badge in channels nobody was actually in.
   */
  private emptyTimer: ReturnType<typeof setTimeout> | null = null;

  private _status: RoomStatus = 'starting';
  private startedAt = 0;

  constructor(opts: MediasoupRoomOptions) {
    this.channelId = opts.channelId;
    this.hostPubkey = opts.hostPubkey;
    this._rules = opts.rules;
    this.cfg = opts.cfg;
    this.engine = opts.engine;
    this.relay = opts.relay;
    this.membership = opts.membership;
    this.onClosed = opts.onClosed;
  }

  get status(): RoomStatus {
    return this._status;
  }

  /** Read-only rules accessor — call-listener uses this for `updateRules`. */
  get rules(): RoomRules {
    return this._rules;
  }

  /**
   * Replace the active ruleset. Most fields take effect on the next dial
   * gate check; v1 doesn't proactively renegotiate when, e.g., `video` is
   * flipped to false (consumers stay open until the producer is closed
   * separately). That parity gap with the werift Room is acceptable for
   * v1 because the host UI flips both rules + producer in tandem.
   */
  updateRules(rules: RoomRules): void {
    this._rules = rules;
  }

  /**
   * Test-only: inject a producer fed by an external RTP source (typically
   * ffmpeg). Creates a `PlainTransport` on the room's router, returns the
   * RTP/RTCP listening address + the SSRC + payload type the caller should
   * use. Producers get a synthetic origin pubkey so browsers attribute
   * the track to "test peer" in their UI.
   *
   * Use case: end-to-end smoke test of the mediasoup pipeline without
   * needing a real browser publisher. Once mediasoup-client validation is
   * complete this can stay around for load tests / regression testing.
   */
  async injectTestProducer(opts: {
    kind: 'audio' | 'video';
    voiceKind: 'audio' | 'camera' | 'screen' | 'screen-audio';
    originPubkey: Hex;
  }): Promise<{
    transportId: string;
    rtpListenIp: string;
    rtpListenPort: number;
    rtcpListenPort: number;
    payloadType: number;
    ssrc: number;
    producerId: string;
  }> {
    if (!this.router) throw new Error('router not ready');
    const isVideo = opts.kind === 'video';
    const payloadType = isVideo ? 101 : 100; // matches mediasoup-server.ts preferredPayloadType
    const ssrc = isVideo ? 22220001 : 22220002;
    const codec = isVideo
      ? { mimeType: 'video/VP8', payloadType, clockRate: 90000 }
      : { mimeType: 'audio/opus', payloadType, clockRate: 48000, channels: 2 };

    const listenIp = this.cfg.publicIp
      ? { ip: '0.0.0.0', announcedIp: this.cfg.publicIp }
      : { ip: '0.0.0.0' };
    const transport = await this.router.createPlainTransport({
      listenIp,
      rtcpMux: false,
      comedia: true, // bind remote address from first packet — caller doesn't need to set DTLS/connect
    });
    log.info('test inject transport', {
      channelId: this.channelId.slice(0, 8),
      kind: opts.kind,
      transportId: transport.id,
      rtp: `${transport.tuple.localIp}:${transport.tuple.localPort}`,
      rtcp: transport.rtcpTuple
        ? `${transport.rtcpTuple.localIp}:${transport.rtcpTuple.localPort}`
        : '(muxed)',
    });

    const producer = await transport.produce({
      kind: opts.kind,
      rtpParameters: {
        codecs: [codec],
        encodings: [{ ssrc }],
      },
    });

    // Stash a synthetic peer record so room snapshots / consumer-newProducer
    // notifications carry the right origin attribution. We don't add to
    // `this.peers` (no transports) — instead, broadcast a notification
    // directly to every existing recv-transport-bearing peer.
    const meta = { kind: opts.voiceKind, originPubkey: opts.originPubkey };
    for (const other of this.peers.values()) {
      if (!other.recvTransport) continue;
      void this.sendNotification(other.pubkey, 'newProducer', {
        producerId: producer.id,
        kind: producer.kind,
        appData: meta,
      });
    }
    // Also keep the producer alive: if the room closes we close it.
    // Track it on a synthetic peer record under the origin pubkey so
    // `consume` can find the appData.
    const syntheticKey = peerKey(opts.originPubkey, SYNTHETIC_CLIENT_ID);
    let synthetic = this.peers.get(syntheticKey);
    const isNewSyntheticPeer = !synthetic;
    if (!synthetic) {
      const now = Date.now();
      synthetic = {
        pubkey: opts.originPubkey,
        clientId: SYNTHETIC_CLIENT_ID,
        producers: new Map(),
        consumers: new Map(),
        producerAppData: new Map(),
        unhealthyTimers: new Map(),
        lastInboundPacketAt: now,
        lastSeenPacketCount: 0,
        joinedAt: now,
      };
      this.peers.set(syntheticKey, synthetic);
      // Synthetic test peer counts as a participant for the empty-grace
      // timer's purposes — clear any pending close so the test peer's
      // existence doesn't expire mid-test.
      this.cancelEmptyTimer();
    }
    synthetic.producers.set(producer.id, producer);
    synthetic.producerAppData.set(producer.id, meta);

    // First time we've seen this synthetic origin pubkey — announce it as
    // a new participant so every recv-transport-bearing peer adds the
    // tile to their roster. Without this, test injectors stream media
    // through `newProducer` but never appear in the participant list,
    // because they don't drive the recv-transport handler that normally
    // emits `peerJoined`.
    if (isNewSyntheticPeer) {
      for (const other of this.peers.values()) {
        if (other.pubkey === opts.originPubkey) continue;
        if (!other.recvTransport) continue;
        void this.sendNotification(other.pubkey, 'peerJoined', {
          pubkey: opts.originPubkey,
        });
      }
    }

    return {
      transportId: transport.id,
      rtpListenIp: this.cfg.publicIp ?? transport.tuple.localIp,
      rtpListenPort: transport.tuple.localPort,
      rtcpListenPort: transport.rtcpTuple?.localPort ?? 0,
      payloadType,
      ssrc,
      producerId: producer.id,
    };
  }

  /**
   * Kick a participant: close their transports + producers + consumers,
   * publish an out-of-band notification so they know why. Idempotent —
   * a second kick on the same pubkey is a no-op.
   */
  async kick(targetPubkey: Hex, reason?: string): Promise<void> {
    // Kick by pubkey covers ALL devices of that user — admin moderation
    // shouldn't leave one of someone's devices in the room while booting
    // the other. Snapshot to a list because we mutate `peers` mid-loop.
    const targets: PeerState[] = [];
    for (const peer of this.peers.values()) {
      if (peer.pubkey === targetPubkey) targets.push(peer);
    }
    if (targets.length === 0) return;
    log.info('kick', { target: targetPubkey.slice(0, 8), reason: reason ?? '', devices: targets.length });
    for (const peer of targets) {
      // Remove from the peer table BEFORE closing so the transport-close
      // observer's `peers.get(key) === peer` guard short-circuits and we
      // don't double-publish `peerLeft` from both this method and the
      // observer.
      this.peers.delete(peerKey(peer.pubkey, peer.clientId));
      for (const producerId of peer.producers.keys()) {
        for (const other of this.peers.values()) {
          if (!other.recvTransport) continue;
          void this.sendNotification(other.pubkey, 'producerClosed', { producerId });
        }
      }
      try { peer.sendTransport?.close(); } catch { /* ignore */ }
      try { peer.recvTransport?.close(); } catch { /* ignore */ }
    }
    await this.sendNotification(targetPubkey, 'kicked', { reason: reason ?? null });
    this.fanoutPeerLeft(targetPubkey);
    this.maybeStartEmptyTimer();
  }

  /**
   * Centralized "this peer is gone from the room" handler. Removes them
   * from `this.peers`, fires `producerClosed` for each producer they
   * owned, then fans out `peerLeft` to everyone else with a recv
   * transport. Notification order matters: clients drop tracks on
   * `producerClosed` and only treat `peerLeft` as a roster update.
   * Without the per-producer fanout, abrupt disconnects (tab close,
   * network loss, OS sleep) leave black tiles in the dex until the
   * jitter buffer drains. Called from the transport-close observer
   * (organic disconnect) and from `kick` (admin action, after the peer
   * is already removed — second call is a no-op thanks to the .get()
   * guard above).
   */
  private handlePeerLeft(peer: PeerState): void {
    if (!this.peers.delete(peerKey(peer.pubkey, peer.clientId))) return;
    log.info('peer left', { peer: peer.pubkey.slice(0, 8), producers: peer.producers.size });
    // 1. Fan out producerClosed for every producer this peer owned, so
    //    every other peer's recvTransport-bound consumers know to drop
    //    the corresponding track immediately. Don't rely on mediasoup's
    //    own producerclose event because the transport close that
    //    triggered us is already racing — we want the wire notification
    //    out before the consumer-side close is observed.
    for (const producerId of peer.producers.keys()) {
      for (const other of this.peers.values()) {
        if (!other.recvTransport) continue;
        void this.sendNotification(other.pubkey, 'producerClosed', { producerId });
      }
    }
    // 2. Then peerLeft for the roster update — but only if the user has
    // no other devices still in the room. Without this check, dropping
    // device 1 of a multi-device user would tell every other peer the
    // user left, even though device 2 is still producing media.
    const userStillPresent = Array.from(this.peers.values()).some(
      (p) => p.pubkey === peer.pubkey,
    );
    if (!userStillPresent) {
      this.fanoutPeerLeft(peer.pubkey);
    }
    this.maybeStartEmptyTimer();
  }

  private fanoutPeerLeft(pubkey: Hex): void {
    for (const other of this.peers.values()) {
      if (!other.recvTransport) continue;
      void this.sendNotification(other.pubkey, 'peerLeft', { pubkey });
    }
  }

  /**
   * Start (or restart) the empty-room grace timer if the peer table just
   * became empty. Idempotent — a second call while the timer is already
   * armed is a no-op. Closes the room after `cfg.emptyGraceSeconds`
   * unless a new peer joins in the meantime; the timer is cleared by
   * {@link cancelEmptyTimer} on every peer add.
   *
   * Also publishes a fresh kind 31314 with `status='active'` but ZERO
   * participants so subscribers see "the room exists, nobody's in it"
   * within one publish cycle instead of waiting for the next periodic
   * activeCall publish — channels that go briefly empty during a
   * channel-switch shouldn't flap clients' "live call" badge.
   */
  private maybeStartEmptyTimer(): void {
    if (this._status !== 'active') return;
    if (this.peers.size > 0) return;
    if (this.emptyTimer) return;
    log.info('room empty — grace timer started', {
      channel: this.channelId.slice(0, 8),
      seconds: this.cfg.emptyGraceSeconds,
    });
    // Refresh the kind 31314 immediately with the empty roster so
    // subscribers see the headcount drop without waiting up to
    // ACTIVE_CALL_INTERVAL_MS for the next periodic tick.
    void this.publishActiveCall().catch(() => undefined);
    this.emptyTimer = setTimeout(() => {
      this.emptyTimer = null;
      if (this.peers.size === 0 && this._status === 'active') {
        log.info('room empty grace expired — closing', {
          channel: this.channelId.slice(0, 8),
        });
        void this.close().catch((err) => log.warn('empty-grace close threw', { err: (err as Error).message }));
      }
    }, this.cfg.emptyGraceSeconds * 1000);
    this.emptyTimer.unref?.();
  }

  private cancelEmptyTimer(): void {
    if (this.emptyTimer) {
      clearTimeout(this.emptyTimer);
      this.emptyTimer = null;
    }
  }

  snapshot(): RoomSnapshot {
    return {
      channelId: this.channelId,
      status: this._status,
      hostPubkey: this.hostPubkey,
      rules: this._rules,
      // De-duplicate by pubkey: the snapshot is consumed by HTTP /rooms
      // and admin tooling that thinks of "participants" as users, not
      // devices. Users with two devices in the same room appear once.
      participants: Array.from(new Set(Array.from(this.peers.values()).map((p) => p.pubkey))),
      startedAt: this.startedAt,
    };
  }

  async start(): Promise<void> {
    log.info('room.start enter', { channelId: this.channelId.slice(0, 8) });
    if (this._status !== 'starting') {
      throw new Error(`room ${this.channelId.slice(0, 8)} already started`);
    }
    this.router = await this.engine.getRouter(this.channelId);
    log.info('room.start router ready', { channelId: this.channelId.slice(0, 8), routerId: this.router.id });
    this._status = 'active';
    this.startedAt = Math.floor(Date.now() / 1000);

    this.signalUnsub = this.relay.subscribe(
      {
        kinds: [KIND_VOICE_SIGNAL],
        '#e': [this.channelId],
        since: Math.floor(Date.now() / 1000) - 60,
      },
      (ev) => {
        if (ev.pubkey === this.relay.pubkey) return;
        const targets = ev.tags.filter((t) => t[0] === 'p').map((t) => t[1]);
        if (targets.length > 0 && !targets.includes(this.relay.pubkey)) return;
        this.handleEnvelope(ev.pubkey, ev.content).catch((err) =>
          log.warn('envelope handler threw', { err: (err as Error).message }),
        );
      },
    );
    log.info('room.start signal subscribed', { channelId: this.channelId.slice(0, 8) });

    const watch = this.membership.watch(this.channelId);
    this.membershipRelease = watch.release;
    log.info('room.start membership held', { channelId: this.channelId.slice(0, 8) });

    // Don't await beacon publishes — keeps room.start() fast even if the
    // relay write is slow. Periodic timers keep the beacon stream going.
    void this.publishBeacon().catch((err) => log.warn('beacon publish failed', { err: (err as Error).message }));
    void this.publishActiveCall().catch((err) => log.warn('active-call publish failed', { err: (err as Error).message }));
    this.beaconTimer = setInterval(() => {
      void this.publishBeacon().catch(() => undefined);
    }, BEACON_INTERVAL_MS);
    this.activeCallTimer = setInterval(() => {
      void this.publishActiveCall().catch(() => undefined);
    }, ACTIVE_CALL_INTERVAL_MS);
    this.reaperTimer = setInterval(() => {
      void this.reap().catch((err) =>
        log.warn('reaper threw', { err: (err as Error).message }),
      );
    }, REAPER_INTERVAL_MS);

    log.info('room started', {
      channelId: this.channelId.slice(0, 8),
      host: this.hostPubkey.slice(0, 8),
      routerId: this.router.id,
    });
  }

  async close(): Promise<void> {
    if (this._status === 'closed') return;
    this._status = 'closed';

    if (this.beaconTimer) { clearInterval(this.beaconTimer); this.beaconTimer = null; }
    if (this.activeCallTimer) { clearInterval(this.activeCallTimer); this.activeCallTimer = null; }
    if (this.reaperTimer) { clearInterval(this.reaperTimer); this.reaperTimer = null; }
    this.cancelEmptyTimer();
    // Clear any per-peer ICE/DTLS sweep timers so a slow shutdown doesn't
    // leave them firing into a closed Room.
    for (const peer of this.peers.values()) {
      for (const t of peer.unhealthyTimers.values()) clearTimeout(t);
      peer.unhealthyTimers.clear();
    }
    this.signalUnsub?.();
    this.signalUnsub = null;

    // Close every peer's transports — mediasoup will close their producers
    // and consumers automatically. Clients see the transport drop.
    for (const peer of this.peers.values()) {
      try { peer.sendTransport?.close(); } catch { /* ignore */ }
      try { peer.recvTransport?.close(); } catch { /* ignore */ }
    }
    this.peers.clear();

    await this.engine.closeRouter(this.channelId).catch(() => undefined);
    this.router = null;

    await this.publishActiveCall().catch(() => undefined);
    this.membershipRelease?.();
    this.membershipRelease = null;
    this.onClosed(this.channelId);

    log.info('room closed', { channelId: this.channelId.slice(0, 8) });
  }

  // ── envelope intake ────────────────────────────────────────────────────

  private async handleEnvelope(fromPubkey: Hex, content: string): Promise<void> {
    if (this._status !== 'active') return;
    const envelope = parseEnvelope(content);
    if (!envelope) {
      // Either malformed or a legacy werift SDP/ICE payload — drop silently.
      // Mixed-engine support is not a goal: when SFU_ENGINE=mediasoup, only
      // mediasoup-aware clients work.
      return;
    }
    if (envelope.type !== 'request') {
      // Responses / notifications travel server → client; any inbound
      // response is from a confused legacy client. Ignore.
      return;
    }
    log.info('rpc request', {
      from: fromPubkey.slice(0, 8),
      method: envelope.method,
      requestId: envelope.requestId.slice(0, 8),
    });

    // `leave` bypasses the dial gate — a kicked or denied peer must
    // still be able to gracefully tear down their transports server-side
    // (otherwise their "you're already in this call" rejection persists
    // until ICE/DTLS times out, which is the symptom in bug #6).
    if (envelope.method !== 'leave') {
      const decision = canDialRoom({
        rules: this._rules,
        members: this.membership.getMembers(this.channelId),
        hostPubkey: this.hostPubkey,
        sender: fromPubkey,
      });
      if (!decision.ok) {
        log.debug('rpc refused at door', {
          from: fromPubkey.slice(0, 8),
          reason: decision.reason,
        });
        return;
      }
    }

    // `clientId` distinguishes two devices belonging to the same Nostr
    // pubkey. Legacy clients (pre-multi-device) don't send it; they
    // collapse onto a single peer slot keyed by `'_legacy'` per pubkey.
    const clientId = envelope.clientId ?? '_legacy';
    const ctx: RpcContext = {
      channelId: this.channelId,
      fromPubkey,
      clientId,
      notify: (method, data) => this.sendNotification(fromPubkey, method, data),
    };
    const response = await dispatchRequest(this.handlers, ctx, envelope);
    await this.sendResponse(fromPubkey, response);
  }

  private async sendResponse(toPubkey: Hex, response: unknown): Promise<void> {
    await this.relay.publish({
      kind: KIND_VOICE_SIGNAL,
      content: JSON.stringify(response),
      tags: [
        ['p', toPubkey],
        ['e', this.channelId],
        // Both tags are present:
        //  - `obelisk-voice-signal` keeps the wire shape uniform with mesh
        //    peer signals (legacy dex clients that subscribe on this tag
        //    keep receiving responses).
        //  - `obelisk-sfu-rpc` is the distinguishing marker so newer dex
        //    versions can filter at subscription time (e.g.
        //    `#t: ['obelisk-voice-signal']` for peer SDP only,
        //    `#t: ['obelisk-sfu-rpc']` for SFU RPC only) instead of
        //    receiving every RPC envelope destined for every peer in
        //    the room and dropping them in-handler.
        ['t', 'obelisk-voice-signal'],
        ['t', 'obelisk-sfu-rpc'],
      ],
      created_at: Math.floor(Date.now() / 1000),
    });
  }

  private async sendNotification<T>(
    toPubkey: Hex,
    method: string,
    data?: T,
  ): Promise<void> {
    const notification: RpcNotification = data === undefined
      ? { type: 'notification', method }
      : { type: 'notification', method, data };
    await this.relay.publish({
      kind: KIND_VOICE_SIGNAL,
      content: JSON.stringify(notification),
      tags: [
        ['p', toPubkey],
        ['e', this.channelId],
        ['t', 'obelisk-voice-signal'],
        ['t', 'obelisk-sfu-rpc'],
      ],
      created_at: Math.floor(Date.now() / 1000),
    });
  }

  // ── method handlers ────────────────────────────────────────────────────

  private getOrCreatePeer(pubkey: Hex, clientId: string): PeerState {
    const key = peerKey(pubkey, clientId);
    let p = this.peers.get(key);
    if (!p) {
      const cap = this._rules.maxParticipants ?? this.cfg.maxParticipantsPerRoom;
      // Cap counts by unique pubkey, not unique device — a user with
      // both a phone and a desktop connected only consumes one of the
      // operator's "max participants" slots. Otherwise the second
      // device's join would silently fail with ROOM_FULL on a busy
      // call right at the cap.
      const distinctPubkeys = new Set<Hex>();
      for (const peer of this.peers.values()) distinctPubkeys.add(peer.pubkey);
      if (!distinctPubkeys.has(pubkey) && distinctPubkeys.size >= cap) {
        throw new RpcError('room full', 'ROOM_FULL');
      }
      const now = Date.now();
      p = {
        pubkey,
        clientId,
        producers: new Map(),
        consumers: new Map(),
        producerAppData: new Map(),
        unhealthyTimers: new Map(),
        lastInboundPacketAt: now,
        lastSeenPacketCount: 0,
        joinedAt: now,
      };
      this.peers.set(key, p);
      // First peer back in — cancel any pending empty-room close so a
      // user briefly toggling devices or refreshing their tab doesn't
      // lose the room out from under them mid-grace.
      this.cancelEmptyTimer();
    }
    return p;
  }

  /**
   * Method dispatch table. Handlers throw `RpcError` to surface a clean
   * error response; the dispatcher centralizes envelope shaping.
   */
  private readonly handlers: RpcHandlerMap = {
    getRouterRtpCapabilities: async () => {
      if (!this.router) throw new RpcError('router not ready', 'NO_ROUTER');
      return this.router.rtpCapabilities;
    },

    createWebRtcTransport: async (ctx, raw) => {
      if (!this.router) throw new RpcError('router not ready', 'NO_ROUTER');
      const data = (raw ?? {}) as { direction?: 'send' | 'recv' };
      const direction = data.direction === 'recv' ? 'recv' : 'send';
      const peer = this.getOrCreatePeer(ctx.fromPubkey, ctx.clientId);
      const existing = direction === 'send' ? peer.sendTransport : peer.recvTransport;
      // On browser reload the dex re-issues createWebRtcTransport for the same
      // peer. Idempotently returning the old transport leaves the browser
      // with stale DTLS keys; close + recreate so handshake succeeds, and
      // also drop any consumers tied to the dead recv transport so they
      // can be re-issued by the existing-producer broadcast below.
      if (existing) {
        try { existing.close(); } catch { /* already closed */ }
        if (direction === 'send') {
          for (const [pid, producer] of peer.producers) {
            try { producer.close(); } catch { /* ignore */ }
            peer.producers.delete(pid);
            peer.producerAppData.delete(pid);
          }
          delete peer.sendTransport;
        } else {
          for (const [cid, consumer] of peer.consumers) {
            try { consumer.close(); } catch { /* ignore */ }
            peer.consumers.delete(cid);
          }
          delete peer.recvTransport;
        }
      }
      const transport = await this.router.createWebRtcTransport(
        this.engine.webRtcTransportOptions(),
      );
      // Bug #6 — drop the peer when ICE or DTLS stays bad for >15 s.
      // ICE/DTLS state can flap during normal wifi handoff; the timer
      // arms on a bad transition and disarms on a recovery, so a brief
      // blip doesn't trigger a reap.
      const armUnhealthyTimer = (cause: string): void => {
        if (peer.unhealthyTimers.has(transport.id)) return; // already armed
        const t = setTimeout(() => {
          peer.unhealthyTimers.delete(transport.id);
          // Recheck — observer may have already swapped the peer out.
          if (this.peers.get(peerKey(peer.pubkey, peer.clientId)) !== peer) return;
          log.info('peer unhealthy timeout — dropping', {
            peer: peer.pubkey.slice(0, 8),
            direction,
            id: transport.id,
            cause,
          });
          this.dropStalePeer(peer, `unhealthy:${cause}`);
        }, TRANSPORT_UNHEALTHY_TIMEOUT_MS);
        peer.unhealthyTimers.set(transport.id, t);
      };
      const cancelUnhealthyTimer = (): void => {
        const t = peer.unhealthyTimers.get(transport.id);
        if (t) {
          clearTimeout(t);
          peer.unhealthyTimers.delete(transport.id);
        }
      };
      transport.on('icestatechange', (state) => {
        // mediasoup's IceState is: new | connected | completed | disconnected | closed.
        // No 'failed' here (DTLS reports that separately below).
        if (state === 'disconnected') {
          armUnhealthyTimer('ice=disconnected');
        } else if (state === 'connected' || state === 'completed') {
          cancelUnhealthyTimer();
        }
      });
      transport.on('dtlsstatechange', (state) => {
        if (state === 'failed') {
          armUnhealthyTimer('dtls=failed');
        } else if (state === 'connected') {
          cancelUnhealthyTimer();
        } else if (state === 'closed') {
          log.debug('transport dtls closed', {
            peer: ctx.fromPubkey.slice(0, 8), direction, id: transport.id,
          });
          cancelUnhealthyTimer();
        }
      });
      // When BOTH transports of a peer have closed organically (DTLS death,
      // ICE failure, router teardown), treat the peer as having left and
      // fan out `peerLeft` to the rest of the room. The reference-equality
      // guard `peer.X === transport` keeps us out of the close+recreate path
      // above, which clears the field BEFORE re-allocation.
      transport.observer.on('close', () => {
        const isStillSend = peer.sendTransport === transport;
        const isStillRecv = peer.recvTransport === transport;
        if (!isStillSend && !isStillRecv) return; // already swapped out
        if (isStillSend) delete peer.sendTransport;
        if (isStillRecv) delete peer.recvTransport;
        if (!peer.sendTransport && !peer.recvTransport && this.peers.get(peerKey(peer.pubkey, peer.clientId)) === peer) {
          this.handlePeerLeft(peer);
        }
      });
      if (direction === 'send') peer.sendTransport = transport;
      else peer.recvTransport = transport;

      // When the peer's recv transport comes online, push the current
      // participant list + every existing producer so the client knows
      // what to render and what to consume. Then fan out `peerJoined` to
      // every other peer with a recv transport so their roster updates.
      // Fires on first connect AND on reload (close+recreate path above).
      //
      // The participant list includes ANY peer in `this.peers`, not just
      // those with their own recv transport. This catches synthetic peers
      // (test injectors that publish via PlainTransport without an SFU
      // recv channel) — they're still real participants from the
      // perspective of every browser-side user, and the dex needs them
      // in the roster to render their tile.
      if (direction === 'recv') {
        // Dedupe by pubkey: a user with two devices in the room is one
        // participant from every other peer's perspective. The snapshot
        // already dedupes; mirror that here for the participantList push
        // so the new arrival's roster matches what existing peers see.
        const otherPubkeys = Array.from(
          new Set(
            Array.from(this.peers.values())
              .filter((p) => p.pubkey !== ctx.fromPubkey)
              .map((p) => p.pubkey),
          ),
        );
        void ctx.notify('participantList', { pubkeys: otherPubkeys });

        for (const other of this.peers.values()) {
          if (other.pubkey === ctx.fromPubkey) continue;
          for (const [, producer] of other.producers) {
            const meta = other.producerAppData.get(producer.id);
            void ctx.notify('newProducer', {
              producerId: producer.id,
              kind: producer.kind,
              appData: meta ?? null,
            });
          }
        }

        // peerJoined is a roster-add signal. Suppress it when the same
        // user is already in the room via another device — otherwise
        // existing peers see "user A joined" for an A who never left.
        // sameUserCount counts THIS peer too, so >1 means another
        // device already represented user A.
        const sameUserCount = Array.from(this.peers.values()).filter(
          (p) => p.pubkey === ctx.fromPubkey,
        ).length;
        if (sameUserCount <= 1) {
          for (const other of this.peers.values()) {
            if (other.pubkey === ctx.fromPubkey) continue;
            if (!other.recvTransport) continue;
            void this.sendNotification(other.pubkey, 'peerJoined', {
              pubkey: ctx.fromPubkey,
            });
          }
        }
      }

      return {
        id: transport.id,
        iceParameters: transport.iceParameters,
        iceCandidates: transport.iceCandidates,
        dtlsParameters: transport.dtlsParameters,
      };
    },

    connectWebRtcTransport: async (ctx, raw) => {
      const data = raw as { transportId: string; dtlsParameters: ms.DtlsParameters };
      const peer = this.peers.get(peerKey(ctx.fromPubkey, ctx.clientId));
      if (!peer) throw new RpcError('no peer state', 'NO_PEER');
      const transport = peer.sendTransport?.id === data.transportId
        ? peer.sendTransport
        : peer.recvTransport?.id === data.transportId
          ? peer.recvTransport
          : null;
      if (!transport) throw new RpcError('unknown transport', 'NO_TRANSPORT');
      await transport.connect({ dtlsParameters: data.dtlsParameters });
      return {};
    },

    produce: async (ctx, raw) => {
      const data = raw as {
        transportId: string;
        kind: ms.MediaKind;
        rtpParameters: ms.RtpParameters;
        appData?: { kind?: 'audio' | 'camera' | 'screen' | 'screen-audio' };
      };
      const peer = this.peers.get(peerKey(ctx.fromPubkey, ctx.clientId));
      if (!peer) throw new RpcError('no peer state', 'NO_PEER');
      const transport = peer.sendTransport;
      if (!transport || transport.id !== data.transportId) {
        throw new RpcError('unknown send transport', 'NO_TRANSPORT');
      }
      const producer = await transport.produce({
        kind: data.kind,
        rtpParameters: data.rtpParameters,
      });
      const voiceKind = sanitizeVoiceKind(data.appData?.kind, data.kind);
      peer.producers.set(producer.id, producer);
      peer.producerAppData.set(producer.id, {
        kind: voiceKind,
        originPubkey: ctx.fromPubkey,
      });
      log.info('producer created', {
        peer: ctx.fromPubkey.slice(0, 8),
        producerId: producer.id,
        kind: data.kind,
        voiceKind,
      });

      producer.on('transportclose', () => {
        peer.producers.delete(producer.id);
        peer.producerAppData.delete(producer.id);
      });

      // Tell every other peer with a recv transport about this new producer
      // so they can call `consume`.
      for (const other of this.peers.values()) {
        if (other.pubkey === ctx.fromPubkey) continue;
        if (!other.recvTransport) continue;
        void this.sendNotification(other.pubkey, 'newProducer', {
          producerId: producer.id,
          kind: producer.kind,
          appData: { kind: voiceKind, originPubkey: ctx.fromPubkey },
        });
      }
      return { id: producer.id };
    },

    consume: async (ctx, raw) => {
      const data = raw as { producerId: string; rtpCapabilities: ms.RtpCapabilities };
      const peer = this.peers.get(peerKey(ctx.fromPubkey, ctx.clientId));
      if (!peer) throw new RpcError('no peer state', 'NO_PEER');
      if (!peer.recvTransport) throw new RpcError('recv transport not ready', 'NO_RECV_TRANSPORT');
      if (!this.router) throw new RpcError('no router', 'NO_ROUTER');
      if (!this.router.canConsume({ producerId: data.producerId, rtpCapabilities: data.rtpCapabilities })) {
        throw new RpcError('cannot consume — codec mismatch', 'CANNOT_CONSUME');
      }
      // Find producer to surface its appData (origin pubkey, voice-kind) to the client.
      let producerOwner: PeerState | null = null;
      for (const other of this.peers.values()) {
        if (other.producers.has(data.producerId)) { producerOwner = other; break; }
      }
      const meta = producerOwner?.producerAppData.get(data.producerId);

      const consumer = await peer.recvTransport.consume({
        producerId: data.producerId,
        rtpCapabilities: data.rtpCapabilities,
        // start paused; client resumes after attaching the track to its
        // <video> element to avoid losing initial frames in some browsers.
        paused: true,
      });
      peer.consumers.set(data.producerId, consumer);
      // Keyframe heartbeat: video freezes silently on packet loss when
      // the producer's natural keyframe interval is long (mediasoup
      // defaults to ~one every 5–10s under load, but real-world I-frame
      // gaps can stretch to 30s+ over flaky links). Browser-side
      // mediasoup-client only requests keyframes on detected loss; if a
      // bunch of packets drop and the consumer's PLI never reaches the
      // producer (e.g., Wi-Fi roam), the receiver stays frozen on the
      // last-good frame until the producer next emits I. Force one every
      // 8s so the worst-case freeze is ~8s, not 30+s.
      let keyframeTimer: ReturnType<typeof setInterval> | null = null;
      if (consumer.kind === 'video') {
        keyframeTimer = setInterval(() => {
          if (consumer.closed || consumer.paused) return;
          consumer.requestKeyFrame()
            .catch((err) => log.debug('keyframe heartbeat failed', { err: (err as Error).message }));
        }, 8000);
      }
      consumer.on('transportclose', () => {
        if (keyframeTimer) { clearInterval(keyframeTimer); keyframeTimer = null; }
        peer.consumers.delete(data.producerId);
      });
      consumer.on('producerclose', () => {
        if (keyframeTimer) { clearInterval(keyframeTimer); keyframeTimer = null; }
        peer.consumers.delete(data.producerId);
        void this.sendNotification(peer.pubkey, 'producerClosed', { producerId: data.producerId });
      });
      return {
        id: consumer.id,
        producerId: data.producerId,
        kind: consumer.kind,
        rtpParameters: consumer.rtpParameters,
        appData: meta ?? null,
      };
    },

    resumeConsumer: async (ctx, raw) => {
      const data = raw as { consumerId: string };
      const peer = this.peers.get(peerKey(ctx.fromPubkey, ctx.clientId));
      if (!peer) throw new RpcError('no peer state', 'NO_PEER');
      for (const consumer of peer.consumers.values()) {
        if (consumer.id === data.consumerId) {
          await consumer.resume();
          // Ask the producer to emit a fresh keyframe so the consumer
          // renders the next P-frame correctly. Video consumers attach
          // mid-stream (the producer sends a keyframe every ~60s
          // by default), so without an explicit request the receiver
          // sees a black/frozen tile until that interval elapses.
          // Audio consumers don't have keyframes — `requestKeyFrame()`
          // is a no-op there, so we fire it unconditionally.
          if (consumer.kind === 'video') {
            try { await consumer.requestKeyFrame(); }
            catch (err) { log.debug('requestKeyFrame on resume failed', { err: (err as Error).message }); }
          }
          return {};
        }
      }
      throw new RpcError('unknown consumer', 'NO_CONSUMER');
    },

    closeProducer: async (ctx, raw) => {
      const data = raw as { producerId: string };
      const peer = this.peers.get(peerKey(ctx.fromPubkey, ctx.clientId));
      if (!peer) throw new RpcError('no peer state', 'NO_PEER');
      const producer = peer.producers.get(data.producerId);
      if (!producer) throw new RpcError('unknown producer', 'NO_PRODUCER');
      producer.close();
      peer.producers.delete(data.producerId);
      peer.producerAppData.delete(data.producerId);
      // Server-side mediasoup auto-closes the corresponding server-side
      // Consumers when a producer closes, but mediasoup-CLIENT does NOT
      // get a wire signal from that — its Consumer object stays open
      // until the underlying track times out (10s+). Pre-fix we relied
      // on that auto-close and didn't fan out, so a remote camera/screen
      // toggle-off left a frozen tile in every other peer's UI until
      // they reloaded. Explicit notification is the only fast signal.
      // Skip the peer who owns the producer (their own UI already knows);
      // same-pubkey other-clientId peers (multi-device) DO get notified
      // because they were consuming this producer.
      for (const other of this.peers.values()) {
        if (other === peer) continue;
        if (!other.recvTransport) continue;
        void this.sendNotification(other.pubkey, 'producerClosed', { producerId: data.producerId });
      }
      return {};
    },

    /**
     * Bug #6 — explicit graceful leave RPC. Idempotent: a `leave` for an
     * already-gone peer just returns ok. Without this the SFU relies
     * entirely on DTLS close-notify to clean up, which is unreliable on
     * abrupt tab close / network loss / quick rejoin and leaves the
     * peer "stuck in the room" until ICE/DTLS times out (often 30 s+).
     * The dex's `pagehide`/`beforeunload` handler fire-and-forgets a
     * `leave` request before tearing down, so even an abrupt close
     * gets a clean slot release in most cases.
     */
    leave: async (ctx) => {
      const peer = this.peers.get(peerKey(ctx.fromPubkey, ctx.clientId));
      if (!peer) {
        log.debug('leave: peer already gone', { peer: ctx.fromPubkey.slice(0, 8) });
        return { ok: true };
      }
      log.info('leave RPC', { peer: ctx.fromPubkey.slice(0, 8) });
      this.dropStalePeer(peer, 'leave-rpc');
      return { ok: true };
    },
  };

  /**
   * Centralized teardown for "this peer is gone, full cleanup": fire
   * `producerClosed` per-producer, `peerLeft` to the rest of the room,
   * close transports (mediasoup propagates the close to producers +
   * consumers automatically), clear sweep timers. Used by `leave` RPC,
   * the ICE/DTLS sweep, and the activity reaper. Idempotent at the
   * peer-table level — second call is a no-op.
   */
  private dropStalePeer(peer: PeerState, cause: string): void {
    if (this.peers.get(peerKey(peer.pubkey, peer.clientId)) !== peer) return;
    log.info('drop stale peer', { peer: peer.pubkey.slice(0, 8), cause });
    // Cancel sweep timers BEFORE removing from peers map so the timer
    // callback's pubkey-equality guard fails fast if it fires concurrently.
    for (const t of peer.unhealthyTimers.values()) clearTimeout(t);
    peer.unhealthyTimers.clear();
    // Remove from table BEFORE closing transports so the close observer's
    // `this.peers.get(peerKey(peer.pubkey, peer.clientId)) === peer` check short-circuits and we
    // don't double-fire the peerLeft fanout. Pre-multi-device the map was
    // keyed on pubkey alone; the composite-key migration missed this one
    // delete site, so until 2026-05-08 every leave/kick/reap cascaded into
    // a duplicate peerLeft + producerClosed storm and a brief ghost-peer
    // window — visible to operators as channel-switch flicker.
    this.peers.delete(peerKey(peer.pubkey, peer.clientId));
    // Fire producerClosed before peerLeft per bug #1 ordering rule.
    for (const producerId of peer.producers.keys()) {
      for (const other of this.peers.values()) {
        if (!other.recvTransport) continue;
        void this.sendNotification(other.pubkey, 'producerClosed', { producerId });
      }
    }
    this.fanoutPeerLeft(peer.pubkey);
    try { peer.sendTransport?.close(); } catch { /* ignore */ }
    try { peer.recvTransport?.close(); } catch { /* ignore */ }
    this.maybeStartEmptyTimer();
  }

  /**
   * Activity-based reaper (bug #7). Runs every `REAPER_INTERVAL_MS`.
   * Drops peers whose RTP packet count hasn't moved for
   * `RTP_INACTIVITY_TIMEOUT_MS`, and peers that joined but never
   * published anything for `NO_PRODUCER_TIMEOUT_MS`. RTP flow is the
   * only signal that survives soft failures (laptop closed but radio
   * on, mobile background-throttle, OS suspend) — ICE/DTLS can read
   * "healthy" while no actual media is moving.
   */
  private async reap(): Promise<void> {
    if (this._status !== 'active') return;
    const now = Date.now();
    // Snapshot to a list — `dropStalePeer` mutates `this.peers`, which
    // we don't want to iterate over directly while doing so.
    const peers = Array.from(this.peers.values());
    for (const peer of peers) {
      // Re-check — earlier reap iteration may have dropped this peer
      // (e.g. via cascading close events).
      if (this.peers.get(peerKey(peer.pubkey, peer.clientId)) !== peer) continue;

      if (peer.producers.size === 0) {
        if (now - peer.joinedAt > NO_PRODUCER_TIMEOUT_MS) {
          this.dropStalePeer(peer, 'no-producers-timeout');
        }
        continue;
      }

      let totalPackets = 0;
      let any = false;
      for (const producer of peer.producers.values()) {
        try {
          const stats = await producer.getStats();
          for (const stat of stats) {
            // mediasoup ProducerStat shape is union-typed across audio /
            // video / RTX layers — `packetCount` is on the inbound entries.
            const pc = (stat as { packetCount?: number }).packetCount;
            if (typeof pc === 'number') {
              totalPackets += pc;
              any = true;
            }
          }
        } catch {
          // producer closed mid-iteration — fine, will be reaped next pass
          // if the peer is genuinely gone, or skipped this pass.
        }
      }
      if (!any) continue;
      if (totalPackets > peer.lastSeenPacketCount) {
        peer.lastSeenPacketCount = totalPackets;
        peer.lastInboundPacketAt = now;
      } else if (now - peer.lastInboundPacketAt > RTP_INACTIVITY_TIMEOUT_MS) {
        this.dropStalePeer(peer, 'rtp-inactivity');
      }
    }
  }

  // ── periodic publishers ────────────────────────────────────────────────

  private async publishBeacon(): Promise<void> {
    await publishSfuBeacon(this.relay, this.channelId, Array.from(this.peers.keys()));
  }

  private async publishActiveCall(): Promise<void> {
    // Count distinct pubkeys (NOT clientIds) — a user with two devices in
    // the room is one participant from every other client's UI perspective.
    // Synthetic test peers count too; they're real audio sources.
    const distinctPubkeys = new Set<Hex>();
    for (const peer of this.peers.values()) distinctPubkeys.add(peer.pubkey);
    await this.relay.publish({
      kind: KIND_SFU_ACTIVE_CALL,
      content: '',
      tags: [
        ['d', this.channelId],
        ['e', this.channelId],
        ['host', this.hostPubkey],
        ['status', this._status],
        // Live participant count. Dex consumers hide the "LIVE" badge
        // when this is 0 — otherwise the room shows live for the full
        // empty-grace window (default 300 s) after the last person
        // leaves, even though nobody can be heard.
        ['count', String(distinctPubkeys.size)],
        ['expiration', String(Math.floor(Date.now() / 1000) + ACTIVE_CALL_TTL_SECONDS)],
        ['t', 'obelisk-sfu-active-call'],
      ],
      created_at: Math.floor(Date.now() / 1000),
    });
  }
}
