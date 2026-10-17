// The stage view's wiring (main.js, lyrics.html, stage-ui.js), checked in the source: one window and one
// lyrics engine, the queue read-only and read only while the stage shows, the page's commands checked,
// the ways in (the header button, the rail, Ctrl+Shift+S) and the remembered form.
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')

const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8')
const main = read('main.js')
const html = read('lyrics.html')
const ui = read('stage-ui.js')
const fn = (src, name) => { const i = src.indexOf(name); assert.ok(i >= 0, name); return src.slice(i, src.indexOf('\n}\n', i) + 2) }

test('one engine: the stage is the lyrics window\'s own page and lyrics-view.js; no timing code of its own', () => {
  assert.equal((html.match(/createLyricsView\(/g) || []).length, 1)
  assert.match(html, /require\('\.\/stage-ui'\)\.createStage\(/)
  for (const t of ["require('./lyrics-", 'requestAnimationFrame(', 'setInterval(', 'setTimeout(']) assert.ok(!ui.includes(t), 'stage-ui.js has no ' + t)
  // the stage's time is the lyrics engine's clock (view.time()), from the same 'lyrics-time' pushes
  // (the sheet-notes band, too: sheet-notes.test.js)
  assert.match(html, /ipcRenderer\.on\('lyrics-time', \(event, playbackTime\) => \{ if \(stage\.shown\) \{ stage\.setTime\(view\.time\(\)\); sheetBand\.setTime\(\) \} \}\)/)
  // the sung line: a third of the way down on the stage, the middle in the lyrics window
  assert.match(html, /anchor: \(\) => \(document\.body\.classList\.contains\('stage'\) \? 0\.34 : 0\.5\)/)
})

test('the queue: read-only from Apple\'s page, read only while the stage shows, at most every 2 s or on a new song', () => {
  const tick = fn(main, 'async function lyricsTick(')
  assert.match(tick, /if \(stageShowing\(\)\) stageTick\(state, key\)/)
  const showing = fn(main, 'function stageShowing(')
  for (const need of ['settings.lyricsStage', 'isVisible()', '!lyricsWindow.isMinimized()']) assert.ok(showing.includes(need), need)
  const st = fn(main, 'async function stageTick(')
  assert.match(st, /key === stageQueueKey && now - stageQueueAt < 2000/)
  assert.match(st, /stageModel\.cleanQueue\(q\)/)
  // the read script changes nothing in the player: no play, skip, set or queue edits
  const script = main.slice(main.indexOf('const stageQueueScript'), main.indexOf('async function stageTick('))
  for (const verb of ['changeToMediaAtIndex(', 'changeToMediaItem(', 'setQueue', 'play(', 'skipTo', 'seekToTime', 'prepend', 'append', 'remove', '.volume =', 'shuffleMode =', 'repeatMode =']) assert.ok(!script.includes(verb), 'read script has no ' + verb)
  assert.match(script, /if \(sig === \$\{JSON\.stringify\(String\(since \|\| ''\)\)\}\) return \{ ok: true, same: true, sig \}/)
})

test('playing a song from the list: only through changeToMediaAtIndex, and only if that place still holds the song clicked', () => {
  const play = main.slice(main.indexOf('const stagePlayScript'), main.indexOf("ipcMain.on('stage-command'"))
  assert.match(play, /String\(it\.id\) !== \$\{JSON\.stringify\(id\)\}/)
  assert.match(play, /typeof mk\.changeToMediaAtIndex !== 'function'\) return false/)
  // the list says when it can't: rows are buttons only with canPlay
  assert.match(ui, /doc\.createElement\(canPlay && !r\.cur \? 'button' : 'div'\)/)
  assert.match(ui, /Read-only: Apple Music\\'s player doesn\\'t offer jumping to a song here/)
})

test('stage-command: only from the lyrics window\'s top frame, every command and value checked', () => {
  const h = main.slice(main.indexOf("ipcMain.on('stage-command'"), main.indexOf('function lastStage('))
  assert.match(h, /event\.sender !== lyricsWindow\.webContents\) return/)
  assert.match(h, /if \(!event\.senderFrame \|\| event\.senderFrame\.parent\) return/)
  assert.match(h, /const c = stageModel\.stageCommand\(command, value\)\s*\n\s*if \(!c\) return/)
  // values reach Apple's page only after the check (numbers; the id through JSON.stringify)
  assert.ok(!/\$\{value/.test(h), 'no raw value in a page script')
})

test('ways in and the remembered form: header button, rail item, Ctrl+Shift+S; one size per form', () => {
  assert.match(html, /<button id="form" aria-label="Studio" aria-pressed="false" aria-keyshortcuts="Control\+Shift\+S"/)
  assert.match(html, /ipcRenderer\.send\('stage-command', 'form', stage\.shown \? 'compact' : 'stage'\)/)
  assert.match(main, /else if \(key === 's'\) toggleStage\(\)/)
  assert.match(main, /else if \(command === 'stage'\) toggleStage\(\)/)
  assert.match(main, /stage: !!lyricsWindow && !!settings\.lyricsStage/)
  assert.match(main, /const form = settings\.lyricsStage \? 'stage' : 'compact'/)
  assert.match(main, /persistBounds\(lyricsWindow, \(\) => \(settings\.lyricsStage \? 'stageBounds' : 'lyricsBounds'\)\)/)
  const S = require('../settings-store')
  const d = S.defaults()
  assert.equal(d.lyricsStage, false)
  assert.equal(d.stageBounds, null)
  assert.ok(require('../shortcuts-model').problem('Ctrl+Shift+S'), 'Ctrl+Shift+S is a window key, never a global one')
})

test('no dead controls: Montage stays hidden, Liner notes only once openLinerNotes exists, the notes band only with its switch on', () => {
  assert.match(html, /<button id="t-montage"[^>]*hidden>/)
  assert.ok(!/t-?[mM]ontage[^\n]*hidden = false/.test(ui), 'nothing shows the Montage tile yet')
  assert.match(main, /const linerNotesReady = \(\) => typeof openLinerNotes === 'function'/)
  assert.match(main, /return \{ stage: !!settings\.lyricsStage, linerNotes: linerNotesReady\(\) \}/)
  assert.match(ui, /el\.tLiner\.hidden = !form\.linerNotes/)
  assert.match(ui, /el\.band\.hidden = !\(has && sheetOn\)/)   // the band: the Sheet notes switch on (a message when nothing to draw)
  assert.match(ui, /el\.layers\.hidden = el\.tNotes\.hidden && el\.tMontage\.hidden && el\.tLiner\.hidden/)
  assert.match(html, /<div id="band"[^>]*hidden><\/div>/)
})

test('the Liner notes tile opens the stage\'s album, and says so when no album matched', () => {
  assert.match(main, /openLinerNotes\(\{ album: s\.album, artist: s\.artist \}, lyricsWindow\)/)
  assert.match(main, /webContents\.send\('stage-liner', !!ok\)/)
  assert.match(html, /ipcRenderer\.on\('stage-liner', \(event, ok\) => stage\.linerFound\(ok\)\)/)
  assert.ok(ui.includes("textContent = ok ? 'Booklet' : 'No album found'"), 'the tile says when no album matched')
  assert.ok(typeof require('../liner-notes-model') === 'object')
})

test('the stage\'s files ship (package.json build.files)', () => {
  const files = require('../package.json').build.files
  for (const f of ['stage-model.js', 'stage-ui.js', 'lyrics.html', 'lyrics-view.js']) assert.ok(files.includes(f), f)
})
