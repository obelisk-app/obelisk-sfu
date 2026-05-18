/**
 * Direct authenticated WebSocket RPC for mediasoup SFU channels.
 *
 * Nostr remains the identity/discovery layer, but mediasoup RPC no longer
 * has to ride ephemeral kind 25050 relay fanout. Clients authenticate with
 * a NIP-42-like kind 22242 challenge, then send the same request envelopes
 * used by the relay RPC path.
 */
import { createHash, randomBytes } from 'node:crypto';
import type { IncomingMessage, Server } from 'node:http';
import type { Socket } from 'node:net';

import { verifyEvent, type Event as NostrEvent } from 'nostr-tools';

import { isAllowedToStart } from './auth.js';
import type { Config } from './config.js';
import { createLogger } from './log.js';
import type { RpcNotification, RpcRequest } from './nostr-rpc.js';
import type { RoomLike, RoomManager } from './room-manager.js';
import type { Hex, RoomRules } from './types.js';

const log = createLogger('direct-rpc');

const AUTH_KIND = 22242;
const AUTH_MAX_AGE_SECONDS = 5 * 60;
const AUTH_TIMEOUT_MS = 15_000;

const DEFAULT_RULES: RoomRules = {
  video: true,
  screen: true,
  allow: null,
  deny: [],
  maxParticipants: null,
  endsAt: null,
};

export interface DirectRpcDeps {
  cfg: Config;
  sfuPubkey: Hex;
  rooms: RoomManager;
}

export function attachDirectRpc(server: Server, deps: DirectRpcDeps): void {
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    if (url.pathname !== '/rpc') {
      socket.destroy();
      return;
    }
    handleUpgrade(req, socket as Socket, head, url, deps);
  });
}

