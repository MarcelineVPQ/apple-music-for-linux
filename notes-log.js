// "Sung notes (developer log)" (Settings → Precise timing, Development channel only, off by default;
// docs/LEVEL2-ALIGN.md "Sung notes"): after a song's whole-song alignment the sonata-align helper works
// out the sung notes from the vocal stem it already separated (RMVPE pitch + the note model in
// align/notes.py), and Sonata saves ONLY those notes (no audio, no stem, no pitch frames) as one JSON
// file per song in ~/.local/share/apple-music-for-linux/notes-log/, at most MAX_FILES, oldest removed.
// The files are for Marcy to judge her live tracks (tools/notes-log.js turns one into a note listing
// and a staff PNG); nothing is uploaded or shown in the app.
//
// The pitch model (RMVPE weights, MIT) is downloaded into the helper's models folder only when the
// switch is turned on (size shown in Settings first, size and SHA-256 checked by the helper).
//
// Electron-free: the file name, the document, its schema, the atomic write, the cap and the switch's
// decisions are tested with node --test (test/notes-log.test.js).
'use strict'
const fsMod = require('fs')
const path = require('path')
const { splitWord, hyphenatorFor } = require('./lyrics-syllables')

const FORMAT = 1
const MAX_FILES = 1000
const DIR_NAME = 'notes-log'
// RVC's rmvpe.pt (huggingface.co/lj1995/VoiceConversionWebUI, MIT): the same entry as align/sung_notes.py RMVPE
const RMVPE = {
  bytes: 181184272,
  sha256: '6d62215f4306e3ca278246188607209f09af3dc77ed4232efdd069798c4ec193',
  licence: 'MIT',
  source: 'huggingface.co/lj1995/VoiceConversionWebUI (rmvpe.pt)'
}

/** Bytes as Settings says them: binary units, as a file manager shows the file ("173 MiB"). */
function sizeText(bytes) {
  const mib = bytes / (1024 * 1024)
  return mib >= 1024 ? (mib / 1024).toFixed(1) + ' GiB' : Math.round(mib) + ' MiB'
}

/** ~/.local/share/apple-music-for-linux/notes-log (XDG_DATA_HOME when set to an absolute path outside an app sandbox). */
function logDir(env, inAppSandbox) {
  const home = env.HOME || ''
  const xdg = env.XDG_DATA_HOME
  const base = xdg && path.isAbsolute(xdg) && !(inAppSandbox && inAppSandbox(xdg, home)) ? xdg : path.join(home, '.local', 'share')
  return path.join(base, 'apple-music-for-linux', DIR_NAME)
}

/** Per request line: per word the syllable texts (lyrics-syllables.js, the split the views use), or null = whole. */
function syllableSpec(lines, lang) {
  const hy = hyphenatorFor(lang || 'en')
  // loop: NOT-WORTH — the song's lines and words (hundreds), once per whole-song job
  return (lines || []).map((l) => String((l && l.text) || '').split(/\s+/).filter(Boolean).map((w) => splitWord(w, hy)))
}

function slug(s) {
  const out = String(s || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60)
  return out || 'unknown'
}

/** <yyyymmdd>-<artist>-<title>.json (a song played again the same day replaces its file). */
function fileName(date, artist, title) {
  const d = date.getFullYear() + String(date.getMonth() + 1).padStart(2, '0') + String(date.getDate()).padStart(2, '0')
  return d + '-' + slug(artist) + '-' + slug(title) + '.json'
}

/**
 * The log file: the song's identity, Sonata's version, the models, the tuning and the notes (the
 * helper's part, align/sung_notes.py run + notes.notes_from), plus the confidence.
 * song: { title, artist, album, duration, appleId }; meta: { version, aligner, stats, created, lineOffset }
 */
