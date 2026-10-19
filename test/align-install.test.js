// align/install.sh: the Precise timing installer (the one installer: a terminal and Settings → Precise
// timing both run it). It installs only an engine signed by the key in align/engine.json, at least
// engine.json's version (or a newer one from a --pin file Sonata writes from the engine feed): download ->
// size, SHA-256 and Ed25519 signature -> the helper's licence (accepted first, by its SHA-256 from Settings)
// -> unpack into <home>/engine-X.Y.Z -> the engine's own setup-venv.sh into <home>/.staging -> a ping ->
// the switch (<home>/venv, <home>/active-engine). Run against a stand-in engine (shell scripts, no Python,
// no engine code) signed with a throwaway key, in a throwaway HOME; the script runs detached (no terminal), as in CI.
const test = require('node:test')
const assert = require('node:assert/strict')
const crypto = require('crypto')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { execFileSync, spawnSync, spawn } = require('child_process')

const INSTALL = path.join(__dirname, '..', 'align', 'install.sh')
const V = '9.9.9'
const fileOf = (v) => 'sonata-engine-' + v + '-linux-x86_64.tar.gz'
const FILE = fileOf(V)

// the stand-in venv recipe: --dry-run says whether the venv is up to date; a build records its arguments
// in $SA_LOG, prints pip-like lines, makes a venv python (and a python3 link into <home>/python, as uv does)
const SETUP = `#!/bin/sh
H="" DRY=0 ARGS=""
while [ $# -gt 0 ]; do case "$1" in --home) H="$2"; shift ;; --dry-run) DRY=1 ;; *) ARGS="$ARGS $1" ;; esac; shift; done
if [ "$DRY" = 1 ]; then if [ -x "$H/venv/bin/python" ] && [ -z "$FAKE_STALE" ]; then echo "packages: up to date"; else echo "packages: to install"; fi; exit 0; fi
echo "\${ARGS# }" >> "$SA_LOG"
[ -z "$FAKE_SLOW" ] || sleep "$FAKE_SLOW"
[ -z "$FAKE_VENV_FAIL" ] || { echo "no Python 3.14 found outside app sandboxes, and no uv to download one." >&2; exit 1; }
echo "Collecting torch==2.11.0"
echo "Downloading torch-2.11.0+cpu-cp314-cp314-manylinux_2_28_x86_64.whl (200.0 MB)"
echo "Progress 100 of 200"
echo "Successfully installed torch-2.11.0"
echo "torch 2.11.0 cpu"
mkdir -p "$H/venv/bin" && printf '#!/bin/sh\\n' > "$H/venv/bin/python" && chmod +x "$H/venv/bin/python"
touch "$H/python/py" && ln -s "$H/python/py" "$H/venv/bin/python3"
printf 'home = %s/python/bin\\n' "$H" > "$H/venv/pyvenv.cfg"
printf '%s\\n' "$VERSION_MARK" > "$H/venv/marker"
case "$ARGS" in *--cpu*|*'--backend cpu'*) v=cpu ;; *'--backend rocm'*) v=rocm7.2 ;; *'--backend xpu'*) v=xpu ;; *) v=cu128 ;; esac
printf 'variant=%s\\n' "$v" > "$H/venv/.sonata-engine-venv"
`
// --check: a pong while the venv (in SONATA_ALIGN_HOME) is there; FAKE_CHECK_FAIL=all|live fails it everywhere or only in place
const CHECK = `#!/bin/sh
[ "$1" = --check ] || exit 0
H="\${SONATA_ALIGN_HOME:-$(dirname "$(dirname "$(readlink -f "$0")")")}"
[ -x "$H/venv/bin/python" ] || exit 1
[ "$FAKE_CHECK_FAIL" = all ] && exit 1
case "$H" in */.staging) ;; *) [ "$FAKE_CHECK_FAIL" = live ] && exit 1 ;; esac
echo '{"type":"pong","protocol":2}'
`

// a signed stand-in engine artifact in dir (version v, protocol p, licence text)
function artifact(dir, privateKey, v, opts = {}) {
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'sa-stage-'))
  const root = path.join(stage, 'sonata-engine-' + v)
  fs.mkdirSync(root)
  const put = (f, text, mode = 0o644) => { fs.writeFileSync(path.join(root, f), text); fs.chmodSync(path.join(root, f), mode) }
  put('ENGINE.json', JSON.stringify(Object.assign({ name: 'sonata-engine', version: v, protocol: opts.protocol || 2, python: '3.14' }, opts.backends ? { backends: opts.backends } : {}), null, 2))
  put('EULA.md', opts.licence || 'TEST HELPER TERMS TEXT\n')
  put('setup-venv.sh', SETUP, 0o755)
  put('sonata-align', CHECK, 0o755)
  const file = fileOf(v)
  execFileSync('tar', ['-czf', path.join(dir, file), '-C', stage, 'sonata-engine-' + v])
  fs.rmSync(stage, { recursive: true, force: true })
  const bytes = fs.readFileSync(path.join(dir, file))
  fs.writeFileSync(path.join(dir, file + '.sig'), crypto.sign(null, bytes, privateKey).toString('base64'))
  return { version: v, protocol: opts.protocol || 2, python: '3.14', file, url: 'https://example.invalid/engine-v' + v + '/' + file, size: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex') }
}

