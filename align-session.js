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
// `aligned|isrc:<ISRC>` (`aligned|title|artist` when the ISRC is unknown; recording-id.js), `partial`
// until every section was aligned. An entry's `duration` is the audio that was aligned (≤ the song);
// `songDuration`, `isrc` and `appleId` name the recording (0.15.42).
//
// Priority of word timing: Apple/LRC word timing (never touched) > aligned > refined (Level 1) >
// estimated. Aligned lines lose `estimated`, so Level 1 never refines them.
//
// Electron-free: the buffer, the priority, the cache entry and the request framing are tested with
// node --test (test/align-session.test.js).
const T = require('./lyrics-timing')
const { chunkStart, MONITOR_LATENCY } = require('./listen-session')
const R = require('./recording-id')
const LS = require('./lyrics-syllables')

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
// version-1 entries are aligned again the next time their song plays with a lyric view open.
// 3 (0.15.39): hyphen runs are words (splitWords). A version-2 entry is still used for lyrics without a
// hyphen run (its words are the same), so only the songs whose words changed are aligned again.
const ENTRY_VERSION = 3
const SAME_WORDS_SINCE = 2
const SECTION_LINES = 8        // progressive alignment: lines per section at most
const SECTION_PRE = 3          // s of audio before a later section's first line sent along (separation context)
const PLAIN_END_SLACK = 5     // s: a plain song counts as heard to its end this close to it (the track change comes early)
const STREAM_HOP = 0.25       // s of audio per `chunk` to a look-ahead stream (the engine's hop)
const FRAME = 0.02             // the aligner's frame hop: section slices start on it, so the helper can stitch
                               // the kept sections into the whole-song pass without moving a frame (0.15.38)

function alignedKey(title, artist) { return 'aligned|' + title + '|' + artist }

/**
 * This recording's stored entry (recording-id.js lookup: by ISRC, else title|artist, with the length
 * check). An entry from before 0.15.42 of a "(Live)"-style title is used only when its word times start
 * where these lyrics' lines do and it aligned no more audio than this song has.
 * info: { isrc?, duration?, appleId? } -> { entry, key, song }
 */
function findAligned(store, title, artist, raw, info) {
  const song = R.songOf(Object.assign({}, info, { title, artist }))
  const check = (e) => !(e.duration > song.duration + R.DURATION_TOLERANCE_S && song.duration > 0) && R.timingMatches(e.lines, raw)
  const got = R.lookup(store, 'aligned|', song, { check })
  return { entry: got.entry, key: got.key, song }
}

// a line's words: white space and hyphen runs ("Hey-", "hey-", "ay"), the same split as the estimate
// (lyrics-timing.js) and the helper (align/sonata_align.py split_words)
const splitWords = T.splitWords

/** FNV-1a 32 over the lyric texts: the cache entry is only used for the same lyrics. */
function lyricsHash(lines) {
  let h = 0x811c9dc5
  // loop: NOT-WORTH — the song's lines (tens) · per track change (entryFor, setLyrics, prepareLines), not per tick
  const s = (lines || []).map((l) => String((l && l.text) || '')).join('\n')
  // loop: NOT-WORTH — one pass over the lyrics' characters (a few KB) · per track change
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h.toString(16).padStart(8, '0')
}

// --- lyrics timed for another version (0.15.47; recording-id.js timingMismatch) ---
// When the lyrics' line times don't fit the recording, they are dropped and the helper places the lines
// from the audio alone: its plain-lyrics mode (lines with `t: null`, protocol 1 and 2; engine 0.2.3 bounds
// each line by its positional band, JamendoLyrics AAE 0.257 s with the whole-song separator; 0.2.1 searches
// the whole song). Without line times there are no sections, so such a song is aligned once, as a whole,
// after it was heard to the end; its entry carries `plain: true` (and the rule's `mismatch` numbers), and
// a later play shows the lines at the times the helper found (plainTimed) before anything else.

/** The lyric lines without their timing (t: null; no end, no words): what the views show un-highlighted. */
function untimed(raw) {
  // loop: NOT-WORTH — the song's lines (tens) · once per track change, only for lyrics timed for another version
  return (raw || []).map((l) => {
    const out = { t: null, text: String((l && l.text) || '') }
    if (l && l.agent) out.agent = l.agent
    return out
  })
}

/** Lyrics with some words: the songs the plain-lyrics mode can align (line times not needed). */
function canAlignPlain(raw) {
  // loop: NOT-WORTH — stops at the first line with words · per track change (setLyrics plain path)
  return !!raw && raw.length > 0 && !T.hasWordTiming(raw) && raw.some((l) => splitWords(l && l.text).length)
}

const PLAIN_MIN_SHARE = 0.3   // a plain entry places the lines only when at least this share of them was aligned
const PLAIN_LINE_GAP = 3      // s between unaligned lines before the first / after the last aligned one

/**
 * The lines placed at the times a plain entry found: an aligned line starts at its first word and ends at
 * its last; the lines between two aligned ones share the gap evenly, those before the first and after the
 * last sit PLAIN_LINE_GAP s apart (only to keep the order: they are `quiet`, never lit and given no
 * estimated words, the accuracy rule). No words (applyAligned adds the aligned ones). null when too few
 * lines were aligned to place the rest.
 */
function plainTimed(lines, entry) {
  if (!entry || !entry.plain || !entry.lines || !Array.isArray(lines) || !lines.length) return null
  // loop: NOT-WORTH — the song's lines (tens) · per track change, only with a plain entry
  const at = lines.map((line, i) => {
    const a = entry.lines[i]
    if (!a || a.text !== line.text || !Array.isArray(a.words) || !a.words.length) return null
    return { t: a.words[0].t, end: a.words[a.words.length - 1].end }
  })
  // loop: NOT-WORTH — the song's lines (tens) · per track change, only with a plain entry
  const known = at.map((a, i) => (a ? i : -1)).filter((i) => i >= 0)
  // loop: NOT-WORTH — the song's lines (tens) · per track change, only with a plain entry
  const wordy = lines.filter((l) => splitWords(l.text).length).length
  if (known.length < Math.max(2, PLAIN_MIN_SHARE * wordy)) return null
  // loop: NOT-WORTH — the song's lines (tens) · per track change, only with a plain entry
  const t = at.map((a) => (a ? a.t : null))
  const first = known[0], last = known[known.length - 1]
  const r3 = (v) => Math.round(v * 1000) / 1000
  // loop: NOT-WORTH — the song's lines, once per track change
  const room = at[first].t >= first * PLAIN_LINE_GAP     // else they share the time from 0 evenly
  for (let i = 0; i < first; i++) t[i] = r3(room ? at[first].t - (first - i) * PLAIN_LINE_GAP : at[first].t * i / first)
  for (let i = last + 1; i < lines.length; i++) t[i] = r3(at[last].end + (i - last - 1) * PLAIN_LINE_GAP + 0.1)
  // loop: NOT-WORTH — the aligned lines and the runs between them, once per track change
  for (let k = 0; k + 1 < known.length; k++) {
    const a = known[k], b = known[k + 1]
    const from = at[a].end, to = at[b].t
    for (let i = a + 1; i < b; i++) t[i] = r3(from + (to - from) * (i - a) / (b - a))
  }
  // loop: NOT-WORTH — the song's lines (tens) · per track change, only with a plain entry
  return lines.map((line, i) => {
    const out = { t: t[i], text: line.text }
    if (line.agent) out.agent = line.agent
    if (at[i]) out.end = at[i].end
    else out.quiet = true            // not found in the audio: shown, never lit (no guessed words)
    return out
  })
}

/** Line-synced lyrics without word timing, with some text: the songs alignment can improve. */
function canAlign(raw) {
  // loop: NOT-WORTH — stops at the first line with words · per track change (setLyrics)
  return !!raw && raw.length > 0 && raw[0].t != null && !T.hasWordTiming(raw) && raw.some((l) => splitWords(l.text).length)
}

/** [start, end] of the singing, from the first line's start to the last line's end (s). The
 * song is aligned once TAIL_PAD s past the end, while it still plays, or at the track change. */
// A last line sung close to the song's end (0.15.59): its estimated end (lyricSpan's allowance) ran past the
// recording, so its section was never "heard", the song never got its whole-song pass and was recorded
// again on every play (One Way Street on the album-on-repeat rig). Span and sections end by the song's end.
const END_SLACK = 1.5         // s before the song's length: the track change can come a tick early
/** span and sections cut to the song's length (duration s; 0: unknown) -> { span, secs } */
function fitToSong(span, secs, duration) {
  const cap = Number(duration) > 0 ? Number(duration) - END_SLACK : Infinity
  const fit = (x) => (x.end > cap && cap > x.start ? Object.assign({}, x, { end: cap }, x.at != null ? { at: Math.min(x.at, cap + TAIL_PAD) } : {}) : x)
  return { span: span ? fit(span) : span, secs: secs.map(fit) }
}

function lyricSpan(lines) {
  // loop: NOT-WORTH — the song's lines (tens) · once per track change (setLyrics)
  const synced = (lines || []).filter((l) => l.t != null)
  if (!synced.length) return null
  const last = synced[synced.length - 1]
  // the last line has no next anchor: allow it as long as the helper's window does
  return { start: synced[0].t, end: Math.max(T.lineEnd(last, undefined), last.t + 0.6 * splitWords(last.text).length + 3) }
}

