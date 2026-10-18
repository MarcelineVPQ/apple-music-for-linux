// The recording behind a cached lyrics / timing entry (recording-id.js, 0.15.42): ISRC first, the
// length as a safety net, the migration of title|artist entries, aliases, and the three users
// (lyrics resolver, precise timing, refined words) on a real lyrics store.
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')
const R = require('../recording-id')
const { createLyricsStore } = require('../lyrics-store')
const { createLyricsResolver } = require('../lyrics-sources')
const A = require('../align-session')
const L = require('../listen-session')

// Two recordings that share a title and artist (lengths from Apple's catalog, 2026-10-17): the Goo Goo
// Dolls' "Iris (Live)" on "Live in Buffalo" and on "The Audience Is This Way". Plus a studio/live pair
// (DMB "Halloween": Before These Crowded Streets vs Live at the Gorge) and one recording on two albums
// (Goo Goo Dolls "Iris": Dizzy Up the Girl 289.559 s, Greatest Hits 289.907 s, the same ISRC).
// The ISRCs are made up (well-formed); the lyrics are placeholders.
const BUFFALO = { title: 'Iris (Live)', artist: 'The Goo Goo Dolls', duration: 376.074, isrc: 'USWB10400001', appleId: '1' }
const AUDIENCE = { title: 'Iris (Live)', artist: 'The Goo Goo Dolls', duration: 342.377, isrc: 'USWB10600002', appleId: '2' }
const STUDIO = { title: 'Halloween', artist: 'Dave Matthews Band', duration: 307.933, isrc: 'USRC19800003', appleId: '3' }
const GORGE = { title: 'Halloween', artist: 'Dave Matthews Band', duration: 356.032, isrc: 'USRC12500004', appleId: '4' }
const ORIGINAL = { title: 'Iris', artist: 'The Goo Goo Dolls', duration: 289.559, isrc: 'USWB19800005', appleId: '5' }
const COMPILATION = Object.assign({}, ORIGINAL, { duration: 289.907, appleId: '6' })

// line-synced lyrics: the same words, sung at different times in each recording
const linesAt = (starts) => starts.map((t, i) => ({ t, text: 'line ' + i + ' of the song' }))
const STUDIO_LINES = linesAt([12, 20, 31, 44, 60, 75, 90, 104])
const GORGE_LINES = linesAt([25, 36, 49, 63, 82, 100, 121, 140])
// an aligned / refined entry's lines: first word a little after each line's start
const wordsOn = (lines, late = 0.3) => Object.fromEntries(lines.map((l, i) => [i, { text: l.text, words: l.text.split(' ').map((w, k) => ({ t: l.t + late + k * 0.3, end: l.t + late + k * 0.3 + 0.25, text: w })) }]))

function memStore() {
  const m = new Map()
  return { get: (k) => (m.has(k) ? m.get(k) : null), set: (k, v) => { m.set(k, v) }, map: m }
}

test('identity: ISRC canonical form, keys, the track key tells studio from live', () => {
  assert.equal(R.normIsrc('us-wb1-04-00001'), 'USWB10400001')
  assert.equal(R.normIsrc('not-an-isrc'), '')
  assert.equal(R.normIsrc(''), '')
  const s = R.songOf(Object.assign({}, BUFFALO, { isrc: 'us-wb1-04-00001' }))
  assert.equal(R.recordingKey(s), 'isrc:USWB10400001')
  assert.equal(R.recordingKey(R.songOf({ title: 'Iris (Live)', artist: 'The Goo Goo Dolls' })), 'Iris (Live)|The Goo Goo Dolls')
  assert.notEqual(R.trackKey(R.songOf(BUFFALO)), R.trackKey(R.songOf(AUDIENCE)))
  // no ISRC: the length tells them apart
  assert.notEqual(R.trackKey(R.songOf(Object.assign({}, BUFFALO, { isrc: '' }))), R.trackKey(R.songOf(Object.assign({}, AUDIENCE, { isrc: '' }))))
})

test('titles: live and alternate marks; plain titles and "Live Forever" are not', () => {
  for (const t of ['Iris (Live)', 'Halloween (Live at the Gorge Amphitheatre, George, WA, 08.30.25)', 'Stay(Wasting Time) [Live at the Gorge]',
    'Slide - Live', 'Iris (Acoustic)', 'Iris (Demo)', 'Dreaming (Utah Saints Mix)', 'Heart of Glass (Special Mix)', 'Afraid (2025 Remaster)',
    'Temple of Love (1992) [2018 Remastered Version]', 'Never Get Old (Single Edit) [2025 Remaster]', 'Song (Remix)', 'Song - Unplugged']) {
    assert.equal(R.variantTitle(t), true, t)
  }
  for (const t of ['Halloween', 'Live Forever', 'We Live in Fear', 'Stay (Wasting Time)', 'Big Romance (feat. Abigail Morris)', 'Temple of Love (1992)']) {
    assert.equal(R.variantTitle(t), false, t)
  }
})

