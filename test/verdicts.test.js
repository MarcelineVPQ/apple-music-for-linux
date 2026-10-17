// The verdict gate (42PS Standard, docs/PERFORMANCE.md): every loop, acquisition and error path in
// every file Sonata ships carries a verdict. The lister is tools/verdicts.js (`--check` in CI); this
// runs it in `npm test` and checks the lister itself finds what it should.
const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('path')
const V = require('../tools/verdicts')

test('every loop, acquisition and error path in every shipped file has a verdict', () => {
  const bad = V.failures(V.scan(path.join(__dirname, '..')))
  assert.deepEqual(bad.map((r) => r.file + ':' + r.line + ' ' + r.kind + ' ' + r.code), [], 'run node tools/verdicts.js --check')
})

test('the lister covers every shipped .js file and page', () => {
  const files = V.shippedFiles(path.join(__dirname, '..'))
  for (const f of ['main.js', 'lyrics.html', 'miniplayer.html', 'visualizer.html', 'audio-listen.js', 'align-helper.js', 'updater.js']) assert.ok(files.includes(f), f)
})

test('the lister: what counts as a candidate and as a verdict', () => {
  const P = V.PATTERNS
  for (const s of ['for (const x of y) {', 'while (i < 3) {', 'list.forEach((x) => {', 'do {']) assert.ok(P.loop.test(s), s)
  for (const s of ["setTimeout(f, 10)", "el.addEventListener('click', f)", "proc.stdout.on('data', f)", "ipcMain.handle('x', f)", "img.onload = () => {}", "spawn('parec', a)", "new MutationObserver(f)", "new BrowserWindow({})"]) assert.ok(P.lifetime.test(s), s)
  for (const s of ['re.exec(text)', 'const m = /x/.exec(s)', 'list.map((x) => x)']) assert.ok(!P.lifetime.test(s) && !P.loop.test(s), s)
  for (const s of ['} catch (e) {', 'try { a() } catch { }', 'p.catch((e) => log(e))']) assert.ok(P.error.test(s), s)
  // only the inline scripts of a page are code
  const lines = V.codeLines('x.html', '<style>for (x) {}</style>\n<script>\nfor (const a of b) {}\n</script>\n<p>while (true)</p>')
  assert.deepEqual(lines.map((l) => l.trim()), ['', '', 'for (const a of b) {}', '', ''])
})
