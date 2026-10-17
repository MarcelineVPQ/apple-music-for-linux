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
const made = []
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'sonata-gfx-')); made.push(d); return d }
test.after(() => { for (const d of made) fs.rmSync(d, { recursive: true, force: true }) })   // the temp folders go with the run
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
  assert.equal(s.note.expRiskA, 'Turns off at the next start.')
  assert.equal(s.note.expRiskB, 'Turns on at the next start.')
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

// --- the real switches ---
test('True video colours: --disable-gpu-memory-buffer-video-frames on Wayland only; not needed under X11; off by default', () => {
  assert.equal(settingsStore.defaults().expTrueVideoColours, false)
  const f = G.startFlags({ expTrueVideoColours: true }, WAYLAND)
  assert.deepEqual(f.switches, [['disable-gpu-memory-buffer-video-frames', '']])
  const x = G.startFlags({ expTrueVideoColours: true }, X11)
  assert.deepEqual(x.switches, [])
  assert.equal(x.inactive.expTrueVideoColours, 'x11-colours')
  assert.deepEqual(G.startFlags({ expTrueVideoColours: true }, withArgs(WAYLAND, '--safe-gpu')).switches, [])
  const rows = (st, x11) => G.graphicsRows({ gpu: { gpu_compositing: 'enabled' }, start: st, x11 }).find((r) => r.id === 'colours').value
  assert.match(rows(f), /^True colours/)
  assert.match(rows(G.startFlags({}, WAYLAND)), /BT\.601 matrix/)
  assert.equal(rows(G.startFlags({}, X11), true), 'Right under X11')
  assert.ok(G.EXPERIMENTS.find((e) => e.key === 'expTrueVideoColours').desc.endsWith('Applies at restart.'))
})

test('Dithered cover glow: the tile is the smallest step (alpha 0 or 1 of 255, white), half the pixels, no long runs, the same every run', () => {
  const D = require('../glow-dither')
  const a = D.noiseAlpha(D.TILE, 20261017, 0.5)
  assert.ok(a.every((v) => v === 0 || v === 1))
  const density = a.reduce((s, v) => s + v, 0) / a.length
  assert.ok(density > 0.48 && density < 0.52, density)
  assert.ok(D.longestRun(a, D.TILE) <= 5, 'no flat run of the tile longer than 5 px, across its wrap too')
  assert.deepEqual(D.noiseAlpha(D.TILE, 20261017, 0.5), a, 'deterministic')
  const png = D.whitePng(a, D.TILE)
  assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10])
  assert.equal(png.readUInt32BE(16), 64)
  assert.equal(png.readUInt32BE(20), 64)
  // every chunk's CRC is right (a bad one and Chromium drops the image: the dither would silently vanish)
  for (let o = 8; o < png.length;) {
    const len = png.readUInt32BE(o)
    assert.equal(png.readUInt32BE(o + 8 + len), D.crc32(png.subarray(o + 4, o + 8 + len)))
    o += 12 + len
  }
  const raw = require('zlib').inflateSync(png.subarray(41, 41 + png.readUInt32BE(33)))
  assert.equal(raw.length, 64 * (1 + 64 * 4))
  assert.deepEqual([...raw.subarray(1, 5)], [255, 255, 255, a[0]], 'white at the tile\'s alpha')
})

