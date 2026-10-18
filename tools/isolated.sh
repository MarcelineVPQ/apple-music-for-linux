#!/usr/bin/env bash
# An ISOLATED Sonata for checks (tools/ui-check.js, tools/rail-check.js, MPRIS, smoke tests): never
# Marcy's copy, never her screen, her keyring, her tray, her audio or her D-Bus.
#
#   tools/isolated.sh start <sonata binary> --cdp 9481 --insp 9482 --display 87 [--env K=V]... [-- app args]
#   tools/isolated.sh run   --display 87 -- <command...>     a command inside that copy's private D-Bus
#                                                            (e.g. busctl --user ..., gdbus introspect ...)
#   tools/isolated.sh stop  --insp 9482 [--display 87]       quit it with app.exit(0), then check coredumps,
#                                                            leftover processes and mounts (the display is
#                                                            looked up from the inspector port when not given)
#
# <sonata binary>: dist/linux-unpacked/apple-music-for-linux from `npm run dist` (or node_modules/electron/dist/electron
# with the app folder in the app args). An unpacked build has no $APPIMAGE, so it never repoints
# ~/Downloads/Sonata.AppImage or prunes AppImages; never start an AppImage from ~/Downloads (it does both).
# What isolates it:
#   - systemd-run --user: started by the user manager with its clean environment, outside any IDE or
#     snap sandbox (a snap's GTK/locale paths crash Chromium: SIGTRAP and a desktop crash notice)
#   - a throwaway HOME, XDG dirs and XDG_RUNTIME_DIR (own settings, login, sockets; no PulseAudio)
#   - Wayland and KDE session variables unset; its own Xvfb display (nothing on Marcy's screen)
#   - env -i: a clean environment built here (PATH, LANG, USER, its HOME and XDG dirs, nothing else of the
#     caller's: no WAYLAND_DISPLAY, DISPLAY, DBUS_SESSION_BUS_ADDRESS or session variables)
#   - dbus-run-session from a minimal config (root/session.conf) whose only service folder is EMPTY: nothing
#     can be D-Bus-activated on it by name, so no xdg-desktop-portal(-kde), document portal, kscreen,
#     kwalletd/ksecretd, dconf or at-spi (2026-10-18: such helpers, started on test copies' private buses,
#     left SIGABRT dumps that can pop crash notices on Marcy's desktop). GTK_USE_PORTAL=0, NO_AT_BRIDGE=1,
#     GSETTINGS_BACKEND=memory and GIO_USE_VFS=local keep the toolkit from asking for them at all
#   - bubblewrap with an empty tmpfs over /run/user/UID: Marcy's runtime dir (her bus, Wayland, PipeWire,
#     wallet sockets) can't be reached even by a full path
#   - --password-store=basic (no KDE Wallet prompt), --no-sandbox (Ubuntu's AppArmor userns rule)
#   - quit via app.exit(0) through the inspector: never SIGTERM (Electron answers it with a core dump,
#     and every dump pops a crash notice on Marcy's desktop); kill -KILL only as a last resort
#   - stop's after-check fails on a core dump of this copy (its binary, or any process with its runtime dir
#     in its environment or its app.log open) or a desktop helper it started; other sessions' dumps and
#     helpers (other agents' copies, the desktop) are listed, not judged
set -euo pipefail
cmd="${1:-}"; shift || true
cdp=9481; insp=9482; disp=87; disp_given=0; envs=(); bin=""; extra=()
while [ $# -gt 0 ]; do
  case "$1" in
    --cdp) cdp="$2"; shift 2 ;;
    --insp) insp="$2"; shift 2 ;;
    --display) disp="${2#:}"; disp_given=1; shift 2 ;;
    --env) envs+=("$2"); shift 2 ;;
    --) shift; extra=("$@"); break ;;
    *) if [ -z "$bin" ]; then bin="$1"; shift; else echo "unknown argument: $1" >&2; exit 2; fi ;;
  esac
done
# stop finds its copy by the inspector port (a stop without --display used to check and clean :87's copy)
byport="${TMPDIR:-/tmp}/sonata-isolated-insp-$insp"
[ "$cmd" = stop ] && [ "$disp_given" = 0 ] && [ -s "$byport" ] && disp="$(cat "$byport")"
root="${TMPDIR:-/tmp}/sonata-isolated-$disp"
unit="sonata-isolated-$disp"
# desktop helpers a test copy must never start, matched by the program path at the start of the command line
WATCH='^/usr/[^ ]*/(xdg-desktop-portal[^ /]*|xdg-document-portal|xdg-permission-store|kscreen_backend_launcher|kwalletd[0-9]*|ksecretd|at-spi-bus-launcher|at-spi2-registryd|dconf-service)( |$)'
watched_pids() { pgrep -f "$WATCH" | sort || true; }

