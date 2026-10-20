// About → For the Curious: the numbers behind how Sonata times your lyrics, from Sonata's own caches and
// the running app (pure: data in, rows out; no Electron, no files). main.js collects the inputs only while
// the section is open and shown (curious-sampler.js) and sends the rows to the panel.
//
// One rule: only real numbers. Whatever Sonata doesn't keep or can't read says "Not yet known" and why;
// nothing is guessed. Rows are { id, label, value, private? }: a private row (the song's name) is shown
// but never copied into the bug-report text.
//
//   libraryStats(entries, opts)    the lyrics cache (lyrics-store.js entries) -> counts and sizes
//   libraryRows(stats, files)      Your library
//   nowRows(np)                    Now playing
//   hoodRows(hood)                 Under the hood
//   reportText(groups, meta)       "Copy for a bug report": plain text, no lyrics, no song names, no paths
'use strict'
const T = require('./lyrics-timing')
const A = require('./align-session')
const V = require('./version-display')   // the engine version as people see it

const UNKNOWN = 'Not yet known'
const unknown = (why) => UNKNOWN + (why ? ': ' + why : '')
const SINCE = '0.15.42'

// binary units, as a file manager shows them (and as Settings says the pitch model's size)
function sizeText(bytes) {
  const b = Number(bytes) || 0
  if (b < 1024) return b + ' B'
  if (b < 1024 * 1024) return (b / 1024).toFixed(b < 10 * 1024 ? 1 : 0) + ' KiB'
  return (b / (1024 * 1024)).toFixed(b < 10 * 1024 * 1024 ? 1 : 0) + ' MiB'
}
const plural = (n, one, many) => n + ' ' + (n === 1 ? one : (many || one + 's'))
const day = (iso) => (typeof iso === 'string' && /^\d{4}-\d{2}-\d{2}/.test(iso) ? iso.slice(0, 10) : null)

const KIND = (key) => (key.startsWith('aligned|') ? 'aligned' : key.startsWith('refined|') ? 'refined' : 'lyrics')

// the words of an aligned entry's lines: { lines, words, held, confSum, confN }
function entryWords(entry) {
  const out = { lines: 0, words: 0, held: 0, confSum: 0, confN: 0 }
  if (!entry || !entry.lines) return out
  // loop: NOT-WORTH — one aligned song's lines (tens), while For the Curious is open
  for (const l of Object.values(entry.lines)) {
    if (!l || !Array.isArray(l.words)) continue
    out.lines++
    out.words += l.words.length
    // loop: HOT-PATH-OK — one line's words (≤ ~15) · per 5 s refresh (current song), per minute over the library, while open
    out.held += l.words.filter((w) => w && w.held).length
    if (Number.isFinite(l.conf)) { out.confSum += l.conf; out.confN++ }
  }
  return out
}

/**
 * entries: [[key, value, size]] from the lyrics store. opts: { estimate } (Settings → Estimated word timing).
 * A song's timing is what Sonata would show it with: Apple's (or LRCLIB's) word timing > aligned on this PC
 * > refined by listening > estimated (or line timing) > plain text.
 */
