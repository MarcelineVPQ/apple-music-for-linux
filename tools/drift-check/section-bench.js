#!/usr/bin/env node
// Progressive alignment bench (docs/LYRIC-TIMING.md): the real sonata-align helper on JamendoLyrics
// songs, aligned the way align-session.js does it while a song plays (sections(), one job per
// section with its own audio slice) versus one job for the whole song. Reports the word-start
// error of both against the hand annotations and the helper's time per section job. Since 0.15.38
// also the final pass built from the sections the helper kept (separate once per song: no audio,
// only the Viterbi again), its accuracy against the whole-song job, and the helper time per song
// for both flows (before: sections + whole song; after: sections + kept final).
//
//   node tools/drift-check/section-bench.js [--limit 20] [--offset 0] [--lang English] [--jamendo DIR] [--align-dir DIR]
//        [--vocable 0.15,0.1,0.05] [--json out.json]
//
// --offset/--limit run a slice of the 79 songs (keep one GPU run short); --json writes the raw errors
// (and the vocable lines) so slices can be added up. --vocable: for each confidence X, the short vocable
// lines (lib.js vocableLine) keeping them from confidence X would add, from the same helper results,
// against the hand annotations and against the first-play estimate of those lines (0.15.39).
//
// --align-dir runs another checkout's align/ scripts (a before/after comparison); without the
// song-cache feature the kept final is skipped. SONATA_ALIGN_VRAM_FRACTION caps the helper's VRAM.
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
const songs = S.fromJamendo(dir, { mode: 'lrc', lang: opt('lang') }).slice(+opt('offset', 0), +opt('offset', 0) + +opt('limit', 20))
const vocable = opt('vocable') ? opt('vocable').split(',').map(Number) : []
const T = require('../../lyrics-timing')
const fs = require('fs')
const alignDir = opt('align-dir', null)
const paths = H.helperPaths(process.env, path.join(__dirname, '../..'))
if (alignDir) paths.server = path.join(path.resolve(alignDir), 'server.py')
const helper = H.createAlignHelper({ paths, log: (m) => console.error('helper:', m) })
// the helper's own VRAM as the driver sees it (nvidia-smi), MB; null without NVIDIA
function helperVram() {
  try {
    const out = execFileSync('nvidia-smi', ['--query-compute-apps=pid,used_memory', '--format=csv,noheader,nounits'], { encoding: 'utf8' })
    const row = out.split('\n').map((l) => l.split(',').map((x) => x.trim())).find((r) => +r[0] === helper.pid)
    return row ? +row[1] : null
  } catch (e) { return null }
}

function pcmOf(song) {
  return execFileSync('ffmpeg', ['-v', 'error', '-i', song.mp3, '-f', 's16le', '-ac', '2', '-ar', String(A.RATE), '-'], { maxBuffer: 1 << 30 })
}
const slice = (pcm, from, until) => pcm.subarray(Math.round(from * A.RATE) * 4, Math.min(pcm.length, Math.round(until * A.RATE) * 4))

