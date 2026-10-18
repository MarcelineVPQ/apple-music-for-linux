// The stage view's page half (lyrics.html body.stage): the lyrics window grown into the now-playing
// stage. Left: the cover (a click turns it over to the song's credits), the song (links to its album and
// artist), "Track N of M", the live chip, the transport and the song's actions (Favorite, Add to Library,
// Add to a Playlist, Copy Link, Go to Album / Artist, More). Right: one list, the songs played, the one
// playing, the "Next · in 1:22" card and the rest. The lyrics in the middle are the lyrics window's own engine
// (lyrics-view.js, one engine). Data comes from main.js: 'stage-np' (the song, on change only),
// 'stage-queue' (Apple's queue, read-only, polled only while the stage shows) and the lyrics feed's
// 'lyrics-time' pushes. The logic is stage-model.js (tested); this file only draws it.
//
// The song's state ('stage-song'), its credits ('stage-credits') and the actions' notes ('stage-said') come
// from main on a new song or after an action only: nothing here asks on a timer.
//
// Render path: nothing here animates on its own (the cover's turn and the notes' fade run once per click). The seek bar, the volume and the track chip move by
// transform only, written on the 2/s time pushes and only when the value changed; the times and the
// countdown change their text once a second while playing. Paused: no writes, no frames.
'use strict'
const M = require('./stage-model')

// the mini player's icons (16 px grid)
const PATHS = {
  shuffle: 'M11.5 2.5h3v3l-1.15-1.15-2.8 2.8-1.06-1.06 2.8-2.8L11.5 2.5zM1 3h2.9c.5 0 .97.2 1.32.55l1.53 1.53-1.06 1.06-1.53-1.53a.37.37 0 0 0-.26-.11H1V3zm13.5 7.5v3h-3l1.15-1.15-2.44-2.44a.37.37 0 0 0-.26-.11H8v-1.5h1.95c.5 0 .97.2 1.32.55l2.44 2.44 1.29-1.29zM1 11.5h2.9c.1 0 .19-.04.26-.11l6.19-6.19 1.5 1.06-6.63 6.63c-.35.35-.83.55-1.32.55H1v-1.5z',
  prev: 'M8.7 7.35 14.6 3.6a.75.75 0 0 1 1.15.63v7.54a.75.75 0 0 1-1.15.63L8.7 8.65v3.12a.75.75 0 0 1-1.15.63L1.3 8.63a.75.75 0 0 1 0-1.26L7.55 3.6a.75.75 0 0 1 1.15.63v3.12z',
  play: 'M4 2.3a.75.75 0 0 1 1.15-.63l9 5.7a.75.75 0 0 1 0 1.26l-9 5.7A.75.75 0 0 1 4 13.7V2.3z',
  pause: 'M4 2h2.5v12H4zM9.5 2H12v12H9.5z',
  next: 'M7.3 7.35 1.4 3.6a.75.75 0 0 0-1.15.63v7.54a.75.75 0 0 0 1.15.63l5.9-3.75v3.12a.75.75 0 0 0 1.15.63l6.25-3.77a.75.75 0 0 0 0-1.26L8.45 3.6a.75.75 0 0 0-1.15.63v3.12z',
  repeat: 'M3.5 5.5h7V7l3-2.25L10.5 2.5V4h-7A2.5 2.5 0 0 0 1 6.5V8h1.5V6.5c0-.55.45-1 1-1zm9 5h-7V9l-3 2.25 3 2.25V12h7A2.5 2.5 0 0 0 15 9.5V8h-1.5v1.5c0 .55-.45 1-1 1z',
  vol: 'M8.5 2.06a.75.75 0 0 1 .43.68v10.52a.75.75 0 0 1-1.21.59L4.6 11.5H2.25a.75.75 0 0 1-.75-.75v-5.5A.75.75 0 0 1 2.25 4.5H4.6l3.12-2.35a.75.75 0 0 1 .78-.09zM11.3 5.53a.75.75 0 0 1 1.06 0 3.5 3.5 0 0 1 0 4.95.75.75 0 1 1-1.06-1.07 2 2 0 0 0 0-2.82.75.75 0 0 1 0-1.06zm1.94-1.94a.75.75 0 0 1 1.06 0 6.25 6.25 0 0 1 0 8.83.75.75 0 1 1-1.06-1.06 4.75 4.75 0 0 0 0-6.71.75.75 0 0 1 0-1.06z',
  note: 'M13 1.2v9.3a2.5 2.5 0 1 1-1.5-2.29V4.4L6 5.7v6.8a2.5 2.5 0 1 1-1.5-2.29V3.1z',
  photo: 'M2 3h12a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1H2a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1zm.5 8.5h11L10 7l-2.5 3L6 8.5zM5 7a1.25 1.25 0 1 0 0-2.5A1.25 1.25 0 0 0 5 7z',
  book: 'M1.5 3c2-.6 4.2-.4 5.75.6V14c-1.55-1-3.75-1.2-5.75-.6zm13 0v10.4c-2-.6-4.2-.4-5.75.6V3.6C10.3 2.6 12.5 2.4 14.5 3z',
  grow: 'M2 2h4.5v1.5H3.5v3H2zm12 0v4.5h-1.5v-3h-3V2zM2 14V9.5h1.5v3h3V14zm12 0H9.5v-1.5h3v-3H14z',
  shrink: 'M5 2h1.5v4.5H2V5h3zm4.5 0H11v3h3v1.5H9.5zM2 9.5h4.5V14H5v-3H2zm7.5 0H14V11h-3v3H9.5z',
  // the song's actions (the mini player's star; the others drawn on the same grid)
  starOff: 'M8 1.6l1.86 3.95 4.14.5-3.06 2.86.83 4.19L8 11.6l-3.77 1.5.83-4.19L2 6.05l4.14-.5z',
  starOn: 'M8 1.6l1.86 3.95 4.14.5-3.06 2.86.83 4.19L8 11.6l-3.77 1.5.83-4.19L2 6.05l4.14-.5z',
  plus: 'M7.25 2h1.5v5.25H14v1.5H8.75V14h-1.5V8.75H2v-1.5h5.25z',
  check: 'M6.2 11.9 2.4 8.1l1.06-1.06L6.2 9.78l6.34-6.34 1.06 1.06z',
  listPlus: 'M1 3h9v1.5H1zm0 4h9v1.5H1zm0 4h5.5v1.5H1zm10.25-2V7h1.5v2H15v1.5h-2.25v2.25h-1.5V10.5H9V9z',
  link: 'M6.6 9.4l2.8-2.8M7.3 4.6l1.1-1.1a2.5 2.5 0 0 1 3.5 3.5l-1.1 1.1M8.7 11.4l-1.1 1.1a2.5 2.5 0 0 1-3.5-3.5l1.1-1.1',
  disc: 'M8 1.25a6.75 6.75 0 1 1 0 13.5 6.75 6.75 0 0 1 0-13.5zM8 6.4a1.6 1.6 0 1 0 0 3.2 1.6 1.6 0 0 0 0-3.2z',
  person: 'M8 1.75a3 3 0 1 1 0 6 3 3 0 0 1 0-6zM2.25 14.25c0-2.9 2.55-5 5.75-5s5.75 2.1 5.75 5z',
  more: 'M3 6.5a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3zm5 0a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3zm5 0a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3z',
  turn: 'M2.5 8a5.5 5.5 0 0 1 9.4-3.9V2.5h1.5v4.25H9.15v-1.5h1.9A4 4 0 1 0 12 8h1.5A5.5 5.5 0 1 1 2.5 8z',
  close: 'M3.28 2.22a.75.75 0 0 0-1.06 1.06L6.94 8l-4.72 4.72a.75.75 0 1 0 1.06 1.06L8 9.06l4.72 4.72a.75.75 0 1 0 1.06-1.06L9.06 8l4.72-4.72a.75.75 0 0 0-1.06-1.06L8 6.94 3.28 2.22z'
}
const STROKED = new Set(['starOff', 'link'])   // drawn as lines (the rest are filled shapes)
const EVENODD = new Set(['disc'])
const SVG = 'http://www.w3.org/2000/svg'
function icon(doc, name) {
  const svg = doc.createElementNS(SVG, 'svg')
  svg.setAttribute('viewBox', '0 0 16 16')
  svg.setAttribute('aria-hidden', 'true')
  svg.setAttribute('focusable', 'false')
  const p = doc.createElementNS(SVG, 'path')
  p.setAttribute('d', PATHS[name])
  if (STROKED.has(name)) { p.setAttribute('fill', 'none'); p.setAttribute('stroke', 'currentColor'); p.setAttribute('stroke-width', '1.3'); p.setAttribute('stroke-linejoin', 'round'); p.setAttribute('stroke-linecap', 'round') }
  if (EVENODD.has(name)) p.setAttribute('fill-rule', 'evenodd')
  svg.appendChild(p)
  return svg
}
function setIcon(el, name) {
  if (el.dataset.icon === name) return
  el.dataset.icon = name
  el.replaceChildren(icon(el.ownerDocument, name))
}

