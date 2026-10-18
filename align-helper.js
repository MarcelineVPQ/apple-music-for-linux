// Client for the sonata-align helper (align/server.py, docs/LEVEL2-ALIGN.md): JSON lines over the
// child's stdin/stdout. The helper is the user's own install (align/install.sh puts a private venv
// in ~/.local/share/sonata-align); Sonata ships only the small Python scripts and runs them with
// that venv's interpreter. Nothing here touches the install.
//
// lifetime: at most ONE helper process. Spawned on demand (first ping or alignment), sent `quit`
// after IDLE_MS without work (WARM_IDLE_MS while a lyric view is open; frees ~1.8 GB of VRAM), told to
// quit after its current job when a game starts (release()), killed on app quit (stop()) and, as a last
// resort, on process exit. A crashed helper is spawned again only for the next job, and after
// MAX_CRASHES crashes in one app run it stays off.
const fs = require('fs')
const path = require('path')
const { spawn } = require('child_process')

// Idle quit (0.15.42, docs/research/efficiency-audit-2026-10.md row 1). In 30 h of Marcy's listening the
// 2-minute quit cost 59 restarts, 48 % of all helper time spent starting and a song's first words ~5 s
// late (cold first job 5.4 s vs 0.5 s warm); 41 of the restarts came after ≤ 10 idle minutes. So:
// lifetime: OK — the idle helper is kept WARM_IDLE_MS while a lyric view (lyrics window, Studio,
// visualizer) is open, when the next job can come at any song change, and IDLE_MS when none is (no
// recording, so no job until a view opens; the ~1.8 GB of VRAM goes back sooner). Measured from the end
// of the last job: when the last view closes the shorter limit applies at once (an idle 3 min → quits
// now). The gaming guard (release()) and app quit (stop()) still end it at once.
const IDLE_MS = 2 * 60 * 1000
const WARM_IDLE_MS = 10 * 60 * 1000
const JOB_TIMEOUT_MS = 3 * 60 * 1000    // without any message for the job (progress resets it)
const PING_TIMEOUT_MS = 60 * 1000       // importing torch + CUDA init takes a few seconds, more when cold
const QUIT_GRACE_MS = 5000
const MAX_CRASHES = 3

/**
 * True for a path inside another app's sandbox or runtime: a snap (/snap, ~/snap, snapd's state),
 * a Flatpak app's data (~/.var/app) or a mounted AppImage (/tmp/.mount_*). Same rule as
 * sonata_align.in_app_sandbox and align/install.sh. A terminal opened in the Codium snap sets
 * XDG_DATA_HOME=~/snap/codium/<rev>/.local/share, and uv put its Python there: the venv broke
 * when that snap revision went away (2026-10).
 */
function inAppSandbox(p, home) {
  if (!p) return false
  const h = path.resolve(home || '')
  const x = path.resolve(String(p))
  const roots = ['/snap', '/var/snap', '/var/lib/snapd', path.join(h, 'snap'), path.join(h, '.var', 'app')]
  return roots.some((r) => x === r || x.startsWith(r + path.sep)) || x.startsWith('/tmp/.mount_')
}

/**
 * Where the helper lives: the user's install (venv) and our scripts (unpacked from the asar).
 * The install is SONATA_ALIGN_HOME, else $XDG_DATA_HOME/sonata-align (unless XDG_DATA_HOME points
 * into another app's sandbox, inAppSandbox), else ~/.local/share/sonata-align; the first with a
 * venv wins. `stray` is an install found only in a sandboxed XDG_DATA_HOME (checkInstall says so).
 */
