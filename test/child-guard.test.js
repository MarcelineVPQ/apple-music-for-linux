'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const G = require('../child-guard')

test('withParentDeath: setpriv --pdeathsig TERM on Linux, unchanged without setpriv or off Linux', () => {
  assert.deepEqual(G.withParentDeath('pactl', ['subscribe'], { platform: 'linux', exists: (p) => p === '/usr/bin/setpriv' }),
    ['/usr/bin/setpriv', ['--pdeathsig', 'TERM', '--', 'pactl', 'subscribe']])
  assert.deepEqual(G.withParentDeath('pactl', ['subscribe'], { platform: 'linux', exists: () => false }), ['pactl', ['subscribe']])
  assert.deepEqual(G.withParentDeath('parec', ['-d', 'x'], { platform: 'darwin', exists: () => true }), ['parec', ['-d', 'x']])
})

test('wiring: look-ahead, the visualizer, the engine tap and the scheme watch start their children guarded', () => {
  const read = (f) => fs.readFileSync(require.resolve('../' + f), 'utf8')
  const main = read('main.js')
  assert.match(main, /binary: lookaheadBinary\(\), socketPath: lookaheadSocket\(\), spawn: guardedSpawn,/)
  assert.match(main, /schemeWatch = guardedSpawn\('gdbus'/)
  assert.match(read('visualizer.js'), /this\.spawn = o\.spawn \|\| guardedSpawn/)
  assert.match(read('audio-listen.js'), /const doSpawn = deps\.spawn \|\| guardedSpawn/)
  assert.ok(require('../package.json').build.files.includes('child-guard.js'))
})