// a throwaway world: HOME, a copy of install.sh with its own pin, a stand-in engine artifact in "rel/"
function world(opts = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sa-install-')))
  const home = path.join(root, 'home')
  const app = path.join(root, 'app', 'align')
  const rel = path.join(root, 'rel')
  for (const d of [home, app, rel]) fs.mkdirSync(d, { recursive: true })
  fs.copyFileSync(INSTALL, path.join(app, 'install.sh'))
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519')
  const key = publicKey.export({ format: 'der', type: 'spki' }).toString('base64')
  const pin = Object.assign(artifact(rel, privateKey, V, opts), { python: '3.12', key }, opts.pin || {})
  fs.writeFileSync(path.join(app, 'engine.json'), JSON.stringify(pin, null, 2) + '\n')
  const log = path.join(root, 'setup-args')
  const env0 = (env) => Object.assign({ HOME: home, PATH: process.env.PATH, SA_LOG: log }, env)
  const run = (args, env = {}) => spawnSync('/bin/sh', [path.join(app, 'install.sh')].concat(args), {
    encoding: 'utf8', detached: true, stdio: ['ignore', 'pipe', 'pipe'], env: env0(env)
  })
  const start = (args, env = {}) => spawn('/bin/sh', [path.join(app, 'install.sh')].concat(args), { detached: true, stdio: ['ignore', 'pipe', 'pipe'], env: env0(env) })
  const done = () => fs.rmSync(root, { recursive: true, force: true })
  const writePin = (p) => { const f = path.join(root, 'pin-' + p.version + '.json'); fs.writeFileSync(f, JSON.stringify(p, null, 2) + '\n'); return f }
  const setupArgs = () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n') : [])
  return { root, home, rel, app, pin, key, privateKey, run, start, done, writePin, setupArgs, sa: path.join(home, '.local', 'share', 'sonata-align') }
}

const field = (out, k) => (new RegExp('^' + k + ': (.*)$', 'm').exec(out) || [])[1]
const engines = (sa) => (fs.existsSync(sa) ? fs.readdirSync(sa).filter((f) => f.startsWith('engine-')) : [])
const events = (out) => out.split('\n').filter((l) => l.startsWith('@@sonata ')).map((l) => JSON.parse(l.slice(9)))
const read = (f) => fs.readFileSync(f, 'utf8')

