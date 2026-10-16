# Feature comparison: Sonata vs other music players

Research of 2026-10-15, against Sonata 0.15.10 (working tree). Sonata's column was checked in the
code (`main.js`, the four local pages, `lyrics-sources.js`) and, for MPRIS, against the running app
on the session bus (read-only `busctl` query). The other columns come from the sources at the end.

**Legend:** ✓ yes · ✗ no · partial · N/A (does not apply to a streaming client) · **(?)** not confirmed
by a source, best knowledge only.

**Columns:**

- **Apple Music (official)**: the Apple Music app for Windows (Microsoft Store) and Music on macOS.
  Where they differ, the note says which.
- **Spotify**: the Spotify desktop app (Windows/macOS; Linux notes where known).
- **Cider**: the third-party Apple Music client (Electron on Linux/macOS, WebView2 on Windows). Its
  own README (Cider-2) and its website (Cider 4.x) disagree on some audio features; both are noted.
- **Strawberry**: the Linux-native player picked as the reference. It is mostly a local-library
  player, with Subsonic/radio streaming.

A key fact for every audio row: Apple Music on the web (MusicKit JS, which Sonata and Cider both
wrap) streams DRM-protected AAC. Lossless and Atmos are FairPlay-only, so no non-Apple client can
play them (Cider-2 README; Apple developer forums).

## The table

### Playback & queue

| Feature | Sonata | Apple Music (official) | Spotify | Cider | Strawberry |
|---|---|---|---|---|---|
| Play/pause, next/previous, seek, volume | ✓ (page + mini player + tray) | ✓ | ✓ | ✓ | ✓ |
| Shuffle / repeat (off/all/one) | ✓ mini player clicks the page's own buttons, MusicKit fallback | ✓ | ✓ | ✓ | ✓ |
| Up Next / queue view and editing | partial: Apple's web Up Next; the mini player's queue button opens it in the main window | ✓ | ✓ | ✓ | ✓ (playlist-based) |
| Gapless playback | partial: whatever music.apple.com does; Sonata adds nothing **(?)** | ✓ | ✓ | partial: "Seamless transition" MusicKit flag | ✓ (GStreamer) **(?)** |
| Crossfade | ✗ | ✓ (with duration) | ✓ (0–12 s) | ✗ (README: blocked by MusicKit) | ✓ **(?)** |
| Autoplay / radio after the queue ends | partial: Apple web autoplay | ✓ | ✓ | ✓ | ✗ |
| Sleep timer | ✗ | ✗ on desktop **(?)** | ✗ on desktop **(?)** | ✗ **(?)** | ✗ **(?)** |
| Favorite / add to library from the mini player | ✓ star + ⋯ menu (Favorite, Add to Library, Copy Link) | ✓ | ✓ (like) | ✓ | N/A |
| Playback speed | ✗ | ✗ | ✗ (music) | ✗ **(?)** | ✗ **(?)** |

### Now playing & art

| Feature | Sonata | Apple Music (official) | Spotify | Cider | Strawberry |
|---|---|---|---|---|---|
| Mini player | ✓ floating pill: art, transport, shuffle/repeat, progress seek, volume/mute, favorite, explicit badge, lyrics + queue buttons, ⋯ menu | ✓ (Shift+Ctrl+M; can stay on top) | ✓ (Premium; square/rectangle/bar, floats) | ✓ (several skins, incl. Winamp style) | ✗ **(?)** |
| Always-on-top mini player on Wayland | ✓ on KDE (KWin D-Bus script), X11; GNOME Wayland can't | N/A | N/A | **(?)** | N/A |
| Full-screen now-playing view | ✓ visualizer/ambient mode: large art, synced lines, spectrum (Ctrl+Shift+V) | ✓ Full Screen Player (Shift+Ctrl+F) | ✓ full-screen Now Playing | ✓ Immersive mode | ✗ |
| **View the album cover large** (click → big cover) | ✗ (only inside the visualizer; BACKLOG "View the album cover" Planned) | ✓ (full-screen player) | ✓ (expand cover / full screen) | ✓ | ✓ (cover viewer) **(?)** |
| Jump to the playing album | ✓ lyrics cover click opens the album when its link is on screen | ✓ | ✓ | ✓ | N/A |
| Adaptive colour from album art | ✓ mini player + lyrics window (toggle) | ✓ full-screen/lyrics backgrounds **(?)** | ✓ Now Playing background **(?)** | partial (album pages on Android) | ✗ |
| Explicit badge | ✓ mini player | ✓ | ✓ | ✓ | N/A |

