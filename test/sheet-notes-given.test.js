// Sheet notes for lyrics with their own word timing (Apple's word/syllable lyrics): the band's states,
// the syllable table from the lyrics' own times, the helper messages, the session (separate each section,
// then the notes on the given times; nothing aligned), and the round trip through the helper client with
// the fake helper (test/fixtures/fake-align-helper.*). docs/LEVEL2-ALIGN.md "Sheet notes".
const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('path')
const A = require('../align-session')
const H = require('../align-helper')
const M = require('../sheet-notes-model')
const LS = require('../lyrics-syllables')

// Apple-style word-timed lyrics: two verses with an interlude between them (two sections); "fifteen"
// carries Apple's own syllables, "stepping" is split by the views' hyphenation, a backing vocal is left out
const w = (t, end, text, syl) => Object.assign({ t, end, text }, syl ? { syl } : {})
const APPLE = [
  { t: 10, end: 12.4, text: 'fifteen steps', words: [w(10, 11, 'fifteen', [w(10, 10.4, 'fif'), w(10.4, 11, 'teen')]), w(11.2, 12.4, 'steps')] },
  { t: 13, end: 15, text: 'then a sharp drop', words: [w(13, 13.4, 'then'), w(13.5, 13.7, 'a'), w(13.8, 14.3, 'sharp'), w(14.4, 15, 'drop')], bg: [w(13, 15, 'ooh')] },
  { t: 30, end: 32, text: 'stepping out', words: [w(30, 31.2, 'stepping'), w(31.3, 32, 'out')] },
  { t: 33, end: 35, text: 'and back again', words: [w(33, 33.5, 'and'), w(33.6, 34.2, 'back'), w(34.3, 35, 'again')] }
]

test('canGiveNotes: line-synced lyrics with their own word timing; not line-only or untimed ones', () => {
  assert.ok(A.canGiveNotes(APPLE))
  assert.ok(!A.canGiveNotes(APPLE.map((l) => ({ t: l.t, text: l.text }))))      // line-only: those are aligned
  assert.ok(!A.canGiveNotes([{ t: null, text: 'x', words: [w(1, 2, 'x')] }]))
  assert.ok(!A.canGiveNotes([]) && !A.canGiveNotes(null))
  assert.ok(!A.canAlign(APPLE))                                                // and they are never aligned
})

test('givenSyllables: Apple\'s own syllables, else the views\' split of the word, lead vocal only, time-ordered', () => {
  const rows = A.givenSyllables(APPLE, LS.hyphenatorFor('en'))
  const line0 = rows.filter((r) => r.line === 0)
  assert.deepEqual(line0.map((r) => [r.t, r.end, r.text, r.word, r.syl, r.nsyl, r.word_text]),
    [[10, 10.4, 'fif', 0, 0, 2, 'fifteen'], [10.4, 11.2, 'teen', 0, 1, 2, 'fifteen'], [11.2, 13, 'steps', 1, 0, 1, 'steps']])   // a word's end reaches to the next word (GIVEN_REACH_S)
  // the views' estimated split of "stepping" (lyrics-syllables.js): starts at the word, ends where the next word starts
  const stepping = rows.filter((r) => r.line === 2 && r.word === 0)
  assert.equal(stepping.length, 2)
  assert.deepEqual([stepping[0].t, stepping[1].end, stepping.map((r) => r.text).join('')], [30, 31.3, 'stepping'])
  assert.ok(!rows.some((r) => r.text === 'ooh'), 'no background vocals')
  assert.deepEqual(rows.map((r) => r.t), rows.map((r) => r.t).slice().sort((a, b) => a - b))
  // no hyphenation patterns: whole words
  assert.equal(A.givenSyllables(APPLE, null).filter((r) => r.line === 2 && r.word === 0).length, 1)
  // a zero-length word is left out
  assert.equal(A.givenSyllables([{ t: 1, text: 'a b', words: [w(1, 1, 'a'), w(1.2, 1.5, 'b')] }], null).length, 1)
})

