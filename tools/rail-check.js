#!/usr/bin/env node
// UI checks for the navigation rail, against a RUNNING ISOLATED Sonata (never the user's copy):
// a copy of `npm run dist`'s linux-unpacked in a scratch folder, throwaway HOME/XDG dirs, Xvfb,
// dbus-run-session, --password-store=basic, the window at x=0 y=0, started with
//   --remote-debugging-port=<cdp> --inspect=<insp>   (any free ports, not 9333 and not the user's)
// Real keyboard/pointer input goes through XTest on that Xvfb display (tools/xtest-input.py),
// so Ctrl+B / Ctrl+D take the same path as a person's keys (before-input-event).
//
//   node tools/rail-check.js <phase> --cdp 9471 --insp 9472 --display :87 --out DIR [--label 1100x760]
//   phases: matrix (pinned/unpinned x light/dark, screenshots + DOM asserts), keys (keyboard & a11y),
//           loops (50x open/close + navigate, listener/observer counts), perf (idle frames, layouts, CPU)
// Prints one JSON report and exits 1 if any assert failed.
//
// What this can't prove (the page is Apple's LOGGED-OUT web player, the only one that loads in
// isolation): logged-in views (Library, playlists, Apple's own lyrics/queue panels, full-screen
// player) are not measured; the generic overlap scan covers whatever is on screen.
'use strict'
const fs = require('fs')
const path = require('path')
const { execFileSync } = require('child_process')
const M = require('../rail-model')

const args = process.argv.slice(2)
const phase = args[0]
const opt = (name, def) => { const i = args.indexOf('--' + name); return i >= 0 ? args[i + 1] : def }
const CDP = Number(opt('cdp', 9471))
const INSP = Number(opt('insp', 9472))
const DISPLAY = opt('display', ':87')
const OUT = opt('out', '.')
const LABEL = opt('label', '')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const results = []
function check(name, ok, detail) { results.push({ name, ok: !!ok, detail }); return ok }

// --- input through XTest (real X events) ---
function x(...a) { execFileSync('python3', ['-I', path.join(__dirname, 'xtest-input.py'), DISPLAY, ...a.map(String)]) }

// --- a small CDP client ---
async function ws(url) {
  const sock = new WebSocket(url)
  await new Promise((r, j) => { sock.onopen = r; sock.onerror = j })
  let id = 0; const pend = new Map(); const subs = []
  sock.onmessage = (m) => {
    const d = JSON.parse(m.data)
    if (d.id && pend.has(d.id)) { pend.get(d.id)(d); pend.delete(d.id) } else for (const f of subs) f(d)
  }
  const send = (method, params = {}) => new Promise((r, j) => {
    const i = ++id
    pend.set(i, (d) => (d.error ? j(new Error(method + ': ' + JSON.stringify(d.error))) : r(d.result)))
    sock.send(JSON.stringify({ id: i, method, params }))
  })
  return { send, on: (f) => subs.push(f), close: () => sock.close() }
}
async function page() {
  let t
  for (let i = 0; i < 60 && !t; i++) {
    try { t = (await (await fetch(`http://127.0.0.1:${CDP}/json/list`)).json()).find((p) => p.type === 'page' && p.url.includes('music.apple.com')) } catch (e) {}
    if (!t) await sleep(500)
  }
  if (!t) throw new Error('main window not found on port ' + CDP)
  const c = await ws(t.webSocketDebuggerUrl)
  const ctxs = new Map()
  c.on((m) => {
    if (m.method === 'Runtime.executionContextCreated') ctxs.set(m.params.context.id, m.params.context)
    if (m.method === 'Runtime.executionContextDestroyed') ctxs.delete(m.params.executionContextId)
    if (m.method === 'Runtime.executionContextsCleared') ctxs.clear()
  })
  await c.send('Runtime.enable')
  await c.send('Page.enable')
  const evalIn = async (expression, contextId) => {
    const p = { expression, awaitPromise: true, returnByValue: true }
    if (contextId) p.contextId = contextId
    const r = await c.send('Runtime.evaluate', p)
    if (r.exceptionDetails) throw new Error('eval: ' + (r.exceptionDetails.exception ? r.exceptionDetails.exception.description : r.exceptionDetails.text))
    return r.result.value
  }
  // the rail's world: Electron's isolated context of the top frame
  const isoId = async () => {
    for (let i = 0; i < 40; i++) {
      for (const ctx of ctxs.values()) {
        if (ctx.auxData && !ctx.auxData.isDefault && ctx.auxData.frameId === t.id) {
          try { if (await evalIn('!!globalThis.__sonataRail', ctx.id)) return ctx.id } catch (e) {}
        }
      }
      await sleep(250)
    }
    throw new Error('rail isolated world not found')
  }
  return {
    c, target: t,
    main: (e) => evalIn(e),
    iso: async (e) => evalIn(e, await isoId()),
    isoObject: async (e) => { const r = await c.send('Runtime.evaluate', { expression: e, contextId: await isoId() }); return r.result.objectId },
    shot: async (file) => { const r = await c.send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(file, Buffer.from(r.data, 'base64')) },
    metrics: async () => Object.fromEntries((await c.send('Performance.getMetrics')).metrics.map((m) => [m.name, m.value]))
  }
}
async function mainProc() {
  const list = await (await fetch(`http://127.0.0.1:${INSP}/json/list`)).json()
  const c = await ws(list[0].webSocketDebuggerUrl)
  const ev = async (expression) => {
    const r = await c.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, includeCommandLineAPI: true })
    if (r.exceptionDetails) throw new Error('main eval: ' + JSON.stringify(r.exceptionDetails).slice(0, 300))
    return r.result.value
  }
  return { c, ev }
}
// counts in the main process that must stay flat
const MAIN_COUNTS = `(() => {
  const { ipcMain, BrowserWindow } = process.mainModule.require('electron')
  const win = BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().includes('music.apple.com'))
  const ch = ['rail:command', 'lyrics-command', 'mini-command', 'settings:set', 'settings:action', 'viz-close']
  return {
    ipc: Object.fromEntries(ch.map((n) => [n, ipcMain.listenerCount(n)])),
    wc: win ? Object.fromEntries(['dom-ready', 'did-navigate', 'before-input-event', 'page-title-updated', 'will-navigate'].map((n) => [n, win.webContents.listenerCount(n)])) : null,
    win: win ? Object.fromEntries(['resize', 'move', 'close', 'app-command'].map((n) => [n, win.listenerCount(n)])) : null,
    windows: BrowserWindow.getAllWindows().length,
    timers: process.getActiveResourcesInfo().filter((r) => r === 'Timeout').length
  }
})()`
const winTitles = (mp) => mp.ev(`process.mainModule.require('electron').BrowserWindow.getAllWindows().map((w) => w.getTitle())`)
const closeWin = (mp, title) => mp.ev(`(() => { const w = process.mainModule.require('electron').BrowserWindow.getAllWindows().find((w) => w.getTitle() === ${JSON.stringify(title)}); if (w) w.close(); return !!w })()`)
async function waitFor(fn, ms = 4000) { const end = Date.now() + ms; let v; while (Date.now() < end) { v = await fn(); if (v) return v; await sleep(100) } return v }

