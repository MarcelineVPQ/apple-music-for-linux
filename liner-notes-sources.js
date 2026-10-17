// The liner notes' outside sources (the booklet: liner-notes.html, opened by main.js openLinerNotes):
// matching an Apple Music album to MusicBrainz, Wikidata and Wikipedia by identifiers only, fetching
// politely, and reducing each answer to the little the booklet prints. No DOM, no Electron: main
// passes in its fetch (Electron's net.fetch), so node --test covers every match with fixtures.
//
// The matches (never a fuzzy title search):
//   Wikidata  the Apple Music album ID property P2281 (haswbstatement, then the item is read back and
//             must carry that exact ID); else the MusicBrainz release group's P436, read back the same way
//   MusicBrainz  the release whose URL relationship is this album's music.apple.com link; else the
//             release with this album's barcode (Apple's UPC, the same digits)
//   Wikipedia the Wikidata item's sitelink, in the UI language when that article exists, else English
//   Cover Art Archive  the matched release's scans; when it has no back or booklet, the release of the
//             same release group with the most of them (its edition is named on the page)
//   setlist.fm  only with the user's own API key (Settings → Integrations), for a live album recorded on
//             one date: the artist's MusicBrainz ID + that date
//
// Licences: MusicBrainz and Wikidata data are CC0; Wikipedia text is CC BY-SA 4.0 (shown with its
// title, a link and the licence, and only trimmed: whole paragraphs dropped, never reworded);
// Cover Art Archive images belong to their owners (shown, never redistributed); setlist.fm data is
// shown with a link to the setlist (its API terms). Etiquette: a User-Agent naming Sonata and the
// repo, one request at a time per host with a gap (MusicBrainz: 1 per 1.1 s), a short backoff on 503/429.
'use strict'

const REPO_URL = 'https://github.com/MarcelineVPQ/apple-music-for-linux'
const userAgent = (version) => 'Sonata/' + (version || '0') + ' (' + REPO_URL + ')'

// the gap between two requests to one host (ms)
const GAPS = { 'musicbrainz.org': 1100, 'coverartarchive.org': 300, 'www.wikidata.org': 150, 'api.setlist.fm': 600 }
const gapFor = (host) => GAPS[host] || (/\.wikipedia\.org$/.test(host) ? 150 : 300)
const TIMEOUT_MS = 12000

const WIKI_LICENSE = { name: 'CC BY-SA 4.0', url: 'https://creativecommons.org/licenses/by-sa/4.0/' }

/** A fetch failure the booklet can say in words: kind 'offline' | 'timeout' | 'http' | 'bad'. */
function failure(kind, message, status) {
  const e = new Error(message)
  e.kind = kind
  if (status) e.status = status
  return e
}
/** The words for a failure, as the booklet shows them. */
function failureText(e) {
  if (!e) return ''
  if (e.kind === 'offline') return 'no connection'
  if (e.kind === 'timeout') return 'no answer in time'
  if (e.kind === 'http') return e.status === 503 || e.status === 429 ? 'the service is busy' : (e.status === 401 || e.status === 403 ? 'the key was refused' : 'it answered with an error (' + (e.status || '?') + ')')
  if (e.kind === 'bad') return 'its answer could not be read'
  if (e.kind === 'apple') return 'it didn\'t answer'
  return 'it failed'
}

/**
 * getJson(url, { headers, missingOk }) -> parsed JSON, or null for a 404 when missingOk.
 * One request at a time per host, each at least gapFor(host) after the last; a 503 or 429 is tried
 * again twice (after 2 s, then 4 s). deps: { fetch, ua, now, sleep, timeoutMs }.
 */
