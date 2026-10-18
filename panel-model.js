// The side panel's pure logic (no DOM, no Electron): where it sits in the main window, its pages and
// sections, the accordion's open/pinned state, the ⋮ menu, header keys and the sections' one-line
// status. Used by main.js (layout, the remembered state) and panel-ui.js (loaded in panel.html as a
// plain script: SonataPanelModel). Modeled on the DS5 app's accordion (Section.tsx, useAccordion.ts,
// SplitView): one section open at a time, pinned sections stay open while others fold, remembered
// per page; narrow windows get a drawer over Apple's page.
;(function (root) {
  'use strict'
  const R = root.SonataRailModel || (typeof require === 'function' ? require('./rail-model') : null)
  const K = root.SonataShortcutsModel || (typeof require === 'function' ? require('./shortcuts-model') : null)

  // 360 px wide; docked beside Apple's page while that leaves Apple at least 760 px, else a drawer.
  // Why 760: Apple's web player switches layout at about 740 px wide, and every crossing leaves ~40
  // listeners and ~170 nodes behind in its page (measured 2026-10-16: toggling Apple's view between
  // 760 and 720 px grew it 200 listeners in 5 cycles; every other width range stayed flat). Docked,
  // the panel never pushes Apple's page across it; a drawer doesn't change Apple's width at all.
  const PANEL = { width: 360, minApple: 760, drawerMargin: 40 }

  // The main window's views: Apple's page | the panel | the rail's room. Pinned rail first (its own
  // rule, rail-model.js), then the panel: docked (Apple's view narrows, so Apple's vw units and fixed
  // panels end where the panel begins) or, when that would squeeze Apple's page, a drawer over it.
  // -> { apple, rail, panel (null when hidden), panelMode: 'hidden' | 'docked' | 'drawer', mode, room }
  function windowLayout(contentWidth, contentHeight, opts) {
    const o = opts || {}
    const base = R.viewBounds(contentWidth, contentHeight, !!o.pinned, !!o.wide)
    const out = Object.assign({}, base, { panel: null, panelMode: 'hidden' })
    if (!o.panelShown) return out
    const w = base.apple.width + base.room
    const h = base.apple.height
    const left = w - base.room - PANEL.width
    if (left >= PANEL.minApple) {
      out.apple = Object.assign({}, base.apple, { width: left })
      out.panel = { x: left, y: 0, width: PANEL.width, height: h }
      out.panelMode = 'docked'
    } else {
      const pw = Math.max(0, Math.min(PANEL.width, w - base.room - PANEL.drawerMargin))
      out.panel = { x: w - base.room - pw, y: 0, width: pw, height: h }
      out.panelMode = 'drawer'
    }
    return out
  }

  // --- pages and sections (the one registry: deep links, tests and the UI use it) ---
  const PAGES = {
    settings: {
      title: 'Settings',
      sections: [
        { id: 'playback', title: 'Playback & lyrics', icon: 'music' },
        { id: 'timing', title: 'Precise timing', icon: 'timer' },
        { id: 'appearance', title: 'Appearance', icon: 'palette' },
        { id: 'windows', title: 'Mini player & windows', icon: 'windows' },
        { id: 'shortcuts', title: 'Global shortcuts', icon: 'keyboard' },
        { id: 'integrations', title: 'Integrations', icon: 'plug' },
        { id: 'updates', title: 'Updates', icon: 'refresh' },
        { id: 'startup', title: 'Startup', icon: 'power' },
        // switches still being tested (gfx-model.js EXPERIMENTS); off until turned on
        { id: 'experimental', title: 'Experimental', icon: 'flask' }
      ]
    },
    about: {
      title: 'About',
      sections: [
        // the DS5 About's sections (Guide only where an app has a guide: Sonata has none); the hero
        // card above them carries the links
        { id: 'whatsnew', title: 'App changes', icon: 'scroll' },
        { id: 'soon', title: 'Coming soon', icon: 'flag' },
        { id: 'credits', title: 'Credits', icon: 'heart' },
        // the graphics readout (gfx-model.js graphicsRows): what this start uses, measured while it shows
        { id: 'graphics', title: 'Graphics', icon: 'monitor' },
        // the honest numbers (curious-model.js); main samples only while this section is open and shown
        { id: 'curious', title: 'For the Curious', icon: 'activity' }
      ]
    }
  }
  const PAGE_IDS = Object.keys(PAGES)
  const sectionIds = (page) => (PAGES[page] ? PAGES[page].sections.map((s) => s.id) : [])

  // --- the accordion: { open: id | null, pins: [ids] } per page ---
  function accState(stored, page) {
    const ids = sectionIds(page)
    const s = stored || {}
    return {
      open: typeof s.open === 'string' && ids.includes(s.open) ? s.open : null,
      pins: Array.isArray(s.pins) ? s.pins.filter((p, i, a) => ids.includes(p) && a.indexOf(p) === i) : []
    }
  }
  const isOpen = (st, id) => st.open === id || st.pins.includes(id)
  const isPinned = (st, id) => st.pins.includes(id)

  // the DS5 rules: one open (unpinned) section; a pinned header folds it and drops the pin (else the
  // header would do nothing); unpinning leaves it open as the one open section; Collapse all folds
  // every section, pins too; Clear pins folds the pinned ones and keeps the open one.
  function accReduce(st, action) {
    const a = action || {}
    const id = a.id
    switch (a.type) {
      case 'toggle':
        if (st.pins.includes(id)) return { open: st.open === id ? null : st.open, pins: st.pins.filter((p) => p !== id) }
        return { open: st.open === id ? null : id, pins: st.pins }
      case 'pin':
        if (st.pins.includes(id)) return { open: id, pins: st.pins.filter((p) => p !== id) }
        return { open: st.open === id ? null : st.open, pins: st.pins.concat([id]) }
      case 'reveal':
        return st.pins.includes(id) ? st : { open: id, pins: st.pins }
      case 'collapseAll':
        return { open: null, pins: [] }
      case 'clearPins':
        return { open: st.open, pins: [] }
      default:
        return st
    }
  }

  // the ⋮ menu: an item that would do nothing is disabled (and says why)
  function menuItems(st) {
    const anyOpen = st.open !== null || st.pins.length > 0
    return [
      { id: 'collapseAll', label: 'Collapse all', disabled: !anyOpen, tip: anyOpen ? 'Fold every section, pinned ones too' : 'Every section is folded already' },
      { id: 'clearPins', label: 'Clear pins', disabled: !st.pins.length, tip: st.pins.length ? 'Unpin every section (they fold; the open one stays open)' : 'No section is pinned' }
    ]
  }

  // ↑ ↓ Home End between the headers (the WAI-ARIA accordion pattern); -> the new index or -1
  function headerKey(key, index, count) {
    if (!count) return -1
    const i = Math.max(0, Math.min(count - 1, index | 0))
    if (key === 'ArrowDown') return (i + 1) % count
    if (key === 'ArrowUp') return (i - 1 + count) % count
    if (key === 'Home') return 0
    if (key === 'End') return count - 1
    return -1
  }

  // --- the sections' one-line status (from the settings snapshot main sends) ---
  const onOff = (name, on) => name + (on ? ' on' : ' off')
  function sectionStatus(page, id, s) {
    const st = s || {}
    if (page === 'settings') {
      switch (id) {
        case 'playback': return [st.lrclibFallback ? 'LRCLIB on' : 'Apple lyrics only', st.estimatedWordTiming ? 'estimated words' : 'line timing', st.notifications ? 'notifications' : null].filter(Boolean).join(' · ')
        case 'timing': return [onOff('Listening', !!st.lyricsListenRefine && !!st.estimatedWordTiming), st.alignInstalled ? onOff('Precise', !!st.lyricsPreciseTiming) : 'Precise: helper not installed'].join(' · ')
        case 'appearance': return [{ system: 'System theme', light: 'Light', dark: 'Dark' }[st.theme] || 'System theme', st.adaptiveColor ? 'album colours' : 'no album colours', st.adaptiveColor && st.glass ? 'Glass' : null].filter(Boolean).join(' · ')
        case 'windows': return [st.miniAlwaysOnTop ? 'Mini player on top' : null, st.lyricsAlwaysOnTop ? 'lyrics on top' : null].filter(Boolean).join(' · ') || 'Nothing kept on top'
        case 'shortcuts': return K.statusLine(st.shortcuts)
        case 'integrations': return ['Last.fm ' + (st.lastfmConnected ? 'connected' : 'off'), 'Discord ' + (st.discordEnabled ? 'on' : 'off')].join(' · ')
        case 'updates': return [st.updateChannel === 'dev' ? 'Development' : 'Stable', !st.checkForUpdates ? 'no automatic checks' : st.autoInstallUpdates ? 'installs automatically' : 'asks before installing'].join(' · ')
        case 'startup': return [st.closeToTray ? 'Close to tray' : null, st.launchAtLogin ? 'Launch at login' : null, st.startMinimized ? 'Start minimized' : null].filter(Boolean).join(' · ') || 'All off'
        case 'experimental': return experimentalStatus(st)
      }
    }
    return ''
  }

  // Experimental's one line: how many switches are on (the graphics switches, and Sheet notes in the Studio
  // when its row shows: the word-timing helper installed), and whether a restart is waiting
  function experimentalStatus(st) {
    const g = st.gfx
    if (!g) return ''
    const n = (g.keys || []).filter((k) => st[k] === true).length + (st.sheetNotes === true && st.alignInstalled ? 1 : 0)
    return [n ? n + ' on' : 'All off', g.safe ? 'safe start' : null, g.pending && g.pending.length ? 'restart to apply' : null].filter(Boolean).join(' · ')
  }

  // the Tab / F6 cycle between the window's views: Apple's page -> the panel (when shown) -> the rail -> Apple's page
  // -> the view to focus next from `from` ('apple' | 'panel' | 'rail'), forward or back
  function focusNext(from, back, panelShown) {
    const ring = panelShown ? ['apple', 'panel', 'rail'] : ['apple', 'rail']
    const i = ring.indexOf(from)
    if (i < 0) return 'apple'
    return ring[(i + (back ? ring.length - 1 : 1)) % ring.length]
  }

  // the panel's commands (main checks the sender, then this list and each argument)
  const COMMANDS = ['mounted', 'set', 'action', 'notice-action', 'notice-dismiss', 'acc', 'hide', 'focus-next', 'focus-prev', 'open-link', 'show-page', 'toast-done', 'toast-action', 'toast-size', 'shortcut-key', 'shortcut-capture']

  const api = { PANEL, PAGES, PAGE_IDS, COMMANDS, windowLayout, sectionIds, accState, isOpen, isPinned, accReduce, menuItems, headerKey, sectionStatus, focusNext }
  if (typeof module === 'object' && module.exports) module.exports = api
  else root.SonataPanelModel = Object.freeze(api)
})(typeof globalThis !== 'undefined' ? globalThis : this)
