// Sheet notes in the Studio: the band above the lyrics (lyrics.html #band, stage-ui.js setBand). It only
// draws: what to show comes from sheet-notes-model.js (mode, gate, layout), the notes and the pitch line
// from main ('lyrics-sheet'), the time from the lyrics view's clock.
//
// Render path (docs/PERFORMANCE.md "Sheet notes"): the whole song is drawn once into one wide strip (SVG
// for the notes and the pitch line, HTML spans for the syllables); playing moves the strip with ONE Web
// Animation of its transform (translateX, linear to the song's end), which the compositor runs without
// the page: no script and no style or layout per frame. It is re-synced only when it drifts (> 60 ms)
// on the 2/s time pushes, paused with the song, and paused while the window is hidden. The note being
// sung gets its class at the note's start and end only (one timeout to the next change, like the lyrics'
// words). Paused or hidden: no animation running, no timer, 0 frames. Reduced motion: no scrolling; the
// staff turns a page at a time (no animation) and the playhead steps on the time pushes.
'use strict'
const M = require('./sheet-notes-model')
const { GLYPHS, SPACE } = require('./sheet-notes-glyphs')

const SVG = 'http://www.w3.org/2000/svg'
const H = 6                    // half a staff space, px (a staff space is 12 px)
const BASE = 92                // y of the staff's bottom line in the band's staff box, px
const SYL_Y = 120              // the syllables' baseline (lyrics.html .sn-syls .s: top 108 px, 12 px type)
const PLACES = [['band', 'Band on top', 'The staff in a band above the lyrics'], ['over', 'Over the sung line', 'The staff rides just above the line being sung']]
const SYL_EM = 6.6             // px per letter of a syllable (12 px semibold), to keep syllables apart
const STAFF_H = 132            // the staff box's height (the 18 px label row is above it; the band is 150 px)
const PPS = { notes: 110, line: 36 }        // px per second: the staff; the first play's wider view of what was heard
const HEAD_AT = { notes: 0.3, line: 0.86 }  // where the playhead sits across the band (share of its width)

function el(doc, tag, cls, parent) {
  const e = doc.createElement(tag)
  if (cls) e.className = cls
  if (parent) parent.appendChild(e)
  return e
}
function sv(doc, tag, attrs, parent) {
  const e = doc.createElementNS(SVG, tag)
  // loop: NOT-WORTH — a few attributes per element, at build time only
  for (const k in attrs) e.setAttribute(k, attrs[k])
  if (parent) parent.appendChild(e)
  return e
}
const yOf = (pos) => BASE - pos * H
const r1 = (v) => Math.round(v * 10) / 10

// Noto Music's staff space is 244 units (its staff lines at 12…988); clefs at that size, accidentals a
// little smaller (2.5 staff spaces for a sharp, as engravers set them beside a note)
const K = (2 * H) / (SPACE - 6)
const ACC_K = K * 0.74
// a glyph from sheet-notes-glyphs.js at (x, y of its origin), scaled
function glyph(doc, name, x, y, parent, cls, k = K) {
  return sv(doc, 'path', { d: GLYPHS[name].d, class: cls || 'gl', transform: 'translate(' + r1(x) + ' ' + r1(y) + ') scale(' + k.toFixed(5) + ')' }, parent)
}
// an accidental centred on the line or space at y (a flat's bowl, not its stem, sits there), its right
// edge at x -> its width
function accidentalAt(doc, name, x, y, parent, cls) {
  const g = GLYPHS[name]
  const centre = name === 'flat' || name === 'dflat' ? g.bottom + (g.top - g.bottom) * 0.26 : (g.top + g.bottom) / 2
  const w = g.w * ACC_K
  glyph(doc, name, x - w, y - centre * ACC_K, parent, cls, ACC_K)
  return w
}
const ACC_NAME = { [M.SHARP]: 'sharp', [M.FLAT]: 'flat', '♮': 'natural', '𝄪': 'dsharp', '𝄫': 'dflat' }

/**
 * createSheetBand({ doc, time() (the lyrics clock, s), playing() , reducedMotion() , onLayout() })
 * -> { el, setState(st), setTime(), hasContent, mode }
 * st: main's 'lyrics-sheet' (on, installed, precise, key, wordSynced, timed, aligned, paused, error, entry?, pitch?)
 */
