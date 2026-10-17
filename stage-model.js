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
// what the lists show: Up Next the next 100 songs, the Playlist a window around the song playing
const UP_NEXT_MAX = 100
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
 * art, autoplay }], position, canPlay, container: { type, name } | null }
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
      autoplay: !!x.autoplay
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
 * The rows of the right column. which 'next': the songs after the one playing (at most 100);
 * 'all': the album or playlist, a window of 50 before and 150 after the song playing.
 * -> { rows: [{ index, n, title, sub, time, cur, played, autoplay }], from, to, total, more }
 */
function queueRows(q, which) {
  const items = q && Array.isArray(q.items) ? q.items : []
  const pos = q && q.position >= 0 ? q.position : -1
  let from, to
  if (which === 'next') { from = pos + 1; to = Math.min(items.length, from + UP_NEXT_MAX) }
  else {
    from = Math.max(0, (pos < 0 ? 0 : pos) - PLAYLIST_BEFORE)
    to = Math.min(items.length, (pos < 0 ? 0 : pos) + PLAYLIST_AFTER + 1)
  }
  const rows = items.slice(from, to).map((it) => ({
    index: it.index,
    n: it.index + 1,
    title: it.title || 'Untitled',
    sub: [it.artist, it.album].filter(Boolean).join(' · '),
    time: it.duration ? clock(it.duration) : '',
    cur: it.index === pos,
    played: pos >= 0 && it.index < pos,
    autoplay: it.autoplay
  }))
  return { rows, from, to, total: items.length, more: to < items.length || (which !== 'next' && from > 0) }
}

/** The playlist tab's name: 'Playlist · 24' (the album's or playlist's songs, autoplay left out). */
function playlistLabel(q) {
  const n = q && Array.isArray(q.items) ? q.items.filter((it) => !it.autoplay).length : 0
  return n ? 'Playlist · ' + n : 'Playlist'
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
const PLAIN = ['play-pause', 'next', 'previous', 'shuffle', 'repeat', 'liner-notes']
const numeric = (v) => (typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v) : NaN)
function stageCommand(command, value) {
  if (typeof command !== 'string') return null
  if (PLAIN.includes(command)) return { command, value: null }
  if (command === 'form') return value === 'stage' || value === 'compact' ? { command, value } : null
  // the Montage tile (on/off) and its credit line (a photo's id, its Commons file name: main looks it up
  // in the photos it sent and opens that photo's page, never a URL from the page)
  if (command === 'montage') return typeof value === 'boolean' ? { command, value } : null
  if (command === 'montage-credit') return typeof value === 'string' && value.length > 0 && value.length <= 300 && !/[\u0000-\u001f]/.test(value) ? { command, value } : null
  if (command === 'seek') { const t = numeric(value); return Number.isFinite(t) && t >= 0 && t <= 86400 ? { command, value: t } : null }
  if (command === 'volume') { const v = numeric(value); return Number.isFinite(v) && v >= 0 && v <= 1 ? { command, value: v } : null }
  if (command === 'play-item') {
    const v = value && typeof value === 'object' ? value : {}
    const ok = Number.isInteger(v.index) && v.index >= 0 && v.index < QUEUE_MAX && typeof v.id === 'string' && /^[\w.:-]{1,64}$/.test(v.id)
    return ok ? { command, value: { index: v.index, id: v.id } } : null
  }
  return null
}

module.exports = {
  STAGE_MIN, STAGE_DEFAULT, COMPACT_MIN, COMPACT_DEFAULT, UP_NEXT_MAX, PLAYLIST_BEFORE, PLAYLIST_AFTER, QUEUE_MAX,
  clock, cleanQueue, trackOf, nextItem, countdown, timeLeft, queueRows, playlistLabel, playingFrom, liveChip, yearOf,
  windowBounds, minSize, stageCommand
}
