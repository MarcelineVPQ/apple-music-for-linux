#!/usr/bin/env node
// The resource budgets (limits in tools/budgets.json, explained in docs/BUDGETS.md), measured on a RUNNING
// ISOLATED Sonata (tools/isolated.sh; tools/check_budgets.sh starts and stops one for you). Never the
// user's copy, never her screen: the copy runs on its own Xvfb display with a throwaway HOME.
//
//   node tools/check-budgets.js quick --cdp 9611 --insp 9612 --out DIR    ~10 min: every state, the release check
//   node tools/check-budgets.js soak  --cdp 9611 --insp 9612 --out DIR    ~35 min: 5 min warm-up + 30 min soak
//   node tools/check-budgets.js report DIR/budgets-quick.json             the table again from a run's results
//
// The copy is logged out, so tools/stand-in.js plays a looped set of local test tracks through a stand-in
// MusicKit in Apple's page: main's real polls, the lyrics engine, the palette and the windows all run.
// Measured per state (tools/budgets.json "states"):
//   - CPU: /proc/<pid>/stat of every app process over the stretch, % of one core. Judged: main, utility
//     and Sonata's own pages. Reported, not judged: the GPU process (Xvfb has no graphics card: software
//     GL inflates it) and Apple's page (Apple's code, not ours).
//   - frames/s of the state's page: compositor frames sent to a DevTools screencast of that page.
//   - repaints/s of that page: `Paint` events of its frame in a trace (contentTracing in the main process).
//   - memory: PSS (/proc/<pid>/smaps_rollup) of every process except the GPU process, everything closed.
//   - listeners: main-process listeners (ipcMain, app, windows, webContents), active timers, and the
//     JS listeners and nodes of the rail and the panel after GC; flat over N open/close cycles of every
//     window (judged: the largest rise).
// Prints the table and writes DIR/budgets-<mode>.json; exits 1 when a budget fails.
'use strict'
const fs = require('fs')
const path = require('path')
const { createKit } = require('./cdp-lib')
const L = require('./budgets-lib')
const SI = require('./stand-in')

const BUDGETS = JSON.parse(fs.readFileSync(path.join(__dirname, 'budgets.json'), 'utf8'))
const args = process.argv.slice(2)
const mode = args[0]
const opt = (name, def) => { const i = args.indexOf('--' + name); return i >= 0 ? args[i + 1] : def }
if (mode === 'report') {
  const r = JSON.parse(fs.readFileSync(args[1], 'utf8'))
  console.log(L.table(L.judge(BUDGETS, r)))
  process.exit(0)
}
if (!BUDGETS.modes[mode]) { console.error('mode: ' + Object.keys(BUDGETS.modes).join(' | ') + ' | report'); process.exit(2) }
const M = Object.assign({}, BUDGETS.modes[mode], process.env.SONATA_BUDGET_MODE ? JSON.parse(process.env.SONATA_BUDGET_MODE) : {})
const ONLY = process.env.SONATA_BUDGET_STATES ? process.env.SONATA_BUDGET_STATES.split(',') : null
const OUT = opt('out', '.')
const kit = createKit({ cdp: Number(opt('cdp', 9611)), insp: Number(opt('insp', 9612)), display: opt('display', ':113') })
const { sleep, target, mainProc } = kit
const E = "process.mainModule.require('electron')"
const log = (...a) => console.error(new Date().toISOString().slice(11, 19), ...a)

