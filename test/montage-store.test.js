// The Montage's photos on disk (montage-store.js): bounded by size and count, least recently shown
// first, rebuilt from the folder after a restart, only its own file names.
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { createImageStore, nameFor } = require('../montage-store')

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'sonata-montage-test-'))
const bytes = (n, v) => Buffer.alloc(n, v || 1)

test('names: the URL\'s SHA-1 and the type\'s extension', () => {
  assert.match(nameFor('https://upload.wikimedia.org/a.jpg', 'image/jpeg'), /^[0-9a-f]{40}\.jpg$/)
  assert.match(nameFor('https://upload.wikimedia.org/a.png', 'image/png'), /^[0-9a-f]{40}\.png$/)
  assert.notEqual(nameFor('https://x/1280px-a.jpg'), nameFor('https://x/1920px-a.jpg'), 'each width its own file')
})

test('bounded by size: the least recently shown photo goes first, never the one just written', () => {
  const dir = tmp()
  let t = 1000
  const s = createImageStore({ dir, maxBytes: 3000, maxFiles: 100, now: () => (t += 1000) })
  const n = (i) => nameFor('u' + i)
  s.put(n(1), bytes(1000)); s.put(n(2), bytes(1000)); s.put(n(3), bytes(1000))
  assert.ok(s.get(n(1)), 'photo 1 shown again: now the most recent')
  s.put(n(4), bytes(1000))
  assert.equal(s.has(n(2)), false, 'the least recently shown went')
  assert.ok(s.has(n(1)) && s.has(n(3)) && s.has(n(4)))
  assert.deepEqual(s.size(), { bytes: 3000, files: 3 })
  assert.equal(fs.existsSync(path.join(dir, n(2))), false, 'its file is gone from disk')
  s.put(n(5), bytes(5000))
  assert.ok(s.has(n(5)), 'a photo larger than the bound is still kept (alone)')
  assert.equal(s.size().files, 1)
  fs.rmSync(dir, { recursive: true, force: true })
})

test('bounded by count', () => {
  const dir = tmp()
  let t = 0
  const s = createImageStore({ dir, maxBytes: 1e9, maxFiles: 3, now: () => ++t })
  for (let i = 0; i < 6; i++) s.put(nameFor('c' + i), bytes(10))   // loop: NOT-WORTH — test only
  assert.equal(s.size().files, 3)
  assert.equal(fs.readdirSync(dir).length, 3)
  fs.rmSync(dir, { recursive: true, force: true })
})

test('after a restart: the index comes back from the folder (sizes, use order); strays and temp files ignored', () => {
  const dir = tmp()
  let t = 1000
  const a = createImageStore({ dir, maxBytes: 1e9, now: () => (t += 1000) })
  a.put(nameFor('r1'), bytes(100)); a.put(nameFor('r2'), bytes(200))
  fs.writeFileSync(path.join(dir, 'notes.txt'), 'x')
  fs.writeFileSync(path.join(dir, nameFor('r3') + '.tmp'), 'x')
  const b = createImageStore({ dir, maxBytes: 250, now: () => (t += 1000) })
  assert.deepEqual(b.size(), { bytes: 300, files: 2 })
  assert.ok(b.get(nameFor('r2')))
  assert.equal(b.get('../../etc/passwd'), null, 'only its own names')
  assert.equal(b.put('evil.jpg', bytes(10)), null)
  b.put(nameFor('r4'), bytes(10))
  assert.equal(b.has(nameFor('r1')), false, 'r1 (least recently used) made room')
  fs.rmSync(dir, { recursive: true, force: true })
})

test('a photo missing from disk is a miss, not an error', () => {
  const dir = tmp()
  const s = createImageStore({ dir })
  const n = nameFor('gone')
  s.put(n, bytes(10))
  fs.unlinkSync(path.join(dir, n))
  assert.equal(s.get(n), null)
  fs.rmSync(dir, { recursive: true, force: true })
  assert.equal(createImageStore({ dir: path.join(dir, 'never') }).get(n), null, 'no folder yet')
})

// QC 2026-10 CACHE_PASS C5: a photo that vanished behind the store left its bytes in the total
test('a photo file that vanished leaves the byte total too', () => {
  const dir = tmp()
  let t = 0
  const s = createImageStore({ dir, maxBytes: 1e9, maxFiles: 100, now: () => ++t })
  const n = (i) => nameFor('v' + i)
  s.put(n(1), bytes(1000)); s.put(n(2), bytes(500))
  fs.rmSync(path.join(dir, n(1)))
  assert.equal(s.get(n(1)), null)
  assert.deepEqual(s.size(), { bytes: 500, files: 1 })
  fs.rmSync(dir, { recursive: true, force: true })
})
