// The engine feed: which Precise timing helper (the Sonata engine) is newest, independent of Sonata's
// own releases. No Electron, tested with node --test (test/engine-feed.test.js).
//
// The engine's release workflow writes latest-engine.json (Stable) and latest-engine-dev.json
// (Development) on MarcelineVPQ/sonata-releases main and signs each file's exact bytes with the
// engine's Ed25519 key (the key in align/engine.json, engine-key.pub there), the signature beside it as
// <file>.sig (base64): the same scheme as Sonata's own feeds (update-feed.js). Fields:
//   { channel: "stable" | "dev", name?, version: "X.Y.Z" or "X.Y.Z-dev.N" (Development only), tag?, prerelease?,
//     protocol: 2, python: "3.14", platform?: "linux-x86_64", file: "sonata-engine-<version>-linux-x86_64.tar.gz",
//     url: "<releases>/engine-v<version>/<file>", size, sha256, sig? (the download's own signature, base64, or
//     "<url>.sig"), key? (must be the trusted key), licence?: { version, sha256 } (the EULA's), released?,
//     notes_url?, min_sonata? / max_sonata?: "X.Y.Z" }   (the live Development feed since 2026-10-18)
// Compatibility, not an exact pin: an engine is accepted when its protocol is one this Sonata installs
// (INSTALL_PROTOCOLS), it is at least align/engine.json's version (the minimum) and this Sonata is inside
// its min/max range. Offered only when newer than the active engine (never a downgrade). The download
// itself is still checked by align/install.sh (size, SHA-256, signature by the same key).
const { feedSignedBy, versionKey, isNewerVersion } = require('./update-feed')

const REPO = 'MarcelineVPQ/sonata-releases'
const ENGINE_FEED_URLS = {
  stable: `https://raw.githubusercontent.com/${REPO}/main/latest-engine.json`,
  dev: `https://raw.githubusercontent.com/${REPO}/main/latest-engine-dev.json`
}
const ENGINE_DOWNLOAD_PREFIX = `https://github.com/${REPO}/releases/download/`
// the helper protocols this Sonata installs (align/install.sh PROTOCOLS; it still talks to protocol 1
// helpers already installed, align-helper.js PROTOCOLS)
const INSTALL_PROTOCOLS = [2]
const ENGINE_VERSION_RE = /^\d+\.\d+\.\d+(?:-dev\.\d+)?$/
const isDevEngine = (v) => /-dev\.\d+$/.test(String(v || ''))

const bad = (what) => Object.assign(new Error('helper update refused: the engine feed ' + what), { code: 'feed' })
// loop: NOT-WORTH — ≤ 5 field names, once per feed read
const pick = (f, ...names) => { for (const n of names) if (f[n] !== undefined && f[n] !== null) return f[n]; return undefined }

