const { app, BaseWindow, BrowserWindow, WebContentsView, Menu, Tray, shell, nativeTheme, nativeImage, ipcMain, clipboard, Notification, components, net, screen, globalShortcut } = require('electron')
const fs = require('fs');
const path = require('path');
const os = require('os');
const { exec, execFile, spawn, execFileSync } = require('child_process');
const { extractPalette } = require('./palette');
const { LastFm, createScrobbleQueue } = require('./lastfm');
const { DiscordPresence } = require('./discord');
const { Visualizer, RATE: VIZ_RATE } = require('./visualizer');
const { createListenSession } = require('./listen-session')
const alignSessionLib = require('./align-session')
const alignHelperLib = require('./align-helper')
const gameGuardLib = require('./game-guard')
const notesLogLib = require('./notes-log')
const sheetModel = require('./sheet-notes-model')
const sheetStoreLib = require('./sheet-notes-store')
const { createCssReplacer } = require('./css-replacer');
const updateFeed = require('./update-feed');
const railModel = require('./rail-model');
const panelModel = require('./panel-model');
const settingsStore = require('./settings-store');
const noticesModel = require('./notices-model');
const updaterLib = require('./updater');
const aboutDataLib = require('./about-data');
const curiousSamplerLib = require('./curious-sampler')
const themeLib = require('./theme');
const miniModel = require('./mini-model');
const coverModel = require('./cover-model');
const relaunch = require('./relaunch');
const shortcutsLib = require('./shortcuts')
const shortcutsModel = require('./shortcuts-model')
const dbusWire = require('./dbus-wire')
const stageModel = require('./stage-model')
const songActions = require('./song-actions')
const nodeNet = require('net')   // Electron's `net` (above) is its HTTP client; this is Node's sockets

// An AppImage started by another AppImage (an update relaunch up to 0.15.35-dev.1) inherits that run's
// FUSE mount in PATH and LD_LIBRARY_PATH. Once that run ends the mount can answer ENOTCONN, and every
// child process looked up through it (gdbus, parec, the aligner) fails: drop other AppImages' mounts,
// keep our own ($APPDIR) — relaunch.js
for (const v of ['PATH', 'LD_LIBRARY_PATH']) {   // loop: NOT-WORTH — two variables, once at start
  if (process.env[v]) process.env[v] = relaunch.cleanPathList(process.env[v], process.env.APPDIR || '')
}

const appName = 'Sonata'
// The app's name is Sonata (the desktop's media controls show it: MPRIS Identity, from the app name),
// but its settings, login and caches stay where every install has them, the folder named after the
// package (~/.config/apple-music-for-linux). userData is read before the rename and pinned; the
// session data, logs and the single-instance lock follow it. The window class (StartupWMClass) and
// the Wayland app id come from the package name before this file runs, so they don't change.
{
  const keepUserData = app.getPath('userData')
  app.setName(appName)
  app.setPath('userData', keepUserData)
}

// Settings → Experimental (gfx-model.js, gfx-runtime.js): the graphics switches are Chromium flags, so they
// are decided here, before 'ready', from the settings file; a start marker turns them off again when a
// start with them never got healthy. --safe-gpu (or SONATA_SAFE_GPU=1) starts without any of them.
// the one CPU sampler (cpu-sampler.js) for About → Graphics and About → For the Curious: it reads only
// when one of them asks, while it shows
const cpuSampler = require('./cpu-sampler').createCpuSampler({ metrics: () => app.getAppMetrics(), now: () => Date.now() })
const gfx = require('./gfx-runtime').createGfx({ app, fs, path, settingsStore, cpuSampler, extra: { decode: decodeProbe() } })
gfx.beforeReady()

// NOTE on sandboxing: recent Ubuntu restricts unprivileged user namespaces via
// AppArmor, which aborts Chromium's sandbox setup BEFORE this script runs — it
// cannot be handled from here. The AppImage launcher (electron-builder's
// AppRun) and start.sh both probe for it and disable the sandbox when needed.

let locale = 'US'
let themeFile = null
let mainWindow = null
let tray = null
let miniWindow = null
let miniPoll = null
let lyricsWindow = null
let lyricsPoll = null
let lyricsKey = ''
let lyricsRetry = null  // { key, attempt, at } after a failed lyrics lookup
let lyricsArt = ''
let curiousTrack = null  // the lyrics feed's song: { key, startAligned, startRefined } (About → For the Curious)
let shuttingDown = false
let lastfm = null
let scrobbleQueue = null   // scrobbles waiting for Last.fm (lastfm.js createScrobbleQueue; lastfm-pending.json)
let scrobbleState = null
let discord = null
let discordConfig = { applicationId: '', enabled: false }
let discordConfigPath = null
let discordReconnectTicks = 0
let lastPresenceKey = ''
let miniTrackKey = ''
let vizWindow = null
let visualizer = null
let vizListener = null   // Sonata's own stream for the visualizer (audio-listen.js)
let vizArt = ''
// the settings and what each may hold: settings-store.js (defaults, recovery from a damaged file, atomic saves)
let settings = settingsStore.defaults()
let settingsExisted = false   // a settings file was there at start (an install from before 0.15.32 has no lastRunVersion)
let lastPalette = null
let lastPaletteKey = null
let settingsPath = null
let notifyKey = null       // null until first poll, so we don't notify the track already loaded at launch
let trayTooltip = ''
let saveBoundsTimer = null

// error: SHOWN — a damaged settings.json: repaired (what reads is kept), copied aside, one notice (showRecovered)
function loadSettings() {
  settingsExisted = fs.existsSync(settingsPath)
  const r = settingsStore.loadSettings(settingsPath)
  settings = r.settings
  if (r.recovery) {
    console.error('settings: damaged file repaired: ' + JSON.stringify(r.recovery))
    showRecovered('settings', settingsStore.recoveryText(r.recovery), r.recovery.aside)
  }
}
// error: NOT-WORTH — a failed save (disk full, read-only) is logged; the setting holds for this run and the next change saves again
function saveSettings() {
  try { settingsStore.saveSettings(settingsPath, settings) } catch (e) { console.error('settings: save failed:', e.message) }
}

// Restore a saved window size/position into BrowserWindow options.
function applySavedBounds(opts, key) {
  const b = settings[key]
  if (b && Number.isInteger(b.width) && Number.isInteger(b.height)) {
    opts.width = b.width; opts.height = b.height
    if (Number.isInteger(b.x) && Number.isInteger(b.y)) { opts.x = b.x; opts.y = b.y }
  }
  return opts
}
// Persist a window's size/position (debounced) whenever it moves or resizes.
// loop: NOT-WORTH — lyrics-window bounds save · 500 ms one-shot debounce · runs only after a move/resize · stops after firing · cost ~0
// lifetime: OK — resize/move listeners live on the window and die with it; the timer checks isDestroyed() first
// key: the setting, or a function giving it (the lyrics window keeps one size per form: lyricsBounds, stageBounds)
function persistBounds(win, key) {
  let timer = null
  const save = () => {
    if (win.isDestroyed() || win.isMinimized() || win.isFullScreen() || !win.isVisible()) return
    clearTimeout(timer)
    timer = setTimeout(() => {
      if (!win.isDestroyed()) { settings[typeof key === 'function' ? key() : key] = win.getBounds(); saveSettings() }
    }, 500)
  }
  win.on('resize', save); win.on('move', save)   // lifetime: OK — both die with the window
}

function initLocaleAndTheme() {
  const dataDir = process.env.SNAP_USER_COMMON || app.getPath('userData');
  fs.mkdirSync(dataDir, { recursive: true });

  if (process.env.SNAP_USER_COMMON) {
    const localeFile = path.join(dataDir, 'locale');
    if (!fs.existsSync(localeFile)) {
      fs.writeFileSync(localeFile, app.getLocaleCountryCode());
    }
    locale = fs.readFileSync(localeFile).toString().substring(0, 2).toUpperCase();
  }
  else {
    locale = app.getLocaleCountryCode() || 'US';
  }

  // 'system' follows the desktop theme; Ctrl+D toggles and persists an override
  themeFile = path.join(dataDir, 'theme');
  if (!fs.existsSync(themeFile)) {
    fs.writeFileSync(themeFile, 'system');
  }
  const savedTheme = fs.readFileSync(themeFile).toString().trim().toLowerCase();
  themePref = ['light', 'dark', 'system'].includes(savedTheme) ? savedTheme : 'system'
  nativeTheme.themeSource = 'system'
  chromiumDark = nativeTheme.shouldUseDarkColors   // what Chromium itself says (the GTK theme)
  applyThemePref()
  watchDesktopScheme()
}

// --- light or dark: Sonata's choice (Ctrl+D, Settings → Appearance → Theme), else the DESKTOP's
// (the XDG portal, then KDE's kdeglobals: desktop-scheme.js), else Chromium's. Chromium alone follows
// the GTK theme, which on KDE can be light while the desktop is dark (0.15.31's unreadable lyrics). ---
const desktopScheme = require('./desktop-scheme')
let themePref = 'system'     // the theme file: 'system' | 'light' | 'dark'
let chromiumDark = false
let portalScheme = null      // 'dark' | 'light' | null (no portal, or no preference)
let kdeScheme = null
let schemeWatch = null       // the `gdbus monitor` child while following the desktop
function applyThemePref() {
  const want = desktopScheme.effectiveScheme(themePref, portalScheme, kdeScheme, chromiumDark)
  if (nativeTheme.themeSource !== want) nativeTheme.themeSource = want
}
// error: NOT-WORTH — no gdbus, no portal or no kdeglobals: that source says nothing, the next one decides.
// execFile/spawn THROW (not call back) on some errors, e.g. ENOTCONN from a dead AppImage mount on PATH
// (0.15.35-dev.1: that throw stopped startup before the window): caught, said once, the theme defaults.
let schemeSpawnLogged = false
function schemeSpawnFailed(e) {
  if (schemeSpawnLogged) return
  schemeSpawnLogged = true
  console.error('theme: cannot ask the desktop for light or dark (' + (e && e.message) + '); using KDE\'s or Chromium\'s answer')
}
function readDesktopScheme() {
  if (process.platform !== 'linux') return
  // error: NOT-WORTH — no kdeglobals (not KDE): that source says nothing, the next one decides
  try { kdeScheme = desktopScheme.parseKdeglobals(fs.readFileSync(path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'kdeglobals'), 'utf8')) } catch (e) { kdeScheme = null }
  applyThemePref()
  // lifetime: OK — one short gdbus call per read (3 s timeout), it ends by itself
  try {
    execFile('gdbus', ['call', '--session', '--dest', 'org.freedesktop.portal.Desktop', '--object-path', '/org/freedesktop/portal/desktop',
      '--method', 'org.freedesktop.portal.Settings.ReadOne', 'org.freedesktop.appearance', 'color-scheme'], { timeout: 3000 }, (err, out) => {
      portalScheme = err ? null : desktopScheme.parsePortal(out)
      applyThemePref()
    })
  } catch (e) { portalScheme = null; schemeSpawnFailed(e) }   // error: LOGGED-OK — logged once; no portal answer
}
// While Sonata follows the desktop: one `gdbus monitor` child hears the portal's SettingChanged, so a
// switch to BreezeDark (or back) applies at once. No polling.
// lifetime: OK — one child process while the theme is "Same as the desktop" (Linux); stopped when Sonata's
// own choice is set and on quit · cost one idle process that wakes only on portal signals
function watchDesktopScheme() {
  readDesktopScheme()
  if (process.platform !== 'linux' || themePref !== 'system' || schemeWatch) return
  try {
    schemeWatch = spawn('gdbus', ['monitor', '--session', '--dest', 'org.freedesktop.portal.Desktop', '--object-path', '/org/freedesktop/portal/desktop'], { stdio: ['ignore', 'pipe', 'ignore'] })
  } catch (e) { schemeWatch = null; schemeSpawnFailed(e); return }   // error: LOGGED-OK — logged once, no gdbus: the scheme read at start stays
  let buf = ''
  // lifetime: OK — data/exit/error listeners on that child, gone with it
  schemeWatch.stdout.on('data', (chunk) => {
    buf += chunk
    const lines = buf.split('\n')
    buf = lines.pop()
    // loop: NOT-WORTH — the lines of one portal signal
    for (const line of lines) {
      const v = desktopScheme.parsePortalSignal(line)
      if (v !== undefined) { portalScheme = v; applyThemePref() }
    }
  })
  schemeWatch.on('error', () => { schemeWatch = null })   // error: NOT-WORTH — gdbus missing: start-time scheme stays
  schemeWatch.on('exit', () => { schemeWatch = null })
}
function stopDesktopScheme() { if (schemeWatch) { schemeWatch.kill(); schemeWatch = null } }
function setThemePref(v) {
  themePref = v
  try { if (themeFile) fs.writeFileSync(themeFile, v) } catch (e) { console.error('theme: save failed:', e.message) }   // error: NOT-WORTH — logged; the choice holds for this run
  if (v === 'system') watchDesktopScheme()
  else stopDesktopScheme()
  applyThemePref()
}

function toggleTheme() {
  setThemePref(nativeTheme.shouldUseDarkColors ? 'light' : 'dark')
  pushPanel()
}

function mainAlive() {
  return !!(mainWindow && !mainWindow.isDestroyed() && appleView && !appleView.webContents.isDestroyed())
}

// Only hand web/mail links to the OS. The main window shows remote web
// content, so a page (or a malicious redirect within it) could otherwise
// trigger navigation to file:// or a scheme wired to a dangerous handler.
function openExternalSafe(url) {
  try {
    const scheme = new URL(url).protocol
    if (scheme === 'http:' || scheme === 'https:' || scheme === 'mailto:') {
      shell.openExternal(url)
    }
  } catch (e) { /* error: NOT-WORTH — not a URL: nothing to open */ }
}

// Block navigation and popups for windows that load our trusted local HTML
// with Node integration — defense in depth so they can never reach remote code.
// lifetime: OK — one setWindowOpenHandler + one will-navigate listener per local window; both die with the window
function lockDownLocalWindow(win) {
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  win.webContents.on('will-navigate', (event) => event.preventDefault())
}

function toggleWindow() {
  if (!mainWindow) return
  if (mainWindow.isVisible()) {
    mainWindow.hide()
  }
  else {
    mainWindow.show()
    mainWindow.focus()
  }
}

// Finds a button by aria-label/title anywhere in the page, including inside
// shadow roots, and clicks it. Injected into command scripts as source text.
const clickPageButtonSource = `
      const clickPageButton = (re) => {
        const walk = (root, depth) => {
          if (depth > 25) return null;
          /* loop: NOT-WORTH — one walk per user command (shuffle, repeat, queue), shadow depth ≤ 25 */
          for (const el of root.querySelectorAll('button, [role=button]')) {
            if (re.test(el.getAttribute('aria-label') || el.title || '')) return el;
          }
          for (const el of root.querySelectorAll('*')) {
            if (el.shadowRoot) { const hit = walk(el.shadowRoot, depth + 1); if (hit) return hit; }
          }
          return null;
        };
        const btn = walk(document, 0);
        if (btn) btn.click();
        return !!btn;
      };`

// Drive the page's own MusicKit player instance
function playerCommand(command) {
  if (!mainWindow) return
  // each script scopes its variables in an IIFE: a bare top-level `const`
  // would permanently claim the name in the page and break later calls
  const scripts = {
    playPause: '(() => { const mk = MusicKit.getInstance(); mk.isPlaying ? mk.pause() : mk.play(); })();',
    next: '(() => { MusicKit.getInstance().skipToNextItem(); })();',
    previous: '(() => { MusicKit.getInstance().skipToPreviousItem(); })();',
    // prefer clicking the page's real control (kept in sync with the app's own
    // UI and queue); fall back to the MusicKit property when it isn't rendered
    toggleShuffle: `(() => {
      ${clickPageButtonSource}
      if (clickPageButton(/shuffle/i)) return;
      const mk = MusicKit.getInstance(); mk.shuffleMode = mk.shuffleMode === 1 ? 0 : 1;
    })();`,
    // cycle off -> all -> one -> off (MusicKit: 0 = none, 1 = one, 2 = all)
    cycleRepeat: `(() => {
      ${clickPageButtonSource}
      if (clickPageButton(/repeat/i)) return;
      const mk = MusicKit.getInstance(); mk.repeatMode = mk.repeatMode === 0 ? 2 : (mk.repeatMode === 2 ? 1 : 0);
    })();`,
    // open Apple's Up Next popover in the full player
    openQueue: `(() => {
      ${clickPageButtonSource}
      clickPageButton(/up next|queue/i);
    })();`
  }
  appleWC().executeJavaScript(scripts[command])
    .catch((e) => console.error('player command failed:', command, e.message))   // error: LOGGED-OK — page mid-load (no MusicKit yet): that one command does nothing
}

// Read current track state from the page's MusicKit instance
const nowPlayingScript = `(() => {
  try {
    const mk = MusicKit.getInstance();
    const item = mk.nowPlayingItem;
    const attrs = item ? item.attributes : null;
    return {
      ok: true,
      isPlaying: mk.isPlaying,
      title: attrs ? (attrs.name || '') : '',
      artist: attrs ? (attrs.artistName || '') : '',
      album: attrs ? (attrs.albumName || '') : '',
      composer: attrs ? (attrs.composerName || '') : '',
      duration: attrs && attrs.durationInMillis ? attrs.durationInMillis / 1000 : 0,
      /* the catalogue id (library songs: their library id); only the Sung notes log keeps it */
      appleId: item ? String((attrs && attrs.playParams && attrs.playParams.catalogId) || item.id || '') : '',
      /* the recording's ISRC from the catalog attributes (no extra request; library uploads have none):
         the lyrics and timing caches are keyed by it (recording-id.js) */
      isrc: attrs ? String(attrs.isrc || item.isrc || '') : '',
      // precise time from the playing media element (fractional seconds); MusicKit's own value
      // can be whole seconds. Used only when the two agree, so a stray element never wins.
      playbackTime: (() => {
        const mkTime = mk.currentPlaybackTime || 0;
        const el = document.getElementById('apple-music-player') || document.querySelector('audio');
        const t = el && Number.isFinite(el.currentTime) ? el.currentTime : NaN;
        return Number.isFinite(t) && t > 0 && Math.abs(t - mkTime) < 1.5 ? t : mkTime;
      })(),
      artworkLarge: attrs && attrs.artwork && attrs.artwork.url
        ? attrs.artwork.url.replace('{w}', 512).replace('{h}', 512)
        : '',
      artwork: attrs && attrs.artwork && attrs.artwork.url
        ? attrs.artwork.url.replace('{w}', 168).replace('{h}', 168)
        : '',
      shuffle: mk.shuffleMode === 1,
      repeat: mk.repeatMode,
      volume: mk.volume,
      contentRating: attrs ? (attrs.contentRating || '') : '',
      releaseDate: attrs ? (attrs.releaseDate || '') : ''
    };
  } catch (e) { /* error: NOT-WORTH — no MusicKit yet (page loading): { ok: false }, the polls skip that tick */
    return { ok: false };
  }
})()`

function createMiniWindow() {
  // lifetime: OK — one mini window at a time; its 'closed' handler nulls it and stops its poll
  miniWindow = new BrowserWindow({
    width: 680,
    height: 72,
    frame: false,
    roundedCorners: false,   // Electron 43+ rounds frameless Linux windows; the pill draws its own shape
    transparent: true,
    hasShadow: false,
    resizable: false,
    alwaysOnTop: settings.miniAlwaysOnTop,
    title: appName + ' — Mini Player',
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    }
  })
  miniWindow.loadFile('miniplayer.html')
  lockDownLocalWindow(miniWindow)
  pushRail()
  // give KWin a moment to map the window before asking it to keep it above
  // loop: NOT-WORTH — mini keep-above · 300 ms one-shot · runs once per mini open · stops after firing · cost one qdbus exec (KDE Wayland only)
  if (settings.miniAlwaysOnTop) setTimeout(() => applyMiniKeepAbove(true), 300)

  // the lyrics and visualizer shortcuts work in the mini player too (shown in its "More" menu)
  // lifetime: OK — registered once per mini window, dies with its webContents
  miniWindow.webContents.on('before-input-event', (event, input) => { viewShortcut(input) })

  miniWindow.webContents.once('did-finish-load', () => {
    miniTrackKey = ''
    if (lastPalette) miniWindow.webContents.send('palette', lastPalette)
    miniWindow.webContents.send('theme', themeState())
    applyMiniBlur()
    // loop: HOT-PATH-OK — mini player now-playing poll · 1000 ms · runs while the mini window exists (also when minimized or paused) · stops on mini 'closed' (and main 'close') · cost 1 executeJavaScript/s into the page + 1 IPC send; measured 0.04-0.05 % of one core in the main process (docs/PERFORMANCE.md). Left as is: only runs while the mini player is open; polling on while minimized costs the same, not worth a code change.
    // error: NOT-WORTH — a failing executeJavaScript (page mid-navigation) is skipped until the next tick; at 1/s that can't hammer, and a reload ends it
    miniPoll = setInterval(async () => {
      if (!mainAlive() || !miniWindow) return
      try {
        const state = await appleWC().executeJavaScript(nowPlayingScript)
        if (!miniWindow || miniWindow.isDestroyed()) return
        miniWindow.webContents.send('now-playing', Object.assign({}, state, { lyricsOpen: !!lyricsWindow }))
        // refresh the favorite star only when the track changes (avoids an
        // API call every tick)
        const key = state && state.ok && state.title ? state.title + '|' + state.artist : ''
        if (key && key !== miniTrackKey) {
          miniTrackKey = key
          const fav = await appleWC().executeJavaScript(ratingFetchScript)
          if (miniWindow && !miniWindow.isDestroyed()) miniWindow.webContents.send('favorite-state', fav)
        }
        if (state && state.ok) refreshPalette(state)
      } catch (e) { /* error: NOT-WORTH — page mid-navigation; tried again next tick */ }
    }, 1000)
  })

  // lifetime: OK — the 'closed' handler nulls miniWindow and clears miniPoll, so no closure keeps the destroyed window alive
  miniWindow.on('closed', () => {
    miniWindow = null
    clearInterval(miniPoll)
    miniPoll = null
    pushRail()
    if (!shuttingDown && mainWindow && !mainWindow.isDestroyed()) {
      // some window managers remember the mini player's tiny geometry
      // and reapply it to the main window on show
      const [width, height] = mainWindow.getSize()
      if (width < 800 || height < 500) {
        mainWindow.setSize(1000, 600)
        mainWindow.center()
      }
      mainWindow.show()
      mainWindow.focus()
    }
  })
}

// --- lyrics window ---

// Fetch Apple's time-synced (TTML) lyrics for the current song through the
// page's MusicKit API session
const lyricsFetchScriptFor = (offset) => `(async () => {
  try {
    const mk = MusicKit.getInstance();
    const item = ${offset ? `mk.queue && mk.queue.items ? mk.queue.items[mk.queue.position + ${offset}] : null` : 'mk.nowPlayingItem'};
    if (!item) return { ok: false };
    const attrs = item.attributes || {};
    const pp = attrs.playParams || {};
    const id = pp.catalogId || pp.id || item.id;
    if (attrs.hasLyrics === false) return { ok: true, ttml: '' };   /* Apple says the song has none: nothing to ask */
    // Word timing lives in /syllable-lyrics (what Apple's web player uses);
    // /lyrics has line timing only, so it's the fallback.
    // A 404 (Apple has no such lyrics) is "no lyrics"; any other failure (offline, Apple's API
    // erring) is reported as failed, so it isn't mistaken for a song without lyrics.
    let failed = '';
    const get = async (kind) => {
      try {
        const res = await mk.api.music('/v1/catalog/{{storefront}}/songs/' + id + '/' + kind);
        const data = res && res.data && res.data.data && res.data.data[0];
        const a = (data && data.attributes) || {};
        const t = a.ttml || a.ttmlLocalizations;
        return typeof t === 'string' ? t : '';
      } catch (e) { /* error: PASSES-ON — a 404 is no lyrics; anything else goes back as failed (lyrics-sources.js retries, then LRCLIB) */
        const code = String((e && (e.errorCode || e.status)) || '');
        const text = String((e && (e.description || e.message)) || '');
        const none = (e && e.status === 404) || /^(404|NOT_FOUND|CONTENT_UNAVAILABLE)$/i.test(code) || /404|not found/i.test(text);
        if (!none) failed = failed || code || text || 'error';
        return '';
      }
    };
    const ttml = (await get('syllable-lyrics')) || (await get('lyrics'));
    return ttml || !failed ? { ok: true, ttml } : { ok: true, ttml: '', failed };
  } catch (e) { /* error: PASSES-ON — no MusicKit (page loading): goes back as failed (lyrics-sources.js retries, then LRCLIB) */
    return { ok: true, ttml: '', failed: 'no MusicKit' };
  }
})()`
const lyricsFetchScript = lyricsFetchScriptFor(0)

// The next song in the play queue (for lyrics prefetch); same fields as nowPlayingScript uses.
const nextItemScript = `(() => {
  try {
    const mk = MusicKit.getInstance();
    const q = mk.queue;
    const item = q && q.items ? q.items[q.position + 1] : null;
    const a = item && item.attributes;
    if (!a || !a.name) return { ok: false };
    return { ok: true, title: a.name, artist: a.artistName || '', album: a.albumName || '',
             duration: a.durationInMillis ? a.durationInMillis / 1000 : 0, isrc: String(a.isrc || item.isrc || '') };
  } catch (e) { /* error: NOT-WORTH — no queue yet: nothing to prefetch */ return { ok: false }; }
})()`

// the playing song's album / artist in Apple's page: song-actions.js openPageScript (through a link in the page)

const lyricsSources = require('./lyrics-sources')
const recordingId = require('./recording-id')

// Apple first, then LRCLIB (Settings → LRCLIB lyrics). net.fetch goes through
// Chromium's network stack, like the rest of the app.
// lyrics cache on disk (created in app 'ready', when userData is known)
let lyricsStore = null
const getLyrics = lyricsSources.createLyricsResolver({
  fetchApple: async (state) => {
    const res = await appleWC().executeJavaScript(state.queueOffset ? lyricsFetchScriptFor(state.queueOffset) : lyricsFetchScript)
    if (res && res.failed) throw new Error('Apple lyrics lookup failed: ' + res.failed)
    return (res && res.ttml) || ''
  },
  store: { get: (k) => (lyricsStore ? lyricsStore.get(k) : null), set: (k, v) => { if (lyricsStore) lyricsStore.set(k, v) } },
  fetchLrclib: (state) => lyricsSources.fetchLrclib(state, {
    fetch: (url, opts) => net.fetch(url, opts),
    userAgent: 'Sonata/' + app.getVersion() + ' (https://github.com/MarcelineVPQ/apple-music-for-linux)'
  }),
  lrclibEnabled: () => !!settings.lrclibFallback,
  log: (msg) => console.error(msg)
})

// Prefetch: once the current song's lyrics are in, look up the next queued song's quietly, so a
// busy lyrics service is usually over before it starts. One lookup per track (in-memory and disk
// caches make repeats free); never retried here, the normal retry handles that song when it plays.
// loop: none (one call per track change while the lyrics window is open)
let prefetchedAfter = ''
async function prefetchNextLyrics(currentKey) {
  if (prefetchedAfter === currentKey || !mainAlive()) return
  prefetchedAfter = currentKey
  try {
    const next = await appleWC().executeJavaScript(nextItemScript)
    if (next && next.ok && next.title) await getLyrics(Object.assign(next, { queueOffset: 1 }))
  } catch (e) { /* error: NOT-WORTH — prefetch is best effort; the song's own lookup runs when it plays */ }
}

