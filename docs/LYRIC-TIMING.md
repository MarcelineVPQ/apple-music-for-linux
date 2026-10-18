# Lyric word timing: drift on the first play (0.15.32)

Marcy's report (0.15.31): "lots of drift in the majority of songs, by the time it gets to the end
of each verse." This page has the measurement, the cause, what changed, and the numbers before and
after. Tools: `tools/drift-check/` (below).

## How it is measured

The **drift check** compares, word by word, what the lyric views light up with where the word is
really sung.

- **The visual side** is the real engine. `tools/drift-check/lib.js` runs the same code that
  `render()` in lyrics-view.js runs: `liveLines`, `interludeAt`, and `wordState` at the playback
  time plus `WORD_LEAD`. It samples every 50 ms. The **DOM proof** (`dom-check.js`) loads the real
  lyrics view (lyrics-view.js and lyrics-view.css in a Chromium page, isolated under Xvfb) and
  drives it on a virtual clock through every song. Every 50 ms it reads which words have `.now`
  inside an `.active` line and compares them with the engine. For the progressive method it also
  delivers the aligned sections through `view.align()`. Result: **75,411 frames over 22 song runs,
  DOM = engine on 100.00 % of frames.** The headless numbers below are therefore exactly what the
  window shows.
- **The spectrum side** is the ground truth.
  - Her library: words force-aligned to the separated vocals by sonata-align (Demucs plus
    wav2vec2 on her GPU). These are the `aligned|…` cache entries, read from a copy of her cache.
    That aligner is 0.032 s median from hand annotations (docs/LEVEL2-ALIGN.md).
  - JamendoLyrics MultiLang: 79 songs, 21,580 words with hand-annotated word starts and ends, the
    Level 2 benchmark. Two input modes: `lrc` gives line starts only, like LRCLIB; `ends` gives line
    starts plus exact line ends.
- **Metrics:**
  - Word-start error: median, mean, p90, and bias. A positive bias means the word lights up late.
  - Drift slope: the least-squares slope of the error against word index within a line, in ms per
    word.
  - Error of each line's last word, and of the last line of each verse. A verse is the lines
    between two interlude gaps.
  - Signed error by position in the line, in deciles.
  - The frame check: the share of sung frames where the word being sung is the lit one.

Methods compared:

| Method | What it is |
|---|---|
| `v0` | the 0.15.31 estimate: words stretched over 90 % of the line's time |
| `estimate` | the new first-play estimate, from the lyrics alone |
| `progressive` | first play with Precise timing on. Sections are aligned while the song plays. Each arrives `HELPER_DELAY` = 8 s after the section's audio is complete. Later lines then use repeats of aligned lines and the song's measured pace. |
| `repeat` | first play with Refine by listening. A line refined after it was sung lends its timing to later identical lines. |
| `refine` | the second play with Refine by listening, using the learned timing |
| `aligned` | the second play with Precise timing |

Refine is run with the real Level 1 detector on the decoded JamendoLyrics audio
(`--audio`). Her own audio can't be replayed, so on her songs the refine rows are missing. Her
`aligned` row is missing too, because there it is the truth itself.

## The cause

On the first play of a song with line-only lyrics (Apple line-timed TTML or LRCLIB), Sonata
estimates the word times. The old estimate spread a line's words over 90 % of the time until the
line's end, or until the next line's start. But a line is sung at its own pace, and the time left
over is silence:

- In her library, **Apple's line end equals the next line's start (within 50 ms) in 51 % of
  lines**. In those lines the "end" includes the pause before the next line. LRCLIB has no ends at
  all. Even Apple's real ends run a median **0.32 s past the last sung word** (p75 0.44 s).
- People sing at about **0.21–0.24 s per weight unit** (wordWeight: syllables + 0.35, plus 0.6
  after punctuation). This is the median pace in both her songs and JamendoLyrics. Lines whose
  time runs on hold ~40–70 % singing. *Never Get Old*: "And I'm never ever gonna get old" gets
  4.7 s and is sung in 1.8 s.

So every word after the first lit up later and later along the line. Signed error by position
(v0, her 7 songs, ms):

```
first word → last word:   -57   23   57  109  174  220  285  295  339  393
```

The slope is +29 ms per word, with a bias of +156 ms. The last line of a verse is worst (+263 ms
bias), because its time runs into the interlude. On LRC input the last line of a verse is
**+681 ms late on average**, because the old cap (0.6 s per word + 2 s) still allowed most of the
gap. That is the "drift by the end of each verse".

Ruled out:

- **The 0.05 s monitor latency.** Her aligned first words sit +0.06 s after Apple's line starts,
  the same at the start and the end of songs. A constant offset doesn't grow along a line.
- **Syllable weights.** A grid over base and punctuation weights moved the mean by less than 5 ms.
- **The clock.** The DOM proof matches the engine on every frame. The bench drives a perfect
  clock, so clock drift isn't measured here, but the engine adds none.

## What changed

