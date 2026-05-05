#!/usr/bin/env bash
# SFU raise: runs the Obelisk SFU + Cloudflare tunnel.
#
# Mirrors obelisk-dex/scripts/dev-raise.sh in shape and UX. Idempotent —
# reuses an already-running SFU process or cloudflared.
#
#   ./scripts/sfu-raise.sh           start (default)
#   ./scripts/sfu-raise.sh status    show what's running for this service
#   ./scripts/sfu-raise.sh stop      stop SFU + tunnel
#
# Env overrides (defaults from .env, then these):
#   TUNNEL_NAME        default: obelisk-sfu
#   TUNNEL_HOSTNAME    default: sfu.example.com  (override per-deploy)
#   PORT               default: 4848             (the SFU HTTP port)
#   PORT_FALLBACK_MAX  default: 5
#   ORIGIN_URL         default: http://127.0.0.1:$PORT
#   SKIP_TUNNEL=1      only start the SFU, no cloudflared
#   FORCE_KILL=1       evict whatever holds $PORT
#   SFU_DEV=1          run via tsx watch instead of compiled dist/

set -u

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd -P)"

if [ -f "$REPO_ROOT/.env" ]; then
  set -a
  # shellcheck disable=SC1091
  . "$REPO_ROOT/.env"
  set +a
fi

TUNNEL_NAME="${TUNNEL_NAME:-obelisk-sfu}"
TUNNEL_HOST="${TUNNEL_HOSTNAME:-${SFU_PUBLIC_URL#https://}}"
TUNNEL_HOST="${TUNNEL_HOST#http://}"
TUNNEL_HOST="${TUNNEL_HOST:-sfu.example.com}"
ORIGIN_CERT="${CLOUDFLARED_ORIGIN_CERT:-$HOME/.cloudflared/cert.pem}"
PORT="${PORT:-${SFU_HTTP_PORT:-4848}}"
PORT_FALLBACK_MAX="${PORT_FALLBACK_MAX:-5}"
ORIGIN_URL_OVERRIDE="${ORIGIN_URL:-}"
ORIGIN_URL="${ORIGIN_URL_OVERRIDE:-http://127.0.0.1:${PORT}}"
SKIP_TUNNEL="${SKIP_TUNNEL:-0}"
FORCE_KILL="${FORCE_KILL:-0}"
SFU_DEV="${SFU_DEV:-0}"

cd "$REPO_ROOT"

red()   { printf "\033[0;31m%s\033[0m\n" "$*"; }
green() { printf "\033[0;32m%s\033[0m\n" "$*"; }
blue()  { printf "\033[0;34m%s\033[0m\n" "$*"; }
dim()   { printf "\033[2m%s\033[0m\n"     "$*"; }
step()  { printf "\n\033[1;36m▸ %s\033[0m\n" "$*"; }

pid_cwd() {
  lsof -a -p "$1" -d cwd -Fn 2>/dev/null | awk '/^n/{print substr($0,2); exit}'
}

# Is this pid an obelisk-sfu Node process rooted in THIS service dir?
is_our_sfu() {
  local pid="$1" cmd cwd
  cmd=$(ps -p "$pid" -o command= 2>/dev/null || true)
  case "$cmd" in
    *"obelisk-sfu"*|*"node "*"dist/index.js"*|*"tsx "*"src/index.ts"*) ;;
    *) return 1 ;;
  esac
  cwd=$(pid_cwd "$pid")
  [ -n "$cwd" ] && [ "$cwd" = "$REPO_ROOT" ]
}

