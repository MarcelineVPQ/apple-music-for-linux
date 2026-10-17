// The Montage's sources (montage-sources.js), offline: Wikidata and Commons answers saved on 2026-10-17
// (test/fixtures/montage/answers.json, trimmed to the fields read). Matching by identifiers only, the
// licence filter, the credits, the order, the thumbnail widths and the polite fetcher.
const test = require('node:test')
const assert = require('node:assert/strict')
const S = require('../montage-sources')
const ANSWERS = require('./fixtures/montage/answers.json')

// a getJson answering from the saved answers; any other URL is a test failure (no network)
function saved(overrides) {
  const asked = []
  const getJson = async (url) => {
    asked.push(url)
    if (overrides && url in overrides) return overrides[url]
    if (!(url in ANSWERS)) throw new Error('not saved: ' + url)
    return JSON.parse(JSON.stringify(ANSWERS[url]))
  }
  return { getJson, asked }
}

test('the artist by its Apple Music ID (P2850, read back), its own image and category: Against Me!', async () => {
  const { getJson, asked } = saved()
  const r = await S.resolveMontage(getJson, { artistId: '6946251', albumId: '', year: 2007 }, 1280)
  assert.equal(r.how.artist, 'Q181684')
  assert.equal(r.how.album, '')
  assert.equal(r.photos.length, 12, 'capped at MAX_PHOTOS')
  assert.equal(r.photos[0].id, 'Against Me! playing at Coachella.jpg', 'the item\'s own image (P18) first when no year category')
  for (const p of r.photos) {
    assert.ok(p.author && p.author.length <= 100, 'a named author: ' + p.id)
    assert.match(p.page, /^https:\/\/commons\.wikimedia\.org\/wiki\/File:/)
    assert.ok(['cc0', 'pd', 'by', 'by-sa', 'fal'].includes(p.licence.kind), p.licence.name)
    assert.ok(!/logo|cover|signature/i.test(p.id))
    assert.match(S.thumbFor(p, 1280), /^https:\/\/(upload|thumb)\.wikimedia\.org\/[^?]+$/)
  }
  // the 2007 photos come before 2011's (the album's era first)
  const years = r.photos.slice(1).map((p) => p.year).filter(Boolean)
  assert.ok(years.indexOf(2007) < years.indexOf(2011))
  // identifiers only: no name search anywhere
  for (const u of asked) {
    assert.ok(!/wbsearchentities|opensearch|prefixsearch/.test(u), u)
    if (/list=search/.test(u)) assert.match(decodeURIComponent(u), /&srsearch=haswbstatement:P2850=6946251$/, 'the only search is the exact ID statement')
  }
})

test('a live album: the album by P2281, its venue (P483) woven between the artist\'s photos: Coldplay, Live 2003', async () => {
  const { getJson } = saved()
  const r = await S.resolveMontage(getJson, { artistId: '471744', albumId: '695900885' }, 1280)
  assert.deepEqual(r.how, { artist: 'Q45188', album: 'Q681424', venues: ['Q5902970'] })
  const venue = r.photos.map((p, i) => [i, /Hordern|Mardi Gras/.test(p.id)]).filter((x) => x[1]).map((x) => x[0])
  assert.ok(venue.length >= 2, 'the Hordern Pavilion shows')
  assert.ok(venue.every((i) => i % 3 === 2 || i >= r.photos.length - venue.length), 'one venue photo after two of the artist\'s: ' + venue)
  // the album is from 2003: 2005-2006 photos before 2025's
  const at = (y) => r.photos.findIndex((p) => p.year === y)
  assert.ok(at(2005) < at(2025) && at(2006) < at(2025))
})

test('nothing matched: no photos (the tile says so), and no Commons request at all', async () => {
  const { getJson, asked } = saved()
  const r = await S.resolveMontage(getJson, { artistId: '1', albumId: '2' }, 1280)
  assert.deepEqual(r.photos, [])
  assert.ok(asked.every((u) => !/commons\.wikimedia/.test(u)))
})

