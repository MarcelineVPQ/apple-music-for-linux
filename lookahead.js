// Look-ahead play (Experimental, Linux, Development builds): "First play: precise from the start".
// Design and measurements: docs/LOOKAHEAD.md.
//
// On a song's first play the listener hears Sonata's stream D seconds late (Precise: 3 s, Quick: 2 s),
// so the engine hears every word D seconds before it is sung and its word timing is there in time.
// Learned songs (word timing cached for this recording), songs with nothing to learn and music videos
// play with no delay. The delay itself is native code in PipeWire's graph (native/lookahead/,
// `sonata-lookahead`): Sonata's own stream goes into its virtual sink, the engine tap (audio-listen.js,
// parec --monitor-stream of that stream) still hears it undelayed, and the helper plays it to the
// default device D later. This file holds:
//   - the pure parts (tested in test/lookahead.test.js): what a song gets (decide, learnState), the heard
//     clock (heardClock), the mapping of player events to helper commands (commandsFor), parsers;
//   - the helper's line protocol client (createDelayLine);
//   - the controller (createLookahead): starts the helper, routes only Sonata's stream to it, follows the
//     player, keeps the heard delay for the clock, and falls back on its own when the helper dies.
// Electron-free: main.js gives it its children, sockets and page.
'use strict'

const DELAYS = Object.freeze({ precise: 3000, quick: 2000 })
const SINK = 'sonata-lookahead'            // the helper's virtual sink (node.name)
const OUT_NODE = 'sonata-lookahead-out'    // the helper's own output stream: never "Sonata's stream"
const READY_MS = 3000          // the helper's "ready" line, at most this long after spawn
const REPLY_MS = 2000          // a command's reply
const MAX_RESTARTS = 3         // a helper that dies is started again at most this often per run
const RESTART_MS = 5000
const DRAIN_SLACK_MS = 1500    // a drain waits D + this for "drained", then the player goes on anyway
const ROUTE_DEBOUNCE_MS = 50
const LOAD_SEEK_MS = 2000      // a seek to the start this soon after an item change is the new song loading
const LOAD_SEEK_S = 0.5
const CONFIRM_MS = 100         // a gate the player hasn't confirmed this soon is opened anyway (never a silent verse)
const BOUNDARY_SEEK_MS = 300   // a jump to a song's start waits this long for an item change (a song boundary is no seek)

// --- what a song gets ---

/** The delay of a choice (Settings → First play: precise from the start). */
function delayOf(choice) { return DELAYS[choice] || DELAYS.precise }

/**
 * Whether the switch is offered here: Linux (the delay is PipeWire code), Development builds only
 * (Stable hides it while it is experimental), and the helper binary shipped with this build.
 * -> { shown, ok, why }   why: '' | 'not-linux' | 'stable' | 'no-helper'
 */
function availability(env) {
  if (env.platform !== 'linux') return { shown: false, ok: false, why: 'not-linux' }
  if (!env.devBuild) return { shown: false, ok: false, why: 'stable' }
  if (!env.binary) return { shown: true, ok: false, why: 'no-helper' }
  return { shown: true, ok: true, why: '' }
}

/** Whether the helper runs at all: the switch on, available here, and Precise word timing on (the
 * switch's own condition). Off: no helper, and Sonata's stream stays on the user's own device. */
function wanted(settings, avail, preciseOn) {
  return !!(settings && settings.lookahead === true && avail && avail.ok && preciseOn)
}

/**
 * What Sonata knows about a song before it plays (no lookup, only the caches):
 *   'learned'  word timing cached for this recording (a complete aligned entry) and its notes and
 *              expression too (when Sheet notes / Expressive words want them): plays with no delay
 *   'notes'    its words are timed (Apple's own word timing, or a complete aligned entry) but its notes or
 *              expression aren't cached yet: a first play for them (0.15.70: Apple word-timed songs counted
 *              as 'nothing' and were never delayed, so their notes always came after the line was sung)
 *   'nothing'  no lyrics, an instrumental, lyrics with their own word timing whose notes are cached (or not
 *              wanted), or lyrics without line times (the stream needs them): nothing for look-ahead to do
 *   'first'    line-timed lyrics not aligned yet: a first play
 *   'unknown'  its lyrics were never looked up: a first play by definition (a learned song has them cached)
 * lyrics: the cached lyrics entry or null; aligned: the valid aligned entry or null; canAlign, hasWords:
 * align-session.js canAlign and lyrics-timing.js hasWordTiming; notesMissing: the song still needs its
 * notes or expression measured this play (main: the align session's notes.missing, with the switches on).
 */
