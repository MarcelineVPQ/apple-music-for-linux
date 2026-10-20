// Sheet notes in the Studio (Sonata's +1, Settings → Precise timing → "Sheet notes in the Studio",
// Experimental, off by default): the sung melody above the lyrics, playing out live on the lyrics clock.
// This file is the pure logic, no DOM and no Electron (tested in test/sheet-notes.test.js with saved
// fixtures); sheet-notes-ui.js only draws what it decides.
//
// Where the notes come from: the sonata-align helper works them out on the GPU from the vocal stem it
// already separated for Precise word timing (align/notes_step.py: RMVPE pitch + the note model
// align/sung_notes.py), on the same clock as the aligned words. Sonata caches them per song
// (sheet-notes-store.js, compact()); the band never analyses anything, it draws.
//
// What the band shows (Marcy, 2026-10-16/17):
//   - first play: a scrolling pitch line, filled in section by section as the helper hears them;
//   - from the second play (the song has precise word timing and its notes are cached): a piano roll on
//     a real staff: each note at its spelled pitch and as long as it was held (no rhythm quantising),
//     the key signature, accidentals off the key, ledger lines, the syllable under its note (a hyphen
//     to the next syllable, an extender under a melisma), bar lines when beats are known, a playhead;
//   - honest confidence: where the notes don't sit on a pitch grid (rap, speech, shouting, a noisy live
//     stretch) the band shows the pitch line there, or nothing, never invented notes (gate()).
'use strict'

const FORMAT = 1
const LETTERS = ['C', 'D', 'E', 'F', 'G', 'A', 'B']
const SHARP = '♯'
const FLAT = '♭'
const SHARP_ORDER = ['F', 'C', 'G', 'D', 'A', 'E', 'B']
const FLAT_ORDER = ['B', 'E', 'A', 'D', 'G', 'C', 'F']
// the bottom line of each clef as a diatonic step (octave × 7 + letter index; C4 = 28). treble8 is the
// vocal tenor clef: written an octave above the sound, so a man's voice sits on the staff.
const CLEFS = {
  treble: { bottom: 4 * 7 + 2, glyph: '\u{1D11E}', label: 'treble clef' },      // E4
  treble8: { bottom: 3 * 7 + 2, glyph: '\u{1D11E}', label: 'treble clef, an octave lower', eight: true },   // E3 written as E4
  bass: { bottom: 2 * 7 + 4, glyph: '\u{1D122}', label: 'bass clef' }           // G2
}
// key-signature places on the treble staff (steps above the bottom line); the bass clef's are two lower
const SHARP_POS = { F: 8, C: 5, G: 9, D: 6, A: 3, E: 7, B: 4 }
const FLAT_POS = { B: 4, E: 7, A: 3, D: 6, G: 2, C: 5, F: 1 }

// --- the gate (honest confidence), calibrated 2026-10-17 (docs/LEVEL2-ALIGN.md "Sheet notes") ---
// A note's `cents` is how far its sung pitch sits from the nearest semitone in the song's own tuning.
// Sung melody clusters near 0 (duration-weighted median 4-19 cents on studio and live-ish vocals);
// rap and speech have no pitch grid, so the offsets spread evenly (median ≈ 25). Note `conf` is the
// pitch model's voicing × stability (sung 0.77-0.89).
// Recalibrated 2026-10-19 on 36 learned songs: per stretch (~10 notes) the spread is noisy, and real
// sung lines with scoops and vibrato reach 22-38 cents (Radiohead "15 Step": four lines at 22-38 showed
// the pitch line every play), the same range as rapped lines (Wilson Way's verses: 23-40). What tells
// them apart is the delivery: those rapped lines run 4.6-7.5 syllables a second, every sung line past
// 20 cents but two at most 4.0 (15 Step 2.7-3.2). So in a song judged sung, a stretch past gridMax falls
// back to the line only when it is fast (> rapRate) or extreme (> spreadMax: past 40 cents the nearest
// semitone is a coin flip between two neighbours; uniform offsets, i.e. no grid at all, give 25).
// Notes between lines have no syllables to judge their delivery by and keep gridMax.
const GATE = {
  spreadMax: 40,      // cents: a stretch whose notes sit further off the grid than this is not shown as notes
  gridMax: 20,        // cents: past this, a stretch shows notes only when it isn't rapped (rapRate)
  rapRate: 4.4,       // syllables a second: a line past gridMax delivered faster than this is rapped
  confMin: 0.6,       // duration-weighted note confidence below this: not shown as notes
  minNotes: 4,        // fewer notes than this around a stretch: judged with its neighbours (poolS)
  poolS: 4,           // s: a stretch's notes are pooled with those this close (a short line alone is noise)
  songSpreadMax: 22   // the whole song further off than this: the pitch line for the whole song
}
const PITCH_HOP = 0.05

const num = (v, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d)
const round = (v, k = 1000) => Math.round(v * k) / k

