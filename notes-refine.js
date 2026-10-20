'use strict'
// Songs keep refining their notes and expressions until they're complete (0.15.71; Marcy 2026-10-19: "the learning
// of each song should stay on until it's perfectly refined"). Pure logic, no Electron: main.js asks refineDue() when
// a learned song starts, records that play like a first one, and merge() keeps the better result per lyric line
// (never a worse one) when the new pass arrives. The metrics, thresholds and the bench they were chosen on are in
// docs/LEVEL2-ALIGN.md "Refinement".
//
// Per sung line (a lyric line with timed syllables, not rapped, in a song the gate doesn't show as a pitch line
// throughout, i.e. not rap or speech; instrumentals have no lines):
//   coverage   syllables with at least one note linked to them (the engine's syl_index) / the line's syllables
//   conf       the line's notes' duration-weighted confidence (the engine's note conf)
//   exprCov    words with a measured vowel (Expressive words) / words whose notes hold ≥ HOLD_MIN s
// A line is complete at coverage ≥ TARGET. A refine play re-measures the song; a line is replaced only by a line
// with more covered syllables, or the same number at ≥ CONF_STEP more confidence. The song settles when every
// sung line is complete, after STILL_MAX refine plays in a row with no line improved, or after MAX_PLAYS.
const sheet = require('./sheet-notes-model')

// Chosen on the bench (docs/LEVEL2-ALIGN.md "Refinement": 40 vocadito songs × MUSDB18 accompaniment, 5 plays):
// TARGET  lines at ≥ 80 % coverage have a mean note F1 of 0.82-0.93 (98 % of them ≥ 0.5); below 60 % it is ≤ 0.56;
//         a higher target (90 %, 100 %) reached the same F1 by play 5 with more plays
// STILL_MAX, MAX_PLAYS  the gain is in the first refine play (+0.8 of the +1.2 points of F1 over four); each later one
//         adds ≤ 0.2 points, within the noise (a replaced line's F1 went up 51 times, down 37): one play without
//         a better line settles the song, three refine plays at most (waiting for 3 idle plays bought +0.2 points
//         for 1.7 more passes on the graphics card per song)
const TARGET = 0.8
const STILL_MAX = 1
const MAX_PLAYS = 3
const CONF_STEP = 0.02
const HOLD_MIN = 0.6         // s: lyrics-expressive.js HOLD_MIN (a vowel held this long stretches)
const HISTORY_MAX = 12       // per-song refine history rows kept on the entry

const round = (v, k = 1000) => Math.round(v * k) / k

