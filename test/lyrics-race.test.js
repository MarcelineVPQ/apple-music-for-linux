// The lyrics raced through the whole song at a track change (Marcy, 0.15.41-dev.1, Studio, an album
// played in order): the new song's lyrics were drawn with the previous song's clock (~3:30), so every
// line up to there counted as sung and the list scrolled smoothly through all of them, then the first
// real sample (0.1 s) scrolled it all the way back. These tests run the real engine (lyrics-view.js,
// which the lyrics window, the Studio and the visualizer share) on a small stand-in DOM and replay
// what main sends at a track change: 'lyrics-data' for the new song, then time samples, the first ones
// still carrying the old song's position. Also: a seek forward or back, a click on a far line, and a
// resume after a long gap snap straight to the line; normal play still scrolls smoothly.
const test = require('node:test')
const assert = require('node:assert/strict')
const T = require('../lyrics-timing')

// --- a stand-in DOM: just what createLyricsView touches ---
const LINE_H = 40
class El {
  constructor(doc, tag) {
    this.ownerDocument = doc
    this.tagName = tag
    this.children = []
    this.parentElement = null
    this.className = ''
    this.dataset = {}
    this.style = { setProperty() {}, removeProperty() {}, transformOrigin: '' }
    this.attrs = {}
    this._text = ''
    this.scrollTop = 0
    this.tabIndex = -1
    this.onclick = null
    this.lang = ''
    const self = this
    this.classList = {
      add(c) { if (!self.has(c)) self.className = (self.className + ' ' + c).trim() },
      remove(c) { self.className = self.className.split(/\s+/).filter((x) => x && x !== c).join(' ') },
      toggle(c, on) { if (on === undefined ? !self.has(c) : on) this.add(c); else this.remove(c) },
      contains(c) { return self.has(c) }
    }
  }
  has(c) { return this.className.split(/\s+/).includes(c) }
  appendChild(c) { if (c instanceof El) { c.parentElement = this; this.children.push(c) } return c }
  insertBefore(c, ref) { if (!ref) return this.appendChild(c); c.parentElement = this; this.children.splice(this.children.indexOf(ref), 0, c); return c }
  get firstChild() { return this.children[0] || null }
  get nextSibling() { const p = this.parentElement; return p ? p.children[p.children.indexOf(this) + 1] || null : null }
  append(...cs) { for (const c of cs) this.appendChild(c) }
  remove() { const p = this.parentElement; if (p) p.children.splice(p.children.indexOf(this), 1); this.parentElement = null }
  set innerHTML(v) { this.children = []; if (/<i>/.test(v)) for (let i = 0; i < 3; i++) this.appendChild(new El(this.ownerDocument, 'i')) }
  set textContent(v) { this.children = []; this._text = String(v) }
  get textContent() { return this._text }
  cloneNode() {
    const c = new El(this.ownerDocument, this.tagName)
    c.className = this.className
    for (const k of this.children) c.appendChild(k.cloneNode())
    return c
  }
  all() { return this.children.flatMap((c) => [c, ...c.all()]) }
  querySelectorAll(sel) { const cls = sel.replace(/^\./, ''); return this.all().filter((e) => e.has(cls)) }
  querySelector(sel) { if (sel.includes(':focus-visible')) return null; if (sel[0] === '#') return null; return this.querySelectorAll(sel)[0] || null }
  setAttribute(k, v) { this.attrs[k] = String(v) }
  removeAttribute(k) { delete this.attrs[k] }
  getAttribute(k) { return k in this.attrs ? this.attrs[k] : null }
  contains(x) { return x === this || this.all().includes(x) }
  focus() {}
  addEventListener() {}
  click() { if (this.onclick) this.onclick() }
  animate() { return { cancel() {}, play() {}, pause() {}, playState: 'paused', currentTime: 0 } }
  get offsetWidth() { return 0 }
  get offsetTop() { return 0 }
  get offsetLeft() { return 0 }
  get offsetParent() { return null }
  // the list is 400 px high; each row (a line or a dots row) is LINE_H px, in DOM order
  getBoundingClientRect() {
    if (this.isList) return { top: 0, bottom: 400, height: 400 }
    const list = this.parentElement
    const top = list.children.indexOf(this) * LINE_H - list.scrollTop
    return { top, bottom: top + LINE_H, height: LINE_H }
  }
  scrollTo(o) { this.scrolls.push(o); this.scrollTop = o.top }
}
function makeDoc() {
  const listeners = {}
  const doc = {
    visibilityState: 'visible',
    activeElement: null,
    createElement: (tag) => new El(doc, tag),
    createTextNode: (t) => ({ text: t }),
    addEventListener: (type, fn) => { (listeners[type] = listeners[type] || []).push(fn) },
    fire: (type) => (listeners[type] || []).forEach((fn) => fn()),   // loop: NOT-WORTH — test stand-in
    defaultView: { matchMedia: () => ({ matches: false }), addEventListener() {} }
  }
  return doc
}

