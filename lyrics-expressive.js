// Expressive words (Settings → Lyrics & Studio → Expressive words; on by default on Development
// channel builds): how the singing was sung, layered on top of the karaoke. The syllable pop stays
// exactly as it is (Marcy 2026-10-18: "it's how I follow along, it's key"); while a vowel is held, the
// expression lives inside and around the popped syllable:
//   - Stretch: the held vowel letter repeats as the note is held ("home" -> "hoooome"), each new letter
//     widening from nothing, the vowel letters wave at the singer's vibrato, and a belted word gains ink.
//     The room for the stretched spelling is reserved when the line is laid out (an invisible spacer
//     after the word), so nothing ever reflows: the letters grow with transform and opacity only.
//   - Ghost vocalise: a long held vowel (and a wordless "ooh" in the lyrics) spawns a large, translucent
//     copy of the held letters behind the lyrics, drifting, stretching as the note is held, breathing
//     with the loudness, wavering with the vibrato and fading when the note ends.
// Accuracy rule: only what the engine measured with confidence is drawn (the `expr` part of the
// helper's notes result, protocol 2 feature "expr", version 1 or 2); a word without it looks as today.
//
// This file is the pure part (no DOM, no Electron; test/expressive.test.js): the cached form of the
// helper's `expr` (compact), what the view gets (forView), which word gets what (matchWord), and the
// Web Animation keyframes the view plays (lyrics-view.js draws them, on the compositor).
'use strict'

const VERSIONS = [1, 2]       // the expr versions this Sonata reads (2 only adds fields to 1)
const FORMAT = 1              // the cached form below
const CONF_MIN = 0.5          // a word's overall confidence below this: nothing is drawn for it
const VIB_CONF = 0.5          // the engine's own vibrato gate; kept here too, so a looser engine can't lower it
const LOUD_CONF = 0.5
const ENV_CONF = 0.6          // share of a held vowel's loudness points that were measured
const CONTOUR_CONF = 0.6      // voiced share of a held vowel's contour
const HOLD_MIN = 0.6          // s: a vowel held this long stretches (tuned 2026-10-18 from the mock-up's 0.45)
const LETTER_S = 0.1          // s of hold per extra vowel letter
const MAX_EXTRA = 5           // at most this many extra letters, and only as many as fit the gap after the word
const GHOST_MIN = 0.8         // s: a held vowel of a lyric word this long ghosts; a vocalise word from HOLD_MIN
const GHOST_ENTER = 0.3       // s: a ghost fades in this long before its vowel
const GHOST_FADE = 1.6        // s: and dissolves over this long after the voice lets go
const GHOST_MAX = 3           // ghosts on screen at once (the oldest goes first)
const GHOST_LETTERS = 7       // extra letters a ghost grows at most
const VIB_IN = 0.12           // s: a vibrato's wave fades in (never a hard edge) ...
const VIB_OUT = 0.25          // ... and out
const WAVE_EM = 0.05          // em: the stretch's wave depth at a 60 cent vibrato (<= 0.07 em)
// wordless vocalise written in the lyrics (oh / ooh / ahh / mm …): the whole word ghosts, not just its vowel
const VOCALISE = /^(o+h*|u+h+|a+h+|m+|hm+|mm+h*|la+|na+|whoa+|wo+|ooh+|ahh+|ah|oh)$/i
const LETTER = /\p{L}/u

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null)
const r3 = (v) => Math.round(v * 1000) / 1000
const clamp = (x, a, b) => Math.max(a, Math.min(b, x))
const smooth = (x) => { const v = clamp(x, 0, 1); return v * v * (3 - 2 * v) }
const pts = (a, n) => Array.isArray(a) && a.length > 0 && a.every((p) => Array.isArray(p) && p.length >= n && p.slice(0, n).every((x) => num(x) !== null))

// --- the cached form (sheet-notes-store.js keeps it with the song's notes) ---

/**
 * The helper's `expr` part -> the cached form, or null (no expr, an unknown version). Only what the
 * view can draw and only what passed the gates; lines shifted by lineOffset (a section job's lines
 * start there). -> { format, v, words: [{ l, w, c, i0, i1, x, t, e, ld?, vb?, env?, ct? }], voc: [...] }
 */
