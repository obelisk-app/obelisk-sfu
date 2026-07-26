/**
 * Tiny HTTP server. Three endpoints, all read-only, all public.
 *
 *   GET /          — JSON service description (mirrors kind 31313).
 *   GET /healthz   — 200 OK with uptime; 503 if shutting down.
 *   GET /rooms     — sanitized list of active rooms (channel id, count, status).
 *
 * This is what the Cloudflare tunnel exposes. Clients verify `/info` and
 * use the authenticated `/rpc` WebSocket; Nostr remains the discovery and
 * backward-compatible signaling path.
 *
 * No auth on these endpoints. They expose nothing the relay doesn't
 * already serve via kind 31313 / 31314.
 */
import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createLogger } from './log.js';
import type { Advertiser } from './advertise.js';
import type { CallListener } from './call-listener.js';
import type { ChannelRegistry } from './channel-registry.js';
import type { Config } from './config.js';
import type { RelayPool } from './relay.js';
import type { RoomManager } from './room-manager.js';
import type { TestPeerIdentityMode, TestPeerMode, TestPeerSpawner } from './test-peer-spawner.js';
import {
  AuthError,
  applyOverrides,
  effectiveOperator,
  loadRuntimeOverrides,
  saveRuntimeOverrides,
  verifyNip98,
  type RuntimeOverrides,
} from './admin.js';
import { attachDirectRpc } from './direct-rpc.js';
import { syncTrustedReferentFollows } from './follow-whitelist.js';

const log = createLogger('http');

export function testPeerModeForChannel(channelKind: string | null, requested?: TestPeerMode): TestPeerMode {
  if (channelKind === 'voice') return 'mesh';
  if (channelKind === 'voice-sfu') return 'sfu';
  return requested ?? 'sfu';
}

export interface HttpServerDeps {
  cfg: Config;
  sfuPubkey: string;
  rooms: RoomManager;
  bootedAt: number;
  /** Required for relay health surfaced in /admin/state and /healthz. */
  relay: RelayPool;
  /** Required for last-advertise timestamp surfaced in /admin/state. */
  advertiser: Advertiser;
  /** Required for per-relay subscription status in /admin/state. */
  listener: CallListener;
  /** Watches kind 39000 metadata so the SFU knows voice vs voice-sfu channels. */
  channels: ChannelRegistry;
  /**
   * Optional test-peer spawner — exposed at /admin/test-peer/* when present.
   * Can spawn both SFU media peers and mesh P2P peers.
   */
  testPeers: TestPeerSpawner | null;
}

/**
 * /healthz returns 503 if NO relay has acknowledged a publish in this many
 * seconds. Single-relay degradation stays 200 so a flapping non-critical
 * relay doesn't trigger pointless restarts; total deafness should page.
 */
