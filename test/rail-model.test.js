// Navigation rail: layout math, open/closed state, keyboard map, items, status lines, glass colours.
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')
const vm = require('vm')
const M = require('../rail-model')

test('layout: unpinned keeps the icon column at every width', () => {
  for (const w of [800, 1000, 1100, 1600, 3840]) assert.deepEqual(M.railLayout(w, false), { mode: 'collapsed', room: 52 })
})

test('layout: pinned takes its full width while Apple keeps >= 800 px, else floats', () => {
  assert.deepEqual(M.railLayout(1100, true), { mode: 'pinned', room: 196 })
  assert.deepEqual(M.railLayout(996, true), { mode: 'pinned', room: 196 })      // 996 - 196 = 800
  assert.deepEqual(M.railLayout(995, true), { mode: 'floating', room: 52 })
  assert.deepEqual(M.railLayout(800, true), { mode: 'floating', room: 52 })
  assert.deepEqual(M.railLayout(3840, true), { mode: 'pinned', room: 196 })
  assert.deepEqual(M.railLayout(undefined, true), { mode: 'floating', room: 52 })
})

test('room CSS: narrows the root and the vw-sized player bar by the room, nothing at 0', () => {
  assert.equal(M.roomCss(0), '')
  assert.equal(M.roomCss(-5), '')
  assert.equal(M.roomCss('x'), '')
  const css = M.roomCss(196)
  assert.match(css, /html\{width:calc\(100% - 196px\) !important\}/)
  assert.match(css, /\.player-bar\{width:calc\(100vw - var\(--web-navigation-width, 0px\) - 196px\) !important\}/)
  assert.match(M.roomCss(51.6), /100% - 52px/)
})

test('open state: hover opens, a pointer pick closes until the pointer leaves and returns', () => {
  let v = M.initialView()
  assert.equal(M.isOpen('collapsed', v), false)
  v = M.viewReduce(v, 'enter'); assert.equal(M.isOpen('collapsed', v), true)
  v = M.viewReduce(v, 'pick'); assert.equal(M.isOpen('collapsed', v), false)
  v = M.viewReduce(v, 'focus-pointer'); assert.equal(M.isOpen('collapsed', v), false)  // the click's focus doesn't reopen it
  v = M.viewReduce(v, 'leave'); assert.equal(M.isOpen('collapsed', v), false)
  assert.equal(v.picked, false)
  v = M.viewReduce(v, 'enter'); assert.equal(M.isOpen('collapsed', v), true)
})

test('open state: keyboard focus opens, Esc closes with focus kept, an arrow reopens, blur resets', () => {
  let v = M.viewReduce(M.initialView(), 'focus-visible')
  assert.equal(M.isOpen('collapsed', v), true)
  v = M.viewReduce(v, 'escape'); assert.equal(M.isOpen('collapsed', v), false)
  assert.equal(v.focusVisible, true)
  v = M.viewReduce(v, 'key'); assert.equal(M.isOpen('collapsed', v), true)
  v = M.viewReduce(v, 'escape'); v = M.viewReduce(v, 'blur')
  assert.deepEqual(v, { hover: false, focusVisible: false, picked: false, dismissed: false })
  // Esc while hovered: closed until the pointer comes back
  v = M.viewReduce(M.viewReduce(M.initialView(), 'enter'), 'escape')
  assert.equal(M.isOpen('collapsed', v), false)
  v = M.viewReduce(M.viewReduce(v, 'leave'), 'enter'); assert.equal(M.isOpen('collapsed', v), true)
})

test('open state: pinned is always open; floating behaves like unpinned', () => {
  for (const t of ['pick', 'escape', 'leave', 'blur']) assert.equal(M.isOpen('pinned', M.viewReduce(M.initialView(), t)), true)
  assert.equal(M.isOpen('floating', M.initialView()), false)
  assert.equal(M.isOpen('floating', M.viewReduce(M.initialView(), 'enter')), true)
  const v = M.initialView()
  assert.equal(M.viewReduce(v, 'unknown'), v)
})

