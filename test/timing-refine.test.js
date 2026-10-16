const test = require('node:test')
const assert = require('node:assert/strict')
const { refineWords, mergeLearned, noiseRate, REFINE } = require('../timing-refine')
const { estimateWords, wordWeight } = require('../lyrics-timing')

// One estimated LRC line (10 s) followed by another at 13 s, in the shape these refine cases were
// written for: the words spread over 0.9 of the time to the next line (at most 0.6 s per word + 2 s),
// weighted like the estimate. The paced default estimate is tested in lyrics-timing.test.js and
// measured with tools/drift-check.
function lineAt(text = 'hold the line now', t = 10, next = 13) {
  const parts = text.split(' ')
  const span = 0.9 * Math.min(next - t, 0.6 * parts.length + 2)
  const weights = parts.map(wordWeight)
  const total = weights.reduce((a, b) => a + b, 0)
  let acc = 0
  const words = parts.map((w, k) => {
    const at = t + (acc / total) * span
    acc += weights[k]
    return { t: at, end: t + (acc / total) * span, text: w }
  })
  return { t, text, words, estimated: true }
}
const onset = (t, strength = 1) => ({ t, strength })

function checkRules(line, words, nextStart, opts = {}) {
  const P = Object.assign({}, REFINE, opts)
  assert.equal(words.length, line.words.length)
  words.forEach((w, i) => {
    assert.equal(w.text, line.words[i].text)
    assert.ok(Math.abs(w.t - line.words[i].t) <= P.maxShift + 1e-9, `word ${i} moved ${w.t - line.words[i].t}`)
    assert.ok(w.t >= line.t - 1e-9, 'starts inside its line')
    assert.ok(w.end - w.t >= P.minWord - 1e-9, 'minimum length')
    if (i) assert.ok(w.t >= words[i - 1].t + P.minWord - 1e-9, 'order kept')
    if (nextStart != null) assert.ok(w.end <= nextStart + 1e-9, 'ends before the next line')
  })
}

test('no evidence: no change', () => {
  const line = lineAt()
  for (const ev of [{ onsets: [], voiced: [] }, {}, null]) {
    const r = refineWords(line, ev, { nextStart: 13 })
    assert.equal(r.moved, 0)
    assert.equal(r.confidence, 0)
    r.words.forEach((w, i) => { assert.equal(w.t, line.words[i].t); assert.equal(w.end, line.words[i].end) })
  }
})

test('clean onsets: syncopated words move to where they are sung', () => {
  const line = lineAt()
  // estimate: 10, 10.675, 11.35, 12.025 (equal weights over 0.9 × 3 s); sung earlier/later
  assert.deepEqual(line.words.map((w) => +w.t.toFixed(3)), [10, 10.675, 11.35, 12.025])
  const sung = [10.0, 10.45, 11.05, 11.75]
  const r = refineWords(line, { onsets: sung.map((t) => onset(t)), voiced: [] }, { nextStart: 13 })
  checkRules(line, r.words, 13)
  r.words.forEach((w, i) => assert.ok(Math.abs(w.t - sung[i]) < 0.02, `${w.text} ${w.t} vs ${sung[i]}`))
  assert.ok(r.moved >= 3 && r.confidence > 0.5)
})

test('never further than maxShift, even when the onsets say so', () => {
  const line = lineAt('a b c d e f', 10, 16)
  const sung = line.words.map((w, i) => (i ? w.t - 0.6 : w.t))   // everything after the first is 0.6 s early
  const r = refineWords(line, { onsets: sung.map((t) => onset(t)) }, { nextStart: 16 })
  checkRules(line, r.words, 16)
  assert.ok(r.words.slice(1).every((w, i) => w.t < line.words[i + 1].t - 0.2), 'moved toward the onsets')
})

test('onsets before the line start pull the first word to the line start, not earlier', () => {
  const line = lineAt()
  const r = refineWords(line, { onsets: [onset(9.92), onset(10.6), onset(11.2), onset(11.8)] }, { nextStart: 13 })
  assert.equal(r.words[0].t, 10)
  checkRules(line, r.words, 13)
})

test('random onsets everywhere (noise): no wrong moves beyond the rules, gated by density', () => {
  let seed = 7
  const R = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648 }
  const line = lineAt('one two three four five six', 10, 15)
  for (let k = 0; k < 50; k++) {
    const onsets = []
    for (let t = 9.5; t < 15.5; t += 0.03 + R() * 0.12) onsets.push(onset(t, 0.9 + 0.1 * R()))
    const r = refineWords(line, { onsets }, { nextStart: 15 })
    checkRules(line, r.words, 15)
    assert.equal(r.moved, 0, 'a line drowning in onsets is left alone')
  }
})

test('weak onsets are ignored', () => {
  const line = lineAt()
  const r = refineWords(line, { onsets: [10, 10.45, 11.05, 11.5].map((t) => onset(t, 0.3)) }, { nextStart: 13 })
  assert.equal(r.moved, 0)
})

test('a noisy mix (high noise rate) is left alone', () => {
  const line = lineAt()
  const ev = { onsets: [10, 10.45, 11.05, 11.5].map((t) => onset(t)) }
  assert.equal(refineWords(line, ev, { nextStart: 13, noiseRate: 3 }).moved, 0)
  assert.ok(refineWords(line, ev, { nextStart: 13, noiseRate: 0.2 }).moved > 0)
})

