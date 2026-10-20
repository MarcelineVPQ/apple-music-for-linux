// Client for the sonata-align helper (the Sonata engine, docs/LEVEL2-ALIGN.md): JSON lines over the
// child's stdin/stdout. The helper is a separate program and the user's own install: align/install.sh
// downloads the engine release pinned in align/engine.json, checks its size, SHA-256 and signature,
// and unpacks it into <home>/engine-X.Y.Z/ with a private venv in <home>/venv (~/.local/share/sonata-align).
// Sonata ships none of the engine's code; it starts <home>/engine-X.Y.Z/main.py with that venv's
// interpreter and speaks the protocol. Nothing here touches the install.
//
// lifetime: at most ONE helper process. Spawned on demand (first ping or alignment), sent `quit`
// after IDLE_MS without work (WARM_IDLE_MS while a lyric view is open; frees ~1.8 GB of VRAM), told to
// quit after its current job when a game starts (release()), killed on app quit (stop()) and, as a last
// resort, on process exit. A crashed helper is spawned again only for the next job, and after
// MAX_CRASHES crashes in one app run it stays off.
const fs = require('fs')
const path = require('path')
const os = require('os')
const { spawn } = require('child_process')
const V = require('./version-display')   // the engine version as people see it

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
// The helper protocol versions this client speaks (the pong's "protocol"; none = 1, the helper that
// shipped inside Sonata up to 0.15.44). A helper with another one is refused: "Update Precise timing".
const PROTOCOLS = [1, 2]

/**
 * The engine release this Sonata wants (align/engine.json: version, protocol, python, file, url, size,
 * sha256, key). "python" (X.Y) is the Python its compiled modules are for: the venv must be on it.
 */
function enginePin(appDir) {
  const dir = path.join(String(appDir || __dirname), 'align')   // read through the asar (Electron's fs)
  // error: NOT-WORTH — no pin (a broken checkout): no engine is wanted, Settings says "not installed"
  try { return JSON.parse(fs.readFileSync(path.join(dir, 'engine.json'), 'utf8')) } catch (e) { return null }
}

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
  // loop: NOT-WORTH — 5 roots · per helperPaths/checkInstall (start, Settings asks), never per tick
  return roots.some((r) => x === r || x.startsWith(r + path.sep)) || x.startsWith('/tmp/.mount_')
}

/**
 * The engine an install says Sonata runs: <home>/active-engine (one line, X.Y.Z; written by
 * align/install.sh after the engine answered a ping in its venv) and that engine's ENGINE.json.
 * -> { version, protocol, python } or null (none, unreadable, or a protocol this client doesn't speak)
 */
function activeEngine(home, readText = (f) => fs.readFileSync(f, 'utf8')) {
  // error: NOT-WORTH — no file (an install from before 0.15.46, or none): the pinned engine is used
  let version
  try { version = String(readText(path.join(home, 'active-engine'))).split('\n')[0].trim() } catch (e) { return null }
  if (!/^\d+\.\d+\.\d+(?:-dev\.\d+)?$/.test(version)) return null
  let meta
  // error: NOT-WORTH — an engine folder without ENGINE.json is not an engine: the pinned one is used
  try { meta = JSON.parse(readText(path.join(home, 'engine-' + version, 'ENGINE.json'))) } catch (e) { return null }   // hardcode: OK — the engine's folder name, never shown
  if (!meta || meta.version !== version || !PROTOCOLS.includes(meta.protocol)) return null
  return { version, protocol: meta.protocol, python: typeof meta.python === 'string' ? meta.python : '' }
}

// engine versions X.Y.Z or X.Y.Z-dev.N: a < b (a release sorts after its development builds)
function olderEngine(a, b) {
  const key = (v) => { const m = /^(\d+)\.(\d+)\.(\d+)(?:-dev\.(\d+))?$/.exec(String(v)); return m ? [+m[1], +m[2], +m[3], m[4] === undefined ? Infinity : +m[4]] : [0, 0, 0, 0] }
  const x = key(a), y = key(b)
  // loop: NOT-WORTH — 4 fields
  for (let i = 0; i < 4; i++) if (x[i] !== y[i]) return x[i] < y[i]
  return false
}

