// Last.fm scrobbles waiting to be sent (lastfm.js createScrobbleQueue) and the batch call: stubbed
// network and disk, a fake clock. BACKLOG "Last.fm: a failed scrobble is retried".
const test = require('node:test')
const assert = require('node:assert/strict')
const { LastFm, createScrobbleQueue, SCROBBLE_MAX_AGE_S, QUEUE_MAX, BATCH, BACKOFF_S } = require('../lastfm')

const T0 = 1_800_000_000 * 1000          // ms
function rig(opts) {
  const o = opts || {}
  const r = { clock: T0, sends: [], saved: null, saves: 0, logs: [], fail: o.fail || 0 }
  r.q = createScrobbleQueue({
    send: async (entries) => {
      r.sends.push(entries.map((e) => e.title))
      if (r.fail > 0) { r.fail--; throw new Error('fetch failed') }
      return { accepted: entries.length, ignored: 0 }
    },
    load: () => { if (o.load === undefined) throw new Error('ENOENT'); return o.load },
    save: (list) => { r.saved = list; r.saves++ },
    now: () => r.clock,
    log: (m) => r.logs.push(m)
  })
  return r
}
const track = (title) => ({ title, artist: 'Against Me!', album: 'White Crosses', duration: 200 })
const nowS = (r) => Math.floor(r.clock / 1000)

test('scrobble queue: sent at once; on success it leaves the queue and the file', async () => {
  const r = rig()
  r.q.add(track('Spanish Moss'), nowS(r) - 120)
  await r.q.tick()
  assert.deepEqual(r.sends, [['Spanish Moss']])
  assert.equal(r.q.pending(), 0)
  assert.deepEqual(r.saved, [])
})

test('scrobble queue: a failed send is kept and retried with a backoff, not every 5 s tick', async () => {
  const r = rig({ fail: 2 })
  r.q.add(track('Because of the Shame'), nowS(r) - 120)
  await r.q.tick()                                   // fails: next try in 30 s
  assert.equal(r.q.pending(), 1)
  assert.equal(r.saved.length, 1)                    // on disk while it waits
  r.clock += 5000; await r.q.tick()
  r.clock += 5000; await r.q.tick()
  assert.equal(r.sends.length, 1, 'no resend inside the backoff')
  r.clock = r.q.nextAt(); await r.q.tick()           // fails again: 60 s
  assert.equal(r.q.nextAt() - r.clock, BACKOFF_S[1] * 1000)
  r.clock = r.q.nextAt(); await r.q.tick()           // works
  assert.equal(r.sends.length, 3)
  assert.equal(r.q.pending(), 0)
  assert.ok(r.logs.some((m) => /scrobble failed .*next try in 30 s/.test(m)))
})

test('scrobble queue: the backoff grows to 30 min and stays there', async () => {
  const r = rig({ fail: 99 })
  r.q.add(track('Ache With Me'), nowS(r))
  const waits = []
  // loop: NOT-WORTH — test: 8 failed sends
  for (let i = 0; i < 8; i++) { await r.q.tick(); waits.push((r.q.nextAt() - r.clock) / 1000); r.clock = r.q.nextAt() }
  assert.deepEqual(waits, [30, 60, 120, 300, 600, 1800, 1800, 1800])
})

test('scrobble queue: pending scrobbles survive a restart (load), invalid and duplicate rows dropped', async () => {
  const first = rig({ fail: 99 })
  first.q.add(track('Teenage Anarchist'), nowS(first) - 600)
  await first.q.tick()
  const saved = first.saved.concat([{ title: '', artist: 'x', timestamp: 1 }, 'junk', first.saved[0]])
  const after = rig({ load: saved })
  assert.equal(after.q.pending(), 1)
  assert.equal(after.saves, 1, 'the cleaned list is written back')
  await after.q.tick()
  assert.deepEqual(after.sends, [['Teenage Anarchist']])
  assert.equal(after.q.pending(), 0)
})

test('scrobble queue: older than 14 days (Last.fm refuses them) are dropped, not sent', async () => {
  const r = rig({ load: [
    { artist: 'A', title: 'old', timestamp: Math.floor(T0 / 1000) - SCROBBLE_MAX_AGE_S - 60 },
    { artist: 'A', title: 'recent', timestamp: Math.floor(T0 / 1000) - 3 * 86400 }
  ] })
  assert.equal(r.q.pending(), 1)
  assert.ok(r.logs.some((m) => /older than 14 days dropped/.test(m)))
  // one waiting through a long outage ages out as well
  r.fail = 99
  await r.q.tick()
  r.clock += 12 * 86400 * 1000
  await r.q.tick()
  assert.equal(r.q.pending(), 0)
  assert.equal(r.sends.length, 1)
})

test('scrobble queue: no double scrobbles (same play queued once; one send at a time)', async () => {
  const r = rig()
  const ts = nowS(r) - 100
  assert.equal(r.q.add(track('Bamboo Bones'), ts), true)
  assert.equal(r.q.add(track('Bamboo Bones'), ts), false)
  await Promise.all([r.q.tick(), r.q.tick()])
  assert.deepEqual(r.sends, [['Bamboo Bones']])
  // the same song played again later is a new scrobble
  r.q.add(track('Bamboo Bones'), ts + 400)
  await r.q.tick()
  assert.equal(r.sends.length, 2)
})

test('scrobble queue: bounded (oldest dropped), sent in batches of 50', async () => {
  const r = rig({ fail: 1 })
  const base = nowS(r) - 86400
  // loop: NOT-WORTH — test: QUEUE_MAX + 5 adds
  for (let i = 0; i < QUEUE_MAX + 5; i++) r.q.add(track('s' + i), base + i * 200)
  assert.equal(r.q.pending(), QUEUE_MAX)
  assert.equal(r.saved[0].title, 's5')
  await r.q.tick()                                   // the first send fails
  r.clock = r.q.nextAt()
  // loop: NOT-WORTH — test: drain in batches
  while (r.q.pending()) await r.q.tick()
  assert.ok(r.sends.every((b) => b.length <= BATCH))
  assert.equal(r.sends.length, 1 + QUEUE_MAX / BATCH)
})

test('LastFm.scrobbleBatch: indexed params, signed, accepted / ignored read back; Last.fm errors throw', async () => {
  const lf = new LastFm('/nonexistent/lastfm.json')
  lf.config = { apiKey: 'k', apiSecret: 's', sessionKey: 'sk' }
  const real = global.fetch
  let body = null
  global.fetch = async (url, opts) => { body = new URLSearchParams(opts.body); return { json: async () => ({ scrobbles: { '@attr': { accepted: 1, ignored: 1 } } }) } }
  try {
    const r = await lf.scrobbleBatch([{ artist: 'A', title: 'one', timestamp: 10, album: 'X', duration: 200.4 }, { artist: 'B', title: 'two', timestamp: 20 }])
    assert.deepEqual(r, { accepted: 1, ignored: 1 })
    assert.equal(body.get('method'), 'track.scrobble')
    assert.equal(body.get('artist[1]'), 'B')
    assert.equal(body.get('track[0]'), 'one')
    assert.equal(body.get('timestamp[1]'), '20')
    assert.equal(body.get('duration[0]'), '200')
    assert.equal(body.get('album[1]'), null)
    assert.match(body.get('api_sig'), /^[0-9a-f]{32}$/)
    global.fetch = async () => ({ json: async () => ({ error: 11, message: 'Service Offline' }) })
    await assert.rejects(lf.scrobbleBatch([{ artist: 'A', title: 'one', timestamp: 10 }]), /error 11/)
  } finally { global.fetch = real }
})
