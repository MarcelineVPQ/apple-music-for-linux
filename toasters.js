// Flying toasters for the visualizer's "toast" scene: original pixel art (a 1950s streamline chrome
// two-slot toaster with feathered wings, and a toast slice) and the formation they fly in. Pure, no
// DOM: visualizer.html turns the pixel maps into cached canvases once; test/toasters.test.js covers
// the art's invariants and the formation/wrap math.
//
// The formation: a staggered, jittered lattice that always fills the screen. Everything flies the same
// diagonal (upper right -> lower left) at the same speed on a torus a little larger than the screen,
// so a toaster leaving at the bottom/left comes back at the top/right and the screen never empties.
// The population never depends on the music; the music sets the wing flap rate (and nudges the speed).

// --- palette (index 0 = transparent) ---
const PALETTE = [
  null,
  '#1b1e26',  // 1 outline
  '#3b4250',  // 2 chrome 0 (darkest)
  '#5d6678',  // 3 chrome 1
  '#8a93a5',  // 4 chrome 2
  '#b7bfcc',  // 5 chrome 3
  '#dde3ec',  // 6 chrome 4
  '#ffffff',  // 7 chrome 5 / specular
  '#1d6b62',  // 8 mint 0
  '#35a994',  // 9 mint 1
  '#7fe6cf',  // 10 mint 2
  '#6a3414',  // 11 crust dark
  '#9c5420',  // 12 crust
  '#d4873a',  // 13 toast
  '#eeb15d',  // 14 toast light
  '#ffdc93',  // 15 toast highlight
  '#2b3140',  // 16 wing outline
  '#c6cedc',  // 17 wing shade
  '#e9eef5',  // 18 wing mid
  '#ffffff'   // 19 wing white
]

// distance from p to segment ab
function segT(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay
  return Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy || 1)))
}
function segDist(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy || 1)))
  return Math.hypot(px - ax - t * dx, py - ay - t * dy)
}

// --- the sprites: a tiny 3D model, ray-marched once into palette pixels ---
// Seen three-quarter from above (orthographic): the top with its two bread slots, the front end
// (lever, dial) pointing to the lower left, where the formation flies, and the right-hand long side.
// Chrome is shaded by what it reflects (sky, horizon, the mint floor), so the reflection bands curve
// with the rounded body; the enamel band and the bread are shaded by a light. The wings are 2D
// feathered pixel art on top, hinged at the body's two top edges and sweeping up and back.

// sprite canvas (source pixels)
const TW = 96
const TH = 76
const PX = 26                 // source pixels per model unit
// wing angles (degrees above the screen horizontal, pointing right/back) for the 5 poses: up … down
const WING_POSES = [78, 56, 34, 12, -10]

const V = {
  norm: (v) => { const l = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / l, v[1] / l, v[2] / l] },
  cross: (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]],
  dot: (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}
// camera: looking down onto the toaster's top, its front end (+z) toward the lower left
const VIEW = V.norm([-0.52, -0.78, -0.42])
const RIGHT = V.norm(V.cross(VIEW, [0, 1, 0]))
const UP = V.cross(RIGHT, VIEW)
const SUN = V.norm([-0.35, 0.85, 0.4])            // reflected sky hot spot / light
// sprite pixel of a model point (centre of the canvas = model origin, shifted to leave wing room)
const ORIGIN = { x: 40, y: 44 }
function project(p) {
  return { x: ORIGIN.x + V.dot(RIGHT, p) * PX, y: ORIGIN.y - V.dot(UP, p) * PX }
}

function grid(w, h) { return { w, h, px: new Uint8Array(w * h) } }
function put(g, x, y, c) { if (x >= 0 && y >= 0 && x < g.w && y < g.h) g.px[y * g.w + x] = c }
function get(g, x, y) { return x >= 0 && y >= 0 && x < g.w && y < g.h ? g.px[y * g.w + x] : 0 }

