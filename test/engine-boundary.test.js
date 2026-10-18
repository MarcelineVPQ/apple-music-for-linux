// The engine boundary (docs/LEVEL2-ALIGN.md "Install"): Precise timing's helper is a separate program,
// the Sonata engine, installed from its own release (align/engine.json). Its code never comes back into
// Sonata's repository, build or source archive: Sonata keeps only the generic bootstrap (align/install.sh),
// the pin, and the protocol client. This gate fails when engine files reappear.
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')
const { spawnSync } = require('child_process')

const ROOT = path.join(__dirname, '..')
// the engine's modules and files as they were in Sonata up to 0.15.44 (and their likely successors)
const ENGINE_NAMES = /(^|\/)(server|sonata_align|notes_step|notes|sung_notes|rmvpe|expr|bench|bench_standard|bench_transcribe|test_align|test_notes|test_licence|notes-log)\.py$|(^|\/)align\/(sonata-align|requirements\.txt|setup-venv\.sh|main\.py)$|\.(so|pyd|pyc)$/
const ALIGN_ALLOWED = ['install.sh', 'engine.json']

function tracked() {
  const r = spawnSync('git', ['-C', ROOT, 'ls-files', '-z'], { encoding: 'utf8' })
  if (r.status !== 0) return null   // a source archive without .git: the folder walk below still runs
  return r.stdout.split('\0').filter(Boolean)
}

test('boundary: align/ holds only the bootstrap and the pin', () => {
  const extra = fs.readdirSync(path.join(ROOT, 'align')).filter((f) => !ALIGN_ALLOWED.includes(f) && f !== '__pycache__')
  assert.deepEqual(extra, [], 'engine files in align/: ' + extra.join(', ') + ' (the engine lives in its own repository and release)')
})

test('boundary: no engine file is tracked anywhere, and no Python in align/', () => {
  const files = tracked()
  if (!files) return
  const bad = files.filter((f) => ENGINE_NAMES.test(f) || (f.startsWith('align/') && !ALIGN_ALLOWED.includes(f.slice(6))))
  assert.deepEqual(bad, [], 'engine files tracked: ' + bad.join(', '))
})

test('boundary: the build ships and unpacks no Python and no engine module', () => {
  const b = require('../package.json').build
  const shipped = [].concat(b.files || [], b.asarUnpack || [], b.extraResources || [], b.extraFiles || []).map((x) => (typeof x === 'string' ? x : x.from || ''))
  const bad = shipped.filter((f) => /\.py$|\*\*|align\/\*/.test(f) || ENGINE_NAMES.test(f))
  assert.deepEqual(bad, [], 'build entries that would ship engine code: ' + bad.join(', '))
  assert.ok(b.files.includes('align/install.sh') && b.files.includes('align/engine.json'))
})

test('boundary: the client spawns the installed engine, never a script from the app folder', () => {
  const src = fs.readFileSync(path.join(ROOT, 'align-helper.js'), 'utf8')
  assert.doesNotMatch(src, /app\.asar\.unpacked/)
  assert.match(src, /'engine-' \+ version/)
})
