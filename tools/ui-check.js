#!/usr/bin/env node
// UI checks for the main window (Apple's page, the side panel, the rail, toasts), the mini player and
// the lyrics window, against a RUNNING ISOLATED Sonata (never the user's copy): the packaged build in a
// scratch folder, throwaway HOME/XDG, Xvfb, dbus-run-session, --password-store=basic, started outside
// any IDE sandbox (systemd-run --user) with --remote-debugging-port=<cdp> --inspect=<insp>, and ended
// with app.exit(0) through the inspector (never SIGTERM: Electron answers it with a core dump).
// SONATA_TEST_ARTWORK=tools/worst-artwork.png gives the album tint and the Glass backdrop a worst-case
// picture (hard black/white stripes and saturated primaries), since the checks run logged out.
//
//   node tools/ui-check.js <phase> --cdp 9481 --insp 9482 --display :87 --out DIR [--label 1100x760]
//   phases: matrix (light/dark x rail pinned/unpinned x panel hidden/shown, Settings and About with every
//           section open; docked or drawer by width), keys (Tab/F6 across the views, accordion keys, Esc,
//           the ⋮ menu), loops (50 panel show/hide, 50 pin cycles, 50 navigations: counts flat),
//           perf (idle repaints and CPU), mini (the mini player, run with --mini), lyrics (the lyrics
//           window's words over a dark and a light album, both schemes; the sung line's every word >= 4.5:1 in
//           light/dark x album colour on/off x Glass on/off)
// Prints one JSON report and exits 1 if any check failed.
'use strict'
const fs = require('fs')
const path = require('path')
const { createKit, parse, lum, ratio, lay } = require('./cdp-lib')
const P = require('../panel-model')

const args = process.argv.slice(2)
const phase = args[0]
const opt = (name, def) => { const i = args.indexOf('--' + name); return i >= 0 ? args[i + 1] : def }
const CDP = Number(opt('cdp', 9481))
const INSP = Number(opt('insp', 9482))
const DISPLAY = opt('display', ':87')
const OUT = opt('out', '.')
const LABEL = opt('label', '')
const { sleep, x, xshot, target, mainProc, waitFor } = createKit({ cdp: CDP, insp: INSP, display: DISPLAY })
const results = []
function check(name, ok, detail) { results.push({ name, ok: !!ok, detail }); return ok }
const E = "process.mainModule.require('electron')"

// --- the main window's views, from the main process ---
const LAYOUT = `(() => {
  const { BaseWindow } = ${E}
  const w = BaseWindow.getAllWindows().find((w) => w.contentView && w.contentView.children.length >= 2)
  const by = (part) => w.contentView.children.find((v) => v.webContents.getURL().includes(part))
  const b = (v) => (v ? Object.assign(v.getBounds(), { visible: v.getVisible ? v.getVisible() : true }) : null)
  return { content: w.getContentBounds(), apple: b(by('music.apple.com')), rail: b(by('rail.html')), panel: b(by('panel.html')), toast: b(by('toast.html')), order: w.contentView.children.map((v) => v.webContents.getURL().split('/').pop().slice(0, 20)) }
})()`
// send a command as that view would (the same ipcMain handler and its checks)
const viewCommand = (view, command, ...a) => `(() => {
  const { BaseWindow, ipcMain } = ${E}
  const w = BaseWindow.getAllWindows().find((w) => w.contentView && w.contentView.children.length >= 2)   // the main window, not a BrowserWindow
  const v = w.contentView.children.find((v) => v.webContents.getURL().includes('${view}.html'))
  if (!v) return false
  ipcMain.emit('${view}:command', { sender: v.webContents, senderFrame: { parent: null } }, ${[JSON.stringify(command), ...a.map((v) => JSON.stringify(v))].join(', ')})
  return true
})()`
const MAIN_COUNTS = `(() => {
  const { ipcMain, BaseWindow, webContents } = ${E}
  const win = BaseWindow.getAllWindows().find((w) => w.contentView && w.contentView.children.length >= 2)
  const ch = ['rail:command', 'rail:focus-in', 'panel:command', 'apple:volume', 'lyrics-command', 'mini-command', 'viz-close']
  return {
    ipc: Object.fromEntries(ch.map((n) => [n, ipcMain.listenerCount(n)])),
    win: Object.fromEntries(['resize', 'move', 'close', 'closed', 'focus', 'enter-full-screen', 'leave-full-screen'].map((n) => [n, win.listenerCount(n)])),
    views: Object.fromEntries(win.contentView.children.map((v) => [/music\.apple\.com/.test(v.webContents.getURL()) ? 'apple' : v.webContents.getURL().split('/').pop(), ['before-input-event', 'focus', 'did-start-loading', 'will-navigate', 'dom-ready', 'did-navigate', 'page-title-updated'].reduce((a, n) => a + v.webContents.listenerCount(n), 0)])),
    children: win.contentView.children.length,
    webContents: webContents.getAllWebContents().length,
    timers: process.getActiveResourcesInfo().filter((x) => x === 'Timeout').length,
    windows: BaseWindow.getAllWindows().map((w) => w.getTitle())
  }
})()`
const settingsFile = `JSON.parse(require('fs').readFileSync(require('path').join(${E}.app.getPath('userData'), 'settings.json'), 'utf8'))`

// --- colour: the worst contrast of a text colour over its layers, over the darkest and lightest
// pixel of the Glass backdrop (read from the image the page shows) or over white and black ---
// text: { rgb, a } (a < 1: a translucent or faded text, blended over what it sits on)
const worstOver = (text, layers, backdrops) => Math.min(...backdrops.map((b) => { const under = lay(b, layers); return ratio(text.a < 1 ? lay(under, [text]) : text.rgb, under) }))

