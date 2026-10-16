const test = require('node:test')
const assert = require('node:assert/strict')
const V = require('../lyrics-view')

const lrc = [
  { t: 5, text: 'hello there world' },
  { t: 8, text: 'second line here' },
  { t: 20, text: 'after a break' }
]

test('prepare: estimates words when asked, finds interludes and sides', () => {
  const p = V.prepare({ lines: lrc, estimate: true })
  assert.equal(p.lines.length, 3)
  assert.ok(p.lines.every((l) => l.estimated && l.words.length === l.text.split(' ').length))
  assert.equal(p.wordTimed, true)
  assert.deepEqual(p.sides, ['', '', ''])
  assert.deepEqual(p.gaps.map((g) => g.index), [0, 2])   // intro (5 s) and the break before line 3
})

test('prepare: no estimate keeps line-only lyrics; empty and missing data are safe', () => {
  const p = V.prepare({ lines: lrc, estimate: false })
  assert.equal(p.lines, lrc)
  assert.equal(p.wordTimed, false)
  assert.deepEqual(V.prepare({}).lines, [])
  assert.deepEqual(V.prepare(null).lines, [])
})

test('prepare: same lines as the lyrics window got before (estimateWords result)', () => {
  const T = require('../lyrics-timing')
  assert.deepEqual(V.prepare({ lines: lrc, estimate: true }).lines, T.estimateWords(lrc))
})

test('refinedLine: applies new timing for the same words of an estimated line only', () => {
  const lines = V.prepare({ lines: lrc, estimate: true }).lines
  const words = lines[1].words.map((w) => ({ t: w.t + 0.1, end: w.end + 0.1, text: w.text }))
  const got = V.refinedLine(lines, { key: 'a|b', lineIndex: 1, words }, 'a|b')
  assert.ok(got.refined)
  assert.equal(got.words[0].t, words[0].t)
  assert.equal(got.text, lines[1].text)
  // wrong song, wrong words, not estimated, bad index
  assert.equal(V.refinedLine(lines, { key: 'x|y', lineIndex: 1, words }, 'a|b'), null)
  assert.equal(V.refinedLine(lines, { key: 'a|b', lineIndex: 1, words: words.slice(1) }, 'a|b'), null)
  assert.equal(V.refinedLine(lines, { key: 'a|b', lineIndex: 1, words: words.map((w) => ({ ...w, text: 'z' })) }, 'a|b'), null)
  assert.equal(V.refinedLine(lrc, { key: 'a|b', lineIndex: 1, words }, 'a|b'), null)
  assert.equal(V.refinedLine(lines, { key: 'a|b', lineIndex: 9, words }, 'a|b'), null)
  assert.equal(V.refinedLine(lines, null, 'a|b'), null)
})

test('stageNext: next line, the line after an interlude, nothing after the last', () => {
  assert.equal(V.stageNext(3, -1, null), 0)
  assert.equal(V.stageNext(3, 0, null), 1)
  assert.equal(V.stageNext(3, 2, null), -1)
  assert.equal(V.stageNext(3, 1, { index: 2, start: 10, end: 20 }), 2)
  assert.equal(V.stageNext(3, -1, { index: 0, start: 0, end: 5 }), 0)
})

