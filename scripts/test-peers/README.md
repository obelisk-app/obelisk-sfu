# SFU test peers

Synthetic Nostr clients used to smoke-test the Obelisk SFU end-to-end without
needing two real browsers. They live alongside the SFU server in this repo
(`scripts/test-peers/`) and can be invoked manually OR spawned via the SFU's
own admin UI (Identity → "Spawn test peer" button on an active room).

| Script              | Engine    | What it does                                                                                  |
|---------------------|-----------|-----------------------------------------------------------------------------------------------|
| `test-peer-ms.mjs`  | mediasoup | Publishes kind 25052 `start`, then drives a `PlainTransport` via `POST /test/inject` + ffmpeg |
| `test-peer.mjs`     | werift    | Legacy: full mesh-style SDP/ICE over kind 25050. Use only against the werift engine.          |
| `test-peer-mesh.mjs`| mesh P2P  | Joins the mesh as a regular peer (no SFU). Useful for mesh-only smoke tests.                  |
| `start-call.mjs`    | n/a       | Authors a kind 25052 `start` once and exits — handy for poking the SFU manually.              |

Each script keeps a persistent keypair under `scripts/.test-peer*/identity.json`
so the dex remembers the bot between restarts. Set `TEST_PEER_NSEC_HEX=<hex>`
to override the on-disk identity for a single run (the admin UI uses this to
give every spawn a unique pubkey without polluting the on-disk state).

## Run manually

```bash
# mediasoup peer (current default SFU engine)
node scripts/test-peers/test-peer-ms.mjs <channel-id-hex>
```

Required env when the SFU's kind 31313 advertisement isn't reachable
(e.g. NIP-29-only relays don't store it):

```bash
SFU_PUBKEY=<sfu hex pubkey> \
SFU_URL=https://sfu.obelisk.ar \
TEST_PEER_RELAYS=wss://relay.obelisk.ar \
node scripts/test-peers/test-peer-ms.mjs <channel-id>
```

The peer's pubkey must be whitelisted on `relay.obelisk.ar` (or whichever
trusted-author relay the SFU is configured to read from), otherwise the
relay rejects the `start` event and the SFU never spins up the room.

## Spawn from the admin UI

The SFU's admin UI (`/admin`) has a **Spawn test peer** form. Authenticated
operators enter a channel id and the SFU forks `node scripts/test-peers/
test-peer-ms.mjs` with `TEST_PEER_NSEC_HEX` pre-set to a freshly-generated
key, plus `SFU_PUBKEY` / `SFU_URL` / `TEST_PEER_RELAYS` derived from the
running configuration. Multiple spawns produce distinct test peers; each
appears as its own tile in the dex.

`POST /admin/test-peer/spawn`, `POST /admin/test-peer/stop`, and
`GET /admin/test-peers` are NIP-98-authed admin endpoints behind the same
operator gate as the rest of `/admin/*`.

## Wire protocol

See [`docs/sfu-system.md`](../../docs/sfu-system.md) for the full kind
25050 RPC envelope spec, kind 25052 control events, and kind 31313
advertisement schema.
