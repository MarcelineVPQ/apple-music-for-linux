// The stage view's pure logic (stage-model.js): Apple's queue cleaned, "Track N of M", the countdown to
// the next song, the time left, the lists, the live chip, the window's bounds per form and the checks on
// the page's commands.
const test = require('node:test')
const assert = require('node:assert/strict')
const M = require('../stage-model')

// an album of 24 songs, 4 min each, song 13 playing (index 12), plus 2 autoplay songs Apple added
const album = (extra) => Object.assign({
  position: 12,
  canPlay: true,
  container: { type: 'albums', name: 'Wayfarers: Live at the Gorge' },
  items: Array.from({ length: 26 }, (_, i) => ({ id: 'i' + i, title: 'Song ' + (i + 1), artist: 'The Band', album: 'Wayfarers', duration: 240, art: 'https://is1.example/112x112.jpg', autoplay: i >= 24 }))
}, extra || {})

test('clock: m:ss, h:mm:ss over an hour, never negative', () => {
  assert.equal(M.clock(0), '0:00')
  assert.equal(M.clock(82), '1:22')
  assert.equal(M.clock(82.9), '1:22')
  assert.equal(M.clock(3725), '1:02:05')
  assert.equal(M.clock(-5), '0:00')
  assert.equal(M.clock('junk'), '0:00')
})

test('cleanQueue: fields bounded and of the right kind, the position inside the list, junk dropped', () => {
  const q = M.cleanQueue({ position: 1, canPlay: 1, container: { type: 'playlists', name: 'Road trip' }, items: [{ id: 5, title: 'A', duration: '200', art: 'http://insecure/x.jpg' }, null, { title: 'x'.repeat(500), art: 'https://ok/y.jpg', autoplay: 'yes' }] })
  assert.equal(q.items.length, 3)
  assert.deepEqual(q.items[0], { index: 0, id: '5', title: 'A', artist: '', album: '', duration: 200, art: '', autoplay: false })
  assert.equal(q.items[1].title, '')
  assert.equal(q.items[2].title.length, 300)
  assert.equal(q.items[2].art, 'https://ok/y.jpg')
  assert.equal(q.items[2].autoplay, true)
  assert.equal(q.position, 1)
  assert.equal(q.canPlay, true)
  assert.deepEqual(q.container, { type: 'playlists', name: 'Road trip' })
  assert.equal(M.cleanQueue({ position: 7, items: [{}] }).position, -1)
  assert.equal(M.cleanQueue({ position: 0.5, items: [{}] }).position, -1)
  assert.deepEqual(M.cleanQueue(null), { items: [], position: -1, canPlay: false, container: null })
  assert.equal(M.cleanQueue({ items: new Array(5000).fill({}) }).items.length, M.QUEUE_MAX)
  assert.equal(M.cleanQueue({ container: {} }).container, null)
})

test('track N of M: the place in the album or playlist; autoplay songs don\'t count; shuffled says so', () => {
  const q = M.cleanQueue(album())
  assert.deepEqual(M.trackOf(q, false), { n: 13, m: 24, shuffled: false, text: 'Track 13 of 24' })
  assert.equal(M.trackOf(q, true).text, '13 of 24, shuffled')
  assert.equal(M.trackOf(M.cleanQueue(album({ position: 0 })), false).text, 'Track 1 of 24')
  assert.equal(M.trackOf(M.cleanQueue(album({ position: 23 })), false).text, 'Track 24 of 24')
  // an autoplay song playing: past the album, nothing to say
  assert.equal(M.trackOf(M.cleanQueue(album({ position: 24 })), false), null)
  // one song, no queue, nothing playing from it: nothing
  assert.equal(M.trackOf(M.cleanQueue({ position: 0, items: [{ id: 'a' }] }), false), null)
  assert.equal(M.trackOf(M.cleanQueue({ position: 0, items: [{ id: 'a' }, { id: 'b', autoplay: true }] }), false), null)
  assert.equal(M.trackOf(null), null)
  assert.equal(M.trackOf(M.cleanQueue(album({ position: -1 }))), null)
})

