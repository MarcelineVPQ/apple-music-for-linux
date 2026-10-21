// Long-lived helper children (pactl subscribe, parec, gdbus monitor) end with Sonata, also when Sonata crashes or is
// killed (Marcy 2026-10-20: after a crash, look-ahead's `pactl subscribe` children lived on, one for 13 hours since
// 0.15.80, and kept their AppImage mounts in /tmp). On Linux each is started through util-linux's setpriv with
// --pdeathsig TERM: setpriv execs the command in place (same pid, so kill() still reaches it), and the kernel sends it
// SIGTERM when Sonata's main process ends however it ends. Without setpriv the command starts as before.
// Electron-free (tests: test/child-guard.test.js).
'use strict'
const fs = require('fs')
const { spawn } = require('child_process')

const SETPRIV = ['/usr/bin/setpriv', '/bin/setpriv']

// cache: OK — key=this run's setpriv path; invalidated=never (a run's system doesn't change); bound=one string
let found
function setprivPath(opts = {}) {
  if (!opts.exists && found !== undefined) return found
  const exists = opts.exists || fs.existsSync
  // loop: NOT-WORTH — two paths, once per run (cached)
  const p = (opts.platform || process.platform) === 'linux' ? SETPRIV.find((x) => exists(x)) || null : null
  if (!opts.exists) found = p
  return p
}

/** [cmd, args] that end with this process: setpriv --pdeathsig TERM -- cmd ...args where it exists, else unchanged. */
function withParentDeath(cmd, args, opts) {
  const sp = setprivPath(opts)
  return sp ? [sp, ['--pdeathsig', 'TERM', '--', cmd].concat(args || [])] : [cmd, args || []]
}

/** child_process.spawn with the parent-death guard. */
function guardedSpawn(cmd, args, options) {
  const [c, a] = withParentDeath(cmd, args)
  // lifetime: OK — the caller owns the child (kills it on stop); the kernel ends it with Sonata (--pdeathsig)
  return spawn(c, a, options)
}

module.exports = { withParentDeath, guardedSpawn, setprivPath }
