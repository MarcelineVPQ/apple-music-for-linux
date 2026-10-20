// Refine timing by listening: stream matching, time mapping, learned-cache flow and the session.
// vocal-detect.js / timing-refine.js are stubbed here (their own tests live with them).
const test = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('events')
const { pickSinkInput, descendants, toMidSide, createListener } = require('../audio-listen')
const S = require('../listen-session')
const T = require('../lyrics-timing')

// shape of real `pactl -f json list sink-inputs` output (PipeWire), anonymised and trimmed
const stream = (index, props, corked = false) => ({
  index, driver: 'PipeWire', owner_module: null, client: null, sink: 569,
  sample_specification: 'float32le 2ch 48000Hz', corked, mute: false,
  properties: Object.assign({ 'client.api': 'pipewire-pulse', 'media.class': 'Stream/Output/Audio' }, props)
})
const FIREFOX = stream(1022, { 'application.name': 'Firefox', 'application.process.id': '5000', 'application.process.binary': 'firefox-bin', 'media.name': 'Some video' }, true)
const SPEECH = stream(1309, { 'application.name': 'speech-dispatcher-dummy', 'application.process.id': '5100', 'application.process.binary': 'sd_dummy' })
const OURS = stream(2081, { 'application.name': 'Chromium', 'application.process.id': '1011', 'application.process.binary': 'apple-music-for-linux', 'node.name': 'Chromium', 'media.name': 'Playback' })
const OTHER_SONATA = stream(2090, { 'application.name': 'Chromium', 'application.process.id': '9011', 'application.process.binary': 'apple-music-for-linux', 'node.name': 'Chromium' })
const TREE = new Set([1000, 1004, 1011])   // main + renderer + audio utility process

test('match: our Chromium stream by process tree, not Firefox or another Sonata', () => {
  const s = pickSinkInput([FIREFOX, SPEECH, OTHER_SONATA, OURS], TREE)
  assert.equal(s.index, 2081)
})

test('match: nothing of ours playing -> null (another Sonata copy is never taken by name)', () => {
  assert.equal(pickSinkInput([FIREFOX, SPEECH, OTHER_SONATA], TREE), null)
  assert.equal(pickSinkInput([], TREE), null)
  assert.equal(pickSinkInput(null, TREE), null)
})

test('match: a stream without a PID is taken only by our own name', () => {
  const noPid = (i, name, bin) => stream(i, { 'application.name': name, 'application.process.binary': bin })
  assert.equal(pickSinkInput([noPid(5, 'Chromium', 'chromium')], TREE), null)
  assert.equal(pickSinkInput([noPid(6, 'Sonata', 'sonata')], TREE).index, 6)
  assert.equal(pickSinkInput([noPid(6, 'Sonata', 'sonata'), OURS], TREE).index, 2081)  // PID match wins
  assert.equal(pickSinkInput([noPid(7, 'My player', 'x')], TREE, { name: 'My player' }).index, 7)
})

test('match: among our streams, a running one beats a corked one, then the newest', () => {
  const oldCorked = stream(3000, OURS.properties, true)
  const a = stream(2500, OURS.properties)
  assert.equal(pickSinkInput([oldCorked, a], TREE).index, 2500)
  assert.equal(pickSinkInput([a, OURS], TREE).index, 2500)
})

test('process tree: descendants of the main process only', () => {
  const procs = [{ pid: 1004, ppid: 1000 }, { pid: 1011, ppid: 1000 }, { pid: 1020, ppid: 1004 }, { pid: 2000, ppid: 1 }, { pid: 2001, ppid: 2000 }]
  assert.deepEqual([...descendants(1000, procs)].sort(), [1000, 1004, 1011, 1020])
})

test('samples: s16le stereo -> mid/side floats, whole frames only', () => {
  const b = Buffer.alloc(10)
  b.writeInt16LE(16384, 0); b.writeInt16LE(0, 2)          // L 0.5, R 0
  b.writeInt16LE(-32768, 4); b.writeInt16LE(-32768, 6)    // L -1, R -1
  const { mid, side } = toMidSide(b)
  assert.equal(mid.length, 2)
  assert.deepEqual([...mid], [0.25, -1])
  assert.deepEqual([...side], [0.25, 0])
})