test('next song and the countdown: the playing song\'s time left, rounded up to the second', () => {
  const q = M.cleanQueue(album())
  assert.equal(M.nextItem(q).title, 'Song 14')
  assert.equal(M.nextItem(M.cleanQueue(album({ position: 25 }))), null)
  assert.equal(M.nextItem(M.cleanQueue({ items: [] })), null)
  assert.equal(M.countdown(240, 158), 'Next · in 1:22')
  assert.equal(M.countdown(240, 157.6), 'Next · in 1:23')
  assert.equal(M.countdown(240, 240), 'Next · in 0:00')
  assert.equal(M.countdown(240, 300), 'Next · in 0:00')
  assert.equal(M.countdown(0, 10), 'Next')
})

test('time left: the playing song\'s rest plus the album\'s songs after it, autoplay left out', () => {
  const q = M.cleanQueue(album())
  // 11 songs after song 13 (14..24) x 4 min + 2 min left of song 13 = 46 min
  assert.equal(M.timeLeft(q, 240, 120), '46 min left')
  const long = M.cleanQueue(album({ items: album().items.map((x) => Object.assign({}, x, { duration: 600 })) }))
  assert.equal(M.timeLeft(long, 600, 0), '2 h 0 min left')
  assert.equal(M.timeLeft(M.cleanQueue(album({ position: 23 })), 240, 230), 'Less than a minute left')
  assert.equal(M.timeLeft(M.cleanQueue(album({ position: 23 })), 240, 240), '')
  assert.equal(M.timeLeft(null, 240, 0), '')
})

test('queue rows: Up Next is the songs after the one playing; the Playlist marks played and current', () => {
  const q = M.cleanQueue(album())
  const next = M.queueRows(q, 'next')
  assert.equal(next.rows.length, 13)
  assert.equal(next.rows[0].title, 'Song 14')
  assert.equal(next.rows[0].n, 14)
  assert.equal(next.rows[0].sub, 'The Band · Wayfarers')
  assert.equal(next.rows[0].time, '4:00')
  assert.ok(next.rows.every((r) => !r.cur && !r.played))
  assert.equal(next.rows[12].autoplay, true)
  const all = M.queueRows(q, 'all')
  assert.equal(all.rows.length, 26)
  assert.equal(all.rows.filter((r) => r.cur).length, 1)
  assert.equal(all.rows.find((r) => r.cur).n, 13)
  assert.equal(all.rows.filter((r) => r.played).length, 12)
  assert.equal(all.more, false)
  assert.equal(M.queueRows(M.cleanQueue({ items: [{ title: '' }] }), 'all').rows[0].title, 'Untitled')
})

test('queue rows: long queues show a window (Up Next 100, the Playlist 50 before and 150 after)', () => {
  const big = M.cleanQueue({ position: 400, items: Array.from({ length: 1000 }, (_, i) => ({ id: 'x' + i, title: 'T' + i, duration: 200 })) })
  const next = M.queueRows(big, 'next')
  assert.equal(next.rows.length, M.UP_NEXT_MAX)
  assert.equal(next.rows[0].index, 401)
  assert.equal(next.more, true)
  assert.equal(M.queueRows(M.cleanQueue(album()), "next").more, false)
  const all = M.queueRows(big, 'all')
  assert.equal(all.from, 350)
  assert.equal(all.to, 551)
  assert.equal(all.rows.length, 201)
  assert.equal(all.total, 1000)
  assert.equal(all.more, true)
  // near the start the window starts at the first song
  assert.equal(M.queueRows(M.cleanQueue({ position: 3, items: big.items }), 'all').from, 0)
})

test('labels: the Playlist tab counts the album or playlist; "Playing from" only when Apple names it', () => {
  assert.equal(M.playlistLabel(M.cleanQueue(album())), 'Playlist · 24')
  assert.equal(M.playlistLabel(null), 'Playlist')
  assert.equal(M.playingFrom(M.cleanQueue(album())), 'Wayfarers: Live at the Gorge')
  assert.equal(M.playingFrom(M.cleanQueue({ container: { type: 'albums' } })), '')
  assert.equal(M.playingFrom(null), '')
})

