// Settings → Precise timing's Install / Update / Repair / Remove, the process part (no Electron): runs the
// one installer, align/install.sh, with --progress and reads its lines into a job (helper-install-model.js).
//   1. --licence-only: the engine is downloaded and checked (size, SHA-256, signature) and its licence
//      written beside the kept download; Settings shows that text (Accept / Cancel). A licence already
//      accepted (the same SHA-256, and the same licence version when the engine feed names one) is not asked
//      again. When the feed names the licence's SHA-256, the downloaded text must be that one.
//   2. --licence-sha SHA --prune: the install itself, accepting exactly the text that was shown. It
//      builds the new venv aside and switches only after the engine answers a ping (install.sh).
//   3. the models, when the install has none yet (main's models(): the helper's own `prepare`).
// Cancel stops the installer's whole process group (pip/uv with it); install.sh's traps leave the
// previous install as it was. Arguments go to the script as an argv array (no shell string), and the
// only values from outside are a version-checked pin file Sonata wrote and the SHA-256 it read.
//
// lifetime: OK — at most one installer child; it ends by itself, on cancel (SIGTERM to its group, then
// SIGKILL after 5 s) or on app quit (stop()). Its stdout/stderr listeners die with it.
const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawn } = require('child_process')
const M = require('./helper-install-model')

const LICENCE_MAX = 64 * 1024

/** The installer's environment: ours minus what an AppImage/Electron sets that would break pip, Python or the venv. */
function installerEnv(env, home) {
  const out = Object.assign({}, env)
  // loop: NOT-WORTH — a few names, once per run
  for (const k of ['LD_LIBRARY_PATH', 'LD_PRELOAD', 'PYTHONHOME', 'PYTHONPATH', 'PYTHONSTARTUP', 'ELECTRON_RUN_AS_NODE', 'APPDIR', 'APPIMAGE', 'ARGV0', 'OWD']) delete out[k]
  if (home) out.SONATA_ALIGN_HOME = home
  out.PYTHONUNBUFFERED = '1'
  out.LC_ALL = 'C.UTF-8'
  return out
}

/** align/install.sh beside the app: inside an AppImage it is in app.asar.unpacked (package.json asarUnpack). */
function scriptPath(appDir) {
  const dir = String(appDir || __dirname).replace(/([\\/])app\.asar(?=$|[\\/])/, '$1app.asar.unpacked')
  return path.join(dir, 'align', 'install.sh')
}

/**
 * createHelperInstaller({ script, home(), env, log, onChange(state), acceptedLicence() -> { sha, version },
 *   onAccepted(sha, engineVersion, licenceVersion), models(job, report(ev)) -> Promise, before(kind) }, deps?)
 * -> { state(), start(kind, opts), accept(), decline(), cancel(), remove(deleteModels), dismiss(), stop(), busy }
 * deps (tests): { spawn, readFile, writePin, rm, setTimeout }
 */
