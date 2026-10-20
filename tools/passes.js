#!/usr/bin/env node
// The AST passes (42PS Standard "Code quality passes", the DS5 configurator's list_loops / list_lifetimes /
// list_errors / list_caches, ported to Sonata's plain JS). tools/verdicts.js stays the line-pattern gate for
// every for/while/do/.forEach, every acquisition and every try/catch/.catch (it also reads the page scripts
// main.js sends into Apple's page as text). This lister parses every shipped file with acorn and lists what a
// line pattern can't see:
//
//   loop    array callbacks (.map .filter .reduce .some .every .find* .flatMap .sort, and .forEach) and
//           loop statements, each with its triggers: await (serial async work in the body), hot (runs per
//           frame, per poll or per audio chunk: an rAF / setInterval / re-arming setTimeout callback, a
//           high-rate event handler ('data', 'timeupdate', pointer/mouse move, scroll, wheel, resize), a
//           function named tick/frame/draw/paint/render/step/animate, or anything those call, resolved by
//           name across the shipped files), nested (inside another loop of the same function)
//   life    the context of every acquisition verdicts.js lists (module scope vs. the function that runs it),
//           for the lifetime tables (no gate here: verdicts.js gates them)
//   error   what try/catch and .catch can't show: a .then(ok, onRejected), a `void` promise, a floating
//           promise (a statement calling an async function of the shipped files, executeJavaScript,
//           loadURL/loadFile, fetch, insertCSS, fs.promises, shell.openExternal or a .then chain, neither
//           awaited, returned, caught nor voided), a JSON.parse outside any try, an empty catch block
//   cache   kept state: module/class collections (Map, Set, WeakMap, array, object) written inside a
//           function; module scalars that are memos (named cache/memo/last/prev/seen/latest/cached, set with
//           ??= or ||=, set inside an `if` that tests them, or assigned a value read from a file); closure
//           memos (a function-local Map/Set/object a nested function writes and something looks up). Plus,
//           for the doc only: ttl (a comparison against Date.now()/performance.now()), repeat-io (a sync
//           file read or spawn inside a loop body) and poll-io (a timer callback that reaches a file read)
//
//   node tools/passes.js [loop|life|error|cache]            TSV rows (all kinds when none is named)
//   node tools/passes.js --check                            exit 1 on a gated row without a verdict
//   node tools/passes.js --counts                           verdict counts per pass
//   node tools/passes.js --md DIR                           the table bodies for docs/*_PASS_*.md
//
// Gated rows and the comment each needs (on the row's line or the 2 lines above; the loop and error rows
// verdicts.js also lists keep its 8-line reach):
//   loop   a hot, awaiting or nested array callback       // loop: VERDICT — reason (N, where it runs)
//   error  then-reject, void, floating, json-parse         // error: VERDICT — what happens to the failure
//   cache  every kept-state row                            // cache: VERDICT — key=…; invalidated=…; bound=…
// Cache verdicts: OK · FIX-STALE · FIX-UNBOUNDED · ADD-CACHE · REMOVE · NOT-WORTH.
'use strict'
const fs = require('fs')
const path = require('path')
const acorn = require('acorn')
const V = require('./verdicts')

