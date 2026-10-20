// The self-update flow (updater.js) against a LOCAL SIGNED TEST FEED: a loopback HTTP server, a
// throwaway Ed25519 key passed the way SONATA_UPDATE_PUBKEY does, real update-feed.js checks
// (signature, channel, file name, URL, size, SHA-512), real file swaps in a temp folder.
const test = require('node:test')
const assert = require('node:assert/strict')
const crypto = require('crypto')
const fs = require('fs')
const http = require('http')
const os = require('os')
const path = require('path')
const U = require('../updater')
const F = require('../update-feed')

const KEY = crypto.generateKeyPairSync('ed25519')
const PUB = KEY.publicKey.export({ format: 'der', type: 'spki' }).toString('base64')
const OTHER = crypto.generateKeyPairSync('ed25519')

// one loopback feed server; `files` maps a path to its bytes
function serve(files) {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      const body = files[req.url]
      if (body === undefined) { res.writeHead(404); res.end(); return }
      res.writeHead(200, { 'content-length': Buffer.byteLength(body) })
      res.end(body)
    })
    srv.listen(0, '127.0.0.1', () => resolve({ srv, base: 'http://127.0.0.1:' + srv.address().port + '/' }))
  })
}
const get = (url) => new Promise((resolve, reject) => {
  http.get(url, (res) => {
    if (res.statusCode !== 200) { res.resume(); reject(new Error('HTTP ' + res.statusCode)); return }
    let b = ''
    res.setEncoding('utf8')
    res.on('data', (c) => { b += c })
    res.on('end', () => resolve(b))
  }).on('error', reject)
})
const download = (url, dest, onProgress) => new Promise((resolve, reject) => {
  http.get(url, (res) => {
    if (res.statusCode !== 200) { res.resume(); reject(new Error('HTTP ' + res.statusCode)); return }
    const total = Number(res.headers['content-length']) || 0
    let got = 0
    const out = fs.createWriteStream(dest)
    res.on('data', (c) => { got += c.length; out.write(c); onProgress(got, total) })
    res.on('end', () => out.end(resolve))
  }).on('error', reject)
})

// a feed for `version`, signed with `key`; `bytes` the AppImage; `sha` override to fake a mismatch
function feedFiles(base, channel, version, bytes, opts) {
  const o = opts || {}
  const file = `sonata-${version}-x86_64.AppImage`
  const feed = JSON.stringify({
    channel, version, file, url: `${base}v${version}/${file}`,
    sha512: o.sha || crypto.createHash('sha512').update(bytes).digest('hex'), size: bytes.length,
    date: '2026-10-16', notes_url: 'https://example.invalid/notes', notes: '### Added\n\n- **Glass**'
  }, null, 2) + '\n'
  const name = channel === 'dev' ? 'latest-dev.json' : 'latest.json'
  const sig = crypto.sign(null, Buffer.from(feed), (o.key || KEY).privateKey).toString('base64') + '\n'
  return { ['/' + name]: feed, ['/' + name + '.sig']: sig, [`/v${version}/${file}`]: bytes }
}

async function rig(version, channel, feeds) {
  const files = {}
  const { srv, base } = await serve(files)
  for (const f of feeds) Object.assign(files, f(base))
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sonata-upd-'))
  const running = path.join(dir, `sonata-${version}-x86_64.AppImage`)
  fs.writeFileSync(running, 'the running AppImage')
  const test = F.testFeed({ SONATA_UPDATE_FEED: base, SONATA_UPDATE_PUBKEY: PUB })
  const states = []
  const installed = []
  let ch = channel
  let t = 0
  const hooks = { onEmit: null }   // what main.js's onUpdateState does when it hears a state
  const up = U.createUpdater({
    version,
    channel: () => ch,
    fetchUpdate: (c) => F.fetchUpdate({ channel: c, fetchText: get, test }),
    download,
    verify: (file, feed) => F.verifyDownload(file, feed),
    fs,
    installedPath: () => running,
    blocker: () => null,
    onInstalled: (p) => installed.push(p),
    emit: (s) => { states.push(s.phase); if (hooks.onEmit) hooks.onEmit(s) },
    now: () => (t += 1000),
    log: () => {}
  })
  return { up, dir, running, states, installed, hooks, setChannel: (c) => { ch = c }, close: () => srv.close() }
}
const BYTES = Buffer.from('a new AppImage, '.repeat(5000))