test('time: song time = clock time - monitor latency; chunk start goes back its length', () => {
  const clock = T.syncClock(null, 10, true, 1000)
  assert.equal(S.MONITOR_LATENCY, 0.05)
  assert.ok(Math.abs(S.songTimeAt(clock, 1500) - (10.5 - 0.05)) < 1e-9)
  assert.ok(Math.abs(S.songTimeAt(clock, 1500, 0) - 10.5) < 1e-9)
  assert.ok(Math.abs(S.chunkStart(clock, 1500, 441, 22050) - (10.5 - 0.05 - 0.02)) < 1e-9)
  const paused = T.syncClock(clock, 12, false, 2000)
  assert.ok(Math.abs(S.songTimeAt(paused, 9000) - 11.95) < 1e-9)   // frozen while paused
})

// estimated lines like the lyrics window shows
const LINES = T.estimateWords([{ t: 1, text: 'one two three' }, { t: 4, text: 'four five' }, { t: 7, text: 'six' }])
const shift = (words, d) => words.map((w) => ({ t: w.t + d, end: w.end + d, text: w.text }))
// running-average stub with the timing-refine.js interface
const mergeLearned = (prev, next, plays) => !prev ? next.map((w) => Object.assign({}, w))
  : next.map((w, i) => ({ t: (prev[i].t * plays + w.t) / (plays + 1), end: (prev[i].end * plays + w.end) / (plays + 1), text: w.text }))

test('learned: key, apply only where text and words still match, inputs untouched', () => {
  assert.equal(S.learnedKey('Song', 'Band'), 'refined|Song|Band')
  const entry = { v: 1, lines: { 0: { text: 'one two three', words: shift(LINES[0].words, 0.2), plays: 1 }, 1: { text: 'changed', words: shift(LINES[1].words, 0.2), plays: 1 } } }
  const before = JSON.stringify(LINES)
  const { lines, used } = S.applyLearned(LINES, entry)
  assert.equal(used, true)
  assert.equal(lines[0].refined, true)
  assert.ok(Math.abs(lines[0].words[0].t - (LINES[0].words[0].t + 0.2)) < 1e-9)
  assert.equal(lines[1], LINES[1])            // text changed: estimate stays
  assert.equal(JSON.stringify(LINES), before)
  assert.equal(S.applyLearned(LINES, null).used, false)
  assert.equal(S.applyLearned(LINES, { v: 2, lines: {} }).used, false)
})

test('learned: merged across plays as a running average', () => {
  let e = S.recordLearned(null, 0, LINES[0], shift(LINES[0].words, 0.3), mergeLearned)
  assert.equal(e.lines[0].plays, 1)
  e = S.recordLearned(e, 0, LINES[0], shift(LINES[0].words, 0.1), mergeLearned)
  assert.equal(e.lines[0].plays, 2)
  assert.ok(Math.abs(e.lines[0].words[0].t - (LINES[0].words[0].t + 0.2)) < 1e-9)
  // a changed line starts over
  const changed = Object.assign({}, LINES[0], { text: 'one two tree', words: LINES[0].words.map((w, i) => i === 2 ? Object.assign({}, w, { text: 'tree' }) : w) })
  e = S.recordLearned(e, 0, changed, changed.words, mergeLearned)
  assert.equal(e.lines[0].plays, 1)
})

function fakeSession(extra = {}) {
  const sent = []
  const store = new Map()
  const listeners = []
  let now = 0
  const pushes = []
  const session = S.createListenSession(Object.assign({
    createListener: (opts) => {
      const l = { opts, started: 0, stopped: 0, start() { this.started++ }, stop() { this.stopped++ } }
      listeners.push(l)
      return l
    },
    // detector stub: an onset 0.2 s into every chunk
    createVocalDetector: () => ({ push: (s, t0) => { pushes.push(t0); return { onsets: [{ t: t0 + 0.2, strength: 1 }], voiced: [] } }, reset() {} }),
    refineWords: (line, ev) => ({ words: shift(line.words, 0.2), moved: line.words.length, confidence: ev.onsets.length ? 0.9 : 0 }),
    mergeLearned,
    store: { get: (k) => store.get(k) || null, set: (k, v) => store.set(k, v) },
    send: (ch, p) => sent.push([ch, p]),
    now: () => now,
    latency: 0
  }, extra))
  return { session, sent, store, listeners, pushes, setNow: (v) => { now = v } }
}

