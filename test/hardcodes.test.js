// tools/hardcodes.js: the gate against user-facing values typed where a single source exists. Each rule
// gets a seeded mistake it must catch and a correct line it must let through; the shipped files pass.
const test = require('node:test')
const assert = require('node:assert')
const path = require('path')
const H = require('../tools/hardcodes')

const rules = (line, file) => H.scanText(file || 'x.js', line + '\n').findings.map((f) => f.rule)

test('raw-version: text built from a raw version fails; through version-display.js passes', () => {
  assert.deepEqual(rules("toast('Sonata ' + app.getVersion() + ' is up to date')"), ['raw-version'])
  assert.deepEqual(rules("text: 'Sonata ' + st.version + ' is available'"), ['raw-version'])
  assert.deepEqual(rules("const t = 'engine ' + (alignEngineVersion() || '')"), ['raw-version'])
  assert.deepEqual(rules("const t = 'engine ' + versionDisplay.short(alignEngineVersion())"), [])
  assert.deepEqual(rules("const t = 'v' + (s.version || '')"), ['raw-version'])
  assert.deepEqual(rules('const t = `Sonata ${version} is ready`'), ['raw-version'])
  assert.deepEqual(rules("text: V.full(st.version) + ' is available'"), [])
  assert.deepEqual(rules("tip: name + (s.version ? ' · ' + V.tagged(s.version) : '')"), [])
  assert.deepEqual(rules("text: 'Updated to ' + V.full(v) + '.'"), [])
})

test('channel-name, repo-url, user-agent, number-text', () => {
  assert.deepEqual(rules("const ch = channel === 'dev' ? 'Development' : 'Stable'"), ['channel-name'])
  assert.deepEqual(rules("return 'Stable ' + v"), ['channel-name'])
  assert.deepEqual(rules("desc: 'Development builds before they\\'re released'"), [], 'prose is not a label')
  assert.deepEqual(rules("const REPO_URL = 'https://github.com/MarcelineVPQ/apple-music-for-linux'"), ['repo-url'])
  assert.deepEqual(rules("const ua = 'Sonata/' + v"), ['user-agent'])
  assert.deepEqual(rules("desc: 'At start and every 2 hours.'"), ['number-text'])
  assert.deepEqual(rules("note: 'at most 1,000 songs'"), ['number-text'])
  assert.deepEqual(rules("note: 'at most ' + n + ' songs'"), [])
})

test('the marker, comments, developer logs and the one place itself are not findings', () => {
  const marked = H.scanText('x.js', "dismissKey: 'update:' + st.version   // hardcode: OK — a key\n")
  assert.equal(marked.findings.length, 0)
  assert.equal(marked.allowed.length, 1)
  assert.equal(H.scanText('x.js', "// hardcode: OK — the folder name\nconst d = 'engine-' + version\n").findings.length, 0, 'the line above counts')
  assert.deepEqual(rules("// says 'Sonata ' + st.version once"), [])
  assert.deepEqual(rules("console.log('align: helper v' + pong.version)"), [])
  assert.deepEqual(rules("const x = 'a' // 'Stable'"), [], 'a trailing comment is not code')
  assert.equal(H.scanText('version-display.js', "const CHANNELS = { stable: 'Stable' }\n").findings.length, 0)
})

test('html pages: only the inline scripts are read', () => {
  assert.deepEqual(H.scanText('p.html', "<p>every 2 hours</p>\n<script>\nconst t = 'every 2 hours'\n</script>\n").findings.map((f) => f.line), [3])
})

test('the shipped files pass (npm run gates runs node tools/hardcodes.js --check)', () => {
  const r = H.scan(path.join(__dirname, '..'))
  assert.deepEqual(r.findings.map((f) => f.file + ':' + f.line + ' ' + f.rule), [])
  assert.match(require('../package.json').scripts.gates, /node tools\/hardcodes\.js --check/)
})
