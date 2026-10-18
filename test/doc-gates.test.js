// The documentation gates (tools/doc-gates.js): each one catches its seeded mistake, and the real
// BACKLOG passes the pure ones (npm run gates runs all six on the repo, git included).
'use strict'
const test = require('node:test')
const assert = require('node:assert')
const fs = require('fs')
const path = require('path')
const G = require('../tools/doc-gates')

const HEAD = '| Item | Status | Notes |\n|------|--------|-------|\n'
const row = (item, status, notes) => '| ' + item + ' | **' + status + '** | ' + notes + ' |\n'

test('soon: a Building or Planned row is in Coming soon or says why not', () => {
  const ok = HEAD + row('Studio', 'Building', 'Soon (The Studio): the lyrics as the centrepiece. dev notes') +
    row('Tooling (internal)', 'Building', 'gates') + row('Hub (unannounced)', 'Idea', 'big') + row('Old', 'Done', 'shipped')
  const r = G.soonProblems(ok)
  assert.deepEqual(r.problems, [])
  assert.equal(r.listed, 1)
  assert.deepEqual(r.optedOut.map((o) => o.marker), ['internal', 'unannounced'])
  // seeded: a Planned row with no Soon and no marker
  assert.match(G.soonProblems(HEAD + row('Equalizer', 'Planned', 'one-hour test first')).problems[0], /Planned but not in Coming soon/)
  // seeded: a Done row still in Coming soon
  assert.match(G.soonProblems(HEAD + row('Cover', 'Done', 'Soon: open the cover large. 0.15.39')).problems[0], /Done but still in Coming soon/)
  // seeded: both a Soon and a marker; a Soon About can't read; a status word that isn't one
  assert.match(G.soonProblems(HEAD + row('X (internal)', 'Building', 'Soon: a thing.')).problems[0], /drop one of the two/)
  assert.match(G.soonProblems(HEAD + row('Y', 'Planned', 'Soon - a thing')).problems[0], /About would not show it/)
  assert.match(G.soonProblems(HEAD + row('Z', 'Shipped', 'x')).problems[0], /not one of/)
  // an Idea row may stay out without a marker (ideas are opt-in)
  assert.deepEqual(G.soonProblems(HEAD + row('Idea row', 'Idea', 'later')).problems, [])
})

test('shipped: rows that look shipped but are not Done', () => {
  const ctx = { version: '0.15.41-dev.1', settingsKeys: ['montage', 'glass'] }
  assert.match(G.shippedProblems(HEAD + row('Cover', 'Idea', '0.15.39-dev.1. A lightbox.'), ctx)[0], /start with 0\.15\.39-dev\.1 \(shipped\)/)
  assert.match(G.shippedProblems(HEAD + row('M', 'Planned', 'Built: the tile.'), ctx)[0], /say it was built/)
  assert.match(G.shippedProblems(HEAD + row('M', 'Idea', 'a switch (`settings.montage`).'), ctx)[0], /already has montage/)
  assert.match(G.shippedProblems(HEAD + row('B', 'Building', '0.15.40-dev.1. All of it works.'), ctx)[0], /name nothing left/)
  // not flagged: a future version, a Building row with work left, a row in testing, a Done row
  assert.deepEqual(G.shippedProblems(HEAD + row('F', 'Planned', '0.16.0 plan.') + row('B', 'Building', '0.15.40-dev.1. Still to see on GNOME.') +
    row('T (in testing)', 'Building', '0.15.40-dev.1. Works.') + row('D', 'Done', '0.15.39-dev.1.'), ctx), [])
  assert.equal(G.versionCmp('0.15.41-dev.1', '0.15.41'), -1)
  assert.equal(G.versionCmp('0.15.41', '0.15.40-dev.9'), 1)
})

test('changelog: user-facing commits since the tag need words under [Unreleased]', () => {
  const shipped = G.shippedTest(['main.js', 'lyrics.html', '!node_modules/hyphen/*/index.js'])
  const feat = { hash: 'abcdef0123', subject: 'feat(lyrics): a thing', body: '', files: ['main.js', 'test/x.test.js'] }
  const empty = '# Changelog\n\n## [Unreleased]\n\n## [0.15.41-dev.1] — T\n\n- old\n'
  const base = { changelog: empty, commits: [feat], shipped, version: '0.15.41-dev.1', versionTagged: true }
  // seeded: a feat on a shipped file and an empty [Unreleased]
  assert.match(G.changelogProblems(base)[0], /\[Unreleased\] is empty: abcdef0 feat\(lyrics\): a thing/)
  // fine: words under [Unreleased]; a "No user-facing change" line; that note in the commit; tests or docs only; a chore
  assert.deepEqual(G.changelogProblems({ ...base, changelog: empty.replace('## [Unreleased]\n', '## [Unreleased]\n\n### Fixed\n\n- **A thing.**\n') }), [])
  assert.deepEqual(G.changelogProblems({ ...base, changelog: empty.replace('## [Unreleased]\n', '## [Unreleased]\n\nNo user-facing change: tests only.\n') }), [])
  assert.deepEqual(G.changelogProblems({ ...base, commits: [{ ...feat, body: 'No user-facing change (a refactor).' }] }), [])
  assert.deepEqual(G.changelogProblems({ ...base, commits: [{ ...feat, files: ['test/x.test.js', 'docs/A.md'] }] }), [])
  assert.deepEqual(G.changelogProblems({ ...base, commits: [{ ...feat, subject: 'chore: tidy' }] }), [])
  // the version being released (not tagged yet) carries its own section
  assert.deepEqual(G.changelogProblems({ ...base, changelog: empty.replace('- old', '- new thing'), versionTagged: false }), [])
  assert.equal(G.changelogSection('## [Unreleased]\n\nx\n\n## [1.0.0]\n', 'Unreleased'), 'x')
})