// the test's clock: performance.now() and requestAnimationFrame are the test's (frames only run when asked)
let nowMs = 0
const realPerf = globalThis.performance
Object.defineProperty(globalThis, 'performance', { value: { now: () => nowMs }, configurable: true, writable: true })
globalThis.requestAnimationFrame = () => 1
globalThis.cancelAnimationFrame = () => {}
test.after(() => Object.defineProperty(globalThis, 'performance', { value: realPerf, configurable: true, writable: true }))

const { createLyricsView } = require('../lyrics-view')

// a word-timed song: a line every `step` s from `first`, three words each
function song(title, first, step, count, duration) {
  const lines = []
  for (let i = 0; i < count; i++) {
    const t = first + i * step
    lines.push({ t, end: t + 3, text: 'la la la', words: [0, 1, 2].map((k) => ({ t: t + k, end: t + k + 0.9, text: 'la' })) })
  }
  return { title, artist: 'LIVE', album: 'Songs from Black Mountain', duration, lines, lang: 'en-US' }
}

function setup(layout = 'scroll') {
  const doc = makeDoc()
  const list = new El(doc, 'div')
  list.isList = true
  list.scrolls = []
  const seeks = []
  const view = createLyricsView({ container: list, layout, onSeek: (t) => seeks.push(t) })
  const lineEls = () => list.children.filter((e) => e.has('line'))
  const h = {
    view, list, seeks, lineEls,
    at(ms) { nowMs = ms },
    // indices of the lines lit (.active)
    active: () => lineEls().map((e, i) => (e.has('active') ? i : -1)).filter((i) => i >= 0),
    // lit lines with a word marked sung or being sung (an unlit line's word classes don't show)
    sung: () => lineEls().map((e, i) => (e.has('active') && e.all().some((w) => w.has('w') && (w.has('sung') || w.has('now'))) ? i : -1)).filter((i) => i >= 0),
    // the scroll that centres line i (rows are lines and countdown dots rows, LINE_H px each)
    topFor: (i) => Math.max(0, list.children.indexOf(lineEls()[i]) * LINE_H - (400 * 0.5 - LINE_H / 2)),
    done() { doc.visibilityState = 'hidden'; doc.fire('visibilitychange') }   // stops the view's wake-up timer
  }
  return h
}

// no line lit or sung before its time (the real song time `real`)
function honest(h, data, real, what) {
  for (const i of h.active()) assert.ok(data.lines[i].t - T.LINE_LEAD <= real + 0.6, what + ': line ' + i + ' (' + data.lines[i].t + ' s) lit at ' + real + ' s')
  for (const i of h.sung()) assert.ok(data.lines[i].t <= real + 0.6, what + ': line ' + i + ' (' + data.lines[i].t + ' s) sung at ' + real + ' s')
}

const A = song('Wings', 10, 8, 26, 223.8)    // lines 10 … 210 s
const B = song('Sofia', 12, 8, 25, 212)      // lines 12 … 204 s

// plays A to ~215 s (the end), then B arrives as main sends it
function playAToTheEnd(h, key) {
  h.view.setData(A)
  for (let k = 0; k <= 6; k++) { h.at(k * 500); h.view.setTime(212 + k * 0.5, true, key ? 'Wings|LIVE' : undefined) }
  h.list.scrolls.length = 0
}