test('tolerance: ±1.5 s is the same recording, more is not; unknown lengths do not refuse', () => {
  assert.equal(R.DURATION_TOLERANCE_S, 1.5)
  assert.equal(R.durationFits(289.559, 289.907), true, 'one recording on two albums (0.35 s)')
  assert.equal(R.durationFits(188.133, 188.92), true, 'the widest copy spread in her library (0.79 s)')
  assert.equal(R.durationFits(100, 101.5), true, 'the edge')
  assert.equal(R.durationFits(100, 98.5), true, 'the edge, shorter')
  assert.equal(R.durationFits(100, 101.51), false, 'just past it')
  assert.equal(R.durationFits(356.032, 353.787), false, 'the closest two live recordings (2.2 s)')
  assert.equal(R.durationFits(307.933, 356.032), false, 'studio vs live')
  assert.equal(R.durationFits(0, 300), true)
  assert.equal(R.durationFits(300, 0), true)
})

test('two recordings with one title (different ISRCs) never share an entry', () => {
  const st = memStore()
  const a = R.lookup(st, 'aligned|', R.songOf(BUFFALO))
  assert.equal(a.entry, null)
  R.put(st, a.key, { lines: { 0: 'buffalo' } }, R.songOf(BUFFALO))
  assert.equal(a.key, 'aligned|isrc:USWB10400001')
  const b = R.lookup(st, 'aligned|', R.songOf(AUDIENCE))
  assert.equal(b.entry, null, 'the other live album gets none of it')
  assert.equal(b.key, 'aligned|isrc:USWB10600002')
  // studio and live of one song too
  R.put(st, 'aligned|isrc:' + STUDIO.isrc, { lines: { 0: 'studio' } }, R.songOf(STUDIO))
  assert.equal(R.lookup(st, 'aligned|', R.songOf(GORGE)).entry, null)
  assert.equal(R.lookup(st, 'aligned|', R.songOf(STUDIO)).entry.lines[0], 'studio')
})

test('one ISRC on two albums (original and compilation) shares; same ISRC with another length does not', () => {
  const st = memStore()
  R.put(st, 'isrc:' + ORIGINAL.isrc, { lines: STUDIO_LINES, source: 'apple' }, R.songOf(ORIGINAL))
  const got = R.lookup(st, '', R.songOf(COMPILATION))
  assert.equal(got.how, 'isrc')
  assert.equal(got.entry.songDuration, 289.559)
  // a remaster that kept the ISRC but is 4 s longer: not reused
  const longer = R.lookup(st, '', R.songOf(Object.assign({}, ORIGINAL, { duration: 293.6 })))
  assert.equal(longer.entry, null)
  assert.equal(longer.how, 'duration')
})

test('migration: an old title|artist entry moves to the ISRC and leaves an alias', () => {
  const st = memStore()
  st.set('aligned|Halloween|Dave Matthews Band', { version: 3, lines: wordsOn(STUDIO_LINES), duration: 120 })
  const got = R.lookup(st, 'aligned|', R.songOf(STUDIO))
  assert.equal(got.how, 'migrated')
  assert.equal(got.key, 'aligned|isrc:USRC19800003')
  assert.equal(st.get('aligned|isrc:USRC19800003').songDuration, 307.933)
  assert.equal(st.get('aligned|isrc:USRC19800003').isrc, 'USRC19800003')
  assert.equal(st.get('aligned|isrc:USRC19800003').appleId, '3')
  assert.deepEqual(st.get('aligned|Halloween|Dave Matthews Band'), { alias: 'aligned|isrc:USRC19800003', isrc: 'USRC19800003', songDuration: 307.933 })
  // the next play finds it by the ISRC; nothing is written again
  const n = st.map.size
  assert.equal(R.lookup(st, 'aligned|', R.songOf(STUDIO)).how, 'isrc')
  assert.equal(st.map.size, n)
  // the live recording (another ISRC) is refused at the alias and gets its own key
  const live = R.lookup(st, 'aligned|', R.songOf(GORGE))
  assert.equal(live.entry, null)
  assert.equal(live.how, 'other-isrc')
  assert.equal(live.key, 'aligned|isrc:USRC12500004')
  // the same song without an ISRC (a library copy): the alias leads to it while the length fits
  assert.equal(R.lookup(st, 'aligned|', R.songOf(Object.assign({}, STUDIO, { isrc: '' }))).how, 'alias')
  assert.equal(R.lookup(st, 'aligned|', R.songOf(Object.assign({}, GORGE, { isrc: '' }))).entry, null, 'the live length does not fit the alias')
})

