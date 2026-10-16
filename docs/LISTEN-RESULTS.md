# Refine timing by listening: Level 1 bench results

Spec: [LISTEN-SPEC.md](LISTEN-SPEC.md). Modules: `vocal-detect.js` (streaming DSP) and
`timing-refine.js` (alignment). Bench: `tools/listen-bench/`.

**Short version:** on synthetic rock mixes with LRCLIB-style line stamps, refining cuts the median
word-start error from 264 ms to 130 ms (+6 dB) and 135 ms (0 dB) on the first play, and to about
100 ms by the third play. About 2 % of words get worse by more than 50 ms. At −6 dB the gain is
smaller (264 → 195 ms) but it is still a gain, and the share of words made worse stays at 2.3 %.
When the voice can't be told apart from the band (a centred rhythm guitar), the noise gate leaves
the song exactly as estimated. The detector costs about 4.5 ms of CPU per second of audio
(≈ 0.45 % of one core).

These are synthetic results. Real recordings will differ: see "Limits" before trusting the
numbers.

## The bench

`node tools/listen-bench/bench.js [--songs 8] [--snr 100,6,0,-6] [--modes stereo,mono] [--plays 3] [--md]`
(`tune.js` runs grid searches on the same prepared audio.) Everything is deterministic: seeded,
no network, no real audio.

- **Songs** (`synth.js`): 8 songs, 130–175 bpm, 14 lines each (711 words, 46 min of audio over
  all conditions), a four-bar intro and a four-bar instrumental break.
- **Singing:** every syllable is an additive harmonic tone (f0 180–480 Hz on a major scale, up to
  30 partials to 5 kHz) shaped by one of 6 vowel formant sets, with a 20–30 ms attack, a 50 ms
  release, a slight decay and vibrato that fades in on long notes. 60 % of syllables start with a
  30 ms consonant noise burst. Syllables are eighths, with 15 % sixteenths and 20 % quarters, so
  some are only ~90 ms long. Half the syllables inside a word are legato. Each word has the
  syllable count `lyrics-timing.syllables()` gives it, so the estimate is fed fair text.
- **Syncopation and holds:** 25 % of words start a sixteenth early or late. 15 % of words have a
  rest after them. 40 % of lines end on a held word and 20 % hold a word mid-line, each held for
  3–8 eighths (0.5–1.8 s).
- **Line stamps:** LRCLIB-style, with the first word's start plus a uniform −150…+50 ms error. Only
  line starts are given, as in LRCLIB. Words come from `estimateWords`.
- **Backing:** kick, a centred snare (noise plus 190 Hz body), hi-hats on eighths panned a little
  right. Distorted power chords (three saws → tanh drive → low-pass) alternate between bars of
  palm-muted eighth chugs and sustained chords. The chords are double-tracked: two different
  performances panned hard left and right with 15 % bleed. The bass is centred. The vocal has a
  light, slightly decorrelated comb reverb.
- **SNR:** vocal RMS while singing vs. backing RMS over the same time: +100 (clean reference),
  +6, 0 and −6 dB. **Mono** = one centred guitar track instead of two wide ones, at 0 dB. This is
  the worst case for the centre-channel trick.
- **Pipeline:** s16 stereo in 20 ms chunks, like `parec --latency-msec=20`, → `createVocalDetector`
  → per line `refineWords` with the evidence in [line − 0.5 s, line end + 0.5 s] and
  `nextStart`, plus the song's `noiseRate`. **Plays 2–3** refine again, starting from the learned
  words, and merge with `mergeLearned`. This assumes the wiring applies learned words before
  refining on the next play, as the spec describes.
- **Metrics:** absolute word-start error against the true start. "Better/worse" means a word's
  error shrank or grew by more than 50 ms. **Holds** count as held if the word's last syllable
  lasts 3+ eighths. For the estimate, "held" means an estimated word of at least 0.6 s, which is
  the only proxy it has. For refined words, it means `held: true`.

## Results (final tuning, 8 songs, 711 words per condition)

