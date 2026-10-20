# Level 2: precise word timing from the audio (sonata-align)

Status: wired into Sonata in 0.15.21 as Settings → *Precise word timing (GPU, experimental)*
(align-session.js, align-helper.js; steps 1–6 of the integration plan below, without the in-app
installer, plain-lyrics mode and transcription; the plain-lyrics mode since 0.15.47 for LRCLIB's plain lyrics,
lyrics timed for another version and shorthand written out, see docs/LYRIC-TIMING.md "Lyrics that don't fit"). As built: recording runs only while a lyric view
is open (the lyrics window or, since 0.15.24, the visualizer, like Level 1; one shared parec for the
visualizer, Level 1 and Level 2), the song is aligned once its lyric span was heard
(≥ 90 %) via stream mode, so no audio file is ever written (since 0.15.33 progressively: each section of
lines is aligned while the song plays, then the whole song once more, see docs/LYRIC-TIMING.md).

**The helper is a separate download (since 0.15.45).** Up to 0.15.44 Sonata shipped the helper's Python
in `align/`. Now the helper is the Sonata engine, its own program with its own licence: a release
(`sonata-engine-X.Y.Z-linux-x86_64.tar.gz` on MarcelineVPQ/sonata-releases, tag `engine-vX.Y.Z`:
compiled modules for Python 3.14 (engine 0.2.1), an entry script, its venv recipe, its licence and third-party notices).
Sonata pins the one it wants in `align/engine.json` (version, protocol, file, URL, size, SHA-256, the
engine's Ed25519 signing key) and carries only the generic bootstrap (`align/install.sh`), the protocol
client (align-helper.js) and the session. Python file names below (sonata_align.py, server.py,
notes_step.py, ...) are the engine's; they are no longer in this repository (test/engine-boundary.test.js
keeps it that way). See "Install" below.
Level 1 (docs/LISTEN-SPEC.md) nudges estimated words toward onsets it hears. Level 2 finds where
each word is actually sung: it separates the vocals and force-aligns the KNOWN lyrics to them on
the GPU. A fallback mode transcribes songs that have no lyrics anywhere.

## Results in one table

79 CC-licensed songs (JamendoLyrics MultiLang: 20 English, 20 German, 19 French, 20 Spanish;
4.7 h, 3,383 lines, 21,580 words) with hand-annotated word starts. Sonata's input is simulated as
LRCLIB-style line starts, with no word timing. Error = |word start − annotated start|, over all words.
Lines the aligner rejects keep Sonata's estimate, as they would in the app.

| Word timing                                        | median | within 0.1 s | within 0.3 s | mean  |
|----------------------------------------------------|-------:|-------------:|-------------:|------:|
| Today: estimate (lyrics-timing.js), exact line starts | 0.170 s | 37 %       | 66 %         | 0.341 s |
| Today: estimate, line starts off by up to ±0.5 s      | 0.300 s | 18 %       | 50 %         | 0.429 s |
| **Aligned**, exact line starts                     | **0.032 s** | **88 %** | **97 %**    | 0.077 s |
| **Aligned**, line starts ±0.5 s                    | 0.033 s | 87 %        | 96 %         | 0.080 s |
| Aligned, line starts ±1.0 s                        | 0.033 s | 87 %        | 95 %         | 0.085 s |
| Aligned, 22.05 kHz s16 capture (Level 1 format), ±0.5 s | 0.033 s | 87 %   | 96 %         | 0.085 s |
| Aligned, no vocal separation, ±0.5 s               | 0.038 s | 79 %        | 90 %         | 0.159 s |
| Aligned, **plain lyrics with no timing at all** (accepted lines) | 0.032 s | 90 % | 98 % | 0.134 s |

- 95.5 % of the lines are accepted (confidence ≥ 0.2). The accepted lines alone have a median
  of 0.032 s, 90 % of words within 0.1 s and 98 % within 0.3 s.
- No systematic bias: the median signed error is −0.007 s, so no offset correction is needed.
- Wrong line starts barely matter: ±1 s of jitter costs about 1 point. The aligner finds the line
  itself; the anchor only bounds the search window.
- Unsynced (plain-text) lyrics can be fully synced. This turns "lyrics without timing" into
  word-synced lyrics.
- GPU speed: **2.6 s per song** on average (songs average 3.6 min, so about 80× real time). Of
  that, Demucs takes 2.0 s, the wav2vec2 pass 0.23 s and the Viterbi alignment 0.34 s. Loading
  the models cold takes 1.5 s. Peak VRAM is 2.7 GB (3.3 GB reserved).
- CPU (Ryzen 9 9950X3D): 33 s per song with all 32 threads; **75 s per song with 4 threads**
  (Demucs 44 s, wav2vec2 30 s). That's usable as "align after the song", just slow.

Blackwell / CUDA: fine. PyTorch 2.11.0+cu128 ships sm_120 kernels, so CUDA works on the RTX 5080
(driver 615). CTranslate2 4.8.3 (faster-whisper) also runs on it in float16.

Benchmark data: the synthetic bench in tools/listen-bench (Level 1) uses formant tones, not
speech. A speech model cannot read words from it, so it doesn't apply here. The JamendoLyrics
hand annotations are stronger ground truth than LRCLIB's `hasWordSync` data, which is itself
user-made and not available for these CC songs.

## Pipeline

```
PCM s16le (22.05/44.1 kHz stereo, file or streamed)                 lines [{t, end?, text}]
  -> Demucs htdemucs (vocals stem, GPU)                                       |
  -> 16 kHz mono -> wav2vec2 CTC log-probs (20 ms frames, 20 s chunks, fp16)   |
  -> ONE global Viterbi pass over the whole song  <---------------------------+
       tokens = every line's characters in order, a "garbage" token (*) between lines,
       each line's characters confined to [line.t − 1.5 s, next line.t + 1.5 s]
  -> per word: start = first frame of its first character, end = last frame + 1,
     confidence = mean peak probability of its characters
  -> per line: confidence = mean of its words; aligned = confidence ≥ 0.2
```

Why a single global pass and not one pass per line: a per-line pass let a repeated phrase
("and every whisper" / "and every beat") lock onto the previous line's audio. The global pass
keeps lines in order and stops them overlapping. Each window keeps a line near its anchor, and a
weak line can't pull its neighbours with it. The `*` token absorbs backing vocals and ad-libs
that aren't in the lyrics.
Lines without alignable characters (only digits or symbols) and lines below the confidence
threshold come back `aligned: false`, and Sonata keeps its estimate for them. Single words with no
alignable characters are interpolated between their neighbours (`interpolated: true`).

### Model choice (the default uses permissive licences only)

