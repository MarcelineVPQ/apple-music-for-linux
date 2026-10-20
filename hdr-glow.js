// The HDR glow on the sung word (Settings → Experimental graphics → HDR output; the lyrics window and the
// visualizer's lyrics). Only while main says this window sits on an HDR screen ('lyrics-hdr' { on,
// headroom }); otherwise nothing here exists and the lyrics keep their SDR glow (lyrics-view.css).
//
// The DS5 app's HdrGlow pattern (src/desktop/live/HdrGlow.tsx), which Marcy picked on her TV in Phase 0
// (2026-10-17: "the WebGPU, just like in DS5, was the brightest white", brighter than CSS colours above
// 1.0): one WebGPU canvas, rgba16float in extended tone mapping (1.0 = SDR white, more is brighter; the
// main process renders in scRGB), premultiplied alpha. It moves into the sung word (or the syllable being
// sung), so the word's pop (a CSS transform) carries it on the compositor. At each word change it is drawn
// once: a mask of the word's letters from a 2D fillText (R: the letters, G: the letters blurred, the halo),
// one full-screen-triangle shader paints the singer's colour (the theme's --sing, read from the word, never
// a literal colour) through it, the letters at the screen's headroom and the halo at about half of that.
// No animation frame, no timer, no observer: one draw per word (~2–4 a second while singing), none paused.
// Pure helpers (colour maths, the text layout) are exported for test/gfx.test.js.
'use strict'

const SHADER = `
struct U { color: vec4f, boost: vec4f };
@group(0) @binding(0) var<uniform> u: U;
@group(0) @binding(1) var samp: sampler;
@group(0) @binding(2) var mask: texture_2d<f32>;
struct V { @builtin(position) pos: vec4f, @location(0) uv: vec2f };
@vertex fn vs(@builtin(vertex_index) i: u32) -> V {
  var p = array<vec2f, 3>(vec2f(-1, -1), vec2f(3, -1), vec2f(-1, 3));
  var o: V;
  o.pos = vec4f(p[i], 0, 1);
  o.uv = vec2f((p[i].x + 1) * 0.5, 1 - (p[i].y + 1) * 0.5);
  return o;
}
fn enc(x: vec3f) -> vec3f {
  let a = abs(x);
  return sign(x) * select(a * 12.92, 1.055 * pow(a, vec3f(1.0 / 2.4)) - 0.055, a > vec3f(0.0031308));
}
@fragment fn fs(v: V) -> @location(0) vec4f {
  let m = textureSample(mask, samp, v.uv);
  let a = max(m.r, m.g * 0.55);
  if (a <= 0.0) { return vec4f(0.0); }
  let lin = u.color.rgb * max(m.r * u.boost.x, m.g * u.boost.y);
  return vec4f(enc(lin / a) * a, a);
}`

// --- pure helpers ---
// "rgb(255, 128, 0)" / "rgba(…)" / "color(srgb r g b)" -> [r, g, b] in 0..1, or null
function parseRgb(s) {
  const t = String(s || '')
  let m = /rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/.exec(t)
  // loop: HOT-PATH-OK — 3 channels, once per sung word/syllable change while HDR is on, not per frame
  if (m) return [m[1], m[2], m[3]].map((x) => Math.max(0, Math.min(1, Number(x) / 255)))
  m = /color\(srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)/.exec(t)
  // loop: HOT-PATH-OK — 3 channels, once per sung word/syllable change while HDR is on, not per frame
  if (m) return [m[1], m[2], m[3]].map((x) => Math.max(0, Math.min(1, Number(x))))
  return null
}
const toLinear = (c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4))
// the singer's colour as linear light, brightest channel at 1 (so the boost keeps the hue: no channel clips
// ahead of the others), leaning 30 % toward white (research gpu-render-hdr §3.4)
function singLinear(rgb) {
  const lin = rgb.map(toLinear)
  const top = Math.max(...lin)
  // loop: HOT-PATH-OK — 3 channels, once per sung word/syllable change while HDR is on
  const n = top > 0 ? lin.map((c) => c / top) : [1, 1, 1]
  // loop: HOT-PATH-OK — 3 channels, once per sung word/syllable change while HDR is on
  return n.map((c) => c + (1 - c) * 0.3)
}
// Only light text glows: on a dark card the sung word is light, and brighter than white reads as light.
// In the light theme the sung word is dark (theme.js fits it to 4.5:1 over a light card): boosting it would
// wash it out against the card (measured on the isolated copy: a pale word on lavender), so it keeps its
// SDR look. Relative luminance of the sRGB colour ≥ 0.18 (a mid grey) counts as light.
function glows(rgb) {
  const l = rgb.map(toLinear)
  return 0.2126 * l[0] + 0.7152 * l[1] + 0.0722 * l[2] >= 0.18
}
// the letters at the screen's headroom (peak / SDR white), the halo at half of the way there; never under 1
function boosts(headroom) {
  const h = Math.max(1, Math.min(6, Number(headroom) || 1))
  return { core: h, halo: 1 + (h - 1) * 0.5 }
}
// where the letters sit in the canvas: the canvas reaches `pad` px past the element on each side; the text
// line box is `boxH` tall with the text centred in it (CSS half-leading); the text is `textW` wide, centred
// in `boxW` (a word's bold copy) or from its left (a syllable)
function textLayout(o) {
  const x = o.pad + (o.center ? (o.boxW - o.textW) / 2 : 0)
  const y = o.pad + o.top + (o.boxH - (o.ascent + o.descent)) / 2 + o.ascent
  return { x, y, width: o.boxW + 2 * o.pad, height: o.elH + 2 * o.pad }
}

