// Expressive words (lyrics-expressive.js, lyrics-view.js, main.js): the engine's measured expression
// drawn on top of the karaoke. The pop stays as it is; the cached form keeps only what passed the
// confidence gates; the view without it is the plain karaoke; everything that moves is a Web Animation
// of transform/opacity, reserved room so nothing reflows, nothing at rest, paused while hidden or paused,
// still under reduced motion; the helper is asked for "expr" only when it serves it.
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')
const X = require('../lyrics-expressive')
const H = require('../align-helper')
const A = require('../align-session')

const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8')
const fixture = (f) => JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'expr', f), 'utf8'))
// a fixture's lines as the view gets them: aligned words (from the notes' syllables), one per (line, word)
function viewLines(fx) {
  const lines = fx.lines.map((l) => ({ t: null, text: l.text, words: [] }))
  // loop: test only
  for (const s of fx.syllables) {
    const ws = lines[s.line].words
    const w = ws[s.word] || (ws[s.word] = { text: s.word_text, t: s.t, end: s.end })
    w.t = Math.min(w.t, s.t)
    w.end = Math.max(w.end, s.end)
  }
  // loop: test only
  for (const l of lines) { l.words = l.words.filter(Boolean); l.t = l.words[0].t; l.end = l.words[l.words.length - 1].end; l.aligned = true }
  return lines
}

// --- the cached form and its gates ---

test('compact: version 1 (real singing) and 2 (synthetic) are read; an unknown version is not', () => {
  const v1 = X.compact(fixture('cortez-feel-v1.json').expr)
  assert.equal(v1.format, X.FORMAT)
  assert.equal(v1.v, 1)
  assert.ok(v1.words.length > 30)
  assert.ok(v1.words.every((w) => w.c >= X.CONF_MIN))
  assert.ok(v1.words.every((w) => w.x === undefined), 'version 1 has no vowel text')
  const v2 = X.compact(fixture('held-vibrato-v2.json').expr)
  assert.equal(v2.v, 2)
  const home = v2.words.find((w) => w.l === 0 && w.w === 2)
  assert.equal(home.x, 'o')
  assert.ok(home.vb && home.vb.tr.length >= 3, 'the vibrato per cycle')
  assert.ok(home.env && home.env.length > 10, 'the loudness envelope')
  assert.equal(X.compact({ version: 3, words: [{ line: 0, word: 0, conf: 1 }] }), null)
  assert.equal(X.compact(null), null)
  assert.equal(X.compact(fixture('cortez-feel-v1.json').expr, 4).words[0].l, v1.words[0].l + 4, 'a section job: lines shifted')
})

test('compact: only what the engine measured with confidence is kept', () => {
  const v = { i0: 1, i1: 2, text: 'o', t: 1, end: 2 }
  const got = X.compact({ version: 2, words: [
    { line: 0, word: 0, conf: 0.4, vowel: v, loud: 0.9, loud_conf: 1 },                           // the word unsure: out
    { line: 0, word: 1, conf: 0.9, vowel: v, vibrato: { rate: 5.5, extent: 50, t: 1.2, end: 1.9, conf: 0.4 } },   // vibrato unsure
    { line: 0, word: 2, conf: 0.9, vowel: v, loud: 0.8, loud_conf: 0.3 },                         // loudness unsure
    { line: 0, word: 3, conf: 0.9, vowel: v, loud_env: [[1, 0.2], [1.05, 0.3]], loud_env_conf: 0.5, contour: [[1, 0], [1.05, 20]], contour_conf: 0.4 },
    { line: 0, word: 4, conf: 0.9, vowel: Object.assign({}, v, { text: 'oo' }) }                   // letters that don't fit i0..i1
  ], vocalise: [{ t: 3, end: 4.5, midi: 57, conf: 0.9 }, { t: 6, end: 7, midi: 57, conf: 0.2 }] })
  const by = Object.fromEntries(got.words.map((w) => [w.w, w]))
  assert.equal(by[0], undefined)
  assert.equal(by[1].vb, undefined)
  assert.equal(by[2].ld, undefined)
  assert.equal(by[3].env, undefined)
  assert.equal(by[3].ct, undefined)
  assert.equal(by[4].x, undefined)
  assert.deepEqual(got.voc, [{ t: 3, e: 4.5, c: 0.9 }])
})

test('forView: off is always nothing (the plain karaoke); on passes the cached words through', () => {
  const c = X.compact(fixture('held-vibrato-v2.json').expr)
  assert.equal(X.forView(c, false), null)
  assert.equal(X.forView(null, true), null)
  assert.equal(X.forView({ format: 99, words: [{}] }, true), null)
  assert.deepEqual(X.forView(c, true).words, c.words)
})

test('defaultOn: on for Development channel builds, off for Stable', () => {
  assert.equal(X.defaultOn('0.15.50-dev.1'), true)
  assert.equal(X.defaultOn('0.15.50-dev'), true)
  assert.equal(X.defaultOn('0.15.50'), false)
  assert.equal(X.defaultOn(''), false)
})

// --- which word gets what ---

test('matchWord: the vowel letters must be the word\'s and on its time; a stretch needs a hold', () => {
  const x = { l: 0, w: 0, c: 0.9, i0: 1, i1: 2, x: 'o', t: 1.1, e: 2.0, ld: 0.8 }
  const m = X.matchWord(x, { text: 'home', t: 1.0, end: 2.1 })
  assert.equal(m.stretch, true)
  assert.equal(m.extra, Math.min(X.MAX_EXTRA, Math.round((0.9 - 0.2) / X.LETTER_S)))
  assert.equal(m.rep, 'o')
  assert.ok(m.ink > 0, 'belted: ink')
  assert.equal(m.ghost.base, 'o', 'held 0.9 s: ghosts its held vowel')
  assert.equal(X.matchWord(x, { text: 'hand', t: 1.0, end: 2.1 }).i0, -1, 'other letters: no vowel drawn (ink only)')
  assert.equal(X.matchWord(Object.assign({}, x, { ld: undefined }), { text: 'hand', t: 1, end: 2 }), null, 'nothing measured fits: nothing')
  assert.equal(X.matchWord(x, { text: 'home', t: 5, end: 6 }).i0, -1, 'another time: no vowel drawn')
  assert.equal(X.matchWord(x, { text: 'home', t: 1, end: 2.1 }, true).stretch, false, 'a hyphen run: no room may open')
  assert.equal(X.matchWord(Object.assign({}, x, { e: 1.4 }), { text: 'home', t: 1, end: 1.5 }).stretch, false, 'a short vowel: no stretch')
  assert.equal(X.matchWord(Object.assign({}, x, { e: 1.4 }), { text: 'home', t: 1, end: 1.5 }).ghost, null, 'and no ghost')
  assert.equal(X.matchWord(Object.assign({}, x, { e: 5 }), { text: 'home', t: 1, end: 5 }).extra, X.MAX_EXTRA)
  // syllables: the held vowel in the last one stretches; in an earlier one it doesn't
  const baby = { text: 'baby', t: 1, end: 3, syl: [{ text: 'ba' }, { text: 'by' }] }
  assert.equal(X.matchWord({ l: 0, w: 0, c: 0.9, i0: 3, i1: 4, t: 1.5, e: 3 }, baby).stretch, true)
  assert.equal(X.matchWord({ l: 0, w: 0, c: 0.9, i0: 1, i1: 2, t: 1.05, e: 2 }, baby).stretch, false)
  // wordless vocalise in the lyrics: the whole word ghosts, from a shorter hold
  const ooh = X.matchWord({ l: 0, w: 0, c: 0.9, i0: 0, i1: 2, t: 1, e: 1.7 }, { text: 'Ooh,', t: 1, end: 1.8 })
  assert.deepEqual([ooh.ghost.base, ooh.ghost.tail], ['oo', 'h'])
})