test('givenSyllables: a held word whose own time ends before its note reaches to the next word, at most GIVEN_REACH_S ("I don\'t mind, I don\'t mind, yeah": both "mind," keep their notes)', () => {
  // Apple's word times leading the sung notes: each "mind," ends 0.3 s after it starts, the held note starts
  // ~0.4 s after the word and lasts ~1 s (the helper gives a note to the syllable it starts in, up to 0.15 s past its end)
  const line = { t: 50, end: 56, text: 'But I don\'t mind, I don\'t mind, yeah', words: [w(50, 50.3, 'But'), w(50.3, 50.5, 'I'), w(50.5, 50.8, 'don\'t'), w(50.8, 51.1, 'mind,'), w(52.2, 52.4, 'I'), w(52.4, 52.7, 'don\'t'), w(52.7, 53.0, 'mind,'), w(55.5, 56, 'yeah')] }
  const rows = A.givenSyllables([line], null)
  const minds = rows.filter((r) => r.word_text === 'mind,')
  assert.deepEqual(minds.map((r) => [r.word, r.t, r.end]), [[3, 50.8, 52.1], [6, 52.7, 54]])
  // a note starting 0.5 s into each held "mind," starts inside its syllable now (before: past end + 0.15 s)
  for (const [m, noteT] of [[minds[0], 51.3], [minds[1], 53.2]]) assert.ok(noteT >= m.t && noteT < m.end + 0.15)   // loop: NOT-WORTH — test
  assert.ok(51.3 > 51.1 + 0.15 && 53.2 > 53.0 + 0.15, 'with the lyrics\' own ends both notes were dropped')
  // never past the next word's start
  assert.equal(rows.find((r) => r.line === 0 && r.word === 2).end, 50.8)
})

test('messages: a section\'s separate-only job streams its slice; the notes job carries the given syllables', () => {
  const pcm = Buffer.alloc(22050 * 4 * 2)
  const msgs = [...A.separateMessages('g1', pcm, { song: 's1', offset: 27 })]
  assert.deepEqual(msgs[0], { cmd: 'separate', id: 'g1', song: 's1', offset: 27, audio: { stream: true, format: 's16le', rate: 22050, channels: 2 } })
  assert.equal(msgs[msgs.length - 1].cmd, 'end')
  assert.equal(msgs.slice(1, -1).reduce((n, m) => n + Buffer.from(m.data, 'base64').length, 0), pcm.length)
  const syl = A.givenSyllables(APPLE, null)
  const kept = [...A.givenNotesMessages('n1', 's1', APPLE, syl, null)]
  assert.equal(kept.length, 1)
  assert.deepEqual(kept[0], { cmd: 'notes', id: 'n1', song: 's1', given: { syllables: syl, lines: A.requestLines(APPLE) } })
  const withAudio = [...A.givenNotesMessages('n2', 's1', APPLE, syl, pcm)]
  assert.equal(withAudio[0].audio.stream, true)
  assert.equal(withAudio[withAudio.length - 1].cmd, 'end')
})

// --- the band ---

test('mode: Apple-timed songs go through the first-play and later-play states (no "its own word timing" message)', () => {
  const base = { on: true, installed: true, precise: true, timed: true, wordSynced: true, aligned: false, doc: null, pitch: [] }
  const first = M.mode(base)
  assert.deepEqual([first.band, first.label], ['line', 'First play · pitch line'])
  assert.ok(!/own word timing/.test(first.text))
  assert.deepEqual(M.mode(Object.assign({}, base, { pitch: [{ t0: 10, hop: 0.05, v: [600] }] })).band, 'line')
  const entry = M.compact({ notes: [{ t: 10, end: 10.4, midi: 60, name: 'C4', conf: 0.9, cents: 2, syl_index: 0 }, { t: 10.4, end: 11, midi: 62, name: 'D4', conf: 0.9, cents: 3, syl_index: 1 }],
    syllables: A.givenSyllables(APPLE, null).slice(0, 2), key: { name: 'C major', fifths: 0 } }, { lyricsHash: 'h' })
  const later = M.mode(Object.assign({}, base, { doc: M.expand(entry) }))
  assert.equal(later.band, 'notes')
  // still says what is needed when the helper or Precise timing is missing
  assert.match(M.mode(Object.assign({}, base, { installed: false })).text, /helper/)
  assert.match(M.mode(Object.assign({}, base, { precise: false })).text, /Precise word timing on/)
  assert.match(M.mode(Object.assign({}, base, { paused: true })).text, /game/)
})

// --- the session ---

