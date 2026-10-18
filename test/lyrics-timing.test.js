const test = require('node:test')
const assert = require('node:assert/strict')
const T = require('../lyrics-timing')

const ttmlLines = [
  { t: 6, end: 8, text: 'a' },
  { t: 8.5, end: 10, text: 'b' },
  { t: 15, end: 17, text: 'c' },     // 5 s gap after b
  { t: 18, end: 19, text: 'd' }
]

test('findInterludes: intro and TTML gaps >= 4 s by line end', () => {
  assert.deepEqual(T.findInterludes(ttmlLines), [
    { index: 0, start: 0, end: 6 },
    { index: 2, start: 10, end: 15 }
  ])
})

test('findInterludes: overlapping duet lines and background vocals extend the singing', () => {
  const lines = [
    { t: 1, end: 3, text: 'x', bg: [{ t: 2, end: 9, text: '(long)' }] },
    { t: 2, end: 4, text: 'y' },
    { t: 12, end: 13, text: 'z' }
  ]
  assert.deepEqual(T.findInterludes(lines), [])  // bg until 9, next at 12: 3 s
})

test('findInterludes: LRC uses empty-stamp ends, else a 3 s guess', () => {
  const lrc = [
    { t: 2, text: 'a' },               // intro 2 s: no dots
    { t: 5, text: 'b' },               // guess end 8, next 12 -> 4 s gap
    { t: 12, end: 13, text: 'c' },     // empty stamp at 13, next 18 -> 5 s
    { t: 18, text: 'd' },
    { t: 23, text: 'e' }               // 18+3=21, 23: 2 s -> none
  ]
  assert.deepEqual(T.findInterludes(lrc), [
    { index: 2, start: 8, end: 12 },
    { index: 3, start: 13, end: 18 }
  ])
})

test('findInterludes: unsynced lyrics have none', () => {
  assert.deepEqual(T.findInterludes([{ t: null, text: 'a' }]), [])
  assert.deepEqual(T.findInterludes([]), [])
})

test('interludeAt / interludeProgress: dots fill one by one, then fade before the line', () => {
  const g = { index: 2, start: 10, end: 15 }
  assert.equal(T.interludeAt([g], 9.9), -1)
  assert.equal(T.interludeAt([g], 10), 0)
  assert.equal(T.interludeAt([g], 14.85), -1)   // the next line lights up 0.2 s early
  assert.deepEqual(T.interludeProgress(g, 10).fills, [0, 0, 0])
  const mid = T.interludeProgress(g, 12.1)        // span 4.2 s, p 0.5 -> 1.5 dots
  assert.deepEqual(mid.fills.map((f) => +f.toFixed(2)), [1, 0.5, 0])
  assert.equal(mid.exit, 1)
  const late = T.interludeProgress(g, 14.5)
  assert.deepEqual(late.fills, [1, 1, 1])
  assert.ok(late.exit > 0 && late.exit < 1)
})

test('wordPos: sung, current and gaps between words', () => {
  const words = [{ t: 1, end: 1.5 }, { t: 1.5, end: 2 }, { t: 2.5, end: 3 }]
  assert.deepEqual(T.wordPos(words, 0.5), { k: 0, now: -1 })
  assert.deepEqual(T.wordPos(words, 1.2), { k: 1, now: 0 })
  assert.deepEqual(T.wordPos(words, 1.5), { k: 2, now: 1 })
  assert.deepEqual(T.wordPos(words, 2.2), { k: 2, now: -1 })
  assert.deepEqual(T.wordPos(words, 9), { k: 3, now: -1 })
})

test('liveLines: latest line as before plus overlapping earlier lines', () => {
  const lines = [{ t: 1, end: 5, text: 'v1' }, { t: 3, end: 4, text: 'v2' }, { t: 6, end: 7, text: 'x' }]
  assert.deepEqual(T.liveLines(lines, 0), { latest: -1, live: [] })
  assert.deepEqual(T.liveLines(lines, 3.5), { latest: 1, live: [0, 1] })
  assert.deepEqual(T.liveLines(lines, 4.5), { latest: 1, live: [0, 1] })   // latest stays lit as before
  assert.deepEqual(T.liveLines(lines, 6), { latest: 2, live: [2] })
  assert.equal(T.latestLine(lines, 0.8), 0)                                  // 0.2 s lead
})