1. **Paced first-play estimate** (lyrics-timing.js `estimateWords`). Tuned on JamendoLyrics
   English and German, checked on French and Spanish and on her songs, which were held out except
   for one Apple-specific constant (below).
   - A line is sung at the song's pace from its start. The rest of its time is tail. The pace is
     0.25 s per unit, blended in log space with the song's own: the 20th percentile of
     time-per-weight over its lines, which picks out the lines sung back to back.
   - The words take at most 90 % of the line's time. A line too long for its time is squeezed in,
     as before.
   - A real Apple end (one that stops more than 50 ms before the next line) is trusted. The words
     take 90 % of [t, end] minus 0.2 s, because Apple's ends run ~0.3 s long. The 0.2 s comes from
     her songs only; JamendoLyrics has no Apple-style ends. With exact ends, a plain 0.9 spread
     would be better, see the `ends` table.
   - The last word of a line sung faster than its time holds for up to 1 s, like a held note.
2. **Progressive alignment** (align-session.js). With Precise timing on, the song is split into
   sections: the lines between two interludes, at most 8 each, split evenly. Each section goes to
   sonata-align as soon as it has been sung (3 s after it ends), as its own slice of audio, while
   the song plays on. Before this change the song was aligned only once, after it ended.
   - Jobs run one at a time, in a queue.
   - Each section's words are cached at once (merged into the entry, `partial: true` until every
     section is done) and sent to the views as `lyrics-aligned`.
   - A section skipped by a seek is left out. The partial entry is completed on a later play,
     which records only the missing sections.
   - A helper failure stops that song's later sections, with one log line.
   - When the whole song was heard, it is aligned once more as one job after the last section,
     and that result is what stays cached (see the cost below). So the audio buffer is still kept
     until the song is done, as before.
3. **What the views learn from it** (lyrics-timing.js `repace` and `reuseRepeats`, lyrics-view.js
   `learnFrom`). These run in `prepare()` and after every `lyrics-aligned` or `lyrics-refined`
   message, so they act during the same play.
   - Plain estimated lines are re-estimated at the pace sung in the aligned or refined lines.
   - A repeated line (chorus) takes the word timing of an identical aligned line, shifted to its
     own start. A refined line is used when no aligned one exists. The copy is cut at the next
     line's start.
   - Priority stays: Apple word timing > aligned > refined > estimated. A repeat copied from an
     aligned line is marked `repeat: 'aligned'`, and a refine message can't replace it. The line's
     own alignment always replaces it. A repeat copied from a refined line is upgraded when an
     aligned source appears.
   - Lines refined from their own audio are never overwritten by repeats.

No main.js change was needed. main.js already applies the cache through `prepareLines`, sends
`lyrics-aligned` to both views, and calls `alignSession.tick` and `stop(true)`.

## Numbers

### Her library (7 songs, Apple line-timed, 1,737 words; truth = aligned)

| Method | median | mean | p90 | bias | ≤0.1 s | ≤0.3 s | slope ms/word | line-end mean (bias) | verse-end mean (bias) | frames lit right |
|---|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|
| v0 (0.15.31) | 196 | 353 | 840 | +156 | 30 % | 64 % | +29 | 441 (+251) | 586 (+263) | 49 % |
| estimate | 181 | 307 | 767 | +37 | 32 % | 68 % | −4 | 396 (−4) | 604 (+187) | 47 % |
| **progressive** (first play) | **138** | **223** | **508** | −2 | 41 % | 77 % | 0 | 274 (−39) | **362 (+30)** | 53 % |

Signed error by position in the line (ms, first word → last word):

```
v0           -57   23   57  109  174  220  285  295  339  393
estimate     -58  -19   -1  -10   70   71   80  104   89  295
progressive  -41  -23  -20   -4   14    4   33   30   -8   79
```

Per song, mean |error| (ms) for v0 → estimate → progressive:

- Sofa King: 318 → 323 → 280
- Ache With Me: 327 → 358 → 258
- Damn: 248 → 231 → 208
- Friday Night: 139 → 138 → 122
- Big Time Nothing: 205 → 222 → 210
- Never Get Old: 855 → 621 → 314
- Satan's Bed: 263 → 203 → 175

The estimate alone is worse on two songs, *Ache With Me* and *Big Time Nothing*. Both are sung
slower than the default pace, so their words now come early. Progressive is better than v0 on
every song but *Big Time Nothing*, where it is about level (210 vs 205).

### JamendoLyrics, LRC input (79 songs, 21,580 words; truth = hand annotations)

| Method | median | mean | p90 | bias | ≤0.1 s | ≤0.3 s | slope | line-end mean (bias) | verse-end mean (bias) | frames |
|---|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|
| v0 (0.15.31) | 170 | 341 | 883 | +185 | 37 % | 66 % | +35 | 540 (+353) | 1384 (+681) | 49 % |
| estimate | 140 | 282 | 693 | −66 | 42 % | 72 % | −3 | 422 (−137) | 1007 (−637) | 49 % |
| repeat (Level 1, first play) | 140 | 282 | 695 | −66 | 42 % | 72 % | −2 | 422 | 1010 | 49 % |
| **progressive** (first play) | **93** | **243** | 607 | −61 | 52 % | 78 % | −3 | 362 (−127) | 936 (−526) | 53 % |
| refine (second play, Level 1) | 139 | 282 | 696 | −64 | 42 % | 72 % | −2 | 422 | 1000 | 49 % |
| aligned (second play, Level 2) | 32 | 80 | 113 | −2 | 88 % | 97 % | 0 | 131 (−11) | 463 (+30) | 68 % |

