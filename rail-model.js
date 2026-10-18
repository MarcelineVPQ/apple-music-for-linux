// The navigation rail's pure logic (no DOM, no Electron): layout math, the open/closed state,
// the keyboard map, the items and status lines. Its colours come from theme.js (one theme system).
// Used by main.js (the two views' bounds, the state it sends) and by rail-ui.js in rail.html, the
// rail's own view (loaded there as a plain script: SonataRailModel).
// Modeled on the DS5 app's AppRail: right edge, icons only, expands over the page on hover or
// keyboard focus, closes right after a pointer pick; pinned it takes its full width (Ctrl+B).
;(function (root) {
  'use strict'
  // every version and channel name people read (version-display.js, loaded before this page script)
  const V = root.SonataVersionDisplay || (typeof require === 'function' ? require('./version-display') : null)

  // DS5 density: 52 px icon column, 196 px open, 13 px labels, 36 px rows (hit targets >= 32 px)
  const RAIL = { collapsed: 52, expanded: 196, minContent: 800, row: 36 }

  // How much of the window the rail takes from Apple's page. Unpinned it keeps its icon column
  // (so it never covers Apple's scrollbar or the player bar) and opens over the page. Pinned it
  // takes its full width, unless that would leave Apple's page under its own minimum (800 px,
  // the window's minWidth): then it floats like the unpinned rail ('floating') until the window
  // is wide enough again. The pin is remembered either way.
  function railLayout(windowWidth, pinned) {
    const w = Number(windowWidth) || 0
    if (!pinned) return { mode: 'collapsed', room: RAIL.collapsed }
    if (w - RAIL.expanded >= RAIL.minContent) return { mode: 'pinned', room: RAIL.expanded }
    return { mode: 'floating', room: RAIL.collapsed }
  }

  // The main window holds two views side by side: Apple's page and the rail (its own web contents,
  // on top). Apple's view gets the window minus the rail's room, so Apple's own layout (vw units,
  // fixed and right:0 panels, its lyrics and queue panels, sheets, menus) ends at the rail by itself.
  // The rail view is its room wide, or its full open width while it is open over Apple's page
  // (`wide`: hover or keyboard focus, unpinned; it narrows again once it has closed).
  // -> { apple: {x,y,width,height}, rail: {x,y,width,height}, mode, room }
  function viewBounds(contentWidth, contentHeight, pinned, wide) {
    const w = Math.max(0, Math.round(Number(contentWidth) || 0))
    const h = Math.max(0, Math.round(Number(contentHeight) || 0))
    const { mode, room } = railLayout(w, pinned)
    const railW = Math.min(w, mode === 'pinned' || wide ? RAIL.expanded : RAIL.collapsed)
    return {
      mode, room,
      apple: { x: 0, y: 0, width: Math.max(0, w - room), height: h },
      rail: { x: w - railW, y: 0, width: railW, height: h }
    }
  }

  // --- open / closed (the rail's own pointer and focus state) ---
  // hover: the pointer is over the rail; focusVisible: keyboard focus inside (Tab/arrows, not a
  // click); picked: an item was just clicked with the pointer, so the rail closes like a menu and
  // hover doesn't reopen it until the pointer leaves and comes back; dismissed: Esc closed it
  // while focus stays inside (the next arrow key or pointer entry opens it again).
  function initialView() { return { hover: false, focusVisible: false, picked: false, dismissed: false } }

  function viewReduce(v, type) {
    switch (type) {
      case 'enter': return Object.assign({}, v, { hover: true, dismissed: false })
      case 'leave': return Object.assign({}, v, { hover: false, picked: false })
      case 'focus-visible': return Object.assign({}, v, { focusVisible: true })
      case 'focus-pointer': return Object.assign({}, v, { focusVisible: false })
      case 'blur': return Object.assign({}, v, { focusVisible: false, dismissed: false })
      case 'pick': return Object.assign({}, v, { picked: true, focusVisible: false })
      case 'escape': return Object.assign({}, v, { dismissed: true })
      case 'key': return Object.assign({}, v, { dismissed: false, focusVisible: true })
      default: return v
    }
  }

  // Is the rail open (labels shown)? Pinned with room: always. Locked: never (icons only; hover
  // and keyboard focus no longer open it). Otherwise on hover (unless just picked) or keyboard
  // focus, and not after Esc.
  function isOpen(mode, v, locked) {
    if (mode === 'pinned') return true
    if (locked || v.dismissed) return false
    return (v.hover && !v.picked) || v.focusVisible
  }

  // --- keyboard (focus moves between the rail's buttons; Enter/Space are the buttons' own) ---
  // -> { action: 'move', index } | { action: 'escape' } | null (not ours: let it through)
  function railKey(key, index, count, mods) {
    const m = mods || {}
    if (m.ctrl || m.alt || m.meta || !count) return null
    const i = Math.max(0, Math.min(count - 1, index | 0))
    switch (key) {
      case 'ArrowDown': case 'ArrowRight': return { action: 'move', index: (i + 1) % count }
      case 'ArrowUp': case 'ArrowLeft': return { action: 'move', index: (i - 1 + count) % count }
      case 'Home': return { action: 'move', index: 0 }
      case 'End': return { action: 'move', index: count - 1 }
      case 'Escape': return { action: 'escape' }
      default: return null
    }
  }

  // --- items ---
  // toggle: a press opens or closes that window (aria-pressed). panel (0.15.32): Settings and About
  // show in the side panel beside Apple's page; pressing the item of the page the panel shows hides
  // the panel, any other shows it with that page (aria-pressed: shown with this page). An open task
  // there (an update, a repaired file, what's new) puts a dot on the item while it isn't shown.
  // The Studio leads a group (Marcy 2026-10-18): Lyrics and Liner Notes sit under it as sub-items
  // (parent: 'stage'; indented with a guide line, and still one click away in the icon column), then
  // the Mini Player (the next most used), the Visualizer, Settings, About. The keyboard walks them in
  // this order, sub-items included.
  const ITEMS = [
    // the Studio (internally the stage: lyrics.html body.stage), the lyrics window grown into the
    // now-playing screen; first on the rail (Marcy 2026-10-17: the standout feature). Pressed while the
    // Studio shows; pressing it then shrinks it back to the lyrics window
    { id: 'stage', label: 'Studio', keyName: 'stage', kind: 'toggle', tipOn: 'Shown · click to shrink it to the lyrics window', tipOff: 'Click to open the Studio: the lyrics with the song and what plays next' },
    { id: 'lyrics', label: 'Lyrics', keyName: 'lyrics', kind: 'toggle', parent: 'stage', tipOff: 'Click to open the compact lyrics window' },
    // the playing album's booklet (the Studio's Liner notes tile, the menus' "Liner Notes…")
    { id: 'liner', label: 'Liner Notes', keyName: 'liner', kind: 'toggle', parent: 'stage', tipOn: 'Open · click to close the booklet', tipOff: 'Click to open the booklet of the playing album', tipIdle: 'Nothing is playing · play a song, then this opens its album\'s booklet' },
    { id: 'mini', label: 'Mini Player', keyName: 'mini', kind: 'toggle' },
    { id: 'visualizer', label: 'Visualizer', keyName: 'visualizer', kind: 'toggle' },
    { id: 'settings', label: 'Settings', keyName: 'settings', kind: 'panel' },
    { id: 'about', label: 'About', keyName: 'about', kind: 'panel' }
  ]
  // what the rail view may send: its items, the pin and lock, 'mounted', 'expand'/'collapse' (widen
  // the view over Apple's page while open), 'focus-apple-next'/'focus-apple-prev' (Tab out: to Apple's
  // page, or Shift+Tab to the panel when it shows)
  const COMMANDS = ['lyrics', 'stage', 'liner', 'visualizer', 'mini', 'settings', 'about', 'pin', 'lock', 'mounted', 'expand', 'collapse', 'focus-apple-next', 'focus-apple-prev']

  // Pin and lock exclude each other, as in the DS5 app: keeping it open unlocks it, locking it
  // unpins it. -> the new { pinned, locked } after toggling `which` ('pin' | 'lock')
  function toggleFlags(flags, which) {
    const f = { pinned: !!(flags && flags.pinned), locked: !!(flags && flags.locked) }
    if (which === 'pin') { f.pinned = !f.pinned; if (f.pinned) f.locked = false }
    else if (which === 'lock') { f.locked = !f.locked; if (f.locked) f.pinned = false }
    return f
  }

  // 'Ctrl+Shift+L' -> 'Control+Shift+L' (aria-keyshortcuts)
  const ariaKeys = (k) => (k ? k.replace(/\bCtrl\b/g, 'Control') : '')

  function railItems(s) {
    const open = (s && s.open) || {}
    const keys = (s && s.keys) || {}
    const panel = (s && s.panel) || {}
    const reminders = (s && s.reminders) || {}
    return ITEMS.map((it) => {
      const key = keys[it.keyName] || ''
      const active = it.kind === 'panel' ? !!panel.shown && panel.page === it.id : !!open[it.id]
      const head = it.label + (key ? ' (' + key + ')' : '')
      // Liner Notes with nothing playing: the tooltip says so (a press then says it in a toast too)
      const idle = !active && it.tipIdle && s && s.song === false
      const what = it.kind === 'toggle'
        ? (active ? it.tipOn || 'Open · click to close' : idle ? it.tipIdle : it.tipOff || 'Click to open')
        : (active ? 'Shown beside the page · click to hide it' : 'Click to show it beside the page')
      // a task waiting there: the dot, said in the tooltip and to screen readers (not colour alone)
      const task = it.kind === 'panel' && !active && reminders[it.id] ? String(reminders[it.id]) : ''
      const sub = it.parent ? ITEMS.find((p) => p.id === it.parent) : null
      return { id: it.id, label: it.label, kind: it.kind, parent: it.parent || '', group: sub ? sub.label : '', key, ariaKeys: ariaKeys(key), active, task, tip: head + '\n' + what + (task ? '\nWaiting: ' + task : '') }
    })
  }

  // the pin: one toggle whose name stays put; aria-pressed (and the active bar) say whether it's on
  function pinItem(s) {
    const pinned = !!(s && s.pinned)
    const mode = (s && s.mode) || 'collapsed'
    let tip = pinned ? 'Pinned open · click to unpin (Ctrl+B)' : 'Pin the rail open (Ctrl+B)'
    if (!pinned && s && s.locked) tip += '\nIt is locked small: pinning unlocks it'
    if (mode === 'floating') tip += '\nThe window is too narrow to make room, so the pinned rail opens over the page until the window is wider'
    return { id: 'pin', label: 'Pin rail', kind: 'toggle', key: 'Ctrl+B', ariaKeys: 'Control+B', active: pinned, tip }
  }

  // the lock (bottom corner, under the icons): one toggle, its name stays put, aria-pressed says it's on
  function lockItem(s) {
    const locked = !!(s && s.locked)
    return {
      id: 'lock', label: 'Lock rail', kind: 'toggle', key: '', ariaKeys: '', active: locked,
      tip: locked ? 'Locked small (icons only) · click to unlock: it opens when you point at it again'
        : 'Lock the rail small (icons only): it no longer opens when you point at it or Tab to it'
    }
  }

  // --- status: a dot PLUS a symbol and words, never colour alone ---
  // level: ok (green, ✓) · wait (amber, …) · warn (amber, !) · off (grey, –)
  const SYMBOL = { ok: '✓', wait: '…', warn: '!', off: '–' }
  function line(id, label, level, text, tip) {
    return { id, label, level, symbol: SYMBOL[level], text, tip: label + ': ' + tip }
  }
  function railStatus(s) {
    const st = s || {}
    const lf = st.lastfm || {}
    const out = []
    out.push(lf.connected
      ? line('lastfm', 'Last.fm', 'ok', 'Connected', 'connected' + (lf.user ? ' as ' + lf.user : '') + ', scrobbling')
      : line('lastfm', 'Last.fm', 'off', 'Not connected', 'not connected (Settings or the tray menu connects it)'))
    out.push(st.discord === 'on'
      ? line('discord', 'Discord', 'ok', 'Connected', 'connected, showing what you play')
      : st.discord === 'waiting'
        ? line('discord', 'Discord', 'wait', 'Waiting for Discord', 'on, waiting for the Discord app' + (st.discordRetryS ? ' (retries every ' + st.discordRetryS + ' s)' : ''))
        : line('discord', 'Discord', 'off', 'Off', 'presence off'))
    out.push(st.precise === 'ready'
      ? line('precise', 'Precise word timing', 'ok', 'Helper ready', 'precise word timing on, helper installed and ready')
      : st.precise === 'busy'
        ? line('precise', 'Precise word timing', 'ok', 'Helper working', 'precise word timing on, the helper is running')
        : st.precise === 'paused'
          ? line('precise', 'Precise word timing', 'wait', 'Paused while gaming', 'precise word timing paused while a game runs or the graphics card is busy; it goes on afterwards')
        : st.precise === 'repair'
          ? line('precise', 'Precise word timing', 'warn', 'Helper needs a rebuild', 'the sonata-align helper\'s Python is missing or inside another app; see Settings → Word timing')
        : st.precise === 'update'
          ? line('precise', 'Precise word timing', 'warn', 'Helper needs an update', 'the sonata-align helper is not the engine this Sonata needs; see Settings → Word timing')
        : st.precise === 'missing'
          ? line('precise', 'Precise word timing', 'warn', 'Helper not installed', 'precise word timing is on but the sonata-align helper is not installed (align/install.sh)')
          : line('precise', 'Precise word timing', 'off', 'Off', 'precise word timing off'))
    return out
  }

  function devBadge(s) {
    if (!s || s.channel !== 'dev') return null
    const name = V.channelName('dev')
    return { text: name, shown: V.short(s.version), tip: name + ' channel' + (s.version ? ' · ' + V.tagged(s.version) : '') + ' (Settings → Updates)' }
  }

  const api = {
    RAIL, ITEMS, COMMANDS, railLayout, viewBounds, initialView, viewReduce, isOpen, railKey,
    railItems, pinItem, lockItem, toggleFlags, railStatus, devBadge
  }
  if (typeof module === 'object' && module.exports) module.exports = api
  else root.SonataRailModel = Object.freeze(api)
})(typeof globalThis !== 'undefined' ? globalThis : this)
