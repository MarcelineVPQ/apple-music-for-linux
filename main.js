const { app, BrowserWindow, Menu, Tray, shell, nativeTheme, nativeImage, ipcMain, dialog, clipboard, Notification, components, net } = require('electron')
const fs = require('fs');
const path = require('path');
const os = require('os');
const { exec, spawn } = require('child_process');
const crypto = require('crypto');
const { LastFm } = require('./lastfm');
const { DiscordPresence } = require('./discord');
const { Visualizer } = require('./visualizer');

const appName = 'Sonata'

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
let shuttingDown = false
let lastfm = null
let scrobbleState = null
let discord = null
let discordConfig = { applicationId: '', enabled: false }
let discordConfigPath = null
let discordReconnectTicks = 0
let lastPresenceKey = ''
let miniTrackKey = ''
let vizWindow = null
let vizPoll = null
let visualizer = null
let vizTrackKey = ''
let settings = { notifications: true, closeToTray: false, launchAtLogin: false, startMinimized: false, windowBounds: null, miniAlwaysOnTop: true }
let settingsPath = null
let settingsWindow = null
let notifyKey = null       // null until first poll, so we don't notify the track already loaded at launch
let trayTooltip = ''
let saveBoundsTimer = null

function loadSettings() {
  try {
    settings = { ...settings, ...JSON.parse(fs.readFileSync(settingsPath, 'utf8')) }
  } catch (e) { /* defaults */ }
}
function saveSettings() {
  try { fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n') } catch (e) {}
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
function persistBounds(win, key) {
  let timer = null
  const save = () => {
    if (win.isDestroyed() || win.isMinimized() || win.isFullScreen() || !win.isVisible()) return
    clearTimeout(timer)
    timer = setTimeout(() => {
      if (!win.isDestroyed()) { settings[key] = win.getBounds(); saveSettings() }
    }, 500)
  }
  win.on('resize', save); win.on('move', save)
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
  nativeTheme.themeSource = ['light', 'dark', 'system'].includes(savedTheme) ? savedTheme : 'system';
}

function toggleTheme() {
  nativeTheme.themeSource = nativeTheme.shouldUseDarkColors ? 'light' : 'dark'
  if (themeFile) {
    fs.writeFileSync(themeFile, nativeTheme.themeSource);
  }
}

function mainAlive() {
  return mainWindow && !mainWindow.isDestroyed()
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
  } catch (e) { /* invalid URL: ignore */ }
}

// Block navigation and popups for windows that load our trusted local HTML
// with Node integration — defense in depth so they can never reach remote code.
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
  mainWindow.webContents.executeJavaScript(scripts[command])
    .catch((e) => console.error('player command failed:', command, e.message))
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
      duration: attrs && attrs.durationInMillis ? attrs.durationInMillis / 1000 : 0,
      playbackTime: mk.currentPlaybackTime || 0,
      artworkLarge: attrs && attrs.artwork && attrs.artwork.url
        ? attrs.artwork.url.replace('{w}', 512).replace('{h}', 512)
        : '',
      artwork: attrs && attrs.artwork && attrs.artwork.url
        ? attrs.artwork.url.replace('{w}', 168).replace('{h}', 168)
        : '',
      shuffle: mk.shuffleMode === 1,
      repeat: mk.repeatMode,
      volume: mk.volume,
      contentRating: attrs ? (attrs.contentRating || '') : ''
    };
  } catch (e) {
    return { ok: false };
  }
})()`

function createMiniWindow() {
  miniWindow = new BrowserWindow({
    width: 680,
    height: 72,
    frame: false,
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
  // give KWin a moment to map the window before asking it to keep it above
  if (settings.miniAlwaysOnTop) setTimeout(() => applyMiniKeepAbove(true), 300)

  miniWindow.webContents.once('did-finish-load', () => {
    miniTrackKey = ''
    miniPoll = setInterval(async () => {
      if (!mainAlive() || !miniWindow) return
      try {
        const state = await mainWindow.webContents.executeJavaScript(nowPlayingScript)
        if (!miniWindow || miniWindow.isDestroyed()) return
        miniWindow.webContents.send('now-playing', state)
        // refresh the favorite star only when the track changes (avoids an
        // API call every tick)
        const key = state && state.ok && state.title ? state.title + '|' + state.artist : ''
        if (key && key !== miniTrackKey) {
          miniTrackKey = key
          const fav = await mainWindow.webContents.executeJavaScript(ratingFetchScript)
          if (miniWindow && !miniWindow.isDestroyed()) miniWindow.webContents.send('favorite-state', fav)
        }
      } catch (e) { /* page mid-navigation; try again next tick */ }
    }, 1000)
  })

  miniWindow.on('closed', () => {
    miniWindow = null
    clearInterval(miniPoll)
    miniPoll = null
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
const lyricsFetchScript = `(async () => {
  try {
    const mk = MusicKit.getInstance();
    const item = mk.nowPlayingItem;
    if (!item) return { ok: false };
    const attrs = item.attributes || {};
    const pp = attrs.playParams || {};
    const id = pp.catalogId || pp.id || item.id;
    const res = await mk.api.music('/v1/catalog/{{storefront}}/songs/' + id + '/lyrics');
    const data = res && res.data && res.data.data && res.data.data[0];
    return { ok: true, ttml: (data && data.attributes && data.attributes.ttml) || '' };
  } catch (e) {
    return { ok: true, ttml: '' };
  }
})()`

function parseTtmlClock(value) {
  value = value.trim()
  if (!value.includes(':')) return parseFloat(value) || 0
  return value.split(':').reduce((total, part) => total * 60 + (parseFloat(part) || 0), 0)
}

function parseTtml(ttml) {
  const lines = []
  const re = /<p[^>]*\bbegin="([^"]+)"[^>]*>([\s\S]*?)<\/p>/g
  let match
  while ((match = re.exec(ttml))) {
    const text = match[2]
      .replace(/></g, '> <')
      .replace(/<[^>]+>/g, '')
      .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
      .replace(/\s+/g, ' ')
      .trim()
    if (text) lines.push({ t: parseTtmlClock(match[1]), text })
  }
  return lines
}

function createLyricsWindow() {
  lyricsWindow = new BrowserWindow(applySavedBounds({
    width: 380,
    height: 560,
    minWidth: 260,
    minHeight: 300,
    frame: false,
    transparent: true,
    hasShadow: false,
    alwaysOnTop: true,
    title: appName + ' — Lyrics',
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    }
  }, 'lyricsBounds'))
  lyricsWindow.loadFile('lyrics.html')
  persistBounds(lyricsWindow, 'lyricsBounds')
  lockDownLocalWindow(lyricsWindow)

  lyricsWindow.webContents.once('did-finish-load', () => {
    lyricsKey = null // force a lyrics fetch on first tick
    lyricsPoll = setInterval(async () => {
      if (!mainAlive() || !lyricsWindow || lyricsWindow.isDestroyed()) return
      let state
      try {
        state = await mainWindow.webContents.executeJavaScript(nowPlayingScript)
      } catch (e) { return }
      if (!state || !state.ok || !lyricsWindow || lyricsWindow.isDestroyed()) return

      const key = state.title + '|' + state.artist
      if (key !== lyricsKey) {
        lyricsKey = key
        let lines = []
        if (state.title) {
          try {
            const res = await mainWindow.webContents.executeJavaScript(lyricsFetchScript)
            if (res && res.ttml) lines = parseTtml(res.ttml)
          } catch (e) { /* no lyrics */ }
        }
        if (lyricsWindow && !lyricsWindow.isDestroyed()) {
          lyricsWindow.webContents.send('lyrics-data', { title: state.title, artist: state.artist, lines })
        }
      }
      if (lyricsWindow && !lyricsWindow.isDestroyed()) lyricsWindow.webContents.send('lyrics-time', state.playbackTime)
    }, 500)
  })

  lyricsWindow.on('closed', () => {
    lyricsWindow = null
    clearInterval(lyricsPoll)
    lyricsPoll = null
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

ipcMain.on('lyrics-command', (event, command, value) => {
  if (command === 'close') {
    if (lyricsWindow) lyricsWindow.close()
  }
  else if (command === 'seek') {
    const seconds = Math.max(0, Number(value) || 0)
    if (mainWindow) {
      mainWindow.webContents.executeJavaScript(`(() => { MusicKit.getInstance().seekToTime(${seconds}); })();`)
        .catch((e) => console.error('lyrics seek failed:', e.message))
    }
  }
})

// --- audio-reactive visualizer / ambient mode ---

function createVizWindow() {
  vizWindow = new BrowserWindow({
    fullscreen: true,
    frame: false,
    backgroundColor: '#000000',
    title: appName + ' — Visualizer',
    webPreferences: { nodeIntegration: true, contextIsolation: false }
  })
  vizWindow.loadFile('visualizer.html')
  lockDownLocalWindow(vizWindow)

  visualizer = new Visualizer((bands) => {
    if (vizWindow && !vizWindow.isDestroyed()) vizWindow.webContents.send('viz-bands', bands)
  })

  vizWindow.webContents.once('did-finish-load', () => {
    visualizer.start()
    vizTrackKey = null
    // 300ms cadence: frequent enough for smooth synced-lyric highlighting
    vizPoll = setInterval(async () => {
      if (!mainAlive() || !vizWindow || vizWindow.isDestroyed()) return
      let state
      try {
        state = await mainWindow.webContents.executeJavaScript(nowPlayingScript)
      } catch (e) { return }
      if (!state || !state.ok || vizWindow.isDestroyed()) return

      const key = state.title + '|' + state.artist
      if (key !== vizTrackKey) {
        vizTrackKey = key
        vizWindow.webContents.send('viz-nowplaying', {
          title: state.title, artist: state.artist, artwork: state.artworkLarge || state.artwork
        })
        // fetch synced lyrics for the new track (same TTML pipeline as the lyrics window)
        let lines = []
        if (state.title) {
          try {
            const res = await mainWindow.webContents.executeJavaScript(lyricsFetchScript)
            if (res && res.ttml) lines = parseTtml(res.ttml)
          } catch (e) { /* no lyrics */ }
        }
        if (vizWindow && !vizWindow.isDestroyed()) vizWindow.webContents.send('viz-lyrics', lines)
      }
      if (vizWindow && !vizWindow.isDestroyed()) vizWindow.webContents.send('viz-time', state.playbackTime)
    }, 300)
  })

  vizWindow.on('closed', () => {
    if (visualizer) { visualizer.stop(); visualizer = null }
    clearInterval(vizPoll); vizPoll = null
    vizWindow = null
  })
}

function toggleVisualizer() {
  if (vizWindow) vizWindow.close()
  else createVizWindow()
}

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
    } catch (e) { /* not rated */ }
    return { ok: true, id: String(id), title: attrs.name || '', url: attrs.url || '', rating };
  } catch (e) {
    return { ok: false };
  }
})()`

