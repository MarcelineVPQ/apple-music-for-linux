// Song sections from the lyrics (lyrics-sections.js). Fixtures are placeholder words, never lyric text:
// each line id ("v1a", "c2") stands for a line of made-up words (say), so only the song's shape is tested.
// The real cached songs were checked by hand (Dancing Queen, Mamma Mia: see the commit).
const test = require('node:test')
const assert = require('node:assert/strict')
const S = require('../lyrics-sections')

// a line of five made-up words for an id (the same id: the same line)
const SYL = ['ka', 'lo', 'mi', 'ten', 'ru', 'sa', 'vo', 'ne', 'pi', 'dar', 'qu', 'zel', 'fo', 'bi', 'gan']
function say(id) {
  let h = 7
  for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) >>> 0
  const out = []
  for (let k = 0; k < 5; k++) { out.push(SYL[h % 15] + SYL[(h >>> 4) % 15] + SYL[(h >>> 8) % 15]); h = (h * 1103515245 + 12345) >>> 0 }
  return out.join(' ')
}
// stanzas: arrays of line ids (or { id, text } for a variant), timed 3 s apart with a 6 s pause between
// stanzas; untimed: t null, no pauses
function song(stanzas, timed = true) {
  const lines = []
  let t = 10
  for (const st of stanzas) {
    for (const x of st) {
      const text = typeof x === 'string' ? say(x) : x.text
      lines.push(timed ? { t, end: t + 2.6, text } : { t: null, text })
      t += 3
    }
    t += 6
  }
  return lines
}
const labels = (lines, title) => S.songSections(lines, { title }).filter((s) => s.label).map((s) => s.label + '@' + s.start)

const V1 = ['v1a', 'v1b', 'v1c', 'v1d']
const V2 = ['v2a', 'v2b', 'v2c', 'v2d']
const V3 = ['v3a', 'v3b', 'v3c', 'v3d']
const C = ['c1', 'c2', 'c3', 'c4']
const P = ['p1', 'p2']

test('words: lower case, no punctuation, brackets or interjections', () => {
  assert.deepEqual(S.words('Ooh-ooh, you can DANCE (yeah!) — jive'), ['you', 'can', 'dance', 'jive'])
  assert.deepEqual(S.words('Whoa-oh'), [])
  assert.ok(S.sameLine(S.words('one two three four five'), S.words('one two three four five six')))
  assert.ok(!S.sameLine(S.words('one two three'), S.words('one two four')))
})

test('verse, chorus, verse, chorus, bridge, chorus', () => {
  const B = ['b1', 'b2']
  assert.deepEqual(labels(song([V1, C, V2, C, B, C])), ['Verse 1@0', 'Chorus@4', 'Verse 2@8', 'Chorus@12', 'Bridge@16', 'Chorus@18'])
})

test('a third verse like the others stays a verse, never a Bridge', () => {
  assert.deepEqual(labels(song([V1, C, V2, C, V3, C])), ['Verse 1@0', 'Chorus@4', 'Verse 2@8', 'Chorus@12', 'Verse 3@16', 'Chorus@20'])
})

test('a pre-chorus: the short block right before every chorus, with no break between', () => {
  assert.deepEqual(labels(song([V1, [...P, ...C], V2, [...P, ...C], C])), ['Verse 1@0', 'Pre-chorus@4', 'Chorus@6', 'Verse 2@10', 'Pre-chorus@14', 'Chorus@16'])
})

test('a chorus block holding the title after two lines: those lines are the pre-chorus', () => {
  const lines = song([V1, [...P, ...C], V2, [...P, ...C]])
  const title = lines[6].text.split(' ').slice(1, 3).join(' ')
  assert.deepEqual(labels(lines, title), ['Verse 1@0', 'Pre-chorus@4', 'Chorus@6', 'Verse 2@10', 'Pre-chorus@14', 'Chorus@16'])
})

test('choruses sung with ad-libs, an extra word and a "Whoa-oh" line are still the chorus', () => {
  const C2 = [{ text: say('c1') + ' (oh yeah)' }, { text: 'Ooh, ' + say('c2') }, 'c3', { text: 'Whoa-oh' }, { text: say('c4') + ' now' }]
  const C3 = ['c1', { text: say('c2') + ', yeah!' }, 'c3', 'c4']
  assert.deepEqual(labels(song([V1, C, V2, C2, V3, C3])), ['Verse 1@0', 'Chorus@4', 'Verse 2@8', 'Chorus@12', 'Verse 3@17', 'Chorus@21'])
})