// lyrics whose words are the same under the version-2 split (white space only)
function noHyphenRuns(lines) {
  // loop: NOT-WORTH — the song's lines (tens), only for a version-2 entry · per track change (validEntry)
  return (lines || []).every((l) => splitWords(l && l.text).length === String((l && l.text) || '').split(/\s+/).filter(Boolean).length)
}

/** A stored entry that fits these lyrics (raw: the lyric lines, for a version-2 entry), or null. */
function validEntry(entry, hash, raw) {
  if (!entry || entry.lyricsHash !== hash) return null
  if (entry.version === ENTRY_VERSION) return entry
  return entry.version === SAME_WORDS_SINCE && raw && noHyphenRuns(raw) ? entry : null
}

/**
 * Lines with aligned words applied (new objects; inputs untouched). Only lines whose text and word
 * list still match; they get `aligned: true` and lose `estimated`. -> { lines, used }
 */
function applyAligned(lines, entry) {
  if (!entry || !entry.lines || !lines) return { lines, used: false }
  let used = false
  // loop: NOT-WORTH — the song's lines × their words (hundreds) · once per track change or resend (prepareLines)
  const out = lines.map((line, i) => {
    const a = entry.lines[i]
    if (!a || a.text !== line.text) return line
    const parts = splitWords(line.text)
    if (!Array.isArray(a.words) || a.words.length !== parts.length || a.words.some((w, k) => w.text !== parts[k])) return line
    used = true
    // entries aligned before 0.15.41 heal here, without a new alignment (T.reattributeHolds; a no-op on newer ones)
    const words = T.reattributeHolds(a.words, entry.model).map((w) => T.copyWord(w))
    const next = Object.assign({}, line, { words, aligned: true })
    delete next.estimated
    return next
  })
  return { lines: out, used }
}

/**
 * The lines to show, by priority: word-timed lyrics (Apple TTML syllables, enhanced LRC) are never
 * touched; otherwise estimate (when that setting is on), then aligned words where a matching cache
 * entry exists. Level 1 runs after this and only refines lines that are still estimated.
 * -> { lines, wordSynced, aligned, onset? }  (onset: the entry's stored song offset, see withOffset)
 */
function prepareLines(raw, opts = {}) {
  const lines = raw || []
  // timed for another version (opts.plain; raw: untimed()): a plain entry places the lines, else they stay untimed
  if (opts.plain) {
    const entry = opts.entry && opts.entry.plain ? validEntry(opts.entry, lyricsHash(lines), lines) : null
    const timed = entry ? plainTimed(lines, entry) : null
    if (!timed) return { lines, wordSynced: false, aligned: false, plain: true }
    const got = applyAligned(opts.estimate ? T.estimateWords(timed) : timed, entry)
    return { lines: got.lines, wordSynced: false, aligned: got.used, plain: true, placed: true }
  }
  if (T.hasWordTiming(lines)) return { lines, wordSynced: true, aligned: false }
  const base = opts.estimate ? T.estimateWords(lines) : lines
  const entry = opts.entry ? validEntry(opts.entry, lyricsHash(lines), lines) : null
  if (!entry || !entry.lines) return { lines: base, wordSynced: false, aligned: false }
  const got = applyAligned(base, entry)
  return { lines: got.lines, wordSynced: false, aligned: got.used, onset: Number.isFinite(entry.offset) ? entry.offset : null }
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
  // cache: OK — key=10 s block index; invalidated=clear() in wrapUp (every finish/stop path); bound=90 × 882 KB (79 MB)
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

// --- look-ahead play: the streamed song (lookahead.js; the helper's `stream` job) ---

/** mid/side floats (audio-listen.js) -> s16le interleaved stereo, as the recording stores them. */
function toS16(mid, side) {
  const out = Buffer.alloc(mid.length * FRAME_BYTES)
  const q = (v) => { const x = Math.round(v * 32768); return x > 32767 ? 32767 : x < -32768 ? -32768 : x }
  // loop: HOT-PATH-OK — one pass over the chunk's frames (~440 per 20 ms chunk) while a look-ahead song plays
  for (let i = 0; i < mid.length; i++) {
    const sd = side ? side[i] : 0
    out.writeInt16LE(q(mid[i] + sd), i * FRAME_BYTES)
    out.writeInt16LE(q(mid[i] - sd), i * FRAME_BYTES + 2)
  }
  return out
}

/**
 * The views' message for a stream's committed words ({ line, words }[] from the helper's 'words'): only
 * lines whose words match these lyrics' split, word for word (an index the line doesn't have is dropped).
 * -> { lines: { index: { text, words } } } or null. Words keep `late` (committed after the listener got
 * there: shown at once, no pop).
 */
function streamedMessage(raw, got) {
  const lines = {}
  let n = 0
  // loop: NOT-WORTH — the lines of one 'words' message (one or two per hop)
  for (const g of got || []) {
    const i = g && g.line
    const line = Number.isInteger(i) ? raw[i] : null
    if (!line || !Array.isArray(g.words)) continue
    const parts = splitWords(line.text)
    // loop: HOT-PATH-OK — one line's words (≤ ~15) · per stream 'words' message (one per 0.25 s hop) while a look-ahead song plays
    const words = g.words.map((w, k) => {
      const t = Number(w && w.t)
      const end = Number(w && w.end)
      const at = Number.isInteger(w && w.index) ? w.index : k
      if (!Number.isFinite(t) || parts[at] !== (w && w.text)) return null
      const out = { t: Math.round(t * 1000) / 1000, end: Math.round((Number.isFinite(end) && end > t ? end : t + 0.05) * 1000) / 1000, text: w.text, index: at }
      if (w.late) out.late = true
      return out
    }).filter(Boolean)
    if (!words.length) continue
    lines[i] = { text: line.text, words }
    n++
  }
  return n ? { lines } : null
}

// --- the request ---

/** The lyric lines as the helper wants them: the original anchors (never estimates) and text. */
function requestLines(raw) {
  // loop: NOT-WORTH — the song's or section's lines (tens) · once per helper job (submit/stream), not per frame
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
  // separate once per song (0.15.38): the helper keeps a section's stem under its song id and offset
  if (opts.song != null) { head.song = opts.song; head.offset = opts.offset || 0 }
  if (opts.final) head.final = true
  if (opts.notes) head.notes = true             // sung notes (notes-log.js): the helper keeps this job's stem
  yield head
  // loop: SERIAL-REQUIRED — the helper reads its stdin in order; one message per 256 KB of PCM · ≤ ~330 for a 15 min song · ends with the buffer
  for (let o = 0; o < pcm.length; o += step) {
    yield { cmd: 'chunk', id, data: pcm.subarray(o, Math.min(pcm.length, o + step)).toString('base64') }
  }
  yield { cmd: 'end', id }
}

/**
 * The cache entry from a helper result. Only lines the helper aligned, whose words match the lyrics,
 * that were fully heard, and whose times make sense. -> entry (lines may be empty), with `rejected`:
 * [{ line, confidence }] for the heard lines the helper didn't trust (under its min_conf; logged, and not
 * tried again on a later play: the same audio gives the same verdict). Keeping short vocable lines
 * ("Hey-hey-ay", "whoa oh oh") from a lower confidence was measured and not taken (docs/LYRIC-TIMING.md
 * "Rejected lines").
 */
function entryFromResult(result, raw, heard, meta = {}) {
  const lines = {}
  const model = meta.model || (result && result.stats && result.stats.aligner) || ''
  const rejected = []
  let n = 0
  // loop: NOT-WORTH — the helper's lines (tens), once per alignment result
  for (const r of (result && result.lines) || []) {
    const i = r && r.line
    const line = raw[i]
    if (!line || !Array.isArray(r.words)) continue
    if (heard && !heard(line, raw[i + 1])) continue
    if (!r.aligned) {
      if (splitWords(line.text).length) rejected.push({ line: i, confidence: Number(r.confidence) || 0 })
      continue
    }
    const parts = splitWords(line.text)
    // loop: NOT-WORTH — one line's words (≤ ~15) · once per alignment result
    if (r.words.length !== parts.length || r.words.some((w, k) => w.text !== parts[k])) continue
    let prev = -Infinity
    let ok = true
    // loop: NOT-WORTH — one line's words (≤ ~15) · once per alignment result
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
    // a hold the aligner gave to a function word before the phrase's last word moves to that word
    lines[i] = { text: line.text, words: T.reattributeHolds(words, model) }
    // the helper's confidence in the line (0..1), for About → For the Curious (0.15.42; older entries have none)
    const conf = Number(r.confidence)
    if (Number.isFinite(conf)) lines[i].conf = Math.round(conf * 1000) / 1000
    n++
  }
  const st = (result && result.stats) || {}
  const out = {
    version: ENTRY_VERSION,
    model,
    lyricsHash: lyricsHash(raw),
    duration: meta.duration || 0,
    aligned: n,
    // loop: NOT-WORTH — the song's lines (tens) · once per alignment result
    total: raw.filter((l) => splitWords(l.text).length).length,
    lines,
    rejected
  }
  // what About → For the Curious shows (0.15.42; entries aligned before carry none of it): the helper's
  // version, when the song was aligned, and the seconds of separation and alignment work on its device
  if (meta.engine) out.engine = meta.engine
  if (meta.at) { out.firstAt = meta.at; out.lastAt = meta.at }
  // aligned from the audio alone, the lyrics' line times dropped (recording-id timingMismatch's numbers)
  if (meta.plain) { out.plain = true; if (meta.mismatch) out.mismatch = meta.mismatch }
  const work = jobSeconds(st)
  if (work != null) { out.workS = work; out.device = st.device || '' }
  return out
}

/** A job's separation + emissions + alignment seconds from the helper's stats (model loading left out), or null. */
function jobSeconds(st) {
  // loop: NOT-WORTH — 3 stats fields · once per alignment result
  const parts = ['separate_s', 'emissions_s', 'align_s'].map((k) => Number(st && st[k])).filter(Number.isFinite)
  // loop: NOT-WORTH — ≤ 3 numbers · once per alignment result
  return parts.length ? Math.round(parts.reduce((a, b) => a + b, 0) * 100) / 100 : null
}

// the For the Curious fields of a merged entry: the first alignment's date, the latest one's, and the work
// summed over every job (unknown once one job's seconds are: an entry from before 0.15.42 stays unknown)
function curiousFields(prev, add) {
  const out = {}
  const firstAt = (prev && prev.firstAt) || (prev && prev.lines && Object.keys(prev.lines).length ? null : add.firstAt)
  if (firstAt) out.firstAt = firstAt
  if (add.lastAt) out.lastAt = add.lastAt
  const known = !prev || !prev.lines || !Object.keys(prev.lines).length || prev.workS != null
  if (known && add.workS != null) out.workS = Math.round(((prev && prev.workS) || 0) * 100 + add.workS * 100) / 100
  return out
}

/** The log text for a result's rejected lines: ' · rejected: line 12 (0.14) "Hey-hey…", …' ('' for none). */
function rejectedNote(rejected, raw) {
  if (!rejected || !rejected.length) return ''
  const text = (i) => { const t = String((raw[i] && raw[i].text) || ''); return t.length > 40 ? t.slice(0, 39) + '…' : t }
  // loop: NOT-WORTH — the rejected lines (a handful) · one log line per alignment result
  return ' · rejected: ' + rejected.map((r) => 'line ' + (r.line + 1) + ' (' + r.confidence.toFixed(2) + ') "' + text(r.line) + '"').join(', ')
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
  // loop: NOT-WORTH — the song's interludes (a few) · once per track change (sections)
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
function finalMessages(id, raw, song, notes) {
  const head = { cmd: 'align', id, song, final: true, lines: requestLines(raw) }
  if (notes) head.notes = true
  return [head]
}

/** A section's helper request: its lines (shifted to the slice) and where its audio slice starts
 * (on the aligner's 20 ms frame grid, so the helper can stitch the sections without a shift). */
function sectionRequest(raw, sec, first) {
  const offset = first ? 0 : Math.max(0, Math.round(Math.floor((sec.start - SECTION_PRE) / FRAME + 1e-9) * FRAME * 1000) / 1000)
  // loop: NOT-WORTH — one section's lines (≤ 8) · once per section job
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
      // loop: NOT-WORTH — one line's words (≤ ~15) per result line · once per section result
      words: Array.isArray(r.words) ? r.words.map((w) => Object.assign({}, w, { t: Number(w.t) + offset, end: Number(w.end) + offset })) : r.words
    }))
  }
  return Object.assign({}, result, { lines })
}

