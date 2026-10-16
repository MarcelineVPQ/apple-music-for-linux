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
-->
<p align="center">
  <img src="docs/media/lyrics-hero.gif" alt="Sonata's lyrics window: the sung word lights up word by word, duet lines sit left and right, and the album cover turns like a small vinyl record" width="420">
</p>

> Sonata is not affiliated with, endorsed by, or sponsored by Apple Inc. "Apple Music" and "Apple" are trademarks of Apple Inc. You need your own Apple Music subscription.

Sonata is free and open source (GPL-3.0), made by one developer under 42 Pixel Studios. It will never be sold.

## Install

**[Download the AppImage from Releases](https://github.com/MarcelineVPQ/apple-music-for-linux/releases/latest)** (x86-64), then:

```bash
chmod +x sonata-*.AppImage
./sonata-*.AppImage
```

- The first run adds Sonata to your app menu (desktop entry and icon, kept in sync if you move the file).
- **It updates itself.** Sonata checks for a new release every two hours and installs it only if the update feed's Ed25519 signature checks out and the download matches the feed's size and SHA-512. Anything else is refused and the reason is shown. Tray → *Check for Updates…* checks right away.
- **Flatpak: coming.** A Sonata Flatpak repository that installs from KDE Discover (and GNOME Software) is planned.

> **Raspberry Pi / ARM:** not supported. Google publishes no Widevine DRM module for desktop linux-arm64, so no Chromium or Electron app can play Apple Music there.

## Features

### Lyrics

Open the lyrics window from the mini player's lyrics button (or its ⋯ menu). It floats on top, resizes, and remembers its size.

- **Word-by-word karaoke** with Apple's own timing: the word being sung pops and glows, without the line jumping around. Click any line to jump there.
- **Estimated word timing** for songs that only have line timing: each line's time is spread across its words, weighted by word length. It is marked "Word timing estimated", and Settings → *Estimated word timing* turns it off.
- **LRCLIB lyrics** for songs Apple has no lyrics for, from [lrclib.net](https://lrclib.net), a free, community-run lyrics database. A credit line shows when they're from LRCLIB. If the service is busy, the window says so and tries again on its own.
- **Countdown dots** for intros and instrumental breaks of about 4 seconds or more: three dots fill up until the singing starts again.
- **Duets:** singer 1 on the left, singer 2 on the right, together in the middle.
- **Backing vocals** sit smaller and dimmer under the main line, with their own word timing.
- **The vinyl cover:** the album art becomes a little record with grooves and a spindle hole, inside a ring that fills with the song's progress. It flips on a track change; click it to open the album. Optionally it spins, either at a relaxed pace or at true speed (33⅓ rpm for albums, 45 for singles and EPs).
- **Offline lyrics cache:** songs you've played before show their lyrics instantly, even offline (about 2,000 songs / 20 MB, oldest dropped first). The next song in your queue is looked up ahead of time while the lyrics window is open.

### Player

- **System tray:** click to hide or show the window; right-click for play/pause, next, previous, mini player, visualizer, dark mode, settings and quit. Music keeps playing while the window is hidden.
- **Mini player** (Ctrl+M): a small, translucent, always-on-top pill with artwork, shuffle, previous / play-pause / next, repeat, a seekable progress bar, volume and mute, favourite, and a ⋯ menu (Add to Library, Copy Link, Lyrics, Always on Top). Drag it anywhere.
- **Visualizer / ambient mode** (Ctrl+Shift+V): full-screen album art, synced lyrics and a real-time spectrum from the actual audio output (captured through PipeWire/PulseAudio, so it works with Apple's DRM). Four scenes: **Bars**, **Aurora** (a Flurry homage), **Nebula** (an iTunes-visualizer homage) and **Toast** (pixel-art winged toasters that flap to the beat, an After Dark wink). Click or ← / → to change, Esc to leave.
- **Adaptive album colours:** the mini player and lyrics window take their colours from the current album art, and the active lyric line glows in the album's colour. Toggle in Settings.
- **Dark mode** follows your desktop; Ctrl+D switches by hand and is remembered.
- Back / forward with Alt+← / Alt+→ and the mouse buttons; window size and position are remembered.

### Integration

- **Last.fm scrobbling** by Last.fm's rules (tracks over 30 s, after half the track or 4 minutes). [Setup](#lastfm-scrobbling).
- **Discord Rich Presence:** "Listening to" with track, artist, album art and progress. [Setup](#discord-presence).
- **Track-change notifications** with album art (toggle in Settings).
- Settings for close to tray, start minimized and launch at login.

### Updates

- **Signed updates** (see [Install](#install)).
- **Two channels** in Settings → Updates: **Stable** (default) gets tested releases; **Development** also gets development builds (`X.Y.Z-dev.N`) as soon as they're out. Stable never sees development builds.

## Screenshots

<!--
Placeholders, not recorded yet (shot list: ~/projects/marketing/sonata/recording-plan.md):
- docs/media/lyrics-duet.png       lyrics window mid-duet: left/right singers, a backing vocal, album-colour glow
- docs/media/lyrics-lrclib.png     a song Apple has no lyrics for, showing the "Lyrics from LRCLIB" credit line
- docs/media/mini-player.png       mini player floating over a desktop, with the lyrics window beside it
- docs/media/visualizer.png        visualizer in the Aurora or Nebula scene with a synced lyric line
Capture with Spectacle (window mode, no shadow), PNG, 2x scale if possible, then optimise with oxipng/pngquant.
-->

| Lyrics, duet | Lyrics from LRCLIB |
| --- | --- |
| ![Lyrics window during a duet, with singers on the left and right](docs/media/lyrics-duet.png) | ![Lyrics window showing lyrics from LRCLIB](docs/media/lyrics-lrclib.png) |
| **Mini player** | **Visualizer** |
| ![Mini player with the lyrics window beside it](docs/media/mini-player.png) | ![Visualizer with album art, spectrum and a synced lyric](docs/media/visualizer.png) |

## Privacy

Sonata talks to Apple (through the Apple Music web player you sign in to) and, only when Apple has no lyrics for a song, to lrclib.net: it sends that song's **title, artist, album and length**, with Sonata's name and version as the user agent. Nothing else, no account, no analytics. Turn it off in Settings → *LRCLIB lyrics*. Last.fm and Discord are only contacted once you connect them. Update checks fetch a signed file from this GitHub repository.

## Keyboard shortcuts

| Shortcut | Action |
| --- | --- |
| `Ctrl+M` | Toggle mini player |
| `Ctrl+Shift+V` | Toggle visualizer (← / → or click to change scene, Esc to exit) |
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

**Is this the old "Apple Music for Linux" app?**
It started as a fork of [cross-platform/apple-music-for-linux](https://github.com/cross-platform/apple-music-for-linux) by Marcus Tomlinson. That app stopped starting when Google stopped serving the Widevine module for its 2021 Electron 13 build ("Failed to install Widevine components"). Sonata moved to castlabs Electron 42 and the modern Widevine components API, and grew from there.

## Last.fm scrobbling

1. Create a free API account at <https://www.last.fm/api/account/create> (any name and description).
2. Tray → **Connect Last.fm…**: Sonata creates its config file and offers to open it; paste your API key and shared secret.
3. Tray → **Connect Last.fm…** again, authorize in the browser, click **Done**.

Disconnect any time from the tray.

## Discord presence

1. Create an application at <https://discord.com/developers/applications> (free, instant). Its name is what Discord shows, e.g. "Apple Music".
2. Tray → **Connect Discord…**: Sonata creates its config file and offers to open it; paste the Application ID.
3. Tray → **Connect Discord…** again, with the Discord desktop app running.

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

Tests: `npm test`. Building and signed releases: [docs/RELEASING.md](docs/RELEASING.md).

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

GPL-3.0, see [LICENSE](LICENSE). Made by Marcy under 42 Pixel Studios.
