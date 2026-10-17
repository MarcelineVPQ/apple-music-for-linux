// Starting Sonata again after an update (pure: env, argv and paths in; a command out).
//
// An AppImage runs from a FUSE mount (/tmp/.mount_SonataXXXXXX), and its AppRun puts that mount at the
// front of PATH (and LD_LIBRARY_PATH). The mount lives only as long as that run. Up to 0.15.35-dev.1 the
// relaunch passed Sonata's own PATH on, so each relaunched copy inherited the mounts of every copy
// before it. A mount whose FUSE helper was killed before it could unmount (the systemd-run unit stopped
// it the moment the old copy's main process left) answers ENOTCONN, and execvp stops at the first
// ENOTCONN on PATH: `execFile('gdbus')` threw "spawn ENOTCONN" at startup, before the window and the
// tray were made (0.15.34 → 0.15.35-dev.1, 2026-10-16).

// a PATH-style entry inside an AppImage's mount (the runtime names it .mount_<name><random>)
function isAppImageMount(dir) {
  return /(^|\/)\.mount_[^/]+(\/|$)/.test(String(dir || ''))
}

// a PATH-style list without other AppImages' mounts (dead once that run ended), empty entries or
// repeats. Entries inside `keepDir` (this run's own $APPDIR, alive while we are) stay.
function cleanPathList(list, keepDir) {
  const keep = keepDir ? String(keepDir).replace(/\/+$/, '') : ''
  const seen = new Set()
  const out = []
  // loop: NOT-WORTH — the entries of one PATH-style variable
  for (const d of String(list || '').split(':')) {
    if (!d || seen.has(d)) continue
    if (isAppImageMount(d) && !(keep && (d === keep || d.startsWith(keep + '/')))) continue
    seen.add(d)
    out.push(d)
  }
  return out.join(':')
}

// the graphical session's variables a relaunch carries over (the user manager usually has them too;
// these win when it doesn't, e.g. a desktop that doesn't import its environment into systemd)
const SESSION_VARS = ['DISPLAY', 'WAYLAND_DISPLAY', 'XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS',
  'XDG_CURRENT_DESKTOP', 'XDG_SESSION_TYPE', 'XDG_SESSION_DESKTOP', 'DESKTOP_SESSION',
  'KDE_FULL_SESSION', 'KDE_SESSION_VERSION', 'XAUTHORITY', 'ELECTRON_OZONE_PLATFORM_HINT',
  'HOME', 'LANG', 'PATH']

// the environment for the new copy: the session's variables only (never this process's Chromium and
// AppRun additions), PATH without any AppImage mount, ours included (ours ends when we exit)
function relaunchEnv(env) {
  const out = {}
  // loop: NOT-WORTH — a fixed list of 15 names
  for (const v of SESSION_VARS) {
    if (!env[v]) continue
    out[v] = v === 'PATH' ? cleanPathList(env[v], '') : env[v]
  }
  if (out.PATH === '') delete out.PATH
  return out
}

// the flags this copy was started with, for the new one (--ozone-platform=x11, --disable-gpu-sandbox…).
// Not --hidden: a relaunch follows "Restart now", so the window comes back. Not Chromium's own
// per-process switches.
function relaunchArgs(argv) {
  return (argv || []).slice(1).filter((a) => typeof a === 'string' && a !== '--hidden' && !/^--type=/.test(a))
}

// `systemd-run` arguments: a transient user service, gone when it ends (--collect). ExitType=cgroup as
// KDE's own launcher sets it: the unit lasts until its last process is gone, so the AppImage's FUSE helper
// can unmount by itself after Sonata quits instead of being killed with the mount still in place.
// cwd: the folder to start in (a run from source passes `electron .`: the "." is that folder)
function systemdRunArgs({ target, args = [], env = {}, unit, exitTypeCgroup = true, cwd = '' }) {
  const setenv = Object.keys(env).map((k) => '--setenv=' + k + '=' + env[k])
  return ['--user', '--collect', '--unit=' + unit,
    ...(exitTypeCgroup ? ['-p', 'ExitType=cgroup'] : []),
    ...(cwd ? ['--working-directory=' + cwd] : []),
    ...setenv, '--', target, ...args]
}

// when there is no systemd: a detached shell that waits for us to go, then becomes the new copy.
// The target and flags go as arguments ("$0" "$@"), never pasted into the script.
function shellArgs(target, args = []) {
  return ['-c', 'sleep 0.5; exec "$0" "$@"', target, ...args]
}

module.exports = { isAppImageMount, cleanPathList, SESSION_VARS, relaunchEnv, relaunchArgs, systemdRunArgs, shellArgs }
