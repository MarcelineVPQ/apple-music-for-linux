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

test('no dead controls: Montage shows with the Studio (montage-ui.js), Liner notes only once openLinerNotes exists, the notes band only with its switch on', () => {
  // the Montage tile: hidden in the page until the Studio shows (montage-ui.js drawTile), before the stage's own form listener
  assert.match(html, /<button id="t-montage"[^>]*hidden>/)
  assert.ok(!/t-?[mM]ontage[^\n]*hidden = false/.test(ui), 'stage-ui.js leaves the Montage tile to montage-ui.js')
  assert.ok(html.indexOf("montage.setForm(") < html.indexOf("ipcRenderer.on('lyrics-form', (event, f) => stage.setForm(f))"), 'the Montage tile shows before the stage counts the layer tiles')
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

test('the song\'s actions: read once per song while the Studio shows (and after an action), never on a timer', () => {
  const st = fn(main, 'async function stageTick(')
  assert.match(st, /if \(key !== stageSongKey\) \{ stageSongKey = key; stageSongRead\(state, key\) \}/)
  // the only callers: the song changing (stageTick) and an action that changed the song's state (stageDone)
  // ... and a favourite write's read that lags it (Apple's ratings read trails its write: Marcy 2026-10-18,
  // the ☆ stayed an outline): read again at most twice, per write, while the read still disagrees
  assert.equal((main.match(/stageSongRead\(/g) || []).length, 4, 'definition + stageTick + stageDone + the lagging re-read')
  const done = fn(main, 'function stageDone(')
  assert.match(done, /if \(ok && \/favorite\|library\|playlist\/\.test\(action\)\)/)
  const block = main.slice(main.indexOf('// --- the Studio\'s song actions'), main.indexOf('// --- the Studio\'s Montage'))
  assert.ok(!block.includes('setInterval('), 'no setInterval(')
  assert.equal(block.split('setTimeout(').length - 1, 1, 'one timer: the lagging read')
  assert.match(fn(main, 'function settleStageSong('), /if \(wait\) \{\s*w\.tries\+\+[\s\S]*stageReread = setTimeout\(\(\) => \{ stageReread = null; if \(stageWrote === w\) stageSongRead\(null, ''\) \}, wait\)/)
  assert.match(main, /const STAGE_REREAD_MS = \[3000, 10000\]/)
  // the source-neutral interface: the Studio asks songSource, never MusicKit itself
  assert.ok(!/MusicKit/.test(block), 'no MusicKit in the Studio\'s action code')
  assert.match(main, /const songSource = songActions\.createAppleSource\(/)
})

test('one action builder: the mini player\'s ⋯ and the Studio\'s ⋯ and row menus come from songMenuItems', () => {
  assert.match(main, /songMenuItems\(info, miniWindow, \['favorite', 'library', '-', 'link', 'cover', 'liner'\]/)
  assert.match(main, /songMenuItems\(stageInfo\(\), lyricsWindow, \['cover', 'liner', '-', 'share'\], stageDone\)/)
  assert.match(main, /songMenuItems\(info, lyricsWindow, \['play-now', 'play-next', '-', 'album', 'credits'\], stageDone\)/)
  // the favourite / library scripts live once, in song-actions.js
  assert.ok(!/me\/ratings\/songs\/\$\{info\.id\}/.test(main), 'no copy of the favourite script in main.js')
  assert.ok(!/const showAlbumScript/.test(main), 'the album link walk is song-actions.js openPageScript')
  assert.match(main, /songActions\.openPageScript\('album'\)/)
})

test('the cover turns over: transform only (rotateY 0.4 s ease-out with perspective), a cross-fade with Reduce motion', () => {
  assert.match(html, /#flip \{[^}]*perspective: 900px/)
  assert.match(html, /#flip-in \{[^}]*transition: transform 0\.4s cubic-bezier/)
  assert.match(html, /#flip\.turned #flip-in \{ transform: rotateY\(180deg\); \}/)
  assert.match(html, /backface-visibility: hidden/)
  const rm = html.slice(html.indexOf('@media (prefers-reduced-motion: reduce) {\n    #flip-in'))
  assert.match(rm, /#flip\.turned #flip-in \{ transform: none; \}/)
  assert.match(rm, /transition: opacity 0\.2s ease/)
  // a button with aria-expanded; the hidden face is inert; credits announced; a new song turns it back
  assert.match(html, /<button id="cover-btn" class="face front" aria-expanded="false" aria-controls="cover-back"/)
  assert.match(ui, /el\.coverBtn\.inert = v\n\s*el\.back\.inert = !v/)
  assert.match(ui, /say\(creditsText\(\)\)/)
  assert.match(ui, /if \(songKey\(\) !== before\) \{ flip\(false\); drawCredits\(\) \}/)
})

test('the Studio\'s keys: only in the Studio, never over a control that uses the key, Esc turns the cover back first', () => {
  const k = ui.slice(ui.indexOf("// --- the Studio's keys"), ui.indexOf('// --- drawing ---'))
  assert.match(k, /if \(!form\.stage \|\| e\.ctrlKey \|\| e\.altKey \|\| e\.metaKey \|\| e\.defaultPrevented\) return/)
  assert.match(k, /const slider0 = t\.closest\('\[role=slider\]'\)/)
  assert.match(k, /const inList = t\.closest\('#q-list, #lines, #q-pop'\)/)
  assert.match(k, /e\.key === ' ' && !onButton && !slider0 && !inList/)
  assert.match(k, /else if \(turned\) \{ e\.preventDefault\(\); e\.stopImmediatePropagation\(\); flip\(false\) \}/)
  assert.match(k, /\}, true\)/, 'a capture listener: it runs before the page\'s Esc closes the window')
  // Ctrl+Shift+S, the global shortcuts (modifiers) and the rail's keys (another view) can't collide: no modifier keys here
  for (const key of ['f', 'c', 'n']) assert.ok(require('../shortcuts-model').problem(key.toUpperCase()), key + ' alone is never a global shortcut')
})

test('one list: no tabs; the next card sits in the list after the song playing, its length in the rows\' column', () => {
  assert.ok(!/tab-next|tab-all|class="seg"/.test(html), 'no Up Next / Playlist tabs')
  assert.ok(!/setTab|which ===/.test(ui), 'no tab code')
  assert.match(html, /<button id="next-card" class="q-row q-next"[^>]*>[\s\S]*?<span class="d" id="next-d"><\/span>/)
  assert.match(ui, /if \(i === v\.cardAt\) \{ const cli = doc\.createElement\('li'\); cli\.appendChild\(el\.nextCard\); lis\.push\(cli\) \}/)
  assert.match(ui, /text\(el\.nextS, \[nx\.artist, nx\.album\]\.filter\(Boolean\)\.join\(' · '\)\)/)
  assert.match(ui, /el\.nextCard\.onclick = \(\) => send\('next'\)/)
  // no auto-scroll while the user scrolls
  assert.match(ui, /if \(sk !== scrolledFor && now\(\) - userScrolled > SCROLL_QUIET\)/)
})

test('the Studio\'s new files ship', () => {
  const files = require('../package.json').build.files
  for (const f of ['song-actions.js', 'mini-model.js', 'liner-notes-model.js']) assert.ok(files.includes(f), f)
})

// the action row's state reaches the Studio: it is sent under the Studio's own song key (title|artist of the
// now-playing), not the lyrics feed's track key (title|artist|ISRC), which the Studio dropped (the ☆ stayed
// an outline after a Favorite, 2026-10-18); after an action the state is read back without resetting the key
// (a reset made the next tick read again and that read won over the action's)
test('the song\'s state: sent under the Studio\'s key; an action reads it back; the buttons draw what came back', () => {
  const S = require('../stage-model')
  assert.equal(S.songKey({ title: 'A', artist: 'B' }), 'A|B')
  assert.equal(S.songKey(null), '')
  const read = fn(main, 'async function stageSongRead(')
  assert.match(read, /const k = stageModel\.songKey\(lastStage\(\)\)/)
  assert.ok(!/stageSongKey = /.test(read), 'the read never changes the per-song key')
  const done = fn(main, 'function stageDone(')
  assert.ok(!/stageSongKey = ''/.test(done))
  assert.match(ui, /const songKey = \(\) => M\.songKey\(np\)/)
  assert.match(ui, /const fav = M\.favoriteButton\(s\)/)
  assert.match(ui, /el\.fav\.setAttribute\('aria-label', fav\.label\)/)
  assert.match(ui, /const lib = M\.libraryButton\(s\)/)
  // the filled star in the accent the other "on" controls use (a theme token)
  assert.match(html, /\.ib\.act\[aria-pressed="true"\] \{ color: var\(--s-accent-text\); \}/)
})
