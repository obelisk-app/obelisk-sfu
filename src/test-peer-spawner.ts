/**
 * Spawns / supervises `scripts/test-peers/test-peer-ms.mjs` child processes
 * driven by the admin UI. Each spawn gets a fresh ephemeral nsec (so
 * multiple test peers in the same room don't collide on identity), and
 * the running set is exposed via `list()` so the operator can stop them
 * individually. The actual mediasoup wiring still happens in the script
 * (it does the kind 25052 start, the kind 20078 beacon, the inject RPC,
 * and the ffmpeg pipelines) — this module is just a process manager.
 *
 * Why fork the existing script instead of inlining the work into the SFU?
 * Two reasons:
 *   1. The script signs Nostr events with a non-SFU identity. The SFU's
 *      RelayPool only knows the SFU's own key; signing an arbitrary nsec
 *      from inside the SFU process means duplicating the nostr-tools
 *      surface here. Spawning a child keeps the surface small.
 *   2. ffmpeg in-process via fluent-ffmpeg or native bindings is heavier
 *      than just forking the existing tested script. The script already
 *      handles SIGTERM cleanup of its own children.
 *
 * Reliability invariants (added 2026-05-08 after a multi-hour CPU pin):
 *
 *   - Each spawn becomes its own POSIX process group (`detached: true` →
 *     `setsid()`). On stop / lifetime expiry / SFU shutdown, we signal the
 *     negative pid (`process.kill(-pid)`) so SIGTERM reaches the test peer
 *     AND its ffmpeg children atomically. Without this, killing the node
 *     wrapper left ffmpeg orphans pinning a CPU each.
 *
 *   - A hard concurrent cap (`maxConcurrent`) refuses spawns past N. The
 *     admin UI hands operators a "spawn" button with no friction; it is
 *     trivial to forget that the previous peer is still running.
 *
 *   - A hard per-peer lifetime (`maxLifetimeSec`) auto-stops peers that
 *     outlive a normal debug session. Defends against the operator closing
 *     the admin tab and forgetting the peer is still consuming CPU.
 *
 *   - On boot, `reapOrphans()` scans `/proc` for ffmpeg processes whose
 *     command line matches the script's hardcoded encoder args (testsrc2 +
 *     sine 440 Hz). Any match is killed. This catches the case where a
 *     prior SFU instance died via SIGKILL and pm2 restarted us — the old
 *     ffmpegs are still pumping UDP into a now-dead mediasoup port.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, readdirSync, readFileSync } from 'node:fs';

import { getPublicKey } from 'nostr-tools';
import { hexToBytes } from '@noble/hashes/utils.js';

import { createLogger } from './log.js';
import type { Config } from './config.js';

const log = createLogger('test-peers');

/**
 * Substrings that uniquely identify a test-peer ffmpeg. Both come from
 * the encoder args hardcoded in `scripts/test-peers/test-peer-ms.mjs`.
 * If you change those args, change these too.
 */
const FFMPEG_SIGNATURES = [
  'testsrc2=size=640x480:rate=15',
  'sine=frequency=440:beep_factor=4',
] as const;

/** Thrown when a spawn is refused because we're at the concurrent cap. */
export class TestPeerCapError extends Error {
  readonly code = 'TEST_PEER_CAP';
  constructor(public readonly cap: number) {
    super(`test peer cap reached (max ${cap} concurrent)`);
    this.name = 'TestPeerCapError';
  }
}

export interface TestPeerInfo {
  peerId: string;
  channelId: string;
  pubkey: string;
  pid: number | null;
  startedAt: number;
  /** Seconds since spawn. Updated each time `list()` is called. */
  ageSec: number;
  /** Hard max-lifetime in seconds — peer is auto-stopped after this. */
  maxLifetimeSec: number;
  /** Relay URLs the script was invoked with — useful for diagnostics. */
  relays: string[];
}

interface RunningPeer {
  peerId: string;
  channelId: string;
  pubkey: string;
  pid: number | null;
  startedAt: number;
  relays: string[];
  child: ChildProcess;
}

