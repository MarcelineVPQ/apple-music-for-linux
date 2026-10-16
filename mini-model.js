// The mini player's pure logic (no DOM, no Electron): the scrubber's seek maths and keys, and the
// KWin blur-behind region for its pill shape. Used by miniplayer.html (require) and main.js.
;(function (root) {
  'use strict'
  const KEY_STEP = 5   // ← / → on the scrubber: 5 s

  // where a pointer at clientX on a bar (left, width) seeks to, in seconds (clamped to the song)
  function seekAt(clientX, left, width, duration) {
    const d = Number(duration) || 0
    const w = Number(width) || 0
    if (d <= 0 || w <= 0) return 0
    const f = Math.min(1, Math.max(0, (Number(clientX) - Number(left)) / w))
    return f * d
  }
  // a key on the focused scrubber -> the new time, or null (not ours)
  function keySeek(key, time, duration) {
    const d = Number(duration) || 0
    if (d <= 0) return null
    const t = Math.min(d, Math.max(0, Number(time) || 0))
    if (key === 'ArrowLeft' || key === 'ArrowDown') return Math.max(0, t - KEY_STEP)
    if (key === 'ArrowRight' || key === 'ArrowUp') return Math.min(d - 0.5, t + KEY_STEP)
    if (key === 'Home') return 0
    return null
  }
  const clock = (s) => {
    const v = Math.max(0, Math.round(Number(s) || 0))
    return Math.floor(v / 60) + ':' + String(v % 60).padStart(2, '0')
  }

  // KWin's _KDE_NET_WM_BLUR_BEHIND_REGION for a pill (a stadium: round ends, radius = half its
  // height) at x,y,w,h (CSS px) in the window, scaled to device pixels: one rect per run of rows with
  // the same inset, so the blur never shows past the rounded ends. -> [x, y, w, h, x, y, w, h, ...]
  function blurRegion(x, y, w, h, scale) {
    const s = Number(scale) > 0 ? Number(scale) : 1
    const X = Math.round(x * s); const Y = Math.round(y * s)
    const W = Math.round(w * s); const H = Math.round(h * s)
    const R = H / 2
    const out = []
    let runStart = 0; let runInset = -1
    // loop: NOT-WORTH — one pass over the pill's rows (≤ ~150 at 2×), once per mini open / setting change
    for (let r = 0; r <= H; r++) {
      let inset = -2
      if (r < H) {
        const dy = r + 0.5 - R
        inset = Math.max(0, Math.ceil(R - Math.sqrt(Math.max(0, R * R - dy * dy)) - 0.25))
      }
      if (inset !== runInset) {
        if (runInset >= 0 && W - 2 * runInset > 0) out.push(X + runInset, Y + runStart, W - 2 * runInset, r - runStart)
        runStart = r
        runInset = inset
      }
    }
    return out
  }

  const api = { KEY_STEP, seekAt, keySeek, clock, blurRegion }
  if (typeof module === 'object' && module.exports) module.exports = api
  else root.SonataMiniModel = Object.freeze(api)
})(typeof globalThis !== 'undefined' ? globalThis : this)