function buildDoc(part, song, meta = {}) {
  const off = meta.lineOffset || 0
  const shift = (x) => (x == null ? x : x + off)
  return {
    format: FORMAT,
    created: meta.created || new Date().toISOString(),
    sonata: meta.version || '',
    song: {
      title: song.title || '', artist: song.artist || '', album: song.album || '',
      duration: Number(song.duration) || 0, appleId: song.appleId ? String(song.appleId) : null
    },
    models: { f0: part.f0_model || 'rmvpe', notes: part.model || '', aligner: meta.aligner || '', params: part.params || {}, vthr: part.vthr },
    language: part.language || null,
    duration_s: part.duration_s,
    tuning: part.tuning,
    key: part.key,
    beats: part.beats || [], bars: part.bars || [], meter: part.meter == null ? null : part.meter, tempo_bpm: part.tempo_bpm == null ? null : part.tempo_bpm,
    lines: (part.lines || []).map((l) => Object.assign({}, l, { index: shift(l.index) })),
    syllables: (part.syllables || []).map((s) => Object.assign({}, s, { line: shift(s.line) })),
    notes: (part.notes || []).map((n) => ({
      t: n.t, end: n.end, midi: n.midi, cents: n.cents, name: n.name,
      syl_index: n.syl_index, line: shift(n.line), word: n.word, syl: n.syl, melisma: !!n.melisma, conf: n.conf
    })),
    confidence: part.confidence,
    stats: meta.stats || {}
  }
}

const isNum = (v) => typeof v === 'number' && Number.isFinite(v)
const isIntOrNull = (v) => v === null || Number.isInteger(v)

/** The schema check: [] when the document is a valid log file, else the problems (tests and the tool). */
function validateDoc(doc) {
  const bad = []
  if (!doc || typeof doc !== 'object') return ['not an object']
  if (doc.format !== FORMAT) bad.push('format')
  if (typeof doc.sonata !== 'string' || !doc.sonata) bad.push('sonata version')
  const s = doc.song || {}
  if (typeof s.title !== 'string' || typeof s.artist !== 'string' || typeof s.album !== 'string' || !isNum(s.duration) || !(s.appleId === null || typeof s.appleId === 'string')) bad.push('song')
  const m = doc.models || {}
  if (typeof m.f0 !== 'string' || typeof m.notes !== 'string' || typeof m.aligner !== 'string') bad.push('models')
  const t = doc.tuning || {}
  if (!isNum(t.cents) || !isNum(t.a4_hz)) bad.push('tuning')
  if (!doc.key || typeof doc.key.name !== 'string') bad.push('key')
  if (!Array.isArray(doc.notes)) bad.push('notes')
  else {
    // loop: NOT-WORTH — the song's notes (hundreds), once per check
    doc.notes.forEach((n, i) => {
      const ok = n && isNum(n.t) && isNum(n.end) && n.end > n.t && Number.isInteger(n.midi) && Number.isInteger(n.cents) &&
        typeof n.name === 'string' && isIntOrNull(n.syl_index) && isIntOrNull(n.line) && isIntOrNull(n.word) && isIntOrNull(n.syl) &&
        typeof n.melisma === 'boolean' && isNum(n.conf)
      if (!ok) bad.push('note ' + i)
    })
  }
  if (!Array.isArray(doc.lines) || !Array.isArray(doc.syllables)) bad.push('lines/syllables')
  if (!doc.confidence || !isNum(doc.confidence.overall)) bad.push('confidence')
  // no audio, ever: no arrays of samples or pitch frames ride along
  if ('f0' in doc || 'audio' in doc || 'stem' in doc) bad.push('audio or frames in the log')
  return bad
}

