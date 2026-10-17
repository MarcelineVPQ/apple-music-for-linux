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
const GATE = {
  spreadMax: 20,      // cents: a stretch whose notes sit further off the grid than this is not shown as notes
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
  const verdict = (st, t0, t1) => {
    if (st.n && st.spread <= g.spreadMax && st.conf >= g.confMin) return { show: 'notes', why: '' }
    const why = !st.n ? 'no notes' : st.spread > g.spreadMax ? 'off the pitch grid (' + st.spread + ' cents)' : 'unsure pitch (confidence ' + st.conf + ')'
    return { show: voicedIn(doc.pitch, t0, t1) ? 'line' : 'none', why }
  }
  const songWide = notes.length && (songStats.spread > g.songSpreadMax || songStats.conf < g.confMin)
  const regions = cuts.filter((c) => c.t1 > c.t0).map((c) => {
    const own = notes.filter((n) => n.t < c.t1 && n.end > c.t0)
    if (!own.length) return Object.assign({}, c, { show: voicedIn(doc.pitch, c.t0, c.t1) ? 'line' : 'none', why: 'no notes', stats: stats([]) })
    if (songWide) return Object.assign({}, c, verdict(songStats, c.t0, c.t1), { stats: songStats })
    const pool = own.length >= g.minNotes ? own : notes.filter((n) => n.t < c.t1 + g.poolS && n.end > c.t0 - g.poolS)
    const st = stats(pool)
    return Object.assign({}, c, verdict(st, c.t0, c.t1), { stats: st })
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
 * wordSynced (the lyrics have their own word timing: Apple's or LRC words, which Sonata doesn't align),
 * timed (line-synced lyrics), aligned (the words on screen are aligned on this PC), doc (the cached notes
 * for these lyrics, expanded) , pitch (first-play pitch pieces so far), paused (a game runs),
 * error (the last pitch/notes failure, text) }
 * -> { band: 'off' | 'notes' | 'line' | 'message', label, text }
 *   off       the switch is off: the band folds away and the lyrics take the room
 *   notes     later plays: notes on the staff (gate() decides per stretch: notes, pitch line or nothing)
 *   line      first play: the pitch line, filled in as the sections are heard
 *   message   on, but nothing to draw for this song: one line says why (never an empty box)
 */
function mode(st) {
  const s = st || {}
  if (!s.on) return { band: 'off', label: '', text: '' }
  if (!s.installed) return { band: 'message', label: 'Experimental', text: 'Sheet notes need Precise word timing’s helper (Settings → Precise timing)' }
  if (!s.precise) return { band: 'message', label: 'Experimental', text: 'Sheet notes need Precise word timing on (Settings → Precise timing)' }
  if (s.doc && s.doc.notes && s.doc.notes.length && s.aligned) {
    const g = s.gate || gate(s.doc)
    return { band: 'notes', label: 'Notes' + (s.doc.key && s.doc.key.name ? ' · ' + s.doc.key.name : ''), text: g.song === 'line' ? 'Pitch line only: ' + g.why : '' }
  }
  if (s.wordSynced) return { band: 'message', label: 'Experimental', text: 'No sheet notes for this song yet: it has its own word timing, and Sonata works out notes only for songs it times itself' }
  if (!s.timed) return { band: 'message', label: 'Experimental', text: 'Sheet notes need lyrics with line timing' }
  if (s.paused) return { band: (s.pitch && s.pitch.length) ? 'line' : 'message', label: 'First play · pitch line', text: 'Paused while a game runs' }
  if (s.pitch && s.pitch.length) return { band: 'line', label: 'First play · pitch line', text: s.error || '' }
  if (s.aligned) return { band: 'message', label: 'Experimental', text: s.error || 'This play works out the notes: they show from the next play' }
  return { band: 'line', label: 'First play · pitch line', text: s.error || 'The pitch line follows each part of the song once Sonata has heard it' }
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

/**
 * The pitch line as polyline runs in (song time, staff pos), split where nobody sings, only inside
 * [from, to) stretches when given (the gate's 'line' regions). -> [[[t, pos], ...], ...]
 */
function pitchRuns(pitch, clef, fifths, spans) {
  if (!pitch || !pitch.v) return []
  const runs = []
  let cur = null
  const inside = (t) => !spans || spans.some((s) => t >= s.t0 && t < s.t1)
  // loop: NOT-WORTH — the song's pitch values (~20/s, a few thousand), once per song or new piece
  for (let i = 0; i < pitch.v.length; i++) {
    const t = round(pitch.t0 + i * pitch.hop)
    const v = pitch.v[i]
    if (!(v > 0) || !inside(t)) { cur = null; continue }
    if (!cur) { cur = []; runs.push(cur) }
    cur.push([t, round(contPos(v / 10, clef, fifths), 100)])
  }
  return runs.filter((r) => r.length > 1)
}

/** The label above the band for a mode + the stretch at the playhead ('Notes · G minor · pitch line here'). */
function labelAt(m, region) {
  if (m.band !== 'notes' || !region || region.show === 'notes') return m.label
  return m.label + (region.show === 'line' ? ' · pitch line here: notes unsure' : ' · notes unsure here')
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
  FORMAT, GATE, CLEFS, PITCH_HOP, SHARP, FLAT,
  parseName, spellMidi, midiOf, spellNote, keyAccidentals, keySignature, clefFor, staffPos, ledgers, accidental, contPos,
  compact, expand, entryValid, stats, gate, regionAt, mode, mergePitch, layout, pitchRuns, labelAt, nextChange, noteAt
}
