const { app, BrowserWindow, Menu, Tray, shell, nativeTheme, nativeImage, ipcMain, dialog, clipboard, Notification, components, net } = require('electron')
const fs = require('fs');
const path = require('path');
const os = require('os');
const { exec, spawn, execFileSync } = require('child_process');
const { extractPalette } = require('./palette');
const { LastFm } = require('./lastfm');
const { DiscordPresence } = require('./discord');
const { Visualizer, RATE: VIZ_RATE } = require('./visualizer');
const { createListenSession } = require('./listen-session')
const alignSessionLib = require('./align-session')
const alignHelperLib = require('./align-helper')
const { createCssReplacer } = require('./css-replacer');
const updateFeed = require('./update-feed');
const railModel = require('./rail-model');

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
let lyricsRetry = null  // { key, attempt, at } after a failed lyrics lookup
let lyricsArt = ''
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
let visualizer = null
let vizListener = null   // Sonata's own stream for the visualizer (audio-listen.js)
let vizArt = ''
let settings = { notifications: true, closeToTray: false, launchAtLogin: false, startMinimized: false, windowBounds: null, miniAlwaysOnTop: true, lyricsAlwaysOnTop: true, adaptiveColor: true, lrclibFallback: true, lyricsArtSpin: false, lyricsArtSpinSpeed: 'relaxed', estimatedWordTiming: true, lyricsListenRefine: false, lyricsPreciseTiming: false, updateChannel: 'stable', railPinned: false, railLocked: false }
let lastPalette = null
let lastPaletteKey = null
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
// loop: lyrics-window bounds save · 500 ms one-shot debounce · runs only after a move/resize · stops after firing · cost ~0
// lifetime: resize/move listeners live on the window and die with it; the timer checks isDestroyed() first
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
// lifetime: one setWindowOpenHandler + one will-navigate listener per local window; both die with the window
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
  pushRail()
  // give KWin a moment to map the window before asking it to keep it above
  // loop: mini keep-above · 300 ms one-shot · runs once per mini open · stops after firing · cost one qdbus exec (KDE Wayland only)
  if (settings.miniAlwaysOnTop) setTimeout(() => applyMiniKeepAbove(true), 300)

  // the lyrics and visualizer shortcuts work in the mini player too (shown in its "More" menu)
  // lifetime: registered once per mini window, dies with its webContents
  miniWindow.webContents.on('before-input-event', (event, input) => { viewShortcut(input) })

  miniWindow.webContents.once('did-finish-load', () => {
    miniTrackKey = ''
    if (lastPalette) miniWindow.webContents.send('palette', lastPalette)
    // loop: mini player now-playing poll · 1000 ms · runs while the mini window exists (also when minimized or paused) · stops on mini 'closed' (and main 'close') · cost 1 executeJavaScript/s into the page + 1 IPC send; measured 0.04-0.05 % of one core in the main process (docs/PERFORMANCE.md). Left as is: only runs while the mini player is open; polling on while minimized costs the same, not worth a code change.
    // error: a failing executeJavaScript (page mid-navigation) is skipped until the next tick; at 1/s that can't hammer, and a reload ends it
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
        if (state && state.ok) refreshPalette(state)
      } catch (e) { /* page mid-navigation; try again next tick */ }
    }, 1000)
  })

  // lifetime: the 'closed' handler nulls miniWindow and clears miniPoll, so no closure keeps the destroyed window alive
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
    // Word timing lives in /syllable-lyrics (what Apple's web player uses);
    // /lyrics has line timing only, so it's the fallback.
    const get = async (kind) => {
      try {
        const res = await mk.api.music('/v1/catalog/{{storefront}}/songs/' + id + '/' + kind);
        const data = res && res.data && res.data.data && res.data.data[0];
        const a = (data && data.attributes) || {};
        const t = a.ttml || a.ttmlLocalizations;
        return typeof t === 'string' ? t : '';
      } catch (e) { return ''; }
    };
    const ttml = (await get('syllable-lyrics')) || (await get('lyrics'));
    return { ok: true, ttml };
  } catch (e) {
    return { ok: true, ttml: '' };
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
             duration: a.durationInMillis ? a.durationInMillis / 1000 : 0 };
  } catch (e) { return { ok: false }; }
})()`

// Clicks a link to the playing song's album already in the page (now-playing bar, lists), found
// through shadow roots. Album id from the song's catalog URL (…/album/name/123?i=456) or its container.
const showAlbumScript = `(() => {
  try {
    const item = MusicKit.getInstance().nowPlayingItem;
    if (!item) return false;
    const m = String((item.attributes && item.attributes.url) || '').match(/\\/album\\/[^/]*\\/?(\\d+)/);
    const id = m ? m[1] : (item.container && item.container.type === 'albums' ? String(item.container.id) : '');
    if (!id) return false;
    const re = new RegExp('/album/(?:[^/?#]*/)?' + id + '(?:[?#]|$)');
    const walk = (root, depth) => {
      if (depth > 25) return null;
      for (const a of root.querySelectorAll('a[href*="/album/"]')) if (re.test(a.getAttribute('href'))) return a;
      for (const el of root.querySelectorAll('*')) {
        if (el.shadowRoot) { const hit = walk(el.shadowRoot, depth + 1); if (hit) return hit; }
      }
      return null;
    };
    const link = walk(document, 0);
    if (link) link.click();
    return !!link;
  } catch (e) { return false; }
})()`

const lyricsSources = require('./lyrics-sources')

// Apple first, then LRCLIB (Settings → LRCLIB lyrics). net.fetch goes through
// Chromium's network stack, like the rest of the app.
// lyrics cache on disk (created in app 'ready', when userData is known)
let lyricsStore = null
const getLyrics = lyricsSources.createLyricsResolver({
  fetchApple: async (state) => {
    const res = await mainWindow.webContents.executeJavaScript(state.queueOffset ? lyricsFetchScriptFor(state.queueOffset) : lyricsFetchScript)
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
    const next = await mainWindow.webContents.executeJavaScript(nextItemScript)
    if (next && next.ok && next.title) await getLyrics(Object.assign(next, { queueOffset: 1 }))
  } catch (e) { /* prefetch is best effort */ }
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
  } catch (e) {
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
// spawned for a job, quits after 2 min idle and is killed on setting off and quit (align-helper.js).
// error: helper not installed, crashing or refusing -> one log line, the song keeps its current timing
// The install is checked at start and whenever Settings asks (install.sh runs outside Sonata), not
// per poll tick.
let alignPaths = null
let alignInstalledNow = false
let alignHelper = null
let alignSession = null
function alignInstalled(recheck) {
  if (recheck || !alignPaths) {
    // one object, updated in place: the helper client reads it at its next spawn
    alignPaths = Object.assign(alignPaths || {}, alignHelperLib.helperPaths(process.env, __dirname))
    alignInstalledNow = alignHelperLib.isInstalled(alignPaths)
  }
  return alignInstalledNow
}
function getAlignHelper() {
  alignInstalled()
  if (!alignHelper) alignHelper = alignHelperLib.createAlignHelper({ paths: alignPaths, log: (m) => console.log('align:', m) })
  return alignHelper
}
function preciseTimingOn() { return !!settings.lyricsPreciseTiming && alignInstalled() }
function getAlignSession() {
  if (!alignSession) {
    alignSession = alignSessionLib.createAlignSession({
      createListener: getSharedListener(),
      helper: getAlignHelper(),
      store: { get: (k) => (lyricsStore ? lyricsStore.get(k) : null), set: (k, v) => { if (lyricsStore) lyricsStore.set(k, v) } },
      send: sendLyrics,
      now: () => performance.now(),
      log: (m) => console.log('align:', m)
    })
  }
  return alignSession
}

// --- lyrics feed: one now-playing poll for every lyric view (lyrics window, visualizer overlay) ---
// Both views run the same engine (lyrics-view.js), so they get the same data: 'lyrics-data' (full
// line/word objects with estimated + learned timing), 'lyrics-time' pushes, 'lyrics-refined' and
// 'lyrics-art'. The visualizer also gets 'viz-nowplaying' (large art), and its audio is run from here.
function lyricViews() {
  return [lyricsWindow, vizWindow].filter((w) => w && !w.isDestroyed())
}
function sendLyrics(channel, ...args) {
  for (const w of lyricViews()) w.webContents.send(channel, ...args)
}
// a view joined (its page just loaded): resend the song and the art on the next tick
function startLyricsFeed() {
  lyricsKey = null
  lyricsArt = null
  vizArt = null
  // loop: lyrics now-playing poll · 500 ms · runs while the lyrics window or the visualizer exists (also when minimized or paused) · stops when the last of them closes (stopLyricsFeedIfIdle; and main 'close') · cost 2 executeJavaScript/s + 1 IPC send per view per tick; one lyrics lookup per track change (cached, see lyrics-sources.js). One poll for both views (the visualizer had its own 300 ms poll before 0.15.22).
  if (!lyricsPoll) lyricsPoll = setInterval(lyricsTick, 500)
}
function stopLyricsFeedIfIdle() {
  if (lyricViews().length) return
  clearInterval(lyricsPoll)
  lyricsPoll = null
  lyricsRetry = null
  if (listenSession) listenSession.stop()
  if (alignSession) alignSession.stop(true)   // a song heard to the end is still aligned
}

// error: a failing executeJavaScript returns early until the next tick; at 2/s that can't hammer
async function lyricsTick() {
  if (!mainAlive() || !lyricViews().length) return
  let state
  try {
    state = await mainWindow.webContents.executeJavaScript(nowPlayingScript)
  } catch (e) { return }
  if (!state || !state.ok || !lyricViews().length) return

  const key = state.title + '|' + state.artist
  // loop: lyrics retry · when the lyrics service failed (busy/offline), refetch the same song after
  // 30 s, 60 s, then every 120 s · only while a lyric view is open and the song unchanged ·
  // stops on success, track change or when the last view closes · cost one lookup per retry
  // error: backoff capped at 120 s, so a down service is never hammered
  const retryDue = lyricsRetry && lyricsRetry.key === key && Date.now() >= lyricsRetry.at
  if (key !== lyricsKey || retryDue) {
    lyricsKey = key
    const got = state.title ? await getLyrics(state) : { lines: [], source: '' }
    if (got.error) {
      const attempt = lyricsRetry && lyricsRetry.key === key ? lyricsRetry.attempt + 1 : 0
      lyricsRetry = { key, attempt, at: Date.now() + [30, 60, 120][Math.min(attempt, 2)] * 1000 }
    } else {
      lyricsRetry = null
      prefetchNextLyrics(key)
    }
    // word timing is chosen here, by priority: Apple/LRC word timing (never touched) > aligned on
    // this PC (Level 2) > refined by listening (Level 1) > estimated. Estimation is the same
    // lyrics-timing call the views would make, so main knows which lines are estimated.
    const precise = preciseTimingOn()
    const aligner = precise ? getAlignSession() : alignSession
    if (aligner) aligner.setLyrics(key, state.title, state.artist, got.lines || [], precise)
    const prep = alignSessionLib.prepareLines(got.lines || [], {
      estimate: !!settings.estimatedWordTiming,
      entry: precise ? aligner.entryFor(state.title, state.artist, got.lines || []) : null
    })
    let lines = prep.lines
    let refined = false
    if (settings.estimatedWordTiming) {
      const session = settings.lyricsListenRefine ? getListenSession() : listenSession
      if (session) ({ lines, refined } = session.setLyrics(key, state.title, state.artist, lines, !!settings.lyricsListenRefine))
    } else if (listenSession) listenSession.stop()
    sendLyrics('lyrics-data', { title: state.title, artist: state.artist, album: state.album, duration: state.duration, lines, source: got.source, lang: got.lang || '', status: got.error || '', estimate: !!settings.estimatedWordTiming, refined, aligned: prep.aligned })
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
  // isPlaying lets the views stop their word-highlight clock right away on pause
  sendLyrics('lyrics-time', state.playbackTime, state.isPlaying)
  if (listenSession) listenSession.tick(state.playbackTime, state.isPlaying, !!settings.lyricsListenRefine)
  if (alignSession) alignSession.tick(state.playbackTime, state.isPlaying, preciseTimingOn())
  vizAudioTick(state.isPlaying)
  refreshPalette(state)
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
  pushRail()

  lyricsWindow.webContents.once('did-finish-load', () => {
    lyricsWindow.webContents.send('lyrics-settings', { spin: !!settings.lyricsArtSpin, speed: settings.lyricsArtSpinSpeed })
    startLyricsFeed()
    if (lastPalette) lyricsWindow.webContents.send('palette', lastPalette)
    // loop: lyrics keep-above · 300 ms one-shot · once per lyrics open · stops after firing · cost one qdbus exec (KDE Wayland only)
    if (settings.lyricsAlwaysOnTop) setTimeout(() => applyLyricsKeepAbove(true), 300)
  })

  // lifetime: 'closed' nulls lyricsWindow; the feed stops when no lyric view is left
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

// lifetime: every ipcMain.on / ipcMain.handle in this file is registered once at module load, never per window open (measured: counts stay at 1 after 20 open/close cycles of each window)
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
    mainWindow.webContents.executeJavaScript(showAlbumScript)
      .catch((e) => console.error('show album failed:', e.message))
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
  pushRail()

  // lifetime: one Visualizer (FFT) and one handle on the shared own-stream listener (the one parec,
  // see getSharedListener) per visualizer window; both stopped and dropped on 'closed'
  visualizer = new Visualizer((bands) => {
    if (vizWindow && !vizWindow.isDestroyed()) vizWindow.webContents.send('viz-bands', bands)
  })
  vizListener = getSharedListener()({ sampleRate: VIZ_RATE, onChunk: (mid) => { if (visualizer) visualizer.push(mid) } })

  // the lyrics feed drives the overlay's lyrics, its now-playing and its audio (vizAudioTick)
  vizWindow.webContents.once('did-finish-load', () => {
    startLyricsFeed()
    if (lastPalette) vizWindow.webContents.send('palette', lastPalette)   // album accent for the sung word
  })

  // lifetime: 'closed' stops the listener handle (the parec ends when no other user listens) and the
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
// loop: spectrum stream · ~43 frames/s from parec · runs while the visualizer exists and the song
// plays (fallback: while the visualizer exists) · stops on pause (listener) and on viz 'closed' ·
// cost one 1024-point FFT + one IPC send per frame
function vizAudioTick(isPlaying) {
  if (!vizListener || !visualizer || visualizer.proc) return   // proc: on the system-monitor fallback
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
const VISUALIZER_KEY = 'Ctrl+Shift+V'
const MINI_KEY = 'Ctrl+M'   // handled in the main window's before-input-event; a label for the rail
function viewShortcut(input) {
  if (input.type !== 'keyUp' || !input.control || !input.shift || input.alt) return false
  const key = input.key.toLowerCase()
  if (key === 'l') toggleLyricsWindow()
  else if (key === 'v') toggleVisualizer()
  else return false
  return true
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

  // lifetime: a fresh Menu per "More" click; nothing keeps it after the popup closes, so it is garbage-collected
  const menu = Menu.buildFromTemplate([
    { label: info.title || 'Not playing', enabled: false },
    { type: 'separator' },
    info.rating === 1
      ? { label: 'Undo Favorite', enabled: idSafe, click: () => musicApiCall(favoriteScript(null), 'undo favorite') }
      : { label: 'Favorite', enabled: idSafe, click: () => musicApiCall(favoriteScript(1), 'favorite') },
    { label: 'Add to Library', enabled: idSafe, click: () => musicApiCall(addToLibraryScript, 'add to library') },
    { type: 'separator' },
    { label: 'Copy Link', enabled: !!info.url, click: () => clipboard.writeText(info.url) },
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
        if (settingsWindow && !settingsWindow.isDestroyed()) settingsWindow.webContents.send('settings:refresh')
      }
    },
    { label: 'Open Full Player', click: toggleMiniPlayer }
  ])
  menu.popup({ window: miniWindow })
}

// On Wayland a window can't raise itself, so setAlwaysOnTop is a no-op
// there. KWin (KDE) exposes keep-above through its D-Bus scripting API;
// drive that as a fallback. Other Wayland compositors offer no client path.
// lifetime: one short-lived qdbus child per call (window open / setting change), never on a timer
function applyKeepAbove(caption, scriptId, on) {
  if (process.platform !== 'linux' || !process.env.WAYLAND_DISPLAY) return
  if (!(process.env.XDG_CURRENT_DESKTOP || '').split(':').includes('KDE')) return
  const scriptPath = path.join(os.tmpdir(), scriptId + '.js')
  try {
    fs.writeFileSync(scriptPath,
      `for (const w of workspace.windowList()) if (w.caption === ${JSON.stringify(caption)}) w.keepAbove = ${on};`)
  } catch (e) { return }
  const scripting = '$Q org.kde.KWin /Scripting org.kde.kwin.Scripting'
  exec(
    `Q=$(command -v qdbus6 || command -v qdbus) && ` +
    `${scripting}.unloadScript ${scriptId} >/dev/null 2>&1; ` +
    `id=$(${scripting}.loadScript ${scriptPath} ${scriptId}) && ` +
    `$Q org.kde.KWin /Scripting/Script$id org.kde.kwin.Script.run && ` +
    `${scripting}.unloadScript ${scriptId}`,
    (err) => { if (err) console.error('kwin keep-above failed:', err.message) }
  )
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
  try { text = fs.readFileSync(rulesFile, 'utf8') } catch (e) { return }
  if (!text.includes('Sonata:remember-position')) return
  const remove = []
  const re = /\[([0-9a-fA-F-]{36})\]\n([\s\S]*?)(?=\n\[|$)/g
  let m
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
    exec('Q=$(command -v qdbus6 || command -v qdbus) && $Q org.kde.KWin /KWin reconfigure', () => {})
  } catch (e) {}
}

// --- adaptive album-art color ---
function broadcastPalette(p) {
  for (const w of [miniWindow, lyricsWindow, vizWindow]) {
    if (w && !w.isDestroyed()) w.webContents.send('palette', p)
  }
  pushRail()   // the rail's glass takes the accent too
}
// lifetime: called from the mini/lyrics polls and (for the rail's tint) the 5 s tick while the main
// window is shown, never in tray-only state. One artwork fetch +
// nativeImage per track change (keyed by title|artist); the buffer and image are locals, only the
// small { accent, bg, bg2, hue } object survives in lastPalette. Nothing accumulates per track.
async function refreshPalette(state) {
  if (!settings.adaptiveColor) {
    if (lastPalette !== null) { lastPalette = null; lastPaletteKey = null; broadcastPalette(null) }
    return
  }
  const key = (state.title || '') + '|' + (state.artist || '')
  if (key === lastPaletteKey) return
  lastPaletteKey = key
  const url = state.artworkLarge || state.artwork
  if (!url) { lastPalette = null; broadcastPalette(null); return }
  try {
    const res = await fetch(url)
    const img = nativeImage.createFromBuffer(Buffer.from(await res.arrayBuffer())).resize({ width: 32, height: 32 })
    lastPalette = extractPalette(img.toBitmap(), { bgra: true })
    broadcastPalette(lastPalette)
  } catch (e) { /* keep previous palette */ }
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

// lifetime: one artwork fetch + nativeImage + Notification per track change while playing; none are
// stored, so they're collected after display. No listeners are attached to the Notification.
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
  // loop: tray / notifications / Last.fm / Discord now-playing poll · 5000 ms · runs always (the tray
  // always exists, so the guard below never short-circuits) — this is the ONLY recurring work in the
  // tray-only state · stops on app exit · cost 1 executeJavaScript every 5 s; measured 0.03-0.06 % of one
  // core in the main process (docs/PERFORMANCE.md). Left as is: tray tooltip, track-change notifications,
  // scrobble timing (playedSeconds += 5 per tick) and Discord presence all need it.
  // error: a failing executeJavaScript skips to the next tick; at 1 per 5 s it can't hammer
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
    // the rail's album tint (one artwork fetch per track change, while the main window shows) and
    // its status dots (Discord reconnecting, the align helper starting/stopping): sent on change only
    if (railMounted && mainWindow.isVisible()) refreshPalette(state)
    pushRail()
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
  // lifetime: user-initiated only (Settings / tray); see feedDiscord for the reconnect path
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
  settingsWindow.on('closed', () => { settingsWindow = null; pushRail() })
  pushRail()
}

ipcMain.handle('settings:get', () => ({
  ...settings,
  version: app.getVersion(),
  appImage: !!appImagePath,
  lastfmConnected: !!(lastfm && lastfm.connected),
  lastfmUser: lastfm ? lastfm.username : '',
  discordEnabled: !!discordConfig.enabled,
  alignInstalled: alignInstalled(true)
}))

// Settings status line for precise word timing: spawns the helper (if needed) and pings it
ipcMain.handle('align:status', async () => {
  if (!alignInstalled()) return { ok: false, message: 'not installed' }
  try {
    const pong = await getAlignHelper().ping()
    console.log('align: helper ready (' + (pong.device || '?') + (pong.gpu ? ', ' + pong.gpu : '') + ', v' + (pong.version || '?') + ')')
    return { ok: true, device: pong.device, gpu: pong.gpu || '', version: pong.version || '', models: pong.models || {} }
  } catch (e) {
    console.log('align: helper not answering: ' + e.message)
    return { ok: false, message: e.message }
  }
})

ipcMain.on('settings:set', (event, key, value) => {
  if (!(key in settings)) return
  settings[key] = value
  saveSettings()
  if (key === 'launchAtLogin' || key === 'startMinimized') applyAutostart()
  else if (key === 'adaptiveColor') {
    if (value) { lastPaletteKey = null; if (lastPalette) broadcastPalette(lastPalette) }  // re-extract next poll
    else { lastPalette = null; lastPaletteKey = null; broadcastPalette(null) }
  }
  else if (key === 'updateChannel') {
    // a switch re-checks at once on the new channel (AppImage builds only)
    if (value !== 'stable' && value !== 'dev') { settings.updateChannel = 'stable'; saveSettings() }
    pendingUpdateVersion = null
    checkForUpdates(false)
  }
  else if (key === 'lyricsArtSpin' || key === 'lyricsArtSpinSpeed') {
    if (lyricsWindow && !lyricsWindow.isDestroyed()) lyricsWindow.webContents.send('lyrics-settings', { spin: !!settings.lyricsArtSpin, speed: settings.lyricsArtSpinSpeed })
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
    }
  }
  else if (key === 'lyricsAlwaysOnTop') {
    if (lyricsWindow && !lyricsWindow.isDestroyed()) {
      lyricsWindow.setAlwaysOnTop(value)
      applyLyricsKeepAbove(value)
    }
  }
  pushRail()   // precise timing, the update channel and the pin show in the rail
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

// lifetime: builds a new Menu on user actions only (connect/disconnect); setContextMenu drops the
// previous Menu, which is then collected. The Tray itself is created once.
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
    { label: 'Check for Updates…', click: () => checkForUpdates(true) },
    { label: 'Settings…', click: createSettingsWindow },
    { label: 'Quit', click: () => app.exit(0) }
  ]))
  pushRail()   // Last.fm / Discord connected or not
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

// Our CSS for Apple's page: the native-app upsell hidden, plus the rail's room (Apple's layout
// narrowed by the rail's width, rail-model.js roomCss) once the rail is up in this document.
const baseCss = '.web-navigation__native-upsell {display: none !important;}'
const customCss = () => baseCss + (railMounted ? railModel.roomCss(railRoom) : '')
let applyCustomCss = () => {}

// --- navigation rail in the main window (rail-model.js, rail-ui.js, rail.css, preload-rail.js) ---
// The rail lives in Apple's page, in a closed shadow root, run in the preload's isolated world.
// Main owns its state (which windows are open, the pin, connections, the album accent) and sends
// it only when it changes; the rail sends back command names, checked here.
let railMounted = false   // the rail said 'mounted' in the current document
let railRoom = 0          // px of the window the rail takes from Apple's page (applied CSS)
let railSent = ''         // the last state sent, as JSON
let railCode = null       // the scripts injected per page load (read once)
function railScripts() {
  if (!railCode) {
    const read = (f) => fs.readFileSync(path.join(__dirname, f), 'utf8')
    railCode = [
      { code: 'globalThis.SONATA_RAIL_CSS = ' + JSON.stringify(read('rail.css')) + ';' },
      { code: read('rail-model.js') },
      { code: read('rail-ui.js') }
    ]
  }
  return railCode
}
// error: an injection that fails (page torn down mid-load) is logged; the next load injects again,
// and without 'mounted' Apple's page keeps its full width (no empty strip)
function injectRail() {
  if (!mainAlive()) return
  try {
    mainWindow.webContents.executeJavaScriptInIsolatedWorld(999, railScripts())
      .catch((e) => console.error('rail: inject failed:', e.message))
  } catch (e) { console.error('rail: inject failed:', e.message) }
}
function railPrecise() {
  if (!settings.lyricsPreciseTiming) return 'off'
  if (!alignInstalled()) return 'missing'
  return alignHelper && alignHelper.running ? 'busy' : 'ready'
}
function railSnapshot() {
  const layout = railModel.railLayout(mainWindow.getContentSize()[0], !!settings.railPinned)
  return {
    pinned: !!settings.railPinned,
    locked: !!settings.railLocked,
    mode: layout.mode,
    room: layout.room,
    open: { lyrics: !!lyricsWindow, visualizer: !!vizWindow, mini: !!miniWindow, settings: !!settingsWindow },
    keys: { lyrics: LYRICS_KEY, visualizer: VISUALIZER_KEY, mini: MINI_KEY, settings: '' },
    lastfm: { connected: !!(lastfm && lastfm.connected), user: lastfm && lastfm.connected ? (lastfm.username || '') : '' },
    discord: discordConfig.enabled ? (discord && discord.ready ? 'on' : 'waiting') : 'off',
    precise: railPrecise(),
    channel: settings.updateChannel,
    version: app.getVersion(),
    palette: lastPalette && settings.adaptiveColor ? { accent: lastPalette.accent } : null
  }
}
// Sends the rail's state if it changed, and re-applies Apple's room if the rail's width changed.
// Called on every event that can change it (windows, settings, connections, palette, resize, the
// 5 s now-playing tick); unchanged state costs one small JSON.stringify and sends nothing.
function pushRail() {
  if (!railMounted || !mainAlive()) return
  const s = railSnapshot()
  if (s.room !== railRoom) { railRoom = s.room; applyCustomCss() }
  const json = JSON.stringify(s)
  if (json === railSent) return
  railSent = json
  mainWindow.webContents.send('rail:state', s)
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
// lifetime: registered once at module load (like every ipcMain handler here)
// error: a command not from the main window's top frame, or not one of the rail's names, is dropped
ipcMain.on('rail:command', (event, command) => {
  if (!mainAlive() || event.sender !== mainWindow.webContents) return
  if (!event.senderFrame || event.senderFrame.parent) return
  if (!railModel.COMMANDS.includes(command)) return
  if (command === 'mounted') { railMounted = true; railSent = ''; railRoom = 0; pushRail() }
  else if (command === 'lyrics') toggleLyricsWindow()
  else if (command === 'visualizer') toggleVisualizer()
  else if (command === 'mini') toggleMiniPlayer()
  else if (command === 'settings') createSettingsWindow()
  else if (command === 'pin') toggleRailPin()
  else if (command === 'lock') toggleRailFlag('lock')
})

function createWindow() {
  Menu.setApplicationMenu(null)

  const b = settings.windowBounds
  const opts = {
    width: 1000, height: 600, minWidth: 800, minHeight: 500,
    show: !(settings.startMinimized || process.argv.includes('--hidden')),
    title: appName,
    // the rail's bridge only (preload-rail.js); the security defaults are spelled out, unchanged:
    // Apple's page gets no Node, the preload is sandboxed and isolated from the page's scripts
    webPreferences: {
      preload: path.join(__dirname, 'preload-rail.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false
    }
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
  // loop: main-window bounds save · 500 ms one-shot debounce · only after a move/resize · cost ~0
  mainWindow.on('resize', rememberBounds)
  mainWindow.on('move', rememberBounds)
  // lifetime: one resize listener for the rail, dies with the window · per resize event one
  // getContentSize + compare; the room CSS and the state go out only when the rail's mode changes
  // (a pinned rail floats below 996 px and takes its room back above)
  mainWindow.on('resize', pushRail)

  // lifetime: createWindow runs once (plus macOS 'activate' with no windows), so the main window's
  // webContents/window listeners below are registered once and die with the window
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
    else if (input.type === 'keyUp' && input.control && !input.shift && !input.alt && input.key.toLowerCase() === 'b') {
      toggleRailPin()   // Ctrl+B (the rail's tooltip names it: rail-model.js pinItem)
    }
    else if (viewShortcut(input)) return
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

  // lifetime: FIXED — this used to call insertCSS directly, which adds a new stylesheet every time;
  // measured 2 -> 202 injected sheets after 200 title changes, growing for the life of the page. The replacer keeps one.
  applyCustomCss = createCssReplacer(mainWindow.webContents, customCss)
  mainWindow.webContents.on('did-navigate', () => {
    // a new document (load, reload): no rail in it until it says 'mounted', so no room either
    railMounted = false
    railRoom = 0
    railSent = ''
    applyCustomCss()
  });

  // lifetime: one dom-ready listener, dies with the window · per page load (not per SPA route
  // change: Apple's routes keep the document, and the rail re-attaches itself) one injection
  mainWindow.webContents.on('dom-ready', injectRail)

  mainWindow.webContents.on('page-title-updated', () => {
    applyCustomCss()
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
  try { installedPath = fs.realpathSync(appImagePath) } catch (e) {}
  stablePath = path.join(path.dirname(installedPath), 'Sonata.AppImage')
}
const appId = 'io.github.MarcelineVPQ.Sonata'
let pendingUpdateVersion = null
let updateCheckBusy = false

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
      } catch (e) {}
      try { fs.symlinkSync(installedPath, stablePath); launch = stablePath } catch (e) {}
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
    try { current = fs.readFileSync(desktopPath, 'utf8') } catch (e) {}
    if (current !== entry) {
      fs.writeFileSync(desktopPath, entry)
      // refresh the XDG desktop DB and KDE's menu cache so the new entry lands
      exec(`update-desktop-database ${JSON.stringify(appsDir)} 2>/dev/null; ` +
           `kbuildsycoca6 2>/dev/null || kbuildsycoca5 2>/dev/null`, () => {})
    }
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

const isNewerVersion = updateFeed.isNewerVersion  // handles X.Y.Z-dev.N

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
    // Signed latest.json / latest-dev.json; while update-feed.js still holds the
    // PLACEHOLDER key this falls back to the old unsigned latest-linux.yml path.
    const feed = await updateFeed.fetchUpdate({
      channel: settings.updateChannel, fetchText, log: (m) => console.log(m)
    })
    if (!isNewerVersion(feed.version, app.getVersion())) {
      if (interactive) dialog.showMessageBox({
        type: 'info', title: 'Updates',
        message: `You're up to date (v${app.getVersion()}, ${settings.updateChannel === 'dev' ? 'Development' : 'Stable'} channel).`
      })
      return
    }
    if (pendingUpdateVersion !== feed.version) {
      const newPath = path.join(path.dirname(installedPath), feed.file)
      const tmp = newPath + '.part'
      await downloadFile(feed.url, tmp)
      try {
        await updateFeed.verifyDownload(tmp, feed)  // size + SHA-512 from the (signed) feed
      } catch (e) {
        // error: PASSES-ON — the unverified file is deleted, the message goes to the log and the interactive dialog below
        fs.rmSync(tmp, { force: true })
        throw e
      }
      fs.chmodSync(tmp, 0o755)
      fs.renameSync(tmp, newPath)
      if (newPath !== installedPath) {
        // Do NOT delete installedPath here: the app is still executing from
        // that AppImage's FUSE mount, and removing it crashes the running
        // process with SIGBUS. Stale old versions are pruned at next launch.
        installedPath = newPath
        process.env.APPIMAGE = newPath
        integrateAppImage()  // repoint the menu entry at the new file name
        if (settings.launchAtLogin) applyAutostart()
      }
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
  // free the single-instance lock so the replacement can take it immediately
  app.releaseSingleInstanceLock()
  const target = (stablePath && fs.existsSync(stablePath)) ? stablePath : installedPath
  // Relaunch in the CLEAN session environment, the way a menu launch does.
  // Inheriting THIS process's Chromium-polluted env crashes the new instance
  // (SIGBUS/SIGTRAP); the user's systemd manager gives it a fresh env and
  // outlives us. Pass only session vars through, not our whole environment.
  const sessionVars = ['DISPLAY', 'WAYLAND_DISPLAY', 'XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS',
    'XDG_CURRENT_DESKTOP', 'XDG_SESSION_TYPE', 'XAUTHORITY', 'HOME', 'LANG', 'PATH']
  let started = false
  try {
    const setenv = sessionVars.filter((v) => process.env[v]).map((v) => '--setenv=' + v + '=' + process.env[v])
    execFileSync('systemd-run',
      ['--user', '--collect', '--unit=sonata-relaunch-' + Date.now(), ...setenv, '--', target],
      { stdio: 'ignore' })
    started = true
  } catch (e) { /* systemd-run unavailable; fall back below */ }
  if (!started) {
    const env = {}
    for (const v of sessionVars) if (process.env[v]) env[v] = process.env[v]
    spawn('/bin/sh', ['-c', 'sleep 0.5; exec ' + JSON.stringify(target)], { detached: true, stdio: 'ignore', env }).unref()
  }
  app.exit(0)
}

