// Precise word timing (Level 2): priority, cache key/entry, the song buffer, the request framing
// and the session flow. The helper is stubbed here (test/align-helper.test.js covers the client).
const test = require('node:test')
const assert = require('node:assert/strict')
const A = require('../align-session')
const { applyLearned } = require('../listen-session')
const { shareListener } = require('../audio-listen')
const T = require('../lyrics-timing')

const RAW = [
  { t: 10, text: 'Hello there world' },
  { t: 14, text: 'second line here' },
  { t: 18, text: 'last one' }
]
const ALIGNED_WORDS = {
  0: [{ t: 10.2, end: 10.6, text: 'Hello' }, { t: 10.7, end: 11.1, text: 'there' }, { t: 11.4, end: 12, text: 'world' }],
  2: [{ t: 18.1, end: 18.5, text: 'last' }, { t: 18.6, end: 19.5, text: 'one' }]
}
function entry(raw = RAW, words = ALIGNED_WORDS) {
  const lines = {}
  for (const [i, w] of Object.entries(words)) lines[i] = { text: raw[i].text, words: w }
  return { version: A.ENTRY_VERSION, model: 'en', lyricsHash: A.lyricsHash(raw), duration: 25, lines }
}

test('key: aligned|title|artist, separate from the lyrics and refined keys', () => {
  assert.equal(A.alignedKey('Song', 'Artist'), 'aligned|Song|Artist')
})

test('hash: same text same hash; changed text or line order changes it; timing does not', () => {
  const h = A.lyricsHash(RAW)
  assert.match(h, /^[0-9a-f]{8}$/)
  assert.equal(A.lyricsHash(RAW.map((l) => Object.assign({}, l, { t: l.t + 1 }))), h)
  assert.notEqual(A.lyricsHash([RAW[0], RAW[1], { t: 18, text: 'last two' }]), h)
  assert.notEqual(A.lyricsHash([RAW[1], RAW[0], RAW[2]]), h)
})

test('canAlign: line-synced lyrics without word timing only', () => {
  assert.equal(A.canAlign(RAW), true)
  assert.equal(A.canAlign([{ t: null, text: 'plain' }]), false)          // unsynced: not in this version
  assert.equal(A.canAlign([{ t: 1, text: 'a b', words: [{ t: 1, end: 2, text: 'a' }] }]), false)  // Apple word timing
  assert.equal(A.canAlign([]), false)
  assert.equal(A.canAlign([{ t: 1, text: '' }]), false)
})

test('priority: Apple word timing is never touched, even with an aligned entry', () => {
  const apple = [{ t: 10, text: 'Hello there world', words: [{ t: 10, end: 11, text: 'Hello' }, { t: 11, end: 12, text: 'there' }, { t: 12, end: 13, text: 'world' }] }]
  const got = A.prepareLines(apple, { estimate: true, entry: entry(apple, { 0: ALIGNED_WORDS[0] }) })
  assert.equal(got.wordSynced, true)
  assert.equal(got.aligned, false)
  assert.strictEqual(got.lines, apple)
})

test('priority: aligned beats estimated; unaligned lines stay estimated', () => {
  const got = A.prepareLines(RAW, { estimate: true, entry: entry() })
  assert.equal(got.aligned, true)
  assert.deepEqual(got.lines[0].words, ALIGNED_WORDS[0])
  assert.equal(got.lines[0].aligned, true)
  assert.equal(got.lines[0].estimated, undefined)
  assert.equal(got.lines[1].estimated, true)
  assert.equal(got.lines[1].aligned, undefined)
  assert.deepEqual(got.lines[2].words, ALIGNED_WORDS[2])
  assert.equal(RAW[0].words, undefined)   // input untouched
})

test('priority: aligned beats refined (Level 1 never applies to aligned lines)', () => {
  const lines = A.prepareLines(RAW, { estimate: true, entry: entry() }).lines
  const est = T.estimateWords(RAW)
  const learned = { v: 1, lines: { 0: { text: RAW[0].text, words: est[0].words.map((w) => Object.assign({}, w, { t: w.t + 0.1 })), plays: 1 },
    1: { text: RAW[1].text, words: est[1].words.map((w) => Object.assign({}, w, { t: w.t + 0.1 })), plays: 1 } } }
  const got = applyLearned(lines, learned)
  assert.deepEqual(got.lines[0].words, ALIGNED_WORDS[0])   // aligned kept
  assert.equal(got.lines[1].refined, true)                 // estimated line refined
})

