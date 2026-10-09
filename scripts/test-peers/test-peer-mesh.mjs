#!/usr/bin/env node
/**
 * Mesh test peer - joins a regular voice channel as a synthetic participant.
 *
 * This is the browser mesh path, not the SFU path: it discovers participants
 * through kind 20078 beacons, exchanges kind 25050 SDP/ICE directly with each
 * peer, and streams the same ffmpeg test pattern + 440 Hz tone used by the
 * SFU media smoke tests through werift MediaStreamTracks.
 *
 * Usage:
 *   node scripts/test-peers/test-peer-mesh.mjs <channel-id-hex>
 *
 * Env:
 *   TEST_PEER_NSEC_HEX          64-char hex private key. If set, do not persist.
 *   TEST_PEER_RELAYS            comma-separated relay URLs.
 *   TEST_PEER_TURN_URLS         comma-separated TURN URLs.
 *   TEST_PEER_TURN_USERNAME     TURN username.
 *   TEST_PEER_TURN_CREDENTIAL   TURN credential.
 *   TEST_PEER_FORCE_RELAY       1 = TURN-only ICE, 0 = all ICE candidates. Default: 0.
 *   TEST_PEER_PUBLIC_IP         public host ICE address. Falls back to SFU_PUBLIC_IP.
 *   TEST_PEER_RTP_PORT_MIN      ICE port range min. Falls back to SFU_RTP_PORT_MIN.
 *   TEST_PEER_RTP_PORT_MAX      ICE port range max. Falls back to SFU_RTP_PORT_MAX.
 *   TEST_PEER_MAX_LIFETIME_SEC  hard self-exit cap, default 1800.
 */

import { spawn } from 'node:child_process';
import { createSocket } from 'node:dgram';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import 'dotenv/config';
import { SimplePool, finalizeEvent, getPublicKey, nip19 } from 'nostr-tools';
import { publishWithAuth, subscribeResilient } from './relay-auth.mjs';
import { generateSecretKey } from 'nostr-tools/pure';
import {
  RTCPeerConnection,
  MediaStreamTrack,
  RtpPacket,
} from 'werift';
import { bindSession, normalizeMeshSignal, parsePresenceBeacon, supersedes } from './mesh-signal.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const stateDir = path.join(__dirname, '..', '.test-peer-mesh');

