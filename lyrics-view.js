// The lyrics engine both lyric views run: the lyrics window (lyrics.html, 'scroll' layout: every line
// in a scrolling list) and the visualizer overlay (visualizer.html, 'stage' layout: the line being sung
// big and centred, the next line under it). One copy of the model, the clock, the word timing and the
// rendering; the pages only add their own chrome and styles (shared word/dot styles: lyrics-view.css).
//
// Data path (main.js lyrics feed, the same for both windows):
//   'lyrics-data'    -> setData(data)      full line/word objects, estimated + learned timing applied
//   'lyrics-time'    -> setTime(t, playing)  2 pushes/s; the smooth clock (lyrics-timing syncClock)
//   'lyrics-refined' -> refine(msg)       Level 1 refined words for one line
//   'lyrics-aligned' -> align(msg)        Level 2 aligned words for the song's lines (precise word timing)
//   'lyrics-align-state' -> alignState(t) a short state for the timing note ("Precise timing paused while you play")
//   data.expr (Expressive words, lyrics-expressive.js forView): only when the setting is on and the song's
//   notes carry the engine's measured expression; without it the view is exactly the plain karaoke.
// The pure helpers (prepare, refinedLine, alignedLines, timingNote, writtenBy, wordState, stageNext) are tested
// in test/lyrics-view.test.js.
//
// Karaoke: the word being sung is lit as a whole (.w.now). Apple words timed in several spans carry
// their syllables (word.syl, lyrics-sources.js): those render as .s spans inside the word and only
// the syllable being sung pops (.s.now); other words pop as a whole, as before. Words without Apple
// syllables get estimated ones (lyrics-syllables.js: hyphenation patterns for data.lang, en-US by
// default), once per line when the lyrics load or a line's timing is refined or aligned.
//
// Render path ("draw once, animate on the compositor", docs/research/gpu-render-hdr-2026-10.md): a word
// change is class writes only, never a layout. The sung word shows a stacked bold copy (.b) instead of
// changing its weight; the line's colour change is a crossfade of stacked copies (lyrics.html); the
// countdown dots are Web Animations made once per interlude (dotKeyframes); a dots row opening or
// closing slides the lines around it with a transform (FLIP), never a height animation.
const T = require('./lyrics-timing')
const S = require('./lyrics-syllables')
const X = require('./lyrics-expressive')
const { createInfoTip } = require('./info-tip')

const WORD_LEAD = 0.05    // s: words light up a touch early to cover the IPC hop
// A jump (a seek, a track change, a resume after sleep) snaps the list straight to the line: more than
// JUMP_S of song time or JUMP_LINES lines since the last render. Only continuous play scrolls smoothly
// (a long smooth scroll ran through every line, 0.15.41-dev.1).
const JUMP_S = 3
const JUMP_LINES = 2

/**
 * Lines and layout facts for a 'lyrics-data' payload (estimated word timing when asked for, estimated
 * syllables for timed words). hyphenate: the lyrics language's hyphenator (null: no syllables).
 */
function prepare(data) {
  const raw = (data && Array.isArray(data.lines)) ? data.lines : []
  const words = learnFrom(data && data.estimate ? T.estimateWords(raw) : raw, data && data.onset)
  const hyphenate = S.hyphenatorFor(data && data.lang)
  const split = hyphenate ? words.map((l) => S.lineWithSyllables(l, hyphenate)) : words
  const lines = split.every((l, i) => l === words[i]) ? words : split
  return { lines, hyphenate, wordTimed: T.hasWordTiming(lines), sides: T.lineSides(lines), gaps: T.findInterludes(lines) }
}

/**
 * What the song's aligned/refined lines teach the estimated ones (lyrics-timing.js): plain estimated
 * lines take the song's sung pace and onset (repace), and repeats of an aligned/refined line (choruses)
 * take its timing (reuseRepeats). onset: the song's onset stored with it, used while too few lines are
 * aligned/refined (lyrics-timing repace opts.onset). Same array when nothing changes.
 */
function learnFrom(lines, onset) {
  return T.boundHolds(T.reuseRepeats(T.repace(lines, { onset: Number.isFinite(onset) ? onset : undefined })))
}

/**
 * The line after a 'lyrics-refined' message, or null when the message isn't for this song, this
 * line isn't estimated, or the words don't match (only the timing of the same words may change).
 */
function refinedLine(lines, msg, key) {
  if (!msg || msg.key !== key) return null
  const line = lines[msg.lineIndex]
  const words = msg.words
  // a repeat mapped from an aligned line keeps that (aligned beats refined)
  if (!line || !line.estimated || line.repeat === 'aligned' || !Array.isArray(words) || !line.words ||
      words.length !== line.words.length || words.some((w, i) => !w || w.text !== line.words[i].text)) return null
  const out = Object.assign({}, line, { words: words.map((w) => T.copyWord(w)), refined: true })
  delete out.repeat
  delete out.repeatOf
  return out
}

/**
 * The lines after a 'lyrics-aligned' message ({ key, lines: { index: { text, words } } }), or null
 * when the message isn't for this song or changes nothing. A line takes the aligned words only when
 * it isn't aligned yet and its text and words match (only the timing of the same words may change).
 * Returns { lines, changed: [index] }.
 */
function alignedLines(lines, msg, key) {
  if (!msg || msg.key !== key || !msg.lines || typeof msg.lines !== 'object') return null
  const next = lines.slice()
  const changed = []
  // loop: NOT-WORTH — one pass over the message's lines (at most the song's line count) · per 'lyrics-aligned' message
  for (const [k, a] of Object.entries(msg.lines)) {
    const i = Number(k)
    const line = next[i]
    const words = a && a.words
    if (!line || line.aligned || !line.words || !Array.isArray(words) || a.text !== line.text ||
        words.length !== line.words.length || words.some((w, j) => !w || w.text !== line.words[j].text)) continue
    const out = Object.assign({}, line, { words: words.map((w) => T.copyWord(w)), aligned: true })
    delete out.estimated
    delete out.repeat
    delete out.repeatOf
    next[i] = out
    changed.push(i)
  }
  return changed.length ? { lines: next, changed } : null
}

/**
 * The songwriter credit at the end of the lyrics: ['A'] -> 'Written by A', ['A', 'B'] -> 'Written by A & B',
 * ['A', 'B', 'C'] -> 'Written by A, B & C'; '' when there are none (only real data is shown: main sends
 * Apple's TTML songwriters or the catalog's composerName, else nothing).
 */
function writtenBy(writers) {
  const names = (Array.isArray(writers) ? writers : []).map((w) => String(w || '').trim()).filter(Boolean)
  if (!names.length) return ''
  return 'Written by ' + (names.length === 1 ? names[0] : names.slice(0, -1).join(', ') + ' & ' + names[names.length - 1])
}

/** The word timing note: aligned beats refined beats estimated; some lines left estimated says so. */
function timingNote(lines, aligned, refined, alignState) {
  const base = timingNoteBase(lines, aligned, refined)
  return alignState ? base + ' · ' + alignState : base
}
function timingNoteBase(lines, aligned, refined) {
  if (aligned) return lines.some((l) => l.estimated) ? 'Word timing aligned on this PC (some lines estimated)' : 'Word timing aligned on this PC'
  return refined ? 'Word timing estimated, refined by listening' : 'Word timing estimated'
}

// --- the lookup's state and the version note (the ⓘ rule, info-tip.js: visible text ≤ TEXT_MAX characters,
// the rest behind the ⓘ) ---

const mmss = (s) => { const v = Math.max(0, Math.round(Number(s) || 0)); return Math.floor(v / 60) + ':' + String(v % 60).padStart(2, '0') }
const clockAt = (ms) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
// how LRCLIB failed, from the HTTP status (0: not reached)
function lrclibFailure(status) {
  if (status === 429) return { short: 'is rate-limited', long: 'answered HTTP 429: too many requests just now' }
  if (status >= 500) return { short: 'is overloaded', long: 'answered HTTP ' + status + ': busy or overloaded' }
  if (status > 0) return { short: 'is failing', long: 'answered HTTP ' + status }
  return { short: 'is unreachable', long: 'could not be reached (offline, or the site is down)' }
}

// the evidence behind an instrumental verdict (the ⓘ): only what was found, never a guess
function instrumentalInfo(ev, apple) {
  const appleWhy = apple === 'failed' ? ' Apple Music’s lyrics didn’t load this time; the next play asks again.' : ' Apple Music has no lyrics for it.'
  if (ev.by === 'lrclib') {
    return 'Marked instrumental on LRCLIB (lrclib.net), the free lyrics database, for a recording of this length' +
      (ev.duration ? ' (' + mmss(ev.duration) + ')' : '') + '.' + appleWhy
  }
  if (ev.by === 'title') return 'The title marks this recording as instrumental' + (ev.marker ? ' (“' + ev.marker + '”)' : '') + '.' + appleWhy
  return ''
}

/**
 * The empty view's text when a song has no lines: what is true about each source. data: 'lyrics-data'
 * ({ title, status, lookup: { lrclib: { status }, apple: 'none' | 'failed', appleError, none, lrclibOn,
 * retry: { tries, max, at } } }). -> { text, info }
 *   status 'lrclib'         LRCLIB failing, a retry is due (Apple has none, or Apple's failed too)
 *   status 'lrclib-failed'  LRCLIB kept failing: no more retries this play
 *   status 'apple'          Apple's lookup failed and nothing stood in, a retry is due
 *   status 'apple-failed'   Apple's lookup kept failing
 *   none                    no lyrics: on Apple Music and LRCLIB ('both'), on Apple Music with LRCLIB off ('apple')
 *   instrumental            { by: 'lrclib', duration } | { by: 'title', marker } (lyrics-sources.js): the calm
 *                           "Instrumental" state (kind 'instrumental', drawn large), its evidence behind the ⓘ
 * -> also kind: 'instrumental' for that state (lyrics.html #empty.instrumental), '' otherwise
 */
