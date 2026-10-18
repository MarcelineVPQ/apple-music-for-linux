// The visualizer freezes while paused (Marcy, 2026-10-16): no requestAnimationFrame and no frames until
// playback resumes; a short settle after the pause; a scene change or resize while frozen redraws once;
// resuming takes no time step across the pause.
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')
const { createFrameGate, SETTLE_MS, STALE_MS } = require('../viz-frames')

// a fake display: rAF callbacks queue up, tick() runs one frame 16 ms later
function display() {
  let t = 0
  let queue = []
  const d = {
    now: () => t,
    raf: (cb) => { queue.push(cb) },
    get pending() { return queue.length },
    tick() { t += 16; const q = queue; queue = []; for (const cb of q) cb() },
    run(ms) { const end = t + ms; while (t < end) { if (queue.length) d.tick(); else t = end } },
    advance(ms) { t += ms }
  }
  return d
}

test('draws while playing; on pause it settles, then requests no frames at all', () => {
  const d = display()
  let drawn = 0
  const g = createFrameGate({ draw: () => drawn++, raf: d.raf, now: d.now })
  g.setPlaying(true)
  d.run(400)
  assert.ok(drawn >= 24, 'frames while playing: ' + drawn)
  // loop: 2 pushes/s while the song plays · test only
  for (let i = 0; i < 4; i++) { g.setPlaying(true); d.run(500) }
  const playing = drawn
  assert.ok(playing >= 140, 'kept drawing with fresh pushes: ' + playing)
  g.setPlaying(false)
  d.run(SETTLE_MS + 100)
  const settled = drawn - playing
  assert.ok(settled >= 25 && settled <= 40, 'a short settle after the pause: ' + settled)
  assert.equal(d.pending, 0, 'no frame requested once frozen')
  assert.equal(g.running, false)
  // still paused: pushes keep coming at 2/s, nothing draws
  const frozen = drawn
  // loop: 20 paused pushes · test only
  for (let i = 0; i < 20; i++) { g.setPlaying(false); d.run(500) }
  assert.equal(drawn, frozen, 'paused for 10 s: 0 frames')
  assert.equal(d.pending, 0)
})

test('resumes smoothly: onResume once (no time step across the pause), then frames again', () => {
  const d = display()
  let drawn = 0
  let resumed = 0
  const g = createFrameGate({ draw: () => drawn++, raf: d.raf, now: d.now, onResume: () => resumed++ })
  g.setPlaying(true)
  d.run(300)
  g.setPlaying(false)
  d.run(2000)
  assert.equal(d.pending, 0)
  const before = drawn
  g.setPlaying(true)
  assert.equal(resumed, 1)
  d.run(300)
  assert.ok(drawn - before >= 17, 'drawing again: ' + (drawn - before))
  g.setPlaying(true)   // a push while already running: no second resume
  assert.equal(resumed, 1)
})

test('a pause and resume inside the settle keeps going without a resume step', () => {
  const d = display()
  let resumed = 0
  const g = createFrameGate({ draw: () => {}, raf: d.raf, now: d.now, onResume: () => resumed++ })
  g.setPlaying(true)
  d.run(200)
  g.setPlaying(false)
  d.run(100)
  g.setPlaying(true)
  assert.equal(resumed, 0, 'never stopped, so nothing to resume')
  assert.ok(d.pending > 0)
})

test('frozen: a scene change or resize draws one settle, then stops again', () => {
  const d = display()
  let drawn = 0
  const g = createFrameGate({ draw: () => drawn++, raf: d.raf, now: d.now })
  g.setPlaying(false)
  d.run(SETTLE_MS + 200)
  assert.equal(d.pending, 0)
  const before = drawn
  g.kick()
  d.run(SETTLE_MS + 200)
  assert.ok(drawn - before >= 25 && drawn - before <= 40, 'one settle: ' + (drawn - before))
  assert.equal(d.pending, 0)
})

test('pushes stop (nothing playing on Apple\'s page): it freezes after STALE_MS; before the first push it draws a while', () => {
  const d = display()
  let drawn = 0
  const g = createFrameGate({ draw: () => drawn++, raf: d.raf, now: d.now })
  d.run(STALE_MS + 200)
  assert.equal(d.pending, 0, 'no push at all: stops')
  assert.ok(drawn > 0, 'the first frames are drawn')
  g.setPlaying(true)
  d.run(STALE_MS + 300)
  assert.equal(d.pending, 0, 'one push and then silence: stops')
})

test('visualizer.html: the render loop runs through the gate, fed by the playing flag', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'visualizer.html'), 'utf8')
  assert.match(html, /createFrameGate\(\{ draw: frame/)
  assert.match(html, /ipcRenderer\.on\('lyrics-time', \(e, t, playing, key\) => \{ lyricsView\.setTime\(t, playing, key\); gate\.setPlaying\(!!playing\) \}\)/)
  assert.doesNotMatch(html, /requestAnimationFrame\(frame\)/, 'no free-running loop')
  assert.match(html, /function setMode[\s\S]*?gate\.kick\(\)/, 'a scene change while frozen redraws')
  assert.match(html, /if \(gate\) gate\.kick\(\)/, 'a resize while frozen redraws')
  assert.match(html, /onResume: \(\) => \{ toast\.last = 0 \}/)
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'))
  assert.ok(pkg.build.files.includes('viz-frames.js'), 'packaged (build.files is an explicit list)')
})