// --- the glow in a page ---
function createHdrGlow(doc) {
  const win = doc.defaultView
  let on = false
  let headroom = 1
  let shown = null          // the element the canvas sits in
  let device = null
  let ctx = null
  let pipeline = null
  let uniform = null
  let sampler = null
  let tex = null
  let starting = null
  let failed = false
  const canvas = doc.createElement('canvas')
  canvas.className = 'hdr-glow'
  canvas.setAttribute('aria-hidden', 'true')
  canvas.style.cssText = 'position:absolute;pointer-events:none;z-index:1'

  // the GPU parts, made once while HDR is on, released when it goes off or the page goes
  function start() {
    if (device || starting || failed) return starting
    const gpu = win.navigator.gpu
    if (!gpu) { failed = true; return null }
    starting = (async () => {
      const adapter = await gpu.requestAdapter()
      // lifetime: OK — destroyed in stop() (HDR off, the window on an SDR screen, or the page going)
      const dev = adapter ? await adapter.requestDevice() : null
      if (!dev) { failed = true; return }
      if (!on) { dev.destroy(); return }
      device = dev
      ctx = canvas.getContext('webgpu')
      ctx.configure({ device, format: 'rgba16float', toneMapping: { mode: 'extended' }, alphaMode: 'premultiplied' })
      const module = device.createShaderModule({ code: SHADER })
      pipeline = device.createRenderPipeline({ layout: 'auto', vertex: { module, entryPoint: 'vs' }, fragment: { module, entryPoint: 'fs', targets: [{ format: 'rgba16float', blend: undefined }] } })
      uniform = device.createBuffer({ size: 32, usage: 0x40 | 0x8 })   // UNIFORM | COPY_DST
      sampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear' })
    })().catch((e) => { failed = true; console.error('hdr glow: no WebGPU device:', e && e.message) })   // error: LOGGED-OK — no HDR glow; the SDR glow stays (the CSS one)
      .finally(() => { starting = null })
    return starting
  }
  function stop() {
    hide()
    if (tex) tex.destroy()
    if (ctx && ctx.unconfigure) ctx.unconfigure()
    if (device) device.destroy()
    tex = null; ctx = null; device = null; pipeline = null; uniform = null; sampler = null
  }
  function hide() {
    if (canvas.parentNode) canvas.remove()
    shown = null
  }

  // the 2D canvases a word is measured and painted on, made once and reused (QC 2026-10 LOOP L1: three canvases,
  // a mask buffer and a texture per sung word went to the GC). Only getImageData's two readbacks stay per word.
  let probe = null
  let paintCore = null
  let paintHalo = null
  let mask = new Uint8Array(0)
  const params = new Float32Array(8)
  function painter() {
    const c = doc.createElement('canvas')
    return c.getContext('2d', { willReadFrequently: true })
  }

  // the letters of `el` (a .w word: its bold copy; a .s syllable: its text), masked at the device's pixels
  function draw(el) {
    const isSyl = el.classList.contains('s')
    const textEl = isSyl ? (el.querySelector('.sg') || el) : (el.querySelector('.b') || el)
    const text = isSyl ? textEl.textContent : (el.dataset.text || textEl.textContent)
    if (!text) { hide(); return }
    const cs = win.getComputedStyle(textEl)
    const size = parseFloat(cs.fontSize) || 16
    const pad = Math.ceil(size * 0.6)
    const dpr = win.devicePixelRatio || 1
    const font = [cs.fontStyle, cs.fontWeight, cs.fontSize, cs.fontFamily].join(' ')
    // lifetime: OK — the probe and the two paint canvases are made once per window and reused (they go with the
    // page); per word only the two getImageData readbacks are new (~64 KB each at DPR 1), the mask buffer and the
    // texture are reused while the word's size fits
    if (!probe) { probe = doc.createElement('canvas').getContext('2d'); paintCore = painter(); paintHalo = painter() }
    const colour = parseRgb(win.getComputedStyle(el).color) || [1, 1, 1]
    if (!glows(colour)) { hide(); return }
    probe.font = font
    if ('letterSpacing' in probe) probe.letterSpacing = cs.letterSpacing === 'normal' ? '0px' : cs.letterSpacing
    if ('fontKerning' in probe) probe.fontKerning = el.closest('.hs') ? 'none' : 'normal'
    const mt = probe.measureText(text)
    const boxW = isSyl ? el.offsetWidth : textEl.offsetWidth
    const boxH = isSyl ? el.offsetHeight : textEl.offsetHeight
    const lay = textLayout({ pad, center: !isSyl, boxW, textW: mt.width, top: isSyl ? 0 : textEl.offsetTop, boxH, elH: el.offsetHeight, ascent: mt.fontBoundingBoxAscent, descent: mt.fontBoundingBoxDescent })
    const W = Math.max(1, Math.round(lay.width * dpr))
    const H = Math.max(1, Math.round(lay.height * dpr))
    const paint = (g, blur) => {
      const c = g.canvas
      if (c.width !== W) c.width = W
      if (c.height !== H) c.height = H
      g.setTransform(1, 0, 0, 1, 0, 0)
      g.clearRect(0, 0, W, H)
      g.setTransform(dpr, 0, 0, dpr, 0, 0)
      g.font = font
      if ('letterSpacing' in g) g.letterSpacing = probe.letterSpacing
      if ('fontKerning' in g) g.fontKerning = probe.fontKerning
      g.filter = blur ? 'blur(' + (size * 0.3).toFixed(1) + 'px)' : 'none'
      g.fillStyle = '#fff'; g.strokeStyle = '#fff'
      g.lineWidth = parseFloat(cs.webkitTextStrokeWidth) || 0
      g.fillText(text, lay.x, lay.y)
      if (g.lineWidth) g.strokeText(text, lay.x, lay.y)
      return g.getImageData(0, 0, W, H).data
    }
    const core = paint(paintCore, false)
    const halo = paint(paintHalo, true)
    if (mask.length < W * H * 4) mask = new Uint8Array(W * H * 4)
    const data = mask.length === W * H * 4 ? mask : mask.subarray(0, W * H * 4)
    // loop: HOT-PATH-OK — one word's mask (~200 × 80 device px), once per word change, never per frame
    for (let i = 0; i < W * H; i++) { data[i * 4] = core[i * 4 + 3]; data[i * 4 + 1] = halo[i * 4 + 3] }
    const lin = singLinear(colour)
    const b = boosts(headroom)
    if (canvas.width !== W) canvas.width = W
    if (canvas.height !== H) canvas.height = H
    canvas.style.left = (-pad) + 'px'
    canvas.style.top = (-pad) + 'px'
    canvas.style.width = lay.width + 'px'
    canvas.style.height = lay.height + 'px'
    if (el.style.position === '' && win.getComputedStyle(el).position === 'static') el.style.position = 'relative'
    if (canvas.parentNode !== el) el.appendChild(canvas)
    shown = el
    // the texture is kept while the size is the same (most words of a line), else replaced
    if (!tex || tex.width !== W || tex.height !== H) {
      if (tex) tex.destroy()
      // lifetime: OK — destroyed when a word of another size replaces it, or in stop()
      tex = device.createTexture({ size: [W, H], format: 'rgba8unorm', usage: 0x4 | 0x2 })   // TEXTURE_BINDING | COPY_DST
    }
    device.queue.writeTexture({ texture: tex }, data, { bytesPerRow: W * 4 }, [W, H])
    params[0] = lin[0]; params[1] = lin[1]; params[2] = lin[2]; params[3] = 1; params[4] = b.core; params[5] = b.halo
    device.queue.writeBuffer(uniform, 0, params)
    const bind = device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: uniform } }, { binding: 1, resource: sampler }, { binding: 2, resource: tex.createView() }] })
    const enc = device.createCommandEncoder()
    const pass = enc.beginRenderPass({ colorAttachments: [{ view: ctx.getCurrentTexture().createView(), clearValue: { r: 0, g: 0, b: 0, a: 0 }, loadOp: 'clear', storeOp: 'store' }] })
    pass.setPipeline(pipeline)
    pass.setBindGroup(0, bind)
    pass.draw(3)
    pass.end()
    device.queue.submit([enc.finish()])
    drawn++
  }
  let drawn = 0
  let want = null           // the element to glow once the device is ready

  // main: is this window on an HDR screen (and with what headroom)?
  function set(s) {
    const next = !!(s && s.on)
    headroom = s && s.headroom ? s.headroom : 1
    if (next === on) { if (on && shown) sung(shown) ; return }
    on = next
    if (!on) { stop(); return }
    const p = start()
    // error: NOT-WORTH — start()'s promise catches inside (LOGGED-OK) and sung() catches draw errors
    if (p) p.then(() => { if (on && want) sung(want) })
  }
  // lyrics-view.js: the element being sung now (a .w word or a .s syllable), or null
  function sung(el) {
    want = el
    if (!on) return
    if (!el) { hide(); return }
    if (!device) { start(); return }
    try { draw(el) } catch (e) { hide(); console.error('hdr glow:', e && e.message) }   // error: LOGGED-OK — this word keeps its SDR glow; the next word tries again
  }
  // lifetime: OK — one pagehide listener per window: the GPU device goes with the page
  win.addEventListener('pagehide', stop)
  return { set, sung, state: () => ({ on, headroom, device: !!device, failed, drawn, shown: shown ? shown.textContent : '' }) }
}

module.exports = { SHADER, parseRgb, toLinear, singLinear, glows, boosts, textLayout, createHdrGlow }
