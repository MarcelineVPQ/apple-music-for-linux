'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const R = require('../song-report')
const X = require('../lyrics-expressive')

// a synthetic song: 6 lines 10 s apart, look-ahead words for 5 of them, notes for 4, the window's draws, 2 corrections
function synthetic() {
  const out = []
  let timer = null
  const rep = R.createSongReport({ log: (m) => out.push(m), setTimeout: (f) => { timer = f; return 1 }, clearTimeout: () => { timer = null } })
  rep.begin({ key: 'k', id: 'Rooster (Live)|Alice in Chains', title: 'Rooster (Live)', version: '0.15.73-dev.1', engine: '0.2.8', lookahead: 'off', kind: 'first play', starts: [10, 20, 30, 40, 50, 60] })
  rep.setLookahead('k', '3 s (cuda)')
  // words: lines 0-3 well ahead (2-3 s), line 4 late by 0.4 s, line 5 never came
  rep.arrived('k', 'words', [{ i: 0, start: 10.2 }], 8)
  rep.arrived('k', 'words', [1], 17.5)
  rep.arrived('k', 'words', [2, 3], 27.7)
  rep.arrived('k', 'words', [4], 50.4)
  rep.arrived('k', 'words', [4], 30)   // a second message for a line: the first arrival counts
  rep.arrived('k', 'notes', [0, 1, 2, 3], 5)
  rep.heard('k', 65)
  rep.drawn({ key: 'k', rows: [
    { i: 0, n: 1, x: { m: 2, d: 2, s: {} } },
    { i: 1, n: 1, x: { m: 1, d: 0, s: { 'line already sung': 1 } } },
    { i: 2, n: 0, x: { m: 0, d: 0, s: {} } }
  ] })
  rep.drawn({ key: 'k', rows: [{ i: 3, n: 1, x: { m: 3, d: 2, s: { 'below threshold': 1 } } }, { i: 4, n: 1, x: null }, { i: 5, n: null, x: null }] })
  rep.helper('timeout')
  rep.end({ n: 2, max: 140, causes: { 'player ahead': 1, 'seek or stall': 1 } })
  return { out, rep, fire: () => timer && timer() }
}

test('song report: the fields from a synthetic song (arrivals, draws, corrections, helper)', () => {
  const { out, rep, fire } = synthetic()
  assert.equal(out.length, 0, 'written once the window\'s last draws are in')
  rep.drawn({ key: 'k', rows: [{ i: 5, n: 1, x: { m: 1, d: 1, s: {} } }] })   // a late batch for the ended song: kept (line 5 had one already)
  fire()
  assert.equal(out.length, 1)
  const text = out[0]
  const [head, second, third] = text.split('\n')
  assert.equal(head, 'song report "Rooster (Live)" · Sonata 0.15.73 Dev · engine 0.2.8 · look-ahead 3 s (cuda)')
  // words: 4 of 6 sung lines ahead; leads 1.8 (10-8 from its own first word 10.2: 2.2), 2.5, 2.3, 12.3, -0.4
  assert.match(second, /^ {2}words ready before sung 67 % \(median lead 2\.3 s, worst −0\.4 s\)/)
  assert.match(second, /notes ready before sung 67 % \(median lead 20\.0 s, worst 5\.0 s\)/)
  assert.match(second, /notes drawn on 4\/5 sung lines/)
  assert.match(second, /expr drawn 4\/6 held words \(1 line already sung, 1 below threshold\)/)
  assert.equal(third, '  clock: 2 corrections (max 140 ms; 1 player ahead, 1 seek or stall) · helper: 1 timed out · first play')
})

