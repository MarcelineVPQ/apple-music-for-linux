# Code quality audit: hardcoding and duplication

Read newest first. Each pass lists what it found in two categories, **hardcoding** (a user-facing value
typed where a single source exists or should exist) and **duplication** (the same thing written twice),
what was fixed, and the tail that is left, so nothing found is lost. The mechanical part is a gate:
`node tools/hardcodes.js --check` (in `npm run gates`, release.yml, and `.hooks/pre-commit`; turn the hook
on once per clone with `git config core.hooksPath .hooks`).

## 2026-10-18: versions and the first hardcode pass (0.15.45-dev.1, branch version-display)

Trigger: Marcy's screenshot. The update toast said "Sonata 0.15.45-dev.1 is up to date (Development)."
when it must say "0.15.45 Dev". 0.15.45 had added a display helper in `update-feed.js` and a second copy
in `panel-ui.js`, then patched a few call sites by hand. Every other place still printed the raw string.

### The one place: `version-display.js`

The source of truth stays `package.json` `version` (set only by `tools/set-version.js`). Next to it,
`version-display.js` holds every display form, the way AVIEW's version.py holds `VERSION_STRING` /
`VERSION_SHORT`:

| Form | Example | Used for |
|---|---|---|
| `short(v)` | `0.15.45 Dev` | status lines, What's new headings, the rail badge, engine versions |
| `full(v)` | `Sonata 0.15.45 Dev` | toasts, notices, desktop notifications |
| `tagged(v)` | `v0.15.45 Dev` | About's hero line, the rail badge's tooltip |
| `channelName(ch)` | `Development` / `Stable` | every channel label |
| `NAME`, `REPO_URL`, `userAgent(v)` | `Sonata`, the repo, `Sonata/0.15.45-dev.1 (…)` | product name, links, the User-Agent (raw on purpose: servers read it) |
| `CURRENT`, `SHORT`, `FULL` | this build's own | main and node code |

Main, the node-integrated windows and the main-side modules `require()` it. The sandboxed pages (panel,
rail) load it as a plain script before their models (`SonataVersionDisplay`, the same UMD pattern as
`rail-model.js`). Raw versions stay in data: feeds, file names, URLs, cache entries, notice keys,
developer logs.

### Hardcoding: fixed

