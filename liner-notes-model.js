// The liner notes booklet's model (no DOM, no Electron): Apple's album data reduced, the per-album
// cache entry and its refresh (createLinerNotes: which source is due, what failed, what the cache
// still holds), and the booklet itself (buildBooklet: sections of pages, every block with its source
// chip). liner-notes.html lays the pages out (pagination, the page turn); main.js fetches.
//
// Only what's real: a section with no data is not printed; a source that failed says so where its
// section would be and on the Sources page; nothing is made up to fill a page.
'use strict'
const S = require('./liner-notes-sources')

const TTL_MS = 30 * 24 * 3600 * 1000      // a source's answer is asked again after 30 days
const RETRY_MS = 10 * 60 * 1000           // a failed source is asked again after 10 minutes (at the next open)
const CACHE = { maxEntries: 150, maxBytes: 6 * 1024 * 1024 }   // liner-notes-cache.json (lyrics-store.js)
const ENTRY_VERSION = 1

// --- Apple's album (the page script in main.js returns the catalog's attributes) ---
const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" }
function decode(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z0-9]+);/gi, (m, e) => {
    if (e[0] === '#') { const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10); return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : m }
    return Object.prototype.hasOwnProperty.call(ENT, e.toLowerCase()) ? ENT[e.toLowerCase()] : m
  })
}
/** Apple's editorial notes (light HTML: <i>, <b>, <br />, <p>) -> plain paragraphs, nothing reworded. */
function notesParagraphs(html) {
  return String(html || '')
    .replace(/<\s*br\s*\/?\s*>|<\/\s*p\s*>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .split(/\n+/).map((p) => decode(p).replace(/\s+/g, ' ').trim()).filter(Boolean)
}
const str = (v, max) => (typeof v === 'string' ? v.slice(0, max || 400) : '')
const num = (v) => (Number.isFinite(v) ? v : 0)
/** The page script's album -> what the booklet keeps (types checked; text capped). */
function reduceApple(a) {
  if (!a || !/^\d+$/.test(String(a.id || ''))) return null
  const art = a.artwork && typeof a.artwork.url === 'string' && /^https:\/\//.test(a.artwork.url) ? { url: a.artwork.url, width: num(a.artwork.width), height: num(a.artwork.height) } : null
  const notes = a.editorialNotes || {}
  return {
    id: String(a.id),
    storefront: /^[a-z]{2}$/.test(a.storefront || '') ? a.storefront : 'us',
    name: str(a.name), artist: str(a.artistName), releaseDate: str(a.releaseDate, 20),
    label: str(a.recordLabel), copyright: str(a.copyright), upc: str(a.upc, 20).replace(/\D/g, ''),
    genres: Array.isArray(a.genreNames) ? a.genreNames.filter((g) => typeof g === 'string' && g !== 'Music').slice(0, 3) : [],
    url: /^https:\/\/music\.apple\.com\//.test(a.url || '') ? a.url : '',
    art,
    notesShort: str(notes.short, 300),
    notes: notesParagraphs(str(notes.standard, 20000)),
    tracks: (Array.isArray(a.tracks) ? a.tracks : []).slice(0, 400).map((t) => ({
      id: String(t.id || ''), name: str(t.name), artist: str(t.artistName), n: num(t.trackNumber), disc: num(t.discNumber) || 1,
      ms: num(t.durationInMillis), composer: str(t.composerName), hasLyrics: !!t.hasLyrics
    })).filter((t) => /^\d+$/.test(t.id))
  }
}

// --- the cache entry and its refresh ---
/** The cache key: one entry per album and Wikipedia language. */
const cacheKey = (appleId, lang) => 'album:' + appleId + ':' + lang
const isLive = (apple, mb) => !!((mb && mb.types.includes('Live')) || (apple && /\((live|en vivo|en directo|live at [^)]*)\b|\blive (at|in|from|on)\b/i.test(apple.name)))
/** The one recording date of a live album, when every track MusicBrainz knows shares it. */
function oneDate(mb) {
  if (!mb) return ''
  const dates = new Set()
  // loop: NOT-WORTH — the release's tracks (≤ ~100), once per refresh
  for (const m of mb.media) for (const t of m.tracks) if (t.date) dates.add(t.date.slice(0, 10))
  // loop: NOT-WORTH — the places (≤ a few)
  for (const p of mb.places) for (const d of p.dates) dates.add(d.slice(0, 10))
  return dates.size === 1 ? [...dates][0] : ''
}

/**
 * createLinerNotes({ getJson, store, now, lang, setlistKey(), log })
 *   .load(appleRaw, appleError, onUpdate, idHint) -> the entry: { v, appleId, lang, at, parts: { apple, mb, wikidata,
 *   wiki, caa, setlist } }, each part { state: 'ok' | 'none' | 'failed' | 'off', at, data?, how?, error?, stale? }.
 * onUpdate(entry, pending) is called with the cached entry first (pending: sources still being asked),
 * then once more when the refresh is done. A failed source keeps its last good answer (stale: true).
 */
function createLinerNotes(deps) {
  const now = deps.now || Date.now
  const inflight = new Map()
  const due = (p, t) => !p || (p.state === 'failed' ? t - p.at >= RETRY_MS : t - p.at >= TTL_MS)
  const fail = (prev, e, t) => Object.assign({}, prev && prev.data ? { data: prev.data, how: prev.how, stale: true, at0: prev.at0 || prev.at } : {}, { state: 'failed', at: t, error: S.failureText(e) })
  const ok = (data, how, t) => (data ? { state: 'ok', at: t, data, how } : { state: 'none', at: t })

  // only: 'mb' asks MusicBrainz alone (the Studio's song credits, songCredits below); the booklet asks every source
  async function refresh(entry, only) {
    const g = deps.getJson
    const P = entry.parts
    const apple = P.apple && P.apple.data
    if (!apple) return
    let t = now()
    if (due(P.mb, t)) {
      try {
        const m = await S.matchMusicBrainz(g, { appleId: apple.id, storefronts: [apple.storefront], upc: apple.upc })
        P.mb = m ? ok(await S.musicBrainzRelease(g, m.release), m.how, now()) : ok(null, '', now())
      } catch (e) { P.mb = fail(P.mb, e, now()); if (deps.log) deps.log('liner notes: MusicBrainz: ' + e.message) }   // error: SHOWN — the Credits page and Sources say MusicBrainz didn't load
    }
    if (only === 'mb') return
    const mb = P.mb && P.mb.data
    const jobs = []
    t = now()
    jobs.push((async () => {
      if (due(P.wikidata, t) || (P.wikidata && P.wikidata.state === 'none' && mb && P.wikidata.noRg)) {
        try {
          const w = await S.matchWikidata(g, { appleId: apple.id, releaseGroup: mb ? mb.releaseGroup : '' })
          if (w) {
            const keep = {}
            // loop: NOT-WORTH — two sitelinks kept (the UI language's and English)
            for (const site of [entry.lang + 'wiki', 'enwiki']) if (w.entity.sitelinks[site]) keep[site] = w.entity.sitelinks[site]
            P.wikidata = ok({ qid: w.qid, sitelinks: keep }, w.how, now())
          } else if (P.mb && P.mb.state === 'failed') {
            P.wikidata = fail(P.wikidata, S.failure('dep', 'MusicBrainz did not load'), now())
            P.wikidata.error = 'MusicBrainz didn\'t load, so the album couldn\'t be matched'
          } else {
            P.wikidata = Object.assign(ok(null, '', now()), mb ? {} : { noRg: true })
          }
        } catch (e) { P.wikidata = fail(P.wikidata, e, now()); if (deps.log) deps.log('liner notes: Wikidata: ' + e.message) }   // error: SHOWN — the Background page and Sources say Wikidata didn't load
      }
      const wd = P.wikidata && P.wikidata.data
      if (wd && (!P.wiki || due(P.wiki, now()) || P.wiki.qid !== wd.qid)) {
        try {
          const w = await S.wikipedia(g, { sitelinks: wd.sitelinks }, entry.lang)
          P.wiki = Object.assign(ok(w, '', now()), { qid: wd.qid })
        } catch (e) { P.wiki = Object.assign(fail(P.wiki, e, now()), { qid: wd.qid }); if (deps.log) deps.log('liner notes: Wikipedia: ' + e.message) }   // error: SHOWN — the Background page and Sources say Wikipedia didn't load
      } else if (!wd && P.wikidata && P.wikidata.state === 'none') P.wiki = { state: 'none', at: now() }
    })())
    if (mb && (due(P.caa, t) || (P.caa && P.caa.release0 !== mb.id))) {
      jobs.push((async () => {
        try {
          let caa = await S.coverArt(g, mb.id)
          let edition = ''
          if (!S.hasScans(caa) && mb.releaseGroup) {
            const pick = S.pickScanRelease(await S.releaseGroupReleases(g, mb.releaseGroup), { id: mb.id, barcode: apple.upc || mb.barcode }, apple.storefront)
            if (pick && pick.id !== mb.id) {
              const other = await S.coverArt(g, pick.id)
              if (S.hasScans(other)) { caa = other; edition = S.editionWords(pick) }
            }
          }
          P.caa = Object.assign(ok(caa.images.length ? Object.assign(caa, { edition }) : null, '', now()), { release0: mb.id })
        } catch (e) { P.caa = fail(P.caa, e, now()); if (deps.log) deps.log('liner notes: Cover Art Archive: ' + e.message) }   // error: SHOWN — the Booklet page and Sources say the scans didn't load
      })())
    } else if (!mb && P.mb && P.mb.state === 'none') P.caa = { state: 'none', at: now() }
    await Promise.all(jobs)
    // setlist.fm: only with the user's own key, only for a live album recorded on one date
    const key = deps.setlistKey ? deps.setlistKey() : ''
    const date = oneDate(mb)
    const artist = mb && mb.artists[0] ? mb.artists[0].id : ''
    if (!key) P.setlist = { state: 'off', at: now() }
    else if (!isLive(apple, mb) || !date || !artist) P.setlist = { state: 'none', at: now(), why: !isLive(apple, mb) ? 'studio' : 'dates' }
    else if (due(P.setlist, now()) || (P.setlist && P.setlist.state !== 'ok' && P.setlist.state !== 'failed') || (P.setlist && P.setlist.date !== date)) {
      try { P.setlist = Object.assign(ok(await S.setlistFm(g, key, artist, date), '', now()), { date }) } catch (e) { P.setlist = Object.assign(fail(P.setlist, e, now()), { date }); if (deps.log) deps.log('liner notes: setlist.fm: ' + e.message) }   // error: SHOWN — the Recording page and Sources say setlist.fm didn't load
    }
  }

  // load(appleRaw, appleError, onUpdate, idHint, only): appleRaw is the page script's album, or null when Apple
  // didn't answer (appleError says why); idHint is then the album's ID, if known, for its cached copy.
  // only 'mb': MusicBrainz alone (the Studio's credits); the other sources stay due for the booklet
  function load(appleRaw, appleError, onUpdate, idHint, only) {
    const apple = appleRaw ? reduceApple(appleRaw) : null
    const appleId = apple ? apple.id : (/^\d+$/.test(String(idHint || '')) ? String(idHint) : '')
    if (!appleId) {
      const entry = { v: ENTRY_VERSION, appleId: '', lang: deps.lang, at: now(), parts: { apple: { state: 'failed', at: now(), error: S.failureText(appleError) || 'the album wasn\'t found' } } }
      onUpdate(entry, false)
      return Promise.resolve(entry)
    }
    const key = cacheKey(appleId, deps.lang)
    // a booklet's refresh in flight answers the Studio too (it asks MusicBrainz first)
    const job0 = inflight.get(key) || (only === 'mb' ? inflight.get(key + '|mb') : null)
    if (job0) return job0.then((e) => { onUpdate(e, false); return e })
    const stored = deps.store.get(key)
    const entry = stored && stored.v === ENTRY_VERSION ? JSON.parse(JSON.stringify(stored)) : { v: ENTRY_VERSION, appleId, lang: deps.lang, parts: {} }
    const t = now()
    if (apple) entry.parts.apple = { state: 'ok', at: t, data: apple }
    else entry.parts.apple = fail(entry.parts.apple, appleError || S.failure('offline', 'no album'), t)
    const P = entry.parts
    const slKey = deps.setlistKey ? deps.setlistKey() : ''
    const setlistDue = !P.setlist || (slKey ? P.setlist.state === 'off' || due(P.setlist, t) : P.setlist.state !== 'off')
    const pending = !!(P.apple.data && (only === 'mb' ? due(P.mb, t) : setlistDue || ['mb', 'wikidata', 'wiki', 'caa'].some((k) => due(P[k], t))))
    onUpdate(entry, pending)
    if (!pending) {
      if (apple) deps.store.set(key, entry)
      return Promise.resolve(entry)
    }
    const fly = only === 'mb' ? key + '|mb' : key
    const job = refresh(entry, only).then(() => {
      entry.at = now()
      deps.store.set(key, entry)
      inflight.delete(fly)
      onUpdate(entry, false)
      return entry
    }, (e) => {
      // error: LOGGED-OK — a bug in a reducer: logged; the booklet keeps what it had (each source catches its own failures above)
      inflight.delete(fly)
      if (deps.log) deps.log('liner notes: refresh failed: ' + (e && e.stack ? e.stack : e))
      onUpdate(entry, false)
      return entry
    })
    inflight.set(fly, job)
    return job
  }
  return { load }
}

// --- the booklet ---
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
/** '1993-11-18' -> 'Thursday, November 18, 1993'; '1993-11' -> 'November 1993'; '1993' -> '1993' */
function fmtDate(d, weekday) {
  const m = /^(\d{4})(?:-(\d{2}))?(?:-(\d{2}))?/.exec(d || '')
  if (!m) return ''
  if (!m[2]) return m[1]
  if (!m[3]) return MONTHS[+m[2] - 1] + ' ' + m[1]
  const day = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])).getUTCDay()
  return (weekday ? DAYS[day] + ', ' : '') + MONTHS[+m[2] - 1] + ' ' + (+m[3]) + ', ' + m[1]
}
const fmtLen = (ms) => { const s = Math.round(ms / 1000); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0') }
function fmtTotal(ms) {
  const m = Math.round(ms / 60000)
  return m >= 60 ? Math.floor(m / 60) + ' h ' + (m % 60) + ' min' : m + ' min'
}
const and = (names) => (names.length <= 1 ? names.join('') : names.slice(0, -1).join(', ') + ' & ' + names[names.length - 1])
const norm = (s) => String(s || '').toLowerCase().replace(/\s*[([].*?[)\]]\s*/g, ' ').replace(/[^\p{L}\p{N}]+/gu, '')

/** Apple's tracks with their MusicBrainz track (by disc and position when the counts agree, else by title). */
function pairTracks(apple, mb) {
  const flat = mb ? mb.media.flatMap((m) => m.tracks.map((t) => Object.assign({ disc: m.position }, t))) : []
  const byPos = flat.length === apple.tracks.length
  return apple.tracks.map((t, i) => {
    let m = null
    if (byPos) m = flat[i]
    if (!m || (norm(m.title) !== norm(t.name) && !norm(t.name).startsWith(norm(m.title)) && !norm(m.title).startsWith(norm(t.name)))) {
      m = flat.find((x) => norm(x.title) === norm(t.name)) || (byPos ? flat[i] : null)
    }
    return { apple: t, mb: m }
  })
}
const chip = (who, what, href) => ({ who, what: what || '', href: href || '' })
const APPLE_CHIP = (what) => chip('Apple Music', what)
const MB_CHIP = (what, id) => chip('MusicBrainz', (what ? what + ' · ' : '') + 'CC0', id ? 'https://musicbrainz.org/release/' + id : '')
function failNote(name, part, still) {
  return { t: 'note', text: name + ' didn\'t load: ' + (part.error || 'it failed') + '. ' + (part.stale ? 'Showing the copy saved ' + fmtDate(new Date(part.at0 || part.at).toISOString().slice(0, 10)) + '.' : (still || 'Sonata asks again the next time you open this booklet.')) }
}
function writersLine(pair) {
  const w = pair.mb ? pair.mb.writers : []
  if (w.length) {
    const by = (role) => w.filter((x) => x.role === role).map((x) => x.name)
    const music = by('music'); const words = by('words'); const written = by('written by')
    const parts = []
    if (written.length) parts.push('Written by ' + and(written))
    if (music.length && words.length && music.join() === words.join()) parts.push('Words and music: ' + and(music))
    else {
      if (music.length) parts.push('Music: ' + and(music))
      if (words.length) parts.push('Words: ' + and(words))
    }
    if (parts.length) return { text: parts.join(' · '), src: 'mb' }
  }
  if (pair.apple.composer) return { text: 'Written by ' + pair.apple.composer, src: 'apple' }
  return { text: '', src: '' }
}
/** Lyric lines -> stanzas (a break at an empty line, or a pause of 4 s or more). */
function stanzas(lines) {
  const out = []
  let cur = []
  let lastEnd = null
  lines.forEach((l, i) => {   // loop: NOT-WORTH — one song's lines (≤ ~150), once per booklet build
    if (!l || l.gap || !String(l.text || '').trim()) { if (cur.length) out.push(cur); cur = []; lastEnd = null; return }
    if (cur.length && Number.isFinite(l.t) && lastEnd !== null && l.t - lastEnd >= 4) { out.push(cur); cur = [] }
    cur.push({ i, text: String(l.text).trim(), t: Number.isFinite(l.t) ? l.t : null })
    lastEnd = Number.isFinite(l.end) ? l.end : (Number.isFinite(l.t) ? l.t + 2 : lastEnd)
  })
  if (cur.length) out.push(cur)
  return out
}

/**
 * buildBooklet(entry, { lyrics, version }) -> { head, sections: [{ id, name, pages }], status }
 *   lyrics: { [appleSongId]: { lines, source, writers } } (the songs of this album in the lyrics cache)
 * A page: { kind: 'tray' | 'front' | 'flow' | 'scan' | 'back' | 'sources', ... , chips: [{ who, what, href }] }
 * A flow page's blocks paginate in the booklet: kicker / title / dek on its first page, chips on every page.
 */
function buildBooklet(entry, ctx) {
  const c = ctx || {}
  const P = entry.parts || {}
  const apple = P.apple && P.apple.data
  const sections = []
  const add = (id, name, pages) => { if (pages.length) sections.push({ id, name, pages }) }
  if (!apple) {
    add('back', 'Sources', [{ kind: 'flow', kicker: 'Liner notes', title: 'This booklet didn\'t open', blocks: [failNote('Apple Music\'s album details', P.apple || {}, 'Sonata asks again the next time you open it.')], chips: [APPLE_CHIP('album details')] }])
    return { head: { title: 'Liner notes', artist: '', line: '' }, sections, status: [] }
  }
  const mbP = P.mb || { state: 'none' }
  const mb = mbP.data || null
  const live = isLive(apple, mb)
  const pairs = pairTracks(apple, mb)
  const totalMs = apple.tracks.reduce((s, t) => s + t.ms, 0)
  const discs = new Set(apple.tracks.map((t) => t.disc)).size
  const caa = P.caa && P.caa.data
  const scans = caa ? caa.images : []
  const ofType = (t) => scans.filter((i) => i.types.includes(t))
  const caaChip = (what) => chip('Cover Art Archive', what + (caa && caa.edition ? ', from ' + caa.edition : ''), scans[0] ? scans[0].page : '')
  const year = (apple.releaseDate || '').slice(0, 4)
  const head = { title: apple.name, artist: apple.artist, line: [apple.artist, year, apple.tracks.length + ' tracks', fmtTotal(totalMs)].filter(Boolean).join(' · '), art: apple.art }

  // Cover: the disc in its tray (the real disc scan when there is one) and the front cover
  const medium = ofType('Medium')[0] || null
  add('cover', 'Cover', [
    { kind: 'tray', scan: medium ? medium.thumbs : null, art: apple.art, caption: (discs > 1 ? discs + ' discs' : 'Disc 1') + ' · ' + apple.tracks.length + ' tracks · ' + fmtTotal(totalMs),
      chips: [medium ? caaChip('disc scan') : APPLE_CHIP('artwork')], alt: medium ? 'The disc (scan)' : 'The album cover as the disc label' },
    { kind: 'front', art: apple.art, alt: 'Front cover: ' + apple.name, chips: [APPLE_CHIP('artwork')] }
  ])

  // Notes: Apple's editorial notes, as Apple wrote them
  if (apple.notes.length) {
    add('notes', 'Notes', [{ kind: 'flow', kicker: 'Editorial notes', title: apple.notesShort || apple.name, titleIsDek: !!apple.notesShort,
      blocks: apple.notes.map((text) => ({ t: 'p', text })), chips: [APPLE_CHIP('editorial notes')] }])
  }

  // Recording: where and when (MusicBrainz), the release (Apple), the set (setlist.fm or the album)
  const facts = []
  const places = mb ? mb.places.filter((p) => /recorded/.test(p.relation)).sort((a, b) => b.tracks - a.tracks) : []
  const dates = new Set()
  if (mb) mb.media.forEach((m) => m.tracks.forEach((t) => { if (t.date) dates.add(t.date.slice(0, 10)) }))   // loop: NOT-WORTH — the tracks, once
  places.forEach((p) => p.dates.forEach((d) => dates.add(d.slice(0, 10))))   // loop: NOT-WORTH — a few places
  const sl = P.setlist && P.setlist.state === 'ok' ? P.setlist.data : null
  const ds = [...dates].sort()
  if (ds.length === 1) facts.push(['Date', fmtDate(ds[0], true), 'mb'])
  else if (ds.length > 1) facts.push(['Dates', fmtDate(ds[0]) + ' – ' + fmtDate(ds[ds.length - 1]) + ' (' + ds.length + ' sessions)', 'mb'])
  if (places.length) facts.push([places.length > 1 ? (places.every((p) => p.type === 'Studio') ? 'Studios' : 'Places') : (places[0].type === 'Studio' ? 'Studio' : (live ? 'Venue' : 'Place')), places.slice(0, 3).map((p) => p.name + (p.address ? ', ' + p.address : (p.area ? ', ' + p.area : ''))).join('; '), 'mb'])
  if (sl && sl.venue && !places.length) facts.push(['Venue', sl.venue + (sl.city ? ', ' + sl.city : ''), 'setlist'])
  if (sl && sl.tour) facts.push(['Tour', sl.tour, 'setlist'])
  if (mb) mb.events.slice(0, 2).forEach((e) => facts.push(['Event', e.name + (e.date ? ' (' + fmtDate(e.date) + ')' : ''), 'mb']))   // loop: NOT-WORTH — ≤ 2
  if (apple.releaseDate) facts.push(['Released', fmtDate(apple.releaseDate, false), 'apple'])
  if (apple.label) facts.push(['Label', apple.label, 'apple'])
  const catno = mb ? mb.labels.map((l) => l.catno).filter((x) => x && !/^\[none\]$/i.test(x)) : []
  if (catno.length) facts.push(['Catalogue', catno.slice(0, 2).join(', '), 'mb'])
  if (apple.genres.length) facts.push(['Genre', apple.genres.join(', '), 'apple'])
  if (live) facts.push(['Set', apple.tracks.length + ' songs · ' + fmtTotal(totalMs), 'apple'])
  const recBlocks = [{ t: 'facts', rows: facts.map(([k, v]) => [k, v]) }]
  const recChips = []
  if (facts.some((f) => f[2] === 'mb')) recChips.push(MB_CHIP('recording', mb.id))
  if (facts.some((f) => f[2] === 'apple')) recChips.push(APPLE_CHIP('release'))
  if (mbP.state === 'failed' && !mb) recBlocks.push(failNote('MusicBrainz', mbP))
  if (live) {
    if (sl) {
      recBlocks.push({ t: 'h3', text: 'The set' + (sl.date ? ', ' + fmtDate(sl.date.split('-').reverse().join('-'), false) : '') })
      let n = 0
      sl.sets.forEach((set) => set.songs.forEach((s) => { n++; recBlocks.push({ t: 'li', group: 'setlist', n, text: s.name + (s.cover ? ' (' + s.cover + ' cover)' : ''), enc: set.encore ? 'encore' + (set.encore > 1 ? ' ' + set.encore : '') : '' }) }))   // loop: NOT-WORTH — one show's songs
      recChips.push(chip('setlist.fm', 'setlist', sl.url))
    } else {
      if (P.setlist && P.setlist.state === 'failed') recBlocks.push(failNote('setlist.fm', P.setlist, 'The set below is the album\'s own track list.'))
      recBlocks.push({ t: 'h3', text: 'The set, as on the album' })
      apple.tracks.forEach((t, i) => recBlocks.push({ t: 'li', group: 'setlist', n: i + 1, text: t.name, song: t.id }))   // loop: NOT-WORTH — the album's tracks
      if (!recChips.some((x) => x.who === 'Apple Music')) recChips.push(APPLE_CHIP('track list'))
    }
  }
  const recTitle = live ? (places[0] ? places[0].name : (sl && sl.venue) || 'Live') : (places.length ? 'Recorded at ' + places[0].name : 'The release')
  add('recording', live ? 'Recording' : 'Release', [{ kind: 'flow', kicker: live ? 'The recording' : (places.length ? 'The recording' : 'The release'), title: recTitle, blocks: recBlocks, chips: recChips }])

  // Background: the album's Wikipedia article (matched through Wikidata), trimmed, attributed
  const wdP = P.wikidata || { state: 'none' }
  const wkP = P.wiki || { state: 'none' }
  const wiki = wkP.data || null
  if (wiki) {
    const blocks = []
    if (wiki.summary) blocks.push({ t: 'dek', text: wiki.summary })
    wiki.sections.forEach((s) => { blocks.push({ t: 'h3', text: s.heading }); s.paras.forEach((p) => blocks.push({ t: 'p', text: p })) })   // loop: NOT-WORTH — ≤ ~8 sections
    if (wkP.state === 'failed') blocks.push(failNote('Wikipedia', wkP))
    const chips = [chip('Wikipedia', '“' + wiki.title + '”' + (wiki.trimmed ? ', trimmed' : ''), wiki.url), chip(wiki.license.name, 'licence', wiki.license.url)]
    if (P.wikidata && P.wikidata.data) chips.push(chip('Wikidata', P.wikidata.data.qid + ' · CC0', 'https://www.wikidata.org/wiki/' + P.wikidata.data.qid))
    add('background', 'Background', [{ kind: 'flow', kicker: 'Wikipedia' + (wiki.lang !== 'en' ? ' (' + wiki.lang + ')' : ''), title: wiki.title, blocks, chips, lang: wiki.lang }])
  } else if (wkP.state === 'failed' || wdP.state === 'failed') {
    add('background', 'Background', [{ kind: 'flow', kicker: 'Wikipedia', title: 'Background', blocks: [failNote(wdP.state === 'failed' ? 'Wikidata' : 'Wikipedia', wdP.state === 'failed' ? wdP : wkP)], chips: [chip('Wikipedia', 'CC BY-SA 4.0')] }])
  }

  // Credits: personnel and production (MusicBrainz), then every track with its writers
  const people = new Map()   // name -> { roles: [], tracks: Set }
  const crew = new Map()     // role -> [names]
  const addCrew = (role, name) => { if (!crew.has(role)) crew.set(role, []); if (!crew.get(role).includes(name)) crew.get(role).push(name) }
  pairs.forEach((p, i) => {   // loop: NOT-WORTH — the album's tracks, once per build
    if (!p.mb) return
    p.mb.performers.forEach((x) => {   // loop: NOT-WORTH — one track's performers
      if (!people.has(x.name)) people.set(x.name, { roles: [], tracks: new Set() })
      const e = people.get(x.name)
      x.role.replace(/ \(guest\)/g, '').split(', ').forEach((r) => { if (!e.roles.includes(r)) e.roles.push(r) })   // loop: NOT-WORTH — a few roles (a guest is listed under With)
      e.tracks.add(i)
    })
    p.mb.crew.forEach((x) => addCrew(x.role, x.name))   // loop: NOT-WORTH — one track's crew
  })
  if (mb) mb.credits.forEach((x) => addCrew(x.role, x.name))   // loop: NOT-WORTH — the release's credits
  const matched = pairs.filter((p) => p.mb).length
  const core = [...people.entries()].filter(([, e]) => e.tracks.size >= Math.max(1, matched / 2))
  const guests = [...people.entries()].filter(([, e]) => e.tracks.size < Math.max(1, matched / 2))
  const credBlocks = []
  core.sort((a, b) => b[1].tracks.size - a[1].tracks.size)
  core.forEach(([name, e]) => credBlocks.push({ t: 'person', group: 'people', name, roles: e.roles.join(', ') }))   // loop: NOT-WORTH — the band
  if (guests.length) {
    credBlocks.push({ t: 'h3', text: 'With' })
    guests.forEach(([name, e]) => credBlocks.push({ t: 'person', group: 'guests', name, roles: e.roles.join(', ') + ' (' + e.tracks.size + (e.tracks.size === 1 ? ' track' : ' tracks') + ')' }))   // loop: NOT-WORTH — the guests
  }
  if (crew.size) credBlocks.push({ t: 'prod', items: [...crew.entries()].slice(0, 12).map(([role, names]) => [role, and(names.slice(0, 6))]) })
  if (mbP.state === 'failed') credBlocks.push(failNote('MusicBrainz', mbP, 'The songwriters below are Apple\'s.'))
  const anyMbWriters = pairs.some((p) => p.mb && p.mb.writers.length)
  const anyAppleWriters = pairs.some((p) => p.apple.composer && !(p.mb && p.mb.writers.length))
  credBlocks.push({ t: 'h3', text: 'Track by track' })
  const coreNames = new Set(core.map(([n]) => n))
  pairs.forEach((p, i) => {   // loop: NOT-WORTH — the album's tracks
    const w = writersLine(p)
    const withWho = p.mb ? p.mb.performers.filter((x) => !coreNames.has(x.name)) : []
    const withText = withWho.length ? 'With ' + and([...new Set(withWho.map((x) => x.name))].map((n) => n + ' (' + [...new Set(withWho.filter((x) => x.name === n).map((x) => x.role.replace(/ \(guest\)/g, '')))].join(', ') + ')')) : ''
    credBlocks.push({ t: 'track', group: 'tracks', n: p.apple.n || i + 1, disc: discs > 1 ? p.apple.disc : 0, title: p.apple.name, sub: w.text, with: withText, len: p.apple.ms ? fmtLen(p.apple.ms) : '', song: p.apple.id })
  })
  const credChips = []
  if (people.size || crew.size || anyMbWriters) credChips.push(MB_CHIP('credits', mb && mb.id))
  if (anyAppleWriters || !anyMbWriters) credChips.push(APPLE_CHIP('track list, songwriters'))
  add('credits', 'Credits', [{ kind: 'flow', kicker: people.size ? 'Personnel' : 'Credits', title: people.size ? (live ? 'On stage' : 'The musicians') : 'Songs & writers', blocks: credBlocks, chips: credChips }])

  // Lyrics: the album's songs whose lyrics are on this computer (the lyrics cache), stanza by stanza
  const lyr = c.lyrics || {}
  const lyricPages = []
  pairs.forEach((p, i) => {   // loop: NOT-WORTH — the album's tracks
    const L = lyr[p.apple.id]
    if (!L || !Array.isArray(L.lines) || !L.lines.length) return
    const w = L.writers && L.writers.length ? 'Written by ' + and(L.writers) : writersLine(p).text
    const blocks = stanzas(L.lines).map((st) => ({ t: 'stanza', song: p.apple.id, lines: st.map((x) => ({ i: x.i, text: x.text })) }))
    if (!blocks.length) return
    if (w) blocks.unshift({ t: 'by', text: w })
    lyricPages.push({ kind: 'flow', kicker: 'Track ' + (p.apple.n || i + 1) + (discs > 1 ? ' · disc ' + p.apple.disc : ''), title: p.apple.name, blocks, song: p.apple.id,
      chips: [L.source === 'lrclib' ? chip('LRCLIB', 'lyrics', 'https://lrclib.net') : APPLE_CHIP('lyrics')] })
  })
  add('lyrics', 'Lyrics', lyricPages)

  // Booklet: the real booklet and tray scans (Cover Art Archive), one per page
  const bookletScans = scans.filter((i) => !i.front && !i.back && i.types.some((t) => /Booklet|Tray|Obi|Liner|Poster|Sticker/.test(t))).slice(0, 16)
  const scanPages = bookletScans.map((img, k) => ({ kind: 'scan', img: img.thumbs, alt: (img.types.join(', ') || 'Scan') + (img.comment ? ': ' + img.comment : '') + ' (scan ' + (k + 1) + ' of ' + bookletScans.length + ')',
    chips: [caaChip((img.types.join(', ') || 'scan').toLowerCase() + (img.comment ? ' (' + img.comment + ')' : ''))] }))
  if (!scanPages.length && P.caa && P.caa.state === 'failed') scanPages.push({ kind: 'flow', kicker: 'The booklet', title: 'Booklet scans', blocks: [failNote('The Cover Art Archive', P.caa)], chips: [chip('Cover Art Archive', 'scans')] })
  add('booklet', 'Booklet', scanPages)

  // Back: where every page came from, and the back cover (the real scan, or the track list)
  const status = sourcesStatus(entry, { live, lyrics: lyricPages.length, tracks: apple.tracks.length, scans: scans.length })
  const backScan = scans.find((i) => i.back) || ofType('Back')[0] || null
  const backList = apple.tracks.map((t, i) => ({ n: t.n || i + 1, title: t.name, song: t.id }))
  add('back', 'Back', [
    { kind: 'sources', rows: status, chips: [chip('Saved on this computer', 'for reading offline')] },
    backScan
      ? { kind: 'scan', img: backScan.thumbs, back: true, alt: 'Back cover (scan)', chips: [caaChip('back cover')] }
      : { kind: 'back', list: backList, fine: [apple.copyright, apple.label && apple.upc ? apple.label + ' · UPC ' + apple.upc : (apple.upc ? 'UPC ' + apple.upc : apple.label)].filter(Boolean), chips: [APPLE_CHIP('track list, copyright')] }
  ])
  return { head, sections, status }
}

/** The Sources page: one row per source with what it gave, or why not, in words. */
function sourcesStatus(entry, info) {
  const P = entry.parts
  const rows = []
  const when = (p) => (p && p.stale ? ' Showing the copy saved ' + fmtDate(new Date(p.at0 || p.at).toISOString().slice(0, 10)) + '.' : '')
  const row = (name, state, text, href) => rows.push({ name, state, text, href: href || '' })
  const said = (name, p, okText, noneText, href) => {
    if (!p) row(name, 'pending', 'Not asked yet.')
    else if (p.state === 'ok') row(name, 'ok', okText(p), href ? href(p) : '')
    else if (p.state === 'failed') row(name, 'failed', 'Didn\'t load: ' + (p.error || 'it failed') + '.' + when(p) + (p.stale ? '' : ' Sonata asks again next time.'))
    else if (p.state === 'off') row(name, 'off', noneText)
    else row(name, 'none', noneText)
  }
  said('Apple Music', P.apple, () => 'Track list, editorial notes, songwriters, release details and artwork.', 'Not available.')
  said('MusicBrainz', P.mb, (p) => 'Credits and recording details, matched by ' + (p.how === 'apple-url' ? 'its link to this Apple Music album' : 'the album\'s barcode') + '. CC0.', 'This album isn\'t in MusicBrainz yet (no release links to it or carries its barcode).', (p) => 'https://musicbrainz.org/release/' + p.data.id)
  said('Cover Art Archive', P.caa, (p) => p.data.images.length + (p.data.images.length === 1 ? ' scan' : ' scans') + (p.data.edition ? ' from ' + p.data.edition : '') + '. The images belong to their owners: shown here, never shared.', P.mb && P.mb.state === 'ok' ? 'No scans of this release yet.' : 'Needs the MusicBrainz match.', (p) => p.data.images[0] ? p.data.images[0].page : '')
  said('Wikidata', P.wikidata, (p) => p.data.qid + ', matched by ' + (p.how === 'P2281' ? 'its Apple Music album ID (P2281)' : 'the MusicBrainz release group (P436)') + '. CC0.', 'No Wikidata item carries this album\'s Apple Music ID or MusicBrainz release group.', (p) => 'https://www.wikidata.org/wiki/' + p.data.qid)
  said('Wikipedia', P.wiki, (p) => 'Text from the article “' + p.data.title + '” (' + p.data.lang + '.wikipedia.org) by its contributors, CC BY-SA 4.0' + (p.data.trimmed ? ', trimmed (whole paragraphs left out, nothing reworded)' : '') + '.', P.wikidata && P.wikidata.state === 'ok' ? 'No Wikipedia article for this album.' : 'Needs the Wikidata match.', (p) => p.data.url)
  said('setlist.fm', P.setlist, (p) => 'The set of ' + (p.data.venue || 'the show') + (p.data.date ? ', ' + p.data.date : '') + ', with your own API key.',
    P.setlist && P.setlist.state === 'off' ? 'Off: for live albums, add your own free API key in Settings → Integrations.' : (P.setlist && P.setlist.why === 'studio' ? 'Not a live album.' : (P.setlist && P.setlist.why === 'dates' ? 'Needs one recording date from MusicBrainz.' : 'No setlist for this show.')),
    (p) => p.data.url)
  row('Lyrics', info.lyrics ? 'ok' : 'none', info.lyrics ? info.lyrics + ' of ' + info.tracks + ' songs: the ones whose lyrics are on this computer (songs you have played).' : 'The lyrics of the songs you play from this album appear here.')
  return rows
}

// --- the Studio's song credits (the cover's back, stage-ui.js) ---
const FEAT = /[([]\s*(?:feat\.?|ft\.?|featuring)\s+([^)\]]+)[)\]]|\s(?:feat\.?|ft\.?|featuring)\s+(.+)$/i
/** 'Song (feat. A & B)' / 'Artist feat. A' -> 'A & B' (Apple's own words), else ''. */
function featuring(title, artist) {
  const m = FEAT.exec(String(title || '')) || FEAT.exec(String(artist || ''))
  return m ? (m[1] || m[2] || '').trim() : ''
}
const cap = (w) => w.charAt(0).toUpperCase() + w.slice(1)
// MusicBrainz crew roles as the back of the cover words them ('producer' -> 'Produced by')
const BY = { producer: 'Produced by', 'co-producer': 'Co-produced by', 'additional producer': 'Additional production', 'executive producer': 'Executive producer', mixing: 'Mixed by', mastering: 'Mastered by', recording: 'Recorded by', engineer: 'Engineered by', arrangement: 'Arranged by', remix: 'Remixed by', programming: 'Programming' }
const byWords = (role) => BY[role] || cap(role)
/**
 * songCredits(entry, song) -> { rows: [{ role, names, src: 'apple' | 'mb' }], chips, mb }: the playing song's
 * credits, only what's real. song: { id (Apple's catalog id), title, artist, composer (Apple's composerName) }.
 * entry: the album's liner-notes cache entry (or null: Apple's catalog only). Written by: MusicBrainz's
 * writers for this recording's work, else Apple's composerName; Performed by: Apple's artist, featuring
 * from Apple's title or artist; the musicians and the crew from this recording's MusicBrainz relations,
 * then the release's own crew where the recording names nobody for that role (marked 'album').
 */
