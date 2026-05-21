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
 *   TEST_PEER_FORCE_RELAY       1 = TURN-only ICE, 0 = all ICE candidates.
 *   TEST_PEER_MAX_LIFETIME_SEC  hard self-exit cap, default 1800.
 */

import { spawn } from 'node:child_process';
import { createSocket } from 'node:dgram';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { SimplePool, finalizeEvent, getPublicKey, nip19 } from 'nostr-tools';
import { generateSecretKey } from 'nostr-tools/pure';
import {
  RTCPeerConnection,
  MediaStreamTrack,
  RtpPacket,
} from 'werift';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const stateDir = path.join(__dirname, '..', '.test-peer-mesh');

const CHANNEL_ID = process.argv[2];
if (!CHANNEL_ID || !/^[0-9a-f]+$/i.test(CHANNEL_ID)) {
  console.error('usage: node test-peer-mesh.mjs <channel-id-hex>');
  process.exit(1);
}

const RELAYS = (process.env.TEST_PEER_RELAYS ?? 'wss://public.obelisk.ar')
  .split(',').map((s) => s.trim()).filter(Boolean);
const TURN_URLS = (process.env.TEST_PEER_TURN_URLS ?? 'turn:89.167.77.78:3478,turn:89.167.77.78:3478?transport=tcp')
  .split(',').map((s) => s.trim()).filter(Boolean);
const TURN_USERNAME = process.env.TEST_PEER_TURN_USERNAME ?? 'obelisk';
const TURN_CREDENTIAL = process.env.TEST_PEER_TURN_CREDENTIAL ?? 'obelisk';
const FORCE_RELAY = (process.env.TEST_PEER_FORCE_RELAY ?? '1') === '1';
const MAX_LIFETIME_SEC = Math.max(60, Number(process.env.TEST_PEER_MAX_LIFETIME_SEC) || 1800);
const PRESENCE_TTL_SECONDS = 45;
const BEACON_INTERVAL_MS = 10_000;
const CONTROL_CHANNEL_LABEL = 'obelisk-control';
const CONTROL_PING_INTERVAL_MS = 2_500;
const CONTROL_PEER_SNAPSHOT_INTERVAL_MS = 5_000;

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
console.log('[mesh] max lifetime', MAX_LIFETIME_SEC, 's');

const pool = new SimplePool({
  automaticallyAuth: () => (template) => Promise.resolve(finalizeEvent(template, secretKey)),
});

async function publish(template, label = 'event') {
  const ev = finalizeEvent({
    ...template,
    created_at: template.created_at ?? Math.floor(Date.now() / 1000),
  }, secretKey);
  const results = await Promise.allSettled(pool.publish(RELAYS, ev));
  const rejected = results
    .map((r, i) => r.status === 'rejected' ? RELAYS[i] + ': ' + (r.reason?.message ?? r.reason) : null)
    .filter(Boolean);
  if (rejected.length > 0) {
    console.warn('[mesh] publish', label, 'had rejections:', rejected.join('; '));
  }
  return ev;
}

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

const peers = new Map();
const connectedPubkeys = new Set();
const rosterLatest = new Map();
const seenSignalIds = new Set();

function knownPubkeys() {
  const out = new Set();
  for (const pk of connectedPubkeys) out.add(pk);
  for (const pk of rosterLatest.keys()) out.add(pk);
  for (const pk of peers.keys()) out.add(pk);
  out.delete(pubkey);
  return Array.from(out).sort();
}

function sendControl(state, msg) {
  const dc = state.controlChannel;
  if (!dc || dc.readyState !== 'open') return;
  try { dc.send(JSON.stringify(msg)); }
  catch (err) { console.warn('[mesh] control send failed', state.remotePubkey.slice(0, 8), err.message); }
}

function sendControlSnapshot(state) {
  sendControl(state, { type: 'peerSnapshot', peers: knownPubkeys(), ts: Date.now() });
}

function broadcastControl(msg) {
  for (const state of peers.values()) sendControl(state, msg);
}