// Gaps (0.15.39): a line can be left out of a job that covered it because part of it wasn't heard (a
// seek inside a section, a pause the recording missed). Such lines are `missed` in the entry and their
// section is aligned again on a later play (at most MAX_FILLS plays, so a line that is never fully
// heard, like a last line whose guessed end runs past the song, can't cost GPU time on every play).
// Lines the helper heard but didn't trust are `rejected` ([{ line, confidence }]) and not tried again:
// the same audio gives the same verdict (a new ENTRY_VERSION or rule tries them all again).
const MAX_FILLS = 2

/** The line indexes from..to that have words (the lines a job over them can align). */
function wordLines(raw, from, to) {
  const out = []
  // loop: NOT-WORTH — one section's lines (≤ ~10) or the song's, once per alignment result
  for (let i = from; i <= to; i++) if (raw[i] && raw[i].t != null && splitWords(raw[i].text).length) out.push(i)
  return out
}

// missed / rejected after a job that covered the line indexes `covered`, given the merged lines
function gapsAfter(prev, add, covered, lines) {
  const rejected = new Map()
  // loop: NOT-WORTH — the song's rejected and missed lines (a handful), once per alignment result
  for (const r of [...((prev && prev.rejected) || []), ...(add.rejected || [])]) rejected.set(r.line, r)
  const missed = new Set([...((prev && prev.missed) || []), ...covered])
  for (const k of Object.keys(lines)) { rejected.delete(+k); missed.delete(+k) }
  for (const i of rejected.keys()) missed.delete(i)
  // loop: NOT-WORTH — the song's rejected and missed lines (a handful) · once per alignment result
  return { rejected: [...rejected.values()].sort((a, b) => a.line - b.line), missed: [...missed].sort((a, b) => a - b) }
}

/**
 * prev entry + one section's entry -> the merged entry (new object). Lines aligned before keep their
 * words (on a later play they may be the whole-song pass's); raw (the lyric lines) tracks the gaps.
 */
function mergeEntry(prev, add, sec, total, raw) {
  const lines = Object.assign({}, add.lines, (prev && prev.lines) || {})
  // loop: NOT-WORTH — the song's sections (≤ ~10) · once per section result
  const done = [...new Set([...((prev && prev.done) || []), sec.from])].sort((a, b) => a - b)
  const gaps = raw ? gapsAfter(prev, add, wordLines(raw, sec.from, sec.to), lines) : {}
  const merged = Object.assign({}, add, gaps, { lines, aligned: Object.keys(lines).length, done, partial: done.length < total, whole: !!(prev && prev.whole) })
  delete merged.firstAt; delete merged.workS
  return Object.assign(merged, curiousFields(prev, add))
}

/** prev entry (sections) + the whole-song pass -> the complete entry: whole-song words win. */
function mergeWhole(prev, add, secs, raw) {
  const lines = Object.assign({}, (prev && prev.lines) || {}, add.lines)
  const gaps = raw ? gapsAfter(prev, add, wordLines(raw, 0, raw.length - 1), lines) : {}
  // loop: NOT-WORTH — the song's sections (≤ ~10) · once per whole-song result
  const merged = Object.assign({}, add, gaps, { lines, aligned: Object.keys(lines).length, done: secs.map((x) => x.from), partial: false, whole: true })
  delete merged.firstAt; delete merged.workS
  return Object.assign(merged, curiousFields(prev, add))
}

/**
 * The entry with the song's learned onset (lyrics-timing robustOnset over its aligned lines: first word
 * − the line's stamp) as `offset` (s, + = sung after the stamp) and `offsetSource: 'aligned'`, so a
 * later play starts its estimated lines (rejected or missed ones) right, and the stats can show it.
 * Unchanged when fewer than ONSET_MIN_LINES lines are aligned.
 */
function withOffset(entry, raw) {
  if (!entry || !entry.lines || !raw) return entry
  const delays = []
  // loop: NOT-WORTH — the entry's aligned lines (tens), once per alignment result
  for (const [k, a] of Object.entries(entry.lines)) {
    const line = raw[k]
    if (line && line.t != null && a && Array.isArray(a.words) && a.words.length) delays.push(a.words[0].t - line.t)
  }
  const offset = T.robustOnset(delays)
  if (offset == null) return entry
  return Object.assign({}, entry, { offset: Math.round(offset * 1000) / 1000, offsetSource: 'aligned' })
}

/** The sections a later play aligns again for an entry's missed lines (none once MAX_FILLS plays tried). */
function refillSections(entry, secs) {
  if (!entry || !Array.isArray(entry.missed) || !entry.missed.length || (entry.fills || 0) >= MAX_FILLS) return []
  const missed = new Set(entry.missed)
  // loop: NOT-WORTH — the song's sections (≤ ~10) · once per track change, only for an entry with missed lines
  return secs.filter((sec) => (entry.done || []).includes(sec.from) && missedIn(missed, sec))
}
function missedIn(missed, sec) {
  // loop: NOT-WORTH — one section's line range (≤ ~10), per section once per play
  for (let i = sec.from; i <= sec.to; i++) if (missed.has(i)) return true
  return false
}

// --- sheet notes for lyrics with their own word timing (Apple's word/syllable lyrics, enhanced LRC) ---
// Those lyrics are never aligned (their words are timed already), so they had no vocal stem and no notes.
// With Sheet notes on, such a song is recorded like a line-only one; each section is only separated
// (helper `separate`, the stem kept, its first-play pitch line asked as for an aligned section), and once
// the song was heard to the end the helper works out the notes on the times the lyrics carry (`notes`
// with `given`: these syllables), from the kept sections or the whole song's audio. Nothing is aligned
// and nothing goes into the lyrics store; the notes go to the sheet-notes store like any song's.

/** Line-synced lyrics with their own word timing and words: the songs whose notes come from given times. */
function canGiveNotes(raw) {
  // loop: NOT-WORTH — stops at the first line with words · per track change (setLyrics)
  return !!raw && raw.length > 0 && raw[0].t != null && T.hasWordTiming(raw) && raw.some((l) => Array.isArray(l && l.words) && l.words.length)
}

/**
 * The syllable table for the helper from the lyrics' own times: each lead-vocal word's syllables as the
 * views pop them (Apple's own `syl`, else lyrics-syllables.js's split of the word's [t, end]; a word that
 * doesn't split is one syllable). Background vocals are left out (the melody is the lead line).
 * hyphenate: lyrics-syllables hyphenatorFor(lang) (null: whole words).
 * -> time-ordered [{ t, end, text, line, word, syl, nsyl, word_text }]
 */