The language comes from the request, or a stopword/script guess from the lyrics (79/79 correct
on the bench).

| Language | Aligner (default)                                   | Licence | Size    | all-words within 0.3 s |
|----------|-----------------------------------------------------|---------|---------|-----------------------:|
| English  | wav2vec2 large-lv60k 960h (torchaudio `en`)         | MIT     | 1.26 GB | 94 % (MMS: 90 %)       |
| German   | jonatasgrosman/wav2vec2-large-xlsr-53-german        | Apache-2.0 | 1.26 GB | 99 % (MMS: 96 %)    |
| French   | …-xlsr-53-french                                    | Apache-2.0 | 1.26 GB | 94 % (MMS: 94 %)    |
| Spanish  | …-xlsr-53-spanish                                   | Apache-2.0 | 1.26 GB | 98 % (MMS: 96 %)    |
| it pt nl pl ru ja zh fi hu el fa ar | …-xlsr-53-<language> (not benchmarked) | Apache-2.0 | 1.26 GB each | – |
| others   | MMS_FA (1,100+ languages), **opt-in `allow_nc`**    | CC-BY-NC 4.0 | 1.26 GB | –            |

The permissive per-language models beat Meta's multilingual MMS_FA on every benchmarked
language. MMS stays an opt-in for languages that have no permissive model. Non-Latin scripts
would need romanisation (uroman) for MMS; that isn't implemented.

Separation: Demucs v4 `htdemucs` (single model, shifts=0, overlap 0.25). It raises
"within 0.1 s" from 79 % to 87 % and "within 0.3 s" from 90 % to 96 %, and it is essential for
transcription (see below). `htdemucs_ft`
would be about 4× slower for a small gain; not worth it here.

## Transcription fallback (no lyrics anywhere)

When Apple and LRCLIB both have nothing: Whisper large-v3-turbo (faster-whisper / CTranslate2,
fp16) transcribes the vocal stem, with VAD and word timestamps. The heard words are then
re-timed with the CTC aligner for the detected language (whisperX-style). Output has the same
shape, plus `text` per line, `source: "transcribed"` and per-word `conf` (Whisper's word
probability; `align_conf` when re-timed). **It can mishear, so the UI must label it.**

| Transcription (79 songs)         | WER   | en / fr / de / es WER        | language detected | word start, correctly heard words |
|----------------------------------|------:|------------------------------|------------------:|------------------------------------|
| vocals stem + CTC re-timing      | 24.8 % | 31.6 / 38.7 / 15.2 / 12.4 % | 78/79             | median 0.032 s, 90 % ≤ 0.1 s, 97 % ≤ 0.3 s |
| vocals stem, Whisper's own times | 24.7 % | same                        | 78/79             | median 0.112 s, 45 % ≤ 0.1 s, 84 % ≤ 0.3 s |
| full mix (no separation)         | 74.7 % | 79 / 73 / 73 / 73 %         | 59/79             | – |

- About one word in four is wrong (English and French are worst: slang, elisions, fast
  delivery). That's fine as a labelled "transcribed" fallback, never as a replacement for
  real lyrics.
- GPU: 4.4 s per song (separation 2.1 s, Whisper 1.6 s, re-timing 0.7 s).
- CPU: 73–442 s per song (int8, 32 threads). The worst case is Whisper looping on a song, so CPU
  transcription is not practical; offer it on GPU only.
- WER is measured against JamendoLyrics' normalised lyrics (accents and punctuation stripped on
  both sides), so it is slightly pessimistic for numbers and spelled-out words.

## Helper protocol (protocol 2)

The helper is spawned by Sonata (`<venv>/bin/python -u <home>/engine-X.Y.Z/main.py`) and speaks JSON
lines on stdin/stdout. Its pong carries `"protocol": 2` (none = 1, the helper shipped inside Sonata up
to 0.15.44); align-helper.js speaks 1 and 2 and refuses another with code `protocol` ("Update Precise
timing"). New fields are additive; both sides ignore what they don't know. stdout carries only
protocol messages; logs go to stderr. One job runs at a time and the rest queue. Models stay
loaded between songs; the alignment model is swapped per language and the separator stays loaded.

```
→ {"cmd":"ping"}
← {"type":"pong","version":"0.1.0","device":"cuda","gpu":"NVIDIA GeForce RTX 5080","models":{"htdemucs":true,"en":true,...},"whisper":{"turbo":false,...}}
→ {"cmd":"prepare","id":"p1","mode":"align","language":"de"}      download + load now (first run)
→ {"cmd":"align","id":"a1","lines":[{"t":12.3,"text":"..."}],"audio":{"path":"/run/user/1000/sonata/x.pcm","format":"s16le","rate":22050,"channels":2}}
→ {"cmd":"align","id":"a2","lines":[...],"audio":{"stream":true,"format":"s16le","rate":22050,"channels":2}}
→ {"cmd":"chunk","id":"a2","data":"<base64 PCM>"}   (repeat)   → {"cmd":"end","id":"a2"}
→ {"cmd":"transcribe","id":"t1","audio":{...}}                     optional "language"
→ {"cmd":"cancel","id":"a1"}      → {"cmd":"quit"}
→ {"cmd":"align","id":"s1","song":"s3","offset":27.0,"lines":[...],"audio":{"stream":true,...}}   a section: its stem is kept
→ {"cmd":"align","id":"f1","song":"s3","final":true,"lines":[...]}   the whole-song pass from the kept stems (no audio)
→ {"cmd":"forget","song":"s3"}   drop that song's kept stems (queued behind its jobs; no reply)
→ {"cmd":"separate","id":"g1","song":"s4","offset":27.0,"audio":{"stream":true,...}}   a section separated only (lyrics with their own word timing)
→ {"cmd":"notes","id":"n2","song":"s4","given":{"syllables":[...],"lines":[...]},"audio"?:{...}}   notes on the lyrics' own times
← {"type":"progress","id":"a1","stage":"download|separate|emissions|align|transcribe","p":0.42,"detail":"en 512/1262 MB"}
← {"type":"result","id":"a1","source":"aligned","lines":[{"line":0,"aligned":true,"confidence":0.61,
     "words":[{"t":12.41,"end":12.70,"text":"Hello","conf":0.72}]}],"stats":{"separate_s":2.0,...,"language":"en"}}
← {"type":"error","id":"a1","message":"...","code":"no-model"|"no-cache"|"low-vram"?}
```

**Separate once per song (0.15.38).** A section job with `song` and `offset` (where its slice starts,
on the 20 ms frame grid) keeps its vocal stem on the CPU (`SongCache`: float32 at 16 kHz, one song,
at most 20 min of audio). The `final` job without audio stitches the stems (overlaps cut at their
middle, unheard gaps silent and blank), runs wav2vec2 once more on the stitched stem, then the
Viterbi and the held notes: no second Demucs pass. If the stems are gone (another song, the helper
restarted, other models) it answers `no-cache`, and align-session.js sends the audio as before.
Reusing each section's own emissions instead was 2 ms worse in median, so the emissions run again
(0.3 s). Measured with tools/drift-check/section-bench.js on 12 JamendoLyrics songs: helper time per
song 5.74 → 3.41 s, the same words' error unchanged (median 42 → 41 ms, mean 75 → 77 ms, ≤ 0.1 s
81 % → 81 %).

