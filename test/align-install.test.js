// align/install.sh and align/sonata-align: where the install goes and which Python builds the venv
// (0.15.38, the Codium snap venv). Run in a throwaway HOME with fake interpreters on a private PATH;
// --dry-run changes nothing.
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { execFileSync, spawnSync } = require('child_process')

const INSTALL = path.join(__dirname, '..', 'align', 'install.sh')
const LAUNCH = path.join(__dirname, '..', 'align', 'sonata-align')

// a throwaway world: HOME, a tools dir with the few commands the scripts use, fake pythons
function world() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sa-install-')))
  const home = path.join(root, 'home')
  const tools = path.join(root, 'tools')
  fs.mkdirSync(home)
  fs.mkdirSync(tools)
  for (const t of ['readlink', 'dirname', 'date', 'mkdir', 'mv', 'rm', 'sed', 'head', 'sh']) {
    const p = execFileSync('sh', ['-c', 'command -v ' + t], { encoding: 'utf8' }).trim()
    fs.symlinkSync(p, path.join(tools, t))
  }
  // a fake interpreter: answers the version check with `ok` (0 = usable)
  const fake = (dir, name, ok = true) => {
    fs.mkdirSync(dir, { recursive: true })
    const f = path.join(dir, name)
    fs.writeFileSync(f, '#!/bin/sh\nexit ' + (ok ? 0 : 1) + '\n')
    fs.chmodSync(f, 0o755)
    return f
  }
  const run = (script, args, env) => spawnSync('/bin/sh', [script].concat(args), {
    encoding: 'utf8', env: Object.assign({ HOME: home }, env, { PATH: (env.PATH ? env.PATH + ':' : '') + tools })
  })
  const done = () => fs.rmSync(root, { recursive: true, force: true })
  return { root, home, fake, run, done }
}

const field = (out, k) => (new RegExp('^' + k + ': (.*)$', 'm').exec(out) || [])[1]

test('install: XDG_DATA_HOME inside a snap is ignored; ~/.local/share/sonata-align instead', () => {
  const w = world()
  try {
    const sys = w.fake(path.join(w.root, 'usr', 'bin'), 'python3.13')
    const r = w.run(INSTALL, ['--dry-run'], { XDG_DATA_HOME: path.join(w.home, 'snap', 'codium', '495', '.local', 'share'), PATH: path.dirname(sys) })
    assert.equal(r.status, 0, r.stderr)
    assert.equal(field(r.stdout, 'home'), path.join(w.home, '.local', 'share', 'sonata-align'))
    assert.equal(field(r.stdout, 'python'), sys)
    assert.equal(field(r.stdout, 'venv'), 'missing')
    // a normal XDG_DATA_HOME is used
    const r2 = w.run(INSTALL, ['--dry-run'], { XDG_DATA_HOME: path.join(w.root, 'data'), PATH: path.dirname(sys) })
    assert.equal(field(r2.stdout, 'home'), path.join(w.root, 'data', 'sonata-align'))
  } finally { w.done() }
})

