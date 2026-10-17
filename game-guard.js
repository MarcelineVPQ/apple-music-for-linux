// Gaming guard for Precise word timing (Settings → "Pause word timing while gaming", on by default;
// docs/research/gpu-lyrics-pipeline-2026-10.md §5). While a game runs, the sonata-align helper
// starts no new job and quits after its current one (frees 1.8–3 GB of graphics memory); the song
// keeps its estimate and Level 1 timing, and the sections it missed fill in on a later play (the
// partial entry, align-session.js). Alignment resumes RESUME_MS after the last signal cleared.
//
// Signals, cheapest first; each one is a no-op where it isn't available (null = "can't tell"):
//   game  Feral GameMode: com.feralinteractive.GameMode ClientCount > 0 on the session bus (gdbus)
//   game  a Steam game: a `reaper SteamLaunch AppId=<n>` process (Steam's game launcher), from /proc
//   gpu   NVIDIA: other processes' SM use (nvidia-smi pmon, our own pids left out) > NV_BUSY %
//   gpu   AMD (only without NVIDIA): /sys/class/drm/card*/device/gpu_busy_percent > AMD_BUSY %
//         a gpu signal needs BUSY_POLLS polls in a row (a short burst is not a game)
// Not available, so never a signal: GameMode not installed or not on the bus; Steam not used;
// no nvidia-smi (AMD, Intel, nouveau); Intel GPUs (no busy figure); inside a Flatpak sandbox /proc
// shows only the sandbox, the session bus needs --talk-name=com.feralinteractive.GameMode, and
// nvidia-smi isn't there. Sonata is a Linux app; on any other OS every probe is off.
//
// Electron-free: the parsers and the decision are tested with stubs (test/game-guard.test.js).
'use strict'
const PROBE_MS = 5000          // at most one check per 5 s (piggybacks on the lyrics poll, no timer of its own)
const RESUME_MS = 30000        // resume 30 s after the last signal cleared (a loading screen isn't the end)
const NV_BUSY = 30             // % SM of other processes (NVIDIA)
const AMD_BUSY = 50            // % gpu_busy_percent (AMD)
const BUSY_POLLS = 2

/** gdbus' reply to Properties.Get ClientCount: "(<1>,)" or "(<int32 1>,)" -> 1; else null. */
function parseGameModeCount(out) {
  const m = /\(\s*<\s*(?:int32\s+)?(-?\d+)\s*>\s*,?\s*\)/.exec(String(out || ''))
  return m ? Number(m[1]) : null
}

/** Steam's game launcher in a /proc cmdline (NUL-separated): `reaper SteamLaunch AppId=<n> -- …`. */
function isSteamGame(cmdline) {
  const parts = String(cmdline || '').split('\0')
  if (!parts.includes('SteamLaunch')) return false
  const id = parts.map((p) => /^AppId=(\d+)$/.exec(p)).find(Boolean)
  return !!id && id[1] !== '0'
}

/**
 * `nvidia-smi pmon -c 1 -s u`: the summed SM % of processes that aren't ours, or null when the
 * output isn't a pmon table. Rows: "gpu pid type sm mem enc dec … command"; "-" counts as 0.
 */