- **Verse ends on LRC input are still far off: −637 ms mean bias.** Here the sign flipped: the
  last line of a verse is sung slower (median 0.33 s per unit, against 0.22 s elsewhere), with held
  notes, so the paced estimate is now early there. A slower pace for verse-end lines (×1.25–1.6)
  was tried. It moved verse ends but not the overall mean, so it isn't in. Only the audio fixes
  these lines.
- Ablation of progressive. Repeats alone: 237 ms mean on JamendoLyrics, 271 ms on hers. Learned
  pace alone: 289 and 256. Both together: 243 and 223.
  - On JamendoLyrics, 26 % of lines are repeats of an earlier aligned line on the first play. On
    hers, 25 %.
  - The learned pace helps her Apple songs a lot but costs 6 ms on JamendoLyrics LRC. Both are
    kept, because her case is the real one.

### JamendoLyrics, line starts with exact ends, and with ±0.5 s jittered LRC starts

| Method | exact ends: median / mean / bias | LRC ±0.5 s: median / mean / bias |
|---|---|---|
| v0 | 122 / 218 / −15 | 293 / 425 / +173 |
| estimate | 133 / 234 / −83 | 279 / 391 / −96 |
| progressive | 90 / 200 / −64 | 284 / 391 / −88 |
| aligned | 33 / 73 / +9 | 33 / 85 / −3 |

- With exact line ends, the old stretch was already right, and the 0.2 s tail for Apple ends
  costs 16 ms. Real Apple ends aren't exact (above), and LRCLIB has none.
- With line starts off by up to ±0.5 s, the start error dominates. Neither the estimate nor
  progressive helps beyond removing the slope. The aligner doesn't care.

### Refine by listening (Level 1) on real music

The detector and refiner, run on the real JamendoLyrics audio, **refine only 138 of 3,383 lines
(4 %)**. The gates (noise rate, onset density, ambiguity, half the syllables matched) reject the
rest. 8 of 79 songs are gated as a whole. The refine and repeat rows are therefore within 1 ms of
the estimate.

This matches her cache: one `refined|` entry with 3 lines, against 7 aligned songs. Level 1 was
tuned on the synthetic bench (tools/listen-bench), and on real mixes it mostly stays out of the
way. It does no harm, but it isn't what fixes drift. Precise timing is.

### Progressive alignment cost (the real helper, RTX 5080)

`tools/drift-check/section-bench.js` runs the real sonata-align helper on JamendoLyrics in two
ways: section by section, as align-session.js now does, and as one whole-song job, as before.

All 79 songs, LRC anchors:

| | median | mean | ≤0.1 s | ≤0.3 s | lines aligned |
|---|--:|--:|--:|--:|--:|
| whole song, one job (0.15.31) | 31 ms | 65 ms | 90 % | 98 % | 3,226 / 3,383 |
| section jobs (655 jobs, 8.3 per song) | 32 ms | 87 ms | 88 % | 96 % | 3,231 / 3,383 |

- The helper takes a median **0.36 s per section job** (p90 0.65 s). The audio per job is a median
  26 s. The whole-song job takes 3.1 s.
- The slowest job took 18.6 s. That was a job whose language switched the model (1.26 GB
  wav2vec2). In the app a song's language doesn't change, so only a song's first job pays the model
  load (1.5 s cold).
- The drift check assumes 8 s from a section's end to its words on screen, which is
  conservative.
- Sections are as accurate as the whole song at the median, but the tail is a bit worse: mean
  87 vs 65 ms. The likely reason is less context at the slice edges. So after the last section,
  when the whole song was heard, the **whole song is aligned once more**. That costs ~3 s of GPU
  per song. Its words win in the cache entry, so later plays are exactly as good as in 0.15.31.
  During the play its message changes nothing on screen, because lines that are already aligned
  are kept.

## Running it

```
cp ~/.config/apple-music-for-linux/lyrics-cache.json /some/scratch/cache-copy.json   # never the live file
node tools/drift-check/drift-check.js --cache /some/scratch/cache-copy.json [--mode lrc|ends] [--jitter 0.5] \
     [--audio --work /some/scratch/onsets] [--songs] [--deciles] [--json out.json]
node tools/drift-check/section-bench.js [--limit 79]          # GPU, spawns its own helper
# DOM proof: isolated Electron, see the header of tools/drift-check/dom-check.js
```

JamendoLyrics is read from the engine's bench.py's copy (`~/.local/share/sonata-align/bench`), and its
aligned words from `<bench>/results/auto-j0.json` (in that bench folder). The `--audio` onsets are cached in `--work`.

## Not verified

- **Progressive alignment hasn't run inside the app yet.** It was tested with node tests, which
  stub the helper, and with the real helper on decoded files (section-bench). Nobody has played a
  song in Sonata with it. The per-section log line is new:
  `align: aligned 6/6 lines (1–6 of 34) of "…" in 0.9 s`.
- **Stutter.** The helper is its own process and a job takes about a second of GPU. In main, a
  section costs one buffer copy and base64 of a few MB. No stutter is expected, but playback while
  sections align hasn't been watched.