const ROOT = path.join(__dirname, '..')
const NEAR = 2
const WORDS = { ...V.WORDS, cache: ['OK', 'FIX-STALE', 'FIX-UNBOUNDED', 'ADD-CACHE', 'REMOVE', 'NOT-WORTH'] }
const ITER = new Set(['map', 'filter', 'reduce', 'reduceRight', 'some', 'every', 'find', 'findIndex', 'findLast', 'findLastIndex', 'flatMap', 'sort', 'toSorted', 'forEach'])
const HOT_EVENTS = new Set(['data', 'timeupdate', 'mousemove', 'pointermove', 'scroll', 'wheel', 'resize', 'audioprocess', 'message'])
const HOT_NAME = /^(tick|frame|onFrame|draw|paint|render|step|animate|loop)([A-Z_]|$)/
const MEMO_NAME = /(cache|memo|^last|Last[A-Z]|^prev|Prev[A-Z]|seen|latest|cached)/i
const LISTENERS = /(listener|subscriber|handler|callback|waiter|resolver|watcher)s?$/i
const MUTATORS = new Set(['set', 'add', 'push', 'unshift', 'splice', 'delete', 'clear', 'pop', 'shift'])
const SYNC_IO = /^(readFileSync|statSync|existsSync|readdirSync|accessSync|lstatSync|realpathSync|execFileSync|execSync|spawnSync|openSync)$/
const ASYNC_IO_MEMBERS = new Set(['executeJavaScript', 'loadURL', 'loadFile', 'insertCSS', 'removeInsertedCSS', 'openExternal', 'showOpenDialog', 'showSaveDialog', 'showMessageBox', 'whenReady', 'capturePage'])

// ---- parsing -------------------------------------------------------------------------------------------
function parseFile(file, text) {
  const src = file.endsWith('.html') ? V.codeLines(file, text).join('\n') : text
  const opts = { ecmaVersion: 'latest', locations: true, allowHashBang: true, allowReturnOutsideFunction: true, allowAwaitOutsideFunction: true }
  try { return acorn.parse(src, { ...opts, sourceType: 'script' }) } catch (e) { // error: PASSES-ON — retried as a module, the second failure is thrown to the caller
    return acorn.parse(src, { ...opts, sourceType: 'module' })
  }
}

// walk every node with its ancestors (no external walker: acorn's ESTree nodes are plain objects)
function walk(node, visit, anc = []) {
  if (!node || typeof node.type !== 'string') return
  visit(node, anc)
  anc.push(node)
  // loop: NOT-WORTH — the AST once per run (the tool, not the app)
  for (const k in node) {
    if (k === 'loc' || k === 'start' || k === 'end') continue
    const v = node[k]
    // loop: NOT-WORTH — children of one node
    if (Array.isArray(v)) for (const c of v) walk(c, visit, anc)
    else if (v && typeof v.type === 'string') walk(v, visit, anc)
  }
  anc.pop()
}

const isFn = (n) => n && /^(FunctionDeclaration|FunctionExpression|ArrowFunctionExpression)$/.test(n.type)
// the [start, end) offsets of every template literal's text parts (a comment can't go there)
const isLoopStmt = (n) => /^(ForStatement|ForInStatement|ForOfStatement|WhileStatement|DoWhileStatement)$/.test(n.type)
const calleeName = (c) => !c ? '' : c.type === 'Identifier' ? c.name : c.type === 'MemberExpression' && !c.computed ? c.property.name : ''
const isIterCall = (n) => n.type === 'CallExpression' && n.callee.type === 'MemberExpression' && !n.callee.computed && ITER.has(n.callee.property.name) && isFn(n.arguments[0])
const isLoop = (n) => isLoopStmt(n) || isIterCall(n)
const loopBody = (n) => isIterCall(n) ? n.arguments[0].body : n.body

function fnName(fn, anc) {
  if (fn.id) return fn.id.name
  const p = anc[anc.length - 1]
  if (!p) return ''
  if (p.type === 'VariableDeclarator' && p.id.type === 'Identifier') return p.id.name
  if ((p.type === 'Property' || p.type === 'MethodDefinition') && p.key) return p.key.name || p.key.value || ''
  if (p.type === 'AssignmentExpression') return calleeName(p.left)
  return ''
}
const enclosingFn = (anc) => { for (let i = anc.length - 1; i >= 0; i--) if (isFn(anc[i])) return { fn: anc[i], idx: i }; return null } // loop: NOT-WORTH — ancestor depth

