// About → For the Curious: the numbers from fixture caches (test/fixtures/curious: a lyrics cache with one
// song of every timing kind, and one sung-notes log file), the bug-report text (nothing private), the
// sampler's life (nothing runs closed) and the new aligned-entry fields it reads.
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const os = require('os')
const path = require('path')
const C = require('../curious-model')
const { createCuriousSampler, REFRESH_MS, FRAME_MS, LIBRARY_EVERY } = require('../curious-sampler')
const { createLyricsStore } = require('../lyrics-store')
const A = require('../align-session')

const FIX = path.join(__dirname, 'fixtures', 'curious')
const store = () => createLyricsStore({ file: path.join(FIX, 'lyrics-cache.json'), fs: Object.assign({}, fs, { writeFileSync() {}, renameSync() {}, mkdirSync() {} }) })
const notesDoc = () => JSON.parse(fs.readFileSync(path.join(FIX, 'notes-precise-song.json'), 'utf8'))
const val = (rows, id) => (rows.find((r) => r.id === id) || {}).value

test('library: every timing kind counted from the lyrics cache, as Sonata would show each song', () => {
  const s = C.libraryStats(store().entries(), { estimate: true })
  assert.equal(s.songs, 8)
  assert.equal(s.apple, 1)
  assert.equal(s.lrcWords, 1)
  assert.equal(s.precise, 2, 'a whole and a partial alignment that fit their lyrics')
  assert.equal(s.partial, 1)
  assert.equal(s.refined, 1)
  assert.equal(s.estimated, 2, 'an estimated song and one whose lyrics changed after aligning')
  assert.equal(s.plain, 1)
  assert.equal(s.lineOnly, 0)
  // aligned on this PC: every aligned entry with words, the stale one too; the failed one has none
  assert.deepEqual([s.alignedSongs, s.alignedLines, s.words, s.held, s.rejected], [3, 5, 14, 1, 1])
  assert.deepEqual([s.refinedSongs, s.refinedLines, s.laterRefinements], [1, 2, 2])
  assert.deepEqual([s.oldest, s.newest, s.undated], ['2026-10-15', '2026-10-17', 1])
  assert.ok(s.bytes.lyrics > 0 && s.bytes.aligned > 0 && s.bytes.refined > 0)
  const off = C.libraryStats(store().entries(), { estimate: false })
  assert.deepEqual([off.estimated, off.lineOnly], [0, 2])
})

test('library rows: real numbers, and "Not yet known" with the reason where Sonata keeps nothing', () => {
  const s = C.libraryStats(store().entries(), { estimate: true })
  const rows = C.libraryRows(s, { lyricsFile: 3178, linerFile: null, montageFile: 2048, montageDir: { files: 2, bytes: 5 * 1024 * 1024 }, notesDir: { files: 1, bytes: 1586 } }, { estimate: true })
  assert.equal(val(rows, 'songs'), '8 songs')
  assert.equal(val(rows, 'precise'), '2 songs (1 still partial)')
  assert.equal(val(rows, 'words'), '14 words in 5 lines of 3 songs; 1 line the helper didn\'t trust')
  assert.equal(val(rows, 'refinements'), '2 line refinements (2 lines refined in 1 song)')
  assert.match(val(rows, 'favourites'), /^Not yet known: /)
  assert.match(val(rows, 'cache-lyrics'), /^3\.1 KiB on disk: .* lyrics, .* precise timing, .* refinements$/)
  assert.equal(val(rows, 'cache-liner'), 'No file yet')
  assert.equal(val(rows, 'cache-montage'), '2.0 KiB + 2 photos, 5.0 MiB')
  assert.equal(val(rows, 'cache-notes'), '1 song, 1.5 KiB')
  assert.equal(val(rows, 'oldest'), '2026-10-15 (1 song aligned before 0.15.42 carries no date)')
  assert.equal(val(rows, 'newest'), '2026-10-17')
  // an empty cache: nothing invented
  const none = C.libraryRows(C.libraryStats([], {}), {}, {})
  assert.equal(val(none, 'words'), 'None yet')
  assert.equal(val(none, 'oldest'), 'None yet')
  assert.equal(val(none, 'estimated'), '0 songs (Estimated word timing is off)')
  assert.equal(val(none, 'cache-lyrics'), 'No file yet')
})

