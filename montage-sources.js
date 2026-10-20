// The Studio's Montage: where its photos come from (Wikimedia Commons, found through Wikidata) and
// which ones may show. No DOM, no Electron: main passes in its fetch (safe-fetch.js over Electron's net.request), so
// node --test covers every match, licence and credit with saved answers (test/fixtures/montage/).
//
// The matches (identifiers only, never a fuzzy name search):
//   the artist  the Wikidata item whose Apple Music artist ID (P2850) is the song's artist's ID
//               (haswbstatement, then the item is read back and must carry that exact ID); else the
//               album item's performer (P175)
//   the album   the item whose Apple Music album ID (P2281) is the song's album's ID, read back the same
//               way; its venue (P483 "recorded at", a live album's hall or amphitheatre) and its date
//   photos      each item's own image (P18) and the files of its Commons category (P373); for the
//               artist also its "<category> in <year>" categories nearest the album's year (the era)
//
// Licences (licenceOf): only files Commons marks with a clear free licence that allows showing them
// with a credit: CC0, public domain, CC BY and CC BY-SA (any version, ported ones too) and the Free Art
// License. Anything else (no licence, NC or ND, GFDL alone, "non-free", fair use) is skipped, and so is
// a file without a named author. Every photo carries its author, licence (with its link) and its
// Commons page; the Studio's credit line shows them. Album covers and Apple's artwork are never used.
//
// Etiquette: a User-Agent naming Sonata and the repo, one request at a time per host with a gap, a
// short backoff on 503/429, thumbnails at a standard width (Commons' thumbnail steps), at most a dozen
// photos per artist and album, and the answer cached on disk by main (montage-store.js, lyrics-store.js).
'use strict'

// the User-Agent (naming Sonata and the repo) comes from version-display.js userAgent, passed in by main

// the gap between two requests to one host (ms)
const GAPS = { 'www.wikidata.org': 150, 'commons.wikimedia.org': 300, 'upload.wikimedia.org': 300, 'thumb.wikimedia.org': 300 }
const gapFor = (host) => GAPS[host] || 300
const TIMEOUT_MS = 12000
const MAX_IMAGE_BYTES = 6 * 1024 * 1024
const MAX_PHOTOS = 12
// Commons' standard thumbnail widths (other widths are slower and rate-limited); the montage asks for
// the smallest one that covers the Studio's centre at its zoom
const WIDTHS = [960, 1280, 1920]

/** A fetch failure in words: kind 'offline' | 'timeout' | 'http' | 'bad'. */
function failure(kind, message, status) {
  const e = new Error(message)
  e.kind = kind
  if (status) e.status = status
  return e
}

/**
 * createFetcher({ fetch, ua, now, sleep, timeoutMs }) -> { getJson(url, opts), getImage(url) }.
 * One request at a time per host, each at least gapFor(host) after the last; a 503 or 429 is tried
 * again twice (after 2 s, then 4 s). getImage -> { bytes: Buffer, type } of a JPEG or PNG ≤ 6 MB.
 */
