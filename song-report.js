// Song reports (0.15.73, Marcy 2026-10-19): at each song's end (or a song change) one multi-line journal entry says
// how well the song was learned and shown on this play:
//
//   song report "Rooster (Live)" · Sonata 0.15.73 Dev · engine 0.2.8 · look-ahead 3 s (cuda)
//     words ready before sung 98 % (median lead 2.3 s, worst −0.4 s) · notes drawn on 27/29 sung lines · expr drawn 31/33 held words
//     clock: 2 corrections (max 140 ms) · helper: no failures · first play
//
// What it gathers, in memory, per song (no timer, no I/O until the one log write at the end):
//   arrived(kind, lines)  main: the lines whose words (look-ahead's stream), notes or expression came, with the
//                         master clock's time then; the lead is the line's start minus that time
//   heard(t)              main's lyrics tick: how far the song was heard (which lines were sung)
//   drawn(rows)           the lyrics window ('lyrics-command' 'draws', batched): per line lit, whether the band drew
//                         notes for it and how many of its measured Expressive words were drawn, with skip reasons
//   helper(kind)          a helper job that failed: 'timeout', 'stream' or 'failure'
// Electron-free: test/song-report.test.js builds a report from a synthetic song.
'use strict'

const V = require('./version-display')
const KINDS = ['words', 'notes', 'expr']
const MAX_LINES = 2000      // a song's lines kept at most (a guard: real songs have ≤ ~150)

function newSong(info) {
  return {
    key: info.key, id: info.id || '', title: info.title || '', version: info.version || '', engine: info.engine || '',
    lookahead: info.lookahead || '', kind: info.kind || '', starts: Array.isArray(info.starts) ? info.starts.slice(0, MAX_LINES) : [],
    arrivals: { words: new Map(), notes: new Map(), expr: new Map() },   // line -> { at, start }
    furthest: 0, draws: new Map(),   // line -> { n, x }
    helper: { timeout: 0, stream: 0, failure: 0 }
  }
}

// loop: NOT-WORTH — the sung lines' leads (≤ ~150), once per report
const median = (xs) => { const a = xs.slice().sort((p, q) => p - q); const m = a.length >> 1; return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2 }
const secs = (x) => (x < 0 ? '−' : '') + Math.abs(x).toFixed(1) + ' s'

/** The lines heard this play (start ≤ the furthest time heard), by index. */
function sungLines(s) {
  const out = []
  // loop: NOT-WORTH — the song's lines (≤ ~150), once per report
  s.starts.forEach((t, i) => { if (Number.isFinite(t) && t <= s.furthest) out.push(i) })
  return out
}

/** One kind's lead line ("words ready before sung 98 % (median lead 2.3 s, worst −0.4 s)"), or '' when none came. */
function leadText(s, kind, sung) {
  const got = s.arrivals[kind]
  if (!got.size) return ''
  const leads = []
  let ahead = 0
  // loop: NOT-WORTH — the sung lines (≤ ~150), once per report
  for (const i of sung) {
    const a = got.get(i)
    if (!a) continue
    const start = Number.isFinite(a.start) ? a.start : s.starts[i]
    const lead = start - a.at
    leads.push(lead)
    if (lead >= 0) ahead++
  }
  if (!sung.length) return ''
  const pct = Math.round(100 * ahead / sung.length)
  return kind + ' ready before sung ' + pct + ' %' + (leads.length ? ' (median lead ' + secs(median(leads)) + ', worst ' + secs(Math.min(...leads)) + ')' : '')
}