function compact(expr, lineOffset = 0) {
  if (!expr || typeof expr !== 'object' || !VERSIONS.includes(expr.version) || !Array.isArray(expr.words)) return null
  const off = Number.isInteger(lineOffset) ? lineOffset : 0
  const words = []
  // loop: NOT-WORTH — the song's expr words (one per sung word, ≤ ~600), once per notes result
  for (const w of expr.words) {
    if (!w || !Number.isInteger(w.line) || !Number.isInteger(w.word) || !(num(w.conf) >= CONF_MIN)) continue
    const v = w.vowel
    const out = { l: w.line + off, w: w.word, c: Math.round(w.conf * 100) / 100 }
    if (v && Number.isInteger(v.i0) && Number.isInteger(v.i1) && v.i1 > v.i0 && num(v.t) !== null && num(v.end) >= v.t) {
      Object.assign(out, { i0: v.i0, i1: v.i1, t: r3(v.t), e: r3(v.end) })
      if (typeof v.text === 'string' && v.text.length === v.i1 - v.i0) out.x = v.text
    }
    if (num(w.loud) !== null && num(w.loud_conf) >= LOUD_CONF) out.ld = clamp(w.loud, -1, 1)
    const vb = w.vibrato
    if (out.t != null && vb && num(vb.rate) > 0 && num(vb.extent) > 0 && num(vb.t) !== null && num(vb.end) > vb.t && num(vb.conf) >= VIB_CONF) {
      out.vb = { r: vb.rate, d: vb.extent, t: r3(vb.t), e: r3(vb.end) }
      // loop: NOT-WORTH — the song's vocalise spans (a few), once per notes result
      if (pts(vb.track, 3)) out.vb.tr = vb.track.map((p) => [r3(p[0]), p[1], p[2]])
    }
    // loop: NOT-WORTH — one vocalise span's loudness points, once per notes result
    if (out.t != null && pts(w.loud_env, 2) && num(w.loud_env_conf) >= ENV_CONF) out.env = w.loud_env.map((p) => [r3(p[0]), clamp(p[1], -1, 1)])
    // version 1 has no contour_conf: the engine sends a contour only where 60 % of it is voiced
    // loop: NOT-WORTH — one vocalise span's contour points, once per notes result
    if (out.t != null && pts(w.contour, 2) && (w.contour_conf == null || num(w.contour_conf) >= CONTOUR_CONF)) out.ct = w.contour.map((p) => [r3(p[0]), Math.round(p[1])])
    if (out.t != null || out.ld != null) words.push(out)
  }
  // held singing on no lyric word (version 2, e.g. Nude's wordless intro): its vowel isn't named (not measured),
  // so it can only ghost as a neutral "ooo", behind its own sub-setting (Wordless vocalise ghosts)
  // TODO(Marcy): the sung vowel's name once the engine measures it (BACKLOG "Expressive lyrics: the voice shapes the words")
  // loop: NOT-WORTH — the song's vocalise spans (a few), once per notes result
  const voc = (Array.isArray(expr.vocalise) ? expr.vocalise : [])
    .filter((x) => x && num(x.t) !== null && num(x.end) > x.t && num(x.conf) >= CONF_MIN)
    .map((x) => {
      const o = { t: r3(x.t), e: r3(x.end), c: x.conf }
      if (x.vibrato && num(x.vibrato.rate) > 0 && num(x.vibrato.extent) > 0 && num(x.vibrato.end) > x.vibrato.t && num(x.vibrato.conf) >= VIB_CONF) o.vb = { r: x.vibrato.rate, d: x.vibrato.extent, t: r3(x.vibrato.t), e: r3(x.vibrato.end) }
      if (pts(x.loud_env, 2)) o.env = x.loud_env.map((p) => [r3(p[0]), clamp(p[1], -1, 1)])
      if (pts(x.contour, 2)) o.ct = x.contour.map((p) => [r3(p[0]), Math.round(p[1])])
      return o
    })
  return { format: FORMAT, v: expr.version, words, voc }
}

/**
 * A first play's expression so far (compact form, or null) with one more section's (compact) merged in: its lines'
 * words replace those lines' old words, and its vocalise spans replace the old ones they overlap (QC 2026-10 #7:
 * a replay or a section measured again appended its vocalise again, ghosts stacked).
 */
function mergeSection(old, add) {
  if (!add) return old || null
  const base = old || { format: add.format, v: add.v, words: [], voc: [] }
  // loop: NOT-WORTH — once per first-play section (every ~10-30 s), N ≤ ~500 words
  const lines = new Set(add.words.map((w) => w.l))
  const addVoc = Array.isArray(add.voc) ? add.voc : []
  // loop: NOT-WORTH — once per first-play section (every ~10-30 s), N ≤ ~500 words, a few vocalise spans (filter + sort)
  const words = base.words.filter((w) => !lines.has(w.l)).concat(add.words).sort((a, b) => a.l - b.l || a.w - b.w)
  // loop: NOT-WORTH — as above: the vocalise spans so far (a few) x this section's (a few)
  const voc = (base.voc || []).filter((v) => !addVoc.some((x) => x.t < v.e && x.e > v.t)).concat(addVoc).sort((a, b) => a.t - b.t)
  return { format: add.format, v: add.v, words, voc }
}

/**
 * The cached form, checked -> what the view gets ({ v, words, voc }) or null. Off: always null (today's
 * look). vocalise: the wordless vocalise ghosts' sub-setting (off: no voc).
 */
function forView(cached, on, vocalise) {
  if (!on || !cached || cached.format !== FORMAT || !Array.isArray(cached.words)) return null
  const voc = vocalise && Array.isArray(cached.voc) ? cached.voc : []
  if (!cached.words.length && !voc.length) return null
  return { v: cached.v, words: cached.words, voc }
}