function closeControl(state) {
  if (state.controlPingTimer) { clearInterval(state.controlPingTimer); state.controlPingTimer = null; }
  if (state.controlSnapshotTimer) { clearInterval(state.controlSnapshotTimer); state.controlSnapshotTimer = null; }
  const dc = state.controlChannel;
  state.controlChannel = null;
  if (dc && dc.readyState === 'open') {
    try { dc.close(); } catch { /* ignore */ }
  }
}

function handleControlMessage(state, raw) {
  let msg;
  try {
    const data = Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw ?? '');
    msg = JSON.parse(data);
  } catch {
    return;
  }
  if (!msg || typeof msg.type !== 'string') return;
  if (msg.type === 'hello' || msg.type === 'peerSnapshot') {
    const hinted = Array.isArray(msg.peers) ? msg.peers : [];
    for (const pk of hinted) createPeer(pk);
  } else if (msg.type === 'peerAdded' && typeof msg.pubkey === 'string') {
    createPeer(msg.pubkey);
  } else if (msg.type === 'peerRemoved' && typeof msg.pubkey === 'string') {
    // Do not tear down a direct PC from a third-party removal. The browser
    // side uses full snapshots to decide staleness; the test peer keeps the
    // direct connection if it already exists.
  } else if (msg.type === 'ping') {
    sendControl(state, { type: 'pong', ts: Date.now(), echoTs: msg.ts ?? Date.now() });
  } else if (msg.type === 'bye') {
    console.log('[mesh] control bye from', state.remotePubkey.slice(0, 8), msg.reason ?? 'remote-bye');
    closeControl(state);
    try { state.pc.close(); } catch { /* ignore */ }
    peers.delete(state.remotePubkey);
    connectedPubkeys.delete(state.remotePubkey);
  }
}

