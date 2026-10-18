// The song's actions (song-actions.js): the page scripts run against a stand-in MusicKit (what they ask
// Apple and what they answer), the source adapter's checks, the Studio's words, and the song's credits
// (liner-notes-model.js songCredits, the cover's back) from Apple's catalog and the album's cache entry.
const test = require('node:test')
const assert = require('node:assert/strict')
const vm = require('vm')
const A = require('../song-actions')
const L = require('../liner-notes-model')

// a stand-in MusicKit: answers by path, logs every call
function page(opt) {
  const o = opt || {}
  const log = []
  const item = o.item === undefined ? { id: '1440892370', attributes: { name: 'Losing My Religion', artistName: 'R.E.M.', url: 'https://music.apple.com/us/album/out-of-time/1440833098?i=1440892370', playParams: { id: '1440892370', catalogId: '1440892370' } } } : o.item
  const answers = o.answers || {}
  const mk = {
    storefrontId: 'us',
    nowPlayingItem: item,
    queue: o.queue || { items: [] },
    api: {
      music: async (path, params, opts) => {
        log.push({ path, params: params ? JSON.parse(JSON.stringify(params)) : params, method: opts && opts.fetchOptions ? opts.fetchOptions.method : 'GET', body: opts && opts.fetchOptions ? opts.fetchOptions.body : undefined })
        // loop: NOT-WORTH — the test's few answers
        for (const [re, a] of Object.entries(answers)) if (new RegExp(re).test(path)) { if (a instanceof Error) throw a; return a }
        return { data: { data: [] } }
      }
    }
  }
  if (o.playNext) mk.playNext = async (x) => { log.push({ playNext: x }) }
  const links = o.links || []
  const doc = { querySelectorAll: (sel) => (sel === '*' ? [] : links.filter((l) => sel.includes(l.kind))) }
  const ctx = vm.createContext({ MusicKit: { getInstance: () => mk }, document: doc, JSON })
  return { log, mk, run: (code) => vm.runInContext(code, ctx) }
}

test('state: the song\'s ids, link, favourite and library state, read in two requests (no polling)', async () => {
  const p = page({ answers: {
    'me/ratings/songs': { data: { data: [{ attributes: { value: 1 } }] } },
    'catalog/us/songs/1440892370': { data: { data: [{ relationships: { library: { data: [{ id: 'i.abc' }] }, artists: { data: [{ id: '3093' }] } } }] } }
  } })
  const st = A.cleanState(await p.run(A.stateScript))
  assert.deepEqual(st, { ok: true, id: '1440892370', title: 'Losing My Religion', artist: 'R.E.M.', url: 'https://music.apple.com/us/album/out-of-time/1440833098?i=1440892370', favorite: true, inLibrary: true, albumId: '1440833098', artistId: '3093' })
  assert.equal(p.log.length, 2)
  assert.deepEqual(p.log[1].params, { include: 'artists', relate: 'library' })
  // not in the library: an empty library relation; no relation at all: unknown (Add to Library stays offered)
  const out = page({ answers: { 'catalog/': { data: { data: [{ relationships: { library: { data: [] } } }] } } } })
  assert.equal(A.cleanState(await out.run(A.stateScript)).inLibrary, false)
  const unknown = page({ answers: { 'catalog/': new Error('busy'), 'ratings': new Error('busy') } })
  const u = A.cleanState(await unknown.run(A.stateScript))
  assert.equal(u.inLibrary, null)
  assert.equal(u.favorite, false)
  assert.deepEqual(A.offers(u), { favorite: true, library: true, inLibrary: false, playlist: true, link: true, album: true, artist: true })
  // a library song (playParams.isLibrary) is in the library without asking
  const lib = page({ item: { id: 'i.xyz', attributes: { name: 'A', playParams: { id: 'i.xyz', isLibrary: true } } } })
  const ls = A.cleanState(await lib.run(A.stateScript))
  assert.equal(ls.inLibrary, true)
  assert.equal(A.offers(ls).library, false)
  assert.equal(lib.log.length, 1, 'no catalog read for a library id')
  // nothing playing
  assert.deepEqual(A.cleanState(await page({ item: null }).run(A.stateScript)), { ok: false, why: 'nothing' })
})

test('cleanState: what crosses from Apple\'s page is checked (ids, links, kinds)', () => {
  const s = A.cleanState({ ok: true, id: '12"; evil()', url: 'javascript:alert(1)', rating: '1', inLibrary: 'yes', albumId: '12a', artistId: 'x', title: 7 })
  assert.equal(s.id, '')
  assert.equal(s.url, '')
  assert.equal(s.favorite, false)
  assert.equal(s.inLibrary, null)
  assert.equal(s.albumId, '')
  assert.equal(s.artistId, '')
  assert.equal(s.title, '')
  assert.deepEqual(A.offers(s), { favorite: false, library: false, inLibrary: false, playlist: false, link: false, album: false, artist: false })
  assert.deepEqual(A.cleanState(null), { ok: false, why: 'not-ready' })
})

