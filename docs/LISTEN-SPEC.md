# Refine timing by listening: Level 1 spec

Goal: lyrics with estimated word timing (line-only Apple lyrics, LRCLIB) get closer to the real
singing. Syncopated words start where they are actually sung, and held words ("word draws") stay
lit while the note is held. The result is learned per song and cached, so later plays are tighter.
Opt-in setting, experimental. Benchmark album: Against Me! "White Crosses" (fast, clear vocals,
LRCLIB-only).

## Rules
- Only Sonata's OWN audio stream, never the whole system. Audio is analysed in memory and never
  stored or sent anywhere. It runs only while the lyrics window is open, the song is playing and
  the current lyrics are estimated (Apple word timing is never touched).
- Cheap: one analysis stream (like the visualizer), a target of < 2 % of one core. Verdict
  comments (`// loop:`, `// lifetime:`, `// error:`) on every loop and child process.
- Confidence-gated: no evidence means no change. Never reorder words; never move a word outside
  its line; never shift a word more than MAX_SHIFT (default 0.35 s) from its estimate.
- Pure logic lives in testable modules (node --test, no Electron).

## Modules and interfaces

### `vocal-detect.js` (pure DSP, owner: agent A)
```js
const d = createVocalDetector({ sampleRate })      // e.g. 22050 or 44100, mono s16 or float
d.push(samples /* Float32Array | Int16Array, mono */, t0 /* song time (s) of samples[0] */)
  -> { onsets: [{ t, strength /*0..1*/ }], voiced: [{ start, end, confidence /*0..1*/ }] }
     // events finished within this chunk; voiced segments may be emitted when they close
d.reset()
```
- Onsets: spectral flux in the vocal band (~300–3500 Hz), adaptive threshold, with guitars and
  drums suppressed as far as practical (e.g. harmonic/percussive split, flux restricted to the
  bins with harmonic structure, or a centre-channel emphasis if stereo is available, so the
  detector may accept stereo and use mid = (L+R)/2 minus side energy as a vocal hint).
- Voiced: sustained harmonic energy in the vocal band (held notes).

### `timing-refine.js` (pure, owner: agent A)
```js
refineWords(line /* { t, end, text, words:[{t,end,text}], estimated:true } */,
            evidence /* { onsets, voiced } within [line.t - 0.5, lineEnd + 0.5] */,
            opts?) -> { words: [{ t, end, text }], moved: n, confidence /*0..1*/ }
mergeLearned(prev /* words or null */, next /* words */, plays) -> words  // running average
```
- Word starts snap to the nearest strong onset within ±MAX_SHIFT, keeping order and minimum
  word lengths.
- A voiced segment that continues past a word's end, with no onset, stretches that word; the
  following words shift right (bounded by the line's end and the next line's start).

### `audio-listen.js` (owner: agent B)
```js
const l = createListener({ appPid?, sinkInputName?, sampleRate: 22050, onChunk(samples, wallMs) })
l.start(); l.stop()
```
- Finds Sonata's own sink input (`pactl -f json list sink-inputs`: match the Electron/Chromium
  stream whose `application.process.id` is this app's renderer/utility process, or whose
  application name matches), then `parec --monitor-stream=<index> --format=s16le
  --channels=2 --rate=22050 --latency-msec=20`. Re-finds the stream when it changes (track change
  can recreate it). Falls back to "unavailable" quietly, with a log line.
- wallMs = performance/Date time when the chunk arrived. Main converts it to song time using the
  lyrics clock (the last playbackTime push plus elapsed), minus a measured or estimated monitor
  latency constant.

### Wiring (owner: agent B)
- Setting `lyricsListenRefine` (default false): "Refine timing by listening (experimental)" with
  the description "Listens to Sonata's own audio while the lyrics window is open to move estimated
  words to where they're sung. Audio is analysed in memory, never saved or sent."
- main.js: when on, the lyrics window is open, the song is playing and the lines are estimated,
  run the listener, feed the detector, and per line (once its time has passed) call refineWords
  and send `lyrics-refined` { key, lineIndex, words } to the window. Store learned words per song
  in the lyrics store under key `refined|isrc:<ISRC>` (`refined|title|artist` without an ISRC; 0.15.42) (version 1), merged across plays with
  mergeLearned. On the next play, apply learned words before rendering.
- lyrics.html: accept `lyrics-refined` (replace that line's word timings live, no DOM rebuild
  beyond that line); the notes line says "Word timing estimated, refined by listening" when any
  learned/refined data is in use.

## Test bench (owner: agent A)
No real songs can be used (DRM). Build a synthetic bench: a Python/numpy (or JS) generator of
"sung" syllables with known start times and held notes (harmonic tones with vowel-like formants,
syncopated placements, some long holds), mixed with a drum loop and a distorted-guitar-like
noise bed at several SNRs (+6, 0, −6 dB), stereo with vocals centred. Feed the result through
vocal-detect + timing-refine starting from the plain estimate. Report the mean/median absolute
word-start error, estimate vs refined, per SNR, plus hold detection accuracy. Commit the bench
under tools/listen-bench/ and the results in docs/LISTEN-RESULTS.md.
