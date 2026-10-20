// Song sections from the lyrics (Marcy 2026-10-19): "Verse 1", "Pre-chorus", "Chorus", "Bridge" labels
// above the first line of each section in the lyrics window and the Studio, worked out from the words alone
// (no engine, no audio). Electron-free; tested in test/lyrics-sections.test.js. lyrics-data carries the
// result as data.sections (for later: chord chart headers, a Rock Band style lift).
//
// Accuracy rule: never label when unsure. A song with no clear repeated block (through-composed) gets none.
//
// 1. Apple's TTML names the parts itself (itunes:songPart on its <div>s, lyrics-sources.js line.part):
//    used as given, verses numbered in order.
// 2. Otherwise, from repetition:
//    - each line is reduced to its words (lower case, no accents or punctuation, no bracketed ad-libs, no
//      "oh"/"yeah" interjections); two lines are the same when >= 80 % of their words match in order.
//      A line with nothing left ("Whoa-oh", "(Yeah!)") is an ad-lib: it belongs to the section before it.
//    - a copy of half the song or more ("(repeat all)" written out, a live reprise) is set aside and takes
//      the labels of what it copies;
//    - segments: a new one starts where a run of 2+ lines repeated elsewhere starts or ends, and at a
//      stanza break (Apple's <div>s, a blank line in plain lyrics, a long gap in the timing);
//    - segments that repeat each other (>= 75 % of their lines) are one kind. The Chorus is the kind
//      repeated most (among those holding the title when any does), then the longest; it needs 3 times,
//      or 2 times with 3+ lines. Kinds that always follow it join it; a kind always right before it joins
//      it when it holds the title (its lines before the title line, 2+, are the Pre-chorus), else it is
//      the Pre-chorus. A segment made only of chorus lines (a short reprise) is Chorus.
//    - lines that never repeat are verses, numbered in order; one alone after the 2nd chorus and before
//      the last, in the second half of the song, and unlike the verses in shape (line count or line
//      length) is the Bridge; a lone 1-2 line stanza first or last (set off by a break) is the Intro/Outro.
//    - a short (1-2 line) repeated block that is none of these gets no label.

const LINE_SAME = 0.8     // share of a line's words that match in order: the same line
const KIND_SAME = 0.75    // share of a segment's lines that match: the same kind of segment
const COPY_MIN = 8        // lines: a copied block at least this long ...
const COPY_SHARE = 0.4    // ... and this share of the song is a copy ("repeat all")
const INTERJECTIONS = new Set(['oh', 'ooh', 'oooh', 'ohh', 'ohhh', 'whoa', 'woah', 'woo', 'wooh', 'yeah', 'yeh', 'yea',
  'ah', 'ahh', 'aah', 'la', 'na', 'hey', 'uh', 'huh', 'mm', 'mmm', 'hmm', 'ha', 'da', 'doo', 'ba', 'eh', 'ay', 'ayy', 'o'])

