// Settings → Precise timing's Install / Update / Repair / Remove: helper-install-model.js (reading
// install.sh's output into steps and bytes, the plain failure messages, the state row and its buttons) and
// helper-installer.js (the licence flow, the runs of install.sh, cancel, remove) against a fake install.sh
// (a shell script printing the same lines), with real processes so cancel stops a real process group.
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')
const HM = require('../helper-install-model')
const HI = require('../helper-installer')

const pv = (j) => { const v = HM.progressView(j); delete v.whole; return v }
const feedAll = (job, lines) => lines.reduce((j, l) => { const e = HM.parseLine(l); return e ? HM.reduce(j, e) : j }, job)

test('progress: install.sh markers, pip and uv lines become steps, bytes and packages', () => {
  assert.deepEqual(HM.parseLine('@@sonata {"ev":"bytes","step":"download","got":5,"total":10}'), { ev: 'bytes', step: 'download', got: 5, total: 10 })
  assert.equal(HM.parseLine('@@sonata {broken'), null)
  assert.deepEqual(HM.parseLine('Downloading torch-2.11.0+cu128-cp314-cp314-manylinux_2_28_x86_64.whl (846.4 MB)'), { ev: 'pkg', name: 'torch', bytes: 846400000 })
  assert.deepEqual(HM.parseLine('Downloading nvidia_cudnn_cu12-9.10.2.21-py3-none-manylinux_2_27_x86_64.whl (706.8 MB)'), { ev: 'pkg', name: 'nvidia-cudnn-cu12', bytes: 706800000 })
  assert.deepEqual(HM.parseLine('Downloading torch (846.4MiB)'), { ev: 'pkg', name: 'torch', bytes: Math.round(846.4 * 1048576) })
  assert.deepEqual(HM.parseLine(' Downloaded torch'), { ev: 'pkg-done', name: 'torch' })
  assert.deepEqual(HM.parseLine('Progress 262144 of 16354295'), { ev: 'pkg-bytes', got: 262144, total: 16354295 })
  assert.equal(HM.parseLine(' + torch==2.11.0+cu128').ev, 'torch-done')
  assert.equal(HM.parseLine('Successfully installed nvidia-cublas-cu12-12.8 torch-2.11.0 torchaudio-2.11.0').ev, 'torch-done')
  assert.equal(HM.parseLine('torch 2.11.0+cu128 cuda').ev, 'packages-done')
  assert.equal(HM.parseLine('Resolved 2 packages in 411ms'), null)
  // a whole install, pip style: 7 steps (no models yet), the venv steps moved by the lines
  let j = HM.newJob('install', { hasModels: false })
  assert.deepEqual(pv(j), { stepNo: 1, stepCount: 7, label: 'Downloading the helper', fraction: null, detail: '' })
  j = feedAll(j, ['@@sonata {"ev":"step","step":"download"}', '@@sonata {"ev":"bytes","step":"download","got":750000,"total":1500000}'])
  assert.equal(HM.progressView(j).fraction, 0.5)
  assert.equal(HM.progressView(j).detail, '750 kB of 2 MB')
  j = feedAll(j, ['@@sonata {"ev":"step","step":"verify"}', '@@sonata {"ev":"step","step":"venv","variant":"gpu"}'])
  assert.equal(HM.progressView(j).label, 'Setting up Python')
  j = feedAll(j, ['Collecting torch==2.11.0', 'Downloading torch-2.11.0+cu128-cp314-cp314-manylinux_2_28_x86_64.whl (846.4 MB)', 'Progress 423200000 of 846400000', '@@sonata {"ev":"size","bytes":3660000000}'])
  let v = HM.progressView(j)
  assert.equal(v.stepNo, 4)
  assert.equal(v.label, 'Installing PyTorch')
  assert.equal(Math.round(v.fraction * 100), 30)    // half: 423 MB of ~3.9 GB downloaded, half: 3.66 of ~7.3 GB on disk
  assert.equal(v.detail, 'torch: 423 MB of 846 MB · 3.7 GB of about 7.3 GB installed')
  assert.equal(Math.round(v.whole * 100), 29)        // 4 % before the venv + 81 % × 0.30
  // pip upgrading itself first is not PyTorch yet
  assert.equal(feedAll(HM.newJob('install'), ['@@sonata {"ev":"step","step":"venv"}', 'Downloading pip-25.2-py3-none-any.whl (1.8 MB)']).step, 'venv')
  j = feedAll(j, ['Successfully installed torch-2.11.0 torchaudio-2.11.0', 'Collecting demucs==4.1.0'])
  assert.equal(HM.progressView(j).label, 'Installing the other packages')
  j = feedAll(j, ['torch 2.11.0+cu128 cuda', '@@sonata {"ev":"step","step":"check"}'])
  assert.equal(HM.progressView(j).label, 'Testing the helper')
  // the one bar follows time, not step names: Python + PyTorch + packages are 81 % of an install
  assert.equal(Math.round(HM.progressView(j).whole * 100), 85)   // the test step starts at 85 % (the venv steps are 81 of 100)
  j = HM.reduce(j, { ev: 'models', p: 0.25, detail: 'en 315/1262 MB' })
  assert.deepEqual(pv(j), { stepNo: 7, stepCount: 7, label: 'Downloading the models', fraction: 0.25, detail: 'English aligner: 315 of 1262 MB' })
  // an update whose packages are unchanged: the three venv steps drop out; with models: no models step
  let u = HM.newJob('update', { hasModels: true })
  u = feedAll(u, ['@@sonata {"ev":"step","step":"verify"}', '@@sonata {"ev":"skip","step":"venv"}', '@@sonata {"ev":"step","step":"check"}'])
  assert.deepEqual([HM.progressView(u).stepNo, HM.progressView(u).stepCount], [3, 3])
  // pip downloads everything first: the bar and the words follow the downloads, package by package
  let d = feedAll(HM.newJob('install'), ['@@sonata {"ev":"step","step":"venv"}', 'Downloading torch-2.11.0+cu128-cp314-cp314-manylinux_2_28_x86_64.whl (820.3 MB)', 'Progress 820300000 of 820300000',
    'Downloading nvidia_cudnn_cu12-9.10.2.21-py3-none-manylinux_2_27_x86_64.whl (1130.0 MB)', 'Progress 130000000 of 1130000000', '@@sonata {"ev":"size","bytes":14000000}'])
  assert.equal(d.dlDone, 820300000)
  assert.equal(HM.progressView(d).detail, 'nvidia-cudnn-cu12: 130 MB of 1.1 GB · 950 MB of about 3.9 GB downloaded')
  assert.equal(Math.round(HM.progressView(d).fraction * 100), 12)
  // steps never go backwards (install.sh says "check" twice: in .staging and in place)
  assert.equal(HM.reduce(j, { ev: 'step', step: 'venv' }).step, 'models')
  // uv: a line per big package, no byte counts; the venv size still moves the bar
  let w = feedAll(HM.newJob('install', {}), ['@@sonata {"ev":"step","step":"venv","variant":"cpu"}', 'Using Python 3.14.4 environment at: /x/.staging/venv', 'Downloading torch (180.2MiB)', '@@sonata {"ev":"size","bytes":550000000}'])
  v = HM.progressView(w)
  assert.equal(v.label, 'Installing PyTorch')
  assert.equal(v.fraction, 0.25)                      // half of it: 550 MB of the CPU build's ~1.1 GB on disk
  assert.match(v.detail, /^Downloading torch \(189 MB\) · 550 MB of about 1\.1 GB installed$/)
})

