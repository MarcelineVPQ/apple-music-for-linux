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
// The pure helpers (prepare, refinedLine, alignedLines, timingNote, stageNext) are tested in
// test/lyrics-view.test.js.
const T = require('./lyrics-timing')

const WORD_LEAD = 0.05    // s: words light up a touch early to cover the IPC hop

/** Lines and layout facts for a 'lyrics-data' payload (estimated word timing when asked for). */
function prepare(data) {
  const raw = (data && Array.isArray(data.lines)) ? data.lines : []
  const lines = data && data.estimate ? T.estimateWords(raw) : raw
  return { lines, wordTimed: T.hasWordTiming(lines), sides: T.lineSides(lines), gaps: T.findInterludes(lines) }
}

/**
 * The line after a 'lyrics-refined' message, or null when the message isn't for this song, this
 * line isn't estimated, or the words don't match (only the timing of the same words may change).
 */
function refinedLine(lines, msg, key) {
  if (!msg || msg.key !== key) return null
  const line = lines[msg.lineIndex]
  const words = msg.words
  if (!line || !line.estimated || !Array.isArray(words) || !line.words ||
      words.length !== line.words.length || words.some((w, i) => !w || w.text !== line.words[i].text)) return null
  return Object.assign({}, line, { words: words.map((w) => ({ t: +w.t, end: +w.end, text: w.text })), refined: true })
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
  // loop: one pass over the message's lines (at most the song's line count) · per 'lyrics-aligned' message
  for (const [k, a] of Object.entries(msg.lines)) {
    const i = Number(k)
    const line = next[i]
    const words = a && a.words
    if (!line || line.aligned || !line.words || !Array.isArray(words) || a.text !== line.text ||
        words.length !== line.words.length || words.some((w, j) => !w || w.text !== line.words[j].text)) continue
    const out = Object.assign({}, line, { words: words.map((w) => ({ t: +w.t, end: +w.end, text: w.text })), aligned: true })
    delete out.estimated
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
 * Stage layout: the line shown under the current one (-1 for none). During an interlude it's the
 * line the countdown dots lead into; otherwise the line after the one that lit up last (the first
 * line before the song's singing starts).
 */
function stageNext(lineCount, latest, interlude) {
  if (interlude) return interlude.index
  return latest + 1 < lineCount ? latest + 1 : -1
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
  let lineEls = []          // per line: { el, side, words: [span], bg: [span], pos, bgPos }
  let interludes = []       // [{ index, start, end, el, dots: [i], row }]
  let wordTimed = false
  let live = new Set()      // lines currently .active
  let shownInterlude = -1
  let shownNext = -1        // stage: line currently .next
  let scrollTarget = null
  let clock = null
  let raf = 0
  let wake = 0
  let songKey = ''          // title|artist, matches 'lyrics-refined' to the song on screen
  let refined = false       // learned or live-refined word timing in use
  let aligned = false       // word timing aligned to the vocals on this PC (precise word timing)
  let notesEl = null
  let notes = []

  function wordSpans(parent, words) {
    const spans = []
    words.forEach((w, i) => {
      if (i) parent.appendChild(doc.createTextNode(' '))
      const span = doc.createElement('span')
      span.className = 'w'
      span.dataset.text = w.text
      span.textContent = w.text
      parent.appendChild(span)
      spans.push(span)
    })
    return spans
  }

  // lifetime: setData replaces the container's children, so old line, word and dot elements and
  // their onclick closures are dropped per track
  function setData(data) {
    const prep = prepare(data)
    lines = prep.lines
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
      const entry = { el, side: sides[i], words: [], bg: [], pos: null, bgPos: null }
      if (line.words && line.words.length) {
        const main = doc.createElement('div')
        entry.words = wordSpans(main, line.words)
        el.appendChild(main)
      }
      else el.textContent = line.text
      if (line.bg && line.bg.length) {
        const bg = doc.createElement('div')
        bg.className = 'bgv'
        entry.bg = wordSpans(bg, line.bg)
        el.appendChild(bg)
      }
      if (line.t !== null && opts.onSeek) {
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
    lines[msg.lineIndex] = line
    entry.pos = null
    if (!refined) { refined = true; if (opts.notes) showNotes() }
    if (clock) { render(T.clockTime(clock, performance.now())); updateFrames() }
  }

  // precise word timing (Settings, experimental): main sends the aligned words when the alignment of
  // the song on screen finishes; only those lines' timing changes (same words, so the spans stay)
  function align(msg) {
    const got = alignedLines(lines, msg, songKey)
    if (!got) return
    lines = got.lines
    for (const i of got.changed) if (lineEls[i]) lineEls[i].pos = null
    aligned = true
    if (opts.notes) showNotes()
    if (clock) { render(T.clockTime(clock, performance.now())); updateFrames() }
  }

  // scaled words at a row's edge grow inward, so they stay inside the window padding
  function edgeOrigin(spans, i, side) {
    const top = spans[i].offsetTop
    if (side === 'right') return i === spans.length - 1 || spans[i + 1].offsetTop !== top ? '100% 65%' : ''
    if (side === 'center') return ''
    return i === 0 || spans[i - 1].offsetTop !== top ? '0% 65%' : ''
  }

  // word classes for one line's words; only touches the DOM when the position changed
  function paintWords(spans, words, time, last, side) {
    const pos = T.wordPos(words, time)
    if (last && last.k === pos.k && last.now === pos.now) return last
    if (pos.now >= 0 && !stage) spans[pos.now].style.transformOrigin = edgeOrigin(spans, pos.now, side)
    for (let i = 0; i < spans.length; i++) {
      spans[i].classList.toggle('sung', i < pos.k && i !== pos.now)
      spans[i].classList.toggle('now', i === pos.now)
    }
    return pos
  }

  function render(time) {
    if (!lines.length || lines[0].t === null) return
    const gi = T.interludeAt(interludes, time)
    const { latest, live: liveNow } = T.liveLines(lines, time)
    // during an interlude nobody sings: the dots take the next line's place
    const next = new Set(gi >= 0 ? [] : liveNow)
    for (const i of live) if (!next.has(i)) lineEls[i].el.classList.remove('active')
    for (const i of next) {
      const e = lineEls[i]
      if (!live.has(i)) { e.el.classList.add('active'); e.pos = e.bgPos = null }
      if (e.words.length) e.pos = paintWords(e.words, lines[i].words, time + WORD_LEAD, e.pos, e.side)
      if (e.bg.length) e.bgPos = paintWords(e.bg, lines[i].bg, time + WORD_LEAD, e.bgPos, e.side)
    }
    live = next
    if (gi !== shownInterlude) {
      if (shownInterlude >= 0) interludes[shownInterlude].el.classList.remove('on')
      if (gi >= 0) interludes[gi].el.classList.add('on')
      shownInterlude = gi
    }
    if (gi >= 0) {
      const g = interludes[gi]
      const { fills, exit } = T.interludeProgress(g, time)
      for (let d = 0; d < 3; d++) {
        g.dots[d].style.opacity = String(0.25 + 0.75 * fills[d])
        g.dots[d].style.transform = 'scale(' + (0.8 + 0.2 * fills[d]).toFixed(3) + ')'
      }
      const breathe = 1 + 0.06 * Math.sin(time * 2.6)
      g.row.style.transform = 'scale(' + (breathe * exit).toFixed(3) + ')'
      g.row.style.opacity = String(exit)
    }
    if (stage) {
      // stage: only the live lines (.active), the dots and the next line (.next) are shown
      const nx = stageNext(lines.length, latest, gi >= 0 ? interludes[gi] : null)
      if (nx !== shownNext) {
        if (shownNext >= 0) lineEls[shownNext].el.classList.remove('next')
        if (nx >= 0) lineEls[nx].el.classList.add('next')
        shownNext = nx
      }
      return
    }
    const target = gi >= 0 ? interludes[gi].el : (latest >= 0 ? lineEls[latest].el : null)
    if (target !== scrollTarget) {
      scrollTarget = target
      if (target) target.scrollIntoView({ block: 'center', behavior: 'smooth' })
    }
  }

  // loop: lyrics word/dot animation · requestAnimationFrame, woken by a setTimeout at the next word/line
  // change (every frame only while a countdown is showing) · runs only while this window is visible, the
  // song is playing and the lyrics have word timing (or a countdown is showing) · stops when hidden
  // (visibilitychange), paused (isPlaying false or the time stops moving), on a new track, or when no
  // word timing/countdown is left · cost: one frame per word change, DOM class writes only for what
  // changed; 3 dot styles per frame during a countdown (docs/PERFORMANCE.md)
  function wantFrames() {
    return doc.visibilityState === 'visible' && !!clock && clock.playing &&
      lines.length > 0 && lines[0].t !== null && (wordTimed || shownInterlude >= 0)
  }
  function schedule(time) {
    if (shownInterlude >= 0) { raf = requestAnimationFrame(frame); return }
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
    if (doc.visibilityState !== 'visible') { stopFrames(); return }
    render(T.clockTime(clock, performance.now()))
    updateFrames()   // re-plans the next wake-up from the resynced clock
  }

  // lifetime: one listener per view, views live as long as their window
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

module.exports = { WORD_LEAD, prepare, refinedLine, alignedLines, timingNote, stageNext, createLyricsView }
