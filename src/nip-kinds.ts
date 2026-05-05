/**
 * Single source of truth for the Nostr event kinds the SFU consumes and
 * publishes. Mirrors the obelisk-dex `src/lib/nip-kinds.ts` for shared
 * kinds; documents the new SFU-specific ones.
 *
 * See docs/sfu-system.md §3 for the full event spec.
 */

// ── Reused mesh-voice kinds ──────────────────────────────────────────────────
//
// The SFU publishes kind 20078 beacons (with an extra `["sfu","1"]` tag) and
// exchanges kind 25050 SDP/ICE/track-info with each peer — same wire as
// obelisk-dex/src/lib/voice/transport.ts.

/** NIP-29 — group metadata (mirror; we don't publish this). */
export const KIND_NIP29_GROUP_METADATA = 39000;
/** NIP-29 — group admin list. We subscribe per channel. */
export const KIND_NIP29_GROUP_ADMINS = 39001;
/** NIP-29 — group member list. We subscribe per channel. */
export const KIND_NIP29_GROUP_MEMBERS = 39002;

/** Mesh — presence beacon. SFU publishes its own with `["sfu","1"]`. */
export const KIND_VOICE_PRESENCE = 20078;
/** Mesh — directed signaling (offer/answer/ICE/trackinfo/qualityhint). */
export const KIND_VOICE_SIGNAL = 25050;

// ── New SFU kinds ────────────────────────────────────────────────────────────

/**
 * SFU advertisement — parameterized replaceable on `d="obelisk-sfu"`.
 * Published once on boot and on config change. Lists the SFU's URL,
 * capacities, supported codecs, and the operator-managed allow-list of
 * pubkeys authorized to start calls.
 */
export const KIND_SFU_ADVERTISEMENT = 31313;

/**
 * SFU active-call state — parameterized replaceable on `d="<channelId>"`.
 * Published when the SFU accepts a call, refreshed every 60 s with NIP-40
 * `expiration=now+90`, replaced on call end with `["status","closed"]`.
 * Clients use this to detect SFU mode for a channel and route signaling.
 */
export const KIND_SFU_ACTIVE_CALL = 31314;

/**
 * SFU control event — ephemeral, signed by the user, addressed via
 * `["p", SFU_PUBKEY]`. Carries `{ action, params }` in JSON content.
 * Actions: `start`, `end`, `kick`, `update`. See docs/sfu-system.md §3.2.
 */
export const KIND_SFU_CONTROL = 25052;