function setup(opts = {}) {
  let nowMs = 0
  const calls = []
  const got = { pitch: [], done: [], failed: [], sections: [], unfinished: [] }
  const store = new Map()
  const helper = {
    align: async (id, messages) => { calls.push({ cmd: 'align', id }); throw new Error('never aligned') },
    forget: (song) => calls.push({ cmd: 'forget', song }),
    sectionNotes: opts.sectionNotes,
    pitch: async (id, song, offset) => { calls.push({ cmd: 'pitch', id, song, offset }); return { type: 'result', id, pitch: { t0: offset, hop: 0.05, v: [0, 600] } } },
    separate: async (id, messages) => {
      const m = [...messages]
      const bytes = m.slice(1, -1).reduce((n, x) => n + Buffer.from(x.data, 'base64').length, 0)
      calls.push({ cmd: 'separate', id, song: m[0].song, offset: m[0].offset, bytes })
      return { type: 'result', id, kept: opts.notKept ? !opts.notKept(m[0].offset) : true, stats: {} }
    },
    givenNotes: async (id, messages) => {
      const m = [...messages]
      if (opts.notesGate) await opts.notesGate
      calls.push({ cmd: 'notes', id, song: m[0].song, audio: !!m[0].audio, syllables: m[0].given.syllables.length, lines: m[0].given.lines.length })
      if (opts.noStem && !m[0].audio) throw Object.assign(new Error('not kept'), { code: 'no-stem' })
      return { type: 'result', id, notes: { notes: [{ t: 10, end: 10.4, midi: 60 }], syllables: m[0].given.syllables, pitch: { t0: 0, hop: 0.05, v: [600] } } }
    }
  }
  if (opts.stream) helper.stream = opts.stream
  const s = A.createAlignSession({
    createListener: () => ({ start() {}, stop() {} }),
    helper,
    store: { get: (k) => store.get(k) || null, set: (k, v) => store.set(k, v) },
    send: (c, x) => { if (opts.sent) opts.sent.push([c, x]) },
    now: () => nowMs,
    log: () => {},
    latency: 0,
    paused: opts.paused,
    notes: {
      wanted: () => true,
      syl: () => [],
      done: (song, r, off) => got.done.push([song.title, off, r.notes.syllables.length]),
      failed: (song, e) => got.failed.push(e.code || e.message),
      pitchWanted: opts.pitchWanted || (() => true),
      pitch: (song, line, e) => got.pitch.push(line ? line.t0 : 'error ' + (e && (e.code || e.message))),
      missing: opts.missing || (() => true),
      sectionWanted: opts.sectionNotes ? () => true : undefined,
      section: (song, part, sec) => got.sections.push([sec.from, sec.to, !!sec.stream, part.notes.length]),
      unfinished: (song) => got.unfinished.push(song.title)
    }
  })
  return { s, calls, got, store, setNow: (v) => { nowMs = v } }
}
function play(env, from, to) {
  const chunk = new Float32Array(2205).fill(0.1)
  for (let t = from; t < to - 1e-9; t += 0.5) {
    env.setNow(t * 1000)
    env.s.tick(t, true, true)
    for (let k = 0; k < 5; k++) if (env.s.recording) env.s._onChunk(chunk, (t + (k + 1) * 0.1) * 1000, null)
  }
}
// the fakes' jobs settle in microtasks and immediates: drained, no fixed wall-clock wait (QC 2026-10 flake)
const settle = () => require('./until').drain()

test('session: an Apple-timed song is recorded for its notes: each section separated (+ its pitch line), then the notes on its own times', async () => {
  const env = setup()
  env.s.setLyrics('15 Step|Radiohead', '15 Step', 'Radiohead', APPLE, true)
  assert.ok(env.s.active)
  const secs = A.sections(APPLE)
  assert.equal(secs.length, 2)
  play(env, 0, secs[1].at + 1)
  await settle()
  assert.deepEqual(env.calls.map((c) => c.cmd), ['separate', 'pitch', 'separate', 'pitch', 'notes'])
  assert.deepEqual(env.calls.filter((c) => c.cmd === 'separate').map((c) => c.offset), [0, A.sectionRequest(APPLE, secs[1], false).offset])
  assert.ok(env.calls.filter((c) => c.cmd === 'separate').every((c) => c.song === 's1' && c.bytes > 0))
  const notes = env.calls.find((c) => c.cmd === 'notes')
  assert.deepEqual([notes.audio, notes.lines, notes.syllables], [false, 4, A.givenSyllables(APPLE, LS.hyphenatorFor('en')).length])   // from the kept sections
  assert.deepEqual(env.got.done, [['15 Step', 0, notes.syllables]])
  assert.deepEqual(env.got.pitch, env.calls.filter((c) => c.cmd === 'separate').map((c) => c.offset))
  assert.equal(env.store.size, 0, 'nothing aligned, nothing in the lyrics store')
  assert.ok(!env.calls.some((c) => c.cmd === 'align'))
  assert.ok(!env.s.active)
})

