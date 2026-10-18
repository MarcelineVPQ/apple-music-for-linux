// The stage view's pure logic (no DOM, no Electron): the lyrics window grown into the now-playing
// stage (lyrics.html body.stage, stage-ui.js). The queue as Apple's player holds it (main.js
// stageQueueScript, read-only), "Track N of M", the countdown to the next song, the time left, the
// live chip, the window's size, and the checks on what the page may ask main to do. Tested in
// test/stage-model.test.js.
'use strict'

// the stage's smallest size: the three columns (292 + 312 px) and room for the lyrics between
const STAGE_MIN = { width: 980, height: 620 }
const STAGE_DEFAULT = { width: 1240, height: 780 }
const COMPACT_MIN = { width: 260, height: 300 }
const COMPACT_DEFAULT = { width: 380, height: 560 }
// what the list shows: a window around the song playing (the played songs before it, the upcoming after)
const PLAYLIST_BEFORE = 50
const PLAYLIST_AFTER = 150
// at most this many queue items cross from Apple's page per read (main.js stageQueueScript)
const QUEUE_MAX = 1000

const str = (v, max) => (typeof v === 'string' ? v : v == null ? '' : String(v)).slice(0, max || 300)
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0)

/** Seconds as a clock: 82 -> '1:22', 3725 -> '1:02:05'; negative or junk -> '0:00'. */
function clock(s) {
  const t = Math.max(0, Math.floor(num(s)))
  const h = Math.floor(t / 3600)
  const m = Math.floor((t % 3600) / 60)
  const ss = String(t % 60).padStart(2, '0')
  return h ? h + ':' + String(m).padStart(2, '0') + ':' + ss : m + ':' + ss
}

/**
 * The queue as read from Apple's page, cleaned: every field the right kind and bounded, the
 * position an index into the items or -1. -> { items: [{ index, id, title, artist, album, duration,
 * art, autoplay, albumId, composer }], position, canPlay, container: { type, name } | null }
 */
function cleanQueue(raw) {
  const r = raw && typeof raw === 'object' ? raw : {}
  const list = Array.isArray(r.items) ? r.items.slice(0, QUEUE_MAX) : []
  const items = list.map((it, index) => {
    const x = it && typeof it === 'object' ? it : {}
    return {
      index,
      id: str(x.id, 64),
      title: str(x.title),
      artist: str(x.artist),
      album: str(x.album),
      duration: Math.max(0, num(x.duration)),
      art: /^https:\/\//.test(str(x.art, 600)) ? str(x.art, 600) : '',
      autoplay: !!x.autoplay,
      albumId: /^\d{1,20}$/.test(str(x.albumId, 20)) ? str(x.albumId, 20) : '',
      composer: str(x.composer)
    }
  })
  const p = Number(r.position)
  const position = Number.isInteger(p) && p >= 0 && p < items.length ? p : -1
  const c = r.container && typeof r.container === 'object' ? { type: str(r.container.type, 40), name: str(r.container.name) } : null
  return { items, position, canPlay: !!r.canPlay, container: c && (c.type || c.name) ? c : null }
}

/**
 * Where the song sits in its album or playlist (the queue Apple built from it), in Marcy's words:
 * 'Track 13 of 24'. Autoplay songs Apple adds after the end don't count. Shuffled: the place in
 * the play order, said as such. null when it doesn't tell anything (one song, or an autoplay song).
 */
function trackOf(q, shuffled) {
  if (!q || !Array.isArray(q.items) || q.position < 0) return null
  const listed = q.items.filter((it) => !it.autoplay)
  const at = listed.findIndex((it) => it.index === q.position)
  if (at < 0 || listed.length < 2) return null
  const n = at + 1
  const m = listed.length
  return { n, m, shuffled: !!shuffled, text: shuffled ? n + ' of ' + m + ', shuffled' : 'Track ' + n + ' of ' + m }
}

/** The song after the one playing, or null at the end of the queue. */
function nextItem(q) {
  if (!q || !Array.isArray(q.items) || q.position < 0) return null
  return q.items[q.position + 1] || null
}

/** The countdown on the next card: 'Next · in 1:22' (the song playing's time left). */
function countdown(duration, time) {
  const d = num(duration)
  if (d <= 0) return 'Next'
  return 'Next · in ' + clock(Math.ceil(Math.max(0, d - num(time))))
}

/**
 * Listening time left in the album or playlist, from the playing song's position: '1 h 17 min left',
 * '23 min left', 'Less than a minute left'; '' with no queue.
 */
function timeLeft(q, duration, time) {
  if (!q || !Array.isArray(q.items) || q.position < 0) return ''
  let s = Math.max(0, num(duration) - num(time))
  // loop: NOT-WORTH — the queue's songs after the one playing (≤ 1000), once per queue change or song
  for (let i = q.position + 1; i < q.items.length; i++) if (!q.items[i].autoplay) s += q.items[i].duration
  const min = Math.round(s / 60)
  if (min < 1) return s > 0 ? 'Less than a minute left' : ''
  const h = Math.floor(min / 60)
  return (h ? h + ' h ' + (min % 60) + ' min' : min + ' min') + ' left'
}