function normalizeRelayUrl(raw) {
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

function parseChannelArg(raw) {
  const value = (raw ?? '').trim();
  if (!value) return { channelId: null, relay: null };
  if (/^[0-9a-f]+$/i.test(value)) return { channelId: value.toLowerCase(), relay: null };
  try {
    const parsed = new URL(value.includes('://') ? value : 'https://obelisk.ar/' + value.replace(/^\/+/, ''));
    const channelId = (parsed.searchParams.get('c') ?? parsed.searchParams.get('channelId') ?? parsed.searchParams.get('channel') ?? '').trim().toLowerCase();
    const relay = normalizeRelayUrl(parsed.searchParams.get('relay') ?? '');
    return { channelId: /^[0-9a-f]+$/i.test(channelId) ? channelId : null, relay };
  } catch {
    return { channelId: null, relay: null };
  }
}

const parsedChannelArg = parseChannelArg(process.argv[2]);
const CHANNEL_ID = parsedChannelArg.channelId;
if (!CHANNEL_ID) {
  console.error('usage: node test-peer-mesh.mjs <channel-id-hex-or-obelisk-app-url>');
  process.exit(1);
}
const DEFAULT_RELAY = parsedChannelArg.relay ?? 'wss://public.obelisk.ar';

const RELAYS = (process.env.TEST_PEER_RELAYS ?? DEFAULT_RELAY)
  .split(',').map((s) => s.trim()).filter(Boolean);
const TURN_URLS = (process.env.TEST_PEER_TURN_URLS ?? process.env.SFU_TURN_URLS ?? '')
  .split(',').map((s) => s.trim()).filter(Boolean);
const TURN_USERNAME = process.env.TEST_PEER_TURN_USERNAME ?? process.env.SFU_TURN_USERNAME ?? '';
const TURN_CREDENTIAL = process.env.TEST_PEER_TURN_CREDENTIAL ?? process.env.SFU_TURN_CREDENTIAL ?? '';
const FORCE_RELAY = (process.env.TEST_PEER_FORCE_RELAY ?? '0') === '1';
const ICE_PUBLIC_IP = (process.env.TEST_PEER_PUBLIC_IP ?? process.env.SFU_PUBLIC_IP ?? '').trim();
const ICE_PORT_MIN = parseOptionalPort(process.env.TEST_PEER_RTP_PORT_MIN ?? process.env.SFU_RTP_PORT_MIN);
const ICE_PORT_MAX = parseOptionalPort(process.env.TEST_PEER_RTP_PORT_MAX ?? process.env.SFU_RTP_PORT_MAX);
const ICE_PORT_RANGE = ICE_PORT_MIN !== null && ICE_PORT_MAX !== null && ICE_PORT_MAX > ICE_PORT_MIN
  ? [ICE_PORT_MIN, ICE_PORT_MAX]
  : null;
const MAX_LIFETIME_SEC = Math.max(60, Number(process.env.TEST_PEER_MAX_LIFETIME_SEC) || 1800);
const PUBLISH_PROFILE = (process.env.TEST_PEER_PUBLISH_PROFILE ?? '1') !== '0';
// Mirrors obelisk-dex `src/constants/voice/*` and docs/features/voice/mesh-protocol.md.
const PRESENCE_TTL_SECONDS = 150;
const PRESENCE_SWEEP_MS = 10_000;
const LEAVE_EXPIRATION_SECONDS = 10;
const BEACON_INTERVAL_MS = 10_000;
const BEACON_BRINGUP_DELAYS_MS = [300, 900, 1800, 3500, 7000, 12000, 18000];
const BEACON_DEBOUNCE_MS = 250;
const CONTROL_CHANNEL_LABEL = 'obelisk-control';
const CONTROL_PING_INTERVAL_MS = 2_500;
const CONTROL_PEER_SNAPSHOT_INTERVAL_MS = 5_000;
const DEAD_PEER_TIMEOUT_MS = 20_000;

function parseOptionalPort(raw) {
  const value = (raw ?? '').trim();
  if (!value) return null;
  const port = Number(value);
  return Number.isInteger(port) && port > 0 && port <= 65535 ? port : null;
}


if (RELAYS.length === 0 || RELAYS.some((r) => !/^wss?:\/\//.test(r))) {
  console.error('[mesh] TEST_PEER_RELAYS must contain ws:// or wss:// URLs');
  process.exit(1);
}

// Identity resolution order mirrors test-peer-ms.mjs so the admin spawner can
// fork many peers with unique ephemeral pubkeys while manual runs stay stable.
let secretKey;
let pubkey;
const envNsec = (process.env.TEST_PEER_NSEC_HEX ?? '').trim();
if (envNsec && /^[0-9a-f]{64}$/i.test(envNsec)) {
  secretKey = Uint8Array.from(Buffer.from(envNsec, 'hex'));
  pubkey = getPublicKey(secretKey);
  console.log('[mesh] using TEST_PEER_NSEC_HEX (ephemeral, not persisted)');
} else {
  mkdirSync(stateDir, { recursive: true });
  const keyPath = path.join(stateDir, 'identity.json');
  if (existsSync(keyPath)) {
    const raw = JSON.parse(readFileSync(keyPath, 'utf8'));
    secretKey = Uint8Array.from(Buffer.from(raw.skHex, 'hex'));
    pubkey = raw.pubkey;
  } else {
    secretKey = generateSecretKey();
    pubkey = getPublicKey(secretKey);
    writeFileSync(keyPath, JSON.stringify({
      skHex: Buffer.from(secretKey).toString('hex'),
      pubkey,
      npub: nip19.npubEncode(pubkey),
    }, null, 2));
  }
}

console.log('[mesh] pubkey=', pubkey);
console.log('[mesh] npub=', nip19.npubEncode(pubkey));
console.log('[mesh] channel=', CHANNEL_ID);
console.log('[mesh] relays=', RELAYS.join(','));
console.log('[mesh] icePolicy=', FORCE_RELAY ? 'relay' : 'all');
if (!FORCE_RELAY && ICE_PUBLIC_IP) console.log('[mesh] publicIce=', ICE_PUBLIC_IP);
if (ICE_PORT_RANGE) {
  console.log('[mesh] icePortRange=', ICE_PORT_RANGE[0] + '-' + ICE_PORT_RANGE[1]);
}
console.log('[mesh] max lifetime', MAX_LIFETIME_SEC, 's');

const signAuth = (template) => Promise.resolve(finalizeEvent(template, secretKey));
const pool = new SimplePool({ automaticallyAuth: () => signAuth });

async function publish(template, label = 'event') {
  const ev = finalizeEvent({
    ...template,
    created_at: template.created_at ?? Math.floor(Date.now() / 1000),
  }, secretKey);
  const results = await publishWithAuth(pool, RELAYS, ev, signAuth);
  const rejected = results
    .map((r, i) => r.status === 'rejected' ? RELAYS[i] + ': ' + (r.reason?.message ?? r.reason) : null)
    .filter(Boolean);
  if (rejected.length > 0) {
    console.warn('[mesh] publish', label, 'had rejections:', rejected.join('; '));
  }
  return ev;
}

if (PUBLISH_PROFILE) {
  console.log('[mesh] publishing kind 0 profile...');
  await publish({
    kind: 0,
    content: JSON.stringify({
      name: 'Mesh Test Peer',
      display_name: 'Mesh Test Peer',
      about: 'Synthetic ffmpeg mesh peer (testsrc2 + 440 Hz sine) used to smoke-test Obelisk P2P voice channels.',
      picture: 'https://upload.wikimedia.org/wikipedia/commons/thumb/0/04/SMPTE_Color_Bars.svg/320px-SMPTE_Color_Bars.svg.png',
      bot: true,
    }),
    tags: [],
  }, 'profile');
} else {
  console.log('[mesh] skipping kind 0 profile publish');
}

function createRtpSink(track, label) {
  return new Promise((resolve, reject) => {
    let pktCount = 0;
    let lastLog = Date.now();
    const sock = createSocket('udp4');
    sock.on('error', reject);
    sock.on('message', (buf) => {
      try {
        const pkt = RtpPacket.deSerialize(buf);
        track.writeRtp(pkt);
        pktCount++;
        const now = Date.now();
        if (now - lastLog > 8000) {
          console.log('[mesh]', label, 'RTP forwarded', pktCount, 'packets');
          lastLog = now;
        }
      } catch {
        // Ignore RTCP / malformed packets.
      }
    });
    sock.bind(0, '127.0.0.1', () => {
      sock.off('error', reject);
      const address = sock.address();
      if (typeof address === 'string') return reject(new Error('unexpected unix socket address'));
      console.log('[mesh]', label, 'RTP sink listening on 127.0.0.1:' + address.port);
      resolve({ sock, port: address.port, getPacketCount: () => pktCount });
    });
  });
}

const sharedVideoTrack = new MediaStreamTrack({ kind: 'video' });
const sharedAudioTrack = new MediaStreamTrack({ kind: 'audio' });
const videoSink = await createRtpSink(sharedVideoTrack, 'video');
const audioSink = await createRtpSink(sharedAudioTrack, 'audio');

const videoArgs = [
  '-loglevel', 'warning', '-re',
  '-f', 'lavfi', '-i', 'testsrc2=size=640x480:rate=15',
  '-c:v', 'libvpx', '-b:v', '500k', '-deadline', 'realtime', '-cpu-used', '4',
  '-g', '15', '-keyint_min', '15',
  '-payload_type', '96', '-ssrc', '1',
  '-f', 'rtp', 'rtp://127.0.0.1:' + videoSink.port + '?pkt_size=1200',
];
const audioArgs = [
  '-loglevel', 'warning', '-re',
  '-f', 'lavfi', '-i', 'sine=frequency=440:beep_factor=4',
  '-c:a', 'libopus', '-b:a', '32k',
  '-payload_type', '111', '-ssrc', '2',
  '-f', 'rtp', 'rtp://127.0.0.1:' + audioSink.port + '?pkt_size=1200',
];

console.log('[mesh] spawning ffmpeg (video)...');
const ffv = spawn('ffmpeg', videoArgs, { stdio: ['ignore', 'inherit', 'inherit'] });
console.log('[mesh] spawning ffmpeg (audio)...');
const ffa = spawn('ffmpeg', audioArgs, { stdio: ['ignore', 'inherit', 'inherit'] });
ffv.on('exit', (code) => console.log('[mesh] ffmpeg video exited', code));
ffa.on('exit', (code) => console.log('[mesh] ffmpeg audio exited', code));

const ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun.cloudflare.com:3478' },
  ...TURN_URLS.map((url) => ({ urls: url, username: TURN_USERNAME, credential: TURN_CREDENTIAL })),
];

// Read by callbacks that can fire before the startup code below finishes.
let shuttingDown = false;

const peers = new Map();
const connectedPubkeys = new Set();
const rosterLatest = new Map();
const seenSignalIds = new Set();
const SEEN_SIGNAL_IDS_MAX = 2048;

/**
 * First-hand peers only: our own PCs and publishers of live beacons we
 * received. Second-hand claims are never re-advertised (they kept departed
 * pubkeys alive between clients).
 */
function knownPubkeys() {
  const out = new Set();
  for (const pk of connectedPubkeys) out.add(pk);
  for (const pk of rosterLatest.keys()) out.add(pk);
  for (const pk of peers.keys()) out.add(pk);
  out.delete(pubkey);
  return Array.from(out).sort();
}

function isCurrent(state) {
  return peers.get(state.remotePubkey) === state;
}

function sendControl(state, msg) {
  const dc = state.controlChannel;
  if (!dc || dc.readyState !== 'open') return false;
  try { dc.send(JSON.stringify(msg)); return true; }
  catch (err) { console.warn('[mesh] control send failed', state.remotePubkey.slice(0, 8), err.message); return false; }
}

function sendControlSnapshot(state) {
  sendControl(state, { type: 'peerSnapshot', peers: knownPubkeys(), ts: Date.now() });
}

function broadcastControl(msg, except) {
  for (const state of peers.values()) if (state !== except) sendControl(state, msg);
}

function closeControl(state) {
  if (state.controlPingTimer) { clearInterval(state.controlPingTimer); state.controlPingTimer = null; }
  if (state.controlSnapshotTimer) { clearInterval(state.controlSnapshotTimer); state.controlSnapshotTimer = null; }
  if (state.deadTimer) { clearTimeout(state.deadTimer); state.deadTimer = null; }
  const dc = state.controlChannel;
  state.controlChannel = null;
  if (dc && dc.readyState === 'open') {
    try { dc.close(); } catch { /* ignore */ }
  }
}

/**
 * Close one connection. Idempotent, and a no-op on the map when `state` has
 * already been replaced, so callbacks from a torn-down PC cannot touch the
 * one that replaced it.
 */
function tearDown(state, reason) {
  if (state.closed) return;
  state.closed = true;
  console.log('[mesh] tear down', state.remotePubkey.slice(0, 8), reason);
  closeControl(state);
  try { state.pc.close(); } catch { /* ignore */ }
  if (!isCurrent(state)) return;
  peers.delete(state.remotePubkey);
  if (connectedPubkeys.delete(state.remotePubkey)) {
    broadcastControl({ type: 'peerRemoved', pubkey: state.remotePubkey });
  }
  scheduleBeacon();
}

function armDeadTimer(state) {
  if (state.deadTimer) clearTimeout(state.deadTimer);
  state.deadTimer = setTimeout(() => {
    state.deadTimer = null;
    tearDown(state, 'heartbeat-lost');
  }, DEAD_PEER_TIMEOUT_MS);
  state.deadTimer.unref?.();
}

function handleControlMessage(state, raw) {
  if (state.closed) return;
  let msg;
  try {
    const data = Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw ?? '');
    msg = JSON.parse(data);
  } catch {
    return;
  }
  if (!msg || typeof msg.type !== 'string') return;
  armDeadTimer(state);
  if (msg.type === 'hello' || msg.type === 'peerSnapshot') {
    if (msg.type === 'hello') state.remoteSignals = msg.signalTransport === 1;
    const hinted = Array.isArray(msg.peers) ? msg.peers : [];
    for (const pk of hinted) createPeer(pk);
  } else if (msg.type === 'signal' && msg.payload && typeof msg.payload.type === 'string') {
    if (state.remoteSignals) void handleSignal(state.remotePubkey, msg.payload);
  } else if (msg.type === 'peerAdded' && typeof msg.pubkey === 'string') {
    createPeer(msg.pubkey);
  } else if (msg.type === 'peerRemoved' && typeof msg.pubkey === 'string') {
    // Do not tear down a direct PC from a third-party removal. The browser
    // side uses full snapshots to decide staleness; the test peer keeps the
    // direct connection if it already exists.
  } else if (msg.type === 'ping') {
    sendControl(state, { type: 'pong', ts: Date.now(), echoTs: msg.ts ?? Date.now() });
  } else if (msg.type === 'bye') {
    tearDown(state, 'control bye: ' + (msg.reason ?? 'remote-bye'));
  }
}

