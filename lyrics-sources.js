// Lyrics sources: Apple's TTML (through the page's MusicKit session) and
// LRCLIB (lrclib.net, a free open lyrics database) as a fallback.
// Pure functions with injected I/O so they can be tested without Electron.

function parseTtmlClock(value) {
  value = value.trim()
  if (!value.includes(':')) return parseFloat(value) || 0
  return value.split(':').reduce((total, part) => total * 60 + (parseFloat(part) || 0), 0)
}

const ENTITIES = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&apos;': "'" }
function decodeEntities(s) {
  return s.replace(/&(amp|lt|gt|quot|#39|apos);/g, (m) => ENTITIES[m])
}

// One tag's attributes -> { name: value }, prefixes kept ('ttm:agent', 'xml:id').
function tagAttrs(tag) {
  const attrs = {}
  // loop: NOT-WORTH — a tag's few attributes, while parsing a song's lyrics (once per song)
  for (const m of tag.matchAll(/([\w:.-]+)\s*=\s*"([^"]*)"/g)) attrs[m[1]] = m[2]
  return attrs
}

/** The lyrics language of a TTML document (<tt xml:lang="en">), '' when it has none. */
function ttmlLang(ttml) {
  const m = /<tt\b[^>]*>/.exec(ttml || '')
  return m ? (tagAttrs(m[0])['xml:lang'] || '') : ''
}

/**
 * The song's writers from Apple's TTML head (<iTunesMetadata><songwriters><songwriter>Name</songwriter>…),
 * in Apple's order; [] when the document has none. Checked against 291 real Apple TTML responses
 * (2026-10-17): 290 carry the list, one has an empty <iTunesMetadata> (no songwriters element).
 */
function ttmlSongwriters(ttml) {
  const head = /<songwriters\b[^>]*>([\s\S]*?)<\/songwriters>/.exec(ttml || '')
  if (!head) return []
  // loop: NOT-WORTH — the song's writers (1-10), once per song
  return [...head[1].matchAll(/<songwriter\b[^>]*>([\s\S]*?)<\/songwriter>/g)]
    .map((m) => decodeEntities(m[1].replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim())
    .filter(Boolean)
}

// <ttm:agent xml:id="v1" type="person"/> -> { v1: 'person' }
function ttmlAgents(ttml) {
  const agents = {}
  // loop: NOT-WORTH — the song's singers (1-3), once per song
  for (const m of ttml.matchAll(/<ttm:agent\b[^>]*>/g)) {
    const a = tagAttrs(m[0])
    if (a['xml:id']) agents[a['xml:id']] = a.type || 'person'
  }
  return agents
}

// One <p>'s inner markup -> timed spans ("syllables") per track, main and background
// (inside <span ttm:role="x-bg">). newWord marks whitespace before the syllable: adjacent
// spans with nothing between them are syllables of one word.
function ttmlSyllables(inner) {
  const out = { main: [], bg: [] }
  const stack = []                        // open spans: { bg, timed }
  let cur = null                          // timed span collecting text
  const gap = { main: true, bg: true }    // whitespace since the last syllable, per track
  // loop: NOT-WORTH — the spans of one line, once per song
  for (const m of inner.matchAll(/<(\/?)([\w:]+)([^>]*)>|([^<]+)/g)) {
    if (m[4] !== undefined) {
      const text = decodeEntities(m[4])
      if (cur) cur.text += text
      else if (/\s/.test(text)) gap.main = gap.bg = true
      continue
    }
    const [, close, name, rest] = m
    if (name === 'br') { gap.main = gap.bg = true; continue }
    if (name !== 'span') continue
    if (close) {
      const top = stack.pop()
      if (top && top.timed && cur) {
        if (/\s$/.test(cur.text)) gap[cur.track] = true
        cur = null
      }
      continue
    }
    if (/\/\s*$/.test(rest)) continue      // <span/>: nothing to show
    const a = tagAttrs(rest)
    const isBg = a['ttm:role'] === 'x-bg'
    const inBg = isBg || stack.some((s) => s.bg)
    const timed = !isBg && a.begin !== undefined
    stack.push({ bg: isBg, timed })
    if (timed) {
      const track = inBg ? 'bg' : 'main'
      cur = { t: parseTtmlClock(a.begin), end: a.end !== undefined ? parseTtmlClock(a.end) : null, text: '', track, newWord: gap[track] }
      out[track].push(cur)
      gap[track] = false
    }
  }
  return out
}

// Syllables -> words [{ t, end, text, syl? }]. everySpan: treat each span as a word (documents that
// never put whitespace between spans). A word built from several spans keeps them as
// syl [{ t, end, text }] (the karaoke syllable pop); their texts join to the word's text.
function mergeSyllables(syllables, everySpan) {
  const words = []
  const parts = []                        // per word: its syllable spans
  // loop: NOT-WORTH — one line's syllables and words (tens), once per song
  for (const s of syllables) {
    if (!s.text.trim()) continue
    const last = words[words.length - 1]
    if (last && !s.newWord && !/^\s/.test(s.text) && !everySpan) {
      last.text += s.text
      if (s.end !== null) last.end = Math.max(last.end === null ? s.end : last.end, s.end)
      parts[parts.length - 1].push(s)
    }
    else { words.push({ t: s.t, end: s.end, text: s.text }); parts.push([s]) }
  }
  // loop: NOT-WORTH — the line's words, twice, once per song
  for (const w of words) w.text = w.text.replace(/\s+/g, ' ').trim()
  for (let i = 0; i < words.length; i++) {
    if (words[i].end === null) words[i].end = i + 1 < words.length ? words[i + 1].t : words[i].t + 1
    const p = parts[i]
    if (p.length < 2) continue
    const syl = p.map((s, j) => ({ t: s.t, end: s.end !== null ? s.end : j + 1 < p.length ? p[j + 1].t : words[i].end, text: s.text.trim() }))
    // only when the syllables spell the word exactly (no inner spaces), so the view can't drift
    if (syl.map((x) => x.text).join('') === words[i].text) words[i].syl = syl
  }
  return words
}

/**
 * Apple TTML -> lines [{ t, end?, text, agent?, words?, bg? }]. end comes from the <p>;
 * agent is the singer id ('v1', 'v2'…) or 'group' (v1000 or a type="group" agent);
 * words / bg are [{ t, end, text, syl? }] and only present for word-timed ("syllable") lyrics;
 * syl: the word's syllables [{ t, end, text }] when Apple timed it in more than one span.
 * Line-only TTML gives { t, end, text } as before.
 */
function parseTtml(ttml) {
  const agents = ttmlAgents(ttml)
  const raw = []
  const re = /<p\b([^>]*)>([\s\S]*?)<\/p>/g
  let match
  // loop: NOT-WORTH — the song's lines (tens to ~100), once per song
  while ((match = re.exec(ttml))) {
    const attrs = tagAttrs(match[1])
    if (attrs.begin === undefined) continue
    raw.push({ attrs, inner: match[2], syl: ttmlSyllables(match[2]) })
  }
  // whitespace between spans separates words; a document without any is word-per-span
  const multi = raw.filter((r) => r.syl.main.length > 1)
  const everySpan = multi.length > 0 && !multi.some((r) => r.syl.main.slice(1).some((s) => s.newWord || /^\s/.test(s.text)))
  const lines = []
  // loop: NOT-WORTH — the song's lines, once per song
  for (const { attrs, inner, syl } of raw) {
    const words = mergeSyllables(syl.main, everySpan)
    const bg = mergeSyllables(syl.bg, everySpan)
    let text
    if (words.length) text = words.map((w) => w.text).join(' ')
    else {
      text = decodeEntities(inner.replace(/></g, '> <').replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim()
      if (bg.length) text = ''              // bg-only line: the bg words carry the text
    }
    if (!text && !bg.length) continue
    const line = { t: parseTtmlClock(attrs.begin) }
    if (attrs.end !== undefined) line.end = parseTtmlClock(attrs.end)
    else if (words.length) line.end = words[words.length - 1].end
    line.text = text
    const agent = attrs['ttm:agent']
    if (agent) line.agent = agent === 'v1000' || agents[agent] === 'group' ? 'group' : agent
    if (words.length) line.words = words
    if (bg.length) line.bg = bg
    lines.push(line)
  }
  return lines
}

const LRC_WORD = /<(\d+):(\d+(?:\.\d+)?)>/g

// Enhanced LRC body "<00:12.00>Hello <00:12.50>world <00:13.10>" -> { text, words }.
// A stamp with no text after it ends the word before it.
function lrcWords(body) {
  const stamps = [...body.matchAll(LRC_WORD)]
  if (!stamps.length) return { text: body.trim(), words: null }
  const words = []
  const lead = body.slice(0, stamps[0].index).trim()
  // loop: NOT-WORTH — one LRC line's word stamps, once per song
  for (let i = 0; i < stamps.length; i++) {
    const m = stamps[i]
    const t = parseInt(m[1], 10) * 60 + parseFloat(m[2])
    const prev = words[words.length - 1]
    if (prev && prev.end === null) prev.end = t
    const seg = body.slice(m.index + m[0].length, i + 1 < stamps.length ? stamps[i + 1].index : body.length).replace(/\s+/g, ' ').trim()
    if (seg) words.push({ t, end: null, text: seg })
  }
  const text = [lead, ...words.map((w) => w.text)].filter(Boolean).join(' ')
  return { text, words: words.length ? words : null }
}

// "[01:02.50] text" (several stamps per line allowed) -> [{ t, end?, text, words? }].
// Empty "[mm:ss.xx]" lines mark an instrumental break: they set the end of the line before.
// Enhanced LRC "<mm:ss.xx>" word stamps become words.
function parseLrc(lrc) {
  const entries = []
  // loop: NOT-WORTH — the LRC file's lines and their stamps (tens to ~100), once per song
  for (const raw of String(lrc || '').split(/\r?\n/)) {
    const stamps = [...raw.matchAll(/\[(\d+):(\d+(?:\.\d+)?)\]/g)]
    if (!stamps.length) continue
    const { text, words } = lrcWords(raw.replace(/\[[^\]]*\]/g, ''))
    const first = parseInt(stamps[0][1], 10) * 60 + parseFloat(stamps[0][2])
    for (const m of stamps) {
      const t = parseInt(m[1], 10) * 60 + parseFloat(m[2])
      if (!text) { entries.push({ t, gap: true }); continue }
      const line = { t, text }
      const shift = t - first
      if (words) line.words = words.map((w) => ({ t: w.t + shift, end: w.end === null ? null : w.end + shift, text: w.text }))
      entries.push(line)
    }
  }
  entries.sort((a, b) => a.t - b.t)
  const lines = []
  // loop: NOT-WORTH — the entries once per song; the inner search stops at the first later stamp (usually the next)
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i]
    if (e.gap) continue
    let next = null
    for (let j = i + 1; j < entries.length && !next; j++) if (entries[j].t > e.t) next = entries[j]
    if (e.words) {
      const last = e.words[e.words.length - 1]
      if (last.end === null) last.end = Math.min(last.t + 1, next ? next.t : Infinity)
      // loop: NOT-WORTH — one line's words, once per song
      for (let k = 0; k < e.words.length - 1; k++) if (e.words[k].end === null) e.words[k].end = e.words[k + 1].t
      e.end = last.end
    }
    else if (next && next.gap) e.end = next.t
    lines.push(e.words ? { t: e.t, end: e.end, text: e.text, words: e.words } : e)
  }
  return lines
}

// One LRCLIB record -> lines. Unsynced lyrics get t: null.
function lrclibLines(hit) {
  if (!hit || hit.instrumental) return []
  if (hit.syncedLyrics) {
    const lines = parseLrc(hit.syncedLyrics)
    if (lines.length) return lines
  }
  if (hit.plainLyrics) {
    return hit.plainLyrics.split(/\r?\n/).map((t) => t.trim()).filter(Boolean).map((text) => ({ t: null, text }))
  }
  return []
}

// Apple album names carry " - EP" / " - Single"; LRCLIB's usually don't.
function cleanAlbum(album) {
  return String(album || '').replace(/ - (EP|Single)$/i, '').trim()
}

// A live recording's marker in a title or album: "(Live)", "[Live at …]", " - Live", an album "Live at the
// Gorge" or "Live" (not a title like "Live Forever" or "We Live in Fear").
const LIVE = /[([]\s*live\b|\s[-–—]\s*live\b|^live(?:\s+(?:at|in|from|on)\b|\s*$)/i
function isLive(title, album) { return LIVE.test(String(title || '')) || LIVE.test(String(album || '')) }

// a synced hit's lines as plain text (its timing is for another recording)
function asPlain(hit) {
  const text = hit.plainLyrics || parseLrc(hit.syncedLyrics || '').map((l) => l.text).filter(Boolean).join('\n')
  return text ? Object.assign({}, hit, { syncedLyrics: null, plainLyrics: text }) : null
}

// a search hit "close in length" to the playing recording (s)
const HIT_NEAR_S = 5

// --- instrumentals (Marcy 2026-10-18, Mad Season "November Hotel (Live At the Moore)": "there are millions of
// instrumental tracks in the world"). "Instrumental" is said only with evidence: LRCLIB's own instrumental
// flag on a hit for this recording, or the title's own marker. Apple having no lyrics is not evidence. Lyrics
// from any source always win. (The engine can't report "no vocals heard" yet: sonata-engine BACKLOG.) ---

// the title's own marker: "(Instrumental)", "[Instrumental Version]", "(Live Instrumental)", " - Instrumental"
const INSTRUMENTAL_TITLE = /[([][^)\]]*\binstrumentals?\b[^)\]]*[)\]]|\s[-–—]\s+(?:[^-–—]*\s)?instrumentals?\b[^-–—]*/i
/** The title's instrumental marker ("(Instrumental)"…), or '' when it has none. */
function instrumentalTitle(title) {
  const m = INSTRUMENTAL_TITLE.exec(String(title || ''))
  return m ? m[0].trim().replace(/^[-–—]\s*/, '') : ''
}
// a title without its qualifiers ("(Live At the Moore)", " - 2013 Remaster"), lower case, punctuation as spaces
const QUALIFIERS = /[([][^)\]]*[)\]]|\s[-–—]\s+.*$/g
const plainName = (s) => String(s || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
const baseTitle = (t) => plainName(String(t || '').replace(QUALIFIERS, ' '))
// one artist: the same name, or one name followed by a featured / joined artist ("Mad Season feat. …")
function sameArtist(a, b) {
  const x = plainName(a)
  const y = plainName(b)
  return !!x && !!y && (x === y || x.startsWith(y + ' ') || y.startsWith(x + ' '))
}
const hasLyrics = (h) => !!(h && ((h.plainLyrics && h.plainLyrics.trim()) || (h.syncedLyrics && h.syncedLyrics.trim())))

/**
 * LRCLIB's evidence that this recording is instrumental: the hit flagged `instrumental` with the song's
 * title (qualifiers aside) and artist, and the recording's length within HIT_NEAR_S (both lengths known;
 * without them there is no telling which recording it is). A hit whose own title says "(Instrumental)" counts
 * only for a song whose title says so too (else it is another version of a sung song). Any hit of the
 * song (any length) that carries lyrics and isn't itself an instrumental version vetoes it: the song is
 * sung somewhere, so Sonata says less rather than something wrong. -> the hit, or null.
 */
function instrumentalHit(hits, state) {
  const s = state || {}
  const list = (Array.isArray(hits) ? hits : []).filter(Boolean)
  const title = baseTitle(s.title)
  const marked = !!instrumentalTitle(s.title)
  if (!title || !(s.duration > 0)) return null
  const same = list.filter((h) => baseTitle(h.trackName || h.name) === title && sameArtist(h.artistName, s.artist))
  if (same.some((h) => !h.instrumental && hasLyrics(h) && !instrumentalTitle(h.trackName || h.name))) return null
  return same.find((h) => h.instrumental && h.duration > 0 && Math.abs(h.duration - s.duration) <= HIT_NEAR_S &&
    (marked || !instrumentalTitle(h.trackName || h.name))) || null
}

/**
 * Best search hit: close in length (±5 s when both are known), then (with the song's `title`/`album`)
 * the same recording: a live cut takes a hit marked live, a studio cut one that isn't (0.15.39). Synced
 * lyrics only from a hit of the same kind: a live cut gets plain lyrics rather than a synced LRC timed
 * for the studio version (and the other way round), since those stamps would be off all song long.
 */
function pickHit(hits, duration, title, album) {
  return rankHits(hits, duration, title, album)[0] || null
}
/** Every usable hit in pickHit's order of preference (pickHit takes the first). */
function rankHits(hits, duration, title, album) {
  const list = Array.isArray(hits) ? hits : []
  const near = list.filter((h) => h && (!duration || !h.duration || Math.abs(h.duration - duration) <= HIT_NEAR_S))
  if (title == null) return [...near.filter((h) => h.syncedLyrics), ...near.filter((h) => !h.syncedLyrics && h.plainLyrics)]
  const live = isLive(title, album)
  const same = near.filter((h) => isLive(h.trackName || h.name, h.albumName) === live)
  const other = near.filter((h) => !same.includes(h))
  const plain = [...other.filter((h) => h.plainLyrics), ...other.filter((h) => !h.plainLyrics && h.syncedLyrics)].map(asPlain).filter(Boolean)
  return [...same.filter((h) => h.syncedLyrics), ...same.filter((h) => !h.syncedLyrics && h.plainLyrics), ...plain]
}

/**
 * What is wrong with an LRCLIB hit's lines for this recording, or '': 'shorthand' (a marker such as
 * "(repeat all)" stands for sung lines, lyrics-shorthand.js) or the reason its line times are for another
 * version (recording-id timingMismatch). state: { duration, title, album }.
 */
function hitProblem(lines, state) {
  if (!lines || !lines.length) return 'empty'
  const sh = require('./lyrics-shorthand').expandShorthand(lines)
  if (sh && (sh.added || sh.unresolved.length)) return 'shorthand'
  const m = R.timingMismatch(lines, { source: 'lrclib', duration: state.duration, title: state.title, album: state.album })
  return m ? m.reason : ''
}

/**
 * Look a song up on LRCLIB. state: { title, artist, album, duration }.
 * deps.fetch(url, { headers }) -> Response-like { ok, status, json() }.
 * Exact match first (/api/get), then a looser search (/api/search).
 * Throws on network/HTTP errors other than 404 (the error's `status`: the HTTP status, 0 when LRCLIB
 * couldn't be reached), also when the exact lookup failed that way and the search found nothing (not
 * known to have no lyrics, so not "no lyrics").
 */
async function fetchLrclib(state, deps) {
  const headers = { 'User-Agent': deps.userAgent || 'Sonata' }
  const get = async (url) => {
    let res
    try { res = await deps.fetch(url, { headers }) } catch (e) {
      // error: PASSES-ON — offline, DNS, refused: status 0 for the caller's message and retry
      throw Object.assign(new Error('lrclib unreachable: ' + ((e && e.message) || 'network error')), { status: 0 })
    }
    if (res.status === 404) return null
    if (!res.ok) throw Object.assign(new Error('lrclib HTTP ' + res.status), { status: res.status })
    return res.json()
  }
  const base = deps.base || 'https://lrclib.net'
  const q = new URLSearchParams({ track_name: state.title, artist_name: state.artist || '' })
  const album = cleanAlbum(state.album)
  if (album) q.set('album_name', album)
  if (state.duration) q.set('duration', String(Math.round(state.duration)))
  // get-cached checks LRCLIB's own database only (no slow external lookups,
  // which LRCLIB rate-limits); any failure there just moves on to search.
  let lines = []
  let exactFailed = null
  let exact = null
  try {
    exact = await get(base + '/api/get-cached?' + q)
    lines = lrclibLines(exact)
  } catch (e) { exactFailed = e /* error: PASSES-ON — falls through to search; thrown below if that finds nothing */ }
  // a hit written as shorthand or timed for another version (hitProblem): the search's other hits are
  // tried for one that is complete and fits; the first one stays when none is (main.js writes it out / drops
  // its times)
  const problem = lines.length ? hitProblem(lines, state) : ''
  let hits = null
  if (!lines.length || problem) {
    const s = new URLSearchParams({ track_name: state.title, artist_name: state.artist || '' })
    try { hits = await get(base + '/api/search?' + s) } catch (e) {
      // error: PASSES-ON — with a hit in hand, its lines (or its instrumental flag) stand
      if (!lines.length && !instrumentalHit([exact], state)) throw e
    }
    const ranked = rankHits(hits, state.duration, state.title || '', state.album).map(lrclibLines).filter((l) => l.length)
    const good = problem || ranked.length ? ranked.find((l) => !hitProblem(l, state)) : null
    if (good && problem && deps.log) deps.log('lrclib: "' + state.title + '": the first hit was ' + problem + ', took another search hit that fits')
    if (good) lines = good
    else if (!lines.length) lines = ranked[0] || []
  }
  if (!lines.length) {
    // no lyrics: LRCLIB's instrumental flag on a hit for this recording (instrumentalHit) rides on the empty
    // result as `instrumental` { by: 'lrclib', duration } (the hit's length, for the ⓘ)
    const hit = instrumentalHit([exact, ...(Array.isArray(hits) ? hits : [])], state)
    if (hit) return Object.assign([], { instrumental: { by: 'lrclib', duration: hit.duration } })
  }
  if (!lines.length && exactFailed) throw exactFailed
  return lines
}

/**
 * Lyrics for a song: Apple first, then LRCLIB when enabled. Results are
 * cached per recording (recording-id.js trackKey, max 50) so several windows share one lookup;
 * empty results are not cached, so the next play retries.
 * state: { title, artist, album, duration, isrc?, appleId? } (the disk store is keyed by ISRC when known)
 * deps: { fetchApple(state) -> ttml string ('' = Apple has none; throws when the lookup failed),
 *         fetchLrclib(state) -> lines, lrclibEnabled() -> bool, log(msg),
 *         store? ({ get(key), set(key, value) }, on disk), sleep?(ms) (tests) }
 * An Apple lookup that fails is tried again APPLE_RETRY_MS.length times (a page mid-navigation is
 * back within seconds), then LRCLIB (when on) stands in, marked appleFailed and kept off the disk
 * store, so the next play asks Apple again. Neither: error 'apple' (main.js retries a few times).
 * LRCLIB failing (5xx, 429, unreachable): error 'lrclib' with `lrclib` { status, message } and `apple`
 * ('none': Apple has no lyrics for it, 'failed': Apple's lookup failed too); main.js retries (retryPlan).
 * No lyrics anywhere: { lines: [], source: '', none: 'apple' | 'both' } ('both': LRCLIB was asked and had
 * none too). Only that definitive answer is kept in memory (NONE_TTL_MS), never a failure, so a song whose
 * lookup failed is asked again; nothing empty goes to the disk store, except an instrumental verdict.
 * Instrumental (no lyrics on Apple Music or LRCLIB, and evidence that none are sung): { lines: [], source,
 * instrumental: { by: 'lrclib', duration } | { by: 'title', marker } }: LRCLIB's flag on a hit for this
 * recording (fetchLrclib, instrumentalHit), else the title's own marker ("(Instrumental)"; also when LRCLIB
 * is off or failing: no retry, no failure message). Kept in memory and on disk like lyrics (instant next
 * time, LRCLIB not asked again); not stored while Apple's lookup failed (Apple's lyrics would win) or when
 * the title alone stood in for a failed LRCLIB lookup.
 */
// Version of the parsed Apple lyrics in the on-disk store: 2 = words keep their syllables (0.15.25),
// 3 = the lyrics language (xml:lang) is stored too (0.15.26), 4 = the songwriters (<songwriters>) too.
// A stored Apple entry from an older parser is fetched again once (served as is when that fails).
const TTML_PARSE = 4
// the waits before the 2nd and 3rd Apple attempt of one lookup
const APPLE_RETRY_MS = [1000, 3000]
// a definitive "no lyrics on Apple Music or LRCLIB" is reused for this long (a song played again soon)
const NONE_TTL_MS = 10 * 60 * 1000

// Retries of a lookup that failed (main.js, per song): LRCLIB is often only briefly overloaded (Marcy
// 2026-10-18: HTTP 503 on about 2 of 3 requests, 200 on the next), so the first retries come fast and then
// back off; each wait is jittered ±RETRY_JITTER so many clients don't retry in step, and a song gets at
// most LRCLIB_MAX_TRIES lookups per session (counting the first). Apple failing alone: APPLE_RETRY_S, then
// the window says Apple's lyrics didn't load.
const LRCLIB_RETRY_S = [1, 2, 4, 8, 30, 120]
const LRCLIB_MAX_TRIES = 10
const APPLE_RETRY_S = [30, 60, 120]
const RETRY_JITTER = 0.2
/**
 * The wait (ms) before the next lookup after `tries` failed lookups of a song (1 = the first failed), or
 * null when no more are made. error: the result's error ('lrclib' | 'apple'). rand() in [0, 1) (tests).
 */
function retryPlan(error, tries, rand = Math.random) {
  const steps = error === 'lrclib' ? LRCLIB_RETRY_S : error === 'apple' ? APPLE_RETRY_S : null
  const max = error === 'lrclib' ? LRCLIB_MAX_TRIES : APPLE_RETRY_S.length + 1
  if (!steps || !(tries >= 1) || tries >= max) return null
  const base = steps[Math.min(tries - 1, steps.length - 1)] * 1000
  return Math.round(base * (1 + RETRY_JITTER * (2 * rand() - 1)))
}

// lifetime: OK — a one-shot wait inside one lookup, settled after ms (nothing holds it)
const realSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// what a result carries beyond its lines: the language and the writers, only when there are some
function withExtras(result, lang, writers) {
  if (lang) result.lang = lang
  if (writers && writers.length) result.writers = writers
  return result
}

const R = require('./recording-id')

function createLyricsResolver(deps) {
  // lifetime: bounded — at most 50 entries (oldest evicted), empty results removed; in-flight lookups
  // are shared, so lyrics + visualizer windows trigger one fetch per track. Only used while lyrics or
  // the visualizer is open. loop: none.
  const cache = new Map()
  const noneAt = new Map()     // key -> when a definitive "no lyrics" came (only those stay in `cache` empty)
  const now = deps.now || Date.now
  return async function getLyrics(state) {
    // one recording: studio and live with the same title are two lookups (recording-id.js)
    const song = R.songOf(state)
    const key = R.trackKey(song)
    if (noneAt.has(key) && now() - noneAt.get(key) > NONE_TTL_MS) { noneAt.delete(key); cache.delete(key) }
    if (cache.has(key)) return cache.get(key)
    const job = (async () => {
      // the on-disk store first (songs played before); LRCLIB results only while LRCLIB is enabled.
      // An entry of another recording (other ISRC, other length, an unchecked old one of a "(Live)" title)
      // is not used: Apple is asked again for this one.
      const found = deps.store ? R.lookup(deps.store, '', song) : { entry: null, key: R.recordingKey(song) }
      const stored = found.entry
      const usable = stored && stored.lines && stored.lines.length && (stored.source !== 'lrclib' || deps.lrclibEnabled())
      const stale = usable && stored.source === 'apple' && stored.parse !== TTML_PARSE
      if (usable && !stale) return withExtras({ lines: stored.lines, source: stored.source }, stored.lang, stored.writers)
      // an instrumental verdict played before: instant, nothing asked
      if (stored && stored.instrumental && !(stored.lines && stored.lines.length)) return { lines: [], source: stored.source || '', instrumental: stored.instrumental }
      const remember = (result) => {
        if (deps.store && result.instrumental) R.put(deps.store, found.key, { lines: [], source: result.source, instrumental: result.instrumental }, song)
        else if (deps.store && result.lines.length) R.put(deps.store, found.key, result.source === 'apple' ? Object.assign({}, result, { parse: TTML_PARSE }) : { lines: result.lines, source: result.source }, song)
        return result
      }
      const marker = instrumentalTitle(state.title)
      const byTitle = () => ({ lines: [], source: '', instrumental: { by: 'title', marker } })
      let appleFailed = ''
      let appleError = null
      const sleep = deps.sleep || realSleep
      // loop: SERIAL-REQUIRED — at most 1 + APPLE_RETRY_MS.length (3) Apple attempts per lookup, each after the last failed
      for (let attempt = 0; ; attempt++) {
        try {
          const ttml = await deps.fetchApple(state)
          appleFailed = ''
          const lines = ttml ? parseTtml(ttml) : []
          if (lines.length) return remember(withExtras({ lines, source: 'apple' }, ttmlLang(ttml), ttmlSongwriters(ttml)))
          break
        } catch (e) {
          // error: SHOWN — a failed Apple lookup (page mid-navigation, Apple's API erring) is tried again; then
          // LRCLIB stands in with a note that Apple's didn't load, or the window says they didn't load (main.js retries)
          appleFailed = (e && e.message) || 'failed'
          appleError = e
          if (attempt >= APPLE_RETRY_MS.length) break
          await sleep(APPLE_RETRY_MS[attempt])
        }
      }
      if (appleFailed && deps.log) deps.log('apple lyrics lookup failed: ' + appleFailed)
      if (stale) return withExtras({ lines: stored.lines, source: 'apple' }, stored.lang, stored.writers)   // Apple unreachable now: the older parse
      if (state.title && deps.lrclibEnabled()) {
        try {
          const lines = await deps.fetchLrclib(state)
          // standing in for Apple's that didn't load: shown, not stored (the next play asks Apple again)
          if (lines.length) return appleFailed ? { lines, source: 'lrclib', appleFailed: true } : remember({ lines, source: 'lrclib' })
          if (lines.instrumental) {
            const got = { lines: [], source: 'lrclib', instrumental: lines.instrumental }
            return appleFailed ? Object.assign(got, { appleFailed: true, apple: 'failed' }) : remember(got)
          }
        } catch (e) {
          // error: SHOWN — logged, and the window says which service failed and how (lyrics-view statusText);
          // main.js retries (retryPlan: fast at first, then backing off)
          if (deps.log) deps.log('lrclib lookup failed: ' + e.message)
          // the title says instrumental: that stands (no retry, no failure message), not stored (LRCLIB unasked)
          if (marker) return appleFailed ? Object.assign(byTitle(), { appleFailed: true, apple: 'failed' }) : byTitle()
          // the service failed (overloaded, rate limit, offline): not the same as "no lyrics"
          const status = e && Number.isInteger(e.status) ? e.status : 0
          return { lines: [], source: '', error: 'lrclib', lrclib: { status, message: (e && e.message) || '' }, apple: appleFailed ? 'failed' : 'none' }
        }
        // Apple's lookup failed and LRCLIB has none: Apple's is still unknown
        if (!appleFailed) return marker ? remember(byTitle()) : { lines: [], source: '', none: 'both' }
      }
      if (marker) return appleFailed ? Object.assign(byTitle(), { appleFailed: true, apple: 'failed' }) : remember(byTitle())
      // Apple's lookup failed and nothing stood in: not "no lyrics"
      return appleFailed ? { lines: [], source: '', error: 'apple', appleError: (appleError && appleError.message) || appleFailed } : { lines: [], source: '', none: 'apple' }
    })()
    cache.set(key, job)
    if (cache.size > 50) { const old = cache.keys().next().value; cache.delete(old); noneAt.delete(old) }
    const result = await job
    // kept: lyrics, and a definitive "none on Apple Music or LRCLIB" (for NONE_TTL_MS); never a failure
    if (result.none === 'both') noneAt.set(key, now())
    else if ((!result.lines.length && !result.instrumental) || result.appleFailed) cache.delete(key)
    return result
  }
}

module.exports = { HIT_NEAR_S, instrumentalTitle, instrumentalHit, rankHits, hitProblem, APPLE_RETRY_MS, NONE_TTL_MS, LRCLIB_RETRY_S, LRCLIB_MAX_TRIES, APPLE_RETRY_S, RETRY_JITTER, retryPlan, parseTtml, parseTtmlClock, ttmlLang, ttmlSongwriters, parseLrc, lrcWords, lrclibLines, cleanAlbum, isLive, pickHit, fetchLrclib, createLyricsResolver }
