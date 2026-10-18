// "Sung notes (developer log)" (notes-log.js, align-session.js notes jobs, main/panel wiring): the switch
// off means no request, no download and no files; the download happens only once the switch is on and a
// bad checksum is handled; the gaming guard skips the notes job; the log file's schema, its atomic write
// and the 1000-file cap. The helper is stubbed (align/test_notes.py covers its side).
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')
const N = require('../notes-log')
const A = require('../align-session')

const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8')
const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'notes-log-test-'))

// the helper's part for a two-line song (the shape align/notes_step.py run returns)
function part() {
  return {
    format: 1, model: 'sonata-notes 2026-10-17', profile: 'stem', viterbi: 'numpy', params: { min_note_s: 0.09 },
    f0_model: 'rmvpe', vthr: 0.7, duration_s: 20,
    tuning: { cents: -3.1, a4_hz: 439.2, strength: 0.7 },
    key: { name: 'G minor', tonic_pc: 7, mode: 'minor', fifths: -2, source: 'ks-notes' },
    beats: [], bars: [], meter: null, tempo_bpm: null,
    lines: [{ index: 0, text: 'oh my', aligned: true, t: 1, end: 2 }, { index: 1, text: 'darling', aligned: true, t: 3, end: 4.5 }],
    syllables: [{ t: 1, end: 1.4, text: 'oh', line: 0, word: 0, syl: 0, nsyl: 1, word_text: 'oh' },
      { t: 3, end: 3.5, text: 'dar', line: 1, word: 0, syl: 0, nsyl: 3, word_text: 'darling' }],
    notes: [{ t: 1, end: 1.3, midi: 67, cents: -4, name: 'G4', conf: 0.9, syl_index: 0, line: 0, word: 0, syl: 0, melisma: true },
      { t: 1.3, end: 1.4, midi: 69, cents: 2, name: 'A4', conf: 0.8, syl_index: 0, line: 0, word: 0, syl: 0, melisma: true, cents_tuning: -3 },
      { t: 6, end: 6.5, midi: 62, cents: 0, name: 'D4', conf: 0.5, syl_index: null, line: null, word: null, syl: null, melisma: false }],
    confidence: { overall: 0.8, note_stability: 0.9, syllables_with_notes: 0.5, notes_on_syllables: 0.66, loud_share: 0.8 },
    language: 'en'
  }
}
const SONG = { title: 'Darling (Live)', artist: 'Goo Goo Dolls', album: 'Live in Buffalo', duration: 241.3, appleId: '1440833098', isrc: 'USRE10400123' }

