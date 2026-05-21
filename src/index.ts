/**
 * Obelisk SFU entrypoint.
 *
 * Boot sequence:
 *   1. Load config + identity.
 *   2. Open relay pool, advertise (kind 31313).
 *   3. Start membership tracker, room manager, call-listener.
 *   4. Start HTTP server.
 *   5. Trap SIGINT/SIGTERM/SIGHUP/SIGUSR1.
 *
 * Shutdown sequence:
 *   1. Mark HTTP /healthz as 503.
 *   2. Close all rooms (publishes kind 31314 status=closed for each).
 *   3. Stop call-listener, advertiser, membership.
 *   4. Close relay pool.
 *   5. Close HTTP server.
 *   6. Exit.
 */
import { Advertiser } from './advertise.js';
import { CallListener } from './call-listener.js';
import { createIdentity } from './identity.js';
import { createLogger } from './log.js';
import { HttpServer } from './http-server.js';
import { MembershipTracker } from './membership.js';
import { RelayPool } from './relay.js';
import { RoomManager } from './room-manager.js';
import { TestPeerSpawner } from './test-peer-spawner.js';
import { reapTestPeerOrphans } from './orphan-reaper.js';
import { createMediasoupEngine, type MediasoupEngine } from './mediasoup-server.js';
import { loadConfig, reloadAllowList, type Config } from './config.js';
import { applyOverrides, loadRuntimeOverrides } from './admin.js';
import { syncTrustedReferentFollows } from './follow-whitelist.js';

const log = createLogger('main');