/** 'C♯4', 'B♭2', 'F♯♯3' (also # and b) -> { letter, acc, octave, step } or null. */
function parseName(name) {
  const m = /^([A-G])((?:♯|♭|#|b)*)(-?\d+)$/.exec(String(name || ''))
  if (!m) return null
  let acc = 0
  // loop: NOT-WORTH — at most two accidental signs per name
  for (const c of m[2]) acc += c === '♯' || c === '#' ? 1 : -1
  const octave = Number(m[3])
  return { letter: m[1], acc, octave, step: octave * 7 + LETTERS.indexOf(m[1]) }
}

/** A MIDI note spelled in a key (fifths -7..7): sharps in sharp keys and C, flats in flat keys. */
function spellMidi(midi, fifths) {
  const pc = ((Math.round(midi) % 12) + 12) % 12
  const sharp = [['C', 0], ['C', 1], ['D', 0], ['D', 1], ['E', 0], ['F', 0], ['F', 1], ['G', 0], ['G', 1], ['A', 0], ['A', 1], ['B', 0]]
  const flat = [['C', 0], ['D', -1], ['D', 0], ['E', -1], ['E', 0], ['F', 0], ['G', -1], ['G', 0], ['A', -1], ['A', 0], ['B', -1], ['B', 0]]
  const [letter, acc] = (fifths < 0 ? flat : sharp)[pc]
  const octave = Math.floor((Math.round(midi) - acc) / 12) - 1
  return { letter, acc, octave, step: octave * 7 + LETTERS.indexOf(letter) }
}

/** The pitch of a spelled note (C4 = 60), to check a name against its MIDI number. */
function midiOf(sp) {
  return (sp.octave + 1) * 12 + [0, 2, 4, 5, 7, 9, 11][LETTERS.indexOf(sp.letter)] + sp.acc
}

/** A note's spelling: its own name from the note model when it matches its MIDI number, else spelled in the key. */
function spellNote(n, fifths) {
  const sp = parseName(n.name)
  return sp && midiOf(sp) === n.midi ? sp : spellMidi(n.midi, fifths)
}

/** { letter: +1 | -1 } for the key signature's letters. */
function keyAccidentals(fifths) {
  const f = Math.max(-7, Math.min(7, Math.round(num(fifths))))
  const out = {}
  // loop: NOT-WORTH — at most 7 letters
  for (const l of f > 0 ? SHARP_ORDER.slice(0, f) : FLAT_ORDER.slice(0, -f)) out[l] = f > 0 ? 1 : -1
  return out
}

/** The key signature's signs on a clef: [{ pos, glyph }] (pos: steps above the bottom line). */
function keySignature(fifths, clef) {
  const f = Math.max(-7, Math.min(7, Math.round(num(fifths))))
  const low = clef === 'bass' ? -2 : 0
  if (f > 0) return SHARP_ORDER.slice(0, f).map((l) => ({ pos: SHARP_POS[l] + low, glyph: SHARP }))
  return FLAT_ORDER.slice(0, -f).map((l) => ({ pos: FLAT_POS[l] + low, glyph: FLAT }))
}

/**
 * The clef for a voice: the one that keeps the most of the singing on the staff (the least note time,
 * weighted by how far, above or below its five lines); a tie keeps the order treble 8vb (most voices),
 * treble, bass. notes: [{ midi, t, end }] (a pitch line passes its voiced values as 50 ms notes).
 */
function clefFor(notes) {
  const ns = (notes || []).filter((n) => Number.isFinite(n.midi) && n.end > n.t)
  if (!ns.length) return 'treble8'
  let best = null
  // loop: NOT-WORTH — three clefs × the song's notes (hundreds), once per song
  for (const clef of ['treble8', 'treble', 'bass']) {
    let cost = 0
    for (const n of ns) {
      const pos = staffPos(spellMidi(n.midi, 0), clef)
      cost += (n.end - n.t) * (Math.max(0, -1 - pos) + Math.max(0, pos - 9))
    }
    if (!best || cost < best.cost - 1e-9) best = { clef, cost }
  }
  return best.clef
}

/** Steps above the clef's bottom line (0 = bottom line, 8 = top line; even = on a line). */
function staffPos(sp, clef) {
  return sp.step - CLEFS[clef || 'treble'].bottom
}

/** The ledger lines a note at pos needs (their positions). */
function ledgers(pos) {
  const out = []
  // loop: NOT-WORTH — a few ledger lines per note
  for (let p = -2; p >= pos; p -= 2) out.push(p)
  // loop: NOT-WORTH — as above
  for (let p = 10; p <= pos; p += 2) out.push(p)
  return out
}

/** The sign a note needs against the key signature (no bars carry accidentals here): '' when none. */
function accidental(sp, keyAcc) {
  const want = keyAcc[sp.letter] || 0
  if (sp.acc === want) return ''
  return sp.acc === 0 ? '♮' : sp.acc === 1 ? SHARP : sp.acc === -1 ? FLAT : sp.acc === 2 ? '𝄪' : sp.acc === -2 ? '𝄫' : ''
}

/** A continuous staff position for a fractional MIDI pitch (the pitch line between the notes). */
function contPos(midi, clef, fifths) {
  const lo = Math.floor(midi)
  const f = midi - lo
  const p = (m) => staffPos(spellMidi(m, fifths), clef) + (spellMidi(m, fifths).acc ? 0.5 * spellMidi(m, fifths).acc : 0)
  return p(lo) + (p(lo + 1) - p(lo)) * f
}

// --- the cached entry: compact on disk, expanded for the view ---

/**
 * The helper's notes part (align/notes_step.py run) -> the cached entry (sheet-notes-store.js). Lines
 * shifted by lineOffset (a section job's lines start there). Only what the band draws is kept.
 */
function compact(part, meta = {}) {
  const p = part || {}
  const off = meta.lineOffset || 0
  const key = p.key || {}
  const syl = (p.syllables || []).map((s) => [round(num(s.t)), round(num(s.end)), String(s.text == null ? '' : s.text).slice(0, 40), s.line == null ? -1 : s.line + off, num(s.syl), Math.max(1, num(s.nsyl, 1))])
  const notes = (p.notes || []).filter((n) => Number.isFinite(n.t) && n.end > n.t && Number.isInteger(n.midi))
    .map((n) => [round(n.t), round(n.end), n.midi, Math.round(num(n.cents)), String(n.name || ''), Math.round(num(n.conf) * 1000), Number.isInteger(n.syl_index) ? n.syl_index : -1, n.melisma ? 1 : 0])
  const pitch = p.pitch && Array.isArray(p.pitch.v) ? { t0: num(p.pitch.t0), hop: num(p.pitch.hop, PITCH_HOP), v: p.pitch.v.map((x) => Math.max(0, Math.min(1270, Math.round(num(x))))) } : null
  return {
    format: FORMAT,
    lyricsHash: String(meta.lyricsHash || ''),
    created: meta.created || '',
    sonata: meta.version || '',
    model: String(p.model || ''),
    key: { name: String(key.name || ''), fifths: Math.max(-7, Math.min(7, Math.round(num(key.fifths)))), mode: key.mode === 'minor' ? 'minor' : 'major' },
    tuning: { cents: num((p.tuning || {}).cents), strength: num((p.tuning || {}).strength) },
    confidence: { overall: num((p.confidence || {}).overall) },
    bars: Array.isArray(p.bars) ? p.bars.filter((b) => Number.isFinite(b)).map((b) => round(b)) : [],
    duration: round(num(p.duration_s)),
    syl,
    notes,
    pitch
  }
}

/** A cached entry, checked: -> the view document { key, notes, syllables, pitch, bars, ... } or null. */
function expand(entry) {
  const e = entry && typeof entry === 'object' ? entry : null
  if (!e || e.format !== FORMAT || !Array.isArray(e.notes) || !Array.isArray(e.syl)) return null
  const syllables = e.syl.filter((s) => Array.isArray(s) && s.length >= 6).map((s) => ({ t: num(s[0]), end: num(s[1]), text: String(s[2]), line: s[3] < 0 ? null : s[3], syl: num(s[4]), nsyl: Math.max(1, num(s[5], 1)) }))
  const notes = e.notes.filter((n) => Array.isArray(n) && n.length >= 8 && Number.isFinite(n[0]) && n[1] > n[0] && Number.isInteger(n[2]))
    .map((n) => {
      const si = Number.isInteger(n[6]) && n[6] >= 0 && n[6] < syllables.length ? n[6] : null
      return { t: n[0], end: n[1], midi: n[2], cents: num(n[3]), name: String(n[4]), conf: num(n[5]) / 1000, syl_index: si, line: si === null ? null : syllables[si].line, melisma: !!n[7] }
    })
  const pitch = e.pitch && Array.isArray(e.pitch.v) && num(e.pitch.hop) > 0 ? { t0: num(e.pitch.t0), hop: num(e.pitch.hop), v: e.pitch.v } : null
  const key = e.key || {}
  return {
    key: { name: String(key.name || ''), fifths: Math.max(-7, Math.min(7, Math.round(num(key.fifths)))) },
    tuning: e.tuning || { cents: 0, strength: 0 },
    confidence: e.confidence || { overall: 0 },
    bars: Array.isArray(e.bars) ? e.bars.filter((b) => Number.isFinite(b)) : [],
    duration: num(e.duration),
    notes,
    syllables,
    pitch
  }
}

// --- a gap in the notes (0.15.63) ---
// A song whose saved notes have a clear gap where the lyrics say someone sings (the recording missed it:
// before 0.15.62 the recorder's clock could be off at a track change, so a song's first ~20 s weren't
// heard) learns itself again on its next play, at most RELEARN_MAX times (the count rides with the entry).
const RELEARN_MAX = 2
// minRunSecs: two short lines together (a whispered aside) aren't a gap the recorder left
const GAP = { voicedMax: 0.1, minLines: 2, minSecs: 8, minRunSecs: 5, restMin: 0.4 }

/**
 * The first stretch of timed lyric lines with (almost) no voiced pitch frames while the rest of the song is
 * well covered: { from, to, lines } (seconds), or null. Lines without timed words (instrumental breaks) aren't
 * looked at; rapped lines (faster than GATE.rapRate) and a song the gate shows as a pitch line throughout
 * (rap, speech) never count as a gap.
 */
function notesGap(entry, opts = {}) {
  const o = Object.assign({}, GAP, opts)
  const doc = expand(entry)
  if (!doc || !doc.pitch || !doc.syllables.length) return null
  const g = gate(doc)
  if (g.song === 'line' && g.stats.spread > GATE.songSpreadMax) return null
  const by = new Map()
  // loop: NOT-WORTH — the song's syllables (hundreds), once per song shown
  for (const s of doc.syllables) {
    if (s.line === null || !(s.end > s.t)) continue
    const l = by.get(s.line) || { t0: s.t, t1: s.end, n: 0 }
    l.t0 = Math.min(l.t0, s.t); l.t1 = Math.max(l.t1, s.end); l.n++
    by.set(s.line, l)
  }
  const lines = [...by.values()].sort((a, b) => a.t0 - b.t0)
  // loop: NOT-WORTH — the song's lines (tens), once per song shown
  for (const l of lines) {
    const frames = Math.max(1, Math.ceil((l.t1 - l.t0) / doc.pitch.hop))
    l.frac = voicedIn(doc.pitch, l.t0, l.t1) / frames
    l.rap = l.n / (l.t1 - l.t0) > GATE.rapRate
  }
  const runs = []
  let run = null
  // loop: NOT-WORTH — the song's lines (tens), once per song shown
  for (const l of lines) {
    if (!l.rap && l.frac < o.voicedMax) { if (!run) runs.push(run = []); run.push(l) } else run = null
  }
  const secs = (r) => r[r.length - 1].t1 - r[0].t0
  const found = runs.find((r) => (r.length >= o.minLines && secs(r) >= o.minRunSecs) || secs(r) >= o.minSecs)
  if (!found) return null
  const rest = lines.filter((l) => !l.rap && !found.includes(l))
  const covered = rest.length ? rest.reduce((a, l) => a + l.frac, 0) / rest.length : 0
  // the rest of the song well covered, and most of it: a song barely voiced anywhere isn't a recording gap
  if (covered < o.restMin || rest.length < found.length) return null
  return { from: round(found[0].t0, 10), to: round(found[found.length - 1].t1, 10), lines: found.length }
}

/** Whether a valid entry with a gap in its notes is learnt again on this play: a gap and fewer than RELEARN_MAX re-learns. */
function relearnDue(entry) {
  if (!entry || entry.failed || (entry.relearns || 0) >= RELEARN_MAX) return null
  return notesGap(entry)
}

/** The entry fits these lyrics (the same text: the notes' syllables point at these lines). */
function entryValid(entry, lyricsHash) {
  return !!(entry && entry.format === FORMAT && !entry.failed && entry.lyricsHash && entry.lyricsHash === lyricsHash)
}

// --- the honest gate ---

const wmedian = (xs) => {
  // xs: [[value, weight]]
  const s = xs.slice().sort((a, b) => a[0] - b[0])
  const total = s.reduce((a, x) => a + x[1], 0)
  let acc = 0
  // loop: NOT-WORTH — a stretch's notes (tens)
  for (const x of s) { acc += x[1]; if (acc >= total / 2) return x[0] }
  return s.length ? s[s.length - 1][0] : 0
}

/** How a set of notes sits: { n, spread (cents, duration-weighted median |cents|), conf (duration-weighted) }. */
function stats(notes) {
  const ns = notes.filter((n) => n.end > n.t)
  if (!ns.length) return { n: 0, spread: 50, conf: 0 }
  const w = ns.map((n) => n.end - n.t)
  const total = w.reduce((a, b) => a + b, 0)
  return {
    n: ns.length,
    spread: wmedian(ns.map((n, i) => [Math.abs(n.cents), w[i]])),
    conf: round(ns.reduce((a, n, i) => a + n.conf * w[i], 0) / Math.max(1e-9, total))
  }
}

/** Voiced pitch-line values between t0 and t1 (0 = no voice). */
function voicedIn(pitch, t0, t1) {
  if (!pitch || !pitch.v) return 0
  const a = Math.max(0, Math.floor((t0 - pitch.t0) / pitch.hop))
  const b = Math.min(pitch.v.length, Math.ceil((t1 - pitch.t0) / pitch.hop))
  let n = 0
  // loop: NOT-WORTH — one stretch's values (≤ a few hundred), once per song
  for (let i = a; i < b; i++) if (pitch.v[i] > 0) n++
  return n
}

/**
 * The stretches of the song and what each one shows: 'notes' (the notes sit on a pitch grid), 'line'
 * (they don't: the pitch line instead) or 'none' (no pitch line either). A stretch is a lyric line
 * (from its first syllable to the next line's), plus the notes outside any line in between; each is
 * judged on its notes pooled with those within GATE.poolS (a short line alone is noise).
 * -> { song: 'notes' | 'line', why, stats, regions: [{ t0, t1, show, line, why, stats }] }
 */
function gate(doc, opts = {}) {
  const g = Object.assign({}, GATE, opts)
  const notes = (doc && doc.notes) || []
  const syl = (doc && doc.syllables) || []
  const songStats = stats(notes)
  // the lines' spans from their syllables
  const spans = new Map()
  // loop: NOT-WORTH — the song's syllables (hundreds), once per song
  for (const s of syl) {
    if (s.line === null || s.line === undefined) continue
    const sp = spans.get(s.line) || { line: s.line, t0: s.t, t1: s.end }
    sp.t0 = Math.min(sp.t0, s.t); sp.t1 = Math.max(sp.t1, s.end)
    spans.set(s.line, sp)
  }
  const lines = [...spans.values()].sort((a, b) => a.t0 - b.t0)
  // stretches: each line, and the gaps between lines that hold notes
  const cuts = []
  const first = notes.length ? notes[0].t : 0
  const last = notes.length ? notes[notes.length - 1].end : 0
  let at = Math.min(first, lines.length ? lines[0].t0 : first)
  // loop: NOT-WORTH — the song's lines (tens), once per song
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]
    if (l.t0 > at + 0.05) cuts.push({ t0: at, t1: l.t0, line: null })
    const t1 = i + 1 < lines.length ? Math.max(l.t1, Math.min(lines[i + 1].t0, l.t1 + 1.5)) : Math.max(l.t1, last)
    cuts.push({ t0: Math.min(l.t0, Math.max(at, l.t0 - 0.25)), t1, line: l.line })
    at = t1
  }
  if (last > at + 0.05) cuts.push({ t0: at, t1: last + 0.01, line: null })
  if (!cuts.length && notes.length) cuts.push({ t0: first, t1: last + 0.01, line: null })
  // syllables a second over each line's sung span (rapped lines are fast)
  const rate = new Map()
  // loop: NOT-WORTH — the song's lines (tens), once per song
  for (const l of lines) {
    const n = syl.filter((s) => s.line === l.line).length
    rate.set(l.line, l.t1 > l.t0 ? round(n / (l.t1 - l.t0), 10) : 0)
  }
  // max: the spread allowed (gridMax for the whole song judged at once and for notes between lines,
  // which have no syllables to tell their delivery by; spreadMax for a line, unless it is rapped)
  const verdict = (st, t0, t1, line = null) => {
    const r = line === null ? 0 : rate.get(line) || 0
    const max = line === null ? g.gridMax : g.spreadMax
    const rapped = line !== null && st.spread > g.gridMax && r > g.rapRate
    if (st.n && st.spread <= max && !rapped && st.conf >= g.confMin) return { show: 'notes', why: '' }
    const why = !st.n ? 'no notes' : st.spread > max ? 'off the pitch grid (' + st.spread + ' cents)'
      : rapped ? 'rapped (' + r + ' syllables a second, ' + st.spread + ' cents off the grid)' : 'unsure pitch (confidence ' + st.conf + ')'
    return { show: voicedIn(doc.pitch, t0, t1) ? 'line' : 'none', why }
  }
  const songWide = notes.length && (songStats.spread > g.songSpreadMax || songStats.conf < g.confMin)
  const regions = cuts.filter((c) => c.t1 > c.t0).map((c) => {
    const own = notes.filter((n) => n.t < c.t1 && n.end > c.t0)
    if (!own.length) return Object.assign({}, c, { show: voicedIn(doc.pitch, c.t0, c.t1) ? 'line' : 'none', why: 'no notes', stats: stats([]) })
    if (songWide) return Object.assign({}, c, verdict(songStats, c.t0, c.t1), { stats: songStats })
    const pool = own.length >= g.minNotes ? own : notes.filter((n) => n.t < c.t1 + g.poolS && n.end > c.t0 - g.poolS)
    const st = stats(pool)
    return Object.assign({}, c, verdict(st, c.t0, c.t1, c.line), { stats: st })
  })
  return {
    song: !notes.length || songWide ? 'line' : 'notes',
    why: !notes.length ? 'no notes' : songWide ? (songStats.spread > g.songSpreadMax ? 'the singing sits off the pitch grid (' + songStats.spread + ' cents): rap, speech or shouting' : 'the pitch is unsure (confidence ' + songStats.conf + ')') : '',
    stats: songStats,
    regions
  }
}

