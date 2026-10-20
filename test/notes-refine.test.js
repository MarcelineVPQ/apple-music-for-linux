// Songs keep refining their notes until they're complete (0.15.71, notes-refine.js; main.js notesRefineDue,
// sheetNotesDone's merge): per-line coverage, the merge that keeps the better line, the stop rules, the words.
const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')
const r = require('../notes-refine')
const m = require('../sheet-notes-model')

// a synthetic entry: `lines` lines of 4 syllables over 3 s (one every 4 s); has(line, k): whether syllable k of
// that line has a note; conf: the notes' confidence (‰); rate: syllables a second (fast lines are rapped)
function song(lines, has, conf = 900, spacing = 0.75) {
  const syl = []
  const notes = []
  const v = []
  // loop: NOT-WORTH — a test song's lines
  for (let line = 0; line < lines; line++) {
    // loop: NOT-WORTH — 4 syllables
    for (let k = 0; k < 4; k++) {
      const t = line * 4 + k * spacing
      if (has(line, k)) notes.push([t, t + spacing * 0.8, 60 + line, 2, 'C4', conf, syl.length, 0])
      syl.push([t, t + spacing * 0.8, 'la', line, 0, 1])
    }
  }
  // loop: NOT-WORTH — a test song's pitch frames
  for (let i = 0; i < lines * 4 / 0.05; i++) v.push(660)
  return { format: m.FORMAT, lyricsHash: 'h', notes, syl, pitch: { t0: 0, hop: 0.05, v }, duration: lines * 4, key: { name: 'C major', fifths: 0 } }
}

test('coverage per sung line: syllables with a linked note / the line\'s syllables', () => {
  const e = song(4, (l, k) => l !== 2 || k === 0)
  const q = r.lineQuality(e)
  assert.deepStrictEqual(q.map((l) => l.coverage), [1, 1, 0.25, 1])
  const s = r.summary(q)
  assert.deepStrictEqual(s.below, [2])
  assert.strictEqual(s.coverage, 0.813)
})

test('rapped lines and instrumentals are not refined', () => {
  // 4 syllables in 0.6 s: 6.7 a second, past the gate's rapRate
  const rap = song(3, () => false, 900, 0.15)
  assert.deepStrictEqual(r.lineQuality(rap), [])
  assert.strictEqual(r.refineDue(rap), null)
  const instrumental = Object.assign(song(1, () => true), { syl: [], notes: [] })
  assert.strictEqual(r.refineDue(instrumental), null)
})

test('a song with lines below TARGET is due; a complete, failed, partial or settled one is not', () => {
  const low = song(4, (l, k) => l < 2 || k === 0)
  assert.deepStrictEqual(r.refineDue(low), { below: [2, 3], coverage: 0.625, play: 1 })
  assert.strictEqual(r.refineDue(song(4, () => true)), null)
  assert.strictEqual(r.refineDue(Object.assign(low, { partial: true })), null)
  assert.strictEqual(r.refineDue({ format: 1, failed: 'error' }), null)
  assert.strictEqual(r.refineDue(Object.assign(song(4, (l, k) => k === 0), { refine: { settled: true, plays: 2 } })), null)
})

test('merge keeps the better line, never a worse one', () => {
  const old = song(4, (l, k) => (l === 0 ? true : l === 1 ? k < 3 : k === 0))     // 100 %, 75 %, 25 %, 25 %
  const fresh = song(4, (l, k) => (l === 0 ? k === 0 : l === 1 ? k < 2 : true))  // 25 %, 50 %, 100 %, 100 %
  const res = r.merge(old, fresh, { at: 'now' })
  assert.deepStrictEqual(res.improved, [2, 3])
  assert.deepStrictEqual(r.lineQuality(res.entry).map((l) => l.coverage), [1, 0.75, 1, 1])
  // every line at least as good as before
  const before = r.lineQuality(old)
  r.lineQuality(res.entry).forEach((l, i) => assert.ok(l.covered >= before[i].covered))
  // the taken lines' notes are linked to the old entry's syllables; the kept ones are untouched
  assert.ok(res.entry.notes.every((n) => n[6] >= 0 && res.entry.syl[n[6]][3] === n[2] - 60))
  assert.strictEqual(res.before.coverage, 0.563)
  assert.strictEqual(res.after.coverage, 0.938)
  assert.deepStrictEqual(res.entry.refine.history, [{ at: 'now', play: 1, coverage: 0.938, lines: 2 }])
  assert.strictEqual(res.entry.refine.still, 0)
})

test('as many syllables: only a clearly more confident line is taken', () => {
  const old = song(2, (l, k) => k < 2, 700)
  assert.deepStrictEqual(r.merge(old, song(2, (l, k) => k < 2, 710)).improved, [])
  assert.deepStrictEqual(r.merge(old, song(2, (l, k) => k < 2, 760)).improved, [0, 1])
  // fewer syllables, however confident: kept
  assert.deepStrictEqual(r.merge(old, song(2, (l, k) => k < 1, 990)).improved, [])
})

test('settles when every line is complete', () => {
  const res = r.merge(song(2, (l, k) => k < 2), song(2, () => true))
  assert.strictEqual(res.entry.refine.settled, true)
  assert.strictEqual(r.refineDue(res.entry), null)
})

