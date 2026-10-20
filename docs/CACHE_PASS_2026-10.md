# Cache pass: every kept state, with its key, invalidation and bound

_2026-10-19, Sonata QC phase part A, on branch `qc-passes` (origin/dev 0.15.69-dev.1, bd85dea). The DS5 configurator's pass pattern (its CLAUDE.md "Loop / Lifetime / Error / Cache pass"): a script lists every candidate, each one carries a verdict comment in the code, nothing is sampled by eye. No behaviour changed in this branch: only verdict comments, the lister and the gate. Marcy picks the fix batches (BACKLOG row "QC passes 2026-10: fix batches")._

## How the list was made

Two listers, both in `npm run gates`, `.hooks/pre-commit`, `npm test` and CI:

- `tools/verdicts.js` (since 0.15.37): line patterns over every shipped file (`build.files` `.js`, the pages' inline `<script>`s and the page scripts main.js sends into Apple's page as text). It gates every `for` / `while` / `do` / `.forEach`, every acquisition (timers, rAF, listeners, observers, child processes, windows/views/trays, sockets, streams, watchers, audio contexts, and now Web Animations `el.animate`, object URLs, power-save blockers and global shortcuts) and every `try/catch` / `.catch`.
- `tools/passes.js` (new, acorn 8.15.0 as an exact devDependency): parses every shipped file and lists what a line pattern can't see. Hot paths are resolved by function name across the shipped files from their roots (rAF / setInterval / re-arming setTimeout callbacks, high-rate events: parec `'data'`, `timeupdate`, pointer/mouse move, scroll, wheel, resize, `message`; functions named tick/frame/draw/paint/render/step/animate); a name resolves to the caller's own file first, else to its one definition. Gated: hot / awaiting / nested array callbacks; floating promises, `.then(ok, onRejected)`, `void` calls, `JSON.parse` outside a try; and every kept-state row (`// cache: VERDICT — key=…; invalidated=…; bound=…`). Doc-only rows: empty catches (they carry the verdicts.js verdict), clock comparisons (ttl), sync reads in loops (repeat-io), sync reads reached from a timer (poll-io), and the acquisition context. The page scripts inside main.js's template strings are text to acorn; verdicts.js covers them.

The verdicts were given by reading each row's code and callers (how often it really runs), in seven file groups. Name-resolved "hot" is an over-approximation by design: most rows reached from the 500 ms lyrics poll (main.js lyricsTick, `setInterval` every 500 ms) run once per track change, behind `if (key !== lyricsKey || retryDue)`, and their verdicts say so.

Invalidation was checked against what changes here: the song (key, ISRC), the album, the theme and album colour, the settings, the update channel and the helper (install, update, engine version).

## Fix candidates (by impact)

| # | Where | What | Impact | Verdict |
|---|---|---|---|---|
| C1 | `main.js:127` `lastPalette` and `main.js:2743` `lastBackdrop` | refreshPalette has no fetch generation: a slow artwork fetch for song A that finishes after song B's (a quick skip) leaves A's tint and Glass backdrop for the rest of B | visible, rare | **FIX-STALE** |
| C2 | `align-session.js:818` `noting` | a whole-song job with notes that is dropped (`prune`), skipped while gaming or after `s.failed` never calls `notesOn(s, false)` / `notes.failed`: the song says "measuring" for the rest of the session (also found by the bug hunt) | visible on slow PCs and while gaming; growth negligible | **FIX-STALE** |
| C3 | `main.js:652` `alignSession` engine version | read once when the session is created: after a helper Update in the same run, new aligned entries carry the old engine version (About → For the Curious shows it) | cosmetic, no growth | **FIX-STALE** |
| C4 | `montage-ui.js:47` `shades` | photo id → scrim alpha, cleared only by a theme push: with Adaptive album colour off it grows ~1 KB per new photo set until the theme changes | tiny | **FIX-UNBOUNDED** |
| C5 | `montage-store.js:75` | when `utimesSync` fails in `get()` the entry leaves the index but its bytes stay in `total`: pruning drops photos earlier than its byte bound needs (80 MB default) | small, only when files vanish behind the store | doc |
| C6 | `theme-apply.js:43` | the render key compares the backdrop by `url.length` + its luminances, not the URL: two different backdrops equal on all four skip the cross-fade | latent | doc (FIX-STALE, unlikely) |
| C7 | `liner-notes-model.js:193` | `deps.store.set` runs before `inflight.delete`: a throwing `set` would leave the album's rejected job in `inflight`, and every later load of that album rejects unhandled | unlikely | doc |

