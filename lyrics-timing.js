// Lyrics window timing: the local playback clock, word positions, interlude gaps and duet
// sides. Pure functions so they can be tested without Electron; lyrics.html requires this.

const INTERLUDE_MIN = 4     // s without singing before the countdown dots show
const LRC_LINE_GUESS = 3    // s a line without an end time is assumed to last
const LINE_LEAD = 0.2       // lines light up this early (as before)

// When a line's singing ends: its own end, its words' / background words' ends, or for LRC
// without word stamps a guess (LRC_LINE_GUESS or the next start, whichever is shorter).
function lineEnd(line, next) {
  let end = line.end != null ? line.end : null
  for (const list of [line.words, line.bg]) {
    if (list && list.length) end = Math.max(end === null ? -Infinity : end, list[list.length - 1].end)
  }
  if (end === null) end = Math.min(line.t + LRC_LINE_GUESS, next && next.t != null ? next.t : Infinity)
  return end
}

/**
 * Gaps of at least `min` seconds with nobody singing, before the first line or between
 * one line's end and the next line's start -> [{ index, start, end }], index = the line
 * the dots stand in for. Unsynced lyrics (t: null) have none.
 */
function findInterludes(lines, min = INTERLUDE_MIN) {
  if (!lines || !lines.length || lines[0].t == null) return []
  const out = []
  let sungUntil = 0
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (line.t - sungUntil >= min) out.push({ index: i, start: sungUntil, end: line.t })
    sungUntil = Math.max(sungUntil, lineEnd(line, lines[i + 1]))
  }
  return out
}

/** The interlude playing at `time` (-1 if none). It ends when the next line lights up. */
function interludeAt(interludes, time) {
  for (let i = 0; i < interludes.length; i++) {
    const g = interludes[i]
    if (time >= g.start && time + LINE_LEAD < g.end) return i
  }
  return -1
}

/**
 * Countdown dot fills (0…1 each) and the group's exit (1 = fully shown, 0 = gone) for an
 * interlude at `time`. The dots fill one by one across the gap; the last 0.6 s fade out.
 */
function interludeProgress(g, time, dots = 3) {
  const end = g.end - LINE_LEAD
  const span = Math.max(0.001, end - g.start - 0.6)
  const p = Math.min(1, Math.max(0, (time - g.start) / span))
  const fills = []
  for (let i = 0; i < dots; i++) fills.push(Math.min(1, Math.max(0, p * dots - i)))
  const exit = Math.min(1, Math.max(0, (end - time) / 0.6))
  return { fills, exit }
}

/**
 * Word position at `time`: k = words started, now = the word being sung (-1 between words).
 * Words before k other than `now` are sung; words from k on are upcoming.
 */
function wordPos(words, time) {
  let k = 0
  while (k < words.length && words[k].t <= time) k++
  const now = k > 0 && time < words[k - 1].end ? k - 1 : -1
  return { k, now }
}

/** The line that lit up last at `time` (-1 before the first): same rule as before. */
function latestLine(lines, time) {
  let index = -1
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].t <= time + LINE_LEAD) index = i
    else break
  }
  return index
}

/**
 * Lines being sung at `time`: the latest one plus up to 3 earlier lines still running
 * (duets and background vocals overlap the next line).
 */
function liveLines(lines, time) {
  const latest = latestLine(lines, time)
  const live = []
  for (let i = Math.max(0, latest - 3); i < latest; i++) {
    if (time < lineEnd(lines[i], lines[i + 1])) live.push(i)
  }
  if (latest >= 0) live.push(latest)
  return { latest, live }
}

/**
 * Seconds from `time` until the next word or line change (Infinity if none), so the window
 * can sleep between changes instead of drawing every frame. `lead` is the word lead.
 */
function nextChange(lines, time, lead = 0) {
  let best = Infinity
  const consider = (at) => { if (at > time && at - time < best) best = at - time }
  const latest = latestLine(lines, time)
  for (let i = Math.max(0, latest - 3); i <= latest + 1 && i < lines.length; i++) {
    const line = lines[i]
    if (line.t == null) continue
    consider(line.t - LINE_LEAD)
    consider(lineEnd(line, lines[i + 1]))
    for (const list of [line.words, line.bg]) {
      if (!list) continue
      for (const w of list) { consider(w.t - lead); consider(w.end - lead) }
    }
  }
  return best
}

// 'v2' < 'v10'
function agentOrder(a, b) {
  return (parseInt(a.replace(/\D/g, ''), 10) || 0) - (parseInt(b.replace(/\D/g, ''), 10) || 0) || (a < b ? -1 : a > b ? 1 : 0)
}