test('live chip: real data only (the album title\'s venue, a known date), nothing for a studio album', () => {
  assert.equal(M.liveChip('Wayfarers: Live at the Gorge'), 'Live · The Gorge')
  assert.equal(M.liveChip('Wayfarers: Live at the Gorge', 'Aug 30, 2025'), 'Live · Aug 30, 2025 · The Gorge')
  assert.equal(M.liveChip('Live from Mars (Remastered)'), 'Live · Mars')
  assert.equal(M.liveChip('Live in Buffalo: July 4th, 2004'), 'Live · Buffalo: July 4th, 2004')
  assert.equal(M.liveChip('The Goo Goo Dolls (Live)'), 'Live')
  assert.equal(M.liveChip('Dizzy Up the Girl'), '')
  assert.equal(M.liveChip('Oliver'), '')
  assert.equal(M.liveChip(''), '')
  assert.equal(M.yearOf('2026-05-01'), '2026')
  assert.equal(M.yearOf(''), '')
})

test('window bounds: each form its own size, kept on screen, never under its minimum or over the screen', () => {
  const area = { x: 0, y: 30, width: 1920, height: 1050 }
  // no saved stage size: the default, centred
  assert.deepEqual(M.windowBounds('stage', null, area), { x: 340, y: 165, width: 1240, height: 780 })
  // a saved one comes back where it was
  assert.deepEqual(M.windowBounds('stage', { x: 100, y: 100, width: 1100, height: 700 }, area), { x: 100, y: 100, width: 1100, height: 700 })
  // too small: raised to the minimum; off screen: pulled back in
  assert.deepEqual(M.windowBounds('stage', { x: 3000, y: -50, width: 500, height: 300 }, area), { x: 1920 - 980, y: 30, width: 980, height: 620 })
  // a small screen: the stage fills it rather than overflowing
  const small = { x: 0, y: 0, width: 900, height: 600 }
  assert.deepEqual(M.windowBounds('stage', null, small), { x: 0, y: 0, width: 900, height: 600 })
  assert.deepEqual(M.minSize('stage', small), { width: 900, height: 600 })
  assert.deepEqual(M.minSize('stage', area), M.STAGE_MIN)
  // the lyrics window: its default size, or its saved one
  assert.deepEqual(M.windowBounds('compact', null, area), { x: 770, y: 275, width: 380, height: 560 })
  assert.deepEqual(M.windowBounds('compact', { x: 10, y: 40, width: 400, height: 600 }, area), { x: 10, y: 40, width: 400, height: 600 })
  assert.deepEqual(M.minSize('compact', area), M.COMPACT_MIN)
  // a saved size without a position: centred
  assert.deepEqual(M.windowBounds('compact', { width: 400, height: 600 }, area), { x: 760, y: 255, width: 400, height: 600 })
})

test('stageCommand: only the stage\'s commands, each value checked', () => {
  for (const c of ['play-pause', 'next', 'previous', 'shuffle', 'repeat', 'liner-notes']) assert.deepEqual(M.stageCommand(c, 'ignored'), { command: c, value: null })
  assert.deepEqual(M.stageCommand('form', 'stage'), { command: 'form', value: 'stage' })
  assert.deepEqual(M.stageCommand('form', 'compact'), { command: 'form', value: 'compact' })
  assert.equal(M.stageCommand('form', 'big'), null)
  assert.deepEqual(M.stageCommand('seek', '12.5'), { command: 'seek', value: 12.5 })
  for (const bad of [-1, NaN, Infinity, 1e9, 'x', null]) assert.equal(M.stageCommand('seek', bad), null, String(bad))
  assert.deepEqual(M.stageCommand('volume', 0.5), { command: 'volume', value: 0.5 })
  for (const bad of [-0.1, 1.1, 'loud']) assert.equal(M.stageCommand('volume', bad), null, String(bad))
  assert.deepEqual(M.stageCommand('play-item', { index: 3, id: 'i.123:abc', extra: 1 }), { command: 'play-item', value: { index: 3, id: 'i.123:abc' } })
  for (const bad of [null, {}, { index: -1, id: 'a' }, { index: 1.5, id: 'a' }, { index: 1, id: '' }, { index: 1, id: 'a"); evil(' }, { index: 1, id: 'x'.repeat(65) }, { index: M.QUEUE_MAX, id: 'a' }]) {
    assert.equal(M.stageCommand('play-item', bad), null, JSON.stringify(bad))
  }
  assert.equal(M.stageCommand('eval', 'x'), null)
  assert.equal(M.stageCommand(5), null)
})