async function main(): Promise<void> {
  const bootedAt = Math.floor(Date.now() / 1000);
  const cfg: Config = loadConfig();
  // Layer admin-ui-driven overrides on top of env. Lives in runtime.json
  // and is the source of truth for relay/allow-list edits made via the
  // admin panel. .env stays as the operator's static baseline.
  applyOverrides(cfg, loadRuntimeOverrides());
  const identity = createIdentity(cfg.nsecHex);
  if (cfg.trustedReferentPubkeys.size > 0) {
    void syncTrustedReferentFollows(cfg).catch((err) =>
      log.warn('trusted referent follow sync failed', { err: (err as Error).message }),
    );
  }

  log.info('boot', {
    pubkey: identity.pubkey,
    operator: cfg.operatorPubkey ?? '(self)',
    relays: cfg.relays.length,
    cap: cfg.maxParticipantsPerRoom,
  });

  // Trusted-author relays are subscribe-only — the SFU isn't necessarily
  // whitelisted for writes there, but it needs to read incoming `start`
  // and kind 25050 traffic from them. Pool them in as read-only so
  // every subscribe() naturally fans across the union.
  const relay = new RelayPool(cfg.relays, identity, cfg.trustedAuthorRelays);
  const membership = new MembershipTracker(relay);

  // mediasoup engine: only spun up when SFU_ENGINE=mediasoup. The werift
  // path keeps zero native dependencies for backward compat.
  let mediasoupEngine: MediasoupEngine | null = null;
  if (cfg.engine === 'mediasoup') {
    mediasoupEngine = await createMediasoupEngine(cfg);
  }

  const rooms = new RoomManager(cfg, relay, membership, mediasoupEngine);
  const advertiser = new Advertiser(cfg, relay);
  const listener = new CallListener(cfg, relay, rooms);
  // Test-peer spawner supports both mediasoup and mesh modes. The mediasoup
  // script needs /test/inject, but the mesh script is pure Nostr/WebRTC.
  const testPeers = new TestPeerSpawner(cfg, identity.pubkey);
  // Sweep ffmpeg orphans from any prior SFU instance that exited via
  // SIGKILL before its spawner could send SIGTERM. One-shot, only at boot,
  // BEFORE any new spawn — otherwise we'd kill our own freshly-launched
  // children. The 2026-05-07 incident was load avg 13 from three of these.
  const killed = reapTestPeerOrphans();
  if (killed > 0) log.warn('reaped orphan test-peer ffmpegs at boot', { killed });
  const http = new HttpServer({
    cfg,
    sfuPubkey: identity.pubkey,
    rooms,
    bootedAt,
    relay,
    advertiser,
    listener,
    testPeers,
  });

  await advertiser.start();
  listener.start();
  await http.start();

  log.info('ready', {
    publicUrl: cfg.publicUrl ?? `http://127.0.0.1:${cfg.httpPort}`,
    pubkey: identity.pubkey,
  });

  // ── Signals ────────────────────────────────────────────────────────────

  let shuttingDown = false;
  async function shutdown(signal: string, exitCode: number): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info('shutdown initiated', { signal });

    http.setShuttingDown();
    listener.stop();
    advertiser.stop();
    testPeers?.stopAll();

    try {
      await rooms.closeAll();
    } catch (err) {
      log.warn('closeAll threw', { err: (err as Error).message });
    }

    try {
      await http.stop();
    } catch (err) {
      log.warn('http.stop threw', { err: (err as Error).message });
    }

    relay.close();
    if (mediasoupEngine) {
      try { await mediasoupEngine.close(); } catch (err) {
        log.warn('mediasoup engine close threw', { err: (err as Error).message });
      }
    }
    log.info('shutdown complete');
    // Give the event loop a tick to flush logs.
    setTimeout(() => process.exit(exitCode), 50);
  }

  process.on('SIGINT', () => void shutdown('SIGINT', 0));
  process.on('SIGTERM', () => void shutdown('SIGTERM', 0));
  process.on('uncaughtException', (err) => {
    log.error('uncaughtException', { err: err.message, stack: err.stack });
    void shutdown('uncaughtException', 1);
  });
  // Treat unhandledRejection the same as uncaughtException. Previously this
  // only logged, which left the process running in a half-broken state
  // (rooms still publishing kind 31314 while their RPC handlers were dead).
  // systemd's `Restart=on-failure` only kicks in on non-zero exit, so a
  // silent zombie was the single biggest "needs manual restart" vector —
  // exiting(1) here is what gives the supervisor a signal to act on.
  process.on('unhandledRejection', (err) => {
    log.error('unhandledRejection', {
      err: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
    });
    void shutdown('unhandledRejection', 1);
  });

  // ── Self-heal watchdog ────────────────────────────────────────────────
  // Polls the same predicates the public /healthz uses, but on a faster
  // cadence and with a hysteresis window. If health has been bad for the
  // full window we exit(1) — systemd then restarts a clean process. This
  // is the catch-all for failure modes that aren't "the process threw":
  //   - every write relay has been silent for too long (we'd be a phantom
  //     advertisement on relays nobody listens to)
  //   - relay subscriptions wedged in a way the call-listener watchdog
  //     couldn't unwedge
  //   - any future degraded-but-running state we add a predicate for
  const WATCHDOG_INTERVAL_MS = 30_000;
  const WATCHDOG_GRACE_MS = 5 * 60_000;
  let firstBadAt: number | null = null;
  const watchdog = setInterval(() => {
    if (shuttingDown) return;
    const now = Date.now();
    const reason = degradedReason(now);
    if (reason == null) {
      if (firstBadAt != null) log.info('watchdog: health recovered');
      firstBadAt = null;
      return;
    }
    if (firstBadAt == null) {
      firstBadAt = now;
      log.warn('watchdog: health degraded — restart pending if not recovered', { reason });
      return;
    }
    const badFor = now - firstBadAt;
    if (badFor >= WATCHDOG_GRACE_MS) {
      log.error('watchdog: degraded too long — exiting for supervisor restart', {
        reason,
        degradedForSeconds: Math.floor(badFor / 1000),
      });
      void shutdown(`watchdog:${reason}`, 1);
    }
  }, WATCHDOG_INTERVAL_MS);
  watchdog.unref?.();

  function degradedReason(nowMs: number): string | null {
    const uptimeSec = Math.floor(nowMs / 1000) - bootedAt;
    // Skip the first WATCHDOG_GRACE_MS of uptime so the SFU has time to
    // settle a publish-ack on at least one write relay before the watchdog
    // could mark it as deaf.
    if (uptimeSec * 1000 < WATCHDOG_GRACE_MS) return null;
    const writeRelays = relay.getRelayHealth().filter((h) => h.role === 'write');
    if (writeRelays.length === 0) return null;
    const nowSec = Math.floor(nowMs / 1000);
    const anyAlive = writeRelays.some(
      (h) => h.lastPublishOk != null && nowSec - h.lastPublishOk < Math.floor(WATCHDOG_GRACE_MS / 1000),
    );
    if (!anyAlive) return 'all-write-relays-silent';
    return null;
  }

  // SIGHUP — reload allow-list + republish advertisement.
  process.on('SIGHUP', () => {
    log.info('SIGHUP — reloading allow-list');
    const { added, removed } = reloadAllowList(cfg);
    if (cfg.trustedReferentPubkeys.size > 0) {
      void syncTrustedReferentFollows(cfg).catch((err) =>
        log.warn('trusted referent follow sync failed', { err: (err as Error).message }),
      );
    }
    if (added > 0 || removed > 0) {
      void advertiser.republish().catch((err) =>
        log.warn('advertisement republish failed', { err: (err as Error).message }),
      );
    }
  });

  // SIGUSR1 — drain (stop accepting new rooms, let existing rooms finish).
  process.on('SIGUSR1', () => {
    log.info('SIGUSR1 — entering drain mode');
    rooms.setDraining();
  });
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('boot failed:', err);
  process.exit(1);
});