/** The region at song time t (regions in time order), or null. */
function regionAt(regions, t) {
  // loop: NOT-WORTH — the song's stretches (tens), per note change
  for (const r of regions || []) if (t >= r.t0 && t < r.t1) return r
  return null
}

// --- what the band shows: the first-play / later-play switch ---

/**
 * The band's mode. st: { on (the setting), installed (the helper), precise (Precise word timing on),
 * wordSynced (the lyrics have their own word timing: Apple's or LRC words, which Sonata doesn't align; their
 * notes are worked out on those times, so they go through the same first-play / later-play states),
 * timed (line-synced lyrics), instrumental ('lrclib' | 'title': the evidence, lyrics-sources.js), aligned (the words on screen are aligned on this PC), doc (the cached notes
 * for these lyrics, expanded) , pitch (first-play pitch pieces so far), paused (a game runs),
 * error (the last pitch/notes failure, text) }
 * -> { band: 'off' | 'notes' | 'line' | 'message', label, text, info }
 *   off       the switch is off: the band folds away and the lyrics take the room
 *   notes     later plays: notes on the staff (gate() decides per stretch: notes, pitch line or nothing)
 *   line      first play: the pitch line, filled in as the sections are heard
 *   message   on, but nothing to draw for this song: one line says why (never an empty box)
 * The long-text rule (the DS5 app's, Marcy 2026-10-18 "we already solved this"): the visible text says
 * only what you must know, at most TEXT_MAX characters, and wraps when the row is narrow (never cut off);
 * the longer explanation is `info`, behind the ⓘ beside it. A message has no label: the Experimental chip
 * already says it (the label repeated "Experimental" next to it).
 */
