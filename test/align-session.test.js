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
  return { version: 1, model: 'en', lyricsHash: A.lyricsHash(raw), duration: 25, lines }
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
  const refused = { version: 1, lyricsHash: A.lyricsHash(RAW), failed: 'no-model', lines: null }
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
  assert.equal(e.version, 1)
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

function setup(helperImpl) {
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
    }
  }
  const s = A.createAlignSession({
    createListener: (opts) => {
      const l = { opts, started: 0, stopped: 0, start() { this.started++ }, stop() { this.stopped++ } }
      listeners.push(l)
      return l
    },
    helper, store, send: (c, p) => sent.push([c, p]), now: () => nowMs, log: (m) => logs.push(m), latency: 0
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
