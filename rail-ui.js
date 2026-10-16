// Sonata's navigation rail (see rail-model.js for the behaviour, rail.css for the look). Runs in
// rail.html, the rail's OWN view in the main window (a WebContentsView beside Apple's page, local,
// sandboxed, contextIsolation on, no Node): Apple's page and the rail share nothing but the window.
// Main sizes the two views: Apple's page gets the window minus the rail's room, so nothing of
// Apple's ever sits under the rail. To open over Apple's page (hover or keyboard focus, unpinned)
// the rail asks main to widen its view ('expand'), slides its panel in, and once it has slid out
// again asks to narrow it ('collapse').
// Talks to main only through the preload's sonataRailBridge (preload-rail-view.js).
// No timers, no animation frames, no polling: it redraws only when main sends a new state, the
// pointer enters or leaves, focus moves, a key is pressed, a slide ends, or the colour scheme changes.
;(function () {
  'use strict'
  const M = globalThis.SonataRailModel
  const bridge = globalThis.sonataRailBridge
  if (!M || !bridge || globalThis.__sonataRail) return

  const doc = document
  const SVG = 'http://www.w3.org/2000/svg'
  // Lucide icons (ISC licence): mic-vocal, audio-waveform, picture-in-picture-2, settings, panel-right-open/close, lock, lock-open
  const ICONS = {
    lyrics: ['path:m11 7.601-5.994 8.19a1 1 0 0 0 .1 1.298l.817.818a1 1 0 0 0 1.314.087L15.09 12', 'path:M16.5 21.174C15.5 20.5 14.372 20 13 20c-2.058 0-3.928 2.356-6 2-2.072-.356-2.775-3.369-1.5-4.5', 'circle:16,7,5'],
    visualizer: ['path:M2 13a2 2 0 0 0 2-2V7a2 2 0 0 1 4 0v13a2 2 0 0 0 4 0V4a2 2 0 0 1 4 0v13a2 2 0 0 0 4 0v-4a2 2 0 0 1 2-2'],
    mini: ['path:M21 9V6a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v10c0 1.1.9 2 2 2h4', 'rect:12,13,10,7,2'],
    settings: ['path:M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z', 'circle:12,12,3'],
    lock: ['rect:3,11,18,11,2', 'path:M7 11V7a5 5 0 0 1 10 0v4'],
    unlock: ['rect:3,11,18,11,2', 'path:M7 11V7a5 5 0 0 1 9.9-1'],
    pinOpen: ['rect:3,3,18,18,2', 'path:M15 3v18', 'path:m10 15-3-3 3-3'],
    pinClose: ['rect:3,3,18,18,2', 'path:M15 3v18', 'path:m8 9 3 3-3 3']
  }
  function icon(name) {
    const svg = doc.createElementNS(SVG, 'svg')
    svg.setAttribute('viewBox', '0 0 24 24')
    svg.setAttribute('aria-hidden', 'true')
    for (const part of ICONS[name]) {
      const [tag, a] = part.split(/:(.*)/s)
      const el = doc.createElementNS(SVG, tag)
      if (tag === 'path') el.setAttribute('d', a)
      else if (tag === 'circle') { const [cx, cy, r] = a.split(','); el.setAttribute('cx', cx); el.setAttribute('cy', cy); el.setAttribute('r', r) }
      else { const [x, y, w, h, rx] = a.split(','); el.setAttribute('x', x); el.setAttribute('y', y); el.setAttribute('width', w); el.setAttribute('height', h); el.setAttribute('rx', rx) }
      svg.appendChild(el)
    }
    return svg
  }
  const el = (tag, cls, text) => {
    const e = doc.createElement(tag)
    if (cls) e.className = cls
    if (text !== undefined) e.textContent = text
    return e
  }

  const root = doc   // the rail's own page (kept as `root` for the test hook)

  // --- the DOM, built once; render() only changes attributes and text ---
  const panel = el('nav', 'panel')
  panel.setAttribute('aria-label', 'Sonata')
  const nav = el('div', 'nav')
  const footer = el('div', 'footer')
  const buttons = []   // roving focus order: the items, the pin, the lock
  function makeButton(id, iconName) {
    const b = el('button', 'link')
    b.type = 'button'
    b.dataset.rail = id
    b.tabIndex = -1
    const ic = el('span', 'ic')
    ic.appendChild(icon(iconName))
    const label = el('span', 'label')
    b.append(ic, label)
    buttons.push(b)
    return b
  }
  for (const it of M.ITEMS) nav.appendChild(makeButton(it.id, it.id))
  const dev = el('div', 'dev')
  dev.hidden = true
  nav.appendChild(dev)
  const statusList = el('div', 'statuses')
  statusList.setAttribute('role', 'group')
  statusList.setAttribute('aria-label', 'Connections')
  const statusRows = {}
  for (const id of ['lastfm', 'discord', 'precise']) {
    const row = el('div', 'status off')
    row.setAttribute('role', 'img')   // one readable line: "Last.fm: connected as …"
    const ic = el('span', 'ic')
    const dot = el('span', 'dot')
    ic.appendChild(dot)
    const label = el('span', 'label')
    const name = el('span', 'name')
    const sub = el('span', 'sub')
    label.append(name, sub)
    row.append(ic, label)
    statusRows[id] = { row, dot, name, sub }
    statusList.appendChild(row)
  }
  const pinBtn = makeButton('pin', 'pinOpen')
  // the lock: a small icon button in the bottom corner, under the icons' column (as in the DS5 app),
  // so it stays reachable while the rail is locked small
  const lockBtn = el('button', 'lockbtn')
  lockBtn.type = 'button'
  lockBtn.dataset.rail = 'lock'
  lockBtn.tabIndex = -1
  lockBtn.appendChild(el('span', 'ic'))
  buttons.push(lockBtn)
  footer.append(statusList, pinBtn, lockBtn)
  panel.append(nav, footer)
  doc.body.appendChild(panel)

  // --- state ---
  let state = null          // from main (rail:state)
  let view = M.initialView()
  let focusIndex = 0
  const darkQuery = matchMedia('(prefers-color-scheme: dark)')
  let themeKey = ''

  function setAttr(e, name, value) {
    if (value === null || value === undefined || value === false) { if (e.hasAttribute(name)) e.removeAttribute(name) }
    else if (e.getAttribute(name) !== String(value)) e.setAttribute(name, String(value))
  }
  function setText(e, t) { if (e.textContent !== t) e.textContent = t }

  function renderButton(b, item) {
    const label = b.querySelector('.label')
    if (label) setText(label, item.label)
    setAttr(b, 'title', item.tip)
    setAttr(b, 'aria-label', item.label)
    setAttr(b, 'aria-keyshortcuts', item.ariaKeys || null)
    b.classList.toggle('active', !!item.active)
    if (item.kind === 'window') {
      setAttr(b, 'aria-current', item.active ? 'true' : null)
      setAttr(b, 'aria-description', item.active ? 'Open' : null)
    } else setAttr(b, 'aria-pressed', item.active ? 'true' : 'false')
  }

  function renderTheme() {
    const key = (state && state.palette ? state.palette.accent : '') + '|' + darkQuery.matches
    if (key === themeKey) return
    themeKey = key
    const t = M.glassTheme(state && state.palette, darkQuery.matches)
    for (const k in t.vars) panel.style.setProperty(k, t.vars[k])
  }

  // the view's width follows the panel: widen before sliding open, narrow after sliding shut
  let sliding = false   // a transform transition is running
  let asked = ''        // the last expand/collapse sent, until main's state answers it
  const instant = () => getComputedStyle(panel).transitionDuration.split(',').every((d) => parseFloat(d) === 0)
  function syncWidth(mode, want) {
    if (!state || mode === 'pinned') { asked = ''; return }
    const wide = !!state.wide
    if (want && !wide && asked !== 'expand') { asked = 'expand'; bridge.send('expand') }
    else if (!want && wide && !panel.classList.contains('open') && !sliding && asked !== 'collapse') { asked = 'collapse'; bridge.send('collapse') }
  }

  function render() {
    const mode = (state && state.mode) || 'collapsed'
    const locked = !!(state && state.locked)
    const want = M.isOpen(mode, view, locked)
    // open only once the view is wide enough to show it (pinned: always)
    const open = want && (mode === 'pinned' || !!(state && state.wide))
    if (open !== panel.classList.contains('open')) {
      panel.classList.toggle('open', open)
      sliding = mode !== 'pinned' && !instant()
    }
    panel.classList.toggle('pinned', mode === 'pinned')
    syncWidth(mode, want)
    panel.classList.toggle('locked', locked)
    renderTheme()
    if (!state) return
    const items = M.railItems(state)
    items.forEach((it, i) => renderButton(buttons[i], it))
    const pin = M.pinItem(state)
    renderButton(pinBtn, pin)
    const ic = pinBtn.querySelector('.ic')
    const pwant = state.pinned ? 'pinClose' : 'pinOpen'
    if (ic.dataset.icon !== pwant) { ic.dataset.icon = pwant; ic.replaceChildren(icon(pwant)) }
    renderButton(lockBtn, M.lockItem(state))
    const lic = lockBtn.firstChild
    const lwant = state.locked ? 'lock' : 'unlock'
    if (lic.dataset.icon !== lwant) { lic.dataset.icon = lwant; lic.replaceChildren(icon(lwant)) }
    for (const s of M.railStatus(state)) {
      const r = statusRows[s.id]
      r.row.className = 'status ' + s.level
      setText(r.dot, s.symbol)
      setText(r.name, s.label)
      setText(r.sub, s.text)
      setAttr(r.row, 'title', s.tip)
      setAttr(r.row, 'aria-label', s.tip)
    }
    const badge = M.devBadge(state)
    dev.hidden = !badge
    if (badge) {
      if (!dev.firstChild) dev.append(el('b'), doc.createTextNode(''))
      setText(dev.firstChild, badge.text)
      setText(dev.lastChild, badge.version ? ' · ' + badge.version : '')
      setAttr(dev, 'title', badge.tip)
      setAttr(dev, 'role', 'note')
      setAttr(dev, 'aria-label', badge.tip)
    }
    buttons.forEach((b, i) => { b.tabIndex = i === focusIndex ? 0 : -1 })
  }

  function update(type) {
    const next = M.viewReduce(view, type)
    if (next === view) return
    view = next
    render()
  }

  // --- listeners: all on our own nodes (inside the closed root) or the one media query; they live
  // as long as this document (a reload or navigation drops the document and them with it) ---
  // lifetime: panel pointerenter/pointerleave · one each, for the document's life · cost one render per crossing
  panel.addEventListener('pointerenter', () => update('enter'))
  panel.addEventListener('pointerleave', () => update('leave'))
  // lifetime: panel focusin/focusout · one each · keyboard focus opens the rail, a click's focus doesn't
  panel.addEventListener('focusin', (e) => {
    const i = buttons.indexOf(e.target)
    if (i >= 0) focusIndex = i
    update(e.target.matches(':focus-visible') ? 'focus-visible' : 'focus-pointer')
  })
  panel.addEventListener('focusout', (e) => {
    if (!e.relatedTarget || !panel.contains(e.relatedTarget)) update('blur')
  })
  // lifetime: panel transitionend/transitioncancel · one each · the slide is over: narrow the view if it closed
  const slideDone = (e) => { if (e.target === panel && e.propertyName === 'transform') { sliding = false; render() } }
  panel.addEventListener('transitionend', slideDone)
  panel.addEventListener('transitioncancel', slideDone)
  // lifetime: panel keydown · one · arrows/Home/End move focus (roving tabindex), Esc closes, Tab and
  // Shift+Tab hand focus back to Apple's page (the rail is one Tab stop between the two views)
  panel.addEventListener('keydown', (e) => {
    if (e.key === 'Tab' && !e.ctrlKey && !e.altKey && !e.metaKey) {
      e.preventDefault()
      bridge.send(e.shiftKey ? 'focus-apple-prev' : 'focus-apple-next')
      return
    }
    const k = M.railKey(e.key, focusIndex, buttons.length, { ctrl: e.ctrlKey, alt: e.altKey, meta: e.metaKey })
    if (!k) return
    e.preventDefault()
    if (k.action === 'escape') { update('escape'); return }
    focusIndex = k.index
    buttons.forEach((b, i) => { b.tabIndex = i === focusIndex ? 0 : -1 })
    buttons[focusIndex].focus({ focusVisible: true })
    update('key')
  })
  // lifetime: panel click · one (delegated) · a real click or Enter/Space on a button sends its command
  // error: synthetic events (isTrusted false: a page script) are ignored; unknown ids never leave here
  panel.addEventListener('click', (e) => {
    if (!e.isTrusted) return
    const b = e.target.closest ? e.target.closest('button[data-rail]') : null
    if (!b || !M.COMMANDS.includes(b.dataset.rail)) return
    bridge.send(b.dataset.rail)
    // a pointer click (detail > 0), not Enter/Space: close the rail now, like a menu
    if (e.detail > 0) update('pick')
  })
  // lifetime: one 'change' listener on the colour-scheme query · fires on theme switches only (Ctrl+D, desktop theme)
  darkQuery.addEventListener('change', () => { themeKey = ''; render() })

  render()

  // state from main; the first one arrives right after 'mounted'
  bridge.onState((s) => {
    if (!state || !!state.wide !== !!(s && s.wide)) asked = ''
    state = s
    if (state && state.mode === 'pinned' && view.picked) view = M.initialView()
    render()
  })
  // main hands keyboard focus over (Tab or Shift+Tab out of Apple's page, F6): the current item
  bridge.onFocus(() => {
    buttons[focusIndex].focus({ focusVisible: true })
    update('key')
  })
  bridge.send('mounted')

  // test hook (the rail's own page; Apple's page is another view and can't reach it): the UI tests
  // read the DOM, the view and the counts through it over remote debugging
  globalThis.__sonataRail = Object.freeze({
    root, panel, query: darkQuery,
    view: () => Object.assign({}, view),
    state: () => state,
    counts: () => ({ observers: 0, listeners: 9, panels: doc.querySelectorAll('.panel').length })
  })
})()