for (const keyed of [true, false]) {
  test('track change: the old song\'s position in the first samples never lights or scrolls through the new song' + (keyed ? ' (keyed samples)' : ' (samples without a key)'), () => {
    const h = setup()
    playAToTheEnd(h, keyed)
    const k = keyed ? 'Sofia|LIVE' : undefined
    h.at(3100); h.view.setData(B)
    assert.deepEqual(h.active(), [], 'nothing lit before the new song\'s first sample (was: drawn with the old clock)')
    honest(h, B, 0, 'setData')
    // the first samples of the new song still carry the old one's position (MusicKit's time not reset yet)
    h.at(3200); h.view.setTime(215.2, true, k); honest(h, B, 0.1, 'stale 215.2')
    h.at(3600); h.view.setTime(215.6, true, k); honest(h, B, 0.2, 'stale 215.6')
    // a late push for the old song (keyed) is not the new song's
    if (keyed) { h.at(3700); h.view.setTime(216.1, true, 'Wings|LIVE'); honest(h, B, 0.3, 'old key') }
    // then the real time
    const real = [0.1, 0.6, 1.1, 1.6, 2.1, 2.6, 3.1]
    real.forEach((t, i) => { h.at(4100 + i * 500); h.view.setTime(t, true, k); honest(h, B, t, 'real ' + t) })
    assert.deepEqual(h.active(), [])
    // no scroll went past the first line: the list never ran through the song
    for (const o of h.list.scrolls) assert.ok(o.top <= h.topFor(1), 'scrolled to ' + o.top + ' px at the start of the song')
    // and the song then plays as normal: line 0 lights at 12 s
    for (let t = 3.6, i = 0; t <= 12.6; t += 0.5, i++) { h.at(7600 + i * 500); h.view.setTime(t, true, k) }
    assert.deepEqual(h.active(), [0])
    honest(h, B, 12.6, 'line 0')
    h.done()
  })
}

test('track change: a sample longer than the new song is ignored; a song that really starts late is shown after a moment', () => {
  const h = setup()
  playAToTheEnd(h, true)
  h.at(3100); h.view.setData(B)
  h.at(3200); h.view.setTime(220, true, 'Sofia|LIVE')   // past B's 212 s: not B's time
  assert.deepEqual(h.active(), [])
  // MusicKit really resumes B at 2:05 (a saved position), well away from A's end: shown at once
  h.at(3700); h.view.setTime(125.4, true, 'Sofia|LIVE')
  assert.deepEqual(h.active(), [14])   // line 14 (124 s)
  assert.equal(h.list.scrolls.at(-1).behavior, 'instant', 'the first place of a song snaps')
  h.done()
})

test('track change: a time that keeps looking like the old song is taken after 3 s at most', () => {
  const h = setup()
  playAToTheEnd(h, true)
  const long = song('Long', 12, 8, 25, 260)
  h.at(3100); h.view.setData(long)
  // a 260 s song that MusicKit says plays right where A was (~215 s): taken for A's stale time at
  // first, then trusted (the view never waits more than 3 s for a song's time)
  let t = 215.3
  const lit = []
  for (let ms = 3200; ms <= 6700; ms += 500, t += 0.5) { h.at(ms); h.view.setTime(t, true, 'Long|LIVE'); lit.push(h.active().length) }
  assert.equal(lit[0], 0, 'the first sample like the old song is not trusted')
  assert.deepEqual(h.active(), [long.lines.length - 1])
  h.done()
})

test('seek forward and back snap to the line (no smooth run through the lines between)', () => {
  const h = setup()
  h.view.setData(B)
  for (let k = 0; k <= 4; k++) { h.at(k * 500); h.view.setTime(28 + k * 0.5, true) }   // line 2 (28 s)
  assert.deepEqual(h.active(), [2])
  h.list.scrolls.length = 0
  h.at(3000); h.view.setTime(140.3, true)            // seek forward to line 16 (140 s)
  assert.deepEqual(h.active(), [16])
  honest(h, B, 140.3, 'seek forward')
  assert.equal(h.list.scrolls.length, 1)
  assert.equal(h.list.scrolls[0].behavior, 'instant', 'a seek forward snaps')
  assert.equal(h.list.scrolls[0].top, h.topFor(16))
  h.at(3500); h.view.setTime(36.4, true)             // seek back to line 3 (36 s)
  assert.deepEqual(h.active(), [3])
  assert.equal(h.list.scrolls[1].behavior, 'instant', 'a seek back snaps')
  assert.equal(h.list.scrolls[1].top, h.topFor(3))
  h.done()
})