test('priority: no entry, a stale entry, or estimation off', () => {
  assert.deepEqual(A.prepareLines(RAW, { estimate: true }).lines, T.estimateWords(RAW))
  const changed = [RAW[0], RAW[1], { t: 18, text: 'last two' }]
  const stale = A.prepareLines(changed, { estimate: true, entry: entry() })
  assert.equal(stale.aligned, false)
  // estimation off: aligned lines still get their words, the others stay line-only
  const off = A.prepareLines(RAW, { estimate: false, entry: entry() })
  assert.equal(off.aligned, true)
  assert.equal(off.lines[1].words, undefined)
  assert.deepEqual(off.lines[0].words, ALIGNED_WORDS[0])
  // a remembered refusal (no model for the language) applies nothing
  const refused = { version: A.ENTRY_VERSION, lyricsHash: A.lyricsHash(RAW), failed: 'no-model', lines: null }
  assert.equal(A.prepareLines(RAW, { estimate: true, entry: refused }).aligned, false)
})

test('applyAligned: a line whose words changed keeps its estimate', () => {
  const e = entry()
  e.lines[0].words = e.lines[0].words.slice(0, 2)
  const got = A.applyAligned(T.estimateWords(RAW), e)
  assert.equal(got.lines[0].estimated, true)
  assert.equal(got.lines[2].aligned, true)
})

// --- buffer ---

function tone(n, l, r) {
  const mid = new Float32Array(n).fill((l + r) / 2)
  const side = new Float32Array(n).fill((l - r) / 2)
  return { mid, side }
}

test('buffer: writes by song time, reconstructs L/R exactly, silence in gaps', () => {
  const b = A.createSongBuffer({ rate: 100, blockSeconds: 1 })
  const { mid, side } = tone(50, 0.5, -0.25)
  b.write(1, mid, side)                       // 1.0 .. 1.5 s
  b.write(2.5, tone(100, 0.25, 0.25).mid, null)   // 2.5 .. 3.5 s, mono
  const pcm = b.pcm(4)
  assert.equal(pcm.length, 400 * 4)
  assert.equal(pcm.readInt16LE(0), 0)                      // before: silence
  assert.equal(pcm.readInt16LE(100 * 4), 16384)            // L 0.5
  assert.equal(pcm.readInt16LE(100 * 4 + 2), -8192)        // R -0.25
  assert.equal(pcm.readInt16LE(200 * 4), 0)                // gap
  assert.equal(pcm.readInt16LE(300 * 4 + 2), 8192)
  assert.deepEqual(b.spans, [[1, 1.5], [2.5, 3.5]])
  assert.equal(b.coverage(1, 2), 0.5)
  assert.equal(b.end, 3.5)
  b.clear()
  assert.equal(b.bytes, 0)
  assert.equal(b.end, 0)
})

test('buffer: back-to-back chunks merge, negative times are cut, the length cap holds', () => {
  const b = A.createSongBuffer({ rate: 100, blockSeconds: 1, maxSeconds: 2 })
  b.write(-0.2, tone(50, 0.1, 0.1).mid, null)   // -0.2 .. 0.3 -> 0 .. 0.3
  b.write(0.3, tone(50, 0.1, 0.1).mid, null)
  assert.deepEqual(b.spans, [[0, 0.8]])
  b.write(1.8, tone(100, 0.1, 0.1).mid, null)   // runs past the 2 s cap
  assert.deepEqual(b.spans, [[0, 0.8], [1.8, 2]])
  assert.equal(b.pcm(10).length, 200 * 4)
  const loud = A.createSongBuffer({ rate: 100 })
  loud.write(0, new Float32Array([0.9]), new Float32Array([0.9]))   // L 1.8 clips
  assert.equal(loud.pcm(0.01).readInt16LE(0), 32767)
})

// --- request framing ---

test('framing: align header (original anchors, stream mode), frame-aligned base64 chunks, end', () => {
  const pcm = Buffer.alloc(1000)
  for (let i = 0; i < pcm.length; i++) pcm[i] = i & 255
  const est = T.estimateWords(RAW)
  const msgs = [...A.alignMessages('a1', [Object.assign({ end: 13 }, RAW[0]), RAW[1]], pcm, { chunkBytes: 302, rate: 22050 })]
  assert.deepEqual(msgs[0], { cmd: 'align', id: 'a1', lines: [{ t: 10, text: 'Hello there world', end: 13 }, { t: 14, text: 'second line here' }],
    audio: { stream: true, format: 's16le', rate: 22050, channels: 2 } })
  assert.equal(msgs[0].audio.path, undefined)                // never a file
  assert.equal(msgs[msgs.length - 1].cmd, 'end')
  const chunks = msgs.slice(1, -1)
  assert.ok(chunks.every((m) => m.cmd === 'chunk' && m.id === 'a1'))
  const parts = chunks.map((m) => Buffer.from(m.data, 'base64'))
  assert.ok(parts.slice(0, -1).every((p) => p.length === 300))   // 302 rounded down to whole frames
  assert.deepEqual(Buffer.concat(parts), pcm)
  assert.equal(est[0].words.length, 3)  // (estimates are never sent: the header has no words)
  assert.equal(msgs[0].lines[0].words, undefined)
  // JSON-lines safe: one line per message
  for (const m of msgs) assert.ok(!JSON.stringify(m).includes('\n'))
})