const ON = { estimate: true, precise: true, listen: true, installed: true, dev: true }
const np = (st, k, more) => Object.assign({ title: k.split('|')[0], artist: k.split('|')[1], playing: true, lyrics: st.peek(k), aligned: st.peek('aligned|' + k), refined: st.peek('refined|' + k), notes: null, track: null, settings: ON }, more)

test('now playing: a precisely timed song with its sung notes', () => {
  const st = store()
  const k = 'Precise Song|Singer C'
  const rows = C.nowRows(np(st, k, { notes: notesDoc(), track: { key: k, startAligned: true, startRefined: false } }))
  assert.equal(val(rows, 'song'), 'Precise Song — Singer C')
  assert.equal(rows.find((r) => r.id === 'song').private, true)
  assert.equal(val(rows, 'source'), 'Precise: sonata-align 0.1.0, en model, whole song')
  assert.equal(val(rows, 'score'), '0.55 mean confidence (0 to 1) · 2 lines of 3 aligned, 1 not trusted')
  assert.equal(val(rows, 'offset'), 'Not yet known: Sonata doesn\'t learn one yet')
  assert.equal(val(rows, 'held'), '1 word held')
  assert.equal(val(rows, 'melisma'), '2 syllables sung over several notes')
  assert.equal(val(rows, 'gpu'), '12.3 s on the GPU + 3.0 s for the sung notes')
  assert.equal(val(rows, 'range'), 'G3 to D5 (19 semitones)')
  assert.equal(val(rows, 'key'), 'G minor')
  assert.equal(val(rows, 'play'), 'Later play: aligned on an earlier play')
})

test('now playing: an entry from before 0.15.42 says what it never kept; other kinds say their source', () => {
  const st = store()
  const old = C.nowRows(np(st, 'Old Song|Singer D', { track: { key: 'Old Song|Singer D', startAligned: false, startRefined: false } }))
  assert.equal(val(old, 'source'), 'Precise: sonata-align (version not kept before 0.15.42), en model, partial')
  assert.match(val(old, 'score'), /^Not yet known: aligned before 0\.15\.42, no score kept · 2 lines of 2 aligned$/)
  assert.equal(val(old, 'gpu'), 'Not yet known: aligned before 0.15.42, not kept')
  assert.equal(val(old, 'play'), 'First play: aligned during this play')
  assert.match(val(old, 'range'), /^Not yet known/)
  const apple = C.nowRows(np(st, 'Apple Song|Singer A'))
  assert.equal(val(apple, 'source'), 'Apple\'s own word timing')
  assert.equal(val(apple, 'score'), 'Not needed: the lyrics carry their own word timing')
  assert.equal(val(apple, 'play'), 'Not yet known: open the lyrics while it plays')
  assert.equal(val(C.nowRows(np(st, 'Refined Song|Singer E', { track: { key: 'Refined Song|Singer E', startAligned: false, startRefined: true } })), 'play'), 'Later play: refined on earlier plays')
  assert.equal(val(C.nowRows(np(st, 'Estimated Song|Singer F')), 'source'), 'Estimated')
  assert.equal(val(C.nowRows(np(st, 'Changed Song|Singer H')), 'source'), 'Estimated', 'stale aligned words are not used')
  assert.equal(val(C.nowRows(np(st, 'Plain Song|Singer G')), 'source'), 'Plain lyrics, no timing')
  assert.match(val(C.nowRows(np(st, 'Unknown|Nobody')), 'source'), /^Not yet known: no lyrics looked up/)
  assert.match(val(C.nowRows(np(st, 'Estimated Song|Singer F', { settings: { estimate: true } })), 'play'), /^Not yet known: Sonata learns from plays only with/)
  assert.deepEqual(C.nowRows(null), [{ id: 'song', label: 'Song', value: 'Nothing playing' }])
})

