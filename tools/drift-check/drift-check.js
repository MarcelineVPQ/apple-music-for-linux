#!/usr/bin/env node
// Drift check (docs/LYRIC-TIMING.md): word-timing methods against the sung words, per song and
// overall: word-start error, drift within a line (error vs word index), error at line and verse
// ends, and the frame check (is the word being sung the one the view lights, every 50 ms).
//
//   node tools/drift-check/drift-check.js [--cache COPY.json] [--jamendo DIR] [--mode lrc|ends]
//        [--jitter 0.3] [--results bench.json] [--audio --work DIR] [--methods v0,estimate,...]
//        [--json out.json] [--songs]
//
//   --cache   a COPY of ~/.config/apple-music-for-linux/lyrics-cache.json (cp it first; this reads it
//             only, but never point tools at a live app's files)
//   --jamendo JamendoLyrics folder (default ~/.local/share/sonata-align/bench/src/jamendolyrics if present)
//   --results bench.py --out JSON with exact anchors (default .../bench/results/auto-j0.json): the
//             aligned method for JamendoLyrics
//   --audio   run the Level 1 detector on the JamendoLyrics mp3s (ffmpeg, cached in --work) for the
//             refine methods
// loop: none; runs once and exits.
'use strict'
const fs = require('fs')
const os = require('os')
const path = require('path')
const L = require('./lib')
const S = require('./sources')
const M = require('./methods')

const args = process.argv.slice(2)
const opt = (name, def) => { const i = args.indexOf('--' + name); return i >= 0 ? args[i + 1] : def }
const flag = (name) => args.includes('--' + name)
const BENCH = path.join(os.homedir(), '.local/share/sonata-align/bench')

const sets = []
if (opt('cache')) sets.push({ label: 'her library (Apple line-timed, truth = aligned)', songs: S.fromCache(opt('cache')) })
const jdir = opt('jamendo', path.join(BENCH, 'src/jamendolyrics'))
if (!flag('no-jamendo') && fs.existsSync(jdir)) {
  const mode = opt('mode', 'lrc')
  sets.push({
    label: 'JamendoLyrics ' + mode + (opt('jitter') ? ' ±' + opt('jitter') + ' s' : '') + ' (truth = hand annotations)',
    songs: S.fromJamendo(jdir, { mode, jitter: +opt('jitter', 0), results: opt('results', path.join(BENCH, 'results/auto-j0.json')), lang: opt('lang') })
  })
}
const work = opt('work', path.join(os.tmpdir(), 'sonata-drift-check'))
const methods = opt('methods', 'v0,estimate,repeat,progressive,refine,refine+repeat,aligned').split(',')

const ms = (x) => Number.isFinite(x) ? (x * 1000).toFixed(0) : '–'
const pc = (x) => Number.isFinite(x) ? (x * 100).toFixed(0) + '%' : '–'
const report = {}
for (const set of sets) {
  console.log('\n## ' + set.label + ': ' + set.songs.length + ' songs')
  const audio = flag('audio')
  const per = {}
  for (const song of set.songs) {
    if (audio && song.mp3) song.audio = S.detectAudio(song, work)
    for (const m of methods) {
      const lines = M.run(m, song)
      if (!lines) continue
      const r = L.evaluate(song, lines)
      ;(per[m] = per[m] || []).push(r)
      if (flag('songs')) {
        const s = L.summarize(L.combine([r]))
        console.log('  ' + song.name.slice(0, 44).padEnd(44) + ' ' + m.padEnd(16) + ' med ' + ms(s.start.median).padStart(4) + ' mean ' + ms(s.start.mean).padStart(4) +
          ' p90 ' + ms(s.start.p90).padStart(5) + ' bias ' + ms(s.start.bias).padStart(5) + ' slope ' + ms(s.slopeMedian).padStart(4) + ' verse-end ' + ms(s.verseEnd.mean).padStart(5) + ' frames ' + pc(s.frames.hitRate))
      }
    }
  }
  console.log('| method | words | median | mean | p90 | bias | ≤0.1 s | ≤0.3 s | slope ms/word (median) | line-end mean (bias) | verse-end mean (bias) | frames lit right |')
  console.log('|---|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|')
  report[set.label] = {}
  for (const m of methods) {
    if (!per[m]) continue
    const s = L.summarize(L.combine(per[m]))
    report[set.label][m] = s
    console.log('| ' + [m, s.start.n, ms(s.start.median), ms(s.start.mean), ms(s.start.p90), ms(s.start.bias), pc(s.start.within01), pc(s.start.within03),
      ms(s.slopeMedian), ms(s.lineEnd.mean) + ' (' + ms(s.lineEnd.bias) + ')', ms(s.verseEnd.mean) + ' (' + ms(s.verseEnd.bias) + ')', pc(s.frames.hitRate)].join(' | ') + ' |')
  }
  console.log('\nheld notes (truth words sung ≥ ' + L.HELD_MIN + ' s): when the highlight ends vs when the voice stops')
  console.log('| method | held words | end error mean | end bias (+ late) | ended ≥ ' + (L.EARLY * 1000) + ' ms early | held frames lit right |')
  console.log('|---|--:|--:|--:|--:|--:|')
  for (const m of methods) {
    const s = report[set.label][m]
    if (!s || !s.held) continue
    console.log('| ' + [m, s.held.n, ms(s.held.end.mean), ms(s.held.end.bias), pc(s.held.earlyRate), pc(s.held.hitRate)].join(' | ') + ' |')
  }
  if (flag('deciles')) {
    console.log('\nsigned start error (ms) by position in the line (deciles of word index):')
    for (const m of methods) if (report[set.label][m]) console.log('  ' + m.padEnd(16) + report[set.label][m].byRel.map((x) => ms(x.bias).padStart(5)).join(' '))
  }
}
if (opt('json')) fs.writeFileSync(opt('json'), JSON.stringify(report, null, 1))
