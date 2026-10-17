// The lyrics engine both lyric views run: the lyrics window (lyrics.html, 'scroll' layout: every line
// in a scrolling list) and the visualizer overlay (visualizer.html, 'stage' layout: the line being sung
// big and centred, the next line under it). One copy of the model, the clock, the word timing and the
// rendering; the pages only add their own chrome and styles (shared word/dot styles: lyrics-view.css).
//
// Data path (main.js lyrics feed, the same for both windows):
//   'lyrics-data'    -> setData(data)      full line/word objects, estimated + learned timing applied
//   'lyrics-time'    -> setTime(t, playing)  2 pushes/s; the smooth clock (lyrics-timing syncClock)
//   'lyrics-refined' -> refine(msg)       Level 1 refined words for one line
//   'lyrics-aligned' -> align(msg)        Level 2 aligned words for the song's lines (precise word timing)
// The pure helpers (prepare, refinedLine, alignedLines, timingNote, wordState, stageNext) are tested
// in test/lyrics-view.test.js.
//
// Karaoke: the word being sung is lit as a whole (.w.now). Apple words timed in several spans carry
// their syllables (word.syl, lyrics-sources.js): those render as .s spans inside the word and only
// the syllable being sung pops (.s.now); other words pop as a whole, as before. Words without Apple
// syllables get estimated ones (lyrics-syllables.js: hyphenation patterns for data.lang, en-US by
// default), once per line when the lyrics load or a line's timing is refined or aligned.
//
// Render path ("draw once, animate on the compositor", docs/research/gpu-render-hdr-2026-10.md): a word
// change is class writes only, never a layout. The sung word shows a stacked bold copy (.b) instead of
// changing its weight; the line's colour change is a crossfade of stacked copies (lyrics.html); the
// countdown dots are Web Animations made once per interlude (dotKeyframes); a dots row opening or
// closing slides the lines around it with a transform (FLIP), never a height animation.
const T = require('./lyrics-timing')
const S = require('./lyrics-syllables')

const WORD_LEAD = 0.05    // s: words light up a touch early to cover the IPC hop

/**
 * Lines and layout facts for a 'lyrics-data' payload (estimated word timing when asked for, estimated
 * syllables for timed words). hyphenate: the lyrics language's hyphenator (null: no syllables).
 */
function prepare(data) {
  const raw = (data && Array.isArray(data.lines)) ? data.lines : []
  const words = learnFrom(data && data.estimate ? T.estimateWords(raw) : raw)
  const hyphenate = S.hyphenatorFor(data && data.lang)
  const split = hyphenate ? words.map((l) => S.lineWithSyllables(l, hyphenate)) : words
  const lines = split.every((l, i) => l === words[i]) ? words : split
  return { lines, hyphenate, wordTimed: T.hasWordTiming(lines), sides: T.lineSides(lines), gaps: T.findInterludes(lines) }
}

/**
 * What the song's aligned/refined lines teach the estimated ones (lyrics-timing.js): plain estimated
 * lines take the song's sung pace (repace), and repeats of an aligned/refined line (choruses) take
 * its timing (reuseRepeats). Same array when nothing changes.
 */
function learnFrom(lines) {
  return T.boundHolds(T.reuseRepeats(T.repace(lines)))
}

/**
 * The line after a 'lyrics-refined' message, or null when the message isn't for this song, this
 * line isn't estimated, or the words don't match (only the timing of the same words may change).
 */
function refinedLine(lines, msg, key) {
  if (!msg || msg.key !== key) return null
  const line = lines[msg.lineIndex]
  const words = msg.words
  // a repeat mapped from an aligned line keeps that (aligned beats refined)
  if (!line || !line.estimated || line.repeat === 'aligned' || !Array.isArray(words) || !line.words ||
      words.length !== line.words.length || words.some((w, i) => !w || w.text !== line.words[i].text)) return null
  const out = Object.assign({}, line, { words: words.map((w) => T.copyWord(w)), refined: true })
  delete out.repeat
  delete out.repeatOf
  return out
}

/**
 * The lines after a 'lyrics-aligned' message ({ key, lines: { index: { text, words } } }), or null
 * when the message isn't for this song or changes nothing. A line takes the aligned words only when
 * it isn't aligned yet and its text and words match (only the timing of the same words may change).
 * Returns { lines, changed: [index] }.
 */
