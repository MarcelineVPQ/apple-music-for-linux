// sonata-align helper client: paths, environment, line parsing and the process lifetime (spawn on
// demand, one process, idle quit, crash, timeout, stop). Real child processes: a fake helper in
// test/fixtures speaks the same JSON-lines protocol as the engine (protocol 2). No engine code here.
const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('path')
const H = require('../align-helper')
const A = require('../align-session')

const FIXTURE = { home: '/tmp/sonata-align-test-home', python: '/bin/sh', server: path.join(__dirname, 'fixtures', 'fake-align-helper.sh') }
const env = (mode) => Object.assign({}, process.env, { FAKE_NODE: process.execPath, FAKE_MODE: mode || '', LD_LIBRARY_PATH: '/tmp/.mount_x/usr/lib' })

function helper(mode, opts = {}) {
  const logs = []
  const h = H.createAlignHelper(Object.assign({ paths: FIXTURE, env: env(mode), log: (m) => logs.push(m) }, opts))
  return { h, logs }
}

function waitFor(cond, ms = 3000) {
  const t0 = Date.now()
  return new Promise((resolve, reject) => {
    // loop: test poll · 20 ms · until cond or ms
    const iv = setInterval(() => {
      if (cond()) { clearInterval(iv); resolve() } else if (Date.now() - t0 > ms) { clearInterval(iv); reject(new Error('timeout')) }
    }, 20)
  })
}

test('paths: the user install for python, the pinned engine in it for the server', () => {
  const none = () => false
  const pin = { version: '0.2.0', python: '3.14' }
  const p = H.helperPaths({ HOME: '/home/m' }, '/tmp/.mount_abc/resources/app.asar', none, pin)
  assert.equal(p.home, '/home/m/.local/share/sonata-align')
  assert.equal(p.python, '/home/m/.local/share/sonata-align/venv/bin/python')
  assert.equal(p.server, '/home/m/.local/share/sonata-align/engine-0.2.0/main.py')
  assert.equal(p.engineVersion, '0.2.0')
  assert.equal(p.enginePython, '3.14')
  assert.equal(H.helperPaths({ HOME: '/h', XDG_DATA_HOME: '/d' }, '/src', none, pin).home, '/d/sonata-align')
  // XDG_DATA_HOME pointing elsewhere (a snap launcher): the ~/.local/share install is still found
  assert.equal(H.helperPaths({ HOME: '/h', XDG_DATA_HOME: '/snap/x' }, '/src', (f) => f.startsWith('/h/'), pin).home, '/h/.local/share/sonata-align')
  assert.equal(H.helperPaths({ HOME: '/h', SONATA_ALIGN_HOME: '/x' }, '/src/app', none, pin).server, '/x/engine-0.2.0/main.py')
  assert.equal(H.helperPaths({ HOME: '/h', SONATA_ALIGN_HOME: '/x' }, '/src', none, pin).python, '/x/venv/bin/python')
  // no pin: no engine wanted, nothing to start
  assert.equal(H.helperPaths({ HOME: '/h' }, '/src', none, null).server, '')
  assert.equal(H.isInstalled(H.helperPaths({ HOME: '/h' }, '/src', none, null)), false)
  // engine work: SONATA_ENGINE_DIR (an unpacked build's main.py, else a checkout's server.py)
  const dev = H.helperPaths({ HOME: '/h', SONATA_ENGINE_DIR: '/e/align' }, '/src', none, pin)
  assert.equal(dev.server, '/e/align/server.py')
  assert.equal(dev.override, true)
  assert.equal(H.helperPaths({ HOME: '/h', SONATA_ENGINE_DIR: '/e/x' }, '/src', (f) => f === '/e/x/main.py', pin).server, '/e/x/main.py')
})

