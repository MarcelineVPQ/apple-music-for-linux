#!/usr/bin/env node
// Build latest.json (Stable) or latest-dev.json (Development), the signed
// update feed Sonata reads, from what is ALREADY published on GitHub. The
// AppImage is downloaded and hashed here, so the feed can never point at a file
// that doesn't exist or doesn't match. Never edit the feeds by hand: run the
// "Update feed" workflow (.github/workflows/feed.yml). See docs/RELEASING.md.
//
//   node tools/build-feed.js [--channel stable|dev] [--out latest.json]
//
// Exit 2: no matching release yet (nothing written). Uses GITHUB_TOKEN when set.
const crypto = require('crypto')
const fs = require('fs')
const { REPO } = require('../update-feed')
const { selectRelease, feedText } = require('./feed-lib')

const args = process.argv.slice(2)
const opt = (name, dflt) => (args.includes(name) ? args[args.indexOf(name) + 1] : dflt)
const channel = opt('--channel', 'stable')
if (channel !== 'stable' && channel !== 'dev') throw new Error('unknown channel ' + channel)
const out = opt('--out', channel === 'dev' ? 'latest-dev.json' : 'latest.json')
const headers = { Accept: 'application/vnd.github+json', 'User-Agent': 'sonata-feed-builder' }
if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`

async function measure(asset) {
  const r = await fetch(asset.browser_download_url, { redirect: 'follow' })
  if (!r.ok || !r.body) throw new Error(`${asset.name}: download returned ${r.status}`)
  const hash = crypto.createHash('sha512')
  let size = 0
  // loop: stream of one AppImage (~125 MB), once per feed per CI run · ends at EOF
  // error: PASSES-ON — a failed download throws and fails the workflow; nothing is written
  for await (const chunk of r.body) { size += chunk.byteLength; hash.update(chunk) }
  if (size !== asset.size) throw new Error(`${asset.name}: size ${size} != ${asset.size}`)
  return { sha512: hash.digest('hex'), size }
}

;(async () => {
  const r = await fetch(`https://api.github.com/repos/${REPO}/releases?per_page=50`, { headers })
  if (!r.ok) throw new Error(`GitHub API returned ${r.status}`)
  const picked = selectRelease(await r.json(), channel)
  if (!picked) { console.error(`No ${channel} release with an AppImage yet; not writing ${out}.`); process.exit(2) }
  fs.writeFileSync(out, feedText(channel, picked, await measure(picked.asset)))
  console.log(`Wrote ${out}: ${picked.version}`)
})().catch((e) => { console.error(e.message); process.exit(1) })
