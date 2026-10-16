#!/usr/bin/env node
// In-app check for progressive alignment (docs/LYRIC-TIMING.md): while section jobs run through
// the real sonata-align helper INSIDE a running isolated Sonata (its main process, the same
// align-helper.js / align-session.js calls the app makes), does playback in Apple's view stutter?
// A media element plays a generated tone in Apple's view; every 25 ms its currentTime is compared
// with the wall clock. Also measured: the main process's event-loop lag (what the lyric polls ride on).
// Reported for a quiet window first (baseline), then while the jobs run.
//
//   node tools/drift-check/stutter-check.js --cdp 9491 --insp 9492 --display :89 [--song <mp3 name part>] [--jobs 6]
// The isolated Sonata must be started with SONATA_ALIGN_HOME pointing at the helper's install.
// loop: none of its own beyond the sampling below; runs once and exits.
'use strict'
const os = require('os')
const path = require('path')
const fs = require('fs')
const { execFileSync } = require('child_process')
const { createKit } = require('../cdp-lib')
const S = require('./sources')

const args = process.argv.slice(2)
const opt = (name, def) => { const i = args.indexOf('--' + name); return i >= 0 ? args[i + 1] : def }
const kit = createKit({ cdp: Number(opt('cdp', 9491)), insp: Number(opt('insp', 9492)), display: opt('display', ':89') })
const E = "process.mainModule.require('electron')"
const dir = opt('jamendo', path.join(os.homedir(), '.local/share/sonata-align/bench/src/jamendolyrics'))

// in Apple's page: a 120 s tone from a generated WAV, sampled every 25 ms (performance.now, currentTime)
const START = `(async () => {
  const rate = 22050, secs = 120, n = rate * secs
  const buf = new ArrayBuffer(44 + n * 2); const v = new DataView(buf)
  const w = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)) }
  w(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); w(8, 'WAVEfmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true)
  v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true); w(36, 'data'); v.setUint32(40, n * 2, true)
  for (let i = 0; i < n; i++) v.setInt16(44 + i * 2, Math.round(Math.sin(i / rate * 2 * Math.PI * 440) * 3000), true)
  const el = document.createElement('audio'); el.setAttribute('data-sonata-test', '')
  el.src = URL.createObjectURL(new Blob([buf], { type: 'audio/wav' }))
  document.body.appendChild(el)
  await el.play()
  globalThis.__stutter = { el, samples: [], mark: [] }
  globalThis.__stutterTimer = setInterval(() => globalThis.__stutter.samples.push([performance.now(), el.currentTime]), 25)
  return true
})()`
const MARK = (name) => `(globalThis.__stutter.mark.push([${JSON.stringify(name)}, performance.now()]), true)`
const STOP = `(() => { clearInterval(globalThis.__stutterTimer); const s = globalThis.__stutter; s.el.pause(); s.el.remove(); return { samples: s.samples, mark: s.mark } })()`

// continuity between two marks: media time vs wall time, the longest stretch where media time stood
// still, and the worst |media - wall| drift
function continuity(samples, from, to) {
  const s = samples.filter(([t]) => t >= from && t <= to)
  let stall = 0; let run = 0; let worst = 0
  for (let i = 1; i < s.length; i++) {
    const dw = s[i][0] - s[i - 1][0]
    const dm = (s[i][1] - s[i - 1][1]) * 1000
    if (dm < dw * 0.25) { run += dw; stall = Math.max(stall, run) } else run = 0
    worst = Math.max(worst, Math.abs((s[i][1] - s[0][1]) * 1000 - (s[i][0] - s[0][0])))
  }
  const wall = s.length ? s[s.length - 1][0] - s[0][0] : 0
  const media = s.length ? (s[s.length - 1][1] - s[0][1]) * 1000 : 0
  return { seconds: +(wall / 1000).toFixed(1), samples: s.length, mediaPerWall: wall ? +(media / wall).toFixed(4) : 0, longestStallMs: Math.round(stall), worstDriftMs: Math.round(worst) }
}