test('failures: plain words with what to do, from the code and the last lines', () => {
  const f = (code, extra = {}) => HM.failText(Object.assign(HM.newJob('install'), { phase: 'failed', code }, extra))
  assert.match(f('download'), /internet connection/)
  assert.match(f('verify'), /didn't pass Sonata's checks .*nothing was installed/)
  assert.match(f('venv', { tail: ['no Python 3.14 found outside app sandboxes, and no uv to download one.'] }), /needs Python 3\.14 .*python3\.14 from your distribution/)
  assert.match(f('venv', { tail: ['OSError: [Errno 28] No space left on device'] }), /disk ran full/)
  assert.match(f('venv'), /previous install is unchanged/)
  assert.match(f('space', { message: 'not enough free space for the helper: it needs about 9 GB in /h, 2 GB are free' }), /9 GB .*2 GB are free\. Free some space/)
  assert.match(f('check'), /previous install stays in use/)
  assert.match(f('licence'), /accept it to go on/)
  assert.match(f('protocol'), /Update Sonata first/)
  assert.match(f('whatever', { message: 'boom' }), /stopped: boom/)
})

test('state row: short (≤ 60 characters, the rest behind the ⓘ) for every state; buttons only when they do something', () => {
  const rows = {
    missing: { state: 'missing', min: '0.2.1' },
    ok: { state: 'ok', version: '0.2.1', py: '3.14', gpu: 'NVIDIA GeForce RTX 5080' },
    available: { state: 'ok', version: '0.2.1', py: '3.14', available: '0.2.2' },
    update: { state: 'update', want: '0.2.1', py: '3.13', wantPy: '3.14' },
    broken: { state: 'broken', target: '/usr/bin/python3.13' },
    sandboxed: { state: 'sandboxed', target: '/h/snap/codium/495/python' },
    stray: { state: 'stray', target: '/h/snap/x' },
    running: { state: 'ok', version: '0.2.1', phase: 'running', job: Object.assign(HM.newJob('update', { hasModels: true }), { step: 'venv' }) },
    fetch: { state: 'missing', phase: 'licence-fetch', job: HM.newJob('install') }
  }
  const want = {
    missing: ['Not installed', ['install']],
    ok: ['Installed: helper 0.2.1, Python 3.14, NVIDIA RTX 5080', ['remove']],
    available: ['Update available: 0.2.2', ['update', 'remove']],
    update: ['Needs an update', ['update', 'remove']],
    broken: ['Needs a repair: its Python is gone', ['repair', 'remove']],
    sandboxed: ['Needs a repair: its Python is inside another app', ['repair', 'remove']],
    stray: ['Installed in the wrong place', ['install', 'remove']],
    running: ['Updating… step 3 of 6', ['cancel']],
    fetch: ['Installing… step 1 of 7', ['cancel']]
  }
  // loop: NOT-WORTH — nine states
  for (const [k, h] of Object.entries(rows)) {
    const r = HM.stateRow(h)
    assert.equal(r.text, want[k][0], k)
    assert.ok(r.text.length <= 60, k + ': ' + r.text.length)
    assert.deepEqual(HM.buttons(h), want[k][1], k)
  }
  assert.match(HM.stateRow(rows.update).info, /on Python 3\.14 \(the installed one is on 3\.13\)/)
  assert.match(HM.stateRow(rows.missing).info, /licence, shown before anything is installed.*about 10 GB/)
  // while the licence or the confirmation shows, the row has no buttons (they are in the page below it)
  assert.deepEqual(HM.buttons({ state: 'missing', phase: 'licence' }), [])
  assert.equal(HM.stateRow({ state: 'missing', phase: 'licence', job: HM.newJob('install') }).text, 'Waiting for you to accept the licence')
  assert.deepEqual(HM.buttons({ state: 'ok', confirmRemove: true }), [])
  // a removal runs to its end (no Cancel); models left after Remove: "Delete the models…"
  assert.deepEqual(HM.buttons({ state: 'ok', phase: 'running', job: Object.assign(HM.newJob('remove'), { kind: 'remove' }) }), [])
  assert.deepEqual(HM.buttons({ state: 'missing', models: true }), ['install', 'remove'])
  assert.equal(HM.bytesText(2.6e9), '2.6 GB')
  assert.equal(HM.bytesText(12e9), '12 GB')
})

