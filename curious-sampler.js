// About → For the Curious, the collecting side (curious-model.js turns what it collects into rows).
// It runs ONLY while the section is open and the main window shown (main.js curiousSync): nothing
// polls at rest. On open it reads everything once; then every REFRESH_MS it samples again, the library
// (the whole lyrics cache and the cache files' sizes) only every LIBRARY_EVERY refreshes.
//
// Each refresh (cost measured on the isolated copy, docs/PERFORMANCE.md "For the Curious"):
//   - frames: each shown Sonata window's and Apple's page's new frames for FRAME_MS
//     (webContents.beginFrameSubscription, dirty frames only; ended after the window)
//   - CPU and memory: app.getAppMetrics() (cumulative CPU seconds, so another caller can't skew it)
//   - the song: one executeJavaScript in Apple's page (the lyrics feed's now-playing script), its
//     lyrics-cache entries (peek: the cache's order is untouched) and its sung-notes log file, if any
//   - Linux: one `pactl -f json list sink-inputs` (Sonata's own stream's format), and `nvidia-smi
//     --query-compute-apps` only while the helper runs (its graphics memory)
// Electron-free: deps carry every Electron call (tested with stubs, test/curious.test.js).
'use strict'
const path = require('path')
const fsMod = require('fs')
const C = require('./curious-model')

// "2026-10-17 20:31:05" in the PC's own time zone
function localStamp(d) {
  const p = (n) => String(n).padStart(2, '0')
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds())
}

const REFRESH_MS = 5000
const FRAME_MS = 1000
const LIBRARY_EVERY = 12     // the library once a minute while open

/**
 * deps: {
 *   metrics() -> app.getAppMetrics()      views() -> [{ name, wc, shown }]   (Sonata's views and Apple's page)
 *   nowPlaying() -> Promise<{ ok, title, artist, isPlaying }>   store: { peek, entries }   track() -> lyrics-feed facts
 *   settings() -> { estimate, precise, listen, installed, dev }   files() -> library file sizes (on library refreshes)
 *   notesDir() -> the sung notes log folder | null   helper() -> { installed, running, pid, paused }
 *   execFile(cmd, args, opts, cb)   platform   pid   versions() -> [[label, value]]
 *   push(data)   now() (ms)   date() -> Date   setTimeout / clearTimeout   log
 * }
 */
