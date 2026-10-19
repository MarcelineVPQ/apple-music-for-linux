#!/usr/bin/env node
// Sonata's look-ahead controller (lookahead.js) against the real helper and a fake player, in a PRIVATE
// PipeWire only (tools/lookahead-test/sandbox.sh):
//
//   tools/lookahead-test/sandbox.sh <scratch> node tools/lookahead-test/controller-itest.js <scratch>
//
// What runs is what Sonata runs: createLookahead with child_process and net, the stream found with
// pactl's JSON and audio-listen.js pickSinkInput over this process's tree (the fake player is our child,
// as Chromium's audio process is Sonata's), the helper binary from <scratch>/build. The page's events
// are sent the way lookahead-page.js sends them. Checks: the stream is routed to the helper's sink and
// nothing else is; first plays only (a learned song and a video get no delay); pause / play / seek go to
// the helper in order; the helper dies (kill -9): the stream is back on the device at once, the clock
// stops shifting, the controller starts it again and routes the stream; stop: back on the default
// device, no target remembered, no node left. Prints one JSON summary; exit 1 on a failed check.
'use strict'
const path = require('path')
const fs = require('fs')
const net = require('net')
const { spawn, execFile, execFileSync } = require('child_process')
const ROOT = path.join(__dirname, '..', '..')
const LA = require(path.join(ROOT, 'lookahead'))
const { pickSinkInput, ownProcessTree } = require(path.join(ROOT, 'audio-listen'))

