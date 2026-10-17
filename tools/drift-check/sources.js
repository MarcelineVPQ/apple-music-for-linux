// Song sources for the drift check. Every song is { name, source, raw, truth, aligned?, audio? }:
//   raw    the lyric lines as Sonata gets them (line-only: { t, end?, text })
//   truth  { lineIndex: [{ t, end, text }] }: where each word is really sung
//   aligned (JamendoLyrics only) the aligner's output from align/bench.py, to score "aligned"
//
// 1. A COPY of Sonata's lyrics cache (never the live file: cp it to a scratch folder first). Songs
//    with an `aligned|title|artist` entry: truth = the GPU aligner's words (median 0.032 s from
//    hand annotations on the benchmark, docs/LEVEL2-ALIGN.md), raw = the cached Apple/LRCLIB lines.
// 2. JamendoLyrics MultiLang (align/bench.py's copy in ~/.local/share/sonata-align/bench): 79 songs
//    with hand-annotated word starts and ends. Input modes: 'lrc' (line starts only, like LRCLIB) and
//    'ends' (line starts and ends, like Apple's line-timed TTML when its ends are tight).
// loop: none beyond one-shot reads; nothing is kept between runs except the onset cache (--work).
'use strict'
const fs = require('fs')
const path = require('path')
const { execFileSync } = require('child_process')
const L = require('./lib')

const words = (text) => String(text || '').split(/\s+/).filter(Boolean)

function fromCache(file) {
  const data = JSON.parse(fs.readFileSync(file, 'utf8'))
  const map = new Map(data.entries || [])
  const songs = []
  for (const [key, entry] of map) {
    if (!key.startsWith('aligned|') || !entry || !entry.lines) continue
    const raw = map.get(key.slice('aligned|'.length))
    if (!raw || !Array.isArray(raw.lines)) continue
    const truth = {}
    for (const [i, a] of Object.entries(entry.lines)) {
      const line = raw.lines[i]
      // version 3 splits hyphen runs into words: scored per white-space word (lib.js toSpaceWords)
      const w = line && a.text === line.text ? L.toSpaceWords(line.text, a.words) : null
      if (w) truth[i] = w
    }
    songs.push({ name: key.slice('aligned|'.length), source: 'cache:' + (raw.source || ''), raw: raw.lines.map((l) => ({ t: l.t, end: l.end, text: l.text })), truth })
  }
  return songs
}

function csvRows(file) {
  const [head, ...rows] = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean)
  const cols = head.split(',')
  return rows.map((r) => {
    // the files here have no quoted commas except the lyrics column, which is last in lines/*.csv
    const parts = r.split(',')
    const o = {}
    cols.forEach((c, i) => { o[c] = i === cols.length - 1 ? parts.slice(i).join(',') : parts[i] })
    return o
  })
}

/**
 * JamendoLyrics songs. opts: { mode: 'lrc'|'ends', jitter (s, uniform ±), results (bench.py --out
 * json with exact anchors, for the aligned method), lang (e.g. 'English') }
 */
