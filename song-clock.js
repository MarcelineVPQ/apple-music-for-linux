// The song clock (0.15.62): the one time source every lyric consumer runs on, like a studio's house
// word clock. Before it, the lyrics view, the sheet-notes band, the listening refiner and the
// alignment recorder each smoothed Apple's 2/s time pushes on their own, so they drifted apart and
// the band's strip (a 1x Web Animation) stepped back each time the words' clock eased.
//
// Main owns the master (createSongClock over the heard time, epoch ms): it takes Apple's player time
// with the moment the page read it (freshTime: a late push is aged, not read as "ahead"), eases small
// differences (lyrics-timing syncClock: 0.5-1.5x, never a step back), and snaps only on a real seek, a
// stall or a new song, which it announces by bumping `epoch` (a discontinuity). Each tick (2/s) it
// pushes the snapshot { anchor, at, corr, playing, key, epoch }; the views take it to their own time
// base once (localize) and interpolate with timeAt / rateAt, so every consumer shows the same instant
// with no per-frame IPC. Electron-free (tests: test/song-clock.test.js).
// 0.15.64, a house clock / PLL (Marcy: no jumps any more, but the band's speed wavered "a little
// faster, a little slower to meet the timing of the words"): the clock no longer eases each push's
// error in at 0.5-1.5x. It runs at exactly 1x; the phase error is the median of the pushes' offsets
// over the last PLL_WINDOW ms (late or stray pushes are outvoted) and is trimmed by a slew of at most
// PLL_SLEW (0.5 %, inaudible, invisible). Only an error over PLL_SNAP (or one push over PLL_JUMP: a
// seek), a pause, a stall or a new song is a clean discontinuity (epoch bump).
'use strict'
const T = require('./lyrics-timing')

/** Song time (s) at nowMs from a snapshot (the same math every consumer uses). */
function timeAt(st, nowMs) { return T.clockTime(st, nowMs) }

const PLL_WINDOW = 3000   // ms of pushes the phase estimate is the median of
const PLL_SLEW = 0.005    // the most the clock's rate leaves 1 to trim its phase
const PLL_TAU = 2         // s: the phase error is trimmed at err / PLL_TAU per s (capped at PLL_SLEW)
const PLL_SNAP = 0.25     // s: an estimated error over this (3+ pushes agreeing) is a discontinuity
const PLL_JUMP = 1        // s: one push this far off is a seek: a discontinuity at once
// 0.15.65, song boundaries (Marcy: "a weird jump at the beginning of the song"): Apple's player resets its time
// to the new song's start ~a tick before it names the new song, so that push read as a seek in the OLD song
// (snapped back to 0:00, the old words and band flashed), then the song changed. A drop from over
// BOUNDARY_FROM s to under BOUNDARY_TO s now waits up to BOUNDARY_WAIT ms for the song change (no push: the
// views run on); only if none comes is it a seek. A new song's first SEED_PUSHES pushes seed its phase quietly:
// a resume or a small offset (< PLL_JUMP) is slewed in, never a step.
const BOUNDARY_TO = 2
const BOUNDARY_FROM = 5
const BOUNDARY_WAIT = 1500
const SEED_PUSHES = 3

function median(xs) {
  const a = xs.slice().sort((x, y) => x - y)   // loop: HOT-PATH-OK — one sort a push (2/s), N <= 8
  const m = a.length >> 1
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2
}

/** The clock's speed at nowMs: 0 paused, its steady rate (1 +/- PLL_SLEW) while playing. */
function rateAt(st, nowMs) {
  if (!st || !st.playing || st.anchor == null) return 0
  if (Number.isFinite(st.rate)) return st.rate
  const c = st.corr || 0
  const e = Math.max(0, (nowMs - st.at) / 1000)
  return Math.abs(c) - e * T.SLEW_RATE > 0 ? 1 + Math.sign(c) * T.SLEW_RATE : 1
}

/** A snapshot stamped in the master's base (epoch ms) moved to a local base: at += localNow - masterNow. */
function localize(st, masterNowMs, localNowMs) {
  if (!st) return null
  return Object.assign({}, st, { at: st.at - masterNowMs + localNowMs, seekAt: undefined })
}

/**
 * createSongClock({ now() ms (the clock's base), epochNow() epoch ms (for readAt), jump (s), log(line) })
 * -> { setSong(key, duration), push(t, isPlaying, key, readAt) -> snapshot | null, seek(t), snapshot(), time(), epoch }
 * push: null while a new song's gate waits for its first own sample (lyrics-timing trackSample), or for
 * another song's time. A step of more than `jump` (default 0.05 s) in the shown time is a discontinuity.
 */