test('alignedLines: aligned words replace the timing of matching lines, once', () => {
  const lines = V.prepare({ lines: lrc, estimate: true }).lines
  const words = lines[1].words.map((w) => ({ t: w.t + 0.2, end: w.end + 0.2, text: w.text }))
  const got = V.alignedLines(lines, { key: 'a|b', lines: { 1: { text: lines[1].text, words } } }, 'a|b')
  assert.deepEqual(got.changed, [1])
  assert.ok(got.lines[1].aligned)
  assert.equal(got.lines[1].estimated, undefined)   // aligned lines are never refined (Level 1)
  assert.equal(got.lines[1].words[0].t, words[0].t)
  assert.equal(got.lines[0], lines[0])               // other lines untouched
  assert.ok(lines[1].estimated)                      // the input isn't changed
  assert.equal(V.refinedLine(got.lines, { key: 'a|b', lineIndex: 1, words }, 'a|b'), null)
  // already aligned, wrong song, other text, other words, bad index, empty message
  assert.equal(V.alignedLines(got.lines, { key: 'a|b', lines: { 1: { text: lines[1].text, words } } }, 'a|b'), null)
  assert.equal(V.alignedLines(lines, { key: 'x|y', lines: { 1: { text: lines[1].text, words } } }, 'a|b'), null)
  assert.equal(V.alignedLines(lines, { key: 'a|b', lines: { 1: { text: 'other', words } } }, 'a|b'), null)
  assert.equal(V.alignedLines(lines, { key: 'a|b', lines: { 1: { text: lines[1].text, words: words.slice(1) } } }, 'a|b'), null)
  assert.equal(V.alignedLines(lines, { key: 'a|b', lines: { 9: { text: 'x', words } } }, 'a|b'), null)
  assert.equal(V.alignedLines(lines, { key: 'a|b' }, 'a|b'), null)
  assert.equal(V.alignedLines(lines, null, 'a|b'), null)
})

test('timingNote: aligned beats refined beats estimated', () => {
  const est = V.prepare({ lines: lrc, estimate: true }).lines
  const all = est.map((l) => { const o = Object.assign({}, l, { aligned: true }); delete o.estimated; return o })
  assert.equal(V.timingNote(all, true, true), 'Word timing aligned on this PC')
  assert.equal(V.timingNote([all[0], est[1]], true, false), 'Word timing aligned on this PC (some lines estimated)')
  assert.equal(V.timingNote(est, false, true), 'Word timing estimated, refined by listening')
  assert.equal(V.timingNote(est, false, false), 'Word timing estimated')
})

test('wordState: the whole word is current, the syllable being sung is marked; words without syl as before', () => {
  const words = [
    { t: 1, end: 2.4, text: 'Karaoke', syl: [{ t: 1, end: 1.3, text: 'Ka' }, { t: 1.3, end: 1.6, text: 'ra' }, { t: 1.6, end: 2, text: 'o' }, { t: 2.1, end: 2.4, text: 'ke' }] },
    { t: 2.5, end: 3, text: 'night' }
  ]
  assert.deepEqual(V.wordState(words, 0.5), { k: 0, now: -1, syl: -1 })
  assert.deepEqual(V.wordState(words, 1.1), { k: 1, now: 0, syl: 0 })
  assert.deepEqual(V.wordState(words, 1.45), { k: 1, now: 0, syl: 1 })
  assert.deepEqual(V.wordState(words, 1.8), { k: 1, now: 0, syl: 2 })
  assert.deepEqual(V.wordState(words, 2.05), { k: 1, now: 0, syl: -1 })   // between two syllables: none pops
  assert.deepEqual(V.wordState(words, 2.2), { k: 1, now: 0, syl: 3 })
  assert.deepEqual(V.wordState(words, 2.7), { k: 2, now: 1, syl: -1 })    // no syl: the word pops as a whole
  assert.deepEqual(V.wordState(words, 3.5), { k: 2, now: -1, syl: -1 })
  const T = require('../lyrics-timing')
  const plain = words.map(({ syl, ...w }) => w)
  for (const t of [0.5, 1.45, 2.7, 3.5]) {
    const p = T.wordPos(plain, t)
    assert.deepEqual(V.wordState(plain, t), { k: p.k, now: p.now, syl: -1 })
  }
})

test('nextChange wakes at syllable boundaries inside a word', () => {
  const T = require('../lyrics-timing')
  const lines = [{ t: 1, end: 3, text: 'Karaoke', words: [{ t: 1, end: 2.4, text: 'Karaoke', syl: [{ t: 1, end: 1.3, text: 'Ka' }, { t: 1.3, end: 2.4, text: 'raoke' }] }] }]
  assert.ok(Math.abs(T.nextChange(lines, 1.1) - 0.2) < 1e-9)
  assert.ok(Math.abs(T.nextChange(lines.map((l) => ({ ...l, words: l.words.map(({ syl, ...w }) => w) })), 1.1) - 1.3) < 1e-9)
})