function attachControlChannel(state, dc) {
  if (!dc || dc.label !== CONTROL_CHANNEL_LABEL) return;
  if (state.controlChannel || state.closed) return;
  state.controlChannel = dc;
  dc.onopen = () => {
    if (state.closed) return;
    console.log('[mesh] control open to', state.remotePubkey.slice(0, 8));
    sendControl(state, {
      type: 'hello',
      peers: knownPubkeys(),
      sessionId: state.sessionId,
      build: 'obelisk-mesh-test-peer',
      signalTransport: 1,
    });
    armDeadTimer(state);
    state.controlPingTimer = setInterval(() => {
      sendControl(state, { type: 'ping', ts: Date.now() });
    }, CONTROL_PING_INTERVAL_MS);
    state.controlSnapshotTimer = setInterval(() => {
      sendControlSnapshot(state);
    }, CONTROL_PEER_SNAPSHOT_INTERVAL_MS);
    state.controlPingTimer.unref?.();
    state.controlSnapshotTimer.unref?.();
  };
  dc.onmessage = (ev) => handleControlMessage(state, ev.data);
  dc.onclose = () => {
    console.log('[mesh] control closed to', state.remotePubkey.slice(0, 8));
    closeControl(state);
  };
  dc.onerror = (ev) => console.warn('[mesh] control error to', state.remotePubkey.slice(0, 8), ev?.error?.message ?? ev?.message ?? 'error');
  if (dc.readyState === 'open') dc.onopen?.();
}

