#!/usr/bin/env node
// Grid search over timing-refine settings on one prepared bench (render + detect once).
//   node tools/listen-bench/tune.js [--songs 8] [--detect '{...}'] [--grid '{"minStrength":[0.8,0.9]}']
// Objective: mean play-1 error at +6 and 0 dB (stereo) plus worseWeight × % of words made worse
// (all stereo SNRs); a mean error above the estimate at −6 dB
// or in mono is penalised 3×.
// loop: none beyond the grid's for-loops; runs once and exits.

const { prepare, evaluate } = require('./bench')

const arg = (name, def) => { const i = process.argv.indexOf('--' + name); return i >= 0 ? process.argv[i + 1] : def }
const conds = prepare({ songs: +arg('songs', 8), detectTuning: JSON.parse(arg('detect', '{}')) })
const grid = JSON.parse(arg('grid', '{}'))
const keys = Object.keys(grid)
const combos = keys.reduce((acc, k) => acc.flatMap((c) => grid[k].map((v) => Object.assign({}, c, { [k]: v }))), [{}])
const results = []
for (const opts of combos) {
  const rows = evaluate(conds, opts, 1)
  const by = (n) => rows.find((r) => r.cond === n)
  const g = (n) => by(n).ref[0].mean - by(n).est.mean
  const W = +arg('worseWeight', 4)
  const score = g('stereo +6 dB') + g('stereo 0 dB') + W * (by('stereo +6 dB').worse + by('stereo 0 dB').worse + by('stereo -6 dB').worse) +
    Math.max(0, g('stereo -6 dB')) * 3 + Math.max(0, g('mono 0 dB')) * 3
  results.push({ opts, score, rows })
}
results.sort((a, b) => a.score - b.score)
for (const r of results.slice(0, +arg('top', 10))) {
  console.log(JSON.stringify(r.opts), 'score', r.score.toFixed(0))
  for (const row of r.rows) console.log(`   ${row.cond.padEnd(14)} est ${row.est.mean.toFixed(0)} -> ${row.ref[0].mean.toFixed(0)} med ${row.est.median.toFixed(0)} -> ${row.ref[0].median.toFixed(0)}  better ${row.better.toFixed(1)}% worse ${row.worse.toFixed(1)}%`)
}