test('install: never a Python inside a snap, even first on PATH or the preferred version', () => {
  const w = world()
  try {
    const snapBin = path.join(w.home, 'snap', 'codium', '495', '.local', 'share', 'uv', 'python', 'cpython-3.12', 'bin')
    w.fake(snapBin, 'python3.12')
    const sys = w.fake(path.join(w.root, 'usr', 'bin'), 'python3.13')
    w.fake(path.join(w.root, 'usr', 'bin'), 'python3.14')
    const r = w.run(INSTALL, ['--dry-run'], { PATH: snapBin + ':' + path.dirname(sys) })
    assert.equal(field(r.stdout, 'python'), sys)
    // a link from a normal dir into the snap counts where it leads
    const linkDir = path.join(w.root, 'links')
    fs.mkdirSync(linkDir)
    fs.symlinkSync(path.join(snapBin, 'python3.12'), path.join(linkDir, 'python3.12'))
    const r2 = w.run(INSTALL, ['--dry-run'], { PATH: linkDir + ':' + path.dirname(sys) })
    assert.equal(field(r2.stdout, 'python'), sys)
    // only unsupported or sandboxed ones: none, and a real install says how to get one
    const only = w.fake(path.join(w.root, 'only'), 'python3.14', false)
    const r3 = w.run(INSTALL, ['--dry-run'], { PATH: path.dirname(only) + ':' + snapBin })
    assert.equal(field(r3.stdout, 'python'), 'none')
    const r4 = w.run(INSTALL, [], { PATH: path.dirname(only) + ':' + snapBin })
    assert.notEqual(r4.status, 0)
    assert.match(r4.stderr, /no system Python 3\.10-3\.13 found/)
    assert.equal(fs.existsSync(path.join(w.home, '.local', 'share', 'sonata-align')), false, 'nothing made')
    // SONATA_ALIGN_PYTHON inside a snap is refused
    const r5 = w.run(INSTALL, ['--dry-run'], { PATH: path.dirname(sys), SONATA_ALIGN_PYTHON: path.join(snapBin, 'python3.12') })
    assert.equal(field(r5.stdout, 'python'), 'none')
    assert.match(r5.stderr, /not usable/)
  } finally { w.done() }
})

test('install: a venv linked into a snap is "sandboxed", a dangling one "broken"; both need --rebuild', () => {
  const w = world()
  try {
    const sys = w.fake(path.join(w.root, 'usr', 'bin'), 'python3.13')
    const venvBin = path.join(w.home, '.local', 'share', 'sonata-align', 'venv', 'bin')
    fs.mkdirSync(venvBin, { recursive: true })
    const snapPy = w.fake(path.join(w.home, 'snap', 'codium', '495', 'py', 'bin'), 'python3.12')
    fs.symlinkSync(snapPy, path.join(venvBin, 'python'))
    let r = w.run(INSTALL, ['--dry-run'], { PATH: path.dirname(sys) })
    assert.equal(field(r.stdout, 'venv'), 'sandboxed')
    r = w.run(INSTALL, [], { PATH: path.dirname(sys) })
    assert.notEqual(r.status, 0)
    assert.match(r.stderr, /is sandboxed.*\n.*--rebuild/)
    assert.equal(fs.readlinkSync(path.join(venvBin, 'python')), snapPy, 'left as it was')
    fs.rmSync(snapPy)
    r = w.run(INSTALL, ['--dry-run'], { PATH: path.dirname(sys) })
    assert.equal(field(r.stdout, 'venv'), 'broken')
  } finally { w.done() }
})

test('launcher: same home rule (--print-home); a dangling venv python says rebuild, as JSON', () => {
  const w = world()
  try {
    const snapXdg = path.join(w.home, 'snap', 'codium', '495', '.local', 'share')
    let r = w.run(LAUNCH, ['--print-home'], { XDG_DATA_HOME: snapXdg })
    assert.equal(r.stdout.trim(), path.join(w.home, '.local', 'share', 'sonata-align'))
    r = w.run(LAUNCH, ['--print-home'], { SONATA_ALIGN_HOME: '/x/sa', XDG_DATA_HOME: snapXdg })
    assert.equal(r.stdout.trim(), '/x/sa')
    const venvBin = path.join(w.home, '.local', 'share', 'sonata-align', 'venv', 'bin')
    fs.mkdirSync(venvBin, { recursive: true })
    fs.symlinkSync(path.join(w.home, 'snap', 'gone', 'python3.12'), path.join(venvBin, 'python'))
    r = w.run(LAUNCH, [], {})
    assert.equal(r.status, 1)
    const msg = JSON.parse(r.stdout)
    assert.equal(msg.type, 'error')
    assert.match(msg.message, /python is gone .*install\.sh --rebuild/)
  } finally { w.done() }
})
