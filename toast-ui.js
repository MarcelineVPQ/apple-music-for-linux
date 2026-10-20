// Sonata's toasts (toast.html): a small view main creates at the bottom right of Apple's page only
// while a toast shows, and closes when the last one goes (no idle cost). Main owns the queue
// (notices-model.js: ≤ 3, same words restart the timer); this page draws it, runs each toast's timer
// (paused while the pointer or the keyboard focus is on a toast) and tells main its height, so the
// view is exactly as tall as the toasts and covers nothing else of Apple's page.
;(function () {
  'use strict'
  const bridge = globalThis.sonataPanelBridge
  if (!bridge || !globalThis.SonataIcons || !globalThis.SonataThemeApply || globalThis.__sonataToasts) return
  const doc = document
  const list = doc.createElement('ul')
  list.className = 'toasts'
  list.setAttribute('aria-live', 'polite')
  list.setAttribute('aria-relevant', 'additions text')
  list.setAttribute('aria-label', 'Notifications')
  doc.body.appendChild(list)
  const theme = globalThis.SonataThemeApply.attach({ surfaces: [] })
  // cache: OK — key=toast id; invalidated=render deletes ids no longer shown, timer cleared; bound=toasts shown (≤ 3)
  const timers = new Map()   // id -> { timer, left, started, shownAt }
  let paused = false
  let sentHeight = -1

  // lifetime: OK — one timer per toast on screen (≤ 3), cleared when it ends, pauses or is shown again
  function arm(t) {
    let rec = timers.get(t.id)
    if (!rec || rec.shownAt !== t.shownAt) {
      if (rec) clearTimeout(rec.timer)
      rec = { timer: null, left: t.durationMs, started: 0, shownAt: t.shownAt }
      timers.set(t.id, rec)
    }
    if (paused || rec.timer) return
    rec.started = Date.now()
    // loop: NOT-WORTH — toast timer · one-shot per toast (5-8 s, longer for long words) · stops when it fires or the toast pauses/ends · cost ~0
    rec.timer = setTimeout(() => bridge.send('toast-done', t.id), rec.left)
  }
  function pauseAll(on) {
    if (paused === on) return
    paused = on
    // loop: NOT-WORTH — ≤ 3 toasts
    for (const rec of timers.values()) {
      if (on && rec.timer) { clearTimeout(rec.timer); rec.timer = null; rec.left = Math.max(2000, rec.left - (Date.now() - rec.started)) }
    }
    if (!on) render()
  }

  let toasts = []
  function render() {
    // loop: NOT-WORTH — the toasts (≤ 3), per toast state push, not per frame
    const ids = new Set(toasts.map((t) => t.id))
    // loop: NOT-WORTH — ≤ 3 toasts per change
    for (const [id, rec] of timers) if (!ids.has(id)) { clearTimeout(rec.timer); timers.delete(id) }
    const items = toasts.map((t) => {
      const old = list.querySelector('[data-toast="' + t.id + '"]')
      if (old) return old
      const li = doc.createElement('li')
      li.className = 'toast'
      li.dataset.toast = String(t.id)
      const text = doc.createElement('span')
      text.className = 'toast-text'
      text.textContent = t.text
      li.appendChild(text)
      if (t.action) {
        const b = doc.createElement('button')
        b.type = 'button'
        b.className = 'btn'
        b.textContent = t.action.label
        // lifetime: OK — one click listener per toast's action, dropped with the toast
        b.addEventListener('click', (e) => { if (e.isTrusted) bridge.send('toast-action', t.id) })
        li.appendChild(b)
      }
      const x = doc.createElement('button')
      x.type = 'button'
      x.className = 'icon-btn'
      x.setAttribute('aria-label', 'Close')
      x.setAttribute('title', 'Close')
      x.appendChild(globalThis.SonataIcons.icon(doc, 'close'))
      // lifetime: OK — one click listener per toast's ×, dropped with the toast
      x.addEventListener('click', (e) => { if (e.isTrusted) bridge.send('toast-done', t.id) })
      li.appendChild(x)
      return li
    })
    list.replaceChildren(...items)
    // loop: NOT-WORTH — ≤ 3 toasts
    for (const t of toasts) arm(t)
    const h = Math.ceil(list.getBoundingClientRect().height)
    if (h !== sentHeight) { sentHeight = h; bridge.send('toast-size', h) }
  }
  // lifetime: OK — pointerenter/pointerleave/focusin/focusout on the list, one each for the page's life
  list.addEventListener('pointerenter', () => pauseAll(true))
  list.addEventListener('pointerleave', () => pauseAll(list.contains(doc.activeElement)))
  list.addEventListener('focusin', () => pauseAll(true))
  list.addEventListener('focusout', (e) => { if (!e.relatedTarget || !list.contains(e.relatedTarget)) pauseAll(list.matches(':hover')) })

  bridge.onState((s) => {
    theme.set(s && s.theme)
    toasts = (s && s.toasts) || []
    render()
  })
  bridge.send('mounted')
  globalThis.__sonataToasts = Object.freeze({ list, timers: () => timers.size })
})()
