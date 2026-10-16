// Synthetic "songs" for the listen bench: sung syllables (harmonic tones with vowel formants,
// consonant bursts, attack/decay, vibrato on holds) at KNOWN times, over a drum loop, a
// distorted power-chord guitar bed (double-tracked L/R, or one centred track) and a bass.
// Deterministic per seed. No real audio is used (DRM), see docs/LISTEN-SPEC.md.

const { syllables } = require('../../lyrics-timing')

function rng(seed) {
  // mulberry32
  let a = seed >>> 0
  return function () {
    a = (a + 0x6D2B79F5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const LEXICON = (
  'I you we they me my the a in on to of and but so now we\'re don\'t can\'t won\'t ' +
  'all night light right wrong long gone home road cold heart fire burn turn time line ' +
  'cross white stand hand fall call wall run sun gun down town ground sound free me ' +
  'never ever only always nothing something city river over under falling running ' +
  'tonight forever believe remember together alone again away inside outside ' +
  'yesterday tomorrow everything everyone nobody somebody revolution'
).split(/\s+/)

const VOWELS = [
  [730, 1090, 2440], [270, 2290, 3010], [300, 870, 2240], [530, 1840, 2480], [570, 840, 2410], [640, 1190, 2390]
]

/**
 * Plan a song: lines of words with known syllable/word times.
 * Returns { sr, dur, bpm, lines: [{ lrcT, words: [{ text, t, end, held, syl: [{t,end,f0,vowel,consonant}] }] }] }
 */
function planSong(seed, opts = {}) {
  const R = rng(seed)
  const pick = (arr) => arr[Math.floor(R() * arr.length)]
  const bpm = opts.bpm || 130 + Math.floor(R() * 45)
  const beat = 60 / bpm, eighth = beat / 2, six = beat / 4
  const nLines = opts.lines || 14
  const scale = [0, 2, 4, 5, 7, 9, 11, 12]
  const tonic = 180 + R() * 60
  let t = 4 * 4 * beat             // four bars of intro
  const lines = []
  for (let li = 0; li < nLines; li++) {
    if (li === Math.floor(nLines / 2)) t += 4 * 4 * beat   // a four-bar instrumental break
    const nWords = 4 + Math.floor(R() * 6)
    const words = []
    const midHold = R() < 0.2 ? 1 + Math.floor(R() * (nWords - 2)) : -1
    const endHold = R() < 0.4
    for (let wi = 0; wi < nWords; wi++) {
      const text = pick(LEXICON)
      const ns = syllables(text)
      // syncopation: start a sixteenth early or late
      let start = t
      if (wi > 0 && R() < 0.25) start += (R() < 0.5 ? -1 : 1) * six
      if (wi > 0 && words.length) start = Math.max(start, words[words.length - 1].end + 0.03)
      const held = wi === midHold || (wi === nWords - 1 && endHold)
      const syl = []
      let st = start
      for (let si = 0; si < ns; si++) {
        const r = R()
        let len = r < 0.15 ? six : r < 0.35 ? 2 * eighth : eighth     // some fast sixteenths, some quarters
        if (held && si === ns - 1) len = eighth * (3 + Math.floor(R() * 6))
        const deg = scale[Math.floor(R() * scale.length)]
        syl.push({
          t: st, end: st + len - 0.02,
          f0: tonic * Math.pow(2, deg / 12),
          vowel: Math.floor(R() * VOWELS.length),
          consonant: R() < 0.6,
          legato: si > 0 && R() < 0.5
        })
        st += len
      }
      const end = syl[syl.length - 1].end
      words.push({ text, t: start, end, held, syl })
      // word gap / rest
      t = st + (R() < 0.15 ? eighth : 0)
    }
    const first = words[0].t
    lines.push({ lrcT: Math.max(0, first + (-0.15 + R() * 0.2)), words })
    t += eighth * (2 + Math.floor(R() * 6))   // gap before next line
  }
  return { bpm, dur: t + 2, lines }
}

// one-pole low-pass in place
function lowpass(x, sr, fc) {
  const a = Math.exp(-2 * Math.PI * fc / sr)
  let y = 0
  for (let i = 0; i < x.length; i++) { y = (1 - a) * x[i] + a * y; x[i] = y }
  return x
}

function renderVocal(plan, sr, R) {
  const n = Math.ceil(plan.dur * sr)
  const v = new Float32Array(n)
  for (const line of plan.lines) {
    for (const w of line.words) {
      for (const s of w.syl) {
        const F = VOWELS[s.vowel]
        const i0 = Math.floor(s.t * sr), i1 = Math.min(n, Math.floor(s.end * sr))
        const dur = s.end - s.t
        // consonant: 30 ms band-ish noise burst at the syllable start
        const cons = s.consonant ? Math.floor(0.03 * sr) : 0
        let hp = 0, prev = 0
        for (let i = 0; i < cons && i0 + i < n; i++) {
          const x = R() * 2 - 1
          hp = 0.7 * (hp + x - prev); prev = x
          v[i0 + i] += 0.15 * hp * Math.sin(Math.PI * i / cons)
        }
        const vs = i0 + Math.floor(cons * 0.6)
        const H = Math.min(30, Math.floor(5000 / s.f0))
        const amps = new Float64Array(H + 1)
        for (let h = 1; h <= H; h++) {
          let g = 0
          for (let k = 0; k < 3; k++) { const bw = 90 + 30 * k; const d = (h * s.f0 - F[k]) / bw; g += (k === 0 ? 1 : k === 1 ? 0.7 : 0.35) / (1 + d * d) }
          amps[h] = (0.15 + g) / Math.sqrt(h)
        }
        let phase = 0
        const att = s.legato ? 0.03 : 0.02, rel = 0.05
        for (let i = vs; i < i1; i++) {
          const tt = (i - i0) / sr
          const vib = 1 + 0.017 * Math.min(1, Math.max(0, (tt - 0.25) / 0.4)) * Math.sin(2 * Math.PI * 5.5 * tt)  // vibrato fades in on long notes
          phase += 2 * Math.PI * s.f0 * vib / sr
          let env = Math.min(1, (i - vs) / sr / att) * Math.min(1, (s.end - i / sr) / rel)
          env *= 1 - 0.25 * Math.min(1, tt / Math.max(0.3, dur))  // slight decay over the note
          let x = 0
          for (let h = 1; h <= H; h++) x += amps[h] * Math.sin(h * phase)
          v[i] += 0.12 * env * x
        }
      }
    }
  }
  return v
}

function renderBacking(plan, sr, R, mode) {
  const n = Math.ceil(plan.dur * sr)
  const L = new Float32Array(n), Rt = new Float32Array(n)
  const beat = 60 / plan.bpm, eighth = beat / 2
  // drums
  for (let b = 0; b * beat < plan.dur; b++) {
    const t = b * beat, bar = b % 4
    const i0 = Math.floor(t * sr)
    if (bar === 0 || bar === 2 || R() < 0.15) {   // kick
      let ph = 0
      for (let i = 0; i < 0.25 * sr && i0 + i < n; i++) {
        const tt = i / sr
        ph += 2 * Math.PI * (45 + 105 * Math.exp(-tt / 0.03)) / sr
        const x = 0.9 * Math.sin(ph) * Math.exp(-tt / 0.09) + (i < 40 ? 0.3 * (R() * 2 - 1) : 0)
        L[i0 + i] += x; Rt[i0 + i] += x
      }
    }
    if (bar === 1 || bar === 3) {                  // snare, centred
      let lp = 0
      for (let i = 0; i < 0.25 * sr && i0 + i < n; i++) {
        const tt = i / sr
        const noise = R() * 2 - 1
        lp = 0.6 * lp + 0.4 * noise
        const x = 0.5 * (noise - lp) * Math.exp(-tt / 0.07) + 0.4 * Math.sin(2 * Math.PI * 190 * tt) * Math.exp(-tt / 0.05)
        L[i0 + i] += x; Rt[i0 + i] += x
      }
    }
    for (let e = 0; e < 2; e++) {                  // hi-hats on eighths, a little right
      const j0 = Math.floor((t + e * eighth) * sr)
      let prev = 0
      for (let i = 0; i < 0.05 * sr && j0 + i < n; i++) {
        const x0 = R() * 2 - 1
        const x = 0.18 * (x0 - prev) * Math.exp(-i / sr / 0.015); prev = x0
        L[j0 + i] += 0.7 * x; Rt[j0 + i] += 1.0 * x
      }
    }
  }
  // guitars: power chords, saw -> tanh drive -> low-pass; chugs or sustained per bar
  const prog = [82.4, 65.4, 98.0, 73.4]
  const bars = Math.ceil(plan.dur / (4 * beat))
  const barPlan = []
  for (let bar = 0; bar < bars; bar++) barPlan.push({ root: prog[bar % 4] * (R() < 0.3 ? 2 : 1), chug: R() < 0.5 })
  const tracks = mode === 'mono' ? 1 : 2
  for (let tr = 0; tr < tracks; tr++) {
    const g = new Float32Array(n)
    const detune = 1 + (tr ? 0.004 : -0.003)
    for (let bar = 0; bar < bars; bar++) {
      const bp = barPlan[bar]
      const freqs = [bp.root, bp.root * 1.5, bp.root * 2].map((f) => f * detune)
      const hits = bp.chug ? 8 : 1
      for (let h = 0; h < hits; h++) {
        const ts = bar * 4 * beat + h * (bp.chug ? eighth : 0) + (R() - 0.5) * 0.016
        const len = bp.chug ? eighth * 0.85 : 4 * beat * 0.98
        const i0 = Math.max(0, Math.floor(ts * sr)), i1 = Math.min(n, Math.floor((ts + len) * sr))
        const ph = freqs.map(() => R())
        for (let i = i0; i < i1; i++) {
          const tt = (i - i0) / sr
          let x = 0
          for (let k = 0; k < 3; k++) { ph[k] += freqs[k] / sr; ph[k] -= Math.floor(ph[k]); x += 2 * ph[k] - 1 }
          x += 0.15 * (R() * 2 - 1)           // pick/string noise
          const env = Math.min(1, tt / 0.005) * (bp.chug ? Math.exp(-tt / 0.12) : Math.exp(-tt / 1.5))
          g[i] += Math.tanh(6 * x * env) * 0.35
        }
      }
    }
    lowpass(g, sr, 3800); lowpass(g, sr, 5000)
    if (tracks === 1) { for (let i = 0; i < n; i++) { L[i] += g[i]; Rt[i] += g[i] } }
    else if (tr === 0) { for (let i = 0; i < n; i++) { L[i] += g[i]; Rt[i] += 0.15 * g[i] } }
    else { for (let i = 0; i < n; i++) { Rt[i] += g[i]; L[i] += 0.15 * g[i] } }
  }
  // bass, centred: root an octave down, eighths
  for (let e = 0; e * eighth < plan.dur; e++) {
    const bar = Math.floor(e / 8)
    const f = (barPlan[bar] ? barPlan[bar].root : 82.4) / 2
    const i0 = Math.floor(e * eighth * sr), i1 = Math.min(n, Math.floor((e + 0.9) * eighth * sr))
    for (let i = i0; i < i1; i++) {
      const tt = (i - i0) / sr
      const x = 0.35 * (Math.sin(2 * Math.PI * f * tt) + 0.3 * Math.sin(4 * Math.PI * f * tt)) * Math.exp(-tt / 0.4)
      L[i] += x; Rt[i] += x
    }
  }
  return { L, R: Rt }
}

// Light, slightly decorrelated reverb on the vocal (combs), so it isn't bone-dry centre.
function reverb(v, sr, R) {
  const outL = Float32Array.from(v), outR = Float32Array.from(v)
  const combs = [[0.0297, 0.0371], [0.0411, 0.0437], [0.0533, 0.0491]]
  for (const [dl, dr] of combs) {
    for (const [d, out] of [[dl, outL], [dr, outR]]) {
      const D = Math.floor(d * sr)
      const buf = new Float32Array(v.length)
      for (let i = 0; i < v.length; i++) { buf[i] = v[i] + (i >= D ? 0.6 * buf[i - D] : 0) }
      for (let i = 0; i < v.length; i++) out[i] += 0.07 * buf[i]
    }
  }
  return { L: outL, R: outR }
}

function rms(x, mask) {
  let s = 0, c = 0
  for (let i = 0; i < x.length; i++) if (!mask || mask[i]) { s += x[i] * x[i]; c++ }
  return Math.sqrt(s / Math.max(1, c))
}

/**
 * Render a planned song at `snrDb` (vocal RMS while singing vs backing RMS over the same time).
 * mode 'stereo' = double-tracked guitars panned L/R; 'mono' = one centred guitar (worst case).
 * Returns { sr, pcm: Int16Array interleaved L,R, plan }.
 */
function renderSong(plan, { sr = 22050, snrDb = 0, mode = 'stereo', seed = 1 } = {}) {
  const R = rng(seed * 7919 + 13)
  const voc = renderVocal(plan, sr, R)
  const back = renderBacking(plan, sr, R, mode)
  const mask = new Uint8Array(voc.length)
  for (const line of plan.lines) for (const w of line.words) {
    for (let i = Math.floor(w.t * sr); i < Math.min(voc.length, w.end * sr); i++) mask[i] = 1
  }
  const vr = rms(voc, mask)
  const br = (rms(back.L, mask) + rms(back.R, mask)) / 2
  const gain = (br / vr) * Math.pow(10, snrDb / 20)
  const vv = reverb(voc.map((x) => x * gain), sr, R)
  const n = voc.length
  let peak = 0
  const L = new Float32Array(n), Rr = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    L[i] = vv.L[i] + back.L[i]; Rr[i] = vv.R[i] + back.R[i]
    peak = Math.max(peak, Math.abs(L[i]), Math.abs(Rr[i]))
  }
  const k = 0.9 / peak
  const pcm = new Int16Array(2 * n)
  for (let i = 0; i < n; i++) { pcm[2 * i] = Math.round(L[i] * k * 32767); pcm[2 * i + 1] = Math.round(Rr[i] * k * 32767) }
  return { sr, pcm, plan }
}

module.exports = { planSong, renderSong, rng }
