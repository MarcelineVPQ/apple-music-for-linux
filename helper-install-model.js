// Settings → Precise timing's helper install, the pure part (no DOM, no Electron, no processes): the
// steps of an install, reading align/install.sh's output (its "@@sonata {json}" lines and the pip / uv
// lines of the engine's setup-venv.sh) into progress, the plain failure messages, and what the state row
// and buttons say. Used by helper-installer.js (main) and panel-helper.js (panel.html, as
// SonataHelperInstallModel). Tested in test/helper-install.test.js.
;(function (root) {
  'use strict'
  // every version a person reads goes through version-display.js (tools/hardcodes.js)
  const V = root.SonataVersionDisplay || (typeof require === 'function' ? require('./version-display') : null)

  // the steps, in order; an update whose Python packages are unchanged skips venv, torch and packages,
  // and models is there only when the install has no models yet
  const STEPS = [
    { id: 'download', label: 'Downloading the helper' },
    { id: 'verify', label: 'Checking the download' },
    { id: 'venv', label: 'Setting up Python' },
    { id: 'torch', label: 'Installing PyTorch' },
    { id: 'packages', label: 'Installing the other packages' },
    { id: 'check', label: 'Testing the helper' },
    { id: 'models', label: 'Downloading the models' }
  ]
  const VENV_STEPS = ['venv', 'torch', 'packages']
  // each step's share of the one bar, by how long it takes (the Python packages are nearly all of it)
  const WEIGHT = { download: 3, verify: 1, venv: 1, torch: 60, packages: 20, check: 5, models: 10 }
  // the venv on disk when done (docs/LEVEL2-ALIGN.md "Install footprint"): the size bar's end
  // per build (the engine's setup-venv.sh --backend), measured 2026-10-18 with Python 3.14 and torch 2.11
  const EXPECTED_VENV = { cuda: 7.3e9, rocm: 15e9, xpu: 8.1e9, openvino: 1.3e9, cpu: 1.3e9 }
  // what pip downloads for it (the wheels: torch cu128 and NVIDIA's CUDA libraries, measured 2026-10-18)
  const EXPECTED_DOWNLOAD = { cuda: 3.9e9, rocm: 6.5e9, xpu: 2.7e9, openvino: 0.35e9, cpu: 0.3e9 }
  const BACKENDS = ['cuda', 'rocm', 'xpu', 'openvino', 'cpu']
  const SHORT = { cuda: 'CUDA', rocm: 'ROCm', xpu: 'XPU', openvino: 'OpenVINO', cpu: 'processor' }
  // Settings → Precise timing → Build for (the ROCm, XPU and OpenVINO builds are new: untested on real cards here;
  // OpenVINO (engine 0.2.6): Intel integrated graphics, or the processor through OpenVINO)
  const BUILD_FOR = [['auto', 'Auto (recommended)'], ['cuda', 'NVIDIA (CUDA)'], ['rocm', 'AMD (ROCm, new)'], ['xpu', 'Intel Arc (XPU, new)'], ['openvino', 'Intel (OpenVINO, new)'], ['cpu', 'Processor only (slow)']]
  const BUILD_NAME = { cuda: 'NVIDIA (CUDA)', rocm: 'AMD (ROCm, new)', xpu: 'Intel Arc (XPU, new)', openvino: 'Intel (OpenVINO, new)', cpu: 'the processor only' }
  const variantOf = (v) => (BACKENDS.includes(v) ? v : v === 'gpu' ? 'cuda' : 'cuda')   // install.sh up to 0.15.45 said gpu
  const TAIL = 12   // the last output lines kept for a failure

  const MB = 1e6
  function bytesText(n) {
    const b = Math.max(0, Number(n) || 0)
    if (b >= 1e9) return (b / 1e9).toFixed(b >= 1e10 ? 0 : 1) + ' GB'
    if (b >= MB) return Math.round(b / MB) + ' MB'
    if (b >= 1e3) return Math.round(b / 1e3) + ' kB'
    return b + ' bytes'
  }
  // "846.4MiB" / "846.4 MB" -> bytes
  function sizeOf(num, unit) {
    const u = String(unit || '').toUpperCase().replace('IB', 'B')
    const k = { B: 1, KB: 1e3, MB: 1e6, GB: 1e9 }[u] || 1
    return Math.round(parseFloat(num) * k * (/I/i.test(unit) ? Math.pow(1.024, { B: 0, KB: 1, MB: 2, GB: 3 }[u] || 0) : 1))
  }

  /** One output line of install.sh -> an event, or null for a line that says nothing we track. */
  function parseLine(raw) {
    const line = String(raw || '').replace(/\r/g, '')
    if (line.startsWith('@@sonata ')) {
      // error: NOT-WORTH — a line that isn't JSON after the marker is ignored (kept in the tail)
      try { const e = JSON.parse(line.slice(9)); return e && typeof e.ev === 'string' ? e : null } catch (err) { return null }
    }
    let m
    if ((m = /^Progress (\d+) of (\d+)$/.exec(line))) return { ev: 'pkg-bytes', got: +m[1], total: +m[2] }
    // pip: "Downloading torch-2.11.0+cu128-cp314-cp314-manylinux_2_28_x86_64.whl (846.4 MB)"
    if ((m = /^\s*Downloading ([A-Za-z0-9_.]+?)-\d[^ ]*\.whl \(([\d.]+) ([kKMG]B)\)$/.exec(line))) return { ev: 'pkg', name: m[1].toLowerCase().replace(/_/g, '-'), bytes: sizeOf(m[2], m[3]) }
    // uv: "Downloading torch (846.4MiB)" ... " Downloaded torch"
    if ((m = /^Downloading ([A-Za-z0-9_.-]+) \(([\d.]+)\s?([KMG]i?B)\)$/.exec(line))) return { ev: 'pkg', name: m[1].toLowerCase(), bytes: sizeOf(m[2], m[3]) }
    if ((m = /^ Downloaded ([A-Za-z0-9_.-]+)$/.exec(line))) return { ev: 'pkg-done', name: m[1].toLowerCase() }
    if (/^ \+ torch==|^Successfully installed .*\btorch-\d/.test(line)) return { ev: 'torch-done' }
    if (/^torch \d\S* (cuda|xpu|cpu)$/.test(line)) return { ev: 'packages-done' }
    if (/^Collecting torch==|^Using Python \d|^Looking in indexes: .*pytorch/.test(line)) return { ev: 'torch-start' }
    return null
  }

  /**
   * A new install job. kind: 'install' | 'update' | 'repair'; hasModels: the install already has the
   * models (no models step).
   */
  function newJob(kind, opts) {
    const o = opts || {}
    return {
      phase: 'running', kind: kind || 'install', version: o.version || '', step: 'download', skipped: o.hasModels ? ['models'] : [],
      got: 0, total: 0, size: 0, variant: 'cuda', pkg: null, pkgGot: 0, pkgTotal: 0, pkgsDone: 0, dlDone: 0, modelP: null, modelDetail: '',
      code: '', message: '', tail: []
    }
  }

  /** The job after one event (parseLine's, or main's own: models, exit). Never mutates `job`. */
  function reduce(job, ev) {
    if (!job || !ev) return job
    const j = Object.assign({}, job)
    // loop: HOT-PATH-OK — 7 steps · per installer output event while an install runs (a few per second)
    const go = (step) => { if (STEPS.findIndex((s) => s.id === step) >= STEPS.findIndex((s) => s.id === j.step)) j.step = step }
    switch (ev.ev) {
      case 'step':
        go(ev.step)
        if (ev.step === 'venv' && ev.variant) j.variant = variantOf(ev.variant)
        break
      case 'skip':
        // loop: NOT-WORTH — 3 venv steps · once per install (the skip event)
        if (ev.step === 'venv') j.skipped = j.skipped.concat(VENV_STEPS.filter((s) => !j.skipped.includes(s)))
        break
      case 'bytes':
        j.got = Math.max(0, +ev.got || 0); j.total = Math.max(0, +ev.total || 0)
        break
      case 'size': j.size = Math.max(0, +ev.bytes || 0); break
      case 'torch-start': if (j.step === 'venv') go('torch'); break
      case 'pkg':
        if (j.step === 'venv' && ev.name !== 'pip') go('torch')
        if (j.pkg && VENV_STEPS.includes(j.step)) j.dlDone += j.pkgTotal   // pip: the one before is done
        j.pkg = { name: String(ev.name || ''), bytes: +ev.bytes || 0 }
        j.pkgGot = 0; j.pkgTotal = +ev.bytes || 0
        break
      case 'pkg-bytes': j.pkgGot = +ev.got || 0; j.pkgTotal = +ev.total || j.pkgTotal; break
      case 'pkg-done': j.pkgsDone++; j.dlDone += j.pkgTotal; j.pkgGot = j.pkgTotal; j.pkg = null; break
      case 'torch-done': if (j.step === 'torch' || j.step === 'venv') { go('packages'); j.pkg = null } break
      case 'packages-done': go('check'); j.pkg = null; break
      case 'models': go('models'); j.modelP = typeof ev.p === 'number' ? Math.max(0, Math.min(1, ev.p)) : null; j.modelDetail = String(ev.detail || ''); break
      case 'licence': j.version = ev.version || j.version; break
      case 'done': j.phase = 'done'; if (ev.version) j.version = ev.version; break
      case 'cancelled': j.phase = 'cancelled'; break
      case 'fail': j.phase = 'failed'; j.code = String(ev.code || 'unknown'); j.message = String(ev.message || ''); break
      case 'text': j.tail = j.tail.concat([String(ev.line || '').slice(0, 300)]).slice(-TAIL); break
    }
    return j
  }

  /** What the progress block shows: { stepNo, stepCount, label, fraction (0..1, or null: busy), detail } */
  function progressView(job) {
    // loop: HOT-PATH-OK — 7 steps · per panel progress push while an install runs
    const steps = STEPS.filter((s) => !job.skipped.includes(s.id))
    // loop: HOT-PATH-OK — ≤ 7 steps · per panel progress push while an install runs
    const i = Math.max(0, steps.findIndex((s) => s.id === job.step))
    const cur = steps[i] || STEPS[0]
    let fraction = null
    let detail = ''
    const venvEnd = EXPECTED_VENV[job.variant] || EXPECTED_VENV.cuda
    if (cur.id === 'download') {
      fraction = job.total ? Math.min(1, job.got / job.total) : null
      detail = job.total ? bytesText(job.got) + ' of ' + bytesText(job.total) : ''
    } else if (VENV_STEPS.includes(cur.id)) {
      // real bytes whatever the tool prints: half for the downloads (pip's byte counts, uv's finished
      // packages), half for the venv on disk against its expected size
      const dlEnd = EXPECTED_DOWNLOAD[job.variant] || EXPECTED_DOWNLOAD.cuda
      const dl = (job.dlDone || 0) + (job.pkg ? job.pkgGot || 0 : 0)
      fraction = job.size || dl ? Math.min(0.99, 0.5 * Math.min(1, dl / dlEnd) + 0.5 * Math.min(1, job.size / venvEnd)) : null
      const pkg = job.pkg && job.pkg.name ? (job.pkgTotal && job.pkgGot ? job.pkg.name + ': ' + bytesText(job.pkgGot) + ' of ' + bytesText(job.pkgTotal) : 'Downloading ' + job.pkg.name + (job.pkg.bytes ? ' (' + bytesText(job.pkg.bytes) + ')' : '')) : ''
      const disk = job.size > 0.05 * venvEnd ? bytesText(job.size) + ' of about ' + bytesText(venvEnd) + ' installed' : dl ? bytesText(dl) + ' of about ' + bytesText(dlEnd) + ' downloaded' : ''
      detail = [pkg, disk].filter(Boolean).join(' · ')
    } else if (cur.id === 'models') {
      fraction = job.modelP
      detail = modelDetail(job.modelDetail)
    }
    // the whole job on one bar: the steps before plus this one's share; the three venv steps share one
    // measure (the venv's size on disk), so the bar follows the bytes, not the step names
    // loop: HOT-PATH-OK — ≤ 7 steps · per panel progress push while an install runs
    const total = steps.reduce((n, s) => n + WEIGHT[s.id], 0)
    let whole
    if (VENV_STEPS.includes(cur.id) && fraction !== null) {
      // loop: HOT-PATH-OK — ≤ 7 steps · per panel progress push while an install runs
      const band = steps.filter((s) => VENV_STEPS.includes(s.id))
      // loop: HOT-PATH-OK — ≤ 7 steps · per panel progress push while an install runs
      const before = steps.slice(0, steps.indexOf(band[0])).reduce((n, s) => n + WEIGHT[s.id], 0)
      // loop: HOT-PATH-OK — ≤ 7 steps · per panel progress push while an install runs
      const startHere = steps.slice(0, i).reduce((n, s) => n + WEIGHT[s.id], 0)
      // loop: HOT-PATH-OK — 3 venv steps · per panel progress push while an install runs
      whole = Math.max(startHere, before + band.reduce((n, s) => n + WEIGHT[s.id], 0) * fraction)
    // loop: HOT-PATH-OK — ≤ 7 steps · per panel progress push while an install runs
    } else whole = steps.slice(0, i).reduce((n, s) => n + WEIGHT[s.id], 0) + WEIGHT[cur.id] * (fraction || 0)
    return { stepNo: i + 1, stepCount: steps.length, label: cur.label, fraction, detail, whole: Math.max(0, Math.min(1, whole / total)) }
  }

  // the helper's "en 646/1262 MB" in words
  const MODEL_NAMES = { htdemucs: 'Vocal separator', en: 'English aligner', mms: 'Multilingual aligner', rmvpe: 'Pitch model' }
  function modelDetail(d) {
    const m = /^(\S+) (\d+)\/(\d+) MB$/.exec(String(d || ''))
    if (!m) return String(d || '')
    const name = MODEL_NAMES[m[1]] || (/^xlsr-(\w+)$/.test(m[1]) ? 'Aligner (' + m[1].slice(5) + ')' : m[1])
    return name + ': ' + m[2] + ' of ' + m[3] + ' MB'
  }

  // loop: NOT-WORTH — the job's tail (≤ TAIL lines) · only for a failed job's message
  const last = (tail, re) => (tail || []).slice().reverse().find((l) => re.test(l)) || ''
  /** A failed job's message in plain words, with what to do. */
  function failText(job) {
    const tail = job.tail || []
    switch (job.code) {
      case 'download': return 'The helper couldn\'t be downloaded. Check the internet connection, then try again. Nothing was changed.'
      case 'verify': return 'The download didn\'t pass Sonata\'s checks (size, checksum or signature), so nothing was installed. Try again later; if it happens again, please report it.'
      case 'protocol': return 'This helper version doesn\'t work with this Sonata. Update Sonata first, then try again.'
      case 'downgrade': return 'That helper is older than the one installed, so nothing was changed.'
      case 'licence': return 'The helper\'s licence changed since you accepted it. Read the new one and accept it to go on.'
      case 'space': return (job.message || 'There isn\'t enough free space for the helper.') + '. Free some space, then try again.'
      case 'venv':
        if (last(tail, /no Python 3\.\d+ found/)) return 'Setting the helper up needs Python 3.14 (or uv). Install python3.14 from your distribution, then try again. Your previous install is unchanged.'
        if (last(tail, /No space left on device/i)) return 'The disk ran full while installing the Python packages. Free some space, then try again. Your previous install is unchanged.'
        return 'Installing the helper\'s Python packages failed. Check the internet connection and free space, then try again. Your previous install is unchanged.'
      case 'check': return 'The new helper didn\'t start, so the previous install stays in use. Try again; if it keeps failing, Remove the helper and install it again.'
      case 'models': return 'The helper is installed, but its models couldn\'t be downloaded. They download on first use; check the internet connection.'
      case 'backend': return 'This helper version can be built for NVIDIA or the processor only; the AMD and Intel builds come with the next helper. Pick NVIDIA or Processor only under Build for, or wait for that update. Nothing was changed.'
      case 'sandbox': case 'home': return job.message || 'The helper\'s folder can\'t be used.'
      case 'spawn': return 'Sonata couldn\'t start its installer (align/install.sh). ' + (job.message || '')
      default: return 'The install stopped' + (job.message ? ': ' + job.message : '') + '. Try again.'
    }
  }

  // "NVIDIA GeForce RTX 5080" -> "NVIDIA RTX 5080" (the row stays short)
  const gpuName = (g) => String(g || '').replace(/\bGeForce\s+/i, '').replace(/\((R|TM)\)/g, '').replace(/\s+/g, ' ').trim()
  const LIMIT = 60
  // "Installed: " + parts, kept to the limit: the Python part goes first (it is behind the ⓘ), then the card's
  // name is shortened
  function fitParts(head, parts, gpu) {
    let all = parts.concat(gpu ? [gpu] : [])
    let t = head + all.join(', ')
    // loop: NOT-WORTH — ≤ 4 parts · per state row build (Settings shown)
    if (t.length > LIMIT) { all = all.filter((p) => !/^Python /.test(p)); t = head + all.join(', ') }
    if (t.length > LIMIT && gpu) {
      const room = LIMIT - (head + all.slice(0, -1).concat(['']).join(', ')).length
      const tail = / \([^)]+\)$/.exec(gpu)
      const name = tail ? gpu.slice(0, -tail[0].length) : gpu
      const keep = Math.max(4, room - (tail ? tail[0].length : 0) - 1)
      all[all.length - 1] = name.slice(0, keep).trimEnd() + '…' + (tail ? tail[0] : '')
      t = head + all.join(', ')
    }
    return t
  }
  // the card part of the installed line: "NVIDIA RTX 5080" (CUDA, the tested build), "AMD Radeon RX 7800 XT (ROCm)",
  // "Intel Arc A770 (XPU)", "processor only"
  function cardPart(s) {
    const b = s.backend || ''
    if (b === 'cpu' || (!b && s.gpu === 'CPU only')) return 'processor only'
    // OpenVINO: the Intel graphics it runs on (the pong's openvino device), else the processor
    if (b === 'openvino') return s.gpu && s.gpu !== 'CPU only' ? gpuName(s.gpu) + ' (OpenVINO)' : 'processor (OpenVINO)'
    const name = gpuName(s.gpu && s.gpu !== 'CPU only' ? s.gpu : s.detectedGpu || '')
    if (!name) return b && b !== 'cuda' ? '(' + SHORT[b] + ')' : ''
    return b === 'rocm' || b === 'xpu' ? name + ' (' + SHORT[b] + ')' : name
  }

  /**
   * The state row: { text (≤ 60 characters, the DS5 long-text rule), info (the longer words behind the ⓘ),
   * level: 'ok' | 'warn' | 'busy' | 'off' }. h: main's snapshot of the helper (main.js helperSnapshot).
   */
  function stateRow(h) {
    const s = h || {}
    const job = s.job
    const where = s.home || '~/.local/share/sonata-align'
    if (s.phase === 'licence') return { text: 'Waiting for you to accept the licence', info: '', level: 'busy' }
    if (job && job.phase === 'running' && (s.phase === 'running' || s.phase === 'licence-fetch')) {
      const p = progressView(job)
      if (s.resumed) {
        const what = job.kind === 'remove' ? 'Finishing the interrupted removal…' : 'Continuing the interrupted ' + NOUN[job.kind] + '… step ' + p.stepNo + ' of ' + p.stepCount
        return { text: what, info: (V ? V.NAME : 'Sonata') + ' was closed while the helper was ' + VERB[job.kind] + '. It continues where it stopped: finished downloads are kept, a download cut short goes on from where it was, and everything is checked again.', level: 'busy' }
      }
      const what = job.kind === 'remove' ? 'Removing…' : (job.kind === 'update' ? 'Updating' : job.kind === 'repair' ? 'Repairing' : 'Installing') + '… step ' + p.stepNo + ' of ' + p.stepCount
      return { text: what, info: '', level: 'busy' }
    }
    switch (s.state) {
      case 'ok': {
        const parts = ['helper ' + (V.short(s.version) || '?')]
        if (s.py) parts.push('Python ' + s.py)
        const card = cardPart(s)
        const full = 'Installed: ' + parts.concat(card ? [card] : []).join(', ')
        const newer = s.backend === 'rocm' || s.backend === 'xpu' ? ' The ' + SHORT[s.backend] + ' build is new: it hasn\'t been tested on a real ' + (s.backend === 'rocm' ? 'AMD' : 'Intel') + ' card yet.'
          : s.backend === 'openvino' ? ' The OpenVINO build is new: on the processor it measured about 1.5 times as fast as Processor only, with the same word timings; its speed on Intel graphics hasn\'t been measured on a real laptop yet.' : ''
        // Check for updates on the row (main.js checkEngineFeed interactive): its answer, for a minute
        if (!s.available && s.check === 'checking') return { text: 'Checking for a newer helper…', info: full + '.', level: 'busy' }
        if (!s.available && s.check === 'current') return { text: 'Up to date: helper ' + (V.short(s.version) || '?'), info: full + '. No newer helper is out on this channel' + (s.incompatible ? ' that works with this Sonata (' + s.incompatible + ' ' + s.incompatibleWhy + ')' : '') + '.', level: 'ok' }
        if (!s.available && s.check === 'failed') return { text: 'Couldn\'t check for a newer helper', info: (s.checkWhy ? 'The check said: ' + s.checkWhy + '. ' : '') + 'Check the internet connection, then try again. The installed helper keeps working.', level: 'warn' }
        if (s.available) return { text: 'Update available: ' + V.short(s.available), info: full + '. The update keeps the downloaded models and the build' + (s.availableNotes ? '. ' + s.availableNotes : '') + '. Installed in ' + where + '.', level: 'warn' }
        // a GPU build that found no card it can use (pong.message): it runs, slowly, on the processor
        if (s.runDevice === 'cpu' && s.backend && s.backend !== 'cpu' && s.runMessage) {
          return { text: 'Installed, but not using a graphics card', info: 'The helper ' + s.runMessage + '. Pick the build for this computer\'s card under Build for, then Rebuild.' + newer, level: 'warn' }
        }
        return { text: fitParts('Installed: ', parts, card), info: full + '. The helper is installed in ' + where + ' (about ' + (s.diskText || bytesText((EXPECTED_VENV[s.backend] || EXPECTED_VENV.cuda) + 1.4e9)) + ' with its Python packages and models). Remove deletes it; the models can stay for a later install.' + newer + (s.incompatible ? ' A newer helper (' + s.incompatible + ') is out but ' + s.incompatibleWhy + '.' : ''), level: 'ok' }
      }
      case 'update': return { text: 'Needs an update', info: 'This Sonata needs helper ' + (V.short(s.want || s.min || '') || '') + ' or newer' + (s.py && s.wantPy && s.py !== s.wantPy ? ' on Python ' + s.wantPy + ' (the installed one is on ' + s.py + ')' : '') + '. Update keeps the downloaded models and rebuilds the Python packages only when they changed.', level: 'warn' }
      case 'broken': return { text: 'Needs a repair: its Python is gone', info: 'The helper\'s Python (' + (s.target || 'its interpreter') + ') was removed. Repair rebuilds the Python packages and keeps the downloaded models.', level: 'warn' }
      case 'sandboxed': return { text: 'Needs a repair: its Python is inside another app', info: 'The helper works, but its Python lives inside another app (' + (s.target || '') + '), so that app\'s next update breaks it. Repair rebuilds it on a Python of its own and keeps the models.', level: 'warn' }
      case 'stray': return { text: 'Installed in the wrong place', info: 'The helper was installed inside another app\'s folder (' + (s.target || '') + '), where Sonata doesn\'t look. Install puts it in ' + where + '.', level: 'warn' }
      default: return { text: 'Not installed', info: 'Precise word timing needs the helper: a separate download (helper ' + (V.short(s.min || '') || '') + ' or newer, with its own licence, shown before anything is installed). It takes about 9 GB with its Python packages (PyTorch for NVIDIA; other builds under Build for) and models, goes into ' + where + ', and every download is checked (size, checksum and signature). Remove deletes it again.' + (s.models ? ' The models downloaded before are still in ' + where + '/models: Install uses them, Delete the models removes them.' : ''), level: 'off' }
    }
  }

  /**
   * The buttons the row shows now (ids, in order). Never one that would do nothing: Install only when
   * nothing is installed, Update only when there is an update, Remove only when there is something to remove.
   */
  function buttons(h) {
    const s = h || {}
    if (s.phase === 'licence' || s.confirmRemove) return []
    if ((s.job && s.job.phase === 'running') || s.phase === 'licence-fetch') return s.job && s.job.kind === 'remove' ? [] : ['cancel']
    const out = []
    if (s.state === 'missing' || s.state === 'stray') out.push('install')
    else if (s.state === 'update' || (s.state === 'ok' && s.available)) out.push('update')
    else if (s.state === 'broken' || s.state === 'sandboxed') out.push('repair')
    // Build for asks for another build than the installed one: Rebuild for it (models kept)
    else if (s.state === 'ok' && s.backend && s.wantBackend && s.backend !== s.wantBackend) out.push('rebuild')
    // Check for updates: an installed helper with no update waiting (the panel disables it while a check runs)
    if (s.state === 'ok' && !s.available) out.push('check')
    // Remove… also when only the kept models are left (it says "Delete the models…" then)
    if (s.state !== 'missing' || s.leftovers || s.models) out.push('remove')
    return out
  }
  const BUTTON_LABEL = { install: 'Install', update: 'Update', repair: 'Repair', rebuild: 'Rebuild', check: 'Check for updates', remove: 'Remove…', cancel: 'Cancel' }
  const buttonLabel = (id, s) => (id === 'rebuild' && s && s.wantBackend ? 'Rebuild for ' + ({ cuda: 'NVIDIA', rocm: 'AMD', xpu: 'Intel Arc', openvino: 'Intel (OpenVINO)', cpu: 'the processor' }[s.wantBackend]) : BUTTON_LABEL[id])

  /**
   * The Build for row: { text (≤ 60), info } — the card found and what Auto builds for. s: helperSnapshot
   * (detected: { name, backend, why, cards: [names] }, choice, wantBackend).
   */
  function buildForRow(s) {
    const d = (s && s.detected) || {}
    const want = (s && s.wantBackend) || d.backend || 'cpu'
    const found = d.name ? 'Found: ' + gpuName(d.name) : d.why ? 'No graphics card the helper can use' : 'No graphics card found'
    let text = (s && s.choice && s.choice !== 'auto') ? 'Builds for ' + BUILD_NAME[want] : found + (d.name ? ' → ' + SHORT[want] : '')
    // OpenVINO on Auto: the speed note, honest (measured on the processor, not yet on Intel graphics)
    if ((!s || !s.choice || s.choice === 'auto') && want === 'openvino') {
      const base = d.name ? found + ' → OpenVINO' : 'No usable graphics card → OpenVINO'
      const note = d.name ? ', speed untested' : ' (~1.5× faster)'
      text = (base + note).length <= LIMIT ? base + note : base
    }
    if (text.length > LIMIT) text = text.slice(0, LIMIT - 1) + '…'
    const cards = (d.cards || []).length ? 'Found: ' + d.cards.join(', ') + '. ' : ''
    const info = cards + 'Auto builds for ' + BUILD_NAME[d.backend || 'cpu'] + (d.why ? ' (' + d.why + ')' : '') + '. ' +
      'NVIDIA (CUDA, ~7 GB) is the tested build. AMD (ROCm, ~15 GB; Radeon RX 6800 and newer) and Intel Arc (XPU, ~8 GB) ' +
      'are new and not yet tested on real cards; without a usable card they run on the processor and say so. ' +
      'Intel (OpenVINO, ~1.3 GB, and ~1.8 GB more once the models are prepared at the first song) runs on Intel graphics ' +
      '(Iris Xe, UHD) or, without them, on the processor through OpenVINO: there it measured about 1.5 times as fast as ' +
      'Processor only, with the same word timings; on Intel graphics it should be faster still (estimated 2 to 4 times), ' +
      'not yet measured on a real laptop. While it runs slower than the music, first plays are timed after the song. ' +
      'Processor only (~1.3 GB) is slow. Update and Repair keep the build (an Update moves Processor only to OpenVINO when Auto picks it).'
    return { text, info }
  }

  // --- a job a quit, a crash or a power cut stopped (main keeps <userData>/helper-job.json while one runs) ---
  const JOB_KINDS = ['install', 'update', 'repair', 'remove']
  // a job that keeps getting stopped (a crash during it, every time) is resumed this often, then left to the user
  const RESUME_TRIES = 3
  const VERB = { install: 'installing', update: 'updating', repair: 'repairing', remove: 'being removed' }
  const KEEP = { install: 'Keep installing', update: 'Keep updating', repair: 'Keep repairing', remove: 'Keep removing' }
  const NOUN = { install: 'install', update: 'update', repair: 'repair', remove: 'removal' }

  /**
   * The marker of a running job: what a resume needs to run the same job again. kind; o: the start
   * options (pinText: the feed's engine, version, licence, backend, rebuild, from, deleteModels); step: the
   * job's step now; tries: how many times it was resumed already.
   */
  function jobMarker(kind, o, step, tries) {
    const x = o || {}
    const opts = {}
    // loop: NOT-WORTH — the 7 option names, once per step change
    for (const k of ['pinText', 'version', 'from', 'backend']) if (typeof x[k] === 'string' && x[k]) opts[k] = x[k]
    if (x.rebuild) opts.rebuild = true
    if (x.deleteModels) opts.deleteModels = true
    if (x.licence && typeof x.licence === 'object') opts.licence = { version: String(x.licence.version || ''), sha256: String(x.licence.sha256 || '') }
    return { v: 1, kind: JOB_KINDS.includes(kind) ? kind : 'install', step: String(step || ''), tries: Math.max(0, tries | 0), opts }
  }

  /** The marker file's text -> the marker, or null for anything else (a damaged or foreign file is ignored). */
  function parseMarker(text) {
    let m
    // error: NOT-WORTH — not JSON: no job to resume (the file is removed by the caller)
    try { m = JSON.parse(String(text || '')) } catch (e) { return null }
    if (!m || m.v !== 1 || !JOB_KINDS.includes(m.kind) || typeof m.opts !== 'object' || !m.opts) return null
    const o = m.opts
    if (o.pinText !== undefined && (typeof o.pinText !== 'string' || o.pinText.length > 8192)) return null
    if (o.backend !== undefined && !BACKENDS.includes(o.backend)) return null
    if (o.from !== undefined && !/^http:\/\/(127\.0\.0\.1|localhost)[:/]/.test(String(o.from))) return null   // a test feed's loopback only
    return jobMarker(m.kind, o, m.step, m.tries)
  }

  /** What to do with a marker found at start: { resume: true } or { resume: false, why: 'tries' } */
  function resumeDecision(m) {
    if (!m) return { resume: false, why: 'none' }
    if (m.tries >= RESUME_TRIES) return { resume: false, why: 'tries' }
    return { resume: true, why: '' }
  }

  /**
   * The question before Sonata quits or restarts while a job runs. action: 'quit' | 'restart'.
   * -> { message, detail, keep, go }: the buttons are [keep, go], keep first (the default and Escape).
   */
  function quitAsk(job, action) {
    const j = job || {}
    const kind = JOB_KINDS.includes(j.kind) ? j.kind : 'install'
    let where = ''
    if (kind !== 'remove' && j.skipped) { const p = progressView(j); where = ' (step ' + p.stepNo + ' of ' + p.stepCount + ')' }
    const restart = action === 'restart'
    return {
      message: 'The Precise timing helper is still ' + VERB[kind] + where + '.',
      detail: (restart ? 'Restart anyway? ' : 'Quit anyway? ') + 'It will continue the next time ' + (V ? V.NAME : 'Sonata') + ' starts' + (kind === 'remove' ? '.' : ', and what is downloaded already is kept.'),
      keep: KEEP[kind],
      go: restart ? 'Restart anyway' : 'Quit anyway'
    }
  }

  /** The notice at start, while a stopped job continues, and when it couldn't be finished. */
  function resumeNotice(kind, outcome) {
    const n = NOUN[JOB_KINDS.includes(kind) ? kind : 'install']
    if (outcome === 'failed') return { kind: 'error', text: 'The interrupted helper ' + n + ' couldn\'t be finished', detail: 'Settings → Precise timing says why and offers Install or Repair.' }
    return { kind: 'info', text: 'The helper ' + n + ' was interrupted — continuing…', detail: (V ? V.NAME : 'Sonata') + ' was closed while the Precise timing helper was ' + VERB[JOB_KINDS.includes(kind) ? kind : 'install'] + '; it picks up where it stopped. Cancel it in Settings → Precise timing.' }
  }

  // The Precise timing helper's task (tasks-model.js: a dot on the rail's Settings item and on the Precise
  // timing header, a press there opens that section): main.js railPrecise's state -> its words, or '' when
  // nothing waits (cleared once the update, repair or install is done).
  const TASK_TEXT = {
    update: 'The Precise timing helper needs an update',
    repair: 'The Precise timing helper needs a repair',
    available: 'A Precise timing helper update is available'
  }
  const taskOf = (precise) => TASK_TEXT[precise] || ''

  const api = { TASK_TEXT, taskOf, JOB_KINDS, RESUME_TRIES, jobMarker, parseMarker, resumeDecision, quitAsk, resumeNotice, STEPS, VENV_STEPS, EXPECTED_VENV, EXPECTED_DOWNLOAD, BACKENDS, BUILD_FOR, BUILD_NAME, fitParts, cardPart, buttonLabel, buildForRow, bytesText, sizeOf, parseLine, newJob, reduce, progressView, failText, gpuName, stateRow, buttons, BUTTON_LABEL }
  if (typeof module === 'object' && module.exports) module.exports = api
  else root.SonataHelperInstallModel = Object.freeze(api)
})(typeof globalThis !== 'undefined' ? globalThis : this)
