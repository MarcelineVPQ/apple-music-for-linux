// Lyrics timed for another version (Marcy 2026-10-18: Mad Season "I Don't Wanna Be a Soldier (Live At the
// Moore)", 557.091 s, LRCLIB lines ending at 359.23 s; the highlight ran 4-5 lines off): the rule
// (recording-id.js timingMismatch), the untimed lines and the placed ones (align-session.js untimed /
// plainTimed / prepareLines), the helper request (plain-lyrics mode: every line t: null, one whole-song job)
// and the cache mark (an entry with `plain: true`, used straight away on the next play).
const test = require('node:test')
const assert = require('node:assert/strict')
const R = require('../recording-id')
const A = require('../align-session')
const V = require('../lyrics-view')

// her song as cached (isrc:USSM11300047): 42 lines from 20.72 s, the last two at 356.22 and 356.92 s (end 359.23)
function soldier() {
  const lines = []
  for (let i = 0; i < 40; i++) lines.push({ t: Math.round((20.72 + i * 8.4) * 100) / 100, text: i % 2 ? "I don't wanna die" : "I don't wanna be a soldier mama" })
  lines.push({ t: 356.22, text: "I don't wanna die" }, { t: 356.92, text: 'Oh no', end: 359.23 })
  return lines
}
const SOLDIER = { source: 'lrclib', duration: 557.091, title: "I Don't Wanna Be a Soldier (Live At the Moore)", album: 'Above (Deluxe Edition)' }

// a song whose lines run from `first` to `last` s (line-synced, no word timing)
function lrc(first, last, n = 30, lastEnd) {
  const out = []
  for (let i = 0; i < n; i++) out.push({ t: Math.round((first + (last - first) * i / (n - 1)) * 100) / 100, text: 'line number ' + i })
  if (lastEnd != null) out[n - 1].end = lastEnd
  return out
}

test('rule: her song trips it (ends-early: 359.23 + 20 s < 75 % of 557.09 s)', () => {
  const m = R.timingMismatch(soldier(), SOLDIER)
  assert.deepEqual(m, { reason: 'ends-early', lyricsEnd: 359.23, duration: 557.09, share: 0.64 })
})

test('rule: normal songs do not trip it', () => {
  const none = (lines, rec, what) => assert.equal(R.timingMismatch(lines, rec), null, what)
  // a studio song with a long instrumental coda (Layla: singing ends ~45 %), any length
  none(lrc(15, 185, 30, 190), { source: 'lrclib', duration: 424, title: 'Layla', album: 'Layla and Other Assorted Love Songs' }, 'studio coda')
  none(lrc(20, 270, 40, 290), { source: 'lrclib', duration: 548, title: 'Free Bird', album: 'Pronounced Leh-Nerd Skin-Nerd' }, 'studio solo')
  // her own lyrics: live cuts whose singing runs near the end (The Pin (Live) 232/257 s, Long Way Down (Live) 200/217 s)
  none(lrc(12, 228, 33, 232), { source: 'lrclib', duration: 257, title: 'The Pin (Live)', album: 'Live in Buffalo' }, 'live, ends at 90 %')
  none(lrc(10, 196, 42, 200), { source: 'lrclib', duration: 217, title: 'Long Way Down (Live)' }, 'live, ends at 92 %')
  // a live jam whose singing ends at 0.72: within the margin (lyrics end + 20 s ≥ 75 %)
  none(lrc(20, 390, 50, 400), { source: 'lrclib', duration: 560, title: 'Halloween (Live)' }, 'live jam at 71 %')
  // exactly on the edge does not trip (strictly less)
  none(lrc(20, 380, 50, 380), { source: 'lrclib', duration: 533.3333333, title: 'Song (Live)' }, 'the edge')
  // Apple's own timing is never judged (her 1,016 s Apple track whose singing ends at 22 %)
  none(lrc(10, 220, 35, 228), { source: 'apple', duration: 1016, title: 'Track (Live)' }, 'apple')
  // short tracks, unknown length, plain or word-timed lyrics: nothing to judge
  none(lrc(5, 40, 10, 42), { source: 'lrclib', duration: 110, title: 'Short (Live)' }, 'short')
  none(lrc(5, 40, 10, 42), { source: 'lrclib', duration: 0, title: 'X (Live)' }, 'no length')
  none([{ t: null, text: 'a' }, { t: null, text: 'b' }], { source: 'lrclib', duration: 500, title: 'X (Live)' }, 'plain')
  none([{ t: 10, text: 'a b', words: [{ t: 10, end: 11, text: 'a' }, { t: 11, end: 12, text: 'b' }] }], { source: 'lrclib', duration: 500, title: 'X (Live)' }, 'word-timed')
  // a studio LRC a few seconds past a studio recording's end (offset stamps) is within PAST_END_S
  none(lrc(10, 243, 30), { source: 'lrclib', duration: 240, title: 'Song' }, 'stamps 3 s past the end')
})

