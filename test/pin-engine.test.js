// tools/pin-engine.js: align/engine.json from an engine release's files, only when its signature checks.
const test = require('node:test')
const assert = require('node:assert/strict')
const crypto = require('crypto')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { execFileSync } = require('child_process')
const P = require('../tools/pin-engine')

test('pin: version, protocol, size and SHA-256 from the release files; a wrong key is refused', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pin-engine-'))
  try {
    const stage = path.join(root, 'stage', 'sonata-engine-1.2.3')
    fs.mkdirSync(stage, { recursive: true })
    fs.writeFileSync(path.join(stage, 'ENGINE.json'), JSON.stringify({ version: '1.2.3', protocol: 2, python: '3.12' }))
    const file = 'sonata-engine-1.2.3-linux-x86_64.tar.gz'
    const rel = path.join(root, 'rel')
    fs.mkdirSync(rel)
    execFileSync('tar', ['-czf', path.join(rel, file), '-C', path.dirname(stage), 'sonata-engine-1.2.3'])
    const bytes = fs.readFileSync(path.join(rel, file))
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519')
    const key = publicKey.export({ format: 'der', type: 'spki' }).toString('base64')
    fs.writeFileSync(path.join(rel, file + '.sig'), crypto.sign(null, bytes, privateKey).toString('base64'))
    const pin = P.pinFor(rel, key)
    assert.deepEqual(pin, { version: '1.2.3', protocol: 2, python: '3.12', file, url: P.RELEASES + 'engine-v1.2.3/' + file,
      size: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex'), key })
    // one key per line: the form align/install.sh's sed reads
    assert.match(P.text(pin), /^ {2}"sha256": "[0-9a-f]{64}",$/m)
    const other = crypto.generateKeyPairSync('ed25519').publicKey.export({ format: 'der', type: 'spki' }).toString('base64')
    assert.throws(() => P.pinFor(rel, other), /does not check with the key/)
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('pin: the committed align/engine.json is in pin-engine form', () => {
  const raw = fs.readFileSync(path.join(__dirname, '..', 'align', 'engine.json'), 'utf8')
  assert.equal(raw, P.text(JSON.parse(raw)))
})
