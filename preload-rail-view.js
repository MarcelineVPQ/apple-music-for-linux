// Preload of the rail's own view (rail.html, a local page): sandboxed, contextIsolation on, no Node.
// Exposes one small bridge to that page: send a command name (main checks it against a list and
// the sender), receive main's rail state, and be told to take keyboard focus.
const { contextBridge, ipcRenderer } = require('electron')

let onState = null
let onFocus = null
let last = null
// lifetime: one 'rail:state' and one 'rail:take-focus' listener per page load (the preload runs once
// per document) · main sends state only when it changes
ipcRenderer.on('rail:state', (_event, state) => {
  last = state
  if (onState) onState(state)
})
ipcRenderer.on('rail:take-focus', () => { if (onFocus) onFocus() })

contextBridge.exposeInMainWorld('sonataRailBridge', {
  send: (command) => ipcRenderer.send('rail:command', String(command)),
  // one subscriber each (the rail); the latest state is handed over at once if one already came
  onState: (fn) => {
    onState = typeof fn === 'function' ? fn : null
    if (onState && last) onState(last)
  },
  onFocus: (fn) => { onFocus = typeof fn === 'function' ? fn : null }
})
