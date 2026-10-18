// Audits for tools/ui-check.js's `every` phase, one per rule, run in any Sonata page through CDP:
//   - dead controls ("no controls that do nothing"): every visible control has a handler for what it
//     does, on itself or delegated from an ancestor (DOMDebugger.getEventListeners, not a guess from
//     markup: navigation is blocked in Sonata's windows, so even a link needs its handler);
//   - theme tokens ("one theme system"): every colour the page paints (text, background, border, outline,
//     shadow, SVG fill and stroke) is the value of a --s-* token, except the physical things CLAUDE.md
//     names (the vinyl, the visualizer's night stage, the 42PS brand colours in Credits);
//   - overflow and clipping: the page doesn't scroll sideways, no text or control sits outside the window,
//     and no text is cut by a box that hides overflow (scrollers and ellipsis-with-tooltip are fine).
// Kept apart from ui-check.js's own phases (other work edits those); each audit returns plain rows that
// ui-check.js turns into checks.
'use strict'

// --- dead controls ---
// the controls, plus every ancestor up to the document, collected in the page for getEventListeners
const CONTROLS = (rootSel) => `(() => {
  const root = document.querySelector(${JSON.stringify(rootSel)}) || document.body
  const vis = (el) => { const r = el.getBoundingClientRect(); const cs = getComputedStyle(el); return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none' && !el.closest('[hidden]') }
  const ctl = [...root.querySelectorAll('button, select, input, textarea, a[href], summary, [role=button], [role=switch], [role=slider], [role=menuitem], [role=tab], [role=checkbox], [tabindex="0"]')].filter(vis)
  const nodes = new Set()
  for (const el of ctl) for (let e = el; e; e = e.parentElement) nodes.add(e)
  nodes.add(document)
  window.__auditNodes = [...nodes]
  window.__auditCtl = ctl
  const name = (el) => (el.getAttribute('aria-label') || el.textContent || el.getAttribute('title') || '').trim().replace(/\\s+/g, ' ').slice(0, 30)
  // a scroller that takes focus to scroll by keys is native behaviour, not a control
  const scroller = (el) => { const cs = getComputedStyle(el); return /auto|scroll/.test(cs.overflowY + cs.overflowX) && (el.scrollHeight > el.clientHeight || el.scrollWidth > el.clientWidth) }
  return ctl.map((el) => ({ tag: el.tagName.toLowerCase(), id: el.id || (el.dataset && (el.dataset.key || el.dataset.rail)) || String(el.className).slice(0, 24), name: name(el), disabled: !!el.disabled || el.getAttribute('aria-disabled') === 'true',
    nativeOk: el.tagName === 'SUMMARY' || (el.getAttribute('tabindex') === '0' && !el.getAttribute('role') && scroller(el)),
    chain: (() => { const c = []; for (let e = el; e; e = e.parentElement) c.push(window.__auditNodes.indexOf(e)); c.push(window.__auditNodes.indexOf(document)); return c })() }))
})()`
const ACTIVATE = ['click', 'pointerdown', 'pointerup', 'mousedown', 'mouseup', 'keydown', 'keyup', 'input', 'change', 'wheel', 'dblclick', 'contextmenu']
// what an ancestor's listener may handle for a control (a document-wide key handler doesn't make a button work)
const DELEGATE = ['click', 'pointerdown', 'pointerup', 'mousedown', 'mouseup', 'input', 'change']