test('a search hit is read back: an item without that exact ID is not the artist', async () => {
  const search = 'https://www.wikidata.org/w/api.php?action=query&list=search&srlimit=3&format=json&srsearch=' + encodeURIComponent('haswbstatement:P2850=6946251')
  const ents = 'https://www.wikidata.org/w/api.php?action=wbgetentities&props=claims&format=json&ids=Q181684'
  const wrong = JSON.parse(JSON.stringify(ANSWERS[ents]))
  wrong.entities.Q181684.claims.P2850 = [{ mainsnak: { datavalue: { value: '999' } } }]
  const { getJson } = saved({ [ents]: wrong })
  assert.ok(search in ANSWERS)
  const r = await S.resolveMontage(getJson, { artistId: '6946251', albumId: '' }, 1280)
  assert.equal(r.how.artist, '')
  assert.deepEqual(r.photos, [])
})

test('the artist through the album\'s performer (P175) when the artist ID has no item', async () => {
  const noArtist = 'https://www.wikidata.org/w/api.php?action=query&list=search&srlimit=3&format=json&srsearch=' + encodeURIComponent('haswbstatement:P2850=471744')
  const venueAndPerformer = 'https://www.wikidata.org/w/api.php?action=wbgetentities&props=claims&format=json&ids=Q45188%7CQ5902970'
  const coldplay = ANSWERS['https://www.wikidata.org/w/api.php?action=wbgetentities&props=claims&format=json&ids=Q45188']
  const venue = ANSWERS['https://www.wikidata.org/w/api.php?action=wbgetentities&props=claims&format=json&ids=Q5902970']
  assert.ok(coldplay && venue, 'saved items')
  const { getJson } = saved({ [noArtist]: { query: { search: [] } }, [venueAndPerformer]: { entities: Object.assign({}, coldplay.entities, venue.entities) } })
  const r = await S.resolveMontage(getJson, { artistId: '471744', albumId: '695900885' }, 1280).catch((e) => ({ error: e.message }))
  assert.equal(r.how && r.how.artist, 'Q45188', JSON.stringify(r).slice(0, 300))
})

test('licences: only clear free licences that allow showing with a credit', () => {
  const L = (short, code, extra) => S.licenceOf(Object.assign({ LicenseShortName: { value: short }, License: { value: code || '' } }, extra || {}))
  assert.equal(L('CC BY-SA 4.0', 'cc-by-sa-4.0', { LicenseUrl: { value: 'https://creativecommons.org/licenses/by-sa/4.0' } }).url, 'https://creativecommons.org/licenses/by-sa/4.0')
  assert.deepEqual(L('CC BY 2.0', 'cc-by-2.0'), { name: 'CC BY 2.0', url: 'https://creativecommons.org/licenses/by/2.0/', kind: 'by' })
  assert.equal(L('CC BY-SA 3.0 de', 'cc-by-sa-3.0-de').name, 'CC BY-SA 3.0 de')
  assert.equal(L('CC0', 'cc0').kind, 'cc0')
  assert.equal(L('Public domain', 'pd').kind, 'pd')
  assert.equal(L('PD-self', 'pd-self').kind, 'pd', 'Commons\' public-domain templates (License pd-…)')
  assert.equal(L('Some text', 'pd-usgov').kind, 'pd')
  assert.equal(L('Free Art License', 'fal').kind, 'fal')
  // not free, or not clear
  for (const [s, c] of [['CC BY-NC 2.0', 'cc-by-nc-2.0'], ['CC BY-ND 4.0', 'cc-by-nd-4.0'], ['CC BY-NC-SA 3.0', ''], ['GFDL', 'gfdl'], ['Attribution', 'attribution'], ['', ''], ['Copyrighted free use', 'copyrighted free use'], ['Fair use', '']]) assert.equal(L(s, c), null, s)
  assert.equal(L('CC BY-SA 4.0', 'cc-by-sa-4.0', { NonFree: { value: 'true' } }), null, 'NonFree')
})

