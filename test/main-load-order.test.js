// main.js runs top to bottom at start: a top-level `const X = require(...)` used by top-level code
// above it throws "Cannot access 'X' before initialization" and Sonata never starts (0.15.68).
const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')

test('main.js: no top-level code uses a required module before its require line', () => {
  const lines = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8').split('\n')
  const defs = []
  lines.forEach((l, i) => {
    const m = l.match(/^const (\w+) = require\(/)
    if (m) defs.push({ name: m[1], line: i })
  })
  const bad = []
  for (const d of defs) {
    for (let i = 0; i < d.line; i++) {
      // only statements at column 0 run at load; code inside functions (indented) runs later
      if (/^\S/.test(lines[i]) && !/^\s*\/\//.test(lines[i]) && new RegExp('\\b' + d.name + '\\b').test(lines[i])) {
        bad.push(d.name + ' used on line ' + (i + 1) + ', required on line ' + (d.line + 1))
      }
    }
  }
  assert.deepStrictEqual(bad, [])
})
