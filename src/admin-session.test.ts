import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { AdminSessions, SESSION_COOKIE, readCookie, sessionCookie } from './admin-session.js';

const tmpFile = () => join(mkdtempSync(join(tmpdir(), 'sfu-sessions-')), 'admin-sessions.json');
const OP = 'a'.repeat(64);

test('issued session resolves from its cookie and survives a reload', () => {
  const path = tmpFile();
  const { token } = new AdminSessions(path).issue(OP);
  const cookie = `other=1; ${SESSION_COOKIE}=${token}`;
  assert.equal(new AdminSessions(path).lookup(cookie), OP);
});

test('persisted file never contains the raw token', () => {
  const path = tmpFile();
  const { token } = new AdminSessions(path).issue(OP);
  assert.doesNotMatch(readFileSync(path, 'utf8'), new RegExp(token));
});

test('revoked, unknown and malformed cookies do not authenticate', () => {
  const s = new AdminSessions(tmpFile());
  const { token } = s.issue(OP);
  const cookie = `${SESSION_COOKIE}=${token}`;
  s.revoke(cookie);
  assert.equal(s.lookup(cookie), null);
  assert.equal(s.lookup(`${SESSION_COOKIE}=${'b'.repeat(64)}`), null);
  assert.equal(readCookie(`${SESSION_COOKIE}=not-hex`, SESSION_COOKIE), null);
  assert.equal(s.lookup(undefined), null);
});

test('session cookie is HttpOnly, SameSite=Strict and scoped to /admin', () => {
  const c = sessionCookie('c'.repeat(64), { secure: true });
  assert.match(c, /HttpOnly/);
  assert.match(c, /SameSite=Strict/);
  assert.match(c, /Path=\/admin/);
  assert.match(c, /Secure/);
  assert.match(sessionCookie(null, { secure: false }), /Max-Age=0/);
});
