// Lyrics written as shorthand (Marcy 2026-10-18: Mad Season "I Don't Know Anything (Live At the Moore)",
// 6:23: LRCLIB's lyrics end at 2:48 with a line "(repeat all)", so 3.5 minutes of singing had no lyrics).
// Some lyrics stand for sung lines with a marker: "(repeat all)", "(x2)", "Oh no x3", "[Chorus]" with
// nothing under it, "(repeat chorus)", "(repeat 1st verse)". A marker is never shown as a sung line;
// the lines it stands for are written out (expandShorthand). Their times are not known, so main.js shows
// the written-out lyrics untimed and the helper places every line from the audio (align-session.js's
// plain-lyrics mode, as for lyrics timed for another version).
//
// The matcher is a table per language (MARKERS; English first): each entry's words are matched against a
// line's whole text with its brackets, a trailing colon and a count ("x2", "×3", "2x") taken off, so a sung
// line that only contains such a word ("(oh yeah)", "(I love?!?)", "Repeat after me") never matches.
//
// Electron-free, tested in test/lyrics-shorthand.test.js.

const MAX_TIMES = 9            // "x12" is not a count we write out

// per language: repeat everything sung so far; repeat a named block; the block labels; the ordinals
const MARKERS = {
  en: {
    all: /^repeat(?: (?:all|everything|(?:the )?whole (?:song|thing|lyrics?)|from (?:the )?(?:top|start|beginning)|song))?$/,
    ref: /^repeat (?:the )?(.+)$/,
    label: /^(chorus|refrain|hook|verse|bridge|pre-chorus|prechorus|post-chorus|intro|outro|interlude|coda|tag)(?: (\d+|[a-z]+))?$/,
    ordinal: { first: 1, '1st': 1, second: 2, '2nd': 2, third: 3, '3rd': 3, fourth: 4, '4th': 4, fifth: 5, '5th': 5, one: 1, two: 2, three: 3, four: 4 },
    ordinalFirst: /^(first|second|third|fourth|fifth|\d+(?:st|nd|rd|th)) (verse|chorus|bridge)$/,
    chorus: /^(chorus|refrain|hook)$/
  }
}

// the inside of a marker: brackets, asterisks, a trailing colon off, lower case, single spaces
function inner(text) {
  let s = String(text || '').trim()
  const wrapped = /^[[(*{].*[\])*}]$/.test(s)
  if (wrapped) s = s.slice(1, -1).trim()
  s = s.replace(/:$/, '').replace(/\s+/g, ' ').trim().toLowerCase()
  return { s, wrapped }
}

// a count at the end ("chorus x2", "x3", "2x", "×2"): -> { s (without it), n } (n 1 when none)
function count(s) {
  const m = /^(.*?)\s*(?:[x×]\s*(\d+)|(\d+)\s*[x×])$/.exec(s)
  if (!m) return { s, n: 1 }
  const n = Number(m[2] || m[3])
  return n >= 2 && n <= MAX_TIMES ? { s: m[1].trim(), n } : { s, n: 1 }
}

// a block's name: "chorus", "verse 2" ("verse two" -> "verse 2"); null when it isn't one
function blockName(s, lang) {
  const L = MARKERS[lang]
  const f = L.ordinalFirst.exec(s)
  if (f) return f[2] + ' ' + (L.ordinal[f[1]] || parseInt(f[1], 10))
  const m = L.label.exec(s)
  if (!m) return null
  const kind = m[1] === 'prechorus' ? 'pre-chorus' : m[1]
  if (!m[2]) return kind
  const n = /^\d+$/.test(m[2]) ? Number(m[2]) : L.ordinal[m[2]]
  return n ? kind + ' ' + n : null
}

/**
 * One lyric line read as a marker, or null for a sung line. -> { kind, n, name? }
 *   all     repeat everything sung so far, n times
 *   label   a block's name ("[Chorus]", "Verse 2:"); with no sung line under it, it stands for that block
 *   ref     repeat a named block ("(repeat chorus)", "(repeat 1st verse)")
 *   times   the line before, n times in all ("(x2)" alone on a line)
 *   inline  this line's own text sung n times ("Oh no (x2)", "Oh no x3"): { text }
 */