/** A line's words for comparing: lower case, no accents, punctuation, bracketed ad-libs or interjections. */
function words(text) {
  return String(text || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/\([^)]*\)|\[[^\]]*\]/g, ' ').replace(/['’]/g, '')
    .split(/[^\p{L}\p{N}]+/u).filter((w) => w && !INTERJECTIONS.has(w))
}

// longest common subsequence length of two short arrays (a line's words, a segment's line classes)
function lcs(a, b) {
  let prev = new Array(b.length + 1).fill(0)
  // loop: NOT-WORTH — two lines' words (or two segments' lines, ~4-12), once per song laid out
  for (let i = 0; i < a.length; i++) {
    const cur = [0]
    // loop: NOT-WORTH — see above
    for (let j = 0; j < b.length; j++) cur.push(a[i] === b[j] ? prev[j] + 1 : Math.max(prev[j + 1], cur[j]))
    prev = cur
  }
  return prev[b.length]
}

/** Two lines' words the same (>= 80 % in order; short lines must match exactly by the same rule). */
function sameLine(a, b) {
  if (!a.length || !b.length) return false
  return lcs(a, b) / Math.max(a.length, b.length) >= LINE_SAME
}

// a's words appear in b in a row (a shortened chorus line: "see that girl" in "see that girl, watch that scene")
function inside(a, b) {
  if (a.length < 2 || a.length > b.length) return false
  // loop: NOT-WORTH — one line's word positions
  for (let i = 0; i + a.length <= b.length; i++) if (a.every((w, k) => b[i + k] === w)) return true
  return false
}

// where the timing shows a stanza break before line i: a gap well over the song's usual one
function timingBreaks(lines) {
  const gaps = []
  let ends = 0
  // loop: NOT-WORTH — the song's lines, once per song laid out
  for (let i = 1; i < lines.length; i++) {
    const a = lines[i - 1]
    const b = lines[i]
    if (!Number.isFinite(a.t) || !Number.isFinite(b.t)) { gaps.push(null); continue }
    if (Number.isFinite(a.end)) ends++
    gaps.push(b.t - (Number.isFinite(a.end) ? a.end : a.t))
  }
  const known = gaps.filter((g) => g !== null && g >= 0).sort((x, y) => x - y)
  const out = lines.map(() => false)
  if (known.length < 4) return out
  const med = known[Math.floor(known.length / 2)]
  // with line ends a gap is the silence between lines; without, the start-to-start time
  const limit = ends >= (lines.length - 1) / 2 ? Math.max(3.5, 5 * med) : Math.max(2 * med, med + 3)
  // loop: NOT-WORTH — the song's gaps, once per song laid out
  gaps.forEach((g, k) => { if (g !== null && g >= limit) out[k + 1] = true })
  return out
}

// Apple's own part names (itunes:songPart) -> sections; null when the TTML gave none
function appleSections(lines) {
  const marks = []
  // loop: NOT-WORTH — the song's lines, once per song laid out
  lines.forEach((l, i) => { if (l && typeof l.part === 'string' && l.part) marks.push({ start: i, part: l.part.toLowerCase().replace(/[^a-z]/g, '') }) })
  if (!marks.length) return null
  const KIND = { verse: 'verse', chorus: 'chorus', prechorus: 'pre-chorus', bridge: 'bridge', intro: 'intro', outro: 'outro', refrain: 'chorus', hook: 'chorus', postchorus: 'chorus' }
  let verses = 0
  const out = []
  // loop: NOT-WORTH — the song's parts (~5-15)
  for (const m of marks) {
    const kind = KIND[m.part] || null
    const n = kind === 'verse' ? ++verses : undefined
    const prev = out[out.length - 1]
    if (prev && prev.kind === kind && kind !== 'verse') continue   // "Chorus", "Chorus": one section
    out.push(section(m.start, kind, n))
  }
  return finish(out, lines.length)
}

const LABEL = { verse: 'Verse', chorus: 'Chorus', 'pre-chorus': 'Pre-chorus', bridge: 'Bridge', intro: 'Intro', outro: 'Outro' }
function section(start, kind, n) {
  return { start, kind, n: n || null, label: kind ? LABEL[kind] + (n ? ' ' + n : '') : null }
}

// each section's end (the next one's start), unlabelled leading lines folded into nothing
function finish(list, count) {
  // loop: NOT-WORTH — the song's sections
  list.forEach((s, k) => { s.end = k + 1 < list.length ? list[k + 1].start : count })
  return list
}

/**
 * The song's sections from its lyric lines ([{ t, end?, text, brk?, part? }], the lines the view shows).
 * opts: { title }. -> [{ start, end, kind, n, label }] (line indexes; kind null / label null: a stretch
 * left unlabelled), [] when the song shows no clear structure.
 */
function songSections(lines, opts = {}) {
  const list = Array.isArray(lines) ? lines : []
  if (list.length < 4) return []
  const apple = appleSections(list)
  if (apple) return apple
  const w = list.map((l) => words(l && l.text))
  const sung = []   // the lines that aren't ad-libs (indexes into list)
  // loop: NOT-WORTH — the song's lines, once per song laid out
  w.forEach((x, i) => { if (x.length) sung.push(i) })
  if (sung.length < 4) return []
  // classes: lines that are the same line share one
  const reps = []
  const cls = sung.map((i) => {
    const k = reps.findIndex((r) => sameLine(w[r], w[i]))
    if (k >= 0) return k
    reps.push(i)
    return reps.length - 1
  })
  const timed = timingBreaks(list)
  // a stanza break before sung line k: any break mark between the sung line before it and it
  const brk = sung.map((i, k) => {
    if (k === 0) return true
    // loop: NOT-WORTH — the few ad-lib lines between two sung lines
    for (let j = sung[k - 1] + 1; j <= i; j++) if (timed[j] || (list[j] && list[j].brk)) return true
    return false
  })
  const title = words(String(opts.title || '').replace(/\s+[-–]\s+.*$/, ''))
  const result = analyse(sung.map((i, k) => k), cls, brk, w, sung, title)
  if (!result) return []
  return finish(result, list.length)
}

// the longest block copied later in the song: { from, to, len } (sung-line positions), or null
function longestCopy(cls) {
  let best = null
  const n = cls.length
  // loop: NOT-WORTH — every diagonal of the song's lines (n² with n ~ 100), once per song laid out
  for (let d = 1; d < n; d++) {
    let run = 0
    // loop: NOT-WORTH — see above
    for (let k = 0; k + d < n; k++) {
      run = cls[k] === cls[k + d] && run < d ? run + 1 : (cls[k] === cls[k + d] ? 1 : 0)
      if (run && (!best || run > best.len)) best = { from: k - run + 1, to: k - run + 1 + d, len: run }
    }
  }
  return best
}

// sections for the sung lines at positions idx (into sung) -> [{ start (a line index), kind, n, label }]
function analyse(idx, cls, brk, w, sung, title) {
  const copy = longestCopy(idx.map((k) => cls[k]))
  if (copy && copy.len >= COPY_MIN && copy.len >= COPY_SHARE * idx.length) {
    // set the copy aside, label the rest, then the copy takes its source's labels
    const keep = idx.filter((k, p) => p < copy.to || p >= copy.to + copy.len)
    const base = analyse(keep, cls, brk, w, sung, title)
    if (!base) return null
    const srcStart = sung[idx[copy.from]]
    const srcEnd = sung[idx[copy.from + copy.len - 1]]
    const at = (line) => { let s = null; for (const x of base) if (x.start <= line) s = x; return s }   // loop: NOT-WORTH — the song's sections
    const shift = sung[idx[copy.to]] - srcStart
    const copied = [Object.assign({}, at(srcStart), { start: srcStart + shift })]
    // loop: NOT-WORTH — the song's sections
    for (const x of base) if (x.start > srcStart && x.start <= srcEnd) copied.push(Object.assign({}, x, { start: x.start + shift }))
    const after = copy.to + copy.len < idx.length ? sung[idx[copy.to + copy.len]] : null
    const out = base.filter((x) => x.start < copied[0].start || (after !== null && x.start >= after))
    if (after !== null && !out.some((x) => x.start === after)) out.push(Object.assign({}, at(after), { start: after }))
    return merge(out.concat(copied).sort((a, b) => a.start - b.start))
  }
  const c = idx.map((k) => cls[k])
  const n = c.length
  // segment starts: where a repeated run (2+ lines, offset >= 2, not overlapping itself) starts or ends
  const cut = idx.map((k, p) => p === 0 || brk[k])
  // loop: NOT-WORTH — every pair of the song's lines (n² with n ~ 100), once per song laid out
  for (let p = 0; p < n; p++) {
    // loop: NOT-WORTH — see above
    for (let q = p + 2; q < n; q++) {
      if (c[p] !== c[q] || (p > 0 && c[p - 1] === c[q - 1])) continue
      let len = 1
      while (q + len < n && p + len < q && c[p + len] === c[q + len]) len++   // loop: NOT-WORTH — one run's length
      if (len < 2) continue
      cut[p] = cut[q] = true
      if (p + len < n) cut[p + len] = true
      if (q + len < n) cut[q + len] = true
    }
  }
  const segs = []
  // loop: NOT-WORTH — the song's lines
  for (let p = 0; p < n; p++) {
    if (cut[p]) segs.push({ a: p, b: p + 1 })
    else segs[segs.length - 1].b = p + 1
  }
  // loop: NOT-WORTH — the song's segments
  segs.forEach((s) => { s.cls = c.slice(s.a, s.b); s.brk = brk[idx[s.a]] })
  // kinds: segments that repeat each other
  const kinds = []
  // loop: NOT-WORTH — the song's segments and the kinds found so far
  for (const s of segs) {
    const k = kinds.find((K) => lcs(K.cls, s.cls) / Math.max(K.cls.length, s.cls.length) >= KIND_SAME)
    if (k) { k.segs.push(s); s.kind = k } else { const K = { cls: s.cls, segs: [s] }; kinds.push(K); s.kind = K }
  }
  const hasTitle = (s) => title.length > 0 && s.cls.some((x, j) => inside(title, w[sung[idx[s.a + j]]]) || title.join(' ') === w[sung[idx[s.a + j]]].join(' '))
  const repeated = kinds.filter((K) => K.segs.length >= 2 && K.cls.length >= 2)
  const titled = repeated.filter((K) => K.segs.some(hasTitle))
  const pick = (titled.length ? titled : repeated).sort((x, y) => y.segs.length - x.segs.length || y.cls.length - x.cls.length)[0]
  if (!pick || !(pick.segs.length >= 3 || pick.cls.length >= 3)) return null
  // the chorus family: the chorus kind and the kinds glued to it
  const family = new Set([pick])
  const pre = new Set()
  const split = new Set()   // kinds holding the title after 2+ lines: those lines are the pre-chorus
  const pos = (s) => segs.indexOf(s)
  let grew = true
  // loop: NOT-WORTH — at most one pass per kind (each pass adds one or stops)
  while (grew) {
    grew = false
    // loop: NOT-WORTH — the song's kinds
    for (const K of kinds) {
      if (family.has(K) || pre.has(K) || K.segs.length < 2) continue
      const isAfter = (s) => { const p = pos(s); return p > 0 && family.has(segs[p - 1].kind) && !s.brk }
      const isBefore = (s) => { const p = pos(s); return p + 1 < segs.length && family.has(segs[p + 1].kind) && !segs[p + 1].brk }
      const before = K.segs.every(isBefore)
      const titled = K.segs.some(hasTitle)
      // always right before the chorus, never after it, no title, not longer than half again the chorus: Pre-chorus
      if (before && !titled && !K.segs.some(isAfter) && K.cls.length <= 1.5 * pick.cls.length) { pre.add(K); continue }
      // next to the chorus every time, or all but once (a reprise cut short)
      // (a block that always comes straight after it, even past a pause, is its post-chorus)
      const always = K.segs.every((s) => { const p = pos(s); return p > 0 && family.has(segs[p - 1].kind) })
      if (!before && (always || K.segs.filter((s) => isAfter(s) || isBefore(s)).length >= Math.max(2, K.segs.length - 1))) { family.add(K); grew = true } else if (before && titled) {
        family.add(K)
        grew = true
        const first = (s) => s.cls.findIndex((x, j) => inside(title, w[sung[idx[s.a + j]]]) || title.join(' ') === w[sung[idx[s.a + j]]].join(' '))
        if (K.segs.every((s) => first(s) >= 2)) split.add({ K, first })
      }
    }
  }
  // the chorus kind itself holding the title only from its 3rd line on: the lines before are the pre-chorus
  const titleAt = (s) => s.cls.findIndex((x, j) => inside(title, w[sung[idx[s.a + j]]]) || title.join(' ') === w[sung[idx[s.a + j]]].join(' '))
  if (title.length && pick.segs.every((s) => titleAt(s) >= 2)) split.add({ K: pick, first: titleAt })
  // chorus lines: any line of the family (or a run of its words, 2+) — a short reprise is the chorus too
  const famLines = []
  // loop: NOT-WORTH — the song's segments and their lines
  for (const s of segs) if (family.has(s.kind)) for (let p = s.a; p < s.b; p++) famLines.push(w[sung[idx[p]]])
  const chorusLine = (p) => famLines.some((f) => sameLine(w[sung[idx[p]]], f) || inside(w[sung[idx[p]]], f))
  // label each segment
  const marks = []
  // loop: NOT-WORTH — the song's segments
  for (const s of segs) {
    const line = sung[idx[s.a]]
    let kind
    if (family.has(s.kind)) kind = 'chorus'
    else if (pre.has(s.kind)) kind = 'pre-chorus'
    else {
      let all = true
      // loop: NOT-WORTH — one segment's lines
      for (let p = s.a; p < s.b && all; p++) all = chorusLine(p)
      kind = all ? 'chorus' : s.kind.segs.length < 2 ? 'unique' : s.cls.length >= 3 ? 'verse-kind' : null
    }
    const sp = [...split].find((x) => x.K === s.kind)
    if (sp) {
      marks.push({ start: line, kind: 'pre-chorus', brk: s.brk, lines: s.b - s.a })
      marks.push({ start: sung[idx[s.a + sp.first(s)]], kind: 'chorus', brk: false, lines: 0 })
      continue
    }
    marks.push({ start: line, kind, brk: s.brk, lines: s.b - s.a, seg: s })
  }
  // a repeated block that always comes straight after a chorus is its post-chorus: Chorus
  const byKind = new Map()
  // loop: NOT-WORTH — the song's segment marks
  marks.forEach((m, k) => { if (m.kind === 'verse-kind') byKind.set(m.seg.kind, (byKind.get(m.seg.kind) || []).concat(k)) })
  // loop: NOT-WORTH — the song's repeated verse kinds
  for (const ks of byKind.values()) if (ks.every((k) => { let j = k - 1; while (j >= 0 && marks[j].kind === null) j--; return j >= 0 && marks[j].kind === 'chorus' })) for (const k of ks) marks[k].kind = 'chorus'   // loop: NOT-WORTH — see above
  // one section per stretch: the same kind running on with no stanza break between
  const secs = []
  // loop: NOT-WORTH — the song's segments
  for (const m of marks) {
    const prev = secs[secs.length - 1]
    if (prev && prev.kind === m.kind && !m.brk && m.kind !== 'verse-kind') { prev.lines += m.lines; prev.segs.push(m.seg); continue }
    secs.push(Object.assign({}, m, { segs: [m.seg] }))
  }
  // a short repeated block with no label opens the verse right after it, or stays with the section before;
  // a single unique line straight after a section (a tag, "Let's go, come on") stays with it
  // loop: NOT-WORTH — the song's sections, backwards
  for (let k = secs.length - 1; k >= 0; k--) {
    const s = secs[k]
    const next = secs[k + 1]
    const prev = secs[k - 1]
    if (s.kind === null && next && next.kind === 'unique' && !next.brk) {
      next.start = s.start; next.brk = s.brk; next.lines += s.lines; next.segs = s.segs.concat(next.segs); secs.splice(k, 1)
    } else if (prev && !s.brk && (s.kind === null || (s.kind === 'unique' && s.lines === 1))) {
      prev.lines += s.lines; prev.segs = prev.segs.concat(s.segs); secs.splice(k, 1)
    }
  }
  // unique stretches: intro / outro / bridge / verse
  const chorusAt = secs.map((s, k) => (s.kind === 'chorus' ? k : -1)).filter((k) => k >= 0)
  const uniques = secs.map((s, k) => (s.kind === 'unique' ? k : -1)).filter((k) => k >= 0)
  const second = chorusAt[1]
  const last = chorusAt[chorusAt.length - 1]
  const late = uniques.filter((k) => second !== undefined && k > second && k < last)
  const lineTotal = (s) => s.segs.reduce((t, g) => t + (g ? g.b - g.a : 0), 0)
  const wordsPer = (s) => {
    let words = 0
    let count = 0
    // loop: NOT-WORTH — one stretch's lines
    for (const g of s.segs) if (g) for (let p = g.a; p < g.b; p++) { words += w[sung[idx[p]]].length; count++ }
    return count ? words / count : 0
  }
  let bridge = -1
  if (chorusAt.length >= 3 && late.length === 1 && uniques.filter((k) => k < late[0]).length >= 2 && uniques.filter((k) => k > second).every((k) => k === late[0])) {
    const b = secs[late[0]]
    const startPos = idx.indexOf(sung.indexOf(b.start))
    const verses = uniques.filter((k) => k < late[0]).map((k) => secs[k])
    const shape = verses.length > 0 && verses.every((v) => Math.abs(lineTotal(v) - lineTotal(b)) >= 2 ||
      wordsPer(b) / (wordsPer(v) || 1) < 0.7 || wordsPer(b) / (wordsPer(v) || 1) > 1.43)
    if (startPos >= n / 2 && shape) bridge = late[0]
  }
  let verse = 0
  const kindNumber = new Map()
  // loop: NOT-WORTH — the song's sections
  secs.forEach((s, k) => {
    if (s.kind === 'unique') {
      if (k === bridge) s.kind = 'bridge'
      else if (k === 0 && s.lines <= 2 && secs.length > 1 && secs[1].kind === 'unique' && secs[1].brk) s.kind = 'intro'
      else if (k === secs.length - 1 && s.lines <= 2 && s.brk && k > last) s.kind = 'outro'
      else { s.kind = 'verse'; s.n = ++verse }
    } else if (s.kind === 'verse-kind') {
      const K = s.segs[0].kind
      if (!kindNumber.has(K)) kindNumber.set(K, ++verse)
      s.kind = 'verse'
      s.n = kindNumber.get(K)
    }
  })
  return merge(secs.map((s) => section(s.start, s.kind, s.n)))
}

// the same label twice in a row: one section
function merge(list) {
  const out = []
  // loop: NOT-WORTH — the song's sections
  for (const s of list) {
    const prev = out[out.length - 1]
    if (prev && prev.label === s.label && s.kind !== 'verse') continue
    if (prev && prev.start === s.start) { out[out.length - 1] = s; continue }
    out.push(s)
  }
  return out
}

// The singers' names on the labels ("Chorus — Sophie & Sky"): behind the duet build's switch for singer
// lanes and name tags (lyrics-lanes.js LANES, off and not a setting until Marcy's OK), with its resolver:
// one flag, one resolver (singerLabels: Apple's ttm:name, else the credited artists when they are
// exactly the singers, else "Singer N"; lines sung together: its group label). Merged 2026-10-19 (qc-checks).
const L = require('./lyrics-lanes')
const NAMES = L.LANES

/**
 * Sections with their singers: sections from songSections, the song's lines (line.agent), names
 * ({ agentId: name }, Apple's ttm:name), opts.artist (the track's artist, for singerLabels' credited
 * names). opts.on: the switch (default lyrics-lanes.js LANES). -> the same sections, each with `singers`
 * ("Sophie & Sky"; singerLabels' group label where a line is sung together, Apple's group agent) when on
 * and the song has 2+ singers; unchanged otherwise.
 */
function withSingers(sections, lines, names, opts = {}) {
  const on = opts.on != null ? !!opts.on : NAMES
  const list = Array.isArray(lines) ? lines : []
  const singers = [...new Set(list.map((l) => l && l.agent).filter((a) => a && a !== 'group'))].sort(L.agentOrder)
  if (!on || singers.length < 2) return sections
  const labels = L.singerLabels(singers, names, opts.artist)
  return sections.map((s) => {
    if (!s.label) return s
    const who = new Set()
    let all = false
    // loop: NOT-WORTH — one section's lines
    for (let i = s.start; i < s.end; i++) {
      const a = list[i] && list[i].agent
      if (a === 'group') all = true
      else if (a) who.add(a)
    }
    if (!all && who.size === 0) return s
    return Object.assign({}, s, { singers: all ? labels.group : [...who].sort(L.agentOrder).map((id) => labels[id]).join(' & ') })
  })
}

/** The text shown above the section's first line: "Chorus", or "Chorus — Sophie & Sky" with singers. */
function labelText(s) {
  return s && s.label ? s.label + (s.singers ? ' — ' + s.singers : '') : ''
}

module.exports = { NAMES, LINE_SAME, KIND_SAME, words, sameLine, inside, timingBreaks, songSections, withSingers, labelText }
