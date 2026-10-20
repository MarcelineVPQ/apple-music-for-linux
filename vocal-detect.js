// Vocal onset and held-note detection for "Refine timing by listening" (docs/LISTEN-SPEC.md).
// Pure streaming DSP, no dependencies, no Electron: push audio chunks in, get events out.
//
// Per hop (~11.6 ms) one complex FFT (~46 ms Hann window) carries both mid (L+R)/2 in its real
// part and side (L-R)/2 in its imaginary part, so stereo costs the same as mono. In the vocal
// band (300–3500 Hz) the "centre" spectrum is |mid| − β·|side|: a centred vocal keeps all of it,
// wide double-tracked guitars and stereo cymbals cancel most of theirs.
//
// - Onsets: SuperFlux-style flux of the log centre spectrum, but against the minimum of the next
//   ~80 ms ("persistent" flux): a sung syllable's partials stay, a drum hit's noise decays, so
//   drums count far less; bins that fall > ~13 dB after their peak inside that span are hits and
//   don't count at all. Peaks above an adaptive threshold (median + k·MAD, floored) are onsets;
//   strength 0…1 grows with how far above it they are.
// - Voiced: frames whose centre band is tonal (persistent spectral peaks carry most of the
//   energy), loud against a slow running floor and within voicedDrop dB of the recent peak (so a
//   note's reverb tail isn't voice); joined into segments with hysteresis.
// Onset times lag the true attack by ~0–15 ms (more at low SNR); voiced segment ends by ~30 ms.
// Cost: ~4.5 ms of CPU per second of 22.05 kHz stereo audio (≈ 0.45 % of one core, bench).
//
// loop: none (the caller pushes chunks; work is proportional to the audio pushed)
// lifetime: fixed-size buffers (one FFT frame, a few frames of band history, ~1.5 s of flux and
// ~4 s of level history for the adaptive thresholds); events are handed out on every push and
// not kept. reset() clears everything (seek, track change).
// error: no throws on odd input; non-finite samples are treated as 0.

// Tuning (chosen with tools/listen-bench, see docs/LISTEN-RESULTS.md)
const TUNING = {
  bandLo: 300, bandHi: 3500,   // Hz, vocal band
  frameSec: 0.046,             // analysis window (rounded to a power of two in samples)
  hops: 4,                     // hops per window (hop = frame / 4)
  sideWeight: 2.0,             // β in |mid| − β·|side|
  persist: 7,                  // frames of look-ahead an increase must survive (min filter)
  decayMax: 1.5,               // a bin falling more than this after its peak (log units, ~13 dB)
                               // within the persist frames is a hit (drum, click), not a note
  maxBack: 2,                  // frames of look-back for the reference (max filter, also ±1 bin)
  thrWindowSec: 1.5,           // adaptive threshold history
  thrK: 2.5,                   // threshold = median + thrK · MAD over thrWindowSec
  thrMin: 0.02,                // absolute floor for the flux threshold (log units per bin)
  peakHalf: 3,                 // local-maximum half window, frames
  minGap: 0.08,                // s between onsets
  onsetBias: 0.0,              // s subtracted from onset times (set from the bench)
  tonalRatio: 2.0,             // a spectral peak must exceed the ±4-bin mean by this factor
  voicedTonal: 0.3,            // tonality (peak energy share) needed to start a voiced run
  voicedLevel: 3.0,            // tonal level over the running floor needed (power ratio)
  floorSec: 4,                 // running floor history
  floorPct: 0.2,               // running floor percentile
  voicedGap: 0.06,             // s of unvoiced frames bridged inside a segment
  voicedMin: 0.12,             // s, shortest segment reported
  voicedBias: 0.0,             // s subtracted from voiced segment times
  voicedDrop: 10,              // dB under the recent peak tonal level where voicing ends
  peakDecay: 3                 // dB/s the recent peak falls
}

