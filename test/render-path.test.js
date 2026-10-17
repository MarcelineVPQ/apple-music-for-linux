// The lyric views' render path stays on the compositor ("lean lyrics", docs/research/gpu-render-hdr-2026-10.md):
// every CSS transition, keyframe animation and Web Animation in the lyrics window and the visualizer moves
// only transform or opacity (or a brightness-type filter, which Chromium also composites). A colour, size,
// position, shadow or pixel-moving filter (blur, drop-shadow) animation re-styles the window every frame on
// the main thread; this gate fails if one comes back. Plus the countdown dots' keyframes and the FLIP maths.
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')
const V = require('../lyrics-view')
const T = require('../lyrics-timing')

const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8')
const styles = (html) => [...html.matchAll(/<style>([\s\S]*?)<\/style>/g)].map((m) => m[1]).join('\n')
const SOURCES = () => ({ 'lyrics-view.css': read('lyrics-view.css'), 'lyrics.html': styles(read('lyrics.html')), 'visualizer.html': styles(read('visualizer.html')), 'liner-notes.html': styles(read('liner-notes.html')) })

const COMPOSITED = new Set(['transform', 'opacity', 'filter', 'none'])
// filter functions that don't move pixels: Chromium runs their animations on the compositor
const NON_MOVING = /^(none|(\s*(brightness|contrast|saturate|grayscale|sepia|invert|opacity|hue-rotate)\([^()]*\)\s*)+)$/

// rules of a stylesheet: [{ selector, decls: { prop: value }, keyframes: name|null }], @media unwrapped
function parse(css) {
  css = css.replace(/\/\*[\s\S]*?\*\//g, '')
  const rules = []
  const keyframes = {}
  let i = 0
  function block(prefix) {
    // loop: one pass over the stylesheet's characters · test only
    while (i < css.length) {
      const open = css.indexOf('{', i)
      const close = css.indexOf('}', i)
      if (close >= 0 && (open < 0 || close < open)) { i = close + 1; return }
      if (open < 0) return
      const head = css.slice(i, open).trim()
      i = open + 1
      if (/^@media|^@supports/.test(head)) { block(prefix); continue }
      const kf = head.match(/^@keyframes\s+([\w-]+)/)
      if (kf) { keyframes[kf[1]] = []; block({ kf: kf[1] }); continue }
      const end = css.indexOf('}', i)
      const decls = {}
      // loop: a rule's declarations · test only
      for (const d of css.slice(i, end).split(';')) {
        const k = d.indexOf(':')
        if (k > 0) decls[d.slice(0, k).trim()] = d.slice(k + 1).trim()
      }
      i = end + 1
      if (prefix && prefix.kf) keyframes[prefix.kf].push({ selector: head, decls })
      else rules.push({ selector: head, decls })
    }
  }
  block(null)
  return { rules, keyframes }
}

// the properties a transition list names ('transform 0.2s ease, opacity 0.3s' -> ['transform', 'opacity'])
const transitioned = (v) => v.split(/,(?![^()]*\))/).map((p) => p.trim().split(/\s+/)[0]).filter(Boolean)
// the classes of a selector's last compound ('.a .s.now > .sg' -> ['.sg']; '.x .s.now' -> ['.s', '.now'])
const lastClasses = (sel) => sel.trim().split(/\s+|>/).filter(Boolean).pop().match(/\.[\w-]+/g) || []

/** Everything in these sheets that would animate off the compositor -> [message] */
function offCompositor(sources) {
  const bad = []
  for (const [file, css] of Object.entries(sources)) {
    const { rules, keyframes } = parse(css)
    for (const r of rules) {
      for (const [prop, value] of Object.entries(r.decls)) {
        if (prop === 'transition' || prop === 'transition-property') {
          for (const p of transitioned(value)) {
            if (!COMPOSITED.has(p)) bad.push(`${file}: ${r.selector} transitions ${p}`)
            if (p === 'filter') {
              // every filter set on the elements this rule transitions must be a non-moving one
              const cls = r.selector.split(',').flatMap(lastClasses)
              for (const o of rules) {
                if (!o.decls.filter || !o.selector.split(',').some((s) => lastClasses(s).some((c) => cls.includes(c)))) continue
                if (!NON_MOVING.test(o.decls.filter)) bad.push(`${file}: ${r.selector} transitions filter, and ${o.selector} sets filter: ${o.decls.filter} (moves pixels: not composited)`)
              }
            }
          }
        }
        if (prop === 'animation' || prop === 'animation-name') {
          for (const part of value.split(',')) {
            const name = part.trim().split(/\s+/).find((w) => keyframes[w])
            if (name) for (const f of keyframes[name]) for (const k of Object.keys(f.decls)) if (!['transform', 'opacity'].includes(k)) bad.push(`${file}: @keyframes ${name} animates ${k} (${r.selector})`)
          }
        }
      }
    }
    for (const [name, frames] of Object.entries(keyframes)) {
      for (const f of frames) for (const k of Object.keys(f.decls)) if (!['transform', 'opacity'].includes(k)) bad.push(`${file}: @keyframes ${name} animates ${k}`)
    }
  }
  return bad
}