function readMarker(text, lang = 'en') {
  const L = MARKERS[lang] || MARKERS.en
  const raw = String(text || '').trim()
  if (!raw) return null
  const { s, wrapped } = inner(raw)
  const c = count(s)
  if (!c.s && c.n > 1) return { kind: 'times', n: c.n }                  // "(x2)", "x3", "[2x]"
  if (L.all.test(c.s)) return { kind: 'all', n: c.n }
  const ref = L.ref.exec(c.s)
  if (ref) { const name = blockName(ref[1], lang); if (name) return { kind: 'ref', name, n: c.n } }
  const name = blockName(c.s, lang)
  // a bare label must look like one: one word ("Chorus"), a numbered one ("Verse 2"), a colon or brackets
  if (name && (wrapped || /:$/.test(raw) || c.n > 1 || /^\S+( \d+)?$/.test(c.s))) return { kind: 'label', name, n: c.n }
  // a sung line with a count after it: "Oh no (x2)", "Oh no [x3]", "Oh no x2"
  const m = /^(.*\S)\s+(?:[[(]\s*(?:[x×]\s*(\d+)|(\d+)\s*[x×])\s*[\])]|[x×](\d+))$/.exec(raw)
  if (m) {
    const n = Number(m[2] || m[3] || m[4])
    if (n >= 2 && n <= MAX_TIMES) return { kind: 'inline', n, text: m[1] }
  }
  return null
}

/**
 * The lyrics with their shorthand written out, or null when they have none. lines: [{ t?, text, agent? }]
 * (LRC or plain). -> { lines: [{ t: null, text, agent? }] when lines were added (their times are not known),
 *   else the sung lines as they were (only labels dropped), timed: !added, added (lines written out),
 *   markers: [{ line, text, kind }], unresolved: [{ line, text }] (a reference to a block that isn't there:
 *   dropped) }
 */
function expandShorthand(lines, lang = 'en') {
  const list = Array.isArray(lines) ? lines : []
  // loop: NOT-WORTH — the song's lines (tens), once per LRCLIB lyrics lookup (track change)
  const read = list.map((l) => readMarker(l && l.text, lang))
  if (!read.some(Boolean)) return null
  // a label with sung lines under it names them (dropped from the view); with none it stands for its block
  // cache: NOT-WORTH — key=block name; invalidated=a new Map per call; bound=the song's labels (once per lyrics lookup)
  const blocks = new Map()      // name -> [line objects]
  // cache: NOT-WORTH — key=line order; invalidated=a new array per call; bound=the written-out lines (≤ ~150 x MAX_TIMES)
  const out = []
  const markers = []
  const unresolved = []
  let added = 0
  let block = null              // { name, lines, n } being collected
  const copy = (l) => { const o = { t: null, text: String(l.text || '') }; if (l.agent) o.agent = l.agent; return o }
  const push = (l, fresh) => { out.push(fresh ? copy(l) : l); if (fresh) added++; if (block) block.lines.push(l) }
  const close = () => {
    if (!block) return
    if (!blocks.has(block.name)) blocks.set(block.name, block.lines)
    // "[Chorus x2]" with its lines: the block sung n times
    for (let k = 1; k < block.n; k++) for (const l of block.lines) { out.push(copy(l)); added++ }   // loop: NOT-WORTH — a block's lines, n ≤ MAX_TIMES · once per song
    block = null
  }
  const emptyAfter = (i) => { for (let j = i + 1; j < list.length; j++) { const r = read[j]; if (!r || r.kind === 'inline') return false; if (r.kind !== 'times') return true } return true }
  // loop: NOT-WORTH — the song's lines (tens), once per track change
  for (let i = 0; i < list.length; i++) {
    const l = list[i]
    const r = read[i]
    if (!r) { push(l, false); continue }
    markers.push({ line: i, text: String(l.text || ''), kind: r.kind })
    if (r.kind === 'inline') {
      const sung = Object.assign({}, l, { text: r.text })
      push(sung, false)
      for (let k = 1; k < r.n; k++) push(sung, true)   // loop: NOT-WORTH — n ≤ MAX_TIMES copies of one line · once per song
      continue
    }
    if (r.kind === 'times') {
      const prev = out[out.length - 1]
      if (!prev) { unresolved.push({ line: i, text: String(l.text || '') }); continue }
      for (let k = 1; k < r.n; k++) push(prev, true)   // loop: NOT-WORTH — n ≤ MAX_TIMES copies of one line · once per song
      continue
    }
    if (r.kind === 'label' && !emptyAfter(i)) { close(); block = { name: r.name, lines: [], n: r.n }; continue }
    close()
    if (r.kind === 'all') {
      const sung = out.slice()
      for (let k = 0; k < r.n; k++) for (const s of sung) { out.push(copy(s)); added++ }   // loop: NOT-WORTH — the lines so far, n ≤ MAX_TIMES · once per song
      continue
    }
    // a reference ("(repeat chorus)", "[Chorus]" with nothing under it): the named block, else for a chorus the
    // lines sung most often in a row (choruses repeat), else nothing (dropped, logged)
    const lines = blocks.get(r.name) || ((MARKERS[lang] || MARKERS.en).chorus.test(r.name) ? repeatedRun(out) : stanza(list, read, r.name))
    if (!lines || !lines.length) { unresolved.push({ line: i, text: String(l.text || '') }); continue }
    for (let k = 0; k < r.n; k++) for (const s of lines) { out.push(copy(s)); added++ }   // loop: NOT-WORTH — a block's lines, n ≤ MAX_TIMES · once per song
  }
  close()
  if (!added) return { lines: out, timed: true, added: 0, markers, unresolved }
  // loop: NOT-WORTH — the written-out lines, once per LRCLIB lyrics lookup with shorthand
  return { lines: out.map((l) => (l.t === null ? l : copy(l))), timed: false, added, markers, unresolved }
}