/** latest-engine(-dev).json after its signature checked out: every field validated. -> the offer */
function parseEngineFeed(text, channel, prefix = ENGINE_DOWNLOAD_PREFIX, keys = null) {
  let f
  // error: PASSES-ON — thrown as the refusal Settings → Precise timing logs
  try { f = JSON.parse(text) } catch (e) { throw bad('is not valid JSON') }
  if (!f || typeof f !== 'object' || Array.isArray(f)) throw bad('is empty')
  if (f.channel !== undefined && f.channel !== channel) throw bad(`is for the ${f.channel} channel, not ${channel}`)
  if (!ENGINE_VERSION_RE.test(String(f.version || ''))) throw bad('has no valid version')
  // a development engine only on Sonata's Development channel; X.Y.Z on both
  if (channel !== 'dev' && isDevEngine(f.version)) throw bad('offers a development engine on Stable')
  if (f.platform !== undefined && f.platform !== 'linux-x86_64') throw bad('is for another platform (' + f.platform + ')')
  if (f.tag !== undefined && f.tag !== 'engine-v' + f.version) throw bad('names another tag')   // hardcode: OK — the release tag the feed must name
  if (f.key !== undefined && keys && !keys.includes(f.key)) throw bad('names another signing key')
  if (!Number.isInteger(f.protocol)) throw bad('has no protocol')
  if (!/^3\.\d{1,2}$/.test(String(f.python || ''))) throw bad('has no Python version')
  const file = `sonata-engine-${f.version}-linux-x86_64.tar.gz`   // hardcode: OK — the release file's name
  if (f.file !== undefined && f.file !== file) throw bad('names an unexpected file')
  const url = `${prefix}engine-v${f.version}/${file}`   // hardcode: OK — the download URL
  if (f.url !== url) throw bad('points outside the engine releases')
  // sig: the download's signature itself (base64, 64 bytes; install.sh checks the .sig file beside the
  // download with the same key) or the address of that file
  const sig = pick(f, 'sig', 'sig_url', 'sigUrl')
  if (sig !== undefined && sig !== url + '.sig' && !(typeof sig === 'string' && /^[A-Za-z0-9+/]{86}==$/.test(sig))) throw bad('has a bad signature field')
  if (!/^[0-9a-f]{64}$/.test(String(f.sha256 || ''))) throw bad('has no SHA-256')
  if (!Number.isSafeInteger(f.size) || f.size <= 0 || f.size > 512 * 1024 * 1024) throw bad('has no size')
  // the licence: { version, sha256 } (the EULA's SHA-256: install.sh's must match it); a plain string = version
  let licence = pick(f, 'licence', 'license')
  if (typeof licence === 'string') licence = { version: licence }
  if (licence !== undefined) {
    if (!licence || typeof licence !== 'object' || Array.isArray(licence)) throw bad('has a bad licence field')
    if (licence.version !== undefined && (typeof licence.version !== 'string' || !/^[\w.+-]{1,40}$/.test(licence.version))) throw bad('has a bad licence version')
    if (licence.sha256 !== undefined && !/^[0-9a-f]{64}$/.test(String(licence.sha256))) throw bad('has a bad licence SHA-256')
  }
  const minSonata = pick(f, 'min_sonata', 'minSonata')
  const maxSonata = pick(f, 'max_sonata', 'maxSonata')
  if (minSonata !== undefined && !versionKey(minSonata)) throw bad('has a bad min_sonata')
  if (maxSonata !== undefined && !versionKey(maxSonata)) throw bad('has a bad max_sonata')
  return {
    version: f.version, protocol: f.protocol, python: f.python, file, url, size: f.size, sha256: f.sha256,
    licence: { version: (licence && licence.version) || '', sha256: (licence && licence.sha256) || '' }, prerelease: f.prerelease === true,
    notesUrl: typeof f.notes_url === 'string' && /^https:\/\//.test(f.notes_url) ? f.notes_url.slice(0, 300) : '', minSonata: minSonata || '', maxSonata: maxSonata || '',
    notes: typeof f.notes === 'string' ? f.notes.slice(0, 2000) : '', date: String(f.released || f.date || '').slice(0, 40)
  }
}

/**
 * Whether this Sonata may install `offer`: '' when it may, else why not (said in Settings).
 * ctx: { appVersion, min (align/engine.json's version), protocols? }
 */
function incompatible(offer, ctx) {
  const protocols = (ctx && ctx.protocols) || INSTALL_PROTOCOLS
  if (!protocols.includes(offer.protocol)) return 'needs a newer Sonata (it speaks helper protocol ' + offer.protocol + ')'
  if (ctx && ctx.min && isNewerVersion(ctx.min, offer.version)) return 'is older than ' + ctx.min + ', the oldest this Sonata runs'
  const app = ctx && ctx.appVersion
  if (app && offer.minSonata && isNewerVersion(offer.minSonata, app.replace(/-dev\.\d+$/, ''))) return 'needs Sonata ' + offer.minSonata + ' or newer'
  if (app && offer.maxSonata && isNewerVersion(app.replace(/-dev\.\d+$/, ''), offer.maxSonata)) return 'is for Sonata up to ' + offer.maxSonata
  return ''
}