test('lineSides: one singer unchanged, duet left/right, together centered', () => {
  assert.deepEqual(T.lineSides([{ agent: 'v1' }, { agent: 'v1' }, {}]), ['', '', ''])
  assert.deepEqual(T.lineSides([{ agent: 'v2' }, { agent: 'v1' }, { agent: 'group' }, { agent: 'v10' }]), ['right', 'left', 'center', 'left'])
})

test('hasWordTiming', () => {
  assert.equal(T.hasWordTiming([{ t: 1, text: 'a' }]), false)
  assert.equal(T.hasWordTiming([{ t: 1, text: 'a', words: [{ t: 1, end: 2, text: 'a' }] }]), true)
  assert.equal(T.hasWordTiming([{ t: 1, text: '', bg: [{ t: 1, end: 2, text: 'a' }] }]), true)
})

test('clock: counts on between pushes and keeps a consistent fractional time', () => {
  let c = T.syncClock(null, 10.0, true, 0)
  c = T.syncClock(c, 10.5, true, 500)
  assert.equal(T.clockTime(c, 750), 10.75)
  c = T.syncClock(c, 11.1, true, 1000)            // 0.1 s off: ease halfway toward it
  assert.ok(Math.abs(T.clockTime(c, 1000) - 11.05) < 1e-9)
  c = T.syncClock(c, 40.2, true, 1500)            // seek elsewhere: snap
  assert.equal(T.clockTime(c, 1500), 40.2)
})

test('clock: whole-second times are kept while inside [v, v+1)', () => {
  let c = T.syncClock(null, 10, true, 0)
  c = T.syncClock(c, 10, true, 500)               // still 10: one repeat is normal
  assert.equal(c.playing, true)
  assert.equal(T.clockTime(c, 500), 10.5)
  c = T.syncClock(c, 11, true, 1000)
  assert.equal(T.clockTime(c, 1000), 11)
  c = T.syncClock(c, 11, true, 1500)
  assert.equal(T.clockTime(c, 1600), 11.6)
  c = T.syncClock(c, 13, true, 2000)              // ahead of the clock (12): snap
  assert.equal(T.clockTime(c, 2000), 13)
})

test('clock: pause by isPlaying or by a time that stops moving', () => {
  let c = T.syncClock(null, 10.25, true, 0)
  c = T.syncClock(c, 10.75, false, 500)
  assert.equal(c.playing, false)
  assert.equal(T.clockTime(c, 5000), 10.75)
  // no isPlaying (older main): unchanged across two pushes = paused
  c = T.syncClock(null, 20.25, undefined, 0)
  c = T.syncClock(c, 20.25, undefined, 500)
  assert.equal(c.playing, true)
  c = T.syncClock(c, 20.25, undefined, 1000)
  assert.equal(c.playing, false)
  c = T.syncClock(c, 20.75, undefined, 1500)      // resumes
  assert.equal(c.playing, true)
  assert.equal(T.clockTime(c, 1500), 20.75)
  // whole seconds need one more repeat
  c = T.syncClock(null, 5, true, 0)
  c = T.syncClock(c, 5, true, 500)
  c = T.syncClock(c, 5, true, 1000)
  assert.equal(c.playing, true)
  c = T.syncClock(c, 5, true, 1500)
  assert.equal(c.playing, false)
})

test('clock: seek from the window wins over stale pushes for a moment', () => {
  let c = T.syncClock(null, 10.25, true, 0)
  c = T.seekClock(c, 60, 100)
  c = T.syncClock(c, 10.75, true, 500)            // main hasn't seen the seek yet
  assert.equal(T.clockTime(c, 500), 60.4)
  c = T.syncClock(c, 60.9, true, 1000)
  assert.ok(Math.abs(T.clockTime(c, 1000) - 60.9) < 0.25)
  c = T.syncClock(c, 5.25, true, 2000)            // after the hold: a real seek snaps
  assert.equal(T.clockTime(c, 2000), 5.25)
})