// --- what the rail and Apple's page look like right now (main world + isolated world) ---
const RAIL_STATE = `(() => {
  const R = globalThis.__sonataRail
  const vis = (r) => { const x1 = Math.max(0, r.left), x2 = Math.min(innerWidth, r.right), y1 = Math.max(0, r.top), y2 = Math.min(innerHeight, r.bottom); return { x: x1, y: y1, w: Math.max(0, x2 - x1), h: Math.max(0, y2 - y1), right: r.right, bottom: r.bottom } }
  const panel = R.panel
  const pr = panel.getBoundingClientRect()
  const nav = R.root.querySelector('.nav')
  const rows = [...R.root.querySelectorAll('.link, .status, .lockbtn')].map((b) => {
    const r = b.getBoundingClientRect(); const lab = b.querySelector('.label'); const cs = getComputedStyle(lab || b)
    const name = b.querySelector('.name') || lab
    const ic = b.querySelector('.ic')
    const icR = ic.getBoundingClientRect()
    // the dot's symbol: its glyph box must stay inside the dot (a wide fallback glyph would spill toward the words)
    const dot = b.querySelector('.dot')
    let glyphInside = null
    if (dot && dot.firstChild) {
      const rg = document.createRange(); rg.selectNodeContents(dot); const gr = rg.getBoundingClientRect(); const dr = dot.getBoundingClientRect()
      glyphInside = gr.left >= dr.left - 0.5 && gr.right <= dr.right + 0.5
    }
    return { id: b.dataset.rail || b.className, button: b.tagName === 'BUTTON', hasLabel: !!lab, vis: vis(r), rect: [r.left, r.top, r.width, r.height],
      icGap: lab ? lab.getBoundingClientRect().left - icR.right : null, icW: icR.width, glyphInside,
      iconColor: getComputedStyle(b).color,
      labelFits: !lab || (name.scrollWidth <= name.clientWidth + 0.5 && (!b.querySelector('.sub') || b.querySelector('.sub').scrollWidth <= b.querySelector('.sub').clientWidth + 0.5)),
      labelOpacity: lab ? cs.opacity : null, labelColor: cs.color, subColor: b.querySelector('.sub') ? getComputedStyle(b.querySelector('.sub')).color : null,
      bg: getComputedStyle(b).backgroundColor, active: b.classList.contains('active'),
      aria: { pressed: b.getAttribute('aria-pressed'), current: b.getAttribute('aria-current'), label: b.getAttribute('aria-label'), keys: b.getAttribute('aria-keyshortcuts'), title: b.getAttribute('title'), role: b.getAttribute('role'), tab: b.tabIndex } }
  })
  const pcs = getComputedStyle(panel)
  return { open: panel.classList.contains('open'), pinned: panel.classList.contains('pinned'), panel: vis(pr), transform: pcs.transform,
    panelBg: pcs.backgroundColor, panelColor: pcs.color, backdrop: pcs.backdropFilter, transition: pcs.transitionDuration,
    navOverflow: nav.scrollHeight - nav.clientHeight, rows, view: R.view(), state: R.state(), counts: R.counts(),
    focused: R.root.activeElement ? (R.root.activeElement.dataset.rail || R.root.activeElement.className) : null,
    focusOutline: R.root.activeElement ? (() => { const s = getComputedStyle(R.root.activeElement); return { style: s.outlineStyle, width: s.outlineWidth, color: s.outlineColor } })() : null,
    navLabel: panel.getAttribute('aria-label'), iw: innerWidth, ih: innerHeight }
})()`
const APPLE_STATE = `(() => {
  // Apple's elements: their VISIBLE box (clipped by every overflow-clipping ancestor), outermost first
  const clipOf = (el) => {
    let r = el.getBoundingClientRect(); let box = { l: r.left, t: r.top, r: r.right, b: r.bottom }
    for (let p = el.parentElement; p; p = p.parentElement) {
      const cs = getComputedStyle(p)
      if (cs.position === 'fixed') break
      if (cs.overflowX !== 'visible' || cs.overflowY !== 'visible' || cs.contain.includes('paint')) {
        const q = p.getBoundingClientRect()
        box = { l: Math.max(box.l, q.left), t: Math.max(box.t, q.top), r: Math.min(box.r, q.right), b: Math.min(box.b, q.bottom) }
      }
    }
    return box
  }
  let maxRight = 0; const offenders = []
  const walk = (root) => {
    for (const el of root.querySelectorAll('*')) {
      if (el.tagName === 'SONATA-RAIL') continue
      if (el.shadowRoot) walk(el.shadowRoot)
      const r = el.getBoundingClientRect()
      if (r.width < 1 || r.height < 1) continue
      const cs = getComputedStyle(el)
      if (cs.visibility === 'hidden' || cs.display === 'none' || +cs.opacity === 0) continue
      // full-window overlays (modal curtains) are allowed to span the window
      if (cs.position === 'fixed' && r.width >= innerWidth - 1 && r.height >= innerHeight - 1) continue
      const b = clipOf(el)
      if (b.r - b.l < 1 || b.b - b.t < 1) continue
      if (b.r > maxRight) maxRight = b.r
      if (b.r > innerWidth - 52 + 0.5 && offenders.length < 8) offenders.push(el.tagName.toLowerCase() + '.' + String(el.className).split(' ')[0] + '@' + Math.round(b.r))
    }
  }
  walk(document)
  const q = (s) => { const e = document.querySelector(s); if (!e) return null; const r = e.getBoundingClientRect(); return [Math.round(r.left), Math.round(r.top), Math.round(r.right), Math.round(r.bottom)] }
  const sp = document.querySelector('#scrollable-page')
  return { maxRight, offenders, playerBar: q('.player-bar'), page: q('#scrollable-page'), nav: q('.navigation'), upsell: q('.upsell-banner'),
    pageScrollbar: sp ? sp.offsetWidth - sp.clientWidth : null, htmlWidth: document.documentElement.getBoundingClientRect().width,
    hScroll: document.scrollingElement.scrollWidth > document.scrollingElement.clientWidth, hosts: document.querySelectorAll('sonata-rail').length,
    hostShadowVisible: document.querySelector('sonata-rail') ? document.querySelector('sonata-rail').shadowRoot : 'none',
    dark: matchMedia('(prefers-color-scheme: dark)').matches }
})()`

