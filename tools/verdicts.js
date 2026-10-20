#!/usr/bin/env node
// The verdict lister (42PS Standard, "Code quality passes"; docs/PERFORMANCE.md). Mechanical, never
// sampled by eye: it lists every candidate in every file Sonata ships (package.json build.files: the
// .js files and the <script> blocks of the .html pages, including the page scripts main.js sends into
// Apple's page as text) and the verdict each one carries.
//
//   node tools/verdicts.js            the full table (file:line, kind, verdict, code)
//   node tools/verdicts.js --check    exit 1 listing every candidate without a verdict (npm run gates, CI)
//
// Candidates and the comments they need:
//   loop      for / while / do loops and .forEach        // loop: VERDICT — reason
//   lifetime  timers (setTimeout, setInterval, requestAnimationFrame), listeners (addEventListener,
//             emitter .on/.once, ipcMain.on/handle, ipcRenderer.on/once, onX = handlers), observers,
//             child processes (spawn, exec, execFile, fork), windows, views, trays, sockets, streams,
//             watchers, audio contexts, Web Animations (el.animate: fill 'forwards' keeps them alive),
//             object URLs, power-save blockers, global shortcuts
//                                                         // lifetime: VERDICT — release point
//             (a timer that is a recurring loop may carry its // loop: verdict instead)
//   error     try/catch and .catch()                      // error: VERDICT — what happens to the failure
// A verdict counts on the candidate's own line or in the 8 lines above it (one comment may cover a
// small group); an error verdict also on the catch's first body line. The verdict word comes first:
//   loop:     PARALLELIZE · BATCH · SERIAL-REQUIRED · HOT-PATH-OK · FIX-HOT-PATH · NOT-WORTH
//   lifetime: OK · LEAK · WASTE · HOT-ALLOC · NOT-WORTH
//   error:    SHOWN · LOGGED-OK · NOT-WORTH · PASSES-ON · SILENT-BUG · SWALLOWED
// Array callbacks other than forEach (.map, .filter, …) are bounded by their array and not listed; one
// that runs per frame gets a // loop: verdict by hand.
'use strict'
const fs = require('fs')
const path = require('path')

