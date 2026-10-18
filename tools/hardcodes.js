#!/usr/bin/env node
// The hardcode gate (Marcy 2026-10-18: "NOTHING should be hardcoded in this manner. ESPECIALLY FOR
// TOASTS"). Mechanical, like tools/verdicts.js: it reads every file Sonata ships (package.json
// build.files: the .js files and the pages' inline <script>s) and refuses a user-facing value that is
// typed where a single source exists:
//
//   raw-version   text built from a raw version: a string joined to app.getVersion(), `x.version`,
//                 `fooVersion` or put in a template ${…version}. People read versions only through
//                 version-display.js (short / full / tagged): "0.15.45 Dev", never "0.15.45-dev.1".
//   channel-name  the literal 'Stable' / 'Development' as a label: version-display.js channelName()
//   repo-url      the source repository's URL: version-display.js REPO_URL
//   user-agent    a 'Sonata/' User-Agent: version-display.js userAgent()
//   number-text   "every 5 seconds", "at most 1,000 songs" typed in a string: the number comes from
//                 its constant (interpolate it), so the words can't drift from what the code does
//
// version-display.js itself is the one place and is not checked. A line that must break a rule for a
// plain reason (a raw version in a cache key, a feed URL, a log line for developers) carries
//   // hardcode: OK — reason            (inside page-script template strings: /* hardcode: OK — … */)
// on the line or the line above. console.* lines are developer logs and not checked.
//
//   node tools/hardcodes.js            every finding and every marked exception
//   node tools/hardcodes.js --check    exit 1 on a finding (npm run gates, .hooks/pre-commit, CI)
'use strict'
const fs = require('fs')
const path = require('path')
const { shippedFiles, codeLines } = require('./verdicts')

const ROOT = path.join(__dirname, '..')
const HOME = 'version-display.js'

// a version expression: app.getVersion(), st.version, alignEngineVersion() (a call with arguments is not one)
const VER = '(?:[\\w$]+\\.)*[\\w$]*[vV]ersion(?:\\(\\))?(?![\\w$(])'
const RAW_VERSION = [
  new RegExp('[\'"`]\\s*\\+\\s*\\(?\\s*' + VER + '(?!\\s*\\?)'),     // 'text ' + st.version, 'x' + (v.version || '')
  new RegExp(VER + '\\s*\\+\\s*[\'"`]'),               // st.version + ' is available'
  new RegExp('\\$\\{\\s*' + VER + '\\s*\\}')           // `… ${version} …`
]
const NUMBER_TEXT = /\b(every|at most|up to|after|within)\s+\d[\d,.]*\s*(ms|s|seconds?|min|minutes?|h|hours?|days?|songs?|files?|lines?|MB|GB|MiB|GiB)\b/i

const RULES = [
  { id: 'raw-version', fix: 'show it through version-display.js: V.short(v) "0.15.45 Dev", V.full(v) "Sonata 0.15.45 Dev", V.tagged(v) "v0.15.45 Dev"',
    test: (code) => RAW_VERSION.some((re) => re.test(code)) },
  { id: 'channel-name', fix: 'use version-display.js channelName(\'stable\' | \'dev\')',
    test: (code) => /['"`](Development|Stable)\s*['"`]/.test(code) },
  { id: 'repo-url', fix: 'use version-display.js REPO_URL',
    test: (code) => /github\.com\/MarcelineVPQ\/apple-music-for-linux/.test(code) },
  { id: 'user-agent', fix: 'use version-display.js userAgent(version)',
    test: (code) => /['"`]Sonata\/['"`]?/.test(code) },
  { id: 'number-text', fix: 'interpolate the constant that sets it (export it from its module; the panel gets it in its snapshot)',
    test: (code, strings) => strings.some((s) => NUMBER_TEXT.test(s)) }
]

// the line's string literals (their contents) and the code before a // comment (strings kept)
function split(line) {
  const strings = []
  let masked = ''
  const re = /'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"|`(?:\\.|[^`\\])*`?/g
  let last = 0
  let m
  // loop: NOT-WORTH — the string literals of one line
  while ((m = re.exec(line))) {
    masked += line.slice(last, m.index) + m[0][0] + 'x'.repeat(Math.max(0, m[0].length - 2)) + (m[0].length > 1 ? m[0][m[0].length - 1] : '')
    strings.push(m[0].slice(1, -1))
    last = m.index + m[0].length
  }
  masked += line.slice(last)
  const c = masked.search(/(^|[^:\\])\/\//)
  const cut = c < 0 ? line.length : c + (masked[c] === '/' ? 0 : 1)
  return { code: line.slice(0, cut).replace(/\/\*.*?\*\//g, (x) => ' '.repeat(x.length)), strings }
}

const MARK = /(?:\/\/|\/\*)\s*hardcode:\s*OK\b/
const isComment = (l) => /^\s*(\/\/|\*|\/\*)/.test(l)

// -> { findings: [{ file, line, rule, fix, code }], allowed: [{ file, line, rule, code }] }
function scanText(file, text) {
  const findings = []
  const allowed = []
  if (file === HOME) return { findings, allowed }
  const lines = codeLines(file, text)
  const raw = text.split('\n')
  // loop: NOT-WORTH — every line of a shipped file, once per run
  lines.forEach((l, i) => {
    if (!l.trim() || isComment(l) || /\bconsole\.(log|error|warn|info)\(/.test(l)) return
    const { code, strings } = split(l)
    // loop: NOT-WORTH — five rules per line
    for (const r of RULES) {
      if (!r.test(code, strings)) continue
      const row = { file, line: i + 1, rule: r.id, fix: r.fix, code: l.trim().slice(0, 140) }
      if (MARK.test(raw[i]) || MARK.test(raw[i - 1] || '')) allowed.push(row)
      else findings.push(row)
    }
  })
  return { findings, allowed }
}

function scan(root) {
  const out = { findings: [], allowed: [], files: 0 }
  // loop: NOT-WORTH — ~85 shipped files, once per run
  for (const f of shippedFiles(root)) {
    const p = path.join(root, f)
    if (!fs.existsSync(p)) continue
    const r = scanText(f, fs.readFileSync(p, 'utf8'))
    out.findings.push(...r.findings)
    out.allowed.push(...r.allowed)
    out.files++
  }
  return out
}

module.exports = { scan, scanText, split, RULES }

if (require.main === module) {
  const r = scan(ROOT)
  const check = process.argv.includes('--check')
  if (!check) {
    // loop: NOT-WORTH — the marked exceptions, once
    for (const a of r.allowed) console.log('ok (marked)  ' + a.file + ':' + a.line + '  ' + a.rule + '  ' + a.code)
  }
  if (r.findings.length) {
    console.error('hardcodes: ' + r.findings.length + ' user-facing value(s) typed where a single source exists:')
    // loop: NOT-WORTH — the findings, once
    for (const x of r.findings) console.error('  ' + x.file + ':' + x.line + '  ' + x.rule + ': ' + x.code + '\n      fix: ' + x.fix)
    if (check) process.exitCode = 1
  } else console.log('hardcodes: none in ' + r.files + ' shipped files (' + r.allowed.length + ' marked exceptions; tools/hardcodes.js lists them).')
}