const S = path.resolve(process.argv[2])
const RUN = process.env.XDG_RUNTIME_DIR
const B = path.join(S, 'build')
const checks = []
const out = { checks, timings: {} }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const check = (name, ok, detail) => { checks.push({ name, ok: !!ok, detail }); if (!ok) console.error('FAIL ' + name + (detail !== undefined ? ': ' + JSON.stringify(detail) : '')) }
const pactlJson = (args) => JSON.parse(execFileSync('pactl', ['-f', 'json', ...args], { encoding: 'utf8' }))
const sinkOf = (nodeName) => {
  const si = pactlJson(['list', 'sink-inputs']).find((s) => s.properties['node.name'] === nodeName)
  if (!si) return null
  const k = pactlJson(['list', 'sinks']).find((x) => x.index === si.sink)
  return k ? k.name : null
}
// error: NOT-WORTH — pgrep exits 1 when nothing matches: that is the answer ''
const pgrep = (pat) => { try { return execFileSync('pgrep', ['-f', pat], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() } catch (e) { return '' } }
const nodes = () => JSON.parse(execFileSync('pw-dump', { encoding: 'utf8' })).filter((o) => o.type === 'PipeWire:Interface:Node').map((o) => o.info.props['node.name'])
async function until(fn, ms, what) {
  const t0 = Date.now()
  // loop: SERIAL-REQUIRED — poll until the condition holds (deadline `ms`)
  while (Date.now() - t0 < ms) { if (fn()) return Date.now() - t0; await sleep(20) }
  throw new Error('timed out: ' + what)
}

// the fake player (a pw_stream like Chromium's), our child: in our process tree like Sonata's audio process
const player = spawn(path.join(B, 'la-test'), ['player', '--ctl', path.join(RUN, 'player.sock'), '--name', 'Sonata'], { stdio: 'ignore' })
const pctl = { sock: null, send(line) { this.sock.write(line + '\n') } }

// main.js lookaheadStream, verbatim in substance: Sonata's own sink input, never the helper's output
function findStream() {
  const run = (args) => new Promise((resolve) => execFile('pactl', args, { timeout: 2000, maxBuffer: 4 << 20 }, (err, o) => { try { resolve(err ? null : JSON.parse(String(o))) } catch (e) { resolve(null) } }))
  return Promise.all([run(['-f', 'json', 'list', 'sink-inputs']), run(['-f', 'json', 'list', 'sinks'])]).then(([inputs, sinks]) => inputs && LA.sonataStream(inputs, sinks, ownProcessTree(process.pid), pickSinkInput))
}

let nextDecision = { ms: LA.DELAYS.precise, why: 'first' }
const playerActions = []
const la = LA.createLookahead({
  binary: path.join(B, 'sonata-lookahead'), socketPath: path.join(RUN, 'sonata-lookahead-itest.sock'),
  spawn, execFile, net, findStream,
  decide: (item) => (item.video ? { ms: 0, why: 'video' } : nextDecision),
  player: (a) => playerActions.push(a),
  setHold: () => {},
  log: (m) => console.log('la:', m)
})
const stat = async () => { await la.tick(); return { phase: la.phase, delayS: la.delayS, state: la.helperState } }

async function main() {
  await until(() => fs.existsSync(path.join(RUN, 'player.sock')), 3000, 'player socket')
  pctl.sock = net.createConnection(path.join(RUN, 'player.sock'))
  pctl.sock.on('data', () => {})
  await until(() => sinkOf('Sonata') === 'speakers', 3000, 'player on speakers')

  // start: the helper runs and only Sonata's stream is moved into its sink
  la.start()
  out.timings.start_to_routed_ms = await until(() => la.phase === 'on' && sinkOf('Sonata') === LA.SINK, 5000, 'routed')
  check('routed: Sonata\'s stream on the look-ahead sink', sinkOf('Sonata') === LA.SINK)
  check('routed: the helper\'s own output on the default device', sinkOf(LA.OUT_NODE) === 'speakers', sinkOf(LA.OUT_NODE))

  // a first play: the page reports the item, the helper gets its delay
  la.pageEvent({ ev: 'item', natural: false, title: 'First song', kind: 'songs' })
  la.pageEvent({ ev: 'playing' })
  await sleep(3800)
  let st = await stat()
  check('first play: heard ~3 s behind', Math.abs(st.delayS - 3) < 0.05, st)
  check('first play: the clock follows', Math.abs(la.clock(60, true).time - (60 - st.delayS)) < 1e-6)

  // pause / play go to the helper (frozen, then playing again with the same delay)
  la.pageEvent({ ev: 'pause' })
  pctl.send('pause 95')                       // Chromium's measured tail
  await sleep(300)
  st = await stat()
  check('pause: the helper is frozen', st.state === 'frozen', st)
  la.pageEvent({ ev: 'play' })
  pctl.send('play 89')                        // Chromium's measured resume lag
  await sleep(1500)
  st = await stat()
  check('play: running again, ~3 s behind', st.state === 'run' && Math.abs(st.delayS - 3) < 0.05, st)

  // a seek: flush + gate; the page's seeked opens it; the new place is heard D later
  la.pageEvent({ ev: 'seeking', t: 40 })
  pctl.send('seek 20000 100 4')
  la.pageEvent({ ev: 'seeked' })
  await sleep(500)
  check('seek: the views hold at the new place while the line refills', la.clock(40.5, true).ready === false)
  await sleep(3300)
  st = await stat()
  check('seek: refilled, ~3 s behind', st.state === 'run' && Math.abs(st.delayS - 3) < 0.05, st)

  // a learned song next (a skip): no delay; a video: no delay
  nextDecision = { ms: 0, why: 'learned' }
  la.pageEvent({ ev: 'item', natural: false, title: 'Learned song', kind: 'songs' })
  pctl.send('seek 30000 30 60')
  la.pageEvent({ ev: 'playing' })
  await sleep(1200)
  st = await stat()
  check('learned song: no delay (only the graph\'s ~2 quanta)', st.delayS < 0.06, st)
  la.pageEvent({ ev: 'item', natural: false, title: 'Clip', kind: 'musicVideos' })
  la.pageEvent({ ev: 'playing' })
  await sleep(800)
  st = await stat()
  check('music video: no delay', st.delayS < 0.06 && la.song.why === 'video', { st, song: la.song })

  // back to a first play, then the helper dies
  nextDecision = { ms: LA.DELAYS.precise, why: 'first' }
  la.pageEvent({ ev: 'item', natural: false, title: 'Another first play', kind: 'songs' })
  la.pageEvent({ ev: 'playing' })
  await sleep(3800)
  const helperPid = Number(pgrep(path.join(B, 'sonata-lookahead') + ' --ctl').split('\n')[0])
  const tKill = Date.now()
  process.kill(helperPid, 'SIGKILL')
  out.timings.kill_to_device_ms = await until(() => sinkOf('Sonata') === 'speakers', 2000, 'fallback to the device')
  out.timings.kill_to_controller_failed_ms = await until(() => la.phase === 'failed', 2000, 'controller fallback')
  check('helper killed: Sonata\'s stream back on the device', sinkOf('Sonata') === 'speakers')
  check('helper killed: the clock stops shifting', la.delayS === 0 && la.clock(70, true).time === 70)
  check('helper killed: no look-ahead node left', !nodes().some((n) => /^sonata-lookahead/.test(n || '')), nodes())
  check('helper killed: the status says so', /^Not running: the helper stopped/.test(la.status()), la.status())
  // the controller starts it again after its backoff and routes the stream again
  await until(() => la.phase === 'on' && sinkOf('Sonata') === LA.SINK, 9000, 'restart')
  out.timings.kill_to_restarted_ms = Date.now() - tKill
  check('restarted: routed again', sinkOf('Sonata') === LA.SINK)

  // stop (switch off / quit): the stream follows the default device again, nothing remembered, nothing left
  la.stop()
  await until(() => sinkOf('Sonata') === 'speakers' && !nodes().some((n) => /^sonata-lookahead/.test(n || '')), 3000, 'stopped clean')
  execFileSync('pactl', ['set-default-sink', 'speakers2'])
  await sleep(500)
  check('stop: Sonata\'s stream follows a new default device (not pinned)', sinkOf('Sonata') === 'speakers2', sinkOf('Sonata'))
  execFileSync('pactl', ['set-default-sink', 'speakers'])
  const state = path.join(process.env.XDG_STATE_HOME, 'wireplumber', 'stream-properties')
  const saved = fs.existsSync(state) ? fs.readFileSync(state, 'utf8') : ''
  // the fake player's key (Chromium's is its application.name too): it was routed, so it has an entry
  const sonataLine = saved.split('\n').find((l) => l.startsWith('Output/Audio:application.name:la-test-player=')) || ''
  check('stop: Sonata\'s stream has a remembered entry, without a target', sonataLine && !/"target"/.test(sonataLine), sonataLine)
  check('stop: no helper process left', !pgrep('sonata-lookahead --ctl'))
}

main().catch((e) => check('ran to the end', false, e.message)).finally(() => {
  out.passed = checks.filter((c) => c.ok).length
  out.failed = checks.filter((c) => !c.ok).length
  console.log(JSON.stringify(out, null, 1))
  la.stop()
  pctl.sock && pctl.sock.destroy()
  player.kill('SIGINT')
  setTimeout(() => process.exit(out.failed ? 1 : 0), 300)
})
