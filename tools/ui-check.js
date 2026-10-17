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
//           light/dark x album colour on/off x Glass on/off), a11y (Sonata's own windows: an offline
//           axe-style rule set, focus order and keyboard reach with the theme's focus ring, reduced motion),
//           stage (the lyrics window grown into the stage: columns, real-data texts, every theme with
//           screenshots, drag regions while the lists scroll, no dead controls, keyboard, idle frames, the Montage
//           (on/off, credit, every word readable over every photo in every theme, cost playing, 0 frames paused or
//           minimised; the real Commons path with SONATA_TEST_MONTAGE), the form)
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
function check(name, ok, detail) { results.push({ name, ok: !!ok, detail }); if (process.env.UI_CHECK_TRACE) console.error((ok ? 'ok   ' : 'FAIL ') + name + (ok ? '' : ' ' + JSON.stringify(detail).slice(0, 700))); return ok }
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
    texts.push({ text: n.textContent.trim().slice(0, 40), color, layers: layersOf(el), size: parseFloat(cs.fontSize), weight: +cs.fontWeight, dim: !!el.closest('.line:not(.active)') || !!el.closest('.bgv'), activeLine: !!el.closest('.line.active') && !el.closest('.bgv'), bgv: !!el.closest('.bgv'), op,
      fits: el.scrollWidth <= el.clientWidth + 1 || cs.textOverflow === 'ellipsis' || cs.display === 'inline', clipped: cs.textOverflow === 'ellipsis' && el.scrollWidth > el.clientWidth + 1, cls: el.className && String(el.className).slice(0, 30),
      rect: [r.left, r.top, r.right, r.bottom] })
  }
  const controls = [...root.querySelectorAll('button, select, input, a[href], [role=switch], [role=slider], [role=button], [tabindex="0"]')].filter(vis).map((el) => {
    const r = el.getBoundingClientRect()
    let name = el.getAttribute('aria-label') || ''
    if (!name && el.getAttribute('aria-labelledby')) name = el.getAttribute('aria-labelledby').split(' ').map((id) => (document.getElementById(id) || {}).textContent || '').join(' ').trim()
    if (!name) name = (el.textContent || '').trim() || el.getAttribute('title') || ''
    // a link inside running text (WCAG 2.5.8's inline exception): paragraphs, lists and the Credits table's cells
    const inline = el.tagName === 'A' && getComputedStyle(el).display === 'inline' && !!el.closest('p, li, dd, dt, td')
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

// --- a11y: Sonata's own windows (the rail, the Settings/About panel, the lyrics window, the visualizer,
// the mini player; never Apple's page). Three parts per window:
//   - an offline rule set in the style of axe-core (no dependency: axe isn't in node_modules and would
//     be the checker's first heavy one): valid roles and aria-* attributes and values, the attributes a
//     role needs, id references that resolve, unique ids, no positive tabindex, nothing focusable under
//     aria-hidden, no control inside another, images with alt, the page's language, every control named;
//   - the keyboard: Tab (and the arrows of a roving group) reach every visible control, in DOM order,
//     and each shows the theme's focus ring (outline >= 2 px in --s-ring) on keyboard focus;
//   - prefers-reduced-motion, emulated through DevTools: no pop, bounce, slide or fast travel left.
const A11Y_RULES = (rootSel) => `(() => {
  const root = document.querySelector(${JSON.stringify(rootSel)}) || document.body
  const out = []
  const bad = (rule, el, why) => out.push(rule + ': ' + (el.id ? '#' + el.id : el.tagName.toLowerCase() + (el.className && typeof el.className === 'string' ? '.' + el.className.split(' ')[0] : '')) + (why ? ' (' + why + ')' : ''))
  const ROLES = 'alert alertdialog application article banner button cell checkbox columnheader combobox complementary contentinfo definition dialog directory document feed figure form grid gridcell group heading img link list listbox listitem log main marquee math menu menubar menuitem menuitemcheckbox menuitemradio meter navigation none note option presentation progressbar radio radiogroup region row rowgroup rowheader scrollbar search searchbox separator slider spinbutton status switch tab table tablist tabpanel term textbox timer toolbar tooltip tree treegrid treeitem'.split(' ')
  const ATTRS = 'activedescendant atomic autocomplete braillelabel brailleroledescription busy checked colcount colindex colindextext colspan controls current describedby description details disabled dropeffect errormessage expanded flowto grabbed haspopup hidden invalid keyshortcuts label labelledby level live modal multiline multiselectable orientation owns placeholder posinset pressed readonly relevant required roledescription rowcount rowindex rowindextext rowspan selected setsize sort valuemax valuemin valuenow valuetext'.split(' ')
  const TOKENS = { pressed: ['true', 'false', 'mixed'], checked: ['true', 'false', 'mixed'], expanded: ['true', 'false'], hidden: ['true', 'false'], disabled: ['true', 'false'], selected: ['true', 'false'], atomic: ['true', 'false'], modal: ['true', 'false'], current: ['true', 'false', 'page', 'step', 'location', 'date', 'time'], live: ['off', 'polite', 'assertive'], haspopup: ['true', 'false', 'menu', 'listbox', 'tree', 'grid', 'dialog'], orientation: ['horizontal', 'vertical', 'undefined'] }
  const IDREFS = ['labelledby', 'describedby', 'controls', 'owns', 'activedescendant', 'flowto', 'errormessage', 'details']
  const NEEDS = { slider: ['valuenow'], switch: ['checked'], checkbox: ['checked'], menuitemcheckbox: ['checked'], menuitemradio: ['checked'], radio: ['checked'], scrollbar: ['valuenow', 'controls'], combobox: ['expanded'], heading: ['level'] }
  const all = [root, ...root.querySelectorAll('*')]
  if (!document.documentElement.lang) out.push('html-has-lang: <html> has no lang')
  const ids = {}
  for (const el of document.querySelectorAll('[id]')) ids[el.id] = (ids[el.id] || 0) + 1   /* loop: NOT-WORTH — test only */
  for (const [id, n] of Object.entries(ids)) if (n > 1) out.push('duplicate-id: #' + id + ' x' + n)
  const FOCUSABLE = 'button, input, select, textarea, a[href], [tabindex], [contenteditable=""], [contenteditable="true"]'
  const focusable = (el) => el.matches(FOCUSABLE) && !el.disabled && el.tabIndex >= 0
  const INTERACTIVE = 'button, input, select, textarea, a[href], [role=button], [role=switch], [role=slider], [role=checkbox], [role=link], [role=menuitem], [role=tab], [role=option]'
  const vis = (el) => { const r = el.getBoundingClientRect(); const cs = getComputedStyle(el); return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none' && !el.closest('[hidden]') }
  const nameOf = (el) => {
    let n = el.getAttribute('aria-label') || ''
    if (!n && el.getAttribute('aria-labelledby')) n = el.getAttribute('aria-labelledby').split(/\\s+/).map((id) => (document.getElementById(id) || {}).textContent || '').join(' ')
    if (!n && el.id) { const l = document.querySelector('label[for="' + el.id + '"]'); if (l) n = l.textContent }
    if (!n && el.tagName !== 'INPUT') n = el.textContent || ''
    if (!n) n = el.getAttribute('title') || el.getAttribute('alt') || ''
    return n.trim()
  }
  for (const el of all) {   /* loop: NOT-WORTH — the page's elements, once per check */
    const role = el.getAttribute('role')
    if (role && !role.split(/\\s+/).every((r) => ROLES.includes(r))) bad('aria-roles', el, role)
    for (const a of el.getAttributeNames()) {
      if (!a.startsWith('aria-')) continue
      const k = a.slice(5)
      const v = el.getAttribute(a)
      if (!ATTRS.includes(k)) { bad('aria-valid-attr', el, a); continue }
      if (TOKENS[k] && !TOKENS[k].includes(v)) bad('aria-valid-attr-value', el, a + '=' + v)
      if (IDREFS.includes(k) && v && !v.split(/\\s+/).every((id) => document.getElementById(id))) bad('aria-valid-attr-value', el, a + ' -> missing #' + v)
    }
    if (role && NEEDS[role]) for (const k of NEEDS[role]) if (!el.hasAttribute('aria-' + k)) bad('aria-required-attr', el, role + ' needs aria-' + k)
    if (el.tabIndex > 0) bad('tabindex', el, 'tabindex ' + el.tabIndex)
    if (el.closest('[aria-hidden="true"]') && focusable(el)) bad('aria-hidden-focus', el)
    if (el.tagName === 'IMG' && !el.hasAttribute('alt') && el.getAttribute('aria-hidden') !== 'true' && !['presentation', 'none'].includes(role)) bad('image-alt', el)
    if (el.matches(INTERACTIVE) && el.parentElement && el.parentElement.closest(INTERACTIVE) && !el.parentElement.closest('[role=menu], [role=listbox], [role=group]')) bad('nested-interactive', el, 'inside ' + (el.parentElement.closest(INTERACTIVE).id || el.parentElement.closest(INTERACTIVE).tagName))
    if (el.matches(INTERACTIVE) && vis(el) && !el.closest('[aria-hidden="true"]') && !nameOf(el)) bad('control-name', el)
  }
  return out
})()`

// the element that has the keyboard: a short descriptor, whether it shows the theme's focus ring, and
// whether it is one of `rootSel`'s visible, tabbable controls (DOM order index)
const FOCUS_NOW = `(() => {
  const el = document.activeElement
  if (!document.hasFocus() || !el || el === document.body) return null
  const probe = document.createElement('span'); probe.style.color = 'var(--s-ring)'; document.body.appendChild(probe)
  const ringColor = getComputedStyle(probe).color; probe.remove()
  const cs = getComputedStyle(el)
  const ring = el.matches(':focus-visible') && cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) >= 2 && cs.outlineColor === ringColor
  return { n: [...document.querySelectorAll('*')].indexOf(el), id: el.id || el.dataset.rail || el.dataset.key || (el.className && String(el.className).split(' ')[0]) || el.tagName, ring, outline: cs.outlineStyle + ' ' + cs.outlineWidth + ' ' + cs.outlineColor, want: ringColor, current: el.getAttribute('aria-current'), label: el.getAttribute('aria-label') }
})()`
// the controls Tab should reach, in DOM order (visible, enabled, tabindex >= 0, not under aria-hidden)
const TABBABLES = (rootSel) => `[...(document.querySelector(${JSON.stringify(rootSel)}) || document.body).querySelectorAll('button, input, select, textarea, a[href], [tabindex]')]
  .filter((el) => { const r = el.getBoundingClientRect(); const cs = getComputedStyle(el); return !el.disabled && el.tabIndex >= 0 && r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none' && !el.closest('[hidden], [aria-hidden="true"]') })
  .map((el) => el.id || el.dataset.rail || el.dataset.key || (el.className && String(el.className).split(' ')[0]) || el.tagName)`
const emulateReduce = (page, on) => page.c.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: on ? 'reduce' : 'no-preference' }] })
const focusWin = (mp, title) => mp.ev(`(() => { const w = ${E}.BrowserWindow.getAllWindows().find((w) => w.getTitle().includes(${JSON.stringify(title)})); if (!w) return false; w.focus(); w.webContents.focus(); return true })()`)
const focusView = (mp, part) => mp.ev(`(${E}.BaseWindow.getAllWindows().find((w) => w.contentView && w.contentView.children.length >= 2).contentView.children.find((v) => v.webContents.getURL().includes(${JSON.stringify(part)})).webContents.focus(), true)`)
const winOpen = (mp, title) => mp.ev(`${E}.BrowserWindow.getAllWindows().some((w) => !w.isDestroyed() && w.getTitle().includes(${JSON.stringify(title)}))`)