test('authors: plain text from Commons\' HTML, never empty or "unknown"', () => {
  const A = (html) => S.authorOf({ Artist: { value: html } })
  assert.equal(A('<a href="//commons.wikimedia.org/wiki/User:IllaZilla" title="User:IllaZilla">IllaZilla</a>'), 'IllaZilla')
  assert.equal(A('<a href="x" title="User:Chickenchips123 (page does not exist)">Chickenchips123</a>'), 'Chickenchips123')
  assert.equal(A('<a rel="nofollow" class="external text" href="https://www.flickr.com/people/x">Stab At Sleep</a> from F L O R I D A, United States'), 'Stab At Sleep from F L O R I D A, United States')
  assert.equal(A('Photo by Jane &amp; John'), 'Jane & John')
  for (const none of ['', 'Unknown', 'unknown author', 'Anonymous', '<span>?</span>']) assert.equal(A(none), '', none)
  const long = A('x '.repeat(80))
  assert.ok(long.length <= 100 && long.endsWith('…'))
})

test('photos: JPEG/PNG photos of a useful size, a free licence, an author and Commons URLs only', () => {
  const ok = { title: 'File:Band live.jpg', imageinfo: [{ mime: 'image/jpeg', width: 2000, height: 1333, url: 'https://upload.wikimedia.org/wikipedia/commons/a/ab/Band_live.jpg', thumburl: 'https://upload.wikimedia.org/wikipedia/commons/thumb/a/ab/Band_live.jpg/1280px-Band_live.jpg?utm_source=x', thumbwidth: 1280, descriptionurl: 'https://commons.wikimedia.org/wiki/File:Band_live.jpg', extmetadata: { LicenseShortName: { value: 'CC BY 4.0' }, License: { value: 'cc-by-4.0' }, Artist: { value: 'Someone' }, DateTimeOriginal: { value: '2003-07-01 20:00' } } }] }
  const p = S.photoFrom(ok)
  assert.equal(p.thumb, 'https://upload.wikimedia.org/wikipedia/commons/thumb/a/ab/Band_live.jpg/1280px-Band_live.jpg', 'tracking query dropped')
  assert.equal(p.year, 2003)
  assert.equal(S.creditText(p), 'Someone · CC BY 4.0 · Wikimedia Commons')
  const with_ = (f) => { const c = JSON.parse(JSON.stringify(ok)); f(c, c.imageinfo[0]); return S.photoFrom(c) }
  assert.equal(with_((c) => { c.title = 'File:Band logo.jpg' }), null, 'a logo')
  assert.equal(with_((c) => { c.title = 'File:Album cover.jpg' }), null, 'a cover')
  assert.equal(with_((c, i) => { i.mime = 'image/svg+xml' }), null, 'not a photo')
  assert.equal(with_((c, i) => { i.width = 640; i.height = 480 }), null, 'too small')
  assert.equal(with_((c, i) => { i.extmetadata.Artist.value = '' }), null, 'no author')
  assert.equal(with_((c, i) => { i.extmetadata.LicenseShortName.value = 'CC BY-NC 2.0' }), null, 'NC')
  assert.equal(with_((c, i) => { i.descriptionurl = 'https://evil.example/wiki/File:x.jpg' }), null, 'not Commons')
  assert.equal(with_((c, i) => { i.url = 'http://upload.wikimedia.org/x.jpg' }), null, 'not https')
  assert.equal(with_((c) => { c.missing = true }), null)
})

test('thumbnail widths: Commons\' standard steps; the original when it is no wider', () => {
  const p = { width: 3000, height: 2000, thumb: 'https://upload.wikimedia.org/wikipedia/commons/thumb/a/ab/X.jpg/1280px-X.jpg', thumbWidth: 1280, original: 'https://upload.wikimedia.org/wikipedia/commons/a/ab/X.jpg' }
  assert.equal(S.thumbFor(p, 1920), 'https://upload.wikimedia.org/wikipedia/commons/thumb/a/ab/X.jpg/1920px-X.jpg')
  assert.equal(S.thumbFor(p, 960), 'https://upload.wikimedia.org/wikipedia/commons/thumb/a/ab/X.jpg/960px-X.jpg')
  assert.equal(S.thumbFor(Object.assign({}, p, { width: 1100 }), 1280), p.original)
  assert.equal(S.widthFor(700), 960)
  assert.equal(S.widthFor(1300), 1280, 'a little upscaling is fine (85 %)')
  assert.equal(S.widthFor(1600), 1920)
  assert.equal(S.widthFor(5000), 1920, 'never more than the largest step')
})

