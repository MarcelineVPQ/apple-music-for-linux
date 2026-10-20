// Forget this song (Development builds, 0.15.74, Marcy 2026-10-19): the song's ⋯ menu (mini player and Studio) asks
// to forget what Sonata LEARNED for the recording, so its next play is a first play again (a deliberate retest):
//   - word timing aligned on this PC ('aligned|' entries) and refined by listening ('refined|'),
//   - the sheet-notes store's file: notes, Expressive words, refine history and settled state, partial parts,
//     re-learn counters and failure markers,
//   - (main) the play under way: the align and listen sessions stop learning it, the helper drops the sections it
//     kept, the first play's parts and the refine state in memory; look-ahead decides from the stores, so the next
//     play reads "first" by itself.
// Confirmed in the item's own submenu: the question, then "Forget what it learned" or "Forget it and the lyrics too"
// (the lyrics text is kept unless that second answer is chosen; '' entries, fetched again on the next play).
// Electron-free: test/forget-song.test.js.
'use strict'
const R = require('./recording-id')

const LABEL = 'Forget this song…'   // the one label, in every menu that offers it
const PREFIXES = ['aligned|', 'refined|']
const LYRICS_PREFIX = ''

/** The confirmation submenu's words (one for every menu that offers the action). */
function confirmText(title) {
  return {
    message: 'Forget what Sonata learned about “' + (title || 'this song') + '”?',
    detail: 'The next play will be a first play.',
    ok: 'Forget what it learned',
    okLyrics: 'Forget it and the lyrics too'
  }
}

/** The log line after a forget. */
function logLine(title, out) {
  return 'forgot "' + (title || '') + '" for a fresh first play (' + out.removed.length + ' stored entr' + (out.removed.length === 1 ? 'y' : 'ies') + (out.notes ? ', its notes' : '') + (out.lyrics ? ', its lyrics' : '') + ')'
}

/**
 * Every store key of this recording under the given prefixes: its legacy title|artist key, the key an alias there
 * points to, and its ISRC key (from the song, else from any of its entries).
 * store: { peek(key) }; song: { title, artist, isrc? }
 */
function songKeys(store, song, prefixes) {
  const legacy = R.legacyKey(song)
  const isrcs = new Set(song.isrc ? [song.isrc] : [])
  const keys = new Set()
  // loop: NOT-WORTH — three prefixes, once per forget
  for (const p of prefixes) {
    const e = store.peek(p + legacy)
    if (!e) continue
    keys.add(p + legacy)
    if (e.alias) keys.add(String(e.alias))
    if (e.isrc) isrcs.add(e.isrc)
  }
  // loop: NOT-WORTH — three prefixes x the recording's ISRCs (one), once per forget
  for (const p of prefixes) for (const i of isrcs) if (store.peek(p + 'isrc:' + i)) keys.add(p + 'isrc:' + i)
  return [...keys]
}

/**
 * Removes what was learned for the song (and its lyrics when asked). -> { removed: [keys], notes: bool, lyrics: bool }
 * deps: { lyricsStore: { peek, remove }, sheetStore: { forget } | null }; song: { title, artist, isrc? }
 * error: PASSES-ON — a store that throws (the sheet file can't be removed) throws to main, which shows it
 */
function forgetStored(deps, song, opts = {}) {
  const prefixes = opts.lyrics ? PREFIXES.concat([LYRICS_PREFIX]) : PREFIXES
  const keys = deps.lyricsStore ? songKeys(deps.lyricsStore, song, prefixes) : []
  // loop: NOT-WORTH — the song's few keys, once per forget
  const removed = keys.filter((k) => deps.lyricsStore.remove(k))
  const notes = deps.sheetStore ? deps.sheetStore.forget(song.title, song.artist) : false
  return { removed, notes, lyrics: !!opts.lyrics && removed.some((k) => !PREFIXES.some((p) => k.startsWith(p))) }
}

module.exports = { LABEL, PREFIXES, confirmText, logLine, songKeys, forgetStored }
