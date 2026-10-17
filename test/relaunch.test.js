// Relaunch after an update (relaunch.js): the new copy gets the session's environment without any
// AppImage mount on PATH (0.15.35-dev.1 started without a window: a dead mount made spawn throw ENOTCONN).
const test = require('node:test')
const assert = require('node:assert/strict')
const R = require('../relaunch')
const fs = require('fs')
const path = require('path')

const M34 = '/tmp/.mount_SonataDGi4iQ'
const M35 = '/tmp/.mount_SonatanPnKMP'

test('AppImage mounts are recognised by the runtime\'s .mount_ name', () => {
  assert.equal(R.isAppImageMount(M34), true)
  assert.equal(R.isAppImageMount(M34 + '/usr/sbin'), true)
  assert.equal(R.isAppImageMount('/usr/bin'), false)
  assert.equal(R.isAppImageMount('/home/me/.mount_notes-are-not/x'), true, 'any .mount_ dir counts')
  assert.equal(R.isAppImageMount('/home/me/mount_x'), false)
  assert.equal(R.isAppImageMount(''), false)
})

test('PATH after two relaunches: the dead earlier mounts go, our own stays first, repeats and blanks go', () => {
  const inherited = [M35, M35 + '/usr/sbin', M34, M34 + '/usr/sbin', '/tmp/.mount_Sonatapzfevu', '/tmp/.mount_Sonatapzfevu/usr/sbin',
    '/home/me/.local/bin', '', '/usr/bin', '/usr/bin', '/bin'].join(':')
  assert.equal(R.cleanPathList(inherited, M35), [M35, M35 + '/usr/sbin', '/home/me/.local/bin', '/usr/bin', '/bin'].join(':'))
  assert.equal(R.cleanPathList(inherited, M35 + '/'), [M35, M35 + '/usr/sbin', '/home/me/.local/bin', '/usr/bin', '/bin'].join(':'), 'a trailing slash on APPDIR')
  assert.equal(R.cleanPathList(inherited, ''), ['/home/me/.local/bin', '/usr/bin', '/bin'].join(':'), 'for the relaunch: no mount at all')
  assert.equal(R.cleanPathList('/tmp/.mount_SonataAB:/tmp/.mount_SonataABC/usr/sbin', '/tmp/.mount_SonataAB'), '/tmp/.mount_SonataAB',
    'a mount whose name only starts like ours is not ours')
  assert.equal(R.cleanPathList(undefined, M35), '')
})

test('relaunch env: session variables only, PATH without mounts, nothing from Chromium or AppRun', () => {
  const env = {
    DISPLAY: ':0', WAYLAND_DISPLAY: 'wayland-0', XDG_RUNTIME_DIR: '/run/user/1000', DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus',
    XDG_CURRENT_DESKTOP: 'KDE', XDG_SESSION_TYPE: 'wayland', KDE_FULL_SESSION: 'true', HOME: '/home/me', LANG: 'en_US.UTF-8',
    PATH: M34 + ':' + M34 + '/usr/sbin:/usr/bin:/bin',
    LD_LIBRARY_PATH: M34 + '/usr/lib', APPDIR: M34, APPIMAGE: '/home/me/Downloads/Sonata.AppImage', CHROME_DESKTOP: 'x.desktop',
    GSETTINGS_SCHEMA_DIR: M34 + '/usr/share/glib-2.0/schemas', XDG_DATA_DIRS: M34 + '/usr/share/:/usr/share'
  }
  const out = R.relaunchEnv(env)
  assert.deepEqual(out, {
    DISPLAY: ':0', WAYLAND_DISPLAY: 'wayland-0', XDG_RUNTIME_DIR: '/run/user/1000', DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus',
    XDG_CURRENT_DESKTOP: 'KDE', XDG_SESSION_TYPE: 'wayland', KDE_FULL_SESSION: 'true', HOME: '/home/me', LANG: 'en_US.UTF-8',
    PATH: '/usr/bin:/bin'
  })
  assert.deepEqual(R.relaunchEnv({ PATH: M34 }), {}, 'a PATH of mounts only is left to the user manager')
  assert.deepEqual(R.relaunchEnv({}), {})
})