// A delegated listener counts for a control only when it can be for it: a handler that picks its target
// by selector (e.target.closest('button[data-rail]')) must name a selector the control matches inside
// that ancestor; a handler that looks at no target at all (the visualizer's "a click anywhere changes the
// scene") handles every click. A document-wide "click outside closes the menu" handler is a picker too.
function delegation(source) {
  const picks = /closest|matches|\.target|contains\(/.test(source)
  const sels = [...source.matchAll(/(['"`])((?:(?!\1).){1,80})\1/g)].map((m) => m[2]).filter((x) => /^[.#\[a-z*]/i.test(x) && !/\s{2}|[;{}()]/.test(x))
  return { catchAll: !picks, sels }
}

// page: a ui-check `target()` ({ c, ev }); returns [{ ...control, dead }]
async function deadControls(page, rootSel) {
  const ctl = await page.ev(CONTROLS(rootSel))
  const n = await page.ev('window.__auditNodes.length')
  const own = []; const deleg = []
  for (let i = 0; i < n; i++) {
    const { result } = await page.c.send('Runtime.evaluate', { expression: 'window.__auditNodes[' + i + ']', objectGroup: 'audit' })
    const { listeners } = await page.c.send('DOMDebugger.getEventListeners', { objectId: result.objectId, depth: 0 })
    own.push(new Set(listeners.map((l) => l.type)))
    deleg.push(listeners.some((x) => DELEGATE.includes(x.type)))
  }
  // the handlers' sources (only for ancestors' delegate-type listeners): one call per listener with a handler object
  const srcs = []
  for (let i = 0; i < n; i++) {
    srcs.push([])
    if (!deleg[i]) continue
    const { result } = await page.c.send('Runtime.evaluate', { expression: 'window.__auditNodes[' + i + ']', objectGroup: 'audit' })
    const { listeners } = await page.c.send('DOMDebugger.getEventListeners', { objectId: result.objectId, depth: 0, objectGroup: 'audit' })
    for (const l of listeners.filter((x) => DELEGATE.includes(x.type))) srcs[i].push(delegation((l.handler && l.handler.description) || ''))
  }
  await page.c.send('Runtime.releaseObjectGroup', { objectGroup: 'audit' })
  // which delegated selectors each control matches inside that ancestor (in the page)
  const matches = await page.ev(`(() => {
    const srcs = ${JSON.stringify(srcs.map((l) => l.map((x) => x.sels)))}
    const ctl = ${JSON.stringify(ctl.map((c) => c.chain))}
    return ctl.map((chain, ci) => chain.slice(1).map((ni) => ni >= 0 && (srcs[ni] || []).some((sels) => sels.some((s) => { try { const hit = window.__auditCtl[ci].closest(s); return !!hit && (window.__auditNodes[ni] === document || window.__auditNodes[ni].contains(hit)) } catch (e) { return false } }))))
  })()`)
  await page.ev('(delete window.__auditNodes, delete window.__auditCtl, true)')
  return ctl.map((c, ci) => {
    const alive = c.nativeOk || ACTIVATE.some((t) => own[c.chain[0]].has(t)) ||
      c.chain.slice(1).some((ni, k) => ni >= 0 && (srcs[ni].some((x) => x.catchAll) || matches[ci][k]))
    return Object.assign({}, c, { chain: undefined, dead: !alive })
  })
}

// --- theme tokens ---
// `except`: selectors of what the rule exempts (drawn as it looks); everything inside them is skipped
// `extra`: custom properties a page sets from theme.js itself (the visualizer's stage colours: theme.js stageText)
const TOKENS = (rootSel, except, extra) => `(() => {
  const root = document.querySelector(${JSON.stringify(rootSel)}) || document.body
  const probe = document.createElement('i'); probe.style.display = 'none'; document.documentElement.appendChild(probe)
  const resolve = (v, prop) => { probe.style[prop] = ''; probe.style[prop] = v; const r = getComputedStyle(probe)[prop]; probe.style[prop] = ''; return r }
  const unset = resolve('', 'color')
  // every --s-* custom property in the page (theme.css rules and theme-apply's inline values), resolved
  const names = new Set()
  for (const s of document.styleSheets) { let rules; try { rules = s.cssRules } catch (e) { continue } const walk = (rs) => { for (const r of rs) { if (r.style) for (const p of r.style) if (p.startsWith('--s-')) names.add(p); if (r.cssRules) walk(r.cssRules) } }; walk(rules) }
  for (const p of document.documentElement.style) if (p.startsWith('--s-')) names.add(p)
  for (const p of ${JSON.stringify(extra || [])}) names.add(p)
  const tokens = new Map()
  for (const n of names) { const v = resolve('var(' + n + ')', 'color'); if (v && v !== unset) tokens.set(v, n); const b = resolve('var(' + n + ')', 'backgroundColor'); if (b && b !== 'rgba(0, 0, 0, 0)') tokens.set(b, n) }
  probe.remove()
  const ex = ${JSON.stringify(except || [])}
  const clear = (c) => !c || c === 'transparent' || c === 'rgba(0, 0, 0, 0)' || c === 'none' || /rgba\\([^)]*,\\s*0\\)$/.test(c)
  const vis = (el) => { const r = el.getBoundingClientRect(); const cs = getComputedStyle(el); return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none' && !el.closest('[hidden]') }
  const short = (el) => el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + (el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\\s+/).slice(0, 2).join('.') : '')
  const bad = []
  const all = [root, ...root.querySelectorAll('*')]
  for (const el of all) {
    if (['SCRIPT', 'STYLE', 'CANVAS', 'IMG', 'BR'].includes(el.tagName) || !vis(el) || ex.some((s) => el.closest(s))) continue
    const cs = getComputedStyle(el)
    const props = []
    if ([...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim())) props.push(['color', cs.color])
    props.push(['background-color', cs.backgroundColor])
    for (const side of ['Top', 'Right', 'Bottom', 'Left']) if (parseFloat(cs['border' + side + 'Width']) > 0 && cs['border' + side + 'Style'] !== 'none') props.push(['border-' + side.toLowerCase() + '-color', cs['border' + side + 'Color']])
    if (cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) > 0) props.push(['outline-color', cs.outlineColor])
    for (const m of (cs.boxShadow === 'none' ? '' : cs.boxShadow).matchAll(/rgba?\\([^)]*\\)/g)) props.push(['box-shadow', m[0]])
    if (el instanceof SVGElement) { if (cs.fill && cs.fill.startsWith('rgb')) props.push(['fill', cs.fill]); if (cs.stroke && cs.stroke.startsWith('rgb')) props.push(['stroke', cs.stroke]) }
    for (const [p, v] of props) if (!clear(v) && !tokens.has(v)) bad.push({ el: short(el).slice(0, 50), prop: p, value: v })
  }
  return { tokens: tokens.size, checked: all.length, bad }
})()`

// --- overflow and clipping ---
// `allow`: selectors whose text may sit outside the window or be cut on purpose (scrolled-away lyric lines)
const OVERFLOW = (rootSel, allow) => `(() => {
  const root = document.querySelector(${JSON.stringify(rootSel)}) || document.body
  const al = ${JSON.stringify(allow || [])}
  const se = document.scrollingElement
  const hScroll = se.scrollWidth > se.clientWidth + 1
  const vis = (el) => { const r = el.getBoundingClientRect(); const cs = getComputedStyle(el); return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none' && +cs.opacity !== 0 && !el.closest('[hidden]') }
  const short = (el) => el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + (el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\\s+/).slice(0, 2).join('.') : '')
  const out = []; const cut = []
  const els = new Set()
  const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  for (let n = w.nextNode(); n; n = w.nextNode()) if (n.textContent.trim() && n.parentElement && !n.parentElement.closest('svg')) els.add(n.parentElement)
  for (const el of root.querySelectorAll('button, select, input, a[href], [role=button], [role=switch], [role=slider]')) els.add(el)
  for (const el of els) {
    if (!vis(el) || al.some((s) => el.closest(s))) continue
    const r = el.getBoundingClientRect()
    // outside the window: only a problem when no scroller can bring it into view
    let scrolls = false
    for (let a = el.parentElement; a && a !== document.documentElement && !scrolls; a = a.parentElement) { const cs = getComputedStyle(a); scrolls = /auto|scroll/.test(cs.overflowX + cs.overflowY) }
    if (!scrolls && (r.left < -1 || r.top < -1 || r.right > innerWidth + 1 || r.bottom > innerHeight + 1)) { out.push(short(el) + ' "' + el.textContent.trim().slice(0, 24) + '" ' + [r.left, r.top, r.right, r.bottom].map(Math.round).join(',')); continue }
    // the nearest box that hides overflow, unless it scrolls (scrolling shows the rest)
    for (let a = el.parentElement; a && a !== document.documentElement; a = a.parentElement) {
      const cs = getComputedStyle(a)
      if (cs.overflowX === 'visible' && cs.overflowY === 'visible') continue
      if (/auto|scroll/.test(cs.overflowX + cs.overflowY)) break
      const b = a.getBoundingClientRect()
      const ecs = getComputedStyle(el)
      const ellipsis = ecs.textOverflow === 'ellipsis' && (el.title || el.getAttribute('aria-label') || el.closest('[title]'))
      if (!ellipsis && (r.left < b.left - 1 || r.right > b.right + 1 || r.top < b.top - 1 || r.bottom > b.bottom + 1)) cut.push(short(el) + ' "' + el.textContent.trim().slice(0, 24) + '" in ' + short(a))
      break
    }
  }
  return { hScroll, outside: out, clipped: cut, vw: innerWidth, vh: innerHeight }
})()`

// --- the visualizer's stage: contrast over the pixels actually behind each text ---
// The stage has no surface colour to compute from (blurred album art, the scene's canvas, a vignette and a
// scrim), so the words are made transparent for a moment, the page is captured, and each text is judged
// over the darkest and lightest pixel under its box (text shadows not counted: stricter). The texts'
// boxes, colours and opacities are read in the same moment as the capture (a lyric line that changes
// between the two would be judged over the wrong pixels), and the words are hidden by their fill
// (-webkit-text-fill-color), so their own colour still reads.
async function stageContrast(page, rootSel) {
  // a settled moment: no CSS animation or transition running on the texts (a new line fading in, a word's
  // fade or pop), so each text is judged as it stays on screen, not mid-fade; the countdown dots' Web
  // Animations are not texts. Tried again if one starts between the read and the capture.
  const SETTLED = `(() => !document.getAnimations().some((a) => a.playState === 'running' && (a instanceof CSSAnimation || a instanceof CSSTransition) && a.effect && a.effect.target && a.effect.target.closest && a.effect.target.closest('#lyrics, #meta, #hint, #audio-note, #mode-label')))()`
  let shot = null
  for (let attempt = 0; attempt < 8 && !shot; attempt++) {
    for (let i = 0; i < 40 && !(await page.ev(SETTLED)); i++) await new Promise((r) => setTimeout(r, 50))
    await page.ev(`(() => { const s = document.createElement('style'); s.id = '__auditHide'; s.textContent = '#lyrics *, #meta *, #hint, #mode-label, #audio-note { -webkit-text-fill-color: transparent !important; text-shadow: none !important; -webkit-text-stroke: 0 !important }'; document.head.appendChild(s); return new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(true)))) })()`)
    const ok = await page.ev(`(() => {
      if (!${SETTLED}) return false
      const root = document.querySelector(${JSON.stringify(rootSel)}) || document.body
      const vis = (el) => { const r = el.getBoundingClientRect(); const cs = getComputedStyle(el); return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none' }
      const rows = []
      const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
      for (let n = w.nextNode(); n; n = w.nextNode()) {
        const el = n.parentElement
        if (!n.textContent.trim() || !el || !vis(el)) continue
        let op = 1; for (let e = el; e; e = e.parentElement) op *= +getComputedStyle(e).opacity
        if (op < 0.1) continue
        const r = el.getBoundingClientRect()
        rows.push({ text: n.textContent.trim().slice(0, 30), rect: [r.left, r.top, r.right, r.bottom], color: getComputedStyle(el).color, op, dim: !!el.closest('.line:not(.active)') || !!el.closest('.bgv') })
      }
      window.__auditRows = rows
      return true
    })()`)
    const s = ok ? await page.c.send('Page.captureScreenshot', { format: 'png' }) : null
    if (s && (await page.ev(SETTLED))) shot = s
    if (!shot) { await page.ev(`(document.getElementById('__auditHide').remove(), true)`); await new Promise((r) => setTimeout(r, 100)) }
  }
  if (!shot) throw new Error('stageContrast: the stage never settled for a capture')
  await page.ev(`(document.getElementById('__auditHide').remove(), true)`)
  await new Promise((r) => setTimeout(r, 200))
  return page.ev(`(async () => {
    const img = new Image(); img.src = 'data:image/png;base64,${shot.data}'; await img.decode()
    const c = document.createElement('canvas'); c.width = img.width; c.height = img.height
    const g = c.getContext('2d', { willReadFrequently: true }); g.drawImage(img, 0, 0)
    const k = img.width / innerWidth
    const L = (p) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4 }; return 0.2126 * f(p[0]) + 0.7152 * f(p[1]) + 0.0722 * f(p[2]) }
    const ratio = (a, b) => { const x = L(a), y = L(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05) }
    const rows = []
    for (const t of window.__auditRows) {
      const x0 = Math.max(0, Math.floor(t.rect[0] * k)), y0 = Math.max(0, Math.floor(t.rect[1] * k)), x1 = Math.min(c.width, Math.ceil(t.rect[2] * k)), y1 = Math.min(c.height, Math.ceil(t.rect[3] * k))
      if (x1 <= x0 || y1 <= y0) continue
      const d = g.getImageData(x0, y0, x1 - x0, y1 - y0).data
      let lo = [9, null], hi = [-1, null]
      for (let i = 0; i < d.length; i += 8) { const p = [d[i], d[i + 1], d[i + 2]]; const l = L(p); if (l < lo[0]) lo = [l, p]; if (l > hi[0]) hi = [l, p] }
      const m = /rgba?\\(([^)]+)\\)/.exec(t.color); const cp = m[1].split(/[ ,\\/]+/).filter(Boolean).map(Number)
      const a = (cp.length > 3 ? cp[3] : 1) * t.op
      const over = (b) => ratio(cp.slice(0, 3).map((v, i) => v * a + b[i] * (1 - a)), b)
      rows.push({ text: t.text, ratio: +Math.min(over(lo[1]), over(hi[1])).toFixed(2), dim: t.dim })
    }
    delete window.__auditRows
    return rows
  })()`)
}

module.exports = { deadControls, TOKENS, OVERFLOW, stageContrast }