// In a page: every visible text and control of `rootSel`, with its colour, its background layers
// (bottom first, from the surface down to it), its box and its accessible name. The Glass backdrop's
// extreme pixels come from decoding the shown image on a canvas (independent of theme.js).
const PAGE_AUDIT = (rootSel) => `(async () => {
  const root = document.querySelector(${JSON.stringify(rootSel)})
  const vis = (el) => { const r = el.getBoundingClientRect(); const cs = getComputedStyle(el); return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none' && +cs.opacity !== 0 && !el.closest('[hidden]') }
  const bg = (el) => { const c = getComputedStyle(el).backgroundColor; return c && c !== 'rgba(0, 0, 0, 0)' && c !== 'transparent' ? c : null }
  const layersOf = (el) => {
    const chain = []
    for (let e = el; e && e !== root.parentElement; e = e.parentElement) chain.unshift(e)
    const out = []
    for (const e of chain) {
      if (e === root && root.classList.contains('glass-on')) { const t = root.querySelector(':scope > .s-tint'); if (t && bg(t)) out.push(bg(t)); continue }
      const b = bg(e); if (b) out.push(b)
    }
    return out
  }
  // the Glass backdrop's darkest and lightest pixel
  let backdrop = null
  const on = root.querySelector(':scope > .s-bd.on')
  if (root.classList.contains('glass-on') && on) {
    const url = /url\\("?(.*?)"?\\)$/.exec(getComputedStyle(on).backgroundImage)
    if (url) {
      const img = new Image(); img.src = url[1]; await img.decode()
      const c = document.createElement('canvas'); c.width = img.width; c.height = img.height
      const g = c.getContext('2d'); g.drawImage(img, 0, 0)
      const d = g.getImageData(0, 0, c.width, c.height).data
      const L = (r, gg, b) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4 }; return 0.2126 * f(r) + 0.7152 * f(gg) + 0.0722 * f(b) }
      let lo = [9, null], hi = [-1, null]
      for (let i = 0; i < d.length; i += 4) { const l = L(d[i], d[i + 1], d[i + 2]); if (l < lo[0]) lo = [l, [d[i], d[i + 1], d[i + 2]]]; if (l > hi[0]) hi = [l, [d[i], d[i + 1], d[i + 2]]] }
      backdrop = [lo[1], hi[1]]
    }
  }
  const texts = []
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (!n.textContent.trim()) continue
    const el = n.parentElement
    if (!vis(el) || el.closest('svg')) continue
    const r = el.getBoundingClientRect()
    const cs = getComputedStyle(el)
    // the text's own colour with every opacity up to the root folded into its alpha (an element faded
    // with opacity reads as faded as a translucent colour; 0.15.37: the sung line's upcoming words)
    let op = 1
    for (let e = el; e && e !== root.parentElement; e = e.parentElement) op *= +getComputedStyle(e).opacity
    if (op < 0.1) continue   // faded out by an ancestor (the mini player's title under its scrubber): not shown
    const color = op < 1 ? cs.color.replace(/rgba?\\(([^)]+)\\)/, (m, a) => { const p = a.split(/[ ,/]+/).filter(Boolean).map(Number); return 'rgba(' + p.slice(0, 3).join(', ') + ', ' + ((p.length > 3 ? p[3] : 1) * op) + ')' }) : cs.color
    texts.push({ text: n.textContent.trim().slice(0, 40), color, layers: layersOf(el), size: parseFloat(cs.fontSize), weight: +cs.fontWeight, dim: !!el.closest('.line:not(.active)') || !!el.closest('.bgv'), activeLine: !!el.closest('.line.active') && !el.closest('.bgv'), op,
      fits: el.scrollWidth <= el.clientWidth + 1 || cs.textOverflow === 'ellipsis' || cs.display === 'inline', clipped: cs.textOverflow === 'ellipsis' && el.scrollWidth > el.clientWidth + 1, cls: el.className && String(el.className).slice(0, 30),
      rect: [r.left, r.top, r.right, r.bottom] })
  }
  const controls = [...root.querySelectorAll('button, select, input, a[href], [role=switch], [role=slider], [role=button], [tabindex="0"]')].filter(vis).map((el) => {
    const r = el.getBoundingClientRect()
    let name = el.getAttribute('aria-label') || ''
    if (!name && el.getAttribute('aria-labelledby')) name = el.getAttribute('aria-labelledby').split(' ').map((id) => (document.getElementById(id) || {}).textContent || '').join(' ').trim()
    if (!name) name = (el.textContent || '').trim() || el.getAttribute('title') || ''
    const inline = el.tagName === 'A' && getComputedStyle(el).display === 'inline' && !!el.closest('p, li, dd, dt')
    const sec = el.closest('[data-section]')
    return { tag: el.tagName, id: el.id || el.dataset.key || el.dataset.rail || el.className.toString().slice(0, 24), name: name.slice(0, 40), w: r.width, h: r.height, inline, disabled: !!el.disabled, section: sec ? sec.dataset.section : (el.closest('.head') ? 'header' : ''), rect: [r.left, r.top, r.right, r.bottom] }
  })
  const rr = root.getBoundingClientRect()
  return { texts, controls, backdrop, root: [rr.left, rr.top, rr.right, rr.bottom], vw: innerWidth, vh: innerHeight, glass: root.classList.contains('glass-on'), dark: matchMedia('(prefers-color-scheme: dark)').matches }
})()`

function judge(t, a, { minHit = 32 } = {}) {
  const bds = a.backdrop ? a.backdrop : [[255, 255, 255], [0, 0, 0]]
  const low = []
  let worstText = 99
  for (const tx of a.texts) {
    const layers = tx.layers.map(parse).filter(Boolean)
    const c = worstOver(parse(tx.color), layers, bds)
    const need = tx.dim ? 3 : 4.5
    worstText = Math.min(worstText, c)
    if (c < need) low.push(tx.text + ' ' + c.toFixed(2) + ' (' + tx.cls + ')')
  }
  check(t + ' text contrast >= 4.5:1 (dim lyric lines >= 3), worst case' + (a.backdrop ? ' over the Glass backdrop\'s darkest and lightest pixel' : ' over white and black'), !low.length, low.length ? low.slice(0, 8) : +worstText.toFixed(2))
  const small = a.controls.filter((c) => !c.inline && (c.w < minHit - 0.5 || c.h < minHit - 0.5))
  check(t + ' hit targets >= ' + minHit + ' px', !small.length, small.map((c) => c.id + ' ' + Math.round(c.w) + 'x' + Math.round(c.h)).slice(0, 10))
  const unnamed = a.controls.filter((c) => !c.name)
  check(t + ' every control has a name', !unnamed.length, unnamed.map((c) => c.tag + '#' + c.id))
  const out = a.texts.filter((tx) => tx.rect[0] < a.root[0] - 1 || tx.rect[2] > a.root[2] + 1).concat(a.controls.filter((c) => c.rect[0] < a.root[0] - 1 || c.rect[2] > a.root[2] + 1))
  check(t + ' nothing clipped at the sides', !out.length, out.map((o) => o.text || o.id).slice(0, 6))
  const nofit = a.texts.filter((tx) => !tx.fits)
  check(t + ' labels fit (or end in … with the full text as a tooltip)', !nofit.length, nofit.map((tx) => tx.text).slice(0, 6))
}

// Apple's page with the simulated logged-in panels (right:0 30vw fixed, a 100vw strip)
const APPLE_STATE = `(() => {
  const add = (css) => { const d = document.createElement('div'); d.setAttribute('data-sonata-test', ''); d.style.cssText = css; document.body.appendChild(d); return d }
  const dock = add('position:fixed;top:0;right:0;width:30vw;height:100vh;z-index:2147483647;pointer-events:none')
  const strip = add('position:fixed;left:0;bottom:120px;width:100vw;height:24px;z-index:2147483647;pointer-events:none')
  const dr = dock.getBoundingClientRect(); const sr = strip.getBoundingClientRect()
  for (const d of document.querySelectorAll('[data-sonata-test]')) d.remove()
  return { iw: innerWidth, dock: [dr.left, dr.right], strip: [sr.left, sr.right], hScroll: document.scrollingElement.scrollWidth > document.scrollingElement.clientWidth }
})()`

