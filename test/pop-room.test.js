// The pop's room (Marcy 2026-10-18, Sabrina Carpenter "We Almost Broke Up Again Last Night" in the Studio): a
// long popped word ate the space after it ("amends,that's right", "predic|table" crowding "it's"). The pop is
// hers and stays as it is (syllable 1.12 with its lift and overshoot, word 1.1, backing 1.08, the held note's
// 1.05, transform only); only a pop that would come closer than POP_GAP to a neighbour changes: its origin
// moves to the side with room (a row's outer edge is free), and only when both sides are short is its scale
// capped. Measured once per layout (lyrics-view.js popRoom), never per frame.
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')
const V = require('../lyrics-view')

const FS = 31   // px: the Studio's lyric size (lyrics.html body.stage .line)
const GAP = V.POP_GAP * FS
// one element's pop, as it lands: its ink [left, right] at scale s about origin ox of its box
const popped = (p, ox, s) => { const o = p.boxL + ox * p.boxW; return [o + s * (p.inkL - o), o + s * (p.inkR - o)] }
// a word in a row with today's spacing: a 0.43em gap between boxes (a space and the 0.08em margins)
function word(len, opts = {}) {
  const w = len * 0.6 * FS
  const space = 0.43 * FS
  return Object.assign({ inkL: 100, inkR: 100 + w, boxL: 100, boxW: w, ox: 0.5, scale: V.POP.word, k: 1, prev: 100 - space, next: 100 + w + space, gap: GAP }, opts)
}

test('a short word keeps exactly today\'s pop (no new origin, no cap)', () => {
  for (const len of [2, 3, 4]) assert.equal(V.popFit(word(len)), null, len + ' letters')
  assert.equal(V.popFit(word(3, { scale: V.POP.bgWord })), null)
  // a short syllable too, overshoot included
  assert.equal(V.popFit(word(3, { scale: 1 + (V.POP.syl - 1) * V.SYL_OVERSHOOT, k: V.SYL_OVERSHOOT })), null)
})

test('a long word in the middle of a line keeps a clear gap both sides ("amends," before "that\'s")', () => {
  const p = word(7)   // "amends," in bold: ~4.2em
  // today it would come within less than POP_GAP of both neighbours
  const [l0, r0] = popped(p, 0.5, V.POP.word)
  assert.ok(l0 - p.prev < GAP && p.next - r0 < GAP)
  const f = V.popFit(p)
  assert.ok(f && f.max > 1 && f.max < V.POP.word, JSON.stringify(f))
  const [l, r] = popped(p, f.ox, f.max)
  assert.ok(l - p.prev >= GAP - 0.05, 'left gap ' + (l - p.prev) / FS + 'em')
  assert.ok(p.next - r >= GAP - 0.05, 'right gap ' + (p.next - r) / FS + 'em')
  // capped no more than needed: the gaps are POP_GAP, not more
  assert.ok(l - p.prev < GAP + 0.1 && p.next - r < GAP + 0.1)
})

test('a word short of room on one side only moves its origin and keeps its scale', () => {
  const p = word(3, { next: 100 + 3 * 0.6 * FS + 0.36 * FS })   // a tighter space after it
  const f = V.popFit(p)
  assert.ok(f && f.max == null && f.ox > 0.5, JSON.stringify(f))
  const [l, r] = popped(p, f.ox, V.POP.word)
  assert.ok(p.next - r >= GAP - 0.05 && l - p.prev >= GAP - 0.05)
})

test('a line\'s first and last words grow outward freely (no cap); a row-start word grows outward only as needed', () => {
  // the last word on its row: nothing after it
  const end = word(9, { next: null })
  const f = V.popFit(end)
  assert.ok(f && f.max == null && f.ox < 0.5)
  assert.ok(popped(end, f.ox, V.POP.word)[0] - end.prev >= GAP - 0.05)
  // the lyrics window's row-start origin (0%: all growth inward) moves right just enough
  const start = word(7, { prev: null, ox: 0 })
  const g = V.popFit(start)
  assert.ok(g && g.max == null && g.ox > 0, JSON.stringify(g))
  assert.ok(Math.abs(start.next - popped(start, g.ox, V.POP.word)[1] - GAP) < 0.05)
  // a short row-start word keeps its 0% origin
  assert.equal(V.popFit(word(2, { prev: null, ox: 0 })), null)
})