function learnState(lyrics, aligned, canAlign, hasWords, notesMissing) {
  if (!lyrics) return 'unknown'
  const lines = lyrics.lines || []
  if (lyrics.instrumental || !lines.length || lines[0].t == null) return 'nothing'
  if (hasWords(lines)) return notesMissing ? 'notes' : 'nothing'
  if (!canAlign(lines)) return 'nothing'
  if (aligned && aligned.lines && !aligned.partial) return notesMissing ? 'notes' : 'learned'
  return 'first'
}

/**
 * The delay for a song, decided once at its start (never mid-song): first plays only.
 * s: { on, ok (helper running, stream routed), video, learn (learnState), engine ('ready' | 'old' | 'cpu' | 'off' |
 * 'unknown' | 'busy'), gpuBusy (the gaming guard's pause: 'game' | 'gpu' (other work on the graphics card) | false),
 * ms (the chosen delay) }
 * 0.15.70 (Marcy): every song not learned yet gets it, with or without a lyrics window or the Studio open (the
 * song is learned either way: main's feed runs while look-ahead does); only real reasons say no.
 * -> { ms, why }   why says what the status line tells
 */
function decide(s) {
  if (!s.on) return { ms: 0, why: 'off' }
  if (!s.ok) return { ms: 0, why: 'unavailable' }
  if (s.video) return { ms: 0, why: 'video' }
  if (s.learn === 'learned') return { ms: 0, why: 'learned' }
  if (s.learn === 'nothing') return { ms: 0, why: 'nothing' }
  if (s.gpuBusy) return { ms: 0, why: s.gpuBusy === 'game' ? 'gaming' : 'gpu-busy' }
  if (s.engine !== 'ready') return { ms: 0, why: 'engine-' + (s.engine || 'unknown') }
  return { ms: s.ms, why: s.learn === 'unknown' ? 'first' : s.learn }
}

/** The engine's readiness for a stream from its pong (align-helper ping) and Sonata's state. */
function engineState(pong, preciseOn) {
  if (!preciseOn) return 'off'
  if (!pong) return 'unknown'
  const features = Array.isArray(pong.features) ? pong.features : []
  if (!features.includes('stream')) return 'old'
  if (pong.stream_ready === false) return pong.stream_reason === 'no-gpu' ? 'cpu' : 'busy'
  return 'ready'
}

// The status line under the switch (honest: what the song playing now got, and why).
const WHY_TEXT = {
  first: 'This song plays {d} s behind: its first play',
  notes: 'This song plays {d} s behind: learning its notes',
  learned: 'No delay: this song is learned',
  nothing: 'No delay: nothing to learn in this song',
  video: 'No delay: music videos are never delayed',
  gaming: 'No delay: a game is running (Precise timing paused)',
  'gpu-busy': 'No delay: the graphics card is busy (Precise timing paused)',
  updating: 'No delay: the timing helper is being updated',
  'needs-precise': 'No delay: needs Precise word timing on',
  'engine-cpu': 'No delay: needs a graphics card (section timing instead)',
  'engine-old': 'No delay: the timing helper needs an update',
  'engine-off': 'No delay: needs Precise word timing on',
  'engine-unknown': 'No delay: the timing helper is starting',
  'engine-busy': 'No delay: the timing helper is busy',
  unavailable: 'Not running',
  off: ''
}
function statusText(why, ms) { return (WHY_TEXT[why] || '').replace('{d}', String(Math.round(ms / 100) / 10)) }

/** The status line's words for the helper's end (sonata-lookahead.c: 3 = no PipeWire, 1 = its socket). */
function exitText(code, signal) {
  if (code === 3) return 'PipeWire isn\'t reachable'
  if (code === 1 || code === 2) return 'its control socket failed'
  return 'the helper stopped (' + (signal || code) + ')'
}

// --- the clock ---

/**
 * The heard clock: what the listener hears is the player's position minus the delay the helper
 * reports (buffered + the graph's own latency, so a quantum change is followed exactly). While the line
 * refills (a song's start, a seek: the new audio is D away) the heard position is before `anchor`
 * (where the new audio starts): the clock holds there, not playing, and the views say "Getting ready".
 * -> { time, playing, ready }
 */
