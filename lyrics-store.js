// On-disk lyrics cache: songs played before load instantly (also offline) and the lyrics
// service gets fewer requests. Only good results are stored (the resolver never passes empty
// or failed lookups). Bounded by entry count and total size; least recently used goes first.
// lifetime: one Map in memory (≤ maxEntries), one JSON file; writes are debounced and atomic
// (temp file + rename), so a crash never leaves a half-written cache.
// loop: one debounce timer (2 s) per burst of changes · stops after the write · flush() on quit

// Recovery (0.15.32): a damaged cache file keeps every song that still reads (json-salvage.js), is
// copied aside as lyrics-cache.json.corrupt-<date>, and opts.onRecovered({ kept, dropped, aside })
// lets main show one notice. A missing file is just an empty cache.
// error: SHOWN — a damaged cache: the notice (main.js); a failed write: NOT-WORTH, it's a cache

const fs = require('fs')
const path = require('path')
const { salvageArrayMember, asideName } = require('./json-salvage')

function createLyricsStore(opts) {
  const file = opts.file
  const maxEntries = opts.maxEntries || 2000
  const maxBytes = opts.maxBytes || 20 * 1024 * 1024
  const debounceMs = opts.debounceMs == null ? 2000 : opts.debounceMs
  const io = opts.fs || fs
  let map = null          // key -> { value, size }
  let bytes = 0
  let timer = null

  const isEntry = (e) => Array.isArray(e) && e.length === 2 && typeof e[0] === 'string' && e[1] !== undefined
  function load() {
    if (map) return
    map = new Map()
    let text
    // error: NOT-WORTH — no cache file yet: start empty
    try { text = io.readFileSync(file, 'utf8') } catch (e) { return }
    let entries = null
    try {
      const data = JSON.parse(text)
      if (data && Array.isArray(data.entries) && data.entries.every(isEntry)) entries = data.entries
    } catch (e) { /* error: SHOWN — damaged: salvaged below, one notice (onRecovered) */ }
    if (entries) {
      // loop: HOT-PATH-OK — ≤ 2,000 entries, once at the first lookup
      for (const [key, value] of entries) add(key, value)
      return
    }
    const s = salvageArrayMember(text, 'entries')
    const good = s.items.filter(isEntry)
    // loop: HOT-PATH-OK — ≤ 2,000 entries, once
    for (const [key, value] of good) add(key, value)
    let aside = ''
    // error: SHOWN — no copy kept: the notice says so
    try { aside = asideName(file, opts.now ? opts.now() : new Date()); io.copyFileSync(file, aside) } catch (e) { aside = '' }
    save()   // the repaired cache, at once
    if (opts.onRecovered) opts.onRecovered({ kept: good.length, dropped: s.bad + (s.items.length - good.length) + (s.found ? 0 : 1), aside })
  }

  function add(key, value) {
    const size = JSON.stringify(value).length + key.length
    if (map.has(key)) bytes -= map.get(key).size
    map.delete(key)
    map.set(key, { value, size })
    bytes += size
    // loop: NOT-WORTH — drops the oldest entries until within bounds; usually 0-1 per add
    while (map.size > maxEntries || (bytes > maxBytes && map.size > 1)) {
      const [oldKey, old] = map.entries().next().value
      map.delete(oldKey)
      bytes -= old.size
    }
  }

  function save() {
    timer = null
    try {
      io.mkdirSync(path.dirname(file), { recursive: true })
      const tmp = file + '.tmp'
      io.writeFileSync(tmp, JSON.stringify({ version: 1, entries: [...map].map(([k, e]) => [k, e.value]) }))
      io.renameSync(tmp, file)
    } catch (e) { /* error: NOT-WORTH — cache only: a failed write is not an error for the user */ }
  }

  return {
    get(key) {
      load()
      const e = map.get(key)
      if (!e) return null
      map.delete(key)          // mark as recently used
      map.set(key, e)
      return e.value
    },
    set(key, value) {
      load()
      add(key, value)
      // loop: cache write debounce · one-shot 2 s per burst of changes · stops after the write · cost one file write
      if (!timer) timer = setTimeout(save, debounceMs)
    },
    flush() {
      if (timer) { clearTimeout(timer); save() }
    },
    get size() { load(); return map.size },
    get bytes() { load(); return bytes }
  }
}

module.exports = { createLyricsStore }
