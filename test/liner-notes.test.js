// The liner notes' data (liner-notes-sources.js, liner-notes-model.js), with no network: real answers
// of each service saved as fixtures (test/fixtures/liner/, trimmed; the album is Nirvana's MTV Unplugged
// in New York, Apple Music 1440892370, fetched 2026-10-17; setlist.fm's answer is written from its API
// documentation, as no key is used here). What is checked:
//   - the matches: Wikidata by P2281, else by the MusicBrainz release group (P436), each read back; never
//     a title search; MusicBrainz by the Apple Music link, else the barcode;
//   - the attribution: Wikipedia's title, link and licence on its pages and on Sources; every page has a source chip;
//   - only what's real: no section without data, Apple's notes as Apple wrote them;
//   - the cache: bounded, per album; offline and failed sources said per section, the saved copy kept;
//   - the etiquette: Sonata's User-Agent, one request at a time per host with its gap, the busy retry.
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')
const S = require('../liner-notes-sources')
const M = require('../liner-notes-model')
const { createLyricsStore } = require('../lyrics-store')

const FIX = path.join(__dirname, 'fixtures', 'liner')
const fx = (f) => JSON.parse(fs.readFileSync(path.join(FIX, f), 'utf8'))
const APPLE_ID = '1440892370'
const RG = 'fb3770f6-83fb-32b7-85c4-1f522a92287e'
const REL = '195973ed-07eb-4db0-951b-515fdb6dc20c'
const SCAN_REL = '5ad5a11d-c5fa-4db9-8b22-5071b034c507'
const ARTIST = '5b11f4ce-a62d-471e-81fc-a69a8278c7da'

// setlist.fm's search answer, in the shape of its API documentation (api.setlist.fm/docs/1.0)
const SETLIST = { type: 'setlists', itemsPerPage: 20, page: 1, total: 1, setlist: [{ id: '63d9e2a3', eventDate: '18-11-1993', artist: { mbid: ARTIST, name: 'Nirvana' },
  venue: { name: 'Sony Music Studios', city: { name: 'New York', stateCode: 'NY', country: { code: 'US', name: 'United States' } } },
  tour: { name: 'In Utero Tour' }, sets: { set: [{ song: [{ name: 'About a Girl' }, { name: 'Come as You Are' }] }, { encore: 1, song: [{ name: 'Where Did You Sleep Last Night', cover: { name: 'Lead Belly' } }] }] },
  url: 'https://www.setlist.fm/setlist/nirvana/1993/sony-music-studios-new-york-ny-63d9e2a3.html' }] }

// the services, answered from the fixtures: url -> json | null (404) | an Error to throw
function routes(extra) {
  const base = ({
    'haswbstatement%3AP2281%3D1440892370': fx('wd-p2281-none.json'),
    ['haswbstatement%3AP436%3D' + RG]: fx('wd-p436-hit.json'),
    'ids=Q212326': fx('wd-Q212326.json'),
    'haswbstatement%3AP2281%3D1440783617': fx('wd-p2281-hit.json'),
    'ids=Q17444': fx('wd-Q17444.json'),
    'musicbrainz.org/ws/2/url?': fx('mb-url.json'),
    'query=barcode': fx('mb-barcode.json'),
    ['musicbrainz.org/ws/2/release/' + REL]: fx('mb-release.json'),
    ['release-group=' + RG]: fx('mb-browse.json'),
    ['coverartarchive.org/release/' + REL]: fx('caa-digital.json'),
    ['coverartarchive.org/release/' + SCAN_REL]: fx('caa-cd.json'),   // a CD's scans (the release ID is the caller's)
    'rest_v1/page/summary/MTV_Unplugged_in_New_York': fx('wp-summary.json'),
    'prop=extracts': fx('wp-extract.json'),
    'api.setlist.fm': SETLIST
  })
  // the test's own answers first (the first fixture whose key is in the URL answers)
  const r = Object.assign({}, extra || {})
  // loop: test only
  for (const k of Object.keys(base)) if (!(k in r)) r[k] = base[k]
  const calls = []
  const getJson = async (url, opts) => {
    calls.push({ url, opts })
    const k = Object.keys(r).find((x) => url.includes(x))
    if (!k) throw new Error('no fixture for ' + url)
    const v = r[k]
    if (v instanceof Error) throw v
    if (v === null) { if (opts && opts.missingOk) return null; throw S.failure('http', '404', 404) }
    return JSON.parse(JSON.stringify(v))
  }
  return { getJson, calls }
}
const memStore = () => { const m = new Map(); return { get: (k) => m.get(k) || null, set: (k, v) => m.set(k, JSON.parse(JSON.stringify(v))), m } }
const clock = (t0) => { let t = t0; return { now: () => t, add: (ms) => { t += ms } } }
async function loaded(L, raw, err, hint) {
  const seen = []
  const entry = await L.load(raw, err, (e, pending) => seen.push({ e: JSON.parse(JSON.stringify(e)), pending }), hint)
  return { entry, seen }
}
const allText = (b) => JSON.stringify(b.sections)

