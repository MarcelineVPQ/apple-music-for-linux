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
const CHROME = [2, 3, 4, 5, 6, 7]

// sprite canvas (source pixels)
const TW = 80
const TH = 52
const BODY = { x0: 23, x1: 56, y0: 19, y1: 40 }    // inclusive bounds of the loaf body
// wing angles (degrees above horizontal) for the 5 drawn poses: up, high, mid, low, down
const WING_POSES = [56, 32, 8, -16, -38]

function grid(w, h) { return { w, h, px: new Uint8Array(w * h) } }
function put(g, x, y, c) { if (x >= 0 && y >= 0 && x < g.w && y < g.h) g.px[y * g.w + x] = c }
function get(g, x, y) { return x >= 0 && y >= 0 && x < g.w && y < g.h ? g.px[y * g.w + x] : 0 }

// distance from p to segment ab
function segDist(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy || 1)))
  return Math.hypot(px - ax - t * dx, py - ay - t * dy)
}

// inside the loaf body: a superellipse, round on top (streamline shoulders and ends) and flatter
// toward the base; the widest point sits a little below the middle
function inLoaf(x, y, b) {
  const cx = (b.x0 + b.x1) / 2
  const cy = b.y0 + (b.y1 - b.y0) * 0.56
  const a = (b.x1 - b.x0) / 2 + 0.5
  const top = y < cy
  const h = top ? cy - b.y0 + 0.5 : b.y1 - cy + 0.5
  const p = top ? 2.4 : 5
  return Math.abs((x - cx) / a) ** p + Math.abs((y - cy) / h) ** p <= 1
}

