#!/usr/bin/env bash
# Release startup smoke (every dev build, before tagging; docs/RELEASING.md "Checks before tagging"):
# starts the BUILT app once in an isolated copy (tools/isolated.sh: throwaway HOME, own Xvfb display,
# private D-Bus, --password-store=basic, GPU off) and fails when, within the first SMOKE_SECONDS (20),
#   - the main process throws ("A JavaScript error occurred in the main process", "Uncaught Exception",
#     "App threw an error during load", an unhandled rejection),
#   - one of Sonata's own pages logs an "Uncaught" error (console lines whose source is a local file;
#     Apple's page is logged out here, its own errors are not Sonata's),
#   - a renderer or the GPU/utility process is gone (crashed, killed, OOM), or the app exits by itself,
#   - stopping it leaves a core dump or a desktop helper (tools/isolated.sh stop's after-check).
# 0.15.68-dev.1 shipped a main-process ReferenceError at load ("Cannot access helperSpeedLib before
# initialization"); this is the check that would have stopped it. ~30 s, nothing heavier.
#
#   tools/smoke-start.sh [<binary>] [--display N] [--cdp P] [--insp P]
#     <binary>: default dist/linux-unpacked/apple-music-for-linux (npm run dist first). An AppImage is
#     copied to a scratch folder under ~/.cache and unpacked there (never started from ~/Downloads).
#     To smoke the source tree instead: node_modules/electron/dist/electron (the app folder is added).
set -euo pipefail
here="$(cd "$(dirname "$0")/.." && pwd)"
bin=""; disp=""; cdp=9491; insp=9492
while [ $# -gt 0 ]; do
  case "$1" in
    --display) disp="${2#:}"; shift 2 ;;
    --cdp) cdp="$2"; shift 2 ;;
    --insp) insp="$2"; shift 2 ;;
    -h|--help) sed -n 2,17p "$0"; exit 0 ;;
    *) bin="$1"; shift ;;
  esac
done
secs="${SMOKE_SECONDS:-20}"
bin="${bin:-$here/dist/linux-unpacked/apple-music-for-linux}"
[ -x "$bin" ] || { echo "smoke: no built app at $bin (run npm run dist first)" >&2; exit 2; }
appargs=(--disable-gpu)
case "$(basename "$bin")" in electron) appargs+=("$here") ;; esac
scratch=""
case "$bin" in
  *.AppImage)
    scratch="$(mktemp -d "${XDG_CACHE_HOME:-$HOME/.cache}/sonata-smoke.XXXXXX")"
    # FUSE can't mount inside the isolation (bwrap), so its contents are unpacked on disk and the packaged
    # binary runs from there: the same files the AppImage holds, without $APPIMAGE (nothing is repointed)
    cp "$bin" "$scratch/"; chmod +x "$scratch/$(basename "$bin")"
    (cd "$scratch" && "./$(basename "$bin")" --appimage-extract >/dev/null)
    bin="$scratch/squashfs-root/apple-music-for-linux" ;;
esac
# a free display: no X server or lock on it, no isolated unit
if [ -z "$disp" ]; then
  for d in $(seq 140 179); do
    [ -e "/tmp/.X$d-lock" ] || [ -e "/tmp/.X11-unix/X$d" ] && continue
    systemctl --user is-active --quiet "sonata-isolated-$d" 2>/dev/null && continue
    disp="$d"; break
  done
fi
[ -n "$disp" ] || { echo "smoke: no free display in :140-:179" >&2; exit 2; }
root="${TMPDIR:-/tmp}/sonata-isolated-$disp"

echo "smoke: $bin on :$disp for ${secs} s"
# ELECTRON_ENABLE_LOGGING: the pages' console messages go to stderr (app.log), so a page's Uncaught shows
"$here/tools/isolated.sh" start "$bin" --cdp "$cdp" --insp "$insp" --display "$disp" \
  --env ELECTRON_ENABLE_LOGGING=1 -- "${appargs[@]}"

log="$root/app.log"
started=0
# loop: SERIAL-REQUIRED — a deadline: 1 s polls of the log for at most SMOKE_SECONDS
for i in $(seq "$secs"); do
  sleep 1
  grep -q '^exit ' "$log" 2>/dev/null && break
  [ "$started" = 0 ] && curl -fs "http://127.0.0.1:$cdp/json/list" 2>/dev/null | grep -q '"type": *"page"' && started="$i"
done

fail=()
bad_main='A JavaScript error occurred in the main process|Uncaught Exception|App threw an error during load|UnhandledPromiseRejection|Unhandled promise rejection|unhandledRejection'
if grep -qE "$bad_main" "$log"; then fail+=("main-process exception"); fi
# Sonata's own pages: console lines with "Uncaught" whose source is a local file (file://, or a page
# script main sends: source empty); Apple's https page is not Sonata's
own_uncaught="$(grep -E 'CONSOLE|console' "$log" | grep -F 'Uncaught' | grep -vE 'source: https?://' || true)"
[ -n "$own_uncaught" ] && fail+=("Uncaught error in a Sonata page")
if grep -qE 'render-process-gone|child-process-gone|Renderer process (crashed|was killed)|GPU process exited unexpectedly|Network service crashed|Trace/breakpoint trap|Segmentation fault|core dumped' "$log"; then fail+=("a process crashed"); fi
if grep -q '^exit ' "$log"; then fail+=("the app exited by itself ($(grep '^exit ' "$log" | tail -1))"); fi
[ "$started" = 0 ] && fail+=("no page came up within ${secs} s")

stopok=1
if ! grep -q '^exit ' "$log"; then
  "$here/tools/isolated.sh" stop --insp "$insp" --display "$disp" || stopok=0
else
  # it exited by itself: the unit is gone; still run the after-check's cleanup through stop's last part
  systemctl --user is-active --quiet "sonata-isolated-$disp" 2>/dev/null && systemctl --user kill -s KILL "sonata-isolated-$disp"
fi
[ "$stopok" = 1 ] || fail+=("stop's after-check (core dump, helper or process left)")

keep="${XDG_CACHE_HOME:-$HOME/.cache}/sonata-smoke-last.log"
cp "$log" "$keep" 2>/dev/null || true
[ -n "$scratch" ] && rm -rf "$scratch"
if [ ${#fail[@]} -gt 0 ]; then
  echo "smoke: FAIL — $(IFS=';'; echo "${fail[*]}")"
  grep -nE "$bad_main|Uncaught|process-gone|crashed|exited unexpectedly" "$keep" | head -20 || true
  echo "full log: $keep"
  exit 1
fi
echo "smoke: PASS — first page after ${started} s, no exception, crash or Uncaught in ${secs} s (log: $keep)"
