// "Refine timing by listening": captures Sonata's OWN playback stream (never the whole system)
// through PulseAudio/PipeWire, so lyrics word timing can be checked against the singing.
// Like visualizer.js it reads the decoded output with parec (DRM audio can't be analysed in the
// page), but it monitors only our sink input: `parec --monitor-stream=<index>`.
// Audio is handed to onChunk in memory and never stored or sent anywhere.
//
// Stream matching: Electron plays audio from a utility child process, so the sink input's
// application.process.id is a child of the main process, not process.pid. We collect our process
// tree from /proc and take the sink input whose PID is in it. Only when a stream carries no PID
// at all do we accept a name match, and then only on our own names (Sonata /
// apple-music-for-linux), never a generic "Chromium"/"Electron", so another Sonata copy or a
// browser is never picked by name alone.
const fs = require('fs')
const { spawn, execFile } = require('child_process')

const RATE = 22050
const OWN_NAME = /sonata|apple-music-for-linux/i
const GENERIC_NAME = /sonata|apple-music-for-linux|chromium|electron/i
const BACKOFF_MS = [500, 1000, 2000, 4000, 8000]
const MAX_FAILS = 6           // consecutive failed starts (no stream, parec died before data)
const STALL_MS = 3000         // no audio this long while running: the stream probably changed

// --- pure helpers (tested in test/listen-wiring.test.js) ---

/** PIDs in the tree under rootPid, from a list of { pid, ppid } (rootPid included). */
function descendants(rootPid, procs) {
  const kids = new Map()
  for (const p of procs) {
    if (!kids.has(p.ppid)) kids.set(p.ppid, [])
    kids.get(p.ppid).push(p.pid)
  }
  const out = new Set([rootPid])
  const stack = [rootPid]
  // loop: tree walk · bounded by the process count · each pid visited once (Set guard)
  while (stack.length) {
    for (const c of kids.get(stack.pop()) || []) if (!out.has(c)) { out.add(c); stack.push(c) }
  }
  return out
}

/**
 * Our sink input from `pactl -f json list sink-inputs` output (parsed array), or null.
 * pids: Set of our process tree. Prefers a PID match; among several, a running (uncorked) one,
 * then the newest (highest index).
 */
function pickSinkInput(list, pids, opts = {}) {
  if (!Array.isArray(list)) return null
  const name = opts.name || null
  const scored = []
  for (const s of list) {
    if (!s || s.index == null) continue
    const p = s.properties || {}
    const pid = parseInt(p['application.process.id'], 10)
    const label = [p['application.name'], p['application.process.binary'], p['node.name']].filter(Boolean).join(' ')
    let score = 0
    if (Number.isFinite(pid)) {
      if (pids && pids.has(pid) && GENERIC_NAME.test(label)) score = 3
      else if (pids && pids.has(pid)) score = 2
    } else if (name ? label.includes(name) : OWN_NAME.test(label)) score = 1
    if (score) scored.push({ s, score })
  }
  scored.sort((a, b) => b.score - a.score || (a.s.corked ? 1 : 0) - (b.s.corked ? 1 : 0) || b.s.index - a.s.index)
  return scored.length ? scored[0].s : null
}

/**
 * Interleaved s16le stereo bytes -> { mid, side } Float32Arrays ((L+R)/2 and (L-R)/2, -1..1).
 * Only whole frames (4 bytes) are converted; the caller keeps the remainder.
 */
function toMidSide(buf) {
  const frames = Math.floor(buf.length / 4)
  const mid = new Float32Array(frames)
  const side = new Float32Array(frames)
  // loop: one pass over the chunk's frames (~440 per 20 ms chunk) · ends with the buffer
  for (let i = 0; i < frames; i++) {
    const l = buf.readInt16LE(i * 4) / 32768
    const r = buf.readInt16LE(i * 4 + 2) / 32768
    mid[i] = (l + r) / 2
    side[i] = (l - r) / 2
  }
  return { mid, side }
}

// --- process tree from /proc ---