/**
 * The right column's one list (no tabs): the songs already played (dimmed; the last PLAYLIST_BEFORE of
 * them), the one playing, then the next card's place, then the songs after the card's (at most
 * PLAYLIST_AFTER). The next song shows only in the card, never as a row as well. Nothing playing: the queue
 * from its start, no card.
 * -> { rows: [{ index, n, title, sub, time, cur, played, autoplay }], cardAt (the row the card follows, or -1),
 *      next (the card's song or null), last (the song playing is the last one), earlier, later, total }
 */
function queueList(q) {
  const items = q && Array.isArray(q.items) ? q.items : []
  const pos = q && q.position >= 0 && q.position < items.length ? q.position : -1
  const next = pos >= 0 ? items[pos + 1] || null : null
  const from = pos >= 0 ? Math.max(0, pos - PLAYLIST_BEFORE) : 0
  const startAfter = pos >= 0 ? Math.min(items.length, pos + (next ? 2 : 1)) : 0
  const to = Math.min(items.length, startAfter + PLAYLIST_AFTER)
  const row = (it) => ({
    index: it.index,
    n: it.index + 1,
    title: it.title || 'Untitled',
    sub: [it.artist, it.album].filter(Boolean).join(' · '),
    time: it.duration ? clock(it.duration) : '',
    cur: it.index === pos,
    played: pos >= 0 && it.index < pos,
    autoplay: it.autoplay
  })
  const head = pos >= 0 ? items.slice(from, pos + 1) : []
  const rows = head.concat(items.slice(startAfter, to)).map(row)
  return { rows, cardAt: next ? head.length - 1 : -1, next, last: pos >= 0 && !next, earlier: from, later: items.length - to, total: items.length }
}

/** 'Playing from <name>' when Apple says what the queue was built from, else ''. */
function playingFrom(q) {
  return q && q.container && q.container.name ? q.container.name : ''
}

/**
 * The live chip for a live album, from real data only: 'Live · The Gorge' when the album's title
 * names the venue ("… Live at the Gorge"), 'Live' for "(Live)"; the recording date only when one is
 * known (recorded: e.g. 'Aug 30, 2025', from the liner notes). '' for a studio album.
 */
function liveChip(album, recorded) {
  const a = str(album)
  if (!/\blive\b/i.test(a)) return ''
  const m = /\blive (?:at|from|in) (.+?)\s*(?:[()[\]]|\s-\s|$)/i.exec(a)
  let venue = m ? m[1].trim() : ''
  if (/^the\s/.test(venue)) venue = 'T' + venue.slice(1)
  return ['Live', str(recorded, 60).trim(), venue].filter(Boolean).join(' · ')
}

/**
 * The lyric line a key moves to (the Studio's ↑ / ↓): dir +1 the next line's start; dir -1 the start of the
 * line being sung when more than 1.5 s of it has passed, else the line before. lines: [{ t }] sorted.
 * -> the time to seek to, or null (no timed lines, or nothing that way).
 */
function lineStep(lines, time, dir) {
  const ts = (Array.isArray(lines) ? lines : []).map((l) => l && l.t).filter((t) => Number.isFinite(t))
  if (!ts.length) return null
  const now = num(time)
  if (dir > 0) { const t = ts.find((x) => x > now + 0.25); return t === undefined ? null : t }
  let cur = -1
  // loop: NOT-WORTH — the song's lines (≤ ~150), once per key press
  for (let i = 0; i < ts.length; i++) if (ts[i] <= now + 0.25) cur = i
  if (cur < 0) return null
  if (now - ts[cur] > 1.5) return ts[cur]
  return cur > 0 ? ts[cur - 1] : ts[0]
}

/** The words sung at a time (the seek bar's hover): the last timed line that started by then, or ''. */
function lineAt(lines, time) {
  let text = ''
  const t = num(time)
  // loop: NOT-WORTH — the song's lines (≤ ~150), once per hover move over the seek bar
  for (const l of Array.isArray(lines) ? lines : []) if (l && Number.isFinite(l.t) && l.t <= t) text = str(l.text, 160)
  return text
}

/** The year of a release date ('2026-05-01' -> '2026'), or ''. */
function yearOf(date) {
  const m = /^(\d{4})/.exec(str(date, 40))
  return m ? m[1] : ''
}

// a saved size that still fits the screen's work area (at least half of it on screen), else null
function fitSaved(saved, area, min) {
  if (!saved || !Number.isInteger(saved.width) || !Number.isInteger(saved.height)) return null
  const width = Math.min(Math.max(saved.width, Math.min(min.width, area.width)), area.width)
  const height = Math.min(Math.max(saved.height, Math.min(min.height, area.height)), area.height)
  if (!Number.isInteger(saved.x) || !Number.isInteger(saved.y)) return { width, height, x: area.x + Math.round((area.width - width) / 2), y: area.y + Math.round((area.height - height) / 2) }
  const x = Math.min(Math.max(saved.x, area.x), area.x + area.width - width)
  const y = Math.min(Math.max(saved.y, area.y), area.y + area.height - height)
  return { x, y, width, height }
}

