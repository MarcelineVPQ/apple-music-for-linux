const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')
const P = require('../lyrics-prefetch')
const L = require('../lyrics-sources')
const R = require('../recording-id')

const song = (n, extra = {}) => Object.assign({ title: 'Song ' + n, artist: 'Band', album: 'Other ' + n, duration: 200 + n, isrc: 'USXX1' + String(n).padStart(7, '0'), appleId: String(1000 + n), hasLyrics: true }, extra)
const mapStore = () => { const m = new Map(); return { m, get: (k) => (m.has(k) ? m.get(k) : null), set: (k, v) => m.set(k, v) } }

// a prefetcher over the real resolver with fake services; returns what was asked and logged
function rig(opts = {}) {
  const store = opts.store || mapStore()
  const asked = { apple: [], lrclib: [] }
  const logs = []
  let lrclibOn = opts.lrclibOn !== false
  let clock = 0
  const getLyrics = L.createLyricsResolver({
    fetchApple: async (s) => { asked.apple.push(s.title); return opts.apple ? opts.apple(s) : '' },
    fetchLrclib: async (s) => { asked.lrclib.push(s.title); if (opts.lrclib) return opts.lrclib(s); return [{ t: 1, text: 'la ' + s.title }] },
    lrclibEnabled: () => lrclibOn, store, log: () => {}, sleep: async () => {}
  })
  const pf = P.createPrefetcher({
    readQueue: async () => opts.queue,
    getLyrics: (it) => getLyrics(Object.assign({}, it, { prefetch: true })),
    isCached: (it) => P.isStored(store, it, lrclibOn),
    online: () => opts.online !== false, paused: () => !!opts.paused,
    log: (m) => logs.push(m), sleep: async (ms) => { clock += ms }, now: () => clock
  })
  return { pf, store, asked, logs, getLyrics, setLrclib: (v) => { lrclibOn = v }, tick: (ms) => { clock += ms } }
}

test('plan: the next 3 in queue order; the rest of the playing album, up to 12', () => {
  const q = [1, 2, 3, 4, 5].map((n) => song(n))
  assert.deepEqual(P.plan(song(0), q, () => false).map((s) => s.title), ['Song 1', 'Song 2', 'Song 3'])
  const album = Array.from({ length: 15 }, (_, i) => song(i + 1, { album: 'LP' }))
  assert.equal(P.plan(song(0, { album: 'LP' }), album, () => false).length, P.PREFETCH_ALBUM_MAX)
  assert.deepEqual(P.plan(song(0, { album: 'LP' }), [song(1, { album: 'LP' }), ...q], () => false).length, 3)
})

test('prefetch: looks up in queue order, stores under the keys a play reads, logs one line each', async () => {
  const r = rig({ queue: [1, 2, 3, 4].map((n) => song(n)) })
  await r.pf.run(song(0))
  assert.deepEqual(r.asked.lrclib, ['Song 1', 'Song 2', 'Song 3'])
  assert.deepEqual(r.logs, ['lyrics: prefetched "Song 1" (lrclib)', 'lyrics: prefetched "Song 2" (lrclib)', 'lyrics: prefetched "Song 3" (lrclib)'])
  // a play of Song 1 (the now-playing state has no prefetch fields) finds it on disk: nothing asked
  const before = r.asked.lrclib.length
  const fresh = rig({ store: r.store, queue: [] })
  const got = await fresh.getLyrics({ title: 'Song 1', artist: 'Band', album: 'Other 1', duration: 201, isrc: song(1).isrc })
  assert.equal(got.lines[0].text, 'la Song 1')
  assert.equal(fresh.asked.lrclib.length + fresh.asked.apple.length, 0)
  assert.equal(r.asked.lrclib.length, before)
  assert.ok(R.lookup(r.store, '', R.songOf(song(1)), { write: false }).entry)
})

test('prefetch: Apple first, by catalog id, and Apple saying none skips nothing else', async () => {
  const ttml = '<tt xml:lang="en"><body><div><p begin="1.0" end="2.0">Hi</p></div></body></tt>'
  const r = rig({ queue: [song(1), song(2)], apple: (s) => (s.appleId === '1001' ? ttml : '') })
  await r.pf.run(song(0))
  assert.deepEqual(r.asked.apple, ['Song 1', 'Song 2'])
  assert.deepEqual(r.asked.lrclib, ['Song 2'])
  assert.equal(r.logs[0], 'lyrics: prefetched "Song 1" (apple)')
})

test('prefetch: songs already cached are skipped', async () => {
  const r = rig({ queue: [song(1), song(2)] })
  await r.pf.run(song(0))
  const r2 = rig({ store: r.store, queue: [song(1), song(2), song(3)] })
  await r2.pf.run(song(0))
  assert.deepEqual(r2.asked.lrclib, ['Song 3'])
})

test('prefetch: LRCLIB failing stops the run and pauses (backoff), then resumes', async () => {
  let fail = true
  const r = rig({ queue: [1, 2, 3].map((n) => song(n)), lrclib: (s) => { if (fail) throw Object.assign(new Error('lrclib HTTP 503'), { status: 503 }); return [{ t: 1, text: s.title }] } })
  await r.pf.run(song(0))
  assert.deepEqual(r.asked.lrclib, ['Song 1'])
  assert.match(r.logs[0], /prefetch paused, LRCLIB failing/)
  assert.ok(r.pf.pausedUntil >= P.PREFETCH_PAUSE_MIN_MS)
  fail = false
  await r.pf.run(song(9))   // still paused: nothing asked
  assert.deepEqual(r.asked.lrclib, ['Song 1'])
  r.tick(P.PREFETCH_PAUSE_MIN_MS * 10)
  await r.pf.run(song(9))
  assert.deepEqual(r.asked.lrclib, ['Song 1', 'Song 1', 'Song 2', 'Song 3'])
})

test('prefetch: LRCLIB lyrics off: only Apple is asked', async () => {
  const r = rig({ queue: [song(1), song(2)], lrclibOn: false })
  await r.pf.run(song(0))
  assert.deepEqual(r.asked.lrclib, [])
  assert.deepEqual(r.asked.apple, ['Song 1', 'Song 2'])
  assert.deepEqual(r.logs, ['lyrics: prefetched "Song 1" (none)', 'lyrics: prefetched "Song 2" (none)'])
})

test('prefetch: nothing offline or while the gaming guard pauses', async () => {
  for (const o of [{ online: false }, { paused: true }]) {
    const r = rig(Object.assign({ queue: [song(1)] }, o))
    await r.pf.run(song(0))
    assert.deepEqual(r.asked, { apple: [], lrclib: [] })
  }
})

test('prefetch: lyrics text only, never helper, audio or alignment work', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'lyrics-prefetch.js'), 'utf8')
  assert.doesNotMatch(src, /require\(['"]\.\/(align|audio|listen|vocal|timing|lookahead)/)
  const pkg = require('../package.json')
  assert.ok(pkg.build.files.includes('lyrics-prefetch.js'))
})