const TEXT_MAX = 60
// a text that may run long (an error from main, the gate's reason): too long, the part before its first
// ': ' stays visible and the whole sentence goes behind the ⓘ; with no such part it stays whole (it wraps)
function fit(text) {
  const t = String(text || '')
  if (t.length <= TEXT_MAX) return { text: t, info: '' }
  const at = t.indexOf(': ')
  return at > 0 && at <= TEXT_MAX ? { text: t.slice(0, at), info: t } : { text: t, info: '' }
}
const say = (band, label, text, info) => Object.assign({ band, label }, info ? { text, info } : fit(text))
function mode(st) {
  const s = st || {}
  if (!s.on) return say('off', '', '')
  // an instrumental: nothing is sung, so there is no melody line to set (not a missing setting or a failure)
  if (s.instrumental) return say('message', '', 'Instrumental', 'Sheet notes follow the sung melody, and this recording is instrumental: ' + (s.instrumental === 'title' ? 'its title says so.' : 'LRCLIB (lrclib.net) marks it so.'))
  if (!s.installed) return say('message', '', 'Needs Precise timing’s helper (Settings → Precise timing)', 'Sheet notes are worked out by Precise word timing’s helper on this PC. Install it in Settings → Precise timing.')
  if (!s.precise) return say('message', '', 'Needs Precise word timing on (Settings → Precise timing)', 'Sheet notes are worked out on this PC by Precise word timing’s helper: turn Precise word timing on in Settings → Precise timing.')
  // the notes are on the clock of the words on screen: aligned ones, or the lyrics' own word timing
  if (s.doc && s.doc.notes && s.doc.notes.length && (s.aligned || s.wordSynced)) {
    const g = s.gate || gate(s.doc)
    return say('notes', 'Notes' + (s.doc.key && s.doc.key.name ? ' · ' + s.doc.key.name : ''), g.song === 'line' ? 'Pitch line only' : '', g.song === 'line' ? 'Pitch line only: ' + g.why : '')
  }
  if (!s.timed) return say('message', '', 'Sheet notes need lyrics with line timing')
  if (s.paused) return say((s.pitch && s.pitch.length) ? 'line' : 'message', 'First play · pitch line', 'Paused while a game runs')
  if (s.aligned && !(s.pitch && s.pitch.length)) return say('message', '', s.error || 'This play works out the notes: they show from the next play')
  // the first play, still hearing the song: `live` (listening() puts "Listening and learning" up where the
  // line is still to come); an error takes the row instead and the dot stays off
  return Object.assign(say('line', 'First play · pitch line', s.error || ''), { live: !s.error })
}

