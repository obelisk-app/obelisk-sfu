import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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

test("admin access manager shows profile-rich npub controls without trusted-relay input", () => {
  const html = readFileSync(new URL("../admin-ui/index.html", import.meta.url), "utf8");
  assert.match(html, /id="allowed-list"/);
  assert.match(html, /id="referent-list"/);
  assert.match(html, /SimplePool/);
  assert.match(html, /nip19\.decode/);
  assert.match(html, /profile.picture/);
  assert.doesNotMatch(html, /id="i-trusted"/);
});
