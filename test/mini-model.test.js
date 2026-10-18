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
  assert.match(html, /#mid\.hot #scrub/)
  // the star and the ⋯ sit outside the hover area (#mid), so they never vanish under the pointer
  const mid = html.slice(html.indexOf('<div id="mid">'), html.indexOf('<button id="fav"'))
  assert.doesNotMatch(mid, /id="fav"|id="more"/)
  assert.match(html, /hotTimer = setTimeout\(\(\) => mid\.classList\.add\('hot'\), 120\)/)
  assert.match(html, /#center\.idle #scrub \{ display: none; \}/)
  assert.match(html, /transition: opacity 0\.15s ease/)
  assert.match(html, /prefers-reduced-motion: reduce/)
  assert.match(html, /id="seek" role="slider" tabindex="0" aria-label="Song position"/)
  for (const id of ['shuffle', 'prev', 'playpause', 'next', 'repeat', 'fav', 'more', 'lyrics', 'queue', 'mute']) assert.match(html, new RegExp('id="' + id + '"[^>]*aria-label="[^"]+"'), id)
  assert.match(html, /send\('seek', t\)/, 'seeks through the same mini-command path')
  assert.match(html, /addEventListener\('wheel', onWheel, \{ passive: false \}\)/)
})

test('⋯ menu: a failed Favorite / Undo Favorite / Add to Library is told in words, with the song', () => {
  assert.deepEqual(M.actionFailedText('favorite', 'Spanish Moss'),
    { title: "Favorite didn't go through", body: '“Spanish Moss” isn\'t in your favorites yet. Try again in a moment.' })
  assert.equal(M.actionFailedText('undo-favorite', 'X').body, '“X” is still in your favorites. Try again in a moment.')
  assert.equal(M.actionFailedText('library', '').title, "Add to Library didn't go through")
  assert.match(M.actionFailedText('library', '').body, /^This song isn't in your library yet/)
  assert.ok(M.actionFailedText('favorite', 'a'.repeat(200)).body.length < 120, 'a long title is shortened')
  assert.equal(M.actionFailedText('other', 'X'), null)
  // main.js tells the user (no longer only logged)
  const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8')
  const call = main.slice(main.indexOf('function songAct('), main.indexOf('function actionFailed('))
  assert.match(call, /const text = miniModel\.actionFailedText\(action, extra\)\s*\n\s*if \(text\) actionFailed\(text\)/)
  // the ⋯ menu's song items come from the one builder the Studio's ⋯ uses too
  assert.match(main, /songMenuItems\(info, miniWindow, \['favorite', 'library', '-', 'link', 'cover', 'liner'\]/)
  assert.match(call, /error: SHOWN/)
})
