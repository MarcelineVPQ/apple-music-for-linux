// 0.15.62: one song clock for everything (song-clock.js), and Refine by listening touches only
// estimated words (Marcy: Apple-word-timed "Dancing Queen" jumped back and forth with Refine on, and the
// sheet-notes band stepped back while the words' clock eased).
'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const C = require('../song-clock')
const T = require('../lyrics-timing')
const M = require('../sheet-notes-model')
const L = require('../listen-session')
const V = require('../lyrics-view')

// a consumer: takes each snapshot into its own time base (offset ms from the master's) and interpolates
function consumer(offsetMs) {
  let st = null
  return {
    take(s, masterNow) { st = C.localize(s, masterNow, masterNow + offsetMs) },
    at(masterNow) { return C.timeAt(st, masterNow + offsetMs) },
    get epoch() { return st ? st.epoch : -1 }
  }
}

test('one clock, two consumers: jittered, late and out-of-order pushes -> identical, monotonic times', () => {
  let now = 1000000
  const clock = C.createSongClock({ now: () => now, epochNow: () => now })
  const a = consumer(0)
  const b = consumer(-987654)
  // seeded jitter: pushes every ~500 ms, read up to 400 ms before they arrive, some reading a stale time
  let seed = 7
  const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647 }
  let song = 0
  let last = -Infinity
  let epochs = new Set()
  for (let k = 0; k < 200; k++) {
    now += 400 + rnd() * 200
    const age = rnd() * 400
    song = (now - 1000000) / 1000
    const told = rnd() < 0.1 ? song - 0.45 * rnd() : song - age / 1000      // an out-of-order (older) time now and then
    const st = clock.push(told, true, 'k', now - age)
    if (st) { a.take(st, now); b.take(st, now); epochs.add(st.epoch) }
    // render between pushes: both consumers show the same instant, never earlier than before
    for (let f = 0; f < 5; f++) {
      const at = now + f * 90
      const ta = a.at(at)
      assert.ok(Math.abs(ta - b.at(at)) < 1e-9)
      assert.ok(ta >= last - 1e-9, 'never backwards: ' + ta + ' after ' + last)
      last = ta
    }
  }
  assert.ok(Math.abs(a.at(now) - song) < 0.35, 'stays with the song')
  assert.equal(epochs.size, 1, 'no discontinuity while it only eases')
})

test('a seek and a new song are one discontinuity each, seen by every consumer', () => {
  let now = 0
  const clock = C.createSongClock({ now: () => now, epochNow: () => now })
  const a = consumer(0)
  const b = consumer(5000)
  let st
  // loop: NOT-WORTH — a test's few pushes
  for (; now <= 3000; now += 500) { st = clock.push(now / 1000, true, 'k', now); a.take(st, now); b.take(st, now) }
  const e0 = st.epoch
  st = clock.seek(60); a.take(st, now); b.take(st, now)
  assert.equal(a.epoch, e0 + 1); assert.equal(b.epoch, e0 + 1)
  assert.equal(a.at(now), 60)
  now += 500
  st = clock.push(3.4, true, 'k', now)   // a push read before the seek: ignored, no step back
  assert.ok(C.timeAt(st, now) >= 60.4)
  assert.equal(st.epoch, e0 + 1)
  clock.setSong('k2', 200)
  now += 500
  st = clock.push(0.2, true, 'k2', now)
  assert.equal(st.key, 'k2'); assert.ok(st.epoch > e0 + 1)
})

test('the band follows the clock: never backwards while it eases; snaps only on a discontinuity', () => {
  let now = 0
  const clock = C.createSongClock({ now: () => now, epochNow: () => now })
  let st = clock.push(10, true, 'k', 0)
  let strip = 10      // where the strip's animation is (song s)
  let rate = 1
  let epoch = st.epoch
  let last = strip
  for (let k = 1; k <= 60; k++) {
    // the strip moves at its playbackRate between pushes (50 ms steps), like a Web Animation
    for (let f = 0; f < 10; f++) { now += 50; strip += rate * 0.05; assert.ok(strip >= last); last = strip }
    st = clock.push(10 + now / 1000 - (k % 3 === 0 ? 0.4 : 0), true, 'k', now)   // late pushes: the clock eases back
    const fit = M.followRate(strip - 10, C.timeAt(st, now) - 10, C.rateAt(st, now), st.epoch !== epoch)
    epoch = st.epoch
    assert.equal(fit.snap, false)
    assert.ok(fit.rate >= M.FOLLOW_MIN && fit.rate <= M.FOLLOW_MAX)
    rate = fit.rate
  }
  assert.ok(Math.abs(strip - C.timeAt(st, now)) < 0.15, 'the strip stays with the words')
  assert.equal(M.followRate(5, 65, 1, true).snap, true)
})