function alignedLines(lines, msg, key) {
  if (!msg || msg.key !== key || !msg.lines || typeof msg.lines !== 'object') return null
  const next = lines.slice()
  const changed = []
  // loop: NOT-WORTH — one pass over the message's lines (at most the song's line count) · per 'lyrics-aligned' message
  for (const [k, a] of Object.entries(msg.lines)) {
    const i = Number(k)
    const line = next[i]
    const words = a && a.words
    if (!line || line.aligned || !line.words || !Array.isArray(words) || a.text !== line.text ||
        words.length !== line.words.length || words.some((w, j) => !w || w.text !== line.words[j].text)) continue
    const out = Object.assign({}, line, { words: words.map((w) => T.copyWord(w)), aligned: true })
    delete out.estimated
    delete out.repeat
    delete out.repeatOf
    next[i] = out
    changed.push(i)
  }
  return changed.length ? { lines: next, changed } : null
}

/** The word timing note: aligned beats refined beats estimated; some lines left estimated says so. */
function timingNote(lines, aligned, refined) {
  if (aligned) return lines.some((l) => l.estimated) ? 'Word timing aligned on this PC (some lines estimated)' : 'Word timing aligned on this PC'
  return refined ? 'Word timing estimated, refined by listening' : 'Word timing estimated'
}

/**
 * Karaoke position of a line's words at `time`: k words have started, `now` is the word being sung
 * (-1 for none), `syl` the syllable of that word being sung (-1 when the word has no syllables or
 * sits between two of them).
 */
function wordState(words, time) {
  const pos = T.wordPos(words, time)
  const w = pos.now >= 0 ? words[pos.now] : null
  // a held note that has sung SUSTAIN_AFTER s into its hold settles into the sustain (hold: true)
  const from = w && (w.held || w.holdFrom != null) ? (w.holdFrom != null ? w.holdFrom : w.t) : null
  return { k: pos.k, now: pos.now, syl: w && w.syl ? T.wordPos(w.syl, time).now : -1, hold: from != null && time >= from + T.SUSTAIN_AFTER }
}

/**
 * Stage layout: the line shown under the current one (-1 for none). During an interlude it's the
 * line the countdown dots lead into; otherwise the line after the one that lit up last (the first
 * line before the song's singing starts).
 */
function stageNext(lineCount, latest, interlude) {
  if (interlude) return interlude.index
  return latest + 1 < lineCount ? latest + 1 : -1
}

const BREATHE = 2.6        // rad/s: the countdown row's gentle breathe, 1 + 0.06 sin(2.6 t), t = song time
const DOT_STEP = Math.PI / BREATHE / 4   // s between breathe keyframes (8 per breath; linear in between)

/**
 * The countdown dots of an interlude as Web Animation keyframes (compositor-only: opacity and
 * transform), the same values the old per-frame code wrote (interludeProgress): each dot fills from
 * 0.25 opacity / scale 0.8 to 1 / 1 in turn, and the row breathes with the song time and fades and
 * shrinks out over the last 0.6 s. Time runs from g.start to the interlude's end (duration, s);
 * an animation's currentTime is (song time - g.start) in ms.
 * -> { duration, dots: [keyframes] x3, row: keyframes }
 */
function dotKeyframes(g) {
  const end = g.end - T.LINE_LEAD
  const duration = Math.max(0.001, end - g.start)
  const at = (t) => Math.min(1, Math.max(0, (t - g.start) / duration))
  const dot = (fill) => ({ opacity: +(0.25 + 0.75 * fill).toFixed(4), transform: 'scale(' + (0.8 + 0.2 * fill).toFixed(4) + ')' })
  const span = Math.max(0.001, end - g.start - 0.6)
  const dots = [0, 1, 2].map((d) => [
    Object.assign({ offset: 0 }, dot(0)),
    Object.assign({ offset: at(g.start + span * d / 3) }, dot(0)),
    Object.assign({ offset: at(g.start + span * (d + 1) / 3) }, dot(1)),
    Object.assign({ offset: 1 }, dot(1))
  ])
  // the row: sampled breathe x exit (exact at the samples, linear between), plus the exit's corners
  const times = new Set([g.start, end, Math.max(g.start, end - 0.6)])
  // loop: NOT-WORTH — one keyframe per 1/8 breath (~0.3 s) across the interlude, once per interlude shown
  for (let t = Math.ceil(g.start / DOT_STEP) * DOT_STEP; t < end; t += DOT_STEP) times.add(t)
  const row = [...times].sort((a, b) => a - b).map((t) => {
    const exit = T.interludeProgress(g, t).exit
    const breathe = 1 + 0.06 * Math.sin(t * BREATHE)
    return { offset: at(t), opacity: +exit.toFixed(4), transform: 'scale(' + (breathe * exit).toFixed(4) + ')' }
  })
  return { duration, dots, row }
}

