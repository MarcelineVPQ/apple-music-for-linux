// The move of releases and feeds to the releases repository (update-feed.js REPO), and the bridge
// that gets installed builds there (docs/RELEASING.md, "Releases repository"). Installed builds up to
// 0.15.18 / 0.15.44-dev.1 read only the legacy repository's feeds and download only from its
// releases; test/fixtures/installed-update-feed/ holds their update-feed.js exactly as shipped.
const test = require('node:test')
const assert = require('node:assert/strict')
const crypto = require('crypto')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { execFileSync } = require('child_process')
const U = require('../update-feed')
const { selectRelease, feedText } = require('../tools/feed-lib')

const ROOT = path.join(__dirname, '..')
const INSTALLED = {
  '0.15.18': require('./fixtures/installed-update-feed/v0.15.18.js'),
  '0.15.44-dev.1': require('./fixtures/installed-update-feed/v0.15.44-dev.1.js')
}
// the first builds that read the releases repository
const BRIDGE = { stable: '0.15.19', dev: '0.15.44-dev.2' }

const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519')
const PUB = publicKey.export({ format: 'der', type: 'spki' }).toString('base64')
const PEM = privateKey.export({ format: 'pem', type: 'pkcs8' })
const appImage = Buffer.from('pretend bridge AppImage bytes')
const measured = { sha512: crypto.createHash('sha512').update(appImage).digest('hex'), size: appImage.length }

const release = (repo, tag, prerelease) => ({
  tag_name: tag, prerelease, draft: false, published_at: '2026-10-19T00:00:00Z',
  html_url: `https://github.com/${repo}/releases/tag/${tag}`, body: 'notes for ' + tag,
  assets: [{ name: `sonata-${tag.slice(1)}-x86_64.AppImage`, size: appImage.length }]
})
// what a repository's release list looks like once both bridge builds are out
const releases = (repo) => [
  release(repo, 'v' + BRIDGE.dev, true), release(repo, 'v' + BRIDGE.stable, false),
  release(repo, 'v0.15.44-dev.1', true), release(repo, 'v0.15.18', false)
]
const feedOf = (repo, channel) => feedText(channel, selectRelease(releases(repo), channel), measured, repo)

// sign like CI does: tools/sign-feed.js with the key in SONATA_FEED_KEY
function signWithTool(text) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sonata-bridge-'))
  try {
    fs.writeFileSync(path.join(dir, 'latest.json'), text)
    execFileSync(process.execPath, [path.join(ROOT, 'tools/sign-feed.js'), 'latest.json'], { cwd: dir, env: { ...process.env, SONATA_FEED_KEY: PEM }, stdio: 'ignore' })
    return fs.readFileSync(path.join(dir, 'latest.json.sig'), 'utf8')
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
}
const served = (urls, channel, text) => {
  const files = { [urls[channel]]: text, [urls[channel] + '.sig']: signWithTool(text) }
  return async (url) => { if (!(url in files)) throw new Error('HTTP 404 ' + url); return files[url] }
}
async function verifiedBy(mod, update) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sonata-bridge-'))
  try { fs.writeFileSync(path.join(dir, 'f'), appImage); await mod.verifyDownload(path.join(dir, 'f'), update) } finally { fs.rmSync(dir, { recursive: true, force: true }) }
}

test('this build reads the releases repository: feeds on its main, downloads from its releases', () => {
  assert.equal(U.REPO, 'MarcelineVPQ/sonata-releases')
  assert.equal(U.FEED_URLS.stable, 'https://raw.githubusercontent.com/MarcelineVPQ/sonata-releases/main/latest.json')
  assert.equal(U.FEED_URLS.dev, 'https://raw.githubusercontent.com/MarcelineVPQ/sonata-releases/main/latest-dev.json')
  assert.equal(U.DOWNLOAD_PREFIX, 'https://github.com/MarcelineVPQ/sonata-releases/releases/download/')
  assert.equal(U.LEGACY_FEED_URL, 'https://github.com/MarcelineVPQ/sonata-releases/releases/latest/download/latest-linux.yml')
  // the legacy location is exactly what the installed builds have compiled in
  for (const [v, old] of Object.entries(INSTALLED)) {
    assert.equal(old.REPO, U.LEGACY_REPO, v)
    assert.deepEqual(old.FEED_URLS, U.feedUrls(U.LEGACY_REPO, U.LEGACY_FEED_BRANCH), v)
  }
})

