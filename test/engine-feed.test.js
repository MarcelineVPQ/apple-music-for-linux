// engine-feed.js: the signed engine feed (latest-engine.json / latest-engine-dev.json on sonata-releases
// main), so a newer Precise timing helper is offered without a Sonata release. Signed with a throwaway key
// here and served from a loopback server, like the real thing from GitHub.
const test = require('node:test')
const assert = require('node:assert/strict')
const crypto = require('crypto')
const http = require('http')
const F = require('../engine-feed')

const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519')
const KEY = publicKey.export({ format: 'der', type: 'spki' }).toString('base64')
const sign = (text, k = privateKey) => crypto.sign(null, Buffer.from(text, 'utf8'), k).toString('base64')
const P = F.ENGINE_DOWNLOAD_PREFIX
const feed = (o = {}, prefix = P) => {
  const v = o.version || '0.2.2'
  const file = 'sonata-engine-' + v + '-linux-x86_64.tar.gz'
  // the live Development feed's form (2026-10-18): a superset of align/engine.json
  return JSON.stringify(Object.assign({
    channel: 'stable', name: 'sonata-engine', version: v, tag: 'engine-v' + v, prerelease: true, protocol: 2, python: '3.14', platform: 'linux-x86_64',
    file, url: prefix + 'engine-v' + v + '/' + file, size: 1515861, sha256: 'b'.repeat(64), sig: 'A'.repeat(86) + '==', key: KEY,
    licence: { version: 'draft-1', sha256: 'c'.repeat(64) }, released: '2026-10-18T15:08:07Z', notes_url: 'https://github.com/MarcelineVPQ/sonata-releases/releases/tag/engine-v' + v
  }, o), null, 2)
}
const served = (files) => (url) => (url in files ? Promise.resolve(files[url]) : Promise.reject(new Error('HTTP 404')))

test('engine feed: a signed feed is read and every field checked', async () => {
  const text = feed()
  const u = F.ENGINE_FEED_URLS.stable
  const offer = await F.fetchEngineFeed({ channel: 'stable', fetchText: served({ [u]: text, [u + '.sig']: sign(text) }), keys: [KEY] })
  assert.equal(offer.version, '0.2.2')
  assert.equal(offer.protocol, 2)
  assert.equal(offer.url, P + 'engine-v0.2.2/sonata-engine-0.2.2-linux-x86_64.tar.gz')
  assert.deepEqual(offer.licence, { version: 'draft-1', sha256: 'c'.repeat(64) })
  assert.equal(offer.date, '2026-10-18T15:08:07Z')
  // sig as the address of the .sig file is fine too; a plain-string licence is its version
  assert.equal(F.parseEngineFeed(feed({ sig: P + 'engine-v0.2.2/sonata-engine-0.2.2-linux-x86_64.tar.gz.sig', licence: 'draft-2' }), 'stable').licence.version, 'draft-2')
  const bad = [
    [{ url: 'https://evil.example/x.tar.gz' }, /outside the engine releases/],
    [{ file: 'other.tar.gz' }, /unexpected file/],
    [{ sig: 'https://evil.example/x.sig' }, /bad signature field/],
    [{ platform: 'darwin-arm64' }, /another platform/],
    [{ tag: 'engine-v9.9.9' }, /another tag/],
    [{ licence: { version: 'draft 1!' } }, /licence version/],
    [{ licence: { sha256: 'nope' } }, /licence SHA-256/],
    [{ version: '0.3.0-dev.1', tag: 'engine-v0.3.0-dev.1' }, /development engine on Stable/],
    [{ sha256: 'xyz' }, /SHA-256/],
    [{ size: 0 }, /size/],
    [{ version: '0.2' }, /version/],
    [{ protocol: '2' }, /protocol/],
    [{ python: 'three' }, /Python/],
    [{ channel: 'dev' }, /dev channel, not stable/],
    [{ min_sonata: 'soon' }, /min_sonata/]
  ]
  // loop: NOT-WORTH — ten malformed feeds
  for (const [o, re] of bad) assert.throws(() => F.parseEngineFeed(feed(o), 'stable'), re, JSON.stringify(o))
  // the key it names must be the trusted one (when Sonata knows it)
  const other = crypto.generateKeyPairSync('ed25519').publicKey.export({ format: 'der', type: 'spki' }).toString('base64')
  assert.throws(() => F.parseEngineFeed(feed({ key: other }), 'stable', P, [KEY]), /another signing key/)
  // X.Y.Z-dev.N: on the Development channel only
  const dv = F.parseEngineFeed(feed({ channel: 'dev', version: '0.3.0-dev.1', tag: 'engine-v0.3.0-dev.1' }), 'dev')
  assert.equal(dv.url, P + 'engine-v0.3.0-dev.1/sonata-engine-0.3.0-dev.1-linux-x86_64.tar.gz')
  assert.throws(() => F.parseEngineFeed('not json', 'stable'), /not valid JSON/)
})

