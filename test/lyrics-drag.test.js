// The lyrics window's drag regions and sideways scrolling (0.15.39-dev.1 regressions).
//   - Chromium 156 (Electron 45) sends one region per element in document order, the later winning, and
//     doesn't clip a scrolled element's region: lines scrolled up out of #lines kept their no-drag rects
//     over the header, and the window stopped dragging a few seconds into a song. #grip, after #lines in
//     the card, re-marks the header as drag (with holes for the cover and the close button).
//   - scrollIntoView / a scrolling focus() also scroll sideways, which pushed every line's start past
//     the card's left edge. The list scrolls by scrollTop only and never sideways.
const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')

const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8')
const html = read('lyrics.html')
const rule = (sel) => {
  const m = html.match(new RegExp('\\n\\s*' + sel.replace(/[#>.*]/g, '\\$&') + '\\s*\\{([^}]*)\\}'))
  return m ? m[1] : ''
}

test('lyrics: #grip comes after #lines in the card, so its drag rect wins over scrolled lines', () => {
  const card = html.slice(html.indexOf('<div id="card">'), html.indexOf('<div id="say"'))
  const lines = card.indexOf('<div id="lines"')
  const grip = card.indexOf('<div id="grip"')
  assert.ok(lines > 0 && grip > lines, '#grip after #lines')
  assert.match(card.slice(grip), /^<div id="grip" aria-hidden="true"><div id="grip-art"><\/div><div id="grip-close"><\/div><\/div>/)
})

test('lyrics: #grip drags, its holes don\'t, and it takes no pointer events', () => {
  assert.match(rule('#grip'), /-webkit-app-region:\s*drag/)
  assert.match(rule('#grip'), /pointer-events:\s*none/)
  assert.match(rule('#grip > div'), /-webkit-app-region:\s*no-drag/)
  assert.match(html, /new ResizeObserver\(placeGrip\)\.observe\(headerEl\)/)
  assert.match(html, /new ResizeObserver\(placeGrip\)\.observe\(artEl\)/)
})

test('lyrics: the body still drags and #lines, #art, #close are no-drag', () => {
  assert.match(rule('body'), /-webkit-app-region:\s*drag/)
  for (const sel of ['#lines', '#art', '#close']) assert.match(rule(sel), /-webkit-app-region:\s*no-drag/, sel)
})

test('lyrics: the list never scrolls sideways', () => {
  assert.match(rule('#lines'), /overflow-x:\s*hidden/)
  const view = read('lyrics-view.js')
  assert.doesNotMatch(view, /\.scrollIntoView\(/, 'no scrollIntoView (it scrolls inline too)')
  for (const m of view.matchAll(/\.focus\(([^)]*)\)/g)) assert.match(m[1], /preventScroll:\s*true/, 'focus() with preventScroll: ' + m[0])
  assert.match(view, /container\.scrollTo\(\{ top: [^}]*left: 0/)
})
