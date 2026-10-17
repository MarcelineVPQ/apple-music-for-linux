// The verdict gate (DS5 / AVIEW rule, docs/PERFORMANCE.md): in Sonata's UI and model code, every
// loop, timer, listener and observer carries a `// loop:` or `// lifetime:` verdict, and every catch an
// `// error:` verdict (what happens to the failure). Mechanical: this lists every candidate line.
// Covers every file written or rewritten since the rail (0.15.29+); older files get theirs as they're touched.
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')

const FILES = [
  'rail-ui.js', 'apple-focus.js', 'preload-rail-view.js', 'rail-model.js',
  'panel-ui.js', 'panel-model.js', 'preload-panel.js', 'toast-ui.js',
  'theme.js', 'theme-apply.js', 'icons.js',
  'notices-model.js', 'updater.js', 'settings-store.js', 'json-salvage.js', 'about-data.js', 'markdown-lite.js',
  'lyrics-store.js', 'update-feed.js', 'wheel-volume.js', 'mini-model.js', 'desktop-scheme.js', 'relaunch.js'
]
const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8')
const isComment = (l) => /^\s*(\/\/|\*|\/\*)/.test(l)

// a verdict for line i: on the line itself, or in the comment lines just above it (up to `reach`
// lines, skipping blank lines and other code-free lines), or the enclosing function's header comment
function hasVerdict(lines, i, kinds, reach) {
  const re = new RegExp('// (' + kinds.join('|') + '):')
  if (re.test(lines[i])) return true
  for (let k = i - 1; k >= Math.max(0, i - reach); k--) if (re.test(lines[k])) return true
  return false
}

test('every loop, timer, listener and observer in the new code has a loop/lifetime verdict', () => {
  const missing = []
  for (const f of FILES) {
    const lines = read(f).split('\n')
    lines.forEach((l, i) => {
      if (isComment(l)) return
      const code = l.replace(/\/\/.*$/, '').replace(/'[^']*'|"[^"]*"|`[^`]*`/g, "''")
      if (/\b(for|while)\s*\(|\.forEach\(|\bsetInterval\(|\bsetTimeout\(|addEventListener\(|new MutationObserver|ipcRenderer\.on\(|requestAnimationFrame\(/.test(code)) {
        if (!hasVerdict(lines, i, ['loop', 'lifetime'], 8)) missing.push(f + ':' + (i + 1) + ': ' + l.trim())
      }
    })
  }
  assert.deepEqual(missing, [], 'no verdict:\n' + missing.join('\n'))
})

test('every catch in the new code says what happens to the failure (// error:)', () => {
  const missing = []
  for (const f of FILES) {
    const lines = read(f).split('\n')
    lines.forEach((l, i) => {
      if (isComment(l) || !/\bcatch\s*\(|\.catch\(/.test(l.replace(/\/\/.*$/, ''))) return
      const near = lines.slice(Math.max(0, i - 6), i + 4).join('\n')
      if (!/\/\/ error:|\/\* error:/.test(near)) missing.push(f + ':' + (i + 1) + ': ' + l.trim())
    })
  }
  assert.deepEqual(missing, [], 'no error verdict:\n' + missing.join('\n'))
})

test('main.js: every timer and every ipcMain handler carries a verdict', () => {
  const lines = read('main.js').split('\n')
  const missing = []
  lines.forEach((l, i) => {
    if (isComment(l)) return
    if (/\bsetInterval\(|ipcMain\.(on|handle)\(/.test(l) && !hasVerdict(lines, i, ['loop', 'lifetime'], 14)) missing.push((i + 1) + ': ' + l.trim())
  })
  assert.deepEqual(missing, [], missing.join('\n'))
})