test('normal play still scrolls smoothly from one line to the next', () => {
  const h = setup()
  h.view.setData(B)
  for (let k = 0; k <= 4; k++) { h.at(k * 500); h.view.setTime(24 + k * 0.5, true) }   // line 1 (20 s)
  h.list.scrolls.length = 0
  for (let k = 5; k <= 9; k++) { h.at(k * 500); h.view.setTime(24 + k * 0.5, true) }   // into line 2 (28 s)
  assert.deepEqual(h.active(), [2])
  assert.equal(h.list.scrolls.length, 1)
  assert.equal(h.list.scrolls[0].behavior, 'smooth')
  h.done()
})

test('a click on a far line (and the keyboard\'s Enter) snaps there', () => {
  const h = setup()
  h.view.setData(B)
  for (let k = 0; k <= 4; k++) { h.at(k * 500); h.view.setTime(28 + k * 0.5, true) }
  h.list.scrolls.length = 0
  h.at(3000); h.lineEls()[20].click()
  assert.deepEqual(h.seeks, [B.lines[20].t])
  assert.deepEqual(h.active(), [20])
  assert.equal(h.list.scrolls.at(-1).behavior, 'instant')
  // the player's own pushes that still say ~30 s (before its seek lands) don't pull the lyrics back
  h.at(3400); h.view.setTime(30.4, true)
  assert.deepEqual(h.active(), [20])
  h.done()
})

test('the Studio stage layout: a track change draws nothing lit until the new song\'s time arrives', () => {
  const h = setup('stage')
  playAToTheEnd(h, true)
  h.at(3100); h.view.setData(B)
  assert.deepEqual(h.active(), [])
  h.at(3200); h.view.setTime(215.2, true, 'Sofia|LIVE')
  assert.deepEqual(h.active(), [])
  h.at(3700); h.view.setTime(0.3, true, 'Sofia|LIVE')
  assert.deepEqual(h.active(), [])
  h.done()
})

test('trackSample: the previous song\'s position, a time past the length and a bad time wait; the rest pass', () => {
  const prev = { anchor: 214, at: 0, playing: true, last: 214 }
  const g = T.trackGate(prev, 200, 0)
  assert.equal(T.trackSample(g, 214.6, true, 500), false, 'plays on from the old song')
  assert.equal(T.trackSample(g, 201.5, true, 500), false, 'past the new song\'s length')
  assert.equal(T.trackSample(g, NaN, true, 500), false)
  assert.equal(T.trackSample(g, 0.2, true, 500), true, 'the new song\'s start')
  assert.equal(T.trackSample(g, 2.9, true, 500), true, 'the first 3 s are always the new song\'s')
  assert.equal(T.trackSample(T.trackGate(prev, 260, 0), 214.6, false, 500), true, 'a paused time is shown as it is')
  assert.equal(T.trackSample(T.trackGate(prev, 260, 0), 214.6, true, 500), false)
  assert.equal(T.trackSample(g, 214.6, true, T.TRACK_WAIT * 1000), true, 'after TRACK_WAIT s any time is taken')
  assert.equal(T.trackSample(T.trackGate(null, 0, 0), 150, true, 100), true, 'no previous song, no length: taken')
  assert.equal(T.trackSample(null, 5, true, 0), true)
})