test('install: --dry-run names the home and the pinned engine; XDG_DATA_HOME inside a snap is ignored', () => {
  const w = world()
  try {
    const r = w.run(['--dry-run'], { XDG_DATA_HOME: path.join(w.home, 'snap', 'codium', '495', '.local', 'share') })
    assert.equal(r.status, 0, r.stderr)
    assert.equal(field(r.stdout, 'home'), w.sa)
    assert.match(field(r.stdout, 'engine'), new RegExp('^' + V.replace(/\./g, '\\.') + ' \\(' + FILE + ', ' + w.pin.size + ' bytes, sha256 ' + w.pin.sha256 + '\\)$'))
    assert.equal(field(r.stdout, 'from'), w.pin.url)
    assert.equal(field(r.stdout, 'installed'), 'no')
    assert.equal(fs.existsSync(w.sa), false)   // nothing written
    const r2 = w.run(['--dry-run', '--from', w.rel], { XDG_DATA_HOME: path.join(w.root, 'data') })
    assert.equal(field(r2.stdout, 'home'), path.join(w.root, 'data', 'sonata-align'))
    assert.equal(field(r2.stdout, 'from'), path.join(w.rel, FILE))
    // a home inside another app's sandbox is refused outright
    const r3 = w.run(['--dry-run'], { SONATA_ALIGN_HOME: path.join(w.home, 'snap', 'codium', '1', 'sa') })
    assert.equal(r3.status, 1)
    assert.match(r3.stderr, /refusing to install .* inside another app's sandbox/)
    // and so is the home folder itself or a relative path
    assert.equal(w.run(['--dry-run'], { SONATA_ALIGN_HOME: w.home }).status, 1)
    assert.equal(w.run(['--dry-run'], { SONATA_ALIGN_HOME: 'rel/sa' }).status, 1)
  } finally { w.done() }
})

test('install: the pinned engine, checked, licence accepted, unpacked; the venv is built aside, then switched in', () => {
  const w = world()
  try {
    const r = w.run(['--from', w.rel, '--accept-licence', '--cpu'])
    assert.equal(r.status, 0, r.stderr + r.stdout)
    assert.match(r.stdout, /checked: size, SHA-256 and signature match the pin/)
    assert.match(r.stdout, /TEST HELPER TERMS TEXT/)   // shown even when accepted by flag
    const dir = path.join(w.sa, 'engine-' + V)
    assert.deepEqual(engines(w.sa), ['engine-' + V])
    assert.equal(JSON.parse(read(path.join(dir, 'ENGINE.json'))).version, V)
    const stamp = read(path.join(dir, '.installed'))
    assert.match(stamp, new RegExp('^sha256=' + w.pin.sha256 + '$', 'm'))
    assert.match(stamp, /^licence_sha256=[0-9a-f]{64}$/m)
    assert.match(stamp, /^licence_accepted=\d{4}-\d\d-\d\dT/m)
    assert.deepEqual(w.setupArgs(), ['--cpu'])
    assert.equal(read(path.join(w.sa, 'active-engine')).trim(), V)
    // built in .staging, moved to the home: its links and pyvenv.cfg point at the home, not .staging
    assert.equal(fs.existsSync(path.join(w.sa, '.staging')), false)
    assert.equal(fs.readlinkSync(path.join(w.sa, 'venv', 'bin', 'python3')), path.join(w.sa, 'python', 'py'))
    assert.equal(read(path.join(w.sa, 'venv', 'pyvenv.cfg')).trim(), 'home = ' + path.join(w.sa, 'python', 'bin'))
    assert.equal(fs.readdirSync(w.sa).filter((f) => f.startsWith('.download')).length, 0)   // the download folders are cleaned up
    // again: nothing is downloaded (the release folder is gone) and the venv is up to date: not rebuilt
    fs.rmSync(w.rel, { recursive: true })
    const r2 = w.run(['--from', w.rel])
    assert.equal(r2.status, 0, r2.stderr)
    assert.match(r2.stdout, /engine 9\.9\.9 is already installed/)
    assert.match(r2.stdout, /venv up to date/)
    assert.deepEqual(w.setupArgs(), ['--cpu'])
    // --rebuild: a new venv (the variant kept: CPU), the old one moved aside, then kept or pruned
    const r3 = w.run(['--rebuild'], { VERSION_MARK: 'second' })
    assert.equal(r3.status, 0, r3.stderr)
    assert.deepEqual(w.setupArgs(), ['--cpu', '--cpu'])
    assert.equal(read(path.join(w.sa, 'venv', 'marker')).trim(), 'second')
    assert.equal(fs.readdirSync(w.sa).filter((f) => f.startsWith('venv.old-')).length, 1)
    assert.match(r3.stdout, /the old venv is in .*venv\.old-/)
    const r4 = w.run(['--rebuild', '--prune'], { VERSION_MARK: 'third' })
    assert.equal(r4.status, 0, r4.stderr)
    assert.equal(fs.readdirSync(w.sa).filter((f) => f.startsWith('venv.old-')).length, 1)   // the one it replaced is gone, the earlier one stays
  } finally { w.done() }
})

test('install --progress: the steps, the download bytes and the end, as JSON lines Settings reads', () => {
  const w = world()
  try {
    const r = w.run(['--from', w.rel, '--accept-licence', '--progress'])
    assert.equal(r.status, 0, r.stderr)
    const ev = events(r.stdout)
    const steps = ev.filter((e) => e.ev === 'step').map((e) => e.step)
    assert.deepEqual(steps.filter((s, i) => steps.indexOf(s) === i), ['download', 'verify', 'venv', 'check'])
    const bytes = ev.filter((e) => e.ev === 'bytes')
    assert.ok(bytes.length >= 1)
    assert.deepEqual(bytes[bytes.length - 1], { ev: 'bytes', step: 'download', got: w.pin.size, total: w.pin.size })
    assert.equal(ev.find((e) => e.step === 'venv').variant, 'cuda')   // the default build
    assert.deepEqual(ev[ev.length - 1], { ev: 'done', version: V })
    // the pip lines of setup-venv.sh come through for the progress parser
    assert.match(r.stdout, /^Progress 100 of 200$/m)
    // an up-to-date venv is said as a skip
    const r2 = w.run(['--progress'])
    assert.ok(events(r2.stdout).some((e) => e.ev === 'skip' && e.step === 'venv'))
  } finally { w.done() }
})

test('install: --licence-only keeps the checked download and its licence; --licence-sha accepts exactly that text', () => {
  const w = world({ licence: 'TERMS v1\n' })
  try {
    const r = w.run(['--from', w.rel, '--licence-only', '--progress'])
    assert.equal(r.status, 0, r.stderr)
    const lic = events(r.stdout).find((e) => e.ev === 'licence')
    assert.equal(lic.version, V)
    assert.equal(lic.sha, crypto.createHash('sha256').update('TERMS v1\n').digest('hex'))
    assert.equal(read(lic.path), 'TERMS v1\n')
    assert.deepEqual(engines(w.sa), [])                       // nothing installed yet
    assert.equal(fs.existsSync(path.join(w.sa, 'venv')), false)
    // another SHA (the licence changed since it was shown): refused, nothing installed, the kept download gone
    const bad = w.run(['--licence-sha', 'a'.repeat(64), '--progress'])
    assert.equal(bad.status, 1)
    assert.equal(events(bad.stdout).pop().code, 'licence')
    assert.deepEqual(engines(w.sa), [])
    assert.equal(fs.existsSync(path.join(w.sa, '.download')), false)
    assert.deepEqual(fs.readdirSync(w.sa).filter((f) => f !== '.install.lock'), [])   // nothing left behind (no empty python/ either; the lock file stays)
    assert.equal(w.run(['--from', w.rel, '--licence-only']).status, 0)
    fs.rmSync(w.rel, { recursive: true })                     // the install uses the kept download
    const ok = w.run(['--licence-sha', lic.sha, '--progress'])
    assert.equal(ok.status, 0, ok.stderr)
    assert.equal(read(path.join(w.sa, 'active-engine')).trim(), V)
    assert.equal(fs.existsSync(path.join(w.sa, '.download')), false)   // the kept download goes after the install
  } finally { w.done() }
})

test('install: no terminal and no --accept-licence: the licence is shown, nothing is installed', () => {
  const w = world()
  try {
    const r = w.run(['--from', w.rel])
    assert.equal(r.status, 1)
    assert.match(r.stdout, /TEST HELPER TERMS TEXT/)
    assert.match(r.stderr, /run it again with --accept-licence/)
    assert.deepEqual(engines(w.sa), [])
    assert.equal(fs.existsSync(path.join(w.sa, 'venv')), false)
  } finally { w.done() }
})

test('install: a download that is not the pinned one is refused (size, SHA-256, signature, key)', () => {
  const cases = [
    ['size', (w) => fs.appendFileSync(path.join(w.rel, FILE), 'x'), /the download is \d+ bytes, the pin says/],
    ['sha256', (w) => { const f = path.join(w.rel, FILE); const b = fs.readFileSync(f); b[b.length - 1] ^= 1; fs.writeFileSync(f, b) }, /SHA-256 is not the pinned one/],
    ['signature', (w) => { const f = path.join(w.rel, FILE + '.sig'); const s = Buffer.from(read(f), 'base64'); s[5] ^= 1; fs.writeFileSync(f, s.toString('base64')) }, /signature does not check out/],
    ['another key', null, /signature does not check out/]
  ]
  // loop: NOT-WORTH — four cases, each its own throwaway world
  for (const [name, spoil, why] of cases) {
    const other = crypto.generateKeyPairSync('ed25519').publicKey.export({ format: 'der', type: 'spki' }).toString('base64')
    const w = world(spoil ? {} : { pin: { key: other } })
    try {
      if (spoil) spoil(w)
      const r = w.run(['--from', w.rel, '--accept-licence', '--progress'])
      assert.equal(r.status, 1, name)
      assert.match(r.stderr, why, name)
      assert.equal(events(r.stdout).pop().code, 'verify', name)
      assert.deepEqual(engines(w.sa), [], name)
      assert.doesNotMatch(r.stdout, /TEST HELPER TERMS TEXT/, name)   // nothing unverified is unpacked or shown
    } finally { w.done() }
  }
})

test('install: a pin with a path in its file name, or a non-https address, is refused', () => {
  const w = world({ pin: { file: '../evil.tar.gz' } })
  try {
    const r = w.run(['--dry-run'])
    assert.equal(r.status, 1)
    assert.match(r.stderr, /bad file name/)
  } finally { w.done() }
  const w2 = world({ pin: { url: 'http://example.invalid/' + FILE } })
  try {
    const r = w2.run(['--dry-run'])
    assert.equal(r.status, 1)
    assert.match(r.stderr, /not https/)
  } finally { w2.done() }
  const w3 = world()
  try {
    // --from: a mirror must be https, a local folder or this machine
    assert.match(w3.run(['--dry-run', '--from', 'ftp://example.invalid/']).stderr, /must be https/)
    assert.match(w3.run(['--dry-run', '--from', 'http://example.invalid/']).stderr, /must be https/)
    assert.equal(w3.run(['--dry-run', '--from', 'http://127.0.0.1:9/']).status, 0)
  } finally { w3.done() }
})

test('install --pin: a newer engine from the feed is installed and becomes active; key, protocol, minimum and downgrade are checked', () => {
  const w = world()
  try {
    assert.equal(w.run(['--from', w.rel, '--accept-licence']).status, 0)
    const newer = Object.assign(artifact(w.rel, w.privateKey, '9.10.0'), { key: w.key })
    const r = w.run(['--pin', w.writePin(newer), '--from', w.rel, '--accept-licence', '--prune', '--progress'], { FAKE_STALE: '1', VERSION_MARK: 'new' })
    assert.equal(r.status, 0, r.stderr)
    assert.equal(read(path.join(w.sa, 'active-engine')).trim(), '9.10.0')
    assert.deepEqual(engines(w.sa), ['engine-9.10.0'])          // --prune: the older engine is gone
    assert.equal(read(path.join(w.sa, 'venv', 'marker')).trim(), 'new')
    assert.equal(fs.readdirSync(w.sa).filter((f) => f.startsWith('venv.old-')).length, 0)
    const refuse = (p, code, re, env) => {
      const x = w.run(['--pin', w.writePin(p), '--from', w.rel, '--accept-licence', '--progress'], env)
      assert.equal(x.status, 1, code)
      assert.equal(events(x.stdout).pop().code, code)
      assert.match(x.stderr, re)
      assert.equal(read(path.join(w.sa, 'active-engine')).trim(), '9.10.0', code)
    }
    // the engine installed is newer: an older one is a downgrade, even one at the minimum
    refuse(Object.assign({}, w.pin), 'downgrade', /older than the installed 9\.10\.0/)
    const plain = w.run(['--from', w.rel, '--accept-licence', '--progress'])   // engine.json's own (older) engine: also no downgrade
    assert.equal(plain.status, 1)
    assert.equal(events(plain.stdout).pop().code, 'downgrade')
    // another key than engine.json's
    const other = crypto.generateKeyPairSync('ed25519').publicKey.export({ format: 'der', type: 'spki' }).toString('base64')
    refuse(Object.assign({}, newer, { version: '9.11.0', file: fileOf('9.11.0'), key: other }), 'pin', /another signing key/)
    // a protocol this Sonata doesn't install, said by the pin or only by the archive's ENGINE.json
    refuse(Object.assign({}, newer, { version: '9.11.0', file: fileOf('9.11.0'), protocol: 3 }), 'protocol', /speaks protocol 3/)
    const p3 = Object.assign(artifact(w.rel, w.privateKey, '9.12.0', { protocol: 3 }), { key: w.key, protocol: 2 })
    refuse(p3, 'protocol', /speaks protocol 3/)
    assert.deepEqual(engines(w.sa), ['engine-9.10.0'])          // nothing of the refused ones stays
  } finally { w.done() }
  // below engine.json's version: refused before anything is downloaded
  const w2 = world()
  try {
    const older = Object.assign(artifact(w2.rel, w2.privateKey, '9.9.8'), { key: w2.key })
    const x = w2.run(['--pin', w2.writePin(older), '--from', w2.rel, '--accept-licence', '--progress'])
    assert.equal(x.status, 1)
    assert.match(x.stderr, /older than 9\.9\.9, the oldest this Sonata runs/)
    assert.equal(fs.existsSync(path.join(w2.sa, 'engine-9.9.8')), false)
  } finally { w2.done() }
})

test('install: a failed venv build or a failed ping leaves the working install as it was', () => {
  const w = world()
  try {
    assert.equal(w.run(['--from', w.rel, '--accept-licence'], { VERSION_MARK: 'old' }).status, 0)
    const newer = Object.assign(artifact(w.rel, w.privateKey, '9.10.0'), { key: w.key })
    const pinFile = w.writePin(newer)
    const same = (what) => {
      assert.equal(read(path.join(w.sa, 'venv', 'marker')).trim(), 'old', what)
      assert.equal(read(path.join(w.sa, 'active-engine')).trim(), V, what)
      assert.deepEqual(engines(w.sa), ['engine-' + V], what)     // the new engine's folder went with the failure
      assert.equal(fs.existsSync(path.join(w.sa, '.staging')), false, what)
      assert.equal(fs.readdirSync(w.sa).filter((f) => f.startsWith('venv.old-')).length, 0, what)
    }
    const v = w.run(['--pin', pinFile, '--from', w.rel, '--accept-licence', '--progress'], { FAKE_STALE: '1', FAKE_VENV_FAIL: '1' })
    assert.equal(v.status, 1)
    assert.equal(events(v.stdout).pop().code, 'venv')
    assert.match(v.stderr, /no Python 3\.14 found/)               // the engine's own words reach Settings' tail
    same('venv')
    const c = w.run(['--pin', pinFile, '--from', w.rel, '--accept-licence', '--progress'], { FAKE_STALE: '1', FAKE_CHECK_FAIL: 'all', VERSION_MARK: 'new' })
    assert.equal(c.status, 1)
    assert.equal(events(c.stdout).pop().code, 'check')
    same('check in .staging')
    // the ping passes in .staging but not in place: the old venv is put back
    const l = w.run(['--pin', pinFile, '--from', w.rel, '--accept-licence', '--progress'], { FAKE_STALE: '1', FAKE_CHECK_FAIL: 'live', VERSION_MARK: 'new' })
    assert.equal(l.status, 1)
    assert.match(l.stderr, /the previous venv is back/)
    same('check in place')
  } finally { w.done() }
})

test('install: cancelled (SIGTERM to its process group) while the venv builds: nothing changes, the staging goes', async () => {
  const w = world()
  try {
    assert.equal(w.run(['--from', w.rel, '--accept-licence'], { VERSION_MARK: 'old' }).status, 0)
    const c = w.start(['--rebuild', '--progress'], { FAKE_SLOW: '5', VERSION_MARK: 'new' })
    let out = ''
    c.stdout.on('data', (d) => { out += d })
    await new Promise((resolve) => { const t = setInterval(() => { if (/"step":"venv"/.test(out)) { clearInterval(t); resolve() } }, 20) })
    process.kill(-c.pid, 'SIGTERM')
    const code = await new Promise((resolve) => c.on('close', (x, sig) => resolve(x === null ? sig : x)))
    assert.notEqual(code, 0)
    assert.ok(/"ev":"cancelled"/.test(out) || code === 'SIGTERM', out)
    assert.equal(read(path.join(w.sa, 'venv', 'marker')).trim(), 'old')
    assert.equal(fs.existsSync(path.join(w.sa, '.staging')), false)
    assert.equal(read(path.join(w.sa, 'active-engine')).trim(), V)
  } finally { w.done() }
})

test('install: not enough free space for a new venv is said before anything is built', () => {
  const w = world()
  try {
    const bin = path.join(w.root, 'bin')
    fs.mkdirSync(bin)
    fs.writeFileSync(path.join(bin, 'df'), '#!/bin/sh\necho "Filesystem 1024-blocks Used Available Capacity Mounted"\necho "/dev/x 100 99 1024 99% /"\n', { mode: 0o755 })
    const r = w.run(['--from', w.rel, '--accept-licence', '--progress'], { PATH: bin + ':' + process.env.PATH })
    assert.equal(r.status, 1)
    const last = events(r.stdout).pop()
    assert.equal(last.code, 'space')
    assert.match(last.message, /needs about 12 GB .* 0 GB are free/)
    assert.equal(fs.existsSync(path.join(w.sa, 'venv')), false)
    assert.deepEqual(engines(w.sa), [])
  } finally { w.done() }
})

test('install --remove: the helper\'s own files go; the models stay unless --delete-models; anything else stays', () => {
  const w = world()
  try {
    assert.equal(w.run(['--from', w.rel, '--accept-licence']).status, 0)
    fs.mkdirSync(path.join(w.sa, 'models'))
    fs.writeFileSync(path.join(w.sa, 'models', 'htdemucs.th'), 'x')
    fs.mkdirSync(path.join(w.sa, 'bench'))
    const r = w.run(['--remove', '--progress'])
    assert.equal(r.status, 0, r.stderr)
    assert.deepEqual(fs.readdirSync(w.sa).sort(), ['bench', 'models'])
    assert.deepEqual(events(r.stdout).pop(), { ev: 'done', removed: true })
    assert.equal(w.run(['--remove', '--delete-models']).status, 0)
    assert.deepEqual(fs.readdirSync(w.sa), ['bench'])
    fs.rmdirSync(path.join(w.sa, 'bench'))
    assert.equal(w.run(['--remove', '--delete-models']).status, 0)
    assert.equal(fs.existsSync(w.sa), false)                       // an empty folder goes too
  } finally { w.done() }
})

test('install: the protocols it installs are engine-feed.js INSTALL_PROTOCOLS, and align-helper.js speaks them', () => {
  const m = /^PROTOCOLS="([\d ]+)"$/m.exec(read(INSTALL))
  assert.ok(m)
  const sh = m[1].trim().split(/\s+/).map(Number)
  assert.deepEqual(sh, require('../engine-feed').INSTALL_PROTOCOLS)
  for (const p of sh) assert.ok(require('../align-helper').PROTOCOLS.includes(p))
})

test('install --pin: development engines (X.Y.Z-dev.N) sort before their release; no downgrade either way', () => {
  const w = world()
  try {
    assert.equal(w.run(['--from', w.rel, '--accept-licence']).status, 0)
    const pinOf = (v) => w.writePin(Object.assign(artifact(w.rel, w.privateKey, v), { key: w.key }))
    const run = (v) => w.run(['--pin', pinOf(v), '--from', w.rel, '--accept-licence', '--progress'], { FAKE_STALE: '1' })
    assert.equal(run('9.10.0-dev.1').status, 0)
    assert.equal(read(path.join(w.sa, 'active-engine')).trim(), '9.10.0-dev.1')
    assert.equal(run('9.10.0-dev.10').status, 0)
    const back = run('9.10.0-dev.2')
    assert.equal(back.status, 1)
    assert.equal(events(back.stdout).pop().code, 'downgrade')
    assert.equal(run('9.10.0').status, 0)
    assert.equal(run('9.10.0-dev.11').status, 1)                   // the release is newer than its development builds
    assert.equal(read(path.join(w.sa, 'active-engine')).trim(), '9.10.0')
  } finally { w.done() }
})

test('install --backend: the engine builds what its ENGINE.json lists; an older engine only NVIDIA or the processor', () => {
  const w = world()   // a stand-in engine without "backends" (like 0.2.1)
  try {
    const r = w.run(['--from', w.rel, '--accept-licence', '--backend', 'rocm', '--progress'])
    assert.equal(r.status, 1)
    const last = events(r.stdout).pop()
    assert.equal(last.code, 'backend')
    assert.match(last.message, /NVIDIA or the processor only; the rocm build needs a newer helper/)
    assert.deepEqual(engines(w.sa), [])                            // the engine it unpacked went again
    assert.equal(w.run(['--from', w.rel, '--accept-licence', '--backend', 'cuda']).status, 0)
    assert.deepEqual(w.setupArgs(), ['--gpu'])
    assert.equal(w.run(['--rebuild', '--backend', 'cpu']).status, 0)
    assert.deepEqual(w.setupArgs(), ['--gpu', '--cpu'])
    assert.equal(w.run(['--backend', 'metal']).status, 2)
  } finally { w.done() }
  const w2 = world({ backends: ['cuda', 'rocm', 'xpu', 'cpu'] })
  try {
    // a disk with room for the ROCm build (24 GB), whatever /tmp has
    const bin = path.join(w2.root, 'bin')
    fs.mkdirSync(bin)
    fs.writeFileSync(path.join(bin, 'df'), '#!/bin/sh\necho "Filesystem 1024-blocks Used Available Capacity Mounted"\necho "/dev/x 1 1 99999999999 1% /"\n', { mode: 0o755 })
    const run0 = w2.run
    w2.run = (args, env = {}) => run0(args, Object.assign({ PATH: bin + ':' + process.env.PATH }, env))
    const r = w2.run(['--from', w2.rel, '--accept-licence', '--backend', 'rocm', '--progress'])
    assert.equal(r.status, 0, r.stderr)
    assert.equal(events(r.stdout).find((e) => e.step === 'venv').variant, 'rocm')
    assert.deepEqual(w2.setupArgs(), ['--backend rocm'])
    // a Repair (no backend named) keeps the venv's: ROCm
    assert.equal(w2.run(['--rebuild']).status, 0)
    assert.deepEqual(w2.setupArgs(), ['--backend rocm', '--backend rocm'])
    assert.equal(w2.run(['--rebuild', '--backend', 'xpu']).status, 0)
    assert.equal(w2.setupArgs().pop(), '--backend xpu')
    // the dry run reports what the engine's recipe says for that backend
    assert.equal(w2.run(['--dry-run', '--backend', 'xpu']).status, 0)
  } finally { w2.done() }
})

// --- killed outright (SIGKILL: a crash, a power cut, Sonata gone): nothing is lost, the next run goes on ---

// a loopback server for the release folder: Range requests answered (206), what each request asked and
// how many bytes went out recorded; stallAfter: the first full answer stops after that many bytes and hangs
function serve(dir, opts = {}) {
  const http = require('http')
  const log = []
  let stalled = false
  // lifetime: OK — closed by the test (close())
  const server = http.createServer((req, res) => {
    const f = path.join(dir, decodeURIComponent(req.url.replace(/^\/+/, '')))
    if (!fs.existsSync(f)) { res.statusCode = 404; res.end(); return }
    const all = fs.readFileSync(f)
    const m = /^bytes=(\d+)-$/.exec(req.headers.range || '')
    const from = m ? +m[1] : 0
    const body = all.subarray(from)
    const entry = { url: req.url, range: req.headers.range || '', sent: 0 }
    log.push(entry)
    res.writeHead(m ? 206 : 200, Object.assign({ 'Content-Length': body.length, ETag: '"e1"', 'Accept-Ranges': 'bytes' }, m ? { 'Content-Range': 'bytes ' + from + '-' + (all.length - 1) + '/' + all.length } : {}))
    if (opts.stallAfter && !stalled && !m && f.endsWith('.tar.gz')) {
      stalled = true
      res.write(body.subarray(0, opts.stallAfter))
      entry.sent = opts.stallAfter
      return   // hangs: the test kills the installer
    }
    entry.sent = body.length
    res.end(body)
  })
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({
    url: 'http://127.0.0.1:' + server.address().port + '/', log,
    close: () => new Promise((r) => { server.closeAllConnections(); server.close(r) })
  })))
}
const until = (fn, ms = 10000) => new Promise((resolve, reject) => {
  const t0 = Date.now()
  // lifetime: OK — cleared when the condition holds or the time is up
  const t = setInterval(() => { if (fn()) { clearInterval(t); resolve() } else if (Date.now() - t0 > ms) { clearInterval(t); reject(new Error('timed out')) } }, 20)
})
const ended = (c) => new Promise((resolve) => c.on('close', (x, sig) => resolve(x === null ? sig : x)))
// a run while the test's own server answers (spawnSync would block it): { status, stdout, stderr }
async function runAsync(w, args, env) {
  const c = w.start(args, env)
  let stdout = ''
  let stderr = ''
  c.stdout.on('data', (d) => { stdout += d })
  c.stderr.on('data', (d) => { stderr += d })
  const status = await ended(c)
  return { status, stdout, stderr }
}