/**
 * Send one signal to the peer of `state`. Stamped with our session, the
 * remote session it answers, and a sequence number. Rides the data channel
 * once it is open and the remote advertised `signalTransport: 1`, as the
 * browser does; otherwise (initial SDP, legacy peers) a signed kind 25050.
 */
async function sendSignal(state, payload, { relayOnly = false } = {}) {
  const signal = {
    ...payload,
    sessionId: state.sessionId,
    ...(state.remoteSessionId ? { targetSessionId: state.remoteSessionId } : {}),
    seq: ++state.outboundSeq,
  };
  if (!relayOnly && state.connected && state.remoteSignals
    && sendControl(state, { type: 'signal', payload: signal })) {
    return;
  }
  await publish({
    kind: 25050,
    content: JSON.stringify(signal),
    tags: [
      ['p', state.remotePubkey],
      ['e', CHANNEL_ID],
      ['t', 'obelisk-voice-signal'],
    ],
  }, 'signal ' + signal.type);
}

async function makeOffer(state, reason) {
  const { pc, remotePubkey } = state;
  if (state.closed || state.makingOffer || pc.signalingState !== 'stable') return;
  try {
    state.makingOffer = true;
    await pc.setLocalDescription();
    if (!pc.localDescription || state.closed) return;
    console.log('[mesh] -> offer to', remotePubkey.slice(0, 8), 'reason=', reason, 'sdp=', pc.localDescription.sdp.length);
    await sendSignal(state, { type: 'peer', peerSignal: { type: 'offer', sdp: pc.localDescription.sdp } });
  } catch (err) {
    console.warn('[mesh] makeOffer threw', err.message);
  } finally {
    state.makingOffer = false;
  }
}

