// Settings → Experimental at run time (main process only): the start-up decision before 'ready', the
// start marker, the GPU-crash handler and About → Graphics' readout. The rules are gfx-model.js (pure,
// tested); this file only does the Electron and file work around them, so main.js calls four things:
//   const gfx = createGfx({ app, … }); gfx.beforeReady()     at module load, before 'ready'
//   gfx.ready({ … })                                           in 'ready', after the settings are loaded
//   gfx.painted()                                              when the main window's first page loaded
//   gfx.snapshot() / gfx.readout(open, appleWC)                the panel's state, About → Graphics
// Docs: docs/research/hdr-hw-accel-apple-music-2026-10.md section 5.
const M = require('./gfx-model')

const HEALTHY_MS = 20 * 1000     // a start counts as healthy 20 s after its first page loaded
const SAMPLE_MS = 5 * 1000       // About → Graphics: one /proc sample every 5 s while it is open
const WINDOW_MS = 60 * 1000      // ... averaged over the last minute

function createGfx(o) {
  const { app, fs, path } = o
  const settingsStore = o.settingsStore
  const log = o.log || ((m) => console.log(m))
  const extra = o.extra || {}        // per-switch runtime parts (hdr screens, decode probe), added by later steps
  let start = { safe: false, active: [], inactive: {}, switches: [], line: '' }
  let ctx = M.startContext({ platform: process.platform, argv: process.argv, env: process.env })
  let atStart = { disable: [], notice: '' }
  let sentinelFile = ''
  let hooks = null
  let crashed = false
  let healthTimer = null
  let healthyAt = 0
  let samples = []
  let sampleTimer = null
  let readoutOpen = false
  let cpu = null

  // Before 'ready': read the settings file (read-only: main's loadSettings repairs it later), look for a
  // start marker left by a start that never got healthy, decide the switches, write the new marker.
  function beforeReady() {
    const dir = app.getPath('userData')
    sentinelFile = path.join(dir, 'gpu-experiment.json')
    let stored = {}
    try { stored = settingsStore.fromStored(JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8'))).settings } catch (e) {
      stored = settingsStore.defaults()   // error: NOT-WORTH — no settings file (first start) or an unreadable one: every switch is off (the default)
    }
    let marker = null
    try { marker = fs.readFileSync(sentinelFile, 'utf8') } catch (e) { marker = null }   // error: NOT-WORTH — no marker: the last start was healthy (or had no switch on)
    // --safe-gpu: no switches and no changes to the settings; the marker stays for a normal start to read
    atStart = ctx.safe ? { disable: [], notice: '' } : M.sentinelAtStart(marker, stored)
    const s = Object.assign({}, stored)
    // loop: NOT-WORTH — ≤ 4 switches, once at start
    for (const k of atStart.disable) s[k] = false
    start = M.startFlags(s, { platform: process.platform, argv: process.argv, env: process.env })
    // loop: NOT-WORTH — ≤ 4 switches, once at start
    for (const [name, value] of start.switches) {
      if (value) app.commandLine.appendSwitch(name, value)
      else app.commandLine.appendSwitch(name)
    }
    log(start.line)
    writeMarker()
    return start
  }
  // the marker exists exactly while an active switch hasn't had a healthy start yet
  function writeMarker() {
    if (ctx.safe) return
    try {
      if (start.active.length) {
        fs.mkdirSync(path.dirname(sentinelFile), { recursive: true })
        fs.writeFileSync(sentinelFile + '.tmp', M.sentinelText(start.active, app.getVersion(), Date.now()))
        fs.renameSync(sentinelFile + '.tmp', sentinelFile)
      } else fs.rmSync(sentinelFile, { force: true })
    } catch (e) { log('[gpu] start marker: ' + e.message) }   // error: LOGGED-OK — no marker means no safety net for this one start; said in the log
  }
  function clearMarker(why) {
    if (ctx.safe || !start.active.length) return
    try { fs.rmSync(sentinelFile, { force: true }) } catch (e) { log('[gpu] start marker: ' + e.message) }   // error: LOGGED-OK — a marker left behind turns the switches off at the next start, the safe side
    log('[gpu] start marker removed: ' + why)
  }

  // In 'ready', with main's settings loaded. h: { settings() -> object, turnOff(key), notify(id, text), changed() }
  function ready(h) {
    hooks = h
    // the marker named switches: they are off in this start already; now off in the settings too, said once
    if (atStart.disable.length) {
      // loop: NOT-WORTH — ≤ 4 switches, once at start
      for (const k of atStart.disable) hooks.turnOff(k)
      hooks.notify('gfx-start', atStart.notice)
      log('[gpu] the last start with ' + atStart.disable.join(', ') + ' never got healthy: turned off')
    }
    // lifetime: NOT-WORTH — registered once, for the app's life
    app.on('child-process-gone', (event, details) => {
      if (!details || details.type !== 'GPU') return
      log('[gpu] graphics process gone: ' + details.reason + ' (exit ' + details.exitCode + ')')
      const off = M.crashTurnOff(details, start.active, hooks.settings())
      if (!off) return
      crashed = true
      hooks.turnOff(off.key)
      hooks.notify('gfx-crash', off.notice)
      clearMarker('handled a graphics crash (' + off.key + ' off for the next start)')
      hooks.changed()
    })
  }
  // the main window's first page loaded: 20 s later, with no graphics crash, the start was healthy
  function painted() {
    if (healthTimer || healthyAt) return
    // lifetime: OK — one shot, cleared at quit (stop)
    healthTimer = setTimeout(() => {
      healthTimer = null
      healthyAt = Date.now()
      if (!crashed) clearMarker('healthy for ' + HEALTHY_MS / 1000 + ' s')
    }, HEALTHY_MS)
  }

  // what the panel shows: per switch whether it can work here, what the next start changes, the readout
  function snapshot(gpuStatus) {
    const s = hooks ? hooks.settings() : {}
    const gpuOn = !gpuStatus || /^enabled/.test(String(gpuStatus.gpu_compositing || ''))
    const blocked = {}
    const note = {}
    // loop: NOT-WORTH — ≤ 4 switches per panel snapshot
    for (const e of M.EXPERIMENTS) {
      const why = !ctx.linux ? 'not-linux' : (!gpuOn || ctx.gpuOff) && e.restart ? 'gpu-off' : e.blocked ? e.blocked(ctx) : null
      if (why) { blocked[e.key] = M.reasonText(why); continue }
      if (!e.restart) continue
      const on = s[e.key] === true
      const used = start.active.includes(e.key)
      const idle = start.inactive[e.key]
      if (on && used) note[e.key] = 'On now.'
      else if (on && idle) note[e.key] = 'Not used this start: ' + M.reasonText(idle).replace(/^Off for this start: /, '') + '.'
      else if (on) note[e.key] = 'Applies at restart.'
      else if (used || idle) note[e.key] = 'Off after a restart.'
    }
    return {
      keys: M.EXPERIMENTS.map((e) => e.key),
      safe: start.safe,
      active: start.active.slice(),
      pending: M.pendingRestart(s, start),
      blocked,
      note,
      rows: readoutOpen ? M.graphicsRows(Object.assign({ gpu: gpuStatus, start, settings: s, cpu, x11: ctx.x11 }, readoutExtra())) : []
    }
  }
  function readoutExtra() {
    const out = {}
    // loop: NOT-WORTH — the few runtime parts (≤ 3)
    for (const k of Object.keys(extra)) if (extra[k].readout) out[k] = extra[k].readout()
    return out
  }

  // About → Graphics open or closed: /proc samples every 5 s only while it shows (no background polling)
  // pids(): [{ pid, kind: 'gpu' | 'page' | 'other' }]
  function readout(open, pids) {
    if (open === readoutOpen) return
    readoutOpen = open
    clearInterval(sampleTimer)
    sampleTimer = null
    samples = []
    cpu = null
    if (!open) return
    // loop: NOT-WORTH — one /proc read of Sonata's ~10 processes every 5 s, only while About → Graphics shows
    const take = () => {
      const ticks = {}
      for (const p of pids()) {
        try {
          const n = M.statTicks(fs.readFileSync('/proc/' + p.pid + '/stat', 'utf8'))
          if (n !== null) ticks[p.pid] = { kind: p.kind, ticks: n }
        } catch (e) { /* error: NOT-WORTH — a process that just ended: left out of this sample */ }
      }
      const now = Date.now()
      samples = M.trimSamples(samples.concat([{ t: now, ticks }]), now, WINDOW_MS)
      cpu = M.cpuOver(samples, 100)
      if (hooks) hooks.changed()
    }
    take()
    // lifetime: OK — cleared when About → Graphics closes (above) and at quit (stop)
    sampleTimer = setInterval(take, SAMPLE_MS)
    // loop: NOT-WORTH — the runtime parts' own probes (≤ 3), once per open
    for (const k of Object.keys(extra)) if (extra[k].probe) extra[k].probe(() => { if (hooks) hooks.changed() })
  }
  function stop() {
    clearTimeout(healthTimer); healthTimer = null
    clearInterval(sampleTimer); sampleTimer = null
  }
  return { beforeReady, ready, painted, snapshot, readout, stop, get start() { return start }, get context() { return ctx } }
}

module.exports = { createGfx, HEALTHY_MS }