test('engine feed: unsigned, tampered or signed by another key is refused', async () => {
  const text = feed()
  const u = F.ENGINE_FEED_URLS.stable
  const other = crypto.generateKeyPairSync('ed25519').privateKey
  const cases = [
    [{ [u]: text, [u + '.sig']: '' }, 'no signature'],
    [{ [u]: text.replace('0.2.2', '0.2.3'), [u + '.sig']: sign(text) }, 'tampered'],
    [{ [u]: text, [u + '.sig']: sign(text, other) }, 'another key']
  ]
  // loop: NOT-WORTH — three cases
  for (const [files, name] of cases) {
    await assert.rejects(F.fetchEngineFeed({ channel: 'stable', fetchText: served(files), keys: [KEY] }), /not signed by the engine key/, name)
  }
  await assert.rejects(F.fetchEngineFeed({ channel: 'stable', fetchText: served({}), keys: [] }), /no key/)
})

test('engine feed: no Stable feed published yet (404) means no stable engine, not an error', async () => {
  assert.equal(await F.fetchEngineFeed({ channel: 'stable', fetchText: served({}), keys: [KEY] }), null)
  assert.equal(await F.fetchEngineFeed({ channel: 'dev', fetchText: served({}), keys: [KEY] }), null)
  await assert.rejects(F.fetchEngineFeed({ channel: 'stable', fetchText: () => Promise.reject(new Error('HTTP 500')), keys: [KEY] }), /500/)
})

test('engine feed: Development reads latest-engine-dev.json, falls back to Stable only when it is missing (never past a bad signature)', async () => {
  const s = F.ENGINE_FEED_URLS.stable, d = F.ENGINE_FEED_URLS.dev
  const st = feed({ version: '0.2.2' })
  const dv = feed({ version: '0.3.0', channel: 'dev' })
  const both = { [s]: st, [s + '.sig']: sign(st), [d]: dv, [d + '.sig']: sign(dv) }
  assert.equal((await F.fetchEngineFeed({ channel: 'dev', fetchText: served(both), keys: [KEY] })).version, '0.3.0')
  assert.equal((await F.fetchEngineFeed({ channel: 'stable', fetchText: served(both), keys: [KEY] })).version, '0.2.2')
  assert.equal((await F.fetchEngineFeed({ channel: 'dev', fetchText: served({ [s]: st, [s + '.sig']: sign(st) }), keys: [KEY] })).version, '0.2.2')
  await assert.rejects(F.fetchEngineFeed({ channel: 'dev', fetchText: served(Object.assign({}, both, { [d + '.sig']: sign('x') })), keys: [KEY] }), /not signed/)
  // the Stable feed may not carry the Development one's channel
  await assert.rejects(F.fetchEngineFeed({ channel: 'stable', fetchText: served({ [s]: dv, [s + '.sig']: sign(dv) }), keys: [KEY] }), /dev channel/)
})