test('framing: empty audio still frames a valid request', () => {
  const msgs = [...A.alignMessages('a2', RAW, Buffer.alloc(0))]
  assert.deepEqual(msgs.map((m) => m.cmd), ['align', 'end'])
})

// --- result -> entry ---

const RESULT = {
  type: 'result', id: 'a1', source: 'aligned', stats: { aligner: 'en' },
  lines: [
    { line: 0, aligned: true, confidence: 0.6, words: [{ t: 10.2, end: 10.6, text: 'Hello', conf: 0.7 }, { t: 10.7, end: 11.1, text: 'there' }, { t: 11.4, end: 12, text: 'world' }] },
    { line: 1, aligned: false, confidence: 0.1, words: [{ t: 14, end: 14.5, text: 'second' }, { t: 14.5, end: 15, text: 'line' }, { t: 15, end: 15.5, text: 'here' }] },
    { line: 2, aligned: true, confidence: 0.5, words: [{ t: 18.1, end: 18.5, text: 'last' }, { t: 18.6, end: 19.5, text: 'one' }] }
  ]
}

test('entry: only aligned lines with matching words, times rounded, conf dropped', () => {
  const e = A.entryFromResult(RESULT, RAW, null, { duration: 25 })
  assert.equal(e.version, A.ENTRY_VERSION)
  assert.equal(e.model, 'en')
  assert.equal(e.lyricsHash, A.lyricsHash(RAW))
  assert.equal(e.aligned, 2)
  assert.equal(e.total, 3)
  assert.deepEqual(Object.keys(e.lines), ['0', '2'])
  assert.deepEqual(e.lines[0].words[0], { t: 10.2, end: 10.6, text: 'Hello' })
})

test('entry: lines not fully heard, mismatched words or broken times are left out', () => {
  const heardOnlyFirst = (line) => line.t < 12
  assert.deepEqual(Object.keys(A.entryFromResult(RESULT, RAW, heardOnlyFirst).lines), ['0'])
  const bad = JSON.parse(JSON.stringify(RESULT))
  bad.lines[0].words[1].text = 'their'
  bad.lines[2].words[1].t = 17          // goes backwards
  assert.deepEqual(A.entryFromResult(bad, RAW, null).lines, {})
  const nullEnd = JSON.parse(JSON.stringify(RESULT))
  nullEnd.lines[2].words[1].end = null
  assert.equal(A.entryFromResult(nullEnd, RAW, null).lines[2].words[1].end, 18.65)
  assert.equal(A.entryFromResult(null, RAW, null).aligned, 0)
})

// --- session ---

function fakeStore() {
  const m = new Map()
  return { get: (k) => (m.has(k) ? m.get(k) : null), set: (k, v) => m.set(k, v), map: m }
}

function setup(helperImpl, extra = {}) {
  let nowMs = 0
  const listeners = []
  const sent = []
  const logs = []
  const store = fakeStore()
  const calls = []
  const helper = {
    align: async (id, messages) => {
      const msgs = [...messages]
      calls.push(msgs)
      return helperImpl ? helperImpl(id, msgs) : RESULT
    },
    forget: (song) => calls.push([{ cmd: 'forget', song }])
  }
  const s = A.createAlignSession({
    createListener: (opts) => {
      const l = { opts, started: 0, stopped: 0, start() { this.started++ }, stop() { this.stopped++ } }
      listeners.push(l)
      return l
    },
    helper, store, send: (c, p) => sent.push([c, p]), now: () => nowMs, log: (m) => logs.push(m), latency: 0, paused: extra.paused
  })
  return { s, listeners, sent, logs, store, calls, setNow: (v) => { nowMs = v } }
}

// plays the song from `from` to `to` s at 500 ms ticks, 0.1 s chunks (rate 22050)
function play(env, from, to) {
  const rate = 22050
  const chunk = new Float32Array(rate / 10).fill(0.1)
  let res = null
  for (let t = from; t < to - 1e-9; t += 0.5) {
    env.setNow(t * 1000)
    res = env.s.tick(t, true, true) || res
    for (let k = 0; k < 5; k++) {
      const end = t + (k + 1) * 0.1
      if (env.s.recording) env.s._onChunk(chunk, end * 1000, null)
    }
  }
  return res
}

test('session: records a line-only song and aligns it once the lyric span was heard; audio dropped', async () => {
  const env = setup()
  env.s.setLyrics('Song|Artist', 'Song', 'Artist', RAW, true)
  const job = play(env, 0, 30)
  assert.ok(job, 'aligned while the song still plays')
  assert.equal(env.s.recording, false)                  // recording stopped at the hand-over
  assert.equal(env.s.bufferBytes, 0)                    // and the audio is gone
  const e = await job
  assert.equal(env.calls.length, 1)
  const head = env.calls[0][0]
  assert.equal(head.cmd, 'align')
  assert.equal(head.audio.stream, true)
  const bytes = env.calls[0].slice(1, -1).reduce((n, m) => n + Buffer.from(m.data, 'base64').length, 0)
  const span = A.lyricSpan(RAW)
  assert.equal(bytes, Math.round((span.end + 3) * 22050) * 4)   // through the lyric span + tail
  assert.equal(e.aligned, 2)
  const stored = env.store.get('aligned|Song|Artist')
  assert.deepEqual(Object.keys(stored.lines), ['0', '2'])
  assert.equal(env.sent[0][0], 'lyrics-aligned')
  assert.equal(env.sent[0][1].key, 'Song|Artist')
  // the second play uses the cache and records nothing
  env.s.setLyrics('x|y', 'x', 'y', [], true)
  env.s.setLyrics('Song|Artist', 'Song', 'Artist', RAW, true)
  assert.ok(env.s.entryFor('Song', 'Artist', RAW))
  play(env, 0, 5)
  assert.equal(env.s.recording, false)
  assert.equal(env.calls.length, 1)
})

