// Settings → Experimental (gfx-model.js, gfx-runtime.js): which Chromium switches a start gets, the start
// marker and its auto-disable, the GPU-crash handler, the restart line and About → Graphics' readout.
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')
const G = require('../gfx-model')
const settingsStore = require('../settings-store')

const WAYLAND = { platform: 'linux', argv: ['/opt/Sonata/sonata'], env: { WAYLAND_DISPLAY: 'wayland-0', DISPLAY: ':0' } }
const X11 = { platform: 'linux', argv: ['/opt/Sonata/sonata', '--ozone-platform=x11'], env: { WAYLAND_DISPLAY: 'wayland-0', DISPLAY: ':0' } }
const withArgs = (base, ...more) => Object.assign({}, base, { argv: base.argv.concat(more) })

// two stand-in switches, for the rules that hold for any switch (the real ones have their own tests below)
const FAKE = [
  { key: 'expRiskA', name: 'Switch A', label: 'A', desc: 'a', restart: true, crashRank: 1, switches: () => [['a-switch', '']], features: ['FeatA'] },
  { key: 'expRiskB', name: 'Switch B', label: 'B', desc: 'b', restart: true, crashRank: 2, switches: () => [['b-switch', 'on']], blocked: (c) => (c.x11 ? 'x11' : null), needs: (c) => (c.x11 ? 'x11' : null) },
  { key: 'expLive', name: 'Live', label: 'L', desc: 'l', restart: false }
]
function withFake(fn) {
  const before = G.EXPERIMENTS.splice(0)
  G.EXPERIMENTS.push(...FAKE)
  try { return fn() } finally { G.EXPERIMENTS.splice(0); G.EXPERIMENTS.push(...before) }
}

test('gfx: the start context reads Wayland/X11, --safe-gpu, SONATA_SAFE_GPU and --disable-gpu', () => {
  assert.equal(G.startContext(WAYLAND).x11, false)
  assert.equal(G.startContext(X11).x11, true)
  assert.equal(G.startContext({ platform: 'linux', argv: [], env: { DISPLAY: ':0' } }).x11, true, 'X11 session without Wayland')
  assert.equal(G.startContext({ platform: 'linux', argv: [], env: { DISPLAY: ':0', ELECTRON_OZONE_PLATFORM_HINT: 'wayland' } }).x11, false)
  assert.equal(G.startContext(withArgs(WAYLAND, '--safe-gpu')).safe, true)
  assert.equal(G.startContext(Object.assign({}, WAYLAND, { env: { SONATA_SAFE_GPU: '1' } })).safe, true)
  assert.equal(G.startContext(withArgs(WAYLAND, '--disable-gpu')).gpuOff, true)
  assert.equal(G.startContext(withArgs(WAYLAND, '--enable-features=Foo,Bar')).enableFeatures, 'Foo,Bar')
})

test('gfx: flags come only from switches that are on; off by default; --safe-gpu and --disable-gpu add none', () => withFake(() => {
  assert.deepEqual(G.startFlags(settingsStore.defaults(), WAYLAND).switches, [], 'defaults: nothing')
  const on = { expRiskA: true, expRiskB: true, expLive: true }
  const f = G.startFlags(on, WAYLAND)
  assert.deepEqual(f.active, ['expRiskA', 'expRiskB'], 'a live (non-restart) switch is no flag')
  assert.deepEqual(f.switches, [['a-switch', ''], ['b-switch', 'on'], ['enable-features', 'FeatA']])
  assert.match(f.line, /^\[gpu\] experimental: expRiskA, expRiskB → --a-switch --b-switch=on --enable-features=FeatA$/)
  const safe = G.startFlags(on, withArgs(WAYLAND, '--safe-gpu'))
  assert.deepEqual(safe.switches, [])
  assert.deepEqual(safe.inactive, { expRiskA: 'safe', expRiskB: 'safe' })
  assert.equal(safe.safe, true)
  assert.deepEqual(G.startFlags(on, withArgs(WAYLAND, '--disable-gpu')).inactive, { expRiskA: 'gpu-off', expRiskB: 'gpu-off' })
  const x = G.startFlags(on, X11)
  assert.deepEqual(x.active, ['expRiskA'])
  assert.deepEqual(x.inactive, { expRiskB: 'x11' })
  assert.match(G.startFlags(on, Object.assign({}, WAYLAND, { platform: 'darwin' })).line, /none; on but not used: expRiskA\(not-linux\)/)
}))

