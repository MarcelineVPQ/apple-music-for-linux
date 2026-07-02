// Audio-reactive spectrum source. Captures the default sink's monitor via
// PulseAudio/PipeWire (parec), runs an FFT, and emits log-spaced band levels.
// This reads the decoded OUTPUT, so it works with DRM audio that the in-page
// Web Audio API is forbidden from analyzing.
const { spawn, execFileSync } = require('child_process')

const RATE = 44100
const N = 2048          // FFT window
const HOP = N / 2       // 50% overlap -> ~43 frames/sec
const BANDS = 48

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
  const f = 35 * Math.pow(17000 / 35, b / BANDS)
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
    this.filled = 0
    this.smooth = new Float64Array(BANDS)
  }

  start() {
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
    this.proc.on('error', (e) => console.error('visualizer capture error:', e.message))
    this.proc.stdout.on('data', (chunk) => this.onData(chunk))
  }

  onData(chunk) {
    this.buf = chunk.length ? Buffer.concat([this.buf, chunk]) : this.buf
    // slide the ring buffer forward by HOP samples each frame
    while (this.buf.length >= HOP * 2) {
      // shift existing samples left by HOP, append HOP new ones
      this.ring.copyWithin(0, HOP)
      for (let i = 0; i < HOP; i++) this.ring[N - HOP + i] = this.buf.readInt16LE(i * 2) / 32768
      this.buf = this.buf.subarray(HOP * 2)
      if (this.filled < N) { this.filled += HOP; if (this.filled < N) continue }
      this.emit()
    }
  }

  emit() {
    const re = new Float64Array(N), im = new Float64Array(N)
    for (let i = 0; i < N; i++) re[i] = this.ring[i] * hann[i]
    fft(re, im)
    const bars = new Array(BANDS)
    for (let b = 0; b < BANDS; b++) {
      let sum = 0, cnt = 0
      for (let k = edges[b]; k < edges[b + 1]; k++) { sum += Math.hypot(re[k], im[k]); cnt++ }
      let v = cnt ? sum / cnt : 0
      v = Math.log10(1 + v * 4) / 2.2               // perceptual compression
      this.smooth[b] = Math.max(v, this.smooth[b] * 0.82)  // attack fast, decay slow
      bars[b] = Math.max(0, Math.min(1, this.smooth[b]))
    }
    this.onBands(bars)
  }

  stop() {
    if (this.proc) { this.proc.kill(); this.proc = null }
    this.buf = Buffer.alloc(0)
    this.filled = 0
    this.smooth.fill(0)
  }
}

module.exports = { Visualizer, BANDS }
