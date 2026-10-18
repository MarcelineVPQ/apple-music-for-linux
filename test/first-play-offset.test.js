// First play on a new album (0.15.42): Apple's line stamps come before the voice, and the song-level
// onset learned from the first aligned section corrects the lines not aligned yet (lyrics-timing.js
// robustOnset / repace), refined as sections arrive, stored with the song for the next play
// (align-session.js / listen-session.js withOffset). Fixture: LIVE, "The River" (numbers only).
const test = require('node:test')
const assert = require('node:assert/strict')
const T = require('../lyrics-timing')
const A = require('../align-session')
const S = require('../listen-session')
const { mergeLearned } = require('../timing-refine')
const V = require('../lyrics-view')
const RIVER = require('./fixtures/first-play-offset.json')

// placeholder words (only the count matters for the timing)
// placeholder words, different per line (only the count matters for the timing; no line repeats another)
const text = (n, i) => Array.from({ length: n }, (_, k) => 'l' + i + 'w' + k).join(' ')
const RAW = RIVER.lines.map((l, i) => ({ t: l.t, end: l.end, text: text(l.words, i) }))
const EST = T.estimateWords(RAW)
// a line aligned with its first word at `sung`, words 0.3 s apart
function aligned(i, sung = RIVER.lines[i].sung) {
  const line = EST[i]
  const out = Object.assign({}, line, { words: line.words.map((w, k) => ({ t: sung + 0.3 * k, end: sung + 0.3 * k + 0.25, text: w.text })), aligned: true })
  delete out.estimated
  return out
}
const inSection = (k, i) => i >= RIVER.sections[k][0] && i <= RIVER.sections[k][1]
const sectionDelays = (k) => RIVER.lines.filter((l, i) => inSection(k, i) && l.sung != null).map((l) => l.sung - l.t)
// Masclef et al. (ISMIR 2021): lyrics noticed about 0.33 s early vs 0.22 s late
const cost = (errs) => errs.reduce((a, e) => a + (e < 0 ? -e / 0.33 : e / 0.22), 0)
const firstWordErrors = (lines, from, to) => {
  const out = []
  for (let i = from; i <= to; i++) if (RIVER.lines[i].sung != null) out.push(lines[i].words[0].t - RIVER.lines[i].sung)
  return out
}

test('fixture: Apple runs seconds early on this song (lines 1-3: 2.9, 1.3, 2.7 s)', () => {
  const d = RIVER.lines.slice(1, 4).map((l) => l.sung - l.t)
  assert.deepEqual(d.map((x) => Math.round(x * 10) / 10), [2.9, 1.3, 2.7])
})

test('the onset from the first aligned section applies to every line not aligned yet; early-biased, never past the median', () => {
  const lines = EST.map((l, i) => (inSection(0, i) ? aligned(i) : l))
  const out = T.repace(lines)
  const onset = T.learnedOnset(lines)
  const ds = sectionDelays(0).sort((a, b) => a - b)
  const median = (ds[3] + ds[4]) / 2
  assert.ok(onset > 0.3 && onset < median, 'a slight early bias: ' + onset.toFixed(2) + ' < median ' + median.toFixed(2))
  for (let i = 8; i < RAW.length; i++) {
    assert.equal(out[i].estimated, true)
    assert.equal(out[i].t, RAW[i].t, 'the line still lights at its stamp')
    const shift = Math.min(onset, 0.4 * (RAW[i].end - RAW[i].t))
    assert.ok(Math.abs(out[i].words[0].t - (RAW[i].t + shift)) < 1e-9, 'line ' + i + ' starts its words onset after the stamp')
  }
  // the second section, shown with it, is right more often than at the stamps (asymmetric cost)
  assert.ok(cost(firstWordErrors(out, 8, 15)) < cost(firstWordErrors(EST, 8, 15)) * 0.9)
  // lines 11-13, the ones that came in seconds early, come in less early
  for (const i of [11, 12, 13]) assert.ok(out[i].words[0].t - RIVER.lines[i].sung > EST[i].words[0].t - RIVER.lines[i].sung + 0.35)
})

