// "Refine timing by listening" wiring between main.js, the listener (audio-listen.js), the
// vocal detector (vocal-detect.js) and the word refiner (timing-refine.js). Electron-free, so the
// time mapping and the learned-cache flow are tested with node --test.
//
// Song time of a chunk: the lyrics clock (the last playbackTime push plus the time since, the
// same lyrics-timing clock the window uses) at the moment the chunk arrived, minus MONITOR_LATENCY
// (the audio in a monitor chunk was played slightly before it reached us), minus the chunk's
// own length for its first sample.
//
// Learned words live in the lyrics store under `refined|isrc:<ISRC>` (`refined|title|artist` when the
// ISRC is unknown; recording-id.js, which also checks the recording's length):
//   { v: 1, lines: { [lineIndex]: { text, words: [{ t, end, text }], plays } }, offset?, offsetSource? }
// offset (0.15.42): the song's onset learned from those lines (lyrics-timing robustOnset of first word −
// the line's stamp, from 3+ lines), offsetSource 'listen'; a later play starts its estimated lines with it.
// Each play refines from the plain estimate (so no word drifts more than MAX_SHIFT from it) and
// the result is merged into the running average with mergeLearned.
const T = require('./lyrics-timing')
const R = require('./recording-id')

// Not measurable in the isolated test run (no real audio there); 50 ms is parec's 20 ms
// fragment plus PipeWire's typical quantum (1024 frames at 48 kHz ≈ 21 ms) and a margin.
const MONITOR_LATENCY = 0.05
const EVIDENCE_PAD = 0.5        // s of evidence before a line's start and after its end
// Delegated decision (overnight 2026-10-16, Marcy can overrule): the bench showed maxShift 1.0 roughly
// halves the median error vs 0.35 with the same ~2 % of words made worse, because LRC line timing is
// often off by more than 0.35 s. See docs/LISTEN-RESULTS.md.
const MAX_SHIFT = 1.0
const MIN_CONFIDENCE = 0.3      // refinements below this are neither shown nor learned
const GAP_TOLERANCE = 0.25      // s; a bigger jump between chunks is a seek/pause: start over
const KEEP_EVIDENCE = 30        // s of onsets/voiced segments kept behind the playhead

function learnedKey(title, artist) { return 'refined|' + title + '|' + artist }

/** Song time (s) at wall time wallMs from a lyrics clock, minus the monitor latency. */
function songTimeAt(clock, wallMs, latency = MONITOR_LATENCY) {
  return T.clockTime(clock, wallMs) - latency
}

/** Song time of a chunk's first sample: it ends at songTimeAt(arrival). */
function chunkStart(clock, wallMs, samples, rate, latency = MONITOR_LATENCY) {
  return songTimeAt(clock, wallMs, latency) - samples / rate
}

function sameWords(a, b) {
  return a && b && a.length === b.length && a.every((w, i) => w.text === b[i].text)
}

/**
 * Lines with learned words applied (new objects; inputs untouched). A learned line is used only
 * when the line's text and word list still match, so changed lyrics fall back to the estimate.
 * -> { lines, used }  (used: at least one line came from learned data; those carry refined: true)
 */
function applyLearned(lines, entry) {
  if (!entry || entry.v !== 1 || !entry.lines || !lines) return { lines, used: false }
  let used = false
  const out = lines.map((line, i) => {
    const l = entry.lines[i]
    if (!l || !line.estimated || l.text !== line.text || !sameWords(line.words, l.words)) return line
    used = true
    return Object.assign({}, line, { words: l.words.map((w) => ({ t: w.t, end: w.end, text: w.text })), refined: true })
  })
  return { lines: out, used }
}

/** The entry after learning `words` for line i (new object; prev untouched). */
function recordLearned(prev, i, line, words, mergeLearned) {
  const entry = prev && prev.v === 1 && prev.lines ? { v: 1, lines: Object.assign({}, prev.lines) } : { v: 1, lines: {} }
  const old = entry.lines[i] && entry.lines[i].text === line.text && sameWords(entry.lines[i].words, words) ? entry.lines[i] : null
  const plays = old ? old.plays || 1 : 0
  entry.lines[i] = { text: line.text, words: mergeLearned(old ? old.words : null, words, plays), plays: plays + 1 }
  return entry
}