function createHelperInstaller(opts, deps = {}) {
  const doSpawn = deps.spawn || spawn
  const readFile = deps.readFile || ((f) => { const b = fs.readFileSync(f); return b.subarray(0, LICENCE_MAX).toString('utf8') })
  const rm = deps.rm || ((p) => fs.rmSync(p, { recursive: true, force: true }))
  const setT = deps.setTimeout || setTimeout
  const writePin = deps.writePin || ((text) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sonata-pin-'))
    const f = path.join(dir, 'engine.json')
    fs.writeFileSync(f, text, { mode: 0o600 })
    return { file: f, done: () => rm(dir) }
  })
  const log = opts.log || ((m) => console.log('helper install:', m))
  let st = { phase: 'idle', kind: '', job: null, licence: null }
  let child = null
  let cancelling = false
  let run = null      // { kind, args, pin, hasModels }

  const changed = () => { if (opts.onChange) opts.onChange(state()) }
  function state() { return { phase: st.phase, kind: st.kind, job: st.job, licence: st.licence } }
  function set(patch) { st = Object.assign({}, st, patch); changed() }

  // runs install.sh with args; each line -> onEvent / the job's tail; -> Promise<{ code, signal }>
  // lifetime: OK — the one installer child (`child` while it runs); its listeners go with it at 'close'
  function exec(args, onEvent) {
    return new Promise((resolve) => {
      let c
      // error: SHOWN — a spawn that throws (no /bin/sh): the job fails with code spawn
      try {
        c = doSpawn('/bin/sh', [opts.script, '--progress'].concat(args), { detached: true, stdio: ['ignore', 'pipe', 'pipe'], env: installerEnv(opts.env || process.env, opts.home && opts.home()) })
      } catch (e) { onEvent({ ev: 'fail', code: 'spawn', message: e.message }); resolve({ code: 1 }); return }
      child = c
      const feed = (stream) => {
        let rest = ''
        stream.setEncoding('utf8')
        // loop: HOT-PATH-OK — the lines of one output chunk (a few; pip's raw progress ~4 a second) · ends with the child
        stream.on('data', (chunk) => {
          const parts = (rest + chunk).split(/\r?\n|\r/)
          rest = parts.pop()
          for (const line of parts) {
            if (!line.trim()) continue
            const ev = M.parseLine(line)
            // the job's tail keeps what a person would read (not the markers or pip's byte counts)
            if (!line.startsWith('@@sonata ') && !/^Progress \d/.test(line)) onEvent({ ev: 'text', line })
            if (ev) onEvent(ev)
          }
        })
      }
      feed(c.stdout)
      feed(c.stderr)
      // error: SHOWN — the child could not start: the job fails with code spawn
      // lifetime: OK — 'error' and 'close' die with the child
      c.on('error', (e) => { onEvent({ ev: 'fail', code: 'spawn', message: e.message }) })
      c.on('close', (code, signal) => { if (child === c) child = null; resolve({ code, signal }) })
    })
  }

  function jobEvent(ev) {
    if (!st.job) return
    const before = st.job
    const after = M.reduce(before, ev)
    // the bars move at most a few times a second: only real changes reach the panel
    if (after !== before) set({ job: after })
  }

  /**
   * Starts an install, update or repair. o: { pinText (the feed's engine, engine-feed.js pinText), from
   * (a test feed's folder), rebuild, backend (cuda | rocm | xpu | openvino | cpu), hasModels, version, licence: the feed's
   * { version, sha256 } }
   */
  async function start(kind, o) {
    if (st.phase === 'licence-fetch' || st.phase === 'running' || st.phase === 'licence') return false
    const k = ['install', 'update', 'repair'].includes(kind) ? kind : 'install'
    const opt = o || {}
    const args = []
    let pin = null
    if (opt.pinText) { pin = writePin(opt.pinText); args.push('--pin', pin.file) }
    if (opt.from) args.push('--from', opt.from)
    if (opt.backend) args.push('--backend', opt.backend)   // cuda | rocm | xpu | openvino | cpu (checked by main and by install.sh)
    if (opt.rebuild || k === 'repair') args.push('--rebuild')
    run = { kind: k, args, pin, hasModels: !!opt.hasModels, licence: opt.licence || null }
    cancelling = false
    if (opts.before) opts.before(k)
    set({ phase: 'licence-fetch', kind: k, job: M.newJob(k, { hasModels: run.hasModels, version: opt.version }), licence: null })
    let lic = null
    // lifetime: OK — the licence fetch: one installer run, ends by itself or on cancel
    const res = await exec(args.concat(['--licence-only']), (ev) => { if (ev.ev === 'licence') lic = ev; else jobEvent(ev) })
    if (cancelling) return finish({ ev: 'cancelled' })
    if (res.code !== 0 || !lic || !lic.sha || !lic.path) {
      if (st.job && st.job.phase !== 'failed') jobEvent({ ev: 'fail', code: 'download', message: 'the licence could not be read' })
      return finish(null)
    }
    let text = ''
    // error: SHOWN — the licence file can't be read: the job fails (nothing is installed without it)
    try { text = readFile(lic.path) } catch (e) { jobEvent({ ev: 'fail', code: 'verify', message: 'the licence could not be read: ' + e.message }); return finish(null) }
    if (!text.trim()) { jobEvent({ ev: 'fail', code: 'verify', message: 'the helper has an empty licence' }); return finish(null) }
    const want = run.licence || {}
    if (want.sha256 && want.sha256 !== lic.sha) { jobEvent({ ev: 'fail', code: 'verify', message: 'the helper\'s licence is not the one its feed names' }); return finish(null) }
    const licence = { version: lic.version, sha: lic.sha, text, licenceVersion: want.version || '' }
    const accepted = (opts.acceptedLicence && opts.acceptedLicence()) || {}
    if (accepted.sha && accepted.sha === lic.sha && (!want.version || !accepted.version || accepted.version === want.version)) { st.licence = licence; return install() }
    set({ phase: 'licence', licence })
    return true
  }

  async function install() {
    const lic = st.licence
    if (!run || !lic) return false
    set({ phase: 'running', job: Object.assign(M.newJob(run.kind, { hasModels: run.hasModels, version: lic.version }), { step: 'download' }) })
    // lifetime: OK — the install: one installer run, ends by itself or on cancel (its group is stopped)
    const res = await exec(run.args.concat(['--licence-sha', lic.sha, '--prune']), jobEvent)
    if (cancelling) return finish({ ev: 'cancelled' })
    if (res.code !== 0 || !st.job || st.job.phase === 'failed') {
      if (st.job && st.job.phase !== 'failed') jobEvent({ ev: 'fail', code: res.signal ? 'killed' : 'unknown', message: (st.job.tail || []).slice(-1)[0] || 'the installer stopped (' + (res.signal || 'exit ' + res.code) + ')' })
      return finish(null)
    }
    // installed and switched: the models, when there are none yet (cancel here keeps the install)
    if (opts.models && !run.hasModels) {
      const job = Object.assign({}, st.job, { phase: 'running' })
      set({ job })
      jobEvent({ ev: 'models', p: 0, detail: '' })
      // error: SHOWN — a models download that fails: the job ends failed with code models (installed, models on first use)
      try { await opts.models(st.job, (ev) => jobEvent(Object.assign({ ev: 'models' }, ev))) } catch (e) {
        if (!cancelling) { jobEvent({ ev: 'fail', code: 'models', message: e.message }); return finish(null) }
      }
    }
    return finish({ ev: 'done', version: lic.version })
  }

  function finish(ev) {
    if (ev) jobEvent(ev)
    if (run && run.pin) { run.pin.done(); run.pin = null }
    const ok = st.job && st.job.phase === 'done'
    if (st.job && st.job.phase === 'running') jobEvent({ ev: 'cancelled' })
    set({ phase: st.job ? st.job.phase : 'idle' })
    log(st.kind + ' ' + (st.job ? st.job.phase + (st.job.code ? ' (' + st.job.code + ': ' + st.job.message + ')' : '') : ''))
    if (opts.after) opts.after(st.kind, st.job)
    return ok
  }

  function accept() {
    if (st.phase !== 'licence' || !st.licence) return false
    if (opts.onAccepted) opts.onAccepted(st.licence.sha, st.licence.version, st.licence.licenceVersion)
    // error: NOT-WORTH — install() turns every failure into the job's failed phase (shown); exec never rejects
    install()
    return true
  }

  function decline() {
    if (st.phase !== 'licence') return false
    if (run && run.pin) { run.pin.done(); run.pin = null }
    // error: NOT-WORTH — the kept download (1.5 MB) is replaced by the next licence fetch anyway
    try { if (opts.home) rm(path.join(opts.home(), '.download')) } catch (e) {}
    set({ phase: 'idle', kind: '', job: null, licence: null })
    return true
  }

  function killGroup(sig) {
    const c = child
    if (!c || !c.pid) return
    // error: NOT-WORTH — the group is gone already (it just exited): nothing to stop
    try { process.kill(-c.pid, sig) } catch (e) { try { c.kill(sig) } catch (e2) {} }
  }

  function cancel() {
    if (st.phase === 'licence') return decline()
    if (st.phase !== 'licence-fetch' && st.phase !== 'running') return false
    if (st.kind === 'remove') return false   // a removal is quick and never half-done on purpose
    cancelling = true
    if (child) {
      killGroup('SIGTERM')
      // lifetime: OK — one-shot: a group still there after 5 s is killed hard
      const c = child
      const t = setT(() => { if (child === c) killGroup('SIGKILL') }, 5000)
      if (t && t.unref) t.unref()
    } else if (opts.cancelModels) opts.cancelModels()
    return true
  }

  async function remove(deleteModels) {
    if (st.phase === 'licence-fetch' || st.phase === 'running') return false
    run = { kind: 'remove', args: [], pin: null, hasModels: true }
    cancelling = false
    if (opts.before) opts.before('remove')
    // loop: NOT-WORTH — 7 steps · once per Remove press (not per paint)
    set({ phase: 'running', kind: 'remove', job: Object.assign(M.newJob('remove', { hasModels: true }), { skipped: M.STEPS.map((s) => s.id).filter((id) => id !== 'download') }), licence: null })
    // lifetime: OK — the removal: one quick installer run
    const res = await exec(['--remove'].concat(deleteModels ? ['--delete-models'] : []), jobEvent)
    if (res.code !== 0 && st.job.phase !== 'failed') jobEvent({ ev: 'fail', code: 'unknown', message: (st.job.tail || []).slice(-1)[0] || 'the removal stopped' })
    else if (res.code === 0) jobEvent({ ev: 'done' })
    return finish(null)
  }

  function dismiss() {
    if (st.phase === 'running' || st.phase === 'licence-fetch' || st.phase === 'licence') return false
    set({ phase: 'idle', kind: '', job: null, licence: null })
    return true
  }

  return {
    state, start, accept, decline, cancel, remove, dismiss,
    /** app quit: an install in progress is cancelled (install.sh leaves the old install as it was) */
    stop() { if (child) { cancelling = true; killGroup('SIGTERM') } },
    get busy() { return st.phase === 'licence-fetch' || st.phase === 'running' }
  }
}

module.exports = { createHelperInstaller, installerEnv, scriptPath, LICENCE_MAX }
