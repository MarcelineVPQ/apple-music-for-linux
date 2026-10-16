// The page of the DOM proof (dom-check.js): drives the real lyrics view on a virtual clock and
// compares the DOM's lit words with the headless engine, frame by frame.
// loop: one synchronous pass over every song's frames (50 ms of song time each), then done.
'use strict'
const { ipcRenderer } = require('electron')
const T = require('../../lyrics-timing')
const V = require('../../lyrics-view')
const A = require('../../align-session')
const L = require('./lib')
const S = require('./sources')
const M = require('./methods')

// the view reads the clock through performance.now(): make it ours
let fakeMs = 0
Object.defineProperty(performance, 'now', { configurable: true, value: () => fakeMs })

const q = new URLSearchParams(location.search)
const songs = []
if (q.get('cache')) songs.push(...S.fromCache(q.get('cache')))
if (q.get('jamendo')) songs.push(...S.fromJamendo(q.get('jamendo'), { mode: 'lrc' }).slice(0, +q.get('limit') || 6))

const container = document.getElementById('lyrics')
const view = V.createLyricsView({ container, layout: 'scroll' })

/** 'line:word' of every word the user sees lit (.now inside an .active line, main words). */
function domLit() {
  const out = new Set()
  const lines = container.querySelectorAll('.line')
  lines.forEach((el, i) => {
    if (!el.classList.contains('active')) return
    const main = el.querySelector(':scope > div:not(.bgv)')
    if (!main) return
    main.querySelectorAll(':scope > .w').forEach((w, j) => { if (w.classList.contains('now')) out.add(i + ':' + j) })
  })
  return out
}

function deliveries(song, est) {
  // progressive: the sections' aligned words, at the time they reach the view (methods.js)
  const aligned = song.aligned || (song.source.startsWith('cache') ? song.truth : null)
  if (!aligned) return []
  return A.sections(song.raw).map((sec) => {
    const lines = {}
    for (let i = sec.from; i <= sec.to; i++) if (aligned[i]) lines[i] = { text: est[i].text, words: aligned[i].map((w) => ({ t: w.t, end: w.end, text: w.text })) }
    return { at: sec.at + M.HELPER_DELAY, lines }
  }).filter((d) => Object.keys(d.lines).length)
}

const report = { songs: [] }
for (const song of songs) {
  const est = T.estimateWords(song.raw)
  for (const method of ['estimate', 'progressive']) {
    const data = { title: song.name, artist: 'drift', lines: est, estimate: false, source: 'apple' }
    const key = data.title + '|' + data.artist
    fakeMs = 0
    view.setData(data)
    const prep = V.prepare(data)
    let engine = prep.lines
    const due = method === 'progressive' ? deliveries(song, est) : []
    if (method === 'progressive' && !due.length) continue
    const truth = []
    for (const [k, ws] of Object.entries(song.truth)) ws.forEach((w, j) => truth.push({ key: k + ':' + j, t: w.t, end: Math.max(w.end, w.t + 0.08) }))
    truth.sort((a, b) => a.t - b.t)
    let frames = 0, same = 0, sung = 0, domHit = 0, engHit = 0
    const diffs = []
    let d = 0
    const from = Math.max(0, truth[0].t - 1), to = truth[truth.length - 1].end + 1
    for (let t = from; t < to; t += L.FRAME) {
      while (d < due.length && due[d].at <= t) {
        const msg = { key, lines: due[d].lines }
        view.align(msg)
        const got = V.alignedLines(engine, msg, key)
        if (got) engine = V.learnFrom(got.lines)
        d++
      }
      fakeMs = t * 1000
      view.setTime(t, true)
      const dom = domLit()
      const eng = L.highlightAt(engine, t, prep.gaps)
      frames++
      const eq = dom.size === eng.size && [...dom].every((x) => eng.has(x))
      if (eq) same++
      else if (diffs.length < 5) diffs.push({ t: +t.toFixed(2), dom: [...dom], engine: [...eng] })
      const cur = truth.find((w) => w.t <= t && t < w.end)
      if (cur) { sung++; if (dom.has(cur.key)) domHit++; if (eng.has(cur.key)) engHit++ }
    }
    report.songs.push({ song: song.name, method, frames, domEqualsEngine: same / frames, sungFrames: sung, domLitRight: domHit / sung, engineLitRight: engHit / sung, diffs })
  }
}
ipcRenderer.send('dom-check-done', report)
