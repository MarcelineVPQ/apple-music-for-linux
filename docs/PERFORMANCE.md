# Performance: loops, lifetimes, measurements

Pass of 2026-10-15, on master 940184d. Every loop and long-lived listener has a
`// loop:` or `// lifetime:` verdict comment in the code. This file collects them.

**Result:** one real defect, now fixed (CSS stylesheets piling up in the page).
Everything else is bounded and cheap. In the everyday state (tray only, main
window hidden) the app runs one 5 s poll and nothing else.

## Tray-only state (main window hidden, no mini/lyrics/visualizer)

| Work | Period | Needed for |
|---|---|---|
| now-playing poll (`startNowPlayingLoop`) | 5 s | tray tooltip, track notifications, Last.fm, Discord |
| update check | 2 h (AppImage only) | self-update |
| Discord reconnect attempt | every 6th poll (30 s), only while Discord is enabled but unreachable | presence |

Nothing else runs: palette extraction only happens while the mini player or lyrics
window is open, or (since the navigation rail) while the main window is shown, for the
rail's tint; lyrics lookups only while a lyric view is open. Per track change there is at most one artwork fetch
plus one `Notification` (notifications on), one Last.fm now-playing call and one
Discord update. None of these objects is stored.

## Loop table

| Where | Loop | Period | Runs while | Stops on | Cost / verdict |
|---|---|---|---|---|---|
| main.js `startNowPlayingLoop` | now-playing poll | 5 s | always (the tray always exists) | app exit | 1 `executeJavaScript`/5 s, 0.02–0.07 % main CPU. Needed, left as is. Since the rail it also refreshes the palette while the main window is shown (one artwork fetch per track change) and calls `pushRail` (one small JSON compare; an IPC send only when the rail's state changed) |
| main.js `createMiniWindow` | mini poll | 1 s | mini window exists, including minimized/paused | mini `closed`, main `close` | 1 read/s, 0.05 % main CPU. Left as is |
| main.js `startLyricsFeed` (0.15.22) | lyrics feed poll, for the lyrics window and the visualizer | 500 ms | lyrics window or visualizer exists, including minimized/paused | last of them `closed`, main `close` | 2 reads/s plus one lyrics lookup per track (cached), 1 IPC send per view per tick. Replaces the lyrics poll and the visualizer's own 300 ms poll |
| main.js `vizAudioTick` + visualizer.js | own-stream parec (audio-listen.js; since 0.15.24 the one shared parec that also feeds refine and precise timing) → 1024-point FFT → IPC | ~43 frames/s | visualizer exists and the song plays (system-monitor fallback: visualizer exists) | pause, viz `closed` | 1 FFT + 1 IPC send per frame; FFT buffers reused (no per-frame garbage) |
| visualizer.html `frame` | requestAnimationFrame | display rate | window visible (Chromium pauses rAF when hidden) | window close | one canvas frame. Left as is: ambient modes animate on purpose |
| visualizer.html lyrics (0.15.22) | lyrics-view.js word/dot loop (the lyrics window's) | per word change | visible, playing, word timing | as the lyrics window | DOM class writes per word change |
| visualizer.html `showLabel` | label fade | 1.4 s one-shot | after a mode switch | fires; cleared before re-arm | ~0 |
| main.js `startUpdateChecks` | update check | 20 s once, then 2 h (+1 per channel switch) | AppImage builds | app exit | 2 small GETs/2 h (signed feed + `.sig`; 1 on the placeholder-key `latest-linux.yml` path); `updateCheckBusy` prevents overlap. A new version is hashed by a streamed read (`update-feed.js` `verifyDownload`), once per version |
| main.js `persistBounds`, `rememberBounds` | bounds save debounce | 500 ms one-shot | after a move/resize | fires | ~0; checks `isDestroyed()` |
| main.js mini/lyrics keep-above | KWin keep-above | 300 ms one-shot | once per window open | fires | one qdbus call, KDE Wayland only |
| lyrics.html `frame` (0.15.10) | requestAnimationFrame: karaoke word highlight + interlude dots | display rate | lyrics window visible **and** playing **and** the song has word timing (or a countdown is showing) | hidden (`visibilitychange`), paused (`isPlaying` false, or the time stops moving), new track, line-only lyrics outside a countdown | per frame a few comparisons; DOM class writes only when a word/line changes, 3 dot styles during a countdown. Measured below |
| lyrics.html `#spin` (0.15.10) | CSS rotation of the round cover | 9 s per turn | Settings → Spin album art on (off by default), visible and playing | `animation-play-state: paused` when hidden or paused | compositor only; +3.5 % software-GL GPU under Xvfb, renderer unchanged |
| miniplayer / settings .html | — | — | — | — | no loops; they only react to IPC pushes |

**Duplicate pollers:** with mini player + lyrics + visualizer all open, three polls
read the same `nowPlayingScript` 6.5 times/s for 0.13–0.20 % main-process CPU.
A shared poller would cut that to 3.3/s but saves about 0.1 % of one core, and only
while all three windows are open, so it's left as is. Minimized windows keep polling
at full rate. The cost is the same as above, so this is also left as is.

**Error gate:** every poll catches a failing `executeJavaScript`, for example while
the page is navigating, and simply waits for the next tick. The fastest poll is
300 ms, so nothing can hammer. If MusicKit isn't ready (logged out), the script
returns `{ ok: false }` and doesn't throw. No backoff is needed.

## Lifetime table

| Where | Thing | Verdict |
|---|---|---|
| main.js `createWindow` `did-navigate` / `page-title-updated` | `insertCSS(customCss)` on every event | **FIXED.** Each call added another stylesheet to the page and never removed the old one: 2 → 202 injected sheets after 200 title changes, growing for the life of the page. Now goes through `css-replacer.js`, which inserts the new copy and then removes the previous one. The CSS is still applied on the same events. |
| main.js all `ipcMain.on` / `ipcMain.handle` | IPC handlers | registered once at module load; counts stay at 1 after 20 open/close cycles |
| main.js mini / lyrics / viz `closed` | poll timers, window refs | cleared and nulled on close; timer count back to 1 after cycles |
| main.js `lockDownLocalWindow`, `persistBounds` | per-window listeners | live on the window and die with it |
| main.js `createWindow` listeners | main window listeners | `createWindow` runs once, so they're registered once |
| main.js `refreshTrayMenu`, `showMoreMenu` | `Menu` per call | user actions only; the old menu is dropped and collected. The Tray is created once |
| main.js `refreshPalette` | artwork buffer + nativeImage per track | locals only; only the small palette object is kept. Mini/lyrics only |
| main.js `notifyTrack` | artwork + `Notification` per track | not stored, no listeners attached; collected after display |
| main.js `feedDiscord` | `DiscordPresence` per reconnect attempt (every 30 s while unreachable) | failed probe sockets are destroyed, nothing stacks. *Theoretical, left as is:* if Discord accepted the socket but never answered the handshake, the next attempt would open a second socket without closing the first |
| discord.js `connect` | probe `error` listener stays on the connected socket | *theoretical, left as is:* a later socket error would retry the remaining paths. Never observed |
| discord.js `onData` | frame buffer | only holds an incomplete frame |
| lyrics-sources.js `createLyricsResolver` | lyrics cache | bounded at 50 entries; empty results are dropped; in-flight lookups are shared between lyrics and the visualizer (LRCLIB behaviour untouched) |
| visualizer.js `emit` | FFT buffers | reused since 0.15.22 (one pair per Visualizer); only the 48-entry band array per frame |
| renderer pages | `ipcRenderer.on` listeners | added once at load (lyrics.html also one `visibilitychange` listener). lyrics.html replaces its line, word and dot elements per track and cancels its rAF on every new track. miniplayer.html swaps the artwork `src` only on a track change |

## Measurements

Isolated run: the repo's Electron (castlabs 42.3.3) under Xvfb, throwaway HOME and
`XDG_RUNTIME_DIR`, private D-Bus, no Wayland, PulseAudio/PipeWire pointed at a
nonexistent socket (no audio, so parec captures nothing), no Apple login (the browse
page loads anonymously; MusicKit has no now-playing item), `--hidden`. A harness
module drove the windows through the app's own IPC channels and tray menu, counted
`executeJavaScript` / `insertCSS` calls, and counted the page's injected stylesheets
over the DevTools protocol. CPU is % of one core.

| Scenario | executeJavaScript/s | main-process CPU | before → after fix |
|---|---|---|---|
| tray only, main hidden (30 s) | 0.2 | 0.06–0.07 % | unchanged |
| mini open | 1.2 | 0.05 % | unchanged |
| mini + lyrics | 3.2 | 0.09–0.11 % | unchanged |
| mini + lyrics + visualizer | 6.5 | 0.14–0.20 % | unchanged |
| all three minimized | 6.5 | 0.13–0.20 % | unchanged |
| tray only after the 20× cycles | 0.2 | 0.02–0.03 % | unchanged |

Hidden page renderer in tray-only state: 0.8 % in the first 30 s while the page was
still settling, then 0.07 %.

20 open/close cycles each of the mini player, lyrics and visualizer, after GC:

| | before cycles | after cycles |
|---|---|---|
| main RSS | 220.1 MB | 223.0–223.3 MB (+3 MB, one-time warm-up; JS heap 3.7 → 4.1 MB) |
| all processes, working set | 680 MB | 680–690 MB |
| active timers (`getActiveResourcesInfo`) | 1 | 1 |
| `ipcMain` listeners per channel | 1 | 1 |
| BrowserWindows / webContents | 1 / 1 | 1 / 1 |

200 simulated `page-title-updated` events on the main page:

| | before fix | after fix |
|---|---|---|
| injected stylesheets in the page | 2 → **202** | 1 → **1** |

## Lyrics window animation (0.15.10)

The lyrics window gets the playback time from main every 500 ms, as before (main now also
sends `isPlaying`). Between pushes it counts on locally with `performance.now()`
(`lyrics-timing.js` `syncClock`) and wakes one requestAnimationFrame at the next word or line
change (`nextChange`), so it draws only when something changes; during a countdown it draws
every frame. The loop only runs while the
window is visible, the song is playing and the lyrics have word timing, or while a countdown
is showing. Line-only lyrics outside a countdown, a paused song or a hidden window cost
nothing extra.

Isolated run (same setup as above, lyrics.html alone in the repo's Electron, fake 36 s TTML
duet looped, pushes every 500 ms, 30 s sample after 3 s warm-up, % of one core, software
GL under Xvfb):

| Lyrics | renderer | GPU process | rAF |
|---|---|---|---|
| line-only TTML (same song) | 1.30–1.47 % | 5.9–6.2 % | off |
| word timing + duet + background vocals, first version (rAF every frame, colour/glow transitions) | 5.4–5.5 % | 12.7–13.0 % | on |
| word timing, rAF only at changes | 4.9 % | 12.1 % | on |
| word timing, rAF only at changes + only transform/opacity transitions (shipped) | 2.5–2.9 % | 11.3–11.9 % | on |
| shipped + round cover with progress ring | 3.0 % | 12.0–12.3 % | on |
| shipped + cover + "Spin album art like a record" on | 3.0–3.2 % | 15.7–15.9 % | on |
| word timing, window hidden | — | — | off (checked) |

Most of the first version's cost was the animated colour and glow (a repaint for every word
change), not the loop, so only `transform` and `opacity` animate now; colour and glow switch
instantly. The test song sings a word every 0.4–0.5 s without pauses, a dense case. The GPU
column is software GL under Xvfb and is much higher than on a real GPU; the difference
between the rows is what counts. The header cover is a plain `<img>` with the mini player's
artwork URL (Chromium's HTTP cache), sent only when the art changes. The progress ring is
written at most 4×/s and only when it moved. The spin (off by default) is a compositor-only
CSS rotation: about +3.5 % in the software-GL GPU process, nothing in the renderer; it is
paused while the window is hidden or the music is paused.

## Navigation rail (0.15.29+; its own view since 0.15.31)

Since 0.15.31 the main window is a `BaseWindow` with two `WebContentsView`s: Apple's page and the
rail (`rail.html`, on top). Apple's view is the window minus the rail's room, so nothing of Apple's
can sit under the rail. The rail view widens over Apple's only while it is open there (hover or
keyboard focus, unpinned) and narrows once it has slid shut. The rail has no loop of its own: no
timer, no animation frame, no polling, no observer (`rail-ui.js` contains none; a unit test checks).
It redraws only on a state push from main, pointer enter/leave, focus, keys, the end of a slide and
a colour-scheme change.

| Where | Thing | Verdict |
|---|---|---|
| main.js `createWindow` | `appleView` + `railView` | created once with the window; their web contents are closed on the window's `closed` (a BaseWindow doesn't do it). Measured: 2 views and 2 web contents throughout 50 open/close, 50 pin/unpin + hover, 50 navigation and 5 reload cycles |
| main.js `layoutViews` / `pushRail` | view bounds + state send | only on change (bounds and state compared as JSON); called on resize, the two fullscreen events, window open/close, settings, connections, palette, expand/collapse and the 5 s tick |
| main.js window listeners | resize ×2 (bounds saver + layout), move, close, closed, focus, enter/leave-full-screen, app-command | registered once in `createWindow`; counts flat |
| main.js Apple view listeners | before-input-event, focus, will-navigate, did-navigate, dom-ready (focus stops), page-title-updated | once each, die with the view; counts flat |
| main.js rail view listeners | before-input-event, focus, did-start-loading, will-navigate (lockdown) | once each, die with the view; counts flat |
| main.js `rail:command`, `rail:focus-in` | `ipcMain.on`, module load | 1 each throughout; each checks its sender view and top frame (and the command list) |
| rail-ui.js | pointerenter/leave, focusin/out, keydown, click, transitionend/cancel on the panel + 1 colour-scheme `change` | once per rail page load (the page never reloads in normal use); measured flat (9) |
| preload-rail-view.js | one `rail:state` + one `rail:take-focus` listener | once per rail page load |
| apple-focus.js (Apple's isolated world) | two focus stops (one `focus` listener each), one capturing `focusin` on the document, ONE `MutationObserver` (childList of `<body>`) | per Apple page load; keeps the stops first and last in `<body>`; measured: always exactly 2 stops |
| preload-apple.js | no listener | only `send('rail:focus-in')` |

Measured in the isolated app (packaged `dist/linux-unpacked`, Xvfb, throwaway HOME, logged-out
Apple page, window 1100×760; `tools/rail-check.js`, CPU from `/proc`, % of one core, 60 s):

| State (0.15.31) | all Sonata processes | renderers | idle repaints (10 s) |
|---|---|---|---|
| without the rail (one-window build, same Electron) | 0.47 % | 0.42 % | — |
| rail unpinned, closed | 0.53 % | 0.43 % | rail 0, Apple 0 |
| rail open on hover, pointer resting on it | 0.03 % | 0.02 % | rail 0, Apple 0 |
| rail pinned | 0.07 % | 0.02 % | rail 0, Apple 0 |

The difference at idle is within noise; the ~0.4 % in the first two rows is Apple's page under the
pointer. The rail view is one more renderer process: **about 34 MB PSS** (Apple's renderer 307 MB vs
345 MB in the one-window build at the same moment, so the total moved little). Hover open/close ×10:
Apple's page 0 layouts (its view doesn't change), the rail page 3 layouts and 13 style recalcs in
total (its viewport changes twice per cycle; the slide itself is transform-only).