/**
 * FLIP: how far each element must start from (translateY, px) so a layout change looks like a slide:
 * before/after are { top, height } per element; dots rows use their centre (they grow from their top).
 * Elements that didn't move (|dy| < 0.5 px) are left out. -> [{ i, dy }]
 */
function slideFrom(before, after, centre) {
  const out = []
  // loop: NOT-WORTH — the shown elements around a countdown (at most the window's lines), per dots open/close
  for (let i = 0; i < before.length; i++) {
    if (!before[i] || !after[i]) continue
    const pos = (r) => r.top + (centre && centre[i] ? r.height / 2 : 0)
    const dy = pos(before[i]) - pos(after[i])
    if (Math.abs(dy) >= 0.5) out.push({ i, dy: Math.round(dy * 10) / 10 })
  }
  return out
}

/**
 * createLyricsView({ container, layout: 'scroll' | 'stage', onSeek(t)?, onFrame(time)?,
 *   emptyText(data)? -> string|null, notes: bool }) -> { setData, setTime, refine, align, time, playing }
 */
function createLyricsView(opts) {
  const container = opts.container
  const doc = container.ownerDocument
  const stage = opts.layout === 'stage'
  let lines = []
  let lineEls = []          // per line: { el, side, words: [span], bg: [span], pos, bgPos }; a word span
                            // with syllables has span.syl = [syllable span]
  let interludes = []       // [{ index, start, end, el, dots: [i], row, anims }]
  let wordTimed = false
  let live = new Set()      // lines currently .active
  let shownInterlude = -1
  let shownNext = -1        // stage: line currently .next
  let scrollTarget = null
  let clock = null
  let raf = 0
  let wake = 0
  let songKey = ''          // title|artist, matches 'lyrics-refined' to the song on screen
  let hyphenate = null      // the song's hyphenator, for syllables of refined/aligned words
  let refined = false       // learned or live-refined word timing in use
  let aligned = false       // word timing aligned to the vocals on this PC (precise word timing)
  let notesEl = null
  let notes = []

  // a word: its regular text (.r) and, stacked on it, the bold copy the sung word shows (.b): the
  // switch is a visibility change, so a word change never lays the line out (lyrics-view.css). With
  // syllables, the bold copy holds them side by side (no spaces) in one row; only it pops them.
  function wordSpans(parent, words) {
    const spans = []
    // loop: NOT-WORTH — one line's words (and their syllables), once per line per track in setData
    words.forEach((w, i) => {
      if (i) parent.appendChild(doc.createTextNode(' '))
      const span = doc.createElement('span')
      span.className = 'w'
      span.dataset.text = w.text
      const r = doc.createElement('span')
      r.className = 'r'
      const b = doc.createElement('span')
      b.className = 'b'
      b.setAttribute('aria-hidden', 'true')
      if (w.syl) {
        span.classList.add('hs')
        r.textContent = w.syl.map((y) => y.text).join('')
        const row = doc.createElement('span')
        row.className = 'sr'
        // loop: NOT-WORTH — a word's syllables (a handful), once per line per track
        span.syl = w.syl.map((y) => {
          const s = doc.createElement('span')
          s.className = 's'
          const g = doc.createElement('span')   // the syllable's brightness layer (filter: brightness only, compositor)
          g.className = 'sg'
          g.textContent = y.text
          s.appendChild(g)
          row.appendChild(s)
          return s
        })
        b.appendChild(row)
      } else {
        r.textContent = w.text
        b.textContent = w.text
      }
      span.append(r, b)
      parent.appendChild(span)
      spans.push(span)
    })
    return spans
  }

  // lifetime: OK — setData replaces the container's children, so old line, word and dot elements and
  // their onclick closures are dropped per track
  function setData(data) {
    const prep = prepare(data)
    lines = prep.lines
    hyphenate = prep.hyphenate
    songKey = (data.title || '') + '|' + (data.artist || '')
    refined = !!data.refined
    aligned = !!data.aligned
    notesEl = null
    lineEls = []
    interludes = []
    live = new Set()
    shownInterlude = -1
    shownNext = -1
    scrollTarget = null
    stopFrames()
    if (!lines.length) {
      wordTimed = false
      const text = opts.emptyText ? opts.emptyText(data) : null
      container.innerHTML = ''
      if (text) {
        const empty = doc.createElement('div')
        empty.id = 'empty'
        empty.textContent = text
        container.appendChild(empty)
      }
      return
    }
    wordTimed = prep.wordTimed
    const sides = prep.sides
    const gaps = prep.gaps
    let g = 0
    container.innerHTML = ''
    // loop: NOT-WORTH — the song's lines (and the countdowns before them), once per track
    lines.forEach((line, i) => {
      while (g < gaps.length && gaps[g].index === i) {
        const dots = doc.createElement('div')
        dots.className = 'dots ' + (sides[i] || 'plainside')
        const row = doc.createElement('div')
        row.className = 'row'
        row.innerHTML = '<i></i><i></i><i></i>'
        dots.appendChild(row)
        container.appendChild(dots)
        interludes.push(Object.assign({ el: dots, row, dots: [...row.children] }, gaps[g++]))
      }
      const el = doc.createElement('div')
      el.className = (line.t === null ? 'line plain' : 'line') + (sides[i] ? ' ' + sides[i] : '')
      const ly = doc.createElement('div')   // the line's content (the FLIP slide target in the stage)
      ly.className = 'ly'
      const entry = { el, ly, side: sides[i], words: [], bg: [], pos: null, bgPos: null }
      if (line.words && line.words.length) {
        const main = doc.createElement('div')
        entry.words = wordSpans(main, line.words)
        ly.appendChild(main)
      }
      else ly.textContent = line.text
      if (line.bg && line.bg.length) {
        const bg = doc.createElement('div')
        bg.className = 'bgv'
        entry.bg = wordSpans(bg, line.bg)
        ly.appendChild(bg)
      }
      el.appendChild(ly)
      if (!stage && line.t !== null) {
        // the lyrics window crossfades the line's colour (lyrics.html): two plain copies (unsung and
        // hover colours) stacked with the karaoke layer; same words and widths, no bold copies
        ly.classList.add('ly-main')
        // loop: NOT-WORTH — two copies per timed line, once per track
        for (const cls of ['ly-dim', 'ly-hov']) {
          const copy = ly.cloneNode(true)
          copy.className = 'ly ' + cls
          copy.setAttribute('aria-hidden', 'true')
          // loop: NOT-WORTH — the copy's bold layers (one per word), once per track
          for (const b of copy.querySelectorAll('.b')) b.remove()
          el.appendChild(copy)   // after the karaoke layer: its words come first in the DOM (z-index stacks them)
        }
      }
      if (line.t !== null && opts.onSeek) {
        // lifetime: OK — one click handler per line, dropped with the line on the next setData
        el.onclick = () => {
          opts.onSeek(line.t)
          clock = T.seekClock(clock, line.t, performance.now())
          render(line.t)
          updateFrames()
        }
      }
      container.appendChild(el)
      lineEls.push(entry)
    })
    notes = []
    if (opts.notes) {
      if (data.source === 'lrclib') notes.push('Lyrics from LRCLIB' + (lines[0].t === null ? ' (not time-synced)' : ''))
      if (lines.some((l) => l.estimated || l.aligned)) notes.push(null)   // word timing note, see showNotes
      showNotes()
    }
    if (clock) render(T.clockTime(clock, performance.now()))
  }

  function showNotes() {
    const text = notes.map((n) => n === null ? timingNote(lines, aligned, refined) : n).join(' · ')
    if (!text) return
    if (!notesEl) {
      notesEl = doc.createElement('div')
      notesEl.id = 'source'
      container.appendChild(notesEl)
    }
    notesEl.textContent = text
  }

  // refine by listening (Settings, experimental): main sends a line's new word timing once the line
  // has been sung; only that line's timing changes (same words, so the spans stay)
  function refine(msg) {
    const line = refinedLine(lines, msg, songKey)
    const entry = line && lineEls[msg.lineIndex]
    if (!entry) return
    lines[msg.lineIndex] = S.lineWithSyllables(line, hyphenate)
    entry.pos = null
    relearn()
    if (!refined) { refined = true; if (opts.notes) showNotes() }
    if (clock) { render(T.clockTime(clock, performance.now())); updateFrames() }
  }

  // precise word timing (Settings, experimental): main sends the aligned words when the alignment of
  // the song on screen finishes; only those lines' timing changes (same words, so the spans stay)
  function align(msg) {
    const got = alignedLines(lines, msg, songKey)
    if (!got) return
    lines = got.lines
    // loop: NOT-WORTH — the aligned lines (at most the song's line count) · per 'lyrics-aligned' message
    for (const i of got.changed) {
      lines[i] = S.lineWithSyllables(lines[i], hyphenate)
      if (lineEls[i]) lineEls[i].pos = null
    }
    relearn()
    aligned = true
    if (opts.notes) showNotes()
    if (clock) { render(T.clockTime(clock, performance.now())); updateFrames() }
  }

  // a line just refined or aligned (progressive alignment sends each section as it's done): the
  // song's later estimated lines take its pace, and its repeats its timing, during this play
  function relearn() {
    const next = learnFrom(lines)
    if (next === lines) return
    // loop: NOT-WORTH — one pass over the song's lines · per 'lyrics-refined' / 'lyrics-aligned' message
    for (let i = 0; i < next.length; i++) {
      if (next[i] === lines[i]) continue
      lines[i] = S.lineWithSyllables(next[i], hyphenate)
      if (lineEls[i]) lineEls[i].pos = null
    }
  }

  // scaled words at a row's edge grow inward, so they stay inside the window padding. The row edges
  // are read once per line (one layout read when it first lights) and kept until the window resizes.
  function edgeOrigin(spans, i, side) {
    if (side === 'center') return ''
    if (!spans.origins) {
      const tops = spans.map((s) => s.offsetTop)
      spans.origins = tops.map((top, k) => side === 'right'
        ? (k === tops.length - 1 || tops[k + 1] !== top ? '100% 65%' : '')
        : (k === 0 || tops[k - 1] !== top ? '0% 65%' : ''))
    }
    return spans.origins[i]
  }
  // lifetime: OK — one resize listener per view; views live as long as their window (the row edges change)
  doc.defaultView.addEventListener('resize', () => {
    // loop: NOT-WORTH — the song's lines, once per resize
    for (const e of lineEls) { delete e.words.origins; delete e.bg.origins }
  })

  // the popping syllable of a word at a row's edge grows inward too (first syllable at the left
  // edge, last at the right edge)
  function sylOrigin(span, j, origin) {
    if (origin === '0% 65%') return j === 0 ? origin : ''
    if (origin === '100% 65%') return j === span.syl.length - 1 ? origin : ''
    return ''
  }

  // word and syllable classes for one line's words; only touches the DOM when the position changed
  function paintWords(spans, words, time, last, side) {
    const pos = wordState(words, time)
    if (last && last.k === pos.k && last.now === pos.now && last.syl === pos.syl && last.hold === pos.hold) return last
    // loop: HOT-PATH-OK — syllables to reset · the previous word's (a handful) per word/syllable change; the whole
    // line's only when it (re)lights (last null: a seek may have left one marked)
    if (!last) {
      for (const sp of spans) if (sp.syl) for (const s of sp.syl) s.classList.remove('now')
    } else if (last.now >= 0 && spans[last.now].syl && (last.now !== pos.now || last.syl !== pos.syl)) {
      for (const s of spans[last.now].syl) s.classList.remove('now')
    }
    if (pos.now >= 0) {
      const span = spans[pos.now]
      const origin = stage ? '' : edgeOrigin(spans, pos.now, side)
      if (span.syl) {
        if (pos.syl >= 0) {
          span.syl[pos.syl].classList.add('now')
          if (!stage) span.syl[pos.syl].style.transformOrigin = sylOrigin(span, pos.syl, origin)
        }
      }
      else if (!stage) span.style.transformOrigin = origin
    }
    // loop: HOT-PATH-OK — one line's words (~5-12) per word/syllable change (returns above when nothing moved)
    for (let i = 0; i < spans.length; i++) {
      spans[i].classList.toggle('sung', i < pos.k && i !== pos.now)
      spans[i].classList.toggle('now', i === pos.now)
      spans[i].classList.toggle('hold', i === pos.now && pos.hold)
    }
    return pos
  }

  function render(time) {
    if (!lines.length || lines[0].t === null) return
    const gi = T.interludeAt(interludes, time)
    const { latest, live: liveNow } = T.liveLines(lines, time)
    // during an interlude nobody sings: the dots take the next line's place
    const next = new Set(gi >= 0 ? [] : liveNow)
    // loop: HOT-PATH-OK — the live lines (1-3, a few in an overlap) per rendered frame
    for (const i of live) if (!next.has(i)) lineEls[i].el.classList.remove('active')
    for (const i of next) {
      const e = lineEls[i]
      if (!live.has(i)) { e.el.classList.add('active'); e.pos = e.bgPos = null }
      if (e.words.length) e.pos = paintWords(e.words, lines[i].words, time + WORD_LEAD, e.pos, e.side)
      if (e.bg.length) e.bgPos = paintWords(e.bg, lines[i].bg, time + WORD_LEAD, e.bgPos, e.side)
    }
    live = next
    let slides = null
    if (stage) {
      // stage: only the live lines (.active), the dots and the next line (.next) are shown
      const nx = stageNext(lines.length, latest, gi >= 0 ? interludes[gi] : null)
      if (nx !== shownNext) {
        if (shownNext >= 0) lineEls[shownNext].el.classList.remove('next')
        if (nx >= 0) lineEls[nx].el.classList.add('next')
        shownNext = nx
      }
    }
    if (gi !== shownInterlude) {
      // the dots row opens/closes at once (no height animation: that laid out every frame); what it
      // moves slides from where it was, on the compositor (FLIP), as the height transition looked
      const around = slideTargets(gi >= 0 ? interludes[gi] : interludes[shownInterlude])
      const before = around.map((a) => rect(a.measure))
      if (shownInterlude >= 0) closeDots(interludes[shownInterlude])
      if (gi >= 0) interludes[gi].el.classList.add('on')
      shownInterlude = gi
      slides = slideFrom(before, around.map((a) => rect(a.measure)), around.map((a) => a.centre)).map((s) => ({ el: around[s.i].move, dy: s.dy }))
    }
    if (gi >= 0) syncDots(interludes[gi], time)
    if (!stage) {
      const target = gi >= 0 ? interludes[gi].el : (latest >= 0 ? lineEls[latest].el : null)
      if (target !== scrollTarget) {
        scrollTarget = target
        if (target) target.scrollIntoView({ block: 'center', behavior: 'smooth' })
      }
    }
    // after the scroll target is taken (it reads positions with transforms)
    // loop: NOT-WORTH — the elements a dots row moved (at most the window's lines), per open/close
    if (slides) for (const s of slides) s.el.animate([{ transform: 'translateY(' + s.dy + 'px)' }, { transform: 'none' }], { duration: 300, easing: 'ease' })
  }

  const rect = (el) => { const r = el.getBoundingClientRect(); return { top: r.top, height: r.height } }

  // what a dots row opening or closing moves: the stage's shown lines (their content, so the stage's
  // own lv-in animation keeps the line's transform), or the lyrics window's lines in view; and the
  // dots row itself (its centre: the old height animation grew it from its top)
  function slideTargets(g) {
    const out = []
    if (g) out.push({ measure: g.el, move: g.el, centre: true })
    const view = container.getBoundingClientRect()
    // loop: NOT-WORTH — one pass over the song's lines, per dots open/close (a few per song)
    for (const e of lineEls) {
      if (stage) {
        if (e.el.classList.contains('active') || e.el.classList.contains('next')) out.push({ measure: e.el, move: e.ly })
        continue
      }
      const r = e.el.getBoundingClientRect()
      if (r.bottom >= view.top - 80 && r.top <= view.bottom + 80) out.push({ measure: e.el, move: e.el })
    }
    return out
  }

  // the countdown on the compositor: one Web Animation per dot and one for the row, made when the
  // dots open, kept in step with the song clock (re-synced only when it drifts), paused with the song
  function syncDots(g, time) {
    if (!g.anims) {
      const k = dotKeyframes(g)
      const opts = { duration: k.duration * 1000, fill: 'both' }
      g.anims = g.dots.map((d, i) => d.animate(k.dots[i], opts)).concat([g.row.animate(k.row, opts)])
    }
    const at = (time - g.start) * 1000
    const playing = !!clock && clock.playing && doc.visibilityState === 'visible'
    // loop: NOT-WORTH — the 4 countdown animations, per render while the dots show
    for (const a of g.anims) {
      if (Math.abs((a.currentTime || 0) - at) > 60) a.currentTime = at
      if (playing && a.playState !== 'running') a.play()
      else if (!playing && a.playState === 'running') a.pause()
    }
  }
  function closeDots(g) {
    g.el.classList.remove('on')
    if (g.anims) for (const a of g.anims) a.cancel()   // loop: NOT-WORTH — 4 animations
    g.anims = null
  }

  // loop: HOT-PATH-OK — lyrics word/line changes · requestAnimationFrame, woken by a setTimeout at the next word/line
  // change (never every frame: the countdown dots run as compositor animations, syncDots) · runs only
  // while this window is visible, the song is playing and the lyrics have word timing (or a countdown is
  // showing, to end it on time) · stops when hidden (visibilitychange), paused (isPlaying false or the
  // time stops moving), on a new track, or when no word timing/countdown is left · cost: one frame per
  // word change, DOM class writes only for what changed, no layout (docs/PERFORMANCE.md)
  function wantFrames() {
    return doc.visibilityState === 'visible' && !!clock && clock.playing &&
      lines.length > 0 && lines[0].t !== null && (wordTimed || shownInterlude >= 0)
  }
  // lifetime: OK — at most one rAF or one wake-up timeout pending (raf / wake); stopFrames cancels both on
  // every replan, a new track, hidden and pause
  function schedule(time) {
    const wait = T.nextChange(lines, time, WORD_LEAD)
    if (wait === Infinity) return                    // nothing left to change until the next push
    if (wait < 0.03) { raf = requestAnimationFrame(frame); return }
    wake = setTimeout(() => { wake = 0; raf = requestAnimationFrame(frame) }, (wait - 0.015) * 1000)
  }
  function frame() {
    raf = 0
    const time = T.clockTime(clock, performance.now())
    render(time)
    if (opts.onFrame) opts.onFrame(time)
    if (wantFrames()) schedule(time)
  }
  function stopFrames() {
    if (raf) cancelAnimationFrame(raf)
    if (wake) clearTimeout(wake)
    raf = wake = 0
  }
  function updateFrames() {
    stopFrames()
    if (wantFrames()) schedule(T.clockTime(clock, performance.now()))
  }

  // isPlaying is sent along since 0.15.10; older pushes (undefined) fall back to "time stopped moving"
  function setTime(playbackTime, isPlaying) {
    clock = T.syncClock(clock, playbackTime, isPlaying, performance.now())
    if (doc.visibilityState !== 'visible') {
      stopFrames()
      if (shownInterlude >= 0) syncDots(interludes[shownInterlude], T.clockTime(clock, performance.now()))   // pauses them
      return
    }
    render(T.clockTime(clock, performance.now()))
    updateFrames()   // re-plans the next wake-up from the resynced clock
  }

  // lifetime: OK — one listener per view, released with its window (views live as long as their window)
  doc.addEventListener('visibilitychange', () => {
    if (doc.visibilityState === 'visible' && clock) render(T.clockTime(clock, performance.now()))
    updateFrames()
  })

  return {
    setData,
    setTime,
    refine,
    align,
    time: () => T.clockTime(clock, performance.now()),
    get playing() { return !!clock && clock.playing }
  }
}

module.exports = { SUSTAIN_AFTER: T.SUSTAIN_AFTER, WORD_LEAD, prepare, learnFrom, refinedLine, alignedLines, timingNote, wordState, stageNext, dotKeyframes, slideFrom, createLyricsView }
