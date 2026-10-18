// Fake sonata-align helper for test/align-helper.test.js: the JSON-lines protocol of the Sonata
// engine (protocol 2, docs/LEVEL2-ALIGN.md "Helper protocol") without any models or engine code.
// FAKE_MODE: '' (normal), 'crash' (exits on align), 'hang' (never answers align), 'noise' (prints a
// non-JSON line first). FAKE_PROTOCOL: the pong's protocol ('none': no field, as protocol 1 helpers).
const mode = process.env.FAKE_MODE || ''
const send = (m) => process.stdout.write(JSON.stringify(m) + '\n')
if (mode === 'noise') process.stdout.write('some library banner\n')
const streams = new Map()
let rest = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  const lines = (rest + chunk).split('\n')
  rest = lines.pop()
  // loop: one pass over the complete request lines in this chunk
  for (const raw of lines) {
    if (!raw.trim()) continue
    const req = JSON.parse(raw)
    if (req.cmd === 'ping') send(Object.assign({ type: 'pong', version: '0.2.0' }, process.env.FAKE_PROTOCOL === 'none' ? {} : { protocol: Number(process.env.FAKE_PROTOCOL || 2) }, { device: 'cpu', models: {}, env: { home: process.env.SONATA_ALIGN_HOME, ld: process.env.LD_LIBRARY_PATH || null } }))
    else if (req.cmd === 'align') {
      if (mode === 'crash') process.exit(3)
      streams.set(req.id, { req, bytes: 0 })
    } else if (req.cmd === 'chunk') streams.get(req.id).bytes += Buffer.from(req.data, 'base64').length
    else if (req.cmd === 'end') {
      if (mode === 'hang') continue
      const { req: r, bytes } = streams.get(req.id)
      streams.delete(req.id)
      send({ type: 'progress', id: req.id, stage: 'separate', p: 0 })
      const out = r.lines.map((l, i) => ({ line: i, aligned: true, confidence: 0.5,
        words: l.text.split(/\s+/).filter(Boolean).map((w, k) => ({ t: l.t + k * 0.3, end: l.t + k * 0.3 + 0.25, text: w, conf: 0.5 })) }))
      send({ type: 'result', id: req.id, source: 'aligned', lines: out, stats: { bytes, aligner: 'fake' } })
    } else if (req.cmd === 'quit') process.exit(0)
  }
})
process.stdin.on('end', () => process.exit(0))