// press `key` up to n times, collecting each stop until focus leaves the page, stays put or comes back
// to a stop already seen (that last press is undone with `back`, so the keyboard ends on the last stop)
async function walkKeys(page, key, n, { from = [], back = null } = {}) {
  const stops = from.filter(Boolean)
  for (let i = 0; i < n; i++) {
    x('key', key); await sleep(180)
    const f = await page.ev(FOCUS_NOW)
    if (!f) break
    if (stops.some((s) => s.n === f.n)) { if (back) { x('key', back); await sleep(180) } break }
    stops.push(f)
  }
  return stops
}
function judgeStops(tag, stops, want) {
  check(tag + ' keyboard reaches every control, in DOM order', stops.map((s) => s.id).join('|') === want.join('|'), { reached: stops.map((s) => s.id), want })
  const noRing = stops.filter((s) => !s.ring)
  check(tag + ' every keyboard stop shows the theme\'s focus ring (>= 2 px, --s-ring)', stops.length && !noRing.length, noRing.map((s) => s.id + ': ' + s.outline + ' want ' + s.want))
}

async function a11y() {
  const mp = await mainProc()
  // --- the rail and the panel (Settings and About, every section open) ---
  const rail = await target('rail.html')
  const rv = await rail.ev(A11Y_RULES('body'))
  check('rail: offline rule set (roles, aria-*, names, ids, tabindex, aria-hidden, nesting, lang)', !rv.length, rv)
  await rail.ev('(document.querySelector("button[data-rail]").focus({ focusVisible: true }), true)')
  await focusView(mp, 'rail.html'); await sleep(300)
  const railWant = await rail.ev(`[...document.querySelectorAll('button[data-rail]')].filter((b) => b.getClientRects().length && getComputedStyle(b).visibility !== 'hidden').map((b) => b.dataset.rail)`)
  const railStops = await walkKeys(rail, 'down', railWant.length + 1, { from: [await rail.ev(FOCUS_NOW)] })
  judgeStops('rail (↓ through the roving group)', railStops, railWant)
  x('key', 'esc'); await sleep(300)
  for (const page of ['settings', 'about']) {
    await setPanel(mp, true, page); await openAll(mp, page)
    const panel = await target('panel.html'); await sleep(400)
    const pv = await panel.ev(A11Y_RULES('.panel'))
    check('panel ' + page + ': offline rule set', !pv.length, pv)
    const want = await panel.ev(TABBABLES('.panel'))
    await panel.ev(`(document.querySelector('.panel').querySelector('button, select, a[href], [tabindex="0"]').focus({ focusVisible: true }), true)`)
    await focusView(mp, 'panel.html'); await sleep(300)
    const stops = await walkKeys(panel, 'tab', want.length + 2, { from: [await panel.ev(FOCUS_NOW)] })
    judgeStops('panel ' + page + ' (Tab)', stops, want)
    // reduced motion: the accordion's chevron and the switches don't animate
    await emulateReduce(panel, true); await sleep(200)
    const d = await panel.ev(`[...document.querySelectorAll('.sec-chev, .switch .knob')].map((e) => getComputedStyle(e).transitionDuration).filter((t) => t.split(',').some((x) => parseFloat(x) > 0))`)
    check('panel ' + page + ' reduced motion: no chevron or switch animation', !d.length, d)
    await emulateReduce(panel, false)
    panel.c.close()
  }
  await setPanel(mp, false)
  await emulateReduce(rail, true); await sleep(200)
  const rd = await rail.ev(`getComputedStyle(document.querySelector('.panel')).transitionDuration`)
  check('rail reduced motion: the rail opens without a slide', rd.split(',').every((t) => parseFloat(t) === 0), rd)
  await emulateReduce(rail, false)
  rail.c.close()

  // --- the lyrics window: test lyrics as the feed would send them (its own pushes held back) ---
  if (!(await winOpen(mp, 'Lyrics'))) { await mp.ev(viewCommand('rail', 'lyrics')); await sleep(2500) }
  let page = await target('lyrics.html')
  const holdLyrics = () => mp.ev(`(() => { const wc = ${E}.BrowserWindow.getAllWindows().find((w) => w.getTitle().includes('Lyrics')).webContents
    if (!wc.__origSend) { wc.__origSend = wc.send; wc.send = function (ch, ...a) { if (/^lyrics-(time|data)$/.test(ch) && a[a.length - 1] !== '__test') return; return wc.__origSend.call(wc, ch, ...a.filter((x) => x !== '__test')) } }
    return true })()`)
  await holdLyrics()
  const send = (ch, ...a) => mp.ev(`(() => { const w = ${E}.BrowserWindow.getAllWindows().find((w) => w.getTitle().includes('Lyrics')); w.webContents.send(${JSON.stringify(ch)}, ...${JSON.stringify(a)}, '__test'); return true })()`)
  await mp.ev(`(() => { const w = ${E}.BrowserWindow.getAllWindows().find((w) => w.getTitle().includes('Lyrics')); w.setBounds({ x: 0, y: 0, width: 380, height: 560 }); return true })()`)
  const words = (t, text) => text.split(' ').map((w, i) => ({ t: t + i * 0.8, end: t + i * 0.8 + 0.7, text: w }))
  const LYR = { title: 'Keyboard check', artist: 'Sonata', album: 'Test', duration: 120, source: 'apple', status: '', estimate: false, refined: false, aligned: false, lang: 'en',
    lines: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((i) => ({ t: i * 6, end: i * 6 + 5, text: 'Remembering beautiful yesterday number ' + (i + 1), words: words(i * 6, 'Remembering beautiful yesterday number ' + (i + 1)) })) }
  await send('lyrics-data', LYR); await send('lyrics-time', 13.1, false); await sleep(800)
  const lv = await page.ev(A11Y_RULES('#card'))
  check('lyrics: offline rule set', !lv.length, lv)
  const lyWant = await page.ev(TABBABLES('#card'))
  await page.ev('(document.activeElement && document.activeElement.blur(), true)')
  await focusWin(mp, 'Lyrics'); await sleep(300)
  const lyStops = await walkKeys(page, 'tab', lyWant.length + 2, { back: 'shift+tab' })
  judgeStops('lyrics (Tab)', lyStops, lyWant)
  check('lyrics: Tab into the list lands on the sung line (aria-current), named by its words', lyStops.length >= 2 && lyStops[lyStops.length - 1].current === 'true' && /number 3$/.test(lyStops[lyStops.length - 1].label || ''), lyStops)
  // the arrows move between lines; the list doesn't scroll away from the keyboard while it chooses
  const lineStops = await walkKeys(page, 'down', 3)
  check('lyrics: ↓ moves line by line, with the focus ring', lineStops.length === 3 && lineStops.every((s) => s.ring) && /number 6$/.test(lineStops[2].label || ''), lineStops.map((s) => s.label))
  const top0 = await page.ev('document.getElementById("lines").scrollTop')
  await send('lyrics-time', 55, false); await sleep(900)
  const top1 = await page.ev('document.getElementById("lines").scrollTop')
  check('lyrics: while the keyboard chooses a line, the list stays put (the sung line moved on)', Math.abs(top1 - top0) < 2, { top0, top1 })
  x('key', 'home'); await sleep(200)
  const home = await page.ev(FOCUS_NOW)
  x('key', 'end'); await sleep(200)
  const end = await page.ev(FOCUS_NOW)
  check('lyrics: Home / End go to the first / last line', /number 1$/.test(home.label || '') && /number 10$/.test(end.label || ''), [home.label, end.label])
  x('key', 'up'); await sleep(200); x('key', 'Return'); await sleep(500)
  const played = await page.ev(`(() => { const a = document.querySelector('.line[aria-current="true"]'); return a && a.getAttribute('aria-label') })()`)
  check('lyrics: Enter plays from the chosen line (it becomes the sung line)', /number 9$/.test(played || ''), played)
  // a mouse click on a line seeks but shows no ring (the look with a mouse is unchanged)
  const r2 = await page.ev(`(() => { const l = [...document.querySelectorAll('.line')][1]; l.scrollIntoView({ block: 'center', behavior: 'instant' }); const r = l.getBoundingClientRect(); return [Math.round(r.left + 30), Math.round(r.top + r.height / 2)] })()`)
  await sleep(300); x('click', r2[0], r2[1]); await sleep(400)
  const clicked = await page.ev(FOCUS_NOW)
  check('lyrics: a click on a line plays from it and shows no focus ring', clicked && /number 2$/.test(clicked.label || '') && clicked.current === 'true' && !clicked.ring && /none/.test(clicked.outline), clicked)
  // reduced motion: the sung word lights without the pop, no syllable bounce, no smooth scroll
  await send('lyrics-time', 12.9, true); await sleep(500)
  const pop = await page.ev(`(() => { const w = document.querySelector('.line.active > .ly-main .w.now'); const s = w && w.querySelector('.s.now'); return { w: w && getComputedStyle(w).transform, s: s && getComputedStyle(s).transform } })()`)
  await emulateReduce(page, true); await sleep(500)
  const still = await page.ev(`(() => { const w = document.querySelector('.line.active > .ly-main .w.now'); const s = w && w.querySelector('.s.now'); return { w: w && getComputedStyle(w).transform, s: s && getComputedStyle(s).transform, scroll: getComputedStyle(document.getElementById('lines')).scrollBehavior } })()`)
  check('lyrics reduced motion: the sung word lights without the pop or the syllable bounce', ((pop.w && pop.w !== 'none') || (pop.s && pop.s !== 'none')) && still.w === 'none' && (!still.s || still.s === 'none') && still.scroll === 'auto', { normal: pop, reduced: still })
  await emulateReduce(page, false)
  // Esc closes the window; Ctrl+Shift+L in it closes it too
  await focusWin(mp, 'Lyrics'); await sleep(200); x('key', 'Escape'); await sleep(800)
  check('lyrics: Esc closes the window', !(await winOpen(mp, 'Lyrics')))
  page.c.close()
  await mp.ev(viewCommand('rail', 'lyrics')); await sleep(2500)
  await focusWin(mp, 'Lyrics'); await sleep(300); x('key', 'ctrl+shift+l'); await sleep(800)
  check('lyrics: Ctrl+Shift+L in the lyrics window closes it', !(await winOpen(mp, 'Lyrics')))

  // --- the visualizer: no controls, the keys change the scene (said by its status), Esc leaves ---
  await mp.ev(viewCommand('rail', 'visualizer')); await sleep(2500)
  page = await target('visualizer.html')
  const vv = await page.ev(A11Y_RULES('body'))
  check('visualizer: offline rule set', !vv.length, vv)
  await focusWin(mp, 'Visualizer'); await sleep(300)
  const m0 = await page.ev('window.__mode()')
  x('key', 'Right'); await sleep(300)
  const m1 = await page.ev('[window.__mode(), document.getElementById("mode-label").textContent, document.getElementById("mode-label").getAttribute("role")]')
  check('visualizer: → changes the scene, said by its status line', m1[0] !== m0 && m1[1] === m1[0] && m1[2] === 'status', { m0, m1 })
  x('key', 'Left'); await sleep(300)
  check('visualizer: ← goes back', (await page.ev('window.__mode()')) === m0)
  await emulateReduce(page, true); await sleep(300)
  const pr = await page.ev('window.__pace()')
  await emulateReduce(page, false); await sleep(300)
  const pn = await page.ev('window.__pace()')
  check('visualizer reduced motion: the scenes that travel slow to 0.3 (and back to 1 without it)', pr === 0.3 && pn === 1, { reduced: pr, normal: pn })
  await focusWin(mp, 'Visualizer'); await sleep(200); x('key', 'Escape'); await sleep(1000)
  check('visualizer: Esc closes it', !(await winOpen(mp, 'Visualizer')))
  page.c.close()

  // --- the mini player (last: opening it hides the main window) ---
  await mp.ev(viewCommand('rail', 'mini')); await sleep(2500)
  page = await target('miniplayer.html')
  await mp.ev(`(() => { const w = ${E}.BrowserWindow.getAllWindows().find((w) => w.getTitle().includes('Mini')); w.setPosition(0, 0); return true })()`)
  x('move', 700, 300); await sleep(600)
  const mv = await page.ev(A11Y_RULES('#pill'))
  check('mini: offline rule set', !mv.length, mv)
  const miniWant = await page.ev(TABBABLES('#pill'))
  await page.ev('(document.activeElement && document.activeElement.blur(), true)')
  await focusWin(mp, 'Mini'); await sleep(300)
  const miniStops = await walkKeys(page, 'tab', miniWant.length + 2)
  judgeStops('mini (Tab, nothing playing)', miniStops, miniWant)
  const states = await page.ev(`['shuffle', 'repeat', 'lyrics', 'mute'].map((id) => document.getElementById(id).getAttribute('aria-pressed'))`)
  check('mini: the toggles say their state (aria-pressed)', states.every((s) => s === 'true' || s === 'false'), states)
  await emulateReduce(page, true); await sleep(200)
  const md = await page.ev(`['np', 'scrub', 'seek-knob'].map((id) => getComputedStyle(document.getElementById(id)).transitionDuration)`)
  check('mini reduced motion: the scrubber crossfade and knob are instant', md.every((t) => parseFloat(t) === 0), md)
  await emulateReduce(page, false)
  await mp.ev(viewCommand('rail', 'mini')); await sleep(800)
  page.c.close(); mp.c.close()
}