async function setTheme(mp, apple, dark) {
  for (let i = 0; i < 3; i++) {
    if ((await apple.ev('matchMedia("(prefers-color-scheme: dark)").matches')) === dark) return true
    x('move', 300, 300); x('key', 'ctrl+d'); await sleep(800)
  }
  return (await apple.ev('matchMedia("(prefers-color-scheme: dark)").matches')) === dark
}
async function setPinned(mp, pinned) {
  for (let i = 0; i < 2; i++) {
    if ((await mp.ev(settingsFile)).railPinned === pinned) return true
    x('move', 300, 300); x('key', 'ctrl+b'); await sleep(700)
  }
  return (await mp.ev(settingsFile)).railPinned === pinned
}
async function setPanel(mp, shown, page) {
  const s = await mp.ev(settingsFile)
  if (shown && (!s.panelShown || s.panelPage !== page)) await mp.ev(viewCommand('rail', page))
  else if (!shown && s.panelShown) await mp.ev(viewCommand('rail', s.panelPage))
  await sleep(900)
}
async function openAll(mp, page) {
  // every section of the page open at once (pinned), so every control is measured
  const s = await mp.ev(settingsFile)
  const pins = ((s.panelPins || {})[page]) || []
  for (const id of P.sectionIds(page)) if (!pins.includes(id)) await mp.ev(viewCommand('panel', 'acc', page, 'pin', id))
  await sleep(600)
}

// --- phases ---
async function matrix() {
  const mp = await mainProc()
  const apple = await target('music.apple.com')
  // the window was just resized: wait until the views follow
  const L0 = await waitFor(async () => { const l = await mp.ev(LAYOUT); return l.apple.width + 52 <= l.content.width && l.rail.x + l.rail.width === l.content.width ? l : null }, 6000) || await mp.ev(LAYOUT)
  const W = L0.content.width; const H = L0.content.height
  check(LABEL + ' window size is the one asked for', !/^\d+x\d+$/.test(LABEL) || LABEL === W + 'x' + H, W + 'x' + H)
  for (const dark of [false, true]) {
    check(LABEL + (dark ? ' dark' : ' light') + ' theme set (Ctrl+D)', await setTheme(mp, apple, dark))
    for (const pinned of [false, true]) {
      check(LABEL + ' pin ' + pinned + ' (Ctrl+B)', await setPinned(mp, pinned))
      for (const state of ['hidden', 'settings', 'about']) {
        const tag = `${LABEL}-${dark ? 'dark' : 'light'}-${pinned ? 'pinned' : 'unpinned'}-${state}`
        await setPanel(mp, state !== 'hidden', state)
        // the keyboard back in Apple's page (a rail with keyboard focus opens over the panel)
        await mp.ev(`(${E}.BaseWindow.getAllWindows()[0].contentView.children.find((v) => v.webContents.getURL().includes('music.apple.com')).webContents.focus(), true)`)
        x('move', Math.round(W * 0.3), Math.round(H / 2)); await sleep(700)
        const L = await mp.ev(LAYOUT)
        const want = P.windowLayout(W, H, { pinned, panelShown: state !== 'hidden' })
        if (state !== 'hidden') {
          await openAll(mp, state)
          const panel = await target('panel.html')
          await sleep(400)
          const a = await panel.ev(PAGE_AUDIT('.panel'))
          xshot(path.join(OUT, tag + '-' + want.panelMode + '.png'), W, H)
          check(tag + ' panel mode ' + want.panelMode, L.panel && L.panel.visible && L.panel.width === want.panel.width && L.panel.x === want.panel.x, { panel: L.panel, want: want.panel })
          check(tag + ' Apple\'s view as the layout says (docked: ends where the panel begins; drawer: keeps its width)', L.apple.width === want.apple.width && (want.panelMode !== 'docked' || L.apple.x + L.apple.width === L.panel.x), { apple: L.apple, panel: L.panel })
          check(tag + ' the panel ends where the rail\'s room begins', L.panel.x + L.panel.width === W - want.room)
          const ap = await apple.ev(APPLE_STATE)
          check(tag + ' simulated 30vw panel and 100vw strip of Apple\'s end inside Apple\'s view' + (want.panelMode === 'docked' ? ' (before the side panel)' : ''), Math.abs(ap.dock[1] - ap.iw) < 0.5 && Math.abs(ap.strip[1] - ap.iw) < 0.5 && (want.panelMode !== 'docked' || ap.dock[1] <= L.panel.x + 0.5) && !ap.hScroll, ap)
          check(tag + ' panel theme follows the window', a.dark === dark, { dark: a.dark })
          judge(tag, a)
          const pstate = await panel.ev('globalThis.__sonataPanel.state()')
          check(tag + ' every section open (pinned) for the audit', pstate.acc[state].pins.length === P.sectionIds(state).length)
          // the panel's header holds the ⋮ menu only: the rail item shows and hides the panel (no header hide button)
          const headerButtons = a.controls.filter((c) => c.section === 'header')
          check(tag + ' header: only the ⋮ menu (no hide button)', headerButtons.length === 1 && /menu-btn/.test(headerButtons[0].id), headerButtons.map((c) => c.name))
          // no permanently greyed-out controls: from source (this isolated copy) Updates shows a status line, not dead buttons
          if (state === 'settings') { const dead = a.controls.filter((c) => c.disabled && c.section === 'updates'); check(tag + ' Updates: no greyed-out controls (from source: a status line instead)', !dead.length, dead.map((c) => c.name)) }
          panel.c.close()
        } else {
          xshot(path.join(OUT, tag + '.png'), W, H)
          check(tag + ' panel hidden: Apple\'s view is the window minus the rail', L.apple.width === W - want.room && (!L.panel || !L.panel.visible), { apple: L.apple, panel: L.panel })
        }
      }
    }
  }
  await setPanel(mp, false); await setPinned(mp, false); await setTheme(mp, apple, false)
  apple.c.close(); mp.c.close()
}

