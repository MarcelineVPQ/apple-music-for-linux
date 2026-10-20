// The Studio's Montage, its pure logic (no DOM, no Electron): the Ken Burns moves, which photo shows
// when, the shade (scrim) each photo needs so every word stays readable, a photo's darkest and
// lightest pixel, and the width to fetch. Used by montage-ui.js (the page), main.js (extremes, width)
// and the tests (test/montage-model.test.js). The look is the approved mock-up
// (docs/mockups/stage-view.html, ken-burns.html, kit/montage.js on branch w2-mockups).
;(function (root) {
  'use strict'
  const T = root.SonataTheme || (typeof require === 'function' ? require('./theme') : null)

  // timing (s): each photo holds HOLD, the next fades in over FADE on top of it; reduced motion holds
  // longer and only cross-fades (no pan, no zoom)
  const HOLD = 11
  const FADE = 2.4
  const CALM_HOLD = 20
  const ZOOM = [1.06, 1.17]
  const DRIFT = 3.2              // % of the photo's box the pan travels
  const INSET = 0.07             // the photo box overhangs the centre column by 7 % each side (mt-photo inset)
  const FPS = 10                 // the pan's frame rate: the drift is ~4 px/s, so 10 writes a second move it in ~0.4 px steps (measured: docs/PERFORMANCE.md)

  // the slot k photo's focus: where the zoom heads (a little above the middle: faces, stages)
  function focus(k) {
    const xs = [0.5, 0.62, 0.38, 0.55, 0.45]
    return [xs[k % xs.length], k % 2 ? 0.45 : 0.4]
  }

  /**
   * The transform of slot k at progress p (0..1 over HOLD + FADE): even slots zoom in toward the
   * focus, odd ones ease back out, so no two moves in a row are the same (kit/montage.js).
   */
  function pose(k, p) {
    const q = Math.min(1, Math.max(0, p))
    const f = focus(k)
    const inward = k % 2 === 0
    const z = inward ? ZOOM[0] + (ZOOM[1] - ZOOM[0]) * q : ZOOM[1] - (ZOOM[1] - ZOOM[0]) * q
    const dx = (0.5 - f[0]) * DRIFT * 2 * (inward ? q : 1 - q) + ((k % 3) - 1) * DRIFT * (q - 0.5)
    const dy = (0.5 - f[1]) * DRIFT * 2 * (inward ? q : 1 - q)
    return { x: +dx.toFixed(3), y: +dy.toFixed(3), scale: +z.toFixed(4) }
  }
  const css = (ps) => 'translate3d(' + ps.x + '%,' + ps.y + '%,0) scale(' + ps.scale + ')'

  /**
   * What shows at montage time t (s, the montage's own clock: it runs only while the music plays) with
   * n photos: { k, cur, prev, local, fading, curOpacity, curPose, prevPose }. cur and prev index the
   * photos; prev is -1 when no fade is running. calm (reduced motion): no poses, the fade is CSS's.
   */
  function frame(t, n, calm) {
    if (!n) return null
    const hold = calm ? CALM_HOLD : HOLD
    const k = Math.max(0, Math.floor(Math.max(0, t) / hold))
    const local = Math.max(0, t) - k * hold
    const cur = k % n
    const fading = n > 1 && k > 0 && local < FADE
    const prev = fading ? (k - 1) % n : -1
    const span = hold + FADE
    return {
      k, cur, prev, local, fading,
      curOpacity: k === 0 || n === 1 ? 1 : Math.min(1, local / FADE),
      curPose: calm ? null : pose(k, (local + FADE) / span),
      prevPose: calm || !fading ? null : pose(k - 1, (hold + local) / span),
      next: calm ? hold - local : 0
    }
  }

  /**
   * The width (CSS px × dpr) a photo must have to cover the centre column at the largest zoom.
   * box: { w, h } of the column; aspect: the photo's width / height (or 1.5 when unknown).
   */
  function needWidth(box, aspect, dpr) {
    const bw = Math.max(1, box.w) * (1 + 2 * INSET)
    const bh = Math.max(1, box.h) * (1 + 2 * INSET)
    const a = aspect > 0 ? aspect : 1.5
    return Math.ceil(Math.max(bw, bh * a) * ZOOM[1] * Math.max(1, dpr || 1))
  }

  /**
   * A photo's darkest and lightest pixel (relative luminance), from its decoded bitmap: every pixel of
   * the size it is shown at, so a word can't land on a lighter or darker spot than the check assumed.
   * bitmap: BGRA bytes (Electron's nativeImage.toBitmap) unless rgba. -> { lo: [r,g,b], hi: [r,g,b] }
   */
  function extremes(bitmap, rgba) {
    const R = rgba ? 0 : 2
    const B = rgba ? 2 : 0
    let lo = null; let hi = null; let lmin = 2; let lmax = -1
    // a luminance table per channel value (the photo has ~1-2 M pixels: no pow per pixel)
    const lin = new Float64Array(256)
    // loop: NOT-WORTH — 256 entries, once per photo
    for (let v = 0; v < 256; v++) { const c = v / 255; lin[v] = c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4) }
    // loop: HOT-PATH-OK — one pass over the shown photo's pixels (≤ ~2.5 M), once per photo download, in main
    for (let i = 0; i + 3 < bitmap.length; i += 4) {
      const r = bitmap[i + R]; const g = bitmap[i + 1]; const b = bitmap[i + B]
      const L = 0.2126 * lin[r] + 0.7152 * lin[g] + 0.0722 * lin[b]
      if (L < lmin) { lmin = L; lo = [r, g, b] }
      if (L > lmax) { lmax = L; hi = [r, g, b] }
    }
    return lo ? { lo, hi } : null
  }

  // the words over the montage and the contrast each needs (theme.js tokens): the sung line, the plain
  // text and the words still to come 4.5:1; the quiet lines 3:1 (as everywhere in Sonata)
  const NEEDS = [['--s-text', 4.5], ['--s-soft', 4.5], ['--s-upcoming', 4.5], ['--s-accent-text', 4.5], ['--s-accent-2-text', 4.5], ['--s-accent-mix-text', 4.5], ['--s-dim', 3]]
  const rgbOf = (s) => { const m = /rgba?\(([^)]+)\)/.exec(String(s || '')); return m ? m[1].split(',').slice(0, 3).map(Number) : null }
  const SCRIM_MIN = 0.6
  const SCRIM_MAX = 0.98

  /**
   * The least shade (the theme's surface colour over the photo, as an alpha) at which every word
   * reaches its contrast over the photo's darkest and lightest pixel; starts at the mock-up's 0.6 and
   * is raised in 0.02 steps. tokens: the page's --s-* values (theme-apply tokens()); photo: { lo, hi }.
   * -> { alpha, worst: { token: ratio }, ok }
   */
  function scrimFor(tokens, photo) {
    const surface = rgbOf(tokens['--s-surface'])
    const bds = photo && photo.lo && photo.hi ? [photo.lo, photo.hi] : [[0, 0, 0], [255, 255, 255]]
    // loop: NOT-WORTH — 7 tokens, once per photo and theme (montage-ui shadeOf caches it by photo id)
    const words = NEEDS.map(([k, need]) => [k, rgbOf(tokens[k]), need]).filter((w) => w[1])
    const worst = (a) => {
      const out = {}
      // loop: NOT-WORTH — ≤ 7 tokens × 2 extremes per step, ≤ 20 steps, once per photo and theme change
      for (const [k, c] of words) out[k] = T.worstContrast(c, [[surface, a]], bds)
      return out
    }
    // loop: NOT-WORTH — ≤ 7 tokens × ≤ 20 steps, once per photo and theme (cached by shadeOf), not per frame
    const pass = (r) => words.every(([k, , need]) => r[k] >= need)
    if (!surface || !words.length) return { alpha: SCRIM_MAX, worst: {}, ok: false }
    let a = SCRIM_MIN
    let r = worst(a)
    // loop: NOT-WORTH — at most 19 steps of 0.02
    while (a < SCRIM_MAX && !pass(r)) { a = Math.min(SCRIM_MAX, +(a + 0.02).toFixed(2)); r = worst(a) }
    Object.keys(r).forEach((k) => { r[k] = +r[k].toFixed(2) })   // loop: NOT-WORTH — ≤ 7 tokens
    return { alpha: a, worst: r, ok: pass(r) }
  }

  const api = { HOLD, FADE, CALM_HOLD, ZOOM, DRIFT, INSET, FPS, NEEDS, SCRIM_MIN, SCRIM_MAX, focus, pose, css, frame, needWidth, extremes, scrimFor }
  if (typeof module === 'object' && module.exports) module.exports = api
  else root.SonataMontage = Object.freeze(api)
})(typeof globalThis !== 'undefined' ? globalThis : this)
