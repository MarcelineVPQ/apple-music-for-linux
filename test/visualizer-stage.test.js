// Visualizer stage layout: the interlude countdown dots are centred (the lyrics window keeps its sides).
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')

const viz = fs.readFileSync(path.join(__dirname, '..', 'visualizer.html'), 'utf8')
const shared = fs.readFileSync(path.join(__dirname, '..', 'lyrics-view.css'), 'utf8')

test('stage: every side of the dots row is centred, its pop grows from the middle', () => {
  const rule = viz.match(/([^{}]*#lyrics \.dots[^{}]*)\{\s*justify-content:\s*center;\s*\}/)
  assert.ok(rule, 'a #lyrics .dots justify-content:center rule')
  for (const side of ['#lyrics .dots,', '#lyrics .dots.plainside']) assert.ok(rule[1].includes(side), side)
  assert.match(viz, /#lyrics \.dots \.row \{ transform-origin: 50% 50%; \}/)
})

test('lyrics window untouched: the shared CSS still starts the dots at the line\'s start (every singer alike)', () => {
  assert.match(shared, /\.dots\.plainside \{ justify-content: flex-start; \}/)
  assert.doesNotMatch(shared, /\.dots\.(left|right|center)\b/)
})