async function keys() {
  const mp = await mainProc()
  const apple = await target('music.apple.com')
  await setPinned(mp, false)
  await setPanel(mp, true, 'settings')
  // fold everything, so the accordion's headers are the panel's stops
  await mp.ev(viewCommand('panel', 'acc', 'settings', 'collapseAll'))
  await sleep(500)
  const panel = await target('panel.html')
  const rail = await target('rail.html')
  const where = async () => {
    for (const [name, t] of [['panel', panel], ['rail', rail], ['apple', apple]]) {
      const f = await t.ev('document.hasFocus() ? (document.activeElement && (document.activeElement.id || document.activeElement.dataset.rail || document.activeElement.className || document.activeElement.tagName)) : null')
      if (f) return name + ':' + String(f).slice(0, 30)
    }
    return 'none'
  }
  // Apple -> panel -> rail -> Apple with F6
  await mp.ev(`(${E}.BaseWindow.getAllWindows()[0].contentView.children.find((v) => v.webContents.getURL().includes('music.apple.com')).webContents.focus(), true)`)
  x('move', 300, 300); await sleep(300)
  const ring = [await where()]
  for (let i = 0; i < 3; i++) { x('key', 'F6'); await sleep(500); ring.push(await where()) }
  check('F6 cycles Apple\'s page -> panel -> rail -> Apple\'s page', /^apple/.test(ring[0]) && /^panel/.test(ring[1]) && /^rail/.test(ring[2]) && /^apple/.test(ring[3]), ring)
  // in the panel: the first stop is the first section header
  x('key', 'F6'); await sleep(500)
  let f = await where()
  check('the panel takes focus on its first section header', /^panel:h-settings-playback/.test(f), f)
  const order = [f]
  for (let i = 0; i < 3; i++) { x('key', 'down'); await sleep(150); order.push(await where()) }
  x('key', 'end'); await sleep(150); order.push(await where())
  x('key', 'home'); await sleep(150); order.push(await where())
  x('key', 'up'); await sleep(150); order.push(await where())
  check('↓ / ↑ / Home / End move between section headers (wrapping)', order.join('|') === ['playback', 'timing', 'appearance', 'windows', 'startup', 'playback', 'startup'].map((id) => 'panel:h-settings-' + id).join('|'), order)
  x('key', 'home'); await sleep(150)
  const exp = () => panel.ev('document.activeElement.getAttribute("aria-expanded") + "|" + (document.activeElement.getAttribute("aria-controls") || "")')
  const e0 = await exp(); x('key', 'enter'); await sleep(500); const e1 = await exp(); x('key', 'space'); await sleep(500); const e2 = await exp()
  check('Enter opens, Space folds (aria-expanded, aria-controls only while open); focus stays on the header', e0 === 'false|' && /^true\|b-settings-playback$/.test(e1) && e2 === 'false|' && /h-settings-playback/.test(await where()), [e0, e1, e2])
  // Tab: header -> its pin -> (open body controls) -> next header; Tab past the panel's end -> the rail
  x('key', 'tab'); await sleep(200)
  const pinF = await panel.ev('document.activeElement.className + "|" + document.activeElement.getAttribute("aria-label") + "|" + document.activeElement.getAttribute("aria-pressed")')
  check('Tab from a header reaches its pin (named, aria-pressed)', /^sec-pin\|Keep Playback & lyrics open\|false$/.test(pinF), pinF)
  x('key', 'enter'); await sleep(500)
  check('Enter on the pin pins it (saved)', ((await mp.ev(settingsFile)).panelPins.settings || []).includes('playback'))
  x('key', 'enter'); await sleep(400)
  for (let i = 0; i < 60 && !/^rail/.test(await where()); i++) { x('key', 'tab'); await sleep(60) }
  check('Tab past the panel\'s last control reaches the rail', /^rail/.test(await where()))
  x('key', 'shift+tab'); await sleep(500)
  check('Shift+Tab from the rail goes back into the panel (its last control)', /^panel/.test(await where()), await where())
  // the ⋮ menu by keyboard
  await panel.ev('(document.querySelector(".menu-btn").focus({ focusVisible: true }), true)')
  x('key', 'enter'); await sleep(300)
  const m = await panel.ev('[document.querySelector(".menu").hidden, document.activeElement.getAttribute("role"), document.querySelector(".menu-btn").getAttribute("aria-expanded")]')
  check('⋮ opens with Enter, focus on its first item, aria-expanded', m[0] === false && m[1] === 'menuitem' && m[2] === 'true', m)
  x('key', 'esc'); await sleep(300)
  check('Esc closes the menu and returns to its button', await panel.ev('document.querySelector(".menu").hidden && document.activeElement.classList.contains("menu-btn")'))
  // the rail item: aria-pressed while its page shows; pressing it again hides the panel
  const railSettings = () => rail.ev('document.querySelector("[data-rail=settings]").getAttribute("aria-pressed")')
  check('rail Settings is pressed while the panel shows it', (await railSettings()) === 'true')
  await mp.ev(viewCommand('rail', 'settings')); await sleep(700)
  const L = await mp.ev(LAYOUT)
  check('pressing the current rail item hides the panel; Apple\'s page gets its room back', (await railSettings()) === 'false' && (!L.panel || !L.panel.visible) && L.apple.width === L.content.width - 52, L)
  // drawer: Esc closes it (narrow window)
  const big = L.content
  await mp.ev(`(${E}.BaseWindow.getAllWindows()[0].setContentSize(820, 600), true)`); await sleep(800)
  await mp.ev(viewCommand('rail', 'settings')); await sleep(900)
  const Ld = await mp.ev(LAYOUT)
  check('narrow window: the panel is a drawer over Apple\'s page (Apple keeps its width)', Ld.panel && Ld.panel.visible && Ld.apple.width === 820 - 52 && Ld.panel.x > 0, Ld)
  await panel.ev('(document.querySelector(".sec-toggle").focus({ focusVisible: true }), true)'); await mp.ev(`(${E}.BaseWindow.getAllWindows()[0].contentView.children.find((v) => v.webContents.getURL().includes('panel.html')).webContents.focus(), true)`)
  await sleep(200); x('key', 'esc'); await sleep(800)
  const Le = await mp.ev(LAYOUT)
  check('Esc closes the drawer; the keyboard goes to the rail', (!Le.panel || !Le.panel.visible) && /^rail/.test(await where()), { panel: Le.panel, focus: await where() })
  await mp.ev(`(${E}.BaseWindow.getAllWindows()[0].setContentSize(${big.width}, ${big.height}), true)`); await sleep(600)
  // Apple's page sees nothing of Sonata's
  const leak = await apple.ev('[typeof window.sonataPanelBridge, typeof window.__sonataPanel, typeof window.SonataPanelModel, typeof window.SonataTheme, typeof window.sonataFocusBridge, typeof window.require]')
  check('Apple\'s page sees no panel bridge, model, theme, focus bridge or require', leak.every((t) => t === 'undefined'), leak)
  const pn = await panel.ev('[typeof window.require, typeof window.process, typeof window.sonataPanelBridge]')
  check('panel page: no Node (only its bridge)', pn[0] === 'undefined' && pn[1] === 'undefined' && pn[2] === 'object', pn)
  apple.c.close(); panel.c.close(); rail.c.close(); mp.c.close()
}