// --- helper-installer.js against a fake install.sh ---
const FAKE = `#!/bin/sh
printf '%s\\n' "$*" >> "$ARGS_LOG"
case " $* " in *" --licence-only "*)
  printf 'TERMS %s\\n' "$TERMS" > "$LIC"
  echo '@@sonata {"ev":"step","step":"download"}'
  [ "$SCEN" = nolicence ] && { echo '@@sonata {"ev":"fail","code":"download","message":"offline"}'; exit 1; }
  echo "@@sonata {\\"ev\\":\\"licence\\",\\"version\\":\\"1.2.3\\",\\"sha\\":\\"$LSHA\\",\\"path\\":\\"$LIC\\"}"
  exit 0 ;;
esac
case " $* " in *" --remove "*) echo '@@sonata {"ev":"step","step":"remove"}'; echo '@@sonata {"ev":"done","removed":true}'; exit 0 ;; esac
echo '@@sonata {"ev":"step","step":"download"}'
echo '@@sonata {"ev":"bytes","step":"download","got":50,"total":100}'
echo '@@sonata {"ev":"step","step":"verify"}'
echo '@@sonata {"ev":"step","step":"venv","variant":"gpu"}'
echo 'Collecting torch==2.11.0'
if [ "$SCEN" = slow ]; then trap 'echo "@@sonata {\\"ev\\":\\"cancelled\\"}"; exit 130' TERM; sleep 20 & wait; fi
if [ "$SCEN" = fail ]; then echo "no Python 3.14 found outside app sandboxes, and no uv to download one." >&2; echo '@@sonata {"ev":"fail","code":"venv","message":"x"}'; exit 1; fi
echo 'Successfully installed torch-2.11.0'
echo 'torch 2.11.0 cuda'
echo '@@sonata {"ev":"step","step":"check"}'
echo '@@sonata {"ev":"done","version":"1.2.3"}'
`
function rig(env = {}, o = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sa-installer-')))
  const script = path.join(root, 'install.sh')
  fs.writeFileSync(script, FAKE, { mode: 0o755 })
  const log = path.join(root, 'args')
  const states = []
  const calls = { accepted: [], after: [], before: [], models: 0 }
  let accepted = typeof o.accepted === 'object' ? o.accepted : { sha: o.accepted || '', version: '' }
  const inst = HI.createHelperInstaller({
    script, home: () => path.join(root, 'home'),
    env: Object.assign({ PATH: process.env.PATH, ARGS_LOG: log, LIC: path.join(root, 'EULA.md'), LSHA: 'f'.repeat(64), TERMS: 'v1' }, env),
    log: () => {},
    onChange: (s) => states.push(s),
    acceptedLicence: () => accepted,
    onAccepted: (sha, version, lv) => { accepted = { sha, version: lv || '' }; calls.accepted.push([sha, version]) },
    before: (k) => calls.before.push(k),
    after: (k, job) => calls.after.push([k, job && job.phase]),
    models: o.models || (async (job, report) => { calls.models++; report({ p: 0.5, detail: 'en 631/1262 MB' }); report({ p: 1, detail: '' }) })
  })
  const args = () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n') : [])
  return { root, inst, states, calls, args, done: () => fs.rmSync(root, { recursive: true, force: true }) }
}
const waitFor = (fn, ms = 5000) => new Promise((resolve, reject) => {
  const t0 = Date.now()
  const t = setInterval(() => { if (fn()) { clearInterval(t); resolve() } else if (Date.now() - t0 > ms) { clearInterval(t); reject(new Error('timed out')) } }, 10)
})

