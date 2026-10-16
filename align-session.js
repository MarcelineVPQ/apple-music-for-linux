// "Precise word timing (GPU, experimental)": Level 2 of lyrics timing (docs/LEVEL2-ALIGN.md).
// While a lyric view (lyrics window or visualizer) is open and a song with line-only lyrics plays, Sonata's OWN playback
// stream (the Level 1 listener, audio-listen.js) is recorded into a song-time-indexed buffer in
// memory. Once enough of the song was heard, the PCM and the lyric lines are streamed to the
// sonata-align helper (align-helper.js) over its stdin, which separates the vocals and force-aligns
// the known words on the GPU. The buffer is dropped as soon as it is handed over; no audio is ever
// written to disk or sent anywhere. Only the word times are kept, in the lyrics store under
// `aligned|title|artist`.
//
// Priority of word timing: Apple/LRC word timing (never touched) > aligned > refined (Level 1) >
// estimated. Aligned lines lose `estimated`, so Level 1 never refines them.
//
// Electron-free: the buffer, the priority, the cache entry and the request framing are tested with
// node --test (test/align-session.test.js).
const T = require('./lyrics-timing')
const { chunkStart, MONITOR_LATENCY } = require('./listen-session')

const RATE = 22050             // the Level 1 capture format; the bench shows no loss vs 44.1 kHz
const CHANNELS = 2
const FRAME_BYTES = 2 * CHANNELS
const BLOCK_SECONDS = 10       // the buffer grows in 10 s blocks (882 KB each)
const MAX_SECONDS = 15 * 60    // longer songs are not recorded past 15 min (79 MB at most)
const MIN_COVERAGE = 0.9       // share of the lyric span that must have been heard
const GAP_TOLERANCE = 0.25     // s; a bigger jump between chunks is a seek: start a new covered span
const TAIL_PAD = 3             // s of audio after the last line's end sent along
const STREAM_CHUNK = 256 * 1024  // PCM bytes per `chunk` message (base64 ≈ 342 KB per line)
const ENTRY_VERSION = 1

function alignedKey(title, artist) { return 'aligned|' + title + '|' + artist }

function splitWords(text) { return String(text || '').split(/\s+/).filter(Boolean) }

/** FNV-1a 32 over the lyric texts: the cache entry is only used for the same lyrics. */
function lyricsHash(lines) {
  let h = 0x811c9dc5
  const s = (lines || []).map((l) => String((l && l.text) || '')).join('\n')
  // loop: one pass over the lyrics' characters (a few KB) · per track change
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h.toString(16).padStart(8, '0')
}

/** Line-synced lyrics without word timing, with some text: the songs alignment can improve. */
function canAlign(raw) {
  return !!raw && raw.length > 0 && raw[0].t != null && !T.hasWordTiming(raw) && raw.some((l) => splitWords(l.text).length)
}

/** [start, end] of the singing, from the first line's start to the last line's end (s). The
 * song is aligned once TAIL_PAD s past the end, while it still plays, or at the track change. */
function lyricSpan(lines) {
  const synced = (lines || []).filter((l) => l.t != null)
  if (!synced.length) return null
  const last = synced[synced.length - 1]
  // the last line has no next anchor: allow it as long as the helper's window does
  return { start: synced[0].t, end: Math.max(T.lineEnd(last, undefined), last.t + 0.6 * splitWords(last.text).length + 3) }
}

/** A stored entry that fits these lyrics, or null. */
function validEntry(entry, hash) {
  return entry && entry.version === ENTRY_VERSION && entry.lyricsHash === hash ? entry : null
}

/**
 * Lines with aligned words applied (new objects; inputs untouched). Only lines whose text and word
 * list still match; they get `aligned: true` and lose `estimated`. -> { lines, used }
 */
function applyAligned(lines, entry) {
  if (!entry || !entry.lines || !lines) return { lines, used: false }
  let used = false
  const out = lines.map((line, i) => {
    const a = entry.lines[i]
    if (!a || a.text !== line.text) return line
    const parts = splitWords(line.text)
    if (!Array.isArray(a.words) || a.words.length !== parts.length || a.words.some((w, k) => w.text !== parts[k])) return line
    used = true
    const next = Object.assign({}, line, { words: a.words.map((w) => ({ t: w.t, end: w.end, text: w.text })), aligned: true })
    delete next.estimated
    return next
  })
  return { lines: out, used }
}

