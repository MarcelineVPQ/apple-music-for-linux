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

test('gate: a sung song keeps its notes through loose lines (Radiohead "15 Step": 22-38 cents, ~3 syllables a second)', () => {
  const g = M.gate(M.expand(fixture('radiohead-15-step').entry))
  assert.equal(g.song, 'notes')
  const sung = g.regions.filter((r) => r.stats.n)
  assert.ok(sung.filter((r) => r.stats.spread > 20).length >= 4, 'the fixture still holds the loose lines')
  assert.ok(sung.every((r) => r.show === 'notes'), JSON.stringify(sung.filter((r) => r.show !== 'notes')))
  // the same lines delivered fast are rapped, and an extreme spread is still the line
  const fast = M.gate(M.expand(fixture('radiohead-15-step').entry), { rapRate: 2 })
  assert.ok(fast.regions.some((r) => r.show !== 'notes' && /rapped/.test(r.why)))
  assert.ok(M.gate(M.expand(fixture('radiohead-15-step').entry), { spreadMax: 25 }).regions.some((r) => /off the pitch grid/.test(r.why)))
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
  assert.equal(first.band, 'line'); assert.equal(first.label, 'First play · pitch line'); assert.equal(first.text, ''); assert.equal(first.live, true)
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

test('the first play\'s pitch pieces: merged in time, a later piece wins where it heard a voice, runs split where the singing stops', () => {
  const fx = fixture('rxbyn-bad-side')
  const line = M.mergePitch(fx.pieces)
  assert.equal(line.hop, 0.05)
  assert.ok(line.t0 <= fx.pieces[0].t0 + 1e-9)
  const a = { t0: 10, hop: 0.05, v: [600, 600, 0, 610] }
  const b = { t0: 10.1, hop: 0.05, v: [620, 620, 620] }
  assert.deepEqual(M.mergePitch([a, b]).v, [600, 600, 620, 620, 620])
  assert.equal(M.mergePitch([]), null)
  const runs = M.pitchRuns({ t0: 0, hop: 0.05, v: [640, 640, 645, 0, 0, 0, 0, 0, 0, 660, 660] }, 'treble', 0)
  assert.equal(runs.length, 2)                           // 300 ms without a voice: the singing stopped
  assert.deepEqual(runs[0].map((p) => p[1]), [0, 0, 0.5])
  // limited to the gate's pitch-line stretches
  assert.equal(M.pitchRuns({ t0: 0, hop: 0.05, v: [640, 640, 650, 0, 0, 0, 0, 0, 0, 660, 660] }, 'treble', 0, [{ t0: 0.2, t1: 1 }]).length, 1)
})

// a sung phrase as the helper sends it: MIDI x 10 per 50 ms, 0 where its voicing gate dropped a hop
const seg = (n, v) => new Array(n).fill(v)
const voicedRuns = (v) => { const r = []; let c = 0; for (const x of v.concat(0)) { if (x > 0) c++; else { if (c > 1) r.push(c); c = 0 } } return r }

test('the first-play pitch line is continuous through a sung phrase (Marcy 2026-10-18: dashes, not a line)', () => {
  // dropouts of 50-250 ms inside the phrase are bridged, in a straight line in MIDI (log frequency)
  const phrase = [].concat(seg(6, 600), [0], seg(4, 610), [0, 0, 0], seg(5, 640), [0, 0], seg(6, 620))
  assert.equal(voicedRuns(phrase).length, 4)             // before: four dashes
  assert.equal(M.pitchRuns({ t0: 0, hop: 0.05, v: phrase }, 'treble', 0).length, 1)
  const bridged = M.cleanPitch({ t0: 0, hop: 0.05, v: phrase }).v
  assert.deepEqual(bridged.slice(10, 15), [610, 617.5, 625, 632.5, 640])
  // 250 ms is still bridged; a real pause (300 ms and more) stays a gap; a jump of more than 7 semitones over
  // a dropout starts a new phrase
  assert.equal(M.pitchRuns({ t0: 0, hop: 0.05, v: [].concat(seg(6, 600), seg(5, 0), seg(6, 600)) }, 'treble', 0).length, 1)
  assert.equal(M.pitchRuns({ t0: 0, hop: 0.05, v: [].concat(seg(6, 600), seg(6, 0), seg(6, 600)) }, 'treble', 0).length, 2)
  assert.equal(M.pitchRuns({ t0: 0, hop: 0.05, v: [].concat(seg(6, 600), [0, 0], seg(6, 690)) }, 'treble', 0).length, 2)
  // a lone 50 ms speck is dropped; 100 ms of voice is kept
  assert.equal(M.pitchRuns({ t0: 0, hop: 0.05, v: [].concat(seg(6, 600), seg(7, 0), [620], seg(7, 0), [630, 630]) }, 'treble', 0).length, 2)
  assert.deepEqual(M.cleanPitch({ t0: 0, hop: 0.05, v: [0, 0, 600, 0, 0] }).v, [0, 0, 0, 0, 0])
  // octave errors: a stretch an octave off its neighbours is folded back (no spike to the next octave)
  const oct = M.cleanPitch({ t0: 0, hop: 0.05, v: [].concat(seg(6, 600), [720, 721], seg(6, 602)) }).v
  assert.ok(oct.every((x) => x > 590 && x < 612), oct.join(' '))
  // a real leap of an octave that is held stays where it is
  const leap = M.cleanPitch({ t0: 0, hop: 0.05, v: [].concat(seg(10, 600), seg(10, 720)) }).v
  assert.deepEqual([leap[2], leap[17]], [600, 720])
  // one-hop spikes go, vibrato keeps its swing (5.5 Hz, ±50 cents, at the helper's 50 ms hop)
  const vib = Array.from({ length: 40 }, (_, i) => Math.round(600 + 5 * Math.sin(2 * Math.PI * 5.5 * i * 0.05)))
  const sw = (v) => Math.max(...v.slice(4, 36)) - Math.min(...v.slice(4, 36))
  assert.ok(sw(M.cleanPitch({ t0: 0, hop: 0.05, v: vib }).v) >= 0.8 * sw(vib))
  const spike = M.cleanPitch({ t0: 0, hop: 0.05, v: [600, 600, 600, 650, 600, 600, 600] }).v
  assert.equal(spike[3], 600)
})

test('the first-play pitch line on recorded helper output: a few long runs, gaps only where the singing stops', () => {
  // before (every missing hop split the line) -> after; JamendoLyrics songs through the real helper
  const want = { 'cortez-feel-stripped': [33, 13], 'rxbyn-bad-side': [39, 12], 'wilson-way-te-recuerdo': [95, 27] }
  for (const [name, [before, after]] of Object.entries(want)) {
    const line = M.mergePitch(fixture(name).pieces)
    assert.equal(voicedRuns(line.v).length, before, name)
    const runs = M.pitchRuns(line, 'treble8', 0, null)
    assert.equal(runs.length, after, name)
    // what is left between runs is a pause (or a leap of more than 7 semitones): never under 250 ms
    for (let i = 1; i < runs.length; i++) assert.ok(runs[i][0][0] - runs[i - 1][runs[i - 1].length - 1][0] >= 0.25 - 1e-9, name + ' run ' + i)
  }
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
    // failures: tried again once, then not; no model: always again (main's notes switch keeps the jobs off
    // until the model is there; a marker used to keep the song from ever getting its notes, 0.15.57)
    st.failed('Other', 'Artist', 'h', 'low-vram')
    assert.ok(st.missing('Other', 'Artist', 'h'))
    st.failed('Other', 'Artist', 'h', 'low-vram')
    assert.ok(!st.missing('Other', 'Artist', 'h'))
    st.failed('Third', 'Artist', 'h', 'no-model')
    assert.ok(st.missing('Third', 'Artist', 'h'))
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
  // first play's section notes (engine feature "section-notes"): the same pitch job, with the section's syllables
  if (opts.sectionWanted) {
    helper.sectionNotes = async (id, song, offset, given) => {
      calls.push({ cmd: 'pitch', id, song, offset, given })
      return { type: 'result', id, pitch: { t0: offset, hop: 0.05, v: [0, 600] }, notes: { notes: [{ t: given.span[0] + 0.1, end: given.span[0] + 0.4, midi: 62, syl_index: 0 }], syllables: given.syllables, pitch: { t0: offset, hop: 0.05, v: [620] }, section: { offset, span: given.span } } }
    }
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
      missing: opts.missing || (() => false),
      sectionWanted: opts.sectionWanted,
      section: (song, part, sec) => { got.sections = (got.sections || []).concat([{ from: sec.from, to: sec.to, part }]) }
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

test('session: a complete song with missed lines still to fill, whose notes (or expression) are missing: that play fills them AND runs the whole-song pass with notes (0.15.54)', async () => {
  const lines = VERSES
  const secs = A.sections(lines)
  const entry = { version: A.ENTRY_VERSION, lyricsHash: A.lyricsHash(lines), whole: true, done: secs.map((s) => s.from), missed: [secs[0].from], fills: 0, lines: [] }
  // nothing missing: only the missed line's section is recorded and aligned (no whole pass, no notes), as before
  const fill = setup({ entry })
  fill.s.setLyrics('Song|A', 'Song', 'A', lines, true)
  play(fill, 0, 45)
  fill.s.stop(true)
  await settle()
  assert.deepEqual(fill.calls.filter((c) => c.cmd !== 'pitch').map((c) => [c.cmd, !!c.final]), [['align', false]])
  // the notes missing (Marcy's "Long Way Down (Live)" on 0.15.52: filling 1 missed line, no notes, no expr)
  const env = setup({ entry, missing: () => true })
  env.s.setLyrics('Song|A', 'Song', 'A', lines, true)
  play(env, 0, 45)
  env.s.stop(true)
  await settle()
  const cmds = env.calls.map((c) => c.cmd + (c.final ? ':final' : '') + (c.notes ? ':notes' : ''))
  assert.ok(cmds.includes('align:final:notes'), cmds.join(' '))
  assert.equal(cmds[cmds.length - 1], 'notes')
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
  // Settings → Lyrics & Studio → In the Studio (a lyrics feature; it applies at once), not in Experimental graphics
  const lyrAt = panel.indexOf('playback: () => ['), appAt = panel.indexOf('appearance: () => [')
  const rowAt = panel.indexOf("switchRow('sheetNotes', 'Sheet notes in the Studio (experimental)'")
  assert.ok(lyrAt > 0 && rowAt > lyrAt && rowAt < appAt, 'the Sheet notes switch is in Lyrics & Studio')
  assert.ok(panel.indexOf("group('In the Studio'") > lyrAt && panel.indexOf("group('In the Studio'") < rowAt, 'under In the Studio')
  const placeAt = panel.indexOf("selectRow('sheetPlace'")
  assert.ok(placeAt > rowAt && placeAt < appAt, 'its placement row right under it')
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
  assert.match(css, /#sn-over \.sn-staff \{ height: 110px; \}/)
  assert.match(css, /#sn-over \.sn \{ position: absolute; left: 0; right: 0; bottom: 0; \}/)
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
  assert.match(panel, /selectRow\('sheetPlace', 'Placement'[\s\S]{0,200}hidden: \(v\) => !preciseReady\(v\) \|\| !v\.sheetNotes/)
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

// the DS5 app's long-text rule (Marcy 2026-10-18: "make this wrap or use the i circle"): what stays visible
// is short, the longer explanation goes behind the ⓘ; a message never repeats the Experimental chip
test('mode: visible text at most 60 characters, the rest behind the ⓘ; the label never repeats the chip', () => {
  const base = { on: true, installed: true, precise: true, timed: true, wordSynced: false, aligned: false, paused: false, error: '', pitch: [] }
  const fx = JSON.parse(require('fs').readFileSync(require('path').join(__dirname, 'fixtures', 'sheet-notes', 'cortez-feel-stripped.json'), 'utf8'))
  const states = [{ installed: false }, { precise: false }, { wordSynced: true }, { timed: false }, { paused: true }, { pitch: fx.pieces },
    { aligned: true }, {}, { aligned: true, doc: M.expand(fx.entry) },
    { error: 'The pitch model is not downloaded: turn Sheet notes off and on to download it' },
    { aligned: true, error: 'No notes this time: ' + 'a long reason from the helper '.repeat(4) },
    { pitch: fx.pieces, error: 'Part of the pitch line is missing: ' + 'x'.repeat(80) }]
  for (const st of states) {
    const m = M.mode(Object.assign({}, base, st))
    assert.ok(m.text.length <= M.TEXT_MAX, JSON.stringify(st).slice(0, 80) + ' -> ' + m.text)
    assert.notEqual(m.label, 'Experimental', 'the label never repeats the Experimental chip')
    if (m.info) assert.ok(m.info.length > m.text.length, m.info)
  }
  // a long text: the part before its first ': ' stays, the whole sentence goes behind the ⓘ
  assert.deepEqual(M.fit('Part of the pitch line is missing: ' + 'y'.repeat(60)), { text: 'Part of the pitch line is missing', info: 'Part of the pitch line is missing: ' + 'y'.repeat(60) })
  assert.deepEqual(M.fit('short'), { text: 'short', info: '' })
  // no such part: it stays whole and wraps (never cut off)
  const long = 'w'.repeat(70)
  assert.deepEqual(M.fit(long), { text: long, info: '' })
  // the gate's long reason: "Pitch line only" stays, the reason goes behind the ⓘ
  const doc = M.expand(fx.entry)
  const m = M.mode(Object.assign({}, base, { aligned: true, doc, gate: { song: 'line', why: 'the singing sits off the pitch grid (80 cents): rap, speech or shouting', regions: [] } }))
  assert.deepEqual([m.text, m.info], ['Pitch line only', 'Pitch line only: the singing sits off the pitch grid (80 cents): rap, speech or shouting'])
})

test('band CSS: the label row wraps instead of cutting its words off; the staff sits under it', () => {
  const css = read('lyrics.html')
  const rule = (sel) => (css.match(new RegExp('\\n  ' + sel.replace(/[.#]/g, '\\$&') + ' \\{([^}]*)\\}')) || [])[1] || ''
  assert.match(rule('.sn-top'), /flex-wrap: wrap/)
  assert.doesNotMatch(rule('.sn-top'), /nowrap|(^|[ ;])height: 26px/)
  assert.doesNotMatch(rule('.sn-msg'), /ellipsis|nowrap/)
  assert.match(rule('.sn-staff'), /position: relative; height: 132px/)
})

test('first play: a realistic piece draws visible runs on the staff', () => {
  // the helper's pitch reply (align/server.py "pitch": { t0, hop 0.05, v MIDI x 10, 0 = no voice }), two sections
  const fx = fixture('cortez-feel-stripped')
  const line = M.mergePitch(fx.pieces)
  const runs = M.pitchRuns(line, 'treble8', 0, null)
  assert.ok(runs.length > 0, 'the line has runs')
  // on the staff (or a few ledger lines off it), not off the band
  assert.ok(runs.every((r) => r.every(([t, pos]) => t >= 25 && t < 50 && pos > -8 && pos < 16)))
})

// --- "Listening and learning" (Marcy 2026-10-18: "some kind of little green blinking dot") ---

test('listening: on while the part at the playhead has no line yet; off once its line arrives, past the lyrics, paused or on an error', () => {
  const fx = fixture('cortez-feel-stripped')
  const base = { on: true, installed: true, precise: true, timed: true, wordSynced: false, aligned: false, doc: null }
  const mode = (st) => M.mode(Object.assign({}, base, st))
  const covered = fx.pieces.map((p) => [p.t0, p.t0 + p.v.length * p.hop])
  const inside = (covered[0][0] + covered[0][1]) / 2
  const after = Math.max(...covered.map((c) => c[1])) + 5
  // pending: nothing heard yet, the playhead in the first part -> the dot, the label and the ⓘ's detail
  const L = M.listening(mode({ pitch: [] }), [], 12, 200)
  assert.deepEqual(L, M.LISTENING)
  assert.equal(L.label, 'Listening and learning')
  assert.ok(L.label.length <= M.TEXT_MAX)
  assert.equal(L.info, 'The pitch line for this part appears once Sonata has heard it; next play it’s there from the start.')
  // the next part, still being heard (the earlier sections' lines are in): on
  assert.equal(M.listening(mode({ pitch: fx.pieces }), fx.pieces, after, 200), M.LISTENING)
  // the part's line arrived (a piece covers the playhead): off, the line draws instead
  assert.equal(M.listening(mode({ pitch: fx.pieces }), fx.pieces, inside, 200), null)
  // past the lyrics' end: nothing left to hear, off (an end of 0 = unknown: still on)
  assert.equal(M.listening(mode({ pitch: fx.pieces }), fx.pieces, after, after - 1), null)
  assert.equal(M.listening(mode({ pitch: fx.pieces }), fx.pieces, after, 0), M.LISTENING)
  // priority: paused for a game or an error say their own words; the dot stays off
  const paused = mode({ paused: true, pitch: fx.pieces })
  assert.equal(paused.text, 'Paused while a game runs')
  assert.equal(M.listening(paused, fx.pieces, after, 200), null)
  const err = mode({ pitch: fx.pieces, error: 'Part of the pitch line is missing: timeout' })
  assert.equal(err.live, false)
  assert.equal(M.listening(err, fx.pieces, after, 200), null)
  assert.equal(M.listening(mode({ pitch: [], error: 'The pitch model is not downloaded' }), [], 12, 200), null)
  // not a first play: later plays' notes, a message, the band off -> never
  assert.equal(M.listening(mode({ aligned: true, doc: M.expand(fx.entry) }), [], 12, 200), null)
  assert.equal(M.listening(mode({ aligned: true }), [], 12, 200), null)
  assert.equal(M.listening(M.mode({ on: false }), [], 12, 200), null)
})

test('listening: the band shows it in the label row and on the staff at the playhead; one gap signal, not two', () => {
  const ui = read('sheet-notes-ui.js')
  assert.match(ui, /const L = M\.listening\(m, pieces, t, Number\(st\.end\) \|\| 0, entry && entry\.partial \? entry\.covered : null\)/)
  assert.match(ui, /label\.textContent = L \? L\.label : m\.label/)
  assert.match(ui, /const inf = L \? L\.info : \(m\.info \|\| ''\)/)
  assert.match(ui, /const headDot = el\(doc, 'span', 'sn-live', head\)/)
  // held still while the song is paused or the window hidden; no timer, no frame loop of its own
  assert.match(ui, /root\.classList\.toggle\('still', !\(opts\.playing\(\) && doc\.visibilityState === 'visible'\)\)/)
  assert.ok(!/lineGap|gapNote|once it has been sung/.test(ui + read('sheet-notes-model.js')), '0.15.47\'s gap message merged into it')
  // main sends where the lyrics end (the align session's span)
  assert.match(read('main.js'), /pieces: sheet\.pitch\.length, end: sheet\.end,/)
  // CSS: a theme token, an opacity pulse of ~1.2 s, paused when still, steady with reduced motion
  const html = read('lyrics.html')
  assert.match(html, /\.sn-live \{[^}]*background: var\(--s-live\); animation: sn-live 1\.2s ease-in-out infinite; \}/)
  assert.match(html, /@keyframes sn-live \{ 0%, 100% \{ opacity: 1; \} 50% \{ opacity: 0\.3; \} \}/)
  assert.match(html, /\.sn\.still \.sn-live \{ animation-play-state: paused; \}/)
  assert.match(html, /@media \(prefers-reduced-motion: reduce\) \{ \.sn-live \{ animation: none; \} \}/)
  // the token: green, in both themes, >= 3:1 (non-text) over any backdrop and album colour
  const T = require('../theme')
  for (const dark of [false, true]) {
    for (const p of [null, { accent: '#ffee00' }, { accent: '#20e070' }, { accent: '#2050ff' }]) {
      const t = T.themeTokens({ dark, palette: p })
      assert.ok(t.contrast.live >= 3, 'live ' + dark + JSON.stringify(p))
      const [r, g, b] = t.vars['--s-live'].match(/\d+/g).map(Number)
      assert.ok(g > r && g > b, 'green: ' + t.vars['--s-live'])
    }
  }
})

// --- the label matches the staff (Marcy 0.15.49, Mad Season "Wake Up (Live At the Moore)", second play, 4:50
// in a vocal break: "Notes · A minor · pitch line here: notes unsure" over an empty staff) ---

test('labelAt: an empty window says "no singing here"; the pitch-line clause only with a run in view', () => {
  const m = { band: 'notes', label: 'Notes · A minor', text: '', info: '' }
  const lineRegion = { t0: 261, t1: 331, show: 'line', line: null }
  const T = require('../lyrics-timing')
  // a break: the playhead's stretch is a 'line' one (stray voicing in the gap), but nothing is drawn or sung in view
  const notes = [{ t: 250, end: 251 }]
  const runs = [[[300.5, 3], [300.9, 4]]]
  const sung = M.lyricSpans([{ t: 244.12, end: 249.35, text: 'Yeah-oh, oh-oh-oh-oh' }, { t: 254.15, end: 261, text: 'Yeah-oh, oh-oh-oh-oh' }, { t: 331.78, end: 336.17, text: 'Wake up, young man' }], T.lineEnd)
  assert.deepEqual(sung, [[244.12, 249.35], [254.15, 261], [331.78, 336.17]])
  const sp = M.staffSpans(notes, runs, [], sung)
  const view = { width: 600, gutter: 60, pps: 110, headAt: 0.3, paged: false }
  const at = (t) => M.labelAt(m, lineRegion, M.seenIn(sp, M.viewWindow(t, view)))
  assert.equal(at(290), 'Notes · A minor · no singing here')
  assert.ok(at(290).length <= M.TEXT_MAX)
  assert.equal(M.QUIET.text, 'no singing here')
  assert.ok(M.QUIET.info.length > 0)
  // a pitch-line run in view: the clause is back
  assert.equal(at(300), 'Notes · A minor · pitch line here: notes unsure')
  // the lyrics' last line still in view (its end within the window behind the playhead): not quiet
  assert.equal(at(261.5), 'Notes · A minor · notes unsure here')
  // past the lyrics' end: quiet
  assert.equal(at(400), 'Notes · A minor · no singing here')
  // a sung stretch with notes: the plain label
  assert.equal(M.labelAt(m, { show: 'notes' }, M.seenIn(sp, M.viewWindow(250.5, view))), 'Notes · A minor')
  // a stretch whose notes are unsure and with no line drawn, while sung: says so (not "no singing")
  assert.equal(M.labelAt(m, { show: 'none' }, M.seenIn(sp, M.viewWindow(246, view))), 'Notes · A minor · notes unsure here')
  // the first play's band (line), a message ("Instrumental") and Listening and learning are untouched
  const line = M.mode({ on: true, installed: true, precise: true, timed: true, pitch: [] })
  assert.equal(M.labelAt(line, lineRegion, { sung: false, notes: false, line: false }), 'First play · pitch line')
  const inst = M.mode({ on: true, instrumental: 'title' })
  assert.equal(inst.text, 'Instrumental')
  assert.equal(M.labelAt(inst, null, { sung: false, notes: false, line: false }), '')
  assert.equal(M.listening(line, [], 290, 400), M.LISTENING)
})

test('viewWindow / seenIn / nextSeen: the window the staff shows and when what is in it changes', () => {
  const v = { width: 600, gutter: 60, pps: 110, headAt: 0.3, paged: false }
  const w = M.viewWindow(100, v)
  // the playhead sits 0.3 across the box: (180 - 60) / 110 s behind it, the rest of the staff ahead
  assert.ok(Math.abs(w.a - (100 - 120 / 110)) < 1e-9 && Math.abs(w.b - w.a - 540 / 110) < 1e-9)
  const paged = M.viewWindow(12, Object.assign({}, v, { paged: true }))
  assert.ok(paged.a <= 12 && paged.b > 12 && Math.abs(paged.b - paged.a - 540 / 110) < 1e-9)
  const sp = M.staffSpans([], [], [{ t: 110, end: 111 }], [])
  assert.deepEqual(M.seenIn(sp, w), { sung: false, notes: false, line: false })
  // the syllable at 110 enters the window when its end edge reaches 110
  const next = M.nextSeen(sp, 100, w, false)
  assert.ok(Math.abs(next - (110 - (w.b - 100))) < 1e-9)
  assert.equal(M.seenIn(sp, M.viewWindow(next + 0.01, v)).sung, true)
  // ... and leaves it once its end has passed the window's start
  const gone = M.nextSeen(sp, 111, M.viewWindow(111, v), false)
  assert.ok(Math.abs(gone - (111 + 120 / 110)) < 1e-9)
  assert.equal(M.seenIn(sp, M.viewWindow(gone + 0.01, v)).sung, false)
  assert.equal(M.nextSeen(sp, 12, paged, true), paged.b)
  // merged spans: overlapping syllables and notes make one
  assert.deepEqual(M.staffSpans([{ t: 1, end: 2 }], [], [{ t: 1.5, end: 3 }, { t: 5, end: 6 }]).sung, [[1, 3], [5, 6]])
})

test('wiring: main sends the lyric lines\' sung spans; the band labels from what is in view', () => {
  const main = read('main.js')
  assert.match(main, /sung: timed \? sheetModel\.lyricSpans\(shown \|\| lines, lyricsTiming\.lineEnd\)/)
  assert.match(main, /extra\.sung = sheet\.sung/)
  const ui = read('sheet-notes-ui.js')
  assert.match(ui, /M\.labelAt\(m, M\.regionAt\(gated && gated\.regions, t\), seen\)/)
  assert.match(ui, /M\.staffSpans\(drawn\.notes, drawn\.runs, doc2\.syllables, sung\)/)
  assert.match(ui, /M\.nextSeen\(/)
  assert.match(ui, /M\.QUIET\.info/)
})

// Marcy 2026-10-18, Sabrina Carpenter "House Tour" at 2:29: a high stretch of the pitch line was drawn above the
// staff with nothing to read it by, right under the label row. It now stays in the staff box's room, with ledger
// lines above/below the staff and, beyond the room, along the edge (out) with a mark where it leaves.
test('roomRuns: the pitch line stays in the staff box, with ledger lines and an honest edge', () => {
  const within = M.roomRuns([[[0, 2], [0.05, 4], [0.1, 6]]])
  assert.deepEqual(within, { runs: [{ pts: [[0, 2], [0.05, 4], [0.1, 6]], out: 0 }], ledgers: [], marks: [] })
  const high = M.roomRuns([[[0, 6], [0.05, 9], [0.1, 11], [0.15, 12], [0.2, 16], [0.25, 17], [0.3, 11], [0.35, 8]]])
  // never outside the room (the label row above, the syllables below)
  for (const r of high.runs) for (const [, p] of r.pts) assert.ok(p <= M.ROOM.hi && p >= M.ROOM.lo, String(p))
  // one stroke: each piece starts where the one before ended; the stretch past the top is marked out
  assert.deepEqual(high.runs.map((r) => r.out), [0, 1, 0])
  for (let i = 1; i < high.runs.length; i++) assert.deepEqual(high.runs[i].pts[0], high.runs[i - 1].pts[high.runs[i - 1].pts.length - 1])
  assert.deepEqual(high.runs[1].pts.slice(1).map((x) => x[1]), [M.ROOM.hi, M.ROOM.hi])
  assert.deepEqual(high.marks, [{ t: 0.2, pos: M.ROOM.hi, dir: 1 }])
  // ledger lines under the stretch that reaches them, as a note there would have
  assert.deepEqual(high.ledgers, [{ pos: 10, t0: 0.1, t1: 0.3 }, { pos: 12, t0: 0.15, t1: 0.25 }])
  // below the staff: the same, mirrored
  const low = M.roomRuns([[[0, 0], [0.05, -2], [0.1, -5], [0.15, 0]]])
  assert.deepEqual(low.runs.map((r) => r.out), [0, -1, 0])
  assert.deepEqual(low.marks, [{ t: 0.1, pos: M.ROOM.lo, dir: -1 }])
  assert.deepEqual(low.ledgers, [{ pos: -2, t0: 0.05, t1: 0.1 }])
  // the room is the staff box's: pos 12 is 20 px under its top (BASE 92, 6 px a step: room for the mark above it,
  // clear of the label row), pos -2 above the syllables (108 px)
  assert.equal(92 - M.ROOM.hi * 6, 20)
  assert.ok(92 - M.ROOM.lo * 6 + 3 < 108)
})

test('the band draws the pitch line through roomRuns and keeps notes in the room (sheet-notes-ui.js)', () => {
  const ui = require('fs').readFileSync(require('path').join(__dirname, '..', 'sheet-notes-ui.js'), 'utf8')
  assert.match(ui, /const fitted = M\.roomRuns\(runs\)/)
  assert.match(ui, /yOf\(Math\.max\(M\.ROOM\.lo, Math\.min\(M\.ROOM\.hi, n\.pos\)\)\)/)
})

test('store: a song with its notes keeps them when a later pass fails; repeated plays never regress them and stop asking after MAX_TRIES', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sheet-notes-'))
  try {
    const st = S.createSheetNotesStore({ dir })
    const good = { format: 1, lyricsHash: 'h', notes: [{ t: 1, end: 2, midi: 60 }], created: 'x' }
    st.set('Monday Morning', 'Fleetwood Mac', good)
    assert.ok(!st.missing('Monday Morning', 'Fleetwood Mac', 'h'))
    assert.ok(st.retryAllowed('Monday Morning', 'Fleetwood Mac'))
    // Expressive words' extra pass fails (a timeout on a CPU helper, say): the notes stay, the try is counted
    for (let k = 1; k <= S.MAX_TRIES; k++) {   // loop: NOT-WORTH — test, MAX_TRIES plays
      st.failed('Monday Morning', 'Fleetwood Mac', 'h', 'timeout')
      const e = st.get('Monday Morning', 'Fleetwood Mac')
      assert.ok(M.entryValid(e, 'h'), 'still valid notes after failed pass ' + k)
      assert.deepEqual(e.notes, good.notes)
      assert.deepEqual(e.retry, { failed: 'timeout', tries: k })
      assert.ok(!st.missing('Monday Morning', 'Fleetwood Mac', 'h'))
    }
    assert.ok(!st.retryAllowed('Monday Morning', 'Fleetwood Mac'), 'not recorded again on every play')
    // other lyrics: the old notes are not theirs, a plain marker as before
    st.failed('Monday Morning', 'Fleetwood Mac', 'h2', 'timeout')
    assert.equal(st.get('Monday Morning', 'Fleetwood Mac').failed, 'timeout')
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

// --- first play: notes and Expressive words section by section (0.15.66) ---

test('session, first play: each section\'s notes ride on its pitch job, with that section\'s own syllables in song time; the whole-song pass still runs', async () => {
  const env = setup({ sectionWanted: () => true, pitchWanted: () => false })
  env.s.setLyrics('Song|A', 'Song', 'A', VERSES, true)
  const secs = A.sections(VERSES)
  play(env, 0, secs[0].at + 1)
  assert.equal(env.s.notesState('Song|A'), 'recording')
  await settle()
  assert.equal(env.s.notesState('Song|A'), 'sections', 'the status line says it measures as it plays')
  play(env, secs[0].at + 1, secs[1].at + 1)
  await settle()
  assert.deepEqual(env.calls.map((c) => c.cmd + (c.final ? ':final' : '')), ['align', 'pitch', 'align', 'pitch', 'align:final', 'notes'])
  const jobs = env.calls.filter((c) => c.cmd === 'pitch')
  jobs.forEach((c, k) => {
    const sec = secs[k]
    assert.ok(c.given.syllables.length > 0)
    assert.ok(c.given.syllables.every((y) => y.line >= sec.from && y.line <= sec.to), 'only the section\'s own lines')
    assert.ok(c.given.syllables.every((y) => y.t >= VERSES[y.line].t - 1 && y.end > y.t), 'song time')
    assert.ok(c.given.span[0] <= c.given.syllables[0].t && c.given.span[1] >= c.given.syllables[c.given.syllables.length - 1].end)
  })
  assert.deepEqual(env.got.sections.map((x) => [x.from, x.to]), secs.slice(0, 2).map((x) => [x.from, x.to]))
  assert.deepEqual(env.got.pitch, [], 'no pitch line handed on while the band does not want one')
  assert.equal(env.got.done.length, 1, 'the whole-song notes come after, as before')
})

test('session: no section notes when not wanted (a processor-only helper, nothing showing them): the jobs are as before', async () => {
  const env = setup({ sectionWanted: () => false })
  env.s.setLyrics('Song|A', 'Song', 'A', VERSES, true)
  const secs = A.sections(VERSES)
  play(env, 0, secs[1].at + 1)
  await settle()
  assert.ok(env.calls.filter((c) => c.cmd === 'pitch').every((c) => !c.given))
  assert.equal(env.got.sections, undefined)
})

test('sectionGiven: aligned words of the section\'s lines, else the lyrics\' own word times; null with none', () => {
  const raw = [{ t: 1, text: 'one two' }, { t: 5, text: 'three', words: [{ text: 'three', t: 5.1, end: 5.6 }] }, { t: 9, text: 'four' }]
  const entry = { lines: { 0: { text: 'one two', words: [{ text: 'one', t: 1.1, end: 1.4 }, { text: 'two', t: 1.5, end: 2 }] } } }
  const g = A.sectionGiven(raw, entry, { from: 0, to: 1 }, null)
  assert.deepEqual(g.syllables.map((y) => [y.line, y.text]), [[0, 'one'], [0, 'two'], [1, 'three']])
  assert.equal(g.span[0], 1.05)
  assert.equal(A.sectionGiven(raw, null, { from: 2, to: 2 }, null), null)
})

test('mergeSections: sections in song order, notes on the merged syllables, pitch lines merged; drawn as the first play\'s notes', () => {
  const part = (off, t) => ({ section: { offset: off }, tuning: { cents: 10 }, syllables: [{ t, end: t + 0.4, text: 'la', line: off, syl: 0, nsyl: 1 }, { t: t + 0.5, end: t + 0.9, text: 'lo', line: off, syl: 0, nsyl: 1 }],
    notes: [{ t: t + 0.5, end: t + 0.9, midi: 64, cents: 0, syl_index: 1 }, { t, end: t + 0.4, midi: 62, cents: 0, syl_index: 0 }], pitch: { t0: off, hop: 0.05, v: [600, 610] } })
  const m = M.mergeSections([part(20, 21), part(0, 1)])
  assert.deepEqual(m.notes.map((n) => [n.t, n.syl_index]), [[1, 0], [1.5, 1], [21, 2], [21.5, 3]])
  assert.deepEqual(m.syllables.map((y) => y.line), [0, 0, 20, 20])
  assert.equal(m.pitch.t0, 0)
  assert.equal(m.tuning.cents, 10)
  const entry = Object.assign(M.compact(m, { lyricsHash: 'h', created: 'first-play:2' }), { partial: true })
  const doc = M.expand(entry)
  assert.equal(doc.notes.length, 4)
  assert.equal(doc.notes[2].line, 20)
  const st = { on: true, installed: true, precise: true, timed: true, aligned: false, wordSynced: false, partial: true, doc }
  const md = M.mode(st)
  assert.equal(md.band, 'notes')
  assert.equal(md.label, 'First play · notes')
  assert.ok(md.live)
  assert.equal(M.listening(md, [{ t0: 0, hop: 0.05, v: [1, 1] }], 50, 0), M.LISTENING, 'still listening where no section came yet')
  assert.equal(M.listening(md, [{ t0: 0, hop: 0.05, v: new Array(100).fill(1) }], 1, 0), null)
})

test('first play (0.15.70): merged parts draw at once in the first play\'s wider view; "Listening and learning" is off where they are; a play left early keeps them', () => {
  const part = (from, t) => ({ section: { offset: t - 1, span: [t, t + 8] }, tuning: { cents: 0 }, syllables: [{ t, end: t + 0.4, text: 'la', line: from, syl: 0, nsyl: 1 }],
    notes: [{ t, end: t + 0.4, midi: 62, cents: 0, conf: 0.9, syl_index: 0 }], pitch: { t0: t, hop: 0.05, v: [620, 620] }, expr: { words: [] } })
  const m = M.mergeSections([part(0, 10), part(4, 30)])
  assert.deepEqual(m.covered, [[10, 18], [30, 38]])
  const entry = Object.assign(M.compact(m, { lyricsHash: 'h', created: 'first-play:2' }), { partial: true })
  assert.deepEqual(entry.covered, [[10, 18], [30, 38]])
  const md = M.mode({ on: true, installed: true, precise: true, timed: true, wordSynced: true, partial: true, doc: M.expand(entry) })
  assert.equal(md.band, 'notes')
  assert.equal(md.first, true, 'the first play\'s view')
  // Listening: off inside a part that came (no pitch pieces needed), on past it
  assert.equal(M.listening(md, [], 12, 0, entry.covered), null)
  assert.equal(M.listening(md, [], 35, 0, entry.covered), null)
  assert.equal(M.listening(md, [], 25, 0, entry.covered), M.LISTENING)
  // the band: the first play's notes at the wider view, so a part sung a few seconds ago is still on the band
  const UI = require('../sheet-notes-ui')
  assert.ok(UI.PPS.first < UI.PPS.notes && UI.HEAD_AT.first > UI.HEAD_AT.notes)
  const past = (k) => (900 * UI.HEAD_AT[k]) / UI.PPS[k]
  assert.ok(past('first') >= 10, 'about 10 s heard stay on a 900 px band: ' + past('first'))
  assert.ok(read('sheet-notes-ui.js').includes("const geom = () => (m.band === 'line' ? 'line' : m.first ? 'first' : 'notes')"))
  // left before its end: a partial entry (parts kept, expression merged), still "missing" for the store
  const pe = M.partialEntry([[0, part(0, 10)], [4, part(4, 30)]], { format: 2, v: 2, words: [{ l: 0, w: 0 }], voc: [] }, { lyricsHash: 'h', created: 'x' })
  assert.equal(pe.partial, true)
  assert.equal(pe.notes.length, 2)
  assert.deepEqual(pe.parts.map((p) => p[0]), [0, 4])
  assert.ok(!('expr' in pe.parts[0][1]))
  assert.deepEqual(pe.expr.words, [{ l: 0, w: 0 }])
  assert.ok(M.entryValid(pe, 'h'))
  const S = require('../sheet-notes-store')
  const files = new Map()
  const io = { mkdirSync() {}, writeFileSync: (f, t) => files.set(f, t), renameSync: (a, b) => { files.set(b, files.get(a)); files.delete(a) }, readFileSync: (f) => { if (!files.has(f)) throw new Error('ENOENT'); return files.get(f) }, utimesSync() {}, readdirSync: () => [], statSync: () => ({ mtimeMs: 0 }), unlinkSync() {} }
  const store = S.createSheetNotesStore({ dir: '/x', io })
  store.set('Song', 'A', pe)
  assert.equal(store.missing('Song', 'A', 'h'), true, 'a partial entry is learned again')
  store.set('Song', 'A', Object.assign({}, pe, { partial: undefined }))
  assert.equal(store.missing('Song', 'A', 'h'), false)
})

test('main (0.15.70): a first play left early is kept and carried on; the pieces survive a re-layout', () => {
  const main = read('main.js')
  assert.match(main, /unfinished: firstPlayUnfinished,/)
  assert.match(main, /firstPlay = firstPlayFor\(s\)/)
  assert.match(main, /if \(sheetModel\.entryValid\(old, s\.hash\) && !old\.partial\) return   \/\/ learned notes are never replaced/)
  assert.match(main, /pitch: sheet && sheet\.key === key \? sheet\.pitch : \[\]/)
})