/**
 * The window's bounds for a form ('stage' or 'compact'): the size it last had in that form (kept on
 * the screen), else the default size centred in the work area, never smaller than the form's
 * minimum or larger than the work area.
 */
function windowBounds(form, saved, area) {
  const stage = form === 'stage'
  const min = stage ? STAGE_MIN : COMPACT_MIN
  const fit = fitSaved(saved, area, min)
  if (fit) return fit
  const def = stage ? STAGE_DEFAULT : COMPACT_DEFAULT
  const width = Math.min(stage ? Math.max(min.width, Math.min(def.width, area.width - 80)) : def.width, area.width)
  const height = Math.min(stage ? Math.max(min.height, Math.min(def.height, area.height - 80)) : def.height, area.height)
  return { x: area.x + Math.round((area.width - width) / 2), y: area.y + Math.round((area.height - height) / 2), width, height }
}

/** The form's smallest window size on this work area. */
function minSize(form, area) {
  const min = form === 'stage' ? STAGE_MIN : COMPACT_MIN
  return { width: Math.min(min.width, area.width), height: Math.min(min.height, area.height) }
}

/**
 * A 'stage-command' from the lyrics page, checked: the command one of the stage's, its value the
 * right kind and in range. -> { command, value } or null (dropped).
 */
const PLAIN = ['play-pause', 'next', 'previous', 'shuffle', 'repeat', 'liner-notes',
  // the song's actions under the volume (song-actions.js through main) and the cover's back ("More in the liner notes")
  'song-library', 'song-link', 'song-album', 'song-artist', 'credits-liner', 'liner-recording']
// the menus' anchor: the button's lower-left corner in the window (CSS px)
const anchor = (v) => (v && typeof v === 'object' && Number.isInteger(v.x) && Number.isInteger(v.y) && v.x >= 0 && v.y >= 0 && v.x <= 20000 && v.y <= 20000 ? { x: v.x, y: v.y } : null)
const numeric = (v) => (typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v) : NaN)
function stageCommand(command, value) {
  if (typeof command !== 'string') return null
  if (PLAIN.includes(command)) return { command, value: null }
  // Favorite: the state wanted (true: favourite it, false: undo), so a double click can't flip it twice
  if (command === 'song-favorite') return typeof value === 'boolean' ? { command, value } : null
  if (command === 'song-playlists' || command === 'song-more') { const a = anchor(value); return a ? { command, value: a } : null }
  if (command === 'form') return value === 'stage' || value === 'compact' ? { command, value } : null
  // the Montage tile (on/off) and its credit line (a photo's id, its Commons file name: main looks it up
  // in the photos it sent and opens that photo's page, never a URL from the page)
  if (command === 'montage') return typeof value === 'boolean' ? { command, value } : null
  if (command === 'montage-credit') return typeof value === 'string' && value.length > 0 && value.length <= 300 && !/[\u0000-\u001f]/.test(value) ? { command, value } : null
  // the Sheet notes tile: Settings' "Sheet notes in the Studio" on or off
  if (command === 'sheet-notes') return typeof value === 'boolean' ? { command, value } : null
  // the band's placement buttons: Settings' "Sheet notes placement"
  if (command === 'sheet-place') return value === 'band' || value === 'over' ? { command, value } : null
  if (command === 'seek') { const t = numeric(value); return Number.isFinite(t) && t >= 0 && t <= 86400 ? { command, value: t } : null }
  if (command === 'volume') { const v = numeric(value); return Number.isFinite(v) && v >= 0 && v <= 1 ? { command, value: v } : null }
  // a queue row's menu: the row (index and id, checked again by main against the queue it sent) and its anchor
  if (command === 'row-menu') {
    const v = value && typeof value === 'object' ? value : {}
    const a = anchor(v)
    const ok = a && Number.isInteger(v.index) && v.index >= 0 && v.index < QUEUE_MAX && typeof v.id === 'string' && /^[\w.:-]{1,64}$/.test(v.id)
    return ok ? { command, value: { index: v.index, id: v.id, x: a.x, y: a.y } } : null
  }
  if (command === 'play-item') {
    const v = value && typeof value === 'object' ? value : {}
    const ok = Number.isInteger(v.index) && v.index >= 0 && v.index < QUEUE_MAX && typeof v.id === 'string' && /^[\w.:-]{1,64}$/.test(v.id)
    return ok ? { command, value: { index: v.index, id: v.id } } : null
  }
  return null
}

module.exports = {
  STAGE_MIN, STAGE_DEFAULT, COMPACT_MIN, COMPACT_DEFAULT, PLAYLIST_BEFORE, PLAYLIST_AFTER, QUEUE_MAX,
  clock, cleanQueue, trackOf, nextItem, countdown, timeLeft, queueList, playingFrom, liveChip, yearOf, lineStep, lineAt,
  windowBounds, minSize, stageCommand
}
