// The album cover lightbox: its size on screen and the artwork pixels it asks Apple for (cover-model.js)
const test = require('node:test')
const assert = require('node:assert/strict')
const C = require('../cover-model')

test('coverLayout: fits the screen, asks for exactly the pixels it shows, never more than the original', () => {
  // 1080p, scale 1, a 3000 px square original: the height limits it, asked at its own size
  const a = C.coverLayout({ width: 1920, height: 1040 }, 1, 3000, 3000)
  assert.equal(a.w, a.h)
  assert.ok(a.h + C.CAPTION <= 1040 * 0.84 + 1)
  assert.equal(a.pxW, a.w)
  // HiDPI (scale 2): same size on screen, twice the pixels
  const b = C.coverLayout({ width: 1920, height: 1040 }, 2, 3000, 3000)
  assert.equal(b.w, a.w)
  assert.equal(b.pxW, a.w * 2)
  // a small original (600 px) is not blown up, and not asked for beyond its size
  const c = C.coverLayout({ width: 2560, height: 1400 }, 1, 600, 600)
  assert.deepEqual(c, { w: 600, h: 600, pxW: 600, pxH: 600 })
  const d = C.coverLayout({ width: 2560, height: 1400 }, 2, 600, 600)
  assert.equal(d.w, 300)
  assert.equal(d.pxW, 600)
  // a wide original keeps its shape; no size known: a square at the screen's fit
  const e = C.coverLayout({ width: 1920, height: 1040 }, 1, 4000, 2000)
  assert.equal(e.w, e.h * 2)
  const f = C.coverLayout({ width: 1000, height: 800 }, 1, 0, 0)
  assert.equal(f.w, f.h)
  assert.ok(f.w <= 860)
})

test('coverUrl: Apple\'s template at a size, with its crop and format placeholders filled', () => {
  assert.equal(C.coverUrl('https://is1-ssl.mzstatic.com/image/thumb/Music/x/{w}x{h}bb.jpg', 1400, 1400), 'https://is1-ssl.mzstatic.com/image/thumb/Music/x/1400x1400bb.jpg')
  assert.equal(C.coverUrl('https://x/{w}x{h}{c}.{f}', 800, 800), 'https://x/800x800bb.jpg')
})