test('pin: align/engine.json names the engine release Sonata installs', () => {
  const pin = H.enginePin(path.join(__dirname, '..'))
  // a development engine (X.Y.Z-dev.N) only in a Development build: a stable Sonata pins a stable engine
  const devBuild = /-dev\.\d+$/.test(require('../package.json').version)
  assert.match(pin.version, devBuild ? /^\d+\.\d+\.\d+(-dev\.\d+)?$/ : /^\d+\.\d+\.\d+$/)
  assert.ok(H.PROTOCOLS.includes(pin.protocol))
  assert.match(pin.python, /^3\.\d+$/)   // the venv's Python follows the pin (checkInstall)
  assert.equal(pin.file, 'sonata-engine-' + pin.version + '-linux-x86_64.tar.gz')
  assert.equal(pin.url, 'https://github.com/MarcelineVPQ/sonata-releases/releases/download/engine-v' + pin.version + '/' + pin.file)
  assert.match(pin.sha256, /^[0-9a-f]{64}$/)
  assert.ok(Number.isInteger(pin.size) && pin.size > 0)
  assert.equal(Buffer.from(pin.key, 'base64').length, 44)   // Ed25519 SPKI DER
  assert.equal(require('crypto').createPublicKey({ key: Buffer.from(pin.key, 'base64'), format: 'der', type: 'spki' }).asymmetricKeyType, 'ed25519')
})

test('protocol: 2 and 1 (no field) are spoken; another one is refused with code "protocol"', async () => {
  assert.equal(H.checkProtocol({ type: 'pong', protocol: 2 }).protocol, 2)
  assert.equal(H.checkProtocol({ type: 'pong' }).type, 'pong')
  assert.throws(() => H.checkProtocol({ type: 'pong', protocol: 3 }), (e) => e.code === 'protocol' && /Update Precise timing/.test(e.message))
  const run = async (proto) => {
    const h = H.createAlignHelper({ paths: FIXTURE, env: Object.assign(env(''), { FAKE_PROTOCOL: proto }), log: () => {} })
    try { return await h.ping() } finally { h.stop() }
  }
  assert.equal((await run('2')).protocol, 2)
  assert.equal((await run('none')).version, '0.2.0')
  await assert.rejects(run('9'), (e) => e.code === 'protocol')
})

test('installed: needs both the venv python and the server script', () => {
  assert.equal(H.isInstalled(FIXTURE), true)
  assert.equal(H.isInstalled(Object.assign({}, FIXTURE, { python: '/nonexistent/python' })), false)
  assert.equal(H.isInstalled(Object.assign({}, FIXTURE, { server: '/nonexistent/server.py' })), false)
})

test('env: AppImage/Electron library and python overrides are dropped', () => {
  const e = H.helperEnv({ HOME: '/h', LD_LIBRARY_PATH: '/a', PYTHONPATH: '/b', PYTHONHOME: '/c', LD_PRELOAD: 'x.so', PATH: '/usr/bin' }, '/h/sa')
  assert.equal(e.LD_LIBRARY_PATH, undefined)
  assert.equal(e.PYTHONPATH, undefined)
  assert.equal(e.PYTHONHOME, undefined)
  assert.equal(e.LD_PRELOAD, undefined)
  assert.equal(e.PATH, '/usr/bin')
  assert.equal(e.SONATA_ALIGN_HOME, '/h/sa')
  assert.equal(e.PYTHONDONTWRITEBYTECODE, '1')
})

test('parser: split chunks, several messages per chunk, non-JSON lines reported', () => {
  const got = []
  const bad = []
  const feed = H.lineParser((m) => got.push(m), (l) => bad.push(l))
  feed('{"type":"po')
  feed('ng"}\n{"type":"progress","id":"a"}\nwarning: x\n\n{"type":"res')
  feed('ult","id":"a"}\n')
  assert.deepEqual(got.map((m) => m.type), ['pong', 'progress', 'result'])
  assert.deepEqual(bad, ['warning: x'])
})

test('lifetime: spawned on demand, one process for several requests, env cleaned', async () => {
  const { h } = helper()
  assert.equal(h.running, false)
  const [p1, p2] = await Promise.all([h.ping(), h.ping()])
  assert.equal(p1.type, 'pong')
  assert.equal(p2.type, 'pong')
  assert.equal(p1.env.home, FIXTURE.home)
  assert.equal(p1.env.ld, null)
  assert.equal(h.running, true)
  h.stop()
  await waitFor(() => !h.running)
})

