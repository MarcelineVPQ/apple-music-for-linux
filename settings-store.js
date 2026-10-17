// Sonata's settings (settings.json in the user data folder): the defaults, what each setting may
// hold, loading with recovery from a damaged file, and atomic saves. Electron-free (fs injected), so
// node --test covers it.
//
// Recovery (DS5 rule): a damaged file never resets everything. What still reads is kept (key by key,
// json-salvage.js), a setting whose value is missing, unreadable or of the wrong kind falls back to
// its default, the damaged file is copied aside as settings.json.corrupt-<date>, the repaired file is
// written back, and the caller shows ONE notice saying what happened (recoveryText).
// error: SHOWN — a damaged settings file: the notice; a failed save: thrown to the caller (it logs and keeps running)
const fsMod = require('fs')
const path = require('path')
const { salvageObject, asideName } = require('./json-salvage')

const bounds = (v) => v === null || (v && typeof v === 'object' && ['width', 'height'].every((k) => Number.isInteger(v[k])) &&
  ['x', 'y'].every((k) => v[k] === undefined || Number.isInteger(v[k])))
const bool = (v) => typeof v === 'boolean'
const oneOf = (...xs) => (v) => xs.includes(v)
const strOrNull = (v) => v === null || (typeof v === 'string' && v.length < 64)
const stringList = (max) => (v) => Array.isArray(v) && v.length <= max && v.every((x) => typeof x === 'string' && x.length < 200)
const perPage = (check) => (v) => !!v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).every((k) => /^(settings|about)$/.test(k) && check(v[k]))

// name: [default, valid?, words (for the recovery notice)]
const SCHEMA = {
  notifications: [true, bool, 'Track notifications'],
  closeToTray: [false, bool, 'Close to tray'],
  launchAtLogin: [false, bool, 'Launch at login'],
  startMinimized: [false, bool, 'Start minimized'],
  windowBounds: [null, bounds, 'Window size'],
  lyricsBounds: [null, bounds, 'Lyrics window size'],
  lyricsStage: [false, bool, 'Lyrics shown as the Studio'],
  stageBounds: [null, bounds, 'Studio size'],
  linerBounds: [null, bounds, 'Liner notes window size'],
  miniAlwaysOnTop: [true, bool, 'Keep the mini player on top'],
  lyricsAlwaysOnTop: [true, bool, 'Keep lyrics on top'],
  adaptiveColor: [true, bool, 'Adaptive album color'],
  glass: [true, bool, 'Glass look'],
  lrclibFallback: [true, bool, 'LRCLIB lyrics'],
  lyricsArtSpin: [false, bool, 'Spin album art like a record'],
  lyricsArtSpinSpeed: ['relaxed', oneOf('relaxed', 'true'), 'Record speed'],
  estimatedWordTiming: [true, bool, 'Estimated word timing'],
  lyricsListenRefine: [false, bool, 'Refine timing by listening'],
  lyricsPreciseTiming: [false, bool, 'Precise word timing'],
  alignGamingPause: [true, bool, 'Pause word timing while gaming'],
  sungNotesLog: [false, bool, 'Sung notes (developer log)'],
  sheetNotes: [false, bool, 'Sheet notes in the Studio'],
  updateChannel: ['stable', oneOf('stable', 'dev'), 'Update channel'],
  checkForUpdates: [true, bool, 'Check for updates automatically'],
  autoInstallUpdates: [false, bool, 'Install updates automatically'],
  updatesAsked: [false, bool, 'Asked about automatic updates'],
  railPinned: [false, bool, 'Rail pinned'],
  railLocked: [false, bool, 'Rail locked'],
  panelShown: [false, bool, 'Side panel shown'],
  panelPage: ['settings', oneOf('settings', 'about'), 'Side panel page'],
  panelOpen: [{}, perPage(strOrNull), 'Open sections'],
  panelPins: [{}, perPage(stringList(20)), 'Pinned sections'],
  dismissedNotices: [[], stringList(50), 'Dismissed notices'],
  globalShortcuts: [false, bool, 'Global shortcuts'],
  shortcutKeys: [{}, require('./shortcuts-model').validStored, 'Global shortcut keys'],
  // the user's own setlist.fm API key (liner notes of live albums); none ships with Sonata
  setlistfmKey: ['', (v) => typeof v === 'string' && /^[A-Za-z0-9-]{0,64}$/.test(v), 'setlist.fm API key'],
  lastRunVersion: ['', (v) => typeof v === 'string' && v.length < 40, 'Last version run']
}

