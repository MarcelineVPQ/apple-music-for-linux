#!/usr/bin/env node
// UI checks for the navigation rail, against a RUNNING ISOLATED Sonata (never the user's copy):
// a copy of `npm run dist`'s linux-unpacked in a scratch folder, throwaway HOME/XDG dirs, Xvfb,
// dbus-run-session, --password-store=basic, the window at x=0 y=0, started with
//   --remote-debugging-port=<cdp> --inspect=<insp>   (any free ports, not 9333 and not the user's)
// Since 0.15.31 the main window holds two views: Apple's page and the rail (rail.html). This talks
// to both over the DevTools protocol, to the main process over its inspector (view bounds, counts),
// takes window screenshots from the X server (both views together), and sends real keyboard and
// pointer input through XTest (tools/xtest-input.py), so Ctrl+B / Ctrl+D / Tab / F6 take a person's path.
//
//   node tools/rail-check.js <phase> --cdp 9471 --insp 9472 --display :87 --out DIR [--label 1100x760]
//   phases: matrix (unpinned/pinned/locked x light/dark, screenshots + asserts, incl. simulated
//           right-docked fixed panels), keys (keyboard & a11y, focus handoff between the views),
//           loops (counts over open/close, pin/unpin, hover, navigation, reloads), perf (repaints, layouts)
// Prints one JSON report and exits 1 if any assert failed.
//
// What this can't prove (the page is Apple's LOGGED-OUT web player, the only one that loads in
// isolation): Apple's logged-in panels themselves. They live inside Apple's view, whose width is the
// window minus the rail, so they can't reach under the rail; the simulated panels stand in for them.
'use strict'
const fs = require('fs')
const path = require('path')
const M = require('../rail-model')

const args = process.argv.slice(2)
const phase = args[0]
const opt = (name, def) => { const i = args.indexOf('--' + name); return i >= 0 ? args[i + 1] : def }
const CDP = Number(opt('cdp', 9471))
const INSP = Number(opt('insp', 9472))
const DISPLAY = opt('display', ':87')
const OUT = opt('out', '.')
const LABEL = opt('label', '')
const results = []
function check(name, ok, detail) { results.push({ name, ok: !!ok, detail }); return ok }

const { createKit, parse, lum, ratio, lay, worst } = require('./cdp-lib')
const { sleep, x, xshot, ws, target, mainProc, waitFor } = createKit({ cdp: CDP, insp: INSP, display: DISPLAY })

async function views() {
  const apple = await target('music.apple.com')
  const rail = await target('rail.html')
  return { apple, rail, close: () => { apple.c.close(); rail.c.close() } }
}
// the window and its two views, from the main process
const LAYOUT = `(() => {
  const { BaseWindow } = process.mainModule.require('electron')
  const w = BaseWindow.getAllWindows().find((w) => w.contentView && w.contentView.children.length === 2)
  const [a, r] = w.contentView.children
  return { content: w.getContentBounds(), apple: a.getBounds(), rail: r.getBounds(), appleUrl: a.webContents.getURL(), railUrl: r.webContents.getURL() }
})()`
// counts in the main process that must stay flat
const MAIN_COUNTS = `(() => {
  const { ipcMain, BaseWindow, webContents } = process.mainModule.require('electron')
  const win = BaseWindow.getAllWindows().find((w) => w.contentView && w.contentView.children.length === 2)
  const [a, r] = win.contentView.children
  const ch = ['rail:command', 'rail:focus-in', 'lyrics-command', 'mini-command', 'settings:set', 'settings:action', 'viz-close']
  return {
    ipc: Object.fromEntries(ch.map((n) => [n, ipcMain.listenerCount(n)])),
    apple: Object.fromEntries(['dom-ready', 'did-navigate', 'before-input-event', 'page-title-updated', 'will-navigate', 'focus'].map((n) => [n, a.webContents.listenerCount(n)])),
    rail: Object.fromEntries(['before-input-event', 'focus', 'did-start-loading', 'will-navigate'].map((n) => [n, r.webContents.listenerCount(n)])),
    win: Object.fromEntries(['resize', 'move', 'close', 'closed', 'focus', 'enter-full-screen', 'leave-full-screen', 'app-command'].map((n) => [n, win.listenerCount(n)])),
    children: win.contentView.children.length,
    webContents: webContents.getAllWebContents().length,
    windows: BaseWindow.getAllWindows().length,
    timers: process.getActiveResourcesInfo().filter((x) => x === 'Timeout').length
  }
})()`
const winTitles = (mp) => mp.ev(`process.mainModule.require('electron').BaseWindow.getAllWindows().map((w) => w.getTitle())`)
const closeWin = (mp, title) => mp.ev(`(() => { const w = process.mainModule.require('electron').BaseWindow.getAllWindows().find((w) => w.getTitle() === ${JSON.stringify(title)}); if (w) w.close(); return !!w })()`)
const settingsFile = `JSON.parse(require('fs').readFileSync(require('path').join(process.mainModule.require('electron').app.getPath('userData'), 'settings.json'), 'utf8'))`