async function loops() {
  const mp = await mainProc()
  const apple = await target('music.apple.com')
  await setPinned(mp, false)
  await setPanel(mp, true, 'settings')
  let panel = await target('panel.html')
  const rail = await target('rail.html')
  const snap = async (tag) => {
    for (const t of [panel, rail, apple]) await t.c.send('HeapProfiler.collectGarbage')
    return { tag, main: await mp.ev(MAIN_COUNTS), panelDom: await panel.c.send('Memory.getDOMCounters'), railDom: await rail.c.send('Memory.getDOMCounters'), appleDom: await apple.c.send('Memory.getDOMCounters'), stops: await apple.iso('globalThis.__sonataFocus.counts()') }
  }
  const rows = [await snap('start')]
  // 50 show/hide through the rail (real clicks on its Settings item: hover opens the rail, click picks)
  const L0 = await mp.ev(LAYOUT)
  const W = L0.content.width
  const railY = await rail.ev('(() => { const r = document.querySelector("[data-rail=settings]").getBoundingClientRect(); return Math.round(r.top + r.height / 2) })()')
  for (let i = 1; i <= 50; i++) {
    x('move', W - 20, railY); await sleep(350); x('click', W - 26, railY); await sleep(350)
    // every window this opened besides the main one (a mis-hit would show here, cycle by cycle)
    const titles = await mp.ev(`${E}.BaseWindow.getAllWindows().map((w) => w.getTitle()).join(',')`)
    if (titles !== 'Sonata') { check('show/hide cycle ' + i + ': only the panel changed (no other window opened)', false, titles); xshot(path.join(OUT, 'stray-' + i + '.png'), W, L0.content.height); await mp.ev(`(${E}.BaseWindow.getAllWindows().filter((w) => w.getTitle() !== 'Sonata').forEach((w) => w.close()), true)`); await sleep(500) }
    x('move', 300, 300); await sleep(250)
    if (i % 10 === 0) rows.push(await snap('show/hide ' + i))
  }
  await setPanel(mp, true, 'settings')
  // 50 pin/unpin and open/close cycles of every section (real clicks)
  for (let i = 1; i <= 50; i++) {
    const r = await panel.ev('(() => { const s = document.querySelectorAll(".sec")[' + (i % 7) + ']; const p = s.querySelector(".sec-pin").getBoundingClientRect(); const h = s.querySelector(".sec-toggle").getBoundingClientRect(); return [p.left + p.width / 2, p.top + p.height / 2, h.left + 40, h.top + h.height / 2] })()')
    const Lp = await mp.ev(LAYOUT)
    x('click', Math.round(Lp.panel.x + r[0]), Math.round(r[1])); await sleep(150)
    x('click', Math.round(Lp.panel.x + r[2]), Math.round(r[3])); await sleep(150)
    x('click', Math.round(Lp.panel.x + r[2]), Math.round(r[3])); await sleep(150)
    if (i % 10 === 0) rows.push(await snap('pin/open ' + i))
  }
  await mp.ev(viewCommand('panel', 'acc', 'settings', 'collapseAll')); await sleep(300)
  // 50 navigations in Apple's page with the panel shown
  const links = ['/new', '/radio', '/browse', '/new']
  for (let i = 1; i <= 50; i++) {
    await apple.ev(`(() => { const a = [...document.querySelectorAll('a')].find((a) => (a.getAttribute('href') || '').endsWith('${links[i % links.length]}')); if (a) a.click(); return !!a })()`)
    await sleep(350)
    if (i % 10 === 0) rows.push(await snap('navigate ' + i))
  }
  const first = rows[0]
  check('main: IPC handler counts flat', rows.every((r) => JSON.stringify(r.main.ipc) === JSON.stringify(first.main.ipc)), first.main.ipc)
  check('main: window and view listener counts flat', rows.every((r) => JSON.stringify([r.main.win, r.main.views]) === JSON.stringify([first.main.win, first.main.views])), rows[rows.length - 1].main.views)
  check('main: views and web contents flat (no toast view left behind)', rows.every((r) => r.main.children === first.main.children && r.main.webContents === first.main.webContents), rows.map((r) => r.main.children + '/' + r.main.webContents))
  check('main: active timers flat (+-2)', rows.every((r) => Math.abs(r.main.timers - first.main.timers) <= 2), rows.map((r) => r.main.timers))
  check('panel page: JS listeners, nodes and documents flat after GC (folded state compared)', rows.filter((r) => /start|navigate/.test(r.tag)).every((r) => r.panelDom.documents === first.panelDom.documents && Math.abs(r.panelDom.jsEventListeners - first.panelDom.jsEventListeners) <= 2 && Math.abs(r.panelDom.nodes - first.panelDom.nodes) <= 2), rows.map((r) => [r.panelDom.jsEventListeners, r.panelDom.nodes].join('/')))
  check('rail page: JS listeners and nodes flat', rows.every((r) => r.railDom.jsEventListeners === first.railDom.jsEventListeners && r.railDom.nodes === first.railDom.nodes), rows.map((r) => [r.railDom.jsEventListeners, r.railDom.nodes].join('/')))
  check('Apple page: always two focus stops', rows.every((r) => r.stops.stops === 2), rows.map((r) => r.stops.stops))
  results.push({ name: 'loop counts (table)', ok: true, detail: rows.map((r) => ({ tag: r.tag, panelJs: r.panelDom.jsEventListeners, panelNodes: r.panelDom.nodes, railJs: r.railDom.jsEventListeners, appleJs: r.appleDom.jsEventListeners, appleNodes: r.appleDom.nodes, webContents: r.main.webContents, timers: r.main.timers, windows: r.main.windows.join(',') })) })
  apple.c.close(); panel.c.close(); rail.c.close(); mp.c.close()
}

