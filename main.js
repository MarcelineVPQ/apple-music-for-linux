const { app, BrowserWindow, Menu, Tray, shell, nativeTheme, nativeImage, components } = require('electron')
const fs = require('fs');
const path = require('path');

const appName = 'Apple Music'

let locale = 'US'
let themeFile = null
let mainWindow = null
let tray = null

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

// Drive the page's own MusicKit player instance
function playerCommand(command) {
  if (!mainWindow) return
  const scripts = {
    playPause: 'const mk = MusicKit.getInstance(); mk.isPlaying ? mk.pause() : mk.play();',
    next: 'MusicKit.getInstance().skipToNextItem();',
    previous: 'MusicKit.getInstance().skipToPreviousItem();'
  }
  mainWindow.webContents.executeJavaScript(scripts[command]).catch(() => {})
}

function createTray() {
  const icon = nativeImage.createFromPath(path.join(__dirname, 'apple-music-for-linux.png'))
    .resize({ width: 22, height: 22 })
  tray = new Tray(icon)
  tray.setToolTip(appName)
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Show / Hide', click: toggleWindow },
    { type: 'separator' },
    { label: 'Play / Pause', click: () => playerCommand('playPause') },
    { label: 'Next', click: () => playerCommand('next') },
    { label: 'Previous', click: () => playerCommand('previous') },
    { type: 'separator' },
    { label: 'Toggle Dark Mode', click: toggleTheme },
    { type: 'separator' },
    { label: 'Quit', click: () => app.exit(0) }
  ]))
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
  })

  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith(appUrl)) {
      event.preventDefault()
      shell.openExternal(url)
    }
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
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
    app.exit(0);
 });
}

app.whenReady().then(async () => {
  await components.whenReady()
  initLocaleAndTheme()
  createWindow()
  createTray()
  app.on('activate', function () {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', function () {
  if (process.platform !== 'darwin') app.quit()
})