const crypto = require('crypto')
const fs = require('fs')

const API_ROOT = 'https://ws.audioscrobbler.com/2.0/'

// Last.fm scrobbling client. Credentials live in a JSON config file:
// { "apiKey": "...", "apiSecret": "...", "sessionKey": "...", "username": "..." }
// apiKey/apiSecret come from the user's own https://www.last.fm/api/account/create
// loop: none · lifetime: no timers or listeners; one fetch per now-playing update / scrobble send,
// called from main.js's 5 s now-playing loop only when connected
class LastFm {
  constructor(configPath) {
    this.configPath = configPath
    this.pendingToken = null
    try {
      this.config = JSON.parse(fs.readFileSync(configPath, 'utf8'))
    } catch (e) {
      // error: NOT-WORTH — no file yet (or unreadable): not configured; Connect in Settings says what to do
      this.config = {}
    }
  }

  save() {
    fs.writeFileSync(this.configPath, JSON.stringify(this.config, null, 2) + '\n')
  }

  get configured() {
    return !!(this.config.apiKey && this.config.apiSecret)
  }

  get connected() {
    return this.configured && !!this.config.sessionKey
  }

  get username() {
    return this.config.username || ''
  }

  writeTemplate() {
    this.config = { apiKey: '', apiSecret: '', ...this.config }
    this.save()
  }

  sign(params) {
    const base = Object.keys(params).sort().map((k) => k + params[k]).join('')
    return crypto.createHash('md5').update(base + this.config.apiSecret, 'utf8').digest('hex')
  }

  async call(method, params, post) {
    const p = { method, api_key: this.config.apiKey, ...params }
    p.api_sig = this.sign(p)
    p.format = 'json' // not part of the signature
    const body = new URLSearchParams(p)
    const res = post
      ? await fetch(API_ROOT, { method: 'POST', body })
      : await fetch(API_ROOT + '?' + body)
    const json = await res.json()
    if (json.error) {
      throw new Error(`last.fm error ${json.error}: ${json.message}`)
    }
    return json
  }

  async startAuth() {
    const r = await this.call('auth.getToken', {})
    this.pendingToken = r.token
    return `https://www.last.fm/api/auth/?api_key=${this.config.apiKey}&token=${r.token}`
  }

  async finishAuth() {
    const r = await this.call('auth.getSession', { token: this.pendingToken })
    this.pendingToken = null
    this.config.sessionKey = r.session.key
    this.config.username = r.session.name
    this.save()
  }

  disconnect() {
    delete this.config.sessionKey
    delete this.config.username
    this.save()
  }

  async updateNowPlaying(track) {
    const params = { artist: track.artist, track: track.title, sk: this.config.sessionKey }
    if (track.album) params.album = track.album
    if (track.duration) params.duration = Math.round(track.duration)
    await this.call('track.updateNowPlaying', params, true)
  }

  // Up to 50 scrobbles in one call (Last.fm's batch form: artist[i], track[i], timestamp[i], …).
  // Resolves to { accepted, ignored }; throws on a network or Last.fm error (the queue retries).
  async scrobbleBatch(entries) {
    const params = { sk: this.config.sessionKey }
    // loop: NOT-WORTH — ≤ 50 entries (BATCH), once per scrobble send
    entries.forEach((e, i) => {
      params['artist[' + i + ']'] = e.artist
      params['track[' + i + ']'] = e.title
      params['timestamp[' + i + ']'] = e.timestamp
      if (e.album) params['album[' + i + ']'] = e.album
      if (e.duration) params['duration[' + i + ']'] = Math.round(e.duration)
    })
    const r = await this.call('track.scrobble', params, true)
    const attr = (r && r.scrobbles && r.scrobbles['@attr']) || {}
    return { accepted: Number(attr.accepted) || 0, ignored: Number(attr.ignored) || 0 }
  }
}

// --- scrobbles waiting to be sent (pure: I/O injected, so it is tested without Electron or network) ---
// A scrobble is queued the moment it is earned and leaves the queue only when Last.fm has answered
// it, so a failed send (offline, Last.fm down, rate limit) is sent again later instead of lost. The
// queue is kept on disk (deps.save), so scrobbles waiting at quit go out after the next start.
//   Backoff: 30 s, 1, 2, 5, 10, then every 30 min, while sends keep failing; any success resets it.
//   Last.fm takes scrobbles up to 14 days old: older ones are dropped (and logged), never sent.
//   No double scrobbles: one send at a time; a song is queued once (artist + title + start time).
//   Bounded: at most QUEUE_MAX waiting (oldest dropped first), sent BATCH at a time.
const SCROBBLE_MAX_AGE_S = 14 * 24 * 3600
const AGE_MARGIN_S = 3600                    // an hour short of 14 days, so a send in flight isn't refused
const QUEUE_MAX = 500
const BATCH = 50
const BACKOFF_S = [30, 60, 120, 300, 600, 1800]