function session(sent) {
  return L.createListenSession({
    createListener: () => ({ start() {}, stop() {} }),
    createVocalDetector: () => ({ push: (s, t0) => ({ onsets: [{ t: t0 + 0.2, strength: 1 }], voiced: [] }), reset() {} }),
    refineWords: (line) => ({ words: line.words.map((w) => ({ t: w.t + 0.2, end: w.end + 0.2, text: w.text })), confidence: 0.9 }),
    mergeLearned: (a, b) => b,
    store: { get: () => null, set() {} },
    send: (ch, p) => sent.push([ch, p]),
    now: () => 0,
    latency: 0
  })
}
const RAW = [0, 1, 2, 3].map((k) => ({ t: 1 + 4 * k, end: 4 + 4 * k, text: 'one two three' }))

test('Refine by listening: Apple word timing and aligned words are never moved', () => {
  const apple = RAW.map((l) => Object.assign({}, l, { words: [{ t: l.t, end: l.t + 1, text: 'one' }, { t: l.t + 1, end: l.t + 2, text: 'two' }, { t: l.t + 2, end: l.end, text: 'three' }] }))
  // a song with its own word timing, even with some lines estimated beside it: no session at all
  const mixed = apple.map((l, i) => i === 3 ? Object.assign({}, T.estimateWords(RAW)[3]) : l)
  const engine = T.estimateWords(RAW).map((l) => { const n = Object.assign({}, l, { aligned: true }); delete n.estimated; return n })
  for (const lines of [apple, mixed, engine]) {
    const sent = []
    const s = session(sent)
    const got = s.setLyrics('k', 'Song', 'Band', lines, true)
    assert.equal(got.lines, lines)
    s.tick(0.5, true, true)
    assert.equal(s.listening, false, 'nothing to refine: the listener never starts')
    assert.equal(sent.length, 0)
  }
  // the view refuses a refine for anything not estimated, or already refined (once per play)
  const msg = (lines) => ({ key: 'k', lineIndex: 0, words: lines[0].words.map((w) => ({ t: w.t + 0.3, end: w.end + 0.3, text: w.text })) })
  assert.equal(V.refinedLine(apple, msg(apple), 'k'), null)
  assert.equal(V.refinedLine(engine, msg(engine), 'k'), null)
  const est = T.estimateWords(RAW)
  const once = V.refinedLine(est, msg(est), 'k')
  assert.ok(once && once.refined)
  const after = est.slice(); after[0] = once
  assert.equal(V.refinedLine(after, msg(after), 'k'), null, 'refined once: never moved again this play')
})

test('corrections over 100 ms are counted: one line a minute with the count, the largest and the causes', () => {
  let now = 0
  const lines = []
  const clock = C.createSongClock({ now: () => now, epochNow: () => now, log: (m) => lines.push(m) })
  // loop: NOT-WORTH — a test's few pushes
  for (; now <= 2000; now += 500) clock.push(now / 1000, true, 'k', now)
  clock.push(now / 1000 - 0.3, true, 'k', now)   // the player 300 ms behind: eased
  now += 500
  clock.push(now / 1000 - 0.3, true, 'k', now)   // again within the minute: counted, not logged yet
  assert.equal(lines.length, 0)
  now += 61000
  clock.push(now / 1000 + 30, true, 'k', now)    // the minute is over: its line, then a jump (snapped) starts the next
  assert.equal(lines.length, 1)
  assert.match(lines[0], /^song clock: 2 corrections in the last minute \(largest \d+ ms, player behind; 2 player behind\)$/)
  const c = clock.corrections()
  assert.equal(c.n, 3)
  assert.ok(c.max >= 30000)
  assert.deepEqual(c.causes, { 'player behind': 2, 'seek or stall': 1 })
  // when each came (song time, signed ms: - the player behind the words), for the song report
  assert.equal(c.at.length, 3)
  assert.deepEqual(c.at.slice(0, 2).map(([, ms, cause]) => [Math.sign(ms), cause]), [[-1, 'player behind'], [-1, 'player behind']])
  assert.ok(c.at[0][0] > 2 && c.at[0][0] < 3, 'its song time: ' + c.at[0][0])
  clock.setSong('next', 200)
  assert.equal(clock.corrections().n, 0, 'a new song starts its own count')
})