test('gfx: --enable-features is one switch: ours join the ones given on the command line', () => withFake(() => {
  const f = G.startFlags({ expRiskA: true }, withArgs(WAYLAND, '--enable-features=UseOzonePlatform,FeatA'))
  assert.deepEqual(f.switches.find((s) => s[0] === 'enable-features'), ['enable-features', 'UseOzonePlatform,FeatA'])
  assert.equal(G.mergeFeatures('', ['X', 'Y', 'X']), 'X,Y')
}))

test('gfx: start marker: none -> nothing; it names a switch still on -> off, with one notice; unreadable -> all on go off', () => withFake(() => {
  assert.deepEqual(G.sentinelAtStart(null, { expRiskA: true }), { disable: [], notice: '' })
  const text = G.sentinelText(['expRiskA'], '0.15.41-dev.1', Date.UTC(2026, 9, 17, 12))
  assert.deepEqual(JSON.parse(text), { flags: ['expRiskA'], version: '0.15.41-dev.1', startedAt: '2026-10-17T12:00:00.000Z' })
  const r = G.sentinelAtStart(text, { expRiskA: true, expRiskB: true })
  assert.deepEqual(r.disable, ['expRiskA'], 'only the switches the failed start used')
  assert.equal(r.notice, 'Sonata turned off Switch A: the last start with it on didn\'t finish. You can turn it back on in Settings → Experimental.')
  assert.deepEqual(G.sentinelAtStart(text, { expRiskA: false }).disable, [], 'already off: nothing to say')
  const both = G.sentinelAtStart('{"flags":["expRiskA","expRiskB"', { expRiskA: true, expRiskB: true, expLive: true })
  assert.deepEqual(both.disable, ['expRiskA', 'expRiskB'], 'a cut-short marker: every restart switch that is on')
  assert.match(both.notice, /^Sonata turned off Switch A and Switch B: the last start with them on/)
}))

test('gfx: a GPU crash turns off the riskiest active switch first, then the next; clean exits and other processes are ignored', () => withFake(() => {
  const crash = { type: 'GPU', reason: 'crashed', exitCode: 139 }
  const active = ['expRiskA', 'expRiskB']
  assert.equal(G.crashTurnOff(crash, active, { expRiskA: true, expRiskB: true }).key, 'expRiskA')
  assert.equal(G.crashTurnOff(crash, active, { expRiskA: false, expRiskB: true }).key, 'expRiskB', 'second crash: the next one')
  assert.equal(G.crashTurnOff(crash, active, { expRiskA: false, expRiskB: false }), null, 'both off: the existing behaviour')
  assert.equal(G.crashTurnOff(crash, [], { expRiskA: true }), null, 'not active this start: not ours')
  assert.equal(G.crashTurnOff({ type: 'GPU', reason: 'clean-exit' }, active, { expRiskA: true }), null)
  assert.equal(G.crashTurnOff({ type: 'GPU', reason: 'killed' }, active, { expRiskA: true }), null)
  assert.equal(G.crashTurnOff({ type: 'Utility', reason: 'crashed' }, active, { expRiskA: true }), null)
  assert.match(G.crashTurnOff(crash, active, { expRiskA: true }).notice, /^The graphics process stopped \(crashed\), so Sonata turned off Switch A for the next start\./)
}))

