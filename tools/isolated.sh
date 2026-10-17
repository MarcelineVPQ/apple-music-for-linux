#!/usr/bin/env bash
# An ISOLATED Sonata for checks (tools/ui-check.js, tools/rail-check.js, MPRIS, smoke tests): never
# Marcy's copy, never her screen, her keyring, her tray, her audio or her D-Bus.
#
#   tools/isolated.sh start <sonata binary> --cdp 9481 --insp 9482 --display 87 [--env K=V]... [-- app args]
#   tools/isolated.sh run   --display 87 -- <command...>     a command inside that copy's private D-Bus
#                                                            (e.g. busctl --user ..., gdbus introspect ...)
#   tools/isolated.sh stop  --insp 9482                      quit it with app.exit(0), then check coredumps
#
# <sonata binary>: dist/linux-unpacked/apple-music-for-linux from `npm run dist` (or node_modules/electron/dist/electron
# with the app folder in the app args). An unpacked build has no $APPIMAGE, so it never repoints
# ~/Downloads/Sonata.AppImage or prunes AppImages; never start an AppImage from ~/Downloads (it does both).
# What isolates it:
#   - systemd-run --user: started by the user manager with its clean environment, outside any IDE or
#     snap sandbox (a snap's GTK/locale paths crash Chromium: SIGTRAP and a desktop crash notice)
#   - a throwaway HOME, XDG dirs and XDG_RUNTIME_DIR (own settings, login, sockets; no PulseAudio)
#   - Wayland and KDE session variables unset; its own Xvfb display (nothing on Marcy's screen)
#   - dbus-run-session: a private session bus (no tray icon, no media controls, no portal on hers)
#   - --password-store=basic (no KDE Wallet prompt), --no-sandbox (Ubuntu's AppArmor userns rule)
#   - quit via app.exit(0) through the inspector: never SIGTERM (Electron answers it with a core dump,
#     and every dump pops a crash notice on Marcy's desktop); kill -KILL only as a last resort
set -euo pipefail
cmd="${1:-}"; shift || true
cdp=9481; insp=9482; disp=87; envs=(); bin=""; extra=()
while [ $# -gt 0 ]; do
  case "$1" in
    --cdp) cdp="$2"; shift 2 ;;
    --insp) insp="$2"; shift 2 ;;
    --display) disp="${2#:}"; shift 2 ;;
    --env) envs+=("$2"); shift 2 ;;
    --) shift; extra=("$@"); break ;;
    *) if [ -z "$bin" ]; then bin="$1"; shift; else echo "unknown argument: $1" >&2; exit 2; fi ;;
  esac
done
root="${TMPDIR:-/tmp}/sonata-isolated-$disp"
unit="sonata-isolated-$disp"