/**
 * Where the helper lives: the user's install (venv) and the engine in it (<home>/engine-X.Y.Z).
 * The install is SONATA_ALIGN_HOME, else $XDG_DATA_HOME/sonata-align (unless XDG_DATA_HOME points
 * into another app's sandbox, inAppSandbox), else ~/.local/share/sonata-align; the first with a
 * venv wins. `stray` is an install found only in a sandboxed XDG_DATA_HOME (checkInstall says so).
 * The engine: the active one (activeEngine: any engine with a protocol this client speaks, at least the
 * pinned version: engine updates come from the engine feed, engine-feed.js, without a Sonata release),
 * else the pinned one (align/engine.json, the minimum); or SONATA_ENGINE_DIR (an engine checkout or
 * unpacked build, for engine work: its main.py, else its server.py).
 */
function helperPaths(env, appDir, exists = (f) => fs.existsSync(f), pin = enginePin(appDir), readText) {
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
  const min = (pin && pin.version) || ''
  const active = env.SONATA_ENGINE_DIR ? null : activeEngine(home, readText)
  const use = active && (!min || !olderEngine(active.version, min)) ? active : null
  const version = use ? use.version : min
  const python = use ? use.python : String((pin && pin.python) || '')
  let engine = version ? path.join(home, 'engine-' + version) : ''   // hardcode: OK — the engine's folder name (the raw pinned version), never shown
  let server = engine ? path.join(engine, 'main.py') : ''
  if (env.SONATA_ENGINE_DIR) {
    engine = env.SONATA_ENGINE_DIR
    server = exists(path.join(engine, 'main.py')) ? path.join(engine, 'main.py') : path.join(engine, 'server.py')
  }
  return {
    home, python: path.join(home, 'venv', 'bin', 'python'), server, engine,
    engineVersion: env.SONATA_ENGINE_DIR ? '' : version, enginePython: env.SONATA_ENGINE_DIR ? '' : python,
    minVersion: min, activeVersion: active ? active.version : '',
    override: !!env.SONATA_ENGINE_DIR, stray, userHome: env.HOME || ''
  }
}

/**
 * A pong from a helper whose protocol this client doesn't speak is refused (code 'protocol').
 * error: PASSES-ON — the ping's promise rejects; Settings shows "Update Precise timing"
 */
function checkProtocol(pong) {
  const p = pong && pong.protocol != null ? pong.protocol : 1
  if (!PROTOCOLS.includes(p)) {
    const e = new Error('Update Precise timing: its helper speaks protocol ' + p + ', this Sonata knows ' + PROTOCOLS.join(' and ') + ' (Settings → Precise timing → Update)')
    e.code = 'protocol'
    throw e
  }
  return pong
}

function isInstalled(paths, io = fs) {
  // error: NOT-WORTH — missing or not executable means "not installed", which Settings → Precise timing says
  if (!paths.server) return false
  try { io.accessSync(paths.python, fs.constants.X_OK); io.accessSync(paths.server, fs.constants.R_OK); return true } catch (e) { return false }
}