test('relaunch args: the flags of this run, without --hidden and Chromium\'s per-process switches', () => {
  assert.deepEqual(R.relaunchArgs(['/tmp/.mount_X/apple-music-for-linux', '--ozone-platform=x11', '--disable-gpu-sandbox', '--hidden', '--type=zygote']),
    ['--ozone-platform=x11', '--disable-gpu-sandbox'])
  assert.deepEqual(R.relaunchArgs(['/tmp/.mount_X/apple-music-for-linux']), [], 'a menu launch has none: Electron picks the platform as it did')
  assert.deepEqual(R.relaunchArgs(undefined), [])
})

test('systemd-run: transient user unit, ExitType=cgroup like KDE\'s launcher, env as --setenv, target then flags', () => {
  const a = R.systemdRunArgs({ target: '/home/me/Downloads/Sonata.AppImage', args: ['--ozone-platform=x11'], env: { DISPLAY: ':0', PATH: '/usr/bin' }, unit: 'sonata-relaunch-1' })
  assert.deepEqual(a, ['--user', '--collect', '--unit=sonata-relaunch-1', '-p', 'ExitType=cgroup',
    '--setenv=DISPLAY=:0', '--setenv=PATH=/usr/bin', '--', '/home/me/Downloads/Sonata.AppImage', '--ozone-platform=x11'])
  const old = R.systemdRunArgs({ target: '/x', env: {}, unit: 'u', exitTypeCgroup: false })
  assert.deepEqual(old, ['--user', '--collect', '--unit=u', '--', '/x'], 'the retry for systemd before 250')
  assert.ok(!a.some((x) => /APPDIR|LD_LIBRARY_PATH|\.mount_/.test(x)))
})

test('shell fallback: target and flags are arguments, never pasted into the script', () => {
  const a = R.shellArgs('/home/me/My "Apps"/Sonata.AppImage', ['--x=$(rm -rf ~)'])
  assert.deepEqual(a, ['-c', 'sleep 0.5; exec "$0" "$@"', '/home/me/My "Apps"/Sonata.AppImage', '--x=$(rm -rf ~)'])
})

// main.js wiring (source checks: Electron isn't loaded in tests)
const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8')

test('main.js: startup steps before the window are guarded, so the window and tray always come', () => {
  const ready = main.slice(main.indexOf('app.whenReady().then('))
  assert.match(ready, /startupStep\('locale and theme', initLocaleAndTheme\)/)
  assert.match(ready, /startupStep\('window', createWindow\)/)
  assert.match(ready, /startupStep\('tray', createTray\)/)
  assert.doesNotMatch(ready.slice(0, ready.indexOf("startupStep('window'")), /^\s*initLocaleAndTheme\(\)/m)
  assert.match(ready, /\}\)\.catch\(\(e\) => \{[\s\S]*?createWindow/, 'a throw outside the steps still brings up the window')
})

test('main.js: the desktop-scheme spawns can\'t throw out of startup', () => {
  const read = main.slice(main.indexOf('function readDesktopScheme'), main.indexOf('function watchDesktopScheme'))
  assert.match(read, /try \{\s*execFile\('gdbus'/)
  assert.match(read, /schemeSpawnFailed\(e\)/)
})

test('main.js: a second launch makes the main window when there is none', () => {
  const si = main.slice(main.indexOf("app.on('second-instance'"), main.indexOf('function startupStep'))
  assert.match(si, /if \(!mainWindow \|\| mainWindow\.isDestroyed\(\)\) \{\s*startupStep\('window', createWindow\)/)
})

test('main.js: the relaunch uses relaunch.js (no raw PATH pass-through) and strips inherited mounts at start', () => {
  const r = main.slice(main.indexOf('function restartIntoUpdate'), main.indexOf('function pruneOldAppImages'))
  assert.match(r, /relaunch\.relaunchEnv\(process\.env\)/)
  assert.match(r, /relaunch\.systemdRunArgs\(/)
  assert.doesNotMatch(r, /'PATH'\]/)
  assert.match(main, /process\.env\[v\] = relaunch\.cleanPathList\(process\.env\[v\], process\.env\.APPDIR/)
})

test('package.json ships relaunch.js (build.files is an explicit list)', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'))
  assert.ok(pkg.build.files.includes('relaunch.js'))
})