function parsePmon(out, ownPids) {
  const own = ownPids instanceof Set ? ownPids : new Set(ownPids || [])
  const lines = String(out || '').split('\n')
  const head = lines.find((l) => /^#\s*gpu\s+pid\s+type\s+sm\b/.test(l))
  if (!head) return null
  let sum = 0
  // loop: NOT-WORTH — one pass over pmon's rows (one per GPU process, a few dozen) · per check
  for (const l of lines) {
    if (!l.trim() || l.startsWith('#')) continue
    const c = l.trim().split(/\s+/)
    const pid = Number(c[1])
    if (!Number.isInteger(pid) || own.has(pid)) continue
    const sm = Number(c[3])
    if (Number.isFinite(sm)) sum += sm
  }
  return sum
}

/**
 * One poll's signals -> the next state. sample: { gamemode: n|null, steam: bool|null,
 * nvBusy: % | null, amdBusy: % | null }. state: { paused, reason ('game'|'gpu'|''), lastSignal, busyPolls }.
 */
function decide(prev, sample, now, opts = {}) {
  const resumeMs = opts.resumeMs == null ? RESUME_MS : opts.resumeMs
  const p = prev || { paused: false, reason: '', lastSignal: -Infinity, busyPolls: 0 }
  const game = (sample.gamemode != null && sample.gamemode > 0) || sample.steam === true
  const busyNow = sample.nvBusy != null ? sample.nvBusy > NV_BUSY : sample.amdBusy != null ? sample.amdBusy > AMD_BUSY : false
  const busyPolls = busyNow ? p.busyPolls + 1 : 0
  const gpu = busyPolls >= BUSY_POLLS
  if (game || gpu) return { paused: true, reason: game ? 'game' : 'gpu', lastSignal: now, busyPolls }
  if (p.paused && now - p.lastSignal < resumeMs) return Object.assign({}, p, { busyPolls })
  return { paused: false, reason: '', lastSignal: p.lastSignal, busyPolls }
}

/** The words for the lyric views' source note and the rail, '' when not paused. */
function pauseText(state) {
  if (!state || !state.paused) return ''
  return state.reason === 'gpu' ? 'Precise timing paused while the graphics card is busy' : 'Precise timing paused while you play'
}

/**
 * The Linux probes. deps: { execFile(cmd, args, opts, cb), fs (readdirSync, readFileSync),
 * ownPids() -> pids, platform }. A probe whose tool is missing (ENOENT) is off for the app's run,
 * so it isn't spawned again every 5 s. Measured per check on Marcy's PC (~800 processes): the first
 * /proc scan 4.6 ms (later ones read only new pids), gdbus and nvidia-smi ~10 ms each as children.
 * error: NOT-WORTH — every probe failure means "can't tell" (null), never a pause and never an error shown
 */
function linuxProbes(deps) {
  const off = new Set()
  const run = (name, cmd, args) => new Promise((resolve) => {
    if (off.has(name)) return resolve(null)
    // lifetime: OK — one short child per probe; killed by the 3 s timeout, ends with its answer
    deps.execFile(cmd, args, { timeout: 3000, encoding: 'utf8' }, (err, stdout) => {
      if (err && err.code === 'ENOENT') off.add(name)
      resolve(err ? null : stdout)
    })
  })
  // lifetime: pid -> comm of the processes seen, pruned to the live ones at every scan
  let comms = new Map()
  function steam() {
    let pids
    // error: NOT-WORTH — no /proc (not Linux, a sandbox): "can't tell"
    try { pids = deps.fs.readdirSync('/proc').filter((n) => /^\d+$/.test(n)) } catch (e) { return null }
    const next = new Map()
    let found = false
    // loop: NOT-WORTH — one pass over /proc (~800 processes; comm read once per new pid, cmdline only for "reaper") · per check
    for (const pid of pids) {
      let comm = comms.get(pid)
      if (comm === undefined) {
        // error: NOT-WORTH — the process ended between readdir and read
        try { comm = deps.fs.readFileSync('/proc/' + pid + '/comm', 'utf8').trim() } catch (e) { continue }
      }
      next.set(pid, comm)
      if (comm !== 'reaper' || found) continue
      // error: NOT-WORTH — the reaper ended meanwhile: not a game now
      try { found = isSteamGame(deps.fs.readFileSync('/proc/' + pid + '/cmdline', 'utf8')) } catch (e) {}
    }
    comms = next
    return found
  }
  function amd() {
    let cards
    // error: NOT-WORTH — no DRM sysfs: "can't tell"
    try { cards = deps.fs.readdirSync('/sys/class/drm').filter((n) => /^card\d+$/.test(n)) } catch (e) { return null }
    let best = null
    // loop: NOT-WORTH — one pass over the DRM cards (one or two) · per check
    for (const c of cards) {
      try {
        const vendor = deps.fs.readFileSync('/sys/class/drm/' + c + '/device/vendor', 'utf8').trim()
        if (vendor !== '0x1002') continue
        const v = Number(deps.fs.readFileSync('/sys/class/drm/' + c + '/device/gpu_busy_percent', 'utf8').trim())
        if (Number.isFinite(v)) best = Math.max(best == null ? 0 : best, v)
      } catch (e) {}   // error: NOT-WORTH — a card without these files (not AMD, an old kernel) is skipped
    }
    return best
  }
  return {
    async sample() {
      if (deps.platform !== 'linux') return { gamemode: null, steam: null, nvBusy: null, amdBusy: null }
      const gm = parseGameModeCount(await run('gamemode', 'gdbus', ['call', '--session', '--dest', 'com.feralinteractive.GameMode',
        '--object-path', '/com/feralinteractive/GameMode', '--method', 'org.freedesktop.DBus.Properties.Get',
        'com.feralinteractive.GameMode', 'ClientCount']))
      const st = gm > 0 ? null : steam()
      const nvOut = await run('nvidia', 'nvidia-smi', ['pmon', '-c', '1', '-s', 'u'])
      const nvBusy = nvOut == null ? null : parsePmon(nvOut, deps.ownPids())
      const amdBusy = nvBusy == null ? amd() : null
      return { gamemode: gm, steam: st, nvBusy, amdBusy }
    }
  }
}

/**
 * createGameGuard({ probes: { sample() }, now(), onChange(state), log? })
 *   maybeCheck() -> Promise<state>  at most one sample per PROBE_MS; concurrent calls share it
 *   state, paused, reset()
 * lifetime: no timer of its own; main calls maybeCheck from the lyrics poll while precise timing has
 * work (a song still to align or the helper running), so nothing runs while it doesn't.
 */
function createGameGuard(opts) {
  const now = opts.now || (() => Date.now())
  const probeMs = opts.probeMs || PROBE_MS
  let state = { paused: false, reason: '', lastSignal: -Infinity, busyPolls: 0 }
  let last = -Infinity
  let busy = null
  return {
    maybeCheck() {
      if (busy) return busy
      if (now() - last < probeMs) return Promise.resolve(state)
      last = now()
      busy = Promise.resolve()
        .then(() => opts.probes.sample())
        .then((sample) => {
          const before = state
          state = decide(state, sample, now(), opts)
          if (before.paused !== state.paused || before.reason !== state.reason) {
            if (opts.log) opts.log(state.paused ? 'precise timing paused (' + state.reason + ')' : 'precise timing resumed')
            if (opts.onChange) opts.onChange(state)
          }
          return state
        })
        .catch(() => state)       // error: NOT-WORTH — a failed check keeps the current state
        .finally(() => { busy = null })
      return busy
    },
    reset() {
      const was = state.paused
      state = { paused: false, reason: '', lastSignal: -Infinity, busyPolls: 0 }
      last = -Infinity
      if (was && opts.onChange) opts.onChange(state)
    },
    get state() { return state },
    get paused() { return state.paused }
  }
}

module.exports = { PROBE_MS, RESUME_MS, NV_BUSY, AMD_BUSY, parseGameModeCount, isSteamGame, parsePmon, decide, pauseText, linuxProbes, createGameGuard }