function heardClock(playerTime, isPlaying, delayS, anchor) {
  if (!(delayS > 0)) return { time: playerTime, playing: isPlaying, ready: true }
  const t = playerTime - delayS
  if (anchor != null && t < anchor - 0.02) return { time: anchor, playing: false, ready: false }
  return { time: Math.max(0, t), playing: isPlaying, ready: true }
}

// --- player events -> helper commands ---

/**
 * The helper commands for one event from Apple's page (lookahead-page.js), in order. The listener hears
 * the delayed stream, so every control acts on it first: pause freezes it before the player stops,
 * a seek drops what is buffered and gates the old audio out until the player's new audio comes.
 * ev: { ev: 'pause'|'play'|'playing'|'seeking'|'seeked'|'item', natural?, held? }
 * st: { ms (this song's delay), holding (an item change held the player), nextMs (for 'item') }
 * -> { cmds: [string], hold: 'drain'|'resume'|null, anchor?: number|null }
 */
function commandsFor(ev, st) {
  switch (ev.ev) {
    // a song playing to its end pauses its element too (before 'ended'): the delayed tail must play out
    case 'pause': return { cmds: st.holding || ev.ended ? [] : ['pause'], hold: null }
    case 'play': return { cmds: st.holding ? [] : ['play'], hold: null }
    // 0.15.65: with no delay nothing is buffered, so a seek needs no flush and no gate (a gate there
    // only ever dropped the player's own audio: silence at a song's start)
    case 'seeking': return { cmds: st.ms > 0 ? ['flush ' + st.ms] : [], hold: null, anchor: Number.isFinite(ev.t) ? ev.t : null }
    // the player's events come ~100 ms before its audio changes: `open` arms the gate, which opens at
    // the break before the new audio (the helper sees it)
    case 'seeked': case 'playing': return { cmds: st.gated ? ['open'] : [], hold: null }
    case 'item': {
      const next = st.nextMs
      // a skip, a click on another song, the end of the queue: the old song is cut, the new one's delay starts now
      // (into no delay: the old tail is dropped with no gate; from no delay into none: nothing to do)
      if (!ev.natural) return { cmds: next > 0 ? ['flush ' + next] : st.ms > 0 ? ['setd 0'] : [], hold: null, anchor: 0 }
      // the old song ended by itself: no cut. Into an equal or longer delay the new song follows on;
      // into a shorter one the old song's last seconds play out first, the player held at the new song
      if (next >= st.ms) return { cmds: ['track ' + next], hold: ev.held ? 'resume' : null, anchor: 0 }
      return { cmds: ['track ' + next], hold: 'drain', anchor: 0 }
    }
    default: return { cmds: [], hold: null }
  }
}

// --- parsers ---

/** "ok stat k=v ..." / "ev name k=v ..." -> { kind, name, ...fields } (numbers where numeric) */
function parseLine(line) {
  const parts = String(line || '').trim().split(/\s+/)
  const out = { kind: parts[0] || '' }
  let i = 1
  if (out.kind === 'ev' || (out.kind === 'ok' && parts[1] && !parts[1].includes('='))) { out.name = parts[1] || ''; i = 2 }
  // loop: NOT-WORTH — ≤ 20 fields of one reply line
  for (; i < parts.length; i++) {
    const eq = parts[i].indexOf('=')
    if (eq <= 0) continue
    const k = parts[i].slice(0, eq)
    const v = parts[i].slice(eq + 1)
    out[k] = /^-?\d+(\.\d+)?$/.test(v) ? Number(v) : v
  }
  return out
}

/** A page event as the isolated world sends it (lookahead-page.js), checked field by field; null when bad. */
function cleanEvent(m) {
  if (!m || typeof m !== 'object') return null
  const EVS = ['pause', 'play', 'playing', 'seeking', 'seeked', 'emptied', 'item']
  if (!EVS.includes(m.ev)) return null
  const out = { ev: m.ev }
  if (Number.isFinite(m.t) && m.t >= 0 && m.t < 36000) out.t = m.t
  if (m.video === true) out.video = true
  if (m.ended === true) out.ended = true
  if (m.ev === 'item') {
    const str = (v) => (typeof v === 'string' ? v.slice(0, 300) : '')
    out.natural = m.natural === true
    out.held = m.held === true
    out.kind = str(m.kind)
    out.title = str(m.title)
    out.artist = str(m.artist)
    out.isrc = str(m.isrc).replace(/[^A-Za-z0-9]/g, '').slice(0, 15)
    out.id = str(m.id)
    out.duration = Number.isFinite(m.duration) && m.duration > 0 && m.duration < 36000 ? m.duration : 0
    out.video = out.video || /video/i.test(out.kind)
  }
  return out
}

