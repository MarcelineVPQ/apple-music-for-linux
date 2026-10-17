// What About shows, from Sonata's own files (pure: text in, data out). main.js reads CHANGELOG.md and
// BACKLOG.md (both ship in the app) only when About opens, and sends this to the side panel.
//   Hero card     hero(): the 42PS card (eyebrow, name, developer, version and channel, links, ©); main
//                 adds it to each panel snapshot, so a channel switch shows at once
//   App changes   the CHANGELOG section of the running version (or the newest one before it), older ones folded
//   Coming soon   BACKLOG rows whose Notes start with "Soon:" (the user-facing sentence after it), by status
//   Credits       CREDITS below: the "Built on" group as prose, every other group and the hyphenation
//                 patterns as one What | Credit table

// "## [0.15.31] — The rail never covers Apple's page" -> sections
function changelogSections(md) {
  const out = []
  let cur = null
  // loop: NOT-WORTH — one pass over CHANGELOG.md's lines (~300), when About opens
  for (const line of String(md || '').split('\n')) {
    const m = /^##\s+\[([^\]]+)\]\s*(?:[—–-]\s*(.*))?$/.exec(line)
    if (m) {
      if (cur) out.push(cur)
      cur = { version: m[1].trim(), title: (m[2] || '').trim(), body: [] }
      continue
    }
    if (/^#\s/.test(line)) { if (cur) out.push(cur); cur = null; continue }
    if (cur) cur.body.push(line)
  }
  if (cur) out.push(cur)
  // loop: NOT-WORTH — ≤ ~40 sections
  return out.map((s) => ({ version: s.version, title: s.title, body: s.body.join('\n').trim() }))
    .filter((s) => !(/^unreleased$/i.test(s.version) && !s.body))
}

// -> { current: section | null, older: [sections] } for the running version
function whatsNew(md, version) {
  const all = changelogSections(md).filter((s) => !/^unreleased$/i.test(s.version))
  const at = all.findIndex((s) => s.version === version)
  if (at >= 0) return { current: all[at], older: all.slice(at + 1) }
  return { current: all[0] || null, older: all.slice(1) }
}

// BACKLOG.md rows "| Item | Status | Soon: one sentence for users. dev notes… |"
function comingSoon(md) {
  const out = []
  // loop: NOT-WORTH — one pass over BACKLOG.md's rows (~60), when About opens
  for (const line of String(md || '').split('\n')) {
    if (!/^\|/.test(line)) continue
    const cells = line.split('|').slice(1, -1).map((c) => c.trim())
    if (cells.length < 3) continue
    const m = /^Soon:\s*(.+?[.!?])(?:\s|$)/.exec(cells[2])
    if (!m) continue
    const status = cells[1].replace(/\*/g, '').trim()
    if (/^done$/i.test(status)) continue
    out.push({ title: cells[0].replace(/\*/g, '').replace(/^After 0\.15\.10:\s*/i, ''), text: m[1], status })
  }
  return out
}

const LRCLIB = 'https://lrclib.net'
// the notices file in the source of this version (its tag; About passes the running version)
const NOTICES = 'https://github.com/MarcelineVPQ/apple-music-for-linux/blob/v{version}/licenses/hyphenation-NOTICES.txt'
// hyphenation patterns Sonata ships (package.json build.files; lyrics-syllables.js), with the licence
// each file's header (hyph-utf8, CTAN / github.com/hyphenation/tex-hyphen) states. Checked 2026-10-16,
// versions confirmed 2026-10-17 against tex-hyphen master. Each file's original notice ships in
// licenses/hyphenation-NOTICES.txt (tools/hyph-notices.js). Romanian (no licence stated) and Indonesian
// (GPL-2.0 only) are not shipped: their words pop whole (BACKLOG).
const PATTERNS = [
  ['en-us', 'English (US)', 'Gerard D. C. Kuiken', 'Permissive (copy and use with the copyright notice kept)'],
  ['en-gb', 'English (UK)', 'Dominik Wujastyk, Graham Toal', 'MIT'],
  ['de-1996', 'German', 'Stephan Hennig, Werner Lemberg, Günter Milde and others', 'MIT'],
  ['fr', 'French', 'Daniel Flipo, Bernard Gaulle, Arthur Reutenauer', 'MIT'],
  ['es', 'Spanish', 'Javier Bezos, CervanTeX', 'MIT'],
  ['it', 'Italian', 'Claudio Beccari', 'LPPL 1.3 or later, or MIT'],
  ['pt', 'Portuguese', 'Pedro J. de Rezende, J. Joao Dias Almeida, Leonardo Araujo, Aline Benevides', 'BSD 3-clause'],
  ['nl', 'Dutch', 'Piet Tutelaers', 'MIT'],
  ['sv', 'Swedish', 'Jan Michael Rynning', 'LPPL 1.2 or later'],
  ['da', 'Danish', 'Frank Jensen', 'LPPL 1.3 or later, or MIT'],
  ['nb', 'Norwegian Bokmål', 'Rune Kleveland, Ole Michael Selberg, Karl Ove Hufthammer', 'Permissive (copy and use with the copyright notice kept)'],
  ['fi', 'Finnish', 'Kauko Saarinen', '"Patterns may be freely distributed"'],
  ['pl', 'Polish', 'Hanna Kołodziejska, Bogusław Jackowski, Marek Ryćko', 'MIT (or others)'],
  ['cs', 'Czech', 'Pavel Ševeček', 'GPL 2.0 or later'],
  ['sk', 'Slovak', 'Jana Chlebíková', 'MIT'],
  ['hu', 'Hungarian', 'Bence Nagy', 'MPL 1.1, GPL 2.0 or LGPL 2.1, at your option'],
  ['tr', 'Turkish', 'Pierre A. MacKay, TUG', 'LPPL 1.0 or later'],
  ['ca', 'Catalan', 'Gonçal Badenes', 'LPPL 1.0 or later'],
  ['hr', 'Croatian', 'Igor Marinović', 'LPPL 1.0 or later, or a permissive licence'],
  ['sl', 'Slovenian', 'Matjaž Vrečko', 'LPPL 1.0 or later, or MIT']
]

// [title, rows: [what, by / licence, url?]]
const CREDITS = [
  ['Built on', [
    ['Sonata', 'Free and open source, GPL-3.0. Made by Marcy Kuhn under 42 Pixel Studios.', 'https://github.com/MarcelineVPQ/apple-music-for-linux'],
    ['Apple Music for Linux', 'The app Sonata started from, by Marcus Tomlinson (GPL-3.0).', 'https://github.com/cross-platform/apple-music-for-linux'],
    ['Electron for Content Security', 'castlabs\' Electron (MIT), with Chromium (BSD and others). Lets Apple Music\'s DRM play.', 'https://github.com/castlabs/electron-releases'],
    ['Widevine', 'Google\'s DRM module, downloaded by Electron at runtime under Google\'s terms; not part of Sonata.', '']
  ]],
  ['Lyrics', [
    ['LRCLIB', 'Lyrics for songs Apple has none for, from lrclib.net, a free lyrics database run by its community.', LRCLIB],
    ['hyphen', 'Syllables for the karaoke pop, by Yevhen Tiurin (ISC).', 'https://github.com/ytiurin/hyphen'],
    ['Hyphenation patterns', 'TeX hyphenation patterns from hyph-utf8, one file per language, each under its own licence (below). Romanian and Indonesian have no estimated syllables: their pattern files carry no licence Sonata can ship under.', 'https://github.com/hyphenation/tex-hyphen'],
    ['Hyphenation pattern notices', 'Each pattern file\'s original copyright and licence notice, unchanged (licenses/hyphenation-NOTICES.txt, also inside the app).', NOTICES]
  ]],
  ['Precise word timing (sonata-align, installed separately)', [
    ['Demucs v4 (htdemucs)', 'Separates the vocals. Meta, MIT.', 'https://github.com/facebookresearch/demucs'],
    ['wav2vec2 (English)', 'Lines the words up. torchaudio\'s wav2vec2 large-lv60k 960h, MIT.', 'https://pytorch.org/audio'],
    ['XLSR-53 fine-tunes (German, French, Spanish)', 'By Jonatas Grosman, Apache-2.0 (Common Voice data, CC0).', 'https://huggingface.co/jonatasgrosman'],
    ['MMS forced aligner', 'Other languages, only when you opt in: Meta, CC-BY-NC 4.0 (non-commercial).', ''],
    ['Whisper large-v3-turbo / faster-whisper', 'Transcription, in the helper only. OpenAI, MIT; SYSTRAN, MIT.', 'https://github.com/SYSTRAN/faster-whisper'],
    ['PyTorch', 'BSD-3-Clause.', 'https://pytorch.org'],
    ['RMVPE pitch model', 'The sung pitch for the sheet notes and the notes log. Wei et al.; RVC\'s code and weights, MIT.', 'https://github.com/RVC-Project/Retrieval-based-Voice-Conversion-WebUI']
  ]],
  ['Art', [
    ['Flying toasters', 'Sonata\'s own 3D model, lit with the "White Home Studio" HDRI from Poly Haven (CC0). A wink to Berkeley Systems\' After Dark.', 'https://polyhaven.com'],
    ['Icons', 'Lucide, ISC.', 'https://lucide.dev'],
    ['Music signs', 'The clefs, sharps and flats of the sheet notes: outlines from Noto Music by Google, SIL Open Font License 1.1 (licenses/NotoMusic-OFL.txt).', 'https://fonts.google.com/noto/specimen/Noto+Music']
  ]]
]

const NOT_AFFILIATED = 'Sonata is not affiliated with, endorsed by, or sponsored by Apple Inc. "Apple Music" and "Apple" are trademarks of Apple Inc. You need your own Apple Music subscription.'

// About's hero card (the 42PS card, the same in every 42PS app: DS5 AboutPage.tsx StudioCard)
const REPO = 'https://github.com/MarcelineVPQ/apple-music-for-linux'
const ISSUES_URL = REPO + '/issues'
const RELEASES_URL = REPO + '/releases'
const LINKS = [
  { id: 'studio', label: '42pixelstudios.com', url: 'https://42pixelstudios.com/', icon: 'globe' },
  { id: 'profile', label: 'github.com/MarcelineVPQ', url: 'https://github.com/MarcelineVPQ', icon: 'github' },
  { id: 'source', label: 'Source code (GPL-3.0)', url: REPO, icon: 'code' },
  { id: 'issues', label: 'Report an issue', url: ISSUES_URL, icon: 'bug' }
]

// -> the hero card's words for this run: version, update channel ('stable' | 'dev'), from source or not
function hero(version, channel, appImage, year) {
  const channelLabel = channel === 'dev' ? 'Development' : 'Stable'
  return {
    eyebrow: 'A 42 Pixel Studios production',
    name: 'Sonata',
    by: 'Marcy Kuhn',
    version: String(version || ''),
    channel: channel === 'dev' ? 'dev' : 'stable',
    // "Developed by Marcy Kuhn · v0.15.38 · Stable" (from source: no updates, so no channel to follow)
    line: 'v' + String(version || '') + ' · ' + channelLabel + (appImage ? '' : ' · from source'),
    copyright: '© ' + (year || new Date().getFullYear()) + ' 42 Pixel Studios — a Marcy Kuhn production.',
    links: LINKS
  }
}

// Coming soon as the DS5 board's columns: in progress first, then planned, then ideas (empty ones left out)
const SOON_GROUPS = [['Building', 'In progress'], ['Planned', 'Planned'], ['Idea', 'Ideas']]
function soonGroups(items) {
  return SOON_GROUPS.map(([status, label]) => ({ label, items: items.filter((it) => it.status.toLowerCase() === status.toLowerCase()) }))
    .filter((g) => g.items.length)
}

function aboutData(changelogMd, backlogMd, version, alignInstalled) {
  const soon = comingSoon(backlogMd)
  return {
    whatsNew: whatsNew(changelogMd, version),
    soon,
    soonGroups: soonGroups(soon),
    credits: CREDITS.map(([title, rows]) => ({ title, rows: rows.map(([what, text, url]) => ({ what, text, url: url.replace('{version}', String(version || '').replace(/^v/, '')) })) })),
    patterns: PATTERNS.map(([code, lang, by, licence]) => ({ code, lang, by, licence })),
    alignInstalled: !!alignInstalled,
    notAffiliated: NOT_AFFILIATED,
    links: LINKS,
    issues: ISSUES_URL,
    releases: RELEASES_URL
  }
}

module.exports = { changelogSections, whatsNew, comingSoon, soonGroups, hero, aboutData, CREDITS, PATTERNS, LINKS, NOT_AFFILIATED, ISSUES_URL, RELEASES_URL }
