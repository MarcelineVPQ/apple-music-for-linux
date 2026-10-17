// Client for the sonata-align helper (align/server.py, docs/LEVEL2-ALIGN.md): JSON lines over the
// child's stdin/stdout. The helper is the user's own install (align/install.sh puts a private venv
// in ~/.local/share/sonata-align); Sonata ships only the small Python scripts and runs them with
// that venv's interpreter. Nothing here touches the install.
//
// lifetime: at most ONE helper process. Spawned on demand (first ping or alignment), sent `quit`
// after IDLE_MS without work (frees ~2.7 GB of VRAM), killed on app quit (stop()) and, as a last
// resort, on process exit. A crashed helper is spawned again only for the next job, and after
// MAX_CRASHES crashes in one app run it stays off.
const fs = require('fs')
const path = require('path')
const { spawn } = require('child_process')

const IDLE_MS = 2 * 60 * 1000
const JOB_TIMEOUT_MS = 3 * 60 * 1000    // without any message for the job (progress resets it)
const PING_TIMEOUT_MS = 60 * 1000       // importing torch + CUDA init takes a few seconds, more when cold
const QUIT_GRACE_MS = 5000
const MAX_CRASHES = 3

/**
 * Where the helper lives: the user's install (venv) and our scripts (unpacked from the asar).
 * The install is looked for in SONATA_ALIGN_HOME, $XDG_DATA_HOME/sonata-align and
 * ~/.local/share/sonata-align; the first with a venv wins (a launcher such as a snap can point
 * XDG_DATA_HOME somewhere other than where install.sh put it).
 */
function helperPaths(env, appDir, exists = (f) => fs.existsSync(f)) {
  const homes = []
  if (env.SONATA_ALIGN_HOME) homes.push(env.SONATA_ALIGN_HOME)
  if (env.XDG_DATA_HOME) homes.push(path.join(env.XDG_DATA_HOME, 'sonata-align'))
  homes.push(path.join(env.HOME || '', '.local', 'share', 'sonata-align'))
  const home = homes.find((h) => exists(path.join(h, 'venv', 'bin', 'python'))) || homes[0]
  // packaged builds: align/ is unpacked next to app.asar (python can't read inside the asar)
  const dir = path.join(String(appDir).replace(/app\.asar(?=$|[\\/])/, 'app.asar.unpacked'), 'align')
  return { home, python: path.join(home, 'venv', 'bin', 'python'), server: path.join(dir, 'server.py') }
}

function isInstalled(paths, io = fs) {
  // error: NOT-WORTH — missing or not executable means "not installed", which Settings → Precise timing says
  try { io.accessSync(paths.python, fs.constants.X_OK); io.accessSync(paths.server, fs.constants.R_OK); return true } catch (e) { return false }
}

/** The helper's environment: ours minus anything an AppImage/Electron sets that would break the venv. */
function helperEnv(env, home) {
  const out = Object.assign({}, env)
  // loop: NOT-WORTH — six names, once per helper spawn
  for (const k of ['LD_LIBRARY_PATH', 'LD_PRELOAD', 'PYTHONHOME', 'PYTHONPATH', 'PYTHONSTARTUP', 'ELECTRON_RUN_AS_NODE']) delete out[k]
  out.SONATA_ALIGN_HOME = home
  out.PYTHONUNBUFFERED = '1'
  out.PYTHONDONTWRITEBYTECODE = '1'   // the AppImage mount is read-only
  return out
}

/** Splits a stdout stream into JSON messages; non-JSON lines go to onBad. */
function lineParser(onMessage, onBad) {
  let rest = ''
  return (chunk) => {
    const parts = (rest + chunk).split('\n')
    rest = parts.pop()
    // loop: HOT-PATH-OK — one pass over the complete lines in this chunk (a few messages) · ends with the chunk
    // error: LOGGED-OK — a non-JSON line goes to onBad (logged as "helper said"); the next line is read
    for (const line of parts) {
      if (!line.trim()) continue
      let msg
      try { msg = JSON.parse(line) } catch (e) { if (onBad) onBad(line); continue }
      onMessage(msg)
    }
  }
}

// lifetime: OK — the live helper is in this Set until it exits; killed hard on process exit. The one
// 'exit' listener on process is added once at module load.
// loop: NOT-WORTH — at most one live helper
// error: NOT-WORTH — a kill of an already-gone process at exit has nothing left to do
const live = new Set()
process.on('exit', () => { for (const p of live) { try { p.kill('SIGKILL') } catch (e) {} } })

