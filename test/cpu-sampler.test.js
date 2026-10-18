// The one CPU sampler (cpu-sampler.js) behind About → Graphics and About → For the Curious.
'use strict'
const test = require('node:test')
const assert = require('node:assert')
const { createCpuSampler, MIN_GAP_MS, GAP_MS } = require('../cpu-sampler')

// a fake clock and app.getAppMetrics(): cumulative CPU seconds per pid
function fake() {
  let t = 0
  let list = []
  let calls = 0
  const s = createCpuSampler({ metrics: () => { calls++; return list }, now: () => t })
  const at = (ms, procs) => { t = ms; list = procs.map(([pid, type, sec]) => ({ pid, type, cpu: sec === null ? { percentUsage: 5 } : { cumulativeCPUUsage: sec, percentUsage: 99 } })) }
  return { s, at, calls: () => calls }
}
const kind = (pid, type) => (type === 'GPU' ? 'gpu' : pid === 3 ? 'page' : 'other')

test('cpu sampler: % of one core over the window, by kind; a new process counts from its first reading', () => {
  const f = fake()
  f.at(0, [[1, 'Browser', 1.0], [2, 'GPU', 0.5], [3, 'Tab', 0.1]])
  f.s.sample()
  assert.equal(f.s.over(kind), null, 'one reading: nothing to say yet')
  f.at(5000, [[1, 'Browser', 1.05], [2, 'GPU', 0.6], [3, 'Tab', 0.2], [4, 'Utility', 9.0]])
  f.s.sample()
  f.at(10000, [[1, 'Browser', 1.1], [2, 'GPU', 0.7], [3, 'Tab', 0.4], [4, 'Utility', 9.1]])
  f.s.sample()
  // 1: 0.1 s, 2: 0.2 s, 3: 0.3 s, 4: 0.1 s (from its first reading, not 9.1) over 10 s
  assert.deepEqual(f.s.over(kind), { seconds: 10, total: 7, gpu: 2, page: 3 })
})

test('cpu sampler: rates between the last two readings, per pid (For the Curious); no cumulative figure: not in the map', () => {
  const f = fake()
  f.at(0, [[1, 'Browser', 1.0], [9, 'Tab', null]])
  f.s.sample()
  assert.equal(f.s.rates().size, 0)
  f.at(5000, [[1, 'Browser', 1.05], [9, 'Tab', null], [7, 'Tab', 2.0]])
  f.s.sample()
  const r = f.s.rates()
  assert.equal(Math.round(r.get(1) * 10) / 10, 1, '0.05 s over 5 s = 1 % of one core')
  assert.equal(r.has(9), false)
  assert.equal(r.has(7), false, 'a new process has no rate yet')
})

test('cpu sampler: two sections asking within a second share one reading; a long gap starts afresh; the window keeps one older reading', () => {
  const f = fake()
  f.at(0, [[1, 'Browser', 1]])
  f.s.sample()
  f.at(MIN_GAP_MS - 1, [[1, 'Browser', 2]])
  f.s.sample()
  assert.equal(f.calls(), 1, 'the second ask reuses the reading')
  // readings every 5 s for 95 s: the window (60 s) plus the one before it
  for (let ms = 5000; ms <= 95000; ms += 5000) { f.at(ms, [[1, 'Browser', ms / 1000]]); f.s.sample() }
  assert.equal(f.s.over(kind).seconds, 65)
  // closed for a while (longer than GAP_MS): the next reading starts a new window
  f.at(95000 + GAP_MS + 1, [[1, 'Browser', 500]])
  f.s.sample()
  assert.equal(f.s.readings, 1)
  assert.equal(f.s.over(kind), null)
})