The doc-only rows (ttl, repeat-io, poll-io) carry no comment. Their verdict: **NOT-WORTH / OK** for all of them. The poll-io rows reached from the lyrics poll go through `alignInstalled()`, which is memoised (`alignPaths`, rechecked only on install changes); game-guard's /proc and DRM reads run every 5 s only while precise timing has work (measured in game-guard.js); audio-listen's /proc walk runs when a listener starts; integrateAppImage / applyAutostart / the update verify run on an install; the curious sampler only while For the Curious is open; ttl rows are the documented throttles (engine feed 30 min, montage freshness, seek holds).

## Fixed on branch qc-fixes (2026-10-19, Marcy approved the four batches)

| # | What | Commit |
|---|---|---|
| C1 | refreshPalette drops a late artwork fetch for another track | 867a20f |
| C2 | align-session `noting`: a job that never runs clears it (never()) | 952c4a0 |
| C5 | montage-store: a vanished photo's bytes leave the total | 83c9319 |

## Counts

| Verdict | Rows |
|---|---|
| (doc only) | 59 |
| FIX-STALE | 1 |
| FIX-UNBOUNDED | 1 |
| NOT-WORTH | 30 |
| OK | 61 |
| **total** | 152 |

## Flagged rows (fix candidates, as the comments say)

| file:line | what | trigger / context | verdict | reason |
|---|---|---|---|---|
| main.js:652 | module | alignSession (lazy init) | FIX-STALE | key=none; invalidated=never (engine version fixed at creation); bound=one session |
| montage-ui.js:47 | closure | shades | FIX-UNBOUNDED | key=photo id; invalidated=theme push (per track w/ album colour); bound=none if off, ~1 KB/set |

## Every row