function readChildren(pid) {
  // /proc/<pid>/task/<tid>/children lists direct children (CONFIG_PROC_CHILDREN)
  const out = []
  for (const tid of fs.readdirSync('/proc/' + pid + '/task')) {
    const txt = fs.readFileSync('/proc/' + pid + '/task/' + tid + '/children', 'utf8').trim()
    if (txt) for (const c of txt.split(/\s+/)) out.push({ pid: +c, ppid: pid })
  }
  return out
}

function scanProc() {
  const out = []
  for (const name of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(name)) continue
    try {
      const stat = fs.readFileSync('/proc/' + name + '/stat', 'utf8')
      const ppid = parseInt(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1], 10)
      out.push({ pid: +name, ppid })
    } catch (e) { /* process gone */ }
  }
  return out
}

/** Our process tree: cheap per-process children files, else a full /proc scan. */
function ownProcessTree(rootPid) {
  try {
    const procs = []
    const stack = [rootPid]
    const seen = new Set()
    // loop: tree walk over our own processes (~10 for Electron) · each pid once
    while (stack.length) {
      const pid = stack.pop()
      if (seen.has(pid)) continue
      seen.add(pid)
      let kids = []
      try { kids = readChildren(pid) } catch (e) { if (pid === rootPid) throw e }
      for (const k of kids) { procs.push(k); stack.push(k.pid) }
    }
    return descendants(rootPid, procs)
  } catch (e) {
    return descendants(rootPid, scanProc())
  }
}

// --- listener ---

// lifetime: every live parec child is in this Set until it exits; killed on process exit so a
// crash or app.exit() never leaves one behind
const liveProcs = new Set()
process.on('exit', () => { for (const p of liveProcs) { try { p.kill('SIGKILL') } catch (e) {} } })

/**
 * createListener({ appPid?, sinkInputName?, sampleRate?, onChunk(mid, wallMs, side), log? })
 * -> { start(), stop(), state }   state: 'idle' | 'finding' | 'running' | 'unavailable'
 * deps (tests): { spawn, execFile, processTree, now, setTimeout, clearTimeout }
 */
