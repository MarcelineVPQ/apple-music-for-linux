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
// the fallback parec: when it ends on its own it is restarted after these waits; a run that delivered
// audio for HEALTHY_MS starts the count again. After the last one the visualizer says it has no sound.
const RESTART_MS = [1000, 2000, 4000, 8000, 16000]
const HEALTHY_MS = 30000

// iterative radix-2 FFT (in place), no dependencies
// loop: HOT-PATH-OK — a 1024-point FFT (bit reversal, then log2(n) = 10 butterfly passes), once per
// spectrum frame (~43/s) while the visualizer shows and audio flows; in place, no allocation
function fft(re, im) {
  const n = re.length
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1
    for (; j & bit; bit >>= 1) j ^= bit
    j ^= bit
    if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]] }
  }
  // loop: HOT-PATH-OK — the butterfly passes (n/2 · log2 n = 5,120 per frame), see above
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
// loop: NOT-WORTH — the band edges and the Hann window, once at module load
for (let b = 0; b <= BANDS; b++) {
  const f = LOW * Math.pow(HIGH / LOW, b / BANDS)
  edges.push(Math.min(N / 2 - 1, Math.max(1, Math.round(f * N / RATE))))
}
const hann = new Float64Array(N)
for (let i = 0; i < N; i++) hann[i] = 0.5 * (1 - Math.cos(2 * Math.PI * i / (N - 1)))

// lifetime: OK — execFileSync waits for pactl (2 s timeout) and leaves no process; once per fallback start
function defaultMonitor() {
  try {
    const sink = execFileSync('pactl', ['get-default-sink'], { timeout: 2000 }).toString().trim()
    if (sink) return sink + '.monitor'
  } catch (e) { /* error: NOT-WORTH — no pactl or no default sink: parec's @DEFAULT_MONITOR@ alias is tried instead */ }
  return '@DEFAULT_MONITOR@'
}

class Visualizer {
  // onBands(levels) per spectrum frame. opts (all optional): onState(state) when the fallback capture's
  // state changes ('' = fine, 'restarting', 'lost' = gave up, 'missing' = no parec); spawn, monitor,
  // setTimeout, clearTimeout, now: stand-ins for tests.
  constructor(onBands, opts) {
    const o = opts || {}
    this.onBands = onBands
    this.onState = o.onState || (() => {})
    this.spawn = o.spawn || spawn
    this.monitor = o.monitor || defaultMonitor
    this.setTimeout = o.setTimeout || setTimeout
    this.clearTimeout = o.clearTimeout || clearTimeout
    this.now = o.now || Date.now
    this.proc = null
    this.fallback = false     // on the whole-system monitor (main.js's vizAudioTick leaves the audio to us)
    this.restarts = 0         // restarts since the last healthy run
    this.restartTimer = null
    this.audioState = ''
    this.buf = Buffer.alloc(0)
    this.ring = new Float64Array(N)
    this.head = 0             // next write position in the circular ring
    this.pending = 0          // new samples since the last frame
    this.filled = 0
    this.smooth = new Float64Array(BANDS)
    // lifetime: OK — reused every frame (no per-frame garbage), dropped with the Visualizer
    this.re = new Float64Array(N)
    this.im = new Float64Array(N)
  }

  /** Mono samples (-1..1, RATE Hz), e.g. audio-listen.js's mid channel. */
  push(samples) {
    // loop: HOT-PATH-OK — one pass over the chunk (~440 samples per 20 ms) · emits a frame per HOP samples
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
    this.fallback = true
    if (this.proc || this.restartTimer) return
    this.spawnMonitor()
  }

  spawnMonitor() {
    const monitor = this.monitor()
    let proc
    // lifetime: OK — the fallback parec (whole-system monitor): restarted with a backoff if it ends on its own
    // (monitorEnded), killed by stop() on the visualizer's 'closed'
    // error: SHOWN — spawn throwing (e.g. a dead PATH entry) is logged and handled as a capture that ended:
    // retried with the backoff, then the visualizer says it has no sound
    try {
      // --latency-msec keeps parec's buffer tiny so audio arrives continuously
      // (its default buffers ~1s, which makes the spectrum update once a second)
      proc = this.spawn('parec', ['-d', monitor, '--format=s16le', '--rate=' + RATE,
        '--channels=1', '--raw', '--latency-msec=20', '--process-time-msec=10'])
    } catch (e) {
      console.error('visualizer: parec not available:', e.message)
      this.monitorEnded(true)
      return
    }
    this.proc = proc
    const started = this.now()
    // the capture ended (once per child, whichever of 'error' / 'exit' comes first): show silence, not the
    // last frame frozen, and restart (or say it can't)
    const ended = (canRetry) => {
      if (this.proc !== proc) return       // stopped by us, or already handled
      this.proc = null
      this.buf = Buffer.alloc(0)
      this.silence()
      this.monitorEnded(canRetry)
    }
    // error: SHOWN — a missing parec (ENOENT) ends the capture for good ('missing'); other errors are retried
    // lifetime: OK — 'error', 'exit' and 'data' listeners on the child, gone with it (stop() kills it)
    proc.on('error', (e) => { console.error('visualizer capture error:', e.message); ended(e.code !== 'ENOENT') })
    proc.on('exit', (code, signal) => { console.error('visualizer: the system capture (parec) ended:', signal || code); ended(true) })
    proc.stdout.on('data', (chunk) => {
      if (this.proc !== proc) return
      if (this.restarts && this.now() - started >= HEALTHY_MS) this.restarts = 0
      this.setState('')
      this.onData(chunk)
    })
  }

  // the fallback capture ended on its own: restart it after the next wait, or give up and say so
  monitorEnded(canRetry) {
    if (!this.fallback) return
    if (!canRetry) { this.setState('missing'); return }
    if (this.restarts >= RESTART_MS.length) { console.error('visualizer: the system capture keeps ending; no sound'); this.setState('lost'); return }
    const wait = RESTART_MS[this.restarts++]
    this.setState('restarting')
    // lifetime: OK — one restart timer at a time, cleared by stop(); the backoff ends after RESTART_MS.length tries
    this.restartTimer = this.setTimeout(() => {
      this.restartTimer = null
      if (this.fallback && !this.proc) this.spawnMonitor()
    }, wait)
  }

  setState(state) {
    if (state === this.audioState) return
    this.audioState = state
    this.onState(state)
  }

  onData(chunk) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk
    const whole = this.buf.length - (this.buf.length % 2)
    // loop: HOT-PATH-OK — one pass over the chunk's samples (~440 per 20 ms) · ends with the chunk
    for (let i = 0; i < whole; i += 2) this.addSample(this.buf.readInt16LE(i) / 32768)
    this.buf = whole < this.buf.length ? Buffer.from(this.buf.subarray(whole)) : Buffer.alloc(0)
  }

  emit() {
    const re = this.re, im = this.im
    // loop: HOT-PATH-OK — 1024 window samples, BANDS bands over their FFT bins (512 bins in all), once per spectrum frame (~43/s while it shows); one small bars array per frame
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

  // lifetime: OK — stop() kills the fallback parec (if any), cancels a pending restart and resets buffers;
  // main.js calls it on visualizer 'closed'
  stop() {
    this.fallback = false
    if (this.restartTimer) { this.clearTimeout(this.restartTimer); this.restartTimer = null }
    const proc = this.proc
    this.proc = null
    if (proc) proc.kill()
    this.buf = Buffer.alloc(0)
    this.filled = this.pending = 0
    this.smooth.fill(0)
  }
}

module.exports = { Visualizer, BANDS, RATE, RESTART_MS, HEALTHY_MS }
