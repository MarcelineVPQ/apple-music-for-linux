const { app, BrowserWindow, Menu, Tray, shell, nativeTheme, nativeImage, ipcMain, dialog, clipboard, components } = require('electron')
const fs = require('fs');
const path = require('path');
const { LastFm } = require('./lastfm');
const { DiscordPresence } = require('./discord');

const appName = 'Apple Music'

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
    alwaysOnTop: true,
    title: appName,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    }
  })
  miniWindow.loadFile('miniplayer.html')
  lockDownLocalWindow(miniWindow)

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
  lyricsWindow = new BrowserWindow({
    width: 380,
    height: 560,
    frame: false,
    transparent: true,
    hasShadow: false,
    alwaysOnTop: true,
    title: appName + ' — Lyrics',
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    }
  })
  lyricsWindow.loadFile('lyrics.html')
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
    { label: 'Open Full Player', click: toggleMiniPlayer }
  ])
  menu.popup({ window: miniWindow })
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

function startNowPlayingLoop() {
  setInterval(async () => {
    const wantLastfm = lastfm && lastfm.connected
    const wantDiscord = discordConfig.enabled && discordConfig.applicationId
    if ((!wantLastfm && !wantDiscord) || !mainAlive()) return
    let state
    try {
      state = await mainWindow.webContents.executeJavaScript(nowPlayingScript)
    } catch (e) {
      return
    }
    if (!state || !state.ok) return
    if (wantLastfm && state.title) feedScrobbler(state)
    if (wantDiscord) feedDiscord(state)
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
      detail: '1. Create an application named "Apple Music" at https://discord.com/developers/applications\n' +
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

// --- tray ---

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
    { type: 'separator' },
    { label: 'Play / Pause', click: () => playerCommand('playPause') },
    { label: 'Next', click: () => playerCommand('next') },
    { label: 'Previous', click: () => playerCommand('previous') },
    { type: 'separator' },
    { label: 'Toggle Dark Mode', click: toggleTheme },
    lastfmItem,
    discordItem,
    { type: 'separator' },
    { label: 'Quit', click: () => app.exit(0) }
  ]))
}

function createTray() {
  const icon = nativeImage.createFromPath(path.join(__dirname, 'apple-music-for-linux.png'))
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

  mainWindow = new BrowserWindow({
    width: 1000,
    height: 600,
    minWidth: 800,
    minHeight: 500,
    title: appName
  })
  mainWindow.loadURL(appUrl + locale.toLowerCase() + '/browse')

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

  mainWindow.on("close", () => {
    shuttingDown = true
    clearInterval(miniPoll)
    clearInterval(lyricsPoll)
    app.exit(0);
 });
}

app.whenReady().then(async () => {
  await components.whenReady()
  initLocaleAndTheme()
  lastfm = new LastFm(path.join(app.getPath('userData'), 'lastfm.json'))
  discordConfigPath = path.join(app.getPath('userData'), 'discord.json')
  loadDiscordConfig()
  createWindow()
  createTray()
  startNowPlayingLoop()
  if (process.argv.includes('--mini')) {
    toggleMiniPlayer()
  }
  app.on('activate', function () {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', function () {
  if (process.platform !== 'darwin') app.quit()
})