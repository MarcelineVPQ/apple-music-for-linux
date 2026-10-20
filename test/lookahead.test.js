// Look-ahead play (lookahead.js, lookahead-page.js): first plays only, the heard clock, the player's
// events mapped to the helper's commands, the stream we route, and the fallback when the helper dies.
// The helper itself (native/lookahead/) is measured in a private PipeWire: tools/lookahead-test/.
const test = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('events')
const LA = require('../lookahead')
const P = require('../lookahead-page')
const { pickSinkInput } = require('../audio-listen')
const AS = require('../align-session')
const T = require('../lyrics-timing')

const MS = LA.DELAYS.precise
const base = { on: true, ok: true, video: false, viewOpen: true, learn: 'first', engine: 'ready', gpuBusy: false, ms: MS }

// --- what a song gets ---

test('decide: a first play is delayed by the chosen delay', () => {
  assert.deepEqual(LA.decide(base), { ms: MS, why: 'first' })
  assert.deepEqual(LA.decide(Object.assign({}, base, { ms: LA.DELAYS.quick })), { ms: LA.DELAYS.quick, why: 'first' })
  // lyrics never looked up: a first play by definition (a learned song has its lyrics cached)
  assert.deepEqual(LA.decide(Object.assign({}, base, { learn: 'unknown' })), { ms: MS, why: 'first' })
})

test('decide: first plays only: learned songs and songs with nothing to learn play with no delay', () => {
  assert.deepEqual(LA.decide(Object.assign({}, base, { learn: 'learned' })), { ms: 0, why: 'learned' })
  assert.deepEqual(LA.decide(Object.assign({}, base, { learn: 'nothing' })), { ms: 0, why: 'nothing' })
})

test('decide: music videos are never delayed', () => {
  assert.deepEqual(LA.decide(Object.assign({}, base, { video: true })), { ms: 0, why: 'video' })
  assert.deepEqual(LA.decide(Object.assign({}, base, { video: true, learn: 'unknown' })), { ms: 0, why: 'video' })
})

test('decide: no GPU, a busy GPU, an old or stopped engine, no view, switch off: no delay, and why', () => {
  assert.equal(LA.decide(Object.assign({}, base, { gpuBusy: true })).why, 'gpu-busy')
  assert.equal(LA.decide(Object.assign({}, base, { engine: 'cpu' })).why, 'engine-cpu')
  assert.equal(LA.decide(Object.assign({}, base, { engine: 'old' })).why, 'engine-old')
  assert.equal(LA.decide(Object.assign({}, base, { engine: 'off' })).why, 'engine-off')
  assert.equal(LA.decide(Object.assign({}, base, { viewOpen: false })).why, 'no-view')
  assert.equal(LA.decide(Object.assign({}, base, { on: false })).why, 'off')
  assert.equal(LA.decide(Object.assign({}, base, { ok: false })).why, 'unavailable')
  // every refusal is 0 ms
  for (const k of [{ gpuBusy: true }, { engine: 'cpu' }, { viewOpen: false }, { on: false }]) assert.equal(LA.decide(Object.assign({}, base, k)).ms, 0)
  // a status line for each, the first play's naming its delay
  assert.equal(LA.statusText('first', 3000), 'This song plays 3 s behind: its first play')
  for (const why of ['learned', 'nothing', 'video', 'no-view', 'gpu-busy', 'engine-cpu', 'engine-old', 'engine-off']) {
    const t = LA.statusText(why, 0)
    assert.ok(t && t.length <= 60, why + ': ' + t)   // the visible line's limit (the ⓘ rule)
  }
})

test('the helper\'s end in plain words', () => {
  assert.equal(LA.exitText(3, null), 'PipeWire isn\'t reachable')
  assert.equal(LA.exitText(1, null), 'its control socket failed')
  assert.equal(LA.exitText(null, 'SIGKILL'), 'the helper stopped (SIGKILL)')
})

test('learnState: from the caches only, with the same tests the align session uses', () => {
  const ls = (lyr, al) => LA.learnState(lyr, al, AS.canAlign, T.hasWordTiming)
  const lines = [{ t: 10, text: 'Hello there' }, { t: 14, text: 'General Kenobi' }]
  assert.equal(ls(null, null), 'unknown')
  assert.equal(ls({ lines: [] }, null), 'nothing')
  assert.equal(ls({ lines: [], instrumental: { by: 'apple' } }, null), 'nothing')
  // Apple's own word timing: nothing to learn
  assert.equal(ls({ lines: [{ t: 10, text: 'Hi', words: [{ t: 10, end: 10.4, text: 'Hi' }] }] }, null), 'nothing')
  // no line times: the stream needs them
  assert.equal(ls({ lines: [{ t: null, text: 'Hello there' }] }, null), 'nothing')
  assert.equal(ls({ lines }, null), 'first')
  assert.equal(ls({ lines }, { lines: { 0: {} }, partial: true }), 'first')
  assert.equal(ls({ lines }, { lines: { 0: {}, 1: {} }, partial: false }), 'learned')
})

