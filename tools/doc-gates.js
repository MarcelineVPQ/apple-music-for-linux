#!/usr/bin/env node
// Documentation freshness gates (Marcy 2026-10-17: "add that to testing so we can keep it up to date").
// The docs, the BACKLOG, About → Coming soon and the in-app help must say what the code does today,
// and nothing private may reach the public repo. Each gate prints one verdict line (PASS, FAIL or
// SKIP) and, on FAIL, each problem with how to fix it.
//
//   node tools/doc-gates.js [--check] [gate …]   all gates, or the named ones; --check exits 1 on a FAIL
//                                                (npm run gates, CI)
//   node tools/doc-gates.js privacy-hash "a phrase"   the line to add to tools/privacy-denylist.txt
//
// Gates:
//   soon       About → Coming soon and BACKLOG.md agree: every Building / Planned row is in Coming soon
//              (Notes start "Soon: …" or "Soon (Card title): …") or says why not by ending its Item
//              with a marker: (internal) nothing for users to wait for, (in testing) already shipped and
//              being checked, (unannounced) waiting for Marcy's OK. A Done row is never in Coming soon.
//              The opted-out rows are listed, so leaving one out is a conscious choice.
//   changelog  feat / fix / perf commits since the last release tag that touch a shipped file
//              (package.json build.files) need words in CHANGELOG.md [Unreleased] (or in the section
//              of the version being released). A commit whose message says "No user-facing change",
//              or an [Unreleased] line saying so, passes.
//   shipped    BACKLOG rows that look shipped but aren't Done (a heuristic, see shippedProblems).
//   refs       README.md, CLAUDE.md, docs/*.md and the in-app help name only files, npm scripts,
//              tools, settings keys and shortcuts that exist. Research notes are history: a doc whose
//              first lines hold "> Research note, dated YYYY-MM-DD" is not checked.
//   version    the version is the same everywhere: tools/set-version.js --verify, plus the metainfo's
//              newest <release> is package.json's and no CHANGELOG section is newer than it.
//   privacy    no public file holds a phrase from tools/privacy-denylist.txt (SHA-256 of the phrase,
//              so the list itself names nothing). A line that must say such a word anyway carries
//              "privacy-ok" and a reason.
'use strict'
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const { execFileSync } = require('child_process')

const ROOT = path.join(__dirname, '..')
const MARKERS = ['internal', 'in testing', 'unannounced']
const STATUSES = ['Idea', 'Planned', 'Building', 'Done', 'Decided against']

// ---------- BACKLOG rows ----------

// BACKLOG.md -> [{ line, item, status, notes, marker }] (the header and separator rows left out)
function backlogRows(md) {
  const out = []
  const lines = String(md || '').split('\n')
  // loop: NOT-WORTH — one pass over BACKLOG.md (~130 rows)
  for (let i = 0; i < lines.length; i++) {
    const m = /^\|\s*(.*?)\s*\|\s*(.*?)\s*\|\s*(.*?)\s*\|\s*$/.exec(lines[i])
    if (!m || /^-+$/.test(m[1].replace(/\s/g, '')) || m[1] === 'Item') continue
    const item = m[1].replace(/\*/g, '').trim()
    const mk = /\((internal|in testing|unannounced)\)\s*$/i.exec(item)
    out.push({ line: i + 1, item, status: m[2].replace(/\*/g, '').trim(), notes: m[3], marker: mk ? mk[1].toLowerCase() : null })
  }
  return out
}

const SOON = /^Soon(?:\s*\(([^)]+)\))?:\s*(.+?[.!?])(?:\s|$)/
const FIX_SOON = 'start its Notes with "Soon (Card title): one plain sentence for users." or end its Item with (internal), (in testing) or (unannounced)'