/**
 * The install's health, checked at start and when Settings asks (never per tick):
 *   ok         the venv's python resolves to an interpreter outside any app sandbox
 *   missing    no venv (not installed): Settings explains how to install
 *   broken     the venv's python is a dangling link or not runnable (its interpreter was removed)
 *   sandboxed  it works, but its python lives inside another app's sandbox (a snap refresh breaks it)
 *   stray      no install where Sonata looks, but one inside a sandboxed XDG_DATA_HOME
 *   update     a healthy venv, but not the engine this Sonata pins (none yet: an install from before the
 *              engine download, or an older engine), or a venv on another Python than the engine's
 * -> { state, python, target, want? }   (target: what the python link points to, when known; want: the pinned engine version)
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
  let pyVersion = null
  try {
    const cfg = io.readFileSync(path.join(path.dirname(path.dirname(py)), 'pyvenv.cfg'), 'utf8')
    const m = /^home\s*=\s*(.+)$/m.exec(cfg)
    cfgHome = m ? m[1].trim() : null
    const v = /^version(?:_info)?\s*=\s*(\d+\.\d+)/m.exec(cfg)
    pyVersion = v ? v[1] : null
  } catch (e) {}   // error: NOT-WORTH — no pyvenv.cfg: the python link alone decides
  if (inAppSandbox(real, paths.userHome) || inAppSandbox(cfgHome, paths.userHome)) return { state: 'sandboxed', python: py, target: real }
  if (!paths.override) {
    const want = paths.engineVersion || ''
    const wantPy = paths.enginePython || ''
    let engineThere = false
    // error: SHOWN — no engine (or not the pinned one) is the 'update' state, which Settings explains
    try { io.accessSync(paths.server, fs.constants.R_OK); engineThere = true } catch (e) { engineThere = false }
    if (!engineThere || (wantPy && pyVersion && pyVersion !== wantPy)) return { state: 'update', python: py, target: real, want, py: pyVersion || '' }
  }
  return { state: 'ok', python: py, target: real, py: pyVersion || '' }
}

/**
 * The repair notice for checkInstall's result, or '' when there is nothing to repair. The buttons it names
 * are in Settings → Precise timing (panel-helper.js); a terminal can do the same with align/install.sh.
 */
function repairText(health) {
  if (!health) return ''
  if (health.state === 'update') return 'Precise word timing needs a helper update (engine ' + (V.short(health.want) || 'of this Sonata') + '). Press Update below: it keeps the downloaded models and rebuilds the Python packages only when they changed.'
  if (health.state === 'broken') return 'Precise word timing can\'t start: its helper\'s Python is gone' + (health.target ? ' (' + health.target + ')' : '') + '. Press Repair below: it rebuilds the Python packages and keeps the downloaded models.'
  if (health.state === 'sandboxed') return 'Precise word timing works, but its helper uses a Python inside another app (' + health.target + '), so that app\'s next update breaks it. Press Repair below: it rebuilds the Python packages and keeps the downloaded models.'
  if (health.state === 'stray') return 'The Precise timing helper was installed inside another app\'s folder (' + health.target + '), where Sonata doesn\'t look. Press Install below to install it where Sonata looks.'
  return ''
}

