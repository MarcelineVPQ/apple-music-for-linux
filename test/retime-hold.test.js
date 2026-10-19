// A line being sung is never re-timed mid-line (0.15.59). On a processor-only PC each section's alignment
// takes 20-50 s, so its words arrived while their lines were on screen or already sung, and the lit word
// jumped back and forth (Marcy's laptop, 2026-10-19). The new timing of a lit line is held until the line
// ends; the other lines take it at once; a lit word never goes dark again.
const test = require('node:test')
const assert = require('node:assert/strict')

// --- a stand-in DOM: just what createLyricsView touches, keeping text nodes ---
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
  appendChild(c) { if (c instanceof El) c.parentElement = this; this.children.push(c); return c }
  append(...cs) { for (const c of cs) this.appendChild(c) }
  remove() { const p = this.parentElement; if (p) p.children.splice(p.children.indexOf(this), 1); this.parentElement = null }
  set innerHTML(v) { this.children = []; if (/<i>/.test(v)) for (let i = 0; i < 3; i++) this.appendChild(new El(this.ownerDocument, 'i')) }
  set textContent(v) { this.children = []; this._text = String(v) }
  get textContent() { return this._text }
  cloneNode() {
    const c = new El(this.ownerDocument, this.tagName)
    c.className = this.className
    c._text = this._text
    for (const k of this.children) c.appendChild(k instanceof El ? k.cloneNode() : { text: k.text })
    return c
  }
  els() { return this.children.filter((c) => c instanceof El) }
  all() { return this.els().flatMap((c) => [c, ...c.all()]) }
  querySelectorAll(sel) { const cls = sel.replace(/^\./, ''); return this.all().filter((e) => e.has(cls)) }
  querySelector(sel) { if (sel.includes(':focus-visible') || sel[0] === '#') return null; return this.querySelectorAll(sel)[0] || null }
  setAttribute(k, v) { this.attrs[k] = String(v) }
  removeAttribute(k) { delete this.attrs[k] }
  getAttribute(k) { return k in this.attrs ? this.attrs[k] : null }
  contains(x) { return x === this || this.all().includes(x) }
  focus() {}
  addEventListener() {}
  animate() { return { cancel() {}, play() {}, pause() {}, playState: 'paused', currentTime: 0 } }
  get offsetWidth() { return 0 }
  get offsetTop() { return 0 }
  get offsetLeft() { return 0 }
  get offsetParent() { return null }
  getBoundingClientRect() { return { top: 0, bottom: 40, height: 40, left: 0, right: 0, width: 0 } }
  scrollTo() {}
}
function makeDoc() {
  const doc = {
    visibilityState: 'visible',
    activeElement: null,
    createElement: (tag) => new El(doc, tag),
    createTextNode: (t) => ({ text: t }),
    addEventListener() {},
    defaultView: { matchMedia: () => ({ matches: false }), addEventListener() {} }
  }
  return doc
}
let nowMs = 0
const realPerf = globalThis.performance
Object.defineProperty(globalThis, 'performance', { value: { now: () => nowMs }, configurable: true, writable: true })
globalThis.requestAnimationFrame = () => 1
globalThis.cancelAnimationFrame = () => {}
test.after(() => Object.defineProperty(globalThis, 'performance', { value: realPerf, configurable: true, writable: true }))

const { createLyricsView } = require('../lyrics-view')

function make(lines) {
  const doc = makeDoc()
  const list = new El(doc, 'div')
  list.isList = true
  const view = createLyricsView({ container: list, layout: 'scroll', onSeek: () => {} })
  view.setData({ key: 'k', title: 'T', artist: 'A', duration: 60, lines, lang: 'en-US', estimate: true })
  return { list, view }
}
// line i's word spans in its karaoke layer (the first .ly row; the dim/hover copies follow it)
function words(list, i) {
  const line = list.els().filter((e) => e.has('line'))[i]
  return line.els().find((e) => e.has('ly')).els()[0].els().filter((e) => e.has('w'))
}
// the global index of the lit word (the 'now' one, else the last sung) over the karaoke rows
function lit(list) {
  const ws = [0, 1, 2].flatMap((i) => words(list, i))
  let at = -1
  ws.forEach((w, i) => { if (w.has('now') || w.has('sung')) at = i })
  return at
}
const LINES = [
  { t: 10, text: 'one two three four' },
  { t: 14, text: 'five six seven eight' },
  { t: 18, text: 'nine ten' }
]
// a push at song time t, `ms` of wall time after the last one (the clock's own pace)
const play = (view, t, ms = 500) => { nowMs += ms; view.setTime(t, true, 'k') }

test('a lit line keeps its timing until it ends; later lines take theirs at once', () => {
  const { list, view } = make(LINES)
  play(view, 11.0)
  play(view, 11.5)
  play(view, 12.0)
  play(view, 12.4, 400)                    // line 0 lit, a word on the estimate
  const before = lit(list)
  assert.ok(before >= 1, 'a word of line 0 is lit')
  // the alignment comes late: line 0's words much later (they'd all go dark) and line 1's earlier
  view.align({ key: 'k', lines: {
    0: { text: LINES[0].text, words: ['one', 'two', 'three', 'four'].map((w, j) => ({ t: 12.8 + j * 0.3, end: 13.0 + j * 0.3, text: w })) },
    1: { text: LINES[1].text, words: ['five', 'six', 'seven', 'eight'].map((w, j) => ({ t: 14 + j * 0.2, end: 14.15 + j * 0.2, text: w })) }
  } })
  assert.equal(lit(list), before, 'the line being sung did not change under the listener')
  let shown = before
  for (let t = 12.5; t < 16; t += 0.1) {
    play(view, +t.toFixed(2), 100)
    const now = lit(list)
    assert.ok(now >= shown, 'no lit word went dark at ' + t.toFixed(1) + ': ' + shown + ' -> ' + now)
    shown = now
  }
  // line 1 took its new timing: at 14.5 its third word (0.4 s in at 0.2 s a word) or later is the one sung
  nowMs += 10000
  view.setTime(14.5, true, 'k')
  assert.ok(words(list, 1).filter((w) => w.has('now') || w.has('sung')).length >= 2, 'line 1 runs on its aligned words')
})

test('a seek back after a held line: the line plays its new timing', () => {
  const { list, view } = make(LINES)
  play(view, 11.0)
  play(view, 11.5)
  view.align({ key: 'k', lines: { 0: { text: LINES[0].text, words: ['one', 'two', 'three', 'four'].map((w, j) => ({ t: 10 + j, end: 10.8 + j, text: w })) } } })
  nowMs += 10000
  view.setTime(16, true, 'k')            // past line 0: its held timing is taken
  nowMs += 10000
  view.setTime(12.2, true, 'k')          // back into line 0: word 2 (12-12.8) is the one sung
  assert.equal(words(list, 0).findIndex((w) => w.has('now')), 2)
})
