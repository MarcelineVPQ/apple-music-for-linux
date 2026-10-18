// The side panel's rules (panel-model.js), notices and toasts (notices-model.js), About's data
// (about-data.js) and the small Markdown reader (markdown-lite.js).
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')
const vm = require('vm')
const P = require('../panel-model')
const N = require('../notices-model')
const A = require('../about-data')
const MD = require('../markdown-lite')

test('layout: docked beside Apple while Apple keeps >= 760 px (its ~740 px breakpoint leaks), else a drawer over it; hidden: Apple as before', () => {
  for (const [w, pinned, mode] of [[1600, false, 'docked'], [1100, false, 'drawer'], [1100, true, 'drawer'], [800, false, 'drawer'], [3840, true, 'docked'], [1172, false, 'docked'], [1171, false, 'drawer'], [1316, true, 'docked'], [1315, true, 'drawer']]) {
    const L = P.windowLayout(w, 700, { pinned, panelShown: true })
    const room = L.room
    assert.equal(L.panelMode, mode, w + ' pinned=' + pinned)
    assert.equal(L.panel.x + L.panel.width, w - room, 'the panel ends where the rail\'s room begins')
    if (mode === 'docked') {
      assert.equal(L.apple.width, w - room - P.PANEL.width, 'Apple\'s view ends where the panel begins')
      assert.ok(L.apple.width >= P.PANEL.minApple)
      assert.equal(L.panel.width, P.PANEL.width)
    } else {
      assert.equal(L.apple.width, w - room, 'drawer: Apple keeps its width')
      assert.ok(L.panel.width <= P.PANEL.width && L.panel.width >= 280)
      assert.ok(L.panel.x >= P.PANEL.drawerMargin, 'a strip of Apple\'s page stays visible')
    }
    assert.equal(L.panel.height, 700)
  }
  const hidden = P.windowLayout(1600, 900, { panelShown: false })
  assert.equal(hidden.panel, null)
  assert.equal(hidden.panelMode, 'hidden')
  assert.equal(hidden.apple.width, 1600 - 52)
})

test('accordion: one open section, pins stay open, DS5 rules for pinned headers and unpinning', () => {
  let st = P.accState({}, 'settings')
  assert.deepEqual(st, { open: null, pins: [] })
  st = P.accReduce(st, { type: 'toggle', id: 'updates' })
  assert.deepEqual(st, { open: 'updates', pins: [] })
  st = P.accReduce(st, { type: 'toggle', id: 'startup' })
  assert.deepEqual(st, { open: 'startup', pins: [] }, 'another one folds the first')
  st = P.accReduce(st, { type: 'pin', id: 'appearance' })
  assert.ok(P.isOpen(st, 'appearance') && P.isOpen(st, 'startup') && !P.isOpen(st, 'updates'))
  st = P.accReduce(st, { type: 'toggle', id: 'updates' })
  assert.ok(P.isOpen(st, 'appearance'), 'a pinned section stays open while others fold')
  assert.ok(!P.isOpen(st, 'startup'))
  // a pinned header folds it and drops the pin
  st = P.accReduce(st, { type: 'toggle', id: 'appearance' })
  assert.ok(!P.isOpen(st, 'appearance') && !P.isPinned(st, 'appearance'))
  // unpinning leaves it open as the one open section
  st = P.accReduce(P.accReduce(st, { type: 'pin', id: 'timing' }), { type: 'pin', id: 'timing' })
  assert.deepEqual(st, { open: 'timing', pins: [] })
  // reveal (a deep link) opens without touching pins
  assert.deepEqual(P.accReduce({ open: null, pins: ['startup'] }, { type: 'reveal', id: 'updates' }), { open: 'updates', pins: ['startup'] })
  // remembered state is cleaned: unknown ids and duplicates go
  assert.deepEqual(P.accState({ open: 'nope', pins: ['updates', 'updates', 'x'] }, 'settings'), { open: null, pins: ['updates'] })
})

test('⋮ menu: Collapse all folds everything (pins too), Clear pins keeps the open one; disabled when it would do nothing', () => {
  const st = { open: 'updates', pins: ['startup', 'appearance'] }
  assert.deepEqual(P.accReduce(st, { type: 'collapseAll' }), { open: null, pins: [] })
  assert.deepEqual(P.accReduce(st, { type: 'clearPins' }), { open: 'updates', pins: [] })
  const m = P.menuItems(st)
  assert.deepEqual(m.map((x) => [x.id, x.disabled]), [['collapseAll', false], ['clearPins', false]])
  const none = P.menuItems({ open: null, pins: [] })
  assert.ok(none.every((x) => x.disabled && x.tip))
  assert.deepEqual(P.menuItems({ open: 'x', pins: [] }).map((x) => x.disabled), [false, true])
})

