# Resource budgets

Sonata sips, it doesn't drink (CLAUDE.md "Sip, don't drink"). These are the numbers that say so, with
limits. The limits live in [`tools/budgets.json`](../tools/budgets.json), the single source of truth; this
page explains them and keeps the last measurement. Raise a limit only with Marcy's OK, in the same commit
as the reason here. Modelled on the DS5 app's budgets (`docs/BUDGETS.md` there).

## Running it

```bash
tools/check_budgets.sh                 # quick, ~10 min: every state once (the dev-release check)
tools/check_budgets.sh --soak          # ~35 min: 5 min warm-up + 30 min of playback (stable candidates)
tools/check_budgets.sh --bin dist/linux-unpacked/apple-music-for-linux   # a packaged build (never ~/Downloads)
SONATA_BUDGET_STATES=lyrics-playing,viz-bars tools/check_budgets.sh      # only some states
SONATA_BUDGET_MODE='{"cpuS":60}' tools/check_budgets.sh                  # other timings, for an experiment
node tools/check-budgets.js report tmp/budgets/budgets-quick.json         # the table again
```

`tools/check_budgets.sh` starts **its own isolated copy** with `tools/isolated.sh` (display :147, DevTools
9747, inspector 9748 by default; `SONATA_BUDGET_DISPLAY` / `SONATA_BUDGET_PORT` to move it): a throwaway
HOME, its own Xvfb display, a private D-Bus, never Marcy's copy or screen; it quits it with `app.exit(0)` and
checks for core dumps. It prints a PASS / FAIL / SKIP table, writes `tmp/budgets/budgets-<mode>.json` and
`app.log`, and exits 1 when a budget fails. The measuring is `tools/check-budgets.js`, the arithmetic
`tools/budgets-lib.js` (tested in `test/budgets.test.js`).

**Not in CI**: it needs a display server and minutes of wall time, and shared runners are far too noisy to
judge tenths of a percent. It is in the release checklist instead (docs/RELEASING.md, "Checks before
tagging"): quick for every development release, `--soak` for a stable candidate.

### Something playing, logged out

The copy is logged out, so nothing plays by itself. `tools/stand-in.js` replaces `MusicKit.getInstance()` in
the test copy's Apple page with a stand-in player: three local test tracks (75-90 s, word-timed TTML with
two singers, background vocals, held notes and an interlude; the test artworks as covers), looped on the
wall clock. Everything main.js reads through MusicKit then runs for real: the 5 s now-playing loop, the mini
player's 1 s poll, the 500 ms lyrics feed, the lyrics lookup, cache and view, next-song prefetch, the
palette and Glass backdrop, track changes. There is **no sound**: an `<audio>` in a copy without PulseAudio
could reach the sound card. The visualizer's spectrum therefore comes from the check (48 bands at ~43/s,
sent from main to the visualizer like visualizer.js does from Sonata's own stream).

Track notifications are turned off in the test copy: its private D-Bus has no notification server, and
libnotify then blocks the main process ~25 s per track change while D-Bus tries to start one (BACKLOG
"No notification server").

## The budgets

