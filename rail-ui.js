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
  if (!M || !bridge || !globalThis.SonataIcons || !globalThis.SonataThemeApply || globalThis.__sonataRail) return

  const doc = document
  // Lucide icons (ISC licence), shared with the side panel (icons.js)
  const icon = (name) => globalThis.SonataIcons.icon(doc, name)
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
    // an open task on a panel page (Settings, About): a dot on the icon (the tooltip says what)
    if (iconName === 'settings' || iconName === 'about') { const dot = el('i', 'task'); dot.hidden = true; ic.appendChild(dot) }
    const label = el('span', 'label')
    b.append(ic, label)
    buttons.push(b)
    return b
  }
  // loop: NOT-WORTH — 7 items, once at load
  M.ITEMS.forEach((it, i) => {
    const b = makeButton(it.id, it.id)
    // a sub-item (Lyrics, Liner Notes under the Studio): indented, a smaller icon on the group's guide
    // line (the last one ends it); screen readers hear the group it belongs to
    if (it.parent) {
      b.classList.add('sub')
      if (!(M.ITEMS[i + 1] && M.ITEMS[i + 1].parent === it.parent)) b.classList.add('last')
      const parent = M.ITEMS.find((p) => p.id === it.parent)
      b.setAttribute('aria-description', 'In ' + parent.label)
    } else if (M.ITEMS[i + 1] && M.ITEMS[i + 1].parent === it.id) b.classList.add('group')
    nav.appendChild(b)
  })
  const dev = el('div', 'dev')
  dev.hidden = true
  nav.appendChild(dev)
  const statusList = el('div', 'statuses')
  statusList.setAttribute('role', 'group')
  statusList.setAttribute('aria-label', 'Connections')
  const statusRows = {}
  // loop: NOT-WORTH — 3 status lines, once at load
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
  // the one theme system (theme.js) with the Glass material on the panel
  const theme = globalThis.SonataThemeApply.attach({ surfaces: [panel] })

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
    setAttr(b, 'aria-pressed', item.active ? 'true' : 'false')
    const dot = b.querySelector('.task')
    if (dot) {
      dot.hidden = !item.task
      setAttr(b, 'aria-description', item.task ? 'Waiting: ' + item.task : null)
    }
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
    if (!state) return
    theme.set(state.theme)
    const items = M.railItems(state)
    // loop: NOT-WORTH — 7 items per state change
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
    // loop: NOT-WORTH — 3 status lines per state change
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
    // loop: NOT-WORTH — 9 buttons per render
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
  // lifetime: OK — panel pointerenter/pointerleave · one each, for the document's life · cost one render per crossing
  panel.addEventListener('pointerenter', () => update('enter'))
  panel.addEventListener('pointerleave', () => update('leave'))
  // lifetime: OK — panel focusin/focusout · one each · keyboard focus opens the rail, a click's focus doesn't
  panel.addEventListener('focusin', (e) => {
    const i = buttons.indexOf(e.target)
    if (i >= 0) focusIndex = i
    update(e.target.matches(':focus-visible') ? 'focus-visible' : 'focus-pointer')
  })
  panel.addEventListener('focusout', (e) => {
    if (!e.relatedTarget || !panel.contains(e.relatedTarget)) update('blur')
  })
  // lifetime: OK — panel transitionend/transitioncancel · one each · the slide is over: narrow the view if it closed
  const slideDone = (e) => { if (e.target === panel && e.propertyName === 'transform') { sliding = false; render() } }
  panel.addEventListener('transitionend', slideDone)
  panel.addEventListener('transitioncancel', slideDone)
  // lifetime: OK — panel keydown · one · arrows/Home/End move focus (roving tabindex), Esc closes, Tab and
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
    // loop: NOT-WORTH — 9 buttons per key press
    buttons.forEach((b, i) => { b.tabIndex = i === focusIndex ? 0 : -1 })
    buttons[focusIndex].focus({ focusVisible: true })
    update('key')
  })
  // lifetime: OK — panel click · one (delegated) · a real click or Enter/Space on a button sends its command
  // error: synthetic events (isTrusted false: a page script) are ignored; unknown ids never leave here
  panel.addEventListener('click', (e) => {
    if (!e.isTrusted) return
    const b = e.target.closest ? e.target.closest('button[data-rail]') : null
    if (!b || !M.COMMANDS.includes(b.dataset.rail)) return
    bridge.send(b.dataset.rail)
    // a pointer click (detail > 0), not Enter/Space: close the rail now, like a menu
    if (e.detail > 0) update('pick')
  })
  // (the colour-scheme and reduced-transparency listeners are theme-apply.js's, one each)

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
    theme: () => theme.state(),
    counts: () => ({ observers: 0, listeners: 10, panels: doc.querySelectorAll('.panel').length })
  })
})()