/** Per sung line of an entry: [{ line, t0, t1, n, covered, coverage, conf, held, expr, exprCov }] (time order), or null. */
function lineQuality(entry) {
  const doc = sheet.expand(entry)
  if (!doc || !doc.syllables.length) return null
  const g = sheet.gate(doc)
  // rap or speech throughout (the gate's song-wide pitch line): nothing to refine into notes
  if (g.song === 'line' && g.stats.spread > sheet.GATE.songSpreadMax) return []
  // cache: NOT-WORTH — key=line; invalidated=each call (local to one lineQuality); bound=the song's lines (tens)
  const by = new Map()
  // loop: NOT-WORTH — the song's syllables (hundreds), once per refine decision or merge
  doc.syllables.forEach((s, i) => {
    if (s.line === null || !(s.end > s.t)) return
    const l = by.get(s.line) || { line: s.line, t0: s.t, t1: s.end, syl: [] }
    l.t0 = Math.min(l.t0, s.t); l.t1 = Math.max(l.t1, s.end); l.syl.push(i)
    by.set(s.line, l)
  })
  const linked = new Map()
  // loop: NOT-WORTH — the song's notes (hundreds), once
  for (const n of doc.notes) if (n.syl_index !== null) { const a = linked.get(n.syl_index) || []; a.push(n); linked.set(n.syl_index, a) }
  const exprWords = new Set(((entry.expr && entry.expr.words) || []).filter((w) => w && w.t != null).map((w) => w.l + ':' + w.w))
  const out = []
  // loop: NOT-WORTH — the song's lines (tens), once
  for (const l of [...by.values()].sort((a, b) => a.t0 - b.t0)) {
    if (l.syl.length / Math.max(0.1, l.t1 - l.t0) > sheet.GATE.rapRate) continue   // rapped
    let covered = 0; let dur = 0; let w = 0
    const heldWords = new Set()
    // loop: NOT-WORTH — a line's syllables (≤ ~20)
    for (const i of l.syl) {
      const ns = linked.get(i)
      if (!ns) continue
      covered++
      // loop: NOT-WORTH — a syllable's notes (1-3), once per refine decision (a learned song starts) or merge, not per tick
      const held = ns.reduce((a, n) => a + (n.end - n.t), 0)
      if (held >= HOLD_MIN) heldWords.add(wordOf(entry, i))
      // loop: NOT-WORTH — a syllable's notes (1-3)
      for (const n of ns) { dur += n.end - n.t; w += n.conf * (n.end - n.t) }
    }
    // loop: NOT-WORTH — a line's held words (≤ ~20), once per refine decision (a learned song starts) or merge, not per tick
    const expr = [...heldWords].filter((k) => exprWords.has(l.line + ':' + k)).length
    out.push({ line: l.line, t0: round(l.t0), t1: round(l.t1), n: l.syl.length, covered, coverage: round(covered / l.syl.length), conf: dur ? round(w / dur) : 0,
      held: heldWords.size, expr, exprCov: heldWords.size ? round(expr / heldWords.size) : 1 })
  }
  return out
}
// the word index of syllable i in its line (the expr words' `w`): words counted by syllable 0 of each
function wordOf(entry, i) {
  const s = entry.syl
  let w = -1
  // loop: NOT-WORTH — back to the line's start (≤ ~20 syllables)
  for (let k = i; k >= 0 && s[k][3] === s[i][3]; k--) if (s[k][4] === 0) w++
  return Math.max(0, w)
}

/** The song's summary: { lines (sung), complete, below: [line], coverage (sung syllables covered / sung syllables) }. */
function summary(q) {
  const lines = q || []
  // loop: NOT-WORTH — the song's lines (tens), three passes, once per refine decision (a learned song starts) or merge, not per tick
  const syl = lines.reduce((a, l) => a + l.n, 0)
  const cov = lines.reduce((a, l) => a + l.covered, 0)
  // loop: NOT-WORTH — the song's lines (tens), filtered then mapped, once per refine decision (a learned song starts) or merge, not per tick
  const below = lines.filter((l) => l.coverage < TARGET).map((l) => l.line)
  return { lines: lines.length, complete: lines.length - below.length, below, coverage: syl ? round(cov / syl) : 1 }
}

/**
 * Whether this play refines a learned entry: { below, coverage, play } (play: the refine play this would be, 1-based),
 * or null (settled, nothing below target, failed, partial, or no sung lines).
 */
function refineDue(entry) {
  if (!entry || entry.failed || entry.partial) return null
  const r = entry.refine || {}
  if (r.settled) return null
  const q = lineQuality(entry)
  if (!q || !q.length) return null
  const s = summary(q)
  if (!s.below.length) return null
  if ((r.plays || 0) >= MAX_PLAYS || (r.still || 0) >= STILL_MAX) return null
  return { below: s.below, coverage: s.coverage, play: (r.plays || 0) + 1 }
}

// a line's score: covered syllables first, then confidence
function better(fresh, old) {
  if (!fresh) return false
  if (!old) return fresh.covered > 0
  return fresh.covered > old.covered || (fresh.covered === old.covered && fresh.covered > 0 && fresh.conf >= old.conf + CONF_STEP)
}

