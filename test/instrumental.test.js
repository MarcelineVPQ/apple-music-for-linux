// Instrumentals (Marcy 2026-10-18, Mad Season "November Hotel (Live At the Moore)", 13:50: "there are millions
// of instrumental tracks in the world"): "Instrumental" only with evidence (LRCLIB's flag on a hit for this
// recording, or the title's own marker), lyrics from any source win, the verdict is cached (no LRCLIB retry),
// and the lyrics view and the sheet-notes band say "Instrumental" instead of a failure line.
const test = require('node:test')
const assert = require('node:assert/strict')
const L = require('../lyrics-sources')
const V = require('../lyrics-view')
const M = require('../sheet-notes-model')

const res = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body })
const hit = (o) => Object.assign({ trackName: 'November Hotel', artistName: 'Mad Season', albumName: 'Above (Deluxe Edition) Disc 2', duration: 830, instrumental: true, plainLyrics: null, syncedLyrics: null }, o)
const moore = { title: 'November Hotel (Live At the Moore)', artist: 'Mad Season', album: 'Live At the Moore', duration: 830 }
// LRCLIB: get-cached answers 404, search answers `hits`
const lrclib = (hits) => async (url) => (url.includes('/api/search') ? res(200, hits) : res(404, null))

test('fetchLrclib: the instrumental flag on a hit of this recording (title, artist, length) -> instrumental', async () => {
  const lines = await L.fetchLrclib(moore, { fetch: lrclib([hit({ duration: 225 }), hit({ duration: 829.44 })]) })
  assert.equal(lines.length, 0)
  assert.deepEqual(lines.instrumental, { by: 'lrclib', duration: 829.44 })
})

test('fetchLrclib: the flag on the exact match counts even when the search then fails', async () => {
  const fetch = async (url) => (url.includes('/api/search') ? res(503, null) : res(200, hit({ duration: 829 })))
  const lines = await L.fetchLrclib(moore, { fetch })
  assert.deepEqual(lines.instrumental, { by: 'lrclib', duration: 829 })
})

test('instrumentalHit: a flag only on a hit of another length, title or artist is not evidence', () => {
  assert.equal(L.instrumentalHit([hit({ duration: 425 }), hit({ duration: 795 })], moore), null)
  assert.equal(L.instrumentalHit([hit({ trackName: 'November Rain' })], moore), null)
  assert.equal(L.instrumentalHit([hit({ artistName: 'Someone Else' })], moore), null)
  // no length for the playing recording: no telling which recording a hit is
  assert.equal(L.instrumentalHit([hit({})], Object.assign({}, moore, { duration: 0 })), null)
  // a "(Instrumental)" version of a sung song is not this recording
  assert.equal(L.instrumentalHit([hit({ trackName: 'Song (Instrumental)', duration: 200 })], { title: 'Song', artist: 'Mad Season', duration: 200 }), null)
  // featured artist on either side still matches
  assert.ok(L.instrumentalHit([hit({ artistName: 'Mad Season feat. Mark Lanegan' })], moore))
})

test('instrumentalHit: lyrics on any hit of the song veto the flag (lyrics win)', () => {
  const sung = hit({ duration: 425, instrumental: false, plainLyrics: 'a sung line' })
  assert.equal(L.instrumentalHit([hit({}), sung], moore), null)
})

test('fetchLrclib: lyrics on a near hit win over a flagged one', async () => {
  const lines = await L.fetchLrclib(moore, { fetch: lrclib([hit({}), hit({ instrumental: false, duration: 831, albumName: 'Live At the Moore', syncedLyrics: '[00:10.00] sung' })]) })
  assert.equal(lines.length, 1)
  assert.equal(lines.instrumental, undefined)
})

test('instrumentalTitle: the title\'s own marker, not a word inside a name', () => {
  assert.equal(L.instrumentalTitle('Song (Instrumental)'), '(Instrumental)')
  assert.equal(L.instrumentalTitle('Song [Live Instrumental]'), '[Live Instrumental]')
  assert.equal(L.instrumentalTitle('Song - Instrumental Version'), 'Instrumental Version')
  assert.equal(L.instrumentalTitle('Instrumental Mind'), '')
  assert.equal(L.instrumentalTitle('November Hotel (Live At the Moore)'), '')
})

function resolver(over) {
  const calls = { apple: 0, lrclib: 0 }
  const map = new Map()
  const store = { get: (k) => map.get(k) || null, set: (k, v) => map.set(k, v) }
  const deps = {
    fetchApple: async () => { calls.apple++; if (over.appleError) throw new Error('apple down'); return over.ttml || '' },
    fetchLrclib: async () => { calls.lrclib++; if (over.lrclibError) throw Object.assign(new Error('lrclib HTTP 503'), { status: 503 }); return over.lrclib || [] },
    lrclibEnabled: () => over.lrclibOn !== false,
    store, sleep: async () => {}
  }
  return { getLyrics: L.createLyricsResolver(deps), calls, map, deps }
}
const flagged = () => Object.assign([], { instrumental: { by: 'lrclib', duration: 829.44 } })

