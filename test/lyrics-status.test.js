// What the lyrics window says when a song has no lines (Marcy 2026-10-18: "Lyrics service busy, trying
// again…" while Apple had no lyrics and LRCLIB answered HTTP 503): each source's state told apart
// (lyrics-view.js statusText, ≤ 60 characters visible, the rest behind the ⓘ), LRCLIB's failure carried
// with its status (lyrics-sources.js fetchLrclib), and the retries: fast at first, then backing off, jittered,
// capped per song (retryPlan).
const test = require('node:test')
const assert = require('node:assert/strict')
const L = require('../lyrics-sources')
const V = require('../lyrics-view')

const AT = new Date(2026, 9, 18, 14, 3, 12).getTime()
const clock = new Date(AT).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
const data = (status, lookup) => ({ title: 'I Don’t Wanna Be a Soldier', status, lookup: Object.assign({ lrclibOn: true }, lookup) })

test('statusText: Apple has no lyrics, LRCLIB overloaded (503): says both, retrying; ⓘ: source, status, next try', () => {
  const s = V.statusText(data('lrclib', { apple: 'none', lrclib: { status: 503 }, retry: { tries: 2, max: L.LRCLIB_MAX_TRIES, at: AT } }))
  assert.equal(s.text, 'No Apple lyrics; LRCLIB is overloaded, retrying')
  assert.match(s.info, /^Apple Music has no lyrics for this recording\./)
  assert.match(s.info, /LRCLIB \(lrclib\.net\).*answered HTTP 503: busy or overloaded/)
  assert.ok(s.info.includes('Try 2 of ' + L.LRCLIB_MAX_TRIES + ' failed; the next one at ' + clock + '.'))
})

test('statusText: rate-limited, unreachable, Apple failing too, and LRCLIB given up', () => {
  assert.equal(V.statusText(data('lrclib', { apple: 'none', lrclib: { status: 429 } })).text, 'No Apple lyrics; LRCLIB is rate-limited, retrying')
  const off = V.statusText(data('lrclib', { apple: 'none', lrclib: { status: 0 } }))
  assert.equal(off.text, 'No Apple lyrics; LRCLIB is unreachable, retrying')
  assert.match(off.info, /could not be reached/)
  const both = V.statusText(data('lrclib', { apple: 'failed', appleError: 'SERVER_ERROR', lrclib: { status: 503 } }))
  assert.equal(both.text, 'Apple’s lyrics didn’t load; LRCLIB is overloaded, retrying')
  assert.match(both.info, /^Apple Music’s lyrics lookup failed \(SERVER_ERROR\)\./)
  const gave = V.statusText(data('lrclib-failed', { apple: 'none', lrclib: { status: 503 }, retry: { tries: 10, max: 10, at: 0 } }))
  assert.equal(gave.text, 'No Apple lyrics; LRCLIB kept failing, asks again next play')
  assert.match(gave.info, /tried 10 times/)
  assert.equal(V.statusText(data('lrclib-failed', { apple: 'failed', lrclib: { status: 503 } })).text, 'Apple’s and LRCLIB’s lyrics didn’t load; next play retries')
})

test('statusText: Apple failing alone, no lyrics anywhere, LRCLIB off, nothing playing', () => {
  assert.equal(V.statusText(data('apple', { apple: 'failed' })).text, 'Apple Music’s lyrics didn’t load, trying again…')
  assert.equal(V.statusText(data('apple-failed', { apple: 'failed' })).text, 'Apple Music’s lyrics didn’t load; next play asks again')
  assert.equal(V.statusText(data('', { none: 'both' })).text, 'No lyrics on Apple Music or LRCLIB for this song')
  const off = V.statusText(data('', { none: 'apple', lrclibOn: false }))
  assert.equal(off.text, 'No Apple Music lyrics for this song')
  assert.match(off.info, /Settings → Playback & lyrics → LRCLIB lyrics/)
  assert.deepEqual(V.statusText({ title: '' }), { text: 'Play a song to see its lyrics', info: '' })
  assert.deepEqual(V.statusText({ title: 'x' }), { text: 'No lyrics available for this song', info: '' })
})