test('session: listens only while playing estimated lyrics; refines each line once after it is sung', () => {
  const f = fakeSession()
  const { lines, refined } = f.session.setLyrics('Song|Band', 'Song', 'Band', LINES, true)
  assert.equal(refined, false)
  assert.equal(lines, LINES)
  f.setNow(0); f.session.tick(0.5, true, true)
  assert.equal(f.listeners.length, 1)
  assert.equal(f.listeners[0].started, 1)
  // feed 1 s chunks of audio up to song time 5.5 (clock moves with wall time)
  for (let wall = 1000; wall <= 5000; wall += 1000) {
    f.setNow(wall)
    f.listeners[0].opts.onChunk(new Float32Array(22050), wall)
    f.session.tick(0.5 + wall / 1000, true, true)
  }
  // line 0 (1 … 3.7 s, +0.5 pad) was heard whole and is refined; line 1 is not over yet
  const msgs = f.sent.filter(([ch]) => ch === 'lyrics-refined')
  assert.equal(msgs.length, 1)
  assert.equal(msgs[0][1].key, 'Song|Band')
  assert.equal(msgs[0][1].lineIndex, 0)
  assert.equal(f.store.get('refined|Song|Band').lines[0].plays, 1)
  // song time of each chunk: clock at arrival minus its length
  assert.ok(Math.abs(f.pushes[0] - 0.5) < 1e-9)
  // pause stops the listener (no parec while paused)
  f.session.tick(5.5, false, true)
  assert.equal(f.listeners[0].stopped, 1)
  assert.equal(f.session.listening, false)
})

test('session: a line we started listening in the middle of is not refined', () => {
  const f = fakeSession()
  f.session.setLyrics('Song|Band', 'Song', 'Band', LINES, true)
  f.setNow(0); f.session.tick(2, true, true)        // joined at 2 s, line 0 started at 1 s
  for (let wall = 1000; wall <= 5000; wall += 1000) {
    f.setNow(wall)
    f.listeners[0].opts.onChunk(new Float32Array(22050), wall)
    f.session.tick(2 + wall / 1000, true, true)
  }
  assert.equal(f.sent.filter(([, p]) => p.lineIndex === 0).length, 0)
})

test('session: no confidence, no change', () => {
  const f = fakeSession({ refineWords: (line) => ({ words: line.words, moved: 0, confidence: 0.1 }) })
  f.session.setLyrics('Song|Band', 'Song', 'Band', LINES, true)
  f.setNow(0); f.session.tick(0.5, true, true)
  for (let wall = 1000; wall <= 5000; wall += 1000) {
    f.setNow(wall)
    f.listeners[0].opts.onChunk(new Float32Array(22050), wall)
    f.session.tick(0.5 + wall / 1000, true, true)
  }
  assert.equal(f.sent.length, 0)
  assert.equal(f.store.size, 0)
})

test('session: learned words come back on the next play; off or not estimated -> no listening', () => {
  const f = fakeSession()
  f.store.set('refined|Song|Band', S.recordLearned(null, 1, LINES[1], shift(LINES[1].words, 0.25), mergeLearned))
  const got = f.session.setLyrics('Song|Band', 'Song', 'Band', LINES, true)
  assert.equal(got.refined, true)
  assert.ok(Math.abs(got.lines[1].words[0].t - (LINES[1].words[0].t + 0.25)) < 1e-9)
  // setting off: plain lines, nothing runs
  const off = f.session.setLyrics('Song|Band', 'Song', 'Band', LINES, false)
  assert.equal(off.refined, false)
  f.session.tick(1, true, false)
  assert.equal(f.listeners.length, 0)
  // Apple word timing (not estimated): untouched, nothing runs
  const apple = [{ t: 1, text: 'a b', words: [{ t: 1, end: 1.5, text: 'a' }, { t: 1.5, end: 2, text: 'b' }] }]
  assert.equal(f.session.setLyrics('X|Y', 'X', 'Y', apple, true).lines, apple)
  f.session.tick(1, true, true)
  assert.equal(f.listeners.length, 0)
})

// --- listener process handling with fake pactl / parec ---

function fakeEnv(listJson) {
  const procs = []
  const timers = []
  let pactlCalls = 0
  const deps = {
    execFile: (cmd, args, opts, cb) => { pactlCalls++; cb(null, typeof listJson === 'function' ? listJson() : listJson) },
    spawn: (cmd, args) => {
      const p = new EventEmitter()
      p.cmd = cmd; p.args = args; p.stdout = new EventEmitter(); p.killed = false
      p.kill = () => { p.killed = true; setImmediate(() => p.emit('exit', null, 'SIGTERM')) }
      procs.push(p)
      return p
    },
    processTree: () => TREE,
    now: () => 0,
    setTimeout: (fn, ms) => { const t = { fn, ms, unref() {} }; timers.push(t); return t },
    clearTimeout: (t) => { const i = timers.indexOf(t); if (i >= 0) timers.splice(i, 1) }
  }
  return { deps, procs, timers, calls: () => pactlCalls }
}