test('install: the engine download killed midway continues where it stopped (Range), is checked whole, then installs', async () => {
  // a big enough engine that half of it is a real part (the licence text pads the archive)
  const w = world({ licence: 'TERMS\n' + crypto.randomBytes(300000).toString('base64') + '\n' })
  const s = await serve(w.rel, { stallAfter: 98304 })
  try {
    const c = w.start(['--from', s.url, '--accept-licence', '--cpu', '--progress'])
    const part = path.join(w.sa, '.resume', FILE)
    // the part has what the server sent and stays put (curl writes in blocks: up to the stall point)
    let last = -1
    let still = 0
    await until(() => { const n = fs.existsSync(part) ? fs.statSync(part).size : 0; still = n > 0 && n === last ? still + 1 : 0; last = n; return still >= 25 })
    process.kill(-c.pid, 'SIGKILL')
    await ended(c)
    const k = fs.statSync(part).size
    assert.ok(k > 0 && k <= 98304)                                     // the part stays (no trap ran)
    assert.ok(w.pin.size > 200000)
    const r = await runAsync(w, ['--from', s.url, '--accept-licence', '--cpu', '--progress'])
    assert.equal(r.status, 0, r.stderr + r.stdout)
    assert.match(r.stdout, new RegExp('continuing the download of the Sonata engine 9\\.9\\.9 at ' + k + ' of \\d+ bytes'))
    const tar = s.log.filter((e) => e.url.endsWith('.tar.gz'))
    assert.equal(tar.length, 2)
    assert.equal(tar[1].range, 'bytes=' + k + '-')                        // asked only for the rest
    assert.equal(tar[1].sent, w.pin.size - k)                     // and got only the rest
    assert.match(r.stdout, /checked: size, SHA-256 and signature match the pin/)
    assert.equal(read(path.join(w.sa, 'active-engine')).trim(), V)
    assert.equal(fs.existsSync(path.join(w.sa, '.resume')), false)     // gone after the install
  } finally { await s.close(); w.done() }
})

