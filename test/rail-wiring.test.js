// Navigation rail wiring: the preload bridge, main.js security posture and command checks,
// rail-ui.js rules (no timers, one observer, closed root, verdicts), packaging.
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')
const Module = require('module')
const { createCssReplacer } = require('../css-replacer')

const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8')
const code = (src) => src.replace(/\/\/.*$/gm, '')   // comments out, for "does the code do X" checks

function loadPreload() {
  const sent = []
  const handlers = {}
  const fakeElectron = {
    ipcRenderer: { send: (...a) => sent.push(a), on: (ch, fn) => { handlers[ch] = (handlers[ch] || []).concat(fn) } }
  }
  const orig = Module._load
  Module._load = function (req, ...rest) { return req === 'electron' ? fakeElectron : orig.call(this, req, ...rest) }
  const before = globalThis.sonataRailBridge
  try {
    delete require.cache[require.resolve('../preload-rail')]
    require('../preload-rail')
    return { bridge: globalThis.sonataRailBridge, sent, handlers }
  } finally {
    Module._load = orig
    if (before === undefined) delete globalThis.sonataRailBridge
  }
}

test('preload: one rail:state listener, a frozen bridge with send + onState only', () => {
  const { bridge, sent, handlers } = loadPreload()
  assert.deepEqual(Object.keys(handlers), ['rail:state'])
  assert.equal(handlers['rail:state'].length, 1)
  assert.ok(Object.isFrozen(bridge))
  assert.deepEqual(Object.keys(bridge).sort(), ['onState', 'send'])
  bridge.send('lyrics'); bridge.send({ toString: () => 'pin' })
  assert.deepEqual(sent, [['rail:command', 'lyrics'], ['rail:command', 'pin']])
  // state before the rail subscribes is kept and handed over; later states go straight through
  handlers['rail:state'][0]({}, { n: 1 })
  const got = []
  bridge.onState((s) => got.push(s.n))
  handlers['rail:state'][0]({}, { n: 2 })
  assert.deepEqual(got, [1, 2])
  bridge.onState('not a function')
  handlers['rail:state'][0]({}, { n: 3 })
  assert.deepEqual(got, [1, 2])
})

test('preload: nothing is exposed to Apple\'s main world (no contextBridge, no Node)', () => {
  const src = code(read('preload-rail.js'))
  assert.doesNotMatch(src, /contextBridge|exposeInMainWorld|webFrame|executeJavaScript/)
  assert.match(src, /require\('electron'\)/)
  assert.doesNotMatch(src, /require\('(fs|child_process|path|os)'\)/)
})

test('main: the main window keeps no Node in Apple\'s page (preload sandboxed + isolated)', () => {
  const src = read('main.js')
  const win = src.slice(src.indexOf('function createWindow()'), src.indexOf('mainWindow = new BrowserWindow(opts)'))
  assert.match(win, /preload: path\.join\(__dirname, 'preload-rail\.js'\)/)
  assert.match(win, /contextIsolation: true/)
  assert.match(win, /sandbox: true/)
  assert.match(win, /nodeIntegration: false/)
})

test('main: rail commands are checked (sender, top frame, known names) and run existing toggles', () => {
  const src = read('main.js')
  const h = src.slice(src.indexOf("ipcMain.on('rail:command'"), src.indexOf("ipcMain.on('rail:command'") + 1100)
  assert.match(h, /event\.sender !== mainWindow\.webContents/)
  assert.match(h, /event\.senderFrame\.parent/)
  assert.match(h, /railModel\.COMMANDS\.includes\(command\)/)
  for (const fn of ['toggleLyricsWindow()', 'toggleVisualizer()', 'toggleMiniPlayer()', 'createSettingsWindow()', 'toggleRailPin()', "toggleRailFlag('lock')"]) assert.ok(h.includes(fn), fn)
  assert.equal((src.match(/ipcMain\.on\('rail:command'/g) || []).length, 1)
  // injected into the isolated world (999), never the main world
  assert.match(src, /executeJavaScriptInIsolatedWorld\(999, railScripts\(\)\)/)
  assert.match(src, /webContents\.on\('dom-ready', injectRail\)/)
})

test('main: nothing removed: tray items, menus and shortcuts are all still there', () => {
  const src = read('main.js')
  for (const label of ["'Show / Hide'", "'Mini Player'", "'Lyrics', accelerator: LYRICS_KEY", "'Visualizer', accelerator: VISUALIZER_KEY", "'Toggle Dark Mode'", "'Check for Updates…'", "'Settings…'", "'Quit'"]) assert.ok(src.includes(label), label)
  for (const key of ["=== 'r'", "=== 'd'", "=== 'm'", "=== 'b'"]) assert.ok(src.includes("input.key.toLowerCase() " + key), key)
  assert.ok(src.includes("const LYRICS_KEY = 'Ctrl+Shift+L'"))
  assert.ok(src.includes("const VISUALIZER_KEY = 'Ctrl+Shift+V'"))
})

test('main: the pin and the lock are remembered settings, off by default, toggled through toggleFlags', () => {
  const src = read('main.js')
  assert.match(src, /railPinned: false, railLocked: false \}/)
  assert.match(src, /railModel\.toggleFlags\(/)
  assert.match(src, /locked: !!settings\.railLocked/)
})

test('rail-ui: no timers or animation frames, one MutationObserver (childList only), a closed root', () => {
  const src = code(read('rail-ui.js'))
  assert.doesNotMatch(src, /setTimeout|setInterval|requestAnimationFrame|requestIdleCallback/)
  assert.equal((src.match(/new MutationObserver/g) || []).length, 1)
  assert.doesNotMatch(src, /subtree|attributes:\s*true|characterData/)
  assert.match(src, /attachShadow\(\{ mode: 'closed' \}\)/)
  assert.doesNotMatch(src, /innerHTML|insertAdjacentHTML|eval\(|new Function/)
  // clicks from page scripts are ignored
  assert.match(src, /if \(!e\.isTrusted\) return/)
})

test('rail-ui: every listener and the observer carry a lifetime/loop verdict', () => {
  const lines = read('rail-ui.js').split('\n')
  lines.forEach((l, i) => {
    if (/addEventListener\(|new MutationObserver/.test(l) && !/^\s*\/\//.test(l)) {
      const above = lines.slice(Math.max(0, i - 6), i).join('\n')
      assert.match(above, /\/\/ (lifetime|loop):/, 'no verdict above line ' + (i + 1) + ': ' + l.trim())
    }
  })
})

test('rail-ui: the CSS animates transform/opacity only (no width/left/right transitions)', () => {
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
  for (const f of ['preload-rail.js', 'rail-model.js', 'rail-ui.js', 'rail.css']) assert.ok(files.includes(f), f)
})

test('css replacer: a function source is read at every apply (the rail room changes)', async () => {
  let n = 0
  const live = new Map()
  const wc = {
    insertCSS: async (css) => { const k = 'k' + (++n); live.set(k, css); return k },
    removeInsertedCSS: async (k) => { if (!live.delete(k)) throw new Error('stale') }
  }
  let room = 52
  const apply = createCssReplacer(wc, () => 'room:' + room)
  await apply()
  room = 196
  await apply()
  assert.deepEqual([...live.values()], ['room:196'])
})