// --- the rail, in its own view (coordinates of that view; LAYOUT turns them into window coordinates) ---
const RAIL_STATE = `(() => {
  const R = globalThis.__sonataRail
  const panel = R.panel
  const pr = panel.getBoundingClientRect()
  const nav = document.querySelector('.nav')
  const rows = [...document.querySelectorAll('.link, .status, .lockbtn')].map((b) => {
    const r = b.getBoundingClientRect(); const lab = b.querySelector('.label'); const cs = getComputedStyle(lab || b)
    const name = b.querySelector('.name') || lab
    const ic = b.querySelector('.ic')
    const icR = ic.getBoundingClientRect()
    const dot = b.querySelector('.dot')
    let glyphInside = null
    if (dot && dot.firstChild) {
      const rg = document.createRange(); rg.selectNodeContents(dot); const gr = rg.getBoundingClientRect(); const dr = dot.getBoundingClientRect()
      glyphInside = gr.left >= dr.left - 0.5 && gr.right <= dr.right + 0.5
    }
    return { id: b.dataset.rail || b.className, button: b.tagName === 'BUTTON', hasLabel: !!lab, rect: [r.left, r.top, r.right, r.bottom],
      icGap: lab ? lab.getBoundingClientRect().left - icR.right : null, icW: icR.width, glyphInside,
      iconColor: getComputedStyle(b).color,
      labelFits: !lab || (name.scrollWidth <= name.clientWidth + 0.5 && (!b.querySelector('.sub') || b.querySelector('.sub').scrollWidth <= b.querySelector('.sub').clientWidth + 0.5)),
      labelOpacity: lab ? cs.opacity : null, labelColor: cs.color, subColor: b.querySelector('.sub') ? getComputedStyle(b.querySelector('.sub')).color : null,
      bg: getComputedStyle(b).backgroundColor, active: b.classList.contains('active'),
      aria: { pressed: b.getAttribute('aria-pressed'), current: b.getAttribute('aria-current'), label: b.getAttribute('aria-label'), keys: b.getAttribute('aria-keyshortcuts'), title: b.getAttribute('title'), role: b.getAttribute('role'), tab: b.tabIndex } }
  })
  const pcs = getComputedStyle(panel)
  const ae = document.activeElement
  return { open: panel.classList.contains('open'), pinned: panel.classList.contains('pinned'), panel: [pr.left, pr.top, pr.right, pr.bottom], vw: innerWidth, vh: innerHeight,
    panelBg: pcs.backgroundColor, transition: pcs.transitionDuration,
    navOverflow: nav.scrollHeight - nav.clientHeight, rows, view: R.view(), state: R.state(), counts: R.counts(),
    hasFocus: document.hasFocus(),
    focused: ae && ae.dataset && ae.dataset.rail ? ae.dataset.rail : null,
    focusOutline: ae && ae !== document.body ? (() => { const s = getComputedStyle(ae); return { style: s.outlineStyle, width: s.outlineWidth, color: s.outlineColor } })() : null,
    navLabel: panel.getAttribute('aria-label') }
})()`
// Apple's page, in its own view: everything of it lies inside its viewport; the simulated logged-in
// panels (fixed right:0 30vw, a 100vw strip) are added for the check and removed after
const APPLE_STATE = `(() => {
  const add = (css) => { const d = document.createElement('div'); d.setAttribute('data-sonata-test', ''); d.style.cssText = css; document.body.appendChild(d); return d }
  const dock = add('position:fixed;top:0;right:0;width:30vw;height:100vh;background:rgba(255,0,0,.25);z-index:2147483647;pointer-events:none')
  const strip = add('position:fixed;left:0;bottom:120px;width:100vw;height:24px;background:rgba(0,0,255,.35);z-index:2147483647;pointer-events:none')
  const dr = dock.getBoundingClientRect(); const sr = strip.getBoundingClientRect()
  let maxRight = 0
  const walk = (root) => {
    for (const el of root.querySelectorAll('*')) {
      if (el.shadowRoot) walk(el.shadowRoot)
      const r = el.getBoundingClientRect()
      if (r.width < 1 || r.height < 1) continue
      const cs = getComputedStyle(el)
      if (cs.position === 'fixed' && r.right > maxRight) maxRight = r.right
    }
  }
  walk(document)
  const q = (s) => { const e = document.querySelector(s); if (!e) return null; const r = e.getBoundingClientRect(); return [Math.round(r.left), Math.round(r.top), Math.round(r.right), Math.round(r.bottom)] }
  return { iw: innerWidth, ih: innerHeight, dock: [dr.left, dr.right], strip: [sr.left, sr.right], maxFixedRight: maxRight,
    playerBar: q('.player-bar'), page: q('#scrollable-page'), hScroll: document.scrollingElement.scrollWidth > document.scrollingElement.clientWidth,
    railInApple: document.querySelectorAll('sonata-rail').length, stops: document.querySelectorAll('sonata-focus').length,
    dark: matchMedia('(prefers-color-scheme: dark)').matches }
})()`
const APPLE_CLEAN = `(() => { for (const d of document.querySelectorAll('[data-sonata-test]')) d.remove(); return true })()`