test('"(repeat all)" written out (untimed, no breaks): the copy takes the labels of what it copies', () => {
  const half = [...V1, ...C, ...V2, ...C]
  assert.deepEqual(labels(song([[...half, ...half]], false)),
    ['Verse 1@0', 'Chorus@4', 'Verse 2@8', 'Chorus@12', 'Verse 1@16', 'Chorus@20', 'Verse 2@24', 'Chorus@28'])
})

test('plain lyrics with blank lines between stanzas (brk) split like timed pauses', () => {
  const lines = song([V1, C, V2, C, C], false)
  for (const i of [4, 8, 12, 16]) lines[i].brk = true
  assert.deepEqual(labels(lines), ['Verse 1@0', 'Chorus@4', 'Verse 2@8', 'Chorus@12'])
})

test('a live version with extra chorus repeats: one Chorus label over the run', () => {
  assert.deepEqual(labels(song([V1, C, V2, [...C, ...C, ...C]])), ['Verse 1@0', 'Chorus@4', 'Verse 2@8', 'Chorus@12'])
})

test('a through-composed song (nothing repeats) gets no labels', () => {
  const st = (k) => ['a', 'b', 'c', 'd'].map((x) => 's' + k + x)
  assert.deepEqual(S.songSections(song([st(1), st(2), st(3), st(4), st(5)])), [])
  // one couplet heard twice is not a chorus
  assert.deepEqual(S.songSections(song([[...st(1), 'r1', 'r2'], st(2), [...st(3), 'r1', 'r2'], st(4)])), [])
})

test("Apple's own part names (itunes:songPart) are used as given", () => {
  const lines = song([V1, C, V2, C])
  lines[0].part = 'Verse'; lines[4].part = 'Chorus'; lines[8].part = 'Verse'; lines[12].part = 'Chorus'
  assert.deepEqual(labels(lines), ['Verse 1@0', 'Chorus@4', 'Verse 2@8', 'Chorus@12'])
})

test("Apple naming every part the same (all \"Verse\") says nothing: the repetition decides (Sunbeam, 2026-10-19)", () => {
  const lines = song([V1, C, V2, C, V3, C])
  for (const i of [0, 4, 8, 12, 16, 20]) lines[i].part = 'Verse'
  assert.deepEqual(labels(lines), ['Verse 1@0', 'Chorus@4', 'Verse 2@8', 'Chorus@12', 'Verse 3@16', 'Chorus@20'])
})

test('sections end where the next starts; the last at the song end', () => {
  const secs = S.songSections(song([V1, C, V2, C]))
  assert.deepEqual(secs.map((s) => [s.start, s.end]), [[0, 4], [4, 8], [8, 12], [12, 16]])
})

test('singer names: off (the duet switch) -> the section only; on -> who sings each section', () => {
  const lines = song([V1, C, V2, C])
  lines.forEach((l, i) => { l.agent = i < 4 ? 'v1' : i >= 8 && i < 12 ? 'v2' : 'group' })
  lines[13].agent = 'v1'
  const secs = S.songSections(lines)
  assert.equal(S.NAMES, require('../lyrics-lanes').LANES)
  assert.equal(S.NAMES, false)
  assert.deepEqual(S.withSingers(secs, lines, { v1: 'Sophie' }).map(S.labelText), ['Verse 1', 'Chorus', 'Verse 2', 'Chorus'])
  assert.deepEqual(S.withSingers(secs, lines, { v1: 'Sophie' }, { on: true }).map(S.labelText),
    ['Verse 1 — Sophie', 'Chorus — Together', 'Verse 2 — Singer 2', 'Chorus — Together'])
  // both singers in one section: joined with " & "
  lines.forEach((l, i) => { if (i >= 4 && i < 8) l.agent = i % 2 ? 'v2' : 'v1' })
  assert.equal(S.labelText(S.withSingers(S.songSections(lines), lines, { v1: 'Sophie', v2: 'Sky' }, { on: true })[1]), 'Chorus — Sophie & Sky')
  // one singer: no names even when on
  const solo = song([V1, C, V2, C])
  assert.deepEqual(S.withSingers(S.songSections(solo), solo, null, { on: true }).map(S.labelText), ['Verse 1', 'Chorus', 'Verse 2', 'Chorus'])
})