Loops (forced GC before each sample): 50× Lyrics open/close with real clicks, 50× pin/unpin (Ctrl+B)
+ hover open/close, 50 navigations, 5 reloads of Apple's page: rail page 9 listeners, 9 JS
listeners, 98 nodes, 1 document throughout; Apple page JS listeners 7666–7667 over the open/close,
pin and hover cycles; main-process IPC handler, window and view listener counts unchanged; 2 web
contents; active timers 1 → 1.

0.15.29–0.15.30 (rail inside Apple's page) measured the same idle cost and flat counts; that design
is replaced because Apple's logged-in panels (lyrics, queue) are sized against the viewport and slid
under a pinned rail.

**Apple's page grows on in-app navigation, rail or not.** 50 navigations between New, Radio and
Browse, GC'd: 15.5 k → 332 k DOM nodes and 5.3 k → 71.8 k listeners *without* the rail, 15.6 k →
320 k and 5.4 k → 69.3 k with it (about 6.3 k nodes and 1.3 k listeners kept per navigation by
Apple's own code). A reload frees it all (2 k listeners after). Logged in this may differ; see
BACKLOG.

## Not measurable headless

- Real playback: no Apple login, so no track changes, artwork, palette, lyrics,
  notifications, Last.fm or Discord traffic. Their per-track paths were reviewed in
  code only.
- Whether music.apple.com changes its page title on every track (or only on page
  navigation). That decides how fast the stylesheet leak grew in the tray-only state.
  It grew either way, just faster if the title changes per track.
- Minimized rendering: Xvfb has no window manager, so "minimized" windows were not
  really hidden there, and the visualizer's GPU/renderer cost (~2–3 %) didn't drop.
  Under KWin, Chromium's occlusion tracking should pause its rAF loop; not verified.
- Many-hour growth: the cycle test covers 20 window lifetimes, not a full day.

| lyrics retry (main.js lyrics poll) | 30 s, 60 s, then 120 s after a failed lyrics lookup | lyrics window open, same song | success, track change, window close | one lookup per retry; capped backoff |
| lyrics prefetch (main.js prefetchNextLyrics) | once per track change | lyrics window open, current lyrics found | — | one lookup per track; cached in memory and on disk |
| lyrics disk cache (lyrics-store.js) | debounced write 2 s after changes | after a good lookup | write done; flush on quit | ≤ 2,000 entries / 20 MB, LRU; atomic temp+rename |

## Visualizer toast scene (0.15.22)

Isolated harness (throwaway HOME and XDG_RUNTIME_DIR, Xvfb 1920×1080, private D-Bus, basic password
store, software GL because the GPU process can't start under Xvfb), visualizer.html fed mock bands at
43/s plus lyrics and time pushes, 60 s, % of one core:

| Scene | renderer | GPU process |
|---|---|---|
| toast, 0.15.20 (a few beat-spawned toasters) | 56.4 | 9.7 |
| toast, 0.15.22 (full formation, ~40 sprites, lyrics overlay) | 59.6 | 9.9 |
| bars, 0.15.22 (reference, 30 s) | 61.4 | 8.6 |
| toast, 0.15.23 (3D-rendered sprites, smoothed scaling) | 65.7 | 8.7 |

Under software GL most of this is rasterising a full-screen canvas every frame, which every scene does;
the formation itself adds about 3 % (one cached-sprite `drawImage` per visible toaster). On a real GPU the
canvas is GPU-rasterised and these numbers are much lower; that isn't measurable here.

### After Dark flight (Unreleased, branch toaster-flight)

Same harness, run in our own `npm run dist` build (scratch copy, app.asar unpacked, harness as main),
1920×1080, the toast scene measured 5 s after entry for 60 s, A/B in the same build (today's
visualizer.html + toasters.js swapped in for "before"), alternating runs:

| Toast scene | renderer runs | renderer mean | GPU process |
|---|---|---|---|
| before: 0.15.26 formation (54 items, ~34 on screen, re-sorted every frame) | 66.3, 67.3 | 66.8 | 9.0–9.1 |
| after: flight (pool of 49, ~34 on screen once full) | 67.5, 64.5, 67.4, 69.2 | 67.2 | 8.7–10.5 |

No measurable difference (run-to-run spread is ±2–3 %). Per frame the flight is one pass over the
pool and one `drawImage` per visible flyer; the draw order is only re-sorted (in place) when a flyer
launches, the pool never grows except on a resize to a bigger sky, and the flight code creates no
objects per frame
(test/toasters.test.js: same objects over 10,000 frames). Live resize 1920×1080 → 1100×800 kept
every flyer in the air and rescaled them.