// "Refine timing by listening" (Settings, off by default): listens to Sonata's own stream while
// a lyric view (lyrics window or visualizer) is open, the song plays and its word timing is estimated (see listen-session.js).
// lifetime: one session for the app's life; its listener (one parec) runs only in that state and
// is stopped on pause, track change, setting off, when the last lyric view closes and on quit.
// error: vocal-detect.js / timing-refine.js missing or failing to load -> listening stays off, logged once
let listenSession = null
let listenLoadFailed = false
function getListenSession() {
  if (listenSession || listenLoadFailed) return listenSession
  try {
    const { createVocalDetector } = require('./vocal-detect')
    const { refineWords, mergeLearned, noiseRate } = require('./timing-refine')
    listenSession = createListenSession({
      createListener: getSharedListener(), createVocalDetector, refineWords, mergeLearned, noiseRate,
      store: { get: (k) => (lyricsStore ? lyricsStore.get(k) : null), set: (k, v) => { if (lyricsStore) lyricsStore.set(k, v) } },
      send: sendLyrics,
      now: () => performance.now(),
      log: (m) => console.log('listen:', m)
    })
  } catch (e) { // error: LOGGED-OK — logged once; listening stays off (listenLoadFailed)
    listenLoadFailed = true
    console.error('listen: refine by listening unavailable:', e.message)
  }
  return listenSession
}

// One parec for every listener of Sonata's own stream (visualizer spectrum, Level 1 refine, Level 2
// precise timing): audio-listen.js shareListener
// lifetime: the shared parec runs while at least one of them listens (see audio-listen.js)
let sharedListener = null
function getSharedListener() {
  if (!sharedListener) {
    const { createListener, shareListener } = require('./audio-listen')
    sharedListener = shareListener(createListener)
  }
  return sharedListener
}

// "Precise word timing (GPU, experimental)" (Settings, off by default; docs/LEVEL2-ALIGN.md): while
// a lyric view (lyrics window or visualizer) is open, a line-only song's own audio is recorded in
// memory and, once heard, handed to the user's sonata-align helper, which lines each word up with the
// singing. Only the word times are cached (lyrics store, `aligned|title|artist`); the audio is dropped
// after the hand-over.
// lifetime: one session + one helper client for the app's life. The session records only while a
// lyric view is open, the song plays and it isn't aligned yet; the helper process (one child) is
// spawned for a job, quits after 10 min idle while a lyric view is open (2 min when none is), at once
// when a game starts (gaming guard), and is killed on setting off and quit (align-helper.js).
// error: helper not installed, crashing or refusing -> one log line, the song keeps its current timing
// The helper is a separate download (the Sonata engine release pinned in align/engine.json, installed by
// align/install.sh into the helper home); Sonata carries none of its code, only the protocol client.
// The install is checked at start and whenever Settings asks (install.sh runs outside Sonata), not
// per poll tick.
let alignPaths = null
let alignInstalledNow = false
let alignHealth = null      // align-helper checkInstall: ok / missing / broken / sandboxed / stray
let alignHelper = null
let alignSession = null
function alignInstalled(recheck) {
  if (recheck || !alignPaths) {
    // one object, updated in place: the helper client reads it at its next spawn
    alignPaths = Object.assign(alignPaths || {}, alignHelperLib.helperPaths(process.env, __dirname))
    alignHealth = alignHelperLib.checkInstall(alignPaths)
    // an engine on a venv of another Python (state 'update') can't load: not installed until install.sh ran again
    alignInstalledNow = alignHelperLib.isInstalled(alignPaths) && alignHealth.state !== 'update'
    showAlignRepair()
  }
  return alignInstalledNow
}
// A venv whose python is gone or lives inside another app's sandbox (the Codium snap): one notice in
// Settings → Word timing with the repair command, while Precise word timing is on.
// error: SHOWN — the repair notice; cleared once the install is healthy (checked at start and when Settings asks)
function showAlignRepair() {
  const text = settings.lyricsPreciseTiming ? alignHelperLib.repairText(alignHealth) : ''
  if (!text) { notices.clear('align-repair'); return }
  notices.show({ id: 'align-repair', place: { page: 'settings', section: 'timing' }, kind: 'error', task: true, text })
}
function getAlignHelper() {
  alignInstalled()
  // warm: while a lyric view (lyrics window, Studio, visualizer) is open the idle helper stays 10 min, else 2 (align-helper.js)
  if (!alignHelper) alignHelper = alignHelperLib.createAlignHelper({ paths: alignPaths, warm: () => lyricViews().length > 0, log: (m) => console.log('align:', m) })
  return alignHelper
}
function preciseTimingOn() { return !!settings.lyricsPreciseTiming && alignInstalled() }
// the engine version this Sonata runs (the pin in align/engine.json, ''  with SONATA_ENGINE_DIR): kept in
// each new aligned entry and shown in About → For the Curious
function alignEngineVersion() {
  alignInstalled()
  return (alignPaths && alignPaths.engineVersion) || ''
}
function getAlignSession() {
  if (!alignSession) {
    alignSession = alignSessionLib.createAlignSession({
      createListener: getSharedListener(),
      helper: getAlignHelper(),
      store: { get: (k) => (lyricsStore ? lyricsStore.get(k) : null), set: (k, v) => { if (lyricsStore) lyricsStore.set(k, v) } },
      send: sendLyrics,
      now: () => performance.now(),
      log: (m) => console.log('align:', m),
      engine: alignEngineVersion(),
      paused: () => alignPaused(),
      notes: {
        wanted: () => notesActive() && getNotesSwitch().wanted(),
        syl: notesLogLib.syllableSpec,
        done: (s, result, lineOffset) => { sungNotesDone(s, result, lineOffset); sheetNotesDone(s, result, lineOffset) },
        failed: (s, e) => { sungNotesFailed(s, e); sheetNotesFailed(s, e) },
        // the first play's pitch line: only while the Studio shows its band (nothing for a band nobody sees)
        pitchWanted: () => sheetNotesOn() && getNotesSwitch().wanted() && stageShowing(),
        pitch: sheetPitch,
        missing: (title, artist, hash) => sheetNotesOn() && getNotesSwitch().wanted() && getSheetStore().missing(title, artist, hash)
      }
    })
  }
  return alignSession
}

// "Sung notes (developer log)" (Settings → Precise timing; Development channel only, off by default;
// notes-log.js, docs/LEVEL2-ALIGN.md "Sung notes"): after a song's whole-song alignment the helper works
// out the sung notes from the vocal stem it already has, and only the notes are written here, one JSON
// per song in ~/.local/share/apple-music-for-linux/notes-log (at most 1000, oldest removed). The pitch
// model is downloaded when the switch is turned on, never while it is off.
// lifetime: OK — one switch object for the app's life; no timer, no child of its own (the helper's)
// error: SHOWN — every outcome (saved, skipped, failed, download) is the one status line under the switch
let notesSwitch = null
let notesStatusText = ''
function sungNotesOn() { return !!settings.sungNotesLog && settings.updateChannel === 'dev' && preciseTimingOn() }
// the notes step runs for the developer log or for the Studio's sheet notes (one switch object: one download)
function notesActive() { return sungNotesOn() || sheetNotesOn() }
function setNotesStatus(text) { notesStatusText = text; pushPanel(); sendSheet() }
function getNotesSwitch() {
  if (!notesSwitch) notesSwitch = notesLogLib.createNotesSwitch({ on: notesActive, helper: getAlignHelper(), status: setNotesStatus, log: (m) => console.log('align:', m) })
  return notesSwitch
}
function sungNotesDone(s, result, lineOffset) {
  if (!sungNotesOn() || !result || !result.notes) return       // turned off meanwhile: nothing is written
  const info = s.info || {}
  const doc = notesLogLib.buildDoc(result.notes, { title: s.title, artist: s.artist, album: info.album, duration: info.duration, appleId: info.appleId, isrc: info.isrc },
    { version: app.getVersion(), aligner: s.given ? 'given' : (s.entry && s.entry.model) || '', stats: result.stats, lineOffset })
  // error: SHOWN — a failed write (disk full, permissions) is the status line
  try {
    const out = notesLogLib.writeLog(notesLogLib.logDir(process.env, alignHelperLib.inAppSandbox), doc)
    setNotesStatus('Saved ' + doc.notes.length + ' notes of “' + s.title + '” (' + path.basename(out.file) + ')')
  } catch (e) {
    console.log('align: sung notes not saved: ' + e.message)
    setNotesStatus('Could not save the notes of “' + s.title + '”: ' + e.message)
  }
}
function sungNotesFailed(s, e) {
  if (!settings.sungNotesLog && !settings.sheetNotes) return
  const code = e && e.code
  if (code === 'no-model' && notesSwitch) notesSwitch.learn({ note_models: { rmvpe: false } })
  const why = code === 'paused' ? 'skipped while a game ran'
    : code === 'no-model' ? 'the pitch model is not downloaded (turn the switch off and on to download it)'
      : code === 'low-vram' ? 'not enough free graphics memory'
        : code === 'no-stem' ? 'the helper no longer had the song (it was restarted)'
          : (e && e.message) || 'unknown error'
  setNotesStatus('No notes for “' + s.title + '”: ' + why)
}

// "Sheet notes in the Studio" (Settings → Precise timing, Experimental, off by default; the Studio's
// Sheet notes tile switches it too; sheet-notes-model.js, docs/LEVEL2-ALIGN.md "Sheet notes"): the sung
// melody in a band above the Studio's lyrics. The helper works the notes out with the song's whole-song
// alignment (the same step as the developer log, on the stem it already separated); they are cached per
// song (sheet-notes-store.js) and sent to the lyrics window with the song. First play: each section's
// pitch line, asked right after that section's words, while the Studio shows. A song aligned before
// the switch was on is recorded once more for its notes. Nothing runs while a game runs (the gaming guard
// skips the jobs) and nothing at all while the switch is off; the band only draws.
// lifetime: OK — one store object and one per-song state for the app's life; no timer, no child of its own
// error: SHOWN — a failed notes step or pitch line is the band's one-line message (and the log)
let sheetStore = null
let sheet = null          // the song on screen: { key, title, artist, hash, entry, pitch: [], aligned, wordSynced, timed, error }
let sheetSent = ''
function sheetNotesOn() { return !!settings.sheetNotes && preciseTimingOn() }
function getSheetStore() {
  if (!sheetStore) sheetStore = sheetStoreLib.createSheetNotesStore({ dir: path.join(app.getPath('userData'), sheetStoreLib.DIR_NAME) })
  return sheetStore
}
// the song on screen changed (lyricsTick): its cached notes, if these lyrics have them
function setSheetSong(key, title, artist, lines, prep) {
  const hash = alignSessionLib.lyricsHash(lines || [])
  const timed = !!(lines && lines.length && lines[0].t != null)
  sheet = { key, title, artist, hash, entry: null, pitch: [], aligned: !!prep.aligned, wordSynced: !!prep.wordSynced, timed, error: '' }
  // (lyrics with their own word timing too: their notes are worked out on those times, align-session.js)
  if (settings.sheetNotes && title && timed) {
    const e = getSheetStore().get(title, artist)
    if (sheetModel.entryValid(e, hash)) sheet.entry = e
  }
  sheetSent = ''
  sendSheet()
}
// the band's state, to the lyrics window only (the visualizer has no band), on change only
function sendSheet() {
  if (!lyricsWindow || lyricsWindow.isDestroyed()) return
  const on = !!settings.sheetNotes
  const st = on && sheet ? {
    on, installed: alignInstalled(), precise: !!settings.lyricsPreciseTiming, key: sheet.key, wordSynced: sheet.wordSynced, timed: sheet.timed, aligned: sheet.aligned,
    paused: alignPaused(), error: sheet.error || (notesSwitch && notesSwitch.model === false ? notesStatusText : ''), pieces: sheet.pitch.length,
    entryAt: sheet.entry ? sheet.entry.created || '1' : '', place: settings.sheetPlace
  } : { on, installed: alignInstalled(), precise: !!settings.lyricsPreciseTiming, place: settings.sheetPlace }
  const json = JSON.stringify(st)
  if (json === sheetSent) return
  const was = sheetSent ? JSON.parse(sheetSent) : {}
  sheetSent = json
  // the notes ride along only when they changed (another song, new notes), the pitch pieces when one came
  const extra = {}
  if (on && sheet && (was.key !== st.key || was.entryAt !== st.entryAt || !was.on)) extra.entry = sheet.entry
  if (on && sheet && (was.key !== st.key || was.pieces !== st.pieces || !was.on)) extra.pitch = sheet.pitch
  lyricsWindow.webContents.send('lyrics-sheet', Object.assign({}, st, extra))
}
function sheetNotesDone(s, result, lineOffset) {
  if (!sheetNotesOn() || !result || !result.notes) return
  const entry = sheetModel.compact(result.notes, { lineOffset, lyricsHash: s.hash, created: new Date().toISOString(), version: app.getVersion() })
  // error: SHOWN — a failed write: the band says the notes couldn't be kept (and the log)
  try { getSheetStore().set(s.title, s.artist, entry) } catch (e) {
    console.log('align: sheet notes not saved: ' + e.message)
    if (sheet && sheet.key === s.key) { sheet.error = 'Could not keep the notes: ' + e.message; sendSheet() }
  }
  if (sheet && sheet.key === s.key) { sheet.entry = entry; sheet.aligned = true; sheet.error = ''; sendSheet() }
}
function sheetNotesFailed(s, e) {
  if (!sheetNotesOn()) return
  const code = (e && e.code) || ''
  // a game running isn't the song's fault: not counted, tried again on a later play
  // error: NOT-WORTH — the marker only limits the retries; without it the song is simply tried again
  if (code !== 'paused') { try { getSheetStore().failed(s.title, s.artist, s.hash, code || 'error') } catch (err) {} }
  if (sheet && sheet.key === s.key) {
    sheet.error = code === 'paused' ? 'No notes this time: a game was running' : code === 'no-model' ? 'The pitch model is not downloaded: turn Sheet notes off and on to download it'
      : code === 'low-vram' ? 'No notes this time: not enough free graphics memory' : 'No notes this time: ' + ((e && e.message) || 'unknown error')
    sendSheet()
  }
}
function sheetPitch(s, line, e) {
  if (!sheet || sheet.key !== s.key) return
  if (line) { sheet.pitch.push(line); sheet.error = '' } else if (e && e.code !== 'no-stem') sheet.error = 'Part of the pitch line is missing: ' + ((e && e.message) || 'unknown error')
  sendSheet()
}

// Gaming guard (game-guard.js; Settings → "Pause word timing while gaming", on by default): while a
// game runs, Precise timing records nothing, starts no job, and the helper quits after its current
// one. The lyric views' source note and the rail say so.
// loop: NOT-WORTH — none of its own · one check per 5 s at most, from the lyrics poll, only while precise timing
// has work (a song still to align, the helper running) or is paused (to see the game end) · cost ~5 ms in main + gdbus and
// nvidia-smi children (~10 ms each) per check
let gameGuard = null
let alignNote = ''
function alignPaused() { return !!(settings.alignGamingPause && gameGuard && gameGuard.paused) }
function alignNoteNow() {
  return alignPaused() && preciseTimingOn() && alignSession && alignSession.active ? gameGuardLib.pauseText(gameGuard.state) : ''
}
function sendAlignNote() {
  const text = alignNoteNow()
  if (text === alignNote) return
  alignNote = text
  sendLyrics('lyrics-align-state', text)
}
function alignGuardTick() {
  const work = (alignSession && alignSession.active) || (alignHelper && alignHelper.running) || (gameGuard && gameGuard.paused)
  if (!settings.alignGamingPause || !preciseTimingOn() || !work) { sendAlignNote(); return }
  if (!gameGuard) {
    gameGuard = gameGuardLib.createGameGuard({
      probes: gameGuardLib.linuxProbes({
        execFile, fs, platform: process.platform,
        ownPids: () => app.getAppMetrics().map((m) => m.pid).concat(alignHelper && alignHelper.pid ? [alignHelper.pid] : [])
      }),
      log: (m) => console.log('align:', m),
      onChange: (st) => {
        if (st.paused && alignHelper) alignHelper.release()   // frees its graphics memory after the current job
        sendAlignNote()
        sendSheet()
        pushRail()
      }
    })
  }
  gameGuard.maybeCheck()
  sendAlignNote()
}

// --- lyrics feed: one now-playing poll for every lyric view (lyrics window, visualizer overlay) ---
// Both views run the same engine (lyrics-view.js), so they get the same data: 'lyrics-data' (full
// line/word objects with estimated + learned timing), 'lyrics-time' pushes, 'lyrics-refined' and
// 'lyrics-art'. The visualizer also gets 'viz-nowplaying' (large art), and its audio is run from here.
function lyricViews() {
  return [lyricsWindow, vizWindow].filter((w) => w && !w.isDestroyed())
}
function sendLyrics(channel, ...args) {
  // loop: HOT-PATH-OK — ≤ 2 views (lyrics window, visualizer), per lyrics push
  for (const w of lyricViews()) w.webContents.send(channel, ...args)
}
// a view joined (its page just loaded): resend the song and the art on the next tick
function startLyricsFeed() {
  lyricsKey = null
  lyricsArt = null
  vizArt = null
  // loop: HOT-PATH-OK — lyrics now-playing poll · 500 ms · runs while the lyrics window or the visualizer exists (also when minimized or paused) · stops when the last of them closes (stopLyricsFeedIfIdle; and main 'close') · cost 2 executeJavaScript/s + 1 IPC send per view per tick; one lyrics lookup per track change (cached, see lyrics-sources.js). One poll for both views (the visualizer had its own 300 ms poll before 0.15.22).
  if (!lyricsPoll) lyricsPoll = setInterval(lyricsTick, 500)
  if (alignHelper) alignHelper.viewsChanged()   // an idle helper now keeps the longer limit
}
function stopLyricsFeedIfIdle() {
  if (lyricViews().length) return
  clearInterval(lyricsPoll)
  lyricsPoll = null
  lyricsRetry = null
  if (listenSession) listenSession.stop()
  if (alignSession) alignSession.stop(true)   // a song heard to the end is still aligned
  if (alignHelper) alignHelper.viewsChanged()   // no view: the 2-minute idle limit, counted from the last job
}

// error: NOT-WORTH — a failing executeJavaScript returns early until the next tick; at 2/s that can't hammer
async function lyricsTick() {
  if (!mainAlive() || !lyricViews().length) return
  let state
  try {
    state = await appleWC().executeJavaScript(nowPlayingScript)
  } catch (e) { return }
  if (!state || !state.ok || !lyricViews().length) return
  const sampledAt = Date.now()   // when state.playbackTime was read (a lyrics lookup below may take a while)

  // one recording (title|artist plus its ISRC, else its length): a live cut titled like the studio one is a new song
  const key = recordingId.trackKey(recordingId.songOf(state))
  // loop: NOT-WORTH — lyrics retry · when the lyrics service failed (busy/offline), refetch the same song after
  // 30 s, 60 s, then every 120 s · only while a lyric view is open and the song unchanged ·
  // stops on success, track change or when the last view closes · cost one lookup per retry.
  // A failed Apple lookup with nothing standing in (error 'apple') is retried 3 times (30, 60, 120 s),
  // then the window says Apple's lyrics didn't load (status 'apple-failed'); the next play asks again.
  // error: NOT-WORTH — backoff capped at 120 s, so a down service is never hammered
  const retryDue = lyricsRetry && lyricsRetry.key === key && Date.now() >= lyricsRetry.at
  if (key !== lyricsKey || retryDue) {
    lyricsKey = key
    const got = state.title ? await getLyrics(state) : { lines: [], source: '' }
    let status = got.error || ''
    if (got.error) {
      const attempt = lyricsRetry && lyricsRetry.key === key ? lyricsRetry.attempt + 1 : 0
      if (got.error === 'apple' && attempt >= 3) { lyricsRetry = null; status = 'apple-failed' }
      else lyricsRetry = { key, attempt, at: Date.now() + [30, 60, 120][Math.min(attempt, 2)] * 1000 }
    } else {
      lyricsRetry = null
      prefetchNextLyrics(key)
    }
    // word timing is chosen here, by priority: Apple/LRC word timing (never touched) > aligned on
    // this PC (Level 2) > refined by listening (Level 1) > estimated. Estimation is the same
    // lyrics-timing call the views would make, so main knows which lines are estimated.
    const precise = preciseTimingOn()
    const aligner = precise ? getAlignSession() : alignSession
    const rec = { duration: state.duration, isrc: state.isrc, appleId: state.appleId }
    if (aligner) aligner.setLyrics(key, state.title, state.artist, got.lines || [], precise, { album: state.album, duration: state.duration, appleId: state.appleId, isrc: state.isrc, lang: got.lang || '' })
    const prep = alignSessionLib.prepareLines(got.lines || [], {
      estimate: !!settings.estimatedWordTiming,
      entry: precise ? aligner.entryFor(state.title, state.artist, got.lines || [], rec) : null
    })
    let lines = prep.lines
    let refined = false
    let heardOnset = null
    if (settings.estimatedWordTiming) {
      const session = settings.lyricsListenRefine ? getListenSession() : listenSession
      if (session) ({ lines, refined, onset: heardOnset } = session.setLyrics(key, state.title, state.artist, lines, !!settings.lyricsListenRefine, rec))
    } else if (listenSession) listenSession.stop()
    // the song's onset stored with it (aligned entry, else learned by listening): the estimated lines start
    // their words that much after their stamps until enough lines are aligned/refined (lyrics-timing repace)
    const onset = prep.onset != null ? prep.onset : heardOnset
    alignNote = alignNoteNow()
    // About → For the Curious' "first or later play": what this song started with (one object per track change)
    curiousTrack = { key, startAligned: !!prep.aligned, startRefined: !!refined }
    // "Written by …" at the end of the lyrics: the TTML's songwriters (Apple lyrics), else the catalog's
    // composerName (Apple's own "A, B & C" text, e.g. for LRCLIB lyrics); nothing when Apple has neither
    const writers = got.writers && got.writers.length ? got.writers : (state.composer ? [state.composer] : [])
    sendLyrics('lyrics-data', { key, title: state.title, artist: state.artist, album: state.album, duration: state.duration, lines, writers, source: got.source, lang: got.lang || '', status, appleFailed: !!got.appleFailed, estimate: !!settings.estimatedWordTiming, refined, aligned: prep.aligned, onset, alignState: alignNote })
    setSheetSong(key, state.title, state.artist, got.lines || [], prep)
  }
  // album art for the lyrics header thumbnail: the mini player's URL (same Chromium cache), sent on change only
  const art = state.artwork || state.artworkLarge || ''
  if (art !== lyricsArt) {
    lyricsArt = art
    sendLyrics('lyrics-art', art)
  }
  // the visualizer's title, artist and large art (its blurred background), sent on change only
  const big = state.artworkLarge || state.artwork || ''
  if (vizWindow && !vizWindow.isDestroyed() && key + '|' + big !== vizArt) {
    vizArt = key + '|' + big
    vizWindow.webContents.send('viz-nowplaying', { title: state.title, artist: state.artist, artwork: big })
  }
  // isPlaying lets the views stop their word-highlight clock right away on pause; key: the song the time
  // is for (the views drop a time for another song, lyrics-view.js setTime). After a slow lookup this
  // tick's time is that old: the next tick (500 ms) sends a fresh one instead.
  if (Date.now() - sampledAt < 250) sendLyrics('lyrics-time', state.playbackTime, state.isPlaying, key)
  if (stageShowing()) stageTick(state, key)
  if (listenSession) listenSession.tick(state.playbackTime, state.isPlaying, !!settings.lyricsListenRefine)
  if (alignSession) alignSession.tick(state.playbackTime, state.isPlaying, preciseTimingOn())
  alignGuardTick()
  vizAudioTick(state.isPlaying)
  refreshPalette(state)
}

function createLyricsWindow() {
  // the form it was last used in (settings.lyricsStage): the stage or the lyrics window, each with its own size
  const form = settings.lyricsStage ? 'stage' : 'compact'
  const area = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea
  const bounds = form === 'stage' ? stageModel.windowBounds('stage', settings.stageBounds, area) : applySavedBounds({ width: stageModel.COMPACT_DEFAULT.width, height: stageModel.COMPACT_DEFAULT.height }, 'lyricsBounds')
  const min = stageModel.minSize(form, area)
  // lifetime: OK — one lyrics window at a time; 'closed' nulls it and stops the feed when no view is left
  lyricsWindow = new BrowserWindow(Object.assign(bounds, {
    minWidth: min.width,
    minHeight: min.height,
    frame: false,
    roundedCorners: false,   // Electron 43+ rounds frameless Linux windows; the card draws its own corners
    transparent: true,
    hasShadow: false,
    alwaysOnTop: true,
    title: appName + ' — Lyrics',
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    }
  }))
  lyricsWindow.loadFile('lyrics.html')
  persistBounds(lyricsWindow, () => (settings.lyricsStage ? 'stageBounds' : 'lyricsBounds'))
  trackHdr(lyricsWindow)
  lockDownLocalWindow(lyricsWindow)
  pushRail()
  // the lyrics and visualizer shortcuts work in the lyrics window too (Ctrl+Shift+L closes it again)
  // lifetime: OK — registered once per lyrics window, dies with its webContents
  lyricsWindow.webContents.on('before-input-event', (event, input) => { viewShortcut(input) })

  // lifetime: OK — fires once per load
  lyricsWindow.webContents.once('did-finish-load', () => {
    lyricsWindow.webContents.send('lyrics-settings', { spin: !!settings.lyricsArtSpin, speed: settings.lyricsArtSpinSpeed })
    lyricsWindow.webContents.send('lyrics-form', lyricsForm())
    stageSent = ''
    montageSong = ''
    lyricsWindow.webContents.send('stage-montage', montageMsg = settings.montage ? { on: true, status: 'idle', photos: [] } : { on: false, status: 'off', photos: [] })
    stageQueueSig = ''
    startLyricsFeed()
    if (lastPalette) lyricsWindow.webContents.send('palette', lastPalette)
    lyricsWindow.webContents.send('theme', themeState())
    // loop: NOT-WORTH — lyrics keep-above · 300 ms one-shot · once per lyrics open · stops after firing · cost one qdbus exec (KDE Wayland only)
    if (settings.lyricsAlwaysOnTop) setTimeout(() => applyLyricsKeepAbove(true), 300)
  })

  // lifetime: OK — 'closed' nulls lyricsWindow; the feed stops when no lyric view is left
  lyricsWindow.on('closed', () => {
    lyricsWindow = null
    stopLyricsFeedIfIdle()
    pushRail()
  })
}

function toggleLyricsWindow() {
  if (lyricsWindow) {
    lyricsWindow.close()
  }
  else {
    createLyricsWindow()
  }
}

// --- the stage: the lyrics window grown into the now-playing screen (lyrics.html body.stage) ---
// One window, two forms: the lyrics window (compact) and the stage. Opening the lyrics (Ctrl+Shift+L,
// the rail, the tray, the mini player) brings back the form last used (settings.lyricsStage); the stage
// button in its header, the rail's Studio item and Ctrl+Shift+S grow it into the stage or shrink it back.
// Each form keeps its own size (lyricsBounds, stageBounds).
let stageSent = ''        // the last 'stage-np' sent (JSON), so it's sent on change only
let stageQueueSig = ''    // the queue's signature as last sent: Apple's page answers "same" while it holds
let stageQueueAt = 0      // when the queue was last read (ms)
let stageQueueKey = ''    // the song the queue was last read for (a new song reads it at once)
let stageQueueLast = null // the queue as last sent (stage-model cleanQueue): the row menus' songs
let stageSongKey = ''     // the song the action row and the credits were read for (read once per song)
let stageSongSeq = 0      // a newer read wins over a late answer
let stageSong = { ok: false }   // the playing song's state (song-actions.js cleanState)
const stageCreditsAsked = new Set()   // albums whose MusicBrainz credits the Studio asked for this session (once each)
// the liner notes (openLinerNotes(album, from), below); the tile shows only when it's there
const linerNotesReady = () => typeof openLinerNotes === 'function'
function lyricsForm() {
  return { stage: !!settings.lyricsStage, linerNotes: linerNotesReady() }
}
function stageShowing() {
  return !!(lyricsWindow && !lyricsWindow.isDestroyed() && settings.lyricsStage && lyricsWindow.isVisible() && !lyricsWindow.isMinimized())
}
function setLyricsForm(stage) {
  const on = !!stage
  if (!lyricsWindow || lyricsWindow.isDestroyed()) {
    settings.lyricsStage = on
    saveSettings()
    createLyricsWindow()
    return
  }
  if (!!settings.lyricsStage === on) { lyricsWindow.show(); lyricsWindow.focus(); return }
  settings.lyricsStage = on
  saveSettings()
  const area = screen.getDisplayMatching(lyricsWindow.getBounds()).workArea
  const form = on ? 'stage' : 'compact'
  const b = stageModel.windowBounds(form, on ? settings.stageBounds : settings.lyricsBounds, area)
  const min = stageModel.minSize(form, area)
  stageSent = ''
  stageQueueSig = ''
  stageQueueKey = ''
  stageSongKey = ''
  lyricsWindow.webContents.send('lyrics-form', lyricsForm())
  lyricsWindow.setMinimumSize(min.width, min.height)
  lyricsWindow.setBounds(b)
  pushRail()
}
// the rail's Studio item and Ctrl+Shift+S: the stage showing shrinks back to the lyrics window, else it opens as the stage
function toggleStage() {
  setLyricsForm(!(lyricsWindow && !lyricsWindow.isDestroyed() && settings.lyricsStage))
}