// "Over the sung line": the room (px) the sung line opens above itself for the staff: the label row with
// the placement buttons (26 px) and the staff without its syllable row (110 px; the words are right below)
const OVER_ROOM = 136

/**
 * Where the staff sits. st: { on, place ('band' | 'over', the setting) }, band: mode().band, stage: the
 * Studio shows. -> { where: 'none' | 'band' | 'over', room (px the sung line opens above itself) }
 * A message (nothing to draw) always sits in the band: there is no staff to ride over the line.
 */
function placement(st, band, stage) {
  const s = st || {}
  if (!s.on || !stage || band === 'off') return { where: 'none', room: 0 }
  const drawn = band === 'notes' || band === 'line'
  if (drawn && s.place === 'over') return { where: 'over', room: OVER_ROOM }
  return { where: 'band', room: 0 }
}

/** First-play pitch pieces merged into one line (where two overlap, the later one wins where it heard a voice). */
function mergePitch(pieces) {
  const ps = (pieces || []).filter((p) => p && Array.isArray(p.v) && p.hop > 0)
  if (!ps.length) return null
  const hop = ps[0].hop
  const t0 = Math.min(...ps.map((p) => p.t0))
  const t1 = Math.max(...ps.map((p) => p.t0 + p.v.length * p.hop))
  const v = new Array(Math.max(0, Math.round((t1 - t0) / hop))).fill(0)
  // loop: NOT-WORTH — the song's sections (≤ ~12) × their values (≤ ~800), once per new piece
  for (const p of ps) {
    const at = Math.round((p.t0 - t0) / hop)
    for (let i = 0; i < p.v.length; i++) if (p.v[i] > 0 || v[at + i] === undefined) v[at + i] = p.v[i]
  }
  return { t0, hop, v }
}

// --- layout: what to draw, in song seconds and staff steps (sheet-notes-ui.js turns them into pixels) ---

/**
 * The notes laid out on the staff. -> { clef, fifths, key: [{ pos, glyph }], notes: [{ t, end, pos,
 * acc, ledgers, now?, syl (text under it or null), ext (an extender under a melisma's later note),
 * loose (no syllable), show }], bars, lowest, highest }
 * show: the gate's verdict for the note's stretch ('notes' are drawn; 'line'/'none' are left out).
 */