test('the RMVPE entry matches the helper\'s (size and checksum) and Settings shows its size first', () => {
  const py = read('align/notes_step.py')
  assert.match(py, new RegExp("'bytes': " + N.RMVPE.bytes))
  assert.match(py, new RegExp("'sha256': '" + N.RMVPE.sha256 + "'"))
  assert.equal(N.sizeText(N.RMVPE.bytes), '173 MiB')
  const ui = read('panel-ui.js')
  assert.match(ui, /downloads the RMVPE pitch model \(' \+ \(v\.notesModelSize/)
})

test('log folder: ~/.local/share/apple-music-for-linux/notes-log; a sandboxed XDG_DATA_HOME is ignored', () => {
  assert.equal(N.logDir({ HOME: '/home/m' }), '/home/m/.local/share/apple-music-for-linux/notes-log')
  assert.equal(N.logDir({ HOME: '/home/m', XDG_DATA_HOME: '/data' }), '/data/apple-music-for-linux/notes-log')
  const sandbox = (p) => p.startsWith('/home/m/snap')
  assert.equal(N.logDir({ HOME: '/home/m', XDG_DATA_HOME: '/home/m/snap/codium/1/.local/share' }, sandbox), '/home/m/.local/share/apple-music-for-linux/notes-log')
})

test('schema: the song\'s identity, Sonata\'s version, the models, the tuning, the notes; no audio', () => {
  const doc = N.buildDoc(part(), SONG, { version: '0.15.38-dev.1', aligner: 'en', stats: { f0_s: 0.3 }, created: '2026-10-17T08:00:00.000Z' })
  assert.deepEqual(N.validateDoc(doc), [])
  assert.deepEqual(doc.song, SONG)
  assert.equal(doc.sonata, '0.15.38-dev.1')
  assert.deepEqual(doc.models, { f0: 'rmvpe', notes: 'sonata-notes 2026-10-17', aligner: 'en', params: { min_note_s: 0.09 }, vthr: 0.7 })
  assert.deepEqual(doc.tuning, part().tuning)
  assert.deepEqual(Object.keys(doc.notes[0]).sort(), ['cents', 'conf', 'end', 'line', 'melisma', 'midi', 'name', 'syl', 'syl_index', 't', 'word'])
  assert.equal(doc.notes[2].line, null)
  // a one-section song's lines are numbered from its first lyric line: shifted back to song lines
  const shifted = N.buildDoc(part(), SONG, { version: 'x', lineOffset: 2 })
  assert.deepEqual([shifted.notes[0].line, shifted.lines[1].index, shifted.syllables[1].line, shifted.notes[2].line], [2, 3, 3, null])
  // what the check catches
  const bad = (f) => { const d = JSON.parse(JSON.stringify(doc)); f(d); return N.validateDoc(d) }
  assert.deepEqual(bad((d) => { d.sonata = '' }), ['sonata version'])
  assert.deepEqual(bad((d) => { d.notes[1].end = 1.2 }), ['note 1'])
  assert.deepEqual(bad((d) => { d.notes[0].midi = 'G4' }), ['note 0'])
  assert.deepEqual(bad((d) => { d.song.appleId = 5 }), ['song'])
  assert.deepEqual(bad((d) => { d.f0 = [220, 221] }), ['audio or frames in the log'])
  assert.deepEqual(bad((d) => { delete d.tuning }), ['tuning'])
  assert.equal(N.buildDoc(part(), Object.assign({}, SONG, { appleId: '' }), { version: 'x' }).song.appleId, null)
  // the recording's ISRC (0.15.42): canonical form, null when unknown; logs from before it (no isrc) still pass
  assert.equal(N.buildDoc(part(), Object.assign({}, SONG, { isrc: 'us-re1-04-00123' }), { version: 'x' }).song.isrc, 'USRE10400123')
  assert.equal(N.buildDoc(part(), Object.assign({}, SONG, { isrc: '' }), { version: 'x' }).song.isrc, null)
  assert.deepEqual(bad((d) => { delete d.song.isrc }), [])
  assert.deepEqual(bad((d) => { d.song.isrc = 'not an isrc' }), ['song'])
})

test('file name: date, artist, title, safe characters only', () => {
  assert.equal(N.fileName(new Date(2026, 9, 7, 23, 5), 'Dave Matthews Band', 'Ants Marching (Live at the Gorge)'), '20261007-Dave-Matthews-Band-Ants-Marching-Live-at-the-Gorge.json')
  assert.equal(N.fileName(new Date(2026, 0, 1), 'Björk', '../../etc/passwd'), '20260101-Bjork-etc-passwd.json')
  assert.equal(N.fileName(new Date(2026, 0, 1), '', '???'), '20260101-unknown-unknown.json')
})

test('atomic write: a temp file in the same folder, then a rename; never a write to the final name', () => {
  const ops = []
  const real = fs
  const io = {
    mkdirSync: (...a) => { ops.push(['mkdir', a[0]]); return real.mkdirSync(...a) },
    writeFileSync: (f, ...a) => { ops.push(['write', path.basename(f)]); return real.writeFileSync(f, ...a) },
    renameSync: (a, b) => { ops.push(['rename', path.basename(a), path.basename(b)]); return real.renameSync(a, b) },
    readdirSync: (d) => real.readdirSync(d),
    statSync: (f) => real.statSync(f),
    unlinkSync: (f) => { ops.push(['unlink', path.basename(f)]); return real.unlinkSync(f) }
  }
  const dir = path.join(tmpDir(), 'notes-log')
  const doc = N.buildDoc(part(), SONG, { version: '0.15.38-dev.1' })
  const out = N.writeLog(dir, doc, { io, pid: 42, date: new Date(2026, 9, 17) })
  const name = '20261017-Goo-Goo-Dolls-Darling-Live.json'
  assert.deepEqual(ops.slice(0, 3), [['mkdir', dir], ['write', name + '.tmp-42'], ['rename', name + '.tmp-42', name]])
  assert.equal(out.file, path.join(dir, name))
  assert.deepEqual(N.validateDoc(JSON.parse(fs.readFileSync(out.file, 'utf8'))), [])
  assert.deepEqual(fs.readdirSync(dir), [name])
  assert.equal(fs.statSync(out.file).mode & 0o777, 0o600)
  // a temp file left by a crash is cleaned up by the next write
  fs.writeFileSync(path.join(dir, 'x.json.tmp-7'), '{')
  N.writeLog(dir, doc, { pid: 43, date: new Date(2026, 9, 18) })
  assert.deepEqual(fs.readdirSync(dir).sort(), [name, '20261018-Goo-Goo-Dolls-Darling-Live.json'])
})

test('the cap: at most 1000 files, the oldest removed first; the new file is never the one removed', () => {
  const dir = tmpDir()
  const doc = N.buildDoc(part(), SONG, { version: 'x' })
  const t0 = Date.now() / 1000 - 10000
  for (let i = 0; i < 1005; i++) {
    const f = path.join(dir, 'old-' + String(i).padStart(4, '0') + '.json')
    fs.writeFileSync(f, '{}')
    fs.utimesSync(f, t0 + i, t0 + i)
  }
  fs.writeFileSync(path.join(dir, 'notes.txt'), 'not a log')          // other files are left alone
  const out = N.writeLog(dir, doc, { name: 'new.json' })
  assert.equal(out.removed.length, 6)
  assert.deepEqual(out.removed, ['old-0000.json', 'old-0001.json', 'old-0002.json', 'old-0003.json', 'old-0004.json', 'old-0005.json'])
  const left = fs.readdirSync(dir)
  assert.equal(left.filter((n) => n.endsWith('.json')).length, N.MAX_FILES)
  assert.ok(left.includes('new.json') && left.includes('old-1004.json') && left.includes('notes.txt'))
  // an older file name with a newer time is kept by time, not name
  assert.equal(N.prune(dir, 1000).length, 0)
})

// --- the switch: when the model is downloaded ---

function stubHelper(pong, prepare) {
  const calls = []
  return {
    calls,
    ping: async () => { calls.push('ping'); return pong() },
    prepareNotes: async () => { calls.push('prepare'); return prepare() }
  }
}

test('switch off: no ping, no download; on: the model is downloaded once, then wanted', async () => {
  let on = false
  const status = []
  const h = stubHelper(() => ({ note_models: { rmvpe: false } }), () => ({ ready: true }))
  const sw = N.createNotesSwitch({ on: () => on, helper: h, status: (t) => status.push(t) })
  assert.equal(await sw.turnedOn(), null)
  assert.deepEqual(h.calls, [])
  assert.equal(sw.wanted(), false)
  on = true
  assert.equal(await sw.turnedOn(), true)
  assert.deepEqual(h.calls, ['ping', 'prepare'])
  assert.deepEqual(status, ['Downloading the pitch model (173 MiB)…', 'Pitch model ready'])
  assert.equal(sw.wanted(), true)
  // already there: no second download
  const h2 = stubHelper(() => ({ note_models: { rmvpe: true } }), () => { throw new Error('must not download') })
  const sw2 = N.createNotesSwitch({ on: () => true, helper: h2 })
  assert.equal(await sw2.turnedOn(), true)
  assert.deepEqual(h2.calls, ['ping'])
})

test('a bad checksum: nothing kept, one status line, not wanted; turning it on again retries', async () => {
  const status = []
  let fail = true
  const h = stubHelper(() => ({ note_models: { rmvpe: false } }), () => {
    if (fail) throw Object.assign(new Error('download of rmvpe has the wrong checksum'), { code: 'checksum' })
    return { ready: true }
  })
  const sw = N.createNotesSwitch({ on: () => true, helper: h, status: (t) => status.push(t) })
  assert.equal(await sw.turnedOn(), false)
  assert.match(status[status.length - 1], /^Pitch model download failed: the download was damaged \(checksum\)/)
  assert.equal(sw.wanted(), false)
  fail = false
  assert.equal(await sw.turnedOn(), true)
  assert.equal(sw.wanted(), true)
  assert.deepEqual(h.calls, ['ping', 'prepare', 'ping', 'prepare'])
})

test('main: the download only when Sung notes becomes active; nothing written once it is off', () => {
  const src = read('main.js')
  assert.match(src, /function sungNotesOn\(\) \{ return !!settings\.sungNotesLog && settings\.updateChannel === 'dev' && preciseTimingOn\(\) \}/)
  assert.match(src, /if \(sungNotesOn\(\)\) getNotesSwitch\(\)\.turnedOn\(\)/)
  assert.match(src, /if \(!sungNotesOn\(\) \|\| !result \|\| !result\.notes\) return/)
  assert.match(src, /wanted: \(\) => sungNotesOn\(\) && getNotesSwitch\(\)\.wanted\(\)/)
  assert.equal(require('../settings-store').defaults().sungNotesLog, false)
  assert.match(src, /'alignGamingPause', 'sungNotesLog'/)
})

test('Settings: the switch shows only on the Development channel; wording and theme', () => {
  const ui = read('panel-ui.js')
  const at = ui.indexOf("switchRow('sungNotesLog'")
  const row = ui.slice(at, ui.indexOf('textBlock', at))
  assert.match(row, /'Sung notes \(developer log\)'/)
  assert.match(row, /hidden: \(v\) => !v\.alignInstalled \|\| v\.updateChannel !== 'dev'/)
  assert.match(row, /saves only the notes \(no audio\) to ~\/\.local\/share\/apple-music-for-linux\/notes-log\/, at most 1,000 songs \(about 110 MB\), oldest removed/)
  assert.doesNotMatch(row, /#[0-9a-f]{3,6}\b|rgb\(|style/i)
})

test('build: the new files ship (build.files is an explicit list)', () => {
  const files = require('../package.json').build.files
  for (const f of ['notes-log.js', 'align/notes_step.py', 'align/notes.py', 'align/sung_notes.py', 'align/rmvpe.py']) assert.ok(files.includes(f), f)
})

// --- the session: when a notes job is asked for ---

const VERSES = [{ t: 10, text: 'first verse one' }, { t: 13, text: 'first verse two' }, { t: 30, text: 'second verse one' }, { t: 33, text: 'second verse two' }]
const ONE = [{ t: 10, text: 'only verse one' }, { t: 13, text: 'only verse two' }]

function echo(id, msgs) {
  const head = msgs[0]
  return {
    type: 'result', id, source: 'aligned', stats: Object.assign({ aligner: 'en' }, head.song != null && !head.final ? { kept: true } : {}),
    lines: head.lines.map((l, k) => ({ line: k, aligned: true, confidence: 0.6, words: l.text.split(' ').map((w, j) => ({ t: l.t + 0.4 * j, end: l.t + 0.4 * j + 0.3, text: w })) }))
  }
}

function setup(opts = {}) {
  let nowMs = 0
  const calls = []
  const done = []
  const failed = []
  const helper = {
    align: async (id, messages) => { const m = [...messages]; calls.push(m); if (opts.onAlign) opts.onAlign(); return echo(id, m) },
    forget: (song) => calls.push([{ cmd: 'forget', song }]),
    notes: async (id, song, syl) => {
      calls.push([{ cmd: 'notes', id, song, syl }])
      if (opts.notesError) throw opts.notesError
      return { type: 'result', id, notes: part(), stats: { f0_s: 0.3 } }
    }
  }
  const s = A.createAlignSession({
    createListener: () => ({ start() {}, stop() {} }),
    helper,
    store: { get: () => null, set: () => {} },
    send: () => {},
    now: () => nowMs,
    log: () => {},
    latency: 0,
    paused: opts.paused,
    notes: opts.noNotes ? undefined : {
      wanted: opts.wanted || (() => true),
      syl: N.syllableSpec,
      done: (song, r, off) => done.push([song.title, r.notes.notes.length, off, song.info]),
      failed: (song, e) => failed.push([song.title, e.code || e.message])
    }
  })
  return { s, calls, done, failed, setNow: (v) => { nowMs = v } }
}

function play(env, from, to) {
  const chunk = new Float32Array(2205).fill(0.1)
  let res = null
  for (let t = from; t < to - 1e-9; t += 0.5) {
    env.setNow(t * 1000)
    res = env.s.tick(t, true, true) || res
    for (let k = 0; k < 5; k++) if (env.s.recording) env.s._onChunk(chunk, (t + (k + 1) * 0.1) * 1000, null)
  }
  return res
}
const settle = () => new Promise((r) => setTimeout(r, 10))

test('session, switch off: no notes flag, no notes request (so the helper keeps nothing)', async () => {
  for (const env of [setup({ wanted: () => false }), setup({ noNotes: true })]) {
    env.s.setLyrics('Song|A', 'Song', 'A', VERSES, true)
    const secs = A.sections(VERSES)
    await play(env, 0, secs[0].at + 1)
    await play(env, secs[0].at + 1, secs[1].at + 1)
    await settle()
    assert.ok(env.calls.every((c) => c[0].notes === undefined && c[0].cmd !== 'notes'))
    assert.deepEqual([env.done, env.failed], [[], []])
  }
})

test('session, switch on: only the whole-song job asks to keep its stem; the notes job comes after its result', async () => {
  const env = setup()
  env.s.setLyrics('Song|A', 'Song', 'A', VERSES, true, { album: 'Live', duration: 40, appleId: '7', lang: 'en' })
  const secs = A.sections(VERSES)
  await play(env, 0, secs[0].at + 1)
  await play(env, secs[0].at + 1, secs[1].at + 1)
  await settle()
  const heads = env.calls.map((c) => c[0])
  assert.deepEqual(heads.map((h) => [h.cmd, !!h.final, !!h.notes]), [['align', false, false], ['align', false, false], ['align', true, true], ['notes', false, false]])
  assert.equal(heads[3].song, heads[2].song)
  assert.equal(heads[3].syl.length, 4)                     // per line, per word: syllable texts or null
  assert.deepEqual(env.done, [['Song', 3, 0, { album: 'Live', duration: 40, appleId: '7', lang: 'en' }]])
})

test('session: a one-section song: its section is the whole song; the kept section is forgotten after the notes', async () => {
  const env = setup()
  env.s.setLyrics('One|A', 'One', 'A', ONE, true)
  await play(env, 0, 22)
  await settle()
  const heads = env.calls.map((c) => c[0])
  assert.deepEqual(heads.map((h) => h.cmd), ['align', 'notes', 'forget'])
  assert.equal(heads[0].notes, true)
  assert.equal(heads[0].offset, 0)
  assert.deepEqual(env.done.map((d) => d[2]), [0])
})

test('gaming guard: a notes job waiting when a game starts is skipped, and says so', async () => {
  let gaming = false
  // a game starts while the alignment runs: its result is still delivered, the notes job is skipped
  const env = setup({ paused: () => gaming, onAlign: () => { gaming = true } })
  env.s.setLyrics('One|A', 'One', 'A', ONE, true)
  await play(env, 0, 22)
  await settle()
  assert.deepEqual(env.calls.map((c) => c[0].cmd), ['align', 'forget'])
  assert.deepEqual(env.failed, [['One', 'paused']])
  assert.deepEqual(env.done, [])
})

test('a failed notes step is never silent', async () => {
  const env = setup({ notesError: Object.assign(new Error('not enough free graphics memory'), { code: 'low-vram' }) })
  env.s.setLyrics('One|A', 'One', 'A', ONE, true)
  await play(env, 0, 22)
  await settle()
  assert.deepEqual(env.failed, [['One', 'low-vram']])
  const src = read('main.js')
  assert.match(src, /setNotesStatus\('No notes for “' \+ s\.title \+ '”: ' \+ why\)/)
  assert.match(src, /setNotesStatus\('Could not save the notes of “' \+ s\.title/)
})

test('align-helper: notes and prepareNotes are one request each', () => {
  const src = read('align-helper.js')
  assert.match(src, /notes\(id, song, syl\) \{ return request\(id, \[\{ cmd: 'notes', id, song, syl \}\], jobTimeoutMs\) \}/)
  assert.match(src, /\{ cmd: 'prepare', id, mode: 'notes' \}/)
})
