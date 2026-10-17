// tools/isolated.sh start must refuse a display that is in use BEFORE it removes anything: on 2026-10-17 a
// start on a busy display wiped the running copy's throwaway HOME, runtime dir and app.log, then failed.
// Here: the X lock of an otherwise free display names a live process (this test); start must exit 2 and leave that display's folder
// as it was. No Electron, no X server, nothing started (the refusal comes first).
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawnSync } = require('child_process')

const SCRIPT = path.join(__dirname, '..', 'tools', 'isolated.sh')

test('isolated.sh start refuses a display whose X lock names a live process, before removing anything', { skip: process.platform !== 'linux' }, () => {
  // a display nobody uses: no X lock, no socket
  let disp = 4900 + (process.pid % 90)
  while (fs.existsSync('/tmp/.X' + disp + '-lock') || fs.existsSync('/tmp/.X11-unix/X' + disp)) disp++
  const lock = '/tmp/.X' + disp + '-lock'
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sonata-isolated-test-'))
  const root = path.join(tmp, 'sonata-isolated-' + disp)
  fs.mkdirSync(path.join(root, 'home'), { recursive: true })
  fs.writeFileSync(path.join(root, 'app.log'), 'the running copy\'s log')
  fs.writeFileSync(lock, String(process.pid).padStart(10) + '\n')   // as X writes it: a live process holds the display
  try {
    const r = spawnSync('bash', [SCRIPT, 'start', '/bin/true', '--display', String(disp), '--cdp', '1', '--insp', '2'], { env: Object.assign({}, process.env, { TMPDIR: tmp }), encoding: 'utf8' })
    assert.equal(r.status, 2, r.stderr)
    assert.match(r.stderr, /in use/)
    assert.equal(fs.readFileSync(path.join(root, 'app.log'), 'utf8'), 'the running copy\'s log', 'nothing removed')
    assert.ok(fs.existsSync(path.join(root, 'home')))
  } finally {
    fs.rmSync(lock, { force: true })
    fs.rmSync(tmp, { recursive: true, force: true })
  }
})