test('held last word stretches to the end of its voiced note, bounded by the next line', () => {
  const line = lineAt('hold the line now', 10, 15)
  const sung = [10.0, 10.35, 10.7, 11.0]
  const est = line.words[3]
  const r = refineWords(line, { onsets: sung.map((t) => onset(t)), voiced: [{ start: 11.0, end: 14.2, confidence: 0.8 }] }, { nextStart: 15 })
  checkRules(line, r.words, 15)
  assert.ok(Math.abs(r.words[3].end - 14.2) < 1e-9, `end ${r.words[3].end}, estimate ${est.end}`)
  assert.equal(r.words[3].held, true)
  // a note that runs into the next line stops at it
  const r2 = refineWords(line, { onsets: sung.map((t) => onset(t)), voiced: [{ start: 11.0, end: 16, confidence: 0.8 }] }, { nextStart: 15 })
  assert.equal(r2.words[3].end, 15)
  checkRules(line, r2.words, 15)
})

test('voicing with a new syllable (onset) inside is not a hold', () => {
  const line = lineAt('hold the line now', 10, 15)
  const sung = [10.0, 10.35, 10.7, 11.0]
  const plain = refineWords(line, { onsets: sung.map((t) => onset(t)), voiced: [{ start: 10, end: 14.2, confidence: 0.8 }] }, { nextStart: 15 })
  assert.equal(plain.words[3].end, 14.2)
  const r = refineWords(line, { onsets: [...sung, 13.9].map((t) => onset(t)), voiced: [{ start: 10, end: 14.2, confidence: 0.8 }] }, { nextStart: 15 })
  assert.ok(r.words[3].end < 14, 'no stretch past a new syllable')
})

test('weak voicing does not stretch', () => {
  const line = lineAt('hold the line now', 10, 15)
  const r = refineWords(line, { onsets: [], voiced: [{ start: 11.0, end: 14.2, confidence: 0.1 }] }, { nextStart: 15 })
  assert.equal(r.moved, 0)
})

test('order kept with adversarial onsets: words never swap or collapse', () => {
  const line = lineAt('a b c d', 10, 12)
  const r = refineWords(line, { onsets: [onset(10.05), onset(10.08), onset(10.1), onset(10.12)] }, { nextStart: 12 })
  checkRules(line, r.words, 12)
})

test('Apple line-only lyrics: a line end bounds the words too', () => {
  const line = estimateWords([{ t: 10, end: 11.9, text: 'hold the line now' }, { t: 13, text: 'next' }])[0]
  const r = refineWords(line, { onsets: [onset(10), onset(10.45), onset(11.05), onset(11.5)], voiced: [{ start: 11.5, end: 12.8, confidence: 0.9 }] }, { nextStart: 13 })
  checkRules(line, r.words, 11.9)
})

test('mergeLearned: running average across plays, restart on changed lyrics', () => {
  const a = [{ t: 1, end: 2, text: 'x' }, { t: 2, end: 3, text: 'y' }]
  const b = [{ t: 1.2, end: 2.2, text: 'x' }, { t: 2.4, end: 3.4, text: 'y', held: true }]
  assert.deepEqual(mergeLearned(null, b, 1), [{ t: 1.2, end: 2.2, text: 'x' }, { t: 2.4, end: 3.4, text: 'y', held: true }])
  const m = mergeLearned(a, b, 2)
  assert.ok(Math.abs(m[0].t - 1.1) < 1e-9 && Math.abs(m[1].t - 2.2) < 1e-9 && Math.abs(m[1].end - 3.2) < 1e-9)
  assert.equal(m[1].held, true)
  const late = mergeLearned(a, b, 50)                 // capped: a new play still counts 1/5
  assert.ok(Math.abs(late[0].t - 1.04) < 1e-9)
  const changed = mergeLearned(a, [{ t: 5, end: 6, text: 'z' }, { t: 6, end: 7, text: 'y' }], 3)
  assert.deepEqual(changed, [{ t: 5, end: 6, text: 'z' }, { t: 6, end: 7, text: 'y' }])
  assert.equal(mergeLearned(a, b.slice(0, 1), 2).length, 1)
})

test('noiseRate: onsets per second in the intro and interludes only', () => {
  const lines = estimateWords([{ t: 10, text: 'a b' }, { t: 12, text: 'c d' }, { t: 30, text: 'e' }])
  const onsets = [onset(2), onset(3), onset(4), onset(11), onset(11.5), onset(20), onset(25, 0.2)]
  const r = noiseRate(onsets, lines)
  // intro 0.5–9.5 (9 s, 3 onsets) + interlude after line 2 to 29.5 (1 onset at 20; 25 is weak)
  assert.ok(r.seconds > 20)
  assert.ok(Math.abs(r.rate - 4 / r.seconds) < 1e-9)
  assert.equal(noiseRate(onsets, lines, 2).rate, null)     // under 3 s heard so far
})

test('held flag: a long word is held only if its tail is one note (no syllable onset in it)', () => {
  const line = lineAt('aah ooh', 10, 13)
  const voiced = [{ start: 9.9, end: 12.75, confidence: 0.9 }]
  const held = refineWords(line, { onsets: [], voiced }, { nextStart: 13 })
  assert.equal(held.words[1].held, true)
  const sung = refineWords(line, { onsets: [onset(12.4, 0.6)], voiced }, { nextStart: 13 })
  assert.ok(!sung.words[1].held)
  checkRules(line, sung.words, 13)
})