// CPU of every process of this Sonata over `ms` (from /proc, % of one core)
async function cpu(pids, ms) {
  const ticks = () => pids.reduce((a, p) => { try { const f = fs.readFileSync('/proc/' + p + '/stat', 'utf8').split(') ')[1].split(' '); return a + +f[11] + +f[12] } catch (e) { return a } }, 0)
  const t0 = ticks(); await sleep(ms); return (ticks() - t0) / (ms / 1000) / 100 * 100 / 1   // ticks are 1/100 s: % of one core
}
async function perf() {
  const mp = await mainProc()
  const pids = await mp.ev(`${E}.app.getAppMetrics().map((m) => m.pid)`)
  const out = {}
  const frames = async (t, ms) => {
    let n = 0
    t.c.on((m) => { if (m.method === 'Page.screencastFrame') { n++; t.c.send('Page.screencastFrameAck', { sessionId: m.params.sessionId }).catch(() => {}) } })
    await t.c.send('Page.startScreencast', { format: 'jpeg', quality: 10, everyNthFrame: 1 })
    await sleep(800); n = 0; await sleep(ms)
    await t.c.send('Page.stopScreencast')
    return n
  }
  x('move', 300, 300)
  await setPanel(mp, false); await sleep(1500)
  out.hiddenCpu = +(await cpu(pids, 30000)).toFixed(2)
  await setPanel(mp, true, 'settings'); await sleep(1500)
  const panel = await target('panel.html'); const rail = await target('rail.html')
  out.shownCpu = +(await cpu(await mp.ev(`${E}.app.getAppMetrics().map((m) => m.pid)`), 30000)).toFixed(2)
  out.panelFramesIdle10s = await frames(panel, 10000)
  out.railFramesIdle10s = await frames(rail, 10000)
  check('idle: the panel and the rail never repaint while resting', out.panelFramesIdle10s === 0 && out.railFramesIdle10s === 0, out)
  const m = await mp.ev(`${E}.app.getAppMetrics().map((m) => ({ type: m.type, mb: Math.round(m.memory.workingSetSize / 1024) }))`)
  out.processes = m
  // show/hide x10: the cost of one toggle
  await panel.c.send('Performance.enable')
  const a0 = await panel.metrics()
  for (let i = 0; i < 10; i++) { await mp.ev(viewCommand('rail', 'settings')); await sleep(400) }
  const a1 = await panel.metrics()
  out.toggle10 = { layouts: a1.LayoutCount - a0.LayoutCount, styles: a1.RecalcStyleCount - a0.RecalcStyleCount, scriptMs: Math.round((a1.ScriptDuration - a0.ScriptDuration) * 1000) }
  results.push({ name: 'perf', ok: true, detail: out })
  panel.c.close(); rail.c.close(); mp.c.close()
}

// the mini player (run the app with --mini): hover and not, light and dark; the star and the ⋯ always
// reachable; the scrubber only over the song's words, never when nothing plays; the keyboard path
async function mini() {
  const mp = await mainProc()
  const page = await target('miniplayer.html')
  await mp.ev(`(() => { const w = ${E}.BrowserWindow.getAllWindows().find((w) => w.getTitle().includes('Mini')); w.setPosition(0, 0); return true })()`)
  await sleep(500)
  // a playing song, as the 1 s poll would send it (resent before each look: the logged-out poll says "nothing")
  const SONG = { ok: true, isPlaying: true, title: 'Say You Love Me', artist: 'Fleetwood Mac', album: 'Greatest Hits (Deluxe Edition)', duration: 250, playbackTime: 140, artwork: '', shuffle: false, repeat: 0, volume: 0.6, contentRating: '' }
  // while playing is simulated, the logged-out poll's "nothing playing" pushes are held back (this
  // checker's own patch of the mini window's send, in the test copy only; undone at the end)
  const hold = (on) => mp.ev(`(() => { const wc = ${E}.BrowserWindow.getAllWindows().find((w) => w.getTitle().includes('Mini')).webContents
    if (${on} && !wc.__origSend) { wc.__origSend = wc.send; wc.send = function (ch, ...a) { if (ch === 'now-playing' && !(a[0] && a[0].__test)) return; return wc.__origSend.call(wc, ch, ...a) } }
    if (!${on} && wc.__origSend) { wc.send = wc.__origSend; delete wc.__origSend }
    return true })()`)
  const play = () => mp.ev(`(() => { const w = ${E}.BrowserWindow.getAllWindows().find((w) => w.getTitle().includes('Mini')); w.webContents.send('now-playing', Object.assign(${JSON.stringify(SONG)}, { __test: true })); return true })()`)
  const rects = () => page.ev('Object.fromEntries(["mid", "fav", "more", "art", "volume"].map((id) => { const r = document.getElementById(id).getBoundingClientRect(); return [id, [Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2)]] }))')
  const look = () => page.ev(`(() => {
    const at = (id) => { const r = document.getElementById(id).getBoundingClientRect(); const e = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return !!e && (e === document.getElementById(id) || document.getElementById(id).contains(e)) }
    const cs = (id) => getComputedStyle(document.getElementById(id))
    return { idle: document.getElementById('center').classList.contains('idle'), hot: document.getElementById('mid').classList.contains('hot'),
      np: +cs('np').opacity, scrub: cs('scrub').display === 'none' ? 'none' : +cs('scrub').opacity,
      favVisible: cs('fav').visibility === 'visible', favHit: at('fav'), moreHit: at('more'), moreVisible: cs('more').visibility === 'visible' }
  })()`)
  for (const dark of [false, true]) {
    for (let i = 0; i < 3 && (await page.ev('matchMedia("(prefers-color-scheme: dark)").matches')) !== dark; i++) {
      await mp.ev(`(${E}.nativeTheme.themeSource = ${JSON.stringify(dark ? 'dark' : 'light')}, true)`); await sleep(600)
    }
    const t = dark ? 'dark' : 'light'
    // nothing playing (the logged-out page): no scrubber even over the words; the ⋯ usable, no star
    x('move', 700, 200); await sleep(1300)
    let R = await rects()
    x('move', R.mid[0], R.mid[1]); await sleep(500)
    let l = await look()
    xshot(path.join(OUT, `mini-${t}-not-playing.png`), 720, 80)
    check(`mini-${t} not playing: no scrubber (no 0:00 bar) even with the pointer on the words; the ⋯ clickable`, l.idle && l.scrub === 'none' && l.np === 1 && l.moreHit && !l.favVisible, l)
    // playing, the pointer on the ⋯, then the star: the scrubber stays shut, both buttons are hit
    await hold(true)
    await play(); x('move', 700, 200); await sleep(250); R = await rects()
    await play(); x('move', R.more[0], R.more[1]); await sleep(400)
    l = await look()
    check(`mini-${t} playing, pointer on the ⋯: the words stay, the ⋯ and the star are there to click`, !l.idle && !l.hot && l.np === 1 && l.moreHit && l.favHit && l.favVisible, l)
    await play(); x('move', R.fav[0], R.fav[1]); await sleep(400)
    l = await look()
    check(`mini-${t} playing, pointer on the star: no scrubber, the star hit`, !l.hot && l.np === 1 && l.favHit, l)
    xshot(path.join(OUT, `mini-${t}-rest.png`), 720, 80)
    // a quick pass over the words on the way to the buttons (< 120 ms): no flicker
    await play(); x('move', R.mid[0] - 60, R.mid[1]); await sleep(50); x('move', R.more[0], R.more[1]); await sleep(300)
    l = await look()
    check(`mini-${t} passing over the words quickly doesn't open the scrubber (hover intent)`, !l.hot && l.np === 1, l)
    // resting on the words: the scrubber, with the ⋯ and the star still in place
    await play(); x('move', R.mid[0], R.mid[1]); await sleep(450)
    l = await look()
    xshot(path.join(OUT, `mini-${t}-hover.png`), 720, 80)
    check(`mini-${t} resting on the words: the scrubber shows; the ⋯ and the star stay visible and clickable`, l.hot && l.scrub === 1 && l.np === 0 && l.moreHit && l.favHit && l.favVisible && l.moreVisible, l)
    const a = await page.ev(PAGE_AUDIT('#pill'))
    judge(`mini-${t}-hover`, a, { minHit: 24 })
    check(`mini-${t} main controls >= 32 px`, a.controls.filter((c) => /playpause|prev|next|shuffle|repeat|lyrics|queue|mute|fav|more/.test(c.id)).every((c) => c.w >= 31.5 && c.h >= 31.5), a.controls.map((c) => c.id + ' ' + Math.round(c.w) + 'x' + Math.round(c.h)).join(', '))
    const st = await page.ev('[getComputedStyle(document.getElementById("pill")).borderRadius, getComputedStyle(document.getElementById("pill")).borderTopWidth]')
    check(`mini-${t} one pill (round ends) with a 1 px outline`, (/999px/.test(st[0]) || parseFloat(st[0]) >= 32) && st[1] === '1px', st)
    // the keyboard: from the artwork, Tab reaches the bar (the scrubber opens), then the star and the ⋯ (it shuts)
    x('move', 700, 200); await sleep(300); await play(); await sleep(200)
    await page.ev('(document.getElementById("art").focus({ focusVisible: true }), true)')
    await mp.ev(`(${E}.BrowserWindow.getAllWindows().find((w) => w.getTitle().includes('Mini')).webContents.focus(), true)`)
    const order = []
    for (let i = 0; i < 3; i++) { x('key', 'tab'); await sleep(250); order.push(await page.ev('document.activeElement.id + ":" + (+getComputedStyle(document.getElementById("scrub")).opacity)')) }
    check(`mini-${t} keyboard: Tab goes bar (scrubber open) -> star -> ⋯ (scrubber shut)`, order.join('|') === 'seek:1|fav:0|more:0', order)
    await hold(false); await sleep(1300)
  }
  // the wheel over the volume: 5 % per notch, the page doesn't scroll
  const vr = (await rects()).volume
  const v0 = await page.ev('+document.getElementById("volume").value')
  x('wheel', vr[0], vr[1], -2); await sleep(400)
  const v1 = await page.ev('[+document.getElementById("volume").value, document.getElementById("volume").getAttribute("aria-valuetext"), document.getElementById("volume").title]')
  check('mini: wheel down 2 notches = -10 %, said in the tooltip and aria-valuetext', v1[0] === Math.max(0, Math.round(v0 / 5) * 5 - 10) && v1[1] === v1[0] + ' %' && v1[2].includes(v1[0] + ' %'), { v0, v1 })
  mp.c.close(); page.c.close()
}

