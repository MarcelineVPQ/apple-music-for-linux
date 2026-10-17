// The resource budgets' arithmetic (tools/budgets-lib.js) and the budgets file itself (tools/budgets.json):
// what tools/check-budgets.js judges with. The measuring needs a display and runs on an isolated copy
// (docs/BUDGETS.md); this is the part that runs everywhere.
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')
const L = require('../tools/budgets-lib')
const SI = require('../tools/stand-in')

const BUDGETS = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'tools', 'budgets.json'), 'utf8'))

test('statTicks: utime + stime, even with spaces and parentheses in the command name', () => {
  const stat = '4242 (electron (zygote) x) S 1 2 3 4 5 6 7 8 9 10 120 30 0 0 20 0 1 0'
  assert.equal(L.statTicks(stat), 150)
})

test('cpuPercent: % of one core; processes that came or went are left out', () => {
  assert.equal(L.cpuPercent({ 1: 100, 2: 50 }, { 1: 150, 2: 50, 3: 999 }, 10), 5)   // 50 ticks = 0.5 s over 10 s
  assert.equal(L.cpuPercent({ 1: 100 }, { 1: 100 }, 10), 0)
  assert.equal(L.cpuPercent({}, {}, 0), 0)
})

test('pssMb: from smaps_rollup', () => {
  assert.equal(L.pssMb('Rss:   20480 kB\nPss:   10240 kB\nPss_Anon: 5 kB'), 10)
  assert.equal(L.pssMb('nothing here'), 0)
})

test('growth: a least-squares slope per 30 minutes, one noisy sample cannot fail it', () => {
  const flat = Array.from({ length: 30 }, (_, i) => ({ t: 300 + i * 60, v: 400 + (i === 14 ? 25 : 0) }))
  assert.ok(Math.abs(L.growthPer30Min(flat)) < 1, 'one spike: ' + L.growthPer30Min(flat))
  const leak = Array.from({ length: 30 }, (_, i) => ({ t: i * 60, v: 400 + i * 0.5 }))   // 0.5 MB a minute
  assert.ok(Math.abs(L.growthPer30Min(leak) - 15) < 1e-9)
  assert.equal(L.slope([{ t: 0, v: 1 }]), 0)
})

test('counterGrowth: last - first, and the peak', () => {
  assert.deepEqual(L.counterGrowth([10, 12, 10]), { end: 0, peak: 2 })
  assert.deepEqual(L.counterGrowth([10, 11, 13]), { end: 3, peak: 3 })
  assert.deepEqual(L.counterGrowth([]), { end: 0, peak: 0 })
})

test('verdict: PASS / FAIL against max and min; INFO without a limit; SKIP when not measured', () => {
  assert.equal(L.verdict(1, { max: 2 }), 'PASS')
  assert.equal(L.verdict(3, { max: 2 }), 'FAIL')
  assert.equal(L.verdict(1, { min: 2, max: 5 }), 'FAIL')
  assert.equal(L.verdict(1, null), 'INFO')
  assert.equal(L.verdict(undefined, { max: 2 }), 'SKIP')
})

test('judge: one row per state and budget; the soak rows are SKIP in quick mode', () => {
  const states = Object.keys(BUDGETS.budgets.shownCpu.states)
  const results = { cpu: {}, frames: {}, paints: {}, memory: { judged: 1 }, listeners: { growth: 0 } }
  for (const s of states.concat(Object.keys(BUDGETS.budgets.hiddenCpu.states))) results.cpu[s] = { judged: 0 }
  for (const s of Object.keys(BUDGETS.budgets.frames.states)) results.frames[s] = 0
  for (const s of Object.keys(BUDGETS.budgets.repaints.states)) results.paints[s] = 0
  const rows = L.judge(BUDGETS, results)
  assert.equal(rows.filter((r) => r.verdict === 'FAIL').length, 0)
  assert.deepEqual(rows.filter((r) => r.verdict === 'SKIP').map((r) => r.budget), ['growth', 'listenerGrowth'])
  results.listeners.growth = 3
  assert.equal(L.judge(BUDGETS, results).find((r) => r.budget === 'listeners').verdict, 'FAIL')
  assert.match(L.table(rows), /budget\s+state\s+measured/)
})

test('budgets.json: every budget has a unit and a reason; every state limit is a number; both modes complete', () => {
  for (const [k, b] of Object.entries(BUDGETS.budgets)) {
    assert.ok(b.unit && b.what, k)
    if (b.states) for (const [s, lim] of Object.entries(b.states)) assert.ok(Number.isFinite(lim.max), k + ' ' + s)
    else assert.ok(Number.isFinite(b.max), k)
  }
  // the states the frame, repaint and CPU budgets judge are the same set (one list of states)
  const shown = Object.keys(BUDGETS.budgets.shownCpu.states).sort()
  assert.deepEqual(Object.keys(BUDGETS.budgets.frames.states).sort(), shown)
  assert.deepEqual(Object.keys(BUDGETS.budgets.repaints.states).sort(), shown)
  for (const m of ['quick', 'soak']) for (const k of ['settleS', 'cpuS', 'framesS', 'traceS', 'hiddenSettleS', 'hiddenS', 'soakWarmupS', 'soakS', 'sampleS']) assert.ok(Number.isFinite(BUDGETS.modes[m][k]), m + ' ' + k)
  assert.equal(BUDGETS.modes.soak.soakS, 1800, 'the soak is 30 minutes')
})

test('stand-in tracks: word-timed TTML the real parser reads (two singers, background vocals, an interlude)', () => {
  const { parseTtml } = require('../lyrics-sources')
  for (const tr of SI.tracks()) {
    const lines = parseTtml(tr.ttml)
    assert.ok(lines.length >= 8, tr.name + ' ' + lines.length)
    assert.ok(lines.every((l) => l.words && l.words.length >= 5 && l.end <= tr.duration))
    assert.ok(lines.some((l) => l.agent === 'v2') && lines.some((l) => l.bg && l.bg.length))
    assert.ok(lines.some((l, i) => i && l.t - lines[i - 1].end >= 10), 'an interlude')
    assert.match(tr.art, /^data:image\/png;base64,/)
  }
  assert.match(SI.installScript({ playing: true }), /MusicKit\.getInstance = \(\) => mk/)
})
