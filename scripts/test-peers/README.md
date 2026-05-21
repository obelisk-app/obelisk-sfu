# SFU test peers

Synthetic Nostr clients used to smoke-test Obelisk voice end-to-end without
needing two real browsers. They live alongside the SFU server in this repo
(`scripts/test-peers/`) and can be invoked manually OR spawned via the SFU
admin UI (Identity -> "Spawn test peer" button on an active room).

| Script | Engine | What it does |
|---|---|---|
| `test-peer-ms.mjs` | mediasoup | Publishes kind 25052 `start`, then drives a `PlainTransport` via `POST /test/inject` + ffmpeg. |
| `test-peer.mjs` | werift | Legacy: full SDP/ICE over kind 25050. Use only against the old werift SFU engine. |
| `test-peer-mesh.mjs` | mesh P2P | Joins a regular mesh voice channel as a browser-compatible peer. It reuses the ffmpeg test pattern + sine-tone media path, publishes kind 20078 beacons, and exchanges kind 25050 SDP/ICE directly with channel peers. |
| `start-call.mjs` | n/a | Authors a kind 25052 `start` once and exits - handy for poking the SFU manually. |

Each script keeps a persistent keypair under `scripts/.test-peer*/identity.json`
so the dex remembers the bot between restarts. Set `TEST_PEER_NSEC_HEX=<hex>`
to override the on-disk identity for a single run. The admin UI uses this to
give every spawn a unique pubkey without polluting the on-disk state.

## Run manually

```bash
# mediasoup peer (current default SFU engine)
npm run test-peer:sfu -- <channel-id-hex>

# mesh P2P peer (regular voice channel, no SFU)
npm run test-peer:mesh -- <channel-id-hex>
```

Required env when the SFU kind 31313 advertisement is not reachable
(for example NIP-29-only relays do not store it):

```bash
SFU_PUBKEY=<sfu hex pubkey> SFU_URL=https://sfu.obelisk.ar TEST_PEER_RELAYS=wss://relay.obelisk.ar npm run test-peer:sfu -- <channel-id>
```

Mesh peers only need relay access and TURN settings:

```bash
TEST_PEER_RELAYS=wss://relay.obelisk.ar TEST_PEER_FORCE_RELAY=1 npm run test-peer:mesh -- <channel-id>
```

For auth-gated relays, the peer pubkey must be whitelisted on the relay it
publishes/subscribes through. The scripts sign NIP-42 AUTH automatically.

## Spawn from the admin UI

The SFU admin UI (`/admin`) has a **Spawn test peer** form. Operators choose
`SFU mediasoup` or `Mesh P2P`, enter a channel id, and optionally override
relays for that spawn. The server forks the matching script with
`TEST_PEER_NSEC_HEX` pre-set to a freshly-generated key. Multiple spawns
produce distinct test peers; each appears as its own tile in the dex.

`POST /admin/test-peer/spawn`, `POST /admin/test-peer/stop`, and
`GET /admin/test-peers` are NIP-98-authed admin endpoints behind the same
operator gate as the rest of `/admin/*`.

## Wire protocol

See `docs/sfu-system.md` in the dex repo for the kind 25050 RPC envelope,
kind 25052 control events, and kind 31313 advertisements. Mesh beacon
semantics live in `docs/voice/mesh-protocol.md` in the dex repo.

Mesh test peers publish kind 20078 with both diagnostic markers:

- `["client", "obelisk-mesh-test-peer"]`
- `["test-peer", "mesh"]`

The dex treats these markers as an admin-only diagnostic bypass of the NIP-29
member gate, not as SFU discovery. Regular channel members still apply the
normal member/admin/open-room gate.
