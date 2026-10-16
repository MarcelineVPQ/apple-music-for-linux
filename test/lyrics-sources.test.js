const test = require('node:test')
const assert = require('node:assert/strict')
const L = require('../lyrics-sources')

const res = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body })

test('parseLrc: timestamps, multi-stamp lines, blanks and metadata dropped, sorted', () => {
  const lines = L.parseLrc('[ar:Someone]\n[00:12.50] Hello\n[00:05.00][01:00.00] Chorus\n[00:20.00]\nno stamp')
  assert.deepEqual(lines, [
    { t: 5, text: 'Chorus' },
    { t: 12.5, text: 'Hello' },
    { t: 60, text: 'Chorus' }
  ])
})

test('parseTtml: begin clock formats and entities', () => {
  const ttml = '<p begin="1.5">A &amp; B</p><p begin="01:02.000"><span>x</span><span>y</span></p>'
  assert.deepEqual(L.parseTtml(ttml), [{ t: 1.5, text: 'A & B' }, { t: 62, text: 'x y' }])
})

test('lrclibLines: synced preferred, plain gets t null, instrumental empty', () => {
  assert.deepEqual(L.lrclibLines({ syncedLyrics: '[00:01.00] a', plainLyrics: 'a' }), [{ t: 1, text: 'a' }])
  assert.deepEqual(L.lrclibLines({ plainLyrics: 'one\n\n two ' }), [{ t: null, text: 'one' }, { t: null, text: 'two' }])
  assert.deepEqual(L.lrclibLines({ instrumental: true, plainLyrics: 'x' }), [])
  assert.deepEqual(L.lrclibLines(null), [])
})

test('cleanAlbum strips Apple " - EP" / " - Single"', () => {
  assert.equal(L.cleanAlbum('Let It Die - EP'), 'Let It Die')
  assert.equal(L.cleanAlbum('Song - Single'), 'Song')
  assert.equal(L.cleanAlbum('A Night at the Opera'), 'A Night at the Opera')
})

test('pickHit: within 5 s, synced first, unknown durations allowed', () => {
  const hits = [
    { duration: 300, syncedLyrics: '[00:01.00] far' },
    { duration: 184, plainLyrics: 'plain' },
    { duration: 186, syncedLyrics: '[00:01.00] near' }
  ]
  assert.equal(L.pickHit(hits, 184).syncedLyrics, '[00:01.00] near')
  assert.equal(L.pickHit(hits, 0).syncedLyrics, '[00:01.00] far')
  assert.equal(L.pickHit([], 184), null)
  assert.equal(L.pickHit(undefined, 184), null)
})

test('fetchLrclib: exact match used; query carries cleaned album and rounded duration', async () => {
  const urls = []
  const fetch = async (url, opts) => {
    urls.push(url)
    assert.match(opts.headers['User-Agent'], /^Sonata/)
    return res(200, { syncedLyrics: '[00:02.00] hi' })
  }
  const lines = await L.fetchLrclib({ title: 'T', artist: 'A', album: 'Alb - EP', duration: 183.6 }, { fetch, userAgent: 'Sonata/test' })
  assert.deepEqual(lines, [{ t: 2, text: 'hi' }])
  assert.equal(urls.length, 1)
  const q = new URL(urls[0]).searchParams
  assert.equal(q.get('album_name'), 'Alb')
  assert.equal(q.get('duration'), '184')
})

test('fetchLrclib: 404 on exact falls back to search and picks the near hit', async () => {
  const fetch = async (url) => url.includes('/api/get-cached')
    ? res(404, {})
    : res(200, [{ duration: 400, syncedLyrics: '[00:01.00] wrong' }, { duration: 184, plainLyrics: 'right' }])
  const lines = await L.fetchLrclib({ title: 'T', artist: 'A', duration: 184 }, { fetch })
  assert.deepEqual(lines, [{ t: null, text: 'right' }])
})