**GPU budget (0.15.38).** In GPU mode torch uses at most 4 CPU threads (`SONATA_ALIGN_THREADS`, 0 =
torch's default; the CPU path is unchanged): its default (one thread per core) only spins while
Demucs waits for the GPU. After each job the allocator's cache goes back to the driver
(`torch.cuda.empty_cache`). Before each GPU job the free VRAM (`torch.cuda.mem_get_info`) must cover
the working set (1.8 GB) + any model still to load + a 1 GB margin (`SONATA_ALIGN_VRAM_MARGIN_GB`),
else `low-vram` and nothing runs. `SONATA_ALIGN_VRAM_FRACTION` hard-caps the process (benches).
the engine's bench.py, 6 English songs, before → after: CPU 66–71 → 31 s, wall the same (20.0 s), peak
VRAM 3184 → 3100 MB reserved, at rest 3184 → 1402 MB reserved (the helper process 3.5 → 1.7 GB in
nvidia-smi), accuracy identical.

**Gaming guard (0.15.38, game-guard.js).** Settings → *Pause word timing while gaming* (on by
default). While Feral GameMode has clients, a Steam game runs (`reaper SteamLaunch AppId=`), or
other processes keep the NVIDIA card > 30 % busy (`nvidia-smi pmon`; AMD: `gpu_busy_percent` > 50 %,
only without NVIDIA) for two checks in a row, Sonata records nothing for alignment, starts no job,
and the helper quits after its current one. Songs keep their estimate and Level 1; the sections
missed fill in on a later play (the partial entry). It resumes 30 s after the last signal. Checks
run at most every 5 s from the lyrics poll, only while there is alignment work or a pause. Signals
that aren't available (no GameMode, no nvidia-smi, Intel, Flatpak sandbox) are no-ops.

Optional fields on `align`/`prepare`:
- `language`: else guessed from the lyrics.
- `aligner`: a model name, to force one.
- `allow_nc`: lets MMS handle other languages.
- `separate: false`: about 5× faster and less accurate.

Model files download on first use with `progress` messages (`stage: "download"`), atomically
(`.part` + rename). After that, everything runs offline.
GPU is used when available. `SONATA_ALIGN_DEVICE=cpu` forces the CPU path, which also runs on
machines without NVIDIA (slow, see above). AMD/ROCm is not tested.

Files (engine): sonata_align.py (pipeline), server.py (protocol), the launcher, setup-venv.sh +
requirements.txt, bench.py, bench_transcribe.py, test_align.py (unit tests: Viterbi, windows, text,
language, PCM, protocol, holds, paths, GPU budget, stitching). In Sonata: `align/install.sh` (the
bootstrap), `align/engine.json` (the pin), test/align-install.test.js (the bootstrap's checks and path
choices), test/fake-align-helper fixtures (the protocol without the engine).

## Sung notes (developer log, experimental)

Settings → Precise timing → **Sung notes (developer log)**: shown only on the Development channel, off
by default, needs Precise word timing on. Groundwork for the +1 (live sheet notes); research and
scores in docs/research/notes-proto-results-2026-10.md on the research-gpu-pipeline branch.

**Flow.** The song's whole-song job (the final pass, or the only section of a one-section song,
offset 0) carries `"notes": true`. After its result has been sent, server.py keeps that job's vocal
stem (CPU, 16 kHz; the stitched sections or the separated song: no second separation), the aligned
lines and each character's first frame (`Aligner.last_char_first`), one song at most. Sonata
(align-session.js) then queues `{"cmd":"notes","id","song","syl"}` behind whatever waits, so the
alignment itself is never delayed; `syl` is lyrics-syllables.js's split of every word (the one the
views use). The helper (the engine's notes_step.py) runs RMVPE on the stem, times each syllable at the first
aligned frame of its letters, gates frames to within 35 dB of the stem's loud singing, calls
`notes.notes_from`, frees RMVPE and the allocator cache, and answers `{"type":"result","notes":{…}}`.
main.js adds the song's identity and writes the file (notes-log.js). Error codes: `no-stem` (nothing
kept for that song, e.g. the helper restarted), `no-model`, `low-vram` (needs 0.9 GB + the 1 GB
margin free), plus `checksum` for the download. Every outcome is the one status line under the
switch.

**The model's interface** (the engine's notes.py; the model is its sung_notes.py, vendored unchanged from
research `research/notes-proto/sung_notes.py` cfb48c7 (research-gpu-pipeline branch), numpy only, no I/O):

    notes_from(f0, times, conf, syllables, opts=None) -> dict
      f0, conf: RMVPE Hz and salience per 10 ms frame; times: frame times (s)
      syllables: [{t, end, text, line, word, syl, nsyl, word_text}], time-ordered
      opts: {'profile': 'stem', 'vthr': 0.7, 'loud': bool per frame, 'params': {...}, 'key': (pc, mode)?}
      -> {format 1, model, profile, params, duration_s, tuning, key, notes[{t, end, midi, cents, name,
          conf, syl_index, line, word, syl, melisma, cents_tuning?, octave_fixed?}], confidence, counts}

A newer model replaces sung_notes.py; notes.py, notes_step.py and the log format stay.

**Download.** RVC's `rmvpe.pt` (huggingface.co/lj1995/VoiceConversionWebUI, MIT), 181,184,272 bytes
(173 MiB, shown in Settings before), SHA-256 `6d62215f…ec193`, into `<helper home>/models/rmvpe.pt`,
only by `{"cmd":"prepare","mode":"notes"}`, which Sonata sends when the switch becomes active (on,
Development channel, Precise word timing on). A wrong size or checksum removes the part file.
The pong lists `"note_models": {"rmvpe": bool}`.

**Not in the helper.** S-KEY and Beat This! are not in its venv (and not tiny: Beat This! weights
~80 MB plus three packages), so there is no key model and no beats or bars: the key is
Krumhansl-Schmuckler on the notes (`source: "ks-notes"`; the melody alone can't tell relative keys
apart).

