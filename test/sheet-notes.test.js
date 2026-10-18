// Sheet notes in the Studio (sheet-notes-model.js, sheet-notes-store.js, the session's pitch and
// notes-only jobs, the wiring in main/stage/lyrics): the note-to-staff mapping (pitch to staff position,
// accidentals and key spelling, durations, syllables), the first-play / later-play switch and the honest
// confidence gate, with saved helper output (test/fixtures/sheet-notes, CC songs; README there).
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')
const M = require('../sheet-notes-model')
const S = require('../sheet-notes-store')
const A = require('../align-session')
const N = require('../notes-log')

const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8')
const fixture = (name) => JSON.parse(read('test/fixtures/sheet-notes/' + name + '.json'))
const docOf = (name) => M.expand(fixture(name).entry)

// --- pitch to staff position ---

test('names: parsed with their accidentals and checked against the MIDI number', () => {
  assert.deepEqual(M.parseName('C♯4'), { letter: 'C', acc: 1, octave: 4, step: 28 })
  assert.deepEqual(M.parseName('B♭2'), { letter: 'B', acc: -1, octave: 2, step: 20 })
  assert.equal(M.parseName('F♯♯3').acc, 2)
  assert.equal(M.parseName('Db5').acc, -1)
  assert.equal(M.parseName('H2'), null)
  assert.equal(M.midiOf(M.parseName('C4')), 60)
  assert.equal(M.midiOf(M.parseName('B♭2')), 46)
  assert.equal(M.midiOf(M.parseName('C♭4')), 59)                // C flat sits a semitone under C
  // the note model's name wins when it matches; a name that doesn't match its MIDI number is spelled again
  assert.equal(M.spellNote({ midi: 61, name: 'D♭4' }, 0).letter, 'D')
  assert.deepEqual(M.spellNote({ midi: 61, name: 'E4' }, -3), { letter: 'D', acc: -1, octave: 4, step: 29 })
  assert.deepEqual(M.spellNote({ midi: 61, name: '' }, 2), { letter: 'C', acc: 1, octave: 4, step: 28 })
})

test('staff positions: treble, treble 8vb (sung an octave lower) and bass, with their ledger lines', () => {
  const pos = (name, clef) => M.staffPos(M.parseName(name), clef)
  assert.equal(pos('E4', 'treble'), 0)          // the bottom line
  assert.equal(pos('F5', 'treble'), 8)          // the top line
  assert.equal(pos('G4', 'treble'), 2)          // the G line the clef curls round
  assert.equal(pos('C4', 'treble'), -2)         // middle C: one ledger line below
  assert.deepEqual(M.ledgers(pos('C4', 'treble')), [-2])
  assert.deepEqual(M.ledgers(pos('A3', 'treble')), [-2, -4])
  assert.deepEqual(M.ledgers(pos('A5', 'treble')), [10])
  assert.deepEqual(M.ledgers(4), [])
  assert.equal(pos('E3', 'treble8'), 0)         // a tenor's E3 is written on the treble staff's bottom line
  assert.equal(pos('C4', 'treble8'), 5)
  assert.equal(pos('G2', 'bass'), 0)
  assert.equal(pos('A3', 'bass'), 8)
  assert.equal(pos('C4', 'bass'), 10)           // middle C over the bass staff
  // the pitch line between notes: half a step for a sharp, in between for a glide
  assert.equal(M.contPos(64, 'treble', 0), 0)
  assert.equal(M.contPos(65, 'treble', 0), 1)
  assert.equal(M.contPos(66, 'treble', 0), 1.5)
  assert.equal(M.contPos(64.5, 'treble', 0), 0.5)
})

test('key signatures: the sharps and flats in their order and places, the bass clef two steps lower', () => {
  assert.deepEqual(M.keyAccidentals(2), { F: 1, C: 1 })
  assert.deepEqual(M.keyAccidentals(-3), { B: -1, E: -1, A: -1 })
  assert.deepEqual(M.keyAccidentals(0), {})
  assert.deepEqual(M.keySignature(2, 'treble'), [{ pos: 8, glyph: '♯' }, { pos: 5, glyph: '♯' }])
  assert.deepEqual(M.keySignature(-3, 'treble').map((s) => s.pos), [4, 7, 3])
  assert.deepEqual(M.keySignature(-3, 'bass').map((s) => s.pos), [2, 5, 1])
  assert.deepEqual(M.keySignature(2, 'treble8'), M.keySignature(2, 'treble'))
  assert.equal(M.keySignature(7, 'treble').length, 7)
  assert.equal(M.keySignature(9, 'treble').length, 7)          // clamped
})