/**
 * The wordless vocalise spans the view may ghost: held singing no lyric word covers (each word's span with
 * a margin), as a matchWord-shaped expression with a neutral "ooo". lines: the view's lines.
 */
function vocaliseExpressions(doc, lines) {
  if (!doc || !Array.isArray(doc.voc) || !doc.voc.length) return []
  const spans = []
  // loop: NOT-WORTH — the song's words (≤ ~600), once per song laid out
  for (const l of lines || []) for (const w of (l && l.words) || []) if (num(w.t) !== null) spans.push([w.t - 0.15, (num(w.end) !== null ? w.end : w.t) + 0.15])
  // loop: NOT-WORTH — the vocalise spans (a few) x the words, once per song laid out
  return doc.voc.filter((v) => v.e - v.t >= HOLD_MIN && !spans.some(([a, b]) => a < v.e && b > v.t)).map((v) => ({
    hold: v.e - v.t, vt: v.t, ve: v.e, ink: 0, vb: v.vb || null, env: v.env || null, ct: v.ct || null, i0: -1,
    ghost: { base: 'oo', tail: '', grow: Math.min(GHOST_LETTERS - 2, Math.round((v.e - v.t) / 0.25)) }
  }))
}

// --- which word gets what ---

/**
 * One view word's expression, or null: the cached word for (line, word) whose vowel letters are this
 * word's letters and whose times sit on its time (a line whose words differ from the ones the helper
 * analysed gets nothing). word: { text, t, end, syl? }. glued: the next word is written straight after
 * this one (a hyphen run: no room may open between them).
 * -> { hold, extra, rep, i0, i1, vt, ve, ink, quiet, vb, env, ct, ghost: { text, tail, letters } | null,
 *      stretch: bool }
 */
function matchWord(x, word, glued, nextT) {
  if (!x || !word || typeof word.text !== 'string') return null
  const text = word.text
  const out = { hold: 0, extra: 0, rep: '', i0: -1, i1: -1, vt: null, ve: null, ink: 0, quiet: false, vb: null, env: null, ct: null, ghost: null, stretch: false }
  if (x.ld != null) { out.ink = clamp(((x.ld + 1) / 2 - 0.55) / 0.45, 0, 1); out.quiet = x.ld < -0.45 }
  if (x.i0 != null && x.i1 <= text.length) {
    const letters = text.slice(x.i0, x.i1)
    const wt = num(word.t)
    const we = num(word.end)
    // on the word's time: from its start to its end, or to the next word's start when the lyrics' own word
    // time ends before the sung note does (Apple's word times often lead the singing; 0.15.57)
    const until = Math.max(we !== null ? we : wt, num(nextT) !== null ? nextT : -Infinity)
    const onTime = wt !== null && x.t >= wt - 0.3 && x.t <= until + 0.3
    // loop: NOT-WORTH — a held vowel's letters (1-3), per word matched (line laid out or applyExpr), not per frame
    if ([...letters].every((c) => LETTER.test(c)) && (x.x == null || x.x === letters) && onTime) {
      out.i0 = x.i0
      out.i1 = x.i1
      out.vt = x.t
      out.ve = x.e
      out.hold = Math.max(0, x.e - x.t)
      out.rep = letters[letters.length - 1]
      out.vb = x.vb || null
      out.env = x.env || null
      out.ct = x.ct || null
      if (out.hold >= HOLD_MIN) {
        out.extra = Math.min(MAX_EXTRA, Math.round((out.hold - 0.2) / LETTER_S))
        // the held vowel must sit in the word's last syllable (the room opens after the word)
        out.stretch = out.extra > 0 && !glued && heldInLastSyllable(word, x.i0)
      }
      out.ghost = ghostLetters(text, letters, out.hold)
    }
  }
  if (out.i0 < 0 && !out.ink && !out.quiet) return null
  return out
}

function heldInLastSyllable(word, i0) {
  if (!Array.isArray(word.syl) || word.syl.length < 2) return true
  // loop: NOT-WORTH — a word's syllables (a handful), per word matched (line laid out or applyExpr)
  const parts = word.syl.map((s) => String((s && s.text) || ''))
  if (parts.join('') !== word.text) return false
  return i0 >= word.text.length - parts[parts.length - 1].length
}

/**
 * The letters a ghost is written with, or null: a vocalise word ("ooh") ghosts its own letters, its
 * last vowel growing ("ooo…h"); a lyric word held at least GHOST_MIN its held vowel letters.
 * TODO(Marcy): she may prefer the sung sound over the written vowel ("cry" -> "aiii"); her call later
 * (BACKLOG "Expressive lyrics: the voice shapes the words").
 */