test('lyrics + visualizer + liner notes CSS: every transition and keyframe animation runs on the compositor', () => {
  assert.deepEqual(offCompositor(SOURCES()), [])
})

test('the gate catches what it is for: colour, size, position, shadow and pixel-moving filter animations', () => {
  const cases = {
    color: '.line { transition: color 0.3s ease; }',
    height: '.dots { transition: height 0.3s ease, opacity 0.3s ease; }',
    width: '.x { transition: width 1s; }',
    top: '.x { transition: top 1s, left 1s; }',
    'box-shadow': '.x { transition: box-shadow 0.2s; }',
    'background-image': '#bg { transition: background-image 0.6s ease; }',
    all: '.x { transition: all 0.2s; }',
    blur: '.line { filter: blur(0.6px); transition: filter 0.3s ease; }',
    'drop-shadow': '.s { transition: filter 0.12s; } .a .s.now { filter: brightness(1.5) drop-shadow(0 0.1em 0.12em red); }',
    keyframes: '@keyframes grow { from { height: 0; } } .x { animation: grow 1s; }'
  }
  for (const [name, css] of Object.entries(cases)) assert.ok(offCompositor({ [name]: css }).length > 0, name)
  // and lets the compositor's own through
  assert.deepEqual(offCompositor({ ok: '.w { transition: transform 0.18s ease-out, opacity 0.25s ease; } .sg { transition: filter 0.1s; } .a .sg { filter: brightness(1.5); } @keyframes in { from { opacity: 0; transform: translateY(1px); } }' }), [])
})