| Budget | Limit | Measured how |
|---|---|---|
| **CPU hidden** (`hiddenCpu`) | ≤ 0.5 % of a core, tray idle and tray playing | Main window hidden (as the tray does), nothing else open, 60 s after 15 s to settle. CPU time of the app's processes from `/proc/<pid>/stat`. Judged: main, utility and Sonata's own pages. |
| **CPU shown** (`shownCpu`) | per state, below | 20 s after 5 s to settle. Judged as above. **Reported, not judged:** the GPU process (Xvfb has no graphics card: software GL inflates it), Apple's page (Apple's code, not ours) and DevTools' tracing service (it runs only because we measure). |
| **Frames** (`frames`) | per state, below | Compositor frames of the state's page per second: a DevTools screencast of that page for 5 s. Resting pages must draw nothing. On the software display the screencast can't keep up with busy pages (the lyrics read 28-40/s while the trace shows a frame per vsync), so for the busy states it is a ceiling, not a target. |
| **Repaints** (`repaints`) | per state, below | `Paint` events of the page's own frame (its DevTools target id) in a 5 s trace recorded in main (`contentTracing`), per second. Compositor-only animation repaints nothing. |
| **Memory** (`memory`) | ≤ 400 MB PSS | `/proc/<pid>/smaps_rollup` PSS of every process except the GPU process and the tracing service, after the quick run with every window closed, main hidden, a GC in every page. Apple's page is about half of it (logged out). |
| **Listeners** (`listeners`) | rise 0 | After one warm-up cycle, 5 cycles of opening and closing the lyrics window, the visualizer, the mini player and the panel. Counted after each: every main-process listener (ipcMain, app, nativeTheme, screen, every window, every webContents), live webContents, active timers, and the rail's and the panel's JS listeners and nodes after a GC. The largest rise of any counter is judged. Apple's page's listeners are reported. |
| **Soak growth** (`growth`) | ≤ 10 MB per 30 min | `--soak`: the stand-in plays for 35 minutes; every minute (a lap) the lyrics window (12 s), the visualizer with its spectrum (12 s), the mini player (8 s) and the panel (3 s) open and close, then PSS and the counters are sampled in the same state (floating windows closed, main shown). Growth = the least-squares slope over the 30 minutes after a 5-minute warm-up (one noisy sample can't fail it), judged without the GPU process and the tracing service. Per process in the results. |
| **Soak listeners** (`listenerGrowth`) | rise 0 | The same counters as Listeners, first to last sample after the warm-up. |

Per-state limits (CPU shown % of a core / frames per s / repaints per s):

| State | What is on screen | CPU | Frames | Repaints |
|---|---|---|---|---|
| `main-idle` | main window, panel hidden, paused | 0.5 | 0.5 | 0.5 |
| `main-playing` | main window, playing | 0.5 | 0.5 | 0.5 |
| `panel-playing` | Settings panel shown, playing | 0.5 | 0.5 | 0.5 |
| `lyrics-playing` | lyrics window, words being sung | 6 | 61 | 40 |
| `lyrics-paused` | lyrics window, paused | 0.5 | 0.5 | 0.5 |
| `mini-playing` | mini player, playing (1 update/s) | 1 | 2 | 4 |
| `viz-bars`, `viz-aurora`, `viz-nebula`, `viz-toast` | visualizer, fullscreen 1920 x 1080, playing, spectrum fed | 20 | 61 | 30 |
| `viz-paused` | visualizer, paused (it freezes) | 0.5 | 0.5 | 0.5 |

Frames and traces of the playing lyric states start at the same point of the song every run (40 s into a
track: words being sung, the interlude behind), so a stretch never lands on the interlude in one run and on
dense words in the next.

## Last measurement

**Baseline: 0.15.38-dev.1** (ff32984, Electron 42.3.3+wvcus castlabs), 2026-10-17, quick mode, from source
(`node_modules/electron` + the tree) on the isolated copy above (Xvfb 1920 x 1080, software GL). Other test
copies ran on the machine at the same time, so treat ±0.2 % as noise.

| State | CPU judged | GPU process (INFO) | Apple's page (INFO) | Frames/s | Paints/s | Style recalcs/s | Layouts/s |
|---|---|---|---|---|---|---|---|
| tray-idle (60 s) | 0.20 | 0 | 0.37 | - | - | - | - |
| tray-playing (60 s) | 0.07 | 0.03 | 0.03 | - | - | - | - |
| main-idle | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| main-playing | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| panel-playing | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| lyrics-playing | 2.10 | 0.90 | 0.10 | 28.4 | 22.2 | 20.6 | 4.8 |
| lyrics-paused | 0.05 | 0 | 0.10 | 0 | 0 | 0 | 0 |
| mini-playing | 0.20 | 0.05 | 0.05 | 1 | 3 | 1 | 1 |
| viz-bars | 8.00 | 4.55 | 0.05 | 60 | 18 | 32.6 | 5.4 |
| viz-aurora | 9.20 | 4.20 | 0.05 | 60 | 18.6 | 32.4 | 5.6 |
| viz-nebula | 11.04 | 4.65 | 0.05 | 60 | 19.6 | 32.6 | 6.0 |
| viz-toast | 7.59 | 4.50 | 0.10 | 60 | 19 | 32.6 | 6.0 |
| viz-paused | 0.10 | 0 | 0.05 | 0 | 0 | 0 | 0 |

An earlier quick run the same day (before the fixed song point) read lyrics-playing 3.0 % / 39.6 frames /
31.6 paints and viz-bars 11.7 % / 26.2 paints: the lyrics and visualizer limits leave room for that spread.
The research harness (docs/PERFORMANCE.md "Lean lyrics") counted 7 paints/s while singing with a different
trace (whole renderer, other categories, another song): compare runs of this tool with each other.

**Memory** (PSS, MB): judged 302.9 (an earlier run 262.6): main 79.6, Apple's page 140.2, rail 31.8,
panel 30.1, network service 21.1. Reported: GPU process 42.1, tracing service 35.7. Total 380.7.

**Listeners**, 5 open/close cycles of every window: every counter flat (rise 0). At rest: ipcMain 8, app 9,
1 window with 9 listeners, 3 webContents with 54, 1 timer; rail 10 JS listeners / 125 nodes, panel 21 / 210;
Apple's page 7,678 listeners / 28,382 nodes, flat too.

**Soak:** 2026-10-17, `--soak`, 0.15.38-dev.1 from source on the same kind of copy: 34 laps over 35.4 minutes (5
warm-up), no lap lost. **PSS fell, it didn't grow:** judged 350.3 MB at the end of the warm-up, 357.4 at most,
298.1 at the end; slope −60.2 MB / 30 min (all processes −91.6). Per process: main −37.5, GPU −31.5, Apple's
page −12.1, network −5.6, panel −3.3, rail −1.6 (the first laps' caches and the warm-up's peak being given
back; the machine was busy with other test copies). **Every counter flat** for all 34 laps: ipcMain 8, app 9,
window listeners 9, 3 webContents with 54 listeners, 1 timer; rail 10 JS listeners, panel 21; Apple's page
5,358 listeners / 15,475 nodes, the same on every sample. An earlier soak the same day (29 laps, stopped by
a DevTools call into a closing page, which now costs one lap instead of the run) read the same: PSS 290 →
239 MB, counters flat.

## What the UI checker covers beside this

`tools/ui-check.js every` (BACKLOG "UI checker for every window") is the look-and-feel half: every Sonata
window and view, light and dark, with the stand-in playing, for contrast, names, hit targets, dead controls,
theme tokens, overflow and clipping. Both run on an isolated copy, before a dev release.