// --- the stage (lyrics.html body.stage): the lyrics window grown into the now-playing screen ---
// Opened from the rail, fed a public-domain song (Oh My Darling, Clementine) with word timing, background
// vocals and an interlude, the song and a 24-song album as Apple's queue would give them. Checks: the three
// columns and their real-data texts (Track 13 of 24, the live chip, Next · in m:ss), contrast / hit targets
// / names / clipping in light/dark x album colour on/off x Glass on/off (screenshots of each), the drag
// regions while both lists are scrolled (Chromium's rule: every element's rect, later wins, scrolled rows
// unclipped), every control visibly doing something (a command to main or a visible change), the keyboard
// (Tab through every control with the focus ring, the queue's arrows), no idle frames while paused, and the
// form: the stage button shrinks it, Ctrl+Shift+S grows it, reopening brings back the form last used.
const CLEMENTINE = [
  'In a cavern, in a canyon', 'Excavating for a mine', 'Dwelt a miner, forty-niner', 'And his daughter Clementine',
  'Oh my darling, oh my darling', 'Oh my darling, Clementine', 'You are lost and gone forever', 'Dreadful sorry, Clementine',
  'Light she was and like a fairy', 'And her shoes were number nine', 'Herring boxes, without topses', 'Sandals were for Clementine',
  'Oh my darling, oh my darling', 'Oh my darling, Clementine', 'You are lost and gone forever', 'Dreadful sorry, Clementine'
]
function stageSong() {
  const lines = []
  let t = 4
  CLEMENTINE.forEach((text, i) => {
    if (i === 8) t += 12   // an interlude: the countdown dots
    const ws = text.split(' ')
    const step = 2.9 / ws.length
    const words = ws.map((w, k) => ({ t: +(t + k * step).toFixed(2), end: +(t + k * step + step * 0.9).toFixed(2), text: w }))
    const line = { t, end: +(t + 3).toFixed(2), text, words }
    // the chorus answers itself: background vocals under it
    if (i >= 4 && i <= 7) { const echo = i === 6 ? 'gone forever' : i % 2 ? 'Clementine' : 'oh my darling'; line.bg = echo.split(' ').map((w, k) => ({ t: +(t + 2.2 + k * 0.4).toFixed(2), end: +(t + 2.55 + k * 0.4).toFixed(2), text: w })) }
    lines.push(line)
    t += 3.1
  })
  return { title: 'Oh My Darling, Clementine', artist: 'The Juniper Lane Band', album: 'Wayfarers: Live at the Gorge', duration: 158, source: 'apple', status: '', estimate: false, refined: false, aligned: true, lang: 'en', writers: ['Traditional'], lines }
}
const STAGE_TRACKS = ['Cotton-Eyed Joe', 'Oh! Susanna', 'Wildwood Flower', 'Swing Low, Sweet Chariot', 'Bury Me Not on the Lone Prairie', 'Down by the Riverside', 'I Ride an Old Paint', 'Old Joe Clark', 'Amazing Grace', 'Will the Circle Be Unbroken', 'Shenandoah', 'Red River Valley', 'Oh My Darling, Clementine', 'The Parting Glass', 'Home on the Range', 'Camptown Races', 'Skip to My Lou', 'Buffalo Gals', 'Arkansas Traveler', 'Turkey in the Straw', 'Wayfaring Stranger', 'John Henry', 'Goodnight, Irene', 'Midnight Special']
const stageQueue = () => ({ position: 12, canPlay: true, container: { type: 'albums', name: 'Wayfarers: Live at the Gorge' },
  items: STAGE_TRACKS.map((title, i) => ({ id: 'pd' + (i + 1), title, artist: 'The Juniper Lane Band', album: 'Wayfarers: Live at the Gorge', duration: 180 + (i * 37) % 420, art: '' }))
    .concat([{ id: 'ap1', title: 'Autoplay Song', artist: 'Someone Else', album: 'Elsewhere', duration: 200, art: '', autoplay: true }]) })