test('learnState + decide (0.15.70): a song is learned only with its notes and expression; Apple word timing + no notes is a delayed first play', () => {
  const ls = (lyr, al, missing) => LA.learnState(lyr, al, AS.canAlign, T.hasWordTiming, missing)
  const apple = { lines: [{ t: 10, text: 'Hi there', words: [{ t: 10, end: 10.4, text: 'Hi' }, { t: 10.5, end: 11, text: 'there' }] }] }
  const lines = { lines: [{ t: 10, text: 'Hello there' }, { t: 14, text: 'General Kenobi' }] }
  const done = { lines: { 0: {}, 1: {} }, partial: false }
  const base = { on: true, ok: true, video: false, viewOpen: true, engine: 'ready', gpuBusy: false, ms: LA.DELAYS.precise }
  // [lyrics, aligned, notes missing] -> learn state -> delay
  const table = [
    [apple, null, true, 'notes', LA.DELAYS.precise],     // Marcy's "expectations": Apple word-timed, no notes yet
    [apple, null, false, 'nothing', 0],                  // Apple word-timed, notes + expression cached
    [lines, done, true, 'notes', LA.DELAYS.precise],     // aligned words, notes still to measure
    [lines, done, false, 'learned', 0],                  // aligned, notes and expression cached
    [lines, null, true, 'first', LA.DELAYS.precise],
    [lines, null, false, 'first', LA.DELAYS.precise],
    [{ lines: [{ t: null, text: 'Hello there' }] }, null, true, 'nothing', 0],   // no line times: the stream needs them
    [{ lines: [], instrumental: { by: 'apple' } }, null, true, 'nothing', 0],
    [null, null, true, 'unknown', LA.DELAYS.precise]
  ]
  for (const [lyr, al, missing, want, ms] of table) {
    const learn = ls(lyr, al, missing)
    assert.equal(learn, want, JSON.stringify([lyr && lyr.lines.length, !!al, missing]))
    assert.equal(LA.decide(Object.assign({}, base, { learn })).ms, ms, want)
  }
  assert.deepEqual(LA.decide(Object.assign({}, base, { learn: 'notes' })), { ms: LA.DELAYS.precise, why: 'notes' })
  // the delay still needs the GPU free and the engine ready
  assert.equal(LA.decide(Object.assign({}, base, { learn: 'notes', gpuBusy: true })).ms, 0)
  assert.equal(LA.decide(Object.assign({}, base, { learn: 'notes', engine: 'cpu' })).ms, 0)
  const t = LA.statusText('notes', 3000)
  assert.equal(t, 'This song plays 3 s behind: learning its notes')
  assert.ok(t.length <= 60)
})

test('main (0.15.70): look-ahead asks whether the song still needs notes, logs the delay, and starts after a helper update', () => {
  const main = require('fs').readFileSync(require('path').join(__dirname, '..', 'main.js'), 'utf8')
  assert.match(main, /lookaheadLib\.learnState\(lyr, aligned, alignSessionLib\.canAlign, lyricsTiming\.hasWordTiming, needsNotes && streamsNotes\)/)
  assert.match(main, /'first play delayed ' \+ d\.ms \/ 1000 \+ ' s \(needs notes\/expression\)'/)
  // the align session and look-ahead share one "still needs its notes" rule
  assert.match(main, /missing: notesMissing\n/)
  // the helper's update at start no longer leaves look-ahead off for the run
  const after = main.slice(main.indexOf('function helperAfter('), main.indexOf('function helperStart('))
  assert.match(after, /applyLookahead\(\)/)
  // wanted(): the stored switch, the build and Precise word timing as the panel shows it (0.15.66)
  assert.equal(LA.wanted({ lookahead: true }, { ok: true }, true), true)
  assert.equal(LA.wanted({ lookahead: true }, { ok: true }, false), false)
})

test('engineState: the engine streams only when its pong says so', () => {
  assert.equal(LA.engineState(null, false), 'off')
  assert.equal(LA.engineState(null, true), 'unknown')
  assert.equal(LA.engineState({ device: 'cuda' }, true), 'old')
  assert.equal(LA.engineState({ features: ['stream'], stream_ready: true }, true), 'ready')
  assert.equal(LA.engineState({ features: ['stream'], stream_ready: false, stream_reason: 'no-gpu' }, true), 'cpu')
  assert.equal(LA.engineState({ features: ['stream'], stream_ready: false, stream_reason: 'x' }, true), 'busy')
})