function helperPaths(env, appDir, exists = (f) => fs.existsSync(f)) {
  const homes = []
  const hasVenv = (h) => exists(path.join(h, 'venv', 'bin', 'python'))
  let stray = null
  if (env.SONATA_ALIGN_HOME) homes.push(env.SONATA_ALIGN_HOME)
  if (env.XDG_DATA_HOME && path.isAbsolute(env.XDG_DATA_HOME)) {
    const x = path.join(env.XDG_DATA_HOME, 'sonata-align')
    if (!inAppSandbox(env.XDG_DATA_HOME, env.HOME)) homes.push(x)
    else if (hasVenv(x)) stray = x
  }
  homes.push(path.join(env.HOME || '', '.local', 'share', 'sonata-align'))
  const home = homes.find(hasVenv) || homes[0]
  // packaged builds: align/ is unpacked next to app.asar (python can't read inside the asar)
  const dir = path.join(String(appDir).replace(/app\.asar(?=$|[\\/])/, 'app.asar.unpacked'), 'align')
  return { home, python: path.join(home, 'venv', 'bin', 'python'), server: path.join(dir, 'server.py'), stray, userHome: env.HOME || '' }
}

function isInstalled(paths, io = fs) {
  // error: NOT-WORTH — missing or not executable means "not installed", which Settings → Precise timing says
  try { io.accessSync(paths.python, fs.constants.X_OK); io.accessSync(paths.server, fs.constants.R_OK); return true } catch (e) { return false }
}

/**
 * The install's health, checked at start and when Settings asks (never per tick):
 *   ok         the venv's python resolves to an interpreter outside any app sandbox
 *   missing    no venv (not installed): Settings explains how to install
 *   broken     the venv's python is a dangling link or not runnable (its interpreter was removed)
 *   sandboxed  it works, but its python lives inside another app's sandbox (a snap refresh breaks it)
 *   stray      no install where Sonata looks, but one inside a sandboxed XDG_DATA_HOME
 * -> { state, python, target }   (target: what the python link points to, when known)
 * error: SHOWN — broken, sandboxed and stray get a repair notice (repairText), never a silent failure
 */
function checkInstall(paths, io = fs) {
  const py = paths.python
  let target = null
  // error: SHOWN — each failed check below is a state the caller turns into a notice (repairText)
  try { io.lstatSync(py) } catch (e) {
    return { state: paths.stray ? 'stray' : 'missing', python: py, target: paths.stray }
  }
  try { target = io.readlinkSync(py) } catch (e) { target = null }
  let real
  try { real = io.realpathSync(py) } catch (e) { return { state: 'broken', python: py, target } }
  try { io.accessSync(real, fs.constants.X_OK) } catch (e) { return { state: 'broken', python: py, target: real } }
  let cfgHome = null
  try {
    const m = /^home\s*=\s*(.+)$/m.exec(io.readFileSync(path.join(path.dirname(path.dirname(py)), 'pyvenv.cfg'), 'utf8'))
    cfgHome = m ? m[1].trim() : null
  } catch (e) {}   // error: NOT-WORTH — no pyvenv.cfg: the python link alone decides
  if (inAppSandbox(real, paths.userHome) || inAppSandbox(cfgHome, paths.userHome)) return { state: 'sandboxed', python: py, target: real }
  return { state: 'ok', python: py, target: real }
}