// --- the matches ---
test('Wikidata: the Apple Music album ID (P2281) first, read back from the item', async () => {
  const { getJson, calls } = routes()
  const m = await S.matchWikidata(getJson, { appleId: '1440783617', releaseGroup: '' })
  assert.equal(m.qid, 'Q17444')
  assert.equal(m.how, 'P2281')
  assert.equal(m.entity.sitelinks.enwiki, 'Nevermind')
  assert.ok(calls.every((c) => /haswbstatement|wbgetentities/.test(c.url)), 'only statement searches and item reads, never a title search')
})

test('Wikidata: no P2281, then the MusicBrainz release group (P436)', async () => {
  const { getJson } = routes()
  const m = await S.matchWikidata(getJson, { appleId: APPLE_ID, releaseGroup: RG })
  assert.deepEqual([m.qid, m.how], ['Q212326', 'P436'])
  assert.equal(await S.matchWikidata(getJson, { appleId: APPLE_ID, releaseGroup: '' }), null, 'no release group: no match, no guess')
})

test('Wikidata: a hit whose item does not carry the exact ID is refused', async () => {
  // the search says Q212326 has P2281=1440892370, but the item (read back) has no P2281
  const { getJson } = routes({ 'haswbstatement%3AP2281%3D1440892370': fx('wd-p436-hit.json') })
  const m = await S.matchWikidata(getJson, { appleId: APPLE_ID, releaseGroup: '' })
  assert.equal(m, null)
})

test('MusicBrainz: the release linked to the Apple Music URL, else the same barcode', async () => {
  let { getJson, calls } = routes()
  assert.deepEqual(await S.matchMusicBrainz(getJson, { appleId: APPLE_ID, storefronts: ['us'], upc: '00720642472729' }), { release: REL, how: 'apple-url' })
  assert.match(calls[0].url, /resource=https%3A%2F%2Fmusic\.apple\.com%2Fus%2Falbum%2F1440892370/)
  ;({ getJson } = routes({ 'musicbrainz.org/ws/2/url?': null }))
  const b = await S.matchMusicBrainz(getJson, { appleId: APPLE_ID, storefronts: ['gb'], upc: '00720642472729' })
  assert.equal(b.how, 'barcode')
  assert.equal(fx('mb-barcode.json').releases.find((r) => r.id === b.release).barcode.replace(/^0+/, ''), '720642472729')
  ;({ getJson } = routes({ 'musicbrainz.org/ws/2/url?': null }))
  assert.equal(await S.matchMusicBrainz(getJson, { appleId: APPLE_ID, upc: '0000123456789' }), null, 'another barcode: no match')
})