test('align: the session framing streams the PCM, the result comes back by id', async () => {
  const { h } = helper()
  const raw = [{ t: 1, text: 'one two' }, { t: 4, text: 'three' }]
  const pcm = Buffer.alloc(22050 * 4 * 3)    // 3 s, ~3 chunks of 256 KB
  const res = await h.align('a1', A.alignMessages('a1', raw, pcm))
  assert.equal(res.type, 'result')
  assert.equal(res.stats.bytes, pcm.length)
  const e = A.entryFromResult(res, raw, null)
  assert.equal(e.aligned, 2)
  assert.deepEqual(e.lines[0].words.map((w) => w.t), [1, 1.3])
  h.stop()
  await waitFor(() => !h.running)
})

test('lifetime: idle helper is sent quit and exits on its own', async () => {
  const { h, logs } = helper('', { idleMs: 100 })
  await h.ping()
  assert.equal(h.running, true)
  await waitFor(() => !h.running, 2000)
  assert.equal(logs.length, 0)     // a requested quit is not a crash
  // and the next request spawns a fresh one
  const p = await h.ping()
  assert.equal(p.type, 'pong')
  h.stop()
  await waitFor(() => !h.running)
})

test('idle limit (0.15.42): 10 min while a lyric view is open, 2 min without, counted from the last job', () => {
  assert.equal(H.IDLE_MS, 2 * 60 * 1000)
  assert.equal(H.WARM_IDLE_MS, 10 * 60 * 1000)
  assert.equal(H.idleDelay(0, true), 10 * 60 * 1000)
  assert.equal(H.idleDelay(0, false), 2 * 60 * 1000)
  assert.equal(H.idleDelay(60 * 1000, true), 9 * 60 * 1000)
  assert.equal(H.idleDelay(60 * 1000, false), 60 * 1000, 'the view closed after 1 idle minute: 1 more')
  assert.equal(H.idleDelay(3 * 60 * 1000, false), 0, 'closed after 3 idle minutes: quit now')
  assert.equal(H.idleDelay(11 * 60 * 1000, true), 0)
  assert.equal(H.idleDelay(-5, false), 2 * 60 * 1000, 'a clock step back never lengthens it')
})

// a fake clock for the helper's timers: advance(ms) fires what is due, in order
function fakeClock() {
  let t = 0
  let timers = []
  const api = {
    now: () => t,
    setTimeout: (fn, ms) => { const h = { fn, at: t + ms, unref() {} }; timers.push(h); return h },
    clearTimeout: (h) => { timers = timers.filter((x) => x !== h) },
    advance(ms) {
      const end = t + ms
      // loop: test clock · fires the due timers in time order
      for (;;) {
        const due = timers.filter((x) => x.at <= end).sort((a, b) => a.at - b.at)[0]
        if (!due) break
        timers = timers.filter((x) => x !== due)
        t = due.at
        due.fn()
      }
      t = end
    },
    get pending() { return timers.length }
  }
  return api
}

test('lifetime: warm while a lyric view is open, the shorter limit once the last one closes (fake clock)', async () => {
  const clock = fakeClock()
  let views = 1
  const logs = []
  const h = H.createAlignHelper({ paths: FIXTURE, env: env(''), log: (m) => logs.push(m), warm: () => views > 0 },
    { setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout, now: clock.now })
  await h.ping()
  // a view open: still there after 9 idle minutes
  clock.advance(9 * 60 * 1000)
  assert.equal(h.running, true)
  // a job resets the idle time
  await h.ping()
  clock.advance(9 * 60 * 1000)
  assert.equal(h.running, true)
  // the last view closes after 9 idle minutes: past the 2-minute limit, so it quits now
  views = 0
  h.viewsChanged()
  await waitFor(() => !h.running, 3000)
  assert.equal(logs.length, 0, 'a requested quit is not a crash')
  // no view: 2 minutes; a view opening in between lengthens it to 10
  await h.ping()
  clock.advance(60 * 1000)
  views = 1
  h.viewsChanged()
  clock.advance(5 * 60 * 1000)
  assert.equal(h.running, true)
  views = 0
  h.viewsChanged()                      // 6 idle minutes, no view: quits now
  await waitFor(() => !h.running, 3000)
  // the plain 2-minute quit without any view
  await h.ping()
  clock.advance(2 * 60 * 1000 - 1)
  assert.equal(h.running, true)
  clock.advance(1)
  await waitFor(() => !h.running, 3000)
  h.stop()
})