function libraryStats(entries, opts) {
  const o = opts || {}
  const byKey = new Map()
  // loop: NOT-WORTH — the lyrics cache (≤ 2,000 entries), on open and once a minute while For the Curious is open
  for (const [key, value] of entries || []) byKey.set(key, value)
  // a song's timing entries sit under the same key as its lyrics (isrc:… or title|artist), or behind an alias
  const pick = (k) => { const v = byKey.get(k); return v && v.alias ? byKey.get(String(v.alias)) : v }
  const s = {
    songs: 0, apple: 0, lrcWords: 0, precise: 0, partial: 0, refined: 0, estimated: 0, lineOnly: 0, plain: 0,
    alignedSongs: 0, alignedLines: 0, words: 0, held: 0, rejected: 0,
    refinedSongs: 0, refinedLines: 0, laterRefinements: 0,
    bytes: { lyrics: 0, aligned: 0, refined: 0 },
    oldest: null, newest: null, undated: 0
  }
  // loop: NOT-WORTH — the same entries once more (≤ 2,000), same cadence
  for (const [key, value, size] of entries || []) {
    const kind = KIND(key)
    s.bytes[kind] += Number(size) || 0
    // an old title|artist key pointing at its recording's ISRC entry (recording-id.js, 0.15.42): counted there
    if (value && value.alias) continue
    if (kind === 'aligned') {
      if (!value || !value.lines) continue
      const w = entryWords(value)
      if (!w.lines) continue
      s.alignedSongs++
      s.alignedLines += w.lines
      s.words += w.words
      s.held += w.held
      s.rejected += Array.isArray(value.rejected) ? value.rejected.length : 0
      const first = day(value.firstAt)
      const last = day(value.lastAt) || first
      if (!first) s.undated++
      if (first && (!s.oldest || first < s.oldest)) s.oldest = first
      if (last && (!s.newest || last > s.newest)) s.newest = last
      continue
    }
    if (kind === 'refined') {
      const lines = value && value.v === 1 && value.lines ? Object.values(value.lines) : []
      if (!lines.length) continue
      s.refinedSongs++
      s.refinedLines += lines.length
      // loop: NOT-WORTH — one song's refined lines (tens)
      for (const l of lines) s.laterRefinements += Math.max(0, (Number(l && l.plays) || 1) - 1)
      continue
    }
    const lines = value && Array.isArray(value.lines) ? value.lines : []
    if (!lines.length) continue
    s.songs++
    if (T.hasWordTiming(lines)) { if (value.source === 'apple') s.apple++; else s.lrcWords++; continue }
    if (lines[0].t == null) { s.plain++; continue }
    const entry = A.validEntry(pick('aligned|' + key), A.lyricsHash(lines), lines)
    if (entry && entry.lines && Object.keys(entry.lines).length) { s.precise++; if (entry.partial) s.partial++; continue }
    const learned = pick('refined|' + key)
    if (learned && learned.v === 1 && learned.lines && Object.keys(learned.lines).length) { s.refined++; continue }
    if (o.estimate) s.estimated++; else s.lineOnly++
  }
  return s
}

const songs = (n) => plural(n, 'song')

