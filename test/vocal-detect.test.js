const test = require('node:test')
const assert = require('node:assert/strict')
const { createVocalDetector, makeFft } = require('../vocal-detect')

const SR = 22050

// Deterministic noise
function rng(seed) {
  let a = seed >>> 0
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = Math.imul(a ^ (a >>> 15), a | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296 }
}

// A "sung" note: harmonics of f0 with a vowel-ish tilt, 20 ms attack, 50 ms release.
function addNote(buf, start, end, f0, amp = 0.2, sr = SR) {
  const i0 = Math.floor(start * sr), i1 = Math.min(buf.length, Math.floor(end * sr))
  for (let i = i0; i < i1; i++) {
    const t = (i - i0) / sr
    const env = Math.min(1, t / 0.02) * Math.min(1, (end - i / sr) / 0.05)
    let x = 0
    for (let h = 1; h * f0 < 4000; h++) x += Math.sin(2 * Math.PI * h * f0 * t) / h * (h * f0 > 500 && h * f0 < 1200 ? 2 : 1)
    buf[i] += amp * env * x
  }
}

function run(mono, { stereo = null, chunk = 441 } = {}) {
  const d = createVocalDetector({ sampleRate: SR, channels: stereo ? 2 : 1 })
  const data = stereo || mono
  const step = chunk * (stereo ? 2 : 1)
  const onsets = [], voiced = []
  for (let i = 0; i < data.length; i += step) {
    const r = d.push(data.subarray(i, i + step), i / (stereo ? 2 : 1) / SR)
    onsets.push(...r.onsets); voiced.push(...r.voiced)
  }
  const r = d.flush(); onsets.push(...r.onsets); voiced.push(...r.voiced)
  return { onsets, voiced }
}

test('fft: a cosine lands in its bin', () => {
  const n = 64, fft = makeFft(n)
  const re = new Float64Array(n), im = new Float64Array(n)
  for (let i = 0; i < n; i++) re[i] = Math.cos(2 * Math.PI * 5 * i / n)
  fft(re, im)
  assert.ok(Math.abs(re[5] - n / 2) < 1e-9 && Math.abs(re[n - 5] - n / 2) < 1e-9)
  for (let k = 0; k < n; k++) if (k !== 5 && k !== n - 5) assert.ok(Math.hypot(re[k], im[k]) < 1e-9)
  assert.throws(() => makeFft(48))
})

test('clean notes: one strong onset per note, within 30 ms', () => {
  const buf = new Float32Array(SR * 4)
  const starts = [0.5, 0.8, 1.25, 1.5, 2.1, 2.45, 3.0]
  const pitches = [220, 262, 196, 247, 294, 220, 262]
  starts.forEach((s, i) => addNote(buf, s, (starts[i + 1] || 3.6) - 0.03, pitches[i]))
  const { onsets } = run(buf)
  const strong = onsets.filter((o) => o.strength >= 0.5)
  assert.equal(strong.length, starts.length)
  strong.forEach((o, i) => assert.ok(Math.abs(o.t - starts[i]) < 0.03, `onset ${o.t} vs ${starts[i]}`))
  for (const o of onsets) assert.ok(o.strength >= 0 && o.strength <= 1)
})

test('44.1 kHz input works the same (window and hop scale with the rate)', () => {
  const sr = 44100
  const buf = new Float32Array(sr * 3)
  const starts = [0.5, 1.1, 1.9]
  starts.forEach((s, i) => addNote(buf, s, s + 0.5, [220, 262, 196][i], 0.2, sr))
  const d = createVocalDetector({ sampleRate: sr })
  assert.equal(d.frameSize, 2048)
  const onsets = []
  for (let i = 0; i < buf.length; i += 882) onsets.push(...d.push(buf.subarray(i, i + 882), i / sr).onsets)
  const strong = onsets.filter((o) => o.strength >= 0.5)
  assert.equal(strong.length, 3)
  strong.forEach((o, i) => assert.ok(Math.abs(o.t - starts[i]) < 0.03))
})