test('accidentals: only where the note differs from the key signature (no bars carry them)', () => {
  const ka = (f) => M.keyAccidentals(f)
  assert.equal(M.accidental(M.parseName('F♯4'), ka(2)), '')     // D major: F sharp is in the key
  assert.equal(M.accidental(M.parseName('F4'), ka(2)), '♮')      // and F natural needs its sign
  assert.equal(M.accidental(M.parseName('B♭2'), ka(1)), '♭')     // G major: B flat is off the key
  assert.equal(M.accidental(M.parseName('C♯4'), ka(0)), '♯')
  assert.equal(M.accidental(M.parseName('F♯♯4'), ka(2)), '𝄪')
  // in a real song: Rxbyn's B♭2s in G major get a flat each, its Gs and Cs none
  const lay = M.layout(docOf('rxbyn-bad-side'))
  const doc = docOf('rxbyn-bad-side')
  doc.notes.forEach((n, i) => assert.equal(lay.notes[i].acc, n.name.includes('♭') ? '♭' : n.name.includes('♯') ? '♯' : '', n.name))
})

test('the clef: the one that keeps the singing on the staff (bass for these two low voices, as the research PNGs)', () => {
  assert.equal(M.layout(docOf('cortez-feel-stripped')).clef, 'bass')
  assert.equal(M.layout(docOf('rxbyn-bad-side')).clef, 'bass')
  assert.equal(M.layout(docOf('wilson-way-te-recuerdo')).clef, 'treble8')
  const melody = (from) => [0, 2, 4, 5, 7, 5, 4, 2].map((d, i) => ({ midi: from + d, t: i, end: i + 0.9 }))
  assert.equal(M.clefFor(melody(67)), 'treble')     // a soprano around G4-D5
  assert.equal(M.clefFor(melody(55)), 'treble8')    // a tenor around G3-D4
  assert.equal(M.clefFor(melody(41)), 'bass')
  assert.equal(M.clefFor([]), 'treble8')
  // every note of every fixture lands within the drawn room (4 ledger lines either way)
  for (const f of ['cortez-feel-stripped', 'rxbyn-bad-side', 'wilson-way-te-recuerdo']) {
    const lay = M.layout(docOf(f))
    assert.ok(lay.lowest >= -6 && lay.highest <= 14, f + ' ' + lay.lowest + '..' + lay.highest)
  }
})

test('durations: each note as long as it was held, never quantised', () => {
  const doc = docOf('cortez-feel-stripped')
  const lay = M.layout(doc)
  assert.equal(lay.notes.length, doc.notes.length)
  doc.notes.forEach((n, i) => { assert.equal(lay.notes[i].t, n.t); assert.equal(lay.notes[i].end, n.end) })
  // real held lengths, not a grid: many different lengths, none rounded to a beat
  const lens = new Set(doc.notes.map((n) => Math.round((n.end - n.t) * 100)))
  assert.ok(lens.size > 20, lens.size)
})

test('syllables: under their first note, a hyphen to the next syllable of the word, an extender under a melisma', () => {
  const lay = M.layout(docOf('rxbyn-bad-side'))
  // "two" sung on C3–D3: the text under C3, an extender under D3
  assert.equal(lay.notes[1].syl, 'two'); assert.equal(lay.notes[2].syl, null); assert.equal(lay.notes[2].ext, true)
  // "about" on C3–D3–C3: one syllable, two extenders
  assert.deepEqual(lay.notes.slice(8, 11).map((n) => [n.syl, n.ext]), [['about', false], [null, true], [null, true]])
  // "al-right": the first syllable carries the hyphen
  assert.deepEqual(lay.notes.slice(12, 14).map((n) => n.syl), ['al-', 'right'])
  // a note with no syllable (an ad-lib, a backing vocal): drawn, but marked loose, no text
  const doc = docOf('cortez-feel-stripped')
  doc.notes[3].syl_index = null
  const l2 = M.layout(doc)
  assert.equal(l2.notes[3].loose, true)
  assert.equal(l2.notes[3].syl, null)
})

// --- the cached entry ---