test('nextChange: next word start/end or line start, with leads', () => {
  const lines = [
    { t: 1, end: 2, text: 'a b', words: [{ t: 1, end: 1.5, text: 'a' }, { t: 1.5, end: 2, text: 'b' }] },
    { t: 5, end: 6, text: 'c', words: [{ t: 5, end: 6, text: 'c' }] }
  ]
  assert.ok(Math.abs(T.nextChange(lines, 1.2) - 0.3) < 1e-9)
  assert.ok(Math.abs(T.nextChange(lines, 2.5) - 2.3) < 1e-9)          // line 2 lights up at 4.8
  assert.ok(Math.abs(T.nextChange(lines, 1.2, 0.05) - 0.25) < 1e-9)
  assert.equal(T.nextChange(lines, 7), Infinity)
})

test('estimateWords: a real line end is spread over (0.9 of it minus a 0.2 s tail), by weight', () => {
  const lines = [{ t: 10, end: 13, text: 'Hold on forever' }, { t: 20, text: 'Go' }]
  const out = T.estimateWords(lines)
  const w = out[0].words
  assert.equal(out[0].estimated, true)
  assert.deepEqual(w.map((x) => x.text), ['Hold', 'on', 'forever'])
  assert.equal(w[0].t, 10)
  // the words fill 0.9 of it minus the tail; 0.15.34: the last one then holds to the end minus the tail
  assert.ok(Math.abs(w[2].holdFrom - (10 + 3 * 0.9 - 0.2)) < 1e-9)
  assert.ok(Math.abs(w[2].end - (13 - 0.2)) < 1e-9)
  for (let i = 1; i < w.length; i++) assert.equal(w[i].t, w[i - 1].end)
  assert.ok(w[2].end - w[2].t > w[1].end - w[1].t) // longer word, longer time
})

test('estimateWords: a line that runs on to the next start is sung at the pace, the rest is tail', () => {
  // Apple's line end = next start (no real end) and LRC (no end): same rule
  const text = 'and I am never ever gonna get old'
  const weight = text.split(' ').reduce((a, x) => a + T.wordWeight(x), 0)
  for (const first of [{ t: 10, end: 15, text }, { t: 10, text }]) {
    const out = T.estimateWords([first, { t: 15, text: 'next line' }], { pace: 0.25 })
    const w = out[0].words
    assert.ok(Math.abs(w[w.length - 2].end - (10 + 0.25 * (weight - T.wordWeight('old')))) < 1e-9, 'paced, not stretched to 15')
    // 0.15.34: the last word holds on (a held note) for up to 3 s, until 0.1 s before the next line
    assert.ok(Math.abs(w[w.length - 1].end - Math.min(w[w.length - 1].t + T.LAST_HOLD, 15 - T.HOLD_GAP)) < 1e-9, 'held: ' + w[w.length - 1].end)
    assert.ok(w[w.length - 1].holdFrom < w[w.length - 1].end, 'where the hold starts is kept (for the syllables)')
    assert.equal(out[0].pace, 0.25)
  }
  // a line too long for its time is squeezed into 0.9 of it
  const fast = T.estimateWords([{ t: 0, text }, { t: 2, text: 'x' }], { pace: 0.25 })[0].words
  assert.ok(Math.abs(fast[fast.length - 1].end - 1.8) < 1e-9)
})

test('estimateWords: no end and no next line -> paced, never the old 0.6 s per word', () => {
  const out = T.estimateWords([{ t: 0, text: 'a b' }, { t: 60, text: 'c' }])
  assert.ok(out[0].words[1].t < 1, 'paced: the words start close together')
  assert.ok(out[0].words[1].holdFrom < 2, 'sung at the pace; the rest is a hold')
  assert.ok(out[1].words[0].end - out[1].words[0].t <= T.LAST_HOLD + 1e-9)
  assert.ok(out[0].words[1].end <= out[0].words[1].t + T.LAST_HOLD + 1e-9, 'a 60 s gap never means a 60 s hold')
})