// -> { problems: [text], optedOut: [{ item, status, marker }], listed: n }
function soonProblems(md) {
  const problems = []
  const optedOut = []
  let listed = 0
  // loop: NOT-WORTH — once per row
  for (const r of backlogRows(md)) {
    const where = 'BACKLOG.md:' + r.line + ' "' + r.item + '"'
    if (!STATUSES.includes(r.status)) { problems.push(where + ': status "' + r.status + '" is not one of ' + STATUSES.join(', ')); continue }
    const startsSoon = /^Soon\b/.test(r.notes)
    const soon = SOON.exec(r.notes)
    if (startsSoon && !soon) problems.push(where + ': its Notes start with "Soon" but not "Soon: sentence." or "Soon (Title): sentence." (About would not show it)')
    if (r.status === 'Done') {
      if (startsSoon) problems.push(where + ' is Done but still in Coming soon: remove its "Soon…:" sentence (shipped work is in the CHANGELOG)')
      continue
    }
    if (r.status === 'Idea') {
      if (startsSoon) problems.push(where + ' is an Idea but in Coming soon: ideas are not coming soon; drop its "Soon…:" (keep the sentence) until it is Planned')
      else if (r.marker) optedOut.push({ item: r.item, status: r.status, marker: r.marker })
      continue
    }
    if (soon) listed++
    if (soon && r.marker) problems.push(where + ' is in Coming soon and marked (' + r.marker + '): drop one of the two')
    if (!soon && r.marker) optedOut.push({ item: r.item, status: r.status, marker: r.marker })
    if (!soon && !r.marker && (r.status === 'Building' || r.status === 'Planned')) problems.push(where + ' is ' + r.status + ' but not in Coming soon: ' + FIX_SOON)
  }
  return { problems, optedOut, listed }
}

// ---------- shipped but not Done ----------

const VERSION_AT_START = /^(\d+)\.(\d+)\.(\d+)(?:-dev\.(\d+))?\b/
const LEFT_TO_DO = /\b(still|next|not yet|open:|needs?|to do|done once|left|remaining|pending|to see|building now|building:|being reworked|todo)\b/i
function versionKey(v) {
  const m = /^(\d+)\.(\d+)\.(\d+)(?:-dev\.(\d+))?$/.exec(v)
  // a stable X.Y.Z comes after every X.Y.Z-dev.N
  return m ? [+m[1], +m[2], +m[3], m[4] === undefined ? Infinity : +m[4]] : null
}
function versionCmp(a, b) {
  const x = versionKey(a); const y = versionKey(b)
  // loop: NOT-WORTH — 4 parts
  for (let i = 0; i < 4; i++) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1
  return 0
}

// The heuristic (what it can and can't catch is in CLAUDE.md, Documentation gates):
//   1. an Idea / Planned row whose Notes start with a released version ("0.15.39-dev.1. …"): the
//      BACKLOG's way of saying "shipped in"
//   2. an Idea / Planned row whose Notes say "Built:" / "shipped in" / "wired in"
//   3. an Idea / Planned row naming a settings key (`settings.x` or `x: [default, …]` in the Notes)
//      that settings-store.js already has
//   4. a Building row (not marked "in testing") whose Notes start with a released version and say
//      nothing is left (no "still", "next", "not yet", "open:", "needs" …)
function shippedProblems(md, { version, settingsKeys = [] }) {
  const problems = []
  // loop: NOT-WORTH — once per row
  for (const r of backlogRows(md)) {
    const where = 'BACKLOG.md:' + r.line + ' "' + r.item + '"'
    const v = VERSION_AT_START.exec(r.notes)
    const released = v && version && versionCmp(v[0], version) <= 0
    if (r.status === 'Idea' || r.status === 'Planned') {
      if (released) problems.push(where + ' is ' + r.status + ' but its Notes start with ' + v[0] + ' (shipped): mark it Done, or move the version out of the first words')
      else if (/\b(Built:|shipped in \d|wired in \d)/i.test(r.notes)) problems.push(where + ' is ' + r.status + ' but its Notes say it was built: mark it Building or Done')
      else {
        const keys = [...r.notes.matchAll(/`settings\.([A-Za-z]\w*)`/g)].map((x) => x[1]).filter((k) => settingsKeys.includes(k))
        if (keys.length) problems.push(where + ' is ' + r.status + ' but settings-store.js already has ' + keys.join(', ') + ': mark it Building or Done')
      }
    } else if (r.status === 'Building' && r.marker !== 'in testing' && released && !LEFT_TO_DO.test(r.notes)) {
      problems.push(where + ' is Building, shipped in ' + v[0] + ', and its Notes name nothing left: mark it Done, or say what is left (or end its Item with (in testing))')
    }
  }
  return problems
}

