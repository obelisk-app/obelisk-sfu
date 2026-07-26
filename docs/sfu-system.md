# Obelisk SFU — current architecture

Obelisk SFU is an operator-run mediasoup service for `voice-sfu` channels.
The browser authenticates directly to the selected SFU with its Nostr identity,
then exchanges mediasoup RPC over WebSocket. Nostr remains the channel pin,
discovery, status, and compatibility layer; media never passes through a Nostr
relay or the Cloudflare HTTP tunnel.

## Data paths

| Path | Transport | Purpose |
|---|---|---|
| Channel selection | NIP-78 kind 30078 | Channel admin pins one SFU URL. |
| Service descriptor | HTTPS `GET /info` | Returns SFU pubkey, operator, capacity, region, and fallback relays. |
| Authentication + RPC | `wss://<sfu>/rpc?channelId=<id>` | Signed identity check and mediasoup request/response/notifications. |
| Media | WebRTC ICE/DTLS/SRTP | Browser ↔ mediasoup UDP/TCP transport. |
| Discovery/status | kinds 31313 / 31314 | Optional SFU discovery and active-room status. |
| Compatibility | kinds 25052 / 25050 | Start and RPC fallback for older clients/SFUs. |

The direct WebSocket removes ephemeral mediasoup control traffic from relays.
It does not remove Nostr identity or the signed channel pin.

## URL-only channel pin

Channel settings ask for one value:

```text
https://sfu.example.com
```

Before publishing, the dex fetches `/info` and requires:

- `service === "obelisk-sfu"`;
- a valid 64-character hex `pubkey`;
- an advertised URL with the same origin;
- public `wss://` relay URLs when compatibility fallback is advertised.

The kind 30078 document stores the verified snapshot:

```json
{
  "pubkey": "<verified-sfu-pubkey>",
  "url": "https://sfu.example.com",
  "trustedRelays": ["wss://trusted.example.com"],
  "relays": ["wss://public.example.com"]
}
```

Admins never type the pubkey or relay lists. The UI displays the full verified
pubkey for advanced out-of-band comparison. Existing three-field pins remain
readable.

Resolution order in the dex is:

1. per-channel kind 30078 URL pin;
2. build-time `NEXT_PUBLIC_SFU_*` fallback;
3. signed kind 31313 discovery.

A `voice-sfu` channel never silently changes into a mesh room when its SFU
is unavailable.

## Direct WebSocket authentication

The server sends:

```json
{
  "type": "auth",
  "kind": 22242,
  "challenge": "<random>",
  "relay": "wss://sfu.example.com/rpc?channelId=<id>",
  "channelId": "<id>"
}
```

The browser signs kind 22242 with `challenge`, `e` (channel), and `relay`
tags and returns the event plus a per-device `clientId`. The SFU verifies the
signature, freshness, challenge, channel, endpoint, and local allow-list before
opening or joining the room.

Close code 4403 is an explicit authorization failure and is shown to the user;
it is not hidden by a relay fallback. Network failure or an older SFU without
`/rpc` may use the existing kind 25050 compatibility transport.

## Authorization

Direct RPC accepts callers that satisfy one of:

- SFU operator pubkey;
- `allow.json` pubkey;
- a pubkey derived from configured trusted-referent follows;
- an active temporary/operator bypass.

Trusted-author relay authorization exists only for the legacy kind 25052
control path. Direct RPC deliberately asks the SFU itself, so the answer is
immediate and independent of relay delivery.

## Public endpoints

| Endpoint | Access | Response |
|---|---|---|
| `/info` | public, CORS-enabled | Identity, URL, relays, capacity, operator, region. |
| `/healthz` | public | Health/degraded status. |
| `/channels` | public | Sanitized registered voice channels. |
| `/channels/resolve` | public | Resolves channel kind and test-peer mode. |
| `/rooms` | public | Sanitized room counts; no participant pubkeys. |
| `/admin` | operator | NIP-98 protected operator UI/API. |
| `/rpc` | signed caller | WebSocket mediasoup RPC. |

## Media engine and dependencies

Production is mediasoup-only and requires Node 22+. The server uses current
registry releases from their upstream repositories:

- `mediasoup` — production WebRTC SFU worker/router;
- `nostr-tools` and `@noble/hashes` — signed Nostr identity and events;
- `dotenv` — environment loading.

Werift is a development dependency used only by synthetic legacy/mesh test
peers. It is not imported by the production room manager. Release verification
must include `npm audit --omit=dev`, `npm run typecheck`, `npm test`, and
`npm run build`.

## Operational requirements

- Public HTTPS/WSS hostname for `/info` and `/rpc`.
- Public IP (or 1:1 NAT) for mediasoup ICE candidates.
- Configured RTP UDP range open inbound (default documented in `.env.example`).
- At least one healthy Nostr relay for channel discovery/status compatibility.
- Explicit callers in `allow.json` or the trusted-referent follow set.

The Cloudflare tunnel carries HTTPS/WebSocket RPC, not SRTP media. Browser
media remains encrypted with DTLS-SRTP to the mediasoup endpoint.
