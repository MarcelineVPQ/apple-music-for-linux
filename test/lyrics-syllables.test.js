const test = require('node:test')
const assert = require('node:assert/strict')
const S = require('../lyrics-syllables')
const V = require('../lyrics-view')

const en = S.hyphenatorFor('en')
const split = (w, h = en) => (S.splitWord(w, h) || [w]).join('·')

test('hyphenation: multi-syllable words split, one-syllable and short words stay whole, punctuation kept', () => {
  assert.equal(split('critics'), 'crit·ics')
  assert.equal(split('Euphoria'), 'Eu·pho·ria')
  assert.equal(split('beautiful,'), 'beau·ti·ful,')
  assert.equal(split('(remember)'), '(re·mem·ber)')
  for (const w of ['called', 'trash', 'love', 'I', 'oh', "don't"]) assert.equal(split(w), w)
})

test('languages: tags map to patterns; en-US by default; no patterns or non-Latin script -> whole word', () => {
  assert.equal(S.patternFor('en-US'), 'en-us')
  assert.equal(S.patternFor('en-GB'), 'en-gb')
  assert.equal(S.patternFor('de-DE'), 'de-1996')
  assert.equal(S.patternFor(''), 'en-us')
  assert.equal(S.patternFor('ja'), null)
  assert.equal(S.hyphenatorFor('ja'), null)
  assert.equal(split('Schmetterling', S.hyphenatorFor('de')), 'Schmet·ter·ling')
  assert.equal(S.splitWord('любовь', en), null)
  assert.equal(S.splitWord('東京', en), null)
})

test('spread: monotonic, covers [t, end] exactly, vowel-heavy parts get more time', () => {
  const syl = S.spread(10, 11.2, ['Eu', 'pho', 'ria'])
  assert.equal(syl[0].t, 10)
  assert.equal(syl[syl.length - 1].end, 11.2)
  for (let i = 0; i < syl.length; i++) {
    assert.ok(syl[i].end > syl[i].t)
    if (i) assert.equal(syl[i].t, syl[i - 1].end)
  }
  assert.equal(syl.map((y) => y.text).join(''), 'Euphoria')
  const [a, b] = S.spread(0, 1, ['aaa', 'b'])
  assert.ok(a.end - a.t > b.end - b.t)
})

test('withSyllables: Apple syl wins; untimed and unsplit words unchanged; same array when nothing splits', () => {
  const apple = { t: 1, end: 2, text: 'Beautiful', syl: [{ t: 1, end: 1.6, text: 'Beauti' }, { t: 1.6, end: 2, text: 'ful' }] }
  const words = [apple, { t: 2, end: 3, text: 'critics' }, { t: 3, end: 3.4, text: 'love' }, { t: 4, end: 4, text: 'remember' }]
  const out = S.withSyllables(words, en)
  assert.equal(out[0], apple)
  assert.deepEqual(out[1].syl.map((y) => y.text), ['crit', 'ics'])
  assert.equal(out[1].t, 2)
  assert.equal(out[1].end, 3)
  assert.equal(out[1].text, 'critics')
  assert.equal(out[2], words[2])
  assert.equal(out[3], words[3])                  // zero-length: no split
  const plain = [{ t: 1, end: 2, text: 'love' }]
  assert.equal(S.withSyllables(plain, en), plain)
  assert.equal(S.withSyllables(words, null), words)
})

test('prepare: estimated words get estimated syllables (bg too); a language without patterns leaves words whole', () => {
  const lines = [{ t: 1, end: 4, text: 'Remember the beautiful critics' }]
  const p = V.prepare({ lines, estimate: true, lang: 'en' })
  const byText = Object.fromEntries(p.lines[0].words.map((w) => [w.text, w.syl ? w.syl.map((y) => y.text).join('·') : '']))
  assert.deepEqual(byText, { Remember: 'Re·mem·ber', the: '', beautiful: 'beau·ti·ful', critics: 'crit·ics' })
  const ja = V.prepare({ lines, estimate: true, lang: 'ja' })
  assert.ok(ja.lines[0].words.every((w) => !w.syl))
  const bgLine = [{ t: 1, end: 3, text: 'yeah', words: [{ t: 1, end: 2, text: 'yeah' }], bg: [{ t: 2, end: 3, text: '(remember)' }] }]
  assert.deepEqual(V.prepare({ lines: bgLine }).lines[0].bg[0].syl.map((y) => y.text), ['(re', 'mem', 'ber)'])
  // the view's syllable state follows the estimated parts
  const w = p.lines[0].words.find((x) => x.text === 'beautiful')
  assert.equal(V.wordState([w], w.syl[1].t + 0.001).syl, 1)
})
