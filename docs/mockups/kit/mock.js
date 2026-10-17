// Shared helpers for the wave-2 mock-ups (design only: none of this ships).
// - The theme: Sonata's real theme.js (../../theme.js, loaded first) computes every --s-* token from
//   the album palette (palette.js output, data/albums.js), dark / light and Glass, exactly as the app
//   does; the Glass backdrop is theme.js makeBackdrop's own 40×40 output for that cover.
// - The control bar on top of each page drives the mock (album colour, dark / light, Glass, play).
// - A fake clock (or a real <audio>) drives the lyrics; nothing runs while paused.
;(function () {
  'use strict'
  const T = window.SonataTheme
  const ALB = window.MOCK_ALBUMS || { covers: {}, photos: {} }

  // --- icons (the mini player's own paths where it has them) ---
  const P = {
    shuffle: 'M11.5 2.5h3v3l-1.15-1.15-2.8 2.8-1.06-1.06 2.8-2.8L11.5 2.5zM1 3h2.9c.5 0 .97.2 1.32.55l1.53 1.53-1.06 1.06-1.53-1.53a.37.37 0 0 0-.26-.11H1V3zm13.5 7.5v3h-3l1.15-1.15-2.44-2.44a.37.37 0 0 0-.26-.11H8v-1.5h1.95c.5 0 .97.2 1.32.55l2.44 2.44 1.29-1.29zM1 11.5h2.9c.1 0 .19-.04.26-.11l6.19-6.19 1.5 1.06-6.63 6.63c-.35.35-.83.55-1.32.55H1v-1.5z',
    prev: 'M8.7 7.35 14.6 3.6a.75.75 0 0 1 1.15.63v7.54a.75.75 0 0 1-1.15.63L8.7 8.65v3.12a.75.75 0 0 1-1.15.63L1.3 8.63a.75.75 0 0 1 0-1.26L7.55 3.6a.75.75 0 0 1 1.15.63v3.12z',
    play: 'M4 2.3a.75.75 0 0 1 1.15-.63l9 5.7a.75.75 0 0 1 0 1.26l-9 5.7A.75.75 0 0 1 4 13.7V2.3z',
    pause: 'M4 2h2.5v12H4zM9.5 2H12v12H9.5z',
    next: 'M7.3 7.35 1.4 3.6a.75.75 0 0 0-1.15.63v7.54a.75.75 0 0 0 1.15.63l5.9-3.75v3.12a.75.75 0 0 0 1.15.63l6.25-3.77a.75.75 0 0 0 0-1.26L8.45 3.6a.75.75 0 0 0-1.15.63v3.12z',
    repeat: 'M3.5 5.5h7V7l3-2.25L10.5 2.5V4h-7A2.5 2.5 0 0 0 1 6.5V8h1.5V6.5c0-.55.45-1 1-1zm9 5h-7V9l-3 2.25 3 2.25V12h7A2.5 2.5 0 0 0 15 9.5V8h-1.5v1.5c0 .55-.45 1-1 1z',
    lyrics: 'M8 1.5c-3.87 0-7 2.57-7 5.75 0 1.84 1.05 3.47 2.68 4.52-.13.72-.53 1.5-1.32 2.14-.18.15-.06.44.17.42 1.55-.15 2.77-.82 3.55-1.48.61.13 1.25.2 1.92.2 3.87 0 7-2.57 7-5.8S11.87 1.5 8 1.5zM4.5 8.5a1 1 0 1 1 0-2 1 1 0 0 1 0 2zm3.5 0a1 1 0 1 1 0-2 1 1 0 0 1 0 2zm3.5 0a1 1 0 1 1 0-2 1 1 0 0 1 0 2z',
    queue: 'M1 3h9v1.5H1V3zm0 4h9v1.5H1V7zm0 4h6v1.5H1V11zm11.5-8H14v7.55a2.5 2.5 0 1 1-1.5-.51V3z',
    vol: 'M8.5 2.06a.75.75 0 0 1 .43.68v10.52a.75.75 0 0 1-1.21.59L4.6 11.5H2.25a.75.75 0 0 1-.75-.75v-5.5A.75.75 0 0 1 2.25 4.5H4.6l3.12-2.35a.75.75 0 0 1 .78-.09zM11.3 5.53a.75.75 0 0 1 1.06 0 3.5 3.5 0 0 1 0 4.95.75.75 0 1 1-1.06-1.07 2 2 0 0 0 0-2.82.75.75 0 0 1 0-1.06zm1.94-1.94a.75.75 0 0 1 1.06 0 6.25 6.25 0 0 1 0 8.83.75.75 0 1 1-1.06-1.06 4.75 4.75 0 0 0 0-6.71.75.75 0 0 1 0-1.06z',
    star: 'M8 1.6l1.86 3.95 4.14.5-3.06 2.86.83 4.19L8 11.6l-3.77 1.5.83-4.19L2 6.05l4.14-.5z',
    more: 'M1.5 8a1.5 1.5 0 1 0 3 0 1.5 1.5 0 0 0-3 0zm5 0a1.5 1.5 0 1 0 3 0 1.5 1.5 0 0 0-3 0zm5 0a1.5 1.5 0 1 0 3 0 1.5 1.5 0 0 0-3 0z',
    close: 'M3.28 2.22a.75.75 0 0 0-1.06 1.06L6.94 8l-4.72 4.72a.75.75 0 1 0 1.06 1.06L8 9.06l4.72 4.72a.75.75 0 1 0 1.06-1.06L9.06 8l4.72-4.72a.75.75 0 0 0-1.06-1.06L8 6.94 3.28 2.22z',
    note: 'M13 1.2v9.3a2.5 2.5 0 1 1-1.5-2.29V4.4L6 5.7v6.8a2.5 2.5 0 1 1-1.5-2.29V3.1z',
    photo: 'M2 3h12a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1H2a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1zm.5 8.5h11L10 7l-2.5 3L6 8.5zM5 7a1.25 1.25 0 1 0 0-2.5A1.25 1.25 0 0 0 5 7z',
    book: 'M1.5 3c2-.6 4.2-.4 5.75.6V14c-1.55-1-3.75-1.2-5.75-.6zm13 0v10.4c-2-.6-4.2-.4-5.75.6V3.6C10.3 2.6 12.5 2.4 14.5 3z',
    mic: 'M8 1a2.5 2.5 0 0 0-2.5 2.5v4a2.5 2.5 0 0 0 5 0v-4A2.5 2.5 0 0 0 8 1zM3.5 7.25H5a3 3 0 0 0 6 0h1.5a4.5 4.5 0 0 1-3.75 4.44V14h-1.5v-2.31A4.5 4.5 0 0 1 3.5 7.25z',
    chevL: 'M10.3 2.3a.75.75 0 0 1 0 1.06L5.66 8l4.64 4.64a.75.75 0 1 1-1.06 1.06L4.07 8.53a.75.75 0 0 1 0-1.06L9.24 2.3a.75.75 0 0 1 1.06 0z',
    chevR: 'M5.7 2.3a.75.75 0 0 0 0 1.06L10.34 8 5.7 12.64a.75.75 0 1 0 1.06 1.06l5.17-5.17a.75.75 0 0 0 0-1.06L6.76 2.3a.75.75 0 0 0-1.06 0z',
    expand: 'M2 2h4.5v1.5H3.5v3H2zm12 0v4.5h-1.5v-3h-3V2zM2 14V9.5h1.5v3h3V14zm12 0H9.5v-1.5h3v-3H14z',
    sonata: 'M8 1a7 7 0 1 0 0 14A7 7 0 0 0 8 1zm2.6 3.3v5.2a1.9 1.9 0 1 1-1.1-1.72V5.6L6.5 6.3v4.4a1.9 1.9 0 1 1-1.1-1.72V5.4z'
  }
  const icon = (name) => '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="' + P[name] + '"/></svg>'

  const fmt = (s) => {
    s = Math.max(0, s)
    const m = Math.floor(s / 60)
    const ss = Math.floor(s % 60)
    return m + ':' + String(ss).padStart(2, '0')
  }
  const el = (tag, cls, html) => {
    const e = document.createElement(tag)
    if (cls) e.className = cls
    if (html !== undefined) e.innerHTML = html
    return e
  }
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))

  // --- per-viewer convenience: the theme choice carries from page to page ---
  const store = {
    get(k, d) { try { const v = localStorage.getItem('sonata-mock-' + k); return v === null ? d : JSON.parse(v) } catch (e) { return d } },
    set(k, v) { try { localStorage.setItem('sonata-mock-' + k, JSON.stringify(v)) } catch (e) { /* private window: fine */ } }
  }

  // --- the theme ---
  const theme = {
    album: store.get('album', 'gorge'),
    dark: store.get('dark', true),
    glass: store.get('glass', true),
    subs: [],
    surfaces: []
  }
  const bdUrl = {}
  function backdropUrl(album, mode) {
    const k = album + ':' + mode
    if (bdUrl[k]) return bdUrl[k]
    const b = ALB.covers[album].backdrop[mode]
    const c = document.createElement('canvas')
    c.width = 40; c.height = 40
    const ctx = c.getContext('2d')
    ctx.putImageData(new ImageData(Uint8ClampedArray.from(b.px), 40, 40), 0, 0)
    bdUrl[k] = c.toDataURL()
    return bdUrl[k]
  }
  function glassSurface(s) {
    if (s._glass) return
    s.classList.add('s-glass')
    const a = el('div', 's-bd'); const b = el('div', 's-bd'); const tint = el('div', 's-tint')
    s.prepend(a, b, tint)
    s._glass = { a, b, front: null, url: '' }
    theme.surfaces.push(s)
  }
  function applyTheme() {
    const a = theme.album && ALB.covers[theme.album] ? ALB.covers[theme.album] : null
    const mode = theme.dark ? 'dark' : 'light'
    const bd = theme.glass && a ? a.backdrop[mode] : null
    const t = T.themeTokens({
      dark: theme.dark,
      palette: a ? a.palette : null,
      glass: theme.glass,
      backdrop: bd ? { lumMin: bd.lumMin, lumMax: bd.lumMax, lo: bd.lo, hi: bd.hi } : null
    })
    const r = document.documentElement
    r.style.colorScheme = mode
    for (const n in t.vars) r.style.setProperty(n, t.vars[n])
    // lyrics.html: the sung line takes the album accent as text while there's an album colour
    if (a) {
      r.style.setProperty('--active', 'var(--s-accent-text)')
      r.style.setProperty('--active-2', 'var(--s-accent-2-text)')
      r.style.setProperty('--active-mix', 'var(--s-accent-mix-text)')
    } else {
      r.style.setProperty('--active', 'var(--s-text)')
      r.style.removeProperty('--active-2')
      r.style.removeProperty('--active-mix')
    }
    const url = bd ? backdropUrl(theme.album, mode) : ''
    theme.surfaces.forEach((s) => {
      s.classList.toggle('glass-on', !!url)
      const L = s._glass
      if (url === L.url) return
      L.url = url
      if (!url) { L.a.classList.remove('on'); L.b.classList.remove('on'); L.front = null; return }
      const nx = L.front === L.a ? L.b : L.a
      nx.style.backgroundImage = 'url("' + url + '")'
      nx.classList.add('on')
      if (L.front) L.front.classList.remove('on')
      L.front = nx
    })
    theme.last = t
    theme.subs.forEach((f) => f(t))
  }
  function setTheme(patch) {
    Object.assign(theme, patch)
    store.set('album', theme.album); store.set('dark', theme.dark); store.set('glass', theme.glass)
    applyTheme()
  }

  // --- the clock: fake (rAF while playing) or an <audio> element's own time ---
  function Clock(duration, opts) {
    const o = opts || {}
    const c = { t: o.start || 0, playing: false, duration, subs: [], audio: o.audio || null, loop: o.loop !== false, rate: 1 }
    let raf = 0; let last = 0
    function tick(now) {
      if (c.audio) c.t = c.audio.currentTime
      else {
        c.t += (now - last) / 1000 * c.rate
        last = now
        if (c.t >= c.duration) {
          if (c.loop) c.t = o.loopTo || 0
          else { c.t = c.duration; c.pause() }
        }
      }
      c.subs.forEach((f) => f(c.t, c.playing))
      if (c.playing) raf = requestAnimationFrame(tick)
    }
    c.on = (f) => { c.subs.push(f); f(c.t, c.playing) }
    c.play = () => {
      if (c.playing) return
      c.playing = true
      if (c.audio) c.audio.play().catch(() => {})
      last = performance.now()
      raf = requestAnimationFrame(tick)
      c.subs.forEach((f) => f(c.t, true))
    }
    c.pause = () => {
      c.playing = false
      cancelAnimationFrame(raf)
      if (c.audio) c.audio.pause()
      c.subs.forEach((f) => f(c.t, false))
    }
    c.toggle = () => (c.playing ? c.pause() : c.play())
    c.seek = (t) => {
      c.t = Math.max(0, Math.min(c.duration, t))
      if (c.audio) c.audio.currentTime = c.t
      c.subs.forEach((f) => f(c.t, c.playing))
    }
    if (c.audio) c.audio.addEventListener('ended', () => { if (c.loop) { c.audio.currentTime = 0; c.audio.play() } else c.pause() })
    return c
  }

  // --- the control bar ---
  function bar(opts) {
    const o = opts || {}
    const b = el('header', 'mock-bar')
    b.innerHTML =
      '<a class="home" href="index.html" title="All wave-2 mock-ups">' + icon('sonata') + 'Sonata <small>wave 2 · ' + esc(o.title || '') + '</small></a>' +
      '<span class="tag">Design mock-up · not in the app</span>' +
      '<span class="grow"></span>'
    const right = el('div'); right.style.cssText = 'display:flex;align-items:center;gap:14px'
    if (o.extra) o.extra.forEach((x) => { right.appendChild(x); right.appendChild(el('span', 'sep')) })
    // album colour
    const al = el('div', 'albums')
    al.appendChild(el('label', 'k', 'Album'))
    const choices = [[null, 'No album colour (Apple red)']].concat(Object.keys(ALB.covers).map((k) => [k, 'Album colour from this cover (palette.js)']))
    const albBtns = choices.map(([k, title]) => {
      const x = el('button')
      x.title = title
      if (k) x.style.backgroundImage = 'url(img/cover-' + k + '.jpg)'
      else x.textContent = '–'
      x.onclick = () => setTheme({ album: k })
      al.appendChild(x)
      return [k, x]
    })
    right.appendChild(al)
    right.appendChild(el('span', 'sep'))
    // dark / light
    const seg = el('div', 'seg')
    const bD = el('button', '', 'Dark'); const bL = el('button', '', 'Light')
    bD.onclick = () => setTheme({ dark: true }); bL.onclick = () => setTheme({ dark: false })
    seg.append(bD, bL)
    right.appendChild(seg)
    const gl = sw('Glass', theme.glass, (v) => setTheme({ glass: v }))
    gl.title = 'Glass: the blurred album artwork under the window tint (Settings → Appearance)'
    right.appendChild(gl)
    if (o.pins !== false) {
      right.appendChild(el('span', 'sep'))
      const pins = sw('Notes', !document.body.classList.contains('no-pins'), (v) => document.body.classList.toggle('no-pins', !v))
      pins.title = 'Show the numbered design notes'
      right.appendChild(pins)
    }
    if (o.clock) {
      right.appendChild(el('span', 'sep'))
      const pb = el('button', 'ib fill')
      pb.title = 'Play / pause the mock-up (Space)'
      const tm = el('span'); tm.style.cssText = 'font-variant-numeric:tabular-nums;min-width:74px;color:var(--s-soft)'
      pb.onclick = () => o.clock.toggle()
      o.clock.on((t, playing) => {
        const want = playing ? 'pause' : 'play'
        if (pb.dataset.i !== want) { pb.innerHTML = icon(want); pb.dataset.i = want }
        tm.textContent = fmt(t) + ' / ' + fmt(o.clock.duration)
      })
      right.append(pb, tm)
      document.addEventListener('keydown', (e) => { if (e.code === 'Space' && e.target === document.body) { e.preventDefault(); o.clock.toggle() } })
    }
    b.appendChild(right)
    document.body.prepend(b)
    const sync = () => {
      albBtns.forEach(([k, x]) => x.setAttribute('aria-pressed', String(k === theme.album)))
      bD.setAttribute('aria-pressed', String(theme.dark)); bL.setAttribute('aria-pressed', String(!theme.dark))
      gl.setAttribute('aria-checked', String(theme.glass))
    }
    theme.subs.push(sync)
    sync()
    return b
  }
  function sw(label, on, onChange) {
    const x = el('button', 'sw', '<i></i>' + esc(label))
    x.setAttribute('role', 'switch')
    x.setAttribute('aria-checked', String(!!on))
    x.style.cssText = 'border:0;background:none;padding:0'
    x.onclick = () => {
      const v = x.getAttribute('aria-checked') !== 'true'
      x.setAttribute('aria-checked', String(v))
      onChange(v)
    }
    return x
  }
  function seg(options, value, onChange) {
    const s = el('div', 'seg')
    const btns = options.map(([v, label, title]) => {
      const x = el('button', '', esc(label))
      if (title) x.title = title
      x.onclick = () => { set(v); onChange(v) }
      s.appendChild(x)
      return [v, x]
    })
    function set(v) { btns.forEach(([k, x]) => x.setAttribute('aria-pressed', String(k === v))) }
    set(value)
    s.set = set
    return s
  }

  // --- lyrics: timed words from plain lines ---
  // lines: [{ text, t, d, side, bg: { text, t, d } }] -> the same with words: [{ text, t, end }]
  function wordsOf(text, t, d) {
    const parts = text.split(/\s+/).filter(Boolean)
    const weight = parts.map((w) => w.replace(/[^\p{L}\p{N}']/gu, '').length + 1.5)
    const sum = weight.reduce((a, b) => a + b, 0)
    let at = t
    const span = d * 0.94
    return parts.map((w, i) => {
      const len = span * weight[i] / sum
      const r = { text: w, t: at, end: at + len }
      at += len
      return r
    })
  }
  function timeLines(lines) {
    return lines.map((l, i) => Object.assign({}, l, {
      i,
      end: l.t + l.d,
      words: wordsOf(l.text, l.t, l.d),
      bg: l.bg ? Object.assign({}, l.bg, { end: l.bg.t + l.bg.d, words: wordsOf(l.bg.text, l.bg.t, l.bg.d) }) : null
    }))
  }
  function wordsHtml(words) {
    return words.map((w) => '<span class="w" data-text="' + esc(w.text) + '"><span class="r">' + esc(w.text) + '</span><span class="b">' + esc(w.text) + '</span></span>').join(' ')
  }
  // mark words sung / now inside a line element for time t
  function markWords(lineEl, words, t) {
    const ws = lineEl._ws || (lineEl._ws = Array.from(lineEl.querySelectorAll(':scope > .w, :scope > .main > .w')))
    ws.forEach((w, i) => {
      const wd = words[i]
      if (!wd) return
      const sung = t >= wd.t
      const now = t >= wd.t && t < wd.end + 0.08
      if (w._s !== sung) { w.classList.toggle('sung', sung); w._s = sung }
      if (w._n !== now) { w.classList.toggle('now', now); w._n = now }
    })
  }

  // a scrolling lyric list in Sonata's style: active line held at `anchor` of the box, interlude dots
  function LyricList(box, lines, opts) {
    const o = Object.assign({ anchor: 0.32, gap: 4, side: true, dotsBefore: true, bgMode: 'inline' }, opts || {})
    box.classList.add('lyr')
    const roll = el('div', 'roll')
    box.appendChild(roll)
    const items = []
    let prevEnd = 0
    lines.forEach((l, i) => {
      if (o.dotsBefore && l.t - prevEnd > o.gap) {
        const d = el('div', 'dots ' + (o.side && l.side ? l.side : 'plainside'), '<div class="row"><i></i><i></i><i></i></div>')
        roll.appendChild(d)
        items.push({ kind: 'dots', el: d, t: prevEnd + 0.4, end: l.t, line: l })
      }
      const e = el('div', 'line ' + (o.side && l.side ? l.side : ''))
      e.innerHTML = wordsHtml(l.words) + (l.bg && o.bgMode === 'inline' ? '<div class="bgv">' + wordsHtml(l.bg.words) + '</div>' : '')
      if (o.onLine) o.onLine(e, l)
      roll.appendChild(e)
      items.push({ kind: 'line', el: e, t: l.t, end: l.end, line: l })
      prevEnd = Math.max(prevEnd, l.end)
    })
    if (o.footer) roll.appendChild(o.footer)
    let cur = null
    function update(t) {
      // the current item: the last whose start passed (dots only inside their window)
      let now = null
      for (const it of items) {
        if (it.kind === 'dots') { if (t >= it.t && t < it.end) now = it }
        else if (t >= it.t - 0.05) now = it
      }
      items.forEach((it) => {
        if (it.kind === 'line') {
          const act = it === now || (now && now.kind === 'line' && now !== it && false)
          if (it._a !== act) { it.el.classList.toggle('active', act); it._a = act }
          const past = t > it.end && !act
          if (it._p !== past) { it.el.classList.toggle('past', past); it._p = past }
          if (act || it._lastMark) {
            markWords(it.el, it.line.words, t)
            if (it.line.bg && o.bgMode === 'inline') {
              const bgEl = it.el.querySelector('.bgv')
              if (bgEl) markWords(bgEl, it.line.bg.words, t)
            }
            it._lastMark = act
          }
        } else {
          const on = it === now
          if (it._on !== on) { it.el.classList.toggle('on', on); it._on = on }
          if (on) {
            const p = (t - it.t) / (it.end - it.t)
            const dots = it.el.querySelectorAll('i')
            dots.forEach((d, k) => {
              const f = Math.max(0, Math.min(1, p * 3 - k))
              d.style.opacity = String(0.25 + 0.75 * f)
              d.style.transform = 'scale(' + (1 + 0.15 * f * (1 - f) * 4) + ')'
            })
            const breathe = 1 + 0.06 * Math.sin(t * 3)
            it.el.firstChild.style.transform = 'scale(' + (p > 0.92 ? 1 - (p - 0.92) * 8 : breathe) + ')'
          }
        }
      })
      if (now !== cur) {
        cur = now
        const target = now ? now.el : items[0].el
        const y = box.clientHeight * o.anchor - target.offsetTop
        roll.style.transform = 'translateY(' + Math.round(Math.min(o.top || 24, y)) + 'px)'
        if (o.onActive) o.onActive(now)
      }
    }
    return { update, roll, items, current: () => cur }
  }

  // the "what to judge" notes: a small pill that opens into the list (closed by default, so the notes
  // never cover the design; the numbered pins stay on it)
  function judge() {
    const j = document.querySelector('.judge')
    if (!j) return
    const h = j.querySelector('h4')
    const n = j.querySelectorAll('li').length
    h.innerHTML = 'What to judge <span>' + n + ' notes</span>'
    h.onclick = () => j.classList.toggle('open')
    const bar = document.querySelector('.mock-bar .tag')
    if (bar) bar.after(j)
    j.classList.add('open')   // open on arrival; one click folds it away
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') j.classList.remove('open') })
  }
  document.addEventListener('DOMContentLoaded', judge)

  window.Mock = { icon, fmt, el, esc, theme, setTheme, applyTheme, glassSurface, Clock, bar, sw, seg, timeLines, wordsOf, wordsHtml, markWords, LyricList, store, albums: ALB }
  // first paint: the tokens before anything else draws
  applyTheme()
})()