- **The first-play numbers on her songs are from 7 songs.** The constants were tuned on
  JamendoLyrics, apart from the Apple tail.

## Held notes (0.15.34)

Marcy's report on 0.15.33: in The Goo Goo Dolls' "Home (Live)", "home" in "Come take me home" is held for
seconds, but its highlight dropped and the next line lit up while it was still sung. Her cache showed why:
the aligner's "home" in that line ended at 75.91 s (0.34 s long), while Apple's line runs to 81.47, past the
next line's start (81.08). A CTC aligner ends a word on the last frame it emits a letter for; a held vowel
is mostly emitted as blank. The first-play estimate capped the last word's hold at 1 s and 90 % of the time
to the next line.

**Metric** (`tools/drift-check`, new "held notes" table): every truth word sung ≥ 0.8 s. *End error*: when
the view stops lighting the word (its end, as `wordState` uses it) minus when the voice stops; *ended early*:
the highlight ends ≥ 250 ms before the voice; *held frames lit*: share of 50 ms frames inside held words
where the held word is the lit one.

**Changes**
1. **Aligner** (the engine's sonata_align.py `extend_holds`): after the alignment, each word's end follows the
   separated vocal stem while it stays loud (within 24 dB of the song's loud singing and 15 dB above its
   quiet frames, dips up to 80 ms), never past the next word's start − 0.04 s or 8 s; an extension of 0.2 s
   or more marks the word `held` with `hold_from` (where the sung part ends). Aligned cache entries move to
   version 2, so songs aligned before are aligned again the next time they play with a lyric view open.
2. **Estimate** (`lyrics-timing.js`): a line sung faster than its time holds its last word for up to 3 s
   (was 1 s), until 0.1 s before the next line (was 90 % of the time to it); with a real Apple end, to that
   end minus Apple's 0.2 s tail; and when Apple's line end is after the next line's start (the singer is
   still holding), over the next line to that end − 0.2 s. Rules picked by measuring nine variants on all
   three sets; "hold until the next line, no limit" was best where lines have ends but kept LRC lines lit
   through long breaks (end error ~3 s).
3. **Overlap** (`boundHolds`): a held word keeps its hold over the next line's start (the new line is
   current while the old word still sings; `liveLines` keeps both lit) but never past the next line's first
   real (aligned or refined) word, and at most 0.6 s past a next line that is only an anchor. Level 1
   (Refine by listening) already marked held words from voiced runs; its `held` now survives every merge.
4. **Syllables and sustain**: the hold belongs to the last syllable (for·ev·er: "er" carries it), and 0.25 s
   into the hold the pop settles into a gentle sustained lift (`.hold`, one 0.6 s ease, no repeat) for as
   long as the voice holds. Same in the visualizer (same engine).

**Numbers** (word starts unchanged in every row)

JamendoLyrics, 79 songs, 2,603 held words, truth = hand annotations:

| method | held: ended early | held frames lit | end error mean (bias) | all frames lit |
|---|--:|--:|--:|--:|
| estimate, LRC starts, before → after | 58 % → 35 % | 44 % → 65 % | 799 (−696) → 736 (−132) ms | 49 % → 58 % |
| estimate, starts + ends, before → after | 78 % → 26 % | 47 % → 64 % | 589 (−503) → 369 (−284) ms | 46 % → 55 % |
| aligned (2nd play), before → after | 50 % → 20 % | 63 % → 81 % | 575 (−359) → 421 (−67) ms | 59 % → 69 % |
| progressive (1st play), before → after | 42 % → 35 % | 62 % → 66 % | 742 (−209) → 699 (−141) ms | 57 % → 59 % |

Her library, 32 songs, 522 held words, truth = her aligned cache (made before this change, so its own holds
are often cut short: the "after" is understated): estimate 61 % → 41 % ended early, held frames lit 38 % →
54 %, all frames lit 38 % → 46 %. Her aligned songs themselves can't be re-measured here (no audio); they are
re-aligned with holds on their next play.

The aligner rows come from two the engine's bench.py runs on the RTX 5080, `--param hold=0` and the default; the
bench file now stores the aligner's word ends and holds. In the app, `tools/ui-check.js lyrics` checks a held
word over the next line's start: both lines lit, the held word lit and settled into its sustain, and released
0.6 s past an anchor-only next line.

## Onset (0.15.35)

Marcy's report on 0.15.34: in The Goo Goo Dolls' "So Alive (Live)", estimated sections ran early on a first
listen. Her cache showed why: Apple's line stamps on this live cut come a median 0.75 s before the first
sung word (aligned entry, 51 lines; range 0–1.66 s), and `learnedPace` learned only the pace from the lines
already aligned, never where in the line the singing starts.

