# Loop pass: every loop and hot array callback, with a verdict

_2026-10-19, Sonata QC phase part A, on branch `qc-passes` (origin/dev 0.15.69-dev.1, bd85dea). The DS5 configurator's pass pattern (its CLAUDE.md "Loop / Lifetime / Error / Cache pass"): a script lists every candidate, each one carries a verdict comment in the code, nothing is sampled by eye. No behaviour changed in this branch: only verdict comments, the lister and the gate. Marcy picks the fix batches (BACKLOG row "QC passes 2026-10: fix batches")._

## How the list was made

Two listers, both in `npm run gates`, `.hooks/pre-commit`, `npm test` and CI:

- `tools/verdicts.js` (since 0.15.37): line patterns over every shipped file (`build.files` `.js`, the pages' inline `<script>`s and the page scripts main.js sends into Apple's page as text). It gates every `for` / `while` / `do` / `.forEach`, every acquisition (timers, rAF, listeners, observers, child processes, windows/views/trays, sockets, streams, watchers, audio contexts, and now Web Animations `el.animate`, object URLs, power-save blockers and global shortcuts) and every `try/catch` / `.catch`.
- `tools/passes.js` (new, acorn 8.15.0 as an exact devDependency): parses every shipped file and lists what a line pattern can't see. Hot paths are resolved by function name across the shipped files from their roots (rAF / setInterval / re-arming setTimeout callbacks, high-rate events: parec `'data'`, `timeupdate`, pointer/mouse move, scroll, wheel, resize, `message`; functions named tick/frame/draw/paint/render/step/animate); a name resolves to the caller's own file first, else to its one definition. Gated: hot / awaiting / nested array callbacks; floating promises, `.then(ok, onRejected)`, `void` calls, `JSON.parse` outside a try; and every kept-state row (`// cache: VERDICT — key=…; invalidated=…; bound=…`). Doc-only rows: empty catches (they carry the verdicts.js verdict), clock comparisons (ttl), sync reads in loops (repeat-io), sync reads reached from a timer (poll-io), and the acquisition context. The page scripts inside main.js's template strings are text to acorn; verdicts.js covers them.

The verdicts were given by reading each row's code and callers (how often it really runs), in seven file groups. Name-resolved "hot" is an over-approximation by design: most rows reached from the 500 ms lyrics poll (main.js lyricsTick, `setInterval` every 500 ms) run once per track change, behind `if (key !== lyricsKey || retryDue)`, and their verdicts say so.

## Fix candidates (by impact; none is a FIX-HOT-PATH row, these are the costs the sweep measured by reading)

| # | Where | What | Impact | Suggested verdict |
|---|---|---|---|---|
| L1 | `hdr-glow.js` `draw` (the `HOT-ALLOC` comment at :151) | Per sung word / syllable while HDR glow is on: a probe canvas, 2 paint canvases and 2 `getImageData` readbacks | ~64 KB (DPR 1) to ~256 KB (DPR 2) of garbage per word, a few words a second while singing; GC churn on the laptop | HOT-ALLOC (marked) |
| L2 | `main.js` `pushPanel` (:4198) from the 5 s now-playing loop | Once the panel has been opened, every 5 s tick builds and `JSON.stringify`s the panel snapshot, also while the window is in the tray; after About was opened the snapshot carries the About texts (CHANGELOG + BACKLOG, ~210 KB) and `lookaheadAvail()` does 2-4 `fs.accessSync` | ~1-2 ms of main-process CPU and ~0.4 MB of strings every 5 s, forever, hidden included ("nothing runs while hidden") | WASTE |
| L3 | `main.js` `sendSheet` (:952) with `firstPlaySection` (:1040) | With look-ahead every streamed line pushes one pitch piece and the whole `sheet.pitch` array is re-sent | IPC per song ∝ lines²: a 60-line song sends ~1,800 pieces instead of 60; bounded per song | FIX-HOT-PATH (per line, not per frame) |
| L4 | `lyrics-view.js` `applyExpr` (:866) | After the final expression pass, every line on screen is deferred and the whole pass (`X.lineExpressions` per line, ~150 × 600 comparisons, a `JSON.stringify` and a layout read per changed line) repeats at each line boundary until they scroll off | ~1-3 ms per line boundary while the lyrics window shows | HOT-PATH-OK today; worth a look |
| L5 | `audio-listen.js` `toMidSide` → `listen-session.js` interleave → `vocal-detect.js` split | Each parec chunk (~50/s) is split to mid/side, re-interleaved, then split again | ~350 KB/s short-lived garbage while listening | clean-up |

Everything else in the hot set is bounded and small (N stated in each comment): the 0.25 s look-ahead 'words' messages (≤ 15 words), the game-guard /proc scan every 5 s while precise timing has work (~800 entries, documented in game-guard.js), the For the Curious refresh while it is open, the vocal detector's medians (~11 sorts/s of ≤ 345 floats).

## Counts

| Verdict | Rows |
|---|---|
| HOT-PATH-OK | 164 |
| NOT-WORTH | 859 |
| SERIAL-REQUIRED | 20 |
| **total** | 1043 |

## Flagged rows (fix candidates, as the comments say)

None.

## Every row

_Generated: `node tools/passes.js --md DIR` writes these tables. Line numbers are those of the commit that adds this file._

