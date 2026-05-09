/**
 * Thin wrapper over nostr-tools `SimplePool` — the SFU's only Nostr surface.
 *
 * Why not the obelisk-dex bridge? The bridge is React/browser-shaped: it
 * holds session state, manages NIP-46 bunkers, dispatches into Zustand
 * stores. The SFU just needs to publish/subscribe with one fixed local
 * key. SimplePool directly is the right altitude.
 *
 * NIP-42 AUTH is wired through `automaticallyAuth`: when a relay sends an
 * AUTH challenge, we sign a kind 22242 event with our SFU identity and
 * push it back. Required for relays like `relay.obelisk.ar` that gate
 * writes by whitelisted-pubkey-after-AUTH.
 */
import { SimplePool, type Event, type EventTemplate, type Filter, type VerifiedEvent } from 'nostr-tools';

import { createLogger } from './log.js';
import type { Identity } from './identity.js';

const log = createLogger('relay');

/**
 * Snapshot of one relay's recent activity. Timestamps are unix seconds.
 * `null` means "we haven't seen this signal yet on this relay since boot."
 */
export interface RelayHealth {
  url: string;
  /** Read- and/or write-side, mostly informational. */
  role: 'write' | 'read';
  /** Last time a publish to this relay resolved successfully. */
  lastPublishOk: number | null;
  /** Last time a publish to this relay was rejected. */
  lastPublishErr: number | null;
  /** Last error message (truncated) recorded for this relay. */
  lastPublishErrMsg: string | null;
  /** Last time a subscribed event OR EOSE was delivered from this relay. */
  lastEventAt: number | null;
}

export class RelayPool {
  private readonly pool: SimplePool;
  private closed = false;
  /**
   * Relays we both publish AND subscribe on. The SFU has write access
   * (NIP-42 AUTH-whitelisted) here.
   */
  private readonly writeRelays: string[];
  /**
   * Read-only relays — subscribed for `start` events and other inbound
   * traffic, but never published to. Trusted-author relays land here
   * when the SFU isn't whitelisted on them itself.
   */
  private readonly readOnlyRelays: string[];

  /** Per-relay last-successful-publish unix-seconds timestamp. */
  private readonly lastPublishOk = new Map<string, number>();
  /** Per-relay last-failed-publish unix-seconds timestamp. */
  private readonly lastPublishErr = new Map<string, number>();
  /** Per-relay last-failed-publish error message (truncated to 200 chars). */
  private readonly lastPublishErrMsg = new Map<string, string>();
  /**
   * Per-relay last-time-we-saw-something timestamp (an event delivery or
   * an EOSE marker, both indicate a live connection at that instant).
   * Read by the call-listener watchdog to detect silently-dead subscriptions.
   */
  private readonly lastEventAt = new Map<string, number>();

  constructor(
    relays: string[],
    private readonly identity: Identity,
    readOnlyRelays: string[] = [],
  ) {
    this.writeRelays = [...relays];
    // De-dupe in case a relay url appears in both lists.
    this.readOnlyRelays = readOnlyRelays.filter((r) => !this.writeRelays.includes(r));
    // automaticallyAuth: nostr-tools calls this for every relay URL we
    // touch. Returning a signer enables AUTH for that relay; returning
    // null means "skip AUTH for this URL". We sign every challenge — the
    // SFU has nothing to hide and the relay decides whether to accept.
    //
    // The cast is because SimplePool's exported type only `Pick`s
    // `enablePing | enableReconnect` from the wider AbstractPool options,
    // even though the runtime constructor honors `automaticallyAuth`.
    // Upstream issue, harmless in practice — see nostr-tools' AbstractSimplePool.
    this.pool = new SimplePool({
      automaticallyAuth: (relayURL: string) => {
        log.debug('AUTH signer requested', { relay: relayURL });
        return (template: EventTemplate): Promise<VerifiedEvent> => {
          const signed = this.identity.sign(template);
          log.debug('AUTH signing challenge', { relay: relayURL });
          return Promise.resolve(signed);
        };
      },
    } as ConstructorParameters<typeof SimplePool>[0]);
  }

  get pubkey(): string {
    return this.identity.pubkey;
  }

  /**
   * Sign + publish to all configured relays. Best-effort: a relay
   * rejecting one event is logged but doesn't throw.
   */
  async publish(template: EventTemplate): Promise<VerifiedEvent> {
    const event = this.identity.sign(template);
    const results = this.pool.publish(this.writeRelays, event);

    let firstAck: string | null = null;
    let firstErr: unknown = null;
    const now = Math.floor(Date.now() / 1000);
    await Promise.allSettled(
      results.map((p, i) =>
        p
          .then(() => {
            const relayUrl = this.writeRelays[i];
            if (relayUrl) {
              this.lastPublishOk.set(relayUrl, now);
              if (!firstAck) firstAck = relayUrl;
            }
          })
          .catch((err) => {
            const relayUrl = this.writeRelays[i] ?? '(unknown)';
            this.lastPublishErr.set(relayUrl, now);
            this.lastPublishErrMsg.set(relayUrl, String((err as Error)?.message ?? err).slice(0, 200));
            if (!firstErr) firstErr = err;
            log.debug('publish relay rejected', {
              relay: relayUrl,
              kind: event.kind,
              err: (err as Error)?.message,
            });
          }),
      ),
    );

    if (!firstAck) {
      log.warn('publish: all relays rejected', { kind: event.kind, err: String(firstErr) });
    } else {
      log.debug('publish ok', { kind: event.kind, ack: firstAck });
    }
    return event;
  }

