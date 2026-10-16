// Drift check: what the lyric views WOULD highlight, frame by frame, against where the words are
// really sung. The "visual" side is the real engine (lyrics-view.js prepare/wordState and
// lyrics-timing.js liveLines, the code path render() runs); the "spectrum" side is the ground
// truth: words force-aligned to the vocals by sonata-align (the GPU aligner, docs/LEVEL2-ALIGN.md)
// or the hand-annotated JamendoLyrics benchmark. See docs/LYRIC-TIMING.md.
//
// Pure functions; the CLI (drift-check.js) loads the songs and prints the report.
// loop: none beyond one-shot for-loops over a song's lines/words/frames; nothing is kept.
'use strict'
const T = require('../../lyrics-timing')
const V = require('../../lyrics-view')

const FRAME = 0.05   // s between sampled frames (20 fps is finer than any word)

// --- the estimator as shipped in 0.15.31, kept here only as the "before" of the report ---
function estimateV0(lines) {
  if (!lines || !lines.length || lines[0].t == null || T.hasWordTiming(lines)) return lines
  return lines.map((line, i) => {
    const next = lines[i + 1]
    const parts = String(line.text || '').split(/\s+/).filter(Boolean)
    if (!parts.length) return line
    let end = line.end != null ? line.end : (next && next.t != null ? next.t : line.t + 0.45 * parts.length + 1)
    end = Math.min(end, line.t + 0.6 * parts.length + 2)
    const span = Math.max(0.2, (end - line.t) * 0.9)
    const weights = parts.map(T.wordWeight)
    const total = weights.reduce((a, b) => a + b, 0)
    let acc = 0
    const words = parts.map((text, k) => {
      const t = line.t + (acc / total) * span
      acc += weights[k]
      return { t, end: line.t + (acc / total) * span, text }
    })
    return Object.assign({}, line, { words, estimated: true })
  })
}

// --- statistics ---
function quantile(sorted, p) {
  if (!sorted.length) return NaN
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.round(p * (sorted.length - 1))))]
}
function stats(values) {
  const v = values.filter(Number.isFinite)
  if (!v.length) return { n: 0 }
  const abs = v.map(Math.abs).sort((a, b) => a - b)
  const signed = [...v].sort((a, b) => a - b)
  const sum = (a) => a.reduce((x, y) => x + y, 0)
  return {
    n: v.length,
    mean: sum(abs) / v.length,          // mean |error|
    median: quantile(abs, 0.5),
    p90: quantile(abs, 0.9),
    bias: sum(v) / v.length,            // mean signed error (+ = the highlight is late)
    within01: abs.filter((x) => x <= 0.1).length / v.length,
    within03: abs.filter((x) => x <= 0.3).length / v.length
  }
}

/** Least-squares slope of y over x (s per word); null for fewer than 3 points. */
function slope(xs, ys) {
  const n = xs.length
  if (n < 3) return null
  const mx = xs.reduce((a, b) => a + b, 0) / n
  const my = ys.reduce((a, b) => a + b, 0) / n
  let num = 0, den = 0
  for (let i = 0; i < n; i++) { num += (xs[i] - mx) * (ys[i] - my); den += (xs[i] - mx) ** 2 }
  return den ? num / den : null
}

/** Verse blocks: lines between the interludes the app shows (gaps ≥ 4 s). -> per line { block, last } */
function verses(raw) {
  const gaps = new Set(T.findInterludes(raw).map((g) => g.index))
  const out = []
  let block = 0
  for (let i = 0; i < raw.length; i++) {
    if (i && gaps.has(i)) block++
    out.push({ block, last: false })
  }
  for (let i = 0; i < out.length; i++) if (i === out.length - 1 || out[i + 1].block !== out[i].block) out[i].last = true
  return out
}

/**
 * Word-start errors of `lines` (method output) against `truth` ({ index: [{ t, end, text }] }).
 * -> { errs: [signed], byRel: [10 deciles of signed], byIdx: {k: [signed]}, slopes: [s/word],
 *      lineEnd: [signed error of each line's last word], verseEnd: [signed, last word of a verse's
 *      last line], verseLines: { first, middle, last: [signed] } }
 */
function startErrors(lines, truth, raw) {
  const out = { errs: [], byRel: Array.from({ length: 10 }, () => []), byIdx: {}, slopes: [], lineEnd: [], verseEnd: [], verseLines: { first: [], middle: [], last: [] } }
  const vs = verses(raw)
  for (const [k, words] of Object.entries(truth)) {
    const i = Number(k)
    const line = lines[i]
    if (!line || !line.words || line.words.length !== words.length) continue
    const xs = [], ys = []
    const firstOfVerse = i === 0 || vs[i - 1].block !== vs[i].block
    words.forEach((g, j) => {
      const e = line.words[j].t - g.t
      out.errs.push(e)
      out.byRel[Math.min(9, Math.floor((10 * j) / words.length))].push(e)
      const key = Math.min(j, 8)
      ;(out.byIdx[key] = out.byIdx[key] || []).push(e)
      xs.push(j); ys.push(e)
      const where = vs[i].last ? 'last' : firstOfVerse ? 'first' : 'middle'
      out.verseLines[where].push(e)
    })
    const s = slope(xs, ys)
    if (s != null) out.slopes.push(s)
    const e = ys[ys.length - 1]
    out.lineEnd.push(e)
    if (vs[i].last) out.verseEnd.push(e)
  }
  return out
}