// "verse N" in timed lyrics without labels: the N-th stanza (the lines between two interludes, ≥ 4 s
// without singing: lyrics-timing findInterludes), counted over the sung lines; null when there's none
function stanza(list, read, name) {
  const m = /^verse (\d+)$/.exec(name)
  // loop: NOT-WORTH — the song's lines, once per "verse N" marker in a lyrics lookup
  const sung = list.filter((l, i) => !read[i] && l && l.t != null)
  // loop: NOT-WORTH — the song's lines, once per "verse N" marker in a lyrics lookup
  if (!m || !sung.length || sung.length !== list.filter((l, i) => !read[i]).length) return null
  // loop: NOT-WORTH — the song's interludes (a few), once per "verse N" marker in a lyrics lookup
  const starts = new Set(require('./lyrics-timing').findInterludes(sung).map((g) => g.index))
  // cache: NOT-WORTH — key=stanza index; invalidated=a new array per call; bound=the song's stanzas
  const out = [[]]
  // loop: NOT-WORTH — the song's lines, once per song with such a marker
  sung.forEach((l, i) => { if (i && starts.has(i)) out.push([]); out[out.length - 1].push(l) })
  return out[Number(m[1]) - 1] || null
}

// the longest run of ≥ 2 lines that occurs twice (the chorus when it isn't labelled); null when none
function repeatedRun(lines) {
  const key = (l) => String(l.text || '').toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, '').replace(/\s+/g, ' ').trim()
  const k = lines.map(key)
  let best = null
  // loop: NOT-WORTH — pairs of start lines (≤ ~100² compares of short runs), once per song with an unlabelled chorus marker
  for (let a = 0; a < k.length; a++) {
    for (let b = a + 1; b < k.length; b++) {
      let n = 0
      while (b + n < k.length && a + n < b && k[a + n] && k[a + n] === k[b + n]) n++
      if (n >= 2 && (!best || n > best.n)) best = { a, n }
    }
  }
  return best ? lines.slice(best.a, best.a + best.n) : null
}

module.exports = { MARKERS, MAX_TIMES, readMarker, expandShorthand, repeatedRun }