// Apple's queue, read-only: the songs as MusicKit holds them (MusicKit.getInstance().queue.items) and
// the one playing. `since` is the signature last sent: while the queue holds (same length, position,
// ends and shuffle) the page answers { same: true } and nothing else crosses.
const stageQueueScript = (since) => `(() => {
  try {
    const mk = MusicKit.getInstance();
    const q = mk.queue;
    const items = (q && q.items) || [];
    const pos = q && typeof q.position === 'number' ? q.position : (typeof mk.nowPlayingItemIndex === 'number' ? mk.nowPlayingItemIndex : -1);
    const id = (it) => (it && it.id ? String(it.id) : '');
    const sig = items.length + ':' + pos + ':' + id(items[0]) + ':' + id(items[items.length - 1]) + ':' + mk.shuffleMode;
    if (sig === ${JSON.stringify(String(since || ''))}) return { ok: true, same: true, sig };
    const np = mk.nowPlayingItem;
    const c = np && np.container;
    const cname = c ? ((c.attributes && c.attributes.name) || c.name || '') : '';
    return {
      ok: true, sig, position: pos,
      canPlay: typeof mk.changeToMediaAtIndex === 'function',
      container: c ? { type: String(c.type || ''), name: String(cname) } : null,
      /* loop: NOT-WORTH — the queue's songs (at most ${stageModel.QUEUE_MAX}), only when the signature changed (a new song, the queue edited), while the stage shows */
      items: items.slice(0, ${stageModel.QUEUE_MAX}).map((it) => {
        const a = it.attributes || {};
        const art = a.artwork && a.artwork.url ? a.artwork.url.replace('{w}', 112).replace('{h}', 112) : '';
        const am = String(a.url || '').match(/\\/album\\/[^/]*\\/?(\\d+)/);
        return { id: id(it), title: a.name || it.title || '', artist: a.artistName || '', album: a.albumName || '', duration: (a.durationInMillis || 0) / 1000, art, autoplay: !!it.isAutoplay, albumId: am ? am[1] : '', composer: a.composerName || '' };
      })
    };
  } catch (e) { /* error: NOT-WORTH — no MusicKit or no queue yet (page loading): { ok: false }, read again on the next tick */
    return { ok: false };
  }
})()`

// The stage's song (sent on change) and queue (read at once on a new song, else every 2 s, and only
// the signature crosses while it holds). Runs in the lyrics feed's tick, only while the stage shows
// (not minimized, not hidden, not the compact form).
// error: NOT-WORTH — a failing read (page mid-navigation) skips this tick; the next tick reads again
async function stageTick(state, key) {
  const np = { title: state.title, artist: state.artist, album: state.album, art: state.artworkLarge || state.artwork || '', duration: state.duration, isPlaying: !!state.isPlaying, shuffle: !!state.shuffle, repeat: state.repeat, volume: Number(state.volume) || 0, releaseDate: state.releaseDate || '' }
  const json = JSON.stringify(np)
  if (json !== stageSent) { stageSent = json; lyricsWindow.webContents.send('stage-np', np) }
  if (key !== stageSongKey) { stageSongKey = key; stageSongRead(state, key) }
  montageTick(state)
  const now = Date.now()
  if (key === stageQueueKey && now - stageQueueAt < 2000) return
  stageQueueKey = key
  stageQueueAt = now
  let q
  try { q = await appleWC().executeJavaScript(stageQueueScript(stageQueueSig)) } catch (e) { return }   // error: NOT-WORTH — page mid-navigation: read again on the next tick
  if (!q || !q.ok || q.same || !stageShowing()) return
  stageQueueSig = q.sig
  stageQueueLast = stageModel.cleanQueue(q)
  lyricsWindow.webContents.send('stage-queue', stageQueueLast)
}

// Play a song of the queue (the stage's Up Next / Playlist): only when Apple's player offers
// changeToMediaAtIndex, and only if the song at that place is still the one clicked (the queue may have
// moved on since the list was drawn); otherwise nothing happens and the list is read again.
const stagePlayScript = (index, id) => `(() => {
  try {
    const mk = MusicKit.getInstance();
    const it = mk.queue && mk.queue.items ? mk.queue.items[${index}] : null;
    if (!it || String(it.id) !== ${JSON.stringify(id)} || typeof mk.changeToMediaAtIndex !== 'function') return false;
    mk.changeToMediaAtIndex(${index});
    return true;
  } catch (e) { /* error: PASSES-ON — false to main, which reads the queue again */
    return false;
  }
})()`

// lifetime: OK — registered once at module load (like every ipcMain handler here)
// error: NOT-WORTH — a command not from the lyrics window's top frame, or one stage-model.stageCommand refuses, is dropped
ipcMain.on('stage-command', (event, command, value) => {
  if (!lyricsWindow || lyricsWindow.isDestroyed() || event.sender !== lyricsWindow.webContents) return
  if (!event.senderFrame || event.senderFrame.parent) return
  const c = stageModel.stageCommand(command, value)
  if (!c) return
  if (c.command === 'form') { setLyricsForm(c.value === 'stage'); return }
  if (c.command === 'montage') {
    // on: remembered, and looked up for the song playing (again, after "none" or offline); off: stops at once
    settings.montage = c.value
    saveSettings()
    if (c.value) { montageSong = ''; montageSend({ on: true, status: 'looking', photos: [] }) } else montageOff()
    return
  }
  if (c.command === 'montage-credit') {
    // the photo's Commons page, from the photos main sent (never a URL from the page)
    const p = montageMsg.photos.find((x) => x.id === c.value)
    if (p && /^https:\/\/commons\.wikimedia\.org\/wiki\/File:/.test(p.page)) openExternalSafe(p.page)
    return
  }
  if (!mainAlive()) return
  const run = (code, what) => appleWC().executeJavaScript(code)
    .catch((e) => console.error('stage ' + what + ' failed:', e.message))   // error: LOGGED-OK — page mid-load: that one command does nothing (the stage shows the player's real state on the next tick)
  if (c.command === 'play-pause') playerCommand('playPause')
  else if (c.command === 'next') playerCommand('next')
  else if (c.command === 'previous') playerCommand('previous')
  else if (c.command === 'shuffle') playerCommand('toggleShuffle')
  else if (c.command === 'repeat') playerCommand('cycleRepeat')
  else if (c.command === 'seek') run(`(() => { MusicKit.getInstance().seekToTime(${c.value}); })();`, 'seek')
  else if (c.command === 'volume') run(`(() => { MusicKit.getInstance().volume = ${c.value}; })();`, 'volume')
  else if (c.command === 'play-item') ipcStagePlay(c.value.index, c.value.id)
  else if (c.command === 'song-favorite') {
    if (!stageSong.ok || !stageSong.id) { stageDone('favorite', false, 'nothing'); return }
    songAct(c.value ? 'favorite' : 'undo-favorite', stageSong, stageDone)
  }
  else if (c.command === 'sheet-notes') setSetting('sheetNotes', c.value)   // the Studio's Sheet notes tile: the same switch as Settings
  else if (c.command === 'sheet-place') setSetting('sheetPlace', c.value)   // the band's placement buttons: the same setting as Settings
  else if (c.command === 'song-library') {
    if (!stageSong.ok || !stageSong.id) stageDone('library', false, 'nothing')
    else if (stageSong.inLibrary === true) stageSay({ kind: 'ok', text: 'Already in your library' })
    else songAct('library', stageSong, stageDone)
  }
  else if (c.command === 'song-link') {
    if (!stageSong.url) stageDone('link', false, 'nothing')
    else songAct('link', stageSong, stageDone)
  }
  else if (c.command === 'song-album' || c.command === 'song-artist') stageOpenPage(c.command === 'song-album' ? 'album' : 'artist')
  else if (c.command === 'song-more') stageMenu(songMenuItems(stageInfo(), lyricsWindow, ['cover', 'liner', '-', 'share'], stageDone), c.value)
  else if (c.command === 'song-playlists') stagePlaylists(c.value)
  else if (c.command === 'row-menu') stageRowMenu(c.value)
  else if (c.command === 'credits-liner' && linerNotesReady()) stageLiner('credits')
  else if (c.command === 'liner-recording' && linerNotesReady()) stageLiner('recording')
  else if (c.command === 'liner-notes' && linerNotesReady()) {
    // the booklet of the album the stage shows; the tile says so when no album matched
    const s = lastStage()
    openLinerNotes({ album: s.album, artist: s.artist }, lyricsWindow)
      .then((ok) => { if (lyricsWindow && !lyricsWindow.isDestroyed()) lyricsWindow.webContents.send('stage-liner', !!ok) })
      .catch((e) => console.error('stage liner notes failed:', e.message))   // error: LOGGED-OK — the booklet didn't open; the next click tries again
  }
})
// play a place of the queue (a click on a row, its menu's Play Now): checked again in Apple's page
function ipcStagePlay(index, id) {
  if (!mainAlive()) return
  appleWC().executeJavaScript(stagePlayScript(index, id))
    .then((ok) => { if (!ok) { stageQueueSig = ''; stageQueueKey = '' } })
    .catch((e) => console.error('stage play failed:', e.message))   // error: LOGGED-OK — page mid-load: nothing plays; the list shows the player's real state on the next read
}
function lastStage() {
  try { return JSON.parse(stageSent || '{}') } catch (e) { return {} }   // error: NOT-WORTH — our own JSON; {} when nothing was sent yet
}

// --- the Studio's song actions (the row under the volume), its menus and the cover's credits ---
// The song's state is read once per song while the Studio shows (and again after an action), never on a
// timer: song-actions.js stateScript (favourite, library, ids) through the source adapter (songSource).
const stageAlive = () => !!(lyricsWindow && !lyricsWindow.isDestroyed())
function stageSay(note) { if (note && stageAlive()) lyricsWindow.webContents.send('stage-said', note) }
// a song action's result in the Studio: its note; after one that changes the song's state, that state again
function stageDone(action, ok, why, info) {
  stageSay(songActions.said(action, ok, why))
  // read back from Apple's page, never assumed: the button shows what Apple now says (same song key kept,
  // so the next tick doesn't read again and outrun this read)
  if (ok && /favorite|library|playlist/.test(action)) stageSongRead(null, '')
}
// the song as the shared menu builder takes it (songMenuItems)
function stageInfo() {
  const s = lastStage()
  return { ok: !!stageSong.ok, id: stageSong.id || '', title: stageSong.title || s.title || '', artist: stageSong.artist || s.artist || '', url: stageSong.url || '', rating: stageSong.favorite ? 1 : 0 }
}
// a native menu under the Studio button that asked for it (at: its lower-left corner in the window)
function stageMenu(template, at) {
  if (!stageAlive()) return
  // lifetime: a fresh Menu per click; nothing keeps it after the popup closes, so it is garbage-collected
  Menu.buildFromTemplate(template).popup({ window: lyricsWindow, x: at.x, y: at.y })
}
async function stageSongRead(state, key) {
  const seq = ++stageSongSeq
  let st
  try { st = await songSource.state() } catch (e) { st = { ok: false, why: 'not-ready' } }   // error: SHOWN — the row shows nothing known (its buttons say why when clicked)
  if (seq !== stageSongSeq || !stageAlive()) return
  stageSong = st
  // sent under the Studio's own key (the now-playing it was just sent), not the feed's track key
  const k = stageModel.songKey(lastStage())
  lyricsWindow.webContents.send('stage-song', Object.assign({ key: k }, st, { offers: songActions.offers(st) }))
  if (state) stageCredits(state, st, k, seq)
}
// the Studio's credits (the cover's back) for the song playing: Apple's catalog at once; MusicBrainz's from
// the album's liner-notes cache entry, or once per album (the liner-notes code, MusicBrainz only) when the
// cache has none. Nothing is fetched again for a song whose album is in the cache.
function linerEntry(albumId) {
  return albumId && linerStore ? linerStore.get(linerModel.cacheKey(albumId, linerSources.wikiLang(app.getLocale()))) : null
}
function stageCredits(state, st, key, seq) {
  const song = { id: st.ok ? st.id : '', title: state.title, artist: state.artist, composer: state.composer }
  const send = (entry) => {
    if (seq !== stageSongSeq || !stageAlive()) return
    lyricsWindow.webContents.send('stage-credits', Object.assign({ key, liner: linerNotesReady() }, linerModel.songCredits(entry, song)))
  }
  const albumId = st.ok ? st.albumId : ''
  const entry = linerEntry(albumId)
  send(entry)
  if (!albumId || (entry && entry.parts && entry.parts.mb) || stageCreditsAsked.has(albumId) || !mainAlive()) return
  if (stageCreditsAsked.size > 500) stageCreditsAsked.clear()
  stageCreditsAsked.add(albumId)
  appleWC().executeJavaScript(linerAlbumScript(albumId, null))
    .then((res) => { if (res && res.ok) getLinerNotes().load(res.album, null, (e, pending) => { if (!pending) send(e) }, '', 'mb') })
    .catch((e) => console.error('studio credits: album lookup failed:', e.message))   // error: LOGGED-OK — the back shows Apple's credits; the booklet asks again when opened
}
// the album or artist in Apple's page (song-actions.js openPageScript); the main window comes to the front
function stageOpenPage(kind, albumId) {
  if (!mainAlive()) { stageDone(kind, false, 'nothing'); return }
  mainWindow.show()
  mainWindow.focus()
  songSource.open(kind, albumId)
    .then((ok) => stageDone(kind, ok))
    .catch((e) => { console.error('studio open ' + kind + ' failed:', e.message); stageDone(kind, false) })   // error: SHOWN — the Studio's note says it couldn't be opened
}
// Add to a playlist: the user's playlists that take songs, read when the menu opens (one request)
function stagePlaylists(at) {
  if (!stageSong.ok || !stageSong.id) { stageDone('playlist', false, 'nothing'); return }
  const song = stageSong
  songSource.playlists().then((list) => {
    const items = list.length
      ? list.map((p) => ({ label: p.name, click: () => songSource.addToPlaylist(p.id, song.id).then(() => stageDone('playlist', true, p.name)).catch((e) => { console.error('add to playlist failed:', e.message); stageDone('playlist', false) }) }))   // error: SHOWN — the Studio's note says it didn't go through
      : [{ label: 'No playlists of yours to add to', enabled: false }]
    stageMenu([{ label: 'Add to a Playlist', enabled: false }, { type: 'separator' }, ...items], at)
  }).catch((e) => { console.error('playlists failed:', e.message); stageDone('playlists', false) })   // error: SHOWN — the Studio's note says the playlists didn't load
}
// a queue row's menu (its ⋯, right-click, the Menu key): the shared builder's queue items
function stageRowMenu(v) {
  const q = stageQueueLast
  const it = q && q.items[v.index]
  if (!it || it.id !== v.id) { stageQueueSig = ''; stageQueueKey = ''; return }   // the queue moved on: read again
  const info = { ok: true, id: it.id, title: it.title, artist: it.artist, url: '', rating: 0, row: { index: it.index, id: it.id, albumId: it.albumId, composer: it.composer, cur: it.index === q.position } }
  stageMenu([{ label: it.title || 'Untitled', enabled: false }, { type: 'separator' }, ...songMenuItems(info, lyricsWindow, ['play-now', 'play-next', '-', 'album', 'credits'], stageDone)], v)
}
// another song's credits (a queue row's menu): Apple's composer, and MusicBrainz's when its album is in the liner-notes cache
function stageRowCredits(row, info) {
  if (!stageAlive()) return
  const c = linerModel.songCredits(linerEntry(row.albumId), { id: row.id, title: info.title, artist: info.artist, composer: row.composer })
  lyricsWindow.webContents.send('stage-row-credits', Object.assign({ index: row.index, id: row.id, title: info.title }, c))
}
// the booklet at one of its sections (the cover's "More in the liner notes", the live chip)
function stageLiner(section) {
  const s = lastStage()
  const albumId = stageSong.ok ? stageSong.albumId : ''
  openLinerNotes(albumId ? { appleId: albumId } : { album: s.album, artist: s.artist }, lyricsWindow, { section })
    .then((ok) => { if (stageAlive()) lyricsWindow.webContents.send('stage-liner', !!ok) })
    .catch((e) => console.error('stage liner notes failed:', e.message))   // error: LOGGED-OK — the booklet didn't open; the next click tries again
}

// --- the Studio's Montage: free photos of the artist, the venue and the album's era behind the lyrics ---
// (montage-ui.js draws it; montage-sources.js finds the photos by identifiers only and keeps only free
// licences with a named author; montage-store.js keeps the downloaded thumbnails on disk, bounded.)
// Runs only with Settings' montage on (the tile; off by default) and only from stageTick, i.e. while the
// Studio shows: one Apple catalog read per new song (its artist's and album's IDs), then the answer from
// the disk cache, else Wikidata + Commons (a handful of requests per artist and album, cached 30 days, a
// "none found" 3 days), then the photos one at a time at their display width. Nothing runs at rest.
const montageSources = require('./montage-sources')
const montageModel = require('./montage-model')
const montageStoreLib = require('./montage-store')
const MONTAGE_SHOW = 8                         // photos downloaded per song (of the ≤ 12 found)
const MONTAGE_FRESH = 30 * 24 * 3600 * 1000    // a found set is asked again after 30 days
const MONTAGE_NONE = 3 * 24 * 3600 * 1000      // "no free photos" is asked again after 3 days
let montageCache = null     // JSON answers (lyrics-store.js): 'song|<id>' -> ids, 'set|<artist>|<album>' -> photos, 'px|<file>' -> extremes
let montageImages = null    // the thumbnails on disk (montage-store.js)
let montageFetch = null     // the polite fetcher (one lane per host), made on first use
let montageSong = ''        // the song the montage was last resolved for
let montageGen = 0          // bumps per resolve: an older one still running stops sending
let montageMsg = { on: false, status: 'off', photos: [] }
function montageSend(msg) {
  montageMsg = msg
  if (lyricsWindow && !lyricsWindow.isDestroyed()) lyricsWindow.webContents.send('stage-montage', msg)
}
function montageOff() {
  montageGen++
  montageSong = ''
  montageSend({ on: false, status: 'off', photos: [] })
}
// the playing song's artist and album IDs (Apple's catalog, through the page's MusicKit; read-only)
const montageIdsScript = `(async () => {
  try {
    const mk = MusicKit.getInstance();
    const item = mk.nowPlayingItem;
    const a = item ? item.attributes || {} : {};
    const id = String((a.playParams && a.playParams.catalogId) || (item && item.id) || '');
    if (!/^\\d{1,20}$/.test(id)) return { ok: false, why: 'not-catalog' };
    const r = await mk.api.music('/v1/catalog/{{storefront}}/songs/' + id, { include: 'artists,albums' });
    const d = r && r.data && r.data.data && r.data.data[0];
    const rel = (d && d.relationships) || {};
    const ar = rel.artists && rel.artists.data && rel.artists.data[0];
    const al = rel.albums && rel.albums.data && rel.albums.data[0];
    return { ok: true, song: id, artistId: ar ? String(ar.id) : '', albumId: al ? String(al.id) : '', date: String((d && d.attributes && d.attributes.releaseDate) || '') };
  } catch (e) { /* error: PASSES-ON — offline or Apple refused: main uses the IDs it saved for this song, or says offline */
    return { ok: false, why: 'failed', online: navigator.onLine };
  }
})()`
// the Studio's centre column at its largest zoom, in device pixels, for a photo of this aspect
function montageWidth(aspect) {
  const b = lyricsWindow && !lyricsWindow.isDestroyed() ? lyricsWindow.getContentBounds() : { width: stageModel.STAGE_DEFAULT.width, height: stageModel.STAGE_DEFAULT.height }
  const dpr = screen.getDisplayMatching(lyricsWindow ? lyricsWindow.getBounds() : b).scaleFactor || 1
  return montageSources.widthFor(montageModel.needWidth({ w: b.width - 292 - 312 - 10, h: b.height - 10 }, aspect, dpr))
}
// a downloaded photo's darkest and lightest pixel, once per file (cached with the answers)
function montageExtremes(name, file) {
  const k = 'px|' + name
  const had = montageCache.get(k)
  if (had) return had
  const img = nativeImage.createFromPath(file)
  if (img.isEmpty()) return null
  const x = montageModel.extremes(img.toBitmap())
  if (x) montageCache.set(k, x)
  return x
}
function montageTick(state) {
  if (!settings.montage || !montageCache) return
  // UI checks only (logged out, nothing plays): SONATA_TEST_MONTAGE=<artist id>:<album id>[:<year>] stands in for the song
  const test = !state.title && /^\d{1,20}:\d{0,20}(:\d{4})?$/.test(process.env.SONATA_TEST_MONTAGE || '') ? process.env.SONATA_TEST_MONTAGE.split(':') : null
  const song = test ? 'test|' + test.join(':') : state.title ? (state.appleId || state.title + '|' + state.artist) : ''
  if (song === montageSong) return
  montageSong = song
  const gen = ++montageGen
  if (!song) { montageSend({ on: true, status: 'idle', photos: [] }); return }
  resolveMontageSong(gen, song, test ? { artistId: test[0], albumId: test[1] || '', year: Number(test[2]) || 0 } : null)
    .catch((e) => {   // error: SHOWN — the tile says Wikimedia Commons didn't answer (click to try again); logged
      console.error('montage failed:', e && e.message)
      if (gen === montageGen) montageSend({ on: true, status: 'failed', photos: [] })
    })
}
async function resolveMontageSong(gen, song, testIds) {
  const live = () => gen === montageGen && settings.montage
  // 1. the song's artist and album IDs: Apple's catalog, else the ones saved for this song
  let ids = testIds
  let offline = false
  if (!ids) {
    let r = null
    try { r = await appleWC().executeJavaScript(montageIdsScript) } catch (e) { r = null }   // error: NOT-WORTH — page mid-navigation: treated as no answer (saved IDs below)
    if (r && r.ok && r.artistId) { ids = { artistId: r.artistId, albumId: r.albumId, year: Number(String(r.date).slice(0, 4)) || 0 }; montageCache.set('song|' + song, ids) }
    else { ids = montageCache.get('song|' + song); offline = !!(r && r.online === false) }
  }
  if (!live()) return
  if (!ids || !ids.artistId) { montageSend({ on: true, status: offline ? 'offline' : 'none', photos: [] }); return }
  // 2. the photos for this artist and album: the cache while fresh, else Wikidata + Commons
  if (!montageFetch) montageFetch = montageSources.createFetcher({ fetch: (url, o) => net.fetch(url, o), ua: montageSources.userAgent(app.getVersion()) })
  const setKey = 'set|' + ids.artistId + '|' + (ids.albumId || '')
  // the same artist and album: the photos showing just go on; another one: "Looking…" until its photos come
  if (montageMsg.set !== setKey) montageSend({ on: true, status: 'looking', photos: [] })
  let set = montageCache.get(setKey)
  const fresh = set && Date.now() - set.at < (set.photos.length ? MONTAGE_FRESH : MONTAGE_NONE)
  if (!fresh) {
    try {
      const r = await montageSources.resolveMontage(montageFetch.getJson, ids, 1280)
      set = { at: Date.now(), photos: r.photos, how: r.how }
      montageCache.set(setKey, set)
    } catch (e) {
      // error: SHOWN — offline or the service busy: the saved set if there is one (the tile says "saved"), else the tile says offline / not loaded
      offline = e && (e.kind === 'offline' || e.kind === 'timeout')
      if (!set) { if (live()) montageSend({ on: true, status: offline ? 'offline' : 'failed', photos: [] }); return }
      offline = true
    }
  }
  if (!live()) return
  if (!set.photos.length) { montageSend({ on: true, status: 'none', photos: [] }); return }
  // 3. the photos, one at a time at their display width: from disk, else downloaded (skipped offline)
  const shown = []
  const send = () => montageSend({ on: true, status: 'ready', offline, set: setKey, photos: shown.slice() })
  // loop: SERIAL-REQUIRED — ≤ 8 photos, one download at a time (Commons' etiquette), the first sent as soon as it is there
  for (const p of set.photos.slice(0, MONTAGE_SHOW)) {
    if (!live()) return
    const url = montageSources.thumbFor(p, montageWidth(p.width / p.height))
    if (!url) continue
    const name = montageStoreLib.nameFor(url, /\.png$/i.test(url) ? 'image/png' : 'image/jpeg')
    let file = montageImages.get(name)
    if (!file && !offline) {
      try {
        const img = await montageFetch.getImage(url)
        file = montageImages.put(name, img.bytes)
      } catch (e) {   // error: NOT-WORTH — one photo failed (gone, busy): the montage shows the others; offline from here on
        if (e && (e.kind === 'offline' || e.kind === 'timeout')) offline = true
        continue
      }
    }
    if (!file) continue
    const x = montageExtremes(path.basename(file), file)
    if (!x) continue
    shown.push({ id: p.id, src: require('url').pathToFileURL(file).href, author: p.author, licence: p.licence.name, licenceUrl: p.licence.url, title: p.title, page: p.page, lo: x.lo, hi: x.hi })
    if (shown.length === 1 && montageMsg.set !== setKey) send()   // the first one at once, unless this set already shows
  }
  if (!live()) return
  if (shown.length) send()
  else montageSend({ on: true, status: offline ? 'offline' : 'failed', photos: [] })
}

// lifetime: OK — every ipcMain.on / ipcMain.handle in this file is registered once at module load, never per window open (measured: counts stay at 1 after 20 open/close cycles of each window)
ipcMain.on('lyrics-command', (event, command, value) => {
  if (command === 'close') {
    if (lyricsWindow) lyricsWindow.close()
  }
  else if (command === 'show-album') {
    if (!mainWindow || mainWindow.isDestroyed()) return
    mainWindow.show()
    mainWindow.focus()
    // open the playing album through the page's own album link (client-side routing, so playback
    // goes on); without such a link on screen the window is only shown
    appleWC().executeJavaScript(songActions.openPageScript('album'))
      .catch((e) => console.error('show album failed:', e.message)) // error: LOGGED-OK — page mid-load: the window is shown, the album isn't opened
  }
  else if (command === 'art-menu') {
    // the header cover's menu (right-click, the Menu key or Shift+F10 on it): its two actions
    if (!lyricsWindow || lyricsWindow.isDestroyed()) return
    // lifetime: a fresh Menu per right-click; nothing keeps it after the popup closes, so it is garbage-collected
    Menu.buildFromTemplate([
      { label: 'View Album Cover', click: () => openCover(lyricsWindow) },
      { label: 'Liner Notes…', click: () => openLinerNotes(null, lyricsWindow) },
      { label: 'Show Album', click: () => ipcMain.emit('lyrics-command', event, 'show-album') }
    ]).popup({ window: lyricsWindow })
  }
  else if (command === 'seek') {
    const seconds = Math.max(0, Number(value) || 0)
    if (mainWindow) {
      appleWC().executeJavaScript(`(() => { MusicKit.getInstance().seekToTime(${seconds}); })();`)
        .catch((e) => console.error('lyrics seek failed:', e.message)) // error: LOGGED-OK — page mid-load: that seek is lost (the next click works)
    }
  }
})