async function setTheme(v, dark) {
  for (let i = 0; i < 2; i++) {
    if ((await v.apple.ev('matchMedia("(prefers-color-scheme: dark)").matches')) === dark) return true
    x('move', 400, 300); x('key', 'ctrl+d'); await sleep(700)
  }
  return (await v.apple.ev('matchMedia("(prefers-color-scheme: dark)").matches')) === dark
}
// the lock is clicked for real (XTest): the rail ignores untrusted clicks
async function setLocked(v, mp, locked) {
  for (let i = 0; i < 2; i++) {
    const s = await v.rail.ev('globalThis.__sonataRail.state()')
    if (s && !!s.locked === locked) return true
    const L = await mp.ev(LAYOUT)
    const r = await v.rail.ev('(() => { const b = document.querySelector(".lockbtn").getBoundingClientRect(); return [b.left + b.width / 2, b.top + b.height / 2] })()')
    x('click', Math.round(L.rail.x + r[0]), Math.round(r[1])); await sleep(700)
    x('move', 300, 300); await sleep(500)
  }
  const s = await v.rail.ev('globalThis.__sonataRail.state()')
  return !!s.locked === locked
}
async function setPinned(v, pinned) {
  for (let i = 0; i < 2; i++) {
    const s = await v.rail.ev('globalThis.__sonataRail.state()')
    if (s && !!s.pinned === pinned) return true
    x('move', 400, 300); x('key', 'ctrl+b'); await sleep(700)
  }
  const s = await v.rail.ev('globalThis.__sonataRail.state()')
  return !!s.pinned === pinned
}

// --- phases ---
async function matrix() {
  const v = await views()
  const mp = await mainProc()
  const L0 = await mp.ev(LAYOUT)
  const W = L0.content.width; const H = L0.content.height
  check(LABEL + ' window size', true, W + 'x' + H)
  for (const which of ['unpinned', 'pinned', 'locked']) {
    const pinned = which === 'pinned'
    const locked = which === 'locked'
    for (const dark of [false, true]) {
      const tag = `${LABEL}-${which}-${dark ? 'dark' : 'light'}`
      check(tag + ' theme set (Ctrl+D)', await setTheme(v, dark))
      if (locked) check(tag + ' lock set (click)', await setLocked(v, mp, true))
      else { await setLocked(v, mp, false); check(tag + ' pin set (Ctrl+B)', await setPinned(v, pinned)) }
      x('move', 300, Math.round(H / 2)); await sleep(700)
      for (const hover of pinned ? [false] : [false, true]) {
        if (hover) { x('move', W - 20, 60); await sleep(900) }
        const t = tag + (hover ? (locked ? '-hover' : '-open') : '')
        const L = await mp.ev(LAYOUT)
        const r = await v.rail.ev(RAIL_STATE)
        const a = await v.apple.ev(APPLE_STATE)
        xshot(path.join(OUT, t + '.png'), W, H)
        await v.apple.ev(APPLE_CLEAN)
        const mode = r.state.mode
        const lay0 = M.railLayout(W, pinned)
        const overlay = r.open && mode !== 'pinned'
        check(t + ' mode', mode === (pinned ? (W - 196 >= 800 ? 'pinned' : 'floating') : 'collapsed'), mode)
        // the two views: Apple's ends where the rail's room starts; the rail view sits at the right edge
        check(t + ' Apple view = window minus the room', L.apple.x === 0 && L.apple.width === W - lay0.room && L.apple.height === H && a.iw === W - lay0.room, { apple: L.apple, iw: a.iw, room: lay0.room })
        check(t + ' rail view at the right edge, as wide as shown', L.rail.x + L.rail.width === W && L.rail.width === (overlay || mode === 'pinned' ? 196 : 52) && L.rail.height === H, L.rail)
        check(t + ' views side by side unless the rail is open over the page', overlay || L.rail.x === L.apple.x + L.apple.width, { apple: L.apple, rail: L.rail })
        // Apple's own fixed/vw elements, and the simulated logged-in panels (right:0 30vw, 100vw), end in its view
        check(t + ' simulated right-docked panel (fixed, right:0, 30vw) ends at the rail', Math.abs(a.dock[1] - a.iw) < 0.5 && (overlay || a.dock[1] <= L.rail.x + 0.5), { dock: a.dock, railX: L.rail.x })
        check(t + ' simulated 100vw strip ends at the rail', Math.abs(a.strip[1] - a.iw) < 0.5 && (overlay || a.strip[1] <= L.rail.x + 0.5), { strip: a.strip, railX: L.rail.x })
        check(t + ' every fixed element of Apple\'s inside its view', a.maxFixedRight <= a.iw + 0.5, a.maxFixedRight)
        check(t + ' player bar and scrolling page inside Apple\'s view', (!a.playerBar || a.playerBar[2] <= a.iw) && (!a.page || a.page[2] <= a.iw), { bar: a.playerBar, page: a.page })
        check(t + ' no horizontal scroll; no rail inside Apple\'s page; two focus stops', !a.hScroll && a.railInApple === 0 && a.stops === 2, { hScroll: a.hScroll, rail: a.railInApple, stops: a.stops })
        check(t + ' open state', locked ? !r.open : (r.open === (pinned ? mode === 'pinned' : hover) || (mode === 'floating' && r.open === hover)), { open: r.open, hover, locked })
        check(t + ' pin and lock never both on', !(r.state.pinned && r.state.locked))
        // the panel, in window coordinates: what shows is the part inside the rail view
        const visible = (rc) => { const x1 = Math.max(0, rc[0]), x2 = Math.min(r.vw, rc[2]), y1 = Math.max(0, rc[1]), y2 = Math.min(r.vh, rc[3]); return { x: L.rail.x + x1, w: Math.max(0, x2 - x1), h: Math.max(0, y2 - y1), bottom: rc[3] } }
        const pv = visible(r.panel)
        check(t + ' rail shows its width at the right edge', Math.abs(pv.w - (r.open ? 196 : 52)) < 1 && Math.abs(pv.x + pv.w - W) < 1 && pv.h === H, pv)
        check(t + ' nothing clipped in the rail (rows inside the window, nav not overflowing)', r.navOverflow <= 0 && r.rows.every((x) => x.rect[3] <= H + 0.5 && x.rect[1] >= 0), { navOverflow: r.navOverflow, lowest: Math.max(...r.rows.map((x) => x.rect[3])), H })
        const buttons = r.rows.filter((x) => x.button)
        check(t + ' hit targets >= 32 px (visible part)', buttons.every((b) => { const vb = visible(b.rect); return vb.w >= 32 && vb.h >= 32 }), buttons.map((b) => { const vb = visible(b.rect); return b.id + ' ' + Math.round(vb.w) + 'x' + Math.round(vb.h) }).join(', '))
        const lk = r.rows.find((x) => x.id === 'lock')
        const lkv = visible(lk.rect)
        check(t + ' lock: aria-pressed matches, tooltip, in the icon column', lk.aria.pressed === String(locked) && /lock/i.test(lk.aria.title) && lkv.x >= pv.x - 0.5 && lkv.x + lkv.w <= pv.x + 52.5, { pressed: lk.aria.pressed, lock: lkv, panelX: pv.x })
        const labelled = r.rows.filter((x) => x.hasLabel)
        check(t + ' icon column never touches the words (gap >= 8 px, column 20 px, dot glyph inside the dot)', labelled.every((x) => x.icGap >= 8 && Math.abs(x.icW - 20) < 0.5 && x.glyphInside !== false), labelled.map((x) => x.id + ':' + x.icGap.toFixed(1)).join(', '))
        if (r.open) check(t + ' labels fit (no ellipsis) and show', labelled.every((x) => x.labelFits && x.labelOpacity === '1'), labelled.filter((x) => !x.labelFits || x.labelOpacity !== '1').map((x) => x.id))
        else check(t + ' labels hidden while closed', labelled.every((x) => x.labelOpacity === '0'))
        // contrast, worst case (the panel over white or black), from computed colours
        const glass = parse(r.panelBg)
        const lowest = { label: 99, soft: 99, active: 99 }
        for (const row of labelled) {
          const layers = [glass]
          const bg = parse(row.bg)
          if (bg && bg.a > 0) layers.push(bg)
          const k = worst(parse(row.labelColor).rgb, layers)
          if (row.active) lowest.active = Math.min(lowest.active, k); else lowest.label = Math.min(lowest.label, k)
          if (row.subColor) lowest.soft = Math.min(lowest.soft, worst(parse(row.subColor).rgb, layers))
        }
        check(t + ' label contrast >= 4.5 (worst case)', Math.min(lowest.label, lowest.soft, lowest.active) >= 4.5, Object.fromEntries(Object.entries(lowest).map(([k, v]) => [k, +v.toFixed(2)])))
        check(t + ' lock icon contrast >= 3', worst(parse(lk.iconColor).rgb, [glass].concat(parse(lk.bg) && parse(lk.bg).a > 0 ? [parse(lk.bg)] : [])) >= 3)
        check(t + ' surface follows the theme; solid with room of its own, tinted glass only over Apple\'s page', (lum(glass.rgb) < 0.2) === dark && (overlay ? glass.a < 1 && glass.a >= 0.85 : glass.a === 1), { bg: r.panelBg, overlay })
        if (hover) { x('move', 300, Math.round(H / 2)); await sleep(700) }
      }
    }
  }
  await setTheme(v, false); await setLocked(v, mp, false); await setPinned(v, false)
  v.close(); mp.c.close()
}

