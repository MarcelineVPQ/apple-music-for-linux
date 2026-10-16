// Sonata's one theme system (pure: no DOM, no Electron). Every Sonata-owned window (the rail, the
// side panel, toasts, the lyrics window, the mini player, the visualizer's chrome) takes its colours
// from the tokens computed here, as --s-* CSS custom properties. theme.css holds the same tokens'
// first-paint defaults (light and dark, no album colour) and the Glass material; nothing else in
// Sonata's CSS writes a literal colour (test/theme.test.js checks).
//
// Inputs: light or dark, the album palette (palette.js: accent, bg) or none, and the Glass look.
// Glass (Settings → Appearance, on by default): a separate view can't blur Apple's page behind it,
// so each surface draws its own backdrop, a blurred, saturated copy of the album artwork (made once
// per track change in the main process: makeBackdrop below), under the album tint, a specular edge
// and a fine noise. The backdrop's lightness is squeezed into a band (dark: deep, light: pale), so
// the tint over it can stay translucent and the words still reach 4.5:1 over its darkest and
// lightest pixel; the alpha is raised (never lowered) until they do.
// Used by main.js (makeBackdrop), theme-apply.js in every page, rail-model.js and the UI checker.
;(function (root) {
  'use strict'

  // --- colour maths ---
  const hexRgb = (h) => {
    const m = /^#?([0-9a-f]{6})$/i.exec(String(h || ''))
    if (!m) return null
    const n = parseInt(m[1], 16)
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
  }
  const mix = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t)
  const lin = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4) }
  const lum = (rgb) => 0.2126 * lin(rgb[0]) + 0.7152 * lin(rgb[1]) + 0.0722 * lin(rgb[2])
  function contrast(a, b) {
    const la = lum(a); const lb = lum(b)
    return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05)
  }
  // translucent layers ([rgb, alpha], bottom first) over a backdrop colour
  const stack = (backdrop, layers) => layers.reduce((acc, l) => acc.map((v, i) => l[0][i] * l[1] + v * (1 - l[1])), backdrop)
  const WHITE = [255, 255, 255]
  const BLACK = [0, 0, 0]
  // the grey whose relative luminance is L (to stand in for a backdrop's darkest / lightest pixel)
  const greyOf = (L) => {
    const c = L <= 0.03928 / 12.92 ? L * 12.92 : 1.055 * Math.pow(Math.max(0, L), 1 / 2.4) - 0.055
    const v = Math.round(Math.max(0, Math.min(1, c)) * 255)
    return [v, v, v]
  }
  // the lowest contrast `text` reaches on these layers over any of the backdrops (default: anything,
  // whose extremes are white and black)
  function worstContrast(text, layers, backdrops) {
    // loop: NOT-WORTH — 2 backdrops (the extremes)
    return Math.min(...(backdrops || [WHITE, BLACK]).map((b) => contrast(text, stack(b, layers))))
  }
  const css = (rgb, a) => 'rgba(' + rgb.map((v) => Math.round(v)).join(',') + ',' + (a === undefined ? 1 : +a.toFixed(3)) + ')'

  // --- the base palette (the only literal colours in Sonata's own UI, with theme.css's first-paint copy) ---
  const BASE = {
    dark: { surface: [30, 30, 34], text: [245, 245, 247], soft: 0.18, tint: 0.16, overPage: 0.9, glass: 0.42, ok: [31, 143, 78], warn: [242, 179, 61], error: [255, 150, 140] },
    light: { surface: [248, 248, 250], text: [29, 29, 31], soft: 0.20, tint: 0.10, overPage: 0.9, glass: 0.5, ok: [24, 128, 68], warn: [242, 179, 61], error: [150, 16, 28] }
  }
  // Apple Music's red, when there's no album colour (the rail had it; the mini player and Settings
  // had near copies, now this one)
  const DEFAULT_ACCENT = [250, 45, 72]
  const TARGET = 4.5

  // -> { vars: {--s-*: css}, contrast: {...}, alpha: {...} }
  // opts: dark, palette ({ accent } or null), glass (bool), backdrop ({ lumMin, lumMax } of the
  // current artwork backdrop, or null: no artwork yet -> a plain surface even with Glass on)
  function themeTokens(opts) {
    const o = opts || {}
    const dark = !!o.dark
    const b = dark ? BASE.dark : BASE.light
    const palette = o.palette || null
    const accent = (palette && hexRgb(palette.accent)) || DEFAULT_ACCENT
    const surface = mix(b.surface, accent, b.tint)
    // the words: whichever of the two text colours reads better on THIS surface (never the colour
    // scheme alone: a dark tint gets light words even if the scheme says light, and the reverse)
    const text = contrast(BASE.dark.text, surface) >= contrast(BASE.light.text, surface) ? BASE.dark.text : BASE.light.text
    const soft = mix(text, surface, b.soft)   // secondary words: text mixed toward the surface
    // over Apple's page (the rail open over it): nearly opaque, raised until labels reach 4.5:1 over anything
    let over = b.overPage
    const overLayers = () => [[surface, over]]
    // loop: NOT-WORTH — at most 5 steps of 0.02
    while (over < 0.98 && (worstContrast(text, overLayers()) < TARGET || worstContrast(soft, overLayers()) < TARGET)) over += 0.02
    // over the desktop blurred by the compositor (KWin blur-behind, the mini player): as translucent as
    // the words allow over anything (the blur's result can be any colour)
    let blurA = dark ? 0.62 : 0.56
    const blurLayers = () => [[surface, blurA]]
    // loop: NOT-WORTH — at most ~20 steps of 0.02
    while (blurA < 0.98 && (worstContrast(text, blurLayers()) < TARGET + 0.1 || worstContrast(soft, blurLayers()) < TARGET + 0.1)) blurA += 0.02
    // the panel / card material: Glass over the artwork backdrop, else solid
    const bd = o.glass && o.backdrop && Number.isFinite(o.backdrop.lumMin) && Number.isFinite(o.backdrop.lumMax)
      ? [greyOf(o.backdrop.lumMin), greyOf(o.backdrop.lumMax)] : null
    let glassA = bd ? b.glass : 1
    const matLayers = () => [[surface, glassA]]
    // a small margin over 4.5: the backdrop's own colour (hue) shifts the mix a little
    // loop: NOT-WORTH — at most ~30 steps of 0.02
    while (bd && glassA < 0.98 && (worstContrast(text, matLayers(), bd) < TARGET + 0.15 || worstContrast(soft, matLayers(), bd) < TARGET + 0.15)) glassA += 0.02
    const matBackdrops = bd || [WHITE, BLACK]
    // active row / pressed control: an accent layer, as strong as the words on it allow
    let activeA = dark ? 0.34 : 0.22
    // loop: NOT-WORTH — at most ~15 steps
    while (activeA > 0.04 && worstContrast(text, matLayers().concat([[accent, activeA]]), matBackdrops) < TARGET) activeA -= 0.02
    // over Apple's page, the same check (the rail's active row)
    // loop: NOT-WORTH — at most ~15 steps
    while (activeA > 0.04 && worstContrast(text, overLayers().concat([[accent, activeA]])) < TARGET) activeA -= 0.02
    const hoverA = dark ? 0.10 : 0.07
    // the focus ring, the active bar, switches and links: the accent pushed toward the text until 3:1 (non-text)
    let ring = accent
    // loop: NOT-WORTH — at most 20 steps
    for (let i = 0; i < 20 && Math.min(worstContrast(ring, overLayers()), worstContrast(ring, matLayers(), matBackdrops)) < 3; i++) ring = mix(ring, text, 0.12)
    // the album accent as words (the sung lyric line): pushed toward the text colour until 4.5:1 on
    // the card (plain or Glass) over anything
    let accentText = accent
    const accentOk = (c) => Math.min(worstContrast(c, overLayers()), worstContrast(c, matLayers(), matBackdrops)) >= TARGET + 0.15
    // loop: NOT-WORTH — at most 25 steps
    for (let i = 0; i < 25 && !accentOk(accentText); i++) accentText = mix(accentText, text, 0.08)
    // dim words (lyric lines not being sung): the text, faded only as far as 3:1 allows
    let dimA = 0.35
    const dimOk = (a) => Math.min(worstContrast(mix(surface, text, a), overLayers()), worstContrast(mix(surface, text, a), matLayers(), matBackdrops)) >= 3
    // loop: NOT-WORTH — at most ~30 steps
    while (dimA < 1 && !dimOk(dimA)) dimA += 0.02
    const dim = mix(surface, text, dimA)
    // a button filled with the accent: white words on it, the fill darkened until 4.5:1 (or black
    // words on a lightened fill, for a pale accent, whichever moves the colour less)
    const fitFill = (words, toward) => {
      let f = accent; let n = 0
      // loop: NOT-WORTH — at most 20 steps
      for (; n < 20 && contrast(words, f) < TARGET; n++) f = mix(f, toward, 0.08)
      return { f, n }
    }
    const onWhite = fitFill(WHITE, BLACK)
    const onBlack = fitFill(BLACK, WHITE)
    const onBtn = onWhite.n <= onBlack.n + 2 ? WHITE : BLACK
    const fill = onBtn === WHITE ? onWhite.f : onBlack.f
    // notices: a warm (task/info) or red (error) wash over the material, words in the text colour
    const warnWash = [b.warn, dark ? 0.16 : 0.22]
    const errWash = [b.error, dark ? 0.18 : 0.12]
    const errText = b.error
    const vars = {
      '--s-accent': css(accent),
      '--s-surface': css(surface),
      '--s-over-page': css(surface, over),
      '--s-blur-tint': css(surface, blurA),
      '--s-material': css(surface, glassA),
      '--s-text': css(text),
      '--s-soft': css(soft),
      '--s-accent-text': css(accentText),
      '--s-dim': css(dim),
      '--s-active': css(accent, activeA),
      '--s-hover': css(text, hoverA),
      '--s-ring': css(ring),
      '--s-fill': css(fill),
      '--s-on-fill': css(onBtn),
      '--s-field': css(text, dark ? 0.08 : 0.06),
      '--s-track': css(text, dark ? 0.22 : 0.24),
      '--s-knob': css(WHITE),
      '--s-edge': dark ? 'rgba(255,255,255,0.14)' : 'rgba(0,0,0,0.12)',
      '--s-specular': dark ? 'rgba(255,255,255,0.10)' : 'rgba(255,255,255,0.55)',
      '--s-shadow': dark ? 'rgba(0,0,0,0.45)' : 'rgba(0,0,0,0.18)',
      '--s-ok': css(b.ok),
      '--s-on-ok': css(WHITE),
      '--s-warn': css(b.warn),
      '--s-on-warn': css([29, 29, 31]),
      '--s-error-text': css(errText),
      '--s-notice': css(warnWash[0], warnWash[1]),
      '--s-notice-bd': css(b.warn, dark ? 0.45 : 0.6),
      '--s-notice-error': css(errWash[0], errWash[1]),
      '--s-notice-error-bd': css(b.error, 0.55),
      '--s-glass-on': bd ? '1' : '0'
    }
    const matPlusRow = (layer) => matLayers().concat(layer ? [layer] : [])
    return {
      vars,
      alpha: { overPage: over, material: glassA, active: activeA, blur: blurA },
      contrast: {
        label: worstContrast(text, overLayers()),
        blurLabel: worstContrast(text, blurLayers()),
        blurSoft: worstContrast(soft, blurLayers()),
        soft: worstContrast(soft, overLayers()),
        materialLabel: worstContrast(text, matLayers(), matBackdrops),
        materialSoft: worstContrast(soft, matLayers(), matBackdrops),
        active: Math.min(worstContrast(text, overLayers().concat([[accent, activeA]])), worstContrast(text, matPlusRow([accent, activeA]), matBackdrops)),
        hover: worstContrast(text, matPlusRow([text, hoverA]), matBackdrops),
        notice: worstContrast(text, matPlusRow(warnWash), matBackdrops),
        noticeError: worstContrast(text, matPlusRow(errWash), matBackdrops),
        errorText: worstContrast(errText, matLayers(), matBackdrops),
        ring: Math.min(worstContrast(ring, overLayers()), worstContrast(ring, matLayers(), matBackdrops)),
        accentText: Math.min(worstContrast(accentText, overLayers()), worstContrast(accentText, matLayers(), matBackdrops)),
        dim: Math.min(worstContrast(dim, overLayers()), worstContrast(dim, matLayers(), matBackdrops)),
        fill: contrast(onBtn, fill)
      }
    }
  }

  // --- the Glass backdrop: the album artwork, blurred, saturated, its lightness squeezed into a band ---
  // pixels: a small bitmap (main.js: the artwork resized to 40×40), 4 bytes per pixel, BGRA (Electron's
  // nativeImage) unless opts.rgba. -> { data (BGRA, same size), width, height, lumMin, lumMax }
  // Runs once per track change and theme (dark / light), in the main process.
  // loop: HOT-PATH-OK — 40×40 = 1,600 pixels × (1 colour pass + 3 blur passes × 2 axes + 1 band pass) once per track
  const BAND = { dark: [0.05, 0.30], light: [0.74, 0.95] }   // HSL lightness range of the backdrop
  function rgbToHsl(r, g, b) {
    r /= 255; g /= 255; b /= 255
    const max = Math.max(r, g, b); const min = Math.min(r, g, b)
    let h = 0; let s = 0; const l = (max + min) / 2
    if (max !== min) {
      const d = max - min
      s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
      if (max === r) h = (g - b) / d + (g < b ? 6 : 0)
      else if (max === g) h = (b - r) / d + 2
      else h = (r - g) / d + 4
      h /= 6
    }
    return [h, s, l]
  }
  function hslToRgb(h, s, l) {
    if (s === 0) return [l * 255, l * 255, l * 255]
    const f = (p, q, t) => {
      if (t < 0) t += 1
      if (t > 1) t -= 1
      if (t < 1 / 6) return p + (q - p) * 6 * t
      if (t < 1 / 2) return q
      if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6
      return p
    }
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s
    const p = 2 * l - q
    return [f(p, q, h + 1 / 3) * 255, f(p, q, h) * 255, f(p, q, h - 1 / 3) * 255]
  }
  // loop: HOT-PATH-OK — (2r+1) × 1,600 pixels per axis, 3 passes, once per track change (~1-3 ms)
  function boxBlur(src, w, h, r) {
    // one horizontal + one vertical pass of a box of radius r (edges clamped), 3 channels in a Float32Array
    const tmp = new Float32Array(src.length)
    const out = new Float32Array(src.length)
    const n = 2 * r + 1
    // loop: HOT-PATH-OK — the horizontal pass (see boxBlur's verdict)
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let s0 = 0; let s1 = 0; let s2 = 0
        for (let k = -r; k <= r; k++) {
          const i = (y * w + Math.min(w - 1, Math.max(0, x + k))) * 3
          s0 += src[i]; s1 += src[i + 1]; s2 += src[i + 2]
        }
        const o = (y * w + x) * 3
        tmp[o] = s0 / n; tmp[o + 1] = s1 / n; tmp[o + 2] = s2 / n
      }
    }
    // loop: HOT-PATH-OK — the vertical pass (see boxBlur's verdict)
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let s0 = 0; let s1 = 0; let s2 = 0
        for (let k = -r; k <= r; k++) {
          const i = (Math.min(h - 1, Math.max(0, y + k)) * w + x) * 3
          s0 += tmp[i]; s1 += tmp[i + 1]; s2 += tmp[i + 2]
        }
        const o = (y * w + x) * 3
        out[o] = s0 / n; out[o + 1] = s1 / n; out[o + 2] = s2 / n
      }
    }
    return out
  }
  function makeBackdrop(pixels, width, height, opts) {
    const o = opts || {}
    const w = width | 0; const h = height | 0
    if (!pixels || w <= 0 || h <= 0 || pixels.length < w * h * 4) return null
    const R = o.rgba ? 0 : 2; const B = o.rgba ? 2 : 0
    let px = new Float32Array(w * h * 3)
    // loop: HOT-PATH-OK — 1,600 pixels, once per track change
    for (let i = 0; i < w * h; i++) {
      // saturate (Apple's now-playing backdrops are vivid): HSL saturation × 1.5
      const [hh, s, l] = rgbToHsl(pixels[i * 4 + R], pixels[i * 4 + 1], pixels[i * 4 + B])
      const c = hslToRgb(hh, Math.min(1, s * 1.5), l)
      px[i * 3] = c[0]; px[i * 3 + 1] = c[1]; px[i * 3 + 2] = c[2]
    }
    const radius = Math.max(1, Math.round(Math.min(w, h) / 10))
    // loop: NOT-WORTH — 3 passes
    for (let p = 0; p < 3; p++) px = boxBlur(px, w, h, radius)   // 3 box passes ~ a Gaussian
    const band = o.dark ? BAND.dark : BAND.light
    const data = new Uint8ClampedArray(w * h * 4)
    let lumMin = 1; let lumMax = 0
    // loop: HOT-PATH-OK — 1,600 pixels, once per track change
    for (let i = 0; i < w * h; i++) {
      const [hh, s, l] = rgbToHsl(px[i * 3], px[i * 3 + 1], px[i * 3 + 2])
      const c = hslToRgb(hh, Math.min(1, s), band[0] + l * (band[1] - band[0])).map((v) => Math.round(Math.max(0, Math.min(255, v))))
      const L = lum(c)
      if (L < lumMin) lumMin = L
      if (L > lumMax) lumMax = L
      data[i * 4 + R] = c[0]; data[i * 4 + 1] = c[1]; data[i * 4 + B] = c[2]; data[i * 4 + 3] = 255
    }
    return { data, width: w, height: h, lumMin, lumMax }
  }

  const api = { BASE, DEFAULT_ACCENT, BAND, hexRgb, mix, lum, contrast, worstContrast, greyOf, stack, themeTokens, makeBackdrop }
  if (typeof module === 'object' && module.exports) module.exports = api
  else root.SonataTheme = Object.freeze(api)
})(typeof globalThis !== 'undefined' ? globalThis : this)