// --- colour maths (independent of rail-model.js, from computed styles) ---
const parse = (s) => { const m = /rgba?\(([^)]+)\)/.exec(s || ''); if (!m) return null; const p = m[1].split(/[ ,/]+/).filter(Boolean).map(Number); return { rgb: p.slice(0, 3), a: p.length > 3 ? p[3] : 1 } }
const lum = (rgb) => { const c = rgb.map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4 }); return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2] }
const ratio = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05) }
const lay = (base, layers) => layers.reduce((acc, l) => acc.map((v, i) => l.rgb[i] * l.a + v * (1 - l.a)), base)
const worst = (text, layers) => Math.min(ratio(text, lay([255, 255, 255], layers)), ratio(text, lay([0, 0, 0], layers)))

async function setTheme(p, dark) {
  for (let i = 0; i < 2; i++) {
    if ((await p.main('matchMedia("(prefers-color-scheme: dark)").matches')) === dark) return true
    x('move', 400, 300); x('key', 'ctrl+d'); await sleep(700)
  }
  return (await p.main('matchMedia("(prefers-color-scheme: dark)").matches')) === dark
}
// the lock is clicked for real (XTest): the rail ignores untrusted clicks
async function setLocked(p, locked) {
  for (let i = 0; i < 2; i++) {
    const s = await p.iso('globalThis.__sonataRail.state()')
    if (s && !!s.locked === locked) return true
    const r = await p.iso('(() => { const b = globalThis.__sonataRail.root.querySelector(".lockbtn").getBoundingClientRect(); return [b.left + b.width / 2, b.top + b.height / 2] })()')
    x('click', Math.round(r[0]), Math.round(r[1])); await sleep(700)
    x('move', 300, 300); await sleep(300)
  }
  const s = await p.iso('globalThis.__sonataRail.state()')
  return !!s.locked === locked
}
async function setPinned(p, pinned) {
  for (let i = 0; i < 2; i++) {
    const s = await p.iso('globalThis.__sonataRail.state()')
    if (s && !!s.pinned === pinned) return true
    x('move', 400, 300); x('key', 'ctrl+b'); await sleep(700)
  }
  const s = await p.iso('globalThis.__sonataRail.state()')
  return !!s.pinned === pinned
}

