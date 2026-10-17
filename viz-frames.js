// The visualizer's frame gate: it draws only while the music plays. On pause it draws a short settle
// (the bars fall to silence, the scene comes to rest) and then stops requesting frames until playback
// resumes, so a paused visualizer costs no frames at all (Marcy, 2026-10-16: "freeze while paused").
// A scene change or a resize while frozen draws one settle, so the still frame is the right scene.
//
//   const gate = createFrameGate({ draw, raf: requestAnimationFrame, now: () => performance.now(), onResume })
//   gate.setPlaying(isPlaying)   // per 'lyrics-time' push (2/s)
//   gate.kick()                  // something changed the picture while frozen
//
// "Playing" also needs fresh pushes: when they stop (Apple's page reports nothing playing, so main
// sends none) the gate counts it as paused after STALE_MS. Before the first push it draws for STALE_MS.
'use strict'

const SETTLE_MS = 500    // frames drawn after a pause: the bars' 0.35-per-frame fall is done in ~30
const STALE_MS = 1500    // 3 missed pushes at 2/s: nothing is playing

// loop: HOT-PATH-OK — visualizer render loop · requestAnimationFrame (display rate) · runs while the music plays (fresh
// 'lyrics-time' pushes saying isPlaying), plus SETTLE_MS after a pause, a scene change or a resize ·
// stops on pause (after the settle) and when pushes stop; Chromium also stops rAF while the window is
// hidden/minimized · cost one canvas frame per display frame while playing, 0 frames while paused
function createFrameGate(opts) {
  const { draw, raf, now } = opts
  const onResume = opts.onResume || (() => {})
  let playing = false
  let lastPush = -Infinity
  let until = now() + STALE_MS   // draw until then even when not playing (first push not here yet)
  let pending = false
  let frames = 0

  const want = (t) => (playing && t - lastPush < STALE_MS) || t < until
  function loop() {
    pending = false
    draw()
    frames++
    if (want(now())) request()
  }
  function request() {
    if (pending) return
    pending = true
    raf(loop)
  }

  function setPlaying(isPlaying) {
    const t = now()
    const wasLive = playing && t - lastPush < STALE_MS
    if (lastPush === -Infinity && !isPlaying) until = t + SETTLE_MS   // the first push says paused: settle from here
    lastPush = t
    if (isPlaying) {
      playing = true
      if (!wasLive && !pending) onResume()   // the loop was stopped: no time step across the pause
      request()
      return
    }
    if (wasLive || playing) until = Math.max(until, t + SETTLE_MS)
    playing = false
    if (want(t)) request()
  }

  function kick() {
    until = Math.max(until, now() + SETTLE_MS)
    request()
  }

  request()
  return {
    setPlaying,
    kick,
    get running() { return pending },
    get frames() { return frames }
  }
}

module.exports = { createFrameGate, SETTLE_MS, STALE_MS }
