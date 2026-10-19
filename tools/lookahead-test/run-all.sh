#!/usr/bin/env bash
# Every look-ahead measurement, one private sandbox each, then the summaries:
#   tools/lookahead-test/run-all.sh <scratch> [tests...]   -> <scratch>/out/<test>.json
set -uo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
S=$(realpath "$1"); shift
TESTS=${*:-exact pause seek quantum follow track crash recreate unroute drift}
for t in $TESTS; do
  echo "== $t $(date +%T)"
  LA_RUNDIR="$S/run-$t" timeout 1200 "$HERE/sandbox.sh" "$S" python3 "$HERE/run.py" "$S" "$t" > "$S/out/$t.log" 2>&1 || echo "  $t: exit $?"
  python3 "$HERE/analyze.py" "$S/out/$t" > "$S/out/$t.json" 2> "$S/out/$t.err" || echo "  $t: analysis failed"
  [ -n "${LA_KEEP:-}" ] || rm -f "$S/out/$t/rec.f32"      # recordings are ~1 MB/s: only the summaries are kept (LA_KEEP=1 keeps them)
done
echo "== done $(date +%T)"