function fromJamendo(dir, opts = {}) {
  const index = csvRows(path.join(dir, 'JamendoLyrics.csv'))
  let aligned = null
  if (opts.results && fs.existsSync(opts.results)) {
    aligned = new Map()
    const res = JSON.parse(fs.readFileSync(opts.results, 'utf8'))
    for (const r of res.lines || []) {
      if (!aligned.has(r.song)) aligned.set(r.song, {})
      aligned.get(r.song)[r.line] = r
    }
  }
  let seed = 42
  const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648 }
  const songs = []
  for (const row of index) {
    if (opts.lang && row.Language !== opts.lang) continue
    const base = row.Filepath.replace(/\.mp3$/, '')
    const ws = csvRows(path.join(dir, 'annotations', 'words', base + '.csv')).map((r) => ({ t: +r.word_start, end: +r.word_end }))
    const ls = csvRows(path.join(dir, 'annotations', 'lines', base + '.csv')).map((r) => ({ t: +r.start_time, end: +r.end_time, text: r.lyrics_line.replace(/^"|"$/g, '') }))
    const truth = {}
    let k = 0
    ls.forEach((l, i) => {
      const parts = words(l.text)
      truth[i] = parts.map((text, j) => ({ t: ws[k + j] && ws[k + j].t, end: ws[k + j] && ws[k + j].end, text }))
      k += parts.length
    })
    if (k !== ws.length) continue    // annotation mismatch (bench.py skips these too)
    const raw = ls.map((l) => {
      const t = Math.max(0, l.t + (opts.jitter ? (rnd() * 2 - 1) * opts.jitter : 0))
      return opts.mode === 'ends' ? { t, end: Math.max(t + 0.2, l.end), text: l.text } : { t, text: l.text }
    })
    const song = { name: base, source: 'jamendo:' + row.Language, lang: row.Language, raw, truth, mp3: path.join(dir, 'mp3', row.Filepath) }
    if (aligned && aligned.has(row.Filepath)) {
      const a = aligned.get(row.Filepath)
      song.aligned = {}
      for (const [i, r] of Object.entries(a)) {
        // the helper's min_conf (0.2); opts.vocableConf (+ vocableMax words) also keeps short vocable lines
        // from that confidence (lib.js vocableLine: measured, not taken)
        const ok = r.conf >= 0.2 || (opts.vocableConf != null && r.conf >= opts.vocableConf && L.vocableLine(ls[i] && ls[i].text, opts.vocableMax))
        if (!ok || !truth[i] || r.err.length !== truth[i].length) continue
        // bench.py stores aligned − annotated starts, and (since 0.15.34) the aligner's own word ends
        // and holds; older result files have no ends: they follow the next word
        const starts = r.err.map((e, j) => truth[i][j].t + e)
        const ends = Array.isArray(r.ends) && r.ends.length === starts.length ? r.ends : null
        song.aligned[i] = starts.map((t, j) => {
          const w = { t, end: ends && Number.isFinite(ends[j]) && ends[j] > t ? ends[j] : (j + 1 < starts.length ? Math.max(t + 0.05, starts[j + 1]) : t + 0.4), text: truth[i][j].text }
          if (r.held && r.held[j]) w.held = true
          return w
        })
      }
    }
    songs.push(song)
  }
  return songs
}

/**
 * Vocal onsets and voiced runs for a song's audio (the Level 1 detector, vocal-detect.js, on the
 * 22.05 kHz stereo the app captures), cached as JSON in `work`. Needs ffmpeg.
 */
function detectAudio(song, work) {
  const file = path.join(work, 'onsets-' + song.name.replace(/[^\w.-]+/g, '_') + '.json')
  if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'))
  const { createVocalDetector } = require('../../vocal-detect')
  const buf = execFileSync('ffmpeg', ['-v', 'error', '-i', song.mp3, '-f', 'f32le', '-ac', '2', '-ar', '22050', '-'], { maxBuffer: 1 << 30 })
  const pcm = new Float32Array(buf.buffer, buf.byteOffset, buf.length / 4)
  const d = createVocalDetector({ sampleRate: 22050, channels: 2 })
  const onsets = [], voiced = []
  const CH = 441 * 2
  // loop: one pass over the song in 20 ms chunks (like parec) · once per song, then cached
  for (let i = 0; i < pcm.length; i += CH) {
    const r = d.push(pcm.subarray(i, i + CH), i / 2 / 22050)
    if (r) { onsets.push(...r.onsets); voiced.push(...r.voiced) }
  }
  const r = d.flush()
  if (r) { onsets.push(...r.onsets); voiced.push(...r.voiced) }
  const out = { onsets, voiced }
  fs.mkdirSync(work, { recursive: true })
  fs.writeFileSync(file, JSON.stringify(out))
  return out
}

module.exports = { fromCache, fromJamendo, detectAudio, words }
