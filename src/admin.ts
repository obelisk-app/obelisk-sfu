/**
 * SFU admin surface — Nostr-authenticated HTTP endpoints for the operator
 * to inspect and reconfigure the running SFU without shelling into the box.
 *
 * Auth is NIP-98 (kind 27235): clients sign an event tagged with the
 * request's HTTP method + URL, base64-encode it, and pass it as
 * `Authorization: Nostr <b64>`. The pubkey on that event must equal the
 * SFU's operator pubkey (`SFU_OPERATOR_PUBKEY`, defaults to the SFU's own
 * pubkey when unset).
 *
 * Persistence: changes are written to `runtime.json` (sibling of `.env`),
 * which is layered on top of env at boot. Some fields hot-swap (allowed
 * pubkeys, allowAll); changing relays requires a restart, which the UI
 * triggers via `POST /admin/restart` — pm2 brings the process back up.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { verifyEvent, type Event as NostrEvent } from 'nostr-tools';

import type { Config } from './config.js';
import { reloadAllowList } from './config.js';
import { createLogger } from './log.js';

const log = createLogger('admin');

const NIP98_KIND = 27235;
/** Max age of a NIP-98 auth event, in seconds. Tight to limit replay. */
const NIP98_MAX_AGE_S = 60;

export interface RuntimeOverrides {
  relays?: string[];
  trustedAuthorRelays?: string[];
  allowed?: string[];
  trustedReferentPubkeys?: string[];
  whitelistBypassUntil?: number | null;
  allowAll?: boolean;
  requireAllowedPubkey?: boolean;
  publicUrl?: string | null;
  region?: string | null;
  operatorPubkey?: string | null;
  /**
   * Server-wide hard cap on call duration in seconds. 0 disables the cap.
   * Hot-reloaded — new rooms pick it up at `start()`, existing rooms get
   * their timers rearmed via `RoomManager.rearmDurationLimits()`.
   */
  maxCallDurationSeconds?: number;
}

const RUNTIME_PATH = resolve(process.cwd(), 'runtime.json');

export function loadRuntimeOverrides(): RuntimeOverrides {
  if (!existsSync(RUNTIME_PATH)) return {};
  try {
    return JSON.parse(readFileSync(RUNTIME_PATH, 'utf8')) as RuntimeOverrides;
  } catch (err) {
    log.warn('runtime.json parse failed — ignoring', { err: (err as Error).message });
    return {};
  }
}

export function saveRuntimeOverrides(o: RuntimeOverrides): void {
  writeFileSync(RUNTIME_PATH, JSON.stringify(o, null, 2));
}

/**
 * Apply runtime overrides on top of an env-derived Config. Mutates `cfg`.
 * Returns the merged set of values so callers don't need to re-read.
 */
export function applyOverrides(cfg: Config, o: RuntimeOverrides): void {
  if (o.relays && o.relays.length > 0) cfg.relays = [...o.relays];
  if (o.trustedAuthorRelays) cfg.trustedAuthorRelays = [...o.trustedAuthorRelays];
  if (Array.isArray(o.trustedReferentPubkeys)) {
    cfg.trustedReferentPubkeys.clear();
    for (const pk of o.trustedReferentPubkeys) {
      if (/^[0-9a-f]{64}$/i.test(pk)) cfg.trustedReferentPubkeys.add(pk.toLowerCase());
    }
  }
  if (o.whitelistBypassUntil !== undefined) {
    cfg.whitelistBypassUntil = o.whitelistBypassUntil == null
      ? null
      : Math.floor(o.whitelistBypassUntil);
  }
  if (o.publicUrl !== undefined) cfg.publicUrl = o.publicUrl;
  if (o.region !== undefined) cfg.region = o.region;
  if (o.operatorPubkey !== undefined) cfg.operatorPubkey = o.operatorPubkey;
  if (typeof o.allowAll === 'boolean') cfg.allowAll = o.allowAll;
  if (typeof o.requireAllowedPubkey === 'boolean') cfg.requireAllowedPubkey = o.requireAllowedPubkey;
  if (typeof o.maxCallDurationSeconds === 'number' && Number.isFinite(o.maxCallDurationSeconds) && o.maxCallDurationSeconds >= 0) {
    cfg.maxCallDurationSeconds = Math.floor(o.maxCallDurationSeconds);
  }
  if (Array.isArray(o.allowed)) {
    cfg.allowedPubkeys.clear();
    for (const pk of o.allowed) {
      if (/^[0-9a-f]{64}$/i.test(pk)) cfg.allowedPubkeys.add(pk.toLowerCase());
    }
  }
}

/**
 * Verify a NIP-98 Authorization header. Returns the signer pubkey (hex)
 * on success, or an Error subclass with a `status` to forward to the client.
 */
export class AuthError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export function verifyNip98(
  authHeader: string | undefined,
  method: string,
  fullUrl: string,
): string {
  if (!authHeader || !authHeader.toLowerCase().startsWith('nostr ')) {
    throw new AuthError(401, 'missing Nostr authorization header');
  }
  const b64 = authHeader.slice(6).trim();
  let decoded: string;
  try {
    decoded = Buffer.from(b64, 'base64').toString('utf8');
  } catch {
    throw new AuthError(400, 'invalid base64 in authorization');
  }
  let ev: NostrEvent;
  try {
    ev = JSON.parse(decoded) as NostrEvent;
  } catch {
    throw new AuthError(400, 'authorization is not a Nostr event');
  }
  if (ev.kind !== NIP98_KIND) {
    throw new AuthError(401, `expected kind ${NIP98_KIND}, got ${ev.kind}`);
  }
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - ev.created_at) > NIP98_MAX_AGE_S) {
    throw new AuthError(401, 'auth event is too old or in the future');
  }
  const tagU = ev.tags.find((t) => t[0] === 'u')?.[1];
  const tagMethod = ev.tags.find((t) => t[0] === 'method')?.[1];
  if (!tagU || !tagMethod) {
    throw new AuthError(401, 'auth event missing u/method tag');
  }
  if (tagMethod.toUpperCase() !== method.toUpperCase()) {
    throw new AuthError(401, `method mismatch: tag=${tagMethod} req=${method}`);
  }
  if (!urlsMatch(tagU, fullUrl)) {
    throw new AuthError(401, `url mismatch: tag=${tagU} req=${fullUrl}`);
  }
  if (!verifyEvent(ev)) {
    throw new AuthError(401, 'invalid signature');
  }
  return ev.pubkey.toLowerCase();
}

/**
 * Compare two URLs ignoring trailing slashes and case in scheme/host.
 * The client doesn't always know exactly what host the SFU is reachable
 * at (cloudflare tunnel + direct IP), so we accept any hostname as long
 * as the path + method match.
 */
function urlsMatch(a: string, b: string): boolean {
  try {
    const ua = new URL(a);
    const ub = new URL(b);
    const pa = ua.pathname.replace(/\/$/, '') || '/';
    const pb = ub.pathname.replace(/\/$/, '') || '/';
    return pa === pb && ua.search === ub.search;
  } catch {
    return a === b;
  }
}

export function effectiveOperator(cfg: Config, sfuPubkey: string): string {
  return (cfg.operatorPubkey ?? sfuPubkey).toLowerCase();
}

/**
 * Re-derive the in-memory allow-list set from the file system after the
 * admin has rewritten allow.json. Thin wrapper around the existing
 * config helper so callers don't need to import both.
 */
export function reapplyAllowList(cfg: Config): void {
  reloadAllowList(cfg);
}