test('noise only: no strong onsets, no voiced segments', () => {
  const R = rng(3)
  const buf = new Float32Array(SR * 4)
  for (let i = 0; i < buf.length; i++) buf[i] = 0.3 * (R() * 2 - 1)
  const { onsets, voiced } = run(buf)
  assert.equal(onsets.filter((o) => o.strength >= 0.5).length, 0)
  assert.equal(voiced.length, 0)
})

test('click-like hits (10 ms noise bursts) give no strong onsets', () => {
  const R = rng(5)
  const buf = new Float32Array(SR * 4)
  for (let b = 0.25; b < 3.8; b += 0.25) {
    const i0 = Math.floor(b * SR)
    for (let i = 0; i < 0.2 * SR; i++) buf[i0 + i] += 0.6 * (R() * 2 - 1) * Math.exp(-i / SR / 0.01)
  }
  const { onsets } = run(buf)
  assert.equal(onsets.filter((o) => o.strength >= 0.5).length, 0, JSON.stringify(onsets))
})

test('a held note is one voiced segment covering it', () => {
  const buf = new Float32Array(SR * 5)
  addNote(buf, 0.5, 0.8, 262)
  addNote(buf, 1.0, 3.2, 220)   // held 2.2 s
  const { voiced } = run(buf)
  const held = voiced.find((v) => v.start < 1.15 && v.end > 3.0)
  assert.ok(held, JSON.stringify(voiced))
  assert.ok(held.end < 3.35 && held.confidence > 0.3)
  assert.ok(!voiced.some((v) => v.start > 3.3))
})

test('stereo: a centred voice is found, wide (side-only) notes are suppressed', () => {
  const voice = new Float32Array(SR * 4), wide = new Float32Array(SR * 4)
  addNote(voice, 0.6, 1.0, 262); addNote(voice, 2.2, 2.6, 294)
  addNote(wide, 1.4, 1.8, 330, 0.4); addNote(wide, 3.0, 3.4, 247, 0.4)
  const pcm = new Float32Array(2 * voice.length)
  for (let i = 0; i < voice.length; i++) { pcm[2 * i] = voice[i] + wide[i]; pcm[2 * i + 1] = voice[i] - wide[i] }
  const strong = run(null, { stereo: pcm }).onsets.filter((o) => o.strength >= 0.5).map((o) => o.t)
  assert.equal(strong.length, 2, JSON.stringify(strong))
  assert.ok(Math.abs(strong[0] - 0.6) < 0.03 && Math.abs(strong[1] - 2.2) < 0.03)
})

test('Int16 input and chunk size give the same events as Float32', () => {
  const buf = new Float32Array(SR * 3)
  addNote(buf, 0.5, 1.2, 220); addNote(buf, 1.4, 2.5, 262)
  const i16 = Int16Array.from(buf, (x) => Math.round(x * 32767))
  const a = run(buf, { chunk: 441 }), b = run(i16, { chunk: 1000 })
  assert.equal(a.onsets.length, b.onsets.length)
  a.onsets.forEach((o, i) => assert.ok(Math.abs(o.t - b.onsets[i].t) < 1e-6))
  assert.equal(a.voiced.length, b.voiced.length)
})

test('a seek (time jump) restarts the analysis; times follow t0', () => {
  const d = createVocalDetector({ sampleRate: SR })
  const buf = new Float32Array(SR * 2)
  addNote(buf, 0.5, 1.5, 220)
  const events = []
  for (let i = 0; i < buf.length; i += 441) events.push(...d.push(buf.subarray(i, i + 441), 60 + i / SR).onsets)
  assert.ok(events.some((o) => Math.abs(o.t - 60.5) < 0.03))
  // jump back to 10 s: no stale events, new ones at the new times
  const after = []
  for (let i = 0; i < buf.length; i += 441) after.push(...d.push(buf.subarray(i, i + 441), 10 + i / SR).onsets)
  assert.ok(after.every((o) => o.t < 60))
  assert.ok(after.some((o) => Math.abs(o.t - 10.5) < 0.03))
  d.reset()
  assert.deepEqual(d.flush(), { onsets: [], voiced: [] })
})

test('non-finite samples are treated as silence', () => {
  const d = createVocalDetector({ sampleRate: SR })
  const buf = new Float32Array(SR).fill(NaN)
  const r = d.push(buf, 0)
  assert.deepEqual(r, { onsets: [], voiced: [] })
})
