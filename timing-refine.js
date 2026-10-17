// "Refine timing by listening": move estimated word starts to where they're sung, and keep
// held words lit while the note is held (docs/LISTEN-SPEC.md). Pure functions, no Electron.
//
// Each word is split into its syllables (lyrics-timing's count), and the line's syllables are
// aligned in order with the detected onsets (a small dynamic-programming alignment that rewards
// strong onsets, charges for skipped syllables/onsets and for jumps in the local offset). A word
// then starts at its first syllable's onset, limited to maxShift from its estimate. The line's
// tempo is searched too (the estimate spreads a line over the gap after it).
//
// Gates (no change is better than a wrong change): only strong onsets count; a line drowning in
// onsets, or a song whose instrumental parts are full of them (noiseRate), is left alone; a word
// moves only when its onset is unambiguous (every near-best tempo agrees, and the alignment
// without that onset scores clearly worse); half the line's syllables must be found.
//
// Rules: words never reorder, never leave their line, never start more than maxShift from the
// estimate, and keep a minimum length.
// loop: NOT-WORTH — one call per line once its time has passed; the alignment is O(S·M·40) per tempo,
// S syllables and M onsets in one line, a few ms at most · lifetime: NOT-WORTH — keeps nothing

const { syllables, findInterludes } = require('./lyrics-timing')

// Tuning (chosen with tools/listen-bench, see docs/LISTEN-RESULTS.md)
const REFINE = {
  maxShift: 0.35,       // s, furthest a word start may move from its estimate
  minWord: 0.08,        // s, shortest word
  leadIn: 0.12,         // s, onsets this far before the line start count (as the line start)
  minStrength: 0.9,     // onsets weaker than this are ignored
  window: 1.0,          // s, how far from its estimate a syllable may look for its onset
  offPenalty: 0.3,      // score per unit of distance from the estimate, in units of offScale
  offScale: [0.15, 0.3], // s: allowed drift = a + b × (time since the line start); the line start
                        // (LRC stamp) is close, the estimate drifts further later in the line
  smooth: 1.0,          // score per s of change in offset between neighbouring matches
  skipSyllable: 0.5,    // score for a syllable without an onset
  skipOnset: 0.15,      // score × strength for an onset left between two matches
  rates: [0.5, 0.6, 0.7, 0.8, 0.9, 1, 1.15, 1.3],  // line tempos tried against the estimate
  ratePenalty: 0.1,     // score per syllable per unit of |log rate|
  ambiguity: 0.15,      // tempos scoring within this of the best must agree on a word's onset
  margin: 0.4,          // a word's onset must beat the best alignment without it by this much
  minMatchFrac: 0.5,    // share of the line's syllables that must find an onset, else no change
  maxDensity: 2.0,      // more usable onsets than this × syllables in the line = too noisy
  interpolate: false,   // unmatched words follow the shift of the matched words around them
  holdMin: 0.6,         // s, a word at least this long whose last holdTail s are one voiced note
  holdTail: 0.45,       // s, the end of a held word: voiced, no onset at all (≥ holdOnset) inside
  holdOnset: 0.5,       // onset strength that counts as a new syllable for the held test
  maxNoise: 1.5,        // onsets/s in the song's instrumental parts above this: refine nothing
                        // (opts.noiseRate, see noiseRate(); unknown = no gate)
  minStretch: 0.15,     // s, voicing must run at least this far past the last word's end
  minVoiced: 0.35,      // voiced-segment confidence needed
  midHolds: true        // a held mid-line word pushes the unmatched words after it right
}

function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v }

// The line's syllables with estimated times: { w (word index), first, t }
function syllablePlan(words) {
  const out = []
  // loop: NOT-WORTH — a line's words and their syllables (≤ ~40), once per refine
  words.forEach((w, i) => {
    const k = syllables(w.text)
    const step = Math.max(0, w.end - w.t) / (k + (/[,;:.!?…—-]$/.test(w.text) ? 0.6 : 0) + 0.35) // see wordWeight
    for (let s = 0; s < k; s++) out.push({ w: i, first: s === 0, t: w.t + s * step })
  })
  return out
}

// Offset change between two matched syllables. After a held note (a long voiced run with no
// onset, see refineWords) the singing is later than the estimate by about the hold: that much
// of a forward jump is free.
function jump(d, hold) {
  return d > 0 ? Math.max(0, d - (hold || 0)) : -d
}

