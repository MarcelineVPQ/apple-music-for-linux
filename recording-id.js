// Which recording a cached lyrics / timing entry belongs to (0.15.42).
//
// Up to 0.15.41 every entry in the lyrics store was keyed `title|artist` and never checked the song's
// length, so a live recording titled like the studio one (or two live albums' "Iris (Live)") would reuse
// the other recording's lyrics timing, precise word times and learned words. Now:
//
// - The recording's identity is its ISRC (from Apple's catalog attributes of the playing item, no extra
//   request): new entries are keyed `isrc:<ISRC>` (with the store's prefix: `aligned|isrc:…`,
//   `refined|isrc:…`). The same recording on another album (a compilation) has the same ISRC and shares
//   the entry; two recordings never share one, whatever their titles.
// - `title|artist` stays as the key only when the ISRC is unknown (a library upload, LRCLIB-only).
// - Every entry carries the recording's length (`songDuration`, s), its `isrc` and Apple `appleId`; an
//   entry whose length differs from the playing song's by more than DURATION_TOLERANCE_S is not used,
//   even under the same ISRC (a remaster or edit can keep the ISRC with another length).
// - Entries from before 0.15.42 (no songDuration) are adopted on their song's next play: used as they
//   are when the title has no live/alternate mark; a marked title ("(Live)", "Acoustic", "Remix"…) is
//   ambiguous (two live albums both name it "Iris (Live)"), so such an entry is used only when the
//   caller re-validates it (timingMatches: the stored word times start where this recording's lyric
//   lines start). With an ISRC known, an adopted entry moves to the ISRC key and the old key becomes an
//   alias ({ alias, isrc, songDuration }) so nothing is fetched or aligned again.
//
// Electron-free, tested in test/recording-id.test.js.
// lyrics-sources.js requires this module, so its isLive is read at call time (no load-order cycle)
const isLive = (title, album) => require('./lyrics-sources').isLive(title, album)

// Tolerance for "the same recording" by length (s). From Marcy's library (Apple catalog lengths,
// 2026-10-17): one recording on several albums differs by ≤ 0.79 s (Blondie "Dreaming" 188.13 /
// 188.49 / 188.92 s; Goo Goo Dolls "Iris" 289.47-289.91; DMB "Stay" 335.23 / 335.78; "Crush" 488.76 /
// 489.33), while two live recordings of one song were 2.2 s apart at the closest (DMB "Halloween",
// Gorge 356.03 vs Las Vegas 353.79) and studio vs live usually tens of seconds. 1.5 s keeps every copy of
// one recording (about 2x the largest spread) and refuses the closest live pair. An absolute bound, not a
// percentage: 1.5 % of a 7-minute live jam would be 6 s. Some recordings can't be told apart by length at
// all (DMB "Pig" studio 417.67 vs a live cut 417.05; Bowie "Afraid" 207.80 vs live 208.40): that is
// what the ISRC and the title marks are for.
const DURATION_TOLERANCE_S = 1.5
// Re-validating an old entry by its timing: a line "matches" when the stored first-word time is within
// TIMING_NEAR_S of the line's start in this recording's lyrics; the entry is the same recording when
// at least TIMING_SAME_SHARE of its lines match. Her 90 aligned entries against their own lyrics: the
// lowest share is 0.79 (p99 offset 1.86 s); the studio entry against the Gorge live lyrics (and back):
// 0.00-0.30 for all 6 DMB pairs she has both of. Her 21 refined entries hold 1-8 lines (a share of
// 0.6 of 1-2 lines means all of them); all 4 of a marked title match their own lyrics.
const TIMING_NEAR_S = 2
const TIMING_SAME_SHARE = 0.6

/** An ISRC in its canonical 12-character form (dashes dropped, upper case), or ''. */
function normIsrc(v) {
  const s = String(v || '').toUpperCase().replace(/[^A-Z0-9]/g, '')
  return /^[A-Z]{2}[A-Z0-9]{3}\d{7}$/.test(s) ? s : ''
}