test('lifetime: a warm idle helper still quits at once for the gaming guard and on stop()', async () => {
  const clock = fakeClock()
  const h = H.createAlignHelper({ paths: FIXTURE, env: env(''), log: () => {}, warm: () => true },
    { setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout, now: clock.now })
  await h.ping()
  clock.advance(30 * 1000)
  h.release()                           // a game started
  await waitFor(() => !h.running, 3000)
  await h.ping()
  h.stop()                              // app quit
  await waitFor(() => !h.running, 3000)
  h.viewsChanged()                      // nothing running: nothing to do
  assert.equal(h.running, false)
})

test('error: a crash fails the job with one log line; the next job respawns; 3 crashes turn it off', async () => {
  const { h, logs } = helper('crash')
  for (let i = 0; i < 3; i++) {
    await assert.rejects(h.align('c' + i, A.alignMessages('c' + i, [{ t: 0, text: 'a' }], Buffer.alloc(8))), /helper exited/)
  }
  assert.equal(logs.filter((l) => /helper exited/.test(l)).length, 3)
  await assert.rejects(h.ping(), /crashed 3 times/)
})

test('error: a silent helper times out and is killed', async () => {
  const { h } = helper('hang', { jobTimeoutMs: 200 })
  await assert.rejects(h.align('h1', A.alignMessages('h1', [{ t: 0, text: 'a' }], Buffer.alloc(8))), /timed out/)
  await waitFor(() => !h.running)
})

test('error: non-JSON stdout is logged, not fatal', async () => {
  const { h, logs } = helper('noise')
  const p = await h.ping()
  assert.equal(p.type, 'pong')
  assert.ok(logs.some((l) => /some library banner/.test(l)))
  h.stop()
  await waitFor(() => !h.running)
})

test('error: not installed -> rejected without spawning', async () => {
  const h = H.createAlignHelper({ paths: { home: '/x', python: '/nonexistent/python', server: '/nonexistent/server.py' }, log: () => {} })
  await assert.rejects(h.ping(), /not installed/)
  assert.equal(h.running, false)
})

test('lifetime: stop() during a job fails it and ends the process', async () => {
  const { h } = helper('hang')
  const job = h.align('s1', A.alignMessages('s1', [{ t: 0, text: 'a' }], Buffer.alloc(8)))
  await waitFor(() => h.running)
  h.stop()
  await assert.rejects(job, /helper exited/)
  await waitFor(() => !h.running)
})

// --- the Codium snap venv (0.15.38): never decide the install's place from another app's sandbox ---

test('paths: a sandboxed XDG_DATA_HOME is never the home; an install found only there is "stray"', () => {
  const none = () => false
  const snapXdg = '/h/snap/codium/495/.local/share'
  assert.equal(H.inAppSandbox(snapXdg, '/h'), true)
  assert.equal(H.inAppSandbox('/snap/codium/495/usr/bin/python3', '/h'), true)
  assert.equal(H.inAppSandbox('/h/.var/app/com.vscodium.codium/data', '/h'), true)
  assert.equal(H.inAppSandbox('/tmp/.mount_Sonata/usr', '/h'), true)
  assert.equal(H.inAppSandbox('/h/.local/share', '/h'), false)
  assert.equal(H.inAppSandbox('/h/snapshots', '/h'), false)
  assert.equal(H.inAppSandbox('/usr/bin/python3.13', '/h'), false)
  const p = H.helperPaths({ HOME: '/h', XDG_DATA_HOME: snapXdg }, '/src', none)
  assert.equal(p.home, '/h/.local/share/sonata-align')
  assert.equal(p.stray, null)
  const q = H.helperPaths({ HOME: '/h', XDG_DATA_HOME: snapXdg }, '/src', (f) => f.startsWith(snapXdg))
  assert.equal(q.home, '/h/.local/share/sonata-align')
  assert.equal(q.stray, snapXdg + '/sonata-align')
  assert.equal(H.helperPaths({ HOME: '/h', XDG_DATA_HOME: 'rel/dir' }, '/src', none).home, '/h/.local/share/sonata-align')
})