function createGetJson(deps) {
  const now = deps.now || Date.now
  const sleep = deps.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)))   // lifetime: OK — one-shot per wait
  const lanes = new Map()   // host -> { last, chain }
  return function getJson(url, opts) {
    const o = opts || {}
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
          const headers = Object.assign({ 'User-Agent': deps.ua, Accept: 'application/json' }, o.headers || {})
          const signal = typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? AbortSignal.timeout(deps.timeoutMs || TIMEOUT_MS) : undefined
          res = await deps.fetch(url, { headers, signal })
        } catch (e) {
          // error: PASSES-ON — no connection or no answer in time: the caller marks that source failed (shown in the booklet)
          throw failure(e && (e.name === 'TimeoutError' || e.name === 'AbortError') ? 'timeout' : 'offline', (e && e.message) || 'fetch failed')
        }
        if ((res.status === 503 || res.status === 429) && attempt < 2) { await sleep(2000 * (attempt + 1)); continue }
        if (res.status === 404 && o.missingOk) return null
        if (!res.ok) throw failure('http', 'HTTP ' + res.status + ' from ' + host, res.status)
        try { return await res.json() } catch (e) { throw failure('bad', 'not JSON from ' + host) }   // error: PASSES-ON — the caller marks the source failed
      }
    })
    // error: NOT-WORTH — the lane only orders requests; each caller gets its own failure from `run`
    lane.chain = run.catch(() => {})
    return run
  }
}

// --- small helpers ---
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const QID = /^Q\d+$/
const digits = (s) => String(s || '').replace(/\D/g, '').replace(/^0+/, '')
const claimValues = (entity, prop) => ((entity && entity.claims && entity.claims[prop]) || [])
  .map((c) => c && c.mainsnak && c.mainsnak.datavalue ? c.mainsnak.datavalue.value : null)
  .filter((v) => typeof v === 'string')
