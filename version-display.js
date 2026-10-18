// How Sonata's versions are shown: the ONE place (Marcy 2026-10-18: "NOTHING should be hardcoded in
// this manner. ESPECIALLY FOR TOASTS"). The source of truth stays package.json's "version" (set by
// tools/set-version.js, never by hand); this file holds the display forms next to it, the way AVIEW's
// version.py does (VERSION_STRING / VERSION_SHORT):
//
//   short('0.15.45-dev.1') -> '0.15.45 Dev'          (people never see the dev number)
//   full('0.15.45-dev.1')  -> 'Sonata 0.15.45 Dev'
//   tagged('0.15.45')      -> 'v0.15.45'             (About's hero line)
//   channelName('dev')     -> 'Development'          ('stable' -> 'Stable')
//   SHORT / FULL / CURRENT                          (this build's own, in main and node only)
//
// The same rule for every version a person reads: Sonata's, an offered update's, the helper engine's,
// a What's new heading. Raw versions stay in data (feeds, file names, logs, User-Agent, cache entries).
// Gate: tools/hardcodes.js (npm run gates, .hooks/pre-commit) fails on a user-facing string built from
// a raw version anywhere else.
//
// Loaded by main and the node-integrated windows with require(), and by the sandboxed pages (panel,
// rail, toasts) as a plain script: SonataVersionDisplay.
;(function (root) {
  'use strict'

  const NAME = 'Sonata'
  const REPO_URL = 'https://github.com/MarcelineVPQ/apple-music-for-linux'
  const CHANNELS = Object.freeze({ stable: 'Stable', dev: 'Development' })

  // '0.15.45-dev.1' | 'v0.15.45-dev.1' -> '0.15.45 Dev'; '0.15.45' stays; '' stays ''
  const short = (v) => String(v == null ? '' : v).trim().replace(/^v(?=\d)/, '').replace(/-dev(\.\d+)?$/, ' Dev')
  const full = (v) => (short(v) ? NAME + ' ' + short(v) : NAME)
  const tagged = (v) => (short(v) ? 'v' + short(v) : '')
  const channelName = (ch) => (ch === 'dev' ? CHANNELS.dev : CHANNELS.stable)
  // the User-Agent Sonata sends (servers read the exact version: raw on purpose)
  const userAgent = (v) => NAME + '/' + (String(v || '') || '0') + ' (' + REPO_URL + ')'

  // this build's own version: package.json, the source of truth (main and node only; pages are sent it)
  let CURRENT = ''
  if (typeof module === 'object' && module.exports && typeof require === 'function') {
    try { CURRENT = String(require('./package.json').version || '') } catch (e) { /* error: NOT-WORTH — a page without package.json uses the version main sends it */ }
  }

  const api = {
    NAME, REPO_URL, CHANNELS, short, full, tagged, channelName, userAgent,
    CURRENT, SHORT: short(CURRENT), FULL: full(CURRENT)
  }
  if (typeof module === 'object' && module.exports) module.exports = api
  else root.SonataVersionDisplay = Object.freeze(api)
})(typeof globalThis !== 'undefined' ? globalThis : this)
