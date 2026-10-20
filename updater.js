// Sonata's self-update flow and its rules, kept free of Electron (network, files and clock are
// injected) so node --test drives it, including against a local signed test feed. The feed, its
// Ed25519 signature and the download's size + SHA-512 check live in update-feed.js (unchanged rules);
// this adds the DS5 app's update UX (electron/main/updater.ts there):
//
//   check -> "Sonata X is available" [Update] [Details] -> downloading (progress) -> installing ->
//   ready: "Sonata X is installed. It starts the next time you open Sonata." [Restart now: greyed while
//   music plays] -> next start: "Updated to X · See what's new"
//
// Rules:
// - Nothing installs before the feed's signature checks out, then the download's size and SHA-512
//   (update-feed.js verifyDownload); a mismatch deletes the download and says so.
// - Never a downgrade, except Back to stable: from the Development channel, the newest stable release
//   is offered even when it is older than this build (explicit, the panel confirms it first). The
//   offer stays until it's installed or Development is picked again, so a routine check can't take it back.
// - Never interrupts playback: an update installs beside the running AppImage and starts next time;
//   Restart now works only while nothing plays (greyed, with why, while music plays; main.js refuses it too).
// - Linux AppImage: the new file is written as <name>.part beside the running one, verified, renamed
//   to its versioned name, and the Sonata.AppImage symlink is repointed (main.js integrateAppImage).
//   The running AppImage is never overwritten or deleted (it is FUSE-mounted: SIGBUS); older ones are
//   pruned at the next start, as before.
const path = require('path')
const { isNewerVersion, isDevVersion } = require('./update-feed')
const V = require('./version-display')   // every version and channel people read (one place)

// Is `remote` offered to a copy running `current`? Newer only; Back to stable: anything but the same.
function offers(remote, current, returningToStable) {
  if (!remote || !current) return false
  if (returningToStable) return remote !== current && !isDevVersion(remote)
  return isNewerVersion(remote, current)
}

// "Updated to X": the version changed since the last run (not on a first run).
function updatedSince(lastRun, current) {
  return !!lastRun && lastRun !== current ? current : null
}

// the automatic check: at start and every CHECK_EVERY_HOURS (main's timer and Settings' words both read it)
const CHECK_EVERY_HOURS = 2
const CHECK_EVERY_MS = CHECK_EVERY_HOURS * 3600 * 1000

const mb = (n) => (Number(n) > 0 ? (n / 1048576).toFixed(n < 10485760 ? 1 : 0) + ' MB' : '')

// The notice for an update state (place: top of the panel), or null. ctx: { playing, lastFailure, helperBusy }
// lastFailure ({ version, detail }): an install of that version failed; while the same version is on
// offer again (a later check), the notice keeps saying why (DS5: a failed install stays said)
function updateNotice(st, ctx) {
  const c = ctx || {}
  const shown = V.short(st.version)
  switch (st.phase) {
    case 'available': {
      const failed = c.lastFailure && c.lastFailure.version === st.version ? c.lastFailure.detail : ''
      return {
        id: 'update', kind: failed ? 'error' : 'info', task: true, dismissKey: 'update:' + st.version + (failed ? ':failed' : ''),   // hardcode: OK — the notice's key (raw version), never shown
        detail: failed ? 'The last try didn\'t install: ' + failed + ' Your current version is untouched.' : '',
        text: st.older
          ? V.channelName('stable') + ' ' + shown + ' is ready to install (Back to stable)' + (st.size ? ', ' + mb(st.size) : '') + '.'
          : V.full(st.version) + ' is available' + (st.size ? ' (' + mb(st.size) + ')' : '') + '.',
        actions: [{ id: 'update-details', label: 'Details' }, { id: 'update-install', label: failed ? 'Try again' : st.older ? 'Install stable' : 'Update', primary: true }]
      }
    }
    case 'downloading': {
      const pct = st.total ? Math.floor(st.got * 100 / st.total) : 0
      return { id: 'update', kind: 'info', closable: false, text: 'Downloading ' + V.full(st.version) + ': ' + mb(st.got) + ' of ' + mb(st.total) + ' (' + pct + ' %)', progress: pct }
    }
    case 'installing':
      return { id: 'update', kind: 'info', closable: false, text: 'Checking and installing ' + V.full(st.version) + '…' }
    case 'ready':
      return {
        id: 'update', kind: 'info', task: true, dismissKey: 'update:ready:' + st.version,   // hardcode: OK — the notice's key (raw version), never shown
        // a Precise timing helper job running: no restart until it has finished (helperBusy). While music plays or the
        // helper works, Restart now is shown greyed with why (Marcy 2026-10-20: "gray it out with a little 'pause audio
        // to restart'" instead of hiding it)
        text: V.full(st.version) + ' is installed. It starts the next time you open ' + V.NAME + (c.helperBusy ? '. To restart now, wait for the Precise timing helper to finish.' : c.playing ? '. Pause the music to restart now.' : ', or restart now.'),
        actions: [{ id: 'update-restart', label: 'Restart now', primary: true, disabled: !!(c.playing || c.helperBusy), tip: c.helperBusy ? 'Waits for the Precise timing helper to finish' : c.playing ? 'Pause the music to restart' : '' }]
      }
    case 'failed':
      return st.during === 'install' || st.shown
        ? { id: 'update', kind: 'error', text: (st.during === 'install' ? 'The update didn\'t install: ' : 'Couldn\'t check for updates: ') + st.detail + (st.during === 'install' ? ' Your current version is untouched.' : '') }
        : null
    default:
      return null
  }
}