function defaults() {
  const out = {}
  // loop: NOT-WORTH — ~28 settings, at start
  for (const k in SCHEMA) out[k] = JSON.parse(JSON.stringify(SCHEMA[k][0]))
  return out
}

// Is `value` acceptable for setting `key` (a known one)? Unknown keys: false.
function validSetting(key, value) {
  return Object.prototype.hasOwnProperty.call(SCHEMA, key) && SCHEMA[key][1](value)
}

// The settings a stored object gives: known keys checked (wrong kind -> default, listed in `reset`),
// unknown keys kept as they are (an older or newer version's).
function fromStored(stored) {
  const out = defaults()
  const reset = []
  // loop: NOT-WORTH — one entry per stored key (~30)
  for (const k of Object.keys(stored || {})) {
    if (!Object.prototype.hasOwnProperty.call(SCHEMA, k)) { out[k] = stored[k]; continue }
    if (SCHEMA[k][1](stored[k])) out[k] = stored[k]
    else reset.push(k)
  }
  return { settings: out, reset }
}

// -> { settings, recovery: null | { kept, reset: [names], unread, aside } }
function loadSettings(file, opts) {
  const o = opts || {}
  const fs = o.fs || fsMod
  let text
  try { text = fs.readFileSync(file, 'utf8') } catch (e) {
    // error: NOT-WORTH — no file yet (first start): the defaults
    return { settings: defaults(), recovery: null }
  }
  let parsed = null
  try { parsed = JSON.parse(text) } catch (e) { parsed = undefined }
  let stored; let unread = 0
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) stored = parsed
  else {
    const s = salvageObject(text)
    stored = s.values
    unread = s.bad + (parsed === undefined ? 0 : 1)
    if (parsed === undefined && !s.bad && !Object.keys(s.values).length) unread = 1
  }
  const { settings, reset } = fromStored(stored)
  if (parsed === stored && !reset.length) return { settings, recovery: null }
  // damaged: keep a copy for the user, write the repaired settings back
  let aside = ''
  try {
    aside = asideName(file, o.now ? o.now() : new Date())
    fs.copyFileSync(file, aside)
  } catch (e) { aside = '' }   // error: SHOWN — the notice says no copy could be kept
  try { saveSettings(file, settings, { fs }) } catch (e) { /* error: NOT-WORTH — the next change saves again */ }
  const kept = Object.keys(stored).filter((k) => Object.prototype.hasOwnProperty.call(SCHEMA, k) && !reset.includes(k)).length
  return { settings, recovery: { kept, reset: reset.map((k) => SCHEMA[k][2]), unread, aside } }
}

// The one notice after a recovery.
function recoveryText(r, what) {
  const name = what || 'settings'
  const parts = ['Sonata\'s ' + name + ' file was damaged, so it was repaired.']
  parts.push(r.kept === 1 ? '1 setting was kept.' : r.kept + ' settings were kept.')
  if (r.reset.length) parts.push('Back to default: ' + r.reset.join(', ') + '.')
  if (r.unread) parts.push((r.unread === 1 ? 'One entry' : r.unread + ' entries') + ' could not be read; anything missing is back to its default.')
  parts.push(r.aside ? 'A copy of the damaged file: ' + r.aside : 'No copy of the damaged file could be kept.')
  return parts.join(' ')
}

// Atomic save (temp file + rename): a crash mid-write can't leave a half-written settings file.
function saveSettings(file, settings, opts) {
  const fs = (opts && opts.fs) || fsMod
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = file + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(settings, null, 2) + '\n')
  fs.renameSync(tmp, file)
}

module.exports = { SCHEMA, defaults, validSetting, fromStored, loadSettings, saveSettings, recoveryText }
