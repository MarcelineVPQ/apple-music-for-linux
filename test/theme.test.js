// The one theme system (theme.js, theme.css, theme-apply.js) and its Glass material: contrast over
// any backdrop and over the busiest artwork, the backdrop maker, the first-paint defaults, and the gate
// that keeps literal colours out of Sonata's own CSS.
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')
const vm = require('vm')
const T = require('../theme')
const { hslToRgb } = require('../palette')

const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8')
const hex = (rgb) => '#' + rgb.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')
const PALETTES = [null, { accent: 'garbage' }]
for (let h = 0; h < 360; h += 15) for (const l of [0.52, 0.6, 0.68]) for (const s of [0.58, 0.95]) PALETTES.push({ accent: hex(hslToRgb(h, s, l)) })
const rgbaOf = (v) => { const m = /rgba\(([^)]+)\)/.exec(v); const p = m[1].split(',').map(Number); return { rgb: p.slice(0, 3), a: p[3] } }

// the busiest artworks we can think of: hard black/white stripes, a checkerboard of saturated
// primaries, pure white, pure black, random noise (40×40 BGRA, as main.js hands them over)
function artworks() {
  const W = 40
  const make = (fn) => { const b = new Uint8Array(W * W * 4); for (let y = 0; y < W; y++) for (let x = 0; x < W; x++) { const [r, g, bl] = fn(x, y); const i = (y * W + x) * 4; b[i] = bl; b[i + 1] = g; b[i + 2] = r; b[i + 3] = 255 } return b }
  let seed = 7
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff)
  return {
    stripes: make((x) => (x % 2 ? [255, 255, 255] : [0, 0, 0])),
    bigStripes: make((x) => (x < 20 ? [255, 255, 255] : [0, 0, 0])),
    primaries: make((x, y) => [[255, 0, 0], [0, 255, 0], [0, 0, 255], [255, 255, 0], [255, 0, 255], [0, 255, 255]][(Math.floor(x / 5) + Math.floor(y / 5)) % 6]),
    white: make(() => [255, 255, 255]),
    black: make(() => [0, 0, 0]),
    noise: make(() => [rnd() * 255, rnd() * 255, rnd() * 255])
  }
}

test('contrast maths: known pairs', () => {
  assert.equal(Math.round(T.contrast([0, 0, 0], [255, 255, 255])), 21)
  assert.equal(T.contrast([10, 20, 30], [10, 20, 30]), 1)
  assert.deepEqual(T.hexRgb('#ff8000'), [255, 128, 0])
  assert.equal(T.hexRgb('nope'), null)
  for (const L of [0, 0.01, 0.2, 0.5, 0.9, 1]) assert.ok(Math.abs(T.lum(T.greyOf(L)) - L) < 0.01, 'greyOf ' + L)
})