function handleUpgrade(
  req: IncomingMessage,
  socket: Socket,
  head: Buffer,
  url: URL,
  deps: DirectRpcDeps,
): void {
  const channelId = (url.searchParams.get('channelId') ?? '').trim().toLowerCase();
  if (!/^[0-9a-f]+$/.test(channelId)) {
    socket.destroy();
    return;
  }

  const key = req.headers['sec-websocket-key'];
  if (typeof key !== 'string' || key.length === 0) {
    socket.destroy();
    return;
  }
  const accept = createHash('sha1')
    .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
    .digest('base64');
  socket.write([
    'HTTP/1.1 101 Switching Protocols',
    'Upgrade: websocket',
    'Connection: Upgrade',
    `Sec-WebSocket-Accept: ${accept}`,
    '',
    '',
  ].join('\r\n'));

  let closing = false;
  let cleaned = false;
  let authed = false;
  let pubkey: Hex | null = null;
  let clientId: string | null = null;
  let room: RoomLike | undefined;
  let unregisterDirect: (() => void) | null = null;
  let chain = Promise.resolve();
  const challenge = randomBytes(32).toString('hex');
  const expectedUrl = directWsUrl(req);

  const closeWith = (code: number, reason: string) => {
    if (closing) return;
    closing = true;
    try { writeClose(socket, code, reason); } catch { /* ignore */ }
    socket.end();
  };

  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    clearTimeout(authTimer);
    try { unregisterDirect?.(); } catch { /* ignore */ }
    unregisterDirect = null;
    if (authed && pubkey && clientId) {
      try { room?.handleDirectDisconnect?.(pubkey, clientId); } catch { /* ignore */ }
    }
  };

  const authTimer = setTimeout(() => closeWith(4401, 'auth timeout'), AUTH_TIMEOUT_MS);
  authTimer.unref?.();

  sendJson(socket, {
    type: 'auth',
    challenge,
    kind: AUTH_KIND,
    relay: expectedUrl,
    channelId,
  });

  const parser = new FrameParser(
    (text) => {
      chain = chain.then(() => handleText(text)).catch((err) => {
        log.warn('direct rpc message failed', { err: (err as Error).message });
        closeWith(1011, 'handler error');
      });
    },
    () => closeWith(1000, 'client closed'),
    () => writePong(socket),
    () => closeWith(1003, 'unsupported frame'),
  );

  async function handleText(text: string): Promise<void> {
    let msg: unknown;
    try { msg = JSON.parse(text); }
    catch {
      closeWith(1007, 'invalid json');
      return;
    }
    if (!msg || typeof msg !== 'object') {
      closeWith(1007, 'invalid message');
      return;
    }
    const obj = msg as Record<string, unknown>;

    if (!authed) {
      if (obj.type !== 'auth') {
        closeWith(4401, 'auth required');
        return;
      }
      const authClientId = typeof obj.clientId === 'string' ? obj.clientId : '';
      if (!/^[a-zA-Z0-9._:-]{1,80}$/.test(authClientId)) {
        closeWith(4401, 'invalid client id');
        return;
      }
      const ev = obj.event as NostrEvent | undefined;
      const verifiedPubkey = verifyAuthEvent(ev, challenge, channelId, expectedUrl);
      if (!verifiedPubkey) {
        closeWith(4401, 'bad auth');
        return;
      }
      if (!isAllowedToStart(deps.cfg, deps.sfuPubkey, verifiedPubkey)) {
        closeWith(4403, 'not whitelisted');
        return;
      }

      room = deps.rooms.get(channelId);
      if (!room) {
        if (deps.rooms.isDraining()) {
          closeWith(4403, 'sfu draining');
          return;
        }
        if (deps.rooms.size() >= deps.cfg.maxRooms) {
          closeWith(4403, 'max rooms reached');
          return;
        }
        room = await deps.rooms.start(channelId, verifiedPubkey, DEFAULT_RULES);
      }
      if (!room.handleDirectRequest || !room.registerDirectSession) {
        closeWith(4400, 'direct rpc unsupported by engine');
        return;
      }
      pubkey = verifiedPubkey;
      clientId = authClientId;
      unregisterDirect = room.registerDirectSession(pubkey, clientId, (notification) => {
        sendJson(socket, notification);
      });
      authed = true;
      clearTimeout(authTimer);
      sendJson(socket, { type: 'auth_ok', pubkey, clientId });
      log.info('direct rpc authenticated', {
        pubkey: pubkey.slice(0, 8),
        channelId: channelId.slice(0, 8),
      });
      return;
    }

    if (obj.type !== 'request') {
      closeWith(1003, 'expected request');
      return;
    }
    if (!pubkey || !clientId || !room?.handleDirectRequest) {
      closeWith(1011, 'session not ready');
      return;
    }
    const reqEnvelope = { ...obj, clientId } as RpcRequest;
    const response = await room.handleDirectRequest(
      pubkey,
      clientId,
      reqEnvelope,
      async (method: string, data?: unknown) => {
        const notification: RpcNotification = data === undefined
          ? { type: 'notification', method }
          : { type: 'notification', method, data };
        sendJson(socket, notification);
      },
    );
    sendJson(socket, response);
  }

  socket.on('data', (chunk) => parser.push(chunk));
  socket.on('close', cleanup);
  socket.on('error', cleanup);
  if (head.length > 0) parser.push(head);
}

function verifyAuthEvent(
  ev: NostrEvent | undefined,
  challenge: string,
  channelId: string,
  expectedUrl: string,
): Hex | null {
  if (!ev || ev.kind !== AUTH_KIND) return null;
  if (!verifyEvent(ev)) return null;
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - ev.created_at) > AUTH_MAX_AGE_SECONDS) return null;
  const challengeTag = ev.tags.find((t) => t[0] === 'challenge')?.[1];
  if (challengeTag !== challenge) return null;
  const channelTag = ev.tags.find((t) => t[0] === 'e')?.[1];
  if (channelTag !== channelId) return null;
  const relayTag = ev.tags.find((t) => t[0] === 'relay')?.[1];
  if (!relayTag || !samePathAndSearch(relayTag, expectedUrl)) return null;
  return /^[0-9a-f]{64}$/i.test(ev.pubkey) ? ev.pubkey.toLowerCase() : null;
}