const ROOT = path.join(__dirname, '..')
const REACH = 8
const WORDS = {
  loop: ['PARALLELIZE', 'BATCH', 'SERIAL-REQUIRED', 'HOT-PATH-OK', 'FIX-HOT-PATH', 'NOT-WORTH'],
  lifetime: ['OK', 'LEAK', 'WASTE', 'HOT-ALLOC', 'NOT-WORTH'],
  error: ['SHOWN', 'LOGGED-OK', 'NOT-WORTH', 'PASSES-ON', 'SILENT-BUG', 'SWALLOWED']
}
const PATTERNS = {
  loop: /\b(for|while)\s*\(|\bdo\s*\{|\.forEach\(/,
  lifetime: new RegExp([
    '\\bset(Interval|Timeout)\\(', '\\brequestAnimationFrame\\(', '\\.addEventListener\\(',
    '\\.(on|once)\\(\\s*[\'"]', '\\bipc(Main|Renderer)\\.(on|once|handle|handleOnce)\\(',
    '\\.on[a-z]+\\s*=\\s*(\\(|function|async|[a-zA-Z_]+\\s*=>)',
    'new (Mutation|Resize|Intersection|Performance)Observer\\b',
    '(^|[^.\\w])(spawn|exec|execFile|execFileSync|fork)\\(', '\\.(spawn|execFile|fork)\\(',
    'new (BrowserWindow|BaseWindow|WebContentsView|Tray|Notification|WebSocket|Worker|AudioContext)\\(',
    '\\bnet\\.(createConnection|connect|createServer)\\(', 'new net\\.Socket\\(',
    '\\bfs\\.(watch|watchFile|createWriteStream|createReadStream)\\(', '\\bnet\\.request\\(',
    '\\.animate\\(\\s*[\\[a-zA-Z]', '\\bURL\\.createObjectURL\\(', '\\bpowerSaveBlocker\\.start\\(', '\\bglobalShortcut\\.register\\('
  ].join('|')),
  error: /\bcatch\s*(\(|\{)|\.catch\(/
}

// the shipped files: build.files' .js entries and .html pages (globs and exclusions skipped)
function shippedFiles(root) {
  const files = require(path.join(root, 'package.json')).build.files
  return files.filter((f) => !/[*!{]/.test(f) && /\.(js|html)$/.test(f) && !f.includes('/'))
}

// the code lines of a file: for .html only the inline <script> blocks (the rest blanked, so line
// numbers stay true)
function codeLines(file, text) {
  const lines = text.split('\n')
  if (!file.endsWith('.html')) return lines
  let inScript = false
  return lines.map((l) => {
    let out = ''
    let rest = l
    // loop: NOT-WORTH — a few tags per line at most
    while (rest.length) {
      if (!inScript) {
        const m = /<script(?![^>]*\bsrc=)[^>]*>/.exec(rest)
        if (!m) break
        inScript = true; rest = rest.slice(m.index + m[0].length)
      } else {
        const e = rest.indexOf('</script>')
        if (e < 0) { out += rest; break }
        out += rest.slice(0, e); inScript = false; rest = rest.slice(e + 9)
      }
    }
    return out
  })
}

const isCommentLine = (l) => /^\s*(\/\/|\*|\/\*)/.test(l)
// a line with its comment and its one-line string literals blanked (template-literal page scripts
// span lines and stay: they are code that runs in Apple's page)
const bare = (l) => l.replace(/'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"/g, "''").replace(/`(?:\\.|[^`\\])*`/g, '``').replace(/(^|[^:\\])\/\/.*$/, '$1').replace(/\/\*.*?\*\//g, '')

function verdictAt(lines, i, kind) {
  const kinds = kind === 'lifetime' ? ['lifetime', 'loop'] : [kind]
  const re = new RegExp('(?://|/\\*)\\s*(' + kinds.join('|') + '):\\s*([A-Z][A-Z-]*)?')
  const look = (k) => { const m = re.exec(lines[k] || ''); return m ? { kind: m[1], word: m[2] || '' } : null }
  const own = look(i)
  if (own) return own
  if (kind === 'error') { for (const k of [i + 1, i + 2]) { const m = look(k); if (m) return m } }
  // loop: NOT-WORTH — at most REACH (8) lines back per candidate
  for (let k = i - 1; k >= Math.max(0, i - REACH); k--) { const m = look(k); if (m) return m }
  return null
}

function scan(root) {
  const rows = []
  // loop: NOT-WORTH — ~45 shipped files, once per run
  for (const f of shippedFiles(root)) {
    const lines = codeLines(f, fs.readFileSync(path.join(root, f), 'utf8'))
    const raw = fs.readFileSync(path.join(root, f), 'utf8').split('\n')
    // loop: NOT-WORTH — every line of a file, once per run
    lines.forEach((l, i) => {
      if (!l.trim() || isCommentLine(l)) return
      const code = bare(l)
      // loop: NOT-WORTH — three kinds
      for (const kind of ['loop', 'lifetime', 'error']) {
        if (!PATTERNS[kind].test(code)) continue
        const v = verdictAt(raw, i, kind)
        rows.push({ file: f, line: i + 1, kind, verdict: v ? v.kind + ':' + (v.word || '?') : '', word: v ? v.word : '', vkind: v ? v.kind : '', code: l.trim().slice(0, 110) })
      }
    })
  }
  return rows
}

// what --check refuses: no verdict, or a verdict without a known verdict word first
function failures(rows) {
  return rows.filter((r) => !r.verdict || !WORDS[r.vkind].includes(r.word))
}

module.exports = { scan, failures, shippedFiles, codeLines, PATTERNS, WORDS }

if (require.main === module) {
  const rows = scan(ROOT)
  if (process.argv.includes('--check')) {
    const bad = failures(rows)
    if (bad.length) {
      console.error(bad.length + ' of ' + rows.length + ' candidates lack a verdict (tools/verdicts.js header says which words):')
      // loop: NOT-WORTH — the failures, once
      for (const r of bad) console.error('  ' + r.file + ':' + r.line + '  ' + r.kind + (r.verdict ? '  (has "' + r.verdict + '")' : '') + '  ' + r.code)
      process.exitCode = 1
    } else console.log('verdicts: all ' + rows.length + ' candidates in ' + shippedFiles(ROOT).length + ' shipped files carry a verdict.')
  } else {
    // loop: NOT-WORTH — the table, once
    for (const r of rows) console.log(r.file + ':' + r.line + '\t' + r.kind + '\t' + (r.verdict || '—') + '\t' + r.code)
  }
}