test('estimateWords (0.15.34): Apple\'s end after the next line\'s start -> the last word holds over the next line', () => {
  const out = T.estimateWords([{ t: 74.7, end: 81.47, text: 'Come take me home' }, { t: 81.08, end: 84, text: 'Oh I need you now' }], { pace: 0.25 })
  const home = out[0].words[3]
  assert.ok(Math.abs(home.end - (81.47 - 0.2)) < 1e-9, String(home.end))
  assert.ok(home.end > 81.08, 'still lit when the next line starts')
  // a real end before the next line is filled as before (no extra hold)
  const tight = T.estimateWords([{ t: 10, end: 13, text: 'Hold on forever' }, { t: 20, text: 'Go' }])[0].words
  assert.ok(Math.abs(tight[2].end - 12.8) < 1e-9, 'a real end: held to it minus the tail, not past it')
})

test('songPace: the lines sung back to back set it, blended with the default; few lines -> default', () => {
  assert.equal(T.songPace([{ t: 0, text: 'a b c' }]), T.PACE)
  const tight = []
  for (let i = 0; i < 10; i++) tight.push({ t: i * 1.5, text: 'one two three four five' })   // 0.22 s per weight unit
  const p = T.songPace(tight)
  assert.ok(p < T.PACE && p > 0.15, String(p))
  const loose = tight.map((l, i) => ({ t: i * 20, text: l.text }))
  assert.ok(T.songPace(loose) > T.PACE)
  assert.ok(T.songPace(loose) <= 0.6)
})

test('learnedPace: from aligned/refined lines of 3+ words only; repeats and estimates do not count', () => {
  const sung = (t, step, extra) => Object.assign({ t, text: 'a b c d', words: ['a', 'b', 'c', 'd'].map((x, k) => ({ t: t + k * step, end: t + k * step + step, text: x })) }, extra)
  assert.equal(T.learnedPace([sung(0, 0.3, { aligned: true })]), null)
  const p = T.learnedPace([sung(0, 0.27, { aligned: true }), sung(5, 0.27, { refined: true, estimated: true }), sung(9, 0.9, { estimated: true }), sung(12, 0.9, { aligned: true, repeat: 'aligned' })])
  assert.ok(Math.abs(p - 0.27 / T.wordWeight('a')) < 1e-9)
})

test('repace: plain estimated lines take the learned pace; aligned, refined and repeats stay', () => {
  const raw = [{ t: 0, text: 'one two three four' }, { t: 5, text: 'five six seven eight' }, { t: 10, text: 'nine ten eleven twelve' }, { t: 15, text: 'end' }]
  const est = T.estimateWords(raw, { pace: 0.4 })
  assert.equal(T.repace(est), est)                  // nothing learned yet
  const fast = (l) => {
    const o = Object.assign({}, l, { words: l.words.map((w, k) => ({ t: l.t + k * 0.2, end: l.t + k * 0.2 + 0.2, text: w.text })), aligned: true })
    delete o.estimated
    return o
  }
  const lines = [fast(est[0]), fast(est[1]), est[2], est[3]]
  const out = T.repace(lines)
  assert.equal(out[0], lines[0])
  assert.equal(out[1], lines[1])
  assert.notEqual(out[2], lines[2])
  assert.ok(out[2].words[3].t < lines[2].words[3].t, 'sung faster than estimated')
  assert.equal(out[2].estimated, true)
  assert.equal(T.repace(out), out, 'same pace again: no change')
})

// a line sung `delay` s after its stamp, words 0.25 s apart (aligned or refined)
const late = (t, delay, extra) => Object.assign({ t, text: 'a b c d', words: ['a', 'b', 'c', 'd'].map((x, k) => ({ t: t + delay + k * 0.25, end: t + delay + k * 0.25 + 0.25, text: x })) }, extra)