test('compact and expand: only what the band draws, line numbers shifted, checked on the way back', () => {
  const part = {
    model: 'm', duration_s: 12.5, key: { name: 'G minor', fifths: -2, mode: 'minor' }, tuning: { cents: -0.3, strength: 0.7 }, confidence: { overall: 0.81 },
    syllables: [{ t: 1, end: 1.4, text: 'hel', line: 0, word: 0, syl: 0, nsyl: 2 }, { t: 1.4, end: 2, text: 'lo', line: 0, word: 0, syl: 1, nsyl: 2 }],
    notes: [{ t: 1.01, end: 1.39, midi: 55, cents: 4, name: 'G3', conf: 0.9, syl_index: 0, line: 0, melisma: false }, { t: 1.41, end: 1.99, midi: 58, cents: -6, name: 'B♭3', conf: 0.88, syl_index: 1, line: 0, melisma: false },
      { t: 3, end: 2, midi: 50 }],
    pitch: { t0: 0, hop: 0.05, v: [0, 550, 551, 0] }, lines: [{}], f0: [1, 2, 3]
  }
  const e = M.compact(part, { lineOffset: 8, lyricsHash: 'abc', created: 'now', version: '0.15.41' })
  assert.equal(e.notes.length, 2)                                   // the broken note (end before start) left out
  assert.equal(e.syl[0][3], 8)                                      // line 0 of a section job starting at line 8
  assert.ok(!('f0' in e) && !('lines' in e))                       // no frames, nothing the band doesn't draw
  const d = M.expand(JSON.parse(JSON.stringify(e)))
  assert.deepEqual(d.notes.map((n) => [n.name, n.syl_index, n.line, n.conf]), [['G3', 0, 8, 0.9], ['B♭3', 1, 8, 0.88]])
  assert.deepEqual(d.key, { name: 'G minor', fifths: -2 })
  assert.deepEqual(d.pitch.v, [0, 550, 551, 0])
  assert.ok(M.entryValid(e, 'abc'))
  assert.ok(!M.entryValid(e, 'other lyrics'))
  assert.ok(!M.entryValid({ format: 1, lyricsHash: 'abc', failed: 'low-vram' }, 'abc'))
  assert.equal(M.expand(null), null)
  assert.equal(M.expand({ format: 2, notes: [], syl: [] }), null)
  assert.equal(M.expand({ format: 1, notes: [[1, 2, 60, 0, 'C4', 900, 99, 0]], syl: [] }).notes[0].syl_index, null)   // a syllable index out of range
})

// --- the honest gate ---

test('gate: sung songs show their notes everywhere', () => {
  for (const f of ['cortez-feel-stripped', 'rxbyn-bad-side']) {
    const g = M.gate(docOf(f))
    assert.equal(g.song, 'notes', f)
    assert.ok(g.stats.spread <= 8, f + ' spread ' + g.stats.spread)
    assert.ok(g.regions.every((r) => r.show === 'notes' || r.why === 'no notes'), f + ' ' + JSON.stringify(g.regions.filter((r) => r.show !== 'notes')))
  }
})

test('gate: a rapped stretch shows the pitch line, never invented notes; with no pitch line, nothing', () => {
  const doc = docOf('synthetic-rap')
  const g = M.gate(doc)
  assert.equal(g.song, 'line')
  assert.match(g.why, /rap, speech or shouting/)
  assert.ok(g.regions.length > 3 && g.regions.every((r) => r.show === 'line'))
  assert.ok(M.layout(doc, g).notes.every((n) => n.show === 'line'))
  doc.pitch = null
  assert.ok(M.gate(doc).regions.every((r) => r.show === 'none'))
  assert.equal(M.mode({ on: true, installed: true, precise: true, timed: true, aligned: true, doc }).text.startsWith('Pitch line only'), true)
})

test('gate: rap verses and a sung chorus in one song: the pitch line for the verses, notes for the chorus', () => {
  const fx = fixture('wilson-way-te-recuerdo')
  const g = M.gate(M.expand(fx.entry))
  assert.equal(g.song, 'notes')
  const byLine = new Map(g.regions.filter((r) => r.line !== null).map((r) => [r.line, r]))
  const text = (i) => fx.lines.find((l) => l.index === i).text
  // rapped: "hola que tal espero que estés bien", "no dejo de pensar en ti …", "pues hay muchos recuerdos …"
  for (const i of [1, 2, 9, 12]) assert.equal(byLine.get(i).show, 'line', i + ' ' + text(i))
  // sung: "y no puedo soportarlo mas …", "cuando te vi por primera vez …", "no pensé que me rendiria a tus pies"
  for (const i of [13, 14, 15]) assert.equal(byLine.get(i).show, 'notes', i + ' ' + text(i))
  // the label says so while the playhead is in a pitch-line stretch
  const m = M.mode({ on: true, installed: true, precise: true, timed: true, aligned: true, doc: M.expand(fx.entry), gate: g })
  assert.equal(M.labelAt(m, byLine.get(1)), 'Notes · B minor · pitch line here: notes unsure')
  assert.equal(M.labelAt(m, byLine.get(13)), 'Notes · B minor')
})