/**
 * Duet layout per line: '' when one singer (layout as before), else 'left' for the first
 * singer (v1), 'right' for the second, alternating after that; 'center' for lines sung
 * together (agent 'group') or without a singer mark.
 */
function lineSides(lines) {
  const singers = [...new Set(lines.map((l) => l.agent).filter((a) => a && a !== 'group'))].sort(agentOrder)
  if (singers.length < 2) return lines.map(() => '')
  return lines.map((l) => {
    if (!l.agent || l.agent === 'group') return 'center'
    return singers.indexOf(l.agent) % 2 ? 'right' : 'left'
  })
}

function hasWordTiming(lines) {
  return !!lines && lines.some((l) => (l.words && l.words.length) || (l.bg && l.bg.length))
}

const EST_FILL = 0.9        // estimated words fill this share of a line's time (the rest is the tail)

/**
 * Estimated word timing for line-only lyrics: each synced line's singing time (its end, else
 * the next line's start, at most LRC-style guess per word) is spread across its words, weighted
 * by letter count. Lines that already have word timing, and unsynced lyrics, are left as is.
 * Returns new line objects with `words` and `estimated: true`.
 */
function estimateWords(lines) {
  if (!lines || !lines.length || lines[0].t == null || hasWordTiming(lines)) return lines
  return lines.map((line, i) => {
    const next = lines[i + 1]
    const parts = String(line.text || '').split(/\s+/).filter(Boolean)
    if (!parts.length) return line
    let end = line.end != null ? line.end : (next && next.t != null ? next.t : line.t + 0.45 * parts.length + 1)
    end = Math.min(end, line.t + 0.6 * parts.length + 2)   // a long gap after the line isn't singing
    const span = Math.max(0.2, (end - line.t) * EST_FILL)
    const weights = parts.map((w) => w.replace(/[^\p{L}\p{N}]/gu, '').length + 2)
    const total = weights.reduce((a, b) => a + b, 0)
    let acc = 0
    const words = parts.map((text, k) => {
      const t = line.t + (acc / total) * span
      acc += weights[k]
      return { t, end: line.t + (acc / total) * span, text }
    })
    return Object.assign({}, line, { words, estimated: true })
  })
}

/**
 * Local playback clock. Main pushes the playback time every 500 ms; between pushes the
 * window counts on with performance.now(). Every push is checked against the clock:
 * - paused (isPlaying false, or the time unchanged across two pushes; three for a whole-second
 *   time, which can legitimately repeat twice while playing): freeze at the time;
 * - a whole-second time (MusicKit may round down) is fine while the clock is in [v, v+1);
 * - a fractional time is fine within 0.25 s;
 * - anything else (seek, drift) snaps the clock to the pushed time.
 * For 1.2 s after a seek from the lyrics window, stale pushes from before the seek are ignored.
 */
function syncClock(clock, received, isPlaying, nowMs) {
  const prev = clock || {}
  const stalled = prev.last === received && prev.prev === received && (!Number.isInteger(received) || prev.prev2 === received)
  const playing = isPlaying !== false && !stalled
  const next = { anchor: received, at: nowMs, playing, last: received, prev: prev.last, prev2: prev.prev, seekAt: prev.seekAt }
  if (!playing || !prev.playing || prev.anchor == null) return next
  const predicted = clockTime(prev, nowMs)
  const ok = Number.isInteger(received)
    ? predicted >= received - 0.05 && predicted < received + 1.05
    : Math.abs(predicted - received) <= 0.25
  const seeking = prev.seekAt != null && nowMs - prev.seekAt < 1200 && Math.abs(predicted - received) > 1.05
  if (ok || seeking) { next.anchor = predicted; next.at = nowMs }
  return next
}

/** The clock after a seek from the lyrics window. */
function seekClock(clock, time, nowMs) {
  const prev = clock || {}
  return { anchor: time, at: nowMs, playing: prev.playing !== false, last: null, prev: null, prev2: null, seekAt: nowMs }
}

function clockTime(clock, nowMs) {
  if (!clock || clock.anchor == null) return 0
  return clock.playing ? clock.anchor + (nowMs - clock.at) / 1000 : clock.anchor
}

module.exports = {
  INTERLUDE_MIN, LRC_LINE_GUESS, LINE_LEAD,
  lineEnd, findInterludes, interludeAt, interludeProgress, wordPos, latestLine, liveLines, nextChange,
  lineSides, hasWordTiming, estimateWords, syncClock, seekClock, clockTime
}