// Chromium's drag regions, as Electron 45 builds them: every element with an app-region, in document
// order, its full rect (a scrolled element's rect is NOT clipped to its scroller), the later one winning.
// -> the winner ('drag' / 'no-drag' / null) at each point
const REGIONS_AT = (points) => `(() => {
  const region = (el) => { const cs = getComputedStyle(el); return cs.getPropertyValue('app-region') || cs.getPropertyValue('-webkit-app-region') || cs.webkitAppRegion || '' }
  const rects = []
  for (const el of document.querySelectorAll('*')) {   /* loop: NOT-WORTH — test only */
    const r = region(el).trim()
    if (r !== 'drag' && r !== 'no-drag') continue
    const cs = getComputedStyle(el)
    if (cs.display === 'none' || el.closest('[hidden]')) continue
    const b = el.getBoundingClientRect()
    if (b.width > 0 && b.height > 0) rects.push([r, b.left, b.top, b.right, b.bottom, el.id || el.className || el.tagName])
  }
  return ${JSON.stringify(points)}.map(([x, y, name]) => { let win = null; for (const r of rects) if (x >= r[1] && x < r[3] && y >= r[2] && y < r[4]) win = r; return { name, x, y, region: win ? win[0] : null, by: win ? String(win[5]).slice(0, 30) : null } })
})()`

