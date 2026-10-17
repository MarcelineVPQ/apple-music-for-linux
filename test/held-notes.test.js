// Held notes (0.15.34): a word stays lit for its whole hold, from every source of timing.
const test = require('node:test')
const assert = require('node:assert/strict')
const T = require('../lyrics-timing')
const A = require('../align-session')
const V = require('../lyrics-view')
const S = require('../lyrics-syllables')

const RAW = [{ t: 74.7, end: 81.47, text: 'Come take me home' }, { t: 81.08, end: 84, text: 'Oh I need you now' }, { t: 90, text: 'Later' }]

test('aligned entries carry the aligner\'s holds (held, holdFrom); old entries are aligned again', () => {
  assert.equal(A.ENTRY_VERSION, 2)
  const result = { lines: [{ line: 0, aligned: true, words: [
    { t: 74.79, end: 75.01, text: 'Come' }, { t: 75.07, end: 75.27, text: 'take' }, { t: 75.31, end: 75.41, text: 'me' },
    { t: 75.57, end: 80.95, text: 'home', held: true, hold_from: 75.91 }] }] }
  const e = A.entryFromResult(result, RAW, null)
  const home = e.lines[0].words[3]
  assert.deepEqual(home, { t: 75.57, end: 80.95, text: 'home', held: true, holdFrom: 75.91 })
  assert.equal(e.lines[0].words[0].held, undefined)
  // a version-1 entry (before holds) is stale: the song is aligned again
  const old = Object.assign({}, e, { version: 1 })
  assert.equal(A.prepareLines(RAW, { estimate: true, entry: old }).aligned, false)
  const shown = A.prepareLines(RAW, { estimate: true, entry: e })
  assert.equal(shown.aligned, true)
  assert.equal(shown.lines[0].words[3].held, true)
})

test('the overlap: a held word stays lit while the next line is current, until the voice stops', () => {
  const lines = V.learnFrom(A.prepareLines(RAW, { estimate: true, entry: A.entryFromResult({ lines: [{ line: 0, aligned: true, words: [
    { t: 74.79, end: 75.01, text: 'Come' }, { t: 75.07, end: 75.27, text: 'take' }, { t: 75.31, end: 75.41, text: 'me' },
    { t: 75.57, end: 81.4, text: 'home', held: true, hold_from: 75.91 }] }] }, RAW, null) }).lines)
  // at 81.3 the next line (81.08) is the latest, and "home" (line 0, word 3) is still the lit word
  const { latest, live } = T.liveLines(lines, 81.3)
  assert.equal(latest, 1)
  assert.ok(live.includes(0) && live.includes(1))
  assert.equal(V.wordState(lines[0].words, 81.3 + V.WORD_LEAD).now, 3)
  // it lets go when the voice does (or HOLD_OVER past an anchor-only next line, whichever first)
  assert.ok(!T.liveLines(lines, 81.7).live.includes(0))
})

test('boundHolds: never past the next line\'s first real word; at most HOLD_OVER past an anchor', () => {
  const held = (end) => [{ t: 0, words: [{ t: 0, end: 0.3, text: 'a' }, { t: 0.4, end, text: 'home', held: true, holdFrom: 0.8 }], aligned: true }]
  // next line only an anchor (estimated): HOLD_OVER past its start
  let lines = T.boundHolds(held(9).concat([{ t: 5, text: 'b c', words: [{ t: 5, end: 5.4, text: 'b' }, { t: 5.4, end: 6, text: 'c' }], estimated: true }]))
  assert.equal(lines[0].words[1].end, 5 + T.HOLD_OVER)
  // next line aligned: its first word bounds it
  lines = T.boundHolds(held(9).concat([{ t: 5, text: 'b', words: [{ t: 5.2, end: 5.5, text: 'b' }], aligned: true }]))
  assert.ok(Math.abs(lines[0].words[1].end - 5.16) < 1e-9)
  assert.equal(lines[0].words[1].held, true)
  // nothing to bound: the same array
  const same = held(4).concat([{ t: 5, text: 'b', words: [{ t: 5, end: 5.5, text: 'b' }] }])
  assert.equal(T.boundHolds(same), same)
})

test('copyWord keeps the hold through repeats, refinements and alignments', () => {
  assert.deepEqual(T.copyWord({ t: 1, end: 4, text: 'x', held: true, holdFrom: 1.5 }, 10), { t: 11, end: 14, text: 'x', held: true, holdFrom: 11.5 })
  assert.deepEqual(T.copyWord({ t: 1, end: 2, text: 'y' }), { t: 1, end: 2, text: 'y' })
  const r = V.refinedLine([{ t: 0, estimated: true, words: [{ t: 0, end: 1, text: 'oh' }] }], { key: 'k', lineIndex: 0, words: [{ t: 0.1, end: 2.5, text: 'oh', held: true }] }, 'k')
  assert.equal(r.words[0].held, true)
})

test('syllables: the hold belongs to the last syllable (for-ev-er: "for-ev" quick, "er" held)', () => {
  const hy = S.hyphenatorFor('en')
  const w = { t: 10, end: 14, text: 'forever', held: true, holdFrom: 10.6 }
  const [out] = S.withSyllables([w], hy)
  assert.ok(out.syl && out.syl.length === 3, JSON.stringify(out.syl))
  assert.ok(out.syl[1].end <= 10.6 + 1e-9, 'the first syllables are sung before the hold')
  assert.equal(out.syl[2].end, 14)
  assert.ok(out.syl[2].end - out.syl[2].t > 3, 'the last syllable carries the hold')
  // Level 1 marks a word held without saying where the hold starts: a short sung part, the rest held
  const l1 = S.withSyllables([{ t: 10, end: 14, text: 'forever', held: true }], hy)[0]
  assert.ok(l1.syl[2].end - l1.syl[2].t > 2.5)
  // estimated holds too (holdFrom set by the estimator)
  const est = T.estimateWords([{ t: 0, text: 'take me forever' }, { t: 9, text: 'x' }], { pace: 0.25 })[0].words[2]
  assert.ok(est.holdFrom > est.t && est.holdFrom < est.end)
})

test('sustain: a held word that has sung a while is marked to settle (no repeated pop)', () => {
  const words = [{ t: 0, end: 0.3, text: 'come' }, { t: 0.4, end: 4, text: 'home', held: true, holdFrom: 0.8 }]
  assert.equal(V.wordState(words, 0.5).hold, false, 'the pop first')
  assert.equal(V.wordState(words, 1.5).hold, true, 'then the gentle sustain while the note holds')
  assert.equal(V.wordState(words, 0.2).hold, false)
  // the view wakes up at that moment (nextChange), so the sustain lands without polling
  assert.ok(Math.abs(T.nextChange([{ t: 0, words }], 0.5) - (0.8 + V.SUSTAIN_AFTER - 0.5)) < 1e-9)
})
