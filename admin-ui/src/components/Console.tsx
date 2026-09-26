// Operator console shell: sidebar (drawer on mobile), live /admin/state
// polling, and the four views. The session cookie authenticates polling,
// so the 5 s refresh costs no signatures; a 401 means the session expired
// and drops back to the login screen.
import { useEffect, useRef, useState } from 'preact/hooks'
import { useLogout, useSigner } from '@nostr-wot/ui'
import type { NostrSigner } from '@nostr-wot/signers'
import { api, Session, Snapshot, UnauthorizedError } from '../api'
import { clearStoredSigners } from '../auth'
import { profileName, useProfiles } from '../profiles'
import { toast } from './toast'
import { Avatar, Icon, shortNpub } from './ui'
import { Overview } from './Overview'
import { Access } from './Access'
import { Settings } from './Settings'
import { TestPeers } from './TestPeers'

type View = 'overview' | 'access' | 'settings' | 'test-peers'
const VIEWS: { id: View; label: string; icon: () => preact.JSX.Element }[] = [
  { id: 'overview', label: 'Overview', icon: Icon.overview },
  { id: 'access', label: 'Access', icon: Icon.access },
  { id: 'settings', label: 'Settings', icon: Icon.settings },
  { id: 'test-peers', label: 'Test peers', icon: Icon.test },
]
const POLL_MS = 5000

const viewFromHash = (): View => {
  const h = window.location.hash.slice(1) as View
  return VIEWS.some((v) => v.id === h) ? h : 'overview'
}

export function Console({ session, onLogout }: { session: Session; onLogout: () => void }) {
  const [snap, setSnap] = useState<Snapshot | null>(null)
  const [view, setView] = useState<View>(viewFromHash)
  const [drawer, setDrawer] = useState(false)
  const [live, setLive] = useState(true)
  const failures = useRef(0)
  const signer = useSigner() as NostrSigner | null
  const sdkLogout = useLogout()
  const profiles = useProfiles([session.pubkey])
  const me = session.pubkey ? profiles.get(session.pubkey) : undefined

  const logout = async () => {
    await api.logout().catch(() => {})
    await clearStoredSigners(signer)
    await sdkLogout().catch(() => {})
    onLogout()
  }

  const refresh = async (quiet = true) => {
    try {
      setSnap(await api.state())
      failures.current = 0
      setLive(true)
      if (!quiet) toast.ok('Refreshed')
    } catch (err) {
      if (err instanceof UnauthorizedError) {
        toast.err('Session expired — sign in again.')
        onLogout()
        return
      }
      failures.current += 1
      setLive(false)
      if (!quiet || failures.current === 3) toast.err((err as Error).message)
    }
  }

  useEffect(() => {
    refresh()
    const t = setInterval(() => { if (!document.hidden) refresh() }, POLL_MS)
    const onVisible = () => { if (!document.hidden) refresh() }
    const onHash = () => setView(viewFromHash())
    document.addEventListener('visibilitychange', onVisible)
    window.addEventListener('hashchange', onHash)
    return () => {
      clearInterval(t)
      document.removeEventListener('visibilitychange', onVisible)
      window.removeEventListener('hashchange', onHash)
    }
  }, [])

  const go = (v: View) => {
    window.location.hash = v
    setView(v)
    setDrawer(false)
  }

  const name = profileName(me, 'Operator')
  const nav = (
    <nav class="flex flex-col gap-1">
      {VIEWS.filter((v) => v.id !== 'test-peers' || snap?.testPeers !== null).map(({ id, label, icon: I }) => (
        <button key={id} class={`lc-nav-item text-left ${view === id ? 'active' : ''}`} onClick={() => go(id)}>
          <I /> {label}
        </button>
      ))}
    </nav>
  )
  const identity = (
    <div class="lc-identity">
      <Avatar picture={me?.picture} label={name} size={36} />
      <div class="min-w-0 flex-1">
        <div class="text-sm font-semibold truncate">{name}</div>
        <div class="text-[11px] text-lc-muted font-mono truncate">{me?.nip05 ?? shortNpub(session.pubkey)}</div>
      </div>
      <button class="lc-icon-btn" title="Sign out" onClick={logout}><Icon.logout /></button>
    </div>
  )
  const brand = (
    <a href="/" class="flex items-center gap-2.5 font-extrabold text-lg">
      <span class="lc-brand-mark !w-8 !h-8 !text-base !rounded-lg">◉</span>
      <span>Obelisk <span class="text-lc-green">SFU</span></span>
    </a>
  )

  return (
    <div class="min-h-screen lc-grid-bg lg:pl-64">
      <aside class="lc-sidebar hidden lg:flex">
        <div class="px-2 mb-8">{brand}</div>
        {nav}
        <div class="mt-auto space-y-3">
          <LiveBadge live={live} onRefresh={() => refresh(false)} />
          {identity}
        </div>
      </aside>

      <header class="lg:hidden sticky top-0 z-30 border-b border-lc-border bg-lc-black/85 backdrop-blur">
        <div class="h-14 px-4 flex items-center justify-between">
          {brand}
          <div class="flex items-center gap-2">
            <Avatar picture={me?.picture} label={name} size={30} />
            <button class="lc-icon-btn" aria-label="Menu" onClick={() => setDrawer(!drawer)}><Icon.menu /></button>
          </div>
        </div>
        {drawer && (
          <div class="px-4 pb-4 space-y-4 animate-fade-in-up">
            {nav}
            <LiveBadge live={live} onRefresh={() => refresh(false)} />
            {identity}
          </div>
        )}
      </header>

      <main class="max-w-6xl mx-auto px-4 sm:px-6 lg:px-10 py-8">
        {!snap ? (
          <div class="space-y-4">
            <div class="lc-card h-28 lc-skeleton" />
            <div class="lc-card h-64 lc-skeleton" />
          </div>
        ) : (
          <div class="animate-fade-in-up" key={view}>
            {view === 'overview' && <Overview snap={snap} onTestTarget={(id) => { sessionStorage.setItem('sfu-test-target', id); go('test-peers') }} />}
            {view === 'access' && <Access snap={snap} onChange={setSnap} />}
            {view === 'settings' && <Settings snap={snap} onChange={setSnap} />}
            {view === 'test-peers' && <TestPeers snap={snap} onChange={() => refresh()} />}
          </div>
        )}
      </main>
    </div>
  )
}

function LiveBadge({ live, onRefresh }: { live: boolean; onRefresh: () => void }) {
  return (
    <button class="w-full flex items-center justify-between px-3 py-2 rounded-lg border border-lc-border text-xs hover:border-lc-olive"
      title="Auto-refreshes every 5 s while this tab is visible — click to refresh now" onClick={onRefresh}>
      <span class={`flex items-center gap-2 ${live ? 'text-lc-green' : 'text-yellow-400'}`}>
        <span class={`lc-dot ${live ? 'lc-dot-online' : 'lc-dot-errored'} !w-2 !h-2`} />
        {live ? 'Live' : 'Reconnecting…'}
      </span>
      <span class="text-lc-muted flex items-center gap-1"><Icon.restart /> refresh</span>
    </button>
  )
}
