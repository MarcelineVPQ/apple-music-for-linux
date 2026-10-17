// The +1 sheet-notes staff for the mock-ups (design only). A piano-roll on a real staff, as the
// research proposes (docs/research/live-sheet-notes-2026-10.md, "What to show first"): each note at
// its sung pitch, as long as it was held, the syllable under it, the key signature, a playhead on the
// lyrics clock. The whole song is drawn once into a wide SVG; playing only moves it (a CSS transform)
// and switches classes on the notes around the playhead.
//   const s = MockStaff.create(box, { notes, f0, key: { fifths }, clef: 'treble8', mode: 'notes' })
//   s.update(t); s.setMode('line' | 'notes')
;(function () {
  'use strict'
  const NS = 'http://www.w3.org/2000/svg'
  const LET = ['C', 'D', 'E', 'F', 'G', 'A', 'B']
  const SHARP_ORDER = ['F', 'C', 'G', 'D', 'A', 'E', 'B']
  const FLAT_ORDER = ['B', 'E', 'A', 'D', 'G', 'C', 'F']
  // treble-clef staff steps (octave * 7 + letter) of the key-signature symbols
  const SHARP_STEPS = { F: 38, C: 35, G: 39, D: 36, A: 33, E: 37, B: 34 }
  const FLAT_STEPS = { B: 34, E: 37, A: 33, D: 36, G: 32, C: 35, F: 31 }
  const SHARP_PC = [['C', 0], ['C', 1], ['D', 0], ['D', 1], ['E', 0], ['F', 0], ['F', 1], ['G', 0], ['G', 1], ['A', 0], ['A', 1], ['B', 0]]
  const FLAT_PC = [['C', 0], ['D', -1], ['D', 0], ['E', -1], ['E', 0], ['F', 0], ['G', -1], ['G', 0], ['A', -1], ['A', 0], ['B', -1], ['B', 0]]

  function keyAcc(fifths) {
    const m = {}
    if (fifths > 0) SHARP_ORDER.slice(0, fifths).forEach((l) => { m[l] = 1 })
    if (fifths < 0) FLAT_ORDER.slice(0, -fifths).forEach((l) => { m[l] = -1 })
    return m
  }
  // a note name ("C♯4") or a MIDI number -> { letter, acc, octave, step }
  function spell(n, fifths) {
    if (typeof n === 'string') {
      const m = /^([A-G])([♯♭#b]?)(-?\d)$/.exec(n)
      if (m) {
        const acc = m[2] === '♯' || m[2] === '#' ? 1 : m[2] === '♭' || m[2] === 'b' ? -1 : 0
        const oct = +m[3]
        return { letter: m[1], acc, octave: oct, step: oct * 7 + LET.indexOf(m[1]) }
      }
    }
    const midi = typeof n === 'number' ? n : 60
    const pc = ((midi % 12) + 12) % 12
    const [letter, acc] = (fifths < 0 ? FLAT_PC : SHARP_PC)[pc]
    const octave = Math.floor((midi - acc) / 12) - 1
    return { letter, acc, octave, step: octave * 7 + LET.indexOf(letter) }
  }
  // a continuous staff position for a fractional MIDI pitch (the sung line)
  const PC_STEP = [0, 0.5, 1, 1.5, 2, 3, 3.5, 4, 4.5, 5, 5.5, 6]
  function contStep(midi) {
    const m = Math.floor(midi); const f = midi - m
    const a = (n) => { const pc = ((n % 12) + 12) % 12; return (Math.floor(n / 12) - 1) * 7 + PC_STEP[pc] }
    return a(m) + (a(m + 1) - a(m)) * f
  }

  const mk = (tag, attrs, parent) => {
    const e = document.createElementNS(NS, tag)
    for (const k in attrs) e.setAttribute(k, attrs[k])
    if (parent) parent.appendChild(e)
    return e
  }

  function create(box, opts) {
    const o = Object.assign({ h: 6, pps: 120, playhead: 0.3, clef: 'treble', mode: 'notes', lyrics: true, gutter: 0 }, opts)
    const fifths = (o.key && o.key.fifths) || 0
    const ka = keyAcc(fifths)
    const shift = o.clef === 'treble8' ? 7 : 0   // treble 8vb: written an octave above the sound
    const h = o.h                                // half a staff space, px
    const top = o.top !== undefined ? o.top : h * 7
    const y = (step) => top + (38 - step) * h
    const staffBottom = y(30)
    const lyricY = staffBottom + h * 7.2
    const height = o.height || (lyricY + h * 3)
    const dur = o.duration || Math.max(...o.notes.map((n) => n.end)) + 2
    const W = Math.ceil(dur * o.pps) + 40

    box.classList.add('staff')
    box.style.height = height + 'px'
    box.innerHTML = ''
    // the fixed part: staff lines, clef, key signature
    const fixed = mk('svg', { class: 'staff-fixed', width: '100%', height }, null)
    box.appendChild(fixed)
    for (let s = 30; s <= 38; s += 2) mk('line', { x1: 0, x2: '100%', y1: y(s), y2: y(s), class: 'sl' }, fixed)
    const clefG = mk('g', { class: 'clef' }, fixed)
    const ct = mk('text', { x: h * 1.2, y: y(32) + h * 0.05, class: 'clef-glyph', 'font-size': h * 7.4 }, clefG)
    ct.textContent = '\u{1D11E}'
    if (o.clef === 'treble8') { const e8 = mk('text', { x: h * 3.05, y: y(30) + h * 4.3, class: 'clef-8', 'font-size': h * 2.1 }, clefG); e8.textContent = '8' }
    let kx = h * 6.6
    const order = fifths > 0 ? SHARP_ORDER.slice(0, fifths) : FLAT_ORDER.slice(0, -fifths)
    order.forEach((l) => {
      const st = fifths > 0 ? SHARP_STEPS[l] : FLAT_STEPS[l]
      const tx = mk('text', { x: kx, y: y(st) + h * 0.75, class: 'acc key', 'font-size': h * 3 }, clefG)
      tx.textContent = fifths > 0 ? '♯' : '♭'
      kx += h * 1.7
    })
    const gutter = o.gutter || kx + h * 2

    // the moving part: the whole song
    const view = document.createElement('div')
    view.className = 'staff-view'
    view.style.left = gutter + 'px'
    box.appendChild(view)
    const strip = document.createElement('div')
    strip.className = 'staff-strip'
    strip.style.cssText = 'position:absolute;left:0;top:0;height:' + height + 'px;width:' + W + 'px;will-change:transform'
    view.appendChild(strip)
    const svg = mk('svg', { width: W, height, class: 'staff-svg' }, strip)
    const xOf = (t) => t * o.pps
    // the sung pitch line (both modes; prominent on the first play)
    // on the first play the line is drawn as the voice is heard: nothing right of the playhead
    const defs = mk('defs', {}, svg)
    const clip = mk('clipPath', { id: 'heard-' + Math.random().toString(36).slice(2) }, defs)
    const clipRect = mk('rect', { x: 0, y: 0, width: 0, height }, clip)
    const pitchG = mk('g', { class: 'pitch' }, svg)
    if (o.f0) {
      let d = ''; let pen = false
      o.f0.midi.forEach((m, i) => {
        const t = i * o.f0.hop_s
        if (m === null) { pen = false; return }
        const yy = y(contStep(m) + shift)
        d += (pen ? 'L' : 'M') + xOf(t).toFixed(1) + ' ' + yy.toFixed(1) + ' '
        pen = true
      })
      mk('path', { d, class: 'pl' }, pitchG)
      mk('path', { d, class: 'pl-glow' }, pitchG)
    }
    // notes
    const notesG = mk('g', { class: 'notes' }, svg)
    const sylG = mk('g', { class: 'syls' }, svg)
    const items = []
    let lastSyl = null
    o.notes.forEach((n) => {
      if (n.syl_index === null && o.skipLoose) return
      const sp = spell(n.name || n.midi, fifths)
      const st = sp.step + shift
      const g = mk('g', { class: 'n ' + (n.cls || '') }, notesG)
      const x0 = xOf(n.t); const x1 = Math.max(x0 + h * 1.5, xOf(n.end))
      // ledger lines
      for (let s = 28; s >= st; s -= 2) mk('line', { x1: x0 - h * 1.9, x2: x0 + h * 1.9, y1: y(s), y2: y(s), class: 'ledger' }, g)
      for (let s = 40; s <= st; s += 2) mk('line', { x1: x0 - h * 1.9, x2: x0 + h * 1.9, y1: y(s), y2: y(s), class: 'ledger' }, g)
      mk('rect', { x: x0, y: y(st) - h * 0.55, width: x1 - x0, height: h * 1.1, rx: h * 0.55, class: 'bar' }, g)
      mk('ellipse', { cx: x0, cy: y(st), rx: h * 1.25, ry: h * 0.9, transform: 'rotate(-20 ' + x0 + ' ' + y(st) + ')', class: 'head' }, g)
      const want = ka[sp.letter] || 0
      if (sp.acc !== want) {
        const a = mk('text', { x: x0 - h * 3.3, y: y(st) + h * 0.8, class: 'acc', 'font-size': h * 2.8 }, g)
        a.textContent = sp.acc === 1 ? '♯' : sp.acc === -1 ? '♭' : '♮'
      }
      const it = { t: n.t, end: n.end, el: g, syl: null, cls: n.cls || '' }
      // the syllable under its first note; a melisma's later notes draw an extender
      if (o.lyrics && n.syl_text !== undefined && n.syl_text !== null) {
        const key = n.syl_key
        if (key !== lastSyl) {
          const tx = mk('text', { x: x0 - h * 0.6, y: lyricY, class: 'syl' }, sylG)
          tx.textContent = n.syl_text
          it.syl = tx
          lastSyl = key
        } else {
          mk('line', { x1: x0 - h * 1.5, x2: x1, y1: lyricY + h * 0.5, y2: lyricY + h * 0.5, class: 'ext' }, sylG)
        }
      }
      items.push(it)
    })
    // the playhead (fixed)
    const ph = document.createElement('div')
    ph.className = 'staff-playhead'
    box.appendChild(ph)

    let mode = o.mode
    function setMode(m) {
      mode = m; box.dataset.mode = m
      if (m === 'line' || m === 'karaoke') pitchG.setAttribute('clip-path', 'url(#' + clip.id + ')')
      else pitchG.removeAttribute('clip-path')
    }
    setMode(mode)
    function update(t) {
      const bw = box.clientWidth
      const px = Math.max(gutter + 20, bw * o.playhead)
      ph.style.transform = 'translateX(' + px + 'px)'
      strip.style.transform = 'translateX(' + (px - gutter - xOf(t)).toFixed(1) + 'px)'
      if (mode === 'line' || mode === 'karaoke') clipRect.setAttribute('width', xOf(t).toFixed(1))
      items.forEach((it) => {
        const state = t >= it.end ? 'past' : t >= it.t - 0.02 ? 'now' : 'up'
        if (it._s !== state) {
          it.el.setAttribute('class', 'n ' + it.cls + ' ' + state)
          if (it.syl) it.syl.setAttribute('class', 'syl ' + state)
          it._s = state
        }
      })
    }
    return { update, setMode, items, gutter, height, spell: (n) => spell(n, fifths) }
  }

  // notes from the notes-proto JSON, with each note's syllable attached
  function fromProto(doc) {
    return doc.notes.map((n) => {
      const s = n.syl_index !== null && n.syl_index !== undefined ? doc.syllables[n.syl_index] : null
      return Object.assign({}, n, s ? {
        syl_text: s.text + (s.syl < s.nsyl - 1 ? '-' : ''),
        syl_key: n.syl_index
      } : {})
    })
  }

  window.MockStaff = { create, fromProto, spell, contStep }
})()
