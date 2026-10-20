// The player's precise time (0.15.85). Apple's MusicKit gives the song's time in whole seconds (floored); the
// playing audio element's currentTime is precise but need not be the song's time: Marcy's song reports 2026-10-20
// ran on whole seconds after most song changes ("Brother", "No Excuses", "Sludge Factory", "Down In a Hole"), the
// page's element read then disagreeing with MusicKit by more than the 1.5 s it was allowed (its own timeline, e.g.
// the queue's, or another element). Each element's offset from the song time is learned instead: MusicKit's whole
// second v is never after the song's time, so offset <= el - v on every read, and the reads of the 470 ms tick land
// all over the second, so the smallest el - v is the offset to within a few tens of ms after a few seconds. Once an
// element's estimate has seen enough of the second (LOCK_READS reads, LOCK_SPREAD of phase), el - offset is the
// precise song time. Both sides bound it: offset <= the smallest el - v, and offset > the largest el - v minus 1 (v is
// the second the song is in), so once the reads' el - v spread over LOCK_SPREAD of the second the offset is known to
// (1 - spread) / 2: within 60 ms. Until then MusicKit's whole second stays (as before). Electron-free (tests:
// test/player-time.test.js).
'use strict'

const LOCK_READS = 4      // reads of one element before its offset is trusted
const LOCK_SPREAD = 0.88  // s: and their el - v spread at least this much: the offset known to (1 - spread) / 2
const MOVED = 0.15        // s: an el - v this far under the estimate: the element's timeline moved (a seek): start over
const AGREE = 1.5         // s: an element this close to MusicKit's time is the song's time itself (offset ~0)
const ELEMENTS = 4        // elements looked at

/**
 * createPlayerTime({ log }) -> { read(sample) -> { t, coarse, via }, reset() }
 * sample: { key (the song), mk (MusicKit's time), els: [[currentTime, paused 0|1], ...] }
 * t: the song's time (s); coarse: true when it is MusicKit's whole second (no element is trusted yet);
 * via: '' (MusicKit) | 'element' (an element agreeing with MusicKit) | 'offset' (an element with a learned offset).
 */
function createPlayerTime(opts = {}) {
  const log = opts.log || null
  let key = null
  let est = []   // cache: OK — key=this song's elements by index; invalidated=a new song (read) or reset(); bound=ELEMENTS
  let said = ''  // the last element/offset logged for this song (one line when it locks or moves)

  function reset() { key = null; est = []; said = '' }

  function read(s) {
    const mk = Number(s && s.mk)
    const els = (s && Array.isArray(s.els) ? s.els : []).slice(0, ELEMENTS)
    if (!Number.isFinite(mk)) return { t: 0, coarse: true, via: '' }
    if (s.key !== key) { key = s.key; est = []; said = '' }
    // MusicKit precise already: as it is
    if (!Number.isInteger(mk)) return { t: mk, coarse: false, via: '' }
    let best = null
    // loop: HOT-PATH-OK — ≤ ELEMENTS elements, once a lyrics tick (2/s)
    els.forEach((e, j) => {
      const t = Number(e && e[0])
      const paused = !!(e && e[1])
      if (!(t > 0) || paused) return
      // the song's own element: in step with MusicKit (the old rule, kept)
      if (Math.abs(t - mk) < AGREE && (!best || best.via !== 'element')) best = { t, coarse: false, via: 'element', j, off: 0 }
      const d = t - mk
      let x = est[j]
      // new, its timeline moved back (a seek on it), or spread over more than a second (moved forward): start over
      if (!x || d < x.lo - MOVED || d > x.lo + 1 + MOVED) x = est[j] = { lo: d, hi: d, n: 0 }
      x.lo = Math.min(x.lo, d)
      x.hi = Math.max(x.hi, d)
      x.n++
      if (x.n >= LOCK_READS && x.hi - x.lo >= LOCK_SPREAD && !best) {
        const off = (x.lo + x.hi - 1) / 2   // the middle of (hi - 1, lo]: within (1 - spread) / 2
        best = { t: t - off, coarse: false, via: 'offset', j, off }
      }
    })
    if (!best) return { t: mk, coarse: true, via: '' }
    const line = best.via + ' ' + best.j + (best.via === 'offset' ? ' ' + best.off.toFixed(1) : '')
    if (log && best.via === 'offset' && line !== said) log('player time: element ' + best.j + ' runs ' + best.off.toFixed(2) + ' s from the song (MusicKit gives whole seconds); its time is used')
    said = line
    return { t: best.t, coarse: false, via: best.via }
  }

  return { read, reset }
}

module.exports = { createPlayerTime, LOCK_READS, LOCK_SPREAD, MOVED, AGREE }