function createCuriousSampler(deps) {
  const setT = deps.setTimeout || setTimeout
  const clearT = deps.clearTimeout || clearTimeout
  const io = deps.fs || fsMod
  let open = false
  let gen = 0              // bumps on close: a refresh still running for an earlier open is dropped
  let timer = null
  let ticks = 0
  let lastCpu = new Map()  // pid -> { s: cumulative CPU seconds, at: ms }
  let library = null
  let notesCache = { name: '', mtime: 0, doc: null }
  let data = null
  let copied = ''

  // frames of each shown view for ms: [{ name, pid, fps | null }]
  function frames(views, ms) {
    const subs = []
    // loop: NOT-WORTH — Sonata's shown views (≤ ~8), once per refresh while For the Curious is open
    for (const v of views) {
      const rec = { name: v.name, pid: v.pid, n: 0, ok: false }
      if (v.shown) {
        // error: NOT-WORTH — a view that can't be subscribed (destroyed meanwhile, no compositor) shows no frame count
        try { v.wc.beginFrameSubscription(true, () => { rec.n++ }); rec.ok = true; rec.wc = v.wc } catch (e) { rec.ok = false }
      }
      subs.push(rec)
    }
    return new Promise((resolve) => {
      // lifetime: OK — a one-shot frame window per refresh; every subscription ends when it fires
      setT(() => {
        // loop: NOT-WORTH — the same views
        for (const r of subs) {
          // error: NOT-WORTH — a view closed during the window: nothing to end
          if (r.ok) { try { r.wc.endFrameSubscription() } catch (e) {} }
          delete r.wc
        }
        resolve(subs.map((r) => ({ name: r.name, pid: r.pid, fps: r.ok ? Math.round(r.n * 1000 / ms) : null })))
      }, ms)
    })
  }

  function run(cmd, args) {
    return new Promise((resolve) => {
      // lifetime: OK — one short child, ended by its 3 s timeout at the latest
      // error: NOT-WORTH — missing or failing tool: null, the row says "not yet known"
      deps.execFile(cmd, args, { timeout: 3000, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 }, (err, out) => resolve(err ? null : String(out)))
    })
  }

  async function audio() {
    if (deps.platform !== 'linux') return { format: C.UNKNOWN + ': read only on Linux (PulseAudio or PipeWire)', latency: C.UNKNOWN + ': read only on Linux' }
    const out = await run('pactl', ['-f', 'json', 'list', 'sink-inputs'])
    let list = null
    // error: NOT-WORTH — pactl's answer unreadable: "not yet known"
    try { list = out ? JSON.parse(out) : null } catch (e) { list = null }
    if (!Array.isArray(list)) return { format: C.UNKNOWN + ': no answer from the sound server (pactl)', latency: C.UNKNOWN }
    const own = deps.ownSinkInput ? deps.ownSinkInput(list) : null
    if (!own) return { format: C.UNKNOWN + ': Sonata has no audio stream right now (nothing playing)', latency: C.UNKNOWN + ': no audio stream' }
    const us = (Number(own.buffer_latency_usec) || 0) + (Number(own.sink_latency_usec) || 0)
    return {
      format: (C.sampleSpecText(own.sample_specification) || String(own.sample_specification || '?')) + (own.corked ? ' (paused)' : ''),
      latency: us > 0 ? (us / 1000).toFixed(1) + ' ms (stream buffer + output)' : C.UNKNOWN + ': the sound server reports 0 (PipeWire doesn\'t fill it in)'
    }
  }

  async function helperRows() {
    const h = deps.helper()
    if (!h.installed) return { state: 'Not installed (Settings → Precise timing says how)', vram: 'None: no helper' }
    if (!h.running) return { state: 'Installed, not running (it starts for a job and quits after 2 min idle)' + (h.paused ? '; paused while gaming' : ''), vram: 'None: not running' }
    const state = 'Running (process ' + h.pid + ')' + (h.paused ? ', paused while gaming' : '')
    const out = await run('nvidia-smi', ['--query-compute-apps=pid,used_memory', '--format=csv,noheader,nounits'])
    if (out == null) return { state, vram: C.UNKNOWN + ': no nvidia-smi (NVIDIA only)' }
    const row = out.split('\n').map((l) => l.split(',').map((x) => x.trim())).find((c) => Number(c[0]) === h.pid)
    return { state, vram: row ? row[1] + ' MiB (nvidia-smi)' : 'None on the GPU right now (nvidia-smi)' }
  }

  // the song's sung-notes log file (newest of its days), parsed once per file
  function notesDoc(np) {
    const dir = deps.notesDir()
    if (!dir || !np.title) return null
    const suffix = deps.notesSuffix(np.artist, np.title)
    let names
    // error: NOT-WORTH — no folder: no notes
    try { names = io.readdirSync(dir).filter((n) => n.endsWith(suffix)).sort() } catch (e) { return null }
    const name = names[names.length - 1]
    if (!name) return null
    let mtime = 0
    // error: NOT-WORTH — removed meanwhile: no notes
    try { mtime = io.statSync(path.join(dir, name)).mtimeMs } catch (e) { return null }
    if (notesCache.name !== name || notesCache.mtime !== mtime) {
      let doc = null
      // error: NOT-WORTH — a damaged log file reads as no notes ("not yet known")
      try { doc = JSON.parse(io.readFileSync(path.join(dir, name), 'utf8')) } catch (e) { doc = null }
      notesCache = { name, mtime, doc }
    }
    return notesCache.doc
  }

  function hoodProcs(fr) {
    const now = deps.now()
    const ms = deps.metrics()
    const byPid = new Map()
    // loop: NOT-WORTH — the shown views' frame counts (≤ ~8), per refresh
    for (const f of fr) { if (!byPid.has(f.pid)) byPid.set(f.pid, []); byPid.get(f.pid).push(f) }
    const next = new Map()
    let totalMb = 0
    // loop: NOT-WORTH — Sonata's processes (≤ ~12), per refresh
    const procs = ms.map((m) => {
      const cum = m.cpu && Number.isFinite(m.cpu.cumulativeCPUUsage) ? m.cpu.cumulativeCPUUsage : null
      const prev = lastCpu.get(m.pid)
      let cpu = null
      if (cum != null && prev) cpu = Math.max(0, (cum - prev.s) / ((now - prev.at) / 1000) * 100)
      else if (cum == null && m.cpu && ticks > 0) cpu = m.cpu.percentUsage
      if (cum != null) next.set(m.pid, { s: cum, at: now })
      const mb = ((m.memory && m.memory.workingSetSize) || 0) / 1024
      totalMb += mb
      const views = byPid.get(m.pid) || []
      const label = views.length ? views.map((v) => v.name).join(', ')
        : m.type === 'Browser' ? 'Sonata (main process)' : m.type === 'GPU' ? 'Graphics process'
          : m.type === 'Utility' ? (/audio/i.test(m.serviceName || m.name || '') ? 'Audio service' : /network/i.test(m.serviceName || m.name || '') ? 'Network service' : 'Utility: ' + (m.name || m.serviceName || '?'))
            : m.type === 'Tab' ? 'Other page' : m.type
      return { label, cpu, mb, frames: views.map((v) => ({ name: v.name, fps: v.fps })), order: views.length ? 0 : 1 }
    })
    lastCpu = next
    return { procs: procs.sort((a, b) => a.order - b.order), totalMb }
  }

  async function refresh(my) {
    const views = deps.views()
    // error: NOT-WORTH — Apple's page busy or gone: "Nothing playing" this refresh
    const npP = Promise.resolve().then(() => deps.nowPlaying()).catch(() => null)
    const [fr, np, au, hp] = await Promise.all([frames(views, FRAME_MS), npP, audio(), helperRows()])
    if (my !== gen) return
    const st = deps.settings()
    if (!library || ticks % LIBRARY_EVERY === 0) {
      library = { stats: C.libraryStats(deps.store.entries(), { estimate: st.estimate }), files: deps.files() }
    }
    const song = np && np.ok && np.title ? np : null
    const key = song ? song.title + '|' + song.artist : ''
    const now = C.nowRows(song ? {
      title: song.title, artist: song.artist, playing: !!song.isPlaying,
      lyrics: deps.store.peek(key), aligned: deps.store.peek('aligned|' + key), refined: deps.store.peek('refined|' + key),
      notes: notesDoc(song), track: deps.track(), settings: st
    } : null)
    const hood = Object.assign(hoodProcs(fr), { helper: hp, audio: au, versions: deps.versions() })
    ticks++
    data = {
      n: ticks,
      at: localStamp(deps.date()),
      library: C.libraryRows(library.stats, library.files, { estimate: st.estimate }),
      now,
      hood: C.hoodRows(hood),
      summary: library.stats.songs + ' songs · ' + library.stats.words + ' words aligned'
    }
    deps.push()
  }

  // after a refresh: the next one, unless the section closed meanwhile (the window gone, say)
  function next(my) {
    if (my !== gen || !open) return
    if (deps.isOpen && !deps.isOpen()) { api.sync(false); return }
    schedule(my)
  }

  function schedule(my) {
    // loop: NOT-WORTH — For the Curious refresh · one REFRESH_MS one-shot after each refresh · only while the
    // section is open and the window shown · stops on close (sync(false)) · cost per refresh: see the header
    timer = setT(() => {
      timer = null
      if (my !== gen) return
      // error: LOGGED-OK — a failed refresh is logged; the next one tries again
      refresh(my).catch((e) => deps.log('for the curious: refresh failed: ' + (e && e.message))).then(() => next(my))
    }, REFRESH_MS)
  }

  const api = {
    /** open: the section is open and the main window shown. Starts (a refresh at once) or stops. */
    sync(want) {
      if (want === open) return
      open = want
      gen++
      if (timer) { clearT(timer); timer = null }
      if (!open) { data = null; copied = ''; ticks = 0; lastCpu = new Map(); library = null; return }
      const my = gen
      // error: LOGGED-OK — logged; the next refresh tries again
      refresh(my).catch((e) => deps.log('for the curious: refresh failed: ' + (e && e.message))).then(() => next(my))
    },
    /** What the panel shows (null while closed). */
    state() { return data ? Object.assign({}, data, { copied }) : null },
    /** The bug-report text of the numbers shown now ('' before the first refresh). */
    report() { return data ? C.reportText({ library: data.library, now: data.now, hood: data.hood }, { at: data.at }) : '' },
    copiedNote(text) { copied = text; deps.push() },
    get open() { return open },
    get running() { return !!timer }
  }
  return api
}

module.exports = { REFRESH_MS, FRAME_MS, LIBRARY_EVERY, createCuriousSampler }
