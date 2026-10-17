// Estimated syllables for the karaoke syllable pop (lyrics-view.js). Apple rarely times syllables
// (most word-synced TTML is one span per word, most lyrics are line-only), so a timed word without
// Apple's own `syl` is split by Liang/TeX hyphenation patterns (the `hyphen` package, ISC; patterns
// from hyph-utf8) and its [t, end] is spread over the parts, weighted by their vowels. Apple's `syl`
// always wins. Words in non-Latin scripts, or in a language without patterns here, stay whole (the
// whole word pops, as before).
//
// Edges: hyphen never splits off fewer than 2 letters at either end (leftmin = rightmin = 2), and
// words shorter than MIN_WORD letters stay whole. A hyphen inside a word (0.15.35) is always a
// boundary: "(Hey-hey-ay-ay-ay)" pops syllable by syllable; each piece is then hyphenated as usual.
//
// Cost: one pattern file per language, loaded on first use (en-us ~100 KB) and kept; the split runs
// once per line when lyrics load or a line's timing changes, never per frame.
const MIN_WORD = 4

// lyrics language (BCP 47, e.g. Apple TTML xml:lang) -> hyphen pattern file. Latin-script languages only.
const PATTERNS = {
  en: 'en-us', 'en-us': 'en-us', 'en-gb': 'en-gb', 'en-au': 'en-gb', 'en-nz': 'en-gb', 'en-ie': 'en-gb',
  de: 'de-1996', fr: 'fr', es: 'es', it: 'it', pt: 'pt', nl: 'nl', sv: 'sv', da: 'da',
  nb: 'nb', no: 'nb', nn: 'nb', fi: 'fi', pl: 'pl', cs: 'cs', sk: 'sk', hu: 'hu', ro: 'ro',
  tr: 'tr', id: 'id', ca: 'ca', hr: 'hr', sl: 'sl'
}
const SEP = '­'

/** Pattern file for a language tag; en-us when unknown (null for a known language without patterns). */
function patternFor(lang) {
  if (!lang) return 'en-us'
  const tag = String(lang).toLowerCase().replace(/_/g, '-')
  if (PATTERNS[tag]) return PATTERNS[tag]
  return PATTERNS[tag.split('-')[0]] || null
}

// lifetime: one hyphenator per pattern file for the process's life (at most a few languages)
const hyphenators = new Map()
/** hyphenate(word) -> string with SEP between parts, or null when there are no patterns. */
function hyphenatorFor(lang) {
  const file = patternFor(lang)
  if (!file) return null
  if (!hyphenators.has(file)) {
    let h = null
    // error: NOT-WORTH — a missing or broken pattern file means no estimated syllables, never a broken view
    try {
      const createHyphenator = require('hyphen')
      h = createHyphenator(require('hyphen/patterns/' + file), { hyphenChar: SEP, minWordLength: MIN_WORD, html: false })
    } catch (e) { h = null }
    hyphenators.set(file, h)
  }
  return hyphenators.get(file)
}

const NON_LATIN_LETTER = /(?=\p{L})\P{Script=Latin}/u

// a hyphen between two letters: a syllable boundary of its own ("(Hey-hey-ay-ay-ay)", which the
// patterns leave whole). The hyphen stays on the piece before it, brackets on the outer pieces.
const INNER_HYPHEN = /(?<=\p{L})-(?=\p{L})/u

// one piece's hyphenation parts (the piece itself when the patterns leave it whole)
function hyphenParts(piece, hyphenate) {
  const parts = String(hyphenate(piece)).split(SEP).filter(Boolean)
  return parts.length > 1 && parts.join('') === piece ? parts : [piece]
}

/**
 * A word's text -> syllable texts (joined they are the word), or null when it stays whole. Hyphens
 * inside the word split first ("(Hey-", "hey-", "ay-", "ay-", "ay)"), then each piece is hyphenated
 * by the patterns when it's long enough. Still one word: only its syllables change.
 */