/** files: { lyricsFile, linerFile, montageFile, montageDir: { files, bytes }, notesDir: { files, bytes } | null } (bytes or null) */
function libraryRows(s, files, opts) {
  const f = files || {}
  const o = opts || {}
  const rows = [
    { id: 'songs', label: 'Songs with lyrics on this PC', value: songs(s.songs) },
    { id: 'apple', label: 'Apple\'s own word timing', value: songs(s.apple) }
  ]
  if (s.lrcWords) rows.push({ id: 'lrc-words', label: 'Word timing from LRCLIB', value: songs(s.lrcWords) })
  rows.push(
    { id: 'precise', label: 'Sonata\'s precise timing', value: songs(s.precise) + (s.partial ? ' (' + s.partial + ' still partial)' : '') },
    { id: 'refined', label: 'Refined by listening', value: songs(s.refined) },
    o.estimate
      ? { id: 'estimated', label: 'Estimated word timing', value: songs(s.estimated) }
      : { id: 'estimated', label: 'Line timing only', value: songs(s.lineOnly) + ' (Estimated word timing is off)' },
    { id: 'plain', label: 'Plain lyrics, no timing', value: songs(s.plain) },
    { id: 'words', label: 'Words aligned on this PC', value: s.alignedSongs ? plural(s.words, 'word') + ' in ' + plural(s.alignedLines, 'line') + ' of ' + songs(s.alignedSongs) + (s.rejected ? '; ' + plural(s.rejected, 'line') + ' the helper didn\'t trust' : '') : 'None yet' },
    { id: 'held', label: 'Held notes found', value: s.alignedSongs ? plural(s.held, 'word') + ' held past the sung syllable' : 'None yet' },
    { id: 'refinements', label: 'Refinements from later plays', value: s.refinedSongs ? plural(s.laterRefinements, 'line refinement') + ' (' + plural(s.refinedLines, 'line') + ' refined in ' + songs(s.refinedSongs) + ')' : 'None yet' },
    { id: 'favourites', label: 'Favourites', value: unknown('Apple keeps your loved songs, and Sonata doesn\'t read them') },
    { id: 'cache-lyrics', label: 'Lyrics cache', value: f.lyricsFile == null ? 'No file yet' : sizeText(f.lyricsFile) + ' on disk: ' + sizeText(s.bytes.lyrics) + ' lyrics, ' + sizeText(s.bytes.aligned) + ' precise timing, ' + sizeText(s.bytes.refined) + ' refinements' },
    { id: 'cache-liner', label: 'Liner notes cache', value: f.linerFile == null ? 'No file yet' : sizeText(f.linerFile) },
    { id: 'cache-montage', label: 'Montage cache', value: (f.montageFile == null ? 'No file yet' : sizeText(f.montageFile)) + (f.montageDir && f.montageDir.files ? ' + ' + plural(f.montageDir.files, 'photo') + ', ' + sizeText(f.montageDir.bytes) : '') }
  )
  if (f.notesDir) rows.push({ id: 'cache-notes', label: 'Sung notes log', value: plural(f.notesDir.files, 'song') + ', ' + sizeText(f.notesDir.bytes) })
  const undated = s.undated ? ' (' + plural(s.undated, 'song') + ' aligned before ' + SINCE + (s.undated === 1 ? ' carries' : ' carry') + ' no date)' : ''
  rows.push(
    { id: 'oldest', label: 'Oldest alignment', value: s.oldest ? s.oldest + undated : s.alignedSongs ? unknown('songs aligned before ' + SINCE + ' carry no date') : 'None yet' },
    { id: 'newest', label: 'Newest alignment', value: s.newest || (s.alignedSongs ? unknown('songs aligned before ' + SINCE + ' carry no date') : 'None yet') }
  )
  return rows
}

// a notes-log document (notes-log.js buildDoc) -> { melismas, low, high, span, key }
function notesFacts(doc) {
  // loop: HOT-PATH-OK — one song's notes (hundreds) · per 5 s refresh while For the Curious is open
  const notes = doc && Array.isArray(doc.notes) ? doc.notes.filter((n) => n && Number.isFinite(n.midi)) : []
  if (!notes.length) return null
  const groups = new Set()
  let low = notes[0]
  let high = notes[0]
  // loop: NOT-WORTH — one song's notes (hundreds), when its log file is first read while For the Curious is open
  for (const n of notes) {
    if (n.melisma && n.syl_index != null) groups.add(n.syl_index)
    if (n.midi < low.midi) low = n
    if (n.midi > high.midi) high = n
  }
  return { melismas: groups.size, low: low.name || String(low.midi), high: high.name || String(high.midi), span: high.midi - low.midi, key: doc.key && doc.key.name ? doc.key.name : null, stats: doc.stats || {} }
}

/**
 * np: { title, artist, playing, lyrics (the cached lyrics entry | null), aligned, refined (cache entries | null),
 *   notes (the song's notes-log document | null), track ({ key, startAligned, startRefined } from the lyrics feed | null),
 *   trackKey (recording-id.js trackKey of the playing song: what the feed's track.key is),
 *   settings: { estimate, precise, listen, installed, dev } }
 */
