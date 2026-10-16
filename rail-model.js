// The navigation rail's pure logic (no DOM, no Electron): layout math, the open/closed state,
// the keyboard map, the items and status lines, and the glass colours with their contrast.
// Used by main.js (room for Apple's page, the state it sends) and by rail-ui.js, which runs in
// the main window's isolated world (main injects this file there first, as SonataRailModel).
// Modeled on the DS5 app's AppRail: right edge, icons only, expands over the page on hover or
// keyboard focus, closes right after a pointer pick; pinned it takes its full width (Ctrl+B).
;(function (root) {
  'use strict'

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

  // CSS for Apple's document (main.js inserts it with insertCSS, one sheet kept). Apple's page is
  // narrowed by `room` px: the root gets narrower, so everything laid out in % (the grid, the
  // scrolling page with its scrollbar) ends at the rail. Apple sizes the floating player bar in
  // vw (100vw - the sidebar), which ignores the root's width, so it gets the room taken off too.
  // Fixed overlays (modals and their dimmed curtains) still span the whole window; modals sit
  // above the rail (Apple's --z-modal is 10001, the rail's z-index is 10000).
  function roomCss(room) {
    const r = Math.max(0, Math.round(Number(room) || 0))
    if (!r) return ''
    return 'html{width:calc(100% - ' + r + 'px) !important}' +
      '@media (min-width:484px){.player-bar{width:calc(100vw - var(--web-navigation-width, 0px) - ' + r + 'px) !important}}'
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

  // Is the rail open (labels shown)? Pinned with room: always. Otherwise on hover (unless just
  // picked) or keyboard focus, and not after Esc.
  function isOpen(mode, v) {
    if (mode === 'pinned') return true
    if (v.dismissed) return false
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
  // toggle: a press opens or closes that window (aria-pressed); window: opens it or brings it
  // forward (Settings has no shortcut and is never closed from here; aria-current when open).
  const ITEMS = [
    { id: 'lyrics', label: 'Lyrics', keyName: 'lyrics', kind: 'toggle' },
    { id: 'visualizer', label: 'Visualizer', keyName: 'visualizer', kind: 'toggle' },
    { id: 'mini', label: 'Mini Player', keyName: 'mini', kind: 'toggle' },
    { id: 'settings', label: 'Settings', keyName: 'settings', kind: 'window' }
  ]
  const COMMANDS = ['lyrics', 'visualizer', 'mini', 'settings', 'pin', 'mounted']

  // 'Ctrl+Shift+L' -> 'Control+Shift+L' (aria-keyshortcuts)
  const ariaKeys = (k) => (k ? k.replace(/\bCtrl\b/g, 'Control') : '')

  function railItems(s) {
    const open = (s && s.open) || {}
    const keys = (s && s.keys) || {}
    return ITEMS.map((it) => {
      const key = keys[it.keyName] || ''
      const active = !!open[it.id]
      const head = it.label + (key ? ' (' + key + ')' : '')
      const what = it.kind === 'toggle'
        ? (active ? 'Open · click to close' : 'Click to open')
        : (active ? 'Open · click to bring it forward' : 'Click to open')
      return { id: it.id, label: it.label, kind: it.kind, key, ariaKeys: ariaKeys(key), active, tip: head + '\n' + what }
    })
  }

  // the pin: one toggle whose name stays put; aria-pressed (and the active bar) say whether it's on
  function pinItem(s) {
    const pinned = !!(s && s.pinned)
    const mode = (s && s.mode) || 'collapsed'
    let tip = pinned ? 'Pinned open · click to unpin (Ctrl+B)' : 'Pin the rail open (Ctrl+B)'
    if (mode === 'floating') tip += '\nThe window is too narrow to make room, so the pinned rail opens over the page until the window is wider'
    return { id: 'pin', label: 'Pin rail', kind: 'toggle', key: 'Ctrl+B', ariaKeys: 'Control+B', active: pinned, tip }
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
        ? line('discord', 'Discord', 'wait', 'Waiting for Discord', 'on, waiting for the Discord app (retries every 30 s)')
        : line('discord', 'Discord', 'off', 'Off', 'presence off'))
    out.push(st.precise === 'ready'
      ? line('precise', 'Precise word timing', 'ok', 'Helper ready', 'precise word timing on, helper installed and ready')
      : st.precise === 'busy'
        ? line('precise', 'Precise word timing', 'ok', 'Helper working', 'precise word timing on, the helper is running')
        : st.precise === 'missing'
          ? line('precise', 'Precise word timing', 'warn', 'Helper not installed', 'precise word timing is on but the sonata-align helper is not installed (align/install.sh)')
          : line('precise', 'Precise word timing', 'off', 'Off', 'precise word timing off'))
    return out
  }

  function devBadge(s) {
    if (!s || s.channel !== 'dev') return null
    return { text: 'Development', version: s.version || '', tip: 'Development channel' + (s.version ? ' · v' + s.version : '') + ' (Settings → Updates)' }
  }

  // --- colours: glass tinted by the album accent, light/dark aware, contrast checked ---
  const hexRgb = (h) => {
    const m = /^#?([0-9a-f]{6})$/i.exec(String(h || ''))
    if (!m) return null
    const n = parseInt(m[1], 16)
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
  }
  const mix = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t)
  const lum = (rgb) => {
    const c = rgb.map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4) })
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]
  }
  function contrast(a, b) {
    const la = lum(a); const lb = lum(b)
    return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05)
  }
  // translucent layers ([rgb, alpha], bottom first) over a backdrop
  const stack = (backdrop, layers) => layers.reduce((acc, l) => acc.map((v, i) => l[0][i] * l[1] + v * (1 - l[1])), backdrop)
  const WHITE = [255, 255, 255]
  const BLACK = [0, 0, 0]
  // the lowest contrast `text` reaches on these layers over anything (the extremes are white and black)
  function worstContrast(text, layers) {
    return Math.min(contrast(text, stack(WHITE, layers)), contrast(text, stack(BLACK, layers)))
  }
  const css = (rgb, a) => 'rgba(' + rgb.map((v) => Math.round(v)).join(',') + ',' + (a === undefined ? 1 : +a.toFixed(3)) + ')'

  const BASE = {
    dark: { glass: [30, 30, 34], text: [245, 245, 247], soft: 0.18, tint: 0.16, alpha: 0.78 },
    light: { glass: [248, 248, 250], text: [29, 29, 31], soft: 0.20, tint: 0.10, alpha: 0.80 }
  }
  const DEFAULT_ACCENT = [250, 45, 72]   // Apple Music's red, when there's no album colour

  // -> CSS custom properties for the rail, plus the measured worst-case contrasts.
  // The glass alpha is raised (never lowered) until labels reach 4.5:1 over any backdrop; the
  // active and hover rows are layers over the glass (as the CSS paints them), checked the same way.
  function glassTheme(palette, dark) {
    const b = dark ? BASE.dark : BASE.light
    const accent = (palette && hexRgb(palette.accent)) || DEFAULT_ACCENT
    const glass = mix(b.glass, accent, b.tint)
    const soft = mix(b.text, glass, b.soft)   // the status words: text mixed toward the glass
    let alpha = b.alpha
    const panel = () => [[glass, alpha]]
    while (alpha < 0.98 && (worstContrast(b.text, panel()) < 4.5 || worstContrast(soft, panel()) < 4.5)) alpha += 0.02
    // active row: an accent layer over the glass, as strong as the labels on it allow (4.5:1)
    let activeA = dark ? 0.34 : 0.22
    while (activeA > 0.04 && worstContrast(b.text, panel().concat([[accent, activeA]])) < 4.5) activeA -= 0.02
    // hovered row: a faint text-coloured layer
    const hoverA = dark ? 0.10 : 0.07
    // the active bar and the focus ring: the accent, pushed toward the text colour until 3:1 (non-text)
    let ring = accent
    for (let i = 0; i < 20 && worstContrast(ring, panel()) < 3; i++) ring = mix(ring, b.text, 0.12)
    return {
      vars: {
        '--rail-glass': css(glass, alpha),
        '--rail-solid': css(glass),
        '--rail-text': css(b.text),
        '--rail-soft': css(soft),
        '--rail-active': css(accent, activeA),
        '--rail-hover': css(b.text, hoverA),
        '--rail-ring': css(ring),
        '--rail-edge': dark ? 'rgba(255,255,255,0.14)' : 'rgba(0,0,0,0.12)',
        '--rail-shadow': dark ? 'rgba(0,0,0,0.45)' : 'rgba(0,0,0,0.18)'
      },
      contrast: {
        label: worstContrast(b.text, panel()),
        soft: worstContrast(soft, panel()),
        active: worstContrast(b.text, panel().concat([[accent, activeA]])),
        hover: worstContrast(b.text, panel().concat([[b.text, hoverA]])),
        ring: worstContrast(ring, panel())
      },
      alpha
    }
  }

  const api = {
    RAIL, ITEMS, COMMANDS, railLayout, roomCss, initialView, viewReduce, isOpen, railKey,
    railItems, pinItem, railStatus, devBadge, glassTheme, contrast, worstContrast, hexRgb
  }
  if (typeof module === 'object' && module.exports) module.exports = api
  else root.SonataRailModel = Object.freeze(api)
})(typeof globalThis !== 'undefined' ? globalThis : this)