// --- the helper's control line ---

/**
 * One connection to the helper's control socket. Replies come in order, one per command; "ev" lines go to onEvent.
 * A command whose reply is late (REPLY_MS) is rejected but keeps its place in the queue, so its late reply is
 * dropped instead of answering the next command (QC 2026-10 #3: a stat taking an open's "ok t=").
 * deps: { net, replyMs? } -> { ready (Promise), cmd(line) -> Promise<fields>, onEvent(fn), onClose(fn), close() }
 * lifetime: OK — one socket; closed by close() or by the helper's exit (then onClose)
 */
function createDelayLine(socketPath, deps) {
  // lifetime: OK — one socket per helper run; ends with close() or the helper's exit (its 'close' below)
  const sock = deps.net.createConnection(socketPath)
  const waiting = []
  let buf = ''
  let evFn = () => {}
  let closeFn = () => {}
  let closed = false
  const ready = new Promise((resolve, reject) => {
    // error: PASSES-ON — a refused or failed connection rejects `ready` (the controller shows "Not running")
    // lifetime: OK — once listeners, gone after the first event or with the socket
    sock.once('error', reject)
    // lifetime: OK — the first event only; the 'data' listener below handles the rest
    sock.once('connect', () => resolve())
  })
  // lifetime: OK — 'data'/'close'/'error' die with the socket
  sock.setEncoding('utf8')
  sock.on('data', (s) => {
    buf += s
    let nl
    // loop: HOT-PATH-OK — the lines of one chunk (a reply or an event, a few per user action, 2 stats/s)
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl)
      buf = buf.slice(nl + 1)
      const f = parseLine(line)
      if (f.kind === 'ev') evFn(f)
      else { const w = waiting.shift(); if (w && !w.late) { clearTimeout(w.timer); w.resolve(f) } }
    }
  })
  // error: NOT-WORTH — a socket error ends the line; its 'close' follows and the controller falls back (shown)
  // lifetime: OK — 'error'/'close' die with the socket
  sock.on('error', () => {})
  sock.on('close', () => {
    closed = true
    // loop: NOT-WORTH — the commands still waiting (≤ a few)
    for (const w of waiting.splice(0)) { clearTimeout(w.timer); if (!w.late) w.reject(new Error('helper gone')) }
    closeFn()
  })
  return {
    ready,
    cmd(line) {
      if (closed) return Promise.reject(new Error('helper gone'))
      return new Promise((resolve, reject) => {
        // lifetime: OK — one-shot reply timeout, cleared by the reply or the close
        // a late reply still comes in order: the slot stays (late) and drops it when it lands
        const w = { resolve, reject, late: false, timer: setTimeout(() => { w.late = true; reject(new Error('no reply to ' + line)) }, deps.replyMs || REPLY_MS) }
        waiting.push(w)
        sock.write(line + '\n')
      })
    },
    onEvent(fn) { evFn = fn },
    onClose(fn) { closeFn = fn },
    close() { if (!closed) sock.end() },
    get closed() { return closed }
  }
}

// --- the controller ---

/**
 * createLookahead(deps) -> controller. deps:
 *   binary, socketPath           the helper and where its control socket goes (a private runtime dir)
 *   spawn, execFile, net         child_process / net (fakes in tests)
 *   findStream() -> Promise<{ index, objectId, sink } | null>   Sonata's own sink input (pactl; never OUT_NODE)
 *   decide(item) -> { ms, why }  this song's delay (main: decide() with what it knows)
 *   player(action)               'resume' (play after a hold) | 'seek0play' (back to the start, play)
 *   setHold(on)                  tells Apple's page to hold the player at the next natural item change
 *   onChange()                   the state or status changed (main pushes Settings and the views)
 *   log
 * lifetime: OK — at most one helper child, one control socket and one `pactl subscribe` child; all three end
 * in stop() (also on quit), the helper also by itself when the socket closes or Sonata dies
 */
