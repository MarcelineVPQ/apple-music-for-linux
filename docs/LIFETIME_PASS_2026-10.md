# Lifetime pass: every acquisition, with its release point

_2026-10-19, Sonata QC phase part A, on branch `qc-passes` (origin/dev 0.15.69-dev.1, bd85dea). The DS5 configurator's pass pattern (its CLAUDE.md "Loop / Lifetime / Error / Cache pass"): a script lists every candidate, each one carries a verdict comment in the code, nothing is sampled by eye. No behaviour changed in this branch: only verdict comments, the lister and the gate. Marcy picks the fix batches (BACKLOG row "QC passes 2026-10: fix batches")._

## How the list was made

Two listers, both in `npm run gates`, `.hooks/pre-commit`, `npm test` and CI:

- `tools/verdicts.js` (since 0.15.37): line patterns over every shipped file (`build.files` `.js`, the pages' inline `<script>`s and the page scripts main.js sends into Apple's page as text). It gates every `for` / `while` / `do` / `.forEach`, every acquisition (timers, rAF, listeners, observers, child processes, windows/views/trays, sockets, streams, watchers, audio contexts, and now Web Animations `el.animate`, object URLs, power-save blockers and global shortcuts) and every `try/catch` / `.catch`.
- `tools/passes.js` (new, acorn 8.15.0 as an exact devDependency): parses every shipped file and lists what a line pattern can't see. Hot paths are resolved by function name across the shipped files from their roots (rAF / setInterval / re-arming setTimeout callbacks, high-rate events: parec `'data'`, `timeupdate`, pointer/mouse move, scroll, wheel, resize, `message`; functions named tick/frame/draw/paint/render/step/animate); a name resolves to the caller's own file first, else to its one definition. Gated: hot / awaiting / nested array callbacks; floating promises, `.then(ok, onRejected)`, `void` calls, `JSON.parse` outside a try; and every kept-state row (`// cache: VERDICT — key=…; invalidated=…; bound=…`). Doc-only rows: empty catches (they carry the verdicts.js verdict), clock comparisons (ttl), sync reads in loops (repeat-io), sync reads reached from a timer (poll-io), and the acquisition context. The page scripts inside main.js's template strings are text to acorn; verdicts.js covers them.

The verdicts were given by reading each row's code and callers (how often it really runs), in seven file groups. Name-resolved "hot" is an over-approximation by design: most rows reached from the 500 ms lyrics poll (main.js lyricsTick, `setInterval` every 500 ms) run once per track change, behind `if (key !== lyricsKey || retryDue)`, and their verdicts say so.

The long-run memory growth seen on the laptop was the focus: helper jobs, per-song caches, Expressive DOM and animations, listeners per song. What holds (read, with callers): align-helper's `pending` jobs (each removed by done/fail/timeout/exit, ≤ ~3 in flight), `stderrTail` (20 lines), the song audio buffer (cleared by every wrapUp path, ≤ ~79 MB for a 15-minute song while it records), the job queue (pruned to the songs on screen), Expressive stretch/ghost animations and ghost nodes (cancelled and removed in `endExpression`, `setData` ends them all), countdown dots (cancelled in `closeDots`), per-window listeners (they go with their window), the HDR texture (destroyed per draw), `firstPlay` / `exprSong` (one song), the capped per-song collections in main (lyricsTries 200, stageCreditsAsked 500, montageCache 1500 entries / 4 MB, scrobble queue 500). Nothing found grows by megabytes per song; the candidates below are what does grow or linger.

## Fix candidates (by impact)

| # | Where | What | Impact | Verdict |
|---|---|---|---|---|
| T1 | `listen-session.js:110` `allOnsets` | Cleared only by `setLyrics` on a new track key; repeat-one, replaying the same song and seeking back keep appending (seek-back adds duplicates that also skew `noiseRate`) | ~0.5 MB/h (up to ~1.8 MB/h at the 12.5 onsets/s ceiling) with the lyrics window open, Refine on and line-timed lyrics; also wasted (`song.done` blocks later refinement) | **LEAK** (corrected from OK) |
| T2 | `hdr-glow.js:151` | See LOOP_PASS L1 | GC churn per sung word with HDR on | **HOT-ALLOC** |
| T3 | `main.js` `pushPanel` | See LOOP_PASS L2 | every 5 s while hidden | WASTE (doc) |
| T4 | `align-session.js` `noting` (CACHE_PASS FIX-STALE row) | a dropped / paused / failed whole-song notes job never clears its key | one short string per affected song; the visible part is the stuck "measuring" note | FIX-STALE |
| T5 | `main.js:1146` look-ahead | `lookahead.stop()` runs on a window-close quit only; tray Quit, `restartIntoUpdate`, `restartApp`, `before-quit` skip it | the helper ends by PR_SET_PDEATHSIG and `pactl subscribe` at its next write; Sonata's stream is not moved back explicitly (the session manager relinks it) | OK (comment corrected) |
| T6 | `audio-listen.js` watchdog stream switch | the old parec leaves `liveProcs` before its SIGTERM, with no SIGKILL fallback (unlike `stop()`) | a parec that ignores SIGTERM outlives the app; unlikely | doc |
| T7 | `lyrics-view.js` `setData` (:657) | a countdown showing at a song change isn't cancelled (`closeDots`) | 4 Web Animations on detached nodes until the interlude's length passes; not a real leak | doc |
| T8 | `align-session.js` wrapUp | `forget` is left to the queued final job; a dropped final job never sends it | harmless: the helper's SongCache holds one song (docs/LEVEL2-ALIGN.md) | doc |

## Fixed on branch qc-fixes (2026-10-19, Marcy approved the four batches)

| # | What | Commit |
|---|---|---|
| T1 | listen-session `allOnsets`: each song time counted once (heardSpans) | e36f693 |
| T2 | hdr-glow (as LOOP L1) | d0f8624 |
| T3 | pushPanel (as LOOP L2) | 3c516cf |

## Counts

| Verdict | Rows |
|---|---|
| NOT-WORTH | 11 |
| OK | 425 |
| loop:HOT-PATH-OK | 9 |
| loop:NOT-WORTH | 45 |
| loop:SERIAL-REQUIRED | 3 |
| **total** | 493 |

## Flagged rows (fix candidates, as the comments say)

None.

## Every row