test('the adapter: Favorite / Undo, Add to Library, playlists, Add to a playlist, Play Next, each asking Apple once', async () => {
  const p = page({ playNext: true, queue: { items: [{ id: 'q1' }, { id: 'q2', attributes: { playParams: { catalogId: '777' } } }] }, answers: {
    'me/library/playlists$': { data: { data: [{ id: 'p.1', attributes: { name: 'Road trip', canEdit: true } }, { id: 'p.2', attributes: { name: 'Apple\'s', canEdit: false } }, { id: 'bad id', attributes: { name: 'x' } }] } }
  } })
  const src = A.createAppleSource({ run: p.run })
  await src.favorite('1440892370', true)
  await src.favorite('1440892370', false)
  await src.addToLibrary('1440892370')
  assert.deepEqual(await src.playlists(), [{ id: 'p.1', name: 'Road trip' }])
  await src.addToPlaylist('p.1', '1440892370')
  assert.equal(await src.playNext(1, 'q2'), 'ok')
  assert.equal(await src.playNext(1, 'q1'), 'gone')
  const calls = p.log.map((c) => c.playNext ? 'playNext ' + c.playNext.song : c.method + ' ' + c.path)
  assert.deepEqual(calls, ['PUT /v1/me/ratings/songs/1440892370', 'DELETE /v1/me/ratings/songs/1440892370', 'POST /v1/me/library', 'GET /v1/me/library/playlists', 'POST /v1/me/library/playlists/p.1/tracks', 'playNext 777'])
  assert.deepEqual(JSON.parse(p.log[0].body), { type: 'rating', attributes: { value: 1 } })
  assert.deepEqual(p.log[2].params, { 'ids[songs]': '1440892370' })
  assert.deepEqual(JSON.parse(p.log[4].body), { data: [{ id: '1440892370', type: 'songs' }] })
  // without playNext in this player: said so
  const old = A.createAppleSource({ run: page({ queue: { items: [{ id: 'q1' }] } }).run })
  assert.equal(await old.playNext(0, 'q1'), 'unsupported')
  // an id that could break out of a page script never reaches one
  for (const bad of ['1"); evil(', '', 'x'.repeat(65), 12]) {
    await assert.rejects(src.favorite(bad, true))
    await assert.rejects(src.addToLibrary(bad))
    await assert.rejects(src.addToPlaylist('p.1', bad))
    await assert.rejects(src.addToPlaylist(bad, '1'))
  }
  await assert.rejects(src.open('playlist'))
  await assert.rejects(src.playNext(-1, 'q1'))
})

test('open: the album or artist through a link already in Apple\'s page (client-side, playback goes on)', async () => {
  let clicked = ''
  const link = (kind, href) => ({ kind, getAttribute: () => href, click: () => { clicked = href } })
  const p = page({ links: [link('/album/', '/us/album/other/1'), link('/album/', '/us/album/out-of-time/1440833098'), link('/artist/', '/us/artist/r-e-m/3093')], answers: { 'catalog/us/songs/': { data: { data: [{ relationships: { artists: { data: [{ id: '3093' }] } } }] } } } })
  const src = A.createAppleSource({ run: p.run })
  assert.equal(await src.open('album'), true)
  assert.equal(clicked, '/us/album/out-of-time/1440833098')
  assert.equal(await src.open('artist'), true)
  assert.equal(clicked, '/us/artist/r-e-m/3093')
  // a queue row's album (given id); no such link on screen: false (the Studio says it couldn't be opened)
  assert.equal(await src.open('album', '1'), true)
  assert.equal(clicked, '/us/album/other/1')
  assert.equal(await src.open('album', '999'), false)
  assert.equal(await A.createAppleSource({ run: page({ item: null }).run }).open('album'), false)
  // a given id that isn't digits is ignored (the playing song's album instead)
  assert.ok(!A.openPageScript('album', '1"; evil()').includes('evil'))
})