test('settles after STILL_MAX plays in a row with no improvement, and never runs past MAX_PLAYS', () => {
  let e = song(3, (l, k) => k === 0)
  const same = song(3, (l, k) => k === 0)
  // loop: NOT-WORTH — STILL_MAX test plays
  for (let i = 1; i <= r.STILL_MAX; i++) {
    assert.ok(r.refineDue(e), 'play ' + i + ' is due')
    e = r.merge(e, same).entry
    assert.strictEqual(e.refine.still, i)
  }
  assert.strictEqual(e.refine.settled, true)
  assert.strictEqual(r.refineDue(e), null)
  // an improvement resets the count; MAX_PLAYS is the hard stop
  let f = song(3, (l, k) => k === 0)
  // loop: NOT-WORTH — MAX_PLAYS test plays
  for (let i = 0; i < r.MAX_PLAYS; i++) f = r.merge(f, i % 2 ? same : song(3, (l, k) => k === 0, 900 + 30 * (i + 1))).entry
  assert.strictEqual(f.refine.plays, r.MAX_PLAYS)
  assert.strictEqual(f.refine.settled, true)
  assert.ok(f.refine.history.length <= r.HISTORY_MAX)
})

test('the status line and the log say what happens, in at most 60 characters', () => {
  const e = song(10, (l, k) => l < 3 || k === 0)
  const due = r.refineDue(e)
  assert.strictEqual(r.logStart('expectations', due), '"expectations": refining 7 lines (coverage 48 %) — play 1')
  const s = r.statusText(r.quality(e), true)
  assert.strictEqual(s.text, 'Refining this song: 7 lines to go')
  assert.ok(s.text.length <= 60)
  assert.match(s.info, /coverage, not accuracy/)
  assert.strictEqual(r.statusText(r.quality(e), false), null)
  const done = r.merge(e, song(10, () => true))
  assert.strictEqual(r.logDone('expectations', done), '"expectations": refined 7 lines (48 % → 100 %) — settled: 100 % of sung syllables have notes')
  const st = r.statusText(r.quality(done.entry), false)
  assert.strictEqual(st.text, 'Notes for 100 % of sung syllables · settled')
  assert.ok(st.text.length <= 60)
  assert.strictEqual(r.logDone('x', r.merge(e, e)), '"x": no line improved this play (1/' + r.STILL_MAX + ') — settled: 48 % of sung syllables have notes')
})

test('the band shows the refine line where notes show', () => {
  const doc = m.expand(song(2, () => true))
  const md = m.mode({ on: true, installed: true, precise: true, aligned: true, timed: true, doc, refine: { text: 'Refining this song: 2 lines to go', info: 'i' } })
  assert.strictEqual(md.text, 'Refining this song: 2 lines to go')
  assert.strictEqual(md.info, 'i')
})

test('main: a learned song below target is recorded again and merged, the helper idle, the learned expression kept drawing', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8')
  assert.match(src, /notesRelearn\(title, artist, hash\) \|\| notesRefineDue\(title, artist, hash\)/)
  assert.match(src, /if \(!due \|\| \(alignSession && alignSession\.waiting\)\) return false/)
  assert.match(src, /merged = notesRefine\.merge\(old, entry/)
  assert.match(src, /if \(!learned && expressiveOn\(\)/)
  assert.match(src, /notesRefine\.logStart\(title, due\)/)
  assert.ok(require('../package.json').build.files.includes('notes-refine.js'))
})

test('every timed sung syllable is represented where its pitch was heard (fillNotes), faded, never counted by the gate', () => {
  // line 0: one measured note held over syllables 0-1 (same pitch), syllable 2 voiced but no note, syllable 3 unvoiced
  const e = song(1, (l, k) => k === 0)
  e.notes[0][1] = 1.4                                     // held over syllable 1's onset (0.75 s)
  e.pitch.v = e.pitch.v.map((x, i) => (i * 0.05 >= 2.25 ? 0 : i * 0.05 >= 1.5 ? 643 : 600))
  const d = m.expand(e)
  const f = m.fillNotes(d)
  const by = (i) => f.notes.filter((n) => n.syl_index === i)
  assert.strictEqual(by(0)[0].end, 0.75)                  // cut at the next syllable's onset
  assert.deepStrictEqual([by(1)[0].fill, by(1)[0].midi, by(1)[0].t], ['split', 60, 0.75])
  assert.deepStrictEqual([by(2)[0].fill, by(2)[0].midi, by(2)[0].cents], ['pitch', 64, 30])
  assert.ok(by(2)[0].conf <= m.FILL.confMax)
  assert.strictEqual(by(3).length, 0)                     // nothing heard: no note
  // the gate and the refine coverage see the measured notes only
  assert.deepStrictEqual(m.gate(f).regions.map((x) => x.show), m.gate(d).regions.map((x) => x.show))
  assert.ok(m.layout(f).notes.filter((n) => n.fill).length === 2)
  assert.strictEqual(r.lineQuality(e)[0].covered, 1)
  // no overlap with measured notes; the band builds from the filled doc
  assert.ok(f.notes.every((n, i) => i === 0 || n.t >= f.notes[i - 1].end - 1e-9))
  assert.match(fs.readFileSync(path.join(__dirname, '..', 'sheet-notes-ui.js'), 'utf8'), /M\.fillNotes\(M\.expand\(entry\)\)/)
})