/**
 * The lines to show, by priority: word-timed lyrics (Apple TTML syllables, enhanced LRC) are never
 * touched; otherwise estimate (when that setting is on), then aligned words where a matching cache
 * entry exists. Level 1 runs after this and only refines lines that are still estimated.
 * -> { lines, wordSynced, aligned }
 */
function prepareLines(raw, opts = {}) {
  const lines = raw || []
  if (T.hasWordTiming(lines)) return { lines, wordSynced: true, aligned: false }
  const base = opts.estimate ? T.estimateWords(lines) : lines
  const entry = opts.entry ? validEntry(opts.entry, lyricsHash(lines)) : null
  if (!entry || !entry.lines) return { lines: base, wordSynced: false, aligned: false }
  const got = applyAligned(base, entry)
  return { lines: got.lines, wordSynced: false, aligned: got.used }
}

// --- the recording ---

/**
 * Song-time-indexed s16le stereo buffer, grown in blocks. Chunks are written where they belong in
 * the song; gaps (seeks, pauses not heard) stay silent and are not "covered".
 */
function createSongBuffer(opts = {}) {
  const rate = opts.rate || RATE
  const maxFrames = Math.round((opts.maxSeconds || MAX_SECONDS) * rate)
  const blockFrames = Math.round((opts.blockSeconds || BLOCK_SECONDS) * rate)
  // lifetime: the blocks live until clear() (after the hand-over, track change, close or quit)
  let blocks = new Map()        // block index -> Buffer
  let covered = []              // [[startFrame, endFrame)], sorted, merged

  function addCovered(a, b) {
    const out = []
    let cur = [a, b]
    // loop: merge into the sorted span list · per chunk (~50/s) · a handful of spans (one per seek)
    for (const s of covered) {
      if (s[1] < cur[0]) out.push(s)
      else if (s[0] > cur[1]) { out.push(cur); cur = s }
      else cur = [Math.min(s[0], cur[0]), Math.max(s[1], cur[1])]
    }
    out.push(cur)
    covered = out
  }

  function sample(v) {
    const s = Math.round(v * 32768)
    return s > 32767 ? 32767 : s < -32768 ? -32768 : s
  }

  return {
    /** Writes mid/side floats (from audio-listen.js) starting at song time t0 (s). */
    write(t0, mid, side) {
      let f = Math.round(t0 * rate)
      let i = 0
      if (f < 0) { i = -f; f = 0 }
      const n = Math.min(mid.length, i + maxFrames - f)
      if (n <= i) return
      const first = f
      // loop: one pass over the chunk's frames (~440 per 20 ms chunk) · ends with the chunk
      for (; i < n; i++, f++) {
        const bi = Math.floor(f / blockFrames)
        let b = blocks.get(bi)
        if (!b) { b = Buffer.alloc(blockFrames * FRAME_BYTES); blocks.set(bi, b) }
        const s = side ? side[i] : 0
        const o = (f - bi * blockFrames) * FRAME_BYTES
        b.writeInt16LE(sample(mid[i] + s), o)
        b.writeInt16LE(sample(mid[i] - s), o + 2)
      }
      addCovered(first, f)
    },
    /** Share (0..1) of [from, to] seconds that was heard. */
    coverage(from, to) {
      const a = Math.max(0, Math.round(from * rate))
      const b = Math.round(to * rate)
      if (b <= a) return 0
      let got = 0
      for (const s of covered) got += Math.max(0, Math.min(b, s[1]) - Math.max(a, s[0]))
      return got / (b - a)
    },
    /** Song time (s) up to which audio exists. */
    get end() { return covered.length ? covered[covered.length - 1][1] / rate : 0 },
    get spans() { return covered.map((s) => [s[0] / rate, s[1] / rate]) },
    get bytes() { return blocks.size * blockFrames * FRAME_BYTES },
    /** s16le interleaved PCM from song time 0 to `until` (s), silence where nothing was heard. */
    pcm(until) {
      const frames = Math.max(0, Math.min(Math.round(until * rate), maxFrames))
      const out = Buffer.alloc(frames * FRAME_BYTES)
      // loop: copy the recorded blocks · once per alignment · ≤ 90 blocks
      for (const [bi, b] of blocks) {
        const at = bi * blockFrames * FRAME_BYTES
        if (at >= out.length) continue
        b.copy(out, at, 0, Math.min(b.length, out.length - at))
      }
      return out
    },
    clear() { blocks = new Map(); covered = [] }
  }
}