test('rule: lyrics running past the recording\'s end trip it for any recording; a live album marks a recording', () => {
  assert.equal(R.timingMismatch(lrc(10, 400, 40), { source: 'lrclib', duration: 300, title: 'Song' }).reason, 'runs-past-end')
  assert.equal(R.timingMismatch(lrc(10, 300, 40, 302), { source: 'lrclib', duration: 600, title: 'Song', album: 'Live at the Gorge' }).reason, 'ends-early')
  assert.equal(R.timingMismatch(lrc(10, 300, 40, 302), { source: 'lrclib', duration: 600, title: 'Song', album: 'Under the Table and Dreaming' }), null)
  assert.equal(R.timingMismatch(lrc(10, 300, 40, 302), { source: 'lrclib', duration: 600, title: 'Song (2025 Remaster)' }).reason, 'ends-early')
})

test('untimed: the lines lose their times, ends and words; text and singer stay', () => {
  const out = A.untimed([{ t: 3, end: 5, text: 'a b', agent: 'v2', words: [{ t: 3, end: 4, text: 'a' }] }, { t: 6, text: 'c' }])
  assert.deepEqual(out, [{ t: null, text: 'a b', agent: 'v2' }, { t: null, text: 'c' }])
  assert.equal(A.lyricsHash(out), A.lyricsHash([{ t: 3, text: 'a b' }, { t: 6, text: 'c' }]))   // the same entry key
  assert.equal(A.canAlign(out), false)
  assert.equal(A.canAlignPlain(out), true)
})

// a plain entry as the helper's whole-song pass leaves it: lines 1, 2 and 4 aligned
const PLAIN_RAW = A.untimed([{ t: 1, text: 'one two' }, { t: 2, text: 'three' }, { t: 3, text: 'four five' }, { t: 4, text: 'six' }, { t: 5, text: 'seven' }])
function plainEntry() {
  return {
    version: A.ENTRY_VERSION, lyricsHash: A.lyricsHash(PLAIN_RAW), plain: true, partial: false, whole: true, aligned: 3, total: 5,
    lines: {
      1: { text: 'three', words: [{ t: 30, end: 31, text: 'three' }] },
      2: { text: 'four five', words: [{ t: 40, end: 40.5, text: 'four' }, { t: 40.6, end: 41.2, text: 'five' }] },
      4: { text: 'seven', words: [{ t: 60, end: 61, text: 'seven' }] }
    }
  }
}

test('plainTimed: aligned lines at their words; the others between, before and after them', () => {
  const out = A.plainTimed(PLAIN_RAW, plainEntry())
  assert.deepEqual(out.map((l) => l.t), [27, 30, 40, 50.6, 60])     // line 0 one gap before; line 3 halfway 41.2 → 60
  assert.equal(out[2].end, 41.2)
  assert.ok(out.every((l) => !l.words))
  assert.deepEqual(out.map((l) => !!l.quiet), [true, false, false, true, false])
  assert.equal(A.plainTimed(PLAIN_RAW, Object.assign(plainEntry(), { plain: false })), null)   // only plain entries place lines
  const few = plainEntry(); few.lines = { 1: few.lines[1] }
  assert.equal(A.plainTimed(PLAIN_RAW, few), null)                    // too few aligned to place the rest
})

