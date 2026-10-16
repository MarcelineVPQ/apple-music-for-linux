const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')
const T = require('../toasters')

const ROOT = path.join(__dirname, '..')
const FPS = 60, DT = 1 / FPS

// PNG width/height from the IHDR chunk
function pngSize(file) {
  const b = fs.readFileSync(file)
  assert.equal(b.toString('latin1', 1, 4), 'PNG', file + ' is a PNG')
  return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) }
}

function sky(W, H, seed = 1) {
  const { w, h } = T.spriteSize(H)
  return T.createFlight(W, H, w, h, T.rng(seed))
}

test('assets: all 9 sprite files exist, have the declared sizes and ship in the AppImage', () => {
  const files = [...T.TOASTER_FILES, T.TOAST_FILE]
  assert.equal(files.length, 9)
  const shipped = require('../package.json').build.files
  let total = 0
  for (const f of files) {
    const full = path.join(ROOT, f)
    assert.ok(fs.existsSync(full), f + ' exists')
    assert.ok(shipped.includes(f) || shipped.some((g) => f.startsWith(g.replace(/\*\*.*$/, ''))), f + ' is in package.json build.files')
    total += fs.statSync(full).size
  }
  for (const f of T.TOASTER_FILES) assert.deepEqual(pngSize(path.join(ROOT, f)), T.TOASTER_SIZE)
  assert.deepEqual(pngSize(path.join(ROOT, T.TOAST_FILE)), T.TOAST_SIZE)
  assert.ok(total < 1024 * 1024, 'sprites stay under 1 MB (' + total + ' bytes)')
})

test('flapFrame: one turn loops the 8 frames in order, wraps per turn', () => {
  const seq = []
  for (let k = 0; k < 8; k++) seq.push(T.flapFrame((k + 0.5) / 8))
  assert.deepEqual(seq, [0, 1, 2, 3, 4, 5, 6, 7])
  assert.equal(T.flapFrame(3.3), T.flapFrame(0.3))
  assert.equal(T.flapFrame(-0.25), T.flapFrame(0.75))
  assert.equal(T.flapFrame(0.999999), 7)
})

test('spriteSize: about a sixth of the screen tall, aspect kept, grows with the screen', () => {
  const hd = T.spriteSize(1080), uhd = T.spriteSize(2160)
  assert.equal(hd.h, 180)
  assert.ok(Math.abs(hd.w / hd.h - T.TOASTER_SIZE.w / T.TOASTER_SIZE.h) < 0.01)
  assert.ok(uhd.h === hd.h * 2)
})

test('DIR: flies down and to the left (top right -> bottom left), unit length', () => {
  assert.ok(T.DIR.x < 0 && T.DIR.y > 0)
  assert.ok(Math.abs(Math.hypot(T.DIR.x, T.DIR.y) - 1) < 1e-9)
})

test('swoop: starts fast, eases down monotonically and smoothly, reaches exactly cruise', () => {
  assert.equal(T.swoopFactor(0), T.SWOOP_BOOST)
  assert.equal(T.swoopFactor(1), 1)
  assert.equal(T.swoopFactor(7), 1)
  assert.equal(T.swoopFactor(-1), T.SWOOP_BOOST)
  let prev = Infinity
  for (let i = 0; i <= 1000; i++) {
    const v = T.swoopFactor(i / 1000)
    assert.ok(v <= prev, 'non-increasing at ' + i)
    assert.ok(v >= 1)
    prev = v
  }
  // ease-out: no kink at the end (slope ~0 as it meets cruise), steepest at launch
  assert.ok(T.swoopFactor(0.99) - 1 < 1e-5)
  assert.ok(T.swoopFactor(0) - T.swoopFactor(0.1) > T.swoopFactor(0.5) - T.swoopFactor(0.6))
  // flap boost follows the same shape and settles to the music's rate
  assert.equal(T.flapBoost(0), T.FLAP_BOOST)
  assert.equal(T.flapBoost(1), 1)
  for (let i = 1; i <= 100; i++) assert.ok(T.flapBoost(i / 100) <= T.flapBoost((i - 1) / 100))
})

test('swoop in flight: a flyer launches fast and settles to its own cruise within its swoop time', () => {
  const fl = sky(1920, 1080, 3)
  let f = null
  for (let i = 0; i < FPS * 30 && !f; i++) {
    T.stepFlight(fl, DT)
    f = fl.pool.find((g) => g.active && g.born === fl.time)
  }
  assert.ok(f, 'something launched')
  const speeds = []
  for (let i = 0; i < FPS * 2.5 && f.active; i++) {
    const x = f.x, y = f.y
    T.stepFlight(fl, DT)
    if (f.active) speeds.push(Math.hypot(f.x - x, f.y - y) / DT)
  }
  const cruise = T.CRUISE * fl.sh * f.cruise
  assert.ok(Math.abs(speeds[0] / cruise - T.SWOOP_BOOST) < 0.1, 'launch ~' + T.SWOOP_BOOST + '× cruise')
  for (let i = 1; i < speeds.length; i++) assert.ok(speeds[i] <= speeds[i - 1] + 1e-9)
  assert.ok(Math.abs(speeds[speeds.length - 1] - cruise) < 1e-6, 'settles to its cruise')
  // flight stays parallel to the nose
  const x0 = f.x, y0 = f.y
  T.stepFlight(fl, DT)
  const a = Math.atan2(f.y - y0, f.x - x0), b = Math.atan2(T.DIR.y, T.DIR.x)
  assert.ok(Math.abs(a - b) < 1e-9)
})

