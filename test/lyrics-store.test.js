const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { createLyricsStore } = require('../lyrics-store')

const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sonata-store-')), 'lyrics-cache.json')

test('store: set, flush to disk, reload in a new store', () => {
  const file = tmp()
  const a = createLyricsStore({ file, debounceMs: 60000 })
  a.set('T|A', { lines: [{ t: 1, text: 'x' }], source: 'apple' })
  a.flush()
  const b = createLyricsStore({ file })
  assert.deepEqual(b.get('T|A'), { lines: [{ t: 1, text: 'x' }], source: 'apple' })
  assert.equal(b.get('nope'), null)
})

test('store: bounded by entries, least recently used goes first', () => {
  const s = createLyricsStore({ file: tmp(), maxEntries: 2, debounceMs: 60000 })
  s.set('a', { lines: [1] }); s.set('b', { lines: [2] })
  s.get('a')                       // a is now the most recent
  s.set('c', { lines: [3] })
  assert.equal(s.get('b'), null)
  assert.ok(s.get('a') && s.get('c'))
})

test('store: bounded by size', () => {
  const s = createLyricsStore({ file: tmp(), maxBytes: 200, debounceMs: 60000 })
  for (let i = 0; i < 20; i++) s.set('k' + i, { lines: ['x'.repeat(40)] })
  assert.ok(s.bytes <= 200)
  assert.ok(s.get('k19'))
  assert.equal(s.get('k0'), null)
})

test('store: unreadable file starts empty, no throw', () => {
  const file = tmp()
  fs.writeFileSync(file, '{broken')
  const s = createLyricsStore({ file })
  assert.equal(s.size, 0)
})
