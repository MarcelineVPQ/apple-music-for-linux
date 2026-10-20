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

test('a correction over 100 ms is logged with its size and cause, at most once a minute', () => {
  let now = 0
  const lines = []
  const clock = C.createSongClock({ now: () => now, epochNow: () => now, log: (m) => lines.push(m) })
  // loop: NOT-WORTH — a test's few pushes
  for (; now <= 2000; now += 500) clock.push(now / 1000, true, 'k', now)
  clock.push(now / 1000 - 0.3, true, 'k', now)   // the player 300 ms behind: eased
  now += 500
  clock.push(now / 1000 - 0.3, true, 'k', now)   // again within the minute: not logged
  assert.equal(lines.length, 1)
  assert.match(lines[0], /song clock: corrected -\d+ ms \(player behind: eased, never back\)/)
  now += 61000
  clock.push(now / 1000 + 30, true, 'k', now)    // a jump: snapped
  assert.equal(lines.length, 2)
  assert.match(lines[1], /jump: a seek or a stall, snapped/)
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
  assert.ok(!lines.some((l) => /snapped/.test(l)), 'no snap logged: ' + lines.join(' | '))   // loop: NOT-WORTH — a test
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
    assert.ok(!lines.some((l) => /jump/.test(l)), lines.join(' | '))   // loop: NOT-WORTH — a test
  }
})
