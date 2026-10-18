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
  assert.deepEqual(q.items[0], { index: 0, id: '5', title: 'A', artist: '', album: '', duration: 200, art: '', autoplay: false, albumId: '', composer: '' })
  // a row's album id (Go to Album) is digits only; its composer (the row's Credits) is text
  const q2 = M.cleanQueue({ items: [{ id: 'a', albumId: '1440892370', composer: 'B. Berry' }, { id: 'b', albumId: '12;alert(1)' }] })
  assert.equal(q2.items[0].albumId, '1440892370')
  assert.equal(q2.items[0].composer, 'B. Berry')
  assert.equal(q2.items[1].albumId, '')
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

test('one list: the played songs (dimmed), the one playing, the next card\'s place, then the rest; the next song only in the card', () => {
  const q = M.cleanQueue(album())
  const v = M.queueList(q)
  assert.equal(v.next.title, 'Song 14')
  // 12 played + the one playing + 12 after the card (songs 15-24 and the 2 autoplay ones)
  assert.equal(v.rows.length, 12 + 1 + 12)
  assert.deepEqual(v.rows.slice(0, 12).map((r) => r.played), Array(12).fill(true))
  assert.equal(v.rows[12].cur, true)
  assert.equal(v.rows[12].title, 'Song 13')
  assert.equal(v.cardAt, 12)
  assert.equal(v.rows[13].title, 'Song 15')
  assert.equal(v.rows[13].index, 14)
  assert.ok(!v.rows.some((r) => r.title === 'Song 14'), 'the next song is only in the card')
  assert.equal(v.rows[13].sub, 'The Band · Wayfarers')
  assert.equal(v.rows[13].time, '4:00')
  assert.equal(v.rows[24].autoplay, true)
  assert.equal(v.last, false)
  assert.equal(v.earlier, 0)
  assert.equal(v.later, 0)
  // the start of an album: nothing played, the card right after the song playing
  const start = M.queueList(M.cleanQueue({ position: 0, items: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] }))
  assert.deepEqual(start.rows.map((r) => r.index), [0, 2])
  assert.equal(start.cardAt, 0)
  // the card's song is the last one: nothing after the card
  const pen = M.queueList(M.cleanQueue({ position: 1, items: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] }))
  assert.deepEqual(pen.rows.map((r) => r.index), [0, 1])
  assert.equal(pen.next.id, 'c')
  // the last song playing: no card, the list ends with it, and it says so (last)
  const end = M.queueList(M.cleanQueue({ position: 2, items: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] }))
  assert.deepEqual(end.rows.map((r) => r.index), [0, 1, 2])
  assert.equal(end.cardAt, -1)
  assert.equal(end.next, null)
  assert.equal(end.last, true)
  // nothing playing: the queue from its start, no card
  const none = M.queueList(M.cleanQueue({ position: -1, items: [{ id: 'a' }, { id: 'b' }] }))
  assert.deepEqual(none.rows.map((r) => r.index), [0, 1])
  assert.equal(none.cardAt, -1)
  // autoplay songs follow the same rule: the next one is in the card only
  const ap = M.queueList(M.cleanQueue({ position: 0, items: [{ id: 'a' }, { id: 'b', autoplay: true }, { id: 'c', autoplay: true }] }))
  assert.deepEqual(ap.rows.map((r) => r.index), [0, 2])
  assert.equal(ap.next.autoplay, true)
  assert.equal(M.queueList(M.cleanQueue({ position: 0, items: [{ title: '' }, { title: '' }] })).rows[0].title, 'Untitled')
  assert.deepEqual(M.queueList(null).rows, [])
})