const HEALTHZ_ALL_RELAYS_DEAD_SEC = 15 * 60;

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
      attachDirectRpc(server, {
        cfg: this.deps.cfg,
        sfuPubkey: this.deps.sfuPubkey,
        rooms: this.deps.rooms,
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
    if (url === '/admin/sync-follows' && method === 'POST') {
      return void this.handleAdminSyncFollows(req, res);
    }
    if (url === '/admin/test-peers' && method === 'GET') {
      return void this.handleTestPeerList(req, res);
    }
    if (url === '/admin/test-peer/spawn' && method === 'POST') {
      return void this.handleTestPeerSpawn(req, res);
    }
    if (url === '/admin/test-peer/stop' && method === 'POST') {
      return void this.handleTestPeerStop(req, res);
    }

    if (method !== 'GET' && method !== 'HEAD') {
      return json(res, 405, { error: 'method not allowed' });
    }

    if (url === '/' || url.startsWith('/?')) {
      return this.handleRoot(req, res);
    }
    if (url === '/info' || url.startsWith('/info?')) {
      return this.handleInfo(res);
    }
    if (url === '/healthz' || url.startsWith('/healthz?')) {
      return this.handleHealth(res);
    }
    if (url === '/rooms' || url.startsWith('/rooms?')) {
      return this.handleRooms(res);
    }
    if (url === '/channels/resolve' || url.startsWith('/channels/resolve?')) {
      return this.handleChannelResolve(req, res);
    }
    if (url === '/channels' || url.startsWith('/channels?')) {
      return this.handleChannels(res);
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
    if (patch.trustedReferentPubkeys) {
      for (const pk of patch.trustedReferentPubkeys) {
        if (!/^[0-9a-f]{64}$/i.test(pk)) {
          return json(res, 400, { error: `invalid trusted referent pubkey: ${pk}` });
        }
      }
    }
    if (patch.whitelistBypassUntil !== undefined && patch.whitelistBypassUntil !== null) {
      const until = patch.whitelistBypassUntil;
      const now = Math.floor(Date.now() / 1000);
      if (typeof until !== 'number' || !Number.isFinite(until) || until < now) {
        return json(res, 400, { error: 'whitelistBypassUntil must be a future unix timestamp or null' });
      }
      if (until - now > 3600) {
        return json(res, 400, { error: 'whitelistBypassUntil cannot be more than one hour from now' });
      }
    }
    if (patch.operatorPubkey && !/^[0-9a-f]{64}$/i.test(patch.operatorPubkey)) {
      return json(res, 400, { error: 'operatorPubkey must be 64-char hex' });
    }
    if (patch.maxCallDurationSeconds !== undefined) {
      const n = patch.maxCallDurationSeconds;
      if (typeof n !== 'number' || !Number.isFinite(n) || n < 0 || n > 24 * 3600) {
        return json(res, 400, { error: 'maxCallDurationSeconds must be 0..86400 (0 disables the cap)' });
      }
    }

    const prevMaxDuration = this.deps.cfg.maxCallDurationSeconds;
    const merged: RuntimeOverrides = { ...loadRuntimeOverrides(), ...patch };
    saveRuntimeOverrides(merged);
    applyOverrides(this.deps.cfg, merged);
    if (patch.trustedReferentPubkeys) {
      try { await syncTrustedReferentFollows(this.deps.cfg); }
      catch (err) { log.warn('trusted referent follow sync failed', { err: (err as Error).message }); }
    }
    // If the duration cap changed, re-arm every active room's end timer so
    // an in-progress call picks up the new ceiling without waiting for a
    // rules update from the host.
    if (patch.maxCallDurationSeconds !== undefined &&
        this.deps.cfg.maxCallDurationSeconds !== prevMaxDuration) {
      this.deps.rooms.rearmDurationLimits();
    }
    log.info('admin overrides applied', { keys: Object.keys(patch) });
    json(res, 200, { ok: true, applied: Object.keys(patch), state: this.adminSnapshot() });
  }

  private async handleAdminSyncFollows(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!this.authOrFail(req, res, 'POST')) return;
    try {
      const result = await syncTrustedReferentFollows(this.deps.cfg);
      json(res, 200, { ok: true, ...result, state: this.adminSnapshot() });
    } catch (err) {
      json(res, 500, { error: (err as Error).message });
    }
  }

  private handleAdminRestart(req: IncomingMessage, res: ServerResponse): void {
    if (!this.authOrFail(req, res, 'POST')) return;
    json(res, 200, { ok: true, restarting: true });
    log.info('admin requested restart');
    setTimeout(() => process.exit(0), 250);
  }

  private handleTestPeerList(req: IncomingMessage, res: ServerResponse): void {
    if (!this.authOrFail(req, res, 'GET')) return;
    if (!this.deps.testPeers) {
      return json(res, 501, { error: 'test peer spawner is unavailable' });
    }
    json(res, 200, { peers: this.deps.testPeers.list() });
  }

  private async handleTestPeerSpawn(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!this.authOrFail(req, res, 'POST')) return;
    if (!this.deps.testPeers) {
      return json(res, 501, { error: 'test peer spawner is unavailable' });
    }
    let body = '';
    for await (const chunk of req) body += chunk;
    let data: { channelId?: string; channelUrl?: string; url?: string; link?: string; relays?: string[]; mode?: TestPeerMode; identityMode?: TestPeerIdentityMode };
    try { data = JSON.parse(body) as typeof data; }
    catch { return json(res, 400, { error: 'invalid json' }); }
    const parsedInput = this.parseChannelInput(data.channelId ?? data.channelUrl ?? data.url ?? data.link ?? '');
    if (!parsedInput.channelId) {
      return json(res, 400, { error: 'channelId, channelUrl, url, or link must contain a hex channel id' });
    }
    const channelId = parsedInput.channelId;
    if (data.relays !== undefined && !Array.isArray(data.relays)) {
      return json(res, 400, { error: 'relays must be an array of ws:// or wss:// URLs' });
    }
    const channel = this.deps.channels.getChannel(channelId);
    const mode = testPeerModeForChannel(channel?.kind ?? null, data.mode);
    if (mode !== 'sfu' && mode !== 'mesh') {
      return json(res, 400, { error: 'mode must be sfu or mesh' });
    }
    if (data.identityMode !== undefined && data.identityMode !== 'ephemeral' && data.identityMode !== 'sfu') {
      return json(res, 400, { error: 'identityMode must be ephemeral or sfu' });
    }
    try {
      const linkRelays = parsedInput.relay ? [parsedInput.relay] : undefined;
      const inferredRelays = mode === 'mesh' && channel?.relays?.length ? channel.relays : undefined;
      const relays = data.relays ?? linkRelays ?? inferredRelays;
      const identityMode = data.identityMode ?? this.defaultTestPeerIdentityMode(mode, relays ?? []);
      const info = this.deps.testPeers.spawn(channelId, {
        ...(relays ? { relays } : {}),
        mode,
        identityMode,
      });
      log.info('admin spawned test peer', {
        peerId: info.peerId,
        mode: info.mode,
        channel: channelId.slice(0, 8),
        relays: info.relays.length,
        identityMode: info.identityMode,
        channelRelays: channel?.relays?.length ?? 0,
      });
      json(res, 200, info);
    } catch (err) {
      json(res, 500, { error: (err as Error).message });
    }
  }

  private defaultTestPeerIdentityMode(mode: TestPeerMode, relays: readonly string[]): TestPeerIdentityMode {
    if (mode !== 'mesh') return 'ephemeral';
    if (relays.length === 0) return 'ephemeral';
    return relays.every((relay) => this.isOpenTestPeerRelay(relay)) ? 'ephemeral' : 'sfu';
  }

  private isOpenTestPeerRelay(relay: string): boolean {
    try {
      return new URL(relay).hostname === 'public.obelisk.ar';
    } catch {
      return false;
    }
  }

  private async handleTestPeerStop(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!this.authOrFail(req, res, 'POST')) return;
    if (!this.deps.testPeers) {
      return json(res, 501, { error: 'test peer spawner is unavailable' });
    }
    let body = '';
    for await (const chunk of req) body += chunk;
    let data: { peerId?: string };
    try { data = JSON.parse(body) as typeof data; }
    catch { return json(res, 400, { error: 'invalid json' }); }
    const peerId = (data.peerId ?? '').trim();
    if (!peerId) return json(res, 400, { error: 'peerId required' });
    const ok = this.deps.testPeers.stop(peerId);
    if (!ok) return json(res, 404, { error: 'unknown peerId' });
    json(res, 200, { ok: true });
  }

  private adminSnapshot() {
    const cfg = this.deps.cfg;
    // Fold the listener's per-relay subscription presence into each entry
    // from RelayPool's health snapshot — operators want to see "publish ok
    // AND I'm still subscribed" as a single row, not two parallel lists.
    const subscribedSet = new Set(this.deps.listener.getRelayStatus().map((s) => s.url));
    const relayHealth = this.deps.relay.getRelayHealth().map((h) => ({
      ...h,
      subscribed: subscribedSet.has(h.url),
    }));
    return {
      pubkey: this.deps.sfuPubkey,
      operator: effectiveOperator(cfg, this.deps.sfuPubkey),
      relays: cfg.relays,
      trustedAuthorRelays: cfg.trustedAuthorRelays,
      allowed: [...cfg.allowedPubkeys],
      trustedReferentPubkeys: [...cfg.trustedReferentPubkeys],
      followAllowedCount: cfg.followAllowedPubkeys.size,
      whitelistBypassUntil: cfg.whitelistBypassUntil,
      allowAll: cfg.allowAll,
      requireAllowedPubkey: cfg.requireAllowedPubkey,
      publicUrl: cfg.publicUrl,
      region: cfg.region,
      maxRooms: cfg.maxRooms,
      maxParticipantsPerRoom: cfg.maxParticipantsPerRoom,
      maxCallDurationSeconds: cfg.maxCallDurationSeconds,
      engine: cfg.engine,
      bootedAt: this.deps.bootedAt,
      activeRooms: this.deps.rooms.list().map((r) => ({
        channelId: r.channelId,
        channelKind: this.deps.channels.getChannel(r.channelId)?.kind ?? 'unknown',
        status: r.status,
        participants: r.participants.length,
        host: r.hostPubkey,
        startedAt: r.startedAt,
      })),
      channelRegistry: this.deps.channels.getStatus(),
      voiceChannels: this.deps.channels.listVoiceChannels(),
      relayHealth,
      advertiser: this.deps.advertiser.getStatus(),
      testPeers: this.deps.testPeers ? this.deps.testPeers.list() : null,
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

  /**
   * GET / — serves the public landing page (HTML) for browsers, or the
   * machine-readable JSON service descriptor for non-browser clients.
   * Browsers detected via Accept: text/html. Anything else (curl with
   * no Accept, kind 31313 consumers, monitoring probes) keeps getting
   * the JSON they had before, so this is a non-breaking change.
   *
   * The same JSON is also at /info unconditionally for clients that
   * want to bypass the negotiation.
   */
  private handleRoot(req: IncomingMessage, res: ServerResponse): void {
    const accept = (req.headers.accept ?? '').toLowerCase();
    const wantsHtml = accept.includes('text/html');
    if (wantsHtml) {
      return this.handleLanding(res);
    }
    this.handleInfo(res);
  }

  private handleInfo(res: ServerResponse): void {
    json(res, 200, {
      service: 'obelisk-sfu',
      version: '0.1.0',
      pubkey: this.deps.sfuPubkey,
      url: this.deps.cfg.publicUrl,
      relays: this.deps.cfg.relays,
      trustedAuthorRelays: this.deps.cfg.trustedAuthorRelays,
      cap: this.deps.cfg.maxParticipantsPerRoom,
      maxRooms: this.deps.cfg.maxRooms,
      codecs: ['opus', 'vp8'],
      operator: this.deps.cfg.operatorPubkey ?? this.deps.sfuPubkey,
      region: this.deps.cfg.region,
      bootedAt: this.deps.bootedAt,
      activeRooms: this.deps.rooms.size(),
      channelRegistry: this.deps.channels.getStatus(),
      voiceChannels: this.deps.channels.listVoiceChannels().length,
    });
  }

  private handleLanding(res: ServerResponse): void {
    // Same La Crypta theme + grid backdrop the admin UI uses, but the
    // payload is read-only and unauthenticated. The JSON descriptor is
    // still reachable at /info; this is the human-friendly view.
    const cfg = this.deps.cfg;
    const ops = cfg.operatorPubkey ?? this.deps.sfuPubkey;
    const uptime = Math.max(0, Math.floor(Date.now() / 1000) - this.deps.bootedAt);
    const escape = (s: string) => s.replace(/[&<>"]/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;',
    }[c] as string));
    const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Obelisk SFU</title>
<style>
  :root {
    --lc-black: #0a0a0a;
    --lc-dark: #171717;
    --lc-border: #262626;
    --lc-green: #b4f953;
    --lc-white: #fafafa;
    --lc-muted: #a3a3a3;
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; background: var(--lc-black); color: var(--lc-white); font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
  body {
    min-height: 100vh;
    background-image: linear-gradient(rgba(255,255,255,.02) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,.02) 1px, transparent 1px);
    background-size: 32px 32px;
  }
  main { max-width: 760px; margin: 0 auto; padding: 64px 20px 80px; }
  .hero { text-align: center; margin-bottom: 32px; }
  .hero h1 { margin: 0; font-size: 40px; letter-spacing: .02em; }
  .hero h1 .acc { color: var(--lc-green); }
  .hero p { margin: 12px auto 0; max-width: 520px; color: var(--lc-muted); font-size: 14px; line-height: 1.5; }
  .pill {
    display: inline-block; padding: 10px 20px; border-radius: 9999px;
    background: var(--lc-green); color: var(--lc-black); font-size: 14px; font-weight: 600;
    text-decoration: none; margin: 16px 6px 0;
    transition: opacity .15s;
  }
  .pill:hover { opacity: .85; }
  .pill.secondary { background: var(--lc-border); color: var(--lc-white); }
  .card { background: var(--lc-dark); border: 1px solid var(--lc-border); border-radius: 12px; padding: 20px; margin-top: 20px; }
  h2 { margin: 0 0 12px; font-size: 13px; letter-spacing: .12em; text-transform: uppercase; color: var(--lc-muted); }
  .kv { display: grid; grid-template-columns: 140px 1fr; gap: 8px 16px; align-items: baseline; font-size: 13px; }
  .kv > div:nth-child(odd) { color: var(--lc-muted); font-size: 11px; text-transform: uppercase; letter-spacing: .08em; }
  .kv > div:nth-child(even) { word-break: break-all; }
  .mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; }
  .badge { display: inline-block; padding: 2px 8px; border-radius: 9999px; font-size: 11px; background: var(--lc-green); color: var(--lc-black); margin-left: 8px; }
  ul { list-style: none; padding: 0; margin: 0; }
  ul li { padding: 4px 0; font-size: 12px; color: var(--lc-muted); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
  footer { margin-top: 48px; text-align: center; color: var(--lc-muted); font-size: 12px; }
  footer a { color: var(--lc-muted); text-decoration: underline; }
</style>
</head>
<body>
<main>
  <section class="hero">
    <h1>Obelisk <span class="acc">SFU</span></h1>
    <p>Mediasoup-backed selective forwarding unit for Obelisk voice/video rooms. Nostr-signaled, allow-listed, operator-run.</p>
    <a class="pill" href="/admin">Open admin</a>
    <a class="pill secondary" href="/info">Service info (JSON)</a>
  </section>

  <section class="card">
    <h2>Identity <span class="badge">live</span></h2>
    <div class="kv">
      <div>Pubkey</div><div class="mono">${escape(this.deps.sfuPubkey)}</div>
      <div>Operator</div><div class="mono">${escape(ops)}</div>
      <div>Public URL</div><div class="mono">${escape(cfg.publicUrl ?? '—')}</div>
      <div>Region</div><div class="mono">${escape(cfg.region ?? '—')}</div>
      <div>Engine</div><div class="mono">${escape(cfg.engine)}</div>
      <div>Capacity</div><div class="mono">${cfg.maxParticipantsPerRoom}/room · ${cfg.maxRooms} rooms</div>
      <div>Active rooms</div><div class="mono">${this.deps.rooms.size()}</div>
      <div>Voice channels</div><div class="mono">${this.deps.channels.getStatus().voiceChannels}</div>
      <div>Uptime</div><div class="mono">${uptime}s</div>
    </div>
  </section>

  <section class="card">
    <h2>Relays</h2>
    <ul>
      ${cfg.relays.map((r) => `<li>· ${escape(r)}</li>`).join('')}
    </ul>
  </section>

  <footer>
    Operator-run service · <a href="/info">/info</a> · <a href="/healthz">/healthz</a> · <a href="/rooms">/rooms</a> · <a href="/channels">/channels</a>
  </footer>
</main>
</body>
</html>`;
    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
    });
    res.end(html);
  }

  private handleHealth(res: ServerResponse): void {
    if (this.shuttingDown) {
      return json(res, 503, { status: 'draining' });
    }
    // Total relay deafness check: if it's been longer than the threshold
    // since boot AND no write-relay has acked any publish in the threshold
    // window, the SFU is silently broken — every client that needs us is
    // hitting a kind 31313 from a relay we're no longer in touch with.
    // 503 makes this visible to monitoring without forcing a restart for
    // partial degradation (one of N relays going wonky stays 200).
    const now = Math.floor(Date.now() / 1000);
    const uptime = now - this.deps.bootedAt;
    if (uptime > HEALTHZ_ALL_RELAYS_DEAD_SEC) {
      const writeRelays = this.deps.relay.getRelayHealth().filter((h) => h.role === 'write');
      const anyAlive = writeRelays.some(
        (h) => h.lastPublishOk != null && now - h.lastPublishOk < HEALTHZ_ALL_RELAYS_DEAD_SEC,
      );
      if (writeRelays.length > 0 && !anyAlive) {
        return json(res, 503, {
          status: 'degraded',
          reason: 'no live relays',
          uptime,
        });
      }
    }
    json(res, 200, {
      status: 'ok',
      uptime,
      activeRooms: this.deps.rooms.size(),
      channelRegistry: this.deps.channels.getStatus(),
      voiceChannels: this.deps.channels.listVoiceChannels().length,
    });
  }

  private handleRooms(res: ServerResponse): void {
    // Public-safe view: don't leak participant pubkey list, just count.
    const sanitized = this.deps.rooms.list().map((r) => ({
      channelId: r.channelId,
      channelKind: this.deps.channels.getChannel(r.channelId)?.kind ?? 'unknown',
      status: r.status,
      participants: r.participants.length,
      startedAt: r.startedAt,
      host: r.hostPubkey,
    }));
    json(res, 200, { rooms: sanitized });
  }

  private handleChannelResolve(req: IncomingMessage, res: ServerResponse): void {
    const params = new URL(req.url ?? '/', 'http://localhost').searchParams;
    const raw = params.get('url') ?? params.get('link') ?? params.get('channelUrl') ?? params.get('channelId') ?? params.get('c') ?? '';
    const parsed = this.parseChannelInput(raw);
    const relay = parsed.relay ?? this.normalizeRelayUrl(params.get('relay') ?? '');
    if (!parsed.channelId) {
      return json(res, 400, { error: 'url, link, channelUrl, channelId, or c must contain a hex channel id' });
    }
    const channel = this.deps.channels.getChannel(parsed.channelId);
    const voiceMode = channel?.kind === 'voice' ? 'mesh' : channel?.kind === 'voice-sfu' ? 'sfu' : 'unknown';
    json(res, 200, {
      channelId: parsed.channelId,
      relay,
      channelKind: channel?.kind ?? 'unknown',
      voiceMode,
      testPeerMode: testPeerModeForChannel(channel?.kind ?? null),
      channel,
    });
  }

  private parseChannelInput(raw: string): { channelId: string | null; relay: string | null } {
    const value = (raw ?? '').trim();
    if (!value) return { channelId: null, relay: null };
    if (/^[0-9a-f]+$/i.test(value)) return { channelId: value.toLowerCase(), relay: null };
    try {
      const parsed = new URL(value.includes('://') ? value : 'https://obelisk.ar/' + value.replace(/^\/+/, ''));
      const channelId = (parsed.searchParams.get('c') ?? parsed.searchParams.get('channelId') ?? parsed.searchParams.get('channel') ?? '').trim().toLowerCase();
      const relay = this.normalizeRelayUrl(parsed.searchParams.get('relay') ?? '');
      return { channelId: /^[0-9a-f]+$/i.test(channelId) ? channelId : null, relay };
    } catch {
      return { channelId: null, relay: null };
    }
  }

  private normalizeRelayUrl(raw: string): string | null {
    const value = (raw ?? '').trim();
    if (!value) return null;
    if (/^wss?:\/\//i.test(value)) return value.replace(/\/+$/, '');
    if (/^https?:\/\//i.test(value)) {
      try {
        const u = new URL(value);
        return 'wss://' + u.host + u.pathname.replace(/\/+$/, '');
      } catch {
        return null;
      }
    }
    return 'wss://' + value.replace(/^\/+/, '').replace(/\/+$/, '');
  }

  private handleChannels(res: ServerResponse): void {
    json(res, 200, {
      summary: this.deps.channels.getStatus(),
      channels: this.deps.channels.listVoiceChannels(),
    });
  }
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'access-control-allow-origin': '*',
  });
  res.end(payload);
}