function layout(doc, g) {
  const d = doc || { notes: [], syllables: [] }
  const fifths = (d.key && d.key.fifths) || 0
  const clef = clefFor(d.notes)
  const ka = keyAccidentals(fifths)
  const verdicts = g || gate(d)
  let lastSyl = null
  let lo = 0
  let hi = 8
  const notes = d.notes.map((n) => {
    const sp = spellNote(n, fifths)
    const pos = staffPos(sp, clef)
    lo = Math.min(lo, pos); hi = Math.max(hi, pos)
    const r = regionAt(verdicts.regions, n.t + 0.001)
    let syl = null
    let ext = false
    if (n.syl_index !== null && n.syl_index !== undefined && d.syllables[n.syl_index]) {
      if (n.syl_index !== lastSyl) {
        const s = d.syllables[n.syl_index]
        syl = s.text + (s.syl < s.nsyl - 1 ? '-' : '')
        lastSyl = n.syl_index
      } else ext = true
    }
    return { t: n.t, end: n.end, pos, letter: sp.letter, octave: sp.octave, acc: accidental(sp, ka), ledgers: ledgers(pos), syl, ext, loose: n.syl_index === null || n.syl_index === undefined, show: r ? r.show : 'notes' }
  })
  return { clef, fifths, key: keySignature(fifths, clef), notes, bars: (d.bars || []).slice(), lowest: lo, highest: hi }
}

// How the drawn pitch line follows a voice. The helper's line (MIDI x 10 per 50 ms, 0 = no voice) drops
// out on every consonant, breath-less onset and voicing-confidence dip: on real stems ~60 % of its gaps
// are 50-200 ms inside sung phrases (the median voiced run is 200-400 ms), so drawn as-is the line is a
// row of dashes. Measured on JamendoLyrics "Cortez - Feel (Stripped)" and eleven cached songs: 2-4x fewer runs,
// the median run 0.3-0.5 s -> 0.6-2.8 s; what is left are pauses of 300 ms and more (RMVPE voicing ~0 there).
const LINE = {
  bridgeS: 0.25,    // s: a dropout up to this long between two voiced stretches is bridged (singing goes on; the
                    // helper's half-a-hop rule trims each side, so 5 empty hops are ~150-250 ms without a voice)
  bridgeJump: 70,   // MIDI x 10: ... unless the voice lands more than this (7 semitones) away: a new phrase
  speckS: 0.06,     // s: a voiced stretch shorter than this, alone after bridging, is dropped (a speck)
  octaveS: 0.25,    // s: the window each side whose median judges an octave error
  octaveLo: 95,     // MIDI x 10: a value 9.5 to 14.5 semitones off that median is folded back an octave
  octaveHi: 145,
  spike: 20         // MIDI x 10: a single value more than 2 semitones off both neighbours is a spike
}

/**
 * The pitch line made continuous where the voice is: octave errors folded back to the local median,
 * single-value spikes taken out (vibrato keeps its swing), dropouts up to
 * LINE.bridgeS bridged in log frequency (MIDI is log frequency: a straight line between the two sides),
 * and specks shorter than LINE.speckS dropped. -> { t0, hop, v } (v: MIDI x 10, 0 = no voice; not rounded)
 */
function cleanPitch(pitch) {
  if (!pitch || !Array.isArray(pitch.v)) return pitch
  const hop = pitch.hop > 0 ? pitch.hop : PITCH_HOP
  const src = pitch.v.map((x) => (x > 0 ? x : 0))
  const n = src.length
  const w = Math.max(1, Math.round(LINE.octaveS / hop))
  // octave errors: a value about an octave off the voiced values around it
  const v = src.slice()
  // loop: NOT-WORTH — the song's pitch values (a few thousand) × a 11-value window, once per song or new piece
  for (let i = 0; i < n; i++) {
    if (!(src[i] > 0)) continue
    const near = []
    // loop: NOT-WORTH — the window around one value (≤ 11)
    for (let k = Math.max(0, i - w); k <= Math.min(n - 1, i + w); k++) if (src[k] > 0) near.push(src[k])
    if (near.length < 3) continue
    near.sort((a, b) => a - b)
    const off = src[i] - near[near.length >> 1]
    if (Math.abs(off) >= LINE.octaveLo && Math.abs(off) <= LINE.octaveHi) v[i] = src[i] - Math.sign(off) * 120
  }
  // single-value spikes: one value further than LINE.spike above (or below) both its neighbours goes to
  // their middle (not a running median: at 20 values/s that halves a 5-6 Hz vibrato's swing)
  const m = v.slice()
  // loop: NOT-WORTH — the song's pitch values, once per song or new piece
  for (let i = 1; i < n - 1; i++) {
    if (!(v[i - 1] > 0 && v[i] > 0 && v[i + 1] > 0)) continue
    const a = v[i] - v[i - 1]
    const b = v[i] - v[i + 1]
    if (Math.sign(a) === Math.sign(b) && Math.min(Math.abs(a), Math.abs(b)) > LINE.spike) m[i] = (v[i - 1] + v[i + 1]) / 2
  }
  // short dropouts: bridged in a straight line (log frequency) when both sides are near each other
  const gapMax = Math.round(LINE.bridgeS / hop + 1e-9)
  let last = -1
  // loop: NOT-WORTH — the song's pitch values, once per song or new piece
  for (let i = 0; i < n; i++) {
    if (!(m[i] > 0)) continue
    const gap = i - last - 1
    if (last >= 0 && gap > 0 && gap <= gapMax && Math.abs(m[i] - m[last]) <= LINE.bridgeJump) {
      // loop: NOT-WORTH — the few values of one dropout (≤ gapMax)
      for (let k = 1; k <= gap; k++) m[last + k] = m[last] + (m[i] - m[last]) * k / (gap + 1)
    }
    last = i
  }
  // specks: voiced stretches shorter than LINE.speckS
  const speck = LINE.speckS / hop - 1e-9
  let from = -1
  // loop: NOT-WORTH — the song's pitch values, once per song or new piece
  for (let i = 0; i <= n; i++) {
    const on = i < n && m[i] > 0
    if (on && from < 0) from = i
    if (!on && from >= 0) {
      if (i - from < speck) m.fill(0, from, i)
      from = -1
    }
  }
  return { t0: pitch.t0, hop, v: m }
}

/**
 * The pitch line as polyline runs in (song time, staff pos), continuous through sung phrases (cleanPitch)
 * and split where the singing stops, only inside [from, to) stretches when given (the gate's 'line'
 * regions). -> [[[t, pos], ...], ...]
 */
