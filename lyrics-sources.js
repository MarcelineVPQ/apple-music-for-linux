// Lyrics sources: Apple's TTML (through the page's MusicKit session) and
// LRCLIB (lrclib.net, a free open lyrics database) as a fallback.
// Pure functions with injected I/O so they can be tested without Electron.

function parseTtmlClock(value) {
  value = value.trim()
  if (!value.includes(':')) return parseFloat(value) || 0
  return value.split(':').reduce((total, part) => total * 60 + (parseFloat(part) || 0), 0)
}

function parseTtml(ttml) {
  const lines = []
  const re = /<p[^>]*\bbegin="([^"]+)"[^>]*>([\s\S]*?)<\/p>/g
  let match
  while ((match = re.exec(ttml))) {
    const text = match[2]
      .replace(/></g, '> <')
      .replace(/<[^>]+>/g, '')
      .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
      .replace(/\s+/g, ' ')
      .trim()
    if (text) lines.push({ t: parseTtmlClock(match[1]), text })
  }
  return lines
}

// "[01:02.50] text" (several stamps per line allowed) -> [{ t, text }]
function parseLrc(lrc) {
  const lines = []
  for (const raw of String(lrc || '').split(/\r?\n/)) {
    const stamps = [...raw.matchAll(/\[(\d+):(\d+(?:\.\d+)?)\]/g)]
    if (!stamps.length) continue
    const text = raw.replace(/\[[^\]]*\]/g, '').trim()
    if (!text) continue
    for (const m of stamps) lines.push({ t: parseInt(m[1], 10) * 60 + parseFloat(m[2]), text })
  }
  return lines.sort((a, b) => a.t - b.t)
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
 *         lrclibEnabled() -> bool, log(msg) }
 */
function createLyricsResolver(deps) {
  const cache = new Map()
  return async function getLyrics(state) {
    const key = state.title + '|' + state.artist
    if (cache.has(key)) return cache.get(key)
    const job = (async () => {
      try {
        const ttml = await deps.fetchApple(state)
        const lines = ttml ? parseTtml(ttml) : []
        if (lines.length) return { lines, source: 'apple' }
      } catch (e) { /* no Apple lyrics */ }
      if (state.title && deps.lrclibEnabled()) {
        try {
          const lines = await deps.fetchLrclib(state)
          if (lines.length) return { lines, source: 'lrclib' }
        } catch (e) {
          if (deps.log) deps.log('lrclib lookup failed: ' + e.message)
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

module.exports = { parseTtml, parseTtmlClock, parseLrc, lrclibLines, cleanAlbum, pickHit, fetchLrclib, createLyricsResolver }
