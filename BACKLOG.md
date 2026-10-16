# Sonata backlog

One list for planned work. Status words: **Planned**, **Building**, **Done**.

| Item | Status | Notes |
|------|--------|-------|
| 0.15.10: LRCLIB lyrics fallback | **Done** | Apple first, then lrclib.net; Settings → LRCLIB lyrics; credit line; unsynced lyrics shown plain. |
| 0.15.10: loop / lifetime / error pass | **Building** | DS5-style verdicts, docs/PERFORMANCE.md; tray-idle cost first; code changes only for measured problems. |
| 0.15.10: karaoke word highlight | **Done** | Apple TTML word timing; the sung word pops (scale + glow, no line jitter); local time interpolation only while the lyrics window is visible. |
| 0.15.10: interlude countdown dots | **Done** | Gaps of about 4 s or more (intro, breaks): three dots fill as a countdown; TTML line ends, LRC empty stamps. |
| 0.15.10: duets and background vocals | **Done** | TTML singer marks: singer 1 left, singer 2 right, together centered; background vocals smaller and dimmer under the line, with their own word timing. |
| 0.15.10: album art in the lyrics header | **Done** | Round cover left of the title (the mini player's artwork URL); no art, no cover. Background unchanged. |
| 0.15.10: progress ring and cover flip | **Done** | Thin accent ring fills with song progress (≤ 4 updates/s, visible only); the cover flips (rotateY) on a track change. |
| 0.15.10: click the cover to show the album | **Done** | Brings the main window to the front and clicks the page's own link to the playing album when one is on screen; otherwise only shows the window. |
| 0.15.10: spin album art like a record | **Done** | Settings switch, off by default; 9 s per turn, only while playing and visible. |
| 0.15.10: scaled words stay inside the padding | **Done** | The sung word grows inward at a row's start (left lines) or end (right lines). |
| After 0.15.10: romanization and translations | **Planned** | From Apple's lyrics data when present; a toggle in the lyrics window, shown only when the song has it. |
| After 0.15.10: songwriter credits | **Planned** | "Written by …" at the end of the lyrics, from the same data. |
| After 0.15.10: Electron update (own release) | **Planned** | castlabs 42.3.3 → 44.5.1+wvcus (stable 2026-10-03), then 45 once castlabs ships it stable. Must stay castlabs (Widevine). |
| After 0.15.10: CI on GitHub | **Planned** | Tests on every push; CI checked after every push (first-class standard). |
| After 0.15.10: gate tests | **Planned** | Every loop has a `// loop:` verdict; no duplicate code. |
| After 0.15.10: CHANGELOG and release checklist | **Planned** | Same release discipline as the other projects. |
| After 0.15.10: karaoke mode | **Idea** | A full karaoke experience built on word timing, countdown dots and duets. Design first. |
| Light mode active-line contrast | **Planned** | With album colours off, the active line is near-white on the light card (existing issue). |
| View the album cover | **Planned** | Open the cover large (click or menu), as most players do. A missing basic feature. |
| Feature comparison vs other players | **Done** | docs/FEATURE-COMPARISON.md: what common music players offer vs Sonata; gaps become backlog rows. |
| MPRIS fixes | **Planned** | (S) Desktop media widgets show no track length/progress (mpris:length unset) and the player is named "apple-music-for-linux", not Sonata. See docs/FEATURE-COMPARISON.md. |
| Global shortcuts | **Planned** | (S–M) X11 directly; Wayland via the GlobalShortcuts portal (KDE supports it). |
| Keyboard and accessibility pass | **Planned** | (S) aria labels, visible focus, reduced motion, keys in the mini player and lyrics; a lyrics shortcut and tray item. |
| Easier Discord / Last.fm setup | **Planned** | (S/M) Ship a Discord app id; a Last.fm key can't ship its secret in open source. |
| Equalizer | **Idea** | (M–L) A one-hour test first: Web Audio on DRM playback may be silent; PipeWire EQ on Sonata's stream is the safe route. |
| Output device choice | **Idea** | (S–M) setSinkId likely works; fallback is moving the PipeWire stream. |
| Estimated word timing for line-only lyrics | **Done** | Spread each line's time across its words (weighted by length). An option, clearly marked "estimated"; no resources. |
| Real word timing by forced alignment (flagship) | **Idea** | The differentiator: what Apple does with paid human syncing, done locally for a free app. Isolate the vocals from Sonata's captured output (the same capture as the visualizer), align the known lyrics, cache per song. GPU (CUDA) when available; opt-in; local only (DRM grey area for shipping to everyone). Experiment on Marcy's machine first: models, latency, accuracy vs Apple's own syllable data. Showcase for the 42 Pixel Studios front page. |
| Main-window lyrics vs pop-out | **Idea** | The main window's lyrics panel is Apple's own web view (line highlight only). Options: route its lyrics button to Sonata's pop-out (small), restyle Apple's panel (fragile), or leave it. Marcy is thinking about it. |
