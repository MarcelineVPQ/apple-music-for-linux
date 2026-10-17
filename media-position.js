// The song's length and position for the desktop's media controls (MPRIS on Linux, the system media
// controls elsewhere). Chromium already publishes Apple's page as a media player through the page's
// Media Session; its track length and position come from the playing element, which in Apple's web
// player has no usable duration, so the widgets showed no length or progress. Sonata declares them
// from MusicKit with navigator.mediaSession.setPositionState, in Apple's page (main world: MusicKit
// lives there), whenever the element plays, pauses, seeks or changes track, and when the position
// drifts from what was declared. Chromium then sets mpris:length and Position and sends Seeked on a
// seek. Pure parts (positionState, drifted) are tested; pageScript() is the text main.js runs in the page.
'use strict'

// -> { duration, position, playbackRate } for setPositionState, or null when there's no song length.
// i: { duration (s, from MusicKit), mkTime (MusicKit's time), elTime (the element's), rate, }
// The element's time is used only when it agrees with MusicKit's (as nowPlayingScript does).
function positionState(i) {
  const duration = Number(i && i.duration)
  if (!Number.isFinite(duration) || duration <= 0) return null
  const mk = Number(i.mkTime) || 0
  const el = Number(i.elTime)
  const t = Number.isFinite(el) && el > 0 && Math.abs(el - mk) < 1.5 ? el : mk
  const rate = Number(i.rate)
  return { duration, position: Math.min(Math.max(0, t), duration), playbackRate: Number.isFinite(rate) && rate > 0 ? rate : 1 }
}

// a new declaration is needed: none yet, another length, another rate, playing changed, or the
// position is more than 1 s from where the last one says it should be by now
function drifted(last, next, playing, now) {
  if (!next) return false
  if (!last) return true
  if (last.duration !== next.duration || last.playbackRate !== next.playbackRate || last.playing !== playing) return true
  const expected = last.position + (playing ? (now - last.at) / 1000 * last.playbackRate : 0)
  return Math.abs(expected - next.position) > 1
}

// Runs in Apple's page (its main world). Self-contained: only its arguments and page globals.
// lifetime: OK — seven capture listeners on Apple's document, added once per page load (a guard on the
// document), gone with the document; no timers
function attach(positionState, drifted) {
  if (document.__sonataPosition) return false
  document.__sonataPosition = true
  let last = null
  const declare = (force) => {
    try {
      const mk = window.MusicKit && window.MusicKit.getInstance && window.MusicKit.getInstance()
      const item = mk && mk.nowPlayingItem
      const ms = item && item.attributes && item.attributes.durationInMillis
      const el = document.getElementById('apple-music-player') || document.querySelector('audio')
      const next = positionState({ duration: ms ? ms / 1000 : 0, mkTime: mk ? mk.currentPlaybackTime : 0, elTime: el ? el.currentTime : NaN, rate: el ? el.playbackRate : 1 })
      if (!next) return
      const playing = !!mk.isPlaying
      const now = Date.now()
      if (!force && !drifted(last, next, playing, now)) return
      navigator.mediaSession.playbackState = playing ? 'playing' : 'paused'
      navigator.mediaSession.setPositionState(next)
      last = Object.assign({ playing, at: now }, next)
    } catch (e) { /* error: NOT-WORTH — no MusicKit or no song yet: the controls keep what they had until the next event */ }
  }
  // media events don't bubble: listened to in the capture phase, so any player element counts
  // loop: NOT-WORTH — six event names, once per page load
  for (const ev of ['play', 'pause', 'seeked', 'ratechange', 'durationchange', 'loadedmetadata']) document.addEventListener(ev, () => declare(true), true)
  // timeupdate (~4/s while playing): only a track change or a drift of over 1 s declares again
  document.addEventListener('timeupdate', () => declare(false), true)
  declare(true)
  return true
}

function pageScript() {
  return '(' + attach.toString() + ')(' + positionState.toString() + ', ' + drifted.toString() + ')'
}

module.exports = { positionState, drifted, pageScript, attach }