test('resolver: LRCLIB\'s verdict -> instrumental, cached on disk; the next lookup asks nobody', async () => {
  const r = resolver({ lrclib: flagged() })
  const got = await r.getLyrics(moore)
  assert.deepEqual(got, { lines: [], source: 'lrclib', instrumental: { by: 'lrclib', duration: 829.44 } })
  assert.equal(got.error, undefined)   // no retry (main.js retries only on error)
  // a fresh resolver (the next app start) on the same disk store: instant, Apple and LRCLIB not asked
  const again = L.createLyricsResolver(Object.assign({}, r.deps, { fetchApple: async () => { throw new Error('asked') }, fetchLrclib: async () => { throw new Error('asked') } }))
  assert.deepEqual(await again(moore), { lines: [], source: 'lrclib', instrumental: { by: 'lrclib', duration: 829.44 } })
  // and in memory: the same resolver doesn't ask again either
  await r.getLyrics(moore)
  assert.deepEqual(r.calls, { apple: 1, lrclib: 1 })
})

test('resolver: Apple lyrics win over an instrumental title or flag', async () => {
  const ttml = '<tt><body><div><p begin="1.0" end="2.0">Sung</p></div></body></tt>'
  const r = resolver({ ttml, lrclib: flagged() })
  const got = await r.getLyrics({ title: 'Song (Instrumental)', artist: 'A', duration: 200 })
  assert.equal(got.source, 'apple')
  assert.equal(got.instrumental, undefined)
  assert.equal(r.calls.lrclib, 0)
})

test('resolver: LRCLIB lyrics win over the title marker', async () => {
  const r = resolver({ lrclib: [{ t: 1, text: 'sung' }] })
  const got = await r.getLyrics({ title: 'Song (Instrumental)', artist: 'A', duration: 200 })
  assert.equal(got.lines.length, 1)
  assert.equal(got.instrumental, undefined)
})

test('resolver: the title marker -> instrumental (LRCLIB off, none on LRCLIB, LRCLIB failing: no retry)', async () => {
  const song = { title: 'Song (Instrumental)', artist: 'A', duration: 200 }
  const want = { lines: [], source: '', instrumental: { by: 'title', marker: '(Instrumental)' } }
  assert.deepEqual(await resolver({ lrclibOn: false }).getLyrics(song), want)
  const none = resolver({})
  assert.deepEqual(await none.getLyrics(song), want)
  assert.equal(none.map.size, 1)   // stored
  const failing = resolver({ lrclibError: true })
  const got = await failing.getLyrics(song)
  assert.deepEqual(got, want)      // no error: main.js doesn't retry or say LRCLIB is busy
  assert.equal(failing.map.size, 0)   // LRCLIB unanswered: not stored, the next play asks again
})

test('resolver: no evidence -> the usual "no lyrics", never instrumental', async () => {
  const got = await resolver({}).getLyrics({ title: 'Quiet Song', artist: 'A', duration: 200 })
  assert.deepEqual(got, { lines: [], source: '', none: 'both' })
})

test('resolver: Apple\'s lookup failing: the verdict shows but is not stored (Apple\'s lyrics would win)', async () => {
  const r = resolver({ appleError: true, lrclib: flagged() })
  const got = await r.getLyrics(moore)
  assert.equal(got.instrumental.by, 'lrclib')
  assert.equal(got.appleFailed, true)
  assert.equal(got.apple, 'failed')
  assert.equal(r.map.size, 0)
})

test('statusText: "Instrumental", drawn large (kind), its evidence behind the ⓘ', () => {
  const lr = V.statusText({ title: moore.title, lookup: { instrumental: { by: 'lrclib', duration: 829.44 } } })
  assert.equal(lr.text, 'Instrumental')
  assert.equal(lr.kind, 'instrumental')
  assert.match(lr.info, /^Marked instrumental on LRCLIB \(lrclib\.net\).*\(13:49\)\. Apple Music has no lyrics for it\.$/)
  const tt = V.statusText({ title: 'Song (Instrumental)', lookup: { instrumental: { by: 'title', marker: '(Instrumental)' } } })
  assert.equal(tt.text, 'Instrumental')
  assert.match(tt.info, /^The title marks this recording as instrumental \(“\(Instrumental\)”\)\./)
  const failed = V.statusText({ title: 'x', lookup: { apple: 'failed', instrumental: { by: 'lrclib', duration: 830 } } })
  assert.match(failed.info, /Apple Music’s lyrics didn’t load this time/)
  // every other state keeps its own text and no kind
  assert.equal(V.statusText({ title: 'x', lookup: { none: 'both' } }).kind, undefined)
})

test('sheet-notes band: "Instrumental", not "Sheet notes need lyrics with line timing"', () => {
  const m = M.mode({ on: true, installed: true, precise: true, timed: false, instrumental: 'lrclib' })
  assert.equal(m.band, 'message')
  assert.equal(m.text, 'Instrumental')
  assert.match(m.info, /LRCLIB/)
  assert.match(M.mode({ on: true, installed: false, instrumental: 'title' }).info, /its title says so/)
  assert.equal(M.mode({ on: true, installed: true, precise: true, timed: false }).text, 'Sheet notes need lyrics with line timing')
  assert.equal(M.mode({ on: false, instrumental: 'lrclib' }).band, 'off')
})