function createListener(opts, deps = {}) {
  const appPid = opts.appPid || process.pid
  const rate = opts.sampleRate || RATE
  const log = opts.log || ((m) => console.log('listen:', m))
  const doSpawn = deps.spawn || spawn
  const doExecFile = deps.execFile || execFile
  const tree = deps.processTree || ownProcessTree
  const now = deps.now || (() => performance.now())
  const setT = deps.setTimeout || setTimeout
  const clearT = deps.clearTimeout || clearTimeout

  let state = 'idle'
  let proc = null
  let index = null
  let rest = Buffer.alloc(0)
  let fails = 0
  let retry = null
  let watchdog = null
  let lastData = 0
  let gen = 0               // bumps on stop(), so late callbacks from an old run are ignored

  function find(cb) {
    // error: pactl missing or slow -> null (counts as a failed start, retried with backoff)
    doExecFile('pactl', ['-f', 'json', 'list', 'sink-inputs'], { timeout: 2000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
      if (err) return cb(null)
      let list = null
      try { list = JSON.parse(String(stdout)) } catch (e) { return cb(null) }
      let pids
      try { pids = tree(appPid) } catch (e) { pids = new Set([appPid]) }
      const s = pickSinkInput(list, pids, { name: opts.sinkInputName })
      cb(s ? s.index : null)
    })
  }

  function scheduleRetry(my) {
    if (my !== gen) return
    fails++
    if (fails >= MAX_FAILS) {
      state = 'unavailable'
      log('own audio stream unavailable, listening off until the next start')
      return
    }
    // loop: re-find · backoff 0.5, 1, 2, 4, 8 s · at most MAX_FAILS consecutive attempts · stops on
    // data (resets), on stop(), or at 'unavailable' · cost one pactl call per attempt
    retry = setT(() => { retry = null; attempt(my) }, BACKOFF_MS[Math.min(fails - 1, BACKOFF_MS.length - 1)])
  }

  function attempt(my) {
    if (my !== gen) return
    state = 'finding'
    find((idx) => {
      if (my !== gen) return
      if (idx == null) return scheduleRetry(my)
      run(my, idx)
    })
  }

  function run(my, idx) {
    index = idx
    rest = Buffer.alloc(0)
    let child
    try {
      child = doSpawn('parec', ['--monitor-stream=' + idx, '--format=s16le', '--channels=2',
        '--rate=' + rate, '--raw', '--latency-msec=20', '--process-time-msec=10'], { stdio: ['ignore', 'pipe', 'ignore'] })
    } catch (e) {
      log('parec not available: ' + e.message)
      state = 'unavailable'
      return
    }
    // lifetime: one parec child per run · ends on stop() (SIGTERM), on stream removal (parec exits
    // by itself) or on process exit (liveProcs)
    proc = child
    liveProcs.add(child)
    state = 'running'
    lastData = now()
    let gotData = false
    child.stdout.on('data', (chunk) => {
      if (my !== gen || proc !== child) return
      const wallMs = now()
      lastData = wallMs
      if (!gotData) { gotData = true; fails = 0 }
      const buf = rest.length ? Buffer.concat([rest, chunk]) : chunk
      const whole = buf.length - (buf.length % 4)
      rest = whole < buf.length ? Buffer.from(buf.subarray(whole)) : Buffer.alloc(0)
      if (!whole) return
      const { mid, side } = toMidSide(buf.subarray(0, whole))
      try { opts.onChunk(mid, wallMs, side) } catch (e) { log('chunk handler failed: ' + e.message) }
    })
    // error: spawn failure (ENOENT) arrives here; exit handles the retry
    child.on('error', (e) => log('parec error: ' + e.message))
    child.on('exit', () => {
      liveProcs.delete(child)
      if (proc !== child) return
      proc = null
      if (my !== gen) return
      // the stream went away (track change can recreate it) or parec failed: find it again
      clearWatchdog()
      if (gotData) fails = 0
      scheduleRetry(my)
    })
    startWatchdog(my)
  }

  function startWatchdog(my) {
    clearWatchdog()
    // loop: stall watchdog · every 1 s while running · if no audio for STALL_MS, re-find the stream
    // and switch when its index changed (a corked old stream gives no data) · stops on stop() or
    // parec exit · cost a timer check per second, one pactl call per stall
    watchdog = setT(function check() {
      watchdog = null
      if (my !== gen || !proc) return
      if (now() - lastData < STALL_MS) { watchdog = setT(check, 1000); return }
      find((idx) => {
        if (my !== gen || !proc) return
        lastData = now()
        if (idx != null && idx !== index) {
          const old = proc
          proc = null
          liveProcs.delete(old)
          try { old.kill() } catch (e) {}
          run(my, idx)
        } else watchdog = setT(check, 1000)
      })
    }, 1000)
  }

  function clearWatchdog() { if (watchdog) { clearT(watchdog); watchdog = null } }

  return {
    start() {
      if (state === 'running' || state === 'finding') return
      gen++
      fails = 0
      attempt(gen)
    },
    // lifetime: stop() kills parec and cancels the retry and watchdog timers; nothing outlives it
    stop() {
      gen++
      if (retry) { clearT(retry); retry = null }
      clearWatchdog()
      if (proc) {
        const p = proc
        proc = null
        try { p.kill() } catch (e) {}
        // error: a parec that ignores SIGTERM is killed hard after 1 s
        const hard = setT(() => { if (liveProcs.has(p)) { try { p.kill('SIGKILL') } catch (e) {} } }, 1000)
        if (hard && hard.unref) hard.unref()
      }
      rest = Buffer.alloc(0)
      index = null
      state = 'idle'
    },
    get state() { return state },
    get index() { return index }
  }
}

module.exports = { createListener, pickSinkInput, descendants, toMidSide, ownProcessTree, RATE }
