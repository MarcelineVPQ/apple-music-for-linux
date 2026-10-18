// The syllable pop's look, pinned (Marcy 2026-10-17: "I like the way the words highlight"): the sung syllable
// of a word lifts and grows on its own ("dis·tance", "ba·by", "Sup-p-per"), with its overshoot ease, a smaller
// lift while a note is held and on backing vocals; the word itself doesn't scale. Any change here is a
// change of look and needs her say. The UI checker's stage phase checks the rendering (no overlap with the
// line above, nothing clipped, back on the baseline after the syllable).
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')

const css = fs.readFileSync(path.join(__dirname, '..', 'lyrics-view.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
const decl = (sel) => {
  const i = css.indexOf(sel + ' {')
  assert.ok(i >= 0, sel)
  return css.slice(i + sel.length + 2, css.indexOf('}', i)).trim()
}

test('the syllable pop: lift 0.24em and 1.12x from 50% 80%, a 0.12 s overshoot ease; the word holds still', () => {
  // scale(min(1.12, var(--pop-max, 1.12))): 1.12 unless a long syllable would crowd a neighbour (test/pop-room.test.js)
  assert.match(decl('.line.active .w.now .s.now'), /^transform: translateY\(-0\.24em\) scale\(min\(1\.12, var\(--pop-max, 1\.12\)\)\); filter: drop-shadow\(0 0\.1em 0\.12em var\(--sing\)\);$/)
  assert.match(decl('.line.active .w.now .s.now > .sg'), /^filter: brightness\(1\.5\);$/)
  assert.match(css, /\.w \.s \{\s*display: inline-block;\s*transform-origin: 50% 80%;\s*transition: transform 0\.12s cubic-bezier\(\.3,1\.6,\.5,1\);\s*\}/)
  assert.match(css, /\.line\.active \.w\.hs\.now, \.line\.active \.bgv \.w\.hs\.now \{ transform: none; \}/)
})

test('the held note and the backing vocals: their own, smaller lift', () => {
  assert.match(decl('.line.active .w.now.hold .s.now'), /^transform: translateY\(-0\.1em\) scale\(min\(1\.05, var\(--pop-max, 1\.05\)\)\);/)
  assert.match(decl('.line.active .bgv .w.now .s.now'), /^transform: translateY\(-0\.16em\) scale\(min\(1\.08, var\(--pop-max, 1\.08\)\)\); filter: none;$/)
  // a word that is no longer sung settles at once (no animation back)
  assert.match(css, /\.w:not\(\.now\) \.s, \.w:not\(\.now\) \.sg \{ transition: none; \}/)
})
