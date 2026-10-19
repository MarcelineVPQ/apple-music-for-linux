const { app, BrowserWindow, ipcMain } = require('electron')
const fs = require('fs'), path = require('path'), { execFileSync } = require('child_process')
const OUT = process.env.LA_OUT, PHASE = process.env.LA_PHASE || 'main'
const logf = fs.openSync(path.join(OUT, 'log.jsonl'), 'w')
const t = () => process.hrtime.bigint().toString()
const log = (o) => fs.writeSync(logf, JSON.stringify(Object.assign({ t: t() }, o)) + '\n')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
function sinks() {
  try {
    const l = JSON.parse(execFileSync('pactl', ['-f', 'json', 'list', 'sink-inputs']).toString())
    const s = JSON.parse(execFileSync('pactl', ['-f', 'json', 'list', 'sinks']).toString())
    const name = (i) => (s.find((x) => x.index === i) || {}).name
    return l.map((x) => ({ index: x.index, sink: name(x.sink), corked: x.corked, props: x.properties }))
  } catch (e) { return String(e) }
}
function snap(label) { log({ k: 'sinks', label, sinks: sinks() }) }
let win
ipcMain.on('ev', (e, ev, ct) => log({ k: 'ev', ev, ct }))
ipcMain.on('ack', (e, c, ct) => log({ k: 'ack', c, ct }))
function cmd(c, v) { log({ k: 'cmd', c, v }); win.webContents.send('cmd', c, v) }
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required')
app.whenReady().then(() => {
  win = new BrowserWindow({ width: 300, height: 200, webPreferences: { nodeIntegration: true, contextIsolation: false } })
  win.loadFile(path.join(__dirname, 'index.html'))
  ipcMain.once('ready', () => run().catch((e) => log({ k: 'err', m: String(e.stack) })).finally(() => { log({ k: 'end' }); app.exit(0) }))
})
const A = 'file://' + path.join(__dirname, 'a.wav'), B = 'file://' + path.join(__dirname, 'b.wav')
async function run() {
  if (PHASE === 'pulsesink') {
    cmd('src', A); await sleep(4000); snap('playing with PULSE_SINK')
    log({ k: 'mark', m: 'unload tmp sink' }); execFileSync('pactl', ['unload-module', process.env.LA_TMPMOD])
    await sleep(500); snap('after unload'); await sleep(4000); snap('after unload +4.5s')
    cmd('pause'); await sleep(1000); cmd('play'); await sleep(3000); snap('after pause/play'); return
  }
  cmd('src', A); await sleep(3000); snap('start')
  // 1/2: pause/resume x12, short pauses 2-3 s
  for (let i = 0; i < 12; i++) { cmd('pause'); await sleep(2000 + (i % 3) * 500); cmd('play'); await sleep(2500) }
  snap('after pauses')
  // 4: seeks x10
  for (let i = 0; i < 10; i++) { cmd('seek', 5 + i * 6.3); await sleep(3000) }
  snap('after seeks')
  // 5: src changes x6
  for (let i = 0; i < 6; i++) { cmd('src', i % 2 ? A : B); await sleep(3500); snap('src ' + i) }
  // 3: long pauses
  for (const ms of [5000, 10000, 20000, 35000]) {
    snap('before pause ' + ms); cmd('pause'); await sleep(ms); snap('end of pause ' + ms); cmd('play'); await sleep(3000); snap('after resume ' + ms)
  }
  // 6: move + restore-target
  const si = sinks().find((x) => x.sink === 'speakers')
  log({ k: 'mark', m: 'move ' + (si && si.index) })
  execFileSync('pactl', ['move-sink-input', String(si.index), 'speakers2'])
  await sleep(3000); snap('after move')
  cmd('pause'); await sleep(35000); snap('long pause after move'); cmd('play'); await sleep(3000); snap('resume after move')
  cmd('src', B); await sleep(3000); snap('src after move')
}
