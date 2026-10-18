// Settings → Experimental → Dithered cover glow (gfx-model.js expGlowDither): CSS for Apple's page that
// breaks the visible steps in the soft glow around an album's cover. Pure (Node's zlib only), so
// node --test covers it; main.js adds the CSS to Apple's page through css-replacer.js.
//
// Why (docs/research/hdr-hw-accel-apple-music-2026-10.md §1–2.4): the glow is Apple's
// `.artwork__radiosity`, a blurred copy of the still cover (blur 20px, saturate 2, opacity .3 in dark),
// scaled .88 from the bottom centre. Chromium doesn't dither a CSS filter's 8-bit result, so its tail
// fades 7, 6, 4, 3, 2, 1, 0 in flat rings up to ~40 px wide (Marcy's screenshot, §1.1), and an HDR
// desktop at 1000 nits SDR white shows each step. Marcy's pick in Phase 0 (2026-10-17): B, noise added
// with mix-blend-mode: plus-lighter.
//
// What it draws: one 64×64 tile of the smallest step there is, +1 code value at half the pixels and 0 at
// the rest, as white at alpha 1/255. Apple's cover wrapper is its own stacking context, so the blend sees
// the glow but not the page behind it; at alpha 1/255 the tile adds one code over the glow and over the
// page alike (an opaque tile would cover the page). It is masked to the glow's falloff only: the glow
// box's edge out to where its tail reaches 0 (fading over the last 16 px), never over the cover itself
// (its rect is cut out), never past the tail, so the page's black beyond the glow stays black.
// Cost: one static composited layer per album header, nothing animates (≈ 0).
// Apple renaming its classes makes the selector stop matching: nothing breaks, the dither just goes.
const zlib = require('zlib')

const TILE = 64
const MARGIN = 70        // px the layer reaches past the cover on each side
const REACH = 30        // px past the glow box's edge where its tail still reads ≥ 1 code (measured below the DMB cover: 1 code at 32 px, 0 at ~38 px from the cover)
const FADE = 16         // px over which the noise fades out after that (it rounds to nothing past the middle of the fade)

// a deterministic pseudo-random sequence (mulberry32): the same tile every run, testable
function rng(seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6D2B79F5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// the tile's alpha values: 1 (one code) at about `density` of the pixels, 0 elsewhere. Run-limited: never
// three equal values in a row or a column (across the tile's wrap too), because plain white noise left a
// 14 px flat run below the cover where a column of the tile happened to repeat (measured).
function noiseAlpha(size, seed, density) {
  const r = rng(seed)
  const out = new Uint8Array(size * size)
  const at = (x, y) => out[((y + size) % size) * size + ((x + size) % size)]
  const three = (v, x, y, dx, dy) => at(x - dx, y - dy) === v && at(x - 2 * dx, y - 2 * dy) === v
  // loop: NOT-WORTH — 4096 pixels, once per app run (the CSS is built once and kept)
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let v = r() < density ? 1 : 0
      // three in a row (left) or a column (above), or, near the tile's end, with its first pixels (the wrap)
      const bad = (w) => (x >= 2 && three(w, x, y, 1, 0)) || (y >= 2 && three(w, x, y, 0, 1)) ||
        (x === size - 1 && at(0, y) === w && (at(1, y) === w || at(x - 1, y) === w)) || (x === size - 2 && at(0, y) === w && at(1, y) === w) ||
        (y === size - 1 && at(x, 0) === w && (at(x, 1) === w || at(x, y - 1) === w)) || (y === size - 2 && at(x, 0) === w && at(x, 1) === w)
      if (bad(v) && !bad(1 - v)) v = 1 - v
      out[y * size + x] = v
    }
  }
  return out
}
// the longest run of one value in any row or column (the tile repeated), for the tests
function longestRun(a, size) {
  let best = 0
  // loop: NOT-WORTH — 2 × 64 lines of 128 pixels, tests only
  for (const dir of [[1, 0], [0, 1]]) {
    for (let k = 0; k < size; k++) {
      let run = 1
      for (let i = 1; i < size * 2; i++) {
        const p = dir[0] ? a[k * size + ((i - 1) % size)] : a[((i - 1) % size) * size + k]
        const q = dir[0] ? a[k * size + (i % size)] : a[(i % size) * size + k]
        run = p === q ? run + 1 : 1
        if (run > best) best = run
      }
    }
  }
  return best
}

