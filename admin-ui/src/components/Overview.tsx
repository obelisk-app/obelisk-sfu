import type { RelayHealth, Snapshot } from '../api'
import { profileName, useProfiles } from '../profiles'
import { Avatar, CopyChip, Section, Stat, age, npub, shortNpub } from './ui'

// Roll the per-relay timestamps into one status (unchanged from the old
// console so operators read it the same way):
//   ok   → recent publish OR recent inbound event (≤5 min)
//   warn → nothing fresh, but an ack within 15 min — subscription may be quiet
//   bad  → access denied/closed, publish failing, or no signal in >15 min
//   idle → read-only relay we haven't heard from yet
type RelayState = 'ok' | 'warn' | 'bad' | 'idle'
export function relayStatus(h: RelayHealth, now = Math.floor(Date.now() / 1000)): RelayState {
  if (h.access === 'denied' || h.access === 'closed') return 'bad'
  const FRESH = 5 * 60
  const STALE = 15 * 60
  const okPub = h.lastPublishOk != null && now - h.lastPublishOk <= FRESH
  const okEvt = h.lastEventAt != null && now - h.lastEventAt <= FRESH
  if (okPub || okEvt) return 'ok'
  if (h.role === 'write') {
    if (h.lastPublishOk != null && now - h.lastPublishOk <= STALE) return 'warn'
    return 'bad'
  }
  if (h.lastEventAt != null && now - h.lastEventAt > STALE) return 'bad'
  if (h.lastEventAt != null) return 'warn'
  return 'idle'
}

const STATE_STYLE: Record<RelayState, string> = {
  ok: 'bg-lc-olive-dark text-lc-green border-lc-olive',
  warn: 'bg-yellow-950/60 text-yellow-300 border-yellow-900',
  bad: 'bg-red-950/60 text-red-300 border-red-900',
  idle: 'bg-lc-black text-lc-muted border-lc-border',
}

