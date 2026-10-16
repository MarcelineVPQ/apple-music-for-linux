#!/usr/bin/env node
// Listen bench: synthetic songs with known word times -> vocal-detect -> timing-refine, against
// the plain estimate (lyrics-timing estimateWords). See docs/LISTEN-RESULTS.md.
//
//   node tools/listen-bench/bench.js [--songs 8] [--snr 6,0,-6] [--modes stereo,mono]
//        [--plays 3] [--detect '{"persist":7}'] [--refine '{"minStrength":0.9}'] [--md]
//   DEBUG=<snr> prints every word refine made worse at that SNR.
//
// loop: none beyond the bench's own for-loops; runs once and exits.

const { planSong, renderSong } = require('./synth')
const { createVocalDetector } = require('../../vocal-detect')
const { refineWords, mergeLearned, noiseRate, REFINE } = require('../../timing-refine')
const { estimateWords } = require('../../lyrics-timing')

const SR = 22050
const CHUNK = 441   // 20 ms per push, like parec --latency-msec=20

function detect(pcm, tuning) {
  const d = createVocalDetector({ sampleRate: SR, channels: 2, tuning })
  const onsets = [], voiced = []
  const c0 = process.cpuUsage()
  for (let i = 0; i < pcm.length; i += 2 * CHUNK) {
    const r = d.push(pcm.subarray(i, i + 2 * CHUNK), i / 2 / SR)
    onsets.push(...r.onsets); voiced.push(...r.voiced)
  }
  const r = d.flush(); onsets.push(...r.onsets); voiced.push(...r.voiced)
  const c = process.cpuUsage(c0)
  return { onsets, voiced, cpuMs: (c.user + c.system) / 1000, audioSec: pcm.length / 2 / SR }
}

/** Render + detect every song of every condition once. */
function prepare({ songs = 8, snrs = [6, 0, -6], modes = ['stereo', 'mono'], detectTuning = {} } = {}) {
  const conds = []
  for (const mode of modes) {
    for (const snr of snrs) {
      if (mode === 'mono' && snr !== 0) continue        // mono guitar is the worst case; 0 dB only
      const items = []
      for (let song = 1; song <= songs; song++) {
        const plan = planSong(song)
        const { pcm } = renderSong(plan, { sr: SR, snrDb: snr, mode, seed: song })
        const ev = detect(pcm, detectTuning)
        const lines = estimateWords(plan.lines.map((l) => ({ t: l.lrcT, text: l.words.map((w) => w.text).join(' ') })))
        items.push({ song, plan, ev, lines })
      }
      conds.push({ mode, snr, name: `${mode} ${snr > 0 ? '+' : ''}${snr} dB`, items })
    }
  }
  return conds
}

function refineSong(lines, ev, base, opts) {
  return lines.map((line, i) => {
    const words = base[i]
    const lineEnd = words[words.length - 1].end
    const evidence = {
      onsets: ev.onsets.filter((o) => o.t >= line.t - 0.5 && o.t <= lineEnd + 0.5),
      voiced: ev.voiced.filter((v) => v.end >= line.t - 0.5 && v.start <= lineEnd + 0.5)
    }
    const next = lines[i + 1]
    return refineWords(Object.assign({}, line, { words }), evidence, Object.assign({}, opts, { nextStart: next ? next.t : undefined })).words
  })
}

function stats(errs) {
  const a = errs.map(Math.abs).sort((x, y) => x - y)
  const mean = a.reduce((s, x) => s + x, 0) / a.length
  return {
    mean: mean * 1000, median: a[a.length >> 1] * 1000,
    in50: 100 * a.filter((x) => x <= 0.05).length / a.length,
    in100: 100 * a.filter((x) => x <= 0.1).length / a.length
  }
}

function prf(truth, pred) {
  let tp = 0, fp = 0, fn = 0
  for (let i = 0; i < truth.length; i++) {
    if (pred[i] && truth[i]) tp++
    else if (pred[i]) fp++
    else if (truth[i]) fn++
  }
  return { p: tp + fp ? 100 * tp / (tp + fp) : NaN, r: tp + fn ? 100 * tp / (tp + fn) : NaN, n: tp + fn }
}

