# Sonata

**An unofficial Apple Music desktop app for Linux, with word-by-word lyrics you can sing along to.**

Apple's word-by-word lyrics on Linux, free and open source, with duets, background vocals and interlude dots. When Apple only has line timing, Sonata estimates the words and says so; when Apple has no lyrics, it falls back to LRCLIB.

<!--
HERO GIF: docs/media/lyrics-hero.gif (not recorded yet). What to record, exactly:
- The Sonata lyrics window on its own, about 420 x 620 px, dark desktop behind it, nothing else on screen.
- A song with Apple's word-by-word (syllable) lyrics AND a duet, so one take shows: the sung word
  popping and glowing in the album colour, singer 1 on the left, singer 2 on the right, a background
  vocal under a line, and the three countdown dots filling before the next verse.
- The vinyl cover in the header with its progress ring, and one track change so the cover flips.
- 8-12 seconds, 24 fps, under 5 MB. Full shot list and gifski/ffmpeg settings:
  ~/projects/marketing/sonata/recording-plan.md (outside the repo).
Put this back above the disclaimer once the file exists (until then it would show as a broken image):
<p align="center">
  <img src="docs/media/lyrics-hero.gif" alt="Sonata's lyrics window: the sung word lights up word by word, duet lines sit left and right, and the album cover turns like a small vinyl record" width="420">
</p>
-->

> Sonata is not affiliated with, endorsed by, or sponsored by Apple Inc. "Apple Music" and "Apple" are trademarks of Apple Inc. You need your own Apple Music subscription.

Sonata is free and open source (GPL-3.0), made by one developer under 42 Pixel Studios. It will never be sold.

## Install

