// Side panel + toasts wiring: the preload bridge, main.js's checks on every panel command, the pages'
// security (CSP, no Node, no HTML strings, untrusted clicks ignored), the retired Settings window and
// the dialogs that became notices.
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')
const Module = require('module')

const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8')
const code = (src) => src.replace(/\/\/.*$/gm, '')

test('panel preload: send / onState / onFocus only; arguments are plain values, at most three', () => {
  const sent = []
  const handlers = {}
  let exposed = null
  const fake = {
    ipcRenderer: { send: (...a) => sent.push(a), on: (ch, fn) => { handlers[ch] = fn } },
    contextBridge: { exposeInMainWorld: (name, api) => { exposed = { name, api } } }
  }
  const orig = Module._load
  Module._load = function (req, ...rest) { return req === 'electron' ? fake : orig.call(this, req, ...rest) }
  try { delete require.cache[require.resolve('../preload-panel')]; require('../preload-panel') } finally { Module._load = orig }
  assert.equal(exposed.name, 'sonataPanelBridge')
  assert.deepEqual(Object.keys(exposed.api).sort(), ['onFocus', 'onState', 'send'])
  assert.deepEqual(Object.keys(handlers).sort(), ['panel:state', 'panel:take-focus'])
  exposed.api.send('set', 'glass', false, { evil: 1 }, 4, 5)
  assert.deepEqual(sent[0], ['panel:command', 'set', 'glass', false, '[object Object]'])
  let where = null
  exposed.api.onFocus((w) => { where = w })
  handlers['panel:take-focus']({}, 'weird')
  assert.equal(where, 'first')
})

test('main: panel commands come only from the panel or toast view\'s top frame, each argument checked', () => {
  const src = read('main.js')
  const at = src.indexOf("ipcMain.on('panel:command'")
  const h = src.slice(at, src.indexOf('\n})', at))
  assert.match(h, /!event\.senderFrame \|\| event\.senderFrame\.parent/)
  assert.match(h, /panelModel\.COMMANDS\.includes\(command\)/)
  assert.match(h, /event\.sender === toastView\.webContents/)
  assert.match(h, /event\.sender === panelView\.webContents/)
  assert.match(h, /if \(!fromPanel\) return/)
  assert.match(h, /command === 'set' && typeof a === 'string'\) setSetting\(a, b\)/)
  assert.match(h, /PANEL_ACTIONS\.includes\(a\)/)
  assert.match(h, /panelModel\.PAGE_IDS\.includes\(a\)/)
  assert.match(h, /open-link' && typeof a === 'string' && \/\^https:/)
  // setSetting: only the panel's keys, each validated by settings-store
  const s = src.slice(src.indexOf('function setSetting('), src.indexOf('function setSetting(') + 900)
  assert.match(s, /!PANEL_SETTABLE\.includes\(key\) \|\| !settingsStore\.validSetting\(key, value\)/)
  assert.match(s, /\['system', 'light', 'dark'\]\.includes\(value\)/)
  // notice actions only for notices on screen, and only their own buttons
  const n = src.slice(src.indexOf('function noticeAction('), src.indexOf('function noticeAction(') + 300)
  assert.match(n, /if \(!n \|\| !n\.actions\.some\(\(a\) => a\.id === action && !a\.disabled\)\) return/)
  assert.equal((src.match(/ipcMain\.on\('panel:command'/g) || []).length, 1)
})

test('the floating Settings window is retired; tray, menus and --settings open the panel', () => {
  const src = read('main.js')
  assert.ok(!fs.existsSync(path.join(__dirname, '..', 'settings.html')))
  assert.doesNotMatch(src, /settings\.html|createSettingsWindow|settingsWindow|'settings:(get|set|action)'|'align:status'/)
  assert.match(src, /label: 'Settings…', click: \(\) => showPanel\('settings'\)/)
  assert.match(src, /label: 'About Sonata', click: \(\) => showPanel\('about'\)/)
  assert.match(src, /'--settings'\)\) \{\s*showPanel\('settings'\)/)
  // showPanel brings a hidden main window back
  const sp = src.slice(src.indexOf('function showPanel('), src.indexOf('function hidePanel('))
  assert.match(sp, /if \(!mainWindow\.isVisible\(\)\) mainWindow\.show\(\)/)
})

test('informational pop-ups became notices or toasts; no dialog.showMessageBox left but the question before quitting', () => {
  // the one question left is the quit guard's (quit-guard.js): it must show while the window is in the
  // tray and must answer before Sonata exits, which a notice can't
  const src = code(read('main.js')).replace(/const quitGuard = quitGuardLib\.createQuitGuard\(\{[\s\S]*?\n\}\)\n/, '')
  assert.doesNotMatch(src, /dialog\.showMessageBox/)
  for (const id of ["id: 'discord'", "id: 'lastfm'", "id: 'whatsnew'", "id: 'ask-auto'"]) assert.ok(read('main.js').includes(id), id)
})

