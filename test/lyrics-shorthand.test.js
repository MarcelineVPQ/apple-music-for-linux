// Lyrics written as shorthand (Marcy 2026-10-18: Mad Season "I Don't Know Anything (Live At the Moore)",
// 6:23, LRCLIB lyrics ending at 2:48 with "(repeat all)"): the markers (lyrics-shorthand.js readMarker),
// written out (expandShorthand: untimed, so the helper places them), a better LRCLIB hit taken first
// (lyrics-sources.js fetchLrclib / hitProblem), and normal lines with parentheses left alone.
const test = require('node:test')
const assert = require('node:assert/strict')
const S = require('../lyrics-shorthand')
const L = require('../lyrics-sources')
const V = require('../lyrics-view')

// the song's shape: 20 sung lines from 0:20 to 2:41, then "(repeat all)" at 2:48 of a 6:23 track
function anything() {
  const lines = []
  for (let i = 0; i < 20; i++) lines.push({ t: Math.round((20 + i * 7.4) * 100) / 100, text: 'I don’t know anything ' + i })
  lines.push({ t: 168, text: '(repeat all)' })
  return lines
}

test('readMarker: the markers', () => {
  const k = (t) => { const m = S.readMarker(t); return m && [m.kind, m.n, m.name || m.text || null] }
  assert.deepEqual(k('(repeat all)'), ['all', 1, null])
  assert.deepEqual(k('Repeat'), ['all', 1, null])
  assert.deepEqual(k('[Repeat from the top]'), ['all', 1, null])
  assert.deepEqual(k('(x2)'), ['times', 2, null])
  assert.deepEqual(k('×3'), ['times', 3, null])
  assert.deepEqual(k('[2x]'), ['times', 2, null])
  assert.deepEqual(k('Oh no (x2)'), ['inline', 2, 'Oh no'])
  assert.deepEqual(k('Oh no x3'), ['inline', 3, 'Oh no'])
  assert.deepEqual(k('[Chorus]'), ['label', 1, 'chorus'])
  assert.deepEqual(k('(chorus)'), ['label', 1, 'chorus'])
  assert.deepEqual(k('Chorus x2'), ['label', 2, 'chorus'])
  assert.deepEqual(k('Verse 2:'), ['label', 1, 'verse 2'])
  assert.deepEqual(k('repeat chorus'), ['ref', 1, 'chorus'])
  assert.deepEqual(k('(Repeat Chorus x2)'), ['ref', 2, 'chorus'])
  assert.deepEqual(k('(repeat 1st verse)'), ['ref', 1, 'verse 1'])
  assert.deepEqual(k('(Repeat the second verse)'), ['ref', 1, 'verse 2'])
})

test('readMarker: sung lines with parentheses or those words are not markers', () => {
  for (const t of ['(oh yeah)', '(I love?!?)', 'Hey hey (hey)', 'Repeat after me', 'I said x', 'Chorus is gone', 'The chorus of birds',
    'We sing the chorus', '(Don’t you know)', 'Oh, oh, oh (whoa)', 'Malcolm X', 'Take 2', 'x', '(x1)', 'Oh no (x12)', 'Verse of my life', 'Number 9']) {
    assert.equal(S.readMarker(t), null, t)
  }
})

test('expandShorthand: "(repeat all)" at the end writes the whole lyric out again, untimed', () => {
  const r = S.expandShorthand(anything())
  assert.equal(r.timed, false)
  assert.equal(r.added, 20)
  assert.equal(r.lines.length, 40)
  assert.ok(r.lines.every((l) => l.t === null), 'their times are not known: the helper places them')
  assert.ok(!r.lines.some((l) => /repeat/i.test(l.text)), 'the marker is never a sung line')
  assert.equal(r.lines[20].text, r.lines[0].text)
  assert.deepEqual(r.markers, [{ line: 20, text: '(repeat all)', kind: 'all' }])
  // LRCLIB's search ranks such a hit behind one that is complete: hitProblem says why
  assert.equal(L.hitProblem(anything(), { duration: 383, title: 'I Don’t Know Anything (Live At the Moore)' }), 'shorthand')
})

test('expandShorthand: xN on a line, alone on a line, and a block label with a count', () => {
  const r = S.expandShorthand([{ t: 1, text: 'Oh no (x3)' }, { t: 5, text: 'Down' }, { t: 7, text: '(x2)' }, { t: 9, text: '[Outro x2]' }, { t: 10, text: 'bye' }])
  assert.deepEqual(r.lines.map((l) => l.text), ['Oh no', 'Oh no', 'Oh no', 'Down', 'Down', 'bye', 'bye'])
  assert.equal(r.added, 4)
})

test('expandShorthand: [Chorus] blocks: labelled once with lines, referred to with nothing under it', () => {
  const r = S.expandShorthand([
    { t: 1, text: '[Verse 1]' }, { t: 2, text: 'v1 a' }, { t: 3, text: 'v1 b' },
    { t: 4, text: '[Chorus]' }, { t: 5, text: 'c a' }, { t: 6, text: 'c b' },
    { t: 7, text: '[Verse 2]' }, { t: 8, text: 'v2 a' },
    { t: 9, text: '[Chorus]' },
    { t: 10, text: '(Repeat 1st verse)' },
    { t: 11, text: 'Chorus x2' }
  ])
  assert.deepEqual(r.lines.map((l) => l.text), ['v1 a', 'v1 b', 'c a', 'c b', 'v2 a', 'c a', 'c b', 'v1 a', 'v1 b', 'c a', 'c b', 'c a', 'c b'])
  assert.equal(r.added, 8)
  assert.deepEqual(r.unresolved, [])
})