/** The *.json log files oldest first (mtime, then name). */
function listLogs(dir, io = fsMod) {
  let names
  // error: NOT-WORTH — no folder yet: nothing logged
  try { names = io.readdirSync(dir) } catch (e) { return [] }
  const out = []
  // loop: NOT-WORTH — ≤ MAX_FILES + 1 files, once per write
  for (const n of names) {
    if (!n.endsWith('.json')) continue
    // error: NOT-WORTH — a file removed meanwhile is skipped
    try { out.push({ name: n, mtime: io.statSync(path.join(dir, n)).mtimeMs }) } catch (e) {}
  }
  return out.sort((a, b) => a.mtime - b.mtime || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
}

/** Keeps the newest `max` log files; removes the rest and stray temp files. -> removed names */
function prune(dir, max = MAX_FILES, io = fsMod, keep = null) {
  const removed = []
  let names = []
  // error: NOT-WORTH — no folder: nothing to prune
  try { names = io.readdirSync(dir) } catch (e) { return removed }
  // loop: NOT-WORTH — the folder's files (≤ ~1000), once per write
  for (const n of names) {
    if (!/\.json\.tmp-\d+$/.test(n)) continue
    // error: NOT-WORTH — an unremovable temp file is tried again next write
    try { io.unlinkSync(path.join(dir, n)); removed.push(n) } catch (e) {}
  }
  const logs = listLogs(dir, io).filter((f) => f.name !== keep)
  const extra = logs.length + (keep ? 1 : 0) - max
  // loop: NOT-WORTH — the oldest extras (usually one), once per write
  for (let i = 0; i < extra; i++) {
    // error: NOT-WORTH — a file removed meanwhile is already gone
    try { io.unlinkSync(path.join(dir, logs[i].name)); removed.push(logs[i].name) } catch (e) {}
  }
  return removed
}

/**
 * Writes one log file atomically (a temp file in the same folder, then rename: a reader never sees half
 * a file), then keeps at most `max` files. -> { file, removed }
 * error: PASSES-ON — a failed write throws to the caller, which shows it in Settings (one line)
 */
function writeLog(dir, doc, opts = {}) {
  const io = opts.io || fsMod
  const name = opts.name || fileName(opts.date || new Date(), doc.song.artist, doc.song.title)
  io.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, name)
  const tmp = file + '.tmp-' + (opts.pid || process.pid)
  io.writeFileSync(tmp, JSON.stringify(doc, null, 1) + '\n', { mode: 0o600 })
  io.renameSync(tmp, file)
  return { file, removed: prune(dir, opts.max || MAX_FILES, io, name) }
}

/**
 * The switch's decisions (main.js wires it). deps: { on() (switch on, Development channel, Precise word
 * timing on), helper: { ping(), prepareNotes() }, status(text), log }
 *   turnedOn()  the switch was just turned on: asks the helper whether RMVPE is there and downloads it
 *               if not (the only download). Nothing happens while on() is false.
 *   learn(pong) a pong from elsewhere (Settings' status): whether RMVPE is there
 *   wanted()    ask for notes on the next whole-song job: on() and RMVPE not known to be missing
 *   model       true / false / null (not known yet)
 */
function createNotesSwitch(deps) {
  let model = null
  let busy = null
  const status = deps.status || (() => {})
  const log = deps.log || (() => {})
  function learn(pong) {
    if (pong && pong.note_models && typeof pong.note_models.rmvpe === 'boolean') model = pong.note_models.rmvpe
    return model
  }
  return {
    turnedOn() {
      if (!deps.on()) return Promise.resolve(model)
      if (busy) return busy
      // error: SHOWN — a failed ping or download (offline, wrong checksum, disk full) is the Settings status line
      busy = Promise.resolve()
        .then(() => deps.helper.ping())
        .then((pong) => {
          if (learn(pong)) { status('Pitch model ready'); return true }
          if (!deps.on()) return model
          status('Downloading the pitch model (' + sizeText(RMVPE.bytes) + ')…')
          log('sung notes: downloading RMVPE (' + RMVPE.bytes + ' bytes)')
          return deps.helper.prepareNotes().then(() => { model = true; status('Pitch model ready'); return true })
        })
        .catch((e) => {   // error: SHOWN — the status line says why (see above)
          model = false
          const why = e && e.code === 'checksum' ? 'the download was damaged (checksum), nothing kept; turn the switch off and on to try again' : (e && e.message) || 'unknown error'
          status('Pitch model download failed: ' + why)
          log('sung notes: ' + why)
          return false
        })
        .finally(() => { busy = null })
      return busy
    },
    learn,
    wanted() { return !!deps.on() && model !== false },
    get model() { return model }
  }
}

module.exports = { FORMAT, MAX_FILES, DIR_NAME, RMVPE, sizeText, logDir, syllableSpec, fileName, buildDoc, validateDoc, listLogs, prune, writeLog, createNotesSwitch }