  /**
   * Subscribe to a filter across all relays. Returns an `unsub` fn.
   * `subscribeMany` in nostr-tools 2.x takes a SINGLE filter — the
   * handler is called once per unique event id across all relays.
   *
   * Subscribes across BOTH writeRelays and readOnlyRelays — that's the
   * union the SFU advertises (kind 31313 lists `relay` + `trusted_relay`
   * tags) and clients may publish to either set. Without this fan-in,
   * a `start` event hitting only a trusted-author relay would be
   * invisible to anything subscribed via this method.
   */
  subscribe(
    filter: Filter,
    onEvent: (ev: Event) => void,
    onEose?: () => void,
  ): () => void {
    if (this.closed) {
      log.warn('subscribe after close — no-op');
      return () => undefined;
    }
    const allRelays = [...this.writeRelays, ...this.readOnlyRelays];
    const sub = this.pool.subscribeMany(allRelays, filter, {
      onevent: onEvent,
      onauth: this.signAuthChallenge,
      ...(onEose ? { oneose: onEose } : {}),
    });
    return () => sub.close();
  }

  /** All relays the SFU subscribes on (write + read-only). */
  get allRelays(): string[] {
    return [...this.writeRelays, ...this.readOnlyRelays];
  }

  /**
   * Sign a NIP-42 AUTH challenge with the SFU's identity. Wired into both
   * the constructor `automaticallyAuth` (publishes) and the per-call
   * `onauth` on every subscribe. nostr-tools' SimplePool routes them
   * separately, so we have to plug both holes — without the per-call
   * `onauth`, subscriptions on AUTH-required relays loop forever with
   * `Auth required` errors.
   */
  private readonly signAuthChallenge = (template: EventTemplate): Promise<VerifiedEvent> => {
    return Promise.resolve(this.identity.sign(template));
  };

  /**
   * Subscribe to a filter on each given relay separately, with the source
   * relay url passed through to the handler. Used by the call-listener so
   * it can distinguish events seen on a trusted relay (whose write-whitelist
   * authorizes the publisher) from events seen on an open relay (which need
   * the local allow.json check).
   *
   * Each relay gets its own `subscribeMany([url], …)`; an event published
   * to multiple relays will fire `onEvent` once per delivery. Callers MUST
   * dedupe by event id if they need each event handled exactly once.
   */
  subscribePerRelay(
    relays: string[],
    filter: Filter,
    onEvent: (ev: Event, sourceRelay: string) => void,
  ): () => void {
    if (this.closed) {
      log.warn('subscribePerRelay after close — no-op');
      return () => undefined;
    }
    const closers: Array<() => void> = [];
    for (const r of relays) {
      closers.push(this.subscribeOneRelay(r, filter, onEvent));
    }
    return () => {
      for (const c of closers) c();
    };
  }

  /**
   * Subscribe to a filter on exactly one relay. Used by the CallListener
   * watchdog so it can rebuild a single relay's subscription without
   * disturbing the others when that relay's stream goes silent.
   *
   * Both event deliveries and EOSE markers update {@link lastEventAt} —
   * either is evidence the underlying socket is still alive. The watchdog
   * uses this signal to decide when to resubscribe.
   *
   * Sets a baseline `lastEventAt = now` at subscribe time so the watchdog
   * doesn't immediately flag a brand-new subscription as stale during the
   * brief window before the relay's first response arrives.
   */
  subscribeOneRelay(
    url: string,
    filter: Filter,
    onEvent: (ev: Event, sourceRelay: string) => void,
  ): () => void {
    if (this.closed) {
      log.warn('subscribeOneRelay after close — no-op', { relay: url });
      return () => undefined;
    }
    this.lastEventAt.set(url, Math.floor(Date.now() / 1000));
    const sub = this.pool.subscribeMany([url], filter, {
      onevent: (ev: Event) => {
        this.lastEventAt.set(url, Math.floor(Date.now() / 1000));
        onEvent(ev, url);
      },
      oneose: () => {
        this.lastEventAt.set(url, Math.floor(Date.now() / 1000));
      },
      onauth: this.signAuthChallenge,
    });
    return () => sub.close();
  }

  /** Last-time-saw-something timestamp for a relay (unix seconds), or null. */
  getLastEventAt(url: string): number | null {
    return this.lastEventAt.get(url) ?? null;
  }

  /**
   * Update {@link lastEventAt} for a relay to "now". The CallListener
   * watchdog calls this right after issuing a resubscribe so the new
   * subscription gets a grace window before the next staleness check —
   * otherwise a still-silent relay would be flagged again on the next tick.
   */
  touchLastEventAt(url: string): void {
    this.lastEventAt.set(url, Math.floor(Date.now() / 1000));
  }

  /**
   * Snapshot of every configured relay's recent activity. Powers the
   * /admin/state relays panel and the /healthz "all-relays-down" check.
   */
  getRelayHealth(): RelayHealth[] {
    const out: RelayHealth[] = [];
    for (const url of this.writeRelays) {
      out.push({
        url,
        role: 'write',
        lastPublishOk: this.lastPublishOk.get(url) ?? null,
        lastPublishErr: this.lastPublishErr.get(url) ?? null,
        lastPublishErrMsg: this.lastPublishErrMsg.get(url) ?? null,
        lastEventAt: this.lastEventAt.get(url) ?? null,
      });
    }
    for (const url of this.readOnlyRelays) {
      out.push({
        url,
        role: 'read',
        // Read-only relays are never published to, so these stay null.
        lastPublishOk: null,
        lastPublishErr: null,
        lastPublishErrMsg: null,
        lastEventAt: this.lastEventAt.get(url) ?? null,
      });
    }
    return out;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.pool.close([...this.writeRelays, ...this.readOnlyRelays]);
    log.info('relay pool closed');
  }
}