/** The repair notice for checkInstall's result, or '' when there is nothing to repair. */
function repairText(health) {
  const how = 'Rebuild it from a normal terminal (not one inside an editor or another app): align/install.sh --rebuild. It keeps the downloaded models; the old venv is kept aside for a rollback.'
  if (!health) return ''
  if (health.state === 'broken') return 'Precise word timing can\'t start: its helper\'s Python is gone' + (health.target ? ' (' + health.target + ')' : '') + '. ' + how
  if (health.state === 'sandboxed') return 'Precise word timing works, but its helper uses a Python inside another app (' + health.target + '), so that app\'s next update breaks it. ' + how
  if (health.state === 'stray') return 'The sonata-align helper was installed inside another app\'s folder (' + health.target + '), where Sonata doesn\'t look. Install it again from a normal terminal: align/install.sh'
  return ''
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
 * The wait before an idle helper quits (ms, ≥ 0): the limit for the views' state minus the time it has
 * already been idle. idleFor: ms since the last job ended; warm: a lyric view is open.
 */
function idleDelay(idleFor, warm, coldMs = IDLE_MS, warmMs = WARM_IDLE_MS) {
  return Math.max(0, (warm ? warmMs : coldMs) - Math.max(0, idleFor || 0))
}

/**
 * createAlignHelper({ paths, env?, log?, idleMs?, warmIdleMs?, warm?, jobTimeoutMs? }, deps?)
 *   -> { installed(), ping(), align(id, messages), viewsChanged(), release(), stop(), running }
 * warm() -> true while a lyric view is open (the longer idle limit applies)
 * deps (tests): { spawn, setTimeout, clearTimeout, now, isInstalled }
 */
function createAlignHelper(opts, deps = {}) {
  const log = opts.log || ((m) => console.log('align:', m))
  const doSpawn = deps.spawn || spawn
  const setT = deps.setTimeout || setTimeout
  const clearT = deps.clearTimeout || clearTimeout
  const installedFn = deps.isInstalled || (() => isInstalled(opts.paths))
  const idleMs = opts.idleMs || IDLE_MS
  const warmIdleMs = opts.warmIdleMs || WARM_IDLE_MS
  const warm = opts.warm || (() => false)
  const now = deps.now || Date.now
  let idleSince = 0           // when the last job ended (0: busy or not running)
  const jobTimeoutMs = opts.jobTimeoutMs || JOB_TIMEOUT_MS
  let child = null
  let pending = new Map()     // id -> { resolve, reject, timer, ms }
  let pings = []              // pong replies carry no id: answered in order
  let idle = null
  let crashes = 0
  let quitting = null         // the child we asked to quit
  let releasing = false       // release(): quit as soon as the current job is done (gaming guard)
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
    if (!child || pending.size) { idleSince = 0; return }
    if (releasing) { releasing = false; quit(); return }
    if (!idleSince) idleSince = now()
    const wait = idleDelay(now() - idleSince, !!warm(), idleMs, warmIdleMs)
    if (!wait) { quit(); return }
    // loop: none · one-shot idle timer · re-armed after each job and when the lyric views open/close · fires once: quit the helper
    idle = setT(() => { idle = null; if (!pending.size) quit() }, wait)
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
    releasing = false
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
    idleSince = 0
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
      idleSince = 0
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
    /**
     * Sung notes (notes-log.js): the notes step on the stem the helper kept from this song's
     * whole-song job (align request with notes: true). syl: per request line, per word the syllable
     * texts or null. -> result { notes, stats }; error codes no-stem, no-model, low-vram
     */
    notes(id, song, syl) { return request(id, [{ cmd: 'notes', id, song, syl }], jobTimeoutMs) },
    /**
     * Sheet notes in the Studio, first play: the pitch line of one section the helper kept (the section
     * job's song id and offset). -> result { pitch: { t0, hop, v }, stats }; error codes no-stem, no-model, low-vram
     */
    pitch(id, song, offset) { return request(id, [{ cmd: 'pitch', id, song, offset }], jobTimeoutMs) },
    /** Downloads the RMVPE pitch model (only when the Sung notes switch is turned on). Error code checksum. */
    prepareNotes() {
      const id = '__notes' + (++pingN)
      return request(id, [{ cmd: 'prepare', id, mode: 'notes' }], jobTimeoutMs)
    },
    /**
     * Gaming guard: the helper quits once its current job is done (now if it has none), which frees
     * its 1.8–3 GB of graphics memory. The next job spawns it again.
     */
    release() {
      if (!child) return
      if (pending.size) releasing = true
      else { if (idle) { clearT(idle); idle = null } quit() }
    },
    /** A lyric view opened or the last one closed: the idle limit follows (main.js lyrics feed). */
    viewsChanged() { if (child && !pending.size && quitting !== child) armIdle() },
    /** Separate once per song: drop that song's kept sections in the helper (queued behind its jobs; no reply). */
    forget(song) {
      if (!child || quitting === child) return
      // error: NOT-WORTH — a closed pipe: the helper is gone and its sections with it
      try { child.stdin.write(JSON.stringify({ cmd: 'forget', song }) + '\n') } catch (e) {}
    },
    /** The helper's process id (the gaming guard leaves our own GPU use out), or 0. */
    get pid() { return child ? child.pid || 0 : 0 },
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

module.exports = { inAppSandbox, helperPaths, isInstalled, checkInstall, repairText, helperEnv, lineParser, createAlignHelper, idleDelay, IDLE_MS, WARM_IDLE_MS }
