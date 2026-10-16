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
| Feature comparison vs other players | **Building** | docs/FEATURE-COMPARISON.md: what common music players offer vs Sonata; gaps become backlog rows. |
