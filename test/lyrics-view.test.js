const test = require('node:test')
const assert = require('node:assert/strict')
const V = require('../lyrics-view')
const T = require('../lyrics-timing')
const noSyl = (lines) => lines.map((l) => Object.assign({}, l, { words: l.words.map(({ syl, ...w }) => w) }))

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
  assert.equal(p.duet.duet, false)
  assert.deepEqual(p.duet.voice, ['', '', ''])
  assert.deepEqual(p.gaps.map((g) => g.index), [0, 2])   // intro (5 s) and the break before line 3
})

test('prepare: no estimate keeps line-only lyrics; empty and missing data are safe', () => {
  const p = V.prepare({ lines: lrc, estimate: false })
  assert.equal(p.lines, lrc)
  assert.equal(p.wordTimed, false)
  assert.deepEqual(V.prepare({}).lines, [])
  assert.deepEqual(V.prepare(null).lines, [])
})

test('prepare: same lines as the lyrics window got before (estimateWords result; syllables added only)', () => {
  assert.deepEqual(noSyl(V.prepare({ lines: lrc, estimate: true }).lines), T.estimateWords(lrc))
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

test('prepare/learnFrom: repeats of an aligned line take its timing; other estimated lines its pace', () => {
  const raw = [
    { t: 10, text: 'we sing this chorus loud' }, { t: 14, text: 'and then a verse goes by' },
    { t: 18, text: 'some more words in here' }, { t: 30, text: 'we sing this chorus loud' }, { t: 40, text: 'end' }
  ]
  const est = T.estimateWords(raw)
  const sung = (l, step) => {
    const o = Object.assign({}, l, { words: l.words.map((w, k) => ({ t: l.t + 0.1 + k * step, end: l.t + 0.1 + k * step + step, text: w.text })), aligned: true })
    delete o.estimated
    return o
  }
  const lines = [sung(est[0], 0.3), sung(est[1], 0.3), est[2], est[3], est[4]]
  const out = noSyl(V.prepare({ lines }).lines)
  assert.equal(out[3].repeat, 'aligned')
  assert.ok(Math.abs(out[3].words[2].t - (30 + 0.1 + 0.6)) < 1e-9)
  assert.notDeepEqual(out[2].words, est[2].words)          // re-paced
  assert.equal(out[2].estimated, true)
  // a refine message can't replace a repeat of an aligned line (aligned beats refined)
  const msg = { key: 'k', lineIndex: 3, words: out[3].words.map((w) => ({ t: w.t + 1, end: w.end + 1, text: w.text })) }
  assert.equal(V.refinedLine(out, msg, 'k'), null)
  // but a real alignment of that line replaces it
  const got = V.alignedLines(out, { key: 'k', lines: { 3: { text: raw[3].text, words: msg.words } } }, 'k')
  assert.equal(got.lines[3].aligned, true)
  assert.equal(got.lines[3].repeat, undefined)
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

test('timingNote: the gaming guard\'s state follows the timing words (0.15.38)', () => {
  const est = V.prepare({ lines: lrc, estimate: true }).lines
  assert.equal(V.timingNote(est, false, false, 'Precise timing paused while you play'), 'Word timing estimated · Precise timing paused while you play')
  assert.equal(V.timingNote(est, false, false, ''), 'Word timing estimated')
})

test('settings: Pause word timing while gaming is on by default', () => {
  assert.equal(require('../settings-store').defaults().alignGamingPause, true)
})

test('wordState: the whole word is current, the syllable being sung is marked; words without syl as before', () => {
  const words = [
    { t: 1, end: 2.4, text: 'Karaoke', syl: [{ t: 1, end: 1.3, text: 'Ka' }, { t: 1.3, end: 1.6, text: 'ra' }, { t: 1.6, end: 2, text: 'o' }, { t: 2.1, end: 2.4, text: 'ke' }] },
    { t: 2.5, end: 3, text: 'night' }
  ]
  assert.deepEqual(V.wordState(words, 0.5), { k: 0, now: -1, syl: -1, hold: false })
  assert.deepEqual(V.wordState(words, 1.1), { k: 1, now: 0, syl: 0, hold: false })
  assert.deepEqual(V.wordState(words, 1.45), { k: 1, now: 0, syl: 1, hold: false })
  assert.deepEqual(V.wordState(words, 1.8), { k: 1, now: 0, syl: 2, hold: false })
  assert.deepEqual(V.wordState(words, 2.05), { k: 1, now: 0, syl: -1, hold: false })   // between two syllables: none pops
  assert.deepEqual(V.wordState(words, 2.2), { k: 1, now: 0, syl: 3, hold: false })
  assert.deepEqual(V.wordState(words, 2.7), { k: 2, now: 1, syl: -1, hold: false })    // no syl: the word pops as a whole
  assert.deepEqual(V.wordState(words, 3.5), { k: 2, now: -1, syl: -1, hold: false })
  const T = require('../lyrics-timing')
  const plain = words.map(({ syl, ...w }) => w)
  for (const t of [0.5, 1.45, 2.7, 3.5]) {
    const p = T.wordPos(plain, t)
    assert.deepEqual(V.wordState(plain, t), { k: p.k, now: p.now, syl: -1, hold: false })
  }
})

test('nextChange wakes at syllable boundaries inside a word', () => {
  const T = require('../lyrics-timing')
  const lines = [{ t: 1, end: 3, text: 'Karaoke', words: [{ t: 1, end: 2.4, text: 'Karaoke', syl: [{ t: 1, end: 1.3, text: 'Ka' }, { t: 1.3, end: 2.4, text: 'raoke' }] }] }]
  assert.ok(Math.abs(T.nextChange(lines, 1.1) - 0.2) < 1e-9)
  assert.ok(Math.abs(T.nextChange(lines.map((l) => ({ ...l, words: l.words.map(({ syl, ...w }) => w) })), 1.1) - 1.3) < 1e-9)
})

test('writtenBy: the songwriter credit lists Apple\'s names as given; nothing without names', () => {
  assert.equal(V.writtenBy(['Rob Thomas']), 'Written by Rob Thomas')
  assert.equal(V.writtenBy(['David Austin', 'George Michael']), 'Written by David Austin & George Michael')
  assert.equal(V.writtenBy(['Chappell Roan', 'Daniel Nigro', 'Justin Tranter']), 'Written by Chappell Roan, Daniel Nigro & Justin Tranter')
  assert.equal(V.writtenBy(['Bill Berry, Peter Buck, Mike Mills & Michael Stipe']), 'Written by Bill Berry, Peter Buck, Mike Mills & Michael Stipe')   // the catalog's composerName, one string
  assert.equal(V.writtenBy([]), '')
  assert.equal(V.writtenBy(undefined), '')
  assert.equal(V.writtenBy(['', '  ']), '')
})

// Backing vocals under the words they answer (mock-up B, after 0.15.40): which main word, and the row's paddings
const ws = (t0, text, step = 0.5) => text.split(' ').map((w, i) => ({ t: t0 + i * step, end: t0 + i * step + step * 0.9, text: w }))
// a measured line: words laid out left to right, 10 px per letter plus a 6 px space, one row unless a top is given
const laid = (text, tops) => { let x = 0; return text.split(' ').map((w, i) => { const r = { left: x, right: x + w.length * 10, top: tops ? tops[i] : 0 }; x = r.right + 6; return r }) }

test('backingAnchor: overlap — under the main word being sung when the backing comes in', () => {
  const main = ws(10, 'I keep on running down the road')   // words at 10, 10.5, 11, ...
  assert.deepEqual(V.backingAnchor(main, ws(11.6, '(ooh yeah)')), { index: 3, after: false })      // "running" (11.5)
  assert.deepEqual(V.backingAnchor(main, ws(11.47, '(ooh yeah)')), { index: 3, after: false })     // just before it: still "running"
  assert.deepEqual(V.backingAnchor(main, ws(10, '(ooh)')), { index: 0, after: false })
})

test('backingAnchor: echo — under the word it repeats, even when it comes in after the line', () => {
  const main = ws(10, 'Took a couple months')
  assert.deepEqual(V.backingAnchor(main, ws(12.2, '(Took a couple months)')), { index: 0, after: false })
  // a partial echo of the line's end
  assert.deepEqual(V.backingAnchor(ws(20, 'I want to hold your hand'), ws(23.1, '(hold your hand)')), { index: 3, after: false })
  // the text repeats in two places: the one closest in time
  assert.deepEqual(V.backingAnchor(ws(0, 'oh my love oh my love'), ws(1.6, '(oh my)')), { index: 3, after: false })
  // one shared word isn't an echo of a longer backing line ("the" here): timing decides
  assert.deepEqual(V.backingAnchor(ws(0, 'down the road we go'), ws(1.1, '(the night is young)')), { index: 2, after: false })
})

test('backingAnchor: after the line — where its last word ends', () => {
  assert.deepEqual(V.backingAnchor(ws(10, 'Hold me close'), ws(12, '(so close now)')), { index: 2, after: true })
})

test('backingAnchor: none — before the line, no main words, no backing, no timing', () => {
  assert.equal(V.backingAnchor(ws(10, 'Hold me close'), ws(9, '(ah)')), null)
  assert.equal(V.backingAnchor([], ws(9, '(ah)')), null)
  assert.equal(V.backingAnchor(ws(10, 'Hold me close'), []), null)
  assert.equal(V.backingAnchor(ws(10, 'Hold me close'), [{ text: '(ah)' }]), null)
  assert.equal(V.backingAnchor(null, null), null)
})

test('backingOffset: left-aligned — the first word under the anchor word, the lead hanging before it', () => {
  const words = laid('I keep on running down the road')   // "running" at 88..158
  assert.deepEqual(V.backingOffset({ align: 'left', width: 400, words, anchor: { index: 3, after: false }, lead: 2, bgWidth: 90 }), { start: 86, end: 0 })
  // after the line: from the last word's end
  const w2 = laid('Hold me close')   // "close" ends at 122
  assert.deepEqual(V.backingOffset({ align: 'left', width: 400, words: w2, anchor: { index: 2, after: true }, lead: 0, bgWidth: 100 }), { start: 122, end: 0 })
  // would run past the line's end: moves back just enough to fit (with the 1 px spare against rounding)
  assert.deepEqual(V.backingOffset({ align: 'left', width: 200, words: w2, anchor: { index: 2, after: true }, lead: 0, bgWidth: 150 }), { start: 49, end: 0 })
})

test('backingOffset: none — no anchor, or the first word: the line\'s own alignment, as before', () => {
  const words = laid('Hold me close')
  assert.deepEqual(V.backingOffset({ align: 'left', width: 400, words, anchor: null, lead: 2, bgWidth: 90 }), { start: 0, end: 0 })
  assert.deepEqual(V.backingOffset({ align: 'right', width: 400, words, anchor: null, lead: 2, bgWidth: 90 }), { start: 0, end: 0 })
  assert.deepEqual(V.backingOffset({ align: 'left', width: 400, words, anchor: { index: 0, after: false }, lead: 2, bgWidth: 90 }), { start: 0, end: 0 })
  assert.deepEqual(V.backingOffset(null), { start: 0, end: 0 })
})

test('backingOffset: the ↳ always inside the text column — an anchored row and one that starts at the line\'s start align the same way (Honey, Honey)', () => {
  // "(Look like a movie star)" comes in under a later word; "(But I like just who you are)" has no anchor (or the
  // first word, or a wrapped main line): before 0.15.42 the second started at 0 with its ↳ hanging out to the left
  const words = laid('Honey honey how he thrills me')
  const arrow = 14
  const anchored = V.backingOffset({ align: 'left', width: 600, words, anchor: { index: 3, after: false }, lead: 0, bgWidth: 160, arrow })
  assert.equal(anchored.start, words[3].left)
  for (const anchor of [null, { index: 0, after: false }]) {
    assert.deepEqual(V.backingOffset({ align: 'left', width: 600, words, anchor, lead: 0, bgWidth: 220, arrow }), { start: arrow, end: 0 }, JSON.stringify(anchor))
  }
  // a wrapped main line (the anchor on its first row) and a backing row too long for one row: the same indent
  const wrapped = laid('Honey honey how he').concat(laid('thrills me').map((w) => Object.assign(w, { top: 40 })))
  assert.deepEqual(V.backingOffset({ align: 'left', width: 300, words: wrapped, anchor: { index: 2, after: false }, lead: 0, bgWidth: 120, arrow }), { start: arrow, end: 0 })
  assert.deepEqual(V.backingOffset({ align: 'left', width: 200, words, anchor: { index: 3, after: false }, lead: 0, bgWidth: 400, arrow }), { start: arrow, end: 0 })
  // every left-aligned case: the ↳ (start - arrow) never left of the line's text start
  for (const o of [anchored, V.backingOffset({ align: 'left', width: 600, words, anchor: null, lead: 0, bgWidth: 220, arrow })]) assert.ok(o.start - arrow >= 0)
  // right-aligned and centred rows keep their own placement
  assert.deepEqual(V.backingOffset({ align: 'right', width: 400, words, anchor: null, lead: 2, bgWidth: 90, arrow }), { start: 0, end: 0 })
  // the page reads the arrow's width from the ↳ itself (lyrics-view.css .bgv::before)
  const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'lyrics-view.js'), 'utf8')
  assert.match(src, /arrow: arrowOf\(row\)/)
})

test('backingOffset: wrap — a wrapped line or a backing row too long for one row keeps the line\'s alignment', () => {
  // narrow window: "running" on the first of two rows; the backing sits under the last row
  // (the second row's words from the row's start: "down" 0..40, "the" 46..76, "road" 82..122)
  const words = laid('I keep on running').concat(laid('down the road').map((w) => Object.assign(w, { top: 27 })))
  assert.deepEqual(V.backingOffset({ align: 'left', width: 140, words, anchor: { index: 3, after: false }, lead: 2, bgWidth: 90 }), { start: 0, end: 0 })
  // the anchor word on the last row: placed as usual, from that row's start ("the" at 46)
  assert.deepEqual(V.backingOffset({ align: 'left', width: 300, words, anchor: { index: 5, after: false }, lead: 2, bgWidth: 90 }), { start: 44, end: 0 })
  // a backing row wider than the line wraps as before
  assert.deepEqual(V.backingOffset({ align: 'left', width: 140, words: laid('Hold me close'), anchor: { index: 2, after: false }, lead: 2, bgWidth: 220 }), { start: 0, end: 0 })
})

test('backingOffset: right-aligned (duet singer 2) — mirrored: padded from the right so the first word still lands under the anchor', () => {
  // a right-aligned line in a 400 px box: its words end at 400
  const words = laid('I want to hold your hand').map((w) => ({ left: w.left + 180, right: w.right + 180, top: 0 }))   // 220 wide, ends at 400
  const hold = words[3]   // 268..308
  const o = V.backingOffset({ align: 'right', width: 400, words, anchor: { index: 3, after: false }, lead: 2, bgWidth: 60 })
  assert.deepEqual(o, { start: 0, end: 74 })
  // the row is right-aligned in (400 - end): its first word's box starts at 400 - 74 - 60 + lead = hold.left
  assert.equal(400 - o.end - 60 + 2, hold.left)
  // a long echo that would pass the right edge hugs it (1 px spare)
  assert.deepEqual(V.backingOffset({ align: 'right', width: 400, words, anchor: { index: 3, after: false }, lead: 2, bgWidth: 150 }), { start: 0, end: 1 })
})

test('backingOffset: centred (both singers, the stage) — padded on the side that moves it', () => {
  const words = laid('Both of them together now').map((w) => ({ left: w.left + 100, right: w.right + 100, top: 0 }))   // "together" at 218..298
  const o = V.backingOffset({ align: 'center', width: 400, words, anchor: { index: 3, after: false }, lead: 0, bgWidth: 100 })
  // centred in [start, 400 - end]: its start = start + (400 - start - end - 100) / 2 = 166
  assert.equal(o.start + (400 - o.start - o.end - 100) / 2, 218)
  const left = V.backingOffset({ align: 'center', width: 400, words, anchor: { index: 0, after: false }, lead: 0, bgWidth: 100 })
  assert.equal(left.start + (400 - left.start - left.end - 100) / 2, 100)
})
