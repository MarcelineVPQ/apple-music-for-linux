// "Precise word timing (GPU, experimental)": Level 2 of lyrics timing (docs/LEVEL2-ALIGN.md).
// While a lyric view (lyrics window or visualizer) is open and a song with line-only lyrics plays, Sonata's OWN playback
// stream (the Level 1 listener, audio-listen.js) is recorded into a song-time-indexed buffer in
// memory. Section by section (the lines between two interludes, at most SECTION_LINES each), once a
// section has been heard its slice of PCM and its lyric lines are streamed to the sonata-align helper
// (align-helper.js) over its stdin, which separates the vocals and force-aligns the known words on the
// GPU, while the song plays on; the views get each section's words as soon as they are back, and
// lyrics-timing.js carries them to later lines (repeats, the song's pace). After the last section a
// fully heard song is aligned once more as a whole (that result is what stays cached), then the
// buffer is dropped; no audio is ever
// written to disk or sent anywhere. Only the word times are kept, in the lyrics store under
// `aligned|title|artist` (`partial` until every section was aligned).
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
const MIN_COVERAGE = 0.9       // share of a section's lyric span that must have been heard
const GAP_TOLERANCE = 0.25     // s; a bigger jump between chunks is a seek: start a new covered span
const TAIL_PAD = 3             // s of audio after the last line's end sent along
const STREAM_CHUNK = 256 * 1024  // PCM bytes per `chunk` message (base64 ≈ 342 KB per line)
// 2 (0.15.34): word ends follow held notes (sonata_align extend_holds) and carry held / holdFrom;
// version-1 entries are aligned again the next time their song plays with a lyric view open
const ENTRY_VERSION = 2
const SECTION_LINES = 8        // progressive alignment: lines per section at most
const SECTION_PRE = 3          // s of audio before a later section's first line sent along (separation context)
const FRAME = 0.02             // the aligner's frame hop: section slices start on it, so the helper can stitch
                               // the kept sections into the whole-song pass without moving a frame (0.15.37)

function alignedKey(title, artist) { return 'aligned|' + title + '|' + artist }

function splitWords(text) { return String(text || '').split(/\s+/).filter(Boolean) }