function ghostLetters(text, letters, hold) {
  const bare = String(text).replace(/[^\p{L}]/gu, '')
  if (VOCALISE.test(bare) && hold >= HOLD_MIN) {
    const m = bare.toLowerCase().match(/^(\p{L}*?)(\p{L})(h*)$/u)
    const base = m ? m[1] + m[2] : bare.toLowerCase()
    return { base, tail: m && m[3] ? 'h' : '', grow: Math.min(GHOST_LETTERS, Math.round(hold / 0.12)) }
  }
  if (hold < GHOST_MIN) return null
  return { base: letters.toLowerCase(), tail: '', grow: Math.min(GHOST_LETTERS, Math.round(hold / 0.12)) }
}

/** The expressions of a line's words: [{ i (word index), m (matchWord) }], drawn ones only. */
function lineExpressions(doc, lineIndex, words, glue) {
  if (!doc || !Array.isArray(words)) return []
  const out = []
  // loop: NOT-WORTH — the song's expr words (≤ ~600) once per line laid out, then one line's words (~5-12)
  const mine = doc.words.filter((x) => x.l === lineIndex)
  if (!mine.length) return out
  // loop: NOT-WORTH — one line's words, once per line laid out
  words.forEach((w, i) => {
    const x = mine.find((y) => y.w === i)
    const next = words[i + 1]
    const m = x ? matchWord(x, w, !!(glue && glue[i + 1]), next ? next.t : null) : null
    if (m) out.push({ i, m })
  })
  return out
}

/** A matched word draws something the eye sees: ink, a lighter shade, a stretch, a vibrato or a ghost. */
const shows = (m) => !!(m && (m.ink > 0 || m.quiet || m.stretch || m.vb || m.ghost))

/**
 * The song report's view of one line (song-report.js): the measured words the helper sent for it, how many
 * of them the view can draw, and why the rest can't, counted by reason. Same checks as matchWord.
 * -> { measured, drawable, skip: { reason: n } }
 */
function lineExprReport(doc, lineIndex, words, glue) {
  const out = { measured: 0, drawable: 0, skip: {} }
  if (!doc || !Array.isArray(doc.words) || !Array.isArray(words)) return out
  const no = (why) => { out.skip[why] = (out.skip[why] || 0) + 1 }
  // loop: NOT-WORTH — the song's expr words (≤ ~600) once per line lit (every few seconds), then the line's (0-3)
  for (const x of doc.words) {
    if (x.l !== lineIndex) continue
    out.measured++
    const w = words[x.w]
    const next = words[x.w + 1]
    const m = w ? matchWord(x, w, !!(glue && glue[x.w + 1]), next ? next.t : null) : null
    if (shows(m)) { out.drawable++; continue }
    if (!w || typeof w.text !== 'string') no('words differ')
    else if (x.i0 == null && x.ld == null) no('no vowel data')
    else if (x.i0 != null && (x.i1 > w.text.length || (x.x != null && x.x !== w.text.slice(x.i0, x.i1)))) no('words differ')
    else if (x.i0 != null && (!m || m.i0 < 0)) no('wrong repeat')
    else no('below threshold')
  }
  return out
}

// --- the keyframes (Web Animations on the compositor: transform and opacity only) ---
// Every timeline below runs in song time from t0 (ms = (song time - t0) * 1000); the view keeps it in
// step with the lyrics clock, as it does the countdown dots.

/**
 * The stretch of one held word: its timeline, from when the word lights (lit, song time) to just after
 * the vowel ends. Before the vowel the extra letters wait unborn and the coda sits right after the vowel.
 */
function stretchTimeline(m, lit) {
  const t0 = Math.min(num(lit) !== null ? lit : m.vt, m.vt)
  return { t0, t1: m.ve + 0.3 }
}

/**
 * Extra letter k of n: invisible, then over its share of the hold (from vt) it fades in and widens from
 * nothing (scaleX from its left edge), then stays. -> keyframes over [t0, t1]
 */
function letterBirth(k, n, t0, t1, vt, hold, squeeze = 1, back = 0) {
  const span = Math.max(0.001, t1 - t0)
  const a = clamp((vt - t0 + hold * k / n) / span, 0, 1)
  const b = clamp((vt - t0 + hold * (k + 1) / n) / span, a, 1)
  // squeezed letters (squeezePlan) also move back by `back` px, so they sit side by side at their narrower width
  const tf = (sx) => (back ? 'translateX(' + (-back).toFixed(2) + 'px) ' : '') + 'scaleX(' + sx + ')'
  const full = +squeeze.toFixed(3)
  return [
    { offset: 0, opacity: 0, transform: tf(0.001) },
    { offset: a, opacity: 0, transform: tf(0.001) },
    { offset: b, opacity: 1, transform: tf(full) },
    { offset: 1, opacity: 1, transform: tf(full) }
  ]
}

