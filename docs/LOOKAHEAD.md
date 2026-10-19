# Look-ahead play: "First play: precise from the start"

Experimental, **Linux only, Development builds only**, off by default: Settings → Playback & lyrics →
*First play: precise from the start*, with *Precise (3 s delay)* or *Quick (2 s delay)*. Marcy said yes
on 2026-10-19 ("build look-ahead play for real"). The research behind it (the delay curve, the online
aligner, the prototype) is in the engine's private repository; this page is the build.

## What it does

On a song's first play, the listener hears Sonata's stream D seconds late (3 s Precise, 2 s Quick).
The engine still hears the stream as Chromium plays it, so it hears every word D seconds before it is
sung and commits its timing in time: the words light up right on the first play, not a section at a
time. The engine's curve: 3 s keeps today's accuracy (−0.7 PCO points against the whole-song decoder,
97 % of words ready in time), 2 s is the aggressive setting (−1.2, 96 %), below about 1 s the acoustic
model hears words too late.

- **First plays only.** Decided once, when the song starts (`lookahead.js` `decide`, from the caches only):
  - a song whose word timing is cached for this recording (`learned`) plays with no delay;
  - so does a song with nothing to learn (no lyrics, an instrumental, Apple's own word timing, lyrics without line times);
  - a song whose lyrics were never looked up is a first play by definition (a learned song has its lyrics cached);
  - **music videos are never delayed**;
  - nor is anything while no lyrics window, Studio or visualizer is open, while the graphics card is busy
    (the gaming guard), or while the engine can't stream (no GPU, an engine without the `stream` feature,
    Precise word timing off). Then the song plays with no delay and its timing comes in sections, as before.
- **Controls act on what is heard.** Pause freezes the delay first (silence within one or two cycles; nothing
  that was buffered plays while paused); play resumes from the buffer at once; a seek drops what was buffered
  and the new place is heard D later; a skip cuts the old song.
- **Switching between songs with and without delay is clean** (`commandsFor`):
  - a skip: the old song is cut, the new song starts with its own delay (D of silence, or at once);
  - a natural end into a delayed song: no cut, the silence goes into the gap between the tracks (at most D);
  - a natural end of a delayed song into one with less delay: Apple's page holds the player at the new item
    (`lookahead-page.js`), the old song's last D seconds play out, then the new song plays from its start with
    no delay ("drained");
  - delayed into delayed: the new song follows on, held for a moment only.
- **The clock follows what is heard.** The lyrics, the Studio, the mini player and the liner notes' sung line
  run on the player's position minus the helper's reported delay (`heardClock`); while the line refills (a
  song's start, a seek) they hold at the new place and the timing note says "Getting ready". The engine and
  the recording keep the player's own clock: they hear the stream undelayed. Apple's own progress bar and the
  desktop's media controls run ahead by the delay (they are Apple's and Chromium's).

## The audio path (Linux, PipeWire)

```
Chromium (Sonata's stream) ──► "Sonata look-ahead" (virtual sink = the helper's input stream)
          │                              └─ ring, D s ──► the helper's output stream ──► the default device
          └─ parec --monitor-stream (the engine tap, audio-listen.js): undelayed
```

- **The helper** (`native/lookahead/sonata-lookahead.c`, about 600 lines of C; libpipewire only): two
  `pw_stream`s in one node group and link group (the module-loopback model). The input is a virtual sink
  (`media.class Audio/Sink`, node `sonata-lookahead`, "Sonata look-ahead"); the output is a playback stream the
  session manager links to the default device and moves when the default changes. One driver clocks both: no
  resampling, no drift. Everything happens in the graph's process cycle (the prototype showed a pipe-based delay
  can neither be exact nor pause in time). Its control socket (one client, Sonata; commands `pause`, `play`,
  `flush D`, `open`, `track D`, `stat`) is described at the top of the source.