function splitWord(text, hyphenate) {
  if (!hyphenate || !text || text.includes(SEP) || NON_LATIN_LETTER.test(text)) return null
  const pieces = INNER_HYPHEN.test(text) ? text.split(INNER_HYPHEN).map((p, i, all) => i < all.length - 1 ? p + '-' : p) : [text]
  const parts = []
  // loop: NOT-WORTH — a word's hyphen pieces (a handful) · once per word per load or timing change
  for (const piece of pieces) parts.push(...hyphenParts(piece, hyphenate))
  return parts.length > 1 && parts.join('') === text ? parts : null
}

// a part's share of the word's time: its vowel letters count fully, other letters a little
function partWeight(part) {
  const letters = part.replace(/[^\p{L}]/gu, '')
  const vowels = (letters.toLowerCase().match(/[aeiouyà-ÿ]/g) || []).length
  return Math.max(0.5, vowels + 0.3 * (letters.length - vowels))
}

/** [t, end] spread over the parts by weight: monotonic, first t = word t, last end = word end. */
function spread(t, end, parts) {
  const weights = parts.map(partWeight)
  const total = weights.reduce((a, b) => a + b, 0)
  const out = []
  let at = t
  let acc = 0
  // loop: NOT-WORTH — one pass over a word's parts (a handful) · once per word per load or timing change
  for (let i = 0; i < parts.length; i++) {
    acc += weights[i]
    const to = i === parts.length - 1 ? end : t + (end - t) * acc / total
    out.push({ t: at, end: to, text: parts[i] })
    at = to
  }
  return out
}

/**
 * Words with estimated syllables added where they split (Apple's syl kept, untimed or zero-length
 * words left alone). Returns the same array when nothing changes.
 */
// Where a held word's hold starts: holdFrom (the aligner's sung end, the estimator's paced end), or
// for a word only marked held (Level 1) its sung part guessed at ~0.3 s per syllable-ish, at most
// 40 % of the word. null: not held.
function holdStart(w) {
  if (w.holdFrom != null && w.holdFrom > w.t && w.holdFrom < w.end) return w.holdFrom
  if (!w.held) return null
  const from = w.t + Math.min((w.end - w.t) * 0.4, 0.3 * Math.max(1, (w.text.match(/[aeiouyà-ÿ]+/gi) || []).length))
  return from > w.t && from < w.end ? from : null
}

function withSyllables(words, hyphenate) {
  if (!hyphenate || !Array.isArray(words)) return words
  let changed = false
  // loop: one pass over a line's words · once per line per load or timing change
  const out = words.map((w) => {
    if (!w || w.syl || !(w.end > w.t)) return w
    const parts = splitWord(w.text, hyphenate)
    if (!parts) return w
    changed = true
    // a held note (0.15.34): the syllables are sung over [t, holdFrom] and the last one carries the
    // hold to the word's end (to-night: "to" quick, "night" held), not spread evenly over the hold
    const from = holdStart(w)
    if (from != null) {
      const syl = spread(w.t, from, parts)
      syl[syl.length - 1].end = w.end
      return Object.assign({}, w, { syl })
    }
    return Object.assign({}, w, { syl: spread(w.t, w.end, parts) })
  })
  return changed ? out : words
}

/** A line with estimated syllables in its words and background vocals (same object when none). */
function lineWithSyllables(line, hyphenate) {
  if (!line || !hyphenate) return line
  const words = withSyllables(line.words, hyphenate)
  const bg = withSyllables(line.bg, hyphenate)
  if (words === line.words && bg === line.bg) return line
  const out = Object.assign({}, line)
  if (line.words) out.words = words
  if (line.bg) out.bg = bg
  return out
}

module.exports = { holdStart, MIN_WORD, patternFor, hyphenatorFor, splitWord, spread, withSyllables, lineWithSyllables }
