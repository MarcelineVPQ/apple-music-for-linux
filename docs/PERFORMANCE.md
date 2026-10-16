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

Nothing else runs: palette extraction and lyrics lookups only happen while the mini
player or lyrics window is open. Per track change there is at most one artwork fetch
plus one `Notification` (notifications on), one Last.fm now-playing call and one
Discord update. None of these objects is stored.

## Loop table

| Where | Loop | Period | Runs while | Stops on | Cost / verdict |
|---|---|---|---|---|---|
| main.js `startNowPlayingLoop` | now-playing poll | 5 s | always (the tray always exists) | app exit | 1 `executeJavaScript`/5 s, 0.02–0.07 % main CPU. Needed, left as is |
| main.js `createMiniWindow` | mini poll | 1 s | mini window exists, including minimized/paused | mini `closed`, main `close` | 1 read/s, 0.05 % main CPU. Left as is |
| main.js `createLyricsWindow` | lyrics poll | 500 ms | lyrics window exists, including minimized/paused | lyrics `closed`, main `close` | 2 reads/s plus one lyrics lookup per track (cached). Left as is |
| main.js `createVizWindow` | visualizer poll | 300 ms | visualizer exists | viz `closed` | 3.3 reads/s. Left as is (fullscreen, foreground-only mode) |
| visualizer.js | parec → FFT → IPC | ~43 frames/s | visualizer exists | viz `closed` (`stop()` kills parec) | 1 FFT + 1 IPC send per frame. Left as is |
| visualizer.html `frame` | requestAnimationFrame | display rate | window visible (Chromium pauses rAF when hidden) | window close | one canvas frame. Left as is: ambient modes animate on purpose |
| visualizer.html `showLabel` | label fade | 1.4 s one-shot | after a mode switch | fires; cleared before re-arm | ~0 |
| main.js `startUpdateChecks` | update check | 20 s once, then 2 h | AppImage builds | app exit | 1 small GET/2 h; `updateCheckBusy` prevents overlap |
| main.js `persistBounds`, `rememberBounds` | bounds save debounce | 500 ms one-shot | after a move/resize | fires | ~0; checks `isDestroyed()` |
| main.js mini/lyrics keep-above | KWin keep-above | 300 ms one-shot | once per window open | fires | one qdbus call, KDE Wayland only |
| miniplayer / lyrics / settings .html | — | — | — | — | no loops; they only react to IPC pushes |

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
| visualizer.js `emit` | two 16 KB `Float64Array`s per frame | short-lived young-generation garbage while the visualizer is open. Cosmetic, left as is |
| renderer pages | `ipcRenderer.on` listeners | added once at load. lyrics.html replaces its line elements per track. miniplayer.html swaps the artwork `src` only on a track change |

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