- **Only Sonata's stream is routed**: `pactl move-sink-input <Sonata's sink input> sonata-lookahead`, the sink
  input found exactly as the engine tap finds it (`audio-listen.js` `pickSinkInput`, Sonata's process tree,
  never the helper's own output stream). The default device is never touched; no other app changes. Chromium
  makes a new stream after a pause of 10–20 s: WirePlumber's remembered target puts it on the look-ahead sink
  (measured), and `pactl subscribe` makes Sonata check and move it if not.
- **Off, quit, or the helper gone**: Sonata moves its stream with `pactl move-sink-input <index> @DEFAULT_SINK@`,
  which pipewire-pulse turns into "no target": the stream follows the default device again and WirePlumber keeps
  no target for it (measured). The helper quits when its socket closes and when Sonata dies (`PR_SET_PDEATHSIG`);
  its PipeWire objects belong to its connection, so the daemon removes them with it: **no virtual device is left
  on the desktop**. If the helper dies while Sonata plays, the session manager relinks Sonata's stream to the
  default device by itself (measured: 6 ms, no silence), Sonata's clock stops shifting at once, the status line
  says so, and Sonata starts the helper again (at most `MAX_RESTARTS` times per run).
- **Visible device**: while it runs, desktop sound settings show "Sonata look-ahead". Hiding it is not
  possible without touching the user's session manager config.

### Packaging: with Sonata, not with the engine

The helper ships in Sonata's Linux build (the AppImage's resources, `lookahead/sonata-lookahead`; `npm run dist`
builds it first with `native/lookahead/build.sh`, which takes the PipeWire headers from the system or fetches
them without root with `apt-get download`). Why not with the engine helper:
- it is part of the player, not of the timing: its commands follow Apple's player controls, and Sonata's
  page hooks, routing and clock change together with it (one version, one test suite);
- it reroutes the user's audio: that code belongs in the public, auditable repository, not in the private engine;
- it is tiny (one C file, about 40 KB built, no Python, no models), Sonata's own code under Sonata's licence
  (GPL-3.0-or-later), linking only libpipewire (MIT), dynamically: no copy bundled, it matches the user's PipeWire;
- the engine stays an optional download; without it look-ahead simply never delays a song.

## Chromium's real behaviour (castlabs Electron 45, measured in a private PipeWire)

| | min / median / max |
|---|---|
| pause tail (`pause()` → last audio reaching the sink) | 74.9 / 95.6 / 104.3 ms |
| resume lag (`play()` → first audio) | 61.7 / 89.0 / 105.5 ms |
| seek: old audio after `currentTime=x` | 88.9 / 99.4 / 106.2 ms, then a 4 ms break, then the new audio |
| track change (`src`): old audio after it / the silence before the new | 0–41 ms / 45–120 ms |

- Pause is a hard cut; resume continues sample-exact with a 5 ms fade-in. The tail is ~6 ms longer than the lag on average.
- `seeked` / `playing` fire 0.3–2 ms after the seek call, ~100 ms **before** the old audio stops: so the helper's
  gate opens on the content (the break of silence before the new audio), not on the event.
- The stream stays across pauses up to ~5 s, is corked at 10 s and replaced between 10 and 20 s; seeks and
  `src` changes keep it.
- Its sink input has no media.role and no target; WirePlumber keys it by `application.name`.

**Surplus policy (decided on these numbers):** a pause tail longer than the resume lag leaves the delay a few ms
above D. Once the surplus is over one quantum, the helper takes all of it out of the next silence longer than
200 ms (never out of sound), so the delay lands on D again; within a quantum (Chromium's ±15 ms jitter) nothing
is trimmed. A deficit (a lag longer than the tail) is fixed at resume by holding the output for the learned
lag: resume is silent anyway. A seek or a track change re-centres exactly. The tail kept while paused is capped
at 250 ms (Chromium's maximum: 104 ms).

## The engine's streaming mode

The engine (branch `lookahead` of the private engine repository; capability `stream` in its pong, protocol
unchanged) runs one streaming job per delayed song: htdemucs over the newest 7.8 s every 0.5 s, wav2vec2 over
the newest 20 s of stem every 0.25 s, and the online aligner (free-end Viterbi) on each hop. A hop that runs late
is not caught up: the next one starts at the newest audio. A word is committed by its onset + lead − 0.15 s and
marked `late` when the listener has already passed it; committed words never move. Sonata's side
(`align-session.js` look-ahead mode, `align-helper.js` `stream`):
- the capture (the shared parec) goes to the job in 0.25 s pieces with their song time (a jump is a seek);
- committed words go to the lyric views as `lyrics-stream` messages, merged word by word (`lyrics-view.js`
  `streamedLines`: the words still to come keep their estimate, moved after the last committed one; this needs
  *Estimated word timing*, on by default);
- **late words are lit at once, without their pop** (`.w.now.late` in `lyrics-view.css`): the pop is never shown at a wrong time;
- no section jobs while the stream runs; at the end the whole song is aligned once more, as for any fully heard
  song: that result is what stays cached for replays;
- the engine refuses (no GPU, a busy GPU, an old engine): the song's sections are aligned as before.

## Measurements (private PipeWire, `tools/lookahead-test/`)

All in a private PipeWire 1.6.2 + WirePlumber 0.5.13 under bwrap (no `/dev/snd`, the user's runtime dir
hidden, private `/tmp`, no D-Bus, no network), two null sinks as devices, quantum 1024 at 48 kHz, no realtime
priority. A fake player (`la-test player`: a `pw_stream` like Chromium's) plays a tone and a sample counter;
a probe records the player's output and both devices in the same graph cycle, so every heard frame names the
sample it came from. Routing, unrouting and crash handling go through `pactl` exactly as Sonata does.
Marcy's own session was checked read-only before and after (`pw-dump` node list).

| Measure | Target | Result |
|---|---|---|
| Delay exactness (D = 0.5 / 1 / 2 / 3 s, 30 s each) | ±5 ms | 500.000 / 1000.000 / 2000.000 / 3000.000 ms, every heard frame; 0 jitter |
| Drift, 10 min at D = 3 s (with Sonata's engine tap running) | none | one value over 601 s (28.9 M heard frames): 0 jitter, 0 drift. The engine tap had each sample 2977.6 ms or more before it was heard (p5 2990.6 ms). The tap's parec moved the graph to quantum 512, so this run sat at 2989.333 ms (D − 512 frames until the next flush); the helper's claim matched it at all 60 stats |
| The helper's heard delay vs the measured offset (what the clock uses) | exact | equal to the sample in steady play, after pauses and after a trimmed surplus; after a quantum change up to one quantum off for D s (see Known limits) |
| Pause → silence at the device (12 pauses) | < 50 ms | 22–37 ms (median 30 ms) at quantum 1024, the player's own tail kept |
| Nothing heard while paused | 0 frames | 0 frames, all 12 |
| Resume | seamless | 0 frames lost or repeated, all 12; equal tail and lag: back on 3000.000 ms; a deficit (lag > tail) closes over the next resumes (learned hold); a surplus is trimmed in the next silence and the delay lands on 3000.000 ms again |
| Seek (flush, gate, refill; Chromium-like old audio for 100 ms after the seek) | new audio after D, no old audio | silence 27–40 ms after the seek; 0 old frames; the new audio starts exactly at the target (0 frames off), 3000.000 ms behind |
| Track change into a delayed song (learned → first play) | no cut, a gap ≤ D | the old song's last audio, then the gap and D of silence, then the new song at exactly 3000.000 ms; nothing lost or heard twice |
| Track change out of a delayed song (first play → learned, the player held) | the old tail plays out, then no delay | the old song heard to its last frame ("drained" 3.0 s after the item change), then the new song from its first frame with no delay (2 quanta, 42.7 ms) |
| Default device changed mid-song | the delay follows, Sonata's stream stays | the helper's output moved to the new device and back; Sonata's stream stayed on the look-ahead sink; one quantum lost at each switch (see Known limits) |
| A new stream (Chromium after a long pause) | routed, no blip | on the look-ahead sink at once (WirePlumber's remembered target), delay 3000.000 ms, no frame on the device directly |
| The helper killed (kill -9) | back on the device at once | relinked to the device in 6 ms; 43 ms of silence; then undelayed; no look-ahead node left |
| Off / quit (`@DEFAULT_SINK@`) | default device, nothing kept | moved in 6 ms; follows a new default device afterwards (not pinned); no target remembered; no node left |
| Sonata's controller (`controller-itest.js`: real spawn, sockets, pactl) | | 18 of 18 checks: routed 25 ms after start; first play 3 s behind, a learned song and a video with none; pause frozen, play and seek back on 3 s; the helper killed: on the device in 7 ms, the controller's fallback in 20 ms, restarted and routed again after its 5 s backoff; stop: the stream follows a new default device, no target remembered, no helper or node left |
| xruns, underruns, overflows | 0 | 0 xrun cycles, 0 underruns or overflows during play (one at the helper's very first cycle), pw-top ERR 0 on every node |
| CPU | < 0.5 % of a core | the helper 0.12 % of one core over 10 min (no realtime priority); the private daemon 0.26 % |

## Known limits

- **A graph quantum change** (another app asking for a lower latency, or the engine tap starting) moves the heard
  delay by up to one quantum for D seconds: the audio already buffered keeps its old latency. The clock follows
  the helper's figure, which is right again within D; the delay itself is re-centred at the next seek or song.
- **A default-device change** while a delayed song plays loses one quantum (21 ms) at the switch, as any device
  switch does, and the clock is one quantum off until the next seek or song.
- **Volume** set in Apple's page is applied by Chromium before the delay: a change is heard D later.
- At a natural track change the lyrics window switches to the new song when Apple's player does, up to D
  seconds before its first sound.
- The output device stays awake while the switch is on and Sonata runs (like any open stream); the helper itself
  costs about 0.1 % of a core.
- **Not checked with Marcy's logged-in Apple Music** (test copies play nothing protected): that Chromium's
  Widevine stream routes the same way, that MusicKit's `nowPlayingItemDidChange` comes before the new song's
  audio, and that MusicKit honours the hold (a pause at the item change). If it doesn't, the new song's start is
  dropped by the helper's gate and Sonata plays it again from its start.
- **The engine's streaming on a GPU is not measured yet** (pacing per hop, VRAM): every test so far ran on the CPU
  with fakes and two short real-model runs, because Marcy's Sonata was using the card.

## macOS and Windows: not built (the switch is hidden there)

- **macOS 14.2+**: Core Audio process taps (`AudioHardwareCreateProcessTap` with `mutedWhenTapped`, read through an
  aggregate device; system audio recording permission) fit the same design: the OS silences the original while
  the helper reads it, and gives it back if the helper dies. Unverified: which process renders Chromium's audio
  (a tap is per process), and whether the tap is before or after the app's volume.
- **Windows 11 (build 20348+)**: process-loopback capture (`ActivateAudioInterfaceAsync`, `INCLUDE_TARGET_PROCESS_TREE`)
  can read Sonata's audio, but **silencing the original is unsolved**: muting Sonata's own session works only if
  the loopback taps before the session's mute, which no documentation says. Test that first; otherwise no look-ahead
  on Windows.

## Tests

- `test/lookahead.test.js`: first plays only (`decide`, `learnState`, music videos), the heard clock and its
  refill hold, the page's events mapped to the helper's commands (pause, play, seek, skip, natural ends with and
  without delay), the routed stream (never the helper's own output), the page scripts, the controller with a fake
  helper (routing, the event order, the drain, a video, the helper dying: fallback, clock, status; stop), the
  streamed words in the views and the late-pop rule.
- `test/align-session.test.js` (look-ahead): the song streamed in 0.25 s pieces with no section jobs, its words to
  the views, the whole-song pass at the end; a refused stream falls back to sections; a learned song never streams.
- `tools/lookahead-test/` (manual, needs gcc and PipeWire): `run-all.sh <scratch>` (each scenario in its own private
  sandbox, `analyze.py` for the numbers) and `controller-itest.js` (Sonata's own controller against the real helper).
  The summaries of the run above are in `tools/lookahead-test/results/` (pause and track from the run after the
  last two helper fixes: a track boundary's place in its cycle, the surplus trimmed to zero).
