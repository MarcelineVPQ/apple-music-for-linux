// Writes Sonata's theme tokens (theme.js) onto a page and keeps its Glass surfaces' artwork backdrop.
// Loaded by every Sonata page: the rail and the side panel (plain script after theme.js, CSP 'self'),
// the toasts, the lyrics window and the mini player (require). Main sends one `theme` object to each
// view: { palette: { accent } | null, glass: bool, backdrop: { dark: { url, lumMin, lumMax },
// light: {...} } | null }. The page's light/dark comes from its own colour scheme.
//
//   const theme = SonataThemeApply.attach({ surfaces: [el, ...] })
//   theme.set(themeFromMain)        // on every push; unchanged input costs one string compare
//
// No timers, no animation frames: it redraws on set() and on a colour-scheme or reduced-transparency
// change. A new backdrop crossfades (CSS opacity on one of two layers, theme.css); Reduce motion makes it instant.
;(function (root) {
  'use strict'
  const T = root.SonataTheme || (typeof require === 'function' ? require('./theme') : null)

  function attach(opts) {
    const o = opts || {}
    const doc = o.document || root.document
    const rootEl = doc.documentElement
    const surfaces = (o.surfaces || []).filter(Boolean)
    const dark = root.matchMedia('(prefers-color-scheme: dark)')
    const plain = root.matchMedia('(prefers-reduced-transparency: reduce)')
    let input = null
    let key = ''
    const written = {}
    let shownUrl = ''
    // two backdrop layers per surface; `front` is the one showing
    const layers = surfaces.map((s) => {
      s.classList.add('s-glass')
      const a = doc.createElement('div'); a.className = 's-bd'
      const b = doc.createElement('div'); b.className = 's-bd'
      const tint = doc.createElement('div'); tint.className = 's-tint'
      s.prepend(a, b, tint)
      return { a, b, front: null }
    })

    function render() {
      const isDark = dark.matches
      const glass = !!(input && input.glass) && !plain.matches
      const bd = glass && input && input.backdrop ? input.backdrop[isDark ? 'dark' : 'light'] : null
      const palette = input && input.palette ? input.palette : null
      const k = [isDark, glass, palette ? palette.accent : '', bd ? bd.url.length + ':' + bd.lumMin + ':' + bd.lumMax + ':' + (bd.lo || '') : ''].join('|')
      if (k === key) return
      key = k
      const t = T.themeTokens({ dark: isDark, palette, glass, backdrop: bd })
      // loop: NOT-WORTH — ~28 tokens, written only when one changed; once per track / theme change
      for (const name in t.vars) {
        if (written[name] !== t.vars[name]) { rootEl.style.setProperty(name, t.vars[name]); written[name] = t.vars[name] }
      }
      const url = bd ? bd.url : ''
      // loop: NOT-WORTH — one entry per Glass surface on the page (1-2)
      surfaces.forEach((s, i) => {
        s.classList.toggle('glass-on', !!url)
        const L = layers[i]
        if (url === shownUrl) return
        if (!url) { L.a.classList.remove('on'); L.b.classList.remove('on'); L.front = null; return }
        const next = L.front === L.a ? L.b : L.a
        next.style.backgroundImage = 'url("' + url + '")'
        next.classList.add('on')
        if (L.front) L.front.classList.remove('on')
        L.front = next
      })
      shownUrl = url
    }
    // lifetime: OK — one 'change' listener on each of the two media queries, for the page's life · fires on
    // a theme switch (Ctrl+D, the desktop) or a reduced-transparency change only
    dark.addEventListener('change', render)
    plain.addEventListener('change', render)
    render()
    return {
      set(next) { input = next || null; render() },
      tokens: () => Object.assign({}, written),
      state: () => ({ key, url: shownUrl, glass: !!(input && input.glass), dark: dark.matches })
    }
  }

  const api = { attach }
  if (typeof module === 'object' && module.exports) module.exports = api
  else root.SonataThemeApply = Object.freeze(api)
})(typeof globalThis !== 'undefined' ? globalThis : this)
