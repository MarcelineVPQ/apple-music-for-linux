'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const F = require('../forget-song')
const R = require('../recording-id')
const L = require('../lookahead')
const { createLyricsStore } = require('../lyrics-store')
const { createSheetNotesStore } = require('../sheet-notes-store')

const SONG = { title: 'Rooster (Live)', artist: 'Alice in Chains', isrc: 'USSM19900001', duration: 380 }
const LINES = [{ t: 10, text: 'Ain\'t found a way to kill me yet' }, { t: 15, text: 'Eyes burn with stinging sweat' }]

function stores() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forget-song-'))
  const lyrics = createLyricsStore({ file: path.join(dir, 'lyrics-cache.json'), debounceMs: 0 })
  const sheet = createSheetNotesStore({ dir: path.join(dir, 'sheet-notes') })
  const song = R.songOf(SONG)
  // a learned song: its lyrics, aligned and refined entries (the aligned one adopted to its ISRC: the old key an alias)
  R.put(lyrics, R.recordingKey(song), { lines: LINES, source: 'lrclib' }, song)
  lyrics.set('aligned|' + R.legacyKey(song), { alias: 'aligned|isrc:' + song.isrc, isrc: song.isrc, songDuration: 380 })
  lyrics.set('aligned|isrc:' + song.isrc, { lines: LINES.map((l) => Object.assign({ aligned: true }, l)), isrc: song.isrc, songDuration: 380 })
  R.put(lyrics, 'refined|' + R.recordingKey(song), { lines: LINES }, song)
  sheet.set(SONG.title, SONG.artist, { format: 1, lyricsHash: 'h', notes: [[1, 2, 60]], expr: { words: [] }, refine: { plays: 2, settled: true }, relearns: 1 })
  return { dir, lyrics, sheet, song }
}
// look-ahead's view of the song, as main's lookaheadDecide reads it (aligned: the entry found, valid when it has lines)
function learnOf(st) {
  const lyr = R.lookup(st.lyrics, '', st.song, { write: false }).entry
  const al = R.lookup(st.lyrics, 'aligned|', st.song, { write: false }).entry
  return L.learnState(lyr, al && al.lines ? al : null, () => true, () => false, false)
}

test('Forget this song: the recording is treated exactly like never played; its lyrics are kept', () => {
  const st = stores()
  assert.equal(learnOf(st), 'learned')
  assert.equal(st.sheet.missing(SONG.title, SONG.artist, 'h'), false)
  const out = F.forgetStored({ lyricsStore: st.lyrics, sheetStore: st.sheet }, { title: SONG.title, artist: SONG.artist })   // no ISRC known: found from the entries
  assert.deepEqual(out.removed.sort(), ['aligned|Rooster (Live)|Alice in Chains', 'aligned|isrc:USSM19900001', 'refined|isrc:USSM19900001'].sort())
  assert.equal(out.notes, true)
  assert.equal(out.lyrics, false)
  assert.equal(learnOf(st), 'first', 'look-ahead: a first play')
  assert.equal(st.sheet.get(SONG.title, SONG.artist), null, 'no cached notes, expression, refine or re-learn state')
  assert.equal(st.sheet.missing(SONG.title, SONG.artist, 'h'), true)
  assert.equal(R.lookup(st.lyrics, 'refined|', st.song, { write: false }).entry, null)
  assert.ok(R.lookup(st.lyrics, '', st.song, { write: false }).entry, 'the lyrics text is kept')
  assert.equal(F.logLine(SONG.title, out), 'forgot "Rooster (Live)" for a fresh first play (3 stored entries, its notes)')
  st.lyrics.flush()
  assert.ok(!fs.readFileSync(path.join(st.dir, 'lyrics-cache.json'), 'utf8').includes('aligned|'), 'removed on disk too')
  fs.rmSync(st.dir, { recursive: true, force: true })
})