// --- the album cover, large (cover.html): from the lyrics header cover's menu and the mini player ---
// A lightbox over the screen the window it was opened from is on: the playing song's cover at the
// size it shows (cover-model.js: the lightbox's pixels, never more than Apple's original), closed with
// Esc, a click, or by leaving it. Nothing animates; one image per open.
let coverWindow = null
const coverArtScript = `(() => {
  try {
    const item = MusicKit.getInstance().nowPlayingItem;
    const a = item ? item.attributes : null;
    const w = a && a.artwork;
    return w && w.url ? { ok: true, url: w.url, width: w.width || 0, height: w.height || 0, album: a.albumName || '', artist: a.artistName || '' } : { ok: false };
  } catch (e) { /* error: NOT-WORTH — no MusicKit yet (page loading): no cover to show, the menu item does nothing that time */
    return { ok: false };
  }
})()`
async function coverArt() {
  let art = null
  try {
    art = mainAlive() ? await appleWC().executeJavaScript(coverArtScript) : null
  } catch (e) { console.error('cover lookup failed:', e.message) }   // error: LOGGED-OK — page mid-load: no lightbox this time
  if (art && art.ok) return art
  // UI checks only (logged out, nothing plays): SONATA_TEST_ARTWORK stands in, as for the album tint
  const f = process.env.SONATA_TEST_ARTWORK
  if (!f) return null
  const img = nativeImage.createFromPath(f)
  if (img.isEmpty()) return null
  const size = img.getSize()
  return { ok: true, url: require('url').pathToFileURL(path.resolve(f)).href, width: size.width, height: size.height, album: 'Test artwork', artist: path.basename(f) }
}
async function openCover(from) {
  if (coverWindow && !coverWindow.isDestroyed()) { coverWindow.focus(); return }
  const art = await coverArt()
  if (!art || (coverWindow && !coverWindow.isDestroyed())) return
  const near = from && !from.isDestroyed() ? from.getBounds() : screen.getCursorScreenPoint()
  const display = from && !from.isDestroyed() ? screen.getDisplayMatching(near) : screen.getDisplayNearestPoint(near)
  const area = display.workArea
  const fit = coverModel.coverLayout(area, display.scaleFactor, art.width, art.height)
  const url = art.url.startsWith('file:') ? art.url : coverModel.coverUrl(art.url, fit.pxW, fit.pxH)
  // lifetime: OK — one lightbox at a time; 'closed' nulls it (it closes on Esc, a click or losing the focus)
  coverWindow = new BrowserWindow({
    x: area.x, y: area.y, width: area.width, height: area.height,
    frame: false,
    transparent: true,
    hasShadow: false,
    resizable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    show: false,
    title: appName + ' — Album cover',
    webPreferences: { nodeIntegration: true, contextIsolation: false }
  })
  coverWindow.loadFile('cover.html')
  lockDownLocalWindow(coverWindow)
  const win = coverWindow
  // lifetime: OK — fires once per load
  win.webContents.once('did-finish-load', () => {
    if (win.isDestroyed()) return
    win.webContents.send('theme', themeState())
    win.webContents.send('cover', { url, w: fit.w, h: fit.h, album: art.album, artist: art.artist })
    win.show()
    win.focus()
  })
  // lifetime: OK — 'blur' and 'closed' die with the window; leaving the lightbox closes it
  win.on('blur', () => { if (!win.isDestroyed()) win.close() })
  win.on('closed', () => { if (coverWindow === win) coverWindow = null })
}
// lifetime: OK — registered once at module load (see the note at ipcMain 'lyrics-command')
ipcMain.on('cover-command', (event, command) => {
  // only the lightbox's own page, its top frame, and only 'close'
  if (!coverWindow || coverWindow.isDestroyed() || event.sender !== coverWindow.webContents) return
  if (event.senderFrame && event.senderFrame.parent) return
  if (command === 'close') coverWindow.close()
})

// --- the liner notes (liner-notes.html): the album's booklet ---
// The album as a CD booklet: the cover and disc, Apple's editorial notes, the recording, Wikipedia's
// background, the credits, the lyrics of the songs played before, the real booklet scans, the sources.
// Opened from the lyrics window cover's menu and the mini player's menus ("Liner Notes…"), and by the
// stage view through openLinerNotes(album). One booklet window at a time; the data comes from Apple's
// catalog (through the page's MusicKit) and the outside sources (liner-notes-sources.js, matched by
// identifiers only), cached per album on disk (liner-notes-model.js, liner-notes-cache.json), so a
// booklet opened before also opens offline. Idle cost: nothing at rest; while a lyrics page of the
// playing song is open (and the window shown), a 500 ms now-playing poll marks the sung line.
const linerSources = require('./liner-notes-sources')
const linerModel = require('./liner-notes-model')
const discFind = require('./disc-find')
let linerWindow = null
let linerReady = false     // the booklet page said 'ready'
let linerStore = null      // created in app 'ready' (userData)
let linerNotes = null
let linerAlbum = null      // the open booklet's album: { id, tracks: Set of song ids }
let linerData = null       // the last 'liner-data' (resent when the page reloads)
let linerFollow = false    // the page shows a lyrics page of the playing song
let linerPoll = null
let linerPlayingKey = ''
let linerSung = null       // { key, times: [line start times] } of the playing song, while following
let linerSungLine = -2
const linerAlbumScript = (albumId, byName) => `(async () => {
  const mk = (() => { try { return MusicKit.getInstance(); } catch (e) { /* error: NOT-WORTH — no MusicKit yet (page loading): reported below as not ready */ return null; } })();
  if (!mk) return { ok: false, why: 'not-ready', online: navigator.onLine };
  const item = mk.nowPlayingItem;
  const na = item ? item.attributes : null;
  const fromSong = String((na && na.playParams && na.playParams.catalogId) || (item && item.id) || '');
  try {
    const sf = mk.storefrontId || 'us';
    let id = ${JSON.stringify(String(albumId || ''))};
    const want = ${JSON.stringify(byName || null)};
    const norm = (x) => String(x || '').toLowerCase().replace(/[^\\p{L}\\p{N}]+/gu, '');
    if (!id && want) {
      /* by name: the playing song's album when it is that album, else the catalog's album with exactly that name and artist (never a near match) */
      const same = na && norm(na.albumName) === norm(want.album) && (!want.artist || norm(na.artistName) === norm(want.artist));
      if (!same) {
        const q = await mk.api.music('/v1/catalog/' + sf + '/search', { term: (want.album + ' ' + (want.artist || '')).slice(0, 200), types: 'albums', limit: 15 });
        const list = (q && q.data && q.data.results && q.data.results.albums && q.data.results.albums.data) || [];
        const hit = list.find((x) => x.attributes && norm(x.attributes.name) === norm(want.album) && (!want.artist || norm(x.attributes.artistName) === norm(want.artist)));
        if (!hit) return { ok: false, why: 'no-album', fromSong: '', online: navigator.onLine };
        id = String(hit.id);
      }
    }
    if (!id) {
      if (!/^\\d+$/.test(fromSong)) return { ok: false, why: 'nothing', online: navigator.onLine };
      const s = await mk.api.music('/v1/catalog/' + sf + '/songs/' + fromSong, { include: 'albums' });
      const d = s && s.data && s.data.data && s.data.data[0];
      const al = d && d.relationships && d.relationships.albums && d.relationships.albums.data;
      id = al && al[0] ? String(al[0].id) : '';
      if (!id) return { ok: false, why: 'no-album', fromSong, online: navigator.onLine };
    }
    const r = await mk.api.music('/v1/catalog/' + sf + '/albums/' + id, { include: 'tracks', extend: 'editorialNotes' });
    const a = r.data.data[0];
    const at = a.attributes;
    const rel = a.relationships && a.relationships.tracks;
    let tracks = (rel && rel.data) || [];
    let next = rel && rel.next;
    for (let i = 0; next && i < 3; i++) { /* loop: SERIAL-REQUIRED — ≤ 3 more pages of a long album's track list, each after the last */
      const more = await mk.api.music(next);
      tracks = tracks.concat((more.data && more.data.data) || []);
      next = more.data && more.data.next;
    }
    return { ok: true, fromSong, album: {
      id: a.id, storefront: sf, name: at.name, artistName: at.artistName, releaseDate: at.releaseDate, recordLabel: at.recordLabel,
      copyright: at.copyright, upc: at.upc, genreNames: at.genreNames, url: at.url, artwork: at.artwork, editorialNotes: at.editorialNotes,
      tracks: tracks.filter((t) => t.type === 'songs' || t.type === 'music-videos').map((t) => ({ id: t.id, name: t.attributes.name, artistName: t.attributes.artistName,
        trackNumber: t.attributes.trackNumber, discNumber: t.attributes.discNumber, durationInMillis: t.attributes.durationInMillis,
        composerName: t.attributes.composerName, hasLyrics: t.attributes.hasLyrics }))
    } };
  } catch (e) { /* error: PASSES-ON — offline or Apple refused: main opens the cached booklet, or its page saying Apple didn't load */
    return { ok: false, why: 'failed', fromSong, albumId: ${JSON.stringify(String(albumId || ''))}, message: String((e && e.message) || e).slice(0, 200), online: navigator.onLine };
  }
})()`
function getLinerNotes() {
  if (linerNotes) return linerNotes
  linerNotes = linerModel.createLinerNotes({
    getJson: linerSources.createGetJson({ fetch: (url, opts) => net.fetch(url, opts), ua: linerSources.userAgent(app.getVersion()) }),
    store: { get: (k) => (linerStore ? linerStore.get(k) : null), set: (k, v) => { if (linerStore) linerStore.set(k, v) } },
    lang: linerSources.wikiLang(app.getLocale()),
    setlistKey: () => settings.setlistfmKey || '',
    log: (m) => console.error(m)
  })
  return linerNotes
}
// the lyrics of this album's songs that are on this computer (the lyrics cache: songs played before)
function linerLyricsFor(apple) {
  const out = {}
  if (!apple || !lyricsStore) return out
  // loop: NOT-WORTH — the album's tracks (≤ ~100), once per booklet push; in-memory cache lookups
  for (const t of apple.tracks) {
    // the track's recording by its length (the album's track list has no ISRC); an old entry of a
    // "(Live)"-style title is shown as before 0.15.42 (the booklet shows the text; the timing check is the lyrics window's)
    const got = recordingId.lookup(lyricsStore, '', recordingId.songOf({ title: t.name, artist: t.artist, duration: t.ms / 1000 }), { write: false, check: () => true }).entry
    if (!got || !Array.isArray(got.lines) || !got.lines.length) continue
    if (got.source === 'lrclib' && !settings.lrclibFallback) continue
    out[t.id] = { lines: got.lines.map((l) => ({ t: l.t, end: l.end, text: l.text || '', gap: !!l.gap })), source: got.source, writers: got.writers || [] }
  }
  return out
}
function sendLinerData(entry, pending) {
  const apple = entry.parts.apple && entry.parts.apple.data
  if (apple) linerAlbum = { id: apple.id, tracks: new Set(apple.tracks.map((t) => t.id)), byKey: new Map(apple.tracks.map((t) => [t.name + '|' + t.artist, t.id])) }
  const booklet = linerModel.buildBooklet(entry, { lyrics: linerLyricsFor(apple) })
  linerData = { booklet, pending: !!pending, opts: { spin: !!settings.lyricsArtSpin }, open: linerOpenAt, discs: linerDiscs(booklet) }
  if (linerReady && linerWindow && !linerWindow.isDestroyed()) linerWindow.webContents.send('liner-data', linerData)
}
// The disc scan's circle (disc-find.js): where the disc sits in a Cover Art Archive "Medium" scan, so the
// booklet shows exactly the disc, centred, turning about its own centre. Found once per scan from its
// 250 px thumbnail (one fetch + nativeImage decode, ~15 ms) and kept in the liner-notes cache
// ('disc:' + the thumbnail's URL; { fit: null } when no disc was found for sure: shown as before, still).
// -> { [key]: fit | null } of the circles known now; the others are sent as 'liner-disc' when found.
const linerDiscAsking = new Set()
function linerDiscs(booklet) {
  const out = {}
  // loop: NOT-WORTH — the booklet's sections and pages (≤ ~40), once per booklet push
  for (const s of booklet.sections || []) {
    for (const p of s.pages || []) {   // loop: NOT-WORTH — the section's pages
      const key = p.kind === 'tray' ? discFind.discKey(p.scan) : ''
      if (!key) continue
      const got = linerStore ? linerStore.get('disc:' + key) : null
      if (got) { out[key] = got.fit || null; continue }
      if (linerDiscAsking.has(key)) continue
      linerDiscAsking.add(key)
      findScanDisc(key).then((fit) => {
        if (fit !== undefined && linerStore) linerStore.set('disc:' + key, { fit })
        if (linerData && linerData.discs) linerData.discs[key] = fit || null
        if (linerReady && linerWindow && !linerWindow.isDestroyed()) linerWindow.webContents.send('liner-disc', { key, fit: fit || null })
      }).finally(() => linerDiscAsking.delete(key))
    }
  }
  return out
}
// -> the fit, null (no disc for sure: remembered), or undefined (the scan didn't load: asked again next time)
async function findScanDisc(url) {
  try {
    const res = await net.fetch(url, { headers: { 'User-Agent': linerSources.userAgent(app.getVersion()) } })
    if (!res.ok) throw new Error('HTTP ' + res.status)
    let img = nativeImage.createFromBuffer(Buffer.from(await res.arrayBuffer()))
    if (img.isEmpty()) return null
    const { width, height } = img.getSize()
    if (Math.max(width, height) > 300) img = img.resize(width >= height ? { width: 300 } : { height: 300 })
    const size = img.getSize()
    return discFind.findDisc({ data: img.toBitmap(), width: size.width, height: size.height })
  } catch (e) {
    // error: LOGGED-OK — offline or the archive refused: the disc shows as before (still), asked again next time
    console.error('liner notes: disc scan: ' + e.message)
    return undefined
  }
}
// the playing song as the booklet shows it (its track marked, the disc turning); sent on change only
function linerPlaying(state) {
  if (!linerReady || !linerWindow || linerWindow.isDestroyed() || !state || !state.ok) return
  const song = linerAlbum ? (linerAlbum.tracks.has(state.appleId) ? state.appleId : (linerAlbum.byKey.get(state.title + '|' + state.artist) || '')) : ''
  const p = { song, playing: !!state.isPlaying, album: !!song }
  const key = JSON.stringify(p)
  if (key === linerPlayingKey) return
  linerPlayingKey = key
  linerWindow.webContents.send('liner-playing', p)
}
// the sung line, while a lyrics page of the playing song is open and the window shows
// error: NOT-WORTH — a failing executeJavaScript returns until the next tick; at 2/s that can't hammer
async function linerTick() {
  if (!mainAlive() || !linerWindow || linerWindow.isDestroyed()) return
  let state
  try { state = await appleWC().executeJavaScript(nowPlayingScript) } catch (e) { return }   // error: NOT-WORTH — page mid-load: the next tick asks again
  if (!state || !state.ok || !linerWindow || linerWindow.isDestroyed()) return
  linerPlaying(state)
  const key = state.title + '|' + state.artist
  if (!linerSung || linerSung.key !== key) {
    const got = lyricsStore ? recordingId.lookup(lyricsStore, '', recordingId.songOf(state), { write: false }).entry : null
    linerSung = { key, times: got && Array.isArray(got.lines) ? got.lines.map((l) => (l && !l.gap && l.text && Number.isFinite(l.t) ? l.t : null)) : [] }
    linerSungLine = -2
  }
  let line = -1
  // loop: HOT-PATH-OK — one song's line starts (≤ ~150) per 500 ms tick, only while following
  for (let i = 0; i < linerSung.times.length; i++) { const t = linerSung.times[i]; if (t !== null && t <= state.playbackTime) line = i }
  const song = linerAlbum && linerAlbum.byKey.get(key)
  if (line !== linerSungLine && song) { linerSungLine = line; linerWindow.webContents.send('liner-time', { song, line }) }
}
function syncLinerPoll() {
  const want = linerFollow && linerWindow && !linerWindow.isDestroyed() && linerWindow.isVisible() && !linerWindow.isMinimized()
  if (want && !linerPoll) {
    linerSungLine = -2
    // loop: HOT-PATH-OK — the booklet's sung-line poll · 500 ms · only while a lyrics page of the playing song is open in a shown booklet · stops when the page turns away, the window hides or minimizes, or closes · cost 2 executeJavaScript/s + an IPC send per line change
    linerPoll = setInterval(linerTick, 500)
  } else if (!want && linerPoll) { clearInterval(linerPoll); linerPoll = null }
}
/**
 * openLinerNotes(album, from): the album's booklet. album: { appleId } (an Apple Music catalog album ID),
 * { album, artist } (the album's and the artist's names as Apple writes them, e.g. from the stage view:
 * the playing song's album when the names match, else the catalog album with exactly that name and
 * artist), or null for the playing song's album; from: the window it was opened from (the booklet opens
 * on its screen). -> true when a booklet opened (or was brought to the front), false when there was
 * nothing to open (nothing playing, or no album with that name). opts.section: the section to open at
 * ('credits', 'recording'), when the booklet has it.
 */
let linerOpenAt = null     // the section a booklet was asked to open at ({ section, n }: the Studio's credits / recording)
let linerOpenSeq = 0
async function openLinerNotes(album, from, opts) {
  const want = album && /^\d{1,20}$/.test(String(album.appleId || '')) ? String(album.appleId) : ''
  const byName = !want && album && typeof album.album === 'string' && album.album.trim()
    ? { album: album.album.trim().slice(0, 300), artist: typeof album.artist === 'string' ? album.artist.trim().slice(0, 300) : '' } : null
  let res = null
  try { res = mainAlive() ? await appleWC().executeJavaScript(linerAlbumScript(want, byName)) : null } catch (e) { console.error('liner notes: album lookup failed:', e.message) }   // error: LOGGED-OK — page mid-load: handled below as "Apple didn't answer"
  const raw = res && res.ok ? res.album : null
  // offline, from the playing song: the album it belonged to the last time (remembered with the booklet)
  const fromSong = res && /^\d+$/.test(res.fromSong || '') ? res.fromSong : ''
  let idHint = ''
  if (!raw) {
    const nameKey = byName ? 'name:' + (byName.album + '|' + byName.artist).toLowerCase() : ''
    idHint = want || (linerStore ? (byName ? linerStore.get(nameKey) : (fromSong ? linerStore.get('song:' + fromSong) : '')) || '' : '')
    if (!idHint && (!res || res.why === 'nothing' || res.why === 'not-ready' || (byName && res.why === 'no-album'))) return false   // nothing playing, no such album, or no page yet: nothing to open
  } else if (linerStore && byName) linerStore.set('name:' + (byName.album + '|' + byName.artist).toLowerCase(), String(raw.id))   // offline next time: the album this name found
  else if (linerStore && fromSong && !want) linerStore.set('song:' + fromSong, String(raw.id))
  const err = raw ? null : linerSources.failure(res && res.online === false ? 'offline' : 'apple', (res && res.message) || 'Apple Music didn\'t answer')
  if (!linerWindow || linerWindow.isDestroyed()) createLinerWindow(from)
  else { if (linerWindow.isMinimized()) linerWindow.restore(); linerWindow.show(); linerWindow.focus() }
  linerPlayingKey = ''
  linerOpenAt = opts && /^(credits|recording)$/.test(opts.section || '') ? { section: opts.section, n: ++linerOpenSeq } : null
  getLinerNotes().load(raw, err, (entry, pending) => sendLinerData(entry, pending), idHint)
  return true
}
// the entry point for other parts of Sonata (the stage view) and the UI checker (process.mainModule.exports)
module.exports.openLinerNotes = openLinerNotes
function createLinerWindow(from) {
  linerReady = false
  linerData = null
  const opts = { width: 1120, height: 780, minWidth: 700, minHeight: 520 }
  const fromWin = from && !from.isDestroyed() ? from : null
  const area = (fromWin ? screen.getDisplayMatching(fromWin.getBounds()) : screen.getDisplayNearestPoint(screen.getCursorScreenPoint())).workArea
  opts.width = Math.min(opts.width, area.width); opts.height = Math.min(opts.height, area.height)
  opts.x = area.x + Math.round((area.width - opts.width) / 2); opts.y = area.y + Math.round((area.height - opts.height) / 2)
  // lifetime: OK — one booklet at a time; 'closed' stops its poll and nulls it
  linerWindow = new BrowserWindow(applySavedBounds(Object.assign(opts, {
    frame: false,
    roundedCorners: false,   // the card draws its own corners (as the lyrics window)
    transparent: true,
    hasShadow: false,
    show: false,
    title: appName + ' — Liner Notes',
    webPreferences: { nodeIntegration: true, contextIsolation: false }
  }), 'linerBounds'))
  const win = linerWindow
  win.loadFile('liner-notes.html')
  persistBounds(win, 'linerBounds')
  lockDownLocalWindow(win)
  // lifetime: OK — fires once per load
  win.webContents.once('did-finish-load', () => {
    if (win.isDestroyed()) return
    win.webContents.send('theme', themeState())
    win.show()
    win.focus()
  })
  // lifetime: OK — these die with the window; hidden or minimized, the sung-line poll stops
  win.on('minimize', syncLinerPoll); win.on('restore', syncLinerPoll); win.on('hide', syncLinerPoll); win.on('show', syncLinerPoll)
  win.on('closed', () => {
    if (linerWindow !== win) return
    linerWindow = null; linerReady = false; linerFollow = false; linerAlbum = null; linerData = null; linerSung = null
    syncLinerPoll()
  })
}
// lifetime: OK — registered once at module load (see the note at ipcMain 'lyrics-command')
// error: NOT-WORTH — anything else (another sender, a subframe, an unknown command or a bad argument) is dropped
ipcMain.on('liner-command', (event, command, arg) => {
  // only the booklet's own page, its top frame, each argument checked
  if (!linerWindow || linerWindow.isDestroyed() || event.sender !== linerWindow.webContents) return
  if (event.senderFrame && event.senderFrame.parent) return
  if (command === 'close') linerWindow.close()
  else if (command === 'ready') {
    linerReady = true
    linerPlayingKey = ''
    linerWindow.webContents.send('theme', themeState())
    if (linerData) linerWindow.webContents.send('liner-data', linerData)
    if (mainAlive()) {
      appleWC().executeJavaScript(nowPlayingScript).then(linerPlaying)
        .catch((e) => console.error('liner notes: now playing failed:', e.message))   // error: LOGGED-OK — page mid-load: the next poll tells the booklet
    }
  }
  else if (command === 'open-link' && typeof arg === 'string' && arg.length < 2048 && /^https:\/\/[^\s]+$/.test(arg)) openExternalSafe(arg)
  else if (command === 'follow' && typeof arg === 'boolean') { linerFollow = arg; syncLinerPoll() }
})

// --- audio-reactive visualizer / ambient mode ---

function createVizWindow() {
  // lifetime: OK — one visualizer at a time; 'closed' stops its audio and nulls it
  vizWindow = new BrowserWindow({
    fullscreen: true,
    frame: false,
    roundedCorners: false,   // Electron 43+ rounds frameless Linux windows; the stage fills the screen edge to edge
    backgroundColor: '#000000',
    title: appName + ' — Visualizer',
    webPreferences: { nodeIntegration: true, contextIsolation: false }
  })
  vizWindow.loadFile('visualizer.html')
  lockDownLocalWindow(vizWindow)
  pushRail()
  // the lyrics and visualizer shortcuts in the visualizer too (Ctrl+Shift+V closes it again)
  // lifetime: OK — registered once per visualizer window, dies with its webContents
  vizWindow.webContents.on('before-input-event', (event, input) => { viewShortcut(input) })

  // lifetime: OK — one Visualizer (FFT) and one handle on the shared own-stream listener (the one parec,
  // see getSharedListener) per visualizer window; both stopped and dropped on 'closed'
  const toViz = (channel, value) => { if (vizWindow && !vizWindow.isDestroyed()) vizWindow.webContents.send(channel, value) }
  visualizer = new Visualizer((bands) => toViz('viz-bands', bands), { onState: (state) => toViz('viz-audio-state', state) })
  vizListener = getSharedListener()({ sampleRate: VIZ_RATE, onChunk: (mid) => { if (visualizer) visualizer.push(mid) } })

  // the lyrics feed drives the overlay's lyrics, its now-playing and its audio (vizAudioTick)
  trackHdr(vizWindow)
  vizWindow.webContents.once('did-finish-load', () => {
    startLyricsFeed()
    if (lastPalette) vizWindow.webContents.send('palette', lastPalette)   // album accent for the sung word
    if (visualizer && visualizer.audioState) toViz('viz-audio-state', visualizer.audioState)   // a capture problem already known
  })

  // lifetime: OK — 'closed' stops the listener handle (the parec ends when no other user listens) and the
  // Visualizer (kills its fallback parec, if any) and nulls vizWindow; the
  // lyrics feed stops when no lyric view is left
  vizWindow.on('closed', () => {
    if (vizListener) { vizListener.stop(); vizListener = null }
    if (visualizer) { visualizer.stop(); visualizer = null }
    vizWindow = null
    stopLyricsFeedIfIdle()
    pushRail()
  })
}

// Visualizer audio, per lyrics-feed tick (2/s): listen to Sonata's own stream while the song plays
// (the stream may be gone while paused) and show silence on pause. When our stream can't be found
// (audio-listen gives up: 'unavailable'), fall back to the whole-system monitor, logged once.
// loop: HOT-PATH-OK — spectrum stream · ~43 frames/s from parec · runs while the visualizer exists and the song
// plays (fallback: while the visualizer exists) · stops on pause (listener) and on viz 'closed' ·
// cost one 1024-point FFT + one IPC send per frame
function vizAudioTick(isPlaying) {
  if (!vizListener || !visualizer || visualizer.fallback) return   // on the system-monitor fallback (it restarts itself)
  if (vizListener.state === 'unavailable') {
    console.log('visualizer: own audio stream not found, showing the whole system mix')
    vizListener.stop()
    visualizer.startMonitor()
    return
  }
  if (isPlaying) vizListener.start()
  else if (vizListener.state !== 'idle') { vizListener.stop(); visualizer.silence() }
}

// Lyrics and visualizer from either player: the same keys in the main window and the mini player,
// shown as accelerator labels in the tray and "More" menus (labels only; the keys are handled here)
const LYRICS_KEY = 'Ctrl+Shift+L'
const STAGE_KEY = 'Ctrl+Shift+S'
const VISUALIZER_KEY = 'Ctrl+Shift+V'
const MINI_KEY = 'Ctrl+M'   // handled in the main window's before-input-event; a label for the rail
function viewShortcut(input) {
  if (input.type !== 'keyUp' || !input.control || !input.shift || input.alt) return false
  const key = input.key.toLowerCase()
  if (key === 'l') toggleLyricsWindow()
  else if (key === 's') toggleStage()
  else if (key === 'v') toggleVisualizer()
  else return false
  return true
}

function toggleVisualizer() {
  if (vizWindow) vizWindow.close()
  else createVizWindow()
}

// lifetime: OK — registered once at module load (see above)
ipcMain.on('viz-close', () => { if (vizWindow) vizWindow.close() })

// --- three-dots menu on the mini player ---

const trackInfoScript = `(async () => {
  try {
    const mk = MusicKit.getInstance();
    const item = mk.nowPlayingItem;
    if (!item) return { ok: false };
    const attrs = item.attributes || {};
    const pp = attrs.playParams || {};
    const id = pp.catalogId || pp.id || item.id;
    let rating = 0;
    try {
      const r = await mk.api.music('/v1/me/ratings/songs', { ids: id });
      const entry = r && r.data && r.data.data && r.data.data[0];
      rating = entry && entry.attributes ? entry.attributes.value : 0;
    } catch (e) { /* error: NOT-WORTH — not rated (or no answer): shown as not a favourite */ }
    return { ok: true, id: String(id), title: attrs.name || '', url: attrs.url || '', rating };
  } catch (e) { /* error: NOT-WORTH — no song or MusicKit: the menu opens without the song items */
    return { ok: false };
  }
})()`

