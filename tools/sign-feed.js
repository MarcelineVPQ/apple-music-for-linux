#!/usr/bin/env node
// Sign a feed file: an Ed25519 signature over its exact bytes, base64, written
// to <file>.sig. Sonata refuses a feed no key in update-feed.js TRUSTED_KEYS signed.
//   SONATA_FEED_KEY="$(cat key.pem)" node tools/sign-feed.js latest.json
// The key is a GitHub Actions secret; without it this fails, so CI can never
// publish an unsigned feed.
const crypto = require('crypto')
const fs = require('fs')

const file = process.argv[2] || 'latest.json'
const pem = process.env.SONATA_FEED_KEY
if (!pem) {
  console.error('SONATA_FEED_KEY is not set: refusing to publish an unsigned feed.')
  process.exit(1)
}
const key = crypto.createPrivateKey(pem)
const data = fs.readFileSync(file)
const signature = crypto.sign(null, data, key)
if (!crypto.verify(null, data, crypto.createPublicKey(key), signature)) throw new Error('signature self-check failed')
fs.writeFileSync(file + '.sig', signature.toString('base64') + '\n')
const pub = crypto.createPublicKey(key).export({ format: 'der', type: 'spki' }).toString('base64')
console.log(`${file}.sig written (key ${pub})`)
