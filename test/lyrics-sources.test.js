const test = require('node:test')
const assert = require('node:assert/strict')
const L = require('../lyrics-sources')

const res = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body })

test('parseLrc: timestamps, multi-stamp lines, metadata dropped, empty stamp ends the line before, sorted', () => {
  const lines = L.parseLrc('[ar:Someone]\n[00:12.50] Hello\n[00:05.00][01:00.00] Chorus\n[00:20.00]\nno stamp')
  assert.deepEqual(lines, [
    { t: 5, text: 'Chorus' },
    { t: 12.5, text: 'Hello', end: 20 },
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

test('resolver: LRCLIB errors are logged, not thrown, and reported as busy (not "no lyrics")', async () => {
  const { getLyrics, calls } = resolver({ lrclibError: 'lrclib HTTP 429' })
  assert.deepEqual(await getLyrics(song), { lines: [], source: '', error: 'busy' })
  assert.match(calls.logs[0], /429/)
})

// --- word timing, duets, background vocals ---

const SYLLABLE_TTML = `<tt xmlns="http://www.w3.org/ns/ttml" xmlns:ttm="http://www.w3.org/ns/ttml#metadata" itunes:timing="Word">
<head><metadata><ttm:agent type="person" xml:id="v1"/><ttm:agent type="person" xml:id="v2"/><ttm:agent type="group" xml:id="v3"/></metadata></head>
<body><div begin="1.000" end="9.000">
<p begin="1.000" end="3.000" ttm:agent="v1" itunes:key="L1"><span begin="1.000" end="1.400">Beau</span><span begin="1.400" end="1.900">ti</span><span begin="1.900" end="2.200">ful</span> <span begin="2.200" end="3.000">day</span><span ttm:role="x-bg"><span begin="2.500" end="2.900">(oh</span> <span begin="2.900" end="3.400">yeah)</span></span></p>
<p begin="00:03.500" end="00:05.000" ttm:agent="v2"><span begin="3.5" end="4.0">Rock &amp;</span> <span begin="4.0" end="5.0">roll</span></p>
<p begin="5.5" end="7" ttm:agent="v3"><span begin="5.5" end="7">Together</span></p>
<p begin="7.5" end="8.5" ttm:agent="v1000"><span begin="7.5" end="8.5">All</span></p>
</div></body></tt>`

test('parseTtml: words merge syllables, keep end, agent and background vocals', () => {
  const lines = L.parseTtml(SYLLABLE_TTML)
  assert.equal(lines.length, 4)
  assert.deepEqual(lines[0], {
    t: 1, end: 3, text: 'Beautiful day', agent: 'v1',
    words: [{ t: 1, end: 2.2, text: 'Beautiful' }, { t: 2.2, end: 3, text: 'day' }],
    bg: [{ t: 2.5, end: 2.9, text: '(oh' }, { t: 2.9, end: 3.4, text: 'yeah)' }]
  })
  assert.equal(lines[1].text, 'Rock & roll')
  assert.equal(lines[1].agent, 'v2')
  assert.equal(lines[1].t, 3.5)
  assert.equal(lines[2].agent, 'group')   // type="group"
  assert.equal(lines[3].agent, 'group')   // v1000
})

test('parseTtml: line-only lyrics keep { t, end, text }; bg-only lines kept; no begin skipped', () => {
  const ttml = '<p begin="1" end="2.5" ttm:agent="v1">Just a line</p><p>no time</p>' +
    '<p begin="3" end="4"><span ttm:role="x-bg"><span begin="3" end="4">(ooh)</span></span></p>'
  assert.deepEqual(L.parseTtml(ttml), [
    { t: 1, end: 2.5, text: 'Just a line', agent: 'v1' },
    { t: 3, end: 4, text: '', bg: [{ t: 3, end: 4, text: '(ooh)' }] }
  ])
})

test('parseTtml: a document with no whitespace between spans treats each span as a word', () => {
  const ttml = '<p begin="1" end="2"><span begin="1" end="1.5">one</span><span begin="1.5" end="2">two</span></p>'
  assert.deepEqual(L.parseTtml(ttml)[0].words.map((w) => w.text), ['one', 'two'])
  assert.equal(L.parseTtml(ttml)[0].text, 'one two')
})

test('parseTtml: whitespace inside a span also separates words; missing word end uses the next word', () => {
  const ttml = '<p begin="1"><span begin="1">Hi </span><span begin="1.5" end="2">there</span></p>'
  const [line] = L.parseTtml(ttml)
  assert.deepEqual(line.words, [{ t: 1, end: 1.5, text: 'Hi' }, { t: 1.5, end: 2, text: 'there' }])
  assert.equal(line.end, 2)
})

test('parseLrc: enhanced word stamps; trailing stamp ends the last word', () => {
  const [line] = L.parseLrc('[00:12.00]<00:12.00>Hello <00:12.50>big world <00:13.10>')
  assert.deepEqual(line, {
    t: 12, end: 13.1, text: 'Hello big world',
    words: [{ t: 12, end: 12.5, text: 'Hello' }, { t: 12.5, end: 13.1, text: 'big world' }]
  })
})

test('parseLrc: enhanced words without a trailing stamp end within 1 s or at the next line', () => {
  const lines = L.parseLrc('[00:01.00]<00:01.00>a <00:01.20>b\n[00:01.70]<00:01.70>c')
  assert.equal(lines[0].words[1].end, 1.7)
  assert.equal(lines[1].words[0].end, 2.7)
})

test('parseLrc: repeated enhanced line shifts its word stamps', () => {
  const lines = L.parseLrc('[00:10.00][00:30.00]<00:10.00>la <00:10.50>la <00:11.00>')
  assert.deepEqual(lines[1].words, [{ t: 30, end: 30.5, text: 'la' }, { t: 30.5, end: 31, text: 'la' }])
})

test('lrclibLines: plain lyrics still t null, synced keep old shape', () => {
  assert.deepEqual(L.lrclibLines({ syncedLyrics: '[00:01.00] a\n[00:02.00] b' }), [{ t: 1, text: 'a' }, { t: 2, text: 'b' }])
})

test('resolver: a busy result is not cached, so a retry asks again', async () => {
  let n = 0
  const getLyrics = L.createLyricsResolver({
    fetchApple: async () => '',
    fetchLrclib: async () => { n++; if (n === 1) throw new Error('lrclib HTTP 503'); return [{ t: 1, text: 'back' }] },
    lrclibEnabled: () => true
  })
  assert.equal((await getLyrics(song)).error, 'busy')
  assert.deepEqual(await getLyrics(song), { lines: [{ t: 1, text: 'back' }], source: 'lrclib' })
})

function memStore() { const m = new Map(); return { m, get: (k) => m.get(k) || null, set: (k, v) => m.set(k, v) } }

test('resolver + store: good results are stored, and served from the store next time without lookups', async () => {
  const store = memStore()
  let apple = 0
  const mk = () => L.createLyricsResolver({ fetchApple: async () => { apple++; return '<p begin="1">x</p>' }, fetchLrclib: async () => [], lrclibEnabled: () => true, store })
  await mk()(song)
  assert.equal(apple, 1)
  assert.deepEqual(store.m.get('T|A'), { lines: [{ t: 1, text: 'x' }], source: 'apple' })
  assert.deepEqual(await mk()(song), { lines: [{ t: 1, text: 'x' }], source: 'apple' })
  assert.equal(apple, 1)
})

test('resolver + store: busy and empty results are not stored; stored LRCLIB lyrics are skipped when LRCLIB is off', async () => {
  const store = memStore()
  const busy = L.createLyricsResolver({ fetchApple: async () => '', fetchLrclib: async () => { throw new Error('503') }, lrclibEnabled: () => true, store })
  await busy(song)
  assert.equal(store.m.size, 0)
  store.m.set('T|A', { lines: [{ t: 1, text: 'l' }], source: 'lrclib' })
  const off = L.createLyricsResolver({ fetchApple: async () => '', fetchLrclib: async () => [], lrclibEnabled: () => false, store })
  assert.deepEqual(await off(song), { lines: [], source: '' })
})