// names of the functions a subtree calls (nested function bodies included: callbacks run in place here)
function callsIn(node) {
  const out = new Set()
  walk(node, (n) => { if (n.type === 'CallExpression') { const c = calleeName(n.callee); if (c) out.add(c) } })
  return out
}
// does a subtree await outside nested (non-callback) functions?
function awaitsIn(body) {
  let found = false
  walk(body, (n) => { if (n.type === 'AwaitExpression' || (n.type === 'ForOfStatement' && n.await)) found = true })
  return found
}

// ---- the program: every shipped file parsed, functions by name ------------------------------------------
function program(root) {
  const files = []
  const fnsByName = new Map()
  // loop: NOT-WORTH — ~100 shipped files, once per run
  for (const f of V.shippedFiles(root)) {
    const text = fs.readFileSync(path.join(root, f), 'utf8')
    let ast
    try { ast = parseFile(f, text) } catch (e) { files.push({ file: f, error: e.message, raw: text.split('\n') }); continue } // error: SHOWN — the file is reported as unparsed and --check fails
    const entry = { file: f, ast, raw: text.split('\n'), fns: [] }
    walk(ast, (n, anc) => {
      if (!isFn(n)) return
      const name = fnName(n, anc)
      entry.fns.push({ node: n, name })
      if (name) { if (!fnsByName.has(name)) fnsByName.set(name, []); fnsByName.get(name).push({ file: f, node: n }) }
    })
    files.push(entry)
  }
  return { files, fnsByName }
}

// the hot functions: roots, then everything they call by a name defined in the shipped files
function hotSet(prog) {
  const hot = new Set()
  const queue = []
  const mark = (fn, why, file) => { if (fn && !hot.has(fn)) { hot.add(fn); fn._hotWhy = why; fn._file = file; queue.push(fn) } }
  const chain = (why, name) => { const parts = (why + ' → ' + name).split(' → '); return parts.length > 4 ? parts[0] + ' → … → ' + parts.slice(-2).join(' → ') : parts.join(' → ') }
  // a name resolves to its definition in the caller's own file, else to the one definition in the shipped files
  // (a name defined in several other files is ambiguous and not followed)
  const byName = (name, why, from) => {
    const d = prog.fnsByName.get(name) || []
    const own = d.filter((x) => x.file === from)
    const pick = own.length ? own : d.length === 1 ? d : []
    for (const x of pick) mark(x.node, why, x.file) // loop: NOT-WORTH — ≤ a few definitions
  }
  // loop: NOT-WORTH — once per run
  for (const f of prog.files) {
    if (!f.ast) continue
    walk(f.ast, (n, anc) => {
      if (isFn(n) && HOT_NAME.test(fnName(n, anc))) mark(n, fnName(n, anc) + '()@' + f.file + ':' + n.loc.start.line, f.file)
      if (n.type !== 'CallExpression') return
      const c0 = calleeName(n.callee)
      const at = '@' + f.file + ':' + n.loc.start.line
      const c = c0
      const a0 = n.arguments[0]
      if (c === 'setInterval' || c === 'requestAnimationFrame') {
        if (isFn(a0)) mark(a0, c + at, f.file); else if (a0 && a0.type === 'Identifier') byName(a0.name, c + at, f.file)
      } else if (c === 'setTimeout' && a0) {
        const encl = enclosingFn(anc)
        const name = encl ? fnName(encl.fn, anc.slice(0, encl.idx)) : ''
        const body = isFn(a0) ? a0 : null
        if (a0.type === 'Identifier' && a0.name === name && encl) mark(encl.fn, 'setTimeout re-arm' + at, f.file)
        else if (body && name && callsIn(body).has(name)) mark(encl.fn, 'setTimeout re-arm' + at, f.file)
      } else if ((c === 'on' || c === 'addEventListener') && a0 && a0.type === 'Literal' && HOT_EVENTS.has(a0.value)) {
        const h = n.arguments[1]
        if (isFn(h)) mark(h, "'" + a0.value + "'" + at, f.file); else if (h && h.type === 'Identifier') byName(h.name, "'" + a0.value + "'" + at, f.file)
      }
    })
  }
  // loop: NOT-WORTH — each hot function is visited once
  while (queue.length) {
    const fn = queue.shift()
    // loop: NOT-WORTH — the names one function calls
    for (const name of callsIn(fn.body)) byName(name, chain(fn._hotWhy || 'hot', name), fn._file)
  }
  return hot
}

