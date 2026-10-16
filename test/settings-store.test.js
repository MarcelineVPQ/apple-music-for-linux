// Settings and lyrics cache: damaged-file recovery (keep what reads, defaults only where damaged, a
// copy aside, one notice) and atomic saves.
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')
const S = require('../settings-store')
const { salvageObject, salvageArrayMember, asideName } = require('../json-salvage')
const { createLyricsStore } = require('../lyrics-store')

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'sonata-settings-'))
const NOW = () => new Date('2026-10-16T12:30:05Z')

test('salvage: a truncated or garbled object keeps every member that still reads', () => {
  const good = JSON.stringify({ a: true, b: { x: 1, y: [1, 2] }, c: 'he said "hi", ok', d: 3 }, null, 2)
  assert.deepEqual(salvageObject(good).values, JSON.parse(good))
  // truncated in the middle of the last member
  const cut = good.slice(0, good.indexOf('"d"') + 4)
  assert.deepEqual(salvageObject(cut).values, { a: true, b: { x: 1, y: [1, 2] }, c: 'he said "hi", ok' })
  assert.equal(salvageObject(cut).bad, 1)
  // a stray byte inside one value
  const garbled = good.replace('true', 'tr\u0000ue')
  const g = salvageObject(garbled)
  assert.equal(g.values.a, undefined)
  assert.equal(g.values.d, 3)
  assert.equal(g.bad, 1)
  assert.deepEqual(salvageObject('').values, {})
  assert.equal(salvageObject('zzz').bad, 1)
})

test('salvage: an array member keeps its readable items', () => {
  const t = '{"version":1,"entries":[["a",{"x":1}],["b",{"y":[1,2]}],["c",{"z":'
  const r = salvageArrayMember(t, 'entries')
  assert.deepEqual(r.items, [['a', { x: 1 }], ['b', { y: [1, 2] }]])
  assert.equal(r.bad, 1)
  assert.equal(salvageArrayMember('{}', 'entries').found, false)
  assert.equal(asideName('/x/settings.json', NOW()), '/x/settings.json.corrupt-2026-10-16T12-30-05')
})

test('settings: no file -> defaults, no notice; a good file -> as stored (unknown keys kept), no notice', () => {
  const d = tmp()
  const f = path.join(d, 'settings.json')
  assert.deepEqual(S.loadSettings(f), { settings: S.defaults(), recovery: null })
  fs.writeFileSync(f, JSON.stringify({ closeToTray: true, winPos: { a: 1 }, updateChannel: 'dev' }))
  const r = S.loadSettings(f)
  assert.equal(r.recovery, null)
  assert.equal(r.settings.closeToTray, true)
  assert.equal(r.settings.updateChannel, 'dev')
  assert.deepEqual(r.settings.winPos, { a: 1 })
  assert.equal(r.settings.glass, true)
  assert.equal(fs.readdirSync(d).length, 1, 'nothing copied aside')
})

test('settings: a damaged file keeps what reads, resets only the damage, copies the file aside, writes the repair', () => {
  const d = tmp()
  const f = path.join(d, 'settings.json')
  const stored = Object.assign(S.defaults(), { closeToTray: true, launchAtLogin: true, updateChannel: 'dev', windowBounds: { x: 1, y: 2, width: 1200, height: 800 } })
  const text = JSON.stringify(stored, null, 2)
  // a crash cut the file after windowBounds' first half
  const cut = text.slice(0, text.indexOf('"windowBounds"') + 30)
  fs.writeFileSync(f, cut)
  const r = S.loadSettings(f, { now: NOW })
  assert.ok(r.recovery)
  assert.equal(r.settings.closeToTray, true)
  assert.equal(r.settings.launchAtLogin, true)
  assert.equal(r.settings.updateChannel, 'stable', 'lost with the cut tail: its default')
  assert.equal(r.settings.windowBounds, null, 'the damaged member is back to its default')
  assert.equal(r.recovery.unread, 1)
  assert.equal(r.recovery.aside, f + '.corrupt-2026-10-16T12-30-05')
  assert.equal(fs.readFileSync(r.recovery.aside, 'utf8'), cut, 'the copy is the damaged file, byte for byte')
  // the repaired file is written back and reads clean
  const again = S.loadSettings(f)
  assert.equal(again.recovery, null)
  assert.equal(again.settings.closeToTray, true)
  const words = S.recoveryText(r.recovery)
  assert.match(words, /damaged/)
  assert.match(words, /settings were kept/)
  assert.match(words, /corrupt-2026-10-16T12-30-05/)
})

test('settings: valid JSON with a wrong kind of value: only that setting goes back, said by name', () => {
  const d = tmp()
  const f = path.join(d, 'settings.json')
  fs.writeFileSync(f, JSON.stringify({ closeToTray: 'yes', updateChannel: 'nightly', notifications: false, panelPins: { settings: ['updates'] } }))
  const r = S.loadSettings(f, { now: NOW })
  assert.equal(r.settings.closeToTray, false)
  assert.equal(r.settings.updateChannel, 'stable')
  assert.equal(r.settings.notifications, false)
  assert.deepEqual(r.settings.panelPins, { settings: ['updates'] })
  assert.deepEqual(r.recovery.reset.sort(), ['Close to tray', 'Update channel'])
  assert.match(S.recoveryText(r.recovery), /Back to default: (Close to tray, Update channel|Update channel, Close to tray)\./)
})

test('settings: validSetting checks every key the panel may set; saves are atomic (no .tmp left)', () => {
  assert.ok(S.validSetting('glass', false))
  assert.ok(!S.validSetting('glass', 'no'))
  assert.ok(!S.validSetting('updateChannel', 'beta'))
  assert.ok(S.validSetting('lyricsArtSpinSpeed', 'true'))
  assert.ok(!S.validSetting('nope', true))
  assert.ok(!S.validSetting('__proto__', {}))
  const d = tmp()
  const f = path.join(d, 'sub', 'settings.json')
  S.saveSettings(f, S.defaults())
  assert.deepEqual(fs.readdirSync(path.dirname(f)), ['settings.json'])
  assert.deepEqual(JSON.parse(fs.readFileSync(f, 'utf8')), S.defaults())
})

test('lyrics cache: a damaged file keeps the songs that read, copies itself aside, reports once', async () => {
  const d = tmp()
  const f = path.join(d, 'lyrics-cache.json')
  const entries = [['a|x', { lines: [1] }], ['b|y', { lines: [2] }], ['c|z', { lines: [3] }]]
  const text = JSON.stringify({ version: 1, entries })
  fs.writeFileSync(f, text.slice(0, text.length - 12))   // the last entry cut
  const got = []
  const store = createLyricsStore({ file: f, debounceMs: 0, now: NOW, onRecovered: (r) => got.push(r) })
  assert.deepEqual(store.get('a|x'), { lines: [1] })
  assert.deepEqual(store.get('b|y'), { lines: [2] })
  assert.equal(store.get('c|z'), null)
  assert.equal(got.length, 1)
  assert.equal(got[0].kept, 2)
  assert.equal(got[0].dropped, 1)
  assert.ok(fs.existsSync(got[0].aside))
  // repaired on disk at once: a new store reads it clean, no second notice
  const got2 = []
  const again = createLyricsStore({ file: f, onRecovered: (r) => got2.push(r) })
  assert.equal(again.size, 2)
  assert.equal(got2.length, 0)
  // no file at all: empty, no notice
  const none = []
  assert.equal(createLyricsStore({ file: path.join(d, 'missing.json'), onRecovered: (r) => none.push(r) }).size, 0)
  assert.equal(none.length, 0)
})