test('offers: newer only; Back to stable: any other stable version, older included; never a dev build', () => {
  assert.ok(U.offers('0.15.33', '0.15.32', false))
  assert.ok(!U.offers('0.15.32', '0.15.32', false))
  assert.ok(!U.offers('0.15.31', '0.15.32', false), 'never a downgrade')
  assert.ok(!U.offers('0.15.32', '0.15.33-dev.2', false), 'dev -> stable channel: no downgrade on its own')
  assert.ok(U.offers('0.15.32', '0.15.33-dev.2', true), 'Back to stable: the older stable')
  assert.ok(!U.offers('0.15.33-dev.3', '0.15.33-dev.2', true), 'Back to stable never takes a dev build')
  assert.ok(!U.offers('0.15.33-dev.2', '0.15.33-dev.2', true))
  assert.equal(U.updatedSince('0.15.31', '0.15.32'), '0.15.32')
  assert.equal(U.updatedSince('', '0.15.32'), null, 'first run: nothing to announce')
  assert.equal(U.updatedSince('0.15.32', '0.15.32'), null)
})

test('notices: available (Update + Details), progress, installed: Restart now only while nothing plays', () => {
  const a = U.updateNotice({ phase: 'available', version: '0.16.0', size: 130e6 }, {})
  assert.match(a.text, /Sonata 0\.16\.0 is available \(124 MB\)/)
  assert.deepEqual(a.actions.map((x) => x.id), ['update-details', 'update-install'])
  assert.ok(a.task && a.dismissKey === 'update:0.16.0')
  const d = U.updateNotice({ phase: 'downloading', version: '0.16.0', got: 52428800, total: 104857600 }, {})
  assert.equal(d.progress, 50)
  assert.equal(d.closable, false)
  const playing = U.updateNotice({ phase: 'ready', version: '0.16.0' }, { playing: true })
  assert.deepEqual(playing.actions, [], 'never interrupts playback')
  assert.match(playing.text, /next time you open Sonata/)
  const paused = U.updateNotice({ phase: 'ready', version: '0.16.0' }, { playing: false })
  assert.deepEqual(paused.actions.map((x) => x.id), ['update-restart'])
  assert.equal(U.updateNotice({ phase: 'failed', during: 'check', detail: 'offline' }, {}), null, 'a scheduled check that fails stays quiet')
  assert.equal(U.updateNotice({ phase: 'failed', during: 'check', detail: 'offline', shown: true }, {}).kind, 'error')
  assert.match(U.updateNotice({ phase: 'failed', during: 'install', detail: 'bad sha' }, {}).text, /didn't install: bad sha Your current version is untouched/)
  assert.match(U.statusLine({ phase: 'up-to-date' }, '0.15.32', 'stable'), /Up to date: 0\.15\.32 \(Stable\)/)
  // a failed install stays said when a later check offers the same version again (DS5)
  const again = U.updateNotice({ phase: 'available', version: '0.16.0' }, { lastFailure: { version: '0.16.0', detail: 'bad sha.' } })
  assert.equal(again.kind, 'error')
  assert.match(again.detail, /The last try didn't install: bad sha\. Your current version is untouched\./)
  assert.equal(again.actions[1].label, 'Try again')
  assert.notEqual(again.dismissKey, a.dismissKey, 'a new reason: shows even if the plain offer was dismissed')
  assert.equal(U.updateNotice({ phase: 'available', version: '0.16.1' }, { lastFailure: { version: '0.16.0', detail: 'x' } }).kind, 'info')
})

test('test feed: loopback http only; its key only with it', () => {
  assert.equal(F.testFeed({}), null)
  assert.equal(F.testFeed({ SONATA_UPDATE_FEED: 'https://example.com/' }), null)
  assert.equal(F.testFeed({ SONATA_UPDATE_FEED: 'http://10.0.0.5:8000/' }), null)
  const t = F.testFeed({ SONATA_UPDATE_FEED: 'http://127.0.0.1:8765', SONATA_UPDATE_PUBKEY: PUB })
  assert.equal(t.urls.stable, 'http://127.0.0.1:8765/latest.json')
  assert.ok(t.keys.includes(PUB) && F.TRUSTED_KEYS.every((k) => t.keys.includes(k)))
  assert.ok(!F.TRUSTED_KEYS.includes(PUB), 'the real list never gets the test key')
  assert.deepEqual(F.testFeed({ SONATA_UPDATE_FEED: 'http://localhost:1/', SONATA_UPDATE_PUBKEY: 'x; rm -rf' }).keys, F.TRUSTED_KEYS)
})

test('local feed: a newer stable release installs beside the running AppImage (signature, then SHA-512)', async () => {
  const r = await rig('0.15.32', 'stable', [(b) => feedFiles(b, 'stable', '0.15.33', BYTES)])
  try {
    const s = await r.up.check()
    assert.equal(s.phase, 'available')
    assert.equal(s.version, '0.15.33')
    assert.match(s.notes, /Glass/)
    const done = await r.up.install()
    assert.equal(done.phase, 'ready', JSON.stringify(done))
    const target = path.join(r.dir, 'sonata-0.15.33-x86_64.AppImage')
    assert.deepEqual(fs.readFileSync(target), BYTES)
    assert.equal(fs.statSync(target).mode & 0o777, 0o755)
    assert.equal(fs.readFileSync(r.running, 'utf8'), 'the running AppImage', 'the running file is untouched')
    assert.ok(!fs.existsSync(target + '.part'))
    assert.deepEqual(r.installed, [target])
    assert.deepEqual([...new Set(r.states)], ['checking', 'available', 'downloading', 'installing', 'ready'])
    // installed: a new check doesn't offer it again
    assert.equal((await r.up.check()).phase, 'ready')
  } finally { r.close() }
})

test('Install updates automatically: an install started on hearing "available" (as main.js does) runs to the end', async () => {
  const r = await rig('0.15.32', 'stable', [(b) => feedFiles(b, 'stable', '0.15.33', BYTES)])
  try {
    let started = null
    // main.js onUpdateState: phase 'available' + autoInstallUpdates -> installUpdate() -> updater.install(), synchronously
    r.hooks.onEmit = (st) => { if (st.phase === 'available' && !started) started = r.up.install() }
    await r.up.check()
    assert.ok(started, 'install() was called on "available"')
    const done = await started
    assert.equal(done.phase, 'ready', 'the install was not refused because the check still counted as busy: ' + JSON.stringify(done))
    assert.ok(fs.existsSync(path.join(r.dir, 'sonata-0.15.33-x86_64.AppImage')))
    assert.deepEqual([...new Set(r.states)], ['checking', 'available', 'downloading', 'installing', 'ready'])
  } finally { r.close() }
})

test('local feed: a feed signed by another key is refused before anything downloads', async () => {
  const r = await rig('0.15.32', 'stable', [(b) => feedFiles(b, 'stable', '0.15.33', BYTES, { key: OTHER })])
  try {
    const s = await r.up.check({ interactive: true })
    assert.equal(s.phase, 'failed')
    assert.match(s.detail, /not signed by a trusted key/)
    assert.ok(s.shown)
    assert.deepEqual(fs.readdirSync(r.dir), [path.basename(r.running)])
  } finally { r.close() }
})

test('local feed: a download whose SHA-512 differs is deleted and refused; nothing is swapped', async () => {
  const r = await rig('0.15.32', 'stable', [(b) => feedFiles(b, 'stable', '0.15.33', BYTES, { sha: 'a'.repeat(128) })])
  try {
    assert.equal((await r.up.check()).phase, 'available')
    const s = await r.up.install()
    assert.equal(s.phase, 'failed')
    assert.equal(s.during, 'install')
    assert.match(s.detail, /SHA512 does not match/)
    assert.equal(s.version, '0.15.33')
    assert.deepEqual(fs.readdirSync(r.dir), [path.basename(r.running)], 'no .part, no new file')
    assert.deepEqual(r.installed, [])
  } finally { r.close() }
})

test('local feed: an older version on Stable is refused (never a downgrade)', async () => {
  const r = await rig('0.15.32', 'stable', [(b) => feedFiles(b, 'stable', '0.15.31', BYTES)])
  try {
    assert.equal((await r.up.check()).phase, 'up-to-date')
    assert.equal((await r.up.install()).phase, 'up-to-date', 'install does nothing without an offer')
  } finally { r.close() }
})

test('local feed: Development -> Stable switch never downgrades; Back to stable installs the older stable', async () => {
  const r = await rig('0.15.33-dev.2', 'dev', [(b) => feedFiles(b, 'stable', '0.15.32', BYTES), (b) => feedFiles(b, 'dev', '0.15.33-dev.2', BYTES)])
  try {
    assert.equal((await r.up.check()).phase, 'up-to-date', 'dev: already the newest dev build')
    r.setChannel('stable')
    assert.equal((await r.up.check()).phase, 'up-to-date', 'switched to Stable: the older stable is NOT offered by itself')
    // Back to stable (confirmed in the panel)
    const s = await r.up.backToStable()
    assert.equal(s.phase, 'ready', JSON.stringify(s))
    assert.ok(fs.existsSync(path.join(r.dir, 'sonata-0.15.32-x86_64.AppImage')))
    assert.ok(r.states.includes('available'))
  } finally { r.close() }
})

test('local feed: Back to stable is dropped when Development is picked again before installing', async () => {
  const r = await rig('0.15.33-dev.2', 'dev', [(b) => feedFiles(b, 'stable', '0.15.32', BYTES), (b) => feedFiles(b, 'dev', '0.15.33-dev.2', BYTES)])
  try {
    r.setChannel('dev')
    assert.equal(r.up.returning(), false)
    assert.equal((await r.up.check()).phase, 'up-to-date')
  } finally { r.close() }
})

test('never writes over the AppImage it runs from', async () => {
  // a feed naming the running file (same version can't be offered, so fake the check result)
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sonata-upd-'))
  const running = path.join(dir, 'sonata-0.15.33-x86_64.AppImage')
  fs.writeFileSync(running, 'running')
  const up = U.createUpdater({
    version: '0.15.32', channel: () => 'stable',
    fetchUpdate: async () => ({ version: '0.15.33', file: 'sonata-0.15.33-x86_64.AppImage', url: 'http://127.0.0.1:1/x', size: 1, hash: {} }),
    download: async () => { throw new Error('must not download') }, verify: async () => {}, fs,
    installedPath: () => running, blocker: () => null, onInstalled: () => {}, emit: () => {}, now: () => 0, log: () => {}
  })
  assert.equal((await up.check()).phase, 'available')
  const s = await up.install()
  assert.equal(s.phase, 'failed')
  assert.match(s.detail, /refusing to overwrite/)
  assert.equal(fs.readFileSync(running, 'utf8'), 'running')
})

test('from source (no AppImage): manual, nothing online', async () => {
  let fetched = 0
  const up = U.createUpdater({ version: '0.15.32', channel: () => 'stable', fetchUpdate: async () => { fetched++ }, blocker: () => 'only the AppImage updates itself', emit: () => {}, now: () => 0, log: () => {} })
  assert.equal((await up.check()).phase, 'manual')
  assert.equal(fetched, 0)
})

// Marcy 2026-10-19: "Check for updates" said up to date minutes after a release: raw.githubusercontent.com's CDN
// served the feed for 5 minutes (max-age=300, x-cache HIT) and ignores query strings
test('a check the user asked for reads the feed fresh (GitHub\'s contents API), automatic ones the CDN; same signature check', async () => {
  assert.equal(F.freshUrl('https://raw.githubusercontent.com/MarcelineVPQ/sonata-releases/main/latest-dev.json'),
    'https://api.github.com/repos/MarcelineVPQ/sonata-releases/contents/latest-dev.json?ref=main')
  assert.equal(F.freshUrl('https://raw.githubusercontent.com/MarcelineVPQ/sonata-releases/main/latest-dev.json.sig'),
    'https://api.github.com/repos/MarcelineVPQ/sonata-releases/contents/latest-dev.json.sig?ref=main')
  assert.equal(F.freshUrl('https://example.com/x'), 'https://example.com/x')
  const asked = []
  const fetchText = async (u, o) => { asked.push([u, !!(o && o.fresh)]); throw new Error('offline') }
  await assert.rejects(F.fetchUpdate({ channel: 'dev', fetchText, fresh: true }))
  assert.deepEqual(asked.map(([u, f]) => [u.split('/')[2], f]).sort(), [['api.github.com', true], ['api.github.com', true], ['raw.githubusercontent.com', false], ['raw.githubusercontent.com', false]], 'the API, then the CDN as the fallback')
  asked.length = 0
  await assert.rejects(F.fetchUpdate({ channel: 'dev', fetchText }))
  assert.ok(asked.every(([u, f]) => u.startsWith('https://raw.githubusercontent.com/') && !f), 'automatic: the CDN only')
  // the updater asks fresh only for an interactive check
  const seen = []
  const up = U.createUpdater({ version: '0.15.32', channel: () => 'stable', fetchUpdate: async (c, o) => { seen.push(o && o.fresh); return { version: '0.15.32' } }, blocker: () => null, emit: () => {}, now: () => 0, log: () => {} })
  await up.check({ interactive: true })
  await up.check({})
  assert.deepEqual(seen, [true, false])
  const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8')
  assert.match(main, /if \(o && o\.fresh\) \{ req\.setHeader\('Accept', 'application\/vnd\.github\.raw'\); req\.setHeader\('Cache-Control', 'no-cache'\) \}/)
  assert.match(main, /fresh: !!\(o && o\.fresh\)/)
})
