const test = require('node:test')
const assert = require('node:assert/strict')
const crypto = require('crypto')
const fs = require('fs')
const os = require('os')
const path = require('path')
const U = require('../update-feed')
const { selectRelease, feedText } = require('../tools/feed-lib')

// A throwaway key pair stands in for the real one.
const pair = () => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519')
  return { privateKey, pub: publicKey.export({ format: 'der', type: 'spki' }).toString('base64') }
}
const K = pair()
const OTHER = pair()
const sign = (text, key = K.privateKey) => crypto.sign(null, Buffer.from(text), key).toString('base64') + '\n'

const appImage = Buffer.from('pretend AppImage bytes')
const sha512hex = crypto.createHash('sha512').update(appImage).digest('hex')
const release = (tag, { prerelease = false, draft = false, asset = true } = {}) => ({
  tag_name: tag, prerelease, draft, published_at: '2026-10-20T00:00:00Z',
  html_url: `https://github.com/${U.REPO}/releases/tag/${tag}`, body: 'notes for ' + tag,
  assets: asset ? [{ name: `sonata-${tag.slice(1)}-x86_64.AppImage`, size: appImage.length }] : []
})
const RELEASES = [
  release('v0.15.14-dev.1', { prerelease: true }),
  release('v0.15.13'),
  release('v0.15.13-dev.2', { prerelease: true }),
  release('v0.15.12'),
  release('v0.16.0-dev.1', { prerelease: true, draft: true }),
  release('v0.15.11', { asset: false })
]
const feedFor = (channel) => feedText(channel, selectRelease(RELEASES, channel), { sha512: sha512hex, size: appImage.length })
const fetcher = (files) => async (url) => {
  if (!(url in files)) throw new Error('HTTP 404 ' + url)
  return files[url]
}

test('version ordering: dev builds sort before their release', () => {
  assert.ok(U.isNewerVersion('0.15.13', '0.15.13-dev.2'))
  assert.ok(!U.isNewerVersion('0.15.13-dev.2', '0.15.13'))
  assert.ok(U.isNewerVersion('0.15.13-dev.10', '0.15.13-dev.9'))
  assert.ok(U.isNewerVersion('0.15.13-dev.1', '0.15.12'))
  assert.ok(U.isNewerVersion('0.15.13', '0.15.12'))
  assert.ok(U.isNewerVersion('0.16.0', '0.15.99'))
  assert.ok(!U.isNewerVersion('0.15.13', '0.15.13'))
  assert.ok(!U.isNewerVersion('garbage', '0.15.13'))
  assert.ok(!U.isNewerVersion('0.15.13-beta.1', '0.15.12'))
})

test('channel filtering: Stable never sees dev builds, Development gets the newest of both', () => {
  assert.equal(selectRelease(RELEASES, 'stable').version, '0.15.13')
  assert.equal(selectRelease(RELEASES, 'dev').version, '0.15.14-dev.1')
  // a stable release newer than every dev build reaches Development too
  assert.equal(selectRelease([release('v0.15.15'), ...RELEASES], 'dev').version, '0.15.15')
  // drafts and releases without the AppImage are skipped
  assert.equal(selectRelease([release('v0.15.11', { asset: false })], 'stable'), null)
  // a dev tag that isn't marked prerelease isn't a stable release either
  assert.equal(selectRelease([release('v0.15.14-dev.1')], 'stable'), null)
})

test('signed feed: verifies and parses', async () => {
  const text = feedFor('stable')
  const url = U.FEED_URLS.stable
  const u = await U.fetchUpdate({ channel: 'stable', keys: [K.pub], fetchText: fetcher({ [url]: text, [url + '.sig']: sign(text) }) })
  assert.equal(u.version, '0.15.13')
  assert.equal(u.signed, true)
  assert.equal(u.url, `https://github.com/${U.REPO}/releases/download/v0.15.13/sonata-0.15.13-x86_64.AppImage`)
  assert.equal(u.size, appImage.length)
  const d = await U.fetchUpdate({ channel: 'dev', keys: [K.pub], fetchText: fetcher({ [U.FEED_URLS.dev]: feedFor('dev'), [U.FEED_URLS.dev + '.sig']: sign(feedFor('dev')) }) })
  assert.equal(d.version, '0.15.14-dev.1')
})

test('signed feed: a tampered feed is refused', async () => {
  const text = feedFor('stable')
  const tampered = text.replace(sha512hex, 'f'.repeat(128))
  const url = U.FEED_URLS.stable
  await assert.rejects(
    U.fetchUpdate({ channel: 'stable', keys: [K.pub], fetchText: fetcher({ [url]: tampered, [url + '.sig']: sign(text) }) }),
    /not signed by a trusted key/)
  assert.ok(!U.feedSignedBy(text + ' ', sign(text), [K.pub]))
})