test('install: a kept part that is not the pinned file is refused by the checks and deleted, never continued', async () => {
  const w = world()
  const s = await serve(w.rel)
  try {
    fs.mkdirSync(path.join(w.sa, '.resume'), { recursive: true })
    const real = fs.readFileSync(path.join(w.rel, FILE))
    const bad = Buffer.from(real); bad[10] ^= 0xff                     // the right length, one wrong byte
    fs.writeFileSync(path.join(w.sa, '.resume', FILE), bad.subarray(0, 1000))
    const r = await runAsync(w, ['--from', s.url, '--accept-licence', '--progress'])
    assert.equal(r.status, 1)
    assert.equal(events(r.stdout).pop().code, 'verify')
    assert.equal(fs.existsSync(path.join(w.sa, '.resume', FILE)), false)
    const r2 = await runAsync(w, ['--from', s.url, '--accept-licence', '--progress'])   // the next try starts from the start
    assert.equal(r2.status, 0, r2.stderr)
  } finally { await s.close(); w.done() }
})

test('install: an update killed outright while its venv builds leaves the working install; the next run cleans up and goes on', async () => {
  const w = world()
  try {
    assert.equal(w.run(['--from', w.rel, '--accept-licence', '--cpu'], { VERSION_MARK: 'old' }).status, 0)
    const c = w.start(['--rebuild', '--progress'], { FAKE_SLOW: '30', VERSION_MARK: 'new' })
    let out = ''
    c.stdout.on('data', (d) => { out += d })
    await until(() => /"step":"venv"/.test(out))
    process.kill(-c.pid, 'SIGKILL')
    await ended(c)
    // the working install is untouched; the staging is left (no trap ran)
    assert.equal(read(path.join(w.sa, 'venv', 'marker')).trim(), 'old')
    assert.equal(read(path.join(w.sa, 'active-engine')).trim(), V)
    assert.ok(fs.existsSync(path.join(w.sa, '.staging')))
    assert.ok(fs.readdirSync(w.sa).some((f) => f.startsWith('.download.')))
    const r = w.run(['--rebuild'], { VERSION_MARK: 'new' })
    assert.equal(r.status, 0, r.stderr)
    assert.equal(read(path.join(w.sa, 'venv', 'marker')).trim(), 'new')
    assert.equal(fs.existsSync(path.join(w.sa, '.staging')), false)
    assert.deepEqual(fs.readdirSync(w.sa).filter((f) => f.startsWith('.download')), [])
  } finally { w.done() }
})