case "$cmd" in
  start)
    [ -x "$bin" ] || { echo "start: <sonata binary> missing or not executable: $bin" >&2; exit 2; }
    case "$(readlink -f "$bin")" in "$HOME/Downloads"/*) echo "start: never from ~/Downloads" >&2; exit 2 ;; esac
    # the private bus may have started the document portal, whose FUSE mount sits in the runtime dir
    { fusermount3 -u "$root/run/doc" || fusermount3 -uz "$root/run/doc"; } 2>/dev/null || true
    rm -rf "$root"; mkdir -p "$root/home" "$root/run"; chmod 700 "$root/run"
    bin="$(readlink -f "$bin")"
    xa=""; [ ${#extra[@]} -gt 0 ] && xa="$(printf '%q ' "${extra[@]}")"
    cat > "$root/inner.sh" <<EOF
#!/usr/bin/env bash
Xvfb :$disp -screen 0 1920x1080x24 -nolisten tcp > "$root/xvfb.log" 2>&1 &
xvfb=\$!
for i in \$(seq 50); do [ -e /tmp/.X11-unix/X$disp ] && break; sleep 0.1; done
DISPLAY=:$disp dbus-run-session -- bash -c 'echo "\$DBUS_SESSION_BUS_ADDRESS" > "$root/bus"; exec "\$@"' sonata "$bin" --no-sandbox --password-store=basic --remote-debugging-port=$cdp --inspect=$insp $xa > "$root/app.log" 2>&1
code=\$?
kill \$xvfb 2>/dev/null
echo "exit \$code" >> "$root/app.log"
EOF
    chmod +x "$root/inner.sh"
    echo "$bin" > "$root/bin"; date '+%Y-%m-%d %H:%M:%S' > "$root/started"
    systemd-run --user --quiet --collect --unit "$unit" \
      env -u WAYLAND_DISPLAY -u XDG_SESSION_TYPE -u XDG_SESSION_DESKTOP -u XDG_CURRENT_DESKTOP -u DESKTOP_SESSION \
          -u KDE_FULL_SESSION -u KDE_SESSION_VERSION -u KDE_SESSION_UID -u SESSION_MANAGER -u DBUS_SESSION_BUS_ADDRESS \
          -u ELECTRON_OZONE_PLATFORM_HINT -u QT_QPA_PLATFORMTHEME -u GTK_MODULES -u DISPLAY -u APPIMAGE -u APPDIR \
          HOME="$root/home" XDG_CONFIG_HOME="$root/home/.config" XDG_DATA_HOME="$root/home/.local/share" \
          XDG_CACHE_HOME="$root/home/.cache" XDG_RUNTIME_DIR="$root/run" PULSE_SERVER=unix:/nonexistent \
          "${envs[@]}" "$root/inner.sh"
    for i in $(seq 100); do curl -fs "http://127.0.0.1:$insp/json/list" >/dev/null 2>&1 && break; sleep 0.2; done
    echo "started $unit (display :$disp, cdp $cdp, inspector $insp; files in $root)"
    ;;
  run)
    [ -s "$root/bus" ] || { echo "run: no isolated copy on display :$disp" >&2; exit 2; }
    DBUS_SESSION_BUS_ADDRESS="$(cat "$root/bus")" DISPLAY=":$disp" "${extra[@]}"
    ;;
  stop)
    node -e '
      const port = process.argv[1]
      ;(async () => {
        const list = await (await fetch("http://127.0.0.1:" + port + "/json/list")).json()
        const ws = new WebSocket(list[0].webSocketDebuggerUrl)
        await new Promise((r, j) => { ws.onopen = r; ws.onerror = j })
        ws.send(JSON.stringify({ id: 1, method: "Runtime.evaluate", params: { expression: "setTimeout(() => process.mainModule.require(\"electron\").app.exit(0), 50); true" } }))
        setTimeout(() => process.exit(0), 300)
      })().catch((e) => { console.error("stop: inspector not reachable: " + e.message); process.exit(1) })' "$insp"
    for i in $(seq 100); do systemctl --user is-active --quiet "$unit" 2>/dev/null || break; sleep 0.2; done
    if systemctl --user is-active --quiet "$unit" 2>/dev/null; then echo "stop: still running after 20 s; last resort: systemctl --user kill -s KILL $unit" >&2; exit 1; fi
    { fusermount3 -u "$root/run/doc" || fusermount3 -uz "$root/run/doc"; } 2>/dev/null || true
    tail -1 "$root/app.log" 2>/dev/null || true
    # every dump since the start (of this copy's binary, and of anything else, as a warning)
    since="$(cat "$root/started" 2>/dev/null || echo '-10min')"
    all="$(coredumpctl list --since "$since" --no-legend 2>/dev/null || true)"
    ours="$(printf '%s\n' "$all" | grep -cF "$(cat "$root/bin" 2>/dev/null || echo /nonexistent)" || true)"
    echo "coredumps of this copy since its start: $ours (any process: $(printf '%s\n' "$all" | grep -c . || true))"
    [ "$ours" = 0 ] || exit 1
    ;;
  *) sed -n 2,9p "$0"; exit 2 ;;
esac