test('statusText: every visible text is at most 60 characters (the ⓘ rule)', () => {
  const states = []
  for (const apple of ['none', 'failed']) for (const status of [503, 429, 0, 418]) for (const st of ['lrclib', 'lrclib-failed']) states.push(data(st, { apple, lrclib: { status } }))
  states.push(data('apple', {}), data('apple-failed', {}), data('', { none: 'both' }), data('', { none: 'apple', lrclibOn: false }))
  for (const d of states) { const t = V.statusText(d).text; assert.ok(t.length <= 60, t + ' (' + t.length + ')') }
})

test('retryPlan: LRCLIB fast first (1, 2, 4, 8 s), then 30 s and 120 s, jittered ±20 %, capped per song', () => {
  const mid = () => 0.5
  assert.deepEqual([1, 2, 3, 4, 5, 6, 7].map((n) => L.retryPlan('lrclib', n, mid)), [1000, 2000, 4000, 8000, 30000, 120000, 120000])
  assert.equal(L.retryPlan('lrclib', 1, () => 0), 800)
  assert.equal(L.retryPlan('lrclib', 1, () => 0.999999), 1200)
  assert.equal(L.retryPlan('lrclib', L.LRCLIB_MAX_TRIES - 1, mid), 120000)
  assert.equal(L.retryPlan('lrclib', L.LRCLIB_MAX_TRIES, mid), null)   // the cap: no more this play
  let total = 0
  for (let n = 1; n < L.LRCLIB_MAX_TRIES; n++) total += L.retryPlan('lrclib', n, () => 1 - 1e-9)
  assert.ok(total < 15 * 60 * 1000, 'all retries within 15 min at the longest jitter')
  // Apple failing alone: as before (30, 60, 120 s, then given up)
  assert.deepEqual([1, 2, 3, 4].map((n) => L.retryPlan('apple', n, mid)), [30000, 60000, 120000, null])
  assert.equal(L.retryPlan('', 1, mid), null)
})

// --- fetchLrclib: the failure's status ---

function res(status, body) { return { status, ok: status >= 200 && status < 300, json: async () => body } }
const SONG = { title: 'T', artist: 'A', duration: 200 }

test('fetchLrclib: a 503 carries its status; unreachable is status 0', async () => {
  await assert.rejects(L.fetchLrclib(SONG, { fetch: async () => res(503) }), (e) => e.status === 503 && /HTTP 503/.test(e.message))
  await assert.rejects(L.fetchLrclib(SONG, { fetch: async () => { throw new TypeError('fetch failed') } }), (e) => e.status === 0 && /unreachable/.test(e.message))
})

test('fetchLrclib: the exact lookup failing (503) and the search finding nothing is a failure, not "no lyrics"', async () => {
  const fetch = async (url) => (url.includes('get-cached') ? res(503) : res(200, []))
  await assert.rejects(L.fetchLrclib(SONG, { fetch }), (e) => e.status === 503)
  // the search finding the song after a 503 on the exact lookup: found
  const found = async (url) => (url.includes('get-cached') ? res(503) : res(200, [{ trackName: 'T', duration: 200, syncedLyrics: '[00:01.00] hi' }]))
  assert.deepEqual(await L.fetchLrclib(SONG, { fetch: found }), [{ t: 1, text: 'hi' }])
  // both answering "not there" (404, empty search): definitive none
  assert.deepEqual(await L.fetchLrclib(SONG, { fetch: async (url) => (url.includes('get-cached') ? res(404) : res(200, [])) }), [])
})

test('resolver: LRCLIB intermittently overloaded (503, 503, then 200): the found lyrics are kept and stored', async () => {
  let n = 0
  const m = new Map()
  const store = { get: (k) => m.get(k) || null, set: (k, v) => m.set(k, v) }
  const getLyrics = L.createLyricsResolver({
    fetchApple: async () => '',
    fetchLrclib: async () => { if (++n < 3) throw Object.assign(new Error('lrclib HTTP 503'), { status: 503 }); return [{ t: 1, text: 'back' }] },
    lrclibEnabled: () => true,
    store
  })
  assert.equal((await getLyrics(SONG)).lrclib.status, 503)
  assert.equal((await getLyrics(SONG)).error, 'lrclib')
  assert.equal(m.size, 0)                                               // no failure stored
  assert.deepEqual(await getLyrics(SONG), { lines: [{ t: 1, text: 'back' }], source: 'lrclib' })
  assert.deepEqual(m.get('T|A').lines, [{ t: 1, text: 'back' }])
  await getLyrics(SONG)
  assert.equal(n, 3)                                                     // served from the cache after that
})