test('minuteLine: one correction reads in the singular, without a cause list', () => {
  assert.equal(C.minuteLine({ n: 1, max: 140, maxCause: 'player ahead', causes: { 'player ahead': 1 } }), 'song clock: 1 correction in the last minute (largest 140 ms, player ahead)')
})

test('every clocked consumer is on the song clock: no 60 ms snap-back left in the views', () => {
  const fs = require('node:fs')
  for (const f of ['lyrics-view.js', 'sheet-notes-ui.js']) {
    const src = fs.readFileSync(require.resolve('../' + f), 'utf8')
    assert.doesNotMatch(src, /> 60\) \w+\.currentTime = /, f)
  }
  assert.match(fs.readFileSync(require.resolve('../main.js'), 'utf8'), /sendLyrics\('lyrics-time', clockNow\)/)
})

// 0.15.64: a house clock / PLL (Marcy: the band's speed wavered to meet the words)
test('jittered pushes (+/-60 ms, now and then 300 ms late): rate 1 +/- 0.005, phase < 20 ms, never backwards, one epoch', () => {
  let now = 0
  const clock = C.createSongClock({ now: () => now, epochNow: () => now })
  let seed = 11
  const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647 }
  let last = -Infinity
  const epochs = new Set()
  let st
  const errs = []
  // loop: NOT-WORTH — a test's pushes
  for (let k = 0; k < 240; k++) {
    now += 500
    const truth = 30 + now / 1000
    const late = rnd() < 0.08 ? 0.3 : 0
    const told = truth - late + (rnd() * 2 - 1) * 0.06   // a late push reads an old time, unaged
    st = clock.push(told, true, 'k', undefined)
    if (k > 5) epochs.add(st.epoch)   // a late first push can start it 300 ms off: one agreed step fixes that
    if (k > 4) {
      const r = C.rateAt(st, now)
      assert.ok(Math.abs(r - 1) <= C.PLL_SLEW + 1e-9, 'rate ' + r)
    }
    // loop: NOT-WORTH — a test's frames
    for (let f = 0; f < 5; f++) {
      const t = C.timeAt(st, now + f * 100)
      assert.ok(t >= last - 1e-9, 'never backwards')
      last = t
    }
    if (k > 40) errs.push(Math.abs(C.timeAt(st, now) - truth))
  }
  assert.equal(epochs.size, 1, 'no discontinuity from jitter')
  errs.sort((x, y) => x - y)
  assert.ok(errs[errs.length >> 1] < 0.02, 'phase converged: median ' + errs[errs.length >> 1])
  assert.ok(errs[Math.floor(errs.length * 0.95)] < 0.04, 'phase stays close')
  // the band at constant speed: its follow rate is the clock's own
  const fit = M.followRate(C.timeAt(st, now) - 0.01, C.timeAt(st, now), C.rateAt(st, now), false)
  assert.ok(Math.abs(fit.rate - 1) <= C.PLL_SLEW + 0.001)
})

test('a real 2 s seek in the player: one discontinuity, then steady', () => {
  let now = 0
  const clock = C.createSongClock({ now: () => now, epochNow: () => now })
  let st
  // loop: NOT-WORTH — a test's pushes
  for (; now <= 5000; now += 500) st = clock.push(now / 1000, true, 'k', now)
  const e0 = st.epoch
  // loop: NOT-WORTH — a test's pushes
  for (; now <= 10000; now += 500) st = clock.push(now / 1000 + 2, true, 'k', now)
  assert.equal(st.epoch, e0 + 1)
  assert.ok(Math.abs(C.timeAt(st, now - 500) - ((now - 500) / 1000 + 2)) < 0.02)
  assert.ok(Math.abs(C.rateAt(st, now) - 1) <= C.PLL_SLEW)
})