test('said: a short confirmation, or what failed and why', () => {
  assert.deepEqual(A.said('favorite', true), { kind: 'ok', text: 'Added to Favorites' })
  assert.deepEqual(A.said('undo-favorite', true), { kind: 'ok', text: 'Removed from Favorites' })
  assert.deepEqual(A.said('library', true), { kind: 'ok', text: 'Added to Library' })
  assert.deepEqual(A.said('playlist', true, 'Road trip'), { kind: 'ok', text: 'Added to “Road trip”' })
  assert.deepEqual(A.said('link', true), { kind: 'ok', text: 'Link copied' })
  assert.equal(A.said('favorite', false).text, "Favorite didn't go through. Try again in a moment")
  assert.equal(A.said('favorite', false).text.split('.')[0], require('../mini-model').actionFailedText('favorite', '').title, 'one set of words with the mini player')
  assert.equal(A.said('library', false, 'nothing').text, "Add to Library didn't go through: nothing is playing")
  assert.equal(A.said('play-next', false, 'unsupported').text, "Play Next didn't go through: Apple Music's player doesn't offer it here")
  assert.match(A.said('album', false).text, /couldn't be opened/)
  assert.equal(A.said('album', false).kind, 'error')
  assert.equal(A.said('nope', true), null)
})

// an album cache entry as liner-notes-model keeps it: Apple's tracks and MusicBrainz's release
const entry = {
  parts: {
    apple: { state: 'ok', data: { id: '1440833098', name: 'Out of Time', tracks: [
      { id: '1440892360', name: 'Radio Song', artist: 'R.E.M.', n: 1, disc: 1, composer: 'Bill Berry, Peter Buck, Mike Mills & Michael Stipe' },
      { id: '1440892370', name: 'Losing My Religion', artist: 'R.E.M.', n: 2, disc: 1, composer: 'Bill Berry, Peter Buck, Mike Mills & Michael Stipe' }
    ] } },
    mb: { state: 'ok', data: { id: 'a1b2', credits: [{ name: 'Scott Litt', role: 'producer' }, { name: 'Bob Ludwig', role: 'mastering' }], media: [{ position: 1, tracks: [
      { title: 'Radio Song', performers: [], crew: [], writers: [] },
      { title: 'Losing My Religion', performers: [{ name: 'Michael Stipe', role: 'lead vocals' }, { name: 'Peter Buck', role: 'mandolin' }], crew: [{ name: 'Scott Litt', role: 'producer' }, { name: 'R.E.M.', role: 'producer' }, { name: 'John Keane', role: 'engineer' }], writers: [{ name: 'Bill Berry', role: 'written by' }, { name: 'Peter Buck', role: 'written by' }, { name: 'Mike Mills', role: 'written by' }, { name: 'Michael Stipe', role: 'written by' }] }
    ] }] } }
  }
}

test('songCredits: Apple\'s catalog alone; with the album\'s cache entry, MusicBrainz\'s writers, musicians and crew', () => {
  const song = { id: '1440892370', title: 'Losing My Religion', artist: 'R.E.M.', composer: 'Bill Berry, Peter Buck, Mike Mills & Michael Stipe' }
  const apple = L.songCredits(null, song)
  assert.deepEqual(apple.rows, [
    { role: 'Written by', names: 'Bill Berry, Peter Buck, Mike Mills & Michael Stipe', src: 'apple' },
    { role: 'Performed by', names: 'R.E.M.', src: 'apple' }
  ])
  assert.deepEqual(apple.chips.map((c) => c.who), ['Apple Music'])
  const full = L.songCredits(entry, song)
  assert.deepEqual(full.rows.map((r) => [r.role, r.names, r.src, !!r.album]), [
    ['Written by', 'Bill Berry, Peter Buck, Mike Mills & Michael Stipe', 'mb', false],
    ['Performed by', 'R.E.M.', 'apple', false],
    ['Musicians', 'Michael Stipe (lead vocals), Peter Buck (mandolin)', 'mb', false],
    ['Produced by', 'Scott Litt & R.E.M.', 'mb', false],
    ['Engineered by', 'John Keane', 'mb', false],
    ['Mastered by', 'Bob Ludwig', 'mb', true]
  ])
  assert.deepEqual(full.chips.map((c) => c.who), ['Apple Music', 'MusicBrainz'])
  assert.equal(full.chips[1].href, 'https://musicbrainz.org/release/a1b2')
  // only what's real: nothing known, nothing made up
  assert.deepEqual(L.songCredits(null, { title: 'X' }).rows, [])
  // featuring, from Apple's own words
  const ft = L.songCredits(null, { title: 'Shiny Happy People (feat. Kate Pierson)', artist: 'R.E.M.' })
  assert.deepEqual(ft.rows.find((r) => r.role === 'Featuring'), { role: 'Featuring', names: 'Kate Pierson', src: 'apple' })
  assert.equal(L.featuring('Song', 'A feat. B & C'), 'B & C')
  assert.equal(L.songCredits(null, { title: 'S', artist: 'A feat. B' }).rows.find((r) => r.role === 'Performed by').names, 'A')
  // a song not on the album (matched by id, then title): Apple's credits only
  assert.equal(L.songCredits(entry, { id: '1', title: 'Other', artist: 'R.E.M.' }).mb, false)
})

test('the liner notes\' MusicBrainz-only refresh (the Studio\'s credits): MusicBrainz asked, the booklet\'s other sources left due', async () => {
  const asked = []
  const store = new Map()
  const notes = L.createLinerNotes({
    getJson: async (url) => { asked.push(url.replace(/\?.*/, '')); return url.includes('/url?') ? { relations: [] } : null },
    store: { get: (k) => store.get(k), set: (k, v) => store.set(k, JSON.parse(JSON.stringify(v))) },
    lang: 'en'
  })
  const raw = { id: '1440833098', name: 'Out of Time', artistName: 'R.E.M.', tracks: [] }
  const e = await notes.load(raw, null, () => {}, '', 'mb')
  assert.ok(asked.length >= 1 && asked.every((u) => u.includes('musicbrainz')), asked.join(' '))
  assert.equal(e.parts.mb.state, 'none')
  assert.equal(e.parts.wiki, undefined)
  assert.ok(store.has(L.cacheKey('1440833098', 'en')))
  // cached now: a second Studio read asks nothing
  const n = asked.length
  await notes.load(raw, null, () => {}, '', 'mb')
  assert.equal(asked.length, n)
})

// Marcy 2026-10-18: "the star needs to get filled in when I choose it as a favorite". The state is read back
// from Apple after the action (never assumed from the click), fresh (no HTTP cache), and the Studio's button
// shows exactly what came back
test('favourite round trip: Favorite, then the state read back says so; Undo, and it says not', async () => {
  let rating = 0
  const p = page({ answers: {} })
  // a stand-in Apple that keeps the rating between calls
  p.mk.api.music = async (path, params, opts) => {
    const f = (opts && opts.fetchOptions) || {}
    p.log.push({ path, method: f.method || 'GET', cache: f.cache })
    if (/ratings\/songs\/1440892370$/.test(path)) { rating = f.method === 'DELETE' ? 0 : JSON.parse(f.body).attributes.value; return {} }
    if (/ratings\/songs$/.test(path)) return { data: { data: rating ? [{ attributes: { value: rating } }] : [] } }
    return { data: { data: [] } }
  }
  const src = A.createAppleSource({ run: p.run })
  const S = require('../stage-model')
  assert.equal(S.favoriteButton(await src.state()).pressed, false)
  await src.favorite('1440892370', true)
  const on = await src.state()
  assert.equal(on.favorite, true)
  assert.deepEqual(S.favoriteButton(on), { pressed: true, icon: 'starOn', label: 'Remove from Favorites', title: 'Remove from Favorites (F): take this song out of your Favorites' })
  await src.favorite('1440892370', false)
  const off = await src.state()
  assert.equal(off.favorite, false)
  assert.deepEqual(S.favoriteButton(off), { pressed: false, icon: 'starOff', label: 'Favorite', title: 'Favorite (F): add this song to your Favorites' })
  // every rating read is fresh: right after a Favorite the answer must be Apple's new one
  const reads = p.log.filter((c) => c.method === 'GET' && /ratings/.test(c.path))
  assert.equal(reads.length, 3)
  assert.ok(reads.every((c) => c.cache === 'no-store'), JSON.stringify(reads))
})

test('a song known only by its library id is rated as a library song', async () => {
  const p = page({ item: { id: 'i.xyz', attributes: { name: 'A', playParams: { id: 'i.xyz', isLibrary: true } } } })
  await p.run(A.stateScript)
  assert.equal(p.log[0].path, '/v1/me/ratings/library-songs')
  const src = A.createAppleSource({ run: p.run })
  await src.favorite('i.xyz', true)
  assert.equal(p.log[1].path, '/v1/me/ratings/library-songs/i.xyz')
})

test('the Studio\'s buttons from the state: the star and the ✓ only when Apple says so', () => {
  const S = require('../stage-model')
  for (const st of [null, { ok: false }, { ok: true, favorite: false }, { ok: false, favorite: true }]) assert.equal(S.favoriteButton(st).pressed, false, JSON.stringify(st))
  assert.equal(S.favoriteButton({ ok: true, favorite: true }).pressed, true)
  assert.deepEqual(S.libraryButton({ ok: true, inLibrary: true }), { done: true, icon: 'check', label: 'In your library', title: 'Already in your library' })
  for (const v of [false, null, undefined]) assert.equal(S.libraryButton({ ok: true, inLibrary: v }).icon, 'plus')
  assert.equal(S.libraryButton({ ok: false, inLibrary: true }).done, false)
})