// --- the Studio's Montage (montage-ui.js): the tile on and off, the photos behind the lyrics with their
// credit, the words readable over every photo in every theme (measured: the shade the page chose, its real
// token colours, each photo's own darkest and lightest pixel decoded here), the credit opening the photo's
// page through main, "no free photos" / offline said on the tile, reduced motion, and the cost: frames and
// CPU playing, 0 frames paused or hidden. Stand-in photos: the checker's worst-case artworks (hard
// black/white stripes, saturated primaries). With SONATA_TEST_MONTAGE=<artist id>:<album id> in the app's
// environment it also runs the real path (Wikidata, Commons, the disk cache) for that artist, with
// screenshots in light and dark.
async function montageStep(mp, page, send, stageLog, lyrWin, W, H, song, np, T0) {
  const facts = () => page.ev('montage.facts()')
  const tileNow = () => page.ev(`(() => { const t = document.getElementById('t-montage'); return { hidden: t.hidden, pressed: t.getAttribute('aria-pressed'), small: t.querySelector('small').textContent, title: t.title, credit: !document.getElementById('mt-credit').hidden, creditText: document.getElementById('mt-credit').textContent, box: !document.getElementById('montage').hidden, say: document.getElementById('say').textContent } })()`)
  const passMontage = (v) => mp.ev(`(${lyrWin}.webContents.__passMontage = ${!!v}, true)`)
  await passMontage(false)
  await mp.ev(`(() => { const s = ${E}.shell; globalThis.__opened = []; if (!s.__origOpen) { s.__origOpen = s.openExternal; s.openExternal = (u) => { globalThis.__opened.push(u); return Promise.resolve() } } return true })()`)
  let t = await tileNow()
  check('montage: the tile shows on the Studio, off by default ("Off")', !t.hidden && t.pressed === 'false' && t.small === 'Off' && !t.box && !t.credit && (await mp.ev(settingsFile)).montage !== true, t)
  await stageLog()
  await page.ev(`(document.getElementById('t-montage').click(), true)`); await sleep(400)
  let l = await stageLog()
  t = await tileNow()
  check('montage: a click turns it on (remembered) and says it is looking', l.some((x) => x[0] === 'montage' && x[1] === true) && (await mp.ev(settingsFile)).montage === true && t.pressed === 'true' && t.small === 'Looking…', { l, t })

  // the stand-in photos: their extremes decoded here, in full (the checker's own loop, not montage-model.js)
  const files = ['worst-artwork.png', 'light-artwork.png', 'dark-artwork.png'].map((f) => path.join(__dirname, f))
  const EXTREMES = (file) => `(() => {
    const img = ${E}.nativeImage.createFromPath(${JSON.stringify(file)}); const b = img.toBitmap()
    const L = (r, g, bb) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4 }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(bb) }
    let lo = [9, null], hi = [-1, null]
    for (let i = 0; i < b.length; i += 4) { const l = L(b[i + 2], b[i + 1], b[i]); if (l < lo[0]) lo = [l, [b[i + 2], b[i + 1], b[i]]]; if (l > hi[0]) hi = [l, [b[i + 2], b[i + 1], b[i]]] }   /* loop: NOT-WORTH — test only */
    return { lo: lo[1], hi: hi[1], size: img.getSize() }
  })()`
  const ext = {}
  const photos = []
  for (const [i, f] of files.entries()) {
    const x = await mp.ev(EXTREMES(f))
    const id = 'Stand-in ' + (i + 1) + '.png'
    ext[id] = x
    photos.push({ id, src: require('url').pathToFileURL(f).href, author: ['Ann Example', 'Ben Example', 'Cy Example'][i], licence: ['CC BY-SA 4.0', 'CC BY 2.0', 'CC0'][i], licenceUrl: '', title: 'Stand-in ' + (i + 1), page: 'https://commons.wikimedia.org/wiki/File:Stand-in_' + (i + 1) + '.png', lo: x.lo, hi: x.hi })
  }
  const state = { on: true, status: 'ready', offline: false, set: 'test|stand-ins', photos }
  await send('stage-montage', state); await sleep(1200)
  t = await tileNow()
  let f = await facts()
  check('montage: with photos it shows behind the lyrics (tile "On"), the first photo in, its credit: author · licence · Wikimedia Commons', t.pressed === 'true' && t.small === 'On' && t.box && f.visible && f.photo === photos[0].id && t.credit && t.creditText === 'Ann Example · CC BY-SA 4.0 · Wikimedia Commons', { t, f })

  // readable over every photo in every theme: the words over the shade the page chose, over the photo's own extremes
  const MEASURE = `(() => {
    const centre = document.getElementById('lines').getBoundingClientRect()
    const vis = (el) => { const r = el.getBoundingClientRect(); const cs = getComputedStyle(el); return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none' && !el.closest('[hidden]') && r.right > centre.left && r.left < centre.right && r.bottom > 0 && r.top < innerHeight }
    const alphaUp = (el) => { let a = 1; for (let e = el; e && e !== document.body; e = e.parentElement) a *= +getComputedStyle(e).opacity; return a }
    const out = []
    const root = document.documentElement
    const tok = (k) => getComputedStyle(root).getPropertyValue(k).trim()
    for (const rootSel of ['#header', '#band', '#lines', '#mt-credit']) {
      const r = document.querySelector(rootSel); if (!r || r.closest('[hidden]')) continue
      const w = document.createTreeWalker(r, NodeFilter.SHOW_TEXT)
      for (let n = w.nextNode(); n; n = w.nextNode()) {
        if (!n.textContent.trim()) continue
        const el = n.parentElement
        if (!vis(el) || el.closest('svg')) continue
        const a = alphaUp(el); if (a < 0.02) continue
        const cs = getComputedStyle(el)
        const bgs = []
        for (let e = el; e && e !== document.getElementById('card'); e = e.parentElement) { const b = getComputedStyle(e).backgroundColor; if (b && b !== 'rgba(0, 0, 0, 0)') bgs.unshift(b) }
        out.push({ text: n.textContent.trim().slice(0, 24), color: cs.color, a, bgs, where: rootSel, bgv: !!el.closest('.bgv') })
      }
    }
    const shown = [...document.querySelectorAll('#montage .mt-photo')].filter((l) => +l.style.opacity > 0).map((l) => l.dataset.photo)
    return { texts: out, surface: tok('--s-surface'), dim: tok('--s-dim'), scrim: +document.getElementById('montage').style.getPropertyValue('--scrim'), shown }
  })()`
  const judgeMontage = (tag, m, extremes) => {
    const surf = parse(m.surface)
    const low = []
    for (const id of m.shown) {
      const x = extremes[id]
      if (!x) { low.push({ id, why: 'no extremes' }); continue }
      for (const tx of m.texts) {
        const c = parse(tx.color)
        const d = parse(m.dim)
        const need = d && c.rgb.every((v, i) => Math.abs(v - d.rgb[i]) <= 1) ? 3 : 4.5   // the quiet lines: 3:1
        const layers = [{ rgb: surf.rgb, a: m.scrim }].concat(tx.bgs.map(parse).filter(Boolean))
        const r = worstOver({ rgb: c.rgb, a: c.a * tx.a }, layers, [x.lo, x.hi])
        if (r < (tx.bgv ? 3 : need)) low.push({ id, text: tx.text, where: tx.where, ratio: +r.toFixed(2), need: tx.bgv ? 3 : need, bgv: tx.bgv })
      }
    }
    // backing vocals on unsung lines are judged on their own, as in the stage's theme loop (being reworked on backing-vocals-b)
    check(tag + ' every word over the montage meets its contrast (4.5:1, quiet lines 3:1) over the photo\'s darkest and lightest pixel (shade ' + m.scrim + ', ' + m.texts.length + ' texts, photos ' + m.shown.join(', ') + ')', m.shown.length > 0 && m.texts.length > 5 && m.scrim > 0 && !low.some((x) => !x.bgv), low.filter((x) => !x.bgv).slice(0, 6))
    const lowBg = low.filter((x) => x.bgv)
    check(tag + ' backing vocals over the montage >= 3:1 (pre-existing in lyrics-view.css; owned by backing-vocals-b)', !lowBg.length, lowBg.slice(0, 4))
  }
  for (const adaptive of [true, false]) {
    for (const glass of [true, false]) {
      await mp.ev(viewCommand('panel', 'set', 'adaptiveColor', adaptive)); await mp.ev(viewCommand('panel', 'set', 'glass', glass)); await sleep(700)
      for (const dark of [false, true]) {
        await mp.ev(`(${E}.nativeTheme.themeSource = ${JSON.stringify(dark ? 'dark' : 'light')}, true)`); await sleep(900)
        const tag = 'montage-' + (dark ? 'dark' : 'light') + (adaptive ? '-album' : '-plain') + (glass ? '-glass' : '')
        await send('lyrics-time', T0, false); await sleep(400)
        judgeMontage(tag, await page.ev(MEASURE), ext)
        xshot(path.join(OUT, tag + '.png'), W, H)
      }
    }
  }
  // the credit asks main by the photo's id; main opens only a photo it sent itself (these stand-ins came from
  // the checker, so nothing opens; the real path below checks the page opening)
  await stageLog()
  await page.ev(`(document.getElementById('mt-credit').click(), true)`); await sleep(400)
  l = await stageLog()
  const opened = await mp.ev('globalThis.__opened.splice(0)')
  check('montage: the credit line asks main for the photo\'s page by its id; main opens nothing it didn\'t send', l.length === 1 && l[0][0] === 'montage-credit' && l[0][1] === photos[0].id && opened.length === 0, { l, opened })

  // playing: the pan runs at 10 Hz; paused, hidden or minimised: nothing
  const pids = await mp.ev(`${E}.app.getAppMetrics().map((m) => m.pid)`)
  const frames = async (ms) => {
    let n = 0
    const on = (m) => { if (m.method === 'Page.screencastFrame') { n++; page.c.send('Page.screencastFrameAck', { sessionId: m.params.sessionId }).catch(() => {}) } }
    page.c.on(on)
    await page.c.send('Page.startScreencast', { format: 'jpeg', quality: 10, everyNthFrame: 1 })
    await sleep(600); n = 0; await sleep(ms)
    await page.c.send('Page.stopScreencast')
    return n
  }
  // the lyrics feed as main sends it while a song plays (2/s), from the main process (this test copy only)
  // from 120 s on (after the song's last line, so the lyrics engine is quiet and the frames are the montage's own)
  const play = (on, from) => mp.ev(`(() => { clearInterval(globalThis.__play); if (${!!on}) { let t = ${from || T0}; globalThis.__play = setInterval(() => { t += 0.5; const wc = ${lyrWin}.webContents; wc.__origSend.call(wc, 'lyrics-time', t, true) }, 500) } return true })()`)
  x('move', 1500, 900)
  await play(true, 120); await sleep(3000)
  await send('stage-montage', { on: false, status: 'off', photos: [] }); await sleep(1500)
  const fpsOff = (await frames(5000)) / 5
  const cpuOff = +(await cpu(pids, 10000)).toFixed(2)
  await send('stage-montage', state); await sleep(1500)
  f = await facts()
  const fpsOn = (await frames(5000)) / 5
  const cpuOn = +(await cpu(pids, 10000)).toFixed(2)
  check('montage: playing, the pan runs at its reduced rate (' + fpsOn + ' frames/s with the lyrics quiet, ' + fpsOff + ' without the montage)', f.running && f.clock > 0 && fpsOn - fpsOff >= 6 && fpsOn - fpsOff <= 14, { f, fpsOn, fpsOff })
  results.push({ name: 'montage cost (table, this machine, Xvfb, software GL; the lyrics quiet)', ok: true, detail: { playingWithMontage: { framesPerSecond: fpsOn, cpuPercentOfOneCore: cpuOn }, playingWithout: { framesPerSecond: fpsOff, cpuPercentOfOneCore: cpuOff } } })
  await play(false); await send('lyrics-time', T0 + 30, false); await sleep(1200)
  f = await facts()
  const nPaused = await frames(5000)
  const cpuPaused = +(await cpu(pids, 10000)).toFixed(2)
  check('montage: paused, no timer and 0 frames for 5 s (on, photos showing)', !f.running && f.visible && nPaused === 0, { f, frames: nPaused, cpu: cpuPaused })
  results.push({ name: 'montage cost paused (table)', ok: true, detail: { framesIn5s: nPaused, cpuPercentOfOneCore: cpuPaused } })
  // hidden (minimised) while playing: the timer stops
  await play(true); await sleep(800)
  await mp.ev(`(${lyrWin}.minimize(), true)`); await sleep(1500)
  // Xvfb has no window manager to iconify a window: then hidden (the same 'hidden' document)
  let how = 'minimised'
  if (await page.ev('document.visibilityState') === 'visible') { how = 'hidden (no window manager to minimise under Xvfb)'; await mp.ev(`(${lyrWin}.hide(), true)`); await sleep(1500) }
  const hid = await page.ev(`[document.visibilityState, montage.facts().running]`)
  const nHidden = await frames(3000)
  const cpuHidden = +(await cpu(pids, 10000)).toFixed(2)
  await mp.ev(`(() => { const w = ${lyrWin}; if (w.isMinimized()) w.restore(); w.showInactive(); return true })()`); await sleep(1500)
  const back = await page.ev('montage.facts().running')
  await play(false); await send('lyrics-time', T0 + 30, false); await sleep(600)
  check('montage: ' + how + ' while playing, the pan stops (document hidden, no timer, 0 frames); shown again, it runs again', hid[0] === 'hidden' && hid[1] === false && nHidden === 0 && back === true, { hid, back, nHidden, cpuHidden })
  results.push({ name: 'montage cost ' + how + ' while playing (table)', ok: true, detail: { framesIn3s: nHidden, cpuPercentOfOneCore: cpuHidden } })

  // reduced motion: no pan or zoom, a slow cross-fade
  await page.c.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] }); await sleep(600)
  f = await facts()
  check('montage: reduced motion: no pan or zoom (no transform), the cross-fade is CSS\'s', f.visible && f.layers.every((y) => !y.transform || y.transform === 'none') && (await page.ev(`document.getElementById('montage').classList.contains('calm')`)), f)
  await page.c.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] }); await sleep(400)

  // nothing found / offline: the tile says so and the montage stays off
  await send('stage-montage', { on: true, status: 'none', photos: [] }); await sleep(500)
  t = await tileNow()
  check('montage: no free photos for the artist: the tile says so ("No free photos"), not pressed, nothing behind the lyrics, said to screen readers', t.small === 'No free photos' && t.pressed === 'false' && !t.box && !t.credit && /No free photos found for this artist/.test(t.title) && /No free photos found for this artist/.test(t.say), t)
  await stageLog()
  await page.ev(`(document.getElementById('t-montage').click(), true)`); await sleep(300)
  l = await stageLog()
  check('montage: a click then looks again', l.some((y) => y[0] === 'montage' && y[1] === true) && (await tileNow()).small === 'Looking…', l)
  await send('stage-montage', { on: true, status: 'offline', photos: [] }); await sleep(400)
  t = await tileNow()
  check('montage: offline with nothing saved: the tile says "Offline"', t.small === 'Offline' && t.pressed === 'false' && !t.box, t)
  await send('stage-montage', Object.assign({}, state, { offline: true })); await sleep(600)
  t = await tileNow()
  check('montage: offline with saved photos: they show, the tile says so ("On · saved")', t.small === 'On · saved' && t.box && t.credit, t)

  // the real path for one artist (only with SONATA_TEST_MONTAGE in the app's environment)
  const real = await mp.ev(`process.env.SONATA_TEST_MONTAGE || ''`)
  if (real) {
    const name = await mp.ev(`process.env.SONATA_TEST_MONTAGE_NAME || ''`)
    await send('stage-np', Object.assign({}, np, { artist: name || np.artist }))
    await send('lyrics-data', Object.assign({}, song, { artist: name || song.artist }))
    await send('lyrics-time', T0, false)
    await passMontage(true)
    await mp.ev(viewCommand('panel', 'set', 'adaptiveColor', true)); await sleep(300)
    await page.ev(`(() => { const t = document.getElementById('t-montage'); if (t.getAttribute('aria-pressed') === 'true') t.click(); return true })()`); await sleep(600)
    await page.ev(`(document.getElementById('t-montage').click(), true)`)
    const t0 = Date.now()
    let st = null
    while (Date.now() - t0 < 120000) {
      st = await page.ev(`(() => { const f = montage.facts(); return { f, small: document.getElementById('t-montage').querySelector('small').textContent } })()`)
      if (st.f.visible && /^On/.test(st.small)) break
      await sleep(1000)
    }
    await sleep(8000)   // the rest of the photos (one at a time)
    const realPhotos = await page.ev(`[...document.querySelectorAll('#montage .mt-photo')].map((l) => l.src)`)
    check('montage (real, ' + real + '): photos from Wikimedia Commons show behind the lyrics with their credit', st && st.f.visible && /^On/.test(st.small), st)
    const realExt = {}
    const shownNow = await page.ev(`[...document.querySelectorAll('#montage .mt-photo')].map((l) => [l.dataset.photo, l.src])`)
    for (const [id, src] of shownNow) if (id && src) realExt[id] = await mp.ev(EXTREMES(require('url').fileURLToPath(src)))
    for (const dark of [false, true]) {
      await mp.ev(`(${E}.nativeTheme.themeSource = ${JSON.stringify(dark ? 'dark' : 'light')}, true)`); await sleep(1200)
      judgeMontage('montage real ' + (dark ? 'dark' : 'light'), await page.ev(MEASURE), realExt)
      xshot(path.join(OUT, 'montage-real-' + (dark ? 'dark' : 'light') + '.png'), W, H)
    }
    await mp.ev('globalThis.__opened.splice(0)')
    const creditId = await page.ev(`document.getElementById('mt-credit').dataset.photo`)
    await page.ev(`(document.getElementById('mt-credit').click(), true)`); await sleep(500)
    const opened2 = await mp.ev('globalThis.__opened.splice(0)')
    check('montage (real): the credit line opens that photo\'s Commons page in the browser, through main', opened2.length === 1 && /^https:\/\/commons\.wikimedia\.org\/wiki\/File:/.test(opened2[0]) && decodeURIComponent(opened2[0].slice(40)).replace(/_/g, ' ') === creditId, { creditId, opened2 })
    results.push({ name: 'montage real credits (table)', ok: true, detail: { credit: await page.ev(`document.getElementById('mt-credit').textContent`), layers: realPhotos.length } })
    await passMontage(false)
  }

  // off again: a click; nothing behind the lyrics, no timer, remembered
  await send('stage-montage', state); await sleep(500)
  await stageLog()
  await page.ev(`(document.getElementById('t-montage').click(), true)`); await sleep(500)
  l = await stageLog()
  t = await tileNow()
  f = await facts()
  check('montage: a click turns it off: nothing behind the lyrics, no credit, no timer, remembered', l.some((y) => y[0] === 'montage' && y[1] === false) && t.pressed === 'false' && t.small === 'Off' && !t.box && !t.credit && !f.running && (await mp.ev(settingsFile)).montage === false, { l, t, f })
  await mp.ev(viewCommand('panel', 'set', 'adaptiveColor', true)); await mp.ev(viewCommand('panel', 'set', 'glass', true))
  await mp.ev(`(${E}.nativeTheme.themeSource = 'dark', true)`); await sleep(800)
  await mp.ev(`(() => { const s = ${E}.shell; if (s.__origOpen) { s.openExternal = s.__origOpen; delete s.__origOpen } return true })()`)
}