// --- the request ---

/** The lyric lines as the helper wants them: the original anchors (never estimates) and text. */
function requestLines(raw) {
  return raw.map((l) => {
    const r = { t: l.t, text: String(l.text || '') }
    if (l.end != null) r.end = l.end
    return r
  })
}

/**
 * The helper messages for one alignment (docs/LEVEL2-ALIGN.md, stream mode): the `align` header,
 * the PCM as base64 `chunk`s, then `end`. A generator, so only one chunk is encoded at a time.
 */
function * alignMessages(id, raw, pcm, opts = {}) {
  const size = opts.chunkBytes || STREAM_CHUNK
  const step = size - (size % FRAME_BYTES)
  const head = { cmd: 'align', id, lines: requestLines(raw), audio: { stream: true, format: 's16le', rate: opts.rate || RATE, channels: CHANNELS } }
  if (opts.language) head.language = opts.language
  yield head
  // loop: one message per 256 KB of PCM · ≤ ~330 for a 15 min song · ends with the buffer
  for (let o = 0; o < pcm.length; o += step) {
    yield { cmd: 'chunk', id, data: pcm.subarray(o, Math.min(pcm.length, o + step)).toString('base64') }
  }
  yield { cmd: 'end', id }
}

/**
 * The cache entry from a helper result. Only lines the helper aligned, whose words match the
 * lyrics, that were fully heard, and whose times make sense. -> entry (lines may be empty)
 */
function entryFromResult(result, raw, heard, meta = {}) {
  const lines = {}
  let n = 0
  for (const r of (result && result.lines) || []) {
    const i = r && r.line
    const line = raw[i]
    if (!line || !r.aligned || !Array.isArray(r.words)) continue
    const parts = splitWords(line.text)
    if (r.words.length !== parts.length || r.words.some((w, k) => w.text !== parts[k])) continue
    if (heard && !heard(line, raw[i + 1])) continue
    let prev = -Infinity
    let ok = true
    const words = r.words.map((w) => {
      const t = Number(w.t)
      let end = Number(w.end)
      if (!Number.isFinite(t) || t < prev) ok = false
      if (!Number.isFinite(end) || end <= t) end = t + 0.05
      prev = t
      return { t: Math.round(t * 1000) / 1000, end: Math.round(end * 1000) / 1000, text: w.text }
    })
    if (!ok) continue
    lines[i] = { text: line.text, words }
    n++
  }
  return {
    version: ENTRY_VERSION,
    model: meta.model || (result && result.stats && result.stats.aligner) || '',
    lyricsHash: lyricsHash(raw),
    duration: meta.duration || 0,
    aligned: n,
    total: raw.filter((l) => splitWords(l.text).length).length,
    lines
  }
}

// --- the session ---

/**
 * One alignment session per main process. deps:
 *   createListener(opts) -> { start, stop }   (audio-listen.js, shared with Level 1)
 *   helper: { align(id, messages) -> Promise<result> }   (align-helper.js)
 *   store: { get, set }   send(channel, payload)   now() (ms, same base as the clock)   log
 */
