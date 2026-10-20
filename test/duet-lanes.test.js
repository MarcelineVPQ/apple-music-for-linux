// More than one singer (0.15.68, Marcy 2026-10-19). Default: one column, every singer with the same
// alignment, size and place; only the sung colour differs (singer 1, singer 2, a shared blend when sung
// together). Singer lanes with name tags are built but off (lyrics-lanes.js LANES), tested here with the
// switch forced on: lane assignment from TTML agents, lines sung together spanning the lanes, the name
// tags' honest fallbacks, the collapse to one column when narrow, and Expressive words inside a lane.
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')
const L = require('../lyrics-lanes')
const { parseTtml, ttmlAgentNames } = require('../lyrics-sources')

const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8')
const fixture = read('test/fixtures/duet-lay-all-your-love.ttml')

test('the switches ship off: one column with per-singer colour, no lanes, no tags', () => {
  assert.equal(L.LANES, false)
  assert.equal(L.LANE_COLOURS, false)
  const plan = L.duetPlan(parseTtml(fixture))
  assert.equal(plan.duet, true)
  assert.equal(plan.lanes, 0)
  assert.equal(plan.lane, null)
  assert.equal(plan.who, null)
  assert.deepEqual(L.tagAt(plan.who), [])
})

test('default: singer 1, singer 2 and lines sung together get their own colour class, nothing else', () => {
  const lines = parseTtml(fixture)
  const plan = L.duetPlan(lines)
  assert.deepEqual([...new Set(plan.voice)].sort(), ['singer-1', 'singer-2', 'singer-group'])
  lines.forEach((l, i) => assert.equal(plan.voice[i], l.agent === 'v1' ? 'singer-1' : l.agent === 'v2' ? 'singer-2' : 'singer-group'))
  // one singer: no class at all (the page as before)
  assert.deepEqual(L.duetPlan([{ agent: 'v1' }, { agent: 'v1' }, {}]).voice, ['', '', ''])
})

test('default: the singer rules in the CSS set only the sung colour (same alignment, size and place for all)', () => {
  const css = read('lyrics-view.css')
  const rules = [...css.matchAll(/([^{}]*\.singer-[\w-]+[^{}]*)\{([^}]*)\}/g)]
  assert.ok(rules.length >= 2, 'singer rules found')
  // loop: test only
  for (const [, sel, body] of rules) {
    const props = body.split(';').map((d) => d.split(':')[0].trim()).filter(Boolean)
    assert.deepEqual(props, ['--sing'], sel.trim() + ' sets ' + props.join(', '))
  }
  // and no page restyles a singer, or brings back left/right duet sides
  for (const f of ['lyrics.html', 'visualizer.html', 'lyrics-view.css']) {
    const src = read(f)
    assert.doesNotMatch(src, /\.line\.(left|right|center)\b|\.dots\.(left|right|center)\b/, f)
    const per = [...src.matchAll(/([^{}]*\.singer-[\w-]+[^{}]*)\{([^}]*)\}/g)].filter(([, , b]) => /text-align|padding|margin|font|left|right|width|transform/.test(b))
    assert.deepEqual(per.map((m) => m[1].trim()), [], f + ': a singer rule changes more than the colour')
  }
})

test('TTML: singers from ttm:agent, names from ttm:name when Apple gives them', () => {
  const lines = parseTtml(fixture)
  assert.deepEqual(L.singersOf(lines), ['v1', 'v2'])
  assert.deepEqual(ttmlAgentNames(fixture), {})
  const named = '<tt><head><metadata><ttm:agent type="person" xml:id="v1"><ttm:name type="full">Meryl Streep</ttm:name></ttm:agent>' +
    '<ttm:agent type="person" xml:id="v2"><ttm:name type="full">Pierce Brosnan &amp; co</ttm:name></ttm:agent><ttm:agent type="group" xml:id="v1000"/></metadata></head></tt>'
  assert.deepEqual(ttmlAgentNames(named), { v1: 'Meryl Streep', v2: 'Pierce Brosnan & co' })
})

