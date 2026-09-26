// Who may start calls: allowed callers, reference accounts (their kind 3
// follows are allowed too), the temporary whitelist bypass and allow-all.
// Changes apply immediately (no restart).
import { useState } from 'preact/hooks'
import { nip19 } from 'nostr-tools'
import { api, Snapshot } from '../api'
import { Profile, profileName, useProfiles } from '../profiles'
import { toast } from './toast'
import { Avatar, CopyChip, Icon, Section, Stat, npub, shortNpub } from './ui'

type ListField = 'allowed' | 'trustedReferentPubkeys'

/** npub / nprofile / 64-hex / NIP-05 → hex pubkey. */
export async function normalizePersonInput(raw: string): Promise<string> {
  const value = raw.trim().replace(/^nostr:/, '')
  if (/^[0-9a-f]{64}$/i.test(value)) return value.toLowerCase()
  if (/^(npub|nprofile)1/i.test(value)) {
    const decoded = nip19.decode(value)
    if (decoded.type === 'npub') return decoded.data.toLowerCase()
    if (decoded.type === 'nprofile') return decoded.data.pubkey.toLowerCase()
  }
  if (value.includes('@')) {
    const [name, domain] = value.split('@')
    if (!name || !domain) throw new Error('Invalid NIP-05 identifier')
    const res = await fetch(`https://${domain}/.well-known/nostr.json?name=${encodeURIComponent(name)}`)
    if (!res.ok) throw new Error(`NIP-05 lookup failed: ${res.status}`)
    const pk = (await res.json())?.names?.[name]
    if (typeof pk === 'string' && /^[0-9a-f]{64}$/i.test(pk)) return pk.toLowerCase()
    throw new Error('NIP-05 did not return a valid pubkey')
  }
  throw new Error('Enter an npub, a 64-character hex pubkey, or a NIP-05 address')
}

const matches = (pk: string, p: Profile | undefined, q: string) =>
  !q || [pk, npub(pk), p?.name, p?.display_name, p?.nip05].some((v) => v?.toLowerCase().includes(q))

export function Access({ snap, onChange }: { snap: Snapshot; onChange: (s: Snapshot) => void }) {
  const profiles = useProfiles([...snap.allowed, ...snap.trustedReferentPubkeys])
  const [busy, setBusy] = useState('')

  const patch = async (body: Record<string, unknown>, ok: string, key = 'patch') => {
    setBusy(key)
    try {
      const { state } = await api.patch(body)
      onChange(state)
      toast.ok(ok)
      return true
    } catch (err) {
      toast.err((err as Error).message)
      return false
    } finally {
      setBusy('')
    }
  }

  const now = Math.floor(Date.now() / 1000)
  const bypassActive = !!snap.whitelistBypassUntil && snap.whitelistBypassUntil > now
  const mode = snap.allowAll ? 'open' : bypassActive ? 'bypass' : 'whitelist'

  const syncFollows = async () => {
    setBusy('sync')
    try {
      const r = await api.syncFollows()
      toast.ok(`Synced ${r.derived ?? 0} followed pubkeys`)
      onChange(await api.state())
    } catch (err) {
      toast.err((err as Error).message)
    } finally {
      setBusy('')
    }
  }

  return (
    <div>
      <div class="mb-6">
        <p class="text-xs font-bold uppercase tracking-[0.18em] text-lc-green mb-1">Access</p>
        <h1 class="text-3xl font-extrabold tracking-tight">Who can start calls</h1>
        <p class="text-sm text-lc-muted mt-1">Changes apply immediately — no restart needed.</p>
      </div>

      <div class="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
        <Stat label="Mode" value={mode === 'open' ? 'Open' : mode === 'bypass' ? 'Bypass' : 'Whitelist'}
          accent={mode === 'whitelist'} hint={mode === 'whitelist' ? 'enforced' : 'anyone can start calls'} />
        <Stat label="Allowed callers" value={snap.allowed.length} />
        <Stat label="Reference accounts" value={snap.trustedReferentPubkeys.length} />
        <Stat label="Via follows" value={snap.followAllowedCount} hint="from reference accounts' kind 3" />
      </div>

      {mode !== 'whitelist' && (
        <div class="rounded-xl border border-yellow-900 bg-yellow-950/40 text-yellow-300 text-sm px-4 py-3 mb-6">
          {mode === 'open'
            ? '⚠ Allow-all is on: any Nostr key can start calls on this SFU. Testing only.'
            : `⚠ Whitelist bypassed until ${new Date(snap.whitelistBypassUntil! * 1000).toLocaleTimeString()} (${Math.ceil((snap.whitelistBypassUntil! - now) / 60)} min left).`}
        </div>
      )}

      <div class="grid lg:grid-cols-2 gap-6 items-start">
        <PeoplePanel
          title="Allowed callers"
          subtitle="These people can authenticate directly to this SFU."
          field="allowed"
          list={snap.allowed}
          profiles={profiles}
          busy={busy}
          searchable
          onAdd={(pk) => patch({ allowed: [...snap.allowed, pk] }, 'Caller allowed', 'add-allowed')}
          onRemove={(pk) => patch({ allowed: snap.allowed.filter((x) => x !== pk) }, 'Removed')}
        />
        <PeoplePanel
          title="Reference accounts"
          subtitle="Everyone these accounts follow (their latest kind 3) is allowed too."
          field="trustedReferentPubkeys"
          list={snap.trustedReferentPubkeys}
          profiles={profiles}
          busy={busy}
          onAdd={(pk) => patch({ trustedReferentPubkeys: [...snap.trustedReferentPubkeys, pk] }, 'Reference account added', 'add-trustedReferentPubkeys')}
          onRemove={(pk) => patch({ trustedReferentPubkeys: snap.trustedReferentPubkeys.filter((x) => x !== pk) }, 'Removed')}
          footer={
            <button class="lc-pill-secondary text-xs gap-1.5 mt-4" disabled={busy === 'sync'} onClick={syncFollows}>
              <Icon.restart /> {busy === 'sync' ? 'Syncing…' : `Sync follows (${snap.followAllowedCount})`}
            </button>
          }
        />
      </div>

      <Section title="Testing overrides" subtitle="Temporarily let anyone in — for testing calls with people who aren't on the list yet.">
        <div class="flex flex-wrap items-center gap-3">
          {bypassActive ? (
            <button class="lc-pill-primary text-sm" disabled={!!busy}
              onClick={() => patch({ whitelistBypassUntil: null }, 'Whitelist re-enabled')}>Re-enable whitelist now</button>
          ) : (
            <button class="lc-pill-secondary text-sm" disabled={!!busy}
              onClick={() => patch({ whitelistBypassUntil: now + 3600 }, 'Whitelist disabled for one hour')}>Disable whitelist for 1 hour</button>
          )}
          <label class="flex items-center gap-3 cursor-pointer ml-auto">
            <span class="text-sm">Allow all <span class="text-lc-muted text-xs">(testing only)</span></span>
            <button type="button" class={`lc-switch ${snap.allowAll ? 'on' : ''}`} role="switch" aria-checked={snap.allowAll}
              disabled={!!busy}
              onClick={() => {
                if (!snap.allowAll && !confirm('Let ANY Nostr key start calls on this SFU?')) return
                patch({ allowAll: !snap.allowAll }, snap.allowAll ? 'Whitelist enforced' : 'SFU access is open')
              }}>
              <span class="lc-switch-knob" />
            </button>
          </label>
        </div>
      </Section>
    </div>
  )
}