/** The coda (as written) rides just after the newest letter: from where it is to widthPx to its right. */
function codaRide(widthPx, t0, t1, vt, hold) {
  const span = Math.max(0.001, t1 - t0)
  const a = clamp((vt - t0) / span, 0, 1)
  const b = clamp((vt - t0 + hold) / span, a, 1)
  const to = 'translateX(' + widthPx.toFixed(2) + 'px)'
  return [{ offset: 0, transform: 'translateX(0px)' }, { offset: a, transform: 'translateX(0px)' }, { offset: b, transform: to }, { offset: 1, transform: to }]
}

const SQUEEZE_MIN = 0.4     // extra letters may be squeezed to this share of their width to fit the gap

/**
 * The extra letters a hold shows in freePx (the gap after the popped word, popRoom): all `extra` of them at
 * full width when they fit, else squeezed (down to SQUEEZE_MIN) so the hold still reads, else as many as fit
 * squeezed. -> { n, scale }
 */
function squeezePlan(extra, freePx, letterPx, popScale = 1) {
  if (!(extra > 0) || !(freePx > 0) || !(letterPx > 0)) return { n: 0, scale: 1 }
  const unit = letterPx * Math.max(1, popScale)
  if (extra * unit <= freePx) return { n: extra, scale: 1 }
  const sc = freePx / (extra * unit)
  if (sc >= SQUEEZE_MIN) return { n: extra, scale: Math.floor(sc * 1000) / 1000 }
  return { n: Math.min(extra, Math.floor(freePx / (unit * SQUEEZE_MIN))), scale: SQUEEZE_MIN }
}

/**
 * How far the rest of a row slides (px) for n extra letters of letterPx at `squeeze` of their width, popped
 * at popScale, beyond the freePx gap the pop already leaves (0: they fit without moving anything).
 */
function nudgePx(n, letterPx, squeeze, popScale, freePx) {
  if (!(n > 0)) return 0
  return Math.max(0, Math.ceil(n * letterPx * squeeze * Math.max(1, popScale) - Math.max(0, freePx || 0)))
}

/**
 * When the row's slide runs (s): the letters grow linearly through the hold (from vt, for `hold` s) to
 * totalPx; the row moves only once they pass the free gap, and arrives with the hold's end. now: the song
 * time it starts at (a seek into the hold: what's left). toPx: where this slide's share ends (the row's right
 * slide hands over to the sung words' left slide); by default the whole push, at the hold's end. -> { delay, duration }
 */
function nudgeTiming(vt, hold, freePx, totalPx, now, toPx = totalPx) {
  const share = (px) => totalPx > 0 ? clamp(Math.max(0, px) / totalPx, 0, 1) : 0
  const from = vt + hold * share(freePx)
  const to = vt + hold * Math.max(share(freePx), share(toPx))
  const start = Math.max(from, now)
  return { delay: Math.max(0, from - now), duration: Math.max(0.05, to - start) }
}

/**
 * Where a stretch's push (nudgePx) comes from: first the later words slide right (up to rightPx, the row's
 * free space after its last word), then the words already sung and the held word slide left (up to leftPx:
 * the held word's left edge; the sung words may leave the row). -> { right, left } (px, both >= 0)
 */
function splitPush(push, rightPx, leftPx) {
  const p = Math.max(0, push || 0)
  const right = Math.min(p, Math.max(0, rightPx || 0))
  return { right, left: Math.min(p - right, Math.max(0, leftPx || 0)) }
}

/** How many extra letters show: as many as fit freePx after the popped word (letters scale with the pop). */
function visibleExtras(extra, freePx, letterPx, scale = 1) {
  if (!(extra > 0) || !(freePx > 0) || !(letterPx > 0)) return 0
  return Math.max(0, Math.min(extra, Math.floor(freePx / (letterPx * Math.max(1, scale)))))
}

/** A letter held at its contour height for the whole timeline (no vibrato to wave it). */
function heldAt(px) { const t = 'translateY(' + px.toFixed(2) + 'px)'; return [{ offset: 0, transform: t }, { offset: 1, transform: t }] }

/** When extra letter k of n is born (song time): the contour height it keeps is the voice's then. */
function bornAt(k, n, vt, hold) { return vt + hold * (k + 0.5) / n }

/** A letter's height from the contour (px; up is negative): ±2.5 semitones ≈ ±0.075 em. */
function contourPx(ct, t, fontPx) { return -clamp(contourAt(ct, t), -250, 250) / 100 * fontPx * 0.03 }

/** Whether a build is a Development channel one (Expressive words' default: on there, off on Stable). */
function defaultOn(version) { return /-dev(\.\d+)?$/.test(String(version || '')) }

/** The vibrato's rate and depth at time t (its per-cycle track when the engine sent one, version 2). */
function vibAt(vb, t) {
  if (!vb.tr || !vb.tr.length) return { rate: vb.r, depth: vb.d }
  let row = vb.tr[0]
  // loop: NOT-WORTH — a vibrato's cycles (≤ ~8 per s of the note), per keyframe built (once per held word)
  for (const p of vb.tr) if (p[0] <= t) row = p
  return { rate: row[1] > 0 ? row[1] : vb.r, depth: row[2] > 0 ? row[2] : vb.d }
}