test('lyrics window: no blur on unsung lines, no backdrop blur on the card (the window is transparent)', () => {
  const { rules } = parse(styles(read('lyrics.html')))
  for (const r of rules) {
    assert.ok(!('backdrop-filter' in r.decls), r.selector + ' sets backdrop-filter')
    if (/\.line/.test(r.selector)) assert.ok(!/blur\(/.test(r.decls.filter || ''), r.selector + ' blurs')
  }
})

test('Web Animations in the lyric views and the visualizer animate transform/opacity only', () => {
  for (const f of ['lyrics-view.js', 'lyrics.html', 'visualizer.html', 'liner-notes.html']) {
    const src = read(f)
    // literal keyframe lists: .animate([{ prop: … }, …]
    for (const m of src.matchAll(/\.animate\(\[([\s\S]*?)\]\s*,/g)) {
      for (const k of m[1].matchAll(/([\w-]+)\s*:/g)) assert.ok(['transform', 'opacity', 'offset', 'easing'].includes(k[1]), f + ' animates ' + k[1])
    }
  }
  const k = V.dotKeyframes({ index: 3, start: 10, end: 20 })
  for (const f of [...k.dots.flat(), ...k.row]) for (const key of Object.keys(f)) assert.ok(['offset', 'opacity', 'transform'].includes(key), key)
})

// a keyframe list's value at offset o (linear between keyframes, as the Web Animation runs them)
function at(frames, o, pick) {
  let a = frames[0]
  for (const f of frames) { if (f.offset <= o) a = f; else { const t = (o - a.offset) / Math.max(1e-9, f.offset - a.offset); return pick(a) + (pick(f) - pick(a)) * t } }
  return pick(a)
}
const scale = (f) => Number(f.transform.match(/scale\(([\d.]+)\)/)[1])

test('countdown dots: the keyframes give the same fill, breathe and exit the per-frame code drew', () => {
  const g = { index: 4, start: 12.4, end: 46.3 }
  const k = V.dotKeyframes(g)
  assert.ok(Math.abs(k.duration - (g.end - T.LINE_LEAD - g.start)) < 1e-9)
  // loop: sample times across the interlude · test only
  for (let t = g.start; t <= g.end - T.LINE_LEAD; t += 0.137) {
    const o = (t - g.start) / k.duration
    const { fills, exit } = T.interludeProgress(g, t)
    for (let d = 0; d < 3; d++) {
      assert.ok(Math.abs(at(k.dots[d], o, (f) => f.opacity) - (0.25 + 0.75 * fills[d])) < 0.002, 'dot ' + d + ' opacity at ' + t)
      assert.ok(Math.abs(at(k.dots[d], o, scale) - (0.8 + 0.2 * fills[d])) < 0.002, 'dot ' + d + ' scale at ' + t)
    }
    const breathe = 1 + 0.06 * Math.sin(t * 2.6)
    assert.ok(Math.abs(at(k.row, o, (f) => f.opacity) - exit) < 0.002, 'row opacity at ' + t)
    assert.ok(Math.abs(at(k.row, o, scale) - breathe * exit) < 0.006, 'row scale at ' + t)   // linear between 1/8-breath samples
  }
  // offsets never go backwards (a Web Animation requires it)
  for (const list of [...k.dots, k.row]) list.forEach((f, i) => { if (i) assert.ok(f.offset >= list[i - 1].offset) })
  assert.equal(k.row[0].offset, 0)
  assert.equal(k.row[k.row.length - 1].offset, 1)
})

test('FLIP: the lines a dots row moves start where they were; the dots row slides from its centre', () => {
  // the lyrics window: dots (height 0 -> 44) above two lines, a line above it doesn't move
  const before = [{ top: 100, height: 0 }, { top: 60, height: 41 }, { top: 100, height: 41 }, { top: 141, height: 41 }]
  const after = [{ top: 100, height: 44 }, { top: 60, height: 41 }, { top: 144, height: 41 }, { top: 185, height: 41 }]
  assert.deepEqual(V.slideFrom(before, after, [true, false, false, false]), [{ i: 0, dy: -22 }, { i: 2, dy: -44 }, { i: 3, dy: -44 }])
  // the stage is centred: the dots row's centre stays, the next line moves by half the row
  assert.deepEqual(V.slideFrom([{ top: 500, height: 0 }, { top: 500, height: 40 }], [{ top: 478, height: 44 }, { top: 522, height: 40 }], [true, false]), [{ i: 1, dy: -22 }])
  assert.deepEqual(V.slideFrom([{ top: 1, height: 2 }], [{ top: 1.3, height: 2 }]), [])
})

test('lyrics engine: no per-frame wake-ups for the countdown, no per-frame dot styles', () => {
  const src = read('lyrics-view.js')
  assert.doesNotMatch(src, /shownInterlude >= 0\) \{ raf = requestAnimationFrame/)
  assert.doesNotMatch(src, /\.style\.(opacity|transform) = /)
  assert.doesNotMatch(src, /offsetTop !== top/, 'row edges are cached, not re-read per word')
})

test('liner notes: the page turn is transform (rotateY) + opacity only; Reduce motion turns it into a cross-fade', () => {
  const src = read('liner-notes.html')
  const anims = [...src.matchAll(/\.animate\((?:fwd \? )?(\[[^\]]*\])(?: : (\[[^\]]*\]))?/g)].flatMap((m) => [m[1], m[2]].filter(Boolean))
  assert.ok(anims.some((a) => /rotateY\(-180deg\)/.test(a)) && anims.some((a) => /rotateY\(180deg\)/.test(a)), 'the turn both ways')
  assert.ok(anims.every((a) => !/(width|height|left|top|color|background|filter|--)/.test(a)), anims.join(' | '))
  assert.match(src, /if \(reduce\.matches\) \{[\s\S]{0,200}fade\.animate\(\[\{ opacity: 0 \}, \{ opacity: 1 \}\]/, 'Reduce motion: an opacity fade, no rotation')
  // no animated custom property (the mock-up's --shade ran on the main thread) and no filter on the spread
  assert.doesNotMatch(src, /@property/)
  assert.doesNotMatch(styles(src), /#spread \{[^}]*filter/)
})