| Where | Was | Now |
|---|---|---|
| `main.js` checkForUpdates (the toast in the screenshot) | `'Sonata ' + app.getVersion() + …` | `updater.js` `upToDateText()` |
| `main.js` showWhatsNew | `'Updated to Sonata ' + v` | `updater.js` `updatedText()` |
| `main.js` tray desktop notification | `'Sonata ' + st.version + ' is available'` / `… is installed` | `updater.js` `updateNotification()` |
| `updater.js` updateNotice (available, Back to stable, downloading, installing, ready) | raw `st.version` | `full()` / `short()` |
| `updater.js` statusLine | its own `shownVersion` wrapping | `short()`, `channelName()` |
| `about-data.js` hero line | `'v' + version` (About showed "v0.15.45-dev.1") | `tagged()`, `channelName()` |
| `rail-model.js` dev badge and tooltip | main sent a formatted version, the tooltip added `v` + it | `short()` / `tagged()` in the model; main sends the raw version |
| `main.js` For the curious → versions | raw Sonata and engine versions | `short()` |
| `curious-model.js` timing source | `'sonata-align ' + engine` | `short()` |
| `align-helper.js` repairText, `panel-ui.js` helper notes | raw engine versions | `short()` |
| `panel-ui.js` Updates, What's new, About summary | private `showV()` copy | `full()` / `short()` / `channelName()` |
| Channel labels: `main.js`, `updater.js`, `about-data.js`, `panel-model.js`, `panel-ui.js` (2), `rail-model.js` | typed `'Development'` / `'Stable'` | `channelName()` |
| `panel-ui.js` "every 2 hours" | typed | `updater.js` `CHECK_EVERY_HOURS` (main's timer reads it too) |
| `panel-ui.js` "at most 1,000 songs (about 110 MB)" | typed | `notes-log.js` `MAX_FILES`, `maxSizeText()` |
| `panel-ui.js` "at most 500 songs" (sheet notes) | typed | `sheet-notes-store.js` `MAX_FILES` |
| `panel-ui.js` the notes-log and sheet-notes folders | typed `~/.local/share/…`, `~/.config/…` (wrong with `XDG_DATA_HOME` set) | the real folders, from main |
| `panel-ui.js` "again every 5 seconds" | typed | `curious-sampler.js` `REFRESH_MS` |
| `panel-ui.js` `'173 MiB'` fallback | typed beside `notes-log.js` `sizeText(RMVPE.bytes)` | removed (main always sends the size) |
| `rail-model.js` "retries every 30 s" (Discord) | typed | main's `NOW_PLAYING_MS × DISCORD_RETRY_TICKS` (the reconnect and the scrobble count read them too) |
| `lastfm.js` "older than 14 days" (log) | typed | `SCROBBLE_MAX_AGE_S` |
| `curious-sampler.js` "quits after 2 min idle" | typed, and wrong while a lyric view is open (10 min) | `align-helper.js` `IDLE_MS`, `WARM_IDLE_MS` |

### Duplication: fixed

| Where | Was | Now |
|---|---|---|
| Version display | `update-feed.js` `shownVersion` + `panel-ui.js` `showV` | `version-display.js` only |
| User-Agent | 3 copies: `main.js`, `liner-notes-sources.js`, `montage-sources.js` (each with its own `REPO_URL`) | `version-display.js` `userAgent()` |
| Repository URL | 6 literals (`main.js`, `about-data.js` ×3, the two sources files) | `version-display.js` `REPO_URL` |
| Product name | `main.js` `appName = 'Sonata'`, `about-data.js` | `version-display.js` `NAME` |
| Floating window titles | typed twice each (created, and the KWin keep-above rule) | `main.js` `TITLES` |
| The RMVPE download sentence | the same sentence in two switches | `panel-ui.js` `rmvpeNote()` |

### The gate

`tools/hardcodes.js` reads every shipped file (`build.files` `.js` and the pages' inline scripts) and fails on:

- **raw-version**: a string joined to `app.getVersion()`, `x.version`, `fooVersion` or `fooVersion()`, or
  a template `${…version}`;
- **channel-name**: a `'Stable'` / `'Development'` label;
- **repo-url**: the repository URL;
- **user-agent**: a `'Sonata/'` User-Agent;
- **number-text**: "every N s/min/hours", "at most N songs", "after N min"… typed in a string.

`version-display.js` is not checked. A line that must break a rule (a notice's key, a feed URL, the
engine's folder name) carries `// hardcode: OK — reason`; today there are 6, listed by
`node tools/hardcodes.js`. Developer logs (`console.*`) are not checked. Tests: `test/hardcodes.test.js`
(a seeded mistake per rule), `test/version-display.test.js` (every update text rendered with a dev
version shows no "-dev."). On screen: `tools/ui-check.js every` checks every page's text, tooltips and
names, and the window titles, for a raw dev version (URLs and release file names keep the real one).

### The tail (found, not fixed in this pass)

| # | Category | Where | What | Should come from |
|---|---|---|---|---|
| 1 | hardcoding | ~78 strings across `panel-ui.js`, `rail-model.js`, `curious-*.js`, `align-helper.js`, `main.js`, `about-data.js` | the product name "Sonata" in prose | `NAME`. Prose, not a label: interpolating every sentence hurts reading for no gain until the name can change. Gate it only if a rename is planned. |
| 2 | hardcoding | 13 strings | the helper's name "sonata-align" in prose | one `HELPER_NAME` (beside the pin in `align-helper.js`) |
| 3 | hardcoding | 24 strings | the feature name "Precise word timing" in prose and labels | one feature-name table, like `CHANNELS` |
| 4 | hardcoding | `panel-ui.js` (helper not installed) | "about 10 GB with its Python packages and models", "a few MB" | `align/engine.json` (add the measured install size beside the download size) |
| 5 | hardcoding | `panel-ui.js` | the default helper folder `~/.local/share/sonata-align` as a fallback | `align-helper.js` `helperPaths` (main sends the real one once known) |
| 6 | hardcoding | `panel-ui.js`, `curious-model.js` | "Development builds…", "(Development channel)" in prose | `channelName('dev')` (prose; gate covers only labels) |
| 7 | duplication | `update-feed.js` `LEGACY_REPO` | the source repo's slug again | kept on purpose: a frozen pin that old builds read; changing it from `REPO_URL` would move what they trust |
| 8 | duplication | `about-data.js` `LINKS` | `https://github.com/MarcelineVPQ` (the owner) beside `REPO_URL` | an `OWNER_URL` in `version-display.js` |
| 9 | hardcoding (colours) | — | colours outside theme tokens | already gated: `test/theme.test.js` and the UI checker's token audit |
