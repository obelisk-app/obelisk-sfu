// Client for the SFU admin API. After sign-in the HttpOnly session cookie
// authenticates every call (see src/admin-session.ts on the server).

export type Hex = string

export interface RelayHealth {
  url: string
  role: 'write' | 'read'
  access: 'ok' | 'denied' | 'closed' | 'unknown'
  accessDetail: string | null
  lastPublishOk: number | null
  lastPublishErr: number | null
  lastPublishErrMsg: string | null
  lastSubscribeClose: number | null
  lastEventAt: number | null
  subscribed: boolean
}

export interface ActiveRoom {
  channelId: string
  channelKind: string
  status: string
  participants: number
  host: Hex | null
  startedAt: number
}

export interface VoiceChannel {
  id: string
  kind: 'voice' | 'voice-sfu' | string
  name: string | null
  about: string | null
  isPublic: boolean
  isOpen: boolean
  relays: string[]
}

export interface TestPeer {
  peerId: string
  channelId: string
  mode: 'sfu' | 'mesh'
  pubkey: Hex
  pid: number | null
  startedAt: number
  relays: string[]
  identityMode: 'ephemeral' | 'sfu'
}

export interface Snapshot {
  pubkey: Hex
  operator: Hex
  relays: string[]
  trustedAuthorRelays: string[]
  allowed: Hex[]
  trustedReferentPubkeys: Hex[]
  followAllowedCount: number
  whitelistBypassUntil: number | null
  allowAll: boolean
  requireAllowedPubkey: boolean
  publicUrl: string | null
  region: string | null
  maxRooms: number
  maxParticipantsPerRoom: number
  maxCallDurationSeconds: number
  engine: string
  bootedAt: number
  activeRooms: ActiveRoom[]
  channelRegistry: {
    subscribed: boolean
    relays: number
    totalChannels: number
    voiceChannels: number
    meshVoiceChannels: number
    sfuVoiceChannels: number
  }
  voiceChannels: VoiceChannel[]
  relayHealth: RelayHealth[]
  advertiser: { sessionId: string; bootedAt: number; lastPublishAt: number | null; lastPublishErrAt: number | null } | null
  testPeers: TestPeer[] | null
}

export interface Session { authed: boolean; pubkey?: Hex }

export class UnauthorizedError extends Error {}

async function req<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(path, {
    credentials: 'same-origin',
    ...init,
    headers: { ...(init.body ? { 'content-type': 'application/json' } : {}), ...(init.headers ?? {}) },
  })
  const text = await res.text()
  let body: { error?: string } & Record<string, unknown>
  try { body = JSON.parse(text) } catch { body = { error: text } }
  if (res.status === 401) throw new UnauthorizedError(body.error ?? 'session expired')
  if (!res.ok) throw new Error(`${res.status} ${body.error ?? 'request failed'}`)
  return body as T
}

export const api = {
  session: () => req<Session>('/admin/session'),
  /** One NIP-98 signature (Authorization header) → session cookie. */
  login: (authorization: string) =>
    req<Session>('/admin/session', { method: 'POST', headers: { authorization } }),
  logout: () => req<{ ok: boolean }>('/admin/session', { method: 'DELETE' }),

  state: () => req<Snapshot>('/admin/state'),
  patch: (patch: Record<string, unknown>) =>
    req<{ ok: boolean; state: Snapshot }>('/admin/state', { method: 'PUT', body: JSON.stringify(patch) }),
  restart: () => req<{ ok: boolean }>('/admin/restart', { method: 'POST' }),
  syncFollows: () => req<{ derived?: number }>('/admin/sync-follows', { method: 'POST' }),
  /** `channelUrl` may be an Obelisk channel link — the SFU extracts the id. */
  spawnTestPeer: (body: { channelId?: string; channelUrl?: string; mode: 'sfu' | 'mesh'; relays?: string[] }) =>
    req<TestPeer>('/admin/test-peer/spawn', { method: 'POST', body: JSON.stringify(body) }),
  stopTestPeer: (peerId: string) =>
    req<{ ok: boolean }>('/admin/test-peer/stop', { method: 'POST', body: JSON.stringify({ peerId }) }),
}
