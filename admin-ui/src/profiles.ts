// Nostr profiles (kind 0) for the pubkeys the console shows — operator,
// allowed callers, reference accounts, room hosts. Resolved in the browser
// from public profile relays and cached for the session.
import { useEffect, useState } from 'preact/hooks'
import { SimplePool } from 'nostr-tools'

export interface Profile {
  name?: string
  display_name?: string
  picture?: string
  nip05?: string
}

const PROFILE_RELAYS = ['wss://purplepag.es', 'wss://relay.damus.io', 'wss://nos.lol', 'wss://relay.primal.net']
const pool = new SimplePool()
const cache = new Map<string, Profile>()
const requested = new Set<string>()
const listeners = new Set<() => void>()

const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined)
const safeUrl = (raw: unknown) => {
  try {
    const u = new URL(String(raw))
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.href : undefined
  } catch { return undefined }
}

async function fetchProfiles(pubkeys: string[]) {
  const wanted = pubkeys.filter((pk) => /^[0-9a-f]{64}$/.test(pk) && !requested.has(pk))
  if (!wanted.length) return
  wanted.forEach((pk) => requested.add(pk))
  try {
    const events = await pool.querySync(PROFILE_RELAYS, { kinds: [0], authors: wanted }, { maxWait: 5000 })
    const latest = new Map<string, (typeof events)[number]>()
    for (const ev of events) {
      const prior = latest.get(ev.pubkey)
      if (!prior || prior.created_at < ev.created_at) latest.set(ev.pubkey, ev)
    }
    for (const pk of wanted) {
      const ev = latest.get(pk)
      let profile: Profile = {}
      if (ev) {
        try {
          const d = JSON.parse(ev.content)
          profile = { name: str(d.name), display_name: str(d.display_name), picture: safeUrl(d.picture), nip05: str(d.nip05) }
        } catch { /* malformed kind 0 */ }
      }
      cache.set(pk, profile)
    }
  } catch {
    wanted.forEach((pk) => cache.set(pk, {}))
  }
  listeners.forEach((fn) => fn())
}

/** Profiles for these pubkeys; re-renders as they arrive. */
export function useProfiles(pubkeys: (string | null | undefined)[]): Map<string, Profile> {
  const [, bump] = useState(0)
  const key = pubkeys.filter(Boolean).join(',')
  useEffect(() => {
    const fn = () => bump((n) => n + 1)
    listeners.add(fn)
    fetchProfiles(pubkeys.filter((p): p is string => !!p))
    return () => { listeners.delete(fn) }
  }, [key])
  return cache
}

export const profileName = (p: Profile | undefined, fallback: string) =>
  p?.display_name || p?.name || fallback