function sdRoundBox(p, c, b, r) {
  const qx = Math.abs(p[0] - c[0]) - b[0] + r, qy = Math.abs(p[1] - c[1]) - b[1] + r, qz = Math.abs(p[2] - c[2]) - b[2] + r
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0), Math.max(qz, 0)) + Math.min(Math.max(qx, qy, qz), 0) - r
}
function sdSphere(p, c, r) { return Math.hypot(p[0] - c[0], p[1] - c[1], p[2] - c[2]) - r }
// cylinder along z
function sdCylZ(p, c, r, h) {
  const dx = Math.hypot(p[0] - c[0], p[1] - c[1]) - r, dz = Math.abs(p[2] - c[2]) - h
  return Math.min(Math.max(dx, dz), 0) + Math.hypot(Math.max(dx, 0), Math.max(dz, 0))
}

// the toaster: [distance, material]
const SLOTS = [-0.17, 0.17]
function toasterSdf(p) {
  let d = sdRoundBox(p, [0, 0, 0], [0.5, 0.52, 0.92], 0.3)            // the streamline loaf
  for (const sx of SLOTS) d = Math.max(d, -sdRoundBox(p, [sx, 0.62, 0], [0.065, 0.3, 0.6], 0.03))
  let best = [d, 'chrome']
  const add = (dist, m) => { if (dist < best[0]) best = [dist, m] }
  for (const sx of SLOTS) add(sdRoundBox(p, [sx, 0.47, 0], [0.045, 0.2, 0.5], 0.06), 'bread')
  add(sdRoundBox(p, [0, -0.55, 0], [0.44, 0.04, 0.84], 0.04), 'base')
  for (const fx of [-0.36, 0.36]) for (const fz of [-0.66, 0.66]) add(sdSphere(p, [fx, -0.64, fz], 0.08), 'foot')
  add(sdCylZ(p, [0.22, -0.12, 0.92], 0.13, 0.04), 'dial')
  add(sdRoundBox(p, [-0.2, 0.16, 0.98], [0.035, 0.035, 0.1], 0.02), 'lever')
  add(sdSphere(p, [-0.2, 0.16, 1.1], 0.075), 'knob')
  return best
}

function sdfNormal(f, p) {
  const e = 0.004
  return V.norm([
    f([p[0] + e, p[1], p[2]])[0] - f([p[0] - e, p[1], p[2]])[0],
    f([p[0], p[1] + e, p[2]])[0] - f([p[0], p[1] - e, p[2]])[0],
    f([p[0], p[1], p[2] + e])[0] - f([p[0], p[1], p[2] - e])[0]
  ])
}

// chrome: the colour of what the surface reflects
function chromeColour(n, p) {
  const dn = V.dot(VIEW, n)
  const r = [VIEW[0] - 2 * dn * n[0], VIEW[1] - 2 * dn * n[1], VIEW[2] - 2 * dn * n[2]]
  if (V.dot(r, SUN) > 0.93) return 7                       // the sun's hot spot
  // the enamel band round the body's waist
  if (p[1] > -0.3 && p[1] < -0.12) return V.dot(n, SUN) > 0.1 ? 10 : V.dot(n, SUN) > -0.3 ? 9 : 8
  const y = r[1]
  if (y > 0.62) return 6
  if (y > 0.3) return 5
  if (y > 0.08) return 4
  if (y > -0.06) return 2                                   // horizon
  if (y > -0.25) return 9                                   // the mint floor, reflected
  if (y > -0.6) return 3                                    // the dark ground near by
  return n[0] > 0.9 && Math.abs(p[2]) < 0.5 && p[1] > 0 ? 6 : 5  // the far floor, lit: the flat sides
}

function lit(n, ramp) {
  const l = V.dot(n, SUN)
  return l > 0.55 ? ramp[0] : l > 0.1 ? ramp[1] : ramp[2]
}

