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
  c = T.syncClock(c, 11.1, true, 1000)            // 0.1 s off: keep the smooth clock
  assert.equal(T.clockTime(c, 1000), 11)
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