async function keys() {
  const v = await views()
  const mp = await mainProc()
  await setTheme(v, false); await setLocked(v, mp, false); await setPinned(v, false)
  const L0 = await mp.ev(LAYOUT)
  const W = L0.content.width
  const onRail = async () => { const r = await v.rail.ev('[document.hasFocus(), document.activeElement && document.activeElement.dataset ? document.activeElement.dataset.rail || null : null]'); return r[0] && !!r[1] }
  const onApple = () => v.apple.ev('document.hasFocus() && !!document.activeElement && document.activeElement !== document.body && document.activeElement.tagName !== "SONATA-FOCUS" ? (document.activeElement.getAttribute("aria-label") || document.activeElement.textContent || "").trim().slice(0, 30) || document.activeElement.tagName : null')
  // into the rail: the first Tab of a fresh page (the stop first in Apple's body)
  await v.apple.c.send('Page.reload'); await sleep(7000)
  x('move', 300, 300)
  await mp.ev(`(process.mainModule.require('electron').BaseWindow.getAllWindows().find((w) => w.contentView && w.contentView.children.length === 2).contentView.children[0].webContents.focus(), true)`)
  await sleep(300)
  let tabs = 0; let reached = false
  for (; tabs < 6 && !reached; tabs++) { x('key', 'tab'); await sleep(250); reached = await onRail() }
  check('Tab from the top of Apple\'s page reaches the rail (its own view)', reached, { tabs })
  let r = await v.rail.ev(RAIL_STATE)
  check('keyboard focus opens the rail (focus-visible)', r.open && r.view.focusVisible, r.view)
  check('Tab lands on one item (roving tabindex)', r.rows.filter((x) => x.button && x.aria.tab === 0).length === 1, r.focused)
  check('focus ring visible (2px solid)', r.focusOutline && r.focusOutline.style === 'solid' && r.focusOutline.width === '2px', r.focusOutline)
  const glass = parse(r.panelBg)
  check('focus ring contrast >= 3', worst(parse(r.focusOutline.color).rgb, [glass]) >= 3, +worst(parse(r.focusOutline.color).rgb, [glass]).toFixed(2))
  // out of the rail: Tab -> Apple's first control, Shift+Tab -> its last; F6 both ways
  x('key', 'tab'); await sleep(500)
  const a1 = await onApple()
  check('Tab out of the rail -> Apple\'s first control', !!a1 && !(await onRail()), a1)
  x('key', 'shift+tab'); await sleep(500)
  check('Shift+Tab from Apple\'s first control -> the rail', await onRail())
  x('key', 'shift+tab'); await sleep(500)
  const a2 = await onApple()
  check('Shift+Tab out of the rail -> Apple\'s last control', !!a2 && a2 !== a1, a2)
  x('key', 'tab'); await sleep(500)
  check('Tab past Apple\'s last control -> the rail', await onRail())
  x('key', 'F6'); await sleep(500)
  const a3 = await onApple()
  check('F6 from the rail -> back to Apple (where focus was)', !!a3, a3)
  x('key', 'F6'); await sleep(500)
  check('F6 from Apple -> the rail', await onRail())
  // arrows, Home/End
  const order = []
  x('key', 'home'); await sleep(150); order.push((await v.rail.ev(RAIL_STATE)).focused)
  for (let i = 0; i < 6; i++) { x('key', 'down'); await sleep(120); order.push((await v.rail.ev(RAIL_STATE)).focused) }
  x('key', 'up'); await sleep(120); order.push((await v.rail.ev(RAIL_STATE)).focused)
  x('key', 'end'); await sleep(120); order.push((await v.rail.ev(RAIL_STATE)).focused)
  check('arrow keys move focus (Home, Down x6 wraps, Up, End)', JSON.stringify(order) === JSON.stringify(['lyrics', 'visualizer', 'mini', 'settings', 'pin', 'lock', 'lyrics', 'lock', 'lock']), order)
  x('key', 'esc'); await sleep(500)
  r = await v.rail.ev(RAIL_STATE)
  let L = await mp.ev(LAYOUT)
  check('Esc collapses (focus stays on the item, the rail view narrows again)', !r.open && r.focused === 'lock' && L.rail.width === 52, { open: r.open, focused: r.focused, railW: L.rail.width })
  x('key', 'home'); await sleep(500)
  r = await v.rail.ev(RAIL_STATE)
  check('an arrow/Home key after Esc opens it again', r.open && r.focused === 'lyrics')
  // Enter opens Lyrics; the item shows it (aria-pressed + active)
  x('key', 'enter')
  const lyricsOpen = await waitFor(async () => (await winTitles(mp)).includes('Sonata — Lyrics'))
  await sleep(500)
  r = await v.rail.ev(RAIL_STATE)
  const ly = r.rows.find((x) => x.id === 'lyrics')
  check('Enter on Lyrics opens the lyrics window', lyricsOpen)
  check('Lyrics shows its window open (aria-pressed=true, active)', ly.aria.pressed === 'true' && ly.active, ly.aria)
  check('keyboard activation leaves focus on the item', r.focused === 'lyrics', r.focused)
  await closeWin(mp, 'Sonata — Lyrics')
  await waitFor(async () => !(await winTitles(mp)).includes('Sonata — Lyrics'))
  await sleep(400)
  r = await v.rail.ev(RAIL_STATE)
  check('closing the lyrics window clears the mark', r.rows.find((x) => x.id === 'lyrics').aria.pressed === 'false')
  // Space on Settings (aria-current while open)
  x('move', 400, 300); x('key', 'F6'); await sleep(300)
  if (!(await onRail())) { x('key', 'F6'); await sleep(300) }
  await v.rail.ev('(() => { document.querySelector("[data-rail=settings]").focus({ focusVisible: true }); return true })()')
  x('key', 'space')
  const setOpen = await waitFor(async () => (await winTitles(mp)).includes('Sonata — Settings'))
  await sleep(400)
  r = await v.rail.ev(RAIL_STATE)
  check('Space on Settings opens Settings; aria-current=true', setOpen && r.rows.find((x) => x.id === 'settings').aria.current === 'true')
  await closeWin(mp, 'Sonata — Settings'); await sleep(500)
  // Ctrl+B from Apple's view and from the rail's view
  x('move', 400, 300); x('click', 600, 40); await sleep(300)
  x('key', 'ctrl+b'); await sleep(800)
  r = await v.rail.ev(RAIL_STATE); L = await mp.ev(LAYOUT)
  let saved = await mp.ev(settingsFile)
  check('Ctrl+B in Apple\'s view pins (views side by side, saved)', r.state.pinned && saved.railPinned === true && L.apple.width === W - M.railLayout(W, true).room && L.rail.x === L.apple.width, { apple: L.apple, rail: L.rail })
  x('key', 'F6'); await sleep(400)
  x('key', 'ctrl+b'); await sleep(800)
  r = await v.rail.ev(RAIL_STATE); saved = await mp.ev(settingsFile)
  check('Ctrl+B in the rail\'s view unpins (saved)', (await onRail()) && !r.state.pinned && saved.railPinned === false)
  check('pin item: aria-pressed + tooltip names Ctrl+B', r.rows.find((x) => x.id === 'pin').aria.pressed === 'false' && /Ctrl\+B/.test(r.rows.find((x) => x.id === 'pin').aria.title))
  // the lock by keyboard
  await v.rail.ev('(() => { document.querySelector("[data-rail=lyrics]").focus({ focusVisible: true }); return true })()')
  x('key', 'end'); await sleep(200)
  r = await v.rail.ev(RAIL_STATE)
  check('End reaches the lock (keyboard)', r.focused === 'lock')
  x('key', 'enter'); await sleep(900)
  r = await v.rail.ev(RAIL_STATE); saved = await mp.ev(settingsFile); L = await mp.ev(LAYOUT)
  check('Enter on the lock locks it (aria-pressed=true, saved), the view narrows', r.state.locked && saved.railLocked === true && r.rows.find((x) => x.id === 'lock').aria.pressed === 'true' && L.rail.width === 52, { locked: r.state.locked, railW: L.rail.width })
  check('locked: keyboard focus keeps it icons only, focus ring still shows', !r.open && r.view.focusVisible && r.focusOutline && r.focusOutline.style === 'solid', { open: r.open, ring: r.focusOutline })
  x('move', 300, 300); await sleep(200); x('move', W - 20, 30); await sleep(800)
  r = await v.rail.ev(RAIL_STATE); L = await mp.ev(LAYOUT)
  check('locked: hover no longer opens it (view stays 52)', !r.open && r.view.hover && L.rail.width === 52, { view: r.view, railW: L.rail.width })
  x('move', 300, 300); await sleep(200)
  x('key', 'ctrl+b'); await sleep(800)
  r = await v.rail.ev(RAIL_STATE); saved = await mp.ev(settingsFile)
  check('Ctrl+B while locked: pinned and unlocked (DS5 rule)', r.state.pinned && !r.state.locked && saved.railPinned === true && saved.railLocked === false)
  await setLocked(v, mp, true)
  r = await v.rail.ev(RAIL_STATE); saved = await mp.ev(settingsFile); L = await mp.ev(LAYOUT)
  check('locking while pinned unpins (click); Apple\'s view gets its room back', !r.state.pinned && r.state.locked && saved.railPinned === false && L.apple.width === W - 52)
  await setLocked(v, mp, false)
  x('move', 300, 300); await sleep(200); x('move', W - 20, 30); await sleep(900)
  r = await v.rail.ev(RAIL_STATE); L = await mp.ev(LAYOUT)
  check('unlocked: hover opens it again (view widens over Apple\'s, Apple\'s size unchanged)', !r.state.locked && r.open && L.rail.width === 196 && L.apple.width === W - 52, { rail: L.rail, apple: L.apple })
  x('move', 300, 300); await sleep(900)
  L = await mp.ev(LAYOUT)
  check('pointer leaves: the panel slides shut, then the view narrows to 52', L.rail.width === 52, L.rail)
  // ARIA
  r = await v.rail.ev(RAIL_STATE)
  check('nav has an accessible name', r.navLabel === 'Sonata')
  const btns = r.rows.filter((x) => x.button)
  check('every button has aria-label + tooltip', btns.every((b) => b.aria.label && b.aria.title), btns.map((b) => b.aria.label))
  check('toggles carry aria-pressed, Settings aria-current only when open', ['lyrics', 'visualizer', 'mini', 'pin', 'lock'].every((id) => ['true', 'false'].includes(btns.find((b) => b.id === id).aria.pressed)) && btns.find((b) => b.id === 'settings').aria.pressed === null)
  check('tooltips name the shortcuts', /Ctrl\+Shift\+L/.test(btns.find((b) => b.id === 'lyrics').aria.title) && /Ctrl\+Shift\+V/.test(btns.find((b) => b.id === 'visualizer').aria.title) && /Ctrl\+M/.test(btns.find((b) => b.id === 'mini').aria.title))
  check('aria-keyshortcuts set', btns.find((b) => b.id === 'lyrics').aria.keys === 'Control+Shift+L')
  const st = r.rows.filter((x) => !x.button)
  check('status lines: role=img with the state in words (never colour alone)', st.length === 3 && st.every((s) => s.aria.role === 'img' && /: /.test(s.aria.label)), st.map((s) => s.aria.label))
  // pointer: hover opens, a click picks and closes
  x('move', W - 20, 30); await sleep(900)
  r = await v.rail.ev(RAIL_STATE)
  check('hover opens the rail', r.open)
  x('click', W - 120, 139); await sleep(900)   // Settings row
  r = await v.rail.ev(RAIL_STATE); L = await mp.ev(LAYOUT)
  // closed at once; the view then narrows to 52, which leaves the pointer over Apple's page (no reopen)
  check('a pointer pick closes the rail at once and the view narrows', !r.open && L.rail.width === 52, { view: r.view, railW: L.rail.width })
  check('the pick ran its command (Settings opened)', await waitFor(async () => (await winTitles(mp)).includes('Sonata — Settings')))
  await closeWin(mp, 'Sonata — Settings'); await sleep(500)
  x('move', 300, 300); await sleep(600); x('move', W - 20, 101); await sleep(900)
  x('click', W - 120, 101)
  check('Mini Player from the rail opens the mini player', await waitFor(async () => (await winTitles(mp)).includes('Sonata — Mini Player')))
  await closeWin(mp, 'Sonata — Mini Player'); await sleep(900)
  x('move', 300, 300); await sleep(600)
  // reduced motion
  await v.rail.c.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] })
  await sleep(200)
  r = await v.rail.ev(RAIL_STATE)
  check('reduced motion: no transitions', r.transition.split(',').every((d) => parseFloat(d) === 0), r.transition)
  x('move', W - 20, 30); await sleep(600); x('move', 300, 300); await sleep(600)
  L = await mp.ev(LAYOUT)
  check('reduced motion: the view still narrows after closing (no transitionend needed)', L.rail.width === 52, L.rail)
  await v.rail.c.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] })
  // Apple's page can't reach the rail: no bridge, no model, no rail; its focus bridge only exists in its isolated world
  const leak = await v.apple.ev('[typeof window.sonataRailBridge, typeof window.__sonataRail, typeof window.SonataRailModel, typeof window.sonataFocusBridge, typeof window.__sonataFocus, typeof window.require, typeof window.process]')
  check('Apple\'s page sees no bridge, model, rail, require or process', leak.every((t) => t === 'undefined'), leak)
  const railNode = await v.rail.ev('[typeof window.require, typeof window.process, typeof window.sonataRailBridge]')
  check('rail page: no Node either (only the bridge)', railNode[0] === 'undefined' && railNode[1] === 'undefined' && railNode[2] === 'object', railNode)
  v.close(); mp.c.close()
}