// Remove older-versioned Sonata AppImages left beside the current one by a
// previous self-update (we couldn't delete them while they were running).
// Safe now: this process runs from appImagePath, never the files being pruned.
function pruneOldAppImages() {
  if (!appImagePath) return
  try {
    const dir = path.dirname(appImagePath)
    const self = path.basename(appImagePath)
    for (const f of fs.readdirSync(dir)) {
      const m = f.match(/^sonata-(\d+\.\d+\.\d+(?:-dev\.\d+)?)-.*\.AppImage$/i)
      if (m && f !== self && isNewerVersion(app.getVersion(), m[1])) {
        try { fs.unlinkSync(path.join(dir, f)) } catch (e) {}
      }
    }
  } catch (e) {}
}

function startUpdateChecks() {
  if (!appImagePath) return
  pruneOldAppImages()
  // loop: update check · 20 s one-shot, then every 2 h · AppImage builds only · stops on app exit ·
  // cost two small HTTPS GETs per 2 h (feed + .sig; one GET on the placeholder-key yml path), download only
  // when a new version exists; a channel switch adds one check; updateCheckBusy stops overlaps
  // error: a failed check (offline, bad signature, hash mismatch) logs and waits the full 2 h, so it can't hammer
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
  lyricsStore = require('./lyrics-store').createLyricsStore({ file: path.join(app.getPath('userData'), 'lyrics-cache.json') })
  app.on('before-quit', () => {
    if (listenSession) listenSession.stop()
    if (alignSession) alignSession.stop(false)
    if (alignHelper) alignHelper.stop()
    if (lyricsStore) lyricsStore.flush()
  })
  loadSettings()
  applyAutostart()
  cleanupWindowPositionMemory()
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