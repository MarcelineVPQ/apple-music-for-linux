// Keyboard focus between Apple's page and the rail's own view (two web contents in one window).
// main.js runs this in Apple's ISOLATED world (999, the preload's world) on every page load. Apple's
// scripts can't see it. It adds two invisible focus stops to Apple's page, first and last in
// <body>: Tab past Apple's last control, or Shift+Tab before its first (or the first Tab of a fresh
// page), lands on one and hands focus to the rail (preload-apple.js -> main -> rail view). From the
// rail, Tab / Shift+Tab / F6 come back here through __sonataFocus.focusApple().
;(function () {
  'use strict'
  const bridge = globalThis.sonataFocusBridge
  if (!bridge || globalThis.__sonataFocus) return
  const doc = document

  function stop(where) {
    const e = doc.createElement('sonata-focus')
    e.tabIndex = 0
    e.setAttribute('role', 'button')
    e.setAttribute('aria-label', 'Sonata navigation rail')
    const css = { all: 'initial', position: 'fixed', top: '0', left: '0', width: '1px', height: '1px', overflow: 'hidden',
      clip: 'rect(0 0 0 0)', 'clip-path': 'inset(50%)', opacity: '0', 'pointer-events': 'none', 'z-index': '-1' }
    for (const k in css) e.style.setProperty(k, css[k], 'important')
    // lifetime: one focus listener per stop, for the document's life
    // error: a focus not caused by the user (isTrusted false: a page script) is ignored
    e.addEventListener('focus', (ev) => { if (ev.isTrusted) bridge.toRail(where) })
    return e
  }
  const first = stop('first')
  const last = stop('last')

  // the last real control focused in Apple's page (F6 comes back to it)
  let lastReal = null
  // lifetime: one capturing focusin listener on Apple's document · one assignment per focus change
  doc.addEventListener('focusin', (e) => {
    const t = e.composedPath ? e.composedPath()[0] : e.target
    if (t && t.tagName !== 'SONATA-FOCUS') lastReal = t
  }, true)

  // Apple's tabbable controls in document order (open shadow roots included)
  const SEL = 'a[href], button, input, select, textarea, [tabindex], [contenteditable="true"]'
  function tabbables() {
    const out = []
    const walk = (root, depth) => {
      if (depth > 25) return
      for (const el of root.querySelectorAll('*')) {
        if (el.shadowRoot) walk(el.shadowRoot, depth + 1)
        if (el.tagName === 'SONATA-FOCUS' || !el.matches(SEL) || el.tabIndex < 0 || el.disabled || el.inert) continue
        if (!el.getClientRects().length) continue
        out.push(el)
      }
    }
    walk(doc, 0)
    return out
  }

  // keep the two stops first and last in <body>
  // loop: none · ONE MutationObserver, childList of <body> only (no subtree) · fires when Apple adds or
  // removes a direct child of <body> (route shells, modals: a few per navigation, none while idle) ·
  // cost one or two element comparisons; moving a stop triggers one more no-op call · lives with the document
  const observer = new MutationObserver(place)
  function place() {
    const body = doc.body
    if (!body) return
    if (body.firstElementChild !== first) body.prepend(first)
    if (body.lastElementChild !== last) body.append(last)
  }
  if (doc.body) { place(); observer.observe(doc.body, { childList: true }) }

  globalThis.__sonataFocus = Object.freeze({
    // where: 'next' (Apple's first control), 'prev' (its last), 'restore' (where focus was before)
    focusApple(where) {
      let target = null
      if (where === 'restore' && lastReal && lastReal.isConnected) target = lastReal
      else {
        const list = tabbables()
        target = where === 'prev' ? list[list.length - 1] : list[0]
      }
      if (target) target.focus({ focusVisible: true })
      return !!target
    },
    counts: () => ({ stops: doc.querySelectorAll('sonata-focus').length, observers: 1, listeners: 3 })
  })
})()
