const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')
const T = require('../toasters')

const ROOT = path.join(__dirname, '..')

// PNG width/height from the IHDR chunk
function pngSize(file) {
  const b = fs.readFileSync(file)
  assert.equal(b.toString('latin1', 1, 4), 'PNG', file + ' is a PNG')
  return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) }
}

test('assets: all 9 sprite files exist, have the declared sizes and ship in the AppImage', () => {
  const files = [...T.TOASTER_FILES, T.TOAST_FILE]
  assert.equal(files.length, 9)
  const shipped = require('../package.json').build.files
  let total = 0
  for (const f of files) {
    const full = path.join(ROOT, f)
    assert.ok(fs.existsSync(full), f + ' exists')
    assert.ok(shipped.includes(f) || shipped.some((g) => f.startsWith(g.replace(/\*\*.*$/, ''))), f + ' is in package.json build.files')
    total += fs.statSync(full).size
  }
  for (const f of T.TOASTER_FILES) assert.deepEqual(pngSize(path.join(ROOT, f)), T.TOASTER_SIZE)
  assert.deepEqual(pngSize(path.join(ROOT, T.TOAST_FILE)), T.TOAST_SIZE)
  assert.ok(total < 1024 * 1024, 'sprites stay under 1 MB (' + total + ' bytes)')
})

test('flapFrame: one turn loops the 8 frames in order, wraps per turn', () => {
  const seq = []
  for (let k = 0; k < 8; k++) seq.push(T.flapFrame((k + 0.5) / 8))
  assert.deepEqual(seq, [0, 1, 2, 3, 4, 5, 6, 7])
  assert.equal(T.flapFrame(3.3), T.flapFrame(0.3))
  assert.equal(T.flapFrame(-0.25), T.flapFrame(0.75))
  assert.equal(T.flapFrame(0.999999), 7)
})

test('spriteSize: about a sixth of the screen tall, aspect kept, grows with the screen', () => {
  const hd = T.spriteSize(1080), uhd = T.spriteSize(2160)
  assert.equal(hd.h, 180)
  assert.ok(Math.abs(hd.w / hd.h - T.TOASTER_SIZE.w / T.TOASTER_SIZE.h) < 0.01)
  assert.ok(uhd.h === hd.h * 2)
})

test('DIR: flies down and to the left (top right -> bottom left), unit length', () => {
  assert.ok(T.DIR.x < 0 && T.DIR.y > 0)
  assert.ok(Math.abs(Math.hypot(T.DIR.x, T.DIR.y) - 1) < 1e-9)
})

test('wrap: always in [0, m)', () => {
  assert.equal(T.wrap(5, 10), 5)
  assert.equal(T.wrap(-1, 10), 9)
  assert.equal(T.wrap(-25, 10), 5)
  assert.equal(T.wrap(30, 10), 0)
})

test('formation: covers the screen, density scales with size, stable for a size', () => {
  const { w, h } = T.spriteSize(1080)
  const f = T.formation(1920, 1080, w, h)
  assert.ok(f.fw >= 1920 + w && f.fh >= 1080 + h, 'torus is screen + one sprite')
  assert.equal(f.fw, f.cols * f.cw)
  assert.equal(f.fh, f.rows * f.ch)
  assert.equal(f.rows % 2, 0)
  assert.equal(f.items.length, f.cols * f.rows)
  assert.ok(f.items.some((i) => i.toast) && f.items.some((i) => !i.toast))
  assert.deepEqual(T.formation(1920, 1080, w, h), f)
  // a bigger screen at the same sprite size holds more
  const big = T.formation(3840, 2160, w, h)
  assert.ok(big.items.length > f.items.length * 2.5)   // ~4× the area, minus the fixed one-sprite margin
})

test('formation: the screen never empties while flying, at any offset', () => {
  const W = 1920, H = 1080
  const { w: sw, h: sh } = T.spriteSize(H)
  const f = T.formation(W, H, sw, sh)
  for (let step = 0; step < 400; step++) {
    const d = step * 37.3
    const ox = T.DIR.x * d, oy = T.DIR.y * d
    let onScreen = 0
    // every screen quadrant has a visible sprite
    const quads = [0, 0, 0, 0]
    for (const it of f.items) {
      const p = T.itemPos(f, it, ox, oy, sw, sh)
      assert.ok(Number.isInteger(p.x) && Number.isInteger(p.y))
      assert.ok(p.x >= -sw && p.x < f.fw - sw + 1 && p.y >= -sh && p.y < f.fh - sh + 1)
      const cx = p.x + sw / 2, cy = p.y + sh / 2
      if (cx >= 0 && cx < W && cy >= 0 && cy < H) {
        onScreen++
        quads[(cx < W / 2 ? 0 : 1) + (cy < H / 2 ? 0 : 2)]++
      }
    }
    assert.ok(onScreen >= f.items.length * 0.4, 'step ' + step + ': ' + onScreen + ' on screen')
    assert.ok(quads.every((q) => q > 0), 'step ' + step + ' quadrants ' + quads)
  }
})

test('itemPos: wrapping is seamless (one full torus period returns the same place)', () => {
  const f = T.formation(1280, 720, 113, 120)
  const it = f.items[5]
  assert.deepEqual(T.itemPos(f, it, -f.fw, 0, 113, 120), T.itemPos(f, it, 0, 0, 113, 120))
  assert.deepEqual(T.itemPos(f, it, 0, f.fh * 3, 113, 120), T.itemPos(f, it, 0, 0, 113, 120))
})
