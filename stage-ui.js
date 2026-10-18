// The stage view's page half (lyrics.html body.stage): the lyrics window grown into the now-playing
// stage. Left: the cover, the song, "Track N of M", the live chip and the transport. Right: Up Next /
// Playlist and the "Next · in 1:22" card. The lyrics in the middle are the lyrics window's own engine
// (lyrics-view.js, one engine). Data comes from main.js: 'stage-np' (the song, on change only),
// 'stage-queue' (Apple's queue, read-only, polled only while the stage shows) and the lyrics feed's
// 'lyrics-time' pushes. The logic is stage-model.js (tested); this file only draws it.
//
// Render path: nothing here animates on its own. The seek bar, the volume and the track chip move by
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
  shrink: 'M5 2h1.5v4.5H2V5h3zm4.5 0H11v3h3v1.5H9.5zM2 9.5h4.5V14H5v-3H2zm7.5 0H14V11h-3v3H9.5z'
}
const SVG = 'http://www.w3.org/2000/svg'
function icon(doc, name) {
  const svg = doc.createElementNS(SVG, 'svg')
  svg.setAttribute('viewBox', '0 0 16 16')
  svg.setAttribute('aria-hidden', 'true')
  svg.setAttribute('focusable', 'false')
  const p = doc.createElementNS(SVG, 'path')
  p.setAttribute('d', PATHS[name])
  svg.appendChild(p)
  return svg
}
function setIcon(el, name) {
  if (el.dataset.icon === name) return
  el.dataset.icon = name
  el.replaceChildren(icon(el.ownerDocument, name))
}

/**
 * createStage({ doc, send(command, value), onLayout() }) -> { setForm, setNowPlaying, setQueue,
 * setTime, setBand, setSheet, shown }. send: ipcRenderer.send('stage-command', …). onLayout: the stage's
 * layout changed (the page recentres the lyrics and moves its drag grip).
 */