// --- phases ---
async function matrix() {
  const p = await page()
  const iw = await p.main('innerWidth'); const ih = await p.main('innerHeight')
  check(LABEL + ' window size', true, iw + 'x' + ih)
  for (const which of ['unpinned', 'pinned', 'locked']) {
    const pinned = which === 'pinned'
    const locked = which === 'locked'
    for (const dark of [false, true]) {
      const tag = `${LABEL}-${which}-${dark ? 'dark' : 'light'}`
      check(tag + ' theme set (Ctrl+D)', await setTheme(p, dark))
      if (locked) check(tag + ' lock set (click)', await setLocked(p, true))
      else { await setLocked(p, false); check(tag + ' pin set (Ctrl+B)', await setPinned(p, pinned)) }
      x('move', 300, Math.round(ih / 2)); await sleep(600)
      for (const hover of pinned ? [false] : [false, true]) {
        if (hover) { x('move', iw - 20, 60); await sleep(600) }
        const t = tag + (hover ? (locked ? '-hover' : '-open') : '')
        const r = await p.iso(RAIL_STATE)
        const a = await p.main(APPLE_STATE)
        await p.shot(path.join(OUT, t + '.png'))
        const mode = r.state.mode
        const room = M.railLayout(iw, pinned).room
        const shownW = r.open ? M.RAIL.expanded : M.RAIL.collapsed
        check(t + ' mode', mode === (pinned ? (iw - 196 >= 800 ? 'pinned' : 'floating') : 'collapsed'), mode)
        check(t + ' Apple page narrowed to the room', Math.abs(a.htmlWidth - (iw - room)) < 1, { html: a.htmlWidth, room })
        check(t + ' nothing of Apple reaches under the rail (clipped boxes)', a.maxRight <= iw - room + 0.5, { maxRight: a.maxRight, edge: iw - room, offenders: a.offenders })
        check(t + ' player bar clear of the rail', !a.playerBar || a.playerBar[2] <= iw - room, a.playerBar)
        check(t + ' scrolling page (and its scrollbar) clear of the rail', !a.page || a.page[2] <= iw - room, { page: a.page, scrollbar: a.pageScrollbar })
        check(t + ' no horizontal scroll', !a.hScroll)
        check(t + ' one host, shadow root closed', a.hosts === 1 && a.hostShadowVisible === null, { hosts: a.hosts })
        check(t + ' open state', locked ? !r.open : (r.open === (pinned ? mode === 'pinned' : hover) || (mode === 'floating' && r.open === hover)), { open: r.open, hover, locked })
        check(t + ' pin and lock never both on', !(r.state.pinned && r.state.locked), { pinned: r.state.pinned, locked: r.state.locked })
        const lk = r.rows.find((x) => x.id === 'lock')
        check(t + ' lock: aria-pressed matches, tooltip, inside the icon column', lk && lk.aria.pressed === String(locked) && /lock/i.test(lk.aria.title) && lk.vis.x >= r.panel.x - 0.5 && lk.vis.x + lk.vis.w <= r.panel.x + M.RAIL.collapsed + 0.5, lk && { pressed: lk.aria.pressed, vis: lk.vis })
        check(t + ' lock icon contrast >= 3 over glass', lk && worst(parse(lk.iconColor).rgb, [parse(r.panelBg)].concat(parse(lk.bg) && parse(lk.bg).a > 0 ? [parse(lk.bg)] : [])) >= 3)
        const labelled = r.rows.filter((x) => x.hasLabel)
        check(t + ' icon column never touches the words (gap >= 8 px, column 20 px, dot glyph inside the dot)', labelled.every((x) => x.icGap >= 8 && Math.abs(x.icW - 20) < 0.5 && x.glyphInside !== false), labelled.map((x) => x.id + ':' + (x.icGap === null ? '-' : x.icGap.toFixed(1)) + (x.glyphInside === false ? ' glyph-out' : '')).join(', '))
        check(t + ' rail shows its width at the right edge', Math.abs(r.panel.w - shownW) < 1 && Math.abs(r.panel.x + r.panel.w - iw) < 1 && r.panel.h === ih, r.panel)
        check(t + ' nothing clipped in the rail (rows inside the window and the panel, nav not overflowing)',
          r.navOverflow <= 0 && r.rows.every((x) => x.vis.bottom <= ih + 0.5 && x.rect[1] >= 0), { navOverflow: r.navOverflow, lowest: Math.max(...r.rows.map((x) => x.vis.bottom)), ih })
        const buttons = r.rows.filter((x) => x.button)
        check(t + ' hit targets >= 32 px (visible part)', buttons.every((b) => b.vis.w >= 32 && b.vis.h >= 32), buttons.map((b) => b.id + ' ' + Math.round(b.vis.w) + 'x' + Math.round(b.vis.h)).join(', '))
        if (r.open) check(t + ' labels fit (no ellipsis) and show', labelled.every((x) => x.labelFits && x.labelOpacity === '1'), labelled.filter((x) => !x.labelFits || x.labelOpacity !== '1').map((x) => x.id))
        else check(t + ' labels hidden while closed', labelled.every((x) => x.labelOpacity === '0'))
        // contrast over glass, worst case (glass over white or black), from computed colours
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
        check(t + ' label contrast >= 4.5 over glass (worst case)', Math.min(lowest.label, lowest.soft, lowest.active) >= 4.5, Object.fromEntries(Object.entries(lowest).map(([k, v]) => [k, +v.toFixed(2)])))
        check(t + ' glass follows the theme', (lum(glass.rgb) < 0.2) === dark && glass.a < 1 && /blur/.test(r.backdrop), { bg: r.panelBg, backdrop: r.backdrop })
        if (hover) { x('move', 300, Math.round(ih / 2)); await sleep(500) }
      }
    }
  }
  await setTheme(p, false); await setLocked(p, false); await setPinned(p, false)
  p.c.close()
}