test('session: notes cached (or Sheet notes off) records nothing for an Apple-timed song', async () => {
  let asked = null
  const env = setup({ missing: (title, artist, hash) => { asked = [title, artist, hash]; return false } })
  env.s.setLyrics('Song|A', 'Song', 'A', APPLE, true)
  assert.deepEqual(asked, ['Song', 'A', A.lyricsHash(APPLE)])
  play(env, 0, 45)
  env.s.stop(true)
  await settle()
  assert.deepEqual(env.calls, [])
  const off = setup()
  off.s.setLyrics('Song|A', 'Song', 'A', APPLE, false)       // Precise timing off / not installed
  play(off, 0, 45)
  await settle()
  assert.deepEqual(off.calls, [])
})

test('session: skipped before the end, the notes are cancelled (jobs still queued skipped, the kept sections forgotten)', async () => {
  const env = setup()
  env.s.setLyrics('Song|A', 'Song', 'A', APPLE, true)
  const secs = A.sections(APPLE)
  play(env, 0, secs[0].at + 1)             // the first section heard and separated
  await settle()
  env.s.setLyrics('Next|B', 'Next', 'B', [{ t: 5, text: 'other song' }], true)   // the skip
  await settle()
  assert.deepEqual(env.calls.map((c) => c.cmd), ['separate', 'pitch', 'forget'])
  assert.deepEqual(env.got.done, [])
  assert.deepEqual(env.got.failed, [], 'a skip is not a failure (the song is tried on its next play)')
  // the skip comes while the section's job is still queued (not started): it is skipped too
  const busy = setup()
  busy.s.setLyrics('Song|A', 'Song', 'A', APPLE, true)
  play(busy, 0, secs[0].at + 1)
  busy.s.stop(true)                        // the last lyric view closed mid-song, before the queue ran
  await settle()
  assert.deepEqual(busy.calls.map((c) => c.cmd), ['forget'])
})

test('session: a section the helper didn\'t keep, or kept sections it lost (no-stem): the notes from the song\'s audio', async () => {
  const secs = A.sections(APPLE)
  const one = setup({ notKept: (offset) => offset > 0 })
  one.s.setLyrics('Song|A', 'Song', 'A', APPLE, true)
  play(one, 0, secs[1].at + 1)
  await settle()
  const n1 = one.calls.filter((c) => c.cmd === 'notes')
  assert.deepEqual(n1.map((c) => c.audio), [true])
  assert.equal(one.calls.filter((c) => c.cmd === 'pitch').length, 1)        // only the kept section has a pitch line
  const lost = setup({ noStem: true })
  lost.s.setLyrics('Song|A', 'Song', 'A', APPLE, true)
  play(lost, 0, secs[1].at + 1)
  await settle()
  assert.deepEqual(lost.calls.filter((c) => c.cmd === 'notes').map((c) => c.audio), [false, true])
  assert.equal(lost.got.done.length, 1)
})

test('session: nothing while a game runs; a notes job reached while gaming is skipped and said', async () => {
  let gaming = true
  const env = setup({ paused: () => gaming })
  env.s.setLyrics('Song|A', 'Song', 'A', APPLE, true)
  play(env, 0, 45)
  await settle()
  assert.deepEqual(env.calls, [], 'nothing recorded, nothing sent')
  gaming = false
  const late = setup({ paused: () => gaming })
  late.s.setLyrics('Song|A', 'Song', 'A', APPLE, true)
  const secs = A.sections(APPLE)
  play(late, 0, secs[1].start + 1)
  gaming = true                              // the game starts in the last section: the recording stops
  play(late, secs[1].start + 1, secs[1].at + 1)
  gaming = false
  late.s.stop(true)
  await settle()
  assert.ok(!late.calls.some((c) => c.cmd === 'notes'))
  // the notes job itself reached while a game runs: skipped, said once (paused, not counted as a failure)
  let atNotes = false
  const third = setup({ paused: () => atNotes })
  third.s.setLyrics('Song|A', 'Song', 'A', APPLE, true)
  play(third, 0, secs[1].at + 0.6)
  atNotes = true
  await settle()
  assert.ok(!third.calls.some((c) => c.cmd === 'notes'))
  assert.deepEqual(third.got.failed, ['paused'])
})

