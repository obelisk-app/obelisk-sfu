import assert from 'node:assert/strict';
import test from 'node:test';

import { testPeerModeForChannel } from './http-server.js';

test('known channel kind overrides an incompatible requested test-peer engine', () => {
  assert.equal(testPeerModeForChannel('voice', 'sfu'), 'mesh');
  assert.equal(testPeerModeForChannel('voice-sfu', 'mesh'), 'sfu');
});

test('unknown channels retain the requested fallback engine', () => {
  assert.equal(testPeerModeForChannel(null, 'mesh'), 'mesh');
  assert.equal(testPeerModeForChannel(null, 'sfu'), 'sfu');
  assert.equal(testPeerModeForChannel(null), 'sfu');
});
