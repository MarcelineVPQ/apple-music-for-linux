// The Montage's pure logic (montage-model.js): the moves, the timeline, the shade every theme needs
// over a photo's darkest and lightest pixel, the extremes and the fetch width.
const test = require('node:test')
const assert = require('node:assert/strict')
const M = require('../montage-model')
const T = require('../theme')

test('moves: zoom in, then out, never the same move twice running; within the photo\'s overhang', () => {
  for (let k = 0; k < 6; k++) {
    const a = M.pose(k, 0)
    const b = M.pose(k, 1)
    if (k % 2 === 0) assert.ok(b.scale > a.scale, 'even slots zoom in')
    else assert.ok(b.scale < a.scale, 'odd slots ease out')
    // loop: NOT-WORTH — test only
    for (const p of [0, 0.25, 0.5, 0.75, 1]) {
      const ps = M.pose(k, p)
      assert.ok(ps.scale >= M.ZOOM[0] && ps.scale <= M.ZOOM[1])
      // the pan never shows the photo's edge: the 7 % overhang plus the zoom cover the drift
      assert.ok(Math.abs(ps.x) <= M.DRIFT * 2 && Math.abs(ps.y) <= M.DRIFT * 2, JSON.stringify(ps))
    }
  }
  assert.match(M.css(M.pose(0, 0.5)), /^translate3d\(-?[\d.]+%,-?[\d.]+%,0\) scale\([\d.]+\)$/, 'transform only')
})

test('timeline: each photo holds 11 s, the next fades in over 2.4 s on top; it wraps around', () => {
  let f = M.frame(0, 3)
  assert.equal(f.cur, 0); assert.equal(f.prev, -1); assert.equal(f.curOpacity, 1)
  f = M.frame(M.HOLD + 1.2, 3)
  assert.equal(f.cur, 1); assert.equal(f.prev, 0); assert.ok(f.fading); assert.ok(Math.abs(f.curOpacity - 0.5) < 1e-9)
  f = M.frame(M.HOLD + M.FADE + 0.1, 3)
  assert.equal(f.prev, -1); assert.equal(f.curOpacity, 1)
  f = M.frame(3 * M.HOLD + 0.5, 3)
  assert.equal(f.cur, 0, 'wraps'); assert.equal(f.prev, 2)
  // one photo: it just drifts, no fade
  f = M.frame(5 * M.HOLD + 0.5, 1)
  assert.equal(f.cur, 0); assert.equal(f.fading, false); assert.equal(f.curOpacity, 1)
  assert.equal(M.frame(10, 0), null)
  // the same time gives the same frame: the clock (only running while the music plays) is all it reads
  assert.deepEqual(M.frame(17.3, 4), M.frame(17.3, 4))
})

test('reduced motion: no pan or zoom, a longer hold, the time to the next cross-fade', () => {
  const f = M.frame(5, 3, true)
  assert.equal(f.curPose, null); assert.equal(f.prevPose, null)
  assert.equal(f.next, M.CALM_HOLD - 5)
  assert.equal(M.frame(M.CALM_HOLD + 1, 3, true).cur, 1)
})

// every theme Sonata draws: light/dark x album colour on/off x Glass on/off (a light and a dark artwork backdrop)
function themes() {
  const out = []
  for (const dark of [false, true]) {
    for (const palette of [null, { accent: '#3e92cc' }, { accent: '#f2c94c' }]) {
      for (const glass of [false, true]) {
        const backdrop = glass ? { lumMin: dark ? 0.004 : 0.5, lumMax: dark ? 0.08 : 0.9 } : null
        out.push({ tag: (dark ? 'dark' : 'light') + (palette ? '-' + palette.accent : '-plain') + (glass ? '-glass' : ''), vars: T.themeTokens({ dark, palette, glass, backdrop }).vars })
      }
    }
  }
  return out
}
const PHOTOS = {
  'black and white': { lo: [0, 0, 0], hi: [255, 255, 255] },
  'a night stage': { lo: [3, 3, 3], hi: [199, 215, 221] },
  'a sunny field': { lo: [52, 31, 14], hi: [190, 165, 139] },
  'mid grey': { lo: [110, 110, 110], hi: [150, 150, 150] }
}
const rgb = (s) => s.match(/[\d.]+/g).slice(0, 3).map(Number)

test('the shade: every word reaches its contrast over every photo in every theme (4.5:1, quiet lines 3:1)', () => {
  // loop: NOT-WORTH — test only (12 themes x 4 photos)
  for (const th of themes()) {
    for (const [name, photo] of Object.entries(PHOTOS)) {
      const s = M.scrimFor(th.vars, photo)
      assert.ok(s.ok, th.tag + ' over ' + name + ': ' + JSON.stringify(s))
      assert.ok(s.alpha >= M.SCRIM_MIN && s.alpha <= M.SCRIM_MAX)
      // checked again independently: the token over the shade over the photo's extremes
      const surf = rgb(th.vars['--s-surface'])
      for (const [k, need] of M.NEEDS) {
        const c = rgb(th.vars[k])
        const worst = Math.min(...[photo.lo, photo.hi].map((b) => T.contrast(c, T.stack(b, [[surf, s.alpha]]))))
        assert.ok(worst >= need - 1e-9, th.tag + ' ' + name + ' ' + k + ' ' + worst.toFixed(2))
      }
    }
  }
})

test('the shade is the least that passes: a calm photo shows more than a harsh one', () => {
  const th = themes()[0].vars
  const harsh = M.scrimFor(th, PHOTOS['black and white']).alpha
  const calm = M.scrimFor(th, PHOTOS['mid grey']).alpha
  assert.ok(calm <= harsh)
  assert.equal(M.scrimFor(th, null).alpha, harsh, 'unknown extremes: black and white assumed')
  // one step less would fail (when above the floor)
  if (harsh > M.SCRIM_MIN) {
    const surf = rgb(th['--s-surface'])
    const less = harsh - 0.02
    const fails = M.NEEDS.some(([k, need]) => T.worstContrast(rgb(th[k]), [[surf, less]], [PHOTOS['black and white'].lo, PHOTOS['black and white'].hi]) < need)
    assert.ok(fails)
  }
})

test('extremes: the darkest and lightest pixel, BGRA (nativeImage) or RGBA', () => {
  // 3 pixels: dark blue-ish, white, mid red; BGRA order
  const bgra = Uint8Array.from([80, 10, 10, 255, 255, 255, 255, 255, 30, 30, 200, 255])
  const x = M.extremes(bgra)
  assert.deepEqual(x.hi, [255, 255, 255])
  assert.deepEqual(x.lo, [10, 10, 80])
  const rgba = Uint8Array.from([10, 10, 80, 255, 255, 255, 255, 255])
  assert.deepEqual(M.extremes(rgba, true).lo, [10, 10, 80])
  assert.equal(M.extremes(new Uint8Array(0)), null)
})

test('fetch width: the centre column at the largest zoom, the photo\'s aspect and the screen\'s scale', () => {
  // the Studio's default 1240 x 780: the centre is ~626 x 770
  const box = { w: 626, h: 770 }
  const land = M.needWidth(box, 1.5, 1)
  assert.ok(land > 1500 && land < 1700, String(land))      // a 3:2 photo covers the height
  assert.ok(M.needWidth(box, 0.75, 1) < land)                // a portrait one covers the width
  assert.equal(M.needWidth(box, 1.5, 2), Math.ceil(Math.max(626 * 1.14, 770 * 1.14 * 1.5) * 1.17 * 2))
})
