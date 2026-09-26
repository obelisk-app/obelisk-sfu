// NIP-42 helpers shared by the test peers.
//
// Obelisk relays answer a write on a not-yet-authenticated socket with
// `restricted: … not whitelisted` (not `auth-required:`), so nostr-tools'
// built-in auth-and-retry never runs, and they CLOSE a REQ sent before AUTH
// finished with `auth-required`, which nostr-tools only reopens when the
// subscription carries `onauth`. Without these helpers a test peer's beacons
// and signals silently vanish and its subscriptions go deaf.

const AUTH_ISH = /auth-required|restricted|not whitelisted|not authori[sz]ed/i;

/** Publish to every relay; on an auth-ish rejection, AUTH that socket and retry once. */
export async function publishWithAuth(pool, relays, event, signer) {
  return Promise.allSettled(pool.publish(relays, event).map((p, i) =>
    p.catch(async (err) => {
      const msg = String(err?.message ?? err);
      if (!AUTH_ISH.test(msg)) throw err;
      const relay = await pool.ensureRelay(relays[i]);
      for (let n = 0; n < 30 && !relay.challenge; n++) await new Promise((r) => setTimeout(r, 100));
      await relay.auth(signer);
      return relay.publish(event);
    })));
}

/**
 * One-filter subscription that answers AUTH, logs why it was closed, and
 * reopens with backoff (the relay may close for auth, rate limits, or a
 * dropped socket). `sinceWindow` keeps a short replay window on reopen.
 */
export function subscribeResilient(pool, relays, filter, { onevent, signer, label, sinceWindow = 30 }) {
  // One subscription per relay: a multi-relay subscription only reports
  // `onclose` once EVERY relay closed it, hiding a single deaf relay.
  const handles = relays.map((url) => {
    let closed = false;
    let delay = 1000;
    let sub = null;
    const open = () => {
      if (closed) return;
      const openedAt = Date.now();
      sub = pool.subscribe([url], { ...filter, since: Math.floor(Date.now() / 1000) - sinceWindow }, {
        onauth: signer,
        onevent,
        onclose: (reasons) => {
          if (closed) return;
          const why = [].concat(reasons ?? []).filter(Boolean)
            .map((r) => (typeof r === 'string' ? r : r?.reason ?? r?.message ?? JSON.stringify(r)))
            .join('; ') || 'closed';
          // A subscription that lived a while starts over at 1 s; one that
          // keeps closing right away backs off (1 s, 2 s, 4 s … 30 s).
          if (Date.now() - openedAt > 60_000) delay = 1000;
          const wait = delay;
          delay = Math.min(delay * 2, 30_000);
          console.warn(`[relay] ${label} on ${url} closed (${why}) — reopening in ${wait}ms`);
          setTimeout(open, wait);
        },
      });
    };
    open();
    return { close() { closed = true; try { sub?.close(); } catch { /* already closed */ } } };
  });
  return { close() { handles.forEach((h) => h.close()); } };
}