test('MusicBrainz release, reduced: tracks, performers, writers, the place and the date', () => {
  const r = S.reduceRelease(fx('mb-release.json'))
  assert.equal(r.releaseGroup, RG)
  assert.ok(r.types.includes('Live'))
  assert.equal(r.artists[0].id, ARTIST)
  const t = r.media[0].tracks[0]
  assert.equal(t.title, 'About a Girl')
  assert.ok(t.performers.some((p) => p.name === 'Kurt Cobain' && p.role === 'lead vocals'))
  assert.deepEqual(t.writers.map((w) => w.role).sort(), ['music', 'words'])
  assert.equal(t.recordedAt, 'Sony Music Studios')
  assert.equal(r.places[0].name, 'Sony Music Studios')
  assert.deepEqual(r.places[0].dates, ['1993-11-18'])
  assert.equal(M.oneDate(r), '1993-11-18')
  assert.equal(S.roleOf({ type: 'producer', attributes: ['co'] }), 'co-producer')
  assert.equal(S.roleOf({ type: 'instrument', attributes: ['guitar', 'guest'], 'attribute-credits': { guitar: '12-string' } }), '12-string (guest)')
})

test('Cover Art Archive: the matched release without scans -> the same pressing\'s release that has them', async () => {
  const { getJson } = routes()
  const caa = await S.coverArt(getJson, REL)
  assert.equal(S.hasScans(caa), false, 'the digital release has only fronts')
  const pick = S.pickScanRelease(await S.releaseGroupReleases(getJson, RG), { id: REL, barcode: '00720642472729' }, 'us')
  assert.equal(pick.id, SCAN_REL, 'a back cover, the same barcode as Apple\'s, the storefront\'s country')
  assert.equal(S.editionWords({ date: '1994-11-01', country: 'US', format: 'CD' }), 'the 1994 US CD')
  const cd = S.reduceCoverArt(fx('caa-cd.json'), SCAN_REL)
  assert.ok(cd.images.every((i) => /^https:\/\//.test(i.thumbs[500])), 'https thumbnails')
  assert.equal(S.reduceCoverArt(null, REL).images.length, 0, 'a 404 is no scans')
})

test('Wikipedia: the summary and the background / recording / reception sections, trimmed, licensed', () => {
  const w = S.reduceWikipedia(fx('wp-summary.json'), fx('wp-extract.json'), 'en')
  assert.equal(w.title, 'MTV Unplugged in New York')
  assert.equal(w.url, 'https://en.wikipedia.org/wiki/MTV_Unplugged_in_New_York')
  assert.deepEqual(w.sections.map((s) => s.heading), ['Background', 'Recording', 'Releases', 'Reception'])
  assert.ok(w.sections.every((s) => s.paras.length <= 3))
  assert.equal(w.trimmed, true)
  assert.equal(w.license.name, 'CC BY-SA 4.0')
  // only trimmed: every paragraph is the article's own text, word for word
  const article = fx('wp-extract.json').query.pages[0].extract
  for (const s of w.sections) for (const p of s.paras) assert.ok(article.includes(p))
  assert.ok(article.includes(w.summary) || fx('wp-summary.json').extract === w.summary)
  assert.equal(S.wikiTitleFor({ sitelinks: { dewiki: 'MTV Unplugged in New York', enwiki: 'x' } }, 'de').lang, 'de')
  assert.equal(S.wikiTitleFor({ sitelinks: { enwiki: 'x' } }, 'fr').lang, 'en', 'no article in the UI language: English')
  assert.equal(S.wikiLang('nb-NO'), 'no')
  assert.equal(S.wikiLang('de-DE'), 'de')
})

// --- the whole booklet ---
function newNotes(r, extra) {
  const store = memStore()
  const c = clock(Date.UTC(2026, 9, 17))
  const L = M.createLinerNotes(Object.assign({ getJson: r.getJson, store, now: c.now, lang: 'en', setlistKey: () => '' }, extra || {}))
  return { L, store, c }
}

test('booklet: every source matched, every page with its source chip, nothing invented', async () => {
  const r = routes()
  const { L, store } = newNotes(r)
  const { entry, seen } = await loaded(L, fx('apple-album.json'), null)
  assert.equal(seen[0].pending, true, 'the cached (here: Apple only) booklet shows first')
  assert.equal(seen[seen.length - 1].pending, false)
  assert.deepEqual(Object.fromEntries(Object.entries(entry.parts).map(([k, p]) => [k, p.state])),
    { apple: 'ok', mb: 'ok', wikidata: 'ok', wiki: 'ok', caa: 'ok', setlist: 'off' })
  assert.ok(store.get(M.cacheKey(APPLE_ID, 'en')), 'cached per album and language')
  const b = M.buildBooklet(entry, {})
  assert.deepEqual(b.sections.map((s) => s.id), ['cover', 'notes', 'recording', 'background', 'credits', 'booklet', 'back'], 'no lyrics section without lyrics')
  for (const s of b.sections) for (const p of s.pages) assert.ok(p.kind === 'sources' || p.chips.length, s.id + ' ' + p.kind + ' has a source chip')
  // Apple's notes as Apple wrote them (tags out, words kept)
  const notes = b.sections.find((s) => s.id === 'notes').pages[0]
  const raw = fx('apple-album.json').editorialNotes.standard.replace(/<[^>]+>/g, '')
  for (const blk of notes.blocks) assert.ok(raw.includes(blk.text.slice(0, 80)), blk.text.slice(0, 40))
  assert.equal(notes.title, fx('apple-album.json').editorialNotes.short)
  assert.doesNotMatch(allText(b), /sample|lorem|placeholder/i)
  // the recording: MusicBrainz's place and date, Apple's release
  const rec = b.sections.find((s) => s.id === 'recording').pages[0]
  assert.deepEqual(rec.blocks[0].rows.slice(0, 2), [['Date', 'Thursday, November 18, 1993'], ['Studio', 'Sony Music Studios, 460 W. 54th St., at 10th Avenue, Manhatten, NY']])
  assert.ok(rec.blocks.some((x) => x.t === 'h3' && x.text === 'The set, as on the album'), 'live, no setlist.fm key: the album\'s own track list')
  // credits: the writers MusicBrainz has, Apple's otherwise
  const cred = b.sections.find((s) => s.id === 'credits').pages[0]
  assert.ok(cred.blocks.some((x) => x.t === 'track' && x.sub === 'Words and music: Kurdt Kobain'))
  // the back cover: the real scan
  assert.equal(b.sections.find((s) => s.id === 'back').pages[1].kind, 'scan')
})

test('attribution: Wikipedia text carries its title, link and licence; Sources names the contributors', async () => {
  const { L } = newNotes(routes())
  const { entry } = await loaded(L, fx('apple-album.json'), null)
  const b = M.buildBooklet(entry, {})
  const bg = b.sections.find((s) => s.id === 'background').pages[0]
  const w = bg.chips.find((c) => c.who === 'Wikipedia')
  assert.equal(w.href, 'https://en.wikipedia.org/wiki/MTV_Unplugged_in_New_York')
  assert.match(w.what, /“MTV Unplugged in New York”, trimmed/)
  assert.ok(bg.chips.some((c) => c.who === 'CC BY-SA 4.0' && c.href === 'https://creativecommons.org/licenses/by-sa/4.0/'))
  assert.ok(bg.chips.some((c) => c.who === 'Wikidata' && /Q212326/.test(c.what)))
  const src = b.status.find((s) => s.name === 'Wikipedia')
  assert.match(src.text, /by its contributors, CC BY-SA 4\.0, trimmed/)
  assert.equal(src.href, w.href)
  assert.match(b.status.find((s) => s.name === 'Cover Art Archive').text, /belong to their owners/)
  assert.match(b.status.find((s) => s.name === 'MusicBrainz').text, /CC0/)
  assert.match(b.status.find((s) => s.name === 'setlist.fm').text, /your own free API key/)
})

test('lyrics pages: the album\'s songs whose lyrics are on this computer, stanza by stanza', async () => {
  const { L } = newNotes(routes())
  const { entry } = await loaded(L, fx('apple-album.json'), null)
  const song = fx('apple-album.json').tracks[1]
  const lines = [{ t: 1, end: 3, text: 'Come as you are' }, { t: 3, end: 5, text: 'as you were' }, { t: 12, end: 14, text: 'Take your time' }, { t: 20, gap: true }, { t: 22, text: 'Memoria' }]
  const b = M.buildBooklet(entry, { lyrics: { [song.id]: { lines, source: 'apple', writers: ['Kurt Cobain'] } } })
  const lyr = b.sections.find((s) => s.id === 'lyrics')
  assert.equal(lyr.pages.length, 1)
  const st = lyr.pages[0].blocks.filter((x) => x.t === 'stanza')
  assert.deepEqual(st.map((x) => x.lines.map((l) => l.i)), [[0, 1], [2], [4]], 'a 4 s pause or an empty line starts a stanza; indices are the song\'s lines (the sung-line mark)')
  assert.equal(lyr.pages[0].blocks[0].text, 'Written by Kurt Cobain')
  assert.equal(lyr.pages[0].chips[0].who, 'Apple Music')
})

test('setlist.fm: off without the user\'s key; with it, asked by artist MBID and date, the key in a header only', async () => {
  const r = routes()
  const { L } = newNotes(r, { setlistKey: () => 'abcd-1234-efgh' })
  const { entry } = await loaded(L, fx('apple-album.json'), null)
  assert.equal(entry.parts.setlist.state, 'ok')
  const call = r.calls.find((c) => c.url.includes('api.setlist.fm'))
  assert.equal(call.url, 'https://api.setlist.fm/rest/1.0/search/setlists?artistMbid=' + ARTIST + '&date=18-11-1993&p=1')
  assert.equal(call.opts.headers['x-api-key'], 'abcd-1234-efgh')
  assert.ok(!r.calls.some((c) => c.url.includes('abcd-1234')), 'the key is never in a URL')
  const b = M.buildBooklet(entry, {})
  const rec = b.sections.find((s) => s.id === 'recording').pages[0]
  assert.ok(rec.chips.some((c) => c.who === 'setlist.fm' && c.href === SETLIST.setlist[0].url), 'linked to its setlist page (setlist.fm terms)')
  assert.deepEqual(rec.blocks.filter((x) => x.t === 'li').map((x) => x.enc), ['', '', 'encore'])
  assert.equal(M.createLinerNotes && S.reduceSetlist({ setlist: [] }), null)
})

// --- offline, failures, the cache ---
test('offline with nothing saved: each section says what didn\'t load; Apple\'s part still shows', async () => {
  const off = S.failure('offline', 'net::ERR_INTERNET_DISCONNECTED')
  const r = routes({ 'musicbrainz.org': off, 'wikidata.org': off })
  const { L } = newNotes(r)
  const { entry } = await loaded(L, fx('apple-album.json'), null)
  assert.equal(entry.parts.mb.state, 'failed')
  assert.equal(entry.parts.mb.error, 'no connection')
  assert.equal(entry.parts.wikidata.state, 'failed')
  const b = M.buildBooklet(entry, {})
  const cred = b.sections.find((s) => s.id === 'credits').pages[0]
  assert.ok(cred.blocks.some((x) => x.t === 'note' && /MusicBrainz didn't load: no connection\. The songwriters below are Apple's\./.test(x.text)))
  assert.ok(cred.blocks.some((x) => x.t === 'track' && x.sub === 'Written by Kurt Cobain'), 'Apple\'s songwriters stand in')
  const bg = b.sections.find((s) => s.id === 'background').pages[0]
  assert.match(bg.blocks[0].text, /didn't load: no connection\. Sonata asks again the next time you open this booklet\./)
  assert.equal(b.status.find((s) => s.name === 'MusicBrainz').state, 'failed')
  assert.ok(b.sections.find((s) => s.id === 'notes'), 'Apple\'s notes still print')
})

test('offline with a saved copy: the copy shows, said as such; failed sources are asked again only after 10 minutes', async () => {
  const r = routes()
  const { L, store, c } = newNotes(r)
  await loaded(L, fx('apple-album.json'), null)
  const n0 = r.calls.length
  // a second open soon after: everything fresh, no request at all
  let { seen } = await loaded(L, fx('apple-album.json'), null)
  assert.equal(r.calls.length, n0)
  assert.equal(seen.length, 1)
  // 31 days later, offline (Apple's page too): the saved booklet, every source "didn't load, showing the copy saved …"
  c.add(31 * 24 * 3600 * 1000)
  const off = S.failure('offline', 'offline')
  const L2 = M.createLinerNotes({ getJson: async () => { throw off }, store, now: c.now, lang: 'en', setlistKey: () => '' })
  const got = await loaded(L2, null, off, APPLE_ID)
  const e = got.entry
  assert.equal(e.parts.apple.state, 'failed')
  assert.ok(e.parts.apple.data && e.parts.apple.stale, 'Apple\'s part from the saved copy')
  assert.equal(e.parts.wiki.state, 'failed')
  assert.ok(e.parts.wiki.data, 'Wikipedia\'s text from the saved copy')
  const b = M.buildBooklet(e, {})
  assert.ok(b.sections.find((s) => s.id === 'background').pages[0].blocks.some((x) => x.t === 'note' && /Showing the copy saved October 17, 2026/.test(x.text)))
  assert.match(b.status.find((s) => s.name === 'Wikipedia').text, /^Didn't load: no connection\. Showing the copy saved October 17, 2026\./)
  // five minutes later: not asked again yet; eleven minutes: asked again
  let calls = 0
  const L3 = M.createLinerNotes({ getJson: async () => { calls++; throw off }, store, now: c.now, lang: 'en', setlistKey: () => '' })
  c.add(5 * 60 * 1000)
  ;({ seen } = await loaded(L3, null, off, APPLE_ID))
  assert.equal(calls, 0)
  c.add(6 * 60 * 1000)
  await loaded(L3, null, off, APPLE_ID)
  assert.ok(calls > 0)
})

test('Apple didn\'t answer and nothing is saved: the booklet says so instead of opening empty', async () => {
  const { L } = newNotes(routes())
  const { entry } = await loaded(L, null, S.failure('offline', 'x'), '')
  const b = M.buildBooklet(entry, {})
  assert.equal(b.sections.length, 1)
  assert.match(b.sections[0].pages[0].blocks[0].text, /Apple Music's album details didn't load: no connection/)
})

test('the cache is bounded like the lyrics cache: entries and bytes, oldest out first', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'liner-cache-'))
  const store = createLyricsStore({ file: path.join(dir, 'liner-notes-cache.json'), maxEntries: M.CACHE.maxEntries, maxBytes: M.CACHE.maxBytes, debounceMs: 0 })
  const entry = { v: 1, parts: { wiki: { data: 'x'.repeat(30000) } } }   // a large booklet's size
  // loop: test only
  for (let i = 0; i < M.CACHE.maxEntries + 40; i++) store.set(M.cacheKey(String(1000 + i), 'en'), entry)
  assert.ok(store.size <= M.CACHE.maxEntries)
  assert.ok(store.bytes <= M.CACHE.maxBytes)
  assert.equal(store.get(M.cacheKey('1000', 'en')), null, 'the oldest went first')
  assert.ok(store.get(M.cacheKey(String(1000 + M.CACHE.maxEntries + 39), 'en')))
  store.flush()
  fs.rmSync(dir, { recursive: true, force: true })
  assert.ok(M.CACHE.maxEntries <= 200 && M.CACHE.maxBytes <= 8 * 1024 * 1024)
})

// --- etiquette ---
test('requests: Sonata\'s User-Agent, one at a time per host with its gap, a busy answer tried again', async () => {
  let t = 0
  const log = []
  let busy = 1
  const fetch = async (url, o) => {
    log.push({ url, at: t, ua: o.headers['User-Agent'] })
    if (url.includes('busy') && busy-- > 0) return { status: 503, ok: false, json: async () => ({}) }
    if (url.includes('missing')) return { status: 404, ok: false, json: async () => ({}) }
    return { status: 200, ok: true, json: async () => ({ url }) }
  }
  const g = S.createGetJson({ fetch, ua: require('../version-display').userAgent('0.15.40'), now: () => t, sleep: async (ms) => { t += ms } })
  await Promise.all([g('https://musicbrainz.org/ws/2/a'), g('https://musicbrainz.org/ws/2/b'), g('https://en.wikipedia.org/x')])
  const mb = log.filter((l) => l.url.includes('musicbrainz'))
  assert.ok(mb[1].at - mb[0].at >= 1100, 'MusicBrainz: at most one request per 1.1 s')
  assert.equal(log[0].ua, 'Sonata/0.15.40 (https://github.com/MarcelineVPQ/apple-music-for-linux)')
  assert.deepEqual(await g('https://musicbrainz.org/busy'), { url: 'https://musicbrainz.org/busy' }, '503: waits and asks again')
  assert.equal(await g('https://coverartarchive.org/missing', { missingOk: true }), null)
  await assert.rejects(g('https://coverartarchive.org/missing'), (e) => e.kind === 'http' && e.status === 404)
  const off = S.createGetJson({ fetch: async () => { throw new TypeError('fetch failed') }, ua: 'x', now: () => 0, sleep: async () => {} })
  await assert.rejects(off('https://www.wikidata.org/w/api.php'), (e) => e.kind === 'offline' && S.failureText(e) === 'no connection')
})

test('no keys or secrets ship: setlist.fm has no default key; the sources hold none', () => {
  const settings = require('../settings-store')
  assert.equal(settings.defaults().setlistfmKey, '')
  assert.equal(settings.validSetting('setlistfmKey', 'abcd-1234'), true)
  assert.equal(settings.validSetting('setlistfmKey', 'x"; drop'), false)
  for (const f of ['liner-notes-sources.js', 'liner-notes-model.js', 'liner-notes.html']) {
    const src = fs.readFileSync(path.join(__dirname, '..', f), 'utf8')
    assert.doesNotMatch(src, /['"][0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}['"]/i, f + ' holds no UUID-like key')
    assert.doesNotMatch(src, /api_key=|apikey=|token=/i, f)
  }
})

test('Apple\'s album: notes HTML to plain paragraphs; only https artwork; bad IDs refused', () => {
  assert.deepEqual(M.notesParagraphs('<i>Unplugged</i> was&nbsp;never &amp; ever.<br />\nSecond <b>one</b>.'), ['Unplugged was never & ever.', 'Second one.'])
  assert.equal(M.reduceApple({ id: 'x1' }), null)
  const a = M.reduceApple(Object.assign(fx('apple-album.json'), { artwork: { url: 'javascript:alert(1)' } }))
  assert.equal(a.art, null)
  assert.equal(a.upc, '00720642472729')
  assert.deepEqual(a.genres, ['Alternative', 'Rock', 'Grunge'])
  assert.equal(M.fmtDate('1993-11-18', true), 'Thursday, November 18, 1993')
  assert.equal(M.fmtDate('1994-11'), 'November 1994')
  assert.equal(M.isLive(a, null), true, '"(Live Acoustic)" in Apple\'s title')
})