function songCredits(entry, song) {
  const s = song || {}
  const rows = []
  const P = (entry && entry.parts) || {}
  const apple = P.apple && P.apple.data
  const mb = P.mb && P.mb.data
  let pair = null
  if (apple && mb) {
    const pairs = pairTracks(apple, mb)
    pair = pairs.find((p) => p.apple.id === String(s.id || '')) || pairs.find((p) => norm(p.apple.name) === norm(s.title)) || null
  }
  const track = pair ? pair.mb : null
  const w = writersLine({ apple: { composer: str(s.composer) || (pair ? pair.apple.composer : '') }, mb: track })
  if (w.text) {
    // writersLine's words split into rows: 'Written by A · Music: B' -> [Written by, A], [Music, B]
    // loop: NOT-WORTH — ≤ 3 parts, once per song
    for (const part of w.text.split(' · ')) {
      const m = /^(Written by|Words and music|Music|Words): ?(.*)$/.exec(part) || /^(Written by) (.*)$/.exec(part)
      if (m) rows.push({ role: m[1], names: m[2], src: w.src })
    }
  }
  if (str(s.artist)) rows.push({ role: 'Performed by', names: str(s.artist).replace(/\s(?:feat\.?|ft\.?|featuring)\s.+$/i, ''), src: 'apple' })
  const feat = featuring(s.title, s.artist)
  if (feat) rows.push({ role: 'Featuring', names: feat, src: 'apple' })
  if (track) {
    const people = new Map()
    // loop: NOT-WORTH — one recording's performers (≤ ~30)
    for (const x of track.performers) { if (!people.has(x.name)) people.set(x.name, []); people.get(x.name).push(x.role) }
    if (people.size) rows.push({ role: 'Musicians', names: [...people.entries()].map(([n, r]) => n + ' (' + [...new Set(r)].join(', ') + ')').join(', '), src: 'mb' })
    const crew = new Map()
    // loop: NOT-WORTH — one recording's crew (≤ ~20)
    for (const x of track.crew) { if (!crew.has(x.role)) crew.set(x.role, []); if (!crew.get(x.role).includes(x.name)) crew.get(x.role).push(x.name) }
    const album = new Map()
    // loop: NOT-WORTH — the release's own credits (≤ ~50), once per song
    for (const x of mb.credits) {
      if (crew.has(x.role) || !BY[x.role]) continue
      if (!album.has(x.role)) album.set(x.role, [])
      if (!album.get(x.role).includes(x.name)) album.get(x.role).push(x.name)
    }
    const order = (a, b) => (Object.keys(BY).indexOf(a[0]) + 1 || 99) - (Object.keys(BY).indexOf(b[0]) + 1 || 99)
    for (const [role, names] of [...crew.entries()].sort(order)) rows.push({ role: byWords(role), names: and(names.slice(0, 8)), src: 'mb' })   // loop: NOT-WORTH — a handful of roles
    for (const [role, names] of [...album.entries()].sort(order)) rows.push({ role: byWords(role), names: and(names.slice(0, 8)), src: 'mb', album: true })   // loop: NOT-WORTH — a handful of roles
  }
  const usesMb = rows.some((r) => r.src === 'mb')
  const chips = []
  if (rows.some((r) => r.src === 'apple')) chips.push(APPLE_CHIP('catalog'))
  if (usesMb) chips.push(MB_CHIP('credits', mb.id))
  return { rows, chips, mb: usesMb }
}

module.exports = { featuring, songCredits, TTL_MS, RETRY_MS, CACHE, ENTRY_VERSION, notesParagraphs, reduceApple, cacheKey, isLive, oneDate, createLinerNotes, fmtDate, fmtLen, pairTracks, stanzas, buildBooklet, sourcesStatus }
