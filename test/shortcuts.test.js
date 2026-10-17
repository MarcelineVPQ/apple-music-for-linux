// Global shortcuts, the running part (shortcuts.js + portal-shortcuts.js) with stubs: a fake
// globalShortcut for X11 and a fake portal connection for Wayland (no real bus, no key grabs). The
// portal path was also checked live against the real xdg-desktop-portal 1.21 frontend with a stub
// backend on a private bus, and the X11 path with real key presses on an isolated copy (Xvfb).
const test = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('events')
const P = require('../portal-shortcuts')
const { createShortcuts } = require('../shortcuts')

function fakeGlobalShortcut(taken = []) {
  const held = new Map()
  return {
    held,
    suspended: false,
    register(k, fn) { if (taken.includes(k) || held.has(k)) return false; held.set(k, fn); return true },
    unregister(k) { held.delete(k) },
    setSuspended(v) { this.suspended = v }
  }
}

// a portal on a fake connection: o.version (0 = none), o.bindCode (0 ok, 1 cancelled), o.triggers
function fakePortal(o = {}) {
  const conn = new EventEmitter()
  conn.uniqueName = ':1.7'
  conn.closed = false
  conn.calls = []
  conn.addMatch = async () => []
  conn.close = () => { if (!conn.closed) { conn.closed = true; conn.emit('close', null) } }
  const respond = (path, code, results) => setImmediate(() => conn.emit('signal', { type: 'signal', path, interface: 'org.freedesktop.portal.Request', member: 'Response', body: [code, results] }))
  conn.call = async (m) => {
    conn.calls.push(m.member)
    if (conn.closed) throw new Error('connection closed')
    if (m.member === 'Register') { if (o.noRegistry) throw new Error('UnknownInterface'); return [] }
    if (m.member === 'Get') { if (!o.version) throw new Error('org.freedesktop.DBus.Error.InvalidArgs: No such interface'); return [o.version] }
    const tok = m.member === 'CreateSession' ? m.body[0].handle_token[1] : m.member === 'BindShortcuts' ? m.body[3].handle_token[1] : ''
    const path = P.requestPath(conn.uniqueName, tok)
    if (m.member === 'CreateSession') { conn.session = '/org/freedesktop/portal/desktop/session/1_7/' + m.body[0].session_handle_token[1]; respond(path, 0, { session_handle: conn.session }) }
    if (m.member === 'BindShortcuts') {
      conn.bound = m.body[1]
      if (!o.bindHangs) respond(path, o.bindCode || 0, { shortcuts: m.body[1].map(([id]) => [id, { description: id, trigger_description: (o.triggers || {})[id] || '' }]) })
    }
    if (m.member === 'ConfigureShortcuts' && o.noConfigure) throw new Error('NotSupported')
    return [path]
  }
  conn.fire = (id, session) => conn.emit('signal', { type: 'signal', path: P.PATH, interface: P.IFACE, member: 'Activated', body: [session || conn.session, id, 1, {}] })
  return conn
}

function setup(o = {}) {
  const acted = []
  let changes = 0
  const timers = []
  const conns = []
  let clock = 0
  const sc = createShortcuts({
    globalShortcut: o.gs || fakeGlobalShortcut(),
    platform: 'linux',
    env: o.env || { DISPLAY: ':0' },
    appId: 'io.github.MarcelineVPQ.Sonata',
    openConnection: async () => { if (o.noBus) throw new Error('no session bus address'); const c = fakePortal(o.portal); conns.push(c); return c },
    act: (id) => acted.push(id),
    onChange: () => { changes++ },
    log: () => {},
    now: () => (clock += 1000),
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length },
    clearTimeout: (i) => { if (timers[i - 1]) timers[i - 1].fn = null }
  })
  return { sc, acted, conns, timers, changes: () => changes }
}
const tick = () => new Promise((r) => setImmediate(r))
const settle = async () => { for (let i = 0; i < 10; i++) await tick() }
const WAYLAND = { XDG_SESSION_TYPE: 'wayland', WAYLAND_DISPLAY: 'wayland-0', XDG_CURRENT_DESKTOP: 'KDE' }

