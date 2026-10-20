// The Studio's Montage, its page half (lyrics.html body.stage): related photos of the artist, the band
// live, the venue and the album's era drifting slowly behind the lyrics (Ken Burns: a slow pan and zoom,
// a cross-fade), under a shade of the theme's own surface colour raised per photo until every word
// reads (montage-model.js scrimFor), with a credit line naming the photo's author, licence and source.
// The tile "Montage" on the Studio's left turns it on and off (remembered by main, off by default).
// Main finds and fetches the photos (montage-sources.js) and sends 'stage-montage':
//   { on, status: 'off'|'idle'|'looking'|'ready'|'none'|'offline'|'failed', offline, photos: [{ id, src,
//     author, licence, licenceUrl, title, lo, hi }] }
// The page sends 'montage' (on/off) and 'montage-credit' (a photo's id: main opens its Commons page).
//
// Render path: two <img> layers, only transform and opacity change (composited: will-change); the pan
// is written 10 times a second (FPS) by one timer, which runs only while the Studio shows, the Montage
// is on with photos, the music plays and the window is visible; paused, hidden or minimised there is no
// timer and no frame. Reduced motion: no pan or zoom, a 3 s cross-fade (CSS) every 20 s from a one-shot
// timer. Idle cost (measured, docs/PERFORMANCE.md): 0 frames paused or hidden.
'use strict'
const M = require('./montage-model')

/**
 * createMontage({ doc, send(command, value), theme (theme-apply), say(text), onLayout() }) ->
 * { setForm(stage), setState(msg), setPlaying(playing), reshade(), next(), facts() }
 */