async function keys() {
  const p = await page()
  const mp = await mainProc()
  await setTheme(p, false); await setPinned(p, false)
  const iw = await p.main('innerWidth'); const ih = await p.main('innerHeight')
  // Tab reaches the rail: it is the first Tab stop of the page (one stop, roving focus inside).
  // (a) Shift+Tab from Apple's first focusable element; (b) Tab from the top of a fresh page
  const onRail = () => p.main('!!document.activeElement && document.activeElement.tagName === "SONATA-RAIL"')
  const firstApple = await p.main(`(() => { const a = document.querySelector('.body-container a[href], .body-container button'); if (a) a.focus(); return a ? a.outerHTML.slice(0, 60) : null })()`)
  x('key', 'shift+tab'); await sleep(250)
  check('Shift+Tab from Apple\'s first element reaches the rail', await onRail(), firstApple)
  await p.c.send('Page.reload'); await sleep(7000)
  x('move', 300, 300)
  let tabs = 0; let reached = false
  for (; tabs < 6 && !reached; tabs++) { x('key', 'tab'); await sleep(150); reached = await onRail() }
  check('Tab from the top of the page reaches the rail', reached, { tabs })
  if (!reached) { x('key', 'shift+tab'); await sleep(150) }
  let r = await p.iso(RAIL_STATE)
  check('keyboard focus opens the rail (focus-visible)', r.open && r.view.focusVisible, r.view)
  check('Tab lands on one item (roving tabindex)', r.rows.filter((x) => x.button && x.aria.tab === 0).length === 1, r.focused)
  check('focus ring visible (2px solid)', r.focusOutline && r.focusOutline.style === 'solid' && r.focusOutline.width === '2px', r.focusOutline)
  const glass = parse(r.panelBg)
  check('focus ring contrast >= 3 over glass', worst(parse(r.focusOutline.color).rgb, [glass]) >= 3, +worst(parse(r.focusOutline.color).rgb, [glass]).toFixed(2))
  // arrows, Home/End
  const order = []
  x('key', 'home'); await sleep(150); order.push((await p.iso(RAIL_STATE)).focused)
  for (let i = 0; i < 6; i++) { x('key', 'down'); await sleep(120); order.push((await p.iso(RAIL_STATE)).focused) }
  x('key', 'up'); await sleep(120); order.push((await p.iso(RAIL_STATE)).focused)
  x('key', 'end'); await sleep(120); order.push((await p.iso(RAIL_STATE)).focused)
  check('arrow keys move focus (Home, Down x6 wraps, Up, End)', JSON.stringify(order) === JSON.stringify(['lyrics', 'visualizer', 'mini', 'settings', 'pin', 'lock', 'lyrics', 'lock', 'lock']), order)
  // Esc collapses, focus stays; an arrow opens again
  x('key', 'esc'); await sleep(300)
  r = await p.iso(RAIL_STATE)
  check('Esc collapses (focus stays on the item)', !r.open && r.focused === 'lock', { open: r.open, focused: r.focused })
  x('key', 'home'); await sleep(300)
  r = await p.iso(RAIL_STATE)
  check('an arrow/Home key after Esc opens it again', r.open && r.focused === 'lyrics')
  // Enter opens Lyrics; the item shows it (aria-pressed + active)
  x('key', 'enter')
  const lyricsOpen = await waitFor(async () => (await winTitles(mp)).includes('Sonata — Lyrics'))
  await sleep(400)
  r = await p.iso(RAIL_STATE)
  const ly = r.rows.find((x) => x.id === 'lyrics')
  check('Enter on Lyrics opens the lyrics window', lyricsOpen)
  check('Lyrics shows its window open (aria-pressed=true, active)', ly.aria.pressed === 'true' && ly.active, ly.aria)
  // the new window takes the keyboard (the main window blurs, so the rail closes); focus in the
  // main window stays on Lyrics, so coming back resumes there
  check('keyboard activation leaves focus on the item', r.focused === 'lyrics', r.focused)
  await closeWin(mp, 'Sonata — Lyrics')
  await waitFor(async () => !(await winTitles(mp)).includes('Sonata — Lyrics'))
  await sleep(400)
  r = await p.iso(RAIL_STATE)
  check('closing the lyrics window clears the mark', r.rows.find((x) => x.id === 'lyrics').aria.pressed === 'false')
  // Space on Settings opens it (aria-current while open)
  x('move', 400, 300); await sleep(200)
  await p.iso('(() => { const b = globalThis.__sonataRail.root.querySelector("[data-rail=settings]"); b.focus({ focusVisible: true }); return true })()')
  x('key', 'space')
  const setOpen = await waitFor(async () => (await winTitles(mp)).includes('Sonata — Settings'))
  await sleep(400)
  r = await p.iso(RAIL_STATE)
  check('Space on Settings opens Settings; aria-current=true', setOpen && r.rows.find((x) => x.id === 'settings').aria.current === 'true')
  await closeWin(mp, 'Sonata — Settings'); await sleep(500)
  // Ctrl+B pins and unpins, remembered in settings.json
  x('move', 400, 300); x('key', 'ctrl+b'); await sleep(700)
  r = await p.iso(RAIL_STATE)
  const html1 = await p.main('document.documentElement.getBoundingClientRect().width')
  const saved1 = await mp.ev(`JSON.parse(require('fs').readFileSync(require('path').join(process.mainModule.require('electron').app.getPath('userData'), 'settings.json'), 'utf8')).railPinned`)
  check('Ctrl+B pins (state, room, saved in settings)', r.state.pinned && saved1 === true && Math.abs(html1 - (iw - M.railLayout(iw, true).room)) < 1, { mode: r.state.mode, html: html1, saved: saved1 })
  check('pin item: aria-pressed=true + tooltip names Ctrl+B', r.rows.find((x) => x.id === 'pin').aria.pressed === 'true' && /Ctrl\+B/.test(r.rows.find((x) => x.id === 'pin').aria.title))
  x('key', 'ctrl+b'); await sleep(700)
  r = await p.iso(RAIL_STATE)
  const saved2 = await mp.ev(`JSON.parse(require('fs').readFileSync(require('path').join(process.mainModule.require('electron').app.getPath('userData'), 'settings.json'), 'utf8')).railPinned`)
  check('Ctrl+B again unpins (saved)', !r.state.pinned && saved2 === false)
  // the lock: keyboard (focus it with arrows, Enter locks), then the rail stays small for pointer and keyboard
  const settingsFile = `JSON.parse(require('fs').readFileSync(require('path').join(process.mainModule.require('electron').app.getPath('userData'), 'settings.json'), 'utf8'))`
  x('move', 400, 300); await sleep(200)
  await p.iso('(() => { globalThis.__sonataRail.root.querySelector("[data-rail=lyrics]").focus({ focusVisible: true }); return true })()')
  x('key', 'end'); await sleep(200)
  r = await p.iso(RAIL_STATE)
  check('End reaches the lock (keyboard)', r.focused === 'lock')
  x('key', 'enter'); await sleep(700)
  r = await p.iso(RAIL_STATE)
  let saved = await mp.ev(settingsFile)
  check('Enter on the lock locks it (aria-pressed=true, saved railLocked)', r.state.locked && saved.railLocked === true && r.rows.find((x) => x.id === 'lock').aria.pressed === 'true', { locked: r.state.locked, saved: saved.railLocked })
  check('locked: keyboard focus keeps it icons only, focus ring still shows', !r.open && r.view.focusVisible && r.focusOutline && r.focusOutline.style === 'solid', { open: r.open, view: r.view, ring: r.focusOutline })
  x('key', 'home'); await sleep(200)
  r = await p.iso(RAIL_STATE)
  check('locked: arrows still move focus, rail stays small', r.focused === 'lyrics' && !r.open)
  x('move', 300, 300); await sleep(200); x('move', iw - 20, 30); await sleep(600)
  r = await p.iso(RAIL_STATE)
  check('locked: hover no longer opens it', !r.open && r.view.hover, r.view)
  x('move', 300, 300); await sleep(200)
  // Ctrl+B while locked pins and unlocks; locking while pinned unpins
  x('key', 'ctrl+b'); await sleep(700)
  r = await p.iso(RAIL_STATE); saved = await mp.ev(settingsFile)
  check('Ctrl+B while locked: pinned and unlocked (DS5 rule), both saved', r.state.pinned && !r.state.locked && saved.railPinned === true && saved.railLocked === false, { pinned: r.state.pinned, locked: r.state.locked })
  await setLocked(p, true)
  r = await p.iso(RAIL_STATE); saved = await mp.ev(settingsFile)
  check('locking while pinned unpins (click), both saved', !r.state.pinned && r.state.locked && saved.railPinned === false && saved.railLocked === true && Math.abs((await p.main('document.documentElement.getBoundingClientRect().width')) - (iw - M.RAIL.collapsed)) < 1)
  await setLocked(p, false)
  x('move', 300, 300); await sleep(200); x('move', iw - 20, 30); await sleep(600)
  r = await p.iso(RAIL_STATE)
  check('unlocked (click again): hover opens it again', !r.state.locked && r.open)
  x('move', 300, 300); await sleep(300)
  // ARIA
  check('nav has an accessible name', r.navLabel === 'Sonata')
  const btns = r.rows.filter((x) => x.button)
  check('every button has aria-label + tooltip', btns.every((b) => b.aria.label && b.aria.title), btns.map((b) => b.aria.label))
  check('toggles carry aria-pressed, Settings aria-current only when open', ['lyrics', 'visualizer', 'mini', 'pin', 'lock'].every((id) => ['true', 'false'].includes(btns.find((b) => b.id === id).aria.pressed)) && btns.find((b) => b.id === 'settings').aria.pressed === null)
  check('tooltips name the shortcuts', /Ctrl\+Shift\+L/.test(btns.find((b) => b.id === 'lyrics').aria.title) && /Ctrl\+Shift\+V/.test(btns.find((b) => b.id === 'visualizer').aria.title) && /Ctrl\+M/.test(btns.find((b) => b.id === 'mini').aria.title))
  check('aria-keyshortcuts set', btns.find((b) => b.id === 'lyrics').aria.keys === 'Control+Shift+L')
  const st = r.rows.filter((x) => !x.button)
  check('status lines: role=img with the state in words (never colour alone)', st.length === 3 && st.every((s) => s.aria.role === 'img' && /: /.test(s.aria.label)), st.map((s) => s.aria.label))
  // pointer: hover opens, a click picks and closes, leaving and coming back opens again
  x('move', 300, 300); await sleep(300)
  x('move', iw - 20, 30); await sleep(500)
  r = await p.iso(RAIL_STATE)
  check('hover opens the rail', r.open)
  // Settings row (4th item: 8 + 3*38 + 18); its window opens away from the pointer, the main
  // window stays (Mini Player would hide it)
  x('click', iw - 120, 139); await sleep(800)
  r = await p.iso(RAIL_STATE)
  check('a pointer pick closes the rail at once (pointer still on it)', !r.open && r.view.picked && r.view.hover, r.view)
  const setOpen2 = await waitFor(async () => (await winTitles(mp)).includes('Sonata — Settings'))
  check('the pick ran its command (Settings opened)', setOpen2)
  await closeWin(mp, 'Sonata — Settings'); await sleep(500)
  // Mini Player through the rail: the main window hides, the mini player opens; closing it brings the main window back
  x('move', 300, 300); await sleep(300); x('move', iw - 20, 101); await sleep(500)   // reopen it (the pick closed it)
  x('click', iw - 120, 101)
  const miniOpen = await waitFor(async () => (await winTitles(mp)).includes('Sonata — Mini Player'))
  check('Mini Player from the rail opens the mini player', miniOpen)
  await closeWin(mp, 'Sonata — Mini Player'); await sleep(800)
  x('move', 300, 300); await sleep(300); x('move', iw - 20, 30); await sleep(500)
  r = await p.iso(RAIL_STATE)
  check('leaving and coming back opens it again', r.open && !r.view.picked)
  x('move', 300, 300); await sleep(300)
  // reduced motion
  await p.c.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] })
  await sleep(200)
  r = await p.iso(RAIL_STATE)
  check('reduced motion: no transitions', r.transition.split(',').every((d) => parseFloat(d) === 0), r.transition)
  await p.c.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] })
  // a page script can't drive the rail: synthetic click on the host, and the isolated globals are not visible
  const titlesBefore = (await winTitles(mp)).length
  const leak = await p.main('(() => { const h = document.querySelector("sonata-rail"); h.click(); h.dispatchEvent(new MouseEvent("click", { bubbles: true, composed: true })); return [typeof window.sonataRailBridge, typeof window.__sonataRail, typeof window.SonataRailModel, h.shadowRoot] })()')
  await sleep(500)
  check('Apple\'s world sees no bridge/model/root, synthetic clicks do nothing', leak[0] === 'undefined' && leak[1] === 'undefined' && leak[2] === 'undefined' && leak[3] === null && (await winTitles(mp)).length === titlesBefore, leak)
  p.c.close(); mp.c.close()
}