function musicApiCall(script, label) {
  if (!mainAlive()) return
  mainWindow.webContents.executeJavaScript(script)
    .catch((e) => console.error(label + ' failed:', e.message))
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
  } catch (e) {
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
    } catch (e) { /* not rated */ }
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
  } catch (e) {
    return { ok: false };
  }
})()`

async function showMoreMenu() {
  if (!mainAlive() || !miniWindow || miniWindow.isDestroyed()) return
  let info = null
  try {
    info = await mainWindow.webContents.executeJavaScript(trackInfoScript)
  } catch (e) { return }
  if (!info || !info.ok) return

  // info.id is interpolated into scripts executed in the page; only allow the
  // catalog-id character set so a crafted id can't break out of the literal
  const idSafe = /^[A-Za-z0-9._-]+$/.test(info.id)

  const favoriteScript = (value) => `(async () => {
    const mk = MusicKit.getInstance();
    await mk.api.music('/v1/me/ratings/songs/${info.id}', {}, { fetchOptions: {
      method: '${value === null ? 'DELETE' : 'PUT'}',
      ${value === null ? '' : `body: JSON.stringify({ type: 'rating', attributes: { value: ${value} } }),`}
      headers: { 'Content-Type': 'application/json' }
    } });
  })()`
  const addToLibraryScript = `(async () => {
    const mk = MusicKit.getInstance();
    await mk.api.music('/v1/me/library', { 'ids[songs]': '${info.id}' }, { fetchOptions: { method: 'POST' } });
  })()`

  const menu = Menu.buildFromTemplate([
    { label: info.title || 'Not playing', enabled: false },
    { type: 'separator' },
    info.rating === 1
      ? { label: 'Undo Favorite', enabled: idSafe, click: () => musicApiCall(favoriteScript(null), 'undo favorite') }
      : { label: 'Favorite', enabled: idSafe, click: () => musicApiCall(favoriteScript(1), 'favorite') },
    { label: 'Add to Library', enabled: idSafe, click: () => musicApiCall(addToLibraryScript, 'add to library') },
    { type: 'separator' },
    { label: 'Copy Link', enabled: !!info.url, click: () => clipboard.writeText(info.url) },
    { label: 'Lyrics', click: toggleLyricsWindow },
    { type: 'separator' },
    {
      label: 'Always on Top',
      type: 'checkbox',
      checked: settings.miniAlwaysOnTop,
      click: (item) => {
        settings.miniAlwaysOnTop = item.checked
        if (miniWindow && !miniWindow.isDestroyed()) miniWindow.setAlwaysOnTop(item.checked)
        applyMiniKeepAbove(item.checked)
        saveSettings()
      }
    },
    { label: 'Open Full Player', click: toggleMiniPlayer }
  ])
  menu.popup({ window: miniWindow })
}

// On Wayland a window can't raise itself, so setAlwaysOnTop is a no-op
// there. KWin (KDE) exposes keep-above through its D-Bus scripting API;
// drive that as a fallback. Other Wayland compositors offer no client path.
function applyMiniKeepAbove(on) {
  if (process.platform !== 'linux' || !process.env.WAYLAND_DISPLAY) return
  if (!(process.env.XDG_CURRENT_DESKTOP || '').split(':').includes('KDE')) return
  const caption = appName + ' — Mini Player'
  const scriptPath = path.join(os.tmpdir(), 'sonata-keep-above.js')
  try {
    fs.writeFileSync(scriptPath,
      `for (const w of workspace.windowList()) if (w.caption === ${JSON.stringify(caption)}) w.keepAbove = ${on};`)
  } catch (e) { return }
  const scripting = '$Q org.kde.KWin /Scripting org.kde.kwin.Scripting'
  exec(
    `Q=$(command -v qdbus6 || command -v qdbus) && ` +
    `${scripting}.unloadScript sonata-keep-above >/dev/null 2>&1; ` +
    `id=$(${scripting}.loadScript ${scriptPath} sonata-keep-above) && ` +
    `$Q org.kde.KWin /Scripting/Script$id org.kde.kwin.Script.run && ` +
    `${scripting}.unloadScript sonata-keep-above`,
    (err) => { if (err) console.error('kwin keep-above failed:', err.message) }
  )
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
  else if (command === 'toggleFavorite') {
    if (mainAlive()) {
      mainWindow.webContents.executeJavaScript(toggleFavoriteScript)
        .then((res) => {
          if (res && res.ok && miniWindow && !miniWindow.isDestroyed()) {
            miniWindow.webContents.send('favorite-state', res)
          }
        })
        .catch((e) => console.error('toggle favorite failed:', e.message))
    }
  }
  else if (command === 'seek') {
    const seconds = Math.max(0, Number(value) || 0)
    if (mainAlive()) {
      mainWindow.webContents.executeJavaScript(`(() => { MusicKit.getInstance().seekToTime(${seconds}); })();`)
        .catch((e) => console.error('seek failed:', e.message))
    }
  }
  else if (command === 'setVolume') {
    const volume = Math.min(1, Math.max(0, Number(value) || 0))
    if (mainAlive()) {
      mainWindow.webContents.executeJavaScript(`(() => { MusicKit.getInstance().volume = ${volume}; })();`)
        .catch((e) => console.error('set volume failed:', e.message))
    }
  }
  else {
    playerCommand(command)
  }
})

// --- now-playing consumers: Last.fm scrobbling and Discord presence ---

async function notifyTrack(state) {
  if (!settings.notifications || !Notification.isSupported()) return
  let icon
  try {
    if (state.artwork) {
      const res = await fetch(state.artwork)
      icon = nativeImage.createFromBuffer(Buffer.from(await res.arrayBuffer()))
    }
  } catch (e) { /* no art */ }
  const body = state.artist + (state.album ? ' — ' + state.album : '')
  new Notification({ title: state.title, body, icon, silent: true }).show()
}

function startNowPlayingLoop() {
  setInterval(async () => {
    const wantLastfm = lastfm && lastfm.connected
    const wantDiscord = discordConfig.enabled && discordConfig.applicationId
    const wantNotify = settings.notifications
    if ((!wantLastfm && !wantDiscord && !wantNotify && !tray) || !mainAlive()) return
    let state
    try {
      state = await mainWindow.webContents.executeJavaScript(nowPlayingScript)
    } catch (e) {
      return
    }
    if (!state || !state.ok) return
    if (tray) updateTrayTooltip(state)
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
      .catch((e) => console.error('last.fm now playing failed:', e.message))
  }
  if (state.isPlaying) scrobbleState.playedSeconds += 5

  // last.fm rules: track longer than 30s, played for half its length or 4 minutes
  const needed = Math.min(scrobbleState.track.duration / 2, 240)
  if (!scrobbleState.scrobbled && scrobbleState.track.duration > 30 && scrobbleState.playedSeconds >= needed) {
    scrobbleState.scrobbled = true
    lastfm.scrobble(scrobbleState.track, scrobbleState.startedAt)
      .catch((e) => console.error('last.fm scrobble failed:', e.message))
  }
}

async function feedDiscord(state) {
  // reconnect roughly every 30s while Discord is unreachable
  if (!discord || !discord.ready) {
    if (discordReconnectTicks++ % 6 !== 0) return
    discord = new DiscordPresence(discordConfig.applicationId)
    try {
      await discord.connect()
      lastPresenceKey = ''
    } catch (e) {
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
  } catch (e) { /* keep defaults */ }
}

function saveDiscordConfig() {
  fs.writeFileSync(discordConfigPath, JSON.stringify(discordConfig, null, 2) + '\n')
}

async function connectDiscord() {
  const parent = mainWindow && mainWindow.isVisible() ? mainWindow : undefined
  loadDiscordConfig()
  if (!discordConfig.applicationId) {
    saveDiscordConfig()
    const { response } = await dialog.showMessageBox(parent, {
      type: 'info',
      title: 'Discord presence',
      message: 'Discord presence needs a (free) Discord application ID.',
      detail: '1. Create an application named "Sonata" at https://discord.com/developers/applications\n' +
              '2. Copy its Application ID into:\n' + discordConfigPath + '\n' +
              '3. Click "Connect Discord" in the tray menu again.',
      buttons: ['Open config file', 'Open Discord developer portal', 'Close']
    })
    if (response === 0) shell.openPath(discordConfigPath)
    if (response === 1) shell.openExternal('https://discord.com/developers/applications')
    return
  }
  discord = new DiscordPresence(discordConfig.applicationId)
  try {
    await discord.connect()
    discordConfig.enabled = true
    saveDiscordConfig()
    lastPresenceKey = ''
    refreshTrayMenu()
  } catch (e) {
    discord = null
    dialog.showMessageBox(parent, {
      type: 'error',
      title: 'Discord connection failed',
      message: e.message,
      detail: 'Make sure the Discord desktop app is running and the application ID in\n' +
              discordConfigPath + '\nis correct.'
    })
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
  refreshTrayMenu()
}

async function connectLastFm() {
  const parent = mainWindow && mainWindow.isVisible() ? mainWindow : undefined
  if (!lastfm.configured) {
    lastfm.writeTemplate()
    const { response } = await dialog.showMessageBox(parent, {
      type: 'info',
      title: 'Connect Last.fm',
      message: 'Last.fm needs your own (free) API credentials.',
      detail: '1. Create an API account at https://www.last.fm/api/account/create\n' +
              '2. Paste the API key and shared secret into:\n' + lastfm.configPath + '\n' +
              '3. Click "Connect Last.fm" in the tray menu again.',
      buttons: ['Open config file', 'Get API account', 'Close']
    })
    if (response === 0) shell.openPath(lastfm.configPath)
    if (response === 1) shell.openExternal('https://www.last.fm/api/account/create')
    return
  }
  try {
    const url = await lastfm.startAuth()
    shell.openExternal(url)
    const { response } = await dialog.showMessageBox(parent, {
      type: 'info',
      title: 'Connect Last.fm',
      message: 'Authorize this app in the browser window that just opened, then click Done.',
      buttons: ['Done', 'Cancel']
    })
    if (response !== 0) return
    await lastfm.finishAuth()
    refreshTrayMenu()
    dialog.showMessageBox(parent, {
      type: 'info',
      title: 'Last.fm connected',
      message: `Scrobbling as ${lastfm.username}.`
    })
  } catch (e) {
    dialog.showMessageBox(parent, {
      type: 'error',
      title: 'Last.fm connection failed',
      message: e.message,
      detail: 'Check the API key and secret in ' + lastfm.configPath
    })
  }
}

// --- settings window ---

function createSettingsWindow() {
  if (settingsWindow) { settingsWindow.focus(); return }
  settingsWindow = new BrowserWindow({
    width: 460, height: 560, resizable: false,
    title: appName + ' — Settings',
    autoHideMenuBar: true,
    webPreferences: { nodeIntegration: true, contextIsolation: false }
  })
  settingsWindow.loadFile('settings.html')
  lockDownLocalWindow(settingsWindow)
  settingsWindow.on('closed', () => { settingsWindow = null })
}

ipcMain.handle('settings:get', () => ({
  ...settings,
  version: app.getVersion(),
  appImage: !!appImagePath,
  lastfmConnected: !!(lastfm && lastfm.connected),
  lastfmUser: lastfm ? lastfm.username : '',
  discordEnabled: !!discordConfig.enabled
}))

ipcMain.on('settings:set', (event, key, value) => {
  if (!(key in settings)) return
  settings[key] = value
  saveSettings()
  if (key === 'launchAtLogin' || key === 'startMinimized') applyAutostart()
})

ipcMain.on('settings:action', async (event, action) => {
  if (action === 'connectLastfm') await connectLastFm()
  else if (action === 'disconnectLastfm') { if (lastfm) lastfm.disconnect() }
  else if (action === 'connectDiscord') await connectDiscord()
  else if (action === 'disconnectDiscord') disconnectDiscord()
  refreshTrayMenu()
  if (settingsWindow && !settingsWindow.isDestroyed()) settingsWindow.webContents.send('settings:refresh')
})

// --- tray ---

function updateTrayTooltip(state) {
  const text = state.title
    ? state.title + ' — ' + state.artist + (state.isPlaying ? '' : ' (paused)')
    : appName
  if (text === trayTooltip) return
  trayTooltip = text
  tray.setToolTip(text)
}

function refreshTrayMenu() {
  const lastfmItem = lastfm && lastfm.connected
    ? { label: `Disconnect Last.fm (${lastfm.username})`, click: () => { lastfm.disconnect(); refreshTrayMenu() } }
    : { label: 'Connect Last.fm…', click: connectLastFm }
  const discordItem = discordConfig.enabled
    ? { label: 'Disconnect Discord', click: disconnectDiscord }
    : { label: 'Connect Discord…', click: connectDiscord }
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Show / Hide', click: toggleWindow },
    { label: 'Mini Player', click: toggleMiniPlayer },
    { label: 'Visualizer', click: toggleVisualizer },
    { type: 'separator' },
    { label: 'Play / Pause', click: () => playerCommand('playPause') },
    { label: 'Next', click: () => playerCommand('next') },
    { label: 'Previous', click: () => playerCommand('previous') },
    { type: 'separator' },
    { label: 'Toggle Dark Mode', click: toggleTheme },
    lastfmItem,
    discordItem,
    { type: 'separator' },
    { label: 'Check for Updates…', click: () => checkForUpdates(true) },
    { label: 'Settings…', click: createSettingsWindow },
    { label: 'Quit', click: () => app.exit(0) }
  ]))
}

function createTray() {
  const icon = nativeImage.createFromPath(path.join(__dirname, 'sonata.png'))
    .resize({ width: 22, height: 22 })
  tray = new Tray(icon)
  tray.setToolTip(appName)
  refreshTrayMenu()
  tray.on('click', toggleWindow)
}

const appUrl = 'https://music.apple.com/'

const customCss =
  '.web-navigation__native-upsell {display: none !important;}'

function createWindow() {
  Menu.setApplicationMenu(null)

  const b = settings.windowBounds
  const opts = {
    width: 1000, height: 600, minWidth: 800, minHeight: 500,
    show: !(settings.startMinimized || process.argv.includes('--hidden')),
    title: appName
  }
  if (b && b.width >= 800 && b.height >= 500) {
    Object.assign(opts, { width: b.width, height: b.height })
    if (Number.isInteger(b.x) && Number.isInteger(b.y)) { opts.x = b.x; opts.y = b.y }
  }
  mainWindow = new BrowserWindow(opts)
  mainWindow.loadURL(appUrl + locale.toLowerCase() + '/browse')

  // remember size/position across launches (debounced)
  const rememberBounds = () => {
    if (!mainAlive() || mainWindow.isMinimized() || mainWindow.isFullScreen()) return
    clearTimeout(saveBoundsTimer)
    saveBoundsTimer = setTimeout(() => {
      if (mainAlive() && mainWindow.isVisible()) { settings.windowBounds = mainWindow.getBounds(); saveSettings() }
    }, 500)
  }
  mainWindow.on('resize', rememberBounds)
  mainWindow.on('move', rememberBounds)

  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (input.type === 'keyUp' && input.control && input.key.toLowerCase() === 'r') {
      mainWindow.reload();
    }
    else if (input.type === 'keyUp' && input.control && input.key.toLowerCase() === 'd') {
      toggleTheme()
    }
    else if (input.type === 'keyUp' && input.control && input.key.toLowerCase() === 'm') {
      toggleMiniPlayer()
    }
    else if (input.type === 'keyUp' && input.control && input.shift && input.key.toLowerCase() === 'v') {
      toggleVisualizer()
    }
    else if (input.type === 'keyUp' && input.alt && input.key === 'ArrowLeft') {
      if (mainWindow.webContents.navigationHistory.canGoBack()) {
        mainWindow.webContents.navigationHistory.goBack()
      }
    }
    else if (input.type === 'keyUp' && input.alt && input.key === 'ArrowRight') {
      if (mainWindow.webContents.navigationHistory.canGoForward()) {
        mainWindow.webContents.navigationHistory.goForward()
      }
    }
  })

  // back/forward mouse buttons
  mainWindow.on('app-command', (event, command) => {
    if (command === 'browser-backward' && mainWindow.webContents.navigationHistory.canGoBack()) {
      mainWindow.webContents.navigationHistory.goBack()
    }
    else if (command === 'browser-forward' && mainWindow.webContents.navigationHistory.canGoForward()) {
      mainWindow.webContents.navigationHistory.goForward()
    }
  })

  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith(appUrl)) {
      event.preventDefault()
      openExternalSafe(url)
    }
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    openExternalSafe(url)
    return { action: 'deny' }
  });

  mainWindow.webContents.on('did-navigate', () => {
    mainWindow.webContents.insertCSS(customCss)
  });

  mainWindow.webContents.on('page-title-updated', () => {
    mainWindow.webContents.insertCSS(customCss)
    mainWindow.setTitle(appName);
  });

  mainWindow.on("close", (e) => {
    // close-to-tray: hide instead of quitting (tray "Quit" bypasses via app.exit)
    if (settings.closeToTray && !shuttingDown) {
      e.preventDefault()
      mainWindow.hide()
      return
    }
    shuttingDown = true
    clearInterval(miniPoll)
    clearInterval(lyricsPoll)
    app.exit(0);
 });
}

// --- AppImage menu integration & self-update ---

const appImagePath = process.env.APPIMAGE || ''
const appId = 'io.github.MarcelineVPQ.Sonata'
const updateFeedUrl = 'https://github.com/MarcelineVPQ/apple-music-for-linux/releases/latest/download/latest-linux.yml'
let pendingUpdateVersion = null
let updateCheckBusy = false

// Running from an AppImage leaves no menu entry or icon behind; write the
// XDG pieces ourselves, and keep Exec pointed at the AppImage if it moves.
function integrateAppImage() {
  if (process.platform !== 'linux' || !appImagePath) return
  try {
    const share = path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'))
    const iconPath = path.join(share, 'icons', 'hicolor', '512x512', 'apps', appId + '.png')
    fs.mkdirSync(path.dirname(iconPath), { recursive: true })
    fs.writeFileSync(iconPath, fs.readFileSync(path.join(__dirname, 'sonata.png')))
    const entry =
      '[Desktop Entry]\nType=Application\nName=Sonata\n' +
      'Comment=Apple Music for Linux\n' +
      'Exec=' + JSON.stringify(appImagePath) + ' %U\n' +
      'Icon=' + appId + '\nTerminal=false\n' +
      'Categories=AudioVideo;Audio;Player;\n' +
      'StartupWMClass=apple-music-for-linux\n'
    const desktopPath = path.join(share, 'applications', appId + '.desktop')
    fs.mkdirSync(path.dirname(desktopPath), { recursive: true })
    let current = ''
    try { current = fs.readFileSync(desktopPath, 'utf8') } catch (e) {}
    if (current !== entry) fs.writeFileSync(desktopPath, entry)
  } catch (e) { console.error('menu integration failed:', e.message) }
}

function fetchText(url) {
  return new Promise((resolve, reject) => {
    const req = net.request(url)
    req.on('response', (res) => {
      if (res.statusCode !== 200) { reject(new Error('HTTP ' + res.statusCode)); return }
      let body = ''
      res.on('data', (chunk) => { body += chunk })
      res.on('end', () => resolve(body))
      res.on('error', reject)
    })
    req.on('error', reject)
    req.end()
  })
}

function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest)
    const fail = (e) => { file.close(() => fs.unlink(dest, () => {})); reject(e) }
    const req = net.request(url)
    req.on('response', (res) => {
      if (res.statusCode !== 200) { fail(new Error('HTTP ' + res.statusCode)); return }
      res.on('data', (chunk) => file.write(chunk))
      res.on('end', () => file.end(resolve))
      res.on('error', fail)
    })
    req.on('error', fail)
    req.end()
  })
}

// electron-builder publishes latest-linux.yml alongside each release's
// AppImage; top-level keys only (the indented per-file block is skipped)
function parseUpdateFeed(text) {
  const grab = (key) => {
    const m = text.match(new RegExp('^' + key + ':\\s*(.+)$', 'm'))
    return m ? m[1].trim() : ''
  }
  return { version: grab('version'), file: grab('path'), sha512: grab('sha512') }
}

function isNewerVersion(a, b) {
  const pa = a.split('.').map(Number), pb = b.split('.').map(Number)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0)
    if (d) return d > 0
  }
  return false
}

// Download the new AppImage next to the current one, verify, and swap it in
// place. The running instance keeps its mount of the old file; the new
// version takes over on the next launch.
async function checkForUpdates(interactive) {
  if (updateCheckBusy) return
  if (!appImagePath) {
    if (interactive) dialog.showMessageBox({
      type: 'info', title: 'Updates',
      message: 'Not running from an AppImage.',
      detail: 'Automatic updates only apply to the AppImage build; from a source checkout, update with git pull.'
    })
    return
  }
  updateCheckBusy = true
  try {
    const feed = parseUpdateFeed(await fetchText(updateFeedUrl))
    if (!feed.version || !feed.file || !isNewerVersion(feed.version, app.getVersion())) {
      if (interactive) dialog.showMessageBox({
        type: 'info', title: 'Updates', message: `You're up to date (v${app.getVersion()}).`
      })
      return
    }
    if (pendingUpdateVersion !== feed.version) {
      const url = `https://github.com/MarcelineVPQ/apple-music-for-linux/releases/download/v${feed.version}/${feed.file}`
      const tmp = appImagePath + '.update'
      await downloadFile(url, tmp)
      const digest = crypto.createHash('sha512').update(fs.readFileSync(tmp)).digest('base64')
      if (feed.sha512 && digest !== feed.sha512) {
        fs.unlinkSync(tmp)
        throw new Error('update checksum mismatch')
      }
      fs.chmodSync(tmp, 0o755)
      fs.renameSync(tmp, appImagePath)
      pendingUpdateVersion = feed.version
    }
    notifyUpdateReady(feed.version, interactive)
  } catch (e) {
    console.error('update check failed:', e.message)
    if (interactive) dialog.showMessageBox({ type: 'error', title: 'Update failed', message: e.message })
  } finally {
    updateCheckBusy = false
  }
}