test('cruise speeds vary ±18 %, faster is nearer (bigger)', () => {
  const r = T.rng(9)
  let lo = Infinity, hi = 0
  for (let i = 0; i < 2000; i++) { const c = T.cruiseFactor(r); lo = Math.min(lo, c); hi = Math.max(hi, c) }
  assert.ok(lo >= 1 - T.CRUISE_SPREAD && hi <= 1 + T.CRUISE_SPREAD)
  assert.ok(lo < 0.86 && hi > 1.14, 'uses the spread')
  assert.ok(T.depthScale(1.1) > T.depthScale(1) && T.depthScale(1) === 1 && T.depthScale(0.9) < 1)
})

test('re-entry delay: random, within its bounds, not constant', () => {
  const r = T.rng(5)
  const seen = new Set()
  for (let i = 0; i < 500; i++) {
    const d = T.reentryDelay(r)
    assert.ok(d >= T.DELAY_MIN && d <= T.DELAY_MAX)
    seen.add(Math.round(d * 10))
  }
  assert.ok(seen.size > 10)
})

test('spawn points: just off the top or right edge, fully off screen, covering both edges', () => {
  const W = 1920, H = 1080, { w: sw, h: sh } = T.spriteSize(H)
  let top = 0, right = 0
  for (let i = 0; i < 1000; i++) {
    const p = T.spawnPoint(i / 1000, W, H, sw, sh)
    if (p.y < 0) { top++; assert.ok(p.x >= 0 && p.x <= W && p.y <= -T.MARGIN * sh) }
    else { right++; assert.ok(p.x >= W + T.MARGIN * sw && p.y >= 0 && p.y <= H) }
  }
  // the flow crosses the top edge W·|DIR.y| and the right edge H·|DIR.x|: weighted by that
  const share = (W * T.DIR.y) / (W * T.DIR.y - H * T.DIR.x)
  assert.ok(Math.abs(top / 1000 - share) < 0.01)
  assert.ok(right > 0)
})

test('scheduler: sky starts empty, fills gradually, staggered launches, never two at one spot', () => {
  const fl = sky(1920, 1080, 1)
  assert.equal(T.onScreen(fl), 0)
  assert.ok(fl.pool.every((f) => !f.active))
  const launchTimes = []
  for (let i = 0; i < FPS * 60; i++) {
    T.stepFlight(fl, DT)
    for (const f of fl.pool) {
      if (!f.active || f.born !== fl.time) continue
      launchTimes.push(fl.time)
      for (const g of fl.pool) {
        if (g === f || !g.active) continue
        assert.ok(Math.hypot(g.x - f.x, g.y - f.y) >= T.MIN_SEP * fl.sh, 'launch spot is clear')
      }
    }
    if (i === FPS * 1 - 1) assert.ok(T.onScreen(fl) <= 2, 'first second: nearly empty')
  }
  // staggered: launches spread out, never a whole wave in one frame
  const perFrame = new Map()
  for (const t of launchTimes) perFrame.set(t, (perFrame.get(t) || 0) + 1)
  assert.ok(Math.max(...perFrame.values()) <= 3)
  const first = launchTimes.filter((t) => t < 10)
  assert.ok(first.length > 10 && new Set(first.map((t) => Math.floor(t))).size >= 8, 'first launches spread over seconds')
})

test('density: full within 15 s, then steady at the old formation density, even across the screen', () => {
  for (const [W, H] of [[1920, 1080], [1280, 720], [3840, 2160], [1000, 1400], [2560, 1080]]) {
    for (const seed of [1, 2]) {
      const fl = sky(W, H, seed)
      const target = T.targetOnScreen(W, H, fl.sw, fl.sh)
      for (let i = 0; i < FPS * 15; i++) T.stepFlight(fl, DT)
      // full: average over the next 3 s is near the target (worst of 200 seeded runs: 0.76; small skies
      // hold ~13 flyers, so they wobble more)
      let s = 0
      for (let i = 0; i < FPS * 3; i++) { T.stepFlight(fl, DT); s += T.onScreen(fl) }
      assert.ok(s / (FPS * 3) > target * 0.7, `${W}x${H}: full by 15 s (${(s / FPS / 3).toFixed(1)} of ${target.toFixed(1)})`)
      // steady: every 10 s window over the next 4 minutes stays near the target
      const quads = [0, 0, 0, 0]
      for (let w = 0; w < 24; w++) {
        let sum = 0
        for (let i = 0; i < FPS * 10; i++) {
          T.stepFlight(fl, DT)
          sum += T.onScreen(fl)
          if (i % 30 === 0) {
            for (const f of fl.pool) {
              if (!f.active || f.x < 0 || f.x >= W || f.y < 0 || f.y >= H) continue
              quads[(f.x < W / 2 ? 0 : 1) + (f.y < H / 2 ? 0 : 2)]++
            }
          }
        }
        const mean = sum / (FPS * 10)
        assert.ok(Math.abs(mean - target) < target * 0.15, `${W}x${H} window ${w}: ${mean.toFixed(1)} vs ${target.toFixed(1)}`)
      }
      const qm = quads.reduce((a, b) => a + b) / 4
      for (const q of quads) assert.ok(Math.abs(q - qm) < qm * 0.25, `${W}x${H} quadrants even: ${quads}`)
    }
  }
})

