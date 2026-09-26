import assert from 'node:assert/strict';
import test from 'node:test';

import { publishWithAuth, subscribeResilient } from './relay-auth.mjs';

function fakeRelay({ rejectFirstWith = null } = {}) {
  const relay = {
    challenge: 'c',
    authed: 0,
    published: 0,
    async auth() { relay.authed += 1; return 'ok'; },
    async publish() { relay.published += 1; return 'ok'; },
  };
  return { relay, firstPublish: rejectFirstWith ? Promise.reject(new Error(rejectFirstWith)) : Promise.resolve('ok') };
}

test('auth-ish rejection → AUTH on that socket and one retry', async () => {
  const { relay, firstPublish } = fakeRelay({ rejectFirstWith: 'restricted: Access denied: your pubkey is not whitelisted' });
  const pool = { publish: () => [firstPublish], ensureRelay: async () => relay };
  const [result] = await publishWithAuth(pool, ['wss://r'], { id: 'x' }, async () => ({}));
  assert.equal(result.status, 'fulfilled');
  assert.equal(relay.authed, 1);
  assert.equal(relay.published, 1);
});

test('other rejections are not retried', async () => {
  const { relay, firstPublish } = fakeRelay({ rejectFirstWith: 'invalid: bad signature' });
  const pool = { publish: () => [firstPublish], ensureRelay: async () => relay };
  const [result] = await publishWithAuth(pool, ['wss://r'], { id: 'x' }, async () => ({}));
  assert.equal(result.status, 'rejected');
  assert.equal(relay.authed, 0);
});

test('subscriptions are per relay, carry onauth and reopen after a close', async () => {
  const opened = [];
  const pool = {
    subscribe(relays, filter, params) {
      opened.push({ relays, filter, params });
      return { close() {} };
    },
  };
  const sub = subscribeResilient(pool, ['wss://a', 'wss://b'], { kinds: [20078], '#e': ['ch'] },
    { onevent() {}, signer: async () => ({}), label: 'roster', sinceWindow: 60 });
  assert.equal(opened.length, 2);
  assert.deepEqual(opened.map((o) => o.relays[0]), ['wss://a', 'wss://b']);
  assert.ok(opened.every((o) => typeof o.params.onauth === 'function'));
  assert.deepEqual(opened[0].filter['#e'], ['ch']);
  opened[0].params.onclose(['auth-required: nope']);
  await new Promise((r) => setTimeout(r, 1100));
  assert.equal(opened.length, 3, 'closed subscription reopened');
  sub.close();
});