// ---- radix-2 complex FFT (in place) ----
function makeFft(n) {
  const levels = Math.round(Math.log2(n))
  if (1 << levels !== n) throw new Error('fft size must be a power of two')
  const rev = new Uint32Array(n)
  // loop: NOT-WORTH — the FFT tables (n = 1024), once per detector
  for (let i = 0; i < n; i++) {
    let r = 0
    for (let b = 0; b < levels; b++) r |= ((i >>> b) & 1) << (levels - 1 - b)
    rev[i] = r
  }
  const cos = new Float64Array(n / 2), sin = new Float64Array(n / 2)
  // loop: NOT-WORTH — once per detector
  for (let i = 0; i < n / 2; i++) { cos[i] = Math.cos(2 * Math.PI * i / n); sin[i] = -Math.sin(2 * Math.PI * i / n) }
  return function fft(re, im) {
    // loop: HOT-PATH-OK — bit-reversal permutation, n = 1024 steps, per analysis frame (~86/s while listening)
    for (let i = 0; i < n; i++) {
      const j = rev[i]
      if (j > i) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t }
    }
    // loop: HOT-PATH-OK — log2(n) = 10 butterfly stages, n/2 butterflies each, per analysis frame; no allocation
    for (let size = 2; size <= n; size <<= 1) {
      const half = size >>> 1, step = n / size
      for (let start = 0; start < n; start += size) {
        for (let k = 0, tw = 0; k < half; k++, tw += step) {
          const a = start + k, b = a + half
          const xr = re[b] * cos[tw] - im[b] * sin[tw]
          const xi = re[b] * sin[tw] + im[b] * cos[tw]
          re[b] = re[a] - xr; im[b] = im[a] - xi
          re[a] += xr; im[a] += xi
        }
      }
    }
  }
}

function median(arr, n) {
  // loop: HOT-PATH-OK — about 11 copy-and-sorts per second of ≤ 345 floats while listening (~0.05 ms each)
  const a = Array.prototype.slice.call(arr, 0, n).sort((x, y) => x - y)
  return n ? (n & 1 ? a[n >> 1] : (a[n / 2 - 1] + a[n / 2]) / 2) : 0
}

