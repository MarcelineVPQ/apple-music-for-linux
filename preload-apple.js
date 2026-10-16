// Preload of Apple's page view: the keyboard-focus bridge to the rail, and nothing else.
// Runs sandboxed with contextIsolation (Electron defaults, spelled out in main.js): Apple's page gets
// no Node, no ipcRenderer and no new globals. The bridge is a plain global of the ISOLATED world,
// where main injects apple-focus.js (executeJavaScriptInIsolatedWorld 999); Apple's scripts (main
// world) can't see it. It can only say "hand focus to the rail" ('first' or 'last' end of the page).
const { ipcRenderer } = require('electron')

globalThis.sonataFocusBridge = Object.freeze({
  toRail: (where) => ipcRenderer.send('rail:focus-in', where === 'last' ? 'last' : 'first')
})