function createPeer(remotePubkey) {
  if (shuttingDown || !remotePubkey || remotePubkey === pubkey) return null;
  if (!/^[0-9a-f]{64}$/.test(remotePubkey)) return null;
  const existing = peers.get(remotePubkey);
  if (existing) return existing;

  // Browsers always take the initiator role toward a marked mesh test peer
  // (`mesh-peer.ts`), so we answer. Between two test peers the browsers'
  // lexicographic rule applies: the smaller pubkey initiates.
  const remoteIsMeshTestPeer = rosterLatest.get(remotePubkey)?.isMeshTestPeer === true;
  const polite = remoteIsMeshTestPeer ? pubkey > remotePubkey : true;
  console.log('[mesh] open PC to', remotePubkey.slice(0, 8), 'polite=', polite,
    remoteIsMeshTestPeer ? '(mesh-test-peer)' : '(browser-driven)');

  const pc = new RTCPeerConnection({
    iceServers: ICE_SERVERS,
    bundlePolicy: 'max-bundle',
    iceTransportPolicy: FORCE_RELAY ? 'relay' : 'all',
    iceUseIpv6: false,
    ...(ICE_PORT_RANGE ? { icePortRange: ICE_PORT_RANGE } : {}),
    ...(ICE_PUBLIC_IP && !FORCE_RELAY ? { iceAdditionalHostAddresses: [ICE_PUBLIC_IP] } : {}),
  });
  const state = {
    pc,
    remotePubkey,
    polite,
    makingOffer: false,
    sessionId: randomUUID().slice(0, 8),
    remoteSessionId: null,
    remoteSignals: false,
    connected: false,
    closed: false,
    outboundSeq: 0,
    signalQueue: Promise.resolve(),
    tx: [],
    controlChannel: null,
    controlPingTimer: null,
    controlSnapshotTimer: null,
    deadTimer: null,
  };
  peers.set(remotePubkey, state);

  if (!polite) {
    try { attachControlChannel(state, pc.createDataChannel(CONTROL_CHANNEL_LABEL, { ordered: true })); }
    catch (err) { console.warn('[mesh] create control channel failed', err.message); }
  }
  pc.ondatachannel = (ev) => attachControlChannel(state, ev.channel);
  pc.onDataChannel?.subscribe?.((channel) => attachControlChannel(state, channel));

  const videoTx = pc.addTransceiver('video', { direction: 'sendonly' });
  state.tx.push({ label: 'video', sender: videoTx.sender });
  void videoTx.sender.replaceTrack(sharedVideoTrack).catch((err) => console.warn('[mesh] replace video track failed', err.message));

  const audioTx = pc.addTransceiver('audio', { direction: 'sendonly' });
  state.tx.push({ label: 'audio', sender: audioTx.sender });
  void audioTx.sender.replaceTrack(sharedAudioTrack).catch((err) => console.warn('[mesh] replace audio track failed', err.message));

  pc.onnegotiationneeded = () => {
    if (state.polite) {
      console.log('[mesh] skip local offer to', remotePubkey.slice(0, 8), 'reason=polite-negotiationneeded');
      return;
    }
    void makeOffer(state, 'negotiationneeded');
  };
  if (!polite) {
    setTimeout(() => { void makeOffer(state, 'initial'); }, 100);
  }

  pc.onIceCandidate.subscribe(async (candidate) => {
    if (!candidate || state.closed) return;
    await sendSignal(state, { type: 'peer', peerSignal: { type: 'candidate', candidate: candidate.toJSON() } });
  });

  pc.connectionStateChange.subscribe((s) => {
    console.log('[mesh] PC ->', remotePubkey.slice(0, 8), 'connectionState=', s);
    if (state.closed || !isCurrent(state)) return;
    if (s === 'connected') {
      state.connected = true;
      if (!connectedPubkeys.has(remotePubkey)) {
        connectedPubkeys.add(remotePubkey);
        broadcastControl({ type: 'peerAdded', pubkey: remotePubkey }, state);
      }
      for (const other of peers.values()) sendControlSnapshot(other);
      scheduleBeacon();
    }
    if (s === 'disconnected') {
      state.connected = false;
      if (connectedPubkeys.delete(remotePubkey)) {
        broadcastControl({ type: 'peerRemoved', pubkey: remotePubkey }, state);
        scheduleBeacon();
      }
    }
    if (s === 'closed' || s === 'failed') tearDown(state, 'pc ' + s);
  });
  pc.iceConnectionStateChange.subscribe((s) => {
    console.log('[mesh] PC ->', remotePubkey.slice(0, 8), 'iceConnectionState=', s);
  });

  setTimeout(async () => {
    if (state.closed) return;
    await sendSignal(state, { type: 'trackinfo', trackInfo: { trackId: sharedVideoTrack.uuid, kind: 'camera' } });
    await sendSignal(state, { type: 'trackinfo', trackInfo: { trackId: sharedAudioTrack.uuid, kind: 'audio' } });
  }, 50);

  return state;
}