function pitchRuns(pitch, clef, fifths, spans) {
  if (!pitch || !pitch.v) return []
  const line = cleanPitch(pitch)
  const runs = []
  let cur = null
  const inside = (t) => !spans || spans.some((s) => t >= s.t0 && t < s.t1)
  // loop: NOT-WORTH — the song's pitch values (~20/s, a few thousand), once per song or new piece
  for (let i = 0; i < line.v.length; i++) {
    const t = round(line.t0 + i * line.hop)
    const v = line.v[i]
    if (!(v > 0) || !inside(t)) { cur = null; continue }
    if (!cur) { cur = []; runs.push(cur) }
    cur.push([t, round(contPos(v / 10, clef, fifths), 100)])
  }
  return runs.filter((r) => r.length > 1)
}

/**
 * The staff box's room (Marcy 2026-10-18, Sabrina Carpenter "House Tour" at 2:29: a high stretch of the pitch
 * line was drawn above the staff with nothing to read it by, right under the label row). Staff positions the
 * box shows clear of the label row above it (the top 20 px keep room for the mark) and of the syllables under
 * it (lyrics.html .sn-syls, 108 px): sheet-notes-ui.js BASE 92, 6 px a step, so pos 12 (y 20, the second ledger
 * line above the staff) down to pos -2 (y 104, the first below).
 */
const ROOM = { hi: 12, lo: -2 }

/**
 * The pitch line's runs fitted to the room, read like notes: above or below the staff it gets ledger lines
 * (each at its staff position, under the stretch that reaches it); beyond the room it runs along the room's
 * edge, marked out (out: 1 above, -1 below) with a mark where it leaves, instead of being cut off or drawn
 * where nothing says how high it is. runs: pitchRuns(). -> { runs: [{ pts: [[t, pos]], out }],
 * ledgers: [{ pos, t0, t1 }], marks: [{ t, pos, dir }] }
 */
function roomRuns(runs, room = ROOM) {
  const out = { runs: [], ledgers: [], marks: [] }
  const side = (p) => (p > room.hi ? 1 : p < room.lo ? -1 : 0)
  const edge = (p) => Math.max(room.lo, Math.min(room.hi, p))
  const open = new Map()   // ledger pos -> the stretch being drawn
  const ledgerAt = (t, p) => {
    // loop: NOT-WORTH — the ledger positions a point needs (a few)
    for (const L of ledgers(Math.round(edge(p)))) { const l = open.get(L); if (l) { l.t1 = t; l.last = t } else { const n = { pos: L, t0: t, t1: t, last: t }; open.set(L, n); out.ledgers.push(n) } }
  }
  // loop: NOT-WORTH — the song's pitch runs and their points (a few thousand), once per build
  for (const run of runs || []) {
    let cur = null
    let prevT = null
    for (const [t, p] of run) {
      const s = side(p)
      if (!cur || cur.out !== s) {
        // the new piece starts where the last one ended, so the line stays one stroke
        const pts = cur ? [[prevT, edge(cur.pts[cur.pts.length - 1][1])]] : []
        cur = { pts, out: s }
        out.runs.push(cur)
        if (s) out.marks.push({ t, pos: s > 0 ? room.hi : room.lo, dir: s })
      }
      cur.pts.push([t, edge(p)])
      // a ledger stretch continues while the next point still needs it (closed by a gap in time)
      // loop: NOT-WORTH — the open ledger stretches (a few)
      for (const l of open.values()) if (l.last !== prevT) open.delete(l.pos)
      ledgerAt(t, p)
      prevT = t
    }
    open.clear()
  }
  out.runs = out.runs.filter((r) => r.pts.length > 1)
  // loop: NOT-WORTH — the ledger stretches, once per build
  out.ledgers = out.ledgers.map(({ pos, t0, t1 }) => ({ pos, t0, t1 }))
  return out
}

/**
 * First play: "Listening and learning" (Marcy 2026-10-18: "some kind of little green blinking dot would really
 * communicate to users"). A section's pitch line comes only after the section has been sung (the helper
 * separates the voice of a part once it has heard it; with Apple's or LRCLIB's line timing that is a
 * whole section), so on a first play the staff between the heard line's end and the playhead is empty. While
 * the part at the playhead has no line yet the band's label row says so, with a small blinking dot (also on
 * the staff at the playhead): it replaces "First play · pitch line" and 0.15.47's gap message, and the ⓘ
 * keeps the detail. It stops when the part's line is there (a piece covers the playhead), after the
 * lyrics' end (nothing left to hear), while paused for a game or on an error (mode(): not `live`).
 * m: mode(); pieces: the first play's pitch pieces ({ t0, hop, v }); t: the song time; end: the lyrics'
 * end (s; 0 = not known). -> null, or { label, info }
 */
const LISTENING = {
  label: 'Listening and learning',
  info: 'The pitch line for this part appears once Sonata has heard it; next play it’s there from the start.'
}
function listening(m, pieces, t, end) {
  if (!m || m.band !== 'line' || !m.live || !(t >= 0)) return null
  if (end > 0 && t >= end) return null
  // loop: NOT-WORTH — the song's sections (≤ ~12), on the 2/s time pushes of the first play's band only
  for (const p of pieces || []) {
    if (p && Array.isArray(p.v) && p.hop > 0 && t >= p.t0 && t < p.t0 + p.v.length * p.hop) return null
  }
  return LISTENING
}

/**
 * What the staff can show, as merged [t0, t1] spans in song time (0.15.50: the label said "pitch line
 * here" over an empty staff in a vocal break, Marcy on Mad Season "Wake Up (Live At the Moore)").
 * notes: the drawn notes ({ t, end }); runs: the drawn pitch-line runs (pitchRuns); syllables: the sung
 * syllables ({ t, end }). -> { sung, notes, line }: sung is any of the three (someone sings there).
 */