// 0.15.65: Marcy's journal at each song change: "corrected -187497 ms (jump: a seek or a stall, snapped)"
// (the player's time for the NEW song came before its name), then "corrected 227 ms (jump…)"
test('a song boundary: the new song\'s time before its name never snaps the old song to 0:00', () => {
  let now = 0
  const lines = []
  const clock = C.createSongClock({ now: () => now, epochNow: () => now, log: (m) => lines.push(m) })
  const a = consumer(0)
  const seen = []
  const take = (st) => { if (st) { a.take(st, now); seen.push(st) } }
  // loop: NOT-WORTH — a test's few pushes
  for (let k = 0; k <= 374; k++) { now = k * 500; take(clock.push(k * 0.5, true, 'old', now)) }   // the old song to 187 s
  const oldEpoch = a.epoch
  let last = a.at(now)
  // the new song's time (0.1, 0.6) arrives under the old song's name, then the name changes
  now += 500; take(clock.push(0.1, true, 'old', now))
  assert.ok(a.at(now) >= last, 'the old song never goes back'); last = a.at(now)
  now += 500; take(clock.push(0.6, true, 'old', now))
  assert.ok(a.at(now) >= last, 'the old song never goes back')
  assert.equal(a.epoch, oldEpoch, 'held: no epoch for the old song')
  // loop: NOT-WORTH — a test's few pushes
  for (let k = 0; k < 12; k++) { now += 500; take(clock.push(1.1 + k * 0.5, true, 'new', now)) }
  const newEpochs = new Set(seen.filter((s) => s.key === 'new').map((s) => s.epoch))   // loop: NOT-WORTH — a test
  assert.equal(newEpochs.size, 1, 'exactly one epoch into the new song')
  assert.ok(seen.every((s) => s.key === 'old' ? s.epoch === oldEpoch : s.epoch > oldEpoch))   // loop: NOT-WORTH — a test
  assert.ok(!clock.corrections().causes['seek or stall'], 'no snap counted: ' + JSON.stringify(clock.corrections()))   // loop: NOT-WORTH — a test
  assert.ok(Math.abs(a.at(now) - (1.1 + 11 * 0.5)) < 0.05, 'on the new song')
})

test('a drop to the start with no song change is a seek after BOUNDARY_WAIT (repeat one)', () => {
  let now = 0
  const clock = C.createSongClock({ now: () => now, epochNow: () => now })
  let st
  // loop: NOT-WORTH — a test's few pushes
  for (let k = 0; k <= 40; k++) { now = k * 500; st = clock.push(k * 0.5, true, 's', now) }
  const e = st.epoch
  // loop: NOT-WORTH — a test's few pushes
  for (let k = 0; k < 5; k++) { now += 500; st = clock.push(0.2 + k * 0.5, true, 's', now) || st }
  assert.ok(st.epoch > e, 'snapped once the wait ran out')
  assert.ok(Math.abs(clock.time() - 2.2) < 0.05)
})

test('a new song\'s first push 227 ms off (or paused, then playing): no visible jump', () => {
  // loop: NOT-WORTH — two cases
  for (const pausedFirst of [false, true]) {
    let now = 0
    const lines = []
    const clock = C.createSongClock({ now: () => now, epochNow: () => now, log: (m) => lines.push(m) })
    const a = consumer(0)
    now = 1000; a.take(clock.push(0, !pausedFirst, 'n', now), now)
    const e = a.epoch
    let last = a.at(now)
    let lastAt = now
    // loop: NOT-WORTH — a test's few pushes
    for (let k = 1; k <= 20; k++) {
      now = 1000 + k * 500
      const st = clock.push((pausedFirst ? k - 1 : k) * 0.5 + 0.227, true, 'n', now)   // paused first: it starts at the 2nd push
      if (st) a.take(st, now)
      assert.equal(a.epoch, e, 'no discontinuity')
      // loop: NOT-WORTH — a test's few frames
      for (let f = 0; f < 5; f++) {
        const t = a.at(now + f * 100)
        assert.ok(t >= last - 1e-9 && t - last <= (now + f * 100 - lastAt) / 1000 * 1.01 + 0.05, 'smooth: ' + (t - last))
        last = t
        lastAt = now + f * 100
      }
    }
    assert.ok(!clock.corrections().causes['seek or stall'], JSON.stringify(clock.corrections()))
  }
})

