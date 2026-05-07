#!/usr/bin/env bash
# Production deploy for the Obelisk SFU.
#
#   ./scripts/sfu-deploy.sh           — build then pm2 restart
#   ./scripts/sfu-deploy.sh --pull    — git pull --ff-only first, then build + restart
#   SKIP_BUILD=1 ./scripts/sfu-deploy.sh — skip build, just pm2 restart
#
# The Cloudflare tunnel (obelisk-sfu-tunnel) is NOT restarted — code
# changes only affect the SFU process. PM2 manages both processes; this
# script targets only `obelisk-sfu`.

set -euo pipefail

cd "$(dirname "$0")/.."

red()   { printf "\033[0;31m%s\033[0m\n" "$*"; }
green() { printf "\033[0;32m%s\033[0m\n" "$*"; }
blue()  { printf "\033[0;34m%s\033[0m\n" "$*"; }
step()  { printf "\n\033[1;36m▸ %s\033[0m\n" "$*"; }

SKIP_BUILD="${SKIP_BUILD:-0}"

if [ "${1:-}" = "--pull" ]; then
  step "Git pull"
  git pull --ff-only
  green "Up to date."
fi

step "Install dependencies"
npm install --prefer-offline
green "Done."

step "Build"
if [ "$SKIP_BUILD" = "1" ]; then
  [ -f dist/index.js ] || { red "dist/index.js missing — cannot skip build."; exit 1; }
  blue "Skipped (SKIP_BUILD=1)."
else
  blue "Compiling TypeScript…"
  npm run build
  green "Build complete."
fi

step "Restart obelisk-sfu (PM2)"
pm2 restart obelisk-sfu --update-env
green "Restarted."

step "Health"
sleep 3
if curl -sf -o /dev/null -w "%{http_code}\n" --max-time 5 http://127.0.0.1:4848/healthz | grep -q "200"; then
  green "SFU healthy on :4848."
else
  red "SFU health probe failed. Check pm2 logs obelisk-sfu --lines 30"
fi

step "Done"
green "Deployed. Public: https://sfu.obelisk.ar"