### Lyrics

| Feature | Sonata | Apple Music (official) | Spotify | Cider | Strawberry |
|---|---|---|---|---|---|
| Time-synced (line) lyrics | ✓ Apple TTML | macOS ✓; Windows: static at the 2023 launch, newer state unconfirmed **(?)** | ✓ | ✓ | partial: unsynced, many sources **(?)** |
| Word-by-word (karaoke) highlight | ✓ from Apple's syllable timing; sung word scales/glows | ✓ iOS "Sing"; macOS **(?)** | ✗ **(?)** | **(?)** | ✗ |
| Duet sides + background vocals | ✓ singer 1 left, 2 right, together centred; background vocals smaller with own timing | ✓ (Apple Music Sing) | ✗ **(?)** | **(?)** | ✗ |
| Instrumental / interlude countdown | ✓ three dots fill for gaps ≥ ~4 s | ✓ (Apple's dots) | ✗ **(?)** | **(?)** | ✗ |
| Click a line to seek | ✓ | ✓ | ✓ **(?)** | ✓ **(?)** | ✗ |
| Fallback lyrics source | ✓ LRCLIB (toggle, credit line, privacy note) | ✗ | ✗ (Musixmatch only) | **(?)** | ✓ several sources |
| Separate floating lyrics window | ✓ resizable, remembers size, optional on top | ✗ (panel in the app; MiniPlayer lyrics on Windows) | ✗ | ✓ mini player with lyrics | ✗ |
| Translation / romanization | ✗ (BACKLOG Planned) | ✓ iOS/macOS 2025+ **(?)** | ✓ translations **(?)** | **(?)** | ✗ |
| Songwriter credits | ✗ (BACKLOG Planned) | ✓ | ✓ (song credits) | **(?)** | ✗ |
| Lyrics font size / zoom | ✗ (window can be resized, text size fixed) | ✗ **(?)** | ✗ **(?)** | **(?)** | ✗ |

### Desktop integration

| Feature | Sonata | Apple Music (official) | Spotify | Cider | Strawberry |
|---|---|---|---|---|---|
| MPRIS (Linux desktop media widget, playerctl) | partial: **Chromium's built-in MPRIS, no Sonata code.** Live check: bus name `org.mpris.MediaPlayer2.chromium.instanceN`, Identity `apple-music-for-linux` (not "Sonata"), title/artist/album/art present, `mpris:length` = INT64_MAX (no duration, so widgets get no progress bar) | N/A | ✓ (Linux client) | ✓ (`org.mpris.MediaPlayer2.cider`) | ✓ |
| Hardware media keys | partial: through that MPRIS path (desktop routes keys to MPRIS); no own handling | ✓ (Windows, 2023) | ✓ | ✓ | ✓ |
| Global (system-wide) shortcuts | ✗ (shortcuts work only inside the main window; no `globalShortcut`) | ✗ **(?)** | ✗ (in-app only) | **(?)** | ✓ (KDE/GNOME/X11) **(?)** |
| In-app keyboard shortcuts | partial: Ctrl+M, Ctrl+Shift+L (lyrics), Ctrl+Shift+V, Ctrl+D, Ctrl+R, Alt+←/→ in the main window; Ctrl+Shift+L/V in the mini player; visualizer ←/→/Esc; none in the lyrics window | ✓ (play, skip, MiniPlayer, Full Screen, lyrics) | ✓ (long list) | ✓ **(?)** | ✓ |
| System tray icon + menu | ✓ show/hide, mini, visualizer, transport, theme, Last.fm, Discord, updates, settings, quit; tooltip shows the track | ✓ Windows (taskbar controls) **(?)** | partial (Windows/macOS; Linux **(?)**) | ✓ | ✓ |
| Track-change notifications | ✓ with album art (toggle) | ✗ **(?)** | ✓ (option) **(?)** | ✓ | ✓ |
| Close to tray / start minimized / launch at login | ✓ / ✓ / ✓ (own `~/.config/autostart` entry) | partial | ✓ | ✓ | ✓ |
| Single instance, remembers window size | ✓ | ✓ | ✓ | ✓ | ✓ |
| Self-update | ✓ AppImage: checks GitHub every 2 h, verifies SHA-512, restart prompt | ✓ (Store) | ✓ | ✓ (Store/itch) | distro packages |
| App menu integration | ✓ AppImage writes its own .desktop + icon | ✓ | ✓ | ✓ | ✓ |

### Audio

| Feature | Sonata | Apple Music (official) | Spotify | Cider | Strawberry |
|---|---|---|---|---|---|
| Equalizer | ✗ | macOS ✓ (EQ presets/manual); Windows: per-song preset only | ✓ (6-band, presets) | website: ✓ 10-band (32 Hz–16 kHz); Cider-2 README: "possible in the future" | ✓ |
| Volume normalization (Sound Check) | ✗ | ✓ Sound Check | ✓ (on by default) | ✗ **(?)** | ✓ ReplayGain/EBU R128 **(?)** |
| Spatial / enhancer processing | ✗ | ✓ Sound Enhancer (Windows) | ✗ | ✓ Audio Spatialization, "Adrenaline Processor" | ✗ |
| Output device choice in the app | ✗ (system mixer only) | ✓ **(?)** | partial: Spotify Connect devices; exclusive mode on Windows | **(?)** | ✓ (plus bit-perfect on Linux) |
| Lossless | ✗ **not possible** (FairPlay-only) | ✓ up to Hi-Res Lossless | ✓ (FLAC 24/44.1, since 2025-09) | ✗ (same block as Sonata) | ✓ local files |
| Dolby Atmos | ✗ **not possible** | ✓ (Automatic/Always/Off) | N/A | ✗ | N/A |
| Show the stream quality (AAC/lossless badge) | ✗ | ✓ | ✓ | **(?)** | ✓ |
| Audio visualizer | ✓ 4 scenes (Bars, Aurora, Nebula, Toast) from the real output via PipeWire/Pulse, works with DRM | ✗ (iTunes had one) | ✗ | ✗ **(?)** | ✓ analyzer bar |

### Social / scrobbling

| Feature | Sonata | Apple Music (official) | Spotify | Cider | Strawberry |
|---|---|---|---|---|---|
| Last.fm scrobbling | ✓ (user brings own API key + secret) | ✗ | ✓ (account link) | ✓ | ✓ |
| ListenBrainz / Libre.fm / Maloja | ✗ | ✗ | ✗ | ✓ Libre.fm, Maloja | ✓ ListenBrainz |
| Discord Rich Presence | ✓ "Listening to", art, progress (user brings own Discord App ID) | ✗ | ✓ (Discord's own connection) | ✓ | ✓ **(?)** |
| Shared listening / remote control from phone | ✗ | partial (SharePlay on Apple devices) | ✓ Spotify Connect, Jam | ✓ Cider Remote (iOS), Cider Connect | ✗ |
| Copy song link | ✓ mini ⋯ menu | ✓ | ✓ | ✓ | N/A |

### Discovery / library

All streaming clients here get browse, search, radio, playlists and library from the service's own
UI. Sonata and Cider both inherit Apple's catalog features from music.apple.com / MusicKit.

| Feature | Sonata | Apple Music (official) | Spotify | Cider | Strawberry |
|---|---|---|---|---|---|
| Browse, search, radio, library, playlists | ✓ (Apple's web UI) | ✓ | ✓ | ✓ (own UI) | local + Subsonic |
| Back/forward navigation | ✓ Alt+←/→, mouse buttons | ✓ | ✓ | ✓ | N/A |
| Smart playlists / shared playlists | ✗ (web doesn't offer) | ✓ (macOS/Windows library) | partial | ✗ (README: API-limited) | ✓ smart playlists |
| Offline downloads | ✗ not possible (web player) | ✓ | ✓ | ✗ | N/A |
| Local files / tag editing | N/A | ✓ | partial | ✗ | ✓ |

### Appearance

| Feature | Sonata | Apple Music (official) | Spotify | Cider | Strawberry |
|---|---|---|---|---|---|
| Dark/light following the desktop + manual toggle | ✓ (system default, Ctrl+D, remembered) | ✓ | dark only | ✓ | ✓ (Qt theme) |
| Themes / custom CSS | ✗ | ✗ | ✗ | ✓ themes + plugins + marketplace | ✓ Qt styles |
| Plugin system | ✗ | ✗ | ✗ (unofficial Spicetify) | ✓ | ✗ |
| Animated cover touches | ✓ cover flip on track change, progress ring, optional record spin | ✓ animated covers (motion art) **(?)** | ✓ Canvas videos | **(?)** | ✗ |

### Accessibility

| Feature | Sonata | Apple Music (official) | Spotify | Cider | Strawberry |
|---|---|---|---|---|---|
| Screen-reader labels on own controls | partial: main window is Apple's web UI; mini/lyrics/settings buttons have `title` only, no `aria-label` | ✓ **(?)** | ✓ **(?)** | **(?)** | ✓ (Qt) **(?)** |
| Keyboard use of own windows | partial: real `<button>`s, but no visible focus style and no shortcuts in mini/lyrics | ✓ | ✓ | **(?)** | ✓ |
| Reduced motion | ✗ (no `prefers-reduced-motion` in the local pages; record spin is off by default) | ✓ (follows OS) **(?)** | **(?)** | **(?)** | N/A |
| Adjustable text size | partial: main window Chromium zoom **(?)**; lyrics text fixed | ✓ | ✓ (zoom) | **(?)** | ✓ |

### Performance / footprint

| Feature | Sonata | Apple Music (official) | Spotify | Cider | Strawberry |
|---|---|---|---|---|---|
| Runtime | Electron (castlabs, Widevine) | native (WinUI/AppKit) **(?)** | CEF (Chromium) | Electron / WebView2 | native Qt/C++ |
| Measured idle cost | tray-only: one 5 s poll, 0.02–0.07 % of one core (main process); ~680 MB working set, all processes (docs/PERFORMANCE.md) | not measured | not measured | not measured | not measured |
| Loops/lifetimes audited | ✓ every loop has a verdict (docs/PERFORMANCE.md) | N/A | N/A | N/A | N/A |
| Linux availability | ✓ (x86-64; no ARM: no Widevine) | ✗ no Linux app | ✓ | ✓ | ✓ |

## Where Sonata leads

Features that none (or almost none) of the compared players offer:

1. **Apple's full lyrics data on Linux at Apple-device level:** word-by-word karaoke highlight,
   duet sides, separately timed background vocals and interlude countdown dots. The official app
   does this only on Apple devices; on Windows it was static. Cider's support for word timing and
   duets is unconfirmed.
2. **A floating lyrics window** that stays on top (on KDE Wayland too), is resizable, remembers its
   size, and has a round cover with a progress ring that jumps to the album. No other player here
   has a separate lyrics window.
3. **LRCLIB fallback** when Apple has no lyrics, with a credit line and an opt-out. No other
   Apple Music client here has one.
4. **An audio-reactive visualizer that works despite DRM.** It reads the real output through
   PipeWire/PulseAudio and has four scenes. Spotify, Apple's current apps and Cider have no visualizer.
5. **Last.fm and Discord built in.** The official Apple app has neither. Spotify has them only
   through server-side account links.
6. **Adaptive album colour** across the mini player and the lyrics window.
7. **Always-on-top on KDE Wayland.** Other Electron clients can't set this there.
8. **Measured lightness:** tray-only idle is a single 5 s poll, and every loop and lifetime is
   documented. No other client here publishes numbers.
9. **Self-installing, self-updating AppImage** with checksum verification and no store needed.

## Gaps, ranked

Ranked by value to a daily Apple Music listener on Linux versus effort. Effort: **S** = hours,
**M** = a day or two, **L** = a week+ or a research spike. The feasibility notes say what an
Electron wrapper around music.apple.com can reach.

| # | Gap | Value | Effort | Feasibility |
|---|---|---|---|---|
| 1 | **View the album cover large** (BACKLOG Planned) | High: a basic every player has | **S** | Easy. MusicKit's artwork URL is a template (`{w}x{h}`), so a 1000–3000 px image can be requested. Open it in an overlay or small window from a click on the mini/lyrics cover or a ⋯ menu item. |
| 2 | **MPRIS polish**: Identity says `apple-music-for-linux`, and there's no track length, so desktop widgets show no progress or seek | High: the Plasma/GNOME media widget, lock screen and KDE Connect all read it | **S** | Chromium builds MPRIS from the page's Media Session. Inject `navigator.mediaSession.setPositionState({duration, position})` from the existing poll to fill in length/position. **(?)** whether music.apple.com overwrites it. The Identity comes from the app/package name; set it with `app.setName('Sonata')`, or rename the package carefully (the userData path depends on it). Media keys already work through this path. |
| 3 | **Easier Discord and Last.fm setup.** Today the user must make their own Discord App ID and Last.fm API key and edit config files | High: most users stop at "create an application" | **S** (Discord) / **M** (Last.fm) | A Discord Application ID is public, so Sonata can ship one named "Sonata" (or "Apple Music"). A Last.fm API key can ship, but its shared secret then sits in an open-source app. Many open-source scrobblers accept that **(?)**. Otherwise keep bring-your-own as the advanced path. |
| 4 | **Global shortcuts** (play/pause/next/mini/lyrics without focusing the window) | Medium-high | **S–M** | Electron `globalShortcut` works on X11. On Wayland, Electron supports the XDG GlobalShortcuts portal with `--enable-features=GlobalShortcutsPortal` (Electron PR #45171). The compositor must implement the portal (KDE yes; GNOME 48+ **(?)**). Shortcuts should be user-set and off by default, so they don't fight media keys. |
| 5 | **Keyboard and accessibility pass on own windows**: `aria-label`s, visible focus, `prefers-reduced-motion`, keys in the mini player/lyrics (Space, ←/→ seek, Esc), a lyrics shortcut in the main window and a tray item | Medium (Marcy's UI standard) | **S** | All local HTML, no platform limits. Reduced motion should stop the cover flip, word scale and spin. |
| 6 | **Lyrics translations / romanization + songwriter credits** (BACKLOG Planned) | Medium | **M** | Only when Apple's lyrics payload has them. The current fetch uses `/songs/{id}/lyrics` TTML. Translations may need the `syllable-lyrics` endpoint or extra `l=` parameters **(?)**; a spike is needed. Credits may be in the TTML `<head>` metadata **(?)**. |
| 7 | **Equalizer** | Medium-high (asked for in every comparison; Spotify, Cider and Strawberry have one) | **M–L** | Two routes. (a) Web Audio: hook MusicKit's `<audio>`/`<video>` element with `createMediaElementSource` + `BiquadFilterNode`s. For EME-protected media, browsers are allowed to output silence, and Chromium's behaviour with castlabs Widevine is **unconfirmed**. Cider advertises a 10-band EQ, which suggests it can work, but Cider-2's README called its audio stack "reduced". A 1-hour spike decides it. (b) PipeWire: put a `filter-chain` EQ on Sonata's own stream. It works regardless of DRM, and Sonata already depends on PipeWire/Pulse for the visualizer. It's Linux-only, but Sonata is Linux-only. Route (b) is the safe bet. |
| 8 | **Output device choice in the app** | Medium | **S–M** | `HTMLMediaElement.setSinkId()` on MusicKit's media element (device list from `enumerateDevices`). Whether it works with EME playback is likely but unconfirmed **(?)**. Fallback: move Sonata's PipeWire stream with `pactl move-sink-input`/`pw-metadata`, which always works. |
| 9 | Volume normalization (Sound Check) | Medium | **L** | MusicKit JS exposes no Sound Check **(?)**. A Web Audio `DynamicsCompressorNode` or a PipeWire loudness filter would only approximate it (no per-track gain data), with the same DRM question as #7. |
| 10 | Quality indicator (AAC 256 / Atmos-not-available) | Low-medium | **S** | Always AAC on the web, so it is a static badge. Useful mainly to set expectations: "Lossless isn't available outside Apple devices". |
| 11 | Sleep timer | Low-medium | **S** | Pure app logic: a timer, then `MusicKit.pause()` (fade with `mk.volume`). Tray + mini ⋯ menu. |
| 12 | ListenBrainz / other scrobblers | Low-medium | **S** | Same scrobble timing as Last.fm. ListenBrainz needs only a user token, so setup is easier than Last.fm. |
| 13 | Lyrics text size | Low-medium | **S** | CSS variable plus Ctrl +/− in the lyrics window. |
| 14 | Mini player size variants (Spotify: square/rectangle/bar) | Low | **M** | Local HTML/window sizes. |
| 15 | Phone remote control (Cider Remote, Spotify Connect) | Low-medium | **L** | KDE Connect already controls Sonata through MPRIS, so fixing #2 covers most of this. An own remote isn't worth it. |
| 16 | Themes / custom CSS / plugins | Low | **M** | Possible (the CSS replacer already injects into the page), but it adds support load. |
| — | Crossfade | — | **not feasible** | Needs two decoders overlapping. MusicKit JS plays one item at a time, and Cider's README lists crossfade as blocked by MusicKit. |
| — | Lossless / Hi-Res / Dolby Atmos | — | **not feasible** | These streams are FairPlay-only. MusicKit JS on Widevine gets AAC (Cider-2 README, Apple forums). |
| — | Offline downloads | — | **not feasible** | The web player has no download path (DRM licence). |

**Top 8 by value/effort:** #1 cover view, #2 MPRIS polish, #3 Discord/Last.fm setup, #4 global
shortcuts, #5 keyboard/a11y pass, #6 lyrics translations + credits, #7 EQ (spike first, PipeWire as
the safe route), #8 output device.

## Sources

- Cider website (feature list, 10-band EQ, scrobblers, remote): https://cider.sh/
- Cider-2 README (lossless/crossfade/EQ/smart playlist limits, platforms): https://github.com/ciderapp/Cider-2
- Cider on Flathub: https://flathub.org/apps/sh.cider.Cider
- Cider legacy docs (MPRIS name): https://v2.cider.sh/docs/legacy-docs/support/technical-faqs
- OMG! Ubuntu on Cider (MPRIS, tray, notifications): https://www.omgubuntu.co.uk/2022/07/cider-is-an-open-source-apple-music-client-for-linux-desktops
- Cider developer posts on DRM and lossless: https://itch.io/t/4752556/audio-quality
- Apple Music for Windows, playback settings: https://support.apple.com/guide/music-windows/playback-settings-musdf855a1b/windows
- Apple Music for Windows, keyboard shortcuts: https://support.apple.com/guide/music-windows/mus1019
- Apple Music for Windows, MiniPlayer: https://support.apple.com/en-ie/guide/music-windows/mus71d7dcfce/windows
- Apple Music for Windows, equalizer (per-song): https://support.apple.com/guide/music-windows/museb684a3de/windows
- 9to5Mac, Windows media keys + static lyrics (2023): https://9to5mac.com/2023/04/25/apple-music-windows-media-keys-lyrics-more/
- MacStories hands-on, Apple Music for Windows: https://www.macstories.net/stories/hands-on-with-apple-music-for-windows/
- TechCrunch, Apple Music Sing (word timing, duets, background vocals): https://techcrunch.com/2022/12/06/apple-music-is-getting-a-new-karaoke-like-feature-apple-sing
- 9to5Mac, time-synced lyrics on Mac: https://9to5mac.com/2020/03/26/mac-how-to-use-time-synced-lyrics-apple-music/
- Apple Developer Forums, no lossless in MusicKit JS: https://developer.apple.com/forums/thread/683021
- Spotify keyboard shortcuts: https://support.spotify.com/us/article/Keyboard-shortcuts/
- Spotify exclusive mode: https://support.spotify.com/mk/article/exclusive-mode/
- Spotify desktop equalizer (Community, Implemented Ideas): https://community.spotify.com/t5/Implemented-Ideas/Desktop-Equalizer-for-the-Desktop-Version/idi-p/1207205
- Spotify crossfade (third-party guide): https://freeyourmusic.com/blog/crossfade-spotify
- Spotify Miniplayer launch (TechRadar): https://www.techradar.com/computing/software/spotify-finally-unveils-a-desktop-app-miniplayer-to-end-window-juggling-but-theres-a-catch
- Spotify Lossless launch (9to5Google): https://9to5google.com/2025/09/10/spotify-finally-adds-lossless-24-bit-audio-quality/
- TIDAL exclusive mode: https://support.tidal.com/hc/en-us/articles/28548110049681-Exclusive-Mode
- Tom's Guide, TIDAL features: https://www.tomsguide.com/how-to/tidal-features-tips-tricks
- Strawberry features: https://www.strawberrymusicplayer.org/
- YouTube Music desktop (th-ch) plugin list (equalizer, crossfade, compressor, custom output device, synced lyrics… possible there because YouTube audio is not DRM-encrypted): https://github.com/th-ch/youtube-music/tree/master/src/plugins
- Electron globalShortcut (Wayland portal): https://www.electronjs.org/docs/latest/api/global-shortcut
- Electron PR #45171, GlobalShortcutsPortal: https://github.com/electron/electron/pull/45171
- W3C public-audio thread on Web Audio + EME (silence for protected media): https://lists.w3.org/Archives/Public/public-audio/2014JanMar/0034.html

TIDAL and YouTube Music desktop were researched for the Gaps list but left out of the table to keep
it readable. TIDAL leads on output (exclusive mode, force volume, Max quality). The th-ch YouTube
Music client has the widest plugin set, which DRM-free audio makes possible.
