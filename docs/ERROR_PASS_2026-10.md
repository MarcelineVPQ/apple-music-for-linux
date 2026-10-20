# Error pass: every catch, rejection and unguarded parse, with what happens to the failure

_2026-10-19, Sonata QC phase part A, on branch `qc-passes` (origin/dev 0.15.69-dev.1, bd85dea). The DS5 configurator's pass pattern (its CLAUDE.md "Loop / Lifetime / Error / Cache pass"): a script lists every candidate, each one carries a verdict comment in the code, nothing is sampled by eye. No behaviour changed in this branch: only verdict comments, the lister and the gate. Marcy picks the fix batches (BACKLOG row "QC passes 2026-10: fix batches")._

## How the list was made

Two listers, both in `npm run gates`, `.hooks/pre-commit`, `npm test` and CI:

- `tools/verdicts.js` (since 0.15.37): line patterns over every shipped file (`build.files` `.js`, the pages' inline `<script>`s and the page scripts main.js sends into Apple's page as text). It gates every `for` / `while` / `do` / `.forEach`, every acquisition (timers, rAF, listeners, observers, child processes, windows/views/trays, sockets, streams, watchers, audio contexts, and now Web Animations `el.animate`, object URLs, power-save blockers and global shortcuts) and every `try/catch` / `.catch`.
- `tools/passes.js` (new, acorn 8.15.0 as an exact devDependency): parses every shipped file and lists what a line pattern can't see. Hot paths are resolved by function name across the shipped files from their roots (rAF / setInterval / re-arming setTimeout callbacks, high-rate events: parec `'data'`, `timeupdate`, pointer/mouse move, scroll, wheel, resize, `message`; functions named tick/frame/draw/paint/render/step/animate); a name resolves to the caller's own file first, else to its one definition. Gated: hot / awaiting / nested array callbacks; floating promises, `.then(ok, onRejected)`, `void` calls, `JSON.parse` outside a try; and every kept-state row (`// cache: VERDICT — key=…; invalidated=…; bound=…`). Doc-only rows: empty catches (they carry the verdicts.js verdict), clock comparisons (ttl), sync reads in loops (repeat-io), sync reads reached from a timer (poll-io), and the acquisition context. The page scripts inside main.js's template strings are text to acorn; verdicts.js covers them.

The verdicts were given by reading each row's code and callers (how often it really runs), in seven file groups. Name-resolved "hot" is an over-approximation by design: most rows reached from the 500 ms lyrics poll (main.js lyricsTick, `setInterval` every 500 ms) run once per track change, behind `if (key !== lyricsKey || retryDue)`, and their verdicts say so.

Floating-promise rows: most call an async function that catches everything inside (askAlignStatus, refreshPalette, stageSongRead, showMoreMenu, feedDiscord, notifyTrack, finishLastFm, updater check/install, checkEngineFeed, the installer's remove, quitGuard.allow, portalOn) and say so; `loadFile` of a shipped page only rejects when its window closes while loading (an unhandled-rejection warning in main's log).

## Fix candidates (by impact)

| # | Where | What happens | Who hits it | Verdict |
|---|---|---|---|---|
| E1 | `main.js:4502` `appleWC().loadURL(...)` | no catch and no `did-fail-load` handler: Apple's area stays blank with no words and no retry; Ctrl+R is the only way out | every start while offline or when Apple is unreachable | **SILENT-BUG** |
| E2 | `main.js:4381` connectLastFm | `lastfm.writeTemplate()` (sync write) runs before the try: an unwritable config folder makes Connect do nothing | rare | **SILENT-BUG** |
| E3 | `main.js:4383` connectDiscord | the same with `saveDiscordConfig()` | rare | **SILENT-BUG** |
| E4 | `audio-listen.js:330` shareListener dispatch | one listener's throw is dropped without a log (createListener's LOGGED-OK never fires in the shared setup) | debugging only | **SWALLOWED** |
| E5 | `lyrics-store.js` write failure (NOT-WORTH "it's a cache") | the same store keeps learned/refined word timing (`refined\|` entries): a persistent write failure (disk full, read-only) loses learned timing across restarts, unannounced | rare | doc: maybe LOGGED-OK → SHOWN |
| E6 | `shortcuts.js` `portalOn` + `portal-shortcuts.js` openSession | a failed CreateSession/BindShortcuts closes the connection, whose 'close' handler already calls `retryLater`; the catch calls it again (retries 2, an orphaned timer) | a first failed portal session retries on its own and burns two of the three tries | bug (see BUG_HUNT) |