**[Download the AppImage from Releases](https://github.com/MarcelineVPQ/sonata-releases/releases/latest)** (x86-64), then:

```bash
chmod +x sonata-*.AppImage
./sonata-*.AppImage
```

- The first run adds Sonata to your app menu (desktop entry and icon, kept in sync if you move the file).
- **It updates itself** (see [Updates](#updates)): it checks every two hours and installs a new release only if the update feed's Ed25519 signature checks out and the download matches the feed's size and SHA-512. Anything else is refused and the reason is shown.
- **Flatpak: coming.** A Sonata Flatpak repository that installs from KDE Discover (and GNOME Software) is planned.

> **Raspberry Pi / ARM:** not supported. Google publishes no Widevine DRM module for desktop linux-arm64, so no Chromium or Electron app can play Apple Music there.

## Features

### Lyrics

Open the lyrics window from the rail's Lyrics item, the mini player's lyrics button (or its ⋯ menu) or Ctrl+Shift+L. It floats on top, resizes, and remembers its size.

- **Word-by-word karaoke** with Apple's own timing: the word being sung pops and glows, without the line jumping around. Click any line to jump there.
- **Estimated word timing** for songs that only have line timing: each line's time is spread across its words, weighted by word length. It is marked "Word timing estimated", and Settings → *Estimated word timing* turns it off.
- **LRCLIB lyrics** for songs Apple has no lyrics for, from [lrclib.net](https://lrclib.net), a free, community-run lyrics database. A credit line shows when they're from LRCLIB. If the service is busy, the window says so and tries again on its own.
- **Countdown dots** for intros and instrumental breaks of about 4 seconds or more: three dots fill up until the singing starts again.
- **Duets:** singer 1 on the left, singer 2 on the right, together in the middle.
- **Backing vocals** sit smaller and dimmer under the main line, with their own word timing.
- **The vinyl cover:** the album art becomes a little record with grooves and a spindle hole, inside a ring that fills with the song's progress. It flips on a track change; click it to open the album. Optionally it spins, either at a relaxed pace or at true speed (33⅓ rpm for albums, 45 for singles and EPs).
- **A tonearm** rests on the spinning record and moves inward as the song plays.
- **Songwriter credits:** the lyrics end with "Written by …" when Apple has the song's writers.
- **View the album cover:** right-click the cover in the lyrics window or the mini player (or View Album Cover in the mini player's menu) and it opens large in the middle of the screen.
- **By keyboard:** Tab lands on the line being sung, ↑ / ↓ move, Enter or Space plays from that line, Esc closes the window.
- **Offline lyrics cache:** songs you've played before show their lyrics instantly, even offline (about 2,000 songs / 20 MB, oldest dropped first). The next song in your queue is looked up ahead of time while the lyrics window is open.

### The Studio

The lyrics window can grow into the Studio, a full now-playing screen: the lyrics big in the middle; the cover, the song, its place in the queue ("Track 13 of 24"), the venue of a live album, the controls and the song's actions (Favorite, Add to Library, Add to a Playlist, Copy Link, Go to Album, Go to Artist, More) on the left; one list on the right: the songs played, the one playing, the next song's card with a "Next · in 1:22" countdown, then the rest. Click a song in the list to play it; each row has a menu. Click the cover (or press C) to turn it over to the song's credits. With Settings → Experimental → Sheet notes in the Studio on, the sung melody plays out above the lyrics or just above the line being sung. Open it with Studio, the first item on the rail, the button in the lyrics window's header or Ctrl+Shift+S; the same button or key shrinks it back to the lyrics window. Sonata remembers which one you used last, and the size of each.

- **Montage** (a tile in the Studio, off until you turn it on): free photos of the artist, the band live and a live album's venue drift slowly behind the lyrics. They come from Wikimedia Commons, only freely licensed ones, and each shows who took it and its licence. The lyrics stay readable over every photo.
- **Liner notes:** the album as a CD booklet you page through: the cover and the disc, Apple Music's notes on the album, where and when it was recorded, the album's Wikipedia article, who played and who wrote each song, the lyrics of songs you've played, and real booklet scans where the Cover Art Archive has them. Every block says where it comes from. Open it from the Studio's Liner notes tile, or Liner Notes… in the lyrics window cover's menu or the mini player's menus; click the right-hand page to turn forward and the left-hand page to turn back (or ← / →), Esc closes it. For live albums, setlist.fm adds the show's setlist with your own free key (Settings → Integrations).

### Precise word timing (optional, experimental)

For songs with line timing only, Sonata can work out where each word is really sung, on your own computer: it separates the vocals from what's playing and lines the lyrics up with them, after the song has played once with the lyrics open. Audio stays in memory; only the word times are kept. It needs the sonata-align helper, a separate program with its own licence, installed from the Sonata source with `align/install.sh`: it downloads the helper release this Sonata pins (`align/engine.json`), checks its size, SHA-256 and signature, shows its licence and asks before installing into `~/.local/share/sonata-align` (the GPU build is about 7 GB with its Python packages and uses an NVIDIA graphics card; `--cpu` makes a slower CPU-only build of about 1 GB). Deleting that folder removes it. Once it's installed, Settings → Precise timing shows the switch. While a game runs it pauses by itself (Settings → *Pause word timing while gaming*). Details: [docs/LEVEL2-ALIGN.md](docs/LEVEL2-ALIGN.md).

*Refine timing by listening* (also under Precise timing, no helper needed) nudges estimated words toward where it hears them sung.

### Player

- **Navigation rail:** a slim bar on the right edge of the main window with Studio, Lyrics, Visualizer, Mini Player, Settings and About. It shows icons only and slides open over the page when you point at it or Tab to it, then closes again after you pick something. Press **Ctrl+B** (or its pin button) to keep it open: the page then makes room for it, and Sonata remembers that. The small lock in its bottom corner does the opposite: it keeps the rail small (icons only), so it no longer opens when you point at it; click again to unlock. Pinning and locking exclude each other. An item is marked while its window is open, and each tooltip names the item's shortcut. At the bottom it shows Last.fm, Discord and precise word timing, each with a symbol and words (not just a coloured dot). On the Development channel it also shows a *Development* badge with the version. It takes on the album's colour and follows light/dark mode. From the keyboard: Tab past either end of the page (or F6) reaches it, ↑ / ↓ move, Enter or Space opens, Esc closes, Tab leaves it. Settings and About open in the [side panel](#settings-and-about); pressing the item again hides it, and a dot on the item says something is waiting there (an update, what's new). The rail has its own space beside Apple's page, so it never covers anything of Apple's, signed in or not. The tray, menus and shortcuts all still work as before.
- **System tray:** click to hide or show the window; right-click for play/pause, next, previous, mini player, visualizer, dark mode, settings and quit. Music keeps playing while the window is hidden.
- **Mini player** (Ctrl+M): an always-on-top pill shaped like Apple Music's own player bar: shuffle, previous / play-pause / next and repeat on the left; the artwork, title and artist with a thin progress line in the middle; lyrics, Up Next, mute and a volume slider on the right; favourite and a ⋯ menu (Add to Library, Copy Link, Lyrics, Visualizer, Always on Top). Point at the middle and it turns into a scrubber with the elapsed and remaining time: click or drag to seek, or ← / → (5 s) when it has the focus. The mouse wheel over the volume (or the speaker) changes it in 5 % steps, also over the volume in Apple's player bar. On KDE (X11) the desktop behind the pill is blurred. Drag it anywhere.
- **Visualizer / ambient mode** (Ctrl+Shift+V): full-screen album art, synced lyrics and a real-time spectrum from the actual audio output (captured through PipeWire/PulseAudio, so it works with Apple's DRM). Four scenes: **Bars**, **Aurora** (a Flurry homage), **Nebula** (an iTunes-visualizer homage) and **Toast** (pixel-art winged toasters that flap to the beat, an After Dark wink). Click or ← / → to change, Esc to leave.
- **Adaptive album colours and Glass:** every Sonata window (the rail, the side panel, the mini player, the lyrics window) takes its colours from the current album art, and the sung lyric line lights up in the album's colour. With *Glass* on (Settings → Appearance, the default), they share a translucent material made from the artwork, blurred and tinted. Words always keep at least 4.5:1 contrast, dimmed lyric lines 3:1, over any artwork.
- **Dark mode** follows your desktop (the XDG portal or KDE's colour scheme, not only the GTK theme); Ctrl+D or Settings → Appearance → Theme switches by hand and is remembered.
- Back / forward with Alt+← / Alt+→ and the mouse buttons; window size and position are remembered.

### Integration

- **Last.fm scrobbling** by Last.fm's rules (tracks over 30 s, after half the track or 4 minutes). [Setup](#lastfm-scrobbling).
- **Discord Rich Presence:** "Listening to" with track, artist, album art and progress. [Setup](#discord-presence).
- **Track-change notifications** with album art (toggle in Settings).
- **Global shortcuts** (Settings → Global shortcuts, off by default): play or pause, next and previous song, and the lyrics window from any app (suggested Ctrl+Alt+P, Ctrl+Alt+Page Down, Ctrl+Alt+Page Up, Ctrl+Alt+Y). On Wayland your desktop asks once and keeps the keys in its own settings. Media keys work without this.
- Settings for close to tray, start minimized and launch at login.

### Settings and About

Settings and About open in a panel beside Apple's page (the rail's Settings and About items, the tray's *Settings…* and *About Sonata*). Apple's page makes room for it; in a narrow window it slides in as a drawer over the page instead (Esc closes it). Settings are grouped in sections: Playback & lyrics, Precise timing, Appearance, Mini player & windows, Global shortcuts, Integrations (Last.fm, Discord, setlist.fm), Updates, Startup and Experimental (switches still being tested, off until you turn them on). Each header says the current state in a few words. One section is open at a time; pin the ones you want to keep open (the dot in a header's corner). The ⋮ menu collapses all sections or clears the pins. Sonata remembers it all. About opens on Sonata's card (the version, the update channel and links to the site, the source and issues), then App changes (what's new in your version), Coming soon, Credits (every third-party part and its licence), Graphics (what this start uses: hardware acceleration, the Experimental switches, and Sonata's CPU use while it is open) and For the Curious (honest numbers on how Sonata hears your music, read only while the section is open, with Copy for a bug report).

Messages (a Last.fm step, an update, a repaired file) appear at the top of the panel or in their section, with their buttons and a × to dismiss. Short confirmations show for a few seconds at the bottom right of the page.

If Sonata's settings file or lyrics cache is ever damaged, Sonata keeps everything that still reads, sets only the damaged parts back to their defaults, keeps a copy of the damaged file beside it (`*.corrupt-<date>`), and tells you once.

### Updates

- **Signed updates** (see [Install](#install)). Nothing installs unless the feed's signature, the file's size and its SHA-512 all check out.
- **What you see:** "Sonata X is available" with *Update* and *Details* (the release notes), a progress bar while it downloads, then "Sonata X is installed" with *Restart now* (only while nothing plays; otherwise it starts the next time you open Sonata), and after the restart "Updated to X" with *See what's new*. In the tray-only state a desktop notification says it once.
- **Install updates automatically** (Settings → Updates; Sonata asks once): updates download and install by themselves and start next time. Off: Sonata asks each time.
- **Check for updates automatically** (on by default): every two hours. Off: Sonata goes online for updates only when you press *Check now* (or the tray's *Check for Updates…*).
- **Two channels:** **Stable** (default) gets tested releases; **Development** also gets development builds (`X.Y.Z-dev.N`) as soon as they're out. Stable never sees development builds. Switching back to Stable never installs an older version by itself; **Back to stable** (Settings → Updates, on Development) installs the newest stable release even if it's older, after asking.
- Never a downgrade otherwise, and never over the AppImage that is running: the new file goes beside it and `Sonata.AppImage` (the menu entry's link) points to it.
- How it works step by step, and how to check a download yourself with its build attestation: [How it's built and tested](#how-its-built-and-tested).

<!--
SCREENSHOTS: not recorded yet. Put this section back (heading "## Screenshots" and the table below)
once the files exist; until then the images would show as broken.
Placeholders (shot list: ~/projects/marketing/sonata/recording-plan.md):
- docs/media/lyrics-duet.png       lyrics window mid-duet: left/right singers, a backing vocal, album-colour glow
- docs/media/lyrics-lrclib.png     a song Apple has no lyrics for, showing the "Lyrics from LRCLIB" credit line
- docs/media/mini-player.png       mini player floating over a desktop, with the lyrics window beside it
- docs/media/visualizer.png        visualizer in the Aurora or Nebula scene with a synced lyric line
Capture with Spectacle (window mode, no shadow), PNG, 2x scale if possible, then optimise with oxipng/pngquant.

| Lyrics, duet | Lyrics from LRCLIB |
| --- | --- |
| ![Lyrics window during a duet, with singers on the left and right](docs/media/lyrics-duet.png) | ![Lyrics window showing lyrics from LRCLIB](docs/media/lyrics-lrclib.png) |
| **Mini player** | **Visualizer** |
| ![Mini player with the lyrics window beside it](docs/media/mini-player.png) | ![Visualizer with album art, spectrum and a synced lyric](docs/media/visualizer.png) |
-->

## Privacy

Sonata talks to Apple (through the Apple Music web player you sign in to) and, only when Apple has no lyrics for a song, to lrclib.net: it sends that song's **title, artist, album and length**, with Sonata's name and version as the user agent. Nothing else, no account, no analytics. Turn it off in Settings → *LRCLIB lyrics*. Last.fm and Discord are only contacted once you connect them. Update checks fetch a signed file from this GitHub repository.

## Keyboard shortcuts

| Shortcut | Action |
| --- | --- |
| `Ctrl+M` | Toggle mini player |
| `Ctrl+Shift+S` | Open the Studio (the lyrics with the song and what plays next), or shrink it back to the lyrics window |
| `Ctrl+Shift+L` | Toggle lyrics (also in the mini player, the lyrics window and the visualizer) |
| `Ctrl+Shift+V` | Toggle visualizer (also in the mini player; ← / → or click to change scene, Esc to exit) |
| `Ctrl+Alt+P`, `Ctrl+Alt+PageDown`, `Ctrl+Alt+PageUp`, `Ctrl+Alt+Y` | Global shortcuts, from any app, when turned on: play / pause, next, previous, lyrics (suggested keys; you can change them) |
| `Ctrl+B` | Pin / unpin the navigation rail (remembered) |
| `F6` | Move the keyboard between Apple's page, the side panel (when shown) and the navigation rail |
| `Ctrl+D` | Toggle dark / light mode |
| `Alt+←` / `Alt+→` | Back / forward (mouse back/forward buttons work too) |
| `Ctrl+R` | Reload |

## FAQ

**Why isn't Sonata on Flathub?**
Flathub's current rules need a hand-written manifest and a long volunteer review, which doesn't fit a one-person project right now. Sonata will have its own Flatpak repository instead, so it can still install and update from Discover. Flathub stays possible later.

**What about DRM?**
Apple Music on the web uses Widevine DRM. Sonata is built on [castlabs' Electron](https://github.com/castlabs/electron-releases), which downloads Google's Widevine module at runtime (it is not bundled). That is why there is no ARM build: Google publishes no desktop linux-arm64 Widevine module.

**Lossless? Dolby Atmos? Downloads?**
Not possible. Lossless and Atmos streams are FairPlay-only, so outside Apple's own apps the Apple Music web player gets AAC. The same goes for offline downloads. This holds for every third-party Apple Music app, not only Sonata.

**Sonata doesn't start after I turned on an Experimental switch. How do I get back?**
Start it once from a terminal with `--safe-gpu` (for example `./Sonata.AppImage --safe-gpu`, or `SONATA_SAFE_GPU=1`): that start uses none of the Experimental graphics switches and changes no settings, so you can turn the switch off in Settings → Experimental. You rarely need it: when a start with a switch on doesn't finish, or the graphics process crashes, Sonata turns that switch off by itself and says so.

**Is this the old "Apple Music for Linux" app?**
It started as a fork of [cross-platform/apple-music-for-linux](https://github.com/cross-platform/apple-music-for-linux) by Marcus Tomlinson. That app stopped starting when Google stopped serving the Widevine module for its 2021 Electron 13 build ("Failed to install Widevine components"). Sonata moved to castlabs Electron 42 and the modern Widevine components API, and grew from there.

## Last.fm scrobbling

1. Create a free API account at <https://www.last.fm/api/account/create> (any name and description).
2. Settings → Integrations → Last.fm **Connect…** (or the tray's **Connect Last.fm…**): Sonata creates its config file and offers to open it; paste your API key and shared secret.
3. **Connect…** again, allow Sonata in the browser, press **Done**.

Disconnect any time from the tray or Settings → Integrations.

## Discord presence

1. Create an application at <https://discord.com/developers/applications> (free, instant). Its name is what Discord shows, e.g. "Apple Music".
2. Settings → Integrations → Discord **Connect…** (or the tray's **Connect Discord…**): Sonata creates its config file and offers to open it; paste the Application ID.
3. **Connect…** again, with the Discord desktop app running.

Works with normal, Flatpak and snap Discord installs. Disconnect any time from the tray.

## Running from source

```bash
git clone https://github.com/MarcelineVPQ/apple-music-for-linux
cd apple-music-for-linux
npm install
./start.sh
```

`--mini`, `--viz` and `--lyrics` start straight into the mini player, the visualizer or the lyrics window.

Recent Ubuntu releases block Chromium's unprivileged-userns sandbox through AppArmor. `start.sh` and the AppImage launcher detect this and fall back to no-sandbox (the app itself can't, because the sandbox aborts before any app code runs). To run with the sandbox instead, make the helper setuid root (again after every `npm install`):

```bash
sudo chown root:root node_modules/electron/dist/chrome-sandbox
sudo chmod 4755 node_modules/electron/dist/chrome-sandbox
```

Optional desktop entry at `~/.local/share/applications/sonata.desktop`:

```ini
[Desktop Entry]
Type=Application
Name=Sonata
Comment=Apple Music for Linux
Exec=/path/to/apple-music-for-linux/start.sh
Icon=/path/to/apple-music-for-linux/sonata.png
Terminal=false
Categories=AudioVideo;Audio;Player;
StartupWMClass=apple-music-for-linux
```

> **Tip:** don't launch from a terminal inside a snap-packaged IDE (VS Code/Codium snap); the snap's confinement breaks Electron's helper processes.

Tests, gates and UI checks: see [How it's built and tested](#how-its-built-and-tested). Project rules: [CLAUDE.md](CLAUDE.md). Building and signed releases: [docs/RELEASING.md](docs/RELEASING.md); a local signed test feed for the updater: `SONATA_UPDATE_FEED` (same file).

## How it's built and tested

<!--
TODO (media, only once the UI and features are final): short clips of the views and the theme
system at work belong here. Not recorded yet; don't add them before then.
-->

**The views.** Sonata is plain JavaScript on [castlabs Electron](https://github.com/castlabs/electron-releases) (for Widevine), with no build step.

- The main window holds separate views side by side: Apple's web player, the [navigation rail](#player), the [side panel](#settings-and-about) (Settings and About) and short notices. Apple's page gets none of Sonata's code beyond a few small scripts for focus, the mouse-wheel volume and the media controls, and it never gets Node.
- The mini player, the lyrics window (and the Studio, its second form), the visualizer, the liner notes and the album cover view are their own windows. One lyrics engine draws the words in the lyrics window, the Studio and the visualizer.
- The logic is kept apart from the windows (layout, lyrics timing, the theme, the updater), so it can be tested without starting Electron.

**One theme system.** Every colour in Sonata's own windows comes from one place (`theme.js`): light or dark, the album's colour, and the Glass material. It raises contrast until text reaches 4.5:1 (3:1 for dimmed lyric lines) over any artwork. New UI uses those colours, never its own. The only exceptions are things drawn as they look in real life: the vinyl cover and the visualizer's night scenes.

**Tests.**

- `npm test`: unit tests for the logic (lyrics sources, word timing, syllables, the cache, the theme's contrast, the rail and panel layout, settings repair, the signed-feed checks and the update flow). They run in plain Node: no Electron, no display, no sound.
- `npm run gates`, three checks:
  - **The verdict gate** (`tools/verdicts.js --check`): every loop, timer, listener, child process and error handler in the shipped code carries a written verdict saying why it's fine or what it costs (`docs/PERFORMANCE.md`). Code without one fails.
  - **The version check** (`tools/set-version.js --verify`): every file that carries the version agrees.
  - **The documentation gates** (`tools/doc-gates.js --check`): About → Coming soon matches the BACKLOG, user-facing changes have a CHANGELOG entry, nothing shipped is still marked as an idea, the docs and the in-app help name only files, settings and shortcuts that exist, and the version is the same everywhere.
- **The UI checker** (`tools/ui-check.js`, `tools/rail-check.js`): starts an isolated copy of Sonata on its own hidden display with a throwaway home folder, and checks the real windows at real sizes. Light and dark, the rail pinned or not, the panel docked or as a drawer: text contrast, names, hit targets, clipping, keyboard paths (Tab, F6, Esc), counts that stay flat over many open/close cycles, and idle repaints. It runs against Apple's logged-out page, so it can't see Apple's signed-in screens, and it needs a display, so it's run by hand before releases, not on GitHub.

**CI.** Every push and pull request runs `npm test` and `npm run gates` on GitHub ([ci.yml](.github/workflows/ci.yml)). A release tag runs them again, and the release stops if the tag doesn't match the version ([release.yml](.github/workflows/release.yml)).

**Releases and signed update feeds.**

- Releases live in [MarcelineVPQ/sonata-releases](https://github.com/MarcelineVPQ/sonata-releases): each one carries the AppImage, the complete source of that release (`sonata-X.Y.Z-source.tar.gz`, GPL-3.0) and `SHA256SUMS`. GitHub Actions there builds the AppImage from exactly that source archive, so the published source is proven to build.
- After each release, a second workflow there downloads the AppImage, records its size and SHA-512 in the update feed, and signs the feed with Sonata's Ed25519 key.
- There are two feeds: **Stable** (`latest.json`, tested releases) and **Development** (`latest-dev.json`, development builds `X.Y.Z-dev.N` plus the stable releases). Stable never offers a development build.
- **Build attestations:** releases also carry a GitHub attestation for the AppImage, the source archive and the feeds: a signed record of which workflow built the file. Check a download with the [GitHub CLI](https://cli.github.com):

  ```bash
  gh attestation verify sonata-X.Y.Z-x86_64.AppImage -R MarcelineVPQ/sonata-releases
  ```

  Releases up to v0.15.44-dev.1 and the Development bridge builds from v0.15.45-dev.1 on are also in this repository (`-R MarcelineVPQ/apple-music-for-linux`); up to v0.15.38-dev.1 they have none. Sonata itself doesn't need this: it checks the feed signature and the file's hash on every update.

**How updates work.**

1. Sonata fetches the feed for your channel and its `.sig` from the releases repository (20 seconds after start, then every two hours, on *Check now* and when you switch channels).
2. It refuses the feed unless the signature is from Sonata's key, the channel is the one you chose, and the version is newer than yours (or it's *Back to stable*).
3. It downloads the AppImage named in the feed, from the releases repository, and refuses it unless the size and SHA-512 match.
4. It puts the new AppImage beside the running one, points `Sonata.AppImage` at it, and offers *Restart now* (only while nothing plays).

What you see along the way, and the settings, are in [Updates](#updates). Details for maintainers: [docs/RELEASING.md](docs/RELEASING.md).

## Always on top on Wayland

Wayland doesn't let apps raise their own windows, so *Always on Top* (mini player and lyrics window) needs the compositor:

- **KDE Plasma (Wayland):** works; Sonata drives KWin's keep-above through its D-Bus scripting API.
- **X11 / XWayland:** works natively.
- **GNOME (Wayland):** no API for this, so the toggle has no effect. Press `Alt+Space` on the window and pick *Always on Top*, or run under XWayland:

  ```bash
  ELECTRON_OZONE_PLATFORM_HINT=x11 ./start.sh
  ```

## Region and theme files

Sonata takes your region from your desktop's locale (country code, `US` if none is set). Settings live in `~/.config/apple-music-for-linux/`; the `theme` file there holds `system`, `light` or `dark`.

## Credits and license

- Based on [cross-platform/apple-music-for-linux](https://github.com/cross-platform/apple-music-for-linux) by Marcus Tomlinson.
- Fallback lyrics from [LRCLIB](https://lrclib.net), a free, open lyrics database run by its community.
- Widevine playback through [castlabs Electron for Content Security](https://github.com/castlabs/electron-releases).
- Karaoke syllables with [hyphen](https://github.com/ytiurin/hyphen) (ISC) and the TeX hyphenation patterns of [hyph-utf8](https://github.com/hyphenation/tex-hyphen), each under its own licence (listed in About → Credits).
- The flying toasters are lit with the "White Home Studio" HDRI from [Poly Haven](https://polyhaven.com) (CC0).
- The sheet notes' clefs, sharps and flats are outlines from [Noto Music](https://fonts.google.com/noto/specimen/Noto+Music) by Google, under the SIL Open Font License 1.1 ([licenses/NotoMusic-OFL.txt](licenses/NotoMusic-OFL.txt)).

The full list, including the optional sonata-align models, is in the app: About → Credits.

GPL-3.0, see [LICENSE](LICENSE). Made by Marcy under 42 Pixel Studios.
