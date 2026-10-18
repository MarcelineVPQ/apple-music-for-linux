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
  const V = root.SonataVersionDisplay || (typeof require === 'function' ? require('./version-display') : null)

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
        case 'timing': return [onOff('Listening', !!st.lyricsListenRefine && !!st.estimatedWordTiming), timingHelper(st)].join(' · ')
        case 'appearance': return [{ system: 'System theme', light: 'Light', dark: 'Dark' }[st.theme] || 'System theme', st.adaptiveColor ? 'album colours' : 'no album colours', st.adaptiveColor && st.glass ? 'Glass' : null].filter(Boolean).join(' · ')
        case 'windows': return [st.miniAlwaysOnTop ? 'Mini player on top' : null, st.lyricsAlwaysOnTop ? 'lyrics on top' : null].filter(Boolean).join(' · ') || 'Nothing kept on top'
        case 'shortcuts': return K.statusLine(st.shortcuts)
        case 'integrations': return ['Last.fm ' + (st.lastfmConnected ? 'connected' : 'off'), 'Discord ' + (st.discordEnabled ? 'on' : 'off')].join(' · ')
        case 'updates': return [V.channelName(st.updateChannel), !st.checkForUpdates ? 'no automatic checks' : st.autoInstallUpdates ? 'installs automatically' : 'asks before installing'].join(' · ')
        case 'startup': return [st.closeToTray ? 'Close to tray' : null, st.launchAtLogin ? 'Launch at login' : null, st.startMinimized ? 'Start minimized' : null].filter(Boolean).join(' · ') || 'All off'
        case 'experimental': return experimentalStatus(st)
      }
    }
    return ''
  }

  // Precise timing's part of the line: the helper's job or news first, else the switch
  function timingHelper(st) {
    const h = st.helper || {}
    if (h.phase === 'licence') return 'helper licence to accept'
    if (h.phase === 'running' || h.phase === 'licence-fetch') return h.kind === 'remove' ? 'removing the helper' : 'installing the helper'
    if (h.state === 'update') return 'helper needs an update'
    if (h.state === 'broken' || h.state === 'sandboxed') return 'helper needs a repair'
    if (h.available && st.alignInstalled) return 'helper update available'
    return st.alignInstalled ? onOff('Precise', !!st.lyricsPreciseTiming) : 'Precise: helper not installed'
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

  // About → For the Curious → How it works (Marcy 2026-10-18: "a simple technical explanation, for the
  // curious, for the geeks"): one row per topic, its title, one visible line (≤ 60 characters, the DS5
  // long-text rule) and a few plain sentences behind its ⓘ. Every sentence is true of this build (the
  // code each one rests on is named beside it). Public text says what people see, never how the
  // helper does it: no method, no model names (test/panel-model.test.js keeps both rules).
  // An `info` that states a number is a function of the panel's snapshot (main.js: updateEveryHours,
  // sheetNotesMax), so the words read the constant that sets it (tools/hardcodes.js); curiousInfo() reads either form.
  const CURIOUS_HOW = [
    // update-feed.js (Ed25519 over the feed's bytes, TRUSTED_KEYS; size + SHA-512), updater.js, docs/RELEASING.md
    { id: 'updates', title: 'Updates you can trust', short: 'Built by GitHub from the published source, then signed',
      info: (v) => 'Each release is built on GitHub\'s own build machines from the source code published with it: every release on the public sonata-releases page on GitHub carries that source archive. The update feed Sonata reads is signed with Sonata\'s key. Before installing anything, Sonata checks that signature, then the download\'s size and checksum against the signed feed; if one is wrong, nothing is installed. Only the AppImage updates itself: it checks shortly after it starts and every ' + (v.updateEveryHours === 1 ? 'hour' : v.updateEveryHours + ' hours') + ', or, with automatic checks off, only when you press Check now (Settings → Updates).' },
    // lyrics-sources.js (Apple TTML through the page's MusicKit, then LRCLIB), lyrics-view.js, lyrics-timing.js, lyrics-store.js
    { id: 'lyrics', title: 'Lyrics and word timing', short: 'Apple\'s own time-synced lyrics, else LRCLIB',
      info: 'While a lyrics view is open, Sonata asks Apple Music for the song\'s lyrics through your own Apple Music session. They come timed line by line, and for some songs word by word. When Apple has none, Sonata looks the song up on LRCLIB (lrclib.net, a free open lyrics database), sending only its title, artist, album and length (Settings → LRCLIB lyrics). Word timing means every word has its own start and end, so the karaoke highlight lights the word being sung. A song timed only by line gets its words spread across each line, marked "estimated", until precise timing or listening does better; Timing source above says which one the playing song uses.' },
    // align-session.js (in-memory buffer, sections, never written or sent; only word times kept), align-helper.js, docs/LEVEL2-ALIGN.md
    { id: 'precise', title: 'Precise word timing', short: 'Lines the words up to the singing, on this PC',
      info: 'For songs whose lyrics are timed only by line. With the helper installed and Precise word timing on, Sonata listens to the song as it plays on this PC while a lyrics view is open. The helper separates the voice from the band and lines each word up with the moment it is sung, a few lines at a time, so the words sharpen during the first play, and the result is kept for later plays. It runs on your graphics card (the processor works too, slowly). The audio stays in memory and is dropped afterwards: Sonata never saves it or sends it anywhere, and keeps only the word times. The helper is a separate download with its own licence (Settings → Precise timing).' },
    // sheet-notes-model.js / sheet-notes-ui.js / sheet-notes-store.js (≤ 500 songs, notes only), Settings → Experimental
    { id: 'sheet', title: 'Sheet notes', short: 'The sung melody on a staff, in time with the words',
      info: (v) => 'An experimental part of the Studio (Settings → Experimental) that needs the helper and Precise word timing. The helper hears the melody of the voice and Sonata writes it on a staff above the lyrics, each note with its syllable. The first time a song plays you see a pitch line that follows the voice; from the next play on, notes on a staff. Where the singing doesn\'t sit on notes (rap, speech, shouting) it keeps the pitch line. It works on this PC like the word timing and keeps only the notes, at most ' + Number(v.sheetNotesMax).toLocaleString('en-US') + ' songs, never the audio.' },
    // settings-store.js, lyrics-store.js, liner-notes-*.js, montage-*.js, update-feed.js, lastfm.js, discord.js;
    // no telemetry or crash reporter anywhere; castlabs Electron fetches Google's Widevine module (README "What about DRM?")
    { id: 'data', title: 'Your data', short: 'No account, no telemetry; your caches stay on this PC',
      info: 'Sonata has no account of its own and sends no telemetry or usage data. On this PC it keeps your settings and its caches (sizes above: lyrics and word times, liner notes, Montage photos, sheet notes) in ~/.config/apple-music-for-linux. Audio it listens to stays in memory and is never saved. It goes online for Apple Music itself (signing in, playing, lyrics, artwork) and Google\'s Widevine module that protected playback needs; LRCLIB when Apple has no lyrics; update checks on GitHub; the Montage (off until you turn it on), the liner notes and the Studio\'s credits (see below); setlist.fm only with your own key; Last.fm and Discord only once you connect them. Copy for a bug report puts the numbers on your clipboard and sends nothing.' },
    // montage-sources.js (Wikidata by Apple Music IDs, Commons, free licences with a named author), liner-notes-sources.js
    { id: 'credits', title: 'Montage and liner notes', short: 'Free photos and booklet facts, each with its credit',
      info: 'The Studio\'s Montage shows photos of the artist and the venue from Wikimedia Commons, found through Wikidata by the Apple Music IDs of the artist and album, never by a name search. Only freely licensed photos with a named author are used, and the credit line names each one\'s author and licence. The liner notes bring together Apple\'s own album notes, MusicBrainz and Wikidata facts (free to use, CC0), the album\'s Wikipedia article (CC BY-SA, shown with its title, link and licence, shortened but never reworded) and booklet scans from the Cover Art Archive, which belong to their owners; the Studio\'s song credits come from MusicBrainz too. For a live album, setlist.fm adds the setlist when you have saved your own key.' }
  ]

  const curiousInfo = (h, v) => (typeof h.info === 'function' ? h.info(v || {}) : h.info)

  // the panel's commands (main checks the sender, then this list and each argument)
  const COMMANDS = ['mounted', 'set', 'action', 'notice-action', 'notice-dismiss', 'acc', 'hide', 'focus-next', 'focus-prev', 'open-link', 'show-page', 'toast-done', 'toast-action', 'toast-size', 'shortcut-key', 'shortcut-capture']

  const api = { PANEL, PAGES, PAGE_IDS, COMMANDS, CURIOUS_HOW, curiousInfo, windowLayout, sectionIds, accState, isOpen, isPinned, accReduce, menuItems, headerKey, sectionStatus, focusNext }
  if (typeof module === 'object' && module.exports) module.exports = api
  else root.SonataPanelModel = Object.freeze(api)
})(typeof globalThis !== 'undefined' ? globalThis : this)