test('availability: Linux and Development builds only, and only with the helper shipped', () => {
  assert.deepEqual(LA.availability({ platform: 'darwin', devBuild: true, binary: '/x' }), { shown: false, ok: false, why: 'not-linux' })
  assert.deepEqual(LA.availability({ platform: 'win32', devBuild: true, binary: '/x' }), { shown: false, ok: false, why: 'not-linux' })
  assert.deepEqual(LA.availability({ platform: 'linux', devBuild: false, binary: '/x' }), { shown: false, ok: false, why: 'stable' })
  assert.deepEqual(LA.availability({ platform: 'linux', devBuild: true, binary: '' }), { shown: true, ok: false, why: 'no-helper' })
  assert.deepEqual(LA.availability({ platform: 'linux', devBuild: true, binary: '/x' }), { shown: true, ok: true, why: '' })
})

// --- the clock ---

test('heardClock: the player time minus the reported delay', () => {
  assert.deepEqual(LA.heardClock(10, true, 3.0213, 0), { time: 10 - 3.0213, playing: true, ready: true })
  // the helper's figure follows a quantum change: the clock takes whatever it reports
  assert.equal(LA.heardClock(10, true, 2.9893, 0).time, 10 - 2.9893)
  // no delay: the player's own clock
  assert.deepEqual(LA.heardClock(10, false, 0, null), { time: 10, playing: false, ready: true })
})

test('heardClock: while the line refills (a start, a seek) it holds at the new audio, not playing', () => {
  // a seek to 60 s: the player is at 61 s, the listener still hears the 3 s of silence before 60 s
  assert.deepEqual(LA.heardClock(61, true, 3, 60), { time: 60, playing: false, ready: false })
  // 3 s later the new audio is heard: the clock runs again from 60
  const c = LA.heardClock(63.5, true, 3, 60)
  assert.equal(c.ready, true)
  assert.ok(Math.abs(c.time - 60.5) < 1e-9)
  // a song's start (anchor 0)
  assert.deepEqual(LA.heardClock(1, true, 3, 0), { time: 0, playing: false, ready: false })
})

// --- player events -> helper commands ---

test('commandsFor: pause freezes, play resumes, a seek flushes and the player opens the gate', () => {
  const st = { ms: MS, holding: false, gated: false }
  assert.deepEqual(LA.commandsFor({ ev: 'pause' }, st).cmds, ['pause'])
  assert.deepEqual(LA.commandsFor({ ev: 'play' }, st).cmds, ['play'])
  const seek = LA.commandsFor({ ev: 'seeking', t: 42 }, st)
  assert.deepEqual(seek.cmds, ['flush ' + MS])
  assert.equal(seek.anchor, 42)
  assert.deepEqual(LA.commandsFor({ ev: 'seeked' }, Object.assign({}, st, { gated: true })).cmds, ['open'])
  assert.deepEqual(LA.commandsFor({ ev: 'playing' }, Object.assign({}, st, { gated: true })).cmds, ['open'])
  // no gate open: nothing to open
  assert.deepEqual(LA.commandsFor({ ev: 'playing' }, st).cmds, [])
  // a song with no delay: nothing buffered, so no flush and no gate (0.15.65: a gate there silenced verses)
  assert.deepEqual(LA.commandsFor({ ev: 'seeking', t: 5 }, { ms: 0 }).cmds, [])
})

test('commandsFor: a song playing to its end is not a pause: its delayed tail plays out', () => {
  assert.deepEqual(LA.commandsFor({ ev: 'pause', ended: true }, { ms: MS }).cmds, [])
  assert.deepEqual(LA.cleanEvent({ ev: 'pause', ended: true, t: 240 }), { ev: 'pause', t: 240, ended: true })
})

test('commandsFor: while an item change holds the player, its own pause/play are not the user\'s', () => {
  const st = { ms: MS, holding: true }
  assert.deepEqual(LA.commandsFor({ ev: 'pause' }, st).cmds, [])
  assert.deepEqual(LA.commandsFor({ ev: 'play' }, st).cmds, [])
})

test('commandsFor: songs with and without delay switch cleanly', () => {
  // a skip (not natural): the old song is cut, the new one starts with its own delay
  assert.deepEqual(LA.commandsFor({ ev: 'item', natural: false }, { ms: MS, nextMs: 0 }), { cmds: ['setd 0'], hold: null, anchor: 0 })
  assert.deepEqual(LA.commandsFor({ ev: 'item', natural: false }, { ms: 0, nextMs: 0 }), { cmds: [], hold: null, anchor: 0 })
  assert.deepEqual(LA.commandsFor({ ev: 'item', natural: false }, { ms: 0, nextMs: MS }), { cmds: ['flush ' + MS], hold: null, anchor: 0 })
  // natural end, into a delayed song: no cut, silence added (a gap of at most D)
  assert.deepEqual(LA.commandsFor({ ev: 'item', natural: true }, { ms: 0, nextMs: MS }), { cmds: ['track ' + MS], hold: null, anchor: 0 })
  // natural end, delayed into delayed: the new song follows on; a held player resumes at once
  assert.deepEqual(LA.commandsFor({ ev: 'item', natural: true, held: true }, { ms: MS, nextMs: MS }), { cmds: ['track ' + MS], hold: 'resume', anchor: 0 })
  // natural end, delayed into learned: the old song's last seconds play out, then the new one from its start
  assert.deepEqual(LA.commandsFor({ ev: 'item', natural: true, held: true }, { ms: MS, nextMs: 0 }), { cmds: ['track 0'], hold: 'drain', anchor: 0 })
})