test('keyboard: arrows wrap, Home/End jump, Esc closes, modified keys and others pass through', () => {
  assert.deepEqual(M.railKey('ArrowDown', 0, 5), { action: 'move', index: 1 })
  assert.deepEqual(M.railKey('ArrowDown', 4, 5), { action: 'move', index: 0 })
  assert.deepEqual(M.railKey('ArrowUp', 0, 5), { action: 'move', index: 4 })
  assert.deepEqual(M.railKey('ArrowRight', 1, 5), { action: 'move', index: 2 })
  assert.deepEqual(M.railKey('ArrowLeft', 1, 5), { action: 'move', index: 0 })
  assert.deepEqual(M.railKey('Home', 3, 5), { action: 'move', index: 0 })
  assert.deepEqual(M.railKey('End', 0, 5), { action: 'move', index: 4 })
  assert.deepEqual(M.railKey('Escape', 2, 5), { action: 'escape' })
  assert.deepEqual(M.railKey('ArrowDown', 99, 5), { action: 'move', index: 0 })   // clamped
  for (const k of ['Enter', ' ', 'Tab', 'b', 'l']) assert.equal(M.railKey(k, 0, 5), null)
  assert.equal(M.railKey('ArrowDown', 0, 5, { ctrl: true }), null)
  assert.equal(M.railKey('ArrowDown', 0, 5, { alt: true }), null)
  assert.equal(M.railKey('ArrowDown', 0, 0), null)
})

test('items: order, shortcuts in tooltips, active state from open windows', () => {
  const s = { open: { lyrics: true, settings: true }, keys: { lyrics: 'Ctrl+Shift+L', visualizer: 'Ctrl+Shift+V', mini: 'Ctrl+M', settings: '' } }
  const items = M.railItems(s)
  assert.deepEqual(items.map((i) => i.id), ['lyrics', 'visualizer', 'mini', 'settings'])
  assert.deepEqual(items.map((i) => i.active), [true, false, false, true])
  assert.match(items[0].tip, /^Lyrics \(Ctrl\+Shift\+L\)\nOpen · click to close$/)
  assert.match(items[1].tip, /^Visualizer \(Ctrl\+Shift\+V\)\nClick to open$/)
  assert.equal(items[2].ariaKeys, 'Control+M')
  assert.equal(items[3].kind, 'window')
  assert.match(items[3].tip, /^Settings\nOpen · click to bring it forward$/)   // no invented shortcut
  assert.equal(items[3].ariaKeys, '')
  assert.ok(M.railItems(null).every((i) => !i.active))
})

test('pin: one name, pressed state, Ctrl+B in the tooltip, the floating case explained', () => {
  const off = M.pinItem({ pinned: false, mode: 'collapsed' })
  const on = M.pinItem({ pinned: true, mode: 'pinned' })
  assert.equal(off.label, on.label)
  assert.equal(off.active, false); assert.equal(on.active, true)
  assert.match(off.tip, /Ctrl\+B/); assert.match(on.tip, /unpin \(Ctrl\+B\)/)
  assert.match(M.pinItem({ pinned: true, mode: 'floating' }).tip, /too narrow/)
  assert.equal(on.ariaKeys, 'Control+B')
})

test('status: every line has a symbol AND words (never colour alone); the tooltip names the service', () => {
  const cases = [
    [{ lastfm: { connected: true, user: 'marcy' }, discord: 'on', precise: 'ready' }, ['ok', 'ok', 'ok']],
    [{ lastfm: { connected: false }, discord: 'waiting', precise: 'missing' }, ['off', 'wait', 'warn']],
    [{ discord: 'off', precise: 'off' }, ['off', 'off', 'off']],
    [{ precise: 'busy' }, ['off', 'off', 'ok']],
    [null, ['off', 'off', 'off']]
  ]
  for (const [s, levels] of cases) {
    const lines = M.railStatus(s)
    assert.deepEqual(lines.map((l) => l.id), ['lastfm', 'discord', 'precise'])
    assert.deepEqual(lines.map((l) => l.level), levels)
    for (const l of lines) {
      assert.ok(l.symbol && l.symbol.length === 1, 'symbol')
      assert.ok(l.text.length > 1, 'words')
      assert.ok(l.tip.startsWith(l.label + ': '), 'tooltip names the service')
    }
    // the symbols differ between levels, so the dot never relies on its colour
    assert.equal(new Set(lines.map((l) => l.level + l.symbol)).size, new Set(lines.map((l) => l.level)).size)
  }
  assert.match(M.railStatus({ lastfm: { connected: true, user: 'marcy' } })[0].tip, /as marcy/)
  assert.equal(M.railStatus({ precise: 'ready' })[2].label, 'Precise word timing')
})

