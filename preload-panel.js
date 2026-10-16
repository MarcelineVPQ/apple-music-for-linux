// Preload of the side panel's view (panel.html) and of the toast view (toast.html): local pages,
// sandboxed, contextIsolation on, no Node. One small bridge: send a command (main checks the sender
// view, its top frame, the command list and every argument: panel-model.js COMMANDS, main.js), receive
// main's state, and be told to take keyboard focus.
const { contextBridge, ipcRenderer } = require('electron')

let onState = null
let onFocus = null
let last = null
// lifetime: one 'panel:state' and one 'panel:take-focus' listener per page load (the preload runs once
// per document) · main sends state only when it changes
ipcRenderer.on('panel:state', (_event, state) => {
  last = state
  if (onState) onState(state)
})
ipcRenderer.on('panel:take-focus', (_event, where) => { if (onFocus) onFocus(where === 'last' ? 'last' : 'first') })

contextBridge.exposeInMainWorld('sonataPanelBridge', {
  // a command name and up to three plain arguments (strings, numbers, booleans or null)
  send: (command, ...args) => ipcRenderer.send('panel:command', String(command),
    ...args.slice(0, 3).map((a) => (a === null || ['string', 'number', 'boolean'].includes(typeof a) ? a : String(a)))),
  // one subscriber each; the latest state is handed over at once if one already came
  onState: (fn) => {
    onState = typeof fn === 'function' ? fn : null
    if (onState && last) onState(last)
  },
  onFocus: (fn) => { onFocus = typeof fn === 'function' ? fn : null }
})