**The log.** `~/.local/share/apple-music-for-linux/notes-log/<yyyymmdd>-<artist>-<title>.json`
(XDG_DATA_HOME when set outside an app sandbox), format 1: `song` {title, artist, album, duration,
appleId, isrc (0.15.42; null when Apple gave none)}, `sonata` (version), `models` {f0, notes, aligner, params, vthr}, `tuning`, `key`, `lines`,
`syllables`, `notes`, `confidence`, `stats`. No audio, no stem, no pitch frames (notes-log.js
`validateDoc` refuses them). Written atomically (temp file + rename, mode 0600); at most 1000 files,
the oldest removed. About 110 kB per song.

**Judging a live track.** The engine's notes-log.py tool (`python3 notes-log.py <file>` in the
engine repository's tools; it moved there with the note model it imports) prints the notes per lyric line ("line
text:  E4 F♯4–G4 …", – joining a melisma) and the same word by word; `--png <picture>.png --t0 34 --dur 25`
draws the research prototype's staff view (system Python with matplotlib).

**Cost (RTX 5080, two JamendoLyrics songs, 3:37 and 4:00, stitched final pass).** The notes job takes
1.1 s wall: RMVPE load 0.27 s, f0 0.36–0.42 s on the GPU, the note model 0.41–0.46 s on the CPU.
Extra VRAM while it runs about 0.6 GB (2.0 GB process peak with the alignment models resident).

Files (engine): notes_step.py (the step, the download), notes.py (the interface), sung_notes.py (the
model), rmvpe.py (the network, RVC's code, MIT; mel filters from torchaudio), test_notes.py (synthetic
voice, syllables, download and checksum, protocol; `SONATA_TEST_RMVPE=<rmvpe.pt>` adds a real RMVPE
run), the notes-log.py tool. In Sonata: notes-log.js, test/notes-log.test.js.

## Sheet notes in the Studio (experimental)

Settings → Experimental graphics → **Sheet notes in the Studio (experimental)**, off by default, needs
Precise word timing on; the Studio's **Sheet notes** tile is the same switch. Sonata's +1: the sung
melody in a band above the Studio's lyrics, on the lyrics clock (Marcy's decisions 2026-10-16/17,
docs/research/live-sheet-notes-2026-10.md on the research-gpu-pipeline branch).

**What it shows** (sheet-notes-model.js `mode()`):
- **First play: a pitch line.** Right after each section's words come back, align-session.js asks
  the helper for that section's pitch line (`{"cmd":"pitch","id","song","offset"}`, from the stem the
  song cache kept for the section: no second separation). It runs inside the section's job, so later
  jobs keep their order, only while the Studio shows the band, and never while a game runs. The line
  is 20 values a second (MIDI × 10, 0 = no voice), drawn from the right edge back (the band shows the
  last ~14 s): it follows each section by about the section's length, because a section is separated
  only once it has been heard. While the part at the playhead has no line yet (so the staff between
  the heard line's end and the playhead is empty), the band's label row says "Listening and
  learning" with a small blinking green dot (`--s-live`), a second one on the staff at the playhead
  (sheet-notes-model.js `listening`; the ⓘ: the line for this part appears once Sonata has heard it). It
  stops when the part's line arrives, past the lyrics' end, while paused for a game or on an error.
  The client draws it continuous through a phrase (sheet-notes-model.js `cleanPitch`, `LINE`): dropouts
  up to 250 ms are bridged in a straight line in MIDI (log frequency) unless the voice lands more than
  7 semitones away, a value 9.5–14.5 semitones off its ±250 ms median is folded back an octave, a lone
  value over 2 semitones off both neighbours is smoothed, and specks under 60 ms are dropped. Measured
  2026-10-18 on helper output (JamendoLyrics Cortez – Feel (Stripped) through RMVPE on CPU, eleven cached
  songs): 60 % of the helper's gaps were 50–200 ms inside phrases; the drawn runs drop 2–4x (median run
  0.3–0.5 s → 0.6–2.8 s), and the gaps left are pauses of 300 ms and more where RMVPE's voicing is ~0.