// The Updates section's status line
function statusLine(st, current, channel) {
  const now = V.short(current)
  const shown = V.short(st && st.version)
  const ch = V.channelName(channel)
  switch (st.phase) {
    case 'checking': return 'Checking for updates…'
    case 'up-to-date': return 'Up to date: ' + now + ' (' + ch + ')'
    case 'available': return (st.older ? V.channelName('stable') + ' ' : 'Version ') + shown + ' is ready to install'
    case 'downloading': return 'Downloading ' + shown + '…'
    case 'installing': return 'Installing ' + shown + '…'
    case 'ready': return shown + ' is installed; it starts next time'
    case 'failed': return (st.during === 'install' ? 'Install failed: ' : 'Check failed: ') + st.detail
    case 'manual': return 'Updates: ' + st.detail
    default: return 'Version ' + now + ' (' + ch + ')'
  }
}

// The toast after Check for updates found nothing newer: "Sonata 0.15.45 Dev is up to date (Development)."; with the
// helper checked too (main.js helperUpToDate): "Sonata 0.15.81 Dev and helper 0.2.10 Dev are up to date (Development)."
function upToDateText(current, channel, helper) {
  const ch = ' (' + V.channelName(channel) + ').'
  if (!helper || !helper.version) return V.full(current) + ' is up to date' + ch
  const h = 'helper ' + V.short(helper.version)
  if (helper.state === 'available') return V.full(current) + ' is up to date' + ch + ' Helper ' + V.short(helper.available) + ' is available: Settings → Precise timing.'
  if (helper.state === 'failed') return V.full(current) + ' is up to date' + ch + ' The helper couldn\'t be checked: Settings → Precise timing says why.'
  return V.full(current) + ' and ' + h + ' are up to date' + ch
}
// The notice once after an update: "Updated to Sonata 0.15.45 Dev."
const updatedText = (version) => 'Updated to ' + V.full(version) + '.'
// The desktop notification while Sonata is in the tray (available or ready), or null
function updateNotification(st) {
  if (!st || (st.phase !== 'available' && st.phase !== 'ready')) return null
  return st.phase === 'ready'
    ? { title: V.full(st.version) + ' is installed', body: 'It starts the next time you open ' + V.NAME + '.' }
    : { title: V.full(st.version) + ' is available', body: 'Open Settings → Updates to install it.' }
}