**Change** (`lyrics-timing.js`): `learnedOnset` takes the median of (first word − line stamp) over the
song's aligned/refined lines (not mapped repeats), from at least 3 lines, clamped to [0, 1.5 s], and 0 when
under 0.15 s. `repace` re-estimates the plain estimated lines with their words starting that much after the
stamp (at most 40 % of the line's time, so a short line is squeezed, never pushed into the next). Lines with
real word timing (Apple syllables, aligned, refined, mapped repeats) are never touched. The line still lights
at its stamp − `LINE_LEAD` (0.2 s), so the line now leads its first word by about onset + 0.2 s, as Apple's
own line-timed lyrics do. The last word's hold is unchanged: it still lets go `HOLD_GAP` (0.1 s) before the
next line's stamp, or at Apple's end minus `TIGHT_TAIL`. Extending the hold to the next line's shifted first
word was measured and not taken: held "ended early" 38 % → 37 % but the end error mean got 2 ms worse.

The dead zone: on JamendoLyrics the line stamps are the annotated line starts, so the learned onsets are
0–0.14 s; shifting by them cost the bench 2 ms of median error (93 → 95 ms, ≤ 0.1 s 52 % → 51 %). With the
0.15 s dead zone the bench is unchanged.

**Numbers** (`progressive`: the first play with precise timing; `estimate` doesn't learn, unchanged).
Her library: a copy of her cache taken 2026-10-16 20:44 (33 aligned songs, the newest entry per song: 4
of the 7 live songs still version 1; Slide, Long Way Down and Home (Live) version 2, Home partial, 23 of 41
lines). Live = titles with "(Live)" (The Goo Goo Dolls, "The Audience Is This Way"); Marcy's aim is to
nail live recordings first.

| set | words | median | mean | bias | ≤ 0.1 s | ≤ 0.3 s | frames lit |
|---|--:|--:|--:|--:|--:|--:|--:|
| "So Alive (Live)", before | 370 | 569 | 686 | −655 | 3 % | 19 % | 14 % |
| "So Alive (Live)", after | 370 | 369 | 467 | −375 | 8 % | 39 % | 19 % |
| live, 7 songs, before | 1,770 | 582 | 672 | −579 | 10 % | 26 % | 27 % |
| live, after | 1,770 | 366 | 490 | −304 | 16 % | 43 % | 33 % |
| studio, 26 songs, before | 7,056 | 174 | 337 | −150 | 35 % | 67 % | 52 % |
| studio, after | 7,056 | 167 | 320 | −103 | 36 % | 69 % | 53 % |
| her library, 33 songs, before | 8,826 | 218 | 404 | −236 | 30 % | 58 % | 47 % |
| her library, after | 8,826 | 194 | 354 | −144 | 32 % | 64 % | 49 % |
| JamendoLyrics LRC, 79 songs, before | 21,580 | 93 | 243 | −61 | 52 % | 78 % | 59 % |
| JamendoLyrics LRC, after | 21,580 | 93 | 243 | −61 | 52 % | 78 % | 59 % |

Live songs, median before → after (ms): Big Machine 871 → 675, January Friend 666 → 365, The Pin 606 → 349,
So Alive 569 → 369, Slide 567 → 302, Home 359 → 316, Long Way Down 293 → 287.

**Not covered: "Home (Live)", "A million miles, but I will find you" → "So take me home"** (Marcy's
screenshot on 0.15.34-dev.1: "So take me home" lit, "me" mid-pop, while the singer was still on the line
before). Apple stamps line 15 at 95.10 s but ends line 14 at 97.13 s: a 2.04 s overlap, the largest of the
21 overlapping pairs in her library (median 0.52 s). On that first play lines 14–15 were estimated (their
section, lines 9–16, can only be aligned after 110 s of audio), so line 15 lit at its stamp and its words
were spread from 95.10 to 100.72 ("me" 97.62–98.88), while line 14's "you" was held to 96.93 by the
0.15.34 overlap rule. The aligner (version 2, cached since) disagrees with her ears too: "you" ends 94.91
s, not held, and "So take me home" is placed at 95.17–96.83 with "home" only 0.47 s long, although Apple's
line runs to 100.92. So the aligner likely placed line 15 too early and missed a held "you"; that can't be
checked without the audio (the drift check takes the aligner as the truth). The learned onset here is
0.34 s, which moves "me" only ~0.2 s. A rule "an estimated line waits for the previous line's Apple end"
would fit this pair, but on the other overlapping pairs the aligner has the next line start 0.16 s after
its stamp (median), before the previous end, so it would measure worse; left for Marcy to decide.

Per song in her library: 12 songs better (six of the seven live ones), 18 unchanged, 3 worse: Ache With Me and Sofa King +8 ms, and Headstrong +250 ms, whose aligned
"truth" is itself off by up to 11 s (median error 1.6 s before the change; its bias improved −891 → −749).

What's left on "So Alive": the first section is sung before anything is learned (lines 0–10 keep the full
early bias), choruses mapped from an aligned line inherit that instance's delay (`reuseRepeats` shifts by the
stamps only), and the "I'm so alive, I'm so alive" lines drift (sung slower than the learned pace). The
"(Hey-hey-ay-ay-ay)" lines were rejected by the aligner (low confidence) and are estimated; they now bounce
by syllable (`splitWord`: a hyphen between letters is a boundary) and take the onset too.

## Lyrics fine-tuning (0.15.39-dev.1)

Five backlog rows in one pass. Measured with the drift check (her cache copied 2026-10-17: 51 aligned
songs, 21 live = titles with "(Live" or "[Live", the Goo Goo Dolls and Dave Matthews Band Live at the
Gorge; 30 studio), the 79-song JamendoLyrics bench (LRC and line-ends input) and the section bench (the
real helper, RTX 5080, in eight slices of ten songs, VRAM capped at 40 %).