test('refined as sections arrive: the onset showing moves at most ONSET_STEP per update', () => {
  // the first section says the voice comes 2.9 s after every stamp: the estimated lines take it whole
  const first = EST.map((l, i) => (inSection(0, i) ? aligned(i, l.t + 2.9) : l))
  const a = T.repace(first)
  assert.ok(Math.abs(T.shownOnset(a) - 2.9) < 1e-9, 'nothing was showing before: the first onset applies whole')
  // the next section says 0.6 s (the first was off): the shown onset steps towards it, it doesn't jump
  const b = T.repace(a.map((l, i) => (inSection(0, i) || i < 12 ? aligned(i, l.t + 0.6) : l)))
  assert.ok(Math.abs(T.shownOnset(b) - (2.9 - T.ONSET_STEP)) < 1e-9)
  const c = T.repace(b)
  assert.ok(Math.abs(T.shownOnset(c) - (2.9 - 2 * T.ONSET_STEP)) < 1e-9, 'and on towards the new onset, one step per update')
  let d = c
  for (let k = 0; k < 6; k++) d = T.repace(d)
  assert.ok(Math.abs(T.shownOnset(d) - 0.6) < 1e-9, 'until it gets there')
})

test('outliers: one line sung far off its stamp does not move the song', () => {
  // kept 0.5, 0.5, 0.55, 0.6; their 0.45 quantile
  assert.ok(Math.abs(T.robustOnset([0.5, 0.55, 0.6, 0.5, 4.0]) - 0.5175) < 1e-9)
  assert.ok(Math.abs(T.robustOnset([0.5, 0.55, 0.6, 0.5, -3.0]) - 0.5175) < 1e-9)
  assert.equal(T.robustOnset([2.9, 3.4, 3.1]), T.ONSET_MAX, 'offsets of 2-3 s are real: capped at 3 s (was 1.5)')
  assert.equal(T.robustOnset([0.1]), null)
  assert.equal(T.robustOnset([2.9], 1), 2.9)
})

test('no overshoot: half the lines on the stamp, half seconds late -> at most ONSET_LATE_MAX late', () => {
  const on = T.robustOnset([0, 0.05, -0.1, 2.5, 2.6, 2.7])
  assert.ok(on <= 0.05 + T.ONSET_LATE_MAX + 1e-9, 'not the 0.45 quantile (' + on.toFixed(2) + ')')
  const lines = EST.map((l, i) => (i < 6 ? aligned(i, l.t + (i % 2 ? 2.6 : 0)) : l))
  const out = T.repace(lines)
  for (let i = 6; i < RAW.length; i++) assert.ok(out[i].words[0].t <= RAW[i].t + T.ONSET_LATE_MAX + 0.05 + 1e-9)
  // this song: the lines sung on their stamp (8, 10) are moved at most ONSET_LATE_MAX later than the stamp put them
  const river = T.repace(EST.map((l, i) => (inSection(0, i) ? aligned(i) : l)))
  for (const i of [8, 10]) assert.ok(river[i].words[0].t - RIVER.lines[i].sung <= Math.max(0, RAW[i].t - RIVER.lines[i].sung) + T.ONSET_LATE_MAX)
})

test('Level 1: refined lines sung 2.9 s after their stamps teach the song 2.9 s (not capped at 1.5)', () => {
  const lines = EST.map((l, i) => (i < 3 ? Object.assign(aligned(i, l.t + 2.9), { aligned: undefined, refined: true, estimated: true }) : l))
  const onset = T.learnedOnset(lines)
  assert.ok(Math.abs(onset - 2.9) < 1e-9)
  const out = T.repace(lines)
  for (let i = 3; i < RAW.length; i++) assert.ok(Math.abs(out[i].words[0].t - (RAW[i].t + Math.min(2.9, 0.4 * (RAW[i].end - RAW[i].t)))) < 1e-9)
})

