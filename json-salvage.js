// Reads what still reads in a damaged JSON file (truncated by a crash, a stray byte, a half-written
// save). Pure: text in, values out. Used by settings-store.js (settings.json: its top-level keys,
// one by one) and lyrics-store.js (lyrics-cache.json: the items of its "entries" array, one by one).
// A value that doesn't parse is dropped; everything around it is kept.

// From `start` (just after an opening { or [), the raw text of each top-level item of that container,
// until its closing bracket or the end of the text. Strings and nesting are respected.
// -> [{ raw, key? }] (key: for an object, the member's name when it read)
// loop: HOT-PATH-OK — one pass over the file's characters (settings ~1 KB, lyrics cache ≤ 20 MB, once at load)
function items(text, start, isObject) {
  const out = []
  let i = start
  const n = text.length
  while (i < n) {
    // skip whitespace and commas between items
    while (i < n && /[\s,]/.test(text[i])) i++
    if (i >= n || text[i] === (isObject ? '}' : ']')) break
    const from = i
    let depth = 0
    let inStr = false
    // loop: HOT-PATH-OK — the same single pass over the text (see items())
    for (; i < n; i++) {
      const c = text[i]
      if (inStr) {
        if (c === '\\') i++
        else if (c === '"') inStr = false
        continue
      }
      if (c === '"') inStr = true
      else if (c === '{' || c === '[') depth++
      else if (c === '}' || c === ']') {
        if (depth === 0) break
        depth--
      } else if (c === ',' && depth === 0) break
    }
    out.push({ raw: text.slice(from, i) })
    if (text[i] === (isObject ? '}' : ']') ) break
  }
  return out
}

const tryParse = (raw) => {
  // error: NOT-WORTH — an item that doesn't parse is the damage being salvaged: dropped and counted
  try { return { ok: true, value: JSON.parse(raw) } } catch (e) { return { ok: false } }
}

// A damaged top-level object: its members that still read. -> { values: { key: value }, bad: n }
// (bad: members found whose name or value didn't parse)
function salvageObject(text) {
  const s = String(text || '')
  const open = s.indexOf('{')
  const values = {}
  let bad = 0
  if (open < 0) return { values, bad: s.trim() ? 1 : 0 }
  // loop: NOT-WORTH — one entry per member (~30 settings)
  for (const it of items(s, open + 1, true)) {
    const m = /^\s*("(?:[^"\\]|\\.)*")\s*:([\s\S]*)$/.exec(it.raw)
    const k = m ? tryParse(m[1]) : { ok: false }
    const v = m ? tryParse(m[2]) : { ok: false }
    if (k.ok && v.ok && typeof k.value === 'string') values[k.value] = v.value
    else bad++
  }
  return { values, bad }
}

// A damaged object's array member (`"entries": [ ... ]`): the items that still read.
// -> { items: [...], bad: n, found: bool }
function salvageArrayMember(text, name) {
  const s = String(text || '')
  const re = new RegExp('"' + name.replace(/[^A-Za-z0-9_]/g, '') + '"\\s*:\\s*\\[')
  const m = re.exec(s)
  if (!m) return { items: [], bad: 0, found: false }
  const out = []
  let bad = 0
  // loop: HOT-PATH-OK — one entry per cached song (≤ 2,000), once at load
  for (const it of items(s, m.index + m[0].length, false)) {
    const v = tryParse(it.raw)
    if (v.ok) out.push(v.value)
    else bad++
  }
  return { items: out, bad, found: true }
}

// `<file>.corrupt-2026-10-16T12-30-05` beside the file (a copy of the damaged one, kept for the user)
function asideName(file, date) {
  const d = date instanceof Date ? date : new Date()
  return file + '.corrupt-' + d.toISOString().slice(0, 19).replace(/:/g, '-')
}

module.exports = { salvageObject, salvageArrayMember, asideName }
