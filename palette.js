// Extract an accent + tinted-background palette from album-art pixels.
// Runs in the main process (nativeImage bitmaps are BGRA), so there's no
// cross-origin canvas tainting to worry about. No dependencies.

function rgbToHsl(r, g, b) {
  r /= 255; g /= 255; b /= 255
  const max = Math.max(r, g, b), min = Math.min(r, g, b)
  let h = 0, s = 0, l = (max + min) / 2
  if (max !== min) {
    const d = max - min
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
    if (max === r) h = (g - b) / d + (g < b ? 6 : 0)
    else if (max === g) h = (b - r) / d + 2
    else h = (r - g) / d + 4
    h /= 6
  }
  return { h: h * 360, s, l }
}

function hslToRgb(h, s, l) {
  h /= 360
  const hue2rgb = (p, q, t) => {
    if (t < 0) t += 1; if (t > 1) t -= 1
    if (t < 1 / 6) return p + (q - p) * 6 * t
    if (t < 1 / 2) return q
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6
    return p
  }
  let r, g, b
  if (s === 0) { r = g = b = l }
  else {
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s
    const p = 2 * l - q
    r = hue2rgb(p, q, h + 1 / 3); g = hue2rgb(p, q, h); b = hue2rgb(p, q, h - 1 / 3)
  }
  return [r * 255, g * 255, b * 255]
}

// loop: NOT-WORTH — 3 channels, a few colours per palette, once per track change (not per poll tick)
const toHex = (rgb) => '#' + rgb.map(v => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('')

const FALLBACK = { accent: '#e0219a', bg: '#241019', bg2: '#33172440'.slice(0, 7) }

// data: raw pixel buffer. opts.bgra reads B,G,R order (Electron nativeImage).
// lifetime: NOT-WORTH — pure function over a 32×32 bitmap (4 KB) once per track change; keeps nothing
function extractPalette(data, opts) {
  const bgra = opts && opts.bgra
  const bins = new Float64Array(36)
  const br = new Float64Array(36), bgc = new Float64Array(36), bb = new Float64Array(36)
  const bn = new Uint32Array(36)
  const pixels = data.length / 4
  const step = 4 * Math.max(1, Math.floor(pixels / 4096))   // sample up to ~4096 px
  // loop: NOT-WORTH — 1,024 pixels (32×32), once per track change
  for (let i = 0; i + 3 < data.length; i += step) {
    const r = data[i + (bgra ? 2 : 0)], g = data[i + 1], b = data[i + (bgra ? 0 : 2)], a = data[i + 3]
    if (a < 200) continue
    const { h, s, l } = rgbToHsl(r, g, b)
    if (s < 0.18 || l < 0.12 || l > 0.9) continue        // ignore grays / extremes
    const w = s * s * (1 - Math.abs(l - 0.55) * 1.3)      // favour vibrant mid-tones
    if (w <= 0) continue
    const k = Math.min(35, Math.floor(h / 10))
    bins[k] += w; br[k] += r; bgc[k] += g; bb[k] += b; bn[k]++
  }
  let peak = -1, pw = 0
  // loop: NOT-WORTH — 36 hue bins, once per track
  for (let i = 0; i < 36; i++) if (bins[i] > pw) { pw = bins[i]; peak = i }
  if (peak < 0 || bn[peak] === 0) return withSecond({ ...FALLBACK }, null)
  const accent = [br[peak] / bn[peak], bgc[peak] / bn[peak], bb[peak] / bn[peak]]
  const a = rgbToHsl(accent[0], accent[1], accent[2])
  // the second voice (duets, 0.15.33): the strongest other vibrant hue at least MIN_HUE_GAP away,
  // when the art has one worth taking (≥ 12 % of the main hue's weight); else a fixed turn of the wheel
  let second = -1, sw = 0
  // loop: NOT-WORTH — 36 hue bins, once per track
  for (let i = 0; i < 36; i++) {
    if (bn[i] === 0 || bins[i] < pw * 0.12) continue
    const d = Math.abs(i - peak) * 10
    if (Math.min(d, 360 - d) < MIN_HUE_GAP) continue
    if (bins[i] > sw) { sw = bins[i]; second = i }
  }
  const s2 = second >= 0 ? rgbToHsl(br[second] / bn[second], bgc[second] / bn[second], bb[second] / bn[second]) : null
  return withSecond({
    accent: toHex(hslToRgb(a.h, Math.min(0.95, Math.max(0.58, a.s)), Math.min(0.68, Math.max(0.52, a.l)))),
    bg: toHex(hslToRgb(a.h, 0.34, 0.11)),      // dark, album-tinted surface
    bg2: toHex(hslToRgb(a.h, 0.30, 0.16)),
    hue: a.h
  }, s2)
}

// The duet's second accent: from the art (s2: its HSL) or, when the art has no second hue (one
// colour, or black and white), the main accent's hue turned by FALLBACK_TURN. Always at least
// MIN_HUE_GAP from the main hue, with the same vividness clamps as the main accent.
const MIN_HUE_GAP = 60
const FALLBACK_TURN = 210
function withSecond(p, s2) {
  const h1 = typeof p.hue === 'number' ? p.hue : rgbToHsl(...hexRgb(p.accent)).h
  const h2 = s2 ? s2.h : (h1 + FALLBACK_TURN) % 360
  const sat = s2 ? Math.min(0.95, Math.max(0.58, s2.s)) : 0.75
  const lit = s2 ? Math.min(0.68, Math.max(0.52, s2.l)) : 0.6
  return Object.assign(p, { accent2: toHex(hslToRgb(h2, sat, lit)), hue2: h2 })
}
const hexRgb = (h) => { const n = parseInt(String(h).slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255] }
const hueGap = (a, b) => { const d = Math.abs(a - b) % 360; return Math.min(d, 360 - d) }

module.exports = { extractPalette, rgbToHsl, hslToRgb, hueGap, MIN_HUE_GAP }