/**
 * A letter's wave (translateY) over [t0, t1]: the measured vibrato, eased in over VIB_IN and out over
 * VIB_OUT, at depth amp px for a 60 cent extent (0.3x-1.4x); phase: the letter's lag (rad), so the wave
 * travels along the letters. base: the letter's own height (px, from the contour), added throughout.
 * 8 keyframes per vibrato cycle. -> keyframes, or null without a vibrato in the timeline
 */
function waveKeyframes(vb, t0, t1, amp, phase, base = 0) {
  if (!vb || vb.e <= t0 || vb.t >= t1) return null
  const span = Math.max(0.001, t1 - t0)
  const out = []
  const at = (t) => clamp((t - t0) / span, 0, 1)
  const y = (t) => {
    if (t < vb.t || t > vb.e + VIB_OUT) return base
    const env = smooth((t - vb.t) / VIB_IN) * (t > vb.e ? 1 - smooth((t - vb.e) / VIB_OUT) : 1)
    const { rate, depth } = vibAt(vb, t)
    // phase accumulates the rate over time, so a vibrato that speeds up stays continuous
    return base + clamp(depth / 60, 0.3, 1.4) * amp * env * Math.sin(phaseAt(vb, t) - phase)
  }
  out.push({ offset: 0, transform: 'translateY(' + base.toFixed(2) + 'px)' })
  const step = 1 / (8 * Math.max(3, vb.r))
  // loop: NOT-WORTH — 8 keyframes per vibrato cycle over one held vowel (≤ ~100), once per held word
  for (let t = Math.max(t0, vb.t); t <= Math.min(t1, vb.e + VIB_OUT); t += step) out.push({ offset: at(t), transform: 'translateY(' + y(t).toFixed(2) + 'px)' })
  out.push({ offset: 1, transform: 'translateY(' + base.toFixed(2) + 'px)' })
  // offsets must not go back (two samples on the same offset are fine)
  // loop: NOT-WORTH — the keyframes just made
  for (let i = 1; i < out.length; i++) if (out[i].offset < out[i - 1].offset) out[i].offset = out[i - 1].offset
  return out
}

// the vibrato's phase at t: 2π ∫ rate dt from its start (per-cycle rates from the track, else the median)
function phaseAt(vb, t) {
  if (!vb.tr || vb.tr.length < 2) return 2 * Math.PI * vb.r * (t - vb.t)
  let ph = 0
  let prev = vb.t
  // loop: NOT-WORTH — a vibrato's cycles (≤ ~8 per s), per keyframe sample (once per held word)
  for (let i = 0; i < vb.tr.length; i++) {
    const start = Math.max(vb.t, vb.tr[i][0])
    const end = i + 1 < vb.tr.length ? vb.tr[i + 1][0] : Infinity
    const rate = vb.tr[i][1] > 0 ? vb.tr[i][1] : vb.r
    if (t <= start) break
    const to = Math.min(t, end)
    ph += 2 * Math.PI * rate * (to - Math.max(prev, start))
    prev = to
    if (t <= end) break
  }
  return ph
}

/** The contour at time t, cents (0 outside it; a gap in the voiced points holds, never invents a glide). */
function contourAt(ct, t) {
  if (!ct || !ct.length || t < ct[0][0] - 0.05) return 0
  if (t >= ct[ct.length - 1][0]) return ct[ct.length - 1][1]
  // loop: NOT-WORTH — a held vowel's contour (≤ 20 points per s), per letter placed (once per held word)
  for (let i = 1; i < ct.length; i++) {
    if (ct[i][0] >= t) {
      const a = ct[i - 1]
      const b = ct[i]
      if (b[0] - a[0] > 0.12) return a[1]
      return a[1] + (b[1] - a[1]) * (t - a[0]) / (b[0] - a[0])
    }
  }
  return 0
}

/** Loudness -1..1 at t: the envelope (version 2) where there is one, else the word's loudness. */
function loudAt(m, t) {
  const e = m.env
  if (e && e.length) {
    if (t <= e[0][0]) return e[0][1]
    // loop: NOT-WORTH — a held vowel's envelope (≤ 20 points per s), per keyframe (once per ghost)
    for (let i = 1; i < e.length; i++) if (e[i][0] >= t) return e[i - 1][1] + (e[i][1] - e[i - 1][1]) * (t - e[i - 1][0]) / Math.max(1e-6, e[i][0] - e[i - 1][0])
    return e[e.length - 1][1]
  }
  return m.ink ? (m.ink * 0.45 + 0.55) * 2 - 1 : 0
}

/** A deterministic 0..1 from a string (where a ghost appears: the same every play). */
function hash01(s) {
  let h = 2166136261
  // loop: NOT-WORTH — a short key (the song and the word), once per ghost
  for (const c of String(s)) h = Math.imul(h ^ c.charCodeAt(0), 16777619)
  return ((h >>> 0) % 1000) / 1000
}

