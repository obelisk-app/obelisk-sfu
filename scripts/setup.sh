#!/usr/bin/env bash
# First-run setup for the Obelisk SFU.
#
#   ./scripts/setup.sh
#
# Idempotent — safe to re-run. Does:
#   1. node + npm version sanity
#   2. npm install (if node_modules missing)
#   3. cp .env.example .env (if .env missing)
#   4. Generate SFU_NSEC if blank in .env
#   5. Create a placeholder allow.json (if missing)
#   6. Print next-step pointers

set -euo pipefail

cd "$(dirname "$0")/.."

red()   { printf "\033[0;31m%s\033[0m\n" "$*"; }
green() { printf "\033[0;32m%s\033[0m\n" "$*"; }
blue()  { printf "\033[0;34m%s\033[0m\n" "$*"; }
dim()   { printf "\033[2m%s\033[0m\n"     "$*"; }
step()  { printf "\n\033[1;36m▸ %s\033[0m\n" "$*"; }

# ── Node version ─────────────────────────────────────────────────────
step "Pre-flight"
command -v node >/dev/null || { red "node not installed."; exit 1; }
command -v npm  >/dev/null || { red "npm not installed."; exit 1; }
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$NODE_MAJOR" -lt 20 ]; then
  red "Node 20+ required (found v$(node -v))."
  exit 1
fi
green "node $(node -v)  npm $(npm -v)"

# ── Dependencies ─────────────────────────────────────────────────────
step "Dependencies"
if [ ! -d node_modules ]; then
  blue "Installing…"
  npm install
else
  dim "node_modules present — skipping (delete it to force a clean install)"
fi
green "OK."

# ── .env ─────────────────────────────────────────────────────────────
step ".env"
if [ ! -f .env ]; then
  cp .env.example .env
  green "Created .env from .env.example"
else
  dim ".env present — leaving alone"
fi

# ── Generate SFU_NSEC if blank ───────────────────────────────────────
step "SFU_NSEC"
SFU_NSEC_LINE="$(grep -E '^SFU_NSEC=' .env || true)"
if [ -z "$SFU_NSEC_LINE" ] || [ "$SFU_NSEC_LINE" = "SFU_NSEC=" ]; then
  blue "No SFU_NSEC set — generating a fresh keypair…"
  node scripts/generate-keys.mjs --write
else
  dim "SFU_NSEC already set — leaving alone (delete the line to rotate)"
fi

# ── allow.json ───────────────────────────────────────────────────────
step "allow.json"
if [ ! -f allow.json ]; then
  cat > allow.json <<'JSON'
{
  "_comment": "Hex pubkeys (NOT npubs) authorized to publish kind 25052 start events on this SFU. Re-read on SIGHUP. Add your own pubkey here so you can test the SFU yourself.",
  "pubkeys": []
}
JSON
  green "Wrote a starter allow.json — edit it to add authorized pubkeys."
else
  dim "allow.json present — leaving alone"
fi

# ── Done ─────────────────────────────────────────────────────────────
step "Done"
cat <<MSG
Next steps:
  1. Edit .env — set SFU_PUBLIC_URL, SFU_RELAYS (if not the default), and
     SFU_PUBLIC_IP if you're behind 1:1 NAT.
  2. Edit allow.json — add hex pubkeys authorized to start calls.
  3. Set up the Cloudflare tunnel (one-time):
       cloudflared tunnel login
       cloudflared tunnel create obelisk-sfu
       cloudflared tunnel route dns --overwrite-dns obelisk-sfu sfu.example.com
  4. Run the service:
       npm run raise
MSG