test('Forget it and the lyrics too: the lyrics go as well (fetched again next play)', () => {
  const st = stores()
  const out = F.forgetStored({ lyricsStore: st.lyrics, sheetStore: st.sheet }, SONG, { lyrics: true })
  assert.equal(out.lyrics, true)
  assert.equal(R.lookup(st.lyrics, '', st.song, { write: false }).entry, null)
  assert.equal(learnOf(st), 'unknown', 'never looked up: a first play by definition')
  // forgetting a song never learned changes nothing and says so
  const again = F.forgetStored({ lyricsStore: st.lyrics, sheetStore: st.sheet }, SONG, { lyrics: true })
  assert.deepEqual(again, { removed: [], notes: false, lyrics: false })
  fs.rmSync(st.dir, { recursive: true, force: true })
})

test('the confirmation\'s words', () => {
  const t = F.confirmText('Rooster (Live)')
  assert.equal(t.message, 'Forget what Sonata learned about “Rooster (Live)”?')
  assert.equal(t.detail, 'The next play will be a first play.')
  assert.equal(F.LABEL, 'Forget this song…')
})

test('wiring: dev builds only, one item in both ⋯ menus, the play under way keeps nothing, the next report says retest', () => {
  const read = (f) => fs.readFileSync(require.resolve('../' + f), 'utf8')
  const main = read('main.js')
  assert.match(main, /function forgetOffered\(\) \{ return updateFeed\.isDevVersion\(app\.getVersion\(\)\) \}/)
  assert.equal((main.match(/\.concat\(forgetOffered\(\) \? \['-', 'forget'\] : \[\]\)/g) || []).length, 2, 'the mini player\'s and the Studio\'s ⋯')
  assert.match(main, /forget: \{ label: forgetSongLib\.LABEL, enabled: !!info\.title && forgetOffered\(\), submenu: forgetSongMenu\(info\) \}/)
  // loop: NOT-WORTH — a test's five callbacks
  for (const cb of ['done', 'failed', 'pitch', 'section', 'unfinished']) assert.match(main, new RegExp('\\n {8}' + cb + ': \\([^)]*\\) => \\{ if \\(!?s\\.forgotten\\)'), cb)
  assert.match(main, /if \(alignSession\) alignSession\.forget\(cur\.key\)/)
  assert.match(main, /deliberate retest \(Forget this song\)/)
  const as = read('align-session.js')
  assert.match(as, /if \(!s\.forgotten\) R\.put\(deps\.store, s\.storeKey, s\.entry, s\.rec\)/)
  assert.match(as, /forget\(key\) \{/)
  assert.match(read('listen-session.js'), /if \(song\.forgotten\) continue/)
})

test('back to the start after a forget: from at least RESTART_FROM_S to at most RESTART_AT_S', () => {
  assert.equal(F.backToStart(187, 0), true, 'dragged to 0:00 near the end (Marcy 2026-10-20)')
  assert.equal(F.backToStart(47, 2.5), true)
  assert.equal(F.backToStart(4, 0.5), false, 'a play just begun')
  assert.equal(F.backToStart(90, 40), false, 'a seek back, not to the start')
  assert.equal(F.backToStart(NaN, 0), false, 'no time seen yet since the forget')
})

test('wiring: a forgotten play moved back to its start lays the song out again as a fresh play', () => {
  const main = fs.readFileSync(require.resolve('../main.js'), 'utf8')
  assert.match(main, /if \(cur\) forgottenPlay = \{ key: cur\.key, t: NaN \}/)
  assert.match(main, /forgetSongLib\.backToStart\(forgottenPlay\.t, state\.playbackTime\)\) \{\n {6}forgottenPlay = null\n {6}if \(alignSession\) alignSession\.stop\(false\)\n {6}if \(listenSession\) listenSession\.restart\(key\)/)
  assert.match(fs.readFileSync(require.resolve('../listen-session.js'), 'utf8'), /restart\(key\) \{ if \(forgot === key\) forgot = '' \}/)
})
