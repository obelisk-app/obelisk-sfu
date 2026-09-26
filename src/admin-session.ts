/**
 * Admin sessions for the web console.
 *
 * NIP-98 alone means one signature per HTTP request, which is fine for an
 * extension but unusable with a remote signer (NIP-46: a phone prompt for
 * every 5 s state poll). So the console signs ONE NIP-98 event against
 * `POST /admin/session`, gets an HttpOnly cookie back, and uses that until
 * it expires. Scripts can keep sending NIP-98 on every call.
 *
 * Tokens are stored hashed (sha256) and persisted next to runtime.json so
 * the "Restart SFU" button doesn't log the operator out. The file never
 * holds a usable token.
 */
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { createLogger } from './log.js';

const log = createLogger('admin-session');

export const SESSION_COOKIE = 'obelisk_sfu_admin';
export const SESSION_TTL_S = 12 * 60 * 60;

interface StoredSession {
  pubkey: string;
  expiresAt: number;
}

const hash = (token: string) => createHash('sha256').update(token).digest('hex');

export class AdminSessions {
  private sessions = new Map<string, StoredSession>();

  constructor(private readonly path = resolve(process.cwd(), 'admin-sessions.json')) {
    this.load();
  }

  /** Mint a session for an operator who just proved their key via NIP-98. */
  issue(pubkey: string): { token: string; expiresAt: number } {
    const token = randomBytes(32).toString('hex');
    const expiresAt = Math.floor(Date.now() / 1000) + SESSION_TTL_S;
    this.sessions.set(hash(token), { pubkey, expiresAt });
    this.save();
    return { token, expiresAt };
  }

  /** Pubkey behind the request's session cookie, or null. */
  lookup(cookieHeader: string | undefined): string | null {
    const token = readCookie(cookieHeader, SESSION_COOKIE);
    if (!token) return null;
    const s = this.sessions.get(hash(token));
    if (!s) return null;
    if (s.expiresAt <= Math.floor(Date.now() / 1000)) {
      this.sessions.delete(hash(token));
      this.save();
      return null;
    }
    return s.pubkey;
  }

  revoke(cookieHeader: string | undefined): void {
    const token = readCookie(cookieHeader, SESSION_COOKIE);
    if (token && this.sessions.delete(hash(token))) this.save();
  }

  private load(): void {
    if (!existsSync(this.path)) return;
    try {
      const raw = JSON.parse(readFileSync(this.path, 'utf8')) as Record<string, StoredSession>;
      const now = Math.floor(Date.now() / 1000);
      for (const [h, s] of Object.entries(raw)) {
        if (s && typeof s.pubkey === 'string' && s.expiresAt > now) this.sessions.set(h, s);
      }
    } catch (err) {
      log.warn('could not read admin sessions — starting empty', { err: (err as Error).message });
    }
  }

  private save(): void {
    const now = Math.floor(Date.now() / 1000);
    for (const [h, s] of this.sessions) if (s.expiresAt <= now) this.sessions.delete(h);
    try {
      writeFileSync(this.path, JSON.stringify(Object.fromEntries(this.sessions)), { mode: 0o600 });
    } catch (err) {
      log.warn('could not persist admin sessions', { err: (err as Error).message });
    }
  }
}

export function readCookie(header: string | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) {
      const value = v.join('=');
      return /^[0-9a-f]{64}$/.test(value) ? value : null;
    }
  }
  return null;
}

export function sessionCookie(token: string | null, { secure }: { secure: boolean }): string {
  const base = `${SESSION_COOKIE}=${token ?? ''}; Path=/admin; HttpOnly; SameSite=Strict${secure ? '; Secure' : ''}`;
  return token ? `${base}; Max-Age=${SESSION_TTL_S}` : `${base}; Max-Age=0`;
}