/**
 * createStage({ doc, send(command, value), onLayout(), say(text), lines(), nextPhoto() }) -> { setForm,
 * setNowPlaying, setQueue, setTime, setBand, setSong, setCredits, said, rowCredits, flip, linerFound, shown }.
 * send: ipcRenderer.send('stage-command', …). onLayout: the stage's layout changed (the page recentres the
 * lyrics and moves its drag grip). say: the screen-reader line. lines: the song's timed lines ({ t, text },
 * lyrics-view.js timedLines) for ↑/↓ and the seek bar's hover. nextPhoto: the Montage's next photo (true when
 * it showed one).
 */
function createStage(opts) {
  const doc = opts.doc
  const $ = (id) => doc.getElementById(id)
  const send = opts.send
  const say = (t) => { if (opts.say) opts.say(t) }
  const lines = () => (opts.lines ? opts.lines() : [])
  const body = doc.body
  const now = () => doc.defaultView.performance.now()
  const el = {
    flip: $('flip'), coverBtn: $('cover-btn'), back: $('cover-back'), cbClose: $('cb-close'), cbRows: $('cb-rows'), cbChips: $('cb-chips'), cbMore: $('cb-more'),
    cover: $('cover'), title: $('np-title'), artist: $('np-artist'), album: $('np-album'),
    chipTrack: $('chip-track'), chipLive: $('chip-live'),
    seek: $('seek-bar'), seekFill: $('seek-fill'), seekRun: $('seek-run'), seekTip: $('seek-tip'), tEl: $('t-el'), tRem: $('t-rem'),
    shuffle: $('b-shuffle'), prev: $('b-prev'), play: $('b-play'), next: $('b-next'), repeat: $('b-repeat'), repeatOne: $('repeat-one'),
    vol: $('vol-bar'), volFill: $('vol-fill'), volRun: $('vol-run'),
    fav: $('a-fav'), lib: $('a-lib'), pl: $('a-pl'), link: $('a-link'), goAlbum: $('a-album'), goArtist: $('a-artist'), more: $('a-more'), note: $('act-note'),
    layers: $('layers'), tNotes: $('t-notes'), tMontage: $('t-montage'), tLiner: $('t-liner'), band: $('band'),
    ctx: $('ctx'), qTitle: $('q-title'),
    nextCard: $('next-card'), nextArt: $('next-art'), nextIn: $('next-in'), nextT: $('next-t'), nextS: $('next-s'), nextD: $('next-d'),
    list: $('q-list'), note2: $('q-note'), footL: $('q-foot-l'), footR: $('q-foot-r'), pop: $('q-pop')
  }
  let form = { stage: false, linerNotes: false }
  let np = null           // 'stage-np': { title, artist, album, art, duration, isPlaying, shuffle, repeat, volume, releaseDate }
  let q = null            // stage-model cleanQueue
  let time = 0
  let shownSec = -1       // the whole second the times and the countdown show
  let seekP = -1          // the fraction the seek bar shows
  let volShown = -1
  let bandNode = null     // the sheet-notes band's content (null: no data, no band, no tile)
  let bandOn = true
  let linerNone = ''      // the album (albumKey) the Liner notes tile found no booklet for: it says so until the album changes
  let song = null         // 'stage-song': the action row's state for the song playing (song-actions.js cleanState + offers)
  let credits = null      // 'stage-credits': the cover's back
  let turned = false      // the cover shows its back (the credits)
  let userScrolled = -1e9 // when the user last scrolled the list (no auto-scroll for SCROLL_QUIET ms after)
  let scrolledFor = ''    // the song the list last scrolled to
  const SCROLL_QUIET = 4000
  const live0 = (album) => M.liveChip(album) || 'Live'
  const albumKey = () => (np ? (np.album || '') + '|' + (np.artist || '') : '|')
  const songKey = () => (np ? (np.title || '') + '|' + (np.artist || '') : '')

  setIcon(el.shuffle, 'shuffle'); setIcon(el.prev, 'prev'); setIcon(el.play, 'play'); setIcon(el.next, 'next'); setIcon(el.repeat, 'repeat')
  setIcon($('i-vol'), 'vol')
  setIcon(el.tNotes.querySelector('.ti'), 'note'); setIcon(el.tMontage.querySelector('.ti'), 'photo'); setIcon(el.tLiner.querySelector('.ti'), 'book')
  setIcon(el.fav, 'starOff'); setIcon(el.lib, 'plus'); setIcon(el.pl, 'listPlus'); setIcon(el.link, 'link'); setIcon(el.goAlbum, 'disc'); setIcon(el.goArtist, 'person'); setIcon(el.more, 'more')
  setIcon(el.cbClose, 'turn'); setIcon($('q-pop-x'), 'close')
  $('flip-hint').append(icon(doc, 'turn'), 'Credits')

  // --- the transport: each button sends its command; Apple's player answers through 'stage-np' ---
  // lifetime: OK — one click handler per control, set once at load, released with the window
  el.play.onclick = () => send('play-pause')
  el.prev.onclick = () => send('previous')
  el.next.onclick = () => send('next')
  el.shuffle.onclick = () => send('shuffle')
  el.repeat.onclick = () => send('repeat')
  el.tLiner.onclick = () => send('liner-notes')
  el.tNotes.onclick = () => { bandOn = !bandOn; showBand() }

  // --- the song's words are links; the chips answer ---
  // lifetime: OK — one click handler per control, set once at load, released with the window
  el.title.onclick = () => send('song-album')
  el.album.onclick = () => send('song-album')
  el.artist.onclick = () => send('song-artist')
  el.chipLive.onclick = () => send('liner-recording')
  el.chipTrack.onclick = () => showPlaying(true)
  el.nextCard.onclick = () => send('next')

  // --- the song's actions: each one says what it did (main answers with 'stage-said') ---
  const anchorOf = (b) => { const r = b.getBoundingClientRect(); return { x: Math.max(0, Math.round(r.left)), y: Math.max(0, Math.round(r.bottom + 2)) } }
  // lifetime: OK — one click handler per action, set once at load, released with the window
  el.fav.onclick = () => send('song-favorite', !(song && song.favorite))
  el.lib.onclick = () => {
    if (el.lib.getAttribute('aria-disabled') === 'true') { said({ kind: 'ok', text: 'Already in your library' }); return }
    send('song-library')
  }
  el.pl.onclick = () => send('song-playlists', anchorOf(el.pl))
  el.link.onclick = () => send('song-link')
  el.goAlbum.onclick = () => send('song-album')
  // lifetime: OK — set once at load, released with the window
  el.goArtist.onclick = () => send('song-artist')
  // lifetime: OK — set once at load, released with the window
  el.more.onclick = () => send('song-more', anchorOf(el.more))

  function drawSong() {
    const s = song && song.ok ? song : null
    const fav = !!(s && s.favorite)
    el.fav.setAttribute('aria-pressed', String(fav))
    setIcon(el.fav, fav ? 'starOn' : 'starOff')
    el.fav.title = fav ? 'Undo Favorite (F): take this song out of your Favorites' : 'Favorite (F): add this song to your Favorites'
    const inLib = !!(s && s.inLibrary === true)
    el.lib.setAttribute('aria-disabled', String(inLib))
    setIcon(el.lib, inLib ? 'check' : 'plus')
    el.lib.setAttribute('aria-label', inLib ? 'In your library' : 'Add to Library')
    el.lib.title = inLib ? 'Already in your library' : 'Add to Library'
    el.link.title = s && s.url ? 'Copy the song\'s Apple Music link' : 'Copy Link (no link known for this song yet)'
  }

  // the note under the row: a short confirmation or what failed; it fades by itself (one opacity animation)
  let noteAnim = null
  function said(n) {
    if (!n || typeof n.text !== 'string') return
    el.note.textContent = n.text
    el.note.classList.toggle('error', n.kind === 'error')
    say(n.text)
    if (noteAnim) noteAnim.cancel()
    // lifetime: OK — one 4 s opacity animation per note (cancelled by the next one); nothing runs after it
    noteAnim = el.note.animate([{ opacity: 1 }, { opacity: 1, offset: 0.8 }, { opacity: 0 }], { duration: n.kind === 'error' ? 7000 : 4000, fill: 'forwards' })
  }

  // --- the cover turns over to the song's credits ---
  // lifetime: OK — the cover's and its back's handlers, set once at load, released with the window
  el.coverBtn.onclick = () => flip(true)
  el.cbClose.onclick = () => flip(false)
  el.cbMore.onclick = () => send('credits-liner')
  // a click on the back (not on its buttons or while selecting text) turns it back
  el.back.addEventListener('click', (e) => {
    if (e.target.closest('button') || String(doc.getSelection() || '')) return
    flip(false)
  })
  // lifetime: OK — set once at load, released with the window
  el.back.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); flip(false) } })
  function flip(on) {
    const v = !!on && !el.flip.hidden
    if (v === turned) return
    const inBack = el.back.contains(doc.activeElement)
    turned = v
    el.flip.classList.toggle('turned', v)
    el.coverBtn.setAttribute('aria-expanded', String(v))
    el.coverBtn.inert = v
    el.back.inert = !v
    if (v) { el.cbClose.focus({ focusVisible: true }); say(creditsText()) } else if (inBack) el.coverBtn.focus({ focusVisible: true })
  }
  function creditsText() {
    const rows = credits && credits.key === songKey() ? credits.rows : []
    return rows.length ? 'Credits. ' + rows.map((r) => r.role + ': ' + r.names + (r.album ? ' (album credit)' : '')).join('. ') : 'Credits: none known for this song yet'
  }
  function drawCreditsInto(dl, chipsBox, c) {
    const rows = c && Array.isArray(c.rows) ? c.rows : []
    dl.replaceChildren()
    // loop: NOT-WORTH — a song's credit rows (≤ ~12), once per song
    for (const r of rows) {
      const dt = doc.createElement('dt')
      dt.textContent = r.role
      const dd = doc.createElement('dd')
      dd.textContent = r.names
      if (r.album) { const sm = doc.createElement('small'); sm.textContent = ' · album credit'; dd.appendChild(sm) }
      dl.append(dt, dd)
    }
    if (!rows.length) { const dd = doc.createElement('dd'); dd.textContent = c ? 'No credits known for this song yet' : 'Looking up the credits…'; dl.appendChild(dd) }
    chipsBox.replaceChildren(...(c && Array.isArray(c.chips) ? c.chips : []).map((ch) => {   // loop: NOT-WORTH — ≤ 2 chips
      const sp = doc.createElement('span')
      sp.className = 'chip'
      sp.textContent = ch.who + (ch.what ? ' · ' + ch.what : '')
      return sp
    }))
  }
  function drawCredits() {
    const c = credits && credits.key === songKey() ? credits : null
    drawCreditsInto(el.cbRows, el.cbChips, c)
    el.cbMore.hidden = !(c && c.liner)
  }

  // --- the two sliders (song position, volume): pointer and keyboard ---
  // set(fraction, done): done on release and on a key (the seek is sent then; the volume as it moves)
  // keyTo(key, fraction): where a key takes the slider, or null for a key it doesn't use
  function slider(bar, get, set, keyTo) {
    let dragging = false
    const at = (e) => { const r = bar.getBoundingClientRect(); return Math.min(1, Math.max(0, (e.clientX - r.left) / Math.max(1, r.width))) }
    // lifetime: OK — the bar's pointer and key handlers, set once at load, released with the window
    bar.onpointerdown = (e) => { if (e.button !== 0) return; dragging = true; bar.setPointerCapture(e.pointerId); set(at(e), false) }
    bar.onpointermove = (e) => { if (dragging) set(at(e), false); if (bar === el.seek) tip(at(e)) }
    bar.onpointerup = (e) => { if (!dragging) return; dragging = false; set(at(e), true) }
    bar.onpointercancel = () => { dragging = false; set(get(), true) }
    bar.onkeydown = (e) => {
      if (e.ctrlKey || e.altKey || e.metaKey) return
      const to = keyTo(e.key, get())
      if (to === null) return
      e.preventDefault()
      set(Math.min(1, Math.max(0, to)), true)
    }
  }
  const dur = () => (np && np.duration > 0 ? np.duration : 0)
  let seeking = false     // the seek bar is being dragged: the time pushes don't move it meanwhile
  slider(el.seek, () => (dur() ? time / dur() : 0), (p, done) => {
    if (!dur()) return
    seeking = !done
    time = p * dur()
    drawTime(true)
    if (done) send('seek', Math.round(time * 10) / 10)
  }, (key, v) => {
    // 5 s and 30 s of the song per key
    const d = dur()
    if (!d) return null
    const k = { ArrowRight: 5, ArrowUp: 5, ArrowLeft: -5, ArrowDown: -5, PageUp: 30, PageDown: -30 }
    if (key in k) return v + k[key] / d
    if (key === 'Home') return 0
    if (key === 'End') return Math.max(0, 1 - 1 / d)
    return null
  })
  // the seek bar's hover: the time there and the words sung then (written on pointer moves only)
  function tip(p) {
    const d = dur()
    if (!d) { el.seekTip.hidden = true; return }
    const t = p * d
    el.seekTip.hidden = false
    el.seekTip.querySelector('b').textContent = M.clock(t)
    el.seekTip.querySelector('span').textContent = M.lineAt(lines(), t)
    const w = el.seek.getBoundingClientRect().width
    const tw = el.seekTip.offsetWidth
    el.seekTip.style.transform = 'translateX(' + Math.round(Math.min(Math.max(0, p * w - tw / 2), Math.max(0, w - tw))) + 'px)'
  }
  // lifetime: OK — one listener, set once at load
  el.seek.addEventListener('pointerleave', () => { el.seekTip.hidden = true })
  slider(el.vol, () => (np ? np.volume || 0 : 0), (v) => {
    if (!np) return
    const before = volShown
    np.volume = v
    drawVolume()
    if (volShown !== before) send('volume', volShown / 100)
  }, (key, v) => {
    const k = { ArrowRight: 0.05, ArrowUp: 0.05, ArrowLeft: -0.05, ArrowDown: -0.05, PageUp: 0.2, PageDown: -0.2 }
    if (key in k) return v + k[key]
    if (key === 'Home') return 0
    if (key === 'End') return 1
    return null
  })

  // --- the list: one Tab stop, Up/Down/Home/End move between the songs, Enter/Space plays one, the Menu
  // key or Shift+F10 opens a song's menu ---
  // lifetime: OK — the list's keydown, contextmenu and scroll-intent listeners, released with the window
  el.list.addEventListener('keydown', (e) => {
    if (e.ctrlKey || e.altKey || e.metaKey) return
    const rows = [...el.list.querySelectorAll('button.q-row')]
    const at = rows.indexOf(doc.activeElement)
    if (at < 0) return
    if (e.key === 'ContextMenu' || (e.key === 'F10' && e.shiftKey)) { e.preventDefault(); rowMenu(rows[at]); return }
    let to = -1
    if (e.key === 'ArrowDown') to = Math.min(rows.length - 1, at + 1)
    else if (e.key === 'ArrowUp') to = Math.max(0, at - 1)
    else if (e.key === 'Home') to = 0
    else if (e.key === 'End') to = rows.length - 1
    else return
    e.preventDefault()
    rows[at].tabIndex = -1
    rows[to].tabIndex = 0
    rows[to].focus({ focusVisible: true })
  })
  // lifetime: OK — set once at load, released with the window
  el.list.addEventListener('contextmenu', (e) => {
    const li = e.target.closest('li')
    const row = li && li.querySelector('.q-row')
    if (!row || !row.dataset.index) return
    e.preventDefault()
    rowMenu(row)
  })
  const scrolledByUser = () => { userScrolled = now() }
  // lifetime: OK — set once at load, released with the window
  el.list.addEventListener('wheel', scrolledByUser, { passive: true })
  // lifetime: OK — set once at load, released with the window
  el.list.addEventListener('pointerdown', (e) => { if (e.target === el.list) scrolledByUser() })   // its scrollbar
  // lifetime: OK — set once at load, released with the window
  el.list.addEventListener('keydown', (e) => { if (/^(Page(Up|Down)|Arrow(Up|Down)|Home|End)$/.test(e.key)) scrolledByUser() })
  function rowMenu(row) {
    const r = row.getBoundingClientRect()
    send('row-menu', { index: Number(row.dataset.index), id: row.dataset.id, x: Math.max(0, Math.round(r.left + 24)), y: Math.max(0, Math.round(r.bottom)) })
  }

  // another song's credits (its menu's Credits): a small popover over the list, closed by Esc, ✕ or a click away
  // lifetime: OK — the popover's handlers, set once at load
  $('q-pop-x').onclick = () => closePop(true)
  el.pop.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closePop(true) } })
  doc.addEventListener('pointerdown', (e) => { if (!el.pop.hidden && !el.pop.contains(e.target)) closePop(false) })
  let popFrom = null
  function rowCredits(c) {
    if (!c || !Array.isArray(c.rows)) return
    $('q-pop-t').textContent = 'Credits · ' + String(c.title || '').slice(0, 80)
    drawCreditsInto(el.pop.querySelector('dl'), el.pop.querySelector('.chips'), c)
    const row = el.list.querySelector('.q-row[data-index="' + Number(c.index) + '"]')
    const qr = $('queue').getBoundingClientRect()
    const rr = row ? row.getBoundingClientRect() : qr
    el.pop.hidden = false
    el.pop.style.top = Math.round(Math.min(Math.max(48, rr.bottom - qr.top + 4), Math.max(48, qr.height - el.pop.offsetHeight - 8))) + 'px'
    popFrom = row
    $('q-pop-x').focus({ focusVisible: true })
    say('Credits for ' + c.title + '. ' + c.rows.map((r) => r.role + ': ' + r.names).join('. '))
  }
  function closePop(back) {
    if (el.pop.hidden) return
    el.pop.hidden = true
    if (back && popFrom && popFrom.isConnected) popFrom.focus({ focusVisible: true })
    popFrom = null
  }

  // --- the Studio's keys (the stage form only; never over a control that uses the key itself) ---
  // Space play/pause, ← → 5 s, ↑ ↓ the previous / next lyric line, F favourite, C the credits, N the next photo,
  // Esc turns the cover back (or closes the credits popover) before it closes the window (lyrics.html)
  // lifetime: OK — one capture listener on the page, released with the window
  doc.addEventListener('keydown', (e) => {
    if (!form.stage || e.ctrlKey || e.altKey || e.metaKey || e.defaultPrevented) return
    const t = e.target && e.target.closest ? e.target : body
    if (e.key === 'Escape') {
      if (!el.pop.hidden) { e.preventDefault(); e.stopImmediatePropagation(); closePop(true) }
      else if (turned) { e.preventDefault(); e.stopImmediatePropagation(); flip(false) }
      return
    }
    if (e.shiftKey) return
    const slider0 = t.closest('[role=slider]')
    const inList = t.closest('#q-list, #lines, #q-pop')
    const onButton = t.closest('button, [role=button]')
    let did = true
    if (e.key === ' ' && !onButton && !slider0 && !inList) send('play-pause')
    else if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && !slider0 && !inList && dur()) send('seek', Math.max(0, Math.min(dur() - 1, time + (e.key === 'ArrowRight' ? 5 : -5))))
    else if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && !slider0 && !inList) {
      const to = M.lineStep(lines(), time, e.key === 'ArrowDown' ? 1 : -1)
      if (to === null) did = false
      else send('seek', Math.round(to * 10) / 10)
    }
    else if (e.key === 'f' || e.key === 'F') el.fav.click()
    else if (e.key === 'c' || e.key === 'C') flip(!turned)
    else if ((e.key === 'n' || e.key === 'N') && opts.nextPhoto) did = !!opts.nextPhoto()
    else did = false
    if (did) e.preventDefault()
  }, true)

  // --- drawing ---
  function setForm(f) {
    form = Object.assign({ stage: false, linerNotes: false }, f || {})
    body.classList.toggle('stage', !!form.stage)
    for (const id of ['np', 'queue']) $(id).hidden = !form.stage   // loop: NOT-WORTH — 2 columns, per form change
    el.ctx.hidden = !form.stage
    const btn = $('form')
    setIcon(btn, form.stage ? 'shrink' : 'grow')
    btn.setAttribute('aria-pressed', String(!!form.stage))
    btn.title = form.stage ? 'Shrink to the lyrics window (Ctrl+Shift+S)' : 'Open the Studio: the lyrics with the song and what plays next (Ctrl+Shift+S)'
    el.tLiner.hidden = !form.linerNotes
    showBand()
    if (form.stage) { shownSec = -1; seekP = -1; volShown = -1; scrolledFor = ''; drawNowPlaying(); drawSong(); drawCredits(); drawQueue(true); drawTime(true) } else flip(false)
    if (opts.onLayout) opts.onLayout()
  }

  // the sheet-notes band (the +1): shown only with notes to show, folded away by its tile; never an empty box
  function showBand() {
    const has = !!bandNode && !!form.stage
    el.tNotes.hidden = !has
    el.tNotes.setAttribute('aria-pressed', String(has && bandOn))
    el.tNotes.querySelector('small').textContent = bandOn ? 'On' : 'Off'
    el.band.hidden = !(has && bandOn)
    el.layers.hidden = el.tNotes.hidden && el.tMontage.hidden && el.tLiner.hidden
  }
  function setBand(node) {
    if (node === bandNode) return
    bandNode = node || null
    el.band.replaceChildren(...(bandNode ? [bandNode] : []))
    showBand()
    if (opts.onLayout) opts.onLayout()
  }

  function text(node, value) { if (node.textContent !== value) node.textContent = value }

  function drawNowPlaying() {
    if (!form.stage) return
    const n = np || {}
    text(el.title, n.title || 'Nothing playing')
    text(el.artist, n.artist || '')
    const year = M.yearOf(n.releaseDate)
    text(el.album, (n.album || '') + (n.album && year ? ' · ' + year : ''))
    el.album.title = el.album.textContent ? el.album.textContent + ': open the album in Apple Music' : ''
    el.title.title = el.title.textContent + (n.title ? ': open the album in Apple Music' : '')
    el.artist.title = n.artist ? n.artist + ': open the artist in Apple Music' : ''
    el.title.setAttribute('aria-label', n.title ? n.title + ': open its album in Apple Music' : 'Nothing playing')
    el.artist.setAttribute('aria-label', (n.artist || 'Artist') + ': open the artist in Apple Music')
    el.album.setAttribute('aria-label', (el.album.textContent || 'Album') + ': open the album in Apple Music')
    el.chipLive.setAttribute('aria-label', live0(n.album) + (form.linerNotes ? ': open the liner notes at the recording' : ''))
    el.title.disabled = !n.title
    el.artist.hidden = !n.artist
    el.album.hidden = !n.album
    if ((n.art || '') !== (el.cover.dataset.src || '')) {
      el.cover.dataset.src = n.art || ''
      if (n.art) el.cover.src = n.art
      else el.cover.removeAttribute('src')
      el.cover.hidden = !n.art
      el.flip.hidden = !n.art
      if (!n.art) flip(false)
    }
    const live = M.liveChip(n.album)
    el.chipLive.hidden = !live
    text(el.chipLive.querySelector('span'), live)
    el.chipLive.title = form.linerNotes ? 'Open the liner notes at the recording' : live
    el.chipLive.disabled = !form.linerNotes
    el.play.setAttribute('aria-label', n.isPlaying ? 'Pause' : 'Play')
    el.play.title = n.isPlaying ? 'Pause (Space)' : 'Play (Space)'
    setIcon(el.play, n.isPlaying ? 'pause' : 'play')
    el.shuffle.setAttribute('aria-pressed', String(!!n.shuffle))
    el.shuffle.classList.toggle('on', !!n.shuffle)
    // MusicKit repeatMode: 0 off, 1 one, 2 all
    const rep = n.repeat === 1 ? 'one' : n.repeat === 2 ? 'all' : 'off'
    el.repeat.setAttribute('aria-pressed', String(rep !== 'off'))
    el.repeat.setAttribute('aria-label', 'Repeat: ' + rep)
    el.repeat.title = 'Repeat: ' + rep + ' (click: ' + (rep === 'off' ? 'all' : rep === 'all' ? 'one' : 'off') + ')'
    el.repeat.classList.toggle('on', rep !== 'off')
    el.repeatOne.hidden = rep !== 'one'
    drawVolume()
    drawTrack()
  }

  function drawVolume() {
    const v = np ? Math.round(Math.min(1, Math.max(0, np.volume || 0)) * 100) : 0
    if (v === volShown) return
    volShown = v
    el.volRun.style.transform = 'translateX(' + v + '%)'
    el.volFill.style.transform = 'scaleX(' + (v / 100) + ')'
    el.vol.setAttribute('aria-valuenow', String(v))
    el.vol.setAttribute('aria-valuetext', v + '%')
  }

  function drawTrack() {
    const t = M.trackOf(q, np && np.shuffle)
    el.chipTrack.hidden = !t
    if (t) {
      text(el.chipTrack.querySelector('span'), t.text)
      el.chipTrack.querySelector('b').style.transform = 'scaleX(' + (t.n / t.m).toFixed(4) + ')'
      el.chipTrack.setAttribute('aria-label', t.text + ': show it in the list')
    }
    text(el.footL, t ? t.text : '')
    const from = M.playingFrom(q)
    el.ctx.replaceChildren()
    if (from) { el.ctx.append('Playing from '); const b = doc.createElement('b'); b.textContent = from; el.ctx.append(b) }
    el.ctx.title = from ? 'Playing from ' + from : ''
  }

  // time pushes (2/s): the seek bar, the times and the countdown, written only when they change
  function drawTime(force) {
    if (!form.stage) return
    const d = dur()
    const p = d ? Math.min(1, Math.max(0, time / d)) : 0
    if (force || Math.abs(p - seekP) >= 0.0005) {
      seekP = p
      el.seekFill.style.transform = 'scaleX(' + p.toFixed(4) + ')'
      el.seekRun.style.transform = 'translateX(' + (p * 100).toFixed(2) + '%)'
    }
    const sec = Math.floor(time)
    if (!force && sec === shownSec) return
    shownSec = sec
    text(el.tEl, M.clock(time))
    text(el.tRem, d ? '-' + M.clock(Math.ceil(d - time)) : '')
    el.seek.setAttribute('aria-valuenow', String(Math.round(time)))
    el.seek.setAttribute('aria-valuemax', String(Math.round(d)))
    el.seek.setAttribute('aria-valuetext', M.clock(time) + ' of ' + M.clock(d))
    text(el.nextIn, M.countdown(d, time))
    text(el.footR, M.timeLeft(q, d, time))
  }

  // the list scrolled so the song playing sits near the top, one or two played songs above it: on open and
  // on a new song, not while the user is scrolling (SCROLL_QUIET after their last scroll), or at once (force: the chip)
  function showPlaying(force) {
    const cur = el.list.querySelector('.q-row.cur')
    if (!cur) return
    const li = cur.parentElement
    const above = li.previousElementSibling && li.previousElementSibling.previousElementSibling ? li.previousElementSibling.previousElementSibling : li.previousElementSibling || li
    el.list.scrollTop = Math.max(0, el.list.scrollTop + above.getBoundingClientRect().top - el.list.getBoundingClientRect().top - 4)
    if (force) {
      cur.classList.remove('flash')
      void cur.offsetWidth   // restart the glow
      cur.classList.add('flash')
      say('Playing now: ' + (np && np.title ? np.title : ''))
    }
  }

  let listKey = ''
  function drawQueue(force) {
    if (!form.stage) return
    const v = M.queueList(q)
    const nx = v.next
    el.nextCard.hidden = !nx
    if (nx) {
      text(el.nextT, nx.title || 'Untitled')
      text(el.nextS, [nx.artist, nx.album].filter(Boolean).join(' · '))
      text(el.nextD, nx.duration ? M.clock(nx.duration) : '')
      el.nextT.title = el.nextT.textContent
      el.nextS.title = el.nextS.textContent
      el.nextCard.title = 'Skip to ' + (nx.title || 'the next song')
      el.nextCard.setAttribute('aria-label', 'Next: ' + (nx.title || 'Untitled') + (nx.artist ? ', ' + nx.artist : '') + '. Skip to it')
      el.nextCard.dataset.index = String(nx.index)
      el.nextCard.dataset.id = nx.id
      if ((nx.art || '') !== (el.nextArt.dataset.src || '')) {
        el.nextArt.dataset.src = nx.art || ''
        if (nx.art) el.nextArt.src = nx.art
        else el.nextArt.removeAttribute('src')
      }
      el.nextArt.hidden = !nx.art
    }
    const key = (q ? q.position : -1) + '|' + v.earlier + '|' + v.rows.length + '|' + (q && q.canPlay) + '|' + (q ? q.items.length : 0) + '|' + (v.rows[0] ? q.items[v.rows[0].index].id : '') + '|' + (nx ? nx.id : '')
    if (!force && key === listKey) { drawTrack(); return }
    listKey = key
    const canPlay = !!(q && q.canPlay)
    const focusedIn = el.list.contains(doc.activeElement)
    const lis = []
    if (v.earlier) { const li = doc.createElement('li'); li.className = 'q-more'; li.textContent = v.earlier + (v.earlier === 1 ? ' earlier song' : ' earlier songs'); lis.push(li) }
    // loop: NOT-WORTH — the list's rows (≤ 201), once per queue change or song
    v.rows.forEach((r, i) => {
      const li = doc.createElement('li')
      const row = doc.createElement(canPlay && !r.cur ? 'button' : 'div')
      row.className = 'q-row' + (r.cur ? ' cur' : '') + (r.played ? ' played' : '')
      const item = q.items[r.index]
      row.dataset.index = String(r.index)
      row.dataset.id = item.id
      const n = doc.createElement('span')
      n.className = 'n'
      if (r.cur) { n.className = 'n eq'; n.setAttribute('aria-hidden', 'true'); n.append(doc.createElement('i'), doc.createElement('i'), doc.createElement('i')) }
      else n.textContent = String(r.n)
      const t = doc.createElement('span')
      t.className = 't'
      t.textContent = r.title
      const small = doc.createElement('small')
      small.textContent = r.autoplay ? 'Autoplay' + (r.sub ? ' · ' + r.sub : '') : r.sub
      t.appendChild(small)
      const d = doc.createElement('span')
      d.className = 'd'
      d.textContent = r.time
      row.append(n, t, d)
      row.title = r.title + (r.sub ? ' — ' + r.sub : '') + (r.cur ? '' : ' (click: play it; right-click: more)')
      if (r.cur) { row.setAttribute('aria-current', 'true'); row.setAttribute('aria-label', 'Playing now: ' + r.title) }
      if (row.tagName === 'BUTTON') {
        row.tabIndex = -1
        row.setAttribute('aria-label', 'Play ' + r.title + (r.sub ? ', ' + r.sub : '') + (r.played ? ' (played)' : ''))
        // lifetime: OK — one click handler per row, dropped with the row on the next redraw
        row.onclick = () => send('play-item', { index: item.index, id: item.id })
      }
      li.appendChild(row)
      if (item.id) {
        const m = doc.createElement('button')
        m.className = 'ib small q-menu'
        m.tabIndex = -1
        m.setAttribute('aria-label', 'More for ' + r.title)
        m.title = 'More: ' + (r.cur ? '' : 'Play Now, Play Next, ') + 'Go to Album, Credits'
        m.setAttribute('aria-haspopup', 'menu')
        m.appendChild(icon(doc, 'more'))
        // lifetime: OK — one click handler per row's ⋯, dropped with the row
        m.onclick = () => rowMenu(row)
        li.appendChild(m)
      }
      lis.push(li)
      if (i === v.cardAt) { const cli = doc.createElement('li'); cli.appendChild(el.nextCard); lis.push(cli) }
    })
    if (v.cardAt < 0) el.list.after(el.nextCard)   // no next song: the card waits (hidden) beside the list
    if (v.later) { const li = doc.createElement('li'); li.className = 'q-more'; li.textContent = v.later + (v.later === 1 ? ' more song' : ' more songs'); lis.push(li) }
    el.list.replaceChildren(...lis)
    el.nextCard.tabIndex = -1
    const first = el.list.querySelector('button.q-row')
    if (first) first.tabIndex = 0
    // the note under the list: nothing to show, read-only, the last song
    const notes = []
    if (!q) notes.push('Waiting for Apple Music\'s queue…')
    else if (!v.rows.length) notes.push('Nothing in the queue')
    if (q && !canPlay && v.rows.length) notes.push('Read-only: Apple Music\'s player doesn\'t offer jumping to a song here')
    if (v.last && v.rows.length > 1) notes.push('That\'s the last one')
    el.note2.hidden = !notes.length
    text(el.note2, notes.join(' · '))
    if (focusedIn && first) first.focus({ focusVisible: true })
    const sk = songKey() + '|' + (q ? q.position : -1)
    if (sk !== scrolledFor && now() - userScrolled > SCROLL_QUIET) { scrolledFor = sk; showPlaying(false) }
    drawTrack()
    drawTime(true)
  }

  return {
    setForm,
    setBand,
    flip,
    said,
    rowCredits,
    get shown() { return !!form.stage },
    get turned() { return turned },
    setNowPlaying(n) {
      const before = songKey()
      np = n && typeof n === 'object' ? n : null
      if (linerNone && linerNone !== albumKey()) { linerNone = ''; el.tLiner.querySelector('small').textContent = 'Booklet' }
      // a new song: the cover turns back to its front (the new cover); its credits are a click away
      if (songKey() !== before) { flip(false); drawCredits() }
      drawNowPlaying()
      drawTime(true)
    },
    setSong(st) {
      if (!st || typeof st !== 'object' || st.key !== songKey()) return
      song = st
      drawSong()
    },
    setCredits(c) {
      if (!c || typeof c !== 'object') return
      credits = c
      drawCredits()
    },
    setQueue(raw) {
      q = M.cleanQueue(raw)
      drawQueue(false)
    },
    // the Liner notes tile's answer from main: false when no album matched the song (the booklet
    // didn't open): the tile says so until the album changes or a click finds one, and screen readers hear it
    linerFound(ok) {
      linerNone = ok ? '' : albumKey()
      el.tLiner.querySelector('small').textContent = ok ? 'Booklet' : 'No album found'
      if (!ok) say('Liner notes: no album found for this song')
    },
    setTime(t) {
      const v = Number(t)
      if (seeking) return
      if (Number.isFinite(v)) time = v
      drawTime(false)
    }
  }
}

module.exports = { createStage, PATHS }