test('signed feed: a wrong key, a missing or garbage .sig is refused', async () => {
  const text = feedFor('stable')
  const url = U.FEED_URLS.stable
  await assert.rejects(
    U.fetchUpdate({ channel: 'stable', keys: [K.pub], fetchText: fetcher({ [url]: text, [url + '.sig']: sign(text, OTHER.privateKey) }) }),
    /not signed by a trusted key/)
  await assert.rejects(U.fetchUpdate({ channel: 'stable', keys: [K.pub], fetchText: fetcher({ [url]: text }) }), /404/)
  assert.ok(!U.feedSignedBy(text, 'not base64 at all', [K.pub]))
  assert.ok(!U.feedSignedBy(text, sign(text), ['broken key']))
  // rotation: either listed key verifies
  assert.ok(U.feedSignedBy(text, sign(text, OTHER.privateKey), [K.pub, OTHER.pub]))
})

test('signed feed: Stable refuses a dev build or the other channel\'s feed, even when signed', async () => {
  const dev = feedFor('dev')
  assert.throws(() => U.parseSignedFeed(dev, 'stable'), /dev channel, not stable/)
  const relabeled = dev.replace('"channel": "dev"', '"channel": "stable"')
  assert.throws(() => U.parseSignedFeed(relabeled, 'stable'), /development build on Stable/)
  const elsewhere = feedFor('stable').replace(`https://github.com/${U.REPO}/`, 'https://evil.example/')
  assert.throws(() => U.parseSignedFeed(elsewhere, 'stable'), /outside this repository/)
})

test('download check: a tampered file or wrong size is refused', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sonata-feed-test-'))
  try {
    const file = path.join(dir, 'x.part')
    const u = U.parseSignedFeed(feedFor('stable'), 'stable')
    fs.writeFileSync(file, appImage)
    await U.verifyDownload(file, u)  // matches
    const flipped = Buffer.from(appImage); flipped[0] ^= 1
    fs.writeFileSync(file, flipped)
    await assert.rejects(U.verifyDownload(file, u), /SHA512 does not match/)
    fs.writeFileSync(file, Buffer.concat([appImage, Buffer.from('x')]))
    await assert.rejects(U.verifyDownload(file, u), /bytes, the feed says/)
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('transition: with the placeholder key the old latest-linux.yml path still works', async () => {
  assert.equal(U.signingReady(), U.TRUSTED_KEYS.some((k) => k !== U.PLACEHOLDER_KEY))
  assert.ok(!U.signingReady([U.PLACEHOLDER_KEY]))
  const sha512b64 = crypto.createHash('sha512').update(appImage).digest('base64')
  const yml = `version: 0.15.13
files:
  - url: sonata-0.15.13-x86_64.AppImage
    sha512: ${sha512b64}
    size: ${appImage.length}
path: sonata-0.15.13-x86_64.AppImage
sha512: ${sha512b64}
releaseDate: '2026-10-20T00:00:00.000Z'
`
  const logs = []
  for (const channel of ['stable', 'dev']) {
    const u = await U.fetchUpdate({ channel, keys: [U.PLACEHOLDER_KEY], fetchText: fetcher({ [U.LEGACY_FEED_URL]: yml }), log: (m) => logs.push(m) })
    assert.equal(u.version, '0.15.13')
    assert.equal(u.signed, false)
    assert.equal(u.url, `https://github.com/${U.REPO}/releases/download/v0.15.13/sonata-0.15.13-x86_64.AppImage`)
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sonata-feed-test-'))
    try {
      fs.writeFileSync(path.join(dir, 'f'), appImage)
      await U.verifyDownload(path.join(dir, 'f'), u)
      fs.writeFileSync(path.join(dir, 'f'), 'other bytes')
      await assert.rejects(U.verifyDownload(path.join(dir, 'f'), u), /does not match/)
    } finally { fs.rmSync(dir, { recursive: true, force: true }) }
  }
  assert.match(logs[0], /unsigned latest-linux\.yml/)
  // a placeholder never verifies anything, even next to a real key
  assert.ok(!U.feedSignedBy('x', sign('x'), [U.PLACEHOLDER_KEY]))
  // the yml must carry a SHA-512 (it was optional before)
  assert.throws(() => U.parseLegacyFeed(yml.replace(/^sha512: .*$/m, '')), /no SHA-512/)
})

test('feed text is stable JSON the app accepts', () => {
  const text = feedFor('stable')
  assert.ok(text.endsWith('}\n'))
  const f = JSON.parse(text)
  assert.deepEqual(Object.keys(f), ['channel', 'version', 'file', 'url', 'sha512', 'size', 'date', 'notes_url', 'notes'])
  assert.equal(U.parseSignedFeed(text, 'stable').hash.value, sha512hex)
})