test('installer: the licence first (from the checked download), then the install accepting exactly that text, then the models', async () => {
  const r = rig()
  try {
    assert.equal(await r.inst.start('install', { hasModels: false }), true)
    assert.equal(r.inst.state().phase, 'licence')
    assert.deepEqual(r.inst.state().licence, { version: '1.2.3', sha: 'f'.repeat(64), text: 'TERMS v1\n', licenceVersion: '' })
    assert.deepEqual(r.args(), ['--progress --licence-only'])
    assert.equal(r.inst.busy, false)                    // waiting for the person, nothing running
    assert.equal(r.inst.accept(), true)
    await waitFor(() => r.calls.after.length === 1)
    assert.deepEqual(r.calls.accepted, [['f'.repeat(64), '1.2.3']])
    assert.deepEqual(r.args()[1], '--progress --licence-sha ' + 'f'.repeat(64) + ' --prune')
    assert.equal(r.calls.models, 1)
    assert.deepEqual(r.calls.after, [['install', 'done']])
    assert.equal(r.inst.state().phase, 'done')
    // progress went through the steps up to the models
    const steps = r.states.filter((s) => s.job).map((s) => s.job.step)
    for (const s of ['download', 'verify', 'venv', 'torch', 'packages', 'check', 'models']) assert.ok(steps.includes(s), s)
    assert.ok(r.states.some((s) => s.job && s.job.modelP === 0.5))
    // the next update: the licence is the same one, so it isn't asked again; models there: no models step
    r.inst.dismiss()
    assert.equal(await r.inst.start('update', { hasModels: true }), true)
    assert.equal(r.inst.state().phase, 'done')
    assert.equal(r.calls.models, 1)
    assert.equal(r.calls.accepted.length, 1)
  } finally { r.done() }
})

