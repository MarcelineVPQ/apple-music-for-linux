// safe-fetch.js: a server header that isn't Latin-1 (Wikimedia's `xkey: File:<name>` in UTF-8, the
// 2026-10-19 error window with Nirvana's MTV Unplugged in the Montage) never throws, against a loopback
// server and against a fake request that hands the header over the way Chromium does (a decoded string).
const test = require('node:test')
const assert = require('node:assert/strict')
const http = require('node:http')
const { EventEmitter } = require('node:events')
const S = require('../safe-fetch')
const montage = require('../montage-sources')

const HEBREW = 'File:היר_ווי_אר_נאו_אנטרטיינ_אס.jpg'   // index 5 is U+05D4 (1492), as in the report

function server(handler) {
  return new Promise((resolve) => {
    const srv = http.createServer(handler)
    srv.listen(0, '127.0.0.1', () => resolve({ srv, base: 'http://127.0.0.1:' + srv.address().port }))
  })
}
const nodeFetch = S.createSafeFetch({ open: (url, method) => http.request(url, { method }) })

test('the report\'s header really is what WHATWG Headers refuses', () => {
  assert.throws(() => new Headers().set('xkey', HEBREW), /ByteString/)
})

test('a loopback server sending a UTF-8 (non-Latin-1) header: answered, no throw', async () => {
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.alloc(100, 7)])
  const { srv, base } = await server((req, res) => {
    res.setHeader('Content-Type', 'image/png')
    res.setHeader('xkey', Buffer.from(HEBREW, 'utf8').toString('latin1'))   // raw UTF-8 bytes on the wire
    res.setHeader('X-Asked-UA', String(req.headers['user-agent']))
    res.end(png)
  })
  try {
    const res = await nodeFetch(base + '/thumb.png', { headers: { 'User-Agent': 'Sonata-test' } })
    assert.equal(res.ok, true)
    assert.equal(res.status, 200)
    assert.equal(res.headers.get('Content-Type'), 'image/png')
    assert.equal(res.headers.get('x-asked-ua'), 'Sonata-test')
    assert.ok(res.headers.has('xkey'))
    assert.deepEqual(Buffer.from(await res.arrayBuffer()), png)
    // and through the Montage's own fetcher, as main uses it
    const f = montage.createFetcher({ fetch: nodeFetch, ua: 'Sonata-test', sleep: async () => {} })
    const img = await f.getImage(base + '/thumb.png')
    assert.equal(img.type, 'image/png')
    assert.equal(img.bytes.length, png.length)
  } finally { srv.close() }
})

test('a header as Chromium hands it over (a decoded Hebrew string): kept as is, no throw', async () => {
  const open = () => {
    const req = new EventEmitter()
    req.setHeader = () => {}
    req.write = () => {}
    req.abort = () => {}
    req.end = () => setImmediate(() => {
      const res = new EventEmitter()
      res.statusCode = 200
      res.headers = { 'content-type': 'application/json', xkey: HEBREW, 'set-cookie': ['a=1', 'b=2'] }
      req.emit('response', res)
      res.emit('data', Buffer.from('{"ok":true}'))
      res.emit('end')
    })
    return req
  }
  const res = await S.createSafeFetch({ open })('https://thumb.wikimedia.org/x.jpg')
  assert.equal(res.headers.get('XKEY'), HEBREW)
  assert.equal(res.headers.get('set-cookie'), 'a=1, b=2')
  assert.equal(res.headers.get('missing'), null)
  assert.deepEqual(await res.json(), { ok: true })
})

test('status, JSON and errors behave like fetch', async () => {
  const { srv, base } = await server((req, res) => {
    if (req.url === '/missing') { res.statusCode = 404; res.end('no'); return }
    if (req.url === '/slow') return   // never answers
    res.setHeader('Content-Type', 'application/json')
    res.end(JSON.stringify({ method: req.method }))
  })
  try {
    const miss = await nodeFetch(base + '/missing')
    assert.equal(miss.ok, false)
    assert.equal(miss.status, 404)
    assert.deepEqual(await (await nodeFetch(base + '/j')).json(), { method: 'GET' })
    await assert.rejects(nodeFetch(base + '/slow', { signal: AbortSignal.timeout(100) }), (e) => e.name === 'TimeoutError')
    const ac = new AbortController(); ac.abort()
    await assert.rejects(nodeFetch(base + '/j', { signal: ac.signal }), (e) => e.name === 'AbortError')
  } finally { srv.closeAllConnections(); srv.close() }
  await assert.rejects(nodeFetch('http://127.0.0.1:1/'), /ECONNREFUSED/)
})

test('the guard matches only the known header error', () => {
  let real
  try { new Headers().set('xkey', HEBREW) } catch (e) { real = e }
  assert.equal(S.isBadHeaderError(real), true)
  assert.equal(S.isBadHeaderError(new TypeError('Cannot read properties of undefined')), false)
  assert.equal(S.isBadHeaderError(new Error('Cannot convert argument to a ByteString')), false)   // not a TypeError
  const elsewhere = new TypeError('Cannot convert argument to a ByteString because …')
  elsewhere.stack = 'TypeError: …\n    at someOtherCode (x.js:1:1)'
  assert.equal(S.isBadHeaderError(elsewhere), false)   // the same words from somewhere else: shown
  assert.equal(S.isBadHeaderError(null), false)
})