test('fetchLrclib: no duration means no duration parameter; nothing found -> []', async () => {
  const urls = []
  const fetch = async (url) => { urls.push(url); return url.includes('/api/get-cached') ? res(404, {}) : res(200, []) }
  assert.deepEqual(await L.fetchLrclib({ title: 'T', artist: 'A', duration: 0 }, { fetch }), [])
  assert.equal(new URL(urls[0]).searchParams.has('duration'), false)
})

test('fetchLrclib: exact lookup failing (429) still tries search', async () => {
  const fetch = async (url) => url.includes('/api/get-cached') ? res(429, {}) : res(200, [{ plainLyrics: 'ok' }])
  assert.deepEqual(await L.fetchLrclib({ title: 'T', artist: 'A' }, { fetch }), [{ t: null, text: 'ok' }])
})

test('fetchLrclib: search errors throw (rate limit)', async () => {
  const fetch = async () => res(429, {})
  await assert.rejects(L.fetchLrclib({ title: 'T', artist: 'A' }, { fetch }), /HTTP 429/)
})

function resolver(over) {
  const calls = { apple: 0, lrclib: 0, logs: [] }
  const getLyrics = L.createLyricsResolver({
    fetchApple: async () => { calls.apple++; return over.apple === undefined ? '' : over.apple },
    fetchLrclib: async () => { calls.lrclib++; if (over.lrclibError) throw new Error(over.lrclibError); return over.lrclib || [] },
    lrclibEnabled: () => over.enabled !== false,
    log: (m) => calls.logs.push(m)
  })
  return { getLyrics, calls }
}
const song = { title: 'T', artist: 'A' }

test('resolver: Apple lyrics win; LRCLIB not called', async () => {
  const { getLyrics, calls } = resolver({ apple: '<p begin="1">x</p>', lrclib: [{ t: 1, text: 'other' }] })
  assert.deepEqual(await getLyrics(song), { lines: [{ t: 1, text: 'x' }], source: 'apple' })
  assert.equal(calls.lrclib, 0)
})

test('resolver: Apple empty -> LRCLIB, and the result is cached', async () => {
  const { getLyrics, calls } = resolver({ lrclib: [{ t: 3, text: 'y' }] })
  assert.equal((await getLyrics(song)).source, 'lrclib')
  await getLyrics(song)
  assert.equal(calls.apple, 1)
  assert.equal(calls.lrclib, 1)
})

test('resolver: concurrent callers share one lookup', async () => {
  const { getLyrics, calls } = resolver({ lrclib: [{ t: 3, text: 'y' }] })
  await Promise.all([getLyrics(song), getLyrics(song)])
  assert.equal(calls.lrclib, 1)
})

test('resolver: setting off -> no LRCLIB request', async () => {
  const { getLyrics, calls } = resolver({ enabled: false, lrclib: [{ t: 3, text: 'y' }] })
  assert.deepEqual(await getLyrics(song), { lines: [], source: '' })
  assert.equal(calls.lrclib, 0)
})

test('resolver: Apple throwing still falls back; empty results are retried next time', async () => {
  const getLyrics = L.createLyricsResolver({
    fetchApple: async () => { throw new Error('no session') },
    fetchLrclib: async () => [],
    lrclibEnabled: () => true
  })
  assert.deepEqual(await getLyrics(song), { lines: [], source: '' })
  let lrclibCalls = 0
  const again = L.createLyricsResolver({ fetchApple: async () => '', fetchLrclib: async () => { lrclibCalls++; return [] }, lrclibEnabled: () => true })
  await again(song); await again(song)
  assert.equal(lrclibCalls, 2)
})

test('resolver: LRCLIB errors are logged, not thrown', async () => {
  const { getLyrics, calls } = resolver({ lrclibError: 'lrclib HTTP 429' })
  assert.deepEqual(await getLyrics(song), { lines: [], source: '' })
  assert.match(calls.logs[0], /429/)
})
