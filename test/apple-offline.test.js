// main.js: Apple's page failing to load (QC 2026-10 ERROR_PASS E1: offline at start, a blank area with no word and no
// retry): a notice with Try again, the panel opened on it once, a retry by itself, cleared when the page loads.
'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')

const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8')
const fn = (name) => { const at = main.indexOf('function ' + name + '('); return main.slice(at, main.indexOf('\n}\n', at) + 2) }

test('Apple offline at start: shown with Try again, retried, cleared on load', () => {
  const shown = []
  const timers = []
  const calls = []
  const env = {
    APPLE_RETRY_MS: 20000, appleStartUrl: 'https://music.apple.com/us/browse', appleRetryTimer: null, appleFailShown: false,
    settings: { panelPage: 'settings' },
    notices: { show: (n) => shown.push(n), clear: (id) => calls.push('clear ' + id) },
    showPanel: (p) => calls.push('panel ' + p), mainAlive: () => true,
    appleWC: () => ({ getURL: () => 'chrome-error://chromewebdata/', reload: () => calls.push('reload'), loadURL: (u) => { calls.push('load ' + u); return Promise.resolve() } }),
    setTimeout: (f, ms) => { const t = { f, ms }; timers.push(t); return t }, clearTimeout: (t) => { if (t) t.cleared = true }
  }
  const api = new Function('env', 'with (env) { ' + fn('appleLoadFailed') + fn('appleRetry') + fn('appleLoaded') + '; return { appleLoadFailed, appleRetry, appleLoaded } }')(env)   // eslint-disable-line no-new-func
  api.appleLoadFailed(-3, 'ERR_ABORTED', true)
  api.appleLoadFailed(-106, 'ERR_INTERNET_DISCONNECTED', false)
  assert.equal(shown.length, 0, 'an aborted load or a subframe is no failure')
  api.appleLoadFailed(-106, 'ERR_INTERNET_DISCONNECTED', true)
  assert.equal(shown.length, 1)
  assert.match(shown[0].text, /Apple Music didn't load: ERR_INTERNET_DISCONNECTED/)
  assert.deepEqual(shown[0].actions.map((a) => a.id), ['apple-retry'])
  assert.equal(shown[0].task, true)
  assert.deepEqual(calls, ['panel settings'])
  timers[0].f()                                        // the retry by itself
  assert.deepEqual(calls.slice(-1), ['load https://music.apple.com/us/browse'])
  api.appleLoadFailed(-106, 'ERR_INTERNET_DISCONNECTED', true)
  assert.equal(calls.filter((c) => c.startsWith('panel')).length, 1, 'the panel opens once per failing spell')
  api.appleLoaded()
  assert.ok(timers[1].cleared)
  assert.deepEqual(calls.slice(-1), ['clear apple-offline'])
  assert.match(main, /case 'apple-retry': appleRetry\(\); break/)
  assert.match(main, /appleWC\(\)\.on\('did-fail-load', \(e, code, desc, url, isMain\) => appleLoadFailed\(code, desc, isMain\)\)/)
})

// QC 2026-10 ERROR_PASS E2/E3: an unwritable config folder made Connect do nothing
test('Last.fm / Discord Connect: a config file that can\'t be written is shown', async () => {
  const shown = []
  const env = {
    INTEGRATIONS: { page: 'settings', section: 'integrations' }, discordConfigPath: '/ro/discord.json', discordConfig: {},
    showPanel () {}, loadDiscordConfig () {}, notices: { show: (n) => shown.push(n), clear () {} },
    saveDiscordConfig: () => { throw Object.assign(new Error('read-only file system'), { code: 'EROFS' }) },
    lastfm: { configured: false, configPath: '/ro/lastfm.json', writeTemplate: () => { throw Object.assign(new Error('permission denied'), { code: 'EACCES' }) } }
  }
  const api = new Function('env', 'with (env) { ' + fn('configNotWritten') + main.slice(main.indexOf('async function connectDiscord('), main.indexOf('\n}\n', main.indexOf('async function connectDiscord(')) + 2) +
    main.slice(main.indexOf('async function connectLastFm('), main.indexOf('\n}\n', main.indexOf('async function connectLastFm(')) + 2) + '; return { connectDiscord, connectLastFm } }')(env)   // eslint-disable-line no-new-func
  await api.connectDiscord()
  await api.connectLastFm()
  assert.deepEqual(shown.map((n) => [n.id, n.kind]), [['discord', 'error'], ['lastfm', 'error']])
  assert.match(shown[0].text, /Discord can't be set up: its settings file couldn't be written \(EROFS\)/)
  assert.match(shown[1].detail, /\/ro\/lastfm\.json/)
})