// PNG (RGBA 8-bit) of white pixels with the given alphas
const CRC = (() => {
  const t = new Uint32Array(256)
  // loop: NOT-WORTH — the 256-entry CRC table, once at load
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0 }
  return t
})()
function crc32(buf) {
  let c = 0xFFFFFFFF
  // loop: NOT-WORTH — the bytes of a ~100-byte PNG chunk, once per run
  for (let i = 0; i < buf.length; i++) c = CRC[(c ^ buf[i]) & 0xFF] ^ (c >>> 8)
  return (c ^ 0xFFFFFFFF) >>> 0
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length)
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td))
  return Buffer.concat([len, td, crc])
}
function whitePng(alpha, size) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0   // 8-bit RGBA
  const raw = Buffer.alloc(size * (1 + size * 4))
  // loop: NOT-WORTH — 64 rows of 64 pixels, once per run
  for (let y = 0; y < size; y++) {
    const row = y * (1 + size * 4)
    raw[row] = 0
    for (let x = 0; x < size; x++) {
      const o = row + 1 + x * 4
      raw[o] = raw[o + 1] = raw[o + 2] = 255
      raw[o + 3] = alpha[y * size + x]
    }
  }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))])
}
function tileDataUrl(o) {
  const opt = o || {}
  return 'data:image/png;base64,' + whitePng(noiseAlpha(TILE, opt.seed || 20261017, opt.density || 0.5), TILE).toString('base64')
}

// The mask's stops, in the layer's own box (the cover W plus MARGIN on each side; % of that box). The glow
// box is the cover scaled .88 from its bottom centre: x 6 %…94 % of W, y 12 %…100 % of W, so in the layer
// x = 6 % of the box + 0.88·MARGIN (6 % of W is 6 % of the box − 0.12·MARGIN), and so on.
function maskStops() {
  const m = MARGIN
  const px = (v) => (Math.round(v * 10) / 10) + 'px'
  const at = (pct, k) => 'calc(' + pct + '% ' + (k < 0 ? '- ' + px(-k) : '+ ' + px(k)) + ')'
  return {
    left: [at(6, 0.88 * m - REACH - FADE), at(6, 0.88 * m - REACH)],
    right: [at(94, -0.88 * m + REACH), at(94, -0.88 * m + REACH + FADE)],
    top: [at(12, 0.76 * m - REACH - FADE), at(12, 0.76 * m - REACH)],
    bottom: [at(100, -m + REACH), at(100, -m + REACH + FADE)]
  }
}

// the CSS for Apple's page (only album/playlist headers whose glow shows: not the tall-artwork layout)
function css(o) {
  const s = maskStops()
  const x = 'linear-gradient(to right, transparent ' + s.left[0] + ', #000 ' + s.left[1] + ', #000 ' + s.right[0] + ', transparent ' + s.right[1] + ')'
  const y = 'linear-gradient(to bottom, transparent ' + s.top[0] + ', #000 ' + s.top[1] + ', #000 ' + s.bottom[0] + ', transparent ' + s.bottom[1] + ')'
  const cover = 'linear-gradient(#000, #000)'
  const mask = [
    'mask-image: ' + x + ', ' + y + ', ' + cover,
    'mask-size: 100% 100%, 100% 100%, calc(100% - ' + 2 * MARGIN + 'px) calc(100% - ' + 2 * MARGIN + 'px)',
    'mask-position: 0 0, 0 0, ' + MARGIN + 'px ' + MARGIN + 'px',
    'mask-repeat: no-repeat',
    // layers combine bottom-up: (the y band minus the cover), then intersected with the x band
    'mask-composite: intersect, subtract, add'
  ]
  return '.container-detail-header:not(.container-detail-header--tall-artwork) .artwork-wrapper:has(> .artwork__radiosity)::after { ' +
    'content: ""; position: absolute; inset: -' + MARGIN + 'px; z-index: 1; pointer-events: none; ' +
    'background: url(' + tileDataUrl(o) + ') 0 0 / ' + TILE + 'px ' + TILE + 'px repeat; ' +
    'mix-blend-mode: plus-lighter; ' + mask.join('; ') + '; }'
}

module.exports = { TILE, MARGIN, REACH, FADE, rng, noiseAlpha, longestRun, whitePng, tileDataUrl, maskStops, css, crc32 }