test('header keys: ↑ ↓ wrap, Home End jump, others pass; focus cycle apple -> panel -> rail', () => {
  assert.equal(P.headerKey('ArrowDown', 6, 7), 0)
  assert.equal(P.headerKey('ArrowUp', 0, 7), 6)
  assert.equal(P.headerKey('Home', 4, 7), 0)
  assert.equal(P.headerKey('End', 1, 7), 6)
  assert.equal(P.headerKey('Enter', 1, 7), -1)
  assert.equal(P.focusNext('apple', false, true), 'panel')
  assert.equal(P.focusNext('panel', false, true), 'rail')
  assert.equal(P.focusNext('rail', false, true), 'apple')
  assert.equal(P.focusNext('apple', true, true), 'rail')
  assert.equal(P.focusNext('rail', true, true), 'panel')
  assert.equal(P.focusNext('apple', false, false), 'rail', 'panel hidden: skipped')
  assert.equal(P.focusNext('rail', true, false), 'apple')
})

test('settings sections: every setting of the old Settings window has a section; statuses say the state in words', () => {
  const ids = P.sectionIds('settings')
  assert.deepEqual(ids, ['playback', 'timing', 'appearance', 'windows', 'shortcuts', 'integrations', 'updates', 'startup'])
  const ui = fs.readFileSync(path.join(__dirname, '..', 'panel-ui.js'), 'utf8')
  // every toggle the retired settings.html had
  for (const k of ['notifications', 'closeToTray', 'launchAtLogin', 'startMinimized', 'adaptiveColor', 'lyricsAlwaysOnTop', 'lyricsArtSpin', 'lrclibFallback', 'estimatedWordTiming', 'lyricsListenRefine', 'lyricsPreciseTiming', 'lyricsArtSpinSpeed', 'updateChannel']) {
    assert.match(ui, new RegExp("(switchRow|selectRow)\\('" + k + "'"), k)
  }
  assert.match(ui, /action: 'lastfm'/)
  assert.match(ui, /action: 'discord'/)
  const s = { lrclibFallback: true, estimatedWordTiming: true, notifications: false, updateChannel: 'dev', checkForUpdates: true, autoInstallUpdates: false, closeToTray: true, launchAtLogin: false, startMinimized: false, adaptiveColor: true, glass: true, theme: 'dark' }
  assert.equal(P.sectionStatus('settings', 'updates', s), 'Development · asks before installing')
  assert.equal(P.sectionStatus('settings', 'startup', s), 'Close to tray')
  assert.equal(P.sectionStatus('settings', 'startup', {}), 'All off')
  assert.equal(P.sectionStatus('settings', 'appearance', s), 'Dark · album colours · Glass')
  assert.equal(P.sectionStatus('settings', 'updates', Object.assign({}, s, { checkForUpdates: false })), 'Development · no automatic checks')
  assert.deepEqual(P.sectionIds('about'), ['whatsnew', 'soon', 'credits', 'curious'])
})

test('panel-model: one file, two worlds (frozen global without CommonJS)', () => {
  const ctx = vm.createContext({})
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'rail-model.js'), 'utf8'), ctx)
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'panel-model.js'), 'utf8'), ctx)
  const G = vm.runInContext('globalThis.SonataPanelModel', ctx)
  assert.ok(Object.isFrozen(G))
  assert.equal(G.windowLayout(1600, 900, { panelShown: true }).panelMode, 'docked')
})