/** Ray-march a model into a grid; materials map to palette colours via colourOf(material, n, p). */
function renderModel(g, sdf, colourOf) {
  for (let y = 0; y < g.h; y++) {
    for (let x = 0; x < g.w; x++) {
      const sx = (x + 0.5 - ORIGIN.x) / PX, sy = -(y + 0.5 - ORIGIN.y) / PX
      let p = [RIGHT[0] * sx + UP[0] * sy - VIEW[0] * 4, RIGHT[1] * sx + UP[1] * sy - VIEW[1] * 4, RIGHT[2] * sx + UP[2] * sy - VIEW[2] * 4]
      // loop: sphere tracing, at most 80 steps per pixel · once per sprite build
      for (let i = 0, t = 0; i < 80 && t < 8; i++) {
        const [d, m] = sdf(p)
        if (d < 0.002) { put(g, x, y, colourOf(m, sdfNormal(sdf, p), p)); break }
        p = [p[0] + VIEW[0] * d, p[1] + VIEW[1] * d, p[2] + VIEW[2] * d]
        t += d
      }
    }
  }
}

// the outline: every empty pixel next to a filled one
function outline(g, colour) {
  const src = g.px.slice()
  const at = (x, y) => x >= 0 && y >= 0 && x < g.w && y < g.h && src[y * g.w + x]
  for (let y = 0; y < g.h; y++) {
    for (let x = 0; x < g.w; x++) {
      if (!src[y * g.w + x] && (at(x + 1, y) || at(x - 1, y) || at(x, y + 1) || at(x, y - 1))) put(g, x, y, colour)
    }
  }
}

// one feathered wing (2D), a bird's spread wing: a covert arm from the shoulder along the leading edge,
// and a row of long pointed flight feathers hanging back from it, longest at the tip, overlapping so
// the trailing edge is scalloped. Pixels are owned by the frontmost shape covering them; the outer
// edge gets the outline, and the borders between feathers (outer half) a soft shade line.
// angleDeg: the arm's direction on screen (degrees counter-clockwise from pointing right).
function paintWing(g, rootX, rootY, angleDeg, scale = 1) {
  const rad = (d) => d * Math.PI / 180
  const a = rad(angleDeg)
  const L = 21 * scale
  const tipX = rootX + Math.cos(a) * L, tipY = rootY - Math.sin(a) * L
  const shapes = []
  const N = 7
  // flight feathers, tip first so the inner ones overlap them
  for (let i = N - 1; i >= 0; i--) {
    const k = i / (N - 1)
    const bx = rootX + Math.cos(a) * L * (0.3 + 0.7 * k), by = rootY - Math.sin(a) * L * (0.3 + 0.7 * k)
    const fa = a - rad(62 + 30 * (1 - k))                     // hang back; the tip feathers fan outward
    const len = (9 + 10 * k) * scale
    shapes.push({ ax: bx, ay: by, bx: bx + Math.cos(fa) * len, by: by - Math.sin(fa) * len, r: 2.7 * scale, taper: 0.8, covert: false })
  }
  // the covert arm along the leading edge, on top
  shapes.push({ ax: rootX, ay: rootY, bx: tipX, by: tipY, r: 3.4 * scale, taper: 0.55, covert: true })
  for (const f of shapes) {
    f.len = Math.hypot(f.bx - f.ax, f.by - f.ay)
    const ux = (f.bx - f.ax) / f.len, uy = (f.by - f.ay) / f.len
    f.nx = -uy; f.ny = ux
  }
  const owner = new Int8Array(g.w * g.h).fill(-1)
  const tOf = new Float32Array(g.w * g.h)
  for (let y = 0; y < g.h; y++) {
    for (let x = 0; x < g.w; x++) {
      for (let i = shapes.length - 1; i >= 0; i--) {
        const f = shapes[i]
        const t = segT(x, y, f.ax, f.ay, f.bx, f.by)
        if (segDist(x, y, f.ax, f.ay, f.bx, f.by) <= f.r * (1 - f.taper * t * t)) { owner[y * g.w + x] = i; tOf[y * g.w + x] = t; break }
      }
    }
  }
  const own = (x, y) => (x < 0 || y < 0 || x >= g.w || y >= g.h) ? -1 : owner[y * g.w + x]
  for (let y = 0; y < g.h; y++) {
    for (let x = 0; x < g.w; x++) {
      const i = own(x, y)
      if (i < 0) {
        if (own(x + 1, y) >= 0 || own(x - 1, y) >= 0 || own(x, y + 1) >= 0 || own(x, y - 1) >= 0) put(g, x, y, 16)
        continue
      }
      const f = shapes[i]
      const t = tOf[y * g.w + x]
      const back = [own(x + 1, y), own(x - 1, y), own(x, y + 1), own(x, y - 1)].some((j) => j >= 0 && j < i)
      if (back && !f.covert && t > 0.35) { put(g, x, y, 17); continue }
      if (f.covert && back) { put(g, x, y, 18); continue }
      const side = (x - f.ax) * f.nx + (y - f.ay) * f.ny
      put(g, x, y, f.covert ? (side < -f.r * 0.3 ? 18 : 19) : side > f.r * 0.3 ? 17 : t > 0.6 ? 19 : 18)
    }
  }
}