/** FNV-1a 32 over the lyric texts: the cache entry is only used for the same lyrics. */
function lyricsHash(lines) {
  let h = 0x811c9dc5
  const s = (lines || []).map((l) => String((l && l.text) || '')).join('\n')
  // loop: NOT-WORTH — one pass over the lyrics' characters (a few KB) · per track change
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
    const next = Object.assign({}, line, { words: a.words.map((w) => T.copyWord(w)), aligned: true })
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
    // loop: HOT-PATH-OK — merge into the sorted span list · per chunk (~50/s) · a handful of spans (one per seek)
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
      // loop: HOT-PATH-OK — one pass over the chunk's frames (~440 per 20 ms chunk) · ends with the chunk
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
      // loop: HOT-PATH-OK — the heard spans (a handful, one per seek), per section check
      for (const s of covered) got += Math.max(0, Math.min(b, s[1]) - Math.max(a, s[0]))
      return got / (b - a)
    },
    /** Song time (s) up to which audio exists. */
    get end() { return covered.length ? covered[covered.length - 1][1] / rate : 0 },
    get spans() { return covered.map((s) => [s[0] / rate, s[1] / rate]) },
    get bytes() { return blocks.size * blockFrames * FRAME_BYTES },
    /** s16le interleaved PCM from song time `from` (default 0) to `until` (s), silence where nothing was heard. */
    pcm(until, from = 0) {
      const f0 = Math.max(0, Math.round(from * rate))
      const frames = Math.max(0, Math.min(Math.round(until * rate), maxFrames) - f0)
      const out = Buffer.alloc(frames * FRAME_BYTES)
      // loop: NOT-WORTH — copy the recorded blocks that overlap · once per alignment · ≤ 90 blocks
      for (const [bi, b] of blocks) {
        const a = bi * blockFrames - f0                         // block start, in frames of `out`
        const lo = Math.max(0, -a), hi = Math.min(blockFrames, frames - a)
        if (hi <= lo) continue
        b.copy(out, (a + lo) * FRAME_BYTES, lo * FRAME_BYTES, hi * FRAME_BYTES)
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
  // separate once per song (0.15.37): the helper keeps a section's stem under its song id and offset
  if (opts.song != null) { head.song = opts.song; head.offset = opts.offset || 0 }
  if (opts.final) head.final = true
  yield head
  // loop: SERIAL-REQUIRED — the helper reads its stdin in order; one message per 256 KB of PCM · ≤ ~330 for a 15 min song · ends with the buffer
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
  // loop: NOT-WORTH — the helper's lines (tens), once per alignment result
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
      const out = { t: Math.round(t * 1000) / 1000, end: Math.round(end * 1000) / 1000, text: w.text }
      // a held note: the aligner followed the voice past the sung word (holdFrom: where the hold starts)
      const from = Number(w.hold_from)
      if (w.held && Number.isFinite(from) && from > t && from < end) { out.held = true; out.holdFrom = Math.round(from * 1000) / 1000 }
      return out
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

// --- progressive sections ---

/** Song time (s) by which line i has surely been sung: its end (Apple), else a guess bounded by the next start. */
function singEnd(raw, i) {
  const line = raw[i]
  const next = raw[i + 1]
  const guess = Math.max(T.lineEnd(line, next), line.t + 0.6 * splitWords(line.text).length + 3)
  if (!next || next.t == null) return guess                   // the last line: as lyricSpan
  return line.end != null ? line.end : Math.min(next.t, guess)
}

/**
 * The song's sections for progressive alignment: the lines between two interludes (the countdown
 * gaps, ≥ 4 s), split evenly into parts of at most SECTION_LINES lines. Each section is aligned once
 * its last line has been sung (TAIL_PAD s after `end`), while the song plays on, so its words reach
 * the views during the first play (repeats and the song's pace carry them to later lines, see
 * lyrics-timing reuseRepeats/repace). -> [{ from, to, start, end, at }] (line indexes, song times)
 */
function sections(raw) {
  const idx = []
  // loop: NOT-WORTH — the song's lines, then its blocks and sections · per song
  for (let i = 0; i < (raw || []).length; i++) if (raw[i].t != null && splitWords(raw[i].text).length) idx.push(i)
  if (!idx.length) return []
  const gaps = new Set(T.findInterludes(raw).map((g) => g.index))
  const blocks = [[]]
  for (const i of idx) {
    if (blocks[blocks.length - 1].length && gaps.has(i)) blocks.push([])
    blocks[blocks.length - 1].push(i)
  }
  const out = []
  // loop: NOT-WORTH — the blocks and their sections (≤ ~10), once per song
  for (const b of blocks) {
    const parts = Math.ceil(b.length / SECTION_LINES)
    const size = Math.ceil(b.length / parts)
    for (let k = 0; k < b.length; k += size) {
      const from = b[k], to = b[Math.min(b.length, k + size) - 1]
      const end = singEnd(raw, to)
      out.push({ from, to, start: raw[from].t, end, at: end + TAIL_PAD })
    }
  }
  return out
}

/**
 * The final whole-song pass from the sections the helper kept (no audio: it only runs the Viterbi
 * again on the stitched stems and emissions). The helper answers code 'no-cache' when it no longer
 * has them; the caller then sends the audio as before.
 */
function finalMessages(id, raw, song) {
  return [{ cmd: 'align', id, song, final: true, lines: requestLines(raw) }]
}

/** A section's helper request: its lines (shifted to the slice) and where its audio slice starts
 * (on the aligner's 20 ms frame grid, so the helper can stitch the sections without a shift). */
function sectionRequest(raw, sec, first) {
  const offset = first ? 0 : Math.max(0, Math.round(Math.floor((sec.start - SECTION_PRE) / FRAME + 1e-9) * FRAME * 1000) / 1000)
  const lines = requestLines(raw.slice(sec.from, sec.to + 1)).map((l) => {
    const r = { t: Math.max(0, l.t - offset), text: l.text }
    if (l.end != null) r.end = l.end - offset
    return r
  })
  return { offset, lines }
}

/** A helper result for a section, in song lines and song time (input to entryFromResult). */
function sectionResult(result, sec, offset) {
  const lines = []
  // loop: NOT-WORTH — the section's lines (≤ ~10), once per alignment result
  for (const r of (result && result.lines) || []) {
    if (!r || !Number.isInteger(r.line)) continue
    lines.push(Object.assign({}, r, {
      line: sec.from + r.line,
      words: Array.isArray(r.words) ? r.words.map((w) => Object.assign({}, w, { t: Number(w.t) + offset, end: Number(w.end) + offset })) : r.words
    }))
  }
  return Object.assign({}, result, { lines })
}

/** prev entry + one section's entry -> the merged entry (new object). */
function mergeEntry(prev, add, sec, total) {
  const lines = Object.assign({}, (prev && prev.lines) || {}, add.lines)
  const done = [...new Set([...((prev && prev.done) || []), sec.from])].sort((a, b) => a - b)
  return Object.assign({}, add, { lines, aligned: Object.keys(lines).length, done, partial: done.length < total })
}

/** prev entry (sections) + the whole-song pass -> the complete entry: whole-song words win. */
function mergeWhole(prev, add, secs) {
  const lines = Object.assign({}, (prev && prev.lines) || {}, add.lines)
  return Object.assign({}, add, { lines, aligned: Object.keys(lines).length, done: secs.map((x) => x.from), partial: false })
}

// --- the session ---

/**
 * One alignment session per main process. deps:
 *   createListener(opts) -> { start, stop }   (audio-listen.js, shared with Level 1)
 *   helper: { align(id, messages) -> Promise<result> }   (align-helper.js)
 *   store: { get, set }   send(channel, payload)   now() (ms, same base as the clock)   log
 *
 * Progressive (0.15.33): the song is aligned section by section while it plays (sections()), one
 * helper job at a time; each section's words are cached (merged into one entry, `partial` until
 * every section was aligned) and sent to the views. A section that wasn't heard (seek) is left out;
 * a partial entry is completed on a later play.
 */
function createAlignSession(deps) {
  const rate = deps.sampleRate || RATE
  const latency = deps.latency == null ? MONITOR_LATENCY : deps.latency
  const log = deps.log || (() => {})
  let listener = null
  let song = null          // { key, title, artist, raw, hash, span, secs, next, buf, sent, failed, entry }
  let clock = null
  let expectNext = null
  let jobs = 0
  let songs = 0
  // lifetime: one promise chain of helper jobs (each holds one section's PCM until it is sent)
  let queue = Promise.resolve()

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

  function heard(s, sec) {
    return s.buf.coverage(sec.start, sec.end) >= MIN_COVERAGE
  }

  // all sections handed over (or missed): stop recording and drop the audio. Without a final pass
  // queued, the helper is told to drop the sections it kept for this song, after its last job.
  function wrapUp(s) {
    s.sent = true
    if (s === song) stopCapture()
    s.buf.clear()
    if (!s.finalQueued && s.kept.size && deps.helper.forget) {
      const job = queue.then(() => deps.helper.forget(s.id))
      queue = job.then(() => {}, () => {})
    }
  }

  // queues one helper job: a section (sec) or, with sec null, the whole song (the final pass, as
  // before 0.15.33: one global alignment is a little better than the sections, so it is what gets
  // cached). The result is merged into the song's cache entry and, if the song is still on screen,
  // sent to the lyric views (lyrics window, visualizer).
  function submit(s, sec) {
    const req = sec ? sectionRequest(s.raw, sec, sec === s.secs[0]) : { offset: 0, lines: requestLines(s.raw) }
    if (!sec) s.finalQueued = true
    const until = Math.min(s.buf.end, (sec ? sec.end : s.span.end) + TAIL_PAD)
    const spans = s.buf.spans
    let pcm = s.buf.pcm(until, req.offset)
    const id = 'a' + (++jobs)
    const lineHeard = (line, next) => {
      const a = line.t
      const b = T.lineEnd(line, next)
      return spans.some((sp) => sp[0] <= a + 0.05 && sp[1] >= b - 0.05)
    }
    const what = sec ? 'lines ' + (sec.from + 1) + '–' + (sec.to + 1) + ' of ' + s.raw.length : 'whole song'
    // error: LOGGED-OK — helper missing, crashed, timed out or refused (no model for the language) -> one log
    // line and no further jobs for this song; its lines keep what they have (aligned sections stay).
    // A no-model refusal is remembered so the song isn't recorded again for nothing.
    // Separate once per song: a section's stem stays in the helper (song id + offset); the final pass
    // uses them when every section of the song was kept in this play, else (or on 'no-cache') the audio.
    const fromKept = () => !sec && s.secs.every((x) => s.kept.has(x.from))
    const run = () => {
      if (s.failed) { pcm = null; return null }
      const started = deps.now()
      const audio = () => { const m = alignMessages(id, req.lines, pcm, sec ? { rate, song: s.id, offset: req.offset } : { rate, song: s.id, final: true }); pcm = null; return m }
      const kept = fromKept()
      let messages = kept ? finalMessages(id, req.lines, s.id) : audio()
      return Promise.resolve()
        .then(() => deps.helper.align(id, messages))
        // error: a final pass the helper can't build from kept sections (no-cache) is sent again with
        // the audio; any other error goes on to the handler below
        .catch((e) => {
          if (!(kept && e && e.code === 'no-cache')) throw e
          log('the helper no longer has the sections of "' + s.title + '": the whole song again from the audio')
          messages = audio()
          return deps.helper.align(id, messages)
        })
        .then((result) => {
          messages = null
          pcm = null
          if (sec && result && result.stats && result.stats.kept) s.kept.add(sec.from)
          const add = entryFromResult(sec ? sectionResult(result, sec, req.offset) : result, s.raw, lineHeard, { duration: until })
          s.entry = sec ? mergeEntry(s.entry, add, sec, s.secCount) : mergeWhole(s.entry, add, s.secs)
          deps.store.set(alignedKey(s.title, s.artist), s.entry)
          log('aligned ' + add.aligned + '/' + (sec ? sec.to - sec.from + 1 : add.total) + ' lines (' + what + ') of "' + s.title + '" in ' + ((deps.now() - started) / 1000).toFixed(1) + ' s')
          if (song && song.key === s.key && add.aligned) deps.send('lyrics-aligned', { key: s.key, lines: add.lines })
          return s.entry
        })
        .catch((e) => {   // error: LOGGED-OK — see the comment above run()
          messages = null
          pcm = null
          s.failed = true
          log('alignment failed for "' + s.title + '": ' + (e && e.message))
          if (e && e.code === 'no-model') {
            deps.store.set(alignedKey(s.title, s.artist), { version: ENTRY_VERSION, lyricsHash: s.hash, failed: 'no-model', lines: null })
          }
          return null
        })
    }
    const job = queue.then(run)
    queue = job.then(() => {}, () => {})
    return job
  }

  // the sections whose audio is complete at song time `time` (all sung ones when final): queued if
  // heard, else skipped. After the last one, the whole song once more if it was all heard (a song of
  // one section: that job was the whole song). -> the last queued job or null
  function due(s, time, final) {
    let job = null
    // loop: HOT-PATH-OK — over the sections not yet handled (≤ ~10 per song) · per tick
    while (s.next < s.secs.length) {
      const sec = s.secs[s.next]
      if (!final && time <= sec.at) break
      if (final && s.buf.end < sec.end - 0.05) break          // not sung yet: nothing more is due
      s.next++
      if (s.skip.has(sec.from) || !heard(s, sec)) continue
      job = submit(s, sec)
    }
    if (s.next < s.secs.length && !final) return job
    if (s.secs.length > 1 && s.buf.end >= s.span.end - 0.05 && s.buf.coverage(s.span.start, s.span.end) >= MIN_COVERAGE) job = submit(s, null)
    wrapUp(s)
    return job
  }

  function finish(submitIfHeard) {
    stopCapture()
    const s = song
    song = null
    clock = null
    if (!s || s.sent) return null
    if (submitIfHeard) return due(s, Infinity, true)
    wrapUp(s)
    return null
  }

  return {
    /** The cached entry for these lyrics, if any (to apply before rendering). */
    entryFor(title, artist, raw) {
      return validEntry(deps.store.get(alignedKey(title, artist)), lyricsHash(raw))
    },
    /**
     * New lyrics on screen. Sections of the previous song still due are aligned if heard (track
     * ended). Recording starts for line-only lyrics that aren't fully aligned yet.
     */
    setLyrics(key, title, artist, raw, enabled) {
      if (song && song.key === key) return
      finish(true)
      if (!enabled || !canAlign(raw)) return
      const hash = lyricsHash(raw)
      const have = validEntry(deps.store.get(alignedKey(title, artist)), hash)
      if (have && !have.partial) return
      const secs = sections(raw)
      const skip = new Set(have && have.partial ? have.done || [] : [])
      if (!secs.some((sec) => !skip.has(sec.from))) return
      song = { id: 's' + (++songs), key, title, artist, raw, hash, span: lyricSpan(raw), secs, secCount: secs.length, skip, next: 0, buf: createSongBuffer({ rate }), sent: false, failed: false, entry: have || null, kept: new Set(), finalQueued: false }
    },
    /** Per lyrics poll tick: records while playing; aligns each section once it has been heard. */
    tick(playbackTime, isPlaying, enabled) {
      if (!enabled) { finish(false); return null }
      if (!song || song.sent) { stopCapture(); return null }
      const now = deps.now()
      clock = T.syncClock(clock, playbackTime, isPlaying, now)
      if (!clock.playing) { stopCapture(); expectNext = null; return null }
      startCapture()
      return due(song, T.clockTime(clock, now), false)
    },
    /**
     * lifetime: stop() ends the recording (stops our listener handle) and drops the buffer;
     * submitIfHeard aligns the sections that were heard (last lyric view closed at the end).
     */
    stop(submitIfHeard) { return finish(!!submitIfHeard) },
    get recording() { return !!listener },
    get bufferBytes() { return song ? song.buf.bytes : 0 },
    _onChunk: onChunk       // tests
  }
}

module.exports = {
  RATE, MIN_COVERAGE, STREAM_CHUNK, SECTION_LINES, ENTRY_VERSION,
  alignedKey, lyricsHash, canAlign, lyricSpan, applyAligned, prepareLines, sections, sectionRequest, finalMessages, sectionResult, mergeEntry, mergeWhole,
  createSongBuffer, requestLines, alignMessages, entryFromResult, createAlignSession
}