function createVocalDetector(opts = {}) {
  const P = Object.assign({}, TUNING, opts.tuning || {})
  const sr = opts.sampleRate || 22050
  const channels = opts.channels === 2 ? 2 : 1
  const N = 1 << Math.round(Math.log2(sr * P.frameSec))
  const H = N / P.hops
  const hopSec = H / sr
  const fft = makeFft(N)
  const win = new Float64Array(N)
  // loop: NOT-WORTH — the window table, once per detector
  for (let i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / N)
  const k0 = Math.max(1, Math.floor(P.bandLo * N / sr)), k1 = Math.min(N / 2 - 1, Math.ceil(P.bandHi * N / sr))
  const B = k1 - k0 + 1
  const re = new Float64Array(N), im = new Float64Array(N)
  const midBuf = new Float32Array(N), sideBuf = new Float32Array(N)
  const HIST = P.persist + P.maxBack + 1          // log-spectrum frames kept for persistent flux
  const ylog = Array.from({ length: HIST }, () => new Float32Array(B))   // log centre magnitude
  const cmag = Array.from({ length: 3 }, () => new Float32Array(B))   // centre magnitudes, 3 frames
  const cmin = new Float32Array(B)
  const thrLen = Math.round(P.thrWindowSec / hopSec)
  const fluxHist = new Float32Array(thrLen)
  const floorLen = Math.round(P.floorSec / hopSec)
  const levelHist = new Float32Array(floorLen)
  const devScratch = new Float32Array(thrLen)

  let fill, frameNo, nextT, refLevel, fluxN, fluxPos, levelN, levelPos
  let cand, lastOnset, voicedRun, onsetsOut, voicedOut, thrNow, floorNow, peakNow
  const peakFall = Math.pow(10, -P.peakDecay * hopSec / 10), dropFactor = Math.pow(10, -P.voicedDrop / 10)
  function reset() {
    fill = 0; frameNo = 0; nextT = null; refLevel = 0; thrNow = P.thrMin; floorNow = 0; peakNow = 0
    fluxN = 0; fluxPos = 0; levelN = 0; levelPos = 0
    cand = []; lastOnset = -Infinity; voicedRun = null
    onsetsOut = []; voicedOut = []
    // loop: NOT-WORTH — ~10 + 3 small arrays, per reset (song start or seek)
    for (const y of ylog) y.fill(0)
    for (const c of cmag) c.fill(0)
  }
  reset()

  // Frame f's centre time (s) is kept with its values; frames are processed in order.
  const frameTimes = new Float64Array(HIST + 4)
  function frameTime(f) { return frameTimes[f % frameTimes.length] }

  function processFrame(tCentre) {
    // loop: HOT-PATH-OK — N = 1024 samples windowed, per analysis frame (~86/s while listening), no allocation
    for (let i = 0; i < N; i++) { re[i] = midBuf[i] * win[i]; im[i] = channels === 2 ? sideBuf[i] * win[i] : 0 }
    fft(re, im)
    const f = frameNo++
    frameTimes[f % frameTimes.length] = tCentre
    const y = ylog[f % HIST]
    const c = cmag[f % 3]
    let sum = 0
    // loop: HOT-PATH-OK — vocal-band bins (~150 at 22050 Hz), per analysis frame
    for (let b = 0; b < B; b++) {
      const k = k0 + b
      let mag
      if (channels === 2) {
        // X = FFT(mid + i·side): MID[k] = (X[k] + conj X[N−k]) / 2, SIDE[k] = (X[k] − conj X[N−k]) / 2i
        const ar = re[k], ai = im[k], br = re[N - k], bi = -im[N - k]
        const mr = (ar + br) / 2, mi = (ai + bi) / 2
        const sr2 = (ai - bi) / 2, si = -(ar - br) / 2
        mag = Math.max(0, Math.hypot(mr, mi) - P.sideWeight * Math.hypot(sr2, si))
      } else {
        mag = Math.hypot(re[k], im[k])
      }
      c[b] = mag
      sum += mag
    }
    // level reference: slow EMA of the mean band magnitude, so the log scale is level-invariant
    const mean = sum / B
    refLevel = refLevel ? refLevel * 0.995 + mean * 0.005 : mean
    const ref = refLevel + 1e-9
    // loop: HOT-PATH-OK — the band bins (~150), per analysis frame
    for (let b = 0; b < B; b++) y[b] = Math.log1p(10 * c[b] / ref)

    if (f >= HIST - 1) onsetStep(f - P.persist)
    if (f >= 2) voicedStep(f - 1)
  }

  // Persistent flux of frame g (needs frames g−maxBack … g+persist).
  // Persistent increase of bin b in a log-spectrum history: min of the next frames minus the
  // max of the previous frames (±1 bin), 0 if it fell.
  function rise(hist, g, b) {
    let lo = Infinity, top = 0, fall = 0
    // loop: HOT-PATH-OK — persist (7) then maxBack (2) frames, per bin per analysis frame (~1,350 steps/frame)
    for (let p = 0; p <= P.persist; p++) {
      const v = hist[(g + p) % HIST][b]
      if (v < lo) lo = v
      if (v > top) top = v
      else if (top - v > fall) fall = top - v
    }
    if (fall > P.decayMax) return 0                  // falls fast after its peak: a hit, not a note
    let hi = 0
    // loop: HOT-PATH-OK — maxBack (2) frames, as above
    for (let p = 1; p <= P.maxBack; p++) {
      const yy = hist[(g - p) % HIST]
      const v = Math.max(yy[b], b > 0 ? yy[b - 1] : 0, b < B - 1 ? yy[b + 1] : 0)
      if (v > hi) hi = v
    }
    return lo > hi ? lo - hi : 0
  }

  function onsetStep(g) {
    let flux = 0
    // loop: HOT-PATH-OK — band bins × (persist + maxBack) frames
    for (let b = 0; b < B; b++) flux += rise(ylog, g, b)
    flux /= B
    // adaptive threshold from the past window (median + K·MAD), refreshed every 4 frames.
    // Persistent flux is sparse (mostly 0), so in practice thrMin rules except in dense passages.
    const n = fluxN
    if (n < 8) thrNow = P.thrMin
    else if (g % 4 === 0) {
      const med = median(fluxHist, n)
      // loop: HOT-PATH-OK — the threshold window (~130 values), every 4th frame; median() copies and sorts
      // ~130 numbers twice there (~20 small sorts/s while listening)
      for (let i = 0; i < n; i++) devScratch[i] = Math.abs(fluxHist[i] - med)
      const mad = median(devScratch, n)
      thrNow = Math.max(P.thrMin, med + P.thrK * mad)
    }
    const thr = thrNow
    fluxHist[fluxPos] = flux; fluxPos = (fluxPos + 1) % thrLen; if (fluxN < thrLen) fluxN++
    cand.push({ t: frameTime(g), flux, thr })
    // peak picking once peakHalf frames of look-ahead exist
    // loop: HOT-PATH-OK — drains cand down to 2·peakHalf+1 entries; at most a few per frame, each over ≤ 7 candidates
    while (cand.length >= 2 * P.peakHalf + 1) {
      const c = cand[P.peakHalf]
      let isMax = true
      for (let i = 0; i < cand.length && i <= 2 * P.peakHalf; i++) {
        if (i !== P.peakHalf && (cand[i].flux > c.flux || (cand[i].flux === c.flux && i < P.peakHalf))) { isMax = false; break }
      }
      if (isMax && c.flux > c.thr && c.t - lastOnset >= P.minGap) {
        const ratio = c.flux / c.thr
        onsetsOut.push({ t: c.t - P.onsetBias, strength: Math.min(1, 1 - Math.exp(-(ratio - 1) * 1.2)) })
        lastOnset = c.t
      }
      cand.shift()
    }
  }

  // Voicing of frame g (uses frames g−1, g, g+1).
  function voicedStep(g) {
    const a = cmag[(g + 2) % 3], b0 = cmag[g % 3], c2 = cmag[(g + 1) % 3]
    // loop: HOT-PATH-OK — the band bins (~150), per analysis frame
    for (let b = 0; b < B; b++) cmin[b] = Math.min(a[b], b0[b], c2[b])
    let total = 0, tonal = 0
    // loop: HOT-PATH-OK — band bins with a ±4-bin running sum (~150 + 4), per analysis frame
    let win9 = 0
    for (let b = 0; b < Math.min(B, 4); b++) win9 += cmin[b] * cmin[b]
    for (let b = 0; b < B; b++) {
      const e = cmin[b] * cmin[b]
      total += e
      if (b + 4 < B) win9 += cmin[b + 4] * cmin[b + 4]
      if (b - 5 >= 0) win9 -= cmin[b - 5] * cmin[b - 5]
      const cnt = Math.min(B - 1, b + 4) - Math.max(0, b - 4) + 1
      if (b > 0 && b < B - 1 && cmin[b] >= cmin[b - 1] && cmin[b] >= cmin[b + 1] && e > P.tonalRatio * P.tonalRatio * (win9 / cnt)) {
        tonal += e + cmin[b - 1] * cmin[b - 1] + cmin[b + 1] * cmin[b + 1]
      }
    }
    const tonality = total > 0 ? Math.min(1, tonal / total) : 0
    levelHist[levelPos] = tonal; levelPos = (levelPos + 1) % floorLen; if (levelN < floorLen) levelN++
    // running floor (a low percentile of the tonal level), refreshed every 8 frames
    if (levelN < 16) floorNow = 0
    else if (g % 8 === 0) {
      // loop: HOT-PATH-OK — every 8th frame (~11/s while listening): copy + sort of ≤ 345 floats, ~0.05 ms each
      const s = Array.prototype.slice.call(levelHist, 0, levelN).sort((x, y) => x - y)
      floorNow = s[Math.floor(P.floorPct * (levelN - 1))]
    }
    const floor = floorNow
    const ratio = floor > 0 ? tonal / floor : (tonal > 0 ? Infinity : 0)
    // peak follower (decays peakDecay dB/s): a note's reverb tail or the gap after it falls
    // below the phrase level fast, so voicing ends with the note, not with the room
    peakNow = Math.max(tonal, peakNow * peakFall)
    const nearPeak = tonal >= peakNow * dropFactor
    const t = frameTime(g)
    const on = voicedRun
      ? tonality >= P.voicedTonal * 0.7 && ratio >= P.voicedLevel * 0.5 && nearPeak
      : tonality >= P.voicedTonal && ratio >= P.voicedLevel && levelN >= 16 && nearPeak
    if (on) {
      const score = Math.min(1, tonality / (P.voicedTonal * 2)) * Math.min(1, Math.log10(Math.max(1, ratio)) / Math.log10(P.voicedLevel * 4))
      if (!voicedRun) voicedRun = { start: t, last: t, sum: 0, n: 0 }
      voicedRun.last = t; voicedRun.sum += score; voicedRun.n++
    } else if (voicedRun && t - voicedRun.last > P.voicedGap) {
      closeVoiced()
    }
  }

  function closeVoiced() {
    const r = voicedRun
    voicedRun = null
    const start = r.start - hopSec / 2 - P.voicedBias, end = r.last + hopSec / 2 - P.voicedBias
    if (end - start >= P.voicedMin) voicedOut.push({ start, end, confidence: r.n ? r.sum / r.n : 0 })
  }

  function take() {
    const out = { onsets: onsetsOut, voiced: voicedOut }
    onsetsOut = []; voicedOut = []
    return out
  }

  /**
   * Feed samples (Float32Array −1…1 or Int16Array; interleaved L,R when channels: 2) whose first
   * sample plays at song time t0 (s). A jump of more than 0.25 s from the expected time (seek)
   * restarts the analysis. Returns the onsets and closed voiced segments found so far.
   */
  function push(samples, t0) {
    const scale = samples instanceof Int16Array ? 1 / 32768 : 1
    const frames = Math.floor(samples.length / channels)
    if (typeof t0 === 'number' && nextT != null && Math.abs(t0 - nextT) > 0.25) {
      const pending = take()
      reset()
      onsetsOut = pending.onsets; voicedOut = pending.voiced
    }
    let t = typeof t0 === 'number' ? t0 : (nextT != null ? nextT : 0)
    // loop: HOT-PATH-OK — one step per sample frame of the chunk (~440 per chunk); a window is analysed every H samples
    for (let i = 0; i < frames; i++) {
      let m, s = 0
      if (channels === 2) {
        let l = samples[2 * i] * scale, r = samples[2 * i + 1] * scale
        if (!Number.isFinite(l)) l = 0
        if (!Number.isFinite(r)) r = 0
        m = (l + r) / 2; s = (l - r) / 2
      } else {
        m = samples[i] * scale
        if (!Number.isFinite(m)) m = 0
      }
      midBuf[fill] = m; sideBuf[fill] = s; fill++
      if (fill === N) {
        // buffer[0] played at t − (N−1)/sr; the window centre is N/2 samples later
        processFrame(t + (i + 1) / sr - N / sr + N / 2 / sr)
        midBuf.copyWithin(0, H); sideBuf.copyWithin(0, H); fill = N - H
      }
    }
    nextT = t + frames / sr
    return take()
  }

  /** Close an open voiced segment (pause, end of track) and return what is pending. */
  function flush() {
    if (voicedRun) closeVoiced()
    return take()
  }

  return { push, flush, reset: () => { reset() }, frameSize: N, hop: H, sampleRate: sr, channels }
}

module.exports = { createVocalDetector, makeFft, TUNING }