// Lyrics timed for another version (Marcy 2026-10-18, Mad Season live at the Moore): until the helper
// placed the lines, main sends them untimed with `version`; nothing is lit, a note with its ⓘ sits over
// the lines. Once placed (a later play), the same view lights them on time again.
test('version note: untimed lines are never lit and carry the note; placed lines play as usual', () => {
  const doc = makeDoc()
  const list = new El(doc, 'div')
  list.isList = true
  list.scrolls = []
  const view = createLyricsView({ container: list, layout: 'scroll', notes: true, onSeek: () => {} })
  const texts = ['I don\'t wanna be a soldier mama', 'I don\'t wanna die', 'Oh no']
  const base = { key: 'Soldier|Mad Season', title: 'Soldier', artist: 'Mad Season', duration: 557, source: 'lrclib', lang: 'en-US' }
  view.setData(Object.assign({}, base, { lines: texts.map((text) => ({ t: null, text })), version: { precise: true, reason: 'ends-early', lyricsEnd: 359.23, duration: 557.09 } }))
  const lead = list.children[0]
  assert.equal(lead.id, 'lead')
  assert.equal(lead.children[0].textContent, 'Lyric timing is for another version: timed after this play')
  const info = lead.children.find((c) => c.has('sn-info'))
  assert.equal(info.hidden, false)
  assert.match(lead.children.find((c) => c.has('sn-info-text')).textContent, /9:17/)
  const lines = () => list.children.filter((e) => e.has('line'))
  assert.ok(lines().every((e) => e.has('plain')))
  for (let k = 0; k < 6; k++) { nowMs = 10000 + k * 500; view.setTime(20 + k, true, base.key) }
  assert.equal(lines().filter((e) => e.has('active')).length, 0, 'nothing lit with the wrong times')
  // the next play: lines placed from the audio, no note
  view.setData(Object.assign({}, base, { key: base.key + '2', lines: texts.map((text, i) => ({ t: 30 + 4 * i, end: 33.5 + 4 * i, text })), version: null }))
  assert.ok(!list.children.some((c) => c.id === 'lead'))
  nowMs = 19500; view.setTime(0.4, true, base.key + '2')            // the new song's start, then a seek to 35 s
  for (let k = 0; k < 8; k++) { nowMs = 20000 + k * 500; view.setTime(35 + k * 0.25, true, base.key + '2') }
  assert.equal(lines().findIndex((e) => e.has('active')), 1)
  // a quiet line (not found in the audio) is never lit, even at its place
  view.setData(Object.assign({}, base, { key: base.key + '3', lines: texts.map((text, i) => Object.assign({ t: 30 + 4 * i, end: 33.5 + 4 * i, text }, i === 1 ? { quiet: true } : {})) }))
  nowMs = 30000; view.setTime(0.4, true, base.key + '3')
  for (let k = 0; k < 8; k++) { nowMs = 30500 + k * 500; view.setTime(35 + k * 0.25, true, base.key + '3') }
  assert.equal(lines().filter((e) => e.has('active')).length, 0)
  doc.visibilityState = 'hidden'; doc.fire('visibilitychange')
})

test('Expressive words line: shown over the lyrics with its ⓘ and button, kept across a resend of the song, gone when it draws', () => {
  const doc = makeDoc()
  const list = new El(doc, 'div')
  list.isList = true
  list.scrolls = []
  const asked = []
  const view = createLyricsView({ container: list, layout: 'scroll', notes: true, onSeek: () => {}, onExpressive: (a) => asked.push(a) })
  const xnote = () => list.children.find((e) => e.id === 'xnote') || null
  view.setData(Object.assign({ key: 'Song|A' }, song('Song', 5, 4, 3, 60)))
  assert.equal(xnote(), null)
  view.exprNote({ text: 'Expressive words needs the Precise timing helper', info: 'Install the helper in Settings.', action: 'install' })
  const el = xnote()
  assert.ok(el)
  assert.equal(list.children.indexOf(el), 0, 'over the lines, seen when the song starts')
  assert.equal(el.children[0].textContent, 'Expressive words needs the Precise timing helper')
  const button = el.children.find((c) => c.className === 'xact')
  assert.equal(button.textContent, 'Install')
  assert.ok(el.children.some((c) => c.className === 'sn-info' && !c.hidden), 'its ⓘ')
  button.onclick({ stopPropagation() {} })
  assert.deepEqual(asked, ['install'])
  // the same song sent again (measured while on screen: lyricsKey reset in main): the line stays until main changes it
  view.setData(Object.assign({ key: 'Song|A' }, song('Song', 5, 4, 3, 60)))
  assert.ok(xnote())
  view.exprNote({ text: 'Expressive words: measuring this song…', info: 'x', action: '' })
  assert.equal(xnote().children[0].textContent, 'Expressive words: measuring this song…')
  assert.ok(!xnote().children.some((c) => c.className === 'xact'), 'no button that would do nothing')
  view.exprNote(null)
  assert.equal(xnote(), null)
  doc.visibilityState = 'hidden'; doc.fire('visibilitychange')
})
