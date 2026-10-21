// Every Sonata window's place and size across launches: the main window, the mini player, the
// lyrics window (one record per form: lyricsBounds, stageBounds), the liner notes and the
// visualizer's screen. One module for all of them (no per-window copies), Electron-free: main.js
// passes the windows and the displays in, so node --test covers it (test/window-bounds.test.js).
//
// What it keeps (settings-store.js `bounds`): { width, height } always, { x, y } only where this
// session can read and set window positions, and { maximized: true } while maximized (the size kept
// is then the one from before maximizing, so un-maximizing after a restart gives that size back).
//
// Positions (positionsWork): X11 and XWayland (--ozone-platform=x11), Windows and macOS report and
// honour them. Native Wayland doesn't: the compositor places windows, getBounds() answers x 0, y 0
// (measured in Marcy's settings.json 2026-10-20: every saved window at 0,0) and a position asked
// for is ignored. There only the size and the maximized state are kept, and KWin places the window.
//
// Restoring (restore): a saved position goes back on the display it was on, moved and shrunk just
// enough to be wholly inside that display's work area. A position on no current display (a monitor
// unplugged, the layout changed) comes back centred on the primary display. No saved position: the
// caller's area (the screen the window opens on), centred, or left to the window manager (centre: false).
'use strict'

const GRAB = { width: 100, height: 40 }   // the piece that must be on a display for the window to count as on it

const int = (v) => Number.isInteger(v)
const hasSize = (b) => !!b && int(b.width) && int(b.height) && b.width > 0 && b.height > 0
const hasPlace = (b) => !!b && int(b.x) && int(b.y)

/**
 * Can this session read and set window positions? Native Wayland can't (see the top).
 * platform: process.platform; ozone: the --ozone-platform switch; hint: ELECTRON_OZONE_PLATFORM_HINT
 * (or --ozone-platform-hint); wayland: WAYLAND_DISPLAY is set. Electron 38+ picks Wayland by itself
 * when WAYLAND_DISPLAY is set and nothing says otherwise.
 */
function positionsWork({ platform, ozone, hint, wayland }) {
  if (platform !== 'linux') return true
  const pick = String(ozone || '') || String(hint || '')
  if (pick === 'x11') return true
  if (pick === 'wayland') return false
  return !wayland
}

// the overlap of two rectangles, { width, height } (0 when they don't touch)
function overlap(a, b) {
  return {
    width: Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)),
    height: Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y))
  }
}

/**
 * The display a window's rectangle is on: the one it overlaps most, if a grab-able piece of it
 * (GRAB, or the whole window when it is smaller) is there; else null (on no current display).
 * displays: Electron's [{ bounds, workArea }] (bounds may be missing: the work area is used).
 */
function displayFor(rect, displays) {
  let best = null
  let bestArea = 0
  // loop: NOT-WORTH — the connected displays (one to a few), once per window opened
  for (const d of displays || []) {
    const o = overlap(rect, d.bounds || d.workArea)
    if (o.width < Math.min(GRAB.width, rect.width) || o.height < Math.min(GRAB.height, rect.height)) continue
    if (o.width * o.height > bestArea) { best = d; bestArea = o.width * o.height }
  }
  return best
}

// a size kept between the minimum and the work area (the minimum gives way on a small screen)
function fitSize(size, min, area) {
  return {
    width: Math.min(Math.max(size.width, Math.min(min.width, area.width)), area.width),
    height: Math.min(Math.max(size.height, Math.min(min.height, area.height)), area.height)
  }
}
const centred = (size, area) => ({ x: area.x + Math.round((area.width - size.width) / 2), y: area.y + Math.round((area.height - size.height) / 2), width: size.width, height: size.height })

/**
 * The bounds to open a window with, and whether to maximize it.
 *  saved      the setting (or null)
 *  displays   screen.getAllDisplays(); primary: screen.getPrimaryDisplay()
 *  area       the work area a window without a saved place opens centred in
 *  size       the default size; fixed: true keeps it whatever was saved (the mini player can't be resized)
 *  min        the smallest size (default: none)
 *  positions  positionsWork(): false ignores a saved x / y
 *  centre     false: a window with no saved place gets no x / y (the window manager places it,
 *             as before this module); default true: centred in area
 * -> { x?, y?, width, height, maximized }
 */
function restore(saved, { displays, primary, area, size, min, fixed, positions, centre = true }) {
  const low = min || { width: 0, height: 0 }
  const want = !fixed && hasSize(saved) ? { width: saved.width, height: saved.height } : size
  const maximized = !!(saved && saved.maximized === true)
  if (positions && hasPlace(saved)) {
    const on = displayFor({ x: saved.x, y: saved.y, width: want.width, height: want.height }, displays)
    if (on) {
      const wa = on.workArea
      const s = fitSize(want, low, wa)
      const x = Math.min(Math.max(saved.x, wa.x), wa.x + wa.width - s.width)
      const y = Math.min(Math.max(saved.y, wa.y), wa.y + wa.height - s.height)
      return { x, y, width: s.width, height: s.height, maximized }
    }
    // on no current display: centred on the primary one
    const wa = (primary && primary.workArea) || area
    return Object.assign(centred(fitSize(want, low, wa), wa), { maximized })
  }
  const s = fitSize(want, low, area)
  return centre ? Object.assign(centred(s, area), { maximized }) : { width: s.width, height: s.height, maximized }
}

/**
 * The record to keep for a window now. prev: the record kept so far (its size stays while the
 * window is maximized). win: { isMaximized(), getBounds(), getNormalBounds?() }.
 */
function capture(win, prev, positions) {
  const maximized = win.isMaximized()
  let b
  if (!maximized) b = win.getBounds()
  else if (hasSize(prev)) b = prev
  else b = typeof win.getNormalBounds === 'function' ? win.getNormalBounds() : win.getBounds()
  const out = { width: b.width, height: b.height }
  if (positions && hasPlace(b)) { out.x = b.x; out.y = b.y }
  if (maximized) out.maximized = true
  return out
}

/**
 * Keep a window's record up to date: after a move, a resize, maximize or un-maximize (debounced),
 * and at once when it closes with a save still waiting.
 *  read() / write(record)  the setting (write saves settings.json)
 *  positions               positionsWork()
 *  fullscreen              true: also kept while fullscreen (the visualizer keeps its screen)
 *  wait                    the debounce, ms
 *  timers                  { setTimeout, clearTimeout } (tests)
 * -> { flush() }
 */
function track(win, { read, write, positions, fullscreen, wait = 500, timers }) {
  const t = timers || { setTimeout, clearTimeout }
  let timer = null
  const usable = () => !win.isDestroyed() && !win.isMinimized() && win.isVisible() && (fullscreen || !win.isFullScreen())
  const save = () => { timer = null; if (usable()) write(capture(win, read(), positions)) }
  const later = () => {
    if (!usable()) return
    t.clearTimeout(timer)
    // lifetime: OK — one debounce at a time, cleared before each new one; save() checks isDestroyed() first
    // loop: NOT-WORTH — a window's place save · one-shot `wait` ms debounce · only after a move/resize/maximize · cost ~0
    timer = t.setTimeout(save, wait)
  }
  const flush = () => { if (timer !== null) { t.clearTimeout(timer); save() } }
  // lifetime: OK — these listeners live on the window and die with it
  // loop: NOT-WORTH — four event names, once per window
  for (const ev of ['resize', 'move', 'maximize', 'unmaximize']) win.on(ev, later)
  win.on('close', flush)   // lifetime: OK — dies with the window
  return { flush }
}

module.exports = { positionsWork, displayFor, restore, capture, track, GRAB }