/**
 * Merges a fresh pass into the learned entry, line by line: a sung line takes the fresh pass's notes, pitch line,
 * and expression only when better() (more covered syllables, or as many at ≥ CONF_STEP more confidence); every
 * other line keeps what it had. The base is the old entry (its syllables and timing stay), so a line can be taken
 * only when the fresh pass split it into the same number of syllables.
 * -> { entry, improved: [line], before, after } (before/after: summary())
 */
function merge(old, fresh, meta = {}) {
  const qo = lineQuality(old) || []
  const qf = lineQuality(fresh) || []
  // loop: NOT-WORTH — the song's lines (tens), once per refine pass (sheetNotesDone), not per tick
  const fBy = new Map(qf.map((l) => [l.line, l]))
  // error: NOT-WORTH — a deep copy of an entry read from JSON: what JSON.stringify writes always parses
  const out = JSON.parse(JSON.stringify(old))
  // loop: NOT-WORTH — the entry's syllables (hundreds), twice per refine pass
  // cache: NOT-WORTH — key=line; invalidated=each call (local to one merge); bound=the entry's syllables (hundreds)
  const sylOf = (e) => { const m = new Map(); e.syl.forEach((s, i) => { const a = m.get(s[3]) || []; a.push(i); m.set(s[3], a) }); return m }
  const oSyl = sylOf(old); const fSyl = sylOf(fresh)
  const improved = []
  // loop: NOT-WORTH — the song's sung lines (tens), once per refine pass
  for (const lo of qo) {
    const lf = fBy.get(lo.line)
    const os = oSyl.get(lo.line) || []; const fs = fSyl.get(lo.line) || []
    if (!better(lf, lo) || os.length !== fs.length) continue
    improved.push(lo.line)
    // loop: NOT-WORTH — a line's syllables (≤ ~20), per improved line, once per refine pass (sheetNotesDone), not per tick
    const map = new Map(fs.map((fi, k) => [fi, os[k]]))
    const t0 = lo.t0; const t1 = lo.t1
    const inSpan = (n) => n[0] < t1 && n[1] > t0
    // the old line's notes (linked to it, or unlinked inside its span) out, the fresh line's in (re-linked to the old syllables)
    // loop: NOT-WORTH — the song's notes (hundreds) per improved line (tens), once per refine pass (sheetNotesDone), not per tick
    out.notes = out.notes.filter((n) => !(n[6] >= 0 ? old.syl[n[6]] && old.syl[n[6]][3] === lo.line : inSpan(n)))
      .concat(fresh.notes.filter((n) => (n[6] >= 0 ? map.has(n[6]) : inSpan(n))).map((n) => { const c = n.slice(); c[6] = n[6] >= 0 ? map.get(n[6]) : -1; return c }))
    // its pitch line (same hop): the fresh values over the line's span
    if (out.pitch && fresh.pitch && out.pitch.hop === fresh.pitch.hop && Array.isArray(fresh.pitch.v)) {
      const a = Math.max(0, Math.floor((t0 - out.pitch.t0) / out.pitch.hop)); const b = Math.min(out.pitch.v.length, Math.ceil((t1 - out.pitch.t0) / out.pitch.hop))
      // loop: NOT-WORTH — one line's pitch values (≤ ~200)
      for (let i = a; i < b; i++) { const j = Math.round(i + (out.pitch.t0 - fresh.pitch.t0) / fresh.pitch.hop); if (j >= 0 && j < fresh.pitch.v.length) out.pitch.v[i] = fresh.pitch.v[j] }
    }
    // its expression: the fresh pass's words of this line, when it measured any
    if (fresh.expr && Array.isArray(fresh.expr.words)) {
      // loop: NOT-WORTH — the fresh pass's Expressive words (hundreds) per improved line, once per refine pass (sheetNotesDone), not per tick
      const fw = fresh.expr.words.filter((w) => w.l === lo.line)
      if (fw.length || !out.expr) {
        const base = out.expr && Array.isArray(out.expr.words) ? out.expr : { format: fresh.expr.format, v: fresh.expr.v, words: [], voc: [] }
        // loop: NOT-WORTH — the entry's Expressive words (hundreds) per improved line, once per refine pass (sheetNotesDone), not per tick
        out.expr = Object.assign({}, base, { words: base.words.filter((w) => w.l !== lo.line).concat(fw).sort((a, b) => a.l - b.l || a.w - b.w) })
      }
    }
  }
  // loop: NOT-WORTH — the song's notes (hundreds), sorted once per refine pass (sheetNotesDone), not per tick
  out.notes.sort((a, b) => a[0] - b[0])
  if (!('expr' in out) && 'expr' in fresh) out.expr = fresh.expr
  const before = summary(qo)
  const after = summary(lineQuality(out) || [])
  const r = Object.assign({ plays: 0, still: 0, history: [] }, old.refine || {})
  r.plays++
  r.still = improved.length ? 0 : r.still + 1
  r.history = r.history.concat([{ at: meta.at || '', play: r.plays, coverage: after.coverage, lines: improved.length }]).slice(-HISTORY_MAX)
  r.coverage = after.coverage
  r.settled = !after.below.length || r.still >= STILL_MAX || r.plays >= MAX_PLAYS
  out.refine = r
  if (meta.version) out.sonata = meta.version
  return { entry: out, improved, before, after }
}