;(async () => {
  const mp = await kit.mainProc()
  const apple = await kit.target('music.apple.com')
  // the song's audio and lyrics (decoded here, before the clock starts)
  const songs = S.fromJamendo(dir, { mode: 'lrc' })
  const song = songs.find((s) => s.name.includes(opt('song', 'Avercage'))) || songs[0]
  const pcm = execFileSync('ffmpeg', ['-v', 'error', '-i', song.mp3, '-f', 's16le', '-ac', '2', '-ar', '22050', '-'], { maxBuffer: 1 << 30 })
  const pcmFile = path.join(os.tmpdir(), 'sonata-stutter-' + process.pid + '.pcm')
  fs.writeFileSync(pcmFile, pcm)
  const rawFile = pcmFile + '.json'
  fs.writeFileSync(rawFile, JSON.stringify(song.raw))
  // in Sonata's main process: the helper and the section requests, exactly as align-session builds them
  await mp.ev(`(() => {
    const A = process.mainModule.require('./align-session'); const H = process.mainModule.require('./align-helper')
    const fs = require('fs')
    globalThis.__st = { A, H, pcm: fs.readFileSync(${JSON.stringify(pcmFile)}), raw: JSON.parse(fs.readFileSync(${JSON.stringify(rawFile)}, 'utf8')), lag: [] }
    globalThis.__st.helper = H.createAlignHelper({ paths: H.helperPaths(process.env, process.mainModule.path), log: () => {} })
    return H.isInstalled(globalThis.__st.helper ? H.helperPaths(process.env, process.mainModule.path) : {})
  })()`)
  const ready = await mp.ev('globalThis.__st.helper.ping().then((p) => p.device + " " + (p.gpu || ""))')
  // main-process event-loop lag: a 50 ms timer, how late each fires
  await mp.ev(`(() => { let last = performance.now(); globalThis.__st.lagTimer = setInterval(() => { const n = performance.now(); globalThis.__st.lag.push([n, n - last - 50]); last = n }, 50); return true })()`)
  await apple.c.send('Runtime.evaluate', { expression: START, awaitPromise: true, userGesture: true, returnByValue: true })
  await kit.sleep(1000)
  await apple.ev(MARK('quiet'))
  const tq = await mp.ev('performance.now()')
  await kit.sleep(10000)
  await apple.ev(MARK('jobs'))
  const tj = await mp.ev('performance.now()')
  const jobs = await mp.ev(`(async () => {
    const { A, helper, pcm, raw } = globalThis.__st
    const slice = (from, until) => pcm.subarray(Math.round(from * A.RATE) * 4, Math.min(pcm.length, Math.round(until * A.RATE) * 4))
    const out = []
    let id = 0
    for (const [k, sec] of A.sections(raw).slice(0, ${Number(opt('jobs', 6))}).entries()) {
      const req = A.sectionRequest(raw, sec, k === 0)
      const t0 = performance.now()
      const res = await helper.align('st' + (++id), A.alignMessages('st' + id, req.lines, slice(req.offset, sec.end + 3)))
      out.push({ s: +((performance.now() - t0) / 1000).toFixed(2), audio: +(sec.end + 3 - req.offset).toFixed(1), ok: !!res })
    }
    return out
  })()`)
  await apple.ev(MARK('done'))
  const td = await mp.ev('performance.now()')
  const lag = await mp.ev('(() => { clearInterval(globalThis.__st.lagTimer); globalThis.__st.helper.stop(); const l = globalThis.__st.lag; delete globalThis.__st; return l })()')
  const r = await apple.ev(STOP)
  fs.rmSync(pcmFile, { force: true }); fs.rmSync(rawFile, { force: true })
  const m = Object.fromEntries(r.mark)
  const lagIn = (a, b) => { const x = lag.filter(([t]) => t >= a && t <= b).map(([, d]) => d).sort((p, q) => p - q); return { p50: Math.round(x[Math.floor(x.length / 2)] || 0), p99: Math.round(x[Math.floor(x.length * 0.99)] || 0), max: Math.round(x[x.length - 1] || 0) } }
  const out = {
    helper: ready, song: song.name, jobs,
    quiet: Object.assign(continuity(r.samples, m.quiet, m.jobs), { mainLagMs: lagIn(tq, tj) }),
    duringJobs: Object.assign(continuity(r.samples, m.jobs, m.done), { mainLagMs: lagIn(tj, td) })
  }
  out.ok = out.duringJobs.longestStallMs <= Math.max(100, out.quiet.longestStallMs + 50) && Math.abs(out.duringJobs.mediaPerWall - 1) < 0.02
  console.log(JSON.stringify(out, null, 1))
  process.exit(out.ok ? 0 : 1)
})().catch((e) => { console.error(e.stack || e.message); process.exit(2) })