// ---- verdicts -------------------------------------------------------------------------------------------
function verdictNear(raw, line, kind, reach) {
  const re = new RegExp('(?://|/\\*)\\s*' + kind + ':\\s*([A-Z][A-Z-]*)?(.*)')
  // loop: NOT-WORTH — at most reach + 1 lines
  for (let k = line; k >= Math.max(0, line - reach); k--) {
    const m = re.exec(raw[k] || '')
    if (m) return { word: m[1] || '', text: (m[2] || '').replace(/\*\/.*$/, '').replace(/^\s*—\s*/, '').trim() }
  }
  if (kind === 'error') { for (const k of [line + 1]) { const m = re.exec(raw[k] || ''); if (m) return { word: m[1] || '', text: (m[2] || '').trim() } } } // loop: NOT-WORTH — one line
  return null
}

// ---- the passes -----------------------------------------------------------------------------------------
function scan(root = ROOT) {
  const prog = program(root)
  const hot = hotSet(prog)
  const rows = []
  const add = (f, node, kind, sub, detail, gated, reach) => {
    const line = node.loc.start.line - 1
    const vk = kind === 'life' ? null : kind
    const v = vk ? verdictNear(f.raw, line, vk, reach) : null
    rows.push({ file: f.file, line: line + 1, col: node.loc.start.column, kind, sub, detail, gated, verdict: v ? v.word : '', reason: v ? v.text : '', code: (f.raw[line] || '').trim().slice(0, 100) })
  }
  // loop: NOT-WORTH — once per run
  for (const f of prog.files) {
    if (!f.ast) { rows.push({ file: f.file, line: 0, kind: 'parse', sub: 'error', detail: f.error, gated: true, verdict: '', reason: '', code: '' }); continue }
    const asyncNames = new Set()
    walk(f.ast, (n, anc) => { if (isFn(n) && n.async) { const nm = fnName(n, anc); if (nm) asyncNames.add(nm) } })
    // the shipped files' async functions by name, for floating calls through a module (helper.run())
    // (only from the files this one requires: a DOM page's el.remove() is not helper-installer's remove())
    const required = new Set([f.file])
    walk(f.ast, (n) => { if (n.type === 'CallExpression' && calleeName(n.callee) === 'require' && n.arguments[0] && typeof n.arguments[0].value === 'string' && n.arguments[0].value.startsWith('./')) required.add(n.arguments[0].value.slice(2).replace(/(\.js)?$/, '.js')) })
    // loop: NOT-WORTH — once per file
    for (const [nm, defs] of prog.fnsByName) if (defs.length === 1 && defs[0].node.async && required.has(defs[0].file)) asyncNames.add(nm)

    const topLevel = new Map() // name -> declarator node (module scope)
    // loop: NOT-WORTH — the top-level statements of one file
    for (const st of f.ast.body) {
      if (st.type !== 'VariableDeclaration') continue
      // loop: NOT-WORTH — declarators of one statement
      for (const d of st.declarations) if (d.id.type === 'Identifier') topLevel.set(d.id.name, { decl: d, kind: st.kind })
    }
    const writes = new Map() // name -> {mut, assign, nullish, guarded, io}
    const w = (name) => { if (!writes.has(name)) writes.set(name, { mut: 0, assign: 0, nullish: 0, guarded: 0, io: 0, lookups: 0 }); return writes.get(name) }

    walk(f.ast, (n, anc) => {
      const encl = enclosingFn(anc)
      const inFn = !!encl
      // loops
      if (isLoop(n)) {
        const trig = []
        if (awaitsIn(loopBody(n))) trig.push('await')
        if (encl && hot.has(encl.fn)) trig.push('hot(' + (encl.fn._hotWhy || '') + ')')
        let nested = false
        // loop: NOT-WORTH — ancestor depth
        for (let i = anc.length - 1; i >= 0 && !(encl && i <= encl.idx && !isIterCall(anc[i])); i--) {
          if (isLoopStmt(anc[i]) || (isIterCall(anc[i]) && anc[i].arguments[0] !== n)) { nested = true; break }
          if (isFn(anc[i]) && !(anc[i - 1] && isIterCall(anc[i - 1]))) break
        }
        if (nested) trig.push('nested')
        const iter = isIterCall(n)
        const legacy = !iter || n.callee.property.name === 'forEach' // verdicts.js lists these
        if (legacy || trig.length) add(f, n, 'loop', iter ? '.' + n.callee.property.name : n.type.replace('Statement', '').toLowerCase(), trig.join(' '), !legacy && trig.length > 0 || legacy, legacy ? 8 : NEAR)
      }
      // lifetime context (verdicts.js gates; this adds where each runs)
      if (n.type === 'CallExpression' || n.type === 'NewExpression') {
        const c = calleeName(n.callee)
        if (/^(setInterval|setTimeout|requestAnimationFrame|addEventListener|on|once|handle|spawn|execFile|exec|fork|watch|createConnection|createObjectURL|register|start)$/.test(c) || (n.type === 'NewExpression' && /Observer|Window|View|Tray|Socket|Worker|AudioContext|Notification/.test(c))) {
          if (c !== 'start' || (n.callee.object && calleeName(n.callee.object) === 'powerSaveBlocker')) {
            const ctx = !inFn ? 'module' : (fnName(encl.fn, anc.slice(0, encl.idx)) || '(anonymous)') + (hot.has(encl.fn) ? ' [hot]' : '')
            add(f, n, 'life', c, ctx, false, 8)
          }
        }
      }
      // errors
      if (n.type === 'CallExpression' && calleeName(n.callee) === 'then' && n.arguments.length >= 2) add(f, n, 'error', 'then-reject', '', true, NEAR)
      if (n.type === 'UnaryExpression' && n.operator === 'void' && n.argument.type === 'CallExpression') add(f, n, 'error', 'void', '', true, NEAR)
      if (n.type === 'ExpressionStatement' && n.expression.type === 'CallExpression') {
        const e = n.expression
        const c = calleeName(e.callee)
        const handled = c === 'catch'
        const isThen = c === 'then'
        const asyncCall = (e.callee.type === 'Identifier' && asyncNames.has(c)) || (e.callee.type === 'MemberExpression' && (ASYNC_IO_MEMBERS.has(c) || asyncNames.has(c) || /^fs\.promises\b|^fsp\b/.test(srcOf(f, e.callee)))) || c === 'fetch'
        if (!handled && (isThen || asyncCall)) add(f, n, 'error', 'floating', isThen ? '.then without .catch' : c + '()', true, NEAR)
      }
      if (n.type === 'CallExpression' && n.callee.type === 'MemberExpression' && calleeName(n.callee) === 'parse' && n.callee.object.type === 'Identifier' && n.callee.object.name === 'JSON') {
        let guarded = false
        // loop: NOT-WORTH — ancestor depth
        for (let i = anc.length - 1; i >= 0; i--) { if (anc[i].type === 'TryStatement' && anc[i + 1] === anc[i].block) { guarded = true; break } if (isFn(anc[i]) && !(anc[i - 1] && anc[i - 1].type === 'CallExpression')) break }
        if (!guarded) add(f, n, 'error', 'json-parse', 'outside a try', true, NEAR)
      }
      if (n.type === 'CatchClause' && n.body.body.length === 0) add(f, n, 'error', 'empty-catch', '', false, 2)
      // cache: writes to module-level names from inside functions
      if (inFn) {
        if (n.type === 'CallExpression' && n.callee.type === 'MemberExpression' && n.callee.object.type === 'Identifier' && topLevel.has(n.callee.object.name)) {
          const p = n.callee.property.name
          if (MUTATORS.has(p)) w(n.callee.object.name).mut++
          if (p === 'get' || p === 'has') w(n.callee.object.name).lookups++
        }
        if (n.type === 'AssignmentExpression') {
          const L = n.left
          if (L.type === 'MemberExpression' && L.object.type === 'Identifier' && topLevel.has(L.object.name)) w(L.object.name).mut++
          if (L.type === 'Identifier' && topLevel.has(L.name)) {
            const r = w(L.name); r.assign++
            if (n.operator === '??=' || n.operator === '||=') r.nullish++
            // loop: NOT-WORTH — ancestor depth
            for (let i = anc.length - 1; i > encl.idx; i--) if (anc[i].type === 'IfStatement' && mentions(anc[i].test, L.name)) { r.guarded++; break }
            if (readsIO(n.right)) r.io++
          }
        }
        if (n.type === 'UnaryExpression' && n.operator === 'delete' && n.argument.type === 'MemberExpression' && n.argument.object.type === 'Identifier' && topLevel.has(n.argument.object.name)) w(n.argument.object.name).mut++
      }
      // closure memos: a function-local collection written by a nested function and looked up
      if (isFn(n) && n.body.type === 'BlockStatement') {
        // loop: NOT-WORTH — the statements of one function body
        for (const st of n.body.body) {
          if (st.type !== 'VariableDeclaration') continue
          // loop: NOT-WORTH — declarators of one statement
          for (const d of st.declarations) {
            if (d.id.type !== 'Identifier' || !isCollection(d.init) || LISTENERS.test(d.id.name)) continue
            const nm = d.id.name
            let nestedWrite = false; let lookup = false
            walk(n.body, (m, a2) => {
              if (m.type === 'CallExpression' && m.callee.type === 'MemberExpression' && m.callee.object.type === 'Identifier' && m.callee.object.name === nm) {
                const p = m.callee.property.name
                if (p === 'get' || p === 'has') lookup = true
                if (MUTATORS.has(p) && a2.some((x) => isFn(x))) nestedWrite = true // loop: NOT-WORTH — ancestor depth
              }
              if (m.type === 'AssignmentExpression' && m.left.type === 'MemberExpression' && m.left.object.type === 'Identifier' && m.left.object.name === nm && m.left.computed && a2.some((x) => isFn(x))) nestedWrite = true // loop: NOT-WORTH — ancestor depth
              if (m.type === 'MemberExpression' && m.computed && m.object.type === 'Identifier' && m.object.name === nm) lookup = true
            })
            if (nestedWrite && lookup) add(f, d, 'cache', 'closure', nm, true, NEAR)
          }
        }
      }
      // class fields: this.x = new Map() / [] / {} that methods mutate
      if (n.type === 'AssignmentExpression' && n.left.type === 'MemberExpression' && n.left.object.type === 'ThisExpression' && isCollection(n.right) && encl && fnName(encl.fn, anc.slice(0, encl.idx)) === 'constructor') {
        const nm = n.left.property.name
        if (!LISTENERS.test(nm) && /cache|memo|seen|known|pending|queue|map|byId|by[A-Z]/i.test(nm)) add(f, n, 'cache', 'field', nm, true, NEAR)
      }
      // doc-only cache rows
      if (n.type === 'BinaryExpression' && /^[<>]=?$/.test(n.operator) && (clockIn(n.left) || clockIn(n.right))) add(f, n, 'cache', 'ttl', '', false, NEAR)
      if (n.type === 'CallExpression' && SYNC_IO.test(calleeName(n.callee))) {
        // loop: NOT-WORTH — ancestor depth
        for (let i = anc.length - 1; i >= 0; i--) { if (isFn(anc[i]) && !(anc[i - 1] && isIterCall(anc[i - 1]))) break; if ((isLoopStmt(anc[i]) && anc[i + 1] === anc[i].body) || isIterCall(anc[i])) { add(f, n, 'cache', 'repeat-io', calleeName(n.callee), false, NEAR); break } }
        if (encl && hot.has(encl.fn)) add(f, n, 'cache', 'poll-io', calleeName(n.callee) + ' in ' + (encl.fn._hotWhy || 'hot'), false, NEAR)
      }
    })
    // module-level kept state
    // loop: NOT-WORTH — the top-level names of one file
    for (const [nm, { decl, kind }] of topLevel) {
      const r = writes.get(nm)
      if (!r || LISTENERS.test(nm)) continue
      const coll = isCollection(decl.init)
      if (coll && r.mut) add(f, decl, 'cache', 'module', nm + ' (' + collKind(decl.init) + ')', true, NEAR)
      else if (!coll && kind !== 'const' && r.assign && (MEMO_NAME.test(nm) || r.nullish || r.io || (r.guarded && /^(null|undefined)$/.test(lit(decl.init))))) add(f, decl, 'cache', 'module', nm + ' (' + (r.io ? 'read from I/O' : r.nullish ? '??=' : MEMO_NAME.test(nm) ? 'memo name' : 'lazy init') + ')', true, NEAR)
      else if (!coll && kind !== 'const' && decl.init && readsIO(decl.init)) add(f, decl, 'cache', 'snapshot', nm, true, NEAR)
    }
  }
  return rows
}
function srcOf(f, node) {
  const lines = f.raw
  if (node.loc.start.line !== node.loc.end.line) return ''
  return lines[node.loc.start.line - 1].slice(node.loc.start.column, node.loc.end.column)
}
function mentions(node, name) { let m = false; walk(node, (x) => { if (x.type === 'Identifier' && x.name === name) m = true }); return m }
function isCollection(n) {
  if (!n) return false
  if (n.type === 'NewExpression' && /^(Map|Set|WeakMap|WeakSet|Array)$/.test(calleeName(n.callee))) return true
  return n.type === 'ArrayExpression' || (n.type === 'ObjectExpression' && n.properties.length === 0)
}
const collKind = (n) => n.type === 'NewExpression' ? calleeName(n.callee) : n.type === 'ArrayExpression' ? 'array' : 'object'
const lit = (n) => !n ? 'undefined' : n.type === 'Literal' ? String(n.value) : n.type === 'Identifier' ? n.name : ''
function readsIO(node) {
  let io = false
  walk(node, (x) => { if (x.type === 'CallExpression' && /^(readFileSync|readFile|execFileSync|execSync|spawnSync|readdirSync|statSync)$/.test(calleeName(x.callee))) io = true })
  return io
}
function clockIn(node) {
  let c = false
  walk(node, (x) => { if (x.type === 'CallExpression' && x.callee.type === 'MemberExpression' && calleeName(x.callee) === 'now' && /^(Date|performance)$/.test(calleeName(x.callee.object))) c = true })
  return c
}