test('parseLine: replies and events', () => {
  assert.deepEqual(LA.parseLine('ok stat version=1 state=run heard_us=3021333 fill=143976'), { kind: 'ok', name: 'stat', version: 1, state: 'run', heard_us: 3021333, fill: 143976 })
  assert.deepEqual(LA.parseLine('ok t=123'), { kind: 'ok', t: 123 })
  assert.deepEqual(LA.parseLine('ev drained t=5 a=0 b=0'), { kind: 'ev', name: 'drained', t: 5, a: 0, b: 0 })
  assert.deepEqual(LA.parseLine('err unknown'), { kind: 'err' })
})

test('cleanEvent: only known events and fields; videos named by their kind', () => {
  assert.equal(LA.cleanEvent(null), null)
  assert.equal(LA.cleanEvent({ ev: 'loadstart' }), null)
  assert.deepEqual(LA.cleanEvent({ ev: 'pause', t: 12.5, extra: 'x' }), { ev: 'pause', t: 12.5 })
  assert.deepEqual(LA.cleanEvent({ ev: 'seeking', t: -1 }), { ev: 'seeking' })
  const it = LA.cleanEvent({ ev: 'item', natural: true, held: 'yes', kind: 'musicVideos', title: 'x'.repeat(400), isrc: 'US-ABC-12<>', duration: 200 })
  assert.equal(it.natural, true)
  assert.equal(it.held, false)
  assert.equal(it.video, true)
  assert.equal(it.title.length, 300)
  assert.equal(it.isrc, 'USABC12')
  assert.equal(LA.cleanEvent({ ev: 'item', kind: 'songs' }).video, false)
  assert.equal(LA.cleanEvent({ ev: 'play', video: true }).video, true)
})

// --- the stream we route ---

test('the routed stream and the engine tap are Chromium\'s, never the helper\'s own output', () => {
  const tree = new Set([1000, 1011, 1500])   // main, audio utility, the helper
  const chromium = { index: 50, sink: 7, corked: false, properties: { 'application.name': 'Sonata', 'application.process.id': '1011', 'node.name': 'Sonata', 'object.id': '88' } }
  const helperOut = { index: 61, sink: 3, corked: false, properties: { 'application.name': 'Sonata', 'application.process.id': '1500', 'node.name': LA.OUT_NODE, 'object.id': '95' } }
  const sinks = [{ index: 3, name: 'alsa_output.usb' }, { index: 7, name: LA.SINK }]
  assert.equal(pickSinkInput([chromium, helperOut], tree).index, 50)
  assert.equal(pickSinkInput([helperOut], tree), null)
  assert.deepEqual(LA.sonataStream([helperOut, chromium], sinks, tree, pickSinkInput), { index: 50, objectId: '88', sink: LA.SINK })
  assert.equal(LA.sonataStream([helperOut], sinks, tree, pickSinkInput), null)
})

// --- the page scripts ---

test('page scripts: self-contained strings; the hold flag is a plain boolean', () => {
  assert.doesNotThrow(() => new Function(P.mainWorldScript()))      // eslint-disable-line no-new-func
  assert.doesNotThrow(() => new Function(P.isolatedWorldScript()))  // eslint-disable-line no-new-func
  assert.equal(P.holdScript(true), 'window.__sonataLaHold = true;')
  assert.equal(P.holdScript(1), 'window.__sonataLaHold = true;')
  assert.equal(P.holdScript(''), 'window.__sonataLaHold = false;')
})

