// model-fetch.js: the helper's model files, fetched so a quit, a crash or a lost connection never costs
// the bytes already downloaded. Against a loopback server that answers Range / If-Range like the real
// hosts (download.pytorch.org, dl.fbaipublicfiles.com, Hugging Face's CDN: 206 with Content-Range, an ETag).
const test = require('node:test')
const assert = require('node:assert/strict')
const crypto = require('crypto')
const fs = require('fs')
const os = require('os')
const path = require('path')
const http = require('http')
const F = require('../model-fetch')

const DATA = crypto.randomBytes(5 * 1024 * 1024 + 123)
const SHA = crypto.createHash('sha256').update(DATA).digest('hex')

// opts: stallAfter (the first answer stops after that many bytes and closes), etag, ignoreRange
function serve(opts = {}) {
  const log = []
  let cut = false
  const server = http.createServer((req, res) => {
    const m = /^bytes=(\d+)-$/.exec(req.headers.range || '')
    const etag = opts.etag || '"v1"'
    const ranged = m && !opts.ignoreRange && (!req.headers['if-range'] || req.headers['if-range'] === etag)
    const from = ranged ? +m[1] : 0
    const body = DATA.subarray(from)
    const e = { range: req.headers.range || '', ifRange: req.headers['if-range'] || '', status: ranged ? 206 : 200, sent: 0 }
    log.push(e)
    res.writeHead(e.status, Object.assign({ 'Content-Length': body.length, ETag: etag }, ranged ? { 'Content-Range': 'bytes ' + from + '-' + (DATA.length - 1) + '/' + DATA.length } : {}))
    if (opts.hangAfter && !cut) { cut = true; res.write(body.subarray(0, opts.hangAfter)); e.sent = opts.hangAfter; return }
    if (opts.stallAfter && !cut) {
      cut = true
      res.write(body.subarray(0, opts.stallAfter), () => { e.sent = opts.stallAfter; res.destroy() })
      return
    }
    e.sent = body.length
    res.end(body)
  })
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({
    url: 'http://127.0.0.1:' + server.address().port + '/model.pt', log,
    close: () => new Promise((r) => { server.closeAllConnections(); server.close(r) })
  })))
}
function dir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'model-fetch-')) }
const item = (d, url, extra) => Object.assign({ name: 'en', url, dest: path.join(d, 'models', 'w2v2.pth'), bytes: DATA.length, sha256: SHA }, extra)

test('model fetch: a download cut midway continues with Range from where it stopped, then is checked and put in place', async () => {
  const s = await serve({ stallAfter: 3 * 1024 * 1024 })
  const d = dir()
  try {
    const it = item(d, s.url)
    await assert.rejects(F.fetchModel(it), (e) => e.code === 'download')
    const part = F.partOf(it.dest)
    const kept = fs.statSync(part).size
    assert.ok(kept >= 2 * 1024 * 1024)                              // the part stays (a dot file: the folder has no models yet)
    assert.equal(path.basename(part)[0], '.')
    assert.equal(fs.existsSync(it.dest), false)
    const r = await F.fetchModel(it)
    assert.equal(s.log.length, 2)
    const from = r.resumedFrom
    assert.equal(s.log[1].range, 'bytes=' + from + '-')
    assert.equal(s.log[1].ifRange, '"v1"')                         // the same file, or the whole of it again
    assert.equal(from, kept - 1024 * 1024)                          // continued 1 MB before its end (a power cut's torn tail)
    assert.equal(r.fetched, DATA.length - from)                     // only the rest came again
    assert.equal(s.log[1].sent, DATA.length - from)
    assert.equal(r.checked, true)
    assert.ok(fs.readFileSync(it.dest).equals(DATA))
    assert.equal(fs.existsSync(part), false)
    assert.equal(fs.existsSync(F.metaOf(it.dest)), false)
    // a whole file is never fetched again
    const again = await F.fetchModel(it)
    assert.equal(again.skipped, true)
    assert.equal(s.log.length, 2)
  } finally { await s.close(); fs.rmSync(d, { recursive: true, force: true }) }
})

