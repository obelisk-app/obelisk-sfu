// runtime.json settings. Relay changes need a restart; the call cap and
// everything else apply live.
import { useEffect, useState } from 'preact/hooks'
import { nip19 } from 'nostr-tools'
import { api, Snapshot } from '../api'
import { useProfiles } from '../profiles'
import { PeoplePanel } from './Access'
import { toast } from './toast'
import { Section, shortNpub } from './ui'

const lines = (s: string) => s.split(/[\s,]+/).map((x) => x.trim()).filter(Boolean)

interface Form {
  relays: string
  publicUrl: string
  region: string
  maxCallMinutes: string
  operator: string
}

const fromSnap = (s: Snapshot): Form => ({
  relays: s.relays.join('\n'),
  publicUrl: s.publicUrl ?? '',
  region: s.region ?? '',
  maxCallMinutes: String(Math.round((s.maxCallDurationSeconds ?? 3600) / 60)),
  operator: nip19.npubEncode(s.operator),
})

function toHex(input: string): string | null {
  const v = input.trim()
  if (!v) return null
  if (/^[0-9a-f]{64}$/i.test(v)) return v.toLowerCase()
  const d = nip19.decode(v)
  if (d.type === 'npub') return d.data
  throw new Error('Operator must be an npub or 64-char hex pubkey')
}

export function Settings({ snap, me, onChange }: { snap: Snapshot; me?: string; onChange: (s: Snapshot) => void }) {
  // Seeded once: the 5 s live refresh must not clobber half-typed input.
  const [form, setForm] = useState<Form>(() => fromSnap(snap))
  const [busy, setBusy] = useState('')
  const [dirty, setDirty] = useState(false)
  const [restartArmed, setRestartArmed] = useState(false)

  useEffect(() => { if (!dirty) setForm(fromSnap(snap)) }, [snap, dirty])
  useEffect(() => {
    if (!restartArmed) return
    const t = setTimeout(() => setRestartArmed(false), 4000)
    return () => clearTimeout(t)
  }, [restartArmed])

  const set = (k: keyof Form) => (e: Event) => {
    setDirty(true)
    setForm((f) => ({ ...f, [k]: (e.target as HTMLInputElement).value }))
  }

  const adminProfiles = useProfiles(snap.admins)
  const patchAdmins = async (admins: string[], ok: string, key: string) => {
    setBusy(key)
    try {
      const { state } = await api.patch({ admins })
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

  const relaysChanged = lines(form.relays).join('\n') !== snap.relays.join('\n')

  const save = async (e: Event) => {
    e.preventDefault()
    let operatorPubkey: string | null
    try { operatorPubkey = toHex(form.operator) } catch (err) { toast.err((err as Error).message); return }
    if (operatorPubkey && operatorPubkey !== snap.operator &&
        !confirm(`Hand operator rights to ${shortNpub(operatorPubkey)}? You'll be locked out unless you control that key.`)) return
    const minutes = Number(form.maxCallMinutes)
    if (!Number.isFinite(minutes) || minutes < 0 || minutes > 1440) { toast.err('Call cap must be 0–1440 minutes'); return }
    setBusy('save')
    try {
      const { state } = await api.patch({
        relays: lines(form.relays),
        publicUrl: form.publicUrl.trim() || null,
        region: form.region.trim() || null,
        maxCallDurationSeconds: Math.floor(minutes * 60),
        operatorPubkey,
      })
      setDirty(false)
      onChange(state)
      toast.ok(relaysChanged ? 'Saved — restart the SFU to apply relay changes' : 'Saved')
    } catch (err) {
      toast.err((err as Error).message)
    } finally {
      setBusy('')
    }
  }

  const restart = async () => {
    if (!restartArmed) { setRestartArmed(true); return }
    setBusy('restart')
    try {
      await api.restart()
      toast.ok('Restarting — reconnecting in a few seconds…')
      setTimeout(() => window.location.reload(), 4000)
    } catch (err) {
      toast.err((err as Error).message)
      setBusy('')
    }
  }

  const field = (label: string, k: keyof Form, props: Record<string, unknown> = {}, hint?: preact.ComponentChildren) => (
    <label class="block">
      <span class="text-xs text-lc-muted block mb-1">{label}</span>
      <input class="lc-input" value={form[k]} onInput={set(k)} {...props} />
      {hint && <span class="text-[11px] text-lc-muted/80 block mt-1">{hint}</span>}
    </label>
  )

  return (
    <div>
      <form onSubmit={save}>
        <Section title="Network">
          <div class="grid gap-4 md:grid-cols-2">
            <label class="block md:col-span-2">
              <span class="text-xs text-lc-muted block mb-1">Listening relays (one per line, wss://)</span>
              <textarea class="lc-input font-mono text-xs h-24 resize-y" value={form.relays} onInput={set('relays')} />
              {relaysChanged && <span class="text-[11px] text-yellow-300 block mt-1">Relay changes take effect after a restart.</span>}
            </label>
            {field('Public URL (advertised in kind 31313)', 'publicUrl', { placeholder: 'https://sfu.example.com' })}
            {field('Region hint', 'region', { placeholder: 'eu-central' })}
          </div>
        </Section>

        <Section title="Calls">
          <div class="max-w-xs">
            {field('Max call duration (minutes, 0 = no cap)', 'maxCallMinutes', { type: 'number', min: 0, max: 1440, step: 5 },
              'Every room auto-closes after this long. Applies to calls already in progress.')}
          </div>
        </Section>

        <Section title="Operator">
          {field('Operator key (npub or hex)', 'operator', { class: 'lc-input font-mono text-xs' },
            <span class="text-yellow-300">⚠ Changing this locks you out unless you control the new key.</span>)}
        </Section>

        <div class="flex flex-wrap items-center gap-3 mb-6">
          <button class="lc-pill-primary" disabled={!!busy || !dirty}>
            {busy === 'save' ? <span class="lc-spinner !w-4 !h-4" /> : dirty ? 'Save changes' : 'Saved'}
          </button>
          {dirty && (
            <button type="button" class="lc-pill-secondary" onClick={() => { setDirty(false); setForm(fromSnap(snap)) }}>Discard</button>
          )}
          <button type="button" class="lc-pill-danger ml-auto" disabled={busy === 'restart'} onClick={restart}>
            {busy === 'restart' ? 'Restarting…' : restartArmed ? 'Click again — active calls will drop' : 'Restart SFU'}
          </button>
        </div>
      </form>

      <PeoplePanel
        title="Admins"
        subtitle="Can sign in to this console with full access, alongside the operator. Applies immediately."
        field="admins"
        list={snap.admins}
        profiles={adminProfiles}
        busy={busy}
        onAdd={async (pk) => {
          if (pk === snap.operator) { toast.ok('That key is already the operator'); return true }
          return patchAdmins([...snap.admins, pk], 'Admin added', 'add-admins')
        }}
        onRemove={(pk) => patchAdmins(snap.admins.filter((x) => x !== pk), 'Admin removed', 'remove-admins')}
        removeConfirm={(pk, name) => pk === me
          ? `Remove yourself (${name}) as admin? You'll be signed out of this console.`
          : `Remove ${name} as admin?`}
      />
    </div>
  )
}