async function railListeners(v) {
  let n = 0
  for (const e of ['globalThis.__sonataRail.panel', 'globalThis.__sonataRail.query', 'window', 'document']) {
    const id = await v.rail.object(e)
    n += (await v.rail.c.send('DOMDebugger.getEventListeners', { objectId: id })).listeners.length
  }
  return n
}
async function loops() {
  const v = await views()
  const mp = await mainProc()
  await setLocked(v, mp, false); await setPinned(v, false)
  const L0 = await mp.ev(LAYOUT)
  const W = L0.content.width
  const snap = async (tag) => {
    await v.rail.c.send('HeapProfiler.collectGarbage'); await v.apple.c.send('HeapProfiler.collectGarbage')
    return {
      tag,
      railDom: await v.rail.c.send('Memory.getDOMCounters'),
      appleDom: await v.apple.c.send('Memory.getDOMCounters'),
      rail: await v.rail.ev('globalThis.__sonataRail.counts()'),
      railListeners: await railListeners(v).catch((e) => 'n/a: ' + e.message),
      stops: await v.apple.iso('globalThis.__sonataFocus.counts()'),
      main: await mp.ev(MAIN_COUNTS)
    }
  }
  const rows = [await snap('start')]
  // 50x open/close Lyrics through the rail with real clicks (rail -> IPC -> main -> window -> state back),
  // plus untrusted clicks that must do nothing
  for (let i = 1; i <= 50; i++) {
    await v.rail.ev(`(document.querySelector('[data-rail=visualizer]').click(), true)`)
    x('move', W - 20, 30); await sleep(450)
    x('click', W - 30, 25); await sleep(300)
    x('move', 300, 300); await sleep(350); x('move', W - 20, 30); await sleep(450)
    x('click', W - 30, 25); await sleep(300)
    x('move', 300, 300); await sleep(350)
    if (i % 10 === 0) rows.push(await snap('openclose ' + i))
  }
  check('untrusted clicks never opened a window', !(await winTitles(mp)).includes('Sonata — Visualizer'))
  // 50x pin/unpin (Ctrl+B) and 50x hover open/close (the rail view widens and narrows)
  for (let i = 1; i <= 50; i++) {
    x('key', 'ctrl+b'); await sleep(250); x('key', 'ctrl+b'); await sleep(250)
    x('move', W - 20, 200); await sleep(400); x('move', 300, 300); await sleep(450)
    if (i % 10 === 0) rows.push(await snap('pin+hover ' + i))
  }
  const Lp = await mp.ev(LAYOUT)
  check('after 50 pin/unpin + hover cycles the views are back to unpinned/closed', Lp.apple.width === W - 52 && Lp.rail.width === 52, Lp)
  // 50x SPA navigation (Apple's own router)
  const links = ['/new', '/radio', '/browse', '/new']
  for (let i = 1; i <= 50; i++) {
    await v.apple.ev(`(() => { const a = [...document.querySelectorAll('a')].find((a) => (a.getAttribute('href') || '').endsWith('${links[i % links.length]}')); if (a) a.click(); return !!a })()`)
    await sleep(350)
    if (i % 10 === 0) rows.push(await snap('navigate ' + i))
  }
  // 5 reloads of Apple's page (new document: focus stops injected again; the rail view is untouched)
  for (let i = 1; i <= 5; i++) { await v.apple.c.send('Page.reload'); await sleep(6000) }
  rows.push(await snap('reload 5'))
  const first = rows[0]; const last = rows[rows.length - 1]
  check('main: two views, web contents count flat', rows.every((r) => r.main.children === 2 && r.main.webContents === first.main.webContents), rows.map((r) => r.main.webContents))
  check('main: IPC handler counts flat', rows.every((r) => JSON.stringify(r.main.ipc) === JSON.stringify(first.main.ipc)), last.main.ipc)
  check('main: window and view listener counts flat', rows.every((r) => JSON.stringify([r.main.apple, r.main.rail, r.main.win]) === JSON.stringify([first.main.apple, first.main.rail, first.main.win])), { apple: last.main.apple, rail: last.main.rail, win: last.main.win })
  check('main: active timers flat (+-2)', rows.every((r) => Math.abs(r.main.timers - first.main.timers) <= 2), rows.map((r) => r.main.timers))
  check('rail page: listeners flat (panel, media query, window, document)', rows.every((r) => r.railListeners === first.railListeners), rows.map((r) => r.railListeners))
  check('rail page: JS listeners, nodes and documents flat (after GC)', rows.every((r) => r.railDom.jsEventListeners === first.railDom.jsEventListeners && r.railDom.nodes === first.railDom.nodes && r.railDom.documents === first.railDom.documents), rows.map((r) => [r.railDom.jsEventListeners, r.railDom.nodes, r.railDom.documents].join('/')))
  check('Apple page: always exactly two focus stops, one observer', rows.every((r) => r.stops.stops === 2 && r.stops.observers === 1), rows.map((r) => r.stops.stops))
  const oc = rows.filter((r) => r.tag === 'start' || r.tag.startsWith('openclose') || r.tag.startsWith('pin+hover')).map((r) => r.appleDom.jsEventListeners)
  check('Apple page: JS listeners show no growth over open/close, pin and hover cycles (+-80, Apple\'s own churn)', Math.max(...oc) - Math.min(...oc) < 80, oc)
  results.push({ name: 'loop counts (table)', ok: true, detail: rows.map((r) => ({ tag: r.tag, railListeners: r.railListeners, railJs: r.railDom.jsEventListeners, railNodes: r.railDom.nodes, appleJs: r.appleDom.jsEventListeners, appleNodes: r.appleDom.nodes, stops: r.stops.stops, webContents: r.main.webContents, ipc: r.main.ipc['rail:command'], timers: r.main.timers })) })
  v.close(); mp.c.close()
}