// Lyrics timed for another version (0.15.47, Marcy 2026-10-18: Mad Season "I Don't Wanna Be a Soldier (Live
// At the Moore)", 557.1 s, got an LRCLIB record whose line times end at 359.2 s: someone uploaded the 352 s
// studio LRC under a 557 s entry, so LRCLIB's own duration matches and the lookup's ±5 s length filter can't
// see it; the highlight ran 4-5 lines behind and the later sections were rejected inside the wrong windows).
// The rule (timingMismatch), conservative on purpose: a false positive hides good timing on the first play.
// Only line-synced LRCLIB lyrics are judged: Apple's own timing for Apple's lyrics of this recording is
// never discarded (her Apple lyrics include a 1,016 s track whose singing ends at 22 %).
//   runs-past-end  the last line starts more than PAST_END_S after the recording ends: timed for a longer
//                  version (no recording sings after its own end)
//   ends-early     the recording is marked live or alternate (variantTitle, or a live album) and its lyrics
//                  end (last line's end) more than EARLY_MARGIN_S before EARLY_SHARE of its length: timed for
//                  a shorter version. Only for marked recordings: a studio song with a long instrumental coda
//                  (Layla's piano coda, Free Bird's solo: the singing ends at ~45-55 %) is normal, and the
//                  lookup already refuses LRCLIB records of another length or another kind (live vs studio).
//                  This song: 359.2 + 20 = 379.2 s < 0.75 × 557.1 = 417.8 s.
// Her 27 cached lyrics with a known length (2026-10-18): only this song trips it (64 %); the next lowest
// LRCLIB one is at 91 %. LRCLIB's own `duration` is not a separate test: the lookup already takes only
// records within 5 s of the recording (lyrics-sources pickHit; get-cached matches ±2 s itself), and this
// record claims the right length. A low alignment confidence is not one either: here 22 of 32 lines still
// passed inside the wrong windows, while hard-to-hear singing can reject many lines of a right LRC.
const MIN_JUDGED_S = 120
const PAST_END_S = 5
const EARLY_MARGIN_S = 20
const EARLY_SHARE = 0.75

/**
 * Whether lyric lines' timing fits the recording. lines: the lyric lines [{ t, end?, text }]; rec:
 * { source, duration, title, album }. -> null (fits, or nothing to judge) or
 * { reason: 'runs-past-end' | 'ends-early', lyricsEnd (s), duration (s), share (lyricsEnd / duration) }
 */
function timingMismatch(lines, rec) {
  const r = rec || {}
  const duration = Number(r.duration)
  if (r.source !== 'lrclib' || !(duration >= MIN_JUDGED_S) || !Array.isArray(lines)) return null
  const timed = lines.filter((l) => l && Number.isFinite(l.t) && String(l.text || '').trim())
  if (!timed.length || timed.some((l) => Array.isArray(l.words) && l.words.length)) return null   // word-timed LRC: not judged
  const last = timed[timed.length - 1]
  const lyricsEnd = Number.isFinite(last.end) ? last.end : last.t
  const out = (reason) => ({ reason, lyricsEnd: Math.round(lyricsEnd * 100) / 100, duration: Math.round(duration * 100) / 100, share: Math.round((lyricsEnd / duration) * 100) / 100 })
  if (last.t > duration + PAST_END_S) return out('runs-past-end')
  const marked = variantTitle(r.title) || isLive('', r.album)
  if (marked && lyricsEnd + EARLY_MARGIN_S < EARLY_SHARE * duration) return out('ends-early')
  return null
}

/** The recording facts of a now-playing state: { title, artist, isrc, duration, appleId }. */
function songOf(state) {
  const s = state || {}
  const d = Number(s.duration)
  return {
    title: String(s.title || ''), artist: String(s.artist || ''), isrc: normIsrc(s.isrc),
    duration: Number.isFinite(d) && d > 0 ? d : 0, appleId: s.appleId ? String(s.appleId) : ''
  }
}

function legacyKey(song) { return song.title + '|' + song.artist }
/** The key new entries are written under (without the store's prefix). */
function recordingKey(song) { return song.isrc ? 'isrc:' + song.isrc : legacyKey(song) }
/** One playing recording, for "is this a new song?" checks: studio and live with one title differ. */
function trackKey(song) {
  return legacyKey(song) + '|' + (song.isrc || (song.duration ? '~' + Math.round(song.duration) : ''))
}

// a title's qualifiers: (…) and […] parts and what follows " - "
const QUALIFIERS = /[([]([^)\]]*)[)\]]|\s[-–—]\s+(.*)$/g
const ALTERNATE = /\b(acoustic|unplugged|demo|re-?mix|mix|remaster(ed)?|edit|version|instrumental|session|take|mono|stereo|karaoke|a cappella|sped up|slowed|reprise|rehearsal|outtake)\b/i
/** A title marked as a live or alternate recording ("(Live)", "Live at …", "(Acoustic)", "[2025 Remaster]"). */
function variantTitle(title) {
  const t = String(title || '')
  if (isLive(t, '')) return true
  // loop: NOT-WORTH — a title's 0-3 bracketed parts, once per lookup
  for (const m of t.matchAll(QUALIFIERS)) if (ALTERNATE.test(m[1] || m[2] || '')) return true
  return false
}

