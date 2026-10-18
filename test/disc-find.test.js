// The disc in a disc scan (disc-find.js): synthetic scans, drawn here, of a CD on patterned paper
const test = require('node:test')
const assert = require('node:assert/strict')
const D = require('../disc-find')

// a light paper with a blue pattern of small marks and thin lines (as the In Rainbows US CD's tray card)
function paper(w, h) {
  const data = new Uint8Array(w * h * 4)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4
      const mark = (x % 9 < 2 && y % 7 < 2) || x % 23 === 0
      data[o] = mark ? 150 : 236; data[o + 1] = mark ? 175 : 234; data[o + 2] = mark ? 225 : 228; data[o + 3] = 255
    }
  }
  return { data, width: w, height: h }
}
// a printed CD: black, with coloured bands of "letters" (yellow, red, green, blue), a light spindle hole
function disc(img, cx, cy, r) {
  const { data, width: w, height: h } = img
  const bands = [[250, 215, 0], [230, 40, 40], [40, 180, 80], [60, 90, 220]]
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy)
      if (d > r) continue
      const o = (y * w + x) * 4
      let c = [12, 12, 14]
      const band = Math.floor((y - cy + r) / (r / 3.5))
      if (band % 2 === 0 && (x * 7 + y * 3) % 11 < 6) c = bands[(band / 2) % 4]
      if (d < r * 0.24) c = [205, 205, 205]   // the clamping ring
      if (d < r * 0.09) c = [236, 234, 228]   // the spindle hole: the paper shows through
      data[o] = c[0]; data[o + 1] = c[1]; data[o + 2] = c[2]
    }
  }
  return img
}
const near = (a, b, tol, what) => assert.ok(Math.abs(a - b) <= tol, what + ': ' + a + ' is not within ' + tol + ' of ' + b)

test('findDisc: an off-centre disc on patterned paper is found, centred and just inside its rim', () => {
  const w = 250; const h = 175
  const fit = D.findDisc(disc(paper(w, h), 160, 90, 78))
  assert.ok(fit, 'found')
  near(fit.x * w, 160, 1.5, 'centre x')
  near(fit.y * h, 90, 1.5, 'centre y')
  near(fit.rx * w, 78 * 0.985, 2, 'radius')
  near(fit.ry * h, fit.rx * w, 0.05, 'the same circle in both directions')
})

test('findDisc: a disc that already fills the scan stays as it is (centred, the whole image)', () => {
  const fit = D.findDisc(disc(paper(200, 200), 100, 100, 99))
  assert.ok(fit)
  near(fit.x, 0.5, 0.01, 'x'); near(fit.y, 0.5, 0.01, 'y'); near(fit.rx, 0.49, 0.01, 'r')
})

test('findDisc: a disc cut by the image edge is shown a little smaller about its own centre; cut too far, refused', () => {
  const w = 250; const h = 175
  // radius 92 with 87.5 px of room above and below: cut, the crop keeps inside the image
  const fit = D.findDisc(disc(paper(w, h), 150, 87.5, 92))
  assert.ok(fit, 'found')
  near(fit.x * w, 150, 1.5, 'centre x')
  near(fit.y * h, 87.5, 1.5, 'centre y')
  assert.ok(fit.ry * h <= 87.5 + 1e-6, 'the crop stays inside the image')
  assert.ok(fit.ry * h >= 92 * (1 - D.RIM_CUT), 'not much smaller than the disc')
  // radius 130 in 87.5 px of room: a third of the disc gone; the scan is shown as before
  assert.equal(D.findDisc(disc(paper(w, h), 150, 87.5, 130)), null)
})

test('findDisc: no disc, a booklet page or a blank image: nothing (the scan shows as before, still)', () => {
  assert.equal(D.findDisc(paper(250, 175)), null)
  const page = paper(250, 175)
  for (let y = 30; y < 150; y++) for (let x = 40; x < 210; x++) { const o = (y * 250 + x) * 4; page.data[o] = page.data[o + 1] = page.data[o + 2] = 20 }
  assert.equal(D.findDisc(page), null, 'a dark rectangle is no disc')
  const blank = { data: new Uint8Array(100 * 100 * 4).fill(128), width: 100, height: 100 }
  assert.equal(D.findDisc(blank), null)
  assert.equal(D.findDisc(null), null)
  assert.equal(D.findDisc({ data: new Uint8Array(10), width: 100, height: 100 }), null, 'too few pixels')
})

test('findDisc: 3-channel pixels and BGRA order give the same circle', () => {
  const img = disc(paper(180, 140), 100, 70, 60)
  const rgb = new Uint8Array(180 * 140 * 3)
  for (let i = 0; i < 180 * 140; i++) { rgb[i * 3] = img.data[i * 4 + 2]; rgb[i * 3 + 1] = img.data[i * 4 + 1]; rgb[i * 3 + 2] = img.data[i * 4] }
  assert.deepEqual(D.findDisc({ data: rgb, width: 180, height: 140, channels: 3 }), D.findDisc(img))
})

test('discCrop: the circle fills the round disc, centred; discKey: the smallest thumbnail', () => {
  assert.deepEqual(D.discCrop({ x: 0.5, y: 0.5, rx: 0.5, ry: 0.5 }), { width: '100%', height: '100%', left: '0%', top: '0%' })
  // the In Rainbows scan (500×350): the disc at (332, 172.5), 162.5 px
  const c = D.discCrop({ x: 0.6642, y: 0.4928, rx: 0.325, ry: 0.4643 })
  const W = parseFloat(c.width); const H = parseFloat(c.height)
  near(W / H, 500 / 350, 0.005, 'the image keeps its shape')
  near(parseFloat(c.left) + 0.6642 * W, 50, 0.01, 'the disc centre at the middle (x)')
  near(parseFloat(c.top) + 0.4928 * H, 50, 0.01, 'the disc centre at the middle (y)')
  assert.equal(D.discCrop(null), null)
  assert.equal(D.discKey({ 250: 'a', 500: 'b', 1200: 'c' }), 'a')
  assert.equal(D.discKey({ 250: '', 500: 'b', 1200: 'c' }), 'b')
  assert.equal(D.discKey(null), '')
})