test('learnedOnset: robust first-word delay of 3+ aligned/refined lines (outliers out, early-biased quantile), clamped, small ones are 0', () => {
  assert.equal(T.learnedOnset([late(0, 0.7, { aligned: true }), late(5, 0.7, { aligned: true })]), null)
  // repeats and plain estimates don't count
  assert.equal(T.learnedOnset([late(0, 0.7, { aligned: true }), late(5, 0.7, { aligned: true }), late(9, 0.7, { estimated: true }), late(12, 0.7, { aligned: true, repeat: 'aligned' })]), null)
  const lines = [late(0, 0.6, { aligned: true }), late(5, 0.8, { refined: true, estimated: true }), late(10, 0.75, { aligned: true }), late(15, 3, { aligned: true })]
  // 3 s is an outlier (dropped); the 0.45 quantile of 0.6, 0.75, 0.8 (a slight early bias)
  assert.ok(Math.abs(T.learnedOnset(lines) - 0.735) < 1e-9, 'one far-off line does not drag it')
  assert.equal(T.learnedOnset([late(0, 4, { aligned: true }), late(5, 4, { aligned: true }), late(10, 4, { aligned: true })]), T.ONSET_MAX)
  assert.equal(T.learnedOnset([late(0, -0.4, { aligned: true }), late(5, -0.3, { aligned: true }), late(10, -0.2, { aligned: true })]), 0)
  assert.equal(T.learnedOnset([late(0, 0.1, { aligned: true }), late(5, 0.1, { aligned: true }), late(10, 0.1, { aligned: true })]), 0, 'under ONSET_MIN: stamps on the voice')
})

test('repace: plain estimated lines start their words at the learned onset; the line, aligned lines and real word timing stay', () => {
  const raw = []
  for (let i = 0; i < 6; i++) raw.push({ t: i * 4, text: 'one two three four' })
  const est = T.estimateWords(raw, { pace: 0.25 })
  const al = (l, delay) => { const o = Object.assign(late(l.t, delay, { aligned: true }), { text: l.text }); return o }
  const lines = [al(est[0], 0.7), al(est[1], 0.75), al(est[2], 0.8), est[3], est[4], est[5]]
  const out = T.repace(lines)
  for (let i = 0; i < 3; i++) assert.equal(out[i], lines[i])
  for (let i = 3; i < 6; i++) {
    assert.equal(out[i].t, raw[i].t, 'the line keeps its stamp (it still lights at t − LINE_LEAD)')
    assert.ok(Math.abs(out[i].words[0].t - (raw[i].t + 0.745)) < 1e-9, 'first word at stamp + onset')
    assert.ok(Math.abs(out[i].onset - 0.745) < 1e-9)
    assert.equal(out[i].words.length, 4)
    if (i < 5) assert.ok(out[i].words[3].end <= raw[i + 1].t - T.HOLD_GAP + 1e-9, 'the hold still lets go before the next line')
  }
  assert.equal(T.repace(out), out, 'same onset and pace again: no change')
  // a short line is shifted at most 40 % of its time
  const short = [al(est[0], 0.7), al(est[1], 0.75), al(est[2], 0.8), T.estimateWords([{ t: 12, text: 'a b' }, { t: 13, text: 'x' }])[0], { t: 13, text: 'x' }]
  const s2 = T.repace(short)
  assert.ok(Math.abs(s2[3].words[0].t - 12.4) < 1e-9)
  // word-timed lyrics (Apple syllable TTML) are never estimated, so never shifted
  const apple = [{ t: 0, text: 'a b', words: [{ t: 0.1, end: 0.5, text: 'a' }, { t: 0.5, end: 1, text: 'b' }] }]
  assert.equal(T.repace(T.estimateWords(apple)), apple)
})

