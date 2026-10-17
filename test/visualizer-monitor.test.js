// The visualizer's fallback capture (visualizer.js startMonitor: parec on the whole-system monitor): if it
// ends on its own it restarts with a backoff and shows silence meanwhile; when it can't recover, the
// visualizer is told ('lost' / 'missing') instead of freezing on the last frame.
const test = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('events')
const { Visualizer, BANDS, RESTART_MS, HEALTHY_MS } = require('../visualizer')

function harness() {
  const h = { procs: [], timers: [], states: [], frames: [], t: 0 }
  h.spawn = () => {
    const p = new EventEmitter()
    p.stdout = new EventEmitter()
    p.killed = false
    p.kill = () => { p.killed = true; p.emit('exit', null, 'SIGTERM') }
    h.procs.push(p)
    return p
  }
  h.viz = new Visualizer((b) => h.frames.push(b), {
    onState: (s) => h.states.push(s),
    spawn: h.spawn,
    monitor: () => 'test.monitor',
    setTimeout: (fn, ms) => { const t = { fn, ms, done: false }; h.timers.push(t); return t },
    clearTimeout: (t) => { t.done = true },
    now: () => h.t
  })
  h.fire = () => { const t = h.timers.find((x) => !x.done); t.done = true; t.fn(); return t.ms }
  h.audio = () => h.procs[h.procs.length - 1].stdout.emit('data', Buffer.alloc(4096))
  return h
}

test('a parec that ends is restarted after 1, 2, 4, 8, 16 s, then the visualizer says it has no sound', () => {
  const h = harness()
  h.viz.startMonitor()
  assert.equal(h.procs.length, 1)
  const waits = []
  // loop: NOT-WORTH — test: every backoff step
  for (let i = 0; i < RESTART_MS.length; i++) {
    h.procs[h.procs.length - 1].emit('exit', 1, null)
    assert.equal(h.viz.proc, null)
    assert.equal(h.states[h.states.length - 1], 'restarting')
    waits.push(h.fire())
    assert.equal(h.procs.length, i + 2)
  }
  assert.deepEqual(waits, RESTART_MS)
  h.procs[h.procs.length - 1].emit('exit', 1, null)
  assert.equal(h.states[h.states.length - 1], 'lost')
  assert.equal(h.timers.filter((t) => !t.done).length, 0, 'no further restart')
  // every end showed silence (the bars fall), not the last frame frozen
  assert.ok(h.frames.length >= RESTART_MS.length + 1)
  assert.deepEqual(h.frames[h.frames.length - 1], new Array(BANDS).fill(0))
})

test('audio again clears the note; a run that stayed healthy starts the backoff over', () => {
  const h = harness()
  h.viz.startMonitor()
  h.procs[0].emit('exit', 1, null)
  h.fire()
  h.audio()
  assert.deepEqual(h.states, ['restarting', ''])
  assert.equal(h.viz.restarts, 1)
  h.t += HEALTHY_MS
  h.audio()
  assert.equal(h.viz.restarts, 0)
  h.procs[1].emit('exit', 1, null)
  assert.equal(h.fire(), RESTART_MS[0])
})

test('no parec installed: no retries, the visualizer says so', () => {
  const h = harness()
  h.viz.startMonitor()
  const e = Object.assign(new Error('spawn parec ENOENT'), { code: 'ENOENT' })
  h.procs[0].emit('error', e)
  h.procs[0].emit('exit', -2, null)   // either order, handled once
  assert.deepEqual(h.states, ['missing'])
  assert.equal(h.timers.length, 0)
})

test('spawn throwing is retried like an ended capture', () => {
  const h = harness()
  let n = 0
  const real = h.viz.spawn
  h.viz.spawn = (...a) => { if (n++ === 0) throw new Error('EACCES'); return real(...a) }
  h.viz.startMonitor()
  assert.deepEqual(h.states, ['restarting'])
  h.fire()
  assert.equal(h.procs.length, 1)
})

test('stop() kills it without a restart and cancels a pending one; startMonitor never doubles up', () => {
  const h = harness()
  h.viz.startMonitor()
  h.viz.startMonitor()
  assert.equal(h.procs.length, 1)
  h.viz.stop()
  assert.ok(h.procs[0].killed)
  assert.equal(h.timers.length, 0, 'the kill is not restarted')
  const h2 = harness()
  h2.viz.startMonitor()
  h2.procs[0].emit('exit', 1, null)
  h2.viz.startMonitor()                 // a tick while the restart is pending
  assert.equal(h2.procs.length, 1)
  h2.viz.stop()
  assert.ok(h2.timers[0].done, 'the pending restart is cancelled')
  assert.equal(h2.viz.fallback, false)
})
