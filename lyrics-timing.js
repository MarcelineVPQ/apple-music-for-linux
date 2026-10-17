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
      for (const w of list) {
        consider(w.t - lead); consider(w.end - lead)
        if (w.held || w.holdFrom != null) consider((w.holdFrom != null ? w.holdFrom : w.t) + SUSTAIN_AFTER - lead)
        // loop: a word's syllables (a handful) · only Apple words timed in several spans
        if (w.syl) for (const y of w.syl) { consider(y.t - lead); consider(y.end - lead) }
      }
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

// How long a word takes to sing, in rough units: syllables (vowel groups; a silent final "e"
// doesn't count), a small base per word, and a short breath after , ; : . ! ? —
// Scripts without Latin vowels fall back to characters / 2.
function syllables(word) {
  const w = word.toLowerCase().replace(/[^\p{L}]/gu, '')
  if (!w) return 1
  if (!/[a-zà-ÿ]/.test(w)) return Math.max(1, Math.round(w.length / 2))
  const groups = w.replace(/(?<!l)e$/, '').match(/[aeiouyà-ÿ]+/g)
  return Math.max(1, groups ? groups.length : 1)
}
function wordWeight(word) {
  return syllables(word) + 0.35 + (/[,;:.!?…—-]$/.test(word) ? 0.6 : 0)
}

// Estimated word timing (line-only lyrics), tuned with tools/drift-check (docs/LYRIC-TIMING.md).
// Singing has a pace: a line is sung at roughly PACE s per weight unit (wordWeight) from its start,
// and whatever time is left before the next line is a tail of silence, not slower singing. The old
// estimate stretched the words over 90 % of the line's time, so when a line's time ran on to the
// next line (Apple's line end is the next line's start in about half the lines; LRCLIB has no end
// at all) every later word lit up late, worst at the end of the line and of a verse.
// - A line with a real end (it stops > TIGHT_GAP before the next line starts) is spread over
//   EST_FILL of [t, end] minus TIGHT_TAIL: Apple's real ends run ~0.3 s past the last sung word.
// - Otherwise the line takes pace × its weight, at most EST_FILL of the time to the next line.
// - The pace: PACE blended with the song's own (the SONG_PACE_Q quantile of time-per-weight over
//   its lines: the lines sung back to back), or the pace learned from lines already aligned or
//   refined in this song (learnedPace), which beats both.
// - A line sung faster than its time: the last word holds on, like a sung note, for at most LAST_HOLD
//   s and until HOLD_GAP before the next line (0.15.34: was 1 s and 90 % of the time to the next line,
//   which ended 61 % of her held notes early; measured in docs/LYRIC-TIMING.md "Held notes").
// - Apple's line end after the next line's start: the singer still holds when the next line comes
//   in, so the last word holds to that end minus TIGHT_TAIL, overlapping the next line.
const PACE = 0.25             // s per weight unit (JamendoLyrics median 0.22–0.24)
const PACE_MIN = 0.15
const PACE_MAX = 0.6
const SONG_PACE_Q = 0.2
const SONG_PACE_BLEND = 0.6   // share of the song's own pace in the log blend with PACE
const EST_FILL = 0.9          // at most this share of the time to the next line is singing
const TIGHT_TAIL = 0.2        // s: a real [t, end] loses this much more tail than EST_FILL (Apple's ends
                              // run ~0.3 s past the last sung word)
const TIGHT_GAP = 0.05        // s: an end this much before the next start is a real end
const LAST_HOLD = 3.0         // s the last word may hold
const HOLD_GAP = 0.1          // s before the next line a held last word lets go

function lineParts(line) { return String((line && line.text) || '').split(/\s+/).filter(Boolean) }
function lineWeight(parts) { return parts.reduce((a, p) => a + wordWeight(p), 0) }

// time from the line's start to its end, else to the next line's start (Infinity: none)
function lineTime(line, next) {
  const end = line.end != null ? line.end : (next && next.t != null ? next.t : Infinity)
  return end - line.t
}
function hasRealEnd(line, next) {
  return line.end != null && (!next || next.t == null || next.t - line.end > TIGHT_GAP)
}

function clampPace(p) { return p < PACE_MIN ? PACE_MIN : p > PACE_MAX ? PACE_MAX : p }

/** The song's pace from its line times alone (s per weight unit). */
function songPace(lines) {
  const r = []
  // loop: one pass over the song's lines · once per estimate
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].t == null) continue
    const w = lineWeight(lineParts(lines[i]))
    const a = lineTime(lines[i], lines[i + 1])
    if (w >= 3 && a > 0 && a < Infinity) r.push(a / w)
  }
  if (r.length < 3) return PACE
  r.sort((a, b) => a - b)
  const q = r[Math.round(SONG_PACE_Q * (r.length - 1))]
  return clampPace(Math.exp((1 - SONG_PACE_BLEND) * Math.log(PACE) + SONG_PACE_BLEND * Math.log(q)))
}