test('prepareLines plain: untimed until a plain entry exists, then placed with the aligned words', () => {
  const first = A.prepareLines(PLAIN_RAW, { plain: true, estimate: true, entry: null })
  assert.equal(first.placed, undefined)
  assert.ok(first.lines.every((l) => l.t === null))                  // shown un-highlighted
  // an entry aligned in the wrong windows (not plain) is not used for a plain song
  const anchored = Object.assign(plainEntry(), { plain: undefined })
  assert.ok(A.prepareLines(PLAIN_RAW, { plain: true, estimate: true, entry: anchored }).lines.every((l) => l.t === null))
  const later = A.prepareLines(PLAIN_RAW, { plain: true, estimate: true, entry: plainEntry() })
  assert.equal(later.placed, true)
  assert.equal(later.aligned, true)
  assert.deepEqual(later.lines[2].words.map((w) => w.t), [40, 40.6])
  assert.equal(later.lines[2].aligned, true)
  assert.equal(later.lines[0].quiet, true)                           // an unaligned line: placed for the order only,
  assert.equal(later.lines[0].words, undefined)                      // no guessed words (never lit, lyrics-race.test.js)
  assert.equal(later.lines[0].estimated, undefined)
})

// --- the session: the request path ---

function setup(helperImpl) {
  let nowMs = 0
  const sent = []
  const logs = []
  const resent = []
  const m = new Map()
  const store = { get: (k) => (m.has(k) ? m.get(k) : null), set: (k, v) => m.set(k, v), map: m }
  const calls = []
  const helper = { align: async (id, messages) => { const msgs = [...messages]; calls.push(msgs); return helperImpl(id, msgs) }, forget: () => {} }
  const s = A.createAlignSession({
    createListener: () => ({ start() {}, stop() {} }),
    helper, store, send: (c, p) => sent.push([c, p]), now: () => nowMs, log: (x) => logs.push(x), latency: 0,
    resend: (key) => resent.push(key)
  })
  return { s, sent, logs, resent, store, calls, setNow: (v) => { nowMs = v } }
}
function play(env, from, to) {
  const rate = 22050
  const chunk = new Float32Array(rate / 10).fill(0.1)
  let res = null
  for (let t = from; t < to - 1e-9; t += 0.5) {
    env.setNow(t * 1000)
    res = env.s.tick(t, true, true) || res
    for (let k = 0; k < 5; k++) if (env.s.recording) env.s._onChunk(chunk, (t + (k + 1) * 0.1) * 1000, null)
  }
  return res
}
// the helper places line k at 5 + 8k s
function placing(id, msgs) {
  return { type: 'result', id, source: 'aligned', lines: msgs[0].lines.map((l, k) => ({ line: k, aligned: true, confidence: 0.5, words: l.text.split(' ').map((w, j) => ({ t: 5 + 8 * k + 0.4 * j, end: 5 + 8 * k + 0.4 * j + 0.3, text: w })) })) }
}
const MISMATCH = { reason: 'ends-early', lyricsEnd: 20, duration: 50, share: 0.4 }