test('page main world: a natural item change is reported before the player is held', () => {
  const calls = []
  const doc = new EventEmitter()
  const attrs = {}
  const listeners = {}
  const mk = {
    currentPlaybackTime: 239.2,
    nowPlayingItem: { id: 'a1', type: 'songs', attributes: { name: 'Old', artistName: 'A', durationInMillis: 240000 } },
    addEventListener: (n, fn) => { listeners[n] = fn },
    pause: () => calls.push('pause')
  }
  const g = {
    document: { __sonataLookahead: false, documentElement: { setAttribute: (k, v) => { attrs[k] = v } },
      addEventListener: (n, fn) => doc.on(n, fn), dispatchEvent: () => calls.push('news:' + attrs['data-sonata-la']) },
    window: { MusicKit: { getInstance: () => mk }, __sonataLaHold: true },
    Event: function (n) { this.type = n },
    setTimeout: () => 0
  }
  const run = new Function('document', 'window', 'Event', 'setTimeout', 'MusicKit', 'return (' + P.mainWorld.toString() + ')(' + P.END_S + ')')  // eslint-disable-line no-new-func
  assert.equal(run(g.document, g.window, g.Event, g.setTimeout, g.window.MusicKit), true)
  doc.emit('timeupdate')                                   // the old song at 239.2 of 240 s: ending by itself
  mk.nowPlayingItem = { id: 'b2', type: 'songs', attributes: { name: 'New', artistName: 'B', isrc: 'GBX', durationInMillis: 200000 } }
  listeners.nowPlayingItemDidChange()
  assert.equal(calls.length, 2)
  const news = JSON.parse(calls[0].slice(5))
  assert.deepEqual(news, { ev: 'item', natural: true, held: true, kind: 'songs', title: 'New', artist: 'B', isrc: 'GBX', duration: 200, id: 'b2' })
  assert.equal(calls[1], 'pause')                          // after the news: main's pause event is known to be the hold
  // a skip in the middle of a song: not natural, never held
  mk.currentPlaybackTime = 30
  doc.emit('timeupdate')
  listeners.nowPlayingItemDidChange()
  assert.equal(JSON.parse(calls[2].slice(5)).natural, false)
  assert.equal(calls.length, 3)
})

// --- the controller, with a fake helper ---

function fakeWorld(opts = {}) {
  const log = []
  const execs = []
  const sent = []
  const player = []
  const holds = []
  let lineClose = null
  let lineEvent = null
  const children = []
  const spawn = (bin, args) => {
    const c = new EventEmitter()
    c.stdout = new EventEmitter()
    c.stderr = new EventEmitter()
    c.stdout.setEncoding = () => {}
    c.stderr.setEncoding = () => {}
    c.kill = (sig) => { c.killed = sig || 'SIGTERM'; setImmediate(() => c.emit('exit', null, c.killed)) }
    c.bin = bin
    c.args = args
    children.push(c)
    if (bin !== 'pactl') setImmediate(() => c.stdout.emit('data', 'ready sonata-lookahead\n'))
    return c
  }
  const stream = { index: 50, objectId: '88', sink: opts.sink || 'alsa_output.usb' }
  const la = LA.createLookahead({
    binary: '/app/sonata-lookahead', socketPath: '/run/x.sock', spawn,
    execFile: (cmd, args, o, cb) => { execs.push([cmd, ...args]); setImmediate(() => cb(null, '')) },
    createLine: () => ({
      ready: Promise.resolve(),
      cmd: (line) => { sent.push(line); return Promise.resolve(line === 'stat' ? LA.parseLine('ok stat state=run heard_us=3021333') : { kind: 'ok' }) },
      onEvent: (fn) => { lineEvent = fn },
      onClose: (fn) => { lineClose = fn },
      close() { this.closed = true },
      closed: false
    }),
    findStream: () => Promise.resolve(stream),
    decide: opts.decide || (() => ({ ms: MS, why: 'first' })),
    now: opts.now,
    player: (a) => player.push(a),
    setHold: (on) => holds.push(on),
    log: (m) => log.push(m)
  })
  return { la, log, execs, sent, player, holds, children, emitHelper: (e) => lineEvent(e), closeLine: () => lineClose(), stream }
}
const settle = () => new Promise((r) => setImmediate(r)).then(() => new Promise((r) => setImmediate(r)))

test('controller: starts the helper, routes only Sonata\'s stream to its sink, watches for new streams', async () => {
  const w = fakeWorld()
  w.la.start()
  assert.equal(w.la.phase, 'starting')
  await settle()
  assert.equal(w.la.phase, 'on')
  assert.deepEqual(w.children[0].args, ['--ctl', '/run/x.sock', '--delay-ms', '0'])
  assert.deepEqual(w.execs[0], ['pactl', 'move-sink-input', '50', LA.SINK])
  assert.ok(w.children.some((c) => c.bin === 'pactl' && c.args[0] === 'subscribe'))
  w.la.stop()
})

test('controller: a stream already on our sink is not moved again', async () => {
  const w = fakeWorld({ sink: LA.SINK })
  w.la.start()
  await settle()
  assert.equal(w.execs.filter((e) => e[1] === 'move-sink-input').length, 0)
  assert.equal(w.la.routed, true)
  w.la.stop()
})

