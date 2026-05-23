/**
 * Relay-side channel discovery for Obelisk voice rooms.
 *
 * The SFU watches NIP-29 kind 39000 metadata across every configured relay
 * and keeps a newest-wins cache of channel type markers. This lets operators
 * see which relay channels are mesh voice vs SFU voice, and lets the call
 * listener reject accidental starts on known non-SFU channels.
 */
import type { Event } from 'nostr-tools';

import { KIND_NIP29_GROUP_METADATA } from './nip-kinds.js';
import { createLogger } from './log.js';
import type { RelayPool } from './relay.js';

const log = createLogger('channels');

export type RelayChannelKind = 'text' | 'voice' | 'voice-sfu' | 'forum';
export type RelayVoiceChannelKind = Extract<RelayChannelKind, 'voice' | 'voice-sfu'>;

export interface RelayChannelInfo {
  id: string;
  kind: RelayChannelKind;
  name: string | null;
  about: string | null;
  isPublic: boolean;
  isOpen: boolean;
  updatedAt: number;
  relays: string[];
}

export interface ChannelRegistryStatus {
  subscribed: boolean;
  relays: number;
  totalChannels: number;
  voiceChannels: number;
  meshVoiceChannels: number;
  sfuVoiceChannels: number;
}

interface ChannelRecord {
  id: string;
  kind: RelayChannelKind;
  name: string | null;
  about: string | null;
  isPublic: boolean;
  isOpen: boolean;
  updatedAt: number;
  relays: Set<string>;
}

interface ParsedMetadata {
  id: string | null;
  name: string | null;
  about: string | null;
  isPublic: boolean;
  isOpen: boolean;
  kind: RelayChannelKind;
}

export class ChannelRegistry {
  private unsubscribe: (() => void) | null = null;
  private readonly channels = new Map<string, ChannelRecord>();

  constructor(private readonly relay: RelayPool) {}

  start(): void {
    if (this.unsubscribe) return;
    const relays = this.relay.allRelays;
    this.unsubscribe = this.relay.subscribePerRelay(
      relays,
      { kinds: [KIND_NIP29_GROUP_METADATA] },
      (ev, sourceRelay) => this.ingest(ev, sourceRelay),
    );
    log.info('watching relay channel metadata', { relays: relays.length });
  }

  stop(): void {
    try { this.unsubscribe?.(); } catch { /* best effort */ }
    this.unsubscribe = null;
  }

  getChannel(channelId: string): RelayChannelInfo | null {
    const rec = this.channels.get(channelId);
    return rec ? this.snapshot(rec) : null;
  }

  listVoiceChannels(): RelayChannelInfo[] {
    return Array.from(this.channels.values())
      .filter((c) => c.kind === 'voice' || c.kind === 'voice-sfu')
      .map((c) => this.snapshot(c))
      .sort((a, b) => (a.name ?? a.id).localeCompare(b.name ?? b.id));
  }

  getStatus(): ChannelRegistryStatus {
    const values = Array.from(this.channels.values());
    const meshVoiceChannels = values.filter((c) => c.kind === 'voice').length;
    const sfuVoiceChannels = values.filter((c) => c.kind === 'voice-sfu').length;
    return {
      subscribed: this.unsubscribe !== null,
      relays: this.relay.allRelays.length,
      totalChannels: values.length,
      voiceChannels: meshVoiceChannels + sfuVoiceChannels,
      meshVoiceChannels,
      sfuVoiceChannels,
    };
  }

  private ingest(ev: Event, sourceRelay: string): void {
    const parsed = parseGroupMetadataTags(ev.tags);
    if (!parsed.id) return;

    const prev = this.channels.get(parsed.id);
    if (prev && ev.created_at < prev.updatedAt) return;
    if (prev && ev.created_at === prev.updatedAt) {
      prev.relays.add(sourceRelay);
      return;
    }

    const rec: ChannelRecord = {
      id: parsed.id,
      kind: parsed.kind,
      name: parsed.name,
      about: parsed.about,
      isPublic: parsed.isPublic,
      isOpen: parsed.isOpen,
      updatedAt: ev.created_at,
      relays: new Set([sourceRelay]),
    };
    this.channels.set(parsed.id, rec);

    if (rec.kind === 'voice' || rec.kind === 'voice-sfu') {
      log.info('voice channel detected', {
        channelId: rec.id.slice(0, 8),
        kind: rec.kind,
        name: rec.name ?? '(unnamed)',
        relay: sourceRelay,
      });
    }
  }

  private snapshot(rec: ChannelRecord): RelayChannelInfo {
    return {
      id: rec.id,
      kind: rec.kind,
      name: rec.name,
      about: rec.about,
      isPublic: rec.isPublic,
      isOpen: rec.isOpen,
      updatedAt: rec.updatedAt,
      relays: Array.from(rec.relays).sort(),
    };
  }
}

/**
 * Mirrors obelisk-dex's kind 39000 channel-kind precedence:
 * voice-sfu > voice > forum > text.
 */
export function parseGroupMetadataTags(tags: string[][]): ParsedMetadata {
  let id: string | null = null;
  let name: string | null = null;
  let about: string | null = null;
  let isPublic = false;
  let isOpen = false;
  let hasVoiceSfu = false;
  let hasVoice = false;
  let hasForum = false;

  for (const tag of tags) {
    const key = tag[0];
    const value = tag[1];
    if (key === 'd') {
      if (id === null && value) id = value;
      continue;
    }
    if (key === 'name') {
      if (name === null && value) name = value;
      continue;
    }
    if (key === 'about') {
      if (about === null && value) about = value;
      continue;
    }
    if (key === 'public') {
      isPublic = true;
      continue;
    }
    if (key === 'open') {
      isOpen = true;
      continue;
    }
    if (key === 't') {
      if (value === 'voice-sfu') hasVoiceSfu = true;
      else if (value === 'voice') hasVoice = true;
      else if (value === 'forum') hasForum = true;
    }
  }

  const kind: RelayChannelKind = hasVoiceSfu
    ? 'voice-sfu'
    : hasVoice
      ? 'voice'
      : hasForum
        ? 'forum'
        : 'text';

  return { id, name, about, isPublic, isOpen, kind };
}