function failures(rows) {
  return rows.filter((r) => {
    if (!r.gated) return false
    if (r.kind === 'parse') return true
    if (!WORDS[r.kind] || !WORDS[r.kind].includes(r.verdict)) return true
    if (r.kind === 'cache' && !/key=.*invalidated=.*bound=/.test(r.reason)) return true
    return false
  })
}

// every row of every pass: tools/verdicts.js's line-pattern rows and this lister's AST rows, one list
function merged(root = ROOT) {
  const ast = scan(root)
  const ctx = new Map()
  // loop: NOT-WORTH — the rows, once per run
  for (const r of ast) { const k = r.file + ':' + r.line + ':' + (r.kind === 'life' ? 'lifetime' : r.kind); if (!ctx.has(k)) ctx.set(k, r) }
  const out = []
  const raws = new Map()
  const rawOf = (f) => { if (!raws.has(f)) raws.set(f, fs.readFileSync(path.join(root, f), 'utf8').split('\n')); return raws.get(f) } // cache: NOT-WORTH — key=file; invalidated=never (one run of the tool); bound=the shipped files
  // loop: NOT-WORTH — the rows, once per run
  for (const r of V.scan(root)) {
    const vk = r.vkind || r.kind
    const v = verdictNear(rawOf(r.file), r.line - 1, vk, 8)
    const c = ctx.get(r.file + ':' + r.line + ':' + r.kind)
    out.push({ pass: r.kind, file: r.file, line: r.line, what: (c && c.kind !== 'life' ? c.sub : '') || r.code.slice(0, 60), detail: c ? c.detail : '', verdict: r.word ? (vk === r.kind ? '' : vk + ':') + r.word : '', reason: v ? v.text : '' })
  }
  const legacy = new Set(out.map((r) => r.file + ':' + r.line + ':' + r.pass))
  // loop: NOT-WORTH — the rows, once per run
  for (const r of ast) {
    if (r.kind === 'life' || r.kind === 'parse') continue
    if (legacy.has(r.file + ':' + r.line + ':' + r.kind) && (r.kind !== 'error' || r.sub === 'empty-catch')) continue
    out.push({ pass: r.kind, file: r.file, line: r.line, what: r.sub, detail: r.detail, verdict: r.verdict, reason: r.reason })
  }
  return out.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line)
}