test('X11: on grabs the four keys, a press acts, off lets go; nothing is held while off', () => {
  const gs = fakeGlobalShortcut()
  const { sc, acted } = setup({ gs })
  sc.apply(false, {})
  assert.equal(gs.held.size, 0)
  assert.equal(sc.snapshot().backend.kind, 'x11')
  sc.apply(true, { next: 'Ctrl+Alt+N' })
  assert.deepEqual([...gs.held.keys()].sort(), ['Ctrl+Alt+N', 'Ctrl+Alt+P', 'Ctrl+Alt+PageUp', 'Ctrl+Alt+Y'])
  gs.held.get('Ctrl+Alt+N')()
  gs.held.get('Ctrl+Alt+Y')()
  assert.deepEqual(acted, ['next', 'lyrics'])
  const snap = sc.snapshot()
  assert.equal(snap.phase, 'on')
  assert.deepEqual(snap.rows.find((r) => r.id === 'next'), { id: 'next', label: 'Next song', key: 'Ctrl+Alt+N', state: 'ok', suggested: 'Ctrl+Alt+PageDown', changed: true })
  assert.equal(snap.anyChanged, true)
  // a changed key: the old one is let go
  sc.apply(true, {})
  assert.ok(!gs.held.has('Ctrl+Alt+N') && gs.held.has('Ctrl+Alt+PageDown'))
  sc.apply(false, {})
  assert.equal(gs.held.size, 0)
  sc.apply(true, {}); sc.stop()
  assert.equal(gs.held.size, 0, 'quit lets go too')
})

test('X11: a key another app holds is marked and named; suspend is passed on', () => {
  const gs = fakeGlobalShortcut(['Ctrl+Alt+P'])
  const { sc } = setup({ gs })
  sc.apply(true, {})
  const snap = sc.snapshot()
  assert.equal(snap.rows[0].state, 'taken')
  assert.match(snap.message, /Another app holds one of these keys: pick another for Play \/ Pause/)
  assert.ok(!('play-pause' in snap.keys))
  sc.suspend(true); assert.equal(gs.suspended, true)
  sc.suspend(false); assert.equal(gs.suspended, false)
})

test('Wayland with the portal: probe, session, bind with suggestions, Activated acts, held keys count once', async () => {
  const { sc, acted, conns } = setup({ env: WAYLAND, portal: { version: 2, triggers: { 'play-pause': 'Ctrl+Alt+P', next: 'Meta+N' } } })
  assert.equal(sc.snapshot().backend.kind, 'unknown')
  await sc.probe()
  assert.equal(conns[0].closed, true, 'the probe connection closes')
  assert.equal(sc.snapshot().backend.kind, 'portal')
  sc.apply(true, {})
  assert.equal(sc.snapshot().phase, 'starting')
  await settle()
  const c = conns[1]
  assert.deepEqual(c.calls, ['Register', 'Get', 'CreateSession', 'BindShortcuts'])
  assert.deepEqual(c.bound.map(([id, v]) => [id, v.preferred_trigger[1]]), [['play-pause', 'CTRL+ALT+p'], ['next', 'CTRL+ALT+Page_Down'], ['previous', 'CTRL+ALT+Page_Up'], ['lyrics', 'CTRL+ALT+y']])
  const snap = sc.snapshot()
  assert.equal(snap.phase, 'on')
  assert.deepEqual(snap.rows.map((r) => [r.id, r.key, r.state]), [['play-pause', 'Ctrl+Alt+P', 'ok'], ['next', 'Meta+N', 'ok'], ['previous', '', 'unset'], ['lyrics', '', 'unset']])
  assert.equal(snap.canConfigure, true)
  assert.equal(snap.anyChanged, false, 'Sonata\'s own keys don\'t apply on Wayland')
  c.fire('next')
  c.fire('play-pause')
  c.fire('evil-id')
  c.fire('next', '/some/other/session')
  assert.deepEqual(acted, ['next', 'play-pause'])
  // the desktop changed a key
  c.emit('signal', { type: 'signal', interface: P.IFACE, member: 'ShortcutsChanged', body: [c.session, [['previous', { trigger_description: 'Meta+B' }]]] })
  assert.equal(sc.snapshot().rows.find((r) => r.id === 'previous').key, 'Meta+B')
  assert.equal(await sc.configure(), true)
  sc.apply(false, {})
  assert.equal(c.closed, true, 'off closes the session (with its connection)')
  assert.equal(sc.snapshot().phase, 'off')
})

test('Wayland without the portal: none, a truthful reason, the switch can\'t start anything', async () => {
  const { sc, conns } = setup({ env: WAYLAND, portal: { version: 0 } })
  sc.apply(true, {})
  await settle()
  const snap = sc.snapshot()
  assert.deepEqual(snap.backend, { kind: 'none', reason: 'no-portal' })
  assert.equal(snap.phase, 'off')
  assert.match(snap.unavailable, /no GlobalShortcuts portal/)
  assert.ok(snap.rows.every((r) => r.state === 'off'))
  assert.equal(conns.length, 1, 'only the probe')
  // no session bus at all reads the same
  const nb = setup({ env: WAYLAND, noBus: true })
  await nb.sc.probe()
  assert.equal(nb.sc.snapshot().backend.reason, 'no-portal')
})

