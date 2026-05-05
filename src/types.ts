/**
 * Shared types for the SFU service. Keep wire-level types aligned with
 * obelisk-dex/src/lib/voice/types.ts so the SFU and browser clients
 * speak the same language on kind 25050.
 */

// Hex-encoded 32-byte pubkey/secret. We don't typebrand these — the cost
// outweighs the benefit at this scale, and verifyEvent enforces validity
// at parse time anyway.
export type Hex = string;

export type VoiceTrackKind = 'audio' | 'camera' | 'screen' | 'screen-audio';

export type VoiceSignalType =
  | 'offer'
  | 'answer'
  | 'ice'
  | 'bye'
  | 'trackinfo'
  | 'qualityhint'
  | 'requestReset';

export interface VoiceQualityHint {
  maxHeight: number | null;
  maxFramerate: number | null;
  maxBitrate: number | null;
}

export interface VoiceSignalPayload {
  type: VoiceSignalType;
  sdp?: string;
  /**
   * Browser-compatible ICE candidate init shape. The browser's
   * `candidate.toJSON()` produces this; werift's does too (modulo
   * `null` vs `undefined` for absent fields — we accept both so the
   * SFU can forward whatever werift emits without re-shaping).
   */
  candidates?: Array<{
    candidate?: string;
    sdpMid?: string | null | undefined;
    sdpMLineIndex?: number | null | undefined;
    usernameFragment?: string | null | undefined;
  }>;
  /**
   * `originPubkey` is the SFU-only addition to the mesh trackInfo: when the
   * SFU forwards member A's track to member B, B's UI needs to know the
   * track originated from A. Mesh clients omit this field; the SFU sets it
   * on every forwarded track. Receivers use `originPubkey ?? remotePubkey`.
   */
  trackInfo?: {
    trackId: string;
    kind: VoiceTrackKind;
    originPubkey?: Hex;
  };
  qualityHint?: VoiceQualityHint;
  sessionId: string;
  seq: number;
}

// ── SFU control event payloads ───────────────────────────────────────────────

export interface RoomRules {
  /** Permit camera tracks at all? Default true. */
  video: boolean;
  /** Permit screen-share tracks? Default true. */
  screen: boolean;
  /** Restrict who, among NIP-29 channel members, can dial. Null = all members. */
  allow: Hex[] | null;
  /** Hard-deny — overrides allow. Used by `kick`. */
  deny: Hex[];
  /** Soft cap — overrides SFU's max if smaller. */
  maxParticipants: number | null;
  /** Auto-end timestamp (unix seconds) — null = no auto-end. */
  endsAt: number | null;
}

export type SfuControlAction = 'start' | 'end' | 'kick' | 'update';

export interface SfuControlPayload {
  action: SfuControlAction;
  params?: {
    // start / update
    video?: boolean;
    screen?: boolean;
    allow?: Hex[] | null;
    deny?: Hex[];
    maxParticipants?: number | null;
    endsAt?: number | null;
    // kick
    target?: Hex;
    reason?: string;
  };
}

// ── Internal room state ──────────────────────────────────────────────────────

export type RoomStatus = 'starting' | 'active' | 'ending' | 'closed';

export interface RoomSnapshot {
  channelId: string;
  hostPubkey: Hex;
  status: RoomStatus;
  startedAt: number;
  rules: RoomRules;
  participants: Hex[];
}