test('Dithered cover glow: the CSS sits on the glow\'s falloff only, over Apple\'s glow, never over the cover', () => {
  const D = require('../glow-dither')
  const css = D.css()
  assert.match(css, /^\.container-detail-header:not\(\.container-detail-header--tall-artwork\) \.artwork-wrapper:has\(> \.artwork__radiosity\)::after \{/)
  assert.match(css, /mix-blend-mode: plus-lighter/)
  assert.match(css, /inset: -70px/)
  assert.match(css, /background: url\(data:image\/png;base64,[A-Za-z0-9+/=]+\) 0 0 \/ 64px 64px repeat/)
  // the cover's rect is cut out of the band, the band is cut to the glow box plus its tail
  assert.match(css, /mask-size: 100% 100%, 100% 100%, calc\(100% - 140px\) calc\(100% - 140px\)/)
  assert.match(css, /mask-position: 0 0, 0 0, 70px 70px/)
  assert.match(css, /mask-composite: intersect, subtract, add/)
  const s = D.maskStops()
  // the glow box (cover × .88 from its bottom centre) plus REACH, fading over FADE
  assert.deepEqual(s.bottom, ['calc(100% - 40px)', 'calc(100% - 24px)'])
  assert.deepEqual(s.left, ['calc(6% + 15.6px)', 'calc(6% + 31.6px)'])
  assert.deepEqual(s.top, ['calc(12% + 7.2px)', 'calc(12% + 23.2px)'])
  assert.ok(css.length < 4000, 'small: ' + css.length)
})

test('Dithered cover glow: main adds it to Apple\'s CSS through the one css-replacer while the switch is on, and re-applies on a change', async () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8')
  assert.match(main, /applyCustomCss = createCssReplacer\(appleWC\(\), appleCss\)/)
  assert.match(main, /function appleCss\(\) \{\s*if \(!settings\.expGlowDither\) return customCss/)
  assert.match(main, /else if \(key === 'expGlowDither'\) \{ if \(applyCustomCss\) applyCustomCss\(\) \}/)
  assert.equal(settingsStore.defaults().expGlowDither, false)
  // the replacer reads the CSS at each apply and keeps one sheet
  const { createCssReplacer } = require('../css-replacer')
  const live = new Map()
  let n = 0
  const wc = { insertCSS: async (t) => { const k = 'k' + (++n); live.set(k, t); return k }, removeInsertedCSS: async (k) => { live.delete(k) } }
  let on = false
  const apply = createCssReplacer(wc, () => 'x{}' + (on ? require('../glow-dither').css() : ''))
  await apply()
  assert.equal(live.size, 1)
  assert.ok(![...live.values()][0].includes('radiosity'))
  on = true
  await apply()
  assert.equal(live.size, 1)
  assert.ok([...live.values()][0].includes('.artwork__radiosity'))
  const e = G.EXPERIMENTS.find((x) => x.key === 'expGlowDither')
  assert.equal(e.restart, false, 'CSS: applies at once, no flag, no restart')
  assert.match(G.graphicsRows({ settings: { expGlowDither: true }, start: G.startFlags({}, WAYLAND) }).find((r) => r.id === 'glow').value, /^Dithered/)
})

test('HDR output: --force-color-profile=scrgb-linear on native Wayland only; off by default; second to go after a crash', () => {
  assert.equal(settingsStore.defaults().expHdrOutput, false)
  assert.deepEqual(G.startFlags({ expHdrOutput: true }, WAYLAND).switches, [['force-color-profile', 'scrgb-linear']])
  assert.equal(G.startFlags({ expHdrOutput: true }, X11).inactive.expHdrOutput, 'x11')
  const both = G.startFlags({ expHdrOutput: true, expTrueVideoColours: true }, WAYLAND)
  assert.deepEqual(both.switches, [['force-color-profile', 'scrgb-linear'], ['disable-gpu-memory-buffer-video-frames', '']])
  const crash = { type: 'GPU', reason: 'crashed' }
  assert.equal(G.crashTurnOff(crash, both.active, { expHdrOutput: true, expTrueVideoColours: true }).key, 'expHdrOutput', 'HDR before the colour fix')
})

test('HDR screens: her kscreen-doctor output (colour codes included) -> DP-5 HDR at 1.8× SDR white, HDMI-A-2 SDR', () => {
  const H = require('../hdr-screens')
  const s = H.parseKscreen(fs.readFileSync(path.join(__dirname, 'fixtures', 'kscreen-doctor-dp5-hdr.txt'), 'utf8'))
  assert.deepEqual(s.map((x) => [x.name, x.hdr, x.sdrNits, x.peakNits, x.x, x.y, x.width, x.height, x.scale]),
    [['HDMI-A-2', false, null, null, 3200, 0, 450, 1920, 1], ['DP-5', true, 1000, 1800, 0, 0, 3200, 1800, 1.2]])
  assert.equal(H.headroom(s[1]), 1.8, 'peak "unknown, overridden with: 1800" over SDR 1000')
  assert.equal(H.headroom(s[0]), null)
  assert.equal(H.headroom({ hdr: true, sdrNits: 203, peakNits: 5000 }), H.MAX_HEADROOM)
  assert.equal(H.headroom({ hdr: true, sdrNits: 400, peakNits: null }), 1, 'peak unknown: no boost promised')
  assert.deepEqual(H.windowHdr(true, s, { x: 200, y: 200, width: 900, height: 700 }), { on: true, headroom: 1.8, screen: 'DP-5' })
  assert.deepEqual(H.windowHdr(true, s, { x: 3210, y: 100, width: 400, height: 900 }), { on: false, headroom: 1, screen: 'HDMI-A-2' })
  assert.deepEqual(H.windowHdr(false, s, { x: 200, y: 200, width: 900, height: 700 }), { on: false, headroom: 1, screen: '' }, 'HDR output off: never on')
  assert.equal(H.screenFor(s, { x: 3000, y: 100, width: 400, height: 400 }).name, 'HDMI-A-2', 'centre on the side screen')
  assert.equal(H.screensLine(s), 'HDMI-A-2 SDR · DP-5 HDR, peak 1800 / SDR 1000 nits')
  assert.equal(H.screensLine([]), 'No screens read (KDE Plasma: kscreen-doctor)')
})

test('HDR runtime: kscreen-doctor read with a fixed argv and a timeout, only with HDR output active; the windows are told', () => {
  const d = tmp()
  fs.writeFileSync(path.join(d, 'settings.json'), JSON.stringify({ expHdrOutput: true }))
  const calls = []
  const fixture = fs.readFileSync(path.join(__dirname, 'fixtures', 'kscreen-doctor-dp5-hdr.txt'), 'utf8')
  const app = fakeApp(d)
  const saved = { argv: process.argv, platform: Object.getOwnPropertyDescriptor(process, 'platform'), env: process.env }
  process.argv = ['/opt/Sonata/sonata']
  Object.defineProperty(process, 'platform', { value: 'linux' })
  process.env = Object.assign({}, saved.env, { WAYLAND_DISPLAY: 'wayland-0', SONATA_SAFE_GPU: '' })
  let gfx
  try {
    delete require.cache[require.resolve('../gfx-runtime')]
    gfx = require('../gfx-runtime').createGfx({ app, fs, path, settingsStore, log: () => {}, execFile: (cmd, args, opts, cb) => { calls.push([cmd, args, opts.timeout]); cb(null, fixture) } })
    gfx.beforeReady()
  } finally {
    process.argv = saved.argv; Object.defineProperty(process, 'platform', saved.platform); process.env = saved.env
  }
  assert.deepEqual(app.switches, [['force-color-profile', 'scrgb-linear']])
  let told = 0
  gfx.ready({ settings: () => ({ expHdrOutput: true }), turnOff: () => {}, notify: () => {}, changed: () => {}, screensChanged: () => told++ })
  assert.deepEqual(calls, [['kscreen-doctor', ['-o'], 5000]])
  assert.equal(told, 1)
  assert.deepEqual(gfx.hdrFor({ x: 10, y: 10, width: 800, height: 600 }), { on: true, headroom: 1.8, screen: 'DP-5' })
  assert.equal(gfx.snapshot({ gpu_compositing: 'enabled' }).note.expHdrOutput, 'On now.')
  gfx.stop()
})

test('HDR glow: the singer\'s colour keeps its hue, the letters at the headroom, the halo below them, never under SDR white', () => {
  const HG = require('../hdr-glow')
  assert.deepEqual(HG.parseRgb('rgb(255, 128, 0)'), [1, 128 / 255, 0])
  assert.deepEqual(HG.parseRgb('rgba(10, 20, 30, 0.5)').map((x) => Math.round(x * 255)), [10, 20, 30])
  assert.deepEqual(HG.parseRgb('color(srgb 1 0.5 0)'), [1, 0.5, 0])
  assert.equal(HG.parseRgb('red'), null)
  const lin = HG.singLinear([1, 0.4, 0.2])
  assert.equal(Math.max(...lin), 1, 'brightest channel at 1')
  assert.ok(lin[0] >= lin[1] && lin[1] >= lin[2], 'the channel order (the hue) stays')
  assert.ok(Math.min(...lin) >= 0.3, 'leans 30 % toward white')
  assert.equal(HG.glows([0.9, 0.8, 1]), true, 'a light sung word (dark theme) glows')
  assert.equal(HG.glows([0.36, 0.2, 0.55]), false, 'a dark sung word (light theme) keeps its SDR look')
  assert.deepEqual(HG.boosts(1.8), { core: 1.8, halo: 1.4 })
  assert.deepEqual(HG.boosts(0.5), { core: 1, halo: 1 })
  assert.deepEqual(HG.boosts(50), { core: 6, halo: 3.5 })
  // the bold copy of a word: text centred in its box, baseline at half-leading + ascent
  assert.deepEqual(HG.textLayout({ pad: 10, center: true, boxW: 100, textW: 80, top: 0, boxH: 40, elH: 40, ascent: 24, descent: 6 }), { x: 20, y: 39, width: 120, height: 60 })
  assert.equal(HG.textLayout({ pad: 10, center: false, boxW: 50, textW: 48, top: 0, boxH: 40, elH: 40, ascent: 24, descent: 6 }).x, 10, 'a syllable starts at its left')
  assert.match(HG.SHADER, /fn enc\(/)
})

test('HDR glow: rgba16float in extended tone mapping (the DS5 path Marcy saw brightest), wired into both lyric views, no frame loop', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'hdr-glow.js'), 'utf8')
  assert.match(src, /ctx\.configure\(\{ device, format: 'rgba16float', toneMapping: \{ mode: 'extended' \}, alphaMode: 'premultiplied' \}\)/)
  assert.doesNotMatch(src, /requestAnimationFrame|setInterval|setTimeout|Observer\(/, 'one draw per word change')
  assert.match(src, /device\.destroy\(\)/)
  for (const page of ['lyrics.html', 'visualizer.html']) {
    const html = fs.readFileSync(path.join(__dirname, '..', page), 'utf8')
    assert.match(html, /require\('\.\/hdr-glow'\)\.createHdrGlow\(document\)/, page)
    assert.match(html, /ipcRenderer\.on\('lyrics-hdr', \((event|e), s\) => hdrGlow\.set\(s\)\)/, page)
    assert.match(html, /onSung: \(el\) => hdrGlow\.sung\(el\)/, page)
  }
  const view = fs.readFileSync(path.join(__dirname, '..', 'lyrics-view.js'), 'utf8')
  assert.match(view, /if \(opts\.onSung\) sungNow\(gi >= 0 \? -1 : latest\)/)
  const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8')
  assert.match(main, /function trackHdr\(win\) \{\s*if \(!gfx\.hdrActive\) return/, 'nothing registered without HDR output')
  assert.match(main, /win\.webContents\.send\('lyrics-hdr', gfx\.hdrFor\(win\.getBounds\(\)\)\)/)
  const files = require('../package.json').build.files
  assert.ok(files.includes('hdr-glow.js') && files.includes('hdr-screens.js'))
})

test('Hardware video decoding: both Linux decode features, joined with any given; first to go after a crash; the colour fix waits', () => {
  assert.equal(settingsStore.defaults().expHwVideoDecode, false)
  const f = G.startFlags({ expHwVideoDecode: true }, WAYLAND)
  assert.deepEqual(f.switches, [['enable-features', 'VaapiOnNvidiaGPUs,AcceleratedVideoDecodeLinuxGL']])
  assert.deepEqual(G.startFlags({ expHwVideoDecode: true }, withArgs(WAYLAND, '--enable-features=WaylandWindowDecorations')).switches,
    [['enable-features', 'WaylandWindowDecorations,VaapiOnNvidiaGPUs,AcceleratedVideoDecodeLinuxGL']])
  assert.deepEqual(G.startFlags({ expHwVideoDecode: true }, X11).active, ['expHwVideoDecode'], 'X11 too (its colours are right there)')
  // with True video colours also on, the colour switch isn't used (it covers software decoding only)
  const both = G.startFlags({ expHwVideoDecode: true, expTrueVideoColours: true }, WAYLAND)
  assert.deepEqual(both.active, ['expHwVideoDecode'])
  assert.equal(both.inactive.expTrueVideoColours, 'hw-decode')
  // decoding blocked (safe start): the colour switch isn't held back by it
  assert.deepEqual(G.startFlags({ expHwVideoDecode: true, expTrueVideoColours: true }, withArgs(WAYLAND, '--disable-gpu')).inactive, { expHwVideoDecode: 'gpu-off', expTrueVideoColours: 'gpu-off' })
  const all = { expHwVideoDecode: true, expHdrOutput: true, expTrueVideoColours: true }
  const st = G.startFlags(all, WAYLAND)
  const crash = { type: 'GPU', reason: 'crashed' }
  assert.equal(G.crashTurnOff(crash, st.active, all).key, 'expHwVideoDecode', 'hardware decoding first')
  assert.equal(G.crashTurnOff(crash, st.active, Object.assign({}, all, { expHwVideoDecode: false })).key, 'expHdrOutput', 'then HDR')
  assert.equal(G.crashTurnOff(crash, st.active, { expHwVideoDecode: false, expHdrOutput: false, expTrueVideoColours: true }), null, 'the colour switch wasn\'t active this start')
  assert.match(G.EXPERIMENTS.find((e) => e.key === 'expHwVideoDecode').desc, /video colours are currently a little off/)
})

test('Hardware video decoding: About → Graphics says hardware or software from the page and the loaded VA-API driver', () => {
  assert.equal(G.decodeLabel({ powerEfficient: true, hevc: true, drivers: ['nvidia_drv_video.so'] }), 'Hardware (VA-API, NVIDIA); HEVC too')
  assert.equal(G.decodeLabel({ powerEfficient: true, hevc: false, drivers: ['radeonsi_drv_video.so'] }), 'Hardware (VA-API, radeonsi)')
  assert.equal(G.decodeLabel({ powerEfficient: false, drivers: [] }), 'Software (the processor)')
  assert.equal(G.decodeLabel(null), '')
  const row = (st, decode) => G.graphicsRows({ start: st, decode }).find((r) => r.id === 'decode').value
  assert.equal(row(G.startFlags({}, WAYLAND), 'Software (the processor)'), 'Software (the processor)')
  assert.equal(row(G.startFlags({ expHwVideoDecode: true }, withArgs(WAYLAND, '--safe-gpu')), ''), 'checking… · Off for this start: Sonata was started with --safe-gpu')
  // every switch has a readout row, a name, a truthful one-line description and the Experimental label
  for (const e of G.EXPERIMENTS) {
    assert.match(e.label, / \(experimental\)$/, e.key)
    assert.match(e.desc, e.restart ? /Applies at restart\.$/ : /Applies at once\.$/, e.key)
    assert.equal(typeof e.readout, 'function', e.key)
    assert.equal(settingsStore.defaults()[e.key], false, e.key + ' off by default')
  }
  assert.deepEqual(G.EXPERIMENTS.map((e) => e.key), ['expTrueVideoColours', 'expGlowDither', 'expHdrOutput', 'expHwVideoDecode'])
})