test('plain (Glass off): every word >= 4.5:1 over ANY backdrop, every album hue, both themes; ring >= 3', () => {
  let worst = 99
  for (const dark of [false, true]) {
    for (const p of PALETTES) {
      const t = T.themeTokens({ dark, palette: p })
      const c = t.contrast
      for (const k of ['label', 'soft', 'blurLabel', 'blurSoft', 'materialLabel', 'materialSoft', 'active', 'hover', 'notice', 'noticeError', 'errorText', 'fill', 'upcoming', 'accentText']) {
        assert.ok(c[k] >= 4.5, k + ' ' + c[k].toFixed(2) + ' ' + JSON.stringify(p) + ' dark=' + dark)
      }
      assert.ok(c.ring >= 3, 'ring ' + JSON.stringify(p) + dark)
      assert.ok(t.alpha.overPage < 0.98, 'still translucent over the page')
      assert.equal(t.alpha.material, 1, 'no artwork: a solid surface')
      worst = Math.min(worst, c.label, c.soft, c.active)
      for (const v of Object.values(t.vars)) assert.match(v, /^(rgba\(|url\(|\d)/)
    }
  }
  assert.ok(worst >= 4.5)
})

test('Glass: over the busiest artwork, every pixel of the backdrop keeps the words >= 4.5:1, translucency kept', () => {
  const W = 40
  for (const [name, art] of Object.entries(artworks())) {
    for (const dark of [false, true]) {
      const bd = T.makeBackdrop(art, W, W, { dark })
      assert.ok(bd && bd.lumMin <= bd.lumMax, name)
      for (const p of [null, { accent: '#ffee00' }, { accent: '#2050ff' }, { accent: '#20e070' }, { accent: '#fa2d48' }]) {
        const t = T.themeTokens({ dark, palette: p, glass: true, backdrop: bd })
        assert.equal(t.vars['--s-glass-on'], '1')
        const mat = rgbaOf(t.vars['--s-material'])
        const text = rgbaOf(t.vars['--s-text']).rgb
        const soft = rgbaOf(t.vars['--s-soft']).rgb
        const upcoming = rgbaOf(t.vars['--s-upcoming']).rgb   // the sung line's words not reached yet
        let lowest = 99
        // the exact check, pixel by pixel (BGRA)
        for (let i = 0; i < W * W; i++) {
          const px = [bd.data[i * 4 + 2], bd.data[i * 4 + 1], bd.data[i * 4]]
          const under = T.stack(px, [[mat.rgb, mat.a]])
          lowest = Math.min(lowest, T.contrast(text, under), T.contrast(soft, under), T.contrast(upcoming, under))
        }
        assert.ok(lowest >= 4.5, `${name} dark=${dark} ${JSON.stringify(p)}: ${lowest.toFixed(2)}`)
        assert.ok(t.contrast.materialLabel >= 4.5 && t.contrast.materialSoft >= 4.5 && t.contrast.active >= 4.5 && t.contrast.hover >= 4.5, name)
        assert.ok(t.contrast.ring >= 3, 'ring ' + name)
        // the artwork shows through (not a solid surface pretending to be glass)
        assert.ok(mat.a <= 0.85, `${name} dark=${dark}: material alpha ${mat.a}`)
      }
    }
  }
})

test('the lyrics bug of 0.15.31: light scheme + dark album art, dark scheme + light album art: words read', () => {
  const W = 40
  const solid = (r, g, b) => { const a = new Uint8Array(W * W * 4); for (let i = 0; i < W * W; i++) { a[i * 4] = b; a[i * 4 + 1] = g; a[i * 4 + 2] = r; a[i * 4 + 3] = 255 } return a }
  const cases = [[false, solid(15, 10, 30), '#3a2a80'], [true, solid(245, 240, 230), '#e8d070'], [false, solid(0, 0, 0), '#20e070'], [true, solid(255, 255, 255), '#ffee00']]
  for (const [dark, art, accent] of cases) {
    for (const glass of [false, true]) {
      const bd = glass ? T.makeBackdrop(art, W, W, { dark }) : null
      const t = T.themeTokens({ dark, palette: { accent }, glass, backdrop: bd })
      const text = rgbaOf(t.vars['--s-text']).rgb
      // the words are chosen for the surface: light words on a dark surface, dark on a light one
      const surf = rgbaOf(t.vars['--s-surface']).rgb
      assert.equal(T.lum(text) > 0.5, T.lum(surf) < 0.5, 'text against its surface, dark=' + dark)
      assert.ok(t.contrast.label >= 4.5 && t.contrast.materialLabel >= 4.5, 'current line ' + accent + ' dark=' + dark)
      assert.ok(t.contrast.accentText >= 4.5, 'the sung line in the album accent ' + t.contrast.accentText)
      assert.ok(t.contrast.dim >= 3, 'dim lines ' + t.contrast.dim)
    }
  }
})

test('Glass backdrop: blurred, saturated, squeezed into the light or dark band; ~ms per track', () => {
  const art = artworks()
  const W = 40
  for (const dark of [false, true]) {
    const bd = T.makeBackdrop(art.stripes, W, W, { dark })
    // a 1-px stripe pattern is blurred flat: neighbouring pixels nearly equal
    let maxStep = 0
    for (let x = 1; x < W; x++) maxStep = Math.max(maxStep, Math.abs(bd.data[(20 * W + x) * 4 + 1] - bd.data[(20 * W + x - 1) * 4 + 1]))
    assert.ok(maxStep < 12, 'blurred: step ' + maxStep)
    // band: dark backdrops stay deep, light ones pale
    if (dark) assert.ok(bd.lumMax < 0.12, 'dark band ' + bd.lumMax)
    else assert.ok(bd.lumMin > 0.4, 'light band ' + bd.lumMin)
  }
  // saturation: a muted red comes out more vivid
  const muted = new Uint8Array(W * W * 4).fill(0)
  for (let i = 0; i < W * W; i++) { muted[i * 4] = 120; muted[i * 4 + 1] = 120; muted[i * 4 + 2] = 170; muted[i * 4 + 3] = 255 }   // BGRA: r=170
  const b = T.makeBackdrop(muted, W, W, { dark: true })
  const r = b.data[2]; const g = b.data[1]
  assert.ok(r > g, 'keeps its hue')
  assert.equal(T.makeBackdrop(null, W, W, {}), null)
  assert.equal(T.makeBackdrop(new Uint8Array(10), W, W, {}), null)
  // cost: once per track change, measured
  const t0 = process.hrtime.bigint()
  for (let i = 0; i < 20; i++) { T.makeBackdrop(art.noise, W, W, { dark: true }); T.makeBackdrop(art.noise, W, W, { dark: false }) }
  const perTrack = Number(process.hrtime.bigint() - t0) / 1e6 / 20
  assert.ok(perTrack < 25, 'both backdrops for one track: ' + perTrack.toFixed(1) + ' ms')
})

test('dark is dark, light is light; the album accent tints the surface', () => {
  const sum = (v) => rgbaOf(v).rgb.reduce((a, b) => a + b, 0)
  assert.ok(sum(T.themeTokens({ dark: true }).vars['--s-surface']) < 300)
  assert.ok(sum(T.themeTokens({ dark: false }).vars['--s-surface']) > 600)
  assert.notEqual(T.themeTokens({ dark: true, palette: { accent: '#2050ff' } }).vars['--s-surface'], T.themeTokens({ dark: true, palette: { accent: '#ff5020' } }).vars['--s-surface'])
  // Glass needs a backdrop: on without one is the plain surface
  assert.equal(T.themeTokens({ dark: true, glass: true, backdrop: null }).vars['--s-glass-on'], '0')
})

test('theme.css first paint = theme.js defaults (no album colour, Glass off), light and dark', () => {
  const css = read('theme.css')
  const block = (re) => Object.fromEntries([...re.exec(css)[1].matchAll(/(--s-[a-z0-9-]+):\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]))
  const dark = block(/:root \{([\s\S]*?)\n\}/)
  const light = Object.assign({}, dark, block(/@media \(prefers-color-scheme: light\) \{\s*:root \{([\s\S]*?)\}/))
  for (const [vars, isDark] of [[dark, true], [light, false]]) {
    const t = T.themeTokens({ dark: isDark }).vars
    for (const k of Object.keys(t)) assert.equal(vars[k], t[k], k + (isDark ? ' (dark)' : ' (light)'))
  }
})

test('one theme system: no literal colours in Sonata\'s own CSS outside theme.css / theme.js', () => {
  const LITERAL = /#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(/
  const styles = (html) => [...html.matchAll(/<style>([\s\S]*?)<\/style>/g)].map((m) => m[1]).join('\n')
  const files = { 'rail.css': read('rail.css'), 'panel.css': read('panel.css'), 'lyrics-view.css': read('lyrics-view.css') }
  for (const f of ['lyrics.html', 'miniplayer.html', 'visualizer.html', 'panel.html', 'rail.html', 'toast.html']) files[f + ' <style>'] = styles(read(f))
  for (const [f, css] of Object.entries(files)) {
    css.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').forEach((line, i) => assert.doesNotMatch(line, LITERAL, f + ':' + (i + 1) + ': ' + line.trim()))
  }
  // the UI scripts set no colours of their own either; the visualizer's canvas paints only with
  // theme.css's --s-stage-* tokens (viz-paint.js formats them, as theme.js does the rest)
  const scripts = (html) => [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]).join('\n')
  const code = { 'visualizer.html <script>': scripts(read('visualizer.html')) }
  for (const f of ['rail-ui.js', 'panel-ui.js', 'toast-ui.js', 'theme-apply.js']) code[f] = read(f)
  for (const [f, src] of Object.entries(code)) {
    src.replace(/\/\/.*$/gm, '').split('\n').forEach((line, i) => assert.doesNotMatch(line, LITERAL, f + ':' + (i + 1)))
  }
  // every Sonata page loads the tokens first
  for (const f of ['lyrics.html', 'miniplayer.html', 'visualizer.html', 'panel.html', 'rail.html', 'toast.html']) assert.match(read(f), /href="theme\.css"/, f)
})

test('theme-apply: writes the tokens once per change, crossfades the backdrop, follows the scheme', () => {
  // a tiny DOM stand-in: enough for theme-apply (classList, style, prepend, matchMedia)
  const mk = () => {
    const classes = new Set(); const style = {}
    return { classList: { add: (c) => classes.add(c), remove: (c) => classes.delete(c), toggle: (c, on) => (on ? classes.add(c) : classes.delete(c)), contains: (c) => classes.has(c) }, style, children: [], prepend(...k) { this.children.unshift(...k) }, set className(v) { classes.clear(); classes.add(v) }, classes }
  }
  const root = { style: { props: {}, setProperty(k, v) { this.props[k] = v; writes++ } } }
  let writes = 0
  const listeners = {}
  const mq = (q) => ({ get matches() { return q.includes('dark') ? isDark : false }, addEventListener: (ev, fn) => { listeners[q] = fn } })
  let isDark = true
  const doc = { documentElement: root, createElement: () => mk() }
  const ctx = vm.createContext({ SonataTheme: T, matchMedia: mq, document: doc })
  vm.runInContext(read('theme-apply.js'), ctx)
  const surface = mk()
  const theme = vm.runInContext('SonataThemeApply', ctx).attach({ surfaces: [surface], document: doc })
  assert.equal(surface.children.length, 3, 'two backdrop layers + the tint layer')
  const first = writes
  theme.set(null)
  assert.equal(writes, first, 'unchanged input: nothing written')
  const bd = { dark: { url: 'data:image/png;base64,AAAA', lumMin: 0.01, lumMax: 0.05 }, light: { url: 'data:image/png;base64,BBBB', lumMin: 0.5, lumMax: 0.8 } }
  theme.set({ palette: { accent: '#2050ff' }, glass: true, backdrop: bd })
  assert.ok(surface.classList.contains('glass-on'))
  const [a, b] = surface.children
  assert.ok(a.classList.contains('on') || b.classList.contains('on'))
  assert.match(String(a.style.backgroundImage || b.style.backgroundImage), /AAAA/)
  // a new track: the other layer takes the new art and fades in, the old one fades out
  theme.set({ palette: { accent: '#2050ff' }, glass: true, backdrop: { dark: { url: 'data:image/png;base64,CCCC', lumMin: 0.01, lumMax: 0.05 }, light: bd.light } })
  assert.equal([a, b].filter((x) => x.classList.contains('on')).length, 1)
  // the scheme changes: the light backdrop
  isDark = false
  listeners['(prefers-color-scheme: dark)']()
  assert.match(String([a, b].find((x) => x.classList.contains('on')).style.backgroundImage), /BBBB/)
  // Glass off: no artwork
  theme.set({ palette: null, glass: false, backdrop: bd })
  assert.ok(!surface.classList.contains('glass-on'))
  assert.equal([a, b].filter((x) => x.classList.contains('on')).length, 0)
})
