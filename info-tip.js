// The ⓘ (the DS5 app's rule for long text, Marcy 2026-10-18): the visible text stays short (at most
// TEXT_MAX characters) and the longer explanation sits behind a small button beside it; shown on hover and
// keyboard focus, a click toggles it (touch), Esc closes it. Screen readers get it as the button's
// description (aria-describedby: the text is always in the page, hidden). One implementation for every
// page that has one (the sheet-notes band, the lyrics view's notes); the look is lyrics.html's .sn-info /
// .sn-tip (theme tokens only; the tip is placed under its parent, which is position: relative).
// Idle cost: none (no timers; six listeners on the button for its parent's life).
const TEXT_MAX = 60

let tipCount = 0   // a unique id per ⓘ for its description

/**
 * createInfoTip(doc, parent) -> { button, set(info) }: the ⓘ and its texts appended to parent, hidden
 * while there is no info. set('') hides it again.
 */
function createInfoTip(doc, parent) {
  const mk = (tag, cls) => { const e = doc.createElement(tag); e.className = cls; parent.appendChild(e); return e }
  const button = mk('button', 'sn-info')
  button.type = 'button'
  button.textContent = 'i'
  button.setAttribute('aria-label', 'More about this')
  button.hidden = true
  const text = mk('span', 'sn-info-text')
  text.id = 'sn-info-text-' + (++tipCount)
  text.hidden = true
  button.setAttribute('aria-describedby', text.id)
  const tip = mk('span', 'sn-tip')
  tip.setAttribute('aria-hidden', 'true')
  tip.hidden = true
  const show = (on) => { tip.hidden = !on || !text.textContent; button.classList.toggle('open', !tip.hidden) }
  // lifetime: OK — the ⓘ's listeners, released with its parent
  button.onmouseenter = () => show(true)
  button.onmouseleave = () => { if (doc.activeElement !== button) show(false) }
  button.onfocus = () => show(true)
  button.onblur = () => show(false)
  button.onclick = (e) => { e.stopPropagation(); show(tip.hidden) }
  button.onkeydown = (e) => { if (e.key === 'Escape' && !tip.hidden) { e.preventDefault(); e.stopPropagation(); show(false) } }
  return {
    button,
    get info() { return text.textContent },
    set(info) {
      const t = String(info || '')
      text.textContent = t
      tip.textContent = t
      button.hidden = !t
      if (!t) show(false)
    }
  }
}

module.exports = { TEXT_MAX, createInfoTip }
