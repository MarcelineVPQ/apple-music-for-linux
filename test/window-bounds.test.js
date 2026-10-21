// Every window's place and size across launches (window-bounds.js): which sessions can place windows,
// restoring on the same display, the off-screen guard, the maximized state, the record kept, the
// debounced tracking, and main.js using the one module for every window.
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')
const W = require('../window-bounds')

// two monitors side by side: a 1920×1080 primary (panel at the bottom) and a 2560×1440 on its right
const left = { id: 1, bounds: { x: 0, y: 0, width: 1920, height: 1080 }, workArea: { x: 0, y: 0, width: 1920, height: 1040 } }
const right = { id: 2, bounds: { x: 1920, y: 0, width: 2560, height: 1440 }, workArea: { x: 1920, y: 0, width: 2560, height: 1400 } }
const both = { displays: [left, right], primary: left, area: left.workArea, size: { width: 1000, height: 600 }, positions: true }

test('positionsWork: native Wayland can not place windows; X11, XWayland and other systems can', () => {
  assert.equal(W.positionsWork({ platform: 'linux', ozone: '', hint: '', wayland: true }), false, 'Electron 38+ picks Wayland by itself')
  assert.equal(W.positionsWork({ platform: 'linux', ozone: 'wayland', wayland: true }), false)
  assert.equal(W.positionsWork({ platform: 'linux', ozone: 'x11', wayland: true }), true, '--ozone-platform=x11: XWayland')
  assert.equal(W.positionsWork({ platform: 'linux', ozone: '', hint: 'x11', wayland: true }), true)
  assert.equal(W.positionsWork({ platform: 'linux', ozone: '', hint: 'wayland', wayland: false }), false)
  assert.equal(W.positionsWork({ platform: 'linux', wayland: false }), true, 'an X11 session')
  assert.equal(W.positionsWork({ platform: 'win32', wayland: false }), true)
  assert.equal(W.positionsWork({ platform: 'darwin' }), true)
})

test('restore: back on the display it was on, size and maximized kept', () => {
  assert.deepEqual(W.restore({ x: 2200, y: 100, width: 1200, height: 800 }, both), { x: 2200, y: 100, width: 1200, height: 800, maximized: false })
  assert.deepEqual(W.restore({ x: 100, y: 50, width: 1200, height: 800, maximized: true }, both), { x: 100, y: 50, width: 1200, height: 800, maximized: true })
})

test('restore: partly off its display it is moved (and shrunk) just enough to be wholly in the work area', () => {
  // hanging off the right monitor's right edge and under the left one's panel
  assert.deepEqual(W.restore({ x: 4000, y: 100, width: 1200, height: 800 }, both), { x: 4480 - 1200, y: 100, width: 1200, height: 800, maximized: false })
  assert.deepEqual(W.restore({ x: 100, y: 600, width: 1000, height: 600 }, both), { x: 100, y: 440, width: 1000, height: 600, maximized: false })
  // larger than the left monitor's work area: shrunk to it
  assert.deepEqual(W.restore({ x: 0, y: 0, width: 2400, height: 1300 }, Object.assign({}, both, { displays: [left] })), { x: 0, y: 0, width: 1920, height: 1040, maximized: false })
  // straddling both monitors: it goes to the one it covers most
  const r = W.restore({ x: 1700, y: 100, width: 1000, height: 600 }, both)
  assert.equal(r.x, 1920, 'more of it was on the right monitor')
})

test('restore: a place on no current display (monitor unplugged) comes back centred on the primary display', () => {
  const unplugged = Object.assign({}, both, { displays: [left] })
  assert.deepEqual(W.restore({ x: 2200, y: 100, width: 1200, height: 800 }, unplugged), { x: 360, y: 120, width: 1200, height: 800, maximized: false })
  // far away, and only a sliver (less than a grab-able piece) on the screen
  assert.deepEqual(W.restore({ x: -5000, y: -5000, width: 800, height: 500 }, both), { x: 560, y: 270, width: 800, height: 500, maximized: false })
  assert.deepEqual(W.restore({ x: 1880, y: 1060, width: 800, height: 500 }, unplugged), { x: 560, y: 270, width: 800, height: 500, maximized: false })
  // maximized on the unplugged monitor: maximized on the primary
  assert.equal(W.restore({ x: 2200, y: 100, width: 1200, height: 800, maximized: true }, unplugged).maximized, true)
})

test('restore: no saved place: centred in the caller\'s area, or left to the window manager (centre: false)', () => {
  assert.deepEqual(W.restore(null, both), { x: 460, y: 220, width: 1000, height: 600, maximized: false })
  assert.deepEqual(W.restore(null, Object.assign({}, both, { centre: false })), { width: 1000, height: 600, maximized: false })
  assert.deepEqual(W.restore({ width: 1200, height: 700 }, Object.assign({}, both, { centre: false })), { width: 1200, height: 700, maximized: false })
})