test('installer: a changed licence is asked again; Cancel on the licence installs nothing', async () => {
  const r = rig({ LSHA: 'e'.repeat(64), TERMS: 'v2' }, { accepted: 'f'.repeat(64) })
  try {
    await r.inst.start('update', { hasModels: true })
    assert.equal(r.inst.state().phase, 'licence')
    assert.equal(r.inst.state().licence.text, 'TERMS v2\n')
    assert.equal(r.inst.cancel(), true)                 // Cancel while the licence shows = decline
    assert.equal(r.inst.state().phase, 'idle')
    assert.deepEqual(r.args(), ['--progress --licence-only'])
    assert.equal(r.inst.accept(), false)
  } finally { r.done() }
})

test('installer: the feed\'s licence: another version is asked again; a text that is not the named SHA-256 is refused', async () => {
  const r = rig({}, { accepted: { sha: 'f'.repeat(64), version: 'draft-1' } })
  try {
    await r.inst.start('update', { hasModels: true, licence: { version: 'draft-1', sha256: 'f'.repeat(64) } })
    assert.equal(r.inst.state().phase, 'done')            // same text, same version: not asked
    r.inst.dismiss()
    await r.inst.start('update', { hasModels: true, licence: { version: 'draft-2', sha256: 'f'.repeat(64) } })
    assert.equal(r.inst.state().phase, 'licence')         // same text, a new licence version: asked again
    assert.equal(r.inst.state().licence.licenceVersion, 'draft-2')
    r.inst.decline()
    assert.equal(await r.inst.start('update', { hasModels: true, licence: { version: 'draft-1', sha256: 'a'.repeat(64) } }), false)
    assert.equal(r.inst.state().job.code, 'verify')
  } finally { r.done() }
})

test('installer: a feed engine goes in as a --pin file (removed afterwards); repair rebuilds', async () => {
  const r = rig({}, { accepted: 'f'.repeat(64) })
  try {
    await r.inst.start('update', { pinText: '{"version": "1.2.3"}\n', from: 'http://127.0.0.1:9/engine-v1.2.3/', hasModels: true })
    const a = r.args()
    assert.match(a[0], /^--progress --pin (\S+engine\.json) --from http:\/\/127\.0\.0\.1:9\/engine-v1\.2\.3\/ --licence-only$/)
    const pinFile = /--pin (\S+)/.exec(a[0])[1]
    assert.match(a[1], /--pin \S+ --from \S+ --licence-sha f{64} --prune$/)
    assert.equal(fs.existsSync(pinFile), false)
    r.inst.dismiss()
    await r.inst.start('repair', { hasModels: true })
    assert.match(r.args()[3], /^--progress --rebuild --licence-sha/)
  } finally { r.done() }
})

