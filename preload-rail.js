// Main window preload: the navigation rail's bridge to main, and nothing else.
// Runs sandboxed with contextIsolation (Electron defaults, unchanged): Apple's page gets no Node,
// no ipcRenderer and no new globals. The bridge is a plain global of the ISOLATED world, where
// main injects rail-ui.js (executeJavaScriptInIsolatedWorld 999); Apple's scripts (main world)
// can't see it. It sends only the rail's command names (main checks them against a list and the
// sender) and hands main's rail state to the rail.
const { ipcRenderer } = require('electron')

let listener = null
let last = null
// lifetime: one 'rail:state' listener per page load (the preload runs once per document) · main
// sends only when the rail's state changes (a window opens/closes, a setting, a pin, a connection)
ipcRenderer.on('rail:state', (_event, state) => {
  last = state
  if (listener) listener(state)
})

globalThis.sonataRailBridge = Object.freeze({
  send: (command) => ipcRenderer.send('rail:command', String(command)),
  // one subscriber (the rail); it gets the latest state at once if one already came
  onState: (fn) => {
    listener = typeof fn === 'function' ? fn : null
    if (listener && last) listener(last)
  }
})
