// Sonata's self-update flow and its rules, kept free of Electron (network, files and clock are
// injected) so node --test drives it, including against a local signed test feed. The feed, its
// Ed25519 signature and the download's size + SHA-512 check live in update-feed.js (unchanged rules);
// this adds the DS5 app's update UX (electron/main/updater.ts there):
//
//   check -> "Sonata X is available" [Update] [Details] -> downloading (progress) -> installing ->
//   ready: "Sonata X is installed. It starts the next time you open Sonata." [Restart now: only while
//   nothing plays] -> next start: "Updated to X · See what's new"
//
// Rules:
// - Nothing installs before the feed's signature checks out, then the download's size and SHA-512
//   (update-feed.js verifyDownload); a mismatch deletes the download and says so.
// - Never a downgrade, except Back to stable: from the Development channel, the newest stable release
//   is offered even when it is older than this build (explicit, the panel confirms it first). The
//   offer stays until it's installed or Development is picked again, so a routine check can't take it back.
// - Never interrupts playback: an update installs beside the running AppImage and starts next time;
//   Restart now is offered only while nothing plays (main.js).
// - Linux AppImage: the new file is written as <name>.part beside the running one, verified, renamed
//   to its versioned name, and the Sonata.AppImage symlink is repointed (main.js integrateAppImage).
//   The running AppImage is never overwritten or deleted (it is FUSE-mounted: SIGBUS); older ones are
//   pruned at the next start, as before.
const path = require('path')
const { isNewerVersion, isDevVersion } = require('./update-feed')

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

const mb = (n) => (Number(n) > 0 ? (n / 1048576).toFixed(n < 10485760 ? 1 : 0) + ' MB' : '')

// The notice for an update state (place: top of the panel), or null. ctx: { playing, lastFailure }
// lastFailure ({ version, detail }): an install of that version failed; while the same version is on
// offer again (a later check), the notice keeps saying why (DS5: a failed install stays said)
function updateNotice(st, ctx) {
  const c = ctx || {}
  switch (st.phase) {
    case 'available': {
      const failed = c.lastFailure && c.lastFailure.version === st.version ? c.lastFailure.detail : ''
      return {
        id: 'update', kind: failed ? 'error' : 'info', task: true, dismissKey: 'update:' + st.version + (failed ? ':failed' : ''),
        detail: failed ? 'The last try didn\'t install: ' + failed + ' Your current version is untouched.' : '',
        text: st.older
          ? 'Stable ' + st.version + ' is ready to install (Back to stable)' + (st.size ? ', ' + mb(st.size) : '') + '.'
          : 'Sonata ' + st.version + ' is available' + (st.size ? ' (' + mb(st.size) + ')' : '') + '.',
        actions: [{ id: 'update-details', label: 'Details' }, { id: 'update-install', label: failed ? 'Try again' : st.older ? 'Install stable' : 'Update', primary: true }]
      }
    }
    case 'downloading': {
      const pct = st.total ? Math.floor(st.got * 100 / st.total) : 0
      return { id: 'update', kind: 'info', closable: false, text: 'Downloading Sonata ' + st.version + ': ' + mb(st.got) + ' of ' + mb(st.total) + ' (' + pct + ' %)', progress: pct }
    }
    case 'installing':
      return { id: 'update', kind: 'info', closable: false, text: 'Checking and installing Sonata ' + st.version + '…' }
    case 'ready':
      return {
        id: 'update', kind: 'info', task: true, dismissKey: 'update:ready:' + st.version,
        text: 'Sonata ' + st.version + ' is installed. It starts the next time you open Sonata' + (c.playing ? ' (Restart now shows when the music is paused).' : ', or restart now.'),
        actions: c.playing ? [] : [{ id: 'update-restart', label: 'Restart now', primary: true }]
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
  const ch = channel === 'dev' ? 'Development' : 'Stable'
  switch (st.phase) {
    case 'checking': return 'Checking for updates…'
    case 'up-to-date': return 'Up to date: ' + current + ' (' + ch + ')'
    case 'available': return (st.older ? 'Stable ' : 'Version ') + st.version + ' is ready to install'
    case 'downloading': return 'Downloading ' + st.version + '…'
    case 'installing': return 'Installing ' + st.version + '…'
    case 'ready': return st.version + ' is installed; it starts next time'
    case 'failed': return (st.during === 'install' ? 'Install failed: ' : 'Check failed: ') + st.detail
    case 'manual': return 'Updates: ' + st.detail
    default: return 'Version ' + current + ' (' + ch + ')'
  }
}

// deps: { version, channel(), fetchUpdate(channel), download(url, dest, onProgress(got, total)),
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
    try {
      const f = await d.fetchUpdate(returningToStable ? 'stable' : d.channel())
      feed = f
      if (!offers(f.version, d.version, returningToStable)) return set({ phase: 'up-to-date', version: d.version, at: d.now() })
      return set({ phase: 'available', version: f.version, size: f.size || 0, notes: f.notes || '', notesUrl: f.notesUrl || '', older: returningToStable && !isNewerVersion(f.version, d.version) })
    } catch (e) {
      // error: SHOWN — the Updates status line always; a notice when the user asked (Check now, Back to stable)
      d.log('update check failed: ' + e.message)
      return set({ phase: 'failed', during: 'check', detail: e.message, shown: !!o.interactive })
    } finally { busy = false }
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

module.exports = { offers, updatedSince, updateNotice, statusLine, createUpdater, mb }
