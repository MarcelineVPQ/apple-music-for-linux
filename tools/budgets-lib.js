// The arithmetic of the resource budgets (tools/budgets.json, docs/BUDGETS.md): CPU from /proc ticks,
// PSS from smaps_rollup, the least-squares growth over a soak, and the PASS / FAIL / INFO table.
// Pure (no Electron, no DOM): tested in test/budgets.test.js; tools/check-budgets.js does the measuring.
'use strict'

const TICKS_PER_S = 100   // Linux USER_HZ (getconf CLK_TCK); /proc/<pid>/stat utime + stime are in these

// utime + stime of one /proc/<pid>/stat line (the command name may hold spaces and parentheses)
function statTicks(stat) {
  const f = String(stat).slice(String(stat).lastIndexOf(') ') + 2).split(' ')
  return Number(f[11]) + Number(f[12])
}

// % of one core between two { pid: ticks } readings over `seconds`; pids that came or went are left out
function cpuPercent(before, after, seconds) {
  let ticks = 0
  for (const pid of Object.keys(after)) if (pid in before) ticks += Math.max(0, after[pid] - before[pid])   // loop: NOT-WORTH — a few processes
  return seconds > 0 ? (ticks / TICKS_PER_S / seconds) * 100 : 0
}

// PSS in MB from /proc/<pid>/smaps_rollup ("Pss:  12345 kB")
function pssMb(rollup) {
  const m = /^Pss:\s+(\d+)\s+kB/m.exec(String(rollup))
  return m ? Number(m[1]) / 1024 : 0
}

// least-squares slope of [{ t: seconds, v }] in v per second (0 with fewer than 2 points)
function slope(samples) {
  const n = samples.length
  if (n < 2) return 0
  let st = 0; let sv = 0
  for (const s of samples) { st += s.t; sv += s.v }   // loop: NOT-WORTH — ≤ 40 samples
  const mt = st / n; const mv = sv / n
  let num = 0; let den = 0
  for (const s of samples) { num += (s.t - mt) * (s.v - mv); den += (s.t - mt) ** 2 }   // loop: NOT-WORTH — ≤ 40 samples
  return den ? num / den : 0
}

// growth per 30 minutes from samples taken after the warm-up
const growthPer30Min = (samples) => slope(samples) * 1800

// the largest rise of a counter over a series ([n0, n1, ...]): last - first, and max - first
function counterGrowth(series) {
  if (!series.length) return { end: 0, peak: 0 }
  return { end: series[series.length - 1] - series[0], peak: Math.max(...series) - series[0] }
}

// One row per judged number. `limit` is the budget's entry: { max } (and optionally { min });
// a number without a limit is INFO; a limit without a number is SKIP (not measured in this mode).
function verdict(measured, limit) {
  if (measured === undefined || measured === null || Number.isNaN(measured)) return limit ? 'SKIP' : 'INFO'
  if (!limit) return 'INFO'
  if (limit.max !== undefined && measured > limit.max) return 'FAIL'
  if (limit.min !== undefined && measured < limit.min) return 'FAIL'
  return 'PASS'
}

// budgets.json + one run's results -> table rows { budget, state, measured, limit, unit, verdict }
// results: { cpu: { state: { judged, ... } }, frames: { state: n }, paints: { state: n },
//            memory: { judged }, listeners: { growth }, soak: { growthMb, listenerGrowth } }
function judge(budgets, results) {
  const B = budgets.budgets
  const rows = []
  const add = (budget, state, measured, limit) => rows.push({ budget, state, measured: measured === undefined ? null : +Number(measured).toFixed(2), limit: limit ? (limit.min !== undefined ? limit.min + '..' : '') + (limit.max !== undefined ? limit.max : '') : '', unit: (B[budget] || {}).unit || '', verdict: verdict(measured, limit) })
  for (const [state, lim] of Object.entries(B.hiddenCpu.states)) add('hiddenCpu', state, ((results.cpu || {})[state] || {}).judged, lim)   // loop: NOT-WORTH — a handful of states
  for (const [state, lim] of Object.entries(B.shownCpu.states)) add('shownCpu', state, ((results.cpu || {})[state] || {}).judged, lim)   // loop: NOT-WORTH — a handful of states
  for (const [state, lim] of Object.entries(B.frames.states)) add('frames', state, (results.frames || {})[state], lim)   // loop: NOT-WORTH — a handful of states
  for (const [state, lim] of Object.entries(B.repaints.states)) add('repaints', state, (results.paints || {})[state], lim)   // loop: NOT-WORTH — a handful of states
  add('memory', 'after the run, all windows closed', (results.memory || {}).judged, { max: B.memory.max })
  add('listeners', B.listeners.cycles + ' open/close cycles of every window', (results.listeners || {}).growth, { max: B.listeners.max })
  const soak = results.soak || {}
  add('growth', 'soak', soak.growthMb, results.soak ? { max: B.growth.max } : null)
  add('listenerGrowth', 'soak', soak.listenerGrowth, results.soak ? { max: B.listenerGrowth.max } : null)
  if (!results.soak) { rows[rows.length - 1].verdict = 'SKIP'; rows[rows.length - 2].verdict = 'SKIP' }
  return rows
}

function table(rows) {
  const w = [14, 34, 10, 10, 13, 7]
  const pad = (s, n) => String(s).padEnd(n)
  const head = pad('budget', w[0]) + pad('state', w[1]) + pad('measured', w[2]) + pad('limit', w[3]) + pad('unit', w[4]) + 'verdict'
  return [head, '-'.repeat(head.length)].concat(rows.map((r) => pad(r.budget, w[0]) + pad(r.state, w[1]) + pad(r.measured === null ? '-' : r.measured, w[2]) + pad(r.limit, w[3]) + pad(r.unit, w[4]) + r.verdict)).join('\n')
}

module.exports = { TICKS_PER_S, statTicks, cpuPercent, pssMb, slope, growthPer30Min, counterGrowth, verdict, judge, table }