function fakeFs(files) {
  // files: path -> { link?: target, exec?: bool, text?: string }
  const get = (p) => { if (!files[p]) { const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e } return files[p] }
  const resolve = (p, n = 0) => { const f = get(p); return f.link ? resolve(f.link, n + 1) : p }
  return {
    lstatSync: (p) => get(p),
    readlinkSync: (p) => { const f = get(p); if (!f.link) throw new Error('EINVAL'); return f.link },
    realpathSync: (p) => resolve(p),
    accessSync: (p) => { if (!get(p).exec) throw new Error('EACCES') },
    readFileSync: (p) => { const f = get(p); if (f.text == null) throw new Error('EISDIR'); return f.text }
  }
}

test('install health: ok, missing, broken link, sandboxed python, stray install, engine update', () => {
  const server = '/h/.local/share/sonata-align/engine-0.2.0/main.py'
  const paths = { python: '/h/.local/share/sonata-align/venv/bin/python', server, engineVersion: '0.2.0', enginePython: '3.14', userHome: '/h', stray: null }
  const cfg = '/h/.local/share/sonata-align/venv/pyvenv.cfg'
  const ok = H.checkInstall(paths, fakeFs({ [paths.python]: { link: '/usr/bin/python3.14' }, '/usr/bin/python3.14': { exec: true }, [server]: { exec: true }, [cfg]: { text: 'home = /usr/bin\nversion_info = 3.14.4\n' } }))
  assert.deepEqual(ok, { state: 'ok', python: paths.python, target: '/usr/bin/python3.14', py: '3.14' })
  // a healthy venv without the pinned engine (installed before the engine download, or an older engine)
  const noEngine = H.checkInstall(paths, fakeFs({ [paths.python]: { link: '/usr/bin/python3.13' }, '/usr/bin/python3.13': { exec: true }, [cfg]: { text: 'home = /usr/bin\n' } }))
  assert.deepEqual(noEngine, { state: 'update', python: paths.python, target: '/usr/bin/python3.13', want: '0.2.0', py: '' })
  assert.match(H.repairText(noEngine), /helper update \(engine 0\.2\.0\)\. Press Update below/)
  // the engine is there but the venv is on another Python than its compiled modules (venv's "version")
  const otherPy = H.checkInstall(paths, fakeFs({ [paths.python]: { link: '/usr/bin/python3.13' }, '/usr/bin/python3.13': { exec: true }, [server]: { exec: true }, [cfg]: { text: 'home = /usr/bin\nversion = 3.13.7\n' } }))
  assert.equal(otherPy.state, 'update')
  // a venv from the previous engine (0.2.0 was Python 3.12): an update too, whatever the pin moves to
  const oldPy = H.checkInstall(paths, fakeFs({ [paths.python]: { link: '/usr/bin/python3.12' }, '/usr/bin/python3.12': { exec: true }, [server]: { exec: true }, [cfg]: { text: 'home = /usr/bin\nversion_info = 3.12.13\n' } }))
  assert.equal(oldPy.state, 'update')
  // engine work (SONATA_ENGINE_DIR): no pin to check
  assert.equal(H.checkInstall(Object.assign({}, paths, { override: true }), fakeFs({ [paths.python]: { link: '/usr/bin/python3.13' }, '/usr/bin/python3.13': { exec: true } })).state, 'ok')
  assert.equal(H.repairText(ok), '')
  assert.equal(H.checkInstall(paths, fakeFs({})).state, 'missing')
  const snapPy = '/h/snap/codium/495/.local/share/uv/python/cpython-3.12-linux-x86_64-gnu/bin/python3.12'
  const broken = H.checkInstall(paths, fakeFs({ [paths.python]: { link: snapPy } }))
  assert.equal(broken.state, 'broken')
  assert.equal(broken.target, snapPy)
  assert.match(H.repairText(broken), /Python is gone .*snap\/codium\/495.*Press Repair below.*keeps the downloaded models/)
  const sandboxed = H.checkInstall(paths, fakeFs({ [paths.python]: { link: snapPy }, [snapPy]: { exec: true }, [cfg]: { text: 'home = /h/snap/codium/495/x\n' } }))
  assert.equal(sandboxed.state, 'sandboxed')
  assert.match(H.repairText(sandboxed), /works, but .* another app .*next update breaks it/)
  // pyvenv.cfg alone (a copied interpreter) is enough to tell
  const copied = H.checkInstall(paths, fakeFs({ [paths.python]: { exec: true }, [cfg]: { text: 'home = /snap/codium/495/usr/bin\n' } }))
  assert.equal(copied.state, 'sandboxed')
  const notExec = H.checkInstall(paths, fakeFs({ [paths.python]: { link: '/usr/bin/python3.13' }, '/usr/bin/python3.13': { exec: false } }))
  assert.equal(notExec.state, 'broken')
  const stray = H.checkInstall(Object.assign({}, paths, { stray: '/h/snap/codium/495/.local/share/sonata-align' }), fakeFs({}))
  assert.equal(stray.state, 'stray')
  assert.match(H.repairText(stray), /inside another app's folder/)
})

test('release(): the helper quits right after its current job (gaming guard); idle: at once', async () => {
  const { h, logs } = helper('')
  await h.ping()
  h.release()                                  // no job: quits now
  await waitFor(() => !h.running, 2000)
  const job = h.align('r1', A.alignMessages('r1', [{ t: 0, text: 'a b' }], Buffer.alloc(8)))
  await waitFor(() => h.running)
  h.release()                                  // a job: finishes first
  const res = await job
  assert.equal(res.type, 'result')
  await waitFor(() => !h.running, 2000)
  assert.equal(logs.length, 0)
  // forget() on a stopped helper is a no-op; pid is 0
  h.forget('s1')
  assert.equal(h.pid, 0)
})

test('active engine: <home>/active-engine names it; a protocol this client speaks and at least the pin, else the pinned one', () => {
  const files = {
    '/h/sa/active-engine': '0.3.0-dev.2\n',
    '/h/sa/engine-0.3.0-dev.2/ENGINE.json': JSON.stringify({ version: '0.3.0-dev.2', protocol: 2, python: '3.15' })
  }
  const read = (f) => { if (!(f in files)) throw new Error('ENOENT'); return files[f] }
  const env = { SONATA_ALIGN_HOME: '/h/sa', HOME: '/h' }
  const pin = { version: '0.2.1', python: '3.14' }
  const p = H.helperPaths(env, '/app', () => true, pin, read)
  assert.equal(p.engineVersion, '0.3.0-dev.2')
  assert.equal(p.enginePython, '3.15')
  assert.equal(p.server, '/h/sa/engine-0.3.0-dev.2/main.py')
  assert.equal(p.minVersion, '0.2.1')
  // a protocol it doesn't speak, or older than the pin: the pinned engine
  files['/h/sa/engine-0.3.0-dev.2/ENGINE.json'] = JSON.stringify({ version: '0.3.0-dev.2', protocol: 9, python: '3.15' })
  assert.equal(H.helperPaths(env, '/app', () => true, pin, read).engineVersion, '0.2.1')
  files['/h/sa/active-engine'] = '0.2.0\n'
  files['/h/sa/engine-0.2.0/ENGINE.json'] = JSON.stringify({ version: '0.2.0', protocol: 2 })
  assert.equal(H.helperPaths(env, '/app', () => true, pin, read).engineVersion, '0.2.1')
  // none (an install from before): the pinned one
  delete files['/h/sa/active-engine']
  assert.equal(H.helperPaths(env, '/app', () => true, pin, read).engineVersion, '0.2.1')
  assert.equal(H.olderEngine('0.2.1-dev.3', '0.2.1'), true)
  assert.equal(H.olderEngine('0.2.10', '0.2.9'), false)
})