test('session: a song heard only partly is not aligned and its audio is dropped on track change', async () => {
  const env = setup()
  env.s.setLyrics('Song|Artist', 'Song', 'Artist', RAW, true)
  play(env, 0, 12)
  assert.ok(env.s.bufferBytes > 0)
  assert.equal(env.s.setLyrics('Next|Artist', 'Next', 'Artist', RAW.slice(0, 1), true), undefined)
  assert.equal(env.calls.length, 0)
  assert.equal(env.s.bufferBytes, 0)
})

test('session: Apple word-timed songs and setting off record nothing', () => {
  const env = setup()
  env.s.setLyrics('A|B', 'A', 'B', [{ t: 1, text: 'x', words: [{ t: 1, end: 2, text: 'x' }] }], true)
  play(env, 0, 3)
  assert.equal(env.listeners.length, 0)
  env.s.setLyrics('C|D', 'C', 'D', RAW, false)
  play(env, 0, 3)
  assert.equal(env.listeners.length, 0)
})

test('session: pause stops recording; setting off drops the recording without aligning', () => {
  const env = setup()
  env.s.setLyrics('Song|Artist', 'Song', 'Artist', RAW, true)
  play(env, 0, 2)
  assert.equal(env.s.recording, true)
  env.s.tick(2, false, true)
  assert.equal(env.s.recording, false)
  env.s.tick(2, true, false)
  assert.equal(env.s.bufferBytes, 0)
  assert.equal(env.calls.length, 0)
})

test('session: lyrics window closed after the song was heard still aligns it (stop(true))', async () => {
  const env = setup()
  env.s.setLyrics('Song|Artist', 'Song', 'Artist', RAW, true)
  // heard to just past the span but not past the tail trigger
  const span = A.lyricSpan(RAW)
  play(env, 0, span.end + 1)
  assert.equal(env.calls.length, 0)
  const job = env.s.stop(true)
  assert.ok(job)
  await job
  assert.equal(env.calls.length, 1)
  assert.equal(env.sent.length, 0)          // the song isn't on screen any more
})

test('session: helper failure -> one log line, nothing cached; no-model is remembered', async () => {
  const env = setup(() => { throw new Error('helper exited') })
  env.s.setLyrics('Song|Artist', 'Song', 'Artist', RAW, true)
  await play(env, 0, 30)
  assert.equal(env.store.get('aligned|Song|Artist'), null)
  assert.equal(env.logs.filter((l) => /failed/.test(l)).length, 1)
  const env2 = setup(() => { const e = new Error('no permissively licensed aligner'); e.code = 'no-model'; throw e })
  env2.s.setLyrics('Song|Artist', 'Song', 'Artist', RAW, true)
  await play(env2, 0, 30)
  assert.equal(env2.store.get('aligned|Song|Artist').failed, 'no-model')
  env2.s.setLyrics('x|y', 'x', 'y', [], true)
  env2.s.setLyrics('Song|Artist', 'Song', 'Artist', RAW, true)
  play(env2, 0, 3)
  assert.equal(env2.listeners.length, 1)    // not recorded again
})

test('session: a seek leaves a gap that keeps those lines out of the result', async () => {
  const env = setup(async (id, msgs) => RESULT)
  env.s.setLyrics('Song|Artist', 'Song', 'Artist', RAW, true)
  play(env, 0, 9)
  env.s.tick(9, false, true)            // pause, then jump past the first line
  const job = play(env, 12.5, 30)
  // span 10..22.2: 9..12.5 missing is ~25 % -> not heard enough, nothing sent
  assert.equal(job, null)
  assert.equal(env.calls.length, 0)
})

// --- progressive sections ---

// two verses with a 10 s interlude: [0, 1] and [2, 3]
const VERSES = [
  { t: 10, text: 'first verse one' },
  { t: 13, text: 'first verse two' },
  { t: 30, text: 'second verse one' },
  { t: 33, text: 'second verse two' }
]
// a helper that "aligns" every line of the request at its anchor (slice time), 0.4 s per word
function echoHelper(id, msgs) {
  const head = msgs[0]
  return {
    type: 'result', id, source: 'aligned',
    lines: head.lines.map((l, k) => ({ line: k, aligned: true, confidence: 0.6, words: l.text.split(' ').map((w, j) => ({ t: l.t + 0.4 * j, end: l.t + 0.4 * j + 0.3, text: w })) }))
  }
}