/**
 * The views' highlight at song time `time`, as render() decides it: nothing during an interlude
 * (the countdown dots), else the live lines (liveLines) and, per live line, the word wordState()
 * marks .now at time + WORD_LEAD. gaps: T.findInterludes(lines) (pass it in when sampling many
 * frames). -> Set of 'line:word'.
 */
function highlightAt(lines, time, gaps = T.findInterludes(lines)) {
  const now = new Set()
  if (T.interludeAt(gaps, time) >= 0) return now
  const { live } = T.liveLines(lines, time)
  for (const i of live) {
    const words = lines[i].words
    if (!words || !words.length) continue
    const st = V.wordState(words, time + V.WORD_LEAD)
    if (st.now >= 0) now.add(i + ':' + st.now)
  }
  return now
}

/**
 * Frame check: every FRAME s over the singing, is the word being sung the one lit? Only frames
 * where the truth has a word count. -> { frames, hit, early, late, hitRate }
 * early: a later word of the same line is lit; late: an earlier word (or the previous line's) is.
 */
function frameCheck(lines, truth, opts = {}) {
  const step = opts.frame || FRAME
  const list = []
  for (const [k, words] of Object.entries(truth)) words.forEach((w, j) => list.push({ key: k + ':' + j, line: +k, j, t: w.t, end: Math.max(w.end, w.t + 0.08) }))
  list.sort((a, b) => a.t - b.t)
  if (!list.length) return { frames: 0, hit: 0, early: 0, late: 0, none: 0, hitRate: NaN }
  let frames = 0, hit = 0, early = 0, late = 0, none = 0
  let cursor = 0
  const from = list[0].t, to = list[list.length - 1].end
  const gaps = opts.gaps || T.findInterludes(lines)
  for (let time = from; time < to; time += step) {
    while (cursor < list.length && list[cursor].end <= time) cursor++
    let cur = null
    for (let c = cursor; c < list.length && list[c].t <= time; c++) if (time < list[c].end) { cur = list[c]; break }
    if (!cur) continue
    frames++
    const lit = highlightAt(lines, time, gaps)
    if (lit.has(cur.key)) { hit++; continue }
    if (!lit.size) { none++; continue }
    // compare with the lit word of the same line, else any lit word
    let other = null
    for (const key of lit) { const [l, w] = key.split(':').map(Number); if (!other || l === cur.line) other = { l, w } }
    if (other.l > cur.line || (other.l === cur.line && other.w > cur.j)) early++
    else late++
  }
  return { frames, hit, early, late, none, hitRate: frames ? hit / frames : NaN }
}

/** One song through one method -> { starts: startErrors, frames: frameCheck } */
function evaluate(song, lines) {
  return { starts: startErrors(lines, song.truth, song.raw), frames: frameCheck(lines, song.truth) }
}

/** Merge per-song results of one method. */
function combine(results) {
  const all = { errs: [], byRel: Array.from({ length: 10 }, () => []), byIdx: {}, slopes: [], lineEnd: [], verseEnd: [], verseLines: { first: [], middle: [], last: [] } }
  const fr = { frames: 0, hit: 0, early: 0, late: 0, none: 0 }
  for (const r of results) {
    const s = r.starts
    all.errs.push(...s.errs); all.slopes.push(...s.slopes); all.lineEnd.push(...s.lineEnd); all.verseEnd.push(...s.verseEnd)
    s.byRel.forEach((v, i) => all.byRel[i].push(...v))
    for (const [k, v] of Object.entries(s.byIdx)) (all.byIdx[k] = all.byIdx[k] || []).push(...v)
    for (const w of ['first', 'middle', 'last']) all.verseLines[w].push(...s.verseLines[w])
    for (const k of Object.keys(fr)) fr[k] += r.frames[k]
  }
  fr.hitRate = fr.frames ? fr.hit / fr.frames : NaN
  return { starts: all, frames: fr }
}

/** Summary numbers of a combined result (seconds; hit rate 0..1). */
function summarize(c) {
  const sl = [...c.starts.slopes].sort((a, b) => a - b)
  return {
    start: stats(c.starts.errs),
    slopeMedian: quantile(sl, 0.5),               // s per word: drift within a line
    slopeMean: sl.length ? sl.reduce((a, b) => a + b, 0) / sl.length : NaN,
    lineEnd: stats(c.starts.lineEnd),
    verseEnd: stats(c.starts.verseEnd),
    byRel: c.starts.byRel.map((v) => stats(v)),
    verseLines: { first: stats(c.starts.verseLines.first), middle: stats(c.starts.verseLines.middle), last: stats(c.starts.verseLines.last) },
    frames: c.frames
  }
}

module.exports = { FRAME, estimateV0, stats, slope, verses, startErrors, highlightAt, frameCheck, evaluate, combine, summarize, quantile }
