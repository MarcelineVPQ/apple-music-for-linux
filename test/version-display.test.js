// version-display.js: the one place versions, channels and the product name are shown (Marcy 2026-10-18:
// the toast said "Sonata 0.15.45-dev.1 is up to date (Development)."; it must say "0.15.45 Dev").
const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')
const vm = require('vm')
const V = require('../version-display')
const U = require('../updater')
const A = require('../about-data')
const R = require('../rail-model')

const DEV = '0.15.45-dev.1'
const noDev = (s, what) => assert.doesNotMatch(String(s), /-dev\b/, what + ' shows the dev number: ' + s)

test('short / full / tagged: people see "0.15.45 Dev", never the dev number; stable stays as it is', () => {
  assert.equal(V.short(DEV), '0.15.45 Dev')
  assert.equal(V.short('0.15.45-dev.12'), '0.15.45 Dev')
  assert.equal(V.short('v0.15.45-dev.3'), '0.15.45 Dev')
  assert.equal(V.short('0.15.18'), '0.15.18')
  assert.equal(V.short('0.2.1'), '0.2.1', 'engine versions too')
  assert.equal(V.short(''), '')
  assert.equal(V.short(null), '')
  assert.equal(V.full(DEV), 'Sonata 0.15.45 Dev')
  assert.equal(V.full('0.15.18'), 'Sonata 0.15.18')
  assert.equal(V.tagged(DEV), 'v0.15.45 Dev')
  assert.equal(V.tagged(''), '')
})

test('channel names and the product identity come from here', () => {
  assert.equal(V.channelName('dev'), 'Development')
  assert.equal(V.channelName('stable'), 'Stable')
  assert.equal(V.channelName(undefined), 'Stable')
  assert.equal(V.NAME, 'Sonata')
  assert.equal(V.userAgent('0.15.40'), 'Sonata/0.15.40 (https://github.com/MarcelineVPQ/apple-music-for-linux)', 'servers get the raw version')
})

test('this build\'s own forms sit next to the source of truth (package.json)', () => {
  const pkg = require('../package.json')
  assert.equal(V.CURRENT, pkg.version)
  assert.equal(V.SHORT, V.short(pkg.version))
  assert.equal(V.FULL, 'Sonata ' + V.short(pkg.version))
  noDev(V.FULL, 'FULL')
})

test('the page world: a plain script gives a frozen SonataVersionDisplay (panel.html and rail.html load it first)', () => {
  const ctx = vm.createContext({})
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'version-display.js'), 'utf8'), ctx)
  const G = vm.runInContext('globalThis.SonataVersionDisplay', ctx)
  assert.ok(Object.isFrozen(G))
  assert.equal(G.short(DEV), '0.15.45 Dev')
  // loop: NOT-WORTH — two pages
  for (const page of ['panel.html', 'rail.html']) {
    const html = fs.readFileSync(path.join(__dirname, '..', page), 'utf8')
    const at = html.indexOf('<script src="version-display.js">')
    assert.ok(at > 0 && at < html.indexOf('<script src="rail-model.js">'), page + ' loads version-display.js before its models')
  }
  assert.ok(require('../package.json').build.files.includes('version-display.js'), 'it ships')
})

test('every update text people read (toasts, notices, notifications, status line) shows no dev number', () => {
  const states = [
    { phase: 'available', version: '0.15.46-dev.2', size: 130e6 },
    { phase: 'available', version: '0.15.44', size: 130e6, older: true },
    { phase: 'downloading', version: '0.15.46-dev.2', got: 1, total: 2 },
    { phase: 'installing', version: '0.15.46-dev.2' },
    { phase: 'ready', version: '0.15.46-dev.2' },
    { phase: 'up-to-date', version: DEV },
    { phase: 'checking' }, { phase: 'idle' }
  ]
  // loop: NOT-WORTH — eight states
  for (const st of states) {
    const n = U.updateNotice(st, { playing: false })
    if (n) { noDev(n.text, st.phase + ' notice'); noDev(n.detail || '', st.phase + ' notice detail') }
    noDev(U.statusLine(st, DEV, 'dev'), st.phase + ' status line')
    const note = U.updateNotification(st)
    if (note) { noDev(note.title, st.phase + ' notification'); noDev(note.body, st.phase + ' notification') }
  }
  assert.equal(U.upToDateText(DEV, 'dev'), 'Sonata 0.15.45 Dev is up to date (Development).', 'the toast in Marcy\'s screenshot')
  assert.equal(U.upToDateText('0.15.44', 'stable'), 'Sonata 0.15.44 is up to date (Stable).')
  assert.equal(U.updatedText(DEV), 'Updated to Sonata 0.15.45 Dev.')
  assert.equal(U.updateNotification({ phase: 'ready', version: '0.15.46-dev.2' }).title, 'Sonata 0.15.46 Dev is installed')
  assert.equal(U.updateNotice({ phase: 'available', version: '0.15.46-dev.2' }, {}).dismissKey, 'update:0.15.46-dev.2', 'keys keep the raw version')
})

test('About\'s hero and the rail badge show the version as people see it', () => {
  assert.equal(A.hero(DEV, 'dev', true, 2026).line, 'v0.15.45 Dev · Development')
  const b = R.devBadge({ channel: 'dev', version: DEV })
  noDev(JSON.stringify(b), 'the rail badge')
})