/**
 * The pace sung in lines whose words were placed from the audio (aligned or refined, not mapped
 * repeats): median over lines of 3+ words of (last start − first start) / weight of all but the
 * last word. null for fewer than 2 such lines.
 */
function learnedPace(lines) {
  const r = []
  // loop: one pass over the song's lines · per estimate / alignment / refine message
  for (const line of lines || []) {
    if (!(line.aligned || line.refined) || line.repeat || !line.words || line.words.length < 3) continue
    const ws = line.words
    const w = lineWeight(ws.slice(0, -1).map((x) => x.text))
    const d = ws[ws.length - 1].t - ws[0].t
    if (w > 0 && d > 0) r.push(d / w)
  }
  if (r.length < 2) return null
  r.sort((a, b) => a - b)
  return clampPace(r[Math.floor(r.length / 2)])
}

/** One line's estimated words at `pace` (null when it has no words). h: hold options, for the drift
 * check's comparisons only (lastHold s, toNext, overlap: the defaults are the shipped rules) */
function estimateLine(line, next, pace, h = {}) {
  const parts = lineParts(line)
  if (!parts.length) return null
  const time = lineTime(line, next)
  const weights = parts.map(wordWeight)
  const total = weights.reduce((a, b) => a + b, 0)
  const tight = hasRealEnd(line, next)
  const cap = tight ? Math.max(0.6 * time, time * EST_FILL - TIGHT_TAIL) : time * EST_FILL
  const span = Math.max(0.2, tight ? cap : Math.min(cap, pace * total))
  let acc = 0
  const words = parts.map((text, k) => {
    const t = line.t + (acc / total) * span
    acc += weights[k]
    return { t, end: line.t + (acc / total) * span, text }
  })
  // sung faster than the line's time: the last word holds into the tail (at most LAST_HOLD s)
  const last = words[words.length - 1]
  const sung = last.end
  const lastHold = h.lastHold != null ? h.lastHold : LAST_HOLD
  // the hold may run to a real end minus Apple's tail, else to just before the next line
  const holdCap = h.toNext === false ? cap : Math.max(cap, time - (tight ? TIGHT_TAIL : HOLD_GAP))
  // (a line squeezed into its time has no room left to hold)
  if ((tight || span < cap) && last.end < line.t + holdCap) last.end = Math.max(last.end, Math.min(line.t + holdCap, last.t + lastHold))
  // Apple's line end AFTER the next line's start: the singer is still holding when the next line
  // comes in, so the last word holds to that end (minus Apple's usual tail)
  if (h.overlap !== false && line.end != null && next && next.t != null && line.end > next.t + TIGHT_GAP) last.end = Math.max(last.end, line.end - TIGHT_TAIL)
  if (last.end - sung >= 0.2) last.holdFrom = sung
  return words
}

/**
 * Estimated word timing for line-only lyrics (see above). Lines that already have word timing, and
 * unsynced lyrics, are left as is. opts.pace: a known pace (s per weight unit). Returns new line
 * objects with `words`, `estimated: true` and the `pace` used.
 */
function estimateWords(lines, opts = {}) {
  if (!lines || !lines.length || lines[0].t == null || hasWordTiming(lines)) return lines
  const pace = opts.pace || songPace(lines)
  return lines.map((line, i) => {
    const words = estimateLine(line, lines[i + 1], pace, opts.hold)
    return words ? Object.assign({}, line, { words, estimated: true, pace }) : line
  })
}

/**
 * Re-estimates the plain estimated lines (not refined, not mapped repeats) at the pace learned from
 * the song's aligned/refined lines. Same array when there's nothing to learn from or nothing changes.
 */
function repace(lines) {
  const pace = learnedPace(lines)
  if (!pace) return lines
  let changed = false
  const out = lines.map((line, i) => {
    if (!line.estimated || line.refined || line.repeat || !line.words || line.t == null) return line
    if (line.pace && Math.abs(line.pace - pace) < 0.005) return line
    // the next line's start is all estimateLine reads from it
    const words = estimateLine(line, lines[i + 1], pace)
    if (!words || words.length !== line.words.length) return line
    changed = true
    return Object.assign({}, line, { words, pace })
  })
  return changed ? out : lines
}

// which timing a repeat was copied from (its source changes when that line is refined again)
function sig(line) { return line.t + ':' + line.words[0].t + ':' + line.words[line.words.length - 1].t }