test('session plain: one whole-song job once heard to the end, every line without a time; the entry is marked', async () => {
  const env = setup(placing)
  env.s.setLyrics('Song|Artist', 'Song', 'Artist', PLAIN_RAW, true, { duration: 50, plain: MISMATCH })
  assert.equal(env.s.active, true)
  assert.equal(play(env, 0, 40), null)                                 // no sections: nothing before the end
  const job = play(env, 40, 50)
  assert.ok(job)
  const e = await job
  assert.equal(env.calls.length, 1)
  const head = env.calls[0][0]
  assert.equal(head.cmd, 'align')
  assert.ok(head.lines.every((l) => l.t === null && l.end === undefined), 'plain-lyrics mode: no line times')
  assert.equal(head.audio.stream, true)
  assert.ok(env.calls[0].length > 2)                                   // the audio was sent (no kept sections to use)
  assert.equal(e.plain, true)
  assert.deepEqual(e.mismatch, MISMATCH)
  assert.equal(e.partial, false)
  assert.equal(e.aligned, 5)
  assert.ok(env.store.map.get('aligned|Song|Artist').plain)
  assert.deepEqual(env.resent, ['Song|Artist'])                        // still on screen: main sends the placed lines
  assert.equal(env.sent.filter(([c]) => c === 'lyrics-aligned').length, 0)
  // the next play: the entry is complete, so nothing is recorded; prepareLines places the lines straight away
  const again = setup(placing)
  again.store.map.set('aligned|Song|Artist', e)
  again.s.setLyrics('Song|Artist', 'Song', 'Artist', PLAIN_RAW, true, { duration: 50, plain: true })
  assert.equal(again.s.active, false)
  const got = again.s.entryFor('Song', 'Artist', PLAIN_RAW, { duration: 50 })
  const prep = A.prepareLines(PLAIN_RAW, { plain: true, entry: got })
  assert.deepEqual(prep.lines.map((l) => l.t), [5, 13, 21, 29, 37])
})

test('session plain: an entry aligned in the wrong windows is replaced, not merged; a song not heard to the end is not sent', async () => {
  const env = setup(placing)
  const old = { version: A.ENTRY_VERSION, lyricsHash: A.lyricsHash(PLAIN_RAW), partial: true, done: [0], lines: { 0: { text: 'one two', words: [{ t: 1, end: 2, text: 'one' }, { t: 2, end: 3, text: 'two' }] } } }
  env.store.map.set('aligned|Song|Artist', old)
  env.s.setLyrics('Song|Artist', 'Song', 'Artist', PLAIN_RAW, true, { duration: 50, plain: MISMATCH })
  const e = await play(env, 0, 50)
  assert.equal(e.lines[0].words[0].t, 5)                               // the plain pass's words, not the old ones
  assert.equal(e.done.length, 0)
  const skip = setup(placing)
  skip.s.setLyrics('Song|Artist', 'Song', 'Artist', PLAIN_RAW, true, { duration: 50, plain: MISMATCH })
  play(skip, 0, 10)
  play(skip, 30, 50)                                                    // a seek over 10-30 s
  assert.equal(skip.s.stop(true), null)
  assert.equal(skip.calls.length, 0)
  assert.match(skip.logs.join('\n'), /not heard to the end/)
})

test('session: without the plain flag a mismatched song is never sent untimed (the anchored path is unchanged)', () => {
  const env = setup(placing)
  env.s.setLyrics('Song|Artist', 'Song', 'Artist', PLAIN_RAW, true, { duration: 50 })
  assert.equal(env.s.active, false)                                    // untimed lyrics alone: not aligned (as before)
})

// --- the note while the lines are untimed ---

test('versionNote: ≤ 60 characters visible, the numbers behind the ⓘ', () => {
  const on = V.versionNote({ precise: true, reason: 'ends-early', lyricsEnd: 359.23, duration: 557.09 })
  assert.equal(on.text, 'Lyric timing is for another version: timed after this play')
  assert.match(on.info, /end at 5:59, but this recording runs 9:17/)
  assert.match(on.info, /From the next play the lyrics follow the singing/)
  const off = V.versionNote({ precise: false, reason: 'runs-past-end', lyricsEnd: 400, duration: 300 })
  assert.equal(off.text, 'Lyric timing is for another version, so it’s hidden')
  assert.match(off.info, /run to 6:40, past the end of this recording \(5:00\)/)
  assert.match(off.info, /Settings → Precise timing/)
  for (const n of [on, off, V.versionNote({ precise: true })]) assert.ok(n.text.length <= 60, n.text)
  assert.deepEqual(V.versionNote(null), { text: '', info: '' })
})
