// Audio-reactive spectrum for the visualizer: an FFT over the decoded output, emitted as log-spaced
// band levels (0..1). It reads the output, not the page, so it works with DRM audio that the in-page
// Web Audio API is forbidden from analyzing.
//
// Audio source (main.js): Sonata's OWN stream, the same capture as "Refine timing by listening"
// (audio-listen.js, `parec --monitor-stream`), fed in with push(). Only when our stream can't be
// found (e.g. a pactl without JSON output) does startMonitor() fall back to the default sink's
// monitor, i.e. the whole system mix, as before 0.15.22.
const { spawn, execFileSync } = require('child_process')

const RATE = 22050      // audio-listen.js's rate, so one capture can feed both
const N = 1024          // FFT window: 46 ms at 22.05 kHz (as 2048 at 44.1 kHz before)
const HOP = N / 2       // 50% overlap -> ~43 frames/sec
const BANDS = 48
const LOW = 35
const HIGH = 10500       // just under Nyquist (11025 Hz)
const GAIN = 2048 / N    // keeps band levels where they were with the old 2048-point window

// iterative radix-2 FFT (in place), no dependencies
function fft(re, im) {
  const n = re.length
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1
    for (; j & bit; bit >>= 1) j ^= bit
    j ^= bit
    if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]] }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = -2 * Math.PI / len
    const wr = Math.cos(ang), wi = Math.sin(ang)
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0
      for (let k = 0; k < len / 2; k++) {
        const a = i + k, b = i + k + len / 2
        const tr = re[b] * cr - im[b] * ci
        const ti = re[b] * ci + im[b] * cr
        re[b] = re[a] - tr; im[b] = im[a] - ti
        re[a] += tr; im[a] += ti
        const ncr = cr * wr - ci * wi
        ci = cr * wi + ci * wr; cr = ncr
      }
    }
  }
}

const edges = []
for (let b = 0; b <= BANDS; b++) {
  const f = LOW * Math.pow(HIGH / LOW, b / BANDS)
  edges.push(Math.min(N / 2 - 1, Math.max(1, Math.round(f * N / RATE))))
}
const hann = new Float64Array(N)
for (let i = 0; i < N; i++) hann[i] = 0.5 * (1 - Math.cos(2 * Math.PI * i / (N - 1)))

function defaultMonitor() {
  try {
    const sink = execFileSync('pactl', ['get-default-sink'], { timeout: 2000 }).toString().trim()
    if (sink) return sink + '.monitor'
  } catch (e) { /* fall through */ }
  return '@DEFAULT_MONITOR@'
}

class Visualizer {
  constructor(onBands) {
    this.onBands = onBands
    this.proc = null
    this.buf = Buffer.alloc(0)
    this.ring = new Float64Array(N)
    this.head = 0             // next write position in the circular ring
    this.pending = 0          // new samples since the last frame
    this.filled = 0
    this.smooth = new Float64Array(BANDS)
    // lifetime: reused every frame (no per-frame garbage)
    this.re = new Float64Array(N)
    this.im = new Float64Array(N)
  }

  /** Mono samples (-1..1, RATE Hz), e.g. audio-listen.js's mid channel. */
  push(samples) {
    // loop: one pass over the chunk (~440 samples per 20 ms) · emits a frame per HOP samples
    for (let i = 0; i < samples.length; i++) this.addSample(samples[i])
  }

  addSample(v) {
    this.ring[this.head] = v                 // circular: head is the oldest sample after the write
    this.head = (this.head + 1) % N
    if (this.filled < N) this.filled++
    if (++this.pending >= HOP) {
      this.pending = 0
      if (this.filled >= N) this.emit()
    }
  }

  /** Fallback: capture the default sink's monitor (whole system) with our own parec. */
  startMonitor() {
    if (this.proc) return
    const monitor = defaultMonitor()
    try {
      // --latency-msec keeps parec's buffer tiny so audio arrives continuously
      // (its default buffers ~1s, which makes the spectrum update once a second)
      this.proc = spawn('parec', ['-d', monitor, '--format=s16le', '--rate=' + RATE,
        '--channels=1', '--raw', '--latency-msec=20', '--process-time-msec=10'])
    } catch (e) {
      console.error('visualizer: parec not available:', e.message)
      return
    }
    // error: a missing parec (ENOENT) lands here; the visualizer just shows no spectrum
    this.proc.on('error', (e) => console.error('visualizer capture error:', e.message))
    this.proc.stdout.on('data', (chunk) => this.onData(chunk))
  }

  onData(chunk) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk
    const whole = this.buf.length - (this.buf.length % 2)
    // loop: one pass over the chunk's samples · ends with the chunk
    for (let i = 0; i < whole; i += 2) this.addSample(this.buf.readInt16LE(i) / 32768)
    this.buf = whole < this.buf.length ? Buffer.from(this.buf.subarray(whole)) : Buffer.alloc(0)
  }

  emit() {
    const re = this.re, im = this.im
    for (let i = 0; i < N; i++) { re[i] = this.ring[(this.head + i) % N] * hann[i]; im[i] = 0 }
    fft(re, im)
    const bars = new Array(BANDS)
    for (let b = 0; b < BANDS; b++) {
      let sum = 0, cnt = 0
      for (let k = edges[b]; k < Math.max(edges[b] + 1, edges[b + 1]); k++) { sum += Math.hypot(re[k], im[k]); cnt++ }
      let v = cnt ? GAIN * sum / cnt : 0
      v = Math.log10(1 + v * 4) / 2.2               // perceptual compression
      this.smooth[b] = Math.max(v, this.smooth[b] * 0.82)  // attack fast, decay slow
      bars[b] = Math.max(0, Math.min(1, this.smooth[b]))
    }
    this.onBands(bars)
  }

  /** No audio (paused): forget the window and show silence once. */
  silence() {
    this.ring.fill(0)
    this.filled = this.pending = this.head = 0
    this.smooth.fill(0)
    this.onBands(new Array(BANDS).fill(0))
  }

  // lifetime: stop() kills the fallback parec (if any) and resets buffers; main.js calls it on
  // visualizer 'closed'
  stop() {
    if (this.proc) { this.proc.kill(); this.proc = null }
    this.buf = Buffer.alloc(0)
    this.filled = this.pending = 0
    this.smooth.fill(0)
  }
}

module.exports = { Visualizer, BANDS, RATE }