case "$cmd" in
  start)
    [ -x "$bin" ] || { echo "start: <sonata binary> missing or not executable: $bin" >&2; exit 2; }
    case "$(readlink -f "$bin")" in "$HOME/Downloads"/*) echo "start: never from ~/Downloads" >&2; exit 2 ;; esac
    # another copy (another agent's) on this display: starting would wipe its HOME and runtime dir under it,
    # so refuse before anything is removed: its unit is active, an X server holds the display, or the X lock
    # names a live process (a lock left by a killed Xvfb names a dead one: Xvfb replaces it)
    lockpid="$( { tr -dc 0-9 < "/tmp/.X$disp-lock"; } 2>/dev/null || true)"
    if systemctl --user is-active --quiet "$unit" 2>/dev/null || pgrep -f "^X[a-z]* :$disp( |\$)" >/dev/null || { [ -n "$lockpid" ] && kill -0 "$lockpid" 2>/dev/null; }; then
      echo "start: display :$disp is in use (unit $unit active, an X server, or /tmp/.X$disp-lock); pick another --display" >&2; exit 2
    fi
    # the private bus may have started the document portal, whose FUSE mount sits in the runtime dir
    [ -f "$root/cleanup.sh" ] && bash "$root/cleanup.sh"
    { fusermount3 -u "$root/run/doc" || fusermount3 -uz "$root/run/doc"; } 2>/dev/null || true
    rm -rf "$root"; mkdir -p "$root/home" "$root/run" "$root/no-services"; chmod 700 "$root/run"
    # the private session bus: its only service folder is empty, so nothing can be started on it by name
    cat > "$root/session.conf" <<EOF
<!DOCTYPE busconfig PUBLIC "-//freedesktop//DTD D-Bus Bus Configuration 1.0//EN" "http://www.freedesktop.org/standards/dbus/1.0/busconfig.dtd">
<busconfig>
  <type>session</type>
  <keep_umask/>
  <listen>unix:dir=$root/run</listen>
  <auth>EXTERNAL</auth>
  <servicedir>$root/no-services</servicedir>
  <policy context="default">
    <allow send_destination="*" eavesdrop="true"/>
    <allow eavesdrop="true"/>
    <allow own="*"/>
  </policy>
</busconfig>
EOF
    bin="$(readlink -f "$bin")"
    xa=""; [ ${#extra[@]} -gt 0 ] && xa="$(printf '%q ' "${extra[@]}")"
    cat > "$root/inner.sh" <<EOF
#!/usr/bin/env bash
Xvfb :$disp -screen 0 1920x1080x24 -nolisten tcp > "$root/xvfb.log" 2>&1 &
xvfb=\$!
for i in \$(seq 50); do [ -e /tmp/.X11-unix/X$disp ] && break; sleep 0.1; done
DISPLAY=:$disp dbus-run-session --config-file="$root/session.conf" -- bash -c 'echo "\$DBUS_SESSION_BUS_ADDRESS" > "$root/bus"; exec "\$@"' sonata \
  bwrap --dev-bind / / --tmpfs "/run/user/$(id -u)" "$bin" --no-sandbox --password-store=basic --remote-debugging-port=$cdp --inspect=$insp $xa > "$root/app.log" 2>&1
code=\$?
kill \$xvfb 2>/dev/null
echo "exit \$code" >> "$root/app.log"
EOF
    chmod +x "$root/inner.sh"
    echo "$bin" > "$root/bin"; date '+%Y-%m-%d %H:%M:%S' > "$root/started"; echo "$disp" > "$byport"
    watched_pids > "$root/watched-before"
    # however the unit ends (app.exit, a closed window, a kill), systemd ends every process left in it,
    # FUSE daemons included: the portal's and an AppImage's own. Their mounts stay behind, so the unit's
    # ExecStopPost (and stop) unmount them: run/doc, and the AppImage mount recorded at start.
    cat > "$root/cleanup.sh" <<EOF
#!/usr/bin/env bash
for m in "$root/run/doc" "\$(cat "$root/appmount" 2>/dev/null)"; do
  [ -n "\$m" ] && { fusermount3 -u "\$m" 2>/dev/null || fusermount3 -uz "\$m" 2>/dev/null; }
done
true
EOF
    systemd-run --user --quiet --collect --unit "$unit" -p "ExecStopPost=/bin/bash $root/cleanup.sh" \
      env -i PATH=/usr/local/bin:/usr/bin:/bin LANG="${LANG:-C.UTF-8}" USER="$USER" LOGNAME="$USER" \
          HOME="$root/home" XDG_CONFIG_HOME="$root/home/.config" XDG_DATA_HOME="$root/home/.local/share" \
          XDG_CACHE_HOME="$root/home/.cache" XDG_RUNTIME_DIR="$root/run" XDG_DATA_DIRS=/usr/local/share:/usr/share \
          XDG_CONFIG_DIRS=/etc/xdg PULSE_SERVER=unix:/nonexistent \
          GTK_USE_PORTAL=0 NO_AT_BRIDGE=1 GSETTINGS_BACKEND=memory GIO_USE_VFS=local \
          "${envs[@]}" "$root/inner.sh"
    for i in $(seq 100); do curl -fs "http://127.0.0.1:$insp/json/list" >/dev/null 2>&1 && break; sleep 0.2; done
    # an AppImage runs from its own FUSE mount (/tmp/.mount_*): note this copy's, from its unit's processes
    cg="/sys/fs/cgroup$(systemctl --user show -p ControlGroup --value "$unit" 2>/dev/null)"
    for p in $(cat "$cg/cgroup.procs" 2>/dev/null); do
      e="$(readlink "/proc/$p/exe" 2>/dev/null || true)"
      case "$e" in */.mount_*/*) m="${e#*/.mount_}"; echo "${e%%/.mount_*}/.mount_${m%%/*}" > "$root/appmount"; break ;; esac
    done
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
    bash "$root/cleanup.sh" 2>/dev/null || true
    rm -f "$byport"
    tail -1 "$root/app.log" 2>/dev/null || true
    am="$(cat "$root/appmount" 2>/dev/null || echo "$root/run/doc")"
    left="$(findmnt -rn -o TARGET 2>/dev/null | grep -cxF -e "$root/run/doc" -e "$am" || true)"
    # anything still running with this copy's runtime dir (portal, at-spi, gvfs) or its Xvfb
    procs="$( { command grep -lsaF "XDG_RUNTIME_DIR=$root/run" /proc/[0-9]*/environ || true; } | wc -l)"
    procs=$((procs + $(pgrep -fc "^Xvfb :$disp " || true)))
    echo "left behind: $left mounts, $procs processes"
    [ "$left" = 0 ] && [ "$procs" = 0 ] || exit 1
    # core dumps since the start: this copy's (its binary, or any process with its runtime dir in its
    # environment or its app.log open) fail; other sessions' are listed only
    since="$(cat "$root/started" 2>/dev/null || echo '-10min')"
    dumps="$(journalctl --user --system --since "$since" MESSAGE_ID=fc2e22bc6ee647b6b90729ab34a250b1 -o json 2>/dev/null |
      node -e '
        const [run, log, exe] = process.argv.slice(1)
        const text = (v) => (Array.isArray(v) ? Buffer.from(v).toString() : String(v == null ? "" : v))
        let data = ""; process.stdin.on("data", (c) => (data += c)).on("end", () => {
          for (const line of data.split("\n").filter(Boolean)) {
            const d = JSON.parse(line)
            const mine = text(d.COREDUMP_ENVIRON).includes("XDG_RUNTIME_DIR=" + run) || text(d.COREDUMP_OPEN_FDS).includes(log) || text(d.COREDUMP_EXE) === exe
            console.log((mine ? "OURS " : "OTHER ") + text(d.COREDUMP_PID) + " " + text(d.COREDUMP_EXE) + " " + text(d.COREDUMP_SIGNAL_NAME))
          }
        })' "$root/run" "$root/app.log" "$(cat "$root/bin" 2>/dev/null || echo /nonexistent)" || true)"
    ours="$(printf '%s\n' "$dumps" | grep -c '^OURS ' || true)"
    printf '%s\n' "$dumps" | grep '^OURS ' || true
    printf '%s\n' "$dumps" | grep '^OTHER ' | sed 's/^/not this copy, reported only: /' || true
    # desktop helpers started since the start: this copy's (its runtime dir in their environment) fail
    helpers=0
    for p in $(comm -13 "$root/watched-before" <(watched_pids) 2>/dev/null); do
      if grep -qsaF "XDG_RUNTIME_DIR=$root/run" "/proc/$p/environ"; then echo "this copy started a desktop helper: $(ps -o pid=,args= -p "$p" || true)"; helpers=$((helpers + 1))
      else echo "not this copy, reported only: helper $(ps -o pid=,args= -p "$p" || echo "$p (gone)")"; fi
    done
    echo "core dumps of this copy since its start: $ours; desktop helpers it started: $helpers"
    [ "$ours" = 0 ] && [ "$helpers" = 0 ] || exit 1
    ;;
  *) sed -n 2,9p "$0"; exit 2 ;;
esac
