// Settings → Experimental: the graphics switches (docs/research/hdr-hw-accel-apple-music-2026-10.md,
// section 5). Pure: no Electron, no DOM (fs injected where a file is read), so node --test covers it.
//
//   EXPERIMENTS        the switches, in the order Settings lists them
//   startFlags()       which Chromium switches this start gets, decided in main.js before 'ready'
//                      from the settings file (the flags never travel in argv: appendSwitch doesn't
//                      touch process.argv, so a relaunch decides them again from the settings)
//   sentinel*()        the start marker: written before 'ready' when a switch is active, removed once
//                      the start was healthy for 20 s; still there at the next start = that start never
//                      got healthy, so its switches go off (covers a crash that takes the whole app down)
//   crashTurnOff()     a GPU-process crash while running: the riskiest active switch goes off for the
//                      next start (the DS5 recordGpuCrash rule)
//   graphicsRows()     About → Graphics, the read-only readout
//   cpuOver()          the readout's CPU line from /proc samples
;(function (root) {
  'use strict'

  // key: the setting (settings-store.js); restart: a Chromium switch, applies at the next start;
  // crashRank: which goes first after a GPU crash (1 = first); switches/features: what it adds;
  // needs(ctx): why it can't act on this start (null: it can)
  const EXPERIMENTS = [
    // Chromium on Wayland draws BT.709 video (Apple's animated covers, music videos) with the BT.601 matrix:
    // red 255,0,0 comes out 233,0,2 (research §1.4). Frames uploaded as plain textures get the right matrix.
    // Software-decoded video only: with hardware decoding on it changes nothing, so it waits (late: decided
    // after the others, knowing what is active).
    {
      key: 'expTrueVideoColours',
      name: 'True video colours',
      label: 'True video colours (experimental)',
      desc: 'On Wayland, animated album covers and music videos keep the colours of the still cover: reds and magentas no longer turn orange when the video fades in. Same CPU cost. Applies at restart.',
      restart: true,
      crashRank: 3,
      late: true,
      switches: () => [['disable-gpu-memory-buffer-video-frames', '']],
      blocked: (c) => (c.x11 ? 'x11-colours' : null),
      needs: (c) => (c.x11 ? 'x11-colours' : c.active.has('expHwVideoDecode') ? 'hw-decode' : null),
      readout: (i, st) => ({
        id: 'colours',
        label: 'Video colours',
        value: st.active.includes('expTrueVideoColours') ? 'True colours: video frames uploaded as textures (--disable-gpu-memory-buffer-video-frames)'
          : st.inactive.expTrueVideoColours ? reasonText(st.inactive.expTrueVideoColours)
            : i.x11 ? 'Right under X11' : 'Chromium\'s default on Wayland: reds and magentas in video a little off (BT.601 matrix)'
      })
    },
    // Apple's glow around an album cover fades in flat 8-bit rings (research §1–2.4); Marcy's Phase 0 pick:
    // noise added with plus-lighter (glow-dither.js). CSS in Apple's page, so it applies at once.
    {
      key: 'expGlowDither',
      name: 'Dithered cover glow',
      label: 'Dithered cover glow (experimental)',
      desc: 'Adds the finest grain to the soft glow around an album\'s cover on Apple\'s page, so it fades smoothly instead of in visible steps (they show most on HDR screens). Applies at once.',
      restart: false,
      readout: (i) => ({
        id: 'glow',
        label: 'Cover glow',
        value: i.settings && i.settings.expGlowDither ? 'Dithered: one code value of grain over the glow\'s fade, plus-lighter' : 'Apple\'s own: fades in 8-bit steps'
      })
    },
    // Sonata renders in scRGB (linear, 1.0 = SDR white), the DS5 app's switch: KWin 6.6 has no "srgb"
    // transfer for Chromium's default path. Phase 0 on DP-5: F16 buffers either way; with scRGB the
    // WebGPU rgba16float canvas was the brightest white (hdr-glow.js draws the sung word with it; screens
    // from kscreen-doctor, hdr-screens.js). Needs native Wayland (XWayland surfaces carry no colour description).
    {
      key: 'expHdrOutput',
      name: 'HDR output',
      label: 'HDR output (experimental)',
      desc: 'On an HDR screen (KDE Plasma), Sonata draws in high dynamic range: the word being sung in the lyrics window and the visualizer glows brighter than white. Applies at restart.',
      restart: true,
      crashRank: 2,
      switches: () => [['force-color-profile', 'scrgb-linear']],
      blocked: (c) => (c.x11 ? 'x11' : null),
      needs: (c) => (c.x11 ? 'x11' : null),
      readout: (i, st) => ({
        id: 'hdr',
        label: 'HDR output',
        value: st.active.includes('expHdrOutput') ? 'On (scRGB): ' + (i.screensLine || 'reading the screens…')
          : st.inactive.expHdrOutput ? reasonText(st.inactive.expHdrOutput) : 'Off' + (i.screensLine ? ' · ' + i.screensLine : '')
      })
    }
  ]

  const byKey = (k) => EXPERIMENTS.find((e) => e.key === k) || null
  const labelOf = (k) => (byKey(k) ? byKey(k).name : k)

  // the words for why a switch that is on does nothing this start
  const REASONS = {
    safe: 'Off for this start: Sonata was started with --safe-gpu',
    'gpu-off': 'Needs the graphics card: Sonata is drawing in software right now',
    'not-linux': 'Only on Linux',
    x11: 'Not under X11 (--ozone-platform=x11): it needs Sonata running on Wayland',
    'x11-colours': 'Not needed under X11: video colours are already right there',
    'hw-decode': 'Hardware video decoding is on, and this fix covers software-decoded video only'
  }
  const reasonText = (r) => REASONS[r] || r || ''

  // the facts startFlags works from: argv, environment and platform
  function startContext(o) {
    const argv = (o && o.argv) || []
    const env = (o && o.env) || {}
    const has = (s) => argv.some((a) => a === s || a.startsWith(s + '='))
    const val = (s) => { const a = argv.find((x) => x.startsWith(s + '=')); return a ? a.slice(s.length + 1) : '' }
    const ozone = val('--ozone-platform') || env.ELECTRON_OZONE_PLATFORM_HINT || ''
    return {
      linux: (o && o.platform) === 'linux',
      safe: has('--safe-gpu') || env.SONATA_SAFE_GPU === '1',
      gpuOff: has('--disable-gpu') || has('--disable-gpu-compositing'),
      x11: ozone === 'x11' || (ozone !== 'wayland' && !env.WAYLAND_DISPLAY && !!env.DISPLAY),
      enableFeatures: val('--enable-features')
    }
  }

  // -> { safe, active: [keys], inactive: { key: reason }, switches: [[name, value]], line }
  // settings: the stored settings (only the EXPERIMENTS keys are read)
  function startFlags(settings, o) {
    const s = settings || {}
    const ctx = startContext(o)
    // the ones that depend on what else is active (late) are decided last
    const wanted = EXPERIMENTS.filter((e) => e.restart && s[e.key] === true).sort((a, b) => (a.late ? 1 : 0) - (b.late ? 1 : 0)).map((e) => e.key)
    ctx.active = new Set()
    const active = []
    const inactive = {}
    const switches = []
    const features = []
    // loop: NOT-WORTH — ≤ 4 switches, once at start
    for (const k of wanted) {
      const e = byKey(k)
      const why = ctx.safe ? 'safe' : ctx.gpuOff ? 'gpu-off' : !ctx.linux ? 'not-linux' : (e.needs ? e.needs(ctx) : null)
      if (why) { inactive[k] = why; continue }
      active.push(k)
      ctx.active.add(k)
      if (e.switches) switches.push(...e.switches(ctx))
      if (e.features) features.push(...e.features)
    }
    // --enable-features is one switch: the last one wins, so ours join any given on the command line
    if (features.length) switches.push(['enable-features', mergeFeatures(ctx.enableFeatures, features)])
    return { safe: ctx.safe, active, inactive, switches, line: startLine(active, inactive, switches) }
  }
  function mergeFeatures(given, add) {
    const out = String(given || '').split(',').map((x) => x.trim()).filter(Boolean)
    // loop: NOT-WORTH — a handful of feature names, once at start
    for (const f of add) if (!out.includes(f)) out.push(f)
    return out.join(',')
  }
  // the one [gpu] line at start (Development builds log it; enough with the start marker to read a report)
  function startLine(active, inactive, switches) {
    const sw = switches.map(([n, v]) => '--' + n + (v ? '=' + v : '')).join(' ')
    const off = Object.keys(inactive).map((k) => k + '(' + inactive[k] + ')').join(', ')
    return '[gpu] experimental: ' + (active.length ? active.join(', ') + ' → ' + sw : 'none') + (off ? '; on but not used: ' + off : '')
  }

  // --- the start marker (~/.config/apple-music-for-linux/gpu-experiment.json) ---
  function sentinelText(active, version, now) {
    return JSON.stringify({ flags: active.slice(), version: String(version || ''), startedAt: new Date(now).toISOString() }) + '\n'
  }
  // the marker's text (null: no marker) and the stored settings -> { disable: [keys], notice: '' }
  // An unreadable marker (cut short) counts as naming every switch that is on.
  function sentinelAtStart(text, settings) {
    if (text === null || text === undefined) return { disable: [], notice: '' }
    const s = settings || {}
    let named = null
    try {
      const j = JSON.parse(text)
      if (j && Array.isArray(j.flags)) named = j.flags.filter((k) => typeof k === 'string')
    } catch (e) { named = null }   // error: NOT-WORTH — an unreadable marker: every switch that is on goes off (below)
    const on = EXPERIMENTS.filter((e) => e.restart && s[e.key] === true).map((e) => e.key)
    const disable = named ? on.filter((k) => named.includes(k)) : on
    if (!disable.length) return { disable, notice: '' }
    const names = listWords(disable.map(labelOf))
    return {
      disable,
      notice: 'Sonata turned off ' + names + ': the last start with ' + (disable.length === 1 ? 'it' : 'them') +
        ' on didn\'t finish. You can turn ' + (disable.length === 1 ? 'it' : 'them') + ' back on in Settings → Experimental.'
    }
  }
  const listWords = (xs) => (xs.length <= 1 ? xs.join('') : xs.slice(0, -1).join(', ') + ' and ' + xs[xs.length - 1])

  // --- a GPU-process crash while running ---
  // details: Electron's child-process-gone details; active: this start's active keys; settings: now.
  // -> { key, notice } (the switch to turn off for the next start) or null (not ours to handle)
  function crashTurnOff(details, active, settings) {
    const d = details || {}
    if (d.type !== 'GPU' || d.reason === 'clean-exit' || d.reason === 'killed') return null
    const s = settings || {}
    const order = EXPERIMENTS.filter((e) => e.restart && e.crashRank && (active || []).includes(e.key) && s[e.key] === true)
      .sort((a, b) => a.crashRank - b.crashRank)
    if (!order.length) return null
    const key = order[0].key
    return {
      key,
      notice: 'The graphics process stopped (' + d.reason + '), so Sonata turned off ' + labelOf(key) +
        ' for the next start. You can turn it back on in Settings → Experimental.'
    }
  }

  // the switches whose setting differs from what this start uses (Settings: "applies at restart")
  // -> [names]
  function pendingRestart(settings, start) {
    const s = settings || {}
    const st = start || { active: [], inactive: {} }
    return EXPERIMENTS.filter((e) => e.restart).filter((e) => {
      const usedNow = st.active.includes(e.key) || Object.prototype.hasOwnProperty.call(st.inactive, e.key)
      return (s[e.key] === true) !== usedNow
    }).map((e) => e.name)
  }

  // --- the readout's CPU line: /proc samples [{ t (ms), ticks: { pid: { kind, ticks } } }], 100 ticks/s ---
  // -> { seconds, total, gpu, page } in % of one core over the window (≤ 60 s), or null with < 2 samples
  function cpuOver(samples, hz) {
    const list = (samples || []).filter((x) => x && x.ticks)
    if (list.length < 2) return null
    const a = list[0]
    const b = list[list.length - 1]
    const secs = (b.t - a.t) / 1000
    if (!(secs > 0)) return null
    const per = { total: 0, gpu: 0, page: 0 }
    // loop: NOT-WORTH — Sonata's processes (≤ ~12), once per sample while About → Graphics is open
    for (const pid of Object.keys(b.ticks)) {
      const now = b.ticks[pid]
      const then = a.ticks[pid]
      const d = Math.max(0, now.ticks - (then && then.kind === now.kind ? then.ticks : now.ticks))
      const pct = d / (hz || 100) / secs * 100
      per.total += pct
      if (now.kind === 'gpu') per.gpu += pct
      if (now.kind === 'page') per.page += pct
    }
    const r = (x) => Math.round(x * 10) / 10
    return { seconds: Math.round(secs), total: r(per.total), gpu: r(per.gpu), page: r(per.page) }
  }
  // the CPU ticks of one /proc/<pid>/stat line (utime + stime), or null
  function statTicks(text) {
    const m = /\)\s+(.*)$/.exec(String(text || '').trim())
    if (!m) return null
    const f = m[1].split(/\s+/)
    const n = Number(f[11]) + Number(f[12])
    return Number.isFinite(n) ? n : null
  }
  // keep the samples of the last `windowMs` (and the one just before, so the window is full)
  function trimSamples(samples, now, windowMs) {
    const keep = samples.filter((x) => now - x.t <= windowMs)
    const older = samples.filter((x) => now - x.t > windowMs)
    return older.length ? [older[older.length - 1]].concat(keep) : keep
  }

  // --- About → Graphics (read-only) ---
  // info: { gpu (app.getGPUFeatureStatus()), start (startFlags), settings, decode, hdr, cpu }
  // -> [{ id, label, value }]
  function graphicsRows(info) {
    const i = info || {}
    const st = i.start || { active: [], inactive: {}, safe: false }
    const gpuOn = !!(i.gpu && /^enabled/.test(String(i.gpu.gpu_compositing || '')))
    const rows = [{ id: 'accel', label: 'Hardware acceleration', value: i.gpu ? (gpuOn ? 'On' : 'Off: drawing in software') : '…' }]
    rows.push({
      id: 'experimental',
      label: 'Experimental switches',
      value: st.safe ? 'Off for this start (--safe-gpu)' : st.active.length ? st.active.map(labelOf).join(', ') : 'None active'
    })
    // loop: NOT-WORTH — ≤ 4 switches, while About → Graphics is open
    for (const e of EXPERIMENTS) if (e.readout) rows.push(e.readout(i, st))   // i.x11: Sonata runs under X11
    const c = i.cpu
    rows.push({
      id: 'cpu',
      label: c && c.seconds >= 55 ? 'CPU in the last minute' : 'CPU so far' + (c ? ' (' + c.seconds + ' s)' : ''),
      value: c ? 'Sonata ' + pct(c.total) + ' · graphics process ' + pct(c.gpu) + ' · Apple\'s page ' + pct(c.page) + ' (% of one core)' : 'Measuring…'
    })
    return rows
  }
  const pct = (x) => (Math.round(x * 10) / 10).toFixed(1) + ' %'

  const api = { EXPERIMENTS, REASONS, reasonText, labelOf, startContext, startFlags, mergeFeatures, startLine, sentinelText, sentinelAtStart, crashTurnOff, pendingRestart, cpuOver, statTicks, trimSamples, graphicsRows }
  if (typeof module === 'object' && module.exports) module.exports = api
  else root.SonataGfxModel = Object.freeze(api)
})(typeof globalThis !== 'undefined' ? globalThis : this)