test('migration: an old entry of a marked title is used only after re-validation', () => {
  const st = memStore()
  st.set('aligned|Iris (Live)|The Goo Goo Dolls', { version: 3, lines: wordsOn(STUDIO_LINES) })
  // no check: refused (an old "(Live)" entry could be any live album's)
  assert.equal(R.lookup(st, 'aligned|', R.songOf(BUFFALO)).how, 'unverified')
  assert.equal(st.map.size, 1, 'nothing moved')
  // a check that fails (its words start elsewhere): refused
  assert.equal(R.lookup(st, 'aligned|', R.songOf(BUFFALO), { check: (e) => R.timingMatches(e.lines, GORGE_LINES) }).entry, null)
  // a check that passes: adopted under the ISRC
  const got = R.lookup(st, 'aligned|', R.songOf(BUFFALO), { check: (e) => R.timingMatches(e.lines, STUDIO_LINES) })
  assert.equal(got.how, 'migrated')
  assert.equal(st.get('aligned|isrc:USWB10400001').songDuration, 376.074)
  // a plain title needs no check
  st.set('Halloween|Dave Matthews Band', { lines: STUDIO_LINES, source: 'apple' })
  assert.equal(R.lookup(st, '', R.songOf(STUDIO)).how, 'migrated')
})

test('missing ISRC: title|artist with the length check; the length is adopted on first use', () => {
  const st = memStore()
  const song = R.songOf({ title: 'Iris (Live)', artist: 'The Goo Goo Dolls', duration: 376.074 })
  const miss = R.lookup(st, '', song)
  assert.equal(miss.key, 'Iris (Live)|The Goo Goo Dolls')
  R.put(st, miss.key, { lines: STUDIO_LINES, source: 'lrclib' }, song)
  assert.equal(st.get(miss.key).songDuration, 376.074)
  assert.equal(st.get(miss.key).isrc, undefined)
  assert.equal(R.lookup(st, '', song).how, 'legacy')
  // the other live album, no ISRC either: its length doesn't fit
  assert.equal(R.lookup(st, '', R.songOf({ title: 'Iris (Live)', artist: 'The Goo Goo Dolls', duration: 342.377 })).how, 'duration')
  // an old plain-title entry without a length gets this song's on use
  st.set('Halloween|Dave Matthews Band', { lines: STUDIO_LINES, source: 'apple' })
  R.lookup(st, '', R.songOf({ title: 'Halloween', artist: 'Dave Matthews Band', duration: 307.933 }))
  assert.equal(st.get('Halloween|Dave Matthews Band').songDuration, 307.933)
  // write: false (the booklet) never writes
  st.set('Pig|Dave Matthews Band', { lines: STUDIO_LINES, source: 'apple' })
  R.lookup(st, '', R.songOf({ title: 'Pig', artist: 'Dave Matthews Band', duration: 417.667, isrc: 'USRC19800009' }), { write: false })
  assert.equal(st.get('Pig|Dave Matthews Band').songDuration, undefined)
  assert.equal(st.get('aligned|isrc:USRC19800009'), null)
})

test('timing re-validation: same recording matches, another does not (her data: ≥ 0.79 vs ≤ 0.30)', () => {
  assert.equal(R.timingMatches(wordsOn(STUDIO_LINES), STUDIO_LINES), true)
  assert.equal(R.timingMatches(wordsOn(STUDIO_LINES, 1.8), STUDIO_LINES), true, 'within 2 s')
  assert.equal(R.timingMatches(wordsOn(STUDIO_LINES), GORGE_LINES), false)
  assert.equal(R.timingMatches(wordsOn(GORGE_LINES), STUDIO_LINES), false)
  // a refined entry of one or two lines: all of them must match
  assert.equal(R.timingMatches({ 3: wordsOn(STUDIO_LINES)[3] }, STUDIO_LINES), true)
  assert.equal(R.timingMatches({ 3: wordsOn(STUDIO_LINES)[3] }, GORGE_LINES), false)
  assert.equal(R.timingMatches({}, STUDIO_LINES), false)
  assert.equal(R.timingMatches(null, STUDIO_LINES), false)
})