test('Level 1: the learned entry stores the offset (offsetSource listen); the next play gets it back', () => {
  const sent = []
  const store = new Map()
  let now = 0
  const listeners = []
  const delay = (words) => words.map((w) => ({ t: w.t + 2.9, end: w.end + 2.9, text: w.text }))
  const session = S.createListenSession({
    createListener: (opts) => { const l = { opts, start() {}, stop() {} }; listeners.push(l); return l },
    createVocalDetector: () => ({ push: (s, t0) => ({ onsets: [{ t: t0 + 0.2, strength: 1 }], voiced: [] }), reset() {} }),
    // the refiner's answer for every line: the singer 2.9 s after the stamp
    refineWords: (line) => ({ words: delay(line.words), moved: line.words.length, confidence: 0.9 }),
    mergeLearned,
    store: { get: (k) => store.get(k) || null, set: (k, v) => store.set(k, v) },
    send: (ch, p) => sent.push([ch, p]),
    now: () => now,
    latency: 0
  })
  const raw = [0, 1, 2, 3].map((k) => ({ t: 1 + 4 * k, end: 4 + 4 * k, text: 'one two three' }))
  const est = T.estimateWords(raw)
  const first = session.setLyrics('Song|Band', 'Song', 'Band', est, true)
  assert.equal(first.onset, null)
  now = 0; session.tick(0.5, true, true)
  for (let wall = 1000; wall <= 17000; wall += 1000) {
    now = wall
    listeners[0].opts.onChunk(new Float32Array(22050), wall)
    session.tick(0.5 + wall / 1000, true, true)
  }
  const entry = store.get('refined|Song|Band')
  assert.ok(Object.keys(entry.lines).length >= 3)
  assert.ok(Math.abs(entry.offset - 2.9) < 1e-9)
  assert.equal(entry.offsetSource, 'listen')
  const again = session.setLyrics('Song|Band', 'Song', 'Band', est, true)
  assert.ok(Math.abs(again.onset - 2.9) < 1e-9)
})

test('aligned entries store the offset (offsetSource aligned); prepareLines hands it on; precise words stay', () => {
  const entry = { version: A.ENTRY_VERSION, lyricsHash: A.lyricsHash(RAW), lines: {} }
  for (let i = 0; i <= 7; i++) {
    const words = aligned(i).words.map((w) => ({ t: w.t, end: w.end, text: w.text }))
    entry.lines[i] = { text: RAW[i].text, words }
  }
  const stored = A.withOffset(entry, RAW)
  assert.equal(stored.offsetSource, 'aligned')
  assert.ok(Math.abs(stored.offset - Math.round(T.robustOnset(sectionDelays(0)) * 1000) / 1000) < 1e-9)
  assert.equal(A.withOffset({ lines: { 0: entry.lines[0] } }, RAW).offset, undefined, 'fewer than 3 lines: no offset')
  const prep = A.prepareLines(RAW, { estimate: true, entry: stored })
  assert.equal(prep.onset, stored.offset)
  // the next play: aligned lines keep their precise words; the lines not aligned (8-15) start at the onset
  const shown = V.prepare({ lines: prep.lines, onset: prep.onset }).lines
  for (let i = 0; i <= 7; i++) assert.equal(shown[i].words[0].t, RIVER.lines[i].sung)
  for (let i = 8; i < RAW.length; i++) assert.ok(shown[i].words[0].t > RAW[i].t + 0.3)
})

test('the stored onset stands in while too few lines are aligned; learned lines win once there are 3', () => {
  const none = T.repace(EST, { onset: 1.2 })
  assert.ok(Math.abs(none[5].words[0].t - (RAW[5].t + 1.2)) < 1e-9)
  const lines = EST.map((l, i) => (i < 3 ? aligned(i, l.t + 0.5) : l))
  const out = T.repace(lines, { onset: 1.2 })
  assert.ok(Math.abs(out[5].words[0].t - (RAW[5].t + 0.5)) < 1e-9)
  assert.equal(T.repace(EST, { onset: NaN }), EST)
  // word-timed lyrics are never touched
  const apple = [{ t: 0, text: 'a b', words: [{ t: 0.1, end: 0.5, text: 'a' }, { t: 0.5, end: 1, text: 'b' }] }]
  assert.equal(T.repace(apple, { onset: 2 }), apple)
})