async function handleSignal(fromPubkey, rawPayload) {
  if (shuttingDown) return;
  let state = peers.get(fromPubkey);
  // A bye or reset for a connection we no longer hold has nothing to close.
  if (!state && (rawPayload?.type === 'bye' || rawPayload?.type === 'requestReset')) return;
  state = state ?? createPeer(fromPubkey);
  if (!state) return;
  const previousSignal = state.signalQueue;
  let releaseSignal = () => {};
  state.signalQueue = new Promise((resolve) => { releaseSignal = resolve; });
  await previousSignal;
  try {
    if (state.closed) {
      // Closed while this signal waited its turn: hand it to the PC that
      // replaced it, or let a fresh offer open one.
      const next = peers.get(fromPubkey);
      if (next ? next !== state : normalizeMeshSignal(rawPayload)?.type === 'offer') {
        await handleSignal(fromPubkey, rawPayload);
      }
      return;
    }
    const verdict = bindSession(state, rawPayload);
    if (verdict === 'drop') {
      console.log('[mesh] drop', rawPayload.type, 'from stale session of', fromPubkey.slice(0, 8));
      return;
    }
    if (verdict === 'replace') {
      // An offer under a new session: the remote rebuilt its side.
      tearDown(state, 'remote session changed');
      await handleSignal(fromPubkey, rawPayload);
      return;
    }
    const payload = normalizeMeshSignal(rawPayload);
    if (!payload) return;
    const { pc } = state;

    if (payload.type === 'offer' && payload.sdp) {
      const offerCollision = state.makingOffer || pc.signalingState !== 'stable';
      if (offerCollision && !state.polite) {
        console.log('[mesh] drop colliding offer from', fromPubkey.slice(0, 8), 'state=', pc.signalingState);
        return;
      }
      if (offerCollision && pc.signalingState === 'have-local-offer') {
        tearDown(state, 'offer glare (polite)');
        await handleSignal(fromPubkey, rawPayload);
        return;
      }
      await pc.setRemoteDescription({ type: 'offer', sdp: payload.sdp });
      const answer = await pc.createAnswer();
      console.log('[mesh] -> answer to', fromPubkey.slice(0, 8), 'sdp=', answer.sdp.length);
      await sendSignal(state, { type: 'peer', peerSignal: { type: 'answer', sdp: answer.sdp } });
      await pc.setLocalDescription(answer);
    } else if (payload.type === 'answer' && payload.sdp) {
      if (pc.signalingState === 'have-local-offer') {
        await pc.setRemoteDescription({ type: 'answer', sdp: payload.sdp });
        console.log('[mesh] applied answer from', fromPubkey.slice(0, 8));
      } else {
        console.log('[mesh] drop answer from', fromPubkey.slice(0, 8), 'state=', pc.signalingState);
      }
    } else if (payload.type === 'ice' && Array.isArray(payload.candidates)) {
      for (const c of payload.candidates) {
        try { await pc.addIceCandidate(c); }
        catch (err) { console.warn('[mesh] addIceCandidate failed', err.message); }
      }
    } else if (payload.type === 'bye') {
      tearDown(state, 'relay bye: ' + (payload.byeReason ?? 'remote-bye'));
    } else if (payload.type === 'requestReset') {
      // The remote already rebuilt its side. A browser (always the
      // initiator toward us) follows with a fresh offer; between test
      // peers the initiator re-dials.
      tearDown(state, 'requestReset');
      if (!state.polite) createPeer(fromPubkey);
    }
  } catch (err) {
    console.warn('[mesh] handleSignal threw', err.message);
  } finally {
    releaseSignal();
  }
}