test('reuseRepeats: an identical later line takes the aligned timing, shifted to its own start', () => {
  const raw = [{ t: 10, text: 'Hold me, closer' }, { t: 14, text: 'tiny dancer' }, { t: 30, text: 'hold me closer' }, { t: 31.2, text: 'x' }]
  const est = T.estimateWords(raw)
  const al = Object.assign({}, est[0], { words: [{ t: 10.1, end: 10.4, text: 'Hold' }, { t: 10.5, end: 10.7, text: 'me,' }, { t: 11.0, end: 12, text: 'closer' }], aligned: true })
  delete al.estimated
  const lines = [al, est[1], est[2], est[3]]
  const out = T.reuseRepeats(lines)
  assert.equal(out[1], lines[1])
  assert.equal(out[2].repeat, 'aligned')
  assert.equal(out[2].estimated, true)
  assert.deepEqual(out[2].words.map((w) => w.text), ['hold', 'me', 'closer'])     // its own word texts
  assert.ok(Math.abs(out[2].words[0].t - 30.1) < 1e-9)
  assert.ok(Math.abs(out[2].words[2].t - 31.0) < 1e-9)
  assert.ok(out[2].words[2].end <= 31.2 + 1e-9, 'cut at the next line')
  assert.equal(T.reuseRepeats(out), out, 'idempotent')
  // a refined source maps too, an aligned one upgrades it; own refined/aligned lines are never touched
  const ref = Object.assign({}, est[0], { refined: true, words: al.words })
  const viaRef = T.reuseRepeats([ref, est[1], est[2], est[3]])
  assert.equal(viaRef[2].repeat, 'refined')
  assert.equal(T.reuseRepeats([al, est[1], viaRef[2], est[3]])[2].repeat, 'aligned')
  const own = Object.assign({}, est[2], { refined: true })
  assert.equal(T.reuseRepeats([al, est[1], own, est[3]])[2], own)
})

test('reuseRepeats: different words, or no room before the next line -> left alone', () => {
  const al = { t: 0, text: 'a b c', aligned: true, words: [{ t: 0, end: 1, text: 'a' }, { t: 1, end: 2, text: 'b' }, { t: 2, end: 3, text: 'c' }] }
  const est = T.estimateWords([{ t: 10, text: 'a b d' }, { t: 20, text: 'a b c' }, { t: 21, text: 'z' }])
  const out = T.reuseRepeats([al, ...est])
  assert.equal(out[1], est[0])
  assert.equal(out[2], est[1])       // its last word would start after 21 - 0.05
})

test('estimateWords: leaves word-timed and unsynced lyrics alone', () => {
  const timed = [{ t: 1, text: 'x', words: [{ t: 1, end: 2, text: 'x' }] }, { t: 3, text: 'y z' }]
  assert.equal(T.estimateWords(timed), timed)
  const plain = [{ t: null, text: 'a b' }]
  assert.equal(T.estimateWords(plain), plain)
})

test('syllables: vowel groups, silent final e, minimum one', () => {
  assert.equal(T.syllables('forever'), 3)
  assert.equal(T.syllables('make'), 1)
  assert.equal(T.syllables('little'), 2)
  assert.equal(T.syllables("I'm"), 1)
  assert.equal(T.syllables('rhythm'), 1)
  assert.equal(T.syllables('anarchist'), 3)
})

test('wordWeight: punctuation adds a short breath', () => {
  assert.ok(T.wordWeight('young,') > T.wordWeight('young'))
})

// --- hyphen runs as words (0.15.39) ---
const SPLIT = require('./fixtures/split-words.json')

test('splitWords: white space and hyphen runs, the same cases as align/sonata_align.py split_words', () => {
  for (const [text, words] of SPLIT.cases) assert.deepEqual(T.splitWords(text), words, text)
})

test('wordGlue: hyphen pieces are written together, other words with a space; null for foreign words', () => {
  const text = 'So (Hey-hey-ay) now'
  const words = T.splitWords(text).map((w) => ({ text: w }))
  assert.deepEqual(T.wordGlue(text, words), [false, false, true, true, false])
  assert.deepEqual(T.wordGlue('gonna- go', T.splitWords('gonna- go').map((w) => ({ text: w }))), [false, false])
  assert.equal(T.wordGlue('a b', [{ text: 'x' }]), null)
  assert.equal(T.wordGlue('a b', []), null)
})