// --- the main process: windows, commands, counts ---
const MAIN = `${E}.BaseWindow.getAllWindows().find((w) => w.contentView && w.contentView.children.length >= 2)`
const viewOf = (part) => `${MAIN}.contentView.children.find((v) => v.webContents.getURL().includes('${part}'))`
// a command as the rail would send it (the same ipcMain handler and its checks)
const rail = (command) => `(() => { const v = ${viewOf('rail.html')}; ${E}.ipcMain.emit('rail:command', { sender: v.webContents, senderFrame: { parent: null } }, ${JSON.stringify(command)}); return true })()`
const WINDOWS = `${E}.BaseWindow.getAllWindows().map((w) => w.getTitle())`
// every process with its role: Apple's page and each Sonata page by the URL its renderer shows
const PROCS = `(() => {
  const { app, webContents } = ${E}
  const pages = {}
  for (const wc of webContents.getAllWebContents()) { try { const pid = wc.getOSProcessId(); const u = wc.getURL(); const name = /music\\.apple\\.com/.test(u) ? 'apple' : u.split('/').pop().replace('.html', '') || 'blank'; pages[pid] = pages[pid] ? pages[pid] + '+' + name : name } catch (e) {} }
  return app.getAppMetrics().map((m) => ({ pid: m.pid, type: m.type, role: m.type === 'Tab' ? (pages[m.pid] || 'tab') : m.type === 'Utility' ? 'utility:' + (m.serviceName || m.name || '') : m.type.toLowerCase() }))
})()`
const COUNTS = `(() => {
  const { ipcMain, app, BaseWindow, webContents, nativeTheme, screen } = ${E}
  const sum = (em) => em.eventNames().reduce((a, n) => a + em.listenerCount(n), 0)
  const res = {}
  for (const r of process.getActiveResourcesInfo()) res[r] = (res[r] || 0) + 1
  return {
    ipcMain: sum(ipcMain), app: sum(app), nativeTheme: sum(nativeTheme), screen: sum(screen),
    windows: BaseWindow.getAllWindows().length, windowListeners: BaseWindow.getAllWindows().reduce((a, w) => a + sum(w), 0),
    webContents: webContents.getAllWebContents().length, webContentsListeners: webContents.getAllWebContents().reduce((a, w) => a + sum(w), 0),
    timers: res.Timeout || 0, resources: res
  }
})()`

// --- process readings (this machine's /proc: the copy runs here) ---
function ticksOf(pids) {
  const out = {}
  for (const p of pids) { try { out[p] = L.statTicks(fs.readFileSync('/proc/' + p + '/stat', 'utf8')) } catch (e) { /* error: NOT-WORTH — a process that ended is left out of both readings */ } }
  return out
}
function pssOf(pid) { try { return L.pssMb(fs.readFileSync('/proc/' + pid + '/smaps_rollup', 'utf8')) } catch (e) { return 0 } }

// judged: everything but the GPU process, Apple's page and DevTools' tracing service (it only runs because
// we measure)
const judgedRole = (p) => p.type !== 'GPU' && !/^apple/.test(p.role) && !/tracing/i.test(p.role)
// a step that never answers (a page gone mid-call) fails the run with its name instead of hanging it
const within = (ms, label, promise) => Promise.race([promise, sleep(ms).then(() => { throw new Error('timed out after ' + ms / 1000 + ' s: ' + label) })])

// CPU of every process over `secs`, by role
async function cpuOver(mp, secs) {
  const procs = await mp.ev(PROCS)
  const a = ticksOf(procs.map((p) => p.pid)); const t0 = Date.now()
  await sleep(secs * 1000)
  const b = ticksOf(procs.map((p) => p.pid)); const s = (Date.now() - t0) / 1000
  const by = {}; let judged = 0; let total = 0
  for (const p of procs) {
    if (!(p.pid in a) || !(p.pid in b)) continue
    const pct = L.cpuPercent({ x: a[p.pid] }, { x: b[p.pid] }, s)
    by[p.role] = +((by[p.role] || 0) + pct).toFixed(3)
    total += pct
    if (judgedRole(p)) judged += pct
  }
  return { judged: +judged.toFixed(3), total: +total.toFixed(3), by, seconds: +s.toFixed(1) }
}

// compositor frames of one page per second (a DevTools screencast of it)
async function framesOver(page, secs) {
  let n = 0
  const sub = (m) => { if (m.method === 'Page.screencastFrame') { n++; page.c.send('Page.screencastFrameAck', { sessionId: m.params.sessionId }).catch(() => {}) } }   // error: NOT-WORTH — an ack after the stop
  page.c.on(sub)
  await page.c.send('Page.startScreencast', { format: 'jpeg', quality: 5, maxWidth: 320, maxHeight: 320, everyNthFrame: 1 })
  await sleep(800); n = 0
  await sleep(secs * 1000)
  const got = n
  await page.c.send('Page.stopScreencast')
  return +(got / secs).toFixed(2)
}