function createSongClock(opts = {}) {
  const now = opts.now || (() => Date.now())
  const epochNow = opts.epochNow || (() => Date.now())
  const jump = opts.jump || 0.05
  let clock = null
  let key = null
  let gate = null
  let epoch = 0
  let gateDone = false   // this push is a new song's first
  let boundaryAt = null  // when a drop to a song's start began waiting for its song change (BOUNDARY_WAIT)
  let seedLeft = 0       // the new song's pushes still seeding its phase quietly
  const log = opts.log || null
  let samples = []   // cache: OK — key=this song's pushes in the last PLL_WINDOW ms; invalidated=a discontinuity, seek, pause or new song; bound=8
  let cum = 0        // s of phase trimmed so far (the integral of rate - 1)
  let loggedAt = -Infinity   // cache: OK — key=the last correction logged; invalidated=each logged line; bound=one number

  function snapshot() {
    if (!clock) return null
    return { anchor: clock.anchor, at: clock.at, corr: clock.corr || 0, rate: Number.isFinite(clock.rate) ? clock.rate : 1, playing: !!clock.playing, key, epoch }
  }
  function setSong(k, duration) {
    if (k === key) return
    gate = T.trackGate(clock, duration, now())
    key = k
    clock = null
    samples = []
    boundaryAt = null
    seedLeft = 0
  }
  // the phase detector: this push's offset from the shown time (null: no information), as syncClock reads it
  function offset(fresh, shown, n) {
    if (!Number.isFinite(fresh)) return null
    let d
    if (Number.isInteger(fresh)) {
      // a whole-second time (MusicKit may round down): the clock inside [v, v+1) is in step
      if (shown >= fresh - 0.05 && shown < fresh + 1.05) return 0
      d = shown < fresh ? fresh - shown : fresh + 1 - shown
    } else d = fresh - shown
    if (clock.seekAt != null && n - clock.seekAt < 1200 && Math.abs(d) > 1.05) return null   // a push from before a seek
    return d
  }
  return {
    setSong,
    push(t, isPlaying, k, readAt) {
      if (typeof k === 'string' && k !== key) setSong(k, 0)
      const n = now()
      if (gate) {
        if (!T.trackSample(gate, t, isPlaying, n)) return null
        gate = null
        gateDone = true
      }
      const fresh = T.freshTime(t, isPlaying, readAt, epochNow())
      const shown = clock ? T.clockTime(clock, n) : null
      // a drop to the start of a song: the song change it most likely is comes first (BOUNDARY_WAIT)
      const recentSeek = clock && clock.seekAt != null && n - clock.seekAt < 1200
      if (clock && clock.playing && !recentSeek && Number.isFinite(fresh) && fresh < BOUNDARY_TO && shown > BOUNDARY_FROM) {
        if (boundaryAt == null) boundaryAt = n
        if (n - boundaryAt < BOUNDARY_WAIT) return null   // held: the views run on, the old song never shows 0:00
      }
      boundaryAt = null   // no drop, or none came in BOUNDARY_WAIT: a seek to the start after all
      let next = T.syncClock(clock, fresh, isPlaying, n)   // pause, stall, resume and the first time
      const seeding = seedLeft > 0 && clock && shown != null && Number.isFinite(fresh) && Math.abs(fresh - shown) <= PLL_JUMP
      if (seedLeft > 0) seedLeft--
      if (seeding && next.playing && !clock.playing) {
        // the new song's player said "paused" at its first push and plays now: on from where it is, the
        // offset slewed in by the PLL below (Marcy's log: "corrected 227 ms (jump…)" at a song's start)
        clock = Object.assign({}, clock, { playing: true, at: n, rate: 1 })
      }
      if (clock && clock.playing && next.playing && clock.anchor != null) {
        cum += ((Number.isFinite(clock.rate) ? clock.rate : 1) - 1) * Math.max(0, n - clock.at) / 1000
        const d = offset(fresh, shown, n)
        const keep = { last: next.last, prev: next.prev, prev2: next.prev2, seekAt: next.seekAt, playing: true, corr: 0 }
        if (d != null && Math.abs(d) > PLL_JUMP && !seeding) {
          next = Object.assign(keep, { anchor: fresh, at: n, rate: 1 })   // a seek: snapped
          samples = []
        } else {
          if (d != null) samples.push({ t: n, off: d, cum })
          samples = samples.filter((x) => n - x.t <= PLL_WINDOW).slice(-8)   // loop: HOT-PATH-OK — once a push (2/s), N <= 8
          const err = samples.length ? median(samples.map((x) => x.off - (cum - x.cum))) : 0   // loop: HOT-PATH-OK — N <= 8, 2/s
          if (samples.length >= 3 && Math.abs(err) > PLL_SNAP && !seeding) {
            next = Object.assign(keep, { anchor: shown + err, at: n, rate: 1 })   // far off and agreed on: one clean step
            samples = []
          } else next = Object.assign(keep, { anchor: shown, at: n, rate: 1 + Math.max(-PLL_SLEW, Math.min(PLL_SLEW, err / PLL_TAU)) })
        }
      } else samples = []
      const stepped = shown != null && Math.abs(T.clockTime(next, n) - shown) > jump
      if (shown == null || stepped) epoch++
      if (shown == null) seedLeft = SEED_PUSHES
      // a correction over 100 ms: one debug line a minute at most, with its size and cause (Marcy's log
      // then shows it if anything still jumps)
      const off = shown == null || !next.playing ? 0 : fresh - shown
      if (log && Math.abs(off) > 0.1 && n - loggedAt >= 60000) {
        loggedAt = n
        log('song clock: corrected ' + Math.round(off * 1000) + ' ms (' + (stepped ? (gateDone ? 'first time of a new song' : 'jump: a seek or a stall, snapped') : off < 0 ? 'player behind: eased, never back' : 'player ahead: eased') + ')' + (Number.isFinite(readAt) ? ', push ' + Math.round(epochNow() - readAt) + ' ms old' : ''))
      }
      gateDone = false
      clock = next
      return snapshot()
    },
    /** A seek from a view: shown at once, stale pushes from before it are ignored (seekClock). */
    seek(t) {
      clock = T.seekClock(clock, t, now())
      samples = []
      epoch++
      return snapshot()
    },
    snapshot,
    time() { return clock ? T.clockTime(clock, now()) : 0 },
    get epoch() { return epoch }
  }
}