// The playing song's source (song-actions.js): Apple Music's adapter; the Studio and the ⋯ menus ask it
const songSource = songActions.createAppleSource({ run: (code) => (mainAlive() ? appleWC().executeJavaScript(code) : Promise.reject(new Error('Apple Music\'s page isn\'t open'))) })
// for the UI checker (process.mainModule.exports, its test copy only): the source (its methods can be stood in for),
// and the queue and song the Studio's menus act on (the checker feeds the page a queue main didn't read)
module.exports.studioTest = { source: songSource, setQueue: (q) => { stageQueueLast = stageModel.cleanQueue(q) }, setSong: (st) => { stageSong = songActions.cleanState(st) }, setNowPlaying: (np) => { stageSent = JSON.stringify(np) } }
/**
 * One song action from a menu or the Studio: 'favorite' | 'undo-favorite' | 'library' | 'link' | 'share'.
 * info: { id, title, artist, url }; done(action, ok, extra) tells the place it came from.
 */
function songAct(action, info, done) {
  let job
  if (action === 'favorite' || action === 'undo-favorite') job = songSource.favorite(info.id, action === 'favorite')
  else if (action === 'library') job = songSource.addToLibrary(info.id)
  else if (action === 'link') job = info.url ? clipboard.writeText(info.url) : Promise.reject(new Error('no link'))
  else if (action === 'share') job = info.url ? clipboard.writeText([info.title, info.artist].filter(Boolean).join(' \u2014 ') + '\n' + info.url) : Promise.reject(new Error('no link'))
  else return
  // Electron 44+: clipboard.writeText returns a Promise
  Promise.resolve(job).then(() => done(action, true))
    .catch((e) => {   // error: SHOWN — every song action's failure is told where it was asked (done: the Studio's note, the mini player's notice)
      console.error(action + ' failed:', e.message)
      done(action, false, mainAlive() ? '' : 'nothing')
    })
}
// the mini player's ⋯: a failure is told by actionFailed (a later one that works takes an old notice away)
function miniActionDone(action, ok, extra) {
  if (ok) { notices.clear('mini-action'); return }
  const text = miniModel.actionFailedText(action, extra)
  if (text) actionFailed(text)
}
/**
 * The song's menu items, one source for the mini player's ⋯ and the Studio's ⋯ (no duplicate actions).
 * pick: the items in order ('-' a separator); done(action, ok, why, info): where a result is told (songAct).
 */
function songMenuItems(info, win, pick, done) {
  const ok = !!(info.ok && songActions.safeId(info.id))
  const report = (action, okk, why) => done(action, okk, why, info)
  const items = {
    favorite: info.rating === 1
      ? { label: 'Undo Favorite', enabled: ok, click: () => songAct('undo-favorite', info, report) }
      : { label: 'Favorite', enabled: ok, click: () => songAct('favorite', info, report) },
    library: { label: 'Add to Library', enabled: ok, click: () => songAct('library', info, report) },
    link: { label: 'Copy Link', enabled: !!info.url, click: () => songAct('link', info, report) },
    cover: { label: 'View Album Cover', enabled: !!info.title, click: () => openCover(win) },
    liner: { label: 'Liner Notes…', enabled: !!info.title, click: () => openLinerNotes(null, win) },
    share: {
      label: 'Share', enabled: !!info.url, submenu: [
        { label: 'Copy Song and Link', click: () => songAct('share', info, report) },
        { label: 'Email…', click: () => openExternalSafe('mailto:?subject=' + encodeURIComponent([info.title, info.artist].filter(Boolean).join(' \u2014 ')) + '&body=' + encodeURIComponent(info.url)) }
      ]
    }
  }
  // a queue row's items (the Studio's Up Next): info.row = { index, id, albumId, composer, cur }
  const row = info.row
  if (row) {
    items['play-now'] = { label: row.cur ? 'Playing Now' : 'Play Now', enabled: !row.cur, click: () => ipcStagePlay(row.index, row.id) }
    items['play-next'] = {
      label: 'Play Next', enabled: !row.cur,
      click: () => songSource.playNext(row.index, row.id).then((r) => done('play-next', r === 'ok', r === 'ok' ? '' : r, info))
        .catch((e) => { console.error('play next failed:', e.message); done('play-next', false, '', info) })   // error: SHOWN — the Studio's note says Play Next didn't go through
    }
    items.album = { label: 'Go to Album', enabled: !!row.albumId, click: () => stageOpenPage('album', row.albumId) }
    items.credits = { label: 'Credits', click: () => (row.cur ? stageAlive() && lyricsWindow.webContents.send('stage-flip', true) : stageRowCredits(row, info)) }
  }
  // loop: NOT-WORTH — a handful of items, once per menu open
  return pick.map((k) => (k === '-' ? { type: 'separator' } : items[k]))
}
// A ⋯ menu action that failed. The menu lives in the mini player, which hides the main window, so
// the panel's notices and the toasts aren't seen: a desktop notification says it (not gated by the
// track-notification setting: the user just asked for this). With the main window showing (or no
// desktop notifications), an error notice at the top of the side panel says it instead.
function actionFailed(text) {
  if (!text) return
  if ((!mainAlive() || !mainWindow.isVisible()) && Notification.isSupported()) {
    // lifetime: OK — shown and collected, no listeners kept (as notifyTrack's)
    new Notification({ title: text.title, body: text.body, silent: true }).show()
    return
  }
  notices.show({ id: 'mini-action', place: 'top', kind: 'error', text: text.title + '. ' + text.body })
}

// Read the current song's favorite rating. The id never leaves the page, so
// there is no string-interpolation/injection surface.
const ratingFetchScript = `(async () => {
  try {
    const mk = MusicKit.getInstance();
    const item = mk.nowPlayingItem;
    if (!item) return { ok: false };
    const attrs = item.attributes || {};
    const pp = attrs.playParams || {};
    const id = pp.catalogId || pp.id || item.id;
    const r = await mk.api.music('/v1/me/ratings/songs', { ids: id });
    const entry = r && r.data && r.data.data && r.data.data[0];
    return { ok: true, rating: entry && entry.attributes ? entry.attributes.value : 0 };
  } catch (e) { /* error: NOT-WORTH — no answer: shown as not a favourite (star off) */
    return { ok: true, rating: 0 };
  }
})()`

// Toggle the current song's favorite state, entirely in the page context.
const toggleFavoriteScript = `(async () => {
  try {
    const mk = MusicKit.getInstance();
    const item = mk.nowPlayingItem;
    if (!item) return { ok: false };
    const attrs = item.attributes || {};
    const pp = attrs.playParams || {};
    const id = pp.catalogId || pp.id || item.id;
    let rating = 0;
    try {
      const r = await mk.api.music('/v1/me/ratings/songs', { ids: id });
      const entry = r && r.data && r.data.data && r.data.data[0];
      rating = entry && entry.attributes ? entry.attributes.value : 0;
    } catch (e) { /* error: NOT-WORTH — not rated (or no answer): treated as not a favourite */ }
    if (rating === 1) {
      await mk.api.music('/v1/me/ratings/songs/' + id, {}, { fetchOptions: { method: 'DELETE' } });
      return { ok: true, rating: 0 };
    }
    await mk.api.music('/v1/me/ratings/songs/' + id, {}, { fetchOptions: {
      method: 'PUT',
      body: JSON.stringify({ type: 'rating', attributes: { value: 1 } }),
      headers: { 'Content-Type': 'application/json' }
    } });
    return { ok: true, rating: 1 };
  } catch (e) { /* error: NOT-WORTH — failed: { ok: false }, the star stays as it was */
    return { ok: false };
  }
})()`

async function showMoreMenu() {
  if (!mainAlive() || !miniWindow || miniWindow.isDestroyed()) return
  let info = null
  try {
    info = await appleWC().executeJavaScript(trackInfoScript)
  } catch (e) { info = null }   // error: NOT-WORTH — page mid-navigation: the menu opens without the song's items
  // nothing playing: the menu still opens (Lyrics, Visualizer, Always on Top, Open Full Player); the
  // song's own items are there but disabled, so the ⋯ never does nothing
  if (!info || !info.ok) info = { ok: false, id: '', title: '', url: '', rating: 0 }

  // lifetime: a fresh Menu per "More" click; nothing keeps it after the popup closes, so it is garbage-collected
  const menu = Menu.buildFromTemplate([
    { label: info.title || 'Not playing', enabled: false },
    { type: 'separator' },
    ...songMenuItems(info, miniWindow, ['favorite', 'library', '-', 'link', 'cover', 'liner'], (action, ok, why, song) => miniActionDone(action, ok, song.title)),
    { label: 'Lyrics', accelerator: LYRICS_KEY, registerAccelerator: false, click: toggleLyricsWindow },
    { label: 'Visualizer', accelerator: VISUALIZER_KEY, registerAccelerator: false, click: toggleVisualizer },
    { type: 'separator' },
    {
      label: 'Always on Top',
      type: 'checkbox',
      checked: settings.miniAlwaysOnTop,
      click: (item) => {
        // one toggle keeps both floating windows (mini + lyrics) on top
        settings.miniAlwaysOnTop = item.checked
        settings.lyricsAlwaysOnTop = item.checked
        if (miniWindow && !miniWindow.isDestroyed()) miniWindow.setAlwaysOnTop(item.checked)
        if (lyricsWindow && !lyricsWindow.isDestroyed()) lyricsWindow.setAlwaysOnTop(item.checked)
        applyMiniKeepAbove(item.checked)
        applyLyricsKeepAbove(item.checked)
        saveSettings()
        pushPanel()
      }
    },
    { label: 'Open Full Player', click: toggleMiniPlayer }
  ])
  menu.popup({ window: miniWindow })
}

// On Wayland a window can't raise itself, so setAlwaysOnTop is a no-op
// there. KWin (KDE) exposes keep-above through its D-Bus scripting API;
// drive that as a fallback. Other Wayland compositors offer no client path.
// lifetime: OK — one short-lived qdbus child per call (window open / setting change), never on a timer
function applyKeepAbove(caption, scriptId, on) {
  if (process.platform !== 'linux' || !process.env.WAYLAND_DISPLAY) return
  if (!(process.env.XDG_CURRENT_DESKTOP || '').split(':').includes('KDE')) return
  const scriptPath = path.join(os.tmpdir(), scriptId + '.js')
  try {
    fs.writeFileSync(scriptPath,
      `for (const w of workspace.windowList()) if (w.caption === ${JSON.stringify(caption)}) w.keepAbove = ${on};`)
  } catch (e) { return }   // error: NOT-WORTH — tmp not writable: setAlwaysOnTop stays the only keep-above
  const scripting = '$Q org.kde.KWin /Scripting org.kde.kwin.Scripting'
  // lifetime: OK — one short qdbus run, it ends by itself
  exec(
    `Q=$(command -v qdbus6 || command -v qdbus) && ` +
    `${scripting}.unloadScript ${scriptId} >/dev/null 2>&1; ` +
    `id=$(${scripting}.loadScript ${scriptPath} ${scriptId}) && ` +
    `$Q org.kde.KWin /Scripting/Script$id org.kde.kwin.Script.run && ` +
    `${scripting}.unloadScript ${scriptId}`,
    (err) => { if (err) console.error('kwin keep-above failed:', err.message) }
  )
}
// KWin's real blur behind the mini player's pill (Apple's player bar blurs what's behind it), on KDE
// under X11 (Sonata often runs with --ozone-platform=x11): the window's _KDE_NET_WM_BLUR_BEHIND_REGION,
// shaped like the pill (mini-model.js blurRegion), set with xprop. Native Wayland would need the
// org_kde_kwin_blur protocol, which Electron gives no way to reach; there, and on other desktops,
// the pill keeps the Glass material (artwork) or its plain tint.
// lifetime: OK — one short-lived xprop child per mini open or Glass change, never on a timer
// error: NOT-WORTH — xprop missing or failing: logged once, the pill keeps its tint (the page doesn't know the difference)
function miniBlurAvailable() {
  if (process.platform !== 'linux' || !(process.env.XDG_CURRENT_DESKTOP || '').split(':').includes('KDE')) return false
  const ozone = app.commandLine.getSwitchValue('ozone-platform') || process.env.ELECTRON_OZONE_PLATFORM_HINT || ''
  return ozone === 'x11' || (!process.env.WAYLAND_DISPLAY && !!process.env.DISPLAY)
}
const glassOn = () => !!settings.glass && !!settings.adaptiveColor
function applyMiniBlur() {
  if (!miniWindow || miniWindow.isDestroyed() || !miniBlurAvailable()) return
  const h = miniWindow.getNativeWindowHandle()
  const xid = h.length >= 8 ? Number(h.readBigUInt64LE(0)) : h.readUInt32LE(0)
  if (!xid) return
  const b = miniWindow.getContentBounds()
  const scale = screen.getDisplayMatching(miniWindow.getBounds()).scaleFactor || 1
  const args = glassOn()
    ? ['-id', String(xid), '-f', '_KDE_NET_WM_BLUR_BEHIND_REGION', '32c', '-set', '_KDE_NET_WM_BLUR_BEHIND_REGION', miniModel.blurRegion(4, 4, b.width - 8, b.height - 8, scale).join(',')]
    : ['-id', String(xid), '-remove', '_KDE_NET_WM_BLUR_BEHIND_REGION']
  // lifetime: OK — one short xprop run per mini open or Glass change
  execFile('xprop', args, (err) => { if (err) console.error('mini blur: xprop failed:', err.message) })
}
function applyMiniKeepAbove(on) { applyKeepAbove(appName + ' — Mini Player', 'sonata-keep-above-mini', on) }
function applyLyricsKeepAbove(on) { applyKeepAbove(appName + ' — Lyrics', 'sonata-keep-above-lyrics', on) }

