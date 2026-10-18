# CLAUDE.md

Guidance for Claude Code in this repository. The studio-wide rules are the 42 Pixel Studios Standard
(`~/projects/42pixelstudios/docs/standards/42ps-standard.md`); this file lists the ones that apply to
Sonata, with their gates.

## Project

**Sonata** (repo and package name `apple-music-for-linux`): an Electron app around Apple's web player
(music.apple.com) for Linux, shipped as an AppImage. castlabs Electron (Widevine), plain JS, no build
step: the files listed in `package.json` `build.files` are the app (a new file must be added there, or
the AppImage fails to load it). Marcy's daily driver: change code only for real, measured problems.

**Its +1** (the one thing it's remembered for): word-level lyric timing computed locally that holds up
on live recordings. Live albums are the yardstick; measured, not eyeballed (`docs/LYRIC-TIMING.md`,
`tools/drift-check/`). The next +1 step (live sheet notes, "Sheet notes in the Studio") is Building
(BACKLOG, branch studio-sheet-notes). Every proposal says
whether it strengthens the +1 or is just "best"; no reorganisation buries the lyrics.

## Commands

```bash
npm ci && npm start        # from source (start.sh: --no-sandbox when chrome-sandbox isn't setuid)
npm test                   # node --test test/*.test.js (pure logic, no Electron, no display)
npm run gates              # tools/verdicts.js --check + tools/set-version.js --verify + tools/doc-gates.js --check (CI runs all)
npm run dist               # electron-builder: dist/sonata-<version>-x86_64.AppImage + dist/linux-unpacked
node tools/set-version.js X.Y.Z[-dev.N] --summary "…"   # the version, set in one step (never by hand)
node tools/doc-gates.js [soon|changelog|shipped|refs|version|privacy]   # the documentation gates (see below)
tools/isolated.sh start|run|stop                        # an isolated copy for checks (see Test runs)
node tools/ui-check.js <matrix|keys|loops|perf|mini|lyrics|a11y|stage|liner|experimental|every> --cdp … --insp … --display :N --out DIR
tools/check_budgets.sh [--soak]                         # resource budgets on its own isolated copy (docs/BUDGETS.md)
node tools/rail-check.js <matrix|keys|loops|perf> …     # the rail's own checks (same isolated copy)
node tools/drift-check/drift-check.js …                 # word-timing accuracy (docs/LYRIC-TIMING.md)
```

## Architecture

- **Main window** (`main.js` `createWindow`): a `BaseWindow` holding `WebContentsView`s: Apple's page
  (`appleView`, preload `preload-apple.js`: only the focus bridge), the rail (`rail.html`, on top), the
  side panel (`panel.html`: Settings and About, created on first show) and toasts (`toast.html`, only
  while one shows). `panel-model.js` `windowLayout` sizes them: Apple's view is the window minus the
  rail's room and the docked panel. Sonata's views are sandboxed with contextIsolation; Apple's page gets
  no local code except what main injects: `apple-focus.js` + `wheel-volume.js` (isolated world 999) and
  `media-position.js` (main world: the song's length and position for the desktop media controls).
  Main drives the player through `executeJavaScript` page scripts against `MusicKit.getInstance()`.
- **Floating windows**: mini player (`miniplayer.html`), lyrics (`lyrics.html`; its second form is the
  Studio, `body.stage` with `stage-ui.js` / `stage-model.js` and the Montage in `montage-*.js`; internal ids
  say `stage`, users read "Studio"), liner notes (`liner-notes.html`, `liner-notes-*.js`), the album cover
  (`cover.html`) and the visualizer (`visualizer.html`): `BrowserWindow`s with nodeIntegration on local files only, navigation and popups
  blocked (`lockDownLocalWindow`). Models with no DOM or Electron (`*-model.js`) hold the testable logic.
- **Polls**: one 5 s now-playing loop always (tray, notifications, Last.fm, Discord, update restart);
  1 s while the mini player exists; 500 ms lyrics feed while the lyrics window or visualizer exists;
  the Studio's queue read on a new song, else every 2 s, only while the Studio shows; 500 ms sung-line
  poll only while a lyrics page of the playing song is open in a shown liner notes booklet.
- **Lyrics engine**: `lyrics-sources.js` resolves Apple TTML (`/syllable-lyrics`, then `/lyrics`, through
  the page's MusicKit) then LRCLIB (Settings), cached on disk by `lyrics-store.js`
  (`~/.config/apple-music-for-linux/lyrics-cache.json`); `lyrics-timing.js` estimates word timing for
  line-only lyrics, `lyrics-syllables.js` splits syllables (`hyphen` patterns); `lyrics-view.js` +
  `lyrics-view.css` is the one view engine for the lyrics window and the visualizer overlay. Word timing
  priority: Apple/LRC words > aligned on this PC (Level 2) > refined by listening (Level 1, `listen-session.js`,
  `vocal-detect.js`, `timing-refine.js`) > estimated. One `parec` of Sonata's own stream feeds all
  listeners (`audio-listen.js` `shareListener`).
- **Align helper** (Level 2, opt-in, `docs/LEVEL2-ALIGN.md`): `align-session.js` records a line-only song
  while a lyric view is open and hands it to `align-helper.js`, a JSON-lines client for `align/server.py`
  run with the user's own venv (`align/install.sh` → `~/.local/share/sonata-align`, or
  `SONATA_ALIGN_HOME`). One helper process at most, quits after 10 min idle while a lyric view is open (2 min
  when none is); only word times are cached. Lyrics and timing entries are keyed by the recording's ISRC
  (`recording-id.js`; `title|artist` without one) and refused when its length differs by > 1.5 s.
- **Theme**: `theme.js` computes every `--s-*` token (light/dark, album accent, Glass backdrop, contrast
  raised until text reaches 4.5:1), `theme-apply.js` writes them in each page, `theme.css` holds the
  first-paint defaults (the only CSS with literal colours).
- **Updater and signed feeds**: `updater.js` is the flow (check, download, verify, install beside the
  running AppImage, Restart now, Back to stable); `update-feed.js` fetches `latest.json` (Stable) /
  `latest-dev.json` (Development) from `master` and refuses anything not signed (Ed25519 over the exact
  bytes) by a key in `TRUSTED_KEYS`, or a download whose size or SHA-512 differs. `relaunch.js` restarts
  through `systemd-run` with a clean session environment. Details: `docs/RELEASING.md`.

## Load-bearing rules

- **One theme system** (Marcy): every colour is a `--s-*` token from `theme.js`; no literal colours in
  new UI, no per-control styling; when something looks off-theme, fix the system. Gate:
  `test/theme.test.js` (no literal colours outside `theme.css`/`theme.js`, every token ≥ 4.5:1 over any
  backdrop, `theme.css` = `theme.js` defaults). Exceptions: physical things drawn as they look (the
  vinyl, the visualizer's night stage) and the 42PS brand colours in Credits.
- **Text meets 4.5:1 in every theme, album colour and Glass** (dim lyric lines 3:1). Gate: the UI checker
  (`tools/ui-check.js`: contrast with opacity counted, names, hit targets, clipping).
- **Sip, don't drink**: nothing visual runs while hidden; near-zero idle frames; new visuals state their
  idle cost in the commit and next to the code (`docs/PERFORMANCE.md`).
- **Smallest fix, not a rewrite**: scope is the reported defect; never replace a component unasked. If the
  narrow fix is impossible, say so in one line and ask.
- **New ideas go to the backlog**; build only when Marcy says "now". Design before code for big UI.
- **Cross-platform by default**; platform-only only when inherent (MPRIS, KWin, AppImage) and approved first.
- **Security baseline**: single instance, navigation and popups blocked, Apple's page gets no Node. The
  `ipcMain` handlers of Sonata's views (rail, panel, toasts, Apple's focus/volume bridge) check the sender
  and top frame and validate each argument; the floating windows' handlers (`lyrics-command`,
  `mini-command`, `viz-close`) don't yet (BACKLOG "Rule gates everywhere"). New handlers check.
- **Sandboxed preloads load only `electron`** (Electron 45: no `events`/`timers`/`url` shims, no `Buffer` or
  `setImmediate`); use Web APIs there. The engine is castlabs Electron pinned exactly (`package.json`
  `devDependencies.electron` and `build.electronVersion` name the same tag), never stock Electron (no Widevine).

## Verdicts (gate: `node tools/verdicts.js --check`, in `npm test`, `npm run gates` and CI)

Every candidate in every shipped file (`build.files` `.js` and the pages' `<script>`s, including the page
scripts main.js sends into Apple's page) carries a verdict, on its line or in the 8 lines above, word first,
added in the same commit as the code:

- `// loop: PARALLELIZE | BATCH | SERIAL-REQUIRED | HOT-PATH-OK | FIX-HOT-PATH | NOT-WORTH — reason`
  (for/while/do and `.forEach`; state N and where it runs)
- `// lifetime: OK | LEAK | WASTE | HOT-ALLOC | NOT-WORTH — release point` (timers, rAF, listeners,
  observers, child processes, windows/views/trays, sockets, streams; a recurring timer may carry `loop:`)
- `// error: SHOWN | LOGGED-OK | NOT-WORTH | PASSES-ON | SILENT-BUG | SWALLOWED — what happens`
  (try/catch, `.catch`)

Honest words: a real leak is LEAK, a hidden user-visible failure SILENT-BUG/SWALLOWED; those get a
BACKLOG row. Inside page-script template strings use `/* … */`. Measurements: `docs/PERFORMANCE.md`.

## Test runs: isolated, never Marcy's copy

Every Electron run for a check uses `tools/isolated.sh` (or the same recipe):

- started with `systemd-run --user` (clean environment, outside an IDE/snap sandbox: a snap's GTK paths
  crash Chromium with SIGTRAP, and every crash pops a notice on Marcy's desktop);
- a throwaway `HOME`, `XDG_*` dirs and `XDG_RUNTIME_DIR` (own settings and login, no PulseAudio);
- `WAYLAND_DISPLAY`, `XDG_SESSION_TYPE`, `XDG_CURRENT_DESKTOP`, `KDE_*`, `DESKTOP_SESSION`,
  `SESSION_MANAGER`, `DBUS_SESSION_BUS_ADDRESS` unset; its own Xvfb display (never her screen);
- `env -i` (a clean environment) and `dbus-run-session` from a config whose only service folder is empty: nothing
  can be D-Bus-activated (no portal, kscreen, wallet, at-spi; no tray icon or media player on her bus), with
  `GTK_USE_PORTAL=0`; her `/run/user/UID` hidden by `bwrap`;
- `--password-store=basic` (no KDE Wallet prompt) and `--no-sandbox` (Ubuntu's AppArmor userns rule);
- quit with `app.exit(0)` through the inspector (`tools/isolated.sh stop`) or by closing the window;
  **never SIGTERM** (Electron answers it with a core dump), `kill -KILL` only as a last resort;
  afterwards `tools/isolated.sh stop` must report no core dump and no desktop helper of this copy;
- **never start an AppImage from `~/Downloads`**: it repoints `~/Downloads/Sonata.AppImage` to itself and
  prunes older `sonata-*.AppImage` beside it, even with a throwaway HOME. Use `dist/linux-unpacked/apple-music-for-linux`
  or copy the AppImage to a scratch folder. Never touch the `Sonata.AppImage` symlink or Marcy's running
  Sonata; restarting it, or anything on her machine, is "say first, then wait".

The UI checker runs against Apple's logged-out page (nothing plays); `SONATA_TEST_ARTWORK=tools/worst-artwork.png`
stands in for album art, and `tools/stand-in.js` (a stand-in MusicKit in the test copy's page, a looped set of
local test tracks, no sound) plays a song for `every` and the budget check. Gate levels: every change: `npm test`
+ `npm run gates`; every dev release: the UI checker phases on an isolated copy, `tools/check_budgets.sh` (quick)
and a packaged AppImage smoke start; a stable release candidate: all of that plus `tools/check_budgets.sh --soak`
and Marcy's own QC. Use your own `--display`/ports: `tools/isolated.sh start` refuses a display in use.

## Releases (Marcy says "release"; never commit or push unless asked)

1. `node tools/set-version.js X.Y.Z[-dev.N] --summary "one sentence"` sets `package.json`,
   `package-lock.json` and the metainfo `<release>`; the CHANGELOG section is `## [X.Y.Z-dev.N] — Title`
   (Keep a Changelog, dev builds get their own sections). `node tools/set-version.js --verify vX.Y.Z…`.
2. Tag `vX.Y.Z` (Stable, `master`) or `vX.Y.Z-dev.N` (Development, a prerelease; work lands on `dev`).
3. `release.yml`: tests, verdict gate, `set-version.js --verify "$GITHUB_REF_NAME"` (a tag ≠ version fails),
   AppImage plus its build attestation, release notes from the CHANGELOG section; then `feed.yml` hashes
   the AppImage, writes and signs `latest.json` / `latest-dev.json` (secret `SONATA_FEED_KEY`), commits them
   to `master` and attests them (`gh attestation verify FILE -R MarcelineVPQ/apple-music-for-linux`).
4. **Never hand-edit a feed**: re-run *Update feed* and verify the `.sig` against `TRUSTED_KEYS`.
5. **Pushed is not done**: check CI after every push (`gh run list --branch <branch>`), fix before
   pushing anything else.

Stable never offers a pre-release; Stable gets only stable upstream engines (a castlabs beta goes to
Development first).

## Backlog: one list

`BACKLOG.md` is the one list (status words **Idea · Planned · Building · Done**). Update the row in the
same commit as the work; anything agreed in conversation gets a row the same day. A row whose Notes start
`Soon: …` or `Soon (Card title): …` is shown in About → Coming soon (`about-data.js`). Every Building or
Planned row is there unless its Item ends with **(internal)**, **(in testing)** or **(unannounced)**
(waiting for Marcy's OK: never announce a direction she hasn't). Release notes: `CHANGELOG.md`.

**Public repo: features only.** Business plans (anything about money, deals or the studio's future) never
go in a tracked file, a commit message or a branch name; Marcy keeps them private. Describe features only.

## Documentation gates (gate: `node tools/doc-gates.js --check`, in `npm run gates` and CI)

Docs are part of every change: the commit that changes behaviour updates the BACKLOG row, the CHANGELOG
`[Unreleased]` entry, the README and the help text it touches. Each gate prints PASS / FAIL / SKIP and,
on FAIL, the line and how to fix it (`test/doc-gates.test.js` seeds a mistake for each):

- **soon**: About → Coming soon = the BACKLOG's `Soon` rows; every Building / Planned row is there or
  carries a marker (the opted-out rows are printed); a Done row never keeps its `Soon`.
- **changelog**: a `feat` / `fix` / `perf` commit since the last release tag that touches a shipped file
  (`build.files`) needs words under `[Unreleased]` (or the section of the version being released). A
  commit saying "No user-facing change", or an `[Unreleased]` line saying so, passes. SKIP without tags
  (ci.yml checks out with `fetch-depth: 0`).
- **shipped** (a heuristic): an Idea / Planned row whose Notes start with a released version, say
  "Built:" / "shipped in", or name a `settings.<key>` key that exists; a Building row shipped in a released
  version whose Notes name nothing left. It can't tell that a feature exists when the row names no
  version, key or "Built:"; it reads words, not code.
- **refs**: README.md, CLAUDE.md, docs/*.md and the in-app help strings name only real files (backticked
  names, and docs/ tools/ align/ test/ … paths), `npm run` scripts, `node tools/…` tools, `settings.<key>`
  keys and Ctrl shortcuts (`shortcuts-model.js` RESERVED + ACTIONS). Not checked: CHANGELOG and BACKLOG
  (history), HTML comments, a line that names the branch a path lives on, and a doc whose first lines hold
  `> Research note, dated YYYY-MM-DD: …` (research is history: date it, don't rewrite it). It can't check
  prose such as "Settings → Section" names or numbers.
- **version**: `set-version.js --verify`, plus the metainfo's newest `<release>` is package.json's and no
  CHANGELOG section is newer.
- **privacy**: no tracked text file holds a phrase from `tools/privacy-denylist.txt` (SHA-256 per phrase,
  so the list names nothing; add one with `node tools/doc-gates.js privacy-hash "phrase"`). A line that
  must use such a word for a plain reason carries `privacy-ok` and the reason.

## Git

Commits: identity `MarcelineVPQ <25850221+MarcelineVPQ@users.noreply.github.com>` (GitHub refuses a
private email), Conventional Commits, a `Co-Authored-By: Claude …` trailer.