| file:line | what | trigger / context | verdict | reason |
|---|---|---|---|---|
| about-data.js:18 | forof |  | NOT-WORTH | one pass over CHANGELOG.md's lines (~300), when About opens |
| about-data.js:30 | .map | nested | NOT-WORTH | ≤ ~40 sections |
| about-data.js:48 | forof |  | NOT-WORTH | one pass over BACKLOG.md's rows (~130), when About opens |
| about-data.js:51 | .map | nested | NOT-WORTH | once per run (aboutCache), BACKLOG rows (~130) × cells (3-4) |
| about-data.js:156 | .map | nested | NOT-WORTH | once per run (aboutCache), 3 groups × Soon items (tens) |
| align-helper.js:60 | .some | hot(setInterval@main.js:1284 → … → helperPaths → inAppSandbox) | NOT-WORTH | 5 roots · per helperPaths/checkInstall (start, Settings asks), never per tick |
| align-helper.js:85 | for | hot(setInterval@main.js:1284 → … → helperPaths → olderEngine) | NOT-WORTH | 4 fields |
| align-helper.js:211 | forof | hot(setInterval@main.js:1284 → … → createAlignHelper → helperEnv) | NOT-WORTH | six names, once per helper spawn |
| align-helper.js:218 | forof | hot(setInterval@main.js:1284 → … → createAlignHelper → helperEnv) | NOT-WORTH | four names, once per helper spawn |
| align-helper.js:231 | forof |  | HOT-PATH-OK | one pass over the complete lines in this chunk (a few messages) · ends with the chunk |
| align-helper.js:246 | forof |  | NOT-WORTH | at most one live helper |
| align-helper.js:265 | .map | hot(setInterval@main.js:1284 → … → createAlignHelper → cpuThreadsFor) | NOT-WORTH | the allowed CPUs (≤ a few dozen) · once per helper spawn |
| align-helper.js:276 | forof | hot(setInterval@main.js:1284 → … → createAlignHelper → allowedCpus) | NOT-WORTH | a few ranges, once per helper spawn |
| align-helper.js:278 | .map | hot(setInterval@main.js:1284 → … → createAlignHelper → allowedCpus) | NOT-WORTH | the allowed CPUs (≤ a few dozen), once per helper spawn |
| align-helper.js:286 | .map | hot(setInterval@main.js:1284 → … → createAlignHelper → allowedCpus) | NOT-WORTH | os.cpus() (≤ a few dozen) · once per helper spawn, only without /proc |
| align-helper.js:302 | .filter | hot(setInterval@main.js:1284 → … → createAlignHelper → wantFor) | NOT-WORTH | ≤ 3 wanted features · once per notes job or stream start |
| align-helper.js:310 | forof | hot(setInterval@main.js:1284 → … → givenNotes → withWant) | SERIAL-REQUIRED | the job's messages in protocol order (passes write()'s pacing through) |
| align-helper.js:447 | forof | hot('data'@align-helper.js:446) | HOT-PATH-OK | the lines of one stderr chunk (a few), kept to the last 20 |
| align-helper.js:474 | forof | hot(setInterval@main.js:1284 → … → createAlignHelper → gone) | NOT-WORTH | the pending jobs (1-2) |
| align-helper.js:508 | forof | await hot(setInterval@main.js:1284 → … → forget → write) | SERIAL-REQUIRED | one pipe, messages in protocol order, waiting for drain |
| align-session.js:71 | .map | hot(setInterval@main.js:1284 → entryFor → lyricsHash) | NOT-WORTH | the song's lines (tens) · per track change (entryFor, setLyrics, prepareLines), not per tick |
| align-session.js:73 | for | hot(setInterval@main.js:1284 → entryFor → lyricsHash) | NOT-WORTH | one pass over the lyrics' characters (a few KB) · per track change |
| align-session.js:91 | .map | hot(setInterval@main.js:1284 → untimed) | NOT-WORTH | the song's lines (tens) · once per track change, only for lyrics timed for another version |
| align-session.js:101 | .some | hot(setInterval@main.js:1284 → getAlignSession → createAlignSession → canAlignPlain) | NOT-WORTH | stops at the first line with words · per track change (setLyrics plain path) |
| align-session.js:117 | .map | hot(setInterval@main.js:1284 → prepareLines → plainTimed) | NOT-WORTH | the song's lines (tens) · per track change, only with a plain entry |
| align-session.js:123 | .filter | hot(setInterval@main.js:1284 → prepareLines → plainTimed) | NOT-WORTH | the song's lines (tens) · per track change, only with a plain entry |
| align-session.js:123 | .map | hot(setInterval@main.js:1284 → prepareLines → plainTimed) nested | NOT-WORTH | the song's lines (tens) · per track change, only with a plain entry |
| align-session.js:125 | .filter | hot(setInterval@main.js:1284 → prepareLines → plainTimed) | NOT-WORTH | the song's lines (tens) · per track change, only with a plain entry |
| align-session.js:128 | .map | hot(setInterval@main.js:1284 → prepareLines → plainTimed) | NOT-WORTH | the song's lines (tens) · per track change, only with a plain entry |
| align-session.js:133 | for | hot(setInterval@main.js:1284 → prepareLines → plainTimed) | NOT-WORTH | the song's lines, once per track change |
| align-session.js:134 | for | hot(setInterval@main.js:1284 → prepareLines → plainTimed) | NOT-WORTH | the song's lines, once per track change |
| align-session.js:136 | for | hot(setInterval@main.js:1284 → prepareLines → plainTimed) | NOT-WORTH | the aligned lines and the runs between them, once per track change |
| align-session.js:139 | for | hot(setInterval@main.js:1284 → prepareLines → plainTimed) nested | NOT-WORTH | the aligned lines and the runs between them, once per track change |
| align-session.js:142 | .map | hot(setInterval@main.js:1284 → prepareLines → plainTimed) | NOT-WORTH | the song's lines (tens) · per track change, only with a plain entry |
| align-session.js:154 | .some | hot(setInterval@main.js:1284 → getAlignSession → createAlignSession → canAlign) | NOT-WORTH | stops at the first line with words · per track change (setLyrics) |
| align-session.js:172 | .filter | hot(setInterval@main.js:1284 → setSheetSong → lyricSpan) | NOT-WORTH | the song's lines (tens) · once per track change (setLyrics) |
| align-session.js:182 | .every | hot(setInterval@main.js:1284 → entryFor → validEntry → noHyphenRuns) | NOT-WORTH | the song's lines (tens), only for a version-2 entry · per track change (validEntry) |
| align-session.js:200 | .map | hot(setInterval@main.js:1284 → prepareLines → applyAligned) | NOT-WORTH | the song's lines × their words (hundreds) · once per track change or resend (prepareLines) |
| align-session.js:258 | forof | hot(setInterval@main.js:1284 → … → write → addCovered) | HOT-PATH-OK | merge into the sorted span list · per chunk (~50/s) · a handful of spans (one per seek) |
| align-session.js:282 | for | hot(setInterval@main.js:1284 → getAlignSession → createAlignSession → write) | HOT-PATH-OK | one pass over the chunk's frames (~440 per 20 ms chunk) · ends with the chunk |
| align-session.js:300 | forof | hot(tick()@align-session.js:1361 → due → coverage) | HOT-PATH-OK | the heard spans (a handful, one per seek), per section check |
| align-session.js:313 | forof | hot(draw()@hdr-glow.js:141 → submit → pcm) | NOT-WORTH | copy the recorded blocks that overlap · once per alignment · ≤ 90 blocks |
| align-session.js:332 | for | hot(setInterval@main.js:1284 → getAlignSession → createAlignSession → toS16) | HOT-PATH-OK | one pass over the chunk's frames (~440 per 20 ms chunk) while a look-ahead song plays |
| align-session.js:350 | forof | hot(setInterval@main.js:1284 → getAlignSession → createAlignSession → streamedMessage) | NOT-WORTH | the lines of one 'words' message (one or two per hop) |
| align-session.js:356 | .map | hot(setInterval@main.js:1284 → getAlignSession → createAlignSession → streamedMessage) nested | HOT-PATH-OK | one line's words (≤ ~15) · per stream 'words' message (one per 0.25 s hop) while a look-ahead song plays |
| align-session.js:377 | .map | hot(draw()@hdr-glow.js:141 → submit → requestLines) | NOT-WORTH | the song's or section's lines (tens) · once per helper job (submit/stream), not per frame |
| align-session.js:399 | for | hot(draw()@hdr-glow.js:141 → submit → alignMessages) | SERIAL-REQUIRED | the helper reads its stdin in order; one message per 256 KB of PCM · ≤ ~330 for a 15 min song · ends with the buffer |
| align-session.js:419 | forof | hot(draw()@hdr-glow.js:141 → submit → entryFromResult) | NOT-WORTH | the helper's lines (tens), once per alignment result |
| align-session.js:430 | .some | hot(draw()@hdr-glow.js:141 → submit → entryFromResult) nested | NOT-WORTH | one line's words (≤ ~15) · once per alignment result |
| align-session.js:434 | .map | hot(draw()@hdr-glow.js:141 → submit → entryFromResult) nested | NOT-WORTH | one line's words (≤ ~15) · once per alignment result |
| align-session.js:462 | .filter | hot(draw()@hdr-glow.js:141 → submit → entryFromResult) | NOT-WORTH | the song's lines (tens) · once per alignment result |
| align-session.js:480 | .map | hot(draw()@hdr-glow.js:141 → submit → entryFromResult → jobSeconds) | NOT-WORTH | 3 stats fields · once per alignment result |
| align-session.js:482 | .reduce | hot(draw()@hdr-glow.js:141 → submit → entryFromResult → jobSeconds) | NOT-WORTH | ≤ 3 numbers · once per alignment result |
| align-session.js:502 | .map | hot(draw()@hdr-glow.js:141 → submit → rejectedNote) | NOT-WORTH | the rejected lines (a handful) · one log line per alignment result |
| align-session.js:526 | for | hot(setInterval@main.js:1284 → getAlignSession → createAlignSession → sections) | NOT-WORTH | the song's lines, then its blocks and sections · per song |
| align-session.js:529 | .map | hot(setInterval@main.js:1284 → getAlignSession → createAlignSession → sections) | NOT-WORTH | the song's interludes (a few) · once per track change (sections) |
| align-session.js:531 | forof | hot(setInterval@main.js:1284 → getAlignSession → createAlignSession → sections) | NOT-WORTH | the song's interludes (a few) · once per track change (sections) |
| align-session.js:537 | forof | hot(setInterval@main.js:1284 → getAlignSession → createAlignSession → sections) | NOT-WORTH | the blocks and their sections (≤ ~10), once per song |
| align-session.js:540 | for | hot(setInterval@main.js:1284 → getAlignSession → createAlignSession → sections) nested | NOT-WORTH | the blocks and their sections (≤ ~10), once per song |
| align-session.js:565 | .map | hot(draw()@hdr-glow.js:141 → submit → sectionRequest) | NOT-WORTH | one section's lines (≤ 8) · once per section job |
| align-session.js:577 | forof | hot(draw()@hdr-glow.js:141 → submit → sectionResult) | NOT-WORTH | the section's lines (≤ ~10), once per alignment result |
| align-session.js:582 | .map | hot(draw()@hdr-glow.js:141 → submit → sectionResult) nested | NOT-WORTH | one line's words (≤ ~15) per result line · once per section result |
| align-session.js:600 | for | hot(draw()@hdr-glow.js:141 → submit → mergeEntry → wordLines) | NOT-WORTH | one section's lines (≤ ~10) or the song's, once per alignment result |
| align-session.js:608 | forof | hot(draw()@hdr-glow.js:141 → submit → mergeEntry → gapsAfter) | NOT-WORTH | the song's rejected and missed lines (a handful), once per alignment result |
| align-session.js:610 | forof | hot(draw()@hdr-glow.js:141 → submit → mergeEntry → gapsAfter) | NOT-WORTH | the song's rejected and missed lines (a handful), once per alignment result |
| align-session.js:611 | forof | hot(draw()@hdr-glow.js:141 → submit → mergeEntry → gapsAfter) | NOT-WORTH | the song's rejected and missed lines (a handful), once per alignment result |
| align-session.js:613 | .sort | hot(draw()@hdr-glow.js:141 → submit → mergeEntry → gapsAfter) | NOT-WORTH | the song's rejected and missed lines (a handful) · once per alignment result |
| align-session.js:613 | .sort | hot(draw()@hdr-glow.js:141 → submit → mergeEntry → gapsAfter) | NOT-WORTH | the song's rejected and missed lines (a handful) · once per alignment result |
| align-session.js:623 | .sort | hot(draw()@hdr-glow.js:141 → submit → mergeEntry) | NOT-WORTH | the song's sections (≤ ~10) · once per section result |
| align-session.js:635 | .map | hot(draw()@hdr-glow.js:141 → submit → mergeWhole) | NOT-WORTH | the song's sections (≤ ~10) · once per whole-song result |
| align-session.js:650 | forof | hot(draw()@hdr-glow.js:141 → submit → withOffset) | NOT-WORTH | the entry's aligned lines (tens), once per alignment result |
| align-session.js:664 | .filter | hot(setInterval@main.js:1284 → getAlignSession → createAlignSession → refillSections) | NOT-WORTH | the song's sections (≤ ~10) · once per track change, only for an entry with missed lines |
| align-session.js:668 | for | hot(setInterval@main.js:1284 → … → refillSections → missedIn) | NOT-WORTH | one section's line range (≤ ~10), per section once per play |
| align-session.js:683 | .some | hot(setInterval@main.js:1284 → getAlignSession → createAlignSession → canGiveNotes) | NOT-WORTH | stops at the first line with words · per track change (setLyrics) |
| align-session.js:699 | for | hot(setInterval@main.js:1284 → getAlignSession → createAlignSession → givenSyllables) | NOT-WORTH | the song's lines, words and syllables (hundreds), once per song |
| align-session.js:704 | .forEach | hot(setInterval@main.js:1284 → getAlignSession → createAlignSession → givenSyllables) nested | NOT-WORTH | one line's words, once per song |
| align-session.js:708 | .forEach |  | NOT-WORTH | one word's syllables (a handful), once per song |
| align-session.js:716 | .sort | hot(setInterval@main.js:1284 → getAlignSession → createAlignSession → givenSyllables) | NOT-WORTH | sort of the song's or section's syllables (hundreds) · once per notes/section-notes job |
| align-session.js:722 | for | hot(setInterval@main.js:1284 → getAlignSession → createAlignSession → givenSyllables) | NOT-WORTH | the song's syllables (hundreds), once per song |
| align-session.js:742 | .map | hot(setInterval@main.js:1284 → getAlignSession → createAlignSession → sectionGiven) | NOT-WORTH | the song's lines (tens) · once per section-notes job |
| align-session.js:751 | .map | hot(setInterval@main.js:1284 → getAlignSession → createAlignSession → sectionGiven) | NOT-WORTH | one section's syllables (≤ ~100) · once per section-notes job |
| align-session.js:761 | for | hot(setInterval@main.js:1284 → … → separateMessages → streamed) | SERIAL-REQUIRED | the helper reads its stdin in order; one message per 256 KB of PCM · ≤ ~330 for a 15 min song · ends with the buffer |
| align-session.js:849 | forof | hot(tick()@align-session.js:1361 → finish → prune) | NOT-WORTH | the jobs queued (a few; at most two songs' worth) · per song change |
| align-session.js:851 | forof | hot(tick()@align-session.js:1361 → finish → prune) | NOT-WORTH | the songs dropped (one or two) · per song change |
| align-session.js:896 | .reduce | hot(setInterval@main.js:1284 → getAlignSession → createAlignSession → onStreamMessage) | HOT-PATH-OK | the 1-2 lines of one stream 'words' message · per 0.25 s hop while a look-ahead song plays |
| align-session.js:991 | .every | hot(draw()@hdr-glow.js:141 → submit → fromKept) | NOT-WORTH | the song's sections (≤ ~10) · once per whole-song job |
| align-session.js:1245 | while | hot(tick()@align-session.js:1361 → due) | HOT-PATH-OK | over the sections not yet handled (≤ ~10 per song) · per tick |
| align-session.js:1351 | .filter | nested | NOT-WORTH | the song's sections (≤ ~10) · once per track change, only after a whole-song pass |
| apple-focus.js:21 | forin |  | NOT-WORTH | 12 style properties, twice per page load |
| apple-focus.js:45 | forof |  | HOT-PATH-OK | Apple's whole DOM (~15 k nodes), only on a Tab/F6 handoff out of the rail (a key press) |
| apple-focus.js:90 | forof |  | NOT-WORTH | the event's path, ≤ ~25 elements, per element boundary crossed |
| audio-listen.js:29 | forof | hot(setInterval@main.js:2901 → … → ownProcessTree → descendants) | NOT-WORTH | the process list (our ~10, or all of /proc on the fallback), once per stream search |
| audio-listen.js:36 | while | hot(setInterval@main.js:2901 → … → ownProcessTree → descendants) | NOT-WORTH | tree walk · bounded by the process count · each pid visited once (Set guard) |
| audio-listen.js:37 | forof | hot(setInterval@main.js:2901 → … → ownProcessTree → descendants) nested | NOT-WORTH | tree walk · bounded by the process count · each pid visited once (Set guard) |
| audio-listen.js:52 | forof | hot(setInterval@main.js:1284 → find → pickSinkInput) | NOT-WORTH | the desktop's sink inputs (a handful), once per stream search |
| audio-listen.js:68 | .sort | hot(setInterval@main.js:1284 → find → pickSinkInput) | NOT-WORTH | sort of the desktop's matching sink inputs (a handful), once per stream search or stall |
| audio-listen.js:82 | for | hot('data'@audio-listen.js:234 → toMidSide) | HOT-PATH-OK | one pass over the chunk's frames (~440 per 20 ms chunk) · ends with the buffer |
| audio-listen.js:97 | forof | hot(setInterval@main.js:2901 → … → ownProcessTree → readChildren) | NOT-WORTH | a process's threads and their children, once per stream search |
| audio-listen.js:99 | forof | hot(setInterval@main.js:2901 → … → ownProcessTree → readChildren) nested | NOT-WORTH | a process's threads and their children, once per stream search |
| audio-listen.js:108 | forof | hot(setInterval@main.js:2901 → … → ownProcessTree → scanProc) | NOT-WORTH | every process on the machine, only when /proc/<pid>/task/ |
| audio-listen.js:127 | while | hot(setInterval@main.js:2901 → … → curiousDeps → ownProcessTree) | NOT-WORTH | tree walk over our own processes (~10 for Electron) · each pid once |
| audio-listen.js:133 | forof | hot(setInterval@main.js:2901 → … → curiousDeps → ownProcessTree) nested | NOT-WORTH | tree walk over our own processes (~10 for Electron) · each pid once |
| audio-listen.js:149 | forof |  | NOT-WORTH | at most one or two live parecs |
| audio-listen.js:330 | forof |  | HOT-PATH-OK | one call per started handle (at most 3: visualizer, refine, align) per chunk |
| cpu-sampler.js:36 | forof |  | NOT-WORTH | Sonata's processes (≤ ~12), per reading while a section that shows CPU is open |
| cpu-sampler.js:55 | forof | hot(setInterval@main.js:2901 → … → createCuriousSampler → rates) | NOT-WORTH | Sonata's processes (≤ ~12), per refresh |
| cpu-sampler.js:70 | forof | hot(setInterval@gfx-runtime.js:232 → over) | NOT-WORTH | Sonata's processes (≤ ~12), per reading while About → Graphics is open |
| cpu-sampler.js:85 | forof | hot(setInterval@gfx-runtime.js:232 → over → firstSeen) | NOT-WORTH | ≤ 13 readings in the window |
| curious-model.js:40 | forof | hot(setInterval@main.js:2901 → … → libraryStats → entryWords) | NOT-WORTH | one aligned song's lines (tens), while For the Curious is open |
| curious-model.js:45 | .filter | hot(setInterval@main.js:2901 → … → libraryStats → entryWords) nested | HOT-PATH-OK | one line's words (≤ ~15) · per 5 s refresh (current song), per minute over the library, while open |
| curious-model.js:60 | forof | hot(setInterval@main.js:2901 → … → createCuriousSampler → libraryStats) | NOT-WORTH | the lyrics cache (≤ 2,000 entries), on open and once a minute while For the Curious is open |
| curious-model.js:71 | forof | hot(setInterval@main.js:2901 → … → createCuriousSampler → libraryStats) | NOT-WORTH | the same entries once more (≤ 2,000), same cadence |
| curious-model.js:98 | forof | hot(setInterval@main.js:2901 → … → createCuriousSampler → libraryStats) nested | NOT-WORTH | one song's refined lines (tens) |
| curious-model.js:153 | .filter | hot(setInterval@main.js:2901 → … → nowRows → notesFacts) | HOT-PATH-OK | one song's notes (hundreds) · per 5 s refresh while For the Curious is open |
| curious-model.js:159 | forof | hot(setInterval@main.js:2901 → … → nowRows → notesFacts) | NOT-WORTH | one song's notes (hundreds), when its log file is first read while For the Curious is open |
| curious-model.js:204 | .reduce | hot(setInterval@main.js:2901 → … → createCuriousSampler → nowRows) | NOT-WORTH | 2 stats fields · per 5 s refresh while For the Curious is open |
| curious-model.js:204 | .map | hot(setInterval@main.js:2901 → … → createCuriousSampler → nowRows) nested | NOT-WORTH | 2 stats fields · per 5 s refresh while For the Curious is open |
| curious-model.js:240 | .forEach | hot(setInterval@main.js:2901 → … → createCuriousSampler → hoodRows) | NOT-WORTH | Sonata's processes (≤ ~12), every refresh while For the Curious is open |
| curious-model.js:253 | forof | hot(setInterval@main.js:2901 → … → createCuriousSampler → hoodRows) | NOT-WORTH | a handful of version lines |
| curious-model.js:264 | forof | hot(setInterval@main.js:2901 → … → createCuriousSampler → reportText) | NOT-WORTH | 3 groups of ≤ ~25 rows, once per press of Copy for a bug report |
| curious-model.js:265 | .filter | hot(setInterval@main.js:2901 → … → createCuriousSampler → reportText) nested | NOT-WORTH | 3 groups of ≤ ~25 rows, once per press of Copy for a bug report |
| curious-model.js:268 | forof | hot(setInterval@main.js:2901 → … → createCuriousSampler → reportText) nested | NOT-WORTH | 3 groups of ≤ ~25 rows, once per press of Copy for a bug report |
| curious-sampler.js:63 | forof | hot(setInterval@main.js:2901 → … → createCuriousSampler → frames) | NOT-WORTH | Sonata's shown views (≤ ~8), once per refresh while For the Curious is open |
| curious-sampler.js:75 | forof |  | NOT-WORTH | the same views |
| curious-sampler.js:117 | .find | hot(setInterval@main.js:2901 → … → createCuriousSampler → helperRows) | HOT-PATH-OK | nvidia-smi's compute apps (a few) · per 5 s refresh while open and the helper runs |
| curious-sampler.js:117 | .map | hot(setInterval@main.js:2901 → … → createCuriousSampler → helperRows) nested | HOT-PATH-OK | nvidia-smi's compute apps (a few) · per 5 s refresh while open and the helper runs |
| curious-sampler.js:146 | .filter | hot(setInterval@main.js:2901 → … → createCuriousSampler → notesDoc) | HOT-PATH-OK | notes log names (≤ 1000, MAX_FILES), matches sorted (a few) · per 5 s refresh while open |
| curious-sampler.js:170 | forof | hot(setInterval@main.js:2901 → … → createCuriousSampler → hoodProcs) | NOT-WORTH | the shown views' frame counts (≤ ~8), per refresh |
| curious-sampler.js:173 | .map | hot(setInterval@main.js:2901 → … → createCuriousSampler → hoodProcs) | NOT-WORTH | Sonata's processes (≤ ~12), per refresh |
| curious-sampler.js:187 | .sort | hot(setInterval@main.js:2901 → … → createCuriousSampler → hoodProcs) | HOT-PATH-OK | Sonata's processes (≤ ~12) · per 5 s refresh while For the Curious is open |
| dbus-wire.js:42 | while | hot('data'@dbus-wire.js:322 → write → parseSig → one) | NOT-WORTH | the fields of one struct in a short signature |
| dbus-wire.js:51 | while | hot('data'@dbus-wire.js:322 → write → parseSig) | NOT-WORTH | the complete types of one signature (a handful) |
| dbus-wire.js:111 | forof | hot('data'@dbus-wire.js:322 → write) | NOT-WORTH | the elements of one array in one message (a few shortcuts or options) |
| dbus-wire.js:118 | .forEach | hot('data'@dbus-wire.js:322 → write) | NOT-WORTH | the fields of one struct |
| dbus-wire.js:134 | .forEach | hot('data'@dbus-wire.js:322 → … → encodeMessage → marshal) | NOT-WORTH | the arguments of one call |
| dbus-wire.js:187 | while | hot('data'@dbus-wire.js:322 → feed → decodeMessage → read) | NOT-WORTH | the elements of one array of one portal message (bounded by its byte length) |
| dbus-wire.js:196 | .map | hot('data'@dbus-wire.js:322 → feed → decodeMessage → read) | NOT-WORTH | per D-Bus message from the portal (shortcut presses, session setup), N = struct fields |
| dbus-wire.js:204 | .map | hot('data'@dbus-wire.js:322 → feed → decodeMessage → unmarshal) | NOT-WORTH | per D-Bus message from the portal (shortcut presses, session setup), N = signature items |
| dbus-wire.js:222 | forof | hot('data'@dbus-wire.js:322 → call → send → encodeMessage) | NOT-WORTH | the 8 header field kinds |
| dbus-wire.js:254 | forof | hot('data'@dbus-wire.js:322 → feed → decodeMessage) | NOT-WORTH | ≤ 9 header fields |
| dbus-wire.js:266 | forof |  | NOT-WORTH | the few addresses of one bus address string |
| dbus-wire.js:271 | forof | nested | NOT-WORTH | the key=value pairs of one address |
| dbus-wire.js:342 | while | hot('data'@dbus-wire.js:322 → feed) | NOT-WORTH | the whole messages in one socket chunk (one or two portal signals) |
| dbus-wire.js:389 | forof | hot('data'@dbus-wire.js:322 → feed → shut) | NOT-WORTH | the calls still waiting when the connection ends (a few) |
| disc-find.js:29 | for |  | NOT-WORTH | 766 histogram bins, once per scan |
| disc-find.js:32 | for |  | NOT-WORTH | 766 histogram bins, once per scan |
| disc-find.js:50 | forof |  | NOT-WORTH | the outline's pixels (≤ ~2000), 3 fits per scan |
| disc-find.js:57 | for |  | NOT-WORTH | Gaussian elimination of a 3×3 system |
| disc-find.js:59 | for | nested | NOT-WORTH | 3 rows |
| disc-find.js:62 | for | nested | NOT-WORTH | 3 rows |
| disc-find.js:65 | for | nested | NOT-WORTH | 4 columns |
| disc-find.js:91 | for |  | NOT-WORTH | the border's pixels (≤ ~1200), once per scan |
| disc-find.js:92 | for | nested | NOT-WORTH | skips straight past the inner pixels of each row |
| disc-find.js:99 | .map | nested | NOT-WORTH | once per disc scan (result cached), 3 channels × border pixels (≤ ~1200) sorted |
| disc-find.js:105 | for |  | HOT-PATH-OK | every pixel of a ≤ 300 px thumbnail once per scan (≤ 90k), then cached per scan |
| disc-find.js:115 | forof |  | NOT-WORTH | ≤ 5 thresholds, the first sure fit wins; once per scan, then cached |
| disc-find.js:120 | for |  | HOT-PATH-OK | every pixel once per scan |
| disc-find.js:125 | for |  | HOT-PATH-OK | every pixel, twice per scan |
| disc-find.js:126 | for | nested | HOT-PATH-OK | the row's pixels |
| disc-find.js:141 | for |  | HOT-PATH-OK | every pixel once, each blob flooded once (a scan's ≤ 90k pixels) |
| disc-find.js:146 | while | nested | HOT-PATH-OK | the flood fill, each pixel pushed once |
| disc-find.js:161 | forof |  | NOT-WORTH | the border's pixels as the flood's seeds |
| disc-find.js:162 | while |  | HOT-PATH-OK | the flood fill, each pixel pushed once |
| disc-find.js:173 | for |  | HOT-PATH-OK | every inner pixel once per scan |
| disc-find.js:174 | for | nested | HOT-PATH-OK | the row's pixels |
| disc-find.js:184 | for |  | NOT-WORTH | 3 fits, each without the previous one's outliers |
| disc-find.js:188 | .map | nested | NOT-WORTH | once per scan, 3 refits × outline points (≤ ~1500), ≤ 5 thresholds |
| disc-find.js:190 | .sort | nested | NOT-WORTH | once per scan, 3 refits × kept outline points sorted (≤ ~1500) |
| disc-find.js:190 | .map | nested | NOT-WORTH | once per scan, 3 refits × kept outline points sorted (≤ ~1500) |
| disc-find.js:193 | .filter | nested | NOT-WORTH | once per scan, 3 refits × outline points (≤ ~1500) |
| disc-find.js:204 | for |  | NOT-WORTH | the outline once |
| disc-find.js:208 | for |  | NOT-WORTH | 180 points round the rim, each looking at a (2·tol+1)² patch |
| disc-find.js:213 | for | nested | NOT-WORTH | the small patch |
| disc-find.js:214 | for | nested | NOT-WORTH | the small patch |
| disc-find.js:225 | for |  | HOT-PATH-OK | every pixel once per scan |
| disc-find.js:226 | for | nested | HOT-PATH-OK | the row's pixels |
| discord.js:20 | forof |  | NOT-WORTH | 3 folders × 10 names, once per connect attempt (at most every 30 s while Discord is away) |
| discord.js:21 | for | nested | NOT-WORTH | 3 folders × 10 names, once per connect attempt (at most every 30 s while Discord is away) |
| discord.js:75 | while | hot('data'@discord.js:59 → onData) | NOT-WORTH | the whole frames in one chunk (usually one); Discord sends a few per track change |
| engine-feed.js:33 | forof | hot(setInterval@main.js:3618 → … → parseEngineFeed → pick) | NOT-WORTH | ≤ 5 field names, once per feed read |
| game-guard.js:37 | .map | hot(setInterval@main.js:1284 → alignGuardTick → linuxProbes → isSteamGame) | NOT-WORTH | the args of one reaper cmdline (a few) · per 5 s check, only for a "reaper" process |
| game-guard.js:49 | .find | hot(setInterval@main.js:1284 → alignGuardTick → linuxProbes → parsePmon) | NOT-WORTH | pmon's rows (a few dozen) · once per 5 s check while precise timing has work |
| game-guard.js:53 | forof | hot(setInterval@main.js:1284 → alignGuardTick → linuxProbes → parsePmon) | NOT-WORTH | one pass over pmon's rows (one per GPU process, a few dozen) · per check |
| game-guard.js:110 | .filter | hot(setInterval@main.js:1284 → alignGuardTick → linuxProbes → steam) | HOT-PATH-OK | /proc entries (~800, a regex each) · per 5 s check while precise timing has work (4.6 ms first scan) |
| game-guard.js:114 | forof | hot(setInterval@main.js:1284 → alignGuardTick → linuxProbes → steam) | NOT-WORTH | one pass over /proc (~800 processes; comm read once per new pid, cmdline only for "reaper") · per check |
| game-guard.js:132 | .filter | hot(setInterval@main.js:1284 → alignGuardTick → linuxProbes → amd) | NOT-WORTH | /sys/class/drm entries (a dozen) · per 5 s check, only without nvidia-smi |
| game-guard.js:135 | forof | hot(setInterval@main.js:1284 → alignGuardTick → linuxProbes → amd) | NOT-WORTH | one pass over the DRM cards (one or two) · per check |
| gfx-model.js:141 | .sort | nested | NOT-WORTH | ≤ 4 experiments · once at start |
| gfx-model.js:141 | .filter | nested | NOT-WORTH | ≤ 4 experiments · once at start |
| gfx-model.js:148 | forof |  | NOT-WORTH | ≤ 4 switches, once at start |
| gfx-model.js:164 | forof |  | NOT-WORTH | a handful of feature names, once at start |
| gfx-model.js:201 | .filter | nested | NOT-WORTH | ≤ 4 experiments · once at start (sentinel) |
| gfx-model.js:204 | forof |  | NOT-WORTH | ≤ 4 switches, once at start |
| gfx-model.js:212 | forof |  | NOT-WORTH | ≤ 4 switches |
| gfx-model.js:235 | .filter | nested | NOT-WORTH | ≤ 4 experiments · only on a second GPU crash in a run |
| gfx-model.js:253 | .filter | nested | NOT-WORTH | ≤ 4 experiments · per Settings snapshot |
| gfx-model.js:270 | .filter | nested | NOT-WORTH | ≤ 4 experiments · per Settings snapshot |
| gfx-model.js:270 | .filter | nested | NOT-WORTH | ≤ 4 experiments · per Settings snapshot |
| gfx-model.js:283 | .map | hot(setInterval@main.js:2901 → … → readout → decodeLabel) | NOT-WORTH | per graphics readout (About/Settings open, every 5 s at most), N = drivers (≤ 4) |
| gfx-model.js:303 | forof |  | NOT-WORTH | ≤ 4 switches, while About → Graphics is open |
| gfx-runtime.js:59 | forof |  | NOT-WORTH | ≤ 4 switches, once at start |
| gfx-runtime.js:62 | forof |  | NOT-WORTH | ≤ 4 switches, once at start |
| gfx-runtime.js:119 | forof |  | NOT-WORTH | ≤ 4 switches, once at start |
| gfx-runtime.js:182 | forof |  | NOT-WORTH | ≤ 4 switches per panel snapshot |
| gfx-runtime.js:192 | .some | nested | NOT-WORTH | the screens (1-3) for one switch · per panel snapshot |
| gfx-runtime.js:212 | forof |  | NOT-WORTH | the few runtime parts (≤ 3) |
| gfx-runtime.js:235 | forof |  | NOT-WORTH | the runtime parts' own probes (≤ 3), once per open |
| glow-dither.js:48 | for |  | NOT-WORTH | 4096 pixels, once per app run (the CSS is built once and kept) |
| glow-dither.js:49 | for | nested | NOT-WORTH | 4096 pixels, once per app run (the CSS is built once and kept) |
| glow-dither.js:65 | forof |  | NOT-WORTH | 2 × 64 lines of 128 pixels, tests only |
| glow-dither.js:66 | for | nested | NOT-WORTH | 2 × 64 lines of 128 pixels, tests only |
| glow-dither.js:68 | for | nested | NOT-WORTH | 2 × 64 lines of 128 pixels, tests only |
| glow-dither.js:83 | for |  | NOT-WORTH | the 256-entry CRC table, once at load |
| glow-dither.js:89 | for |  | NOT-WORTH | the bytes of a ~100-byte PNG chunk, once per run |
| glow-dither.js:104 | for |  | NOT-WORTH | 64 rows of 64 pixels, once per run |
| glow-dither.js:107 | for | nested | NOT-WORTH | 64 rows of 64 pixels, once per run |
| gpu-detect.js:37 | forof | hot(setInterval@main.js:2901 → … → gpuScan → scanSysfs) | NOT-WORTH | the DRM cards (1–4), once per start |
| gpu-detect.js:54 | forof | hot(setInterval@main.js:2901 → … → detect → parseLspci) | NOT-WORTH | one line per PCI device (a few dozen), once per start |
| gpu-detect.js:59 | .map | hot(setInterval@main.js:2901 → … → detect → parseLspci) nested | NOT-WORTH | the quoted fields of one lspci line (≤ ~8) · once per run (gpuScan caches) |
| gpu-detect.js:86 | .map | hot(setInterval@main.js:2901 → … → gpuScan → detect) | NOT-WORTH | the cards (1-3) · once per run (gpuScan caches gpuCards) |
| gpu-detect.js:106 | .find | hot(setInterval@main.js:2901 → … → helperSnapshot → recommend) | NOT-WORTH | the cards (1-3) · per helper snapshot while Settings shows |
| gpu-detect.js:109 | .find | hot(setInterval@main.js:2901 → … → helperSnapshot → recommend) | NOT-WORTH | the cards (1-3) · per helper snapshot while Settings shows |
| gpu-detect.js:112 | .find | hot(setInterval@main.js:2901 → … → helperSnapshot → recommend) | NOT-WORTH | the cards (1-3) · per helper snapshot while Settings shows |
| gpu-detect.js:115 | .find | hot(setInterval@main.js:2901 → … → helperSnapshot → recommend) | NOT-WORTH | the cards (1-3) · per helper snapshot while Settings shows |
| gpu-detect.js:118 | .find | hot(setInterval@main.js:2901 → … → helperSnapshot → recommend) | NOT-WORTH | the cards (1-3) · per helper snapshot while Settings shows |
| hdr-glow.js:48 | .map | hot(draw()@hdr-glow.js:141 → parseRgb) | HOT-PATH-OK | 3 channels, once per sung word/syllable change while HDR is on, not per frame |
| hdr-glow.js:51 | .map | hot(draw()@hdr-glow.js:141 → parseRgb) | HOT-PATH-OK | 3 channels, once per sung word/syllable change while HDR is on, not per frame |
| hdr-glow.js:61 | .map | hot(draw()@hdr-glow.js:141 → singLinear) | HOT-PATH-OK | 3 channels, once per sung word/syllable change while HDR is on |
| hdr-glow.js:63 | .map | hot(draw()@hdr-glow.js:141 → singLinear) | HOT-PATH-OK | 3 channels, once per sung word/syllable change while HDR is on |
| hdr-glow.js:182 | for | hot(draw()@hdr-glow.js:141) | HOT-PATH-OK | one word's mask (~200 × 80 device px), once per word change, never per frame |
| hdr-screens.js:19 | .flatMap | nested | NOT-WORTH | kscreen outputs (1-4) and their lines, once per kscreen-doctor read (start, About) |
| hdr-screens.js:58 | .find | hot(setInterval@main.js:2901 → … → windowHdr → screenFor) | NOT-WORTH | the screens (1-4), per lyric window load/move (300 ms debounce) or screen change |
| hdr-screens.js:62 | .sort | hot(setInterval@main.js:2901 → … → windowHdr → screenFor) | NOT-WORTH | copy + sort of the screens (1-4), per lyric window load/move or screen change |
| helper-install-model.js:92 | .findIndex | hot(setInterval@main.js:1284 → … → reduce → go) | HOT-PATH-OK | 7 steps · per installer output event while an install runs (a few per second) |
| helper-install-model.js:92 | .findIndex | hot(setInterval@main.js:1284 → … → reduce → go) | HOT-PATH-OK | 7 steps · per installer output event while an install runs (a few per second) |
| helper-install-model.js:100 | .filter | hot(setInterval@main.js:1284 → getAlignSession → createAlignSession → reduce) | NOT-WORTH | 3 venv steps · once per install (the skip event) |
| helper-install-model.js:130 | .filter | hot(setInterval@main.js:1284 → … → create → progressView) | HOT-PATH-OK | 7 steps · per panel progress push while an install runs |
| helper-install-model.js:132 | .findIndex | hot(setInterval@main.js:1284 → … → create → progressView) | HOT-PATH-OK | ≤ 7 steps · per panel progress push while an install runs |
| helper-install-model.js:156 | .reduce | hot(setInterval@main.js:1284 → … → create → progressView) | HOT-PATH-OK | ≤ 7 steps · per panel progress push while an install runs |
| helper-install-model.js:160 | .filter | hot(setInterval@main.js:1284 → … → create → progressView) | HOT-PATH-OK | ≤ 7 steps · per panel progress push while an install runs |
| helper-install-model.js:162 | .reduce | hot(setInterval@main.js:1284 → … → create → progressView) | HOT-PATH-OK | ≤ 7 steps · per panel progress push while an install runs |
| helper-install-model.js:164 | .reduce | hot(setInterval@main.js:1284 → … → create → progressView) | HOT-PATH-OK | ≤ 7 steps · per panel progress push while an install runs |
| helper-install-model.js:166 | .reduce | hot(setInterval@main.js:1284 → … → create → progressView) | HOT-PATH-OK | 3 venv steps · per panel progress push while an install runs |
| helper-install-model.js:168 | .reduce | hot(setInterval@main.js:1284 → … → create → progressView) | HOT-PATH-OK | ≤ 7 steps · per panel progress push while an install runs |
| helper-install-model.js:182 | .find | hot(setInterval@main.js:2901 → … → failText → last) | NOT-WORTH | the job's tail (≤ TAIL lines) · only for a failed job's message |
| helper-install-model.js:215 | .filter | hot(setInterval@main.js:1284 → … → stateRow → fitParts) | NOT-WORTH | ≤ 4 parts · per state row build (Settings shown) |
| helper-install-model.js:345 | forof | hot(setInterval@main.js:3618 → … → writeHelperJob → jobMarker) | NOT-WORTH | the 7 option names, once per step change |
| helper-installer.js:28 | forof | hot(paintWords()@lyrics-view.js:1252 → remove → exec → installerEnv) | NOT-WORTH | a few names, once per run |
| helper-installer.js:85 | forof | hot('data'@helper-installer.js:82) | HOT-PATH-OK | the lines of one output chunk (a few; pip's raw progress ~4 a second) · ends with the child |
| helper-installer.js:231 | .filter | hot(paintWords()@lyrics-view.js:1252 → remove) | NOT-WORTH | 7 steps · once per Remove press (not per paint) |
| helper-installer.js:231 | .map | hot(paintWords()@lyrics-view.js:1252 → remove) nested | NOT-WORTH | 7 steps · once per Remove press (not per paint) |
| helper-speed.js:19 | .map | hot(setInterval@main.js:1284 → … → record → ratioOf) | NOT-WORTH | 3 stats fields · once per helper job result |
| helper-speed.js:22 | .reduce | hot(setInterval@main.js:1284 → … → record → ratioOf) | NOT-WORTH | 3 numbers · once per helper job result |
| helper-speed.js:47 | .sort | hot(setInterval@main.js:1284 → … → fast → median) | NOT-WORTH | once per helper job result, N ≤ the kept ratios (a handful) |
| icons.js:52 | forof |  | NOT-WORTH | ≤ 11 parts per icon (most ≤ 5), when a control is built |
| json-salvage.js:14 | while |  | HOT-PATH-OK | one pass over the file's characters (settings ~1 KB, lyrics cache ≤ 20 MB, once at load) |
| json-salvage.js:16 | while | nested | HOT-PATH-OK | one pass over the file's characters (settings ~1 KB, lyrics cache ≤ 20 MB, once at load) |
| json-salvage.js:22 | for | nested | HOT-PATH-OK | the same single pass over the text (see items()) |
| json-salvage.js:56 | forof |  | NOT-WORTH | one entry per member (~30 settings) |
| json-salvage.js:76 | forof |  | HOT-PATH-OK | one entry per cached song (≤ 2,000), once at load |
| lastfm.js:46 | .map | hot(render()@lyrics-view.js:1282 → syncExpressions → rateAt → sign) | NOT-WORTH | once per Last.fm call (now playing per song, a scrobble send), N ≤ ~255 params; 'data' root is a name clash |
| lastfm.js:97 | .forEach | hot(setInterval@main.js:451 → send → scrobbleBatch) | NOT-WORTH | ≤ 50 entries (BATCH), once per scrobble send |
| lastfm.js:157 | forof | hot(tick()@lastfm.js:196 → keep) | NOT-WORTH | ≤ QUEUE_MAX entries, on load and after each change |
| lastfm.js:165 | .filter | hot(tick()@lastfm.js:196 → dropExpired) | HOT-PATH-OK | per 5 s tick only while scrobbles wait and the backoff allows a send, N ≤ 500 (QUEUE_MAX) |
| lastfm.js:177 | forof |  | NOT-WORTH | the saved queue (≤ QUEUE_MAX), once at start |
| lastfm.js:206 | .filter | hot(tick()@lastfm.js:196) | NOT-WORTH | once per successful send, N ≤ 500 queued, Set lookup |
| liner-notes-model.js:27 | .map | hot(setInterval@main.js:1284 → … → reduceApple → notesParagraphs) | NOT-WORTH | reduceApple once per album load (booklet open / Studio's per-album credits), N = paragraphs (≤ ~20) |
| liner-notes-model.js:45 | .filter | hot(setInterval@main.js:1284 → … → createLinerNotes → reduceApple) | NOT-WORTH | once per album load, N = genre names (≤ ~5) |
| liner-notes-model.js:51 | .filter | hot(setInterval@main.js:1284 → … → createLinerNotes → reduceApple) | NOT-WORTH | once per album load, N = album tracks (≤ 400 cap, usually ≤ 30) |
| liner-notes-model.js:51 | .map | hot(setInterval@main.js:1284 → … → createLinerNotes → reduceApple) nested | NOT-WORTH | once per album load, N = album tracks (≤ 400 cap, usually ≤ 30) |
| liner-notes-model.js:67 | forof | hot(setInterval@main.js:1284 → … → createLinerNotes → oneDate) | NOT-WORTH | the release's tracks (≤ ~100), once per refresh |
| liner-notes-model.js:69 | forof | hot(setInterval@main.js:1284 → … → createLinerNotes → oneDate) | NOT-WORTH | the places (≤ a few) |
| liner-notes-model.js:112 | forof |  | NOT-WORTH | two sitelinks kept (the UI language's and English) |
| liner-notes-model.js:232 | .flatMap | hot(setInterval@main.js:451 → send → songCredits → pairTracks) | NOT-WORTH | pairTracks per song change / booklet build, N = MB tracks (≤ ~100) |
| liner-notes-model.js:235 | .map | hot(setInterval@main.js:451 → send → songCredits → pairTracks) | NOT-WORTH | per song change / booklet build, N = tracks (≤ ~30); title fallback find is O(n²) worst, n small |
| liner-notes-model.js:254 | .map | hot(setInterval@main.js:451 → … → writersLine → by) | NOT-WORTH | per song change (Studio) or per track per booklet build, N = one work's writers (≤ ~10) |
| liner-notes-model.js:254 | .filter | hot(setInterval@main.js:451 → … → writersLine → by) nested | NOT-WORTH | per song change (Studio) or per track per booklet build, N = one work's writers (≤ ~10) |
| liner-notes-model.js:273 | .forEach |  | NOT-WORTH | one song's lines (≤ ~150), once per booklet build |
| liner-notes-model.js:329 | .filter | nested | NOT-WORTH | once per booklet build, N = MB places (≤ a few) |
| liner-notes-model.js:331 | .forEach |  | NOT-WORTH | the tracks, once |
| liner-notes-model.js:332 | .forEach |  | NOT-WORTH | a few places |
| liner-notes-model.js:340 | .forEach |  | NOT-WORTH | ≤ 2 |
| liner-notes-model.js:344 | .map | nested | NOT-WORTH | once per booklet build, N = release labels (≤ a few) |
| liner-notes-model.js:357 | .forEach |  | NOT-WORTH | one show's songs |
| liner-notes-model.js:362 | .forEach |  | NOT-WORTH | the album's tracks |
| liner-notes-model.js:376 | .forEach |  | NOT-WORTH | ≤ ~8 sections |
| liner-notes-model.js:391 | .forEach |  | NOT-WORTH | the album's tracks, once per build |
| liner-notes-model.js:393 | .forEach |  | NOT-WORTH | one track's performers |
| liner-notes-model.js:396 | .forEach |  | NOT-WORTH | a few roles (a guest is listed under With) |
| liner-notes-model.js:399 | .forEach |  | NOT-WORTH | one track's crew |
| liner-notes-model.js:401 | .forEach |  | NOT-WORTH | the release's credits |
| liner-notes-model.js:407 | .forEach |  | NOT-WORTH | the band |
| liner-notes-model.js:410 | .forEach |  | NOT-WORTH | the guests |
| liner-notes-model.js:418 | .forEach |  | NOT-WORTH | the album's tracks |
| liner-notes-model.js:422 | .map | nested | NOT-WORTH | per track per booklet build, N = a track's guest performers (≤ ~10), O(n²) on tiny n |
| liner-notes-model.js:422 | .filter | nested | NOT-WORTH | per track per booklet build, N = a track's guest performers (≤ ~10), O(n²) on tiny n |
| liner-notes-model.js:433 | .forEach |  | NOT-WORTH | the album's tracks |
| liner-notes-model.js:519 | .find | hot(setInterval@main.js:451 → send → songCredits) | NOT-WORTH | songCredits per song change / queue-row menu, N = album tracks (≤ ~30) |
| liner-notes-model.js:519 | .find | hot(setInterval@main.js:451 → send → songCredits) | NOT-WORTH | songCredits per song change / queue-row menu, N = album tracks (≤ ~30) |
| liner-notes-model.js:526 | forof | hot(setInterval@main.js:451 → send → songCredits) | NOT-WORTH | ≤ 3 parts, once per song |
| liner-notes-model.js:537 | forof | hot(setInterval@main.js:451 → send → songCredits) | NOT-WORTH | one recording's performers (≤ ~30) |
| liner-notes-model.js:538 | .map | hot(setInterval@main.js:451 → send → songCredits) | NOT-WORTH | one recording's performers (≤ ~30) |
| liner-notes-model.js:541 | forof | hot(setInterval@main.js:451 → send → songCredits) | NOT-WORTH | one recording's crew (≤ ~20) |
| liner-notes-model.js:544 | forof | hot(setInterval@main.js:451 → send → songCredits) | NOT-WORTH | the release's own credits (≤ ~50), once per song |
| liner-notes-model.js:550 | forof | hot(setInterval@main.js:451 → send → songCredits) | NOT-WORTH | a handful of roles |
| liner-notes-model.js:551 | forof | hot(setInterval@main.js:451 → send → songCredits) | NOT-WORTH | a handful of roles |
| liner-notes-model.js:553 | .some | hot(setInterval@main.js:451 → send → songCredits) | NOT-WORTH | a handful of roles |
| liner-notes-model.js:556 | .some | hot(setInterval@main.js:451 → send → songCredits) | NOT-WORTH | per song change, N = credit rows (≤ ~12) |
| liner-notes-sources.js:68 | for | await | SERIAL-REQUIRED | at most 3 attempts of one request (a busy answer waits, then asks again) |
| liner-notes-sources.js:98 | .filter | hot(setInterval@main.js:1284 → … → reduceEntity → claimValues) | NOT-WORTH | one property's claims (≤ ~5), a few per entity, once per booklet fetch (not a poll) |
| liner-notes-sources.js:98 | .map | hot(setInterval@main.js:1284 → … → reduceEntity → claimValues) nested | NOT-WORTH | one property's claims (≤ ~5), a few per entity, once per booklet fetch (not a poll) |
| liner-notes-sources.js:117 | .filter | hot(setInterval@main.js:1284 → … → matchWikidata → wikidataByStatement) | NOT-WORTH | ≤ 3 search hits, once per booklet fetch |
| liner-notes-sources.js:117 | .map | hot(setInterval@main.js:1284 → … → matchWikidata → wikidataByStatement) nested | NOT-WORTH | ≤ 3 search hits, once per booklet fetch |
| liner-notes-sources.js:129 | forof | hot(setInterval@main.js:1284 → … → wikidataEntity → reduceEntity) | NOT-WORTH | one entry per wiki the item has (≤ ~300), once per match |
| liner-notes-sources.js:142 | forof | await hot(setInterval@main.js:1284 → … → createLinerNotes → matchWikidata) | SERIAL-REQUIRED | at most 2 identifiers, the second only when the first finds nothing |
| liner-notes-sources.js:145 | forof | await hot(setInterval@main.js:1284 → … → createLinerNotes → matchWikidata) nested | SERIAL-REQUIRED | ≤ 3 hits, read back until one carries the exact ID (usually the first) |
| liner-notes-sources.js:164 | .filter | hot(setInterval@main.js:1284 → … → createLinerNotes → matchMusicBrainz) | NOT-WORTH | ≤ 3 storefronts, once per booklet fetch |
| liner-notes-sources.js:166 | forof | await hot(setInterval@main.js:1284 → … → createLinerNotes → matchMusicBrainz) | SERIAL-REQUIRED | ≤ 2 storefront spellings of the one link, the second only when the first isn't known |
| liner-notes-sources.js:169 | .find | hot(setInterval@main.js:1284 → … → createLinerNotes → matchMusicBrainz) nested | NOT-WORTH | one URL's relations (≤ ~5), ≤ 2 per booklet fetch |
| liner-notes-sources.js:177 | .find | hot(setInterval@main.js:1284 → … → createLinerNotes → matchMusicBrainz) | NOT-WORTH | ≤ 10 barcode hits, once per booklet fetch |
| liner-notes-sources.js:189 | .map | hot(setInterval@main.js:1284 → … → createLinerNotes → releaseGroupReleases) | NOT-WORTH | ≤ 100 releases of the group, once per booklet fetch |
| liner-notes-sources.js:213 | .map | hot(setInterval@main.js:1284 → … → reduceRelease → roleOf) | NOT-WORTH | one relation's attributes (≤ ~4), per relation in one release reduce (once per fetch) |
| liner-notes-sources.js:215 | .filter | hot(setInterval@main.js:1284 → … → reduceRelease → roleOf) | NOT-WORTH | ≤ ~4 attributes, per relation in one release reduce (once per fetch) |
| liner-notes-sources.js:217 | .filter | hot(setInterval@main.js:1284 → … → reduceRelease → roleOf) | NOT-WORTH | ≤ ~4 attributes, per relation in one release reduce (once per fetch) |
| liner-notes-sources.js:224 | .filter | hot(setInterval@main.js:1284 → … → reduceRelease → roleOf) | NOT-WORTH | ≤ ~4 attributes, per relation in one release reduce (once per fetch) |
| liner-notes-sources.js:250 | forof | hot(setInterval@main.js:1284 → … → musicBrainzRelease → reduceRelease) | NOT-WORTH | the release's own relationships (≤ ~50) |
| liner-notes-sources.js:256 | .map | hot(setInterval@main.js:1284 → … → musicBrainzRelease → reduceRelease) | NOT-WORTH | the release's media and tracks (≤ ~100), once per booklet fetch |
| liner-notes-sources.js:269 | forof |  | NOT-WORTH | one recording's relationships (≤ ~40), once per release reduce |
| liner-notes-sources.js:284 | forof | nested | NOT-WORTH | one work's relationships (≤ ~20) |
| liner-notes-sources.js:296 | .filter | hot(setInterval@main.js:1284 → … → musicBrainzRelease → reduceRelease) | NOT-WORTH | ≤ ~5 labels, once per booklet fetch |
| liner-notes-sources.js:296 | .map | hot(setInterval@main.js:1284 → … → musicBrainzRelease → reduceRelease) nested | NOT-WORTH | ≤ ~5 labels, once per booklet fetch |
| liner-notes-sources.js:301 | .map | hot(setInterval@main.js:1284 → … → musicBrainzRelease → reduceRelease) | NOT-WORTH | ≤ ~5 credited artists, once per booklet fetch |
| liner-notes-sources.js:304 | .map | hot(setInterval@main.js:1284 → … → musicBrainzRelease → reduceRelease) | NOT-WORTH | ≤ ~10 places, once per booklet fetch |
| liner-notes-sources.js:312 | .filter | hot(setInterval@main.js:1284 → … → reduceRelease → dedupe) | NOT-WORTH | one credit list (≤ ~200), per track and release in one reduce, once per fetch |
| liner-notes-sources.js:322 | .filter | nested | NOT-WORTH | one release's scans (≤ ~30), once per booklet fetch |
| liner-notes-sources.js:333 | .some | hot(setInterval@main.js:1284 → … → createLinerNotes → hasScans) | NOT-WORTH | ≤ ~30 scans × ≤ 4 types, once or twice per booklet fetch |
| liner-notes-sources.js:341 | .find | hot(setInterval@main.js:1284 → … → createLinerNotes → pickScanRelease) | NOT-WORTH | ≤ 100 releases, once per booklet fetch |
| liner-notes-sources.js:343 | .filter | hot(setInterval@main.js:1284 → … → createLinerNotes → pickScanRelease) | NOT-WORTH | ≤ 100 releases, once per booklet fetch |
| liner-notes-sources.js:348 | .sort | hot(setInterval@main.js:1284 → … → createLinerNotes → pickScanRelease) | NOT-WORTH | sort of ≤ 100 releases, once per booklet fetch |
| liner-notes-sources.js:351 | for |  | NOT-WORTH | 4 keys per comparison |
| liner-notes-sources.js:400 | .filter | hot(setInterval@main.js:1284 → … → reduceWikipedia → paras) | NOT-WORTH | one section's lines (≤ ~30), per article section, once per fetch |
| liner-notes-sources.js:400 | .map | hot(setInterval@main.js:1284 → … → reduceWikipedia → paras) nested | NOT-WORTH | one section's lines (≤ ~30), per article section, once per fetch |
| liner-notes-sources.js:407 | forof | hot(setInterval@main.js:1284 → … → wikipedia → reduceWikipedia) | NOT-WORTH | one article's sections (≤ ~40), once per fetch |
| liner-notes-sources.js:415 | .some | hot(setInterval@main.js:1284 → … → wikipedia → reduceWikipedia) nested | NOT-WORTH | ≤ 12 headings per section, ≤ ~40 sections, once per fetch |
| liner-notes-sources.js:418 | forof | hot(setInterval@main.js:1284 → … → wikipedia → reduceWikipedia) nested | NOT-WORTH | ≤ MAX_PARAS paragraphs per section |
| liner-notes-sources.js:447 | .find | hot(setInterval@main.js:1284 → … → setlistFm → reduceSetlist) | NOT-WORTH | ≤ 20 setlists of one page, once per booklet fetch |
| liner-notes-sources.js:458 | .map | hot(setInterval@main.js:1284 → … → setlistFm → reduceSetlist) | NOT-WORTH | ≤ ~4 sets × ≤ ~30 songs, once per booklet fetch |
| liner-notes-sources.js:458 | .map | nested | NOT-WORTH | ≤ ~4 sets × ≤ ~30 songs, once per booklet fetch |
| liner-notes.html:332 | forof |  | NOT-WORTH | the 0-2 images of one page, when it comes near |
| liner-notes.html:347 | forof |  | NOT-WORTH | ≤ 12 facts |
| liner-notes.html:360 | .forEach |  | NOT-WORTH | ≤ 12 credits |
| liner-notes.html:380 | forof |  | NOT-WORTH | one stanza's lines |
| liner-notes.html:410 | forof |  | NOT-WORTH | ≤ 4 chips per page |
| liner-notes.html:422 | for |  | NOT-WORTH | one stanza's lines, while measuring |
| liner-notes.html:435 | while |  | NOT-WORTH | a binary search over the words (≤ log2 of a paragraph's words) |
| liner-notes.html:444 | for |  | NOT-WORTH | back over the last few words, looking for a sentence's end |
| liner-notes.html:457 | while |  | NOT-WORTH | the flow's blocks, once per layout (≤ a few hundred; each block placed once, |
| liner-notes.html:507 | forof |  | NOT-WORTH | ≤ 2 chips |
| liner-notes.html:516 | forof |  | NOT-WORTH | ≤ 2 chips |
| liner-notes.html:523 | forof |  | NOT-WORTH | the album's tracks |
| liner-notes.html:526 | .forEach |  | NOT-WORTH | ≤ 3 lines |
| liner-notes.html:529 | forof |  | NOT-WORTH | ≤ 2 chips |
| liner-notes.html:535 | for |  | NOT-WORTH | ≤ 6 measuring steps, once per layout |
| liner-notes.html:560 | forof |  | NOT-WORTH | the booklet's sections (≤ 8) and their pages, once per layout |
| liner-notes.html:562 | forof | nested | NOT-WORTH | the booklet's sections (≤ 8) and their pages, once per layout |
| liner-notes.html:564 | forof | nested | NOT-WORTH | the booklet's sections (≤ 8) and their pages, once per layout |
| liner-notes.html:580 | .forEach |  | NOT-WORTH | the pages, once per layout |
| liner-notes.html:581 | .forEach |  | NOT-WORTH | once per layout |
| liner-notes.html:584 | .forEach |  | NOT-WORTH | the pages, once per layout |
| liner-notes.html:596 | for |  | NOT-WORTH | the spreads, once per layout |
| liner-notes.html:612 | forof |  | NOT-WORTH | ≤ 4 pages |
| liner-notes.html:626 | forof |  | NOT-WORTH | ≤ 8 section buttons |
| liner-notes.html:636 | .filter | nested | NOT-WORTH | 2 pages, once per show / page turn (the hot root is a name match on go) |
| liner-notes.html:730 | forof |  | NOT-WORTH | ≤ 8 sections |
| liner-notes.html:746 | forof |  | NOT-WORTH | the two open pages' track rows (≤ ~60) |
| liner-notes.html:749 | forof |  | NOT-WORTH | the one disc on the cover spread; a scan turns only when its disc was found for sure (no wobble) |
| liner-notes.html:761 | forof |  | NOT-WORTH | the two open pages, one lookup each |
| liner-notes.html:777 | forof |  | NOT-WORTH | the booklet's disc scans (0-1) |
| liner-notes.html:793 | forof |  | NOT-WORTH | the booklet's pages (≤ ~40), once when a scan's circle is found |
| liner-notes.html:803 | .filter | nested | NOT-WORTH | the sources (≤ ~8), once per liner-data push |
| listen-session.js:46 | .every | hot(tick()@listen-session.js:227 → processDue → sameWords) | NOT-WORTH | one line's words (≤ ~15), per due line (once per line per play) and on setLyrics |
| listen-session.js:58 | .map | hot(setInterval@main.js:1284 → getListenSession → createListenSession → applyLearned) | NOT-WORTH | the song's lines (≤ ~150), once per setLyrics (per song) |
| listen-session.js:80 | forof | hot(tick()@listen-session.js:227 → processDue → withOffset) | NOT-WORTH | the entry's learned lines (tens), once per refined line |
| listen-session.js:133 | for |  | HOT-PATH-OK | one pass over the chunk's frames (one parec chunk, ~1-2 k) per audio chunk while |
| listen-session.js:138 | forof |  | HOT-PATH-OK | the few onsets / voiced spans one chunk adds (0-3) |
| listen-session.js:139 | forof |  | HOT-PATH-OK | the few onsets / voiced spans one chunk adds (0-3) |
| listen-session.js:163 | for | hot(tick()@listen-session.js:227 → processDue) | HOT-PATH-OK | due-line scan · per tick (2/s) · over the song's lines (tens) · cost trivial |
| listen-session.js:174 | .filter | hot(tick()@listen-session.js:227 → processDue) nested | NOT-WORTH | ≤ 30 s of onsets (≤ ~375), once per due line (once per line per play), not every tick |
| listen-session.js:176 | .filter | hot(tick()@listen-session.js:227 → processDue) nested | NOT-WORTH | ≤ 30 s of voiced spans (tens), once per due line per play |
| listen-session.js:194 | .filter | hot(tick()@listen-session.js:227 → processDue) | HOT-PATH-OK | runs per 500 ms tick only when the oldest onset is past 30 s; N ≤ ~375 |
| listen-session.js:196 | .filter | hot(tick()@listen-session.js:227 → processDue) | HOT-PATH-OK | runs per 500 ms tick only when the oldest span is past 30 s; N ≤ ~30 |
| lookahead-page.js:86 | forof |  | NOT-WORTH | six event names, once per page load |
| lookahead.js:188 | for | hot('data'@lookahead.js:246 → parseLine) | NOT-WORTH | ≤ 20 fields of one reply line |
| lookahead.js:250 | while | hot('data'@lookahead.js:246) | HOT-PATH-OK | the lines of one chunk (a reply or an event, a few per user action, 2 stats/s) |
| lookahead.js:264 | forof |  | NOT-WORTH | the commands still waiting (≤ a few) |
| lookahead.js:535 | .some | hot(setTimeout re-arm@lookahead.js:515) | NOT-WORTH | N <= 1, per page event |
| lookahead.js:541 | forof | hot(setTimeout re-arm@lookahead.js:515) | SERIAL-REQUIRED | the helper applies its commands in the order sent |
| lyrics-expressive.js:60 | forof |  | NOT-WORTH | the song's expr words (one per sung word, ≤ ~600), once per notes result |
| lyrics-expressive.js:73 | .map | nested | NOT-WORTH | the song's vocalise spans (a few), once per notes result |
| lyrics-expressive.js:76 | .map | nested | NOT-WORTH | one vocalise span's loudness points, once per notes result |
| lyrics-expressive.js:79 | .map | nested | NOT-WORTH | one vocalise span's contour points, once per notes result |
| lyrics-expressive.js:86 | .filter | nested | NOT-WORTH | the song's vocalise spans (a few), once per notes result |
| lyrics-expressive.js:117 | forof | hot(render()@lyrics-view.js:1282 → applyExpr → vocaliseExpressions) | NOT-WORTH | the song's words (≤ ~600), once per song laid out |
| lyrics-expressive.js:119 | .map | hot(render()@lyrics-view.js:1282 → applyExpr → vocaliseExpressions) | NOT-WORTH | the vocalise spans (a few) x the words, once per song laid out |
| lyrics-expressive.js:119 | .filter | hot(render()@lyrics-view.js:1282 → applyExpr → vocaliseExpressions) nested | NOT-WORTH | the vocalise spans (a few) x the words, once per song laid out |
| lyrics-expressive.js:149 | .every | hot(render()@lyrics-view.js:1282 → applyExpr → lineExpressions → matchWord) | NOT-WORTH | a held vowel's letters (1-3), per word matched (line laid out or applyExpr), not per frame |
| lyrics-expressive.js:174 | .map | hot(render()@lyrics-view.js:1282 → … → matchWord → heldInLastSyllable) | NOT-WORTH | a word's syllables (a handful), per word matched (line laid out or applyExpr) |
| lyrics-expressive.js:201 | .filter | hot(render()@lyrics-view.js:1282 → applyExpr → lineExpressions) | NOT-WORTH | the song's expr words (≤ ~600) once per line laid out, then one line's words (~5-12) |
| lyrics-expressive.js:204 | .forEach | hot(render()@lyrics-view.js:1282 → applyExpr → lineExpressions) | NOT-WORTH | one line's words, once per line laid out |
| lyrics-expressive.js:327 | forof | hot(render()@lyrics-view.js:1282 → … → waveKeyframes → vibAt) | NOT-WORTH | a vibrato's cycles (≤ ~8 per s of the note), per keyframe built (once per held word) |
| lyrics-expressive.js:352 | for | hot(render()@lyrics-view.js:1282 → syncExpressions → startStretch → waveKeyframes) | NOT-WORTH | 8 keyframes per vibrato cycle over one held vowel (≤ ~100), once per held word |
| lyrics-expressive.js:356 | for | hot(render()@lyrics-view.js:1282 → syncExpressions → startStretch → waveKeyframes) | NOT-WORTH | the keyframes just made |
| lyrics-expressive.js:366 | for | hot(render()@lyrics-view.js:1282 → … → waveKeyframes → phaseAt) | NOT-WORTH | a vibrato's cycles (≤ ~8 per s), per keyframe sample (once per held word) |
| lyrics-expressive.js:384 | for | hot(render()@lyrics-view.js:1282 → … → contourPx → contourAt) | NOT-WORTH | a held vowel's contour (≤ 20 points per s), per letter placed (once per held word) |
| lyrics-expressive.js:401 | for | hot(render()@lyrics-view.js:1282 → … → ghostPlan → loudAt) | NOT-WORTH | a held vowel's envelope (≤ 20 points per s), per keyframe (once per ghost) |
| lyrics-expressive.js:411 | forof |  | NOT-WORTH | a short key (the song and the word), once per ghost |
| lyrics-expressive.js:439 | for | hot(render()@lyrics-view.js:1282 → syncExpressions → startGhost → ghostPlan) | NOT-WORTH | a ghost's letters (≤ ~12), once per ghost |
| lyrics-expressive.js:453 | for | hot(render()@lyrics-view.js:1282 → syncExpressions → startGhost → ghostPlan) | NOT-WORTH | one keyframe per 0.1 s of a held vowel (≤ ~60), once per ghost |
| lyrics-expressive.js:485 | forof | hot(setInterval@main.js:1284 → logNotesPlan → summary) | NOT-WORTH | the song's expr words (≤ ~600), once per song |
| lyrics-expressive.js:492 | forof | hot(setInterval@main.js:1284 → logNotesPlan → summary) | NOT-WORTH | the song's vocalise spans (a few) |
| lyrics-prefetch.js:38 | while |  | NOT-WORTH | at most PREFETCH_ALBUM_MAX (12) queue items, once per song |
| lyrics-prefetch.js:71 | while | await | SERIAL-REQUIRED | one look-ahead at a time; a newer song replaces the older between lookups |
| lyrics-prefetch.js:78 | forof | await nested | SERIAL-REQUIRED | one lookup at a time, PREFETCH_GAP_MS apart (gentle on LRCLIB); at most 12 songs |
| lyrics-shorthand.js:99 | .map | hot(setInterval@main.js:1284 → expandShorthand) | NOT-WORTH | the song's lines (tens), once per LRCLIB lyrics lookup (track change) |
| lyrics-shorthand.js:116 | for | hot(setInterval@main.js:1284 → expandShorthand → close) | NOT-WORTH | a block's lines, n ≤ MAX_TIMES · once per song |
| lyrics-shorthand.js:119 | for | hot(setInterval@main.js:1284 → expandShorthand → emptyAfter) | NOT-WORTH | a block's lines, n ≤ MAX_TIMES · once per song |
| lyrics-shorthand.js:121 | for | hot(setInterval@main.js:1284 → expandShorthand) | NOT-WORTH | the song's lines (tens), once per track change |
| lyrics-shorthand.js:129 | for | hot(setInterval@main.js:1284 → expandShorthand) nested | NOT-WORTH | n ≤ MAX_TIMES copies of one line · once per song |
| lyrics-shorthand.js:135 | for | hot(setInterval@main.js:1284 → expandShorthand) nested | NOT-WORTH | n ≤ MAX_TIMES copies of one line · once per song |
| lyrics-shorthand.js:142 | for | hot(setInterval@main.js:1284 → expandShorthand) nested | NOT-WORTH | the lines so far, n ≤ MAX_TIMES · once per song |
| lyrics-shorthand.js:149 | for | hot(setInterval@main.js:1284 → expandShorthand) nested | NOT-WORTH | a block's lines, n ≤ MAX_TIMES · once per song |
| lyrics-shorthand.js:154 | .map | hot(setInterval@main.js:1284 → expandShorthand) | NOT-WORTH | the written-out lines, once per LRCLIB lyrics lookup with shorthand |
| lyrics-shorthand.js:162 | .filter | hot(setInterval@main.js:1284 → expandShorthand → stanza) | NOT-WORTH | the song's lines, once per "verse N" marker in a lyrics lookup |
| lyrics-shorthand.js:164 | .filter | hot(setInterval@main.js:1284 → expandShorthand → stanza) | NOT-WORTH | the song's lines, once per "verse N" marker in a lyrics lookup |
| lyrics-shorthand.js:166 | .map | hot(setInterval@main.js:1284 → expandShorthand → stanza) | NOT-WORTH | the song's interludes (a few), once per "verse N" marker in a lyrics lookup |
| lyrics-shorthand.js:170 | .forEach | hot(setInterval@main.js:1284 → expandShorthand → stanza) | NOT-WORTH | the song's lines, once per song with such a marker |
| lyrics-shorthand.js:180 | for | hot(setInterval@main.js:1284 → expandShorthand → repeatedRun) | NOT-WORTH | pairs of start lines (≤ ~100² compares of short runs), once per song with an unlabelled chorus marker |
| lyrics-shorthand.js:181 | for | hot(setInterval@main.js:1284 → expandShorthand → repeatedRun) nested | NOT-WORTH | pairs of start lines (≤ ~100² compares of short runs), once per song with an unlabelled chorus marker |
| lyrics-shorthand.js:183 | while | hot(setInterval@main.js:1284 → expandShorthand → repeatedRun) nested | NOT-WORTH | pairs of start lines (≤ ~100² compares of short runs), once per song with an unlabelled chorus marker |
| lyrics-sources.js:20 | forof |  | NOT-WORTH | a tag's few attributes, while parsing a song's lyrics (once per song) |
| lyrics-sources.js:48 | forof |  | NOT-WORTH | the song's singers (1-3), once per song |
| lyrics-sources.js:64 | forof |  | NOT-WORTH | the spans of one line, once per song |
| lyrics-sources.js:86 | .some | nested | NOT-WORTH | open span stack (depth ≤ 3), per span while parsing TTML, once per song lookup |
| lyrics-sources.js:106 | forof |  | NOT-WORTH | one line's syllables and words (tens), once per song |
| lyrics-sources.js:117 | forof |  | NOT-WORTH | the line's words, twice, once per song |
| lyrics-sources.js:118 | for |  | NOT-WORTH | the line's words, twice, once per song |
| lyrics-sources.js:123 | .map | nested | NOT-WORTH | one multi-span word's syllables (≤ ~6), per word of a line, once per song lookup |
| lyrics-sources.js:126 | .map | nested | NOT-WORTH | same syllables joined once per multi-span word, once per song lookup |
| lyrics-sources.js:144 | while |  | NOT-WORTH | the song's lines (tens to ~100), once per song |
| lyrics-sources.js:154 | forof |  | NOT-WORTH | the song's lines, once per song |
| lyrics-sources.js:159 | .map | nested | NOT-WORTH | one line's words (≤ ~15), per line, once per song lookup |
| lyrics-sources.js:188 | for |  | NOT-WORTH | one LRC line's word stamps, once per song |
| lyrics-sources.js:206 | forof |  | NOT-WORTH | the LRC file's lines and their stamps (tens to ~100), once per song |
| lyrics-sources.js:211 | forof | nested | NOT-WORTH | the LRC file's lines and their stamps (tens to ~100), once per song |
| lyrics-sources.js:217 | .map | nested | NOT-WORTH | one line's words per repeated stamp, once per LRC parse (per lookup) |
| lyrics-sources.js:224 | for |  | NOT-WORTH | the entries once per song; the inner search stops at the first later stamp (usually the next) |
| lyrics-sources.js:228 | for | nested | NOT-WORTH | the entries once per song; the inner search stops at the first later stamp (usually the next) |
| lyrics-sources.js:233 | for | nested | NOT-WORTH | one line's words, once per song |
| lyrics-sources.js:251 | .map | nested | NOT-WORTH | plain lyrics' lines (≤ ~150), once per LRCLIB hit parsed (per lookup) |
| lyrics-sources.js:516 | for | await | SERIAL-REQUIRED | at most 1 + APPLE_RETRY_MS.length (3) Apple attempts per lookup, each after the last failed |
| lyrics-store.js:41 | forof |  | HOT-PATH-OK | ≤ 2,000 entries, once at the first lookup |
| lyrics-store.js:47 | forof |  | HOT-PATH-OK | ≤ 2,000 entries, once |
| lyrics-store.js:62 | while |  | NOT-WORTH | drops the oldest entries until within bounds; usually 0-1 per add |
| lyrics-syllables.js:75 | .map | hot(setInterval@main.js:1284 → … → withSyllables → splitWord) | NOT-WORTH | a word's hyphen pieces (a handful), once per word per load or timing change of its line |
| lyrics-syllables.js:78 | forof | hot(setInterval@main.js:1284 → … → withSyllables → splitWord) | NOT-WORTH | a word's hyphen pieces (a handful) · once per word per load or timing change |
| lyrics-syllables.js:93 | .reduce | hot(setInterval@main.js:1284 → … → withSyllables → spread) | NOT-WORTH | a word's parts (a handful), once per word per load or timing change of its line |
| lyrics-syllables.js:98 | for | hot(setInterval@main.js:1284 → … → withSyllables → spread) | NOT-WORTH | one pass over a word's parts (a handful) · once per word per load or timing change |
| lyrics-syllables.js:125 | .map | hot(setInterval@main.js:1284 → … → givenSyllables → withSyllables) | NOT-WORTH | one pass over a line's words · once per line per load or timing change; — a line's words (~5-12), once per line per load, refine, align or stream message |
| lyrics-timing.js:13 | forof | hot(render()@lyrics-view.js:1282 → liveLines → lineEnd) | HOT-PATH-OK | two lists (words, background), called per view update for a few live lines |
| lyrics-timing.js:30 | for | hot(setInterval@main.js:1284 → expandShorthand → stanza → findInterludes) | NOT-WORTH | the song's lines, once per lyrics data |
| lyrics-timing.js:41 | for | hot(render()@lyrics-view.js:1282 → interludeAt) | HOT-PATH-OK | the song's interludes (a few), per view update |
| lyrics-timing.js:58 | for | hot(render()@lyrics-view.js:1282 → syncDots → dotKeyframes → interludeProgress) | HOT-PATH-OK | 3 dots, per frame only while an interlude shows |
| lyrics-timing.js:70 | while | hot(paintWords()@lyrics-view.js:1252 → wordState → wordPos) | HOT-PATH-OK | one line's words (≤ ~15), per frame while a word is being sung |
| lyrics-timing.js:79 | for | hot(render()@lyrics-view.js:1282 → liveLines → latestLine) | HOT-PATH-OK | the song's lines (tens), stops at the first future line; per view update |
| lyrics-timing.js:94 | for | hot(render()@lyrics-view.js:1282 → liveLines) | HOT-PATH-OK | at most 3 earlier lines, per view update |
| lyrics-timing.js:110 | for |  | HOT-PATH-OK | ≤ 5 lines × their words and syllables (tens), once per change (the view sleeps until then) |
| lyrics-timing.js:115 | forof | nested | HOT-PATH-OK | ≤ 5 lines × their words and syllables (tens), once per change (the view sleeps until then) |
| lyrics-timing.js:117 | forof | nested | HOT-PATH-OK | ≤ 5 lines × their words and syllables (tens), once per change (the view sleeps until then) |
| lyrics-timing.js:121 | forof | nested | HOT-PATH-OK | a word's syllables (a handful) · only Apple words timed in several spans |
| lyrics-timing.js:140 | .map | nested | NOT-WORTH | the song's lines (≤ ~150) + sort of ≤ a few singers, once per 'lyrics-data' (per song) in the view |
| lyrics-timing.js:150 | .some | hot(setInterval@main.js:1284 → prepareLines → hasWordTiming) | NOT-WORTH | the song's lines (≤ ~150), stops at the first word-timed one; per song / per estimate |
| lyrics-timing.js:207 | forof | hot(setInterval@main.js:1284 → prepareLines → plainTimed → splitWords) | NOT-WORTH | a line's words and their hyphen pieces · once per line per estimate / alignment / match |
| lyrics-timing.js:211 | .forEach | hot(setInterval@main.js:1284 → prepareLines → plainTimed → splitWords) nested | NOT-WORTH | a line's words and their hyphen pieces · once per line per estimate / alignment / match |
| lyrics-timing.js:227 | for | hot(render()@lyrics-view.js:1282 → applyExpr → wordGlue) | NOT-WORTH | one line's words · once per line per track (setData) |
| lyrics-timing.js:239 | .reduce | hot(setInterval@main.js:1284 → … → songPace → lineWeight) | NOT-WORTH | one line's words (≤ ~15), per line per estimate/repace (per song, per refine message) |
| lyrics-timing.js:256 | for | hot(setInterval@main.js:1284 → prepareLines → estimateWords → songPace) | NOT-WORTH | one pass over the song's lines · once per estimate |
| lyrics-timing.js:264 | .sort | hot(setInterval@main.js:1284 → prepareLines → estimateWords → songPace) | NOT-WORTH | sort of ≤ ~150 line paces, once per estimate (per song) |
| lyrics-timing.js:277 | forof |  | NOT-WORTH | one pass over the song's lines · per estimate / alignment / refine message |
| lyrics-timing.js:281 | .map | nested | NOT-WORTH | one line's words (≤ ~15), per aligned/refined line, per estimate or refine message |
| lyrics-timing.js:328 | .sort | hot(tick()@listen-session.js:227 → processDue → withOffset → robustOnset) | NOT-WORTH | sort of ≤ ~150 delays, once per line refined (tens per play), not per tick |
| lyrics-timing.js:333 | .sort | hot(tick()@listen-session.js:227 → processDue → withOffset → robustOnset) | NOT-WORTH | ≤ ~150 deviations sorted, once per line refined (tens per play) |
| lyrics-timing.js:333 | .map | hot(tick()@listen-session.js:227 → processDue → withOffset → robustOnset) nested | NOT-WORTH | ≤ ~150 deviations sorted, once per line refined (tens per play) |
| lyrics-timing.js:336 | .filter | hot(tick()@listen-session.js:227 → processDue → withOffset → robustOnset) | NOT-WORTH | ≤ ~150 delays, once per line refined (tens per play) |
| lyrics-timing.js:352 | forof |  | NOT-WORTH | one pass over the song's lines · per estimate / alignment / refine message |
| lyrics-timing.js:377 | .reduce | hot(setInterval@main.js:1284 → prepareLines → estimateWords → estimateLine) | NOT-WORTH | one line's word weights (≤ ~15), per line per estimate (per song) |
| lyrics-timing.js:383 | .map | hot(setInterval@main.js:1284 → prepareLines → estimateWords → estimateLine) | NOT-WORTH | one line's words (≤ ~15), per line per estimate (per song) |
| lyrics-timing.js:412 | .map | hot(setInterval@main.js:1284 → prepareLines → estimateWords) | NOT-WORTH | the song's lines (≤ ~150), once per estimate (per song, in main and the view) |
| lyrics-timing.js:451 | forof |  | NOT-WORTH | stops at the first plain estimated line · per repace |
| lyrics-timing.js:499 | for |  | NOT-WORTH | one pass over the song's lines · per lyrics data / alignment / refine message |
| lyrics-timing.js:552 | for | hot(setInterval@main.js:1284 → prepareLines → applyAligned → reattributeHolds) | NOT-WORTH | one line's words · once per aligned line per cache read / helper result |
| lyrics-timing.js:576 | forof |  | NOT-WORTH | two passes over the song's lines · per estimate / alignment / refine message |
| lyrics-timing.js:596 | forof |  | NOT-WORTH | one line's words, per repeated line |
| lyrics-view.js:97 | forof |  | NOT-WORTH | one pass over the message's lines (at most the song's line count) · per 'lyrics-aligned' message |
| lyrics-view.js:103 | .some | nested | NOT-WORTH | one line's words (~5-12) per message line, per 'lyrics-aligned' message (a few per song) |
| lyrics-view.js:105 | .map | nested | NOT-WORTH | one line's words (~5-12) per message line, per 'lyrics-aligned' message (a few per song) |
| lyrics-view.js:129 | forof |  | NOT-WORTH | the lines of one message (one or two per hop) and their words |
| lyrics-view.js:135 | forof | nested | NOT-WORTH | the lines of one message (one or two per hop) and their words |
| lyrics-view.js:148 | for | nested | NOT-WORTH | the rest of one line's words, per 'lyrics-stream' message |
| lyrics-view.js:158 | .every | nested | HOT-PATH-OK | one streamed line's words (~5-12), per 'lyrics-stream' message (look-ahead hops) |
| lyrics-view.js:318 | .map | hot('resize'@lyrics-view.js:1136 → placeBacking → backingAnchor) | NOT-WORTH | one line's backing words (~2-8), once per line placed (load, resize frame, stage line shown) |
| lyrics-view.js:320 | .map | hot('resize'@lyrics-view.js:1136 → placeBacking → backingAnchor) | NOT-WORTH | one line's main words (~5-12), once per line placed (load, resize frame, stage line shown) |
| lyrics-view.js:323 | for | hot('resize'@lyrics-view.js:1136 → placeBacking → backingAnchor) | NOT-WORTH | main words x backing words (a line's, ~5-12 each), once per line laid out |
| lyrics-view.js:325 | while | hot('resize'@lyrics-view.js:1136 → placeBacking → backingAnchor) nested | NOT-WORTH | main words x backing words (a line's, ~5-12 each), once per line laid out |
| lyrics-view.js:337 | for | hot('resize'@lyrics-view.js:1136 → placeBacking → backingAnchor) | NOT-WORTH | a line's main words, once per line laid out |
| lyrics-view.js:431 | .map | hot(render()@lyrics-view.js:1282 → syncDots → dotKeyframes) | NOT-WORTH | 3 dots x 4 keyframes, once per interlude shown (g.anims made once) |
| lyrics-view.js:440 | for | hot(render()@lyrics-view.js:1282 → syncDots → dotKeyframes) | NOT-WORTH | one keyframe per 1/8 breath (~0.3 s) across the interlude, once per interlude shown |
| lyrics-view.js:441 | .map | hot(render()@lyrics-view.js:1282 → syncDots → dotKeyframes) | NOT-WORTH | one keyframe per 1/8 breath (~0.3 s) across the interlude, once per interlude shown |
| lyrics-view.js:441 | .sort | hot(render()@lyrics-view.js:1282 → syncDots → dotKeyframes) nested | NOT-WORTH | one keyframe per 1/8 breath (~0.3 s) across the interlude, once per interlude shown |
| lyrics-view.js:457 | for | hot(render()@lyrics-view.js:1282 → slideFrom) | NOT-WORTH | the shown elements around a countdown (at most the window's lines), per dots open/close |
| lyrics-view.js:537 | .map | hot(render()@lyrics-view.js:1282 → applyExpr → xKey) | NOT-WORTH | a line's measured words (0-3), per line laid out or per applyExpr pass (line boundaries) |
| lyrics-view.js:556 | .forEach | hot(render()@lyrics-view.js:1282 → … → lineMain → wordSpans) | NOT-WORTH | one line's words (and their syllables), once per line per track in setData |
| lyrics-view.js:623 | forof | hot(render()@lyrics-view.js:1282 → … → wordSpans → expressLetters) | NOT-WORTH | a held vowel's letters (1-3), once per line laid out |
| lyrics-view.js:638 | for | hot(render()@lyrics-view.js:1282 → … → wordSpans → expressLetters) | NOT-WORTH | the extra letters (≤ MAX_EXTRA), once per line laid out |
| lyrics-view.js:734 | .forEach |  | NOT-WORTH | the song's lines (and the countdowns before them), once per track |
| lyrics-view.js:735 | while |  | NOT-WORTH | the song's lines (and the countdowns before them), once per track |
| lyrics-view.js:768 | forof |  | NOT-WORTH | two copies per timed line, once per track |
| lyrics-view.js:773 | forof | nested | NOT-WORTH | the copy's bold layers (one per word), once per track |
| lyrics-view.js:832 | forof | hot(render()@lyrics-view.js:1282 → applyExpr → relayLine → lineMain) | NOT-WORTH | the line's measured words (0-3), once per line laid out |
| lyrics-view.js:838 | .map | hot(render()@lyrics-view.js:1282 → applyExpr → relayLine → lineMain) nested | NOT-WORTH | a held word's syllables (a handful), once per line laid out or swapped |
| lyrics-view.js:842 | .map | hot(render()@lyrics-view.js:1282 → applyExpr → relayLine → lineMain) | NOT-WORTH | a line's measured words (0-3), once per line laid out or swapped |
| lyrics-view.js:872 | for | hot(render()@lyrics-view.js:1282 → applyExpr) | NOT-WORTH | the song's lines (tens), once per line boundary while an expression waits (a few per song) |
| lyrics-view.js:885 | .some | hot(render()@lyrics-view.js:1282 → applyExpr) | NOT-WORTH | xlive (≤ ~5) and the song's vocalise (a few), once per applyExpr (line boundary while one waits) |
| lyrics-view.js:885 | .map | hot(render()@lyrics-view.js:1282 → applyExpr) | NOT-WORTH | xlive (≤ ~5) and the song's vocalise (a few), once per applyExpr (line boundary while one waits) |
| lyrics-view.js:887 | .some | hot(render()@lyrics-view.js:1282 → applyExpr) | NOT-WORTH | the song's lines x their measured words (0-3), once per applyExpr, only until the layer exists |
| lyrics-view.js:901 | .forEach | hot(render()@lyrics-view.js:1282 → applyExpr → relayLine) | NOT-WORTH | one line's words (~5-12), once per swapped line |
| lyrics-view.js:906 | forof | hot(render()@lyrics-view.js:1282 → applyExpr → relayLine) | NOT-WORTH | two copies, once per swapped line |
| lyrics-view.js:913 | forof | hot(render()@lyrics-view.js:1282 → applyExpr → relayLine) nested | NOT-WORTH | the copy's bold layers (one per word), once per swapped line |
| lyrics-view.js:957 | while |  | NOT-WORTH | skips at most the ghost layer and the version note, per state change |
| lyrics-view.js:985 | forof | hot(render()@lyrics-view.js:1282 → takeHeld) | HOT-PATH-OK | the held lines (≤ 3, usually none) per rendered frame while one is held |
| lyrics-view.js:1023 | forof |  | NOT-WORTH | the aligned lines (at most the song's line count) · per 'lyrics-aligned' message |
| lyrics-view.js:1037 | forof |  | NOT-WORTH | the changed lines (one or two per message) and their word spans |
| lyrics-view.js:1046 | .forEach | nested | NOT-WORTH | one streamed line's word spans (~5-12), per 'lyrics-stream' message |
| lyrics-view.js:1061 | for |  | NOT-WORTH | one pass over the song's lines · per 'lyrics-refined' / 'lyrics-aligned' message |
| lyrics-view.js:1074 | for | hot('resize'@lyrics-view.js:1136 → placeBacking → xOf) | NOT-WORTH | a node's few offset parents |
| lyrics-view.js:1086 | forof | hot('resize'@lyrics-view.js:1136 → placeBacking) | NOT-WORTH | the song's lines (or the stage's 1-3 shown ones) · when lyrics load, after a resize or new |
| lyrics-view.js:1093 | forof | hot('resize'@lyrics-view.js:1136 → placeBacking) | NOT-WORTH | the lines to place (above) |
| lyrics-view.js:1095 | .map | hot('resize'@lyrics-view.js:1136 → placeBacking) | NOT-WORTH | the lines to place, each its words (~5-12): one layout read for the batch |
| lyrics-view.js:1111 | .forEach | hot('resize'@lyrics-view.js:1136 → placeBacking) | NOT-WORTH | the lines to place (above): class off, two style writes each |
| lyrics-view.js:1127 | .map | hot(paintWords()@lyrics-view.js:1252 → popRoom → edgeOrigin) | NOT-WORTH | one line's words (~5-12), once per line per layout (cached in spans.origins) |
| lyrics-view.js:1129 | .map | hot(paintWords()@lyrics-view.js:1252 → popRoom → edgeOrigin) | NOT-WORTH | one line's words (~5-12), once per line per layout (cached in spans.origins) |
| lyrics-view.js:1138 | forof | hot('resize'@lyrics-view.js:1136) | NOT-WORTH | the song's lines, once per resize |
| lyrics-view.js:1163 | .map | hot(paintWords()@lyrics-view.js:1252 → popRoom) | NOT-WORTH | one line's words, per word change only while its window has no layout |
| lyrics-view.js:1167 | .map | hot(paintWords()@lyrics-view.js:1252 → popRoom) | NOT-WORTH | one line's words (~5-12), once per line per layout (cached in spans.fit) |
| lyrics-view.js:1198 | .map | hot(paintWords()@lyrics-view.js:1252 → popRoom) | NOT-WORTH | one line's words (~5-12) and their syllables, once per line per layout |
| lyrics-view.js:1210 | for |  | NOT-WORTH | the rest of one row's words (~5-12), once per line per layout |
| lyrics-view.js:1218 | for |  | NOT-WORTH | the row's words up to this one (~5-12), once per line per layout |
| lyrics-view.js:1258 | forof | hot(paintWords()@lyrics-view.js:1252) | HOT-PATH-OK | syllables to reset · the previous word's (a handful) per word/syllable change; the whole |
| lyrics-view.js:1260 | forof | hot(paintWords()@lyrics-view.js:1252) | HOT-PATH-OK | syllables to reset · the previous word's (a handful) per word/syllable change; the whole |
| lyrics-view.js:1274 | for | hot(paintWords()@lyrics-view.js:1252) | HOT-PATH-OK | one line's words (~5-12) per word/syllable change (returns above when nothing moved) |
| lyrics-view.js:1292 | .filter | hot(render()@lyrics-view.js:1282) | HOT-PATH-OK | the live lines (1-3), per render (word changes + 2/s time pushes); one small Set |
| lyrics-view.js:1294 | forof | hot(render()@lyrics-view.js:1282) | HOT-PATH-OK | the live lines (1-3, a few in an overlap) per rendered frame |
| lyrics-view.js:1295 | forof | hot(render()@lyrics-view.js:1282) | HOT-PATH-OK | the live lines (1-3, a few in an overlap) per rendered frame |
| lyrics-view.js:1303 | forof | hot(render()@lyrics-view.js:1282) | HOT-PATH-OK | the live lines (1-3) per rendered frame, a set lookup each (no allocation) |
| lyrics-view.js:1326 | .map | hot(render()@lyrics-view.js:1282) | NOT-WORTH | the elements around a countdown (≤ the window's lines), per dots open/close only |
| lyrics-view.js:1331 | .map | hot(render()@lyrics-view.js:1282) | NOT-WORTH | the elements around a countdown (≤ the window's lines), per dots open/close only |
| lyrics-view.js:1331 | .map | hot(render()@lyrics-view.js:1282) nested | NOT-WORTH | the elements around a countdown (≤ the window's lines), per dots open/close only |
| lyrics-view.js:1331 | .map | hot(render()@lyrics-view.js:1282) nested | NOT-WORTH | the elements around a countdown (≤ the window's lines), per dots open/close only |
| lyrics-view.js:1352 | forof | hot(render()@lyrics-view.js:1282) | NOT-WORTH | the elements a dots row moved (at most the window's lines), per open/close |
| lyrics-view.js:1376 | .map | hot(render()@lyrics-view.js:1282 → moveRoom) | NOT-WORTH | the lines in view, per room move (a sung-line change with sheet notes over the line) |
| lyrics-view.js:1382 | .map | hot(render()@lyrics-view.js:1282 → moveRoom) | NOT-WORTH | the lines in view, per room move (a sung-line change with sheet notes over the line) |
| lyrics-view.js:1382 | .map | hot(render()@lyrics-view.js:1282 → moveRoom) nested | NOT-WORTH | the lines in view, per room move (a sung-line change with sheet notes over the line) |
| lyrics-view.js:1395 | forof | hot(render()@lyrics-view.js:1282 → slideTargets) | NOT-WORTH | one pass over the song's lines, per dots open/close (a few per song) |
| lyrics-view.js:1413 | .map | hot(render()@lyrics-view.js:1282 → syncDots) | NOT-WORTH | 3 dots, once per interlude shown (only while g.anims is null) |
| lyrics-view.js:1418 | forof | hot(render()@lyrics-view.js:1282 → syncDots) | NOT-WORTH | the 4 countdown animations, per render while the dots show |
| lyrics-view.js:1426 | forof | hot(render()@lyrics-view.js:1282 → closeDots) | NOT-WORTH | 4 animations |
| lyrics-view.js:1442 | forof | hot(render()@lyrics-view.js:1282 → syncExpressions) | HOT-PATH-OK | the live lines (1-3) x their measured words (0-3), per render |
| lyrics-view.js:1445 | forof | hot(render()@lyrics-view.js:1282 → syncExpressions) nested | HOT-PATH-OK | the live lines (1-3) x their measured words (0-3), per render |
| lyrics-view.js:1455 | .some | hot(render()@lyrics-view.js:1282 → syncExpressions) nested | HOT-PATH-OK | xlive (≤ ~5) per measured word (0-3) of the live lines (1-3), per render |
| lyrics-view.js:1457 | .some | hot(render()@lyrics-view.js:1282 → syncExpressions) nested | HOT-PATH-OK | xlive (≤ ~5) per measured word (0-3) of the live lines (1-3), per render |
| lyrics-view.js:1462 | forof | hot(render()@lyrics-view.js:1282 → syncExpressions) | HOT-PATH-OK | the song's wordless vocalise spans (a few), per render |
| lyrics-view.js:1463 | .some | hot(render()@lyrics-view.js:1282 → syncExpressions) nested | HOT-PATH-OK | the song's wordless vocalise spans (a few), per render |
| lyrics-view.js:1468 | forof | hot(render()@lyrics-view.js:1282 → syncExpressions) | HOT-PATH-OK | the expressions playing (≤ 1-2 stretches + GHOST_MAX ghosts), per render |
| lyrics-view.js:1474 | forof | hot(render()@lyrics-view.js:1282 → syncExpressions) nested | HOT-PATH-OK | one expression's animations (≤ ~14), per render |
| lyrics-view.js:1524 | .map | hot(render()@lyrics-view.js:1282 → syncExpressions → startStretch → slide) | NOT-WORTH | one row's words (~5-12), once per held word (startStretch) |
| lyrics-view.js:1526 | forof | hot(render()@lyrics-view.js:1282 → syncExpressions → startStretch → slide) | NOT-WORTH | one row's words (~5-12), once per held word |
| lyrics-view.js:1535 | forof |  | NOT-WORTH | the same words |
| lyrics-view.js:1543 | .forEach | hot(render()@lyrics-view.js:1282 → syncExpressions → startStretch) | NOT-WORTH | the extra letters (≤ MAX_EXTRA), once per held word |
| lyrics-view.js:1544 | forof |  | NOT-WORTH | ≤ MAX_EXTRA |
| lyrics-view.js:1551 | .forEach | hot(render()@lyrics-view.js:1282 → syncExpressions → startStretch) | NOT-WORTH | the extra letters (≤ MAX_EXTRA), once per held word |
| lyrics-view.js:1559 | .map | hot(render()@lyrics-view.js:1282 → syncExpressions → startStretch) | NOT-WORTH | the extra letters (≤ 5), once per held word (startStretch) |
| lyrics-view.js:1561 | .forEach | hot(render()@lyrics-view.js:1282 → syncExpressions → startStretch) | NOT-WORTH | the vowel and extra letters (≤ ~11), once per held word |
| lyrics-view.js:1576 | .filter | hot(render()@lyrics-view.js:1282 → syncExpressions → startGhost) | NOT-WORTH | xlive (≤ ~5), once per ghost started |
| lyrics-view.js:1578 | .find | hot(render()@lyrics-view.js:1282 → syncExpressions → startGhost) | NOT-WORTH | xlive (≤ ~5), once per ghost started while GHOST_MAX are shown |
| lyrics-view.js:1581 | .filter | hot(render()@lyrics-view.js:1282 → syncExpressions → startGhost) | NOT-WORTH | xlive (≤ ~5), once per ghost started while GHOST_MAX are shown |
| lyrics-view.js:1597 | .forEach | hot(render()@lyrics-view.js:1282 → syncExpressions → startGhost) | NOT-WORTH | a ghost's letters (≤ ~12), once per ghost |
| lyrics-view.js:1629 | forof | hot(render()@lyrics-view.js:1282 → syncExpressions → startGhost → placeGhost) | NOT-WORTH | the song's lines and countdowns (≤ ~150), once per ghost |
| lyrics-view.js:1630 | forof | hot(render()@lyrics-view.js:1282 → syncExpressions → startGhost → placeGhost) | NOT-WORTH | the countdowns (a few), once per ghost |
| lyrics-view.js:1635 | .sort | hot(render()@lyrics-view.js:1282 → syncExpressions → startGhost → placeGhost) | NOT-WORTH | the taken spans in view (≤ ~30), once per ghost placed |
| lyrics-view.js:1639 | forof | hot(render()@lyrics-view.js:1282 → syncExpressions → startGhost → placeGhost) | NOT-WORTH | the taken spans just read, once per ghost |
| lyrics-view.js:1646 | .filter | hot(render()@lyrics-view.js:1282 → syncExpressions → startGhost → placeGhost) | NOT-WORTH | the free gaps (a few), once per ghost placed |
| lyrics-view.js:1651 | .reduce | hot(render()@lyrics-view.js:1282 → syncExpressions → startGhost → placeGhost) | NOT-WORTH | the free gaps (a few), once per ghost placed |
| lyrics-view.js:1665 | forof | hot(render()@lyrics-view.js:1282 → syncExpressions → startStretch → syncOne) | NOT-WORTH | one expression's animations (≤ ~14), once when it starts |
| lyrics-view.js:1668 | forof | hot(render()@lyrics-view.js:1282 → syncExpressions → endExpression) | NOT-WORTH | one expression's animations (≤ ~14) |
| lyrics-view.js:1669 | forof | hot(render()@lyrics-view.js:1282 → syncExpressions → endExpression) | NOT-WORTH | a few style resets |
| lyrics-view.js:1675 | forof |  | NOT-WORTH | the expressions playing (≤ ~5), per song |
| lyrics-view.js:1797 | forof | hot(requestAnimationFrame@lyrics.html:1126 → recenter) | NOT-WORTH | the song's lines, once per layout change |
| lyrics-view.js:1818 | .filter | nested | NOT-WORTH | the song's lines (≤ ~150), once per key press or hover move |
| lyrics.html:826 | forin |  | NOT-WORTH | 3 properties per palette change |
| lyrics.html:1000 | forof | hot(requestAnimationFrame@lyrics.html:1126 → placeGrip) | NOT-WORTH | at most 3 areas and their few controls, once per resize of one of them, never per frame |
| lyrics.html:1006 | forof | hot(requestAnimationFrame@lyrics.html:1126 → placeGrip) nested | NOT-WORTH | at most 3 areas and their few controls, once per resize of one of them, never per frame |
| main.js:47 | forof |  | NOT-WORTH | two variables, once at start |
| main.js:259 | forof | hot('data'@main.js:254) | NOT-WORTH | the lines of one portal signal |
| main.js:324 | for (const el of root.querySelectorAll('button, [role=button |  | NOT-WORTH | one walk per user command (shuffle, repeat, queue), shadow depth ≤ 25 |
| main.js:327 | for (const el of root.querySelectorAll('*')) { |  | NOT-WORTH | one walk per user command (shuffle, repeat, queue), shadow depth ≤ 25 |
| main.js:1052 | .filter | nested | NOT-WORTH | once per first-play section (every ~10-30 s), N ≤ ~500 words so far (filter + sort) |
| main.js:1123 | .map | hot(setInterval@main.js:1284 → alignGuardTick → linuxProbes → ownPids) | HOT-PATH-OK | ≤ 1 game-guard check per 5 s, only while precise timing has work; N ≈ 8 processes |
| main.js:1272 | .filter | hot(setInterval@main.js:1284 → lyricViews) | HOT-PATH-OK | a ≤ 2-window filter, a few calls per 500 ms lyrics tick while a view is open |
| main.js:1276 | forof | hot(setInterval@main.js:1284 → sendLyrics) | HOT-PATH-OK | ≤ 2 views (lyrics window, visualizer), per lyrics push |
| main.js:1348 | .map | hot(setInterval@main.js:1284) | NOT-WORTH | once per song change, LRCLIB shorthand lyrics only; N = markers (≤ ~10) |
| main.js:1350 | .find | hot(setInterval@main.js:1284) | NOT-WORTH | once per song change, LRCLIB shorthand lyrics only; N = markers (≤ ~10) |
| main.js:1943 | forof | await hot(setInterval@main.js:1284 → stageTick → montageTick → resolveMontageSong) | SERIAL-REQUIRED | ≤ 8 photos, one download at a time (Commons' etiquette), the first sent as soon as it is there |
| main.js:2141 | for (let i = 0; next && i < 3; i++) { /* loop: SERIAL-REQUIR |  | SERIAL-REQUIRED | ≤ 3 more pages of a long album's track list, each after the last |
| main.js:2173 | forof |  | NOT-WORTH | the album's tracks (≤ ~100), once per booklet push; in-memory cache lookups |
| main.js:2180 | .map | nested | NOT-WORTH | per booklet push (a few per open), ≤ ~100 tracks × ≤ ~150 lines, in memory |
| main.js:2201 | forof |  | NOT-WORTH | the booklet's sections and pages (≤ ~40), once per booklet push |
| main.js:2202 | forof | nested | NOT-WORTH | the section's pages |
| main.js:2258 | .map | hot(setInterval@main.js:2272) | NOT-WORTH | inside the song-change check: once per song while following, N ≤ ~150 lines |
| main.js:2263 | for | hot(setInterval@main.js:2272) | HOT-PATH-OK | one song's line starts (≤ ~150) per 500 ms tick, only while following |
| main.js:2721 | while |  | NOT-WORTH | once per start, a few KWin rules |
| main.js:2723 | forof |  | NOT-WORTH | once per start, a few KWin rules |
| main.js:2747 | forof | hot(setInterval@main.js:451 → refreshPalette → broadcastPalette) | NOT-WORTH | 3 windows (and the booklet), once per palette change |
| main.js:2765 | forof | hot(setInterval@main.js:451 → refreshPalette → useArtwork → makeBackdrops) | HOT-PATH-OK | 2 × 1,600 pixels, once per track change (measured ~3-6 ms, docs/PERFORMANCE.md) |
| main.js:3366 | .some | hot(setInterval@main.js:2272 → linerPlaying → has) | NOT-WORTH | once per install recheck (helperScan), N = files in one folder; the hot link is a name collision with Map.has |
| main.js:3374 | .some | hot(setInterval@main.js:1284 → preciseTimingOn → alignInstalled → helperScan) | NOT-WORTH | helperScan runs only on alignInstalled(recheck), not per tick; N ≤ ~10 entries |
| main.js:3411 | forof | await | SERIAL-REQUIRED | the models folder (a few files, one level of subfolders), once per Remove… press |
| main.js:3472 | .forEach | hot(setInterval@main.js:3618 → … → getHelperInstaller → helperModelsAbort) | NOT-WORTH | one listener per download |
| main.js:3475 | forof | await hot(setInterval@main.js:3618 → … → getHelperInstaller → helperModels) | SERIAL-REQUIRED | one download at a time (the connection's bandwidth); 2-3 models, once per install |
| main.js:3907 | .find | hot(setInterval@main.js:2901 → pushPanel → panelSnapshot → accOf) | HOT-PATH-OK | per pushPanel (5 s tick), only for a page with no stored open section; N ≤ ~12 |
| main.js:3977 | forof | hot(setInterval@main.js:2901 → pushPanel → panelSnapshot) | HOT-PATH-OK | 20 keys per panel snapshot |
| main.js:4050 | forof |  | NOT-WORTH | ≤ 4 switches, on a click |
| main.js:4093 | forof |  | NOT-WORTH | three event names, once |
| main.js:4146 | forof |  | NOT-WORTH | ≤ 1,000 files (the notes log's cap; the montage folder ≤ 300), once a minute while For the Curious is open |
| main.js:4531 | forof |  | NOT-WORTH | four event names, once |
| main.js:4597 | forof |  | NOT-WORTH | 4 views, once on close |
| main.js:4861 | forof |  | NOT-WORTH | at most two tries: with ExitType=cgroup, then without (systemd older than 250) |
| main.js:4885 | forof |  | NOT-WORTH | the AppImage folder's entries, once at start |
| markdown-lite.js:14 | while | hot(setInterval@main.js:1284 → find → parse → inline) | HOT-PATH-OK | one pass over one line's characters; About is drawn on demand only |
| markdown-lite.js:41 | forof | hot(setInterval@main.js:1284 → find → parse) | NOT-WORTH | one pass over a section's lines (~10-60) |
| media-position.js:59 | forof |  | NOT-WORTH | six event names, once per page load |
| mini-model.js:42 | for | hot(setInterval@main.js:2901 → … → applyMiniBlur → blurRegion) | NOT-WORTH | one pass over the pill's rows (≤ ~150 at 2×), once per mini open / setting change |
| miniplayer.html:303 | forof | hot('pointermove'@miniplayer.html:328 → showTime) | NOT-WORTH | 2 bars |
| model-fetch.js:87 | forof |  | NOT-WORTH | the install's 2-3 models, once per install |
| montage-model.js:87 | for | hot(setInterval@main.js:1284 → … → montageExtremes → extremes) | NOT-WORTH | 256 entries, once per photo |
| montage-model.js:89 | for | hot(setInterval@main.js:1284 → … → montageExtremes → extremes) | HOT-PATH-OK | one pass over the shown photo's pixels (≤ ~2.5 M), once per photo download, in main |
| montage-model.js:115 | .filter | hot(draw()@montage-ui.js:133 → shadeOf → scrimFor) | NOT-WORTH | 7 tokens, once per photo and theme (montage-ui shadeOf caches it by photo id) |
| montage-model.js:115 | .map | hot(draw()@montage-ui.js:133 → shadeOf → scrimFor) nested | NOT-WORTH | 7 tokens, once per photo and theme (montage-ui shadeOf caches it by photo id) |
| montage-model.js:119 | forof | hot(draw()@montage-ui.js:133 → shadeOf → scrimFor → worst) | NOT-WORTH | ≤ 7 tokens × 2 extremes per step, ≤ 20 steps, once per photo and theme change |
| montage-model.js:123 | .every | hot(draw()@montage-ui.js:133 → shadeOf → scrimFor → pass) | NOT-WORTH | ≤ 7 tokens × ≤ 20 steps, once per photo and theme (cached by shadeOf), not per frame |
| montage-model.js:128 | while | hot(draw()@montage-ui.js:133 → shadeOf → scrimFor) | NOT-WORTH | at most 19 steps of 0.02 |
| montage-model.js:129 | .forEach | hot(draw()@montage-ui.js:133 → shadeOf → scrimFor) | NOT-WORTH | ≤ 7 tokens |
| montage-sources.js:61 | for | await | SERIAL-REQUIRED | at most 3 attempts of one request (a busy answer waits, then asks again) |
| montage-sources.js:102 | .map | hot(setInterval@main.js:1284 → … → strings → claims) | NOT-WORTH | one property's claims (≤ ~5), once per resolve (stage-ui's yearOf is another function) |
| montage-sources.js:105 | .filter | hot(setInterval@main.js:1284 → … → reduceItem → strings) | NOT-WORTH | ≤ ~5 claims, per item reduce, once per artist+album resolve |
| montage-sources.js:107 | .map | hot(setInterval@main.js:1284 → … → reduceItem → items) | NOT-WORTH | ≤ ~5 claims, per item reduce, once per artist+album resolve |
| montage-sources.js:110 | .find | hot(setInterval@main.js:1284 → … → reduceItem → yearOf) | NOT-WORTH | ≤ ~5 claims, per item reduce, once per resolve (not drawNowPlaying: a name match) |
| montage-sources.js:120 | .filter | hot(setInterval@main.js:1284 → … → matchBy → byStatement) | NOT-WORTH | ≤ 3 search hits, ≤ 2 per artist+album resolve (cached set otherwise) |
| montage-sources.js:120 | .map | hot(setInterval@main.js:1284 → … → matchBy → byStatement) nested | NOT-WORTH | ≤ 3 search hits, ≤ 2 per artist+album resolve (cached set otherwise) |
| montage-sources.js:124 | .filter | hot(setInterval@main.js:1284 → … → matchItems → entities) | NOT-WORTH | ≤ 10 QIDs, ≤ 3 calls per resolve |
| montage-sources.js:148 | forof | hot(setInterval@main.js:1284 → … → matchItems → matchBy) | NOT-WORTH | ≤ 3 hits, read back together |
| montage-sources.js:169 | .map | hot(setInterval@main.js:1284 → … → resolveMontage → matchItems) | NOT-WORTH | ≤ 2 venues, once per resolve |
| montage-sources.js:186 | .map | hot(setInterval@main.js:1284 → … → resolveMontage → filesNamed) | NOT-WORTH | ≤ 20 names, once per resolve |
| montage-sources.js:195 | .map | hot(setInterval@main.js:1284 → … → resolveMontage → subcats) | NOT-WORTH | ≤ 100 subcategories, ≤ 2 per resolve |
| montage-sources.js:205 | .map | hot(setInterval@main.js:1284 → … → resolveMontage → eraCategories) | NOT-WORTH | ≤ 100 category names, once per resolve |
| montage-sources.js:205 | .sort | hot(setInterval@main.js:1284 → … → resolveMontage → eraCategories) nested | NOT-WORTH | ≤ 100 category names, once per resolve |
| montage-sources.js:205 | .filter | hot(setInterval@main.js:1284 → … → resolveMontage → eraCategories) nested | NOT-WORTH | ≤ 100 category names, once per resolve |
| montage-sources.js:205 | .map | hot(setInterval@main.js:1284 → … → resolveMontage → eraCategories) nested | NOT-WORTH | ≤ 100 category names, once per resolve |
| montage-sources.js:306 | .find | hot(setInterval@main.js:1284 → … → montageWidth → widthFor) | NOT-WORTH | ≤ ~5 widths, ≤ 8 photos per song change |
| montage-sources.js:319 | .filter | hot(setInterval@main.js:1284 → … → arrange → take) | NOT-WORTH | once per artist+album resolve (cached in main.js montageCache), N ≤ ~150 candidates |
| montage-sources.js:328 | for | hot(setInterval@main.js:1284 → … → resolveMontage → arrange) | NOT-WORTH | ≤ MAX_PHOTOS picks from ≤ ~150 candidates, once per artist and album |
| montage-sources.js:348 | .flatMap | hot(setInterval@main.js:1284 → … → resolveMontageSong → resolveMontage) | NOT-WORTH | ≤ 2 venues, once per artist+album resolve |
| montage-sources.js:352 | .map | hot(setInterval@main.js:1284 → … → resolveMontageSong → resolveMontage) | NOT-WORTH | ≤ 2 venues × ≤ 3 images, once per resolve |
| montage-sources.js:352 | .flatMap | hot(setInterval@main.js:1284 → … → resolveMontageSong → resolveMontage) nested | NOT-WORTH | ≤ 2 venues × ≤ 3 images, once per resolve |
| montage-sources.js:354 | forof | hot(setInterval@main.js:1284 → … → resolveMontageSong → resolveMontage) | NOT-WORTH | ≤ ~9 own images, once per song |
| montage-sources.js:357 | forof | await hot(setInterval@main.js:1284 → … → resolveMontageSong → resolveMontage) | SERIAL-REQUIRED | ≤ 2 venues, one Commons request each (one host lane: one at a time anyway) |
| montage-sources.js:364 | .find | hot(setInterval@main.js:1284 → … → resolveMontageSong → resolveMontage) | NOT-WORTH | ≤ 100 subcategories, once per resolve |
| montage-sources.js:367 | forof | await hot(setInterval@main.js:1284 → … → resolveMontageSong → resolveMontage) | SERIAL-REQUIRED | ≤ 2 year categories, one request each |
| montage-sources.js:374 | .map | hot(setInterval@main.js:1284 → … → resolveMontageSong → resolveMontage) | NOT-WORTH | ≤ 2 venues, once per resolve |
| montage-store.js:40 | forof |  | NOT-WORTH | ≤ maxFiles (+ strays) entries, once at the first use |
| montage-store.js:59 | .filter | nested | NOT-WORTH | sort of ≤ maxFiles (400) entries, only when a put pushes the cache over a bound |
| montage-store.js:61 | forof |  | NOT-WORTH | ≤ maxFiles entries, only when a new photo pushed the cache over a bound |
| montage-ui.js:96 | .forEach |  | NOT-WORTH | 2 layers, per new photo set |
| montage-ui.js:197 | .forEach |  | NOT-WORTH | 2 layers |
| notes-log.js:90 | .map | hot(setInterval@main.js:1284 → getAlignSession → sungNotesDone → buildDoc) | NOT-WORTH | the song's lines (tens) · once per sung-notes result (buildDoc) |
| notes-log.js:92 | .map | hot(setInterval@main.js:1284 → getAlignSession → sungNotesDone → buildDoc) | NOT-WORTH | the song's syllables (hundreds) · once per sung-notes result |
| notes-log.js:94 | .map | hot(setInterval@main.js:1284 → getAlignSession → sungNotesDone → buildDoc) | NOT-WORTH | the song's notes (hundreds) · once per sung-notes result |
| notes-log.js:123 | .forEach |  | NOT-WORTH | the song's notes (hundreds), once per check |
| notes-log.js:144 | forof | hot(setInterval@main.js:1284 → … → prune → listLogs) | NOT-WORTH | ≤ MAX_FILES + 1 files, once per write |
| notes-log.js:150 | .sort | hot(setInterval@main.js:1284 → … → prune → listLogs) | NOT-WORTH | once per notes log written (one per song), N ≤ 1000 files |
| notes-log.js:160 | forof | hot(setInterval@main.js:1284 → … → writeLog → prune) | NOT-WORTH | the folder's files (≤ ~1000), once per write |
| notes-log.js:166 | .filter | hot(setInterval@main.js:1284 → … → writeLog → prune) | NOT-WORTH | once per notes log written (one per song), N ≤ 1000 files |
| notes-log.js:169 | for | hot(setInterval@main.js:1284 → … → writeLog → prune) | NOT-WORTH | the oldest extras (usually one), once per write |
| notices-model.js:59 | .filter | nested | HOT-PATH-OK | per show() (≤ 4/s during a helper install's progress), N ≤ 3 actions |
| notices-model.js:104 | forof | hot('resize'@main.js:4528 → railSnapshot → reminders) | NOT-WORTH | N ≤ ~6 notices; on change |
| palette.js:40 | .map | hot(setInterval@main.js:451 → … → extractPalette → toHex) | NOT-WORTH | 3 channels, a few colours per palette, once per track change (not per poll tick) |
| palette.js:54 | for | hot(setInterval@main.js:451 → refreshPalette → useArtwork → extractPalette) | NOT-WORTH | 1,024 pixels (32×32), once per track change |
| palette.js:66 | for | hot(setInterval@main.js:451 → refreshPalette → useArtwork → extractPalette) | NOT-WORTH | 36 hue bins, once per track |
| palette.js:74 | for | hot(setInterval@main.js:451 → refreshPalette → useArtwork → extractPalette) | NOT-WORTH | 36 hue bins, once per track |
| panel-helper.js:68 | forof | hot(setInterval@main.js:1284 → … → shareListener → create) | NOT-WORTH | five buttons, once per body build |
| panel-helper.js:96 | forof | hot(setInterval@main.js:1284 → … → shareListener → create) | NOT-WORTH | five builds, once per body build |
| panel-helper.js:211 | .find | hot(setInterval@main.js:1284 → … → create → keepFocus) | HOT-PATH-OK | per state push (≤ 4/s during an install) only when focus was in the block and lost, N ≤ 6 buttons |
| panel-helper.js:219 | .find | hot(setInterval@main.js:1284 → … → create → keepDangerFocus) | HOT-PATH-OK | per state push only when focus was in the danger zone and lost, N ≤ 6 buttons |
| panel-helper.js:248 | forof |  | NOT-WORTH | five buttons |
| panel-model.js:80 | .map | hot(renderSections()@panel-ui.js:969 → accState → sectionIds) | HOT-PATH-OK | per state push (accState in renderSections and renderMenu), N ≤ 8 sections |
| panel-model.js:92 | .filter | hot(renderSections()@panel-ui.js:969 → accState) | HOT-PATH-OK | per state push, N ≤ 8 pins (includes/indexOf O(n²) with n ≤ 8) |
| panel-model.js:92 | .map | hot(renderSections()@panel-ui.js:969 → accState) nested | HOT-PATH-OK | per state push, N ≤ 8 pins (includes/indexOf O(n²) with n ≤ 8) |
| panel-model.js:107 | .filter | hot(setInterval@main.js:2901 → … → showPanel → accReduce) | NOT-WORTH | per header click, N ≤ 8 pins |
| panel-model.js:111 | .filter | hot(setInterval@main.js:2901 → … → showPanel → accReduce) | NOT-WORTH | per pin click, N ≤ 8 pins |
| panel-model.js:154 | .map | hot(renderSections()@panel-ui.js:969 → sectionStatus) | HOT-PATH-OK | per state push, N = 6 window options |
| panel-model.js:188 | .filter | hot(renderSections()@panel-ui.js:969 → sectionStatus → experimentalStatus) | HOT-PATH-OK | per state push, N = gfx keys (4) |
| panel-ui.js:142 | forof |  | NOT-WORTH | ≤ 3 options, once per body build |
| panel-ui.js:157 | .forEach | hot(renderSections()@panel-ui.js:969 → update) | NOT-WORTH | ≤ 3 options per state push |
| panel-ui.js:189 | forof | hot(renderSections()@panel-ui.js:969 → update) | NOT-WORTH | ≤ 3 buttons |
| panel-ui.js:291 | .find | hot(paint()@panel-ui.js:288) | HOT-PATH-OK | per state push while Shortcuts is open, N = 4 shortcut rows per row's paint |
| panel-ui.js:328 | .map | hot(renderSections()@panel-ui.js:969 → update) | NOT-WORTH | per section render on a state push (not per frame), N = rows of one section (≤ ~20) |
| panel-ui.js:333 | .map | hot(renderSections()@panel-ui.js:969 → update) | NOT-WORTH | only when the row ids changed, N = rows of one section (≤ ~20) |
| panel-ui.js:341 | forof | hot(renderSections()@panel-ui.js:969 → update) | NOT-WORTH | ≤ ~25 rows per state push while About → Graphics or For the Curious is open |
| panel-ui.js:409 | forof |  | NOT-WORTH | a few controls per group |
| panel-ui.js:416 | forof | hot(renderSections()@panel-ui.js:969 → update) | NOT-WORTH | a few controls per group |
| panel-ui.js:437 | forof | hot(renderSections()@panel-ui.js:969 → update → markdown → inlineNodes) | NOT-WORTH | one node per run of text in a line |
| panel-ui.js:447 | forof | hot(renderSections()@panel-ui.js:969 → update → markdown) | NOT-WORTH | one block per heading / paragraph / list of one release |
| panel-ui.js:453 | forof | hot(renderSections()@panel-ui.js:969 → update → markdown) nested | NOT-WORTH | list items of one release |
| panel-ui.js:660 | if (olderShown) a.whatsNew.older.forEach(add) |  | NOT-WORTH | ≤ ~40 releases, only after Show older releases |
| panel-ui.js:693 | forof | hot(renderSections()@panel-ui.js:969 → update) | NOT-WORTH | ≤ 3 groups of a handful of plans, when Coming soon opens or BACKLOG changes |
| panel-ui.js:698 | forof | hot(renderSections()@panel-ui.js:969 → update) nested | NOT-WORTH | ≤ 3 groups of a handful of plans, when Coming soon opens or BACKLOG changes |
| panel-ui.js:785 | forof | hot(renderSections()@panel-ui.js:969 → update) | NOT-WORTH | 4 groups of ≤ 6 credits and 20 pattern rows, once per open |
| panel-ui.js:787 | forof | hot(renderSections()@panel-ui.js:969 → update) nested | NOT-WORTH | 4 groups of ≤ 6 credits and 20 pattern rows, once per open |
| panel-ui.js:797 | forof | hot(renderSections()@panel-ui.js:969 → update) nested | NOT-WORTH | ≤ 6 credits of one group, once per open |
| panel-ui.js:801 | forof | hot(renderSections()@panel-ui.js:969 → update) nested | NOT-WORTH | 20 pattern files, once per open |
| panel-ui.js:814 | .map | hot(renderSections()@panel-ui.js:969 → aboutStatus) | HOT-PATH-OK | per state push while About shows, N ≤ 3 Coming soon groups |
| panel-ui.js:857 | forof | hot(renderSections()@panel-ui.js:969 → update) | NOT-WORTH | 4 links, once per About page |
| panel-ui.js:890 | forof | hot(renderNotices()@panel-ui.js:910 → noticeEl) | NOT-WORTH | ≤ 3 actions |
| panel-ui.js:912 | .map | hot(renderNotices()@panel-ui.js:910) | HOT-PATH-OK | per state push, N = notices in that container (≤ ~6), one JSON.stringify each |
| panel-ui.js:914 | .map | hot(renderNotices()@panel-ui.js:910) | HOT-PATH-OK | per state push, N ≤ ~6 notices; unchanged ones keep their element |
| panel-ui.js:923 | .every | hot(renderNotices()@panel-ui.js:910) | HOT-PATH-OK | per state push, N ≤ ~6 notices, identity compare |
| panel-ui.js:935 | .map | hot(render()@panel-ui.js:1034 → buildPage) | NOT-WORTH | only when the page changes (Settings ↔ About), N ≤ 8 sections |
| panel-ui.js:973 | forof | hot(renderSections()@panel-ui.js:969) | NOT-WORTH | ≤ 8 sections per state push |
| panel-ui.js:994 | .map | hot(renderSections()@panel-ui.js:969) nested | NOT-WORTH | once per section open (body built then), N = a few parts |
| panel-ui.js:1003 | forof | hot(renderSections()@panel-ui.js:969) nested | NOT-WORTH | a section's few controls |
| panel-ui.js:1004 | .filter | hot(renderSections()@panel-ui.js:969) nested | NOT-WORTH | a section's few controls |
| panel-ui.js:1013 | .map | hot(renderMenu()@panel-ui.js:1008) | NOT-WORTH | only when the menu's item count changes (built once), N = 2 |
| panel-ui.js:1026 | .forEach | hot(renderMenu()@panel-ui.js:1008) | NOT-WORTH | 2 menu items per state push |
| panel-ui.js:1045 | .filter | hot(render()@panel-ui.js:1034) | HOT-PATH-OK | per state push, N ≤ ~6 notices |
| panel-ui.js:1053 | .find | hot(render()@panel-ui.js:1034) | NOT-WORTH | once per deep link (reveal.n changes), N ≤ 8 sections |
| portal-shortcuts.js:66 | forof |  | NOT-WORTH | one entry per bound shortcut (4) |
| preload-apple.js:20 | forof |  | NOT-WORTH | ten field names per player event |
| rail-model.js:136 | .map | hot(render()@rail-ui.js:139 → railItems) | HOT-PATH-OK | per rail state push / render, N = 7 items (inner find ≤ 7) |
| rail-ui.js:51 | .forEach |  | NOT-WORTH | 7 items, once at load |
| rail-ui.js:71 | forof |  | NOT-WORTH | 3 status lines, once at load |
| rail-ui.js:131 | .every | hot(render()@rail-ui.js:139 → instant) | NOT-WORTH | the panel's transition durations (1-3), only when the rail opens or closes |
| rail-ui.js:156 | .forEach | hot(render()@rail-ui.js:139) | NOT-WORTH | 7 items per state change |
| rail-ui.js:167 | forof | hot(render()@rail-ui.js:139) | NOT-WORTH | 3 status lines per state change |
| rail-ui.js:187 | .forEach | hot(render()@rail-ui.js:139) | NOT-WORTH | 9 buttons per render |
| rail-ui.js:229 | .forEach |  | NOT-WORTH | 9 buttons per key press |
| recording-id.js:86 | .filter | hot(setInterval@main.js:1284 → timingMismatch) | NOT-WORTH | the song's lines (≤ ~150), once per lookup result and per LRCLIB hit checked (not per tick) |
| recording-id.js:88 | .some | hot(setInterval@main.js:1284 → timingMismatch) | NOT-WORTH | the timed lines (≤ ~150), once per lookup result / LRCLIB hit |
| recording-id.js:124 | forof | hot(setInterval@main.js:1284 → timingMismatch → variantTitle) | NOT-WORTH | a title's 0-3 bracketed parts, once per lookup |
| recording-id.js:153 | forof | hot(setInterval@main.js:1284 → entryFor → findAligned → timingMatches) | NOT-WORTH | the entry's lines (≤ ~150), once per old entry on its first play after the update |
| relaunch.js:23 | forof |  | NOT-WORTH | the entries of one PATH-style variable |
| relaunch.js:44 | forof |  | NOT-WORTH | a fixed list of 15 names |
| settings-store.js:91 | forin |  | NOT-WORTH | ~28 settings, at start |
| settings-store.js:106 | forof |  | NOT-WORTH | one entry per stored key (~30) |
| sheet-notes-model.js:71 | forof |  | NOT-WORTH | at most two accidental signs per name |
| sheet-notes-model.js:102 | forof |  | NOT-WORTH | at most 7 letters |
| sheet-notes-model.js:111 | .map | hot(drawFixed()@sheet-notes-ui.js:144 → keySignature) | NOT-WORTH | per staff build / layout (state push), ≤ 7 signs |
| sheet-notes-model.js:113 | .map | hot(drawFixed()@sheet-notes-ui.js:144 → keySignature) | NOT-WORTH | per staff build / layout (state push), ≤ 7 signs |
| sheet-notes-model.js:126 | forof |  | NOT-WORTH | three clefs × the song's notes (hundreds), once per song |
| sheet-notes-model.js:128 | forof | nested | NOT-WORTH | three clefs × the song's notes (hundreds), once per song |
| sheet-notes-model.js:146 | for | hot(drawRuns()@sheet-notes-ui.js:219 → roomRuns → ledgers) | NOT-WORTH | a few ledger lines per note |
| sheet-notes-model.js:148 | for | hot(drawRuns()@sheet-notes-ui.js:219 → roomRuns → ledgers) | NOT-WORTH | as above |
| sheet-notes-model.js:179 | .filter | nested | NOT-WORTH | per song change or new first-play section, N = notes (hundreds) |
| sheet-notes-model.js:192 | .filter | nested | NOT-WORTH | per song change or new first-play section, N = bars (≤ ~150) |
| sheet-notes-model.js:205 | .map | hot(setInterval@main.js:1284 → … → notesGap → expand) | NOT-WORTH | expand per song (relearnDue) and per sheet state push, N = syllables (hundreds) |
| sheet-notes-model.js:205 | .filter | hot(setInterval@main.js:1284 → … → notesGap → expand) nested | NOT-WORTH | expand per song (relearnDue) and per sheet state push, N = syllables (hundreds) |
| sheet-notes-model.js:207 | .map | hot(setInterval@main.js:1284 → … → notesGap → expand) | NOT-WORTH | per song and per sheet state push, N = notes (hundreds) |
| sheet-notes-model.js:207 | .filter | hot(setInterval@main.js:1284 → … → notesGap → expand) nested | NOT-WORTH | per song and per sheet state push, N = notes (hundreds) |
| sheet-notes-model.js:219 | .filter | hot(setInterval@main.js:1284 → … → notesGap → expand) | NOT-WORTH | per song and per sheet state push, N = bars (≤ ~150) |
| sheet-notes-model.js:249 | forof | hot(setInterval@main.js:1284 → … → relearnDue → notesGap) | NOT-WORTH | the song's syllables (hundreds), once per song shown |
| sheet-notes-model.js:256 | .sort | hot(setInterval@main.js:1284 → … → relearnDue → notesGap) | NOT-WORTH | notesGap once per learned song started, N = lyric lines (tens) |
| sheet-notes-model.js:258 | forof | hot(setInterval@main.js:1284 → … → relearnDue → notesGap) | NOT-WORTH | the song's lines (tens), once per song shown |
| sheet-notes-model.js:266 | forof | hot(setInterval@main.js:1284 → … → relearnDue → notesGap) | NOT-WORTH | the song's lines (tens), once per song shown |
| sheet-notes-model.js:271 | .find | hot(setInterval@main.js:1284 → … → relearnDue → notesGap) | NOT-WORTH | once per learned song started, N = silent runs (a few) |
| sheet-notes-model.js:274 | .filter | hot(setInterval@main.js:1284 → … → relearnDue → notesGap) | NOT-WORTH | once per learned song started, N = lines (tens) × found run (a few) |
| sheet-notes-model.js:276 | .reduce | hot(setInterval@main.js:1284 → … → relearnDue → notesGap) | NOT-WORTH | once per learned song started, N = lines (tens) |
| sheet-notes-model.js:298 | .sort | hot(setInterval@main.js:1284 → … → stats → wmedian) | NOT-WORTH | gate per sheet state push (not per frame), sort of one stretch's notes (tens) per region |
| sheet-notes-model.js:300 | .reduce | hot(setInterval@main.js:1284 → … → stats → wmedian) | NOT-WORTH | per region per state push, N = a stretch's notes (tens) |
| sheet-notes-model.js:303 | forof | hot(setInterval@main.js:1284 → … → stats → wmedian) | NOT-WORTH | a stretch's notes (tens) |
| sheet-notes-model.js:310 | .filter | hot(setInterval@main.js:1284 → … → gate → stats) | NOT-WORTH | stats per region per sheet state push, N = a stretch's notes (tens; the song's once) |
| sheet-notes-model.js:313 | .map | hot(setInterval@main.js:1284 → … → gate → stats) | NOT-WORTH | per region per state push, N = a stretch's notes (tens) |
| sheet-notes-model.js:315 | .reduce | hot(setInterval@main.js:1284 → … → gate → stats) | NOT-WORTH | per region per state push, N = a stretch's notes (tens) |
| sheet-notes-model.js:319 | .map | hot(setInterval@main.js:1284 → … → gate → stats) | NOT-WORTH | per region per state push, N = a stretch's notes (tens) |
| sheet-notes-model.js:321 | .reduce | hot(setInterval@main.js:1284 → … → gate → stats) | NOT-WORTH | per region per state push, N = a stretch's notes (tens) |
| sheet-notes-model.js:332 | for | hot(setInterval@main.js:1284 → … → notesGap → voicedIn) | NOT-WORTH | one stretch's values (≤ a few hundred), once per song |
| sheet-notes-model.js:351 | forof | hot(setInterval@main.js:1284 → … → notesGap → gate) | NOT-WORTH | the song's syllables (hundreds), once per song |
| sheet-notes-model.js:358 | .sort | hot(setInterval@main.js:1284 → … → notesGap → gate) | NOT-WORTH | gate per sheet state push or song (rAF relayout doesn't reach it), N = lines (tens) |
| sheet-notes-model.js:365 | for | hot(setInterval@main.js:1284 → … → notesGap → gate) | NOT-WORTH | the song's lines (tens), once per song |
| sheet-notes-model.js:377 | forof | hot(setInterval@main.js:1284 → … → notesGap → gate) | NOT-WORTH | the song's lines (tens), once per song |
| sheet-notes-model.js:378 | .filter | hot(setInterval@main.js:1284 → … → notesGap → gate) nested | NOT-WORTH | the song's lines (tens), once per song |
| sheet-notes-model.js:394 | .map | hot(setInterval@main.js:1284 → … → notesGap → gate) | NOT-WORTH | per sheet state push, regions (tens) × notes filter (hundreds) ≈ 25k compares |
| sheet-notes-model.js:394 | .filter | hot(setInterval@main.js:1284 → … → notesGap → gate) nested | NOT-WORTH | per sheet state push, regions (tens) × notes filter (hundreds) ≈ 25k compares |
| sheet-notes-model.js:413 | forof | hot(setTimeout re-arm@sheet-notes-ui.js:329 → mark → regionAt) | NOT-WORTH | the song's stretches (tens), per note change |
| sheet-notes-model.js:488 | .filter | hot(setInterval@main.js:1284 → setSheetSong → mergeSections → mergePitch) | NOT-WORTH | mergePitch per song change / new first-play piece, N = pieces (≤ ~60) |
| sheet-notes-model.js:492 | .map | hot(setInterval@main.js:1284 → setSheetSong → mergeSections → mergePitch) | NOT-WORTH | per song change / new piece, N = pieces (≤ ~60) |
| sheet-notes-model.js:494 | .map | hot(setInterval@main.js:1284 → setSheetSong → mergeSections → mergePitch) | NOT-WORTH | per song change / new piece, N = pieces (≤ ~60) |
| sheet-notes-model.js:497 | forof | hot(setInterval@main.js:1284 → setSheetSong → mergeSections → mergePitch) | NOT-WORTH | the song's sections (≤ ~12) × their values (≤ ~800), once per new piece |
| sheet-notes-model.js:499 | for | hot(setInterval@main.js:1284 → setSheetSong → mergeSections → mergePitch) nested | NOT-WORTH | the song's sections (≤ ~12) × their values (≤ ~800), once per new piece |
| sheet-notes-model.js:514 | .sort | hot(setInterval@main.js:1284 → setSheetSong → mergeSections) | NOT-WORTH | mergeSections per song change / new first-play section, N = parts (≤ ~60) |
| sheet-notes-model.js:514 | .filter | hot(setInterval@main.js:1284 → setSheetSong → mergeSections) nested | NOT-WORTH | mergeSections per song change / new first-play section, N = parts (≤ ~60) |
| sheet-notes-model.js:521 | forof | hot(setInterval@main.js:1284 → setSheetSong → mergeSections) | NOT-WORTH | the song's sections or lines processed so far (≤ ~60), once per new one |
| sheet-notes-model.js:525 | forof | hot(setInterval@main.js:1284 → setSheetSong → mergeSections) nested | NOT-WORTH | one section's notes (tens), once per new section |
| sheet-notes-model.js:531 | .sort | hot(setInterval@main.js:1284 → setSheetSong → mergeSections) | NOT-WORTH | per song change / new section, sort of the merged notes (hundreds) |
| sheet-notes-model.js:531 | .map | hot(setInterval@main.js:1284 → setSheetSong → mergeSections) nested | NOT-WORTH | per song change / new section, sort of the merged notes (hundreds) |
| sheet-notes-model.js:542 | .map | hot(setInterval@main.js:1284 → setSheetSong → mergeSections) | NOT-WORTH | per song change / new section, N = notes (hundreds) |
| sheet-notes-model.js:544 | .map | hot(setInterval@main.js:1284 → setSheetSong → mergeSections) | NOT-WORTH | per song change / new section, N = parts (≤ ~60) |
| sheet-notes-model.js:615 | for |  | NOT-WORTH | the song's pitch values (a few thousand) × a 11-value window, once per song or new piece |
| sheet-notes-model.js:619 | for | nested | NOT-WORTH | the window around one value (≤ 11) |
| sheet-notes-model.js:622 | .sort | nested | NOT-WORTH | cleanPitch once per build / new piece, one ≤ 11-value sort per voiced value (a few thousand) |
| sheet-notes-model.js:630 | for |  | NOT-WORTH | the song's pitch values, once per song or new piece |
| sheet-notes-model.js:640 | for |  | NOT-WORTH | the song's pitch values, once per song or new piece |
| sheet-notes-model.js:645 | for | nested | NOT-WORTH | the few values of one dropout (≤ gapMax) |
| sheet-notes-model.js:653 | for |  | NOT-WORTH | the song's pitch values, once per song or new piece |
| sheet-notes-model.js:676 | for |  | NOT-WORTH | the song's pitch values (~20/s, a few thousand), once per song or new piece |
| sheet-notes-model.js:710 | forof | hot(drawRuns()@sheet-notes-ui.js:219 → roomRuns → ledgerAt) | NOT-WORTH | the ledger positions a point needs (a few) |
| sheet-notes-model.js:713 | forof | hot(drawRuns()@sheet-notes-ui.js:219 → roomRuns) | NOT-WORTH | the song's pitch runs and their points (a few thousand), once per build |
| sheet-notes-model.js:716 | forof | hot(drawRuns()@sheet-notes-ui.js:219 → roomRuns) nested | NOT-WORTH | the song's pitch runs and their points (a few thousand), once per build |
| sheet-notes-model.js:728 | forof | hot(drawRuns()@sheet-notes-ui.js:219 → roomRuns) nested | NOT-WORTH | the open ledger stretches (a few) |
| sheet-notes-model.js:735 | .filter | hot(drawRuns()@sheet-notes-ui.js:219 → roomRuns) | NOT-WORTH | roomRuns once per build / new piece, N = runs (hundreds) |
| sheet-notes-model.js:737 | .map | hot(drawRuns()@sheet-notes-ui.js:219 → roomRuns) | NOT-WORTH | the ledger stretches, once per build |
| sheet-notes-model.js:761 | forof |  | NOT-WORTH | the song's sections (≤ ~12), on the 2/s time pushes of the first play's band only |
| sheet-notes-model.js:775 | .filter | nested | NOT-WORTH | spansOf per build / respan, N = notes, runs or syllables (hundreds) |
| sheet-notes-model.js:778 | forof |  | NOT-WORTH | the song's notes, runs or syllables (hundreds), once per build |
| sheet-notes-model.js:790 | .filter | nested | NOT-WORTH | per build / respan, N = pitch runs (hundreds) |
| sheet-notes-model.js:793 | .filter | nested | NOT-WORTH | per build / respan, N = lyric lines (tens) |
| sheet-notes-model.js:804 | .filter | hot(setInterval@main.js:1284 → setSheetSong → lyricSpans) | NOT-WORTH | lyricSpans once per song change (setSheetSong), N = lines (tens) |
| sheet-notes-model.js:807 | .filter | hot(setInterval@main.js:1284 → setSheetSong → lyricSpans) | NOT-WORTH | the song's lines (tens), once per track change |
| sheet-notes-model.js:807 | .map | hot(setInterval@main.js:1284 → setSheetSong → lyricSpans) nested | NOT-WORTH | the song's lines (tens), once per track change |
| sheet-notes-model.js:823 | .some | hot(setTimeout re-arm@sheet-notes-ui.js:329 → mark → seenIn → touches) | HOT-PATH-OK | per note change (≈ 2-4/s, playing and shown), 3 × merged spans (tens-hundreds), no allocation |
| sheet-notes-model.js:838 | forof | hot(setTimeout re-arm@sheet-notes-ui.js:329 → nextSeen) | NOT-WORTH | the song's merged spans (tens to hundreds), per note change while playing and shown |
| sheet-notes-model.js:839 | forof | hot(setTimeout re-arm@sheet-notes-ui.js:329 → nextSeen) nested | NOT-WORTH | the song's merged spans (tens to hundreds), per note change while playing and shown |
| sheet-notes-model.js:872 | forof |  | HOT-PATH-OK | the song's notes (hundreds): one pass per note change while playing and shown (≈ 2-4 per second), no DOM |
| sheet-notes-model.js:877 | forof |  | NOT-WORTH | the song's stretches (tens), per note change |
| sheet-notes-model.js:887 | while | hot(setTimeout re-arm@sheet-notes-ui.js:329 → mark → noteAt) | NOT-WORTH | a binary search over the notes, per note change |
| sheet-notes-store.js:25 | for | hot(setInterval@main.js:1284 → … → fileName → fnv) | NOT-WORTH | a title and an artist (tens of characters), per lookup |
| sheet-notes-ui.js:37 | forin | hot(drawFixed()@sheet-notes-ui.js:144 → sv) | NOT-WORTH | a few attributes per element, at build time only |
| sheet-notes-ui.js:147 | for | hot(drawFixed()@sheet-notes-ui.js:144) | NOT-WORTH | five staff lines, per build |
| sheet-notes-ui.js:155 | forof | hot(drawFixed()@sheet-notes-ui.js:144) | NOT-WORTH | at most 7 key-signature signs, per build |
| sheet-notes-ui.js:175 | forof |  | NOT-WORTH | the song's bars (≤ ~150), per build |
| sheet-notes-ui.js:185 | .forEach |  | NOT-WORTH | the song's notes (hundreds), once per build (a new song, new notes, a form change) |
| sheet-notes-ui.js:194 | forof |  | NOT-WORTH | a note's few ledger lines |
| sheet-notes-ui.js:222 | forof | hot(drawRuns()@sheet-notes-ui.js:219) | NOT-WORTH | the line's ledger stretches, once per build or new piece |
| sheet-notes-ui.js:224 | forof | hot(drawRuns()@sheet-notes-ui.js:219) | NOT-WORTH | the line's voiced runs (hundreds), once per build or new piece |
| sheet-notes-ui.js:227 | for | hot(drawRuns()@sheet-notes-ui.js:219) nested | NOT-WORTH | a run's points |
| sheet-notes-ui.js:231 | forof | hot(drawRuns()@sheet-notes-ui.js:219) | NOT-WORTH | where the line leaves the room (a few per song) |
| sheet-notes-ui.js:305 | forof | hot(setTimeout re-arm@sheet-notes-ui.js:329 → mark) | NOT-WORTH | the drawn notes, on a note change only (a few per second at most), class writes only for the ones whose state changed |
| sheet-notes-ui.js:379 | forof |  | NOT-WORTH | two buttons, per state push |
| shortcuts-model.js:29 | .map | hot(setInterval@main.js:1284 → … → slug → normalize) | NOT-WORTH | per key check (apply, a settings write, a key press), ≤ 4 parts; interval root is a name clash |
| shortcuts-model.js:33 | forof | hot(setInterval@main.js:1284 → … → slug → normalize) | NOT-WORTH | the 1–3 modifiers of one key |
| shortcuts-model.js:40 | .find | hot(setInterval@main.js:1284 → … → slug → normalize) | NOT-WORTH | per key check, N = 11 named keys |
| shortcuts-model.js:43 | .filter | hot(setInterval@main.js:1284 → … → slug → normalize) | NOT-WORTH | per key check, N = 4 modifiers |
| shortcuts-model.js:60 | forof |  | NOT-WORTH | 4 actions |
| shortcuts-model.js:64 | forof |  | NOT-WORTH | 4 actions |
| shortcuts.js:67 | forof |  | NOT-WORTH | 4 actions |
| shortcuts.js:77 | forof |  | NOT-WORTH | 4 actions, when the switch or a key changes |
| shortcuts.js:85 | .filter | nested | NOT-WORTH | when the switch or a key changes, N = 4 actions |
| shortcuts.js:224 | .filter | nested | NOT-WORTH | per snapshot, N = 4 rows |
| song-actions.js:148 | for (const a of root.querySelectorAll('a[href*="/${kind}/"]' |  | NOT-WORTH | one walk per click, shadow depth ≤ 25 |
| song-actions.js:149 | for (const el of root.querySelectorAll('*')) { |  | NOT-WORTH | one walk per click, shadow depth ≤ 25 |
| song-actions.js:278 | .filter | nested | NOT-WORTH | once per Add to playlist menu open, N = Apple's playlists, capped to PLAYLISTS_MAX (100) |
| stage-model.js:40 | .map | hot(setInterval@main.js:1284 → stageTick → cleanQueue) | NOT-WORTH | the queue (≤ QUEUE_MAX 1000), only when its signature changes, read ≤ every 2 s |
| stage-model.js:69 | .filter | hot(drawTrack()@stage-ui.js:516 → trackOf) | NOT-WORTH | the queue (≤ 1000), per now-playing change or queue push, not per frame |
| stage-model.js:71 | .findIndex | hot(drawTrack()@stage-ui.js:516 → trackOf) | NOT-WORTH | the queue (≤ 1000), per now-playing change or queue push, not per frame |
| stage-model.js:99 | for | hot(drawTime()@stage-ui.js:532 → timeLeft) | NOT-WORTH | the queue's songs after the one playing (≤ 1000), once per queue change or song |
| stage-model.js:162 | .map | nested | NOT-WORTH | the song's lines (≤ ~150), once per ↑/↓ key press |
| stage-model.js:168 | for |  | NOT-WORTH | the song's lines (≤ ~150), once per key press |
| stage-model.js:179 | forof |  | NOT-WORTH | the song's lines (≤ ~150), once per hover move over the seek bar |
| stage-ui.js:219 | .map | hot(drawNowPlaying()@stage-ui.js:460 → flip → creditsText) | NOT-WORTH | the song's credit rows (a few), when the credits open |
| stage-ui.js:225 | forof | hot(drawCreditsInto()@stage-ui.js:221) | NOT-WORTH | a song's credit rows (≤ ~12), once per song |
| stage-ui.js:234 | .map | hot(drawCreditsInto()@stage-ui.js:221) | NOT-WORTH | ≤ 2 chips |
| stage-ui.js:413 | forof |  | NOT-WORTH | 2 columns, per form change |
| stage-ui.js:600 | .forEach | hot(drawQueue()@stage-ui.js:570) | NOT-WORTH | the list's rows (≤ 201), once per queue change or song |
| theme-apply.js:48 | forin | hot(render()@theme-apply.js:38) | NOT-WORTH | ~28 tokens, written only when one changed; once per track / theme change |
| theme-apply.js:53 | .forEach | hot(render()@theme-apply.js:38) | NOT-WORTH | one entry per Glass surface on the page (1-2) |
| theme.js:26 | .map | hot(render()@theme-apply.js:38 → themeTokens → mix) | NOT-WORTH | 3 channels, per themeTokens call: only when render()'s key changes (track/theme) |
| theme.js:35 | .reduce | hot(render()@theme-apply.js:38 → themeTokens → worstContrast → stack) | NOT-WORTH | 1-3 layers, per contrast step in themeTokens (on a track/theme change only) |
| theme.js:48 | .map | hot(render()@theme-apply.js:38 → themeTokens → worstContrast) | NOT-WORTH | 2 backdrops (the extremes) |
| theme.js:51 | .map | hot(render()@theme-apply.js:38 → themeTokens → css) | NOT-WORTH | per token when the theme is computed (render key changed), N = 3-4 channels |
| theme.js:81 | while | hot(render()@theme-apply.js:38 → themeTokens) | NOT-WORTH | at most 5 steps of 0.02 |
| theme.js:87 | while | hot(render()@theme-apply.js:38 → themeTokens) | NOT-WORTH | at most ~20 steps of 0.02 |
| theme.js:92 | .every | hot(render()@theme-apply.js:38 → themeTokens → okRgb) | NOT-WORTH | 3 channels, once per themeTokens call (track/theme change) |
| theme.js:99 | while | hot(render()@theme-apply.js:38 → themeTokens) | NOT-WORTH | at most ~30 steps of 0.02 |
| theme.js:104 | while | hot(render()@theme-apply.js:38 → themeTokens) | NOT-WORTH | at most ~15 steps |
| theme.js:107 | while | hot(render()@theme-apply.js:38 → themeTokens) | NOT-WORTH | at most ~15 steps |
| theme.js:112 | for | hot(render()@theme-apply.js:38 → themeTokens) | NOT-WORTH | at most 20 steps |
| theme.js:117 | for | hot(render()@theme-apply.js:38 → themeTokens) | NOT-WORTH | at most 20 steps |
| theme.js:125 | for | hot(render()@theme-apply.js:38 → themeTokens → fitText) | NOT-WORTH | at most 25 steps |
| theme.js:139 | for | hot(render()@theme-apply.js:38 → themeTokens) | NOT-WORTH | at most 25 steps |
| theme.js:148 | for | hot(render()@theme-apply.js:38 → themeTokens) | NOT-WORTH | at most 25 steps |
| theme.js:153 | while | hot(render()@theme-apply.js:38 → themeTokens) | NOT-WORTH | at most ~30 steps |
| theme.js:160 | while | hot(render()@theme-apply.js:38 → themeTokens) | NOT-WORTH | at most ~30 steps |
| theme.js:167 | for | hot(render()@theme-apply.js:38 → themeTokens → fitFill) | NOT-WORTH | at most 20 steps |
| theme.js:181 | while | hot(render()@theme-apply.js:38 → themeTokens → fitWash) | NOT-WORTH | at most ~8 steps of 0.02 |
| theme.js:190 | for | hot(render()@theme-apply.js:38 → themeTokens) | NOT-WORTH | at most 25 steps |
| theme.js:305 | for | hot(setInterval@main.js:451 → … → makeBackdrop → boxBlur) | HOT-PATH-OK | the horizontal pass (see boxBlur's verdict) |
| theme.js:306 | for | hot(setInterval@main.js:451 → … → makeBackdrop → boxBlur) nested | HOT-PATH-OK | the horizontal pass (see boxBlur's verdict) |
| theme.js:308 | for | hot(setInterval@main.js:451 → … → makeBackdrop → boxBlur) nested | HOT-PATH-OK | the horizontal pass (see boxBlur's verdict) |
| theme.js:317 | for | hot(setInterval@main.js:451 → … → makeBackdrop → boxBlur) | HOT-PATH-OK | the vertical pass (see boxBlur's verdict) |
| theme.js:318 | for | hot(setInterval@main.js:451 → … → makeBackdrop → boxBlur) nested | HOT-PATH-OK | the vertical pass (see boxBlur's verdict) |
| theme.js:320 | for | hot(setInterval@main.js:451 → … → makeBackdrop → boxBlur) nested | HOT-PATH-OK | the vertical pass (see boxBlur's verdict) |
| theme.js:337 | for | hot(setInterval@main.js:451 → … → makeBackdrops → makeBackdrop) | HOT-PATH-OK | 1,600 pixels, once per track change |
| theme.js:345 | for | hot(setInterval@main.js:451 → … → makeBackdrops → makeBackdrop) | NOT-WORTH | 3 passes |
| theme.js:350 | for | hot(setInterval@main.js:451 → … → makeBackdrops → makeBackdrop) | HOT-PATH-OK | 1,600 pixels, once per track change |
| theme.js:353 | .map | hot(setInterval@main.js:451 → … → makeBackdrops → makeBackdrop) nested | NOT-WORTH | 3 channels per pixel (1,600 px x 2 modes), once per track change in main (~3-6 ms) |
| theme.js:377 | for |  | NOT-WORTH | at most 20 steps |
| timing-refine.js:58 | .forEach | hot(tick()@listen-session.js:227 → processDue → refineWords → syllablePlan) | NOT-WORTH | a line's words and their syllables (≤ ~40), once per refine |
| timing-refine.js:61 | for |  | NOT-WORTH | a line's words and their syllables (≤ ~40), once per refine |
| timing-refine.js:88 | for | hot(tick()@listen-session.js:227 → processDue → refineWords → align) | NOT-WORTH | the DP: S × M nodes, each over ≤ 5 syllables × 8 onsets (S, M ≤ ~40), a few ms per call; refineWords runs once per line, once its time has passed (listen-session.js) |
| timing-refine.js:89 | for | hot(tick()@listen-session.js:227 → processDue → refineWords → align) | NOT-WORTH | the DP: S × M nodes, each over ≤ 5 syllables × 8 onsets (S, M ≤ ~40), a few ms per call; refineWords runs once per line, once its time has passed (listen-session.js) |
| timing-refine.js:90 | for | hot(tick()@listen-session.js:227 → processDue → refineWords → align) nested | NOT-WORTH | the DP: S × M nodes, each over ≤ 5 syllables × 8 onsets (S, M ≤ ~40), a few ms per call; refineWords runs once per line, once its time has passed (listen-session.js) |
| timing-refine.js:97 | for | hot(tick()@listen-session.js:227 → processDue → refineWords → align) nested | NOT-WORTH | the DP's look-back: ≤ 5 syllables × 8 onsets × the onsets skipped (≤ 8) |
| timing-refine.js:98 | for | hot(tick()@listen-session.js:227 → processDue → refineWords → align) nested | NOT-WORTH | the DP's look-back: ≤ 5 syllables × 8 onsets × the onsets skipped (≤ 8) |
| timing-refine.js:103 | for | hot(tick()@listen-session.js:227 → processDue → refineWords → align) nested | NOT-WORTH | the DP's look-back: ≤ 5 syllables × 8 onsets × the onsets skipped (≤ 8) |
| timing-refine.js:114 | for | hot(tick()@listen-session.js:227 → processDue → refineWords → align) | NOT-WORTH | the best end node, S × M, once per align call |
| timing-refine.js:115 | for | hot(tick()@listen-session.js:227 → processDue → refineWords → align) nested | NOT-WORTH | the best end node, S × M, once per align call |
| timing-refine.js:122 | for | hot(tick()@listen-session.js:227 → processDue → refineWords → align) | NOT-WORTH | backtrack, ≤ S steps |
| timing-refine.js:140 | .map | hot(tick()@listen-session.js:227 → processDue → refineWords) | NOT-WORTH | one line's words (≤ ~15), once per due line per play (noisy song) |
| timing-refine.js:147 | .sort | hot(tick()@listen-session.js:227 → processDue → refineWords) | NOT-WORTH | the line's evidence onsets (≤ ~40) filter/map/sort, once per due line per play |
| timing-refine.js:147 | .map | hot(tick()@listen-session.js:227 → processDue → refineWords) nested | NOT-WORTH | the line's evidence onsets (≤ ~40) filter/map/sort, once per due line per play |
| timing-refine.js:147 | .filter | hot(tick()@listen-session.js:227 → processDue → refineWords) nested | NOT-WORTH | the line's evidence onsets (≤ ~40) filter/map/sort, once per due line per play |
| timing-refine.js:152 | .filter | hot(tick()@listen-session.js:227 → processDue → refineWords) | NOT-WORTH | the line's voiced spans (≤ ~10), once per due line per play |
| timing-refine.js:154 | .some | hot(tick()@listen-session.js:227 → processDue → refineWords → anyOnset) | NOT-WORTH | line's onsets (≤ ~40) per call, a few calls per word, once per due line per play |
| timing-refine.js:157 | forof | hot(tick()@listen-session.js:227 → processDue → refineWords) | NOT-WORTH | the line's onsets (≤ ~40) × its voiced spans, once per refine |
| timing-refine.js:158 | .find | hot(tick()@listen-session.js:227 → processDue → refineWords) nested | NOT-WORTH | the line's onsets (≤ ~40) × its voiced spans, once per refine |
| timing-refine.js:165 | .map | hot(tick()@listen-session.js:227 → processDue → refineWords) | NOT-WORTH | one line's words (≤ ~15), once per due line per play |
| timing-refine.js:169 | .filter | hot(tick()@listen-session.js:227 → processDue → refineWords) | NOT-WORTH | line's onsets (≤ ~40), once per due line per play |
| timing-refine.js:178 | .map | hot(tick()@listen-session.js:227 → processDue → refineWords) | NOT-WORTH | 8 tempos × one alignment each, once per due line per play |
| timing-refine.js:184 | .sort | hot(tick()@listen-session.js:227 → processDue → refineWords) | NOT-WORTH | sort of 8 tempo tries, once per due line per play |
| timing-refine.js:188 | forof | hot(tick()@listen-session.js:227 → processDue → refineWords) | NOT-WORTH | the other tempos (a few) × syllables, once per refine |
| timing-refine.js:190 | for | hot(tick()@listen-session.js:227 → processDue → refineWords) nested | NOT-WORTH | the other tempos (a few) × syllables, once per refine |
| timing-refine.js:196 | for | hot(tick()@listen-session.js:227 → processDue → refineWords) | NOT-WORTH | one re-alignment per matched first syllable (≤ ~15 words), once per refine |
| timing-refine.js:203 | .filter | hot(tick()@listen-session.js:227 → processDue → refineWords) | NOT-WORTH | the line's syllables (≤ ~25), once per due line per play |
| timing-refine.js:208 | .forEach | hot(tick()@listen-session.js:227 → processDue → refineWords) | NOT-WORTH | the line's syllables, once per refine |
| timing-refine.js:216 | for | hot(tick()@listen-session.js:227 → processDue → refineWords) | NOT-WORTH | the line's words with a scan to the nearest anchors (≤ ~15²), once per refine |
| timing-refine.js:219 | while | hot(tick()@listen-session.js:227 → processDue → refineWords) nested | NOT-WORTH | the line's words with a scan to the nearest anchors (≤ ~15²), once per refine |
| timing-refine.js:220 | while | hot(tick()@listen-session.js:227 → processDue → refineWords) nested | NOT-WORTH | the line's words with a scan to the nearest anchors (≤ ~15²), once per refine |
| timing-refine.js:228 | .map | hot(tick()@listen-session.js:227 → processDue → refineWords) | NOT-WORTH | one line's words (≤ ~15), once per due line per play |
| timing-refine.js:236 | for | hot(tick()@listen-session.js:227 → processDue → refineWords) | NOT-WORTH | two passes over the line's words, once per refine |
| timing-refine.js:240 | for | hot(tick()@listen-session.js:227 → processDue → refineWords) | NOT-WORTH | two passes over the line's words, once per refine |
| timing-refine.js:245 | .some | hot(tick()@listen-session.js:227 → processDue → refineWords) | NOT-WORTH | one line's words (≤ ~15), once per due line per play |
| timing-refine.js:247 | .map | hot(tick()@listen-session.js:227 → processDue → refineWords) | NOT-WORTH | one line's words (≤ ~15), once per due line per play |
| timing-refine.js:255 | for | hot(tick()@listen-session.js:227 → processDue → refineWords) | NOT-WORTH | the line's words, with short inner scans to the next anchor, once per refine |
| timing-refine.js:260 | while | hot(tick()@listen-session.js:227 → processDue → refineWords) nested | NOT-WORTH | the line's words, with short inner scans to the next anchor, once per refine |
| timing-refine.js:262 | for | hot(tick()@listen-session.js:227 → processDue → refineWords) nested | NOT-WORTH | the line's words, with short inner scans to the next anchor, once per refine |
| timing-refine.js:265 | for | hot(tick()@listen-session.js:227 → processDue → refineWords) nested | NOT-WORTH | the words up to the next anchor |
| timing-refine.js:270 | .map | hot(tick()@listen-session.js:227 → processDue → refineWords) | NOT-WORTH | one line's words (≤ ~15), once per due line per play |
| timing-refine.js:276 | .find | hot(tick()@listen-session.js:227 → processDue → refineWords) | NOT-WORTH | line's voiced spans (≤ ~10), once per due line per play |
| timing-refine.js:278 | .some | hot(tick()@listen-session.js:227 → processDue → refineWords) | NOT-WORTH | line's onsets (≤ ~40), once per due line per play |
| timing-refine.js:283 | .forEach | hot(tick()@listen-session.js:227 → processDue → refineWords) | NOT-WORTH | the line's words, three passes, once per refine |
| timing-refine.js:284 | forof | hot(tick()@listen-session.js:227 → processDue → refineWords) | NOT-WORTH | the line's words, three passes, once per refine |
| timing-refine.js:288 | .some | hot(tick()@listen-session.js:227 → processDue → refineWords) nested | NOT-WORTH | words × voiced spans (≤ 15 × 10), once per due line per play |
| timing-refine.js:291 | for | hot(tick()@listen-session.js:227 → processDue → refineWords) | NOT-WORTH | words × voiced spans (≤ 15 × 10), once per due line per play |
| timing-refine.js:306 | .map | hot(tick()@listen-session.js:227 → processDue → noiseRate) | NOT-WORTH | the song's interludes (a few), once per due line per play (tens per song) |
| timing-refine.js:310 | forof | hot(tick()@listen-session.js:227 → processDue → noiseRate) | NOT-WORTH | the song's instrumental spans × the onsets heard so far (≤ a few thousand), once per refined line |
| timing-refine.js:313 | forof | hot(tick()@listen-session.js:227 → processDue → noiseRate) nested | NOT-WORTH | the song's instrumental spans × the onsets heard so far (≤ a few thousand), once per refined line |
| timing-refine.js:327 | .map | hot(tick()@listen-session.js:227 → … → mergeLearned → fresh) | NOT-WORTH | one line's words (≤ ~15), once per refined line |
| timing-refine.js:329 | .some | hot(tick()@listen-session.js:227 → processDue → recordLearned → mergeLearned) | NOT-WORTH | one line's words (≤ ~15), once per refined line |
| timing-refine.js:332 | .map | hot(tick()@listen-session.js:227 → processDue → recordLearned → mergeLearned) | NOT-WORTH | one line's words (≤ ~15), once per refined line |
| toast-ui.js:40 | forof |  | NOT-WORTH | ≤ 3 toasts |
| toast-ui.js:49 | .map | hot(render()@toast-ui.js:47) | NOT-WORTH | the toasts (≤ 3), per toast state push, not per frame |
| toast-ui.js:51 | forof | hot(render()@toast-ui.js:47) | NOT-WORTH | ≤ 3 toasts per change |
| toast-ui.js:52 | .map | hot(render()@toast-ui.js:47) | NOT-WORTH | ≤ 3 toasts per change |
| toast-ui.js:84 | forof | hot(render()@toast-ui.js:47) | NOT-WORTH | ≤ 3 toasts |
| toasters.js:161 | forof | hot(renderToast()@visualizer.html:430 → resetFlight) | NOT-WORTH | the pool (~50 flyers), once per scene (re)entry |
| toasters.js:177 | forof | hot(renderToast()@visualizer.html:430 → resizeFlight) | NOT-WORTH | the pool (~50), once per window resize |
| toasters.js:183 | while | hot(renderToast()@visualizer.html:430 → resizeFlight) | NOT-WORTH | grows the pool to its new size (≤ ~50 new flyers), once per resize |
| toasters.js:196 | while | hot(renderToast()@visualizer.html:430 → resizeFlight → placeInOrder) | HOT-PATH-OK | one insertion-sort step over the order (≤ ~50), per launch only |
| toasters.js:197 | while | hot(renderToast()@visualizer.html:430 → resizeFlight → placeInOrder) | HOT-PATH-OK | one insertion-sort step over the order (≤ ~50), per launch only |
| toasters.js:205 | for | hot(stepFlight()@toasters.js:249 → launch → nearest) | HOT-PATH-OK | the pool (~50 flyers) per tried spot, only for a flyer whose wait ran out |
| toasters.js:221 | for | hot(stepFlight()@toasters.js:249 → launch) | HOT-PATH-OK | launch retry · every 0.12–0.3 s of scene time · while every tried spot is within MIN_SEP of a |
| toasters.js:255 | for | hot(stepFlight()@toasters.js:249) | HOT-PATH-OK | two passes over the pool (~50 flyers) per animation frame while the toast scene shows; no allocation |
| toasters.js:269 | for | hot(stepFlight()@toasters.js:249) | HOT-PATH-OK | the second pass: waiting flyers count down, launches (see above) |
| toasters.js:281 | forof |  | NOT-WORTH | the pool (~50); used by the tests, not per frame |
| update-feed.js:49 | .some | hot(setInterval@main.js:3618 → checkEngineFeed → fetchEngineFeed → feedSignedBy) | NOT-WORTH | N = 1 trusted key (2 during a rotation) |
| update-feed.js:76 | for | hot(setInterval@main.js:3618 → checkEngineFeed → judgeOffer → isNewerVersion) | NOT-WORTH | 4 fixed fields |
| update-feed.js:163 | forof | hot(setInterval@main.js:3618 → … → verify → verifyDownload) | SERIAL-REQUIRED | the hash is sequential; stream read of one AppImage (~125 MB) · 64 KB chunks · once per new version · ends at EOF |
| visualizer.html:155 | for | hot(stepBands()@visualizer.html:153) | HOT-PATH-OK | three passes over the bands (n ≈ 48) per animation frame; no allocation |
| visualizer.html:157 | for | hot(stepBands()@visualizer.html:153) | HOT-PATH-OK | three passes over the bands (n ≈ 48) per animation frame; no allocation |
| visualizer.html:158 | for | hot(stepBands()@visualizer.html:153) | HOT-PATH-OK | three passes over the bands (n ≈ 48) per animation frame; no allocation |
| visualizer.html:173 | .sort | hot(frame()@visualizer.html:490 → detectBeat) | HOT-PATH-OK | copy + sort of ≤ 8 intervals per detected beat (≤ 4/s), not per frame |
| visualizer.html:246 | forof |  | NOT-WORTH | 3 properties |
| visualizer.html:328 | for | hot(renderBars()@visualizer.html:319) | HOT-PATH-OK | one pass over the bands (n ≈ 48) per frame; the two gradients per bar are cached |
| visualizer.html:352 | for | hot(renderAurora()@visualizer.html:346) | NOT-WORTH | 6 streamers, once per scene entry |
| visualizer.html:361 | forof | hot(renderAurora()@visualizer.html:346) | HOT-PATH-OK | 6 streamers per frame, two radial gradients each (12 per frame) |
| visualizer.html:380 | for | hot(renderNebula()@visualizer.html:374) | NOT-WORTH | 240 particles, once per scene entry |
| visualizer.html:396 | forof | hot(renderNebula()@visualizer.html:374) | HOT-PATH-OK | 240 particles per frame, a radial gradient each: measured, caching them (per hue, mapped |
| visualizer.html:458 | for | hot(renderToast()@visualizer.html:430) | HOT-PATH-OK | the flyer pool (~50) per frame, one drawImage per visible flyer, no allocation |
| visualizer.js:28 | for | hot('data'@visualizer.js:155 → … → emit → fft) | HOT-PATH-OK | a 1024-point FFT (bit reversal, then log2(n) = 10 butterfly passes), once per |
| visualizer.js:30 | for | hot('data'@visualizer.js:155 → … → emit → fft) nested | HOT-PATH-OK | a 1024-point FFT (bit reversal, then log2(n) = 10 butterfly passes), once per |
| visualizer.js:35 | for | hot('data'@visualizer.js:155 → … → emit → fft) | HOT-PATH-OK | the butterfly passes (n/2 · log2 n = 5,120 per frame), see above |
| visualizer.js:38 | for | hot('data'@visualizer.js:155 → … → emit → fft) nested | HOT-PATH-OK | the butterfly passes (n/2 · log2 n = 5,120 per frame), see above |
| visualizer.js:40 | for | hot('data'@visualizer.js:155 → … → emit → fft) nested | HOT-PATH-OK | the butterfly passes (n/2 · log2 n = 5,120 per frame), see above |
| visualizer.js:55 | for |  | NOT-WORTH | the band edges and the Hann window, once at module load |
| visualizer.js:60 | for |  | NOT-WORTH | the band edges and the Hann window, once at module load |
| visualizer.js:103 | for |  | HOT-PATH-OK | one pass over the chunk (~440 samples per 20 ms) · emits a frame per HOP samples |
| visualizer.js:187 | for | hot('data'@visualizer.js:155 → onData) | HOT-PATH-OK | one pass over the chunk's samples (~440 per 20 ms) · ends with the chunk |
| visualizer.js:194 | for | hot('data'@visualizer.js:155 → onData → addSample → emit) | HOT-PATH-OK | 1024 window samples, BANDS bands over their FFT bins (512 bins in all), once per spectrum frame (~43/s while it shows); one small bars array per frame |
| visualizer.js:197 | for | hot('data'@visualizer.js:155 → onData → addSample → emit) | HOT-PATH-OK | 1024 window samples, BANDS bands over their FFT bins (512 bins in all), once per spectrum frame (~43/s while it shows); one small bars array per frame |
| visualizer.js:199 | for | hot('data'@visualizer.js:155 → onData → addSample → emit) nested | HOT-PATH-OK | 1024 window samples, BANDS bands over their FFT bins (512 bins in all), once per spectrum frame (~43/s while it shows); one small bars array per frame |
| viz-paint.js:38 | forof |  | NOT-WORTH | 13 tokens, once per page load |
| viz-paint.js:61 | for | hot(renderBars()@visualizer.html:319 → barGradients) | NOT-WORTH | once per band count (n ≈ 48), not per frame: 2 gradients per band |
| vocal-detect.js:60 | for | hot(tick()@listen-session.js:227 → startListening → createVocalDetector → makeFft) | NOT-WORTH | the FFT tables (n = 1024), once per detector |
| vocal-detect.js:62 | for | hot(tick()@listen-session.js:227 → startListening → createVocalDetector → makeFft) nested | NOT-WORTH | the FFT tables (n = 1024), once per detector |
| vocal-detect.js:67 | for | hot(tick()@listen-session.js:227 → startListening → createVocalDetector → makeFft) | NOT-WORTH | once per detector |
| vocal-detect.js:70 | for | hot(tick()@listen-session.js:227 → startListening → createVocalDetector → fft) | HOT-PATH-OK | bit-reversal permutation, n = 1024 steps, per analysis frame (~86/s while listening) |
| vocal-detect.js:75 | for | hot(tick()@listen-session.js:227 → startListening → createVocalDetector → fft) | HOT-PATH-OK | log2(n) = 10 butterfly stages, n/2 butterflies each, per analysis frame; no allocation |
| vocal-detect.js:77 | for | hot(tick()@listen-session.js:227 → startListening → createVocalDetector → fft) nested | HOT-PATH-OK | log2(n) = 10 butterfly stages, n/2 butterflies each, per analysis frame; no allocation |
| vocal-detect.js:78 | for | hot(tick()@listen-session.js:227 → startListening → createVocalDetector → fft) nested | HOT-PATH-OK | log2(n) = 10 butterfly stages, n/2 butterflies each, per analysis frame; no allocation |
| vocal-detect.js:92 | .sort | hot(tick()@listen-session.js:227 → startListening → createVocalDetector → median) | HOT-PATH-OK | about 11 copy-and-sorts per second of ≤ 345 floats while listening (~0.05 ms each) |
| vocal-detect.js:106 | for | hot(tick()@listen-session.js:227 → startListening → createVocalDetector) | NOT-WORTH | the window table, once per detector |
| vocal-detect.js:130 | forof | hot(tick()@listen-session.js:227 → startListening → createVocalDetector → reset) | NOT-WORTH | ~10 + 3 small arrays, per reset (song start or seek) |
| vocal-detect.js:131 | forof | hot(tick()@listen-session.js:227 → startListening → createVocalDetector → reset) | NOT-WORTH | ~10 + 3 small arrays, per reset (song start or seek) |
| vocal-detect.js:141 | for | hot(tick()@listen-session.js:227 → startListening → createVocalDetector → processFrame) | HOT-PATH-OK | N = 1024 samples windowed, per analysis frame (~86/s while listening), no allocation |
| vocal-detect.js:149 | for | hot(tick()@listen-session.js:227 → startListening → createVocalDetector → processFrame) | HOT-PATH-OK | vocal-band bins (~150 at 22050 Hz), per analysis frame |
| vocal-detect.js:169 | for | hot(tick()@listen-session.js:227 → startListening → createVocalDetector → processFrame) | HOT-PATH-OK | the band bins (~150), per analysis frame |
| vocal-detect.js:181 | for | hot(tick()@listen-session.js:227 → startListening → createVocalDetector → rise) | HOT-PATH-OK | persist (7) then maxBack (2) frames, per bin per analysis frame (~1,350 steps/frame) |
| vocal-detect.js:190 | for | hot(tick()@listen-session.js:227 → startListening → createVocalDetector → rise) | HOT-PATH-OK | maxBack (2) frames, as above |
| vocal-detect.js:201 | for | hot(tick()@listen-session.js:227 → startListening → createVocalDetector → onsetStep) | HOT-PATH-OK | band bins × (persist + maxBack) frames |
| vocal-detect.js:211 | for | hot(tick()@listen-session.js:227 → startListening → createVocalDetector → onsetStep) | HOT-PATH-OK | the threshold window (~130 values), every 4th frame; median() copies and sorts |
| vocal-detect.js:220 | while | hot(tick()@listen-session.js:227 → startListening → createVocalDetector → onsetStep) | HOT-PATH-OK | drains cand down to 2·peakHalf+1 entries; at most a few per frame, each over ≤ 7 candidates |
| vocal-detect.js:223 | for | hot(tick()@listen-session.js:227 → startListening → createVocalDetector → onsetStep) nested | HOT-PATH-OK | drains cand down to 2·peakHalf+1 entries; at most a few per frame, each over ≤ 7 candidates |
| vocal-detect.js:239 | for | hot(tick()@listen-session.js:227 → startListening → createVocalDetector → voicedStep) | HOT-PATH-OK | the band bins (~150), per analysis frame |
| vocal-detect.js:243 | for | hot(tick()@listen-session.js:227 → startListening → createVocalDetector → voicedStep) | HOT-PATH-OK | band bins with a ±4-bin running sum (~150 + 4), per analysis frame |
| vocal-detect.js:244 | for | hot(tick()@listen-session.js:227 → startListening → createVocalDetector → voicedStep) | HOT-PATH-OK | band bins with a ±4-bin running sum (~150 + 4), per analysis frame |
| vocal-detect.js:260 | .sort | hot(tick()@listen-session.js:227 → startListening → createVocalDetector → voicedStep) | HOT-PATH-OK | every 8th frame (~11/s while listening): copy + sort of ≤ 345 floats, ~0.05 ms each |
| vocal-detect.js:310 | for | hot(tick()@listen-session.js:227 → startListening → createVocalDetector → push) | HOT-PATH-OK | one step per sample frame of the chunk (~440 per chunk); a window is analysed every H samples |