test('lyrics resolver: a live cut with the studio title gets its own lyrics, a copy shares; on a real store', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sonata-rec-'))
  const store = createLyricsStore({ file: path.join(dir, 'lyrics-cache.json'), debounceMs: 0 })
  const asked = []
  const ttml = (who) => '<tt><body><div><p begin="00:10.000" end="00:12.000">' + who + '</p></div></body></tt>'
  const make = () => createLyricsResolver({
    fetchApple: async (s) => { asked.push(s.appleId); return ttml(s.appleId === '4' ? 'gorge' : 'studio') },
    fetchLrclib: async () => [], lrclibEnabled: () => false, store
  })
  const get = make()
  assert.equal((await get(STUDIO)).lines[0].text, 'studio')
  assert.equal((await get(GORGE)).lines[0].text, 'gorge', 'not the studio entry')
  assert.deepEqual(asked, ['3', '4'])
  store.flush()
  assert.equal(store.get('isrc:USRC19800003').songDuration, 307.933)
  assert.equal(store.get('isrc:USRC12500004').isrc, 'USRC12500004')
  // a fresh resolver (next start): both from the store, nothing asked
  const again = make()
  assert.equal((await again(GORGE)).lines[0].text, 'gorge')
  assert.equal((await again(STUDIO)).lines[0].text, 'studio')
  assert.deepEqual(asked, ['3', '4'])
  fs.rmSync(dir, { recursive: true, force: true })
})

test('lyrics resolver: an old entry is adopted for a plain title, re-fetched for a "(Live)" one', async () => {
  const st = memStore()
  st.set('Halloween|Dave Matthews Band', { lines: STUDIO_LINES, source: 'apple', parse: 4 })
  st.set('Iris (Live)|The Goo Goo Dolls', { lines: STUDIO_LINES, source: 'apple', parse: 4 })
  const asked = []
  const get = createLyricsResolver({
    fetchApple: async (s) => { asked.push(s.title); return '<tt><body><div><p begin="00:01.000">fresh</p></div></body></tt>' },
    fetchLrclib: async () => [], lrclibEnabled: () => false, store: st
  })
  assert.equal((await get(STUDIO)).lines[0].text, STUDIO_LINES[0].text, 'plain title: the stored lyrics')
  assert.equal((await get(BUFFALO)).lines[0].text, 'fresh', '"(Live)": asked again')
  assert.deepEqual(asked, ['Iris (Live)'])
  assert.equal(st.get('isrc:USWB10400001').lines[0].text, 'fresh')
  assert.equal(st.get('Halloween|Dave Matthews Band').alias, 'isrc:USRC19800003')
})

test('precise timing: entryFor uses only this recording\'s aligned words; writes go to the ISRC key', () => {
  const st = memStore()
  const helper = { align: async () => ({}), notes: async () => ({}) }
  const s = A.createAlignSession({ createListener: () => ({ start() {}, stop() {} }), helper, store: st, send: () => {}, now: () => 0 })
  const lines = STUDIO_LINES
  const entry = { version: A.ENTRY_VERSION, lyricsHash: A.lyricsHash(lines), lines: wordsOn(lines), aligned: lines.length, total: lines.length }
  R.put(st, 'aligned|isrc:' + STUDIO.isrc, entry, R.songOf(STUDIO))
  assert.ok(s.entryFor(STUDIO.title, STUDIO.artist, lines, STUDIO), 'the studio recording')
  assert.equal(s.entryFor(GORGE.title, GORGE.artist, lines, GORGE), null, 'the live one with the same words: none')
  // an old entry of a "(Live)" title: used when its words start where these lines do, and moved
  st.set('aligned|Iris (Live)|The Goo Goo Dolls', Object.assign({}, entry))
  assert.equal(s.entryFor(BUFFALO.title, BUFFALO.artist, GORGE_LINES.map((l, i) => Object.assign({}, l, { text: lines[i].text })), BUFFALO), null)
  assert.ok(s.entryFor(BUFFALO.title, BUFFALO.artist, lines, BUFFALO))
  assert.ok(st.get('aligned|isrc:USWB10400001'))
  // setLyrics remembers where this recording's entry goes
  s.setLyrics('k', GORGE.title, GORGE.artist, lines, true, GORGE)
  s.stop(false)
})

test('refined words: learned per recording; another recording\'s entry is never merged into', () => {
  const st = memStore()
  R.put(st, 'refined|isrc:' + STUDIO.isrc, { v: 1, lines: { 0: { text: STUDIO_LINES[0].text, words: wordsOn(STUDIO_LINES)[0].words, plays: 2 } } }, R.songOf(STUDIO))
  const s = L.createListenSession({ createListener: () => ({ start() {}, stop() {} }), createVocalDetector: () => ({ push() {}, reset() {} }), refineWords: () => null, mergeLearned: (a, b) => b, store: st, send: () => {}, now: () => 0 })
  const est = STUDIO_LINES.map((l) => Object.assign({}, l, { estimated: true, words: l.text.split(' ').map((w, k) => ({ t: l.t + k * 0.4, end: l.t + k * 0.4 + 0.3, text: w })) }))
  assert.equal(s.setLyrics('a', STUDIO.title, STUDIO.artist, est, true, STUDIO).refined, true)
  assert.equal(s.setLyrics('b', GORGE.title, GORGE.artist, est, true, GORGE).refined, false)
  s.stop()
})