function pruneRoster() {
  const now = Math.floor(Date.now() / 1000);
  for (const [pk, entry] of Array.from(rosterLatest.entries())) {
    if (entry.expiresAt > now) continue;
    rosterLatest.delete(pk);
    const peer = peers.get(pk);
    if (peer && !connectedPubkeys.has(pk)) tearDown(peer, 'presence expired');
  }
}

function upsertRosterBeacon(ev) {
  if (ev.pubkey === pubkey) return;
  const beacon = parsePresenceBeacon(ev, { channelId: CHANNEL_ID, ttlSeconds: PRESENCE_TTL_SECONDS });
  if (!beacon || beacon.isSfu) return;
  if (!supersedes(rosterLatest.get(ev.pubkey), beacon)) return;
  if (beacon.terminal) {
    // A leave beacon removes the publisher now, not after the old lease.
    const known = rosterLatest.delete(ev.pubkey);
    const peer = peers.get(ev.pubkey);
    if (peer) tearDown(peer, 'presence left');
    if (known || peer) scheduleBeacon();
    return;
  }
  const isNew = !rosterLatest.has(ev.pubkey);
  rosterLatest.set(ev.pubkey, beacon);
  console.log('[mesh] roster sees', ev.pubkey.slice(0, 8), beacon.connectedTo.length ? 'connected=' + beacon.connectedTo.length : '');
  createPeer(ev.pubkey);
  for (const pk of beacon.connectedTo) if (pk !== pubkey) createPeer(pk);
  if (isNew) scheduleBeacon();
  for (const state of peers.values()) sendControlSnapshot(state);
}

// Indexed filters (`#p` / `#e`): the relays ration tag-less "scrape" REQs
// and close them when over budget — voice subscriptions must be targeted.
const signalSub = subscribeResilient(pool, RELAYS, { kinds: [25050], '#p': [pubkey] }, {
  label: 'signals',
  signer: signAuth,
  sinceWindow: 60,
  onevent: async (ev) => {
    if (seenSignalIds.has(ev.id)) return;
    seenSignalIds.add(ev.id);
    if (seenSignalIds.size > SEEN_SIGNAL_IDS_MAX) seenSignalIds.delete(seenSignalIds.values().next().value);
    if (ev.pubkey === pubkey) return;
    if (!ev.tags.some((t) => t[0] === 'e' && t[1] === CHANNEL_ID)) return;
    const targeted = ev.tags.some((t) => t[0] === 'p' && t[1] === pubkey);
    if (!targeted) return;
    let payload;
    try { payload = JSON.parse(ev.content); } catch { return; }
    if (!payload || typeof payload.type !== 'string') return;
    console.log('[mesh] <-', payload.type, 'from', ev.pubkey.slice(0, 8), 'seq=', payload.seq ?? '-');
    await handleSignal(ev.pubkey, payload);
  },
});

const rosterSub = subscribeResilient(pool, RELAYS, { kinds: [20078], '#e': [CHANNEL_ID] }, {
  label: 'roster',
  signer: signAuth,
  sinceWindow: PRESENCE_TTL_SECONDS,
  onevent: upsertRosterBeacon,
});

