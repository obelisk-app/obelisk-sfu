import assert from 'node:assert/strict';
import test from 'node:test';

import { normalizeMeshSignal } from './mesh-signal.mjs';

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
