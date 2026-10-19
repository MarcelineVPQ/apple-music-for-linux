#!/bin/bash
# Chromium's own pause tail, resume lag, seek and track-change timing (docs/LOOKAHEAD.md "Chromium's real
# behaviour"). Runs INSIDE the private sandbox, never on a desktop session:
#   tools/lookahead-test/sandbox.sh <scratch> bash tools/lookahead-test/chromium/run-in.sh <phase>
#   python3 tools/lookahead-test/chromium/analyze.py <scratch>/out/chromium-<phase>
# phase: main (pauses, seeks, src changes, a long pause) | pulsesink (PULSE_SINK and its sink removed)
# Needs <scratch>/build/la-test (tools/lookahead-test/la-test.c) and castlabs Electron (ELECTRON, default
# the worktree's node_modules). Xvfb inside the sandbox needs -extension GLX: the fresh /dev has no GPU
# device nodes and its GLX would load the NVIDIA EGL library and crash (seen once, 2026-10-19).
set -e; ulimit -c 0
C=$LA_SCRATCH; OUT=$C/out/chromium-$1; mkdir -p "$OUT"; rm -f "$OUT"/*
E=${ELECTRON:-$LA_HERE/../../node_modules/electron/dist/electron}
APP=$C/chromium-app; rm -rf "$APP"; cp -r "$LA_HERE/chromium" "$APP"; python3 "$APP/gen_wav.py" "$APP"
"$C/build/la-test" rec --name probe --out "$OUT/rec" --chans 4 & PROBE=$!
for i in $(seq 50); do pw-link -i | grep -q probe:in_4 && break; sleep 0.1; done
lk() { for i in $(seq 30); do pw-link "$1" "$2" 2>/dev/null && return 0; sleep 0.2; done; echo "link $1 $2 failed"; }
sleep 0.5; lk speakers:monitor_FL probe:in_1; lk speakers:monitor_FR probe:in_2
lk speakers2:monitor_FL probe:in_3; lk speakers2:monitor_FR probe:in_4
mkdir -p /tmp/.X11-unix; chmod 1777 /tmp/.X11-unix
Xvfb :191 -screen 0 640x480x24 -nolisten tcp -extension GLX > "$OUT/xvfb.log" 2>&1 & X=$!
sleep 1
if [ "$1" = pulsesink ]; then
  MOD=$(pactl load-module module-null-sink sink_name=tmp); export LA_TMPMOD=$MOD PULSE_SINK=tmp
  sleep 1
  pw-link -u speakers2:monitor_FL probe:in_3 || true; pw-link -u speakers2:monitor_FR probe:in_4 || true
  pw-link tmp:monitor_FL probe:in_3 || true; pw-link tmp:monitor_FR probe:in_4 || true
fi
# Electron quits by itself (app.exit(0) at the end of its timeline): never SIGTERM it (a core dump)
env -u WAYLAND_DISPLAY -u DBUS_SESSION_BUS_ADDRESS DISPLAY=:191 LA_OUT="$OUT" LA_PHASE="$1" "$E" --no-sandbox --password-store=basic --disable-gpu --user-data-dir="$C/udd-$1" "$APP" > "$OUT/electron.log" 2>&1 || echo "electron exit $?"
sleep 1
kill $PROBE; wait $PROBE || true
kill $X || true
cp "$XDG_RUNTIME_DIR/wireplumber.log" "$OUT/" 2>/dev/null || true