/** The draw side's line ("notes drawn on 27/29 sung lines · expr drawn 31/33 held words (2 line already sung)"). */
function drawText(s) {
  let bandLines = 0
  let noted = 0
  let measured = 0
  let drawn = 0
  const skip = {}
  // loop: NOT-WORTH — the lines lit (≤ ~150), once per report; a line's skip reasons (≤ 5)
  for (const r of s.draws.values()) {
    if (r.n != null) { bandLines++; if (r.n) noted++ }
    if (r.x) {
      measured += r.x.m
      drawn += r.x.d
      for (const [why, n] of Object.entries(r.x.s || {})) skip[why] = (skip[why] || 0) + n
    }
  }
  const out = []
  if (!s.draws.size) return 'nothing drawn (no lyrics window open)'
  out.push(bandLines ? 'notes drawn on ' + noted + '/' + bandLines + ' sung lines' : 'notes: band not shown')
  // loop: NOT-WORTH — the skip reasons (≤ 5), once per report
  const why = Object.keys(skip).sort((a, b) => skip[b] - skip[a]).map((k) => skip[k] + ' ' + k).join(', ')
  out.push(measured ? 'expr drawn ' + drawn + '/' + measured + ' held words' + (why ? ' (' + why + ')' : '') : 'expr: none measured')
  return out.join(' · ')
}

function clockText(c) {
  if (!c || !c.n) return 'clock: no corrections'
  // loop: NOT-WORTH — at most 4 causes
  const by = Object.keys(c.causes || {}).sort((a, b) => c.causes[b] - c.causes[a]).map((k) => c.causes[k] + ' ' + k).join(', ')
  return 'clock: ' + c.n + ' correction' + (c.n === 1 ? '' : 's') + ' (max ' + c.max + ' ms' + (by ? '; ' + by : '') + ')'
}

function helperText(h) {
  const parts = []
  if (h.timeout) parts.push(h.timeout + ' timed out')
  if (h.stream) parts.push(h.stream + ' stream failed')
  if (h.failure) parts.push(h.failure + ' failed')
  return 'helper: ' + (parts.length ? parts.join(', ') : 'no failures')
}

/** The report's text: three lines (see the top of this file). clock: song-clock.js corrections(). */
function reportText(s, clock) {
  const head = 'song report "' + s.title + '"' + (s.version ? ' · ' + V.full(s.version) : '') + (s.engine ? ' · engine ' + V.short(s.engine) : '') + ' · look-ahead ' + (s.lookahead || 'off')
  const sung = sungLines(s)
  // loop: NOT-WORTH — three kinds, once per report
  const leads = KINDS.map((k) => leadText(s, k, sung)).filter(Boolean)
  const second = leads.concat([drawText(s)]).join(' · ')
  const third = [clockText(clock), helperText(s.helper), s.kind || 'play'].join(' · ')
  return head + '\n  ' + second + '\n  ' + third
}

/** One draw row's debug line (developer log): 'song report: line 12: notes shown · expr 2/3 (1 line already sung)'. */
function drawLine(r) {
  const n = r.n == null ? 'band not shown' : r.n ? 'notes shown' : 'no notes'
  // loop: NOT-WORTH — a line's skip reasons (≤ 5), per line lit with the developer log on
  const x = r.x && r.x.m ? 'expr ' + r.x.d + '/' + r.x.m + (Object.keys(r.x.s || {}).length ? ' (' + Object.entries(r.x.s).map(([k, v]) => v + ' ' + k).join(', ') + ')' : '') : 'no expr'
  return 'song report: line ' + (r.i + 1) + ': ' + n + ' · ' + x
}

/** A draws message from the lyrics window, checked: -> rows or null. */
function cleanRows(msg) {
  if (!msg || typeof msg !== 'object' || typeof msg.key !== 'string' || !Array.isArray(msg.rows) || msg.rows.length > 200) return null
  const out = []
  // loop: NOT-WORTH — one batch (a few lines), per message every ~2 s at most
  for (const r of msg.rows) {
    if (!r || !Number.isInteger(r.i) || r.i < 0 || r.i >= MAX_LINES) continue
    const n = r.n === 1 || r.n === 0 ? r.n : null
    let x = null
    if (r.x && Number.isInteger(r.x.m) && Number.isInteger(r.x.d) && r.x.m >= 0 && r.x.d >= 0 && r.x.m < 1000) {
      const s = {}
      // loop: NOT-WORTH — a line's skip reasons (≤ 5)
      for (const [k, v] of Object.entries(r.x.s || {}).slice(0, 8)) if (Number.isInteger(v) && v > 0) s[String(k).slice(0, 40)] = v
      x = { m: r.x.m, d: Math.min(r.x.d, r.x.m), s }
    }
    out.push({ i: r.i, n, x })
  }
  return out
}