// --- the helper client with the fake helper ---

const FIXTURE = { home: '/tmp/sonata-align-test-home', python: '/bin/sh', server: path.join(__dirname, 'fixtures', 'fake-align-helper.sh') }
function waitFor(cond, ms = 3000) {
  const t0 = Date.now()
  return new Promise((resolve, reject) => {
    // loop: test poll · 20 ms · until cond or ms
    const iv = setInterval(() => {
      if (cond()) { clearInterval(iv); resolve() } else if (Date.now() - t0 > ms) { clearInterval(iv); reject(new Error('timeout')) }
    }, 20)
  })
}

test('helper client + fake helper: separate keeps the sections, the notes come back on the given times and compact into a store entry', async () => {
  const h = H.createAlignHelper({ paths: FIXTURE, env: Object.assign({}, process.env, { FAKE_NODE: process.execPath, FAKE_MODE: '' }), log: () => {} })
  try {
    const pcm = Buffer.alloc(22050 * 4 * 2)
    const g1 = await h.separate('g1', A.separateMessages('g1', pcm, { song: 's1', offset: 0 }))
    assert.deepEqual([g1.type, g1.kept, g1.stats.bytes], ['result', true, pcm.length])
    await h.separate('g2', A.separateMessages('g2', pcm, { song: 's1', offset: 16.98 }))
    const syl = A.givenSyllables(APPLE, LS.hyphenatorFor('en'))
    const res = await h.givenNotes('n1', A.givenNotesMessages('n1', 's1', APPLE, syl, null))
    assert.deepEqual([res.stats.given, res.stats.from, res.stats.sections], [true, 'kept', 2])
    assert.deepEqual(res.notes.notes.map((n) => n.t), syl.map((s) => s.t))       // anchored to Apple's own times
    await assert.rejects(h.givenNotes('n2', A.givenNotesMessages('n2', 's1', APPLE, syl, null)), (e) => e.code === 'no-stem')   // one try per kept song
    const res2 = await h.givenNotes('n3', A.givenNotesMessages('n3', 's1', APPLE, syl, pcm))
    assert.deepEqual([res2.stats.from, res2.stats.bytes], ['audio', pcm.length])
    // what main stores (sheetNotesDone): the same entry format as an aligned song's, valid for these lyrics
    const hash = A.lyricsHash(APPLE)
    const entry = M.compact(res.notes, { lineOffset: 0, lyricsHash: hash, created: '2026-10-18T00:00:00.000Z', version: 'test' })
    assert.ok(M.entryValid(entry, hash))
    const doc = M.expand(entry)
    assert.equal(doc.notes.length, syl.length)
    assert.equal(doc.syllables[0].text, 'fif')
    assert.equal(M.mode({ on: true, installed: true, precise: true, timed: true, wordSynced: true, aligned: false, doc, pitch: [] }).band, 'notes')
  } finally {
    h.stop()
    await waitFor(() => !h.running)
  }
})

