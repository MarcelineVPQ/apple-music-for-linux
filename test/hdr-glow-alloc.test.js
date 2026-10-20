// hdr-glow.js draw (QC 2026-10 LOOP_PASS L1, HOT-ALLOC): the measuring and painting canvases are made once and the
// mask texture is kept while words keep their size; per sung word only the two readbacks are new.
'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const G = require('../hdr-glow')

function fakes() {
  const n = { canvases: 0, textures: 0, destroyed: 0, readbacks: 0 }
  const ctx2d = (c) => ({
    canvas: c, measureText: (t) => ({ width: t.length * 8, fontBoundingBoxAscent: 12, fontBoundingBoxDescent: 4 }),
    setTransform () {}, clearRect () {}, scale () {}, fillText () {}, strokeText () {},
    getImageData: (x, y, w, h) => { n.readbacks++; return { data: new Uint8ClampedArray(w * h * 4) } }
  })
  const el = (text) => {
    const e = { classList: { contains: () => false }, dataset: { text }, textContent: text, style: { position: '' }, offsetWidth: text.length * 8, offsetHeight: 20, offsetTop: 0,
      querySelector: () => null, closest: () => null, appendChild (c) { c.parentNode = e } }
    return e
  }
  const doc = {
    createElement: () => {
      n.canvases++
      const c = { style: {}, width: 300, height: 150, setAttribute () {}, remove () { this.parentNode = null } }
      c.getContext = (kind) => kind === 'webgpu' ? { configure () {}, unconfigure () {}, getCurrentTexture: () => ({ createView: () => ({}) }) } : ctx2d(c)
      return c
    }
  }
  const device = {
    destroy () {}, createShaderModule: () => ({}), createRenderPipeline: () => ({ getBindGroupLayout: () => ({}) }),
    createBuffer: () => ({}), createSampler: () => ({}), createBindGroup: () => ({}),
    createTexture: (d) => { n.textures++; return { width: d.size[0], height: d.size[1], destroy () { n.destroyed++ }, createView: () => ({}) } },
    createCommandEncoder: () => ({ beginRenderPass: () => ({ setPipeline () {}, setBindGroup () {}, draw () {}, end () {} }), finish: () => ({}) }),
    queue: { writeTexture () {}, writeBuffer () {}, submit () {} }
  }
  const win = {
    devicePixelRatio: 1,
    navigator: { gpu: { requestAdapter: async () => ({ requestDevice: async () => device }) } },
    getComputedStyle: () => ({ fontSize: '16px', fontStyle: 'normal', fontWeight: '700', fontFamily: 'sans', letterSpacing: 'normal', color: 'rgb(255, 255, 255)', position: 'static', webkitTextStrokeWidth: '0px' }),
    addEventListener () {}
  }
  doc.defaultView = win
  return { n, doc, win, el }
}

test('hdr glow: canvases made once, the texture kept for words of one size, two readbacks per word', async () => {
  const f = fakes()
  const glow = G.createHdrGlow(f.doc)
  glow.set({ on: true, headroom: 4 })
  await new Promise((r) => setTimeout(r, 0))
  await new Promise((r) => setImmediate(r))
  assert.equal(glow.state().device, true)
  const base = f.n.canvases
  // loop: NOT-WORTH — a test's 20 words
  for (let k = 0; k < 20; k++) glow.sung(f.el(k % 2 ? 'love' : 'home'))   // same length: same size
  assert.equal(glow.state().drawn, 20)
  assert.ok(f.n.canvases - base <= 3, 'probe + two paint canvases at most: ' + (f.n.canvases - base))
  assert.equal(f.n.textures, 1, 'one texture for one size')
  assert.equal(f.n.readbacks, 40)
  glow.sung(f.el('tonight'))                           // another size: the texture is replaced, not leaked
  assert.equal(f.n.textures, 2)
  assert.equal(f.n.destroyed, 1)
})
