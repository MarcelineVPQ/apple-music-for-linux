// Every local module the shipped app loads is in the AppImage (package.json build.files). 0.15.85-dev.1's build had
// player-time.js missing and could not start ("Cannot find module './player-time'"); the startup smoke caught it.
// (package.json itself is always packed by electron-builder.)
'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')

const root = path.join(__dirname, '..')
const files = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).build.files
const listed = (f) => f === 'package.json' || files.some((g) => g === f || (g.endsWith('/**/*') && f.startsWith(g.slice(0, -4) + '/')) || (g.endsWith('/**') && f.startsWith(g.slice(0, -2))))

test('every local require of a shipped .js file is in build.files, and so on down', () => {
  const seen = new Set()
  const todo = ['main.js']
  const missing = []
  // loop: NOT-WORTH — a test: the shipped modules, once
  while (todo.length) {
    const f = todo.pop()
    if (seen.has(f)) continue
    seen.add(f)
    if (!listed(f)) missing.push(f)
    const src = fs.readFileSync(path.join(root, f), 'utf8')
    // loop: NOT-WORTH — a test
    for (const m of src.matchAll(/require\(\s*['"](\.\/[^'"]+)['"]\s*\)/g)) {
      let r = path.normalize(path.join(path.dirname(f), m[1]))
      if (!r.endsWith('.js') && !r.endsWith('.json')) r += fs.existsSync(path.join(root, r + '.js')) ? '.js' : '.json'
      if (r.endsWith('.js')) todo.push(r)
      else if (!listed(r)) missing.push(r)
    }
  }
  assert.deepEqual(missing, [], 'not in package.json build.files: ' + missing.join(', '))
  assert.ok(seen.has('player-time.js'))
})