test('restore: on native Wayland a saved x / y (always 0, 0 there) is ignored; size and maximized still come back', () => {
  const wayland = Object.assign({}, both, { positions: false, centre: false })
  assert.deepEqual(W.restore({ x: 0, y: 0, width: 1600, height: 872 }, wayland), { width: 1600, height: 872, maximized: false })
  assert.deepEqual(W.restore({ width: 1600, height: 872, maximized: true }, wayland), { width: 1600, height: 872, maximized: true })
})

test('restore: the minimum size and a fixed size (the mini player)', () => {
  const min = { width: 800, height: 500 }
  assert.deepEqual(W.restore({ x: 10, y: 10, width: 300, height: 200 }, Object.assign({}, both, { min })), { x: 10, y: 10, width: 800, height: 500, maximized: false })
  // the minimum gives way on a screen smaller than it
  const tiny = { workArea: { x: 0, y: 0, width: 700, height: 400 } }
  assert.deepEqual(W.restore(null, { displays: [tiny], primary: tiny, area: tiny.workArea, size: { width: 1000, height: 600 }, min, positions: true }), { x: 0, y: 0, width: 700, height: 400, maximized: false })
  const mini = Object.assign({}, both, { size: { width: 680, height: 72 }, fixed: true })
  assert.deepEqual(W.restore({ x: 2000, y: 1300, width: 999, height: 999 }, mini), { x: 2000, y: 1300, width: 680, height: 72, maximized: false })
})

test('restore: damaged or empty records fall back to the default size', () => {
  for (const bad of [null, undefined, {}, { width: 'big', height: 600 }, { width: 0, height: 0 }]) {
    assert.deepEqual(W.restore(bad, Object.assign({}, both, { centre: false })), { width: 1000, height: 600, maximized: false })
  }
})

// a stand-in BrowserWindow
function fakeWin(state) {
  const handlers = {}
  return Object.assign({
    destroyed: false, minimized: false, visible: true, fullscreen: false, maximized: false,
    bounds: { x: 10, y: 20, width: 900, height: 700 }, normal: null,
    isDestroyed() { return this.destroyed }, isMinimized() { return this.minimized }, isVisible() { return this.visible },
    isFullScreen() { return this.fullscreen }, isMaximized() { return this.maximized },
    getBounds() { return Object.assign({}, this.bounds) }, getNormalBounds() { return Object.assign({}, this.normal || this.bounds) },
    on(ev, fn) { (handlers[ev] = handlers[ev] || []).push(fn) },
    emit(ev) { (handlers[ev] || []).forEach((fn) => fn()) }, // loop: NOT-WORTH — a test
    handlers
  }, state)
}
// timers you run by hand
function fakeTimers() {
  let next = 1
  const pending = new Map()
  return {
    setTimeout(fn) { const id = next++; pending.set(id, fn); return id },
    clearTimeout(id) { pending.delete(id) },
    run() { const fns = [...pending.values()]; pending.clear(); fns.forEach((fn) => fn()) }, // loop: NOT-WORTH — a test
    get size() { return pending.size }
  }
}

test('capture: position only where it works; while maximized the size from before is kept', () => {
  const win = fakeWin()
  assert.deepEqual(W.capture(win, null, true), { x: 10, y: 20, width: 900, height: 700 })
  assert.deepEqual(W.capture(win, null, false), { width: 900, height: 700 })
  win.maximized = true; win.bounds = { x: 0, y: 0, width: 1920, height: 1040 }
  assert.deepEqual(W.capture(win, { x: 10, y: 20, width: 900, height: 700 }, true), { x: 10, y: 20, width: 900, height: 700, maximized: true })
  // nothing kept yet: the normal bounds
  win.normal = { x: 30, y: 40, width: 1000, height: 600 }
  assert.deepEqual(W.capture(win, null, true), { x: 30, y: 40, width: 1000, height: 600, maximized: true })
  assert.deepEqual(W.capture(win, null, false), { width: 1000, height: 600, maximized: true })
})