// Order-preserving alignment of syllables to onsets -> { match: onset index per syllable
// (−1 = none), score }. `ban` forbids one syllable/onset pair (for the margin test).
// loop: S × M nodes, each looks back over at most 5 syllables × 8 onsets (S, M ≤ ~40 per line)
function align(syl, onsets, P, lo, ban = null) {
  const S = syl.length, M = onsets.length
  const best = new Float64Array(S * M).fill(-Infinity)
  const prev = new Int32Array(S * M).fill(-1)
  const own = (s, j) => {
    const off = onsets[j].t - syl[s].t
    if (Math.abs(off) > P.window) return -Infinity
    return onsets[j].s - P.offPenalty * Math.abs(off) / (P.offScale[0] + P.offScale[1] * Math.max(0, syl[s].t - lo))
  }
  // onsets inside the line before the first match count as skipped too
  const lead = new Float64Array(M + 1)
  // loop: NOT-WORTH — the DP: S × M nodes, each over ≤ 5 syllables × 8 onsets (S, M ≤ ~40), a few ms per call; refineWords runs once per line, once its time has passed (listen-session.js)
  for (let j = 0; j < M; j++) lead[j + 1] = lead[j] + (onsets[j].t > lo ? onsets[j].s : 0)
  for (let s = 0; s < S; s++) {
    for (let j = 0; j < M; j++) {
      if (ban && ban.s === s && ban.j === j) continue
      const o = own(s, j)
      if (o === -Infinity) continue
      let b = o - P.skipSyllable * s - P.skipOnset * lead[j], from = -1
      const off = onsets[j].t - syl[s].t
      // loop: NOT-WORTH — the DP's look-back: ≤ 5 syllables × 8 onsets × the onsets skipped (≤ 8)
      for (let ps = Math.max(0, s - 5); ps < s; ps++) {
        for (let pj = Math.max(0, j - 8); pj < j; pj++) {
          const pv = best[ps * M + pj]
          if (pv === -Infinity) continue
          if (onsets[j].t - onsets[pj].t < 0.06) continue
          let skipped = 0
          for (let q = pj + 1; q < j; q++) skipped += onsets[q].s
          const v = pv + o - P.skipSyllable * (s - ps - 1) - P.skipOnset * skipped -
            P.smooth * jump(off - (onsets[pj].t - syl[ps].t), onsets[pj].hold)
          if (v > b) { b = v; from = ps * M + pj }
        }
      }
      best[s * M + j] = b; prev[s * M + j] = from
    }
  }
  let top = -1, topV = 0
  // loop: NOT-WORTH — the best end node, S × M, once per align call
  for (let s = 0; s < S; s++) {
    for (let j = 0; j < M; j++) {
      const v = best[s * M + j] - P.skipSyllable * (S - 1 - s)
      if (v > topV) { topV = v; top = s * M + j }
    }
  }
  const match = new Int32Array(S).fill(-1)
  // loop: NOT-WORTH — backtrack, ≤ S steps
  for (let k = top; k >= 0; k = prev[k]) match[Math.floor(k / M)] = k % M
  return { match, score: topV }
}

/**
 * Refine one line's estimated words.
 * line: { t, end?, text, words: [{ t, end, text }], estimated: true }
 * evidence: { onsets: [{ t, strength }], voiced: [{ start, end, confidence }] } around the line
 * opts: REFINE overrides, plus nextStart (the next line's start) as the upper bound
 * -> { words: [{ t, end, text, held? }], moved, confidence }
 */