async function perf() {
  const v = await views()
  const mp = await mainProc()
  const L0 = await mp.ev(LAYOUT)
  const W = L0.content.width
  await v.rail.c.send('Performance.enable'); await v.apple.c.send('Performance.enable')
  // frames: Chromium sends a screencast frame only when a view repaints
  const counters = { rail: 0, apple: 0 }
  for (const k of ['rail', 'apple']) v[k].c.on((m) => { if (m.method === 'Page.screencastFrame') { counters[k]++; v[k].c.send('Page.screencastFrameAck', { sessionId: m.params.sessionId }).catch(() => {}) } })
  const frames = async (tag, ms) => {
    for (const k of ['rail', 'apple']) await v[k].c.send('Page.startScreencast', { format: 'jpeg', quality: 10, everyNthFrame: 1 })
    await sleep(800); counters.rail = 0; counters.apple = 0
    await sleep(ms)
    for (const k of ['rail', 'apple']) await v[k].c.send('Page.stopScreencast')
    return { tag, railFrames: counters.rail, appleFrames: counters.apple }
  }
  const out = { idle: [] }
  x('move', W - 100, 20); await sleep(1500)
  out.idle.push(await frames('closed, idle 10 s', 10000))
  // hover open / close: the rail view widens and narrows (one layout of the rail page each, as its
  // viewport changes), the slide is transform-only; Apple's view does nothing
  const a0 = await v.apple.metrics(); const r0 = await v.rail.metrics()
  for (let i = 0; i < 10; i++) { x('move', W - 20, 20); await sleep(500); x('move', W - 100, 20); await sleep(600) }
  const a1 = await v.apple.metrics(); const r1 = await v.rail.metrics()
  out.hover = { cycles: 10, appleLayouts: a1.LayoutCount - a0.LayoutCount, railLayouts: r1.LayoutCount - r0.LayoutCount, railStyles: r1.RecalcStyleCount - r0.RecalcStyleCount }
  check('hover open/close x10: Apple\'s page does no layout; the rail lays out only on its view\'s 2 resizes per cycle', out.hover.appleLayouts === 0 && out.hover.railLayouts <= 2 * 10 + 2, out.hover)
  x('move', W - 20, 300); await sleep(1500)
  out.idle.push(await frames('open (hovered), resting 10 s', 10000))
  x('move', 300, 300); await sleep(1000)
  x('key', 'ctrl+b'); await sleep(1500)
  out.idle.push(await frames('pinned, idle 10 s', 10000))
  x('key', 'ctrl+b'); await sleep(800)
  check('idle: the rail view never repaints while resting (closed, open, pinned)', out.idle.every((f) => f.railFrames === 0), out.idle)
  const src = fs.readFileSync(path.join(__dirname, '..', 'rail-ui.js'), 'utf8').replace(/\/\/.*$/gm, '')
  check('rail-ui.js schedules nothing (no setTimeout/setInterval/requestAnimationFrame)', !/setTimeout|setInterval|requestAnimationFrame|requestIdleCallback/.test(src))
  results.push({ name: 'perf', ok: true, detail: out })
  v.close(); mp.c.close()
}

;(async () => {
  fs.mkdirSync(OUT, { recursive: true })
  if (phase === 'matrix') await matrix()
  else if (phase === 'keys') await keys()
  else if (phase === 'loops') await loops()
  else if (phase === 'perf') await perf()
  else throw new Error('phase: matrix | keys | loops | perf')
  const failed = results.filter((r) => !r.ok)
  console.log(JSON.stringify({ phase, label: LABEL, passed: results.length - failed.length, failed: failed.length, results }, null, 1))
  process.exit(failed.length ? 1 : 0)
})().catch((e) => {
  const failed = results.filter((r) => !r.ok)
  console.log(JSON.stringify({ phase, label: LABEL, crashed: e.stack || e.message, passed: results.length - failed.length, failed: failed.length + 1, results }, null, 1))
  process.exit(2)
})