export interface TestPeerSpawnerOptions {
  /** Max concurrent test peers across all channels. Default 5. */
  maxConcurrent?: number;
  /** Max lifetime per peer in seconds. Default 1800 (30 min). */
  maxLifetimeSec?: number;
  /**
   * How often the lifetime-enforcement timer fires, in seconds. Default 60.
   * Lower = peers exit closer to maxLifetimeSec; higher = less wakeup churn.
   */
  reapIntervalSec?: number;
}

export class TestPeerSpawner {
  private readonly peers = new Map<string, RunningPeer>();
  private readonly scriptPath: string;
  private readonly maxConcurrent: number;
  private readonly maxLifetimeSec: number;
  private reapTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly cfg: Config,
    private readonly sfuPubkey: string,
    opts: TestPeerSpawnerOptions = {},
  ) {
    this.maxConcurrent = Math.max(1, opts.maxConcurrent ?? 5);
    this.maxLifetimeSec = Math.max(60, opts.maxLifetimeSec ?? 1800);
    const reapIntervalMs = Math.max(10, opts.reapIntervalSec ?? 60) * 1000;

    // Resolve `scripts/test-peers/test-peer-ms.mjs` relative to the
    // running compiled module. Works under both `node dist/index.js`
    // (here = dist/, script = ../scripts/...) and dev (`tsx src/index.ts`,
    // here = src/, script = ../scripts/...).
    const here = dirname(fileURLToPath(import.meta.url));
    const candidates = [
      resolve(here, '../scripts/test-peers/test-peer-ms.mjs'),
      resolve(here, '../../scripts/test-peers/test-peer-ms.mjs'),
    ];
    const found = candidates.find(existsSync);
    if (!found) {
      throw new Error(`test-peer-ms.mjs not found, looked in: ${candidates.join(', ')}`);
    }
    this.scriptPath = found;

    this.reapTimer = setInterval(() => this.enforceLifetime(), reapIntervalMs);
    // Don't keep the event loop alive just for the reaper.
    this.reapTimer.unref?.();
  }

  /**
   * Fork a `test-peer-ms.mjs` child process targeting `channelId` with a
   * freshly-minted ephemeral identity. Returns immediately after spawn —
   * the script does its own discovery + ffmpeg startup async. If the room
   * isn't active yet on the SFU, the child will fail at the inject step
   * and exit; the operator sees that via `list()` showing the peer gone.
   *
   * `relays` (optional): the relay URLs the test peer publishes its
   * `start` + beacon events to. Defaults to the SFU's configured
   * `relays` list — that's the right answer for nearly every case, since
   * the SFU is already subscribed to those. Override is for diagnostic
   * runs where you want to test a single relay in isolation.
   */
  spawn(channelId: string, opts: { relays?: string[] } = {}): TestPeerInfo {
    if (!/^[0-9a-f]+$/i.test(channelId)) {
      throw new Error('channelId must be hex');
    }
    if (this.peers.size >= this.maxConcurrent) {
      throw new TestPeerCapError(this.maxConcurrent);
    }
    const peerId = randomBytes(8).toString('hex');
    const skBytes = randomBytes(32);
    const skHex = Buffer.from(skBytes).toString('hex');
    const pubkey = getPublicKey(hexToBytes(skHex));

    const relays = (opts.relays && opts.relays.length > 0
      ? opts.relays
      : this.cfg.relays
    ).filter((r) => /^wss?:\/\//.test(r));
    if (relays.length === 0) {
      throw new Error('no valid relays for test peer (must be ws:// or wss://)');
    }

    // Hand the SFU's known pubkey + url through so the script doesn't have
    // to discover us via kind 31313 — that lookup is flaky on NIP-29-only
    // relays that don't store advertisements. The script uses these env
    // vars when SFU_PUBKEY+SFU_URL are both set.
    const env = {
      ...process.env,
      TEST_PEER_NSEC_HEX: skHex,
      SFU_PUBKEY: this.sfuPubkey,
      // publicUrl is what cloudflared / the operator advertised. Falls
      // back to localhost so a local-dev SFU still works.
      SFU_URL: this.cfg.publicUrl ?? `http://127.0.0.1:${this.cfg.httpPort}`,
      TEST_PEER_RELAYS: relays.join(','),
      // Per-peer absolute lifetime — defense in depth so the script
      // self-terminates even if the spawner forgets it (e.g., SFU crash
      // + restart leaving the test peer reparented to init).
      TEST_PEER_MAX_LIFETIME_SEC: String(this.maxLifetimeSec),
    };

    log.info('spawning test peer', {
      peerId,
      channelId: channelId.slice(0, 8),
      pubkey: pubkey.slice(0, 8),
      script: this.scriptPath,
      maxLifetimeSec: this.maxLifetimeSec,
    });

    // detached: true → setsid() → child becomes its own process group leader.
    // We then signal the negative pid on stop, which delivers to every
    // process in the group (the test peer node script + its ffmpegs).
    // Without this, killing only the node wrapper used to leave ffmpeg
    // orphans behind whenever the wrapper exited abruptly.
    const child = spawn('node', [this.scriptPath, channelId], {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    });

    child.stdout?.on('data', (data: Buffer) => {
      log.debug('test peer stdout', { peerId, line: data.toString().trim() });
    });
    child.stderr?.on('data', (data: Buffer) => {
      log.debug('test peer stderr', { peerId, line: data.toString().trim() });
    });
    child.on('exit', (code, signal) => {
      log.info('test peer exited', { peerId, code, signal });
      this.peers.delete(peerId);
    });
    child.on('error', (err) => {
      log.warn('test peer spawn error', { peerId, err: err.message });
      this.peers.delete(peerId);
    });

    const info: RunningPeer = {
      peerId,
      channelId,
      pubkey,
      pid: child.pid ?? null,
      startedAt: Math.floor(Date.now() / 1000),
      relays,
      child,
    };
    this.peers.set(peerId, info);
    return this.toInfo(info);
  }

  /**
   * Send SIGTERM to the test peer's process group, then SIGKILL after a
   * short grace if it's still around. Idempotent — stopping an already-gone
   * peer is a no-op. Returns true if a process was sent the signal; false
   * if the peerId was unknown.
   */
  stop(peerId: string): boolean {
    const peer = this.peers.get(peerId);
    if (!peer) return false;
    log.info('stopping test peer', { peerId, pid: peer.pid });
    this.killPeerGroup(peer, 'SIGTERM');

    // Escalate to SIGKILL if the process group ignores SIGTERM. The exit
    // handler above will delete from the map either way; we proactively
    // delete here so a follow-up list() doesn't show a zombie entry.
    const killTimer = setTimeout(() => {
      if (this.peers.has(peerId)) {
        log.warn('test peer ignored SIGTERM, escalating to SIGKILL', { peerId });
        this.killPeerGroup(peer, 'SIGKILL');
      }
    }, 5_000);
    killTimer.unref?.();

    this.peers.delete(peerId);
    return true;
  }

  list(): TestPeerInfo[] {
    return Array.from(this.peers.values()).map((p) => this.toInfo(p));
  }

  /** Stop every running test peer. Called during SFU shutdown. */
  stopAll(): void {
    for (const peerId of Array.from(this.peers.keys())) this.stop(peerId);
  }

  /** Cap + lifetime config for the admin UI. */
  limits(): { maxConcurrent: number; maxLifetimeSec: number; active: number } {
    return {
      maxConcurrent: this.maxConcurrent,
      maxLifetimeSec: this.maxLifetimeSec,
      active: this.peers.size,
    };
  }

  /** Stop the lifetime-enforcement timer. Call during SFU shutdown. */
  dispose(): void {
    if (this.reapTimer) {
      clearInterval(this.reapTimer);
      this.reapTimer = null;
    }
  }

  /**
   * Sweep `/proc` for ffmpeg processes whose cmdline matches the
   * test-peer encoder args, and SIGTERM their process group. Intended to
   * run once at SFU boot — catches orphans left by a prior SFU instance
   * that exited via SIGKILL (so its in-process spawner never had a
   * chance to clean up). Safe to call any time `this.peers` is empty;
   * calling it while peers are running would also kill our own children.
   *
   * Returns the number of orphan PIDs signaled.
   */
  reapOrphans(): number {
    if (this.peers.size > 0) {
      log.warn('reapOrphans called with active peers — refusing to avoid self-kill', {
        active: this.peers.size,
      });
      return 0;
    }
    let killed = 0;
    let scanned = 0;
    for (const pid of listPids()) {
      scanned++;
      const cmdline = readCmdline(pid);
      if (!cmdline) continue;
      // Only ffmpeg, only with the test-peer signature. The signature is
      // unique enough that we won't hit unrelated ffmpeg jobs (browsers,
      // OBS, other ffmpegs without testsrc2 + ssrc 2222000x).
      if (!cmdline.startsWith('ffmpeg')) continue;
      if (!FFMPEG_SIGNATURES.some((sig) => cmdline.includes(sig))) continue;
      try {
        // Kill the whole process group if the ffmpeg is its own group
        // leader. If not (the prior SFU ran without detached:true), fall
        // back to killing just the pid — still reaps the leak.
        try { process.kill(-pid, 'SIGTERM'); }
        catch { process.kill(pid, 'SIGTERM'); }
        killed++;
        log.info('reaped orphan test-peer ffmpeg', { pid, cmdline: cmdline.slice(0, 120) });
      } catch (err) {
        log.warn('reapOrphans kill failed', { pid, err: (err as Error).message });
      }
    }
    if (killed > 0) {
      log.info('reapOrphans complete', { scanned, killed });
      // Schedule a SIGKILL pass for anything that ignored SIGTERM. We
      // don't recheck — `kill -0` would race; the next reap interval
      // catches stragglers.
      setTimeout(() => {
        for (const pid of listPids()) {
          const cmdline = readCmdline(pid);
          if (!cmdline?.startsWith('ffmpeg')) continue;
          if (!FFMPEG_SIGNATURES.some((sig) => cmdline.includes(sig))) continue;
          try {
            try { process.kill(-pid, 'SIGKILL'); }
            catch { process.kill(pid, 'SIGKILL'); }
            log.warn('orphan ignored SIGTERM, sent SIGKILL', { pid });
          } catch { /* already gone */ }
        }
      }, 2_000).unref?.();
    } else if (scanned > 0) {
      log.debug('reapOrphans complete — no orphans', { scanned });
    }
    return killed;
  }

  private enforceLifetime(): void {
    const now = Math.floor(Date.now() / 1000);
    for (const [peerId, peer] of this.peers) {
      const age = now - peer.startedAt;
      if (age >= this.maxLifetimeSec) {
        log.info('test peer exceeded max lifetime, stopping', {
          peerId, ageSec: age, maxLifetimeSec: this.maxLifetimeSec,
        });
        this.stop(peerId);
      }
    }
  }

  private killPeerGroup(peer: RunningPeer, signal: NodeJS.Signals): void {
    if (peer.pid == null) return;
    try {
      // Negative pid → process group. Reaches the test peer node script
      // AND its ffmpeg children in one syscall.
      process.kill(-peer.pid, signal);
    } catch (err) {
      // ESRCH = no such process group; child already exited. Anything
      // else (EPERM in particular) we want to know about.
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'ESRCH') {
        log.warn('killPeerGroup signal failed, falling back to single-pid', {
          pid: peer.pid, signal, err: (err as Error).message,
        });
        try { peer.child.kill(signal); } catch { /* gone */ }
      }
    }
  }

  private toInfo(p: RunningPeer): TestPeerInfo {
    const now = Math.floor(Date.now() / 1000);
    return {
      peerId: p.peerId,
      channelId: p.channelId,
      pubkey: p.pubkey,
      pid: p.pid,
      startedAt: p.startedAt,
      ageSec: Math.max(0, now - p.startedAt),
      maxLifetimeSec: this.maxLifetimeSec,
      relays: p.relays,
    };
  }
}

/** List numeric PIDs from /proc. Returns empty on non-Linux platforms. */
function listPids(): number[] {
  try {
    return readdirSync('/proc')
      .filter((name) => /^\d+$/.test(name))
      .map((name) => Number(name));
  } catch {
    return [];
  }
}

/** Read a process's cmdline (NUL-separated → space-separated). Returns null on error. */
function readCmdline(pid: number): string | null {
  try {
    const raw = readFileSync(`/proc/${pid}/cmdline`, 'utf8');
    // /proc/N/cmdline uses NUL separators and a trailing NUL.
    return raw.replace(/\0+$/, '').replace(/\0/g, ' ');
  } catch {
    return null;
  }
}