| file:line | what | trigger / context | verdict | reason |
|---|---|---|---|---|
| align-helper.js:246 | process.on('exit', () => { for (const p of live) { try { p.k | module | loop:NOT-WORTH | at most one live helper |
| align-helper.js:448 | c.stdout.on('data', lineParser((m) => onMessage(m, c), (line | ensure [hot] | OK | one helper child · ends on quit (idle), stop(), a timeout kill, its own crash, or process exit (live) |
| align-helper.js:453 | c.stderr.on('data', (s) => { | ensure [hot] | loop:HOT-PATH-OK | the lines of one stderr chunk (a few), kept to the last 20 |
| align-helper.js:458 | c.stdin.on('error', () => {})   // lifetime: OK — dies with  | ensure [hot] | OK | dies with the child |
| align-helper.js:461 | c.on('error', (e) => { log('helper failed to start: ' + e.me | ensure [hot] | OK | 'error' and 'exit' listeners die with the child |
| align-helper.js:462 | c.on('exit', (code, signal) => gone(c, c !== quitting && cod | ensure [hot] | OK | 'error' and 'exit' listeners die with the child |
| align-helper.js:520 | c.stdin.once('drain', off) | (anonymous) | OK | the drain/exit listeners remove each other (off), one pair at a time |
| align-helper.js:521 | c.once('exit', off) | (anonymous) | OK | the drain/exit listeners remove each other (off), one pair at a time |
| apple-focus.js:24 | e.addEventListener('focus', (ev) => { if (ev.isTrusted) brid | stop | OK | one focus listener per stop, released with the document |
| apple-focus.js:33 | doc.addEventListener('focusin', (e) => { | (anonymous) | OK | one capturing focusin listener on Apple's document, released with it · one assignment per focus change |
| apple-focus.js:60 | const observer = new MutationObserver(place) | (anonymous) | OK | ONE MutationObserver, childList of <body> only (no subtree) · fires when Apple adds or |
| apple-focus.js:87 | if (W) doc.addEventListener('pointerover', (e) => { | (anonymous) | OK | one capturing, passive pointerover listener on Apple's document (released with it) · per element boundary |
| apple-focus.js:96 | el.addEventListener('wheel', onVolumeWheel, { passive: false | (anonymous) | OK | one wheel listener per volume control element, released with it (not passive: it stops the scroll) |
| audio-listen.js:149 | process.on('exit', () => { for (const p of liveProcs) { try  | module | loop:NOT-WORTH | at most one or two live parecs |
| audio-listen.js:234 | child.stdout.on('data', (chunk) => { | run [hot] | OK | one parec child per run · ends on stop() (SIGTERM), on stream removal (parec exits |
| audio-listen.js:248 | child.on('error', (e) => log('parec error: ' + e.message)) | run [hot] | OK | 'error'/'exit' listeners (and 'data' above) die with the child |
| audio-listen.js:249 | child.on('exit', () => { | run [hot] | OK | 'error'/'exit' listeners (and 'data' above) die with the child |
| cover.html:76 | ipcRenderer.on('theme', (event, t) => theme.set(t)) | module | OK | the ipcRenderer.on listeners ('theme', 'cover') and the click / keydown |
| cover.html:80 | ipcRenderer.on('cover', (event, c) => { | module | OK | the ipcRenderer.on listeners ('theme', 'cover') and the click / keydown |
| cover.html:95 | document.addEventListener('click', close) | module | OK | the click and keydown listeners, added once at load, die with the window |
| cover.html:96 | document.addEventListener('keydown', (e) => { | module | OK | the click and keydown listeners, added once at load, die with the window |
| curious-sampler.js:89 | deps.execFile(cmd, args, { timeout: 3000, encoding: 'utf8',  | (anonymous) | OK | one short child, ended by its 3 s timeout at the latest |
| dbus-wire.js:306 | const sock = o.net.createConnection({ path }) | (anonymous) | OK | the socket lives until close() or the bus ends it; 'close' tells the owner |
| dbus-wire.js:317 | const timer = setTimeout(() => fail(new Error('session bus:  | (anonymous) | OK | cleared on success or failure |
| dbus-wire.js:319 | sock.on('error', (err) => { clearTimeout(timer); if (conn) c | (anonymous) | OK | the socket's listeners go with the socket |
| dbus-wire.js:320 | sock.on('close', () => { clearTimeout(timer); if (conn) conn | (anonymous) | OK | the socket's listeners go with the socket |
| dbus-wire.js:321 | sock.on('connect', () => sock.write(Buffer.concat([Buffer.fr | (anonymous) | OK | the socket's listeners go with the socket |
| dbus-wire.js:322 | sock.on('data', (chunk) => { | (anonymous) | OK | the socket's listeners go with the socket |
| dbus-wire.js:378 | const timer = setTimeout(() => { this.pending.delete(serial) | (anonymous) | OK | cleared by the reply, or fires once and rejects |
| discord.js:55 | const socket = net.createConnection(candidates[i]) | tryNext | NOT-WORTH | one probe socket per candidate path; a failed probe errors and is destroyed |
| discord.js:56 | socket.on('connect', () => { | tryNext | NOT-WORTH | one probe socket per candidate path; a failed probe errors and is destroyed |
| discord.js:59 | socket.on('data', (chunk) => this.onData(chunk)) | (anonymous) | OK | data/close/error listeners on the connected socket, gone with it (close() destroys it) |
| discord.js:60 | socket.on('close', () => { this.ready = false; this.socket = | (anonymous) | OK | data/close/error listeners on the connected socket, gone with it (close() destroys it) |
| discord.js:61 | socket.on('error', () => { this.ready = false; this.socket = | (anonymous) | OK | data/close/error listeners on the connected socket, gone with it (close() destroys it) |
| discord.js:65 | socket.on('error', () => tryNext(i + 1))   // lifetime: NOT- | tryNext | NOT-WORTH | see above (the probe's listener) |
| game-guard.js:99 | deps.execFile(cmd, args, { timeout: 3000, encoding: 'utf8' } | (anonymous) | OK | one short child per probe; killed by the 3 s timeout, ends with its answer |
| gfx-runtime.js:99 | execFile('kscreen-doctor', ['-o'], { timeout: 5000 }, (err,  | readScreens | OK | kscreen-doctor exits by itself; the 5 s timeout kills a hung one |
| gfx-runtime.js:131 | app.on('child-process-gone', (event, details) => { | ready | NOT-WORTH | registered once, for the app's life |
| gfx-runtime.js:153 | healthTimer = setTimeout(() => { | painted | OK | one shot, cleared at quit (stop) |
| gfx-runtime.js:235 | sampleTimer = setInterval(take, SAMPLE_MS) | readout | OK | cleared when About → Graphics closes (above) and at quit (stop) |
| hdr-glow.js:254 | win.addEventListener('pagehide', stop) | createHdrGlow | OK | one pagehide listener per window: the GPU device goes with the page |
| helper-installer.js:70 | function exec(args, onEvent) { |  | OK | the one installer child (`child` while it runs); its listeners go with it at 'close' |
| helper-installer.js:82 | stream.on('data', (chunk) => { | feed [hot] | loop:HOT-PATH-OK | the lines of one output chunk (a few; pip's raw progress ~4 a second) · ends with the child |
| helper-installer.js:98 | c.on('error', (e) => { onEvent({ ev: 'fail', code: 'spawn',  | (anonymous) | OK | 'error' and 'close' die with the child |
| helper-installer.js:99 | c.on('close', (code, signal) => { if (child === c) child = n | (anonymous) | OK | 'error' and 'close' die with the child |
| helper-installer.js:132 | const res = await exec(args.concat(['--licence-only']), (ev) | start | OK | the licence fetch: one installer run, ends by itself or on cancel |
| helper-installer.js:156 | const res = await exec(run.args.concat(['--licence-sha', lic | install [hot] | OK | the install: one installer run, ends by itself or on cancel (its group is stopped) |
| helper-installer.js:233 | const res = await exec(['--remove'].concat(deleteModels ? [' | remove [hot] | OK | the removal: one quick installer run |
| info-tip.js:32 | button.onmouseenter = () => show(true) |  | OK | the ⓘ's listeners, released with its parent |
| info-tip.js:33 | button.onmouseleave = () => { if (doc.activeElement !== butt |  | OK | the ⓘ's listeners, released with its parent |
| info-tip.js:34 | button.onfocus = () => show(true) |  | OK | the ⓘ's listeners, released with its parent |
| info-tip.js:35 | button.onblur = () => show(false) |  | OK | the ⓘ's listeners, released with its parent |
| info-tip.js:36 | button.onclick = (e) => { e.stopPropagation(); show(tip.hidd |  | OK | the ⓘ's listeners, released with its parent |
| info-tip.js:37 | button.onkeydown = (e) => { if (e.key === 'Escape' && !tip.h |  | OK | the ⓘ's listeners, released with its parent |
| liner-notes-sources.js:58 | const sleep = deps.sleep \|\| ((ms) => new Promise((r) => setT | (anonymous) | OK | one-shot per wait |
| liner-notes.html:261 | ipcRenderer.on('theme', (event, t) => theme.set(t)) | module | OK | the ipcRenderer.on listeners, the keydown / click / resize listeners and the |
| liner-notes.html:299 | document.addEventListener('click', (e) => { | module | OK | one delegated click listener for the whole page |
| liner-notes.html:640 | function say(t) { $('say').textContent = ''; requestAnimatio | say | OK | one frame, then done |
| liner-notes.html:668 | const anim = fade.animate([{ opacity: 0 }, { opacity: 1 }],  |  | OK | 220 ms, goes with its node |
| liner-notes.html:669 | anim.onfinish = () => { fade.remove(); done() }   // lifetim |  | OK | once per turn |
| liner-notes.html:683 | const anim = leaf.animate(fwd ? [{ transform: 'rotateY(0deg) |  | OK | the 700 ms turn and its shade (fill 'forwards'): both go with leaf.remove() in onfinish; once per turn |
| liner-notes.html:684 | shade.animate([{ opacity: 0 }, { opacity: 0.45 }], { duratio |  | OK | the 700 ms turn and its shade (fill 'forwards'): both go with leaf.remove() in onfinish; once per turn |
| liner-notes.html:685 | anim.onfinish = () => { leaf.remove(); done() }   // lifetim |  | OK | once per turn |
| liner-notes.html:706 | spreadEl.addEventListener('mousedown', (e) => { downAt = [e. | module | OK | two listeners on the spread for the page's life |
| liner-notes.html:707 | spreadEl.addEventListener('click', (e) => { | module | OK | two listeners on the spread for the page's life |
| liner-notes.html:719 | $('close').addEventListener('click', () => send('close'))    | module | OK | once at load |
| liner-notes.html:721 | document.addEventListener('keydown', (e) => { | module | OK | one keydown listener for the page |
| liner-notes.html:742 | b.addEventListener('click', () => goSection(p.section))   // | buildNav | OK | rebuilt with the nav (old buttons and listeners are dropped) |
| liner-notes.html:775 | ipcRenderer.on('liner-data', (event, d) => { | module | OK | added once at load, dies with the window |
| liner-notes.html:792 | ipcRenderer.on('liner-playing', (event, p) => { playing = Ob | module | OK | the four listeners below, added once at load, die with the window |
| liner-notes.html:793 | ipcRenderer.on('liner-time', (event, s) => { if (s && s.song | module | OK | the four listeners below, added once at load, die with the window |
| liner-notes.html:794 | ipcRenderer.on('liner-disc', (event, d) => { | module | OK | the four listeners below, added once at load, die with the window |
| liner-notes.html:801 | ipcRenderer.on('liner-opts', (event, o) => { opts = Object.a | module | loop:NOT-WORTH | the booklet's pages (≤ ~40), once when a scan's circle is found |
| liner-notes.html:814 | b.addEventListener('click', () => go(spreads.length - 1))    | status | OK | rebuilt with the status line |
| liner-notes.html:847 | new ResizeObserver(() => { | module | OK | one observer on the stage for the page's life |
| liner-notes.html:851 | resizeTimer = setTimeout(() => { | (anonymous) | loop:NOT-WORTH | one-shot 160 ms debounce per resize burst · cost one layout |
| lookahead-page.js:45 | document.addEventListener('timeupdate', remember, true) | mainWorld | OK | capture listeners on Apple's document, once per page load (the guard above), gone with it |
| lookahead-page.js:46 | document.addEventListener('ended', () => { lastPos = lastDur | mainWorld | OK | capture listeners on Apple's document, once per page load (the guard above), gone with it |
| lookahead-page.js:49 | mk.addEventListener('nowPlayingItemDidChange', () => { | hook [hot] | OK | one MusicKit listener per page load (its instance lives as long as the page) |
| lookahead-page.js:68 | if (n < 120) setTimeout(() => wait(n + 1), 500) | wait [hot] | loop:SERIAL-REQUIRED | retry until MusicKit is configured · every 500 ms · at most 120 tries (60 s) · stops when hooked |
| lookahead-page.js:86 | for (const ev of ['pause', 'play', 'playing', 'seeking', 'se | isolatedWorld | loop:NOT-WORTH | six event names, once per page load |
| lookahead-page.js:87 | document.addEventListener('sonata-la', () => { | isolatedWorld | loop:NOT-WORTH | six event names, once per page load |
| lookahead.js:244 | const sock = deps.net.createConnection(socketPath) | createDelayLine [hot] | OK | one socket per helper run; ends with close() or the helper's exit (its 'close' below) |
| lookahead.js:253 | sock.once('error', reject) | (anonymous) | OK | once listeners, gone after the first event or with the socket |
| lookahead.js:255 | sock.once('connect', () => resolve()) | (anonymous) | OK | the first event only; the 'data' listener below handles the rest |
| lookahead.js:259 | sock.on('data', (s) => { | createDelayLine [hot] | OK | 'data'/'close'/'error' die with the socket |
| lookahead.js:273 | sock.on('error', () => {}) | createDelayLine [hot] | OK | 'error'/'close' die with the socket |
| lookahead.js:274 | sock.on('close', () => { | createDelayLine [hot] | OK | 'error'/'close' die with the socket |
| lookahead.js:287 | const w = { resolve, reject, late: false, timer: setTimeout( | (anonymous) | OK | one-shot reply timeout, cleared by the reply or the close |
| lookahead.js:358 | c = deps.spawn(deps.binary, ['--ctl', deps.socketPath, '--de | start | OK | one helper child at a time; ends when its socket closes (stop), by SIGTERM, or with Sonata (PR_SET_PDEATHSIG) |
| lookahead.js:375 | c.stdout.on('data', onReady) | start | OK | stdout/stderr/exit listeners die with the child |
| lookahead.js:377 | c.stderr.on('data', (s) => log('helper: ' + String(s).trim() | start | OK | stdout/stderr/exit listeners die with the child |
| lookahead.js:379 | c.on('error', (e) => { if (child === c) fail('could not star | start | OK | stdout/stderr/exit listeners die with the child |
| lookahead.js:380 | c.on('exit', (code, signal) => gone(c, code, signal)) | start | OK | stdout/stderr/exit listeners die with the child |
| lookahead.js:382 | readyTimer = setTimeout(() => { if (child === c && !line) {  | start | loop:NOT-WORTH | one-shot ready timeout per start |
| lookahead.js:438 | restartTimer = setTimeout(() => { restartTimer = null; if (! | gone | loop:SERIAL-REQUIRED | retry/backoff: at most MAX_RESTARTS restarts per run, RESTART_MS apart |
| lookahead.js:456 | deps.execFile('pactl', ['move-sink-input', String(s.index),  | (anonymous) | OK | one short pactl child per move (2 s timeout) |
| lookahead.js:477 | deps.execFile('pactl', ['move-sink-input', String(s.index),  | (anonymous) | OK | one short pactl child (2 s timeout) |
| lookahead.js:489 | try { s = deps.spawn('pactl', ['subscribe'], { stdio: ['igno | watchStreams [hot] | OK | one `pactl subscribe` child while look-ahead runs; killed in stop() and fallback() |
| lookahead.js:493 | s.stdout.on('data', (t) => { | watchStreams [hot] | OK | the child's listeners die with it; it is killed in stop()/fallback() |
| lookahead.js:497 | routeTimer = setTimeout(() => { routeTimer = null; route() } | (anonymous) [hot] | loop:NOT-WORTH | one debounced check per burst of stream events |
| lookahead.js:500 | s.on('error', () => {}) | watchStreams [hot] | loop:NOT-WORTH | one debounced check per burst of stream events |
| lookahead.js:501 | s.on('exit', () => { if (sub === s) sub = null }) | watchStreams [hot] | loop:NOT-WORTH | one debounced check per burst of stream events |
| lookahead.js:521 | confirmTimer = setTimeout(() => { | armConfirm [hot] | OK | one-shot; cleared by the player's own confirm, the next gate or stop() |
| lookahead.js:537 | boundaryTimer = setTimeout(() => { boundaryTimer = null; pag | pageEvent [hot] | OK | one-shot; cleared by the item change, the next such seek or stop() |
| lookahead.js:571 | drainTimer = setTimeout(() => { | pageEvent [hot] | loop:NOT-WORTH | one-shot safety per held item change |
| lookahead.js:613 | const t = setTimeout(() => { if (child === c) kill(c) }, 100 | stop | loop:NOT-WORTH | one-shot kill timer at stop |
| lyrics-prefetch.js:51 | const realSleep = (ms) => new Promise((resolve) => setTimeou | (anonymous) | OK | a one-shot wait between two lookups, settled after ms (nothing holds it) |
| lyrics-sources.js:468 | const realSleep = (ms) => new Promise((resolve) => setTimeou | (anonymous) | OK | a one-shot wait inside one lookup, settled after ms (nothing holds it) |
| lyrics-store.js:92 | if (!timer) timer = setTimeout(save, debounceMs) | set | loop:NOT-WORTH | cache write debounce · one-shot 2 s per burst of changes · stops after the write · cost one file write |
| lyrics-view.js:780 | el.onclick = () => { |  | OK | one click handler per line, dropped with the line on the next setData |
| lyrics-view.js:959 | b.onclick = (e) => { e.stopPropagation(); opts.onExpressive( |  | OK | released with the line (replaced on each state change and with the song's layout) |
| lyrics-view.js:1145 | doc.defaultView.addEventListener('resize', () => { | createLyricsView | OK | one resize listener per view; views live as long as their window (the row edges change) |
| lyrics-view.js:1150 | if (!bgFrame) bgFrame = requestAnimationFrame(() => { bgFram | (anonymous) [hot] | OK | at most one pending frame (bgFrame), cleared when it runs |
| lyrics-view.js:1361 | if (slides && !still() && !jump) for (const s of slides) s.e |  | loop:NOT-WORTH | the elements a dots row moved (at most the window's lines), per open/close |
| lyrics-view.js:1422 | g.anims = g.dots.map((d, i) => d.animate(k.dots[i], opts)).c |  | loop:NOT-WORTH | 3 dots, once per interlude shown (only while g.anims is null) |
| lyrics-view.js:1563 | extras.forEach((el, k) => x.anims.push(el.animate(X.letterBi |  | loop:NOT-WORTH | the extra letters (≤ MAX_EXTRA), once per held word |
| lyrics-view.js:1565 | if (coda) x.anims.push(coda.animate(X.codaRide(n * w * squee |  | loop:NOT-WORTH | the extra letters (≤ MAX_EXTRA), once per held word |
| lyrics-view.js:1577 | if (kf) x.anims.push(el.animate(kf, o)) |  | loop:NOT-WORTH | the vowel and extra letters (≤ ~11), once per held word |
| lyrics-view.js:1578 | else if (base) x.anims.push(el.animate(X.heldAt(base), o))   |  | loop:NOT-WORTH | the vowel and extra letters (≤ ~11), once per held word |
| lyrics-view.js:1605 | x.anims.push(el.animate(plan.opacity, o)) |  | OK | the ghost's animations (≤ ~14) are cancelled in endExpression, its node removed (song end, setData) |
| lyrics-view.js:1606 | if (plan.drift) x.anims.push(el.animate(plan.drift, o)) |  | OK | the ghost's animations (≤ ~14) are cancelled in endExpression, its node removed (song end, setData) |
| lyrics-view.js:1615 | if (birth) x.anims.push(s.animate(birth, o)) |  | loop:NOT-WORTH | a ghost's letters (≤ ~12), once per ghost |
| lyrics-view.js:1620 | if (wave) x.anims.push(s.animate(wave, o)) |  | OK | cancelled with the ghost in endExpression (see above) |
| lyrics-view.js:1621 | else if (base) x.anims.push(s.animate(X.heldAt(base), o)) |  | OK | cancelled with the ghost in endExpression (see above) |
| lyrics-view.js:1706 | if (wait < 0.03) { raf = requestAnimationFrame(frame); retur | schedule [hot] | OK | at most one rAF or one wake-up timeout pending (raf / wake); stopFrames cancels both on |
| lyrics-view.js:1707 | wake = setTimeout(() => { wake = 0; raf = requestAnimationFr | schedule [hot] | OK | at most one rAF or one wake-up timeout pending (raf / wake); stopFrames cancels both on |
| lyrics-view.js:1771 | container.addEventListener('focusin', (e) => { | createLyricsView | OK | one keydown and one focusin listener on the list, released with its window |
| lyrics-view.js:1776 | container.addEventListener('keydown', (e) => { | createLyricsView | loop:NOT-WORTH | one pass over the song's lines, per focus move inside the list |
| lyrics-view.js:1797 | doc.addEventListener('visibilitychange', () => { | createLyricsView | OK | one listener per view, released with its window (views live as long as their window) |
| lyrics.html:819 | ipcRenderer.on('theme', (event, t) => theme.set(t)) | module | OK | 'theme' and 'palette' listeners, added once at load, released with the window |
| lyrics.html:820 | ipcRenderer.on('palette', (event, p) => { | module | OK | 'theme' and 'palette' listeners, added once at load, released with the window |
| lyrics.html:840 | ipcRenderer.on('lyrics-art', (event, url) => { | module | OK | added once at load, released with the window |
| lyrics.html:849 | img.onload = async () => { |  | OK | the onload handler goes with its Image (collected after the load) |
| lyrics.html:860 | await thumb.animate([{ transform: 'rotateY(0deg)' }, { trans |  | OK | a 250 ms flip, finishes on its own (no fill); once per new cover |
| lyrics.html:864 | thumb.animate([{ transform: 'rotateY(-90deg)' }, { transform |  | OK | a 250 ms flip, finishes on its own (no fill); once per new cover |
| lyrics.html:869 | artEl.onclick = () => ipcRenderer.send('lyrics-command', 'sh |  | OK | one click handler on the header art, released with the window |
| lyrics.html:873 | artEl.addEventListener('keydown', (e) => { if (e.key === 'En | module | OK | the art's keydown (Enter/Space, a button for the keyboard) and contextmenu, and the page's |
| lyrics.html:874 | artEl.addEventListener('contextmenu', (e) => { e.preventDefa | module | OK | the art's keydown (Enter/Space, a button for the keyboard) and contextmenu, and the page's |
| lyrics.html:875 | document.addEventListener('keydown', (e) => { if (e.key ===  | module | OK | the art's keydown (Enter/Space, a button for the keyboard) and contextmenu, and the page's |
| lyrics.html:904 | ipcRenderer.on('lyrics-settings', (event, s) => { | module | OK | added once at load, released with the window |
| lyrics.html:968 | const anim = armEl.animate([{ transform: rot(from), offset:  |  | OK | fill 'forwards' (the arm stays put): cancelled by the next stopArm() (seek, pause, new song) |
| lyrics.html:974 | swingTimer = setTimeout(() => { swingTimer = 0; tonearm.clas | syncArm | loop:NOT-WORTH | one-shot, once per new song: sets the arm down when the swing ends |
| lyrics.html:980 | document.getElementById('close').onclick = () => ipcRenderer |  | OK | one click handler, released with the window |
| lyrics.html:1019 | new ResizeObserver(placeGrip).observe(headerEl) | module | OK | the five ResizeObservers below live as long as the window |
| lyrics.html:1020 | new ResizeObserver(placeGrip).observe(artEl) | module | OK | the five ResizeObservers below live as long as the window |
| lyrics.html:1021 | new ResizeObserver(placeGrip).observe(document.getElementByI | module | OK | the five ResizeObservers below live as long as the window |
| lyrics.html:1023 | new ResizeObserver(() => { if (sheetBand) sheetBand.relayout | module | OK | the five ResizeObservers below live as long as the window |
| lyrics.html:1024 | new ResizeObserver(placeGrip).observe(document.getElementByI | module | OK | the five ResizeObservers below live as long as the window |
| lyrics.html:1029 | ipcRenderer.on('lyrics-hdr', (event, s) => hdrGlow.set(s)) | module | OK | added once at load, released with the window |
| lyrics.html:1051 | ipcRenderer.on('lyrics-data', (event, data) => { | module | OK | the lyrics feed's listeners ('lyrics-data', '-refined', '-aligned', '-time'), added once at load, released with the window |
| lyrics.html:1075 | ipcRenderer.on('lyrics-refined', (event, msg) => view.refine | module | OK | see 'lyrics-data' above |
| lyrics.html:1076 | ipcRenderer.on('lyrics-aligned', (event, msg) => view.align( | module | OK | see 'lyrics-data' above |
| lyrics.html:1077 | ipcRenderer.on('lyrics-stream', (event, msg) => view.stream( | module | OK | see 'lyrics-data' above |
| lyrics.html:1078 | ipcRenderer.on('lyrics-align-state', (event, text) => view.a | module | OK | see 'lyrics-data' above |
| lyrics.html:1079 | ipcRenderer.on('lyrics-expr-note', (event, note) => view.exp | module | OK | see 'lyrics-data' above |
| lyrics.html:1080 | ipcRenderer.on('lyrics-expr', (event, msg) => view.express(m | module | OK | see 'lyrics-data' above |
| lyrics.html:1084 | ipcRenderer.on('lyrics-time', (event, clock) => { | module | OK | see 'lyrics-data' above |
| lyrics.html:1091 | document.addEventListener('visibilitychange', updateStill) | module | OK | one listener for the window's life (the view keeps its own for the word animation) |
| lyrics.html:1103 | ipcRenderer.on('lyrics-form', (event, f) => montage.setForm( | module | OK | the Montage's five listeners (form, state, time, theme; the colour scheme's change), added once at load, released with the window |
| lyrics.html:1104 | ipcRenderer.on('stage-montage', (event, m) => montage.setSta | module | OK | the Montage's five listeners (form, state, time, theme; the colour scheme's change), added once at load, released with the window |
| lyrics.html:1105 | ipcRenderer.on('lyrics-time', () => montage.setPlaying(view. | module | OK | the Montage's five listeners (form, state, time, theme; the colour scheme's change), added once at load, released with the window |
| lyrics.html:1106 | ipcRenderer.on('theme', () => montage.reshade()) | module | OK | the Montage's five listeners (form, state, time, theme; the colour scheme's change), added once at load, released with the window |
| lyrics.html:1107 | matchMedia('(prefers-color-scheme: dark)').addEventListener( | module | OK | the Montage's five listeners (form, state, time, theme; the colour scheme's change), added once at load, released with the window |
| lyrics.html:1126 | relayout = requestAnimationFrame(() => { relayout = 0; place | onLayout | OK | one pending frame at most (cancelled by the next layout change), per layout change |
| lyrics.html:1172 | overEl.animate([{ transform: 'translateY(' + was + 'px)' },  |  | OK | a 300 ms one-shot per line change, finished on its own (transform only: compositor) |
| lyrics.html:1177 | ipcRenderer.on('lyrics-sheet', (event, st) => { | module | OK | one listener, added once at load, released with the window |
| lyrics.html:1188 | document.getElementById('form').onclick = () => ipcRenderer. |  | OK | one click handler on the stage button, released with the window |
| lyrics.html:1191 | ipcRenderer.on('lyrics-form', (event, f) => stage.setForm(f) | module | OK | the stage's nine listeners ('lyrics-form', 'stage-np', 'stage-queue', 'stage-liner', 'stage-song', |
| lyrics.html:1192 | ipcRenderer.on('stage-song', (event, st) => stage.setSong(st | module | OK | the stage's nine listeners ('lyrics-form', 'stage-np', 'stage-queue', 'stage-liner', 'stage-song', |
| lyrics.html:1193 | ipcRenderer.on('stage-credits', (event, c) => stage.setCredi | module | OK | the stage's nine listeners ('lyrics-form', 'stage-np', 'stage-queue', 'stage-liner', 'stage-song', |
| lyrics.html:1194 | ipcRenderer.on('stage-said', (event, n) => stage.said(n)) | module | OK | the stage's nine listeners ('lyrics-form', 'stage-np', 'stage-queue', 'stage-liner', 'stage-song', |
| lyrics.html:1195 | ipcRenderer.on('stage-row-credits', (event, c) => stage.rowC | module | OK | the stage's nine listeners ('lyrics-form', 'stage-np', 'stage-queue', 'stage-liner', 'stage-song', |
| lyrics.html:1196 | ipcRenderer.on('stage-flip', (event, on) => stage.flip(!!on) | module | OK | the stage's nine listeners ('lyrics-form', 'stage-np', 'stage-queue', 'stage-liner', 'stage-song', |
| lyrics.html:1199 | linesEl.addEventListener('click', (e) => { if (stage.shown & | module | OK | one click listener on the lyrics list, released with the window |
| lyrics.html:1200 | ipcRenderer.on('stage-liner', (event, ok) => stage.linerFoun | module | OK | one click listener on the lyrics list, released with the window |
| lyrics.html:1201 | ipcRenderer.on('stage-np', (event, np) => stage.setNowPlayin | module | OK | one click listener on the lyrics list, released with the window |
| lyrics.html:1202 | ipcRenderer.on('stage-queue', (event, q) => stage.setQueue(q | module | OK | one click listener on the lyrics list, released with the window |
| lyrics.html:1203 | ipcRenderer.on('lyrics-time', (event, playbackTime) => { if  | module | OK | one click listener on the lyrics list, released with the window |
| lyrics.html:1206 | new ResizeObserver(() => { if (!relayout) relayout = request | module | OK | one ResizeObserver on the lyrics list for the window's life |
| main.js:169 | timer = setTimeout(() => { | save [hot] | OK | resize/move listeners live on the window and die with it; the timer checks isDestroyed() first |
| main.js:173 | win.on('resize', save); win.on('move', save)   // lifetime:  | persistBounds [hot] | OK | both die with the window |
| main.js:235 | execFile('gdbus', ['call', '--session', '--dest', 'org.freed | readDesktopScheme [hot] | OK | one short gdbus call per read (3 s timeout), it ends by itself |
| main.js:250 | schemeWatch = spawn('gdbus', ['monitor', '--session', '--des | watchDesktopScheme [hot] | OK | one child process while the theme is "Same as the desktop" (Linux); stopped when Sonata's |
| main.js:254 | schemeWatch.stdout.on('data', (chunk) => { | watchDesktopScheme [hot] | OK | data/exit/error listeners on that child, gone with it |
| main.js:264 | schemeWatch.on('error', () => { schemeWatch = null })   // e | watchDesktopScheme [hot] | loop:NOT-WORTH | the lines of one portal signal |
| main.js:265 | schemeWatch.on('exit', () => { schemeWatch = null }) | watchDesktopScheme [hot] | loop:NOT-WORTH | the lines of one portal signal |
| main.js:303 | win.webContents.on('will-navigate', (event) => event.prevent | lockDownLocalWindow [hot] | OK | one setWindowOpenHandler + one will-navigate listener per local window; both die with the window |
| main.js:417 | miniWindow = new BrowserWindow({ | createMiniWindow [hot] | OK | one mini window at a time; its 'closed' handler nulls it and stops its poll |
| main.js:438 | if (settings.miniAlwaysOnTop) setTimeout(() => applyMiniKeep | createMiniWindow [hot] | loop:NOT-WORTH | mini keep-above · 300 ms one-shot · runs once per mini open · stops after firing · cost one qdbus exec (KDE Wayland only) |
| main.js:442 | miniWindow.webContents.on('before-input-event', (event, inpu | createMiniWindow [hot] | OK | registered once per mini window, dies with its webContents |
| main.js:444 | miniWindow.webContents.once('did-finish-load', () => { | createMiniWindow [hot] | OK | registered once per mini window, dies with its webContents |
| main.js:451 | miniPoll = setInterval(async () => { | (anonymous) | loop:HOT-PATH-OK | mini player now-playing poll · 1000 ms · runs while the mini window exists (also when minimized or paused) · stops on mini 'closed' (and main 'close') · cost 1 executeJavaScript/s into the page + 1 IPC send; measured 0.04-0.05 % of one core in the main process (docs/PERFORMANCE.md). Left as is: only runs while the mini player is open; polling on while minimized costs the same, not worth a code change. |
| main.js:471 | miniWindow.on('closed', () => { | createMiniWindow [hot] | OK | the 'closed' handler nulls miniWindow and clears miniPoll, so no closure keeps the destroyed window alive |
| main.js:1246 | execFile('pactl', args, { timeout: 2000, maxBuffer: 4 * 1024 | (anonymous) | OK | one short pactl child per lookup (2 s timeout); only on a play or item event while look-ahead runs |
| main.js:1335 | ipcMain.on('apple:lookahead', (event, msg) => { | module | OK | registered once at module load |
| main.js:1364 | if (!lyricsPoll) lyricsPoll = setInterval(lyricsTick, 500) | startLyricsFeed [hot] | loop:HOT-PATH-OK | lyrics now-playing poll · 500 ms · runs while the lyrics window or the visualizer exists (also when minimized or paused), or while look-ahead runs (0.15.70: it learns songs with no view open; nothing is sent then) · stops when the last of them closes (stopLyricsFeedIfIdle; and main 'close') · cost 2 executeJavaScript/s + 1 IPC send per view per tick; one lyrics lookup per track change (cached, see lyrics-sources.js). One poll for both views (the visualizer had its own 300 ms poll before 0.15.22). |
| main.js:1529 | lyricsWindow = new BrowserWindow(Object.assign(bounds, { | createLyricsWindow [hot] | OK | one lyrics window at a time; 'closed' nulls it and stops the feed when no view is left |
| main.js:1551 | lyricsWindow.webContents.on('before-input-event', (event, in | createLyricsWindow [hot] | OK | registered once per lyrics window, dies with its webContents |
| main.js:1554 | lyricsWindow.webContents.once('did-finish-load', () => { | createLyricsWindow [hot] | OK | fires once per load |
| main.js:1565 | if (settings.lyricsAlwaysOnTop) setTimeout(() => applyLyrics | (anonymous) | loop:NOT-WORTH | lyrics keep-above · 300 ms one-shot · once per lyrics open · stops after firing · cost one qdbus exec (KDE Wayland only) |
| main.js:1569 | lyricsWindow.on('closed', () => { | createLyricsWindow [hot] | OK | 'closed' nulls lyricsWindow; the feed stops when no lyric view is left |
| main.js:1709 | ipcMain.on('stage-command', (event, command, value) => { | module | OK | registered once at module load (like every ipcMain handler here) |
| main.js:1815 | stageReread = setTimeout(() => { stageReread = null; if (sta | settleStageSong [hot] | OK | one one-shot re-read at a time (cleared by a new write), at most STAGE_REREAD_MS.length per write; it reads only while the same write still waits |
| main.js:2054 | ipcMain.on('lyrics-command', (event, command, value) => { | module | OK | every ipcMain.on / ipcMain.handle in this file is registered once at module load, never per window open (measured: counts stay at 1 after 20 open/close cycles of each window) |
| main.js:2128 | coverWindow = new BrowserWindow({ | openCover | OK | one lightbox at a time; 'closed' nulls it (it closes on Esc, a click or losing the focus) |
| main.js:2145 | win.webContents.once('did-finish-load', () => { | openCover | OK | fires once per load |
| main.js:2153 | win.on('blur', () => { if (!win.isDestroyed()) win.close() } | openCover | OK | 'blur' and 'closed' die with the window; leaving the lightbox closes it |
| main.js:2154 | win.on('closed', () => { if (coverWindow === win) coverWindo | openCover | OK | 'blur' and 'closed' die with the window; leaving the lightbox closes it |
| main.js:2157 | ipcMain.on('cover-command', (event, command) => { | module | OK | registered once at module load (see the note at ipcMain 'lyrics-command') |
| main.js:2356 | linerPoll = setInterval(linerTick, 500) | syncLinerPoll | loop:HOT-PATH-OK | the booklet's sung-line poll · 500 ms · only while a lyrics page of the playing song is open in a shown booklet · stops when the page turns away, the window hides or minimizes, or closes · cost 2 executeJavaScript/s + an IPC send per line change |
| main.js:2405 | linerWindow = new BrowserWindow(applySavedBounds(Object.assi | createLinerWindow | OK | one booklet at a time; 'closed' stops its poll and nulls it |
| main.js:2420 | win.webContents.once('did-finish-load', () => { | createLinerWindow | OK | fires once per load |
| main.js:2427 | win.on('minimize', syncLinerPoll); win.on('restore', syncLin | createLinerWindow | OK | these die with the window; hidden or minimized, the sung-line poll stops |
| main.js:2428 | win.on('closed', () => { | createLinerWindow | OK | these die with the window; hidden or minimized, the sung-line poll stops |
| main.js:2437 | ipcMain.on('liner-command', (event, command, arg) => { | module | OK | registered once at module load (see the note at ipcMain 'lyrics-command') |
| main.js:2460 | vizWindow = new BrowserWindow({ | createVizWindow [hot] | OK | one visualizer at a time; 'closed' stops its audio and nulls it |
| main.js:2474 | vizWindow.webContents.on('before-input-event', (event, input | createVizWindow [hot] | OK | registered once per visualizer window, dies with its webContents |
| main.js:2484 | vizWindow.webContents.once('did-finish-load', () => { | createVizWindow [hot] | OK | one Visualizer (FFT) and one handle on the shared own-stream listener (the one parec, |
| main.js:2493 | vizWindow.on('closed', () => { | createVizWindow [hot] | OK | 'closed' stops the listener handle (the parec ends when no other user listens) and the |
| main.js:2542 | ipcMain.on('viz-close', () => { if (vizWindow) vizWindow.clo | module | OK | registered once at module load (see above) |
| main.js:2640 | new Notification({ title: text.title, body: text.body, silen | actionFailed | OK | shown and collected, no listeners kept (as notifyTrack's) |
| main.js:2747 | exec( | applyKeepAbove [hot] | OK | one short qdbus run, it ends by itself |
| main.js:2780 | execFile('xprop', args, (err) => { if (err) console.error('m | applyMiniBlur [hot] | OK | one short xprop run per mini open or Glass change |
| main.js:2818 | exec('Q=$(command -v qdbus6 \|\| command -v qdbus) && $Q org.k | cleanupWindowPositionMemory | OK | one short qdbus run, it ends by itself |
| main.js:2909 | ipcMain.on('mini-command', (event, command, value) => { | module | OK | registered once at module load (see the note at ipcMain 'lyrics-command') |
| main.js:2979 | new Notification({ title: state.title, body, icon, silent: t | notifyTrack [hot] | OK | shown and collected, no listeners kept |
| main.js:2989 | setInterval(async () => { | startNowPlayingLoop | loop:HOT-PATH-OK | tray / notifications / Last.fm / Discord now-playing poll · 5000 ms · runs always (the tray |
| main.js:3245 | appleRetryTimer = setTimeout(() => { appleRetryTimer = null; | appleLoadFailed | OK | one-shot retry, re-armed by the next failure, cleared on a successful load (appleLoaded) |
| main.js:3506 | execFile('lspci', ['-mm', '-nn'], { timeout: 5000 }, (err, o | gpuScan [hot] | OK | one lspci child, once; it ends by itself (5 s timeout) |
| main.js:3556 | helperPushTimer = setTimeout(() => { helperPushTimer = null; | helperChanged | OK | one-shot, at most one pending (≤ 4 pushes a second while a job runs) |
| main.js:3744 | helperFeedFirst = setTimeout(() => checkEngineFeed(true), 25 | startHelperFeedChecks | OK | both cleared at the top here (checks off or restarted); they end with the app |
| main.js:3745 | helperFeedTimer = setInterval(() => checkEngineFeed(true), 6 | startHelperFeedChecks | OK | both cleared at the top here (checks off or restarted); they end with the app |
| main.js:3856 | tray = new Tray(icon) | createTray | NOT-WORTH | one tray and its click listener for the app's life |
| main.js:3859 | tray.on('click', toggleWindow) | createTray | NOT-WORTH | one tray and its click listener for the app's life |
| main.js:4018 | panelView = new WebContentsView({ webPreferences: SONATA_VIE | createPanelView [hot] | OK | created once on first show, kept (hidden), closed with the window |
| main.js:4026 | panelView.webContents.on('before-input-event', (event, input | createPanelView [hot] | OK | one listener each on the panel's web contents, created once, die with it |
| main.js:4027 | panelView.webContents.on('focus', () => { focusedView = 'pan | createPanelView [hot] | OK | one listener each on the panel's web contents, created once, die with it |
| main.js:4028 | panelView.webContents.on('did-start-loading', () => { panelM | createPanelView [hot] | OK | one listener each on the panel's web contents, created once, die with it |
| main.js:4211 | win.webContents.on('did-finish-load', () => sendHdr(win)) | trackHdr [hot] | OK | the load, move and closed listeners die with the window; the one-shot timer is cleared on close |
| main.js:4212 | win.on('move', () => { clearTimeout(timer); timer = setTimeo | trackHdr [hot] | OK | the load, move and closed listeners die with the window; the one-shot timer is cleared on close |
| main.js:4213 | win.on('closed', () => clearTimeout(timer)) | trackHdr [hot] | OK | the load, move and closed listeners die with the window; the one-shot timer is cleared on close |
| main.js:4220 | const later = () => { clearTimeout(screensTimer); screensTim | later | OK | one 250 ms one-shot, replaced by the next screen event (a debounce) |
| main.js:4359 | toastView = new WebContentsView({ webPreferences: SONATA_VIE | syncToasts [hot] | OK | closed (removeChildView + close) when the last toast goes, at the top of syncToasts |
| main.js:4428 | ipcMain.on('rail:command', (event, command) => { | module | OK | registered once at module load (like every ipcMain handler here) |
| main.js:4458 | ipcMain.on('rail:focus-in', (event, where) => { | module | OK | registered once at module load |
| main.js:4470 | ipcMain.on('apple:volume', (event, steps) => { | module | OK | registered once at module load |
| main.js:4486 | ipcMain.on('panel:command', (event, command, a, b, c) => { | module | OK | registered once at module load |
| main.js:4623 | mainWindow = new BaseWindow(opts) | createWindow | NOT-WORTH | the one main window, for the app's life (close quits or hides to the tray) |
| main.js:4627 | appleView = new WebContentsView({ | createWindow | OK | the views' web contents are closed in the window's 'closed' handler (a BaseWindow doesn't) |
| main.js:4631 | railView = new WebContentsView({ webPreferences: SONATA_VIEW | createWindow | OK | the views' web contents are closed in the window's 'closed' handler (a BaseWindow doesn't) |
| main.js:4639 | appleWC().on('did-fail-load', (e, code, desc, url, isMain) = | createWindow | OK | 'did-fail-load' / 'did-finish-load' listeners for Apple's view's life (they go with it) |
| main.js:4640 | appleWC().on('did-finish-load', appleLoaded) | createWindow | OK | 'did-fail-load' / 'did-finish-load' listeners for Apple's view's life (they go with it) |
| main.js:4646 | railView.webContents.once('did-finish-load', () => gfx.paint | createWindow | OK | once, on the rail's first load: the start-marker clock (gfx-runtime.js) starts there |
| main.js:4657 | saveBoundsTimer = setTimeout(() => { | rememberBounds [hot] | OK | one 500 ms debounce, cleared before each new one |
| main.js:4662 | mainWindow.on('resize', rememberBounds) | createWindow | loop:NOT-WORTH | main-window bounds save · 500 ms one-shot debounce · only after a move/resize · cost ~0 |
| main.js:4663 | mainWindow.on('move', rememberBounds) | createWindow | loop:NOT-WORTH | main-window bounds save · 500 ms one-shot debounce · only after a move/resize · cost ~0 |
| main.js:4668 | mainWindow.on('resize', pushRail) | createWindow | OK | one listener each for the views' layout, die with the window · per event one bounds |
| main.js:4675 | mainWindow.on('enter-full-screen', pushRail) | createWindow | loop:NOT-WORTH | two event names, once |
| main.js:4676 | mainWindow.on('leave-full-screen', pushRail) | createWindow | loop:NOT-WORTH | two event names, once |
| main.js:4679 | mainWindow.on('focus', () => { | createWindow | OK | one listener · the window's focus goes to the view that had it (a BaseWindow has no |
| main.js:4688 | appleWC().on('before-input-event', (event, input) => windowS | createWindow | OK | createWindow runs once (plus macOS 'activate' with no windows), so the views' and the |
| main.js:4689 | railView.webContents.on('before-input-event', (event, input) | createWindow | OK | createWindow runs once (plus macOS 'activate' with no windows), so the views' and the |
| main.js:4690 | appleWC().on('focus', () => { focusedView = 'apple' }) | createWindow | OK | createWindow runs once (plus macOS 'activate' with no windows), so the views' and the |
| main.js:4691 | railView.webContents.on('focus', () => { focusedView = 'rail | createWindow | OK | createWindow runs once (plus macOS 'activate' with no windows), so the views' and the |
| main.js:4693 | railView.webContents.on('did-start-loading', () => { railMou | createWindow | OK | createWindow runs once (plus macOS 'activate' with no windows), so the views' and the |
| main.js:4697 | mainWindow.on('app-command', (event, command) => { | createWindow | OK | once per window, dies with it |
| main.js:4707 | appleWC().on('will-navigate', (event, url) => { | createWindow | OK | dies with Apple's view |
| main.js:4722 | appleWC().on('did-navigate', () => { | createWindow | OK | FIXED: this used to call insertCSS directly, which adds a new stylesheet every time; |
| main.js:4729 | appleWC().on('dom-ready', injectFocusStops) | createWindow | OK | one dom-ready listener, dies with the view · per Apple page load (not per SPA route |
| main.js:4730 | appleWC().on('dom-ready', injectMediaPosition) | createWindow | OK | one dom-ready listener, dies with the view · per Apple page load (not per SPA route |
| main.js:4731 | appleWC().on('dom-ready', injectLookahead) | createWindow | OK | one dom-ready listener, dies with the view · per Apple page load (not per SPA route |
| main.js:4733 | appleWC().on('page-title-updated', () => { | createWindow | OK | one dom-ready listener, dies with the view · per Apple page load (not per SPA route |
| main.js:4739 | mainWindow.on('closed', () => { | createWindow | OK | a BaseWindow doesn't destroy its views' web contents; they are closed here |
| main.js:4743 | mainWindow.on("close", (e) => { | createWindow | loop:NOT-WORTH | 4 views, once on close |
| main.js:4819 | exec(`update-desktop-database ${JSON.stringify(appsDir)} 2>/ | integrateAppImage | OK | one short run when the entry changed, it ends by itself |
| main.js:4828 | const req = net.request(url) |  | OK | one request per feed fetch; its listeners go with it at end or error |
| main.js:4831 | req.on('response', (res) => { | (anonymous) | OK | one request per feed fetch; its listeners go with it at end or error |
| main.js:4834 | res.on('data', (chunk) => { body += chunk }) | (anonymous) | OK | one request per feed fetch; its listeners go with it at end or error |
| main.js:4835 | res.on('end', () => resolve(body)) | (anonymous) | OK | one request per feed fetch; its listeners go with it at end or error |
| main.js:4836 | res.on('error', reject)   // lifetime: OK — the response's l | (anonymous) | OK | the response's listeners go with it |
| main.js:4838 | req.on('error', reject)   // lifetime: OK — goes with the re | (anonymous) | OK | goes with the request |
| main.js:4847 | const file = fs.createWriteStream(dest) |  | OK | the file stream ends with the response or is closed on failure; one request per download |
| main.js:4849 | const req = net.request(url) |  | OK | the file stream ends with the response or is closed on failure; one request per download |
| main.js:4850 | req.on('response', (res) => { | (anonymous) | OK | the file stream ends with the response or is closed on failure; one request per download |
| main.js:4855 | res.on('data', (chunk) => { got += chunk.length; file.write( | (anonymous) | loop:NOT-WORTH | download stream · one chunk at a time (~16-64 KB) · once per update · ends at EOF · progress ≤ 4/s (updater.js) |
| main.js:4856 | res.on('end', () => file.end(resolve)) | (anonymous) | loop:NOT-WORTH | download stream · one chunk at a time (~16-64 KB) · once per update · ends at EOF · progress ≤ 4/s (updater.js) |
| main.js:4857 | res.on('error', fail) | (anonymous) | loop:NOT-WORTH | download stream · one chunk at a time (~16-64 KB) · once per update · ends at EOF · progress ≤ 4/s (updater.js) |
| main.js:4859 | req.on('error', fail) | (anonymous) | loop:NOT-WORTH | download stream · one chunk at a time (~16-64 KB) · once per update · ends at EOF · progress ≤ 4/s (updater.js) |
| main.js:4910 | const note = new Notification({ | onUpdateState [hot] | OK | one notification per offered version, collected after display |
| main.js:4915 | note.on('click', () => showPanel('settings', 'updates')) | onUpdateState [hot] | OK | one click listener on this notification, collected with it |
| main.js:5008 | execFileSync('systemd-run', relaunch.systemdRunArgs({ target |  | loop:NOT-WORTH | at most two tries: with ExitType=cgroup, then without (systemd older than 250) |
| main.js:5016 | spawn('/bin/sh', relaunch.shellArgs(target, args), { detache | startNewCopy | OK | detached and unref'd: the new Sonata outlives this one |
| main.js:5056 | updateFirstTimer = setTimeout(() => checkForUpdates(false),  | startUpdateChecks | OK | both cleared at the top here (checks off or restarted); they end with the app |
| main.js:5057 | updateTimer = setInterval(() => checkForUpdates(false), upda | startUpdateChecks | OK | both cleared at the top here (checks off or restarted); they end with the app |
| main.js:5091 | app.on('second-instance', () => { | module | NOT-WORTH | app listeners, registered once for the app's life |
| main.js:5159 | app.on('before-quit', () => { | (anonymous) | NOT-WORTH | registered once, for the app's life |
| main.js:5207 | app.on('activate', function () { | (anonymous) | NOT-WORTH | registered once, for the app's life |
| main.js:5218 | app.on('window-all-closed', function () { | module | NOT-WORTH | registered once, for the app's life |
| media-position.js:59 | for (const ev of ['play', 'pause', 'seeked', 'ratechange', ' | attach | loop:NOT-WORTH | six event names, once per page load |
| media-position.js:61 | document.addEventListener('timeupdate', () => declare(false) | attach | loop:NOT-WORTH | six event names, once per page load |
| miniplayer.html:243 | ipcRenderer.on('theme', (event, t) => { | module | OK | added once at load, released with the window |
| miniplayer.html:251 | document.getElementById('shuffle').onclick = () => send('tog |  | OK | one click handler per control (set once at load, released with the window) |
| miniplayer.html:252 | document.getElementById('prev').onclick = () => send('previo |  | OK | one click handler per control (set once at load, released with the window) |
| miniplayer.html:253 | document.getElementById('playpause').onclick = () => send('p |  | OK | one click handler per control (set once at load, released with the window) |
| miniplayer.html:254 | document.getElementById('next').onclick = () => send('next') |  | OK | one click handler per control (set once at load, released with the window) |
| miniplayer.html:255 | document.getElementById('repeat').onclick = () => send('cycl |  | OK | one click handler per control (set once at load, released with the window) |
| miniplayer.html:256 | document.getElementById('queue').onclick = () => send('queue |  | OK | one click handler per control (set once at load, released with the window) |
| miniplayer.html:257 | document.getElementById('lyrics').onclick = () => send('lyri |  | OK | one click handler per control (set once at load, released with the window) |
| miniplayer.html:258 | document.getElementById('more').onclick = () => send('moreMe |  | OK | one click handler per control (set once at load, released with the window) |
| miniplayer.html:260 | document.getElementById('art').onclick = () => send('expand' |  | OK | set once at load, released with the window |
| miniplayer.html:262 | document.getElementById('art').addEventListener('keydown', ( | module | OK | one keydown listener on the artwork, released with the window (a button for the keyboard: Enter / Space) |
| miniplayer.html:265 | document.getElementById('art').addEventListener('contextmenu | module | OK | one contextmenu listener on the artwork, released with the window: its menu (View Album |
| miniplayer.html:266 | document.getElementById('fav').onclick = () => send('toggleF |  | OK | one contextmenu listener on the artwork, released with the window: its menu (View Album |
| miniplayer.html:277 | ipcRenderer.on('favorite-state', (event, fav) => { | module | OK | added once at load, released with the window |
| miniplayer.html:293 | mid.addEventListener('pointerenter', () => { | module | OK | pointerenter / pointerleave on the words, one each, released with the window |
| miniplayer.html:296 | hotTimer = setTimeout(() => mid.classList.add('hot'), 120) | (anonymous) | loop:NOT-WORTH | hover intent · one 120 ms one-shot per pointer entry · cleared on leave · cost ~0 |
| miniplayer.html:298 | mid.addEventListener('pointerleave', () => { clearTimeout(ho | module | loop:NOT-WORTH | hover intent · one 120 ms one-shot per pointer entry · cleared on leave · cost ~0 |
| miniplayer.html:321 | seek.addEventListener('pointerdown', (e) => { | module | OK | pointerdown/move/up and keydown on the bar, one each, released with the window |
| miniplayer.html:328 | seek.addEventListener('pointermove', (e) => { if (dragging)  | module | OK | pointerdown/move/up and keydown on the bar, one each, released with the window |
| miniplayer.html:330 | seek.addEventListener('pointerup', (e) => { | module | OK | see above: one each, released with the window |
| miniplayer.html:336 | seek.addEventListener('keydown', (e) => { | module | OK | see above: one each, released with the window |
| miniplayer.html:348 | volumeSlider.onpointerdown = () => { draggingVolume = true } |  | OK | the slider's three handlers, set once at load, released with the window |
| miniplayer.html:349 | volumeSlider.onpointerup = () => { draggingVolume = false } |  | OK | the slider's three handlers, set once at load, released with the window |
| miniplayer.html:350 | volumeSlider.oninput = () => { |  | OK | the slider's three handlers, set once at load, released with the window |
| miniplayer.html:381 | volumeSlider.addEventListener('wheel', onWheel, { passive: f | module | OK | one wheel listener each on the slider and the speaker button (and the speaker's click), released with the window (not passive: it stops the scroll) |
| miniplayer.html:382 | document.getElementById('mute').addEventListener('wheel', on | module | OK | one wheel listener each on the slider and the speaker button (and the speaker's click), released with the window (not passive: it stops the scroll) |
| miniplayer.html:383 | document.getElementById('mute').onclick = () => { |  | OK | one wheel listener each on the slider and the speaker button (and the speaker's click), released with the window (not passive: it stops the scroll) |
| miniplayer.html:399 | ipcRenderer.on('now-playing', (event, state) => { | module | OK | added once at load, released with the window; a push per second while the mini player is open |
| model-fetch.js:126 | req.setTimeout(STALL_MS, () => req.destroy(new FetchError('d | (anonymous) | OK | the stall timer and the error listener die with the request |
| model-fetch.js:127 | req.on('error', (e) => reject(e instanceof FetchError ? e :  | (anonymous) | OK | the stall timer and the error listener die with the request |
| model-fetch.js:138 | const s = fs.createReadStream(file, { start: 0, end: n - 1 } |  | OK | a read stream over the part, ends at its end or on error |
| model-fetch.js:139 | s.on('data', (b) => h.update(b)) | (anonymous) | OK | a read stream over the part, ends at its end or on error |
| model-fetch.js:140 | s.on('end', () => resolve(h)) | (anonymous) | OK | a read stream over the part, ends at its end or on error |
| model-fetch.js:141 | s.on('error', reject) | (anonymous) | OK | a read stream over the part, ends at its end or on error |
| model-fetch.js:211 | const out = fs.createWriteStream(part, start > 0 ? { flags:  |  | OK | the part's write stream, closed at the response's end or on failure |
| model-fetch.js:224 | res.on('data', (b) => { | (anonymous) | loop:HOT-PATH-OK | one chunk of the response at a time (16-64 KB) · progress at most every 8 MB |
| model-fetch.js:231 | out.on('drain', () => res.resume()) | (anonymous) | loop:HOT-PATH-OK | one chunk of the response at a time (16-64 KB) · progress at most every 8 MB |
| model-fetch.js:234 | res.on('end', () => { ended = true; out.end() }) | (anonymous) | OK | the response's and the part's listeners end with them (end, close, error) |
| model-fetch.js:235 | res.on('close', () => { if (!ended) fail(new FetchError('dow | (anonymous) | OK | the response's and the part's listeners end with them (end, close, error) |
| model-fetch.js:236 | out.on('finish', () => { if (!failed) resolve() }) | (anonymous) | OK | the response's and the part's listeners end with them (end, close, error) |
| model-fetch.js:237 | res.on('error', fail) | (anonymous) | OK | the response's and the part's listeners end with them (end, close, error) |
| model-fetch.js:238 | out.on('error', (e) => { out.destroy(); fail(e) }) | (anonymous) | OK | the response's and the part's listeners end with them (end, close, error) |
| montage-sources.js:52 | const sleep = deps.sleep \|\| ((ms) => new Promise((r) => setT | (anonymous) | OK | one-shot per wait |
| montage-ui.js:52 | tile.onclick = () => { |  | OK | one click handler, set once at load, released with the window |
| montage-ui.js:60 | credit.onclick = () => { if (shownPhoto) send('montage-credi |  | OK | one click handler on the credit line, released with the window |
| montage-ui.js:188 | timer = setTimeout(() => { timer = 0; clock += (win.performa | schedule [hot] | loop:NOT-WORTH | one one-shot per photo (every 20 s) while playing; none paused or hidden |
| montage-ui.js:192 | timer = setTimeout(tick, 1000 / M.FPS) | schedule [hot] | loop:HOT-PATH-OK | the Ken Burns pan · 10 Hz (FPS) · only while the Studio shows, the Montage is on with photos, the music plays and the window is visible · stops on pause, hide, minimise, the Montage off, the compact form · cost 2 transform/opacity writes per tick (composited layers), measured in docs/PERFORMANCE.md |
| montage-ui.js:196 | doc.addEventListener('visibilitychange', () => { if (doc.vis | createMontage | OK | two listeners for the window's life: the window shown/hidden/minimised and the reduced-motion setting |
| montage-ui.js:197 | calmQuery.addEventListener('change', () => { slot = [-1, -1] | createMontage | loop:NOT-WORTH | 2 layers |
| panel-helper.js:50 | btn.onmouseenter = () => show(true) |  | OK | the ⓘ's six handlers, set once, dropped with the section's body |
| panel-helper.js:51 | btn.onmouseleave = () => { if (doc.activeElement !== btn) sh |  | OK | the ⓘ's six handlers, set once, dropped with the section's body |
| panel-helper.js:52 | btn.onfocus = () => show(true) |  | OK | the ⓘ's six handlers, set once, dropped with the section's body |
| panel-helper.js:53 | btn.onblur = () => show(false) |  | OK | the ⓘ's six handlers, set once, dropped with the section's body |
| panel-helper.js:54 | btn.onclick = (e) => { e.stopPropagation(); if (e.isTrusted) |  | OK | the ⓘ's six handlers, set once, dropped with the section's body |
| panel-helper.js:55 | btn.onkeydown = (e) => { if (e.key === 'Escape' && !tipEl.hi |  | OK | the ⓘ's six handlers, set once, dropped with the section's body |
| panel-helper.js:75 | b.addEventListener('click', (e) => { if (e.isTrusted && !b.d | create [hot] | OK | one click listener per button, dropped with the section's body |
| panel-helper.js:100 | sel.addEventListener('change', (e) => { if (e.isTrusted) bri | create [hot] | OK | one change listener, dropped with the section's body |
| panel-helper.js:127 | resultX.addEventListener('click', (e) => { if (e.isTrusted)  | create [hot] | OK | one click listener, dropped with the section's body |
| panel-helper.js:147 | accept.addEventListener('click', (e) => { if (e.isTrusted) s | create [hot] | OK | two click listeners, dropped with the section's body |
| panel-helper.js:148 | decline.addEventListener('click', (e) => { if (e.isTrusted)  | create [hot] | OK | two click listeners, dropped with the section's body |
| panel-helper.js:169 | removeAsk.addEventListener('click', (e) => { if (e.isTrusted | create [hot] | OK | one click listener, dropped with the section's body |
| panel-helper.js:192 | removeBtn.addEventListener('click', (e) => { if (e.isTrusted | create [hot] | OK | two click listeners, dropped with the section's body |
| panel-helper.js:193 | keepCancel.addEventListener('click', (e) => { if (e.isTruste | create [hot] | OK | two click listeners, dropped with the section's body |
| panel-helper.js:200 | lic.addEventListener('keydown', (e) => { if (e.key === 'Esca | create [hot] | OK | two keydown listeners, dropped with the section's body |
| panel-helper.js:201 | conf.addEventListener('keydown', (e) => { if (e.key === 'Esc | create [hot] | OK | two keydown listeners, dropped with the section's body |
| panel-ui.js:110 | b.addEventListener('click', (e) => { if (e.isTrusted && !b.d | switchRow | OK | one click listener per switch, dropped with its section's body |
| panel-ui.js:148 | sel.addEventListener('change', (e) => { if (e.isTrusted) bri | selectRow | OK | one change listener per select, dropped with its section's body |
| panel-ui.js:176 | b.addEventListener('click', (e) => { if (e.isTrusted && !b.d | (anonymous) | OK | one click listener per button, dropped with its section's body |
| panel-ui.js:224 | input.addEventListener('input', paint) | keyRow | OK | input, keydown and the two clicks, dropped with the section's body |
| panel-ui.js:225 | input.addEventListener('keydown', (e) => { if (e.key === 'En | keyRow | OK | input, keydown and the two clicks, dropped with the section's body |
| panel-ui.js:226 | save.addEventListener('click', (e) => { if (!e.isTrusted \|\|  | keyRow | OK | input, keydown and the two clicks, dropped with the section's body |
| panel-ui.js:227 | remove.addEventListener('click', (e) => { if (e.isTrusted) b | keyRow | OK | input, keydown and the two clicks, dropped with the section's body |
| panel-ui.js:264 | keyBtn.addEventListener('click', (e) => { | shortcutRow | OK | click, keydown and blur on the key button and a click on Reset (all four below), dropped with the section's body |
| panel-ui.js:273 | keyBtn.addEventListener('keydown', (e) => { | shortcutRow | OK | the key button's keydown, dropped with the section's body |
| panel-ui.js:286 | keyBtn.addEventListener('blur', () => stopCapture(true)) | shortcutRow | OK | blur on the key button and Reset's click, dropped with the section's body |
| panel-ui.js:287 | reset.addEventListener('click', (e) => { if (e.isTrusted &&  | shortcutRow | OK | blur on the key button and Reset's click, dropped with the section's body |
| panel-ui.js:379 | btn.addEventListener('mouseenter', () => show(true)) | attachInfo | OK | the ⓘ's listeners, dropped with the section's body |
| panel-ui.js:380 | btn.addEventListener('mouseleave', () => { if (doc.activeEle | attachInfo | OK | the ⓘ's listeners, dropped with the section's body |
| panel-ui.js:381 | btn.addEventListener('focus', () => show(true)) | attachInfo | OK | the ⓘ's listeners, dropped with the section's body |
| panel-ui.js:382 | btn.addEventListener('blur', () => show(false)) | attachInfo | OK | the ⓘ's listeners, dropped with the section's body |
| panel-ui.js:383 | btn.addEventListener('click', (e) => { if (e.isTrusted) show | attachInfo | OK | the ⓘ's listeners, dropped with the section's body |
| panel-ui.js:384 | btn.addEventListener('keydown', (e) => { if (e.key === 'Esca | attachInfo | OK | the ⓘ's listeners, dropped with the section's body |
| panel-ui.js:431 | a.addEventListener('click', (e) => { e.preventDefault(); if  | link [hot] | OK | one click listener per link, dropped with its body |
| panel-ui.js:666 | more.addEventListener('click', () => { olderShown = true; sh | update [hot] | OK | one click listener, replaced with the body's content |
| panel-ui.js:723 | copyBtn.addEventListener('click', (e) => { if (e.isTrusted & | curious | OK | one click listener, dropped with the section's body |
| panel-ui.js:896 | b.addEventListener('click', (e) => { if (e.isTrusted) bridge | noticeEl [hot] | OK | one click listener per action button, dropped with the notice |
| panel-ui.js:904 | x.addEventListener('click', (e) => { if (e.isTrusted) bridge | noticeEl [hot] | OK | one click listener, dropped with the notice |
| panel-ui.js:964 | toggle.addEventListener('click', (e) => { if (e.isTrusted) b | (anonymous) | OK | one click listener on each header and pin, dropped with the page's accordion |
| panel-ui.js:965 | pin.addEventListener('click', (e) => { if (e.isTrusted) brid | (anonymous) | OK | one click listener on each header and pin, dropped with the page's accordion |
| panel-ui.js:1072 | menuBtn.addEventListener('click', (e) => { if (!e.isTrusted) | (anonymous) | OK | menu button click, menu click and keydown, one each for the page's life |
| panel-ui.js:1073 | menu.addEventListener('click', (e) => { | (anonymous) | OK | menu button click, menu click and keydown, one each for the page's life |
| panel-ui.js:1079 | menu.addEventListener('keydown', (e) => { | (anonymous) | OK | menu button click, menu click and keydown, one each for the page's life |
| panel-ui.js:1091 | panel.addEventListener('keydown', (e) => { | (anonymous) | OK | one keydown listener on the panel and one pointerdown on the document (closes the menu) |
| panel-ui.js:1114 | doc.addEventListener('pointerdown', (e) => { if (!menu.hidde | (anonymous) | OK | one pointerdown listener on the document for the page's life: a press outside the ⋮ menu closes it |
| portal-shortcuts.js:50 | conn.on('signal', onSignal) | (anonymous) | OK | both listeners go when the request is answered, times out or the connection closes |
| portal-shortcuts.js:51 | conn.on('close', onClose) | (anonymous) | OK | both listeners go when the request is answered, times out or the connection closes |
| portal-shortcuts.js:52 | if (opts && opts.timeoutMs) timer = setTimeout(() => done(re | (anonymous) | OK | cleared in done() |
| portal-shortcuts.js:103 | conn.on('signal', onSignal) | openSession | OK | one 'signal' and one 'close' listener per session; removed when it closes |
| portal-shortcuts.js:104 | conn.on('close', onClose) | openSession | OK | one 'signal' and one 'close' listener per session; removed when it closes |
| preload-panel.js:13 | ipcRenderer.on('panel:state', (_event, state) => { | module | OK | one 'panel:state' and one 'panel:take-focus' listener per page load (the preload runs once |
| preload-panel.js:17 | ipcRenderer.on('panel:take-focus', (_event, where) => { if ( | module | OK | one 'panel:state' and one 'panel:take-focus' listener per page load (the preload runs once |
| preload-rail-view.js:12 | ipcRenderer.on('rail:state', (_event, state) => { | module | OK | one 'rail:state' and one 'rail:take-focus' listener per page load (the preload runs once |
| preload-rail-view.js:16 | ipcRenderer.on('rail:take-focus', () => { if (onFocus) onFoc | module | OK | one 'rail:state' and one 'rail:take-focus' listener per page load (the preload runs once |
| rail-ui.js:200 | panel.addEventListener('pointerenter', () => update('enter') | (anonymous) | OK | panel pointerenter/pointerleave · one each, for the document's life · cost one render per crossing |
| rail-ui.js:201 | panel.addEventListener('pointerleave', () => update('leave') | (anonymous) | OK | panel pointerenter/pointerleave · one each, for the document's life · cost one render per crossing |
| rail-ui.js:203 | panel.addEventListener('focusin', (e) => { | (anonymous) | OK | panel focusin/focusout · one each · keyboard focus opens the rail, a click's focus doesn't |
| rail-ui.js:208 | panel.addEventListener('focusout', (e) => { | (anonymous) | OK | panel focusin/focusout · one each · keyboard focus opens the rail, a click's focus doesn't |
| rail-ui.js:213 | panel.addEventListener('transitionend', slideDone) | (anonymous) | OK | panel transitionend/transitioncancel · one each · the slide is over: narrow the view if it closed |
| rail-ui.js:214 | panel.addEventListener('transitioncancel', slideDone) | (anonymous) | OK | panel transitionend/transitioncancel · one each · the slide is over: narrow the view if it closed |
| rail-ui.js:217 | panel.addEventListener('keydown', (e) => { | (anonymous) | OK | panel keydown · one · arrows/Home/End move focus (roving tabindex), Esc closes, Tab and |
| rail-ui.js:235 | panel.addEventListener('click', (e) => { | (anonymous) | OK | panel click · one (delegated) · a real click or Enter/Space on a button sends its command |
| sheet-notes-ui.js:108 | b.onclick = () => { if (st.place !== value && opts.onPlace)  |  | OK | two click handlers, set once with the band, released with the window |
| sheet-notes-ui.js:283 | anim = strip.animate([{ transform: 'translateX(' + r1(stripX |  | OK | one Web Animation at a time (stopAnim cancels it on a rebuild, a relayout, the band off or reduced motion) |
| sheet-notes-ui.js:333 | wake = setTimeout(() => { wake = 0; const now = opts.time(); | schedule [hot] | OK | at most one pending (wake); cleared on every re-plan, pause, hide and a new song |
| sheet-notes-ui.js:408 | doc.addEventListener('visibilitychange', () => { | createSheetBand | OK | one visibilitychange listener for the band's life (the window's) |
| shortcuts.js:80 | try { ok = d.globalShortcut.register(keys[a.id], () => fire( | x11On | loop:NOT-WORTH | 4 actions, when the switch or a key changes |
| shortcuts.js:149 | retryTimer = d.setTimeout(() => { retryTimer = null; if (ena | retryLater | OK | one pending retry at most, cleared when the shortcuts go off |
| stage-ui.js:127 | el.play.onclick = () => send('play-pause') |  | OK | one click handler per control, set once at load, released with the window |
| stage-ui.js:128 | el.prev.onclick = () => send('previous') |  | OK | one click handler per control, set once at load, released with the window |
| stage-ui.js:129 | el.next.onclick = () => send('next') |  | OK | one click handler per control, set once at load, released with the window |
| stage-ui.js:130 | el.shuffle.onclick = () => send('shuffle') |  | OK | one click handler per control, set once at load, released with the window |
| stage-ui.js:131 | el.repeat.onclick = () => send('repeat') |  | OK | one click handler per control, set once at load, released with the window |
| stage-ui.js:132 | el.tLiner.onclick = () => send('liner-notes') |  | OK | one click handler per control, set once at load, released with the window |
| stage-ui.js:134 | el.tNotes.onclick = () => send('sheet-notes', !sheetOn) |  | OK | one click handler per control, set once at load, released with the window |
| stage-ui.js:138 | el.title.onclick = () => send('song-album') |  | OK | one click handler per control, set once at load, released with the window |
| stage-ui.js:139 | el.album.onclick = () => send('song-album') |  | OK | one click handler per control, set once at load, released with the window |
| stage-ui.js:140 | el.artist.onclick = () => send('song-artist') |  | OK | one click handler per control, set once at load, released with the window |
| stage-ui.js:141 | el.chipLive.onclick = () => send('liner-recording') |  | OK | one click handler per control, set once at load, released with the window |
| stage-ui.js:142 | el.chipTrack.onclick = () => showPlaying(true) |  | OK | one click handler per control, set once at load, released with the window |
| stage-ui.js:143 | el.nextCard.onclick = () => send('next') |  | OK | one click handler per control, set once at load, released with the window |
| stage-ui.js:148 | el.fav.onclick = () => send('song-favorite', !M.favoriteButt |  | OK | one click handler per action, set once at load, released with the window |
| stage-ui.js:149 | el.lib.onclick = () => { |  | OK | one click handler per action, set once at load, released with the window |
| stage-ui.js:153 | el.pl.onclick = () => send('song-playlists', anchorOf(el.pl) |  | OK | one click handler per action, set once at load, released with the window |
| stage-ui.js:154 | el.link.onclick = () => send('song-link') |  | OK | one click handler per action, set once at load, released with the window |
| stage-ui.js:155 | el.goAlbum.onclick = () => send('song-album') |  | OK | one click handler per action, set once at load, released with the window |
| stage-ui.js:157 | el.goArtist.onclick = () => send('song-artist') |  | OK | set once at load, released with the window |
| stage-ui.js:159 | el.more.onclick = () => send('song-more', anchorOf(el.more)) |  | OK | set once at load, released with the window |
| stage-ui.js:190 | noteAnim = el.note.animate([{ opacity: 1 }, { opacity: 1, of |  | OK | one 4 s opacity animation per note (cancelled by the next one); nothing runs after it |
| stage-ui.js:195 | el.coverBtn.onclick = () => flip(true) |  | OK | the cover's and its back's handlers, set once at load, released with the window |
| stage-ui.js:196 | el.cbClose.onclick = () => flip(false) |  | OK | the cover's and its back's handlers, set once at load, released with the window |
| stage-ui.js:197 | el.cbMore.onclick = () => send('credits-liner') |  | OK | the cover's and its back's handlers, set once at load, released with the window |
| stage-ui.js:199 | el.back.addEventListener('click', (e) => { | createStage | OK | the cover's and its back's handlers, set once at load, released with the window |
| stage-ui.js:204 | el.back.addEventListener('keydown', (e) => { if (e.key === ' | createStage | OK | set once at load, released with the window |
| stage-ui.js:254 | bar.onpointerdown = (e) => { if (e.button !== 0) return; dra |  | OK | the bar's pointer and key handlers, set once at load, released with the window |
| stage-ui.js:255 | bar.onpointermove = (e) => { if (dragging) set(at(e), false) |  | OK | the bar's pointer and key handlers, set once at load, released with the window |
| stage-ui.js:256 | bar.onpointerup = (e) => { if (!dragging) return; dragging = |  | OK | the bar's pointer and key handlers, set once at load, released with the window |
| stage-ui.js:257 | bar.onpointercancel = () => { dragging = false; set(get(), t |  | OK | the bar's pointer and key handlers, set once at load, released with the window |
| stage-ui.js:258 | bar.onkeydown = (e) => { |  | OK | the bar's pointer and key handlers, set once at load, released with the window |
| stage-ui.js:297 | el.seek.addEventListener('pointerleave', () => { el.seekTip. | createStage | OK | one listener, set once at load |
| stage-ui.js:315 | el.list.addEventListener('keydown', (e) => { | createStage | OK | the list's keydown, contextmenu and scroll-intent listeners, released with the window |
| stage-ui.js:333 | el.list.addEventListener('contextmenu', (e) => { | createStage | OK | set once at load, released with the window |
| stage-ui.js:342 | el.list.addEventListener('wheel', scrolledByUser, { passive: | createStage | OK | set once at load, released with the window |
| stage-ui.js:344 | el.list.addEventListener('pointerdown', (e) => { if (e.targe | createStage | OK | set once at load, released with the window |
| stage-ui.js:346 | el.list.addEventListener('keydown', (e) => { if (/^(Page(Up\| | createStage | OK | set once at load, released with the window |
| stage-ui.js:354 | $('q-pop-x').onclick = () => closePop(true) |  | OK | the popover's handlers, set once at load |
| stage-ui.js:355 | el.pop.addEventListener('keydown', (e) => { if (e.key === 'E | createStage | OK | the popover's handlers, set once at load |
| stage-ui.js:356 | doc.addEventListener('pointerdown', (e) => { if (!el.pop.hid | createStage | OK | the popover's handlers, set once at load |
| stage-ui.js:382 | doc.addEventListener('keydown', (e) => { | createStage | OK | one capture listener on the page, released with the window |
| stage-ui.js:627 | row.onclick = () => send('play-item', { index: item.index, i |  | OK | one click handler per row, dropped with the row on the next redraw |
| stage-ui.js:639 | m.onclick = () => rowMenu(row) |  | OK | one click handler per row's ⋯, dropped with the row |
| theme-apply.js:68 | dark.addEventListener('change', render) | attach | OK | one 'change' listener on each of the two media queries, for the page's life · fires on |
| theme-apply.js:69 | plain.addEventListener('change', render) | attach | OK | one 'change' listener on each of the two media queries, for the page's life · fires on |
| toast-ui.js:34 | rec.timer = setTimeout(() => bridge.send('toast-done', t.id) | arm [hot] | loop:NOT-WORTH | toast timer · one-shot per toast (5-8 s, longer for long words) · stops when it fires or the toast pauses/ends · cost ~0 |
| toast-ui.js:68 | b.addEventListener('click', (e) => { if (e.isTrusted) bridge | (anonymous) | OK | one click listener per toast's action, dropped with the toast |
| toast-ui.js:78 | x.addEventListener('click', (e) => { if (e.isTrusted) bridge | (anonymous) | OK | one click listener per toast's ×, dropped with the toast |
| toast-ui.js:89 | list.addEventListener('pointerenter', () => pauseAll(true)) | (anonymous) | OK | pointerenter/pointerleave/focusin/focusout on the list, one each for the page's life |
| toast-ui.js:90 | list.addEventListener('pointerleave', () => pauseAll(list.co | (anonymous) | OK | pointerenter/pointerleave/focusin/focusout on the list, one each for the page's life |
| toast-ui.js:91 | list.addEventListener('focusin', () => pauseAll(true)) | (anonymous) | OK | pointerenter/pointerleave/focusin/focusout on the list, one each for the page's life |
| toast-ui.js:92 | list.addEventListener('focusout', (e) => { if (!e.relatedTar | (anonymous) | OK | pointerenter/pointerleave/focusin/focusout on the list, one each for the page's life |
| update-feed.js:176 | for await (const chunk of fs.createReadStream(filePath)) h.u |  | loop:SERIAL-REQUIRED | the hash is sequential; stream read of one AppImage (~125 MB) · 64 KB chunks · once per new version · ends at EOF |
| visualizer.html:151 | ipcRenderer.on('viz-bands', (e, b) => { bands = b; window.__ | module | OK | resize + ipcRenderer listeners below are added once at load and die with the window |
| visualizer.html:189 | ipcRenderer.on('viz-audio-state', (e, state) => { document.g | module | OK | added once at load, released with the window |
| visualizer.html:193 | ipcRenderer.on('viz-nowplaying', (e, s) => { | module | OK | added once at load, released with the window |
| visualizer.html:227 | ipcRenderer.on('lyrics-hdr', (e, s) => hdrGlow.set(s)) | module | OK | added once at load, released with the window |
| visualizer.html:230 | ipcRenderer.on('lyrics-data', (e, data) => lyricsView.setDat | module | OK | added once at load, released with the window |
| visualizer.html:231 | ipcRenderer.on('lyrics-time', (e, clock) => { lyricsView.set | module | OK | added once at load, released with the window |
| visualizer.html:232 | ipcRenderer.on('lyrics-refined', (e, msg) => lyricsView.refi | module | OK | added once at load, released with the window |
| visualizer.html:233 | ipcRenderer.on('lyrics-aligned', (e, msg) => lyricsView.alig | module | OK | added once at load, released with the window |
| visualizer.html:235 | ipcRenderer.on('lyrics-expr', (e, msg) => lyricsView.express | module | OK | added once at load, released with the window (as the lines above) |
| visualizer.html:236 | ipcRenderer.on('lyrics-stream', (e, msg) => lyricsView.strea | module | OK | added once at load, released with the window (as the lines above) |
| visualizer.html:238 | ipcRenderer.on('lyrics-align-state', (e, text) => lyricsView | module | OK | the lyrics feed's listeners, added once at load, released with the window |
| visualizer.html:244 | ipcRenderer.on('palette', (e, p) => { | module | OK | added once at load, released with the window |
| visualizer.html:260 | motionQuery.addEventListener('change', () => { pace = motion | module | OK | one change listener for the window's life |
| visualizer.html:275 | labelTimer = setTimeout(() => { labelEl.style.opacity = '0'  | showLabel | loop:NOT-WORTH | mode-label fade · 1400 ms one-shot · after a mode switch · cleared before re-arming · cost ~0 |
| visualizer.html:287 | document.onkeydown = (e) => { |  | OK | the page's key and click handlers, set once, released with the window |
| visualizer.html:293 | document.onclick = () => setMode(modeIdx + 1)   // click cyc |  | OK | the page's key and click handlers, set once, released with the window |
| visualizer.js:65 | const sink = execFileSync('pactl', ['get-default-sink'], { t |  | OK | execFileSync waits for pactl (2 s timeout) and leaves no process; once per fallback start |
| visualizer.js:133 | proc = this.spawn('parec', ['-d', monitor, '--format=s16le', | spawnMonitor [hot] | OK | the fallback parec (whole-system monitor): restarted with a backoff if it ends on its own |
| visualizer.js:153 | proc.on('error', (e) => { console.error('visualizer capture  | spawnMonitor [hot] | OK | 'error', 'exit' and 'data' listeners on the child, gone with it (stop() kills it) |
| visualizer.js:154 | proc.on('exit', (code, signal) => { console.error('visualize | spawnMonitor [hot] | OK | 'error', 'exit' and 'data' listeners on the child, gone with it (stop() kills it) |
| visualizer.js:155 | proc.stdout.on('data', (chunk) => { | spawnMonitor [hot] | OK | 'error', 'exit' and 'data' listeners on the child, gone with it (stop() kills it) |
| visualizer.js:171 | this.restartTimer = this.setTimeout(() => { | monitorEnded [hot] | OK | one restart timer at a time, cleared by stop(); the backoff ends after RESTART_MS.length tries |
