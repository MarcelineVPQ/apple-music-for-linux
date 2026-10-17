// The visualizer's paint: the stage colours from the theme (theme.css's fixed --s-stage-* tokens: the
// night stage is art, the same in every theme), the bars' cached gradients and the glows.
//
// The bars' gradients are UNIT gradients (y 0 to 1), made once per band count. The caller builds the
// bar's path in canvas pixels as before, then sets a transform that maps the unit gradient onto it and
// fills: a canvas maps the fill style through the transform at fill time, while the path keeps the
// coordinates it was built with. So one gradient serves every bar height and every window size: nothing
// is rebuilt on a resize, only when the colours (tokens) or the band count change.
'use strict'

// 'hsla(320,90%,68%,0.98)' / 'hsl(320 90% 68% / 0.98)' -> { h, s, l, a }, or null (not an HSL colour)
function parseHsl(str) {
  const m = /^\s*hsla?\(\s*(-?[\d.]+)(?:deg)?[\s,]+([\d.]+)%[\s,]+([\d.]+)%(?:[\s,/]+([\d.]+)(%?))?\s*\)\s*$/.exec(String(str || ''))
  if (!m) return null
  const a = m[4] === undefined ? 1 : Number(m[4]) / (m[5] ? 100 : 1)
  return { h: Number(m[1]), s: Number(m[2]), l: Number(m[3]), a }
}

// the CSS for a stage colour at another hue (the scenes sweep and shift hue around their token)
function hsla(c, h) { return 'hsla(' + h + ',' + c.s + '%,' + c.l + '%,' + c.a + ')' }

// the tokens each scene paints with; get(name) reads one custom property (getComputedStyle)
const TOKENS = {
  trail: '--s-stage-trail', trailShort: '--s-stage-trail-short', sky: '--s-stage-sky',
  barTop: '--s-stage-bar-top', barTopEnd: '--s-stage-bar-top-end',
  barBase: '--s-stage-bar-base', barBaseEnd: '--s-stage-bar-base-end',
  barMirror: '--s-stage-bar-mirror', barMirrorEnd: '--s-stage-bar-mirror-end',
  aurora: '--s-stage-aurora', auroraCore: '--s-stage-aurora-core',
  nebula: '--s-stage-nebula', nebulaCore: '--s-stage-nebula-core'
}
const PLAIN = ['trail', 'trailShort', 'sky']   // used as they are (fills); the rest are HSL, for hue sweeps

// -> { trail: 'rgba(…)', …, barTop: { h, s, l, a }, … }. A missing or unreadable token paints nothing
// (a plain one: 'transparent'; an HSL one: alpha 0) and is listed in `missing`.
function readStage(get) {
  const out = { missing: [] }
  // loop: NOT-WORTH — 13 tokens, once per page load
  for (const [key, name] of Object.entries(TOKENS)) {
    const raw = String(get(name) || '').trim()
    if (PLAIN.includes(key)) {
      out[key] = raw || 'transparent'
      if (!raw) out.missing.push(name)
      continue
    }
    const c = parseHsl(raw)
    if (!c) out.missing.push(name)
    out[key] = c || { h: 0, s: 0, l: 0, a: 0 }
  }
  return out
}

const lerp = (a, b, t) => a + (b - a) * t

// The bars' gradients: per band, the bar (top colour to base colour) and its mirror (to transparent),
// swept from the *-end-less token at band 0 toward the *-end token. Built once per band count.
// ctx: the 2D context (createLinearGradient). Returns { n, body: [], mirror: [] }.
function barGradients(ctx, stage, n) {
  const body = [], mirror = []
  const at = (from, to, t) => ({ s: lerp(from.s, to.s, t), l: lerp(from.l, to.l, t), a: lerp(from.a, to.a, t), h: from.h + (to.h - from.h) * t })
  // loop: NOT-WORTH — once per band count (n ≈ 48), not per frame: 2 gradients per band
  for (let i = 0; i < n; i++) {
    const t = i / n
    const top = at(stage.barTop, stage.barTopEnd, t), base = at(stage.barBase, stage.barBaseEnd, t), mir = at(stage.barMirror, stage.barMirrorEnd, t)
    const g = ctx.createLinearGradient(0, 0, 0, 1)
    g.addColorStop(0, hsla(top, top.h)); g.addColorStop(1, hsla(base, base.h))
    const m = ctx.createLinearGradient(0, 0, 0, 1)
    m.addColorStop(0, hsla(mir, mir.h)); m.addColorStop(1, 'transparent')
    body.push(g); mirror.push(m)
  }
  return { n, body, mirror }
}

// The glows (aurora, nebula): a soft round light at (x, y), one radial gradient per fill, as before.
// Measured (docs/PERFORMANCE.md, "Visualizer paint"): caching them per hue and mapping a unit gradient
// with the transform made each frame dearer to rasterise (nebula 51 -> 26 frames/s under software GL)
// while saving little script time, so the glows keep their per-fill gradient; only the colour moved to
// the theme tokens. c: a stage colour ({ h, s, l, a }), hue: the hue to draw it at.
function glow(ctx, x, y, radius, c, hue) {
  const g = ctx.createRadialGradient(x, y, 0, x, y, radius)
  g.addColorStop(0, hsla(c, hue)); g.addColorStop(1, 'transparent')
  ctx.fillStyle = g
  ctx.beginPath(); ctx.arc(x, y, radius, 0, Math.PI * 2); ctx.fill()
}

module.exports = { parseHsl, hsla, readStage, barGradients, glow, TOKENS }