// a line's text for repeat matching: lower case, letters/digits/apostrophes, single spaces
function repeatKey(text) {
  return String(text || '').toLowerCase().replace(/[^\p{L}\p{N}'’\s]/gu, '').replace(/\s+/g, ' ').trim()
}

/**
 * Repeated lines (choruses): a plain estimated line takes the word timing of an identical line that
 * was aligned (preferred) or refined, shifted to its own start; a repeat mapped from a refined line
 * is upgraded when an aligned one appears. Words that would run past the next line's start are cut
 * off there; a line whose words wouldn't start before it is left alone.
 * Marks mapped lines `repeat: 'aligned' | 'refined'` (they stay `estimated`). Same array when nothing
 * changes.
 */
// A word's timing, copied (shifted by `shift` s, ends capped at `limit`), held notes included:
// held (the voice holds the word past its sung part) and holdFrom (where the hold starts), which the
// syllables (lyrics-syllables.js: the hold belongs to the last syllable) and the sustain use.
function copyWord(w, shift = 0, text = w.text, limit = Infinity) {
  const out = { t: +w.t + shift, end: Math.min(+w.end + shift, limit), text }
  if (w.held) out.held = true
  if (w.holdFrom != null && +w.holdFrom + shift < out.end) out.holdFrom = +w.holdFrom + shift
  return out
}

// The sustain (0.15.34): this long after a held note's hold begins, its pop settles into a gentle
// sustained lift (the .hold class), instead of staying at full pop or popping again
const SUSTAIN_AFTER = 0.25

// How far a held word may run into the next line when that line's start is only an anchor (Apple/LRC
// line time, not a sung word): line starts often come a little before the voice does.
const HOLD_OVER = 0.6

/**
 * Held notes against the next line (0.15.34): a word the aligner or the listener found held keeps its
 * hold over the next line's start (the overlap: the new line is current while the old word still
 * sings), but never past the next line's first REAL word (aligned or refined) - 0.04 s, and at most
 * HOLD_OVER past a next line that's only an anchor. Same array when nothing changes.
 */
function boundHolds(lines) {
  if (!lines || !lines.length) return lines
  let out = lines
  // loop: one pass over the song's lines · per lyrics data / alignment / refine message
  for (let i = 0; i < lines.length - 1; i++) {
    const line = lines[i]
    const next = lines[i + 1]
    if (!line.words || !line.words.length || next.t == null) continue
    const last = line.words[line.words.length - 1]
    if (!last.held) continue
    const real = (next.aligned || next.refined) && next.words && next.words.length
    const limit = real ? next.words[0].t - 0.04 : next.t + HOLD_OVER
    if (!(last.end > limit) || limit <= last.t + 0.05) continue
    if (out === lines) out = lines.slice()
    const words = line.words.slice()
    words[words.length - 1] = copyWord(last, 0, last.text, limit)
    out[i] = Object.assign({}, line, { words })
  }
  return out
}

function reuseRepeats(lines) {
  if (!lines || !lines.length) return lines
  const src = new Map()   // key -> { line, kind }
  // loop: two passes over the song's lines · per estimate / alignment / refine message
  for (const line of lines) {
    if (line.repeat || !line.words || line.t == null || !(line.aligned || line.refined)) continue
    const key = repeatKey(line.text)
    const kind = line.aligned ? 'aligned' : 'refined'
    const have = src.get(key)
    if (key && (!have || (have.kind === 'refined' && kind === 'aligned'))) src.set(key, { line, kind })
  }
  if (!src.size) return lines
  let changed = false
  const out = lines.map((line, i) => {
    if (!line.estimated || line.refined || line.aligned || !line.words || line.t == null) return line
    const s = src.get(repeatKey(line.text))
    if (!s || s.line.words.length !== line.words.length || (line.repeat === s.kind && line.repeatOf === sig(s.line))) return line
    if (line.repeat === 'aligned' && s.kind === 'refined') return line
    const shift = line.t - s.line.t
    const next = lines[i + 1]
    const limit = next && next.t != null ? next.t : Infinity
    const words = s.line.words.map((w, k) => copyWord(w, shift, line.words[k].text, limit))
    if (words[words.length - 1].t >= limit - 0.05) return line
    for (const w of words) if (w.end <= w.t) w.end = w.t + 0.05
    changed = true
    return Object.assign({}, line, { words, repeat: s.kind, repeatOf: sig(s.line) })
  })
  return changed ? out : lines
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
  const seeking = prev.seekAt != null && nowMs - prev.seekAt < 1200 && Math.abs(predicted - received) > 1.05
  if (Number.isInteger(received)) {
    // coarse whole-second time: keep the smooth clock while it's inside [v, v+1)
    if (seeking || (predicted >= received - 0.05 && predicted < received + 1.05)) { next.anchor = predicted; next.at = nowMs }
    return next
  }
  // precise media time: ease halfway toward it on every push (smooth, converges in ~1 s);
  // further off than 0.3 s is a seek or a stall, so snap
  const d = received - predicted
  if (seeking) { next.anchor = predicted; next.at = nowMs }
  else if (Math.abs(d) <= 0.3) { next.anchor = predicted + d / 2; next.at = nowMs }
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
  INTERLUDE_MIN, LRC_LINE_GUESS, LINE_LEAD, LAST_HOLD, HOLD_GAP, HOLD_OVER, SUSTAIN_AFTER, copyWord, boundHolds,
  lineEnd, findInterludes, interludeAt, interludeProgress, wordPos, latestLine, liveLines, nextChange,
  lineSides, hasWordTiming, estimateWords, syllables, wordWeight, syncClock, seekClock, clockTime,
  PACE, songPace, learnedPace, estimateLine, repace, repeatKey, reuseRepeats
}