- **Later plays: notes on a staff.** The whole-song job's notes step (the same as the developer log's)
  also returns the song's pitch line; main caches notes, syllables, key and line per song
  (sheet-notes-store.js, `~/.config/apple-music-for-linux/sheet-notes/`, one ~20–40 kB file per song,
  at most 500, least recently used out first) and sends them with the song once the lyrics on screen
  are the aligned ones. A song aligned before the switch was on (a complete cache entry, no notes) is
  recorded once more and aligned as a whole for its notes (`missing()`); a failed notes step is tried
  again at most twice (`no-model` waits for the switch's download).
- **Lyrics with their own word timing** (Apple's word/syllable lyrics, enhanced LRC; most popular
  songs): never aligned, so at first they had no stem and no notes. With Sheet notes on and no
  notes cached for these lyrics (sheet-notes-store.js `missing()`), the song is recorded the same way
  (one `parec`, only while a lyric view is open) and each section is only separated
  (`{"cmd":"separate","id","song","offset","audio":{stream}}`: Demucs, the stem kept in the song cache
  under its own key; no alignment model is loaded), then its pitch line is asked as above. Once the
  song was heard to the end, `{"cmd":"notes","id","song","given":{"syllables","lines"}}` works out the
  notes from the kept sections (stitched; or, when a section wasn't kept or the helper lost them
  (`no-stem`), with the song's audio streamed and separated once) on the syllable table Sonata sends:
  align-session.js `givenSyllables`, each lead-vocal word's syllables as the views pop them (Apple's own
  `syl` times, else lyrics-syllables.js's split of the word's own [t, end]; background vocals left out).
  The helper (notes_step.py `run_given`) runs the same RMVPE + note model as for an aligned song; the
  notes are cached in the same store and format (title|artist file, the lyrics' hash), so the next play
  shows the staff on the lyrics' own clock (`mode()` takes `wordSynced` like `aligned`). Nothing goes into
  the lyrics store. Left before its end (a skip, the view closed, a seek past part of it): no notes this
  time, the jobs still queued are skipped and the kept sections forgotten; the next play tries again.
  One job at a time, the VRAM checks (separation: the alignment's working set + Demucs + the margin;
  the notes: as below), the gaming guard and the one-helper rule are the same as for aligned songs.
  Measured 2026-10-18 (RTX 5080, the real helper driven by align-session.js, Cortez – Feel (Stripped),
  4:01, its JamendoLyrics word annotations standing in for Apple's times): 6 sections separated and
  their pitch lines, then the notes from the stitched sections, 7.7 s wall in all (model loads
  included); the notes step RMVPE load 0.23 s, f0 0.31 s, note model 0.44 s; 363 notes on 368
  syllables, E major, spread 4 cents (all notes); the helper's peak about 1.9 GB of graphics memory.
- **Nothing to draw:** one line says why (no helper, Precise timing off, no line timing, paused for a game).

**The label row** (above the staff): the **Experimental** chip, the label (Notes · key, First play ·
pitch line; a message has none, so nothing repeats the chip), the message and the placement buttons. It
follows the DS5 app's rule for long text (Marcy 2026-10-18): the visible text says only what you must
know, at most 60 characters (`TEXT_MAX`), and the row wraps onto a second line when the column is
narrow, never cutting words off; a longer explanation sits behind an **ⓘ** beside it (`info`: shown on
hover or keyboard focus, a click toggles it, Esc closes it; screen readers get it as the ⓘ's
description and in the band's name). A long error from main keeps its part before the first ": " on
screen and the whole sentence behind the ⓘ (`fit()`).

**The staff** (`layout()`): each note at its spelled pitch (the note model's line-of-fifths name), as
long as it was held (no rhythm quantising), the key signature (K-S on the notes: the helper has no
key model, so relative keys can be confused, see below), accidentals where a note differs from the
key (no bars carry them), ledger lines, the clef that keeps the most singing on the staff (treble,
treble 8vb or bass), the syllable under its first note (a hyphen to the next syllable, an extender
under a melisma; notes without a syllable drawn dim), bar lines when beats exist (none yet: no beat
model in the helper), a playhead at 30 %. The clefs and accidentals are Noto Music outlines
(sheet-notes-glyphs.js, SIL OFL 1.1, licenses/NotoMusic-OFL.txt), so they look the same on every system.

**Placement** (Settings → Lyrics & Studio → Placement, remembered; the band's two buttons switch it;
`placement()`): **Band on top** (the band under the Studio's header) or **Over the sung line**: the sung
line (or the countdown standing for it) opens 136 px of room above itself (lyrics-view.js `opts.room`:
class `.room`, a transparent top border, so no other line's text moves into it; the lines in view slide
to their new places by FLIP on the compositor), and the staff (label row with the buttons, the staff
without its syllable row: the words are right below) sits in that room, inside the lyrics list so it
scrolls with the lines, moving to the next line by one 300 ms transform animation (none with reduced
motion). The sung line, room and all, is centred on the engine's anchor (a third of the way down). A
message (nothing to draw) always stays in the band.

**Honest confidence** (`gate()`): a note's `cents` is how far it sits from the nearest semitone in the
song's own tuning. Sung melody clusters near the grid; rap and speech spread evenly (median ≈ 25).
Each lyric line (and the notes between lines) is judged on its notes, pooled with those within 4 s
when it has fewer than 4: duration-weighted median |cents| ≤ 20 and confidence ≥ 0.6 → notes. In a song
judged sung, a lyric line past 20 cents still shows notes unless it is rapped (faster than 4.4 syllables
a second) or extreme (past 40 cents: the nearest semitone is a coin flip); notes between lines keep the
20-cent rule. Else the pitch line there (or nothing without one), and the band's label says "pitch line
here: notes unsure". Recalibrated 2026-10-19 on 36 learned songs: per line (~10 notes) sung scoops and
vibrato reach 22–38 cents (Radiohead "15 Step": 2.7–3.2 syllables a second), the same spread as Wilson
Way's rapped verses (23–40 cents, 4.6–7.5 syllables a second); the delivery is what tells them apart.
A whole song past 22 cents (or below 0.6) is the pitch line throughout. Measured 2026-10-17 with the
real helper (Demucs → alignment → RMVPE → note model) on JamendoLyrics songs, and on Marcy's
developer-log files (notes only):

| Song | Kind | Song spread (cents) | Shown as notes | Pitch line |
|---|---|---|---|---|
| Cortez – Feel (Stripped) | sung | 5 | 100 % | 0 % |
| Rxbyn – Bad Side | sung | 4 | 100 % | 0 % |
| Lower Loveday – Is It Right | sung | 9 | 97 % | 3 % |
| Wilson Way – Te Recuerdo | rapped verses, sung chorus | 7 | 75 % (the chorus) | 25 % (the verses) |
| Wordsmith – The Statement | rap | 24 | 0 % | 100 % |
| Jason Miller – Crowd Pleaser | rap | 25 | 0 % | 100 % |
| Cortez, simulated live (reverb, noise, two out-of-tune "crowd" copies) | sung | 7 | 98 % | 2 % |
| DMB studio songs (log files) | loose, slid vocals | 10–19 | 53–90 % | the rest |

**Cost** (helper, RTX 5080): a section's pitch line 0.27–0.51 s (RMVPE load + f0), the notes step as
for the developer log (~1.1 s per song), +0.6 GB VRAM while either runs. The band: docs/PERFORMANCE.md.

**Known limits:** the key is guessed from the notes (Rxbyn: G major for the research's G minor;
Cortez: E major for F♯ minor), so a key signature can be the relative or a neighbour; songs with
Apple's own word timing get notes only when they are heard to the end in one play, and their syllables
are Apple's own only where Apple timed syllables (else the views' estimated split of each word); the
first play's line trails a section behind.

## Install

**From Settings.** Settings → Precise timing has a *Helper* row: its state in a few words
("Not installed", "Installed: helper 0.2.1, Python 3.14, NVIDIA RTX 5080", "Update available: 0.2.2",
"Needs an update", "Needs a repair: …", "Installing… step 3 of 7"), the longer words behind its ⓘ, and only
the buttons that do something now: Install, Update, Repair, Remove…, or Cancel while a job runs. Main runs
the same `align/install.sh` a terminal would (helper-installer.js; in the AppImage from
`app.asar.unpacked/align/`, so nothing has to be extracted), with `--progress`:

1. `--licence-only`: the engine is downloaded and checked (size, SHA-256, signature), kept in
   `<home>/.download`, and its EULA.md is shown in the page (scrollable; *Accept and install* / *Cancel*).
   The SHA-256 of the accepted text is remembered (`settings.alignLicence`); the next update asks again only
   when the text changed.
2. `--licence-sha SHA --prune`: the install, accepting exactly that text (another text is refused). Its
   `@@sonata {json}` lines and the pip lines of setup-venv.sh (with `PIP_PROGRESS_BAR=raw`: "Progress N of
   M"; uv prints a line per big package) become the progress: the step, one bar weighted by how long each
   step takes, and bytes (the download, pip's per-package bytes, the new venv's size on disk every 2 s).
3. The models, when the install has none yet: the helper's own `prepare` (Demucs + the English aligner,
   1.35 GB; other languages download on first use), with its download progress.

Cancel stops the installer's whole process group. A failure says what happened and what to do
(helper-install-model.js `failText`: no network, a refused download, no Python 3.14, no space, a helper that
doesn't start). While a job runs the helper is stopped and nothing is aligned. Remove… asks in the page and
keeps the downloaded models unless unticked (`install.sh --remove [--delete-models]`: only the helper's own
files; anything else in the folder, such as bench songs, stays). A fresh install turns Precise word timing on.

**The installer** (`align/install.sh`, the one installer):

1. picks the home (below) and reads `align/engine.json` (the minimum engine and the trusted key), or
   `--pin FILE` (an engine from the feed, same form): its key must be engine.json's, its protocol one this
   Sonata installs (`PROTOCOLS`, = engine-feed.js `INSTALL_PROTOCOLS`), its version at least engine.json's and
   not older than the active engine (no downgrade); https addresses only (`--from` also takes a local folder
   or a loopback address);
2. downloads the release file and its `.sig` (`--from DIR|URL` for a mirror or a local copy), and refuses
   it unless its size, its SHA-256 and its Ed25519 signature (OpenSSL 3, the key in the pin) all match, and
   its ENGINE.json names that version and a protocol it installs;
3. prints the helper's EULA.md, its licence, and installs only after "yes" at the terminal
   (`--accept-licence` for scripts, `--licence-sha` for Settings; with no terminal and neither it stops);
4. unpacks it into `<home>/engine-X.Y.Z/` (stamp `.installed`: SHA-256, the licence's SHA-256 and when it was accepted);
5. unless the engine's recipe says the venv is up to date (`setup-venv.sh --dry-run`), checks the free space
   (12 GB for the GPU build: the venv plus pip's wheels, which go to `<home>/.staging/tmp`, not `/tmp`), runs
   the engine's own setup-venv.sh into `<home>/.staging` (Python 3.14, torch 2.11 from the PyTorch index,
   the variant the venv had: `--cpu` for CPU wheels), points the new venv's links and scripts at the home,
   and pings the engine in it (`sonata-align --check`);
6. moves the old venv aside, the new one in, pings again (a failure puts the old one back) and only then
   writes `<home>/active-engine`: the switch. `--prune` deletes the venv it replaced and older engines.
   A failed or cancelled run (its traps) leaves the working install as it was: the staging, a newly unpacked
   engine that never became active and a half-done switch are undone.

**Builds (GPU backends).** Settings → Precise timing → *Build for* (`settings.alignBackend`: auto | cuda |
rocm | xpu | openvino | cpu). `gpu-detect.js` reads `/sys/class/drm/cardN/device/{vendor,device,class}` (0x10de NVIDIA,
0x1002 AMD, 0x8086 Intel; amdgpu's `mem_info_vram_total` < 4 GiB = an integrated GPU; Intel Arc = device ids
0x5690–0x56cf, 0xe200–0xe2ff) and `lspci -mm -nn` for names (and as the fallback without sysfs). Auto: an
NVIDIA card → cuda, else a discrete AMD card → rocm, else an Intel Arc card → xpu, else Intel integrated
graphics → openvino, else on an Intel processor (`/proc/cpuinfo` GenuineIntel) → openvino, else cpu. Install and
*Rebuild for …* make the chosen build; Update and Repair keep the installed one (the venv stamp's variant), except
that on Auto an Update moves Processor only to OpenVINO when Auto picks it. **OpenVINO** (0.15.65, engine 0.2.6):
the CPU wheels plus OpenVINO (no telemetry package); the engine converts its networks on this machine at the first
job (models/openvino, ~1.8 GB) and runs them on an Intel GPU (FP16) else the CPU (FP32, word times identical to
PyTorch, measured 1.5× as fast). The pong keeps `device: cpu` and adds `backend: openvino`, `openvino: {device,
name}`. The 0.15.59 processor-only protections stay (priority, cores free, quits sooner); first plays are timed
after the song until `helper-speed.js` has measured that the helper on Intel graphics keeps up (median of the last
3 jobs' work seconds per audio second < 1), then section by section like a GPU machine (logged as "helper speed: …").
`install.sh --backend B` passes `--backend B` to the engine's setup-venv.sh when its ENGINE.json lists B in
`"backends"` (engine 0.2.2 on), else `--gpu` / `--cpu` (cuda / cpu only; rocm and xpu fail with code
`backend`, said in Settings). The PyTorch 2.11.0 indexes: cu128, rocm7.2 (the wheels carry the ROCm runtime;
kernels for gfx1030, gfx1100–1102, gfx1150/1151, gfx1200/1201 and data-centre parts; the system needs the
amdgpu driver and /dev/kfd access), xpu (Intel's runtime from the same index) and cpu. Measured 2026-10-18
(Python 3.14, pip): cuda 3.9 GB download / 7.3 GB venv, rocm 6.5 / 15 GB, xpu 2.7 / 8.1 GB, cpu 0.3 / 1.3 GB.
In the engine, every GPU call goes through `sonata_align.accel` (ROCm answers through torch.cuda, Intel through
torch.xpu), a device must pass one small test computation before it is used, and the pong carries `backend`,
`build` and, for a GPU build without a usable card, a `message` (it runs on the CPU; Settings says so).
**ROCm and XPU are untested on real AMD/Intel cards**: both builds were installed from the real indexes and
pinged on a machine without such cards (GPUs hidden), and fell back to the CPU with that message.

**Engine updates without a Sonata release.** engine-feed.js reads latest-engine.json (Stable) or
latest-engine-dev.json (Development, else Stable) from MarcelineVPQ/sonata-releases main, signed with the
engine key (the one in engine.json, Ed25519 over the exact bytes, `<file>.sig`, the scheme of Sonata's own
feeds; the Development one is live since 2026-10-18, a missing Stable one means "no stable engine yet").
Fields (a superset of engine.json): `channel`, `name`, `version` (X.Y.Z, or X.Y.Z-dev.N on the Development
channel only), `tag`, `prerelease`, `protocol`, `python`, `platform` (linux-x86_64), `file`, `url` (must be
the engine release's), `size`, `sha256`, `sig` (the download's own signature, base64), `key` (must be the
trusted one), `licence` `{ version, sha256 }` (the downloaded EULA must have that SHA-256; a new licence
version or text is asked again, `settings.alignLicenceVersion`), `released`, `notes_url`, optional
`min_sonata` / `max_sonata`. Sonata accepts any engine whose protocol it installs, at least engine.json's version and inside the
min/max range: engine.json is the minimum, not the only engine. Checked 25 s after start, every 6 h and when
Precise timing opens (at most every 30 min), only with *Check for updates automatically* on; Settings,
the section header and the rail then say "Helper update available". align-helper.js runs the engine named
in `<home>/active-engine` when its protocol is one it speaks and it is at least the pinned version, else
the pinned one. *Update the helper automatically* (off by default) installs a newer one by itself, once
per version, when nothing is being aligned; a changed licence is still shown first. For tests:
`SONATA_ENGINE_FEED=http://127.0.0.1:PORT/` (loopback only) with `SONATA_ENGINE_PUBKEY` (a test key for the
feed; the download is still checked against engine.json's key).

Updating from a terminal = running `align/install.sh` again (or with `--pin`); only a few MB download
unless the requirements changed. `SONATA_ENGINE_DIR` points Sonata at an unpacked engine or an engine
checkout instead (engine work only). Sonata's CI never downloads the engine: its tests use the fake helper,
stand-in engines (test/align-install.test.js) and a fake installer (test/helper-install.test.js).

**Never lost to a quit, a crash or a power cut** (0.15.56). While a job runs, every way out of Sonata asks
first (`quit-guard.js`: tray Quit, closing the window, Restart now; an update's Restart now waits). Main keeps
`<userData>/helper-job.json` (kind, step, the engine's pin, licence and build) while the job runs and removes it
when the job ends by itself; at the next start a marker left behind resumes the job (at most 3 tries). The
engine's download continues in `<home>/.resume` (curl `-C -`), the models' in `.<file>.part-sonata`
(`model-fetch.js`: the engine's own model list, HTTP Range with If-Range, then size and SHA-256), and
`install.sh` holds `<home>/.install.lock` and clears what a killed run left (staging, temporary folders, a venv
moved aside). Measured 2026-10-19 (CPU build, live feed): killed at 702 MB of the English aligner, the restart
continued at 701 MB (1 MB back) and fetched only the remaining 561 MB, SHA-256 checked; a Repair killed while
PyTorch installed left the old venv answering, and the next start finished it.

## Install footprint

Everything lives under `~/.local/share/sonata-align/` (`SONATA_ALIGN_HOME` overrides it;
`$XDG_DATA_HOME/sonata-align` only when XDG_DATA_HOME is not inside another app's sandbox). Nothing
is installed system-wide.

**The venv's Python (0.15.38; Python 3.14 only since 0.15.45).** A venv's `bin/python` is a link to the
interpreter it was made from. The engine's setup-venv.sh builds it from the pinned Python, 3.14 (`SONATA_ALIGN_PYTHON`
overrides), never one under `~/snap`, `/snap`, `~/.var/app` or an AppImage mount; without a system 3.14
uv downloads one into `<home>/python`. The first install came from the Codium
snap's terminal: uv put Python in `~/snap/codium/495/` and the snap set XDG_DATA_HOME there, so a
snap refresh would have broken Precise timing. Sonata checks the install at start and when
Settings asks (align-helper.js `checkInstall`): a dangling or sandboxed python gets a notice in
Settings → Precise timing and the rail says "Helper needs a rebuild". The fix is Repair there (or
`align/install.sh --rebuild` from a normal terminal): a new venv is built aside and switched in only once
the engine answers in it; the models stay.

| Part | Size |
|---|---|
| venv (Python 3.14, torch 2.11 cu128 + CUDA libs 4.2 GB, triton 0.6 GB, demucs, transformers, faster-whisper) | 7.1–7.3 GB |
| CPU-only venv (`install.sh --cpu`, estimate) | ~1 GB |
| htdemucs | 84 MB |
| aligner per language (en / xlsr-xx / mms) | 1.26 GB each |
| Whisper large-v3-turbo (transcription only) | 1.62 GB |
| RMVPE (Sung notes developer log only) | 181 MB |
| **Typical user** (venv + Demucs + English + one more language) | **≈ 9.7 GB** |
| uv's wheel cache (`~/.cache/uv`, can be cleared after install) | ~6.5 GB |

Runtime: 3.1 GB VRAM peak while aligning, 1.7 GB at rest with the models loaded (0.15.38); the GPU is idle between songs. The helper should exit
when idle (see the integration plan) so the VRAM is freed.

## Licences

Sonata is GPL-3.0. Nothing below is bundled into Sonata. The user's own install downloads it.

| Component | Licence | Notes |
|---|---|---|
| the helper (the Sonata engine, ours) | its own licence, shown at install | separate program and download; the copies shipped in Sonata up to 0.15.44 stay GPL-3.0 |
| PyTorch / torchaudio | BSD-3 / BSD-2 | |
| NVIDIA CUDA/cuDNN wheels | NVIDIA EULA (redistributable runtime) | pulled by pip, not by us |
| Demucs code + htdemucs weights | MIT | |
| wav2vec2 large-lv60k-960h (torchaudio) | MIT (fairseq) | trained on LibriLight / LibriSpeech (public-domain audiobooks) |
| jonatasgrosman XLSR-53 fine-tunes | Apache-2.0 | Common Voice data (CC0) |
| MMS_FA | **CC-BY-NC 4.0** | opt-in only (`allow_nc`), never the default |
| transformers / huggingface_hub | Apache-2.0 | |
| faster-whisper / CTranslate2 | MIT / MIT | |
| Whisper large-v3-turbo weights (+ CTranslate2 conversion, dropbox-dash, formerly mobiuslabsgmbh) | MIT | |
| RMVPE network code (RVC, the engine's rmvpe.py) + rmvpe.pt weights | MIT | Sung notes developer log only |
| onnxruntime (Silero VAD inside faster-whisper) | MIT (VAD model MIT) | |
| soundfile (libsndfile), PyAV (FFmpeg) | BSD-3 (LGPL-2.1 libs, dynamically linked) | |
| Bench songs (JamendoLyrics) | CC BY / BY-SA / BY-NC / BY-ND / … per song | kept only in `~/.local/share/sonata-align/bench/`, unmodified, never in the repo; used only for local measurement |

The default path (permissive aligners + Demucs + Whisper) is fully OK for a free open-source app.
MMS would make "commercial use" of the feature questionable, which is why it stays opt-in and
labelled.

## DRM and privacy note

- Audio comes only from Sonata's own playback stream, via the Level 1 listener (its own sink
  input, never the system mix or a microphone).
- It is analysed locally on the user's machine. Nothing is uploaded; the only network traffic is
  the one-time model download.
- Song audio is never stored beyond the run. If the full song has to go through a file, it is a
  0600 file in `$XDG_RUNTIME_DIR` (tmpfs), deleted when the result arrives. The stream mode avoids
  a file entirely.
- Only the timings (numbers and the lyric words Sonata already had) are cached.
- Sonata does not decrypt, rip or export anything. It analyses what it is already playing, like
  the visualizer does.

## Integration plan for Sonata

1. **Setting** "Precise word timing (GPU, experimental)", off by default. Description: "Separates
   the vocals and lines up each word with the singing, on this computer. Needs a one-time download
   of about 3 GB (more for other languages) and works best with an NVIDIA GPU." Below it, a status
   line from `ping`: GPU name or "CPU only, slow"; models downloaded or not; an "Install / Remove"
   button that runs `install.sh` and later `prepare` with progress. A second toggle, "Transcribe
   songs without lyrics (may mishear)", is greyed out without a GPU.
2. **Helper lifetime** (main.js, AVIEW verdict comments): spawn `align/sonata-align` on demand
   when there's a job. It is one child process. Send `quit` after 10 minutes idle while a lyric view
   (lyrics window, Studio, visualizer) is open and 2 minutes when none is (0.15.42; it holds ~1.8 GB of
   VRAM idle; align-helper.js `IDLE_MS` / `WARM_IDLE_MS`), at once when a game starts (gaming guard),
   and kill it on app quit. If it crashes, show a log line plus a status in Settings, and
   don't respawn more than once per song.
3. **Capture**: reuse the Level 1 listener (`audio-listen.js`, 22.05 kHz s16 stereo; the bench
   shows no accuracy loss vs 44.1 kHz). main keeps a song-time-indexed buffer (≈ 88 KB/s, 21 MB for
   4 min). Chunks are placed by song time via the lyrics clock, and gaps from seeks or pauses are
   filled with silence and marked uncovered.
   - **Align after the first play**: when the track ends (or ≥ 90 % of the lyric span is covered),
     stream the buffer to the helper (`audio.stream`) and drop it.
   - Lines in uncovered spans come back unaligned and keep their estimate, or the helper is only
     given covered spans.
   - **Progressive** (later): align each 30–60 s section as it completes. The global pass works
     per section with the section's lines; about 1 s each on the GPU.
4. **Apply + cache**:
   - Store the result in lyrics-store as `aligned|isrc:<ISRC>` (`aligned|title|artist` when the ISRC
     is unknown; recording-id.js, 0.15.42) with `{version, model, lyricsHash, duration, lines}` plus the
     recording's `songDuration`, `isrc`, `appleId`; an entry whose `songDuration` differs from the
     playing song's by more than 1.5 s is not used.
   - Since 0.15.42 an entry also keeps, for About → For the Curious (curious-model.js): `engine` (the
     sonata-align version), `firstAt` / `lastAt` (ISO dates of the first and latest job), `workS` and
     `device` (the helper's separation + emissions + alignment seconds, summed over the song's jobs; left
     out once an older job's seconds are unknown) and each line's `conf` (the helper's confidence, 0..1).
   - Words of aligned lines replace the estimate; unaligned lines keep it.
   - The lyrics hash invalidates the entry when the lyrics change.
   - If the song is still playing, send it live like `lyrics-refined`.
5. **Preference**:
   - Apple word timing (never touched) > `aligned` > `refined` (Level 1) > estimated.
   - Unsynced plain lyrics plus audio become word-synced via the `plain` mode (no anchors).
   - No lyrics at all and the transcribe setting on: `transcribed|title|artist`.
6. **Notes line** in the lyrics window: "Word timing aligned to the vocals on this computer".
   For transcribed lyrics: "Transcribed from the audio — may contain mistakes".
7. **Flatpak**:
   - A 7 GB CUDA venv cannot be part of the Flatpak.
   - Option A (recommended): the in-app installer creates the venv inside the sandbox's data dir
     (`~/.var/app/<id>/data/sonata-align`), with uv as a downloaded binary. This needs a Python ≥ 3.10
     runtime (the org.freedesktop.Platform has one) and `--device=all` for `/dev/nvidia*`. CUDA's
     `libcuda.so` comes from the org.freedesktop.Platform.GL.nvidia extension. The installer must
     check that the extension's driver version matches the host's.
   - Option B: a host install plus `flatpak-spawn --host`. This needs
     `--talk-name=org.freedesktop.Flatpak`, which Flathub review dislikes.
   - AUR/tarball builds have no issue: they spawn the script directly.

## Open questions

- **CPU-only users**:
  - 75 s per song on 4 threads works but heats laptops. Should CPU mode be offered at all, or
    only "align when plugged in and idle"?
  - A `separate:false` CPU mode is about 5× faster, with less accuracy (no-separation numbers in
    the first table).
- **Install size**: a 7 GB venv is heavy for a music player. Options:
  - a CPU-only venv for non-NVIDIA machines (~1 GB);
  - ONNX/TensorRT exports of Demucs + wav2vec2 to drop torch (a big project);
  - sharing one venv with other apps (no).
- **AMD/Intel GPUs**: ROCm torch wheels exist; untested.
- **Languages without a permissive aligner** (Korean, Hindi, …): ship MMS opt-in with a clear
  "non-commercial model" note, or leave them unaligned.
- **Capture coverage rules**: how much of a song must be heard before aligning? What happens if
  the user skips around?
- **Confidence threshold**:
  - 0.2 was chosen from the bench: lines at 0.20–0.25 still have 96 % of words within 0.3 s.
  - Below 0.05 the median is still 0.09 s, but the tail is long.
  - The UI could fade words by confidence instead of a hard cut.
- **Held-note ends**: CTC gives word starts well; word ends (the "word draws" for held notes) come
  from the last emitting frame and are less reliable. The bench couldn't measure them, because
  JamendoLyrics word ends are mostly the next word's start. Level 1's voiced-segment detection
  could extend them.
- **Background vocals** and Apple's `bg` lines: these are not aligned separately yet. The `*`
  token absorbs them.
- **Transcription**: is a ~25 % WER good enough to show at all? Maybe only with a "help improve:
  submit to LRCLIB" flow after the user corrects it.

**Held notes (0.15.34):** after the Viterbi pass, `extend_holds` lets each word's end follow the separated vocal stem while it stays loud (`hold_db` 24 dB below the song's loud singing, 15 dB above its quiet frames, `hold_gap` 4 frames, `hold_max` 8 s, never past the next word − 0.04 s). Words extended by ≥ 0.2 s carry `held` and `hold_from`. `--param hold=0` turns it off (the bench's "before"). Numbers: docs/LYRIC-TIMING.md "Held notes".

**Hold attribution (0.15.41):** the CTC path puts a held line-final word on its last letters, so `extend_holds` can give the hold to the function word before it ("make it o—n"). Sonata moves such holds back (lyrics-timing.js `reattributeHolds`, on helper results and on cache reads); the helper output is unchanged. the engine's bench.py stores word starts and `hold_from` and scores the words as Sonata shows them (`aligned_as_shown`). docs/LYRIC-TIMING.md "Hold attribution".