async function stage() {
  const mp = await mainProc()
  // the commands the stage sends main (this test copy only): a second listener beside main's own
  await mp.ev(`(() => { const { ipcMain } = ${E}; if (!globalThis.__stageLog) ipcMain.on('stage-command', (e, c, v) => globalThis.__stageLog.push([c, v])); globalThis.__stageLog = []; return true })()`)
  const stageLog = () => mp.ev('globalThis.__stageLog.splice(0)')
  await mp.ev(viewCommand('rail', 'stage')); await sleep(3000)
  check('stage: the rail\'s Stage item opens the lyrics window as the stage', (await mp.ev(settingsFile)).lyricsStage === true && await winOpen(mp, 'Lyrics'))
  const panelShown = async () => mp.ev(`${settingsFile}.panelShown`)
  if (!(await panelShown())) { await mp.ev(viewCommand('rail', 'settings')); await sleep(2500) }
  const page = await target('lyrics.html')
  const lyrWin = `${E}.BrowserWindow.getAllWindows().find((w) => w.getTitle().includes('Lyrics'))`
  await mp.ev(`(() => { const wc = ${lyrWin}.webContents
    if (!wc.__origSend) { wc.__origSend = wc.send; wc.send = function (ch, ...a) { if ((/^(lyrics-(time|data)|stage-(np|queue))$/.test(ch) || (ch === 'stage-montage' && !wc.__passMontage)) && a[a.length - 1] !== '__test') return; return wc.__origSend.call(wc, ch, ...a.filter((x) => x !== '__test')) } }
    return true })()`)
  const send = (ch, ...a) => mp.ev(`(${lyrWin}.webContents.send(${JSON.stringify(ch)}, ...${JSON.stringify(a)}, '__test'), true)`)
  const W = 1240; const H = 780
  const b = await mp.ev(`(() => { const w = ${lyrWin}; w.setBounds({ x: 0, y: 0, width: ${W}, height: ${H} }); return w.getBounds() })()`)
  check('stage: the window takes the stage size (min 980 x 620)', b.width === W && b.height === H, b)
  const art = require('url').pathToFileURL(path.resolve(process.env.SONATA_TEST_ARTWORK || path.join(__dirname, 'dark-artwork.png'))).href
  const song = stageSong()
  const np = { title: song.title, artist: song.artist, album: song.album, art, duration: song.duration, isPlaying: false, shuffle: false, repeat: 0, volume: 0.7, releaseDate: '2026-05-01' }
  const T0 = 26.2
  const feed = async (t) => { await send('lyrics-data', song); await send('stage-np', np); await send('stage-queue', stageQueue()); await send('lyrics-time', t, false); await sleep(900) }
  await feed(T0)

  // --- the columns and their real-data texts ---
  const facts = await page.ev(`(() => {
    const r = (id) => { const e = document.getElementById(id); const b = e.getBoundingClientRect(); return [Math.round(b.left), Math.round(b.right), Math.round(b.width)] }
    const tx = (id) => document.getElementById(id).textContent
    return { stage: document.body.classList.contains('stage'), np: r('np'), lines: r('lines'), queue: r('queue'), size: getComputedStyle(document.querySelector('.line')).fontSize,
      ctx: tx('ctx'), track: tx('chip-track'), live: tx('chip-live'), nextIn: tx('next-in'), nextT: tx('next-t'), title: tx('np-title'), album: tx('np-album'), tabAll: tx('tab-all'),
      rows: document.querySelectorAll('#q-list .q-row').length, firstRow: (document.querySelector('#q-list .q-row .t') || {}).textContent, footL: tx('q-foot-l'), footR: tx('q-foot-r'),
      band: document.getElementById('band').hidden, layers: document.getElementById('layers').hidden, montage: document.getElementById('t-montage').hidden, liner: document.getElementById('t-liner').hidden,
      tElapsed: tx('t-el'), tRem: tx('t-rem'), hScroll: [document.getElementById('lines'), document.getElementById('q-list')].map((e) => e.scrollWidth > e.clientWidth + 1) }
  })()`)
  check('stage: three columns: the song (292 px), the lyrics between, what plays next (312 px)', facts.stage && facts.np[2] === 292 && facts.queue[2] === 312 && facts.np[1] <= facts.lines[0] + 1 && facts.lines[1] <= facts.queue[0] + 1, facts)
  check('stage: the lyrics are big (31 px) in the middle', facts.size === '31px', facts.size)
  check('stage: "Track 13 of 24" from the queue (the autoplay song not counted), the live chip from the album title', facts.track === 'Track 13 of 24' && facts.footL === 'Track 13 of 24' && facts.live === 'Live · The Gorge', facts)
  const left = Math.ceil(song.duration - T0)
  check('stage: the next card counts down the playing song (Next · in ' + Math.floor(left / 60) + ':' + String(left % 60).padStart(2, '0') + ') and names the next song', facts.nextIn === 'Next · in ' + Math.floor(left / 60) + ':' + String(left % 60).padStart(2, '0') && facts.nextT === 'The Parting Glass', facts)
  check('stage: Up Next lists the 12 songs after it plus the autoplay one; Playing from the album; the Playlist tab counts 24', facts.rows === 12 && facts.firstRow.startsWith('The Parting Glass') && facts.ctx === 'Playing from Wayfarers: Live at the Gorge' && facts.tabAll === 'Playlist · 24', facts)
  check('stage: no empty boxes or dead controls (no sheet notes yet: no band; the Montage tile shows (its row with it); Liner notes hidden until it\'s merged)', facts.band && !facts.layers && !facts.montage && facts.liner, facts)
  check('stage: neither list scrolls sideways', facts.hScroll.every((h) => !h), facts.hScroll)

  // --- every theme: light/dark x album colour on/off x Glass on/off ---
  for (const adaptive of [true, false]) {
    for (const glass of [true, false]) {
      await mp.ev(viewCommand('panel', 'set', 'adaptiveColor', adaptive)); await mp.ev(viewCommand('panel', 'set', 'glass', glass)); await sleep(700)
      for (const dark of [false, true]) {
        await mp.ev(`(${E}.nativeTheme.themeSource = ${JSON.stringify(dark ? 'dark' : 'light')}, true)`); await sleep(900)
        const tag = 'stage-' + (dark ? 'dark' : 'light') + (adaptive ? '-album' : '-plain') + (glass ? '-glass' : '')
        await send('lyrics-time', T0, false); await sleep(500)
        xshot(path.join(OUT, tag + '.png'), W, H)
        const a = await page.ev(PAGE_AUDIT('#card'))
        // backing vocals on unsung lines are judged on their own (below): their look is being reworked on
        // branch backing-vocals-b (lyrics-view.css .bgv opacity 0.7 over the dim colour, the same in the lyrics window)
        judge(tag, Object.assign({}, a, { texts: a.texts.filter((t) => !t.bgv) }), { minHit: 24 })
        const bg = a.texts.filter((t) => t.bgv).map((t) => ({ text: t.text, ratio: +worstOver(parse(t.color), t.layers.map(parse).filter(Boolean), a.backdrop || [[255, 255, 255], [0, 0, 0]]).toFixed(2) }))
        const lowBg = bg.filter((x) => x.ratio < 3)
        check(tag + ' backing vocals >= 3:1 (pre-existing in lyrics-view.css; owned by backing-vocals-b)', !lowBg.length, lowBg.slice(0, 4))
        const cols = await page.ev(`(() => { const out = []; for (const id of ['np', 'queue']) { const c = document.getElementById(id).getBoundingClientRect(); for (const e of document.getElementById(id).querySelectorAll('*')) { const r = e.getBoundingClientRect(); if (r.width && !e.matches('.bar > span') && (r.left < c.left - 1 || r.right > c.right + 1) && !e.closest('[hidden]')) out.push(id + ' ' + (e.id || e.className)) } } return out })()`)
        check(tag + ' nothing spills out of the side columns', !cols.length, cols.slice(0, 6))
      }
    }
  }
  await mp.ev(viewCommand('panel', 'set', 'adaptiveColor', true)); await mp.ev(viewCommand('panel', 'set', 'glass', true)); await sleep(600)
  await mp.ev(`(${E}.nativeTheme.themeSource = 'dark', true)`); await sleep(800)
  // the Playlist tab and a duet moment for the record
  await page.ev(`(document.getElementById('tab-all').click(), true)`); await sleep(400)
  xshot(path.join(OUT, 'stage-dark-playlist.png'), W, H)
  await page.ev(`(document.getElementById('tab-next').click(), true)`); await sleep(300)

  // --- drag regions while both lists are scrolled: late in the song (lines scrolled up over the header) ---
  await send('lyrics-time', 60.5, false); await sleep(1200)
  await page.ev(`(document.getElementById('tab-all').click(), true)`); await sleep(400)
  await page.ev(`(() => { const q = document.getElementById('q-list'); q.scrollTop = q.scrollHeight; return q.scrollTop })()`); await sleep(300)
  const pts = await page.ev(`(() => {
    const c = (id) => { const r = document.getElementById(id).getBoundingClientRect(); return [Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2), id] }
    const ctx = document.getElementById('ctx').getBoundingClientRect()
    const qt = document.getElementById('q-title').getBoundingClientRect()
    const vol = document.getElementById('vol').getBoundingClientRect()
    const lines = document.getElementById('lines').getBoundingClientRect()
    const above = [...document.querySelectorAll('#lines .line')].filter((l) => l.getBoundingClientRect().bottom < lines.top).length
    return { above, scrolled: document.getElementById('q-list').scrollTop, points: [[Math.round(ctx.left + 20), Math.round(ctx.top + ctx.height / 2), 'header (playing from)'], [Math.round(ctx.right - 4), Math.round(ctx.top + 3), 'header (right end)'], [Math.round(qt.left + 10), Math.round(qt.top + qt.height / 2), 'queue title'], [Math.round(vol.left + 40), Math.round(vol.bottom + 30), 'left column below the volume'],
      c('form'), c('close'), c('tab-next'), c('tab-all'), c('b-play'), c('seek-bar'), c('vol-bar'), [Math.round(lines.left + 60), Math.round(lines.top + 120), 'a lyric line'], c('q-list')] }
  })()`)
  const reg = await page.ev(REGIONS_AT(pts.points))
  await page.ev(`(document.getElementById('tab-next').click(), true)`); await sleep(300)
  const want = (n) => /header|queue title|left column/.test(n) ? 'drag' : 'no-drag'
  const wrong = reg.filter((r) => r.region !== want(r.name))
  check('stage drag regions (lyrics scrolled ' + pts.above + ' lines up over the header, the queue scrolled ' + pts.scrolled + ' px): the header, the queue\'s title and the left column drag; every control and both lists don\'t', pts.above >= 3 && pts.scrolled > 0 && !wrong.length, { wrong, all: reg })

  // --- every control does something you can see or hear ---
  await send('lyrics-time', T0, false); await sleep(600)
  await stageLog()
  const clicks = [['b-shuffle', 'shuffle'], ['b-prev', 'previous'], ['b-play', 'play-pause'], ['b-next', 'next'], ['b-repeat', 'repeat']]
  const got = {}
  for (const [id, cmd] of clicks) { await page.ev(`(document.getElementById(${JSON.stringify(id)}).click(), true)`); await sleep(250); const l = await stageLog(); got[id] = l.map((x) => x[0]).join(','); check('stage: ' + id + ' sends "' + cmd + '" to the player', got[id] === cmd, l) }
  await page.ev(`(document.getElementById('seek-bar').focus(), true)`); await focusWin(mp, 'Lyrics'); await sleep(200)
  x('key', 'Right'); await sleep(300)
  let l = await stageLog()
  check('stage: → on the song position seeks 5 s on', l.length === 1 && l[0][0] === 'seek' && Math.abs(l[0][1] - (T0 + 5)) < 0.6, l)
  await page.ev(`(document.getElementById('vol-bar').focus(), true)`); await sleep(150)
  x('key', 'Left'); await sleep(300)
  l = await stageLog()
  check('stage: ← on the volume turns it down 5 %', l.length === 1 && l[0][0] === 'volume' && Math.abs(l[0][1] - 0.65) < 0.011, l)
  const sb = await page.ev(`(() => { const r = document.getElementById('seek-bar').getBoundingClientRect(); return [Math.round(r.left + r.width * 0.5), Math.round(r.top + r.height / 2)] })()`)
  x('click', sb[0], sb[1]); await sleep(300)
  l = await stageLog()
  check('stage: a click half way along the song position seeks to the middle', l.length >= 1 && l[l.length - 1][0] === 'seek' && Math.abs(l[l.length - 1][1] - song.duration / 2) < 3, l)
  await send('lyrics-time', T0, false); await sleep(300)
  await page.ev(`(document.querySelector('#q-list button.q-row').click(), true)`); await sleep(300)
  l = await stageLog()
  check('stage: a click on an Up Next song asks to play that place in the queue (index and id, checked again in Apple\'s page)', l.length === 1 && l[0][0] === 'play-item' && l[0][1].index === 13 && l[0][1].id === 'pd14', l)
  await page.ev(`(document.getElementById('tab-all').click(), true)`); await sleep(300)
  const tabbed = await page.ev(`[document.getElementById('q-title').textContent, document.getElementById('tab-all').getAttribute('aria-pressed'), document.querySelectorAll('#q-list .q-row').length, !!document.querySelector('#q-list .q-row.cur'), document.getElementById('next-card').hidden]`)
  check('stage: the Playlist tab shows the whole album with the song playing marked (the next card steps aside)', tabbed[0] === 'Playlist' && tabbed[1] === 'true' && tabbed[2] === 25 && tabbed[3] && tabbed[4], tabbed)
  await page.ev(`(document.getElementById('tab-next').click(), true)`); await sleep(300)
  // every visible control was exercised (a control not in this list would be untested: it fails here)
  const ctrls = await page.ev(`[...document.querySelectorAll('#card button, #card [role=slider], #card [role=button]')].filter((e) => { const r = e.getBoundingClientRect(); return r.width && r.height && !e.closest('[hidden]') && getComputedStyle(e).display !== 'none' }).map((e) => e.id || e.className)`)
  // t-montage and mt-credit: the Montage step below exercises them
  const known = new Set(['b-shuffle', 'b-prev', 'b-play', 'b-next', 'b-repeat', 'seek-bar', 'vol-bar', 'tab-next', 'tab-all', 'q-row', 'form', 'close', 'line', 't-montage', 'mt-credit'])
  const untested = ctrls.filter((c) => !known.has(String(c).split(' ')[0]))
  check('stage: every visible control is one this check exercised (no dead or untested controls)', !untested.length, untested)
  // read-only when Apple's player has no way to jump: no buttons, and it says so
  await send('stage-queue', Object.assign(stageQueue(), { canPlay: false })); await sleep(400)
  const ro = await page.ev(`[document.querySelectorAll('#q-list button').length, document.getElementById('q-note').hidden, document.getElementById('q-note').textContent]`)
  check('stage: without changeToMediaAtIndex the list is read-only and says so', ro[0] === 0 && !ro[1] && /Read-only/.test(ro[2]), ro)
  await send('stage-queue', stageQueue()); await sleep(400)

  // --- the keyboard: Tab reaches every control in DOM order with the ring; the queue's arrows ---
  const lyWant = await page.ev(TABBABLES('#card'))
  // the keyboard starts from the top of the page (a blur keeps the old element as Tab's starting point)
  await page.ev(`(() => { const t = document.createElement('div'); t.tabIndex = -1; document.body.prepend(t); t.focus(); t.remove(); return true })()`)
  await focusWin(mp, 'Lyrics'); await sleep(300)
  const stops = await walkKeys(page, 'tab', lyWant.length + 2, { back: 'shift+tab' })
  judgeStops('stage (Tab)', stops, lyWant)
  const rules = await page.ev(A11Y_RULES('#card'))
  check('stage: offline rule set (roles, names, ids, nothing focusable hidden)', !rules.length, rules)
  await page.ev(`(document.querySelector('#q-list button.q-row').focus({ focusVisible: true }), true)`); await sleep(150)
  const rows = await walkKeys(page, 'down', 2)
  check('stage: ↓ in the queue moves song by song, with the focus ring', rows.length === 2 && rows.every((s) => s.ring) && /Home on the Range/.test(rows[0].label || '') && /Camptown Races/.test(rows[1].label || ''), rows.map((s) => s.label))

  // --- idle: paused, nothing repaints ---
  await page.ev('(document.activeElement && document.activeElement.blur(), true)')
  x('move', 1500, 900); await sleep(1500)
  let n = 0
  page.c.on((m) => { if (m.method === 'Page.screencastFrame') { n++; page.c.send('Page.screencastFrameAck', { sessionId: m.params.sessionId }).catch(() => {}) } })
  await page.c.send('Page.startScreencast', { format: 'jpeg', quality: 10, everyNthFrame: 1 })
  await sleep(1000); n = 0; await sleep(5000)
  await page.c.send('Page.stopScreencast')
  check('stage: paused, no frames for 5 s (nothing animates on its own)', n === 0, { frames: n })

  await montageStep(mp, page, send, stageLog, lyrWin, W, H, song, np, T0)

  // --- the form: the stage button shrinks it, Ctrl+Shift+S grows it, reopening brings back the last form ---
  await page.ev(`(document.getElementById('form').click(), true)`); await sleep(1500)
  const small = await mp.ev(`(() => { const w = ${lyrWin}; return Object.assign(w.getBounds(), { min: w.getMinimumSize() }) })()`)
  const sf = await page.ev(`[document.body.classList.contains('stage'), document.getElementById('np').hidden, document.getElementById('form').getAttribute('aria-pressed')]`)
  check('stage: the stage button shrinks it back to the lyrics window (its own size and minimum)', small.width < 600 && small.min[0] === 260 && !sf[0] && sf[1] && sf[2] === 'false' && (await mp.ev(settingsFile)).lyricsStage === false, { small, sf })
  xshot(path.join(OUT, 'stage-shrunk-compact.png'), small.width + small.x, small.height + small.y)
  await focusWin(mp, 'Lyrics'); await sleep(200); x('key', 'ctrl+shift+s'); await sleep(1500)
  const big = await mp.ev(`(() => { const w = ${lyrWin}; return Object.assign(w.getBounds(), { min: w.getMinimumSize() }) })()`)
  check('stage: Ctrl+Shift+S grows it into the stage again, at the size it had', big.width === W && big.height === H && big.min[0] === 980 && (await page.ev(`document.body.classList.contains('stage')`)), big)
  await focusWin(mp, 'Lyrics'); await sleep(200); x('key', 'Escape'); await sleep(1000)
  check('stage: Esc closes it', !(await winOpen(mp, 'Lyrics')))
  page.c.close()
  await mp.ev(viewCommand('rail', 'lyrics')); await sleep(2500)
  const page2 = await target('lyrics.html')
  check('stage: the lyrics item reopens it in the form last used (the stage)', await page2.ev(`document.body.classList.contains('stage')`))
  // back to the lyrics window for the other phases, then closed
  await page2.ev(`(document.getElementById('form').click(), true)`); await sleep(1200)
  await mp.ev(viewCommand('rail', 'lyrics')); await sleep(800)
  page2.c.close(); mp.c.close()
}

;(async () => {
  fs.mkdirSync(OUT, { recursive: true })
  const phases = { matrix, keys, loops, perf, mini, lyrics, a11y, stage }
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
