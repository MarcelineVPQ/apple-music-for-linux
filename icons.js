// Sonata's icons (Lucide, ISC licence), for the rail and the side panel: one set, built as SVG nodes
// (no HTML strings). Loaded as a plain script (SonataIcons) in rail.html and panel.html.
;(function (root) {
  'use strict'
  const SVG = 'http://www.w3.org/2000/svg'
  // 'path:d' | 'circle:cx,cy,r' | 'rect:x,y,w,h,rx'
  const ICONS = {
    lyrics: ['path:m11 7.601-5.994 8.19a1 1 0 0 0 .1 1.298l.817.818a1 1 0 0 0 1.314.087L15.09 12', 'path:M16.5 21.174C15.5 20.5 14.372 20 13 20c-2.058 0-3.928 2.356-6 2-2.072-.356-2.775-3.369-1.5-4.5', 'circle:16,7,5'],
    visualizer: ['path:M2 13a2 2 0 0 0 2-2V7a2 2 0 0 1 4 0v13a2 2 0 0 0 4 0V4a2 2 0 0 1 4 0v13a2 2 0 0 0 4 0v-4a2 2 0 0 1 2-2'],
    mini: ['path:M21 9V6a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v10c0 1.1.9 2 2 2h4', 'rect:12,13,10,7,2'],
    settings: ['path:M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z', 'circle:12,12,3'],
    about: ['circle:12,12,10', 'path:M12 16v-4', 'path:M12 8h.01'],
    lock: ['rect:3,11,18,11,2', 'path:M7 11V7a5 5 0 0 1 10 0v4'],
    unlock: ['rect:3,11,18,11,2', 'path:M7 11V7a5 5 0 0 1 9.9-1'],
    pinOpen: ['rect:3,3,18,18,2', 'path:M15 3v18', 'path:m10 15-3-3 3-3'],
    pinClose: ['rect:3,3,18,18,2', 'path:M15 3v18', 'path:m8 9 3 3-3 3'],
    chevron: ['path:m6 9 6 6 6-6'],
    close: ['path:M18 6 6 18', 'path:m6 6 12 12'],
    more: ['circle:12,12,1', 'circle:12,5,1', 'circle:12,19,1'],
    music: ['path:M9 18V5l12-2v13', 'circle:6,18,3', 'circle:18,16,3'],
    timer: ['path:M10 2h4', 'path:M12 14l3-3', 'circle:12,14,8'],
    palette: ['path:M12 22a1 1 0 0 1 0-20 10 9 0 0 1 10 9 5 5 0 0 1-5 5h-2.25a1.75 1.75 0 0 0-1.4 2.8l.3.4a1.75 1.75 0 0 1-1.4 2.8z', 'circle:13.5,6.5,0.5', 'circle:17.5,10.5,0.5', 'circle:6.5,12.5,0.5', 'circle:8.5,7.5,0.5'],
    windows: ['rect:2,4,20,16,2', 'path:M10 4v4', 'path:M2 8h20', 'path:M6 4v4'],
    plug: ['path:M12 22v-5', 'path:M9 8V2', 'path:M15 8V2', 'path:M18 8v5a4 4 0 0 1-4 4h-4a4 4 0 0 1-4-4V8Z'],
    refresh: ['path:M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8', 'path:M21 3v5h-5', 'path:M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16', 'path:M8 16H3v5'],
    power: ['path:M12 2v10', 'path:M18.4 6.6a9 9 0 1 1-12.77.04'],
    scroll: ['path:M15 12h-5', 'path:M15 8h-5', 'path:M19 17V5a2 2 0 0 0-2-2H4', 'path:M8 21h12a2 2 0 0 0 2-2v-1a1 1 0 0 0-1-1H11a1 1 0 0 0-1 1v1a2 2 0 1 1-4 0V5a2 2 0 1 0-4 0v2a1 1 0 0 0 1 1h3'],
    flag: ['path:M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z', 'path:M4 22v-7'],
    heart: ['path:M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z'],
    external: ['path:M15 3h6v6', 'path:M10 14 21 3', 'path:M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6'],
    // About's hero card links (the DS5 About's icons)
    globe: ['circle:12,12,10', 'path:M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20', 'path:M2 12h20'],
    github: ['path:M15 22v-4a4.8 4.8 0 0 0-1-3.5c3 0 6-2 6-5.5.08-1.25-.27-2.48-1-3.5.28-1.15.28-2.35 0-3.5 0 0-1 0-3 1.5-2.64-.5-5.36-.5-8 0C6 2 5 2 5 2c-.3 1.15-.3 2.35 0 3.5A5.403 5.403 0 0 0 4 9c0 3.5 3 5.5 6 5.5-.39.49-.68 1.05-.85 1.65-.17.6-.22 1.23-.15 1.85v4', 'path:M9 18c-4.51 2-5-2-7-2'],
    code: ['path:m16 18 6-6-6-6', 'path:m8 6-6 6 6 6'],
    bug: ['path:M12 20v-9', 'path:M14 7a4 4 0 0 1 4 4v3a6 6 0 0 1-12 0v-3a4 4 0 0 1 4-4z', 'path:M14.12 3.88 16 2', 'path:M21 21a4 4 0 0 0-3.81-4', 'path:M21 5a4 4 0 0 1-3.55 3.97', 'path:M22 13h-4', 'path:M3 21a4 4 0 0 1 3.81-4', 'path:M3 5a4 4 0 0 0 3.55 3.97', 'path:M6 13H2', 'path:m8 2 1.88 1.88', 'path:M9 7.13V6a3 3 0 1 1 6 0v1.13'],
    link: ['path:M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71', 'path:M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71'],
    keyboard: ['rect:2,4,20,16,2', 'path:M6 8h.01M10 8h.01M14 8h.01M18 8h.01', 'path:M8 12h.01M12 12h.01M16 12h.01', 'path:M7 16h10']
  }
  function icon(doc, name) {
    const svg = doc.createElementNS(SVG, 'svg')
    svg.setAttribute('viewBox', '0 0 24 24')
    svg.setAttribute('aria-hidden', 'true')
    svg.setAttribute('focusable', 'false')
    // loop: NOT-WORTH — ≤ 11 parts per icon (most ≤ 5), when a control is built
    for (const part of ICONS[name] || []) {
      const [tag, a] = part.split(/:(.*)/s)
      const el = doc.createElementNS(SVG, tag)
      if (tag === 'path') el.setAttribute('d', a)
      else if (tag === 'circle') { const [cx, cy, r] = a.split(','); el.setAttribute('cx', cx); el.setAttribute('cy', cy); el.setAttribute('r', r) }
      else { const [x, y, w, h, rx] = a.split(','); el.setAttribute('x', x); el.setAttribute('y', y); el.setAttribute('width', w); el.setAttribute('height', h); el.setAttribute('rx', rx) }
      svg.appendChild(el)
    }
    return svg
  }
  const api = { ICONS, icon }
  if (typeof module === 'object' && module.exports) module.exports = api
  else root.SonataIcons = Object.freeze(api)
})(typeof globalThis !== 'undefined' ? globalThis : this)