test('under the hood: CPU, memory and frames per process; audio formats in words', () => {
  const rows = C.hoodRows({
    procs: [{ label: 'Rail, This panel', cpu: 0.04, mb: 81.6, frames: [{ name: 'Rail', fps: 0 }, { name: 'This panel', fps: 1 }] }, { label: 'Graphics process', cpu: null, mb: 120, frames: [] }],
    totalMb: 201.6, helper: { state: 'Running (process 7)', vram: '1756 MiB (nvidia-smi)' }, audio: { format: '48 kHz, 2 channels, 32-bit float', latency: null }, versions: [['Sonata', '0.15.42']]
  })
  assert.equal(val(rows, 'proc-0'), '0.0 % CPU · 82 MB · frames/s: Rail 0, This panel 1')
  assert.equal(val(rows, 'proc-1'), 'measuring… · 120 MB')
  assert.equal(val(rows, 'memory'), '202 MB (working set of every Sonata process)')
  assert.equal(val(rows, 'latency'), 'Not yet known')
  assert.equal(val(rows, 'v-sonata'), '0.15.42')
  assert.equal(C.sampleSpecText('float32le 2ch 48000Hz'), '48 kHz, 2 channels, 32-bit float')
  assert.equal(C.sampleSpecText('s16le 1ch 44100Hz'), '44.1 kHz, 1 channel, 16-bit')
  assert.equal(C.sampleSpecText('garbage'), null)
})

test('bug report: every row but the private ones; no lyrics, no song or artist names', () => {
  const st = store()
  const k = 'Precise Song|Singer C'
  const groups = {
    library: C.libraryRows(C.libraryStats(st.entries(), { estimate: true }), {}, { estimate: true }),
    now: C.nowRows(np(st, k, { notes: notesDoc() })),
    hood: C.hoodRows({ procs: [], versions: [['Sonata', '0.15.42']] })
  }
  const text = C.reportText(groups, { at: '2026-10-17 20:00:00' })
  assert.match(text, /^Sonata — For the Curious \(2026-10-17 20:00:00\)\nNo lyrics, song names or personal data are included\.\n/)
  assert.match(text, /## Your library\nSongs with lyrics on this PC: 8 songs/)
  assert.match(text, /Timing source: Precise: sonata-align 0\.1\.0/)
  // nothing private: no titles, artists or lyric words from the cache
  for (const [key, value] of st.entries()) {
    for (const part of key.split('|').slice(key.startsWith('aligned|') || key.startsWith('refined|') ? 1 : 0)) assert.ok(!text.includes(part), 'leaks ' + part)
    const lines = value && (Array.isArray(value.lines) ? value.lines : value.lines ? Object.values(value.lines) : [])
    for (const l of lines || []) assert.ok(!text.includes(l.text), 'leaks the lyric "' + l.text + '"')
  }
})

// --- the sampler: stubs for every Electron call, a fake clock ---
function harness(over) {
  const timers = new Map()
  let tid = 0
  let now = 0
  const pushes = []
  const subs = { begun: 0, ended: 0 }
  const wc = { beginFrameSubscription: (dirty, cb) => { subs.begun++; cb(); cb() }, endFrameSubscription: () => { subs.ended++ } }
  let cum = 0
  const execs = []
  const st = store()
  const deps = Object.assign({
    metrics: () => [{ pid: 10, type: 'Tab', cpu: { cumulativeCPUUsage: (cum += 0.05), percentUsage: 99 }, memory: { workingSetSize: 81920 } }, { pid: 1, type: 'Browser', cpu: { cumulativeCPUUsage: cum * 2 }, memory: { workingSetSize: 102400 } }],
    views: () => [{ name: 'This panel', wc, pid: 10, shown: true }, { name: 'Mini player', wc, pid: 11, shown: false }],
    nowPlaying: async () => ({ ok: true, title: 'Precise Song', artist: 'Singer C', isPlaying: true }),
    store: { peek: (k) => st.peek(k), entries: () => st.entries() },
    track: () => null,
    settings: () => ON,
    files: () => ({ lyricsFile: 3178 }),
    notesDir: () => FIX,
    notesSuffix: () => '-precise-song.json',
    helper: () => ({ installed: true, running: true, pid: 7, paused: false }),
    ownSinkInput: (list) => list[0],
    execFile: (cmd, args, opts, cb) => { execs.push(cmd); cb(null, cmd === 'pactl' ? JSON.stringify([{ sample_specification: 'float32le 2ch 48000Hz', buffer_latency_usec: 0, sink_latency_usec: 0 }]) : '7, 1756\n99, 3\n') },
    platform: 'linux',
    versions: () => [['Sonata', 'test']],
    push: () => pushes.push(now),
    isOpen: () => true,
    now: () => now,
    date: () => new Date('2026-10-17T20:00:00Z'),
    setTimeout: (fn, ms) => { timers.set(++tid, { fn, at: now + ms }); return tid },
    clearTimeout: (id) => timers.delete(id),
    log: () => {}
  }, over)
  const s = createCuriousSampler(deps)
  // runs due timers in order, letting the refresh's promises settle between them
  const advance = async (ms) => {
    const end = now + ms
    for (;;) {
      await new Promise((r) => setImmediate(r))
      const due = [...timers].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0]
      if (!due) break
      timers.delete(due[0]); now = due[1].at; due[1].fn()
    }
    now = end
    await new Promise((r) => setImmediate(r))
  }
  return { s, timers, pushes, subs, execs, advance, deps }
}

