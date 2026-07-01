const crypto = require('crypto')
const fs = require('fs')

const API_ROOT = 'https://ws.audioscrobbler.com/2.0/'

// Last.fm scrobbling client. Credentials live in a JSON config file:
// { "apiKey": "...", "apiSecret": "...", "sessionKey": "...", "username": "..." }
// apiKey/apiSecret come from the user's own https://www.last.fm/api/account/create
class LastFm {
  constructor(configPath) {
    this.configPath = configPath
    this.pendingToken = null
    try {
      this.config = JSON.parse(fs.readFileSync(configPath, 'utf8'))
    } catch (e) {
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

  async scrobble(track, startedAt) {
    const params = {
      artist: track.artist,
      track: track.title,
      timestamp: startedAt,
      sk: this.config.sessionKey
    }
    if (track.album) params.album = track.album
    if (track.duration) params.duration = Math.round(track.duration)
    await this.call('track.scrobble', params, true)
  }
}

module.exports = { LastFm }
