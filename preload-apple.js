// Preload of Apple's page view: the keyboard-focus bridge to the rail, and nothing else.
// Runs sandboxed with contextIsolation (Electron defaults, spelled out in main.js): Apple's page gets
// no Node, no ipcRenderer and no new globals. The bridge is a plain global of the ISOLATED world,
// where main injects apple-focus.js (executeJavaScriptInIsolatedWorld 999); Apple's scripts (main
// world) can't see it. It can only say "hand focus to the rail" ('first' or 'last' end of the page),
// "the wheel turned N notches over the volume control" (a whole number, -20..20) and, while look-ahead
// play runs, what the player did (lookahead-page.js).
const { ipcRenderer } = require('electron')

globalThis.sonataFocusBridge = Object.freeze({
  toRail: (where) => ipcRenderer.send('rail:focus-in', where === 'last' ? 'last' : 'first'),
  // the mouse wheel over Apple's volume control: whole notches (+ louder), main sets MusicKit's volume
  volume: (steps) => ipcRenderer.send('apple:volume', Math.max(-20, Math.min(20, Math.trunc(Number(steps) || 0)))),
  // look-ahead play (lookahead-page.js, only injected while it runs): the media element's events and the
  // item news, as a fresh object of known fields (main checks them again: lookahead.js cleanEvent)
  lookahead: (m) => {
    if (!m || typeof m !== 'object') return
    const out = {}
    // loop: NOT-WORTH — ten field names per player event
    for (const k of ['ev', 't', 'video', 'ended', 'natural', 'held', 'kind', 'title', 'artist', 'isrc', 'duration', 'id']) {
      const v = m[k]
      if (typeof v === 'string') out[k] = v.slice(0, 300)
      else if (typeof v === 'number' || typeof v === 'boolean') out[k] = v
    }
    ipcRenderer.send('apple:lookahead', out)
  }
})