function createMontage(opts) {
  const doc = opts.doc
  const $ = (id) => doc.getElementById(id)
  const send = opts.send
  const win = doc.defaultView
  const box = $('montage')
  const layers = [...box.querySelectorAll('.mt-photo')]
  const tile = $('t-montage')
  const credit = $('mt-credit')
  const creditText = credit.querySelector('span')
  const calmQuery = win.matchMedia('(prefers-reduced-motion: reduce)')

  let stage = false
  let state = { on: false, status: 'off', photos: [] }
  let playing = false
  let clock = 0            // the montage's own time (s): runs only while it plays, kept across songs of one set
  let setKey = ''          // the photos' ids: a new set starts the clock again
  let timer = 0
  let lastTick = 0
  // cache: OK — key=layer index (2); invalidated=reset on a new photo set and a reduced-motion change; bound=2
  let slot = [-1, -1]      // the slot (k) each layer shows
  let shownPhoto = ''
  let scrimShown = ''
  // cache: FIX-UNBOUNDED — key=photo id; invalidated=theme push (per track w/ album colour); bound=none if off, ~1 KB/set
  const shades = new Map() // photo id -> scrim alpha (for this theme)
  const written = [{ t: '', o: '' }, { t: '', o: '' }]

  // --- the tile ---
  // lifetime: OK — one click handler, set once at load, released with the window
  tile.onclick = () => {
    // on: turn it off. Off, or nothing found / offline / failed: ask main (again) to turn it on
    const want = !(state.on && (state.status === 'ready' || state.status === 'looking' || state.status === 'idle'))
    send('montage', want)
    // shown at once; main's answer replaces it
    setState(Object.assign({}, state, { on: want, status: want ? 'looking' : 'off', photos: want ? state.photos : [] }))
  }
  // lifetime: OK — one click handler on the credit line, released with the window
  credit.onclick = () => { if (shownPhoto) send('montage-credit', shownPhoto) }

  const TILE = {
    off: ['Off', 'Related photos of the artist and the venue drifting behind the lyrics (off)'],
    idle: ['On', 'Montage on: photos show while a song plays'],
    looking: ['Looking…', 'Looking for free photos of this artist on Wikimedia Commons'],
    ready: ['On', 'Montage on: free photos from Wikimedia Commons drift behind the lyrics (click to turn off)'],
    none: ['No free photos', 'No free photos found for this artist (click to look again)'],
    offline: ['Offline', 'Offline: no saved photos for this artist yet (click to try again)'],
    failed: ['Not loaded', 'Wikimedia Commons didn\'t answer (click to try again)']
  }
  function drawTile() {
    tile.hidden = !stage
    const st = state.on ? state.status : 'off'
    const [small, title] = TILE[st] || TILE.off
    const lit = state.on && (st === 'ready' || st === 'looking' || st === 'idle')
    tile.setAttribute('aria-pressed', String(lit))
    const s = tile.querySelector('small')
    const words = st === 'ready' && state.offline ? 'On · saved' : small
    if (s.textContent !== words) s.textContent = words
    tile.title = st === 'ready' && state.offline ? 'Montage on: offline, showing the photos saved on this computer' : title
    tile.setAttribute('aria-description', tile.title)
  }

  // --- what shows ---
  const photos = () => (state.on && state.status === 'ready' && Array.isArray(state.photos) ? state.photos : [])
  const visible = () => stage && photos().length > 0
  const running = () => visible() && playing && doc.visibilityState === 'visible'
  const calm = () => calmQuery.matches

  function setState(msg) {
    const m = msg && typeof msg === 'object' ? msg : {}
    const was = state.status
    state = { on: !!m.on, status: String(m.status || 'off'), offline: !!m.offline, photos: Array.isArray(m.photos) ? m.photos.filter((p) => p && typeof p.src === 'string' && typeof p.id === 'string') : [] }
    // a new set of photos (another artist or album) starts the montage over; more photos of the same set don't
    const key = state.photos.length ? String(m.set || state.photos.map((p) => p.id).join('|')) : ''
    if (key !== setKey) { setKey = key; clock = 0; slot = [-1, -1]; shownPhoto = ''; layers.forEach((l) => { l.removeAttribute('src'); l.style.opacity = '0' }); written.forEach((w) => { w.t = ''; w.o = '' }) }   // loop: NOT-WORTH — 2 layers, per new photo set
    drawTile()
    // screen readers hear the outcome of a click once: found nothing, offline
    if (state.on && state.status !== was && (state.status === 'none' || state.status === 'offline' || state.status === 'failed') && opts.say) opts.say('Montage: ' + TILE[state.status][1].replace(/ \(click.*\)$/, ''))
    draw(true)
    schedule()
  }

  // the shade for a photo, in this theme: raised from 0.6 until every word passes (montage-model.js)
  function shadeOf(p) {
    if (!p) return M.SCRIM_MAX
    if (!shades.has(p.id)) shades.set(p.id, M.scrimFor(opts.theme.tokens(), p).alpha)
    return shades.get(p.id)
  }
  function reshade() { shades.clear(); scrimShown = ''; draw(true) }

  // one layer: its photo for slot k, its transform and opacity (written only when they change)
  function put(i, k, ps, opacity) {
    const L = layers[i]
    const list = photos()
    if (slot[i] !== k) {
      slot[i] = k
      const p = list[k % list.length]
      L.dataset.photo = p.id
      L.dataset.ready = ''
      L.src = p.src
      // lifetime: OK — one decode per photo shown; the next draw shows it once decoded
      L.decode().then(() => { if (slot[i] === k) { L.dataset.ready = '1'; draw(true) } }, () => { /* error: NOT-WORTH — a broken file: the layer stays hidden, the next photo comes in its turn */ })
    }
    const o = L.dataset.ready ? opacity : 0
    const t = ps ? M.css(ps) : 'none'
    const w = written[i]
    if (w.t !== t) { w.t = t; L.style.transform = t }
    const os = o.toFixed(3)
    if (w.o !== os) { w.o = os; L.style.opacity = os }
  }

  function draw(force) {
    box.hidden = !visible()
    credit.hidden = box.hidden
    if (box.hidden) return
    const list = photos()
    const f = M.frame(clock, list.length, calm())
    box.classList.toggle('calm', calm())
    const a = f.k % 2
    const b = 1 - a
    put(a, f.k, f.curPose, calm() ? 1 : f.curOpacity)
    if (f.fading && !calm()) put(b, f.k - 1, f.prevPose, 1)
    else if (calm() && f.k > 0) put(b, f.k - 1, null, 0)   // the CSS transition fades it out
    else {
      if (written[b].o !== '0.000') { written[b].o = '0.000'; layers[b].style.opacity = '0' }
      if (calm() && written[b].t !== 'none') { written[b].t = 'none'; layers[b].style.transform = 'none' }
    }
    if (layers[a].style.zIndex !== '2') { layers[a].style.zIndex = '2'; layers[b].style.zIndex = '1' }
    // the credit names the photo coming in (from the start of its fade)
    const p = list[f.cur]
    if (p.id !== shownPhoto || force) {
      shownPhoto = p.id
      credit.dataset.photo = p.id
      const words = [p.author, p.licence, 'Wikimedia Commons'].filter(Boolean)
      const b0 = doc.createElement('b')
      b0.textContent = words[0]
      creditText.replaceChildren(b0, ' · ' + words.slice(1).join(' · '))
      credit.title = '"' + (p.title || p.id) + '" by ' + p.author + ', ' + p.licence + '. Opens its Wikimedia Commons page in your browser'
      credit.setAttribute('aria-label', 'Photo by ' + p.author + ', ' + p.licence + ', Wikimedia Commons: open its page in the browser')
    }
    // the shade: this photo's, or the stronger of the two while they cross-fade
    const alpha = Math.max(shadeOf(p), f.fading ? shadeOf(list[f.prev]) : 0)
    const s = alpha.toFixed(2)
    if (s !== scrimShown) { scrimShown = s; box.style.setProperty('--scrim', s) }
  }

  // --- the clock: one timer, only while running ---
  function stop() { if (timer) { clearTimeout(timer); timer = 0 } }
  function tick() {
    timer = 0
    if (!running()) return
    const now = win.performance.now()
    clock += Math.min(0.25, Math.max(0, (now - lastTick) / 1000))
    lastTick = now
    draw(false)
    schedule()
  }
  function schedule() {
    stop()
    if (!running()) return
    lastTick = lastTick && win.performance.now() - lastTick < 300 ? lastTick : win.performance.now()
    if (calm()) {
      // reduced motion: no pan; one one-shot timer to the next photo's cross-fade
      const f = M.frame(clock, photos().length, true)
      const at = win.performance.now()
      // loop: NOT-WORTH — one one-shot per photo (every 20 s) while playing; none paused or hidden
      timer = setTimeout(() => { timer = 0; clock += (win.performance.now() - at) / 1000; draw(false); schedule() }, Math.max(50, f.next * 1000 + 30))
      return
    }
    // loop: HOT-PATH-OK — the Ken Burns pan · 10 Hz (FPS) · only while the Studio shows, the Montage is on with photos, the music plays and the window is visible · stops on pause, hide, minimise, the Montage off, the compact form · cost 2 transform/opacity writes per tick (composited layers), measured in docs/PERFORMANCE.md
    timer = setTimeout(tick, 1000 / M.FPS)
  }

  // lifetime: OK — two listeners for the window's life: the window shown/hidden/minimised and the reduced-motion setting
  doc.addEventListener('visibilitychange', () => { if (doc.visibilityState === 'visible') lastTick = 0; schedule() })
  calmQuery.addEventListener('change', () => { slot = [-1, -1]; written.forEach((w) => { w.t = ''; w.o = '' }); draw(true); schedule() })   // loop: NOT-WORTH — 2 layers

  return {
    setForm(isStage) {
      stage = !!isStage
      drawTile()
      draw(true)
      schedule()
    },
    setState,
    setPlaying(p) {
      const v = !!p
      if (v === playing) return
      playing = v
      if (v) lastTick = 0
      schedule()
    },
    reshade,
    // the next photo now (a click on the photo area, the Studio's N key): -> true when one came in
    next() {
      if (!visible() || photos().length < 2) return false
      const f = M.frame(clock, photos().length, calm())
      clock = clock - f.local + (calm() ? M.CALM_HOLD : M.HOLD) + M.FADE   // the next slot, its fade done (shown at once, paused or playing)
      lastTick = 0
      draw(true)
      schedule()
      return true
    },
    // for the UI checker: what shows and the shade it chose
    facts: () => ({ visible: !box.hidden, running: !!timer, clock: +clock.toFixed(2), photo: shownPhoto, scrim: scrimShown, layers: layers.map((l) => ({ photo: l.dataset.photo || '', opacity: l.style.opacity, transform: l.style.transform })) })
  }
}

module.exports = { createMontage }