const GIVEN_REACH_S = 1.0   // how far a given word's end may reach towards the next word (givenSyllables)
function givenSyllables(raw, hyphenate) {
  // cache: NOT-WORTH — key=none (a local array returned per call); invalidated=new each call; bound=the song's syllables
  const rows = []
  const r3 = (v) => Math.round(v * 1000) / 1000
  // loop: NOT-WORTH — the song's lines, words and syllables (hundreds), once per song
  for (let i = 0; i < (raw || []).length; i++) {
    const line = raw[i]
    if (!line || !Array.isArray(line.words) || !line.words.length) continue
    const words = LS.withSyllables(line.words, hyphenate)
    // loop: NOT-WORTH — one line's words, once per song
    words.forEach((w, k) => {
      if (!w || !(Number(w.end) > Number(w.t))) return
      const parts = Array.isArray(w.syl) && w.syl.length ? w.syl : [w]
      // loop: NOT-WORTH — one word's syllables (a handful), once per song
      parts.forEach((p, j) => {
        const t = Number(p.t), end = Number(p.end)
        if (!Number.isFinite(t) || !(end > t)) return
        rows.push({ t: r3(t), end: r3(end), text: String(p.text == null ? '' : p.text), line: i, word: k, syl: j, nsyl: parts.length, word_text: String(w.text || '') })
      })
    })
  }
  // loop: NOT-WORTH — sort of the song's or section's syllables (hundreds) · once per notes/section-notes job
  rows.sort((a, b) => a.t - b.t || a.line - b.line || a.word - b.word || a.syl - b.syl)
  // a word's last syllable reaches on to the next syllable's start (at most GIVEN_REACH_S more): the lyrics'
  // own word times (Apple's) often end before the held note does, and the helper gives a note to the syllable
  // it starts in only up to 0.15 s after that syllable's end, so a held word lost its note (and Expressive
  // words its stretch) on some plays and not others (Marcy, "I don't mind, I don't mind", 0.15.57)
  // loop: NOT-WORTH — the song's syllables (hundreds), once per song
  for (let k = 0; k < rows.length; k++) {
    const r = rows[k]
    if (r.syl !== r.nsyl - 1) continue
    const next = rows[k + 1]
    const reach = next ? Math.min(next.t, r.end + GIVEN_REACH_S) : r.end
    if (reach > r.end) r.end = r3(reach)
  }
  return rows
}

/**
 * First play: the syllable table of one section's own lines for the helper's section notes (engine feature
 * "section-notes"): the words this play aligned for them (entry.lines), else the lyrics' own word times (lyrics
 * with their own timing), split as the views pop them (givenSyllables). -> { syllables, lines, span } or null
 * (no timed word in the section). span: the section's sung stretch, song s.
 */
function sectionGiven(raw, entry, sec, hyphenate) {
  const from = sec.from
  const to = sec.to
  // loop: NOT-WORTH — the song's lines (tens) · once per section-notes job
  const own = (raw || []).map((l, i) => {
    if (i < from || i > to || !l) return null
    const e = entry && entry.lines && entry.lines[i]
    if (e && Array.isArray(e.words) && e.words.length) return { t: l.t, text: l.text, words: e.words }
    return Array.isArray(l.words) && l.words.length ? l : null
  })
  const syllables = givenSyllables(own, hyphenate)
  if (!syllables.length) return null
  // loop: NOT-WORTH — one section's syllables (≤ ~100) · once per section-notes job
  const span = [Math.round((syllables[0].t - 0.05) * 1000) / 1000, Math.round((Math.max(...syllables.map((x) => x.end)) + 0.3) * 1000) / 1000]
  return { syllables, lines: requestLines(raw || []), span }
}

// a header, then the PCM as base64 chunks and `end` (stream mode), one chunk encoded at a time
function * streamed(head, pcm, opts = {}) {
  const size = opts.chunkBytes || STREAM_CHUNK
  const step = size - (size % FRAME_BYTES)
  yield head
  // loop: SERIAL-REQUIRED — the helper reads its stdin in order; one message per 256 KB of PCM · ≤ ~330 for a 15 min song · ends with the buffer
  for (let o = 0; o < pcm.length; o += step) yield { cmd: 'chunk', id: head.id, data: pcm.subarray(o, Math.min(pcm.length, o + step)).toString('base64') }
  yield { cmd: 'end', id: head.id }
}

/** A section's separate-only job (its stem is kept under the song id and offset). */
function separateMessages(id, pcm, opts = {}) {
  return streamed({ cmd: 'separate', id, song: opts.song, offset: opts.offset || 0, audio: { stream: true, format: 's16le', rate: opts.rate || RATE, channels: CHANNELS } }, pcm, opts)
}

/** The notes on the lyrics' own times: from the kept sections (no pcm), or with the song's audio streamed. */
function givenNotesMessages(id, song, raw, syllables, pcm, opts = {}) {
  const head = { cmd: 'notes', id, song, given: { syllables, lines: requestLines(raw) } }
  if (!pcm) return [head]
  head.audio = { stream: true, format: 's16le', rate: opts.rate || RATE, channels: CHANNELS }
  return streamed(head, pcm, opts)
}

// --- the session ---

/**
 * One alignment session per main process. deps:
 *   createListener(opts) -> { start, stop }   (audio-listen.js, shared with Level 1)
 *   helper: { align(id, messages) -> Promise<result>, notes?(id, song, syl), pitch?, separate?(id, messages),
 *     givenNotes?(id, messages), forget? }   (align-helper.js)
 *   notes?: { wanted(), syl(lines, lang), done(song, result, lineOffset), failed(song, error),
 *     pitchWanted?(), pitch?(song, line, error), missing?(title, artist, lyricsHash) }   sung notes
 *     (notes-log.js, main.js): when wanted, the song's whole-song job (the final pass, or the one
 *     section of a one-section song) asks the helper to keep its stem, and once its words are delivered
 *     a notes job is queued behind whatever waits; the gaming guard skips it like any job.
 *     Sheet notes in the Studio (sheet-notes-model.js): pitchWanted() asks, right after each section's
 *     result, for that section's pitch line (the first play's band; part of the section's job, so the
 *     song's later jobs keep their order); missing() says a fully aligned song has no notes yet, so it
 *     is recorded once more and aligned as a whole for them (no section jobs). Lyrics with their own word
 *     timing (canGiveNotes) that missing() names are recorded for their notes only: each section separated
 *     (separate), then the notes on the lyrics' own times (givenNotes), see "sheet notes for lyrics with
 *     their own word timing" above
 *   store: { get, set }   send(channel, payload)   now() (ms, same base as the clock)   log
 *   resend?(key): a plain song's lines were placed from the audio while it is still on screen (main sends
 *     the song's lyrics again, so the views get them with their new line times)
 *
 * Progressive (0.15.33): the song is aligned section by section while it plays (sections()), one
 * helper job at a time; each section's words are cached (merged into one entry, `partial` until
 * every section was aligned) and sent to the views. A section that wasn't heard (seek) is left out;
 * a partial entry is completed on a later play.
 */
// A streamed line's notes are measured on the engine's own alignment of that line. In a song with repeated choruses
// it can place a line at another repeat (Marcy 2026-10-19, "After Midnight": the band showed syllables of other
// parts at the playhead), and then its notes are another part's audio too. -> whether the part sits on its line's
// own span in the lyrics (Apple's words or line times: STREAM_FIT_S of slack, at least half of it inside), or
// true when the lyrics give no time to check against. A part that doesn't fit is dropped (the pass after the song
// measures it on the right audio).
const STREAM_FIT_S = 1.5
// Stream first (systems research 2026-10-19, "Stream-first scheduling"): the helper runs one job at a time in arrival
// order, so the last song's whole-song pass sent at its end held the next song's look-ahead stream ~16-20 s, past most
// first lines. While look-ahead runs, that pass waits until the next song's stream is ready (or failed, or the next
// song has none) and at most STREAM_FIRST_MS. Which job the helper runs first is the engine's own (a job already
// running there can't be passed): this only orders what Sonata sends.
const STREAM_FIRST_MS = 20000
function streamPartFits(part, raw, i) {
  const line = raw && raw[i]
  if (!line || line.t == null || !part) return true
  // loop: NOT-WORTH — one streamed line's syllables and notes (≤ ~40 each), once per streamed line
  const syl = Array.isArray(part.syllables) ? part.syllables.filter((y) => Number.isFinite(y.t)) : []
  const notes = Array.isArray(part.notes) ? part.notes.filter((n) => Number.isFinite(n.t)) : []
  const xs = syl.length ? syl : notes
  if (!xs.length) return true
  // loop: NOT-WORTH — one streamed line's syllables or notes (≤ ~40), once per streamed line
  const a = Math.min(...xs.map((y) => y.t))
  // loop: NOT-WORTH — as above
  const b = Math.max(...xs.map((y) => (Number.isFinite(y.end) ? y.end : y.t)))
  const words = Array.isArray(line.words) && line.words.length ? line.words : null
  const r0 = words ? words[0].t : line.t
  const r1 = words ? words[words.length - 1].end : T.lineEnd(line, raw[i + 1])
  if (!Number.isFinite(r0) || !Number.isFinite(r1)) return true
  if (Math.abs(a - r0) > STREAM_FIT_S + Math.max(0, (r1 - r0) * 0.25)) return false
  const inside = Math.max(0, Math.min(b, r1 + STREAM_FIT_S) - Math.max(a, r0 - STREAM_FIT_S))
  return inside >= 0.5 * Math.max(0.05, b - a)
}