test('same signing scheme: same trusted keys and file name rule as the installed builds', () => {
  for (const [v, old] of Object.entries(INSTALLED)) {
    assert.deepEqual(U.TRUSTED_KEYS, old.TRUSTED_KEYS, v)
    assert.equal(U.FILE_RE.source, old.FILE_RE.source, v)
  }
})

test('bridge: installed builds take the bridge build from the legacy feed, signature and download check out', async () => {
  const cases = [['0.15.18', 'stable'], ['0.15.44-dev.1', 'dev'], ['0.15.44-dev.1', 'stable']]
  for (const [installed, channel] of cases) {
    const old = INSTALLED[installed]
    const text = feedOf(U.LEGACY_REPO, channel)
    const u = await old.fetchUpdate({ channel, keys: [PUB], fetchText: served(old.FEED_URLS, channel, text) })
    assert.equal(u.version, BRIDGE[channel], `${installed} on ${channel}`)
    assert.equal(u.signed, true)
    assert.ok(u.url.startsWith(`https://github.com/${U.LEGACY_REPO}/releases/download/v${BRIDGE[channel]}/`), u.url)
    // Stable 0.15.18 moves up to 0.15.19; Development 0.15.44-dev.1 to the dev bridge
    if (channel === 'stable' && installed === '0.15.18') assert.ok(old.isNewerVersion(u.version, installed))
    if (channel === 'dev') assert.ok(old.isNewerVersion(u.version, installed))
    await verifiedBy(old, u)
  }
})

test('bridge: installed builds refuse the releases repository\'s own feed, so the legacy feeds must carry the bridge', async () => {
  for (const [installed, old] of Object.entries(INSTALLED)) {
    const text = feedOf(U.REPO, 'stable')
    await assert.rejects(old.fetchUpdate({ channel: 'stable', keys: [PUB], fetchText: served(old.FEED_URLS, 'stable', text) }), /outside this repository/, installed)
  }
})

test('after the bridge: this build takes the releases repository\'s feed and refuses a legacy-repository download', async () => {
  for (const channel of ['stable', 'dev']) {
    const u = await U.fetchUpdate({ channel, keys: [PUB], fetchText: served(U.FEED_URLS, channel, feedOf(U.REPO, channel)) })
    assert.equal(u.version, BRIDGE[channel])
    assert.equal(u.url, `${U.DOWNLOAD_PREFIX}v${u.version}/sonata-${u.version}-x86_64.AppImage`)
    await verifiedBy(U, u)
    await assert.rejects(U.fetchUpdate({ channel, keys: [PUB], fetchText: served(U.FEED_URLS, channel, feedOf(U.LEGACY_REPO, channel)) }), /outside this repository/)
  }
})

test('the release workflows publish to the releases repository and keep the legacy feeds for the bridge', () => {
  const release = fs.readFileSync(path.join(ROOT, '.github/workflows/release.yml'), 'utf8')
  const feed = fs.readFileSync(path.join(ROOT, '.github/workflows/feed.yml'), 'utf8')
  assert.ok(release.includes(`RELEASES_REPO: ${U.REPO}`), 'release.yml pushes the release to the releases repository')
  assert.ok(release.includes('git archive'), 'release.yml makes the GPL source archive')
  // the legacy feeds are built for the legacy repository's releases (the URLs installed builds accept)
  assert.match(feed, new RegExp(`build-feed\\.js --repo ${U.LEGACY_REPO} --channel stable`))
  assert.match(feed, new RegExp(`build-feed\\.js --repo ${U.LEGACY_REPO} --channel dev`))
})
