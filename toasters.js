// Flying toasters for the visualizer's "toast" scene: the sprites (rendered from Marcy's Blender model,
// assets/toaster/: 8 wing-flap frames and a toast slice) and the flight they fly. Pure, no DOM:
// visualizer.html loads the images once and draws what stepFlight() leaves in the pool;
// test/toasters.test.js covers the flight math and the assets.
//
// The flight (After Dark's Flying Toasters): the sky starts empty. Every flyer (toaster or slice of
// toast) waits its own random moment, launches from just off the top or right edge, swoops in fast and
// eases down to its own cruising speed (each a little different, so they drift past each other), flies
// the diagonal its nose points along (DIR) and, once it's fully off the bottom/left, waits its own
// random delay and launches again with a new swoop and a new speed. The number of flyers is set so
// that, once full, the sky holds the same density as the old formation (one per lattice cell).
// Faster flyers count as nearer: they draw on top and a touch larger. The music sets the wing flap
// rate (and nudges the speed of everyone); the flap runs faster during a swoop.
//
// Cost: a fixed pool of flyer objects (no per-frame allocation), a draw order that is re-sorted only
// when a flyer launches (insertion, in place), and one cached-frame drawImage per visible flyer.

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

/** Drawn toaster size for a canvas height: about a sixth of the screen tall (any scale). */
function spriteSize(height) {
  const k = Math.max(0.25, height / 6 / TOASTER_SIZE.h)
  return { w: Math.round(TOASTER_SIZE.w * k), h: Math.round(TOASTER_SIZE.h * k), k }
}

// small deterministic PRNG (tests); the visualizer passes Math.random
function rng(seed) {
  let s = seed >>> 0 || 1
  return () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296 }
}

// flight direction on screen: where the toaster's nose (lever end) points in the renders, measured
// along the base's long edge (upper right -> lower left)
const DIR = (() => { const x = -165, y = 131, l = Math.hypot(x, y); return { x: x / l, y: y / l } })()

// --- tuning ---
const CRUISE = 0.5              // mean cruising speed, sprite heights per second (as the old formation)
const CRUISE_SPREAD = 0.18      // each flyer cruises at CRUISE × (1 ± up to 18 %)
const SWOOP_BOOST = 3.2         // launch speed = 3.2 × its cruise …
const SWOOP_MIN = 1.2, SWOOP_MAX = 1.8   // … easing down to cruise over 1.2–1.8 s
const FLAP_BOOST = 2.4          // wings beat up to 2.4× faster at launch, settling with the swoop
const DEPTH_SCALE = 0.6         // size = 1 + 0.6 × (relative speed − 1): ±11 % at the spread's ends
const DELAY_MIN = 0.4, DELAY_MAX = 2.4   // re-entry wait after leaving, seconds
const RETRY_MIN = 0.12, RETRY_MAX = 0.3  // launch spot taken: try again this much later
const SPAWN_TRIES = 6           // candidate launch spots per launch; the one farthest from the others wins
const MIN_SEP = 1.0             // launch spot must be ≥ 1 sprite height from every flyer in the air
const MARGIN = 0.6              // launch/leave this many sprite sizes (from the centre) off screen
const TOAST_SHARE = 0.2         // ~1 in 5 is a slice of toast

/** Lattice cell of the old formation: the sky's target density is one flyer per cell. */
function cellSize(sw, sh) { return { cw: Math.round(sw * 1.5), ch: Math.round(sh * 1.35) } }

/** How many flyers should be on screen once the sky is full (same density as the old formation). */
function targetOnScreen(W, H, sw, sh) { const c = cellSize(sw, sh); return (W * H) / (c.cw * c.ch) }

/**
 * Swoop speed factor for swoop progress u (0 = launch, 1 = done): SWOOP_BOOST at launch, a smooth
 * ease-out (cubic, zero slope at the end) down to exactly 1 (cruise), 1 from then on. Monotonic.
 */
