// On-disk lyrics cache: songs played before load instantly (also offline) and the lyrics
// service gets fewer requests. Only good results are stored (the resolver never passes empty
// or failed lookups). Bounded by entry count and total size; least recently used goes first.
// lifetime: one Map in memory (≤ maxEntries), one JSON file; writes are debounced and atomic
// (temp file + rename), so a crash never leaves a half-written cache.
// loop: one debounce timer (2 s) per burst of changes · stops after the write · flush() on quit

const fs = require('fs')
const path = require('path')

function createLyricsStore(opts) {
  const file = opts.file
  const maxEntries = opts.maxEntries || 2000
  const maxBytes = opts.maxBytes || 20 * 1024 * 1024
  const debounceMs = opts.debounceMs == null ? 2000 : opts.debounceMs
  const io = opts.fs || fs
  let map = null          // key -> { value, size }
  let bytes = 0
  let timer = null

  function load() {
    if (map) return
    map = new Map()
    try {
      const data = JSON.parse(io.readFileSync(file, 'utf8'))
      for (const [key, value] of data.entries || []) add(key, value)
    } catch (e) { /* no cache yet, or unreadable: start empty */ }
  }

  function add(key, value) {
    const size = JSON.stringify(value).length + key.length
    if (map.has(key)) bytes -= map.get(key).size
    map.delete(key)
    map.set(key, { value, size })
    bytes += size
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
    } catch (e) { /* cache only: a failed write is not an error for the user */ }
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