async function publishBeacon() {
  if (shuttingDown) return;
  const tags = [
    ['e', CHANNEL_ID],
    ['t', 'obelisk-voice-presence'],
    ['client', 'obelisk-mesh-test-peer'],
    ['test-peer', 'mesh'],
    ['expiration', String(Math.floor(Date.now() / 1000) + PRESENCE_TTL_SECONDS)],
    ['v', 'camera'],
  ];
  for (const pk of Array.from(connectedPubkeys).sort()) tags.push(['p', pk]);
  for (const pk of knownPubkeys()) tags.push(['peer', pk]);
  await publish({ kind: 20078, content: '', tags }, 'beacon');
  console.log('[mesh] beacon published connected=', connectedPubkeys.size, 'known=', knownPubkeys().length);
}

let beaconDebounce = null;
function scheduleBeacon() {
  if (shuttingDown || beaconDebounce) return;
  beaconDebounce = setTimeout(() => {
    beaconDebounce = null;
    void publishBeacon().catch(() => undefined);
  }, BEACON_DEBOUNCE_MS);
}

await publishBeacon();
// Bring-up burst: an ephemeral beacon lost while the room's subscriptions
// were still opening would otherwise cost a full steady-state tick.
const bringupTimers = BEACON_BRINGUP_DELAYS_MS.map((ms) => setTimeout(() => { void publishBeacon().catch(() => undefined); }, ms));
const beaconTimer = setInterval(() => { void publishBeacon().catch(() => undefined); }, BEACON_INTERVAL_MS);
const pruneTimer = setInterval(pruneRoster, PRESENCE_SWEEP_MS);

const startedAt = Date.now();
const statsTimer = setInterval(() => {
  const uptime = Math.floor((Date.now() - startedAt) / 1000);
  const peerStats = Array.from(peers.values()).map((p) => {
    const senders = p.tx.map((tx) => tx.label + ':pkts=' + (tx.sender.packetCount ?? 0) + ',bytes=' + (tx.sender.octetCount ?? 0)).join(' ');
    return p.remotePubkey.slice(0, 8) + '(' + p.pc.connectionState + ' ' + senders + ')';
  });
  console.log('[mesh] status uptime=', uptime, 's peers=', peers.size, 'connected=', connectedPubkeys.size, 'rtp=', videoSink.getPacketCount() + '/' + audioSink.getPacketCount(), peerStats.join(' | ') || '-');
  if (uptime >= MAX_LIFETIME_SEC) {
    console.log('[mesh] reached max lifetime', MAX_LIFETIME_SEC, 's - exiting');
    void cleanup();
  }
}, 30_000);

async function publishLeave() {
  await publish({
    kind: 20078,
    content: '',
    tags: [
      ['e', CHANNEL_ID],
      ['t', 'obelisk-voice-presence'],
      ['status', 'left'],
      // In the future, not the past: a NIP-40 relay drops an already
      // expired event before delivering it.
      ['expiration', String(Math.floor(Date.now() / 1000) + LEAVE_EXPIRATION_SECONDS)],
    ],
  }, 'leave');
}

async function cleanup() {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log('[mesh] shutting down');
  bringupTimers.forEach(clearTimeout);
  if (beaconDebounce) clearTimeout(beaconDebounce);
  clearInterval(beaconTimer);
  clearInterval(pruneTimer);
  clearInterval(statsTimer);
  const peerByes = Array.from(peers.values()).map((state) => {
    const viaControl = sendControl(state, { type: 'bye', reason: 'local-leave' });
    return viaControl ? null : sendSignal(state, { type: 'bye', byeReason: 'local-leave' }, { relayOnly: true });
  });
  // Bounded: a relay that never answers must not hold the process open.
  await Promise.race([
    Promise.allSettled([publishLeave(), ...peerByes]),
    new Promise((resolve) => setTimeout(resolve, 3000)),
  ]);
  try { ffv.kill('SIGTERM'); } catch { /* ignore */ }
  try { ffa.kill('SIGTERM'); } catch { /* ignore */ }
  try { videoSink.sock.close(); } catch { /* ignore */ }
  try { audioSink.sock.close(); } catch { /* ignore */ }
  for (const state of peers.values()) {
    closeControl(state);
    try { state.pc.close(); } catch { /* ignore */ }
  }
  signalSub.close();
  rosterSub.close();
  try { pool.close(RELAYS); } catch { /* ignore */ }
  setTimeout(() => process.exit(0), 500);
}
process.on('SIGINT', () => { void cleanup(); });
process.on('SIGTERM', () => { void cleanup(); });

console.log('[mesh] running. Ctrl-C to stop.');