/** Same length within the tolerance; true when either is unknown (nothing to compare). */
function durationFits(stored, playing) {
  if (!(stored > 0) || !(playing > 0)) return true
  return Math.abs(stored - playing) <= DURATION_TOLERANCE_S
}

/** value with the recording's facts (only the known ones; an entry's own facts are kept). */
function stamp(value, song) {
  if (!value || typeof value !== 'object') return value
  const out = Object.assign({}, value)
  if (song.duration && !(out.songDuration > 0)) out.songDuration = Math.round(song.duration * 1000) / 1000
  if (song.isrc && !out.isrc) out.isrc = song.isrc
  if (song.appleId && !out.appleId) out.appleId = song.appleId
  return out
}

/**
 * Old-entry re-validation by timing: entryLines { index: { words: [{ t }] } } (aligned or refined)
 * against this recording's lyric lines [{ t }]. true when enough lines start where the stored words do.
 */
function timingMatches(entryLines, rawLines) {
  if (!entryLines || typeof entryLines !== 'object' || !Array.isArray(rawLines)) return false
  let n = 0
  let near = 0
  // loop: NOT-WORTH — the entry's lines (≤ ~150), once per old entry on its first play after the update
  for (const [k, a] of Object.entries(entryLines)) {
    const w = a && Array.isArray(a.words) ? a.words[0] : null
    const line = rawLines[Number(k)]
    if (!w || !Number.isFinite(w.t) || !line || !Number.isFinite(line.t)) continue
    n++
    if (Math.abs(w.t - line.t) <= TIMING_NEAR_S) near++
  }
  return n > 0 && near / n >= TIMING_SAME_SHARE
}

/**
 * The stored entry for this recording, or null. store: { get(k), set(k, v) }; prefix: '' (lyrics),
 * 'aligned|', 'refined|'. opts.check(entry) -> bool re-validates an old entry of a marked title (default:
 * refuse); opts.write === false never writes (readers like the booklet). -> { entry, key, how }:
 * key is where this recording's entry is (or will be) written; how: 'isrc' | 'legacy' | 'alias' |
 * 'migrated' | 'none' | 'other-isrc' | 'duration' | 'unverified'.
 */
function lookup(store, prefix, song, opts = {}) {
  const write = opts.write !== false
  const miss = (how) => ({ entry: null, key: prefix + recordingKey(song), how })
  if (song.isrc) {
    const e = store.get(prefix + 'isrc:' + song.isrc)
    if (e && !e.alias) return durationFits(e.songDuration, song.duration) ? { entry: e, key: prefix + 'isrc:' + song.isrc, how: 'isrc' } : miss('duration')
  }
  const lk = prefix + legacyKey(song)
  let e = store.get(lk)
  let key = lk
  let how = 'legacy'
  if (e && e.alias) {
    if (song.isrc && e.isrc && e.isrc !== song.isrc) return miss('other-isrc')
    if (!durationFits(e.songDuration, song.duration)) return miss('duration')
    key = String(e.alias)
    e = store.get(key)
    if (!e || e.alias) return miss('none')
    how = 'alias'
  }
  if (!e) return miss('none')
  if (song.isrc && e.isrc && e.isrc !== song.isrc) return miss('other-isrc')   // never across ISRCs
  if (e.songDuration > 0) {
    if (!durationFits(e.songDuration, song.duration)) return miss('duration')
  } else if (variantTitle(song.title) && !(opts.check && opts.check(e))) return miss('unverified')
  if (!write) return { entry: e, key, how }
  if (song.isrc && how === 'legacy') {
    // adopt: the entry moves to the ISRC, the old key points at it
    const moved = stamp(e, song)
    const to = prefix + 'isrc:' + song.isrc
    store.set(to, moved)
    store.set(lk, { alias: to, isrc: song.isrc, songDuration: moved.songDuration || 0 })
    return { entry: moved, key: to, how: 'migrated' }
  }
  if (!(e.songDuration > 0) && song.duration) {
    e = stamp(e, song)
    store.set(key, e)
  }
  return { entry: e, key, how }
}

/** Writes value for this recording at key (from lookup), stamped with the recording's facts. */
function put(store, key, value, song) { store.set(key, stamp(value, song)) }

module.exports = {
  DURATION_TOLERANCE_S, TIMING_NEAR_S, TIMING_SAME_SHARE, MIN_JUDGED_S, PAST_END_S, EARLY_MARGIN_S, EARLY_SHARE,
  timingMismatch, normIsrc, songOf, legacyKey, recordingKey, trackKey, variantTitle, durationFits, stamp, timingMatches, lookup, put
}
