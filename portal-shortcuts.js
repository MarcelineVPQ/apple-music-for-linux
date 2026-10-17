// The XDG GlobalShortcuts portal (org.freedesktop.portal.GlobalShortcuts), Sonata's global shortcuts on
// Wayland. KDE Plasma and GNOME implement it: the desktop owns the keys, shows its own dialog when
// Sonata asks for shortcuts (BindShortcuts), remembers the choice per app, and tells Sonata when one
// is pressed (Activated). The session is tied to the D-Bus connection that made it (dbus-wire.js),
// so it stays open while the shortcuts are on and closes with them.
//
// Flow: Registry.Register (our app id, so the desktop names and remembers us; optional) -> version
// -> CreateSession -> BindShortcuts (the desktop's dialog the first time; later it answers with the
// keys the user chose) -> Activated / ShortcutsChanged signals. Version 2 adds ConfigureShortcuts (the
// desktop's own editor for our shortcuts). Pure apart from the connection, which is passed in, so
// node --test drives it with a stub portal.
'use strict'

const DEST = 'org.freedesktop.portal.Desktop'
const PATH = '/org/freedesktop/portal/desktop'
const IFACE = 'org.freedesktop.portal.GlobalShortcuts'

let tokenN = 0
const token = (p) => 'sonata_' + p + '_' + process.pid + '_' + (++tokenN)
// the Request object a call will answer on (the portal's documented path)
const requestPath = (unique, tok) => PATH + '/request/' + String(unique).replace(/^:/, '').replace(/\./g, '_') + '/' + tok

// The portal's GlobalShortcuts version: 0 when there's no portal or it lacks the interface.
// error: NOT-WORTH — no portal, no interface, no answer: all mean "not available" (0)
async function portalVersion(conn) {
  try {
    const [v] = await conn.call({ destination: DEST, path: PATH, interface: 'org.freedesktop.DBus.Properties', member: 'Get', signature: 'ss', body: [IFACE, 'version'] }, { timeoutMs: 5000 })
    return Number.isInteger(v) && v > 0 ? v : 0
  } catch (e) { return 0 }
}

// One portal request: subscribe to its Response first (the spec's order), make the call, resolve with
// { code, results } (0 = done, 1 = the user cancelled, 2 = other). `wait` false: no timeout (a dialog
// may wait for the user as long as it likes).
async function request(conn, member, signature, body, tok, opts) {
  const path = requestPath(conn.uniqueName, tok)
  await conn.addMatch("type='signal',interface='org.freedesktop.portal.Request',member='Response',path='" + path + "'")
  return new Promise((resolve, reject) => {
    const paths = new Set([path])
    let timer = null
    const done = (fn, v) => { if (timer) clearTimeout(timer); conn.removeListener('signal', onSignal); conn.removeListener('close', onClose); fn(v) }
    const onSignal = (m) => {
      if (m.interface === 'org.freedesktop.portal.Request' && m.member === 'Response' && paths.has(m.path)) {
        done(resolve, { code: m.body[0], results: m.body[1] || {} })
      }
    }
    const onClose = () => done(reject, new Error(member + ': the connection closed'))
    // lifetime: OK — both listeners go when the request is answered, times out or the connection closes
    conn.on('signal', onSignal)
    conn.on('close', onClose)
    if (opts && opts.timeoutMs) timer = setTimeout(() => done(reject, new Error(member + ': no answer')), opts.timeoutMs)   // lifetime: OK — cleared in done()
    conn.call({ destination: DEST, path: PATH, interface: IFACE, member, signature, body })
      .then(([handle]) => { if (handle) paths.add(handle) })   // an old portal may answer on another path
      .catch((err) => done(reject, err))   // error: PASSES-ON — the caller's promise rejects
  })
}

// shortcuts: [{ id, description, trigger }] (trigger in the portal's form, e.g. "CTRL+ALT+p").
// -> [[id, { description: [s], preferred_trigger: [s] }]] as BindShortcuts takes them
const bindList = (shortcuts) => shortcuts.map((s) => [s.id, { description: ['s', s.description], preferred_trigger: ['s', s.trigger] }])
// the portal's a(sa{sv}) answer -> { id: trigger description ('' when the user left one unset) }
function triggersOf(list) {
  const out = {}
  // loop: NOT-WORTH — one entry per bound shortcut (4)
  for (const [id, o] of Array.isArray(list) ? list : []) out[id] = (o && typeof o.trigger_description === 'string') ? o.trigger_description : ''
  return out
}