### Hyphen runs are words

"(Hey-hey-ay-ay-ay)" was one word to all three splitters, so the estimate weighed it as about two
syllables and the aligner placed it as one token. Now `lyrics-timing.js` `splitWords` (used by
align-session.js too) and the engine's sonata_align.py `split_words` split at white space and at every hyphen
between two letters, the hyphen staying on the piece before it ("(Hey-", "hey-", "ay-", "ay-", "ay)").
One fixture, `test/fixtures/split-words.json`, is checked by both test suites. A hyphen piece gets no
breath weight (`wordWeight`). The views write the pieces of a run together, without spaces
(`wordGlue` against the line's text; checked in a real Chromium page). Apple words timed by Apple are
not split, so a timed "Hey-hey" keeps its 0.15.35 syllable bounce.

Aligned entries move to version 3. A version-2 entry is still used for lyrics without a hyphen run (its
words are the same), so only 13 of the 51 aligned songs in her cache are aligned again on their next play.

The drift check scores per white-space word (`lib.js` `toSpaceWords`: a run's pieces count as one word
from the first piece's start to the last piece's end), so the numbers stay comparable with earlier rows.
Its aligned methods spread a cached version-2 run's time over its pieces (`toPieces`), as a version-3
entry would carry them.

JamendoLyrics has no hyphen runs (its texts are normalised), so all its rows are identical before and
after. Her library, the 30 lines (160 words) with a hyphen run that have aligned truth:

| | median | mean | bias | ≤ 0.3 s | frames lit |
|---|--:|--:|--:|--:|--:|
| estimate, before → after | 328 → 317 | 441 → 437 | −310 → −299 | 46 → 48 % | 46 → 47 % |
| progressive, before → after | 215 → 223 | 333 → 334 | −226 → −219 | 59 → 59 % | 52 → 52 % |

The gain that matters can't be measured here: the aligner now places each "hey" on its own, but the
truth in her cache was aligned as one token per run.

### Rejected lines are logged; a lower min_conf for vocables was not taken

The aligner drops a line whose mean letter probability is under `min_conf` (0.2). Each section's log line
now names them: `align: aligned 6/8 lines (lines 9–16 of 41) of "…" in 0.9 s · rejected: line 12 (0.14)
"(Hey-hey-ay-ay-ay)"`, and the entry keeps them (`rejected: [{ line, confidence }]`).

Short vocable lines (only "oh", "hey", "na", "la", "whoa" …, at most 8 words: `tools/drift-check/lib.js`
`vocableLine`) are the lines it rejects most: 59 of the 313 lines rejected on the section bench. Keeping
them from a lower confidence, measured on the lines that rule would add:

| kept from | section jobs: lines, aligned vs estimate (median, ≤ 0.3 s) | whole song: lines, aligned vs estimate |
|---|---|---|
| 0.15 | 9: 518 vs 125 ms, 41 vs 91 % | 5: 184 vs 232 ms, 57 vs 81 % |
| 0.10 | 14: 482 vs 116 ms, 38 vs 94 % | 9: 191 vs 215 ms, 61 vs 88 % |
| 0.05 | 15: 525 vs 94 ms, 35 vs 95 % | 13: 184 vs 213 ms, 60 vs 89 % |
| 0.02 | 22: 584 vs 185 ms, 34 vs 82 % | 15: 191 vs 210 ms, 58 vs 90 % |

The bench's whole-song results (auto-j0.json, 0.10–0.2): 7 lines, aligned median 151 vs estimate
194 ms, within 0.3 s 74 vs 93 %. The rejected vocable lines are placed worse than the estimate, by far
in the section jobs the app runs first, so `min_conf` stays. Her live songs may differ (their line stamps
come early), but her cache has no truth for rejected lines; the new log lines will show their confidence.

### pickHit: the same recording

`lyrics-sources.js` `isLive` ("(Live)", "[Live …]", " - Live", an album "Live at …" or "Live"; not
"Live Forever") and `pickHit(hits, duration, title, album)`: inside the ±5 s length window a hit of the
same kind (live or studio) comes first, synced before plain. When only hits of the other kind are left,
their words are used as plain lyrics, never their timing (a studio LRC's stamps are off all song long on a
live cut). Her cache has no LRCLIB live songs (25 live, all Apple), so this is covered by tests only.

### Level 2: gaps filled on a later play

0.15.33–0.15.38 already filled whole sections a play skipped (seek, gaming pause, helper failure:
`partial`). Two gaps were left: a line left out of a section that was otherwise heard (a seek inside it:
the section needs 90 % coverage, each line all of its own time), and a fully heard song kept its rejected
lines as "done". Now the entry keeps `missed` lines (heard sections, lines neither aligned nor rejected);
their sections are aligned again on a later play, at most `MAX_FILLS` (2) plays, so a line that is never
fully heard can't cost GPU time forever. Such a play records only the spans of those sections and runs no
second whole-song pass when the entry had one (`whole`); lines aligned before keep their words. Rejected
lines are not retried: the same audio gives the same verdict.

### Held notes mid-line: measured, no estimator change

JamendoLyrics has 2,603 held words (sung ≥ 0.8 s); 1,144 of them are inside a line. The estimate ends
60 % of those early (progressive 49 %), against 15 % of held last words. The text barely tells which word
is held: no punctuation in the bench, 18 stretched spellings ("sooo"), and words of 3+ syllables are held
41 % of the time but already get the time of their syllables. Extra hold weight for such words:

| variant | estimate median / mean (LRC) | mid-line held: ended early, frames lit |
|---|--:|--:|
| none (shipped) | 140 / 282 | 60 %, 44 % |
| 3+ syllables, +0.5 unit | 141 / 281 | – |
| 3+ syllables, +1 unit | 142 / 281 | 54 %, 48 % |
| 2+ syllables, +0.5 unit | 146 / 279 | 51 %, 49 % |
| 2+ syllables, +1 unit | – | 43 %, 52 % |
| stretched spellings, +1 unit | 140 / 282 | – |

Every variant that moves held notes costs the 79-song bench median 1–6 ms (≤ 0.1 s 42 → 40–41 %), so
none is in. The aligner already holds mid-line words (`extend_holds` runs every word to the next word's
start − 0.04 s), repeats and Level 1 carry `held`, and the view sustains any held word, not only a line's
last.

### Before / after (nothing regressed)

| set | method | before: median / mean / ≤ 0.3 s / frames | after |
|---|---|---|---|
| JamendoLyrics LRC, 79 songs | estimate | 140 / 282 / 72 % / 58 % | same |
| | progressive | 93 / 243 / 78 % / 59 % | same |
| | aligned | 32 / 80 / 97 % / 68 % | same |
| JamendoLyrics with ends | progressive | 91 / 200 / 79 % / 58 % | same |
| her library, 51 songs | estimate | 295 / 469 / 51 % / 44 % | 294 / 469 / 51 % / 44 % |
| | progressive | 201 / 355 / 62 % / 49 % | same |
| live, 21 songs | estimate | 412 / 541 / 39 % / 41 % | same |
| | progressive | 256 / 393 / 55 % / 47 % | same |
| studio, 30 songs | progressive | 173 / 326 / 68 % / 51 % | same |
| section bench, 79 songs | whole song | 31 / 65 / 98 %, 3,226 lines | same (this branch's helper) |
| | section jobs | 32 / 87 / 96 %, 3,231 lines (0.15.33) | 32 / 89 / 96 %, 3,227 lines |

Seen on the section bench with VRAM capped at 40 %: for 6 of 79 songs the helper had dropped the kept
sections before the kept-final pass ("no-cache"); the app then sends the audio again, the bench now skips
that pass and says so. Not investigated further (another branch's area).

## Hold attribution (0.15.41)

Marcy's report: in The Goo Goo Dolls' "So Alive (Live)", "You can make it on, you can make it on", the
singer holds the last "on", but its highlight dropped after a moment. Her cache (version 3, model `en`):
"it" 176.81–181.58, held from 176.85; "on" 181.63–182.02. The sung "it" is short and "on" is held from
about 176.9 to about 182 s.

**Cause.** A CTC aligner emits a held vowel mostly as blank, so the Viterbi path puts "on" on its last
frames (the "n" at the end of the hold), and `extend_holds` then follows the loud stem from the end of
"it" to "on"'s start: the word before gets the hold. The aligner's word starts are otherwise right, and
the hold itself is real; only its owner is wrong.

**What the bench says about moving holds** (79 JamendoLyrics songs, ±0.5 s anchors, the aligner's own
starts, ends and `hold_from` now stored by the engine's bench.py). Of 278 mid-line words held ≥ 0.5 s, moving
the next word's start to the hold's start made it worse for 201 and better for 68: mid-line holds ("la
cellule", "tu musa", "a menos") are mostly real. Line-final words after a held function word are the
other way round ("care at all": "all" 1.22 s late → 0.10 s early).

**Change** (`lyrics-timing.js` `reattributeHolds`, one line's words): when a function word (per aligner
language: en, de, fr, es lists; "no" and "so" left out, they are held) holds ≥ `MOVE_HOLD` (0.6 s), does
not end a phrase itself, and the next word is the line's last word (or ends a phrase: , ; : . ! ?)
spanning ≤ `MOVE_SHORT` (0.7 s), the function word ends where it was sung (its `holdFrom`) and the last
word starts there and holds to its own end. It runs in `entryFromResult` (new helper results, stored
and sent live) and in `applyAligned` (every cache read), so entries aligned before heal on their next
play with no GPU run and no `ENTRY_VERSION` bump; on a fixed entry it is a no-op. The thresholds: a 1.0 s
hold missed three "on my own" in Long Way Down (holds 0.73–0.83 s); a 0.6 s last word missed "at all"
in Damn (0.61 s); a 0.5 s hold also moved pairs the bench can't vouch for; on the bench 0.4 s moved a
Spanish "no no" wrongly until "no" left the list. The bench gives the same three moves from 0.6 to
1.0 s for the last word.

**Numbers.** JamendoLyrics, all words (aligned, rejected lines keep the estimate), new `aligned_as_shown`
row of the engine's bench.py: median 0.033 s, 87.2 % ≤ 0.1 s, 96.1 % ≤ 0.3 s, mean 0.084 s, before and
after; 3 words move, all closer to the annotation (1.22 → 0.10, 0.73 → 0.05, 0.81 → 0.07 s). Her
library (a copy of her cache, 2026-10-17, 90 aligned entries, 3,656 lines): 31 pairs of a word held
≥ 0.6 s before a short last word; 13 move (10 songs: "make it on", "on my own" ×4, "at all" ×4, "on us",
"on in" ×2, "we are"), 18 stay (a content word held: "hold on", "scream it", "mean it", "go away"; or
a phrase ending at the held word: "too, oh", "will, oh").

Not covered: a mid-line function word that takes a hold belonging to a later word (no rule could tell
it apart on the bench), and languages without a list (MMS).

## First-play onset (0.15.42)

Marcy's report on 0.15.41: LIVE, "The River" (Songs from Black Mountain), a new album: on the first play the
lyrics came in "way before the singer sings them". Her cache (a copy, 2026-10-17): Apple line timing, no
word timing; the aligned entry partial (sections 0 and 8 done). Apple's stamp vs the first sung word, line 1:
21.39 → 24.27 s (2.9 s early), line 2: 1.3 s, line 3: 2.7 s.

**The cause is not one offset.** Apple's stamps on this song run back to back (77 % of lines start where
the line before ends), and the singer comes in after a breath: the lead per line runs from −0.24 s (lines
0, 5, 7, 8 are on the stamp) to +2.88 s (line 1); median +0.77 s over the song, IQR 0.14–1.40 s. Ends are
closer (median −0.07 s). On a first play a section's lines show while that section is being heard, before
its own alignment, so section 0 shows at the stamps and section 8 with the onset learned from section 0.

**Why Level 1 didn't catch it.** It refines a line only after the line is sung (evidence to its end +
0.5 s), so never the line on screen; its word matching looks at most 1.0 s from the estimate and moves no
word more than `MAX_SHIFT` (1.0 s), so a 2.9 s lead is invisible to it; the learned onset needed 3 lines
and was capped at 1.5 s. Her cache has no learned (`refined|`) entry for this song at all. A line-level
voice-start detector from the Level 1 evidence was tried (first voiced segment with an onset after the
stamp): on JamendoLyrics with exact stamps it answered 31 % of lines with a median lead of +0.68 s instead
of 0, and it did not recover a synthetic 2.9 s shift; not taken (BACKLOG Idea "Per-line voice-start
detection").

**Change** (`lyrics-timing.js` `robustOnset`, used by `learnedOnset`): lines more than 3 × MAD (at least
0.25 s) from the median are dropped; the onset is the 0.45 quantile (a slight early bias: lyrics are noticed
about 0.33 s early vs 0.22 s late, Lizé Masclef, Vaglio & Moussallam, ISMIR 2021), but never more than the
25th percentile + 0.5 s (no overshoot: at most a quarter of the lines start their words more than 0.5 s
after the voice); cap 3.0 s (was 1.5 s; offsets of 2–3 s are real). `repace` moves an onset already showing
by at most 0.5 s per update (`ONSET_STEP`), so later sections refine it without the words jumping. The
song's onset is stored: `offset` (s, + = sung after the stamp) and `offsetSource` (`aligned` on the aligned
entry, `listen` on the learned entry), from 3+ lines; main sends it as `onset` in lyrics-data and the views
use it while fewer than 3 lines are aligned/refined (`repace` opts.onset). Precise word timing is never
touched. Linear drift was checked and not needed: the median change between a song's first and second half
is 0.00 s (3 of 92 songs over 0.5 s).

**Numbers** (`progressive`, first words per line unless said; asymmetric score = mean of early/0.33 +
late/0.22, lower is better). Her library: 93 songs, 24,349 words, 3,754 lines.

| set | median | mean | > 0.3 s late | > 1 s late | > 1 s early | asym. score |
|---|--:|--:|--:|--:|--:|--:|
| her library, before (all words) | 225 | 392 | 8.3 % | 2.2 % | 3.0 % | 1.01 |
| her library, after (all words) | 227 | 393 | 7.8 % | 2.2 % | 3.1 % | 1.00 |
| live songs, before → after (all words) | 281 → 284 | 423 → 427 | | | | |
| "The River", before | 576 | 809 | 32.1 % | 7.1 % | 28.6 % | 2.84 |
| "The River", after | 529 | 855 | 7.1 % | 0 % | 35.7 % | 2.46 |
| JamendoLyrics LRC (79 songs) | 93 | 243 | unchanged | | | |

The early-biased quantile without the guard measured "The River" 2.68 (28.6 % > 1 s early, 25 % > 0.3 s
late); the guard was kept (decided 2026-10-17: the asymmetric score favours it). A song-level shift cannot fix this song: what is left is
per line.

**Her library** (lines vs aligned starts, 93 songs): a consistent offset over 1 s in 2 songs, "Low"
(R.E.M., median +1.13 s, IQR 0.71–1.76) and "So Alive (Live)" (median +1.07 s, IQR 0.75–1.25); near it
Broadway (Live) +0.99, Stay (Wasting Time) +0.97, January Friend (Live) +0.83. Apple's stamps lead the voice
in almost every song (median +0.2 to +1.0 s), at the line's start rather than its end.

Not covered: per-line leads on back-to-back stamps before the line's own section is aligned.
