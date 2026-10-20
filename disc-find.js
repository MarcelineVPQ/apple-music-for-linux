// The disc in a disc scan (the liner notes' cover spread). The Cover Art Archive's "Medium" scans are
// often a photo of the CD lying on paper or in its tray, the disc off-centre; shown as-is in the round
// .disc and spun, such a scan wobbles. findDisc finds the disc's circle in the scan's pixels so the
// booklet can show exactly the disc, centred, turning about its own centre. Pure: pixels in, a circle
// out (main decodes the scan with nativeImage; the tests draw synthetic ones).
//
// The method: the background is the colour of the image's border (its median); pixels far from it
// (Otsu's split of the distances, at least MIN_DIST) are the disc; a 1 px opening drops thin pattern
// lines; the largest blob with its holes filled (the spindle hole, a label as light as the paper) is the
// disc; a least-squares circle (Kåsa) on its outline, the outline pixels on the image's edge left out
// (a disc cut by the edge), refitted twice without the outliers. The fit is used only when it is round
// and true: most of the outline on the circle, the circle filled by the blob and the blob inside the
// circle. A disc cut by the edge is shown a little smaller about its own centre (no empty sliver), and
// refused when more than RIM_CUT of its radius would go.

const MIN_DIST = 60        // the least colour distance (sum of |ΔR|+|ΔG|+|ΔB|) that counts as the disc
const RIM_CUT = 0.12       // the most of the radius given up to keep a cut disc inside the image
const RIM_IN = 0.985       // the crop sits just inside the disc's rim (no background at the edge)

/** The scan's key for the fit cache and for the booklet page: its smallest thumbnail's URL. */
function discKey(thumbs) {
  if (!thumbs) return ''
  return thumbs[250] || thumbs[500] || thumbs[1200] || ''
}

function otsu(hist, total) {
  let sum = 0
  // loop: NOT-WORTH — 766 histogram bins, once per scan
  for (let i = 0; i < hist.length; i++) sum += i * hist[i]
  let sumB = 0; let wB = 0; let best = 0; let at = 0
  // loop: NOT-WORTH — 766 histogram bins, once per scan
  for (let i = 0; i < hist.length; i++) {
    wB += hist[i]
    if (!wB) continue
    const wF = total - wB
    if (!wF) break
    sumB += i * hist[i]
    const mB = sumB / wB; const mF = (sum - sumB) / wF
    const v = wB * wF * (mB - mF) * (mB - mF)
    if (v > best) { best = v; at = i }
  }
  return at
}

function circleFit(xs, ys, idx) {
  // Kåsa: x² + y² + Dx + Ey + F = 0, least squares (the normal equations, 3×3)
  let sx = 0; let sy = 0; let sxx = 0; let syy = 0; let sxy = 0; let sxz = 0; let syz = 0; let sz = 0
  const n = idx.length
  // loop: NOT-WORTH — the outline's pixels (≤ ~2000), 3 fits per scan
  for (const i of idx) {
    const x = xs[i]; const y = ys[i]; const z = x * x + y * y
    sx += x; sy += y; sxx += x * x; syy += y * y; sxy += x * y; sxz += x * z; syz += y * z; sz += z
  }
  // [sxx sxy sx; sxy syy sy; sx sy n] · [D E F] = -[sxz syz sz]
  const a = [[sxx, sxy, sx, -sxz], [sxy, syy, sy, -syz], [sx, sy, n, -sz]]
  // loop: NOT-WORTH — Gaussian elimination of a 3×3 system
  for (let c = 0; c < 3; c++) {
    let p = c
    for (let r = c + 1; r < 3; r++) if (Math.abs(a[r][c]) > Math.abs(a[p][c])) p = r   // loop: NOT-WORTH — 3 rows
    if (Math.abs(a[p][c]) < 1e-9) return null
    const t = a[c]; a[c] = a[p]; a[p] = t
    for (let r = 0; r < 3; r++) {   // loop: NOT-WORTH — 3 rows
      if (r === c) continue
      const f = a[r][c] / a[c][c]
      for (let k = c; k < 4; k++) a[r][k] -= f * a[c][k]   // loop: NOT-WORTH — 4 columns
    }
  }
  const D = a[0][3] / a[0][0]; const E = a[1][3] / a[1][1]; const F = a[2][3] / a[2][2]
  const cx = -D / 2; const cy = -E / 2
  const r2 = cx * cx + cy * cy - F
  return r2 > 0 ? { cx, cy, r: Math.sqrt(r2) } : null
}

/**
 * findDisc({ data, width, height, channels }) -> { x, y, rx, ry } or null.
 * data: the pixels, row by row (RGBA or BGRA: the colour order doesn't matter), channels 3 or 4
 * (default 4); keep it small (≤ ~300 px a side: main hands the 250 px thumbnail).
 * The circle to show, as fractions of the image: its centre (x of the width, y of the height) and its
 * radius (rx of the width, ry of the height); null when no disc was found for sure (the caller then
 * shows the scan as before, and keeps it still).
 */