/** The entry with its `offset` from its learned lines against `lines`' stamps (unchanged under 3 lines). */
function withOffset(entry, lines) {
  const delays = []
  // loop: NOT-WORTH — the entry's learned lines (tens), once per refined line
  for (const [k, l] of Object.entries(entry.lines)) {
    const line = lines[k]
    if (line && line.t != null && l.words && l.words.length) delays.push(l.words[0].t - line.t)
  }
  const offset = T.robustOnset(delays)
  return offset == null ? entry : Object.assign(entry, { offset: Math.round(offset * 1000) / 1000, offsetSource: 'listen' })
}

/**
 * One listening session per main process. deps:
 *   createListener(opts) -> { start, stop }   (audio-listen.js)
 *   createVocalDetector({ sampleRate }) -> { push, reset }   (vocal-detect.js)
 *   refineWords(line, evidence) / mergeLearned(prev, next, plays)   (timing-refine.js)
 *   store: { get, set }   send(channel, payload)   now() (ms, same base as the clock)   log
 */
function createListenSession(deps) {
  const rate = deps.sampleRate || 22050
  const latency = deps.latency == null ? MONITOR_LATENCY : deps.latency
  const log = deps.log || (() => {})
  let listener = null
  let detector = null
  let song = null          // { key, title, artist, base: [lines], done: Set }
  let clock = null
  let expectNext = null    // song time the next chunk should start at
  let coveredFrom = null   // song time since when we've listened without a gap
  let onsets = []
  let voiced = []

  let allOnsets = []    // lifetime: whole song's onsets for the noise gate (bounded by song length); cleared per song
  function resetEvidence() {
    onsets = []
    voiced = []
    expectNext = null
    coveredFrom = null
    if (detector) detector.reset()
  }

  function onChunk(mid, wallMs, side) {
    if (!song || !clock || !clock.playing || !detector) return
    const t0 = chunkStart(clock, wallMs, mid.length, rate, latency)
    if (expectNext == null || Math.abs(t0 - expectNext) > GAP_TOLERANCE) {
      resetEvidence()
      coveredFrom = t0
    }
    expectNext = t0 + mid.length / rate
    // the detector uses stereo for its mid/side vocal hint: rebuild interleaved L,R when we have side
    let input = mid
    if (side && side.length === mid.length) {
      input = new Float32Array(mid.length * 2)
      // loop: HOT-PATH-OK — one pass over the chunk's frames (one parec chunk, ~1-2 k) per audio chunk while
      // listening · ends with the chunk; the interleaved buffer is a new Float32Array per chunk (small, collected)
      for (let i = 0; i < mid.length; i++) { input[2 * i] = mid[i] + side[i]; input[2 * i + 1] = mid[i] - side[i] }
    }
    const res = detector.push(input, t0)
    // loop: HOT-PATH-OK — the few onsets / voiced spans one chunk adds (0-3)
    if (res) {
      if (res.onsets) for (const o of res.onsets) { onsets.push(o); allOnsets.push(o) }
      if (res.voiced) for (const v of res.voiced) voiced.push(v)
    }
  }

  function startListening() {
    if (listener) return
    if (!detector) detector = deps.createVocalDetector({ sampleRate: rate, channels: 2 })
    resetEvidence()
    listener = deps.createListener({ sampleRate: rate, onChunk })
    listener.start()
  }

  function stopListening() {
    if (!listener) return
    listener.stop()
    listener = null
    resetEvidence()
  }

  // per line, once its evidence window has passed: refine from the plain estimate, show it and learn it
  function processDue(now) {
    if (coveredFrom == null || expectNext == null) return
    const lines = song.base
    // loop: HOT-PATH-OK — due-line scan · per tick (2/s) · over the song's lines (tens) · cost trivial
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      if (song.done.has(i) || !line.estimated || line.aligned || line.repeat || !line.words || !line.words.length) continue
      const end = T.lineEnd(line, lines[i + 1])
      const from = line.t - EVIDENCE_PAD
      const to = end + EVIDENCE_PAD
      if (to > expectNext || to > now) continue          // not heard yet
      song.done.add(i)                                    // one try per line per play
      if (from < coveredFrom) continue                    // we didn't hear the whole line
      const evidence = {
        onsets: onsets.filter((o) => o.t >= from && o.t <= to),
        voiced: voiced.filter((v) => v.end >= from && v.start <= to)
      }
      let res
      // song gate: onsets during intro/interludes (guitar chugs in mono mixes) mean low trust
      const gate = deps.noiseRate ? deps.noiseRate(allOnsets, lines, now) : { rate: null }
      const opts = { nextStart: lines[i + 1] && lines[i + 1].t != null ? lines[i + 1].t : undefined, noiseRate: gate.rate, maxShift: MAX_SHIFT }
      // error: LOGGED-OK — a refine that throws is logged; the line keeps its estimate
      try { res = deps.refineWords(line, evidence, opts) } catch (e) { log('refine failed: ' + e.message); continue }
      if (!res || !res.words || !sameWords(line.words, res.words) || !(res.confidence >= MIN_CONFIDENCE)) continue
      // merged into this recording's entry only (song.learned: null when the stored one is another recording's)
      const entry = withOffset(recordLearned(song.learned, i, line, res.words, deps.mergeLearned), lines)
      song.learned = entry
      R.put(deps.store, song.storeKey, entry, song.rec)
      deps.send('lyrics-refined', { key: song.key, lineIndex: i, words: entry.lines[i].words })
    }
    // drop evidence the remaining lines can't use any more
    const keepFrom = now - KEEP_EVIDENCE
    if (onsets.length && onsets[0].t < keepFrom) onsets = onsets.filter((o) => o.t >= keepFrom)
    if (voiced.length && voiced[0].end < keepFrom) voiced = voiced.filter((v) => v.end >= keepFrom)
  }

  return {
    /**
     * New lyrics for the window. lines: the estimated lines (before learned data). Returns the
     * lines to render ({ lines, refined, onset }) with learned words applied (onset: the entry's offset, or null).
     */
    setLyrics(key, title, artist, lines, enabled, info) {
      stopListening()
      clock = null
      // 0.15.62: only words Sonata estimated (line-timed lyrics spread across words) are refined. A song
      // with any word timing of its own (Apple's or LRC words; not estimated, not aligned) is never
      // touched, and aligned / mapped lines are skipped below (Marcy: Apple-word-timed "Dancing Queen"'s
      // words jumped back and forth with Refine on)
      const own = !!lines && lines.some((l) => ((l.words && l.words.length) || (l.bg && l.bg.length)) && !l.estimated && !l.aligned)
      const estimated = !!lines && !own && lines.some((l) => l.estimated && !l.aligned)
      song = enabled && estimated ? { key, title, artist, base: lines, done: new Set() } : null
      allOnsets = []
      if (!song) return { lines, refined: false, onset: null }
      // this recording's learned words (info: { isrc, duration }); an old entry of a "(Live)"-style title
      // only when its words start where these lines do
      const rec = R.songOf(Object.assign({}, info, { title, artist }))
      const found = R.lookup(deps.store, 'refined|', rec, { check: (e) => R.timingMatches(e.lines, lines) })
      song.storeKey = found.key
      song.rec = rec
      song.learned = found.entry
      const got = applyLearned(lines, found.entry)
      return { lines: got.lines, refined: got.used, onset: found.entry && Number.isFinite(found.entry.offset) ? found.entry.offset : null }
    },
    /** Per lyrics poll tick: the playback time push. Runs/stops the listener. */
    tick(playbackTime, isPlaying, enabled, songClock) {
      if (!song || !enabled) { stopListening(); if (!enabled) song = null; return }
      const now = deps.now()
      // songClock: main's one song clock in deps.now()'s base (song-clock.js localize); without it, the raw push smoothed here
      clock = songClock || T.syncClock(clock, playbackTime, isPlaying, now)
      if (!clock.playing) { stopListening(); return }
      startListening()
      processDue(songTimeAt(clock, now, latency))
    },
    // lifetime: stop() ends the listener (kills parec) and forgets the song; called on lyrics close and quit
    stop() { stopListening(); song = null; clock = null },
    get listening() { return !!listener },
    _onChunk: onChunk       // tests
  }
}

module.exports = {
  MONITOR_LATENCY, EVIDENCE_PAD, MIN_CONFIDENCE,
  learnedKey, songTimeAt, chunkStart, applyLearned, recordLearned, withOffset, createListenSession
}