test('installer: a failure keeps its last lines for the plain message; a failed licence fetch installs nothing', async () => {
  const r = rig({ SCEN: 'fail' }, { accepted: 'f'.repeat(64) })
  try {
    assert.equal(await r.inst.start('install', { hasModels: true }), false)
    const job = r.inst.state().job
    assert.equal(job.phase, 'failed')
    assert.equal(job.code, 'venv')
    assert.match(HM.failText(job), /needs Python 3\.14/)
    assert.deepEqual(r.calls.after, [['install', 'failed']])
  } finally { r.done() }
  const r2 = rig({ SCEN: 'nolicence' })
  try {
    assert.equal(await r2.inst.start('install', {}), false)
    assert.equal(r2.inst.state().job.code, 'download')
    assert.equal(r2.args().length, 1)
  } finally { r2.done() }
})

test('installer: Cancel stops the installer\'s process group; the job ends cancelled', async () => {
  const r = rig({ SCEN: 'slow' }, { accepted: 'f'.repeat(64) })
  try {
    const p = r.inst.start('install', { hasModels: true })
    await waitFor(() => r.inst.state().job && r.inst.state().job.step === 'torch')
    assert.equal(r.inst.busy, true)
    assert.equal(r.inst.cancel(), true)
    assert.equal(await p, false)
    assert.equal(r.inst.state().phase, 'cancelled')
    assert.equal(r.inst.busy, false)
    assert.deepEqual(r.calls.after, [['install', 'cancelled']])
  } finally { r.done() }
})

test('installer: Remove passes --delete-models only when asked; nothing starts while a job runs', async () => {
  const r = rig()
  try {
    assert.equal(await r.inst.remove(false), true)
    assert.equal(await r.inst.remove(true), true)
    assert.deepEqual(r.args(), ['--progress --remove', '--progress --remove --delete-models'])
    assert.deepEqual(r.calls.before, ['remove', 'remove'])
  } finally { r.done() }
  const r2 = rig({ SCEN: 'slow' }, { accepted: 'f'.repeat(64) })
  try {
    const p = r2.inst.start('install', { hasModels: true })
    await waitFor(() => r2.inst.busy)
    assert.equal(await r2.inst.start('install', {}), false)
    assert.equal(await r2.inst.remove(true), false)
    assert.equal(r2.inst.dismiss(), false)
    r2.inst.stop()                                      // app quit
    await p
    assert.equal(r2.inst.state().phase, 'cancelled')
  } finally { r2.done() }
})

test('installer: the script beside the asar (AppImage) and a clean environment', () => {
  assert.equal(HI.scriptPath('/tmp/.mount_SonataX/resources/app.asar'), '/tmp/.mount_SonataX/resources/app.asar.unpacked/align/install.sh')
  assert.equal(HI.scriptPath('/home/m/src/sonata'), '/home/m/src/sonata/align/install.sh')
  const env = HI.installerEnv({ PATH: '/usr/bin', LD_LIBRARY_PATH: '/tmp/.mount_x/usr/lib', PYTHONPATH: '/x', APPDIR: '/tmp/.mount_x', HOME: '/h' }, '/h/sa')
  assert.deepEqual(Object.keys(env).sort(), ['HOME', 'LC_ALL', 'PATH', 'PYTHONUNBUFFERED', 'SONATA_ALIGN_HOME'])
  assert.equal(env.SONATA_ALIGN_HOME, '/h/sa')
})