test('controller: the page\'s events reach the helper in order; the clock follows its reported delay', async () => {
  const w = fakeWorld()
  w.la.start()
  await settle()
  w.la.pageEvent({ ev: 'item', natural: false, title: 'New song', kind: 'songs' })
  w.la.pageEvent({ ev: 'playing' })
  w.la.pageEvent({ ev: 'pause' })
  w.la.pageEvent({ ev: 'play' })
  w.la.pageEvent({ ev: 'seeking', t: 60 })
  w.la.pageEvent({ ev: 'seeked' })
  w.la.pageEvent({ ev: 'bogus' })
  assert.deepEqual(w.sent, ['flush ' + MS, 'open', 'pause', 'play', 'flush ' + MS, 'open'])
  assert.deepEqual(w.holds, [true])                 // a delayed song: hold at its natural end
  await w.la.tick()
  assert.ok(Math.abs(w.la.delayS - 3.021333) < 1e-9)
  const c = w.la.clock(70, true)
  assert.ok(Math.abs(c.time - (70 - 3.021333)) < 1e-9)
  assert.equal(w.la.clock(62, true).ready, false)   // still filling after the seek to 60
  assert.equal(w.la.status(), 'This song plays 3 s behind: its first play')
  w.la.stop()
})

test('controller: the new song\'s own seek to its start while it loads is not a seek', async () => {
  const w = fakeWorld()
  w.la.start()
  await settle()
  w.la.pageEvent({ ev: 'item', natural: true, title: 'B' })
  w.la.pageEvent({ ev: 'seeking', t: 0 })
  assert.deepEqual(w.sent, ['track ' + MS])
  w.la.pageEvent({ ev: 'seeking', t: 30 })          // the user's seek, right after: a seek
  assert.deepEqual(w.sent.slice(-1), ['flush ' + MS])
  w.la.stop()
})

test('controller: a music video gets no delay (and no hold)', async () => {
  const w = fakeWorld({ decide: (it) => LA.decide(Object.assign({}, base, { video: !!it.video })) })
  w.la.start()
  await settle()
  w.la.pageEvent({ ev: 'item', natural: false, kind: 'musicVideos', title: 'Clip' })
  assert.deepEqual(w.sent, [])
  assert.deepEqual(w.holds, [false])
  assert.equal(w.la.song.ms, 0)
  assert.equal(w.la.status(), 'No delay: music videos are never delayed')
  w.la.stop()
})

test('controller: delayed into learned at a natural end: the tail drains, then the new song from its start', async () => {
  let next = MS
  const w = fakeWorld({ decide: () => ({ ms: next, why: next ? 'first' : 'learned' }) })
  w.la.start()
  await settle()
  w.la.pageEvent({ ev: 'item', natural: false, title: 'A' })
  next = 0
  w.la.pageEvent({ ev: 'item', natural: true, held: true, title: 'B' })
  assert.deepEqual(w.sent.slice(-1), ['track 0'])
  w.la.pageEvent({ ev: 'pause' })                  // the hold's own pause: not sent
  assert.deepEqual(w.sent.slice(-1), ['track 0'])
  assert.deepEqual(w.player, [])
  w.emitHelper({ kind: 'ev', name: 'drained' })
  assert.deepEqual(w.player, ['seek0play'])
  w.la.pageEvent({ ev: 'playing' })
  assert.deepEqual(w.sent.slice(-1), ['open'])
  w.la.stop()
})

test('controller: delayed into delayed at a natural end: the held player plays on at once', async () => {
  const w = fakeWorld()
  w.la.start()
  await settle()
  w.la.pageEvent({ ev: 'item', natural: false, title: 'A' })
  w.la.pageEvent({ ev: 'item', natural: true, held: true, title: 'B' })
  assert.deepEqual(w.sent.slice(-1), ['track ' + MS])
  assert.deepEqual(w.player, ['resume'])
  w.la.stop()
})

test('controller: the helper dies: the clock stops shifting at once, the stream target is cleared, it restarts later', async () => {
  const w = fakeWorld()
  w.la.start()
  await settle()
  w.la.pageEvent({ ev: 'item', natural: false, title: 'A' })
  await w.la.tick()
  assert.ok(w.la.delayS > 3)
  w.children[0].emit('exit', null, 'SIGKILL')
  assert.equal(w.la.phase, 'failed')
  assert.equal(w.la.delayS, 0)
  assert.equal(w.la.clock(70, true).time, 70)              // the player's own clock again: what is heard now
  await settle()
  assert.deepEqual(w.execs.slice(-1)[0], ['pactl', 'move-sink-input', '50', '@DEFAULT_SINK@'])
  assert.match(w.la.status(), /^Not running: the helper stopped/)
  assert.equal(w.holds.slice(-1)[0], false)
  w.la.stop()                                               // no restart after stop
  assert.equal(w.la.phase, 'off')
})

