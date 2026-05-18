/**
 * Follow-derived SFU whitelist.
 *
 * Mirrors the obelisk-relay admin model: operators configure trusted
 * referent accounts, then the service fetches each referent's latest kind-3
 * contact list and allows those followed pubkeys to authenticate.
 */
import { writeFileSync } from 'node:fs';

import { SimplePool, type Event } from 'nostr-tools';

import type { Config } from './config.js';
import { createLogger } from './log.js';
import type { Hex } from './types.js';

const log = createLogger('follow-whitelist');

export async function syncTrustedReferentFollows(cfg: Config): Promise<{
  referents: number;
  derived: number;
}> {
  const referents = [...cfg.trustedReferentPubkeys];
  if (referents.length === 0) {
    cfg.followAllowedPubkeys.clear();
    persistFollowDerived(cfg, []);
    return { referents: 0, derived: 0 };
  }

  const pool = new SimplePool();
  try {
    const events = await pool.querySync(
      cfg.followRelays,
      { kinds: [3], authors: referents },
      { maxWait: 10_000 },
    );
    const latest = new Map<Hex, Event>();
    for (const ev of events) {
      const prev = latest.get(ev.pubkey);
      if (!prev || prev.created_at < ev.created_at) latest.set(ev.pubkey, ev);
    }

    const follows = new Set<Hex>();
    for (const ev of latest.values()) {
      for (const tag of ev.tags) {
        if (tag[0] !== 'p') continue;
        const pk = tag[1]?.toLowerCase();
        if (pk && /^[0-9a-f]{64}$/.test(pk)) follows.add(pk);
      }
    }

    cfg.followAllowedPubkeys.clear();
    for (const pk of follows) cfg.followAllowedPubkeys.add(pk);
    persistFollowDerived(cfg, [...follows]);
    log.info('trusted referent follow sync complete', {
      referents: referents.length,
      latestContactLists: latest.size,
      derived: follows.size,
    });
    return { referents: referents.length, derived: follows.size };
  } finally {
    try { pool.close(cfg.followRelays); } catch { /* best effort */ }
  }
}

function persistFollowDerived(cfg: Config, pubkeys: readonly Hex[]): void {
  writeFileSync(cfg.followAllowFilePath, JSON.stringify([...pubkeys].sort(), null, 2));
}