function findDisc(img) {
  const w = img && img.width | 0; const h = img && img.height | 0
  const ch = (img && img.channels) || 4
  const px = img && img.data
  if (!px || w < 24 || h < 24 || px.length < w * h * ch) return null
  const n = w * h
  // the background: the median colour of the 2 px border
  const border = []
  // loop: NOT-WORTH — the border's pixels (≤ ~1200), once per scan
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {   // loop: NOT-WORTH — skips straight past the inner pixels of each row
      if (y > 1 && y < h - 2 && x === 2) x = w - 2
      border.push(y * w + x)
    }
  }
  const bg = [0, 1, 2].map((c) => {
    // loop: NOT-WORTH — once per disc scan (result cached), 3 channels × border pixels (≤ ~1200) sorted
    const v = border.map((i) => px[i * ch + c]).sort((p, q) => p - q)
    return v[v.length >> 1]
  })
  const dist = new Uint16Array(n)
  const hist = new Uint32Array(766)
  // loop: HOT-PATH-OK — every pixel of a ≤ 300 px thumbnail once per scan (≤ 90k), then cached per scan
  for (let i = 0; i < n; i++) {
    const o = i * ch
    const d = Math.abs(px[o] - bg[0]) + Math.abs(px[o + 1] - bg[1]) + Math.abs(px[o + 2] - bg[2])
    dist[i] = d; hist[d]++
  }
  // the threshold: Otsu's split of the distances first; a disc printed in colours near the paper's (a
  // yellow on white) can lose its rim at that split, so lower ones are tried until a disc is sure
  const split = Math.max(MIN_DIST, otsu(hist, n))
  const tries = [split, 200, 140, 100, MIN_DIST].filter((t, i, a) => t <= split && a.indexOf(t) === i)
  // loop: NOT-WORTH — ≤ 5 thresholds, the first sure fit wins; once per scan, then cached
  for (const T of tries) { const fit = fitAt(T); if (fit) return fit }
  return null

  function fitAt(T) {
    let mask = new Uint8Array(n)
    for (let i = 0; i < n; i++) mask[i] = dist[i] > T ? 1 : 0   // loop: HOT-PATH-OK — every pixel once per scan
    // a 1 px opening (erode, then dilate): thin pattern lines and specks go, the disc stays
    const morph = (src, keep) => {
      const out = new Uint8Array(n)
      // loop: HOT-PATH-OK — every pixel, twice per scan
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {   // loop: HOT-PATH-OK — the row's pixels
          const i = y * w + x
          const l = x > 0 ? src[i - 1] : src[i]; const r = x < w - 1 ? src[i + 1] : src[i]
          const u = y > 0 ? src[i - w] : src[i]; const d = y < h - 1 ? src[i + w] : src[i]
          out[i] = keep ? (src[i] & l & r & u & d) : (src[i] | l | r | u | d)
        }
      }
      return out
    }
    mask = morph(morph(mask, true), false)
    // the largest blob (4-connected)
    const label = new Int32Array(n)
    const stack = new Int32Array(n)
    let best = 0; let bestSize = 0; let next = 0
    // loop: HOT-PATH-OK — every pixel once, each blob flooded once (a scan's ≤ 90k pixels)
    for (let s = 0; s < n; s++) {
      if (!mask[s] || label[s]) continue
      next++
      let top = 0; let size = 0
      stack[top++] = s; label[s] = next
      while (top) {   // loop: HOT-PATH-OK — the flood fill, each pixel pushed once
        const i = stack[--top]; size++
        const x = i % w
        if (x > 0 && mask[i - 1] && !label[i - 1]) { label[i - 1] = next; stack[top++] = i - 1 }
        if (x < w - 1 && mask[i + 1] && !label[i + 1]) { label[i + 1] = next; stack[top++] = i + 1 }
        if (i >= w && mask[i - w] && !label[i - w]) { label[i - w] = next; stack[top++] = i - w }
        if (i < n - w && mask[i + w] && !label[i + w]) { label[i + w] = next; stack[top++] = i + w }
      }
      if (size > bestSize) { bestSize = size; best = next }
    }
    if (!best || bestSize < n * 0.08) return null
    // its holes filled: everything the border can't reach without crossing the blob
    const out = new Uint8Array(n)   // 1 = reached from the border (outside the disc)
    let top = 0
    // loop: NOT-WORTH — the border's pixels as the flood's seeds
    for (const i of border) if (label[i] !== best && !out[i]) { out[i] = 1; stack[top++] = i }
    while (top) {   // loop: HOT-PATH-OK — the flood fill, each pixel pushed once
      const i = stack[--top]
      const x = i % w
      if (x > 0 && !out[i - 1] && label[i - 1] !== best) { out[i - 1] = 1; stack[top++] = i - 1 }
      if (x < w - 1 && !out[i + 1] && label[i + 1] !== best) { out[i + 1] = 1; stack[top++] = i + 1 }
      if (i >= w && !out[i - w] && label[i - w] !== best) { out[i - w] = 1; stack[top++] = i - w }
      if (i < n - w && !out[i + w] && label[i + w] !== best) { out[i + w] = 1; stack[top++] = i + w }
    }
    // the outline: disc pixels next to the outside, not on the image's edge
    const xs = []; const ys = []
    // loop: HOT-PATH-OK — every inner pixel once per scan
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {   // loop: HOT-PATH-OK — the row's pixels
        const i = y * w + x
        if (out[i]) continue
        if (out[i - 1] || out[i + 1] || out[i - w] || out[i + w]) { xs.push(x + 0.5); ys.push(y + 0.5) }
      }
    }
    if (xs.length < 24) return null
    let idx = xs.map((_, i) => i)
    let c = null
    // loop: NOT-WORTH — 3 fits, each without the previous one's outliers
    for (let pass = 0; pass < 3; pass++) {
      c = circleFit(xs, ys, idx)
      if (!c) return null
      // loop: NOT-WORTH — once per scan, 3 refits × outline points (≤ ~1500), ≤ 5 thresholds
      const res = xs.map((x, i) => Math.abs(Math.hypot(x - c.cx, ys[i] - c.cy) - c.r))
      // loop: NOT-WORTH — once per scan, 3 refits × kept outline points sorted (≤ ~1500)
      const med = idx.map((i) => res[i]).sort((p, q) => p - q)[idx.length >> 1]
      const tol = Math.max(1.5, 2.5 * med)
      // loop: NOT-WORTH — once per scan, 3 refits × outline points (≤ ~1500)
      const kept = idx.filter((i) => res[i] <= tol)
      if (kept.length < 24) return null
      idx = kept
    }
    const { cx, cy, r } = c
    const short = Math.min(w, h)
    if (r < 0.3 * short || r > 0.75 * Math.max(w, h)) return null
    if (cx < 0 || cy < 0 || cx > w || cy > h) return null
    // round and true: the rim is there all the way round (where it is inside the image)
    const tol = Math.max(1.5, r * 0.025)
    const edge = new Uint8Array(n)
    for (let i = 0; i < xs.length; i++) edge[Math.floor(ys[i]) * w + Math.floor(xs[i])] = 1   // loop: NOT-WORTH — the outline once
    const t = Math.ceil(tol)
    let seen = 0; let held = 0
    // loop: NOT-WORTH — 180 points round the rim, each looking at a (2·tol+1)² patch
    for (let a = 0; a < 180; a++) {
      const px0 = cx + r * Math.cos(a * Math.PI / 90); const py0 = cy + r * Math.sin(a * Math.PI / 90)
      if (px0 < 2 || py0 < 2 || px0 > w - 2 || py0 > h - 2) continue
      seen++
      let hit = false
      for (let dy = -t; dy <= t && !hit; dy++) {   // loop: NOT-WORTH — the small patch
        for (let dx = -t; dx <= t && !hit; dx++) {   // loop: NOT-WORTH — the small patch
          const x = Math.floor(px0) + dx; const y = Math.floor(py0) + dy
          if (x >= 0 && y >= 0 && x < w && y < h && edge[y * w + x]) hit = true
        }
      }
      if (hit) held++
    }
    if (seen < 90 || held < seen * 0.8) return null
    // the circle (inside the image) filled by the disc, and the disc inside the circle
    let inC = 0; let inCdisc = 0; let disc = 0; let discIn = 0
    // loop: HOT-PATH-OK — every pixel once per scan
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {   // loop: HOT-PATH-OK — the row's pixels
        const i = y * w + x
        const inside = Math.hypot(x + 0.5 - cx, y + 0.5 - cy) <= r
        const d = !out[i]
        if (inside) { inC++; if (d) inCdisc++ }
        if (d) { disc++; if (inside || Math.hypot(x + 0.5 - cx, y + 0.5 - cy) <= r + tol) discIn++ }
      }
    }
    if (!inC || inCdisc < inC * 0.9 || discIn < disc * 0.92) return null
    // the crop: just inside the rim, and inside the image (a disc cut by the edge shows a little smaller)
    const room = Math.min(cx, cy, w - cx, h - cy)
    const rc = Math.min(r * RIM_IN, room)
    if (rc < r * (1 - RIM_CUT)) return null
    const k = (v) => Math.round(v * 10000) / 10000
    return { x: k(cx / w), y: k(cy / h), rx: k(rc / w), ry: k(rc / h) }
  }
}

/**
 * discCrop(fit) -> the img's inline style (percent of the round .disc) that shows exactly that circle,
 * centred and filling the disc, so the disc's own spin turns it about its centre.
 */
function discCrop(fit) {
  if (!fit || !(fit.rx > 0) || !(fit.ry > 0)) return null
  const W = 100 / (2 * fit.rx); const H = 100 / (2 * fit.ry)
  const p = (v) => (Math.round(v * 1000) / 1000) + '%'
  return { width: p(W), height: p(H), left: p(50 - fit.x * W), top: p(50 - fit.y * H) }
}

module.exports = { findDisc, discCrop, discKey, MIN_DIST, RIM_CUT }
