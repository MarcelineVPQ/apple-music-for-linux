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

test('view bounds: Apple gets the window minus the room; the rail sits at the right edge, on top', () => {
  assert.deepEqual(M.viewBounds(1100, 760, false, false), { mode: 'collapsed', room: 52, apple: { x: 0, y: 0, width: 1048, height: 760 }, rail: { x: 1048, y: 0, width: 52, height: 760 } })
  // open over the page (unpinned): the rail view widens over Apple's, Apple keeps its size
  assert.deepEqual(M.viewBounds(1100, 760, false, true), { mode: 'collapsed', room: 52, apple: { x: 0, y: 0, width: 1048, height: 760 }, rail: { x: 904, y: 0, width: 196, height: 760 } })
  // pinned: side by side, nothing overlaps
  assert.deepEqual(M.viewBounds(1100, 760, true, false), { mode: 'pinned', room: 196, apple: { x: 0, y: 0, width: 904, height: 760 }, rail: { x: 904, y: 0, width: 196, height: 760 } })
  assert.deepEqual(M.viewBounds(1100, 760, true, true).apple.width, 904)
  // too narrow to pin: floats like unpinned
  assert.deepEqual(M.viewBounds(900, 600, true, false).rail, { x: 848, y: 0, width: 52, height: 600 })
  assert.deepEqual(M.viewBounds(900, 600, true, true).rail, { x: 704, y: 0, width: 196, height: 600 })
  // never negative, rounded; Apple's view and the rail's room always add up to the window
  assert.deepEqual(M.viewBounds(30.4, -5, false, false), { mode: 'collapsed', room: 52, apple: { x: 0, y: 0, width: 0, height: 0 }, rail: { x: 0, y: 0, width: 30, height: 0 } })
  for (const w of [800, 995, 996, 1100, 1600, 3840]) for (const p of [false, true]) for (const wide of [false, true]) {
    const b = M.viewBounds(w, 700, p, wide)
    assert.equal(b.apple.width + b.room, w)
    assert.equal(b.rail.x + b.rail.width, w)
    if (!wide || b.mode === 'pinned') assert.equal(b.rail.x, b.apple.width, 'no overlap unless open over the page')
  }
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

test('items: order, shortcuts in tooltips, active state from open windows and the panel', () => {
  const s = { open: { lyrics: true }, panel: { shown: true, page: 'settings' }, keys: { lyrics: 'Ctrl+Shift+L', visualizer: 'Ctrl+Shift+V', mini: 'Ctrl+M', settings: '', about: '' } }
  const items = M.railItems(s)
  assert.deepEqual(items.map((i) => i.id), ['lyrics', 'visualizer', 'mini', 'settings', 'about'])
  assert.deepEqual(items.map((i) => i.active), [true, false, false, true, false])
  assert.match(items[0].tip, /^Lyrics \(Ctrl\+Shift\+L\)\nOpen · click to close$/)
  assert.match(items[1].tip, /^Visualizer \(Ctrl\+Shift\+V\)\nClick to open$/)
  assert.equal(items[2].ariaKeys, 'Control+M')
  assert.equal(items[3].kind, 'panel')
  assert.match(items[3].tip, /^Settings\nShown beside the page · click to hide it$/)   // no invented shortcut
  assert.match(items[4].tip, /^About\nClick to show it beside the page$/)
  assert.equal(items[3].ariaKeys, '')
  assert.ok(M.railItems(null).every((i) => !i.active))
  // the panel hidden: nothing active; a task on a page shows as its dot, said in words
  const hidden = M.railItems({ panel: { shown: false, page: 'settings' }, reminders: { settings: 'Sonata 0.16.0 is available.' } })
  assert.equal(hidden[3].active, false)
  assert.equal(hidden[3].task, 'Sonata 0.16.0 is available.')
  assert.match(hidden[3].tip, /Waiting: Sonata 0\.16\.0 is available\./)
  // shown with that page: the dot goes (the page itself shows the task)
  assert.equal(M.railItems({ panel: { shown: true, page: 'settings' }, reminders: { settings: 'x' } })[3].task, '')
  assert.ok(M.COMMANDS.includes('about') && M.COMMANDS.includes('settings'))
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

test('one file, two worlds: without CommonJS it becomes a frozen SonataRailModel global', () => {
  const ctx = vm.createContext({})
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'rail-model.js'), 'utf8'), ctx)
  const G = vm.runInContext('globalThis.SonataRailModel', ctx)
  assert.equal(typeof G.railLayout, 'function')
  assert.ok(Object.isFrozen(G))
  assert.equal(JSON.stringify(G.railLayout(1100, true)), '{"mode":"pinned","room":196}')
})

test('lock: keeps the rail icons only, whatever the pointer or keyboard does (pinned excepted)', () => {
  for (const t of ['enter', 'focus-visible', 'key']) {
    const v = M.viewReduce(M.initialView(), t)
    assert.equal(M.isOpen('collapsed', v, false), true)
    assert.equal(M.isOpen('collapsed', v, true), false)
    assert.equal(M.isOpen('floating', v, true), false)
  }
  assert.equal(M.isOpen('pinned', M.initialView(), true), true)   // never both: toggleFlags
})

test('lock and pin exclude each other (DS5 rules): pinning unlocks, locking unpins', () => {
  assert.deepEqual(M.toggleFlags({ pinned: false, locked: false }, 'lock'), { pinned: false, locked: true })
  assert.deepEqual(M.toggleFlags({ pinned: true, locked: false }, 'lock'), { pinned: false, locked: true })
  assert.deepEqual(M.toggleFlags({ pinned: false, locked: true }, 'pin'), { pinned: true, locked: false })
  assert.deepEqual(M.toggleFlags({ pinned: false, locked: true }, 'lock'), { pinned: false, locked: false })
  assert.deepEqual(M.toggleFlags({ pinned: true, locked: false }, 'pin'), { pinned: false, locked: false })
  assert.deepEqual(M.toggleFlags(null, 'pin'), { pinned: true, locked: false })
  assert.deepEqual(M.toggleFlags({ pinned: true }, 'nope'), { pinned: true, locked: false })
  // whatever the order of presses, never both on
  let f = { pinned: false, locked: false }
  for (const w of ['pin', 'lock', 'lock', 'pin', 'lock', 'pin', 'pin', 'lock']) { f = M.toggleFlags(f, w); assert.ok(!(f.pinned && f.locked)) }
})

test('lock item: one name, pressed state, tooltip says what it does; the pin tooltip warns it unlocks', () => {
  const off = M.lockItem({ locked: false })
  const on = M.lockItem({ locked: true })
  assert.equal(off.label, on.label)
  assert.equal(off.active, false); assert.equal(on.active, true)
  assert.match(off.tip, /icons only/)
  assert.match(on.tip, /click to unlock/)
  assert.ok(M.COMMANDS.includes('lock'))
  assert.match(M.pinItem({ pinned: false, locked: true }).tip, /pinning unlocks it/)
  assert.doesNotMatch(M.pinItem({ pinned: false, locked: false }).tip, /unlocks/)
})
