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

test('hyphens inside a word are syllable boundaries (0.15.35): brackets stay on the outer pieces', () => {
  assert.deepEqual(S.splitWord('(Hey-hey-ay-ay-ay)', en), ['(Hey-', 'hey-', 'ay-', 'ay-', 'ay)'])
  assert.deepEqual(S.splitWord('Hey-hey-ay-ay-ay-ay', en), ['Hey-', 'hey-', 'ay-', 'ay-', 'ay-', 'ay'])
  // each piece is then hyphenated as usual
  assert.equal(split('self-control'), 'self-·con·trol')
  // a hyphen not between two letters is not a boundary
  for (const w of ['-ay', 'ay-', 'a--b', 'hey']) assert.equal(split(w), w)
  assert.equal(S.splitWord('(Hey-hey)', null), null)
})

test('a hyphen run is still ONE word: same t/end/text, its syllables pop in turn (estimated and timed)', () => {
  const words = [{ t: 10, end: 12.5, text: '(Hey-hey-ay-ay-ay)' }]
  const out = S.withSyllables(words, en)
  assert.equal(out.length, 1)
  assert.equal(out[0].t, 10)
  assert.equal(out[0].end, 12.5)
  assert.equal(out[0].text, '(Hey-hey-ay-ay-ay)')
  assert.equal(out[0].syl.map((y) => y.text).join(''), '(Hey-hey-ay-ay-ay)')
  assert.equal(out[0].syl[0].t, 10)
  assert.equal(out[0].syl[4].end, 12.5)
  // the view: the word is lit and its syllables take turns
  const seen = []
  for (let t = 10.01; t < 12.5; t += 0.05) {
    const st = V.wordState(out, t)
    assert.equal(st.now, 0)
    if (seen[seen.length - 1] !== st.syl) seen.push(st.syl)
  }
  assert.deepEqual(seen, [0, 1, 2, 3, 4])
  // a line-only "(Hey-hey-ay-ay-ay)" line, estimated: one word, five syllables
  const p = V.prepare({ lines: [{ t: 37.5, end: 40.4, text: '(Hey-hey-ay-ay-ay)' }, { t: 40.5, text: 'next' }], estimate: true, lang: 'en' })
  assert.equal(p.lines[0].words.length, 1)
  assert.equal(p.lines[0].words[0].syl.length, 5)
})

test('Romanian and Indonesian ship no patterns (no licence to ship them): their words stay whole', () => {
  for (const lang of ['ro', 'ro-RO', 'id', 'id-ID']) {
    assert.equal(S.patternFor(lang), null, lang)
    assert.equal(S.hyphenatorFor(lang), null, lang)
  }
  const line = S.lineWithSyllables({ t: 0, end: 2, text: 'Placeholder', words: [{ t: 0, end: 2, text: 'Placeholder' }] }, S.hyphenatorFor('ro'))
  assert.ok(!line.words[0].syl, 'no estimated syllables')
  // every language the map names has a pattern file that ships, and its notice ships too
  const pkg = require('../package.json')
  const shipped = /!\(([^)]+)\)/.exec(pkg.build.files.find((f) => f.includes('patterns/!(')))[1].split('|')
  assert.ok(!shipped.includes('ro') && !shipped.includes('id'))
  for (const lang of ['en', 'de', 'fr', 'es', 'it', 'pt', 'nl', 'sv', 'da', 'nb', 'fi', 'pl', 'cs', 'sk', 'hu', 'tr', 'ca', 'hr', 'sl', 'en-gb']) assert.ok(shipped.includes(S.patternFor(lang)), lang)
  assert.ok(pkg.build.files.includes('licenses/hyphenation-NOTICES.txt'))
  const notices = require('fs').readFileSync(require('path').join(__dirname, '..', 'licenses', 'hyphenation-NOTICES.txt'), 'utf8')
  for (const code of shipped) assert.ok(notices.includes(`(${code}): hyph-${code}.tex`), code + ' notice')
  assert.ok(!/\((ro|id)\): hyph-/.test(notices))
})