function statusText(data) {
  const d = data || {}
  if (!d.title) return { text: 'Play a song to see its lyrics', info: '' }
  const lk = d.lookup || {}
  if (lk.instrumental) return { text: 'Instrumental', info: instrumentalInfo(lk.instrumental, lk.apple), kind: 'instrumental' }
  const retry = lk.retry || null
  const next = retry && retry.at ? ' Try ' + retry.tries + ' of ' + retry.max + ' failed; the next one at ' + clockAt(retry.at) + '.' : ''
  const appleNone = lk.apple !== 'failed'
  const appleWhy = appleNone ? 'Apple Music has no lyrics for this recording.' : 'Apple Music’s lyrics lookup failed' + (lk.appleError ? ' (' + lk.appleError + ')' : '') + '.'
  if (d.status === 'lrclib' || d.status === 'lrclib-failed') {
    const f = lrclibFailure(lk.lrclib && Number(lk.lrclib.status))
    const lr = ' LRCLIB (lrclib.net), the free lyrics database Sonata asks next, ' + f.long + '.'
    if (d.status === 'lrclib-failed') {
      return { text: appleNone ? 'No Apple lyrics; LRCLIB kept failing, asks again next play' : 'Apple’s and LRCLIB’s lyrics didn’t load; next play retries',
        info: appleWhy + lr + ' Sonata tried ' + ((retry && retry.max) || '') + ' times and stopped for now; the next time this song plays it asks again.' }
    }
    return { text: (appleNone ? 'No Apple lyrics; LRCLIB ' : 'Apple’s lyrics didn’t load; LRCLIB ') + f.short + ', retrying',
      info: appleWhy + lr + next }
  }
  if (d.status === 'apple') return { text: 'Apple Music’s lyrics didn’t load, trying again…', info: appleWhy + next }
  if (d.status === 'apple-failed') return { text: 'Apple Music’s lyrics didn’t load; next play asks again', info: appleWhy + ' Sonata tried a few times and stopped for now; the next time this song plays it asks again.' }
  if (lk.none === 'both') return { text: 'No lyrics on Apple Music or LRCLIB for this song', info: 'Apple Music has no lyrics for this recording, and LRCLIB (lrclib.net) has none for it either.' }
  if (lk.none === 'apple' && !lk.lrclibOn) return { text: 'No Apple Music lyrics for this song', info: 'Apple Music has no lyrics for this recording. Sonata can also look on LRCLIB (lrclib.net), a free lyrics database: Settings → Playback & lyrics → LRCLIB lyrics.' }
  return { text: 'No lyrics available for this song', info: '' }
}

/**
 * The note over lyrics whose line times are for another version (main.js: recording-id timingMismatch),
 * while the lines show untimed. v: { precise, reason?, lyricsEnd?, duration? }. -> { text, info }
 */
function versionNote(v) {
  if (!v) return { text: '', info: '' }
  const later = ' Sonata works out each line’s time from this recording’s audio on this PC once the song has played to its end; a line it can’t find stays un-highlighted. From the next play the lyrics follow the singing.'
  // LRCLIB's plain lyrics: the source note already says they aren't time-synced
  if (v.reason === 'untimed') return v.precise ? { text: 'No line timing: Sonata times these lyrics after this play', info: 'LRCLIB has these lyrics without line times.' + later } : { text: '', info: '' }
  if (v.reason === 'shorthand') {
    const fact = 'LRCLIB’s lyrics say ' + (v.marker ? '“' + v.marker + '”' : 'a repeat') + ' instead of the sung lines, so Sonata wrote them out (' + (v.added || 0) + ' more lines). Their times aren’t known.'
    return v.precise ? { text: 'Lyrics were shorthand, written out: timed after this play', info: fact + later }
      : { text: 'Lyrics were shorthand, written out: shown without timing', info: fact + ' With Precise word timing on (Settings → Precise timing) Sonata can time the lines from this recording’s audio on this PC.' }
  }
  const fact = v.reason === 'runs-past-end' ? 'LRCLIB’s line times run to ' + mmss(v.lyricsEnd) + ', past the end of this recording (' + mmss(v.duration) + '), so they belong to a longer version.'
    : v.reason === 'ends-early' ? 'LRCLIB’s line times end at ' + mmss(v.lyricsEnd) + ', but this recording runs ' + mmss(v.duration) + ', so they belong to a shorter version.'
      : 'LRCLIB’s line times don’t fit this recording.'
  if (v.precise) {
    return { text: 'Lyric timing is for another version: timed after this play',
      info: fact + ' Sonata leaves them out rather than highlight the wrong lines.' + later }
  }
  return { text: 'Lyric timing is for another version, so it’s hidden',
    info: fact + ' Sonata leaves them out rather than highlight the wrong lines. With Precise word timing on (Settings → Precise timing) it can time the lines from this recording’s audio on this PC.' }
}

/**
 * Karaoke position of a line's words at `time`: k words have started, `now` is the word being sung
 * (-1 for none), `syl` the syllable of that word being sung (-1 when the word has no syllables or
 * sits between two of them).
 */
function wordState(words, time) {
  const pos = T.wordPos(words, time)
  const w = pos.now >= 0 ? words[pos.now] : null
  // a held note that has sung SUSTAIN_AFTER s into its hold settles into the sustain (hold: true)
  const from = w && (w.held || w.holdFrom != null) ? (w.holdFrom != null ? w.holdFrom : w.t) : null
  return { k: pos.k, now: pos.now, syl: w && w.syl ? T.wordPos(w.syl, time).now : -1, hold: from != null && time >= from + T.SUSTAIN_AFTER }
}

/**
 * Stage layout: the line shown under the current one (-1 for none). During an interlude it's the
 * line the countdown dots lead into; otherwise the line after the one that lit up last (the first
 * line before the song's singing starts).
 */
function stageNext(lineCount, latest, interlude) {
  if (interlude) return interlude.index
  return latest + 1 < lineCount ? latest + 1 : -1
}

// Backing vocals under the words they answer (mock-up B, after 0.15.40): the backing line (x-bg) starts
// under the main-line word it comes in on. backingAnchor picks that word from the timing and the text,
// backingOffset turns it and the measured line into the backing row's side paddings (px). The view
// measures once per line when it's laid out (setData, a resize, a stage line shown, new timing), never
// per frame.
const BG_TOL = 0.05   // s: a backing line starting this close before a word starts on it
const BG_SPARE = 1    // px
const bgNorm = (t) => String(t || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '')

/**
 * Which main word the backing line starts under: { index, after } or null (no main words or backing,
 * or the backing starts before the line: it starts at the line's start, as before). An echo (the
 * backing repeats the line's words: "Took a couple months" / "(Took a couple months)") starts under the
 * word it echoes; when the text repeats in several places, the longest match closest in time wins.
 * Otherwise it starts under the main word being sung when it comes in; after: true when it comes in
 * after the line's last word ends (it starts where that word ends).
 */
function backingAnchor(words, bg) {
  if (!Array.isArray(words) || !words.length || !Array.isArray(bg) || !bg.length) return null
  const start = bg[0] && typeof bg[0].t === 'number' ? bg[0].t : null
  const B = bg.map((w) => bgNorm(w && w.text))
  const M = words.map((w) => bgNorm(w && w.text))
  let best = null
  // loop: NOT-WORTH — main words x backing words (a line's, ~5-12 each), once per line laid out
  for (let j = 0; j < M.length; j++) {
    let run = 0
    while (run < B.length && j + run < M.length && B[run] && B[run] === M[j + run]) run++
    if (!run || run < Math.min(2, B.length, M.length - j)) continue
    const dt = start === null || typeof words[j].t !== 'number' ? 0 : Math.abs(words[j].t - start)
    if (!best || run > best.run || (run === best.run && dt < best.dt)) best = { index: j, run, dt }
  }
  if (best) return { index: best.index, after: false }
  if (start === null) return null
  const last = words[words.length - 1]
  const lastEnd = typeof last.end === 'number' ? last.end : last.t
  if (typeof lastEnd === 'number' && start >= lastEnd) return { index: words.length - 1, after: true }
  let at = -1
  // loop: NOT-WORTH — a line's main words, once per line laid out
  for (let i = 0; i < words.length; i++) if (typeof words[i].t === 'number' && words[i].t <= start + BG_TOL) at = i
  return at >= 0 ? { index: at, after: false } : null
}

/**
 * The backing row's paddings so its first word starts under the anchor word: { start, end } in px
 * (physical left and right). box: { align: 'left'|'right'|'center' (the row's text-align), width (the
 * line's content width), words: [{ left, right, top }] (main words, px from the line's left edge),
 * anchor (backingAnchor), lead (px from the row's start to its first word's box), bgWidth (the row's
 * width on one line), arrow (px: the ↳ that hangs before the row's first word, with its gap) }. A
 * left-aligned row always starts at least `arrow` in, so the ↳ sits inside the line's text column (under
 * the main line's start), never hanging out to its left: the same for an anchored row, one under the first
 * word, one with no anchor and a wrapped one (0.15.42). { 0, 0 } (the line's own alignment) when there's no anchor, the
 * anchor word isn't on the line's last row (a wrapped line: the backing sits under the last row), or
 * the backing doesn't fit on one row (it wraps as before). A backing row that would run past the line's
 * end moves back just enough to fit. Right-aligned rows are padded from the right (mirrored), centred
 * rows on the side that moves them.
 */
function backingOffset(box) {
  const r = (v) => Math.round(Math.max(0, v) * 2) / 2
  const arrow = box && box.align === 'left' && box.arrow > 0 ? box.arrow : 0
  const none = { start: r(arrow), end: 0 }
  if (!box || !box.anchor || !Array.isArray(box.words) || !box.words.length) return box ? none : { start: 0, end: 0 }
  const w = box.words[box.anchor.index]
  const lastRow = box.words[box.words.length - 1].top
  const free = box.width - box.bgWidth
  if (!w || !(free > BG_SPARE) || Math.abs(w.top - lastRow) > 1) return none
  // BG_SPARE: layout widths are whole pixels, so a row fitted to the line's end keeps a pixel spare (never wraps)
  const x = Math.max(arrow, Math.min(free - BG_SPARE, Math.max(0, (box.anchor.after ? w.right : w.left) - (box.lead || 0))))
  if (box.align === 'right') return { start: 0, end: r(free - x) }
  if (box.align === 'center') return { start: r(2 * x - free), end: r(free - 2 * x) }
  return { start: r(x), end: 0 }
}