function refineWords(line, evidence, opts = {}) {
  const P = Object.assign({}, REFINE, opts)
  const est = (line && line.words) || []
  const n = est.length
  if (!n) return { words: [], moved: 0, confidence: 0 }
  if (P.noiseRate != null && P.noiseRate > P.maxNoise) {
    return { words: est.map((w) => ({ t: w.t, end: w.end, text: w.text })), moved: 0, confidence: 0 }
  }
  const lo = line.t != null ? Math.min(line.t, est[0].t) : est[0].t
  let hi = Math.min(line.end != null ? line.end : Infinity, P.nextStart != null ? P.nextStart : Infinity)
  if (!(hi < Infinity)) hi = est[n - 1].end + P.maxShift
  hi = Math.max(hi, est[n - 1].end)                      // never squeeze the estimate itself
  const onsets = ((evidence && evidence.onsets) || [])
    .filter((o) => o.strength >= P.minStrength && o.t >= lo - P.leadIn && o.t <= hi - P.minWord / 2)
    .map((o) => ({ t: Math.max(lo, o.t), s: o.strength }))
    .sort((a, b) => a.t - b.t)
  const voiced = ((evidence && evidence.voiced) || []).filter((v) => v.confidence >= P.minVoiced)
  const anyOnset = (a, b) => ((evidence && evidence.onsets) || []).some((o) => o.strength >= P.holdOnset && o.t > a && o.t < b)
  // held notes: a voiced run that starts at an onset and lasts holdMin+ with no new syllable
  // loop: NOT-WORTH — the line's onsets (≤ ~40) × its voiced spans, once per refine
  for (const o of onsets) {
    const v = voiced.find((x) => Math.abs(x.start - o.t) <= 0.12 && x.end - o.t >= P.holdMin)
    o.hold = v && !anyOnset(o.t + 0.12, v.end - 0.05) ? v.end - o.t : 0
  }
  const heldUntil = new Array(n).fill(0)
  const syl = syllablePlan(est)

  let starts = est.map((w) => w.t)
  const anchored = new Array(n).fill(false)
  let confidence = 0
  const inLine = onsets.filter((o) => o.t >= est[0].t - P.maxShift && o.t <= est[n - 1].end).length
  // gate: no onsets, or a line drowning in them (drums, guitar chugs), gives no usable evidence
  if (onsets.length && inLine <= P.maxDensity * syl.length) {
    // The estimate spreads a line over the time to the next line, so a line followed by a pause
    // is sung faster than estimated (and one with a hold, slower). Try a few tempos for the line
    // (syllable times scaled around the line start) and keep the best alignment.
    // Near-ties between tempos that put a word on different onsets mean the onset pattern is
    // ambiguous there (a regular grid with a missed syllable): such words don't move.
    const tries = P.rates.map((rate) => {
      const warped = rate === 1 ? syl : syl.map((x) => ({ w: x.w, first: x.first, t: lo + (x.t - lo) * rate }))
      const a = align(warped, onsets, P, lo)
      return { warped, match: a.match, raw: a.score, score: a.score - P.ratePenalty * Math.abs(Math.log(rate)) * syl.length }
    })
    tries.sort((a, b) => b.score - a.score)
    const best = tries[0]
    const match = Int32Array.from(best.match), score = best.score
    // loop: NOT-WORTH — the other tempos (a few) × syllables, once per refine
    for (const alt of tries.slice(1)) {
      if (alt.score < score - P.ambiguity) break
      for (let k = 0; k < syl.length; k++) if (alt.match[k] >= 0 && alt.match[k] !== match[k]) match[k] = -1
    }
    // A word's onset must also be clearly better than the next-best alignment without it
    // (e.g. everything one syllable over): else the word doesn't move.
    if (P.margin > 0) {
      // loop: NOT-WORTH — one re-alignment per matched first syllable (≤ ~15 words), once per refine
      for (let k = 0; k < syl.length; k++) {
        if (!syl[k].first || match[k] < 0) continue
        const alt = align(best.warped, onsets, P, lo, { s: k, j: best.match[k] })
        if (best.raw - alt.score < P.margin) match[k] = -1
      }
    }
    const count = match.filter((j) => j >= 0).length
    confidence = clamp(score / syl.length, 0, 1)
    if (count >= Math.max(1, Math.ceil(P.minMatchFrac * syl.length))) {
      const shift = new Array(n).fill(null)
      // loop: NOT-WORTH — the line's syllables, once per refine
      syl.forEach((s, k) => {
        if (match[k] < 0) return
        const o = onsets[match[k]]
        if (o.hold) heldUntil[s.w] = o.t + o.hold
        if (s.first) { shift[s.w] = o.t - s.t; anchored[s.w] = true }
      })
      if (P.interpolate) {
        // loop: NOT-WORTH — the line's words with a scan to the nearest anchors (≤ ~15²), once per refine
        for (let i = 0; i < n; i++) {
          if (anchored[i]) continue
          let a = i - 1, b = i + 1
          while (a >= 0 && !anchored[a]) a--
          while (b < n && !anchored[b]) b++
          if (a >= 0 && b < n) {   // between two anchors: linear; past the outer anchors: no move
            const f = (est[i].t - est[a].t) / Math.max(1e-6, est[b].t - est[a].t)
            shift[i] = shift[a] * (1 - f) + shift[b] * f
          }
        }
      }
      starts = est.map((w, i) => w.t + clamp(shift[i] || 0, -P.maxShift, P.maxShift))
    } else {
      confidence = Math.min(confidence, count / syl.length)
    }
  }

  // order and minimum lengths inside [lo, hi]; anything that can't fit keeps the estimate
  // loop: NOT-WORTH — two passes over the line's words, once per refine
  for (let i = 0; i < n; i++) {
    const min = i ? starts[i - 1] + P.minWord : lo
    if (starts[i] < min) starts[i] = min
  }
  for (let i = n - 1; i >= 0; i--) {
    const max = i < n - 1 ? starts[i + 1] - P.minWord : hi - P.minWord
    if (starts[i] > max) starts[i] = max
  }
  if (starts.some((t, i) => Math.abs(t - est[i].t) > P.maxShift + 1e-9 || t < lo - 1e-9 || (i && t < starts[i - 1] + P.minWord - 1e-9))) {
    starts = est.map((w) => w.t)
  }

  // held mid-line word (one of its syllables matched a held note): the note goes on past the
  // next word's estimated start, so that word and the unmatched ones after it shift right, up
  // to the next matched word / the line end
  if (P.midHolds) {
    // loop: NOT-WORTH — the line's words, with short inner scans to the next anchor, once per refine
    for (let i = 0; i < n - 1; i++) {
      if (anchored[i + 1] || !heldUntil[i]) continue
      const end = starts[i + 1]
      if (heldUntil[i] < end + P.minStretch) continue
      let k = i + 1
      while (k < n && !anchored[k]) k++
      let delta = Math.min(heldUntil[i] + 0.05 - end, (k < n ? starts[k] : hi) - P.minWord - starts[k - 1])
      for (let q = i + 1; q < k; q++) delta = Math.min(delta, est[q].t + P.maxShift - starts[q])
      if (delta < 0.05) continue
      // loop: NOT-WORTH — the words up to the next anchor
      for (let q = i + 1; q < k; q++) starts[q] += delta
    }
  }

  const words = est.map((w, i) => ({ t: starts[i], end: i < n - 1 ? starts[i + 1] : 0, text: w.text }))
  const last = words[n - 1]
  last.end = clamp(est[n - 1].end + (starts[n - 1] - est[n - 1].t), last.t + P.minWord, hi)

  // held last word: a voiced segment that carries it past its end, with no onset in between
  const v = voiced.find((s) => s.start <= last.t + 0.12 && s.end > last.t + 0.1)
  if (v && v.end > last.end + P.minStretch && !onsets.some((o) => o.t > last.t + 0.1 && o.t < v.end - 0.05)) {
    last.end = Math.min(v.end, hi)
  }
  // held: long enough, and its last holdTail seconds are one voiced note with no new syllable
  // loop: NOT-WORTH — the line's words, three passes, once per refine
  words.forEach((w, i) => { if (heldUntil[i] && heldUntil[i] - w.t >= P.holdMin) w.held = true })
  for (const w of words) {
    if (w.held || w.end - w.t < P.holdMin) continue
    const a = w.end - P.holdTail
    if (voiced.some((s) => s.start <= a && s.end >= w.end - 0.1) && !anyOnset(a, w.end - 0.05)) w.held = true
  }
  let moved = 0
  for (let i = 0; i < n; i++) if (Math.abs(words[i].t - est[i].t) > 0.005 || Math.abs(words[i].end - est[i].end) > 0.005) moved++
  return { words, moved, confidence }
}