test('estimateWords: a hyphen run is timed as words, without a breath after each piece', () => {
  const [line] = T.estimateWords([{ t: 10, text: '(Hey-hey-ay-ay-ay)' }, { t: 30, text: 'next' }])
  assert.deepEqual(line.words.map((w) => w.text), ['(Hey-', 'hey-', 'ay-', 'ay-', 'ay)'])
  // five vocables of one syllable each: equal shares, back to back, at the song's pace
  const d = line.words.slice(0, 4).map((w) => w.end - w.t)
  assert.ok(d.every((x) => Math.abs(x - d[0]) < 1e-9), d.join(' '))
  for (let k = 1; k < 5; k++) assert.equal(line.words[k].t, line.words[k - 1].end)
  assert.equal(T.wordWeight('hey-'), T.wordWeight('hey'))
  assert.equal(T.wordWeight('-'), T.wordWeight('x') + 0.6)
})

// Hold attribution (0.15.41): "So Alive (Live)" line 53, as her cache had it (test/fixtures/hold-attribution.json)
const SO_ALIVE = require('./fixtures/hold-attribution.json')

test('reattributeHolds: the hold "it" got before the line\'s last word moves to "on"', () => {
  const words = SO_ALIVE.words
  const out = T.reattributeHolds(words, SO_ALIVE.model)
  assert.notEqual(out, words)
  // "it" keeps its short sung part and is no longer held
  assert.deepEqual(out[8], { t: 176.81, end: 176.85, text: 'it' })
  // "on" starts where "it" was sung, and holds to where the voice stops
  assert.equal(out[9].t, 176.85)
  assert.equal(out[9].end, 182.02)
  assert.equal(out[9].held, true)
  assert.ok(Math.abs(out[9].holdFrom - 176.93) < 1e-9)
  // nothing else moves, and the input is untouched
  for (let k = 0; k < 8; k++) assert.equal(out[k], words[k])
  assert.equal(words[8].end, 181.58)
  // a second pass changes nothing (cached entries go through it on every read)
  assert.equal(T.reattributeHolds(out, SO_ALIVE.model), out)
})

test('reattributeHolds: only a function word before a short last word of a line or phrase', () => {
  const w = (t, end, text, holdFrom) => Object.assign({ t, end, text }, holdFrom != null ? { held: true, holdFrom } : {})
  const same = (words, model = 'en') => assert.equal(T.reattributeHolds(words, model), words)
  // a content word held, then a short last word: the singer held "scream"
  same([w(0, 0.3, 'I'), w(0.4, 7.5, 'scream', 1.8), w(7.6, 8.1, 'it')])
  // a mid-line hold: the next word isn't the end of the line or phrase (JamendoLyrics: mostly right)
  same([w(0, 2.5, 'la', 0.1), w(2.6, 3, 'cellule'), w(3.1, 3.4, 'noire')], 'xlsr-fr')
  // the last word is long already, or the hold is short
  same([w(0, 3, 'for', 0.3), w(3.1, 4.8, 'awhile')])
  same([w(0, 0.6, 'at', 0.1), w(0.65, 0.9, 'all')])
  // the phrase ends at the held word ("say," then a new phrase)
  same([w(0, 2.5, 'say,', 0.4), w(2.6, 2.7, 'it')])
  // a language without a function-word list (MMS) is left alone
  same([w(0, 2, 'at', 0.1), w(2.1, 2.4, 'all')], 'mms')
  // phrase-final: the word before a comma takes the hold
  const out = T.reattributeHolds([w(0, 0.2, 'in'), w(0.3, 1.5, 'your', 0.4), w(1.5, 1.9, 'arms,'), w(2, 2.3, 'babe')], 'en')
  assert.deepEqual(out[1], { t: 0.3, end: 0.4, text: 'your' })
  assert.deepEqual(out[2], { t: 0.4, end: 1.9, text: 'arms,', held: true, holdFrom: 0.8 })
})