// The pop's room (Marcy 2026-10-18: a long popped word ate the space after it, "amends,that's", "predic|table"
// crowding "it's"). The pop itself is unchanged (lyrics-view.css: scale, lift, timing, overshoot, the held
// note's 1.05); only where a word's growth would bring its ink closer than POP_GAP to a neighbour's does it
// change: first its transform-origin moves (the growth goes to the side with room: a row's outer edge is
// free), and only when both sides are short of room is its scale capped (--pop-max, lyrics-view.css). Short
// words and words with room keep exactly today's numbers. Measured once per layout (popRoom in the view).
const POP_GAP = 0.28       // em of the row's text: the clear gap a popped word always leaves (a space between words at rest is ~0.43em)
const POP = { word: 1.1, bgWord: 1.08, syl: 1.12, bgSyl: 1.08 }   // = lyrics-view.css's pop scales (test/pop-room.test.js)
// the syllable pop's overshoot (lyrics-view.css cubic-bezier(.3,1.6,.5,1)): it peaks at 1.111 of its growth
const SYL_OVERSHOOT = 1.111

/**
 * Where one popping element may grow: null when its pop fits as it is (today's origin and scale), else
 * { ox, max }: its new transform-origin x (0..1 of its box) and the scale it may reach (≤ its own; the
 * CSS takes min(scale, max)). p: { inkL, inkR (px: its ink at rest), boxL, boxW (px: the box its origin is
 * relative to), ox (0..1: today's origin), scale (its pop's peak scale, overshoot included), k (that peak's
 * growth over the CSS value's: SYL_OVERSHOOT or 1), prev, next (px: the neighbours' ink edges at rest; null:
 * nothing there, a row's edge or a hyphen joint, which touches as written), gap (px) }.
 */
function popFit(p) {
  const P = p.prev == null ? -Infinity : p.prev + p.gap
  const N = p.next == null ? Infinity : p.next - p.gap
  const s = p.scale
  const o0 = p.boxL + p.ox * p.boxW
  const left = (o, k) => o + k * (p.inkL - o)
  const right = (o, k) => o + k * (p.inkR - o)
  const EPS = 0.01
  if (left(o0, s) >= P - EPS && right(o0, s) <= N + EPS) return null
  const w = p.inkR - p.inkL
  // the largest scale whose ink fits between P and N (no less than 1: the word at rest is where it is)
  const sc = Math.max(1, Math.min(s, w > 0 ? (N - P) / w : s))
  if (sc <= 1 + 1e-6) return { ox: p.ox, max: 1 }
  // the origins that keep both edges inside at sc: o <= hi (left edge), o >= lo (right edge); the nearest to today's
  const hi = (sc * p.inkL - P) / (sc - 1)
  const lo = (sc * p.inkR - N) / (sc - 1)
  const o = Math.min(hi, Math.max(lo, o0))
  const ox = Math.round((o - p.boxL) / p.boxW * 1000) / 1000
  const max = sc >= s ? null : Math.floor((1 + (sc - 1) / (p.k || 1)) * 1000) / 1000
  return { ox, max }
}

const BREATHE = 2.6       // rad/s: the countdown row's gentle breathe, 1 + 0.06 sin(2.6 t), t = song time
const DOT_STEP = Math.PI / BREATHE / 4   // s between breathe keyframes (8 per breath; linear in between)

/**
 * The countdown dots of an interlude as Web Animation keyframes (compositor-only: opacity and
 * transform), the same values the old per-frame code wrote (interludeProgress): each dot fills from
 * 0.25 opacity / scale 0.8 to 1 / 1 in turn, and the row breathes with the song time and fades and
 * shrinks out over the last 0.6 s. Time runs from g.start to the interlude's end (duration, s);
 * an animation's currentTime is (song time - g.start) in ms.
 * still (prefers-reduced-motion): the dots only fill (opacity) and the row only fades out, no scale.
 * -> { duration, dots: [keyframes] x3, row: keyframes }
 */
function dotKeyframes(g, still) {
  const end = g.end - T.LINE_LEAD
  const duration = Math.max(0.001, end - g.start)
  const at = (t) => Math.min(1, Math.max(0, (t - g.start) / duration))
  const dot = (fill) => ({ opacity: +(0.25 + 0.75 * fill).toFixed(4), transform: 'scale(' + (still ? 1 : 0.8 + 0.2 * fill).toFixed(4) + ')' })
  const span = Math.max(0.001, end - g.start - 0.6)
  const dots = [0, 1, 2].map((d) => [
    Object.assign({ offset: 0 }, dot(0)),
    Object.assign({ offset: at(g.start + span * d / 3) }, dot(0)),
    Object.assign({ offset: at(g.start + span * (d + 1) / 3) }, dot(1)),
    Object.assign({ offset: 1 }, dot(1))
  ])
  // the row: sampled breathe x exit (exact at the samples, linear between), plus the exit's corners
  const times = new Set([g.start, end, Math.max(g.start, end - 0.6)])
  // loop: NOT-WORTH — one keyframe per 1/8 breath (~0.3 s) across the interlude, once per interlude shown
  for (let t = Math.ceil(g.start / DOT_STEP) * DOT_STEP; t < end; t += DOT_STEP) times.add(t)
  const row = [...times].sort((a, b) => a - b).map((t) => {
    const exit = T.interludeProgress(g, t).exit
    const breathe = 1 + 0.06 * Math.sin(t * BREATHE)
    return { offset: at(t), opacity: +exit.toFixed(4), transform: 'scale(' + (still ? 1 : breathe * exit).toFixed(4) + ')' }
  })
  return { duration, dots, row }
}

/**
 * FLIP: how far each element must start from (translateY, px) so a layout change looks like a slide:
 * before/after are { top, height } per element; dots rows use their centre (they grow from their top).
 * Elements that didn't move (|dy| < 0.5 px) are left out. -> [{ i, dy }]
 */
function slideFrom(before, after, centre) {
  const out = []
  // loop: NOT-WORTH — the shown elements around a countdown (at most the window's lines), per dots open/close
  for (let i = 0; i < before.length; i++) {
    if (!before[i] || !after[i]) continue
    const pos = (r) => r.top + (centre && centre[i] ? r.height / 2 : 0)
    const dy = pos(before[i]) - pos(after[i])
    if (Math.abs(dy) >= 0.5) out.push({ i, dy: Math.round(dy * 10) / 10 })
  }
  return out
}

/**
 * createLyricsView({ container, layout: 'scroll' | 'stage', onSeek(t)?, onFrame(time)?,
 *   emptyText(data)? -> string|null, notes: bool, credits: bool, anchor?: number | () => number,
 *   room?: () => px, onRoom?(el | null) })
 *   -> { setData, recenter, setTime, refine, align, time, playing }
 * room (scroll layout; the Studio's sheet notes "Over the sung line", sheet-notes-ui.js): the sung line
 * (or the countdown that stands for it) opens that many px of room above itself (.room, a transparent
 * top border: no line's text moves into it); the lines around slide to their new places on the
 * compositor (FLIP, as the countdown does), and onRoom(el) tells the page where the room is now.
 */
