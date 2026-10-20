// main.js pushPanel (QC 2026-10 LOOP_PASS L2, WASTE): out of sight (the panel hidden, the window in the tray or
// minimized) one snapshot says so, then nothing is built until it shows again. The function runs here on stubs.
'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')

const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8')
const src = main.slice(main.indexOf('function pushPanel() {'), main.indexOf('\n}\n', main.indexOf('function pushPanel() {')) + 2)

function world() {
  const w = { settings: { panelShown: true }, visible: true, minimized: false, built: 0, sent: [], n: 0 }
  const env = {
    panelAlive: () => true, panelMounted: true, mainAlive: () => true, aboutSync: () => {},
    panelSnapshot: () => { w.built++; return { n: w.n, shown: w.settings.panelShown } },
    panelSent: '', panelSentHidden: false, panelStale: false
  }
  const run = new Function('w', 'env', `with (env) { const settings = w.settings; const mainWindow = { isVisible: () => w.visible, isMinimized: () => w.minimized };
    const panelView = { webContents: { send: (c, s) => w.sent.push(s) } }; ${src}; return pushPanel }`)   // eslint-disable-line no-new-func
  w.push = run(w, env)
  w.env = env
  return w
}

test('pushPanel: while the window is in the tray, one snapshot then none until it shows', () => {
  const w = world()
  w.push(); assert.equal(w.sent.length, 1)
  w.visible = false
  w.n++; w.push()                                      // the hide itself is told once
  assert.equal(w.sent.length, 2)
  const built = w.built
  // loop: NOT-WORTH — a test's ten ticks
  for (let k = 0; k < 10; k++) { w.n++; w.push() }     // the 5 s loop while in the tray
  assert.equal(w.built, built, 'nothing built while hidden')
  assert.equal(w.env.panelStale, true)
  w.visible = true
  w.push()                                             // shown again (the 'show' listener)
  assert.equal(w.sent.length, 3)
  assert.equal(w.sent[2].n, w.n, 'the latest state')
})

test('pushPanel: the panel hidden in a shown window is the same; main re-sends on show and restore', () => {
  const w = world()
  w.settings.panelShown = false
  w.push(); w.n++; w.push(); w.n++; w.push()
  assert.equal(w.sent.length, 1)
  assert.match(main, /for \(const ev of \['show', 'restore'\]\) mainWindow\.on\(ev, \(\) => \{ if \(panelStale\) pushPanel\(\) \}\)/)
})