// one feathered wing, behind the body: primaries fanned out from the shoulder, longest at the leading
// edge, their rounded tips overlapping. Pixels are owned by the frontmost feather covering them; the
// wing's outer edge gets the outline, and the borders between feathers (outer half only) a soft shade
// line, so the tips read as separate feathers without speckle.
function paintWing(g, rootX, rootY, dir, angleDeg) {
  // [angle offset (deg), length, radius], back to front: primaries, then the shoulder coverts
  const feathers = [[18, 17, 2.4], [10, 21, 2.5], [2, 23, 2.6], [-7, 22, 2.6], [-16, 19, 2.5], [-25, 15, 2.4], [-4, 12, 4.2], [6, 10, 3.8]]
  const shapes = feathers.map(([off, len, r]) => {
    const a = (angleDeg + off) * Math.PI / 180
    return { len, r, tx: rootX + dir * Math.cos(a) * len, ty: rootY - Math.sin(a) * len, nx: -Math.sin(a) * dir, ny: -Math.cos(a), covert: len < 13 }
  })
  const owner = new Int8Array(g.w * g.h).fill(-1)
  for (let y = 0; y < g.h; y++) {
    for (let x = 0; x < g.w; x++) {
      for (let i = shapes.length - 1; i >= 0; i--) {
        const f = shapes[i]
        if (segDist(x, y, rootX, rootY, f.tx, f.ty) <= f.r) { owner[y * g.w + x] = i; break }
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
      const along = Math.hypot(x - rootX, y - rootY) / f.len
      // border with the feather behind (drawn earlier): a shade line on the outer half
      const back = [own(x + 1, y), own(x - 1, y), own(x, y + 1), own(x, y - 1)].some((j) => j >= 0 && j < i)
      if (back && along > 0.45 && !f.covert) { put(g, x, y, 17); continue }
      const side = (x - rootX) * f.nx + (y - rootY) * f.ny
      put(g, x, y, f.covert ? (side > f.r * 0.5 ? 18 : 19) : side > f.r * 0.45 ? 17 : along > 0.7 ? 19 : 18)
    }
  }
}

// bread top poking out of a slot: rounded loaf top, crust rim, toasted face
function paintBread(g, x0, x1, yTop, yBottom) {
  const cx = (x0 + x1) / 2
  for (let y = yTop; y <= yBottom; y++) {
    for (let x = x0; x <= x1; x++) {
      // the slice's rounded shoulders
      const top = yTop + Math.max(0, Math.abs(x - cx) - (x1 - x0) / 2 + 3) ** 2 / 3
      if (y < top) continue
      const edge = x === x0 || x === x1 || y < top + 1
      put(g, x, y, edge ? 11 : (y < top + 2 ? 12 : (x - x0 < 2 ? 15 : 14)))
    }
  }
}

/** Toaster pose (0 up … 4 down) -> { w, h, px } palette indices. */
function buildToaster(pose) {
  const g = grid(TW, TH)
  const ang = WING_POSES[pose]
  // wings behind the body
  paintWing(g, BODY.x0 + 4, BODY.y0 + 7, -1, ang)
  paintWing(g, BODY.x1 - 4, BODY.y0 + 7, 1, ang)
  // two slices in the two slots
  paintBread(g, BODY.x0 + 7, BODY.x0 + 15, BODY.y0 - 7, BODY.y0 + 6)
  paintBread(g, BODY.x1 - 15, BODY.x1 - 7, BODY.y0 - 7, BODY.y0 + 6)
  // the loaf body: chrome, shaded as a rounded solid. Its reflection bands curve with the surface
  // (they bend upward toward the ends): a bright sky band, a curved specular streak, a dark horizon
  // and the reflected mint floor, then the lit lower edge.
  const b = BODY
  const hgt = b.y1 - b.y0
  const midX = (b.x0 + b.x1) / 2
  const halfW = (b.x1 - b.x0) / 2
  for (let y = b.y0 - 1; y <= b.y1 + 1; y++) {
    for (let x = b.x0 - 1; x <= b.x1 + 1; x++) {
      if (!inLoaf(x, y, b)) {
        // outline: transparent-or-wing pixel next to the body
        if (inLoaf(x + 1, y, b) || inLoaf(x - 1, y, b) || inLoaf(x, y + 1, b) || inLoaf(x, y - 1, b)) {
          if (get(g, x, y) < 11 || get(g, x, y) > 15) put(g, x, y, 1)
        }
        continue
      }
      const dx = Math.abs(x - midX) / halfW
      const v = (y - b.y0) / hgt + 0.16 * dx * dx      // curved bands
      let c
      if (v < 0.12) c = 4
      else if (v < 0.2) c = dx < 0.62 ? 5 : 4          // the specular streak
      else if (v < 0.3) c = 4
      else if (v < 0.46) c = 3
      else if (v < 0.54) c = 2
      else if (v < 0.62) c = 0                          // horizon
      else if (v < 0.76) c = -1                         // reflected colour
      else if (v < 0.9) c = 3
      else c = 2
      if (c === -1) { put(g, x, y, dx > 0.8 ? 8 : v < 0.69 ? 9 : 10); continue }
      if (dx > 0.88) c = Math.max(0, c - 2)
      else if (dx > 0.72) c = Math.max(0, c - 1)
      put(g, x, y, CHROME[c])
    }
  }
  // slot openings, following the rounded top
  for (const [s0, s1] of [[b.x0 + 7, b.x0 + 15], [b.x1 - 15, b.x1 - 7]]) {
    for (let x = s0 - 1; x <= s1 + 1; x++) {
      let ty = b.y0
      while (!inLoaf(x, ty, b) && ty < b.y1) ty++
      put(g, x, ty, 1)
      put(g, x, ty + 1, 3)
      if (x >= s0 && x <= s1) put(g, x, ty - 1, x === s0 || x === s1 ? 11 : 12)
    }
  }
  // the hot specular: a long white streak along the shoulder and a star glint on it
  for (let x = b.x0 + 6; x <= b.x1 - 9; x++) {
    const dx = Math.abs(x - midX) / halfW
    const y = Math.round(b.y0 + 0.16 * hgt - 0.16 * dx * dx * hgt)
    if (inLoaf(x, y, b) && get(g, x, y) !== 1) put(g, x, y, 7)
  }
  const gx = b.x0 + 9, gy = Math.round(b.y0 + 0.16 * hgt - 0.16 * (Math.abs(gx - midX) / halfW) ** 2 * hgt)
  for (const [ddx, ddy] of [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1], [2, 0], [-2, 0]]) put(g, gx + ddx, gy + ddy, 7)
  // a soft rim light down the right end
  for (let y = b.y0 + 6; y <= b.y1 - 6; y++) {
    let x = b.x1
    while (!inLoaf(x, y, b) && x > midX) x--
    put(g, x - 1, y, 5)
  }
  // streamline speed ribs on the lower front (left), tapering
  const ribs = [[b.y1 - 5, 13], [b.y1 - 3, 9]]
  for (const [y, len] of ribs) {
    for (let x = b.x0 + 3; x < b.x0 + 3 + len; x++) { put(g, x, y, 7); put(g, x, y + 1, 2) }
    put(g, b.x0 + 3 + len, y, 10)
  }
  // the dial: dark ring, mint knob, white pointer
  const dcx = b.x1 - 7, dcy = b.y1 - 5
  for (let y = dcy - 3; y <= dcy + 3; y++) {
    for (let x = dcx - 3; x <= dcx + 3; x++) {
      const d = Math.hypot(x - dcx, y - dcy)
      if (d <= 1.6) put(g, x, y, 10)
      else if (d <= 2.6) put(g, x, y, 8)
      else if (d <= 3.2) put(g, x, y, 1)
    }
  }
  put(g, dcx, dcy - 1, 7)
  // the side lever: a dark slot in the body's right side and a stem out to a round mint knob
  const ly = b.y1 - 9
  for (let y = ly - 2; y <= ly + 2; y++) put(g, b.x1, y, 1)
  for (let x = b.x1 + 1; x <= b.x1 + 3; x++) { put(g, x, ly - 1, 1); put(g, x, ly, 5); put(g, x, ly + 1, 1) }
  for (let y = ly - 3; y <= ly + 3; y++) {
    for (let x = b.x1 + 3; x <= b.x1 + 9; x++) {
      const d = Math.hypot(x - (b.x1 + 6), y - ly)
      if (d <= 2.1) put(g, x, y, x + y < b.x1 + 6 + ly ? 10 : 9)
      else if (d <= 3.1) put(g, x, y, 1)
    }
  }
  // chrome base band, a touch wider than the body, and stubby feet
  for (let x = b.x0 - 1; x <= b.x1 + 1; x++) {
    put(g, x, b.y1 + 1, 1)
    put(g, x, b.y1 + 2, x < b.x0 + 3 || x > b.x1 - 3 ? 4 : 6)
    put(g, x, b.y1 + 3, 3)
    put(g, x, b.y1 + 4, 1)
  }
  for (const fx of [b.x0 + 3, b.x1 - 6]) {
    for (let x = fx; x < fx + 4; x++) { put(g, x, b.y1 + 5, x === fx || x === fx + 3 ? 1 : 2); put(g, x, b.y1 + 6, 1) }
  }
  return g
}

