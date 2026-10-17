// The Montage's photos on disk (~/.config/apple-music-for-linux/montage/): each Commons thumbnail
// downloaded once, at its display width, then shown from here (also offline). Bounded by total size
// and count; the least recently shown goes first (its file's mtime is touched on each use). The
// photos' credits and the artist → photos answers live in the JSON cache beside it (lyrics-store.js,
// montage-cache.json), so a cached photo always comes back with its author and licence.
// lifetime: no timers, no watchers; one directory listing at the first use, then an in-memory index.
// error: NOT-WORTH — it's a cache: a failed write or delete leaves the photo to be fetched again.
'use strict'
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')

const NAME = /^[0-9a-f]{40}\.(jpg|png)$/

/** The file name for a photo URL: its SHA-1 and the type's extension. */
function nameFor(url, type) {
  return crypto.createHash('sha1').update(String(url)).digest('hex') + (type === 'image/png' ? '.png' : '.jpg')
}

/**
 * createImageStore({ dir, maxBytes, maxFiles, fs, now }) -> { path(name), has(name), get(name), put(name, bytes), size() }
 * get: the file's path (and marks it used) or null; put: writes it (temp + rename), then drops the
 * least recently used files until both bounds hold (never the one just written).
 */
function createImageStore(opts) {
  const dir = opts.dir
  const maxBytes = opts.maxBytes || 80 * 1024 * 1024
  const maxFiles = opts.maxFiles || 400
  const io = opts.fs || fs
  const now = opts.now || Date.now
  let index = null          // name -> { bytes, used }
  let total = 0

  function load() {
    if (index) return
    index = new Map()
    let names = []
    try { names = io.readdirSync(dir) } catch (e) { return }   // error: NOT-WORTH — no folder yet: an empty cache
    // loop: NOT-WORTH — ≤ maxFiles (+ strays) entries, once at the first use
    for (const n of names) {
      if (!NAME.test(n)) continue
      try {
        const st = io.statSync(path.join(dir, n))
        index.set(n, { bytes: st.size, used: st.mtimeMs })
        total += st.size
      } catch (e) { /* error: NOT-WORTH — vanished between the listing and the stat: not in the cache */ }
    }
  }
  function drop(n) {
    const e = index.get(n)
    if (!e) return
    index.delete(n)
    total -= e.bytes
    try { io.unlinkSync(path.join(dir, n)) } catch (e2) { /* error: NOT-WORTH — already gone */ }
  }
  function prune(keep) {
    if (total <= maxBytes && index.size <= maxFiles) return
    const old = [...index.entries()].filter(([n]) => n !== keep).sort((a, b) => a[1].used - b[1].used)
    // loop: NOT-WORTH — ≤ maxFiles entries, only when a new photo pushed the cache over a bound
    for (const [n] of old) {
      if (total <= maxBytes && index.size <= maxFiles) break
      drop(n)
    }
  }
  return {
    path: (n) => path.join(dir, n),
    has(n) { load(); return NAME.test(n) && index.has(n) },
    get(n) {
      load()
      if (!NAME.test(n) || !index.has(n)) return null
      const p = path.join(dir, n)
      const t = now()
      index.get(n).used = t
      try { io.utimesSync(p, t / 1000, t / 1000) } catch (e) { /* error: NOT-WORTH — the file went missing: dropped below */
        index.delete(n); return null
      }
      return p
    },
    put(n, bytes) {
      load()
      if (!NAME.test(n) || !bytes || !bytes.length) return null
      const p = path.join(dir, n)
      const t = now()
      try {
        io.mkdirSync(dir, { recursive: true })
        const tmp = p + '.tmp'
        io.writeFileSync(tmp, bytes)
        io.renameSync(tmp, p)
        io.utimesSync(p, t / 1000, t / 1000)   // the file's mtime is its last use (read back after a restart)
      } catch (e) { return null }   // error: NOT-WORTH — disk full or read-only: null, main skips that photo (the others show)
      if (index.has(n)) total -= index.get(n).bytes
      index.set(n, { bytes: bytes.length, used: t })
      total += bytes.length
      prune(n)
      return p
    },
    size() { load(); return { bytes: total, files: index.size } }
  }
}

module.exports = { createImageStore, nameFor }
