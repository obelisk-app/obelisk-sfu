/**
 * Tiny HTTP server. Three endpoints, all read-only, all public.
 *
 *   GET /          — JSON service description (mirrors kind 31313).
 *   GET /healthz   — 200 OK with uptime; 503 if shutting down.
 *   GET /rooms     — sanitized list of active rooms (channel id, count, status).
 *
 * This is what the Cloudflare tunnel exposes. The tunnel is cosmetic —
 * call control happens over Nostr — but it gives operators a public
 * URL for monitoring and clients a verifiable identity endpoint.
 *
 * No auth on these endpoints. They expose nothing the relay doesn't
 * already serve via kind 31313 / 31314.
 */
import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createLogger } from './log.js';
import type { Config } from './config.js';
import type { RoomManager } from './room-manager.js';
import {
  AuthError,
  applyOverrides,
  effectiveOperator,
  loadRuntimeOverrides,
  saveRuntimeOverrides,
  verifyNip98,
  type RuntimeOverrides,
} from './admin.js';

const log = createLogger('http');

export interface HttpServerDeps {
  cfg: Config;
  sfuPubkey: string;
  rooms: RoomManager;
  bootedAt: number;
}

export class HttpServer {
  private server: Server | null = null;
  private shuttingDown = false;

  constructor(private readonly deps: HttpServerDeps) {}

  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      const server = createServer((req, res) => this.handle(req, res));
      server.on('error', (err) => {
        log.error('http server error', { err: (err as Error).message });
        reject(err);
      });
      server.listen(this.deps.cfg.httpPort, () => {
        log.info('http server listening', { port: this.deps.cfg.httpPort });
        resolve();
      });
      this.server = server;
    });
  }

  setShuttingDown(): void {
    this.shuttingDown = true;
  }

  stop(): Promise<void> {
    return new Promise((resolve) => {
      if (!this.server) return resolve();
      this.server.close(() => resolve());
      this.server = null;
    });
  }

  private handle(req: IncomingMessage, res: ServerResponse): void {
    const url = req.url ?? '/';
    const method = (req.method ?? 'GET').toUpperCase();

    if (method === 'POST' && (url === '/test/inject' || url.startsWith('/test/inject?'))) {
      return void this.handleTestInject(req, res);
    }
    if (url === '/admin' || url === '/admin/' || url.startsWith('/admin/ui')) {
      return this.handleAdminUi(req, res, url);
    }
    if (url === '/admin/state' || url.startsWith('/admin/state?')) {
      if (method === 'GET') return void this.handleAdminGet(req, res);
      if (method === 'PUT') return void this.handleAdminPut(req, res);
      return json(res, 405, { error: 'method not allowed' });
    }
    if (url === '/admin/restart' && method === 'POST') {
      return void this.handleAdminRestart(req, res);
    }

    if (method !== 'GET' && method !== 'HEAD') {
      return json(res, 405, { error: 'method not allowed' });
    }

    if (url === '/' || url.startsWith('/?')) {
      return this.handleRoot(res);
    }
    if (url === '/healthz' || url.startsWith('/healthz?')) {
      return this.handleHealth(res);
    }
    if (url === '/rooms' || url.startsWith('/rooms?')) {
      return this.handleRooms(res);
    }
    json(res, 404, { error: 'not found' });
  }

  private fullUrl(req: IncomingMessage): string {
    const host = req.headers.host ?? 'localhost';
    const proto = (req.headers['x-forwarded-proto'] as string) ?? 'https';
    return `${proto}://${host}${req.url ?? '/'}`;
  }

  private authOrFail(req: IncomingMessage, res: ServerResponse, method: string): string | null {
    try {
      const pubkey = verifyNip98(req.headers.authorization, method, this.fullUrl(req));
      const op = effectiveOperator(this.deps.cfg, this.deps.sfuPubkey);
      if (pubkey !== op) {
        json(res, 403, { error: 'not the operator', operator: op });
        return null;
      }
      return pubkey;
    } catch (err) {
      const e = err as AuthError;
      json(res, e.status ?? 401, { error: e.message });
      return null;
    }
  }

  private handleAdminGet(req: IncomingMessage, res: ServerResponse): void {
    if (!this.authOrFail(req, res, 'GET')) return;
    json(res, 200, this.adminSnapshot());
  }

  private async handleAdminPut(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!this.authOrFail(req, res, 'PUT')) return;
    let body = '';
    for await (const chunk of req) body += chunk;
    let patch: RuntimeOverrides;
    try {
      patch = JSON.parse(body) as RuntimeOverrides;
    } catch {
      return json(res, 400, { error: 'invalid json body' });
    }
    if (patch.relays) {
      for (const u of patch.relays) {
        if (!u.startsWith('wss://') && !u.startsWith('ws://')) {
          return json(res, 400, { error: `relays contains non-ws URL: ${u}` });
        }
      }
      if (patch.relays.length === 0) {
        return json(res, 400, { error: 'relays must list at least one URL' });
      }
    }
    if (patch.trustedAuthorRelays) {
      for (const u of patch.trustedAuthorRelays) {
        if (!u.startsWith('wss://') && !u.startsWith('ws://')) {
          return json(res, 400, { error: `trustedAuthorRelays contains non-ws URL: ${u}` });
        }
      }
    }
    if (patch.allowed) {
      for (const pk of patch.allowed) {
        if (!/^[0-9a-f]{64}$/i.test(pk)) {
          return json(res, 400, { error: `invalid allowed pubkey: ${pk}` });
        }
      }
    }
    if (patch.operatorPubkey && !/^[0-9a-f]{64}$/i.test(patch.operatorPubkey)) {
      return json(res, 400, { error: 'operatorPubkey must be 64-char hex' });
    }

    const merged: RuntimeOverrides = { ...loadRuntimeOverrides(), ...patch };
    saveRuntimeOverrides(merged);
    applyOverrides(this.deps.cfg, merged);
    log.info('admin overrides applied', { keys: Object.keys(patch) });
    json(res, 200, { ok: true, applied: Object.keys(patch), state: this.adminSnapshot() });
  }

  private handleAdminRestart(req: IncomingMessage, res: ServerResponse): void {
    if (!this.authOrFail(req, res, 'POST')) return;
    json(res, 200, { ok: true, restarting: true });
    log.info('admin requested restart');
    setTimeout(() => process.exit(0), 250);
  }

  private adminSnapshot() {
    const cfg = this.deps.cfg;
    return {
      pubkey: this.deps.sfuPubkey,
      operator: effectiveOperator(cfg, this.deps.sfuPubkey),
      relays: cfg.relays,
      trustedAuthorRelays: cfg.trustedAuthorRelays,
      allowed: [...cfg.allowedPubkeys],
      allowAll: cfg.allowAll,
      publicUrl: cfg.publicUrl,
      region: cfg.region,
      maxRooms: cfg.maxRooms,
      maxParticipantsPerRoom: cfg.maxParticipantsPerRoom,
      engine: cfg.engine,
      bootedAt: this.deps.bootedAt,
      activeRooms: this.deps.rooms.list().map((r) => ({
        channelId: r.channelId,
        status: r.status,
        participants: r.participants.length,
        host: r.hostPubkey,
        startedAt: r.startedAt,
      })),
    };
  }

  private handleAdminUi(_req: IncomingMessage, res: ServerResponse, url: string): void {
    // Static admin UI lives next to dist/ at admin-ui/. Resolve relative to
    // this compiled file so it works under both `node dist/index.js` and
    // `tsx watch src/index.ts`.
    const here = dirname(fileURLToPath(import.meta.url));
    const baseGuess = [
      resolve(here, '../admin-ui'),       // dist/ → ../admin-ui
      resolve(here, '../../admin-ui'),    // src/  → ../../admin-ui (dev)
    ].find(existsSync);
    if (!baseGuess) {
      return json(res, 500, { error: 'admin-ui not found on disk' });
    }
    let rel = url.replace(/^\/admin\/?(ui\/?)?/, '') || 'index.html';
    if (rel === '' || rel === '/') rel = 'index.html';
    rel = rel.split('?')[0]!.split('#')[0]!;
    if (rel.includes('..')) return json(res, 400, { error: 'bad path' });
    const file = resolve(baseGuess, rel);
    if (!file.startsWith(baseGuess) || !existsSync(file)) {
      return json(res, 404, { error: 'not found' });
    }
    const ct: Record<string, string> = {
      '.html': 'text/html; charset=utf-8',
      '.js': 'text/javascript; charset=utf-8',
      '.css': 'text/css; charset=utf-8',
      '.svg': 'image/svg+xml',
      '.png': 'image/png',
      '.ico': 'image/x-icon',
    };
    const type = ct[extname(file).toLowerCase()] ?? 'application/octet-stream';
    res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' });
    res.end(readFileSync(file));
  }

  /**
   * POST /test/inject
   *   { channelId, kind: 'audio'|'video', voiceKind, originPubkey }
   * Returns RTP listen tuple for the caller's ffmpeg to send to.
   * Only available when the engine is mediasoup. werift engine doesn't
   * have PlainTransport — call this against a mediasoup SFU only.
   */
  private async handleTestInject(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (this.deps.cfg.engine !== 'mediasoup') {
      return json(res, 501, { error: 'test inject requires SFU_ENGINE=mediasoup' });
    }
    let body = '';
    for await (const chunk of req) body += chunk;
    let data: { channelId?: string; kind?: 'audio' | 'video'; voiceKind?: string; originPubkey?: string };
    try { data = JSON.parse(body) as typeof data; }
    catch { return json(res, 400, { error: 'invalid json' }); }
    if (!data.channelId || !/^[0-9a-f]+$/i.test(data.channelId)) {
      return json(res, 400, { error: 'channelId must be hex' });
    }
    const kind = data.kind === 'video' ? 'video' : 'audio';
    const voiceKind = (data.voiceKind ?? (kind === 'audio' ? 'audio' : 'camera')) as 'audio' | 'camera' | 'screen' | 'screen-audio';
    const originPubkey = data.originPubkey;
    if (!originPubkey || !/^[0-9a-f]{64}$/i.test(originPubkey)) {
      return json(res, 400, { error: 'originPubkey must be 64-char hex' });
    }
    const room = this.deps.rooms.get(data.channelId);
    if (!room || !('injectTestProducer' in room)) {
      return json(res, 404, { error: 'no active mediasoup room for channelId' });
    }
    try {
      const result = await (room as { injectTestProducer: (o: { kind: 'audio' | 'video'; voiceKind: 'audio' | 'camera' | 'screen' | 'screen-audio'; originPubkey: string }) => Promise<unknown> })
        .injectTestProducer({ kind, voiceKind, originPubkey });
      return json(res, 200, result);
    } catch (err) {
      log.warn('test inject failed', { err: (err as Error).message });
      return json(res, 500, { error: (err as Error).message });
    }
  }

  private handleRoot(res: ServerResponse): void {
    json(res, 200, {
      service: 'obelisk-sfu',
      version: '0.1.0',
      pubkey: this.deps.sfuPubkey,
      url: this.deps.cfg.publicUrl,
      relays: this.deps.cfg.relays,
      cap: this.deps.cfg.maxParticipantsPerRoom,
      maxRooms: this.deps.cfg.maxRooms,
      codecs: ['opus', 'vp9', 'h264'],
      operator: this.deps.cfg.operatorPubkey ?? this.deps.sfuPubkey,
      region: this.deps.cfg.region,
      bootedAt: this.deps.bootedAt,
    });
  }

  private handleHealth(res: ServerResponse): void {
    if (this.shuttingDown) {
      return json(res, 503, { status: 'draining' });
    }
    json(res, 200, {
      status: 'ok',
      uptime: Math.floor(Date.now() / 1000) - this.deps.bootedAt,
      activeRooms: this.deps.rooms.size(),
    });
  }

  private handleRooms(res: ServerResponse): void {
    // Public-safe view: don't leak participant pubkey list, just count.
    const sanitized = this.deps.rooms.list().map((r) => ({
      channelId: r.channelId,
      status: r.status,
      participants: r.participants.length,
      startedAt: r.startedAt,
      host: r.hostPubkey,
    }));
    json(res, 200, { rooms: sanitized });
  }
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(payload);
}