function attachControlChannel(state, dc) {
  if (!dc || dc.label !== CONTROL_CHANNEL_LABEL) return;
  if (state.controlChannel) return;
  state.controlChannel = dc;
  dc.onopen = () => {
    console.log('[mesh] control open to', state.remotePubkey.slice(0, 8));
    sendControl(state, {
      type: 'hello',
      peers: knownPubkeys(),
      sessionId: state.sessionId,
      build: 'obelisk-mesh-test-peer',
    });
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

async function sendSignal(toPubkey, payload) {
  await publish({
    kind: 25050,
    content: JSON.stringify(payload),
    tags: [
      ['p', toPubkey],
      ['e', CHANNEL_ID],
      ['t', 'obelisk-voice-signal'],
    ],
  }, 'signal ' + payload.type);
}

async function makeOffer(state, reason) {
  const { pc, remotePubkey } = state;
  if (state.makingOffer || pc.signalingState !== 'stable') return;
  try {
    state.makingOffer = true;
    await pc.setLocalDescription();
    if (!pc.localDescription) return;
    console.log('[mesh] -> offer to', remotePubkey.slice(0, 8), 'reason=', reason, 'sdp=', pc.localDescription.sdp.length);
    await sendSignal(remotePubkey, {
      type: 'offer',
      sdp: pc.localDescription.sdp,
      sessionId: state.sessionId,
      seq: ++state.outboundSeq,
    });
  } catch (err) {
    console.warn('[mesh] makeOffer threw', err.message);
  } finally {
    state.makingOffer = false;
  }
}

function createPeer(remotePubkey) {
  if (!remotePubkey || remotePubkey === pubkey) return null;
  const existing = peers.get(remotePubkey);
  if (existing) return existing;

  const polite = pubkey > remotePubkey;
  console.log('[mesh] open PC to', remotePubkey.slice(0, 8), 'polite=', polite);

  const pc = new RTCPeerConnection({
    iceServers: ICE_SERVERS,
    bundlePolicy: 'max-bundle',
    iceTransportPolicy: FORCE_RELAY ? 'relay' : 'all',
  });
  const state = {
    pc,
    remotePubkey,
    polite,
    makingOffer: false,
    sessionId: randomUUID().slice(0, 8),
    outboundSeq: 0,
    tx: [],
    controlChannel: null,
    controlPingTimer: null,
    controlSnapshotTimer: null,
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
  if (!polite) setTimeout(() => { void makeOffer(state, 'initial'); }, 100);

  pc.onIceCandidate.subscribe(async (candidate) => {
    if (!candidate) return;
    await sendSignal(remotePubkey, {
      type: 'ice',
      candidates: [candidate.toJSON()],
      sessionId: state.sessionId,
      seq: ++state.outboundSeq,
    });
  });

  pc.connectionStateChange.subscribe((s) => {
    console.log('[mesh] PC ->', remotePubkey.slice(0, 8), 'connectionState=', s);
    if (s === 'connected') {
      const isNew = !connectedPubkeys.has(remotePubkey);
      connectedPubkeys.add(remotePubkey);
      if (isNew) broadcastControl({ type: 'peerAdded', pubkey: remotePubkey });
      for (const other of peers.values()) sendControlSnapshot(other);
      void publishBeacon().catch(() => undefined);
    }
    if (s === 'closed' || s === 'failed' || s === 'disconnected') {
      const had = connectedPubkeys.delete(remotePubkey);
      if (had) broadcastControl({ type: 'peerRemoved', pubkey: remotePubkey });
      if (s === 'closed' || s === 'failed') {
        closeControl(state);
        peers.delete(remotePubkey);
      }
      for (const other of peers.values()) sendControlSnapshot(other);
      void publishBeacon().catch(() => undefined);
    }
  });
  pc.iceConnectionStateChange.subscribe((s) => {
    console.log('[mesh] PC ->', remotePubkey.slice(0, 8), 'iceConnectionState=', s);
  });

  setTimeout(async () => {
    await sendSignal(remotePubkey, {
      type: 'trackinfo',
      trackInfo: { trackId: sharedVideoTrack.uuid, kind: 'camera' },
      sessionId: state.sessionId,
      seq: ++state.outboundSeq,
    });
    await sendSignal(remotePubkey, {
      type: 'trackinfo',
      trackInfo: { trackId: sharedAudioTrack.uuid, kind: 'audio' },
      sessionId: state.sessionId,
      seq: ++state.outboundSeq,
    });
  }, 50);

  return state;
}

async function handleSignal(fromPubkey, payload) {
  const state = createPeer(fromPubkey);
  if (!state) return;
  const { pc } = state;
  try {
    if (payload.sessionId) state.remoteSessionId = payload.sessionId;

    if (payload.type === 'offer' && payload.sdp) {
      const offerCollision = state.makingOffer || pc.signalingState !== 'stable';
      if (offerCollision && !state.polite) {
        console.log('[mesh] drop colliding offer from', fromPubkey.slice(0, 8), 'state=', pc.signalingState);
        return;
      }
      if (offerCollision && pc.signalingState === 'have-local-offer') {
        console.log('[mesh] reset polite peer on offer glare from', fromPubkey.slice(0, 8));
        closeControl(state);
        try { pc.close(); } catch { /* ignore */ }
        peers.delete(fromPubkey);
        connectedPubkeys.delete(fromPubkey);
        await handleSignal(fromPubkey, payload);
        return;
      }
      await pc.setRemoteDescription({ type: 'offer', sdp: payload.sdp });
      await pc.setLocalDescription();
      if (pc.localDescription) {
        console.log('[mesh] -> answer to', fromPubkey.slice(0, 8), 'sdp=', pc.localDescription.sdp.length);
        await sendSignal(fromPubkey, {
          type: 'answer',
          sdp: pc.localDescription.sdp,
          sessionId: state.sessionId,
          seq: ++state.outboundSeq,
        });
      }
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
    } else if (payload.type === 'requestReset') {
      console.log('[mesh] requestReset from', fromPubkey.slice(0, 8));
      closeControl(state);
      try { pc.close(); } catch { /* ignore */ }
      peers.delete(fromPubkey);
      connectedPubkeys.delete(fromPubkey);
      createPeer(fromPubkey);
    }
  } catch (err) {
    console.warn('[mesh] handleSignal threw', err.message);
  }
}

function eventHasTag(ev, name, value) {
  return ev.tags.some((t) => t[0] === name && t[1] === value);
}

function pruneRoster() {
  const now = Math.floor(Date.now() / 1000);
  for (const [pk, entry] of Array.from(rosterLatest.entries())) {
    if (entry.expiresAt > now) continue;
    rosterLatest.delete(pk);
    if (!connectedPubkeys.has(pk)) {
      const peer = peers.get(pk);
      if (peer) {
        closeControl(peer);
        try { peer.pc.close(); } catch { /* ignore */ }
        peers.delete(pk);
      }
    }
  }
}

function upsertRosterBeacon(ev) {
  if (ev.pubkey === pubkey) return;
  if (!eventHasTag(ev, 'e', CHANNEL_ID)) return;
  if (!eventHasTag(ev, 't', 'obelisk-voice-presence')) return;
  if (eventHasTag(ev, 'sfu', '1')) return;
  const expirationTag = ev.tags.find((t) => t[0] === 'expiration')?.[1];
  const expiresAt = expirationTag ? parseInt(expirationTag, 10) || 0 : ev.created_at + PRESENCE_TTL_SECONDS;
  if (!Number.isFinite(expiresAt) || expiresAt <= Math.floor(Date.now() / 1000)) return;
  const prev = rosterLatest.get(ev.pubkey);
  if (prev && prev.createdAt >= ev.created_at) return;
  const hintedSet = new Set();
  for (const t of ev.tags) {
    if ((t[0] === 'p' || t[0] === 'peer') && typeof t[1] === 'string' && t[1] && t[1] !== pubkey) {
      hintedSet.add(t[1]);
    }
  }
  const hinted = Array.from(hintedSet);
  rosterLatest.set(ev.pubkey, { createdAt: ev.created_at, expiresAt, peers: hinted });

  console.log('[mesh] roster sees', ev.pubkey.slice(0, 8), hinted.length ? 'hints=' + hinted.length : '');
  createPeer(ev.pubkey);
  for (const pk of hinted) createPeer(pk);
  for (const state of peers.values()) sendControlSnapshot(state);
}

pool.subscribe(RELAYS, {
  kinds: [25050],
  since: Math.floor(Date.now() / 1000) - 30,
}, {
  onevent: async (ev) => {
    if (seenSignalIds.has(ev.id)) return;
    seenSignalIds.add(ev.id);
    if (ev.pubkey === pubkey) return;
    if (!eventHasTag(ev, 'e', CHANNEL_ID)) return;
    const targeted = ev.tags.some((t) => t[0] === 'p' && t[1] === pubkey);
    if (!targeted) return;
    let payload;
    try { payload = JSON.parse(ev.content); } catch { return; }
    console.log('[mesh] <-', payload.type, 'from', ev.pubkey.slice(0, 8), 'seq=', payload.seq ?? '-');
    await handleSignal(ev.pubkey, payload);
  },
});

pool.subscribe(RELAYS, {
  kinds: [20078],
  since: Math.floor(Date.now() / 1000) - 60,
}, {
  onevent: upsertRosterBeacon,
});

async function publishBeacon() {
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
await publishBeacon();
const beaconTimer = setInterval(() => { void publishBeacon().catch(() => undefined); }, BEACON_INTERVAL_MS);
const pruneTimer = setInterval(pruneRoster, Math.floor(PRESENCE_TTL_SECONDS * 500));

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
    cleanup();
  }
}, 30_000);

let shuttingDown = false;
function cleanup() {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log('[mesh] shutting down');
  clearInterval(beaconTimer);
  clearInterval(pruneTimer);
  clearInterval(statsTimer);
  try { ffv.kill('SIGTERM'); } catch { /* ignore */ }
  try { ffa.kill('SIGTERM'); } catch { /* ignore */ }
  try { videoSink.sock.close(); } catch { /* ignore */ }
  try { audioSink.sock.close(); } catch { /* ignore */ }
  for (const state of peers.values()) {
    closeControl(state);
    try { state.pc.close(); } catch { /* ignore */ }
  }
  try { pool.close(RELAYS); } catch { /* ignore */ }
  setTimeout(() => process.exit(0), 500);
}
process.on('SIGINT', cleanup);
process.on('SIGTERM', cleanup);

console.log('[mesh] running. Ctrl-C to stop.');