module.exports = { scan, failures, merged, WORDS, parseFile, walk }

if (require.main === module) {
  const args = process.argv.slice(2)
  const only = args.find((a) => ['loop', 'life', 'error', 'cache'].includes(a))
  const rows = scan(ROOT).filter((r) => !only || r.kind === only)
  if (args.includes('--check')) {
    const bad = failures(rows)
    if (bad.length) {
      console.error(bad.length + ' of ' + rows.filter((r) => r.gated).length + ' gated rows lack a verdict (tools/passes.js header says which words):')
      // loop: NOT-WORTH — the failures, once
      for (const r of bad) console.error('  ' + r.file + ':' + r.line + '  ' + r.kind + ' ' + r.sub + ' ' + r.detail + (r.verdict ? '  (has "' + r.verdict + '")' : '') + '  ' + r.code)
      process.exitCode = 1
    } else console.log('passes: all ' + rows.filter((r) => r.gated).length + ' gated rows carry a verdict (' + rows.length + ' rows).')
  } else if (args.includes('--counts')) {
    const c = {}
    // loop: NOT-WORTH — the rows, once
    for (const r of merged(ROOT)) { const k = r.pass + '\t' + (r.verdict || '—'); c[k] = (c[k] || 0) + 1 }
    // loop: NOT-WORTH — the counts, once
    for (const k of Object.keys(c).sort()) console.log(k + '\t' + c[k])
  } else if (args.includes('--md')) {
    // the full tables for docs/*_PASS_*.md: tools/verdicts.js's rows (with their comment's reason and this
    // lister's trigger / context for the same line) and this lister's own rows, one file per pass
    const dir = args[args.indexOf('--md') + 1]
    const esc = (s) => String(s).replace(/\|/g, '\\|')
    const all = merged(ROOT)
    // loop: NOT-WORTH — four passes
    for (const kind of ['loop', 'lifetime', 'error', 'cache']) {
      const out = ['| file:line | what | trigger / context | verdict | reason |', '|---|---|---|---|---|']
      // loop: NOT-WORTH — the rows, once
      for (const r of all.filter((x) => x.pass === kind)) out.push('| ' + r.file + ':' + r.line + ' | ' + esc(r.what) + ' | ' + esc(r.detail) + ' | ' + (r.verdict || '') + ' | ' + esc(r.reason) + ' |')
      fs.writeFileSync(path.join(dir, kind + '.md'), out.join('\n') + '\n')
    }
  } else {
    // loop: NOT-WORTH — the table, once
    for (const r of rows) console.log([r.file + ':' + r.line, r.kind, r.sub, r.detail, r.verdict || (r.gated ? '—' : ''), r.code].join('\t'))
  }
}
