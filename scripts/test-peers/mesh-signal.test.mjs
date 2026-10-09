import assert from 'node:assert/strict';
import test from 'node:test';

import { bindSession, normalizeMeshSignal, parsePresenceBeacon, supersedes } from './mesh-signal.mjs';

test('normalizes simple-peer SDP and ICE signals', () => {
  assert.deepEqual(
    normalizeMeshSignal({ type: 'peer', peerSignal: { type: 'offer', sdp: 'v=0' }, sessionId: 'a' }),
    { type: 'offer', peerSignal: { type: 'offer', sdp: 'v=0' }, sdp: 'v=0', sessionId: 'a' },
  );
  assert.deepEqual(
    normalizeMeshSignal({ type: 'peer', peerSignal: { type: 'candidate', candidate: { candidate: 'ice' } } }),
    { type: 'ice', peerSignal: { type: 'candidate', candidate: { candidate: 'ice' } }, candidates: [{ candidate: 'ice' }] },
  );
});

test('keeps legacy signals and rejects malformed peer signals', () => {
  const legacy = { type: 'answer', sdp: 'v=0' };
  assert.equal(normalizeMeshSignal(legacy), legacy);
  assert.equal(normalizeMeshSignal({ type: 'peer', peerSignal: { type: 'renegotiate' } }), null);
});

test('binds the remote session on its first SDP, not on ICE or metadata', () => {
  const state = { sessionId: 'mine', remoteSessionId: null };
  assert.equal(bindSession(state, { type: 'trackinfo', sessionId: 'old' }), 'accept');
  assert.equal(state.remoteSessionId, null);
  assert.equal(bindSession(state, { type: 'peer', peerSignal: { type: 'offer', sdp: 'v=0' }, sessionId: 'a' }), 'accept');
  assert.equal(state.remoteSessionId, 'a');
  assert.equal(bindSession(state, { type: 'peer', peerSignal: { type: 'candidate', candidate: {} }, sessionId: 'a' }), 'accept');
});

test('drops stale-session signals and replaces on an offer from a rebuilt remote', () => {
  const state = { sessionId: 'mine', remoteSessionId: 'a' };
  assert.equal(bindSession(state, { type: 'peer', peerSignal: { type: 'candidate', candidate: {} }, sessionId: 'old' }), 'drop');
  assert.equal(bindSession(state, { type: 'bye', sessionId: 'old' }), 'drop');
  assert.equal(bindSession(state, { type: 'peer', peerSignal: { type: 'offer', sdp: 'v=0' }, sessionId: 'b' }), 'replace');
  assert.equal(state.remoteSessionId, 'a');
});

test('targetSessionId for another connection drops even resets', () => {
  const state = { sessionId: 'mine', remoteSessionId: 'a' };
  assert.equal(bindSession(state, { type: 'requestReset', sessionId: 'a', targetSessionId: 'previous' }), 'drop');
  assert.equal(bindSession(state, { type: 'requestReset', sessionId: 'z', targetSessionId: 'mine' }), 'accept');
  assert.equal(bindSession(state, { type: 'bye', byeReason: 'room-full', sessionId: 'z' }), 'accept');
  assert.equal(bindSession(state, { type: 'answer', sdp: 'v=0' }), 'accept');
});

const CH = 'c0ffee';
const beacon = (tags, created_at = 1000, pubkey = 'a'.repeat(64)) => ({
  pubkey, created_at, tags: [['e', CH], ['t', 'obelisk-voice-presence'], ...tags],
});

test('beacon participants are the publisher and its p tags, never peer tags', () => {
  const b = parsePresenceBeacon(beacon([
    ['expiration', '1150'], ['p', 'b'.repeat(64)], ['p', 'b'.repeat(64)], ['peer', 'c'.repeat(64)],
  ]), { channelId: CH, ttlSeconds: 150, nowSeconds: 1000 });
  assert.deepEqual(b.connectedTo, ['b'.repeat(64)]);
  assert.equal(b.terminal, false);
  assert.equal(b.expiresAt, 1150);
});

test('a status=left beacon is terminal even with a future expiration', () => {
  const b = parsePresenceBeacon(beacon([['status', 'left'], ['expiration', '1010']]), { channelId: CH, ttlSeconds: 150, nowSeconds: 1000 });
  assert.equal(b.terminal, true);
  assert.equal(b.expiresAt, 1000);
});

test('beacons for other channels or without the presence marker are ignored', () => {
  assert.equal(parsePresenceBeacon({ pubkey: 'a', created_at: 1, tags: [['e', 'other'], ['t', 'obelisk-voice-presence']] }, { channelId: CH, ttlSeconds: 150 }), null);
  assert.equal(parsePresenceBeacon({ pubkey: 'a', created_at: 1, tags: [['e', CH]] }, { channelId: CH, ttlSeconds: 150 }), null);
});

test('newest beacon wins; at an equal created_at only a terminal one replaces', () => {
  const live = { createdAt: 1000, terminal: false };
  assert.equal(supersedes(undefined, live), true);
  assert.equal(supersedes(live, { createdAt: 999, terminal: true }), false);
  assert.equal(supersedes(live, { createdAt: 1000, terminal: false }), false);
  assert.equal(supersedes(live, { createdAt: 1000, terminal: true }), true);
  assert.equal(supersedes(live, { createdAt: 1001, terminal: false }), true);
});
