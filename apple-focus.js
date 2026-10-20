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
    // loop: NOT-WORTH — 12 style properties, twice per page load
    for (const k in css) e.style.setProperty(k, css[k], 'important')
    // lifetime: OK — one focus listener per stop, released with the document
    // error: a focus not caused by the user (isTrusted false: a page script) is ignored
    e.addEventListener('focus', (ev) => { if (ev.isTrusted) bridge.toRail(where) })
    return e
  }
  const first = stop('first')
  const last = stop('last')

  // the last real control focused in Apple's page (F6 comes back to it)
  let lastReal = null
  // lifetime: OK — one capturing focusin listener on Apple's document, released with it · one assignment per focus change
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
      // loop: HOT-PATH-OK — Apple's whole DOM (~15 k nodes), only on a Tab/F6 handoff out of the rail (a key press)
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
  // lifetime: OK — ONE MutationObserver, childList of <body> only (no subtree) · fires when Apple adds or
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

  // Mouse wheel over Apple's own volume control (the player bar's speaker and its slider): 5 % per
  // notch, as in the mini player (wheel-volume.js, injected before this file). The page doesn't scroll.
  // The wheel listener goes on that control only (found when the pointer enters it), never on the
  // whole document: a non-passive document wheel listener would make every scroll of Apple's page wait.
  // If Apple renames the control (class "chrome-volume"), the wheel there simply scrolls again.
  const W = globalThis.SonataWheelVolume
  // cache: OK — key=Apple's volume control element; invalidated=GC'd with the element (WeakSet); bound=live controls (1–2)
  const hooked = new WeakSet()
  const steps = W ? W.createWheelSteps() : null
  function onVolumeWheel(e) {
    if (!e.isTrusted || !steps || !bridge.volume) return
    e.preventDefault()
    const n = steps.feed(e.deltaY, e.deltaMode, e.timeStamp)
    if (n) bridge.volume(n)
  }
  // lifetime: OK — one capturing, passive pointerover listener on Apple's document (released with it) · per element boundary
  // crossed, a walk up the event path (≤ ~25 elements) · adds one wheel listener per volume control
  // element, once (WeakSet), which lives and dies with that element
  if (W) doc.addEventListener('pointerover', (e) => {
    if (!e.isTrusted) return
    // loop: NOT-WORTH — the event's path, ≤ ~25 elements, per element boundary crossed
    for (const el of e.composedPath()) {
      if (el === doc.body || el === doc) break
      if (el.classList && el.classList.contains('chrome-volume')) {
        if (!hooked.has(el)) {
          hooked.add(el)
          // lifetime: OK — one wheel listener per volume control element, released with it (not passive: it stops the scroll)
          el.addEventListener('wheel', onVolumeWheel, { passive: false })
        }
        break
      }
    }
  }, { capture: true, passive: true })

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
    counts: () => ({ stops: doc.querySelectorAll('sonata-focus').length, observers: 1, listeners: 4 })
  })
})()