test('song report: a song change ends the old report; nothing heard, nothing drawn', () => {
  const out = []
  const rep = R.createSongReport({ log: (m) => out.push(m), closeMs: 0, setTimeout: (f) => { f(); return 0 }, clearTimeout: () => {}, clock: () => null })
  rep.begin({ key: 'a', title: 'A', starts: [5] })
  rep.begin({ key: 'a', title: 'A', starts: [6] })   // the same song laid out again: same report
  assert.equal(out.length, 0)
  rep.begin({ key: 'b', title: 'B', starts: [5] })
  assert.equal(out.length, 1)
  assert.match(out[0], /^song report "A" · look-ahead off\n {2}nothing drawn \(no lyrics window open\)\n {2}clock: no corrections · helper: no failures · play$/)
  rep.mark('x', 'refine play')
  assert.equal(rep.key, 'b')
})

test('song report: the draws message is checked (bad rows dropped, counts bounded)', () => {
  assert.equal(R.cleanRows(null), null)
  assert.equal(R.cleanRows({ key: 1, rows: [] }), null)
  const rows = R.cleanRows({ key: 'k', rows: [{ i: -1 }, { i: 2.5 }, { i: 3, n: 7, x: { m: 2, d: 5, s: { a: 1, b: -1, c: 'x' } } }] })
  assert.deepEqual(rows, [{ i: 3, n: null, x: { m: 2, d: 2, s: { a: 1 } } }])
})

test('developer log: one draw line per line lit', () => {
  assert.equal(R.drawLine({ i: 11, n: 1, x: { m: 3, d: 2, s: { 'line already sung': 1 } } }), 'song report: line 12: notes shown · expr 2/3 (1 line already sung)')
  assert.equal(R.drawLine({ i: 0, n: null, x: null }), 'song report: line 1: band not shown · no expr')
})

test('lineExprReport: skip reasons counted (no vowel data, words differ, wrong repeat, below threshold)', () => {
  const words = [{ text: 'hold', t: 1, end: 2 }, { text: 'me', t: 2, end: 2.5 }, { text: 'now', t: 2.5, end: 3 }]
  const doc = { words: [
    { l: 0, w: 0, i0: 1, i1: 2, x: 'o', t: 1.1, e: 2.2, ld: null },     // held 1.1 s: drawn (a stretch)
    { l: 0, w: 1, i0: null, i1: null, ld: null, t: 2, e: 2.1 },         // nothing measured on the vowel
    { l: 0, w: 2, i0: 1, i1: 2, x: 'u', t: 2.6, e: 2.8 },               // other letters: other words
    { l: 0, w: 0, i0: 1, i1: 2, x: 'o', t: 9, e: 9.9 },                 // the same word in a later repeat: off its time
    { l: 0, w: 2, i0: 1, i1: 2, x: 'o', t: 2.6, e: 2.7 },               // on time, held 0.1 s: below threshold
    { l: 0, w: 5, i0: 0, i1: 1, t: 4, e: 5 },                           // a word the line doesn't have
    { l: 1, w: 0, i0: 1, i1: 2, t: 1.1, e: 2.2 }                        // another line: not counted
  ] }
  const r = X.lineExprReport(doc, 0, words, null)
  assert.equal(r.measured, 6)
  assert.equal(r.drawable, 1)
  assert.deepEqual(r.skip, { 'no vowel data': 1, 'words differ': 2, 'wrong repeat': 1, 'below threshold': 1 })
  assert.deepEqual(X.lineExprReport(null, 0, words), { measured: 0, drawable: 0, skip: {} })
})

test('the draw side is wired: the view reports each line lit, the window batches to main, main checks the sender', () => {
  const fs = require('node:fs')
  const read = (f) => fs.readFileSync(require.resolve('../' + f), 'utf8')
  assert.match(read('lyrics-view.js'), /opts\.onLineSung\(i, sungReport\(i\)\)/)
  assert.match(read('lyrics.html'), /ipcRenderer\.send\('lyrics-command', 'draws', \{ key: drawKey, rows: drawRows \}\)/)
  assert.match(read('main.js'), /command === 'draws'\) \{ if \(lyricsWindow && !lyricsWindow\.isDestroyed\(\) && event\.sender === lyricsWindow\.webContents\) songReport\.drawn\(value\)/)
})