/**
 * createAlignHelper({ paths, env?, log?, idleMs?, jobTimeoutMs? }, deps?)
 *   -> { installed(), ping(), align(id, messages), stop(), running }
 * deps (tests): { spawn, setTimeout, clearTimeout, isInstalled }
 */
function createAlignHelper(opts, deps = {}) {
  const log = opts.log || ((m) => console.log('align:', m))
  const doSpawn = deps.spawn || spawn
  const setT = deps.setTimeout || setTimeout
  const clearT = deps.clearTimeout || clearTimeout
  const installedFn = deps.isInstalled || (() => isInstalled(opts.paths))
  const idleMs = opts.idleMs || IDLE_MS
  const jobTimeoutMs = opts.jobTimeoutMs || JOB_TIMEOUT_MS
  let child = null
  let pending = new Map()     // id -> { resolve, reject, timer, ms }
  let pings = []              // pong replies carry no id: answered in order
  let idle = null
  let crashes = 0
  let quitting = null         // the child we asked to quit
  let stderrTail = []

  function fail(id, err) {
    const p = pending.get(id)
    if (!p) return
    pending.delete(id)
    if (p.timer) clearT(p.timer)
    p.reject(err)
    armIdle()
  }

  function done(id, value) {
    const p = pending.get(id)
    if (!p) return
    pending.delete(id)
    if (p.timer) clearT(p.timer)
    p.resolve(value)
    armIdle()
  }

  function touch(id) {
    const p = pending.get(id)
    if (!p) return
    if (p.timer) clearT(p.timer)
    // loop: none · one-shot job timeout, re-armed on every message for the job
    // error: a helper silent for the timeout is treated as hung: the job fails and the helper is killed
    p.timer = setT(() => {
      fail(id, new Error('helper timed out'))
      kill()
    }, p.ms)
  }

  function armIdle() {
    if (idle) { clearT(idle); idle = null }
    if (!child || pending.size) return
    // loop: none · one-shot idle timer · re-armed after each job · fires once: quit the helper
    idle = setT(() => { idle = null; if (!pending.size) quit() }, idleMs)
    if (idle && idle.unref) idle.unref()
  }

  function onMessage(msg) {
    if (msg.type === 'pong') {
      const id = pings.shift()
      if (id) done(id, msg)
    } else if (msg.type === 'progress') touch(msg.id)
    else if (msg.type === 'result') done(msg.id, msg)
    else if (msg.type === 'error') {
      if (msg.id == null) { log('helper: ' + msg.message); return }
      const e = new Error(msg.message || 'helper error')
      if (msg.code) e.code = msg.code
      fail(msg.id, e)
    }
  }

  function ensure() {
    if (child) return child
    if (crashes >= MAX_CRASHES) throw new Error('helper crashed ' + crashes + ' times, off until restart')
    if (!installedFn()) throw new Error('sonata-align is not installed (run align/install.sh)')
    const p = opts.paths
    const c = doSpawn(p.python, ['-u', p.server], { stdio: ['pipe', 'pipe', 'pipe'], env: helperEnv(opts.env || process.env, p.home) })
    // lifetime: OK — one helper child · ends on quit (idle), stop(), a timeout kill, its own crash, or process exit (live)
    child = c
    live.add(c)
    stderrTail = []
    c.stdout.setEncoding('utf8')
    c.stdout.on('data', lineParser(onMessage, (line) => log('helper said: ' + line.slice(0, 200))))
    c.stderr.setEncoding('utf8')
    // stderr is the helper's log (warnings, tracebacks): keep the last lines for a crash report only
    // lifetime: OK — the stdout/stderr/stdin/child listeners die with the child
    // loop: HOT-PATH-OK — the lines of one stderr chunk (a few), kept to the last 20
    c.stderr.on('data', (s) => {
      for (const line of s.split('\n')) if (line.trim()) stderrTail.push(line)
      if (stderrTail.length > 20) stderrTail = stderrTail.slice(-20)
    })
    // error: NOT-WORTH — a closed pipe while writing (helper died) is handled by 'exit'
    c.stdin.on('error', () => {})   // lifetime: OK — dies with the child
    // error: LOGGED-OK — spawn failure (ENOENT, EACCES) arrives here; 'exit' may not follow, so clean up too
    // lifetime: OK — 'error' and 'exit' listeners die with the child
    c.on('error', (e) => { log('helper failed to start: ' + e.message); gone(c, true) })
    c.on('exit', (code, signal) => gone(c, c !== quitting && code !== 0, code, signal))
    return c
  }

  function gone(c, crashed, code, signal) {
    live.delete(c)
    if (child !== c) return
    child = null
    if (quitting === c) quitting = null
    if (idle) { clearT(idle); idle = null }
    if (crashed) {
      crashes++
      log('helper exited (' + (signal || code) + ')' + (stderrTail.length ? ': ' + stderrTail[stderrTail.length - 1].slice(0, 200) : ''))
    }
    const err = new Error('helper exited')
    pings = []
    // loop: NOT-WORTH — the pending jobs (1-2)
    for (const id of [...pending.keys()]) fail(id, err)
  }

  function quit() {
    const c = child
    if (!c) return
    quitting = c
    // error: NOT-WORTH — a pipe already closed means the helper is leaving anyway; the grace timer below kills it otherwise
    try { c.stdin.write(JSON.stringify({ cmd: 'quit' }) + '\n'); c.stdin.end() } catch (e) {}
    // error: NOT-WORTH — a helper that doesn't leave within the grace time is killed (SIGTERM, then SIGKILL);
    // a kill that throws means it is already gone
    const t = setT(() => {
      if (!live.has(c)) return
      try { c.kill() } catch (e) {}
      const h = setT(() => { if (live.has(c)) { try { c.kill('SIGKILL') } catch (e) {} } }, 2000)
      if (h && h.unref) h.unref()
    }, QUIT_GRACE_MS)
    if (t && t.unref) t.unref()
  }

  function kill() {
    const c = child
    if (!c) return
    quitting = c
    // error: NOT-WORTH — a kill that throws means the helper is already gone; SIGKILL after 2 s otherwise
    try { c.kill() } catch (e) {}
    const h = setT(() => { if (live.has(c)) { try { c.kill('SIGKILL') } catch (e) {} } }, 2000)
    if (h && h.unref) h.unref()
  }

  // writes the messages one line at a time, waiting for the pipe to drain (a song is ~28 MB of base64)
  // loop: SERIAL-REQUIRED — one pipe, messages in protocol order, waiting for drain
  // lifetime: OK — the drain/exit listeners remove each other (off), one pair at a time
  async function write(c, messages) {
    for (const m of messages) {
      if (child !== c) throw new Error('helper exited')
      if (!c.stdin.write(JSON.stringify(m) + '\n')) {
        await new Promise((resolve) => {
          const off = () => { c.stdin.removeListener('drain', off); c.removeListener('exit', off); resolve() }
          c.stdin.once('drain', off)
          c.once('exit', off)
        })
      }
    }
  }

  function request(id, messages, ms) {
    return new Promise((resolve, reject) => {
      let c
      // error: PASSES-ON — not installed / crashed too often: the caller's promise rejects (Settings shows it, the session logs it)
      try { c = ensure() } catch (e) { reject(e); return }
      if (idle) { clearT(idle); idle = null }
      pending.set(id, { resolve, reject, timer: null, ms })
      touch(id)
      write(c, messages).catch((e) => fail(id, e))   // error: PASSES-ON — the job's promise rejects
    })
  }

  let pingN = 0
  return {
    installed: () => installedFn(),
    /** -> pong { version, device, gpu?, models } */
    ping() {
      const id = '__ping' + (++pingN)
      pings.push(id)
      // error: PASSES-ON — rethrown to askAlignStatus (main.js), which shows it in Settings
      return request(id, [{ cmd: 'ping' }], PING_TIMEOUT_MS).catch((e) => { pings = pings.filter((p) => p !== id); throw e })
    },
    /** messages: iterable of protocol messages for job `id` (align-session.js alignMessages) */
    align(id, messages) { return request(id, messages, jobTimeoutMs) },
    /** lifetime: app quit / setting off: fails pending jobs, ends the helper now */
    stop() {
      if (idle) { clearT(idle); idle = null }
      const c = child
      if (!c) return
      quit()
      // error: NOT-WORTH — a kill that throws means the helper is already gone
      try { c.kill() } catch (e) {}
    },
    get running() { return !!child }
  }
}

module.exports = { helperPaths, isInstalled, helperEnv, lineParser, createAlignHelper, IDLE_MS }
