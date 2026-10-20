// A learned song whose saved notes have a gap where the lyrics say someone sings learns itself again
// (0.15.63, sheet-notes-model.js notesGap / relearnDue; main.js notesRelearn). The fixture is a real
// cached entry ("Lay All Your Love On Me": its first ~20 s weren't captured), syllable texts replaced.
const test = require('node:test')
const assert = require('node:assert')
const path = require('path')
const m = require('../sheet-notes-model')

const fixture = () => JSON.parse(require('fs').readFileSync(path.join(__dirname, 'fixtures', 'notes-gap-lay-all.json'), 'utf8'))

// a synthetic entry: lines of 4 syllables over 3 s, each [t0, line]; voiced: (t) => whether the pitch is voiced at t
function song(lines, voiced, dur = 200) {
  const syl = []
  const notes = []
  // loop: NOT-WORTH — a test song's lines
  lines.forEach(([t0, line]) => {
    // loop: NOT-WORTH — 4 syllables
    for (let k = 0; k < 4; k++) {
      const t = t0 + k * 0.75
      if (voiced(t)) notes.push([t, t + 0.6, 60, 2, 'C4', 900, syl.length, 0])
      syl.push([t, t + 0.6, 'la', line, k, 1])
    }
  })
  const v = []
  // loop: NOT-WORTH — a test song's pitch frames
  for (let i = 0; i < dur / 0.05; i++) v.push(voiced(i * 0.05) ? 660 : 0)
  return { format: m.FORMAT, lyricsHash: 'h', notes, syl, pitch: { t0: 0, hop: 0.05, v }, duration: dur, key: { name: 'C major', fifths: 0 } }
}
const every = (from, to, step) => { const out = []; let line = 0; for (let t = from; t < to; t += step) out.push([t, line++]); return out }

test('the fixture: its unrecorded start is a gap where the lyrics are sung', () => {
  const gap = m.notesGap(fixture())
  assert.ok(gap, 'a gap')
  assert.ok(gap.from < 1 && gap.to > 7 && gap.to < 22, JSON.stringify(gap))
  assert.ok(m.relearnDue(fixture()))
})

test('a fully covered song has no gap', () => {
  assert.strictEqual(m.notesGap(song(every(10, 190, 4), () => true)), null)
})

test('a long instrumental break (no timed words) is not a gap', () => {
  const lines = every(10, 80, 4).concat(every(140, 190, 4).map(([t, l]) => [t, l + 100]))
  assert.strictEqual(m.notesGap(song(lines, (t) => t < 82 || t >= 138)), null)
})

test('a sung stretch with no voice in the notes is a gap', () => {
  const gap = m.notesGap(song(every(10, 190, 4), (t) => t < 60 || t >= 80))
  assert.ok(gap && gap.from >= 60 && gap.to <= 80 && gap.lines >= 2, JSON.stringify(gap))
})

test('a song that is barely voiced anywhere is not judged (the rest is not well covered)', () => {
  assert.strictEqual(m.notesGap(song(every(10, 190, 4), (t) => t > 180)), null)
})

test('at most RELEARN_MAX re-learns: then the song keeps what it has', () => {
  const e = fixture()
  assert.strictEqual(m.RELEARN_MAX, 2)
  e.relearns = 1
  assert.ok(m.relearnDue(e))
  e.relearns = 2
  assert.strictEqual(m.relearnDue(e), null)
  assert.strictEqual(m.relearnDue(Object.assign(fixture(), { failed: 'error' })), null)
})

test('main asks for a re-learn through the notes "missing" check and counts it on the new result', () => {
  const src = require('fs').readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8')
  assert.match(src, /notesRelearn\(title, artist, hash\)\)\)/)
  assert.match(src, /re-learning this play \('/)
  assert.match(src, /entry\.relearns = n/)
})
