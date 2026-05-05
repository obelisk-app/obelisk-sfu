/**
 * SFU's Nostr identity. Loaded once at boot from `SFU_NSEC` and held for
 * the lifetime of the process.
 *
 * Anyone who can read this struct can sign as the SFU. We never log the
 * private key; only the derived hex pubkey shows up in logs.
 */
import { hexToBytes } from '@noble/hashes/utils.js';
import { getPublicKey, finalizeEvent, type EventTemplate, type VerifiedEvent } from 'nostr-tools';

import type { Hex } from './types.js';

export interface Identity {
  pubkey: Hex;
  sign(template: EventTemplate): VerifiedEvent;
}

export function createIdentity(nsecHex: Hex): Identity {
  const sk = hexToBytes(nsecHex);
  if (sk.length !== 32) {
    throw new Error('SFU_NSEC must be 32 bytes (64 hex chars)');
  }
  const pubkey = getPublicKey(sk);
  return {
    pubkey,
    sign(template) {
      return finalizeEvent(template, sk);
    },
  };
}