# Subcommand dispatch ────────────────────────────────────────────
SUB="${1:-start}"
case "$SUB" in
  start) ;;
  status)
    pids=$(lsof -tiTCP -sTCP:LISTEN 2>/dev/null | sort -u || true)
    found_sfu=""
    for pid in $pids; do
      if is_our_sfu "$pid"; then
        port=$(lsof -p "$pid" -iTCP -sTCP:LISTEN -P -n 2>/dev/null | awk 'NR>1{split($9,a,":"); print a[length(a)]; exit}')
        green "SFU: pid $pid on :$port  (cwd $REPO_ROOT)"
        found_sfu=1
        break
      fi
    done
    [ -z "$found_sfu" ] && dim "SFU: not running for this service"
    if pgrep -f "cloudflared .* tunnel.*${TUNNEL_NAME}" >/dev/null 2>&1 \
       || pgrep -f "cloudflared .*--cred-file.*${TUNNEL_NAME}" >/dev/null 2>&1; then
      pgrep -af "cloudflared .* tunnel" | while read -r line; do green "tunnel: $line"; done
    else
      dim "tunnel: no cloudflared running for $TUNNEL_NAME"
    fi
    exit 0
    ;;
  stop)
    blue "Stopping SFU + tunnel for $TUNNEL_NAME…"
    pids=$(lsof -tiTCP -sTCP:LISTEN 2>/dev/null | sort -u || true)
    for pid in $pids; do
      if is_our_sfu "$pid"; then
        blue "killing SFU pid $pid"
        kill -TERM "$pid" 2>/dev/null
        pkill -TERM -P "$pid" 2>/dev/null
      fi
    done
    if pgrep -f "cloudflared .* tunnel" >/dev/null 2>&1; then
      blue "killing cloudflared (any tunnel — narrow if needed)"
      pkill -TERM -f "cloudflared .* ${TUNNEL_NAME}" 2>/dev/null || true
    fi
    sleep 1
    green "Done."
    exit 0
    ;;
  -h|--help|help)
    sed -n '2,18p' "$0" | sed 's/^# \{0,1\}//'
    exit 0
    ;;
  *)
    red "Unknown subcommand: $SUB"
    echo "Usage: $0 [start|status|stop]"
    exit 2
    ;;
esac

# ── Pre-flight ───────────────────────────────────────────────────
step "Pre-flight"
command -v node >/dev/null || { red "node not installed."; exit 1; }
command -v npm  >/dev/null || { red "npm not installed."; exit 1; }
[ -d node_modules ] || { red "Run ./scripts/setup.sh first."; exit 1; }
[ -f .env ] || { red "No .env. Run ./scripts/setup.sh first."; exit 1; }

# Refuse to run with an empty SFU_NSEC.
if ! grep -qE '^SFU_NSEC=[0-9a-fA-F]{64}$' .env; then
  red "SFU_NSEC missing or invalid in .env. Run: node scripts/generate-keys.mjs --write"
  exit 1
fi
green "OK."

if [ "$SKIP_TUNNEL" != "1" ]; then
  command -v cloudflared >/dev/null || { red "cloudflared not installed. brew install cloudflared"; exit 1; }
  [ -f "$ORIGIN_CERT" ] || { red "Origin cert missing: $ORIGIN_CERT"; red "Run: cloudflared tunnel login (or set CLOUDFLARED_ORIGIN_CERT)"; exit 1; }
  dim "Origin cert: $ORIGIN_CERT"
fi

# ── Tunnel lookup ────────────────────────────────────────────────
TUNNEL_UUID=""
CRED_FILE=""
if [ "$SKIP_TUNNEL" != "1" ]; then
  step "Tunnel lookup"
  TUNNEL_UUID=$(cloudflared --origincert "$ORIGIN_CERT" tunnel list 2>/dev/null | awk -v n="$TUNNEL_NAME" '$2==n {print $1}')
  if [ -z "$TUNNEL_UUID" ]; then
    red "Tunnel '$TUNNEL_NAME' not found."
    echo "Create it with:"
    echo "  cloudflared tunnel create $TUNNEL_NAME"
    echo "  cloudflared tunnel route dns --overwrite-dns $TUNNEL_NAME $TUNNEL_HOST"
    exit 1
  fi
  CRED_FILE="$HOME/.cloudflared/${TUNNEL_UUID}.json"
  [ -f "$CRED_FILE" ] || { red "Missing credentials file: $CRED_FILE"; exit 1; }
  dim "UUID: $TUNNEL_UUID  →  $TUNNEL_HOST"
fi

# ── Port check ───────────────────────────────────────────────────
step "SFU on port $PORT"
SFU_ALREADY_RUNNING=0

pids=$(lsof -tiTCP:"$PORT" -sTCP:LISTEN 2>/dev/null || true)