/** A golden-brown toast slice: crust rim, toasted face, highlight. */
function buildToast() {
  const w = 24, h = 24
  const g = grid(w, h)
  // a bread slice: a square-ish body under a wider rounded crown with a slight dip in the middle
  const inside = (x, y) => {
    if (y >= 10 && y <= 21 && x >= 4 && x <= 19) return true
    if (y > 12 || y < 2) return false
    const e = ((x - 11.5) / 9.6) ** 2 + ((y - 9.5) / 6.4) ** 2 <= 1
    return e && !(Math.hypot(x - 11.5, y - 1.6) < 2.4)
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!inside(x, y)) {
        if (inside(x + 1, y) || inside(x - 1, y) || inside(x, y + 1) || inside(x, y - 1)) put(g, x, y, 1)
        continue
      }
      const rim = !inside(x + 1, y) || !inside(x - 1, y) || !inside(x, y + 1) || !inside(x, y - 1)
      const rim2 = !inside(x + 2, y) || !inside(x - 2, y) || !inside(x, y + 2) || !inside(x, y - 2)
      let c = rim ? 11 : rim2 ? 12 : 13
      if (!rim2 && x + y < 17) c = 15               // highlight toward the upper left
      else if (!rim2 && x + y < 21) c = 14
      put(g, x, y, c)
    }
  }
  // a few darker toasting marks
  for (const [x, y] of [[13, 14], [14, 14], [9, 17], [16, 18], [17, 18], [11, 12]]) put(g, x, y, 12)
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

/** Integer pixel scale for a canvas height: a toaster about a ninth of the screen tall. */
function spriteScale(height) {
  return Math.max(2, Math.round(height / (TH * 7.5)))
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

// flight direction: left and down (unit-ish; y per x as After Dark's shallow dive)
const DIR = { x: -0.86, y: 0.51 }

module.exports = {
  PALETTE, TW, TH, WING_POSES, buildToaster, buildToast, flapPose,
  spriteScale, formation, wrap, itemPos, DIR
}
