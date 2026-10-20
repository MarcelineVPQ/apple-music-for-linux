// Sonata's notices and toasts (pure: no DOM, no Electron), modeled on the DS5 app's notices.ts and
// toast.ts. Main owns one instance; the side panel draws the notices, the toast view the toasts.
//
// Notice: a banner with words, optional actions (buttons) and a dismiss ×. Where it shows:
//   place 'top'              at the top of the side panel, whichever page it shows
//   place { page, section }  at the top of that section's body
// How its × closes it says what kind it is (as in DS5):
//   dismissKey — a task (an update, a repaired file): hidden across restarts until its reason changes
//                (a new key shows again). Only these keys are kept (≤ 50, pruned when the reason goes).
//   otherwise  — closes now; shown again only when the caller shows it again.
// task: true — an open task: a dot on its section and on its rail item while the panel doesn't show
// it. The dot follows the task, not the dismissal: it stays until the caller clears the notice.
//
// Toast: a short confirmation or event ("Last.fm connected"), bottom right of Apple's page, gone
// after a few seconds (paused while pointed at or focused, in the toast view). Never for an error or
// a task: those are notices. At most 3; the same words again restart the timer instead of stacking.
// While the main window is hidden nothing is queued (an event nobody saw is stale later).
;(function (root) {
  'use strict'
  const MAX_DISMISSED = 50
  const TOAST_MAX = 3
  const TOAST_MS = 5000
  const TOAST_ACTION_MS = 8000

  const noticeKey = (id, reason) => id + ':' + reason
  const idOf = (key) => { const at = key.indexOf(':'); return at < 0 ? key : key.slice(0, at) }

  // what may come in from the stored setting (dismissedNotices)
  function parseDismissed(v) {
    return Array.isArray(v) ? v.filter((k) => typeof k === 'string' && k.length < 200).slice(-MAX_DISMISSED) : []
  }

  // words per second ~ 4: a toast stays long enough to read (DS5 readingTime)
  function toastDuration(text, hasAction) {
    const base = hasAction ? TOAST_ACTION_MS : TOAST_MS
    const words = String(text || '').split(/\s+/).filter(Boolean).length
    return Math.max(base, Math.round(words / 4 * 1000) + 1500)
  }

  function createNotices(opts) {
    const o = opts || {}
    const onChange = o.onChange || (() => {})
    const saveDismissed = o.saveDismissed || (() => {})
    let notices = []          // in the order shown (newest last)
    let dismissed = parseDismissed(o.dismissed)
    let toasts = []
    let nextToast = 1
    let version = 0
    const changed = () => { version++; onChange() }

    function show(n) {
      if (!n || typeof n.id !== 'string' || !n.text) return
      const notice = {
        id: n.id,
        kind: n.kind === 'error' ? 'error' : 'info',
        text: String(n.text),
        detail: n.detail ? String(n.detail) : '',
        // loop: HOT-PATH-OK — per show() (≤ 4/s during a helper install's progress), N ≤ 3 actions
        actions: (n.actions || []).filter((a) => a && typeof a.id === 'string' && a.label).map((a) => ({ id: a.id, label: String(a.label), primary: !!a.primary, disabled: !!a.disabled, tip: a.tip ? String(a.tip) : '' })),
        dismissKey: n.dismissKey || '',
        closable: n.closable !== false,
        task: !!n.task,
        page: (n.place && n.place !== 'top' && n.place.page) || (n.page === 'about' ? 'about' : 'settings'),
        place: n.place && n.place !== 'top' ? { page: n.place.page, section: n.place.section } : 'top',
        role: n.kind === 'error' ? 'alert' : 'status'
      }
      const at = notices.findIndex((x) => x.id === notice.id)
      if (at >= 0 && JSON.stringify(notices[at]) === JSON.stringify(notice)) return
      if (at >= 0) notices = notices.map((x, i) => (i === at ? notice : x))
      else notices = notices.concat([notice])
      changed()
    }
    function clear(id) {
      const next = notices.filter((x) => x.id !== id)
      if (next.length !== notices.length) { notices = next; changed() }
    }
    function has(id) { return notices.some((x) => x.id === id) }
    function get(id) { return notices.find((x) => x.id === id) || null }
    // the ×: a task's key is remembered; anything else closes now
    function dismiss(id) {
      const n = get(id)
      if (!n || !n.closable) return false
      if (n.dismissKey) {
        if (!dismissed.includes(n.dismissKey)) {
          dismissed = dismissed.concat([n.dismissKey]).slice(-MAX_DISMISSED)
          saveDismissed(dismissed.slice())
        }
        changed()
      } else clear(id)
      return true
    }
    // keys whose reason no longer applies go (settled: id -> the keys current now; an id not listed is unknown yet)
    function prune(settled) {
      const kept = dismissed.filter((k) => { const cur = settled[idOf(k)]; return cur === undefined || cur.includes(k) })
      if (kept.length !== dismissed.length) { dismissed = kept; saveDismissed(dismissed.slice()) }
    }
    const visible = () => notices.filter((n) => !(n.dismissKey && dismissed.includes(n.dismissKey)))

    // the dots: per page (rail item) and per section, from the open tasks (dismissed or not)
    function reminders() {
      const pages = {}
      const sections = {}
      // loop: NOT-WORTH — N ≤ ~6 notices; on change
      for (const n of notices) {
        if (!n.task) continue
        const page = n.page
        pages[page] = pages[page] ? pages[page] + '\n' + n.text : n.text
        if (n.place !== 'top') sections[page + '/' + n.place.section] = n.text
      }
      return { pages, sections }
    }

    // --- toasts ---
    function toast(text, t) {
      const words = String(text || '')
      if (!words) return null
      if (o.windowShown && !o.windowShown()) return null
      const same = toasts.find((x) => x.text === words)
      if (same) { same.shownAt = ++version; onChange(); return same.id }
      const action = t && t.action && t.action.id && t.action.label ? { id: t.action.id, label: String(t.action.label) } : null
      const item = { id: nextToast++, text: words, action, durationMs: toastDuration(words, !!action), shownAt: ++version }
      toasts = toasts.slice(Math.max(0, toasts.length - (TOAST_MAX - 1))).concat([item])
      onChange()
      return item.id
    }
    function endToast(id) {
      const next = toasts.filter((x) => x.id !== id)
      if (next.length !== toasts.length) { toasts = next; changed() }
    }
    function clearToasts() { if (toasts.length) { toasts = []; changed() } }

    // the stored keys, once settings are read (main loads them after this model exists)
    function setDismissed(keys) { dismissed = parseDismissed(keys); changed() }

    return {
      show, clear, has, get, dismiss, prune, setDismissed, reminders, toast, endToast, clearToasts,
      visible, all: () => notices.slice(), toasts: () => toasts.slice(), dismissed: () => dismissed.slice(),
      version: () => version
    }
  }

  const api = { MAX_DISMISSED, TOAST_MAX, TOAST_MS, TOAST_ACTION_MS, noticeKey, idOf, parseDismissed, toastDuration, createNotices }
  if (typeof module === 'object' && module.exports) module.exports = api
  else root.SonataNotices = Object.freeze(api)
})(typeof globalThis !== 'undefined' ? globalThis : this)
