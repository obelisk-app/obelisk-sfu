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
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';

import { getPublicKey } from 'nostr-tools';
import { hexToBytes } from '@noble/hashes/utils.js';

import { createLogger } from './log.js';
import type { Config } from './config.js';

const log = createLogger('test-peers');

export interface TestPeerInfo {
  peerId: string;
  channelId: string;
  pubkey: string;
  pid: number | null;
  startedAt: number;
  /** Relay URLs the script was invoked with — useful for diagnostics. */
  relays: string[];
}

interface RunningPeer extends TestPeerInfo {
  child: ChildProcess;
}

export class TestPeerSpawner {
  private readonly peers = new Map<string, RunningPeer>();
  private readonly scriptPath: string;

  constructor(
    private readonly cfg: Config,
    private readonly sfuPubkey: string,
  ) {
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
    };

    log.info('spawning test peer', {
      peerId,
      channelId: channelId.slice(0, 8),
      pubkey: pubkey.slice(0, 8),
      script: this.scriptPath,
    });

    const child = spawn('node', [this.scriptPath, channelId], {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      // detached: false so when the SFU exits, child gets SIGTERM via the
      // process group. We track and kill explicitly anyway, but this is
      // belt + suspenders for a crash-restart cycle.
      detached: false,
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
   * Send SIGTERM to the test peer's child process. Idempotent — stopping
   * an already-gone peer is a no-op. Returns true if a process was sent
   * the signal; false if the peerId was unknown.
   */
  stop(peerId: string): boolean {
    const peer = this.peers.get(peerId);
    if (!peer) return false;
    log.info('stopping test peer', { peerId });
    try { peer.child.kill('SIGTERM'); } catch { /* already gone */ }
    // The exit handler will delete from the map; but proactively delete
    // here too so a follow-up list() doesn't include zombies.
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

  private toInfo(p: RunningPeer): TestPeerInfo {
    return {
      peerId: p.peerId,
      channelId: p.channelId,
      pubkey: p.pubkey,
      pid: p.pid,
      startedAt: p.startedAt,
      relays: p.relays,
    };
  }
}