| Condition | Method | Mean err (ms) | Median (ms) | ≤ 50 ms | ≤ 100 ms |
|---|---|---|---|---|---|
| clean (+100 dB) | estimate | 428 | 264 | 15 % | 28 % |
| | refined, play 1 | 285 | 93 | 44 % | 51 % |
| | refined, play 3 | 236 | 63 | 48 % | 58 % |
| **+6 dB** | estimate | 428 | 264 | 15 % | 28 % |
| | refined, play 1 | **311** | **130** | 38 % | 45 % |
| | refined, play 2 | 285 | 105 | 40 % | 49 % |
| | refined, play 3 | 273 | 97 | 41 % | 51 % |
| **0 dB** | estimate | 428 | 264 | 15 % | 28 % |
| | refined, play 1 | **321** | **135** | 36 % | 44 % |
| | refined, play 2 | 295 | 115 | 37 % | 48 % |
| | refined, play 3 | 283 | 103 | 39 % | 50 % |
| **−6 dB** | estimate | 428 | 264 | 15 % | 28 % |
| | refined, play 1 | **385** | **195** | 25 % | 34 % |
| | refined, play 3 | 374 | 188 | 26 % | 36 % |
| mono guitar, 0 dB | estimate | 428 | 264 | 15 % | 28 % |
| | refined (gated) | 428 | 264 | 15 % | 28 % |

| Condition | Words better / worse by > 50 ms (play 1) | Hold P / R, estimate proxy | Hold P / R, refined | Held-word end error, mean (estimate → refined) |
|---|---|---|---|---|
| clean | 54.6 % / 1.0 % | 15 / 51 % | 50 / 32 % | 555 → 371 ms |
| +6 dB | 45.4 % / 2.0 % | 15 / 51 % | 47 / 31 % | 555 → 404 ms |
| 0 dB | 41.5 % / 1.8 % | 15 / 51 % | 53 / 25 % | 555 → 421 ms |
| −6 dB | 19.5 % / 2.3 % | 15 / 51 % | 42 / 18 % | 555 → 502 ms |
| mono, 0 dB (gated) | 0 % / 0 % | 15 / 51 % | – / 0 % | 555 → 555 ms |
| mono, 0 dB, **gate off** | 15.3 % / **13.5 %** | 15 / 51 % | 33 / 14 % | 555 → 545 ms |

**Detector on its own** (syllable onsets with strength ≥ 0.9, matched within ±70 ms; "false" =
no syllable start within ±70 ms):

| Condition | Syllables found | False onsets | Median lag | Voiced frames: precision / recall | Held notes covered by one voiced segment |
|---|---|---|---|---|---|
| clean | 85 % | 0 % | −1 ms | 97 / 59 % | 29 / 32 |
| +6 dB | 80 % | 1 % | 4 ms | 87 / 61 % | 31 / 32 |
| 0 dB | 79 % | 1 % | 8 ms | 82 / 62 % | 30 / 32 |
| −6 dB | 70 % | 2 % | 13 ms | 74 / 70 % | 30 / 32 |
| mono guitar, 0 dB | 66 % | **52 %** | 7 ms | – | – |