/**
 * One ghost's plan: its size (times the line's type: 3-5x, with the loudness), its
 * timeline [t0, t1], the opacity keyframes (in, breathing with the loudness, out), the drift and the
 * birth time of each letter. Its drift is tied to the note's own timing for now: it crosses about a
 * fifth of the layer over its life, so a long slow note floats slowly.
 * TODO: beat-synced drift (enter on a downbeat, cross in N bars) once the engine tracks the tempo
 * (BACKLOG "Expressive lyrics: the voice shapes the words").
 * still (reduced motion): no drift and no wave, the letters all there, fading in and out only.
 * driftPx: how far it drifts over its life (the view: a gentle 6 % of the lyrics' width). Where it sits is
 * the view's (centred in the free space beside the sung line).
 * -> { size, t0, t1, opacity: keyframes, drift: keyframes|null, letters: [{ ch, born }] }
 */
function ghostPlan(m, seed, still, driftPx = 0) {
  const g = m.ghost
  const v0 = m.vt
  const v1 = m.ve
  const t0 = v0 - GHOST_ENTER
  const t1 = v1 + GHOST_FADE
  const span = t1 - t0
  const loud01 = clamp((loudAt(m, (v0 + v1) / 2) + 1) / 2, 0, 1)
  const letters = []
  const text = g.base + (g.base[g.base.length - 1] || '').repeat(g.grow) + g.tail
  const n = text.length
  // loop: NOT-WORTH — a ghost's letters (≤ ~12), once per ghost
  for (let i = 0; i < n; i++) {
    const grown = i >= g.base.length && i < g.base.length + g.grow
    const born = grown ? v0 + (v1 - v0) * (i - g.base.length + 1) / (g.grow + 1) : (i >= g.base.length + g.grow ? v1 : v0)
    letters.push({ ch: text[i], born: still ? v0 : born })
  }
  const opacity = []
  const at = (t) => clamp((t - t0) / span, 0, 1)
  // far back: 4-12 % (the mock-up's Ghost vocalise), louder singing a little stronger
  const peak = (t) => 0.04 + 0.08 * clamp((loudAt(m, t) + 1) / 2, 0, 1)
  opacity.push({ offset: 0, opacity: 0 })
  opacity.push({ offset: at(v0), opacity: +peak(v0).toFixed(3) })
  // breathing with the loudness: one keyframe every 0.1 s through the hold (still: one level)
  if (!still) {
    // loop: NOT-WORTH — one keyframe per 0.1 s of a held vowel (≤ ~60), once per ghost
    for (let t = v0 + 0.1; t < v1; t += 0.1) opacity.push({ offset: at(t), opacity: +peak(t).toFixed(3) })
  }
  opacity.push({ offset: at(v1), opacity: +peak(v1).toFixed(3) })
  opacity.push({ offset: 1, opacity: 0 })
  return {
    size: 3 + 2 * loud01,
    t0,
    t1,
    opacity,
    drift: still || !(driftPx > 0) ? null : [{ offset: 0, transform: 'translateX(0px)' }, { offset: 1, transform: 'translateX(' + driftPx.toFixed(1) + 'px)' }],
    letters
  }
}

/** A ghost letter's birth: invisible until its moment, then fading in over 0.25 s. -> keyframes or null */
function ghostLetterBirth(born, t0, t1) {
  if (born <= t0) return null
  const span = Math.max(0.001, t1 - t0)
  const a = clamp((born - t0) / span, 0, 1)
  return [{ offset: 0, opacity: 0 }, { offset: a, opacity: 0 }, { offset: clamp(a + 0.25 / span, a, 1), opacity: 1 }, { offset: 1, opacity: 1 }]
}

// --- the per-song log line (main.js: one per song shown, and one when a song's expression is measured) ---

/** What a cached expression holds for the eye: { held (vowels held >= HOLD_MIN), ghosts (lyric words held >= GHOST_MIN, plus wordless vocalise), v } */
function summary(cached) {
  const c = cached && typeof cached === 'object' ? cached : {}
  const words = Array.isArray(c.words) ? c.words : []
  const voc = Array.isArray(c.voc) ? c.voc : []
  let held = 0
  let ghosts = 0
  // loop: NOT-WORTH — the song's expr words (≤ ~600), once per song
  for (const w of words) {
    if (num(w.t) === null || num(w.e) === null) continue
    const hold = w.e - w.t
    if (hold >= HOLD_MIN) held++
    if (hold >= GHOST_MIN) ghosts++
  }
  // loop: NOT-WORTH — the song's vocalise spans (a few)
  for (const x of voc) if (num(x.t) !== null && num(x.e) !== null && x.e - x.t >= HOLD_MIN) ghosts++
  return { held, ghosts, v: c.v || null }
}

/**
 * The one log line for a song: why it shows expression or why not. state: { on, helper: 'serves' | 'lacks' |
 * 'unknown', entry: the song's notes entry for these lyrics or null, title } -> 'expressive: …'
 */
