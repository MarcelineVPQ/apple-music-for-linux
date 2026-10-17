// The Montage's wiring (main.js, lyrics.html, montage-ui.js), checked in the source: off by default and
// remembered, fetched only while the Studio shows with it on, the page's commands checked, the credit
// opening only a Commons page main itself sent, the animation's lean rules, and the files shipped.
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')
const SM = require('../stage-model')

const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8')
const main = read('main.js')
const html = read('lyrics.html')
const ui = read('montage-ui.js')
const fn = (src, name) => { const i = src.indexOf(name); assert.ok(i >= 0, name); return src.slice(i, src.indexOf('\n}\n', i) + 2) }

test('off by default, remembered: the tile turns it on and off through main', () => {
  assert.equal(require('../settings-store').defaults().montage, false)
  const h = main.slice(main.indexOf("ipcMain.on('stage-command'"), main.indexOf('function lastStage('))
  assert.match(h, /if \(c\.command === 'montage'\) \{[\s\S]*?settings\.montage = c\.value\s*\n\s*saveSettings\(\)/)
  assert.match(ui, /send\('montage', want\)/)
})

test('page commands are checked: on/off a boolean, the credit a photo id (never a URL to open)', () => {
  assert.deepEqual(SM.stageCommand('montage', true), { command: 'montage', value: true })
  assert.equal(SM.stageCommand('montage', 'yes'), null)
  assert.equal(SM.stageCommand('montage', 1), null)
  assert.deepEqual(SM.stageCommand('montage-credit', 'Coldplay.jpg'), { command: 'montage-credit', value: 'Coldplay.jpg' })
  for (const bad of ['', 'x'.repeat(301), 'a\nb', 42, null]) assert.equal(SM.stageCommand('montage-credit', bad), null, String(bad))
  const h = main.slice(main.indexOf("if (c.command === 'montage-credit')"), main.indexOf('function lastStage('))
  assert.match(h, /montageMsg\.photos\.find\(\(x\) => x\.id === c\.value\)/)
  assert.match(h, /\^https:\\\/\\\/commons\\\.wikimedia\\\.org\\\/wiki\\\/File:/)
  assert.match(h, /openExternalSafe\(p\.page\)/)
})

test('fetched only while the Studio shows with the Montage on, once per song', () => {
  const st = fn(main, 'async function stageTick(')
  assert.match(st, /montageTick\(state\)/)
  assert.equal((main.match(/^\s*montageTick\(state\)$/gm) || []).length, 1, 'only from stageTick (which runs only while the Studio shows)')
  const tick = fn(main, 'function montageTick(')
  assert.match(tick, /if \(!settings\.montage \|\| !montageCache\) return/)
  assert.match(tick, /if \(song === montageSong\) return/)
  // the IDs script only reads Apple's catalog
  const script = main.slice(main.indexOf('const montageIdsScript'), main.indexOf('function montageWidth('))
  for (const verb of ['changeToMediaAtIndex(', 'setQueue', 'play(', 'seekToTime', '.volume =', 'shuffleMode =']) assert.ok(!script.includes(verb), verb)
  assert.match(script, /include: 'artists,albums'/)
})

test('photos one at a time, at their display width, from the bounded disk cache first', () => {
  const r = fn(main, 'async function resolveMontageSong(')
  assert.match(r, /loop: SERIAL-REQUIRED — ≤ 8 photos, one download at a time/)
  assert.match(r, /montageImages\.get\(name\)/)
  assert.match(r, /montageSources\.thumbFor\(p, montageWidth\(p\.width \/ p\.height\)\)/)
  assert.match(main, /createImageStore\(\{ dir: path\.join\(app\.getPath\('userData'\), 'montage'\), maxBytes: 64 \* 1024 \* 1024, maxFiles: 300 \}\)/)
  assert.match(main, /montage-cache\.json'\), maxEntries: 1500, maxBytes: 4 \* 1024 \* 1024/)
})

test('lean: one timer, only while running; nothing at rest; transform and opacity only', () => {
  assert.equal((ui.match(/setTimeout\(/g) || []).length, 2, 'the pan tick and the reduced-motion one-shot')
  assert.ok(!/setInterval\(|requestAnimationFrame\(/.test(ui))
  const sched = fn(ui, '  function schedule(')
  assert.match(sched, /stop\(\)\s*\n\s*if \(!running\(\)\) return/)
  assert.match(ui, /const running = \(\) => visible\(\) && playing && doc\.visibilityState === 'visible'/)
  assert.match(ui, /doc\.addEventListener\('visibilitychange'/)
  // the layers' styles written: transform and opacity (and their stacking), nothing else
  const writes = [...ui.matchAll(/\.style\.(\w+)\s*=/g)].map((m) => m[1])
  assert.deepEqual([...new Set(writes)].sort(), ['opacity', 'transform', 'zIndex'])
  assert.match(html, /\.mt-photo \{[^}]*will-change: transform, opacity;/)
})

test('readable over every photo: the shade is computed per photo from main\'s measured extremes', () => {
  assert.match(ui, /M\.scrimFor\(opts\.theme\.tokens\(\), p\)\.alpha/)
  assert.match(fn(main, 'function montageExtremes('), /montageModel\.extremes\(img\.toBitmap\(\)\)/)
  assert.match(html, /\.mt-scrim::before \{[^}]*background: var\(--s-surface\); opacity: var\(--scrim, 0\.98\)/)
  assert.match(html, /ipcRenderer\.on\('theme', \(\) => montage\.reshade\(\)\)/)
})

test('the credit line: author, licence and source, a real button that opens the page through main', () => {
  assert.match(html, /<button id="mt-credit" aria-label="Photo credit" hidden>/)
  assert.match(ui, /credit\.onclick = \(\) => \{ if \(shownPhoto\) send\('montage-credit', shownPhoto\) \}/)
  assert.match(ui, /\[p\.author, p\.licence, 'Wikimedia Commons'\]/)
})

test('the files ship (package.json build.files)', () => {
  const files = require('../package.json').build.files
  for (const f of ['montage-model.js', 'montage-sources.js', 'montage-store.js', 'montage-ui.js']) assert.ok(files.includes(f), f)
})