test('hyphen joints touch as written: the joined side is never measured', () => {
  // "Yeah-" "oh,": the piece after the joint has no prev (lyrics-view.js .gj), the one before no next (.gn)
  assert.equal(V.popFit(word(4, { prev: null, next: null })), null)
  const f = V.popFit(word(7, { prev: null }))
  assert.ok(f && f.max == null)   // all its growth may go to the joint's side
})

test('a syllable\'s cap allows for the overshoot: at its peak the gap still holds', () => {
  const k = V.SYL_OVERSHOOT
  const p = word(8, { scale: 1 + (V.POP.syl - 1) * k, k })
  const f = V.popFit(p)
  assert.ok(f && f.max < V.POP.syl)
  const peak = 1 + (f.max - 1) * k
  const [l, r] = popped(p, f.ox, peak)
  assert.ok(l - p.prev >= GAP - 0.05 && p.next - r >= GAP - 0.05)
})

test('no room at all (never with today\'s spacing): no growth rather than an overlap', () => {
  const f = V.popFit(word(5, { prev: 100 - 0.1 * FS, next: 100 + 5 * 0.6 * FS + 0.1 * FS }))
  assert.deepEqual(f, { ox: 0.5, max: 1 })
})

test('lyrics-view.css: the pop scales are POP\'s, each min(own, --pop-max) with today\'s number as the default', () => {
  const css = fs.readFileSync(path.join(__dirname, '..', 'lyrics-view.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
  const m = (n) => 'scale\\(min\\(' + String(n).replace('.', '\\.') + ', var\\(--pop-max, ' + String(n).replace('.', '\\.') + '\\)\\)\\)'
  assert.match(css, new RegExp('\\.line\\.active \\.w\\.now \\{[^}]*transform: ' + m(V.POP.word) + ';'))
  assert.match(css, new RegExp('\\.line\\.active \\.bgv \\.w\\.now \\{ transform: ' + m(V.POP.bgWord) + '; \\}'))
  assert.match(css, new RegExp('\\.line\\.active \\.w\\.now \\.s\\.now \\{ transform: translateY\\(-0\\.24em\\) ' + m(V.POP.syl) + ';'))
  assert.match(css, new RegExp('\\.line\\.active \\.bgv \\.w\\.now \\.s\\.now \\{ transform: translateY\\(-0\\.16em\\) ' + m(V.POP.bgSyl) + ';'))
  assert.match(css, new RegExp('\\.line\\.active \\.w\\.now\\.hold:not\\(\\.hs\\) \\{ transform: ' + m(1.05) + ';'))
  assert.match(css, new RegExp('\\.line\\.active \\.w\\.now\\.hold \\.s\\.now \\{ transform: translateY\\(-0\\.1em\\) ' + m(1.05) + ';'))
  // the overshoot the cap allows for is the syllable ease's: cubic-bezier(.3,1.6,.5,1) peaks at 1.111
  assert.match(css, /\.w \.s \{[^}]*transition: transform 0\.12s cubic-bezier\(\.3,1\.6,\.5,1\);/)
  let peak = 0
  // loop: NOT-WORTH — test only
  for (let t = 0; t <= 1; t += 0.001) peak = Math.max(peak, 3 * (1 - t) ** 2 * t * 1.6 + 3 * (1 - t) * t * t + t ** 3)
  assert.ok(Math.abs(peak - V.SYL_OVERSHOOT) < 0.002, String(peak))
})

// --- the view: a stand-in DOM with a laid-out row (words in a line, 31 px text) ---
let reads = 0
class El {
  constructor(doc, tag) {
    this.ownerDocument = doc
    this.tagName = tag
    this.children = []
    this.parentElement = null
    this.className = ''
    this.dataset = {}
    const props = {}
    this.style = { props, setProperty(k, v) { props[k] = v }, removeProperty(k) { delete props[k] }, transformOrigin: '' }
    this.attrs = {}
    this._text = ''
    this.box = { l: 0, w: 0 }
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
  remove() {}
  set innerHTML(v) { this.children = []; if (/<i>/.test(v)) for (let i = 0; i < 3; i++) this.appendChild(new El(this.ownerDocument, 'i')) }
  set textContent(v) { this.children = []; this._text = String(v) }
  get textContent() { return this._text }
  cloneNode() { const c = new El(this.ownerDocument, this.tagName); c.className = this.className; return c }
  els() { return this.children.filter((c) => c instanceof El) }
  all() { return this.els().flatMap((c) => [c, ...c.all()]) }
  querySelectorAll(sel) { const cls = sel.replace(/^\./, ''); return this.all().filter((e) => e.has(cls)) }
  querySelector() { return null }
  setAttribute(k, v) { this.attrs[k] = String(v) }
  removeAttribute(k) { delete this.attrs[k] }
  getAttribute(k) { return k in this.attrs ? this.attrs[k] : null }
  contains(x) { return x === this || this.all().includes(x) }
  focus() {}
  addEventListener() {}
  animate() { return { cancel() {}, play() {}, pause() {}, playState: 'paused', currentTime: 0 } }
  // layout: absolute x (offsetParent null, so offsetLeft is the page x), one row at top 0
  get offsetWidth() { reads++; return Math.round(this.box.w) }
  get offsetTop() { reads++; return 0 }
  get offsetLeft() { reads++; return Math.round(this.box.l) }
  get offsetParent() { return null }
  get clientWidth() { return 1000 }
  getBoundingClientRect() { reads++; return { top: 0, bottom: 40, height: 40, left: this.box.l, right: this.box.l + this.box.w, width: this.box.w } }
  scrollTo() {}
}
function makeDoc() {
  const listeners = {}
  const doc = {
    visibilityState: 'visible',
    activeElement: null,
    createElement: (tag) => new El(doc, tag),
    createTextNode: (t) => ({ text: t }),
    createRange: () => { let el = null; return { selectNodeContents(e) { el = e }, getBoundingClientRect() { reads++; const w = el.parentElement.box.w * 1.04; const c = el.box.l + el.box.w / 2; return { left: c - w / 2, right: c + w / 2, width: w } } } },
    addEventListener() {},
    defaultView: {
      matchMedia: () => ({ matches: false }),
      addEventListener(type, f) { (listeners[type] = listeners[type] || []).push(f) },
      getComputedStyle: () => ({ fontSize: FS + 'px', textAlign: 'left' })
    },
    fire: (type) => (listeners[type] || []).forEach((f) => f())
  }
  return doc
}
globalThis.requestAnimationFrame = () => 1
globalThis.cancelAnimationFrame = () => {}
const realPerf = globalThis.performance
Object.defineProperty(globalThis, 'performance', { value: { now: () => 0 }, configurable: true, writable: true })
test.after(() => Object.defineProperty(globalThis, 'performance', { value: realPerf, configurable: true, writable: true }))

// lays the karaoke row out as the Studio does: bold box per word (0.6em a letter), regular text 0.59em a letter
// centred in it, 0.41em between boxes (none at a hyphen joint): ~0.43em from ink to ink, as measured in the
// Studio; syllables side by side in the bold copy
function layout(list) {
  for (const line of list.els().filter((e) => e.has('line'))) {
    const row = line.els()[0].els()[0]
    let x = 40
    row.box = { l: 40, w: 900 }
    // loop: NOT-WORTH — test only
    for (const w of row.els()) {
      const n = w.dataset.text.length
      const joined = w.has('gj')
      if (w !== row.els()[0] && !joined) x += 0.41 * FS
      const bw = (joined || w.has('gn') ? 0.59 : 0.6) * n * FS
      w.box = { l: x, w: bw }
      const [r, b] = w.els()
      r.box = { l: x + (bw - 0.59 * n * FS) / 2, w: 0.59 * n * FS }
      b.box = { l: x, w: bw }
      let sx = x
      // loop: NOT-WORTH — test only
      for (const s of w.syl || []) { const sw = 0.6 * s.els()[0].textContent.length * FS; s.box = { l: sx, w: sw }; sx += sw }
      x += bw
    }
  }
}

function view(lines) {
  const doc = makeDoc()
  const list = new El(doc, 'div')
  const v = V.createLyricsView({ container: list, layout: 'stage' })
  v.setData({ title: 't', artist: 'a', duration: 60, lines, lang: 'ro', estimate: false })   // ro: no hyphenation patterns, words stay whole
  layout(list)
  const row = list.els().filter((e) => e.has('line'))[0].els()[0].els()[0]
  return { doc, v, words: row.els() }
}
const timed = (text, t0) => text.split(' ').map((w, i) => ({ t: t0 + i * 0.5, end: t0 + i * 0.5 + 0.45, text: w }))

test('the view: a long word mid-line gets a cap, short words and the row\'s last word none; measured once per layout', () => {
  const lines = [{ t: 1, end: 6, text: 'we make amends, so right', words: timed('we make amends, so right', 1) }]
  const { doc, v, words } = view(lines)
  reads = 0
  v.setTime(1.2, false)   // "we" lights: the line is measured now
  const first = reads
  assert.ok(first > 0)
  // every later frame and word change of the line: no layout read at all
  // loop: NOT-WORTH — test only
  for (let t = 1.2; t < 3.9; t += 0.05) v.setTime(t, false)
  assert.equal(reads, first, 'no per-frame (or per-word) layout reads')
  const cap = words.map((w) => w.style.props['--pop-max'])
  assert.equal(cap[0], undefined)            // "we"
  assert.equal(cap[1], undefined)            // "make"
  assert.ok(+cap[2] > 1 && +cap[2] < 1.1)    // "amends,"
  assert.equal(cap[3], undefined)            // "so"
  assert.equal(cap[4], undefined)            // "right": the row's end, free outward
  // "amends," popped: its gaps to "make" and "so" stay >= POP_GAP
  v.setTime(2.2, false)
  assert.ok(words[2].has('now'))
  const ox = parseFloat(words[2].style.transformOrigin) / 100
  const s = +cap[2]
  const o = words[2].box.l + ox * words[2].box.w
  const l = o + s * (words[2].box.l - o)
  const r = o + s * (words[2].box.l + words[2].box.w - o)
  const prevR = words[1].els()[0].box.l + words[1].els()[0].box.w
  const nextL = words[3].els()[0].box.l
  assert.ok(l - prevR >= GAP - 0.1 && nextL - r >= GAP - 0.1, [(l - prevR) / FS, (nextL - r) / FS].join(' '))
  // a short word pops as today: no origin of its own (the CSS 50% 65%)
  v.setTime(1.7, false)
  assert.equal(words[1].style.transformOrigin, '')
  // a resize measures again, once
  doc.fire('resize')
  reads = 0
  v.setTime(2.2, false)
  const again = reads
  assert.ok(again > 0)
  // loop: NOT-WORTH — test only
  for (let t = 2.2; t < 3.9; t += 0.05) v.setTime(t, false)
  assert.equal(reads, again)
})

test('the view: hyphen pieces keep their joint (no cap or gap there); syllables: only the outer ones meet the neighbours', () => {
  const words = timed('Yeah- oh, again', 1)
  words[2].syl = [{ t: 2, end: 2.2, text: 'a' }, { t: 2.2, end: 2.45, text: 'gain' }]
  const lines = [{ t: 1, end: 3, text: 'Yeah-oh, again', words }]
  const { v, words: ws } = view(lines)
  assert.ok(ws[0].has('gn') && ws[1].has('gj'))
  v.setTime(1.2, false)
  assert.equal(ws[0].style.props['--pop-max'], undefined)
  assert.equal(ws[1].style.props['--pop-max'], undefined)
  v.setTime(2.3, false)
  assert.ok(ws[2].syl[1].has('now'))
  // short pieces pop as today, at the joint too: no origin, no cap
  assert.ok(ws.slice(0, 2).every((w) => w.style.transformOrigin === ''))
  // the caps sit on the syllables, never on a word with syllables (the custom property inherits)
  assert.equal(ws[2].style.props['--pop-max'], undefined)
})