const sm = require('../shortcuts-model')
const refCtx = {
  tracked: ['main.js', 'docs/LYRIC-TIMING.md', 'tools/ui-check.js', 'align/install.sh'],
  code: "const CACHE = 'lyrics-cache.json'",
  scripts: ['test', 'gates', 'start'],
  settingsKeys: ['montage'],
  shortcuts: new Set(sm.RESERVED.concat(sm.ACTIONS.map((a) => a.key)).map(sm.normalize)),
  normalize: sm.normalize
}
const refs = (text) => G.refProblems([{ name: 'README.md', text }], refCtx)

test('refs: docs name only files, scripts, tools, settings and shortcuts that exist', () => {
  assert.deepEqual(refs('Run `main.js` with `npm run gates`, `node tools/ui-check.js every`, `align/install.sh`, docs/LYRIC-TIMING.md,\n' +
    'saved in `lyrics-cache.json` (`settings.montage`); Ctrl+Shift+S, Ctrl+Alt+Page Down, another app\'s Shift+Ctrl+F; `~/.config/x.json`.'), [])
  // seeded mistakes, one each
  assert.match(refs('the old `settings.html` window')[0], /`settings\.html` is not a file/)
  assert.match(refs('npm run dist:flatpak')[0], /not a package\.json script/)
  assert.match(refs('node tools/old-check.js')[0], /tools\/old-check\.js does not exist/)
  assert.match(refs('see docs/research/gone-2026-10.md')[0], /does not exist/)
  assert.match(refs('the `settings.lyricsColour` key')[0], /not a setting/)
  assert.match(refs('press Ctrl+Shift+K')[0], /Ctrl\+Shift\+K is not one of Sonata's shortcuts/)
  // fine: a path on another branch said so, a parked HTML comment, a dated research note
  assert.deepEqual(refs('scores in docs/research/x.md on the research-gpu-pipeline branch'), [])
  assert.deepEqual(refs('<!--\n![shot](docs/media/shot.png)\n-->'), [])
  assert.deepEqual(G.refProblems([{ name: 'docs/OLD.md', text: '# Old\n\n> Research note, dated 2026-10-15: history.\n\n`settings.html`' }], refCtx), [])
  // the in-app help strings are read out of the source
  assert.match(G.helpText("el('p', 'Press Ctrl+Shift+K to open it')"), /Press Ctrl\+Shift\+K to open it/)
})

test('version: the metainfo and the CHANGELOG follow package.json', () => {
  const pkg = { version: '0.15.41-dev.1' }
  const lock = { version: '0.15.41-dev.1', packages: { '': { version: '0.15.41-dev.1' } } }
  const meta = (v) => '<releases>\n    <release version="' + v + '" date="2026-10-17" type="development">\n'
  const cl = '## [Unreleased]\n\n## [0.15.41-dev.1] — T\n'
  assert.deepEqual(G.versionProblems({ pkg, lock, metainfo: meta('0.15.41-dev.1') + meta('0.15.40-dev.1'), changelog: cl }), [])
  // seeded: an older release first in the metainfo, a CHANGELOG section newer than package.json
  assert.ok(G.versionProblems({ pkg, lock, metainfo: meta('0.15.40-dev.1') + meta('0.15.41-dev.1'), changelog: cl }).some((p) => /newest <release> is 0\.15\.40-dev\.1/.test(p)))
  assert.ok(G.versionProblems({ pkg, lock, metainfo: meta('0.15.41-dev.1'), changelog: '## [0.15.42-dev.1] — N\n' + cl }).some((p) => /newer than package\.json/.test(p)))
})

test('privacy: a phrase on the hashed list fails, wherever it is', () => {
  const list = new Set([G.phraseHash('Purple Elephant'), G.phraseHash('zebra')])
  assert.equal(G.phraseHash('purple   elephant!'), G.phraseHash('Purple Elephant'), 'case, spacing and punctuation do not matter')
  const p = G.privacyProblems([{ name: 'BACKLOG.md', text: 'fine line\nthe purple-elephant plan\nZebra crossing privacy-ok: a street\n' }], list)
  assert.equal(p.length, 1)
  assert.match(p[0], /^BACKLOG\.md:2: "purple elephant"/)
  // the real list is hashes only (it names nothing) and is not empty
  const real = fs.readFileSync(path.join(__dirname, '..', 'tools', 'privacy-denylist.txt'), 'utf8').split('\n').filter((l) => l && !l.startsWith('#'))
  assert.ok(real.length >= 20 && real.every((l) => /^[0-9a-f]{64}$/.test(l)))
})

test('the real BACKLOG passes soon and shipped', () => {
  const md = fs.readFileSync(path.join(__dirname, '..', 'BACKLOG.md'), 'utf8')
  assert.deepEqual(G.soonProblems(md).problems, [])
  assert.equal(require('../about-data').comingSoon(md).length, G.soonProblems(md).listed, 'About lists exactly the Soon rows')
  assert.deepEqual(G.shippedProblems(md, { version: require('../package.json').version, settingsKeys: Object.keys(require('../settings-store').SCHEMA) }), [])
})
