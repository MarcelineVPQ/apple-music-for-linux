// Navigation rail wiring: two views in one window (Apple's page + the rail), the preload bridges,
// main.js security posture and command checks, rail-ui.js / apple-focus.js rules (no timers,
// observers, verdicts), packaging.
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')
const Module = require('module')
const { createCssReplacer } = require('../css-replacer')

const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8')
const code = (src) => src.replace(/\/\/.*$/gm, '')   // comments out, for "does the code do X" checks

function withFakeElectron(fake, fn) {
  const orig = Module._load
  Module._load = function (req, ...rest) { return req === 'electron' ? fake : orig.call(this, req, ...rest) }
  try { return fn() } finally { Module._load = orig }
}

test('rail view preload: send / onState / onFocus only, through contextBridge, state kept until subscribed', () => {
  const sent = []
  const handlers = {}
  let exposed = null
  const fake = {
    ipcRenderer: { send: (...a) => sent.push(a), on: (ch, fn) => { handlers[ch] = (handlers[ch] || []).concat(fn) } },
    contextBridge: { exposeInMainWorld: (name, api) => { exposed = { name, api } } }
  }
  withFakeElectron(fake, () => { delete require.cache[require.resolve('../preload-rail-view')]; require('../preload-rail-view') })
  assert.equal(exposed.name, 'sonataRailBridge')
  const bridge = exposed.api
  assert.deepEqual(Object.keys(bridge).sort(), ['onFocus', 'onState', 'send'])
  assert.deepEqual(Object.keys(handlers).sort(), ['rail:state', 'rail:take-focus'])
  assert.ok(Object.values(handlers).every((h) => h.length === 1))
  bridge.send('lyrics'); bridge.send({ toString: () => 'pin' })
  assert.deepEqual(sent, [['rail:command', 'lyrics'], ['rail:command', 'pin']])
  handlers['rail:state'][0]({}, { n: 1 })
  const got = []
  bridge.onState((s) => got.push(s.n))
  handlers['rail:state'][0]({}, { n: 2 })
  assert.deepEqual(got, [1, 2])
  let focused = 0
  bridge.onFocus(() => focused++)
  handlers['rail:take-focus'][0]({})
  assert.equal(focused, 1)
})

test('Apple preload: only a "focus the rail" bridge, in its isolated world (no contextBridge, no Node)', () => {
  const sent = []
  const fake = { ipcRenderer: { send: (...a) => sent.push(a), on: () => { throw new Error('no listeners expected') } } }
  const before = globalThis.sonataFocusBridge
  try {
    withFakeElectron(fake, () => { delete require.cache[require.resolve('../preload-apple')]; require('../preload-apple') })
    const b = globalThis.sonataFocusBridge
    assert.ok(Object.isFrozen(b))
    assert.deepEqual(Object.keys(b), ['toRail'])
    b.toRail('last'); b.toRail('anything')
    assert.deepEqual(sent, [['rail:focus-in', 'last'], ['rail:focus-in', 'first']])
  } finally { if (before === undefined) delete globalThis.sonataFocusBridge }
  const src = code(read('preload-apple.js'))
  assert.doesNotMatch(src, /contextBridge|exposeInMainWorld|webFrame|executeJavaScript/)
  assert.doesNotMatch(src, /require\('(fs|child_process|path|os)'\)/)
})