function createAlignSession(deps) {
  const rate = deps.sampleRate || RATE
  const latency = deps.latency == null ? MONITOR_LATENCY : deps.latency
  const log = deps.log || (() => {})
  let listener = null
  let song = null          // { key, title, artist, raw, hash, span, buf, sent }
  let clock = null
  let expectNext = null
  let jobs = 0

  function onChunk(mid, wallMs, side) {
    if (!song || song.sent || !clock || !clock.playing) return
    let t0 = chunkStart(clock, wallMs, mid.length, rate, latency)
    // chunks follow each other: keep them back to back so the audio stays intact; a jump is a seek
    if (expectNext != null && Math.abs(t0 - expectNext) <= GAP_TOLERANCE) t0 = expectNext
    expectNext = t0 + mid.length / rate
    song.buf.write(t0, mid, side)
  }

  function startCapture() {
    if (listener) return
    expectNext = null
    listener = deps.createListener({ sampleRate: rate, onChunk })
    listener.start()
  }

  function stopCapture() {
    if (!listener) return
    listener.stop()
    listener = null
    expectNext = null
  }

  function heardEnough(s) {
    return s.span && s.buf.coverage(s.span.start, s.span.end) >= MIN_COVERAGE
  }

  // hands the recording to the helper and drops it; the result is cached and, if the song is
  // still on screen, sent to the lyric views (lyrics window, visualizer)
  function submit(s) {
    s.sent = true
    if (s === song) stopCapture()
    const until = Math.min(s.buf.end, s.span.end + TAIL_PAD)
    const spans = s.buf.spans
    const pcm = s.buf.pcm(until)
    s.buf.clear()
    const heard = (line, next) => {
      const a = line.t
      const b = T.lineEnd(line, next)
      return spans.some((sp) => sp[0] <= a + 0.05 && sp[1] >= b - 0.05)
    }
    const id = 'a' + (++jobs)
    const started = deps.now()
    let messages = alignMessages(id, s.raw, pcm, { rate })
    // error: helper missing, crashed, timed out or refused (no model for the language) -> one log
    // line; the song keeps its estimated/refined timing. A no-model refusal is remembered so the
    // song isn't recorded again for nothing.
    return Promise.resolve()
      .then(() => deps.helper.align(id, messages))
      .then((result) => {
        messages = null
        const entry = entryFromResult(result, s.raw, heard, { duration: until })
        deps.store.set(alignedKey(s.title, s.artist), entry)
        log('aligned ' + entry.aligned + '/' + entry.total + ' lines of "' + s.title + '" in ' + ((deps.now() - started) / 1000).toFixed(1) + ' s')
        if (song && song.key === s.key && entry.aligned) deps.send('lyrics-aligned', { key: s.key, lines: entry.lines })
        return entry
      })
      .catch((e) => {
        messages = null
        log('alignment failed for "' + s.title + '": ' + (e && e.message))
        if (e && e.code === 'no-model') {
          deps.store.set(alignedKey(s.title, s.artist), { version: ENTRY_VERSION, lyricsHash: s.hash, failed: 'no-model', lines: null })
        }
        return null
      })
  }

  function finish(submitIfHeard) {
    stopCapture()
    const s = song
    song = null
    clock = null
    if (s && !s.sent && submitIfHeard && heardEnough(s)) return submit(s)
    if (s) s.buf.clear()
    return null
  }

  return {
    /** The cached entry for these lyrics, if any (to apply before rendering). */
    entryFor(title, artist, raw) {
      return validEntry(deps.store.get(alignedKey(title, artist)), lyricsHash(raw))
    },
    /**
     * New lyrics on screen. The previous song is aligned if enough of it was heard (track ended).
     * Recording starts for line-only lyrics that have no alignment cached yet.
     */
    setLyrics(key, title, artist, raw, enabled) {
      if (song && song.key === key) return
      finish(true)
      if (!enabled || !canAlign(raw)) return
      const hash = lyricsHash(raw)
      if (validEntry(deps.store.get(alignedKey(title, artist)), hash)) return
      song = { key, title, artist, raw, hash, span: lyricSpan(raw), buf: createSongBuffer({ rate }), sent: false }
    },
    /** Per lyrics poll tick: records while playing; aligns once the lyric span has been heard. */
    tick(playbackTime, isPlaying, enabled) {
      if (!enabled) { finish(false); return null }
      if (!song || song.sent) { stopCapture(); return null }
      const now = deps.now()
      clock = T.syncClock(clock, playbackTime, isPlaying, now)
      if (!clock.playing) { stopCapture(); expectNext = null; return null }
      startCapture()
      if (T.clockTime(clock, now) > song.span.end + TAIL_PAD && heardEnough(song)) return submit(song)
      return null
    },
    /**
     * lifetime: stop() ends the recording (stops our listener handle) and drops the buffer;
     * submitIfHeard aligns a song that was heard far enough (last lyric view closed at the end).
     */
    stop(submitIfHeard) { return finish(!!submitIfHeard) },
    get recording() { return !!listener },
    get bufferBytes() { return song ? song.buf.bytes : 0 },
    _onChunk: onChunk       // tests
  }
}

module.exports = {
  RATE, MIN_COVERAGE, STREAM_CHUNK,
  alignedKey, lyricsHash, canAlign, lyricSpan, applyAligned, prepareLines,
  createSongBuffer, requestLines, alignMessages, entryFromResult, createAlignSession
}