let id = 0
async function main() {
  const pong = await helper.ping()
  const kept = (pong.features || []).includes('song-cache')
  // warm-up (model load, first kernels): not timed
  if (songs.length) await helper.align('warm', A.alignMessages('warm', songs[0].raw.slice(0, 1), slice(pcmOf(songs[0]), 0, 12)))
  const errs = { whole: [], sections: [], kept: [], wholeBoth: [], keptBoth: [] }
  const vocab = {}
  const rejectedAll = []
  const jobs = []
  const perSong = []
  let peakVram = 0
  let coverWhole = 0, coverSec = 0, coverKept = 0, total = 0
  let n = 0
  for (const song of songs) {
    const songId = 'bench' + (++n)
    const pcm = pcmOf(song)
    const raw = song.raw
    // whole song (the 0.15.31 flow)
    const t0 = Date.now()
    const whole = await helper.align('w' + (++id), A.alignMessages('w' + id, raw, pcm))
    const wholeS = (Date.now() - t0) / 1000
    const eWhole = A.entryFromResult(whole, raw, null)
    // progressive sections (this flow)
    peakVram = Math.max(peakVram, helperVram() || 0)
    const secs = A.sections(raw)
    const merged = {}
    const secResults = []
    let secS = 0
    for (const [k, sec] of secs.entries()) {
      const req = A.sectionRequest(raw, sec, k === 0)
      const until = sec.end + 3
      const t1 = Date.now()
      const res = await helper.align('s' + (++id), A.alignMessages('s' + id, req.lines, slice(pcm, req.offset, until), { song: songId, offset: req.offset }))
      const took = (Date.now() - t1) / 1000
      secS += took
      jobs.push({ s: took, audio: until - req.offset, lines: sec.to - sec.from + 1 })
      const mapped = A.sectionResult(res, sec, req.offset)
      secResults.push(mapped)
      Object.assign(merged, A.entryFromResult(mapped, raw, null).lines)
    }
    peakVram = Math.max(peakVram, helperVram() || 0)
    // the final pass from the kept sections (this flow since 0.15.38)
    let eKept = null
    let keptS = null
    if (kept && secs.length > 1) {
      const t2 = Date.now()
      // error: LOGGED-OK — the helper dropped this song's sections (its cache budget): no kept final for
      // it (the app sends the audio again then, as the whole-song job above)
      const res = await helper.align('k' + (++id), A.finalMessages('k' + id, raw, songId)).catch((e) => {
        if (e && e.code === 'no-cache') { console.error('kept final: the helper no longer has', song.name); return null }
        throw e
      })
      keptS = res ? (Date.now() - t2) / 1000 : null
      eKept = res ? A.entryFromResult(res, raw, null) : null
    }
    // the vocable lines each X would add (whole song and sections): their errors, and the estimate's
    const est = T.estimateWords(raw)
    const addVocable = (result, which, mapped) => {
      const before = A.entryFromResult(mapped, raw, null)
      for (const x of vocable) {
        const keep = (r) => r.aligned || (Number(r.confidence) >= x && Array.isArray(r.words) && r.words.length > 0 && raw[r.line] && L.vocableLine(raw[r.line].text))
        const after = A.entryFromResult(Object.assign({}, mapped, { lines: (mapped.lines || []).map((r) => (r && keep(r) ? Object.assign({}, r, { aligned: true }) : r)) }), raw, null)
        const v = (vocab[which + ':' + x] = vocab[which + ':' + x] || { lines: 0, aligned: [], estimate: [], conf: [] })
        for (const [i, a] of Object.entries(after.lines)) {
          if (before.lines[i]) continue
          v.lines++
          a.words.forEach((w, j) => { v.aligned.push(w.t - song.truth[i][j].t); v.estimate.push(est[i].words[j].t - song.truth[i][j].t) })
        }
      }
      for (const r of before.rejected) rejectedAll.push({ which, song: song.name, line: r.line, confidence: r.confidence, text: raw[r.line].text, vocable: L.vocableLine(raw[r.line].text) })
    }
    addVocable(whole, 'whole', whole)
    for (const m of secResults) addVocable(m, 'sections', m)
    const score = (lines, out) => {
      for (const [i, a] of Object.entries(lines)) a.words.forEach((w, j) => out.push(w.t - song.truth[i][j].t))
    }
    score(eWhole.lines, errs.whole)
    score(merged, errs.sections)
    if (eKept) {
      // the same lines in both (each may accept a line the other rejects)
      const both = (a, b) => Object.fromEntries(Object.entries(a).filter(([i]) => b[i]))
      score(both(eWhole.lines, eKept.lines), errs.wholeBoth)
      score(both(eKept.lines, eWhole.lines), errs.keptBoth)
    }
    if (eKept) { score(eKept.lines, errs.kept); coverKept += Object.keys(eKept.lines).length } else if (kept) { score(eWhole.lines, errs.kept); coverKept += Object.keys(eWhole.lines).length }
    coverWhole += Object.keys(eWhole.lines).length
    coverSec += Object.keys(merged).length
    total += Object.keys(song.truth).length
    // a song of one section has no extra pass in the app (that section was the whole song)
    perSong.push({ before: secS + (secs.length > 1 ? wholeS : 0), after: secS + (secs.length > 1 ? (keptS == null ? wholeS : keptS) : 0) })
    console.log(song.name.slice(0, 40).padEnd(40), 'sections', String(secs.length).padStart(2), 'whole', wholeS.toFixed(1) + ' s',
      kept ? 'kept final ' + (keptS == null ? '-' : keptS.toFixed(2) + ' s') : '',
      'lines aligned whole/sections' + (kept ? '/kept' : ''), Object.keys(eWhole.lines).length + '/' + Object.keys(merged).length + (kept ? '/' + (eKept ? Object.keys(eKept.lines).length : '-') : ''), 'of', Object.keys(song.truth).length)
  }
  const f = (s) => `median ${(s.median * 1000).toFixed(0)} ms, mean ${(s.mean * 1000).toFixed(0)} ms, ≤0.1 s ${(s.within01 * 100).toFixed(0)} %, ≤0.3 s ${(s.within03 * 100).toFixed(0)} %`
  console.log('\nwhole song:', f(L.stats(errs.whole)), '| lines aligned', coverWhole, '/', total)
  console.log('sections:  ', f(L.stats(errs.sections)), '| lines aligned', coverSec, '/', total)
  if (kept) console.log('kept final:', f(L.stats(errs.kept)), '| lines aligned', coverKept, '/', total)
  if (kept && errs.keptBoth.length) console.log('same lines: whole', f(L.stats(errs.wholeBoth)), '| kept', f(L.stats(errs.keptBoth)), '|', errs.keptBoth.length, 'words')
  const sum = (k) => perSong.reduce((a, x) => a + x[k], 0) / Math.max(1, perSong.length)
  console.log('helper s per song: sections + whole song', sum('before').toFixed(2), '| sections + kept final', kept ? sum('after').toFixed(2) : '-')
  await new Promise((r) => setTimeout(r, 300))
  console.log('helper VRAM (nvidia-smi): max between jobs', peakVram || '-', 'MB | resting after the last job', helperVram() || '-', 'MB')
  for (const [k, v] of Object.entries(vocab)) {
    console.log('vocable lines added at', k, ':', v.lines, 'lines | aligned', v.aligned.length ? f(L.stats(v.aligned)) : '-', '| estimate', v.estimate.length ? f(L.stats(v.estimate)) : '-')
  }
  if (opt('json')) fs.writeFileSync(opt('json'), JSON.stringify({ errs, vocab, rejected: rejectedAll, cover: { whole: coverWhole, sections: coverSec, kept: coverKept, total }, jobs, perSong }))
  const js = jobs.map((j) => j.s).sort((a, b) => a - b)
  console.log('section jobs:', jobs.length, '| helper time median', L.quantile(js, 0.5).toFixed(2), 's, p90', L.quantile(js, 0.9).toFixed(2), 's, max', js[js.length - 1].toFixed(2),
    's | audio per job median', L.quantile(jobs.map((j) => j.audio).sort((a, b) => a - b), 0.5).toFixed(0), 's')
}

main().catch((e) => { console.error(e); process.exitCode = 1 }).finally(() => helper.stop())