test('depth order: drawn slowest first, so faster (nearer) flyers land on top; kept through re-launches', () => {
  const fl = sky(1920, 1080, 4)
  for (let i = 0; i < FPS * 120; i++) {
    T.stepFlight(fl, DT)
    if (i % 60) continue
    const o = fl.order
    assert.equal(o.length, fl.pool.length)
    assert.equal(new Set(o).size, o.length)
    for (let k = 1; k < o.length; k++) assert.ok(fl.pool[o[k - 1]].cruise <= fl.pool[o[k]].cruise)
  }
})

test('pool: the same flyer objects for 10,000 frames, no growth; reset empties the sky in place', () => {
  const fl = sky(1920, 1080, 6)
  const objs = fl.pool.slice()
  const order = fl.order
  let relaunched = 0
  const born = new Map()
  for (let i = 0; i < 10000; i++) {
    T.stepFlight(fl, DT, 0.9 + 0.35 * Math.abs(Math.sin(i / 300)), 2)
    for (const f of fl.pool) if (f.active && born.get(f) !== f.born) { if (born.has(f)) relaunched++; born.set(f, f.born) }
  }
  assert.equal(fl.pool.length, objs.length)
  assert.ok(fl.pool.every((f, i) => f === objs[i]))
  assert.equal(fl.order, order)
  assert.equal(fl.order.length, objs.length)
  assert.ok(relaunched > objs.length, 'flyers are reused (' + relaunched + ' re-launches)')
  T.resetFlight(fl)
  assert.equal(T.onScreen(fl), 0)
  assert.ok(fl.pool.every((f, i) => f === objs[i] && !f.active))
})

test('resize: flyers keep flying, positions scale with the sky, density follows the new size', () => {
  const fl = sky(1920, 1080, 7)
  for (let i = 0; i < FPS * 30; i++) T.stepFlight(fl, DT)
  const before = fl.pool.filter((f) => f.active).map((f) => [f, f.x / 1920, f.y / 1080])
  const n0 = fl.pool.length
  // smaller: same flyers, positions scaled, extras stop re-entering
  let s = T.spriteSize(600)
  T.resizeFlight(fl, 900, 600, s.w, s.h)
  for (const [f, rx, ry] of before) {
    assert.ok(f.active)
    assert.ok(Math.abs(f.x / 900 - rx) < 1e-9 && Math.abs(f.y / 600 - ry) < 1e-9)
  }
  assert.equal(fl.pool.length, n0)
  for (let i = 0; i < FPS * 60; i++) T.stepFlight(fl, DT)
  assert.ok(fl.pool.slice(fl.limit).every((f) => !f.active))
  let sum = 0
  for (let i = 0; i < FPS * 30; i++) { T.stepFlight(fl, DT); sum += T.onScreen(fl) }
  const t1 = T.targetOnScreen(900, 600, s.w, s.h)
  assert.ok(Math.abs(sum / FPS / 30 - t1) < t1 * 0.25, 'small sky density ' + (sum / FPS / 30).toFixed(1) + ' vs ' + t1.toFixed(1))
  // wider: the pool grows once, order covers every flyer
  s = T.spriteSize(1080)
  T.resizeFlight(fl, 3440, 1080, s.w, s.h)
  assert.ok(fl.pool.length > n0)
  assert.equal(fl.order.length, fl.pool.length)
  sum = 0
  for (let i = 0; i < FPS * 30; i++) T.stepFlight(fl, DT)
  for (let i = 0; i < FPS * 30; i++) { T.stepFlight(fl, DT); sum += T.onScreen(fl) }
  const t2 = T.targetOnScreen(3440, 1080, s.w, s.h)
  assert.ok(Math.abs(sum / FPS / 30 - t2) < t2 * 0.2, 'wide sky density ' + (sum / FPS / 30).toFixed(1) + ' vs ' + t2.toFixed(1))
})

test('flap: each flyer keeps its own phase, beats faster during the swoop', () => {
  const fl = sky(1920, 1080, 8)
  for (let i = 0; i < FPS * 20; i++) T.stepFlight(fl, DT, 1, 2)
  const act = fl.pool.filter((f) => f.active)
  assert.ok(new Set(act.map((f) => T.flapFrame(f.flap))).size > 3, 'phases differ')
  const young = act.find((f) => f.age < 0.2), old = act.find((f) => f.age > 3)
  if (young && old) {
    const y0 = young.flap, o0 = old.flap
    T.stepFlight(fl, DT, 1, 2)
    assert.ok(young.flap - y0 > old.flap - o0)
  }
})
