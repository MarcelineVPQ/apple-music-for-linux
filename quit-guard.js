// Never lose a helper install to a quit or a restart (Marcy 2026-10-19): while Settings → Precise timing
// installs, updates, repairs or removes the helper, every way out of Sonata asks first (tray Quit,
// closing the window when that quits, Restart now for the graphics switches and for an update):
// "The Precise timing helper is still installing (step N of M). Quit anyway? It will continue the next
// time Sonata starts." [Keep installing] [Quit anyway]. Pure (no Electron): main passes the job and the
// dialog. Tested in test/quit-guard.test.js.
'use strict'
const M = require('./helper-install-model')

/**
 * createQuitGuard({ job() -> the running job or null, ask(words) -> Promise<index of the button pressed> })
 * -> { allow(action) -> Promise<boolean>, asking }   action: 'quit' | 'restart'
 * One question at a time: a second way out while the question shows is answered "no" (the first decides).
 */
function createQuitGuard(o) {
  let pending = null
  async function allow(action) {
    const job = o.job()
    if (!job) return true
    if (pending) return false
    const words = M.quitAsk(job, action)
    // error: PASSES-ON — a dialog that fails to show counts as Keep installing (nothing is lost)
    pending = Promise.resolve().then(() => o.ask(words)).catch(() => 0)
    const pressed = await pending
    pending = null
    return pressed === 1
  }
  return { allow, get asking() { return !!pending } }
}

module.exports = { createQuitGuard }