// repaints (Paint), style recalcs and layouts of one page per second, from a trace recorded in main
async function paintsOver(mp, page, secs) {
  const frame = page.t.id
  const r = await mp.ev(`(async () => {
    const { contentTracing } = ${E}
    const fs = require('fs'); const os = require('os'); const path = require('path')
    await contentTracing.startRecording({ included_categories: ['devtools.timeline', 'disabled-by-default-devtools.timeline'], excluded_categories: ['*'] })
    const t0 = Date.now()
    await new Promise((r) => setTimeout(r, ${secs * 1000}))
    const span = (Date.now() - t0) / 1000
    const file = await contentTracing.stopRecording(path.join(os.tmpdir(), 'sonata-budget-trace-' + process.pid + '.json'))
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')); fs.unlinkSync(file)
    const ev = raw.traceEvents || raw
    const c = { Paint: 0, UpdateLayoutTree: 0, Layout: 0 }
    const of = (e) => (e.args && (e.args.data && e.args.data.frame || e.args.beginData && e.args.beginData.frame)) || ''
    for (const e of ev) if (e.name in c && (e.ph === 'X' || e.ph === 'B') && of(e) === ${JSON.stringify(frame)}) c[e.name]++
    return { span, c }
  })()`)
  const per = (k) => +(r.c[k] / r.span).toFixed(2)
  return { paints: per('Paint'), styles: per('UpdateLayoutTree'), layouts: per('Layout') }
}

// PSS of every process by role, after a GC in every page; judged = all but the GPU process
async function memory(mp) {
  for (const t of await pages()) { try { await t.send('HeapProfiler.collectGarbage') } catch (e) { /* error: NOT-WORTH — a page closing */ } t.close() }
  await sleep(2000)
  const procs = await mp.ev(PROCS)
  const by = {}; let judged = 0; let total = 0
  for (const p of procs) {
    const mb = pssOf(p.pid)
    by[p.role] = +((by[p.role] || 0) + mb).toFixed(1)
    total += mb
    if (p.type !== 'GPU' && !/tracing/i.test(p.role)) judged += mb
  }
  return { judged: +judged.toFixed(1), total: +total.toFixed(1), by }
}

// every page target (for GC and DOM counters)
async function pages() {
  const list = await (await fetch(`http://127.0.0.1:${opt('cdp', 9611)}/json/list`)).json()
  const out = []
  for (const t of list.filter((p) => p.type === 'page')) { try { out.push(Object.assign(await kit.ws(t.webSocketDebuggerUrl), { url: t.url })) } catch (e) { /* error: NOT-WORTH — closed meanwhile */ } }
  return out
}
// the persistent pages' JS listeners and nodes after GC (rail, panel; Apple's reported)
async function domCounts() {
  const out = {}
  for (const t of await pages()) {
    const name = /music\.apple\.com/.test(t.url) ? 'apple' : t.url.split('/').pop().replace('.html', '')
    try { await t.send('HeapProfiler.collectGarbage'); const d = await t.send('Memory.getDOMCounters'); out[name] = { js: d.jsEventListeners, nodes: d.nodes, documents: d.documents } } catch (e) { /* error: NOT-WORTH — closed meanwhile */ }
    t.close()
  }
  return out
}

// --- the stand-in player in Apple's page ---
let apple
async function standIn(opts) {
  try { return await apple.ev(SI.installScript(opts)) } catch (e) {
    apple = await target('music.apple.com')   // the page reloaded: install again
    return apple.ev(SI.installScript(opts))
  }
}
// synthetic spectrum for the visualizer (~43 frames/s, as visualizer.js sends from Sonata's own stream;
// the isolated copy has no audio), from main, to the visualizer window only; stopped after each stretch
const bands = (on) => `(() => {
  const { BrowserWindow } = ${E}
  clearInterval(globalThis.__budgetBands); globalThis.__budgetBands = null
  if (${on}) { let k = 0; globalThis.__budgetBands = setInterval(() => { const w = BrowserWindow.getAllWindows().find((w) => w.getTitle().includes('Visualizer')); if (!w) return; k++; const kick = (k % 21) < 3 ? 0.9 : 0.25; w.webContents.send('viz-bands', Array.from({ length: 48 }, (_, i) => Math.max(0, (i < 6 ? kick : 0.5 - i / 120) * (0.7 + 0.3 * Math.sin(k / 5 + i))))) }, 23) }
  return true
})()`