/** The helper's environment: ours minus anything an AppImage/Electron sets that would break the venv. */
function helperEnv(env, home, threads) {
  const out = Object.assign({}, env)
  // loop: NOT-WORTH — six names, once per helper spawn
  for (const k of ['LD_LIBRARY_PATH', 'LD_PRELOAD', 'PYTHONHOME', 'PYTHONPATH', 'PYTHONSTARTUP', 'ELECTRON_RUN_AS_NODE']) delete out[k]
  out.SONATA_ALIGN_HOME = home
  out.PYTHONUNBUFFERED = '1'
  out.PYTHONDONTWRITEBYTECODE = '1'   // the AppImage mount is read-only
  // a processor-only helper's PyTorch / BLAS threads (cpuThreadsFor): cores stay free for playback
  if (threads > 0) {
    // loop: NOT-WORTH — four names, once per helper spawn
    for (const k of ['OMP_NUM_THREADS', 'MKL_NUM_THREADS', 'OPENBLAS_NUM_THREADS', 'NUMEXPR_NUM_THREADS']) out[k] = String(threads)
  }
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
// cache: OK — key=a spawned helper child; invalidated=gone() on its exit or error; bound=one helper (two while an old one quits)
const live = new Set()
process.on('exit', () => { for (const p of live) { try { p.kill('SIGKILL') } catch (e) {} } })

/**
 * The wait before an idle helper quits (ms, ≥ 0): the limit for the views' state minus the time it has
 * already been idle. idleFor: ms since the last job ended; warm: a lyric view is open.
 */
// Processor-only PCs (0.15.59, Marcy's laptop: Sonata at 53 % CPU and 3.5 GiB after an album on repeat,
// words jumping): the helper runs at a lower priority than playback (HELPER_NICE: the music, Apple's page and
// the lyric clock always come first) and with CPU_FREE cores left free (its PyTorch threads, OMP_NUM_THREADS);
// with its models loaded it holds ~3 GB of memory, so it quits after IDLE_MS idle even while a view is open.
const HELPER_NICE = 10
const CPU_FREE = 2

/**
 * The PyTorch threads for a processor-only helper: the physical cores this process may use, CPU_FREE left
 * free (at least 1). cpus: [{ cpu, core }] (core: a physical core's id, e.g. "package:core").
 */
function cpuThreadsFor(cpus) {
  // loop: NOT-WORTH — the allowed CPUs (≤ a few dozen) · once per helper spawn
  const cores = new Set((cpus || []).map((c) => c.core))
  return Math.max(1, cores.size - CPU_FREE)
}

/** The CPUs this process may run on, with their physical core (Linux sysfs; elsewhere os.cpus(), one core each). */
function allowedCpus(read = (f) => require('fs').readFileSync(f, 'utf8')) {
  // error: NOT-WORTH — no /proc or sysfs (another OS, a sandbox): every logical CPU counts as its own core
  try {
    const list = /Cpus_allowed_list:\s*(\S+)/.exec(read('/proc/self/status'))[1]
    const ids = []
    // loop: NOT-WORTH — a few ranges, once per helper spawn
    for (const part of list.split(',')) { const [a, b] = part.split('-').map(Number); for (let i = a; i <= (b === undefined ? a : b); i++) ids.push(i) }
    // loop: NOT-WORTH — the allowed CPUs (≤ a few dozen), once per helper spawn
    return ids.map((cpu) => {
      const t = '/sys/devices/system/cpu/cpu' + cpu + '/topology/'
      let core = String(cpu)
      try { core = read(t + 'physical_package_id').trim() + ':' + read(t + 'core_id').trim() } catch (e) {}   // error: NOT-WORTH — no topology: its own core
      return { cpu, core }
    })
  } catch (e) {
    // loop: NOT-WORTH — os.cpus() (≤ a few dozen) · once per helper spawn, only without /proc
    return os.cpus().map((c, i) => ({ cpu: i, core: String(i) }))
  }
}

function idleDelay(idleFor, warm, coldMs = IDLE_MS, warmMs = WARM_IDLE_MS) {
  return Math.max(0, (warm ? warmMs : coldMs) - Math.max(0, idleFor || 0))
}

/**
 * The `want` of a notes request: what the caller asks for that this helper says it serves (its pong's
 * features). want: e.g. ['expr'] (Expressive words); features: the pong's list. -> the list, or null
 * (nothing to ask: an older engine gets today's request, byte for byte).
 */
function wantFor(want, features) {
  if (!Array.isArray(want) || !Array.isArray(features)) return null
  // loop: NOT-WORTH — ≤ 3 wanted features · once per notes job or stream start
  const got = want.filter((w) => features.includes(w))
  return got.length ? got : null
}

/** messages with `want` on the first one (the job's header), lazily: a generator over a generator. */
function * withWant(messages, want) {
  let first = true
  // loop: SERIAL-REQUIRED — the job's messages in protocol order (passes write()'s pacing through)
  for (const m of messages) {
    yield first ? Object.assign({}, m, { want }) : m
    first = false
  }
}

/**
 * createAlignHelper({ paths, env?, log?, idleMs?, warmIdleMs?, warm?, jobTimeoutMs?, want? }, deps?)
 *   -> { installed(), ping(), align(id, messages), notes, pitch, separate, givenNotes, prepareNotes, viewsChanged(), release(), forget, stop(), running }
 * warm() -> true while a lyric view is open (the longer idle limit applies)
 * want() -> what a notes job asks for beyond the notes, e.g. ['expr'] (Expressive words); asked of a
 *   helper only when its pong lists the feature (a ping first when this helper process hasn't answered one)
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
  // processor only (the last pong said cpu, or the installed build is the CPU one): see HELPER_NICE
  const cpuOnly = opts.cpu || (() => false)
  const setPriority = deps.setPriority || ((pid, n) => os.setPriority(pid, n))
  const cpuThreads = deps.cpuThreads || (() => cpuThreadsFor(allowedCpus()))
  const now = deps.now || Date.now
  let idleSince = 0           // when the last job ended (0: busy or not running)
  const jobTimeoutMs = opts.jobTimeoutMs || JOB_TIMEOUT_MS
  let child = null
  // cache: OK — key=job id; invalidated=done/fail (result, error, timeout via touch, exit via gone); bound=jobs in flight (≤ ~3)
  let pending = new Map()     // id -> { resolve, reject, timer, ms }
  let pings = []              // pong replies carry no id: answered in order (a timed-out ping keeps its slot)
  let idle = null
  let crashes = 0
  let quitting = null         // the child we asked to quit
  let releasing = false       // release(): quit as soon as the current job is done (gaming guard)
  // cache: OK — key=none (the helper's last stderr lines); invalidated=reset at each spawn; bound=20 lines of ≤ one chunk each
  let stderrTail = []
  // cache: OK — key=the running helper process; invalidated=its exit (gone) and every new pong; bound=one list
  let features = null         // the running helper's pong features (null: none answered since it started)
  // cache: OK — key=the installed engine; invalidated=every pong (an updated engine answers its own); bound=one list
  let known = null            // the last pong's features from any helper process (serves(): before this one has answered)

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
    const wait = idleDelay(now() - idleSince, !!warm() && !cpuOnly(), idleMs, warmIdleMs)
    if (!wait) { quit(); return }
    // loop: none · one-shot idle timer · re-armed after each job and when the lyric views open/close · fires once: quit the helper
    idle = setT(() => { idle = null; if (!pending.size) quit() }, wait)
    if (idle && idle.unref) idle.unref()
  }

  function onMessage(msg, from) {
    if (msg.type === 'pong') {
      // a pong from a helper already replaced belongs to none of this one's pings
      if (from && from !== child) return
      // in order: a timed-out ping keeps its place (done() then finds no job), so its late pong never answers the next one
      const id = pings.shift()
      if (id) done(id, msg)
    } else if (msg.type === 'stream' || msg.type === 'words' || msg.type === 'notes') {
      // look-ahead play's streaming job (stream()): its ready state, its committed words and each line's notes
      touch(msg.id)
      const p = pending.get(msg.id)
      if (p && p.progress) p.progress(msg)
    } else if (msg.type === 'progress') {
      touch(msg.id)
      const p = pending.get(msg.id)
      if (p && p.progress) p.progress(msg)
    }
    else if (msg.type === 'result') {
      // the job's stats for main's measured helper speed (helper-speed.js: pure, never throws)
      if (opts.onResult) opts.onResult(msg)
      done(msg.id, msg)
    }
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
    if (!installedFn()) throw new Error('sonata-align is not installed (Settings → Precise timing → Install)')
    const p = opts.paths
    const cpu = !!cpuOnly()
    const c = doSpawn(p.python, ['-u', p.server], { stdio: ['pipe', 'pipe', 'pipe'], env: helperEnv(opts.env || process.env, p.home, cpu ? cpuThreads() : 0) })
    // below playback (HELPER_NICE), set before the helper starts its threads (they inherit it): on a busy
    // PC the music, Apple's page and the lyric clock always come first
    // error: LOGGED-OK — no pid (spawn failed: 'error' follows) or not allowed: the helper runs at the normal priority
    try { if (c && c.pid) setPriority(c.pid, HELPER_NICE) } catch (e) { log('helper priority: ' + e.message) }
    // lifetime: OK — one helper child · ends on quit (idle), stop(), a timeout kill, its own crash, or process exit (live)
    child = c
    releasing = false
    live.add(c)
    stderrTail = []
    c.stdout.setEncoding('utf8')
    c.stdout.on('data', lineParser((m) => onMessage(m, c), (line) => log('helper said: ' + line.slice(0, 200))))
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
    features = null
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

  function request(id, messages, ms, progress) {
    return new Promise((resolve, reject) => {
      let c
      // error: PASSES-ON — not installed / crashed too often: the caller's promise rejects (Settings shows it, the session logs it)
      try { c = ensure() } catch (e) { reject(e); return }
      if (idle) { clearT(idle); idle = null }
      idleSince = 0
      pending.set(id, { resolve, reject, timer: null, ms, progress: progress || null })
      touch(id)
      write(c, messages).catch((e) => fail(id, e))   // error: PASSES-ON — the job's promise rejects
    })
  }

  // what this notes job may ask for (opts.want, filtered by the helper's features); a helper that hasn't
  // answered a ping since it started is asked first (it is running: it keeps the song's stem)
  // error: NOT-WORTH — a failed ping only means nothing extra is asked: the notes job itself still runs (and reports its own failure)
  function wanted() {
    const want = opts.want ? opts.want() : null
    if (!Array.isArray(want) || !want.length) return Promise.resolve(null)
    if (features && child) return Promise.resolve(wantFor(want, features))
    // error: NOT-WORTH — a failed ping only means nothing extra is asked; the notes job reports its own failure
    return api.ping().then(() => wantFor(want, features), () => null)
  }

  let pingN = 0
  const api = {
    installed: () => installedFn(),
    /** -> pong { version, device, gpu?, models } */
    ping() {
      const id = '__ping' + (++pingN)
      pings.push(id)
      // error: PASSES-ON — rethrown to askAlignStatus (main.js), which shows it in Settings
      // a ping that failed while its helper still runs keeps its slot in `pings`: a late pong is dropped
      // there, never given to the next ping (QC #3); with no helper (never sent, or exited) the slot goes
      return request(id, [{ cmd: 'ping' }], PING_TIMEOUT_MS).catch((e) => { if (!child) pings = pings.filter((p) => p !== id); throw e }).then(checkProtocol)
        .then((pong) => { features = known = Array.isArray(pong.features) ? pong.features : []; return pong })
    },
    /** messages: iterable of protocol messages for job `id` (align-session.js alignMessages) */
    align(id, messages) { return request(id, messages, jobTimeoutMs) },
    /**
     * Sung notes (notes-log.js): the notes step on the stem the helper kept from this song's
     * whole-song job (align request with notes: true). syl: per request line, per word the syllable
     * texts or null. -> result { notes, stats }; error codes no-stem, no-model, low-vram
     */
    notes(id, song, syl) {
      return wanted().then((want) => request(id, [Object.assign({ cmd: 'notes', id, song, syl }, want ? { want } : {})], jobTimeoutMs))
    },
    /**
     * Sheet notes in the Studio, first play: the pitch line of one section the helper kept (the section
     * job's song id and offset). -> result { pitch: { t0, hop, v }, stats }; error codes no-stem, no-model, low-vram
     */
    pitch(id, song, offset) { return request(id, [{ cmd: 'pitch', id, song, offset }], jobTimeoutMs) },
    /**
     * First play (engine feature "section-notes", 0.2.7): the pitch line of one kept section plus its notes and,
     * when wanted, its Expressive words, from the same pitch pass. given: { syllables (the section's own lines,
     * song time), lines, span: [a, b], language? }. -> result { pitch, notes: { notes, syllables, pitch, expr?,
     * section }, stats }; the same error codes as pitch()
     */
    sectionNotes(id, song, offset, given) {
      return wanted().then((want) => request(id, [Object.assign({ cmd: 'pitch', id, song, offset, want: ['notes'].concat(want || []),
        given: { syllables: given.syllables, lines: given.lines || [] }, span: given.span }, given.language ? { language: given.language } : {})], jobTimeoutMs))
    },
    /**
     * Sheet notes for lyrics with their own word timing (Apple's): one section only separated and kept
     * (align-session.js separateMessages; no alignment). -> result { kept, stats }; error code low-vram
     */
    separate(id, messages) { return request(id, messages, jobTimeoutMs) },
    /**
     * The notes of such a song on the times its lyrics carry (align-session.js givenNotesMessages): from
     * the kept sections, or from the streamed song. -> result { notes, stats }; codes no-stem, no-model, low-vram
     */
    givenNotes(id, messages) { return wanted().then((want) => request(id, want ? withWant(messages, want) : messages, jobTimeoutMs)) },
    /**
     * Downloads (and loads) the alignment models now: Demucs and the aligner for `language` (Settings →
     * Precise timing's install, its last step, when the install has none). onProgress(msg): the helper's
     * progress messages ({ stage: 'download', p, detail }). -> result { ready, device }
     */
    prepare(language, onProgress) {
      const id = '__prepare' + (++pingN)
      return request(id, [{ cmd: 'prepare', id, mode: 'align', language: language || 'en' }], jobTimeoutMs, onProgress)
    },
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
    /**
     * Look-ahead play (lookahead.js, align-session.js lookahead mode): one streaming alignment while the
     * song plays, the helper hearing it `lead` s before the listener (docs/LEVEL2-ALIGN.md "stream").
     * head: { song, lines, language?, lead, duration?, rate }. on(msg): the helper's 'stream' (ready) and
     * 'words' messages. -> { done: Promise<result>, chunk(t, pcm), end(), cancel() }; the helper is spawned
     * for it like for any job; the job's quiet limit is the song's length (words come only where someone sings).
     * error: PASSES-ON — `done` rejects on the helper's error (codes no-gpu, plain, busy, no-model) or its exit
     */
    stream(id, head, on) {
      const quietMs = Math.max(jobTimeoutMs, ((Number(head.duration) || 0) + 60) * 1000)
      const msg = { cmd: 'stream', id, song: head.song, lines: head.lines, lead: head.lead, audio: { format: 's16le', rate: head.rate || 22050, channels: 2 } }
      if (head.language) msg.language = head.language
      if (head.duration) msg.duration = head.duration
      // first play: each line's notes (and Expressive words) ride with its words (engine feature "stream-notes")
      if (head.notes && features && features.includes('stream-notes')) msg.want = ['notes'].concat(wantFor(opts.want ? opts.want() : [], features) || [])
      const done = request(id, [msg], quietMs, on)
      let open = true
      const send = (m) => {
        if (!open || !child) return
        // error: NOT-WORTH — a closed pipe: the helper is gone; `done` rejects through its exit
        try { child.stdin.write(JSON.stringify(m) + '\n') } catch (e) {}
      }
      return {
        done,
        /** t: the song time (s) of the chunk's first frame; pcm: s16le stereo at head.rate */
        chunk(t, pcm) { send({ cmd: 'chunk', id, t: Math.round(t * 1000) / 1000, data: pcm.toString('base64') }) },
        end() { send({ cmd: 'end', id }); open = false },
        cancel() { send({ cmd: 'cancel', id }); open = false; fail(id, Object.assign(new Error('cancelled'), { code: 'cancelled' })) }
      }
    },
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
    get running() { return !!child },
    /** Whether the engine said it serves a feature (its last pong, e.g. 'expr'); false before any pong. */
    serves(feature) { return !!known && known.includes(feature) },
    /** Whether any helper process answered a ping yet (serves() is only meaningful then). */
    get answered() { return !!known }
  }
  return api
}

module.exports = { PROTOCOLS, enginePin, activeEngine, olderEngine, checkProtocol, inAppSandbox, helperPaths, isInstalled, checkInstall, repairText, helperEnv, lineParser, createAlignHelper, wantFor, withWant, idleDelay, IDLE_MS, WARM_IDLE_MS, HELPER_NICE, CPU_FREE, cpuThreadsFor, allowedCpus }
