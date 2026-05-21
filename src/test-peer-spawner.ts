/**
 * Spawns / supervises synthetic test-peer child processes driven by the admin UI.
 *
 * Modes:
 *   - sfu: scripts/test-peers/test-peer-ms.mjs drives mediasoup PlainTransport
 *          injection and validates SFU forwarding.
 *   - mesh: scripts/test-peers/test-peer-mesh.mjs joins as a regular P2P
 *           participant and validates browser mesh signaling/media.
 *
 * Each spawn gets a fresh ephemeral nsec so multiple test peers in the same
 * room do not collide on identity. The actual media and Nostr work stays in
 * the scripts; this module is just a process manager.
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

export type TestPeerMode = 'sfu' | 'mesh';

export interface TestPeerInfo {
  peerId: string;
  channelId: string;
  mode: TestPeerMode;
  pubkey: string;
  pid: number | null;
  startedAt: number;
  /** Relay URLs the script was invoked with - useful for diagnostics. */
  relays: string[];
}

interface RunningPeer extends TestPeerInfo {
  child: ChildProcess;
}

export class TestPeerSpawner {
  private readonly peers = new Map<string, RunningPeer>();
  private readonly scriptPaths: Record<TestPeerMode, string>;

  constructor(
    private readonly cfg: Config,
    private readonly sfuPubkey: string,
  ) {
    const here = dirname(fileURLToPath(import.meta.url));
    this.scriptPaths = {
      sfu: this.resolveScript(here, 'test-peer-ms.mjs'),
      mesh: this.resolveScript(here, 'test-peer-mesh.mjs'),
    };
  }

  private resolveScript(here: string, file: string): string {
    // Works under both node dist/index.js (here = dist/) and dev
    // (tsx src/index.ts, here = src/).
    const candidates = [
      resolve(here, '../scripts/test-peers/' + file),
      resolve(here, '../../scripts/test-peers/' + file),
    ];
    const found = candidates.find(existsSync);
    if (!found) throw new Error(file + ' not found, looked in: ' + candidates.join(', '));
    return found;
  }

  /**
   * Fork a synthetic test peer targeting channelId with a freshly-minted
   * ephemeral identity. Returns immediately after spawn; the script handles
   * discovery/media startup asynchronously.
   */
  spawn(channelId: string, opts: { relays?: string[]; mode?: TestPeerMode } = {}): TestPeerInfo {
    if (!/^[0-9a-f]+$/i.test(channelId)) {
      throw new Error('channelId must be hex');
    }
    const mode = opts.mode ?? 'sfu';
    if (mode !== 'sfu' && mode !== 'mesh') {
      throw new Error('mode must be sfu or mesh');
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

    const env = {
      ...process.env,
      TEST_PEER_NSEC_HEX: skHex,
      TEST_PEER_RELAYS: relays.join(','),
      TEST_PEER_MODE: mode,
    };

    if (mode === 'sfu') {
      Object.assign(env, {
        SFU_PUBKEY: this.sfuPubkey,
        // publicUrl is what cloudflared / the operator advertised. Falls
        // back to localhost so a local-dev SFU still works.
        SFU_URL: this.cfg.publicUrl ?? 'http://127.0.0.1:' + this.cfg.httpPort,
      });
    }

    const scriptPath = this.scriptPaths[mode];
    log.info('spawning test peer', {
      peerId,
      mode,
      channelId: channelId.slice(0, 8),
      pubkey: pubkey.slice(0, 8),
      script: scriptPath,
    });

    const child = spawn('node', [scriptPath, channelId], {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: false,
    });

    child.stdout?.on('data', (data: Buffer) => {
      log.debug('test peer stdout', { peerId, mode, line: data.toString().trim() });
    });
    child.stderr?.on('data', (data: Buffer) => {
      log.debug('test peer stderr', { peerId, mode, line: data.toString().trim() });
    });
    child.on('exit', (code, signal) => {
      log.info('test peer exited', { peerId, mode, code, signal });
      this.peers.delete(peerId);
    });
    child.on('error', (err) => {
      log.warn('test peer spawn error', { peerId, mode, err: err.message });
      this.peers.delete(peerId);
    });

    const info: RunningPeer = {
      peerId,
      channelId,
      mode,
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
   * Send SIGTERM to the test peer's child process. Idempotent.
   */
  stop(peerId: string): boolean {
    const peer = this.peers.get(peerId);
    if (!peer) return false;
    log.info('stopping test peer', { peerId, mode: peer.mode });
    try { peer.child.kill('SIGTERM'); } catch { /* already gone */ }
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
      mode: p.mode,
      pubkey: p.pubkey,
      pid: p.pid,
      startedAt: p.startedAt,
      relays: p.relays,
    };
  }
}
