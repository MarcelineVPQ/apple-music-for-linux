// The Ken Burns montage for the mock-ups (design only): related photos drift behind the lyrics,
// a slow pan and zoom and a cross-fade, transform and opacity only. Driven by the song clock, so it
// freezes when the music pauses and follows a seek.
//   const m = MockMontage.create(box, photos, { hold: 10, fade: 2.4, onPhoto })
//   m.update(t)
;(function () {
  'use strict'
  function create(box, photos, opts) {
    const o = Object.assign({ hold: 10, fade: 2.4, zoom: [1.06, 1.17], drift: 3.2 }, opts || {})
    box.classList.add('montage')
    const layers = photos.map((p) => {
      const d = document.createElement('div')
      d.className = 'mt-photo'
      d.style.backgroundImage = 'url("' + p.file + '")'
      d.style.backgroundPosition = (p.focus[0] * 100) + '% ' + (p.focus[1] * 100) + '%'
      box.appendChild(d)
      return d
    })
    let shown = -1
    function pose(k, p) {
      // even slots zoom in toward the focus, odd ones ease back out: never the same move twice running
      const ph = photos[k % photos.length]
      const inward = k % 2 === 0
      const z = inward ? o.zoom[0] + (o.zoom[1] - o.zoom[0]) * p : o.zoom[1] - (o.zoom[1] - o.zoom[0]) * p
      const dx = (0.5 - ph.focus[0]) * o.drift * 2 * (inward ? p : 1 - p) + (k % 3 - 1) * o.drift * (p - 0.5)
      const dy = (0.5 - ph.focus[1]) * o.drift * 2 * (inward ? p : 1 - p)
      return 'translate3d(' + dx.toFixed(3) + '%,' + dy.toFixed(3) + '%,0) scale(' + z.toFixed(4) + ')'
    }
    function update(t) {
      const span = o.hold
      const k = Math.max(0, Math.floor(t / span))
      const local = t - k * span
      const cur = k % photos.length
      const prev = (k - 1 + photos.length) % photos.length
      layers.forEach((L, i) => {
        let op = 0; let tr = null
        if (i === cur) {
          op = k === 0 ? 1 : Math.min(1, local / o.fade)
          tr = pose(k, (local + o.fade) / (span + o.fade))
        } else if (i === prev && k > 0 && local < o.fade) {
          op = 1   // under the incoming photo, still drifting
          tr = pose(k - 1, (span + local) / (span + o.fade))
        }
        L.style.opacity = op.toFixed(3)
        L.style.zIndex = i === cur ? 2 : 1
        if (tr) L.style.transform = tr
      })
      if (cur !== shown) { shown = cur; if (o.onPhoto) o.onPhoto(photos[cur], cur) }
    }
    return { update, layers }
  }
  window.MockMontage = { create }
})()
