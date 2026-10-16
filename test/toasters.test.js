const test = require('node:test')
const assert = require('node:assert/strict')
const T = require('../toasters')

test('sprites: every pose and the toast use palette colours only, at the declared size', () => {
  const sprites = [...T.WING_POSES.map((_, i) => T.buildToaster(i)), T.buildToast()]
  for (const g of sprites) {
    assert.equal(g.px.length, g.w * g.h)
    for (const c of g.px) assert.ok(c === 0 || (c < T.PALETTE.length && T.PALETTE[c]), 'colour ' + c)
  }
  assert.equal(sprites[0].w, T.TW)
  assert.equal(sprites[0].h, T.TH)
})

test('sprites: the wings move between poses (up reaches higher, down lower) and nothing touches the edge', () => {
  const extent = (g) => {
    let top = g.h, bottom = -1
    for (let y = 0; y < g.h; y++) for (let x = 0; x < g.w; x++) if (g.px[y * g.w + x]) { top = Math.min(top, y); bottom = Math.max(bottom, y) }
    return { top, bottom }
  }
  const poses = T.WING_POSES.map((_, i) => T.buildToaster(i))
  const up = extent(poses[0])
  const down = extent(poses[poses.length - 1])
  assert.ok(up.top < down.top, 'up pose reaches higher')
  for (const g of poses) {
    for (let y = 0; y < g.h; y++) {
      assert.equal(g.px[y * g.w], 0)
      assert.equal(g.px[y * g.w + g.w - 1], 0)
    }
    for (let x = 0; x < g.w; x++) assert.equal(g.px[(g.h - 1) * g.w + x], 0)
  }
  // all poses differ
  for (let i = 1; i < poses.length; i++) assert.notDeepEqual(poses[i].px, poses[i - 1].px)
})

test('flapPose: eased ping-pong cycle up -> down -> up, wraps per turn', () => {
  const seq = []
  for (let k = 0; k < 8; k++) seq.push(T.flapPose(k / 8))
  assert.deepEqual(seq, [0, 1, 2, 3, 4, 3, 2, 1].map((p) => p))  // 8 steps of a turn
  assert.equal(T.flapPose(0.5), T.WING_POSES.length - 1)
  assert.equal(T.flapPose(3.25), T.flapPose(0.25))
  assert.equal(T.flapPose(-0.25), T.flapPose(0.75))
})

test('spriteScale: integer, at least 2, grows with the screen', () => {
  assert.equal(T.spriteScale(200), 2)
  const hd = T.spriteScale(1080), uhd = T.spriteScale(2160)
  assert.ok(Number.isInteger(hd) && Number.isInteger(uhd))
  assert.ok(uhd >= hd * 2 - 1)
  // a toaster stays a readable fraction of the screen height on 4K
  assert.ok(T.TH * uhd > 2160 / 12 && T.TH * uhd < 2160 / 4)
})

test('wrap: always in [0, m)', () => {
  assert.equal(T.wrap(5, 10), 5)
  assert.equal(T.wrap(-1, 10), 9)
  assert.equal(T.wrap(-25, 10), 5)
  assert.equal(T.wrap(30, 10), 0)
})

test('formation: covers the screen, density scales with size, stable for a size', () => {
  const s = T.spriteScale(1080)
  const f = T.formation(1920, 1080, T.TW * s, T.TH * s)
  assert.ok(f.fw >= 1920 + T.TW * s && f.fh >= 1080 + T.TH * s, 'torus is screen + one sprite')
  assert.equal(f.fw, f.cols * f.cw)
  assert.equal(f.fh, f.rows * f.ch)
  assert.equal(f.rows % 2, 0)
  assert.equal(f.items.length, f.cols * f.rows)
  assert.ok(f.items.some((i) => i.toast) && f.items.some((i) => !i.toast))
  assert.deepEqual(T.formation(1920, 1080, T.TW * s, T.TH * s), f)
  // a bigger screen at the same sprite size holds more
  const big = T.formation(3840, 2160, T.TW * s, T.TH * s)
  assert.ok(big.items.length > f.items.length * 3)
})

test('formation: the screen never empties while flying, at any offset', () => {
  const W = 1920, H = 1080
  const s = T.spriteScale(H)
  const sw = T.TW * s, sh = T.TH * s
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
  const f = T.formation(1280, 720, 160, 104)
  const it = f.items[5]
  assert.deepEqual(T.itemPos(f, it, -f.fw, 0, 160, 104), T.itemPos(f, it, 0, 0, 160, 104))
  assert.deepEqual(T.itemPos(f, it, 0, f.fh * 3, 160, 104), T.itemPos(f, it, 0, 0, 160, 104))
})
