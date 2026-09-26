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

test('admin console resolves people from npub/hex/NIP-05 with Nostr profiles', () => {
  const access = readFileSync(new URL('../admin-ui/src/components/Access.tsx', import.meta.url), 'utf8');
  const profiles = readFileSync(new URL('../admin-ui/src/profiles.ts', import.meta.url), 'utf8');
  assert.match(access, /nip19\.decode/);
  assert.match(access, /well-known\/nostr\.json/);
  assert.match(access, /trustedReferentPubkeys/);
  assert.match(profiles, /SimplePool/);
  assert.match(profiles, /picture/);
  assert.doesNotMatch(access, /trustedAuthorRelays/);
});

test('admin console signs in through the nostr-wot-sdk login modal and a NIP-98 session', () => {
  const login = readFileSync(new URL('../admin-ui/src/components/Login.tsx', import.meta.url), 'utf8');
  const auth = readFileSync(new URL('../admin-ui/src/auth.ts', import.meta.url), 'utf8');
  assert.match(login, /LoginModal/);
  assert.match(login, /'nip07', 'nip46', 'import'/);
  assert.match(auth, /kind: 27235/);
  assert.match(auth, /\/admin\/session/);
});