// the lyrics window over a dark and a light album, both schemes (0.15.31's unreadable lyrics)
// The sung line in every combination (0.15.37): light/dark x album colour on/off x Glass on/off, each
// word of the active line (sung, being sung, not reached yet) >= 4.5:1 over the card (the Glass
// backdrop's darkest and lightest pixel), with opacity counted. Prints the worst ratio per combination.
async function activeLine(mp, page, send, data, tag, b) {
  const word = (t, text) => text.split(' ').map((w, i) => ({ t: t + i * 0.6, end: t + i * 0.6 + 0.5, text: w }))
  const lines = [0, 1, 2, 3].map((i) => ({ t: i * 6, end: i * 6 + 5, text: 'Words of line ' + (i + 1) + ' here', words: word(i * 6, 'Words of line ' + (i + 1) + ' here') }))
  await send('lyrics-data', Object.assign({}, data, { title: 'Active line check', lines })); await sleep(400)
  await send('lyrics-time', 13.7, false); await sleep(700)   // line 3: "Words of line" sung, "line" lit, "3 here" to come
  const a = await page.ev(PAGE_AUDIT('#card'))
  xshot(path.join(OUT, 'active-' + tag + '.png'), b.width, b.height)
  const bds = a.backdrop ? a.backdrop : [[255, 255, 255], [0, 0, 0]]
  const words = a.texts.filter((t) => t.activeLine)
  const rows = words.map((t) => ({ text: t.text, op: +t.op.toFixed(2), ratio: +worstOver(parse(t.color), t.layers.map(parse).filter(Boolean), bds).toFixed(2) }))
  const worstRow = rows.reduce((w, r) => (r.ratio < w.ratio ? r : w), { ratio: 99 })
  check(tag + ' the sung line: every word >= 4.5:1 (sung, being sung and still to come), worst ' + worstRow.ratio + ' ("' + worstRow.text + '")', rows.length >= 5 && rows.every((r) => r.ratio >= 4.5), rows)
}