function createAlignSession(deps) {
  const rate = deps.sampleRate || RATE
  const latency = deps.latency == null ? MONITOR_LATENCY : deps.latency
  const log = deps.log || (() => {})
  let listener = null
  let song = null          // { key, title, artist, raw, hash, span, secs, next, buf, sent, failed, entry }
  let clock = null
  let expectNext = null
  let jobs = 0
  // the songs whose notes job (and so Expressive words' measuring) is queued or running, by lyrics key
  // (main.js expressiveNote: "measuring this song…"); keys only, never the song (its audio buffer)
  // cache: OK — key=the song's lyrics key; invalidated=its notes job ends, or submit()'s job never runs (dropped, paused, s.failed: never()); bound=the jobs queued
  const noting = new Set()
  const notesOn = (s, on) => { s.notesQueued = on; if (on) noting.add(s.key); else noting.delete(s.key) }
  let songs = 0
  const paused = deps.paused || (() => false)    // gaming guard (main.js): no recording, no new jobs
  // processor only (main.js alignCpuOnly, 0.15.59): a first play is timed after the song, as a whole, never
  // section by section while it plays (on a laptop each section took 20-50 s: the helper fell behind the
  // music, its late words re-timed the lines on screen and its queue held every waiting song's audio)
  const slow = deps.slow || (() => false)
  // lifetime: one promise chain of helper jobs (each holds one section's PCM until it is sent)
  let queue = Promise.resolve()
  // The queue never grows beyond the song on screen and the one before it (0.15.59): a job not started yet
  // for an older song is dropped with its audio (that song is timed on a later play). Marcy's laptop had an
  // album on repeat run ahead of the helper for an hour: 3.5 GiB, 53 % CPU, words of songs long gone.
  // cache: OK — key=a queued job not started yet; invalidated=its start, or prune() when its song is two songs back; bound=the jobs of two songs
  const pending = new Set()
  let lastSong = null      // the song heard before the one on screen (its end-of-song jobs still run)
  const current = (x) => x === song || x === lastSong
  // -> start(): true when the job may run now (false: dropped, its audio already freed)
  function track(x, free) {
    const j = { s: x, free }
    pending.add(j)
    return () => {
      if (!pending.delete(j)) return false
      if (current(x)) return true
      free()
      return false
    }
  }
  function prune() {
    const gone = new Set()
    // loop: NOT-WORTH — the jobs queued (a few; at most two songs' worth) · per song change
    for (const j of pending) if (!current(j.s)) { pending.delete(j); j.free(); gone.add(j.s.title) }
    // loop: NOT-WORTH — the songs dropped (one or two) · per song change
    for (const t of gone) log('dropped the waiting work for "' + t + '": it is no longer playing (timed on a later play)')
  }

  function onChunk(mid, wallMs, side) {
    if (!song || song.sent || !clock || !clock.playing) return
    let t0 = chunkStart(clock, wallMs, mid.length, rate, latency)
    // chunks follow each other: keep them back to back so the audio stays intact; a jump is a seek
    if (expectNext != null && Math.abs(t0 - expectNext) <= GAP_TOLERANCE) t0 = expectNext
    expectNext = t0 + mid.length / rate
    // a play that only fills gaps records only the spans of the sections it aligns
    if (song.need && !song.need.some((sp) => t0 + mid.length / rate >= sp[0] && t0 <= sp[1])) return
    song.buf.write(t0, mid, side)
    if (song.stream) feedStream(song, t0, mid, side)
  }

  // look-ahead: the capture goes to the helper's stream in STREAM_HOP pieces as it comes (a jump in song
  // time, a seek, starts a new piece: the helper sees the jump in its `t`)
  function feedStream(s, t0, mid, side) {
    const st = s.stream
    const pcm = toS16(mid, side)
    if (st.parts.length && Math.abs(t0 - st.next) > GAP_TOLERANCE) flushStream(s)
    if (!st.parts.length) st.t = t0
    st.parts.push(pcm)
    st.frames += mid.length
    st.next = t0 + mid.length / rate
    if (st.frames >= STREAM_HOP * rate) flushStream(s)
  }
  function flushStream(s) {
    const st = s.stream
    if (!st || !st.parts.length) return
    st.job.chunk(st.t, st.parts.length === 1 ? st.parts[0] : Buffer.concat(st.parts))
    st.parts = []
    st.frames = 0
  }
  // the stream's words, to the views while the song is on screen
  function onStreamMessage(s, msg) {
    // first play's notes, line by line (engine feature "stream-notes"): like a section's, ahead of the delayed listener
    if (msg.type === 'notes') {
      if (msg.notes && Number.isInteger(msg.line) && !streamPartFits(msg.notes, s.raw, msg.line)) { log('stream of "' + s.title + '": the notes of line ' + (msg.line + 1) + ' were measured at another part of the song: dropped'); return }
      if (msg.notes && Number.isInteger(msg.line) && deps.notes && deps.notes.section) { s.sectionNotes = (s.sectionNotes || 0) + 1; deps.notes.section(s, msg.notes, { from: msg.line, to: msg.line, stream: true }) }
      return
    }
    if (msg.type === 'stream') { s.stream.ready = true; streamNews(); log('streaming "' + s.title + '" ' + s.lookahead + ' ms ahead of the listener (' + (msg.device || '?') + ')'); return }
    // words the lyrics or the cache already time (Apple's own, a learned song's) stay: only the stream's notes are used
    if (msg.type !== 'words' || !song || song !== s || s.wordsKnown) return
    const m = streamedMessage(s.raw, msg.lines)
    // loop: HOT-PATH-OK — the 1-2 lines of one stream 'words' message · per 0.25 s hop while a look-ahead song plays
    if (m) { s.stream.words += Object.values(m.lines).reduce((a, l) => a + l.words.length, 0); deps.send('lyrics-stream', Object.assign({ key: s.key }, m)) }
  }
  function openStream(s) {
    if (!s.lookahead || s.stream || s.streamFailed || !deps.helper.stream || paused()) return
    const id = 'l' + (++jobs)
    const job = deps.helper.stream(id, { song: s.id, lines: requestLines(s.raw), language: s.info && s.info.lang, lead: s.lookahead / 1000, duration: s.info && s.info.duration, rate, notes: sectionNotesOn() }, (msg) => onStreamMessage(s, msg))
    s.stream = { id, job, parts: [], frames: 0, t: 0, next: 0, ready: false, words: 0 }
    // the helper can't stream (no GPU, a refusal, its exit): this song's sections are aligned as before
    // error: LOGGED-OK — one log line; the song plays on (delayed) with section timing
    job.done.then((result) => {
      const st = (result && result.stats) || {}
      log('stream of "' + s.title + '" ended: ' + (st.words != null ? st.words : s.stream ? s.stream.words : 0) + ' words' + (st.late_words != null ? ', ' + st.late_words + ' late' : '') + (st.hop_ms_p95 != null ? ', hop p95 ' + st.hop_ms_p95 + ' ms' : ''))
    }, (e) => {
      if (e && e.code === 'cancelled') return
      log('stream of "' + s.title + '" failed (' + ((e && (e.code || e.message)) || '?') + '): its sections are aligned instead')
      s.streamFailed = (e && e.code) || 'error'
      s.stream = null
      streamNews()
    })
  }
  function closeStream(s, cancel) {
    const st = s.stream
    if (!st) return
    if (cancel) st.job.cancel()
    else { flushStream(s); st.job.end() }
    s.stream = null
  }

  function startCapture() {
    if (song && !song.sent) openStream(song)
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
    // given times, not heard to the end: whatever sections the helper kept for the song are dropped after its jobs
    if (s.given && s.cancelled && deps.helper.forget) {
      const job = queue.then(() => deps.helper.forget(s.id))
      // error: NOT-WORTH — keeps the chain going; helper.forget is sync and catches its own write error
      queue = job.then(() => {}, () => {})
      return
    }
    if (!s.finalQueued && !s.notesQueued && s.kept.size && deps.helper.forget) {
      const job = queue.then(() => deps.helper.forget(s.id))
      // error: NOT-WORTH — keeps the chain going; helper.forget is sync and catches its own write error
      queue = job.then(() => {}, () => {})
    }
  }

  // queues one helper job: a section (sec) or, with sec null, the whole song (the final pass, as
  // before 0.15.33: one global alignment is a little better than the sections, so it is what gets
  // cached). The result is merged into the song's cache entry and, if the song is still on screen,
  // sent to the lyric views (lyrics window, visualizer).
  // waits for the song on screen's stream (see STREAM_FIRST_MS); resolved by streamNews() or the time limit
  // cache: OK — key=a whole-song pass waiting for the next stream; invalidated=that stream ready/failed, no stream, or the limit; bound=the passes queued (1-2)
  let streamWaiters = []
  function streamFirst(s) {
    const ready = () => { const n = song; return !!n && n !== s && (!n.lookahead || !!n.streamFailed || !!(n.stream && n.stream.ready) || n.sent || n.failed) }
    if (ready()) return Promise.resolve()
    return new Promise((resolve) => {
      // loop: NOT-WORTH — the passes waiting (1-2), once when one goes
      const w = { ready, done: () => { clearT(w.timer); streamWaiters = streamWaiters.filter((x) => x !== w); resolve() } }
      // lifetime: OK — one-shot limit per waiting pass, cleared when it goes (streamNews)
      w.timer = setT(() => { log('the whole-song pass of "' + s.title + '" waited ' + STREAM_FIRST_MS / 1000 + ' s for the next song\'s stream: sent now'); w.done() }, STREAM_FIRST_MS)
      streamWaiters.push(w)
    })
  }
  // afterSet: a new song's lyrics were just set; no song kept (nothing to time, switch off): no stream will come
  function streamNews(afterSet) {
    // loop: NOT-WORTH — the passes waiting (1-2), on a song change or a stream's ready / failure
    for (const w of streamWaiters.slice()) if (w.ready() || (afterSet && !song)) w.done()
  }
  const setT = deps.setTimeout || setTimeout
  const clearT = deps.clearTimeout || clearTimeout
  function submit(s, sec) {
    const req = sec ? sectionRequest(s.raw, sec, sec === s.secs[0]) : { offset: 0, lines: requestLines(s.raw) }
    if (!sec) s.finalQueued = true
    // sung notes: only on the whole-song job, from the song's start (a one-section song's section is it)
    const whole = !sec || (s.secs.length === 1 && sec === s.secs[0] && req.offset === 0)
    const notes = whole && !!(deps.notes && deps.notes.wanted() && deps.helper.notes)
    if (notes) notesOn(s, true)
    // a plain song (timed for another version): the whole recording as heard, to its end
    const until = s.plain ? s.buf.end : Math.min(s.buf.end, (sec ? sec.end : s.span.end) + TAIL_PAD)
    const spans = s.buf.spans
    let pcm = s.buf.pcm(until, req.offset)
    const start = track(s, () => { pcm = null })
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
    // loop: NOT-WORTH — the song's sections (≤ ~10) · once per whole-song job
    const fromKept = () => !sec && s.secs.length > 0 && s.secs.every((x) => s.kept.has(x.from))
    // a job that never runs (dropped by prune(), the song failed, skipped while gaming): its notes are no longer
    // measuring (QC 2026-10 #2: 'measuring' stuck for the session), and a whole-song job wrapUp() left the
    // helper's forget to is sent here (#4: the kept sections stayed in the helper)
    const never = () => {
      pcm = null
      if (notes) notesOn(s, false)
      if (!sec && !s.notesQueued && s.kept.size && deps.helper.forget) deps.helper.forget(s.id)
      return null
    }
    const run = () => {
      // the last song's whole-song pass: the next song's stream goes to the helper first (STREAM_FIRST_MS)
      if (!sec && s !== song && deps.streamFirst && deps.streamFirst()) return streamFirst(s).then(go)
      return go()
    }
    const go = () => {
      if (!start()) return never()
      if (s.failed) return never()
      // gaming guard: a job not started yet is skipped; its lines fill in on a later play
      if (paused()) { log('skipped ' + what + ' of "' + s.title + '" (paused while gaming)'); return never() }
      const started = deps.now()
      const audio = () => { const m = alignMessages(id, req.lines, pcm, sec ? { rate, song: s.id, offset: req.offset, notes } : { rate, song: s.id, final: true, notes }); pcm = null; return m }
      const kept = fromKept()
      let messages = kept ? finalMessages(id, req.lines, s.id, notes) : audio()
      return Promise.resolve()
        .then(() => deps.helper.align(id, messages))
        // error: PASSES-ON — a final pass the helper can't build from kept sections (no-cache) is sent
        // again with the audio; any other error goes on to the handler below
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
          // (a plain song was heard whole before it was sent: its lines have no times to check against)
          const add = entryFromResult(sec ? sectionResult(result, sec, req.offset) : result, s.raw, s.plain ? null : lineHeard, { duration: until, engine: deps.engine || '', at: (deps.date ? deps.date() : new Date()).toISOString(), plain: !!s.plain, mismatch: s.plain && s.plain.reason ? s.plain : null })
          s.entry = sec ? mergeEntry(s.entry, add, sec, s.secCount, s.raw) : mergeWhole(s.entry, add, s.secs, s.raw)
          if (s.fills) s.entry.fills = s.fills
          s.entry = withOffset(s.entry, s.raw)
          R.put(deps.store, s.storeKey, s.entry, s.rec)
          log('aligned ' + add.aligned + '/' + (sec ? sec.to - sec.from + 1 : add.total) + ' lines (' + what + ') of "' + s.title + '" in ' + ((deps.now() - started) / 1000).toFixed(1) + ' s' + rejectedNote(add.rejected, s.raw))
          // a plain song's lines get their times only now: main sends the song again (prepareLines places them)
          if (song && song.key === s.key && add.aligned) {
            if (s.plain) { if (deps.resend) deps.resend(s.key) } else deps.send('lyrics-aligned', { key: s.key, lines: add.lines })
          }
          if (notes) submitNotes(s, req.lines, sec ? sec.from : 0)
          if (sec && !whole && s.kept.has(sec.from) && sectionAsked() && deps.helper.pitch) return sectionPitch(s, req.offset, what, sec).then(() => s.entry)
          return s.entry
        })
        .catch((e) => {   // error: LOGGED-OK — see the comment above run()
          messages = null
          pcm = null
          s.failed = true
          if (notes) { notesOn(s, false); deps.notes.failed(s, new Error('the alignment failed, so no notes')) }
          log('alignment failed for "' + s.title + '": ' + (e && e.message))
          if (e && e.code === 'no-model') {
            R.put(deps.store, s.storeKey, { version: ENTRY_VERSION, lyricsHash: s.hash, failed: 'no-model', lines: null }, s.rec)
          }
          return null
        })
    }
    const job = queue.then(run)
    // error: NOT-WORTH — keeps the chain going; run() catches inside (LOGGED-OK) and the caller holds `job`
    queue = job.then(() => {}, () => {})
    return job
  }

  // Sheet notes, first play: the pitch line of a section just aligned, from the stem the helper kept for
  // it (no second separation). Skipped while a game runs. The line goes to main (deps.notes.pitch),
  // which sends it to the Studio's band if the song is still on screen.
  // error: SHOWN — a failure is handed to deps.notes.pitch(song, null, error): the band says the line is missing
  // First play's notes and Expressive words (0.15.66; engine feature "section-notes"): when sectionWanted(), the same
  // job also asks for the section's notes and expression (sectionGiven: its own lines' syllables), handed to
  // deps.notes.section as they come; the whole-song pass after the song still runs and replaces them.
  function sectionAsked() { return !!(deps.notes && ((deps.notes.pitchWanted && deps.notes.pitchWanted()) || sectionNotesOn())) }
  function sectionNotesOn() { return !!(deps.notes && deps.notes.sectionWanted && deps.notes.section && deps.helper.sectionNotes && deps.notes.sectionWanted()) }
  function sectionPitch(s, offset, what, sec) {
    if (paused()) { log('skipped the pitch line of ' + what + ' of "' + s.title + '" (paused while gaming)'); return Promise.resolve() }
    if (!current(s)) return Promise.resolve()
    const qid = 'q' + (++jobs)
    const started = deps.now()
    const given = sec && sectionNotesOn() ? sectionGiven(s.raw, s.entry, sec, LS.hyphenatorFor((s.info && s.info.lang) || 'en')) : null
    if (given && s.info && s.info.lang) given.language = s.info.lang
    if (!given && !(deps.notes.pitchWanted && deps.notes.pitchWanted())) return Promise.resolve()
    return Promise.resolve()
      .then(() => given ? deps.helper.sectionNotes(qid, s.id, offset, given) : deps.helper.pitch(qid, s.id, offset))
      .then((result) => {
        const line = result && result.pitch
        const part = given && result && result.notes
        log((part ? 'notes + pitch line of ' : 'pitch line of ') + what + ' of "' + s.title + '": ' + (part ? (part.notes || []).length + ' notes' + (part.expr ? ', ' + (part.expr.words || []).length + ' expr words' : '') + ', ' : '') +
          (line && line.v ? line.v.length : 0) + ' values in ' + ((deps.now() - started) / 1000).toFixed(1) + ' s')
        if (deps.notes.pitchWanted && deps.notes.pitchWanted()) deps.notes.pitch(s, line || null, line ? null : new Error('no pitch line in the answer'))
        if (part) { s.sectionNotes = (s.sectionNotes || 0) + 1; deps.notes.section(s, part, sec) }
      })
      .catch((e) => {   // error: SHOWN — see above (a section's notes that failed: the whole-song pass after the song has them)
        log('pitch line failed for ' + what + ' of "' + s.title + '": ' + (e && e.message))
        if (deps.notes.pitchWanted && deps.notes.pitchWanted()) deps.notes.pitch(s, null, e)
      })
  }

  // Sung notes: queued after the whole-song result was delivered (behind any job already waiting, so
  // alignment is never delayed by it). The helper answers from the stem it kept; the gaming guard skips
  // it. Afterwards a one-section song's kept section is dropped (wrapUp left that to this job).
  // error: SHOWN — every failure goes to deps.notes.failed (Settings' one-line status); never silent
  function submitNotes(s, lines, lineOffset) {
    const nid = 'n' + (++jobs)
    const syl = deps.notes.syl(lines, s.info && s.info.lang)
    const start = track(s, () => {})
    const run = () => {
      if (!start()) {
        deps.notes.failed(s, Object.assign(new Error('the song is no longer playing'), { code: 'dropped' }))
        return null
      }
      if (paused()) {
        log('skipped the sung notes of "' + s.title + '" (paused while gaming)')
        deps.notes.failed(s, Object.assign(new Error('skipped while a game ran'), { code: 'paused' }))
        return null
      }
      const started = deps.now()
      return Promise.resolve()
        .then(() => deps.helper.notes(nid, s.id, syl))
        .then((result) => {
          log('sung notes of "' + s.title + '": ' + ((result && result.notes && result.notes.notes) || []).length + ' notes in ' + ((deps.now() - started) / 1000).toFixed(1) + ' s')
          deps.notes.done(s, result, lineOffset)
        })
        .catch((e) => {   // error: SHOWN — see above
          log('sung notes failed for "' + s.title + '": ' + (e && e.message))
          deps.notes.failed(s, e)
        })
    }
    const job = queue.then(run).then(() => {
      notesOn(s, false)
      if (!s.finalQueued && s.kept.size && deps.helper.forget) deps.helper.forget(s.id)
    })
    // error: NOT-WORTH — keeps the chain going; run() catches inside (deps.notes.failed, SHOWN)
    queue = job.then(() => {}, () => {})
    return job
  }

  // Sheet notes on given times, one section: separated only (its stem kept in the helper), then its
  // first-play pitch line as for an aligned section. Skipped when the song was left before its end
  // (cancelled), the helper failed for it, or a game runs.
  // error: LOGGED-OK — a failed separation is one log line; the notes job then sends the song's audio
  function submitSeparate(s, sec) {
    const req = sectionRequest(s.raw, sec, sec === s.secs[0])
    const until = Math.min(s.buf.end, sec.end + TAIL_PAD)
    let pcm = s.buf.pcm(until, req.offset)
    const start = track(s, () => { pcm = null })
    const id = 'g' + (++jobs)
    const what = 'lines ' + (sec.from + 1) + '–' + (sec.to + 1) + ' of ' + s.raw.length
    const run = () => {
      if (!start()) return null
      if (s.failed || s.cancelled) { pcm = null; return null }
      if (paused()) { pcm = null; log('skipped separating ' + what + ' of "' + s.title + '" (paused while gaming)'); return null }
      const started = deps.now()
      const messages = separateMessages(id, pcm, { rate, song: s.id, offset: req.offset })
      pcm = null
      return Promise.resolve()
        .then(() => deps.helper.separate(id, messages))
        .then((result) => {
          if (result && result.kept) s.kept.add(sec.from)
          log('separated ' + what + ' of "' + s.title + '" for its notes in ' + ((deps.now() - started) / 1000).toFixed(1) + ' s')
          if (result && result.kept && !s.cancelled && sectionAsked() && deps.helper.pitch) return sectionPitch(s, req.offset, what, sec)
          return null
        })
        .catch((e) => {   // error: LOGGED-OK — see above
          log('separating ' + what + ' of "' + s.title + '" failed: ' + (e && e.message))
          return null
        })
    }
    const job = queue.then(run)
    // error: NOT-WORTH — keeps the chain going; run() catches inside (LOGGED-OK)
    queue = job.then(() => {}, () => {})
    return job
  }

  // Sheet notes on given times, the whole song (heard to the end): the notes on the lyrics' own syllable
  // times, from the sections the helper kept when every one was, else from the song's audio (also on
  // no-stem: the helper restarted). The result goes where an aligned song's notes go (deps.notes.done).
  // error: SHOWN — every failure goes to deps.notes.failed (the band's line, the store's retry count)
  function submitGivenNotes(s) {
    notesOn(s, true)
    let pcm = s.buf.pcm(Math.min(s.buf.end, s.span.end + TAIL_PAD), 0)
    const start = track(s, () => { pcm = null })
    const nid = 'n' + (++jobs)
    const syl = givenSyllables(s.raw, LS.hyphenatorFor((s.info && s.info.lang) || 'en'))
    const run = () => {
      if (!start()) {
        deps.notes.failed(s, Object.assign(new Error('the song is no longer playing'), { code: 'dropped' }))
        return null
      }
      if (s.cancelled) { pcm = null; return null }
      if (paused()) {
        pcm = null
        log('skipped the sheet notes of "' + s.title + '" (paused while gaming)')
        deps.notes.failed(s, Object.assign(new Error('skipped while a game ran'), { code: 'paused' }))
        return null
      }
      const started = deps.now()
      const kept = s.secs.every((x) => s.kept.has(x.from))
      const audio = () => { const m = givenNotesMessages(nid, s.id, s.raw, syl, pcm, { rate }); pcm = null; return m }
      return Promise.resolve()
        .then(() => deps.helper.givenNotes(nid, kept ? givenNotesMessages(nid, s.id, s.raw, syl, null) : audio()))
        // error: PASSES-ON — kept sections the helper no longer has (no-stem): once more with the audio
        .catch((e) => {
          if (!(kept && e && e.code === 'no-stem' && pcm)) throw e
          log('the helper no longer has the sections of "' + s.title + '": its notes from the audio')
          return deps.helper.givenNotes(nid, audio())
        })
        .then((result) => {
          pcm = null
          log('sheet notes of "' + s.title + '" on its own word times: ' + ((result && result.notes && result.notes.notes) || []).length + ' notes in ' + ((deps.now() - started) / 1000).toFixed(1) + ' s')
          deps.notes.done(s, result, 0)
        })
        .catch((e) => {   // error: SHOWN — see above
          pcm = null
          log('sheet notes failed for "' + s.title + '": ' + (e && e.message))
          deps.notes.failed(s, e)
        })
    }
    const job = queue.then(run).then(() => { notesOn(s, false) })
    // error: NOT-WORTH — keeps the chain going; run() catches inside (deps.notes.failed, SHOWN)
    queue = job.then(() => {}, () => {})
    return job
  }

  // the whole lyric span heard (≥ MIN_COVERAGE) up to its end
  function heardWhole(s) {
    return s.buf.end >= s.span.end - 0.05 && s.buf.coverage(s.span.start, s.span.end) >= MIN_COVERAGE
  }

  // the sections whose audio is complete at song time `time` (all sung ones when final): queued if
  // heard, else skipped. After the last one, the whole song once more if it was all heard (a song of
  // one section: that job was the whole song). -> the last queued job or null
  function due(s, time, final) {
    let job = null
    // given times, left before the end (a skip, the view closed): no notes this time; jobs still queued are skipped
    if (s.given && final && !heardWhole(s)) {
      s.cancelled = true
      closeStream(s, true)
      log('no sheet notes for "' + s.title + '" this time: it was not heard to the end')
      unfinished(s)
      wrapUp(s)
      return null
    }
    // look-ahead: the stream times the words while the song plays (no section jobs); at the end the
    // whole song is aligned once, as for any fully heard song (that result is what stays cached)
    if (s.stream || (s.lookahead && !s.streamFailed && deps.helper.stream)) {
      if (!final) return null
      closeStream(s, false)
      // given times: the notes on the lyrics' own times from the whole song (what stays cached)
      if (s.given) job = submitGivenNotes(s)
      else if (s.secs.length && heardWhole(s)) job = submit(s, null)
      else unfinished(s)
      wrapUp(s)
      return job
    }
    // processor only: no section jobs while the song plays; heard to its end, it is timed once as a whole
    // (one job instead of a section per few lines plus the whole); left before its end, the sections heard
    if (s.slow && !s.wholeDone && s.secs.length > 1) {
      if (!final) return null
      if (heardWhole(s)) {
        s.next = s.secs.length
        job = submit(s, null)
        wrapUp(s)
        return job
      }
    }
    // loop: HOT-PATH-OK — over the sections not yet handled (≤ ~10 per song) · per tick
    while (s.next < s.secs.length) {
      const sec = s.secs[s.next]
      if (!final && time <= sec.at) break
      if (final && s.buf.end < sec.end - 0.05) break          // not sung yet: nothing more is due
      s.next++
      if (s.skip.has(sec.from) || !heard(s, sec)) continue
      job = s.given ? submitSeparate(s, sec) : submit(s, sec)
    }
    if (s.next < s.secs.length && !final) return job
    // a plain song (no sections): the whole recording once it was heard to its end
    if (s.plain) {
      if (!final && time < s.span.end) return null
      if (heardWhole(s)) job = submit(s, null)
      else log('"' + s.title + '" was not heard to the end: its lines are placed from the audio on a later play')
      wrapUp(s)
      return job
    }
    if (s.given) {
      if (heardWhole(s)) job = submitGivenNotes(s)
      else { s.cancelled = true; log('no sheet notes for "' + s.title + '" this time: it was not heard to the end'); unfinished(s) }
      wrapUp(s)
      return job
    }
    // (not again on a play that only fills gaps of an entry that had its whole-song pass)
    if (!s.wholeDone && s.secs.length > 1 && s.buf.end >= s.span.end - 0.05 && s.buf.coverage(s.span.start, s.span.end) >= MIN_COVERAGE) job = submit(s, null)
    else if (final && s.sectionNotes) unfinished(s)
    wrapUp(s)
    return job
  }

  // a song left before its end whose sections (or stream lines) brought notes: those are kept (main writes them as
  // a partial entry), so the next play draws them from its start and records the song again for the rest
  function unfinished(s) {
    if (s.sectionNotes && deps.notes && deps.notes.unfinished) deps.notes.unfinished(s)
  }

  function finish(submitIfHeard) {
    stopCapture()
    const s = song
    song = null
    clock = null
    if (s) lastSong = s
    prune()
    if (!s || s.sent) { if (s) closeStream(s, true); return null }
    if (submitIfHeard) return due(s, Infinity, true)
    closeStream(s, true)
    wrapUp(s)
    return null
  }

  return {
    /** The cached entry for these lyrics of this recording (info: { isrc, duration }), if any (to apply before rendering). */
    entryFor(title, artist, raw, info) {
      return validEntry(findAligned(deps.store, title, artist, raw, info).entry, lyricsHash(raw), raw)
    },
    /**
     * New lyrics on screen. Sections of the previous song still due are aligned if heard (track
     * ended). Recording starts for line-only lyrics that aren't fully aligned yet.
     */
    setLyrics(key, title, artist, raw, enabled, info) {
      // error: NOT-WORTH — streamNews only resolves waiters (no throw)
      if (streamWaiters.length) Promise.resolve().then(() => streamNews(true))
      if (song && song.key === key) return
      finish(true)
      // Sheet notes for lyrics with their own word timing: recorded for the notes only (no alignment)
      if (enabled && canGiveNotes(raw) && deps.notes && deps.notes.missing && deps.helper.separate && deps.helper.givenNotes &&
        deps.notes.wanted() && deps.notes.missing(title, artist, lyricsHash(raw))) {
        const fitted = fitToSong(lyricSpan(raw), sections(raw), info && info.duration)
        const secs = fitted.secs
        if (!secs.length) return
        log('recording "' + title + '" for its sheet notes (its own word timing)')
        song = { id: 's' + (++songs), key, title, artist, raw, hash: lyricsHash(raw), span: fitted.span, secs, secCount: secs.length, skip: new Set(), next: 0, buf: createSongBuffer({ rate }), sent: false, failed: false, entry: null, kept: new Set(), finalQueued: false, fills: 0, wholeDone: false, need: null, notesQueued: false, info: info || {}, given: true, cancelled: false,
          // look-ahead play (0.15.70): a delayed first play streams for its line notes; its words stay the lyrics' own
          lookahead: info && info.lookahead > 0 ? info.lookahead : 0, stream: null, streamFailed: '', wordsKnown: true }
        return
      }
      // timed for another version (info.plain: recording-id timingMismatch, or true for a song that has a
      // plain entry; raw: untimed()): aligned once as a whole from the audio, unless a plain entry is complete
      if (enabled && info && info.plain) {
        const dur = Number(info.duration)
        if (!canAlignPlain(raw) || !(dur > 0)) return
        const hash = lyricsHash(raw)
        const found = findAligned(deps.store, title, artist, raw, info)
        const valid = validEntry(found.entry, hash, raw)
        const have = valid && valid.plain ? valid : null      // an entry aligned in the wrong windows is replaced
        const complete = !!(have && !have.partial)
        const notesOnly = complete && !!(deps.notes && deps.notes.missing && deps.notes.missing(title, artist, hash))
        if (complete && !notesOnly) return
        if (notesOnly) log('recording "' + title + '" once more for its sheet notes')
        song = { id: 's' + (++songs), key, title, artist, raw, hash, span: { start: 0, end: Math.max(0, dur - PLAIN_END_SLACK) }, secs: [], secCount: 0, skip: new Set(), next: 0, buf: createSongBuffer({ rate }), sent: false, failed: false, entry: null, kept: new Set(), finalQueued: false, fills: 0, wholeDone: false, need: null, notesQueued: false, info, storeKey: found.key, rec: found.song, plain: typeof info.plain === 'object' ? info.plain : true }
        return
      }
      if (!enabled || !canAlign(raw)) return
      const hash = lyricsHash(raw)
      const found = findAligned(deps.store, title, artist, raw, info)
      const have = validEntry(found.entry, hash, raw)
      const fitted = fitToSong(lyricSpan(raw), sections(raw), info && info.duration)
      const secs = fitted.secs
      // a complete entry with missed lines (0.15.39): their sections once more, on at most MAX_FILLS plays
      const refill = refillSections(have, secs)
      const complete = !!(have && !have.partial && !refill.length)
      // Sheet notes / Expressive words: an entry whose sections are all aligned but whose notes (or their
      // expression) are missing (aligned before the switch was on, or the notes step was skipped): the song
      // is recorded once more and aligned as a whole, for its notes. With missed lines still to fill, that
      // play fills them AND runs the whole-song pass (0.15.54: a refill play used to skip the notes step,
      // so such songs never got their notes or expression on those plays)
      const notesMissing = !!(have && !have.partial && deps.notes && deps.notes.missing && deps.notes.missing(title, artist, hash))
      const notesOnly = complete && notesMissing
      if (complete && !notesOnly) return
      // notes only: no section jobs (a one-section song's section is its whole-song job)
      const skip = notesOnly ? new Set(secs.length > 1 ? secs.map((sec) => sec.from) : [])
        : new Set(have ? (have.done || []).filter((from) => !refill.some((sec) => sec.from === from)) : [])
      if (!notesOnly && !secs.some((sec) => !skip.has(sec.from))) return
      const fills = refill.length ? (have.fills || 0) + 1 : (have && have.fills) || 0
      const wholeDone = !notesMissing && !!(have && have.whole)
      // after the whole-song pass only the sections still to align are recorded (with their slice's margins)
      // loop: NOT-WORTH — the song's sections (≤ ~10) · once per track change, only after a whole-song pass
      const need = wholeDone ? secs.filter((sec) => !skip.has(sec.from)).map((sec) => [sec.start - SECTION_PRE - 1, sec.end + TAIL_PAD + 1]) : null
      if (refill.length) log('filling ' + have.missed.length + ' missed line(s) of "' + title + '" (play ' + fills + ' of ' + MAX_FILLS + ')')
      if (notesOnly) log('recording "' + title + '" once more for its sheet notes')
      else if (notesMissing) log('recording "' + title + '" whole this time, for its sheet notes')
      song = { id: 's' + (++songs), key, title, artist, raw, hash, span: fitted.span, secs, secCount: secs.length, skip, next: 0, buf: createSongBuffer({ rate }), sent: false, failed: false, entry: have || null, kept: new Set(), finalQueued: false, fills, wholeDone, need, notesQueued: false, info: info || {}, storeKey: found.key, rec: found.song,
        // look-ahead play: this first play is heard info.lookahead ms late; its words come from a stream
        // (0.15.70: also a learned song recorded for its notes only: the stream brings them line by line, the
        // cached words stay on screen)
        lookahead: (!have || notesOnly) && !need && info && info.lookahead > 0 ? info.lookahead : 0, stream: null, streamFailed: '', wordsKnown: notesOnly }
      song.slow = !song.lookahead && !!slow()
    },
    /** Per lyrics poll tick: records while playing; aligns each section once it has been heard. */
    tick(playbackTime, isPlaying, enabled, songClock) {
      if (!enabled) { finish(false); return null }
      if (!song || song.sent) { stopCapture(); return null }
      const now = deps.now()
      // songClock: main's one song clock in deps.now()'s base (song-clock.js localize); without it, the raw push smoothed here
      clock = songClock || T.syncClock(clock, playbackTime, isPlaying, now)
      if (!clock.playing) {
        stopCapture(); expectNext = null
        // paused: the stream stays open (it resumes where the audio does); its quiet limit isn't a hang meanwhile
        if (song.stream && song.stream.job.alive) song.stream.job.alive()
        return null
      }
      // gaming guard: nothing is recorded while a game runs, so the sections it covers are not
      // heard (skipped) and fill in on a later play (a partial entry); recording resumes after
      if (paused()) { stopCapture(); expectNext = null; return null }
      startCapture()
      return due(song, T.clockTime(clock, now), false)
    },
    /**
     * lifetime: stop() ends the recording (stops our listener handle) and drops the buffer;
     * submitIfHeard aligns the sections that were heard (last lyric view closed at the end).
     */
    stop(submitIfHeard) { return finish(!!submitIfHeard) },
    get recording() { return !!listener },
    /** Expressive words' state for the song with this lyrics key: 'measuring' (its notes job is queued or
     * running), 'recording' (on screen and being recorded for its notes or alignment), else ''. */
    notesState(key) {
      if (noting.has(key)) return 'measuring'
      // first play: the section notes are flowing (sectionPitch / the stream's line notes): measured as it plays
      return song && song.key === key && !song.sent && !song.failed ? (song.sectionNotes ? 'sections' : 'recording') : ''
    },
    /** A song on screen still needs alignment work (the gaming guard only polls then). */
    get active() { return !!(song && !song.sent) },
    get bufferBytes() { return song ? song.buf.bytes : 0 },
    /** Processor only: the song on screen is being recorded to be timed after it ends (main.js's view note). */
    get learnsAfter() { return !!(song && song.slow && !song.sent && !song.failed && !song.wholeDone && song.secs.length > 1) },
    /** The helper jobs queued and not started (tests, For the Curious). */
    get waiting() { return pending.size },
    /** Look-ahead: the song on screen streams its words ('' none, 'starting', 'streaming', 'failed: code'). */
    get streamState() { return !song || !song.lookahead ? '' : song.streamFailed ? 'failed: ' + song.streamFailed : song.stream ? (song.stream.ready ? 'streaming' : 'starting') : '' },
    _onChunk: onChunk       // tests
  }
}

module.exports = {
  RATE, MIN_COVERAGE, STREAM_CHUNK, SECTION_LINES, ENTRY_VERSION,
  GIVEN_REACH_S, END_SLACK, fitToSong, alignedKey, findAligned, lyricsHash, validEntry, canAlign, untimed, canAlignPlain, plainTimed, canGiveNotes, givenSyllables, sectionGiven, separateMessages, givenNotesMessages, lyricSpan, applyAligned, prepareLines, sections, sectionRequest, finalMessages, sectionResult, mergeEntry, mergeWhole, withOffset,
  MAX_FILLS, refillSections,
  createSongBuffer, requestLines, alignMessages, entryFromResult, rejectedNote, createAlignSession,
  STREAM_HOP, toS16, streamedMessage, streamPartFits, STREAM_FIT_S
}