test('main: one window, two views, both sandboxed + isolated, no Node anywhere; the rail on top', () => {
  const src = read('main.js')
  const win = src.slice(src.indexOf('function createWindow()'), src.indexOf("appleWC().loadURL("))
  assert.match(win, /mainWindow = new BaseWindow\(opts\)/)
  assert.match(win, /appleView = new WebContentsView\(\{\s*webPreferences: \{ preload: path\.join\(__dirname, 'preload-apple\.js'\), contextIsolation: true, sandbox: true, nodeIntegration: false \}/)
  assert.match(win, /railView = new WebContentsView\(\{\s*webPreferences: \{ preload: path\.join\(__dirname, 'preload-rail-view\.js'\), contextIsolation: true, sandbox: true, nodeIntegration: false \}/)
  assert.ok(win.indexOf('addChildView(appleView)') < win.indexOf('addChildView(railView)'), 'rail added last (on top)')
  assert.match(src, /railView\.webContents\.loadFile\('rail\.html'\)/)
  assert.match(src, /lockDownLocalWindow\(railView\)/)
  // the views' web contents are closed with the window
  assert.match(src, /mainWindow\.on\('closed', \(\) => \{\s*for \(const v of \[appleView, railView\]\) if \(v && !v\.webContents\.isDestroyed\(\)\) v\.webContents\.close\(\)/)
  // Apple's page no longer gets the rail injected, nor any room CSS
  assert.doesNotMatch(src, /railScripts|roomCss|SONATA_RAIL_CSS/)
  assert.doesNotMatch(src, /mainWindow\.webContents/)
})

test('main: the views are sized by rail-model viewBounds on resize, fullscreen and rail changes', () => {
  const src = read('main.js')
  assert.match(src, /railModel\.viewBounds\(w, h, !!settings\.railPinned, railWide && !settings\.railLocked\)/)
  for (const ev of ['resize', 'enter-full-screen', 'leave-full-screen']) assert.ok(src.includes(`mainWindow.on('${ev}', pushRail)`), ev)
  assert.match(src, /appleView\.setBounds\(b\.apple\)/)
  assert.match(src, /railView\.setBounds\(b\.rail\)/)
})

test('main: rail commands are checked (rail view, top frame, known names) and run existing toggles', () => {
  const src = read('main.js')
  const at = src.indexOf("ipcMain.on('rail:command'")
  const h = src.slice(at, src.indexOf('})', at))
  assert.match(h, /event\.sender !== railView\.webContents/)
  assert.match(h, /event\.senderFrame\.parent/)
  assert.match(h, /railModel\.COMMANDS\.includes\(command\)/)
  for (const fn of ['toggleLyricsWindow()', 'toggleVisualizer()', 'toggleMiniPlayer()', 'createSettingsWindow()', 'toggleRailPin()', "toggleRailFlag('lock')", "focusApple('next')", "focusApple('prev')"]) assert.ok(h.includes(fn), fn)
  assert.match(h, /command === 'expand'\) \{ if \(!settings\.railLocked && !settings\.railPinned\)/)
  assert.equal((src.match(/ipcMain\.on\('rail:command'/g) || []).length, 1)
  const f = src.slice(src.indexOf("ipcMain.on('rail:focus-in'"), src.indexOf("ipcMain.on('rail:focus-in'") + 300)
  assert.match(f, /event\.sender !== appleWC\(\)/)
  // the focus stops go into Apple's isolated world (999), never the main world
  assert.match(src, /appleWC\(\)\.executeJavaScriptInIsolatedWorld\(999, \[\{ code: focusCode \}\]\)/)
  assert.match(src, /appleWC\(\)\.on\('dom-ready', injectFocusStops\)/)
})

test('main: nothing removed: tray items, menus and shortcuts are all still there, in both views', () => {
  const src = read('main.js')
  for (const label of ["'Show / Hide'", "'Mini Player'", "'Lyrics', accelerator: LYRICS_KEY", "'Visualizer', accelerator: VISUALIZER_KEY", "'Toggle Dark Mode'", "'Check for Updates…'", "'Settings…'", "'Quit'"]) assert.ok(src.includes(label), label)
  for (const key of ["=== 'r'", "=== 'd'", "=== 'm'", "=== 'b'"]) assert.ok(src.includes("input.key.toLowerCase() " + key), key)
  assert.ok(src.includes("const LYRICS_KEY = 'Ctrl+Shift+L'"))
  assert.ok(src.includes("const VISUALIZER_KEY = 'Ctrl+Shift+V'"))
  assert.match(src, /appleWC\(\)\.on\('before-input-event', \(event, input\) => windowShortcut\(input\)\)/)
  assert.match(src, /railView\.webContents\.on\('before-input-event', \(event, input\) => windowShortcut\(input\)\)/)
  assert.match(src, /input\.key === 'F6'/)
})

test('main: the pin and the lock are remembered settings, off by default, toggled through toggleFlags', () => {
  const src = read('main.js')
  assert.match(src, /railPinned: false, railLocked: false \}/)
  assert.match(src, /railModel\.toggleFlags\(/)
  assert.match(src, /locked: !!settings\.railLocked/)
})

test('rail-ui: no timers, no animation frames, no observers; untrusted clicks ignored; no HTML strings', () => {
  const src = code(read('rail-ui.js'))
  assert.doesNotMatch(src, /setTimeout|setInterval|requestAnimationFrame|requestIdleCallback|MutationObserver/)
  assert.doesNotMatch(src, /innerHTML|insertAdjacentHTML|eval\(|new Function/)
  assert.match(src, /if \(!e\.isTrusted\) return/)
})

test('apple-focus: one MutationObserver (body childList only), no timers, untrusted focus ignored', () => {
  const src = code(read('apple-focus.js'))
  assert.equal((src.match(/new MutationObserver/g) || []).length, 1)
  assert.match(src, /observer\.observe\(doc\.body, \{ childList: true \}\)/)
  assert.doesNotMatch(src, /subtree|attributes:\s*true|characterData/)
  assert.doesNotMatch(src, /setTimeout|setInterval|requestAnimationFrame|requestIdleCallback|innerHTML/)
  assert.match(src, /if \(ev\.isTrusted\) bridge\.toRail\(where\)/)
})

test('every listener and observer in rail-ui.js and apple-focus.js carries a lifetime/loop verdict', () => {
  for (const f of ['rail-ui.js', 'apple-focus.js', 'preload-rail-view.js']) {
    const lines = read(f).split('\n')
    lines.forEach((l, i) => {
      if (/addEventListener\(|new MutationObserver|ipcRenderer\.on\(/.test(l) && !/^\s*\/\//.test(l)) {
        const above = lines.slice(Math.max(0, i - 7), i).join('\n')
        assert.match(above, /\/\/ (lifetime|loop):/, f + ': no verdict above line ' + (i + 1) + ': ' + l.trim())
      }
    })
  }
})

test('rail.html: local scripts only (CSP), the model then the UI', () => {
  const html = read('rail.html')
  assert.match(html, /Content-Security-Policy" content="default-src 'none'; script-src 'self'; style-src 'self'/)
  assert.ok(html.indexOf('rail-model.js') < html.indexOf('rail-ui.js'))
  assert.doesNotMatch(html, /https?:/)
})

test('rail CSS: animates transform/opacity only (no width/left/right transitions); reduced motion respected', () => {
  const css = read('rail.css')
  for (const m of css.matchAll(/transition:\s*([^;]+);/g)) {
    for (const part of m[1].split(',')) {
      const prop = part.trim().split(/\s+/)[0]
      assert.ok(['transform', 'opacity', 'none'].includes(prop), 'transition on ' + prop)
    }
  }
  assert.match(css, /prefers-reduced-motion: reduce/)
})

test('packaging: every rail file ships in the AppImage', () => {
  const files = require('../package.json').build.files
  for (const f of ['preload-apple.js', 'preload-rail-view.js', 'apple-focus.js', 'rail.html', 'rail-model.js', 'rail-ui.js', 'rail.css']) assert.ok(files.includes(f), f)
  assert.ok(!files.includes('preload-rail.js'))
})

test('css replacer: a function source is read at every apply', async () => {
  let n = 0
  const live = new Map()
  const wc = {
    insertCSS: async (css) => { const k = 'k' + (++n); live.set(k, css); return k },
    removeInsertedCSS: async (k) => { if (!live.delete(k)) throw new Error('stale') }
  }
  let v = 1
  const apply = createCssReplacer(wc, () => 'v:' + v)
  await apply()
  v = 2
  await apply()
  assert.deepEqual([...live.values()], ['v:2'])
})