test('sections: split at interludes, long blocks evenly into ≤ 8 lines; due TAIL_PAD after the end', () => {
  const s = A.sections(VERSES)
  assert.deepEqual(s.map((x) => [x.from, x.to]), [[0, 1], [2, 3]])
  assert.equal(s[0].start, 10)
  assert.equal(s[0].end, 13 + 0.6 * 3 + 3)          // LRC line: a guess, bounded by the next start (30)
  assert.equal(s[0].at, s[0].end + 3)
  assert.equal(s[1].end, A.lyricSpan(VERSES).end)    // the last section ends where the lyric span does
  const long = []
  for (let i = 0; i < 20; i++) long.push({ t: i * 2, end: i * 2 + 1.5, text: 'la la' })
  const parts = A.sections(long)
  assert.deepEqual(parts.map((x) => x.to - x.from + 1), [7, 7, 6])
  assert.equal(parts[0].end, 2 * 6 + 1.5)            // Apple end used as is
  assert.deepEqual(A.sections([{ t: null, text: 'x' }]), [])
})

test('sectionRequest/sectionResult: later sections get their own slice; times and indexes map back', () => {
  const s = A.sections(VERSES)
  const first = A.sectionRequest(VERSES, s[0], true)
  assert.equal(first.offset, 0)
  assert.deepEqual(first.lines, [{ t: 10, text: 'first verse one' }, { t: 13, text: 'first verse two' }])
  const second = A.sectionRequest(VERSES, s[1], false)
  assert.equal(second.offset, 27)
  assert.deepEqual(second.lines.map((l) => l.t), [3, 6])
  const back = A.sectionResult(echoHelper('x', [{ lines: second.lines }]), s[1], second.offset)
  assert.deepEqual(back.lines.map((l) => l.line), [2, 3])
  assert.equal(back.lines[0].words[0].t, 30)
  const e = A.entryFromResult(back, VERSES, null)
  assert.deepEqual(Object.keys(e.lines), ['2', '3'])
})

test('session: progressive: each verse is aligned while the song plays and sent to the views; then the whole song', async () => {
  const env = setup(echoHelper)
  env.s.setLyrics('Song|Artist', 'Song', 'Artist', VERSES, true)
  const secs = A.sections(VERSES)
  const job = play(env, 0, secs[0].at + 1)
  assert.ok(job, 'the first verse is handed over before the song ends')
  assert.equal(env.s.recording, true, 'still recording the rest')
  const e1 = await job
  assert.equal(e1.partial, true)
  assert.deepEqual(Object.keys(e1.lines), ['0', '1'])
  assert.equal(env.sent.length, 1)
  assert.deepEqual(Object.keys(env.sent[0][1].lines), ['0', '1'])
  assert.equal(env.store.get('aligned|Song|Artist').partial, true)
  // the second verse: its own slice of audio (from 3 s before its first line)
  const job2 = play(env, secs[0].at + 1, secs[1].at + 1)
  const e2 = await job2                      // the last job: the whole song once more (what gets cached)
  assert.equal(env.calls.length, 3)
  assert.equal(env.calls[2][0].lines.length, 4)
  const bytes = env.calls[1].slice(1, -1).reduce((n, m) => n + Buffer.from(m.data, 'base64').length, 0)
  assert.equal(bytes, (Math.round((secs[1].end + 3) * 22050) - Math.round(27 * 22050)) * 4)
  assert.equal(e2.partial, false)
  assert.equal(e2.aligned, 4)
  assert.deepEqual(env.sent.map(([, p]) => Object.keys(p.lines)), [['0', '1'], ['2', '3'], ['0', '1', '2', '3']])
  assert.equal(env.s.recording, false)
  assert.equal(env.s.bufferBytes, 0)
})

test('session: a verse skipped by a seek stays out; the partial entry is completed on the next play', async () => {
  const env = setup(echoHelper)
  env.s.setLyrics('Song|Artist', 'Song', 'Artist', VERSES, true)
  const secs = A.sections(VERSES)
  play(env, 0, 5)
  env.s.tick(5, false, true)                 // pause, seek into the second verse
  const job = play(env, 29, secs[1].at + 1)
  const e = await job
  assert.equal(env.calls.length, 1)          // no whole-song pass: the song wasn't all heard
  assert.deepEqual(Object.keys(e.lines), ['2', '3'])
  assert.equal(e.partial, true)
  // next play: only the first verse is recorded and aligned
  env.s.setLyrics('x|y', 'x', 'y', [], true)
  env.s.setLyrics('Song|Artist', 'Song', 'Artist', VERSES, true)
  const again = play(env, 0, secs[1].at + 1)
  const e2 = await again
  assert.equal(env.calls.length, 3)          // the missing verse, then the whole song
  assert.deepEqual(env.calls[1][0].lines.map((l) => l.text), ['first verse one', 'first verse two'])
  assert.equal(e2.partial, false)
  assert.deepEqual(Object.keys(e2.lines), ['0', '1', '2', '3'])
  // complete: not recorded again
  env.s.setLyrics('x|y', 'x', 'y', [], true)
  env.s.setLyrics('Song|Artist', 'Song', 'Artist', VERSES, true)
  const before = env.listeners.length
  play(env, 0, 3)
  assert.equal(env.listeners.length, before)
})