async function lyrics() {
  const mp = await mainProc()
  await mp.ev(viewCommand('rail', 'lyrics')); await sleep(2500)
  // the panel (for the album colour and Glass switches, as the Settings panel sets them)
  const panelShown = async () => mp.ev(`${settingsFile}.panelShown`)
  if (!(await panelShown())) { await mp.ev(viewCommand('rail', 'settings')); await sleep(2500) }
  const page = await target('lyrics.html')
  const data = { title: 'Contrast check', artist: 'Sonata', album: 'Test', duration: 60, source: 'apple', status: '', estimate: false, refined: false, aligned: false, lang: 'en',
    lines: [0, 1, 2, 3, 4, 5].map((i) => ({ t: i * 6, end: i * 6 + 5, text: 'Line number ' + (i + 1) + ' of the song', words: [] })) }
  // the lyrics feed's own pushes (logged out: no song, time 0) are held back while this checker drives
  // the window (its own patch of the window's send, in the test copy only)
  await mp.ev(`(() => { const wc = ${E}.BrowserWindow.getAllWindows().find((w) => w.getTitle().includes('Lyrics')).webContents
    wc.__origSend = wc.send
    wc.send = function (ch, ...a) { if (/^lyrics-(time|data)$/.test(ch) && a[a.length - 1] !== '__test') return; return wc.__origSend.call(wc, ch, ...a.filter((x) => x !== '__test')) }
    return true })()`)
  const send = (ch, ...a) => mp.ev(`(() => { const w = ${E}.BrowserWindow.getAllWindows().find((w) => w.getTitle().includes('Lyrics')); w.webContents.send(${JSON.stringify(ch)}, ...${JSON.stringify(a)}, '__test'); return true })()`)
  const b0 = await mp.ev(`(() => { const w = ${E}.BrowserWindow.getAllWindows().find((w) => w.getTitle().includes('Lyrics')); w.setBounds({ x: 0, y: 0, width: 380, height: 560 }); return w.getBounds() })()`)
  for (const adaptive of [true, false]) {
    for (const glass of [true, false]) {
      await mp.ev(viewCommand('panel', 'set', 'adaptiveColor', adaptive)); await mp.ev(viewCommand('panel', 'set', 'glass', glass)); await sleep(600)
      for (const dark of [false, true]) {
        await mp.ev(`(${E}.nativeTheme.themeSource = ${JSON.stringify(dark ? 'dark' : 'light')}, true)`); await sleep(900)
        await activeLine(mp, page, send, data, (dark ? 'dark' : 'light') + (adaptive ? '-album' : '-plain') + (glass ? '-glass' : '') + '-' + LABEL, b0)
      }
    }
  }
  await mp.ev(viewCommand('panel', 'set', 'adaptiveColor', true)); await mp.ev(viewCommand('panel', 'set', 'glass', true)); await sleep(600)
  for (const dark of [false, true]) {
    await mp.ev(`(${E}.nativeTheme.themeSource = ${JSON.stringify(dark ? 'dark' : 'light')}, true)`); await sleep(800)
    await send('lyrics-data', data); await send('lyrics-time', 13, false); await sleep(800)
    const tag = 'lyrics-' + (dark ? 'dark' : 'light') + '-' + LABEL
    const b = await mp.ev(`(() => { const w = ${E}.BrowserWindow.getAllWindows().find((w) => w.getTitle().includes('Lyrics')); w.setBounds({ x: 0, y: 0, width: 380, height: 560 }); return w.getBounds() })()`)
    await sleep(400)
    xshot(path.join(OUT, tag + '.png'), b.width, b.height)
    const a = await page.ev(PAGE_AUDIT('#card'))
    const active = a.texts.filter((t) => /Line number 3/.test(t.text))
    check(tag + ' the current line is there', active.length >= 1)
    judge(tag, a, { minHit: 24 })
    // a duet (0.15.33): singer 1 left, singer 2 right, both together centred; each sings in its own
    // colour, each >= 4.5:1, and the sides differ too (colour is never the only cue)
    const word = (t, text) => text.split(' ').map((w, i) => ({ t: t + i * 0.5, end: t + i * 0.5 + 0.45, text: w }))
    const duet = Object.assign({}, data, { title: 'Duet check', lines: [
      { t: 0, end: 4, text: 'First singer sings here', agent: 'v1', words: word(0, 'First singer sings here') },
      { t: 5, end: 9, text: 'Second singer answers back', agent: 'v2', words: word(5, 'Second singer answers back') },
      { t: 10, end: 14, text: 'Both of them together now', agent: 'v1000', words: word(10, 'Both of them together now') },
      { t: 15, end: 19, text: 'First singer once again', agent: 'v1', words: word(15, 'First singer once again') }] })
    duet.lines[2].agent = 'group'
    await send('lyrics-data', duet); await sleep(500)
    const seen = {}
    for (const [who, t] of [['singer 1', 1.2], ['singer 2', 6.2], ['together', 11.2]]) {
      await send('lyrics-time', t, true); await sleep(600)
      const st = await page.ev(`(() => { const l = document.querySelector('.line.active'); const w = l && l.querySelector('.w.now'); return l ? { side: [...l.classList].filter((c) => ['left', 'right', 'center'].includes(c)).join(''), color: getComputedStyle(w || l).color } : null })()`)
      seen[who] = st
      xshot(path.join(OUT, tag.replace('lyrics-', 'duet-') + '-' + who.replace(' ', '') + '.png'), b.width, b.height)
      const da = await page.ev(PAGE_AUDIT('#card'))
      judge(tag + ' duet ' + who, da, { minHit: 24 })
    }
    check(tag + ' duet: the singers sit on their own sides (left, right, centre)', seen['singer 1'] && seen['singer 1'].side === 'left' && seen['singer 2'].side === 'right' && seen['together'].side === 'center', seen)
    if (process.env.SONATA_TEST_ARTWORK || LABEL.includes('artwork')) {
      check(tag + ' duet: three different colours for singer 1, singer 2 and together', new Set(Object.values(seen).map((x) => x && x.color)).size === 3, seen)
    }
    // a held note (0.15.34): "home" held over the next line's start stays the lit word (settled into
    // the sustain) while the next line is current, and lets go when the voice does
    const held = Object.assign({}, data, { title: 'Held note check', lines: [
      { t: 0, end: 7, text: 'Come take me home', aligned: true, words: [{ t: 0.5, end: 0.8, text: 'Come' }, { t: 0.9, end: 1.2, text: 'take' }, { t: 1.3, end: 1.5, text: 'me' }, { t: 1.6, end: 7, text: 'home', held: true, holdFrom: 2.1 }] },
      { t: 6, end: 9, text: 'Oh I need you now' }, { t: 12, end: 14, text: 'Later on' }] })
    await send('lyrics-data', held); await sleep(400)
    const look = async (t) => { await send('lyrics-time', t, false); await sleep(350); return page.ev(`(() => { const ls = [...document.querySelectorAll('.line')]; const home = ls[0].querySelectorAll('.w')[3]; return { active: ls.map((l) => l.classList.contains('active')), homeNow: home.classList.contains('now'), homeHold: home.classList.contains('hold') } })()`) }
    const atHold = await look(6.3)
    if (!dark) xshot(path.join(OUT, 'held-' + LABEL + '.png'), b.width, b.height)
    check(tag + ' held note: at 6.3 s the next line is current AND "home" (held over its start) is still the lit word, in its sustain', atHold.active[0] && atHold.active[1] && atHold.homeNow && atHold.homeHold, atHold)
    const early = await look(1.8)
    check(tag + ' held note: the pop first (no sustain yet at the start of the word)', early.homeNow && !early.homeHold, early)
    const after = await look(7.4)
    check(tag + ' held note: when the voice stops (bounded to 0.6 s past the next line\'s start) "home" lets go', !(after.active[0] && after.homeNow) && !after.active[0] && after.active[1], after)   // lit = .now inside an .active line
    await send('lyrics-data', data); await sleep(300)
  }
  mp.c.close(); page.c.close()
}

;(async () => {
  fs.mkdirSync(OUT, { recursive: true })
  const phases = { matrix, keys, loops, perf, mini, lyrics }
  if (!phases[phase]) throw new Error('phase: ' + Object.keys(phases).join(' | '))
  await phases[phase]()
  const failed = results.filter((r) => !r.ok)
  console.log(JSON.stringify({ phase, label: LABEL, passed: results.length - failed.length, failed: failed.length, results }, null, 1))
  process.exit(failed.length ? 1 : 0)
})().catch((e) => {
  const failed = results.filter((r) => !r.ok)
  console.log(JSON.stringify({ phase, label: LABEL, crashed: e.stack || e.message, passed: results.length - failed.length, failed: failed.length + 1, results }, null, 1))
  process.exit(2)
})
