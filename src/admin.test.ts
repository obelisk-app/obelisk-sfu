import assert from 'node:assert/strict';
import test from 'node:test';

import { applyOverrides, isConsoleAdmin } from './admin.js';
import type { Config } from './config.js';

const OP = 'a'.repeat(64);
const SFU = 'b'.repeat(64);
const ADMIN = 'c'.repeat(64);

const cfg = () => ({ operatorPubkey: OP, adminPubkeys: new Set<string>() }) as unknown as Config;

test('console admins are the operator plus the runtime admins list', () => {
  const c = cfg();
  assert.equal(isConsoleAdmin(c, SFU, OP), true);
  assert.equal(isConsoleAdmin(c, SFU, ADMIN), false);
  applyOverrides(c, { admins: [ADMIN.toUpperCase(), 'not-hex'] });
  assert.deepEqual([...c.adminPubkeys], [ADMIN]);
  assert.equal(isConsoleAdmin(c, SFU, ADMIN), true);
  assert.equal(isConsoleAdmin(c, SFU, SFU), false);
  applyOverrides(c, { admins: [] });
  assert.equal(isConsoleAdmin(c, SFU, ADMIN), false);
});