async function listeners(p) {
  const ids = [await p.isoObject('globalThis.__sonataRail.panel'), await p.isoObject('globalThis.__sonataRail.host'), await p.isoObject('globalThis.__sonataRail.query')]
  let n = 0
  for (const id of ids) n += (await p.c.send('DOMDebugger.getEventListeners', { objectId: id })).listeners.length
  return n
}
async function loops() {
  const p = await page()
  const mp = await mainProc()
  await setPinned(p, false)
  const iw = await p.main('innerWidth')
  await p.c.send('Performance.enable')
  const snap = async (tag) => ({
    tag,
    gc: await p.c.send('HeapProfiler.collectGarbage'),
    dom: await p.c.send('Memory.getDOMCounters'),
    rail: await p.iso('globalThis.__sonataRail.counts()'),
    railListenersOnPanel: await listeners(p).catch((e) => 'n/a: ' + e.message),
    main: await mp.ev(MAIN_COUNTS)
  })
  const rows = [await snap('start')]
  // 50x open/close Lyrics, Visualizer and Mini Player through the rail (rail -> IPC -> main -> window -> state back)
  for (let i = 1; i <= 50; i++) {
    for (const id of ['lyrics', 'visualizer']) {
      await p.iso(`globalThis.__sonataRail.root.querySelector('[data-rail=${id}]').click()`)   // isTrusted false: must be ignored
    }
    x('move', iw - 20, 30)
    x('click', iw - 30, 25); await sleep(250)    // Lyrics (real click)
    x('move', 300, 300); x('move', iw - 20, 30)
    x('click', iw - 30, 25); await sleep(250)    // Lyrics again: closes
    x('move', 300, 300)
    if (i % 10 === 0) rows.push(await snap('openclose ' + i))
  }
  check('synthetic (untrusted) clicks never opened a window', !(await winTitles(mp)).includes('Sonata — Visualizer'))
  // 50x SPA navigation (Apple's own router: clicking its sidebar links)
  const links = ['/new', '/radio', '/browse', '/new']
  for (let i = 1; i <= 50; i++) {
    const href = links[i % links.length]
    await p.main(`(() => { const a = [...document.querySelectorAll('a')].find((a) => (a.getAttribute('href') || '').endsWith('${href}')); if (a) a.click(); return !!a })()`)
    await sleep(350)
    if (i % 10 === 0) rows.push(await snap('navigate ' + i))
  }
  // Apple removing the host, then replacing <body> (as a re-render could): the rail comes back, still one
  const before = await p.iso('globalThis.__sonataRail.counts()')
  await p.main('document.querySelector("sonata-rail").remove(), true'); await sleep(200)
  const afterRemove = await p.iso('globalThis.__sonataRail.counts()')
  check('host removed by the page -> re-attached at once (one host)', afterRemove.hosts === 1 && afterRemove.reattached === before.reattached + 1, { before, afterRemove })
  await p.main('(() => { const b = document.createElement("body"); b.append(...[...document.body.childNodes].filter((n) => n.nodeName !== "SONATA-RAIL")); document.body.replaceWith(b); return true })()'); await sleep(200)
  const afterBody = await p.iso('globalThis.__sonataRail.counts()')
  check('<body> replaced -> rail moves to the new body, observer re-bound (still one observer)', afterBody.hosts === 1 && afterBody.observerRebinds === before.observerRebinds + 1 && await p.main('document.body.firstElementChild.tagName === "SONATA-RAIL"'), afterBody)
  // 5 reloads (a new document each time: the rail is injected and mounted again)
  for (let i = 1; i <= 5; i++) {
    await p.c.send('Page.reload')
    await sleep(6000)
  }
  rows.push(await snap('reload 5'))
  const first = rows[0]; const last = rows[rows.length - 1]
  const mid = rows.find((r) => r.tag === 'navigate 50')
  check('rail: exactly one host throughout', rows.every((r) => r.rail.hosts === 1), rows.map((r) => r.rail.hosts))
  check('rail listeners on its nodes + media query flat', rows.every((r) => r.railListenersOnPanel === first.railListenersOnPanel), rows.map((r) => r.railListenersOnPanel))
  check('rail: one MutationObserver (by construction), re-bound only on a new <body>', rows.every((r) => r.rail.observers === 1), rows.map((r) => r.rail.observerRebinds))
  check('main: IPC handler counts flat', rows.every((r) => JSON.stringify(r.main.ipc) === JSON.stringify(first.main.ipc)), last.main.ipc)
  check('main: main-window listener counts flat', rows.every((r) => JSON.stringify(r.main.wc) === JSON.stringify(first.main.wc) && JSON.stringify(r.main.win) === JSON.stringify(first.main.win)), last.main)
  check('main: active timers flat (+-2: the lyrics/mini polls and debounces come and go)', rows.every((r) => Math.abs(r.main.timers - first.main.timers) <= 2), rows.map((r) => r.main.timers))
  // Apple's own page adds and drops listeners as it works (+-50 around a level); no steady growth per cycle
  const oc = rows.filter((r) => r.tag === 'start' || r.tag.startsWith('openclose')).map((r) => r.dom.jsEventListeners)
  check('renderer: JS listeners (whole page, Apple included) show no steady growth over 50 open/close', Math.max(...oc) - Math.min(...oc) < 80 && oc[oc.length - 1] - oc[0] < 50, oc)
  check('renderer: documents settle at 2 after GC (no leaked documents)', rows.slice(1).every((r) => r.dom.documents <= 2), rows.map((r) => r.dom.documents))
  results.push({ name: 'loop counts (table)', ok: true, detail: rows.map((r) => ({ tag: r.tag, docs: r.dom.documents, nodes: r.dom.nodes, jsListeners: r.dom.jsEventListeners, railListeners: r.railListenersOnPanel, hosts: r.rail.hosts, rebinds: r.rail.observerRebinds, reattached: r.rail.reattached, ipc: r.main.ipc['rail:command'], wcDomReady: r.main.wc && r.main.wc['dom-ready'], winResize: r.main.win && r.main.win.resize, timers: r.main.timers })) })
  void mid
  p.c.close(); mp.c.close()
}

