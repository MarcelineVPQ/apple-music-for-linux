// Mouse wheel → volume steps (pure): 5 % per wheel notch, up = louder. A trackpad sends many small
// deltas; they add up to whole notches instead of each one stepping. Used by the mini player's volume
// slider and speaker button (miniplayer.html) and over Apple's own volume control (apple-focus.js,
// through main). Loaded with require() or as a plain script (SonataWheelVolume).
;(function (root) {
  'use strict'
  const STEP = 0.05          // 5 % per notch
  const NOTCH_PX = 100       // Chromium's wheel delta per notch on Linux (pixel mode); Windows/mac similar
  const LINES_PER_NOTCH = 3
  const RESET_MS = 600       // a pause this long drops a half-finished notch

  // -> { feed(deltaY, deltaMode, now) -> whole notches (+ louder, - quieter), reset() }
  function createWheelSteps() {
    let acc = 0
    let last = -Infinity
    return {
      feed(deltaY, deltaMode, now) {
        const d = Number(deltaY) || 0
        if (!d) return 0
        const t = Number(now) || 0
        // a long pause, or a turn the other way, starts a new notch
        if (t - last > RESET_MS || (acc && Math.sign(acc) !== Math.sign(-d))) acc = 0
        last = t
        const notches = deltaMode === 2 ? -d : deltaMode === 1 ? -d / LINES_PER_NOTCH : -d / NOTCH_PX
        acc += notches
        const whole = acc > 0 ? Math.floor(acc + 1e-9) : Math.ceil(acc - 1e-9)
        acc -= whole
        return whole || 0   // never -0
      },
      reset() { acc = 0; last = -Infinity }
    }
  }

  // the new volume (0..1) after `steps` notches from `volume`, on the 5 % grid
  function stepVolume(volume, steps) {
    const v = Math.min(1, Math.max(0, Number(volume) || 0))
    const grid = Math.round(v / STEP)
    return Math.min(1, Math.max(0, (grid + (steps | 0)) * STEP))
  }
  const percent = (v) => Math.round(Math.min(1, Math.max(0, Number(v) || 0)) * 100)

  const api = { STEP, NOTCH_PX, LINES_PER_NOTCH, RESET_MS, createWheelSteps, stepVolume, percent }
  if (typeof module === 'object' && module.exports) module.exports = api
  else root.SonataWheelVolume = Object.freeze(api)
})(typeof globalThis !== 'undefined' ? globalThis : this)