test('gfx: "applies at restart" lists the switches the next start changes', () => withFake(() => {
  const start = G.startFlags({ expRiskA: true }, WAYLAND)
  assert.deepEqual(G.pendingRestart({ expRiskA: true }, start), [])
  assert.deepEqual(G.pendingRestart({ expRiskA: false, expRiskB: true, expLive: true }, start), ['Switch A', 'Switch B'])
  const x = G.startFlags({ expRiskB: true }, X11)
  assert.deepEqual(G.pendingRestart({ expRiskB: true }, x), [], 'on but not usable here: no restart helps')
}))

test('gfx: CPU readout from /proc samples: % of one core over the window, by process kind', () => {
  assert.equal(G.statTicks('1234 (sonata (gpu)) S 1 2 3 4 5 6 7 8 9 10 250 50 0 0'), 300)
  assert.equal(G.statTicks('garbage'), null)
  const s = [
    { t: 0, ticks: { 1: { kind: 'other', ticks: 100 }, 2: { kind: 'gpu', ticks: 50 }, 3: { kind: 'page', ticks: 10 } } },
    { t: 10000, ticks: { 1: { kind: 'other', ticks: 110 }, 2: { kind: 'gpu', ticks: 70 }, 3: { kind: 'page', ticks: 40 }, 4: { kind: 'other', ticks: 999 } } }
  ]
  assert.deepEqual(G.cpuOver(s, 100), { seconds: 10, total: 6, gpu: 2, page: 3 }, 'a new process counts from its first sample')
  assert.equal(G.cpuOver(s.slice(0, 1), 100), null)
  const many = Array.from({ length: 20 }, (_, i) => ({ t: i * 5000, ticks: {} }))
  const kept = G.trimSamples(many, 95000, 60000)
  assert.equal(kept[0].t, 30000, 'one sample older than the window stays, so the window is full')
  assert.equal(kept[kept.length - 1].t, 95000)
})

test('gfx: About → Graphics rows say acceleration, what this start uses and the CPU line', () => withFake(() => {
  const start = G.startFlags({ expRiskA: true }, WAYLAND)
  const rows = G.graphicsRows({ gpu: { gpu_compositing: 'enabled' }, start, cpu: { seconds: 60, total: 10.84, gpu: 2.04, page: 8.3 } })
  assert.deepEqual(rows.map((r) => r.id), ['accel', 'experimental', 'cpu'])
  assert.equal(rows[0].value, 'On')
  assert.equal(rows[1].value, 'Switch A')
  assert.equal(rows[2].label, 'CPU in the last minute')
  assert.equal(rows[2].value, 'Sonata 10.8 % · graphics process 2.0 % · Apple\'s page 8.3 % (% of one core)')
  const soft = G.graphicsRows({ gpu: { gpu_compositing: 'disabled_software' }, start: G.startFlags({}, WAYLAND), cpu: { seconds: 12, total: 1, gpu: 0, page: 1 } })
  assert.equal(soft[0].value, 'Off: drawing in software')
  assert.equal(soft[1].value, 'None active')
  assert.equal(soft[2].label, 'CPU so far (12 s)')
  assert.equal(G.graphicsRows({ start: G.startFlags({ expRiskA: true }, withArgs(WAYLAND, '--safe-gpu')) })[1].value, 'Off for this start (--safe-gpu)')
}))

// --- gfx-runtime.js against a fake app and a real temp folder ---
function fakeApp(dir, argv) {
  const switches = []
  const handlers = {}
  return {
    switches, handlers,
    getPath: () => dir,
    getVersion: () => '0.15.41-dev.1',
    commandLine: { appendSwitch: (n, v) => switches.push(v === undefined ? [n] : [n, v]) },
    on: (ev, fn) => { handlers[ev] = fn },
    argv
  }
}
function runtime(dir, settings, argv) {
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify(settings))
  const app = fakeApp(dir)
  const saved = { argv: process.argv, platform: Object.getOwnPropertyDescriptor(process, 'platform'), env: process.env }
  process.argv = ['/opt/Sonata/sonata'].concat(argv || [])
  Object.defineProperty(process, 'platform', { value: 'linux' })
  process.env = Object.assign({}, saved.env, { WAYLAND_DISPLAY: 'wayland-0', SONATA_SAFE_GPU: '' })
  const logs = []
  try {
    delete require.cache[require.resolve('../gfx-runtime')]
    const gfx = require('../gfx-runtime').createGfx({ app, fs, path, settingsStore, log: (m) => logs.push(m) })
    gfx.beforeReady()
    return { gfx, app, logs }
  } finally {
    process.argv = saved.argv
    Object.defineProperty(process, 'platform', saved.platform)
    process.env = saved.env
  }
}
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'sonata-gfx-'))
const marker = (d) => path.join(d, 'gpu-experiment.json')

