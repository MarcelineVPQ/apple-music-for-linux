// media-position.js: the song's length and position for the desktop's media controls (MPRIS length,
// Position, Seeked), declared from MusicKit in Apple's page
const test = require('node:test')
const assert = require('node:assert/strict')
const vm = require('vm')
const fs = require('fs')
const path = require('path')
const M = require('../media-position')

test('positionState: MusicKit length, the element\'s time when it agrees, clamped, rate never 0', () => {
  assert.deepEqual(M.positionState({ duration: 200, mkTime: 12, elTime: 12.4, rate: 1 }), { duration: 200, position: 12.4, playbackRate: 1 })
  assert.equal(M.positionState({ duration: 200, mkTime: 12, elTime: 80, rate: 1 }).position, 12)   // a stray element never wins
  assert.equal(M.positionState({ duration: 200, mkTime: 230, elTime: NaN }).position, 200)
  assert.equal(M.positionState({ duration: 200, mkTime: -3 }).position, 0)
  assert.equal(M.positionState({ duration: 200, mkTime: 1, rate: 0 }).playbackRate, 1)
  for (const d of [0, NaN, Infinity, undefined, -1]) assert.equal(M.positionState({ duration: d, mkTime: 1 }), null)
})

test('drifted: first time, a new song or state, or more than 1 s off', () => {
  const next = { duration: 200, position: 15, playbackRate: 1 }
  assert.equal(M.drifted(null, next, true, 0), true)
  assert.equal(M.drifted(null, null, true, 0), false)
  const last = { duration: 200, position: 10, playbackRate: 1, playing: true, at: 0 }
  assert.equal(M.drifted(last, next, true, 5000), false)            // 10 s + 5 s played = 15 s
  assert.equal(M.drifted(last, next, true, 2000), true)             // a seek forward
  assert.equal(M.drifted(last, Object.assign({}, next, { duration: 180 }), true, 5000), true)   // a new song
  assert.equal(M.drifted(last, next, false, 5000), true)            // paused
  assert.equal(M.drifted(Object.assign({}, last, { playing: false }), { duration: 200, position: 10.5, playbackRate: 1 }, false, 9000), false)
})

function fakePage() {
  const listeners = {}
  const declared = []
  const el = { currentTime: 10, playbackRate: 1 }
  const mk = { isPlaying: true, currentPlaybackTime: 10, nowPlayingItem: { attributes: { durationInMillis: 200000 } } }
  const document = {
    getElementById: (id) => (id === 'apple-music-player' ? el : null),
    querySelector: () => null,
    addEventListener: (ev, f, capture) => { assert.equal(capture, true); (listeners[ev] = listeners[ev] || []).push(f) }
  }
  const navigator = { mediaSession: { playbackState: 'none', setPositionState: (s) => declared.push(Object.assign({ state: navigator.mediaSession.playbackState }, s)) } }
  const now = { t: 1000 }
  const ctx = { document, navigator, window: { MusicKit: { getInstance: () => mk } }, Date: { now: () => now.t }, Math, Number, Object }
  const fire = (ev) => (listeners[ev] || []).forEach((f) => f())
  return { ctx, el, mk, declared, fire, now, listeners }
}

test('the page script: declares at once, on a seek and a pause, not on every timeupdate, once per page', () => {
  const p = fakePage()
  assert.equal(vm.runInNewContext(M.pageScript(), p.ctx), true)
  assert.deepEqual(p.declared, [{ state: 'playing', duration: 200, position: 10, playbackRate: 1 }])
  // played on normally: timeupdate says nothing new
  p.now.t = 3000; p.el.currentTime = 12; p.mk.currentPlaybackTime = 12; p.fire('timeupdate')
  assert.equal(p.declared.length, 1)
  // the user seeks to 1:30: the seek is declared (Chromium sends Seeked)
  p.el.currentTime = 90; p.mk.currentPlaybackTime = 90; p.fire('seeked')
  assert.equal(p.declared.length, 2); assert.equal(p.declared[1].position, 90)
  // a gapless next song (no element event but timeupdate): its new length is declared
  p.now.t = 4000; p.mk.nowPlayingItem = { attributes: { durationInMillis: 180000 } }; p.el.currentTime = 0.5; p.mk.currentPlaybackTime = 0.5; p.fire('timeupdate')
  assert.equal(p.declared.length, 3); assert.equal(p.declared[2].duration, 180)
  // pause
  p.mk.isPlaying = false; p.fire('pause')
  assert.equal(p.declared[3].state, 'paused')
  // a second injection (dom-ready again for the same document) adds nothing
  const before = Object.values(p.listeners).flat().length
  assert.equal(vm.runInNewContext(M.pageScript(), p.ctx), false)
  assert.equal(Object.values(p.listeners).flat().length, before)
})

test('the page script: no MusicKit or no song yet declares nothing and doesn\'t throw', () => {
  const p = fakePage()
  p.ctx.window.MusicKit = undefined
  assert.equal(vm.runInNewContext(M.pageScript(), p.ctx), true)
  p.fire('play')
  assert.deepEqual(p.declared, [])
})

test('main.js: the name is Sonata, the settings folder stays, the position script runs per page load, and it ships', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8')
  assert.match(src, /const keepUserData = app\.getPath\('userData'\)\s*\n\s*app\.setName\(appName\)\s*\n\s*app\.setPath\('userData', keepUserData\)/)
  assert.ok(src.indexOf('app.setName(appName)') < src.indexOf('requestSingleInstanceLock'))
  assert.match(src, /appleWC\(\)\.on\('dom-ready', injectMediaPosition\)/)
  assert.ok(require('../package.json').build.files.includes('media-position.js'))
})