test('engine compatibility: protocol, minimum, Sonata range; offered only when newer (no downgrade)', () => {
  const offer = F.parseEngineFeed(feed({ version: '0.2.2' }), 'stable')
  const ctx = { appVersion: '0.15.46-dev.1', min: '0.2.1' }
  assert.deepEqual(F.judgeOffer(offer, '0.2.1', ctx), { state: 'available', offer, why: '' })
  assert.equal(F.judgeOffer(offer, '', ctx).state, 'available')          // nothing installed: Install takes it
  assert.equal(F.judgeOffer(offer, '0.2.2', ctx).state, 'current')
  assert.equal(F.judgeOffer(offer, '0.3.0', ctx).state, 'current')       // older than the installed one: never offered
  const p3 = F.parseEngineFeed(feed({ version: '0.4.0', protocol: 3 }), 'stable')
  assert.equal(F.judgeOffer(p3, '0.2.1', ctx).state, 'incompatible')
  assert.match(F.judgeOffer(p3, '0.2.1', ctx).why, /newer Sonata .*protocol 3/)
  const old = F.parseEngineFeed(feed({ version: '0.2.0' }), 'stable')
  assert.match(F.incompatible(old, ctx), /older than 0\.2\.1/)
  const needs = F.parseEngineFeed(feed({ version: '0.2.5', min_sonata: '0.16.0' }), 'stable')
  assert.match(F.judgeOffer(needs, '0.2.1', ctx).why, /needs Sonata 0\.16\.0/)
  assert.equal(F.incompatible(F.parseEngineFeed(feed({ version: '0.2.5', min_sonata: '0.15.46' }), 'stable'), ctx), '')   // a dev build of 0.15.46 counts as 0.15.46
  assert.match(F.incompatible(F.parseEngineFeed(feed({ version: '0.2.5', max_sonata: '0.15.40' }), 'stable'), ctx), /up to 0\.15\.40/)
  assert.equal(F.judgeOffer(null, '0.2.1', ctx).state, 'current')
  // development engines: newer than the release before, older than their release
  const d1 = F.parseEngineFeed(feed({ channel: 'dev', version: '0.2.2-dev.1', tag: 'engine-v0.2.2-dev.1' }), 'dev')
  assert.equal(F.judgeOffer(d1, '0.2.1', ctx).state, 'available')
  assert.equal(F.judgeOffer(d1, '0.2.2', ctx).state, 'current')
  assert.equal(F.judgeOffer(d1, '0.2.2-dev.2', ctx).state, 'current')
})

test('engine pin: the file align/install.sh --pin reads (one key per line, the production address)', () => {
  const offer = F.parseEngineFeed(feed({ version: '0.2.2' }), 'stable')
  const text = F.pinText(offer, KEY)
  const pin = JSON.parse(text)
  assert.deepEqual(Object.keys(pin), ['version', 'protocol', 'python', 'file', 'url', 'size', 'sha256', 'key'])
  assert.equal(pin.url, offer.url)
  assert.equal(pin.key, KEY)
  // one "key": value per line, as install.sh's sed reads it
  assert.ok(text.split('\n').filter((l) => l.includes(':')).every((l) => /^ {2}"\w+": ("[^"]*"|\d+),?$/.test(l)), text)
})

test('engine test feed: loopback http only, with its own key; the whole check over a real local server', async () => {
  assert.equal(F.testEngineFeed({ SONATA_ENGINE_FEED: 'http://example.com/' }), null)
  assert.equal(F.testEngineFeed({ SONATA_ENGINE_FEED: 'https://127.0.0.1/' }), null)
  assert.equal(F.testEngineFeed({}), null)
  const files = {}
  const server = http.createServer((req, res) => {
    const body = files[req.url]
    if (body === undefined) { res.writeHead(404); res.end(); return }
    res.writeHead(200); res.end(body)
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    const base = 'http://127.0.0.1:' + server.address().port + '/'
    const t = F.testEngineFeed({ SONATA_ENGINE_FEED: base, SONATA_ENGINE_PUBKEY: KEY })
    assert.equal(t.urls.stable, base + 'latest-engine.json')
    const text = feed({ version: '0.2.9' }, base)
    files['/latest-engine.json'] = text
    files['/latest-engine.json.sig'] = sign(text)
    const fetchText = (url) => new Promise((resolve, reject) => http.get(url, (res) => {
      let b = ''
      res.on('data', (c) => { b += c })
      res.on('end', () => (res.statusCode === 200 ? resolve(b) : reject(new Error('HTTP ' + res.statusCode))))
    }).on('error', reject))
    const offer = await F.fetchEngineFeed({ channel: 'dev', fetchText, keys: [], test: t })   // no dev feed there: Stable
    assert.equal(offer.version, '0.2.9')
    assert.equal(offer.url, base + 'engine-v0.2.9/sonata-engine-0.2.9-linux-x86_64.tar.gz')
    // the pin still names the production address; main passes the test server as --from
    assert.match(F.pinText(offer, KEY), /"url": "https:\/\/github\.com\/MarcelineVPQ\/sonata-releases\/releases\/download\/engine-v0\.2\.9\//)
    files['/latest-engine.json'] = text.replace('0.2.9', '0.3.9')
    await assert.rejects(F.fetchEngineFeed({ channel: 'stable', fetchText, keys: [], test: t }), /not signed/)
  } finally { server.close() }
})