test('gfx runtime: before ready the switches are appended and the marker written; a healthy start removes it', (t) => withFake(() => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const d = tmp()
  const { gfx, app, logs } = runtime(d, { expRiskA: true })
  assert.deepEqual(app.switches, [['a-switch'], ['enable-features', 'FeatA']])
  assert.deepEqual(JSON.parse(fs.readFileSync(marker(d), 'utf8')).flags, ['expRiskA'])
  assert.match(logs[0], /^\[gpu\] experimental: expRiskA/)
  gfx.ready({ settings: () => ({ expRiskA: true }), turnOff: () => assert.fail('nothing to turn off'), notify: () => assert.fail('nothing to say'), changed: () => {} })
  gfx.painted()
  t.mock.timers.tick(19999)
  assert.ok(fs.existsSync(marker(d)), 'not healthy before 20 s')
  t.mock.timers.tick(1)
  assert.equal(fs.existsSync(marker(d)), false, 'healthy: the marker is gone')
  gfx.stop()
}))

test('gfx runtime: a marker left by a start that never got healthy -> that start uses none of its switches, they go off, one notice', () => withFake(() => {
  const d = tmp()
  fs.writeFileSync(marker(d), G.sentinelText(['expRiskA'], '0.15.41-dev.1', 0))
  const settings = { expRiskA: true, expRiskB: true }
  const { gfx, app } = runtime(d, settings)
  assert.deepEqual(app.switches, [['b-switch', 'on']], 'A left out of this start; B (not in the marker) stays')
  assert.deepEqual(JSON.parse(fs.readFileSync(marker(d), 'utf8')).flags, ['expRiskB'], 'a new marker for this start')
  const off = []
  const said = []
  gfx.ready({ settings: () => settings, turnOff: (k) => { off.push(k); settings[k] = false }, notify: (id, text) => said.push([id, text]), changed: () => {} })
  assert.deepEqual(off, ['expRiskA'])
  assert.equal(said.length, 1)
  assert.equal(said[0][0], 'gfx-start')
  gfx.stop()
}))

test('gfx runtime: --safe-gpu adds no switch, keeps the settings and the marker as they are', () => withFake(() => {
  const d = tmp()
  const left = G.sentinelText(['expRiskA'], 'x', 0)
  fs.writeFileSync(marker(d), left)
  const { gfx, app } = runtime(d, { expRiskA: true }, ['--safe-gpu'])
  assert.deepEqual(app.switches, [])
  assert.equal(fs.readFileSync(marker(d), 'utf8'), left)
  gfx.ready({ settings: () => ({ expRiskA: true }), turnOff: () => assert.fail('no change in a safe start'), notify: () => assert.fail('no notice'), changed: () => {} })
  assert.equal(gfx.snapshot({ gpu_compositing: 'enabled' }).safe, true)
  gfx.stop()
}))

test('gfx runtime: a GPU crash while running turns one switch off for the next start, says so, and clears the marker', () => withFake(() => {
  const d = tmp()
  const settings = { expRiskA: true, expRiskB: true }
  const { gfx, app } = runtime(d, settings)
  const said = []
  let changed = 0
  gfx.ready({ settings: () => settings, turnOff: (k) => { settings[k] = false }, notify: (id, text) => said.push(id), changed: () => changed++ })
  app.handlers['child-process-gone']({}, { type: 'GPU', reason: 'clean-exit' })
  assert.deepEqual(said, [])
  app.handlers['child-process-gone']({}, { type: 'GPU', reason: 'crashed', exitCode: 11 })
  assert.deepEqual(settings, { expRiskA: false, expRiskB: true })
  assert.deepEqual(said, ['gfx-crash'])
  assert.equal(changed, 1)
  assert.equal(fs.existsSync(marker(d)), false)
  app.handlers['child-process-gone']({}, { type: 'GPU', reason: 'oom', exitCode: 1 })
  assert.deepEqual(settings, { expRiskA: false, expRiskB: false })
  gfx.stop()
}))