test('order: duplicates dropped, capped, the venue woven in', () => {
  const ph = (id, year) => ({ id, year })
  const out = S.arrange({ venue: [ph('v1'), ph('v2')], era: [ph('e1', 2004), ph('e0', 2003)], own: [ph('o1'), ph('e1', 2004)], rest: Array.from({ length: 20 }, (x, i) => ph('r' + i, 2000 + i)) }, 2003)
  assert.equal(out.length, S.MAX_PHOTOS)
  assert.deepEqual(out.slice(0, 6).map((p) => p.id), ['e0', 'e1', 'v1', 'o1', 'r3', 'v2'])
  assert.equal(new Set(out.map((p) => p.id)).size, out.length)
})

test('the era: "<category> in <year>" nearest the album, within 3 years', () => {
  const names = ['Coldplay in 2005', 'Coldplay in 2006', 'Coldplay in 2011', 'Coldplay artworks', 'Members of Coldplay']
  assert.deepEqual(S.eraCategories('Coldplay', names, 2003, 2), ['Coldplay in 2005', 'Coldplay in 2006'])
  assert.deepEqual(S.eraCategories('Coldplay', names, 1990, 2), [])
  assert.deepEqual(S.eraCategories('Coldplay', names, 0, 2), [])
})

// --- the polite fetcher ---
function fakeNet(script) {
  let t = 1000
  const calls = []
  const res = (status, body, type) => ({ ok: status >= 200 && status < 300, status, json: async () => body, arrayBuffer: async () => new Uint8Array(body).buffer, headers: { get: (h) => (h === 'content-type' ? type || 'application/json' : h === 'content-length' ? String(body.length || 0) : null) } })
  return {
    calls,
    deps: {
      ua: S.userAgent('9.9.9'),
      now: () => t,
      sleep: async (ms) => { t += ms },
      fetch: async (url, o) => { calls.push({ url, at: t, ua: o.headers['User-Agent'], accept: o.headers.Accept }); const s = script.shift(); if (s instanceof Error) throw s; return res(...s) }
    }
  }
}
test('fetcher: names Sonata, waits between requests to one host, backs off when busy', async () => {
  const n = fakeNet([[200, { a: 1 }], [429, {}], [200, { b: 2 }]])
  const f = S.createFetcher(n.deps)
  assert.deepEqual(await f.getJson('https://commons.wikimedia.org/w/api.php?x=1'), { a: 1 })
  assert.deepEqual(await f.getJson('https://commons.wikimedia.org/w/api.php?x=2'), { b: 2 })
  assert.equal(n.calls[0].ua, 'Sonata/9.9.9 (https://github.com/MarcelineVPQ/apple-music-for-linux)')
  assert.ok(n.calls[1].at - n.calls[0].at >= 300, 'the host\'s gap')
  assert.ok(n.calls[2].at - n.calls[1].at >= 2000, 'a 429 waits 2 s, then asks again')
})
test('fetcher: offline and refusals become failures the tile can word', async () => {
  const n = fakeNet([new TypeError('net::ERR_INTERNET_DISCONNECTED'), [404, {}]])
  const f = S.createFetcher(n.deps)
  await assert.rejects(f.getJson('https://www.wikidata.org/w/api.php?a'), (e) => e.kind === 'offline')
  await assert.rejects(f.getJson('https://www.wikidata.org/w/api.php?b'), (e) => e.kind === 'http' && e.status === 404)
})
test('fetcher: images only as JPEG or PNG and at most 6 MB', async () => {
  const jpg = Array.from({ length: 200 }, (x, i) => i % 256)
  const n = fakeNet([[200, jpg, 'image/jpeg'], [200, jpg, 'text/html'], [200, Array.from({ length: S.MAX_IMAGE_BYTES + 1 }, () => 0), 'image/jpeg']])
  const f = S.createFetcher(n.deps)
  const img = await f.getImage('https://upload.wikimedia.org/x.jpg')
  assert.equal(img.type, 'image/jpeg')
  assert.equal(img.bytes.length, 200)
  assert.equal(n.calls[0].accept, 'image/jpeg,image/png')
  await assert.rejects(f.getImage('https://upload.wikimedia.org/y.jpg'), (e) => e.kind === 'bad')
  await assert.rejects(f.getImage('https://upload.wikimedia.org/z.jpg'), (e) => e.kind === 'bad')
})
