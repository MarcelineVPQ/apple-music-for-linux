// Which screens run in HDR, for Settings → Experimental → HDR output (gfx-model.js expHdrOutput). Pure:
// text in, data out; main runs the one read-only program (`kscreen-doctor -o`, KDE Plasma, fixed argv, no
// shell, a 5 s timeout) and keeps the result. Ported from the DS5 app's electron/main/games/hdr.ts
// (parseKscreenOutputs), plus the brightness lines KWin prints for an HDR output, because the HDR glow's
// headroom is the peak over the SDR white: DP-5 on Marcy's desktop says "SDR brightness: 1000 nits" and
// "Peak brightness: unknown, overridden with: 1800 nits" (her settings), so 1.8× SDR white.
// Don't trust (dynamic-range: high) instead: with the scRGB profile it reads true on every screen.
;(function (root) {
  'use strict'
  // kscreen-doctor colours its output (ANSI codes) even into a pipe
  const ANSI = new RegExp(String.fromCharCode(27) + '\\[[0-9;]*m', 'g')
  const SDR_WHITE_NITS = 203        // Chromium's SDR white (BT.2408) when KWin doesn't say
  const MAX_HEADROOM = 6            // never more than 6× SDR white, whatever a setting says

  // `kscreen-doctor -o` -> [{ name, enabled, connected, hdr, sdrNits, peakNits, x, y, width, height, scale }]
  function parseKscreen(text) {
    const clean = String(text || '').replace(ANSI, '')
    return clean.split(/^Output:/m).slice(1).flatMap((block) => {
      const name = (/^\s*\d+\s+(\S+)/.exec(block) || [])[1]
      if (!name) return []
      const lines = block.split('\n').map((l) => l.trim())
      const joined = lines.join('\n')
      const geo = /^Geometry:\s*(-?\d+),(-?\d+)\s+(\d+)x(\d+)/m.exec(joined)
      const hdrState = ((/^HDR:\s*(\S+)/m.exec(joined) || [])[1] || '').toLowerCase()
      const nits = (re) => { const m = re.exec(joined); if (!m) return null; const o = /overridden with:\s*(\d+)/.exec(m[0]); const v = o ? Number(o[1]) : Number((/(\d+)\s*nits/.exec(m[0]) || [])[1]); return Number.isFinite(v) && v > 0 ? v : null }
      return [{
        name,
        enabled: lines.includes('enabled'),
        connected: lines.includes('connected'),
        hdr: hdrState === 'enabled',
        sdrNits: nits(/^SDR brightness:.*$/m),
        peakNits: nits(/^Peak brightness:.*$/m),
        x: geo ? Number(geo[1]) : 0,
        y: geo ? Number(geo[2]) : 0,
        width: geo ? Number(geo[3]) : 0,
        height: geo ? Number(geo[4]) : 0,
        scale: Number((/^Scale:\s*([\d.]+)/m.exec(joined) || [])[1]) || 1
      }]
    }).filter((o) => o.enabled && o.connected)
  }

  // how many times SDR white the screen can show (peak / SDR white), ≥ 1; null for an SDR screen
  function headroom(s) {
    if (!s || !s.hdr) return null
    const sdr = s.sdrNits || SDR_WHITE_NITS
    if (!s.peakNits) return 1
    return Math.round(Math.min(MAX_HEADROOM, Math.max(1, s.peakNits / sdr)) * 100) / 100
  }

  // the screen under a window: the one holding the window's centre (logical coordinates, as Electron's
  // screen module and KWin's Geometry both give them), else the one it overlaps most
  function screenFor(screens, b) {
    if (!b || !screens || !screens.length) return null
    const cx = b.x + b.width / 2
    const cy = b.y + b.height / 2
    const inside = screens.find((s) => cx >= s.x && cx < s.x + s.width && cy >= s.y && cy < s.y + s.height)
    if (inside) return inside
    const area = (s) => Math.max(0, Math.min(b.x + b.width, s.x + s.width) - Math.max(b.x, s.x)) * Math.max(0, Math.min(b.y + b.height, s.y + s.height) - Math.max(b.y, s.y))
    const best = screens.slice().sort((p, q) => area(q) - area(p))[0]
    return area(best) > 0 ? best : null
  }

  // what one window is told: { on, headroom, screen } (on only when HDR output is active and its screen is HDR)
  function windowHdr(active, screens, bounds) {
    const s = active ? screenFor(screens, bounds) : null
    const h = headroom(s)
    return { on: !!(active && h), headroom: h || 1, screen: s ? s.name : '' }
  }

  // About → Graphics' line for the screens
  function screensLine(screens) {
    if (!screens) return 'Looking…'
    if (!screens.length) return 'No screens read (KDE Plasma: kscreen-doctor)'
    return screens.map((s) => s.name + (s.hdr ? ' HDR' + (s.peakNits ? ', peak ' + s.peakNits + ' / SDR ' + (s.sdrNits || SDR_WHITE_NITS) + ' nits' : '') : ' SDR')).join(' · ')
  }

  const api = { SDR_WHITE_NITS, MAX_HEADROOM, parseKscreen, headroom, screenFor, windowHdr, screensLine }
  if (typeof module === 'object' && module.exports) module.exports = api
  else root.SonataHdrScreens = Object.freeze(api)
})(typeof globalThis !== 'undefined' ? globalThis : this)