test('lanes (switch on): each singer in their lane in time order, lines sung together span all lanes', () => {
  const lines = parseTtml(fixture)
  const plan = L.duetPlan(lines, { lanes: true })
  assert.equal(plan.lanes, 2)
  lines.forEach((l, i) => assert.equal(plan.lane[i], l.agent === 'v1' ? 0 : l.agent === 'v2' ? 1 : -1, l.text))
  assert.ok(plan.lane.includes(-1), 'the fixture has a line sung together')
  // inside lanes, one colour unless LANE_COLOURS allows the singers' colours
  assert.deepEqual([...new Set(plan.voice)], [''])
  assert.ok(L.duetPlan(lines, { lanes: true, laneColours: true }).voice.includes('singer-2'))
  // more singers than lanes: one column with tags (never a lane shared by two singers)
  const four = L.duetPlan(['v1', 'v2', 'v3', 'v4'].map((agent) => ({ agent })), { lanes: true })
  assert.equal(four.lanes, 1)
  assert.deepEqual(L.tagAt(four.who), [true, true, true, true])
})

test('name tags: at each lane\'s first line and each singer change; names honest or neutral', () => {
  assert.deepEqual(L.tagAt(['v1', 'v1', 'v2', 'v2', 'group', 'v1']), [true, false, true, false, true, true])
  const s = ['v1', 'v2']
  assert.deepEqual(L.singerLabels(s, { v1: 'Meryl Streep' }, 'ABBA'), { v1: 'Meryl Streep', v2: 'Singer 2', group: 'Together' })
  assert.deepEqual(L.singerLabels(s, null, 'Dominic Cooper & Amanda Seyfried'), { v1: 'Dominic Cooper', v2: 'Amanda Seyfried', group: 'Together' })
  assert.deepEqual(L.singerLabels(s, null, 'Elton John feat. Kiki Dee'), { v1: 'Elton John', v2: 'Kiki Dee', group: 'Together' })
  // a band name, a one-word name or a count that doesn't match: neutral, never a guess
  for (const artist of ['Mumford & Sons', 'Simon & Garfunkel', 'ABBA', 'Drake feat. Rihanna', 'A Person, B Person & C Person', '']) {
    assert.deepEqual(L.singerLabels(s, {}, artist), { v1: 'Singer 1', v2: 'Singer 2', group: 'Together' }, artist)
  }
})

test('narrow: lanes collapse to one column below LANE_MIN_PX a lane', () => {
  assert.equal(L.collapsed(L.LANE_MIN_PX * 2, 2), false)
  assert.equal(L.collapsed(L.LANE_MIN_PX * 2 - 1, 2), true)
  assert.equal(L.collapsed(300, 1), false)
  assert.equal(L.collapsed(0, 2), false, 'not laid out yet: measured when it is')
})

