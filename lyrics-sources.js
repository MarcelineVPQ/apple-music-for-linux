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
  for (const m of tag.matchAll(/([\w:.-]+)\s*=\s*"([^"]*)"/g)) attrs[m[1]] = m[2]
  return attrs
}

/** The lyrics language of a TTML document (<tt xml:lang="en">), '' when it has none. */
function ttmlLang(ttml) {
  const m = /<tt\b[^>]*>/.exec(ttml || '')
  return m ? (tagAttrs(m[0])['xml:lang'] || '') : ''
}

// <ttm:agent xml:id="v1" type="person"/> -> { v1: 'person' }
function ttmlAgents(ttml) {
  const agents = {}
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
  while ((match = re.exec(ttml))) {
    const attrs = tagAttrs(match[1])
    if (attrs.begin === undefined) continue
    raw.push({ attrs, inner: match[2], syl: ttmlSyllables(match[2]) })
  }
  // whitespace between spans separates words; a document without any is word-per-span
  const multi = raw.filter((r) => r.syl.main.length > 1)
  const everySpan = multi.length > 0 && !multi.some((r) => r.syl.main.slice(1).some((s) => s.newWord || /^\s/.test(s.text)))
  const lines = []
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
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i]
    if (e.gap) continue
    let next = null
    for (let j = i + 1; j < entries.length && !next; j++) if (entries[j].t > e.t) next = entries[j]
    if (e.words) {
      const last = e.words[e.words.length - 1]
      if (last.end === null) last.end = Math.min(last.t + 1, next ? next.t : Infinity)
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

// Best search hit: close in length (±5 s when both are known), synced first.
function pickHit(hits, duration) {
  const list = Array.isArray(hits) ? hits : []
  const near = list.filter((h) => !duration || !h.duration || Math.abs(h.duration - duration) <= 5)
  return near.find((h) => h.syncedLyrics) || near.find((h) => h.plainLyrics) || null
}

/**
 * Look a song up on LRCLIB. state: { title, artist, album, duration }.
 * deps.fetch(url, { headers }) -> Response-like { ok, status, json() }.
 * Exact match first (/api/get), then a looser search (/api/search).
 * Throws on network/HTTP errors other than 404.
 */
async function fetchLrclib(state, deps) {
  const headers = { 'User-Agent': deps.userAgent || 'Sonata' }
  const get = async (url) => {
    const res = await deps.fetch(url, { headers })
    if (res.status === 404) return null
    if (!res.ok) throw new Error('lrclib HTTP ' + res.status)
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
  try {
    lines = lrclibLines(await get(base + '/api/get-cached?' + q))
  } catch (e) { /* fall through to search */ }
  if (!lines.length) {
    const s = new URLSearchParams({ track_name: state.title, artist_name: state.artist || '' })
    lines = lrclibLines(pickHit(await get(base + '/api/search?' + s), state.duration))
  }
  return lines
}

/**
 * Lyrics for a song: Apple first, then LRCLIB when enabled. Results are
 * cached per title|artist (max 50) so several windows share one lookup;
 * empty results are not cached, so the next play retries.
 * deps: { fetchApple(state) -> ttml string, fetchLrclib(state) -> lines,
 *         lrclibEnabled() -> bool, log(msg), store? ({ get(key), set(key, value) }, on disk) }
 */
// Version of the parsed Apple lyrics in the on-disk store: 2 = words keep their syllables (0.15.25),
// 3 = the lyrics language (xml:lang) is stored too (0.15.26). A stored Apple entry from an older parser
// is fetched again once (served as is when that fails).
const TTML_PARSE = 3

function createLyricsResolver(deps) {
  // lifetime: bounded — at most 50 entries (oldest evicted), empty results removed; in-flight lookups
  // are shared, so lyrics + visualizer windows trigger one fetch per track. Only used while lyrics or
  // the visualizer is open. loop: none.
  const cache = new Map()
  return async function getLyrics(state) {
    const key = state.title + '|' + state.artist
    if (cache.has(key)) return cache.get(key)
    const job = (async () => {
      // the on-disk store first (songs played before); LRCLIB results only while LRCLIB is enabled
      const stored = deps.store ? deps.store.get(key) : null
      const usable = stored && stored.lines && stored.lines.length && (stored.source !== 'lrclib' || deps.lrclibEnabled())
      const stale = usable && stored.source === 'apple' && stored.parse !== TTML_PARSE
      if (usable && !stale) return stored.lang ? { lines: stored.lines, source: stored.source, lang: stored.lang } : { lines: stored.lines, source: stored.source }
      const remember = (result) => {
        if (deps.store && result.lines.length) deps.store.set(key, result.source === 'apple' ? Object.assign({}, result, { parse: TTML_PARSE }) : { lines: result.lines, source: result.source })
        return result
      }
      try {
        const ttml = await deps.fetchApple(state)
        const lines = ttml ? parseTtml(ttml) : []
        const lang = ttml ? ttmlLang(ttml) : ''
        if (lines.length) return remember(lang ? { lines, source: 'apple', lang } : { lines, source: 'apple' })
      } catch (e) { /* no Apple lyrics */ }
      if (stale) return { lines: stored.lines, source: 'apple' }   // Apple unreachable now: the older parse
      if (state.title && deps.lrclibEnabled()) {
        try {
          const lines = await deps.fetchLrclib(state)
          if (lines.length) return remember({ lines, source: 'lrclib' })
        } catch (e) {
          if (deps.log) deps.log('lrclib lookup failed: ' + e.message)
          // the service failed (busy, rate limit, offline): not the same as "no lyrics"
          return { lines: [], source: '', error: 'busy' }
        }
      }
      return { lines: [], source: '' }
    })()
    cache.set(key, job)
    if (cache.size > 50) cache.delete(cache.keys().next().value)
    const result = await job
    if (!result.lines.length) cache.delete(key)
    return result
  }
}

module.exports = { parseTtml, parseTtmlClock, ttmlLang, parseLrc, lrcWords, lrclibLines, cleanAlbum, pickHit, fetchLrclib, createLyricsResolver }