/**
 * What the feed means for this install. active: the engine version running ('' when none).
 * -> { state: 'available' | 'current' | 'incompatible', offer, why }
 *   available     newer than the active engine and compatible: Settings offers Update
 *   current       not newer (the same, or older: never a downgrade)
 *   incompatible  newer, but this Sonata can't take it (why)
 */
function judgeOffer(offer, active, ctx) {
  if (!offer) return { state: 'current', offer: null, why: '' }
  if (active && !isNewerVersion(offer.version, active)) return { state: 'current', offer, why: '' }
  const why = incompatible(offer, ctx)
  return why ? { state: 'incompatible', offer, why } : { state: 'available', offer, why: '' }
}

/** The pin file align/install.sh --pin reads (engine.json's form, one key per line), for `offer`. */
function pinText(offer, key) {
  return JSON.stringify({
    version: offer.version, protocol: offer.protocol, python: offer.python, file: offer.file,
    // hardcode: OK — the download URL (the release tag), never shown
    url: ENGINE_DOWNLOAD_PREFIX + 'engine-v' + offer.version + '/' + offer.file, size: offer.size, sha256: offer.sha256, key
  }, null, 2) + '\n'
}

// Test feed (as update-feed.js testFeed): SONATA_ENGINE_FEED=http://127.0.0.1:PORT/ serves
// latest-engine(-dev).json(.sig) and the engine files under engine-vX.Y.Z/ from this machine, so the
// whole update can run before anything is published. Loopback http only; SONATA_ENGINE_PUBKEY adds a
// test key for the feed only (install.sh still checks the download against engine.json's key).
function testEngineFeed(env) {
  const raw = env && env.SONATA_ENGINE_FEED
  if (!raw) return null
  let u
  try { u = new URL(raw) } catch (e) { return null }   // error: NOT-WORTH — not a URL: no test feed
  if (u.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(u.hostname)) return null
  const base = u.href.endsWith('/') ? u.href : u.href + '/'
  const key = typeof env.SONATA_ENGINE_PUBKEY === 'string' && /^[A-Za-z0-9+/=]{40,200}$/.test(env.SONATA_ENGINE_PUBKEY) ? [env.SONATA_ENGINE_PUBKEY] : []
  return { urls: { stable: base + 'latest-engine.json', dev: base + 'latest-engine-dev.json' }, prefix: base, keys: key }
}

/**
 * One check of the engine feed for `channel` ('stable' | 'dev'). fetchText(url) -> Promise<string>.
 * keys: the trusted engine key(s) (align/engine.json's). -> the offer (parseEngineFeed), signature checked.
 * A missing Development feed falls back to the Stable one.
 */
async function fetchEngineFeed({ channel, fetchText, keys, test = null }) {
  if (channel !== 'dev') channel = 'stable'
  const trusted = (keys || []).concat(test ? test.keys : [])
  if (!trusted.length) throw bad('has no key to check it with')
  const urls = test ? test.urls : ENGINE_FEED_URLS
  const read = async (ch) => {
    const url = urls[ch]
    const [text, sig] = await Promise.all([fetchText(url), fetchText(url + '.sig')])
    if (!feedSignedBy(text, sig, trusted)) throw bad(`(${url.split('/').pop()}) is not signed by the engine key`)
    return parseEngineFeed(text, ch, test ? test.prefix : ENGINE_DOWNLOAD_PREFIX, test ? null : trusted)
  }
  // no Stable feed published (404): no stable engine yet, nothing offered
  // error: PASSES-ON — any other error passes on (main logs it)
  if (channel === 'stable') { try { return await read('stable') } catch (e) { if (/\b404\b/.test(e.message)) return null; throw e } }
  // error: PASSES-ON — a Development feed that can't be read (none published yet): the Stable one, whose errors pass on
  try { return await read('dev') } catch (e) { if (e.code === 'feed') throw e; return fetchEngineFeed({ channel: 'stable', fetchText, keys, test }) }
}

module.exports = { isDevEngine, REPO, ENGINE_FEED_URLS, ENGINE_DOWNLOAD_PREFIX, INSTALL_PROTOCOLS, parseEngineFeed, incompatible, judgeOffer, pinText, testEngineFeed, fetchEngineFeed }
