// 0.15.85 (player-time.js): the song's precise time when MusicKit gives whole seconds and the page's media element
// runs on another timeline. Marcy's song reports 2026-10-20: "whole seconds" after most song changes ("Brother",
// "No Excuses", "Sludge Factory", "Down In a Hole"), with up to 2 s steps in their first seconds.
'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const P = require('../player-time')

// a song playing for secs at 470 ms reads; MusicKit floors the song time; the element runs `off` s from it
function play(secs, off, opts = {}) {
  const pt = P.createPlayerTime()
  const phase = opts.phase || 0
  const out = []
  // loop: NOT-WORTH — a test's reads
  for (let k = 0; k * 0.47 < secs; k++) {
    const t = phase + k * 0.47
    const els = opts.els ? opts.els(t) : [[t + off, 0]]
    out.push({ t, r: pt.read({ key: 'a', mk: Math.floor(t), els }) })
  }
  return out
}

test('an element on its own timeline: its offset is learned, then its precise time (within 60 ms)', () => {
  // loop: NOT-WORTH — offsets and phases
  for (const off of [512.37, 1834.9, 3.2]) {
    for (const phase of [0, 0.2, 0.71]) {
      const out = play(12, off, { phase })
      const early = out.slice(0, 3)
      assert.ok(early.every((x) => x.r.coarse), 'not trusted on a read or two: MusicKit\'s whole seconds')
      const late = out.filter((x) => x.t > 8)
      assert.ok(late.every((x) => !x.r.coarse && x.r.via === 'offset'), 'off ' + off + ' phase ' + phase + ': locked by 8 s')
      assert.ok(late.every((x) => Math.abs(x.r.t - x.t) <= 0.06), 'off ' + off + ' phase ' + phase + ': worst ' + Math.max(...late.map((x) => Math.abs(x.r.t - x.t))).toFixed(3))
    }
  }
})

test('an element agreeing with MusicKit is used at once (the old rule); a paused one never', () => {
  const out = play(3, 0)
  assert.ok(out.slice(1).every((x) => !x.r.coarse && x.r.via === 'element' && Math.abs(x.r.t - x.t) < 1e-9))
  const paused = play(10, 512.37, { els: (t) => [[t + 512.37, 1]] })
  assert.ok(paused.every((x) => x.r.coarse), 'a paused element is not the playing one')
  // two elements: the old song's (paused) and the playing one on its own timeline
  const two = play(12, 0, { els: (t) => [[200.5, 1], [t + 777.77, 0]] })
  assert.ok(two.filter((x) => x.t > 8).every((x) => x.r.via === 'offset' && Math.abs(x.r.t - x.t) <= 0.06))
})

test('MusicKit precise already: as it is; a new song or a seek on the element starts the estimate over', () => {
  const pt = P.createPlayerTime()
  assert.deepEqual(pt.read({ key: 'a', mk: 12.34, els: [[900, 0]] }), { t: 12.34, coarse: false, via: '' })
  // locked, then the element's timeline jumps (a seek): whole seconds again until it is learned anew, never a wrong time
  const pt2 = P.createPlayerTime()
  let t = 0
  // loop: NOT-WORTH — a test's reads
  for (; t < 10; t += 0.47) pt2.read({ key: 'a', mk: Math.floor(t), els: [[t + 300.4, 0]] })
  const after = []
  // loop: NOT-WORTH — a test's reads
  for (let k = 0; k < 20; k++, t += 0.47) after.push({ t, r: pt2.read({ key: 'a', mk: Math.floor(t), els: [[t + 120.15, 0]] }) })
  assert.ok(after.every((x) => x.r.coarse || Math.abs(x.r.t - x.t) <= 0.06), 'never the old offset on the new timeline')
  assert.ok(after.slice(-3).every((x) => !x.r.coarse), 'learned again')
  // a new song: the old estimate is dropped
  const r = pt2.read({ key: 'b', mk: 0, els: [[555.5, 0]] })
  assert.equal(r.coarse, true)
})

test('main: the page sends MusicKit\'s time and the elements; the tick reads the song time through player-time.js', () => {
  const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'main.js'), 'utf8')
  assert.match(src, /mkTime: mk\.currentPlaybackTime \|\| 0,/)
  assert.match(src, /els: \[\.\.\.document\.querySelectorAll\('audio, video'\)\]/)
  assert.match(src, /const pt = playerTime\.read\(/)
  assert.match(src, /coarse: state\.coarseTime != null \? state\.coarseTime : Number\.isInteger\(state\.playbackTime\)/)
})