test('gate: a few notes are judged with their neighbours; a quiet unsure stretch is not shown as notes', () => {
  const n = (t, cents, conf = 0.9) => ({ t, end: t + 0.3, midi: 60, cents, name: 'C4', conf, syl_index: null, line: null, melisma: false })
  // a 2-note line inside a well-sung stretch passes with its neighbours
  const notes = [n(0, 3), n(0.4, -4), n(0.8, 2), n(1.2, 5), n(1.6, -2), n(5, 30), n(5.4, -28), n(6, 4), n(6.4, 2)]
  const syllables = [{ t: 5, end: 5.7, text: 'a', line: 1, syl: 0, nsyl: 1 }]
  const g = M.gate({ notes, syllables, pitch: null })
  assert.equal(M.regionAt(g.regions, 5.2).show, 'notes')
  // low confidence everywhere: the song is the pitch line (or nothing without one)
  const unsure = notes.map((x) => Object.assign({}, x, { cents: 2, conf: 0.4 }))
  const g2 = M.gate({ notes: unsure, syllables: [], pitch: { t0: 0, hop: 0.05, v: new Array(200).fill(600) } })
  assert.equal(g2.song, 'line')
  assert.match(g2.why, /unsure/)
})

// --- first play / later plays ---

test('mode: off folds the band away; the switch on says why there is nothing to draw', () => {
  const base = { on: true, installed: true, precise: true, timed: true, wordSynced: false, aligned: false, doc: null, pitch: [] }
  assert.equal(M.mode({ on: false }).band, 'off')
  assert.equal(M.mode(Object.assign({}, base, { installed: false })).band, 'message')
  assert.match(M.mode(Object.assign({}, base, { precise: false })).text, /Precise word timing on/)
  // Apple-timed lyrics are no longer turned away: their notes come from their own word times (sheet-notes-given.test.js)
  assert.equal(M.mode(Object.assign({}, base, { wordSynced: true })).band, 'line')
  assert.match(M.mode(Object.assign({}, base, { timed: false })).text, /line timing/)
})

test('mode: the first play draws the pitch line as sections come back; later plays the notes', () => {
  const fx = fixture('cortez-feel-stripped')
  const base = { on: true, installed: true, precise: true, timed: true, wordSynced: false }
  // first play, nothing heard yet: the line band, saying what comes
  const first = M.mode(Object.assign({}, base, { aligned: false, doc: null, pitch: [] }))
  assert.equal(first.band, 'line'); assert.equal(first.label, 'First play · pitch line'); assert.match(first.text, /once Sonata has heard it/)
  // first play, two sections back: the line
  const some = M.mode(Object.assign({}, base, { aligned: false, doc: null, pitch: fx.pieces }))
  assert.equal(some.band, 'line'); assert.equal(some.text, '')
  // a game started: paused, says so (the line heard so far stays)
  assert.equal(M.mode(Object.assign({}, base, { paused: true, pitch: fx.pieces })).text, 'Paused while a game runs')
  // the second play: aligned words and cached notes: the staff
  const later = M.mode(Object.assign({}, base, { aligned: true, doc: M.expand(fx.entry), pitch: [] }))
  assert.deepEqual([later.band, later.label, later.text], ['notes', 'Notes · E major', ''])
  // aligned before the switch was on (no notes yet): this play works them out
  assert.match(M.mode(Object.assign({}, base, { aligned: true, doc: null })).text, /from the next play/)
  // notes cached but the words on screen aren't the aligned ones (e.g. Precise timing's entry for other lyrics): no staff
  assert.notEqual(M.mode(Object.assign({}, base, { aligned: false, doc: M.expand(fx.entry) })).band, 'notes')
})

