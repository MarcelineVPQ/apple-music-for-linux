// Hyphen runs render as written (Marcy, 0.15.49: "Yeah-oh, oh-oh-oh-oh" showed as "Yeah- oh, oh- oh- oh- oh"
// in Mad Season "Wake Up (Live At the Moore)"). The pieces of a hyphen run are separate words (each its own
// time and pop, lyrics-timing.js splitWords) written with no text space between them (wordGlue), but every
// word box had a word gap (margin-inline) and a reserved bold width whose slack sat either side of the
// text, which read as a space. The joined pieces now carry .gj / .gn and lyrics-view.css takes the gap and
// the slack away at the joint only. The pop (transform on .w and .s) is untouched.
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')

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

// the karaoke row of line i: its text as drawn (text nodes + each word's regular text) and its word spans
function drawn(list, i) {
  const line = list.els().filter((e) => e.has('line'))[i]
  const ly = line.els().find((e) => e.has('ly'))
  const row = ly.els()[0]
  const words = row.els().filter((e) => e.has('w'))
  const text = row.children.map((c) => (c instanceof El ? c.els().find((e) => e.has('r')).textContent : c.text)).join('')
  return { text, words }
}

function render(lines, lang = 'en-US') {
  const doc = makeDoc()
  const list = new El(doc, 'div')
  list.isList = true
  const view = createLyricsView({ container: list, layout: 'scroll', onSeek: () => {} })
  view.setData({ title: 'Wake Up (Live At the Moore)', artist: 'Mad Season', duration: 457.63, lines, lang, estimate: true })
  return { doc, list, view }
}

test('a hyphen run renders exactly as written, each piece its own word with its own time', () => {
  // Apple's lines for Mad Season "Wake Up (Live At the Moore)" (line-synced; the aligner rejected these, so estimated words)
  const lines = [
    { t: 244.12, end: 249.35, text: 'Yeah-oh, oh-oh-oh-oh' },
    { t: 249.35, end: 254.15, text: 'So an infection not a phase, yeah-oh' }
  ]
  const { list, view, doc } = render(lines)
  const a = drawn(list, 0)
  assert.equal(a.text, 'Yeah-oh, oh-oh-oh-oh')
  assert.deepEqual(a.words.map((w) => w.dataset.text), ['Yeah-', 'oh,', 'oh-', 'oh-', 'oh-', 'oh'])
  // the joints: .gn on the piece before, .gj on the piece after; the word after a real space has neither
  assert.deepEqual(a.words.map((w) => [w.has('gn'), w.has('gj')]), [[true, false], [false, true], [true, false], [true, true], [true, true], [false, true]])
  const b = drawn(list, 1)
  assert.equal(b.text, 'So an infection not a phase, yeah-oh')
  assert.ok(b.words.slice(0, -2).every((w) => !w.has('gj') && !w.has('gn')), 'words with spaces keep their gaps')
  // each piece gets its own time: at each piece's estimated time that piece alone is the one being sung
  const prep = require('../lyrics-view').prepare({ lines, lang: 'en-US', estimate: true })
  const ws = prep.lines[0].words
  assert.equal(ws.length, 6)
  for (let k = 1; k < ws.length; k++) assert.ok(ws[k].t > ws[k - 1].t, 'piece ' + k + ' starts after piece ' + (k - 1))
  ws.forEach((w, k) => {
    nowMs += 1000
    view.setTime((w.t + w.end) / 2, true)
    assert.deepEqual(a.words.map((x) => x.has('now')), ws.map((_, j) => j === k), 'piece ' + k + ' (' + w.text + ')')
  })
  doc.visibilityState = 'hidden'
})

test('em/en dashes and a spaced dash keep their spaces; a trailing hyphen before a space is not joined', () => {
  const lines = [
    { t: 1, end: 4, text: 'wait — for me' },
    { t: 4, end: 7, text: 'here–there' },
    { t: 7, end: 10, text: 'word - word' },
    { t: 10, end: 13, text: 'gonna- go' }
  ]
  const { list } = render(lines)
  const texts = [0, 1, 2, 3].map((i) => drawn(list, i))
  assert.deepEqual(texts.map((d) => d.text), ['wait — for me', 'here–there', 'word - word', 'gonna- go'])
  for (const d of texts) assert.ok(d.words.every((w) => !w.has('gj') && !w.has('gn')), d.text)
  assert.deepEqual(texts[0].words.map((w) => w.dataset.text), ['wait', '—', 'for', 'me'])
  assert.deepEqual(texts[1].words.map((w) => w.dataset.text), ['here–there'])
})

test('lyrics-view.css: the joint has no word gap or bold-width slack; the pop rules are unchanged', () => {
  const css = fs.readFileSync(path.join(__dirname, '..', 'lyrics-view.css'), 'utf8')
  assert.match(css, /\.w\.gj \{ margin-inline-start: 0; \}/)
  assert.match(css, /\.w\.gn \{ margin-inline-end: 0; \}/)
  assert.match(css, /\.w\.gj::after, \.w\.gn::after \{ content: none; \}/)
  // the bold copy stays centred over the narrower box (overflowing text would start-align)
  assert.match(css, /\.w\.gj > \.b, \.w\.gn > \.b \{ left: -50%; right: -50%; \}/)
  // the joint rules touch no transform, transition or animation: the pop is the same for joined pieces
  const joint = css.split('\n').filter((l) => /\.g[jn]\b/.test(l)).join('\n')
  assert.doesNotMatch(joint, /transform|transition|animation|scale/)
  assert.match(css, /\.line\.active \.w\.now \{[^}]*transform: scale\(1\.1\);/)
  assert.match(css, /\.line\.active \.w\.now \.s\.now \{ transform: translateY\(-0\.24em\) scale\(1\.12\);/)
})