function spansOf(list) {
  const xs = list.filter((x) => x[1] > x[0]).sort((p, q) => p[0] - q[0])
  const out = []
  // loop: NOT-WORTH — the song's notes, runs or syllables (hundreds), once per build
  for (const x of xs) {
    const last = out[out.length - 1]
    if (last && x[0] <= last[1]) last[1] = Math.max(last[1], x[1])
    else out.push([x[0], x[1]])
  }
  return out
}
// lyrics: the lyric lines' sung spans ([[t0, t1]], main's sung: lyricSpans), so a line the notes left out
// (one the aligner didn't trust has no syllables here) still counts as sung
function staffSpans(notes, runs, syllables, lyrics) {
  const n = (notes || []).map((x) => [x.t, x.end])
  const l = (runs || []).filter((r) => r.length).map((r) => [r[0][0], r[r.length - 1][0]])
  const y = (syllables || []).map((x) => [x.t, x.end])
  const ly = (lyrics || []).filter((x) => Array.isArray(x)).map((x) => [Number(x[0]), Number(x[1])])
  return { notes: spansOf(n), line: spansOf(l), sung: spansOf(n.concat(l, y, ly)) }
}

/**
 * The timed lyric lines' sung spans, [[t, end]] (s, 2 decimals): from the line's start to its end as the
 * interlude dots reckon it (lineEnd: lyrics-timing.js, words or the line's end, else a guess), so "no
 * singing here" and the dots agree. lineEnd(line, next) -> s.
 */
function lyricSpans(lines, lineEnd) {
  const timed = (lines || []).filter((l) => l && l.t != null && Number.isFinite(Number(l.t)))
  const r2 = (x) => Math.round(x * 100) / 100
  // loop: NOT-WORTH — the song's lines (tens), once per track change
  return timed.map((l, i) => [r2(l.t), r2(lineEnd(l, timed[i + 1]))]).filter((x) => Number.isFinite(x[1]) && x[1] > x[0])
}

/**
 * The stretch of song time the staff shows at t: the playhead sits HEAD_AT across the box, the staff
 * starts after the gutter (clef and key). paged (reduced motion): the page holding t.
 * v: { width, gutter, pps, headAt, paged } -> { a, b }
 */
function viewWindow(t, v) {
  const span = Math.max(1, (v.width - v.gutter) / v.pps)
  if (v.paged) { const p = Math.floor(t / span); return { a: p * span, b: (p + 1) * span } }
  const a = t - (v.width * v.headAt - v.gutter) / v.pps
  return { a, b: a + span }
}

const touches = (spans, a, b) => (spans || []).some((x) => x[0] < b && x[1] > a)
/** What the window [a, b) has on the staff: { sung, notes, line } (booleans). */
function seenIn(sp, w) {
  return { sung: touches(sp && sp.sung, w.a, w.b), notes: touches(sp && sp.notes, w.a, w.b), line: touches(sp && sp.line, w.a, w.b) }
}

/**
 * The next song time after t when something enters or leaves the window (Infinity: none), so the label
 * changes with the staff: a span's start reaching the window's end, its end leaving the window's start;
 * paged, the page's end.
 */
function nextSeen(sp, t, w, paged) {
  if (paged) return w.b > t ? w.b : Infinity
  let best = Infinity
  // loop: NOT-WORTH — the song's merged spans (tens to hundreds), per note change while playing and shown
  for (const k of ['sung', 'notes', 'line']) {
    for (const x of (sp && sp[k]) || []) {
      const enter = x[0] - (w.b - t)
      const leave = x[1] + (t - w.a)
      if (enter > t && enter < best) best = enter
      if (leave > t && leave < best) best = leave
    }
  }
  return best
}

// nobody sings in the window shown (a break, or after the lyrics end): the staff is empty and the label says so
const QUIET = {
  text: 'no singing here',
  info: 'Nobody sings in this stretch of the staff: an instrumental break, or past the end of the lyrics.'
}

/**
 * The label above the band for a mode + the stretch at the playhead ('Notes · G minor · pitch line
 * here: notes unsure'), matching what is drawn: seen (seenIn() for the window shown) "no singing here"
 * when the window has nothing sung; the pitch-line clause only while a pitch-line run is in view.
 * Without seen, the stretch at the playhead alone decides (as before 0.15.50).
 */
function labelAt(m, region, seen) {
  if (m.band !== 'notes') return m.label
  if (seen && !seen.sung) return m.label + ' · ' + QUIET.text
  if (!region || region.show === 'notes') return m.label
  return m.label + (region.show === 'line' && (!seen || seen.line) ? ' · pitch line here: notes unsure' : ' · notes unsure here')
}

/** The time of the next note start or end, or region edge, after t (Infinity: none). */
function nextChange(lay, regions, t) {
  let best = Infinity
  // loop: HOT-PATH-OK — the song's notes (hundreds): one pass per note change while playing and shown (≈ 2-4 per second), no DOM
  for (const n of lay.notes) {
    if (n.t > t && n.t < best) best = n.t
    else if (n.end > t && n.end < best) best = n.end
  }
  // loop: NOT-WORTH — the song's stretches (tens), per note change
  for (const r of regions || []) if (r.t0 > t && r.t0 < best) best = r.t0
  return best
}

/** Which note is sounding at t: its index or -1 (notes in time order, they don't overlap). */
function noteAt(lay, t) {
  const ns = lay.notes
  let lo = 0
  let hi = ns.length - 1
  // loop: NOT-WORTH — a binary search over the notes, per note change
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (ns[mid].end <= t) lo = mid + 1
    else if (ns[mid].t > t) hi = mid - 1
    else return mid
  }
  return -1
}

module.exports = {
  FORMAT, GATE, LINE, CLEFS, TEXT_MAX, fit, PITCH_HOP, SHARP, FLAT, OVER_ROOM, placement,
  parseName, spellMidi, midiOf, spellNote, keyAccidentals, keySignature, clefFor, staffPos, ledgers, accidental, contPos,
  compact, expand, entryValid, notesGap, relearnDue, RELEARN_MAX, GAP, stats, gate, regionAt, mode, mergePitch, layout, cleanPitch, pitchRuns, ROOM, roomRuns, LISTENING, listening,
  staffSpans, lyricSpans, viewWindow, seenIn, nextSeen, QUIET, labelAt, nextChange, noteAt
}
// the band follows the song clock the way every clocked animation does (song-clock.js followRate)
const { followRate, FOLLOW_SNAP, FOLLOW_MIN, FOLLOW_MAX } = require('./song-clock')
Object.assign(module.exports, { followRate, FOLLOW_SNAP, FOLLOW_MIN, FOLLOW_MAX })
