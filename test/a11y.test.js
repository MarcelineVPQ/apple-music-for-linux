// Accessibility of Sonata's own windows (lyrics, mini player, visualizer, rail, panel), from their
// source: the static half of tools/ui-check.js `a11y` (that phase drives a real isolated copy: focus
// order, keyboard reach, focus rings, the rule set, reduced motion in the running pages).
//   - reduced motion: every pop, bounce and lift in lyrics-view.css has a "transform: none" under
//     prefers-reduced-motion, and the countdown dots only fill (no scale) when still;
//   - names: every button in the floating windows' markup is named; each page says its language;
//   - focus: every control of the lyrics window and the mini player has a :focus-visible ring in the
//     theme's ring colour (var(--s-ring)), never the browser's own.
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')
const V = require('../lyrics-view')

const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8')
const styles = (html) => [...html.matchAll(/<style>([\s\S]*?)<\/style>/g)].map((m) => m[1]).join('\n')

// rules with their @media context: [{ media, selectors: [..], decls: { prop: value } }]
function rules(css) {
  css = css.replace(/\/\*[\s\S]*?\*\//g, '')
  const out = []
  let i = 0
  function block(media) {
    // loop: one pass over the stylesheet's characters · test only
    while (i < css.length) {
      const open = css.indexOf('{', i)
      const close = css.indexOf('}', i)
      if (close >= 0 && (open < 0 || close < open)) { i = close + 1; return }
      if (open < 0) return
      const head = css.slice(i, open).trim()
      i = open + 1
      if (/^@media/.test(head)) { block(head); continue }
      if (/^@keyframes/.test(head)) { block('@keyframes'); continue }
      const end = css.indexOf('}', i)
      const decls = {}
      // loop: a rule's declarations · test only
      for (const d of css.slice(i, end).split(';')) {
        const k = d.indexOf(':')
        if (k > 0) decls[d.slice(0, k).trim()] = d.slice(k + 1).trim()
      }
      i = end + 1
      out.push({ media, selectors: head.split(',').map((x) => x.trim().replace(/\s+/g, ' ')), decls })
    }
  }
  block('')
  return out
}
const REDUCE = /prefers-reduced-motion:\s*reduce/

test('reduced motion: every word pop, syllable bounce and held-note lift is switched off', () => {
  const r = rules(read('lyrics-view.css'))
  const moving = r.filter((x) => !x.media && x.decls.transform && x.decls.transform !== 'none')
    .flatMap((x) => x.selectors).filter((s) => /\.now\b/.test(s))
  assert.ok(moving.length >= 6, 'the pops are found: ' + moving.join(' | '))
  const off = new Set(r.filter((x) => REDUCE.test(x.media) && x.decls.transform === 'none').flatMap((x) => x.selectors))
  assert.deepEqual(moving.filter((s) => !off.has(s)), [])
})

test('reduced motion: the visualizer\'s new line fades without rising; the record flip and smooth scroll stop', () => {
  const viz = rules(styles(read('visualizer.html')))
  assert.ok(viz.some((x) => REDUCE.test(x.media) && x.selectors.includes('#lyrics .line.active') && /lv-next/.test(x.decls['animation-name'] || '')))
  const html = read('lyrics.html')
  assert.match(html, /prefers-reduced-motion: reduce\)'\)\.matches\) \{ thumb\.src = artUrl; return \}/)
  assert.ok(rules(styles(html)).some((x) => REDUCE.test(x.media) && x.selectors.includes('#lines') && x.decls['scroll-behavior'] === 'auto'))
  // the scenes that travel take the reduced pace; the bars don't travel
  const vs = read('visualizer.html')
  assert.match(vs, /aurora\.t \+= .*\* pace/)
  assert.match(vs, /nebula\.rot \+= .*\* pace/)
  assert.match(vs, /const dt = .*\* pace/)
})

test('reduced motion: the countdown dots only fill (opacity), never scale; the fill is the same', () => {
  const g = { start: 10, end: 20 }
  const still = V.dotKeyframes(g, true)
  const moving = V.dotKeyframes(g, false)
  const frames = [...still.dots.flat(), ...still.row]
  assert.ok(frames.every((f) => f.transform === 'scale(1.0000)'), 'no scale when still')
  assert.deepEqual(still.dots.map((d) => d.map((f) => f.opacity)), moving.dots.map((d) => d.map((f) => f.opacity)))
  assert.deepEqual(still.row.map((f) => f.opacity), moving.row.map((f) => f.opacity))
  assert.ok(moving.row.some((f) => f.transform !== 'scale(1.0000)'), 'the breathe is still there without the preference')
})

test('names: every button in the floating windows is named; every page says its language', () => {
  for (const f of ['lyrics.html', 'miniplayer.html', 'visualizer.html', 'rail.html', 'panel.html', 'liner-notes.html']) {
    const html = read(f)
    assert.match(html, /<html lang="en">/, f + ' has lang')
    // loop: the page's buttons · test only
    for (const b of html.matchAll(/<button\b[^>]*>/g)) assert.match(b[0], /aria-label="[^"]+"/, f + ': ' + b[0])
    // loop: the page's role=button elements · test only
    for (const b of html.matchAll(/<[a-z]+\b[^>]*role="button"[^>]*>/g)) assert.match(b[0], /tabindex="0"[^>]*aria-label="[^"]+"|aria-label="[^"]+"[^>]*tabindex="0"/, f + ': ' + b[0])
  }
})

test('focus: the lyrics window\'s and the mini player\'s controls show the theme\'s ring on keyboard focus', () => {
  const want = { 'lyrics.html': ['#close', '#form', '#art', '#lines', '.line', '.ib', '.bar', '.tile', '.lnk', 'button.chip', '#cover-btn', 'button.q-row'], 'miniplayer.html': ['button', '#art', '#seek', '#volume'], 'liner-notes.html': ['#close', '.curl', '#sections button', '#status button', 'a'] }
  for (const [f, sels] of Object.entries(want)) {
    const r = rules(styles(read(f)))
    for (const s of sels) {
      const ring = r.find((x) => x.selectors.includes(s + ':focus-visible'))
      assert.ok(ring && /var\(--s-ring\)/.test(ring.decls.outline || ''), f + ' ' + s + ':focus-visible uses --s-ring')
    }
  }
})

test('no colour-only signals: the stage\'s on toggles (shuffle, repeat) get a dot as well as the colour', () => {
  const r = rules(styles(read('lyrics.html')))
  const dot = r.find((x) => x.selectors.includes('.ib.on::after'))
  assert.ok(dot && dot.decls.content === "''" && dot.decls.background === 'currentColor')
})

test('no colour-only signals: the mini player\'s on toggles get a dot as well as the colour', () => {
  const r = rules(styles(read('miniplayer.html')))
  const dot = r.find((x) => x.selectors.includes('button.small.active:not(#fav)::after'))
  assert.ok(dot && dot.decls.content === "''" && dot.decls.background === 'currentColor')
  // the duet singers differ by side as well as colour (lyrics-view.css)
  const lv = rules(read('lyrics-view.css'))
  assert.ok(lv.some((x) => x.selectors.includes('.line.left') && x.decls['text-align'] === 'left'))
  assert.ok(lv.some((x) => x.selectors.includes('.line.right') && x.decls['text-align'] === 'right'))
  assert.ok(lv.some((x) => x.selectors.includes('.line.center') && x.decls['text-align'] === 'center'))
})

test('liner notes: reduced motion stops the disc and the pulse; the sung line is marked by a dot as well as the colour', () => {
  const r = rules(styles(read('liner-notes.html')))
  assert.ok(r.some((x) => REDUCE.test(x.media) && x.selectors.includes('.disc.spin') && x.decls.animation === 'none'))
  assert.ok(r.some((x) => REDUCE.test(x.media) && x.selectors.includes('.page.pulse::before') && x.decls.animation === 'none'))
  assert.ok(r.some((x) => !x.media && x.selectors.includes('.stz span.now::before') && x.decls.opacity === '1'))
  const html = read('liner-notes.html')
  assert.match(html, /<div id="say" class="sr-only" role="status" aria-live="polite">/, 'page turns are said to screen readers')
  assert.match(html, /if \(e\.key === 'Escape'\) \{ e\.preventDefault\(\); send\('close'\)/, 'Esc closes')
})