// QC 2026-10 #1: the same song starting again (Previous more than ~3 s in, a scrub to 0:00, repeat-one)
// never waits BOUNDARY_WAIT for a song change that won't come
test('the same song restarting is a clean epoch at once; only a drop near the song\'s end holds', () => {
  const run = (upTo, info) => {
    let now = 0
    const clock = C.createSongClock({ now: () => now, epochNow: () => now })
    clock.setSong('s', 240)
    let st
    // loop: NOT-WORTH — a test's few hundred pushes
    for (let k = 0; k <= upTo * 2; k++) { now = k * 500; st = clock.push(k * 0.5, true, 's', now, info) }
    const e = st.epoch
    now += 500
    const got = clock.push(0.1, true, 's', now, info)
    return { got, e, clock }
  }
  const mid = run(60)                                   // Previous at 1:00, or a scrub back to the start
  assert.ok(mid.got && mid.got.epoch > mid.e, 'snapped at once')
  assert.ok(Math.abs(mid.clock.time() - 0.1) < 0.05)
  assert.equal(mid.clock.holding, false)
  const one = run(236, { repeatOne: true })              // repeat-one at the song's end
  assert.ok(one.got && one.got.epoch > one.e, 'repeat-one: at once')
  const end = run(236)                                  // a natural end: the next song's time before its name
  assert.equal(end.got, null, 'held for the song change')
  assert.equal(end.clock.holding, true, 'the recorder and the refiner wait while held')
})

test('main: the recorder and the refiner wait while the clock holds a drop for its song change', () => {
  const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'main.js'), 'utf8')
  assert.match(src, /songClock\.holding \? null : songClock\.snapshot\(\)/)
  assert.match(src, /repeatOne: state\.repeat === 1/)
})

// QC 2026-10 #5: freshTime ages each push by its own (jittering) age, so a frozen time never compared equal
test('a player frozen while it says playing holds the clock, no saw-tooth', () => {
  let now = 0
  const clock = C.createSongClock({ now: () => now, epochNow: () => now })
  let st
  // loop: NOT-WORTH — a test's few pushes
  for (let k = 0; k <= 20; k++) { now = k * 500; st = clock.push(k * 0.5, true, 's', now - 30) }
  const frozen = 10
  const epochs = new Set()
  const times = []
  // loop: NOT-WORTH — a test's few pushes
  for (let k = 1; k <= 12; k++) {
    now += 500
    st = clock.push(frozen, true, 's', now - 30 - (k % 3) * 7) || st   // the same time, ages jittering by ms
    if (k >= 4) { epochs.add(st.epoch); times.push(clock.time()) }
  }
  assert.equal(st.playing, false, 'a stall is detected')
  assert.equal(epochs.size, 1, 'held: no epoch bump per push')
  assert.ok(Math.max(...times) - Math.min(...times) < 0.01, 'the clock stands still: ' + times.join(','))
})

// Marcy 2026-10-19: with look-ahead the heard time comes back ~150 ms off after a pause; that was a snap (an epoch)
test('a resume after a pause goes on from where the clock stood; a small offset is slewed, never a step', () => {
  let now = 0
  const lines = []
  const clock = C.createSongClock({ now: () => now, epochNow: () => now, log: (m) => lines.push(m) })
  let st
  // loop: NOT-WORTH — a test's few pushes
  for (let k = 0; k <= 160; k++) { now = k * 500; st = clock.push(k * 0.5, true, 's', now) }
  // loop: NOT-WORTH — a test's few pushes
  for (let k = 0; k < 6; k++) { now += 500; st = clock.push(80.2, false, 's', now) || st }   // paused
  const e = st.epoch
  const held = clock.time()
  now += 500; st = clock.push(80.2 - 0.148, true, 's', now)                                   // resumed, 148 ms back
  assert.equal(st.epoch, e, 'no discontinuity')
  assert.ok(clock.time() >= held - 0.01, 'never a step back')
  // loop: NOT-WORTH — a test's few pushes
  for (let k = 1; k <= 6; k++) { now += 500; st = clock.push(80.052 + k * 0.5, true, 's', now) }
  assert.equal(st.epoch, e)
  assert.ok(!lines.some((l) => /snapped/.test(l)), lines.join(' | '))
  // a real seek while paused still snaps
  now += 500; clock.push(150, false, 's', now)
  now += 500; st = clock.push(150.3, true, 's', now)
  assert.ok(st.epoch > e)
})