function toasterColour(m, n, p) {
  if (m === 'chrome') return chromeColour(n, p)
  if (m === 'bread') return n[1] > 0.6 ? (p[2] > 0.15 ? 15 : 14) : lit(n, [14, 13, 12])
  if (m === 'base') return lit(n, [3, 2, 2])
  if (m === 'foot') return 2
  if (m === 'dial') return n[2] > 0.8 ? (Math.hypot(p[0] - 0.22, p[1] + 0.12) < 0.06 ? 7 : 10) : 8
  if (m === 'lever') return lit(n, [6, 4, 2])
  if (m === 'knob') return lit(n, [10, 9, 8])
  return 1
}

// the body is the same in every pose: rendered once
let bodyCache = null
function toasterBody() {
  if (!bodyCache) {
    const g = grid(TW, TH)
    renderModel(g, toasterSdf, toasterColour)
    outline(g, 1)
    bodyCache = g
  }
  return bodyCache
}

// wing hinges: the body's two top long edges, toward the back (screen up-right)
const NEAR_HINGE = project([0.46, 0.4, -0.25])
const FAR_HINGE = project([-0.46, 0.45, -0.35])

/** Toaster pose (0 up … 4 down) -> { w, h, px } palette indices. */
function buildToaster(pose) {
  const g = grid(TW, TH)
  const ang = WING_POSES[pose]
  // far wing behind the body (a touch smaller, further away), body, near wing in front
  paintWing(g, Math.round(FAR_HINGE.x), Math.round(FAR_HINGE.y), ang + 10, 0.9)
  const body = toasterBody()
  for (let i = 0; i < body.px.length; i++) if (body.px[i]) g.px[i] = body.px[i]
  paintWing(g, Math.round(NEAR_HINGE.x), Math.round(NEAR_HINGE.y), ang - 4, 1.08)
  return g
}

// the toast: a slice lying tilted, seen from the same camera; its crown (two lobes) to the back
function toastSdf(p) {
  // into the slice's frame: tilt it up toward the viewer a little, turn it along the flight
  const ca = Math.cos(0.5), sa = Math.sin(0.5)
  const q = [p[0], p[1] * ca - p[2] * sa, p[1] * sa + p[2] * ca]
  const flat = Math.abs(q[1]) - 0.07                         // thickness
  // the slice outline in its plane (x, z): a square body under a two-lobed crown
  const bx = Math.abs(q[0]) - 0.48, bz = Math.abs(q[2] - 0.12) - 0.42
  let shape = Math.min(Math.max(bx, bz), 0) + Math.hypot(Math.max(bx, 0), Math.max(bz, 0)) - 0.08
  shape = Math.min(shape, Math.hypot(q[0] - 0.27, q[2] + 0.36) - 0.32, Math.hypot(q[0] + 0.27, q[2] + 0.36) - 0.32)
  const d = Math.min(Math.max(flat, shape), 0) + Math.hypot(Math.max(flat, 0), Math.max(shape, 0))
  return [d - 0.02, shape > -0.09 ? 'crust' : 'face']
}

