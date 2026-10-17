// Gaming guard (game-guard.js): the parsers, the decision and the probes, with stubs (no D-Bus,
// no /proc, no nvidia-smi of the machine running the tests).
const test = require('node:test')
const assert = require('node:assert/strict')
const G = require('../game-guard')

test('GameMode: ClientCount from gdbus, both reply styles; anything else is "can\'t tell"', () => {
  assert.equal(G.parseGameModeCount('(<0>,)\n'), 0)
  assert.equal(G.parseGameModeCount('(<int32 2>,)'), 2)
  assert.equal(G.parseGameModeCount(''), null)
  assert.equal(G.parseGameModeCount('Error: GDBus.Error:org.freedesktop.DBus.Error.ServiceUnknown'), null)
  assert.equal(G.parseGameModeCount(null), null)
})

test('Steam: a reaper SteamLaunch with a real AppId is a game; Steam itself is not', () => {
  const c = (...a) => a.join('\0') + '\0'
  assert.equal(G.isSteamGame(c('/home/u/.local/share/Steam/ubuntu12_32/reaper', 'SteamLaunch', 'AppId=1245620', '--', '/x/proton', 'run', 'game.exe')), true)
  assert.equal(G.isSteamGame(c('reaper', 'SteamLaunch', 'AppId=0', '--', 'x')), false)
  assert.equal(G.isSteamGame(c('/home/u/.local/share/Steam/ubuntu12_32/steam', '-silent')), false)
  assert.equal(G.isSteamGame(c('reaper', 'SomethingElse', 'AppId=5')), false)
  assert.equal(G.isSteamGame(''), false)
})

const PMON = `# gpu         pid   type     sm    mem    enc    dec    jpg    ofa    command
# Idx           #    C/G      %      %      %      %      %      %    name
    0       5447     G      2      0      -      -      -      -    Xwayland
    0       9001   C+G     71     40      -      -      -      -    GameThread
    0       1234     C     55     20      -      -      -      -    python
    0       2222   C+G      -      -      -      -      -      -    apple-musi
`

test('NVIDIA: pmon SM % of other processes; ours (helper, Sonata) left out; not a table -> null', () => {
  assert.equal(G.parsePmon(PMON, [1234, 2222]), 73)
  assert.equal(G.parsePmon(PMON, new Set()), 128)
  assert.equal(G.parsePmon('NVIDIA-SMI has failed because it couldn\'t communicate with the NVIDIA driver', []), null)
  assert.equal(G.parsePmon('', []), null)
})

const S = (o) => Object.assign({ gamemode: null, steam: null, nvBusy: null, amdBusy: null }, o)

test('decide: GameMode or a Steam game pauses at once; resume 30 s after the last signal', () => {
  let st = G.decide(null, S({ gamemode: 1 }), 0)
  assert.deepEqual([st.paused, st.reason], [true, 'game'])
  st = G.decide(st, S({ gamemode: 0, steam: false }), 10000)
  assert.equal(st.paused, true, 'still paused: a loading screen or a menu is not the end')
  st = G.decide(st, S({ gamemode: 0, steam: false }), 29999)
  assert.equal(st.paused, true)
  st = G.decide(st, S({ gamemode: 0, steam: false }), 30000)
  assert.deepEqual([st.paused, st.reason], [false, ''])
  assert.equal(G.decide(null, S({ steam: true }), 0).reason, 'game')
})

test('decide: a busy GPU needs two polls in a row; game beats gpu; AMD only counts without NVIDIA', () => {
  let st = G.decide(null, S({ nvBusy: 80 }), 0)
  assert.equal(st.paused, false, 'one busy poll is a burst')
  st = G.decide(st, S({ nvBusy: 80 }), 5000)
  assert.deepEqual([st.paused, st.reason], [true, 'gpu'])
  st = G.decide(st, S({ nvBusy: 80, gamemode: 1 }), 10000)
  assert.equal(st.reason, 'game')
  let b = G.decide(null, S({ nvBusy: 80 }), 0)
  b = G.decide(b, S({ nvBusy: 5 }), 5000)
  b = G.decide(b, S({ nvBusy: 80 }), 10000)
  assert.equal(b.paused, false, 'not in a row')
  let a = G.decide(null, S({ amdBusy: 90 }), 0)
  a = G.decide(a, S({ amdBusy: 90 }), 5000)
  assert.equal(a.reason, 'gpu')
  let n = G.decide(null, S({ nvBusy: 10, amdBusy: 90 }), 0)
  n = G.decide(n, S({ nvBusy: 10, amdBusy: 90 }), 5000)
  assert.equal(n.paused, false, 'the NVIDIA card (where CUDA runs) decides, not a busy iGPU')
})