/** The stored per-song quality (the entry's refine record, or the first measurement): { coverage, settled, below }. */
function quality(entry) {
  const q = lineQuality(entry)
  if (!q) return null
  const s = summary(q)
  const r = (entry && entry.refine) || {}
  return { coverage: s.coverage, below: s.below.length, lines: s.lines, settled: !!r.settled || !s.below.length, plays: r.plays || 0 }
}

// --- words people read ---
const pct = (x) => Math.round(x * 100) + ' %'
const n = (k, one, many) => k + ' ' + (k === 1 ? one : many)
/** The log line when a refine play starts. */
function logStart(title, due) { return '"' + title + '": refining ' + n(due.below.length, 'line', 'lines') + ' (coverage ' + pct(due.coverage) + ') — play ' + due.play }
/** The log line after a refine pass was merged. */
function logDone(title, res) {
  const r = res.entry.refine
  return '"' + title + '": ' + (res.improved.length ? 'refined ' + n(res.improved.length, 'line', 'lines') + ' (' + pct(res.before.coverage) + ' → ' + pct(res.after.coverage) + ')' : 'no line improved this play (' + r.still + '/' + STILL_MAX + ')') +
    (r.settled ? ' — settled: ' + pct(res.after.coverage) + ' of sung syllables have notes' : '')
}
const INFO = 'Sonata keeps measuring a song on later plays until each sung line has notes for at least ' + pct(TARGET) + ' of its syllables, and keeps the better result for every line, never a worse one. It stops once every line is complete, after a play that improved no line, or after ' + MAX_PLAYS + ' refine plays. The percentage is how many sung syllables have a measured note: coverage, not accuracy (there is nothing to check a song against on this PC, and an accuracy estimate wasn’t reliable enough on songs it wasn’t fitted on to show). Faded notes were placed from the word timing and aren’t counted.'
/** The one status line (lyric views' note, the Studio's band), ≤ 60 characters: { text, info } or null. */
function statusText(q, refining) {
  if (!q || !q.lines) return null
  if (refining && q.below) return { text: 'Refining this song: ' + n(q.below, 'line', 'lines') + ' to go', info: 'Notes for ' + pct(q.coverage) + ' of sung syllables so far. ' + INFO }
  if (q.settled && q.plays) return { text: 'Notes for ' + pct(q.coverage) + ' of sung syllables · settled', info: INFO }
  return null
}

module.exports = { TARGET, STILL_MAX, MAX_PLAYS, CONF_STEP, HISTORY_MAX, lineQuality, summary, refineDue, better, merge, quality, logStart, logDone, statusText, INFO }