// Opens a session and binds the shortcuts. o: { conn, appId, shortcuts, onActivated(id), onChanged(triggers), onClosed(), log }
// -> { version, triggers, cancelled, configure(), close() }; rejects with err.code 'no-portal' when
// the desktop has no GlobalShortcuts portal.
async function openSession(o) {
  const conn = o.conn
  const log = o.log || (() => {})
  if (o.appId) {
    // error: LOGGED-OK — an older portal without the host registry, or an app id it doesn't know: the desktop names us from the connection instead
    try {
      await conn.call({ destination: DEST, path: PATH, interface: 'org.freedesktop.host.portal.Registry', member: 'Register', signature: 'sa{sv}', body: [o.appId, {}] }, { timeoutMs: 5000 })
    } catch (e) { log('portal: app id not registered (' + e.message + ')') }
  }
  const version = await portalVersion(conn)
  if (!version) { const e = new Error('The desktop has no GlobalShortcuts portal'); e.code = 'no-portal'; throw e }
  let session = ''
  let closed = false
  const onClose = () => {
    if (closed) return
    closed = true
    conn.removeListener('signal', onSignal)
    conn.close()   // the desktop ended the session (or the bus went): the connection has nothing left to do
    if (o.onClosed) o.onClosed()
  }
  const onSignal = (m) => {
    if (!session) return
    if (m.interface === 'org.freedesktop.portal.Session' && m.member === 'Closed' && m.path === session) { onClose(); return }
    if (m.interface !== IFACE || m.body[0] !== session) return
    if (m.member === 'Activated' && typeof m.body[1] === 'string') o.onActivated(m.body[1])
    else if (m.member === 'ShortcutsChanged') o.onChanged(triggersOf(m.body[1]))
  }
  await conn.addMatch("type='signal',sender='" + DEST + "',interface='" + IFACE + "'")
  await conn.addMatch("type='signal',sender='" + DEST + "',interface='org.freedesktop.portal.Session',member='Closed'")
  // lifetime: OK — one 'signal' and one 'close' listener per session; removed when it closes
  conn.on('signal', onSignal)
  conn.on('close', onClose)
  const tc = token('c')
  const created = await request(conn, 'CreateSession', 'a{sv}', [{ handle_token: ['s', tc], session_handle_token: ['s', token('s')] }], tc, { timeoutMs: 15000 })
  if (created.code !== 0 || typeof created.results.session_handle !== 'string') throw new Error('CreateSession refused (' + created.code + ')')
  session = created.results.session_handle
  const tb = token('b')
  const bound = await request(conn, 'BindShortcuts', 'oa(sa{sv})sa{sv}', [session, bindList(o.shortcuts), '', { handle_token: ['s', tb] }], tb)
  return {
    version,
    session,
    cancelled: bound.code === 1,
    failed: bound.code > 1,
    triggers: bound.code === 0 ? triggersOf(bound.results.shortcuts) : {},
    // version 2: the desktop's own editor for these shortcuts. -> true when the desktop took the request
    async configure() {
      if (version < 2 || closed) return false
      // error: LOGGED-OK — a desktop that lists version 2 without the editor: false, the panel says where to change them
      try {
        await conn.call({ destination: DEST, path: PATH, interface: IFACE, member: 'ConfigureShortcuts', signature: 'osa{sv}', body: [session, '', {}] }, { timeoutMs: 10000 })
        return true
      } catch (e) { log('portal: ConfigureShortcuts failed (' + e.message + ')'); return false }
    },
    // ends the session with the connection (the portal closes a session whose connection is gone);
    // onClosed is not called for a close Sonata asked for
    close() {
      if (closed) return
      closed = true
      conn.removeListener('signal', onSignal)
      conn.close()
    }
  }
}

module.exports = { DEST, PATH, IFACE, requestPath, portalVersion, request, bindList, triggersOf, openSession }