function swoopFactor(u) {
  if (!(u < 1)) return 1
  const r = 1 - (u > 0 ? u : 0)
  return 1 + (SWOOP_BOOST - 1) * r * r * r
}

/** Wing-flap rate factor during the swoop: FLAP_BOOST at launch, eases to 1 with the swoop. */
function flapBoost(u) {
  if (!(u < 1)) return 1
  const r = 1 - (u > 0 ? u : 0)
  return 1 + (FLAP_BOOST - 1) * r * r
}

/** A new cruising speed factor, CRUISE_SPREAD around 1. */
function cruiseFactor(rand) { return 1 + CRUISE_SPREAD * (2 * rand() - 1) }

/** Draw scale for a cruise factor: faster = nearer = a touch larger. */
function depthScale(cruise) { return 1 + DEPTH_SCALE * (cruise - 1) }

/** The wait before a flyer that left re-enters, seconds. */
function reentryDelay(rand) { return DELAY_MIN + (DELAY_MAX - DELAY_MIN) * rand() }

// the launch line: off the top edge (weight W·|DIR.y|) and off the right edge (weight H·|DIR.x|),
// weighted by how much of the diagonal flow crosses each, so coverage is even across the screen
function edgeWeights(W, H) { return { top: W * Math.abs(DIR.y), right: H * Math.abs(DIR.x) } }

/** Launch centre for s in [0, 1): along the top edge, then down the right edge, fully off screen. */
function spawnPoint(s, W, H, sw, sh, out) {
  const e = edgeWeights(W, H)
  const t = s * (e.top + e.right)
  const o = out || { x: 0, y: 0 }
  if (t < e.top) { o.x = t / Math.abs(DIR.y); o.y = -MARGIN * sh * (1 + CRUISE_SPREAD) }
  else { o.x = W + MARGIN * sw * (1 + CRUISE_SPREAD); o.y = (t - e.top) / Math.abs(DIR.x) }
  return o
}

/** Has a flyer centred at (x, y) fully left (past the left or bottom edge)? */
function hasLeft(x, y, W, H, sw, sh) {
  return x < -MARGIN * sw * (1 + CRUISE_SPREAD) || y > H + MARGIN * sh * (1 + CRUISE_SPREAD)
}

/**
 * Pool size for a W×H sky: enough flyers that, with their transit and re-entry waits, the steady
 * on-screen count matches targetOnScreen. Mean path = mean chord through the screen (area over the
 * flow's projected width) plus the off-screen run-in and run-out; the swoop shortens the transit.
 */
function poolSize(W, H, sw, sh) {
  const e = edgeWeights(W, H), lp = e.top + e.right
  const chord = (W * H) / lp
  const mt = MARGIN * sh * (1 + CRUISE_SPREAD), mr = MARGIN * sw * (1 + CRUISE_SPREAD)
  // run-in + run-out along DIR, averaged over the launch line: top launches cross mt/|DIR.y| (weight
  // W·|DIR.y|), right launches mr/|DIR.x| (weight H·|DIR.x|); the exits mirror them
  const margins = 2 * (W * mt + H * mr) / lp
  const v = CRUISE * sh
  const swoopGain = (SWOOP_BOOST - 1) * ((SWOOP_MIN + SWOOP_MAX) / 2) / 4   // seconds saved by the swoop
  const transit = Math.max(0.5, (chord + margins) / v - swoopGain)
  const cycle = transit + (DELAY_MIN + DELAY_MAX) / 2
  const onFrac = (chord / v) / cycle
  // × 1.04: blocked launch spots wait a little longer than the plain delay (measured over 40 seeds)
  return Math.max(2, Math.round(1.04 * targetOnScreen(W, H, sw, sh) / onFrac))
}

function newFlyer(id) {
  return { id, active: false, wait: 0, x: 0, y: 0, cruise: 1, scale: 1, age: 0, swoop: 1.5, flap: 0, rock: 0, toast: false, born: -1 }
}