// Wayland won't let an app read or set its own window position, so we can't
// remember it ourselves. KWin (KDE) can, via a "remember position" window rule
// (positionrule=4). Install one per window, matched by title, once — then KWin
// persists each window's spot across sessions on its own.
// Earlier versions tried to remember window positions on KDE Wayland (first
// via KWin rules, then KWin scripting). It fought the compositor and shoved
// windows around unpredictably, so it's removed — KDE places windows normally.
// This one-time cleanup undoes what those versions wrote.
function cleanupWindowPositionMemory() {
  if (settings.winPos) { delete settings.winPos; saveSettings() }
  if (process.platform !== 'linux' || !process.env.WAYLAND_DISPLAY) return
  if (!(process.env.XDG_CURRENT_DESKTOP || '').split(':').includes('KDE')) return
  const rulesFile = path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'kwinrulesrc')
  let text
  try { text = fs.readFileSync(rulesFile, 'utf8') } catch (e) { return }   // error: NOT-WORTH — no kwinrulesrc: nothing to clean
  if (!text.includes('Sonata:remember-position')) return
  const remove = []
  const re = /\[([0-9a-fA-F-]{36})\]\n([\s\S]*?)(?=\n\[|$)/g
  let m
  // loop: NOT-WORTH — once per start, a few KWin rules
  while ((m = re.exec(text))) { if (m[2].includes('Sonata:remember-position')) remove.push(m[1]) }
  let out = text
  for (const id of remove) out = out.replace(new RegExp('\\n?\\[' + id + '\\][\\s\\S]*?(?=\\n\\[|$)'), '')
  const gen = out.match(/\[General\][\s\S]*?(?=\n\[|$)/)
  if (gen) {
    const rm = gen[0].match(/^rules=(.*)$/m)
    const list = (rm && rm[1].trim() ? rm[1].trim().split(',') : []).filter((x) => !remove.includes(x))
    const block = gen[0].replace(/^count=\d+/m, 'count=' + list.length).replace(/^rules=.*$/m, 'rules=' + list.join(','))
    out = out.replace(gen[0], block)
  }
  try {
    fs.writeFileSync(rulesFile, out)
    // lifetime: OK — one short qdbus run, it ends by itself
    exec('Q=$(command -v qdbus6 || command -v qdbus) && $Q org.kde.KWin /KWin reconfigure', () => {})
  } catch (e) {}   // error: NOT-WORTH — kwinrulesrc not writable: the old rules stay (one-time cleanup)
}

// --- adaptive album-art color and the Glass backdrop ---
// Every Sonata window takes the album's colour and (Glass on) the blurred artwork through ONE theme
// object (themeState: theme.js computes the tokens in each page); the visualizer also keeps its
// 'palette' (the sung word's glow).
let lastBackdrop = null    // { dark: { url, lumMin, lumMax }, light: {...} } for the current track
function broadcastPalette(p) {
  const t = themeState()
  // loop: NOT-WORTH — 3 windows (and the booklet), once per palette change
  for (const w of [miniWindow, lyricsWindow, vizWindow]) {
    if (!w || w.isDestroyed()) continue
    w.webContents.send('palette', p)
    if (w !== vizWindow) w.webContents.send('theme', t)   // the visualizer's stage is always dark (theme.css --s-stage-*)
  }
  if (linerWindow && !linerWindow.isDestroyed()) linerWindow.webContents.send('theme', t)   // the booklet: its card and paper
  pushRail()   // the rail's surface takes the accent (and the Glass) too
  pushPanel()
  syncToasts()
}
// The Glass material's backdrop: the artwork at 40×40, saturated, blurred and squeezed into a light
// band (light mode) and a dark band (dark mode), as two small PNG data URLs (theme.js makeBackdrop).
// Once per track change; the pages scale it up (which blurs it further) and crossfade to it.
// loop: HOT-PATH-OK — 2 × 1,600 pixels, once per track change (measured ~3-6 ms, docs/PERFORMANCE.md)
function makeBackdrops(img) {
  const size = 40
  const bmp = img.resize({ width: size, height: size, quality: 'good' }).toBitmap()
  const out = {}
  for (const mode of ['dark', 'light']) {
    const b = themeLib.makeBackdrop(bmp, size, size, { dark: mode === 'dark' })
    if (!b) return null
    const url = nativeImage.createFromBitmap(Buffer.from(b.data.buffer, b.data.byteOffset, b.data.byteLength), { width: size, height: size }).toDataURL()
    out[mode] = { url, lumMin: +b.lumMin.toFixed(4), lumMax: +b.lumMax.toFixed(4), lo: b.lo, hi: b.hi }
  }
  return out
}
// lifetime: called from the mini/lyrics polls and (for the rail's and the panel's tint) the 5 s tick
// while the main window is shown, never in tray-only state. One artwork fetch + nativeImage per track
// change (keyed by title|artist); the buffer and images are locals, only the small palette object and
// the two ~3 KB backdrop data URLs survive (lastPalette, lastBackdrop). Nothing accumulates per track.
async function refreshPalette(state) {
  if (!settings.adaptiveColor) {
    if (lastPalette !== null) { lastPalette = null; lastBackdrop = null; lastPaletteKey = null; broadcastPalette(null) }
    return
  }
  if (process.env.SONATA_TEST_ARTWORK && !state.title) return   // UI checks: the test artwork stays
  const key = (state.title || '') + '|' + (state.artist || '')
  if (key === lastPaletteKey) return
  lastPaletteKey = key
  const url = state.artworkLarge || state.artwork
  if (!url) { lastPalette = null; lastBackdrop = null; broadcastPalette(null); return }
  try {
    const res = await fetch(url)
    useArtwork(nativeImage.createFromBuffer(Buffer.from(await res.arrayBuffer())))
  } catch (e) { /* error: NOT-WORTH — artwork unreachable: the previous palette stays */ }
}
function useArtwork(full) {
  lastPalette = extractPalette(full.resize({ width: 32, height: 32 }).toBitmap(), { bgra: true })
  lastBackdrop = makeBackdrops(full)
  broadcastPalette(lastPalette)
}
// UI checks only (tools/ui-check.js): SONATA_TEST_ARTWORK=<local image> stands in for a playing
// song's artwork (the checks run logged out, with nothing playing), so the album tint and the Glass
// backdrop can be measured over a worst-case picture. Unset (always, in normal use): nothing happens.
function useTestArtwork() {
  const f = process.env.SONATA_TEST_ARTWORK
  if (!f || !settings.adaptiveColor) return
  const img = nativeImage.createFromPath(f)
  if (img.isEmpty()) { console.error('test artwork: unreadable ' + f); return }
  lastPaletteKey = 'test-artwork'
  useArtwork(img)
}

function toggleMiniPlayer() {
  if (miniWindow) {
    miniWindow.close()
  }
  else {
    if (mainWindow) mainWindow.hide()
    createMiniWindow()
  }
}

// lifetime: OK — registered once at module load (see the note at ipcMain 'lyrics-command')
ipcMain.on('mini-command', (event, command, value) => {
  if (command === 'expand') {
    toggleMiniPlayer()
  }
  else if (command === 'queue') {
    toggleMiniPlayer()
    playerCommand('openQueue')
  }
  else if (command === 'lyrics') {
    toggleLyricsWindow()
  }
  else if (command === 'moreMenu') {
    showMoreMenu()
  }
  else if (command === 'artMenu') {
    // the artwork's menu (right-click, the Menu key or Shift+F10 on it)
    if (!miniWindow || miniWindow.isDestroyed()) return
    // lifetime: a fresh Menu per right-click; nothing keeps it after the popup closes, so it is garbage-collected
    Menu.buildFromTemplate([
      { label: 'View Album Cover', click: () => openCover(miniWindow) },
      { label: 'Liner Notes…', click: () => openLinerNotes(null, miniWindow) },
      { label: 'Open Full Player', click: toggleMiniPlayer }
    ]).popup({ window: miniWindow })
  }
  else if (command === 'toggleFavorite') {
    if (mainAlive()) {
      appleWC().executeJavaScript(toggleFavoriteScript)
        .then((res) => {
          if (res && res.ok && miniWindow && !miniWindow.isDestroyed()) {
            miniWindow.webContents.send('favorite-state', res)
          }
        })
        .catch((e) => console.error('toggle favorite failed:', e.message)) // error: LOGGED-OK — the star stays as it was, so the user sees nothing changed
    }
  }
  else if (command === 'seek') {
    const seconds = Math.max(0, Number(value) || 0)
    if (mainAlive()) {
      appleWC().executeJavaScript(`(() => { MusicKit.getInstance().seekToTime(${seconds}); })();`)
        .catch((e) => console.error('seek failed:', e.message)) // error: LOGGED-OK — page mid-load: that seek is lost
    }
  }
  else if (command === 'setVolume') {
    const volume = Math.min(1, Math.max(0, Number(value) || 0))
    if (mainAlive()) {
      appleWC().executeJavaScript(`(() => { MusicKit.getInstance().volume = ${volume}; })();`)
        .catch((e) => console.error('set volume failed:', e.message)) // error: LOGGED-OK — page mid-load: the volume stays
    }
  }
  else {
    playerCommand(command)
  }
})

// --- now-playing consumers: Last.fm scrobbling and Discord presence ---

// lifetime: OK — one artwork fetch + nativeImage + Notification per track change while playing; none are
// stored, so they're collected after display. No listeners are attached to the Notification.
async function notifyTrack(state) {
  if (!settings.notifications || !Notification.isSupported()) return
  let icon
  try {
    if (state.artwork) {
      const res = await fetch(state.artwork)
      icon = nativeImage.createFromBuffer(Buffer.from(await res.arrayBuffer()))
    }
  } catch (e) { /* error: NOT-WORTH — no art: the notification shows without it */ }
  const body = state.artist + (state.album ? ' — ' + state.album : '')
  // lifetime: OK — shown and collected, no listeners kept
  new Notification({ title: state.title, body, icon, silent: true }).show()
}

function startNowPlayingLoop() {
  // loop: HOT-PATH-OK — tray / notifications / Last.fm / Discord now-playing poll · 5000 ms · runs always (the tray
  // always exists, so the guard below never short-circuits) — this is the ONLY recurring work in the
  // tray-only state · stops on app exit · cost 1 executeJavaScript every 5 s; measured 0.03-0.06 % of one
  // core in the main process (docs/PERFORMANCE.md). Left as is: tray tooltip, track-change notifications,
  // scrobble timing (playedSeconds += 5 per tick) and Discord presence all need it.
  // error: NOT-WORTH — a failing executeJavaScript skips to the next tick; at 1 per 5 s it can't hammer
  setInterval(async () => {
    const wantLastfm = lastfm && lastfm.connected
    const wantDiscord = discordConfig.enabled && discordConfig.applicationId
    const wantNotify = settings.notifications
    // scrobbles that failed before (or waited at the last quit) go out when their backoff is over
    if (wantLastfm && scrobbleQueue) scrobbleQueue.tick()
    if ((!wantLastfm && !wantDiscord && !wantNotify && !tray) || !mainAlive()) return
    let state
    try {
      state = await appleWC().executeJavaScript(nowPlayingScript)
    } catch (e) { // error: NOT-WORTH — page mid-load: skipped to the next tick
      return
    }
    if (!state || !state.ok) return
    setPlaying(!!state.isPlaying)
    if (tray) updateTrayTooltip(state)
    if (linerWindow) linerPlaying(state)   // the booklet's playing track (sent on change only)
    // the rail's album tint (one artwork fetch per track change, while the main window shows) and
    // its status dots (Discord reconnecting, the align helper starting/stopping): sent on change only
    if ((railMounted || panelMounted) && mainWindow.isVisible()) refreshPalette(state)
    pushRail()
    pushPanel()
    if (wantLastfm && state.title) feedScrobbler(state)
    if (wantDiscord) feedDiscord(state)
    if (wantNotify && state.title) {
      const key = state.title + '|' + state.artist
      // baseline on the first observed track so launch doesn't fire a notification
      if (notifyKey === null) notifyKey = key
      else if (key !== notifyKey && state.isPlaying) { notifyKey = key; notifyTrack(state) }
      else if (key !== notifyKey) notifyKey = key
    }
  }, 5000)
}

function feedScrobbler(state) {
  const key = state.title + ' ' + state.artist
  if (!scrobbleState || scrobbleState.key !== key) {
    scrobbleState = {
      key,
      track: { title: state.title, artist: state.artist, album: state.album, duration: state.duration },
      startedAt: Math.floor(Date.now() / 1000),
      playedSeconds: 0,
      scrobbled: false
    }
    lastfm.updateNowPlaying(scrobbleState.track)
      .catch((e) => console.error('last.fm now playing failed:', e.message)) // error: LOGGED-OK — "now playing" is cosmetic; the scrobble is sent separately
  }
  if (state.isPlaying) scrobbleState.playedSeconds += 5

  // last.fm rules: track longer than 30s, played for half its length or 4 minutes
  const needed = Math.min(scrobbleState.track.duration / 2, 240)
  if (!scrobbleState.scrobbled && scrobbleState.track.duration > 30 && scrobbleState.playedSeconds >= needed) {
    // queued once per play (scrobbled), sent now; a failed send stays queued and is retried with a
    // backoff, across restarts (lastfm.js createScrobbleQueue: its error verdict is LOGGED-OK)
    scrobbleState.scrobbled = true
    scrobbleQueue.add(scrobbleState.track, scrobbleState.startedAt)
    scrobbleQueue.tick()
  }
}

// lifetime: while Discord is unreachable this makes one DiscordPresence every 6th tick (30 s); a
// failed connect leaves no socket open (each probe socket errors and is destroyed), so nothing stacks.
// Theoretical case, left as is: if Discord accepts the socket but never answers the handshake,
// connect() never settles and the next attempt 30 s later opens another socket without closing it.
// Not seen in practice; the old object would need an explicit close() to make it impossible.
async function feedDiscord(state) {
  // reconnect roughly every 30s while Discord is unreachable
  if (!discord || !discord.ready) {
    if (discordReconnectTicks++ % 6 !== 0) return
    discord = new DiscordPresence(discordConfig.applicationId)
    try {
      await discord.connect()
      lastPresenceKey = ''
    } catch (e) { // error: NOT-WORTH — Discord not running: tried again in 30 s; the rail shows "waiting"
      discord = null
      return
    }
  }

  if (!state.title || !state.isPlaying) {
    if (lastPresenceKey !== 'idle') {
      lastPresenceKey = 'idle'
      discord.clearActivity()
    }
    return
  }

  const endsAt = Date.now() + Math.max(0, state.duration - state.playbackTime) * 1000
  // re-send when the track changes or the position jumps (seek), not every tick
  const key = state.title + '|' + state.artist + '|' + Math.round(endsAt / 5000)
  if (key === lastPresenceKey) return
  lastPresenceKey = key

  const activity = {
    type: 2, // "Listening to"
    details: state.title,
    state: state.artist || undefined,
    assets: {
      large_image: state.artworkLarge || undefined,
      large_text: state.album || undefined
    }
  }
  if (state.duration) {
    activity.timestamps = {
      start: Date.now() - Math.round(state.playbackTime * 1000),
      end: Math.round(endsAt)
    }
  }
  discord.setActivity(activity)
}

function loadDiscordConfig() {
  try {
    discordConfig = { applicationId: '', enabled: false, ...JSON.parse(fs.readFileSync(discordConfigPath, 'utf8')) }
  } catch (e) { /* error: NOT-WORTH — no discord.json yet (or unreadable): defaults; Connect writes a new one */ }
}

function saveDiscordConfig() {
  fs.writeFileSync(discordConfigPath, JSON.stringify(discordConfig, null, 2) + '\n')
}

// --- Last.fm and Discord: set up and connected from Settings → Integrations (or the tray, which opens
// it). Each step is a notice in that section, with the actions it needs; no pop-up dialogs. ---
const INTEGRATIONS = { page: 'settings', section: 'integrations' }
async function connectDiscord() {
  showPanel('settings', 'integrations')
  loadDiscordConfig()
  notices.clear('discord')
  if (!discordConfig.applicationId) {
    saveDiscordConfig()
    notices.show({
      id: 'discord', place: INTEGRATIONS,
      text: 'Discord presence needs a (free) Discord application ID.',
      detail: '1. Create an application named "Sonata" in Discord\'s developer portal. 2. Paste its Application ID into ' + discordConfigPath + '. 3. Press Connect again.',
      actions: [{ id: 'discord-open-config', label: 'Open config file' }, { id: 'discord-open-portal', label: 'Open developer portal' }]
    })
    return
  }
  // lifetime: user-initiated only (Settings / tray); see feedDiscord for the reconnect path
  discord = new DiscordPresence(discordConfig.applicationId)
  try {
    await discord.connect()
    discordConfig.enabled = true
    saveDiscordConfig()
    lastPresenceKey = ''
    refreshTrayMenu()
    toast('Discord connected: it shows what you play')
  } catch (e) {
    // error: SHOWN — an error notice in Integrations with the reason
    discord = null
    notices.show({ id: 'discord', place: INTEGRATIONS, kind: 'error', text: 'Discord didn\'t connect: ' + e.message, detail: 'Make sure the Discord desktop app is running and the application ID in ' + discordConfigPath + ' is correct.' })
  }
}

function disconnectDiscord() {
  if (discord) {
    discord.clearActivity()
    discord.close()
    discord = null
  }
  discordConfig.enabled = false
  saveDiscordConfig()
  notices.clear('discord')
  refreshTrayMenu()
}

async function connectLastFm() {
  showPanel('settings', 'integrations')
  notices.clear('lastfm')
  if (!lastfm.configured) {
    lastfm.writeTemplate()
    notices.show({
      id: 'lastfm', place: INTEGRATIONS,
      text: 'Last.fm needs your own (free) API key and shared secret.',
      detail: '1. Create an API account on last.fm. 2. Paste the API key and shared secret into ' + lastfm.configPath + '. 3. Press Connect again.',
      actions: [{ id: 'lastfm-open-config', label: 'Open config file' }, { id: 'lastfm-get-account', label: 'Get an API account' }]
    })
    return
  }
  try {
    const url = await lastfm.startAuth()
    openExternalSafe(url)
    notices.show({
      id: 'lastfm', place: INTEGRATIONS,
      text: 'Allow Sonata in the browser window that just opened, then press Done.',
      actions: [{ id: 'lastfm-cancel', label: 'Cancel' }, { id: 'lastfm-done', label: 'Done', primary: true }]
    })
  } catch (e) {
    // error: SHOWN — an error notice in Integrations with the reason
    notices.show({ id: 'lastfm', place: INTEGRATIONS, kind: 'error', text: 'Last.fm didn\'t connect: ' + e.message, detail: 'Check the API key and secret in ' + lastfm.configPath })
  }
}
async function finishLastFm() {
  notices.clear('lastfm')
  try {
    await lastfm.finishAuth()
    refreshTrayMenu()
    toast('Last.fm connected: scrobbling as ' + lastfm.username)
  } catch (e) {
    // error: SHOWN — an error notice in Integrations with the reason
    notices.show({ id: 'lastfm', place: INTEGRATIONS, kind: 'error', text: 'Last.fm didn\'t connect: ' + e.message, detail: 'Check the API key and secret in ' + lastfm.configPath })
  }
}
function disconnectLastFm() {
  if (lastfm) lastfm.disconnect()
  notices.clear('lastfm')
  refreshTrayMenu()
}

// --- notices and toasts (notices-model.js): the side panel draws the notices, the toast view the toasts ---
// lifetime: one model for the app's life; its notices are bounded (one per id, ≤ ~8 ids) and its toasts (≤ 3)
const notices = noticesModel.createNotices({
  dismissed: [],
  saveDismissed: (keys) => { settings.dismissedNotices = keys; saveSettings() },
  windowShown: () => mainAlive() && mainWindow.isVisible(),
  onChange: () => { pushPanel(); pushRail(); syncToasts() }
})
function toast(text, opts) { notices.toast(text, opts) }
// a repaired settings or lyrics cache file: one notice, a dot on Settings until it's dismissed
function showRecovered(what, text, aside) {
  notices.show({
    id: 'recovered-' + what, kind: 'info', task: true, page: 'settings',
    dismissKey: 'recovered-' + what + ':' + (aside || Date.now()),
    text, actions: aside ? [{ id: 'recovered-show-' + what, label: 'Show the copy' }] : []
  })
  recoveredAside[what] = aside
}
const recoveredAside = {}

// What each notice's buttons do (the notice ids and action ids main itself put there)
// error: NOT-WORTH — an action for a notice that isn't shown any more, or not one of these, is dropped
function noticeAction(id, action) {
  const n = notices.get(id)
  if (!n || !n.actions.some((a) => a.id === action && !a.disabled)) return
  switch (action) {
    case 'discord-open-config': shell.openPath(discordConfigPath); break
    case 'discord-open-portal': openExternalSafe('https://discord.com/developers/applications'); break
    case 'lastfm-open-config': shell.openPath(lastfm.configPath); break
    case 'lastfm-get-account': openExternalSafe('https://www.last.fm/api/account/create'); break
    case 'lastfm-done': finishLastFm(); break
    case 'lastfm-cancel': notices.clear('lastfm'); break
    case 'update-details': showPanel('settings', 'updates'); break
    case 'update-install': installUpdate(); break
    case 'update-restart': if (!lastPlaying) restartIntoUpdate(); break
    case 'whatsnew-see': showPanel('about', 'whatsnew'); break
    case 'ask-auto-yes': setSetting('autoInstallUpdates', true); break
    case 'ask-auto-no': setSetting('autoInstallUpdates', false); break
    case 'recovered-show-settings': if (recoveredAside.settings) shell.showItemInFolder(recoveredAside.settings); break
    case 'recovered-show-lyrics': if (recoveredAside.lyrics) shell.showItemInFolder(recoveredAside.lyrics); break
    case 'gfx-show': notices.clear(id); showPanel('settings', 'experimental'); break
  }
}

// --- settings: what the panel may change, each checked (settings-store.js), and what a change does ---
const PANEL_SETTABLE = ['notifications', 'closeToTray', 'launchAtLogin', 'startMinimized', 'miniAlwaysOnTop', 'lyricsAlwaysOnTop', 'adaptiveColor', 'glass',
  'lrclibFallback', 'lyricsArtSpin', 'lyricsArtSpinSpeed', 'estimatedWordTiming', 'lyricsListenRefine', 'lyricsPreciseTiming', 'alignGamingPause', 'sungNotesLog', 'sheetNotes', 'sheetPlace', 'updateChannel', 'checkForUpdates', 'autoInstallUpdates', 'globalShortcuts',
  ...require('./gfx-model').EXPERIMENTS.map((e) => e.key)]   // Settings → Experimental (a restart switch applies at the next start)
function setSetting(key, value) {
  // the setlist.fm key: the panel may set or clear it, never read it back (the panel only learns whether one is saved)
  if (key === 'setlistfmKey') {
    const v = typeof value === 'string' ? value.trim() : value
    if (!settingsStore.validSetting(key, v) || settings[key] === v) return
    settings[key] = v
    saveSettings()
    pushPanel()
    return
  }
  if (key === 'theme') {
    if (!['system', 'light', 'dark'].includes(value)) return
    setThemePref(value)
    pushPanel()
    return
  }
  if (!PANEL_SETTABLE.includes(key) || !settingsStore.validSetting(key, value)) return
  if (settings[key] === value) return
  settings[key] = value
  if (key === 'autoInstallUpdates') { settings.updatesAsked = true; notices.clear('ask-auto') }
  saveSettings()
  if (key === 'launchAtLogin' || key === 'startMinimized') applyAutostart()
  else if (key === 'adaptiveColor') {
    applyMiniBlur()
    if (value) { lastPaletteKey = null; if (lastPalette) broadcastPalette(lastPalette); useTestArtwork() }  // re-extract next poll (UI checks: the test artwork again; nothing without SONATA_TEST_ARTWORK)
    else { lastPalette = null; lastBackdrop = null; lastPaletteKey = null; broadcastPalette(null) }
  }
  else if (key === 'glass') { broadcastPalette(lastPalette); applyMiniBlur() }
  else if (key === 'updateChannel') {
    // a switch: the other channel's offer goes; checks again at once if checks are on (never a downgrade)
    if (updater) updater.reset()
    backConfirm = false
    if (settings.checkForUpdates) checkForUpdates(false)
  }
  else if (key === 'checkForUpdates') startUpdateChecks()
  else if (key === 'lyricsArtSpin' || key === 'lyricsArtSpinSpeed') {
    if (lyricsWindow && !lyricsWindow.isDestroyed()) lyricsWindow.webContents.send('lyrics-settings', { spin: !!settings.lyricsArtSpin, speed: settings.lyricsArtSpinSpeed })
    if (linerWindow && !linerWindow.isDestroyed() && linerReady) linerWindow.webContents.send('liner-opts', { spin: !!settings.lyricsArtSpin })
  }
  else if (key === 'estimatedWordTiming' || key === 'lyricsListenRefine') {
    lyricsKey = null  // re-send the current song's lyrics with the new setting
    if (!value && listenSession) listenSession.stop()
  }
  else if (key === 'lyricsPreciseTiming') {
    lyricsKey = null
    if (!value) {
      if (alignSession) alignSession.stop(false)   // drop any recording
      if (alignHelper) alignHelper.stop()           // and free the GPU now
      alignStatusText = ''
    } else askAlignStatus()
    showAlignRepair()
  }
  else if (key === 'globalShortcuts') { shortcutError = ''; applyShortcuts() }
  else if (key === 'expGlowDither') { if (applyCustomCss) applyCustomCss() }
  if (key === 'sungNotesLog' || key === 'sheetNotes' || key === 'lyricsPreciseTiming' || key === 'updateChannel') {
    // the only download: when the notes step becomes active (the developer log on the Development
    // channel, or Sheet notes in the Studio; Precise word timing on)
    if (notesActive()) getNotesSwitch().turnedOn()
    else if (key === 'sungNotesLog' || key === 'sheetNotes') notesStatusText = ''
    if (key === 'sheetNotes' || key === 'lyricsPreciseTiming') { lyricsKey = null; sendSheet() }   // the song again, with or without its notes
  }
  else if (key === 'sheetPlace') sendSheet()   // the band or over the sung line: the page moves the staff
  else if (key === 'alignGamingPause') {
    if (!value && gameGuard) gameGuard.reset()    // off: resume now
    sendAlignNote()
  }
  else if (key === 'lyricsAlwaysOnTop') {
    if (lyricsWindow && !lyricsWindow.isDestroyed()) {
      lyricsWindow.setAlwaysOnTop(value)
      applyLyricsKeepAbove(value)
    }
  }
  else if (key === 'miniAlwaysOnTop') {
    if (miniWindow && !miniWindow.isDestroyed()) {
      miniWindow.setAlwaysOnTop(value)
      applyMiniKeepAbove(value)
    }
  }
  pushRail()   // precise timing, the update channel and the pin show in the rail
  pushPanel()
}

// Settings → Precise timing's status line: spawns the helper (if needed) and pings it
// error: SHOWN — the helper's answer or its error, in that line
let alignStatusText = ''
let alignAsking = false
async function askAlignStatus() {
  if (alignAsking || !settings.lyricsPreciseTiming || !alignInstalled(true)) return
  alignAsking = true
  alignStatusText = 'Starting the helper…'
  pushPanel()
  try {
    const pong = await getAlignHelper().ping()
    console.log('align: helper ready (' + (pong.device || '?') + (pong.gpu ? ', ' + pong.gpu : '') + ', v' + (pong.version || '?') + ')')
    alignStatusText = pong.device === 'cuda' ? 'Ready on ' + (pong.gpu || 'the GPU') : 'Ready, CPU only (slow: about a minute per song)'
    if (notesSwitch) notesSwitch.learn(pong)
  } catch (e) { // error: SHOWN — "Helper not working: …" in Settings → Precise timing
    console.log('align: helper not answering: ' + e.message)
    alignStatusText = 'Helper not working: ' + e.message
  } finally { alignAsking = false }
  pushPanel()
}

// --- tray ---

function updateTrayTooltip(state) {
  const text = state.title
    ? state.title + ' — ' + state.artist + (state.isPlaying ? '' : ' (paused)')
    : appName
  if (text === trayTooltip) return
  trayTooltip = text
  tray.setToolTip(text)
}

// lifetime: builds a new Menu on user actions only (connect/disconnect); setContextMenu drops the
// previous Menu, which is then collected. The Tray itself is created once.
function refreshTrayMenu() {
  const lastfmItem = lastfm && lastfm.connected
    ? { label: `Disconnect Last.fm (${lastfm.username})`, click: disconnectLastFm }
    : { label: 'Connect Last.fm…', click: connectLastFm }
  const discordItem = discordConfig.enabled
    ? { label: 'Disconnect Discord', click: disconnectDiscord }
    : { label: 'Connect Discord…', click: connectDiscord }
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Show / Hide', click: toggleWindow },
    { label: 'Mini Player', click: toggleMiniPlayer },
    { label: 'Lyrics', accelerator: LYRICS_KEY, registerAccelerator: false, click: toggleLyricsWindow },
    { label: 'Visualizer', accelerator: VISUALIZER_KEY, registerAccelerator: false, click: toggleVisualizer },
    { type: 'separator' },
    { label: 'Play / Pause', click: () => playerCommand('playPause') },
    { label: 'Next', click: () => playerCommand('next') },
    { label: 'Previous', click: () => playerCommand('previous') },
    { type: 'separator' },
    { label: 'Toggle Dark Mode', click: toggleTheme },
    lastfmItem,
    discordItem,
    { type: 'separator' },
    { label: 'Check for Updates…', click: () => { showPanel('settings', 'updates'); checkForUpdates(true) } },
    { label: 'Settings…', click: () => showPanel('settings') },
    { label: 'About Sonata', click: () => showPanel('about') },
    { label: 'Quit', click: () => { stopDesktopScheme(); app.exit(0) } }
  ]))
  pushRail()   // Last.fm / Discord connected or not
}

function createTray() {
  const icon = nativeImage.createFromPath(path.join(__dirname, 'sonata.png'))
    .resize({ width: 22, height: 22 })
  // lifetime: NOT-WORTH — one tray and its click listener for the app's life
  tray = new Tray(icon)
  tray.setToolTip(appName)
  refreshTrayMenu()
  tray.on('click', toggleWindow)
}

const appUrl = 'https://music.apple.com/'

// Our CSS for Apple's page: the native-app upsell hidden.
const customCss = '.web-navigation__native-upsell {display: none !important;}'
// Apple's page's CSS: ours, plus the cover-glow dither while Settings → Experimental has it on (glow-dither.js;
// built once, ~6 KB with its noise tile)
let glowDitherCss = ''
function appleCss() {
  if (!settings.expGlowDither) return customCss
  if (!glowDitherCss) glowDitherCss = require('./glow-dither').css()
  return customCss + '\n' + glowDitherCss
}
let applyCustomCss = () => {}

// --- the main window: Apple's page, the side panel, the navigation rail (and toasts) ---
// mainWindow is a BaseWindow holding WebContentsViews side by side: Apple's page (appleView), the side
// panel (panelView, panel.html: Settings and About, only once first shown) and the rail (railView,
// rail.html, on top). Apple's view is the window minus the rail's room and the docked panel
// (panel-model.js windowLayout), so Apple's own layout, its vw units, fixed panels (lyrics, queue),
// sheets, menus and toasts end where Sonata's views begin. A narrow window gets the panel as a drawer
// over Apple's page instead. While the unpinned rail is open over the page (hover or keyboard focus),
// its view widens over Apple's ("wide") and narrows once it has slid shut. Toasts get a small view of
// their own over the bottom right of Apple's page, only while one shows. Every view is sandboxed
// with contextIsolation; only Sonata's own views load local code, Apple's page gets none of it.
let appleView = null
let railView = null
let panelView = null      // created on first show, kept (hidden: setVisible(false))
let toastView = null      // created for a toast, closed when the last one goes
function appleWC() { return appleView.webContents }
function railAlive() { return !!(railView && !railView.webContents.isDestroyed()) }
function panelAlive() { return !!(panelView && !panelView.webContents.isDestroyed()) }
function toastAlive() { return !!(toastView && !toastView.webContents.isDestroyed()) }
const SONATA_VIEW_PREFS = (preload) => ({ preload: path.join(__dirname, preload), contextIsolation: true, sandbox: true, nodeIntegration: false })

// --- navigation rail state (rail-model.js, rail-ui.js, rail.css, rail.html, preload-rail-view.js) ---
// Main owns its state (which windows are open, the pin and lock, connections, the album accent,
// whether its view is wide, the panel) and sends it only when it changes; the rail sends back
// command names, checked here.
let railMounted = false   // rail.html said 'mounted'
let railWide = false      // the rail view is widened over Apple's page (unpinned, open)
let railSent = ''         // the last state sent, as JSON
let railBoundsKey = ''    // the last bounds applied, as JSON
let focusCode = null      // apple-focus.js, injected per Apple page load (read once)
let panelMode = 'hidden'  // 'hidden' | 'docked' | 'drawer' (the last layout)
function railPrecise() {
  if (!settings.lyricsPreciseTiming) return 'off'
  if (!alignInstalled()) return alignHealth && alignHealth.state === 'update' ? 'update' : alignHealth && alignHealth.state !== 'missing' ? 'repair' : 'missing'
  if (alignPaused()) return 'paused'
  if (alignHealth && alignHealth.state === 'sandboxed') return 'repair'
  return alignHelper && alignHelper.running ? 'busy' : 'ready'
}
function contentSize() {
  const b = mainWindow.getContentBounds()
  return [b.width, b.height]
}
// the toast view's place: bottom right of Apple's view, as tall as its toasts
let toastHeight = 0
function toastBounds(apple) {
  const w = Math.min(360, Math.max(0, apple.width - 32))
  const h = Math.min(toastHeight || 48 * notices.toasts().length, Math.max(0, apple.height - 32))
  return { x: apple.x + apple.width - w - 16, y: apple.y + apple.height - h - 16, width: w, height: h }
}
// Sizes the views for the window, the pin, the rail's open state and the panel. Cheap when nothing
// changed (one bounds read and a string compare).
function layoutViews() {
  if (!mainAlive() || !railAlive()) return
  const [w, h] = contentSize()
  const b = panelModel.windowLayout(w, h, { pinned: !!settings.railPinned, wide: railWide && !settings.railLocked, panelShown: !!settings.panelShown && panelAlive() })
  const t = toastAlive() ? toastBounds(b.apple) : null
  const key = JSON.stringify([b, t])
  if (key === railBoundsKey) return
  railBoundsKey = key
  panelMode = b.panelMode
  appleView.setBounds(b.apple)
  railView.setBounds(b.rail)
  if (panelAlive()) {
    panelView.setVisible(!!b.panel)
    if (b.panel) panelView.setBounds(b.panel)
  }
  if (t) toastView.setBounds(t)
}
function themeState() {
  const on = !!settings.adaptiveColor && !!lastPalette
  return {
    palette: on ? { accent: lastPalette.accent, accent2: lastPalette.accent2 } : null,
    glass: glassOn(),
    blurBehind: miniBlurAvailable(),
    backdrop: on && settings.glass && lastBackdrop ? lastBackdrop : null
  }
}
function railSnapshot() {
  const layout = railModel.railLayout(contentSize()[0], !!settings.railPinned)
  return {
    pinned: !!settings.railPinned,
    locked: !!settings.railLocked,
    mode: layout.mode,
    room: layout.room,
    wide: railWide && layout.mode !== 'pinned' && !settings.railLocked,
    open: { lyrics: !!lyricsWindow, stage: !!lyricsWindow && !!settings.lyricsStage, visualizer: !!vizWindow, mini: !!miniWindow },
    panel: { shown: !!settings.panelShown, page: settings.panelPage },
    reminders: notices.reminders().pages,
    keys: { lyrics: LYRICS_KEY, stage: STAGE_KEY, visualizer: VISUALIZER_KEY, mini: MINI_KEY, settings: '', about: '' },
    lastfm: { connected: !!(lastfm && lastfm.connected), user: lastfm && lastfm.connected ? (lastfm.username || '') : '' },
    discord: discordConfig.enabled ? (discord && discord.ready ? 'on' : 'waiting') : 'off',
    precise: railPrecise(),
    channel: settings.updateChannel,
    version: updateFeed.shownVersion(app.getVersion()),
    theme: themeState()
  }
}
// Lays the views out and sends the rail's state if it changed. Called on every event that can change
// it (windows, settings, connections, palette, resize, the 5 s now-playing tick); unchanged state
// costs one small JSON.stringify and sends nothing.
function pushRail() {
  if (!mainAlive() || !railAlive()) return
  if (settings.railPinned || settings.railLocked) railWide = false
  layoutViews()
  if (!railMounted) return
  const s = railSnapshot()
  const json = JSON.stringify(s)
  if (json === railSent) return
  railSent = json
  railView.webContents.send('rail:state', s)
}
// Pin (Ctrl+B) and lock exclude each other, as in the DS5 app (rail-model.js toggleFlags)
function toggleRailFlag(which) {
  const f = railModel.toggleFlags({ pinned: settings.railPinned, locked: settings.railLocked }, which)
  settings.railPinned = f.pinned
  settings.railLocked = f.locked
  saveSettings()
  pushRail()
}
function toggleRailPin() { toggleRailFlag('pin') }

