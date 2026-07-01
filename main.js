const { app, BrowserWindow, Menu, shell, nativeTheme, components } = require('electron')
const fs = require('fs');
const path = require('path');

const appName = 'Apple Music'

let locale = 'US'
let themeFile = null

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

const appUrl = 'https://music.apple.com/'

const customCss =
  '.web-navigation__native-upsell {display: none !important;}'

function createWindow() {
  Menu.setApplicationMenu(null)

  const mainWindow = new BrowserWindow({
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
      nativeTheme.themeSource = nativeTheme.shouldUseDarkColors ? 'light' : 'dark'
      if (themeFile) {
        fs.writeFileSync(themeFile, nativeTheme.themeSource);
      }
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
  app.on('activate', function () {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', function () {
  if (process.platform !== 'darwin') app.quit()
})