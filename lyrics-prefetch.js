// Lyrics for the songs coming up in Up Next, looked up quietly while a song plays, so they're ready
// (and on disk, lyrics-cache.json) before they play. Lyrics text only: no audio, no helper, no alignment.
// Pure logic with injected I/O (main.js wires it); test/lyrics-prefetch.test.js.
//
// Gentle by design: one lookup at a time, PREFETCH_GAP_MS apart, only after the playing song's own
// lyrics are in; paused while LRCLIB is failing (lyrics-sources retryPlan waits, at least
// PREFETCH_PAUSE_MIN_MS), offline, or while the gaming guard pauses heavy work. Every lookup goes
// through the same resolver as a play (Apple first, then LRCLIB when on), so it's stored under the
// same recording keys.

const R = require('./recording-id')
const { retryPlan } = require('./lyrics-sources')

const PREFETCH_COUNT = 3          // the next songs looked up
const PREFETCH_ALBUM_MAX = 12     // when the next songs are the playing album's: the rest of it, up to this
const PREFETCH_GAP_MS = 4000      // between two lookups
const PREFETCH_PAUSE_MIN_MS = 30 * 1000   // the shortest pause after LRCLIB failed

// a stored entry that a play would use as is (lyrics, or an instrumental verdict)
function isStored(store, item, lrclibOn) {
  if (!store) return false
  const e = R.lookup(store, '', R.songOf(item), { write: false }).entry
  if (!e) return false
  if (e.lines && e.lines.length) return e.source !== 'lrclib' || lrclibOn
  return !!e.instrumental
}

/**
 * The songs to look up, in queue order: the next PREFETCH_COUNT, or, while the next songs are the
 * playing one's album, that album's remaining songs (up to PREFETCH_ALBUM_MAX); untitled ones and
 * ones already stored left out. current: the playing song; upcoming: the queue after it.
 */
function plan(current, upcoming, isCached) {
  const list = Array.isArray(upcoming) ? upcoming.slice(0, PREFETCH_ALBUM_MAX) : []
  const album = current && current.album
  let run = 0
  // loop: NOT-WORTH — at most PREFETCH_ALBUM_MAX (12) queue items, once per song
  while (album && run < list.length && list[run].album === album && list[run].artist === current.artist) run++
  const n = Math.max(PREFETCH_COUNT, run)
  return list.slice(0, n).filter((it) => it && it.title && !isCached(it))
}

// result -> the log word
function outcome(got) {
  if (got.instrumental) return 'instrumental'
  if (got.lines && got.lines.length) return got.source === 'apple' ? 'apple' : 'lrclib'
  return 'none'
}

// lifetime: OK — a one-shot wait between two lookups, settled after ms (nothing holds it)
const realSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * deps: { readQueue() -> Promise<[item]> (the songs after the playing one), getLyrics(item) -> result
 * (lyrics-sources createLyricsResolver), isCached(item) -> bool, online() -> bool, paused() -> bool,
 * log(msg), sleep?(ms), now?() }. item: { title, artist, album, duration, isrc, appleId }.
 * run(current): look ahead from this song (a newer call replaces an older one between lookups).
 */
function createPrefetcher(deps) {
  const sleep = deps.sleep || realSleep
  const now = deps.now || Date.now
  let want = null           // the song to look ahead from next
  let working = null        // the worker's promise while it runs
  let failStreak = 0        // LRCLIB failures in a row
  let pausedUntil = 0

  const blocked = () => now() < pausedUntil || !deps.online() || deps.paused()

  async function work() {
    // loop: SERIAL-REQUIRED — one look-ahead at a time; a newer song replaces the older between lookups
    while (want) {
      const current = want
      want = null
      if (blocked()) return
      let upcoming = []
      try { upcoming = await deps.readQueue() } catch (e) { return /* error: NOT-WORTH — no queue yet (page loading): nothing to look up; the next song tries again */ }
      // loop: SERIAL-REQUIRED — one lookup at a time, PREFETCH_GAP_MS apart (gentle on LRCLIB); at most 12 songs
      for (const item of plan(current, upcoming, deps.isCached)) {
        await sleep(PREFETCH_GAP_MS)   // spaced from the playing song's own lookup and from each other
        if (want || blocked()) break
        const got = await deps.getLyrics(item)
        if (got.error === 'lrclib') {
          failStreak++
          pausedUntil = now() + Math.max(PREFETCH_PAUSE_MIN_MS, retryPlan('lrclib', failStreak) || 120 * 1000)
          deps.log('lyrics: prefetch paused, LRCLIB failing (' + ((got.lrclib && got.lrclib.message) || 'error') + ')')
          break
        }
        if (got.error) break   // Apple's lookup failed (page busy): the next song tries again
        failStreak = 0
        deps.log('lyrics: prefetched "' + item.title + '" (' + outcome(got) + ')')
      }
    }
  }

  function run(current) {
    want = current
    if (!working) {
      working = work().finally(() => { working = null })
    }
    return working
  }

  return { run, get pausedUntil() { return pausedUntil } }
}

module.exports = { PREFETCH_COUNT, PREFETCH_ALBUM_MAX, PREFETCH_GAP_MS, PREFETCH_PAUSE_MIN_MS, isStored, plan, outcome, createPrefetcher }
