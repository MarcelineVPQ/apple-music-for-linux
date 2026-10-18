// Pure part of tools/build-feed.js: picks the release latest.json /
// latest-dev.json describes and writes the feed text. Kept separate so it can be
// tested on fixture release lists without the network (test/update-feed.test.js).
const { REPO, versionKey, isNewerVersion } = require('../update-feed')

const STABLE_TAG = /^v(\d+\.\d+\.\d+)$/
const DEV_TAG = /^v(\d+\.\d+\.\d+-dev\.\d+)$/

// The newest release for a channel, from GitHub's release list (newest first).
// "stable": only published, non-prerelease vX.Y.Z releases.
// "dev": the newest of the development prereleases (vX.Y.Z-dev.N) and the
// stable releases, so Development users get stable releases too.
function selectRelease(releases, channel) {
  let best = null
  // loop: NOT-WORTH — one page of ≤ 50 releases, once per CI run
  for (const r of releases) {
    if (r.draft) continue
    const m = !r.prerelease ? STABLE_TAG.exec(r.tag_name) : (channel === 'dev' ? DEV_TAG.exec(r.tag_name) : null)
    if (!m) continue
    const version = m[1]
    const asset = (r.assets || []).find((a) => a.name === `sonata-${version}-x86_64.AppImage`)
    if (!asset) continue
    if (!best || isNewerVersion(version, best.version)) best = { release: r, version, asset }
  }
  return best
}

// The feed file's exact text (what gets signed). measured = { sha512 (hex), size }.
function feedText(channel, picked, measured) {
  if (!versionKey(picked.version)) throw new Error('bad version ' + picked.version)
  const feed = {
    channel,
    version: picked.version,
    file: picked.asset.name,
    url: `https://github.com/${REPO}/releases/download/${picked.release.tag_name}/${picked.asset.name}`,
    sha512: measured.sha512,
    size: measured.size,
    date: picked.release.published_at || '',
    notes_url: picked.release.html_url || '',
    notes: String(picked.release.body || '').trim().slice(0, 20000)
  }
  return JSON.stringify(feed, null, 2) + '\n'
}

module.exports = { STABLE_TAG, DEV_TAG, selectRelease, feedText }