test('notices: shown, replaced by id, dismissed by key across restarts until the reason changes, pruned', () => {
  let saved = null
  let changes = 0
  const n = N.createNotices({ saveDismissed: (k) => { saved = k }, onChange: () => changes++ })
  n.show({ id: 'update', task: true, dismissKey: 'update:0.16.0', text: 'Sonata 0.16.0 is available.', actions: [{ id: 'update-install', label: 'Update', primary: true }] })
  n.show({ id: 'lastfm', place: { page: 'settings', section: 'integrations' }, text: 'Allow Sonata…' })
  assert.equal(n.visible().length, 2)
  const c = changes
  n.show({ id: 'lastfm', place: { page: 'settings', section: 'integrations' }, text: 'Allow Sonata…' })
  assert.equal(changes, c, 'the same notice again changes nothing')
  // dots: the task's page and section
  assert.deepEqual(n.reminders().pages, { settings: 'Sonata 0.16.0 is available.' })
  // dismiss a task: hidden, key kept; the dot stays (it follows the task)
  assert.ok(n.dismiss('update'))
  assert.deepEqual(saved, ['update:0.16.0'])
  assert.equal(n.visible().length, 1)
  assert.ok(n.reminders().pages.settings)
  // a restart: the key is remembered
  const again = N.createNotices({ dismissed: saved })
  again.show({ id: 'update', task: true, dismissKey: 'update:0.16.0', text: 'x' })
  assert.equal(again.visible().length, 0)
  // a new reason shows again
  again.show({ id: 'update', task: true, dismissKey: 'update:0.16.1', text: 'y' })
  assert.equal(again.visible().length, 1)
  // prune: the key of a reason that no longer applies goes
  let kept = null
  const p = N.createNotices({ dismissed: ['update:0.16.0', 'other:1'], saveDismissed: (k) => { kept = k } })
  p.prune({ update: [] })
  assert.deepEqual(kept, ['other:1'])
  // a non-task × just closes
  assert.ok(n.dismiss('lastfm'))
  assert.equal(n.has('lastfm'), false)
  // not closable: the × does nothing
  n.show({ id: 'dl', closable: false, text: 'Downloading…' })
  assert.equal(n.dismiss('dl'), false)
  assert.equal(N.parseDismissed(['a', 5, null, 'b']).length, 2)
  assert.equal(N.parseDismissed(Array.from({ length: 80 }, (_, i) => 'k' + i)).length, N.MAX_DISMISSED)
})

test('toasts: ≤ 3, same words restart instead of stacking, nothing queued while the window is hidden', () => {
  let shown = true
  const n = N.createNotices({ windowShown: () => shown })
  const a = n.toast('One')
  n.toast('Two'); n.toast('Three'); n.toast('Four')
  assert.deepEqual(n.toasts().map((t) => t.text), ['Two', 'Three', 'Four'])
  const before = n.toasts().find((t) => t.text === 'Four').shownAt
  n.toast('Four')
  assert.equal(n.toasts().length, 3)
  assert.ok(n.toasts().find((t) => t.text === 'Four').shownAt > before, 'its timer restarts')
  assert.ok(Number.isInteger(a))
  n.endToast(n.toasts()[0].id)
  assert.equal(n.toasts().length, 2)
  shown = false
  assert.equal(n.toast('Unseen'), null)
  assert.equal(n.toasts().length, 2)
  assert.ok(N.toastDuration('short', false) >= N.TOAST_MS)
  assert.ok(N.toastDuration('a '.repeat(40), false) > N.TOAST_MS, 'long words stay longer')
  assert.ok(N.toastDuration('x', true) >= N.TOAST_ACTION_MS)
})