test('install: killed between moving the old venv aside and switching in the new one: the next run puts it back', () => {
  const w = world()
  try {
    assert.equal(w.run(['--from', w.rel, '--accept-licence', '--cpu'], { VERSION_MARK: 'old' }).status, 0)
    fs.renameSync(path.join(w.sa, 'venv'), path.join(w.sa, 'venv.old-20261019-120000'))   // the state such a kill leaves
    const r = w.run([])
    assert.equal(r.status, 0, r.stderr)
    assert.match(r.stdout, /the previous venv is back/)
    assert.match(r.stdout, /venv up to date/)                          // nothing rebuilt: it was whole
    assert.equal(read(path.join(w.sa, 'venv', 'marker')).trim(), 'old')
  } finally { w.done() }
})

test('install: one run at a time: a second run waits for the first (a run left behind by a killed Sonata)', async () => {
  const w = world()
  try {
    assert.equal(w.run(['--from', w.rel, '--accept-licence', '--cpu']).status, 0)
    const a = w.start(['--rebuild', '--progress'], { FAKE_SLOW: '2', VERSION_MARK: 'a' })
    let outA = ''
    a.stdout.on('data', (d) => { outA += d })
    await until(() => /"step":"venv"/.test(outA))
    const b = w.start(['--rebuild', '--progress'], { VERSION_MARK: 'b' })
    let outB = ''
    b.stdout.on('data', (d) => { outB += d })
    await until(() => /"ev":"wait"/.test(outB))
    assert.equal(await ended(a), 0)
    assert.equal(await ended(b), 0)
    assert.match(outB, /another install of the helper is running/)
    assert.equal(read(path.join(w.sa, 'venv', 'marker')).trim(), 'b')   // the second ran after the first, whole
  } finally { w.done() }
})

test('install --remove: stopped midway, run again: it finishes (Sonata resumes it on the next start)', () => {
  const w = world()
  try {
    assert.equal(w.run(['--from', w.rel, '--accept-licence', '--cpu']).status, 0)
    fs.mkdirSync(path.join(w.sa, 'models'))
    fs.writeFileSync(path.join(w.sa, 'models', 'm.pt'), 'x')
    fs.rmSync(path.join(w.sa, 'engine-' + V), { recursive: true })      // what a kill partway through rm -rf leaves
    fs.mkdirSync(path.join(w.sa, '.resume'))
    const r = w.run(['--remove'])
    assert.equal(r.status, 0, r.stderr)
    assert.deepEqual(fs.readdirSync(w.sa), ['models'])
  } finally { w.done() }
})