// --- the side panel (panel-model.js, panel-ui.js, panel.css, panel.html, preload-panel.js) ---
// Settings and About, shown and hidden from the rail (its item pressed again hides it), the tray and
// menus. Main owns its state: shown, the page, each page's open section and pins (settings.json),
// the notices, and sends it only when it changes.
let panelMounted = false
let panelSent = ''
let reveal = null         // the last deep link: { page, section, n, focus }
let revealCount = 0
let aboutCache = null     // About's texts (CHANGELOG.md, BACKLOG.md), read when About first shows
let backConfirm = false   // Back to stable: the confirm step is showing
function createPanelView() {
  if (panelAlive() || !mainAlive()) return
  // lifetime: OK — created once on first show, kept (hidden), closed with the window
  panelView = new WebContentsView({ webPreferences: SONATA_VIEW_PREFS('preload-panel.js') })
  panelView.setBackgroundColor('#00000000')
  // between Apple's page and the rail: the rail, opening over the page, stays on top
  mainWindow.contentView.addChildView(panelView, mainWindow.contentView.children.indexOf(railView))
  panelView.webContents.loadFile('panel.html')
  lockDownLocalWindow(panelView)
  // lifetime: OK — one listener each on the panel's web contents, created once, die with it
  panelView.webContents.on('before-input-event', (event, input) => { if (!shortcutCapture) windowShortcut(input) })
  panelView.webContents.on('focus', () => { focusedView = 'panel' })
  panelView.webContents.on('did-start-loading', () => { panelMounted = false; panelSent = '' })
}
// the open section and pins of a page (first visit: the first section with an open task opens)
function accOf(page) {
  const stored = { open: (settings.panelOpen || {})[page], pins: (settings.panelPins || {})[page] }
  if (stored.open === undefined) {
    const rem = notices.reminders().sections
    stored.open = panelModel.sectionIds(page).find((id) => rem[page + '/' + id]) || null
  }
  return panelModel.accState(stored, page)
}
function saveAcc(page, st) {
  settings.panelOpen = Object.assign({}, settings.panelOpen, { [page]: st.open })
  settings.panelPins = Object.assign({}, settings.panelPins, { [page]: st.pins })
  saveSettings()
}
function accAction(page, type, id) {
  const before = accOf(page)
  const after = panelModel.accReduce(before, { type, id })
  if (JSON.stringify(after) === JSON.stringify(before)) return
  saveAcc(page, after)
  if (page === 'settings' && panelModel.isOpen(after, 'timing') && !panelModel.isOpen(before, 'timing')) askAlignStatus()
  seenWhatsNew()
  pushPanel()
}
// show the panel (with a page, and a section opened and scrolled to); the main window comes forward
function showPanel(page, section, opts) {
  if (!mainAlive()) return
  const o = opts || {}
  if (page && panelModel.PAGE_IDS.includes(page)) settings.panelPage = page
  settings.panelShown = true
  if (section) {
    saveAcc(settings.panelPage, panelModel.accReduce(accOf(settings.panelPage), { type: 'reveal', id: section }))
    reveal = { page: settings.panelPage, section, n: ++revealCount, focus: !!o.focus }
  }
  saveSettings()
  createPanelView()
  if (!mainWindow.isVisible()) mainWindow.show()
  if (mainWindow.isMinimized()) mainWindow.restore()
  if (settings.panelPage === 'settings' && panelModel.isOpen(accOf('settings'), 'timing')) askAlignStatus()
  seenWhatsNew()
  pushRail()
  pushPanel()
}
function hidePanel() {
  if (!settings.panelShown) return
  const hadFocus = focusedView === 'panel'
  if (shortcutCapture) captureShortcut(false)   // a key wait never outlives the panel
  settings.panelShown = false
  saveSettings()
  pushRail()
  pushPanel()
  // the keyboard was in the panel: it goes to the rail (where the panel came from)
  if (hadFocus) focusRail()
}
// a rail item for a panel page: the page shown -> hide; otherwise show it with that page
function togglePanelPage(page) {
  if (settings.panelShown && settings.panelPage === page && panelAlive()) hidePanel()
  else showPanel(page)
}
// About read on demand (CHANGELOG.md and BACKLOG.md ship in the app); kept for the run
// error: NOT-WORTH — a missing file reads as empty: About says so ("nothing listed")
function aboutData() {
  if (!aboutCache) {
    const read = (f) => { try { return fs.readFileSync(path.join(__dirname, f), 'utf8') } catch (e) { return '' } }
    aboutCache = aboutDataLib.aboutData(read('CHANGELOG.md'), read('BACKLOG.md'), app.getVersion(), alignInstalled())
  }
  return aboutCache
}
function panelSnapshot() {
  const u = updater ? updater.state() : { phase: 'idle' }
  const v = {}
  for (const k of PANEL_SETTABLE) v[k] = settings[k] // loop: HOT-PATH-OK — 20 keys per panel snapshot
  Object.assign(v, {
    theme: themePref,
    version: app.getVersion(),
    appImage: !!appImagePath,
    alignInstalled: alignInstalled(),
    alignState: alignHealth ? alignHealth.state : 'missing',
    alignEngine: alignEngineVersion(),
    alignHome: alignPaths ? alignPaths.home : '',
    alignStatus: alignStatusText,
    notesStatus: notesStatusText,
    notesModel: !!(notesSwitch && notesSwitch.model),
    notesModelSize: notesLogLib.sizeText(notesLogLib.RMVPE.bytes),
    lastfmConnected: !!(lastfm && lastfm.connected),
    lastfmUser: lastfm && lastfm.connected ? (lastfm.username || '') : '',
    discordEnabled: !!discordConfig.enabled,
    setlistfmKeySet: !!settings.setlistfmKey,
    discordState: discordConfig.enabled ? (discord && discord.ready ? 'on' : 'waiting') : 'off',
    updateLine: updaterLib.statusLine(u, app.getVersion(), settings.updateChannel),
    updateBusy: ['checking', 'downloading', 'installing'].includes(u.phase),
    updateNotes: u.phase === 'available' ? (u.notes || '') : '',
    backToStable: settings.updateChannel === 'dev' || updateFeed.isDevVersion(app.getVersion()),
    backConfirm,
    shortcuts: shortcuts ? Object.assign(shortcuts.snapshot(), { error: shortcutError, capture: shortcutCapture }) : null,
    gfx: gfx.snapshot(app.getGPUFeatureStatus()),
    curious: curious ? curious.state() : null
  })
  const shownAbout = settings.panelShown && settings.panelPage === 'about'
  return {
    page: settings.panelPage,
    shown: !!settings.panelShown,
    mode: panelMode,
    acc: { settings: accOf('settings'), about: accOf('about') },
    v,
    notices: notices.visible(),
    reminders: notices.reminders(),
    // the hero card's version and channel are live (the channel can change while About is cached)
    about: shownAbout || aboutCache ? Object.assign({ hero: aboutDataLib.hero(app.getVersion(), settings.updateChannel, !!appImagePath) }, aboutData()) : null,
    theme: themeState(),
    reveal
  }
}
// Settings → Experimental in 'ready' (gfx-runtime.js): a switch the start marker or a graphics crash turned
// off is saved off and said once, at the top of the panel, with a way to the section
function startGfx() {
  gfx.ready({
    settings: () => settings,
    turnOff: (key) => { if (settings[key] === true) { settings[key] = false; saveSettings() } },
    notify: (id, text) => notices.show({ id, kind: 'info', task: true, page: 'settings', text, actions: [{ id: 'gfx-show', label: 'Open Experimental' }] }),
    changed: () => pushPanel(),
    screensChanged: () => { sendHdr(lyricsWindow); sendHdr(vizWindow) }
  })
  watchScreens()
}
// About → Graphics' "Video decoding" line, read when the section opens: Apple's page asks MediaCapabilities
// about Apple's top artwork stream, and the graphics process's /proc maps say which VA-API driver it loaded
function decodeProbe() {
  let last = null
  return {
    readout: () => require('./gfx-model').decodeLabel(last),
    probe(done) {
      if (!appleView || appleWC().isDestroyed()) return
      const gpu = app.getAppMetrics().find((m) => m.type === 'GPU')
      let drivers = []
      try { drivers = [...new Set(fs.readFileSync('/proc/' + gpu.pid + '/maps', 'utf8').match(/[\w-]+_drv_video\.so/g) || [])] } catch (e) { drivers = [] }   // error: NOT-WORTH — no graphics process or no /proc: the line says software or hardware from the page alone
      const ask = `(async () => { const q = (c) => navigator.mediaCapabilities.decodingInfo({ type: 'media-source', video: { contentType: 'video/mp4; codecs="' + c + '"', width: 1080, height: 1080, bitrate: 4e6, framerate: 30 } }); const a = await q('avc1.640020'); return { powerEfficient: !!a.powerEfficient, hevc: MediaSource.isTypeSupported('video/mp4; codecs="hvc1.2.20000000.L123.B0"') } })()`
      appleWC().executeJavaScript(ask).then((r) => { last = Object.assign({ drivers }, r); done() })
        .catch((e) => console.error('graphics readout: decoding check failed:', e.message))   // error: LOGGED-OK — the line keeps saying "checking…"; reopening About → Graphics asks again
    }
  }
}
// HDR output (Settings → Experimental, active this start): each lyric window is told whether it sits on an
// HDR screen and with what headroom ('lyrics-hdr', hdr-glow.js), when it loads, after it moves (300 ms after
// the last move event) and when the screens change. Without HDR output nothing is registered.
function sendHdr(win) {
  if (win && !win.isDestroyed()) win.webContents.send('lyrics-hdr', gfx.hdrFor(win.getBounds()))
}
function trackHdr(win) {
  if (!gfx.hdrActive) return
  let timer = null
  // lifetime: OK — the load, move and closed listeners die with the window; the one-shot timer is cleared on close
  win.webContents.on('did-finish-load', () => sendHdr(win))
  win.on('move', () => { clearTimeout(timer); timer = setTimeout(() => sendHdr(win), 300) })
  win.on('closed', () => clearTimeout(timer))
}
// the desktop's screens changed: read KDE's outputs again (250 ms after the last event), then tell the windows
let screensTimer = null
function watchScreens() {
  if (!gfx.hdrActive) return
  // lifetime: OK — one 250 ms one-shot, replaced by the next screen event (a debounce)
  const later = () => { clearTimeout(screensTimer); screensTimer = setTimeout(() => gfx.screensChanged(), 250) }
  // lifetime: NOT-WORTH — three screen listeners for the app's life, only with HDR output on
  for (const ev of ['display-added', 'display-removed', 'display-metrics-changed']) screen.on(ev, later)   // loop: NOT-WORTH — three event names, once
}
// an About section is on screen: open, the panel shown on About, the main window shown and not minimised.
// About → Graphics and For the Curious read the CPU sampler only then.
function aboutShowing(id) {
  return !!(mainAlive() && panelAlive() && panelMounted && mainWindow.isVisible() && !mainWindow.isMinimized() &&
    settings.panelShown && settings.panelPage === 'about' && panelModel.isOpen(accOf('about'), id))
}
// both: on every state push and when the main window is shown, hidden, minimised or restored
function aboutSync() { gfxReadout(); curiousSync() }
// About → Graphics: a CPU reading every 5 s (cpu-sampler.js) while it shows
function gfxReadout() {
  gfx.readout(aboutShowing('graphics'), (pid, type) => {
    const page = appleView && !appleWC().isDestroyed() ? appleWC().getOSProcessId() : 0
    return type === 'GPU' ? 'gpu' : pid === page ? 'page' : 'other'
  })
}
// About → For the Curious (curious-sampler.js): samples only while the section is open and the main window
// shown; every change of those (a state push, the window shown, hidden, minimised or restored) asks again
// lifetime: OK — one sampler for the app's life, created on the section's first open; its one-shot refresh
// timer runs only while open (curious-sampler.js)
let curious = null
const curiousOpen = () => aboutShowing('curious')
function curiousSync() {
  const open = curiousOpen()
  if (!curious && !open) return
  if (!curious) curious = curiousSamplerLib.createCuriousSampler(curiousDeps())
  curious.sync(open)
}
function curiousViews() {
  const out = []
  const add = (name, wc, shown) => { if (wc && !wc.isDestroyed()) out.push({ name, wc, pid: wc.getOSProcessId(), shown: !!shown }) }
  const winShown = (w) => !!(w && !w.isDestroyed() && w.isVisible() && !w.isMinimized())
  if (appleView) add('Apple\'s page', appleWC(), true)
  if (railAlive()) add('Rail', railView.webContents, true)
  if (panelAlive()) add('This panel', panelView.webContents, settings.panelShown)
  if (toastAlive()) add('Toasts', toastView.webContents, true)
  if (lyricsWindow && !lyricsWindow.isDestroyed()) add(settings.lyricsStage ? 'Studio' : 'Lyrics window', lyricsWindow.webContents, winShown(lyricsWindow))
  if (miniWindow && !miniWindow.isDestroyed()) add('Mini player', miniWindow.webContents, winShown(miniWindow))
  if (vizWindow && !vizWindow.isDestroyed()) add('Visualizer', vizWindow.webContents, winShown(vizWindow))
  if (linerWindow && !linerWindow.isDestroyed()) add('Liner notes', linerWindow.webContents, winShown(linerWindow))
  if (coverWindow && !coverWindow.isDestroyed()) add('Cover', coverWindow.webContents, winShown(coverWindow))
  return out
}
function curiousFiles() {
  const ud = app.getPath('userData')
  // error: NOT-WORTH — a file or folder not there yet: null / 0 ("No file yet")
  const size = (f) => { try { return fs.statSync(path.join(ud, f)).size } catch (e) { return null } }
  const dir = (d) => {
    let files = 0; let bytes = 0
    // loop: NOT-WORTH — ≤ 1,000 files (the notes log's cap; the montage folder ≤ 300), once a minute while For the Curious is open
    // error: NOT-WORTH — no folder or a file removed meanwhile: counted as nothing
    try { for (const n of fs.readdirSync(d)) { try { bytes += fs.statSync(path.join(d, n)).size; files++ } catch (e) {} } } catch (e) { return null }
    return { files, bytes }
  }
  const notes = curiousNotesDir()
  return { lyricsFile: size('lyrics-cache.json'), linerFile: size('liner-notes-cache.json'), montageFile: size('montage-cache.json'), montageDir: dir(path.join(ud, 'montage')), notesDir: notes ? dir(notes) : null }
}
function curiousNotesDir() {
  const d = notesLogLib.logDir(process.env, alignHelperLib.inAppSandbox)
  return fs.existsSync(d) ? d : null
}
function curiousDeps() {
  const { execFile } = require('child_process')
  const { pickSinkInput, ownProcessTree } = require('./audio-listen')
  return {
    cpu: cpuSampler,
    views: curiousViews,
    nowPlaying: () => appleWC().executeJavaScript(nowPlayingScript),
    store: { peek: (k) => (lyricsStore ? lyricsStore.peek(k) : null), entries: () => (lyricsStore ? lyricsStore.entries() : []) },
    track: () => curiousTrack,
    settings: () => ({ estimate: !!settings.estimatedWordTiming, precise: preciseTimingOn(), listen: !!settings.lyricsListenRefine && !!settings.estimatedWordTiming, installed: alignInstalled(), dev: settings.updateChannel === 'dev' }),
    files: curiousFiles,
    notesDir: curiousNotesDir,
    notesSuffix: (artist, title) => notesLogLib.fileName(new Date(), artist, title).slice(8),
    helper: () => ({ installed: alignInstalled(), running: !!(alignHelper && alignHelper.running), pid: alignHelper ? alignHelper.pid : 0, paused: alignPaused() }),
    ownSinkInput: (list) => pickSinkInput(list, ownProcessTree(process.pid)),
    execFile,
    platform: process.platform,
    versions: () => [
      ['Sonata', app.getVersion() + (appImagePath ? '' : ' (from source)')],
      ['Electron', process.versions.electron + ' (castlabs, with Widevine)'],
      ['Chromium', process.versions.chrome],
      ['Node', process.versions.node],
      ['sonata-align', alignEngineVersion() ? 'engine ' + alignEngineVersion() + (alignInstalled() ? ' (installed separately)' : ' (wanted by this Sonata; not installed)') : 'Not yet known'],
      ['System', process.platform + ' ' + require('os').release() + (process.platform === 'linux' ? ', ' + (process.env.XDG_SESSION_TYPE || 'session type not set') : '')]
    ],
    push: pushPanel,
    isOpen: curiousOpen,
    now: () => performance.now(),
    date: () => new Date(),
    log: (m) => console.error(m)
  }
}
// "Copy for a bug report": the numbers shown now as plain text (no lyrics, no song names, no paths)
function curiousCopy() {
  const text = curious ? curious.report() : ''
  if (!text) return
  // error: SHOWN — the line under the button says whether it was copied (Electron 44+: writeText may return a Promise)
  Promise.resolve().then(() => clipboard.writeText(text))
    .then(() => curious.copiedNote('Copied: ' + text.split('\n').length + ' lines of plain text, no lyrics, song names or personal data.'),
      (e) => { console.error('for the curious: copy failed:', e.message); curious.copiedNote('Could not copy: ' + e.message) })
}
// sends the panel's state if it changed; one JSON compare otherwise
function pushPanel() {
  if (!panelAlive() || !panelMounted) return
  aboutSync()
  const s = panelSnapshot()
  const json = JSON.stringify(s)
  if (json === panelSent) return
  panelSent = json
  panelView.webContents.send('panel:state', s)
}

// --- toasts: their own small view, only while one shows ---
let toastMounted = false
let toastSent = ''
function syncToasts() {
  const list = notices.toasts()
  if (!list.length) {
    if (toastAlive()) {
      mainWindow.contentView.removeChildView(toastView)
      toastView.webContents.close()
    }
    toastView = null; toastMounted = false; toastSent = ''; toastHeight = 0
    return
  }
  if (!mainAlive()) return
  if (!toastAlive()) {
    // lifetime: OK — closed (removeChildView + close) when the last toast goes, at the top of syncToasts
    toastView = new WebContentsView({ webPreferences: SONATA_VIEW_PREFS('preload-panel.js') })
    toastView.setBackgroundColor('#00000000')
    mainWindow.contentView.addChildView(toastView)   // on top of everything
    toastView.webContents.loadFile('toast.html')
    lockDownLocalWindow(toastView)
    railBoundsKey = ''
  }
  layoutViews()
  if (!toastMounted) return
  const s = { toasts: list, theme: themeState() }
  const json = JSON.stringify(s)
  if (json === toastSent) return
  toastSent = json
  toastView.webContents.send('panel:state', s)
}

// --- keyboard focus between the views: Apple's page -> the panel (when shown) -> the rail -> Apple's ---
// Tab past either end of Apple's page (apple-focus.js stops), Tab out at either end of the panel or the
// rail, or F6, moves to the next view in that ring (Shift: the previous one).
let focusedView = 'apple'   // the view the keyboard is in: 'apple' | 'panel' | 'rail'
function focusRail() {
  if (!mainAlive() || !railAlive()) return
  railView.webContents.focus()
  railView.webContents.send('rail:take-focus')
}
function focusPanel(where) {
  if (!mainAlive() || !panelAlive() || !settings.panelShown) return false
  panelView.webContents.focus()
  panelView.webContents.send('panel:take-focus', where)
  return true
}
// error: LOGGED-OK — a failing injection (page mid-navigation) only leaves the focus in the window; logged
function focusApple(where) {
  if (!mainAlive()) return
  const code = 'globalThis.__sonataFocus ? globalThis.__sonataFocus.focusApple(' + JSON.stringify(where) + ') : false'
  // the target is focused first (inside Apple's page), then the view: the page never lands back on a stop
  appleWC().executeJavaScriptInIsolatedWorld(999, [{ code }])
    .catch((e) => console.error('rail: focus handoff failed:', e.message))
    .finally(() => { if (mainAlive()) appleWC().focus() })
}
// move from view `from` forward or back (panel-model.js focusNext); `entry`: where in the target
function focusView(from, back, entry) {
  const to = panelModel.focusNext(from, back, !!settings.panelShown && panelAlive())
  if (to === 'rail') focusRail()
  else if (to === 'panel') focusPanel(back ? 'last' : 'first')
  else focusApple(entry || (back ? 'prev' : 'next'))
}
function toggleViewFocus() {
  focusView(focusedView, false, focusedView === 'rail' ? 'restore' : undefined)
}
function injectFocusStops() {
  if (!mainAlive()) return
  // the wheel-volume maths first (a plain script there: SonataWheelVolume), then the focus stops
  if (!focusCode) focusCode = fs.readFileSync(path.join(__dirname, 'wheel-volume.js'), 'utf8') + '\n' + fs.readFileSync(path.join(__dirname, 'apple-focus.js'), 'utf8')
  appleWC().executeJavaScriptInIsolatedWorld(999, [{ code: focusCode }])
    .catch((e) => console.error('rail: focus stops failed:', e.message))   // error: LOGGED-OK — page mid-load: no focus stops until the next load (Tab still works in the page)
}
// The song's length and position for the desktop's media controls (media-position.js): declared from
// MusicKit in Apple's page (main world), once per page load; the page script keeps it current itself.
const mediaPositionCode = require('./media-position').pageScript()
function injectMediaPosition() {
  if (!mainAlive()) return
  appleWC().executeJavaScript(mediaPositionCode)
    .catch((e) => console.error('media controls: position script failed:', e.message))   // error: LOGGED-OK — page mid-load: no length in the media controls until the next load (playback is unaffected)
}

// lifetime: OK — registered once at module load (like every ipcMain handler here)
// error: NOT-WORTH — a command not from the rail view's top frame, or not one of the rail's names, is dropped
ipcMain.on('rail:command', (event, command) => {
  if (!mainAlive() || !railAlive() || event.sender !== railView.webContents) return
  if (!event.senderFrame || event.senderFrame.parent) return
  if (!railModel.COMMANDS.includes(command)) return
  if (command === 'mounted') { railMounted = true; railSent = ''; pushRail() }
  else if (command === 'expand') { if (!settings.railLocked && !settings.railPinned) { railWide = true; pushRail() } }
  else if (command === 'collapse') { railWide = false; pushRail() }
  else if (command === 'focus-apple-next') focusView('rail', false)
  else if (command === 'focus-apple-prev') focusView('rail', true)
  else if (command === 'lyrics') toggleLyricsWindow()
  else if (command === 'stage') toggleStage()
  else if (command === 'visualizer') toggleVisualizer()
  else if (command === 'mini') toggleMiniPlayer()
  else if (command === 'settings') togglePanelPage('settings')
  else if (command === 'about') togglePanelPage('about')
  else if (command === 'pin') toggleRailPin()
  else if (command === 'lock') toggleRailFlag('lock')
})
// lifetime: OK — registered once at module load
// error: NOT-WORTH — only from Apple's view, top frame; anything else is dropped. 'last' (Tab past Apple's end):
// the next view; 'first' (Shift+Tab before its start, or a fresh page's first Tab): the previous one
ipcMain.on('rail:focus-in', (event, where) => {
  if (!mainAlive() || event.sender !== appleWC()) return
  if (!event.senderFrame || event.senderFrame.parent) return
  focusView('apple', where !== 'last')
})

// The mouse wheel over Apple's own volume control (apple-focus.js): N notches, 5 % each, set through
// MusicKit like the mini player's volume.
// lifetime: OK — registered once at module load
// error: NOT-WORTH — only from Apple's view, top frame, a whole number -20..20; anything else is dropped; a failing
// script (page mid-navigation) is logged and the wheel does nothing that time
const wheelVolume = require('./wheel-volume')
ipcMain.on('apple:volume', (event, steps) => {
  if (!mainAlive() || event.sender !== appleWC() || !event.senderFrame || event.senderFrame.parent) return
  if (!Number.isInteger(steps) || steps === 0 || Math.abs(steps) > 20) return
  appleWC().executeJavaScript('(() => { const mk = MusicKit.getInstance(); return mk.volume; })()')
    .then((v) => {
      const next = wheelVolume.stepVolume(v, steps)
      return appleWC().executeJavaScript(`(() => { MusicKit.getInstance().volume = ${next}; })();`)
    })
    .catch((e) => console.error('wheel volume failed:', e.message)) // error: LOGGED-OK — page mid-load: the wheel does nothing that time
})