test('one list: long queues show a window (the last 50 played, "N earlier"; 150 after the card, "N more")', () => {
  const big = M.cleanQueue({ position: 400, items: Array.from({ length: 1000 }, (_, i) => ({ id: 'x' + i, title: 'T' + i, duration: 200 })) })
  const v = M.queueList(big)
  assert.equal(v.earlier, 350)
  assert.equal(v.rows[0].index, 350)
  assert.equal(v.rows.filter((r) => r.played).length, M.PLAYLIST_BEFORE)
  assert.equal(v.rows[v.cardAt].index, 400)
  assert.equal(v.rows[v.cardAt + 1].index, 402)
  assert.equal(v.rows.length, 50 + 1 + 150)
  assert.equal(v.rows[v.rows.length - 1].index, 551)
  assert.equal(v.later, 1000 - 552)
  assert.equal(v.total, 1000)
  // near the start: from the first song, nothing earlier
  assert.equal(M.queueList(M.cleanQueue({ position: 3, items: big.items })).earlier, 0)
})

test('labels: "Playing from" only when Apple names it', () => {
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

test('stageCommand: the song\'s actions, the menus\' anchors and a row\'s menu, each value checked', () => {
  for (const c of ['song-library', 'song-link', 'song-album', 'song-artist', 'credits-liner', 'liner-recording']) assert.deepEqual(M.stageCommand(c, 'x'), { command: c, value: null })
  assert.deepEqual(M.stageCommand('song-favorite', true), { command: 'song-favorite', value: true })
  assert.deepEqual(M.stageCommand('song-favorite', false), { command: 'song-favorite', value: false })
  for (const bad of [1, 'true', null, undefined]) assert.equal(M.stageCommand('song-favorite', bad), null, String(bad))
  assert.deepEqual(M.stageCommand('song-more', { x: 10, y: 400, z: 1 }), { command: 'song-more', value: { x: 10, y: 400 } })
  assert.deepEqual(M.stageCommand('song-playlists', { x: 0, y: 0 }), { command: 'song-playlists', value: { x: 0, y: 0 } })
  for (const bad of [null, {}, { x: -1, y: 0 }, { x: 1.5, y: 2 }, { x: 1, y: 1e6 }, { x: '1', y: 2 }]) {
    assert.equal(M.stageCommand('song-more', bad), null, JSON.stringify(bad))
    assert.equal(M.stageCommand('song-playlists', bad), null, JSON.stringify(bad))
  }
  assert.deepEqual(M.stageCommand('row-menu', { index: 4, id: 'pd5', x: 900, y: 300 }), { command: 'row-menu', value: { index: 4, id: 'pd5', x: 900, y: 300 } })
  for (const bad of [{ index: 4, id: 'pd5' }, { index: -1, id: 'a', x: 1, y: 1 }, { index: 1, id: 'a"', x: 1, y: 1 }, { index: M.QUEUE_MAX, id: 'a', x: 1, y: 1 }]) assert.equal(M.stageCommand('row-menu', bad), null, JSON.stringify(bad))
})

test('lineStep: ↓ the next line\'s start, ↑ this line\'s start after 1.5 s of it, else the one before', () => {
  const L = [{ t: 1 }, { t: 5 }, { t: 9 }, { t: null }]
  assert.equal(M.lineStep(L, 6, 1), 9)
  assert.equal(M.lineStep(L, 0, 1), 1)
  assert.equal(M.lineStep(L, 9.5, 1), null)
  assert.equal(M.lineStep(L, 7, -1), 5)
  assert.equal(M.lineStep(L, 6, -1), 1)
  assert.equal(M.lineStep(L, 1.2, -1), 1)
  assert.equal(M.lineStep(L, 0, -1), null)
  assert.equal(M.lineStep([], 3, 1), null)
  assert.equal(M.lineStep(null, 3, -1), null)
})

test('lineAt: the words sung at a time (the seek bar\'s hover), or nothing before the first line', () => {
  const L = [{ t: 1, text: 'That\'s me in the corner' }, { t: 5, text: 'That\'s me in the spotlight' }]
  assert.equal(M.lineAt(L, 0.5), '')
  assert.equal(M.lineAt(L, 3), 'That\'s me in the corner')
  assert.equal(M.lineAt(L, 60), 'That\'s me in the spotlight')
  assert.equal(M.lineAt([{ t: 0, text: 'x'.repeat(400) }], 1).length, 160)
  assert.equal(M.lineAt(null, 1), '')
})
