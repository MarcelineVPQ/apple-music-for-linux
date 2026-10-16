// Flying toasters for the visualizer's "toast" scene: the sprites (rendered from Marcy's Blender model,
// assets/toaster/: 8 wing-flap frames and a toast slice) and the formation they fly in. Pure, no DOM:
// visualizer.html loads the images once; test/toasters.test.js covers the formation/wrap math and
// the assets.
//
// The formation: a staggered, jittered lattice that always fills the screen. Everything flies the same
// diagonal (upper right -> lower left, where the toasters' noses point) at the same speed on a torus a
// little larger than the screen, so a toaster leaving at the bottom/left comes back at the top/right and
// the screen never empties. The population never depends on the music; the music sets the wing flap
// rate (and nudges the speed).

// the sprite files (relative to the app root) and their pixel sizes
const FRAMES = 8
const TOASTER_FILES = Array.from({ length: FRAMES }, (_, i) => 'assets/toaster/toaster_' + i + '.png')
const TOAST_FILE = 'assets/toaster/toast.png'
const TOASTER_SIZE = { w: 240, h: 256 }    // every frame has the same crop, so frames never jitter
const TOAST_SIZE = { w: 136, h: 138 }      // same render scale as the toaster

/** Flap frame (0…7) for a phase in turns (any real number): one turn loops the 8 rendered frames. */
function flapFrame(phase) {
  const p = phase - Math.floor(phase)
  return Math.min(FRAMES - 1, Math.floor(p * FRAMES))
}

// --- formation ---

/** Drawn toaster size for a canvas height: about a sixth of the screen tall (any scale). */
function spriteSize(height) {
  const k = Math.max(0.25, height / 6 / TOASTER_SIZE.h)
  return { w: Math.round(TOASTER_SIZE.w * k), h: Math.round(TOASTER_SIZE.h * k), k }
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
  const cw = Math.round(sw * 1.5)
  const ch = Math.round(sh * 1.35)
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

// flight direction on screen: where the toaster's nose (lever end) points in the renders, measured
// along the base's long edge (upper right -> lower left)
const DIR = (() => { const x = -165, y = 131, l = Math.hypot(x, y); return { x: x / l, y: y / l } })()

module.exports = {
  FRAMES, TOASTER_FILES, TOAST_FILE, TOASTER_SIZE, TOAST_SIZE, flapFrame,
  spriteSize, formation, wrap, itemPos, DIR
}
