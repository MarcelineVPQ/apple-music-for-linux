// Duet colours (0.15.33): the album palette gives a second accent far enough round the colour wheel,
// with a fallback pair for one-colour and black-and-white art; the theme fits both, and the group
// blend, to 4.5:1 in light and dark, plain and Glass; the lyric views route them by singer.
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')
const P = require('../palette')
const T = require('../theme')

const N = 32
const art = (fn) => { const b = new Uint8Array(N * N * 4); for (let i = 0; i < N * N; i++) { const [r, g, bl] = fn(i % N, Math.floor(i / N)); b[i * 4] = bl; b[i * 4 + 1] = g; b[i * 4 + 2] = r; b[i * 4 + 3] = 255 } return b }
const hueOf = (hex) => { const [r, g, b] = T.hexRgb(hex); return P.rgbToHsl(r, g, b).h }

test('palette: two hues in the art -> two accents, the second from the art, >= 60° apart', () => {
  const cases = {
    'red and blue': art((x) => (x < 20 ? [215, 35, 45] : [35, 70, 215])),
    'teal and orange': art((x, y) => ((x + y) % 3 ? [20, 160, 150] : [235, 130, 30])),
    'purple and yellow': art((x) => (x % 2 ? [120, 40, 200] : [230, 200, 40]))
  }
  for (const [name, a] of Object.entries(cases)) {
    const p = P.extractPalette(a, { bgra: true })
    assert.ok(P.hueGap(hueOf(p.accent), hueOf(p.accent2)) >= P.MIN_HUE_GAP, name + ': ' + p.accent + ' / ' + p.accent2)
  }
  // the second really comes from the art: red + blue art gives a blue second voice
  const rb = P.extractPalette(cases['red and blue'], { bgra: true })
  assert.ok(P.hueGap(hueOf(rb.accent2), 230) < 25, rb.accent2)
})

test('palette: one-colour art, near hues and black-and-white art get a clearly different fallback pair', () => {
  for (const [name, a] of Object.entries({
    'one red': art(() => [200, 40, 50]),
    'red and orange (only 30° apart)': art((x) => (x % 2 ? [220, 30, 40] : [230, 120, 30])),
    'black and white': art((x) => (x % 2 ? [255, 255, 255] : [0, 0, 0])),
    'grey': art(() => [128, 128, 128])
  })) {
    const p = P.extractPalette(a, { bgra: true })
    assert.match(p.accent2, /^#[0-9a-f]{6}$/, name)
    assert.ok(P.hueGap(hueOf(p.accent), hueOf(p.accent2)) >= P.MIN_HUE_GAP, name + ': ' + p.accent + ' / ' + p.accent2)
  }
})

test('theme: singer 2 and the group blend read at 4.5:1 and stay distinct, light and dark, plain and Glass', () => {
  const pairs = []
  for (let h = 0; h < 360; h += 30) {
    const a = P.extractPalette(art((x) => (x < 22 ? hsl(h) : hsl(h + 150))), { bgra: true })
    pairs.push([a.accent, a.accent2])
  }
  function hsl(h) { return P.hslToRgb(((h % 360) + 360) % 360, 0.8, 0.5) }
  const bd = { dark: { lumMin: 0.005, lumMax: 0.08 }, light: { lumMin: 0.5, lumMax: 0.85 } }
  for (const dark of [false, true]) {
    for (const glass of [false, true]) {
      for (const [a, b] of pairs) {
        const t = T.themeTokens({ dark, palette: { accent: a, accent2: b }, glass, backdrop: glass ? bd[dark ? 'dark' : 'light'] : null })
        for (const k of ['accentText', 'accent2Text', 'mixText']) assert.ok(t.contrast[k] >= 4.5, k + ' ' + t.contrast[k].toFixed(2) + ' ' + a + '/' + b + ' dark=' + dark + ' glass=' + glass)
        const h1 = P.rgbToHsl(...T.hexRgb(rgbHex(t.vars['--s-accent-text']))).h
        const h2 = P.rgbToHsl(...T.hexRgb(rgbHex(t.vars['--s-accent-2-text']))).h
        assert.ok(P.hueGap(h1, h2) >= 30, 'still two colours after fitting: ' + t.vars['--s-accent-text'] + ' / ' + t.vars['--s-accent-2-text'])
      }
    }
  }
  function rgbHex(v) { return '#' + v.match(/[\d.]+/g).slice(0, 3).map((n) => Math.round(+n).toString(16).padStart(2, '0')).join('') }
  // no second accent (Adaptive album color off, or an old palette): every singer in the main one
  const one = T.themeTokens({ dark: true, palette: { accent: '#e22831' } })
  assert.equal(one.vars['--s-accent-2-text'], one.vars['--s-accent-text'])
})

test('group blend goes round the wheel (red + blue = purple), not through grey', () => {
  const [r, g, b] = T.hueBlend([226, 40, 49], [40, 69, 226])
  const h = P.rgbToHsl(r, g, b)
  assert.ok(h.h > 260 && h.h < 320 && h.s > 0.5, JSON.stringify(h))
})

test('visualizer: each voice lifted to 4.5:1 on the dark stage', () => {
  for (const hex of ['#2845e2', '#e22831', '#1a7f37', '#4c54e6', '#7a1fa2']) {
    const out = T.stageText(hex)
    assert.ok(T.contrast(T.hexRgb(out), [0, 0, 0]) >= 4.5, hex + ' -> ' + out)
  }
})

test('the lyric views route the colours by singer; background vocals inherit their line', () => {
  const css = fs.readFileSync(path.join(__dirname, '..', 'lyrics-view.css'), 'utf8')
  assert.match(css, /\.line\.singer-2, \.dots\.singer-2 \{ --sing: var\(--active-2, var\(--active\)\); \}/)
  assert.match(css, /\.line\.singer-group, \.dots\.singer-group \{ --sing: var\(--active-mix, var\(--active\)\); \}/)
  assert.doesNotMatch(css.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\.line, \.dots \{ --sing: var\(--active\); \}/, ''), /color: var\(--active\)|text-shadow:[^;]*var\(--active\)/)
  // 0.15.68: one column, no sides (test/duet-lanes.test.js): colour is the one per-singer difference
  const lyr = fs.readFileSync(path.join(__dirname, '..', 'lyrics.html'), 'utf8')
  assert.match(lyr, /'--active-2': '--s-accent-2-text'/)
  const viz = fs.readFileSync(path.join(__dirname, '..', 'visualizer.html'), 'utf8')
  assert.match(viz, /r\.setProperty\('--active-2', T\.stageText\(a2\)\)/)
  const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8')
  assert.match(main, /palette: on \? \{ accent: lastPalette\.accent, accent2: lastPalette\.accent2 \} : null/)
})