const titleHas = (part) => `${E}.BrowserWindow.getAllWindows().some((w) => w.getTitle().includes('${part}'))`
async function floating(mp, which, open) {
  const part = { lyrics: 'Lyrics', visualizer: 'Visualizer', mini: 'Mini' }[which]
  if ((await mp.ev(titleHas(part))) !== open) await mp.ev(rail(which))
  for (let i = 0; i < 40 && (await mp.ev(titleHas(part))) !== open; i++) await sleep(250)
  if (which === 'mini' && !open) await mp.ev(`(${MAIN}.show(), true)`)
}
const settingsFile = `JSON.parse(require('fs').readFileSync(require('path').join(${E}.app.getPath('userData'), 'settings.json'), 'utf8'))`
async function panel(mp, shown) {
  const s = await mp.ev(settingsFile)
  if (!!s.panelShown !== shown) await mp.ev(rail('settings'))
  await sleep(900)
}
async function mainShown(mp, shown) { await mp.ev(`(${MAIN}.${shown ? 'show' : 'hide'}(), true)`); await sleep(600) }
async function closeAll(mp) {
  for (const w of ['lyrics', 'visualizer', 'mini']) await floating(mp, w, false)
  await mp.ev(bands(false))
}

// --- the states (tools/budgets.json "states"): set up, then measured the same way ---
const STATES = {
  'tray-idle': { page: null, setup: async (mp) => { await closeAll(mp); await panel(mp, false); await standIn({ playing: false }); await mainShown(mp, false) }, hidden: true },
  'tray-playing': { page: null, setup: async (mp) => { await closeAll(mp); await standIn({ playing: true }); await mainShown(mp, false) }, hidden: true },
  'main-idle': { page: 'rail.html', setup: async (mp) => { await closeAll(mp); await mainShown(mp, true); await panel(mp, false); await standIn({ playing: false }) } },
  'main-playing': { page: 'rail.html', setup: async (mp) => { await closeAll(mp); await mainShown(mp, true); await panel(mp, false); await standIn({ playing: true }) } },
  'panel-playing': { page: 'panel.html', setup: async (mp) => { await closeAll(mp); await mainShown(mp, true); await panel(mp, true); await standIn({ playing: true }) } },
  'lyrics-playing': { page: 'lyrics.html', setup: async (mp) => { await mainShown(mp, true); await panel(mp, false); await standIn({ playing: true, seek: 20 }); await floating(mp, 'lyrics', true) } },
  'lyrics-paused': { page: 'lyrics.html', setup: async (mp) => { await floating(mp, 'lyrics', true); await standIn({ playing: false, seek: 20 }) } },
  'mini-playing': { page: 'miniplayer.html', setup: async (mp) => { await closeAll(mp); await standIn({ playing: true }); await floating(mp, 'mini', true) } },
  'viz-bars': { page: 'visualizer.html', viz: 'bars' },
  'viz-aurora': { page: 'visualizer.html', viz: 'aurora' },
  'viz-nebula': { page: 'visualizer.html', viz: 'nebula' },
  'viz-toast': { page: 'visualizer.html', viz: 'toast' },
  'viz-paused': { page: 'visualizer.html', viz: 'bars', paused: true }
}
async function vizSetup(mp, st) {
  // a fresh visualizer per scene (switching scenes in an open one measured 0 frames: it stayed frozen)
  await floating(mp, 'mini', false); await floating(mp, 'lyrics', false); await floating(mp, 'visualizer', false)
  await standIn({ playing: !st.paused, seek: 20 })
  await floating(mp, 'visualizer', true)
  const page = await target('visualizer.html')
  await page.ev(`(() => { const order = ['bars', 'aurora', 'nebula', 'toast']; for (let i = 0; i < 4 && window.__mode() !== ${JSON.stringify(st.viz)}; i++) document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight' })); return window.__mode() })()`)
  page.c.close()
  await mp.ev(bands(!st.paused))
}

const SAME_POINT = 40   // s into a stand-in track: lines being sung, the interlude (≈ 22-34 s) behind
async function measureStates(mp, results) {
  for (const [id, st] of Object.entries(STATES)) {
    if (ONLY && !ONLY.includes(id)) continue
    log('state', id)
    await within(60000, id + ' setup', st.viz ? vizSetup(mp, st) : st.setup(mp))
    await sleep((st.hidden ? M.hiddenSettleS : M.settleS) * 1000)
    const secs = st.hidden ? M.hiddenS : M.cpuS
    results.cpu[id] = await within(secs * 1000 + 30000, id + ' cpu', cpuOver(mp, secs))
    if (st.page) {
      const page = await within(40000, id + ' page', target(st.page))
      // frames and the trace start at the same point of the song every run (singing, past the interlude),
      // so a stretch never lands on the interlude in one run and on dense words in the next
      const same = async () => { if (/playing|viz-(?!paused)/.test(id) && !/main|panel|mini/.test(id)) { await standIn({ seek: SAME_POINT }); await sleep(1000) } }
      await same()
      results.frames[id] = await within(M.framesS * 1000 + 20000, id + ' frames', framesOver(page, M.framesS))
      await same()
      const p = await within(M.traceS * 1000 + 30000, id + ' trace', paintsOver(mp, page, M.traceS))
      results.paints[id] = p.paints
      results.work[id] = p
      page.c.close()
    }
    log('  cpu', results.cpu[id].judged, 'frames', results.frames[id], 'paints', results.paints[id])
    fs.writeFileSync(path.join(OUT, 'budgets-' + mode + '.json'), JSON.stringify(results, null, 1))
  }
  await closeAll(mp)
}