test('expandShorthand: an unlabelled "(repeat chorus)" takes the run sung twice; "repeat 1st verse" the first stanza', () => {
  const lines = [{ t: 1, text: 'v a' }, { t: 3, text: 'c a' }, { t: 5, text: 'c b' }, { t: 7, text: 'v b' }, { t: 9, text: 'c a' }, { t: 11, text: 'c b' }, { t: 13, text: '(repeat chorus)' }]
  assert.deepEqual(S.expandShorthand(lines).lines.slice(-2).map((l) => l.text), ['c a', 'c b'])
  // stanzas: the lines between interludes (≥ 4 s without singing)
  const st = [{ t: 10, text: 'one' }, { t: 12, text: 'two' }, { t: 30, text: 'three' }, { t: 32, text: 'four' }, { t: 50, text: '(repeat first verse)' }]
  assert.deepEqual(S.expandShorthand(st).lines.slice(4).map((l) => l.text), ['one', 'two'])
  // a reference to nothing: dropped (never shown), reported
  const none = S.expandShorthand([{ t: 1, text: 'a' }, { t: 2, text: '(repeat bridge)' }])
  assert.deepEqual(none.lines.map((l) => l.text), ['a'])
  assert.equal(none.unresolved.length, 1)
})

test('expandShorthand: labels alone are dropped and the timing kept; lyrics without markers are untouched (null)', () => {
  const r = S.expandShorthand([{ t: 1, text: '[Verse 1]' }, { t: 2, text: 'a' }, { t: 4, text: '[Chorus]' }, { t: 5, text: 'b' }])
  assert.equal(r.timed, true)
  assert.deepEqual(r.lines, [{ t: 2, text: 'a' }, { t: 5, text: 'b' }])
  assert.equal(S.expandShorthand([{ t: 1, text: 'Hey (hey)' }, { t: 2, text: '(oh yeah)' }, { t: 3, text: '(I love?!?)' }]), null)
  assert.equal(S.expandShorthand([{ t: null, text: 'plain (oh)' }]), null)
})

test('fetchLrclib: a hit written as shorthand gives way to a complete search hit; kept when there is none', async () => {
  const res = (status, body) => ({ status, ok: status === 200, json: async () => body })
  const lrc = (lines) => lines.map((l) => '[' + String(Math.floor(l.t / 60)).padStart(2, '0') + ':' + (l.t % 60).toFixed(2).padStart(5, '0') + '] ' + l.text).join('\n')
  const state = { title: 'I Don’t Know Anything (Live At the Moore)', artist: 'Mad Season', duration: 383 }
  const short = { trackName: state.title, duration: 383, syncedLyrics: lrc(anything()) }
  const full = []
  for (let i = 0; i < 40; i++) full.push({ t: 20 + i * 8.5, text: 'line ' + i })
  const complete = { trackName: state.title, duration: 384, syncedLyrics: lrc(full) }
  const logs = []
  const fetch = async (url) => (url.includes('get-cached') ? res(200, short) : res(200, [short, complete]))
  const got = await L.fetchLrclib(state, { fetch, log: (m) => logs.push(m) })
  assert.equal(got.length, 40)
  assert.equal(got[39].text, 'line 39')
  assert.match(logs[0], /shorthand, took another search hit/)
  const only = async (url) => (url.includes('get-cached') ? res(200, short) : res(200, [short]))
  assert.equal((await L.fetchLrclib(state, { fetch: only })).length, 21)     // main.js writes it out
  const down = async (url) => (url.includes('get-cached') ? res(200, short) : res(503))
  assert.equal((await L.fetchLrclib(state, { fetch: down })).length, 21)     // the search failing: the hit stands
})

test('versionNote: shorthand written out, ≤ 60 characters; LRCLIB plain lyrics', () => {
  const on = V.versionNote({ precise: true, reason: 'shorthand', marker: '(repeat all)', added: 20 })
  assert.equal(on.text, 'Lyrics were shorthand, written out: timed after this play')
  assert.match(on.info, /say “\(repeat all\)” instead of the sung lines, so Sonata wrote them out \(20 more lines\)/)
  assert.match(on.info, /a line it can’t find stays un-highlighted/)
  const off = V.versionNote({ precise: false, reason: 'shorthand', marker: '(x2)', added: 1 })
  assert.equal(off.text, 'Lyrics were shorthand, written out: shown without timing')
  assert.equal(V.versionNote({ precise: true, reason: 'untimed' }).text, 'No line timing: Sonata times these lyrics after this play')
  assert.deepEqual(V.versionNote({ precise: false, reason: 'untimed' }), { text: '', info: '' })
  for (const n of [on, off]) assert.ok(n.text.length <= 60)
})