/**
 * The report keeper (main.js). deps: { log(text), devLog() -> bool, clock() -> corrections of the song now,
 * closeMs (how long a song that ended still takes the lyrics window's last draws; default 3000), setTimeout, clearTimeout }
 */
function createSongReport(deps) {
  const log = deps.log || (() => {})
  const setT = deps.setTimeout || setTimeout
  const clearT = deps.clearTimeout || clearTimeout
  const closeMs = deps.closeMs == null ? 3000 : deps.closeMs
  let cur = null       // cache: OK — key=the song playing; invalidated=end() (song change or end); bound=one song's lines
  let closing = null   // cache: OK — key=the song just ended; invalidated=its report written (closeMs later) ; bound=one song
  let closeTimer = null
  function write() {
    if (closeTimer) { clearT(closeTimer); closeTimer = null }
    if (!closing) return ''
    const text = reportText(closing.s, closing.clock)
    closing = null
    log(text)
    return text
  }
  function find(key) { return cur && cur.key === key ? cur : closing && closing.s.key === key ? closing.s : null }
  return {
    /** A song shown: a new report (the same song again only updates its line starts). */
    begin(info) {
      if (!info || !info.key) return
      if (cur && cur.key === info.key) { if (Array.isArray(info.starts)) cur.starts = info.starts.slice(0, MAX_LINES); return }
      if (cur) this.end()
      cur = newSong(info)
    },
    /** The song ended (or changed): its report is written closeMs later, once the window's last draws are in. */
    end(clock) {
      if (!cur) return
      write()   // an older one still waiting goes first
      closing = { s: cur, clock: clock || (deps.clock ? deps.clock() : null) }
      cur = null
      // lifetime: OK — one-shot timer, cleared by write() (the next end, or flush on quit)
      closeTimer = setT(write, closeMs)
      if (closeTimer && closeTimer.unref) closeTimer.unref()
    },
    flush: write,
    arrived(key, kind, lines, at) {
      const s = find(key)
      if (!s || !s.arrivals[kind] || !Number.isFinite(at)) return
      // loop: NOT-WORTH — one message's lines (one per hop, a section's ≤ ~20)
      for (const l of lines) {
        const i = typeof l === 'object' && l ? l.i : l
        if (!Number.isInteger(i) || i < 0 || i >= MAX_LINES || s.arrivals[kind].has(i)) continue
        s.arrivals[kind].set(i, { at, start: typeof l === 'object' && l ? l.start : undefined })
      }
    },
    heard(key, t) { if (cur && cur.key === key && Number.isFinite(t) && t > cur.furthest) cur.furthest = t },
    setLookahead(key, text) { if (cur && cur.key === key && text && text !== 'off') cur.lookahead = text },
    mark(id, kind) { if (cur && cur.id === id) cur.kind = kind },
    drawn(msg) {
      const rows = cleanRows(msg)
      const s = rows && find(msg.key)
      if (!s) return
      const dev = deps.devLog && deps.devLog()
      // loop: NOT-WORTH — one batch (a few lines)
      for (const r of rows) {
        if (!s.draws.has(r.i)) s.draws.set(r.i, r)
        if (dev) log(drawLine(r))
      }
    },
    helper(kind) {
      const s = cur || (closing && closing.s)
      if (s) s.helper[kind === 'timeout' || kind === 'stream' ? kind : 'failure']++
    },
    get key() { return cur ? cur.key : '' }
  }
}

module.exports = { createSongReport, reportText, leadText, drawText, clockText, helperText, drawLine, cleanRows, newSong, MAX_LINES }
