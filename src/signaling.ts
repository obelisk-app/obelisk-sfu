/**
 * Voice-channel transport — kind 20078 beacons + kind 25050 SDP/ICE.
 *
 * Server-side mirror of obelisk-dex/src/lib/voice/transport.ts. The wire
 * format is identical so browser peers don't need a special-case path
 * for talking to the SFU; they just see a peer with the SFU's pubkey.
 *
 * The `["sfu","1"]` tag on the SFU's beacon is the topology marker
 * clients use to detect SFU mode (see docs/sfu-system.md §3.4).
 */
import type { Event } from 'nostr-tools';

import { KIND_VOICE_PRESENCE, KIND_VOICE_SIGNAL } from './nip-kinds.js';
import { createLogger } from './log.js';
import type { RelayPool } from './relay.js';
import type { Hex, VoiceSignalPayload } from './types.js';

const log = createLogger('signaling');

const PRESENCE_TTL_SECONDS = 30;

/**
 * Publish an SFU presence beacon for a channel.
 *
 * `connectedTo` mirrors the mesh — peers we currently have live PCs to.
 * It feeds the same transitive-discovery mechanism browsers already
 * implement, so a fresh joiner whose relay drops the SFU's beacon can
 * still infer the SFU's presence from another beacon's `p` tags.
 */
export async function publishSfuBeacon(
  relay: RelayPool,
  channelId: string,
  connectedTo: readonly Hex[],
): Promise<void> {
  const expiration = Math.floor(Date.now() / 1000) + PRESENCE_TTL_SECONDS;
  const tags: string[][] = [
    ['e', channelId],
    ['t', 'obelisk-voice-presence'],
    ['expiration', String(expiration)],
    // Topology marker — the only difference between mesh and SFU beacons.
    ['sfu', '1'],
  ];
  const seen = new Set<string>();
  for (const pk of connectedTo) {
    if (!pk || seen.has(pk)) continue;
    seen.add(pk);
    tags.push(['p', pk]);
  }
  await relay.publish({
    kind: KIND_VOICE_PRESENCE,
    content: '',
    tags,
    created_at: Math.floor(Date.now() / 1000),
  });
}

/**
 * Send a directed SDP/ICE/track-info payload to one peer in a channel.
 * `payload.seq` is the per-(self,remote) sequence number; the caller
 * (Peer) increments it. We don't validate seq here — that's the receiver's
 * job, and obelisk-dex does it the same way for mesh peers.
 */
export async function sendSignal(
  relay: RelayPool,
  channelId: string,
  toPubkey: Hex,
  payload: VoiceSignalPayload,
): Promise<void> {
  await relay.publish({
    kind: KIND_VOICE_SIGNAL,
    content: JSON.stringify(payload),
    tags: [
      ['p', toPubkey],
      ['e', channelId],
      ['t', 'obelisk-voice-signal'],
    ],
    created_at: Math.floor(Date.now() / 1000),
  });
  log.debug('→ signal', {
    type: payload.type,
    to: toPubkey.slice(0, 8),
    seq: payload.seq,
    channel: channelId.slice(0, 8),
  });
}

/**
 * Subscribe to incoming kind 25050 events for a channel that are
 * addressed to the SFU. Some relays don't index `#p` for ephemeral
 * kinds, so we filter by `#e` and gate by p-tag in the handler — same
 * defensive posture as the browser transport.
 */
export function subscribeSfuSignals(
  relay: RelayPool,
  channelId: string,
  selfPubkey: Hex,
  onSignal: (fromPubkey: Hex, payload: VoiceSignalPayload) => void,
): () => void {
  const since = Math.floor(Date.now() / 1000) - 60;
  return relay.subscribe(
    {
      kinds: [KIND_VOICE_SIGNAL],
      '#e': [channelId],
      since,
    },
    (ev: Event) => {
      const targets: string[] = [];
      for (const t of ev.tags) {
        if (t[0] === 'p' && typeof t[1] === 'string') targets.push(t[1]);
      }
      if (ev.pubkey === selfPubkey) return;
      if (targets.length > 0 && !targets.includes(selfPubkey)) return;
      try {
        const payload = JSON.parse(ev.content) as VoiceSignalPayload;
        log.debug('← signal', {
          type: payload.type,
          from: ev.pubkey.slice(0, 8),
          seq: payload.seq,
          channel: channelId.slice(0, 8),
        });
        onSignal(ev.pubkey, payload);
      } catch (err) {
        log.warn('malformed signal payload', { err: (err as Error).message });
      }
    },
  );
}