test('lineExpressions: the real fixture\'s held vowels stretch, its long ones ghost', () => {
  const fx = fixture('cortez-feel-v1.json')
  const doc = X.forView(X.compact(fx.expr), true)
  const lines = viewLines(fx)
  const all = lines.flatMap((l, i) => X.lineExpressions(doc, i, l.words, null))
  assert.ok(all.length > 20)
  assert.ok(all.some((x) => x.m.stretch), 'some held vowels stretch')
  assert.ok(all.filter((x) => x.m.ghost).length >= 1, 'a long hold ghosts')
  assert.ok(all.every((x) => x.m.i0 < 0 || lines.some((l) => l.words[x.i] && l.words[x.i].text.slice(x.m.i0, x.m.i1).length)))
})

// --- keyframes: transform and opacity only, in order ---

const KEYS = new Set(['offset', 'opacity', 'transform'])
function checkFrames(kf) {
  assert.ok(Array.isArray(kf) && kf.length >= 2)
  // loop: test only
  for (let i = 0; i < kf.length; i++) {
    assert.ok(Object.keys(kf[i]).every((k) => KEYS.has(k)), 'compositor properties only: ' + Object.keys(kf[i]))
    assert.ok(kf[i].offset >= 0 && kf[i].offset <= 1)
    if (i) assert.ok(kf[i].offset >= kf[i - 1].offset)
    if (kf[i].transform) assert.doesNotMatch(kf[i].transform, /var\(|calc\(/, 'no custom property in a keyframe (it would leave the compositor)')
  }
}

test('keyframes: the stretch, the wave and the ghost move only transform and opacity', () => {
  const m = X.matchWord({ l: 0, w: 0, c: 0.9, i0: 1, i1: 2, x: 'o', t: 1.1, e: 2.6, ld: 0.5, vb: { r: 5.6, d: 45, t: 1.4, e: 2.5, tr: [[1.4, 5.4, 40], [1.6, 5.8, 50]] }, ct: [[1.1, 0], [1.6, 80], [2.5, -40]] },
    { text: 'home', t: 1.0, end: 2.7 })
  const tl = X.stretchTimeline(m, 0.95)
  assert.equal(tl.t0, 0.95)
  // loop: test only
  for (let k = 0; k < m.extra; k++) checkFrames(X.letterBirth(k, m.extra, tl.t0, tl.t1, m.vt, m.hold))
  checkFrames(X.codaRide(40, tl.t0, tl.t1, m.vt, m.hold))
  assert.equal(X.visibleExtras(5, 1000, 10, 1.1), 5)
  assert.equal(X.visibleExtras(5, 25, 10, 1.1), 2, 'only what fits the gap')
  assert.equal(X.visibleExtras(5, 0, 10), 0)
  const wave = X.waveKeyframes(m.vb, tl.t0, tl.t1, 1, 0, 0)
  checkFrames(wave)
  const ys = wave.map((f) => Number(/translateY\((-?[\d.]+)px\)/.exec(f.transform)[1]))
  assert.ok(Math.max(...ys.map(Math.abs)) <= 1.4 + 1e-9, 'depth bounded')
  assert.ok(Math.max(...ys) > 0.3, 'it waves')
  assert.equal(ys[0], 0)
  assert.equal(X.waveKeyframes(null, 0, 1, 1, 0), null)
  const plan = X.ghostPlan(m, 'k|0|0', false, 120)
  checkFrames(plan.opacity)
  checkFrames(plan.drift)
  assert.ok(plan.opacity.every((f) => f.opacity <= 0.12 + 1e-9), 'far back: a ghost never competes with the words (≤ 12 %)')
  assert.ok(plan.size >= 3 && plan.size <= 5, 'large: 3-5x the lyrics')
  assert.ok(plan.letters.length > 1 && plan.letters[0].ch === 'o')
  // reduced motion: no drift, no breathing, all letters there from the start
  const still = X.ghostPlan(m, 'k|0|0', true, 120)
  assert.equal(still.drift, null)
  assert.ok(still.letters.every((l) => l.born === m.vt))
  assert.ok(still.opacity.length <= 4)
  assert.equal(X.ghostPlan(m, 'k|0|0', false, 120).x, plan.x, 'the same place every play')
})

// --- the view (a stand-in DOM) ---

class El {
  constructor(doc, tag) {
    this.ownerDocument = doc
    this.tagName = tag
    this.children = []
    this.parentElement = null
    this.className = ''
    this.dataset = {}
    this.styleSets = []
    const self = this
    // every style write is recorded (a property set, or a custom property through setProperty)
    this.style = new Proxy({ transformOrigin: '' }, {
      get(o, k) { if (k === 'setProperty') return (n, v) => { self.styleSets.push(n); o[n] = v }; if (k === 'removeProperty') return () => {}; return o[k] },
      set(o, k, v) { o[k] = v; self.styleSets.push(k); return true }
    })
    this.attrs = {}
    this._text = ''
    this.scrollTop = 0
    this.tabIndex = -1
    this.lang = ''
    this.anims = []
    this.classList = {
      add(c) { if (!self.has(c)) self.className = (self.className + ' ' + c).trim() },
      remove(c) { self.className = self.className.split(/\s+/).filter((x) => x && x !== c).join(' ') },
      toggle(c, on) { if (on === undefined ? !self.has(c) : on) this.add(c); else this.remove(c) },
      contains(c) { return self.has(c) }
    }
  }
  has(c) { return this.className.split(/\s+/).includes(c) }
  appendChild(c) { if (c instanceof El) { if (c.parentElement) c.remove(); c.parentElement = this } this.children.push(c); return c }
  insertBefore(c, ref) { if (c instanceof El) c.parentElement = this; const i = ref ? this.children.indexOf(ref) : -1; if (i < 0) this.children.push(c); else this.children.splice(i, 0, c); return c }
  get firstChild() { return this.children[0] || null }
  append(...cs) { for (const c of cs) this.appendChild(c) }   // loop: test only
  remove() { const p = this.parentElement; if (p) p.children.splice(p.children.indexOf(this), 1); this.parentElement = null }
  replaceWith(n) { const p = this.parentElement; if (!p) return; p.children[p.children.indexOf(this)] = n; if (n instanceof El) n.parentElement = p; this.parentElement = null }
  set innerHTML(v) { this.children = []; if (/<i>/.test(v)) for (let i = 0; i < 3; i++) this.appendChild(new El(this.ownerDocument, 'i')) }   // loop: test only
  set textContent(v) { this.children = []; this._text = String(v) }
  get textContent() { return this._text + this.children.map((c) => (c instanceof El ? c.textContent : c.text)).join('') }
  cloneNode() {
    const c = new El(this.ownerDocument, this.tagName)
    c.className = this.className
    c._text = this._text
    c.attrs = Object.assign({}, this.attrs)
    for (const k of this.children) c.appendChild(k instanceof El ? k.cloneNode() : { text: k.text })   // loop: test only
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
  animate(keyframes, opts) {
    const a = { keyframes, opts, state: 'paused', currentTime: 0, cancelled: false, el: this,
      cancel() { this.cancelled = true; this.state = 'idle' }, play() { this.state = 'running' }, pause() { this.state = 'paused' },
      get playState() { return this.state } }
    this.anims.push(a)
    this.ownerDocument.anims.push(a)
    return a
  }
  get offsetWidth() { return this._w != null ? this._w : 10 }
  get clientWidth() { return 600 }
  get clientHeight() { return 400 }
  get offsetHeight() { return 40 }
  get offsetTop() { return 0 }
  get offsetLeft() { return this._x || 0 }
  get offsetParent() { return null }
  getBoundingClientRect() { return { top: 0, bottom: 40, height: 40, left: 0, right: 0, width: 0 } }
  scrollTo() {}
}
// a serialisation of a subtree: tags, classes, attributes and text, in order (what the page would draw)
function dump(n) {
  if (!(n instanceof El)) return JSON.stringify(n.text)
  return '<' + n.tagName + ' ' + JSON.stringify(n.className) + ' ' + JSON.stringify(n.attrs) + ' ' + JSON.stringify(n.dataset) + ' ' + JSON.stringify(n._text) + '>' + n.children.map(dump).join('') + '</>'
}
function makeDoc(reduce) {
  const doc = {
    visibilityState: 'visible',
    activeElement: null,
    anims: [],
    createElement: (tag) => new El(doc, tag),
    createTextNode: (t) => ({ text: t }),
    addEventListener() {},
    defaultView: { matchMedia: () => ({ matches: !!reduce }), addEventListener() {}, getComputedStyle: () => ({ fontSize: '20px', width: '0', content: 'none' }) }
  }
  return doc
}
let nowMs = 0
const realPerf = globalThis.performance
Object.defineProperty(globalThis, 'performance', { value: { now: () => nowMs }, configurable: true, writable: true })
globalThis.requestAnimationFrame = () => 1
globalThis.cancelAnimationFrame = () => {}
globalThis.getComputedStyle = () => ({ textAlign: 'left' })
test.after(() => Object.defineProperty(globalThis, 'performance', { value: realPerf, configurable: true, writable: true }))

const { createLyricsView } = require('../lyrics-view')

const HELD = [
  { t: 1.0, end: 3.9, text: 'take me home tonight', words: [{ text: 'take', t: 1.0, end: 1.3 }, { text: 'me', t: 1.3, end: 1.55 }, { text: 'home', t: 1.6, end: 3.2 }, { text: 'tonight', t: 3.25, end: 3.9 }], aligned: true },
  { t: 4.0, end: 5.5, text: 'oh', words: [{ text: 'oh', t: 4.0, end: 5.5 }], aligned: true }
]
const EXPR = { version: 2, words: [
  { line: 0, word: 2, conf: 0.9, vowel: { i0: 1, i1: 2, text: 'o', t: 1.66, end: 3.1, lead: 0.06, coda: 0.04 }, loud: 0.8, loud_conf: 0.9,
    vibrato: { rate: 5.6, extent: 45, t: 2.0, end: 3.0, conf: 0.9, track: [[2.0, 5.5, 44], [2.18, 5.7, 46]] }, contour: [[1.66, 0], [2.4, 30], [3.0, -10]], contour_conf: 0.95 },
  { line: 1, word: 0, conf: 0.9, vowel: { i0: 0, i1: 1, text: 'o', t: 4.05, end: 5.4, lead: 0, coda: 0.04 }, loud: -0.2, loud_conf: 0.9 }
], vocalise: [] }

// rowW: the rows' width (px); the words sit 60 px apart, 40 px wide (the gap after a line's last word is
// what's left of the row)
function view(expr, reduce, data = {}, rowW = 1000) {
  const doc = makeDoc(reduce)
  const list = new El(doc, 'div')
  const v = createLyricsView({ container: list, layout: 'scroll', onSeek: () => {} })
  const d = Object.assign({ key: 'k1', title: 'Song', artist: 'Artist', duration: 60, lines: JSON.parse(JSON.stringify(HELD)), lang: 'en-US', aligned: true }, data)
  if (expr) d.expr = expr
  v.setData(d)
  // loop: test only
  for (const w of list.all().filter((e) => e.has('w'))) {
    const row = w.parentElement
    row._w = rowW
    w._x = row.els().filter((e) => e.has('w')).indexOf(w) * 60
    w._w = 40
    // its text layers (no offset parents here: they carry the word's place themselves)
    for (const c of w.els()) { c._x = w._x; c._w = 40 }   // loop: test only
  }
  return { doc, list, v }
}
// each call is a jump to song time t (10 s of wall time later: never inside the clock's slew, lyrics-timing syncClock)
const at = (v, t, playing = true) => { nowMs += 10000; v.setTime(t, playing, 'k1') }

test('view: without expr (the setting off, or an older engine) the lines are exactly the plain karaoke', () => {
  const a = view(null)
  const b = view(undefined, false, { expr: null })
  assert.equal(dump(a.list), dump(b.list))
  assert.doesNotMatch(dump(a.list), /"(xs|xa|xt|xv|xe|xw|xc|xi|xq|xg|xgw|xp)"|\b(xs|xa|xg|xp) /, 'no expressive class anywhere')
  // and a song whose words aren't the ones the helper measured: its lines too (only the list's own class differs)
  const c = view(X.forView(X.compact({ version: 2, words: [{ line: 0, word: 2, conf: 0.9, vowel: { i0: 1, i1: 2, text: 'a', t: 1.66, end: 3.1 } }] }), true))
  const lines = (l) => l.els().filter((e) => e.has('line')).map(dump).join('')
  assert.equal(lines(c.list), lines(a.list))
  at(a.v, 2.5)
  assert.equal(a.doc.anims.length, 0, 'nothing animates')
})

test('view: nothing is reserved in the line: a held word looks as today until its hold starts', () => {
  const plain = view(null)
  const { list } = view(X.forView(X.compact(EXPR), true))
  const lines = (l) => l.els().filter((e) => e.has('line'))
  // the line's structure and every word's regular text are the plain karaoke's; no spacer, no room
  assert.ok(!list.all().some((e) => e.has('xsw') || e.has('xsp')))
  const words = (l) => lines(l).flatMap((e) => e.all().filter((x) => x.has('w')).map((w) => w.els().find((y) => y.has('r')).textContent))
  assert.deepEqual(words(list), words(plain.list))
  assert.deepEqual(lines(list)[0].els().map((e) => e.className), lines(plain.list)[0].els().map((e) => e.className))
  const word = list.all().find((e) => e.has('xs'))
  const b = word.els().find((e) => e.has('b'))
  assert.equal(b.getAttribute('aria-hidden'), 'true')
  // the extra letters wait out of the flow (an anchor at the vowel), the bold copy's flow is the written word
  const anchor = b.all().find((e) => e.has('xa'))
  assert.ok(anchor && anchor.all().filter((e) => e.has('xe')).length === X.MAX_EXTRA)
  const flow = (n) => n.children.filter((c) => !(c instanceof El) || !c.has('xa')).map((c) => (c instanceof El ? flow(c) : c.text)).join('') + (n._text || '')
  assert.equal(flow(b), 'home')
  assert.ok(list.firstChild.has('xg'), 'the ghost layer first in the list')
  assert.equal(list.firstChild.getAttribute('aria-hidden'), 'true')
})

// the words sit 60 px apart, 40 px wide: "home" 120-160, "tonight" 180-220; popped (1.1 about 140) "home" ends at
// 162; the gap rule (0.28 em of 20 px) leaves 180 - 5.6 - 162 = 12.4 px free; a popped extra letter is 11 px
const popRight = 162
const nextLeft = 180
const GAP = 0.28 * 20
test('view: a mid-line hold stretches in place and the rest of its row slides right, keeping the gap', () => {
  const { list, v } = view(X.forView(X.compact(EXPR), true), false, {}, 1000)
  at(v, 1.8)
  const home = list.all().find((e) => e.dataset.text === 'home')
  const tonight = list.all().find((e) => e.dataset.text === 'tonight')
  const shown = home.all().filter((e) => e.has('xe') && !e.has('xh'))
  assert.equal(shown.length, X.MAX_EXTRA, 'the whole stretch, at full width')
  assert.ok(tonight.has('xn'))
  const push = parseFloat(tonight.style['--xn'])
  assert.equal(push, Math.ceil(X.MAX_EXTRA * 11 - (nextLeft - GAP - popRight)))
  assert.ok(nextLeft + push - (popRight + X.MAX_EXTRA * 11) >= GAP - 1e-9, 'the pop gap stays clear')
  assert.ok(!list.all().some((e) => e.dataset.text === 'take' && e.has('xn')), 'only the words after it move')
  // the hold ends: the sung word is back to its spelling and the row glides back
  at(v, 3.5)
  assert.equal(tonight.style['--xn'], '0px')
  assert.ok(shown.every((e) => !e.anims.some((a) => !a.cancelled)))
  const css = read('lyrics-view.css')
  assert.match(css, /\.w\.xn > \.r, \.w\.xn > \.b \{ translate: var\(--xn, 0px\) 0; transition: translate var\(--xn-t, 0\.3s ease\); \}/)
  assert.equal(tonight.style['--xn-t'], '0.3s ease 0s', 'glides back over 0.3 s')
  // the slide keeps pace with the letters: from when they reach the gap to the hold's end, linear
  const t = X.nudgeTiming(1.66, 1.44, 12.4, 55, 1.8)
  assert.ok(Math.abs(t.delay - (1.66 + 1.44 * 12.4 / 55 - 1.8)) < 1e-9)
  assert.ok(Math.abs(t.duration - 1.44 * (1 - 12.4 / 55)) < 1e-9)
  assert.equal(X.nudgeTiming(1.66, 1.44, 12.4, 55, 3.0).delay, 0, 'a seek into the hold: what is left')
})

test('view: the slide is capped at the row\'s edge (nothing overflows or wraps); a line-end word stretches outward', () => {
  // the row ends 18 px after "tonight": the letters get the gap + 18 px, squeezed, and the row slides at most 18 px
  const { list, v } = view(X.forView(X.compact(EXPR), true), false, {}, 240)
  at(v, 1.8)
  const tonight = list.all().find((e) => e.dataset.text === 'tonight')
  const push = parseFloat(tonight.style['--xn'] || '0')
  assert.ok(push <= 240 - 220 - 2 + 1e-9, 'the row\'s last word stays inside: ' + push)
  const home = list.all().find((e) => e.dataset.text === 'home')
  assert.ok(home.all().filter((e) => e.has('xe') && !e.has('xh')).length >= 1)
  // the row already ends at its last word: nothing slides right; the words already sung make the room (below)
  const tight = view(X.forView(X.compact(EXPR), true), false, {}, 222)
  at(tight.v, 1.8)
  assert.equal(tight.list.all().find((e) => e.dataset.text === 'tonight').style['--xn'], undefined)
  // "oh", alone on its row: nothing to slide, it stretches outward into the row
  const end = view(X.forView(X.compact(EXPR), true), false, {}, 1000)
  at(end.v, 4.3)
  const oh = end.list.all().find((e) => e.dataset.text === 'oh')
  assert.ok(oh.all().filter((e) => e.has('xe') && !e.has('xh')).length > 0)
  assert.ok(!end.list.all().some((e) => e.has('xn') && e.style['--xn'] !== '0px' && e.dataset.text !== 'tonight'))
  assert.deepEqual(X.squeezePlan(5, 30, 10, 1.1), { n: 5, scale: 0.545 })
  assert.equal(X.nudgePx(5, 10, 1, 1.1, 12.4), 43)
  assert.equal(X.nudgePx(0, 10, 1, 1.1, 12.4), 0)
})

// Room from the left (Marcy 2026-10-19, "push the already sung words off the screen to the left"), per
// alignment: free space first, then the words already sung (and the held word) slide out of the way; the
// words not yet sung never move left of their place; back in 0.3 s when the hold ends.
// off: where the row's words start (0 left-aligned; centred and right-aligned (duet) rows start further in)
function placed(rowW, off) {
  const r = view(X.forView(X.compact(EXPR), true), false, {}, rowW)
  const row = r.list.all().find((e) => e.dataset.text === 'take').parentElement
  // loop: test only
  for (const w of row.els().filter((e) => e.has('w'))) { w._x += off; for (const c of w.els()) c._x = w._x }   // loop: test only
  return r
}
const NEED = Math.ceil(X.MAX_EXTRA * 11 - (nextLeft - GAP - popRight))   // what the 5 letters need beyond the gap
const word = (l, t) => l.all().find((e) => e.dataset.text === t)
const xn = (l, t) => parseFloat(word(l, t).style['--xn'] || '0')
const fullStretch = (l) => {
  const home = word(l, 'home')
  const shown = home.all().filter((e) => e.has('xe') && !e.has('xh'))
  assert.equal(shown.length, X.MAX_EXTRA, 'the whole stretch shows')
  assert.ok(shown.every((e) => e.anims.some((a) => !a.cancelled && /scaleX\(1\)$/.test(a.keyframes[a.keyframes.length - 1].transform))), 'at full width, not squeezed')
}
for (const [name, rowW, off, right] of [
  ['left-aligned, the row full to its right edge', 222, 0, 0],
  ['right-aligned (a duet\'s second voice)', 1000, 1000 - 220, 0],
  ['centred, a little room on the right', 260, 20, 18]
]) {
  test('view: room from the left, ' + name + ': the sung words slide left by exactly the shortfall', () => {
    const { list, v } = placed(rowW, off)
    at(v, 1.8)
    fullStretch(list)
    assert.equal(xn(list, 'tonight'), right, 'the unsung word after it: right only into free space')
    const left = NEED - right
    assert.equal(xn(list, 'take'), -left)
    assert.equal(xn(list, 'me'), -left)
    assert.ok(Math.abs(xn(list, 'home') * 1.1 + left) < 0.1, 'the held word too, in its popped scale: ' + xn(list, 'home'))
    assert.ok(word(list, 'take').has('xn') && word(list, 'home').has('xn'))
    // the hold ends: everything glides back in 0.3 s
    at(v, 3.5)
    // loop: test only
    for (const t of ['take', 'me', 'home', 'tonight']) {
      if (!word(list, t).has('xn')) continue
      assert.equal(word(list, t).style['--xn'], '0px', t)
      assert.equal(word(list, t).style['--xn-t'], '0.3s ease 0s', t)
    }
  })
}

test('view: room from the left: free space first, the held word stays in view, reduced motion moves nothing', () => {
  // enough room on the right: nothing sung moves
  const wide = placed(1000, 0)
  at(wide.v, 1.8)
  assert.equal(xn(wide.list, 'take'), 0)
  assert.ok(xn(wide.list, 'tonight') > 0)
  // the held word near the row's left edge: the left slide stops at its edge (it stays in view), then squeezed
  const edge = view(X.forView(X.compact(EXPR), true), false, {}, 222)
  const row = edge.list.all().find((e) => e.dataset.text === 'take').parentElement
  // loop: test only
  for (const [i, w] of row.els().filter((e) => e.has('w')).entries()) { w._x = [0, 0, 22, 82][i]; for (const c of w.els()) c._x = w._x }   // loop: test only
  at(edge.v, 1.8)
  assert.ok(xn(edge.list, 'home') * 1.1 >= -20 - 1e-9, 'never past its own left edge: ' + xn(edge.list, 'home'))
  // reduced motion: no slide at all
  const still = view(X.forView(X.compact(EXPR), true), true, {}, 222)
  at(still.v, 1.8)
  assert.ok(!still.list.all().some((e) => e.has('xn')))
  assert.deepEqual(X.splitPush(43, 18, 100), { right: 18, left: 25 })
  assert.deepEqual(X.splitPush(43, 50, 100), { right: 43, left: 0 })
  assert.deepEqual(X.splitPush(43, 0, 10), { right: 0, left: 10 })
  // the right slide hands over to the left one: back to back through the hold
  const r = X.nudgeTiming(1.66, 1.44, 12.4, 55.4, 1.0, 30.4)
  const l = X.nudgeTiming(1.66, 1.44, 30.4, 55.4, 1.0)
  assert.ok(Math.abs(r.delay + r.duration - l.delay) < 1e-9)
  assert.ok(Math.abs(l.delay + l.duration - (1.66 + 1.44 - 1.0)) < 1e-9)
})

// the letters a stretching word shows, in order: its bold copy without the unborn (.xh) letters
const shownText = (n) => n._text + n.children.map((c) => (c instanceof El ? (c.has('xh') ? '' : shownText(c)) : c.text)).join('')
for (const [text, vowel] of [['now,', 'o'], ['me,', 'e'], ['home', 'o']]) {
  test('view: a stretching "' + text + '" reads as one word: the extra letters at the vowel, the coda and its punctuation once', () => {
    const lines = [{ t: 1.0, end: 3.9, text: 'at ' + text + ' go', words: [{ text: 'at', t: 1.0, end: 1.5 }, { text, t: 1.6, end: 3.2 }, { text: 'go', t: 3.25, end: 3.9 }], aligned: true }]
    const expr = { version: 2, words: [{ line: 0, word: 1, conf: 0.9, vowel: { i0: 1, i1: 2, text: vowel, t: 1.66, end: 3.1, lead: 0.06, coda: 0.04 }, loud: 0.8, loud_conf: 0.9 }], vocalise: [] }
    const { list, v } = view(X.forView(X.compact(expr), true), false, { lines }, 1000)
    at(v, 1.8)
    const w = word(list, text)
    const b = w.els().find((e) => e.has('b'))
    const k = b.all().filter((e) => e.has('xe') && !e.has('xh')).length
    assert.ok(k > 0)
    assert.equal(shownText(b), text[0] + vowel.repeat(1 + k) + text.slice(2))
    assert.equal(w.els().find((e) => e.has('r')).textContent, text, 'the regular copy: as written (hidden while sung)')
    // the HDR glow's still mask of the written word steps aside while the letters show (it drew "now,oow,")
    assert.ok(w.has('xo'))
    at(v, 3.5)
    assert.ok(!w.has('xo'))
  })
}
test('css: the HDR glow steps aside over a stretched word', () => {
  assert.match(read('lyrics-view.css'), /\.w\.xo \.hdr-glow \{ opacity: 0; \}/)
})

test('view: the stretch and the ghost play in step with the song, pause with it and while hidden, and end', () => {
  const { doc, list, v } = view(X.forView(X.compact(EXPR), true))
  at(v, 1.2)
  assert.equal(doc.anims.length, 0, 'before the held word: nothing')
  at(v, 1.8)
  const ghostly = (a) => a.el.has('xgw') || a.el.has('xgl')
  const stretch = doc.anims.filter((a) => !a.cancelled && !ghostly(a))
  assert.ok(stretch.length >= 6, 'the letters, the coda and the waves')
  assert.ok(stretch.every((a) => a.playState === 'running'))
  assert.ok(stretch.every((a) => Math.abs(a.currentTime - (1.8 - (1.6 - 0.05)) * 1000) < 61), 'in song time from when the word lit')
  const ghost = list.firstChild.els()
  assert.equal(ghost.length, 1, 'a 1.4 s hold ghosts')
  assert.equal(ghost[0].textContent[0], 'o')
  at(v, 2.2, false)
  assert.ok(doc.anims.filter((a) => !a.cancelled).every((a) => a.playState === 'paused'), 'paused with the song')
  doc.visibilityState = 'hidden'
  at(v, 2.3, true)
  assert.ok(doc.anims.filter((a) => !a.cancelled).every((a) => a.playState === 'paused'), 'paused while hidden')
  doc.visibilityState = 'visible'
  at(v, 2.4)
  assert.ok(doc.anims.filter((a) => !a.cancelled).every((a) => a.playState === 'running'))
  at(v, 3.4)
  assert.ok(stretch.every((a) => a.cancelled), 'the stretch ends with its word')
  at(v, 6.0)
  assert.equal(list.firstChild.els().length, 0, 'the ghost dissolved and is gone')
  assert.ok(doc.anims.every((a) => a.cancelled), 'nothing left running')
  // loop: test only
  for (const a of doc.anims) assert.ok(a.keyframes.every((f) => Object.keys(f).every((k) => KEYS.has(k))))
  at(v, 1.8)
  assert.ok(doc.anims.some((a) => !a.cancelled))
  v.setData({ key: 'k2', title: 'Next', artist: 'A', duration: 60, lines: [], lang: 'en-US' })
  assert.ok(doc.anims.every((a) => a.cancelled), 'a new song cancels whatever plays')
})

test('view: never a style write on the line while playing but the nudge (the ghost places only itself)', () => {
  const { list, v } = view(X.forView(X.compact(EXPR), true))
  const before = new Map(list.all().map((e) => [e, e.styleSets.length]))
  at(v, 1.8)
  at(v, 2.5)
  // the karaoke's own writes (paintWords' origin, popRoom's cap) are allowed; Expressive words adds none to the line
  const OWN = new Set(['transformOrigin', '--pop-max'])
  const wrote = list.all().filter((e) => before.has(e)).flatMap((e) => e.styleSets.slice(before.get(e)).filter((k) => !OWN.has(k)).map((k) => [e.dataset.text || e.className, k]))
  // the one write Expressive words makes on the line: the row's later word's nudge, once at the hold's start
  assert.deepEqual(wrote, [['tonight', '--xn-t'], ['tonight', '--xn']])
})

test('view: the ghost sits in the free space beside the sung line, large and far back', () => {
  const { list, v } = view(X.forView(X.compact(EXPR), true))
  at(v, 1.8)
  const g = list.firstChild.els()[0]
  assert.ok(parseFloat(g.style.fontSize) >= 3 * 20 && parseFloat(g.style.fontSize) <= 5 * 20)
  assert.match(g.style.top, /^\d+px$/)
  assert.match(g.style.left, /^\d+px$/)
})

test('view: wordless vocalise: a neutral "ooo" ghost only where no lyric word covers it, behind its own switch', () => {
  const expr = Object.assign({}, EXPR, { vocalise: [{ t: 0.0, end: 0.75, midi: 64, conf: 0.8 }, { t: 1.2, end: 2.6, midi: 64, conf: 0.9 }, { t: 6.0, end: 6.3, midi: 64, conf: 0.9 }] })
  const c = X.compact(expr)
  assert.equal(c.voc.length, 3)
  assert.deepEqual(X.forView(c, true, false).voc, [], 'the sub-switch off: none')
  const m = X.vocaliseExpressions(X.forView(c, true, true), HELD)
  assert.equal(m.length, 1, 'one held long enough and on no word (one is under "take me home", one too short)')
  assert.equal(m[0].ghost.base, 'oo')
  const { list, v } = view(X.forView(c, true, true))
  at(v, 0.2)
  const g = list.firstChild.els()
  assert.equal(g.length, 1)
  assert.match(g[0].textContent, /^o{3,}$/)
})

test('view: reduced motion: no drift, no wave, no growth: the stretched spelling at once, the ghost fades only', () => {
  const { doc, list, v } = view(X.forView(X.compact(EXPR), true), true)
  at(v, 1.8)
  const word = list.all().find((e) => e.has('xs'))
  assert.ok(word.has('xr'), 'the stretched spelling, still')
  assert.ok(!list.all().some((e) => e.has('xn')), 'reduced motion: the row doesn\'t move')
  const live = doc.anims.filter((a) => !a.cancelled)
  const still = (a) => new Set(a.keyframes.map((f) => f.transform)).size <= 1
  assert.ok(live.length && live.every((a) => (a.el.has('xgw') || a.el.has('xgl')) && still(a)), 'only the ghost\'s fade: ' + live.map((a) => a.el.className))
  assert.ok(!live.some((a) => a.keyframes.some((f) => /translateX/.test(f.transform || ''))), 'no drift')
  at(v, 3.4)
  assert.ok(!word.has('xr'))
})

test('render path: the expressive styles animate nothing themselves and the pop rules are untouched', () => {
  const css = read('lyrics-view.css')
  const part = css.slice(css.indexOf('/* Expressive words'), css.indexOf('/* prefers-reduced-motion'))
  assert.ok(part.length > 200)
  assert.doesNotMatch(part.replace(/transition: translate var\(--xn-t, 0\.3s ease\);/, ''), /transition|animation|@keyframes/, 'only the row nudge\'s translate transition')
  assert.doesNotMatch(part, /\.s\.now|\.w\.now \{|scale\(/, 'the pop is not restyled')
  assert.match(css, /\.line\.active \.w\.now \{\n  opacity: 1;\n  color: var\(--sing\);\n  transform: scale\(min\(1\.1, var\(--pop-max, 1\.1\)\)\);/)
  assert.match(css, /\.line\.active \.w\.now \.s\.now \{ transform: translateY\(-0\.24em\) scale\(min\(1\.12, var\(--pop-max, 1\.12\)\)\);/)
  assert.doesNotMatch(read('lyrics-view.js').slice(read('lyrics-view.js').indexOf('function startStretch')), /transformOrigin/, 'the pop\'s origin stays popRoom\'s')
  assert.match(part, /color: var\(--s-ghost\)/, 'the ghost colour is the theme\'s token')
})

// --- main and the helper ---

test('main: expr is sent only when Expressive words is on and kept for these lyrics', () => {
  const src = read('main.js')
  assert.match(src, /function expressiveSetting\(\) \{ return settings\.expressiveWords == null \? expressive\.defaultOn\(app\.getVersion\(\)\) : !!settings\.expressiveWords \}/)
  assert.match(src, /function expressiveOn\(\) \{ return expressiveSetting\(\) && preciseTimingOn\(\) \}/)
  assert.match(src, /const e = on \? getSheetStore\(\)\.get\(title, artist\) : null/)
  assert.match(src, /const view = entry \? expressive\.forView\(entry\.expr, true, vocaliseSetting\(\)\) : now \? expressive\.forView\(now, true, vocaliseSetting\(\)\) : null/)
  // a first play's sections only while no learned entry exists for these lyrics (firstPlaySection)
  assert.match(src, /const fp = firstPlayOf\(key, alignSessionLib\.lyricsHash\(lines \|\| \[\]\)\)\n\s+const now = !entry && on && fp && fp\.expr \? fp\.expr : null/)
  assert.match(src, /if \(expr\) data\.expr = expr\n\s+sendLyrics\('lyrics-data', data\)/)
  assert.match(src, /want: \(\) => \(expressiveOn\(\) \? \['expr'\] : \[\]\)/)
  assert.equal(require('../settings-store').defaults().expressiveWords, null)
  assert.ok(require('../settings-store').validSetting('expressiveWords', true) && require('../settings-store').validSetting('expressiveWords', null))
  assert.ok(!require('../settings-store').validSetting('expressiveWords', 'on'))
  const ui = read('panel-ui.js')
  assert.match(ui, /switchRow\('expressiveWords', 'Expressive words'/)
  assert.ok(JSON.parse(read('package.json')).build.files.includes('lyrics-expressive.js'))
})

const FIXTURE = { home: '/tmp/sonata-align-test-home', python: '/bin/sh', server: path.join(__dirname, 'fixtures', 'fake-align-helper.sh') }
function waitFor(cond, ms = 3000) {
  const t0 = Date.now()
  return new Promise((resolve, reject) => {
    // loop: test poll · 20 ms · until cond or ms
    const iv = setInterval(() => { if (cond()) { clearInterval(iv); resolve() } else if (Date.now() - t0 > ms) { clearInterval(iv); reject(new Error('timeout')) } }, 20)
  })
}
const APPLE = [{ t: 0.5, end: 2.5, text: 'oh home', words: [{ text: 'oh', t: 0.5, end: 1.4 }, { text: 'home', t: 1.5, end: 2.5 }] }]

for (const [features, asks] of [['notes,pitch,given-notes,expr', true], ['notes,pitch,given-notes', false]]) {
  test('helper: a notes job asks for "expr" only when the helper serves it (features: ' + features + ')', async () => {
    const h = H.createAlignHelper({ paths: FIXTURE, env: Object.assign({}, process.env, { FAKE_NODE: process.execPath, FAKE_MODE: '', FAKE_FEATURES: features }), want: () => ['expr'], log: () => {} })
    try {
      const pcm = Buffer.alloc(22050 * 4)
      await h.separate('g1', A.separateMessages('g1', pcm, { song: 's1', offset: 0 }))
      const syl = A.givenSyllables(APPLE, null)
      const res = await h.givenNotes('n1', A.givenNotesMessages('n1', 's1', APPLE, syl, null))
      assert.deepEqual(res.stats.want, asks ? ['expr'] : null, 'an older engine gets today\'s request')
      assert.equal(!!res.notes.expr, asks)
      assert.equal(h.serves('expr'), asks)
      if (asks) {
        const c = X.compact(res.notes.expr)
        assert.equal(c.v, 2)
        assert.ok(c.words.length >= 1)
      }
    } finally {
      h.stop()
      await waitFor(() => !h.running)
    }
  })
}

test('helper: nothing wanted (Expressive words off): no ping first, no want', async () => {
  const h = H.createAlignHelper({ paths: FIXTURE, env: Object.assign({}, process.env, { FAKE_NODE: process.execPath, FAKE_MODE: '' }), want: () => [], log: () => {} })
  try {
    const pcm = Buffer.alloc(22050 * 4)
    await h.separate('g1', A.separateMessages('g1', pcm, { song: 's1', offset: 0 }))
    const res = await h.givenNotes('n1', A.givenNotesMessages('n1', 's1', APPLE, A.givenSyllables(APPLE, null), null))
    assert.equal(res.stats.want, null)
    assert.equal(h.serves('expr'), false, 'never pinged')
  } finally {
    h.stop()
    await waitFor(() => !h.running)
  }
  assert.deepEqual(H.wantFor(['expr'], ['notes']), null)
  assert.deepEqual(H.wantFor(['expr'], ['expr', 'notes']), ['expr'])
  assert.equal(H.wantFor(['expr'], null), null)
})

// --- 0.15.54: Expressive words reach real songs (Marcy on 0.15.52-dev.1 saw not one) ---

test('summary / statusLine: one log line per song says what it shows, or why nothing', () => {
  const expr = { format: 1, v: 2, words: [{ l: 0, w: 0, c: 0.8, i0: 1, i1: 2, t: 1, e: 1.7 }, { l: 0, w: 1, c: 0.8, i0: 1, i1: 2, t: 3, e: 4.2 }, { l: 1, w: 0, c: 0.8, ld: 0.4 }], voc: [{ t: 9, e: 10.5, c: 0.7 }] }
  assert.deepEqual(X.summary(expr), { held: 2, ghosts: 2, v: 2 })
  assert.equal(X.statusLine({ on: true, helper: 'serves', entry: { expr }, title: 'S' }), 'expressive: 2 held notes, 2 ghosts for "S" (expr v2)')
  assert.match(X.statusLine({ on: false, title: 'S' }), /^expressive: none for "S" \(Expressive words or Precise word timing is off\)/)
  assert.match(X.statusLine({ on: true, helper: 'lacks', entry: { notes: [] }, title: 'S' }), /does not measure expression/)
  assert.match(X.statusLine({ on: true, helper: 'unknown', entry: null, title: 'S' }), /has not answered yet/)
  assert.match(X.statusLine({ on: true, helper: 'serves', entry: { notes: [] }, title: 'S' }), /no audio yet: measured from this play/)
  assert.match(X.statusLine({ on: true, helper: 'serves', entry: { expr: null }, title: 'S' }), /measured nothing confident/)
  assert.match(X.statusLine({ on: true, helper: 'serves', entry: { expr: { format: 1, v: 2, words: [{ l: 0, w: 0, t: 1, e: 1.2 }], voc: [] } }, title: 'S' }), /nothing held long enough/)
})

test('main: the expression is kept only when the helper was asked for it, logged once per song and when measured', () => {
  const src = read('main.js')
  assert.match(src, /const asked = expressiveOn\(\) && !!alignHelper && alignHelper\.serves\('expr'\)\n\s+if \(asked\) \{\n\s+entry\.expr = expressive\.compact\(result\.notes\.expr, lineOffset\)/)
  assert.match(src, /console\.log\('align: ' \+ expressive\.statusLine\(\{ on, helper, entry, title \}\)\)/)
  assert.match(src, /expressiveFor\(state\.title, state\.artist, plain \? prep\.lines : base, key\)/)
  // a song whose notes came without expression is asked again (missing) while the engine serves it, or
  // before this run's helper answered (a first play after a restart used to be skipped, 0.15.57)
  assert.match(src, /expressiveOn\(\) && alignHelper && \(!alignHelper\.answered \|\| alignHelper\.serves\('expr'\)\) && expressiveMissing\(title, artist, hash\)/)
})

test('view: a song whose only expression is wordless vocalise still gets it', () => {
  const src = read('lyrics-view.js')
  assert.match(src, /data\.expr\.words\.length \|\| \(Array\.isArray\(data\.expr\.voc\) && data\.expr\.voc\.length\)/)
})

// --- the lyrics view's Expressive words line (0.15.57: Sonata said nothing while it couldn't draw) ---

test('noteFor: why Expressive words does not draw yet, in the order a person fixes it, each ≤ 60 characters with its ⓘ', () => {
  const ready = { on: true, installed: true, precise: true, helper: 'serves', entry: 'missing', job: '' }
  const at = (o) => X.noteFor(Object.assign({}, ready, o))
  assert.equal(X.noteFor(null), null)
  assert.equal(at({ on: false, installed: false }), null, 'off: nothing to say')
  assert.equal(at({ entry: 'drawn', job: 'measuring' }), null, 'it draws: nothing to say')
  assert.equal(at({}), null, 'nothing recorded for it (no timed lyrics): nothing to say')
  const cases = [
    [{ installed: false, precise: false }, 'Expressive words needs the Precise timing helper', 'install'],
    [{ installing: true, installed: false }, 'Expressive words: the helper is being installed…', 'show'],
    [{ update: true, installed: false }, 'Expressive words needs a newer helper', 'show'],
    [{ precise: false }, 'Expressive words: Precise word timing is off', 'show'],
    [{ helper: 'lacks' }, 'Expressive words needs a newer helper', 'show'],
    [{ pitch: 'downloading', job: 'recording' }, 'Expressive words: downloading the pitch model…', ''],
    [{ pitch: 'failed', pitchWhy: 'offline' }, 'Expressive words: the pitch model didn’t download', ''],
    [{ entry: 'none', job: 'recording' }, 'Expressive words: nothing held long enough in this song', ''],
    [{ job: 'measuring' }, 'Expressive words: measuring this song…', ''],
    [{ job: 'recording' }, 'Expressive words: measured once this song has played through', '']
  ]
  for (const [o, text, action] of cases) {   // loop: NOT-WORTH — test cases
    const n = at(o)
    assert.equal(n.text, text)
    assert.equal(n.action, action)
    assert.ok(n.text.length <= require('../info-tip').TEXT_MAX, n.text)
    assert.ok(n.info.length > n.text.length, 'the ⓘ explains: ' + n.text)
  }
  assert.match(at({ pitch: 'failed', pitchWhy: 'offline' }).info, /^offline\. Turn Expressive words off and on/)
  assert.equal(at({ paused: true, job: 'recording' }), null, 'a game runs: the timing note says so')
})

test('main: the Expressive words line is sent on change, its button opens Settings → Precise timing; the pitch model is fetched once a song shows', () => {
  const src = read('main.js')
  assert.match(src, /if \(state\.title\) sendExprNote\(key\)/)
  assert.match(src, /sendLyrics\('lyrics-data', data\)\n\s+exprNoteSent = ''/)
  assert.match(src, /if \(precise\) ensureNotesModel\(\)/)
  assert.match(src, /command === 'expressive'\) showPanel\('settings', 'timing'\)/)
  assert.match(src, /job: alignSession && preciseTimingOn\(\) \? alignSession\.notesState\(key\) : ''/)
  // a missing pitch model is remembered for Expressive words too, and never marks the song as failed
  assert.match(src, /if \(code === 'no-model' && notesSwitch\) notesSwitch\.learn\(\{ note_models: \{ rmvpe: false \} \}\)\n\s+if \(!settings\.sungNotesLog && !settings\.sheetNotes\) return/)
  assert.match(src, /if \(code !== 'paused' && code !== 'no-model' && code !== 'dropped'\)/)
  // the measured song on screen gets its lyrics again, with the expression, in the same play
  assert.match(src, /if \(entry\.expr && lyricsKey === s\.key\) lyricsKey = null/)
  const html = read('lyrics.html')
  assert.match(html, /ipcRenderer\.on\('lyrics-expr-note', \(event, note\) => view\.exprNote\(note\)\)/)
  assert.match(html, /onExpressive: \(\) => ipcRenderer\.send\('lyrics-command', 'expressive'\)/)
})

test('lineExpressions: both held "mind," of one line stretch, also when the lyrics\' own word time ends before the sung vowel starts (Marcy, Monday Morning)', () => {
  const W = (t, end, text) => ({ t, end, text })
  // Apple's word times lead the singing by ~0.4 s and end early; each "mind," is held ~1 s
  const words = [W(50, 50.3, 'But'), W(50.3, 50.5, 'I'), W(50.5, 50.8, 'don\'t'), W(50.8, 51.1, 'mind,'), W(52.2, 52.4, 'I'), W(52.4, 52.7, 'don\'t'), W(52.7, 53.0, 'mind,'), W(55.5, 56, 'yeah')]
  const held = (w, t, e) => ({ l: 4, w, c: 0.8, i0: 1, i1: 2, t, e, x: 'i' })
  const doc = { format: X.FORMAT, v: 2, words: [held(3, 51.2, 52.1), held(6, 53.4, 54.4)], voc: [] }   // the second vowel starts 0.4 s after its word's end
  const got = X.lineExpressions(doc, 4, words)
  assert.deepEqual(got.map((g) => g.i), [3, 6], 'each "mind," gets its own (line, word) expression')
  assert.ok(got.every((g) => g.m.stretch && g.m.extra > 0 && g.m.ghost), 'both stretch and ghost')
  // a vowel that starts after the next word started is not this word's
  assert.equal(X.lineExpressions({ format: X.FORMAT, v: 2, words: [held(3, 52.6, 53.4)], voc: [] }, 4, words).length, 0)
})

test('view: a stretch lasts while its measured vowel sounds, past the lyrics\' own word end; it starts then too', () => {
  const src = read('lyrics-view.js')
  assert.match(src, /const sounding = wt != null && time >= wt && time < m\.ve/)
  assert.match(src, /\(lit \|\| sounding\) && time <= m\.ve \+ 0\.3/)
  assert.match(src, /\(!x\.span\.classList\.contains\('now'\) && time > x\.ve\)/)
})

// --- first play: the expression measured section by section (0.15.66, lyrics-view.js express) ---

test('view, first play: a section\'s expression is applied only at line boundaries, never into the line being sung', () => {
  const { list, v } = view(null)
  const lines = () => list.els().filter((e) => e.has('line'))
  at(v, 2.0)                                     // line 0 sung ("home")
  const sung = dump(lines()[0])
  v.express({ key: 'k1', expr: X.forView(X.compact(EXPR), true), final: false })
  assert.equal(dump(lines()[0]), sung, 'the line being sung is untouched')
  at(v, 2.5)
  assert.equal(dump(lines()[0]), sung, 'still untouched while it is sung')
  assert.ok(!lines()[1].all().some((e) => e.has('xs')), 'nothing applied before the boundary')
  at(v, 4.2)                                     // the boundary: line 1 lit, line 0 behind
  assert.ok(lines()[0].all().some((e) => e.has('xs')), 'the line that is no longer sung takes its expression')
  assert.ok(!lines()[1].all().some((e) => e.has('xs')), 'the line now sung waits')
  at(v, 1.2)                                     // the next boundary (a seek back: line 0 lit again)
  assert.ok(lines()[1].all().some((e) => e.has('xs')), 'and takes it at the next boundary')
  assert.ok(list.has('xp'))
})

test('view, first play: the whole-song pass replaces the sections\' expression without a visible change', () => {
  const { list, v } = view(null)
  const lines = () => list.els().filter((e) => e.has('line'))
  v.express({ key: 'k1', expr: X.forView(X.compact(EXPR), true), final: false })   // nothing lit: applied at once
  const nodes = () => lines().flatMap((l) => l.all())
  const before = nodes()
  // the same measurement from the final pass: not one node of the lines is rebuilt
  v.express({ key: 'k1', expr: X.forView(X.compact(EXPR), true), final: true })
  at(v, 2.0)
  at(v, 4.2)
  const after = nodes()
  assert.equal(after.length, before.length)
  assert.ok(after.every((n, k) => n === before[k]), 'the same nodes: nothing visible changed')
  // a different final measurement: only lines off screen are swapped; one on screen waits until it scrolls away
  const changed = JSON.parse(JSON.stringify(EXPR))
  changed.words[1].loud = 0.9
  at(v, 6.0)
  const l1 = lines()[1]
  const shown = dump(l1)
  v.express({ key: 'k1', expr: X.forView(X.compact(changed), true), final: true })
  assert.equal(dump(l1), shown, 'on screen: unchanged')
  l1.getBoundingClientRect = () => ({ top: 900, bottom: 940, height: 40, left: 0, right: 0, width: 0 })
  at(v, 1.2)                                     // a boundary with the line off screen
  assert.notEqual(dump(lines()[1]), shown, 'swapped once off screen')
  assert.ok(lines()[1].all().some((e) => e.has('xi')), 'the final pass\'s louder word')
})

test('view: another song\'s expression is ignored; a new song drops one still waiting', () => {
  const { list, v } = view(null)
  v.express({ key: 'other', expr: X.forView(X.compact(EXPR), true), final: false })
  assert.ok(!list.all().some((e) => e.has('xs')))
})

test('noteFor: while the sections\' expression flows the line says it measures as it plays (not "once played through")', () => {
  const base = { on: true, installed: true, precise: true, helper: 'serves', entry: 'drawn', job: 'sections' }
  assert.equal(X.noteFor(base).text, 'Expressive words: measuring as it plays')
  assert.equal(X.noteFor(Object.assign({}, base, { entry: 'missing' })).text, 'Expressive words: measuring as it plays')
  assert.equal(X.noteFor(Object.assign({}, base, { job: '' })), null)
  assert.equal(X.noteFor(Object.assign({}, base, { job: 'sections', paused: true })), null)
})

// QC 2026-10 #7: a replay (or a section measured again) never stacks its vocalise on the old spans
test('mergeSection: a section\'s words replace its lines\' words, its vocalise replaces the spans it overlaps', () => {
  const E = require('../lyrics-expressive')
  const a = { format: 1, v: 2, words: [{ l: 0, w: 0, t: 1 }, { l: 1, w: 0, t: 5 }], voc: [{ t: 10, e: 12 }, { t: 30, e: 31 }] }
  const b = { format: 1, v: 2, words: [{ l: 1, w: 0, t: 5.1 }], voc: [{ t: 10.1, e: 12.2 }] }
  const m = E.mergeSection(a, b)
  assert.deepEqual(m.words.map((w) => [w.l, w.t]), [[0, 1], [1, 5.1]])
  assert.deepEqual(m.voc, [{ t: 10.1, e: 12.2 }, { t: 30, e: 31 }])
  assert.deepEqual(E.mergeSection(m, b).voc, m.voc, 'merging the same section again changes nothing')
  assert.equal(E.mergeSection(null, b).words.length, 1)
  assert.equal(E.mergeSection(a, null), a)
})

test('main: a first play\'s state is one play\'s (song id and lyrics hash), never an earlier play\'s', () => {
  const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'main.js'), 'utf8')
  assert.match(src, /firstPlay\.play !== s\.id \|\| firstPlay\.hash !== s\.hash\) firstPlay = firstPlayFor\(s\)/)
  assert.match(src, /firstPlay\.expr = expressive\.mergeSection\(firstPlay\.expr, add\)/)
})

// QC 2026-10 #8: an expression that arrives while a vocalise ghost plays still brings its own vocalise
test('view, first play: new vocalise that arrives while a ghost plays shows once that ghost ends', () => {
  const first = Object.assign({}, EXPR, { vocalise: [{ t: 0.0, end: 0.75, midi: 64, conf: 0.8 }] })
  const { list, v } = view(X.forView(X.compact(first), true, true))
  at(v, 0.2)                                     // the opening "ooo" ghosts
  assert.equal(list.firstChild.els().length, 1)
  const next = Object.assign({}, EXPR, { vocalise: [{ t: 0.0, end: 0.75, midi: 64, conf: 0.8 }, { t: 6.0, end: 7.5, midi: 64, conf: 0.9 }] })
  v.express({ key: 'k1', expr: X.forView(X.compact(next), true, true), final: true })
  at(v, 1.2)                                     // the ghost is over
  at(v, 6.2)                                     // the new span, on no lyric word (the old ghost ends this frame)
  at(v, 6.4)                                     // the next frame
  const ghosts = list.firstChild.els().filter((g) => /^o{3,}$/.test(g.textContent))   // loop: NOT-WORTH — a test
  assert.ok(ghosts.length >= 1, 'the new vocalise ghosts')
})
