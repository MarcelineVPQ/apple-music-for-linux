#!/usr/bin/env node
// Create the Ed25519 key pair that signs Sonata's update feed. Run ONCE on the
// developer's PC (docs/RELEASING.md, "Signing key"):
//   node tools/feed-keygen.js
// The private key goes to ~/.config/sonata-release/feed-signing-key.pem
// (folder 700, file 600, outside the repo; same place as the DS5 app's
// ~/.config/ds5-release key). It refuses to overwrite an existing key: losing or
// replacing it means installed apps stop accepting updates until a release
// that trusts the new key reaches them.
const crypto = require('crypto')
const fs = require('fs')
const os = require('os')
const path = require('path')

const dir = path.join(os.homedir(), '.config', 'sonata-release')
const file = path.join(dir, 'feed-signing-key.pem')
if (fs.existsSync(file)) {
  console.error(`${file} already exists; not overwriting it. Its public key:`)
  const pub = crypto.createPublicKey(crypto.createPrivateKey(fs.readFileSync(file)))
  console.error('  ' + pub.export({ format: 'der', type: 'spki' }).toString('base64'))
  process.exit(1)
}
const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519')
fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
fs.chmodSync(dir, 0o700)
fs.writeFileSync(file, privateKey.export({ format: 'pem', type: 'pkcs8' }), { mode: 0o600, flag: 'wx' })
fs.chmodSync(file, 0o600)
const pub = publicKey.export({ format: 'der', type: 'spki' }).toString('base64')
console.log(`Private key: ${file} (chmod 600). Keep a backup somewhere safe and offline.

Next steps (docs/RELEASING.md):
1. Store it as the Actions secret:
     gh secret set SONATA_FEED_KEY -R MarcelineVPQ/apple-music-for-linux < ${file}
2. In update-feed.js, replace PLACEHOLDER_KEY in TRUSTED_KEYS with:
     '${pub}', // ${new Date().toISOString().slice(0, 7)}, ~/.config/sonata-release on the developer's PC
`)