test('the first play\'s pitch pieces: merged in time, a later piece wins where it heard a voice, runs split where nobody sings', () => {
  const fx = fixture('rxbyn-bad-side')
  const line = M.mergePitch(fx.pieces)
  assert.equal(line.hop, 0.05)
  assert.ok(line.t0 <= fx.pieces[0].t0 + 1e-9)
  const a = { t0: 10, hop: 0.05, v: [600, 600, 0, 610] }
  const b = { t0: 10.1, hop: 0.05, v: [620, 620, 620] }
  assert.deepEqual(M.mergePitch([a, b]).v, [600, 600, 620, 620, 620])
  assert.equal(M.mergePitch([]), null)
  const runs = M.pitchRuns({ t0: 0, hop: 0.05, v: [640, 640, 645, 0, 0, 660, 660] }, 'treble', 0)
  assert.equal(runs.length, 2)
  assert.deepEqual(runs[0].map((p) => p[1]), [0, 0, 0.5])
  // limited to the gate's pitch-line stretches
  assert.equal(M.pitchRuns({ t0: 0, hop: 0.05, v: [640, 640, 650, 0, 0, 660, 660] }, 'treble', 0, [{ t0: 0.2, t1: 1 }]).length, 1)
})

test('the playhead: the note sung at a time, and the next change to wake up for', () => {
  const lay = M.layout(docOf('rxbyn-bad-side'))
  assert.equal(M.noteAt(lay, 34.9), 0)
  assert.equal(M.noteAt(lay, 35.4), -1)                  // between "so" and "two"
  assert.equal(M.noteAt(lay, 35.55), 1)
  assert.equal(M.nextChange(lay, [], 35.4), 35.51)
  assert.equal(M.nextChange(lay, [], 35.55), 35.62)
  assert.equal(M.nextChange(lay, [], 1e9), Infinity)
})

// --- the store ---