function notifyUpdateReady(version, interactive) {
  if (interactive) {
    dialog.showMessageBox({
      type: 'info', title: 'Update ready',
      message: `Sonata v${version} is installed.`,
      detail: 'Restart to start using it.',
      buttons: ['Restart Now', 'Later'],
      defaultId: 0
    }).then(({ response }) => { if (response === 0) restartIntoUpdate() })
  } else if (Notification.isSupported()) {
    const note = new Notification({
      title: `Sonata v${version} is ready`,
      body: 'Update downloaded — click to restart into it.',
      icon: path.join(__dirname, 'sonata.png'),
      silent: true
    })
    note.on('click', restartIntoUpdate)
    note.show()
  }
}

function restartIntoUpdate() {
  shuttingDown = true
  // free the single-instance lock so the replacement doesn't see us and quit
  app.releaseSingleInstanceLock()
  spawn(appImagePath, [], { detached: true, stdio: 'ignore' }).unref()
  app.exit(0)
}

function startUpdateChecks() {
  if (!appImagePath) return
  setTimeout(() => checkForUpdates(false), 20 * 1000)
  setInterval(() => checkForUpdates(false), 2 * 60 * 60 * 1000)
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
  } catch (e) { console.error('autostart update failed:', e.message) }
}

// single instance: launching Sonata again just surfaces the running copy
if (!app.requestSingleInstanceLock()) {
  app.exit(0)
}
app.on('second-instance', () => {
  if (miniWindow && !miniWindow.isDestroyed()) {
    miniWindow.show()
    miniWindow.focus()
  } else if (mainWindow && !mainWindow.isDestroyed()) {
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.show()
    mainWindow.focus()
  }
})

app.whenReady().then(async () => {
  await components.whenReady()
  initLocaleAndTheme()
  lastfm = new LastFm(path.join(app.getPath('userData'), 'lastfm.json'))
  discordConfigPath = path.join(app.getPath('userData'), 'discord.json')
  loadDiscordConfig()
  settingsPath = path.join(app.getPath('userData'), 'settings.json')
  loadSettings()
  applyAutostart()
  integrateAppImage()
  createWindow()
  createTray()
  startNowPlayingLoop()
  startUpdateChecks()
  if (process.argv.includes('--mini')) {
    toggleMiniPlayer()
  }
  if (process.argv.includes('--viz')) {
    toggleVisualizer()
  }
  if (process.argv.includes('--settings')) {
    createSettingsWindow()
  }
  if (process.argv.includes('--lyrics')) {
    toggleLyricsWindow()
  }
  app.on('activate', function () {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', function () {
  if (process.platform !== 'darwin') app.quit()
})