async function perf() {
  const p = await page()
  await p.c.send('Performance.enable')
  const iw = await p.main('innerWidth')
  const hasRail = await p.main('!!document.querySelector("sonata-rail")')
  // frames: Chromium sends a screencast frame only when the page repaints
  let frames = 0
  p.c.on((m) => { if (m.method === 'Page.screencastFrame') { frames++; p.c.send('Page.screencastFrameAck', { sessionId: m.params.sessionId }).catch(() => {}) } })
  const idle = async (tag, ms) => {
    x('move', 300, 300); await sleep(1500)
    await p.c.send('Page.startScreencast', { format: 'jpeg', quality: 10, everyNthFrame: 1 }); await sleep(800)
    frames = 0
    const m0 = await p.metrics()
    await sleep(ms)
    const m1 = await p.metrics()
    await p.c.send('Page.stopScreencast')
    return { tag, frames, layouts: m1.LayoutCount - m0.LayoutCount, styles: m1.RecalcStyleCount - m0.RecalcStyleCount, scriptMs: Math.round((m1.ScriptDuration - m0.ScriptDuration) * 1000), taskMs: Math.round((m1.TaskDuration - m0.TaskDuration) * 1000) }
  }
  const out = { hasRail, idle: [] }
  out.idle.push(await idle('idle 10 s', 10000))
  if (hasRail) {
    // hover open / close: only transform + opacity change, so no layout. The pointer starts on a
    // quiet strip of Apple's page (y=20, its header row: no hover effects there); crossing Apple's
    // cards would run Apple's own hover effects (~10 layouts per crossing, measured without the rail)
    x('move', iw - 100, 20); await sleep(1500)
    const m0 = await p.metrics()
    for (let i = 0; i < 10; i++) { x('move', iw - 20, 20); await sleep(400); x('move', iw - 100, 20); await sleep(400) }
    const m1 = await p.metrics()
    // control: the same number of moves, over Apple's page only
    for (let i = 0; i < 10; i++) { x('move', iw - 120, 20); await sleep(400); x('move', iw - 100, 20); await sleep(400) }
    const m2 = await p.metrics()
    out.hover = { crossings: 20, layoutsRail: m1.LayoutCount - m0.LayoutCount, layoutsControl: m2.LayoutCount - m1.LayoutCount, stylesRail: m1.RecalcStyleCount - m0.RecalcStyleCount, stylesControl: m2.RecalcStyleCount - m1.RecalcStyleCount }
    check('hover open/close: at most 1 layout per 4 crossings (transform/opacity only, no per-frame layout)', out.hover.layoutsRail <= 5, out.hover)
    // open and resting: no frames
    x('move', iw - 20, 300); await sleep(1500)
    await p.c.send('Page.startScreencast', { format: 'jpeg', quality: 10, everyNthFrame: 1 }); await sleep(800)
    frames = 0; await sleep(10000); out.idle.push({ tag: 'open (hovered), resting 10 s', frames })
    await p.c.send('Page.stopScreencast')
    x('move', 300, 300)
    // the rail's own code: no timers or animation frames at all
    const src = fs.readFileSync(path.join(__dirname, '..', 'rail-ui.js'), 'utf8').replace(/\/\/.*$/gm, '')
    check('rail-ui.js schedules nothing (no setTimeout/setInterval/requestAnimationFrame)', !/setTimeout|setInterval|requestAnimationFrame|requestIdleCallback/.test(src))
  }
  results.push({ name: 'perf', ok: true, detail: out })
  p.c.close()
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
})().catch((e) => { console.error(e.stack || e.message); process.exit(2) })