test('sampler: nothing before it is opened; on open one refresh at once, then one every 5 s; closed, nothing runs', async () => {
  const h = harness()
  assert.equal(h.s.state(), null)
  assert.equal(h.s.report(), '')
  assert.equal(h.timers.size, 0)
  h.s.sync(true)
  await h.advance(FRAME_MS)
  const first = h.s.state()
  assert.equal(first.n, 1)
  assert.equal(h.pushes.length, 1)
  assert.equal(val(first.now, 'source'), 'Precise: sonata-align 0.1.0, en model, whole song')
  assert.equal(val(first.now, 'melisma'), '2 syllables sung over several notes', 'the song\'s notes-log file is read')
  // the hidden mini player is not subscribed; the panel's frames: 2 in the 1 s window
  assert.deepEqual([h.subs.begun, h.subs.ended], [1, 1])
  assert.equal(val(first.hood, 'proc-0'), 'measuring… · 80 MB · 2 frames/s')
  assert.equal(val(first.hood, 'vram'), '1756 MiB (nvidia-smi)')
  assert.equal(val(first.hood, 'audio'), '48 kHz, 2 channels, 32-bit float')
  assert.match(val(first.hood, 'latency'), /^Not yet known: the sound server reports 0/)
  assert.match(h.s.report(), /^Sonata — For the Curious/)
  await h.advance(REFRESH_MS + FRAME_MS)
  const second = h.s.state()
  assert.equal(second.n, 2)
  // CPU from the cumulative seconds: 0.05 s over (5 s + 1 s frame window) = 0.8 % of one core, whatever percentUsage says
  assert.equal(val(second.hood, 'proc-0'), '0.8 % CPU · 80 MB · 2 frames/s')
  h.s.copiedNote('Copied')
  assert.equal(h.s.state().copied, 'Copied')
  h.s.sync(false)
  assert.equal(h.timers.size, 0, 'closing clears the refresh timer')
  assert.equal(h.s.state(), null)
  const pushed = h.pushes.length
  const execs = h.execs.length
  await h.advance(60000)
  assert.equal(h.pushes.length, pushed, 'no refresh while closed')
  assert.equal(h.execs.length, execs, 'no child process while closed')
  assert.equal(h.subs.begun, h.subs.ended, 'every frame subscription ended')
})

test('sampler: closed during a refresh, its result is dropped; the window gone, it stops by itself', async () => {
  const h = harness()
  h.s.sync(true)
  h.s.sync(false)
  await h.advance(FRAME_MS * 2)
  assert.equal(h.s.state(), null)
  assert.equal(h.pushes.length, 0)
  let open = true
  const g = harness({ isOpen: () => open })
  g.s.sync(true)
  await g.advance(FRAME_MS)
  open = false
  await g.advance(REFRESH_MS + FRAME_MS)
  assert.equal(g.s.open, false)
  assert.equal(g.timers.size, 0)
})