function statusLine(state) {
  const st = state || {}
  const what = st.title ? ' for "' + st.title + '"' : ''
  if (!st.on) return 'expressive: none' + what + ' (Expressive words or Precise word timing is off)'
  const e = st.entry
  if (e && e.expr) {
    const n = summary(e.expr)
    if (!n.held && !n.ghosts) return 'expressive: none' + what + ' (nothing held long enough and measured with confidence, expr v' + (n.v || '?') + ')'
    return 'expressive: ' + n.held + ' held notes, ' + n.ghosts + ' ghosts' + what + ' (expr v' + (n.v || '?') + ')'
  }
  if (e && 'expr' in e) return 'expressive: none' + what + ' (the helper measured nothing confident in it)'
  if (st.helper === 'lacks') return 'expressive: none' + what + ' (this helper version does not measure expression: update the helper)'
  if (st.helper === 'unknown') return 'expressive: none' + what + ' yet (the helper has not answered yet)'
  return 'expressive: none' + what + ' yet (no audio yet: measured from this play once the song is heard to its end, drawn as soon as it is)'
}

/**
 * The lyrics view's one line about Expressive words when it is on but can't draw (yet), or null when there is
 * nothing to say (it draws, it's off, or the song can't have it). Visible text ≤ 60 characters (info-tip.js
 * TEXT_MAX), the rest behind the ⓘ; action: a button that opens Settings → Precise timing ('install' | 'show').
 * st: { on (the setting), installed, installing, update (the helper is too old), precise (Precise word timing),
 *   helper: 'unknown' | 'serves' | 'lacks', pitch: '' | 'downloading' | 'failed', pitchWhy,
 *   entry: 'drawn' | 'none' | 'missing' (this song's measured expression), job: 'measuring' | 'recording' | 'sections' (first play: section results flowing) | '',
 *   paused (a game runs: the timing note says so) }
 */
function noteFor(state) {
  const st = state || {}
  if (!st.on) return null
  const say = (text, info, action) => ({ text, info: info || '', action: action || '' })
  const what = 'Expressive words draws how each word was sung (held notes stretching, wordless vocalise as ghosts) from what the Precise timing helper measures on this PC.'
  // first play (0.15.66): the sections' expression flows in while the song plays, drawn from the next line on
  if (st.job === 'sections' && !st.paused) return say('Expressive words: measuring as it plays', what + ' This first play is measured section by section while it plays: each part draws from the next line after it was heard, and the whole song is measured once more at its end.')
  if (st.entry === 'drawn') return null
  if (st.installing) return say('Expressive words: the helper is being installed…', what + ' It starts once the helper is installed (Settings → Precise timing).', 'show')
  if (st.update) return say('Expressive words needs a newer helper', what + ' This helper is too old for this Sonata: update it in Settings → Precise timing.', 'show')
  if (!st.installed) return say('Expressive words needs the Precise timing helper', what + ' Install the helper in Settings → Precise timing (a separate download).', 'install')
  if (!st.precise) return say('Expressive words: Precise word timing is off', what + ' Turn on Precise word timing in Settings → Precise timing.', 'show')
  if (st.helper === 'lacks') return say('Expressive words needs a newer helper', what + ' This helper version doesn’t measure it: update it in Settings → Precise timing.', 'show')
  if (st.pitch === 'downloading') return say('Expressive words: downloading the pitch model…', what + ' It needs the pitch model, downloaded once.')
  if (st.pitch === 'failed') return say('Expressive words: the pitch model didn’t download', (st.pitchWhy ? st.pitchWhy + '. ' : '') + 'Turn Expressive words off and on in Settings → Lyrics & Studio to try again.')
  if (st.paused) return null
  if (st.entry === 'none') return say('Expressive words: nothing held long enough in this song', 'The helper measured this song and found no word held long enough, and no wordless singing, to draw with confidence.')
  if (st.job === 'measuring') return say('Expressive words: measuring this song…', what + ' It draws as soon as the helper is done, during this play.')
  if (st.job === 'recording') return say('Expressive words: measured once this song has played through', what + ' The helper measures the song from this play once it has been heard to its end; it draws right after.')
  return null
}

module.exports = {
  noteFor,
  VERSIONS, FORMAT, CONF_MIN, HOLD_MIN, LETTER_S, MAX_EXTRA, GHOST_MIN, GHOST_ENTER, GHOST_FADE, GHOST_MAX, WAVE_EM, VOCALISE,
  compact, mergeSection, forView, vocaliseExpressions, matchWord, lineExpressions, lineExprReport, shows, stretchTimeline, letterBirth, codaRide, visibleExtras, squeezePlan, nudgePx, splitPush, nudgeTiming, bornAt, contourPx, heldAt, defaultOn, waveKeyframes,
  contourAt, loudAt, ghostPlan, ghostLetterBirth, hash01, summary, statusLine
}