function createFetcher(deps) {
  const now = deps.now || Date.now
  const sleep = deps.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)))   // lifetime: OK — one-shot per wait
  // cache: OK — key=host; invalidated=never (lane order and last time only); bound=≤ 3 hosts (Wikidata, Commons, upload)
  const lanes = new Map()   // host -> { last, chain }
  function request(url, accept, read) {
    const host = new URL(url).hostname
    let lane = lanes.get(host)
    if (!lane) { lane = { last: 0, chain: Promise.resolve() }; lanes.set(host, lane) }
    const run = lane.chain.then(async () => {
      // loop: SERIAL-REQUIRED — at most 3 attempts of one request (a busy answer waits, then asks again)
      for (let attempt = 0; ; attempt++) {
        const wait = lane.last + gapFor(host) - now()
        if (wait > 0) await sleep(wait)
        lane.last = now()
        let res
        try {
          const signal = typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? AbortSignal.timeout(deps.timeoutMs || TIMEOUT_MS) : undefined
          res = await deps.fetch(url, { headers: { 'User-Agent': deps.ua, Accept: accept }, signal })
        } catch (e) {
          // error: PASSES-ON — no connection or no answer in time: the caller says offline (the tile) or tries the next photo
          throw failure(e && (e.name === 'TimeoutError' || e.name === 'AbortError') ? 'timeout' : 'offline', (e && e.message) || 'fetch failed')
        }
        if ((res.status === 503 || res.status === 429) && attempt < 2) { await sleep(2000 * (attempt + 1)); continue }
        if (!res.ok) throw failure('http', 'HTTP ' + res.status + ' from ' + host, res.status)
        return read(res, host)
      }
    })
    // error: NOT-WORTH — the lane only orders requests; each caller gets its own failure from `run`
    lane.chain = run.catch(() => {})
    return run
  }
  return {
    getJson: (url) => request(url, 'application/json', async (res, host) => {
      try { return await res.json() } catch (e) { throw failure('bad', 'not JSON from ' + host) }   // error: PASSES-ON — the caller treats the source as failed
    }),
    getImage: (url) => request(url, 'image/jpeg,image/png', async (res, host) => {
      const type = String((res.headers && res.headers.get && res.headers.get('content-type')) || '').split(';')[0].trim()
      if (type !== 'image/jpeg' && type !== 'image/png') throw failure('bad', 'not a JPEG or PNG from ' + host)
      const len = Number(res.headers.get('content-length') || 0)
      if (len > MAX_IMAGE_BYTES) throw failure('bad', 'too large from ' + host)
      const bytes = Buffer.from(await res.arrayBuffer())
      if (bytes.length > MAX_IMAGE_BYTES || bytes.length < 64) throw failure('bad', 'bad size from ' + host)
      return { bytes, type }
    })
  }
}

// --- small helpers ---
const QID = /^Q\d+$/
const APPLE_ID = /^\d{1,20}$/
// loop: NOT-WORTH — one property's claims (≤ ~5), once per resolve (stage-ui's yearOf is another function)
const claims = (entity, prop) => ((entity && entity.claims && entity.claims[prop]) || [])
  .map((c) => (c && c.mainsnak && c.mainsnak.datavalue ? c.mainsnak.datavalue.value : null))
// loop: NOT-WORTH — ≤ ~5 claims, per item reduce, once per artist+album resolve
const strings = (entity, prop) => claims(entity, prop).filter((v) => typeof v === 'string')
// loop: NOT-WORTH — ≤ ~5 claims, per item reduce, once per artist+album resolve
const items = (entity, prop) => claims(entity, prop).map((v) => (v && QID.test(v.id || '') ? v.id : null)).filter(Boolean)
const yearOf = (entity, prop) => {
  // loop: NOT-WORTH — ≤ ~5 claims, per item reduce, once per resolve (not drawNowPlaying: a name match)
  const t = claims(entity, prop).find((v) => v && typeof v.time === 'string')
  const m = t ? /^[+]?(\d{4})-/.exec(t.time) : null
  return m ? Number(m[1]) : 0
}

