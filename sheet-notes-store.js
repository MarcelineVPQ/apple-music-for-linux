// Sheet notes in the Studio: the per-song cache of the notes the helper worked out (sheet-notes-model.js
// compact()), one small JSON file per song in ~/.config/apple-music-for-linux/sheet-notes/ (about 20-40 kB
// each: the notes, their syllables, the key and the pitch line; no audio, no pitch frames), at most
// MAX_FILES, the least recently used removed first. A song is read only when it plays with the Studio's
// band on, never at start. A song whose notes step failed gets a small marker, so it isn't recorded again
// on every play (at most MAX_TRIES).
// Electron-free; tested in test/sheet-notes.test.js.
'use strict'
const fsMod = require('fs')
const path = require('path')
const { prune } = require('./notes-log')

const DIR_NAME = 'sheet-notes'
const MAX_FILES = 500
const MAX_TRIES = 2

function slug(s) {
  const out = String(s || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40)
  return out || 'unknown'
}
// FNV-1a 32 over title|artist: two songs whose names slug the same still get their own file
function fnv(s) {
  let h = 0x811c9dc5
  // loop: NOT-WORTH — a title and an artist (tens of characters), per lookup
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0 }
  return h.toString(16).padStart(8, '0')
}

/** <artist>-<title>-<hash>.json */
function fileName(title, artist) {
  return slug(artist) + '-' + slug(title) + '-' + fnv(String(title || '') + '|' + String(artist || '')) + '.json'
}

function createSheetNotesStore(opts) {
  const dir = opts.dir
  const io = opts.io || fsMod
  const max = opts.max || MAX_FILES
  const file = (title, artist) => path.join(dir, fileName(title, artist))
  return {
    dir,
    /** The entry for a song, or null. Marks it as used (its file's time), so it is kept longest. */
    get(title, artist) {
      const f = file(title, artist)
      let text
      // error: NOT-WORTH — no file: no notes for this song yet
      try { text = io.readFileSync(f, 'utf8') } catch (e) { return null }
      let entry = null
      // error: NOT-WORTH — a damaged file is a cache miss; the next notes step writes it again
      try { entry = JSON.parse(text) } catch (e) { return null }
      const now = new Date()
      // error: NOT-WORTH — the time only orders the pruning
      try { io.utimesSync(f, now, now) } catch (e) {}
      return entry && typeof entry === 'object' ? entry : null
    },
    /**
     * Writes a song's entry atomically (temp file + rename) and keeps at most `max` files.
     * error: PASSES-ON — a failed write throws to main, which logs it and shows the band's message
     */
    set(title, artist, entry) {
      io.mkdirSync(dir, { recursive: true })
      const name = fileName(title, artist)
      const f = path.join(dir, name)
      const tmp = f + '.tmp-' + (opts.pid || process.pid)
      io.writeFileSync(tmp, JSON.stringify(entry), { mode: 0o600 })
      io.renameSync(tmp, f)
      return prune(dir, max, io, name)
    },
    /** Forget this song (forget-song.js): its notes, expression, refine and re-learn state, partial parts and failure
     * marker all live in its one file. -> whether there was one. error: PASSES-ON — a failed removal throws to main */
    forget(title, artist) {
      const f = file(title, artist)
      if (!io.existsSync(f)) return false
      io.unlinkSync(f)
      return true
    },
    /** A failed notes step for these lyrics: counted, so the song is tried again at most MAX_TRIES times. */
    failed(title, artist, lyricsHash, code) {
      const old = this.get(title, artist)
      // a song that has its notes for these lyrics keeps them: a later pass (Expressive words' measuring) that
      // fails only counts its tries beside them (before 0.15.57 the marker replaced good notes, so the band
      // fell back to the first play's pitch line and the song was recorded again on every play)
      if (old && !old.failed && old.lyricsHash === lyricsHash && Array.isArray(old.notes)) {
        const r = old.retry && typeof old.retry === 'object' ? old.retry : null
        return this.set(title, artist, Object.assign({}, old, { retry: { failed: String(code || 'error').slice(0, 40), tries: (r && r.tries ? r.tries : 0) + 1 } }))
      }
      const tries = old && old.failed && old.lyricsHash === lyricsHash ? (old.tries || 1) + 1 : 1
      return this.set(title, artist, { format: 1, lyricsHash, failed: String(code || 'error').slice(0, 40), tries })
    },
    /** Whether a later pass on a song that has its notes may run again: no failed retry, or fewer than MAX_TRIES (no pitch model: always). */
    retryAllowed(title, artist) {
      const e = this.get(title, artist)
      const r = e && e.retry
      return !r || r.failed === 'no-model' || (r.tries || 0) < MAX_TRIES
    },
    /** Whether a song still needs its notes worked out: no entry for these lyrics, or a failure tried fewer than MAX_TRIES times. */
    missing(title, artist, lyricsHash) {
      const e = this.get(title, artist)
      if (!e || e.lyricsHash !== lyricsHash) return true
      // no pitch model isn't the song's fault (main's notes switch downloads it and keeps notes jobs off until then):
      // tried again, also for markers written before 0.15.57 (they kept such a song from ever getting its notes)
      if (e.failed === 'no-model') return true
      if (e.failed) return (e.tries || 1) < MAX_TRIES
      // the notes of the parts a play heard before it was left (main's firstPlayUnfinished): still to learn whole
      // (a partial entry whose whole-song pass failed counts its tries like a failure: retry beside its notes)
      if (e.partial) return !(e.retry && e.retry.failed !== 'no-model' && (e.retry.tries || 0) >= MAX_TRIES)
      return false
    }
  }
}

module.exports = { DIR_NAME, MAX_FILES, MAX_TRIES, fileName, createSheetNotesStore }