export function Overview({ snap, onTestTarget }: { snap: Snapshot; onTestTarget: (channelId: string) => void }) {
  const profiles = useProfiles([snap.operator, snap.pubkey, ...snap.activeRooms.map((r) => r.host)])
  const op = profiles.get(snap.operator)
  const healthy = snap.relayHealth.filter((h) => relayStatus(h) === 'ok').length
  const participants = snap.activeRooms.reduce((n, r) => n + r.participants, 0)
  const adv = snap.advertiser
  const uptime = age(snap.bootedAt)

  return (
    <div>
      <p class="text-sm text-lc-muted mb-6">
        {snap.publicUrl ?? 'no public URL'} · {snap.region ?? 'no region'} · {snap.engine} engine · up {uptime}
      </p>

      <div class="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
        <Stat label="Active rooms" value={snap.activeRooms.length} hint={`of ${snap.maxRooms} max`} accent={snap.activeRooms.length > 0} />
        <Stat label="In calls" value={participants} hint={`${snap.maxParticipantsPerRoom} per room max`} />
        <Stat label="Voice channels" value={snap.channelRegistry.voiceChannels}
          hint={`${snap.channelRegistry.sfuVoiceChannels} SFU · ${snap.channelRegistry.meshVoiceChannels} mesh`} />
        <Stat label="Relays healthy" value={`${healthy}/${snap.relayHealth.length}`}
          accent={healthy === snap.relayHealth.length && healthy > 0} hint={adv?.lastPublishAt ? `advertised ${age(adv.lastPublishAt)} ago` : 'not advertised yet'} />
      </div>

      <div class="grid lg:grid-cols-[1fr_1.2fr] gap-6 items-start">
        <Section title="Identity">
          <div class="flex items-center gap-3 mb-4">
            <Avatar picture={profiles.get(snap.pubkey)?.picture} label="SFU" size={48} rounded="xl" />
            <div class="min-w-0">
              <div class="font-semibold">{profileName(profiles.get(snap.pubkey), 'SFU identity')}</div>
              <CopyChip text={npub(snap.pubkey)} label={shortNpub(snap.pubkey)} />
            </div>
          </div>
          <dl class="lc-kv">
            <dt>Operator</dt>
            <dd class="flex items-center gap-2">
              <Avatar picture={op?.picture} label={profileName(op, 'OP')} size={22} />
              <span class="truncate">{profileName(op, shortNpub(snap.operator))}</span>
            </dd>
            <dt>Public URL</dt><dd class="font-mono text-xs">{snap.publicUrl ?? '—'}</dd>
            <dt>Region</dt><dd>{snap.region ?? '—'}</dd>
            <dt>Engine</dt><dd>{snap.engine}</dd>
            <dt>Capacity</dt><dd>{snap.maxParticipantsPerRoom}/room · {snap.maxRooms} concurrent</dd>
            <dt>Call cap</dt><dd>{snap.maxCallDurationSeconds ? `${Math.round(snap.maxCallDurationSeconds / 60)} min` : 'none'}</dd>
            <dt>Advertised</dt>
            <dd class="text-xs">{adv ? `${adv.lastPublishAt ? `${age(adv.lastPublishAt)} ago` : 'never'} · session ${adv.sessionId.slice(0, 8)}` : '—'}</dd>
          </dl>
        </Section>

        <Section title="Relay health"
          subtitle="Green: recent publish or inbound event. Yellow: nothing inbound for over 5 min — the subscription may be wedging. Red: no access, publishes failing, or no sign of life.">
          {snap.relayHealth.length === 0 ? (
            <p class="text-sm text-lc-muted">No relays configured.</p>
          ) : (
            <div class="space-y-2">
              {snap.relayHealth.map((h) => {
                const st = relayStatus(h)
                const label = h.access === 'denied' ? 'NO ACCESS' : h.access === 'closed' ? 'CLOSED' : st.toUpperCase()
                return (
                  <div key={h.url + h.role} class="rounded-lg border border-lc-border bg-lc-black/60 px-3 py-2.5">
                    <div class="flex items-center gap-2 flex-wrap">
                      <span class="font-mono text-xs break-all flex-1 min-w-0">{h.url}</span>
                      <span class={`text-[10px] font-bold tracking-wider rounded-md border px-1.5 py-0.5 ${STATE_STYLE[st]}`}>{label}</span>
                      <span class="lc-tag !bg-lc-black !text-lc-muted border border-lc-border">{h.role}</span>
                    </div>
                    <div class="text-[11px] text-lc-muted mt-1">
                      event {age(h.lastEventAt)} ago · {h.subscribed ? '✓ subscribed' : '✗ not subscribed'}
                      {h.role === 'write' && ` · publish ok ${age(h.lastPublishOk)} ago`}
                      {h.lastSubscribeClose != null && ` · closed ${age(h.lastSubscribeClose)} ago`}
                    </div>
                    {h.access === 'denied' && (
                      <div class="text-[11px] text-red-300 mt-1">SFU key has no access: {h.accessDetail ?? 'relay rejected subscription/publish'}</div>
                    )}
                    {h.access === 'closed' && h.accessDetail && (
                      <div class="text-[11px] text-red-300 mt-1">Relay closed the subscription: {h.accessDetail}</div>
                    )}
                    {h.role === 'write' && h.lastPublishErrMsg && st !== 'ok' && (
                      <div class="text-[11px] text-red-300 mt-1">Last error ({age(h.lastPublishErr)} ago): {h.lastPublishErrMsg}</div>
                    )}
                  </div>
                )
              })}
            </div>
          )}
        </Section>
      </div>

      <Section title="Active rooms" subtitle="Live calls on this SFU. Rooms close automatically at the call-duration cap.">
        {snap.activeRooms.length === 0 ? (
          <div class="text-center py-8 text-sm text-lc-muted">No calls right now.</div>
        ) : (
          <div class="grid gap-3 md:grid-cols-2">
            {snap.activeRooms.map((r) => {
              const host = r.host ? profiles.get(r.host) : undefined
              const channel = snap.voiceChannels.find((c) => c.id === r.channelId)
              return (
                <div key={r.channelId} class="rounded-xl border border-lc-border bg-lc-black/60 p-4">
                  <div class="flex items-center gap-2 mb-2">
                    <span class="lc-dot lc-dot-online !w-2 !h-2" />
                    <span class="font-semibold truncate">{channel?.name ?? `${r.channelId.slice(0, 16)}…`}</span>
                    <span class="lc-tag ml-auto">{r.status}</span>
                  </div>
                  <div class="text-xs text-lc-muted flex items-center gap-2 flex-wrap">
                    <span>{r.participants} in call</span>·<span>{r.channelKind}</span>·<span>started {age(r.startedAt)} ago</span>
                  </div>
                  {r.host && (
                    <div class="flex items-center gap-2 mt-3 text-xs">
                      <Avatar picture={host?.picture} label={profileName(host, 'H')} size={22} />
                      <span class="text-lc-muted">host</span>
                      <span class="truncate">{profileName(host, shortNpub(r.host))}</span>
                    </div>
                  )}
                  {snap.testPeers !== null && (
                    <button class="lc-pill-secondary text-xs !px-3 !py-1.5 mt-3" onClick={() => onTestTarget(r.channelId)}>
                      Send a test peer here →
                    </button>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </Section>
    </div>
  )
}