// --- Wikidata ---
const WD_API = 'https://www.wikidata.org/w/api.php'
async function byStatement(getJson, prop, value) {
  const j = await getJson(WD_API + '?action=query&list=search&srlimit=3&format=json&srsearch=' + encodeURIComponent('haswbstatement:' + prop + '=' + value))
  // loop: NOT-WORTH — ≤ 3 search hits, ≤ 2 per artist+album resolve (cached set otherwise)
  return ((j && j.query && j.query.search) || []).map((h) => h.title).filter((t) => QID.test(t))
}
async function entities(getJson, qids) {
  // loop: NOT-WORTH — ≤ 10 QIDs, ≤ 3 calls per resolve
  const ids = [...new Set(qids.filter((q) => QID.test(q)))].slice(0, 10)
  if (!ids.length) return {}
  const j = await getJson(WD_API + '?action=wbgetentities&props=claims&format=json&ids=' + ids.join('%7C'))
  return (j && j.entities) || {}
}
/** What the montage needs of an item: its own images (P18), its Commons category (P373), its IDs. */
function reduceItem(e) {
  if (!e || !QID.test(e.id || '')) return null
  return {
    qid: e.id,
    images: strings(e, 'P18').slice(0, 3),
    category: strings(e, 'P373')[0] || '',
    p2850: strings(e, 'P2850'), p2281: strings(e, 'P2281'),
    venues: items(e, 'P483').slice(0, 2), performers: items(e, 'P175').slice(0, 2),
    year: yearOf(e, 'P577')
  }
}
/** The item carrying exactly this ID (read back after the search: a search index can lag behind). */
async function matchBy(getJson, prop, field, value) {
  if (!APPLE_ID.test(String(value || ''))) return null
  const hits = await byStatement(getJson, prop, String(value))
  if (!hits.length) return null
  const ents = await entities(getJson, hits)
  // loop: NOT-WORTH — ≤ 3 hits, read back together
  for (const q of hits) {
    const it = reduceItem(ents[q])
    if (it && it[field].includes(String(value))) return it
  }
  return null
}

/**
 * The song's items: { artist, album, venues: [item] } (each item or null). artistId, albumId: Apple
 * Music catalog IDs (digits). The artist by P2850, else the album's performer (P175); the venue only
 * through the album's P483.
 */
async function matchItems(getJson, ids) {
  const album = await matchBy(getJson, 'P2281', 'p2281', ids.albumId)
  let artist = await matchBy(getJson, 'P2850', 'p2850', ids.artistId)
  const more = []
  if (!artist && album && album.performers.length) more.push(album.performers[0])
  if (album) more.push(...album.venues)
  const ents = await entities(getJson, more)
  if (!artist && album && album.performers.length) artist = reduceItem(ents[album.performers[0]])
  // loop: NOT-WORTH — ≤ 2 venues, once per resolve
  const venues = album ? album.venues.map((q) => reduceItem(ents[q])).filter(Boolean) : []
  return { artist, album, venues }
}

// --- Commons ---
const COMMONS_API = 'https://commons.wikimedia.org/w/api.php'
const EXT = 'LicenseShortName|License|LicenseUrl|Artist|DateTimeOriginal|AttributionRequired|NonFree|ObjectName'
const infoQuery = (width) => COMMONS_API + '?action=query&format=json&formatversion=2&prop=imageinfo&iiprop=url%7Csize%7Cmime%7Cextmetadata&iiurlwidth=' + width + '&iiextmetadatafilter=' + encodeURIComponent(EXT)
const catTitle = (name) => 'Category:' + String(name).replace(/^Category:/i, '').replace(/ /g, '_')

async function filesIn(getJson, category, width) {
  if (!category) return []
  const j = await getJson(infoQuery(width) + '&generator=categorymembers&gcmtype=file&gcmlimit=50&gcmtitle=' + encodeURIComponent(catTitle(category)))
  return (j && j.query && j.query.pages) || []
}
async function filesNamed(getJson, names, width) {
  // loop: NOT-WORTH — ≤ 20 names, once per resolve
  const t = [...new Set(names.filter(Boolean))].slice(0, 20).map((n) => 'File:' + String(n).replace(/^File:/i, '').replace(/ /g, '_'))
  if (!t.length) return []
  const j = await getJson(infoQuery(width) + '&titles=' + encodeURIComponent(t.join('|')))
  return (j && j.query && j.query.pages) || []
}
async function subcats(getJson, category) {
  if (!category) return []
  const j = await getJson(COMMONS_API + '?action=query&format=json&formatversion=2&list=categorymembers&cmtype=subcat&cmlimit=100&cmtitle=' + encodeURIComponent(catTitle(category)))
  // loop: NOT-WORTH — ≤ 100 subcategories, ≤ 2 per resolve
  return ((j && j.query && j.query.categorymembers) || []).map((m) => String(m.title || '').replace(/^Category:/, '')).filter(Boolean)
}
/**
 * The artist's "<category> in <year>" categories nearest the album's year, at most `n` (from its
 * "<category> by year" category): the era's photos. -> [name]
 */