Verdict corrected: `song-actions.js:48` SHOWN → LOGGED-OK (a failed rating read shows "not a favourite"; the failure only reaches main's log).

## Counts

| Verdict | Rows |
|---|---|
| LOGGED-OK | 67 |
| NOT-WORTH | 223 |
| PASSES-ON | 32 |
| SHOWN | 45 |
| SILENT-BUG | 3 |
| SWALLOWED | 1 |
| **total** | 371 |

## Flagged rows (fix candidates, as the comments say)

| file:line | what | verdict | reason |
|---|---|---|---|
| audio-listen.js:330 | empty-catch | **SWALLOWED** | one user's throw doesn't stop the others, but unlike createListener it isn't logged |
| main.js:4381 | floating | **SILENT-BUG** | rare: writeTemplate() (sync write) is before the try; unwritable config = no notice |
| main.js:4383 | floating | **SILENT-BUG** | rare: saveDiscordConfig() is before the try; unwritable config = Connect does nothing |
| main.js:4502 | floating | **SILENT-BUG** | offline or Apple down at start: loadURL rejects, Apple's view stays blank, unexplained |

## Every row

_Generated: `node tools/passes.js --md DIR` writes these tables. Line numbers are those of the commit that adds this file._

| file:line | what | trigger / context | verdict | reason |
|---|---|---|---|---|
| align-helper.js:44 | try { return JSON.parse(fs.readFileSync(path.join(dir, 'engi |  | NOT-WORTH | no pin (a broken checkout): no engine is wanted, Settings says "not installed" |
| align-helper.js:71 | try { version = String(readText(path.join(home, 'active-engi |  | NOT-WORTH | no file (an install from before 0.15.46, or none): the pinned engine is used |
| align-helper.js:75 | try { meta = JSON.parse(readText(path.join(home, 'engine-' + |  | NOT-WORTH | an engine folder without ENGINE.json is not an engine: the pinned one is used |
| align-helper.js:147 | try { io.accessSync(paths.python, fs.constants.X_OK); io.acc |  | NOT-WORTH | missing or not executable means "not installed", which Settings → Precise timing says |
| align-helper.js:166 | try { io.lstatSync(py) } catch (e) { |  | SHOWN | each failed check below is a state the caller turns into a notice (repairText) |
| align-helper.js:169 | try { target = io.readlinkSync(py) } catch (e) { target = nu |  | SHOWN | each failed check below is a state the caller turns into a notice (repairText) |
| align-helper.js:171 | try { real = io.realpathSync(py) } catch (e) { return { stat |  | SHOWN | each failed check below is a state the caller turns into a notice (repairText) |
| align-helper.js:172 | try { io.accessSync(real, fs.constants.X_OK) } catch (e) { r |  | SHOWN | each failed check below is a state the caller turns into a notice (repairText) |
| align-helper.js:181 | empty-catch |  | NOT-WORTH | no pyvenv.cfg: the python link alone decides |
| align-helper.js:188 | try { io.accessSync(paths.server, fs.constants.R_OK); engine |  | SHOWN | no engine (or not the pinned one) is the 'update' state, which Settings explains |
| align-helper.js:234 | try { msg = JSON.parse(line) } catch (e) { if (onBad) onBad( |  | LOGGED-OK | a non-JSON line goes to onBad (logged as "helper said"); the next line is read |
| align-helper.js:246 | empty-catch |  | NOT-WORTH | a kill of an already-gone process at exit has nothing left to do |
| align-helper.js:281 | empty-catch |  | NOT-WORTH | no topology: its own core |
| align-helper.js:284 | } catch (e) { |  | NOT-WORTH | no topology: its own core |
| align-helper.js:434 | try { if (c && c.pid) setPriority(c.pid, HELPER_NICE) } catc |  | LOGGED-OK | no pid (spawn failed: 'error' follows) or not allowed: the helper runs at the normal priority |
| align-helper.js:482 | floating | write() | NOT-WORTH | a pipe already closed means the helper is leaving anyway; the grace timer below kills it otherwise |
| align-helper.js:482 | floating | write() | NOT-WORTH | a pipe already closed means the helper is leaving anyway; the grace timer below kills it otherwise |
| align-helper.js:487 | empty-catch |  | NOT-WORTH | a helper that doesn't leave within the grace time is killed (SIGTERM, then SIGKILL); |
| align-helper.js:488 | empty-catch |  | NOT-WORTH | a helper that doesn't leave within the grace time is killed (SIGTERM, then SIGKILL); |
| align-helper.js:499 | empty-catch |  | NOT-WORTH | a kill that throws means the helper is already gone; SIGKILL after 2 s otherwise |
| align-helper.js:500 | empty-catch |  | NOT-WORTH | a kill that throws means the helper is already gone; SIGKILL after 2 s otherwise |
| align-helper.js:524 | try { c = ensure() } catch (e) { reject(e); return } |  | PASSES-ON | not installed / crashed too often: the caller's promise rejects (Settings shows it, the session logs it) |
| align-helper.js:529 | write(c, messages).catch((e) => fail(id, e))   // error: PAS |  | PASSES-ON | the job's promise rejects |
| align-helper.js:541 | then-reject |  | NOT-WORTH | a failed ping only means nothing extra is asked; the notes job reports its own failure |
| align-helper.js:552 | return request(id, [{ cmd: 'ping' }], PING_TIMEOUT_MS).catch |  | PASSES-ON | rethrown to askAlignStatus (main.js), which shows it in Settings |
| align-helper.js:635 | floating | write() | NOT-WORTH | a closed pipe: the helper is gone; `done` rejects through its exit |
| align-helper.js:635 | floating | write() | NOT-WORTH | a closed pipe: the helper is gone; `done` rejects through its exit |
| align-helper.js:649 | floating | write() | NOT-WORTH | a closed pipe: the helper is gone and its sections with it |
| align-helper.js:649 | floating | write() | NOT-WORTH | a closed pipe: the helper is gone and its sections with it |
| align-helper.js:660 | empty-catch |  | NOT-WORTH | a kill that throws means the helper is already gone |
| align-session.js:905 | floating | .then without .catch | LOGGED-OK | one log line; the song plays on (delayed) with section timing |
| align-session.js:905 | then-reject |  | LOGGED-OK | one log line; the song plays on (delayed) with section timing |
| align-session.js:952 | then-reject |  | NOT-WORTH | keeps the chain going; helper.forget is sync and catches its own write error |
| align-session.js:958 | then-reject |  | NOT-WORTH | keeps the chain going; helper.forget is sync and catches its own write error |
| align-session.js:1005 | .catch((e) => { |  | PASSES-ON | a final pass the helper can't build from kept sections (no-cache) is sent |
| align-session.js:1030 | .catch((e) => {   // error: LOGGED-OK — see the comment abov |  | LOGGED-OK | see the comment above run() |
| align-session.js:1044 | then-reject |  | NOT-WORTH | keeps the chain going; run() catches inside (LOGGED-OK) and the caller holds `job` |
| align-session.js:1075 | .catch((e) => {   // error: SHOWN — see above (a section's n |  | SHOWN | see above (a section's notes that failed: the whole-song pass after the song has them) |
| align-session.js:1106 | .catch((e) => {   // error: SHOWN — see above |  | SHOWN | see above |
| align-session.js:1116 | then-reject |  | NOT-WORTH | keeps the chain going; run() catches inside (deps.notes.failed, SHOWN) |
| align-session.js:1146 | .catch((e) => {   // error: LOGGED-OK — see above |  | LOGGED-OK | see above |
| align-session.js:1153 | then-reject |  | NOT-WORTH | keeps the chain going; run() catches inside (LOGGED-OK) |
| align-session.js:1185 | .catch((e) => { |  | PASSES-ON | kept sections the helper no longer has (no-stem): once more with the audio |
| align-session.js:1195 | .catch((e) => {   // error: SHOWN — see above |  | SHOWN | see above |
| align-session.js:1203 | then-reject |  | NOT-WORTH | keeps the chain going; run() catches inside (deps.notes.failed, SHOWN) |
| audio-listen.js:114 | empty-catch |  | NOT-WORTH | a process that ended mid-scan is skipped |
| audio-listen.js:132 | try { kids = readChildren(pid) } catch (e) { if (pid === roo |  | NOT-WORTH | a child gone mid-walk is skipped; no children files at all (old kernel): the full /proc scan below |
| audio-listen.js:136 | } catch (e) {   // error: NOT-WORTH — no children files: the |  | NOT-WORTH | no children files: the full /proc scan instead |
| audio-listen.js:149 | empty-catch |  | NOT-WORTH | a kill at exit of a process already gone has nothing left to do |
| audio-listen.js:182 | try { list = JSON.parse(String(stdout)) } catch (e) { return |  | NOT-WORTH | pactl missing, slow or unparsable -> null (counts as a failed start, retried with backoff) |
| audio-listen.js:184 | try { pids = tree(appPid) } catch (e) { pids = new Set([appP |  | NOT-WORTH | pactl missing, slow or unparsable -> null (counts as a failed start, retried with backoff) |
| audio-listen.js:220 | } catch (e) { |  | LOGGED-OK | — no parec: logged, listening off ('unavailable'; the visualizer falls back to the system mix) |
| audio-listen.js:244 | try { opts.onChunk(mid, wallMs, side) } catch (e) { log('chu |  | LOGGED-OK |  |
| audio-listen.js:279 | empty-catch |  | NOT-WORTH | a kill that throws means that parec is already gone |
| audio-listen.js:304 | empty-catch |  | NOT-WORTH | a kill that throws means parec is already gone; one that ignores SIGTERM is killed hard after 1 s |
| audio-listen.js:305 | empty-catch |  | NOT-WORTH | a kill that throws means parec is already gone; one that ignores SIGTERM is killed hard after 1 s |
| audio-listen.js:330 | empty-catch |  | SWALLOWED | one user's throw doesn't stop the others, but unlike createListener it isn't logged |
| css-replacer.js:17 | if (old) return webContents.removeInsertedCSS(old).catch(()  |  | NOT-WORTH | a key from a previous document is stale; removing it fails and there is nothing to remove |
| css-replacer.js:19 | }).catch(() => {}) |  | NOT-WORTH | insertCSS fails only while the page is mid-navigation; the next navigation or title change applies it again |
| curious-sampler.js:67 | try { v.wc.beginFrameSubscription(true, () => { rec.n++ });  |  | NOT-WORTH | a view that can't be subscribed (destroyed meanwhile, no compositor) shows no frame count |
| curious-sampler.js:77 | empty-catch |  | NOT-WORTH | a view closed during the window: nothing to end |
| curious-sampler.js:98 | try { list = out ? JSON.parse(out) : null } catch (e) { list |  | NOT-WORTH | pactl's answer unreadable: "not yet known" |
| curious-sampler.js:146 | try { names = io.readdirSync(dir).filter((n) => n.endsWith(s |  | NOT-WORTH | no folder: no notes |
| curious-sampler.js:151 | try { mtime = io.statSync(path.join(dir, name)).mtimeMs } ca |  | NOT-WORTH | removed meanwhile: no notes |
| curious-sampler.js:155 | try { doc = JSON.parse(io.readFileSync(path.join(dir, name), |  | NOT-WORTH | a damaged log file reads as no notes ("not yet known") |
| curious-sampler.js:193 | const npP = Promise.resolve().then(() => deps.nowPlaying()). |  | NOT-WORTH | Apple's page busy or gone: "Nothing playing" this refresh |
| curious-sampler.js:230 | floating | .then without .catch | LOGGED-OK | a failed refresh is logged; the next one tries again |
| curious-sampler.js:230 | floating | .then without .catch | LOGGED-OK | a failed refresh is logged; the next one tries again |
| curious-sampler.js:244 | floating | .then without .catch | LOGGED-OK | logged; the next refresh tries again |
| curious-sampler.js:244 | floating | .then without .catch | LOGGED-OK | logged; the next refresh tries again |
| dbus-wire.js:274 | try { kv[part.slice(0, i)] = decodeURIComponent(part.slice(i |  | NOT-WORTH | a stray % stays literal |
| dbus-wire.js:314 | empty-catch |  | NOT-WORTH | already gone |
| dbus-wire.js:335 | .catch((err) => { clearTimeout(timer); fail(err) })   // err |  | PASSES-ON | the caller's open() rejects |
| dbus-wire.js:344 | try { got = decodeMessage(this.buf) } catch (err) { this.shu |  | PASSES-ON | a malformed message closes the connection; the owner hears 'close' |
| dbus-wire.js:375 | try { serial = this.send(Object.assign({ type: 'call' }, m)) |  | PASSES-ON | a value the signature can't hold: the caller's promise rejects |
| dbus-wire.js:391 | empty-catch |  | NOT-WORTH | already gone |
| discord.js:82 | } catch (e) { |  | NOT-WORTH | — malformed frame: drop the connection rather than crash; the 30 s reconnect tries again |
| engine-feed.js:39 | try { f = JSON.parse(text) } catch (e) { throw bad('is not v |  | PASSES-ON | thrown as the refusal Settings → Precise timing logs |
| engine-feed.js:125 | try { u = new URL(raw) } catch (e) { return null }   // erro |  | NOT-WORTH | not a URL: no test feed |
| engine-feed.js:150 | if (channel === 'stable') { try { return await read('stable' |  | PASSES-ON | any other error passes on (main logs it) |
| engine-feed.js:152 | try { return await read('dev') } catch (e) { if (e.code ===  |  | PASSES-ON | a Development feed that can't be read (none published yet): the Stable one, whose errors pass on |
| game-guard.js:110 | try { pids = deps.fs.readdirSync('/proc').filter((n) => /^\d |  | NOT-WORTH | no /proc (not Linux, a sandbox): "can't tell" |
| game-guard.js:118 | try { comm = deps.fs.readFileSync('/proc/' + pid + '/comm',  |  | NOT-WORTH | the process ended between readdir and read |
| game-guard.js:123 | empty-catch |  | NOT-WORTH | the reaper ended meanwhile: not a game now |
| game-guard.js:132 | try { cards = deps.fs.readdirSync('/sys/class/drm').filter(( |  | NOT-WORTH | no DRM sysfs: "can't tell" |
| game-guard.js:141 | empty-catch |  | NOT-WORTH | a card without these files (not AMD, an old kernel) is skipped |
| game-guard.js:189 | .catch(() => state)       // error: NOT-WORTH — a failed che |  | NOT-WORTH | a failed check keeps the current state |
| gfx-model.js:197 | try { j = JSON.parse(text) } catch (e) { j = null }   // err |  | NOT-WORTH | an unreadable marker: a strike for every switch that is on (below) |
| gfx-runtime.js:50 | try { stored = settingsStore.fromStored(JSON.parse(fs.readFi |  | NOT-WORTH | — no settings file (first start) or an unreadable one: every switch is off (the default) |
| gfx-runtime.js:54 | try { marker = fs.readFileSync(sentinelFile, 'utf8') } catch |  | NOT-WORTH | no marker: the last start was healthy (or had no switch on) |
| gfx-runtime.js:82 | } catch (e) { log('[gpu] start marker: ' + e.message) }   // |  | LOGGED-OK | no marker means no safety net for this one start; said in the log |
| gfx-runtime.js:86 | try { fs.rmSync(sentinelFile, { force: true }) } catch (e) { |  | LOGGED-OK | a marker left behind turns the switches off at the next start, the safe side |
| gpu-detect.js:33 | try { names = io.readdirSync(root) } catch (e) { return [] } |  | NOT-WORTH | no /sys/class/drm (not Linux, a container): no cards, lspci is asked instead |
| gpu-detect.js:34 | const read = (f) => { try { return String(io.readFileSync(f, |  | NOT-WORTH | a missing file is an unknown value |
| gpu-detect.js:131 | try { text = String(read('/proc/cpuinfo')) } catch (e) { ret |  | NOT-WORTH | no /proc: unknown, Auto takes the processor build |
| hdr-glow.js:124 | })().catch((e) => { failed = true; console.error('hdr glow:  |  | LOGGED-OK | no HDR glow; the SDR glow stays (the CSS one) |
| hdr-glow.js:223 | floating | .then without .catch | NOT-WORTH | start()'s promise catches inside (LOGGED-OK) and sung() catches draw errors |
| hdr-glow.js:231 | try { draw(el) } catch (e) { hide(); console.error('hdr glow |  | LOGGED-OK | this word keeps its SDR glow; the next word tries again |
| helper-install-model.js:59 | try { const e = JSON.parse(line.slice(9)); return e && typeo |  | NOT-WORTH | a line that isn't JSON after the marker is ignored (kept in the tail) |
| helper-install-model.js:356 | try { m = JSON.parse(String(text \|\| '')) } catch (e) { retur |  | NOT-WORTH | not JSON: no job to resume (the file is removed by the caller) |
| helper-installer.js:76 | } catch (e) { onEvent({ ev: 'fail', code: 'spawn', message:  |  | SHOWN | a spawn that throws (no /bin/sh): the job fails with code spawn |
| helper-installer.js:140 | try { text = readFile(lic.path) } catch (e) { jobEvent({ ev: |  | SHOWN | the licence file can't be read: the job fails (nothing is installed without it) |
| helper-installer.js:168 | try { await opts.models(st.job, (ev) => jobEvent(Object.assi |  | SHOWN | a models download that fails: the job ends failed with code models (installed, models on first use) |
| helper-installer.js:190 | floating | install() | NOT-WORTH | install() turns every failure into the job's failed phase (shown); exec never rejects |
| helper-installer.js:198 | empty-catch |  | NOT-WORTH | the kept download (1.5 MB) is replaced by the next licence fetch anyway |
| helper-installer.js:207 | empty-catch |  | NOT-WORTH | the group is gone already (it just exited): nothing to stop |
| json-salvage.js:44 | try { return { ok: true, value: JSON.parse(raw) } } catch (e |  | NOT-WORTH | an item that doesn't parse is the damage being salvaged: dropped and counted |
| lastfm.js:17 | } catch (e) { |  | NOT-WORTH | — no file yet (or unreadable): not configured; Connect in Settings says what to do |
| lastfm.js:160 | try { deps.save(queue.slice()) } catch (e) { log('last.fm: p |  | LOGGED-OK | still queued in memory and sent this session; only a quit before then loses them |
| lastfm.js:173 | try { loaded = deps.load ? deps.load() : [] } catch (e) { lo |  | NOT-WORTH | no file yet (or unreadable): nothing waiting |
| lastfm.js:211 | } catch (e) { |  | LOGGED-OK | — the scrobbles stay queued (on disk too) and are sent again after a backoff |
| liner-notes-model.js:99 | } catch (e) { P.mb = fail(P.mb, e, now()); if (deps.log) dep |  | SHOWN | the Credits page and Sources say MusicBrainz didn't load |
| liner-notes-model.js:120 | } catch (e) { P.wikidata = fail(P.wikidata, e, now()); if (d |  | SHOWN | the Background page and Sources say Wikidata didn't load |
| liner-notes-model.js:127 | } catch (e) { P.wiki = Object.assign(fail(P.wiki, e, now()), |  | SHOWN | the Background page and Sources say Wikipedia didn't load |
| liner-notes-model.js:143 | } catch (e) { P.caa = fail(P.caa, e, now()); if (deps.log) d |  | SHOWN | the Booklet page and Sources say the scans didn't load |
| liner-notes-model.js:154 | try { P.setlist = Object.assign(ok(await S.setlistFm(g, key, |  | SHOWN | the Recording page and Sources say setlist.fm didn't load |
| liner-notes-model.js:175 | json-parse | outside a try | NOT-WORTH | deep copy of the store's own entry (already parsed JSON, no cycles); cannot throw |
| liner-notes-model.js:190 | then-reject |  | LOGGED-OK | onRejected logs the stack and settles with the entry; each source catches its own failure |
| liner-notes-sources.js:77 | } catch (e) { |  | PASSES-ON | — no connection or no answer in time: the caller marks that source failed (shown in the booklet) |
| liner-notes-sources.js:84 | try { return await res.json() } catch (e) { throw failure('b |  | PASSES-ON | the caller marks the source failed |
| liner-notes-sources.js:88 | lane.chain = run.catch(() => {}) |  | NOT-WORTH | the lane only orders requests; each caller gets its own failure from `run` |
| listen-session.js:183 | try { res = deps.refineWords(line, evidence, opts) } catch ( |  | LOGGED-OK | a refine that throws is logged; the line keeps its estimate |
| lookahead-page.js:33 | empty-catch |  | NOT-WORTH | a page without a document element can't be told; the next event tries again |
| lookahead-page.js:42 | empty-catch |  | NOT-WORTH | no MusicKit yet: nothing to remember |
| lookahead-page.js:57 | empty-catch |  | NOT-WORTH | a pause MusicKit refuses: the helper's gate drops the new song's audio until main plays it from its start |
| lookahead-page.js:66 | empty-catch |  | NOT-WORTH | MusicKit not configured yet: tried again |
| lookahead-page.js:89 | empty-catch |  | NOT-WORTH | news that isn't JSON is dropped |
| lookahead.js:329 | return line.cmd(cmd).catch((e) => { log('helper: ' + cmd + ' |  | LOGGED-OK | a command the helper didn't answer: logged; its exit (if that's why) falls back |
| lookahead.js:342 | } catch (e) {   // error: SHOWN — the status line says the h |  | SHOWN | the status line says the helper could not start |
| lookahead.js:381 | }).catch((e) => { if (line === l) { fail('no control socket: |  | SHOWN | the status line |
| lookahead.js:404 | empty-catch |  | NOT-WORTH | already gone |
| lookahead.js:422 | empty-catch |  | NOT-WORTH | a kill that throws means it is already gone |
| lookahead.js:440 | }).catch((e) => { log('stream lookup failed: ' + e.message); |  | LOGGED-OK | tried again on the next stream event |
| lookahead.js:458 | }).catch((e) => log('stream lookup failed: ' + e.message))   |  | LOGGED-OK | as above |
| lookahead.js:467 | try { s = deps.spawn('pactl', ['subscribe'], { stdio: ['igno |  | LOGGED-OK | routing is then checked on play and item events only |
| lookahead.js:585 | empty-catch |  | NOT-WORTH | already gone |
| lyrics-prefetch.js:76 | try { upcoming = await deps.readQueue() } catch (e) { return |  | NOT-WORTH | no queue yet (page loading): nothing to look up; the next song tries again |
| lyrics-sources.js:365 | try { res = await deps.fetch(url, { headers }) } catch (e) { |  | PASSES-ON | — offline, DNS, refused: status 0 for the caller's message and retry |
| lyrics-sources.js:386 | } catch (e) { exactFailed = e /* error: PASSES-ON — falls th |  | PASSES-ON | falls through to search; thrown below if that finds nothing |
| lyrics-sources.js:394 | try { hits = await get(base + '/api/search?' + s) } catch (e |  | PASSES-ON | falls through to search; thrown below if that finds nothing |
| lyrics-sources.js:523 | } catch (e) { |  | SHOWN | — a failed Apple lookup (page mid-navigation, Apple's API erring) is tried again; then |
| lyrics-sources.js:543 | } catch (e) { |  | SHOWN | — logged, and the window says which service failed and how (lyrics-view statusText); |
| lyrics-store.js:33 | try { text = io.readFileSync(file, 'utf8') } catch (e) { ret |  | NOT-WORTH | no cache file yet: start empty |
| lyrics-store.js:38 | empty-catch |  | SHOWN | damaged: salvaged below, one notice (onRecovered) |
| lyrics-store.js:50 | try { aside = asideName(file, opts.now ? opts.now() : new Da |  | SHOWN | no copy kept: the notice says so |
| lyrics-store.js:76 | empty-catch |  | NOT-WORTH | cache only: a failed write is not an error for the user |
| lyrics-syllables.js:49 | } catch (e) { h = null } |  | NOT-WORTH | a missing or broken pattern file means no estimated syllables, never a broken view |
| lyrics.html:861 | empty-catch |  | NOT-WORTH | the flip was cancelled (a newer cover or the window closing); the cover is set below anyway |
| main.js:148 | try { settingsStore.saveSettings(settingsPath, settings) } c |  | NOT-WORTH | a failed save (disk full, read-only) is logged; the setting holds for this run and the next change saves again |
| main.js:231 | try { kdeScheme = desktopScheme.parseKdeglobals(fs.readFileS |  | NOT-WORTH | no kdeglobals (not KDE): that source says nothing, the next one decides |
| main.js:240 | } catch (e) { portalScheme = null; schemeSpawnFailed(e) }    |  | LOGGED-OK | logged once; no portal answer |
| main.js:251 | } catch (e) { schemeWatch = null; schemeSpawnFailed(e); retu |  | LOGGED-OK | logged once, no gdbus: the scheme read at start stays |
| main.js:270 | try { if (themeFile) fs.writeFileSync(themeFile, v) } catch  |  | NOT-WORTH | logged; the choice holds for this run |
| main.js:293 | floating | openExternal() | NOT-WORTH | Linux: resolves once xdg-open is launched; only a missing xdg-open rejects (a warning) |
| main.js:295 | empty-catch |  | NOT-WORTH | not a URL: nothing to open |
| main.js:366 | .catch((e) => console.error('player command failed:', comman |  | LOGGED-OK | page mid-load (no MusicKit yet): that one command does nothing |
| main.js:410 | } catch (e) { /* error: NOT-WORTH — no MusicKit yet (page lo |  | NOT-WORTH | no MusicKit yet (page loading): { ok: false }, the polls skip that tick |
| main.js:433 | floating | loadFile() | NOT-WORTH | packaged miniplayer.html; rejects only if the window closes mid-load (a warning) |
| main.js:465 | floating | refreshPalette() | NOT-WORTH | — page mid-navigation; tried again next tick */ } |
| main.js:466 | empty-catch |  | NOT-WORTH | page mid-navigation; tried again next tick |
| main.js:515 | } catch (e) { /* error: PASSES-ON — a 404 is no lyrics; anyt |  | PASSES-ON | a 404 is no lyrics; anything else goes back as failed (lyrics-sources.js retries, then LRCLIB) |
| main.js:525 | } catch (e) { /* error: PASSES-ON — no MusicKit (page loadin |  | PASSES-ON | no MusicKit (page loading): goes back as failed (lyrics-sources.js retries, then LRCLIB) |
| main.js:547 | } catch (e) { /* error: NOT-WORTH — no queue yet: nothing to |  | NOT-WORTH | no queue yet: nothing to prefetch |
| main.js:590 | lyricsPrefetcher.run(current).catch((e) => console.error('ly |  | LOGGED-OK | best effort; each song's own lookup runs when it plays |
| main.js:612 | } catch (e) { // error: LOGGED-OK — logged once; listening s |  | LOGGED-OK | logged once; listening stays off (listenLoadFailed) |
| main.js:774 | } catch (e) { |  | SHOWN | a failed write (disk full, permissions) is the status line |
| main.js:868 | json-parse | outside a try | NOT-WORTH | parses the JSON.stringify of the line above |
| main.js:881 | empty-catch |  | NOT-WORTH | a store read that throws: logged as no cached notes |
| main.js:963 | json-parse | outside a try | NOT-WORTH | sheetSent is our own JSON.stringify (set on each send below) |
| main.js:986 | empty-catch |  | NOT-WORTH | a store read that throws: no old entry, nothing to count or keep |
| main.js:993 | try { getSheetStore().set(s.title, s.artist, entry) } catch  |  | SHOWN | a failed write: the band says the notes couldn't be kept (and the log) |
| main.js:1014 | empty-catch |  | NOT-WORTH | the marker only limits the retries; without it the song is simply tried again |
| main.js:1018 | empty-catch |  | NOT-WORTH | a store read that throws: no cached notes, the band's message below says the pass failed |
| main.js:1161 | const exists = (f) => { try { fs.accessSync(f, fs.constants. |  | NOT-WORTH | a missing file is "not shipped here": the switch says so |
| main.js:1180 | execFile('pactl', args, { timeout: 2000, maxBuffer: 4 * 1024 |  | NOT-WORTH | pactl missing or failing: no stream found (nothing is routed; tried again on the next event) |
| main.js:1186 | try { pids = audioListen.ownProcessTree(process.pid) } catch |  | NOT-WORTH | no process tree: only our own pid |
| main.js:1214 | appleWC().executeJavaScript(code).catch((e) => console.error |  | LOGGED-OK | page mid-load: the player stays as it is; the user's play button works |
| main.js:1218 | appleWC().executeJavaScript(lookaheadPage.holdScript(on)).ca |  | LOGGED-OK | page mid-load: no hold at the next item change (its old song's tail is cut instead) |
| main.js:1234 | .catch((e) => console.error('look-ahead: page script failed: |  | LOGGED-OK | page mid-load: injected again at its next load; without it songs play with no delay |
| main.js:1236 | .catch((e) => console.error('look-ahead: page events failed: |  | LOGGED-OK | as above |
| main.js:1250 | floating | askAlignStatus() | NOT-WORTH | askAlignStatus catches inside (the helper's error is Settings' status line) |
| main.js:1304 | } catch (e) { return } |  | NOT-WORTH | a failing executeJavaScript returns early until the next tick; at 2/s that can't hammer |
| main.js:1422 | floating | stageTick() | NOT-WORTH | — tick() never rejects (a failed stat is logged inside) |
| main.js:1423 | floating | .then without .catch | NOT-WORTH | tick() never rejects (a failed stat is logged inside) |
| main.js:1423 | then-reject |  | NOT-WORTH | tick() never rejects (a failed stat is logged inside) |
| main.js:1435 | floating | refreshPalette() | NOT-WORTH | refreshPalette catches its artwork fetch inside; the rest is sync |
| main.js:1460 | floating | loadFile() | NOT-WORTH | packaged lyrics.html; rejects only if the window closes mid-load (a warning) |
| main.js:1580 | } catch (e) { /* error: NOT-WORTH — no MusicKit or no queue  |  | NOT-WORTH | no MusicKit or no queue yet (page loading): { ok: false }, read again on the next tick |
| main.js:1594 | floating | stageSongRead() | NOT-WORTH | stageSongRead catches its one async read (songSource.state); the rest is sync |
| main.js:1601 | try { q = await appleWC().executeJavaScript(stageQueueScript |  | NOT-WORTH | page mid-navigation: read again on the next tick |
| main.js:1618 | } catch (e) { /* error: PASSES-ON — false to main, which rea |  | PASSES-ON | false to main, which reads the queue again |
| main.js:1646 | .catch((e) => console.error('stage ' + what + ' failed:', e. |  | LOGGED-OK | page mid-load: that one command does nothing (the stage shows the player's real state on the next tick) |
| main.js:1681 | .catch((e) => console.error('stage liner notes failed:', e.m |  | LOGGED-OK | the booklet didn't open; the next click tries again |
| main.js:1689 | .catch((e) => console.error('stage play failed:', e.message) |  | LOGGED-OK | page mid-load: nothing plays; the list shows the player's real state on the next read |
| main.js:1692 | try { return JSON.parse(stageSent \|\| '{}') } catch (e) { ret |  | NOT-WORTH | our own JSON; {} when nothing was sent yet |
| main.js:1712 | floating | stageSongRead() | NOT-WORTH | stageSongRead catches its one async read (songSource.state); the rest is sync |
| main.js:1731 | floating | stageSongRead() | NOT-WORTH | stageSongRead catches its one async read (songSource.state); the rest is sync |
| main.js:1749 | try { st = await songSource.state() } catch (e) { st = { ok: |  | SHOWN | the row shows nothing known (its buttons say why when clicked) |
| main.js:1780 | .catch((e) => console.error('studio credits: album lookup fa |  | LOGGED-OK | the back shows Apple's credits; the booklet asks again when opened |
| main.js:1789 | .catch((e) => { console.error('studio open ' + kind + ' fail |  | SHOWN | the Studio's note says it couldn't be opened |
| main.js:1797 | ? list.map((p) => ({ label: p.name, click: () => songSource. |  | SHOWN | the Studio's note says it didn't go through |
| main.js:1800 | }).catch((e) => { console.error('playlists failed:', e.messa |  | SHOWN | the Studio's note says the playlists didn't load |
| main.js:1822 | .catch((e) => console.error('stage liner notes failed:', e.m |  | LOGGED-OK | the booklet didn't open; the next click tries again |
| main.js:1869 | } catch (e) { /* error: PASSES-ON — offline or Apple refused |  | PASSES-ON | offline or Apple refused: main uses the IDs it saved for this song, or says offline |
| main.js:1900 | .catch((e) => {   // error: SHOWN — the tile says Wikimedia  |  | SHOWN | the tile says Wikimedia Commons didn't answer (click to try again); logged |
| main.js:1912 | try { r = await appleWC().executeJavaScript(montageIdsScript |  | NOT-WORTH | page mid-navigation: treated as no answer (saved IDs below) |
| main.js:1930 | } catch (e) { |  | SHOWN | — offline or the service busy: the saved set if there is one (the tile says "saved"), else the tile says offline / not loaded |
| main.js:1953 | } catch (e) {   // error: NOT-WORTH — one photo failed (gone |  | NOT-WORTH | one photo failed (gone, busy): the montage shows the others; offline from here on |
| main.js:1981 | .catch((e) => console.error('show album failed:', e.message) |  | LOGGED-OK | page mid-load: the window is shown, the album isn't opened |
| main.js:1999 | .catch((e) => console.error('lyrics seek failed:', e.message |  | LOGGED-OK | page mid-load: that seek is lost (the next click works) |
| main.js:2016 | } catch (e) { /* error: NOT-WORTH — no MusicKit yet (page lo |  | NOT-WORTH | no MusicKit yet (page loading): no cover to show, the menu item does nothing that time |
| main.js:2024 | } catch (e) { console.error('cover lookup failed:', e.messag |  | LOGGED-OK | page mid-load: no lightbox this time |
| main.js:2057 | floating | loadFile() | NOT-WORTH | packaged cover.html; rejects only if the lightbox closes (blur) mid-load |
| main.js:2106 | const mk = (() => { try { return MusicKit.getInstance(); } c |  | NOT-WORTH | no MusicKit yet (page loading): reported below as not ready |
| main.js:2153 | } catch (e) { /* error: PASSES-ON — offline or Apple refused |  | PASSES-ON | offline or Apple refused: main opens the cached booklet, or its page saying Apple didn't load |
| main.js:2229 | } catch (e) { |  | LOGGED-OK | — offline or the archive refused: the disc shows as before (still), asked again next time |
| main.js:2250 | try { state = await appleWC().executeJavaScript(nowPlayingSc |  | NOT-WORTH | page mid-load: the next tick asks again |
| main.js:2291 | try { res = mainAlive() ? await appleWC().executeJavaScript( |  | LOGGED-OK | page mid-load: handled below as "Apple didn't answer" |
| main.js:2332 | floating | loadFile() | NOT-WORTH | packaged liner-notes.html; rejects only if the booklet closes mid-load |
| main.js:2365 | .catch((e) => console.error('liner notes: now playing failed |  | LOGGED-OK | page mid-load: the next poll tells the booklet |
| main.js:2385 | floating | loadFile() | NOT-WORTH | packaged visualizer.html; rejects only if the visualizer closes mid-load |
| main.js:2475 | } catch (e) { /* error: NOT-WORTH — not rated (or no answer) |  | NOT-WORTH | not rated (or no answer): shown as not a favourite |
| main.js:2477 | } catch (e) { /* error: NOT-WORTH — no song or MusicKit: the |  | NOT-WORTH | no song or MusicKit: the menu opens without the song items |
| main.js:2500 | .catch((e) => {   // error: SHOWN — every song action's fail |  | SHOWN | every song action's failure is told where it was asked (done: the Studio's note, the mini player's notice) |
| main.js:2540 | .catch((e) => { console.error('play next failed:', e.message |  | SHOWN | the Studio's note says Play Next didn't go through |
| main.js:2575 | } catch (e) { /* error: NOT-WORTH — no answer: shown as not  |  | NOT-WORTH | no answer: shown as not a favourite (star off) |
| main.js:2594 | } catch (e) { /* error: NOT-WORTH — not rated (or no answer) |  | NOT-WORTH | not rated (or no answer): treated as not a favourite |
| main.js:2605 | } catch (e) { /* error: NOT-WORTH — failed: { ok: false }, t |  | NOT-WORTH | failed: { ok: false }, the star stays as it was |
| main.js:2615 | } catch (e) { info = null }   // error: NOT-WORTH — page mid |  | NOT-WORTH | page mid-navigation: the menu opens without the song's items |
| main.js:2660 | } catch (e) { return }   // error: NOT-WORTH — tmp not writa |  | NOT-WORTH | tmp not writable: setAlwaysOnTop stays the only keep-above |
| main.js:2715 | try { text = fs.readFileSync(rulesFile, 'utf8') } catch (e)  |  | NOT-WORTH | no kwinrulesrc: nothing to clean |
| main.js:2735 | empty-catch |  | NOT-WORTH | kwinrulesrc not writable: the old rules stay (one-time cleanup) |
| main.js:2791 | empty-catch |  | NOT-WORTH | artwork unreachable: the previous palette stays |
| main.js:2834 | floating | showMoreMenu() | NOT-WORTH | showMoreMenu catches its page read; building the menu is sync |
| main.js:2854 | .catch((e) => console.error('toggle favorite failed:', e.mes |  | LOGGED-OK | the star stays as it was, so the user sees nothing changed |
| main.js:2861 | .catch((e) => console.error('seek failed:', e.message)) // e |  | LOGGED-OK | page mid-load: that seek is lost |
| main.js:2868 | .catch((e) => console.error('set volume failed:', e.message) |  | LOGGED-OK | page mid-load: the volume stays |
| main.js:2888 | empty-catch |  | NOT-WORTH | no art: the notification shows without it |
| main.js:2911 | } catch (e) { // error: NOT-WORTH — page mid-load: skipped t |  | NOT-WORTH | page mid-load: skipped to the next tick |
| main.js:2922 | floating | refreshPalette() | NOT-WORTH | refreshPalette catches its artwork fetch inside |
| main.js:2927 | floating | feedDiscord() | NOT-WORTH | feedDiscord catches its connect; setActivity/clearActivity are sync writes |
| main.js:2933 | floating | notifyTrack() | NOT-WORTH | notifyTrack catches its art fetch; the Notification is sync |
| main.js:2950 | .catch((e) => console.error('last.fm now playing failed:', e |  | LOGGED-OK | "now playing" is cosmetic; the scrobble is sent separately |
| main.js:2978 | } catch (e) { // error: NOT-WORTH — Discord not running: tri |  | NOT-WORTH | Discord not running: tried again in 30 s; the rail shows "waiting" |
| main.js:3019 | empty-catch |  | NOT-WORTH | no discord.json yet (or unreadable): defaults; Connect writes a new one |
| main.js:3052 | } catch (e) { |  | SHOWN | — an error notice in Integrations with the reason |
| main.js:3092 | } catch (e) { |  | SHOWN | — an error notice in Integrations with the reason |
| main.js:3103 | } catch (e) { |  | SHOWN | — an error notice in Integrations with the reason |
| main.js:3146 | floating | finishLastFm() | NOT-WORTH | finishLastFm catches inside (SHOWN: the Integrations notice) |
| main.js:3151 | floating | .then without .catch | NOT-WORTH | quitGuard.allow never rejects (a dialog failure is caught in quit-guard.js) |
| main.js:3203 | floating | checkForUpdates() | NOT-WORTH | updater.check catches inside (SHOWN in Settings → Updates) |
| main.js:3205 | floating | checkEngineFeed() | NOT-WORTH | checkEngineFeed catches its feed fetch (LOGGED-OK); the rest is sync |
| main.js:3224 | floating | askAlignStatus() | NOT-WORTH | askAlignStatus catches inside (Settings' status line) |
| main.js:3277 | } catch (e) { // error: SHOWN — "Helper not working: …" in S |  | SHOWN | "Helper not working: …" in Settings → Precise timing |
| main.js:3331 | } catch (e) { console.log('helper: the job marker: ' + e.mes |  | LOGGED-OK | the marker can't be written (read-only config): the job runs, only a resume after a crash is lost |
| main.js:3337 | empty-catch |  | NOT-WORTH | no marker there: nothing to clear |
| main.js:3366 | const has = (dir) => { try { return fs.readdirSync(dir).some |  | NOT-WORTH | no folder: nothing there |
| main.js:3368 | try { names = fs.readdirSync(home) } catch (e) { names = []  |  | NOT-WORTH | no folder: nothing to remove |
| main.js:3371 | try { stamp = fs.readFileSync(path.join(home, 'venv', '.sona |  | NOT-WORTH | no venv: no build |
| main.js:3388 | } catch (e) { console.log('helper: lspci: ' + e.message) } |  | LOGGED-OK | no lspci (or it fails, or execFile throws: a dead mount on PATH): the sysfs ids stay as the names |
| main.js:3409 | try { list = await fs.promises.readdir(dir, { withFileTypes: |  | NOT-WORTH | a file that vanishes while counting counts 0 |
| main.js:3414 | empty-catch |  | NOT-WORTH | a file gone meanwhile counts 0 |
| main.js:3469 | } catch (e) { console.log('helper models: ' + e.message + '; |  | LOGGED-OK | the helper's own download below (from the start) |
| main.js:3523 | floating | askAlignStatus() | NOT-WORTH | askAlignStatus catches inside (Settings' status line) |
| main.js:3566 | try { text = fs.readFileSync(helperJobFile(), 'utf8') } catc |  | NOT-WORTH | no marker: nothing was interrupted |
| main.js:3582 | floating | remove() | NOT-WORTH | installer remove() never rejects (exec resolves); failures are the job's row |
| main.js:3605 | } catch (e) {   // error: LOGGED-OK — no feed, a network err |  | LOGGED-OK | no feed, a network error or a refused feed: nothing is offered, the installed helper keeps working |
| main.js:3638 | floating | .then without .catch | NOT-WORTH | dirBytes never rejects (unreadable files count 0) |
| main.js:3647 | floating | remove() | NOT-WORTH | installer remove() never rejects (exec resolves); failures are the job's row |
| main.js:3717 | floating | checkForUpdates() | NOT-WORTH | updater.check catches inside (SHOWN in Settings → Updates, opened by the click) |
| main.js:3894 | floating | loadFile() | NOT-WORTH | packaged panel.html; rejects only if the view is closed mid-load |
| main.js:3922 | floating | askAlignStatus() | NOT-WORTH | askAlignStatus and checkEngineFeed both catch inside |
| main.js:3922 | floating | checkEngineFeed() | NOT-WORTH | askAlignStatus and checkEngineFeed both catch inside |
| main.js:3942 | floating | askAlignStatus() | NOT-WORTH | askAlignStatus catches inside (Settings' status line) |
| main.js:3967 | const read = (f) => { try { return fs.readFileSync(path.join |  | NOT-WORTH | a missing file reads as empty: About says so ("nothing listed") |
| main.js:4065 | try { drivers = [...new Set(fs.readFileSync('/proc/' + gpu.p |  | NOT-WORTH | no graphics process or no /proc: the line says software or hardware from the page alone |
| main.js:4068 | .catch((e) => console.error('graphics readout: decoding chec |  | LOGGED-OK | the line keeps saying "checking…"; reopening About → Graphics asks again |
| main.js:4141 | const size = (f) => { try { return fs.statSync(path.join(ud, |  | NOT-WORTH | a file or folder not there yet: null / 0 ("No file yet") |
| main.js:4146 | empty-catch |  | NOT-WORTH | no folder or a file removed meanwhile: counted as nothing |
| main.js:4193 | floating | .then without .catch | SHOWN | the line under the button says whether it was copied (Electron 44+: writeText may return a Promise) |
| main.js:4193 | then-reject |  | SHOWN | the line under the button says whether it was copied (Electron 44+: writeText may return a Promise) |
| main.js:4228 | floating | loadFile() | NOT-WORTH | packaged toast.html; rejects only if the last toast ends mid-load |
| main.js:4262 | .catch((e) => console.error('rail: focus handoff failed:', e |  | LOGGED-OK | a failing injection (page mid-navigation) only leaves the focus in the window; logged |
| main.js:4280 | .catch((e) => console.error('rail: focus stops failed:', e.m |  | LOGGED-OK | page mid-load: no focus stops until the next load (Tab still works in the page) |
| main.js:4288 | .catch((e) => console.error('media controls: position script |  | LOGGED-OK | page mid-load: no length in the media controls until the next load (playback is unaffected) |
| main.js:4318 | .catch((e) => console.error('rail liner notes failed:', e.me |  | LOGGED-OK | the booklet didn't open; the next press tries again |
| main.js:4343 | .catch((e) => console.error('wheel volume failed:', e.messag |  | LOGGED-OK | page mid-load: the wheel does nothing that time |
| main.js:4381 | floating | connectLastFm() | SILENT-BUG | rare: writeTemplate() (sync write) is before the try; unwritable config = no notice |
| main.js:4383 | floating | connectDiscord() | SILENT-BUG | rare: saveDiscordConfig() is before the try; unwritable config = Connect does nothing |
| main.js:4385 | floating | checkForUpdates() | NOT-WORTH | updater.check catches inside (SHOWN in Settings → Updates) |
| main.js:4392 | floating | backToStable() | NOT-WORTH | updater.check / install catch inside (SHOWN in the update notice) |
| main.js:4399 | floating | .then without .catch | NOT-WORTH | quitGuard.allow never rejects (a dialog failure is caught in quit-guard.js) |
| main.js:4502 | floating | loadURL() | SILENT-BUG | offline or Apple down at start: loadURL rejects, Apple's view stays blank, unexplained |
| main.js:4504 | floating | loadFile() | NOT-WORTH | packaged rail.html; rejects only if the window closes mid-load |
| main.js:4610 | floating | .then without .catch | NOT-WORTH | allow() never rejects |
| main.js:4633 | empty-catch |  | NOT-WORTH | unresolvable: the APPIMAGE path as given is used |
| main.js:4653 | empty-catch |  | NOT-WORTH | nothing to remove; the symlink below says if it can't be made |
| main.js:4654 | empty-catch |  | NOT-WORTH | folder not writable: the menu entry points at the versioned file instead |
| main.js:4671 | empty-catch |  | NOT-WORTH | no entry yet: it is written below |
| main.js:4679 | } catch (e) { console.error('menu integration failed:', e.me |  | LOGGED-OK | no menu entry or icon this run; Sonata itself runs |
| main.js:4866 | empty-catch |  | NOT-WORTH | systemd-run unavailable or too old: next try, then the shell below |
| main.js:4872 | } catch (e) { console.error('relaunch: could not start the n |  | LOGGED-OK | the next menu launch starts it |
| main.js:4888 | empty-catch |  | NOT-WORTH | not removable now: tried again next start |
| main.js:4892 | empty-catch |  | NOT-WORTH | not removable now: tried again next start |
| main.js:4895 | empty-catch |  | NOT-WORTH | folder unreadable: nothing pruned |
| main.js:4935 | } catch (e) { console.error('autostart update failed:', e.me |  | LOGGED-OK | the login entry stays as it was (read-only config: rare) |
| main.js:4969 | try { fn() } catch (e) { console.error('startup: ' + name +  |  | LOGGED-OK | startup goes on |
| main.js:4980 | json-parse | outside a try | NOT-WORTH | load() runs inside createScrobbleQueue's try (lastfm.js:170): damaged = none |
| main.js:5065 | }).catch((e) => { |  | LOGGED-OK | — a step outside startupStep threw: said, and the window and tray still come up when they can |
| media-position.js:55 | empty-catch |  | NOT-WORTH | no MusicKit or no song yet: the controls keep what they had until the next event |
| model-fetch.js:43 | const sizeOf = (f) => { try { return fs.statSync(f).size } c |  | NOT-WORTH | no file: -1 |
| model-fetch.js:81 | try { j = JSON.parse(String(out).trim().split('\n').pop()) } |  | PASSES-ON | not JSON: rejected, the caller logs it and lets the helper download |
| model-fetch.js:111 | try { u = new URL(url) } catch (e) { reject(new FetchError(' |  | PASSES-ON | a malformed address rejects; the download fails with it |
| model-fetch.js:159 | try { meta = JSON.parse(fs.readFileSync(metaFile, 'utf8')) \| |  | NOT-WORTH | no meta or unreadable: the part is treated as unknown (Range without If-Range, checked after) |
| model-fetch.js:165 | try { fs.renameSync(helperPart, part); have = sizeOf(part);  |  | NOT-WORTH | the rename fails (gone meanwhile): starts from zero |
| montage-sources.js:69 | } catch (e) { |  | PASSES-ON | — no connection or no answer in time: the caller says offline (the tile) or tries the next photo |
| montage-sources.js:79 | lane.chain = run.catch(() => {}) |  | NOT-WORTH | the lane only orders requests; each caller gets its own failure from `run` |
| montage-sources.js:84 | try { return await res.json() } catch (e) { throw failure('b |  | PASSES-ON | the caller treats the source as failed |
| montage-store.js:38 | try { names = io.readdirSync(dir) } catch (e) { return }   / |  | NOT-WORTH | no folder yet: an empty cache |
| montage-store.js:46 | empty-catch |  | NOT-WORTH | vanished between the listing and the stat: not in the cache |
| montage-store.js:54 | empty-catch |  | NOT-WORTH | already gone |
| montage-store.js:75 | try { io.utimesSync(p, t / 1000, t / 1000) } catch (e) { /*  |  | NOT-WORTH | the file went missing: dropped below |
| montage-store.js:91 | } catch (e) { return null }   // error: NOT-WORTH — disk ful |  | NOT-WORTH | disk full or read-only: null, main skips that photo (the others show) |
| montage-ui.js:123 | floating | .then without .catch | NOT-WORTH | a broken file: the layer stays hidden, the next photo comes in its turn |
| montage-ui.js:123 | then-reject |  | NOT-WORTH | a broken file: the layer stays hidden, the next photo comes in its turn |
| notes-log.js:141 | try { names = io.readdirSync(dir) } catch (e) { return [] } |  | NOT-WORTH | no folder yet: nothing logged |
| notes-log.js:147 | empty-catch |  | NOT-WORTH | a file removed meanwhile is skipped |
| notes-log.js:158 | try { names = io.readdirSync(dir) } catch (e) { return remov |  | NOT-WORTH | no folder: nothing to prune |
| notes-log.js:163 | empty-catch |  | NOT-WORTH | an unremovable temp file is tried again next write |
| notes-log.js:171 | empty-catch |  | NOT-WORTH | a file removed meanwhile is already gone |
| notes-log.js:228 | .catch((e) => {   // error: SHOWN — the status line says why |  | SHOWN | the status line says why (see above) |
| portal-shortcuts.js:29 | } catch (e) { return 0 } |  | NOT-WORTH | no portal, no interface, no answer: all mean "not available" (0) |
| portal-shortcuts.js:55 | .catch((err) => done(reject, err))   // error: PASSES-ON — t |  | PASSES-ON | the caller's promise rejects |
| portal-shortcuts.js:80 | } catch (e) { log('portal: app id not registered (' + e.mess |  | LOGGED-OK | an older portal without the host registry, or an app id it doesn't know: the desktop names us from the connection instead |
| portal-shortcuts.js:124 | } catch (e) { log('portal: ConfigureShortcuts failed (' + e. |  | LOGGED-OK | a desktop that lists version 2 without the editor: false, the panel says where to change them |
| quit-guard.js:23 | pending = Promise.resolve().then(() => o.ask(words)).catch(( |  | PASSES-ON | a dialog that fails to show counts as Keep installing (nothing is lost) |
| settings-store.js:91 | json-parse | outside a try | NOT-WORTH | our own SCHEMA defaults stringified on the same line, can't fail |
| settings-store.js:119 | try { text = fs.readFileSync(file, 'utf8') } catch (e) { |  | NOT-WORTH | — no file yet (first start): the defaults |
| settings-store.js:124 | try { parsed = JSON.parse(text) } catch (e) { parsed = undef |  | NOT-WORTH | no file yet (first start): the defaults |
| settings-store.js:140 | } catch (e) { aside = '' }   // error: SHOWN — the notice sa |  | SHOWN | the notice says no copy could be kept |
| settings-store.js:141 | empty-catch |  | NOT-WORTH | the next change saves again |
| sheet-notes-store.js:46 | try { text = io.readFileSync(f, 'utf8') } catch (e) { return |  | NOT-WORTH | no file: no notes for this song yet |
| sheet-notes-store.js:49 | try { entry = JSON.parse(text) } catch (e) { return null } |  | NOT-WORTH | a damaged file is a cache miss; the next notes step writes it again |
| sheet-notes-store.js:52 | empty-catch |  | NOT-WORTH | the time only orders the pruning |
| shortcuts.js:51 | } catch (e) { |  | LOGGED-OK | — no bus: "no portal", the section says so |
| shortcuts.js:69 | empty-catch |  | NOT-WORTH | a key that was never registered |
| shortcuts.js:80 | try { ok = d.globalShortcut.register(keys[a.id], () => fire( |  | SHOWN | a key the X server won't give (another app holds it): that row says "Taken by another app" |
| shortcuts.js:114 | } catch (e) { |  | SHOWN | — no portal or no session: the section's message; Ask again retries |
| shortcuts.js:146 | floating | portalOn() | NOT-WORTH | portalOn() catches inside (its try covers the whole session start) |
| shortcuts.js:165 | floating | .then without .catch | NOT-WORTH | probe() never rejects |
| shortcuts.js:175 | floating | portalOn() | NOT-WORTH | portalOn() catches inside |
| shortcuts.js:188 | empty-catch |  | NOT-WORTH | an Electron without setSuspended: grabs stay, a held key can't be picked again |
| shortcuts.js:205 | floating | portalOn() | NOT-WORTH | portalOn() catches inside |
| song-actions.js:48 | } catch (e) { /* error: LOGGED-OK — not rated (Apple answers |  | LOGGED-OK | not rated (Apple answers 404) or no answer: shown as not a favourite; what failed is logged by main (out.read) |
| song-actions.js:62 | } catch (e) { /* error: NOT-WORTH — no answer: the library s |  | NOT-WORTH | no answer: the library state stays unknown (Add to Library stays offered), no artist link |
| song-actions.js:65 | } catch (e) { /* error: PASSES-ON — no MusicKit yet (page lo |  | PASSES-ON | no MusicKit yet (page loading): { ok: false }, the Studio says nothing is known |
| song-actions.js:140 | } catch (e) { /* error: PASSES-ON — no answer: false, the ca |  | PASSES-ON | no answer: false, the caller says the artist couldn't be opened |
| song-actions.js:157 | } catch (e) { /* error: PASSES-ON — no song or no MusicKit:  |  | PASSES-ON | no song or no MusicKit: false, the caller says so |
| update-feed.js:54 | } catch (e) { |  | NOT-WORTH | — a key that can't be read verifies nothing: the update is refused as unsigned, which the log/dialog says |
| update-feed.js:104 | try { f = JSON.parse(text) } catch (e) { throw new Error('up |  | PASSES-ON | thrown as the refusal the Updates section shows |
| update-feed.js:131 | try { u = new URL(raw) } catch (e) { return null }   // erro |  | NOT-WORTH | not a URL: no test feed |
| updater.js:142 | } catch (e) { |  | SHOWN | — the Updates status line always; a notice when the user asked (Check now, Back to stable) |
| updater.js:174 | } catch (e) { |  | PASSES-ON | — the unverified file is deleted; the catch below shows the reason |
| updater.js:184 | } catch (e) { |  | SHOWN | — the update notice says it didn't install and why; the current version is untouched |
| version-display.js:37 | empty-catch |  | NOT-WORTH | a page without package.json uses the version main sends it |
| visualizer.html:211 | floating | .then without .catch | NOT-WORTH | a cover that fails to decode is shown anyway (the old background-image path did the same) |
| visualizer.html:211 | floating | .then without .catch | NOT-WORTH | a cover that fails to decode is shown anyway (the old background-image path did the same) |
| visualizer.html:267 | empty-catch |  | NOT-WORTH | storage unavailable (a private profile): the first scene is shown |
| visualizer.html:279 | empty-catch |  | NOT-WORTH | storage unavailable: the scene isn't remembered for next time |
| visualizer.js:67 | empty-catch |  | NOT-WORTH | no pactl or no default sink: parec's @DEFAULT_MONITOR@ alias is tried instead |
| visualizer.js:135 | } catch (e) { |  | SHOWN | spawn throwing (e.g. a dead PATH entry) is logged and handled as a capture that ended: |