test('track: debounced saves after move / resize / (un)maximize, none while minimized, hidden or fullscreen, flushed on close', () => {
  const win = fakeWin()
  const timers = fakeTimers()
  let kept = null
  let writes = 0
  W.track(win, { read: () => kept, write: (r) => { kept = r; writes++ }, positions: true, timers })
  for (const ev of ['resize', 'move', 'maximize', 'unmaximize', 'close']) assert.ok(win.handlers[ev], ev + ' is listened to') // loop: NOT-WORTH — a test
  win.emit('move'); win.emit('resize'); win.emit('move')
  assert.equal(timers.size, 1, 'one debounce')
  timers.run()
  assert.equal(writes, 1)
  assert.deepEqual(kept, { x: 10, y: 20, width: 900, height: 700 })
  // maximized: the size from before stays, maximized added
  win.maximized = true; win.bounds = { x: 0, y: 0, width: 1920, height: 1040 }
  win.emit('maximize'); timers.run()
  assert.deepEqual(kept, { x: 10, y: 20, width: 900, height: 700, maximized: true })
  win.maximized = false; win.bounds = { x: 10, y: 20, width: 900, height: 700 }
  win.emit('unmaximize'); timers.run()
  assert.deepEqual(kept, { x: 10, y: 20, width: 900, height: 700 })
  // minimized / hidden / fullscreen: nothing scheduled
  writes = 0
  win.minimized = true; win.emit('resize'); win.minimized = false
  win.visible = false; win.emit('move'); win.visible = true
  win.fullscreen = true; win.emit('resize'); win.fullscreen = false
  assert.equal(timers.size, 0); assert.equal(writes, 0)
  // closing with a save waiting: saved at once
  win.bounds = { x: 50, y: 60, width: 800, height: 500 }
  win.emit('move'); win.emit('close')
  assert.deepEqual(kept, { x: 50, y: 60, width: 800, height: 500 })
  assert.equal(timers.size, 0)
  // destroyed before the debounce ran: nothing written
  writes = 0
  win.emit('move'); win.destroyed = true; timers.run()
  assert.equal(writes, 0)
})

test('track: fullscreen: true keeps a fullscreen window (the visualizer\'s screen)', () => {
  const win = fakeWin({ fullscreen: true, bounds: { x: 1920, y: 0, width: 2560, height: 1440 } })
  const timers = fakeTimers()
  let kept = null
  W.track(win, { read: () => kept, write: (r) => { kept = r }, positions: true, fullscreen: true, timers })
  win.emit('resize'); timers.run()
  assert.deepEqual(kept, { x: 1920, y: 0, width: 2560, height: 1440 })
  // and back on that screen when it is still there
  assert.deepEqual(W.restore(kept, Object.assign({}, both, { size: { width: 2560, height: 1440 } })), { x: 1920, y: 0, width: 2560, height: 1400, maximized: false })
})

test('settings: every window record is a checked bounds setting (maximized a boolean)', () => {
  const S = require('../settings-store')
  const d = S.defaults()
  // loop: NOT-WORTH — a test
  for (const k of ['windowBounds', 'lyricsBounds', 'stageBounds', 'linerBounds', 'miniBounds', 'vizBounds']) assert.equal(d[k], null, k)
  const dir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'sonata-wb-'))
  const file = path.join(dir, 'settings.json')
  fs.writeFileSync(file, JSON.stringify(Object.assign(S.defaults(), { windowBounds: { x: 1, y: 2, width: 900, height: 600, maximized: true }, miniBounds: { width: 680, height: 72, maximized: 'yes' } })))
  const r = S.loadSettings(file)
  assert.deepEqual(r.settings.windowBounds, { x: 1, y: 2, width: 900, height: 600, maximized: true })
  assert.equal(r.settings.miniBounds, null, 'a maximized that is not a boolean is refused')
  fs.rmSync(dir, { recursive: true, force: true })
})

test('main.js: every window goes through the one module, no per-window copies', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8')
  assert.match(main, /require\('\.\/window-bounds'\)/)
  assert.ok(!/applySavedBounds|saveBoundsTimer|rememberBounds/.test(main), 'the old per-window code is gone')
  assert.ok(!/= \w+\.getBounds\(\); saveSettings\(\)/.test(main), 'no window saves its bounds by itself')
  for (const [key, win] of [['windowBounds', 'mainWindow'], ['miniBounds', 'miniWindow'], ['linerBounds', 'win'], ['vizBounds', 'vizWindow']]) { // loop: NOT-WORTH — a test
    assert.match(main, new RegExp(`savedBounds\\('${key}'`), key + ' is restored')
    assert.match(main, new RegExp(`persistBounds\\(${win}, '${key}'`), key + ' is kept')
  }
  assert.match(main, /savedBounds\(form === 'stage' \? 'stageBounds' : 'lyricsBounds'/)
  assert.match(main, /maximizeRestored\(mainWindow, place\)/)
  assert.match(main, /maximizeRestored\(lyricsWindow, place\)/)
  assert.match(main, /maximizeRestored\(win, place\)/)
})
