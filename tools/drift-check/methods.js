// Word-timing methods for the drift check: what the lyric views show on a song's FIRST play (before
// anything was learned) and on later plays. Each returns the line objects lyrics-view.js would render.
//   v0           the 0.15.31 estimate (stretched over the line's time), the "before"
//   estimate     today's estimate (lyrics-timing estimateWords)
//   repeat       first play with "Refine timing by listening": each line is refined once it has been
//                sung (too late for itself), and later identical lines reuse that timing
//   progressive  first play with precise timing: sections are aligned while the song plays
//                (align-session.js sections) and reach the view after the helper's run; later
//                identical lines reuse aligned timing, other estimated lines take the song's pace
//   refine       the second play with refine by listening (learned from the first play)
//   refine+repeat  the second play, repeats filled from refined/aligned lines
//   aligned      the second play with precise timing (JamendoLyrics: bench.py's aligner output)
// loop: none beyond one pass over a song's lines per method.
'use strict'
const T = require('../../lyrics-timing')
const A = require('../../align-session')
const { refineWords, noiseRate } = require('../../timing-refine')
const { EVIDENCE_PAD, MAX_SHIFT, MIN_CONFIDENCE } = require('../../listen-session')
const L = require('./lib')

const HELPER_DELAY = 8   // s from a section's audio being complete to its words reaching the view (GPU ~1–7 s + IPC)

/** The aligner's words per line for a song (cache: the truth itself, which IS the aligner's output). */
// (as the app's aligner gives them since version 3: hyphen runs as words, see lib.js toPieces)
function alignedOf(song) {
  const a = song.aligned || (song.source.startsWith('cache') ? song.truth : null)
  if (!a) return null
  const out = {}
  for (const [i, w] of Object.entries(a)) out[i] = L.toPieces(song.raw[i].text, w)
  return out
}

/** Level 1 refine of every estimated line, as listen-session.js processDue does it after the line. */
function refineAll(song, lines) {
  if (!song.audio) return null
  const { onsets, voiced } = song.audio
  const out = lines.slice()
  const refinedAt = {}
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (!line.estimated || !line.words) continue
    const end = T.lineEnd(line, lines[i + 1])
    const from = line.t - EVIDENCE_PAD, to = end + EVIDENCE_PAD
    const ev = { onsets: onsets.filter((o) => o.t >= from && o.t <= to), voiced: voiced.filter((v) => v.end >= from && v.start <= to) }
    const gate = noiseRate(onsets.filter((o) => o.t <= to), lines, to)
    const res = refineWords(line, ev, { nextStart: lines[i + 1] && lines[i + 1].t != null ? lines[i + 1].t : undefined, noiseRate: gate.rate, maxShift: MAX_SHIFT })
    if (!res || !res.words || !(res.confidence >= MIN_CONFIDENCE)) continue
    out[i] = Object.assign({}, line, { words: res.words.map((w) => ({ t: w.t, end: w.end, text: w.text })), refined: true })
    refinedAt[i] = to       // known from this song time on
  }
  return { lines: out, refinedAt }
}

/**
 * First play: line i is shown with what is known when it lights up. known(i, t) -> the lines
 * (by index) whose better timing has arrived by song time t.
 */
function firstPlay(estimated, better, arrivedAt, opts = {}) {
  const out = estimated.slice()
  for (let i = 0; i < estimated.length; i++) {
    const t = estimated[i].t
    if (t == null) continue
    const known = estimated.map((l, j) => (better[j] && arrivedAt[j] != null && arrivedAt[j] <= t - T.LINE_LEAD ? better[j] : l))
    let lines = known
    if (opts.pace) lines = T.repace(lines, i)                 // the song's pace from what's known
    const mapped = T.reuseRepeats(lines)
    out[i] = mapped[i]
  }
  return out
}

function run(method, song) {
  const raw = song.raw
  if (method === 'v0') return L.estimateV0(raw)
  const est = T.estimateWords(raw)
  if (method === 'estimate') return est
  const aligned = alignedOf(song)
  if (method === 'aligned') {
    if (!aligned || song.source.startsWith('cache')) return null   // cache: aligned IS the truth
    const entry = { version: A.ENTRY_VERSION, lyricsHash: A.lyricsHash(raw), lines: {} }
    for (const [i, w] of Object.entries(aligned)) entry.lines[i] = { text: raw[i].text, words: w }
    return A.prepareLines(raw, { estimate: true, entry }).lines
  }
  if (method === 'progressive') {
    if (!aligned) return null
    const better = {}, arrivedAt = {}
    for (const sec of A.sections(raw)) {
      for (let i = sec.from; i <= sec.to; i++) {
        if (!aligned[i]) continue
        better[i] = Object.assign({}, est[i], { words: aligned[i].map((w) => ({ t: w.t, end: w.end, text: w.text })), aligned: true })
        delete better[i].estimated
        arrivedAt[i] = sec.at + HELPER_DELAY
      }
    }
    return firstPlay(est, better, arrivedAt, { pace: true })
  }
  if (method === 'repeat' || method === 'refine' || method === 'refine+repeat') {
    const r = refineAll(song, est)
    if (!r) return null
    if (method === 'refine') return r.lines
    if (method === 'refine+repeat') return T.reuseRepeats(r.lines)
    const better = {}
    for (const i of Object.keys(r.refinedAt)) better[i] = r.lines[i]
    return firstPlay(est, better, r.refinedAt)
  }
  throw new Error('unknown method ' + method)
}

module.exports = { run, refineAll, firstPlay, HELPER_DELAY }