test('development badge only on the dev channel', () => {
  assert.equal(M.devBadge({ channel: 'stable', version: '0.15.26' }), null)
  assert.equal(M.devBadge(null), null)
  const b = M.devBadge({ channel: 'dev', version: '0.15.27-dev.1' })
  assert.equal(b.text, 'Development')
  assert.equal(b.version, '0.15.27-dev.1')
  assert.match(b.tip, /Development channel · v0\.15\.27-dev\.1/)
})

test('contrast maths: known pairs', () => {
  assert.equal(Math.round(M.contrast([0, 0, 0], [255, 255, 255])), 21)
  assert.equal(M.contrast([10, 20, 30], [10, 20, 30]), 1)
  assert.deepEqual(M.hexRgb('#ff8000'), [255, 128, 0])
  assert.equal(M.hexRgb('nope'), null)
})

test('glass: labels >= 4.5:1 (and the ring >= 3:1) over ANY backdrop, every album hue, both themes', () => {
  const { hslToRgb } = require('../palette')
  const hex = (rgb) => '#' + rgb.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')
  const palettes = [null, { accent: 'garbage' }]
  for (let h = 0; h < 360; h += 10) for (const l of [0.52, 0.6, 0.68]) for (const s of [0.58, 0.95]) palettes.push({ accent: hex(hslToRgb(h, s, l)) })
  let worst = 99
  for (const dark of [false, true]) {
    for (const p of palettes) {
      const t = M.glassTheme(p, dark)
      assert.ok(t.contrast.label >= 4.5, 'label ' + JSON.stringify(p) + dark)
      assert.ok(t.contrast.soft >= 4.5, 'soft ' + JSON.stringify(p) + dark)
      assert.ok(t.contrast.active >= 4.5, 'active ' + JSON.stringify(p) + dark)
      assert.ok(t.contrast.hover >= 4.5, 'hover ' + JSON.stringify(p) + dark)
      assert.ok(t.contrast.ring >= 3, 'ring ' + JSON.stringify(p) + dark)
      assert.ok(t.alpha < 0.98, 'still glass')
      worst = Math.min(worst, t.contrast.label, t.contrast.soft, t.contrast.active)
      for (const k of ['--rail-glass', '--rail-text', '--rail-soft', '--rail-active', '--rail-hover', '--rail-ring', '--rail-solid']) assert.match(t.vars[k], /^rgba\(/)
    }
  }
  assert.ok(worst >= 4.5)
})

test('glass: dark is dark, light is light; the album accent tints it', () => {
  const lumOf = (v) => { const [r, g, b] = v.match(/[\d.]+/g).map(Number); return r + g + b }
  assert.ok(lumOf(M.glassTheme(null, true).vars['--rail-glass']) < 300)
  assert.ok(lumOf(M.glassTheme(null, false).vars['--rail-glass']) > 600)
  assert.notEqual(M.glassTheme({ accent: '#2050ff' }, true).vars['--rail-glass'], M.glassTheme({ accent: '#ff5020' }, true).vars['--rail-glass'])
})

test('one file, two worlds: without CommonJS it becomes a frozen SonataRailModel global', () => {
  const ctx = vm.createContext({})
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'rail-model.js'), 'utf8'), ctx)
  const G = vm.runInContext('globalThis.SonataRailModel', ctx)
  assert.equal(typeof G.railLayout, 'function')
  assert.ok(Object.isFrozen(G))
  assert.equal(JSON.stringify(G.railLayout(1100, true)), '{"mode":"pinned","room":196}')
})