const https = (u) => String(u || '').replace(/^http:\/\//, 'https://')

/** The Wikipedia language for a UI locale ('en-US' -> 'en'; Norwegian Bokmål's wiki is 'no'). */
function wikiLang(locale) {
  const l = String(locale || 'en').toLowerCase().split(/[-_]/)[0]
  if (l === 'nb' || l === 'nn') return 'no'
  return /^[a-z]{2,3}$/.test(l) ? l : 'en'
}

// --- Wikidata ---
const WD_API = 'https://www.wikidata.org/w/api.php'
/** The items whose statement `prop` is exactly `value` (CirrusSearch haswbstatement: an exact match). */
async function wikidataByStatement(getJson, prop, value) {
  const url = WD_API + '?action=query&list=search&srlimit=3&format=json&srsearch=' + encodeURIComponent('haswbstatement:' + prop + '=' + value)
  const j = await getJson(url)
  const hits = ((j && j.query && j.query.search) || []).map((h) => h.title).filter((t) => QID.test(t))
  return hits
}
/** One item's statements and sitelinks, reduced. */
async function wikidataEntity(getJson, qid) {
  const j = await getJson(WD_API + '?action=wbgetentities&props=claims%7Csitelinks%2Furls&format=json&ids=' + encodeURIComponent(qid))
  return reduceEntity(j && j.entities ? j.entities[qid] : null)
}
function reduceEntity(e) {
  if (!e || !QID.test(e.id || '')) return null
  const sitelinks = {}
  // loop: NOT-WORTH — one entry per wiki the item has (≤ ~300), once per match
  for (const [site, s] of Object.entries(e.sitelinks || {})) if (/wiki$/.test(site) && s && s.title) sitelinks[site] = s.title
  return { qid: e.id, p2281: claimValues(e, 'P2281'), p436: claimValues(e, 'P436'), sitelinks }
}
/**
 * The Wikidata item for an album: P2281 (its Apple Music ID) first, else the MusicBrainz release
 * group's P436. Every hit is read back and must carry the exact ID (a search index can lag behind).
 * -> { qid, how: 'P2281' | 'P436', entity } | null
 */
async function matchWikidata(getJson, { appleId, releaseGroup }) {
  const tries = []
  if (/^\d+$/.test(String(appleId || ''))) tries.push(['P2281', String(appleId), 'p2281'])
  if (UUID.test(releaseGroup || '')) tries.push(['P436', releaseGroup, 'p436'])
  // loop: SERIAL-REQUIRED — at most 2 identifiers, the second only when the first finds nothing
  for (const [prop, value, field] of tries) {
    const hits = await wikidataByStatement(getJson, prop, value)
    // loop: SERIAL-REQUIRED — ≤ 3 hits, read back until one carries the exact ID (usually the first)
    for (const qid of hits) {
      const entity = await wikidataEntity(getJson, qid)
      if (entity && entity[field].includes(value)) return { qid, how: prop, entity }
    }
  }
  return null
}

// --- MusicBrainz ---
const MB = 'https://musicbrainz.org/ws/2/'
const RELEASE_INC = 'recordings+artist-credits+artist-rels+place-rels+event-rels+recording-level-rels+work-rels+work-level-rels+labels+release-groups'
/**
 * The MusicBrainz release of an Apple Music album: the release linked to its music.apple.com URL
 * (the storefronts given, then 'us'), else one with its barcode (Apple's UPC; leading zeros aside).
 * -> { release, how: 'apple-url' | 'barcode' } | null
 */
async function matchMusicBrainz(getJson, { appleId, storefronts, upc }) {
  if (/^\d+$/.test(String(appleId || ''))) {
    const sfs = [...new Set([...(storefronts || []), 'us'].filter((s) => /^[a-z]{2}$/.test(s)))]
    // loop: SERIAL-REQUIRED — ≤ 2 storefront spellings of the one link, the second only when the first isn't known
    for (const sf of sfs) {
      const j = await getJson(MB + 'url?fmt=json&inc=release-rels&resource=' + encodeURIComponent('https://music.apple.com/' + sf + '/album/' + appleId), { missingOk: true })
      const rel = ((j && j.relations) || []).find((r) => r['target-type'] === 'release' && r.release && UUID.test(r.release.id))
      if (rel) return { release: rel.release.id, how: 'apple-url' }
    }
  }
  const code = digits(upc)
  if (code.length >= 8) {
    const j = await getJson(MB + 'release?fmt=json&limit=10&query=' + encodeURIComponent('barcode:' + String(upc).replace(/\D/g, '')))
    const hit = ((j && j.releases) || []).find((r) => digits(r.barcode) === code && UUID.test(r.id))
    if (hit) return { release: hit.id, how: 'barcode' }
  }
  return null
}
async function musicBrainzRelease(getJson, id) {
  return reduceRelease(await getJson(MB + 'release/' + id + '?fmt=json&inc=' + RELEASE_INC))
}
/** The release group's releases with their Cover Art Archive counts (one page: ≤ 100). */
async function releaseGroupReleases(getJson, rgid) {
  const j = await getJson(MB + 'release?fmt=json&limit=100&inc=media&release-group=' + rgid)
  return ((j && j.releases) || []).map((r) => ({
    id: r.id, date: r.date || '', country: r.country || '', barcode: r.barcode || '',
    format: ((r.media || [])[0] || {}).format || '',
    art: r['cover-art-archive'] ? { count: r['cover-art-archive'].count || 0, back: !!r['cover-art-archive'].back, front: !!r['cover-art-archive'].front, darkened: !!r['cover-art-archive'].darkened } : null
  }))
}

// MusicBrainz relationship types as the booklet words them (the rest keep their own words)
const ROLE = {
  producer: 'producer', engineer: 'engineer', mix: 'mixing', recording: 'recording', mastering: 'mastering',
  'liner notes': 'liner notes', 'design/illustration': 'design', photography: 'photography', 'art direction': 'art direction',
  'graphic design': 'graphic design', design: 'design', illustration: 'illustration', programming: 'programming',
  arranger: 'arrangement', orchestrator: 'orchestration', conductor: 'conductor', performer: 'performer',
  'performing orchestra': 'orchestra', remixer: 'remix', 'audio director': 'audio director', 'sound': 'sound',
  'chorus master': 'chorus master', 'instrument arranger': 'arrangement', 'vocal arranger': 'vocal arrangement',
  'mix-DJ': 'DJ mix', editor: 'editing', balance: 'balance engineer', 'creative direction': 'creative direction'
}
const PERFORMING = new Set(['instrument', 'vocal', 'performer', 'performing orchestra', 'conductor'])
const WRITING = { composer: 'music', lyricist: 'words', writer: 'written by', librettist: 'libretto', translator: 'translation', arranger: 'arrangement' }

// one relationship's role words: 'guitar', 'lead vocals', 'additional producer', 'mixing'
function roleOf(r) {
  const credited = r['attribute-credits'] || {}
  const attrs = (r.attributes || []).map((a) => credited[a] || a)
  const extra = attrs.filter((a) => ['additional', 'assistant', 'associate', 'co', 'executive', 'guest', 'solo'].includes(a))
  const main = attrs.filter((a) => !extra.includes(a) && a !== 'task')
  let words
  if (r.type === 'instrument') words = main.length ? main.join(', ') : 'instruments'
  else if (r.type === 'vocal') words = main.length ? main.join(', ') : 'vocals'
  else words = ROLE[r.type] || r.type
  if (extra.includes('co')) words = 'co-' + words
  const pre = extra.filter((a) => !['co', 'guest', 'solo'].includes(a))
  if (pre.length) words = pre.join(' ') + ' ' + words
  if (extra.includes('solo')) words += ' (solo)'
  if (extra.includes('guest')) words += ' (guest)'
  return words
}
const nameOf = (r) => (r['target-credit'] || (r.artist && r.artist.name) || '').trim()

/** A MusicBrainz release, reduced to what the booklet prints. */
function reduceRelease(j) {
  if (!j || !UUID.test(j.id || '')) return null
  const rg = j['release-group'] || {}
  const credits = []   // release-level: [{ name, role }]
  const places = new Map()   // name -> { name, address, area, type, dates: Set, tracks: n }
  const events = new Map()
  const addPlace = (r) => {
    const p = r.place
    const key = p.id || p.name
    if (!places.has(key)) places.set(key, { name: p.name, address: p.address || '', area: (p.area && p.area.name) || '', type: p.type || '', dates: new Set(), tracks: 0, relation: r.type })
    const e = places.get(key)
    if (r.begin) e.dates.add(r.begin)
    if (r.end && r.end !== r.begin) e.dates.add(r.end)
    return e
  }
  // loop: NOT-WORTH — the release's own relationships (≤ ~50)
  for (const r of j.relations || []) {
    if (r['target-type'] === 'artist' && nameOf(r)) credits.push({ name: nameOf(r), role: roleOf(r) })
    else if (r['target-type'] === 'place' && r.place && /recorded|mixed/.test(r.type)) addPlace(r)
    else if (r['target-type'] === 'event' && r.event) events.set(r.event.id || r.event.name, { name: r.event.name, type: r.event.type || '', date: (r.event['life-span'] && r.event['life-span'].begin) || r.begin || '' })
  }
  const media = (j.media || []).map((m) => ({
    position: m.position || 1,
    format: m.format || '',
    title: m.title || '',
    tracks: (m.tracks || []).map((t) => {
      const rec = t.recording || {}
      const performers = []
      const crew = []
      const writers = []
      let work = ''
      let recordedAt = ''
      let date = ''
      // loop: NOT-WORTH — one recording's relationships (≤ ~40), once per release reduce
      for (const r of rec.relations || []) {
        if (r['target-type'] === 'artist' && nameOf(r)) {
          (PERFORMING.has(r.type) ? performers : crew).push({ name: nameOf(r), role: roleOf(r) })
          if (!date && r.begin && PERFORMING.has(r.type)) date = r.begin
        } else if (r['target-type'] === 'place' && r.place && /recorded/.test(r.type)) {
          const p = addPlace(r)
          p.tracks++
          recordedAt = p.name
          if (r.begin) date = r.begin
        } else if (r['target-type'] === 'event' && r.event) {
          events.set(r.event.id || r.event.name, { name: r.event.name, type: r.event.type || '', date: r.begin || '' })
        } else if (r['target-type'] === 'work' && r.work && r.type === 'performance') {
          work = r.work.title || ''
          if (!date && r.begin) date = r.begin
          // loop: NOT-WORTH — one work's relationships (≤ ~20)
          for (const w of r.work.relations || []) {
            if (w['target-type'] === 'artist' && WRITING[w.type] && w.artist) writers.push({ name: (w['target-credit'] || w.artist.name).trim(), role: WRITING[w.type] })
          }
        }
      }
      return {
        number: t.number || String(t.position || ''), position: t.position || 0, title: t.title || rec.title || '',
        length: t.length || rec.length || 0, recording: rec.id || '', work, performers, crew, writers: dedupe(writers), recordedAt, date
      }
    })
  }))
  const labels = (j['label-info'] || []).map((l) => ({ name: (l.label && l.label.name) || '', catno: l['catalog-number'] || '' })).filter((l) => l.name || l.catno)
  return {
    id: j.id, title: j.title || '', date: j.date || '', country: j.country || '', barcode: j.barcode || '',
    releaseGroup: rg.id || '', types: [rg['primary-type'], ...(rg['secondary-types'] || [])].filter(Boolean),
    artists: (j['artist-credit'] || []).map((a) => ({ name: a.name || (a.artist && a.artist.name) || '', id: (a.artist && a.artist.id) || '' })),
    labels, credits: dedupe(credits), media,
    places: [...places.values()].map((p) => ({ name: p.name, address: p.address, area: p.area, type: p.type, relation: p.relation, tracks: p.tracks, dates: [...p.dates].sort() })),
    events: [...events.values()]
  }
}
function dedupe(list) {
  const seen = new Set()
  return list.filter((x) => { const k = x.name + '|' + x.role; if (seen.has(k)) return false; seen.add(k); return true })
}

// --- Cover Art Archive ---
const CAA = 'https://coverartarchive.org/release/'
async function coverArt(getJson, releaseId) {
  return reduceCoverArt(await getJson(CAA + releaseId, { missingOk: true }), releaseId)
}
function reduceCoverArt(j, releaseId) {
  const images = ((j && j.images) || []).filter((i) => i && i.thumbnails).map((i) => ({
    id: String(i.id || ''),
    types: (i.types || []).slice(0, 4),
    front: !!i.front, back: !!i.back,
    comment: String(i.comment || '').slice(0, 120),
    thumbs: { 250: https(i.thumbnails['250'] || i.thumbnails.small), 500: https(i.thumbnails['500'] || i.thumbnails.large), 1200: https(i.thumbnails['1200'] || '') },
    page: 'https://musicbrainz.org/release/' + releaseId + '/cover-art'
  }))
  return { release: releaseId, images }
}
const hasScans = (caa) => !!caa && caa.images.some((i) => i.back || i.types.some((t) => /Booklet|Back|Tray|Medium/.test(t)))
/**
 * When the matched release has no back or booklet scan: the same album's release that has them. A
 * back cover first, then the same barcode as Apple's (the same pressing), then the storefront's
 * country, then the most scans, then the earliest.
 */
function pickScanRelease(releases, matched, country) {
  const m = releases.find((r) => r.id === matched.id)
  const ok = releases.filter((r) => r.art && r.art.count > 1 && !r.art.darkened)
  const code = digits(matched.barcode)
  const cc = String(country || '').toUpperCase()
  const score = (r) => [r.art.back ? 1 : 0, code && digits(r.barcode) === code ? 1 : 0, cc && r.country === cc ? 1 : 0, r.art.count]
  ok.sort((a, b) => {
    const x = score(a); const y = score(b)
    // loop: NOT-WORTH — 4 keys per comparison
    for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return y[i] - x[i]
    return String(a.date || '9999').localeCompare(String(b.date || '9999'))
  })
  return ok[0] || m || null
}
/** "the 1994 US CD": an edition in words (MusicBrainz's date, country and medium). */
function editionWords(r) {
  if (!r) return ''
  const country = r.country && !/^X[EW]$/.test(r.country) ? r.country : (r.country === 'XE' ? 'European' : '')
  const fmt = /CD/.test(r.format) ? 'CD' : (r.format || 'release').replace(/^12" /, '').replace(/^Digital Media$/, 'digital release')
  return ['the', (r.date || '').slice(0, 4), country, fmt].filter(Boolean).join(' ')
}

// --- Wikipedia ---
// the article sections the booklet prints, by their usual headings per language (case-insensitive starts)
const WIKI_SECTIONS = {
  en: ['background', 'recording', 'production', 'composition', 'music', 'release', 'reception', 'critical reception', 'legacy', 'concert', 'performance', 'live performances'],
  de: ['hintergrund', 'entstehung', 'aufnahme', 'produktion', 'musik', 'veröffentlichung', 'rezeption', 'kritik'],
  fr: ['historique', 'genèse', 'contexte', 'enregistrement', 'production', 'musique', 'sortie', 'accueil', 'réception'],
  es: ['antecedentes', 'grabación', 'producción', 'composición', 'lanzamiento', 'recepción'],
  it: ['storia', 'registrazione', 'produzione', 'composizione', 'pubblicazione', 'accoglienza'],
  nl: ['achtergrond', 'opname', 'productie', 'uitgave', 'ontvangst'],
  pt: ['antecedentes', 'gravação', 'produção', 'composição', 'lançamento', 'recepção'],
  sv: ['bakgrund', 'inspelning', 'produktion', 'utgivning', 'mottagande']
}
const MAX_PARAS = 3          // per section
const MAX_CHARS = 5200       // all sections together (the lead's summary aside)

function wikiTitleFor(entity, lang) {
  if (!entity) return null
  if (entity.sitelinks[lang + 'wiki']) return { lang, title: entity.sitelinks[lang + 'wiki'] }
  if (entity.sitelinks.enwiki) return { lang: 'en', title: entity.sitelinks.enwiki }
  return null
}
async function wikipedia(getJson, entity, uiLang) {
  const at = wikiTitleFor(entity, uiLang)
  if (!at) return null
  const host = 'https://' + at.lang + '.wikipedia.org'
  const summary = await getJson(host + '/api/rest_v1/page/summary/' + encodeURIComponent(at.title.replace(/ /g, '_')) + '?redirect=true', { missingOk: true })
  const ex = await getJson(host + '/w/api.php?action=query&prop=extracts%7Cinfo&inprop=url&explaintext=1&exsectionformat=wiki&redirects=1&format=json&formatversion=2&titles=' + encodeURIComponent(at.title))
  return reduceWikipedia(summary, ex, at.lang)
}
/** -> { lang, title, url, history, revision, summary, sections: [{ heading, paras }], trimmed, license } | null */
function reduceWikipedia(summary, ex, lang) {
  const page = ex && ex.query && ex.query.pages ? ex.query.pages[0] : null
  if (!page || page.missing || typeof page.extract !== 'string') return null
  const text = page.extract
  const parts = text.split(/\n(?==+ [^\n]+ =+\n)/)
  const paras = (s) => s.split(/\n+/).map((p) => p.trim()).filter((p) => p && !/^=+ .* =+$/.test(p))
  const lead = paras(parts[0] || '')
  const want = WIKI_SECTIONS[lang] || WIKI_SECTIONS.en
  const sections = []
  let used = 0
  let trimmed = false
  // loop: NOT-WORTH — one article's sections (≤ ~40), once per fetch
  for (const part of parts.slice(1)) {
    const m = /^(=+) ([^\n]+?) =+\n?/.exec(part)
    if (!m) continue
    const level = m[1].length
    const heading = m[2].trim()
    const body = paras(part.slice(m[0].length))
    if (level > 2 || !body.length) { if (level > 2) trimmed = true; continue }   // sub-sections are left out (trimmed); a heading alone isn't printed
    if (!want.some((w) => heading.toLowerCase().startsWith(w))) { trimmed = true; continue }
    const keep = []
    // loop: NOT-WORTH — ≤ MAX_PARAS paragraphs per section
    for (const p of body) {
      if (keep.length >= MAX_PARAS || used + p.length > MAX_CHARS) { trimmed = true; break }
      keep.push(p); used += p.length
    }
    if (keep.length < body.length) trimmed = true
    if (keep.length) sections.push({ heading, paras: keep })
  }
  const lead1 = summary && typeof summary.extract === 'string' && summary.extract.trim() ? summary.extract.trim() : (lead[0] || '')
  if (lead.length > 1 || parts.length > 1) trimmed = true
  const title = page.title || (summary && summary.title) || ''
  const url = https(page.fullurl || (summary && summary.content_urls && summary.content_urls.desktop && summary.content_urls.desktop.page) || ('https://' + lang + '.wikipedia.org/wiki/' + encodeURIComponent(title.replace(/ /g, '_'))))
  if (!lead1 && !sections.length) return null
  return {
    lang, title, url, history: url + (url.includes('?') ? '&' : '?') + 'action=history',
    revision: String(page.lastrevid || (summary && summary.revision) || ''),
    summary: lead1, sections, trimmed, license: WIKI_LICENSE
  }
}

// --- setlist.fm (the user's own key only) ---
async function setlistFm(getJson, key, artistMbid, date) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date || '')
  if (!key || !UUID.test(artistMbid || '') || !m) return null
  const j = await getJson('https://api.setlist.fm/rest/1.0/search/setlists?artistMbid=' + artistMbid + '&date=' + m[3] + '-' + m[2] + '-' + m[1] + '&p=1',
    { headers: { 'x-api-key': key, 'Accept-Language': 'en' }, missingOk: true })
  return reduceSetlist(j)
}
function reduceSetlist(j) {
  const s = j && Array.isArray(j.setlist) ? j.setlist.find((x) => x && x.sets && Array.isArray(x.sets.set) && x.sets.set.length) : null
  if (!s) return null
  const v = s.venue || {}
  const city = v.city || {}
  return {
    url: https(s.url || ''),
    date: s.eventDate || '',
    venue: v.name || '',
    city: [city.name, city.stateCode, city.country && city.country.name].filter(Boolean).join(', '),
    tour: (s.tour && s.tour.name) || '',
    sets: s.sets.set.map((x) => ({ name: x.name || '', encore: x.encore || 0, songs: (x.song || []).map((g) => ({ name: g.name || '', info: g.info || '', cover: (g.cover && g.cover.name) || '' })).filter((g) => g.name) }))
  }
}

module.exports = {
  REPO_URL, userAgent, GAPS, gapFor, WIKI_LICENSE, failure, failureText, createGetJson, wikiLang,
  wikidataByStatement, wikidataEntity, reduceEntity, matchWikidata,
  matchMusicBrainz, musicBrainzRelease, releaseGroupReleases, reduceRelease, roleOf,
  coverArt, reduceCoverArt, hasScans, pickScanRelease, editionWords,
  wikiTitleFor, wikipedia, reduceWikipedia, setlistFm, reduceSetlist
}