test('model fetch: the file changed on the server (If-Range): it comes whole from the start, not stitched', async () => {
  const s1 = await serve({ stallAfter: 2 * 1024 * 1024, etag: '"old"' })
  const d = dir()
  try {
    const it = item(d, s1.url)
    await assert.rejects(F.fetchModel(it))
    await s1.close()
    const s2 = await serve({ etag: '"new"' })
    try {
      // the same address on the new server's port: the part's meta names the old one, so point it there
      const it2 = Object.assign({}, it, { url: s2.url })
      fs.writeFileSync(F.metaOf(it.dest), JSON.stringify({ url: s2.url, etag: '"old"' }))
      const r = await F.fetchModel(it2)
      assert.equal(s2.log[0].status, 200)
      assert.equal(r.resumedFrom, 0)
      assert.ok(fs.readFileSync(it.dest).equals(DATA))
    } finally { await s2.close() }
  } finally { fs.rmSync(d, { recursive: true, force: true }) }
})

test('model fetch: a wrong SHA-256 deletes the download and says so (code verify)', async () => {
  const s = await serve()
  const d = dir()
  try {
    const it = item(d, s.url, { sha256: 'a'.repeat(64) })
    await assert.rejects(F.fetchModel(it), (e) => e.code === 'verify')
    assert.equal(fs.existsSync(it.dest), false)
    assert.equal(fs.existsSync(F.partOf(it.dest)), false)
  } finally { await s.close(); fs.rmSync(d, { recursive: true, force: true }) }
})

test('model fetch: the helper\'s own cut-short download (<file>.part) is taken over when a SHA-256 can check it', async () => {
  const s = await serve()
  const d = dir()
  try {
    const it = item(d, s.url)
    fs.mkdirSync(path.dirname(it.dest), { recursive: true })
    fs.writeFileSync(it.dest + '.part', DATA.subarray(0, 4 * 1024 * 1024))
    const r = await F.fetchModel(it)
    assert.ok(r.resumedFrom >= 3 * 1024 * 1024)
    assert.equal(s.log[0].ifRange, '')                               // no ETag known for it: the checksum decides
    assert.ok(fs.readFileSync(it.dest).equals(DATA))
    assert.equal(fs.existsSync(it.dest + '.part'), false)
  } finally { await s.close(); fs.rmSync(d, { recursive: true, force: true }) }
})

test('model fetch: cancelled midway: rejects cancelled, the part stays for the next try', async () => {
  const s = await serve({ hangAfter: 1024 * 1024 })
  const d = dir()
  try {
    const it = item(d, s.url)
    const listeners = []
    let aborted = false
    const p = F.fetchModel(it, { signal: { get aborted() { return aborted }, onAbort: (f) => listeners.push(f) } })
    const part = F.partOf(it.dest)
    // lifetime: OK — cleared once the part has data
    await new Promise((r) => { const t = setInterval(() => { if (fs.existsSync(part) && fs.statSync(part).size > 0) { clearInterval(t); r() } }, 5) })
    aborted = true
    listeners.forEach((f) => f())
    await assert.rejects(p, (e) => e.code === 'cancelled')
    assert.equal(fs.existsSync(it.dest), false)
    assert.ok(fs.statSync(part).size > 0)
  } finally { await s.close(); fs.rmSync(d, { recursive: true, force: true }) }
})

test('model fetch: only https (http to a loopback address for tests); the engine\'s list is checked', async () => {
  await assert.rejects(F.get('http://example.com/x', {}, 0), /not https/)
  const d = dir()
  try {
    const fake = (out) => (cmd, args, o, cb) => cb(null, JSON.stringify(out))
    const home = path.join(d, 'home')
    const plan = await F.enginePlan({ python: 'py', engine: 'e', home, names: ['htdemucs', 'en', 'kim'], exec: fake({ dir: path.join(home, 'models'), models: {
      htdemucs: { url: 'https://x/h.th', file: 'htdemucs-955717e8.th', bytes: 10, sha256: '' },
      en: { url: 'http://x/e.pth', file: 'e.pth', bytes: 10 },                      // not https: left to the helper
      kim: { url: 'https://x/k', file: '../k', bytes: 10 } } }) })                  // a path in the name: refused
    assert.deepEqual(plan.map((p) => p.name), ['htdemucs'])
    assert.equal(plan[0].sha256, F.KNOWN_SHA256['htdemucs-955717e8.th'])           // the known checksum fills in
    await assert.rejects(F.enginePlan({ python: 'py', engine: 'e', home, names: ['en'], exec: fake({ dir: '/elsewhere', models: {} }) }), /outside its home/)
    assert.deepEqual(F.installNames('cpu'), ['htdemucs', 'en'])
    assert.deepEqual(F.installNames('cuda'), ['htdemucs', 'en', 'kim'])
  } finally { fs.rmSync(d, { recursive: true, force: true }) }
})
