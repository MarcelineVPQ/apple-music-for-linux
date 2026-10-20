// How fast the Precise timing helper really is on this computer (0.15.65), from its own job stats: seconds of
// work (separation + emissions + alignment, model loading left out) per second of audio. A processor-only
// helper times first plays after the song (0.15.59, align-session.js slow); a helper on Intel graphics
// through OpenVINO (engine 0.2.6) may do first-play section work like a GPU machine, but only once it has
// shown that a job takes less time than its audio (median of the last jobs < 1). Decided at runtime from
// measurements, never from the card's name: an iGPU's speed depends on the laptop and its power profile.
// No Electron: test/helper-speed.test.js.

const KEEP = 3           // the last jobs that count
const FAST_BELOW = 1.0   // work seconds per audio second: below this the helper keeps up with the music

/** A job's work seconds per audio second from the helper's stats, or null (not an alignment, or stitched: no separation). */
function ratioOf(st) {
  if (!st || typeof st !== 'object') return null
  const dur = Number(st.duration_s)
  if (!(dur >= 5)) return null
  if (Number(st.stitched) > 0) return null          // the final pass from kept stems: no separation, not comparable
  const parts = ['separate_s', 'emissions_s', 'align_s'].map((k) => Number(st[k]))
  if (!parts.every(Number.isFinite)) return null
  return parts.reduce((a, b) => a + b, 0) / dur
}

/**
 * -> { learnPong(pong), record(stats) -> ratio | null, fast() -> bool, gpu() -> bool, state() }
 * Measurements are kept for one helper build and device (the pong's backend + OpenVINO device): another one
 * starts over.
 */
function createHelperSpeed(opts = {}) {
  const log = opts.log || (() => {})
  // cache: OK — key=the helper's backend + device (the pong); invalidated=a pong with another one; bound=KEEP ratios
  let key = ''
  let ratios = []
  let gpu = false
  let last = null       // the last decision logged
  function learnPong(pong) {
    const p = pong || {}
    const ov = p.backend === 'openvino' && p.openvino && typeof p.openvino === 'object' ? p.openvino : null
    const k = String(p.backend || '') + '/' + String(p.device || '') + '/' + (ov ? String(ov.device || '') : '')
    gpu = !!(ov && ov.device === 'GPU')
    if (k !== key) { key = k; ratios = []; last = null }
  }
  function median() {
    if (!ratios.length) return null
    const s = ratios.slice().sort((a, b) => a - b)
    const m = s.length >> 1
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
  }
  function fast() {
    const m = median()
    const yes = gpu && m != null && m < FAST_BELOW
    if (yes !== last && (m != null || last != null)) {
      last = yes
      log('helper speed: ' + (m == null ? 'not measured' : m.toFixed(2) + ' s of work per s of audio (median of ' + ratios.length + ')') +
        (gpu ? ' on Intel graphics' : ' on the processor') + ' → first plays ' + (yes ? 'section by section while they play' : 'timed after the song'))
    }
    return yes
  }
  function record(st) {
    const r = ratioOf(st)
    if (r == null) return null
    ratios.push(r)
    if (ratios.length > KEEP) ratios = ratios.slice(-KEEP)
    fast()
    return r
  }
  return { learnPong, record, fast, gpu: () => gpu, state: () => ({ key, ratios: ratios.slice(), gpu, median: median() }) }
}

module.exports = { createHelperSpeed, ratioOf, KEEP, FAST_BELOW }