test('gfx runtime: the panel snapshot says what each switch does this start and what waits for a restart', () => withFake(() => {
  const d = tmp()
  const settings = { expRiskA: true }
  const { gfx } = runtime(d, settings)
  gfx.ready({ settings: () => settings, turnOff: () => {}, notify: () => {}, changed: () => {} })
  let s = gfx.snapshot({ gpu_compositing: 'enabled' })
  assert.deepEqual(s.keys, ['expRiskA', 'expRiskB', 'expLive'])
  assert.equal(s.note.expRiskA, 'On now.')
  assert.deepEqual(s.pending, [])
  settings.expRiskA = false
  settings.expRiskB = true
  s = gfx.snapshot({ gpu_compositing: 'enabled' })
  assert.equal(s.note.expRiskA, 'Off after a restart.')
  assert.equal(s.note.expRiskB, 'Applies at restart.')
  assert.deepEqual(s.pending, ['Switch A', 'Switch B'])
  s = gfx.snapshot({ gpu_compositing: 'disabled_software' })
  assert.equal(s.blocked.expRiskA, G.REASONS['gpu-off'], 'no graphics card: the restart switches are disabled with the reason')
  assert.equal(s.blocked.expLive, undefined, 'a live switch needs no flag')
  assert.deepEqual(s.rows, [], 'no readout while About → Graphics is closed')
  gfx.stop()
}))

test('gfx: the panel builds Experimental from the one registry and offers Restart now; the readout is About → Graphics', () => {
  const ui = fs.readFileSync(path.join(__dirname, '..', 'panel-ui.js'), 'utf8')
  assert.match(ui, /experimental: \(\) => \[/)
  assert.match(ui, /G\.EXPERIMENTS\.map\(\(e\) => switchRow\(e\.key, e\.label, e\.desc/)
  assert.match(ui, /action: 'gfx-restart'/)
  assert.match(ui, /graphics: \(\) => \[\s*readoutBlock/)
  const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8')
  assert.match(main, /'gfx-restart'\]/, 'main accepts the action')
  // decided before 'ready': the runtime is created and asked before app.whenReady()
  assert.ok(main.indexOf('gfx.beforeReady()') > 0 && main.indexOf('gfx.beforeReady()') < main.indexOf('app.whenReady()'))
  assert.match(fs.readFileSync(path.join(__dirname, '..', 'panel.html'), 'utf8'), /<script src="gfx-model\.js"><\/script>\s*<script src="markdown-lite\.js">/)
  const files = require('../package.json').build.files
  assert.ok(files.includes('gfx-model.js') && files.includes('gfx-runtime.js'))
})

test('gfx: Restart now runs this same Sonata again through relaunch.js, in the folder it started in, without --safe-gpu', () => {
  const R = require('../relaunch')
  const a = R.systemdRunArgs({ target: '/usr/bin/electron', args: ['.', '--no-sandbox'], env: {}, unit: 'u', cwd: '/src/sonata' })
  assert.ok(a.includes('--working-directory=/src/sonata'))
  assert.ok(!R.systemdRunArgs({ target: 't', unit: 'u' }).some((x) => x.startsWith('--working-directory')))
  const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8')
  assert.match(main, /function restartApp\(\) \{[\s\S]*?filter\(\(a\) => a !== '--safe-gpu'\)[\s\S]*?startNewCopy\(installedPath \|\| process\.execPath, args, appImagePath \? '' : process\.cwd\(\)\)/)
})