test('controller: stop routes the stream back, closes the helper and the stream watcher', async () => {
  const w = fakeWorld()
  w.la.start()
  await settle()
  const sub = w.children.find((c) => c.bin === 'pactl')
  w.la.stop()
  await settle()
  assert.deepEqual(w.execs.slice(-1)[0], ['pactl', 'move-sink-input', '50', '@DEFAULT_SINK@'])
  assert.ok(sub.killed)
  assert.equal(w.la.delayS, 0)
  assert.equal(w.la.status(), '')
})

// --- the streamed words in the views and the session ---

const V = require('../lyrics-view')

test('views: streamed words take their committed times one by one; the rest follow; late words are marked', () => {
  const lines = [{ t: 10, text: 'one two three', estimated: true, words: [{ t: 10, end: 10.4, text: 'one' }, { t: 10.5, end: 10.9, text: 'two' }, { t: 11, end: 11.4, text: 'three' }] }]
  // the first two words committed; "two" later than its estimate, so "three" moves after it
  const a = V.streamedLines(lines, { key: 'k', lines: { 0: { text: 'one two three', words: [{ t: 10.1, end: 10.5, text: 'one', index: 0 }, { t: 10.9, end: 11.6, text: 'two', index: 1, late: true }] } } }, 'k')
  assert.deepEqual(a.changed, [0])
  const l = a.lines[0]
  assert.equal(l.aligned, undefined)
  assert.equal(l.streaming, true)
  assert.deepEqual([l.words[0].t, l.words[1].t], [10.1, 10.9])
  assert.equal(l.words[1].late, true)
  assert.equal(l.words[0].late, undefined)
  assert.ok(l.words[2].t >= 11.6 && !l.words[2].streamed)
  // a committed word never moves again
  const b = V.streamedLines(a.lines, { key: 'k', lines: { 0: { text: 'one two three', words: [{ t: 12, end: 12.5, text: 'one', index: 0 }] } } }, 'k')
  assert.equal(b, null)
  // the last word: the line is aligned
  const c = V.streamedLines(a.lines, { key: 'k', lines: { 0: { text: 'one two three', words: [{ t: 11.7, end: 12, text: 'three', index: 2 }] } } }, 'k')
  assert.equal(c.lines[0].aligned, true)
  assert.equal(c.lines[0].estimated, undefined)
  // another song, other words, another text: nothing
  assert.equal(V.streamedLines(lines, { key: 'other', lines: { 0: { text: 'one two three', words: [{ t: 1, end: 2, text: 'one', index: 0 }] } } }, 'k'), null)
  assert.equal(V.streamedLines(lines, { key: 'k', lines: { 0: { text: 'one two three', words: [{ t: 1, end: 2, text: 'uno', index: 0 }] } } }, 'k'), null)
})

