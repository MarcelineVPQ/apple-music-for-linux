# Apple Music for Linux

An unofficial [Apple Music](https://music.apple.com/) desktop app for Linux — a lightweight Electron wrapper with full DRM playback support (Widevine), a system tray, and a mini player.

This is a fork of [cross-platform/apple-music-for-linux](https://github.com/cross-platform/apple-music-for-linux), revived and extended.

## ✨ What's new in this fork

The upstream app no longer starts: it pins a 2021 castlabs Electron 13 build whose Widevine DRM module Google no longer serves, so it fails with *"Failed to install Widevine components"* and never opens a window. This fork fixes that and adds quality-of-life features:

- **Works again** — upgraded to castlabs Electron 42 (`+wvcus`) and the modern `components` API, so Widevine installs and Apple Music plays
- **System tray icon** — click to hide/show the window; right-click for Play/Pause, Next, Previous, dark mode, mini player, and Quit. Music keeps playing while the window is hidden
- **Mini player** — a small, always-on-top translucent pill (Ctrl+M) in the style of Apple's floating player:
  - album artwork (click to return to the full player)
  - shuffle / previous / play-pause / next / repeat, with active states
  - track title and artist, updated live
  - volume slider with mute toggle
  - queue button that jumps back to the full player and opens *Up Next*
  - drag it anywhere by its background
- **Dark mode** — follows your desktop theme by default; Ctrl+D toggles light/dark manually and the choice is remembered across launches (upstream always started in light mode and only remembered the theme inside the snap)
- **Sane window sizing** — the main window keeps a minimum size and restores its geometry when expanding from the mini player
- **`start.sh` launcher** — handles the Chromium sandbox restrictions on modern Ubuntu automatically
- **`--mini` flag** — launch straight into the mini player

## ⌨️ Keyboard shortcuts

| Shortcut | Action |
| --- | --- |
| `Ctrl+M` | Toggle mini player |
| `Ctrl+D` | Toggle dark / light mode |
| `Ctrl+R` | Reload |

## 🚀 Running from source

```bash
git clone https://github.com/MarcelineVPQ/apple-music-for-linux
cd apple-music-for-linux
npm install
./start.sh
```

`start.sh` runs the app with the sandbox disabled when needed: recent Ubuntu releases block Chromium's unprivileged-userns sandbox via AppArmor. To run with the sandbox enabled instead, make the sandbox helper setuid root (repeat after every `npm install`):

```bash
sudo chown root:root node_modules/electron/dist/chrome-sandbox
sudo chmod 4755 node_modules/electron/dist/chrome-sandbox
```

Optionally add a desktop entry at `~/.local/share/applications/apple-music-for-linux.desktop`:

```ini
[Desktop Entry]
Type=Application
Name=Apple Music
Comment=Apple Music for Linux
Exec=/path/to/apple-music-for-linux/start.sh
Icon=/path/to/apple-music-for-linux/apple-music-for-linux.png
Terminal=false
Categories=Audio;Music;Player;
StartupWMClass=apple-music-for-linux
```

> **Tip:** don't launch the app from a terminal inside a snap-packaged IDE (VS Code/Codium snap) — the snap's confinement breaks Electron's helper processes. Use a regular terminal or the desktop entry.

## 🌍 Set your region

The app auto-detects your region. If it gets it wrong when running as a snap, override it manually:

```bash
mkdir -p ~/snap/apple-music-for-linux/common
echo "GB" > ~/snap/apple-music-for-linux/common/locale
```

(Replace "GB" with your country's [ISO 3166-1 alpha-2](https://en.wikipedia.org/wiki/ISO_3166-1_alpha-2) code.)

## 🎨 Theme file

The theme preference is stored in `theme` under `~/.config/apple-music-for-linux/` (or `~/snap/apple-music-for-linux/common/` as a snap). Valid values: `system`, `light`, `dark`.

## License

GPL-3.0 — see [LICENSE](LICENSE). Based on [cross-platform/apple-music-for-linux](https://github.com/cross-platform/apple-music-for-linux) by Marcus Tomlinson.
