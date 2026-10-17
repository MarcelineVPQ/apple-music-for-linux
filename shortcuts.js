// Global shortcuts, the running part: play/pause, next, previous and the lyrics window from anywhere.
// X11: Electron's globalShortcut grabs the keys (Sonata's own, changeable in Settings). Wayland: no
// app may read another window's keys, so the desktop's GlobalShortcuts portal does it
// (portal-shortcuts.js): the desktop asks the user once, owns the keys, and tells Sonata when one is
// pressed; the keys are changed in the desktop's own settings. No portal on Wayland: the section says
// so and the switch stays off. Electron, the connection and the clock are injected (node --test drives
// this with stubs); the rules are in shortcuts-model.js.
//
// Cost: nothing while off. On X11, key grabs held by the X server (no process, no timer). On
// Wayland, one idle D-Bus socket that wakes only when the desktop sends a shortcut signal.
'use strict'
const M = require('./shortcuts-model')
const portalLib = require('./portal-shortcuts')

const RETRY_MS = 10000
const RETRIES = 3

// d: { globalShortcut, platform, env, appId, openConnection() -> Promise<conn>, act(id), onChange(), log,
//      now() -> ms, setTimeout, clearTimeout }
function createShortcuts(d) {
  let portalVersion = null    // the desktop's GlobalShortcuts version; null until asked (Wayland only)
  let probing = null
  let enabled = false
  let keys = M.bindings({})   // X11: the keys Sonata grabs
  let taken = new Set()       // X11: ids whose key another app holds
  let portal = null           // Wayland: the open session
  let phase = 'off'           // 'off' | 'starting' | 'on' | 'cancelled' | 'error'
  let message = ''
  let triggers = {}           // Wayland: id -> the desktop's words for its key ('' = left unset)
  let configureFailed = false
  let gen = 0                 // bumps whenever the portal side starts or stops: late answers are dropped
  let connecting = false      // a portalOn() is in flight
  let pendingConn = null      // its connection, closed by portalOff() (a dialog may wait for the user)
  let retries = 0
  let retryTimer = null
  const guard = M.repeatGuard(300)
  const fire = (id) => { if (M.IDS.includes(id) && guard(id, d.now())) d.act(id) }
  const backend = () => M.chooseBackend({ platform: d.platform, env: d.env, portalVersion })

  // Wayland: ask once whether the desktop has the portal (one short connection)
  // error: LOGGED-OK — no session bus or no answer: "no portal", the section says so
  function probe() {
    if (portalVersion !== null) return Promise.resolve(portalVersion)
    if (!probing) {
      probing = (async () => {
        let conn = null
        try {
          conn = await d.openConnection()
          portalVersion = await portalLib.portalVersion(conn)
        } catch (e) {
          // error: LOGGED-OK — no bus: "no portal", the section says so
          portalVersion = 0
          d.log('shortcuts: no session bus (' + e.message + ')')
        } finally { if (conn) conn.close() }
        probing = null
        d.onChange()
        return portalVersion
      })()
    }
    return probing
  }

  // --- X11 ---
  function x11Off() {
    // loop: NOT-WORTH — 4 actions
    for (const a of M.ACTIONS) {
      // error: NOT-WORTH — a key that was never registered
      try { d.globalShortcut.unregister(keys[a.id]) } catch (e) { /* nothing held */ }
    }
    taken = new Set()
  }
  function x11On(next) {
    x11Off()
    keys = next
    // loop: NOT-WORTH — 4 actions, when the switch or a key changes
    for (const a of M.ACTIONS) {
      let ok = false
      // error: SHOWN — a key the X server won't give (another app holds it): that row says "Taken by another app"
      try { ok = d.globalShortcut.register(keys[a.id], () => fire(a.id)) } catch (e) { ok = false }
      if (!ok) taken.add(a.id)
    }
    phase = 'on'
    message = taken.size ? 'Another app holds ' + (taken.size === 1 ? 'one of these keys' : 'some of these keys') + ': pick another for ' + M.ACTIONS.filter((a) => taken.has(a.id)).map((a) => a.label).join(', ') + '.' : ''
  }

  // --- Wayland: the portal ---
  async function portalOn() {
    const my = ++gen
    connecting = true
    phase = 'starting'
    message = ''
    configureFailed = false
    d.onChange()
    let conn = null
    try {
      conn = await d.openConnection()
      if (my !== gen) { conn.close(); return }
      pendingConn = conn
      const s = await portalLib.openSession({
        conn, appId: d.appId, shortcuts: M.portalShortcuts(), log: d.log,
        onActivated: fire,
        onChanged: (t) => { if (my === gen) { triggers = t; d.onChange() } },
        onClosed: () => lost(my)
      })
      if (my !== gen) { s.close(); return }
      portal = s
      triggers = s.triggers
      retries = 0
      phase = s.cancelled ? 'cancelled' : s.failed ? 'error' : 'on'
      message = s.cancelled ? 'The desktop\'s shortcut dialog was closed without saving, so no keys are set. Ask again to see it once more.'
        : s.failed ? 'The desktop refused the shortcuts.' : ''
    } catch (e) {
      // error: SHOWN — no portal or no session: the section's message; Ask again retries
      if (conn) conn.close()
      if (my !== gen) return
      portal = null
      if (e.code === 'no-portal') { portalVersion = 0; phase = 'off'; message = '' }
      else {
        phase = 'error'
        message = 'Sonata couldn\'t reach the desktop\'s shortcut service (' + e.message + ').'
        if (retries > 0) retryLater(my)   // a reconnect that failed: the next try, while tries are left
      }
      d.log('shortcuts: portal: ' + e.message)
    } finally { if (my === gen) { connecting = false; pendingConn = null } }
    d.onChange()
  }
  // the desktop ended the session (its portal restarted, the bus went): try again a few times
  function lost(my) {
    if (my !== gen) return
    portal = null
    triggers = {}
    phase = 'error'
    message = 'The desktop\'s shortcut service closed the connection.'
    retryLater(my)
    d.onChange()
  }
  // up to RETRIES tries in a row (a working session resets the count), then the user's Ask again
  function retryLater(my) {
    if (retries >= RETRIES || !enabled) { message += ' Ask again to reconnect.'; return }
    retries++
    message += ' Sonata tries again in a few seconds.'
    // lifetime: OK — one pending retry at most, cleared when the shortcuts go off
    retryTimer = d.setTimeout(() => { retryTimer = null; if (enabled && !portal && my === gen) portalOn() }, RETRY_MS)
  }
  function portalOff() {
    gen++
    connecting = false
    if (retryTimer) { d.clearTimeout(retryTimer); retryTimer = null }
    if (portal) portal.close()
    if (pendingConn) pendingConn.close()
    portal = null
    pendingConn = null
    triggers = {}
  }

  // the switch and the stored keys (settings.json) -> what runs
  function apply(on, storedKeys) {
    enabled = !!on
    const next = M.bindings(storedKeys)
    const b = backend()
    if (b.kind === 'unknown') {
      if (enabled) { phase = 'starting'; probe().then(() => apply(enabled, storedKeys)) }   // error: NOT-WORTH — probe() never rejects
      else phase = 'off'
      keys = next
    } else if (b.kind === 'x11') {
      if (enabled) x11On(next)
      else { x11Off(); keys = next; phase = 'off'; message = '' }
    } else if (b.kind === 'portal') {
      keys = next
      if (!enabled) { portalOff(); phase = 'off'; message = '' }
      else if (!portal && !connecting) { portalOn(); return }
    } else {
      keys = next
      phase = 'off'
      message = ''
    }
    d.onChange()
  }

  // the panel's "Press the new keys" mode: Sonata's own grabs let go meanwhile (X11), so the keys reach the panel
  function suspend(on) {
    if (backend().kind !== 'x11') return
    // error: NOT-WORTH — an Electron without setSuspended: grabs stay, a held key can't be picked again
    try { d.globalShortcut.setSuspended(!!on) } catch (e) { /* keep going */ }
  }

  // Wayland: the desktop's own editor (portal version 2); false when it isn't there (the panel says where instead)
  async function configure() {
    if (!portal) return false
    const ok = await portal.configure()
    if (!ok) { configureFailed = true; d.onChange() }
    return ok
  }
  // Wayland: start over (a new session, so the desktop asks again when it has no keys for Sonata)
  function askAgain() {
    if (backend().kind !== 'portal' || !enabled) return
    portalOff()
    retries = 0
    phase = 'off'
    portalOn()
  }

  function snapshot() {
    const b = backend()
    const viaPortal = b.kind === 'portal'
    const rows = M.ACTIONS.map((a) => {
      const key = viaPortal ? (triggers[a.id] || '') : keys[a.id]
      let state = 'off'
      if (enabled && phase === 'on') state = viaPortal ? (key ? 'ok' : 'unset') : (taken.has(a.id) ? 'taken' : 'ok')
      return { id: a.id, label: a.label, key, state, suggested: a.key, changed: !viaPortal && keys[a.id] !== a.key }
    })
    return {
      backend: b,
      enabled,
      phase,
      message,
      rows,
      keys: Object.fromEntries(rows.filter((r) => r.key && r.state !== 'taken').map((r) => [r.id, r.key])),
      canConfigure: viaPortal && !!portal && portal.version >= 2 && !configureFailed,
      canAskAgain: viaPortal && enabled && (phase === 'cancelled' || phase === 'error'),
      anyChanged: rows.some((r) => r.changed),
      where: M.WHERE[M.desktopOf(d.env)],
      unavailable: M.unavailableText(b)
    }
  }

  function stop() {
    enabled = false
    if (backend().kind === 'x11') x11Off()
    portalOff()
    phase = 'off'
  }

  return { apply, probe, suspend, configure, askAgain, snapshot, stop, fire }
}

module.exports = { createShortcuts }
