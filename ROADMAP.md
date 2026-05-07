# ROADMAP — Obelisk SFU

mediasoup-based selective forwarding unit for the Obelisk voice/video
stack. Nostr-RPC signaling on kind 25050; presence + active-call status
on kinds 31313 / 20078 / 31314. Companion roadmaps live in
`obelisk-app/obelisk` (dex) and `obelisk-app/obelisk-relay`.

## ✅ Shipped

- mediasoup engine boot + 4-worker pool.
- kind 25052 control event listener with two-layer auth (trusted-relay
  + local allow.json).
- Nostr-RPC dispatcher: `getRouterRtpCapabilities`, `createWebRtcTransport`,
  `connectWebRtcTransport`, `produce`, `consume`, `resumeConsumer`,
  `closeProducer`, `leave`.
- Periodic presence beacons (kind 20078) + active-call announcement
  (kind 31314).
- Synthetic test peer spawner — admin GUI `/admin → "Spawn test peer"`
  drives a real ffmpeg-encoded media flow against the room for
  end-to-end smoke tests.
- Admin GUI for runtime allow-list and SFU config.
- Cloudflare-tunnel reverse proxy at `sfu.obelisk.ar`.
- **Multi-device support.** RPC envelopes carry an optional `clientId`;
  the SFU keys peers by `peerKey(pubkey, clientId)` instead of pubkey
  alone, so two devices sharing one Nostr pubkey get distinct slots.
  Notifications still routed by pubkey (both devices receive). Cap
  counts by distinct pubkey, not distinct device.
- **Keyframe heartbeat** — every video consumer requests an I-frame
  every 8s as a packet-loss recovery backstop (mediasoup's natural
  keyframe interval can stretch to 30s+, so a Wi-Fi roam used to leave
  receivers frozen on a stale frame for that whole window).

## 🛡️ Reliability

- [ ] **Producer-side health monitor.** Watch `producer.score` /
  `getStats()` for stalled tracks; ping the producer via PLI when
  consumer count is high but bytes-out is dropping.
- [ ] **Consumer-bandwidth-aware keyframe cadence.** 8s is a blanket
  heartbeat; a healthy connection doesn't need it. Drive cadence off
  observed loss / NACK rate so we only burn extra bandwidth on flaky
  links.
- [ ] **Per-call SFU pinning over kind 30078.** Channel admins pin
  `{pubkey, url, trustedRelays}` per channel. Document the contract,
  add a per-channel admin UI in the dex, expose a /pins endpoint on
  the SFU itself for self-introspection.
- [ ] **Graceful-degrade on worker death.** `mediasoup worker died`
  currently exits the Node process and waits for PM2 to restart. Catch
  the death event, migrate active rooms to a healthy worker if any
  remain, only exit if all four are dead.
- [ ] **Connection-quality reporting back to clients.** Forward
  per-consumer `score` updates as `consumerScore` notifications so the
  dex can show "weak signal" / "reconnecting" indicators per remote
  peer.
- [ ] **Stress test harness.** Extend `scripts/test-peers/` with an
  N-peer ramp script that spawns synthetic producers + consumers up to
  `cap` and reports drop rates. Should run nightly via cron + post
  results to a Nostr event the admin GUI displays.
- [ ] **Mediasoup version pin + upgrade path.** Document the current
  mediasoup version, the codecs configured, and the upgrade procedure
  so a security release doesn't require figuring this out from scratch.
- [ ] **TURN credential rotation.** `SFU_FORCE_RELAY=1` mode uses the
  admin's TURN server; rotate the long-term creds via runtime config
  rather than restart-required env edits.
- [ ] **Per-room bandwidth caps.** RoomRules has `maxParticipants` but
  no aggregate-bandwidth cap. Add `maxBandwidthKbps` so a runaway
  screen-share doesn't saturate the SFU's uplink for everyone else.
- [ ] **Audit log for kick / mute.** Today `kick` / admin actions go
  through `canManageRoom` but aren't persisted. Write a ring-buffer of
  recent moderation actions to `runtime.json` + expose in the admin
  GUI.
- [ ] **Synthetic peer health dashboard.** Show in `/admin` whether
  any test peers are running, which channels they're attached to, and
  their producer stats — useful for verifying a deployed SFU end-to-end
  without opening a real browser.

## 🐛 Known issues

- Mediasoup worker death triggers full process exit (see "Graceful-degrade
  on worker death"). PM2 restart heals it within a few seconds but live
  calls drop.
- Quota / rate-limit responses from the relay aren't currently routed
  back to the SFU's publish failures cleanly — they show up as generic
  errors in logs. Match upstream's `restricted:` prefix detection.
- Keyframe heartbeat costs ~5-10% extra bandwidth per video consumer on
  a healthy connection. Adaptive cadence is in the reliability list
  above.

## 📚 Docs

- Protocol spec: `docs/sfu-system.md` (in obelisk-app/obelisk repo).
- Operator deploy guide: `DEPLOY.md`.
- Admin UI tour: `docs/admin-ui.md`.

## Upstream + family

- mediasoup: <https://mediasoup.org>
- Companion: [obelisk-app/obelisk](https://github.com/obelisk-app/obelisk)
  (dex client), [obelisk-app/obelisk-relay](https://github.com/obelisk-app/obelisk-relay)
  (NIP-29 relay).
