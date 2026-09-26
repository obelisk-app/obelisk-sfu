import '@nostr-wot/ui/styles.css'
import { render } from 'preact'
import { useEffect, useState } from 'preact/hooks'
import { NostrSessionProvider } from '@nostr-wot/ui'
import './style.css'
import { api, Session } from './api'
import { Login } from './components/Login'
import { Console } from './components/Console'
import { Toasts } from './components/toast'

function App() {
  const [session, setSession] = useState<Session | null>(null)
  // After an explicit logout / expiry the login screen waits for a
  // deliberate signer choice instead of silently signing back in.
  const [loggedOut, setLoggedOut] = useState(false)

  useEffect(() => {
    api.session().then(setSession).catch(() => setSession({ authed: false }))
  }, [])

  if (session === null) {
    return <div class="min-h-screen flex items-center justify-center lc-grid-bg"><span class="lc-spinner" /></div>
  }
  if (!session.authed) return <Login onLogin={setSession} fresh={loggedOut} />
  return (
    <>
      <Toasts />
      <Console session={session} onLogout={() => { setLoggedOut(true); setSession({ authed: false }) }} />
    </>
  )
}

render(
  <NostrSessionProvider theme="la-crypta" autoRestore>
    <App />
  </NostrSessionProvider>,
  document.getElementById('app')!,
)