function createLookahead(deps) {
  const log = deps.log || (() => {})
  let phase = 'off'          // off | starting | on | stopping (stop() until the helper exits) | failed
  let startAfterStop = false // start() came while the old helper was still exiting (QC 2026-10 #9)
  let failure = ''
  let child = null
  let line = null
  let sub = null
  let restarts = 0
  let restartTimer = null
  let routed = null          // { index, objectId } of the sink input we moved
  let routeTimer = null
  let stopping = false
  // the song playing now, as the helper has it
  let song = { ms: 0, why: 'off', anchor: null, key: '' }
  let holding = false        // an item change held the player (drain or resume pending)
  let drainTimer = null
  let gated = false
  let confirmTimer = null    // the gate's CONFIRM_MS fallback
  let boundaryTimer = null   // a jump to the start waiting for its item change
  let heardUs = 0            // the helper's last heard delay (µs)
  let itemAt = -Infinity     // when the last item change came (a load's own seek is not the user's)
  let itemUntitled = false   // that item change named no song (a cold start announces the song twice)
  const now = deps.now || Date.now
  let helperState = ''

  function changed() { if (deps.onChange) deps.onChange() }

  function send(cmd) {
    if (!line || line.closed) return Promise.resolve(null)
    // error: LOGGED-OK — a command the helper didn't answer: logged; its exit (if that's why) falls back
    return line.cmd(cmd).catch((e) => { log('helper: ' + cmd + ': ' + e.message); return null })
  }

  function start() {
    if (phase === 'starting' || phase === 'on') return
    // a quick off and on: the old helper still owns the socket; this start runs when it has exited (gone)
    if (phase === 'stopping') { startAfterStop = true; return }
    stopping = false
    phase = 'starting'
    failure = ''
    changed()
    let c
    // lifetime: OK — one helper child at a time; ends when its socket closes (stop), by SIGTERM, or with Sonata (PR_SET_PDEATHSIG)
    try {
      c = deps.spawn(deps.binary, ['--ctl', deps.socketPath, '--delay-ms', '0'], { stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (e) {   // error: SHOWN — the status line says the helper could not start
      fail('could not start: ' + e.message)
      return
    }
    child = c
    let out = ''
    let readyTimer = null
    // lifetime: OK — the ready wait ends on the line, on exit or on its timeout
    const onReady = (s) => {
      out += s
      if (!/^ready /m.test(out) || line) return
      clearTimeout(readyTimer)
      connect(c)
    }
    c.stdout.setEncoding('utf8')
    // lifetime: OK — stdout/stderr/exit listeners die with the child
    c.stdout.on('data', onReady)
    c.stderr.setEncoding('utf8')
    c.stderr.on('data', (s) => log('helper: ' + String(s).trim().slice(0, 200)))
    // error: SHOWN — spawn failure (ENOENT) comes here: the status line says so
    c.on('error', (e) => { if (child === c) fail('could not start: ' + e.message) })
    c.on('exit', (code, signal) => gone(c, code, signal))
    // loop: NOT-WORTH — one-shot ready timeout per start
    readyTimer = setTimeout(() => { if (child === c && !line) { fail('did not start in time'); kill(c) } }, READY_MS)
  }

  function connect(c) {
    const l = deps.createLine ? deps.createLine(deps.socketPath) : createDelayLine(deps.socketPath, deps)
    line = l
    l.onEvent(onHelperEvent)
    l.onClose(() => { if (line === l) { line = null; if (!stopping && child === c) kill(c) } })
    l.ready.then(() => {
      if (line !== l) return
      phase = 'on'
      song = { ms: 0, why: song.why, anchor: null, key: song.key }
      log('helper running; routing Sonata\'s stream')
      route()
      watchStreams()
      changed()
    }).catch((e) => { if (line === l) { fail('no control socket: ' + e.message); kill(c) } })   // error: SHOWN — the status line
  }

  function fail(why) {
    failure = why
    phase = 'failed'
    log('look-ahead off: ' + why)
    fallback()
    changed()
  }

  // The helper died or failed: Sonata's stream is already back on the default device (the session
  // manager relinks a stream whose sink is gone); the clock stops shifting at once, and the stream's
  // remembered target is cleared so nothing points at the look-ahead sink later.
  function fallback() {
    heardUs = 0
    if (holding) deps.player('resume')   // a player held at an item change plays on
    holding = false
    gated = false
    if (drainTimer) { clearTimeout(drainTimer); drainTimer = null }
    song = { ms: 0, why: 'unavailable', anchor: null, key: song.key }
    unroute()
    deps.setHold(false)
    if (sub) { const s = sub; sub = null; try { s.kill() } catch (e) {} }   // error: NOT-WORTH — already gone
  }

  function gone(c, code, signal) {
    if (child !== c) return
    child = null
    if (line) { line.close(); line = null }
    if (stopping) {
      phase = 'off'
      changed()
      if (startAfterStop) { startAfterStop = false; start() }
      return
    }
    fail(exitText(code, signal))
    if (restarts < MAX_RESTARTS) {
      restarts++
      // loop: SERIAL-REQUIRED — retry/backoff: at most MAX_RESTARTS restarts per run, RESTART_MS apart
      restartTimer = setTimeout(() => { restartTimer = null; if (!stopping && phase === 'failed') start() }, RESTART_MS)
    }
  }

  function kill(c) {
    // error: NOT-WORTH — a kill that throws means it is already gone
    try { c.kill('SIGTERM') } catch (e) {}
  }

  // --- routing: only Sonata's own stream, by its sink input ---
  function route() {
    if (phase !== 'on') return Promise.resolve(false)
    return deps.findStream().then((s) => {
      if (!s || phase !== 'on') return false
      if (s.sink === SINK) { routed = s; return true }
      return new Promise((resolve) => {
        // error: LOGGED-OK — a move that fails leaves the stream on its device (no delay, nothing lost); the next event tries again
        // lifetime: OK — one short pactl child per move (2 s timeout)
        deps.execFile('pactl', ['move-sink-input', String(s.index), SINK], { timeout: 2000 }, (err) => {
          if (err) { log('could not route the stream: ' + err.message); resolve(false); return }
          routed = s
          resolve(true)
        })
      })
    }).catch((e) => { log('stream lookup failed: ' + e.message); return false })   // error: LOGGED-OK — tried again on the next stream event
  }

  // Back to the default device, and nothing remembered: `pactl move-sink-input <index> @DEFAULT_SINK@` makes
  // pipewire-pulse set the stream's target to none (-1), so it follows the default device again and
  // WirePlumber keeps no target for Sonata's stream (measured: tools/lookahead-test). The stream is looked
  // up again first: Chromium may have made a new one since it was routed.
  function unroute() {
    const was = routed
    routed = null
    if (!was) return
    deps.findStream().then((s) => {
      if (!s) return
      // error: LOGGED-OK — pactl failing: the session manager already moved the stream if its sink is gone
      // lifetime: OK — one short pactl child (2 s timeout)
      deps.execFile('pactl', ['move-sink-input', String(s.index), '@DEFAULT_SINK@'], { timeout: 2000 }, (err) => {
        if (err) log('could not route the stream back: ' + err.message)
      })
    }).catch((e) => log('stream lookup failed: ' + e.message))   // error: LOGGED-OK — as above
  }

  // Chromium makes a new stream after a long pause (10–20 s, measured): WirePlumber's restored target
  // usually puts it on our sink; any stream event checks, and moves it if not
  function watchStreams() {
    if (sub) return
    let s
    // lifetime: OK — one `pactl subscribe` child while look-ahead runs; killed in stop() and fallback()
    try { s = deps.spawn('pactl', ['subscribe'], { stdio: ['ignore', 'pipe', 'ignore'] }) } catch (e) { log('no pactl subscribe: ' + e.message); return }   // error: LOGGED-OK — routing is then checked on play and item events only
    sub = s
    s.stdout.setEncoding('utf8')
    // lifetime: OK — the child's listeners die with it; it is killed in stop()/fallback()
    s.stdout.on('data', (t) => {
      if (!/'(new|change)' on sink-input/.test(t)) return
      if (routeTimer) return
      // loop: NOT-WORTH — one debounced check per burst of stream events
      routeTimer = setTimeout(() => { routeTimer = null; route() }, ROUTE_DEBOUNCE_MS)
    })
    // error: LOGGED-OK — pactl subscribe ending: routing is still checked on play and item events
    s.on('error', () => {})
    s.on('exit', () => { if (sub === s) sub = null })
  }

  // --- helper events ---
  function onHelperEvent(e) {
    if (e.name === 'drained' && holding) {
      holding = false
      if (drainTimer) { clearTimeout(drainTimer); drainTimer = null }
      gated = true; armConfirm()
      deps.player('seek0play')
    } else if (e.name === 'auto-resume') log('the player played on after a pause Sonata missed: resumed')
    else if (e.name === 'gate-timeout') { gated = false; log('the player never confirmed a seek: the gate opened after its timeout') }
  }

  // --- the player ---
  // a gate the player doesn't confirm within CONFIRM_MS is opened from here (the helper then opens at the
  // next break, at most its OPEN_MAX_MS later): the old 3 s timeout silenced a verse at each song start
  function armConfirm() {
    if (confirmTimer) clearTimeout(confirmTimer)
    // lifetime: OK — one-shot; cleared by the player's own confirm, the next gate or stop()
    confirmTimer = setTimeout(() => {
      confirmTimer = null
      if (!gated || holding || phase !== 'on') return
      gated = false
      send('open')
      log('the player did not confirm a seek within ' + CONFIRM_MS + ' ms: audio passed through')
    }, CONFIRM_MS)
  }
  function pageEvent(raw, late) {
    const ev = cleanEvent(raw)
    if (!ev || phase !== 'on') return
    // a jump to a song's start that comes just before its item change is the song changing, not a seek:
    // held BOUNDARY_SEEK_MS for the item; only then is it a seek (a flush and its gate)
    if (ev.ev === 'seeking' && !(ev.t >= LOAD_SEEK_S) && !late && song.ms > 0 && now() - itemAt >= LOAD_SEEK_MS) {
      if (boundaryTimer) clearTimeout(boundaryTimer)
      // lifetime: OK — one-shot; cleared by the item change, the next such seek or stop()
      boundaryTimer = setTimeout(() => { boundaryTimer = null; pageEvent(raw, true) }, BOUNDARY_SEEK_MS)
      return
    }
    if (ev.ev === 'item' && boundaryTimer) { clearTimeout(boundaryTimer); boundaryTimer = null }
    // the new song's player may set its position to the start while it loads: that is no seek (a flush
    // there would cut the old song's delayed tail)
    if (ev.ev === 'seeking' && now() - itemAt < LOAD_SEEK_MS && !(ev.t >= LOAD_SEEK_S)) return
    // 0.15.85 (Marcy 2026-10-20: "a second or two of the beginning of a song gets cut off", only the first track
    // when playback starts): a cold start announces its song twice, first with no title, then named a second later
    // ('look-ahead: "": 3000 ms (first)', then "Honey, Honey"); the second announcement flushed the delay line again
    // and dropped the second of the song already in it. The named one, within LOAD_SEEK_MS at the same delay, only
    // names it.
    const naming = ev.ev === 'item' && itemUntitled && now() - itemAt < LOAD_SEEK_MS && !ev.natural
    if (ev.ev === 'item') { itemAt = now(); itemUntitled = !ev.title && !ev.id }
    if (ev.ev === 'play' || ev.ev === 'item') route()   // a new stream may have come with it
    const oldMs = song.ms
    let nextMs = song.ms
    if (naming) {
      const d = deps.decide(ev)
      if (d.ms === oldMs) {
        song = { ms: d.ms, why: d.why, anchor: song.anchor, key: ev.id || ev.title }
        deps.setHold(d.ms > 0)
        changed()
        return
      }
    }
    if (ev.ev === 'item') {
      const d = deps.decide(ev)
      nextMs = d.ms
      song = { ms: d.ms, why: d.why, anchor: 0, key: ev.id || ev.title }
      deps.setHold(d.ms > 0)
      changed()
    }
    const r = commandsFor(ev, { ms: oldMs, holding, gated, nextMs })
    if (r.anchor !== undefined) song.anchor = r.anchor
    if (r.cmds.some((c) => c.startsWith('flush '))) { gated = true; armConfirm() }   // loop: NOT-WORTH — N <= 1, per page event
    else if ((ev.ev === 'seeked' || ev.ev === 'playing') && r.cmds.includes('open')) {
      gated = false
      if (confirmTimer) { clearTimeout(confirmTimer); confirmTimer = null }
    }
    // loop: SERIAL-REQUIRED — the helper applies its commands in the order sent
    for (const c of r.cmds) send(c)
    if (ev.ev !== 'item' || !ev.held) return
    if (r.hold !== 'drain') { deps.player('resume'); return }
    // the old song's tail plays out (at most its delay), then the new song from its start; a lost
    // "drained" never holds the player longer than that
    holding = true
    if (drainTimer) clearTimeout(drainTimer)
    // loop: NOT-WORTH — one-shot safety per held item change
    drainTimer = setTimeout(() => {
      drainTimer = null
      if (!holding) return
      holding = false
      gated = true; armConfirm()
      deps.player('seek0play')
    }, oldMs + DRAIN_SLACK_MS)
  }

  /** Sonata's own controls (rail, mini player, shortcuts) act on the heard stream first. */
  function beforeCommand(command) {
    if (phase !== 'on') return
    if (command === 'pause') send('pause')
  }

  /** Per lyrics tick: the heard delay (the clock follows the helper's own figure). */
  function tick() {
    if (phase !== 'on' || !line) return Promise.resolve()
    return send('stat').then((f) => {
      if (!f || f.kind !== 'ok') return
      heardUs = Number(f.heard_us) || 0
      helperState = String(f.state || '')
    })
  }

  /** lifetime: OK — the helper, its socket, the subscribe child and every timer end here */
  function stop() {
    stopping = true
    if (restartTimer) { clearTimeout(restartTimer); restartTimer = null }
    if (routeTimer) { clearTimeout(routeTimer); routeTimer = null }
    if (drainTimer) { clearTimeout(drainTimer); drainTimer = null }
    if (confirmTimer) { clearTimeout(confirmTimer); confirmTimer = null }
    if (boundaryTimer) { clearTimeout(boundaryTimer); boundaryTimer = null }
    if (holding) { holding = false; deps.player('resume') }
    unroute()
    deps.setHold(false)
    if (sub) { const s = sub; sub = null; try { s.kill() } catch (e) {} }   // error: NOT-WORTH — already gone
    if (line) { line.close(); line = null }
    const c = child
    if (c) {
      // the helper quits when its socket closes; a stuck one is ended
      // loop: NOT-WORTH — one-shot kill timer at stop
      const t = setTimeout(() => { if (child === c) kill(c) }, 1000)
      if (t.unref) t.unref()
    }
    heardUs = 0
    song = { ms: 0, why: 'off', anchor: null, key: '' }
    // the helper's exit (gone) ends it: meanwhile no page event routes the stream back onto its sink
    phase = child ? 'stopping' : 'off'
    startAfterStop = false
    changed()
  }

  return {
    start, stop, pageEvent, beforeCommand, tick,
    /** The clock for the views: { time, playing, ready } of the heard audio. */
    clock(playerTime, isPlaying) {
      // with no delay the line still holds ~2 quanta (≈ 43 ms): the clock follows that too
      return heardClock(playerTime, isPlaying, phase === 'on' ? heardUs / 1e6 : 0, song.ms > 0 ? song.anchor : null)
    },
    get phase() { return phase },
    get failure() { return failure },
    get song() { return Object.assign({}, song) },
    get delayS() { return phase === 'on' ? heardUs / 1e6 : 0 },
    get helperState() { return helperState },
    get routed() { return !!routed },
    status() {
      if (phase === 'failed') return 'Not running: ' + failure
      if (phase === 'starting') return 'Starting…'
      if (phase !== 'on') return ''
      return statusText(song.why, song.ms)
    }
  }
}

/**
 * Sonata's own sink input from `pactl -f json list sink-inputs` (audio-listen.js pickSinkInput, so the
 * engine tap and the routing agree), leaving out the helper's own output stream.
 */
function sonataStream(list, sinks, pids, pick) {
  const mine = (Array.isArray(list) ? list : []).filter((s) => !(s && s.properties && s.properties['node.name'] === OUT_NODE))
  const s = pick(mine, pids)
  if (!s) return null
  const sink = (Array.isArray(sinks) ? sinks : []).find((k) => k && k.index === s.sink)
  return { index: s.index, objectId: s.properties ? s.properties['object.id'] : null, sink: sink ? sink.name : '' }
}

module.exports = { wanted,
  DELAYS, SINK, OUT_NODE, MAX_RESTARTS,
  delayOf, availability, learnState, decide, engineState, statusText, exitText, heardClock, commandsFor, parseLine, cleanEvent,
  sonataStream, createDelayLine, createLookahead
}
