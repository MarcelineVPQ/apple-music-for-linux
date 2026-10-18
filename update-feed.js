// The self-update feed, kept free of Electron so it can be tested with node --test.
//
// Same design as the DS5 app (electron/main/feedSignature.ts there): CI writes
// latest.json (Stable) and latest-dev.json (Development) on the releases repository's main, signs each
// file's exact bytes with an Ed25519 key that only exists as the
// SONATA_FEED_KEY Actions secret (tools/sign-feed.mjs), and commits the
// signature beside it as latest.json.sig (base64). The app refuses a feed no
// key in TRUSTED_KEYS signed, and a download whose size or SHA-512 differs
// from the signed feed. See docs/RELEASING.md.
const crypto = require('crypto')
const fs = require('fs')

// Where releases and feeds live (0.15.45-dev.1 on): a public release-only repository with
// the signed AppImages, latest.json / latest-dev.json (+ .sig) on main and each release's GPL source
// archive. Builds up to 0.15.18 / 0.15.44-dev.1 read LEGACY_REPO (the source repository, feeds on
// master); its Development feed stays frozen on the last bridge build, which reads REPO, and its Stable feed on
// 0.15.18 (no Stable bridge; docs/RELEASING.md, "Releases repository").
const REPO = 'MarcelineVPQ/sonata-releases'
const FEED_BRANCH = 'main'
const LEGACY_REPO = 'MarcelineVPQ/apple-music-for-linux'
const LEGACY_FEED_BRANCH = 'master'
const feedUrls = (repo, branch) => ({
  stable: `https://raw.githubusercontent.com/${repo}/${branch}/latest.json`,
  dev: `https://raw.githubusercontent.com/${repo}/${branch}/latest-dev.json`
})
const downloadPrefix = (repo) => `https://github.com/${repo}/releases/download/`
const FEED_URLS = feedUrls(REPO, FEED_BRANCH)
// electron-builder's feed, read by installs up to 0.15.12 (and by this app while
// the key below is still the placeholder). Unsigned: only GitHub's TLS vouches for it.
const LEGACY_FEED_URL = `https://github.com/${REPO}/releases/latest/download/latest-linux.yml`
const DOWNLOAD_PREFIX = downloadPrefix(REPO)

// PLACEHOLDER_KEY is kept for the tests and the fallback logic: while only the
// placeholder is listed, signingReady() is false and the updater falls back to the
// unsigned latest-linux.yml path. The real key is in TRUSTED_KEYS below.
const PLACEHOLDER_KEY = 'PLACEHOLDER-SONATA-FEED-PUBLIC-KEY'
// base64 SPKI DER (`openssl pkey -pubout -outform DER | base64`). A list so the
// key can be rotated: ship the new key in one release, start signing with it in the next.
const TRUSTED_KEYS = [
  'MCowBQYDK2VwAyEAVxFXyg3ED8cezVoKuB4w1n4lpaOx8au7hepDDg6R0WE=', // 2026-10, ~/.config/sonata-release on the developer's PC
]

const signingReady = (keys = TRUSTED_KEYS) => keys.some((k) => k !== PLACEHOLDER_KEY)

function feedSignedBy(text, signatureB64, keys) {
  const signature = Buffer.from(String(signatureB64 || '').trim(), 'base64')
  if (signature.length !== 64) return false
  // loop: NOT-WORTH — N = 1 trusted key (2 during a rotation)
  return keys.some((k) => {
    if (k === PLACEHOLDER_KEY) return false
    try {
      const key = crypto.createPublicKey({ key: Buffer.from(k, 'base64'), format: 'der', type: 'spki' })
      return crypto.verify(null, Buffer.from(text, 'utf8'), key, signature)
    } catch (e) {
      // error: NOT-WORTH — a key that can't be read verifies nothing: the update is refused as unsigned, which the log/dialog says
      return false
    }
  })
}

// X.Y.Z or X.Y.Z-dev.N -> [X, Y, Z, N]; a release sorts after its dev builds
// (0.15.13-dev.2 < 0.15.13). Anything else -> null.
function versionKey(v) {
  const m = /^(\d+)\.(\d+)\.(\d+)(?:-dev\.(\d+))?$/.exec(String(v || ''))
  return m ? [+m[1], +m[2], +m[3], m[4] === undefined ? Infinity : +m[4]] : null
}
const isDevVersion = (v) => /-dev\.\d+$/.test(String(v || ''))
// What people see: 0.15.43-dev.1 -> "0.15.43 Dev" (Marcy 2026-10-18: the dev number confuses; the
// -dev.N stays in the real version, tags and feeds, where the updater needs it)
const shownVersion = (v) => String(v || '').replace(/-dev\.\d+$/, ' Dev')

// true when a is strictly newer than b; false when either can't be read
function isNewerVersion(a, b) {
  const x = versionKey(a), y = versionKey(b)
  if (!x || !y) return false
  // loop: NOT-WORTH — 4 fixed fields
  for (let i = 0; i < 4; i++) if (x[i] !== y[i]) return x[i] > y[i]
  return false
}

const FILE_RE = /^sonata-\d+\.\d+\.\d+(?:-dev\.\d+)?-x86_64\.AppImage$/

// electron-builder's latest-linux.yml; top-level keys only (the indented per-file block is skipped)
function parseLegacyFeed(text) {
  const grab = (key) => {
    const m = text.match(new RegExp('^' + key + ':\\s*(.+)$', 'm'))
    return m ? m[1].trim().replace(/^'(.*)'$/, '$1') : ''
  }
  const version = grab('version'), file = grab('path'), sha512 = grab('sha512')
  if (!versionKey(version) || isDevVersion(version)) throw new Error('update feed (latest-linux.yml) has no usable version')
  if (!FILE_RE.test(file)) throw new Error('update feed (latest-linux.yml) names an unexpected file: ' + file)
  if (!/^[A-Za-z0-9+/]{86}==$/.test(sha512)) throw new Error('update feed (latest-linux.yml) has no SHA-512')
  return {
    version, file, url: `${DOWNLOAD_PREFIX}v${version}/${file}`,
    hash: { algo: 'sha512', encoding: 'base64', value: sha512 }, size: null, notes: '', signed: false
  }
}