if [ -n "$pids" ]; then
  pid1=$(echo "$pids" | head -1)
  cmd=$(ps -p "$pid1" -o command= 2>/dev/null || true)
  cwd=$(pid_cwd "$pid1")
  if is_our_sfu "$pid1"; then
    green "SFU already on $PORT — reusing this service's process (pid $pid1)."
    SFU_ALREADY_RUNNING=1
  else
    blue "Port $PORT held by another process:"
    dim "  pid $pid1  cmd: $cmd"
    [ -n "$cwd" ] && dim "  cwd: $cwd"
    if [ "$FORCE_KILL" = "1" ]; then
      blue "FORCE_KILL=1 — killing."
      kill $pids 2>/dev/null || true; sleep 1
      still=$(lsof -tiTCP:"$PORT" -sTCP:LISTEN 2>/dev/null || true)
      [ -n "$still" ] && { kill -9 $still 2>/dev/null || true; sleep 1; }
    else
      blue "Probing fallback ports $((PORT+1))..$((PORT+PORT_FALLBACK_MAX))"
      found=""
      for off in $(seq 1 "$PORT_FALLBACK_MAX"); do
        cand=$((PORT + off))
        cpids=$(lsof -tiTCP:"$cand" -sTCP:LISTEN 2>/dev/null || true)
        if [ -z "$cpids" ]; then
          found="$cand"; PORT="$cand"; green "Using free port $cand."; break
        fi
        cpid1=$(echo "$cpids" | head -1)
        if is_our_sfu "$cpid1"; then
          PORT="$cand"; SFU_ALREADY_RUNNING=1; found="$cand"
          green "Our SFU already on $cand — reusing (pid $cpid1)."
          break
        fi
      done
      if [ -z "$found" ]; then
        red "No free port. Options:"
        red "  • FORCE_KILL=1 ./scripts/sfu-raise.sh"
        red "  • PORT=4900 ./scripts/sfu-raise.sh"
        exit 1
      fi
    fi
  fi
fi

ORIGIN_URL="${ORIGIN_URL_OVERRIDE:-http://127.0.0.1:${PORT}}"
export SFU_HTTP_PORT="$PORT"

# ── Launch ───────────────────────────────────────────────────────
SFU_PID=""
TUNNEL_PID=""

cleanup() {
  trap - EXIT INT TERM HUP
  [ -n "$SFU_PID" ] && kill -0 "$SFU_PID" 2>/dev/null && {
    dim "stopping SFU (pid $SFU_PID)…"
    kill -TERM "$SFU_PID" 2>/dev/null || true
    pkill -TERM -P "$SFU_PID" 2>/dev/null || true
  }
  [ -n "$TUNNEL_PID" ] && kill -0 "$TUNNEL_PID" 2>/dev/null && {
    dim "stopping cloudflared (pid $TUNNEL_PID)…"
    kill -TERM "$TUNNEL_PID" 2>/dev/null || true
  }
}
trap cleanup EXIT INT TERM HUP

if [ "$SFU_ALREADY_RUNNING" = "0" ]; then
  if [ "$SFU_DEV" = "1" ]; then
    blue "Starting SFU via tsx watch (logs → ./sfu.log)…"
    npx tsx watch src/index.ts > sfu.log 2>&1 &
    SFU_PID=$!
  else
    if [ ! -d dist ] || [ ! -f dist/index.js ]; then
      blue "Building TypeScript…"
      npm run build
    fi
    blue "Starting SFU (logs → ./sfu.log)…"
    node --enable-source-maps dist/index.js > sfu.log 2>&1 &
    SFU_PID=$!
  fi

  # Wait up to 30s for the HTTP port to bind — that's the strongest
  # signal the service is actually up.
  for i in $(seq 1 30); do
    lsof -iTCP:"$PORT" -sTCP:LISTEN -n -P >/dev/null 2>&1 && { green "SFU up on :$PORT."; break; }
    if ! kill -0 "$SFU_PID" 2>/dev/null; then
      red "SFU died. Last 30 log lines:"; tail -30 sfu.log; exit 1
    fi
    sleep 1
  done
  lsof -iTCP:"$PORT" -sTCP:LISTEN -n -P >/dev/null 2>&1 || { red "SFU didn't bind :$PORT within 30s. See sfu.log"; exit 1; }
fi

if [ "$SKIP_TUNNEL" = "1" ]; then
  step "Ready"
  green "Local: http://127.0.0.1:$PORT  (SKIP_TUNNEL=1)"
  if [ -n "$SFU_PID" ]; then
    dim "SFU PID $SFU_PID — Ctrl-C or close terminal to stop."
    wait "$SFU_PID"
  fi
  exit 0
fi

# ── Tunnel ───────────────────────────────────────────────────────
step "Cloudflare tunnel"
if pgrep -f "cloudflared .* ${TUNNEL_UUID}" >/dev/null 2>&1; then
  green "Tunnel '$TUNNEL_NAME' already running — reusing."