// open and close every window N times: the main process's and the persistent pages' counts stay flat
async function listenerCycles(mp, results, n) {
  const snap = async (tag) => ({ tag, main: await mp.ev(COUNTS), dom: await domCounts() })
  const cycle = async () => {
    for (const w of ['lyrics', 'visualizer']) { await floating(mp, w, true); await sleep(1500); await floating(mp, w, false) }
    await floating(mp, 'mini', true); await sleep(1500); await floating(mp, 'mini', false)
    await panel(mp, true); await sleep(500); await panel(mp, false)
    await sleep(1000)
  }
  await mainShown(mp, true); await standIn({ playing: true })
  await cycle()   // warm-up: first opens create what stays (the panel view, caches)
  const rows = [await snap('after 1 warm-up cycle')]
  for (let i = 1; i <= n; i++) { await cycle(); rows.push(await snap('cycle ' + i)) }
  const series = (f) => rows.map(f)
  const keys = { ipcMain: (r) => r.main.ipcMain, app: (r) => r.main.app, windowListeners: (r) => r.main.windowListeners, webContentsListeners: (r) => r.main.webContentsListeners, webContents: (r) => r.main.webContents, nativeTheme: (r) => r.main.nativeTheme, screen: (r) => r.main.screen, timers: (r) => r.main.timers, railJs: (r) => (r.dom.rail || {}).js, panelJs: (r) => (r.dom.panel || {}).js, railNodes: (r) => (r.dom.rail || {}).nodes, panelNodes: (r) => (r.dom.panel || {}).nodes }
  const growth = {}
  for (const [k, f] of Object.entries(keys)) growth[k] = L.counterGrowth(series(f).filter((v) => v !== undefined)).end
  results.listeners = { cycles: n, growth: Math.max(...Object.values(growth)), byCounter: growth, apple: series((r) => (r.dom.apple || {}).js), rows }
}

async function quick(mp, results) {
  await measureStates(mp, results)
  if (!ONLY) await listenerCycles(mp, results, BUDGETS.budgets.listeners.cycles)
  await closeAll(mp); await panel(mp, false); await mainShown(mp, false); await standIn({ playing: false })
  await sleep(10000)
  results.memory = await memory(mp)
}