function directWsUrl(req: IncomingMessage): string {
  const host = req.headers.host ?? 'localhost';
  const protoHeader = ((req.headers['x-forwarded-proto'] as string | undefined) ?? '').toLowerCase();
  const proto = protoHeader === 'https' ? 'wss' : 'ws';
  return `${proto}://${host}${req.url ?? '/rpc'}`;
}

function samePathAndSearch(a: string, b: string): boolean {
  try {
    const ua = new URL(a);
    const ub = new URL(b);
    return ua.pathname === ub.pathname && ua.search === ub.search;
  } catch {
    return a === b;
  }
}

function sendJson(socket: Socket, value: unknown): void {
  writeFrame(socket, 0x1, Buffer.from(JSON.stringify(value), 'utf8'));
}

function writePong(socket: Socket): void {
  writeFrame(socket, 0xA, Buffer.alloc(0));
}

function writeClose(socket: Socket, code: number, reason: string): void {
  const reasonBytes = Buffer.from(reason, 'utf8');
  const payload = Buffer.alloc(2 + reasonBytes.length);
  payload.writeUInt16BE(code, 0);
  reasonBytes.copy(payload, 2);
  writeFrame(socket, 0x8, payload);
}

function writeFrame(socket: Socket, opcode: number, payload: Buffer): void {
  const header: number[] = [0x80 | opcode];
  if (payload.length < 126) {
    header.push(payload.length);
  } else if (payload.length <= 0xffff) {
    header.push(126, (payload.length >> 8) & 0xff, payload.length & 0xff);
  } else {
    header.push(127, 0, 0, 0, 0);
    const len = payload.length;
    header.push((len >>> 24) & 0xff, (len >>> 16) & 0xff, (len >>> 8) & 0xff, len & 0xff);
  }
  socket.write(Buffer.concat([Buffer.from(header), payload]));
}

class FrameParser {
  private buffer = Buffer.alloc(0);

  constructor(
    private readonly onText: (text: string) => void,
    private readonly onClose: () => void,
    private readonly onPing: () => void,
    private readonly onUnsupported: () => void,
  ) {}

  push(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (this.buffer.length >= 2) {
      const b0 = this.buffer[0]!;
      const b1 = this.buffer[1]!;
      const fin = (b0 & 0x80) !== 0;
      const opcode = b0 & 0x0f;
      const masked = (b1 & 0x80) !== 0;
      let len = b1 & 0x7f;
      let offset = 2;
      if (len === 126) {
        if (this.buffer.length < offset + 2) return;
        len = this.buffer.readUInt16BE(offset);
        offset += 2;
      } else if (len === 127) {
        if (this.buffer.length < offset + 8) return;
        const high = this.buffer.readUInt32BE(offset);
        const low = this.buffer.readUInt32BE(offset + 4);
        if (high !== 0) {
          this.onUnsupported();
          return;
        }
        len = low;
        offset += 8;
      }
      if (!masked || !fin) {
        this.onUnsupported();
        return;
      }
      if (this.buffer.length < offset + 4 + len) return;
      const mask = this.buffer.subarray(offset, offset + 4);
      offset += 4;
      const payload = Buffer.from(this.buffer.subarray(offset, offset + len));
      this.buffer = this.buffer.subarray(offset + len);
      for (let i = 0; i < payload.length; i++) payload[i] = payload[i]! ^ mask[i % 4]!;
      if (opcode === 0x1) {
        this.onText(payload.toString('utf8'));
      } else if (opcode === 0x8) {
        this.onClose();
        return;
      } else if (opcode === 0x9) {
        this.onPing();
      } else {
        this.onUnsupported();
        return;
      }
    }
  }
}