function nowRows(np) {
  const n = np || {}
  if (!n.title) return [{ id: 'song', label: 'Song', value: 'Nothing playing' }]
  const st = n.settings || {}
  const key = n.title + '|' + n.artist
  const lines = n.lyrics && Array.isArray(n.lyrics.lines) ? n.lyrics.lines : null
  const rows = [{ id: 'song', label: 'Song', value: n.title + (n.artist ? ' — ' + n.artist : ''), private: true }]
  const wordTimed = lines && T.hasWordTiming(lines)
  const entry = lines && !wordTimed ? A.validEntry(n.aligned, A.lyricsHash(lines), lines) : null
  const aligned = entry && entry.lines && Object.keys(entry.lines).length ? entry : null
  const learned = n.refined && n.refined.v === 1 && n.refined.lines && Object.keys(n.refined.lines).length ? n.refined : null
  const w = entryWords(aligned)
  let source
  if (!lines) source = unknown('no lyrics looked up for this song yet (open the lyrics)')
  else if (wordTimed) source = n.lyrics.source === 'apple' ? 'Apple\'s own word timing' : 'Word timing from LRCLIB'
  else if (lines[0].t == null) source = 'Plain lyrics, no timing'
  else if (aligned) source = 'Precise: ' + (aligned.engine ? 'sonata-align ' + V.short(aligned.engine) : 'sonata-align (version not kept before ' + SINCE + ')') + (aligned.model ? ', ' + aligned.model + ' model' : '') + (aligned.partial ? ', partial' : ', whole song')
  else if (learned) source = 'Refined by listening'
  else source = st.estimate ? 'Estimated' : 'Line timing only'
  rows.push({ id: 'source', label: 'Timing source', value: source })
  if (aligned) {
    const cover = plural(w.lines, 'line') + ' of ' + (aligned.total || w.lines) + ' aligned' + (Array.isArray(aligned.rejected) && aligned.rejected.length ? ', ' + aligned.rejected.length + ' not trusted' : '')
    rows.push({ id: 'score', label: 'Alignment score', value: w.confN ? (w.confSum / w.confN).toFixed(2) + ' mean confidence (0 to 1) · ' + cover : unknown('aligned before ' + SINCE + ', no score kept') + ' · ' + cover })
  } else rows.push({ id: 'score', label: 'Alignment score', value: wordTimed ? 'Not needed: the lyrics carry their own word timing' : unknown(st.precise ? 'not aligned yet' : 'Precise word timing is off') })
  rows.push({ id: 'offset', label: 'Learned voice-start offset', value: unknown('Sonata doesn\'t learn one yet') })
  rows.push({ id: 'held', label: 'Held words', value: aligned ? plural(w.held, 'word') + ' held' : unknown('found by precise timing') })
  const nf = notesFacts(n.notes)
  rows.push({ id: 'melisma', label: 'Melismas', value: nf ? plural(nf.melismas, 'syllable') + ' sung over several notes' : unknown(st.dev ? 'needs the song\'s sung notes (Settings → Precise timing)' : 'needs the sung notes (Development channel)') })
  if (aligned && aligned.workS != null) {
    const dev = aligned.device === 'cuda' ? 'on the GPU' : aligned.device === 'cpu' ? 'on the CPU' : ''
    // loop: NOT-WORTH — 2 stats fields · per 5 s refresh while For the Curious is open
    const notesS = nf ? ['f0_s', 'notes_s'].map((k) => Number(nf.stats[k])).filter(Number.isFinite).reduce((a, b) => a + b, 0) : 0
    rows.push({ id: 'gpu', label: 'Helper time on this song', value: aligned.workS.toFixed(1) + ' s ' + dev + (notesS ? ' + ' + notesS.toFixed(1) + ' s for the sung notes' : '') })
  } else rows.push({ id: 'gpu', label: 'Helper time on this song', value: aligned ? unknown('aligned before ' + SINCE + ', not kept') : 'None' })
  rows.push({ id: 'range', label: 'Vocal range', value: nf ? nf.low + ' to ' + nf.high + ' (' + plural(nf.span, 'semitone') + ')' : unknown('needs the sung notes') })
  rows.push({ id: 'key', label: 'Detected key', value: nf && nf.key ? nf.key : unknown('needs the sung notes') })
  let play
  const t = n.track && n.track.key === (n.trackKey || key) ? n.track : null
  if (!st.precise && !st.listen) play = unknown('Sonata learns from plays only with Precise word timing or Refine by listening on')
  else if (!t) play = unknown('open the lyrics while it plays')
  else if (t.startAligned) play = 'Later play: aligned on an earlier play'
  else if (t.startRefined) play = 'Later play: refined on earlier plays'
  else if (aligned) play = 'First play: aligned during this play'
  else play = 'First play with the lyrics open: nothing learned yet'
  rows.push({ id: 'play', label: 'First or later play', value: play })
  return rows
}

