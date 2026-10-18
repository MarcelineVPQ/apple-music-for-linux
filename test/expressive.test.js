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
      get(o, k) { if (k === 'setProperty') return (n) => self.styleSets.push(n); if (k === 'removeProperty') return () => {}; return o[k] },
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
  { t: 1.0, end: 3.2, text: 'take me home', words: [{ text: 'take', t: 1.0, end: 1.3 }, { text: 'me', t: 1.3, end: 1.55 }, { text: 'home', t: 1.6, end: 3.2 }], aligned: true },
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
  }
  return { doc, list, v }
}
const at = (v, t, playing = true) => { nowMs += 1000; v.setTime(t, playing, 'k1') }

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

test('view: the stretch grows only into the gap the pop leaves; already-sung words are back to their spelling', () => {
  // plenty of room after "home": all its extra letters; a tight row: all of them squeezed into the gap (38 px for
  // 5 popped letters of 11 px: 0.69 of their width); tighter: as many as fit at the narrowest squeeze; none: none
  for (const [rowW, want, squeezed] of [[1000, X.MAX_EXTRA, false], [200, X.MAX_EXTRA, true], [175, 2, true], [165, 0, false]]) {
    const { list, v } = view(X.forView(X.compact(EXPR), true), false, {}, rowW)
    at(v, 1.8)
    const xe = list.all().find((e) => e.has('xs')).all().filter((e) => e.has('xe'))
    const shown = xe.filter((e) => !e.has('xh'))
    assert.equal(shown.length, want, 'row ' + rowW)
    const last = shown.length ? shown[shown.length - 1].anims[0].keyframes.slice(-1)[0].transform : ''
    assert.equal(/scaleX\(0\.|scaleX\(0\.4\)/.test(last), squeezed, 'row ' + rowW + ': ' + last)
    at(v, 3.5)
    assert.ok(xe.every((e) => !e.has('xh') && !e.anims.some((a) => !a.cancelled)), 'after the hold: as written')
  }
  assert.deepEqual(X.squeezePlan(5, 38, 10, 1.1), { n: 5, scale: 0.69 })
  assert.deepEqual(X.squeezePlan(5, 13, 10, 1.1), { n: 2, scale: 0.4 })
  assert.deepEqual(X.squeezePlan(5, 100, 10, 1.1), { n: 5, scale: 1 })
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

test('view: never a style write on the line while playing (the ghost places only itself)', () => {
  const { list, v } = view(X.forView(X.compact(EXPR), true))
  const before = new Map(list.all().map((e) => [e, e.styleSets.length]))
  at(v, 1.8)
  at(v, 2.5)
  // the karaoke's own writes (paintWords' origin, popRoom's cap) are allowed; Expressive words adds none to the line
  const OWN = new Set(['transformOrigin', '--pop-max'])
  const wrote = list.all().filter((e) => before.has(e)).flatMap((e) => e.styleSets.slice(before.get(e)).filter((k) => !OWN.has(k)).map((k) => [e.className, k]))
  assert.deepEqual(wrote, [])
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
  assert.doesNotMatch(part, /transition|animation|@keyframes/)
  assert.doesNotMatch(part, /\.s\.now|\.w\.now \{|scale\(/, 'the pop is not restyled')
  assert.match(css, /\.line\.active \.w\.now \{\n  opacity: 1;\n  color: var\(--sing\);\n  transform: scale\(min\(1\.1, var\(--pop-max, 1\.1\)\)\);/)
  assert.match(css, /\.line\.active \.w\.now \.s\.now \{ transform: translateY\(-0\.24em\) scale\(min\(1\.12, var\(--pop-max, 1\.12\)\)\);/)
  assert.doesNotMatch(read('lyrics-view.js').slice(read('lyrics-view.js').indexOf('function startStretch')), /transformOrigin/, 'the pop\'s origin stays popRoom\'s')
  assert.match(part, /color: var\(--s-ghost\)/, 'the ghost colour is the theme\'s token')
})

// --- main and the helper ---

test('main: expr is sent only when Expressive words is on and kept for these lyrics; the pitch model is never downloaded by its default', () => {
  const src = read('main.js')
  assert.match(src, /function expressiveSetting\(\) \{ return settings\.expressiveWords == null \? expressive\.defaultOn\(app\.getVersion\(\)\) : !!settings\.expressiveWords \}/)
  assert.match(src, /function expressiveOn\(\) \{ return expressiveSetting\(\) && preciseTimingOn\(\) \}/)
  assert.match(src, /if \(!expressiveOn\(\) \|\| !title\) return undefined/)
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
