#!/usr/bin/env node
// The version, set in one step (42PS Standard: "the version is written in one place"). package.json's
// "version" is the source; this writes it and everything generated from it:
//
//   node tools/set-version.js X.Y.Z[-dev.N] --summary "One sentence for software centres" [--date YYYY-MM-DD]
//       sets package.json, package-lock.json (root and packages[""]) and the metainfo <release>
//       (added at the top of <releases>, or its date/summary replaced if that version is there;
//       type="development" for -dev.N). Without --summary an existing entry is kept as it is.
//   node tools/set-version.js --verify [vX.Y.Z[-dev.N]]
//       exit 1 unless package.json, package-lock.json and the metainfo agree, CHANGELOG.md has a
//       "## [version]" (or "## [Unreleased]") section, and, given a tag, the tag is "v" + version.
//       release.yml runs it with the pushed tag; CI runs it without one.
//
// Only Stable (X.Y.Z) and Development (X.Y.Z-dev.N) versions exist (docs/RELEASING.md).
'use strict'
const fs = require('fs')
const path = require('path')

const VERSION = /^(\d+)\.(\d+)\.(\d+)(?:-dev\.(\d+))?$/
const validVersion = (v) => typeof v === 'string' && VERSION.test(v)
const isDev = (v) => /-dev\.\d+$/.test(v)
const xmlEscape = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
const reEscape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

// the metainfo text with `version`'s <release> at the top of <releases> (or updated in place)
function metainfoWithRelease(xml, version, date, summary) {
  const type = isDev(version) ? ' type="development"' : ''
  const existing = new RegExp('    <release version="' + reEscape(version) + '"[^>]*>[\\s\\S]*?</release>\\n')
  const m = existing.exec(xml)
  if (m && summary == null) {
    // keep its description; only the date and type follow the arguments
    const head = '    <release version="' + version + '" date="' + date + '"' + type + '>'
    return xml.replace(m[0], m[0].replace(/^ {4}<release [^>]*>/, head))
  }
  if (summary == null || !String(summary).trim()) throw new Error('metainfo has no <release> for ' + version + ': give --summary "one sentence"')
  const entry =
    '    <release version="' + version + '" date="' + date + '"' + type + '>\n' +
    '      <description>\n' +
    '        <p>' + xmlEscape(String(summary).trim()) + '</p>\n' +
    '      </description>\n' +
    '    </release>\n'
  if (m) return xml.replace(m[0], entry)
  if (!/  <releases>\n/.test(xml)) throw new Error('metainfo has no <releases> element')
  return xml.replace(/  <releases>\n/, (s) => s + entry)
}

// what disagrees with package.json's version (and the tag, when given): [] when all agree
function problems({ pkg, lock, metainfo, changelog }, tag) {
  const v = pkg.version
  const out = []
  if (!validVersion(v)) out.push('package.json version ' + v + ' is not X.Y.Z or X.Y.Z-dev.N')
  if (lock.version !== v) out.push('package-lock.json is ' + lock.version)
  if (!lock.packages || !lock.packages[''] || lock.packages[''].version !== v) out.push('package-lock.json packages[""] is ' + (lock.packages && lock.packages[''] && lock.packages[''].version))
  const rel = new RegExp('<release version="' + reEscape(v) + '"([^>]*)>').exec(metainfo)
  if (!rel) out.push('the metainfo has no <release version="' + v + '">')
  else if (isDev(v) !== /type="development"/.test(rel[1])) out.push('the metainfo <release> for ' + v + (isDev(v) ? ' needs' : ' must not have') + ' type="development"')
  if (!changelog.includes('## [' + v + ']') && !changelog.includes('## [Unreleased]')) out.push('CHANGELOG.md has no "## [' + v + ']" or "## [Unreleased]" section')
  if (tag != null && tag !== 'v' + v) out.push('tag ' + tag + ' != package.json v' + v)
  return out
}

function today() {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate())
}

function main(argv, root) {
  const file = (p) => path.join(root, p)
  const read = (p) => fs.readFileSync(file(p), 'utf8')
  const opt = (name) => { const i = argv.indexOf('--' + name); return i >= 0 ? argv[i + 1] : undefined }
  const files = () => ({ pkg: JSON.parse(read('package.json')), lock: JSON.parse(read('package-lock.json')), metainfo: read(META), changelog: read('CHANGELOG.md') })
  if (argv.includes('--verify')) {
    const i = argv.indexOf('--verify')
    const tag = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : null
    const f = files()
    const bad = problems(f, tag)
    if (bad.length) { console.error('Version ' + f.pkg.version + ' is inconsistent:\n  - ' + bad.join('\n  - ')); return 1 }
    console.log('Version ' + f.pkg.version + ' is consistent' + (tag ? ' with tag ' + tag : '') + '.')
    return 0
  }
  const version = argv.find((a, i) => !a.startsWith('--') && !(i > 0 && argv[i - 1].startsWith('--')))
  if (!validVersion(version)) { console.error('usage: set-version.js X.Y.Z[-dev.N] --summary "…" [--date YYYY-MM-DD] | --verify [tag]'); return 2 }
  const date = opt('date') || today()
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) { console.error('--date is YYYY-MM-DD'); return 2 }
  const f = files()
  const metainfo = metainfoWithRelease(f.metainfo, version, date, opt('summary'))
  f.pkg.version = version
  f.lock.version = version
  if (f.lock.packages && f.lock.packages['']) f.lock.packages[''].version = version
  fs.writeFileSync(file('package.json'), JSON.stringify(f.pkg, null, 2) + '\n')
  fs.writeFileSync(file('package-lock.json'), JSON.stringify(f.lock, null, 2) + '\n')
  fs.writeFileSync(file(META), metainfo)
  console.log('Set ' + version + ' in package.json, package-lock.json and ' + META + ' (' + date + ').')
  if (!f.changelog.includes('## [' + version + ']')) console.log('CHANGELOG.md: name the section "## [' + version + '] — Short title" before tagging.')
  return 0
}
const META = 'io.github.MarcelineVPQ.Sonata.metainfo.xml'

module.exports = { validVersion, metainfoWithRelease, problems }
if (require.main === module) process.exitCode = main(process.argv.slice(2), path.join(__dirname, '..'))
