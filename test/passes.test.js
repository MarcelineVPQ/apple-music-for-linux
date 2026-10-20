// The AST passes (tools/passes.js, the DS5 configurator's list_loops / list_errors / list_caches ported to
// Sonata): every gated row in every shipped file carries a verdict, and the lister finds what it should.
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')
const P = require('../tools/passes')

test('every gated loop, error and cache row in every shipped file has a verdict', () => {
  const bad = P.failures(P.scan(path.join(__dirname, '..')))
  assert.deepEqual(bad.map((r) => r.file + ':' + r.line + ' ' + r.kind + ' ' + r.sub + ' ' + r.code), [], 'run node tools/passes.js --check')
})

test('the lister: hot array callbacks, floating promises, kept state', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'passes-'))
  try {
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ build: { files: ['a.js'] } }))
    fs.writeFileSync(path.join(dir, 'a.js'), [
      "const seen = new Map()",                                    // 1 module collection written below
      "let lastKey = null",                                         // 2 memo scalar
      "async function load() { return 1 }",                         // 3
      "function tick(list) {",                                      // 4 hot by name
      "  lastKey = list.map((x) => x * 2).join()",                  // 5 hot .map
      "  seen.set(lastKey, 1)",                                     // 6
      "  load()",                                                   // 7 floating
      "}",
      "// cache: OK — key=k; invalidated=never; bound=1",            // 9
      "const kept = new Set()",                                      // 10 gated, has a verdict
      "function put(k) { kept.add(k); JSON.parse(k) }",              // 11 json-parse outside a try
      "setInterval(() => tick([]), 1000)"
    ].join('\n'))
    const rows = P.scan(dir)
    const at = (line, kind) => rows.filter((r) => r.line === line && r.kind === kind)
    assert.ok(at(1, 'cache').length && at(2, 'cache').length, 'module state')
    assert.match(at(5, 'loop')[0].detail, /hot/)
    assert.equal(at(7, 'error')[0].sub, 'floating')
    assert.equal(at(11, 'error')[0].sub, 'json-parse')
    assert.equal(at(10, 'cache')[0].verdict, 'OK')
    const bad = P.failures(rows).map((r) => r.line + r.kind)
    assert.ok(bad.includes('1cache') && bad.includes('5loop') && !bad.includes('10cache'))
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('a cache verdict names its key, invalidation and bound', () => {
  const row = { gated: true, kind: 'cache', verdict: 'OK', reason: 'per song' }
  assert.equal(P.failures([row]).length, 1)
  assert.equal(P.failures([{ ...row, reason: 'key=isrc; invalidated=new song; bound=1' }]).length, 0)
})