function createStage(opts) {
  const doc = opts.doc
  const $ = (id) => doc.getElementById(id)
  const send = opts.send
  const body = doc.body
  const el = {
    cover: $('cover'), title: $('np-title'), artist: $('np-artist'), album: $('np-album'),
    chipTrack: $('chip-track'), chipLive: $('chip-live'),
    seek: $('seek-bar'), seekFill: $('seek-fill'), seekRun: $('seek-run'), tEl: $('t-el'), tRem: $('t-rem'),
    shuffle: $('b-shuffle'), prev: $('b-prev'), play: $('b-play'), next: $('b-next'), repeat: $('b-repeat'), repeatOne: $('repeat-one'),
    vol: $('vol-bar'), volFill: $('vol-fill'), volRun: $('vol-run'),
    layers: $('layers'), tNotes: $('t-notes'), tMontage: $('t-montage'), tLiner: $('t-liner'), band: $('band'),
    ctx: $('ctx'), qTitle: $('q-title'), tabNext: $('tab-next'), tabAll: $('tab-all'),
    nextCard: $('next-card'), nextArt: $('next-art'), nextIn: $('next-in'), nextT: $('next-t'), nextS: $('next-s'),
    list: $('q-list'), note: $('q-note'), footL: $('q-foot-l'), footR: $('q-foot-r')
  }
  let form = { stage: false, linerNotes: false }
  let np = null           // 'stage-np': { title, artist, album, art, duration, isPlaying, shuffle, repeat, volume, releaseDate }
  let q = null            // stage-model cleanQueue
  let which = 'next'      // the right column's tab
  let time = 0
  let shownSec = -1       // the whole second the times and the countdown show
  let seekP = -1          // the fraction the seek bar shows
  let volShown = -1
  let bandNode = null     // the sheet-notes band's content (sheet-notes-ui.js), set once by the page
  let sheetOn = false     // Settings' "Sheet notes in the Studio" (Experimental), as main last said
  let sheetMsg = false    // the band holds only a one-line message (nothing to draw for this song)
  let sheetOver = false   // "Over the sung line": the staff rides in the lyrics, the band row stays empty
  let linerNone = ''      // the album (albumKey) the Liner notes tile found no booklet for: it says so until the album changes
  const albumKey = () => (np ? (np.album || '') + '|' + (np.artist || '') : '|')

  setIcon(el.shuffle, 'shuffle'); setIcon(el.prev, 'prev'); setIcon(el.play, 'play'); setIcon(el.next, 'next'); setIcon(el.repeat, 'repeat')
  setIcon($('i-vol'), 'vol')
  setIcon(el.tNotes.querySelector('.ti'), 'note'); setIcon(el.tMontage.querySelector('.ti'), 'photo'); setIcon(el.tLiner.querySelector('.ti'), 'book')

  // --- the transport: each button sends its command; Apple's player answers through 'stage-np' ---
  // lifetime: OK — one click handler per control, set once at load, released with the window
  el.play.onclick = () => send('play-pause')
  el.prev.onclick = () => send('previous')
  el.next.onclick = () => send('next')
  el.shuffle.onclick = () => send('shuffle')
  el.repeat.onclick = () => send('repeat')
  el.tLiner.onclick = () => send('liner-notes')
  // the Sheet notes tile is the setting itself (main turns it on or off and answers with 'lyrics-sheet')
  el.tNotes.onclick = () => send('sheet-notes', !sheetOn)

  // --- the two sliders (song position, volume): pointer and keyboard ---
  // set(fraction, done): done on release and on a key (the seek is sent then; the volume as it moves)
  // keyTo(key, fraction): where a key takes the slider, or null for a key it doesn't use
  function slider(bar, get, set, keyTo) {
    let dragging = false
    const at = (e) => { const r = bar.getBoundingClientRect(); return Math.min(1, Math.max(0, (e.clientX - r.left) / Math.max(1, r.width))) }
    // lifetime: OK — the bar's pointer and key handlers, set once at load, released with the window
    bar.onpointerdown = (e) => { if (e.button !== 0) return; dragging = true; bar.setPointerCapture(e.pointerId); set(at(e), false) }
    bar.onpointermove = (e) => { if (dragging) set(at(e), false) }
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

  // --- the right column's tabs: Up Next / Playlist ---
  // lifetime: OK — two click handlers, set once at load
  el.tabNext.onclick = () => setTab('next')
  el.tabAll.onclick = () => setTab('all')
  function setTab(w) {
    if (w === which) return
    which = w
    el.tabNext.setAttribute('aria-pressed', String(w === 'next'))
    el.tabAll.setAttribute('aria-pressed', String(w === 'all'))
    drawQueue(true)
    if (opts.onLayout) opts.onLayout()
  }

  // the list: one Tab stop, Up/Down/Home/End move between the songs, Enter/Space plays one
  // lifetime: OK — one keydown listener on the list, released with the window
  el.list.addEventListener('keydown', (e) => {
    if (e.ctrlKey || e.altKey || e.metaKey) return
    const rows = [...el.list.querySelectorAll('button.q-row')]
    const at = rows.indexOf(doc.activeElement)
    if (at < 0) return
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
    if (form.stage) { shownSec = -1; seekP = -1; volShown = -1; drawNowPlaying(); drawQueue(true); drawTime(true) }
    if (opts.onLayout) opts.onLayout()
  }

  // the sheet-notes band (the +1, Experimental): its tile shows in the Studio and switches it; on, the band
  // sits above the words (a one-line message when this song has nothing to draw, never an empty box);
  // off, it folds away and the lyrics take the room
  function showBand() {
    const has = !!bandNode && !!form.stage
    el.tNotes.hidden = !has
    el.tNotes.setAttribute('aria-pressed', String(has && sheetOn))
    el.tNotes.querySelector('small').textContent = sheetOn ? 'Experimental' : 'Off'
    el.tNotes.title = sheetOn ? 'Sheet notes are on (Experimental): click to fold the band away' : 'The sung melody as notes above the lyrics, in sync (Experimental): click to turn on'
    const was = el.band.hidden
    el.band.hidden = !(has && sheetOn) || sheetOver
    el.band.classList.toggle('msg', sheetMsg)
    el.layers.hidden = el.tNotes.hidden && el.tMontage.hidden && el.tLiner.hidden
    return was !== el.band.hidden
  }
  function setBand(node) {
    if (node === bandNode) return
    bandNode = node || null
    el.band.replaceChildren(...(bandNode ? [bandNode] : []))
    showBand()
    if (opts.onLayout) opts.onLayout()
  }
  // main's word on the switch (on), whether the band holds only a message (msg), and whether the staff
  // rides over the sung line instead (over: the page moved it into the lyrics)
  function setSheet(on, msg, over) {
    const changed = sheetOn !== !!on || sheetMsg !== !!msg || sheetOver !== !!over
    sheetOn = !!on
    sheetMsg = !!msg
    sheetOver = !!over
    showBand()
    if (changed && opts.onLayout) opts.onLayout()
  }

  function text(node, value) { if (node.textContent !== value) node.textContent = value }

  function drawNowPlaying() {
    if (!form.stage) return
    const n = np || {}
    text(el.title, n.title || 'Nothing playing')
    text(el.artist, n.artist || '')
    const year = M.yearOf(n.releaseDate)
    text(el.album, (n.album || '') + (n.album && year ? ' · ' + year : ''))
    el.album.title = el.album.textContent
    el.title.title = el.title.textContent
    if ((n.art || '') !== (el.cover.dataset.src || '')) {
      el.cover.dataset.src = n.art || ''
      if (n.art) el.cover.src = n.art
      else el.cover.removeAttribute('src')
      el.cover.hidden = !n.art
    }
    const live = M.liveChip(n.album)
    el.chipLive.hidden = !live
    text(el.chipLive.querySelector('span'), live)
    el.play.setAttribute('aria-label', n.isPlaying ? 'Pause' : 'Play')
    el.play.title = n.isPlaying ? 'Pause' : 'Play'
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

  let listKey = ''
  function drawQueue(force) {
    if (!form.stage) return
    const nx = M.nextItem(q)
    el.qTitle.textContent = which === 'next' ? 'Up Next' : 'Playlist'
    el.tabAll.textContent = M.playlistLabel(q)
    el.tabAll.setAttribute('aria-label', el.tabAll.textContent)
    el.nextCard.hidden = which !== 'next' || !nx
    if (nx) {
      text(el.nextT, nx.title || 'Untitled')
      text(el.nextS, [nx.artist, nx.duration ? M.clock(nx.duration) : '', nx.album].filter(Boolean).join(' · '))
      el.nextT.title = el.nextT.textContent
      el.nextS.title = el.nextS.textContent
      if ((nx.art || '') !== (el.nextArt.dataset.src || '')) {
        el.nextArt.dataset.src = nx.art || ''
        if (nx.art) el.nextArt.src = nx.art
        else el.nextArt.removeAttribute('src')
      }
      el.nextArt.hidden = !nx.art
    }
    const view = M.queueRows(q, which)
    const key = which + '|' + (q ? q.position : -1) + '|' + view.from + '|' + view.to + '|' + (q && q.canPlay) + '|' + (q ? q.items.length : 0) + '|' + (q && q.items[view.from] ? q.items[view.from].id : '')
    if (!force && key === listKey) { drawTrack(); return }
    listKey = key
    const canPlay = !!(q && q.canPlay)
    const focusedIn = el.list.contains(doc.activeElement)
    const rows = view.rows.map((r) => {
      const li = doc.createElement('li')
      const row = doc.createElement(canPlay && !r.cur ? 'button' : 'div')
      row.className = 'q-row' + (r.cur ? ' cur' : '') + (r.played ? ' played' : '')
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
      row.title = r.title + (r.sub ? ' — ' + r.sub : '')
      if (r.cur) { row.setAttribute('aria-current', 'true'); row.setAttribute('aria-label', 'Playing now: ' + r.title) }
      if (row.tagName === 'BUTTON') {
        row.tabIndex = -1
        row.setAttribute('aria-label', 'Play ' + r.title + (r.sub ? ', ' + r.sub : ''))
        const item = q.items[r.index]
        // lifetime: OK — one click handler per row, dropped with the row on the next redraw
        row.onclick = () => send('play-item', { index: item.index, id: item.id })
      }
      li.appendChild(row)
      return li
    })
    el.list.replaceChildren(...rows)
    el.list.setAttribute('aria-label', which === 'next' ? 'Up Next' : 'Playlist')
    const first = el.list.querySelector('button.q-row')
    if (first) first.tabIndex = 0
    // the note under the list: nothing to show, read-only, or only part of a long playlist shown
    const notes = []
    if (!q) notes.push('Waiting for Apple Music\'s queue…')
    else if (!view.rows.length) notes.push(which === 'next' ? 'Nothing up next' : 'Nothing in the queue')
    if (q && !canPlay && view.rows.length) notes.push('Read-only: Apple Music\'s player doesn\'t offer jumping to a song here')
    if (view.more) notes.push('Showing ' + view.rows.length + ' of ' + view.total + ' songs')
    el.note.hidden = !notes.length
    text(el.note, notes.join(' · '))
    if (which === 'all') {
      const cur = el.list.querySelector('.cur')
      el.list.scrollTop = cur ? Math.max(0, cur.parentElement.offsetTop - el.list.clientHeight * 0.35) : 0
    } else el.list.scrollTop = 0
    if (focusedIn && first) first.focus({ focusVisible: true })
    drawTrack()
    drawTime(true)
  }

  return {
    setForm,
    setBand,
    setSheet,
    get shown() { return !!form.stage },
    setNowPlaying(n) {
      np = n && typeof n === 'object' ? n : null
      if (linerNone && linerNone !== albumKey()) { linerNone = ''; el.tLiner.querySelector('small').textContent = 'Booklet' }
      drawNowPlaying()
      drawTime(true)
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
      const say = doc.getElementById('say')
      if (!ok && say) say.textContent = 'Liner notes: no album found for this song'
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