/**
 * How a clocked Web Animation (the band's strip, the interlude dots, Expressive stretches and ghosts)
 * follows the song clock. cur: where the animation is (s from its start), want: where the clock says it should be, clockRate: the clock's
 * speed now (rateAt), jumpNow: the clock had a discontinuity (a seek, a new song) or is paused.
 * -> { snap, rate }: snap only on a discontinuity or a drift over FOLLOW_SNAP s; otherwise a speed
 * (FOLLOW_MIN-FOLLOW_MAX x, never backwards) that closes the drift in about a second.
 */
const FOLLOW_SNAP = 1
const FOLLOW_MIN = 0.5
const FOLLOW_MAX = 1.5
const FOLLOW_DEAD = 0.03   // s of drift a clocked animation lets be (its rate stays the clock's)
const FOLLOW_TRIM = 0.02   // the most a small drift moves its rate
function followRate(cur, want, clockRate, jumpNow) {
  const base = Number.isFinite(clockRate) && clockRate > 0 ? clockRate : 1
  const d = want - cur
  const round = (r) => Math.round(r * 1000) / 1000
  if (jumpNow || !Number.isFinite(d) || Math.abs(d) > FOLLOW_SNAP) return { snap: true, rate: round(base) }
  // 0.15.64: in step (within FOLLOW_DEAD) it runs at the clock's own rate, a small drift is trimmed by at
  // most FOLLOW_TRIM (invisible), only a big one (a hidden window, a stall) is eased in faster
  if (Math.abs(d) <= FOLLOW_DEAD) return { snap: false, rate: round(base) }
  if (Math.abs(d) <= 0.25) return { snap: false, rate: round(base + Math.max(-FOLLOW_TRIM, Math.min(FOLLOW_TRIM, d))) }
  return { snap: false, rate: round(Math.min(FOLLOW_MAX, Math.max(FOLLOW_MIN, base + d))) }
}

/**
 * Keeps one Web Animation on the clock: a.currentTime only on a discontinuity (the clock's epoch moved,
 * paused) or a drift over FOLLOW_SNAP; otherwise its speed eases the drift in, so it never steps back.
 * wantMs: where the clock says it is (ms from the animation's start).
 */
function follow(a, wantMs, clockRate, epoch, paused) {
  const fit = followRate((a.currentTime || 0) / 1000, wantMs / 1000, clockRate, paused || a.sonataEpoch !== epoch)
  a.sonataEpoch = epoch
  if (fit.snap) a.currentTime = wantMs
  if (a.playbackRate !== fit.rate) a.playbackRate = fit.rate
}

module.exports = { createSongClock, timeAt, rateAt, localize, followRate, follow, FOLLOW_SNAP, FOLLOW_MIN, FOLLOW_MAX, PLL_SLEW, PLL_SNAP }