// latest.json / latest-dev.json, after its signature checked out. Every field is
// validated: the download must be this repo's release file for this version,
// and the Stable feed may never carry a development build.
function parseSignedFeed(text, channel, prefix = DOWNLOAD_PREFIX) {
  let f
  // error: PASSES-ON — thrown as the refusal the Updates section shows
  try { f = JSON.parse(text) } catch (e) { throw new Error('update refused: the signed feed is not valid JSON') }
  const bad = (what) => new Error('update refused: the signed feed ' + what)
  if (!f || typeof f !== 'object') throw bad('is empty')
  if (f.channel !== channel) throw bad(`is for the ${f.channel} channel, not ${channel}`)
  if (!versionKey(f.version)) throw bad('has no valid version')
  if (channel === 'stable' && isDevVersion(f.version)) throw bad('offers a development build on Stable')
  if (f.file !== `sonata-${f.version}-x86_64.AppImage`) throw bad('names an unexpected file')
  if (f.url !== `${prefix}v${f.version}/${f.file}`) throw bad('points outside this repository\'s releases')
  if (!/^[0-9a-f]{128}$/.test(f.sha512)) throw bad('has no SHA-512')
  if (!Number.isSafeInteger(f.size) || f.size <= 0) throw bad('has no size')
  return {
    version: f.version, file: f.file, url: f.url, size: f.size,
    hash: { algo: 'sha512', encoding: 'hex', value: f.sha512 },
    notes: typeof f.notes === 'string' ? f.notes : '', notesUrl: typeof f.notes_url === 'string' ? f.notes_url : '', date: f.date || '', signed: true
  }
}

// Test feed (0.15.32, as in the DS5 app): SONATA_UPDATE_FEED=http://127.0.0.1:8765/ points the updater
// at a server on this machine, so a whole update (signature, hash, swap, Back to stable) can be
// exercised before anything is published. Loopback http only, so nothing on the network can stand in
// for GitHub; downloads must then come from the same server. SONATA_UPDATE_PUBKEY (base64 SPKI) adds
// a test key, only together with such a feed, never for the real one. -> null, or the feed's settings
function testFeed(env) {
  const raw = env && env.SONATA_UPDATE_FEED
  if (!raw) return null
  let u
  try { u = new URL(raw) } catch (e) { return null }   // error: NOT-WORTH — not a URL: no test feed
  if (u.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(u.hostname)) return null
  const base = u.href.endsWith('/') ? u.href : u.href + '/'
  const key = typeof env.SONATA_UPDATE_PUBKEY === 'string' && /^[A-Za-z0-9+/=]{40,200}$/.test(env.SONATA_UPDATE_PUBKEY) ? [env.SONATA_UPDATE_PUBKEY] : []
  return { urls: { stable: base + 'latest.json', dev: base + 'latest-dev.json' }, prefix: base, keys: TRUSTED_KEYS.concat(key) }
}

// One check: what the feed for `channel` offers. fetchText(url) -> Promise<string>.
// With only the placeholder key, the old unsigned latest-linux.yml path is used
// for both channels (it only ever lists Stable releases).
async function fetchUpdate({ channel, fetchText, keys = TRUSTED_KEYS, log = () => {}, test = null }) {
  if (channel !== 'dev') channel = 'stable'
  if (test) keys = test.keys
  if (!signingReady(keys)) {
    log('update feed: no signing key in this build yet; using the unsigned latest-linux.yml (Stable only)')
    return parseLegacyFeed(await fetchText(LEGACY_FEED_URL))
  }
  const url = (test ? test.urls : FEED_URLS)[channel]
  const [text, sig] = await Promise.all([fetchText(url), fetchText(url + '.sig')])
  if (!feedSignedBy(text, sig, keys)) throw new Error(`update refused: ${url.split('/').pop()} is not signed by a trusted key`)
  return parseSignedFeed(text, channel, test ? test.prefix : DOWNLOAD_PREFIX)
}

// Throws unless the downloaded file matches the feed's size and hash.
async function verifyDownload(filePath, update) {
  const size = fs.statSync(filePath).size
  if (update.size != null && size !== update.size) {
    throw new Error(`update refused: download is ${size} bytes, the feed says ${update.size}`)
  }
  const h = crypto.createHash(update.hash.algo)
  // loop: SERIAL-REQUIRED — the hash is sequential; stream read of one AppImage (~125 MB) · 64 KB chunks · once per new version · ends at EOF
  // error: PASSES-ON — a read error rejects; the caller deletes the .part file and logs
  for await (const chunk of fs.createReadStream(filePath)) h.update(chunk)
  const digest = h.digest(update.hash.encoding)
  if (digest !== update.hash.value) throw new Error(`update refused: the download's ${update.hash.algo.toUpperCase()} does not match the feed`)
}

module.exports = {
  REPO, FEED_BRANCH, LEGACY_REPO, LEGACY_FEED_BRANCH, FEED_URLS, LEGACY_FEED_URL, DOWNLOAD_PREFIX, feedUrls, downloadPrefix,
  PLACEHOLDER_KEY, TRUSTED_KEYS, FILE_RE,
  signingReady, feedSignedBy, versionKey, isDevVersion, isNewerVersion, shownVersion,
  parseLegacyFeed, parseSignedFeed, fetchUpdate, verifyDownload, testFeed
}
