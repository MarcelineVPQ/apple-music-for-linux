// Look-ahead play's ears in Apple's page (lookahead.js; docs/LOOKAHEAD.md). Two small page scripts,
// injected by main only while look-ahead runs:
//
// - mainWorld(): in Apple's main world (MusicKit lives there). On MusicKit's nowPlayingItemDidChange it
//   tells the isolated world what the new item is (kind, title, artist, ISRC, length) and whether the old
//   one ended by itself (its last position within END_S of its length). When main has asked it to
//   (window.__sonataLaHold: the playing song is delayed), it holds the player at a natural item change,
//   so the delayed song's last seconds can play out before a song with a shorter delay starts. The news
//   goes through a DOM attribute + a plain event: the two worlds share the DOM, not their objects.
// - isolatedWorld(): in Sonata's isolated world (999, where the focus bridge is). It forwards the media
//   element's own pause / play / playing / seeking / seeked / emptied events (trusted ones only: Apple's
//   scripts can't fake them) and the main world's item news to main through sonataFocusBridge.lookahead.
//   main checks every field again (lookahead.js cleanEvent).
//
// Idle cost: none (event listeners only; nothing runs while nothing plays). Pure strings for main:
// mainWorldScript(), isolatedWorldScript().
'use strict'

const END_S = 1.5

// lifetime: OK — two capture listeners and one MusicKit listener, added once per page load (a guard on the
// document), gone with the document; one retry timer chain while MusicKit isn't configured (≤ 60 s)
function mainWorld(endS) {
  if (document.__sonataLookahead) return false
  document.__sonataLookahead = true
  let lastPos = 0
  let lastDur = 0
  const send = (o) => {
    /* error: NOT-WORTH — a page without a document element can't be told; the next event tries again */
    try {
      document.documentElement.setAttribute('data-sonata-la', JSON.stringify(o))
      document.dispatchEvent(new Event('sonata-la'))
    } catch (e) {}
  }
  const remember = () => {
    /* error: NOT-WORTH — no MusicKit yet: nothing to remember */
    try {
      const mk = window.MusicKit.getInstance()
      const it = mk.nowPlayingItem
      lastPos = mk.currentPlaybackTime || 0
      lastDur = it && it.attributes && it.attributes.durationInMillis ? it.attributes.durationInMillis / 1000 : 0
    } catch (e) {}
  }
  /* lifetime: OK — capture listeners on Apple's document, once per page load (the guard above), gone with it */
  document.addEventListener('timeupdate', remember, true)
  document.addEventListener('ended', () => { lastPos = lastDur }, true)
  const hook = (mk) => {
    /* lifetime: OK — one MusicKit listener per page load (its instance lives as long as the page) */
    mk.addEventListener('nowPlayingItemDidChange', () => {
      const it = mk.nowPlayingItem
      const a = (it && it.attributes) || {}
      const natural = lastDur > 0 && lastPos >= lastDur - endS
      const kind = String((it && it.type) || (a.playParams && a.playParams.kind) || '')
      const held = !!(window.__sonataLaHold && natural)
      send({ ev: 'item', natural, held, kind, title: a.name || '', artist: a.artistName || '', isrc: String(a.isrc || ''), duration: a.durationInMillis ? a.durationInMillis / 1000 : 0, id: String((it && it.id) || '') })
      /* error: NOT-WORTH — a pause MusicKit refuses: the helper's gate drops the new song's audio until main plays it from its start */
      if (held) { try { mk.pause() } catch (e) {} }
      lastPos = 0
      lastDur = 0
    })
  }
  /* loop: SERIAL-REQUIRED — retry until MusicKit is configured · every 500 ms · at most 120 tries (60 s) · stops when hooked */
  const wait = (n) => {
    let mk = null
    /* error: NOT-WORTH — MusicKit not configured yet: tried again */
    try { mk = window.MusicKit && window.MusicKit.getInstance() } catch (e) {}
    if (mk) { hook(mk); return }
    if (n < 120) setTimeout(() => wait(n + 1), 500)
  }
  wait(0)
  return true
}

// lifetime: OK — seven capture listeners on Apple's document, added once per page load (a guard), gone with it
function isolatedWorld() {
  if (globalThis.__sonataLaAttached) return false
  globalThis.__sonataLaAttached = true
  const bridge = globalThis.sonataFocusBridge
  if (!bridge || !bridge.lookahead) return false
  const media = (e) => {
    if (!e.isTrusted || !(e.target instanceof HTMLMediaElement)) return
    // ended: the pause a media element fires when it plays to its end (before 'ended'), not the user's
    bridge.lookahead({ ev: e.type, t: e.target.currentTime, video: e.target instanceof HTMLVideoElement, ended: !!e.target.ended })
  }
  /* loop: NOT-WORTH — six event names, once per page load */
  for (const ev of ['pause', 'play', 'playing', 'seeking', 'seeked', 'emptied']) document.addEventListener(ev, media, true)
  document.addEventListener('sonata-la', () => {
    /* error: NOT-WORTH — news that isn't JSON is dropped */
    try { bridge.lookahead(JSON.parse(document.documentElement.getAttribute('data-sonata-la') || 'null')) } catch (e) {}
  })
  return true
}

function mainWorldScript() { return '(' + mainWorld.toString() + ')(' + END_S + ')' }
function isolatedWorldScript() { return '(' + isolatedWorld.toString() + ')()' }
/** Main's hold flag in Apple's main world: the playing song is delayed. */
function holdScript(on) { return 'window.__sonataLaHold = ' + (on ? 'true' : 'false') + ';' }

module.exports = { END_S, mainWorld, isolatedWorld, mainWorldScript, isolatedWorldScript, holdScript }