test('decide: no signal available anywhere (other distros, Flatpak, Intel) never pauses', () => {
  let st = null
  for (let t = 0; t < 60000; t += 5000) st = G.decide(st, S({}), t)
  assert.equal(st.paused, false)
})

test('pauseText: truthful and small', () => {
  assert.equal(G.pauseText({ paused: false }), '')
  assert.equal(G.pauseText({ paused: true, reason: 'game' }), 'Precise timing paused while you play')
  assert.equal(G.pauseText({ paused: true, reason: 'gpu' }), 'Precise timing paused while the graphics card is busy')
})

function stubDeps(o = {}) {
  const calls = []
  const files = Object.assign({
    '/proc': ['1', '42', 'self', '777'],
    '/proc/1/comm': 'systemd\n', '/proc/42/comm': 'reaper\n', '/proc/777/comm': 'bash\n',
    '/proc/42/cmdline': ['reaper', 'SteamLaunch', 'AppId=570', '--', 'dota'].join('\0'),
    '/sys/class/drm': ['card0', 'card1', 'renderD128'],
    '/sys/class/drm/card0/device/vendor': '0x1002\n', '/sys/class/drm/card0/device/gpu_busy_percent': '64\n',
    '/sys/class/drm/card1/device/vendor': '0x8086\n'
  }, o.files || {})
  const read = (p) => { calls.push(p); if (!(p in files)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); return files[p] }
  return {
    calls,
    deps: {
      platform: o.platform || 'linux',
      ownPids: () => [1234],
      fs: { readdirSync: read, readFileSync: read },
      execFile: (cmd, args, opts, cb) => {
        calls.push(cmd)
        const r = (o.exec || {})[cmd]
        if (r === undefined) return cb(Object.assign(new Error('spawn ' + cmd + ' ENOENT'), { code: 'ENOENT' }))
        if (r instanceof Error) return cb(r)
        cb(null, r)
      }
    }
  }
}

test('probes: GameMode, Steam from /proc, NVIDIA pmon; missing tools are off for the run', async () => {
  const { deps, calls } = stubDeps({ exec: { gdbus: '(<0>,)', 'nvidia-smi': PMON } })
  const p = G.linuxProbes(deps)
  assert.deepEqual(await p.sample(), { gamemode: 0, steam: true, nvBusy: 128 - 55, amdBusy: null })
  const none = stubDeps({ files: { '/proc/42/comm': 'bash\n' } })
  const q = G.linuxProbes(none.deps)
  assert.deepEqual(await q.sample(), { gamemode: null, steam: false, nvBusy: null, amdBusy: 64 }, 'no gdbus, no nvidia-smi: AMD sysfs')
  const n1 = none.calls.filter((c) => c === 'gdbus' || c === 'nvidia-smi').length
  await q.sample()
  assert.equal(none.calls.filter((c) => c === 'gdbus' || c === 'nvidia-smi').length, n1, 'ENOENT: not spawned again')
  const comm = none.calls.filter((c) => c === '/proc/1/comm').length
  assert.equal(comm, 1, 'a pid\'s comm is read once')
  assert.ok(calls.includes('/proc/42/cmdline'))
})

test('probes: not Linux -> every signal off', async () => {
  const { deps, calls } = stubDeps({ platform: 'win32', exec: { gdbus: '(<3>,)' } })
  assert.deepEqual(await G.linuxProbes(deps).sample(), { gamemode: null, steam: null, nvBusy: null, amdBusy: null })
  assert.equal(calls.length, 0)
})

test('guard: one check per 5 s, shared while running; onChange on pause and resume only', async () => {
  let t = 0
  let sample = S({ gamemode: 0 })
  let n = 0
  const changes = []
  const g = G.createGameGuard({ probes: { sample: async () => { n++; return sample } }, now: () => t, onChange: (s) => changes.push(s.paused) })
  await Promise.all([g.maybeCheck(), g.maybeCheck()])
  assert.equal(n, 1)
  t = 4000
  await g.maybeCheck()
  assert.equal(n, 1, 'rate limited')
  t = 5000
  sample = S({ gamemode: 1 })
  await g.maybeCheck()
  assert.equal(g.paused, true)
  t = 10000
  await g.maybeCheck()
  sample = S({ gamemode: 0 })
  t = 15000; await g.maybeCheck()
  t = 40000; await g.maybeCheck()
  assert.equal(g.paused, false)
  assert.deepEqual(changes, [true, false])
  g.reset()
  assert.deepEqual(changes, [true, false], 'reset while not paused says nothing')
})

test('guard: a failing probe keeps the current state', async () => {
  const g = G.createGameGuard({ probes: { sample: async () => { throw new Error('boom') } }, now: () => 0 })
  const st = await g.maybeCheck()
  assert.equal(st.paused, false)
})

test('package.json ships game-guard.js (build.files is an explicit list)', () => {
  assert.ok(require('../package.json').build.files.includes('game-guard.js'))
})
