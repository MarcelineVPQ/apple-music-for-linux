// DOM proof for the drift check (docs/LYRIC-TIMING.md): the REAL lyrics view (lyrics-view.js +
// lyrics-view.css in a Chromium page) is driven through every song on a virtual clock, and every
// 50 ms the words carrying .now in the DOM are compared with what the headless engine
// (tools/drift-check/lib.js highlightAt) says. For the progressive method the aligned sections are
// delivered with view.align() when they would arrive, as main.js does.
//
// Electron main script. Run it ONLY isolated (never on the user's session or profile):
//   H=$(mktemp -d); env -u WAYLAND_DISPLAY -u XDG_SESSION_TYPE -u KDE_FULL_SESSION -u XDG_CURRENT_DESKTOP \
//     HOME=$H XDG_CONFIG_HOME=$H/c XDG_DATA_HOME=$H/d XDG_CACHE_HOME=$H/k DISPLAY=:93 \
//     dbus-run-session -- node_modules/electron/dist/electron --password-store=basic --no-sandbox --no-zygote \
//     --disable-gpu-sandbox --disable-gpu --in-process-gpu --ozone-platform=x11 \
//     tools/drift-check/dom-check.js --cache COPY.json --out result.json
//   (with `Xvfb :93 -screen 0 1280x800x24` running). It quits itself (window close -> app.quit) when
//   done. Keep --no-zygote and --in-process-gpu: without them the unsandboxed zygote and the GPU
//   process die at start (SIGTRAP core dumps, which pop crash notices on the desktop). Check
//   `coredumpctl list --since -2min` after a run.
// loop: none; one window, one pass over the songs, then quit.
'use strict'
const { app, BrowserWindow, ipcMain } = require('electron')
const fs = require('fs')
const path = require('path')

const args = process.argv.slice(2)
const opt = (name, def) => { const i = args.indexOf('--' + name); return i >= 0 ? args[i + 1] : def }

app.whenReady().then(() => {
  const win = new BrowserWindow({ width: 420, height: 640, x: 0, y: 0, show: true, webPreferences: { nodeIntegration: true, contextIsolation: false, backgroundThrottling: false } })
  ipcMain.once('dom-check-done', (e, report) => {
    const text = JSON.stringify(report, null, 1)
    if (opt('out')) fs.writeFileSync(opt('out'), text)
    console.log(text)
    win.close()
  })
  win.on('closed', () => app.quit())
  win.loadFile(path.join(__dirname, 'dom-page.html'), { query: { cache: opt('cache', ''), jamendo: opt('jamendo', ''), limit: opt('limit', '6') } })
})
app.on('window-all-closed', () => app.quit())