function PeoplePanel({ title, subtitle, field, list, profiles, busy, searchable, onAdd, onRemove, footer }: {
  title: string
  subtitle: string
  field: ListField
  list: string[]
  profiles: Map<string, Profile>
  busy: string
  searchable?: boolean
  onAdd: (pk: string) => Promise<boolean>
  onRemove: (pk: string) => Promise<boolean>
  footer?: preact.ComponentChildren
}) {
  const [input, setInput] = useState('')
  const [query, setQuery] = useState('')
  const [resolving, setResolving] = useState(false)

  const add = async (e: Event) => {
    e.preventDefault()
    if (!input.trim()) return
    setResolving(true)
    try {
      const pk = await normalizePersonInput(input)
      if (list.includes(pk)) {
        toast.ok('Already added')
        return
      }
      if (await onAdd(pk)) setInput('')
    } catch (err) {
      toast.err((err as Error).message)
    } finally {
      setResolving(false)
    }
  }

  const q = query.trim().toLowerCase()
  const visible = list.filter((pk) => matches(pk, profiles.get(pk), q))

  return (
    <section class="lc-card p-5 mb-6">
      <div class="flex items-center gap-2 mb-1">
        <h2 class="font-bold text-lg">{title}</h2>
        <span class="lc-tag">{list.length}</span>
      </div>
      <p class="text-xs text-lc-muted mb-4">{subtitle}</p>

      <form class="flex gap-2 mb-3" onSubmit={add}>
        <input class="lc-input font-mono text-xs" placeholder="npub1…, hex, or name@domain"
          value={input} onInput={(e) => setInput((e.target as HTMLInputElement).value)} />
        <button class="lc-pill-primary text-sm gap-1 whitespace-nowrap" disabled={resolving || busy === `add-${field}` || !input.trim()}>
          {resolving || busy === `add-${field}` ? <span class="lc-spinner !w-4 !h-4" /> : <><Icon.plus /> Add</>}
        </button>
      </form>

      {searchable && list.length > 4 && (
        <label class="lc-search mb-3">
          <Icon.search />
          <input placeholder="Search name, npub or NIP-05" value={query} onInput={(e) => setQuery((e.target as HTMLInputElement).value)} />
        </label>
      )}

      <div class="space-y-2">
        {visible.length === 0 && (
          <p class="text-xs text-lc-muted py-2">{q ? 'No matching people.' : 'Nobody added yet.'}</p>
        )}
        {visible.map((pk) => {
          const p = profiles.get(pk)
          const name = profileName(p, shortNpub(pk))
          return (
            <div key={pk} class="flex items-center gap-3 rounded-xl border border-lc-border bg-lc-black/60 px-3 py-2.5">
              <Avatar picture={p?.picture} label={name} size={38} />
              <div class="min-w-0 flex-1">
                <div class="text-sm font-semibold truncate">{name}</div>
                <div class="text-[11px] text-lc-muted truncate">{p?.nip05 ?? <CopyChip text={npub(pk)} label={shortNpub(pk)} />}</div>
              </div>
              {p?.nip05 && <CopyChip text={npub(pk)} label="copy npub" />}
              <button class="lc-pill-danger text-xs !px-3 !py-1" disabled={!!busy}
                onClick={() => { if (confirm(`Remove ${name}?`)) onRemove(pk) }}>Remove</button>
            </div>
          )
        })}
      </div>
      {footer}
    </section>
  )
}
