// Fake sonata-align helper for test/align-helper.test.js: the JSON-lines protocol of the Sonata
// engine (protocol 2, docs/LEVEL2-ALIGN.md "Helper protocol") without any models or engine code.
// FAKE_MODE: '' (normal), 'crash' (exits on align), 'hang' (never answers align), 'noise' (prints a
// non-JSON line first). FAKE_PROTOCOL: the pong's protocol ('none': no field, as protocol 1 helpers).
// Also the sheet notes of lyrics with their own word timing: `separate` (a section kept) and `notes`
// with `given` (from the kept sections, else no-stem; or from streamed audio).
// Look-ahead play's `stream` job: ready at once (FAKE_STREAM=no-gpu: refused as on a CPU), and each
// line's words, once, when a chunk reaches the line's start (FAKE_STREAM=late: every word marked late).
const mode = process.env.FAKE_MODE || ''
const send = (m) => process.stdout.write(JSON.stringify(m) + '\n')
if (mode === 'noise') process.stdout.write('some library banner\n')
const streams = new Map()
const kept = new Map()        // song -> kept section offsets (the `separate` jobs)
// the notes of lyrics with their own word timing: one note per given syllable (MIDI 60 + its index)
function givenNotes(id, req, bytes) {
  const syl = (req.given && req.given.syllables) || []
  const from = bytes != null ? 'audio' : 'kept'
  if (from === 'kept' && !kept.has(req.song)) { send({ type: 'error', id, code: 'no-stem', message: 'not kept' }); return }
  const offsets = kept.get(req.song) || []
  kept.delete(req.song)
  send({ type: 'result', id, notes: { format: 1, model: 'fake', key: { name: 'C major', fifths: 0, mode: 'major' }, syllables: syl,
    notes: syl.map((s, i) => ({ t: s.t, end: s.end, midi: 60 + (i % 12), cents: 0, name: '', conf: 0.9, syl_index: i, line: s.line, melisma: false })),
    pitch: { t0: 0, hop: 0.05, v: [600] } }, stats: { given: true, from, bytes: bytes || 0, sections: offsets.length } })
}
let rest = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  const lines = (rest + chunk).split('\n')
  rest = lines.pop()
  // loop: one pass over the complete request lines in this chunk
  for (const raw of lines) {
    if (!raw.trim()) continue
    const req = JSON.parse(raw)
    if (req.cmd === 'ping') send(Object.assign({ type: 'pong', version: '0.2.0' }, process.env.FAKE_PROTOCOL === 'none' ? {} : { protocol: Number(process.env.FAKE_PROTOCOL || 2) }, { device: 'cpu', models: {}, features: ['stream'], stream_ready: process.env.FAKE_STREAM !== 'no-gpu', stream_reason: process.env.FAKE_STREAM === 'no-gpu' ? 'no-gpu' : undefined, env: { home: process.env.SONATA_ALIGN_HOME, ld: process.env.LD_LIBRARY_PATH || null } }))
    else if (req.cmd === 'separate' || (req.cmd === 'notes' && req.given && req.audio)) streams.set(req.id, { req, bytes: 0 })
    else if (req.cmd === 'notes' && req.given) givenNotes(req.id, req, null)
    else if (req.cmd === 'stream') {
      if (process.env.FAKE_STREAM === 'no-gpu') { send({ type: 'error', id: req.id, code: 'no-gpu', message: 'streaming needs a GPU' }); continue }
      streams.set(req.id, { req, bytes: 0, sent: new Set(), chunks: [] })
      send({ type: 'stream', id: req.id, state: 'ready', device: 'cuda', hop: 0.25 })
    } else if (req.cmd === 'chunk' && streams.get(req.id) && streams.get(req.id).req.cmd === 'stream') {
      const st = streams.get(req.id)
      const n = Buffer.from(req.data, 'base64').length
      st.bytes += n
      st.chunks.push(req.t)
      const until = req.t + n / 4 / st.req.audio.rate
      const lines = {}
      // loop: one pass over the request's lines per chunk (test fixture)
      st.req.lines.forEach((l, i) => {
        if (st.sent.has(i) || l.t > until) return
        st.sent.add(i)
        lines[i] = l.text.split(/\s+/).filter(Boolean).map((w, k) => Object.assign({ t: l.t + k * 0.3, end: l.t + k * 0.3 + 0.25, text: w, conf: 0.6 }, process.env.FAKE_STREAM === 'late' ? { late: true } : {}))
      })
      const out = Object.keys(lines).map((i) => ({ line: Number(i), words: lines[i] }))
      if (out.length) send({ type: 'words', id: req.id, heard: until, lines: out })
    } else if (req.cmd === 'end' && streams.get(req.id) && streams.get(req.id).req.cmd === 'stream') {
      const st = streams.get(req.id)
      streams.delete(req.id)
      send({ type: 'result', id: req.id, source: 'stream', stats: { hops: st.chunks.length, bytes: st.bytes, first_t: st.chunks[0], words: st.sent.size } })
    }
    else if (req.cmd === 'align') {
      if (mode === 'crash') process.exit(3)
      streams.set(req.id, { req, bytes: 0 })
    } else if (req.cmd === 'chunk') streams.get(req.id).bytes += Buffer.from(req.data, 'base64').length
    else if (req.cmd === 'end') {
      if (mode === 'hang') continue
      const { req: r, bytes } = streams.get(req.id)
      streams.delete(req.id)
      if (r.cmd === 'separate') {
        kept.set(r.song, (kept.get(r.song) || []).concat([r.offset]))
        send({ type: 'result', id: req.id, kept: true, stats: { bytes, separate_s: 0.01 } })
        continue
      }
      if (r.cmd === 'notes') { givenNotes(req.id, r, bytes); continue }
      send({ type: 'progress', id: req.id, stage: 'separate', p: 0 })
      const out = r.lines.map((l, i) => ({ line: i, aligned: true, confidence: 0.5,
        words: l.text.split(/\s+/).filter(Boolean).map((w, k) => ({ t: l.t + k * 0.3, end: l.t + k * 0.3 + 0.25, text: w, conf: 0.5 })) }))
      send({ type: 'result', id: req.id, source: 'aligned', lines: out, stats: { bytes, aligner: 'fake' } })
    } else if (req.cmd === 'quit') process.exit(0)
  }
})
process.stdin.on('end', () => process.exit(0))