test('Wayland: a cancelled dialog says so and offers Ask again, which starts a new session', async () => {
  const { sc, conns } = setup({ env: WAYLAND, portal: { version: 1, bindCode: 1 } })
  await sc.probe()
  sc.apply(true, {})
  await settle()
  let snap = sc.snapshot()
  assert.equal(snap.phase, 'cancelled')
  assert.match(snap.message, /closed without saving/)
  assert.equal(snap.canAskAgain, true)
  assert.equal(snap.canConfigure, false, 'version 1 has no editor')
  sc.askAgain()
  await settle()
  assert.equal(conns[1].closed, true)
  assert.equal(conns.length, 3)
})

test('Wayland: the desktop closing the session retries a few times, then asks the user', async () => {
  const o = { env: WAYLAND, portal: { version: 2 } }
  const { sc, conns, timers } = setup(o)
  await sc.probe()
  sc.apply(true, {})
  await settle()
  // a loss with a working reconnect: back on, the count starts over
  let c = conns[conns.length - 1]
  c.emit('signal', { type: 'signal', path: c.session, interface: 'org.freedesktop.portal.Session', member: 'Closed', body: [] })
  assert.equal(sc.snapshot().phase, 'error')
  assert.match(sc.snapshot().message, /tries again/)
  assert.equal(timers[0].ms, 10000)
  timers[0].fn()
  await settle()
  assert.equal(sc.snapshot().phase, 'on')
  // then the desktop's service is gone for good: three more tries, then Ask again
  c = conns[conns.length - 1]
  o.noBus = true
  c.emit('signal', { type: 'signal', path: c.session, interface: 'org.freedesktop.portal.Session', member: 'Closed', body: [] })
  for (let i = 1; i <= 3; i++) { timers[i].fn(); await settle() }
  assert.equal(timers.length, 4, 'no fourth retry in a row')
  assert.equal(sc.snapshot().phase, 'error')
  assert.match(sc.snapshot().message, /Ask again to reconnect/)
  assert.equal(sc.snapshot().canAskAgain, true)
})

test('Wayland: off while the desktop\'s dialog is still open drops the late answer', async () => {
  const { sc, conns } = setup({ env: WAYLAND, portal: { version: 2, bindHangs: true } })
  await sc.probe()
  sc.apply(true, {})
  await settle()
  assert.equal(sc.snapshot().phase, 'starting')
  sc.apply(false, {})
  await settle()
  assert.equal(conns[1].closed, true)
  assert.equal(sc.snapshot().phase, 'off')
})

test('portal: a desktop with version 2 but no editor -> configure false, the panel hides the button', async () => {
  const { sc } = setup({ env: WAYLAND, portal: { version: 2, noConfigure: true, noRegistry: true } })
  await sc.probe()
  sc.apply(true, {})
  await settle()
  assert.equal(sc.snapshot().phase, 'on', 'no host registry is fine')
  assert.equal(await sc.configure(), false)
  assert.equal(sc.snapshot().canConfigure, false)
})

test('wiring: main acts on the four ids, checks the panel\'s arguments, stops on quit; the files ship', () => {
  const fs = require('fs')
  const path = require('path')
  const src = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8')
  assert.match(src, /command === 'shortcut-key' && shortcutsModel\.IDS\.includes\(a\) && \(b === null \|\| \(typeof b === 'string' && b\.length <= 40\)\)/)
  assert.match(src, /command === 'shortcut-capture' && typeof a === 'boolean'/)
  assert.match(src, /'play-pause': \(\) => playerCommand\('playPause'\)/)
  assert.match(src, /if \(shortcuts\) shortcuts\.stop\(\)/)
  assert.match(src, /if \(!shortcutCapture\) windowShortcut\(input\)/)
  const files = require('../package.json').build.files
  for (const f of ['shortcuts.js', 'shortcuts-model.js', 'portal-shortcuts.js', 'dbus-wire.js']) assert.ok(files.includes(f), f)
  assert.match(fs.readFileSync(path.join(__dirname, '..', 'panel.html'), 'utf8'), /<script src="shortcuts-model\.js"><\/script>\s*<script src="panel-model\.js">/)
})