let bandCount = 0   // a unique id per band for the ⓘ's description
function createSheetBand(opts) {
  const doc = opts.doc
  const root = el(doc, 'div', 'sn')
  const top = el(doc, 'div', 'sn-top', root)
  const exp = el(doc, 'span', 'sn-exp', top)
  exp.textContent = 'Experimental'
  const label = el(doc, 'span', 'sn-label', top)
  const msg = el(doc, 'span', 'sn-msg', top)
  // the ⓘ (the DS5 app's rule for long text): the longer explanation behind a small button beside the
  // message; shown on hover and keyboard focus, a click toggles it (touch), Esc closes it. Screen readers
  // get it as the button's description (aria-describedby: the text is always in the page, hidden).
  // Idle cost: none (no timers; three listeners on the button for the band's life).
  const info = el(doc, 'button', 'sn-info', top)
  info.type = 'button'
  info.textContent = 'i'
  info.setAttribute('aria-label', 'More about this')
  info.hidden = true
  const infoText = el(doc, 'span', 'sn-info-text', top)
  infoText.id = 'sn-info-text-' + (++bandCount)
  infoText.hidden = true
  info.setAttribute('aria-describedby', infoText.id)
  const tip = el(doc, 'span', 'sn-tip', top)
  tip.setAttribute('aria-hidden', 'true')
  tip.hidden = true
  const showTip = (on) => { tip.hidden = !on || !infoText.textContent; info.classList.toggle('open', !tip.hidden) }
  // lifetime: OK — the ⓘ's listeners, set once with the band, released with the window
  info.onmouseenter = () => showTip(true)
  info.onmouseleave = () => { if (doc.activeElement !== info) showTip(false) }
  info.onfocus = () => showTip(true)
  info.onblur = () => showTip(false)
  info.onclick = (e) => { e.stopPropagation(); showTip(tip.hidden) }
  info.onkeydown = (e) => { if (e.key === 'Escape' && !tip.hidden) { e.preventDefault(); e.stopPropagation(); showTip(false) } }
  // where the staff sits (Settings → Experimental → Sheet notes placement, remembered): two buttons,
  // shown while there is something to draw
  const placeSeg = el(doc, 'span', 'sn-place', top)
  placeSeg.setAttribute('role', 'group')
  placeSeg.setAttribute('aria-label', 'Staff placement')
  const placeBtns = PLACES.map(([value, text, tip]) => {
    const b = el(doc, 'button', '', placeSeg)
    b.type = 'button'
    b.textContent = text
    b.title = tip
    b.dataset.place = value
    // lifetime: OK — two click handlers, set once with the band, released with the window
    b.onclick = () => { if (st.place !== value && opts.onPlace) opts.onPlace(value) }
    return b
  })
  const box = el(doc, 'div', 'sn-staff', root)
  box.setAttribute('aria-hidden', 'true')           // the drawing; what it shows is in the band's aria-label
  const fixed = sv(doc, 'svg', { class: 'sn-fixed', height: STAFF_H }, box)
  const view = el(doc, 'div', 'sn-view', box)
  const strip = el(doc, 'div', 'sn-strip', view)
  const head = el(doc, 'div', 'sn-head', box)

  let st = { on: false }
  let entry = null          // the cached notes (main's entry), as sent
  let pieces = []           // the first play's pitch pieces
  let doc2 = null           // expand(entry)
  let gated = null          // gate(doc2)
  let lay = null            // layout(doc2, gated)
  let m = { band: 'off' }   // mode()
  let built = ''            // what the strip holds ('notes:<key>' | 'line:<n>')
  let gutter = 60
  let anim = null           // the strip's Web Animation
  let animFrom = 0          // the song time the animation started at
  let wake = 0              // the timeout to the next note change
  let items = []            // [{ g, syl, i }] per drawn note
  let nowIdx = -2
  let page = -1             // reduced motion: the page shown
  let duration = 0
  let lineRuns = []         // the first play's drawn runs (buildLine), for lineGap
  let gapShown = null       // the first play's "this part shows once sung" note while it is up

  const pps = () => PPS[m.band === 'line' ? 'line' : 'notes']
  const headAt = () => HEAD_AT[m.band === 'line' ? 'line' : 'notes']

  // --- the fixed part: staff lines, clef, key signature ---
  function drawFixed(clef, fifths) {
    fixed.replaceChildren()
    // loop: NOT-WORTH — five staff lines, per build
    for (let p = 0; p <= 8; p += 2) sv(doc, 'line', { x1: 0, x2: '100%', y1: yOf(p), y2: yOf(p), class: 'sl' }, fixed)
    const k = (2 * H) / (SPACE - 6)
    // the clefs' origins: Noto Music's staff has its bottom line 12 units over the baseline
    const baseY = BASE + 12 * k
    glyph(doc, clef === 'bass' ? 'bass' : 'treble', 4, baseY, fixed, 'gl clef')
    let x = clef === 'bass' ? 42 : 36
    if (clef === 'treble8') { const t = sv(doc, 'text', { x: 14, y: yOf(-4) + 2, class: 'clef8' }, fixed); t.textContent = '8' }
    // loop: NOT-WORTH — at most 7 key-signature signs, per build
    for (const s of M.keySignature(fifths, clef)) {
      const name = s.glyph === M.SHARP ? 'sharp' : 'flat'
      x += accidentalAt(doc, name, x + GLYPHS[name].w * ACC_K, yOf(s.pos), fixed, 'gl key') + 2
    }
    gutter = x + 10
    view.style.left = gutter + 'px'
  }

  // --- the moving part: the whole song once ---
  function buildNotes() {
    const clef = lay.clef
    drawFixed(clef, lay.fifths)
    const W = Math.ceil((duration || (lay.notes.length ? lay.notes[lay.notes.length - 1].end + 4 : 10)) * pps()) + 40
    strip.replaceChildren()
    strip.style.width = W + 'px'
    const svg = sv(doc, 'svg', { class: 'sn-svg', width: W, height: STAFF_H }, strip)
    const syls = el(doc, 'div', 'sn-syls', strip)
    const x = (t) => r1(t * pps())
    // bar lines, when the beats are known (the helper has no beat model yet: none today)
    // loop: NOT-WORTH — the song's bars (≤ ~150), per build
    for (const b of lay.bars) sv(doc, 'line', { x1: x(b), x2: x(b), y1: yOf(8), y2: yOf(0), class: 'bar' }, svg)
    // the pitch line where the notes are unsure (the gate's 'line' stretches)
    const lineSpans = gated.regions.filter((r) => r.show === 'line')
    const runs = M.pitchRuns(doc2.pitch, clef, lay.fifths, gated.song === 'line' ? null : lineSpans)
    drawRuns(svg, runs, x, 'pl')
    items = []
    let sylRight = -1e9
    // loop: NOT-WORTH — the song's notes (hundreds), once per build (a new song, new notes, a form change)
    lay.notes.forEach((n, i) => {
      if (n.show !== 'notes' || gated.song === 'line') return
      const g = sv(doc, 'g', { class: 'n' + (n.loose ? ' loose' : '') }, svg)
      const x0 = x(n.t)
      const x1 = Math.max(x0 + 2 * H, x(n.end))
      const y = yOf(n.pos)
      // loop: NOT-WORTH — a note's few ledger lines
      for (const p of n.ledgers) sv(doc, 'line', { x1: x0 - 9, x2: x0 + 9, y1: yOf(p), y2: yOf(p), class: 'ledger' }, g)
      sv(doc, 'rect', { x: x0, y: y - H * 0.5, width: r1(x1 - x0), height: H, rx: H * 0.5, class: 'held' }, g)
      sv(doc, 'ellipse', { cx: x0, cy: y, rx: H * 1.2, ry: H * 0.85, transform: 'rotate(-20 ' + x0 + ' ' + y + ')', class: 'head' }, g)
      if (n.acc) accidentalAt(doc, ACC_NAME[n.acc], x0 - H * 1.4, y, g, 'gl acc')
      let syl = null
      if (n.syl) {
        // under its note; a syllable sung right after the last one moves along so the two don't touch
        // (widths estimated from the letters: no layout read while building)
        const sx = Math.max(x0 - 4, sylRight + 5)
        syl = el(doc, 'span', 's', syls)
        syl.textContent = n.syl
        syl.style.transform = 'translateX(' + r1(sx) + 'px)'
        sylRight = sx + n.syl.length * SYL_EM
      } else if (n.ext && x1 - 2 > sylRight + 3) sv(doc, 'line', { x1: Math.max(x0 - 8, sylRight + 3), x2: x1, y1: SYL_Y + 3, y2: SYL_Y + 3, class: 'ext' }, svg)
      items.push({ g, syl, i, cls: g.getAttribute('class') })
    })
    built = 'notes:' + (st.key || '') + ':' + (entry && entry.created)
  }

  function drawRuns(svg, runs, x, cls) {
    // loop: NOT-WORTH — the line's voiced runs (hundreds), once per build or new piece
    for (const run of runs) {
      let d = ''
      // loop: NOT-WORTH — a run's points
      for (let k = 0; k < run.length; k++) d += (k ? 'L' : 'M') + x(run[k][0]) + ' ' + r1(yOf(run[k][1])) + ' '
      sv(doc, 'path', { d, class: cls }, svg)
    }
  }

  // first play: the pitch line of every piece heard so far, on a treble-8 staff (a voice is placed by
  // its own median once enough of it is there), redrawn when a piece arrives
  function buildLine() {
    const line = M.mergePitch(pieces)
    const clef = M.clefFor(line ? line.v.map((v, i) => ({ midi: Math.round(v / 10), t: i, end: v > 0 ? i + 1 : i })) : [])
    drawFixed(clef, 0)
    const W = Math.ceil((duration || (line ? line.t0 + line.v.length * line.hop + 4 : 10)) * pps()) + 40
    strip.replaceChildren()
    strip.style.width = W + 'px'
    const svg = sv(doc, 'svg', { class: 'sn-svg', width: W, height: STAFF_H }, strip)
    lineRuns = M.pitchRuns(line, clef, 0, null)
    drawRuns(svg, lineRuns, (t) => r1(t * pps()), 'pl first')
    items = []
    built = 'line:' + pieces.length + ':' + (st.key || '')
  }

  // --- moving: one compositor animation; re-synced only when it drifts ---
  function stripX(t) { return (box.clientWidth || 600) * headAt() - gutter - t * pps() }
  function place(t) {
    const w = box.clientWidth || 600
    head.style.transform = 'translateX(' + r1(w * headAt()) + 'px)'
    if (opts.reducedMotion && opts.reducedMotion()) {
      // pages: the strip stays put until the playhead reaches the page's end; the playhead steps
      const span = Math.max(1, (w - gutter) / pps())
      const p = Math.floor(t / span)
      if (anim) { anim.cancel(); anim = null }
      if (p !== page) { page = p; strip.style.transform = 'translateX(' + r1(-p * span * pps()) + 'px)' }
      head.style.transform = 'translateX(' + r1(gutter + (t - p * span) * pps()) + 'px)'
      return
    }
    page = -1
    const playing = opts.playing() && doc.visibilityState === 'visible'
    const end = Math.max(t + 1, duration || t + 600)
    if (!anim) {
      // lifetime: OK — one Web Animation at a time (stopAnim cancels it on a rebuild, a relayout, the band off or reduced motion)
      animFrom = t
      anim = strip.animate([{ transform: 'translateX(' + r1(stripX(t)) + 'px)' }, { transform: 'translateX(' + r1(stripX(end)) + 'px)' }],
        { duration: (end - t) * 1000, easing: 'linear', fill: 'both' })
      if (!playing) anim.pause()
      return
    }
    const want = (t - animFrom) * 1000
    if (Math.abs((anim.currentTime || 0) - want) > 60) anim.currentTime = want
    if (playing && anim.playState !== 'running') anim.play()
    else if (!playing && anim.playState === 'running') anim.pause()
  }
  function stopAnim() { if (anim) { anim.cancel(); anim = null } }

  // the note being sung: its class at its start and end; one timeout to the next change while playing
  function mark(t) {
    if (!lay || m.band !== 'notes') return
    const at = M.noteAt(lay, t)
    if (at !== nowIdx) {
      nowIdx = at
      // loop: NOT-WORTH — the drawn notes, on a note change only (a few per second at most), class writes only for the ones whose state changed
      for (const it of items) {
        const state = it.i === at ? ' now' : lay.notes[it.i].end <= t ? ' past' : ''
        const c = it.cls + state
        if (it.g.getAttribute('class') !== c) { it.g.setAttribute('class', c); if (it.syl) it.syl.className = 's' + state }
      }
    }
    const lab = M.labelAt(m, M.regionAt(gated && gated.regions, t))
    if (label.textContent !== lab) { label.textContent = lab; label.hidden = !lab }
  }
  function schedule(t) {
    if (wake) { clearTimeout(wake); wake = 0 }
    if (!lay || m.band !== 'notes' || !opts.playing() || doc.visibilityState !== 'visible') return
    const next = M.nextChange(lay, gated && gated.regions, t + 0.005)
    if (next === Infinity) return
    // loop: NOT-WORTH — one-shot at the next note start or end, re-planned from the clock each time
    // lifetime: OK — at most one pending (wake); cleared on every re-plan, pause, hide and a new song
    wake = setTimeout(() => { wake = 0; const now = opts.time(); mark(now); schedule(now) }, Math.max(10, (next - t) * 1000))
  }

  function setTime() {
    if (m.band !== 'notes' && m.band !== 'line') return
    if (root.offsetParent === null) { stopAnim(); if (wake) { clearTimeout(wake); wake = 0 } return }   // folded away or hidden
    const t = opts.time()
    place(t)
    mark(t)
    schedule(t)
    gapNote(t)
  }

  // first play: none of the heard line in view (it has scrolled off behind the playhead): the message row
  // says why the staff is empty, unless the mode already says something (an error, paused)
  function gapNote(t) {
    const g = m.band === 'line' && !m.text && built.startsWith('line:') ? gapAt(t) : null
    if ((g && g.text) === (gapShown && gapShown.text) && (g && g.info) === (gapShown && gapShown.info)) return
    gapShown = g
    msg.textContent = g ? g.text : (m.text || '')
    msg.hidden = !msg.textContent
    const inf = g ? g.info : (m.info || '')
    infoText.textContent = inf
    tip.textContent = inf
    info.hidden = !inf
    if (!inf) showTip(false)
  }
  function gapAt(t) {
    const w = box.clientWidth || 600
    // the strip shows song time t + (x - the playhead's x) / pps from the gutter to the box's right edge
    return M.lineGap(lineRuns, t - Math.max(0, w * headAt() - gutter) / pps(), t + w * (1 - headAt()) / pps())
  }

  // --- state from main ---
  function setState(next) {
    const s = next || { on: false }
    if ('entry' in s) entry = s.entry || null
    if ('pitch' in s) pieces = Array.isArray(s.pitch) ? s.pitch.slice() : []
    if (s.key !== st.key) { nowIdx = -2 }
    st = s
    duration = Number(opts.duration ? opts.duration() : 0) || 0
    doc2 = entry ? M.expand(entry) : null
    gated = doc2 ? M.gate(doc2) : null
    lay = doc2 ? M.layout(doc2, gated) : null
    m = M.mode(Object.assign({}, s, { doc: doc2, gate: gated, pitch: pieces }))
    root.dataset.mode = m.band
    const drawn = m.band === 'notes' || m.band === 'line'
    const place = s.place === 'over' ? 'over' : 'band'
    root.classList.toggle('over', drawn && place === 'over')
    // the placement buttons and the staff always show while Sheet notes is on (Marcy 2026-10-18: "i dont
    // like it being hidden arbitrarily"): a song with nothing to draw gets an empty staff and its message
    placeSeg.hidden = false
    // loop: NOT-WORTH — two buttons, per state push
    for (const b of placeBtns) b.setAttribute('aria-pressed', String(b.dataset.place === place))
    label.textContent = m.label
    label.hidden = !m.label
    msg.textContent = m.text
    msg.hidden = !m.text
    gapShown = null
    infoText.textContent = m.info || ''
    tip.textContent = m.info || ''
    info.hidden = !m.info
    if (!m.info) showTip(false)
    box.hidden = m.band === 'off'
    const want = m.band === 'notes' ? 'notes:' + (s.key || '') + ':' + (entry && entry.created) : m.band === 'line' ? 'line:' + pieces.length + ':' + (s.key || '') : ''
    if (want && want !== built) {
      stopAnim()
      if (m.band === 'notes') buildNotes()
      else buildLine()
      nowIdx = -2
    }
    if (!want) { lineRuns = []; stopAnim(); if (built !== 'empty' && m.band !== 'off') { drawFixed('treble8', 0); strip.replaceChildren() } built = m.band === 'off' ? '' : 'empty' }
    if (opts.onLayout) opts.onLayout()
    setTime()
  }

  // lifetime: OK — one visibilitychange listener for the band's life (the window's)
  doc.addEventListener('visibilitychange', () => {
    if (doc.visibilityState !== 'visible') { if (anim && anim.playState === 'running') anim.pause(); if (wake) { clearTimeout(wake); wake = 0 } }
    else setTime()
  })

  return {
    el: root,
    setState,
    setTime,
    // the layout changed (window resize, the band shown): the playhead and the strip from the clock again
    relayout() { stopAnim(); page = -1; setTime() },
    get mode() { return m.band },
    // the room the sung line opens for the staff: only "Over the sung line" with something to draw
    get room() { return M.placement(st, m.band, true).room },
    get on() { return !!st.on },
    // for the UI checker: what is drawn and running
    debug() { return { mode: m.band, place: root.classList.contains('over') ? 'over' : 'band', label: label.textContent, msg: msg.textContent, info: infoText.textContent, notes: items.length, paths: strip.querySelectorAll('path.pl').length, anim: anim ? anim.playState : 'none', wake: !!wake, gate: gated ? gated.song : null, clef: lay ? lay.clef : null } }
  }
}

module.exports = { createSheetBand, PPS, HEAD_AT, BASE, H, PLACES }