// 30 minutes of playback (the stand-in loops its tracks) with every window opened and closed each lap;
// a sample each lap in the same state (floating windows closed, main shown, panel hidden)
async function soak(mp, results) {
  await mainShown(mp, true); await panel(mp, false); await standIn({ playing: true, seek: 0 })
  const t0 = Date.now(); const end = t0 + (M.soakWarmupS + M.soakS) * 1000
  const samples = []; const lapErrors = []
  let lap = 0
  while (Date.now() < end) {
    lap++
    const lapEnd = Date.now() + M.sampleS * 1000
    let si = {}; let mem; let main; let dom
    // a page closing under a DevTools call ("Promise was collected", 2026-10-17 lap 30) costs that lap's
    // sample, not the soak: logged, counted, and the next lap starts clean
    try {
      await floating(mp, 'lyrics', true); await sleep(12000); await floating(mp, 'lyrics', false)
      await floating(mp, 'visualizer', true); await mp.ev(bands(true)); await sleep(12000); await mp.ev(bands(false)); await floating(mp, 'visualizer', false)
      await floating(mp, 'mini', true); await sleep(8000); await floating(mp, 'mini', false)
      await panel(mp, true); await sleep(3000); await panel(mp, false)
      si = await standIn({})
      while (Date.now() < lapEnd) await sleep(500)
      mem = await memory(mp)
      main = await mp.ev(COUNTS)
      dom = await domCounts()
    } catch (e) {
      lapErrors.push({ lap, error: e.message })
      log('soak lap', lap, 'skipped:', e.message)
      await closeAll(mp).catch(() => {}); await sleep(2000)   // error: LOGGED-OK — the next lap tries again
      continue
    }
    const t = (Date.now() - t0) / 1000
    samples.push({ t: +t.toFixed(0), lap, warm: t > M.soakWarmupS, pss: mem.judged, pssTotal: mem.total, by: mem.by, main, dom, track: si.title })
    log('soak lap', lap, 'pss', mem.judged, 'ipc', main.ipcMain, 'wc', main.webContents, 'timers', main.timers, 'rail js', (dom.rail || {}).js, 'panel js', (dom.panel || {}).js)
    fs.writeFileSync(path.join(OUT, 'budgets-' + mode + '.json'), JSON.stringify(Object.assign(results, { soakSamples: samples }), null, 1))
  }
  const warm = samples.filter((s) => s.warm)
  const counters = (s) => [s.main.ipcMain, s.main.app, s.main.windowListeners, s.main.webContentsListeners, s.main.webContents, s.main.timers, (s.dom.rail || {}).js || 0, (s.dom.panel || {}).js || 0]
  const names = ['ipcMain', 'app', 'windowListeners', 'webContentsListeners', 'webContents', 'timers', 'railJs', 'panelJs']
  const byCounter = {}
  names.forEach((n, i) => { byCounter[n] = L.counterGrowth(warm.map((s) => counters(s)[i])) })
  const byRole = {}
  for (const role of Object.keys(warm[0] ? warm[0].by : {})) byRole[role] = +L.growthPer30Min(warm.map((s) => ({ t: s.t, v: s.by[role] || 0 }))).toFixed(2)
  results.soak = {
    laps: lap, lapErrors, minutes: +((Date.now() - t0) / 60000).toFixed(1),
    growthMb: +L.growthPer30Min(warm.map((s) => ({ t: s.t, v: s.pss }))).toFixed(2),
    growthMbTotal: +L.growthPer30Min(warm.map((s) => ({ t: s.t, v: s.pssTotal }))).toFixed(2),
    growthByRole: byRole,
    listenerGrowth: Math.max(...Object.values(byCounter).map((g) => g.end)),
    listenerByCounter: byCounter,
    appleJs: warm.map((s) => (s.dom.apple || {}).js), appleNodes: warm.map((s) => (s.dom.apple || {}).nodes)
  }
  results.memory = { judged: warm.length ? warm[warm.length - 1].pss : undefined, total: warm.length ? warm[warm.length - 1].pssTotal : undefined, by: warm.length ? warm[warm.length - 1].by : {} }
}

;(async () => {
  fs.mkdirSync(OUT, { recursive: true })
  const mp = await mainProc()
  apple = await target('music.apple.com')
  await sleep(3000)
  const results = { mode, when: new Date().toISOString(), version: await mp.ev(`${E}.app.getVersion()`), electron: await mp.ev('process.versions.electron'), timings: M, cpu: {}, frames: {}, paints: {}, work: {}, windows: await mp.ev(WINDOWS) }
  // track notifications off in the test copy: its private D-Bus has no notification server, and libnotify
  // then blocks the main process ~25 s per track change while D-Bus tries to start one (measured 2026-10-17)
  await panel(mp, true)
  await mp.ev(`(() => { const v = ${viewOf('panel.html')}; ${E}.ipcMain.emit('panel:command', { sender: v.webContents, senderFrame: { parent: null } }, 'set', 'notifications', false); return true })()`)
  await panel(mp, false)
  await standIn({ playing: false, seek: 10 })
  if (mode === 'quick') await quick(mp, results)
  else await soak(mp, results)
  await closeAll(mp); await standIn({ playing: false })
  results.rows = L.judge(BUDGETS, results)
  fs.writeFileSync(path.join(OUT, 'budgets-' + mode + '.json'), JSON.stringify(results, null, 1))
  console.log(L.table(results.rows))
  console.log('memory by process (MB PSS): ' + JSON.stringify(results.memory.by))
  const failed = results.rows.filter((r) => r.verdict === 'FAIL')
  console.log(failed.length ? failed.length + ' budget(s) FAILED' : 'every measured budget passed')
  process.exit(failed.length ? 1 : 0)
})().catch((e) => { console.error(e.stack || e.message); process.exit(2) })