else
  blue "Starting cloudflared '$TUNNEL_NAME' → $ORIGIN_URL (logs → ./tunnel.log)"
  cloudflared --origincert "$ORIGIN_CERT" tunnel \
    --config /dev/null \
    --cred-file "$CRED_FILE" \
    run \
    --url "$ORIGIN_URL" \
    --no-tls-verify \
    "$TUNNEL_UUID" > tunnel.log 2>&1 &
  TUNNEL_PID=$!
  sleep 2
  if ! kill -0 "$TUNNEL_PID" 2>/dev/null; then
    red "cloudflared died. Last 20 log lines:"; tail -20 tunnel.log; exit 1
  fi
fi

step "Tunnel handshake"
ready=0
for i in $(seq 1 30); do
  if grep -q "Registered tunnel connection" tunnel.log 2>/dev/null; then
    n=$(grep -c "Registered tunnel connection" tunnel.log 2>/dev/null || echo 0)
    [ "$n" -ge 1 ] && { green "cloudflared registered $n edge connection(s)."; ready=1; break; }
  fi
  if grep -qiE "error|failed|unauthorized" tunnel.log 2>/dev/null \
     && ! grep -q "Registered tunnel connection" tunnel.log 2>/dev/null; then
    red "cloudflared reported errors. Last 30 log lines:"; tail -30 tunnel.log
    exit 1
  fi
  sleep 1
done
if [ "$ready" != "1" ]; then
  red "cloudflared didn't register an edge connection within 30s."
  red "Last 30 log lines:"; tail -30 tunnel.log
  exit 1
fi

# Probe the public hostname.
step "Public reachability"
probe_public() {
  local ip
  ip=$(dig +short +time=2 +tries=1 "$TUNNEL_HOST" @1.1.1.1 | grep -m1 -E '^[0-9.]+$')
  if [ -n "$ip" ]; then
    curl -sk -o /dev/null -w "%{http_code}" --max-time 5 \
      --resolve "${TUNNEL_HOST}:443:${ip}" "https://$TUNNEL_HOST/healthz"
  else
    curl -sk -o /dev/null -w "%{http_code}" --max-time 5 "https://$TUNNEL_HOST/healthz"
  fi
}

wait_public() {
  local attempts="$1" code=""
  for _ in $(seq 1 "$attempts"); do
    code=$(probe_public)
    case "$code" in
      2*|3*|401|403) echo "$code"; return 0 ;;
      *) dim "got $code — retrying…" ;;
    esac
    sleep 2
  done
  echo "$code"
  return 1
}

if code=$(wait_public 15); then
  green "https://$TUNNEL_HOST/healthz responding ($code)."
else
  blue "Public hostname not responding (last code: $code) — attempting DNS route fix…"
  if cloudflared --origincert "$ORIGIN_CERT" tunnel route dns --overwrite-dns "$TUNNEL_UUID" "$TUNNEL_HOST" >>tunnel.log 2>&1; then
    green "Re-routed $TUNNEL_HOST → $TUNNEL_NAME. Re-checking…"
    if code=$(wait_public 15); then
      green "https://$TUNNEL_HOST/healthz responding ($code)."
    else
      red "Still no response after DNS route (last code: $code). See tunnel.log."
    fi
  else
    red "DNS route command failed — see tunnel.log."
  fi
fi

step "Ready"
green "Local:   http://127.0.0.1:$PORT"
green "Public:  https://$TUNNEL_HOST"
green "Health:  https://$TUNNEL_HOST/healthz"
green "Rooms:   https://$TUNNEL_HOST/rooms"
dim   "Logs:    ./sfu.log  ./tunnel.log"
dim   "PIDs:    ${SFU_PID:+sfu=$SFU_PID  }${TUNNEL_PID:+tunnel=$TUNNEL_PID}"
dim   "Stop:    Ctrl-C (or close terminal) — children spawned by this run will be killed."
dim   "         Reused processes (if any) survive; use ./scripts/sfu-raise.sh stop for those."
echo

wait_pids=""
[ -n "$SFU_PID" ] && wait_pids="$wait_pids $SFU_PID"
[ -n "$TUNNEL_PID" ] && wait_pids="$wait_pids $TUNNEL_PID"
if [ -n "$wait_pids" ]; then
  # shellcheck disable=SC2086
  wait $wait_pids
fi
exit 0