test('listener: monitors only our stream with the spec parec args; chunks as mid floats', () => {
  const env = fakeEnv(JSON.stringify([FIREFOX, OURS]))
  const chunks = []
  const l = createListener({ appPid: 1000, onChunk: (mid, wall) => chunks.push([mid, wall]) }, env.deps)
  l.start()
  assert.equal(env.procs.length, 1)
  assert.equal(env.procs[0].cmd, 'parec')
  assert.deepEqual(env.procs[0].args.slice(0, 4), ['--monitor-stream=2081', '--format=s16le', '--channels=2', '--rate=22050'])
  assert.ok(env.procs[0].args.includes('--latency-msec=20'))
  assert.equal(l.state, 'running')
  env.procs[0].stdout.emit('data', Buffer.alloc(6))   // 1.5 frames: one now, the rest kept
  env.procs[0].stdout.emit('data', Buffer.alloc(2))
  assert.deepEqual(chunks.map((c) => c[0].length), [1, 1])
  l.stop()
  assert.equal(env.procs[0].killed, true)
  assert.equal(l.state, 'idle')
})

test('listener: re-finds the stream when parec exits; bounded retries end in unavailable', async () => {
  let list = JSON.stringify([OURS])
  const env = fakeEnv(() => list)
  const logs = []
  const l = createListener({ appPid: 1000, onChunk() {}, log: (m) => logs.push(m) }, env.deps)
  l.start()
  env.procs[0].stdout.emit('data', Buffer.alloc(4))
  list = JSON.stringify([FIREFOX])      // track change: our stream is gone
  env.procs[0].emit('exit', 0)
  // run the retry timers (watchdog timers are 1000 ms; retries use the backoff list)
  for (let i = 0; i < 10 && l.state !== 'unavailable'; i++) {
    const t = env.timers[0]   // after the exit only retry timers are pending (the watchdog is cleared)
    assert.ok(t, 'a retry is scheduled')
    env.timers.splice(env.timers.indexOf(t), 1)
    t.fn()
  }
  assert.equal(l.state, 'unavailable')
  assert.ok(env.calls() <= 7)
  assert.ok(logs.some((m) => /unavailable/.test(m)))
  assert.equal(env.timers.length, 0)   // nothing left running
})

test('listener: stream comes back after a track change -> new parec on the new index', () => {
  let list = JSON.stringify([OURS])
  const env = fakeEnv(() => list)
  const l = createListener({ appPid: 1000, onChunk() {} }, env.deps)
  l.start()
  list = JSON.stringify([stream(2200, OURS.properties)])
  env.procs[0].emit('exit', 0)
  const retry = env.timers.find((x) => x.ms === 500)
  retry.fn()
  assert.equal(env.procs.length, 2)
  assert.equal(env.procs[1].args[0], '--monitor-stream=2200')
  l.stop()
  assert.equal(env.procs[1].killed, true)
})

// QC 2026-10 LIFETIME T1: the noise gate's onsets grew with every replay and seek back (duplicates skewed its rate)
test('session: the noise gate counts each song time once: a seek back or a replay adds no onsets', () => {
  const seen = []
  const f = fakeSession({ noiseRate: (onsets) => { seen.push(onsets.length); return { rate: null } } })
  f.session.setLyrics('Song|Band', 'Song', 'Band', LINES, true)
  const pass = (wall0) => {
    f.setNow(wall0); f.session.tick(0.5, true, true)
    // loop: NOT-WORTH — a test's few chunks
    for (let wall = wall0 + 1000; wall <= wall0 + 5000; wall += 1000) {
      f.setNow(wall)
      f.listeners[f.listeners.length - 1].opts.onChunk(new Float32Array(22050), wall)
      f.session.tick(0.5 + (wall - wall0) / 1000, true, true)
    }
  }
  pass(0)
  const once = f.session.noiseOnsets
  assert.ok(once > 0)
  pass(100000)                                         // back to the start: the same song time again
  assert.equal(f.session.noiseOnsets, once, 'no duplicates')
  assert.deepEqual(S.addSpan([[0, 5]], 5.1, 8), [[0, 8]])
  assert.deepEqual(S.addSpan([[0, 5]], 20, 21), [[0, 5], [20, 21]])
  assert.equal(S.spanCovered([[0, 8]], 2, 3), true)
  assert.equal(S.spanCovered([[0, 8]], 7.5, 9), false)
})