/**
 * A flight for a W×H sky with sw×sh sprites. Every flyer starts waiting (empty sky) with a launch
 * moment spread over about one transit, so the sky fills gradually and evenly.
 * lifetime: one per visualizer window (a scene re-entry empties it in place with resetFlight); the
 * pool grows only on a resize to a bigger sky and never shrinks (extra flyers just stop re-entering).
 */
function createFlight(W, H, sw, sh, rand = Math.random) {
  const fl = { W, H, sw, sh, rand, time: 0, limit: 0, pool: [], order: [], spot: { x: 0, y: 0 } }
  resizeFlight(fl, W, H, sw, sh)
  resetFlight(fl)
  return fl
}

// the first launches spread over ~0.8 of a mean crossing (s): gradual, but no long empty wait
function fillSpan(fl) {
  const e = edgeWeights(fl.W, fl.H)
  return Math.max(1, 0.8 * (fl.W * fl.H) / (e.top + e.right) / (CRUISE * fl.sh))
}

/** Empty the sky and schedule every flyer's first launch (scene (re)entry). */
function resetFlight(fl) {
  fl.time = 0
  const span = fillSpan(fl)
  // loop: NOT-WORTH — the pool (~50 flyers), once per scene (re)entry
  for (const f of fl.pool) {
    f.active = false
    f.born = -1
    f.wait = fl.rand() * span
  }
}

/**
 * New sky size: scale the flyers' positions with it (they keep flying), re-size the pool for the new
 * density. Bigger: new flyers join, waiting a random moment. Smaller: the extras finish their flight and
 * don't come back.
 */
function resizeFlight(fl, W, H, sw, sh) {
  if (fl.W && fl.H && (fl.W !== W || fl.H !== H)) {
    const kx = W / fl.W, ky = H / fl.H
    // loop: NOT-WORTH — the pool (~50), once per window resize
    for (const f of fl.pool) { f.x *= kx; f.y *= ky }
  }
  fl.W = W; fl.H = H; fl.sw = sw; fl.sh = sh
  fl.limit = poolSize(W, H, sw, sh)
  const span = fillSpan(fl)
  // loop: NOT-WORTH — grows the pool to its new size (≤ ~50 new flyers), once per resize
  while (fl.pool.length < fl.limit) {
    const f = newFlyer(fl.pool.length)
    f.wait = fl.rand() * span
    fl.pool.push(f)
    placeInOrder(fl, f, true)
  }
}

// keep fl.order (pool indices) sorted by cruise, slowest (farthest) first: move f to its place
function placeInOrder(fl, f, isNew) {
  const o = fl.order
  let i = isNew ? o.push(f.id) - 1 : o.indexOf(f.id)
  // loop: HOT-PATH-OK — one insertion-sort step over the order (≤ ~50), per launch only
  while (i > 0 && fl.pool[o[i - 1]].cruise > f.cruise) { o[i] = o[i - 1]; o[--i] = f.id }
  while (i < o.length - 1 && fl.pool[o[i + 1]].cruise < f.cruise) { o[i] = o[i + 1]; o[++i] = f.id }
}

// smallest distance from (x, y) to any flyer in the air
function nearest(fl, x, y) {
  let best = Infinity
  const pool = fl.pool
  // loop: HOT-PATH-OK — the pool (~50 flyers) per tried spot, only for a flyer whose wait ran out
  for (let i = 0; i < pool.length; i++) {
    const g = pool[i]
    if (!g.active) continue
    const d = Math.hypot(g.x - x, g.y - y)
    if (d < best) best = d
  }
  return best
}

