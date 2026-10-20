// The one task registry (tasks-model.js, Marcy 2026-10-19: "the whole app works the same way for all
// things"): anything that needs the user registers a task; the rail item and the section header show the
// same dot; a press on the rail item opens the waiting section; the dot goes when the task is resolved.
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')
const TM = require('../tasks-model')
const N = require('../notices-model')
const H = require('../helper-install-model')
const R = require('../rail-model')
const PM = require('../panel-model')
const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8')

test('registry: a task gives a dot on its page and section and a target; clearing it removes them', () => {
  let changes = 0
  const t = TM.createTasks({ onChange: () => changes++ })
  t.set('helper', { page: 'settings', section: 'timing', text: 'The Precise timing helper needs an update' })
  assert.equal(changes, 1)
  t.set('helper', { page: 'settings', section: 'timing', text: 'The Precise timing helper needs an update' })
  assert.equal(changes, 1, 'the same task again changes nothing')
  t.set('notice:recovered-settings', { page: 'settings', text: 'Settings were repaired' })
  const d = t.dots()
  assert.equal(d.pages.settings, 'The Precise timing helper needs an update\nSettings were repaired')
  assert.equal(d.sections['settings/timing'], 'The Precise timing helper needs an update')
  assert.equal(t.target('settings'), 'timing')
  assert.equal(t.target('about'), '')
  t.clear('helper')
  assert.equal(t.dots().sections['settings/timing'], undefined)
  assert.equal(t.target('settings'), '', 'a page-wide task opens the page as it was')
  t.set('notice:recovered-settings', { page: 'settings', text: '' })   // no words: resolved
  assert.deepEqual(t.dots().pages, {})
})

test('notices: task and error notices register in the one registry, at their section or taskSection', () => {
  const tasks = TM.createTasks()
  const n = N.createNotices({ tasks })
  n.show({ id: 'helper-resume', place: 'top', page: 'settings', task: true, taskSection: 'timing', text: 'The helper install was interrupted — continuing…' })
  n.show({ id: 'lastfm', place: { page: 'settings', section: 'integrations' }, kind: 'error', text: 'Last.fm didn\'t connect' })
  n.show({ id: 'ask-auto', place: 'top', text: 'Keep Sonata up to date?' })
  const d = tasks.dots()
  assert.equal(d.sections['settings/timing'], 'The helper install was interrupted — continuing…')
  assert.equal(d.sections['settings/integrations'], 'Last.fm didn\'t connect')
  assert.equal(tasks.all().find((x) => x.id === 'notice:lastfm').level, 'error')
  assert.ok(!tasks.has('notice:ask-auto'), 'a question is not a task')
  assert.deepEqual(n.reminders(), d, 'notices read their dots from the registry')
  n.clear('lastfm')
  assert.ok(!tasks.has('notice:lastfm'))
  // a dismissed task notice keeps its dot until the caller clears it
  n.show({ id: 'update', place: 'top', page: 'settings', task: true, taskSection: 'updates', dismissKey: 'update:1', text: 'Sonata X is ready' })
  n.dismiss('update')
  assert.equal(tasks.dots().sections['settings/updates'], 'Sonata X is ready')
})

test('the Precise timing helper: update, repair and an available update are tasks; ready, off, busy are not', () => {
  for (const s of ['update', 'repair', 'available']) assert.match(H.taskOf(s), /Precise timing helper/)
  for (const s of ['ready', 'busy', 'off', 'missing', 'installing', 'paused', undefined]) assert.equal(H.taskOf(s), '')
  const main = read('main.js')
  assert.match(main, /tasks\.set\('helper', \{ page: 'settings', section: 'timing', level: 'task', text: helperModel\.taskOf\(precise\) \}\)/)
  assert.match(main, /const precise = railPrecise\(\)\n {2}syncHelperTask\(precise\)/)
})

test('rail: the dot on Settings while it is not shown, said in words; a press opens the waiting section, expanded', () => {
  const items = R.railItems({ reminders: { settings: 'The Precise timing helper needs an update' }, panel: { shown: false } })
  const st = items.find((i) => i.id === 'settings')
  assert.equal(st.task, 'The Precise timing helper needs an update')
  assert.match(st.tip, /Waiting: The Precise timing helper needs an update/)
  const shown = R.railItems({ reminders: { settings: 'x' }, panel: { shown: true, page: 'settings' } }).find((i) => i.id === 'settings')
  assert.equal(shown.task, '', 'no dot while the page shows (its section header has it)')
  const main = read('main.js')
  assert.match(main, /function togglePanelPage\(page\) \{\n[^\n]*hidePanel\(\)\n {2}else showPanel\(page, tasks\.target\(page\) \|\| undefined\)/)
  // showPanel(page, section) reveals the section: opened in the accordion
  const after = PM.accReduce(PM.accState({ open: null, pins: [] }, 'settings'), { type: 'reveal', id: 'timing' })
  assert.ok(PM.isOpen(after, 'timing'))
})

test('one mechanism: no other dot, badge or reminder code', () => {
  const main = read('main.js')
  assert.doesNotMatch(main, /notices\.reminders\(\)/, 'main reads the dots from the registry (tasks.dots())')
  assert.doesNotMatch(read('notices-model.js'), /pages\[page\] = /, 'notices keep no dot list of their own')
  // the dot element: only the rail's panel items and the section headers draw it, from the reminders
  const shipped = JSON.parse(read('package.json')).build.files.filter((f) => /\.(js|html)$/.test(f) && fs.existsSync(path.join(__dirname, '..', f)))
  const drawers = shipped.filter((f) => /el\('i', 'task'\)/.test(read(f)))
  assert.deepEqual(drawers.sort(), ['panel-ui.js', 'rail-ui.js'])
  // one look: the dot's colour and shape only in theme.css
  for (const f of ['rail.css', 'panel.css', 'lyrics-view.css']) {
    const css = read(f).replace(/\/\*[\s\S]*?\*\//g, '')
    assert.doesNotMatch(css, /\.task[^{]*\{[^}]*background/, f + ' styles the task dot itself')
    assert.doesNotMatch(css, /\.(badge|unread|unseen)\b/, f + ' has an ad-hoc badge')
  }
  assert.match(read('theme.css'), /\.task \{[^}]*background: var\(--s-warn\)/)
  // every notice main marks as a task at the top of Settings names its section unless it is page-wide
  const pageWide = ['recovered-']
  for (const m of main.matchAll(/notices\.show\((?:Object\.assign\()?\{([^\n]*task: true[^\n]*)/g)) {
    if (pageWide.some((p) => m[1].includes(p))) continue
    if (/place: INTEGRATIONS|place: \{/.test(m[1])) continue
    assert.match(m[1], /taskSection: '/, 'a top task notice without its section: ' + m[1].slice(0, 80))
  }
})