(Voiced numbers come from 4 songs. Voiced-frame recall is low on purpose: short syllables and the
gaps between them aren't "held".)

**CPU:** 4.0–4.7 ms of CPU per second of audio at 22050 Hz, stereo or mono (Node 22, this
desktop). That is ≈ 0.45 % of one core, inside the spec's < 2 % budget, which also has to cover
parec and IPC. The first version used 8 ms/s. Recomputing the adaptive threshold every 4 frames
and the voicing floor every 8 frames halved it.

## What helps, what doesn't

- **Word starts, +6 / 0 dB: clear gain.** First play: mean −27 %, median about halved, words
  within 100 ms go from 28 % to 44–45 %. About 2 % of words get worse by more than 50 ms. Those
  are almost all one-syllable slips, where an onset in a regular eighth-note grid was missed.
  Later plays keep gaining, because each play may move a word another `maxShift` from the learned
  timing.
- **−6 dB: small gain, no harm.** The detector still finds 70 % of syllables with 2 % false
  onsets. But the ambiguity gates (below) block most moves, so only 19.5 % of words improve. The
  share made worse stays at 2.3 %.
- **The biggest limit is `maxShift` = 0.35 s, not the listening.** The LRC estimate is often
  wrong by more than 0.35 s: a held word mid-line pushes every later word late, and a pause after
  a line stretches the whole line. With `maxShift` 1.0 and nothing else changed, the play-1
  median drops to **46 ms (+6 dB) / 59 ms (0 dB)** with the same 2 % of words made worse, because
  the words that move are the same ones and they just get all the way there. Hold P/R rises to
  62 / 40 %. I kept the spec's 0.35 s default. Raising it is a decision for Marcy.
- **Holds: the detection works, the word mapping is the limit.** One voiced segment covers 30 of
  32 held notes and ends within about 30 ms of the true end, even at −6 dB. But a held word can
  only be marked once its word lands on the note. When the estimate puts the word more than
  `maxShift` away from the note, it can't get there. The held flag is right about half the time
  (precision 42–53 % vs. 15 % for "long estimated word") and catches a quarter to a third of
  holds. Held-word end error drops from 555 ms to 404–421 ms.
- **Mid-line holds pushing the next words** (`midHolds`): only fires when the held note matched
  one of the word's own syllables. That moves the needle a little (held-word end error at +6 dB
  407 → 377 ms in tuning) and costs about 0.4 % more words made worse. It stays on because the
  spec asks for it. An earlier version, which trusted any voicing past a word's end, made another
  2–4 % of words worse and was dropped.
- **Mono / centred guitar: no help possible with this approach.** Here 52 % of strong onsets are
  guitar chugs. Without the gate, refining made as many words worse as better (13.5 % vs 15.3 %).
  The noise gate measures onsets per second in the song's intro and interludes: ≤ 0.7/s for every
  stereo song, 2.5–4.6/s for every mono song. It then switches the song off cleanly.

## Things tried and dropped

- Matching words (not syllables) to the nearest onsets: in noise, 19–21 % of words got worse.
  Aligning syllables in order fixed most of that.
- No line tempo search: lines followed by a pause got aligned one syllable off. Trying 8 tempos
  (0.5–1.3×) brought the mean down by another ~50 ms.
- Interpolating unmatched words between matched ones: more gain, but also more words made worse.
  It is off.
- Flux of mid minus flux of side (`'ms'`) instead of the flux of |mid| − β|side|: more false
  onsets at every SNR.
- A mean-based adaptive threshold: worse. Persistent flux is mostly 0, so the median + K·MAD
  threshold is in practice the `thrMin` floor, with MAD only mattering in dense passages.

## Tuning chosen

`vocal-detect.js` `TUNING`:

| Constant | Value | Why |
|---|---|---|
| bandLo / bandHi | 300 / 3500 Hz | vocal band (formants F1–F3) |
| frameSec / hops | 0.046 s / 4 | 1024-point FFT, 11.6 ms hop at 22050 Hz (2048 at 44.1 kHz) |
| sideWeight | 2.0 | centre = \|mid\| − 2·\|side\|: best false-onset rate at −6 dB |
| persist | 7 frames (81 ms) | 3 frames: 33 % false onsets at +6 dB; 7: 1–2 %; 9 loses fast syllables |
| maxBack | 2 frames | SuperFlux-style reference (max of the previous 2 frames, ±1 bin) |
| decayMax | 1.5 (≈ 13 dB) | bins that drop this much after their peak are hits (rejects clicks and hats) |
| thrWindowSec / thrK / thrMin | 1.5 s / 2.5 / 0.02 | thrMin 0.01 floods; 0.04 loses quiet syllables |
| peakHalf / minGap | 3 frames / 80 ms | peak picking |
| voicedTonal / voicedLevel | 0.3 / 3.0 | tonality share and level over the 20th-percentile floor (4 s) |
| voicedDrop / peakDecay | 10 dB / 3 dB/s | ends voicing with the note, not the reverb (precision 58 → 97 % clean) |
| voicedGap / voicedMin | 60 ms / 120 ms | hysteresis |

