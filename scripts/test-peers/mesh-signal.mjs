export function normalizeMeshSignal(payload) {
  if (payload?.type !== 'peer' || !payload.peerSignal || typeof payload.peerSignal !== 'object') return payload;

  const signal = payload.peerSignal;
  if ((signal.type === 'offer' || signal.type === 'answer') && typeof signal.sdp === 'string') {
    return { ...payload, type: signal.type, sdp: signal.sdp };
  }
  if (signal.type === 'candidate' && signal.candidate) {
    return { ...payload, type: 'ice', candidates: [signal.candidate] };
  }
  return null;
}

function isSdp(payload) {
  if (payload.type === 'offer' || payload.type === 'answer') return true;
  const nativeType = payload.peerSignal?.type;
  return payload.type === 'peer' && (nativeType === 'offer' || nativeType === 'answer');
}

function isOffer(payload) {
  return payload.type === 'offer' || (payload.type === 'peer' && payload.peerSignal?.type === 'offer');
}

/**
 * Session binding, as the browser's `PeerSessionBinding` does it. A peer binds
 * to the remote's `sessionId` on its first SDP offer or answer; afterwards a
 * signal from another session belongs to a connection that no longer exists,
 * except an offer, which means the remote rebuilt and wants a fresh PC.
 * `targetSessionId` names the connection a signal answers, so a late signal
 * for one we replaced is dropped before it can touch the new one.
 *
 * Returns 'accept', 'drop' or 'replace'. Binds `state.remoteSessionId`.
 */
export function bindSession(state, payload) {
  if (payload.targetSessionId && payload.targetSessionId !== state.sessionId) return 'drop';
  const incoming = payload.sessionId;
  if (!incoming) return 'accept';
  if (payload.type === 'requestReset') return 'accept';
  if (payload.type === 'bye' && payload.byeReason === 'room-full') return 'accept';
  if (state.remoteSessionId == null || state.remoteSessionId === incoming) {
    // ICE, track metadata and renegotiation hints can trail in from an old
    // connection; only SDP decides which session owns this one.
    if (isSdp(payload)) state.remoteSessionId = incoming;
    return 'accept';
  }
  return isOffer(payload) ? 'replace' : 'drop';
}

function hasTag(ev, name, value) {
  return ev.tags.some((t) => t[0] === name && t[1] === value);
}

/**
 * Parse a kind 20078 presence beacon the way the browser's roster does.
 * Only the publisher and its `p` tags (live connections) are participants:
 * `peer` tags are second-hand and re-gossiping them kept departed peers alive.
 * A `status: left|closed` beacon is terminal even if its expiration is ahead.
 */
export function parsePresenceBeacon(ev, { channelId, ttlSeconds, nowSeconds = Math.floor(Date.now() / 1000) }) {
  if (!hasTag(ev, 'e', channelId)) return null;
  if (!hasTag(ev, 't', 'obelisk-voice-presence')) return null;
  const expirationTag = ev.tags.find((t) => t[0] === 'expiration')?.[1];
  const expiresAt = expirationTag ? parseInt(expirationTag, 10) : ev.created_at + ttlSeconds;
  if (!Number.isFinite(expiresAt)) return null;
  const status = ev.tags.find((t) => t[0] === 'status')?.[1];
  const terminal = status === 'left' || status === 'closed' || expiresAt <= nowSeconds;
  const connectedTo = Array.from(new Set(ev.tags
    .filter((t) => t[0] === 'p' && typeof t[1] === 'string' && t[1] && t[1] !== ev.pubkey)
    .map((t) => t[1])));
  return {
    createdAt: ev.created_at,
    expiresAt: terminal ? Math.min(expiresAt, nowSeconds) : expiresAt,
    terminal,
    connectedTo,
    isSfu: hasTag(ev, 'sfu', '1'),
    isMeshTestPeer: hasTag(ev, 'client', 'obelisk-mesh-test-peer') || hasTag(ev, 'test-peer', 'mesh'),
  };
}

/** Newest wins; at an equal `created_at` only a terminal beacon replaces. */
export function supersedes(prev, next) {
  if (!prev) return true;
  if (prev.createdAt > next.createdAt) return false;
  return prev.createdAt < next.createdAt || next.terminal;
}