test('session: a failed section stops that song\'s later sections (one log line)', async () => {
  const env = setup(() => { throw new Error('helper exited') })
  env.s.setLyrics('Song|Artist', 'Song', 'Artist', VERSES, true)
  const secs = A.sections(VERSES)
  await play(env, 0, secs[0].at + 1)
  const later = play(env, secs[0].at + 1, secs[1].at + 1)
  assert.equal(await later, null)
  assert.equal(env.calls.length, 1)
  assert.equal(env.logs.filter((l) => /failed/.test(l)).length, 1)
  assert.equal(env.store.get('aligned|Song|Artist'), null)
})

test('session: jobs run one at a time, in order', async () => {
  let running = 0, most = 0
  const order = []
  const env = setup(async (id, msgs) => {
    running++; most = Math.max(most, running)
    await new Promise((r) => setTimeout(r, 5))
    order.push(msgs[0].lines[0].text)
    running--
    return echoHelper(id, msgs)
  })
  env.s.setLyrics('Song|Artist', 'Song', 'Artist', VERSES, true)
  // the window closes after the whole song was heard: both verses are handed over at once
  play(env, 0, A.sections(VERSES)[1].end + 1)
  await env.s.stop(true)
  assert.equal(most, 1)
  assert.deepEqual(order, ['first verse one', 'second verse one', 'first verse one'])   // + the whole song
})

// --- shared listener ---

test('shared listener: one real listener for two users, stopped when the last stops', () => {
  const real = { started: 0, stopped: 0, start() { this.started++ }, stop() { this.stopped++ }, state: 'running' }
  let created = 0
  let dispatch = null
  const make = shareListener((opts) => { created++; dispatch = opts.onChunk; return real })
  const got = { a: 0, b: 0 }
  const a = make({ onChunk: () => got.a++ })
  const b = make({ onChunk: () => { got.b++; throw new Error('b fails') } })
  a.start(); b.start()
  assert.equal(created, 1)
  dispatch(new Float32Array(1), 0, null)
  assert.deepEqual(got, { a: 1, b: 1 })     // b's error doesn't stop a
  a.stop()
  assert.equal(real.stopped, 0)
  dispatch(new Float32Array(1), 0, null)
  assert.deepEqual(got, { a: 1, b: 2 })
  b.stop()
  assert.equal(real.stopped, 1)
  b.stop()
  assert.equal(real.stopped, 1)
  assert.equal(a.state, 'idle')
})

// --- separate once per song (0.15.38) ---

// echoHelper that keeps sections like align/server.py (stats.kept) and can forget them
function keepingHelper(state = { lost: false }) {
  return (id, msgs) => {
    const head = msgs[0]
    if (head.final && !head.audio) {
      if (state.lost) { const e = new Error('not kept'); e.code = 'no-cache'; throw e }
      return Object.assign(echoHelper(id, msgs), { stats: { stitched: 2 } })
    }
    return Object.assign(echoHelper(id, msgs), { stats: head.song != null && !head.final ? { kept: true } : {} })
  }
}

test('sectionRequest: later slices start on the 20 ms frame grid (the helper stitches without a shift)', () => {
  const raw = [{ t: 1, text: 'a b' }, { t: 20.517, text: 'c d' }]
  const s = A.sections(raw)
  const r = A.sectionRequest(raw, s[1], false)
  assert.equal(r.offset, 17.5)                       // 20.517 - 3 = 17.517 -> down to 17.50
  assert.ok(Math.abs(r.offset / 0.02 - Math.round(r.offset / 0.02)) < 1e-9)
  assert.equal(r.lines[0].t, 20.517 - 17.5)
})

test('session: separate once per song: sections carry the song id and offset; the final pass sends no audio', async () => {
  const env = setup(keepingHelper())
  env.s.setLyrics('Song|Artist', 'Song', 'Artist', VERSES, true)
  const secs = A.sections(VERSES)
  await play(env, 0, secs[0].at + 1)
  const e = await play(env, secs[0].at + 1, secs[1].at + 1)
  assert.equal(env.calls.length, 3)
  const [h1, h2, h3] = env.calls.map((c) => c[0])
  assert.equal(h1.song, h2.song)
  assert.deepEqual([h1.offset, h2.offset], [0, 27])
  assert.ok(h1.audio && h2.audio)
  assert.deepEqual(env.calls[2].length, 1, 'the final pass is one message: no audio chunks')
  assert.equal(h3.final, true)
  assert.equal(h3.song, h1.song)
  assert.equal(h3.audio, undefined)
  assert.equal(h3.lines.length, 4)
  assert.equal(e.partial, false)
  assert.equal(e.aligned, 4)
})

