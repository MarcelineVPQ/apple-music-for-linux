// sonata-align helper client: paths, environment, line parsing and the process lifetime (spawn on
// demand, one process, idle quit, crash, timeout, stop). Real child processes: a fake helper in
// test/fixtures speaks the same JSON-lines protocol as align/server.py.
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

test('paths: the user install for python, our unpacked scripts for the server', () => {
  const none = () => false
  const p = H.helperPaths({ HOME: '/home/m' }, '/tmp/.mount_abc/resources/app.asar', none)
  assert.equal(p.home, '/home/m/.local/share/sonata-align')
  assert.equal(p.python, '/home/m/.local/share/sonata-align/venv/bin/python')
  assert.equal(p.server, '/tmp/.mount_abc/resources/app.asar.unpacked/align/server.py')
  assert.equal(H.helperPaths({ HOME: '/h', XDG_DATA_HOME: '/d' }, '/src', none).home, '/d/sonata-align')
  // XDG_DATA_HOME pointing elsewhere (a snap launcher): the ~/.local/share install is still found
  assert.equal(H.helperPaths({ HOME: '/h', XDG_DATA_HOME: '/snap/x' }, '/src', (f) => f.startsWith('/h/')).home, '/h/.local/share/sonata-align')
  assert.equal(H.helperPaths({ HOME: '/h', SONATA_ALIGN_HOME: '/x' }, '/src/app', none).server, '/src/app/align/server.py')
  assert.equal(H.helperPaths({ HOME: '/h', SONATA_ALIGN_HOME: '/x' }, '/src', none).python, '/x/venv/bin/python')
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