test('the late pop rule is in the stylesheet: a late word lit without its pop', () => {
  const css = require('fs').readFileSync(require('path').join(__dirname, '..', 'lyrics-view.css'), 'utf8')
  assert.match(css, /\.line\.active \.w\.now\.late, \.line\.active \.w\.now\.late \.s\.now[^{]*\{ transform: none; filter: none; \}/)
})

test('session: the helper\'s committed words become the views\' message, word for word', () => {
  const raw = [{ t: 5, text: 'Hey-hey there' }, { t: 9, text: 'Bye' }]
  const m = AS.streamedMessage(raw, [{ line: 0, words: [{ t: 5.01, end: 5.3, text: 'Hey-' }, { t: 5.3, end: 5.6, text: 'hey', late: true }] }, { line: 7, words: [{ t: 1, end: 2, text: 'x' }] }, { line: 1, words: [{ t: 9, end: 9.2, text: 'Hello' }] }])
  assert.deepEqual(m, { lines: { 0: { text: 'Hey-hey there', words: [{ t: 5.01, end: 5.3, text: 'Hey-', index: 0 }, { t: 5.3, end: 5.6, text: 'hey', index: 1, late: true }] } } })
  assert.equal(AS.streamedMessage(raw, []), null)
  // the capture as the helper wants it: s16le stereo from mid/side
  const pcm = AS.toS16(new Float32Array([0.5, -1]), new Float32Array([0.25, 0]))
  assert.deepEqual([pcm.readInt16LE(0), pcm.readInt16LE(2), pcm.readInt16LE(4), pcm.readInt16LE(6)], [24576, 8192, -32768, -32768])
})

// 0.15.65: Marcy "didn't get audio for the first verse": the helper ran with the switch shown off, and a song
// change read as a seek gated Sonata's audio until the helper's 3 s timeout
test('wanted: the helper runs only with the switch on, available, and Precise word timing on', () => {
  const ok = { ok: true }
  assert.equal(LA.wanted({ lookahead: true }, ok, true), true)
  assert.equal(LA.wanted({ lookahead: true }, ok, false), false, 'Precise timing off: the switch is disabled')
  assert.equal(LA.wanted({ lookahead: true }, { ok: false }, true), false)
  assert.equal(LA.wanted({ lookahead: false }, ok, true), false)
  assert.equal(LA.wanted({}, ok, true), false)
})

test('controller: a gate the player never confirms is opened after 100 ms, not 3 s', async () => {
  const w = fakeWorld()
  w.la.start()
  await settle()
  w.la.pageEvent({ ev: 'item', natural: false, title: 'S' })    // a skip into a delayed song: gated
  assert.deepEqual(w.sent.slice(-1), ['flush ' + MS])
  await new Promise((r) => setTimeout(r, 130))
  assert.deepEqual(w.sent.slice(-1), ['open'])
  assert.ok(w.log.some((l) => /did not confirm/.test(l)))
  // a confirmed one is not opened twice
  w.la.pageEvent({ ev: 'seeking', t: 90 })
  w.la.pageEvent({ ev: 'seeked' })
  await new Promise((r) => setTimeout(r, 130))
  assert.equal(w.sent.filter((c) => c === 'open').length, 2)   // loop: NOT-WORTH — a test
  w.la.stop()
})

test('controller: a jump to the start just before the item change is the song changing, never a seek', async () => {
  let t = 1000000
  const w = fakeWorld({ now: () => t })
  w.la.start()
  await settle()
  w.la.pageEvent({ ev: 'item', natural: true, title: 'A' })        // a delayed song plays
  w.sent.length = 0
  t += 180000                                                       // ... to its end
  // the next song: its position resets to 0 a moment before its item event
  w.la.pageEvent({ ev: 'seeking', t: 0 })
  w.la.pageEvent({ ev: 'item', natural: true, title: 'B' })
  await new Promise((r) => setTimeout(r, 350))
  assert.ok(!w.sent.some((c) => c.startsWith('flush')), 'no flush, no gate: ' + w.sent.join(','))   // loop: NOT-WORTH — a test
  w.la.stop()
})

test('controller: a song with no delay is never gated (a seek, a skip)', async () => {
  const w = fakeWorld({ decide: () => ({ ms: 0, why: 'learned' }) })
  w.la.start()
  await settle()
  w.la.pageEvent({ ev: 'item', natural: false, title: 'L' })
  w.la.pageEvent({ ev: 'seeking', t: 40 })
  w.la.pageEvent({ ev: 'seeking', t: 0 })
  await new Promise((r) => setTimeout(r, 350))
  assert.ok(!w.sent.some((c) => c.startsWith('flush')), w.sent.join(','))   // loop: NOT-WORTH — a test
  w.la.stop()
})

test('the helper\'s own gate timeout is a backstop of at most 300 ms (never a silent verse)', () => {
  const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'native', 'lookahead', 'sonata-lookahead.c'), 'utf8')
  const ms = Number((/#define GATE_TIMEOUT_MS (\d+)/.exec(src) || [])[1])
  assert.ok(ms > 0 && ms <= 300, String(ms))
})

test('delay line (QC #3): a late reply is dropped, never taken by the next command', async () => {
  const sock = new EventEmitter()
  const writes = []
  sock.setEncoding = () => {}
  sock.write = (s) => writes.push(s)
  sock.end = () => sock.emit('close')
  const line = LA.createDelayLine('/x.sock', { net: { createConnection: () => sock }, replyMs: 20 })
  sock.emit('connect')
  await line.ready
  const open = line.cmd('open')
  await assert.rejects(open, /no reply to open/)        // the helper stalls past the timeout
  const stat = line.cmd('stat')
  sock.emit('data', 'ok t=123\n')                        // open's late reply lands first
  sock.emit('data', 'ok stat state=run heard_us=3021333\n')
  const f = await stat
  assert.equal(f.name, 'stat')
  assert.equal(f.heard_us, 3021333)
  line.close()
})

test('controller (QC #9): a quick off and on starts again once the old helper exits; nothing routes meanwhile', async () => {
  const w = fakeWorld()
  w.la.start()
  await settle()
  assert.equal(w.la.phase, 'on')
  const helper = w.children.find((c) => c.bin === '/app/sonata-lookahead')   // loop: NOT-WORTH — a test
  w.la.stop()
  assert.equal(w.la.phase, 'stopping')
  await settle()                                       // its route back to the default device
  w.la.start()                                         // switched on again before the old helper is gone
  const moves = w.execs.length
  w.la.pageEvent({ ev: 'play' })                       // no route onto the dying sink
  await settle()
  assert.equal(w.execs.length, moves)
  helper.emit('exit', 0, null)
  await settle()
  await settle()
  assert.equal(w.la.phase, 'on', 'running again with the switch on')
  assert.equal(w.children.filter((c) => c.bin === '/app/sonata-lookahead').length, 2)   // loop: NOT-WORTH — a test
  w.la.stop()
})