test('session: final pass falls back to the audio when the helper lost the sections (no-cache)', async () => {
  const env = setup(keepingHelper({ lost: true }))
  env.s.setLyrics('Song|Artist', 'Song', 'Artist', VERSES, true)
  const secs = A.sections(VERSES)
  await play(env, 0, secs[0].at + 1)
  const e = await play(env, secs[0].at + 1, secs[1].at + 1)
  assert.equal(env.calls.length, 4)                 // 2 sections, the kept try, then with the audio
  assert.equal(env.calls[2].length, 1)
  assert.ok(env.calls[3][0].audio && env.calls[3][0].final)
  assert.ok(env.calls[3].length > 2, 'the audio follows as chunks')
  assert.equal(e.aligned, 4)
  assert.ok(env.logs.some((l) => /no longer has the sections/.test(l)))
})

test('session: a song not heard to the end: the helper is told to forget its kept sections', async () => {
  const env = setup(keepingHelper())
  env.s.setLyrics('Song|Artist', 'Song', 'Artist', VERSES, true)
  const secs = A.sections(VERSES)
  const job = play(env, 0, secs[0].at + 1)
  await job
  env.s.setLyrics('x|y', 'x', 'y', [], true)         // track change before the second verse
  await new Promise((r) => setImmediate(r))
  const last = env.calls[env.calls.length - 1][0]
  assert.deepEqual(last, { cmd: 'forget', song: env.calls[0][0].song })
})

test('session: gaming guard: nothing recorded and no new jobs while paused; later sections go on after', async () => {
  let gaming = false
  const env = setup(keepingHelper(), { paused: () => gaming })
  env.s.setLyrics('Song|Artist', 'Song', 'Artist', VERSES, true)
  const secs = A.sections(VERSES)
  play(env, 0, 5)
  gaming = true
  assert.equal(play(env, 5, secs[0].at + 1), null)
  assert.equal(env.s.recording, false)
  assert.equal(env.calls.length, 0)
  gaming = false                                      // the game ended: the second verse is recorded and aligned
  const e = await play(env, 25, secs[1].at + 1)
  assert.equal(env.calls.length, 1)
  assert.deepEqual(Object.keys(e.lines), ['2', '3'])
  assert.equal(e.partial, true)                       // the first verse fills in on a later play
})

test('session: gaming guard: a queued job not started yet is skipped (one log line), not failed', async () => {
  let gaming = false
  let release
  const gate = new Promise((r) => { release = r })
  const helperImpl = keepingHelper()
  const env = setup(async (id, msgs) => { await gate; return helperImpl(id, msgs) }, { paused: () => gaming })
  env.s.setLyrics('Song|Artist', 'Song', 'Artist', VERSES, true)
  const secs = A.sections(VERSES)
  const j1 = play(env, 0, secs[0].at + 1)
  await new Promise((r) => setImmediate(r))                 // the first verse's job has started
  const j2 = play(env, secs[0].at + 1, secs[1].at + 1)     // the second verse queued behind it
  gaming = true
  release()
  await j1
  assert.equal(await j2, null)
  assert.equal(env.calls.length, 1)
  assert.ok(env.logs.some((l) => /paused while gaming/.test(l)))
})

// --- rejected lines and gaps (0.15.39) ---

test('entryFromResult: lines the helper heard but rejected are listed with their confidence and logged', () => {
  const result = { lines: [
    { line: 0, aligned: false, confidence: 0.12, words: [{ t: 10, end: 10.3, text: 'first' }, { t: 10.4, end: 10.7, text: 'verse' }, { t: 10.8, end: 11, text: 'one' }] },
    { line: 1, aligned: true, confidence: 0.5, words: [{ t: 13, end: 13.3, text: 'first' }, { t: 13.4, end: 13.7, text: 'verse' }, { t: 13.8, end: 14, text: 'two' }] }
  ] }
  const e = A.entryFromResult(result, VERSES, null)
  assert.deepEqual(Object.keys(e.lines), ['1'])
  assert.deepEqual(e.rejected, [{ line: 0, confidence: 0.12 }])
  assert.equal(A.rejectedNote(e.rejected, VERSES), ' · rejected: line 1 (0.12) "first verse one"')
  assert.equal(A.rejectedNote([], VERSES), '')
})

// plays the song with the half second from `gapAt` not heard (a seek inside the first verse's first
// line: its section is still 90 % heard, the line isn't)
function playWithGap(env, gapAt, to) {
  play(env, 0, gapAt)
  return play(env, gapAt + 0.5, to)
}