`timing-refine.js` `REFINE`:

| Constant | Value | Why |
|---|---|---|
| maxShift | 0.35 s | spec default (1.0 would gain a lot, see above) |
| minWord | 0.08 s | spec |
| leadIn | 0.12 s | an LRC stamp up to 0.12 s late still lets the first word use its onset |
| minStrength | 0.9 | weaker onsets are 30–50 % false in noise |
| window | 1.0 s | how far a syllable looks for its onset (1.5 s: no gain) |
| offPenalty / offScale | 0.3 / 0.15 s + 0.3 × time into the line | the line stamp is close, later words drift |
| smooth | 1.0 per s | change in offset between matched neighbours |
| skipSyllable / skipOnset | 0.5 / 0.15 | missed syllable / extra onset |
| rates / ratePenalty | 0.5…1.3 (8 tempos) / 0.1 | line tempo search |
| ambiguity | 0.15 | tempos within this score must agree on a word's onset |
| margin | 0.4 | the alignment without that onset must score this much lower |
| minMatchFrac / maxDensity | 0.5 / 2.0 | line-level gates |
| interpolate | false | see above |
| holdMin / holdTail / holdOnset | 0.6 s / 0.45 s / 0.5 | held = long, and its tail is one voiced note with no onset |
| minStretch / minVoiced | 0.15 s / 0.35 | last-word stretch |
| maxNoise | 1.5 onsets/s | stereo songs ≤ 0.7, mono-guitar songs ≥ 2.5 |
| midHolds | true | spec behaviour, see above |
| MAX_PLAYS (merge) | 5 | after 5 plays a new play still counts 1/5 |

## Limits (be honest about the bench)

- The singer is a synthesizer. Real voices have breathy onsets, slides into notes, doubled
  vocals, backing vocals (often wide, which helps, or centred, which doesn't), and heavier reverb
  and compression. Real distorted guitars are less tonal at the bin level. Expect lower syllable
  recall than here.
- The centre-channel trick depends on the mix: it helps a lot when the guitars are
  double-tracked and panned wide, which is common in punk and rock (Against Me! included), and
  does nothing for mono or centred parts. There the noise gate switches refining off. It can only
  do that after hearing 3 s of an intro or interlude, so until then (`rate: null`) refining runs
  ungated.
- The bench's line stamps are only slightly off (−150…+50 ms). LRCLIB stamps that are badly off
  can't be fixed: a word never moves before its line's stamp.
- Monitor latency and clock conversion (agent B's side) aren't simulated. Detector times are
  exact song times here. A constant offset in the wiring shifts every onset, and the alignment
  will partly follow it. That needs measuring in the real app.

## API as built (for the wiring)

```js
const { createVocalDetector } = require('./vocal-detect')
const d = createVocalDetector({ sampleRate: 22050, channels: 2 /* 1 = mono (default) */, tuning? })
d.push(samples /* Int16Array | Float32Array; interleaved L,R when channels: 2 */, t0 /* song s */)
  -> { onsets: [{ t, strength }], voiced: [{ start, end, confidence }] }
d.flush()   // close an open voiced segment (pause / track end) -> same shape
d.reset()   // track change; a t0 jump of > 0.25 s (seek) resets by itself

const { refineWords, mergeLearned, noiseRate } = require('./timing-refine')
refineWords(line, { onsets, voiced }, { nextStart /* next line's t */, noiseRate /* from below */ })
  -> { words: [{ t, end, text, held? }], moved, confidence }
noiseRate(allOnsetsSoFar, lines, upToSongTime) -> { rate /* onsets/s, null until 3 s heard */, seconds }
mergeLearned(prevWords | null, words, plays /* including this one */) -> words
```

Events come out about 140 ms after the audio (81 ms persistence, 35 ms peak picking, half a window), and a voiced
segment comes out when it ends. Refining a line at its end + 0.5 s, as the spec says, has all its
evidence. `held: true` is optional extra data; the lyrics window can ignore it.
