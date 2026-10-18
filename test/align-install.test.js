// align/install.sh: the Precise timing bootstrap. It installs only the engine release pinned in
// align/engine.json: download -> size, SHA-256 and Ed25519 signature -> the helper's licence (accepted
// first) -> unpack into <home>/engine-X.Y.Z -> the engine's own setup-venv.sh. Run against a stand-in
// engine (shell scripts, no Python, no engine code) signed with a throwaway key, in a throwaway HOME;
// the script runs detached (no terminal), as in CI.
const test = require('node:test')
const assert = require('node:assert/strict')
const crypto = require('crypto')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { execFileSync, spawnSync } = require('child_process')

const INSTALL = path.join(__dirname, '..', 'align', 'install.sh')
const V = '9.9.9'
const FILE = 'sonata-engine-' + V + '-linux-x86_64.tar.gz'

// a throwaway world: HOME, a copy of install.sh with its own pin, a stand-in engine artifact in "rel/"
function world(opts = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sa-install-')))
  const home = path.join(root, 'home')
  const app = path.join(root, 'app', 'align')
  const rel = path.join(root, 'rel')
  const stage = path.join(root, 'stage', 'sonata-engine-' + V)
  for (const d of [home, app, rel, stage]) fs.mkdirSync(d, { recursive: true })
  fs.copyFileSync(INSTALL, path.join(app, 'install.sh'))
  const put = (f, text, mode = 0o644) => { fs.writeFileSync(path.join(stage, f), text); fs.chmodSync(path.join(stage, f), mode) }
  put('ENGINE.json', JSON.stringify({ name: 'sonata-engine', version: V, protocol: 2 }))
  put('EULA.md', 'TEST HELPER TERMS TEXT\n')
  // the stand-in venv recipe: records its arguments, makes a venv python
  put('setup-venv.sh', '#!/bin/sh\nwhile [ $# -gt 0 ]; do case "$1" in --home) H="$2"; shift 2; continue ;; esac; echo "$1" >> "$H/setup-args"; shift; done\nmkdir -p "$H/venv/bin" && printf "#!/bin/sh\\n" > "$H/venv/bin/python" && chmod +x "$H/venv/bin/python"\n', 0o755)
  put('sonata-align', '#!/bin/sh\n[ "$1" = --check ] && echo \'{"type":"pong","protocol":2}\'\n', 0o755)
  execFileSync('tar', ['-czf', path.join(rel, FILE), '-C', path.dirname(stage), path.basename(stage)])
  const bytes = fs.readFileSync(path.join(rel, FILE))
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519')
  fs.writeFileSync(path.join(rel, FILE + '.sig'), crypto.sign(null, bytes, privateKey).toString('base64'))
  const pin = Object.assign({
    version: V, protocol: 2, python: '3.12', file: FILE,
    url: 'https://example.invalid/engine-v' + V + '/' + FILE,
    size: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
    key: publicKey.export({ format: 'der', type: 'spki' }).toString('base64')
  }, opts.pin || {})
  fs.writeFileSync(path.join(app, 'engine.json'), JSON.stringify(pin, null, 2) + '\n')
  const run = (args, env = {}) => spawnSync('/bin/sh', [path.join(app, 'install.sh')].concat(args), {
    encoding: 'utf8', detached: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: Object.assign({ HOME: home, PATH: process.env.PATH }, env)
  })
  const done = () => fs.rmSync(root, { recursive: true, force: true })
  return { root, home, rel, pin, run, done, sa: path.join(home, '.local', 'share', 'sonata-align') }
}

const field = (out, k) => (new RegExp('^' + k + ': (.*)$', 'm').exec(out) || [])[1]
const engines = (sa) => (fs.existsSync(sa) ? fs.readdirSync(sa).filter((f) => f.startsWith('engine-')) : [])

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
  } finally { w.done() }
})

test('install: the pinned engine, checked, licence accepted, unpacked; the engine builds the venv', () => {
  const w = world()
  try {
    const r = w.run(['--from', w.rel, '--accept-licence', '--cpu'])
    assert.equal(r.status, 0, r.stderr + r.stdout)
    assert.match(r.stdout, /checked: size, SHA-256 and signature match the pin/)
    assert.match(r.stdout, /TEST HELPER TERMS TEXT/)   // shown even when accepted by flag
    const dir = path.join(w.sa, 'engine-' + V)
    assert.deepEqual(engines(w.sa), ['engine-' + V])
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'ENGINE.json'), 'utf8')).version, V)
    const stamp = fs.readFileSync(path.join(dir, '.installed'), 'utf8')
    assert.match(stamp, new RegExp('^sha256=' + w.pin.sha256 + '$', 'm'))
    assert.match(stamp, /^licence_accepted=\d{4}-\d\d-\d\dT/m)
    assert.deepEqual(fs.readFileSync(path.join(w.sa, 'setup-args'), 'utf8').trim().split('\n'), ['--cpu'])
    assert.equal(fs.readdirSync(w.sa).filter((f) => f.startsWith('.download')).length, 0)   // the download folder is cleaned up
    // again: nothing is downloaded (the release folder is gone), the venv step runs again
    fs.rmSync(w.rel, { recursive: true })
    const r2 = w.run(['--from', w.rel])
    assert.equal(r2.status, 0, r2.stderr)
    assert.match(r2.stdout, /engine 9\.9\.9 is already installed/)
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
    ['signature', (w) => { const f = path.join(w.rel, FILE + '.sig'); const s = Buffer.from(fs.readFileSync(f, 'utf8'), 'base64'); s[5] ^= 1; fs.writeFileSync(f, s.toString('base64')) }, /signature does not check out/],
    ['another key', null, /signature does not check out/]
  ]
  // loop: NOT-WORTH — four cases, each its own throwaway world
  for (const [name, spoil, why] of cases) {
    const other = crypto.generateKeyPairSync('ed25519').publicKey.export({ format: 'der', type: 'spki' }).toString('base64')
    const w = world(spoil ? {} : { pin: { key: other } })
    try {
      if (spoil) spoil(w)
      const r = w.run(['--from', w.rel, '--accept-licence'])
      assert.equal(r.status, 1, name)
      assert.match(r.stderr, why, name)
      assert.deepEqual(engines(w.sa), [], name)
      assert.doesNotMatch(r.stdout, /TEST HELPER TERMS TEXT/, name)   // nothing unverified is unpacked or shown
    } finally { w.done() }
  }
})

test('install: a pin with a path in its file name is refused', () => {
  const w = world({ pin: { file: '../evil.tar.gz' } })
  try {
    const r = w.run(['--dry-run'])
    assert.equal(r.status, 1)
    assert.match(r.stderr, /bad file name/)
  } finally { w.done() }
})
