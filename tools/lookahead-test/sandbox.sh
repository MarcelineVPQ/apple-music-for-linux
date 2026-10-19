#!/usr/bin/env bash
# Runs a command next to a PRIVATE PipeWire (+ pulse protocol + WirePlumber) that cannot reach the
# user's audio, devices or desktop. For the look-ahead tests only (tools/lookahead-test/README.md).
#
#   tools/lookahead-test/sandbox.sh <scratch-dir> <command...>
#
# Isolation (bwrap): a fresh /dev (no /dev/snd), the user's /run/user/$UID and /run/dbus hidden behind
# empty tmpfs mounts, a private /tmp, new PID/IPC/network namespaces (no abstract sockets, no D-Bus, no
# network), a private XDG_RUNTIME_DIR (0700) and HOME/XDG dirs under the scratch dir (WirePlumber's
# state goes there, never to ~/.local/state). The daemon loads no ALSA/bluez plugins: two null sinks
# ("speakers", the default, and "speakers2") stand in for devices. --die-with-parent + the PID
# namespace end every process started here when the command ends.
set -euo pipefail
S=$(realpath "$1"); shift
HERE=$(cd "$(dirname "$0")" && pwd)
R=${LA_RUNDIR:-$S/run}          # one per sandbox running at the same time
rm -rf "$R" "$S/home/.local/state/wireplumber"; mkdir -p "$R" "$S/home/.config/wireplumber/wireplumber.conf.d" "$S/home/.local/state" "$S/home/.local/share"
chmod 700 "$R"
cp "$HERE/wp-sandbox.conf" "$S/home/.config/wireplumber/wireplumber.conf.d/99-sandbox.conf"
exec env -i PATH=/usr/bin:/bin HOME="$S/home" LANG=C.UTF-8 \
  bwrap --dev-bind / / --dev /dev --proc /proc --tmpfs /dev/shm --tmpfs /tmp \
    --tmpfs "/run/user/$(id -u)" --tmpfs /run/dbus \
    --unshare-pid --unshare-net --unshare-ipc --die-with-parent \
    --setenv XDG_RUNTIME_DIR "$R" --setenv PIPEWIRE_RUNTIME_DIR "$R" --setenv PULSE_RUNTIME_PATH "$R/pulse" \
    --setenv XDG_CONFIG_HOME "$S/home/.config" --setenv XDG_STATE_HOME "$S/home/.local/state" \
    --setenv XDG_DATA_HOME "$S/home/.local/share" --setenv LA_SCRATCH "$S" --setenv LA_HERE "$HERE" \
    /bin/bash -c '
      set -e
      pipewire -c "$LA_HERE/pw-sandbox.conf" > "$XDG_RUNTIME_DIR/pipewire.log" 2>&1 &
      for i in $(seq 50); do [ -S "$XDG_RUNTIME_DIR/pipewire-0" ] && break; sleep 0.1; done
      [ -S "$XDG_RUNTIME_DIR/pipewire-0" ] || { echo "private pipewire did not start"; cat "$XDG_RUNTIME_DIR/pipewire.log"; exit 1; }
      wireplumber -p policy > "$XDG_RUNTIME_DIR/wireplumber.log" 2>&1 &
      for i in $(seq 100); do pactl info 2>/dev/null | grep -q "Default Sink: speakers$" && break; sleep 0.1; done
      pactl info 2>/dev/null | grep -q "Default Sink: speakers$" || { echo "wireplumber did not pick the default sink"; tail -20 "$XDG_RUNTIME_DIR/wireplumber.log"; exit 1; }
      "$@"
    ' sandbox "$@"
