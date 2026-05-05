#!/usr/bin/env node
/**
 * Generate a fresh Nostr keypair for the SFU's identity.
 *
 *   node scripts/generate-keys.mjs           # print keys to stdout
 *   node scripts/generate-keys.mjs --write   # also patch SFU_NSEC into .env
 *
 * The hex secret is what goes into `SFU_NSEC` in `.env`. The npub is what
 * users add to their UI when authorizing this SFU. The hex pubkey is what
 * appears in kind 31313 advertisement and kind 31314 active-call events.
 */
import { generateSecretKey, getPublicKey, nip19 } from 'nostr-tools';
import { bytesToHex } from '@noble/hashes/utils.js';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const envPath = resolve(__dirname, '..', '.env');

const writeEnv = process.argv.includes('--write');

const sk = generateSecretKey();
const skHex = bytesToHex(sk);
const pkHex = getPublicKey(sk);
const nsec = nip19.nsecEncode(sk);
const npub = nip19.npubEncode(pkHex);

console.log('SFU keypair generated.');
console.log('');
console.log(`  pubkey hex : ${pkHex}`);
console.log(`  npub       : ${npub}`);
console.log('');
console.log('  KEEP SECRET — anything below this line lets someone sign as your SFU:');
console.log(`  secret hex : ${skHex}`);
console.log(`  nsec       : ${nsec}`);
console.log('');

if (!writeEnv) {
  console.log('Add to services/sfu/.env:');
  console.log(`  SFU_NSEC=${skHex}`);
  console.log('');
  console.log('Or re-run with --write to patch .env automatically.');
  process.exit(0);
}

if (!existsSync(envPath)) {
  console.error(`No .env at ${envPath}. Copy .env.example first, then re-run.`);
  process.exit(1);
}

const lines = readFileSync(envPath, 'utf8').split('\n');
let patched = false;
for (let i = 0; i < lines.length; i++) {
  const line = lines[i];
  if (line.startsWith('SFU_NSEC=')) {
    if (line.length > 'SFU_NSEC='.length) {
      console.error('SFU_NSEC already set in .env. Refusing to overwrite.');
      console.error('Edit .env manually if you really want to rotate the key.');
      process.exit(2);
    }
    lines[i] = `SFU_NSEC=${skHex}`;
    patched = true;
    break;
  }
}
if (!patched) {
  lines.push(`SFU_NSEC=${skHex}`);
}
writeFileSync(envPath, lines.join('\n'));
console.log(`Wrote SFU_NSEC into ${envPath}.`);
