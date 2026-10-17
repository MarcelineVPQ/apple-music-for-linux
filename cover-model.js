// The album cover lightbox (cover.html, opened from the lyrics header cover and the mini player):
// how large it shows and which artwork size it asks Apple for. Pure: numbers in, numbers out.
//
// Apple's artwork URLs are templates ('…/{w}x{h}bb.jpg'); the catalog gives the original's size
// (artwork.width / height, often 3000 px or more). The lightbox asks for exactly the pixels it shows
// (its size × the display's scale factor), never more than the original has, and never shows the
// art larger than the original (no upscaled blur).

const CAPTION = 64      // room under the cover for its caption card (px)

/**
 * coverLayout(workArea { width, height }, scaleFactor, nativeW, nativeH)
 *   -> { w, h, pxW, pxH }: the cover's size on screen (CSS px) and the pixels to ask Apple for
 */
function coverLayout(area, scale, nativeW, nativeH) {
  const s = scale > 0 ? scale : 1
  const nw = nativeW > 0 ? nativeW : 0
  const nh = nativeH > 0 ? nativeH : 0
  const aspect = nw && nh ? nw / nh : 1
  const maxW = Math.max(120, Math.floor(area.width * 0.86))
  const maxH = Math.max(120, Math.floor(area.height * 0.84) - CAPTION)
  let w = Math.min(maxW, maxH * aspect)
  if (nw) w = Math.min(w, nw / s)           // not larger than the original
  w = Math.floor(w)
  const h = Math.floor(w / aspect)
  let pxW = Math.round(w * s)
  if (nw) pxW = Math.min(pxW, nw)
  const pxH = Math.round(pxW / aspect)
  return { w, h, pxW, pxH }
}

/** Apple's artwork template at a size: {w}, {h}, and the crop / format placeholders some carry. */
function coverUrl(template, pxW, pxH) {
  return String(template || '')
    .replace('{w}', String(pxW)).replace('{h}', String(pxH))
    .replace('{c}', 'bb').replace('{f}', 'jpg')
}

module.exports = { coverLayout, coverUrl, CAPTION }