test('sampler: the library is read on open and then once a minute; no helper, no nvidia-smi; other systems say so', async () => {
  let reads = 0
  const h = harness({ files: () => { reads++; return {} }, helper: () => ({ installed: true, running: false, pid: 0 }), platform: 'win32' })
  h.s.sync(true)
  await h.advance(FRAME_MS + (REFRESH_MS + FRAME_MS) * LIBRARY_EVERY)
  assert.equal(reads, 2)
  assert.deepEqual(h.execs, [], 'no child process: no helper running, no pactl off Linux')
  assert.match(val(h.s.state().hood, 'vram'), /^None: not running/)
  assert.match(val(h.s.state().hood, 'audio'), /^Not yet known: read only on Linux/)
})

test('lyrics store: peek leaves the order alone; entries carry their sizes', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'curious-store-'))
  try {
    const s = createLyricsStore({ file: path.join(dir, 'c.json'), maxEntries: 2, debounceMs: 0 })
    s.set('a', { lines: [1] }); s.set('b', { lines: [2] })
    assert.deepEqual(s.peek('a'), { lines: [1] })
    s.set('c', { lines: [3] })          // peek didn't refresh 'a': it is the one dropped
    assert.equal(s.peek('a'), null)
    assert.deepEqual(s.entries().map((e) => e[0]), ['b', 'c'])
    assert.equal(s.entries()[0][2], JSON.stringify({ lines: [2] }).length + 1)
    s.flush()
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('aligned entries (0.15.42): line confidence, engine, dates and helper seconds; merges sum the work', () => {
  const raw = [{ t: 10, text: 'one two' }, { t: 14, text: 'three four' }]
  const res = (i, conf) => ({ stats: { aligner: 'en', device: 'cuda', load_s: 9, separate_s: 4.2, emissions_s: 0.5, align_s: 0.31 }, lines: [{ line: i, aligned: true, confidence: conf, words: raw[i].text.split(' ').map((w, k) => ({ t: raw[i].t + k * 0.5, end: raw[i].t + k * 0.5 + 0.4, text: w })) }] })
  const a = A.entryFromResult(res(0, 0.61234), raw, null, { engine: '0.1.0', at: '2026-10-17T01:00:00.000Z' })
  assert.equal(a.lines[0].conf, 0.612)
  assert.deepEqual([a.engine, a.firstAt, a.lastAt, a.workS, a.device], ['0.1.0', '2026-10-17T01:00:00.000Z', '2026-10-17T01:00:00.000Z', 5.01, 'cuda'], 'model loading is not counted')
  const secs = [{ from: 0, to: 0 }, { from: 1, to: 1 }]
  const b = A.entryFromResult(res(1, 0.5), raw, null, { engine: '0.1.0', at: '2026-10-17T02:00:00.000Z' })
  const m = A.mergeEntry(a, b, secs[1], 2, raw)
  assert.deepEqual([m.firstAt, m.lastAt, m.workS], ['2026-10-17T01:00:00.000Z', '2026-10-17T02:00:00.000Z', 10.02])
  const w = A.mergeWhole(m, b, secs, raw)
  assert.deepEqual([w.firstAt, w.workS], ['2026-10-17T01:00:00.000Z', 15.03])
  // an entry from before 0.15.42 (lines, no seconds, no date): the total stays unknown, the first date too
  const old = { version: 3, lyricsHash: A.lyricsHash(raw), lines: { 0: a.lines[0] }, done: [0] }
  const o = A.mergeEntry(old, b, secs[1], 2, raw)
  assert.equal(o.workS, undefined)
  assert.equal(o.firstAt, undefined)
  assert.equal(o.lastAt, '2026-10-17T02:00:00.000Z')
  // a result without timing stats: no seconds claimed
  assert.equal(A.entryFromResult({ lines: [] }, raw, null).workS, undefined)
})

test('wiring: main samples only while About → For the Curious (or Graphics) is open and the window shown; one CPU sampler; copy is a checked action', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8')
  const open = src.slice(src.indexOf('function aboutShowing(id)'), src.indexOf('function aboutSync()'))
  for (const want of ['mainWindow.isVisible()', '!mainWindow.isMinimized()', 'settings.panelShown', "settings.panelPage === 'about'", "panelModel.isOpen(accOf('about'), id)"]) assert.ok(open.includes(want), want)
  assert.match(src, /const curiousOpen = \(\) => aboutShowing\('curious'\)/)
  assert.match(src, /gfx\.readout\(aboutShowing\('graphics'\)/)
  assert.match(src, /function aboutSync\(\) \{ gfxReadout\(\); curiousSync\(\) \}/)
  assert.match(src, /function pushPanel\(\) \{\n {2}if \(!panelAlive\(\) \|\| !panelMounted\) return\n {2}aboutSync\(\)/)
  assert.match(src, /for \(const ev of \['show', 'hide', 'minimize', 'restore'\]\) mainWindow\.on\(ev, aboutSync\)/)
  // one CPU sampler for both sections (no second /proc or getAppMetrics reader)
  assert.equal((src.match(/createCpuSampler\(/g) || []).length, 1)
  assert.match(src, /createGfx\(\{[^}]*cpuSampler/)
  assert.match(src, /cpu: cpuSampler,/)
  assert.ok(!/\/proc\/' \+ \w+\.pid \+ '\/stat/.test(fs.readFileSync(path.join(__dirname, '..', 'gfx-runtime.js'), 'utf8')), 'gfx-runtime reads no /proc of its own')
  assert.match(src, /const PANEL_ACTIONS = \[[^\]]*'curious-copy'/)
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'))
  for (const f of ['curious-model.js', 'curious-sampler.js', 'cpu-sampler.js']) assert.ok(pkg.build.files.includes(f), f + ' ships')
  const ui = fs.readFileSync(path.join(__dirname, '..', 'panel-ui.js'), 'utf8')
  assert.match(ui, /bridge\.send\('action', 'curious-copy'\)/)
  assert.match(ui, /setAttr\(said, 'role', 'status'\)/)
})

test('ISRC keys (0.15.42): an old title|artist alias is counted once, under its recording; now playing finds the ISRC entry', async () => {
  const raw = [{ t: 10, text: 'one two' }, { t: 14, text: 'three four' }]
  const words = (l) => l.text.split(' ').map((w, k) => ({ t: l.t + k * 0.5, end: l.t + k * 0.5 + 0.4, text: w }))
  const aligned = { version: 3, model: 'en', engine: '0.1.0', lyricsHash: A.lyricsHash(raw), lines: { 0: { text: raw[0].text, words: words(raw[0]), conf: 0.8 } }, rejected: [], songDuration: 200, isrc: 'USABC2600001' }
  const entries = [
    ['isrc:USABC2600001', { lines: raw, source: 'lrclib', songDuration: 200, isrc: 'USABC2600001' }, 100],
    ['Live Song (Live)|Band', { alias: 'isrc:USABC2600001', isrc: 'USABC2600001', songDuration: 200 }, 50],
    ['aligned|isrc:USABC2600001', aligned, 300],
    ['aligned|Live Song (Live)|Band', { alias: 'aligned|isrc:USABC2600001', isrc: 'USABC2600001', songDuration: 200 }, 50]
  ]
  const s = C.libraryStats(entries, { estimate: true })
  assert.deepEqual([s.songs, s.precise, s.alignedSongs, s.words], [1, 1, 1, 2], 'aliases are not songs or alignments of their own')
  const map = new Map(entries.map(([k, v]) => [k, v]))
  const h = harness({
    store: { peek: (k) => map.get(k) || null, entries: () => entries },
    nowPlaying: async () => ({ ok: true, title: 'Live Song (Live)', artist: 'Band', isrc: 'USABC2600001', duration: 200.4, isPlaying: true }),
    notesDir: () => null
  })
  h.s.sync(true)
  await h.advance(FRAME_MS)
  assert.equal(val(h.s.state().now, 'source'), 'Precise: sonata-align 0.1.0, en model, whole song')
  assert.match(val(h.s.state().now, 'score'), /^0\.80 mean confidence/)
  // another recording with the same title (another ISRC): nothing of this one's is shown
  const g = harness({
    store: { peek: (k) => map.get(k) || null, entries: () => entries },
    nowPlaying: async () => ({ ok: true, title: 'Live Song (Live)', artist: 'Band', isrc: 'USXYZ2600009', duration: 240, isPlaying: true }),
    notesDir: () => null
  })
  g.s.sync(true)
  await g.advance(FRAME_MS)
  assert.match(val(g.s.state().now, 'source'), /^Not yet known: no lyrics looked up/)
  h.s.sync(false); g.s.sync(false)
})