function createLyricsView(opts) {
  const container = opts.container
  const doc = container.ownerDocument
  // Vertical only: scrollIntoView and a focus() that scrolls also scroll sideways (inline 'nearest') when
  // a line is wider than the list (a popped word at the edge), which pushed every line's start past
  // the card's left edge (0.15.39-dev.1). So the list scrolls by its scrollTop alone, always back at left 0.
  function scrollToLine(el, block, snap) {
    const box = container.getBoundingClientRect()
    const r = el.getBoundingClientRect()
    let top = container.scrollTop + r.top - box.top
    if (block === 'center') top -= box.height * anchor() - r.height / 2
    else if (r.top >= box.top && r.bottom <= box.bottom) top = container.scrollTop   // 'nearest': already in view
    else if (r.bottom > box.bottom) top -= box.height - r.height
    container.scrollTo({ top: Math.max(0, top), left: 0, behavior: snap ? 'instant' : still() ? 'auto' : 'smooth' })   // 'instant': lyrics.html's list has scroll-behavior: smooth, which 'auto' follows
  }
  const stage = opts.layout === 'stage'
  // scroll: where the sung line is held, as a fraction of the list's height from its top (the lyrics
  // window: the middle; its stage form, lyrics.html body.stage: a third of the way down). A number or a
  // function read at each scroll, so the page can change it with its layout.
  const anchor = () => { const a = typeof opts.anchor === 'function' ? opts.anchor() : opts.anchor; return Number.isFinite(a) ? a : 0.5 }
  let lines = []
  let lineEls = []          // per line: { el, side, words: [span], bg: [span], pos, bgPos, bgKey }; a word span
                            // with syllables has span.syl = [syllable span]; bgKey: the layout the backing
                            // row was placed for (placeBacking), null when it needs placing
  let interludes = []       // [{ index, start, end, el, dots: [i], row, anims }]
  let wordTimed = false
  let live = new Set()      // lines currently .active
  let shownInterlude = -1
  let shownNext = -1        // stage: line currently .next
  let scrollTarget = null
  let roomEl = null         // the element holding the room above itself (opts.room), or null
  let roomPx = 0
  let clock = null
  let waiting = null        // a new song's lyrics wait for its first time sample (lyrics-timing trackGate); null: the clock is the song's
  let shownTime = null      // the song time and the latest line of the last render (a jump snaps, see JUMP_S)
  let shownLatest = -1
  let raf = 0
  let wake = 0
  let songOnset            // the song's onset stored with it ('lyrics-data' onset, s; undefined: none)
  let songKey = ''          // the recording (main's key; title|artist without one), matches 'lyrics-refined'/'-aligned' to the song on screen
  let hyphenate = null      // the song's hyphenator, for syllables of refined/aligned words
  let refined = false       // learned or live-refined word timing in use
  let aligned = false       // word timing aligned to the vocals on this PC (precise word timing)
  let alignState = ''       // e.g. "Precise timing paused while you play" (gaming guard, main.js)
  let notesEl = null
  let notes = []
  let xdoc = null           // Expressive words: the song's measured expression (data.expr), null: the plain karaoke
  let ghostLayer = null     // the ghost vocalise layer behind the lines (only with xdoc and a ghosting word)
  let xlive = []            // the expressions playing: [{ kind: 'stretch' | 'ghost', it, line, t0, t1, anims, el? }]
  let roving = null         // scroll: the line the keyboard enters the list on (tabindex 0), see setRoving
  // prefers-reduced-motion: no pop, bounce, slide or smooth scroll (lyrics-view.css has the CSS half);
  // read when used, so a change of the desktop setting applies from the next word
  const motion = doc.defaultView.matchMedia ? doc.defaultView.matchMedia('(prefers-reduced-motion: reduce)') : null
  const still = () => !!motion && motion.matches
  // the keyboard in the lyrics window's list: the timed lines are buttons (Enter/Space plays from that
  // line, like a click), one Tab stop for the list (roving tabindex), Up/Down/Home/End move between lines
  const keys = !stage && !!opts.onSeek

  // a word: its regular text (.r) and, stacked on it, the bold copy the sung word shows (.b): the
  // switch is a visibility change, so a word change never lays the line out (lyrics-view.css). With
  // syllables, the bold copy holds them side by side (no spaces) in one row; only it pops them.
  // text: the line's text, so the pieces of a hyphen run ("Hey-", "hey-", "ay") are written together
  function wordSpans(parent, words, text, xs) {
    const spans = []
    const glue = text != null ? T.wordGlue(text, words) : null
    // loop: NOT-WORTH — one line's words (and their syllables), once per line per track in setData
    words.forEach((w, i) => {
      const joined = !!(i && glue && glue[i])
      if (i && !joined) parent.appendChild(doc.createTextNode(' '))
      const span = doc.createElement('span')
      span.className = 'w'
      // a hyphen piece written straight after the previous one ("Yeah-" "oh,"): the two touch as written
      // (lyrics-view.css .w.gj / .w.gn: no word gap or bold-width slack at the joint)
      if (joined) { span.classList.add('gj'); spans[i - 1].classList.add('gn') }
      span.dataset.text = w.text
      const xm = xs ? xs.get(i) : null   // Expressive words: this word's measured expression (lyrics-expressive.js matchWord)
      const r = doc.createElement('span')
      r.className = 'r'
      const b = doc.createElement('span')
      b.className = 'b'
      b.setAttribute('aria-hidden', 'true')
      if (w.syl) {
        span.classList.add('hs')
        r.textContent = w.syl.map((y) => y.text).join('')
        const row = doc.createElement('span')
        row.className = 'sr'
        // loop: NOT-WORTH — a word's syllables (a handful), once per line per track
        const lastFrom = w.text.length - (w.syl[w.syl.length - 1].text || '').length
        span.syl = w.syl.map((y, k) => {
          const s = doc.createElement('span')
          s.className = 's'
          const g = doc.createElement('span')   // the syllable's brightness layer (filter: brightness only, compositor)
          g.className = 'sg'
          // the held vowel's syllable (always the last for a stretch, lyrics-expressive.js matchWord) holds its letters
          if (xm && xm.i0 >= 0 && k === w.syl.length - 1 && xm.i0 >= lastFrom && (xm.stretch || xm.vb)) expressLetters(g, y.text, xm, lastFrom)
          else g.textContent = y.text
          s.appendChild(g)
          row.appendChild(s)
          return s
        })
        b.appendChild(row)
      } else {
        r.textContent = w.text
        if (xm && xm.i0 >= 0 && (xm.stretch || xm.vb)) expressLetters(b, w.text, xm, 0)
        else b.textContent = w.text
      }
      span.append(r, b)
      if (xm) expressWord(span, xm)
      if (xm && xm.stretch) {
        // the room for the stretched spelling: an invisible bold spacer right after the word, kept on the
        // word's row (.xsw: no break inside), so the extra letters never move the line (lyrics-view.css)
        const wrap = doc.createElement('span')
        wrap.className = 'xsw'
        const room = doc.createElement('span')
        room.className = 'xsp'
        room.setAttribute('aria-hidden', 'true')
        room.textContent = xm.rep.repeat(xm.extra)
        wrap.append(span, room)
        parent.appendChild(wrap)
      } else parent.appendChild(span)
      spans.push(span)
    })
    return spans
  }

  // Expressive words: a word's measured ink (a belted word gains ink, a whispered one reads a shade lighter)
  // and, for a stretch or a vibrato, its vowel letters as their own boxes (lyrics-view.css .xv / .xe / .xc)
  function expressWord(span, xm) {
    span.xm = xm
    if (xm.ink > 0) { span.classList.add('xi'); span.style.setProperty('--xi', xm.ink.toFixed(2)) }
    if (xm.quiet) span.classList.add('xq')
    if (xm.stretch) span.classList.add('xs')
  }
  // into `box`: the text before the vowel, each vowel letter (.xv, the wave), the extra letters (.xe > .xw:
  // born one by one; the wave on the inner box) and the coda (.xc, riding after the newest letter, with
  // the hold's extender .xx). from: where `piece` starts in the word's text.
  function expressLetters(box, piece, xm, from) {
    const a = xm.i0 - from
    const b = xm.i1 - from
    if (a > 0) box.appendChild(doc.createTextNode(piece.slice(0, a)))
    // loop: NOT-WORTH — a held vowel's letters (1-3), once per line laid out
    for (const ch of piece.slice(a, b)) {
      const v = doc.createElement('span')
      v.className = 'xv'
      v.textContent = ch
      box.appendChild(v)
    }
    if (!xm.stretch) {
      if (b < piece.length) box.appendChild(doc.createTextNode(piece.slice(b)))
      return
    }
    // loop: NOT-WORTH — the extra letters (≤ MAX_EXTRA), once per line laid out
    for (let k = 0; k < xm.extra; k++) {
      const e = doc.createElement('span')
      e.className = 'xe'
      const inner = doc.createElement('span')
      inner.className = 'xw'
      inner.textContent = xm.rep
      e.appendChild(inner)
      box.appendChild(e)
    }
    const coda = doc.createElement('span')
    coda.className = 'xc'
    if (b < piece.length) coda.appendChild(doc.createTextNode(piece.slice(b)))
    const ext = doc.createElement('span')
    ext.className = 'xx'
    coda.appendChild(ext)
    box.appendChild(coda)
  }

  // lifetime: OK — setData replaces the container's children, so old line, word and dot elements and
  // their onclick closures are dropped per track
  function setData(data) {
    const prevKey = songKey
    const prep = prepare(data)
    lines = prep.lines
    hyphenate = prep.hyphenate
    songKey = data.key || ((data.title || '') + '|' + (data.artist || ''))
    songOnset = Number.isFinite(data.onset) ? data.onset : undefined
    refined = !!data.refined
    aligned = !!data.aligned
    alignState = typeof data.alignState === 'string' ? data.alignState : ''
    if (songKey !== prevKey) {
      // a new song: its lyrics wait for its own time, never drawn with the previous song's clock
      waiting = T.trackGate(clock, data.duration, performance.now())
      clock = null
    }
    shownTime = null
    shownLatest = -1
    notesEl = null
    lineEls = []
    interludes = []
    live = new Set()
    shownInterlude = -1
    shownNext = -1
    scrollTarget = null
    if (roomEl && opts.onRoom) opts.onRoom(null)
    roomEl = null
    roving = null
    stopFrames()
    endExpressions()
    xdoc = data.expr && Array.isArray(data.expr.words) && data.expr.words.length ? data.expr : null
    ghostLayer = null
    if (sungEl) { sungEl = null; opts.onSung(null) }   // the old song's word goes with its lines
    if (data.lang) container.lang = data.lang
    else container.removeAttribute('lang')
    if (!lines.length) {
      wordTimed = false
      // emptyText(data): a string, or { text, info } (the longer explanation behind an ⓘ)
      const got = opts.emptyText ? opts.emptyText(data) : null
      const say = got && typeof got === 'object' ? got : { text: got || '', info: '' }
      container.innerHTML = ''
      if (say.text) {
        const empty = doc.createElement('div')
        empty.id = 'empty'
        if (say.kind) empty.className = say.kind   // 'instrumental': a state of the song, drawn large (lyrics.html)
        const span = doc.createElement('span')
        span.className = 'say'
        span.textContent = say.text
        empty.appendChild(span)
        if (say.info) createInfoTip(doc, empty).set(say.info)
        container.appendChild(empty)
      }
      return
    }
    wordTimed = prep.wordTimed
    const sides = prep.sides
    const gaps = prep.gaps
    let g = 0
    container.innerHTML = ''
    if (xdoc) {
      container.classList.add('xp')   // its own stacking context: the ghosts go behind the lines, never behind the window
    } else if (container.classList.contains('xp')) container.classList.remove('xp')
    // lyrics timed for another version, shown untimed (main.js data.version): the note says why, over the lines
    const vnote = opts.notes ? versionNote(data.version) : null
    if (vnote && vnote.text) {
      const lead = doc.createElement('div')
      lead.id = 'lead'
      const span = doc.createElement('span')
      span.className = 'say'
      span.textContent = vnote.text
      lead.appendChild(span)
      createInfoTip(doc, lead).set(vnote.info)
      container.appendChild(lead)
    }
    // loop: NOT-WORTH — the song's lines (and the countdowns before them), once per track
    lines.forEach((line, i) => {
      while (g < gaps.length && gaps[g].index === i) {
        const dots = doc.createElement('div')
        dots.className = 'dots ' + (sides[i] || 'plainside')
        const row = doc.createElement('div')
        row.className = 'row'
        row.innerHTML = '<i></i><i></i><i></i>'
        dots.appendChild(row)
        container.appendChild(dots)
        interludes.push(Object.assign({ el: dots, row, dots: [...row.children] }, gaps[g++]))
      }
      const el = doc.createElement('div')
      el.className = (line.t === null ? 'line plain' : 'line') + (sides[i] ? ' ' + sides[i] : '')
      const ly = doc.createElement('div')   // the line's content (the FLIP slide target in the stage)
      ly.className = 'ly'
      const entry = { el, ly, side: sides[i], words: [], bg: [], pos: null, bgPos: null, bgKey: null, main: null, x: null }
      if (line.words && line.words.length) {
        const main = doc.createElement('div')
        // Expressive words: the line's measured words (none: the plain karaoke, as before)
        const xl = xdoc && line.t !== null ? X.lineExpressions(xdoc, i, line.words, line.text != null ? T.wordGlue(line.text, line.words) : null) : []
        if (xl.length) entry.x = xl
        entry.words = wordSpans(main, line.words, line.text, xl.length ? new Map(xl.map((x) => [x.i, x.m])) : null)
        entry.main = main
        ly.appendChild(main)
      }
      else ly.textContent = line.text
      if (line.bg && line.bg.length) {
        const bg = doc.createElement('div')
        bg.className = 'bgv'
        entry.bg = wordSpans(bg, line.bg)
        ly.appendChild(bg)
      }
      el.appendChild(ly)
      if (!stage && line.t !== null) {
        // the lyrics window crossfades the line's colour (lyrics.html): two plain copies (unsung and
        // hover colours) stacked with the karaoke layer; same words and widths, no bold copies
        ly.classList.add('ly-main')
        // loop: NOT-WORTH — two copies per timed line, once per track
        for (const cls of ['ly-dim', 'ly-hov']) {
          const copy = ly.cloneNode(true)
          copy.className = 'ly ' + cls
          copy.setAttribute('aria-hidden', 'true')
          // loop: NOT-WORTH — the copy's bold layers (one per word), once per track
          for (const b of copy.querySelectorAll('.b')) b.remove()
          el.appendChild(copy)   // after the karaoke layer: its words come first in the DOM (z-index stacks them)
        }
      }
      if (line.t !== null && opts.onSeek) {
        // lifetime: OK — one click handler per line, dropped with the line on the next setData
        el.onclick = () => {
          opts.onSeek(line.t)
          waiting = null
          clock = T.seekClock(clock, line.t, performance.now())
          render(line.t)
          updateFrames()
        }
        if (keys) {
          el.tabIndex = -1
          el.setAttribute('role', 'button')
          el.setAttribute('aria-label', line.text || '')
        }
      }
      container.appendChild(el)
      lineEls.push(entry)
    })
    // "Written by …" after the last line (the lyrics window; the visualizer's stage has no end to show it at)
    const by = opts.credits ? writtenBy(data.writers) : ''
    if (by) {
      const credits = doc.createElement('div')
      credits.id = 'credits'
      credits.textContent = by
      container.appendChild(credits)
    }
    if (keys) setRoving(lineEls.find((e, i) => lines[i].t !== null) || null)
    // the ghost vocalise layer: first in the list, sticky at its top, as tall as the list (lyrics-view.css .xg)
    if (lineEls.some((e) => e.x && e.x.some((x) => x.m.ghost))) {
      ghostLayer = doc.createElement('div')
      ghostLayer.className = 'xg'
      ghostLayer.setAttribute('aria-hidden', 'true')
      container.insertBefore(ghostLayer, container.firstChild)
    }
    placeBacking()   // the lyrics window's lines are all laid out now; the stage's when they show
    notes = []
    if (opts.notes) {
      if (data.source === 'lrclib') notes.push('Lyrics from LRCLIB' + (lines[0].t === null ? ' (not time-synced)' : '') + (data.appleFailed ? ", as Apple Music's didn't load" : ''))
      if (lines.some((l) => l.estimated || l.aligned)) notes.push(null)   // word timing note, see showNotes
      showNotes()
    }
    if (clock) render(T.clockTime(clock, performance.now()))
  }

  function showNotes() {
    const text = notes.map((n) => n === null ? timingNote(lines, aligned, refined, alignState) : n).join(' · ')
    if (!text) return
    if (!notesEl) {
      notesEl = doc.createElement('div')
      notesEl.id = 'source'
      container.appendChild(notesEl)
    }
    notesEl.textContent = text
  }

  // refine by listening (Settings, experimental): main sends a line's new word timing once the line
  // has been sung; only that line's timing changes (same words, so the spans stay)
  function refine(msg) {
    const line = refinedLine(lines, msg, songKey)
    const entry = line && lineEls[msg.lineIndex]
    if (!entry) return
    lines[msg.lineIndex] = S.lineWithSyllables(line, hyphenate)
    entry.pos = null
    entry.bgKey = null
    relearn()
    placeBacking()
    if (!refined) { refined = true; if (opts.notes) showNotes() }
    if (clock) { render(T.clockTime(clock, performance.now())); updateFrames() }
  }

  // gaming guard (main.js): the timing note says when precise timing is paused; '' clears it
  function setAlignState(text) {
    const t = typeof text === 'string' ? text : ''
    if (t === alignState) return
    alignState = t
    if (opts.notes && notes.includes(null)) showNotes()
  }

  // precise word timing (Settings, experimental): main sends the aligned words when the alignment of
  // the song on screen finishes; only those lines' timing changes (same words, so the spans stay)
  function align(msg) {
    const got = alignedLines(lines, msg, songKey)
    if (!got) return
    lines = got.lines
    // loop: NOT-WORTH — the aligned lines (at most the song's line count) · per 'lyrics-aligned' message
    for (const i of got.changed) {
      lines[i] = S.lineWithSyllables(lines[i], hyphenate)
      if (lineEls[i]) lineEls[i].pos = lineEls[i].bgKey = null
    }
    relearn()
    placeBacking()
    aligned = true
    if (opts.notes) showNotes()
    if (clock) { render(T.clockTime(clock, performance.now())); updateFrames() }
  }

  // a line just refined or aligned (progressive alignment sends each section as it's done): the
  // song's later estimated lines take its pace and onset, and its repeats its timing, during this play
  function relearn() {
    const next = learnFrom(lines, songOnset)
    if (next === lines) return
    // loop: NOT-WORTH — one pass over the song's lines · per 'lyrics-refined' / 'lyrics-aligned' message
    for (let i = 0; i < next.length; i++) {
      if (next[i] === lines[i]) continue
      lines[i] = S.lineWithSyllables(next[i], hyphenate)
      if (lineEls[i]) lineEls[i].pos = lineEls[i].bgKey = null
    }
  }

  // Backing vocals under the words they answer (backingAnchor/backingOffset): each backing row's side
  // paddings, set as --bgv-start/--bgv-end on its line (all three stacked copies take them). One batch:
  // the lines' measuring class on (.bgm: the row on one line, unpadded), one layout read for all, the
  // class off and the paddings written. Layout positions (offsetLeft/offsetWidth), so the pop, a
  // slide or the stage's rise (transforms) don't move it. Placed once per layout a line is shown in:
  // the lyrics window's lines when the lyrics load, a stage line when it shows as current or next
  // (its sizes differ), again after a resize or new word timing (bgKey null); never per frame.
  const xOf = (n) => { let x = 0; for (; n; n = n.offsetParent) x += n.offsetLeft; return x }   // loop: NOT-WORTH — a node's few offset parents
  const alignOf = (a) => a === 'right' || a === 'end' ? 'right' : a === 'center' || a === '-webkit-center' ? 'center' : 'left'
  // the ↳'s width with its gap (lyrics-view.css .bgv::before: absolute, translateX(-100% - 0.12em)), read with the batch's layout
  function arrowOf(row) {
    const cs = doc.defaultView.getComputedStyle(row, '::before')
    const w = parseFloat(cs.width)
    return Number.isFinite(w) && cs.content !== 'none' ? w + 0.12 * (parseFloat(cs.fontSize) || 0) : 0
  }
  function placeBacking(only) {
    const todo = []
    // loop: NOT-WORTH — the song's lines (or the stage's 1-3 shown ones) · when lyrics load, after a resize or new
    // timing, and per frame on the stage, where it only compares a key until a shown line's layout changes
    for (const i of only || lineEls.keys()) {
      const e = lineEls[i]
      if (!e || !e.bg.length || !e.words.length) continue
      const key = stage ? (e.el.classList.contains('active') ? 'a' : e.el.classList.contains('next') ? 'n' : '') : 's'
      if (key && key !== e.bgKey) todo.push({ i, e, key })
    }
    if (!todo.length) return
    for (const t of todo) t.e.el.classList.add('bgm')   // loop: NOT-WORTH — the lines to place (above)
    // loop: NOT-WORTH — the lines to place, each its words (~5-12): one layout read for the batch
    const got = todo.map(({ i, e }) => {
      const main = e.main || e.words[0].parentElement
      const row = e.bg[0].parentElement
      if (!main.offsetWidth) return null   // not laid out (a hidden window): placed when it is
      const base = xOf(main)
      return backingOffset({
        align: alignOf(getComputedStyle(row).textAlign),
        width: main.clientWidth,
        words: e.words.map((s) => { const l = xOf(s) - base; return { left: l, right: l + s.offsetWidth, top: s.offsetTop } }),
        anchor: backingAnchor(lines[i].words, lines[i].bg),
        lead: xOf(e.bg[0]) - xOf(row),
        bgWidth: row.offsetWidth,
        arrow: arrowOf(row)
      })
    })
    // loop: NOT-WORTH — the lines to place (above): class off, two style writes each
    todo.forEach(({ e, key }, k) => {
      e.el.classList.remove('bgm')
      const o = got[k]
      if (!o) return
      e.bgKey = key
      if (o.start) e.el.style.setProperty('--bgv-start', o.start + 'px'); else e.el.style.removeProperty('--bgv-start')
      if (o.end) e.el.style.setProperty('--bgv-end', o.end + 'px'); else e.el.style.removeProperty('--bgv-end')
    })
  }

  // scaled words at a row's edge grow inward, so they stay inside the window padding. The row edges
  // are read once per line (one layout read when it first lights) and kept until the window resizes.
  function edgeOrigin(spans, i, side) {
    if (side === 'center') return ''
    if (!spans.origins) {
      const tops = spans.map((s) => s.offsetTop)
      spans.origins = tops.map((top, k) => side === 'right'
        ? (k === tops.length - 1 || tops[k + 1] !== top ? '100% 65%' : '')
        : (k === 0 || tops[k - 1] !== top ? '0% 65%' : ''))
    }
    return spans.origins[i]
  }
  // lifetime: OK — one resize listener per view; views live as long as their window (the row edges change)
  doc.defaultView.addEventListener('resize', () => {
    // loop: NOT-WORTH — the song's lines, once per resize
    for (const e of lineEls) { delete e.words.origins; delete e.bg.origins; delete e.words.fit; delete e.bg.fit; e.bgKey = null }
    // the backing rows again, once per frame of a resize (rows wrap differently)
    // lifetime: OK — at most one pending frame (bgFrame), cleared when it runs
    if (!bgFrame) bgFrame = requestAnimationFrame(() => { bgFrame = 0; placeBacking() })
  })
  let bgFrame = 0

  // the popping syllable of a word at a row's edge grows inward too (first syllable at the left
  // edge, last at the right edge)
  function sylOrigin(span, j, origin) {
    if (origin === '0% 65%') return j === 0 ? origin : ''
    if (origin === '100% 65%') return j === span.syl.length - 1 ? origin : ''
    return ''
  }

  // The pop's room (popFit): each word's (or, with syllables, each syllable's) origin and scale cap, from
  // the row's layout, measured once when the line first lights and kept until the layout changes (a resize,
  // recenter, new lyrics: the same lifetime as the edge origins); never per frame. -> [{ word, syl: [] }]: the
  // origins paintWords sets (today's edge origins where the pop fits). The caps are written here, once, as
  // --pop-max on the element that scales: the word, or its syllables (never both: the property inherits).
  function popRoom(spans, side) {
    if (spans.fit) return spans.fit
    const row = spans[0].parentElement
    // not laid out (a hidden window): today's origins, measured when it is
    // loop: NOT-WORTH — one line's words, per word change only while its window has no layout
    if (!row.offsetWidth) return spans.map((sp, i) => { const edge = stage ? '' : edgeOrigin(spans, i, side); return { word: edge, syl: sp.syl ? sp.syl.map((_, j) => stage ? '' : sylOrigin(sp, j, edge)) : null } })
    const bgRow = row.classList.contains('bgv')
    const gap = POP_GAP * (parseFloat(doc.defaultView.getComputedStyle(row).fontSize) || 0)
    const tops = spans.map((sp) => sp.offsetTop)
    // an element's [left, right] in px from the row's left edge, in layout px: from its rect (sub-pixel; whole-pixel
    // offsets put the gaps 1-2 px off) unless something scales it now (a pop, a held note), then from its offsets
    const base = row.getBoundingClientRect()
    const ra = row.offsetWidth ? base.width / row.offsetWidth : 1
    const rowX = xOf(row)
    const at = (el) => {
      const r = el.getBoundingClientRect()
      const w = el.offsetWidth
      if (w && Math.abs(r.width / ra / w - 1) < 0.01) return [(r.left - base.left) / ra, (r.right - base.left) / ra]
      const l = xOf(el) - rowX
      return [l, l + w]
    }
    // the sung bold copy's ink: the word's box, except a joined piece's (.gj/.gn: its copy is centred over a
    // narrower box), read from its text's rect in the copy's own scale
    const bold = (sp) => {
      if (!sp.classList.contains('gj') && !sp.classList.contains('gn')) return at(sp)
      const b = sp.children[1]
      const [bl, br] = at(b)
      const range = doc.createRange()
      range.selectNodeContents(b)
      const t = range.getBoundingClientRect()
      const box = b.getBoundingClientRect()
      const f = box.width ? (br - bl) / box.width : 1
      return [bl + (t.left - box.left) * f, bl + (t.right - box.left) * f]
    }
    const oxOf = (origin) => origin.startsWith('0%') ? 0 : origin.startsWith('100%') ? 1 : 0.5
    const pct = (ox, y) => +(ox * 100).toFixed(1) + '% ' + y
    const cap = (el, f) => { if (f && f.max) el.style.setProperty('--pop-max', String(f.max)); else el.style.removeProperty('--pop-max') }
    // loop: NOT-WORTH — one line's words (~5-12) and their syllables, once per line per layout
    spans.fit = spans.map((sp, i) => {
      const edge = stage ? '' : edgeOrigin(spans, i, side)
      // the neighbours' regular text (what they show); none at a row's edge or a hyphen joint (it touches as written)
      const prev = i > 0 && tops[i - 1] === tops[i] && !sp.classList.contains('gj') ? at(spans[i - 1].children[0])[1] : null
      const next = i + 1 < spans.length && tops[i + 1] === tops[i] && !sp.classList.contains('gn') ? at(spans[i + 1].children[0])[0] : null
      // Expressive words' stretch (lyrics-expressive.js): the stretched spelling runs on into the room reserved
      // after the word (.xsp); its pop must keep the gap at the spelling's full length, so that is its ink
      const room = sp.parentElement && sp.parentElement.classList.contains('xsw') ? sp.parentElement.children[1] : null
      const roomW = room ? Math.max(0, at(room)[1] - at(room)[0]) : 0
      if (!sp.syl) {
        const [inkL, inkR0] = bold(sp)
        const inkR = inkR0 + roomW
        const [boxL, boxR] = at(sp)
        const f = popFit({ inkL, inkR, boxL, boxW: boxR - boxL, ox: oxOf(edge), scale: bgRow ? POP.bgWord : POP.word, k: 1, prev, next, gap })
        cap(sp, f)
        return { word: f ? pct(f.ox, '65%') : edge, syl: null }
      }
      // syllables: the first and last meet the neighbours; the ones inside a word grow into their own word, as today
      const last = sp.syl.length - 1
      return {
        word: edge,
        syl: sp.syl.map((el, j) => {
          let own = stage ? '' : sylOrigin(sp, j, edge)
          const [l, r] = at(el)
          // a stretched last syllable: its box already holds the unborn letters (layout width, in the room); its
          // pop stays centred on (or at the row's edge of) the written letters, as today, and fits at full length
          const xw = j === last && room && sp.classList.contains('xs') ? Math.min(r - l, roomW) : 0
          let ox = oxOf(own)
          if (xw) { const wr = (r - l - xw) / (r - l); const y = own ? '65%' : '80%'; ox = own.startsWith('0%') ? 0 : own.startsWith('100%') ? wr : wr / 2; own = pct(ox, y) }
          const f = popFit({ inkL: l, inkR: r, boxL: l, boxW: r - l, ox, scale: 1 + ((bgRow ? POP.bgSyl : POP.syl) - 1) * SYL_OVERSHOOT, k: SYL_OVERSHOOT, prev: j === 0 ? prev : null, next: j === last ? next : null, gap })
          cap(el, f)
          return f ? pct(f.ox, own ? '65%' : '80%') : own
        })
      }
    })
    return spans.fit
  }

  // word and syllable classes for one line's words; only touches the DOM when the position changed
  function paintWords(spans, words, time, last, side) {
    const pos = wordState(words, time)
    if (last && last.k === pos.k && last.now === pos.now && last.syl === pos.syl && last.hold === pos.hold) return last
    // loop: HOT-PATH-OK — syllables to reset · the previous word's (a handful) per word/syllable change; the whole
    // line's only when it (re)lights (last null: a seek may have left one marked)
    if (!last) {
      for (const sp of spans) if (sp.syl) for (const s of sp.syl) s.classList.remove('now')
    } else if (last.now >= 0 && spans[last.now].syl && (last.now !== pos.now || last.syl !== pos.syl)) {
      for (const s of spans[last.now].syl) s.classList.remove('now')
    }
    if (pos.now >= 0) {
      const span = spans[pos.now]
      const fit = popRoom(spans, side)[pos.now]   // once per line per layout (cached)
      if (span.syl) {
        if (pos.syl >= 0) {
          span.syl[pos.syl].classList.add('now')
          span.syl[pos.syl].style.transformOrigin = fit.syl[pos.syl]
        }
      }
      else span.style.transformOrigin = fit.word
    }
    // loop: HOT-PATH-OK — one line's words (~5-12) per word/syllable change (returns above when nothing moved)
    for (let i = 0; i < spans.length; i++) {
      spans[i].classList.toggle('sung', i < pos.k && i !== pos.now)
      spans[i].classList.toggle('now', i === pos.now)
      spans[i].classList.toggle('hold', i === pos.now && pos.hold)
    }
    return pos
  }

  function render(time) {
    if (!lines.length || lines[0].t === null) return
    const gi = T.interludeAt(interludes, time)
    const { latest, live: liveNow } = T.liveLines(lines, time)
    const jump = shownTime === null || Math.abs(time - shownTime) > JUMP_S || Math.abs(latest - shownLatest) > JUMP_LINES
    shownTime = time
    shownLatest = latest
    // during an interlude nobody sings: the dots take the next line's place. A `quiet` line (its place from
    // the audio not found, align-session plainTimed) is never lit: un-highlighted rather than guessed
    const next = new Set(gi >= 0 ? [] : liveNow.filter((i) => !lines[i].quiet))
    // loop: HOT-PATH-OK — the live lines (1-3, a few in an overlap) per rendered frame
    for (const i of live) if (!next.has(i)) { lineEls[i].el.classList.remove('active'); if (keys) lineEls[i].el.removeAttribute('aria-current') }
    for (const i of next) {
      const e = lineEls[i]
      if (!live.has(i)) { e.el.classList.add('active'); e.pos = e.bgPos = null; if (keys) e.el.setAttribute('aria-current', 'true') }
      if (e.words.length) e.pos = paintWords(e.words, lines[i].words, time + WORD_LEAD, e.pos, e.side)
      if (e.bg.length) e.bgPos = paintWords(e.bg, lines[i].bg, time + WORD_LEAD, e.bgPos, e.side)
    }
    live = next
    if (xdoc) syncExpressions(time)
    if (opts.onSung) sungNow(gi >= 0 ? -1 : latest)
    let slides = null
    if (stage) {
      // stage: only the live lines (.active), the dots and the next line (.next) are shown
      const nx = stageNext(lines.length, latest, gi >= 0 ? interludes[gi] : null)
      if (nx !== shownNext) {
        if (shownNext >= 0) lineEls[shownNext].el.classList.remove('next')
        if (nx >= 0) lineEls[nx].el.classList.add('next')
        shownNext = nx
      }
      // a backing row is placed for the size the stage shows its line at (current or next), when it shows
      placeBacking(nx >= 0 ? [...next, nx] : next)
    }
    if (gi !== shownInterlude) {
      // the dots row opens/closes at once (no height animation: that laid out every frame); what it
      // moves slides from where it was, on the compositor (FLIP), as the height transition looked
      const around = slideTargets(gi >= 0 ? interludes[gi] : interludes[shownInterlude])
      const before = around.map((a) => rect(a.measure))
      if (shownInterlude >= 0) closeDots(interludes[shownInterlude])
      if (gi >= 0) interludes[gi].el.classList.add('on')
      shownInterlude = gi
      slides = slideFrom(before, around.map((a) => rect(a.measure)), around.map((a) => a.centre)).map((s) => ({ el: around[s.i].move, dy: s.dy }))
    }
    if (gi >= 0) syncDots(interludes[gi], time)
    if (!stage) {
      const target = gi >= 0 ? interludes[gi].el : (latest >= 0 ? lineEls[latest].el : null)
      // the sheet notes' room above the sung line: moved before the scroll, so the scroll centres the line with its room
      const px = opts.room ? Math.max(0, Math.round(opts.room() || 0)) : 0
      const want = px > 0 ? target : null
      if (want !== roomEl || (want && px !== roomPx)) { slides = (slides || []).concat(moveRoom(want, px)); scrollTarget = null }
      // the keyboard is choosing a line: the list stays where the keyboard is (a mouse click's
      // focus isn't :focus-visible, so pointer users keep the follow-along scroll); asked only when
      // the target changes (per line, not per word)
      if (target !== scrollTarget && !(keys && container.querySelector('.line:focus-visible'))) {
        scrollTarget = target
        if (target) scrollToLine(target, 'center', jump)
      }
      // Tab into the list lands on the sung line, unless the keyboard is already in it
      if (keys && latest >= 0 && !container.contains(doc.activeElement)) setRoving(lineEls[latest])
    }
    // after the scroll target is taken (it reads positions with transforms); reduced motion: no slide
    // loop: NOT-WORTH — the elements a dots row moved (at most the window's lines), per open/close
    if (slides && !still() && !jump) for (const s of slides) s.el.animate([{ transform: 'translateY(' + s.dy + 'px)' }, { transform: 'none' }], { duration: 300, easing: 'ease' })
  }

  const rect = (el) => { const r = el.getBoundingClientRect(); return { top: r.top, height: r.height } }

  // opts.onSung(el): the element being sung changed (the latest line's word, or its syllable being sung;
  // null between words, in an interlude and at the end): the HDR glow (hdr-glow.js) follows it. One compare
  // per rendered frame, a call only on a change.
  let sungEl = null
  function sungNow(latest) {
    const e = latest >= 0 ? lineEls[latest] : null
    const p = e && e.pos
    const span = p && p.now >= 0 ? e.words[p.now] : null
    const el = span ? (span.syl && p.syl >= 0 ? span.syl[p.syl] : span) : null
    if (el === sungEl) return
    sungEl = el
    opts.onSung(el)
  }

  // the room moves to `el` (or goes): one class and one custom property, measured before and after so the
  // lines in view slide (FLIP, slideFrom) instead of jumping; -> the slides (render plays them)
  function moveRoom(el, px) {
    const around = still() ? [] : slideTargets(null)
    const before = around.map((a) => rect(a.measure))
    if (roomEl && roomEl !== el) roomEl.classList.remove('room')
    if (el) { el.style.setProperty('--room', px + 'px'); el.classList.add('room') }
    roomEl = el
    roomPx = px
    const out = slideFrom(before, around.map((a) => rect(a.measure)), null).map((s) => ({ el: around[s.i].move, dy: s.dy }))
    if (opts.onRoom) opts.onRoom(el)
    return out
  }

  // what a dots row opening or closing moves: the stage's shown lines (their content, so the stage's
  // own lv-in animation keeps the line's transform), or the lyrics window's lines in view; and the
  // dots row itself (its centre: the old height animation grew it from its top)
  function slideTargets(g) {
    const out = []
    if (g) out.push({ measure: g.el, move: g.el, centre: true })
    const view = container.getBoundingClientRect()
    // loop: NOT-WORTH — one pass over the song's lines, per dots open/close (a few per song)
    for (const e of lineEls) {
      if (stage) {
        if (e.el.classList.contains('active') || e.el.classList.contains('next')) out.push({ measure: e.el, move: e.ly })
        continue
      }
      const r = e.el.getBoundingClientRect()
      if (r.bottom >= view.top - 80 && r.top <= view.bottom + 80) out.push({ measure: e.el, move: e.el })
    }
    return out
  }

  // the countdown on the compositor: one Web Animation per dot and one for the row, made when the
  // dots open, kept in step with the song clock (re-synced only when it drifts), paused with the song
  function syncDots(g, time) {
    if (!g.anims) {
      const k = dotKeyframes(g, still())
      const opts = { duration: k.duration * 1000, fill: 'both' }
      g.anims = g.dots.map((d, i) => d.animate(k.dots[i], opts)).concat([g.row.animate(k.row, opts)])
    }
    const at = (time - g.start) * 1000
    const playing = !!clock && clock.playing && doc.visibilityState === 'visible'
    // loop: NOT-WORTH — the 4 countdown animations, per render while the dots show
    for (const a of g.anims) {
      if (Math.abs((a.currentTime || 0) - at) > 60) a.currentTime = at
      if (playing && a.playState !== 'running') a.play()
      else if (!playing && a.playState === 'running') a.pause()
    }
  }
  function closeDots(g) {
    g.el.classList.remove('on')
    if (g.anims) for (const a of g.anims) a.cancel()   // loop: NOT-WORTH — 4 animations
    g.anims = null
  }

  // --- Expressive words on the compositor (lyrics-expressive.js; lyrics-view.css "Expressive words") ---
  // Idle cost: nothing at all between held notes (no timer, no rAF, no listener of its own). During a held
  // vowel: one Web Animation per extra letter (≤ 8) and per vowel letter's wave, plus the coda and its
  // extender, all transform/opacity on the compositor; a ghost adds ≤ ~12 letters for its life (the hold +
  // ~2 s). They start, stay in step and end in render() (word changes and the 2/s time pushes), like the
  // countdown dots: paused with the song and while the window is hidden, cancelled on a new song. On the
  // CPU fallback the same few small layers are composited in software.
  const AOPTS = (t0, t1) => ({ duration: Math.max(1, (t1 - t0) * 1000), fill: 'both' })
  function syncExpressions(time) {
    const playing = !!clock && clock.playing && doc.visibilityState === 'visible'
    // start: the live lines' measured words whose moment this is (a seek into a hold starts it there)
    // loop: HOT-PATH-OK — the live lines (1-3) x their measured words (0-3), per render
    for (const i of live) {
      const e = lineEls[i]
      if (!e || !e.x) continue
      for (const it of e.x) {
        const m = it.m
        if (m.i0 < 0) continue
        const span = e.words[it.i]
        const lit = span && span.classList.contains('now')
        if ((m.stretch || m.vb) && lit && time <= m.ve + 0.3 && !xlive.some((x) => x.it === it && x.kind === 'stretch')) startStretch(e, it, time)
        if (m.ghost && ghostLayer && time >= m.vt - X.GHOST_ENTER && time < m.ve && !xlive.some((x) => x.it === it && x.kind === 'ghost')) startGhost(it, i, time)
      }
    }
    // keep in step, and end what is over (a stretch also ends when its word or line is no longer sung)
    const keep = []
    // loop: HOT-PATH-OK — the expressions playing (≤ 1-2 stretches + GHOST_MAX ghosts), per render
    for (const x of xlive) {
      const over = time > x.t1 || time < x.t0 - 1 || (x.kind === 'stretch' && (!live.has(x.line) || !x.span.classList.contains('now')))
      if (over) { endExpression(x); continue }
      const at = (time - x.t0) * 1000
      // loop: HOT-PATH-OK — one expression's animations (≤ ~14), per render
      for (const a of x.anims) {
        if (Math.abs((a.currentTime || 0) - at) > 60) a.currentTime = at
        if (playing && a.playState !== 'running') a.play()
        else if (!playing && a.playState === 'running') a.pause()
      }
      keep.push(x)
    }
    xlive = keep
  }

  // a held word's stretch: the extra letters born through the hold, the coda riding after the newest one,
  // the vowel letters waving at the measured vibrato. One layout read (a letter's width and the type size)
  // when it starts. Reduced motion: the stretched spelling at once, no wave (.xr).
  function startStretch(e, it, time) {
    const m = it.m
    const span = e.words[it.i]
    const lineIndex = lineEls.indexOf(e)
    const tl = X.stretchTimeline(m, lines[lineIndex].words[it.i].t - WORD_LEAD)
    const x = { kind: 'stretch', it, line: lineIndex, span, t0: tl.t0, t1: tl.t1, anims: [], reset: [] }
    xlive.push(x)
    if (still()) { if (m.stretch) span.classList.add('xr'); x.reset.push(() => span.classList.remove('xr')); return }
    const o = AOPTS(tl.t0, tl.t1)
    const extras = m.stretch ? [...span.querySelectorAll('.xe')] : []
    const fontPx = parseFloat(doc.defaultView.getComputedStyle(span).fontSize) || 16
    if (extras.length) {
      const w = extras[0].offsetWidth || fontPx * 0.55
      const n = extras.length
      // loop: NOT-WORTH — the extra letters (≤ MAX_EXTRA), once per held word
      extras.forEach((el, k) => x.anims.push(el.animate(X.letterBirth(k, n, tl.t0, tl.t1, m.vt, m.hold), o)))
      const coda = span.querySelector('.xc')
      if (coda) x.anims.push(coda.animate(X.codaRide(n * w, tl.t0, tl.t1, m.vt, m.hold), o))
      const ext = span.querySelector('.xx')
      if (ext) { ext.style.width = (n * w).toFixed(1) + 'px'; x.anims.push(ext.animate(X.extenderShrink(tl.t0, tl.t1, m.vt, m.hold), o)) }
      // (the held syllable's pop origin and its room for the stretched spelling come from popRoom, once per layout)
    }
    // the wave: the vowel letters, then the extra letters (each at the height the voice had when it was born)
    const amp = fontPx * X.WAVE_EM
    const waving = [...span.querySelectorAll('.xv')]
    const inner = m.stretch ? [...span.querySelectorAll('.xw')] : []
    // loop: NOT-WORTH — the vowel and extra letters (≤ ~11), once per held word
    waving.concat(inner).forEach((el, j) => {
      const k = j - waving.length
      const base = k >= 0 && m.ct ? X.contourPx(m.ct, X.bornAt(k, inner.length, m.vt, m.hold), fontPx) : 0
      const kf = m.vb ? X.waveKeyframes(m.vb, tl.t0, tl.t1, amp, j * 0.85, base) : null
      if (kf) x.anims.push(el.animate(kf, o))
      else if (base) x.anims.push(el.animate(X.heldAt(base), o))   // its height, held for the timeline
    })
    syncOne(x, time)
  }

  // a ghost: the held letters, large and translucent behind the lines, drifting, growing with the hold,
  // breathing with the loudness and wavering with the vibrato (lyrics-expressive.js ghostPlan)
  function startGhost(it, lineIndex, time) {
    const m = it.m
    if (xlive.filter((x) => x.kind === 'ghost').length >= X.GHOST_MAX) {
      const oldest = xlive.find((x) => x.kind === 'ghost')
      endExpression(oldest)
      xlive = xlive.filter((x) => x !== oldest)
    }
    const span = lineEls[lineIndex].words[it.i]
    const fontPx = parseFloat(doc.defaultView.getComputedStyle(span).fontSize) || 16
    const plan = X.ghostPlan(m, songKey + '|' + lineIndex + '|' + it.i, still(), (ghostLayer.clientWidth || 0) * 0.2)
    const el = doc.createElement('span')
    el.className = 'xgw'
    el.style.left = (plan.x * 100).toFixed(1) + '%'
    el.style.top = (plan.y * (container.clientHeight || 0)).toFixed(0) + 'px'   // the list's visible height (one read per ghost)
    el.style.fontSize = (plan.size * fontPx).toFixed(1) + 'px'
    const o = AOPTS(plan.t0, plan.t1)
    const x = { kind: 'ghost', it, line: lineIndex, el, t0: plan.t0, t1: plan.t1, anims: [], reset: [] }
    x.anims.push(el.animate(plan.opacity, o))
    if (plan.drift) x.anims.push(el.animate(plan.drift, o))
    const gPx = plan.size * fontPx
    // loop: NOT-WORTH — a ghost's letters (≤ ~12), once per ghost
    plan.letters.forEach((l, i) => {
      const s = doc.createElement('span')
      s.className = 'xgl'
      s.textContent = l.ch
      el.appendChild(s)
      const birth = X.ghostLetterBirth(l.born, plan.t0, plan.t1)
      if (birth) x.anims.push(s.animate(birth, o))
      // each letter keeps the pitch it was born on: the ghost bends along the contour
      const base = m.ct ? X.contourPx(m.ct, l.born, gPx) * 1.2 : 0
      const wave = !still() && m.vb ? X.waveKeyframes(m.vb, plan.t0, plan.t1, gPx * 0.025, i * 0.7, base) : null
      if (wave) x.anims.push(s.animate(wave, o))
      else if (base) x.anims.push(s.animate(X.heldAt(base), o))
    })
    ghostLayer.appendChild(el)
    xlive.push(x)
    syncOne(x, time)
  }

  function syncOne(x, time) {
    const playing = !!clock && clock.playing && doc.visibilityState === 'visible'
    const at = (time - x.t0) * 1000
    // loop: NOT-WORTH — one expression's animations (≤ ~14), once when it starts
    for (const a of x.anims) { a.currentTime = at; if (playing) a.play(); else a.pause() }
  }
  function endExpression(x) {
    for (const a of x.anims) a.cancel()   // loop: NOT-WORTH — one expression's animations (≤ ~14)
    for (const f of x.reset) f()   // loop: NOT-WORTH — a few style resets
    if (x.el) x.el.remove()
  }
  // lifetime: OK — every expression's animations are cancelled and its ghost removed here (new song, setData)
  // or when it ends (syncExpressions); none outlives its song
  function endExpressions() {
    for (const x of xlive) endExpression(x)   // loop: NOT-WORTH — the expressions playing (≤ ~5), per song
    xlive = []
  }

  // loop: HOT-PATH-OK — lyrics word/line changes · requestAnimationFrame, woken by a setTimeout at the next word/line
  // change (never every frame: the countdown dots run as compositor animations, syncDots) · runs only
  // while this window is visible, the song is playing and the lyrics have word timing (or a countdown is
  // showing, to end it on time) · stops when hidden (visibilitychange), paused (isPlaying false or the
  // time stops moving), on a new track, or when no word timing/countdown is left · cost: one frame per
  // word change, DOM class writes only for what changed, no layout (docs/PERFORMANCE.md)
  function wantFrames() {
    return doc.visibilityState === 'visible' && !!clock && clock.playing &&
      lines.length > 0 && lines[0].t !== null && (wordTimed || shownInterlude >= 0)
  }
  // lifetime: OK — at most one rAF or one wake-up timeout pending (raf / wake); stopFrames cancels both on
  // every replan, a new track, hidden and pause
  function schedule(time) {
    const wait = T.nextChange(lines, time, WORD_LEAD)
    if (wait === Infinity) return                    // nothing left to change until the next push
    if (wait < 0.03) { raf = requestAnimationFrame(frame); return }
    wake = setTimeout(() => { wake = 0; raf = requestAnimationFrame(frame) }, (wait - 0.015) * 1000)
  }
  function frame() {
    raf = 0
    const time = T.clockTime(clock, performance.now())
    render(time)
    if (opts.onFrame) opts.onFrame(time)
    if (wantFrames()) schedule(time)
  }
  function stopFrames() {
    if (raf) cancelAnimationFrame(raf)
    if (wake) clearTimeout(wake)
    raf = wake = 0
  }
  function updateFrames() {
    stopFrames()
    if (wantFrames()) schedule(T.clockTime(clock, performance.now()))
  }

  // isPlaying is sent along since 0.15.10; older pushes (undefined) fall back to "time stopped moving".
  // key (since 0.15.42): the song the time is for (main's lyrics key); a push for another song (the
  // previous one's last, or the next one's before its lyrics arrive) is dropped. A new song's first
  // samples that still carry the previous song's position are dropped too (lyrics-timing trackSample).
  function setTime(playbackTime, isPlaying, key) {
    if (typeof key === 'string' && key !== songKey) return
    if (waiting) {
      if (!T.trackSample(waiting, playbackTime, isPlaying, performance.now())) return
      waiting = null
    }
    clock = T.syncClock(clock, playbackTime, isPlaying, performance.now())
    if (doc.visibilityState !== 'visible') {
      stopFrames()
      if (shownInterlude >= 0) syncDots(interludes[shownInterlude], T.clockTime(clock, performance.now()))   // pauses them
      if (xlive.length) syncExpressions(T.clockTime(clock, performance.now()))   // pauses them too
      return
    }
    render(T.clockTime(clock, performance.now()))
    updateFrames()   // re-plans the next wake-up from the resynced clock
  }

  // the one line with tabindex 0 (roving tabindex): two attribute writes when it moves, no layout
  function setRoving(entry) {
    if (!entry || entry === roving) return
    if (roving) roving.el.tabIndex = -1
    entry.el.tabIndex = 0
    roving = entry
  }
  if (keys) {
    // lifetime: OK — one keydown and one focusin listener on the list, released with its window
    container.addEventListener('focusin', (e) => {
      // loop: NOT-WORTH — one pass over the song's lines, per focus move inside the list
      const entry = lineEls.find((x) => x.el === e.target)
      if (entry) setRoving(entry)
    })
    container.addEventListener('keydown', (e) => {
      if (e.ctrlKey || e.altKey || e.metaKey) return
      // loop: NOT-WORTH — one pass over the song's lines, per key press in the list
      const timed = lineEls.filter((x, i) => lines[i] && lines[i].t !== null)
      const at = timed.findIndex((x) => x.el === doc.activeElement)
      if (at < 0) return
      let to = -1
      if (e.key === 'ArrowDown') to = Math.min(timed.length - 1, at + 1)
      else if (e.key === 'ArrowUp') to = Math.max(0, at - 1)
      else if (e.key === 'Home') to = 0
      else if (e.key === 'End') to = timed.length - 1
      else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); timed[at].el.click(); return }
      else return
      e.preventDefault()
      setRoving(timed[to])
      timed[to].el.focus({ focusVisible: true, preventScroll: true })
      scrollToLine(timed[to].el, 'nearest')
    })
  }

  // lifetime: OK — one listener per view, released with its window (views live as long as their window)
  doc.addEventListener('visibilitychange', () => {
    if (doc.visibilityState === 'visible' && clock) render(T.clockTime(clock, performance.now()))
    updateFrames()
  })

  // the page's layout changed (the lyrics window grown into the stage or shrunk back, a band folded
  // away): scroll the sung line back to its anchor on the next render, and place the backing rows
  // again, as the page's font sizes changed (rows wrap differently)
  function recenter() {
    scrollTarget = null
    if (roomEl && opts.onRoom) opts.onRoom(roomEl)
    // loop: NOT-WORTH — the song's lines, once per layout change
    for (const e of lineEls) { delete e.words.origins; delete e.bg.origins; delete e.words.fit; delete e.bg.fit; e.bgKey = null }
    placeBacking()
    if (clock && lines.length) render(T.clockTime(clock, performance.now()))
  }

  return {
    setData,
    recenter,
    setTime,
    refine,
    align,
    alignState: setAlignState,
    time: () => T.clockTime(clock, performance.now()),
    // the song's timed lines ({ t, text }), for the Studio's ↑/↓ and the seek bar's hover (on demand, not per frame)
    // loop: NOT-WORTH — the song's lines (≤ ~150), once per key press or hover move
    timedLines: () => lines.filter((l) => l && l.t !== null && Number.isFinite(l.t) && !l.gap && l.text).map((l) => ({ t: l.t, text: String(l.text) })),
    get playing() { return !!clock && clock.playing }
  }
}

module.exports = { SUSTAIN_AFTER: T.SUSTAIN_AFTER, WORD_LEAD, POP, POP_GAP, SYL_OVERSHOOT, popFit, statusText, versionNote, prepare, backingAnchor, backingOffset, learnFrom, refinedLine, alignedLines, timingNote, writtenBy, wordState, stageNext, dotKeyframes, slideFrom, createLyricsView }