test('panel and toast pages: local scripts only (CSP), no Node, no HTML strings, untrusted clicks ignored, no polling', () => {
  for (const f of ['panel.html', 'toast.html']) {
    const html = read(f)
    assert.match(html, /Content-Security-Policy" content="default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:"/, f)
    assert.doesNotMatch(html, /https?:\/\/(?!www\.w3\.org)/, f)
  }
  for (const f of ['panel-ui.js', 'toast-ui.js']) {
    const src = code(read(f))
    assert.doesNotMatch(src, /innerHTML|insertAdjacentHTML|outerHTML|eval\(|new Function|require\(/, f)
    assert.doesNotMatch(src, /setInterval|requestAnimationFrame|MutationObserver|ResizeObserver/, f)
  }
  const ui = code(read('panel-ui.js'))
  assert.doesNotMatch(ui, /setTimeout/, 'the panel schedules nothing')
  // every click handler that sends a command checks isTrusted
  const clicks = ui.match(/addEventListener\('click', \(e\) => \{[^\n]*(\n[^\n]*){0,2}/g) || []
  assert.ok(clicks.length >= 6)
  for (const c of clicks) assert.match(c, /e\.isTrusted/, c)
  assert.doesNotMatch(ui, /<details|'details'/)
  // the rail item is the one way to show or hide the panel (plus Esc for the drawer): no header hide button
  assert.doesNotMatch(ui, /hide-btn|Hide the panel|'pinClose'/)
  assert.match(ui, /head\.append\(titles, menuBtn\)/)
  // from source the Updates section shows a status line, not greyed-out controls
  assert.match(ui, /running from source: only the AppImage updates itself/)
  assert.doesNotMatch(ui, /disabled: \(v\) => !v\.appImage/)
})

test('accessibility in the markup: headers are buttons with aria-expanded/controls, pins aria-pressed, switches role=switch and named', () => {
  const ui = read('panel-ui.js')
  assert.match(ui, /setAttr\(sec\.toggle, 'aria-expanded'/)
  assert.match(ui, /setAttr\(sec\.toggle, 'aria-controls', open \? sec\.bodyWrap\.id : null\)/)
  assert.match(ui, /setAttr\(sec\.pin, 'aria-pressed'/)
  assert.match(ui, /setAttr\(pin, 'aria-label', 'Keep ' \+ def\.title \+ ' open'\)/)
  assert.match(ui, /setAttr\(b, 'role', 'switch'\)/)
  assert.match(ui, /setAttr\(b, 'aria-labelledby', label\.id\)/)
  assert.match(ui, /setAttr\(menu, 'role', 'menu'\)/)
  assert.match(ui, /e\.key === 'Escape'/)
  assert.match(ui, /bridge\.send\(e\.shiftKey \? 'focus-prev' : 'focus-next'\)/)
})

// the Settings IA pass (2026-10-19, Marcy approved): placement and text only
test('Settings IA: visible hints ≤ 60 characters, one dev check, the merged Startup id lands in Windows & startup', () => {
  const ui = read('panel-ui.js')
  const settings = ui.slice(ui.indexOf('    settings: {'), ui.indexOf('    about: {'))
  // every literal visible line of a switch / select (the rest goes behind the ⓘ)
  const lines = [...settings.matchAll(/(?:switchRow|selectRow)\('\w+', '((?:[^'\\]|\\.)*)', '((?:[^'\\]|\\.)*)'/g)].map((m) => [m[1], m[2].replace(/\\'/g, '\'')])
  assert.ok(lines.length >= 25, 'found the rows: ' + lines.length)
  for (const [label, line] of lines) assert.ok(line.length <= 60, label + ': ' + line.length + ' characters')
  // one Development-build check for the dev-only rows (not the channel, not a version regex)
  assert.doesNotMatch(settings, /updateChannel !== 'dev'|-dev\(/)
  assert.match(ui, /const devOnly = \(v\) => !v\.devBuild/)
  assert.ok((settings.match(/devOnly\(v\)/g) || []).length >= 5)
  const main = read('main.js')
  assert.match(main, /devBuild: updateFeed\.isDevVersion\(app\.getVersion\(\)\)/)
  // a merged section's old id (Startup) lands where it went; Lyrics & Studio's Set up Precise timing opens Precise timing
  assert.match(main, /section = panelModel\.sectionId\(settings\.panelPage, section\)/)
  assert.match(main, /else if \(name === 'show-timing'\) showPanel\('settings', 'timing'\)/)
  assert.match(main, /const PANEL_ACTIONS = \[[^\]]*'show-timing'/)
  // Precise timing: the helper first, the danger zone (Remove the helper) last; Estimated + Refine under "Without the helper"
  const timing = settings.slice(settings.indexOf('timing: () => {'), settings.indexOf('playback: () => ['))
  assert.ok(timing.indexOf('helper,') < timing.indexOf("switchRow('alignAutoUpdate'") && timing.indexOf("switchRow('alignAutoUpdate'") < timing.indexOf("switchRow('lyricsPreciseTiming'"))
  assert.ok(timing.indexOf("group('Without the helper'") < timing.indexOf("switchRow('estimatedWordTiming'") && timing.indexOf("switchRow('estimatedWordTiming'") < timing.indexOf("switchRow('lyricsListenRefine'"))
  assert.match(timing, /helper\.danger\n\s*\]\n\s*\},\s*$/)
  // with Precise not ready, Expressive words and Sheet notes say so and offer the way there (no greyed dead end)
  assert.equal((settings.match(/'Needs Precise timing', \[\{ label: 'Set up Precise timing', action: 'show-timing' \}\]/g) || []).length, 2)
  assert.doesNotMatch(settings, /Check now'/)
})
