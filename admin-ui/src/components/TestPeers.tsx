// Synthetic ffmpeg-driven callers. SFU mode injects media into a mediasoup
// room; mesh mode joins a regular voice channel over P2P signaling. Known
// channels pick their engine automatically (server-side).
import { useEffect, useState } from 'preact/hooks'
import { api, Snapshot } from '../api'
import { toast } from './toast'
import { Section, age, shortNpub } from './ui'

export function TestPeers({ snap, onChange }: { snap: Snapshot; onChange: () => void }) {
  const [channel, setChannel] = useState(() => sessionStorage.getItem('sfu-test-target') ?? '')
  const [mode, setMode] = useState<'sfu' | 'mesh'>('sfu')
  const [relays, setRelays] = useState('')
  const [busy, setBusy] = useState('')

  useEffect(() => { sessionStorage.removeItem('sfu-test-target') }, [])

  if (snap.testPeers === null) {
    return <Section title="Test peers"><p class="text-sm text-lc-muted">The test-peer spawner isn't enabled on this SFU.</p></Section>
  }

  const known = snap.voiceChannels.find((c) => c.id === channel.trim().toLowerCase())
  const effectiveMode = known ? (known.kind === 'voice' ? 'mesh' : 'sfu') : mode

  const spawn = async (e: Event) => {
    e.preventDefault()
    const input = channel.trim()
    if (!input) return
    setBusy('spawn')
    try {
      const list = relays.split(/[\s,]+/).map((x) => x.trim()).filter(Boolean)
      // The server also accepts Obelisk channel links and extracts the id.
      const isHex = /^[0-9a-f]{8,64}$/i.test(input)
      const info = await api.spawnTestPeer({
        ...(isHex ? { channelId: input.toLowerCase() } : { channelUrl: input }),
        mode,
        ...(list.length ? { relays: list } : {}),
      })
      toast.ok(`Spawned ${info.peerId}`)
      onChange()
    } catch (err) {
      toast.err((err as Error).message)
    } finally {
      setBusy('')
    }
  }

  const stop = async (peerId: string) => {
    setBusy(peerId)
    try {
      await api.stopTestPeer(peerId)
      toast.ok('Test peer stopped')
      onChange()
    } catch (err) {
      toast.err((err as Error).message)
    } finally {
      setBusy('')
    }
  }

  return (
    <div>
      <div class="grid lg:grid-cols-[1.1fr_1fr] gap-6 items-start">
        <Section title="Spawn a test peer">
          <form class="space-y-4" onSubmit={spawn}>
            {snap.voiceChannels.length > 0 && (
              <div>
                <span class="text-xs text-lc-muted block mb-1.5">Known voice channels</span>
                <div class="flex flex-wrap gap-1.5 max-h-40 overflow-y-auto">
                  {snap.voiceChannels.map((c) => (
                    <button type="button" key={c.id}
                      class={`lc-chip text-xs hover:!border-lc-olive ${channel === c.id ? '!border-lc-green !text-lc-green' : ''}`}
                      onClick={() => setChannel(c.id)} title={c.about ?? c.id}>
                      {c.kind === 'voice-sfu' ? '◉' : '◌'} {c.name ?? c.id.slice(0, 10)}
                    </button>
                  ))}
                </div>
              </div>
            )}
            <label class="block">
              <span class="text-xs text-lc-muted block mb-1">Channel id or Obelisk link</span>
              <input class="lc-input font-mono text-xs" placeholder="abc123… or https://obelisk.ar/…" value={channel}
                onInput={(e) => setChannel((e.target as HTMLInputElement).value)} />
              {known && (
                <span class="text-[11px] text-lc-green block mt-1">
                  {known.name ?? 'Known channel'} — {known.kind === 'voice-sfu' ? 'SFU channel → mediasoup peer' : 'mesh channel → P2P peer'}
                </span>
              )}
            </label>
            <div>
              <span class="text-xs text-lc-muted block mb-1">Engine {known && <span class="text-lc-muted/70">(picked from the channel)</span>}</span>
              <div class={`lc-seg max-w-xs ${known ? 'opacity-50 pointer-events-none' : ''}`}>
                <button type="button" class={effectiveMode === 'sfu' ? 'active' : ''} onClick={() => setMode('sfu')}>SFU mediasoup</button>
                <button type="button" class={effectiveMode === 'mesh' ? 'active' : ''} onClick={() => setMode('mesh')}>Mesh P2P</button>
              </div>
            </div>
            <label class="block">
              <span class="text-xs text-lc-muted block mb-1">Relays (optional — defaults to the SFU's)</span>
              <textarea class="lc-input font-mono text-xs h-16 resize-y" placeholder={snap.relays.join('\n')} value={relays}
                onInput={(e) => setRelays((e.target as HTMLTextAreaElement).value)} />
              <span class="text-[11px] text-lc-muted/80 block mt-1">
                SFU mode publishes a kind 25052 <code>start</code> + kind 20078 beacon; mesh mode publishes kind 20078 beacons and kind 25050 SDP/ICE.
              </span>
            </label>
            <button class="lc-pill-primary" disabled={busy === 'spawn' || !channel.trim()}>
              {busy === 'spawn' ? <span class="lc-spinner !w-4 !h-4" /> : 'Spawn test peer'}
            </button>
          </form>
        </Section>

        <Section title="Running" actions={<span class="lc-tag">{snap.testPeers.length}</span>}>
          {snap.testPeers.length === 0 ? (
            <p class="text-sm text-lc-muted py-4 text-center">No test peers running.</p>
          ) : (
            <div class="space-y-2">
              {snap.testPeers.map((p) => {
                const ch = snap.voiceChannels.find((c) => c.id === p.channelId)
                return (
                  <div key={p.peerId} class="rounded-xl border border-lc-border bg-lc-black/60 p-3">
                    <div class="flex items-center gap-2">
                      <span class="lc-dot lc-dot-online !w-2 !h-2" />
                      <span class="font-mono text-xs truncate flex-1">{p.peerId}</span>
                      <span class="lc-tag">{p.mode}</span>
                      <button class="lc-pill-danger text-xs !px-3 !py-1" disabled={busy === p.peerId} onClick={() => stop(p.peerId)}>
                        {busy === p.peerId ? '…' : 'Stop'}
                      </button>
                    </div>
                    <div class="text-[11px] text-lc-muted mt-1.5 space-y-0.5">
                      <div>channel <span class="text-lc-white">{ch?.name ?? `${p.channelId.slice(0, 12)}…`}</span> · pid {p.pid ?? '—'} · {age(p.startedAt)} ago</div>
                      <div>identity {p.identityMode} · {shortNpub(p.pubkey)}</div>
                      <div class="font-mono truncate">{p.relays.join(' · ') || '—'}</div>
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </Section>
      </div>
    </div>
  )
}