// deps: { version, channel(), fetchUpdate(channel, { fresh }), download(url, dest, onProgress(got, total)),
//   verify(file, feed), fs, installedPath(), blocker() (why this copy can't update itself, or null),
//   onInstalled(newPath), emit(state), now(), log }
function createUpdater(deps) {
  const d = deps
  let state = { phase: 'idle' }
  let feed = null            // the feed the offer on screen came from
  let busy = false
  let returningToStable = false
  let lastProgress = 0
  const set = (s) => { state = s; d.emit(state); return state }

  async function check(opts) {
    const o = opts || {}
    if (d.channel() === 'dev') returningToStable = false
    // once installed, only a restart moves on (a new check would offer the same update again)
    if (busy || state.phase === 'ready' || state.phase === 'downloading' || state.phase === 'installing') return state
    const blocker = d.blocker()
    if (blocker) return set({ phase: 'manual', detail: blocker })
    busy = true
    set({ phase: 'checking' })
    let next
    try {
      // a check the user asked for reads the feed fresh (update-feed.js freshUrl), an automatic one may be cached
      const f = await d.fetchUpdate(returningToStable ? 'stable' : d.channel(), { fresh: !!o.interactive })
      feed = f
      next = !offers(f.version, d.version, returningToStable)
        ? { phase: 'up-to-date', version: d.version, at: d.now() }
        : { phase: 'available', version: f.version, size: f.size || 0, notes: f.notes || '', notesUrl: f.notesUrl || '', older: returningToStable && !isNewerVersion(f.version, d.version) }
    } catch (e) {
      // error: SHOWN — the Updates status line always; a notice when the user asked (Check for updates, Back to stable)
      d.log('update check failed: ' + e.message)
      next = { phase: 'failed', during: 'check', detail: e.message, shown: !!o.interactive }
    } finally { busy = false }
    // the outcome is told only once the check is over, so whoever hears "available" can install() right
    // away (main's Install updates automatically did, and install() refused while the check was still busy)
    return set(next)
  }

  async function install() {
    if (busy || state.phase !== 'available' || !feed) return state
    busy = true
    const f = feed
    try {
      const dir = path.dirname(d.installedPath())
      const target = path.join(dir, f.file)
      // never write over the AppImage this process runs from (FUSE-mounted: SIGBUS)
      if (path.resolve(target) === path.resolve(d.installedPath())) throw new Error('the update has the running file\'s name; refusing to overwrite it')
      const part = target + '.part'
      lastProgress = 0
      set({ phase: 'downloading', version: f.version, got: 0, total: f.size || 0 })
      await d.download(f.url, part, (got, total) => {
        const t = d.now()
        // at most 4 progress pushes a second
        if (t - lastProgress < 250 && got < total) return
        lastProgress = t
        set({ phase: 'downloading', version: f.version, got, total: total || f.size || 0 })
      })
      set({ phase: 'installing', version: f.version })
      try {
        await d.verify(part, f)   // size + SHA-512 from the signed feed
      } catch (e) {
        // error: PASSES-ON — the unverified file is deleted; the catch below shows the reason
        d.fs.rmSync(part, { force: true })
        throw e
      }
      d.fs.chmodSync(part, 0o755)
      d.fs.renameSync(part, target)
      d.onInstalled(target)
      returningToStable = false
      return set({ phase: 'ready', version: f.version })
    } catch (e) {
      // error: SHOWN — the update notice says it didn't install and why; the current version is untouched
      d.log('update install failed: ' + e.message)
      return set({ phase: 'failed', during: 'install', detail: e.message, version: f.version })
    } finally { busy = false }
  }

  // Back to stable (the panel confirmed it): the stable release, even when older, then installed
  async function backToStable() {
    if (state.phase === 'ready') return state
    returningToStable = true
    const s = await check({ interactive: true })
    if (s.phase === 'available') return install()
    return s
  }

  return {
    check, install, backToStable,
    state: () => state,
    feed: () => feed,
    returning: () => returningToStable,
    // a channel switch: forget an offer from the other channel
    reset() { if (!busy && state.phase !== 'ready') { feed = null; set({ phase: 'idle' }) } }
  }
}

module.exports = { CHECK_EVERY_HOURS, CHECK_EVERY_MS, offers, updatedSince, updateNotice, statusLine, upToDateText, updatedText, updateNotification, createUpdater, mb }
