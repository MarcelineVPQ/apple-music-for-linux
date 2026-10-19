// Never lose a helper install to a quit or a restart: quit-guard.js asks first, the job marker
// (helper-install-model.js) lets the next start continue it, and main wires every way out through the guard.
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')
const { createQuitGuard } = require('../quit-guard')
const M = require('../helper-install-model')

const job = (kind, step) => Object.assign(M.newJob(kind, {}), { step })

test('quit guard: no job, no question; a job asks, Keep installing stays, Quit anyway goes', async () => {
  const asked = []
  let current = null
  let answer = 0
  const g = createQuitGuard({ job: () => current, ask: async (w) => { asked.push(w); return answer } })
  assert.equal(await g.allow('quit'), true)
  assert.equal(asked.length, 0)
  current = job('install', 'models')
  assert.equal(await g.allow('quit'), false)
  assert.equal(asked[0].message, 'The Precise timing helper is still installing (step 7 of 7).')
  assert.match(asked[0].detail, /^Quit anyway\? It will continue the next time Sonata starts/)
  assert.deepEqual([asked[0].keep, asked[0].go], ['Keep installing', 'Quit anyway'])
  answer = 1
  assert.equal(await g.allow('restart'), true)
  assert.equal(asked[1].go, 'Restart anyway')
  assert.match(asked[1].detail, /^Restart anyway\?/)
})

test('quit guard: one question at a time; a dialog that fails keeps installing', async () => {
  let release
  const g = createQuitGuard({ job: () => job('update', 'torch'), ask: () => new Promise((r) => { release = r }) })
  const first = g.allow('quit')
  await new Promise((r) => setImmediate(r))
  assert.equal(g.asking, true)
  assert.equal(await g.allow('quit'), false)   // the second way out while the first question shows
  release(1)
  assert.equal(await first, true)
  const bad = createQuitGuard({ job: () => job('install', 'download'), ask: () => { throw new Error('no display') } })
  assert.equal(await bad.allow('quit'), false)
})

test('quit guard: the words per job kind', () => {
  assert.equal(M.quitAsk(job('remove', 'download'), 'quit').message, 'The Precise timing helper is still being removed.')
  assert.equal(M.quitAsk(job('repair', 'venv'), 'quit').keep, 'Keep repairing')
  assert.match(M.quitAsk(job('update', 'download'), 'quit').message, /still updating \(step 1 of 7\)/)
})

test('job marker: written and read back; damaged or foreign markers are ignored; three tries, then the user decides', () => {
  const m = M.jobMarker('update', { pinText: '{"version":"0.2.6"}', version: '0.2.6', backend: 'cpu', licence: { version: 'draft-1', sha256: 'ab' }, hasModels: true, junk: 'x' }, 'venv', 0)
  assert.deepEqual(m.opts, { pinText: '{"version":"0.2.6"}', version: '0.2.6', backend: 'cpu', licence: { version: 'draft-1', sha256: 'ab' } })
  assert.deepEqual(M.parseMarker(JSON.stringify(m)), m)
  assert.equal(M.parseMarker('{not json'), null)
  assert.equal(M.parseMarker(JSON.stringify(Object.assign({}, m, { kind: 'format-disk' }))), null)
  assert.equal(M.parseMarker(JSON.stringify(Object.assign({}, m, { opts: { backend: 'metal' } }))), null)
  assert.equal(M.parseMarker(JSON.stringify(Object.assign({}, m, { opts: { from: 'https://evil.example/' } }))), null)   // a test feed is loopback only
  assert.deepEqual(M.resumeDecision(m), { resume: true, why: '' })
  assert.deepEqual(M.resumeDecision(Object.assign({}, m, { tries: M.RESUME_TRIES })), { resume: false, why: 'tries' })
  const rm = M.jobMarker('remove', { deleteModels: true }, '', 1)
  assert.equal(M.parseMarker(JSON.stringify(rm)).opts.deleteModels, true)
})

test('resumed job: Settings and the notice say it continues (≤ 60 characters on the row); a failure says what to do', () => {
  const row = M.stateRow({ phase: 'running', resumed: true, job: job('install', 'models') })
  assert.equal(row.text, 'Continuing the interrupted install… step 7 of 7')
  assert.ok(row.text.length <= 60)
  assert.match(row.info, /continues where it stopped/)
  assert.deepEqual(M.buttons({ phase: 'running', job: job('install', 'models') }), ['cancel'])
  assert.equal(M.resumeNotice('install', 'running').text, 'The helper install was interrupted — continuing…')
  assert.match(M.resumeNotice('update', 'failed').text, /interrupted helper update couldn't be finished/)
  // a failed resumed job: the row's buttons offer the way back (Install or Repair)
  assert.deepEqual(M.buttons({ state: 'missing', job: Object.assign(job('install', 'venv'), { phase: 'failed' }) }), ['install'])
  assert.deepEqual(M.buttons({ state: 'broken', job: Object.assign(job('repair', 'venv'), { phase: 'failed' }) }), ['repair', 'remove'])
})

test('main: every way out goes through the guard; a quit keeps the marker; the start resumes it', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8')
  assert.match(src, /label: 'Quit', click: \(\) => quitGuard\.allow\('quit'\)/)                       // tray Quit
  assert.match(src, /helperInstaller\.busy\) \{\n\s+e\.preventDefault\(\)\n\s+quitGuard\.allow\('quit'\)/)   // closing the window
  assert.match(src, /'gfx-restart'\) quitGuard\.allow\('restart'\)/)                                   // Restart now (graphics)
  assert.match(src, /'update-restart': if \(!lastPlaying\) quitGuard\.allow\('restart'\)/)             // Restart now (update)
  assert.match(src, /helperBusy: !!\(helperInstaller && helperInstaller\.busy\)/)                       // no restart offered while it runs
  assert.match(src, /busy\) showPanel\('settings', 'timing'\)/)                                         // a second launch shows the progress
  assert.match(src, /if \(!shuttingDown\) \{\n\s+clearHelperJob\(\)/)                                   // only a job's own end clears the marker
  assert.match(src, /startupStep\('interrupted helper job', helperResume\)/)
  const pkg = require('../package.json')
  for (const f of ['quit-guard.js', 'model-fetch.js']) assert.ok(pkg.build.files.includes(f), f + ' ships')
})
