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
