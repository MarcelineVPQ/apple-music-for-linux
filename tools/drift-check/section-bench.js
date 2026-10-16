#!/usr/bin/env node
// Progressive alignment bench (docs/LYRIC-TIMING.md): the real sonata-align helper on JamendoLyrics
// songs, aligned the way align-session.js does it while a song plays (sections(), one job per
// section with its own audio slice) versus one job for the whole song. Reports the word-start
// error of both against the hand annotations and the helper's time per section job.
//
//   node tools/drift-check/section-bench.js [--limit 20] [--lang English] [--jamendo DIR]
//
// Spawns ITS OWN helper (align-helper.js, the user's install; GPU sharing with a running Sonata is
// fine, nothing of Sonata's is touched) and quits it at the end. Audio is decoded with ffmpeg to the
// capture format (22.05 kHz s16le stereo) in memory.
// loop: none; runs once and exits.
'use strict'
const os = require('os')
const path = require('path')
const { execFileSync } = require('child_process')
const A = require('../../align-session')
const H = require('../../align-helper')
const S = require('./sources')
const L = require('./lib')

const args = process.argv.slice(2)
const opt = (name, def) => { const i = args.indexOf('--' + name); return i >= 0 ? args[i + 1] : def }
const dir = opt('jamendo', path.join(os.homedir(), '.local/share/sonata-align/bench/src/jamendolyrics'))
const songs = S.fromJamendo(dir, { mode: 'lrc', lang: opt('lang') }).slice(0, +opt('limit', 20))
const helper = H.createAlignHelper({ paths: H.helperPaths(process.env, path.join(__dirname, '../..')), log: (m) => console.error('helper:', m) })

function pcmOf(song) {
  return execFileSync('ffmpeg', ['-v', 'error', '-i', song.mp3, '-f', 's16le', '-ac', '2', '-ar', String(A.RATE), '-'], { maxBuffer: 1 << 30 })
}
const slice = (pcm, from, until) => pcm.subarray(Math.round(from * A.RATE) * 4, Math.min(pcm.length, Math.round(until * A.RATE) * 4))

let id = 0
async function main() {
  await helper.ping()
  const errs = { whole: [], sections: [] }
  const jobs = []
  let coverWhole = 0, coverSec = 0, total = 0
  for (const song of songs) {
    const pcm = pcmOf(song)
    const raw = song.raw
    // whole song (the 0.15.31 flow)
    const t0 = Date.now()
    const whole = await helper.align('w' + (++id), A.alignMessages('w' + id, raw, pcm))
    const wholeS = (Date.now() - t0) / 1000
    const eWhole = A.entryFromResult(whole, raw, null)
    // progressive sections (this flow)
    const secs = A.sections(raw)
    const merged = {}
    for (const [k, sec] of secs.entries()) {
      const req = A.sectionRequest(raw, sec, k === 0)
      const until = sec.end + 3
      const t1 = Date.now()
      const res = await helper.align('s' + (++id), A.alignMessages('s' + id, req.lines, slice(pcm, req.offset, until)))
      jobs.push({ s: (Date.now() - t1) / 1000, audio: until - req.offset, lines: sec.to - sec.from + 1 })
      Object.assign(merged, A.entryFromResult(A.sectionResult(res, sec, req.offset), raw, null).lines)
    }
    const score = (lines, out) => {
      for (const [i, a] of Object.entries(lines)) a.words.forEach((w, j) => out.push(w.t - song.truth[i][j].t))
    }
    score(eWhole.lines, errs.whole)
    score(merged, errs.sections)
    coverWhole += Object.keys(eWhole.lines).length
    coverSec += Object.keys(merged).length
    total += Object.keys(song.truth).length
    console.log(song.name.slice(0, 40).padEnd(40), 'sections', String(secs.length).padStart(2), 'whole', wholeS.toFixed(1) + ' s',
      'lines aligned whole/sections', Object.keys(eWhole.lines).length + '/' + Object.keys(merged).length, 'of', Object.keys(song.truth).length)
  }
  const f = (s) => `median ${(s.median * 1000).toFixed(0)} ms, mean ${(s.mean * 1000).toFixed(0)} ms, ≤0.1 s ${(s.within01 * 100).toFixed(0)} %, ≤0.3 s ${(s.within03 * 100).toFixed(0)} %`
  console.log('\nwhole song:', f(L.stats(errs.whole)), '| lines aligned', coverWhole, '/', total)
  console.log('sections:  ', f(L.stats(errs.sections)), '| lines aligned', coverSec, '/', total)
  const js = jobs.map((j) => j.s).sort((a, b) => a - b)
  console.log('section jobs:', jobs.length, '| helper time median', L.quantile(js, 0.5).toFixed(2), 's, p90', L.quantile(js, 0.9).toFixed(2), 's, max', js[js.length - 1].toFixed(2),
    's | audio per job median', L.quantile(jobs.map((j) => j.audio).sort((a, b) => a - b), 0.5).toFixed(0), 's')
}

main().catch((e) => { console.error(e); process.exitCode = 1 }).finally(() => helper.stop())