/** A golden-brown toast slice: crust rim, toasted face, highlight. */
function buildToast() {
  const g = grid(48, 44)
  const saved = { x: ORIGIN.x, y: ORIGIN.y }
  ORIGIN.x = 24; ORIGIN.y = 22
  renderModel(g, toastSdf, (m, n, p) => {
    if (m === 'crust') return lit(n, [12, 12, 11])
    const l = V.dot(n, SUN)
    return l > 0.9 && p[0] < 0 ? 15 : l > 0.5 ? 14 : 13
  })
  ORIGIN.x = saved.x; ORIGIN.y = saved.y
  outline(g, 1)
  // a few toasting marks on the face
  for (const [x, y] of [[22, 20], [23, 20], [27, 24], [19, 25], [26, 18]]) if (get(g, x, y) === 14 || get(g, x, y) === 13) put(g, x, y, 12)
  return g
}

/**
 * Flap pose for a phase in turns (any real number): an eased cycle up -> down -> up (cosine, so the
 * wing lingers at the top and bottom of the stroke), quantised to the 5 poses. One full turn is
 * 8 steps of 0,1,2,3,4,3,2,1.
 */
function flapPose(phase) {
  const p = phase - Math.floor(phase)
  const a = (1 - Math.cos(2 * Math.PI * p)) / 2      // 0 up, 1 down
  return Math.min(WING_POSES.length - 1, Math.round(a * (WING_POSES.length - 1)))
}

// --- formation ---

/** Integer pixel scale for a canvas height: a toaster sprite about a sixth of the screen tall. */
function spriteScale(height) {
  return Math.max(2, Math.round(height / (TH * 5.5)))
}

// small deterministic PRNG, so a formation is the same for the same size
function rng(seed) {
  let s = seed >>> 0 || 1
  return () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296 }
}

/**
 * A formation for a W×H canvas with sprites of sw×sh device pixels: a torus (fw×fh, a whole number
 * of lattice cells, at least the screen plus one sprite) with one item per cell, odd rows shifted by
 * half a cell, each jittered inside its cell. ~1 in 5 is a slice of toast.
 * -> { fw, fh, cw, ch, cols, rows, items: [{ bx, by, toast, phase }] }
 */
function formation(W, H, sw, sh, seed = 7) {
  const cw = Math.round(sw * 1.18)
  const ch = Math.round(sh * 1.45)
  const cols = Math.max(2, Math.ceil((W + sw) / cw))
  let rows = Math.max(2, Math.ceil((H + sh) / ch))
  if (rows % 2) rows++                              // the stagger repeats every two rows
  const rand = rng(seed)
  const items = []
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      items.push({
        bx: c * cw + (r % 2 ? cw / 2 : 0) + (rand() - 0.5) * cw * 0.16,
        by: r * ch + (rand() - 0.5) * ch * 0.22,
        toast: rand() < 0.2,
        phase: rand()                                // own flap phase (turns)
      })
    }
  }
  return { fw: cols * cw, fh: rows * ch, cw, ch, cols, rows, items }
}

function wrap(v, m) { return ((v % m) + m) % m }

/**
 * Top-left of an item after the formation has flown (ox, oy) device pixels, on the torus, shifted by
 * one sprite so items enter and leave fully off screen. Integer pixels.
 */
function itemPos(f, item, ox, oy, sw, sh) {
  return { x: Math.round(wrap(item.bx + ox, f.fw) - sw), y: Math.round(wrap(item.by + oy, f.fh) - sh) }
}

// flight direction on screen: where the toaster's nose (+z) points, upper right -> lower left
const DIR = (() => { const a = project([0, 0, 1]), o = project([0, 0, 0]); const l = Math.hypot(a.x - o.x, a.y - o.y); return { x: (a.x - o.x) / l, y: (a.y - o.y) / l } })()

module.exports = {
  PALETTE, TW, TH, WING_POSES, buildToaster, buildToast, flapPose,
  spriteScale, formation, wrap, itemPos, DIR
}