function eraCategories(category, names, year, n) {
  if (!year) return []
  const re = new RegExp('^' + category.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ' in (\\d{4})$')
  // loop: NOT-WORTH — ≤ 100 category names, once per resolve
  return names.map((c) => { const m = re.exec(c); return m ? { c, y: Number(m[1]) } : null })
    .filter((x) => x && Math.abs(x.y - year) <= 3)
    .sort((a, b) => Math.abs(a.y - year) - Math.abs(b.y - year) || a.y - b.y)
    .slice(0, n || 2).map((x) => x.c)
}

// --- licences, authors, files ---
const decode = (s) => String(s || '')
  .replace(/<[^>]*>/g, ' ')
  .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'")
  .replace(/&#(\d+);/g, (m, n) => String.fromCodePoint(Number(n)))
  .replace(/\s+/g, ' ').trim()
const meta = (m, k) => (m && m[k] && typeof m[k].value === 'string' ? m[k].value : '')
const CC = /^CC BY(-SA)? (\d\.\d|\d)( [a-z]{2,}(-[a-z]{2,})?)?$/i
const HTTPS_LICENCE = /^https:\/\/(creativecommons\.org|artlibre\.org)\//

/**
 * A file's licence, when it is a clear free licence that allows showing it with a credit:
 * -> { name ('CC BY-SA 2.0', 'CC0', 'Public domain', 'Free Art License'), url, kind } | null.
 * extmetadata: Commons' imageinfo extmetadata (LicenseShortName, License, LicenseUrl, NonFree).
 */
function licenceOf(m) {
  if (/^true$/i.test(meta(m, 'NonFree'))) return null
  const short = decode(meta(m, 'LicenseShortName'))
  const code = meta(m, 'License').toLowerCase()
  const link = meta(m, 'LicenseUrl').replace(/^http:\/\//, 'https://')
  if (/\b(nc|nd)\b|non-?commercial|no-?deriv|fair use|non-free/i.test(short + ' ' + code)) return null
  if (/^cc0\b/i.test(short) || code === 'cc0') return { name: 'CC0', url: 'https://creativecommons.org/publicdomain/zero/1.0/', kind: 'cc0' }
  if (/^public domain$/i.test(short) || /^pd($|-)/.test(code)) return { name: 'Public domain', url: '', kind: 'pd' }
  const cc = CC.exec(short)
  if (cc) {
    const kind = cc[1] ? 'by-sa' : 'by'
    const url = HTTPS_LICENCE.test(link) ? link : 'https://creativecommons.org/licenses/' + kind + '/' + (cc[2].includes('.') ? cc[2] : cc[2] + '.0') + '/'
    return { name: 'CC ' + (cc[1] ? 'BY-SA' : 'BY') + ' ' + cc[2] + (cc[3] || ''), url, kind }
  }
  if (/^(FAL|Free Art License|LAL)\b/i.test(short) || /^fal\b/.test(code)) return { name: 'Free Art License', url: 'https://artlibre.org/licence/lal/en/', kind: 'fal' }
  return null
}

const NO_AUTHOR = /^(unknown|anonymous|author unknown|unknown author|unknown photographer|see (below|above|source)|n\/?a|none|-|\?)\.?$/i
/** The author as Commons credits them, in plain text (≤ 100 characters), or '' when none is named. */
function authorOf(m) {
  let a = decode(meta(m, 'Artist'))
    .replace(/\s*\(page does not exist\)/gi, '')
    .replace(/^(photo(graph)?( by)?|by|author|uploaded by)[:\s]+/i, '')
    .replace(/\s*\(talk\)\s*$/i, '')
    .trim()
  if (!a || NO_AUTHOR.test(a)) return ''
  if (a.length > 100) a = a.slice(0, 99).replace(/\s+\S*$/, '') + '…'
  return a
}

// file names that are not photos of the act or the place (logos, signatures, covers, posters, maps)
const NOT_A_PHOTO = /logo|signature|autograph|\bcover\b|album art|discograf|discography|poster|flyer|ticket|setlist|\bmap\b|diagram|\bplan\b|screenshot|wordmark|\bicon\b/i
const THUMB_HOST = /^https:\/\/(upload|thumb)\.wikimedia\.org\//
const PAGE = /^https:\/\/commons\.wikimedia\.org\/wiki\/File:[^\s?#]+$/
const clean = (u) => String(u || '').replace(/\?.*$/, '')

/**
 * One Commons page (imageinfo + extmetadata) as a montage photo, or null when it may not show (not a
 * JPEG/PNG photo of a useful size, no free licence, no author, a logo or cover). -> { id, title, page,
 * author, licence: { name, url, kind }, width, height, thumb, original, year }
 */
function photoFrom(p) {
  const ii = p && Array.isArray(p.imageinfo) ? p.imageinfo[0] : null
  if (!ii || p.missing) return null
  const title = String(p.title || '').replace(/^File:/, '')
  if (!title || NOT_A_PHOTO.test(title)) return null
  if (ii.mime !== 'image/jpeg' && ii.mime !== 'image/png') return null
  const w = Number(ii.width) || 0
  const h = Number(ii.height) || 0
  if (w < 800 || h < 500 || w > h * 3 || h > w * 2) return null
  const m = ii.extmetadata || {}
  const licence = licenceOf(m)
  if (!licence) return null
  const author = authorOf(m)
  if (!author) return null
  const page = clean(ii.descriptionurl)
  const thumb = clean(ii.thumburl)
  const original = clean(ii.url)
  if (!PAGE.test(page) || !THUMB_HOST.test(original) || (thumb && !THUMB_HOST.test(thumb))) return null
  const y = /^(\d{4})/.exec(decode(meta(m, 'DateTimeOriginal')).replace(/^\D+/, ''))
  return { id: title, title: decode(meta(m, 'ObjectName')) || title.replace(/\.[a-z]+$/i, ''), page, author, licence, width: w, height: h, thumb, thumbWidth: Number(ii.thumbwidth) || 0, original, year: y ? Number(y[1]) : 0 }
}

/**
 * The URL of a photo at `width` (one of WIDTHS): Commons' thumbnail at that step, or the original
 * when it is no wider. '' when the photo has no usable URL.
 */
function thumbFor(photo, width) {
  if (!photo) return ''
  if (photo.width <= width) return photo.original
  if (!photo.thumb) return ''
  const t = photo.thumb.replace(/\/(\d+)px-([^/]+)$/, '/' + width + 'px-$2')
  return t !== photo.thumb || photo.thumbWidth === width ? t : ''
}

/** The smallest standard width that covers `need` CSS pixels × dpr, at most the largest. */
function widthFor(needPx) {
  const n = Math.max(1, Number(needPx) || 0)
  // loop: NOT-WORTH — ≤ ~5 widths, ≤ 8 photos per song change
  return WIDTHS.find((w) => w >= n * 0.85) || WIDTHS[WIDTHS.length - 1]
}

/**
 * The montage's order: the venue's photos (a live album's hall) woven between the artist's, the
 * album's era first (photos dated nearest its year), then the artist's own image, then the rest by
 * date; duplicates dropped; at most MAX_PHOTOS. groups: { venue: [photo], era: [photo], own: [photo],
 * rest: [photo] }, year: the album's year or 0.
 */
function arrange(groups, year) {
  // cache: NOT-WORTH — key=photo id; invalidated=local to one arrange call, freed on return; bound=≤ ~150 candidates
  const seen = new Set()
  // loop: NOT-WORTH — once per artist+album resolve (cached in main.js montageCache), N ≤ ~150 candidates
  const take = (list) => (list || []).filter((p) => p && !seen.has(p.id) && seen.add(p.id))
  const near = (a, b) => (year ? (a.year ? Math.abs(a.year - year) : 99) - (b.year ? Math.abs(b.year - year) : 99) : 0)
  const venue = take(groups.venue)
  const era = take(groups.era).sort(near)
  const own = take(groups.own)
  const rest = take(groups.rest).sort(near)
  const artist = era.concat(own, rest)
  const out = []
  // loop: NOT-WORTH — ≤ MAX_PHOTOS picks from ≤ ~150 candidates, once per artist and album
  for (let i = 0, a = 0, v = 0; out.length < MAX_PHOTOS && (a < artist.length || v < venue.length); i++) {
    // two of the artist's for one of the venue's: the music first, the place between
    if (v < venue.length && (i % 3 === 2 || a >= artist.length)) out.push(venue[v++])
    else if (a < artist.length) out.push(artist[a++])
  }
  return out
}

/**
 * Everything for one song: its items and their photos, in montage order.
 * ids: { artistId, albumId, year (the song's release year, a fallback) }; width: the thumbnail step.
 * -> { photos: [photo], how: { artist: qid|'', album: qid|'', venues: [qid] }, checked: n }
 *    photos is [] when nothing licensed was found (the tile says so).
 */
async function resolveMontage(getJson, ids, width) {
  const w = WIDTHS.includes(width) ? width : WIDTHS[1]
  const { artist, album, venues } = await matchItems(getJson, ids)
  const year = (album && album.year) || Number(ids.year) || 0
  const pages = { venue: [], era: [], own: [], rest: [] }
  // loop: NOT-WORTH — ≤ 2 venues, once per artist+album resolve
  const own = [...(artist ? artist.images : []), ...(album ? album.images : []), ...venues.flatMap((v) => v.images)]
  if (own.length) {
    const named = await filesNamed(getJson, own, w)
    // loop: NOT-WORTH — ≤ 2 venues × ≤ 3 images, once per resolve
    const venueImages = new Set(venues.flatMap((v) => v.images).map((n) => n.replace(/_/g, ' ')))
    // loop: NOT-WORTH — ≤ ~9 own images, once per song
    for (const p of named) (venueImages.has(String(p.title || '').replace(/^File:/, '')) ? pages.venue : pages.own).push(p)
  }
  // loop: SERIAL-REQUIRED — ≤ 2 venues, one Commons request each (one host lane: one at a time anyway)
  for (const v of venues) pages.venue.push(...await filesIn(getJson, v.category, w))
  if (album && album.category) pages.era.push(...await filesIn(getJson, album.category, w))
  if (artist && artist.category) {
    pages.rest.push(...await filesIn(getJson, artist.category, w))
    if (year) {
      const subs = await subcats(getJson, artist.category)
      // loop: NOT-WORTH — ≤ 100 subcategories, once per resolve
      const byYear = subs.find((s) => s === artist.category + ' by year')
      const years = eraCategories(artist.category, byYear ? await subcats(getJson, byYear) : subs, year, 2)
      // loop: SERIAL-REQUIRED — ≤ 2 year categories, one request each
      for (const c of years) pages.era.push(...await filesIn(getJson, c, w))
    }
  }
  const ph = (list) => list.map(photoFrom).filter(Boolean)
  const checked = pages.venue.length + pages.era.length + pages.own.length + pages.rest.length
  const photos = arrange({ venue: ph(pages.venue), era: ph(pages.era), own: ph(pages.own), rest: ph(pages.rest) }, year)
  // loop: NOT-WORTH — ≤ 2 venues, once per resolve
  return { photos, how: { artist: artist ? artist.qid : '', album: album ? album.qid : '', venues: venues.map((v) => v.qid) }, checked }
}

/** The credit line's words: 'Author · CC BY-SA 2.0 · Wikimedia Commons'. */
function creditText(photo) {
  if (!photo) return ''
  return [photo.author, photo.licence && photo.licence.name, 'Wikimedia Commons'].filter(Boolean).join(' · ')
}

module.exports = {
  WIDTHS, MAX_PHOTOS, MAX_IMAGE_BYTES, createFetcher, failure,
  reduceItem, matchItems, eraCategories, licenceOf, authorOf, photoFrom, thumbFor, widthFor, arrange, resolveMontage, creditText
}
