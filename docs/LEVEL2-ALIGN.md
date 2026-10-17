# Level 2: precise word timing from the audio (sonata-align)

Status: wired into Sonata in 0.15.21 as Settings → *Precise word timing (GPU, experimental)*
(align-session.js, align-helper.js; steps 1–6 of the integration plan below, without the in-app
installer, plain-lyrics mode and transcription). As built: recording runs only while a lyric view
is open (the lyrics window or, since 0.15.24, the visualizer, like Level 1; one shared parec for the
visualizer, Level 1 and Level 2), the song is aligned once its lyric span was heard
(≥ 90 %) via stream mode, so no audio file is ever written (since 0.15.33 progressively: each section of
lines is aligned while the song plays, then the whole song once more, see docs/LYRIC-TIMING.md), and the helper is the user's venv
python running the `align/` scripts shipped unpacked next to app.asar.
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

## Helper protocol (`align/sonata-align`)

The helper is spawned by Sonata and speaks JSON lines on stdin/stdout. stdout carries only
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
← {"type":"progress","id":"a1","stage":"download|separate|emissions|align|transcribe","p":0.42,"detail":"en 512/1262 MB"}
← {"type":"result","id":"a1","source":"aligned","lines":[{"line":0,"aligned":true,"confidence":0.61,
     "words":[{"t":12.41,"end":12.70,"text":"Hello","conf":0.72}]}],"stats":{"separate_s":2.0,...,"language":"en"}}
← {"type":"error","id":"a1","message":"...","code":"no-model"|"no-cache"|"low-vram"?}
```

**Separate once per song (0.15.37).** A section job with `song` and `offset` (where its slice starts,
on the 20 ms frame grid) keeps its vocal stem on the CPU (`SongCache`: float32 at 16 kHz, one song,
at most 20 min of audio). The `final` job without audio stitches the stems (overlaps cut at their
middle, unheard gaps silent and blank), runs wav2vec2 once more on the stitched stem, then the
Viterbi and the held notes: no second Demucs pass. If the stems are gone (another song, the helper
restarted, other models) it answers `no-cache`, and align-session.js sends the audio as before.
Reusing each section's own emissions instead was 2 ms worse in median, so the emissions run again
(0.3 s). Measured with tools/drift-check/section-bench.js on 12 JamendoLyrics songs: helper time per
song 5.74 → 3.41 s, the same words' error unchanged (median 42 → 41 ms, mean 75 → 77 ms, ≤ 0.1 s
81 % → 81 %).

**GPU budget (0.15.37).** In GPU mode torch uses at most 4 CPU threads (`SONATA_ALIGN_THREADS`, 0 =
torch's default; the CPU path is unchanged): its default (one thread per core) only spins while
Demucs waits for the GPU. After each job the allocator's cache goes back to the driver
(`torch.cuda.empty_cache`). Before each GPU job the free VRAM (`torch.cuda.mem_get_info`) must cover
the working set (1.8 GB) + any model still to load + a 1 GB margin (`SONATA_ALIGN_VRAM_MARGIN_GB`),
else `low-vram` and nothing runs. `SONATA_ALIGN_VRAM_FRACTION` hard-caps the process (benches).
align/bench.py, 6 English songs, before → after: CPU 66–71 → 31 s, wall the same (20.0 s), peak
VRAM 3184 → 3100 MB reserved, at rest 3184 → 1402 MB reserved (the helper process 3.5 → 1.7 GB in
nvidia-smi), accuracy identical.

**Gaming guard (0.15.37, game-guard.js).** Settings → *Pause word timing while gaming* (on by
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

Files: `align/sonata_align.py` (pipeline), `align/server.py` (protocol), `align/sonata-align`
(launcher), `align/install.sh` + `requirements.txt`, `align/bench.py`,
`align/bench_transcribe.py`, `align/test_align.py` (unit tests: Viterbi, windows, text, language,
PCM, protocol, holds, paths, GPU budget, stitching). test/align-install.test.js covers install.sh's
and the launcher's path choices.

## Install footprint

Everything lives under `~/.local/share/sonata-align/` (`SONATA_ALIGN_HOME` overrides it;
`$XDG_DATA_HOME/sonata-align` only when XDG_DATA_HOME is not inside another app's sandbox). Nothing
is installed system-wide.

**The venv's Python (0.15.37).** A venv's `bin/python` is a link to the interpreter it was made
from. install.sh builds it from a system Python 3.10–3.13 (3.12 first; `SONATA_ALIGN_PYTHON`
overrides), never one under `~/snap`, `/snap`, `~/.var/app` or an AppImage mount, and never lets uv
download one (except `--uv-python`, into `<home>/python`). The first install came from the Codium
snap's terminal: uv put Python in `~/snap/codium/495/` and the snap set XDG_DATA_HOME there, so a
snap refresh would have broken Precise timing. Sonata checks the install at start and when
Settings asks (align-helper.js `checkInstall`): a dangling or sandboxed python gets a notice in
Settings → Precise timing and the rail says "Helper needs a rebuild". The fix is
`align/install.sh --rebuild` from a normal terminal: the old venv is moved aside to
`venv.old-<date>` (put back automatically if the build fails), the models stay.

| Part | Size |
|---|---|
| venv (a system Python 3.10–3.13, torch 2.11 cu128 + CUDA libs 4.2 GB, triton 0.6 GB, demucs, transformers, faster-whisper) | 7.1 GB |
| CPU-only venv (`install.sh --cpu`, estimate) | ~1 GB |
| htdemucs | 84 MB |
| aligner per language (en / xlsr-xx / mms) | 1.26 GB each |
| Whisper large-v3-turbo (transcription only) | 1.62 GB |
| **Typical user** (venv + Demucs + English + one more language) | **≈ 9.7 GB** |
| uv's wheel cache (`~/.cache/uv`, can be cleared after install) | ~6.5 GB |

Runtime: 3.1 GB VRAM peak while aligning, 1.7 GB at rest with the models loaded (0.15.37); the GPU is idle between songs. The helper should exit
when idle (see the integration plan) so the VRAM is freed.

## Licences

Sonata is GPL-3.0. Nothing below is bundled into Sonata. The user's own install downloads it.

| Component | Licence | Notes |
|---|---|---|
| align/ code (ours) | GPL-3.0 (repo licence) | |
| PyTorch / torchaudio | BSD-3 / BSD-2 | |
| NVIDIA CUDA/cuDNN wheels | NVIDIA EULA (redistributable runtime) | pulled by pip, not by us |
| Demucs code + htdemucs weights | MIT | |
| wav2vec2 large-lv60k-960h (torchaudio) | MIT (fairseq) | trained on LibriLight / LibriSpeech (public-domain audiobooks) |
| jonatasgrosman XLSR-53 fine-tunes | Apache-2.0 | Common Voice data (CC0) |
| MMS_FA | **CC-BY-NC 4.0** | opt-in only (`allow_nc`), never the default |
| transformers / huggingface_hub | Apache-2.0 | |
| faster-whisper / CTranslate2 | MIT / MIT | |
| Whisper large-v3-turbo weights (+ CTranslate2 conversion, dropbox-dash, formerly mobiuslabsgmbh) | MIT | |
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
   when there's a job. It is one child process. Send `quit` after 2 minutes idle (frees 2.7 GB of
   VRAM) and kill it on app quit. If it crashes, show a log line plus a status in Settings, and
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
   - Store the result in lyrics-store as `aligned|title|artist` with
     `{version:1, model, lyricsHash, duration, lines}`.
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
