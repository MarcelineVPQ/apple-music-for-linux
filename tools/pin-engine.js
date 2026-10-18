#!/usr/bin/env node
// Pins the Sonata engine release this Sonata installs (align/engine.json), from the release's files.
//   node tools/pin-engine.js DIR [--key BASE64] [--out align/engine.json]
// DIR holds sonata-engine-X.Y.Z-linux-x86_64.tar.gz and its .sig (downloaded from the engine-vX.Y.Z
// release on MarcelineVPQ/sonata-releases). The signature must check with the key already pinned
// (a new key only with --key, said out loud). Writes version, protocol (from the archive's ENGINE.json),
// file, url, size, sha256, key: one key per line, the form align/install.sh reads.
const crypto = require('crypto')
const fs = require('fs')
const path = require('path')
const { execFileSync } = require('child_process')

const RELEASES = 'https://github.com/MarcelineVPQ/sonata-releases/releases/download/'
const FILE_RE = /^sonata-engine-(\d+\.\d+\.\d+(?:-dev\.\d+)?)-linux-x86_64\.tar\.gz$/

/** The pin for one artifact (throws when the signature doesn't check with `key`). */
function pinFor(dir, key) {
  const file = fs.readdirSync(dir).find((f) => FILE_RE.test(f))
  if (!file) throw new Error('no sonata-engine-X.Y.Z-linux-x86_64.tar.gz in ' + dir)
  const version = FILE_RE.exec(file)[1]
  const bytes = fs.readFileSync(path.join(dir, file))
  const sig = Buffer.from(fs.readFileSync(path.join(dir, file + '.sig'), 'utf8').trim(), 'base64')
  const pub = crypto.createPublicKey({ key: Buffer.from(key, 'base64'), format: 'der', type: 'spki' })
  if (!crypto.verify(null, bytes, pub, sig)) throw new Error('the signature of ' + file + ' does not check with the key')
  const meta = JSON.parse(execFileSync('tar', ['-xzOf', path.join(dir, file), 'sonata-engine-' + version + '/ENGINE.json'], { encoding: 'utf8' }))
  if (meta.version !== version) throw new Error('ENGINE.json says ' + meta.version + ', the file name ' + version)
  return {
    version, protocol: meta.protocol, python: meta.python, file,
    url: RELEASES + 'engine-v' + version + '/' + file,
    size: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex'), key
  }
}

const text = (pin) => JSON.stringify(pin, null, 2) + '\n'

if (require.main === module) {
  const args = process.argv.slice(2)
  const opt = (k) => { const i = args.indexOf(k); return i >= 0 ? args.splice(i, 2)[1] : null }
  const out = opt('--out') || path.join(__dirname, '..', 'align', 'engine.json')
  const newKey = opt('--key')
  const dir = args[0]
  if (!dir) { console.error('usage: node tools/pin-engine.js DIR [--key BASE64] [--out FILE]'); process.exit(2) }
  // error: SHOWN — no current pin and no --key: said, exit 1
  let key = newKey
  if (!key) { try { key = JSON.parse(fs.readFileSync(out, 'utf8')).key } catch (e) { console.error('no pinned key in ' + out + ': pass --key'); process.exit(1) } }
  if (newKey) console.log('pinning with a NEW engine key: ' + newKey)
  const pin = pinFor(dir, key)
  fs.writeFileSync(out, text(pin))
  console.log('pinned engine ' + pin.version + ' (' + pin.size + ' bytes, sha256 ' + pin.sha256 + ') in ' + out)
}

module.exports = { pinFor, text, FILE_RE, RELEASES }