// --- the view, on a stand-in DOM: classes, the lane properties, tags ---
class El {
  constructor(doc, tag) {
    this.ownerDocument = doc; this.tagName = tag; this.children = []; this.parentElement = null; this.className = ''
    this.dataset = {}; this.attrs = {}; this._text = ''; this.scrollTop = 0; this.tabIndex = -1; this.lang = ''; this.width = 600
    const props = {}
    this.style = { setProperty(k, v) { props[k] = v }, removeProperty(k) { delete props[k] }, props, transformOrigin: '' }
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
  append(...cs) { for (const c of cs) this.appendChild(c) }   // loop: test only
  remove() { const p = this.parentElement; if (p) p.children.splice(p.children.indexOf(this), 1); this.parentElement = null }
  set innerHTML(v) { this.children = []; if (/<i>/.test(v)) for (let i = 0; i < 3; i++) this.appendChild(new El(this.ownerDocument, 'i')) }   // loop: test only
  set textContent(v) { this.children = []; this._text = String(v) }
  get textContent() { return this._text }
  cloneNode() { const c = new El(this.ownerDocument, this.tagName); c.className = this.className; c._text = this._text; for (const k of this.children) c.appendChild(k instanceof El ? k.cloneNode() : { text: k.text }); return c }   // loop: test only
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
  get clientWidth() { return this.width }
  get offsetWidth() { return 0 }
  get offsetTop() { return 0 }
  get offsetLeft() { return 0 }
  get offsetParent() { return null }
  getBoundingClientRect() { return { top: 0, bottom: 40, height: 40, left: 0, right: 0, width: 0 } }
  scrollTo() {}
}
function makeDoc() {
  const doc = { visibilityState: 'visible', activeElement: null, createElement: (tag) => new El(doc, tag), createTextNode: (t) => ({ text: t }), addEventListener() {}, defaultView: { matchMedia: () => ({ matches: false }), addEventListener() {} } }
  return doc
}
let nowMs = 0
const realPerf = globalThis.performance
Object.defineProperty(globalThis, 'performance', { value: { now: () => nowMs }, configurable: true, writable: true })
globalThis.requestAnimationFrame = () => 1
globalThis.cancelAnimationFrame = () => {}
test.after(() => Object.defineProperty(globalThis, 'performance', { value: realPerf, configurable: true, writable: true }))
const { createLyricsView } = require('../lyrics-view')

function render(duet, width = 600, data = {}) {
  const list = new El(makeDoc(), 'div')
  list.width = width
  const view = createLyricsView({ container: list, layout: 'scroll', onSeek: () => {}, duet })
  view.setData(Object.assign({ key: 'k', title: 'Lay All Your Love On Me', artist: 'Dominic Cooper & Amanda Seyfried', duration: 60, lines: parseTtml(fixture), lang: 'en-US' }, data))
  return { list, view, lines: list.els().filter((e) => e.has('line')) }
}

test('view, default: the lines differ only by their colour class; no lanes, no tags, no lane properties', () => {
  const { list, lines } = render(undefined)
  assert.equal(list.has('lanes'), false)
  const src = parseTtml(fixture)
  lines.forEach((el, i) => {
    const want = src[i].agent === 'v1' ? 'singer-1' : src[i].agent === 'v2' ? 'singer-2' : 'singer-group'
    assert.equal(el.className.replace(/\s+/g, ' '), 'line ' + want, src[i].text)
    assert.deepEqual(el.style.props, {})
    assert.equal(el.has('tagged'), false)
  })
  // the same structure for both singers: strip the colour class and two lines of each singer compare equal in shape
  const shape = (el) => el.els().map((c) => c.className).join('|')
  const a = lines.find((_, i) => src[i].agent === 'v1')
  const b = lines.find((_, i) => src[i].agent === 'v2')
  assert.equal(shape(a), shape(b))
})

test('view, lanes on: lane classes and --lane per singer, group lines span, tags with names from the credits', () => {
  const { list, lines } = render({ lanes: true })
  assert.ok(list.has('lanes'))
  assert.equal(list.has('lane-one'), false)
  assert.equal(list.style.props['--lanes'], '2')
  const src = parseTtml(fixture)
  lines.forEach((el, i) => {
    if (src[i].agent === 'v1' || src[i].agent === 'v2') {
      assert.ok(el.has('lane'), src[i].text)
      assert.equal(el.style.props['--lane'], src[i].agent === 'v1' ? '0' : '1')
    } else assert.equal(el.has('lane'), false, 'sung together: spans the lanes')
    assert.equal(/singer-/.test(el.className), false, 'one colour in lanes')
    const change = i === 0 || (src[i - 1].agent || 'group') !== (src[i].agent || 'group')
    assert.equal(el.has('tagged'), change, 'tag at a singer change: ' + src[i].text)
    if (change) assert.equal(el.dataset.singer, { v1: 'Dominic Cooper', v2: 'Amanda Seyfried' }[src[i].agent] || 'Together')
  })
})

test('view, lanes on, narrow window: one column, the tags stay', () => {
  const { list, lines } = render({ lanes: true }, L.LANE_MIN_PX * 2 - 20, { artist: 'ABBA' })
  assert.ok(list.has('lanes') && list.has('lane-one'))
  assert.equal(lines[0].dataset.singer, 'Singer 1')
  assert.ok(lines.some((el) => el.dataset.singer === 'Singer 2'))
})
