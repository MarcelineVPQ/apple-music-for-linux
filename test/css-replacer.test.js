const test = require('node:test')
const assert = require('node:assert/strict')
const { createCssReplacer } = require('../css-replacer')

// fake webContents that tracks live injected sheets like Chromium does
function fakeWc() {
  let n = 0
  const live = new Set()
  return {
    live,
    insertCSS: async () => { const k = 'k' + (++n); live.add(k); return k },
    removeInsertedCSS: async (k) => { if (!live.delete(k)) throw new Error('stale key') }
  }
}

test('repeated applies keep exactly one sheet', async () => {
  const wc = fakeWc()
  const apply = createCssReplacer(wc, 'x{}')
  for (let i = 0; i < 200; i++) await apply()
  assert.equal(wc.live.size, 1)
})

test('overlapping applies still end with one sheet', async () => {
  const wc = fakeWc()
  const apply = createCssReplacer(wc, 'x{}')
  await Promise.all([apply(), apply(), apply()])
  assert.equal(wc.live.size, 1)
})

test('stale key from a previous document is ignored', async () => {
  const wc = fakeWc()
  const apply = createCssReplacer(wc, 'x{}')
  await apply()
  wc.live.clear() // full navigation: the old document's sheets are gone
  await apply()
  assert.equal(wc.live.size, 1)
})

test('insert failure does not throw', async () => {
  const apply = createCssReplacer({ insertCSS: async () => { throw new Error('gone') } }, 'x{}')
  await apply()
})