// ---------- CHANGELOG [Unreleased] ----------

// "## [Unreleased]" -> its body (trimmed), or null when there is no such section
function changelogSection(md, name) {
  const lines = String(md || '').split('\n')
  const start = lines.findIndex((l) => new RegExp('^##\\s+\\[' + name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\]').test(l))
  if (start < 0) return null
  const end = lines.findIndex((l, i) => i > start && /^##?\s/.test(l))
  return lines.slice(start + 1, end < 0 ? lines.length : end).join('\n').trim()
}

const NO_USER_CHANGE = /no user-facing change/i
const USER_COMMIT = /^(feat|fix|perf)(\([^)]*\))?!?:/
// commits: [{ hash, subject, body, files }]; shipped: (file) => true for a file in the app
// -> problems ([] when the CHANGELOG covers them)
function changelogProblems({ changelog, commits, shipped, version, versionTagged }) {
  const user = commits.filter((c) => USER_COMMIT.test(c.subject) && !NO_USER_CHANGE.test(c.body) && c.files.some(shipped))
  if (!user.length) return []
  const unreleased = changelogSection(changelog, 'Unreleased') || ''
  // the version being released (package.json's, not tagged yet) carries the words instead
  const releasing = !versionTagged ? changelogSection(changelog, version) || '' : ''
  if (unreleased || releasing) return []
  return [user.length + ' user-facing commit(s) since the last release tag and CHANGELOG.md [Unreleased] is empty: ' +
    user.slice(0, 5).map((c) => c.hash.slice(0, 7) + ' ' + c.subject).join('; ') + (user.length > 5 ? '; …' : '') +
    '. Add what changed for users under ## [Unreleased] (Added / Changed / Fixed), or a line "No user-facing change: why", or say "No user-facing change" in the commit message']
}

// is `file` (repo-relative) part of the app? package.json build.files: literal names, plus the
// node_modules globs (not tracked in git, so never a commit's file)
function shippedTest(buildFiles) {
  const literal = new Set(buildFiles.filter((f) => !/[*!{]/.test(f)))
  return (file) => literal.has(file)
}

function gitCommitsSince(tag) {
  const out = execFileSync('git', ['log', '--no-merges', '--format=%x1e%H%x1f%s%x1f%b%x1f', '--name-only', tag + '..HEAD'], { cwd: ROOT, encoding: 'utf8' })
  return out.split('\x1e').filter((s) => s.trim()).map((chunk) => {
    const [hash, subject, body, rest] = chunk.split('\x1f')
    return { hash, subject, body, files: String(rest || '').split('\n').map((s) => s.trim()).filter(Boolean) }
  })
}

// ---------- stale references ----------

const FILE_EXT = 'js|mjs|html|css|json|py|sh|yml|yaml|md|svg|png|txt|xml|desktop|ts|tsx'
const RESEARCH = /^> Research note, dated \d{4}-\d{2}-\d{2}/m

// docs: [{ name, text }]; ctx: { tracked: [paths], code: text of the shipped files, scripts: [names],
// settingsKeys: [names], shortcuts: Set of normalized keys, normalize(key) -> key | null }
function refProblems(docs, ctx) {
  const problems = []
  const tracked = new Set(ctx.tracked)
  const basenames = new Set(ctx.tracked.map((f) => path.basename(f)))
  // a source file must be in the tree; a data file the app writes (settings.json, lyrics-cache.json,
  // latest-linux.yml …) may instead be named in the code
  const fileExists = (ref) => {
    const r = ref.replace(/^\.\//, '').replace(/[):,.]+$/, '')
    const data = /\.(json|txt|yml|yaml|xml)$/.test(r) && ctx.code.includes(r)
    if (r.includes('/')) return tracked.has(r) || ctx.tracked.some((f) => f.endsWith('/' + r)) || data
    return basenames.has(r) || data
  }
  // loop: NOT-WORTH — a dozen docs, a few hundred lines each
  for (const doc of docs) {
    if (RESEARCH.test(doc.text.split('\n').slice(0, 8).join('\n'))) continue
    // HTML comments hold parked text (a screenshot not recorded yet): not checked, lines kept
    const lines = doc.text.replace(/<!--[\s\S]*?-->/g, (c) => c.replace(/[^\n]/g, ' ')).split('\n')
    // loop: NOT-WORTH — once per line
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      // a path on another branch is fine when the line names the branch ("… on the research-gpu-pipeline branch")
      const onBranch = /\bbranch\b/.test(line)
      const where = doc.name + ':' + (i + 1)
      // backticked file names and paths
      // loop: NOT-WORTH — a few per line
      for (const m of line.matchAll(/`([^`\s]+)`/g)) {
        const tok = m[1]
        if (!new RegExp('^[\\w@.\\/-]+\\.(' + FILE_EXT + ')$').test(tok)) continue
        if (onBranch || /^(~|\/|\$|https?:)/.test(tok) || /[<>*{}]/.test(tok) || /^[\w-]+\.(example|test)\./.test(tok)) continue
        if (!fileExists(tok)) problems.push(where + ': `' + tok + '` is not a file in the repo (renamed or removed?): fix the name, or drop the backticks if it is a future file')
      }
      // loop: NOT-WORTH — a few per line
      for (const m of line.matchAll(/\bnpm run ([\w:-]+)/g)) {
        if (!ctx.scripts.includes(m[1])) problems.push(where + ': "npm run ' + m[1] + '" is not a package.json script')
      }
      // loop: NOT-WORTH — a few per line
      // repo paths written without backticks (docs/…, tools/…, align/…, test/…, packaging/…)
      // loop: NOT-WORTH — a few per line
      for (const m of line.matchAll(new RegExp('(?:^|[\\s(\\[])((?:docs|tools|align|test|packaging|assets|licenses|\\.github)\\/[\\w./-]*\\.(?:' + FILE_EXT + '))(?![\\w/])', 'g'))) {
        if (!onBranch && !fileExists(m[1])) problems.push(where + ': ' + m[1] + ' does not exist (renamed, removed, or only on another branch?): fix the path, or say which branch has it without the path')
      }
      // loop: NOT-WORTH — a few per line
      for (const m of line.matchAll(/`settings\.([A-Za-z]\w*)`/g)) {
        if (new RegExp('^(' + FILE_EXT + ')$').test(m[1])) continue   // settings.html: a file name, checked above
        if (!ctx.settingsKeys.includes(m[1])) problems.push(where + ': `settings.' + m[1] + '` is not a setting in settings-store.js')
      }
      // shortcuts led by Ctrl (another app's "Shift+Ctrl+F" is not ours)
      // loop: NOT-WORTH — a few per line
      for (const m of line.matchAll(/(^|[^+\w])(Ctrl(?:\+(?:Alt|Shift|Super))*\+(?:Page Up|Page Down|[A-Za-z0-9]+))/g)) {
        const key = ctx.normalize(m[2].replace(/Page (Up|Down)/, 'Page$1'))
        if (!key || !ctx.shortcuts.has(key)) problems.push(where + ': ' + m[2] + ' is not one of Sonata\'s shortcuts (shortcuts-model.js RESERVED and ACTIONS)')
      }
    }
  }
  return problems
}

// the in-app help: the user-facing strings of Sonata's own pages and models
const HELP_FILES = ['panel-ui.js', 'panel-model.js', 'rail-model.js', 'stage-ui.js', 'lyrics.html', 'miniplayer.html', 'visualizer.html', 'liner-notes.html', 'cover.html', 'notices-model.js', 'mini-model.js']
// a page or model's string literals, one per line, so refProblems sees what users read
function helpText(src) {
  return [...String(src).matchAll(/'((?:[^'\\\n]|\\.)*)'|"((?:[^"\\\n]|\\.)*)"|>([^<>\n]{3,})</g)].map((m) => m[1] || m[2] || m[3] || '').filter((s) => /\s/.test(s)).join('\n')
}

// ---------- version ----------

function versionProblems({ pkg, lock, metainfo, changelog }) {
  const out = require('./set-version').problems({ pkg, lock, metainfo, changelog })
  const v = pkg.version
  const first = /<release version="([^"]+)"/.exec(metainfo)
  if (first && first[1] !== v) out.push('the metainfo\'s newest <release> is ' + first[1] + ', not package.json\'s ' + v + ': node tools/set-version.js ' + v + ' --summary "…"')
  const newest = /^##\s+\[(\d+\.\d+\.\d+(?:-dev\.\d+)?)\]/m.exec(changelog)
  if (newest && versionKey(v) && versionCmp(newest[1], v) > 0) out.push('CHANGELOG.md\'s newest section [' + newest[1] + '] is newer than package.json ' + v + ': set the version with tools/set-version.js')
  return out
}

// ---------- privacy ----------

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex')
const words = (s) => String(s).toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').match(/[\p{L}\p{N}]+/gu) || []
const phraseHash = (phrase) => sha(words(phrase).join(' '))

// files: [{ name, text }]; hashes: Set of phraseHash values -> problems
function privacyProblems(files, hashes) {
  const problems = []
  // loop: NOT-WORTH — every public text file once (~200 files, a few MB)
  for (const f of files) {
    const lines = f.text.split('\n')
    // loop: NOT-WORTH — once per line
    for (let i = 0; i < lines.length; i++) {
      if (/privacy-ok/.test(lines[i])) continue
      const w = words(lines[i])
      // loop: NOT-WORTH — 1- to 4-word phrases per line
      for (let a = 0; a < w.length; a++) {
        for (let n = 1; n <= 4 && a + n <= w.length; n++) {
          const p = w.slice(a, a + n).join(' ')
          if (hashes.has(sha(p))) { problems.push(f.name + ':' + (i + 1) + ': "' + p + '" is on the private list (business topics stay out of the public repo): remove it, or mark the line privacy-ok with a reason if it is plainly not business'); a = w.length }
        }
      }
    }
  }
  return problems
}

const PRIVACY_SKIP = /^(LICENSE|licenses\/|package-lock\.json|test\/fixtures\/|tools\/privacy-denylist\.txt|.*\.sig$|.*\.(png|jpg|jpeg|webp|glb|blend|wav|flac|mp3|ogg|ico|ttf|woff2?)$)/
function loadDenylist(file) {
  return new Set(fs.readFileSync(file, 'utf8').split('\n').map((l) => l.trim()).filter((l) => /^[0-9a-f]{64}$/.test(l)))
}

// ---------- running them on the repo ----------

function tracked() {
  return execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' }).split('\n').filter(Boolean)
}
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8')

function gateSoon() {
  const r = soonProblems(read('BACKLOG.md'))
  const about = require('../about-data').comingSoon(read('BACKLOG.md'))
  if (about.length !== r.listed) r.problems.push('about-data.js comingSoon lists ' + about.length + ' rows but BACKLOG.md has ' + r.listed + ' "Soon" rows: the two parsers disagree (fix about-data.js)')
  const groups = { internal: [], 'in testing': [], unannounced: [] }
  // loop: NOT-WORTH — the opted-out rows
  for (const o of r.optedOut) groups[o.marker].push(o.item.replace(/\s*\([^)]*\)\s*$/, ''))
  const info = [r.listed + ' rows in Coming soon'].concat(MARKERS.filter((m) => groups[m].length).map((m) => 'left out, ' + m + ' (' + groups[m].length + '): ' + groups[m].join('; ')))
  return { problems: r.problems, info }
}

function gateChangelog() {
  let tag
  try { tag = execFileSync('git', ['describe', '--tags', '--abbrev=0', '--match', 'v*'], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() } catch (e) {
    // error: SHOWN — no tag in this clone (a shallow CI checkout without fetch-depth: 0): the gate says SKIP
    return { skip: 'no release tag in this clone (CI needs actions/checkout fetch-depth: 0)' }
  }
  const pkg = JSON.parse(read('package.json'))
  let versionTagged = false
  try { execFileSync('git', ['rev-parse', '-q', '--verify', 'refs/tags/v' + pkg.version], { cwd: ROOT, stdio: 'ignore' }); versionTagged = true } catch (e) { /* error: NOT-WORTH — no tag: the version is being released */ }
  const commits = gitCommitsSince(tag)
  return { problems: changelogProblems({ changelog: read('CHANGELOG.md'), commits, shipped: shippedTest(pkg.build.files), version: pkg.version, versionTagged }), info: [commits.length + ' commits since ' + tag] }
}

function gateShipped() {
  const pkg = JSON.parse(read('package.json'))
  return { problems: shippedProblems(read('BACKLOG.md'), { version: pkg.version, settingsKeys: Object.keys(require('../settings-store').SCHEMA) }) }
}

function refContext(files) {
  const pkg = JSON.parse(read('package.json'))
  const sm = require('../shortcuts-model')
  const code = pkg.build.files.filter((f) => /\.(js|html|py|sh)$/.test(f) && files.includes(f)).map(read).join('\n') + '\n' +
    files.filter((f) => /^(tools|\.github)\//.test(f) && /\.(js|sh|py|yml)$/.test(f) && f !== 'tools/doc-gates.js').map(read).join('\n')
  return {
    tracked: files,
    code,
    scripts: Object.keys(pkg.scripts || {}),
    settingsKeys: Object.keys(require('../settings-store').SCHEMA),
    shortcuts: new Set(sm.RESERVED.concat(sm.ACTIONS.map((a) => a.key)).map((k) => sm.normalize(k))),
    normalize: sm.normalize
  }
}

function gateRefs() {
  const files = tracked()
  const md = files.filter((f) => f === 'README.md' || f === 'CLAUDE.md' || /^docs\/[^/]+\.md$/.test(f))
  const docs = md.map((f) => ({ name: f, text: read(f) }))
    .concat(HELP_FILES.filter((f) => files.includes(f)).map((f) => ({ name: f + ' (help strings)', text: helpText(read(f)) })))
  return { problems: refProblems(docs, refContext(files)), info: [docs.length + ' docs and help files'] }
}

function gateVersion() {
  const j = (f) => JSON.parse(read(f))
  return { problems: versionProblems({ pkg: j('package.json'), lock: j('package-lock.json'), metainfo: read('io.github.MarcelineVPQ.Sonata.metainfo.xml'), changelog: read('CHANGELOG.md') }) }
}

function gatePrivacy() {
  const hashes = loadDenylist(path.join(ROOT, 'tools', 'privacy-denylist.txt'))
  if (!hashes.size) return { problems: ['tools/privacy-denylist.txt has no phrases'] }
  const files = tracked().filter((f) => !PRIVACY_SKIP.test(f) && fs.existsSync(path.join(ROOT, f)))
    .map((f) => ({ name: f, text: read(f) })).filter((f) => !f.text.includes('\u0000'))
  return { problems: privacyProblems(files, hashes), info: [files.length + ' files, ' + hashes.size + ' phrases'] }
}

const GATES = { soon: gateSoon, changelog: gateChangelog, shipped: gateShipped, refs: gateRefs, version: gateVersion, privacy: gatePrivacy }

function main(argv) {
  if (argv[0] === 'privacy-hash') {
    if (!argv[1]) { console.error('usage: node tools/doc-gates.js privacy-hash "a phrase"'); return 2 }
    console.log(phraseHash(argv.slice(1).join(' ')))
    return 0
  }
  const check = argv.includes('--check')
  const names = argv.filter((a) => !a.startsWith('--'))
  const run = names.length ? names : Object.keys(GATES)
  let failed = 0
  // loop: NOT-WORTH — six gates
  for (const name of run) {
    if (!GATES[name]) { console.error('unknown gate ' + name + ' (' + Object.keys(GATES).join(', ') + ')'); return 2 }
    const r = GATES[name]()
    if (r.skip) { console.log('SKIP ' + name + ': ' + r.skip); continue }
    console.log((r.problems.length ? 'FAIL ' : 'PASS ') + name + (r.info ? ' (' + r.info[0] + ')' : ''))
    // loop: NOT-WORTH — a few lines
    for (const l of (r.info || []).slice(1)) console.log('     ' + l)
    // loop: NOT-WORTH — the problems found
    for (const p of r.problems) console.log('  ✗ ' + p)
    if (r.problems.length) failed++
  }
  return check && failed ? 1 : 0
}

module.exports = { backlogRows, soonProblems, shippedProblems, changelogSection, changelogProblems, shippedTest, refProblems, helpText, versionProblems, privacyProblems, phraseHash, words, versionCmp, MARKERS }
if (require.main === module) process.exitCode = main(process.argv.slice(2))
