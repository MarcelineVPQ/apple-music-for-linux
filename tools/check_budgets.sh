#!/usr/bin/env bash
# The resource budget check (docs/BUDGETS.md, limits in tools/budgets.json): starts its OWN isolated Sonata
# (tools/isolated.sh: throwaway HOME, its own Xvfb display, private D-Bus, never Marcy's copy or screen),
# measures it with tools/check-budgets.js, quits it with app.exit(0) and checks for core dumps.
#
#   tools/check_budgets.sh                 --quick (~10 min): every state once, the release check
#   tools/check_budgets.sh --soak          ~35 min: 5 min warm-up + a 30-minute soak (memory and listener growth)
#   tools/check_budgets.sh --bin PATH      measure that build (default: Electron from node_modules + this source tree;
#                                          a packaged build: dist/linux-unpacked/apple-music-for-linux, never ~/Downloads)
#   SONATA_BUDGET_STATES=lyrics-playing,viz-bars tools/check_budgets.sh   only those states
#   SONATA_BUDGET_MODE='{"cpuS":60}' tools/check_budgets.sh              other timings, for an experiment
#   SONATA_BUDGET_DISPLAY=147 / SONATA_BUDGET_PORT=9747 (uses it and +1)  another display or ports
# Results: tmp/budgets/budgets-<mode>.json and app.log; prints the PASS/FAIL table, exits 1 on a FAIL.
# Needs a display server (Xvfb) and minutes of wall time: not in CI.
set -euo pipefail
APP="$(cd "$(dirname "$0")/.." && pwd)"
MODE=quick; BIN=""
while [ $# -gt 0 ]; do
  case "$1" in
    --quick) MODE=quick; shift ;;
    --soak) MODE=soak; shift ;;
    --bin) BIN="$2"; shift 2 ;;
    *) sed -n 2,14p "$0"; exit 2 ;;
  esac
done
DISP="${SONATA_BUDGET_DISPLAY:-147}"
CDP="${SONATA_BUDGET_PORT:-9747}"; INSP=$((CDP + 1))
OUT="$APP/tmp/budgets"
for p in "$CDP" "$INSP"; do
  if curl -s -o /dev/null --max-time 2 "http://127.0.0.1:$p/json/version"; then
    echo "port $p is in use; pick others with SONATA_BUDGET_PORT=<n> (uses n and n+1)" >&2; exit 2
  fi
done
args=()
if [ -z "$BIN" ]; then BIN="$APP/node_modules/electron/dist/electron"; args=(-- "$APP"); fi
mkdir -p "$OUT"
"$APP/tools/isolated.sh" start "$BIN" --cdp "$CDP" --insp "$INSP" --display "$DISP" "${args[@]}"
stop() {
  cp "${TMPDIR:-/tmp}/sonata-isolated-$DISP/app.log" "$OUT/app.log" 2>/dev/null || true
  "$APP/tools/isolated.sh" stop --insp "$INSP" --display "$DISP" || echo "the isolated copy did not stop cleanly (see above)" >&2
}
trap stop EXIT
sleep 8   # Apple's page loads (logged out) and the rail mounts
status=0
nice -n 10 node "$APP/tools/check-budgets.js" "$MODE" --cdp "$CDP" --insp "$INSP" --display ":$DISP" --out "$OUT" || status=$?
exit "$status"