// "float32le 2ch 48000Hz" (PulseAudio / PipeWire sample spec) -> "48 kHz, 2 channels, 32-bit float"
function sampleSpecText(spec) {
  const m = /^(\w+?)(le|be)?\s+(\d+)ch\s+(\d+)Hz$/.exec(String(spec || '').trim())
  if (!m) return null
  const fmt = { float32: '32-bit float', s16: '16-bit', s24: '24-bit', s32: '32-bit', s24_32: '24-bit in 32', u8: '8-bit' }[m[1]] || m[1]
  const hz = Number(m[4])
  return (hz % 1000 ? (hz / 1000).toFixed(1) : hz / 1000) + ' kHz, ' + plural(Number(m[3]), 'channel') + ', ' + fmt
}

const pct = (x) => (x == null ? 'measuring…' : (Math.round(x * 10) / 10).toFixed(1) + ' % CPU')

/**
 * hood: { procs: [{ label, cpu (% of one core | null: first sample), mb, frames: [{ name, fps | null }] }],
 *   totalMb, helper: { state, vram }, audio: { format, latency }, versions: [[label, value]] }
 */
function hoodRows(h) {
  const hood = h || {}
  const rows = []
  // loop: NOT-WORTH — Sonata's processes (≤ ~12), every refresh while For the Curious is open
  ;(hood.procs || []).forEach((p, i) => {
    const fr = (p.frames || []).filter((f) => f.fps != null)
    const frames = !fr.length ? '' : fr.length === 1 ? ' · ' + fr[0].fps + ' frames/s' : ' · frames/s: ' + fr.map((f) => f.name + ' ' + f.fps).join(', ')
    rows.push({ id: 'proc-' + i, label: p.label, value: pct(p.cpu) + ' · ' + Math.round(p.mb) + ' MB' + frames })
  })
  rows.push({ id: 'memory', label: 'Memory in all', value: hood.totalMb == null ? 'measuring…' : Math.round(hood.totalMb) + ' MB (working set of every Sonata process)' })
  const hp = hood.helper || {}
  rows.push({ id: 'helper', label: 'Precise timing helper', value: hp.state || unknown() })
  rows.push({ id: 'vram', label: 'Helper graphics memory', value: hp.vram || unknown() })
  const au = hood.audio || {}
  rows.push({ id: 'audio', label: 'Audio output', value: au.format || unknown() })
  rows.push({ id: 'latency', label: 'Audio latency', value: au.latency || unknown() })
  // loop: NOT-WORTH — a handful of version lines
  for (const [label, value] of hood.versions || []) rows.push({ id: 'v-' + label.toLowerCase().replace(/\W+/g, '-'), label, value })
  return rows
}

const GROUPS = [['library', 'Your library'], ['now', 'Now playing'], ['hood', 'Under the hood']]

/** The bug-report text: every row but the private ones (no lyrics text, no song or artist names, no paths). */
function reportText(groups, meta) {
  const m = meta || {}
  const out = ['Sonata — For the Curious' + (m.at ? ' (' + m.at + ')' : ''), 'No lyrics, song names or personal data are included.']
  // loop: NOT-WORTH — 3 groups of ≤ ~25 rows, once per press of Copy for a bug report
  for (const [id, title] of GROUPS) {
    const rows = ((groups || {})[id] || []).filter((r) => !r.private)
    if (!rows.length) continue
    out.push('', '## ' + title)
    for (const r of rows) out.push(r.label + ': ' + r.value)
  }
  return out.join('\n') + '\n'
}

module.exports = { UNKNOWN, GROUPS, sizeText, libraryStats, libraryRows, notesFacts, nowRows, sampleSpecText, hoodRows, reportText }
