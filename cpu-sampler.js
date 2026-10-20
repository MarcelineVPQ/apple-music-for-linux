// One CPU sampler for About → Graphics and About → For the Curious (main process). Both read Sonata's
// processes from app.getAppMetrics(): its cumulative CPU seconds per process (cumulativeCPUUsage), so
// one reader can't skew the other (percentUsage is "since the last call") and it works on every
// platform (no /proc). It never runs on its own: each section asks for a reading at its own refresh while
// it shows (gfx-runtime.js readout, curious-sampler.js), and two asks within MIN_GAP_MS share one reading.
// It keeps the last WINDOW_MS of readings (and the one before, so the window is full); after a gap longer
// than GAP_MS (both sections closed) it starts afresh, so a reopened section never averages over the gap.
// Electron-free: deps.metrics and deps.now are stubs in test/cpu-sampler.test.js.
'use strict'

const WINDOW_MS = 60 * 1000
const MIN_GAP_MS = 1000
const GAP_MS = 15 * 1000

/**
 * deps: { metrics() -> app.getAppMetrics(), now() -> ms }
 *   sample()       a reading now (or the one taken < MIN_GAP_MS ago) -> the metrics list it read
 *   rates()        Map pid -> % of one core between the last two readings (a new process, or one without
 *                  cumulative seconds: not in the map)
 *   over(kindOf)   { seconds, total, gpu, page } in % of one core over the window, by kindOf(pid, type)
 *                  ('gpu' | 'page' | other); null with fewer than 2 readings
 */
function createCpuSampler(deps) {
  const windowMs = deps.windowMs || WINDOW_MS
  // cache: OK — key=reading time; invalidated=pruned to WINDOW_MS (+1) per sample, reset after a 15 s gap; bound=≤ ~61 readings
  let readings = []     // [{ t, list, procs: Map pid -> { type, s } }]

  function sample() {
    const t = deps.now()
    const last = readings[readings.length - 1]
    if (last && t - last.t < MIN_GAP_MS) return last.list
    if (last && t - last.t > GAP_MS) readings = []
    const list = deps.metrics() || []
    const procs = new Map()
    // loop: NOT-WORTH — Sonata's processes (≤ ~12), per reading while a section that shows CPU is open
    for (const m of list) {
      const s = m.cpu && Number.isFinite(m.cpu.cumulativeCPUUsage) ? m.cpu.cumulativeCPUUsage : null
      if (s !== null) procs.set(m.pid, { type: m.type, s })
    }
    readings.push({ t, list, procs })
    const keep = readings.filter((x) => t - x.t <= windowMs)
    const older = readings.filter((x) => t - x.t > windowMs)
    readings = older.length ? [older[older.length - 1]].concat(keep) : keep
    return list
  }

  function rates() {
    const out = new Map()
    if (readings.length < 2) return out
    const a = readings[readings.length - 2]
    const b = readings[readings.length - 1]
    const secs = (b.t - a.t) / 1000
    if (!(secs > 0)) return out
    // loop: NOT-WORTH — Sonata's processes (≤ ~12), per refresh
    for (const [pid, p] of b.procs) {
      const q = a.procs.get(pid)
      if (q) out.set(pid, Math.max(0, (p.s - q.s) / secs * 100))
    }
    return out
  }

  function over(kindOf) {
    if (readings.length < 2) return null
    const a = readings[0]
    const b = readings[readings.length - 1]
    const secs = (b.t - a.t) / 1000
    if (!(secs > 0)) return null
    const per = { total: 0, gpu: 0, page: 0 }
    // loop: NOT-WORTH — Sonata's processes (≤ ~12), per reading while About → Graphics is open
    for (const [pid, p] of b.procs) {
      const q = a.procs.get(pid)
      // a process that started inside the window counts from its first reading in it
      const first = q ? q.s : firstSeen(pid)
      const pct = Math.max(0, p.s - first) / secs * 100
      const kind = kindOf(pid, p.type)
      per.total += pct
      if (kind === 'gpu') per.gpu += pct
      if (kind === 'page') per.page += pct
    }
    const r = (x) => Math.round(x * 10) / 10
    return { seconds: Math.round(secs), total: r(per.total), gpu: r(per.gpu), page: r(per.page) }
  }
  function firstSeen(pid) {
    // loop: NOT-WORTH — ≤ 13 readings in the window
    for (const x of readings) { const p = x.procs.get(pid); if (p) return p.s }
    return 0
  }

  return { sample, rates, over, get readings() { return readings.length } }
}

module.exports = { WINDOW_MS, MIN_GAP_MS, GAP_MS, createCpuSampler }