// try to launch f: the free-est of SPAWN_TRIES spots along the launch line, or wait a moment
// loop: HOT-PATH-OK — launch retry · every 0.12–0.3 s of scene time · while every tried spot is within MIN_SEP of a
// flyer · ends when the edge clears (flyers there move on within a second) · cost SPAWN_TRIES × pool
// distance checks per try, only for a flyer whose wait ran out
function launch(fl, f) {
  const p = fl.spot
  let bx = 0, by = 0, bd = -1
  for (let k = 0; k < SPAWN_TRIES; k++) {
    spawnPoint(fl.rand(), fl.W, fl.H, fl.sw, fl.sh, p)
    const d = nearest(fl, p.x, p.y)
    if (d > bd) { bd = d; bx = p.x; by = p.y }
  }
  if (bd < MIN_SEP * fl.sh) { f.wait = RETRY_MIN + (RETRY_MAX - RETRY_MIN) * fl.rand(); return false }
  f.active = true
  f.x = bx; f.y = by
  f.age = 0
  f.swoop = SWOOP_MIN + (SWOOP_MAX - SWOOP_MIN) * fl.rand()
  f.cruise = cruiseFactor(fl.rand)
  f.scale = depthScale(f.cruise)
  f.toast = fl.rand() < TOAST_SHARE
  f.flap = fl.rand()
  f.rock = fl.rand()
  f.born = fl.time
  placeInOrder(fl, f, false)
  return true
}

/**
 * Advance the flight by dt seconds. speedMul nudges everyone's speed (the music); flapRate is the
 * wing-beat rate in flap cycles per second (the music). Movement first, then launches, so a flyer
 * launched this step sits on its launch spot. No allocation.
 * loop: called once per animation frame by visualizer.html's rAF loop while the toast scene shows
 * (Chromium stops rAF when the window is hidden) · cost one pass over the pool (~50 flyers) plus launches.
 * error: none thrown; dt is clamped by the caller (≤ 50 ms) so a stall can't teleport flyers.
 */
function stepFlight(fl, dt, speedMul = 1, flapRate = 1) {
  fl.time += dt
  const v = CRUISE * fl.sh * speedMul
  const W = fl.W, H = fl.H, sw = fl.sw, sh = fl.sh
  const pool = fl.pool
  // loop: HOT-PATH-OK — two passes over the pool (~50 flyers) per animation frame while the toast scene shows; no allocation
  for (let i = 0; i < pool.length; i++) {
    const f = pool[i]
    if (!f.active) continue
    const u = f.age / f.swoop
    const d = v * f.cruise * swoopFactor(u) * dt
    f.x += DIR.x * d; f.y += DIR.y * d
    f.flap += dt * flapRate * flapBoost(u)
    f.age += dt
    if (hasLeft(f.x, f.y, W, H, sw, sh)) {
      f.active = false
      f.wait = reentryDelay(fl.rand)
    }
  }
  // loop: HOT-PATH-OK — the second pass: waiting flyers count down, launches (see above)
  for (let i = 0; i < pool.length; i++) {
    const f = pool[i]
    if (f.active || i >= fl.limit) continue
    f.wait -= dt
    if (f.wait <= 0) launch(fl, f)
  }
}

/** Flyers whose centre is on screen. */
function onScreen(fl) {
  let n = 0
  // loop: NOT-WORTH — the pool (~50); used by the tests, not per frame
  for (const f of fl.pool) if (f.active && f.x >= 0 && f.x < fl.W && f.y >= 0 && f.y < fl.H) n++
  return n
}

module.exports = {
  FRAMES, TOASTER_FILES, TOAST_FILE, TOASTER_SIZE, TOAST_SIZE, flapFrame, spriteSize, rng, DIR,
  CRUISE, CRUISE_SPREAD, SWOOP_BOOST, SWOOP_MIN, SWOOP_MAX, FLAP_BOOST, DELAY_MIN, DELAY_MAX, MIN_SEP, MARGIN,
  cellSize, targetOnScreen, swoopFactor, flapBoost, cruiseFactor, depthScale, reentryDelay,
  spawnPoint, hasLeft, poolSize, createFlight, resetFlight, resizeFlight, stepFlight, onScreen
}
