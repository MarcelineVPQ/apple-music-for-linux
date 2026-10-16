// The mini player's scrubber maths and KWin blur region (mini-model.js), and its page rules.
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')
const M = require('../mini-model')

test('scrubber: pointer -> seconds (clamped); ← / → 5 s, Home to the start; other keys pass', () => {
  assert.equal(M.seekAt(150, 100, 200, 240), 60)
  assert.equal(M.seekAt(50, 100, 200, 240), 0)
  assert.equal(M.seekAt(999, 100, 200, 240), 240)
  assert.equal(M.seekAt(150, 100, 0, 240), 0)
  assert.equal(M.keySeek('ArrowRight', 60, 240), 65)
  assert.equal(M.keySeek('ArrowLeft', 3, 240), 0)
  assert.equal(M.keySeek('ArrowRight', 239, 240), 239.5)
  assert.equal(M.keySeek('Home', 100, 240), 0)
  assert.equal(M.keySeek('Enter', 100, 240), null)
  assert.equal(M.keySeek('ArrowRight', 0, 0), null)
  assert.equal(M.clock(130), '2:10')
})

test('blur region: covers the pill and nothing past its round ends', () => {
  const r = M.blurRegion(4, 4, 672, 64, 1)
  assert.equal(r.length % 4, 0)
  let area = 0
  const rows = new Map()
  for (let i = 0; i < r.length; i += 4) {
    const [x, y, w, h] = r.slice(i, i + 4)
    assert.ok(x >= 4 && x + w <= 676 && y >= 4 && y + h <= 68, 'inside the pill box')
    for (let k = 0; k < h; k++) rows.set(y + k, [x, w])
    area += w * h
  }
  assert.equal(rows.size, 64, 'every row of the pill')
  // the stadium's area: rectangle + circle
  const ideal = (672 - 64) * 64 + Math.PI * 32 * 32
  assert.ok(area <= ideal && area > ideal * 0.95, area + ' vs ' + ideal)
  // the middle row spans the full width, the top row only the straight part (round ends)
  assert.deepEqual(rows.get(36), [4, 672])
  assert.ok(rows.get(4)[0] > 4 + 20)
  // scaled to device pixels
  const r2 = M.blurRegion(4, 4, 672, 64, 2)
  assert.equal(r2[0] >= 8, true)
  assert.equal(Math.max(...r2.filter((_, i) => i % 4 === 1)) + 0 <= 8 + 128, true)
})

test('mini page: one pill with a hairline, scrubber on hover with a crossfade, reduced motion, tokens only, named controls', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'miniplayer.html'), 'utf8')
  assert.match(html, /#pill \{[^}]*border: 1px solid var\(--s-edge\);[^}]*border-radius: 999px;/)
  assert.doesNotMatch(html, /id="lcd"/, 'no inner boxed card')
  assert.match(html, /#center:hover #scrub/)
  assert.match(html, /transition: opacity 0\.15s ease/)
  assert.match(html, /prefers-reduced-motion: reduce/)
  assert.match(html, /id="seek" role="slider" tabindex="0" aria-label="Song position"/)
  for (const id of ['shuffle', 'prev', 'playpause', 'next', 'repeat', 'fav', 'more', 'lyrics', 'queue', 'mute']) assert.match(html, new RegExp('id="' + id + '"[^>]*aria-label="[^"]+"'), id)
  assert.match(html, /send\('seek', t\)/, 'seeks through the same mini-command path')
  assert.match(html, /addEventListener\('wheel', onWheel, \{ passive: false \}\)/)
})