test('wiring: main loads cached notes for word-timed songs too, and the band no longer turns them away', () => {
  const fs = require('fs')
  const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8')
  assert.match(main, /if \(settings\.sheetNotes && title && timed\) \{/)
  assert.ok(!/No sheet notes for this song yet: it has its own word timing/.test(fs.readFileSync(path.join(__dirname, '..', 'sheet-notes-model.js'), 'utf8')))
})

test('session: notesState says recording while the song is heard, measuring while its notes job waits or runs, then nothing (Expressive words line)', async () => {
  let release = null
  const env = setup({ notesGate: new Promise((r) => { release = r }) })
  assert.equal(env.s.notesState('Song|A'), '')
  env.s.setLyrics('Song|A', 'Song', 'A', APPLE, true)
  assert.equal(env.s.notesState('Song|A'), 'recording')
  assert.equal(env.s.notesState('Other|B'), '')
  const secs = A.sections(APPLE)
  play(env, 0, secs[1].at + 1)
  await settle()
  assert.equal(env.s.notesState('Song|A'), 'measuring')
  // the next song comes on while it measures: the measured one still says so, the new one records
  env.s.setLyrics('Next|B', 'Next', 'B', APPLE, true)
  assert.equal(env.s.notesState('Song|A'), 'measuring')
  assert.equal(env.s.notesState('Next|B'), 'recording')
  release()
  await settle()
  assert.equal(env.s.notesState('Song|A'), '', 'the notes job ended')
  assert.deepEqual(env.got.done.map((d) => d[0]), ['Song'])
})

// --- 0.15.70: look-ahead for Apple-timed songs; a play left early keeps its parts ---

function fakeStream() {
  const st = { heads: [], chunks: 0, ended: 0, cancelled: 0, on: null }
  st.fn = (id, head, on) => {
    st.heads.push(head)
    st.on = on
    return {
      done: new Promise(() => {}),
      chunk: () => { st.chunks++ },
      end: () => { st.ended++ },
      cancel: () => { st.cancelled++ }
    }
  }
  return st
}

test('session, look-ahead: an Apple-timed first play streams for its line notes (no section jobs); its own words stay; the notes on its own times at the end', async () => {
  const st = fakeStream()
  const sent = []
  const env = setup({ stream: st.fn, sectionNotes: async () => ({}), sent })
  env.s.setLyrics('15 Step|Radiohead', '15 Step', 'Radiohead', APPLE, true, { duration: 40, lookahead: 3000 })
  play(env, 0, 37)
  assert.equal(st.heads.length, 1, 'one stream for the delayed first play')
  assert.equal(st.heads[0].lead, 3)
  assert.equal(st.heads[0].notes, true, 'the stream asks for each line\'s notes')
  assert.deepEqual(st.heads[0].lines.map((l) => l.text), APPLE.map((l) => l.text))
  assert.ok(st.chunks > 0)
  assert.equal(env.calls.filter((c) => c.cmd === 'separate').length, 0, 'no section jobs while the stream brings the notes')
  // a line's notes arrive ahead of the listener: to the band and the views like a section's
  st.on({ type: 'notes', line: 2, notes: { notes: [{ t: 30, end: 31, midi: 60 }], syllables: [] } })
  assert.deepEqual(env.got.sections, [[2, 2, true, 1]])
  assert.equal(env.s.notesState('15 Step|Radiohead'), 'sections')
  // the stream's own words never replace Apple's
  st.on({ type: 'words', lines: [{ line: 0, words: [{ t: 10.1, end: 10.5, text: 'fifteen' }] }] })
  assert.ok(!sent.some((x) => x[0] === 'lyrics-stream'))
  // heard to its end: the stream ends, then the notes on the lyrics' own times (what stays cached)
  play(env, 37, 40)
  env.s.setLyrics('Next|B', 'Next', 'B', [{ t: 5, text: 'other song' }], true)
  await settle()
  assert.equal(st.ended, 1)
  assert.deepEqual(env.calls.map((c) => c.cmd), ['notes'])
  assert.equal(env.calls[0].audio, true, 'from the song\'s audio (no sections were kept)')
  assert.deepEqual(env.got.done.map((d) => d[0]), ['15 Step'])
})

test('session: an Apple-timed song left before its end keeps the notes its parts brought (notes.unfinished); a stream is cancelled', async () => {
  const st = fakeStream()
  const env = setup({ stream: st.fn, sectionNotes: async () => ({}) })
  env.s.setLyrics('Song|A', 'Song', 'A', APPLE, true, { duration: 40, lookahead: 3000 })
  play(env, 0, 20)
  st.on({ type: 'notes', line: 0, notes: { notes: [{ t: 10, end: 10.4, midi: 60 }], syllables: [] } })
  env.s.setLyrics('Next|B', 'Next', 'B', [{ t: 5, text: 'other song' }], true)
  await settle()
  assert.equal(st.cancelled, 1)
  assert.deepEqual(env.got.unfinished, ['Song'])
  assert.deepEqual(env.got.done, [])
  // no part came: nothing to keep
  const none = setup()
  none.s.setLyrics('Song|A', 'Song', 'A', APPLE, true)
  play(none, 0, 5)
  none.s.setLyrics('Next|B', 'Next', 'B', [{ t: 5, text: 'other song' }], true)
  await settle()
  assert.deepEqual(none.got.unfinished, [])
})
