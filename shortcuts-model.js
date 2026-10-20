// Global shortcuts, the pure part (no DOM, no Electron): the actions, the key model (Electron
// accelerators such as "Ctrl+Alt+P"), checking and changing a key, turning a key press into one,
// the portal's trigger form, and which way a desktop gets them (X11 key grabs, the Wayland portal, or
// none, with the reason). Used by main.js (shortcuts.js) and panel-ui.js (loaded in panel.html as a
// plain script: SonataShortcutsModel).
;(function (root) {
  'use strict'

  // the actions and their suggested keys: free in KDE Plasma's and GNOME's default shortcuts
  // (Ctrl+Alt+arrows switch workspaces on GNOME, Ctrl+Alt+L locks the screen on some desktops)
  const ACTIONS = [
    { id: 'play-pause', label: 'Play / Pause', key: 'Ctrl+Alt+P' },
    { id: 'next', label: 'Next song', key: 'Ctrl+Alt+PageDown' },
    { id: 'previous', label: 'Previous song', key: 'Ctrl+Alt+PageUp' },
    { id: 'lyrics', label: 'Show or hide lyrics', key: 'Ctrl+Alt+Y' }
  ]
  const IDS = ACTIONS.map((a) => a.id)
  const MODS = ['Ctrl', 'Alt', 'Shift', 'Super']
  const NAMED = ['Left', 'Right', 'Up', 'Down', 'PageUp', 'PageDown', 'Home', 'End', 'Insert', 'Delete', 'Space']
  const KEYS = new Set([...'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'].concat(Array.from({ length: 24 }, (_, i) => 'F' + (i + 1)), NAMED))
  // Sonata's own window keys (main.js windowShortcut / viewShortcut): never a global one
  const RESERVED = ['Ctrl+R', 'Ctrl+D', 'Ctrl+M', 'Ctrl+B', 'Ctrl+Shift+L', 'Ctrl+Shift+S', 'Ctrl+Shift+V']
  const ALIASES = { control: 'Ctrl', ctrl: 'Ctrl', cmdorctrl: 'Ctrl', commandorcontrol: 'Ctrl', alt: 'Alt', option: 'Alt', shift: 'Shift', super: 'Super', meta: 'Super', cmd: 'Super', command: 'Super' }

  // "ctrl+alt+p" / "Alt+Control+P" -> "Ctrl+Alt+P" (modifiers in MODS order); null when not a key Sonata takes
  function normalize(accel) {
    if (typeof accel !== 'string' || accel.length > 40) return null
    // loop: NOT-WORTH — per key check (apply, a settings write, a key press), ≤ 4 parts; interval root is a name clash
    const parts = accel.split('+').map((p) => p.trim()).filter(Boolean)
    if (parts.length < 2) return null
    const mods = new Set()
    // loop: NOT-WORTH — the 1–3 modifiers of one key
    for (const p of parts.slice(0, -1)) {
      const m = ALIASES[p.toLowerCase()]
      if (!m || mods.has(m)) return null
      mods.add(m)
    }
    const raw = parts[parts.length - 1]
    // loop: NOT-WORTH — per key check, N = 11 named keys
    const key = raw.length === 1 ? raw.toUpperCase() : (NAMED.find((n) => n.toLowerCase() === raw.toLowerCase()) || (/^f\d{1,2}$/i.test(raw) ? raw.toUpperCase() : raw))
    if (!KEYS.has(key)) return null
    // loop: NOT-WORTH — per key check, N = 4 modifiers
    return MODS.filter((m) => mods.has(m)).concat([key]).join('+')
  }

  // -> '' when the key can be a global shortcut, else why not (words for the panel)
  function problem(accel) {
    const k = normalize(accel)
    if (!k) return 'Not a key Sonata can use'
    if (!/(^|\+)(Ctrl|Alt|Super)\+/.test(k)) return 'Needs Ctrl, Alt or Super, so it doesn\'t catch normal typing'
    if (RESERVED.includes(k)) return k + ' is one of Sonata\'s own window keys'
    return ''
  }

  // the stored changes ({ id: key }, only the ones that differ) -> the key of every action
  function bindings(stored) {
    const s = stored && typeof stored === 'object' ? stored : {}
    const out = {}
    // loop: NOT-WORTH — 4 actions
    for (const a of ACTIONS) out[a.id] = (typeof s[a.id] === 'string' && !problem(s[a.id])) ? normalize(s[a.id]) : a.key
    // two actions on one key: the later one goes back to its suggestion (a hand-edited settings file)
    const seen = new Map()
    // loop: NOT-WORTH — 4 actions
    for (const a of ACTIONS) {
      if (seen.has(out[a.id])) out[a.id] = a.key
      seen.set(out[a.id], a.id)
    }
    return out
  }

  // A key change from the panel: key null puts the suggested key back.
  // -> { stored (the new changes to save), error ('' or why the key was refused) }
  function setKey(stored, id, accel) {
    const now = Object.assign({}, stored && typeof stored === 'object' ? stored : {})
    const act = ACTIONS.find((a) => a.id === id)
    if (!act) return { stored: now, error: 'No such shortcut' }
    if (accel === null) { delete now[id]; return { stored: now, error: '' } }
    const why = problem(accel)
    if (why) return { stored: now, error: why }
    const k = normalize(accel)
    const cur = bindings(now)
    const other = ACTIONS.find((a) => a.id !== id && cur[a.id] === k)
    if (other) return { stored: now, error: k + ' is already ' + other.label }
    if (k === act.key) delete now[id]
    else now[id] = k
    return { stored: now, error: '' }
  }

  // a stored value check for settings-store.js: only known ids with plausible keys
  function validStored(v) {
    return !!v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length <= IDS.length &&
      Object.keys(v).every((k) => IDS.includes(k) && typeof v[k] === 'string' && v[k].length <= 40)
  }

  // A key press in the panel's "Press the new keys" mode (KeyboardEvent fields).
  // -> { key } a complete key, { waiting: true } only modifiers so far, { cancel: true } Esc alone,
  //    { error } a key Sonata can't take
  const CODE_KEYS = { ArrowLeft: 'Left', ArrowRight: 'Right', ArrowUp: 'Up', ArrowDown: 'Down', PageUp: 'PageUp', PageDown: 'PageDown', Home: 'Home', End: 'End', Insert: 'Insert', Delete: 'Delete', Space: 'Space' }
  function fromKeyEvent(e) {
    const ev = e || {}
    const code = String(ev.code || '')
    if (/^(Control|Alt|Shift|Meta|OS)(Left|Right)?$/.test(code) || /^(Control|Alt|Shift|Meta|AltGraph)$/.test(ev.key)) return { waiting: true }
    if (ev.key === 'Escape' && !ev.ctrlKey && !ev.altKey && !ev.metaKey && !ev.shiftKey) return { cancel: true }
    let key = null
    if (/^Key[A-Z]$/.test(code)) key = code.slice(3)
    else if (/^Digit\d$/.test(code)) key = code.slice(5)
    else if (/^F\d{1,2}$/.test(code)) key = code
    else if (CODE_KEYS[code]) key = CODE_KEYS[code]
    if (!key) return { error: 'Sonata can\'t use that key: try a letter, a number, F1–F24, an arrow or Page Up/Down' }
    if (!ev.ctrlKey && !ev.altKey && !ev.metaKey) return { error: 'Needs Ctrl, Alt or Super, so it doesn\'t catch normal typing' }
    const accel = [ev.ctrlKey && 'Ctrl', ev.altKey && 'Alt', ev.shiftKey && 'Shift', ev.metaKey && 'Super'].filter(Boolean).concat([key]).join('+')
    const why = problem(accel)
    return why ? { error: why } : { key: normalize(accel) }
  }

  // "Ctrl+Alt+PageDown" -> "CTRL+ALT+Page_Down" (the XDG shortcuts format: modifiers, then an xkb key name)
  const PORTAL_MOD = { Ctrl: 'CTRL', Alt: 'ALT', Shift: 'SHIFT', Super: 'LOGO' }
  const PORTAL_KEY = { PageUp: 'Page_Up', PageDown: 'Page_Down', Space: 'space' }
  function toPortalTrigger(accel) {
    const k = normalize(accel)
    if (!k) return ''
    const parts = k.split('+')
    const key = parts.pop()
    return parts.map((m) => PORTAL_MOD[m]).concat([PORTAL_KEY[key] || (key.length === 1 ? key.toLowerCase() : key)]).join('+')
  }
  // the shortcuts as the portal's BindShortcuts gets them (the suggested keys; the desktop decides)
  const portalShortcuts = () => ACTIONS.map((a) => ({ id: a.id, description: a.label, trigger: toPortalTrigger(a.key) }))

  // Which way this desktop gets global shortcuts.
  // o: { platform, env, portalVersion (0 = none, null = not asked yet) }
  // -> { kind: 'x11' | 'portal' | 'none' | 'unknown', reason }
  function chooseBackend(o) {
    const env = o.env || {}
    if (o.platform !== 'linux') return { kind: 'none', reason: 'platform' }
    const wayland = env.XDG_SESSION_TYPE === 'wayland' || !!env.WAYLAND_DISPLAY
    if (wayland) {
      // Wayland gives no app the keys of another app's window: only the desktop's portal can
      if (o.portalVersion === null || o.portalVersion === undefined) return { kind: 'unknown', reason: 'asking' }
      return o.portalVersion > 0 ? { kind: 'portal', reason: '' } : { kind: 'none', reason: 'no-portal' }
    }
    if (env.DISPLAY) return { kind: 'x11', reason: '' }
    return { kind: 'none', reason: 'no-display' }
  }
  // KDE / GNOME / other, for the words that say where a desktop keeps its shortcuts
  function desktopOf(env) {
    const d = String((env && (env.XDG_CURRENT_DESKTOP || env.XDG_SESSION_DESKTOP)) || '').toLowerCase()
    if (/kde|plasma/.test(d)) return 'kde'
    if (/gnome|unity|ubuntu/.test(d)) return 'gnome'
    return 'other'
  }
  const WHERE = {
    kde: 'System Settings → Keyboard → Shortcuts → Sonata',
    gnome: 'GNOME Settings (where it lists apps\' global shortcuts)',
    other: 'your desktop\'s keyboard shortcut settings'
  }

  // why the switch can't be used, in words; '' when it can
  function unavailableText(backend) {
    if (backend.kind === 'none' && backend.reason === 'no-portal') return 'This desktop doesn\'t offer global shortcuts to apps on Wayland (it has no GlobalShortcuts portal). Your keyboard\'s media keys still work (below).'
    if (backend.kind === 'none' && backend.reason === 'no-display') return 'No desktop session was found, so there is nothing to take keys from.'
    if (backend.kind === 'none') return 'Global shortcuts are for Linux desktops.'
    if (backend.kind === 'unknown') return 'Asking the desktop whether it offers global shortcuts…'
    return ''
  }

  // the Settings section's one-line status. st: the panel snapshot's `shortcuts`
  function statusLine(st) {
    const s = st || {}
    if (!s.backend || s.backend.kind === 'none') return 'Not available here'
    if (!s.enabled) return 'Off'
    if (s.phase === 'starting') return 'Asking the desktop…'
    if (s.phase === 'cancelled') return 'On · the desktop\'s dialog was cancelled'
    if (s.phase === 'error') return 'On · not working: see the section'
    const keys = IDS.map((id) => (s.keys || {})[id]).filter(Boolean)
    return 'On · ' + (keys.length ? keys[0] + (keys.length > 1 ? ' and ' + (keys.length - 1) + ' more' : '') : 'no keys set')
  }

  // One action per key press: key repeat (a held key) and a press arriving twice don't skip songs.
  // -> fn(id, nowMs) -> true when the press counts
  function repeatGuard(ms) {
    // cache: OK — key=action id; invalidated=overwritten per press; bound=4 ids (fire() checks M.IDS first)
    const last = new Map()
    return (id, now) => {
      const prev = last.get(id)
      if (prev !== undefined && now - prev < ms) return false
      last.set(id, now)
      return true
    }
  }

  const api = { ACTIONS, IDS, RESERVED, WHERE, normalize, problem, bindings, setKey, validStored, fromKeyEvent, toPortalTrigger, portalShortcuts, chooseBackend, desktopOf, unavailableText, statusLine, repeatGuard }
  if (typeof module === 'object' && module.exports) module.exports = api
  else root.SonataShortcutsModel = Object.freeze(api)
})(typeof globalThis !== 'undefined' ? globalThis : this)
