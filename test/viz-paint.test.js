// The visualizer's paint (viz-paint.js): its colours come from theme.css's --s-stage-* tokens, and its
// bars' gradients are made once and reused, not per frame (BACKLOG "Visualizer: per-frame gradients").
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')
const P = require('../viz-paint')

const css = fs.readFileSync(path.join(__dirname, '..', 'theme.css'), 'utf8')
const token = (name) => { const m = new RegExp(name.replace(/-/g, '\\-') + ':\\s*([^;]+);').exec(css); return m ? m[1] : '' }

// a 2D context stand-in: counts gradients and records their stops and the fills' transforms
function fakeCtx() {
  const c = { made: 0, fills: [], transform: [1, 0, 0, 1, 0, 0] }
  const grad = (kind, args) => { c.made++; const g = { kind, args, stops: [] }; g.addColorStop = (o, col) => g.stops.push([o, col]); return g }
  c.createLinearGradient = (...a) => grad('linear', a)
  c.createRadialGradient = (...a) => grad('radial', a)
  c.beginPath = () => {}; c.arc = () => {}
  c.setTransform = (...m) => { c.transform = m }
  c.fill = () => c.fills.push({ style: c.fillStyle, transform: c.transform })
  return c
}

test('every stage token is in theme.css and reads back (no missing colour)', () => {
  const s = P.readStage(token)
  assert.deepEqual(s.missing, [])
  for (const name of Object.values(P.TOKENS)) assert.ok(token(name), name)
  assert.equal(s.sky, 'rgba(6,5,12,0.84)')
  assert.deepEqual(s.barTop, { h: 320, s: 90, l: 68, a: 0.98 })
})

test('the look is kept: the bars sweep 320° -> 250° with the same stops as before', () => {
  const s = P.readStage(token)
  const ctx = fakeCtx()
  const n = 48
  const b = P.barGradients(ctx, s, n)
  assert.equal(ctx.made, 2 * n)
  // loop: NOT-WORTH — test: every band
  for (let i = 0; i < n; i++) {
    const hue = 320 - (i / n) * 70   // the pre-token formula
    assert.deepEqual(b.body[i].stops, [[0, `hsla(${hue},90%,68%,0.98)`], [1, `hsla(${hue},85%,45%,0.85)`]])
    assert.deepEqual(b.mirror[i].stops, [[0, `hsla(${hue},85%,55%,0.6)`], [1, 'transparent']])
    assert.deepEqual(b.body[i].args, [0, 0, 0, 1], 'a unit gradient')
  }
})

test('glows keep the look: the same colour as before, at the hue the scene asks for', () => {
  const s = P.readStage(token)
  const ctx = fakeCtx()
  P.glow(ctx, 10, 20, 5, s.nebula, 300 - 0.5 * 60 + 0.25 * 40)
  const g = ctx.fills[0].style
  assert.deepEqual(g.args, [10, 20, 0, 10, 20, 5])
  assert.deepEqual(g.stops, [[0, `hsla(${300 - 0.5 * 60 + 0.25 * 40},88%,66%,0.34)`], [1, 'transparent']])
  P.glow(ctx, 0, 0, 1, s.auroraCore, 300 + 14 + 20)
  assert.equal(ctx.fills[1].style.stops[0][1], 'hsla(334,95%,78%,0.6)')
})

test('parseHsl: comma and space syntax, alpha optional or in %, junk is null', () => {
  assert.deepEqual(P.parseHsl(' hsla(318,92%,70%,0.2)'), { h: 318, s: 92, l: 70, a: 0.2 })
  assert.deepEqual(P.parseHsl('hsl(318 92% 70% / 20%)'), { h: 318, s: 92, l: 70, a: 0.2 })
  assert.deepEqual(P.parseHsl('hsl(10, 50%, 50%)'), { h: 10, s: 50, l: 50, a: 1 })
  assert.equal(P.parseHsl('rgba(0,0,0,1)'), null)
  assert.equal(P.parseHsl(''), null)
})

test('a missing token paints nothing and is reported', () => {
  const s = P.readStage((name) => (name === '--s-stage-sky' || name === '--s-stage-aurora') ? '' : token(name))
  assert.deepEqual(s.missing, ['--s-stage-sky', '--s-stage-aurora'])
  assert.equal(s.sky, 'transparent')
  assert.equal(s.aurora.a, 0)
})

test('visualizer.html paints only through viz-paint: no gradient made in the frame code', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'visualizer.html'), 'utf8')
  assert.doesNotMatch(html, /create(Linear|Radial)Gradient/)
  assert.doesNotMatch(html, /FIX-HOT-PATH/)
})