// The panel's and the toast view's commands, from their own top frames only, each argument checked.
// lifetime: OK — registered once at module load
// error: NOT-WORTH — anything else (another sender, a subframe, an unknown command or a bad argument) is dropped
const PANEL_ACTIONS = ['lastfm', 'discord', 'check-now', 'back-to-stable', 'back-cancel', 'shortcuts-configure', 'shortcuts-ask-again', 'shortcuts-reset', 'gfx-restart', 'curious-copy']
ipcMain.on('panel:command', (event, command, a, b, c) => {
  if (!mainAlive() || !event.senderFrame || event.senderFrame.parent) return
  if (!panelModel.COMMANDS.includes(command)) return
  const fromToast = toastAlive() && event.sender === toastView.webContents
  const fromPanel = panelAlive() && event.sender === panelView.webContents
  if (fromToast) {
    if (command === 'mounted') { toastMounted = true; toastSent = ''; syncToasts() }
    else if (command === 'toast-done' && Number.isInteger(a)) notices.endToast(a)
    else if (command === 'toast-action' && Number.isInteger(a)) { const t = notices.toasts().find((x) => x.id === a); if (t && t.action) noticeAction('toast', t.action.id); notices.endToast(a) }
    else if (command === 'toast-size' && Number.isFinite(a) && a >= 0 && a < 1000) { toastHeight = Math.ceil(a); railBoundsKey = ''; layoutViews() }
    return
  }
  if (!fromPanel) return
  if (command === 'mounted') { panelMounted = true; panelSent = ''; if (shortcutCapture) captureShortcut(false); pushPanel() }
  else if (command === 'set' && typeof a === 'string') setSetting(a, b)
  else if (command === 'action' && PANEL_ACTIONS.includes(a)) panelAction(a)
  else if (command === 'notice-action' && typeof a === 'string' && typeof b === 'string') noticeAction(a, b)
  else if (command === 'notice-dismiss' && typeof a === 'string') { if (a === 'whatsnew') seenWhatsNew(true); notices.dismiss(a) }
  else if (command === 'acc' && panelModel.PAGE_IDS.includes(a) && ['toggle', 'pin', 'collapseAll', 'clearPins'].includes(b) &&
    (b === 'collapseAll' || b === 'clearPins' || panelModel.sectionIds(a).includes(c))) accAction(a, b, c)
  else if (command === 'hide') hidePanel()
  else if (command === 'focus-next') focusView('panel', false)
  else if (command === 'focus-prev') focusView('panel', true)
  else if (command === 'open-link' && typeof a === 'string' && /^https:\/\//.test(a)) openExternalSafe(a)
  else if (command === 'show-page' && panelModel.PAGE_IDS.includes(a)) showPanel(a)
  else if (command === 'shortcut-key' && shortcutsModel.IDS.includes(a) && (b === null || (typeof b === 'string' && b.length <= 40))) setShortcutKey(a, b)
  else if (command === 'shortcut-capture' && typeof a === 'boolean') captureShortcut(a)
})
function panelAction(name) {
  if (name === 'lastfm') { if (lastfm && lastfm.connected) disconnectLastFm(); else connectLastFm() }
  else if (name === 'discord') { if (discordConfig.enabled) disconnectDiscord(); else connectDiscord() }
  else if (name === 'check-now') checkForUpdates(true)
  else if (name === 'back-to-stable') {
    // the first press asks (the line says what happens), the second installs
    if (!backConfirm) { backConfirm = true; pushPanel(); return }
    backConfirm = false
    backToStable()
  }
  else if (name === 'back-cancel') { backConfirm = false; pushPanel() }
  else if (name === 'shortcuts-configure' && shortcuts) shortcuts.configure()
  else if (name === 'shortcuts-ask-again' && shortcuts) shortcuts.askAgain()
  else if (name === 'shortcuts-reset') { settings.shortcutKeys = {}; saveSettings(); shortcutError = ''; applyShortcuts() }
  else if (name === 'gfx-restart') restartApp()
  else if (name === 'curious-copy') curiousCopy()
}

// --- global shortcuts (shortcuts.js: X11 key grabs, or the desktop's portal on Wayland) ---
let shortcuts = null
let shortcutError = ''      // why the last key typed in Settings was refused
let shortcutCapture = false // Settings is waiting for a new key: Sonata's window keys and grabs step aside
const SHORTCUT_ACTS = {
  'play-pause': () => playerCommand('playPause'),
  next: () => playerCommand('next'),
  previous: () => playerCommand('previous'),
  lyrics: () => toggleLyricsWindow()
}
function startShortcuts() {
  shortcuts = shortcutsLib.createShortcuts({
    globalShortcut, platform: process.platform, env: process.env, appId,
    openConnection: () => dbusWire.Connection.open({ net: nodeNet, env: process.env }),
    act: (id) => SHORTCUT_ACTS[id](),
    onChange: () => pushPanel(),
    log: (m) => console.log(m),
    now: () => Date.now(),
    setTimeout, clearTimeout
  })
  // Wayland: ask once whether the desktop offers the portal, so Settings can say so before it's turned on
  if (shortcutsModel.chooseBackend({ platform: process.platform, env: process.env, portalVersion: null }).kind === 'unknown') shortcuts.probe()
  applyShortcuts()
}
function applyShortcuts() {
  if (shortcuts) shortcuts.apply(settings.globalShortcuts, settings.shortcutKeys)
}
function setShortcutKey(id, accel) {
  const r = shortcutsModel.setKey(settings.shortcutKeys, id, accel)
  captureShortcut(false)   // first: while grabs are suspended, Electron refuses new ones
  shortcutError = r.error
  if (!r.error) { settings.shortcutKeys = r.stored; saveSettings(); applyShortcuts() }
  pushPanel()
}
function captureShortcut(on) {
  shortcutCapture = !!on
  if (shortcuts) shortcuts.suspend(shortcutCapture)
  if (on) shortcutError = ''
  pushPanel()
}

// The keys both views share (Apple's page and the rail): reload, theme, mini player, pin, lyrics,
// visualizer, back/forward, F6 to move between the two views
function windowShortcut(input) {
  if (input.type === 'keyUp' && input.control && input.key.toLowerCase() === 'r') {
    appleWC().reload()
  }
  else if (input.type === 'keyUp' && input.control && input.key.toLowerCase() === 'd') {
    toggleTheme()
  }
  else if (input.type === 'keyUp' && input.control && input.key.toLowerCase() === 'm') {
    toggleMiniPlayer()
  }
  else if (input.type === 'keyUp' && input.control && !input.shift && !input.alt && input.key.toLowerCase() === 'b') {
    toggleRailPin()   // Ctrl+B (the rail's tooltip names it: rail-model.js pinItem)
  }
  else if (input.type === 'keyUp' && input.key === 'F6' && !input.control && !input.alt) {
    toggleViewFocus()
  }
  else if (viewShortcut(input)) return
  else if (input.type === 'keyUp' && input.alt && input.key === 'ArrowLeft') {
    if (appleWC().navigationHistory.canGoBack()) appleWC().navigationHistory.goBack()
  }
  else if (input.type === 'keyUp' && input.alt && input.key === 'ArrowRight') {
    if (appleWC().navigationHistory.canGoForward()) appleWC().navigationHistory.goForward()
  }
}

function createWindow() {
  Menu.setApplicationMenu(null)

  const b = settings.windowBounds
  const opts = {
    width: 1000, height: 600, minWidth: 800, minHeight: 500,
    show: !(settings.startMinimized || process.argv.includes('--hidden')),
    title: appName,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#1e1e1e' : '#ffffff'
  }
  if (b && b.width >= 800 && b.height >= 500) {
    Object.assign(opts, { width: b.width, height: b.height })
    if (Number.isInteger(b.x) && Number.isInteger(b.y)) { opts.x = b.x; opts.y = b.y }
  }
  // lifetime: NOT-WORTH — the one main window, for the app's life (close quits or hides to the tray)
  mainWindow = new BaseWindow(opts)
  // Apple's page: its preload is only the focus bridge to the rail (preload-apple.js); the security
  // defaults are spelled out, unchanged: no Node, sandboxed, isolated from the page's scripts
  // lifetime: OK — the views' web contents are closed in the window's 'closed' handler (a BaseWindow doesn't)
  appleView = new WebContentsView({
    webPreferences: { preload: path.join(__dirname, 'preload-apple.js'), contextIsolation: true, sandbox: true, nodeIntegration: false }
  })
  // the rail: a local page, sandboxed and isolated too, transparent where it has nothing to draw
  railView = new WebContentsView({ webPreferences: SONATA_VIEW_PREFS('preload-rail-view.js') })
  railView.setBackgroundColor('#00000000')
  mainWindow.contentView.addChildView(appleView)
  mainWindow.contentView.addChildView(railView)   // added last: on top
  layoutViews()
  appleWC().loadURL(appUrl + locale.toLowerCase() + '/browse')
  railView.webContents.loadFile('rail.html')
  // lifetime: OK — once, on the rail's first load: the start-marker clock (gfx-runtime.js) starts there
  railView.webContents.once('did-finish-load', () => gfx.painted())
  lockDownLocalWindow(railView)
  // the side panel, if it was showing when Sonata last closed
  if (settings.panelShown) createPanelView()
  appleWC().focus()

  // remember size/position across launches (debounced)
  const rememberBounds = () => {
    if (!mainAlive() || mainWindow.isMinimized() || mainWindow.isFullScreen()) return
    clearTimeout(saveBoundsTimer)
    // lifetime: OK — one 500 ms debounce, cleared before each new one
    saveBoundsTimer = setTimeout(() => {
      if (mainAlive() && mainWindow.isVisible()) { settings.windowBounds = mainWindow.getBounds(); saveSettings() }
    }, 500)
  }
  // loop: NOT-WORTH — main-window bounds save · 500 ms one-shot debounce · only after a move/resize · cost ~0
  mainWindow.on('resize', rememberBounds)
  mainWindow.on('move', rememberBounds)
  // lifetime: OK — one listener each for the views' layout, die with the window · per event one bounds
  // read + compare; setBounds only when the size or the rail's mode changed (a pinned rail floats
  // below 996 px). Maximize and fullscreen arrive as resizes; the fullscreen events are listened to
  // as well in case a window manager resizes before announcing them.
  mainWindow.on('resize', pushRail)
  // lifetime: OK — four listeners for the window's life: About → Graphics and For the Curious sample only while the window shows
  // loop: NOT-WORTH — four event names, once
  for (const ev of ['show', 'hide', 'minimize', 'restore']) mainWindow.on(ev, aboutSync)
  mainWindow.on('enter-full-screen', pushRail)
  mainWindow.on('leave-full-screen', pushRail)
  // lifetime: OK — one listener · the window's focus goes to the view that had it (a BaseWindow has no
  // web contents of its own)
  mainWindow.on('focus', () => {
    if (!mainAlive()) return
    if (focusedView === 'rail' && railAlive()) railView.webContents.focus()
    else if (focusedView === 'panel' && panelAlive() && settings.panelShown) panelView.webContents.focus()
    else appleWC().focus()
  })

  // lifetime: OK — createWindow runs once (plus macOS 'activate' with no windows), so the views' and the
  // window's listeners below are registered once and die with them
  appleWC().on('before-input-event', (event, input) => windowShortcut(input))
  railView.webContents.on('before-input-event', (event, input) => windowShortcut(input))
  appleWC().on('focus', () => { focusedView = 'apple' })
  railView.webContents.on('focus', () => { focusedView = 'rail' })
  // the rail page loading again (it never navigates; only a reload after a renderer crash): it says 'mounted' again
  railView.webContents.on('did-start-loading', () => { railMounted = false; railSent = '' })

  // back/forward mouse buttons
  // lifetime: OK — once per window, dies with it
  mainWindow.on('app-command', (event, command) => {
    if (command === 'browser-backward' && appleWC().navigationHistory.canGoBack()) {
      appleWC().navigationHistory.goBack()
    }
    else if (command === 'browser-forward' && appleWC().navigationHistory.canGoForward()) {
      appleWC().navigationHistory.goForward()
    }
  })

  // lifetime: OK — dies with Apple's view
  appleWC().on('will-navigate', (event, url) => {
    if (!url.startsWith(appUrl)) {
      event.preventDefault()
      openExternalSafe(url)
    }
  });

  appleWC().setWindowOpenHandler(({ url }) => {
    openExternalSafe(url)
    return { action: 'deny' }
  });

  // lifetime: OK — FIXED: this used to call insertCSS directly, which adds a new stylesheet every time;
  // measured 2 -> 202 injected sheets after 200 title changes, growing for the life of the page. The replacer keeps one.
  applyCustomCss = createCssReplacer(appleWC(), appleCss)
  appleWC().on('did-navigate', () => {
    applyCustomCss()
  });

  // lifetime: OK — one dom-ready listener, dies with the view · per Apple page load (not per SPA route
  // change: Apple's routes keep the document) one injection of the focus stops and one of the
  // media-controls position script
  appleWC().on('dom-ready', injectFocusStops)
  appleWC().on('dom-ready', injectMediaPosition)

  appleWC().on('page-title-updated', () => {
    applyCustomCss()
    mainWindow.setTitle(appName);
  });

  // lifetime: OK — a BaseWindow doesn't destroy its views' web contents; they are closed here
  mainWindow.on('closed', () => {
    for (const v of [appleView, railView, panelView, toastView]) if (v && !v.webContents.isDestroyed()) v.webContents.close() // loop: NOT-WORTH — 4 views, once on close
  })

  mainWindow.on("close", (e) => {
    // close-to-tray: hide instead of quitting (tray "Quit" bypasses via app.exit)
    if (settings.closeToTray && !shuttingDown) {
      e.preventDefault()
      mainWindow.hide()
      return
    }
    shuttingDown = true
    stopDesktopScheme()
    clearInterval(miniPoll)
    clearInterval(lyricsPoll)
    if (listenSession) listenSession.stop()
    if (alignSession) alignSession.stop(false)
    if (alignHelper) alignHelper.stop()
    app.exit(0);
 });
}

// --- AppImage menu integration & self-update ---

const appImagePath = process.env.APPIMAGE || ''
let installedPath = appImagePath  // the real, versioned AppImage currently in use
let stablePath = ''               // <dir>/Sonata.AppImage symlink -> installedPath
if (appImagePath) {
  try { installedPath = fs.realpathSync(appImagePath) } catch (e) {}   // error: NOT-WORTH — unresolvable: the APPIMAGE path as given is used
  stablePath = path.join(path.dirname(installedPath), 'Sonata.AppImage')
}
const appId = 'io.github.MarcelineVPQ.Sonata'

// Running from an AppImage leaves no menu entry or icon behind; write the
// XDG pieces ourselves, and keep Exec pointed at the AppImage if it moves.
function integrateAppImage() {
  if (process.platform !== 'linux' || !installedPath) return
  try {
    // Point a stable symlink (Sonata.AppImage) at the current versioned file,
    // and aim the menu entry at the symlink. That way the .desktop file never
    // changes across updates, so the menu can't go stale and fire a deleted
    // versioned path (the "can't find <old version>" bug).
    let launch = installedPath
    if (stablePath && stablePath !== installedPath) {
      try {
        if (fs.existsSync(stablePath) || fs.lstatSync(stablePath, { throwIfNoEntry: false })) {
          fs.rmSync(stablePath, { force: true })
        }
      } catch (e) {}   // error: NOT-WORTH — nothing to remove; the symlink below says if it can't be made
      try { fs.symlinkSync(installedPath, stablePath); launch = stablePath } catch (e) {}   // error: NOT-WORTH — folder not writable: the menu entry points at the versioned file instead
    }
    const share = path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'))
    const iconPath = path.join(share, 'icons', 'hicolor', '512x512', 'apps', appId + '.png')
    fs.mkdirSync(path.dirname(iconPath), { recursive: true })
    fs.writeFileSync(iconPath, fs.readFileSync(path.join(__dirname, 'sonata.png')))
    const entry =
      '[Desktop Entry]\nType=Application\nName=Sonata\n' +
      'Comment=Apple Music for Linux\n' +
      'Exec=' + JSON.stringify(launch) + ' %U\n' +
      'Icon=' + appId + '\nTerminal=false\n' +
      'Categories=AudioVideo;Audio;Player;\n' +
      'StartupWMClass=apple-music-for-linux\n'
    const appsDir = path.join(share, 'applications')
    const desktopPath = path.join(appsDir, appId + '.desktop')
    fs.mkdirSync(appsDir, { recursive: true })
    let current = ''
    try { current = fs.readFileSync(desktopPath, 'utf8') } catch (e) {}   // error: NOT-WORTH — no entry yet: it is written below
    if (current !== entry) {
      fs.writeFileSync(desktopPath, entry)
      // refresh the XDG desktop DB and KDE's menu cache so the new entry lands
      // lifetime: OK — one short run when the entry changed, it ends by itself
      exec(`update-desktop-database ${JSON.stringify(appsDir)} 2>/dev/null; ` +
           `kbuildsycoca6 2>/dev/null || kbuildsycoca5 2>/dev/null`, () => {})
    }
  } catch (e) { console.error('menu integration failed:', e.message) }   // error: LOGGED-OK — no menu entry or icon this run; Sonata itself runs
}

function fetchText(url) {
  return new Promise((resolve, reject) => {
    // lifetime: OK — one request per feed fetch; its listeners go with it at end or error
    const req = net.request(url)
    req.on('response', (res) => {
      if (res.statusCode !== 200) { reject(new Error('HTTP ' + res.statusCode)); return }
      let body = ''
      res.on('data', (chunk) => { body += chunk })
      res.on('end', () => resolve(body))
      res.on('error', reject)
    })
    req.on('error', reject)   // lifetime: OK — goes with the request
    req.end()
  })
}

// error: PASSES-ON — a failed request or write rejects; updater.js shows it and deletes the .part file
function downloadFile(url, dest, onProgress) {
  return new Promise((resolve, reject) => {
    // lifetime: OK — the file stream ends with the response or is closed on failure; one request per download
    const file = fs.createWriteStream(dest)
    const fail = (e) => { file.close(() => fs.unlink(dest, () => {})); reject(e) }
    const req = net.request(url)
    req.on('response', (res) => {
      if (res.statusCode !== 200) { fail(new Error('HTTP ' + res.statusCode)); return }
      const total = Number(res.headers['content-length']) || 0
      let got = 0
      // loop: NOT-WORTH — download stream · one chunk at a time (~16-64 KB) · once per update · ends at EOF · progress ≤ 4/s (updater.js)
      res.on('data', (chunk) => { got += chunk.length; file.write(chunk); if (onProgress) onProgress(got, total) })
      res.on('end', () => file.end(resolve))
      res.on('error', fail)
    })
    req.on('error', fail)
    req.end()
  })
}

// --- self-update: the flow and its rules are updater.js's; main wires it to the feed, the files, the
// notices and the playback state ---
const testFeed = updateFeed.testFeed(process.env)
if (testFeed) console.log('update: TEST FEED ' + testFeed.prefix + ' (loopback only)')
let lastPlaying = false          // from the now-playing polls: Restart now waits for a pause
let updateNotified = ''          // the version a desktop notification was shown for (tray-only state)
// lifetime: NOT-WORTH — one updater for the app's life (AppImage builds only)
const updater = updaterLib.createUpdater({
  version: app.getVersion(),
  channel: () => settings.updateChannel,
  fetchUpdate: (channel) => updateFeed.fetchUpdate({ channel, fetchText, test: testFeed, log: (m) => console.log(m) }),
  download: downloadFile,
  verify: (file, feed) => updateFeed.verifyDownload(file, feed),
  fs,
  installedPath: () => installedPath,
  blocker: () => (!appImagePath ? 'only the AppImage updates itself; from source, update with git pull' : null),
  onInstalled: (newPath) => {
    // the running AppImage stays (FUSE-mounted); the new one is beside it, the symlink and menu entry point at it
    installedPath = newPath
    process.env.APPIMAGE = newPath
    integrateAppImage()
    if (settings.launchAtLogin) applyAutostart()
  },
  emit: () => onUpdateState(),
  now: () => Date.now(),
  log: (m) => console.error(m)
})
let lastInstallFailure = null   // { version, detail } of the last failed install (said while that version is offered)
function onUpdateState() {
  const st = updater.state()
  if (st.phase === 'failed' && st.during === 'install') lastInstallFailure = { version: st.version, detail: st.detail }
  else if (st.phase === 'ready') lastInstallFailure = null
  const n = updaterLib.updateNotice(st, { playing: lastPlaying, lastFailure: lastInstallFailure })
  if (n) notices.show(Object.assign({ place: 'top', page: 'settings' }, n))
  else if (st.phase !== 'checking') notices.clear('update')
  // Install updates automatically: an offered (newer) update downloads, checks and installs by itself
  // (not again by itself after that version failed: Try again is the user's)
  if (st.phase === 'available' && settings.autoInstallUpdates && !st.older && !(lastInstallFailure && lastInstallFailure.version === st.version)) installUpdate()
  // in the tray (window hidden): one desktop notification per version, which opens Settings → Updates
  if ((st.phase === 'available' || st.phase === 'ready') && updateNotified !== st.phase + st.version &&
      !(mainAlive() && mainWindow.isVisible()) && Notification.isSupported()) {
    updateNotified = st.phase + st.version
    // lifetime: OK — one notification per offered version, collected after display
    const note = new Notification({
      title: st.phase === 'ready' ? 'Sonata ' + st.version + ' is installed' : 'Sonata ' + st.version + ' is available',
      body: st.phase === 'ready' ? 'It starts the next time you open Sonata.' : 'Open Settings → Updates to install it.',
      icon: path.join(__dirname, 'sonata.png'), silent: true
    })
    // lifetime: OK — one click listener on this notification, collected with it
    note.on('click', () => showPanel('settings', 'updates'))
    note.show()
  }
  pushPanel()
}
function installUpdate() { updater.install() }
async function checkForUpdates(interactive) {
  if (!appImagePath) {
    if (interactive) toast('Only the AppImage updates itself; from source, update with git pull.')
    return
  }
  const st = await updater.check({ interactive })
  if (interactive && st.phase === 'up-to-date') toast('Sonata ' + app.getVersion() + ' is up to date (' + (settings.updateChannel === 'dev' ? 'Development' : 'Stable') + ').')
}
// Back to stable (confirmed in the panel): the Stable channel, then its newest release even if older
async function backToStable() {
  if (settings.updateChannel !== 'stable') { settings.updateChannel = 'stable'; saveSettings(); pushRail() }
  await updater.backToStable()
}
// a change in playback (from the 5 s poll): Restart now shows only while paused
function setPlaying(playing) {
  if (playing === lastPlaying) return
  lastPlaying = playing
  if (updater.state().phase === 'ready') onUpdateState()
}

// "Updated to X · See what's new": once after an update, until About's What's new was seen or it's dismissed
function showWhatsNew() {
  const last = settings.lastRunVersion || (settingsExisted ? 'earlier' : '')
  const v = updaterLib.updatedSince(last, app.getVersion())
  if (!v) { if (settings.lastRunVersion !== app.getVersion()) { settings.lastRunVersion = app.getVersion(); saveSettings() } return }
  notices.show({
    id: 'whatsnew', place: 'top', page: 'about', task: true, kind: 'info',
    text: 'Updated to Sonata ' + v + '.',
    actions: [{ id: 'whatsnew-see', label: 'See what\'s new', primary: true }]
  })
}
// About → What's new shown (or the notice dismissed): it was seen
function seenWhatsNew(dismissed) {
  if (!notices.has('whatsnew')) return
  const shown = settings.panelShown && settings.panelPage === 'about' && panelModel.isOpen(accOf('about'), 'whatsnew')
  if (!shown && !dismissed) return
  settings.lastRunVersion = app.getVersion()
  saveSettings()
  notices.clear('whatsnew')
}
// asked once (DS5): install updates automatically? Until answered, Sonata asks before installing.
function askAutoUpdate() {
  if (settings.updatesAsked || !appImagePath) return
  notices.show({
    id: 'ask-auto', place: 'top', kind: 'info',
    text: 'Keep Sonata up to date?',
    detail: 'New versions can download and install by themselves, checked like every update (signature and checksum), and start the next time you open Sonata. You can change this in Settings → Updates.',
    actions: [{ id: 'ask-auto-no', label: 'Ask me each time' }, { id: 'ask-auto-yes', label: 'Update automatically', primary: true }]
  })
}

function restartIntoUpdate() {
  shuttingDown = true
  // free the single-instance lock so the replacement can take it immediately
  app.releaseSingleInstanceLock()
  const target = (stablePath && fs.existsSync(stablePath)) ? stablePath : installedPath
  startNewCopy(target, relaunch.relaunchArgs(process.argv))
  stopDesktopScheme()
  app.exit(0)
}
// Settings → Experimental → Restart now: this same Sonata again (the AppImage in use, or Electron with the
// app folder when run from source, in the folder it was started from), without --safe-gpu: the switches
// are decided again at its start from the settings (gfx-runtime.js). Music stops for the restart.
function restartApp() {
  shuttingDown = true
  app.releaseSingleInstanceLock()
  const args = relaunch.relaunchArgs(process.argv).filter((a) => a !== '--safe-gpu')
  startNewCopy(installedPath || process.execPath, args, appImagePath ? '' : process.cwd())
  stopDesktopScheme()
  app.exit(0)
}
// Relaunch in the CLEAN session environment, the way a menu launch does.
// Inheriting THIS process's Chromium-polluted env crashes the new instance
// (SIGBUS/SIGTRAP); the user's systemd manager gives it a fresh env and
// outlives us. Pass only session vars through, not our whole environment,
// and PATH without our AppImage mount, which ends with us (relaunch.js).
function startNewCopy(target, args, cwd) {
  const env = relaunch.relaunchEnv(process.env)
  const unit = 'sonata-relaunch-' + Date.now()
  let started = false
  // loop: NOT-WORTH — at most two tries: with ExitType=cgroup, then without (systemd older than 250)
  for (const exitTypeCgroup of [true, false]) {
    try {
      execFileSync('systemd-run', relaunch.systemdRunArgs({ target, args, env, unit, exitTypeCgroup, cwd }), { stdio: 'ignore' })
      started = true
      break
    } catch (e) { /* error: NOT-WORTH — systemd-run unavailable or too old: next try, then the shell below */ }
  }
  if (!started) {
    try {
      // lifetime: OK — detached and unref'd: the new Sonata outlives this one
      spawn('/bin/sh', relaunch.shellArgs(target, args), { detached: true, stdio: 'ignore', env, cwd: cwd || undefined }).unref()
    } catch (e) { console.error('relaunch: could not start the new copy:', e.message) }   // error: LOGGED-OK — the next menu launch starts it
  }
}

// Remove older-versioned Sonata AppImages left beside the current one by a
// previous self-update (we couldn't delete them while they were running).
// Safe now: this process runs from appImagePath, never the files being pruned.
function pruneOldAppImages() {
  if (!appImagePath) return
  try {
    const dir = path.dirname(appImagePath)
    const self = path.basename(appImagePath)
    // loop: NOT-WORTH — the AppImage folder's entries, once at start
    for (const f of fs.readdirSync(dir)) {
      const m = f.match(/^sonata-(\d+\.\d+\.\d+(?:-dev\.\d+)?)-.*\.AppImage$/i)
      if (m && f !== self && updateFeed.isNewerVersion(app.getVersion(), m[1])) {
        try { fs.unlinkSync(path.join(dir, f)) } catch (e) {}   // error: NOT-WORTH — not removable now: tried again next start
      }
      // a download a crash or a quit cut short (never a running file: those end in .AppImage)
      else if (/^sonata-\d+\.\d+\.\d+(?:-dev\.\d+)?-x86_64\.AppImage\.part$/.test(f)) {
        try { fs.unlinkSync(path.join(dir, f)) } catch (e) {}   // error: NOT-WORTH — not removable now: tried again next start
      }
    }
  } catch (e) {}   // error: NOT-WORTH — folder unreadable: nothing pruned
}

// Check for updates automatically (Settings → Updates, on by default): 20 s after start, then every 2 h.
// Off: no timer and nothing online at start; only Check now (or the tray's Check for Updates…) goes online.
// loop: NOT-WORTH — update check · 20 s one-shot, then every 2 h · AppImage builds with checks on only · stopped when
// checks are turned off, and on app exit · cost two small HTTPS GETs per 2 h (feed + .sig), a download
// only when a new version is offered and installed; updater.js's busy flag stops overlaps
// error: SHOWN — a failed check (offline, bad signature, hash mismatch) is shown in Settings → Updates and waits the full 2 h, so it can't hammer
let updateFirstTimer = null
let updateTimer = null
function startUpdateChecks() {
  clearTimeout(updateFirstTimer); clearInterval(updateTimer)
  updateFirstTimer = null; updateTimer = null
  if (!appImagePath || !settings.checkForUpdates) return
  // lifetime: OK — both cleared at the top here (checks off or restarted); they end with the app
  updateFirstTimer = setTimeout(() => checkForUpdates(false), 20 * 1000)
  updateTimer = setInterval(() => checkForUpdates(false), 2 * 60 * 60 * 1000)
}

// ~/.config/autostart entry for launch-on-login (Electron's setLoginItemSettings
// is a no-op on Linux, so write the desktop file ourselves)
function autostartExec() {
  if (process.env.APPIMAGE) return JSON.stringify(process.env.APPIMAGE)
  return JSON.stringify(process.execPath)
}
function applyAutostart() {
  const dir = path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'autostart')
  const file = path.join(dir, 'io.github.MarcelineVPQ.Sonata.desktop')
  try {
    if (settings.launchAtLogin) {
      fs.mkdirSync(dir, { recursive: true })
      const exec = autostartExec() + (settings.startMinimized ? ' --hidden' : '')
      fs.writeFileSync(file,
        '[Desktop Entry]\nType=Application\nName=Sonata\n' +
        'Exec=' + exec + '\nIcon=io.github.MarcelineVPQ.Sonata\n' +
        'Terminal=false\nX-GNOME-Autostart-enabled=true\n')
    } else if (fs.existsSync(file)) {
      fs.unlinkSync(file)
    }
  } catch (e) { console.error('autostart update failed:', e.message) }   // error: LOGGED-OK — the login entry stays as it was (read-only config: rare)
}

// single instance: launching Sonata again just surfaces the running copy
if (!app.requestSingleInstanceLock()) {
  app.exit(0)
}
// Launching Sonata again always shows something: the mini player when it's up, else the main window,
// made now if there is none (a startup that stopped before it, 0.15.35-dev.1). Before the app is ready
// the startup below makes it.
// lifetime: NOT-WORTH — app listeners, registered once for the app's life
app.on('second-instance', () => {
  if (miniWindow && !miniWindow.isDestroyed()) {
    miniWindow.show()
    miniWindow.focus()
    return
  }
  if (!app.isReady()) return
  if (!mainWindow || mainWindow.isDestroyed()) {
    startupStep('window', createWindow)
    if (!tray) startupStep('tray', createTray)
  }
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.show()
    mainWindow.focus()
  }
})

// One startup step: a failure is logged and the next step still runs, so a theme, locale or
// settings problem can't keep the window and the tray from appearing.
function startupStep(name, fn) {
  try { fn() } catch (e) { console.error('startup: ' + name + ' failed:', (e && e.stack) || e) }   // error: LOGGED-OK — startup goes on
}

app.whenReady().then(async () => {
  await components.whenReady()
  startupStep('locale and theme', initLocaleAndTheme)
  lastfm = new LastFm(path.join(app.getPath('userData'), 'lastfm.json'))
  const pendingPath = path.join(app.getPath('userData'), 'lastfm-pending.json')
  scrobbleQueue = createScrobbleQueue({
    send: (entries) => lastfm.scrobbleBatch(entries),
    load: () => JSON.parse(fs.readFileSync(pendingPath, 'utf8')),
    // written whole and renamed into place, so a quit mid-write can't leave half a file
    save: (list) => {
      if (!list.length) { fs.rmSync(pendingPath, { force: true }); return }
      fs.writeFileSync(pendingPath + '.tmp', JSON.stringify(list) + '\n')
      fs.renameSync(pendingPath + '.tmp', pendingPath)
    },
    log: (msg) => console.error(msg)
  })
  discordConfigPath = path.join(app.getPath('userData'), 'discord.json')
  loadDiscordConfig()
  settingsPath = path.join(app.getPath('userData'), 'settings.json')
  // a damaged cache keeps what reads, is copied aside and says so once (lyrics-store.js)
  // the Montage's answers and photos (bounded; only caches: a damaged answers file keeps what reads, quietly)
  montageCache = require('./lyrics-store').createLyricsStore({ file: path.join(app.getPath('userData'), 'montage-cache.json'), maxEntries: 1500, maxBytes: 4 * 1024 * 1024, onRecovered: (r) => console.error('montage cache: damaged file repaired: ' + JSON.stringify(r)) })
  montageImages = montageStoreLib.createImageStore({ dir: path.join(app.getPath('userData'), 'montage'), maxBytes: 64 * 1024 * 1024, maxFiles: 300 })
  lyricsStore = require('./lyrics-store').createLyricsStore({
    file: path.join(app.getPath('userData'), 'lyrics-cache.json'),
    onRecovered: (r) => {
      console.error('lyrics cache: damaged file repaired: ' + JSON.stringify(r))
      showRecovered('lyrics', 'Sonata\'s lyrics cache was damaged, so it was repaired: ' + r.kept + ' songs kept' +
        (r.dropped ? ', ' + r.dropped + ' unreadable ' + (r.dropped === 1 ? 'entry' : 'entries') + ' dropped (they are fetched again when played)' : '') + '. ' +
        (r.aside ? 'A copy of the damaged file: ' + r.aside : 'No copy of the damaged file could be kept.'), r.aside)
    }
  })
  // the liner notes' cache: one entry per album (bounded like the lyrics cache, liner-notes-model.js CACHE);
  // a damaged file keeps what reads (it is only a cache: the rest is fetched again when a booklet opens)
  linerStore = require('./lyrics-store').createLyricsStore({
    file: path.join(app.getPath('userData'), 'liner-notes-cache.json'),
    maxEntries: linerModel.CACHE.maxEntries,
    maxBytes: linerModel.CACHE.maxBytes,
    onRecovered: (r) => console.error('liner notes cache: damaged file repaired: ' + JSON.stringify(r))   // error: LOGGED-OK — a cache: what didn't read is fetched again
  })
  // lifetime: NOT-WORTH — registered once, for the app's life
  app.on('before-quit', () => {
    gfx.stop()
    stopDesktopScheme()
    if (shortcuts) shortcuts.stop()
    if (listenSession) listenSession.stop()
    if (alignSession) alignSession.stop(false)
    if (alignHelper) alignHelper.stop()
    if (lyricsStore) lyricsStore.flush()
    if (linerStore) linerStore.flush()
    if (montageCache) montageCache.flush()
  })
  startupStep('settings', loadSettings)
  startupStep('graphics switches', startGfx)
  startupStep('notices', () => notices.setDismissed(settings.dismissedNotices))
  startupStep('autostart', applyAutostart)
  startupStep('window positions', cleanupWindowPositionMemory)
  startupStep('menu entry', integrateAppImage)
  startupStep('window', createWindow)
  startupStep('tray', createTray)
  startupStep('global shortcuts', startShortcuts)
  startNowPlayingLoop()
  useTestArtwork()
  startupStep('old versions', pruneOldAppImages)   // local files only (no network), also with automatic checks off
  startupStep('update checks', startUpdateChecks)
  startupStep('what\'s new', showWhatsNew)
  startupStep('auto-update question', askAutoUpdate)
  startupStep('precise timing install check', () => alignInstalled(true))
  if (process.argv.includes('--mini')) {
    toggleMiniPlayer()
  }
  if (process.argv.includes('--viz')) {
    toggleVisualizer()
  }
  if (process.argv.includes('--settings')) {
    showPanel('settings')
  }
  if (process.argv.includes('--about')) {
    showPanel('about')
  }
  if (process.argv.includes('--lyrics')) {
    toggleLyricsWindow()
  }
  // lifetime: NOT-WORTH — registered once, for the app's life
  app.on('activate', function () {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
}).catch((e) => {
  // error: LOGGED-OK — a step outside startupStep threw: said, and the window and tray still come up when they can
  console.error('startup failed:', (e && e.stack) || e)
  if (!mainWindow || mainWindow.isDestroyed()) startupStep('window', createWindow)
  if (!tray) startupStep('tray', createTray)
})

// lifetime: NOT-WORTH — registered once, for the app's life
app.on('window-all-closed', function () {
  if (process.platform !== 'darwin') app.quit()
})