| file:line | what | trigger / context | verdict | reason |
|---|---|---|---|---|
| align-helper.js:44 | poll-io | readFileSync in setInterval@main.js:3745 → checkEngineFeed → enginePin |  |  |
| align-helper.js:147 | poll-io | accessSync in setInterval@main.js:1364 → preciseTimingOn → alignInstalled → isInstalled |  |  |
| align-helper.js:147 | poll-io | accessSync in setInterval@main.js:1364 → preciseTimingOn → alignInstalled → isInstalled |  |  |
| align-helper.js:166 | poll-io | lstatSync in setInterval@main.js:1364 → preciseTimingOn → alignInstalled → checkInstall |  |  |
| align-helper.js:171 | poll-io | realpathSync in setInterval@main.js:1364 → preciseTimingOn → alignInstalled → checkInstall |  |  |
| align-helper.js:172 | poll-io | accessSync in setInterval@main.js:1364 → preciseTimingOn → alignInstalled → checkInstall |  |  |
| align-helper.js:176 | poll-io | readFileSync in setInterval@main.js:1364 → preciseTimingOn → alignInstalled → checkInstall |  |  |
| align-helper.js:188 | poll-io | accessSync in setInterval@main.js:1364 → preciseTimingOn → alignInstalled → checkInstall |  |  |
| align-helper.js:245 | module | live (Set) | OK | key=a spawned helper child; invalidated=gone() on its exit or error; bound=one helper (two while an old one quits) |
| align-helper.js:342 | closure | pending | OK | key=job id; invalidated=done/fail (result, error, timeout via touch, exit via gone); bound=jobs in flight (≤ ~3) |
| align-helper.js:349 | closure | stderrTail | OK | key=none (the helper's last stderr lines); invalidated=reset at each spawn; bound=20 lines of ≤ one chunk each |
| align-session.js:251 | closure | blocks | OK | key=10 s block index; invalidated=clear() in wrapUp (every finish/stop path); bound=90 × 882 KB (79 MB) |
| align-session.js:696 | closure | rows | NOT-WORTH | key=none (a local array returned per call); invalidated=new each call; bound=the song's syllables |
| align-session.js:846 | closure | noting | OK | key=the song's lyrics key; invalidated=its notes job ends, or submit()'s job never runs (dropped, paused, s.failed: never()); bound=the jobs queued |
| apple-focus.js:76 | closure | hooked | OK | key=Apple's volume control element; invalidated=GC'd with the element (WeakSet); bound=live controls (1–2) |
| audio-listen.js:97 | poll-io | readdirSync in setInterval@main.js:2989 → … → ownProcessTree → readChildren |  |  |
| audio-listen.js:98 | repeat-io | readFileSync |  |  |
| audio-listen.js:98 | poll-io | readFileSync in setInterval@main.js:2989 → … → ownProcessTree → readChildren |  |  |
| audio-listen.js:108 | poll-io | readdirSync in setInterval@main.js:2989 → … → ownProcessTree → scanProc |  |  |
| audio-listen.js:111 | repeat-io | readFileSync |  |  |
| audio-listen.js:111 | poll-io | readFileSync in setInterval@main.js:2989 → … → ownProcessTree → scanProc |  |  |
| audio-listen.js:148 | module | liveProcs (Set) | OK | key=parec child; invalidated=deleted on child 'exit' or watchdog switch; bound=≤ 2 live parecs |
| audio-listen.js:326 | closure | users | OK | key=handle object; invalidated=stop() deletes it (each startListening makes a new one); bound=≤ 3 users |
| cpu-sampler.js:26 | closure | readings | OK | key=reading time; invalidated=pruned to WINDOW_MS (+1) per sample, reset after a 15 s gap; bound=≤ ~61 readings |
| curious-sampler.js:146 | repeat-io | readdirSync |  |  |
| curious-sampler.js:146 | poll-io | readdirSync in setInterval@main.js:2989 → … → createCuriousSampler → notesDoc |  |  |
| curious-sampler.js:151 | poll-io | statSync in setInterval@main.js:2989 → … → createCuriousSampler → notesDoc |  |  |
| curious-sampler.js:155 | poll-io | readFileSync in setInterval@main.js:2989 → … → createCuriousSampler → notesDoc |  |  |
| dbus-wire.js:295 | field | pending | OK | key=call serial; invalidated=deleted on reply or timeout, cleared on shut(); bound=calls in flight (a few) |
| game-guard.js:95 | closure | off | OK | key=probe name (gamemode, nvidia); invalidated=never: a missing tool stays off for the run (by design); bound=2 names |
| game-guard.js:110 | repeat-io | readdirSync |  |  |
| game-guard.js:110 | poll-io | readdirSync in setInterval@main.js:1364 → alignGuardTick → linuxProbes → steam |  |  |
| game-guard.js:118 | repeat-io | readFileSync |  |  |
| game-guard.js:118 | poll-io | readFileSync in setInterval@main.js:1364 → alignGuardTick → linuxProbes → steam |  |  |
| game-guard.js:123 | repeat-io | readFileSync |  |  |
| game-guard.js:123 | poll-io | readFileSync in setInterval@main.js:1364 → alignGuardTick → linuxProbes → steam |  |  |
| game-guard.js:132 | repeat-io | readdirSync |  |  |
| game-guard.js:132 | poll-io | readdirSync in setInterval@main.js:1364 → alignGuardTick → linuxProbes → amd |  |  |
| game-guard.js:137 | repeat-io | readFileSync |  |  |
| game-guard.js:137 | poll-io | readFileSync in setInterval@main.js:1364 → alignGuardTick → linuxProbes → amd |  |  |
| game-guard.js:139 | repeat-io | readFileSync |  |  |
| game-guard.js:139 | poll-io | readFileSync in setInterval@main.js:1364 → alignGuardTick → linuxProbes → amd |  |  |
| gpu-detect.js:33 | poll-io | readdirSync in setInterval@main.js:2989 → … → gpuScan → scanSysfs |  |  |
| gpu-detect.js:34 | poll-io | readFileSync in setInterval@main.js:2989 → … → scanSysfs → read |  |  |
| lastfm.js:149 | closure | seen | OK | key=artist+title+start time; invalidated=cleared and rebuilt by keep() on every queue change; bound=QUEUE_MAX (500) |
| liner-notes-model.js:83 | closure | inflight | OK | key=album:id:lang (+'\|mb'); invalidated=deleted when its refresh settles; bound=albums fetching now (1-2) |
| liner-notes-model.js:387 | closure | people | NOT-WORTH | key=performer name; invalidated=local to one buildBooklet call, dropped on return; bound=album's performers |
| liner-notes-model.js:389 | closure | crew | NOT-WORTH | key=crew role; invalidated=local to one buildBooklet call, dropped on return; bound=album's roles (tens) |
| liner-notes-sources.js:60 | closure | lanes | OK | key=host; invalidated=never (order + last time only); bound=≤ ~6 hosts (MB, CAA, WD, setlist, wikis) |
| liner-notes-sources.js:238 | closure | places | NOT-WORTH | key=place id; invalidated=local to one reduceRelease call, freed on return; bound=the release's places (≤ ~10) |
| liner-notes-sources.js:310 | closure | seen | NOT-WORTH | key=name\|role; invalidated=local to one dedupe call, freed on return; bound=the list (≤ ~200) |
| liner-notes.html:268 | module | discs (Map) | OK | key=disc scan URL; invalidated=window closed; bound=≤ 1 per album shown while open, ~100 B each |
| liner-notes.html:270 | module | discImgs (Map) | OK | key=disc image URL; invalidated=cleared on every tray page built; bound=1 img |
| liner-notes.html:274 | module | spreads (array) | OK | key=none (the spreads of this layout); invalidated=rebuilt each layout; bound=pages/2 (≤ ~20) |
| liner-notes.html:760 | module | sungAt (lazy init) | OK | key=the marked line element; invalidated=clearSung on each new line or song; bound=1 ref |
| liner-notes.html:845 | module | lastSize (memo name) | OK | key=stage size; invalidated=each resize that relays out (a data relayout doesn't set it); bound=1 number |
| listen-session.js:124 | closure | onsets | OK | key=song time; invalidated=reset on gap/seek/song, pruned to KEEP_EVIDENCE 30 s each tick; bound=≤ ~375 |
| listen-session.js:126 | closure | voiced | OK | key=song time; invalidated=reset on gap/seek/song, pruned to 30 s each tick; bound=≤ ~30 spans |
| lyrics-shorthand.js:103 | closure | blocks | NOT-WORTH | key=block name; invalidated=a new Map per call; bound=the song's labels (once per lyrics lookup) |
| lyrics-shorthand.js:105 | closure | out | NOT-WORTH | key=line order; invalidated=a new array per call; bound=the written-out lines (≤ ~150 x MAX_TIMES) |
| lyrics-shorthand.js:168 | closure | out | NOT-WORTH | key=stanza index; invalidated=a new array per call; bound=the song's stanzas |
| lyrics-sources.js:484 | closure | cache | OK | key=trackKey (recording); invalidated=failures dropped, none-both after NONE_TTL_MS; bound=50 (FIFO), ≤ ~50 KB each |
| lyrics-sources.js:486 | closure | noneAt | OK | key=trackKey; invalidated=TTL on next lookup, deleted with its cache entry on eviction; bound=≤ 50 like cache |
| lyrics-syllables.js:38 | module | hyphenators (Map) | OK | key=pattern file; invalidated=never (pure, fixed patterns); bound=languages met (a few) |
| lyrics-view.js:497 | closure | lines | OK | key=line index; invalidated=replaced on setData/refine/align/stream; bound=the song's lines (≤ ~150) |
| lyrics-view.js:499 | closure | lineEls | OK | key=line index; invalidated=reset in setData (new song or layout); bound=the song's lines |
| lyrics-view.js:503 | closure | interludes | OK | key=countdown order; invalidated=reset in setData; bound=the song's interludes (a few) |
| lyrics-view.js:554 | closure | spans | NOT-WORTH | key=word index; invalidated=new array per line laid out, .fit dropped on resize; bound=its words |
| lyrics-view.js:1738 | ttl |  |  |  |
| main.js:80 | module | locale (read from I/O) | NOT-WORTH | key=none (the locale at start); invalidated=never (a restart); bound=one string |
| main.js:88 | module | lyricsPoll (lazy init) | NOT-WORTH | key=none (the poll handle); invalidated=cleared when the last view closes; bound=one |
| main.js:94 | module | lyricsTries (Map) | OK | key=recording key; invalidated=deleted on success, oldest dropped; bound=200 songs (~60 B) |
| main.js:100 | module | lastfm (memo name) | NOT-WORTH | key=none (the one LastFm client); invalidated=never; bound=one object |
| main.js:102 | module | scrobbleQueue (read from I/O) | OK | key=none (lastfm-pending.json); invalidated=its own atomic saves; bound=QUEUE_MAX 500 |
| main.js:104 | module | scrobbleState (lazy init) | OK | key=title+artist; invalidated=a new track; bound=one object |
| main.js:106 | module | discord (lazy init) | NOT-WORTH | key=none (the presence client); invalidated=replaced on reconnect/disconnect; bound=one |
| main.js:108 | module | discordConfig (read from I/O) | OK | key=none (discord.json); invalidated=read again on Connect; bound=one small object |
| main.js:116 | module | lastPresenceKey (memo name) | OK | key=title\|artist\|end/5 s; invalidated=track change, seek, reconnect; bound=one string |
| main.js:120 | module | visualizer (lazy init) | NOT-WORTH | key=none (the open visualizer's FFT); invalidated=nulled on 'closed'; bound=one |
| main.js:127 | module | lastPalette (memo name) | OK | key=title\|artist; invalidated=next track (a fetch for an earlier track is dropped: lastPaletteKey check); bound=one object |
| main.js:129 | module | lastPaletteKey (memo name) | OK | key=title\|artist; invalidated=a new track, adaptive colour toggled; bound=one string |
| main.js:132 | module | notifyKey (lazy init) | OK | key=title\|artist; invalidated=each track change; bound=one string |
| main.js:212 | module | kdeScheme (read from I/O) | OK | key=none (kdeglobals); invalidated=read again at each readDesktopScheme; bound=one value |
| main.js:214 | module | schemeWatch (lazy init) | NOT-WORTH | key=none (the gdbus monitor child); invalidated=nulled on exit or stop; bound=one |
| main.js:231 | poll-io | readFileSync in setInterval@main.js:2989 → … → watchDesktopScheme → readDesktopScheme |  |  |
| main.js:646 | module | alignPaths (lazy init) | OK | key=env + app dir; invalidated=alignInstalled(true) (start, Settings, a job); bound=one |
| main.js:650 | module | alignHelper (lazy init) | NOT-WORTH | key=none (one helper client, reads alignPaths in place); invalidated=never; bound=one |
| main.js:652 | module | alignSession (lazy init) | FIX-STALE | key=none; invalidated=never (engine version fixed at creation); bound=one session |
| main.js:761 | module | notesSwitch (lazy init) | NOT-WORTH | key=none (one notes switch); invalidated=never; bound=one object |
| main.js:815 | module | sheetStore (lazy init) | NOT-WORTH | key=none (one store; disk ≤ MAX_FILES); invalidated=never; bound=one object |
| main.js:1048 | module | firstPlay (lazy init) | OK | key=the song's lyrics key; invalidated=a section of another song, the whole-song pass; bound=one song's sections (≤ ~60 parts) |
| main.js:1147 | module | gameGuard (lazy init) | NOT-WORTH | key=none (one game guard); invalidated=reset when the setting goes off; bound=one |
| main.js:1220 | module | lookahead (lazy init) | NOT-WORTH | key=none (one look-ahead controller); invalidated=never; bound=one |
| main.js:1227 | poll-io | accessSync in setInterval@main.js:1364 → … → helperPaths → exists |  |  |
| main.js:1399 | ttl |  |  |  |
| main.js:1502 | ttl |  |  |  |
| main.js:1599 | module | stageCreditsAsked (Set) | OK | key=album id; invalidated=cleared past 500; bound=500 ids (~20 B each) |
| main.js:1803 | module | stageReread (lazy init) | NOT-WORTH | key=none (the pending re-read timer); invalidated=fires or a new write; bound=one |
| main.js:1923 | module | montageCache (memo name) | OK | key=song/set/px; invalidated=30 d / 3 d freshness; bound=1500 entries, 4 MB |
| main.js:1926 | module | montageFetch (lazy init) | NOT-WORTH | key=none (one fetcher, made on first use); invalidated=never; bound=one |
| main.js:2008 | ttl |  |  |  |
| main.js:2093 | module | coverWindow (lazy init) | NOT-WORTH | key=none (the open lightbox); invalidated=nulled on 'closed'; bound=one window |
| main.js:2184 | module | linerPoll (lazy init) | NOT-WORTH | key=none (the poll handle); invalidated=cleared in syncLinerPoll; bound=one |
| main.js:2187 | module | linerSung (lazy init) | OK | key=title\|artist; invalidated=a new song, booklet closed; bound=≤ ~150 line times |
| main.js:2281 | module | linerDiscAsking (Set) | OK | key=scan URL; invalidated=deleted when its lookup ends (finally); bound=≤ ~4 in flight |
| main.js:2827 | module | lastBackdrop (memo name) | OK | key=the palette's track; invalidated=with lastPalette (a late fetch for another track is dropped); bound=2 × ~3 KB |
| main.js:3228 | module | recoveredAside (object) | OK | key=what (settings \| lyrics); invalidated=a new recovery; bound=2 paths |
| main.js:3236 | module | appleRetryTimer (lazy init) | NOT-WORTH | key=the pending retry; invalidated=a load (appleLoaded) or the next failure; bound=one timer |
| main.js:3489 | repeat-io | readdirSync |  |  |
| main.js:3489 | poll-io | readdirSync in setInterval@main.js:2356 → linerPlaying → has |  |  |
| main.js:3491 | poll-io | readdirSync in setInterval@main.js:1364 → preciseTimingOn → alignInstalled → helperScan |  |  |
| main.js:3494 | poll-io | readFileSync in setInterval@main.js:1364 → preciseTimingOn → alignInstalled → helperScan |  |  |
| main.js:3516 | module | cpuMaker (lazy init) | OK | key=none (the processor doesn't change while Sonata runs); invalidated=never; bound=one string |
| main.js:3723 | ttl |  |  |  |
| main.js:3906 | module | focusCode (read from I/O) | OK | key=none (two shipped files); invalidated=never (shipped); bound=one string (tens of KB) |
| main.js:4013 | module | aboutCache (memo name) | OK | key=none (CHANGELOG, BACKLOG, install); invalidated=nulled after a helper job; bound=one |
| main.js:4096 | poll-io | readFileSync in setInterval@main.js:2989 → … → aboutData → read |  |  |
| main.js:4244 | module | curious (lazy init) | NOT-WORTH | key=none (one sampler, made on first open); invalidated=never; bound=one |
| main.js:4275 | repeat-io | statSync |  |  |
| main.js:4869 | module | lastPlaying (memo name) | OK | key=none (the last poll's isPlaying); invalidated=each now-playing poll; bound=one boolean |
| main.js:4893 | module | lastInstallFailure (memo name) | OK | key=version; invalidated=a ready install replaces it; bound=one object |
| main.js:5008 | repeat-io | execFileSync |  |  |
| main.js:5125 | poll-io | readFileSync in setInterval@main.js:1364 → … → stageCredits → load |  |  |
| miniplayer.html:346 | module | lastVolume (memo name) | NOT-WORTH | key=none (the volume before mute); invalidated=each volume change; bound=one number |
| miniplayer.html:427 | ttl |  |  |  |
| miniplayer.html:431 | ttl |  |  |  |
| model-fetch.js:43 | poll-io | statSync in setInterval@main.js:3745 → … → complete → sizeOf |  |  |
| model-fetch.js:159 | poll-io | readFileSync in setInterval@main.js:3745 → … → helperModels → fetchModel |  |  |
| montage-sources.js:54 | closure | lanes | OK | key=host; invalidated=never (lane order and last time only); bound=≤ 3 hosts (Wikidata, Commons, upload) |
| montage-sources.js:317 | closure | seen | NOT-WORTH | key=photo id; invalidated=local to one arrange call, freed on return; bound=≤ ~150 candidates |
| montage-store.js:43 | repeat-io | statSync |  |  |
| montage-ui.js:43 | closure | slot | OK | key=layer index (2); invalidated=reset on a new photo set and a reduced-motion change; bound=2 |
| montage-ui.js:47 | closure | shades | FIX-UNBOUNDED | key=photo id; invalidated=theme push (per track w/ album colour); bound=none if off, ~1 KB/set |
| montage-ui.js:182 | ttl |  |  |  |
| notes-log.js:141 | poll-io | readdirSync in setInterval@main.js:1364 → … → prune → listLogs |  |  |
| notes-log.js:147 | repeat-io | statSync |  |  |
| notes-log.js:147 | poll-io | statSync in setInterval@main.js:1364 → … → prune → listLogs |  |  |
| notes-log.js:158 | poll-io | readdirSync in setInterval@main.js:1364 → … → writeLog → prune |  |  |
| panel-ui.js:322 | closure | made | OK | key=readout row id; invalidated=cleared when the row id list changes; bound=≤ ~25 rows, dropped with the body |
| portal-shortcuts.js:40 | closure | paths | OK | key=request path / portal handle; invalidated=dropped with the request when answered; bound=2 |
| preload-panel.js:10 | module | last (memo name) | OK | key=none (main's latest panel state); invalidated=replaced on each 'panel:state'; bound=one object |
| preload-rail-view.js:9 | module | last (memo name) | OK | key=none (main's latest rail state); invalidated=replaced on each 'rail:state'; bound=one object |
| rail-ui.js:35 | closure | buttons | NOT-WORTH | key=roving focus index; invalidated=never (built once at load); bound=9 buttons |
| sheet-notes-model.js:754 | closure | open | NOT-WORTH | key=ledger pos; invalidated=cleared per run, local to one roomRuns call; bound=a few ledger positions |
| sheet-notes-store.js:46 | poll-io | readFileSync in setInterval@main.js:1364 → … → missing → get |  |  |
| shortcuts-model.js:182 | closure | last | OK | key=action id; invalidated=overwritten per press; bound=4 ids (fire() checks M.IDS first) |
| shortcuts.js:26 | closure | taken | OK | key=action id; invalidated=reset by x11Off() before each x11On(); bound=4 actions |
| theme-apply.js:26 | closure | written | OK | key=token name; invalidated=overwritten when a token's value changes; bound=~28 tokens |
| toast-ui.js:19 | closure | timers | OK | key=toast id; invalidated=render deletes ids no longer shown, timer cleared; bound=toasts shown (≤ 3) |
| update-feed.js:169 | poll-io | statSync in setInterval@main.js:3745 → … → verify → verifyDownload |  |  |
| visualizer.html:149 | module | shown (array) | OK | key=band index; invalidated=re-sliced when the band count changes; bound=band count (~48) |
| visualizer.html:306 | module | barPaint (lazy init) | OK | key=band count; invalidated=rebuilt when it changes (fixed stage colours); bound=one set, 2 per band |