const entryKey = (e) => e.artist + '\n' + e.title + '\n' + e.timestamp
function validEntry(e) {
  return !!(e && typeof e.artist === 'string' && typeof e.title === 'string' && e.title &&
    Number.isFinite(e.timestamp) && e.timestamp > 0)
}
function cleanEntry(e) {
  const out = { artist: e.artist, title: e.title, timestamp: Math.floor(e.timestamp) }
  if (typeof e.album === 'string' && e.album) out.album = e.album
  if (Number.isFinite(e.duration) && e.duration > 0) out.duration = e.duration
  return out
}

/**
 * deps: { send(entries) -> Promise<{ accepted, ignored }>, load() -> array, save(array),
 *         now() -> ms (Date.now), log(msg) }
 * -> { add(track, startedAt), tick() -> Promise, pending(), nextAt() }
 */
function createScrobbleQueue(deps) {
  const now = deps.now || Date.now
  const log = deps.log || (() => {})
  let queue = []
  let busy = false
  let failures = 0
  let nextAt = 0
  const seen = new Set()

  // lifetime: OK — the queue is bounded (QUEUE_MAX) and lives for the app's life; no timers: main.js's
  // 5 s now-playing loop calls tick()
  function keep(list) {
    queue = list
    seen.clear()
    // loop: NOT-WORTH — ≤ QUEUE_MAX entries, on load and after each change
    for (const e of queue) seen.add(entryKey(e))
  }
  function persist() {
    try { deps.save(queue.slice()) } catch (e) { log('last.fm: pending scrobbles not saved: ' + e.message) }   // error: LOGGED-OK — still queued in memory and sent this session; only a quit before then loses them
  }
  function dropExpired() {
    const oldest = now() / 1000 - (SCROBBLE_MAX_AGE_S - AGE_MARGIN_S)
    const fresh = queue.filter((e) => e.timestamp >= oldest)
    if (fresh.length === queue.length) return false
    log('last.fm: ' + (queue.length - fresh.length) + ' scrobble(s) older than 14 days dropped (Last.fm no longer takes them)')
    keep(fresh)
    return true
  }

  let loaded = []
  try { loaded = deps.load ? deps.load() : [] } catch (e) { loaded = [] }   // error: NOT-WORTH — no file yet (or unreadable): nothing waiting
  const unique = []
  const keys = new Set()
  // loop: NOT-WORTH — the saved queue (≤ QUEUE_MAX), once at start
  for (const e of Array.isArray(loaded) ? loaded : []) {
    if (!validEntry(e) || keys.has(entryKey(e))) continue
    keys.add(entryKey(e))
    unique.push(cleanEntry(e))
  }
  keep(unique.slice(-QUEUE_MAX))
  if (dropExpired() || unique.length !== (Array.isArray(loaded) ? loaded.length : 0)) persist()

  function add(track, startedAt) {
    const e = { artist: track.artist || '', title: track.title || '', album: track.album, duration: track.duration, timestamp: startedAt }
    if (!validEntry(e)) return false
    const entry = cleanEntry(e)
    if (seen.has(entryKey(entry))) return false
    keep(queue.concat([entry]).slice(-QUEUE_MAX))
    persist()
    if (!busy) nextAt = 0          // a new scrobble goes out on the next tick, even during a backoff
    return true
  }

  async function tick() {
    if (busy || !queue.length || now() < nextAt) return
    if (dropExpired()) persist()
    if (!queue.length) return
    busy = true
    const batch = queue.slice(0, BATCH)
    try {
      const r = await deps.send(batch)
      const sent = new Set(batch.map(entryKey))
      keep(queue.filter((e) => !sent.has(entryKey(e))))
      persist()
      failures = 0
      nextAt = 0
      if (r && r.ignored) log('last.fm: ' + r.ignored + ' of ' + batch.length + ' scrobble(s) ignored by Last.fm')
    } catch (e) {
      // error: LOGGED-OK — the scrobbles stay queued (on disk too) and are sent again after a backoff
      failures++
      const wait = BACKOFF_S[Math.min(failures - 1, BACKOFF_S.length - 1)]
      nextAt = now() + wait * 1000
      log('last.fm scrobble failed (' + queue.length + ' waiting, next try in ' + wait + ' s): ' + e.message)
    } finally {
      busy = false
    }
  }

  return { add, tick, pending: () => queue.length, nextAt: () => nextAt }
}

module.exports = { LastFm, createScrobbleQueue, SCROBBLE_MAX_AGE_S, QUEUE_MAX, BATCH, BACKOFF_S }
