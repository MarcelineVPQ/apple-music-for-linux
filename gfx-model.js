// Settings → Experimental graphics: the graphics switches (docs/research/hdr-hw-accel-apple-music-2026-10.md,
// section 5). Pure: no Electron, no DOM (fs injected where a file is read), so node --test covers it.
//
//   EXPERIMENTS        the switches, in the order Settings lists them
//   startFlags()       which Chromium switches this start gets, decided in main.js before 'ready'
//                      from the settings file (the flags never travel in argv: appendSwitch doesn't
//                      touch process.argv, so a relaunch decides them again from the settings)
//   sentinel*()        the start marker: written before 'ready' when a switch is active, removed once
//                      the start was healthy, marked clean on a quit or restart; two starts in a row that
//                      died before getting healthy turn their switches off (a crash that takes the app down)
//   crashTurnOff()     the second GPU-process crash in one run: the riskiest active switch goes off for
//                      the next start (the DS5 recordGpuCrash rule)
//   graphicsRows()     About → Graphics, the read-only readout
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
      short: 'Videos keep the still cover\'s colours (Wayland)',   // the visible line (≤ 60); desc goes behind the ⓘ
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
      short: 'Smooths the steps in the cover\'s glow',   // the visible line (≤ 60); desc goes behind the ⓘ
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
      short: 'Brighter-than-white glow on HDR screens (KDE)',   // the visible line (≤ 60); desc goes behind the ⓘ
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
    },
    // Chromium 156 skips NVIDIA for VA-API on purpose ("Should skip nVidia device named: nvidia-drm");
    // VaapiOnNvidiaGPUs turns it on, AcceleratedVideoDecodeLinuxGL is the Linux GL decode feature, named too
    // so a changed default can't silently turn decoding off (research §3). The riskiest switch: community
    // driver code Chromium doesn't support on NVIDIA, and hardware frames on Wayland keep the BT.601 colours.
    // First to go after a graphics crash.
    {
      key: 'expHwVideoDecode',
      name: 'Hardware video decoding',
      label: 'Hardware video decoding (experimental)',
      short: 'Decodes covers on the graphics card, less CPU',   // the visible line (≤ 60); desc goes behind the ⓘ
      desc: 'Decodes animated covers on the graphics card instead of the processor (about 7 % of a CPU core less while one plays). On Wayland, video colours are currently a little off with this on. Applies at restart.',
      restart: true,
      crashRank: 1,
      features: ['VaapiOnNvidiaGPUs', 'AcceleratedVideoDecodeLinuxGL'],
      readout: (i, st) => ({
        id: 'decode',
        label: 'Video decoding',
        value: (i.decode ? i.decode : 'checking…') + (st.active.includes('expHwVideoDecode') ? '' : st.inactive.expHwVideoDecode ? ' · ' + reasonText(st.inactive.expHwVideoDecode) : '')
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
  // Written before 'ready' while a switch is active; removed once the start is healthy (HEALTHY_MS after its
  // first page, no graphics crash); marked clean when Sonata quits or restarts itself before that (Quit,
  // Restart now, an update's restart: never a failure). Still there, not clean, at the next start = that start
  // died before it got healthy: a strike for each of its switches. STRIKES in a row turn a switch off (one
  // unlucky start, a logout or a kill keeps them); a clean or healthy start in between ends the row.
  const STRIKES = 2
  // a graphics-process crash while running: the second one in one run turns the riskiest switch off (DS5's rule)
  const CRASHES = 2
  // o: { strikes: { key: n }, clean: true }
  function sentinelText(active, version, now, o) {
    const j = { flags: active.slice(), version: String(version || ''), startedAt: new Date(now).toISOString() }
    const st = o && o.strikes ? Object.fromEntries(Object.entries(o.strikes).filter(([k, n]) => n > 0 && active.includes(k))) : {}
    if (Object.keys(st).length) j.strikes = st
    if (o && o.clean) j.clean = true
    return JSON.stringify(j) + '\n'
  }
  // the marker's text (null: no marker) and the stored settings -> { disable: [keys], notice: '', strikes: { key: n } }
  // strikes: carried into this start's marker. An unreadable marker (cut short) is a strike for every switch on.
  function sentinelAtStart(text, settings) {
    if (text === null || text === undefined) return { disable: [], notice: '', strikes: {} }
    const s = settings || {}
    let j = null
    try { j = JSON.parse(text) } catch (e) { j = null }   // error: NOT-WORTH — an unreadable marker: a strike for every switch that is on (below)
    const named = j && Array.isArray(j.flags) ? j.flags.filter((k) => typeof k === 'string') : null
    const before = j && j.strikes && typeof j.strikes === 'object' ? j.strikes : {}
    const on = EXPERIMENTS.filter((e) => e.restart && s[e.key] === true).map((e) => e.key)
    const strikes = {}
    // loop: NOT-WORTH — ≤ 4 switches, once at start
    for (const k of on) {
      const had = Number.isInteger(before[k]) && before[k] > 0 ? before[k] : 0
      const used = named ? named.includes(k) : true
      // a clean exit (or a switch the last start didn't use) neither counts nor ends the row
      strikes[k] = j && j.clean ? had : used ? had + 1 : had
    }
    const disable = on.filter((k) => strikes[k] >= STRIKES)
    // loop: NOT-WORTH — ≤ 4 switches
    for (const k of disable) delete strikes[k]
    if (!disable.length) return { disable, notice: '', strikes }
    const names = listWords(disable.map(labelOf))
    const it = disable.length === 1 ? 'it' : 'them'
    return {
      disable,
      strikes,
      notice: 'Sonata turned off ' + names + ': the last ' + STRIKES + ' starts with ' + it + ' on ended before Sonata was running ' +
        'properly (it closed without being quit). Turn ' + it + ' back on in Settings → Experimental graphics.'
    }
  }
  const listWords = (xs) => (xs.length <= 1 ? xs.join('') : xs.slice(0, -1).join(', ') + ' and ' + xs[xs.length - 1])

  // --- a GPU-process crash while running ---
  // details: Electron's child-process-gone details; active: this start's active keys; settings: now.
  // -> { key, notice } (the switch to turn off for the next start) or null (not ours to handle)
  // A real failure only: a clean exit or a kill (Sonata quitting, the system) never counts.
  const realCrash = (d) => !!d && d.type === 'GPU' && d.reason !== 'clean-exit' && d.reason !== 'killed'
  function crashTurnOff(details, active, settings) {
    const d = details || {}
    if (!realCrash(d)) return null
    const s = settings || {}
    const order = EXPERIMENTS.filter((e) => e.restart && e.crashRank && (active || []).includes(e.key) && s[e.key] === true)
      .sort((a, b) => a.crashRank - b.crashRank)
    if (!order.length) return null
    const key = order[0].key
    return {
      key,
      notice: 'The graphics process stopped twice in this run (' + d.reason + '), so Sonata turned off ' + labelOf(key) +
        ' for the next start. Turn it back on in Settings → Experimental graphics.'
    }
  }

  // a switch that is on but can't act next to the others that are on (True video colours with Hardware video
  // decoding): the reason, said next to it, or null. settings: now; ctx: startContext()
  function settingConflict(key, settings, ctx) {
    const e = byKey(key)
    const s = settings || {}
    if (!e || !e.late || !e.needs || s[key] !== true) return null
    const others = new Set(EXPERIMENTS.filter((x) => x.restart && !x.late && s[x.key] === true).map((x) => x.key))
    return e.needs(Object.assign({}, ctx || {}, { active: others }))
  }
  // the words next to the switch: off (not used this start either), soon (used now, not from the next start)
  const CONFLICT_NOTE = {
    'hw-decode': {
      off: 'Not used while Hardware video decoding is on: this fix covers software-decoded video only.',
      soon: 'On now, but not used from the next start while Hardware video decoding is on: this fix covers software-decoded video only.'
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


  // About → Graphics' decoding line: Apple's page asks MediaCapabilities about Apple's top artwork stream
  // (H.264 High 1080², "powerEfficient" = a hardware decoder) and the graphics process's /proc maps say which
  // VA-API driver it loaded. p: { powerEfficient, hevc, drivers: ['nvidia_drv_video.so', …] } or null
  function decodeLabel(p) {
    if (!p) return ''
    const drv = (p.drivers || []).map((d) => d.replace(/_drv_video\.so$/, ''))
    const who = drv.includes('nvidia') ? 'NVIDIA' : drv.length ? drv.join(', ') : ''
    if (p.powerEfficient) return 'Hardware (VA-API' + (who ? ', ' + who : '') + ')' + (p.hevc ? '; HEVC too' : '')
    return 'Software (the processor)' + (who ? '; VA-API driver ' + who + ' loaded' : '')
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

  const api = { EXPERIMENTS, REASONS, STRIKES, CRASHES, CONFLICT_NOTE, reasonText, labelOf, startContext, startFlags, mergeFeatures, startLine, sentinelText, sentinelAtStart, realCrash, crashTurnOff, settingConflict, pendingRestart, decodeLabel, graphicsRows }
  if (typeof module === 'object' && module.exports) module.exports = api
  else root.SonataGfxModel = Object.freeze(api)
})(typeof globalThis !== 'undefined' ? globalThis : this)