// QC 2026-10 (Marcy's log, look-ahead on: "song clock: corrected 494 ms (jump…)" every minute, words jumping
// back and forth): MusicKit's whole-second time minus look-ahead's fractional heard delay was taken for a
// precise time, so the clock snapped ~0.5 s back and forth every few pushes. The player's time being whole
// seconds (info.coarse) keeps the [v, v + 1) window after the delay is taken off.
test('look-ahead with whole-second player times: no back-and-forth steps (info.coarse)', () => {
  const run = (info) => {
    let now = 1000000
    const logs = []
    const clock = C.createSongClock({ now: () => now, epochNow: () => now, log: (m) => logs.push(m) })
    clock.setSong('k', 300)
    let steps = 0; let prev = null
    // loop: NOT-WORTH — a test's 4 minutes of pushes
    for (let i = 0; i < 480; i++) {
      now += 500 + (i % 3) * 7
      const truth = (now - 1000000) / 1000 + 5
      clock.push(Math.floor(truth) - 3.0123, true, 'k', now, info)
      const shown = clock.time()
      // (the first seconds settle the start: whole seconds put it up to 1 s off, one clean step at most)
      if (prev != null && i > 10 && Math.abs(shown - prev - (500 + (i % 3) * 7) / 1000) > 0.1) steps++
      prev = shown
    }
    return { steps, logs }
  }
  assert.ok(run({}).steps > 20, 'without the flag the heard time snaps back and forth (the bug)')
  const fixed = run({ coarse: true })
  assert.equal(fixed.steps, 0)
  assert.ok(fixed.logs.length <= 1, 'at most the song start\'s correction is logged: ' + fixed.logs.join(' | '))
  const main = require('fs').readFileSync(require('path').join(__dirname, '..', 'main.js'), 'utf8')
  assert.match(main, /songClock\.push\(heard\.playbackTime, [^\n]*coarse: Number\.isInteger\(state\.playbackTime\)/, 'main says when the player\'s own time is whole seconds')
})

// 0.15.77 (Marcy 2026-10-19: the words up to ~1 s late, "corrected ~979 ms (player ahead: eased)"): whole-second
// times kept any clock inside [v, v+1) as in step, so one seeded at v stayed almost a second behind. Pushes 470 ms
// apart (main.js LYRICS_TICK_MS) land all over the second; their spans overlap to the true phase.
test('whole-second player times: the clock locks onto the true phase, not up to a second behind', () => {
  for (const frac of [0.1, 0.45, 0.7, 0.95]) {
    let now = 1000000
    const clock = C.createSongClock({ now: () => now, epochNow: () => now })
    clock.setSong('k', 300)
    let steps = 0; let prev = null; let worst = 0
    // loop: NOT-WORTH — a test's minute of pushes
    for (let i = 0; i < 130; i++) {
      const dt = 470 + (i % 3) * 3
      now += dt
      const truth = (now - 1000000) / 1000 + 5 + frac
      clock.push(Math.floor(truth), true, 'k', now, { coarse: true })
      const shown = clock.time()
      if (i > 20) worst = Math.max(worst, Math.abs(shown - truth))
      if (prev != null && i > 20 && Math.abs(shown - prev - dt / 1000) > 0.1) steps++
      prev = shown
    }
    assert.ok(worst < 0.15, frac + ': within 0.15 s of the song after the first seconds, worst ' + worst.toFixed(3))
    assert.equal(steps, 0, frac + ': once locked, no steps')
  }
  const main = require('fs').readFileSync(require('path').join(__dirname, '..', 'main.js'), 'utf8')
  assert.match(main, /const LYRICS_TICK_MS = 470\b/, 'the lyrics tick walks through the second')
})