test('about: What\'s new = this version\'s CHANGELOG section, older ones after; Coming soon from BACKLOG "Soon:" rows', () => {
  const md = '# Changelog\n\nintro\n\n## [Unreleased]\n\n## [0.15.32] — Panel\n\n### Added\n\n- **A** thing\n\n## [0.15.31] — Rail\n\n- b\n'
  const w = A.whatsNew(md, '0.15.32')
  assert.equal(w.current.version, '0.15.32')
  assert.equal(w.current.title, 'Panel')
  assert.match(w.current.body, /\*\*A\*\* thing/)
  assert.deepEqual(w.older.map((s) => s.version), ['0.15.31'])
  // a dev build: the newest section is shown
  assert.equal(A.whatsNew(md, '0.15.33-dev.1').current.version, '0.15.32')
  const backlog = '| Item | Status | Notes |\n|---|---|---|\n| View the album cover | **Planned** | Soon: open the album cover large. dev notes here |\n| Thing | **Done** | Soon: never shown. |\n| Other | **Idea** | no marker |\n'
  assert.deepEqual(A.comingSoon(backlog), [{ title: 'View the album cover', text: 'open the album cover large.', status: 'Planned' }])
  // the real files read and give something
  const real = A.aboutData(fs.readFileSync(path.join(__dirname, '..', 'CHANGELOG.md'), 'utf8'), fs.readFileSync(path.join(__dirname, '..', 'BACKLOG.md'), 'utf8'), require('../package.json').version, false)
  assert.equal(real.whatsNew.current.version, require('../package.json').version, 'the running version has its CHANGELOG section')
  // at least one: 0.15.39 shipped most of the marked rows, so the count moves with the BACKLOG
  assert.ok(real.soon.length >= 1, 'Coming soon lists the marked BACKLOG rows')
  assert.ok(real.credits.some((g) => g.rows.some((r) => /castlabs/.test(r.text))))
  assert.ok(real.credits.some((g) => g.rows.some((r) => /LRCLIB/.test(r.what))))
  assert.ok(real.credits.some((g) => g.rows.some((r) => /Poly Haven/.test(r.text) && /CC0/.test(r.text))))
  assert.equal(real.patterns.length, 20)
  assert.match(real.notAffiliated, /not affiliated/)
  assert.ok(real.links.every((l) => /^https:\/\//.test(l.url)))
  assert.ok(/\/releases$/.test(real.releases) && /\/issues$/.test(real.issues))
  assert.ok(real.soonGroups.length >= 1 && real.soonGroups.reduce((n, g) => n + g.items.length, 0) === real.soon.length, 'every plan in one group')
  // every shipped hyphenation pattern file has its licence listed
  const files = require('../package.json').build.files.find((f) => f.includes('patterns/!('))
  const shipped = /!\(([^)]+)\)/.exec(files)[1].split('|')
  assert.deepEqual(real.patterns.map((p) => p.code).sort(), shipped.sort())
})

test('markdown-lite: headings, lists, bold/italic/code, https links only; no HTML passes through', () => {
  const b = MD.parse('### Added\n\n- **Bold** and *it* and `code`\n  continued\n- [link](https://x.y) and [bad](javascript:alert(1))\n\nA <b>tag</b> stays text.')
  assert.equal(b[0].t, 'h')
  assert.equal(b[1].t, 'ul')
  assert.equal(MD.plain(b[1].items[0]), 'Bold and it and code continued')
  const links = b[1].items[1].filter((n) => n.t === 'a')
  assert.equal(links.length, 1)
  assert.equal(links[0].href, 'https://x.y')
  assert.equal(MD.plain(b[2].c), 'A <b>tag</b> stays text.')
})

test('about: the hero card (the 42PS card, as in the DS5 About): version, channel, the four links, the © line', () => {
  const h = A.hero('0.15.38-dev.1', 'dev', true, 2026)
  assert.equal(h.eyebrow, 'A 42 Pixel Studios production')
  assert.equal(h.name, 'Sonata')
  assert.equal(h.by, 'Marcy Kuhn')
  assert.equal(h.version, '0.15.38-dev.1')
  assert.equal(h.channel, 'dev')
  assert.equal(h.line, 'v0.15.38-dev.1 · Development')
  assert.equal(A.hero('0.15.38', 'stable', true, 2026).line, 'v0.15.38 · Stable')
  assert.equal(A.hero('0.15.38', 'stable', false, 2026).line, 'v0.15.38 · Stable · from source')
  assert.equal(h.copyright, '© 2026 42 Pixel Studios — a Marcy Kuhn production.')
  assert.doesNotMatch(JSON.stringify(h), /joint/i, '"production", never "joint"')
  assert.deepEqual(h.links.map((l) => [l.label, l.url]), [
    ['42pixelstudios.com', 'https://42pixelstudios.com/'],
    ['github.com/MarcelineVPQ', 'https://github.com/MarcelineVPQ'],
    ['Source code (GPL-3.0)', 'https://github.com/MarcelineVPQ/apple-music-for-linux'],
    ['Report an issue', 'https://github.com/MarcelineVPQ/apple-music-for-linux/issues']
  ])
  // every link has an icon the icon set draws, and the licence named is the repo's
  const I = require('../icons')
  for (const l of h.links) assert.ok(I.ICONS[l.icon], l.icon)
  assert.match(fs.readFileSync(path.join(__dirname, '..', 'LICENSE'), 'utf8'), /GNU GENERAL PUBLIC LICENSE\s+Version 3/)
  // the app icon the card shows ships in the AppImage
  assert.ok(require('../package.json').build.files.includes('sonata.svg'))
  // main sends it with each panel snapshot (live channel)
  assert.match(fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8'), /hero: aboutDataLib\.hero\(app\.getVersion\(\), settings\.updateChannel, !!appImagePath\)/)
})

test('about: Coming soon groups follow the DS5 board (In progress, Planned, Ideas; empty groups left out)', () => {
  const g = A.soonGroups([{ title: 'a', text: 'x.', status: 'Planned' }, { title: 'b', text: 'y.', status: 'Building' }, { title: 'c', text: 'z.', status: 'Planned' }])
  assert.deepEqual(g.map((x) => [x.label, x.items.map((i) => i.title)]), [['In progress', ['b']], ['Planned', ['a', 'c']]])
})