test('session: a line missed inside a heard section is aligned on a later play; only its section, recorded alone', async () => {
  const env = setup(echoHelper)
  const secs = A.sections(VERSES)
  const end = A.lyricSpan(VERSES).end + 4
  env.s.setLyrics('Song|Artist', 'Song', 'Artist', VERSES, true)
  await playWithGap(env, 11, end)
  await env.s.stop(true)
  const e1 = env.store.get('aligned|Song|Artist')
  assert.equal(e1.whole, true)
  assert.equal(e1.partial, false)
  assert.deepEqual(Object.keys(e1.lines), ['1', '2', '3'])
  assert.deepEqual(e1.missed, [0])
  const calls = env.calls.length
  // the next play: the first verse again (only it is recorded), no whole-song pass
  env.s.setLyrics('x|y', 'x', 'y', [], true)
  env.s.setLyrics('Song|Artist', 'Song', 'Artist', VERSES, true)
  assert.match(env.logs[env.logs.length - 1], /filling 1 missed line/)
  const job = play(env, 0, 25)
  assert.ok(job, 'the first verse is aligned again')
  play(env, 25, 40)
  // only the first verse's span (with its margins) was recorded: blocks 0–2 of 10 s, not the second verse
  assert.ok(env.s.bufferBytes > 0 && env.s.bufferBytes <= 3 * 10 * 22050 * 4, String(env.s.bufferBytes))
  play(env, 40, end)
  await job
  await env.s.stop(true)
  const e2 = env.store.get('aligned|Song|Artist')
  assert.equal(env.calls.length, calls + 1)
  assert.deepEqual(env.calls[calls][0].lines.map((l) => l.text), ['first verse one', 'first verse two'])
  assert.deepEqual(Object.keys(e2.lines), ['0', '1', '2', '3'])
  assert.deepEqual(e2.missed, [])
  assert.equal(e2.fills, 1)
  assert.equal(e2.whole, true)
  // lines aligned before keep their words (the whole-song pass's)
  assert.deepEqual(e2.lines[2], e1.lines[2])
  // complete: not recorded again
  env.s.setLyrics('x|y', 'x', 'y', [], true)
  env.s.setLyrics('Song|Artist', 'Song', 'Artist', VERSES, true)
  const before = env.listeners.length
  play(env, 0, 3)
  assert.equal(env.listeners.length, before)
  assert.ok(secs.length === 2)
})

test('session: a line never heard is tried on at most MAX_FILLS later plays; rejected lines never again', async () => {
  const env = setup(echoHelper)
  const end = A.lyricSpan(VERSES).end + 4
  const again = async () => {
    env.s.setLyrics('x|y', 'x', 'y', [], true)
    env.s.setLyrics('Song|Artist', 'Song', 'Artist', VERSES, true)
    const before = env.listeners.length
    await playWithGap(env, 11, end)
    await env.s.stop(true)
    return env.listeners.length > before
  }
  env.s.setLyrics('Song|Artist', 'Song', 'Artist', VERSES, true)
  await playWithGap(env, 11, end)
  await env.s.stop(true)
  assert.equal(await again(), true)
  assert.equal(await again(), true)
  assert.equal(env.store.get('aligned|Song|Artist').fills, A.MAX_FILLS)
  assert.equal(await again(), false)
  assert.deepEqual(env.store.get('aligned|Song|Artist').missed, [0])
  // a rejected line is not missed: nothing to fill
  const rej = setup((id, msgs) => {
    const r = echoHelper(id, msgs)
    r.lines[0] = Object.assign({}, r.lines[0], { aligned: false, confidence: 0.1 })
    return r
  })
  rej.s.setLyrics('Song|Artist', 'Song', 'Artist', VERSES, true)
  await play(rej, 0, end)
  await rej.s.stop(true)
  const e = rej.store.get('aligned|Song|Artist')
  assert.deepEqual(e.missed, [])
  assert.deepEqual(e.rejected.map((r) => r.line), [0])
  assert.ok(rej.logs.some((m) => /rejected: line 1 \(0\.10\) "first verse one"/.test(m)), rej.logs.join('\n'))
  rej.s.setLyrics('x|y', 'x', 'y', [], true)
  rej.s.setLyrics('Song|Artist', 'Song', 'Artist', VERSES, true)
  const before = rej.listeners.length
  play(rej, 0, 3)
  assert.equal(rej.listeners.length, before)
})

test('validEntry: a version-2 entry still serves lyrics without hyphen runs; with one it is aligned again', () => {
  const v2 = Object.assign(entry(), { version: 2 })
  assert.equal(A.prepareLines(RAW, { estimate: true, entry: v2 }).aligned, true)
  const hy = [{ t: 10, text: 'Hey-hey there world' }, RAW[1], RAW[2]]
  const v2h = { version: 2, lyricsHash: A.lyricsHash(hy), lines: { 2: { text: 'last one', words: ALIGNED_WORDS[2] } } }
  assert.equal(A.prepareLines(hy, { estimate: true, entry: v2h }).aligned, false)
  assert.equal(A.prepareLines(hy, { estimate: true, entry: Object.assign({}, v2h, { version: A.ENTRY_VERSION }) }).aligned, true)
})