test('store: one file per song, read back for the same lyrics only, failures tried twice, the oldest pruned', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sheet-notes-'))
  try {
    const st = S.createSheetNotesStore({ dir, max: 3 })
    assert.equal(st.get('Song', 'Artist'), null)
    assert.ok(st.missing('Song', 'Artist', 'h1'))
    const e = fixture('cortez-feel-stripped').entry
    st.set('Song', 'Artist', Object.assign({}, e, { lyricsHash: 'h1' }))
    assert.ok(!st.missing('Song', 'Artist', 'h1'))
    assert.ok(st.missing('Song', 'Artist', 'h2'))             // other lyrics
    assert.equal(st.get('Song', 'Artist').notes.length, e.notes.length)
    assert.match(S.fileName('Feel (Stripped)', 'Cortez'), /^Cortez-Feel-Stripped-[0-9a-f]{8}\.json$/)
    assert.notEqual(S.fileName('A/B', 'X'), S.fileName('A B', 'X'))   // same slug, own file
    // failures: tried again once, then not; no model: not until the switch downloads it
    st.failed('Other', 'Artist', 'h', 'low-vram')
    assert.ok(st.missing('Other', 'Artist', 'h'))
    st.failed('Other', 'Artist', 'h', 'low-vram')
    assert.ok(!st.missing('Other', 'Artist', 'h'))
    st.failed('Third', 'Artist', 'h', 'no-model')
    assert.ok(!st.missing('Third', 'Artist', 'h'))
    st.set('Fourth', 'Artist', { format: 1, lyricsHash: 'h' })
    assert.equal(fs.readdirSync(dir).filter((n) => n.endsWith('.json')).length, 3)
    assert.ok(!fs.readdirSync(dir).some((n) => n.includes('.tmp-')))
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

// --- the session: the first play's pitch lines, and a notes-only play ---

const VERSES = [{ t: 10, text: 'first verse one' }, { t: 13, text: 'first verse two' }, { t: 30, text: 'second verse one' }, { t: 33, text: 'second verse two' }]
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
  const got = { pitch: [], done: [], failed: [] }
  const store = new Map()
  if (opts.entry) store.set(A.alignedKey('Song', 'A'), opts.entry)
  const helper = {
    align: async (id, messages) => { const m = [...messages]; calls.push(m[0]); return echo(id, m) },
    forget: (song) => calls.push({ cmd: 'forget', song }),
    notes: async (id, song) => { calls.push({ cmd: 'notes', id, song }); return { type: 'result', id, notes: { notes: [{ t: 10, end: 10.5, midi: 60 }], pitch: { t0: 0, hop: 0.05, v: [600] } } } },
    pitch: async (id, song, offset) => { calls.push({ cmd: 'pitch', id, song, offset }); if (opts.pitchError) throw opts.pitchError; return { type: 'result', id, pitch: { t0: offset, hop: 0.05, v: [0, 600] } } }
  }
  const s = A.createAlignSession({
    createListener: () => ({ start() {}, stop() {} }),
    helper,
    store: { get: (k) => store.get(k) || null, set: (k, v) => store.set(k, v) },
    send: () => {},
    now: () => nowMs,
    log: () => {},
    latency: 0,
    paused: opts.paused,
    notes: {
      wanted: () => true,
      syl: N.syllableSpec,
      done: (song, r, off) => got.done.push([song.title, off]),
      failed: (song, e) => got.failed.push(e.code || e.message),
      pitchWanted: opts.pitchWanted || (() => true),
      pitch: (song, line, e) => got.pitch.push(line ? line.t0 : 'error ' + (e && (e.code || e.message))),
      missing: opts.missing || (() => false)
    }
  })
  return { s, calls, got, store, setNow: (v) => { nowMs = v } }
}
function play(env, from, to) {
  const chunk = new Float32Array(2205).fill(0.1)
  for (let t = from; t < to - 1e-9; t += 0.5) {
    env.setNow(t * 1000)
    env.s.tick(t, true, true)
    for (let k = 0; k < 5; k++) if (env.s.recording) env.s._onChunk(chunk, (t + (k + 1) * 0.1) * 1000, null)
  }
}
const settle = () => new Promise((r) => setTimeout(r, 15))

test('session, first play: each section\'s pitch line right after its words (same job, so the order holds), not for the whole-song job', async () => {
  const env = setup()
  env.s.setLyrics('Song|A', 'Song', 'A', VERSES, true)
  const secs = A.sections(VERSES)
  play(env, 0, secs[0].at + 1)
  play(env, secs[0].at + 1, secs[1].at + 1)
  await settle()
  assert.deepEqual(env.calls.map((c) => c.cmd + (c.final ? ':final' : '')), ['align', 'pitch', 'align', 'pitch', 'align:final', 'notes'])
  const offsets = env.calls.filter((c) => c.cmd === 'align' && !c.final).map((c) => c.offset)
  assert.deepEqual(env.calls.filter((c) => c.cmd === 'pitch').map((c) => c.offset), offsets)
  assert.deepEqual(env.got.pitch, offsets)
})

test('session: no pitch jobs while the Studio\'s band is off, or while a game runs; a failed one is said', async () => {
  const off = setup({ pitchWanted: () => false })
  off.s.setLyrics('Song|A', 'Song', 'A', VERSES, true)
  const secs = A.sections(VERSES)
  play(off, 0, secs[1].at + 1)
  await settle()
  assert.ok(!off.calls.some((c) => c.cmd === 'pitch'))
  let gaming = false
  const g = setup({ paused: () => gaming })
  g.s.setLyrics('Song|A', 'Song', 'A', VERSES, true)
  play(g, 0, secs[0].at + 1)
  gaming = true
  await settle()
  assert.ok(!g.calls.some((c) => c.cmd === 'pitch'))
  const bad = setup({ pitchError: Object.assign(new Error('not enough free graphics memory'), { code: 'low-vram' }) })
  bad.s.setLyrics('Song|A', 'Song', 'A', VERSES, true)
  play(bad, 0, secs[0].at + 1)
  await settle()
  assert.deepEqual(bad.got.pitch, ['error low-vram'])
})

test('session: a song aligned before Sheet notes was on is recorded once more, as one whole-song job with notes', async () => {
  const lines = VERSES
  const entry = { version: A.ENTRY_VERSION, lyricsHash: A.lyricsHash(lines), whole: true, done: A.sections(lines).map((s) => s.from), lines: [] }
  const without = setup({ entry })
  without.s.setLyrics('Song|A', 'Song', 'A', lines, true)
  play(without, 0, 45)
  without.s.stop(true)
  await settle()
  assert.deepEqual(without.calls, [])                      // complete and nothing missing: nothing records
  let asked = null
  const env = setup({ entry, missing: (title, artist, hash) => { asked = [title, artist, hash]; return true } })
  env.s.setLyrics('Song|A', 'Song', 'A', lines, true)
  assert.deepEqual(asked, ['Song', 'A', A.lyricsHash(lines)])
  play(env, 0, 45)
  await settle()
  assert.deepEqual(env.calls.map((c) => [c.cmd, !!c.final, !!c.notes]), [['align', true, true], ['notes', false, false]])
  assert.deepEqual(env.got.done, [['Song', 0]])
})

// --- the wiring ---

test('wiring: the setting, the tile, main\'s state to the lyrics window, the build files', () => {
  const store = require('../settings-store')
  assert.equal(store.defaults().sheetNotes, false)                      // Experimental: off by default
  assert.ok(store.validSetting('sheetNotes', true) && !store.validSetting('sheetNotes', 'yes'))
  const stage = require('../stage-model')
  assert.deepEqual(stage.stageCommand('sheet-notes', true), { command: 'sheet-notes', value: true })
  assert.equal(stage.stageCommand('sheet-notes', 'on'), null)
  const main = read('main.js')
  assert.match(main, /'sungNotesLog', 'sheetNotes', 'sheetPlace', 'updateChannel'/)
  assert.match(main, /else if \(c\.command === 'sheet-notes'\) setSetting\('sheetNotes', c\.value\)/)
  assert.match(main, /lyricsWindow\.webContents\.send\('lyrics-sheet'/)
  assert.match(main, /pitchWanted: \(\) => sheetNotesOn\(\) && getNotesSwitch\(\)\.wanted\(\) && stageShowing\(\)/)
  assert.match(main, /function sheetNotesOn\(\) \{ return !!settings\.sheetNotes && preciseTimingOn\(\) \}/)
  const ui = read('stage-ui.js')
  assert.match(ui, /el\.tNotes\.onclick = \(\) => send\('sheet-notes', !sheetOn\)/)
  const html = read('lyrics.html')
  assert.match(html, /ipcRenderer\.on\('lyrics-sheet', \(event, st\) => \{/)
  assert.match(html, /stage\.setBand\(sheetBand\.el\)/)
  const panel = read('panel-ui.js')
  // Settings → Experimental (beside the graphics switches; it applies at once), no longer in Precise timing
  const expAt = panel.indexOf('experimental: () => ['), timingAt = panel.indexOf('timing: () => [')
  const rowAt = panel.indexOf("switchRow('sheetNotes', 'Sheet notes in the Studio (experimental)'")
  assert.ok(expAt > 0 && rowAt > expAt, 'the Sheet notes switch is in the Experimental section')
  assert.ok(!(rowAt > timingAt && rowAt < panel.indexOf('startup: () => [')), 'not in Precise timing')
  assert.ok(panel.indexOf("selectRow('sheetPlace'") > expAt, 'its placement row goes with it')
  const files = require('../package.json').build.files
  for (const f of ['sheet-notes-model.js', 'sheet-notes-store.js', 'sheet-notes-ui.js', 'sheet-notes-glyphs.js', 'licenses/NotoMusic-OFL.txt']) assert.ok(files.includes(f), f)
  // the glyphs carry their own licence (OFL), named in the file
  assert.match(read('sheet-notes-glyphs.js'), /SIL Open Font License 1\.1/)
  assert.match(read('licenses/NotoMusic-OFL.txt'), /SIL OPEN FONT LICENSE Version 1\.1/)
})

test('render path: the band moves by one transform animation, waits by a timeout to the next note, and stops when paused or hidden', () => {
  const src = read('sheet-notes-ui.js')
  // one Web Animation, transform only (render-path.test.js checks its keyframes too)
  assert.equal((src.match(/\.animate\(/g) || []).length, 1)
  assert.match(src, /strip\.animate\(\[\{ transform: /)
  assert.ok(!/requestAnimationFrame|setInterval/.test(src), 'no frame loop and no interval: the compositor runs the animation')
  // paused or hidden: the animation paused and no timer
  assert.match(src, /if \(!lay \|\| m\.band !== 'notes' \|\| !opts\.playing\(\) \|\| doc\.visibilityState !== 'visible'\) return/)
  assert.match(src, /else if \(!playing && anim\.playState === 'running'\) anim\.pause\(\)/)
  assert.match(src, /if \(doc\.visibilityState !== 'visible'\) \{ if \(anim && anim\.playState === 'running'\) anim\.pause\(\)/)
  // reduced motion: pages, no animation
  assert.match(src, /if \(opts\.reducedMotion && opts\.reducedMotion\(\)\) \{/)
  // theme tokens only in the band's CSS
  const css = read('lyrics.html').split('\n').filter((l) => /^\s*(#band|\.sn)/.test(l)).join('\n')
  assert.ok(css.length > 500)
  assert.ok(!/#[0-9a-f]{3,8}\b|rgba?\(/i.test(css), 'no literal colours in the band')
})

// --- placement: Band on top / Over the sung line (0.15.42) ---

test('placement: band on top by default; over the sung line only with something to draw, in the Studio', () => {
  assert.equal(require('../settings-store').defaults().sheetPlace, 'band')
  assert.ok(require('../settings-store').validSetting('sheetPlace', 'over') && !require('../settings-store').validSetting('sheetPlace', 'under'))
  const on = { on: true, place: 'over' }
  assert.deepEqual(M.placement(on, 'notes', true), { where: 'over', room: M.OVER_ROOM })
  assert.deepEqual(M.placement(on, 'line', true), { where: 'over', room: M.OVER_ROOM })   // the first play's line rides over it too
  assert.deepEqual(M.placement(on, 'message', true), { where: 'band', room: 0 })        // a message has no staff: it stays in the band
  assert.deepEqual(M.placement(on, 'notes', false), { where: 'none', room: 0 })         // the compact lyrics window: no sheet notes
  assert.deepEqual(M.placement({ on: false, place: 'over' }, 'off', true), { where: 'none', room: 0 })
  assert.deepEqual(M.placement({ on: true, place: 'band' }, 'notes', true), { where: 'band', room: 0 })
  assert.deepEqual(M.placement({ on: true }, 'notes', true), { where: 'band', room: 0 })
  // the room holds the label row (with the placement buttons) and the staff without its syllable row
  assert.equal(M.OVER_ROOM, 136)
  const css = read('lyrics.html')
  assert.match(css, /#sn-over \{ position: absolute; left: 40px; right: 56px; top: 0; height: 136px;/)
  assert.match(css, /#sn-over \.sn-staff \{ bottom: auto; height: 110px; \}/)
  assert.match(css, /\.sn\.over \.sn-syls \{ display: none; \}/)
})

test('placement: the setting, the band\'s two buttons and main', () => {
  const stage = require('../stage-model')
  assert.deepEqual(stage.stageCommand('sheet-place', 'over'), { command: 'sheet-place', value: 'over' })
  assert.equal(stage.stageCommand('sheet-place', 'top'), null)
  const main = read('main.js')
  assert.match(main, /else if \(c\.command === 'sheet-place'\) setSetting\('sheetPlace', c\.value\)/)
  assert.match(main, /place: settings\.sheetPlace \}/)
  const panel = read('panel-ui.js')
  assert.match(panel, /selectRow\('sheetPlace', 'Sheet notes placement'/)
  const ui = read('sheet-notes-ui.js')
  assert.match(ui, /\['band', 'Band on top'/)
  assert.match(ui, /\['over', 'Over the sung line'/)
  assert.match(ui, /b\.onclick = \(\) => \{ if \(st\.place !== value && opts\.onPlace\) opts\.onPlace\(value\) \}/)
  assert.match(read('lyrics.html'), /onPlace: \(p\) => ipcRenderer\.send\('stage-command', 'sheet-place', p\)/)
})

test('over the sung line: the room opens by a border (no line text moves into it), lines slide (FLIP), the staff follows by transform', () => {
  const lv = read('lyrics-view.js')
  // the room moves before the scroll is taken, so the line is centred with its room
  const i = lv.indexOf('const want = px > 0 ? target : null')
  const scroll = lv.indexOf("if (target) scrollToLine(target, 'center'")   // (…, jump) since fix-lyrics-race
  assert.ok(i > 0 && scroll > 0 && i < scroll)
  // one class and a custom property; FLIP from the measured before/after; reduced motion: no slides
  assert.match(lv, /el\.style\.setProperty\('--room', px \+ 'px'\); el\.classList\.add\('room'\)/)
  assert.match(lv, /const around = still\(\) \? \[\] : slideTargets\(null\)/)
  assert.match(lv, /slideFrom\(before, around\.map\(\(a\) => rect\(a\.measure\)\), null\)/)
  // a new song's lines: the room goes with them
  assert.match(lv, /if \(roomEl && opts\.onRoom\) opts\.onRoom\(null\)\n {4}roomEl = null/)
  const css = read('lyrics-view.css')
  assert.match(css, /\.line\.room, \.dots\.room \{ border-top: var\(--room, 0px\) solid transparent; \}/)
  assert.ok(!/\.room[^{]*\{[^}]*transition/.test(css), 'the room never transitions (layout): the lines slide by FLIP')
  // the staff overlay: inside the list (scrolls with it), moved by transform, animated only off reduced motion
  const html = read('lyrics.html')
  assert.match(html, /if \(overEl\.parentElement !== linesEl\) linesEl\.appendChild\(overEl\)/)
  assert.match(html, /overEl\.style\.transform = 'translateY\(' \+ y \+ 'px\)'/)
  assert.match(html, /if \(was !== null && was !== y && !matchMedia\('\(prefers-reduced-motion: reduce\)'\)\.matches\)/)
  assert.match(html, /room: \(\) => \(sheetBand && stage\.shown \? sheetBand\.room : 0\)/)
})