/**
 * False-onset rate of a song: onsets per second (strength ≥ minStrength) in its instrumental
 * parts — the intro before the first line and the interludes (lyrics-timing findInterludes),
 * 0.5 s in from each side. A mix where the voice can't be told from the band (e.g. a centred
 * rhythm guitar) shows up as a high rate; refineWords then leaves the song alone.
 * lines: the song's (estimated) lines; onsets: everything detected so far; upTo: song time
 * analysed so far. -> { rate, seconds } (rate null until 3 s of instrumental audio was heard)
 */
function noiseRate(onsets, lines, upTo = Infinity, opts = {}) {
  const P = Object.assign({}, REFINE, opts)
  const spans = (findInterludes(lines) || []).map((g) => [g.start + 0.5, Math.min(upTo, g.end - 0.5)])
  if (!spans.length && lines && lines.length && lines[0].t != null) spans.push([0.5, Math.min(upTo, lines[0].t - 0.5)])
  let seconds = 0, count = 0
  // loop: NOT-WORTH — the song's instrumental spans × the onsets heard so far (≤ a few thousand), once per refined line
  for (const [a, b] of spans) {
    if (b <= a) continue
    seconds += b - a
    for (const o of onsets) if (o.strength >= P.minStrength && o.t >= a && o.t < b) count++
  }
  return { rate: seconds >= 3 ? count / seconds : null, seconds }
}

const MAX_PLAYS = 5   // after this many plays a new play still counts for 1/5

/**
 * Running average of learned word timings across plays. prev: learned words or null; next: this
 * play's refined words; plays: number of plays including this one. A different word list (lyrics
 * changed) starts over from `next`.
 */
function mergeLearned(prev, next, plays) {
  const fresh = () => next.map((w) => Object.assign({ t: w.t, end: w.end, text: w.text }, w.held ? { held: true } : {}))
  if (!prev || !next || prev.length !== next.length || prev.some((w, i) => w.text !== next[i].text)) return fresh()
  const k = 1 / clamp(Math.round(plays) || 1, 1, MAX_PLAYS)
  return next.map((w, i) => {
    const p = prev[i]
    const out = { t: p.t + (w.t - p.t) * k, end: p.end + (w.end - p.end) * k, text: w.text }
    if ((p.held || w.held) && out.end - out.t >= REFINE.holdMin) out.held = true
    return out
  })
}

module.exports = { refineWords, mergeLearned, noiseRate, REFINE, MAX_PLAYS }
