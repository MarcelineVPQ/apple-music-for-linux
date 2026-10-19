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
'use strict'
const T = require('./lyrics-timing')

/** Song time (s) at nowMs from a snapshot (the same math every consumer uses). */
function timeAt(st, nowMs) { return T.clockTime(st, nowMs) }

/** The clock's speed at nowMs: 0 paused, 1 in step, 1 +/- SLEW_RATE while it eases a correction in. */
function rateAt(st, nowMs) {
  if (!st || !st.playing || st.anchor == null) return 0
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
  const log = opts.log || null
  let loggedAt = -Infinity   // cache: OK — key=the last correction logged; invalidated=each logged line; bound=one number

  function snapshot() {
    if (!clock) return null
    return { anchor: clock.anchor, at: clock.at, corr: clock.corr || 0, playing: !!clock.playing, key, epoch }
  }
  function setSong(k, duration) {
    if (k === key) return
    gate = T.trackGate(clock, duration, now())
    key = k
    clock = null
    epoch++
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
      const next = T.syncClock(clock, fresh, isPlaying, n)
      const stepped = shown != null && Math.abs(T.clockTime(next, n) - shown) > jump
      if (shown == null || stepped) epoch++
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
function followRate(cur, want, clockRate, jumpNow) {
  const base = Number.isFinite(clockRate) && clockRate > 0 ? clockRate : 1
  const d = want - cur
  if (jumpNow || !Number.isFinite(d) || Math.abs(d) > FOLLOW_SNAP) return { snap: true, rate: Math.round(base * 100) / 100 }
  const r = Math.min(FOLLOW_MAX, Math.max(FOLLOW_MIN, base + d))
  return { snap: false, rate: Math.round(r * 100) / 100 }
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

module.exports = { createSongClock, timeAt, rateAt, localize, followRate, follow, FOLLOW_SNAP, FOLLOW_MIN, FOLLOW_MAX }