/** Score one refine setting on prepared conditions. */
function evaluate(conds, opts = {}, plays = 3, debugSnr = null) {
  const holdMin = opts.holdMin || REFINE.holdMin
  return conds.map((c) => {
    const estE = [], refE = Array.from({ length: plays }, () => [])
    const heldTruth = [], heldEst = [], heldRef = [], endEst = [], endRef = []
    let worse = 0, better = 0, total = 0
    const noiseRates = []
    for (const { song, plan, ev, lines } of c.items) {
      let learned = null
      const perPlay = []
      const noise = opts.noiseGate === false ? null : noiseRate(ev.onsets, lines, Infinity, opts).rate
      noiseRates.push(noise)
      for (let play = 1; play <= plays; play++) {
        const refined = refineSong(lines, ev, learned || lines.map((l) => l.words), Object.assign({}, opts, { noiseRate: noise }))
        learned = learned ? learned.map((ws, i) => mergeLearned(ws, refined[i], play)) : refined
        perPlay.push(learned)
      }
      plan.lines.forEach((pl, li) => {
        pl.words.forEach((w, wi) => {
          const e = lines[li].words[wi], r = perPlay[0][li][wi]
          estE.push(e.t - w.t)
          for (let p = 0; p < plays; p++) refE[p].push(perPlay[p][li][wi].t - w.t)
          const de = Math.abs(e.t - w.t), dr = Math.abs(r.t - w.t)
          if (dr > de + 0.05) {
            worse++
            if (debugSnr !== null && c.snr === debugSnr) {
              const near = ev.onsets.filter((o) => Math.abs(o.t - w.t) < 0.4).map((o) => (o.t - w.t).toFixed(2) + '/' + o.strength.toFixed(1)).join(' ')
              console.log(`song ${song} line ${li} word ${wi} "${w.text}" est ${(e.t - w.t).toFixed(2)} ref ${(r.t - w.t).toFixed(2)} onsets[${near}]`)
            }
          }
          if (dr < de - 0.05) better++
          total++
          heldTruth.push(w.held); heldEst.push(e.end - e.t >= holdMin); heldRef.push(!!r.held)
          if (w.held) { endEst.push(e.end - w.end); endRef.push(r.end - w.end) }
        })
      })
    }
    return {
      cond: c.name, mode: c.mode, snr: c.snr, words: total, noise: noiseRates,
      est: stats(estE), ref: refE.map(stats), worse: 100 * worse / total, better: 100 * better / total,
      holdEst: prf(heldTruth, heldEst), holdRef: prf(heldTruth, heldRef),
      holdEndEst: stats(endEst), holdEndRef: stats(endRef)
    }
  })
}

const f = (x, d = 0) => (Number.isFinite(x) ? x.toFixed(d) : '–')

function printRows(rows, md) {
  if (md) {
    console.log('| Condition | Words | Method | Mean err (ms) | Median (ms) | ≤ 50 ms | ≤ 100 ms |')
    console.log('|---|---|---|---|---|---|---|')
    for (const r of rows) {
      console.log(`| ${r.cond} | ${r.words} | estimate | ${f(r.est.mean)} | ${f(r.est.median)} | ${f(r.est.in50)} % | ${f(r.est.in100)} % |`)
      r.ref.forEach((s, p) => console.log(`| | | refined, play ${p + 1} | ${f(s.mean)} | ${f(s.median)} | ${f(s.in50)} % | ${f(s.in100)} % |`))
    }
    console.log('\n| Condition | Words better / worse by > 50 ms (play 1) | Held words | Hold P / R, estimate | Hold P / R, refined | Held-word end error, mean ms (estimate → refined) |')
    console.log('|---|---|---|---|---|---|')
    for (const r of rows) {
      console.log(`| ${r.cond} | ${f(r.better, 1)} % / ${f(r.worse, 1)} % | ${r.holdRef.n} | ${f(r.holdEst.p)} / ${f(r.holdEst.r)} % | ${f(r.holdRef.p)} / ${f(r.holdRef.r)} % | ${f(r.holdEndEst.mean)} → ${f(r.holdEndRef.mean)} |`)
    }
  } else {
    for (const r of rows) {
      console.log(`${r.cond.padEnd(14)} n=${r.words}  est mean ${f(r.est.mean)} med ${f(r.est.median)} ≤50 ${f(r.est.in50)}% ≤100 ${f(r.est.in100)}%`)
      r.ref.forEach((s, p) => console.log(`${''.padEnd(14)} play${p + 1} mean ${f(s.mean)} med ${f(s.median)} ≤50 ${f(s.in50)}% ≤100 ${f(s.in100)}%`))
      console.log(`${''.padEnd(14)} noise/s ${r.noise.map((x) => f(x, 1)).join(' ')}`)
      console.log(`${''.padEnd(14)} better ${f(r.better, 1)}% worse ${f(r.worse, 1)}%  hold est P${f(r.holdEst.p)} R${f(r.holdEst.r)}  ref P${f(r.holdRef.p)} R${f(r.holdRef.r)} (n=${r.holdRef.n})  held end err est ${f(r.holdEndEst.mean)} ref ${f(r.holdEndRef.mean)}`)
    }
  }
}

module.exports = { prepare, evaluate, printRows, detect, SR }

if (require.main === module) {
  const arg = (name, def) => { const i = process.argv.indexOf('--' + name); return i >= 0 ? process.argv[i + 1] : def }
  const conds = prepare({
    songs: +arg('songs', 8),
    snrs: arg('snr', '6,0,-6').split(',').map(Number),
    modes: arg('modes', 'stereo,mono').split(','),
    detectTuning: JSON.parse(arg('detect', '{}'))
  })
  const rows = evaluate(conds, JSON.parse(arg('refine', '{}')), +arg('plays', 3), process.env.DEBUG != null ? +process.env.DEBUG : null)
  printRows(rows, process.argv.includes('--md'))
  let cpu = 0, sec = 0
  for (const c of conds) for (const it of c.items) { cpu += it.ev.cpuMs; sec += it.ev.audioSec }
  console.log(`\ndetector CPU: ${(cpu / sec).toFixed(2)} ms per second of stereo audio at ${SR} Hz (${(cpu / sec / 10).toFixed(2)} % of one core), ${f(sec / 60, 1)} min of audio`)
}
