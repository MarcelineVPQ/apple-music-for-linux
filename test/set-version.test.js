// tools/set-version.js: the version set in one step, and --verify (release.yml, CI)
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { execFileSync, spawnSync } = require('child_process')
const S = require('../tools/set-version')

const META = '<component>\n  <releases>\n    <release version="1.2.3" date="2026-01-01">\n      <description>\n        <p>Old.</p>\n      </description>\n    </release>\n  </releases>\n</component>\n'

test('versions: only X.Y.Z and X.Y.Z-dev.N', () => {
  for (const v of ['0.15.37', '0.15.37-dev.1', '1.0.0-dev.12']) assert.ok(S.validVersion(v), v)
  for (const v of ['0.15', 'v0.15.37', '0.15.37-beta.1', '0.15.37-dev', '0.15.37-dev.1 ', '']) assert.ok(!S.validVersion(v), v)
})

test('metainfo: a new release goes on top, dev builds typed "development", text escaped', () => {
  const out = S.metainfoWithRelease(META, '1.2.4-dev.1', '2026-02-02', 'Fish & <chips>')
  assert.match(out, /<releases>\n {4}<release version="1\.2\.4-dev\.1" date="2026-02-02" type="development">\n {6}<description>\n {8}<p>Fish &amp; &lt;chips&gt;<\/p>/)
  assert.ok(out.indexOf('1.2.4-dev.1') < out.indexOf('1.2.3'))
  const stable = S.metainfoWithRelease(META, '1.2.4', '2026-02-02', 'Done.')
  assert.match(stable, /<release version="1\.2\.4" date="2026-02-02">/)
})

test('metainfo: an existing release is updated in place, never doubled', () => {
  const again = S.metainfoWithRelease(META, '1.2.3', '2026-03-03')
  assert.equal((again.match(/version="1\.2\.3"/g) || []).length, 1)
  assert.match(again, /date="2026-03-03">[\s\S]*Old\./)
  const replaced = S.metainfoWithRelease(META, '1.2.3', '2026-03-03', 'New.')
  assert.match(replaced, /New\./)
  assert.doesNotMatch(replaced, /Old\./)
  assert.throws(() => S.metainfoWithRelease(META, '9.9.9', '2026-03-03'), /--summary/)
})

const files = (v, extra) => Object.assign({
  pkg: { version: v }, lock: { version: v, packages: { '': { version: v } } },
  metainfo: S.metainfoWithRelease(META, v, '2026-02-02', 'x'), changelog: '## [Unreleased]\n'
}, extra)

test('verify: everything agrees, and the tag is v + version', () => {
  assert.deepEqual(S.problems(files('1.2.4-dev.1')), [])
  assert.deepEqual(S.problems(files('1.2.4-dev.1'), 'v1.2.4-dev.1'), [])
  assert.match(S.problems(files('1.2.4-dev.1'), 'v1.2.4').join(), /tag v1\.2\.4 != package\.json v1\.2\.4-dev\.1/)
  assert.match(S.problems(files('1.2.4', { lock: { version: '1.2.3', packages: { '': { version: '1.2.4' } } } })).join(), /package-lock\.json is 1\.2\.3/)
  assert.match(S.problems(files('1.2.4', { metainfo: META })).join(), /no <release version="1\.2\.4">/)
  assert.match(S.problems(files('1.2.4', { changelog: '## [1.2.3]\n' })).join(), /CHANGELOG/)
  assert.match(S.problems(files('1.2.4-beta.1')).join(), /not X\.Y\.Z/)
})

test('the script: sets all three files, then --verify passes and a wrong tag fails', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sonata-setver-'))
  try {
    fs.mkdirSync(path.join(dir, 'tools'))
    fs.copyFileSync(path.join(__dirname, '..', 'tools', 'set-version.js'), path.join(dir, 'tools', 'set-version.js'))
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'x', version: '1.2.3' }, null, 2) + '\n')
    fs.writeFileSync(path.join(dir, 'package-lock.json'), JSON.stringify({ name: 'x', version: '1.2.3', packages: { '': { name: 'x', version: '1.2.3' } } }, null, 2) + '\n')
    fs.writeFileSync(path.join(dir, 'io.github.MarcelineVPQ.Sonata.metainfo.xml'), META)
    fs.writeFileSync(path.join(dir, 'CHANGELOG.md'), '# Changelog\n\n## [Unreleased]\n')
    const run = (...a) => spawnSync(process.execPath, [path.join(dir, 'tools', 'set-version.js'), ...a], { encoding: 'utf8' })
    assert.equal(run('--verify').status, 0)   // 1.2.3 everywhere to start with
    execFileSync(process.execPath, [path.join(dir, 'tools', 'set-version.js'), '1.2.4-dev.1', '--summary', 'A test.', '--date', '2026-02-02'])
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).version, '1.2.4-dev.1')
    const lock = JSON.parse(fs.readFileSync(path.join(dir, 'package-lock.json'), 'utf8'))
    assert.equal(lock.version, '1.2.4-dev.1'); assert.equal(lock.packages[''].version, '1.2.4-dev.1')
    assert.match(fs.readFileSync(path.join(dir, 'io.github.MarcelineVPQ.Sonata.metainfo.xml'), 'utf8'), /version="1\.2\.4-dev\.1" date="2026-02-02" type="development"/)
    assert.equal(run('--verify').status, 0)
    assert.equal(run('--verify', 'v1.2.4-dev.1').status, 0)
    assert.equal(run('--verify', 'v1.2.4').status, 1)
    assert.equal(run('1.2.4-beta').status, 2)
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('the repository itself is consistent', () => {
  const root = path.join(__dirname, '..')
  const r = (p) => fs.readFileSync(path.join(root, p), 'utf8')
  assert.deepEqual(S.problems({ pkg: JSON.parse(r('package.json')), lock: JSON.parse(r('package-lock.json')), metainfo: r('io.github.MarcelineVPQ.Sonata.metainfo.xml'), changelog: r('CHANGELOG.md') }), [])
})
