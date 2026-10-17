# Changelog

Release notes for Sonata. A tag's GitHub release takes its notes from the
section named after its version (`## [X.Y.Z] — Short title`; the title after
the dash becomes the release title), or from `[Unreleased]` when there is none.
See docs/RELEASING.md.

## [Unreleased]

### Changed

- **Backing vocals come in under the words they answer.** The smaller line of backing vocals under a lyric line now starts right under the word where the backing voices come in, or under the words they echo, so you can see where in the line they answer. They're set in italics with a small ↳, light up word by word as before, and follow the singer's side in duets. When they come in after the line, they start where it ends.

### Fixed

- **Backing vocals are easier to read.** Backing vocals not sung yet were fainter than the rest of the lyrics (as low as 2.1:1 contrast). They now meet the same 3:1 as the lines not being sung, in every theme, album colour and with Glass, and still look quieter than the main line.

## [0.15.40-dev.1] — The lyrics window drags again

### Fixed

- **The lyrics window drags again.** Since 0.15.39 (Electron 45), a few seconds into a song you could no longer move the lyrics window by its header: the lyric lines that had scrolled out of view still counted as "not for dragging" over the header. The header now always drags, with the cover and the close button still working; keyboard and screen-reader order are unchanged.
- **Lyrics no longer slide sideways.** The lines could scroll a little to the side, cutting off their first letters at the card's left edge. They now only scroll up and down.

### Changed

- **The sung notes log keeps up to 1,000 songs** (about 110 MB), up from 200; the oldest are removed first.

## [0.15.39-dev.1] — Electron 45, global shortcuts, the album cover and a keyboard pass

### Added

- **View the album cover.** Right-click the cover in the lyrics window or the mini player (or press the Menu key on it), or choose View Album Cover in the mini player's More menu, and the song's cover opens large in the middle of your screen, as sharp as your screen can show it. Esc, a click anywhere or Close puts it away.
- **A tonearm on the spinning record.** With "Spin album art like a record" on, a small tonearm rests on the lyrics window's record and moves inward as the song plays, like the real thing. It lifts when you pause, at the end of the song, and swings back for the next one.
- **Songwriter credits.** The lyrics window ends with "Written by …" when Apple has the song's writers, from Apple's lyrics or its catalog.
- **Global shortcuts** (Settings → Global shortcuts, off by default). Play or pause, skip to the next or previous song, and show or hide the lyrics window from any app, with Ctrl+Alt+P, Ctrl+Alt+Page Down, Ctrl+Alt+Page Up and Ctrl+Alt+Y. On Wayland (KDE Plasma, and GNOME versions that offer it) your desktop asks you once to confirm the keys and keeps them in its own shortcut settings; "Change keys…" opens its editor. On X11 you change the keys right in the section: press the button and then the new keys. If your desktop can't give apps global shortcuts, the section says so. Your keyboard's media keys keep working as before, with or without this.
- **Lyrics by keyboard.** Tab into the lyrics and you land on the line being sung; ↑ and ↓ move from line to line (Home and End to the first and last), and Enter or Space plays from that line, as a click does. While you choose, the list stays where you are instead of following the song. Esc closes the lyrics window, Ctrl+Shift+L and Ctrl+Shift+V work in it (and in the visualizer) as they do in the main window and the mini player, and the album cover is a button you can reach with Tab. With a mouse, nothing looks different.
- **A clear focus ring everywhere you use the keyboard.** The lyrics window's and the mini player's buttons, cover and lines show the theme's ring colour when you reach them with the keyboard, like the rail and Settings, never the browser's own.
- **Screen readers hear what matters, once.** The mini player says the new song when it starts, the lyrics window says when a song has no lyrics or the lyrics service is busy, and the visualizer says the name of the scene you switch to. The lyrics themselves are never read out word by word. Lyrics carry their language, and the mini player's Mute and Repeat say whether they're on (and "Repeat one").
- **Sung notes (developer log)** (Settings → Precise timing, experimental, Development channel only, off by default). After a song's whole-song alignment, Sonata works out the sung notes from the vocals it has already separated and saves only the notes (no audio) as one file per song in `~/.local/share/apple-music-for-linux/notes-log/`, at most 200 songs, oldest removed. Each file names the song, the Sonata version and the models, with the song's tuning, a key estimated from the notes, and each note's time, pitch, syllable and confidence. Turning the switch on first downloads the RMVPE pitch model (173 MiB, MIT licence) into the helper's models folder; nothing downloads while it is off. It runs after the song's words have been delivered, never before, follows the gaming guard, and adds about 1 second per song (0.4 s on the graphics card). A line under the switch says what happened to the last song, including why notes were skipped. `tools/notes-log.py` turns a file into a note listing per lyric line and a staff picture, for judging live recordings. This is the groundwork for live sheet notes; nothing is shown in the lyrics yet.
- **Check where your download came from.** Releases now carry a GitHub build attestation for the AppImage and the update feeds: a signed record that Sonata's own release workflow on GitHub built the file, and from which commit. Anyone can check a download with `gh attestation verify sonata-X.Y.Z-x86_64.AppImage -R MarcelineVPQ/apple-music-for-linux`. Sonata's updates are checked as before (the feed's signature, the file's size and SHA-512); this is an extra check for you. Releases up to 0.15.38-dev.1 don't have one.
- **The README says how Sonata is built and tested**: its views, the one theme system, the tests and checks, CI, the signed Stable and Development feeds, and how an update gets from GitHub to your computer, step by step.

### Changed

- **Newer engine: Electron 45 (castlabs 45.0.0-alpha.14, Chromium 156), an alpha for the Development channel only.** Sonata still uses castlabs' Electron, so Apple Music's protected (Widevine) playback keeps working; Stable stays on its current engine until castlabs ships 45 as a stable release. Startup time is the same and Sonata uses about 7 % less memory (about 800 instead of 860 MB on a test copy). The Copy Link menu item, the mini player, the lyrics window and the visualizer were adjusted for the new engine's changes (Linux windows without a frame would otherwise get rounded corners), so they look and work as before.
- **The visualizer's bars scene is lighter.** It used to make two new colour gradients for every bar on every frame; it now makes them once and reuses them. That is about 13 % less drawing work for the visualizer page at the same frame rate, and the bars look the same. The visualizer's colours now come from Sonata's one theme system, like the rest of the app. Nothing changes in the picture.
- **About → Credits lists each hyphenation pattern's exact licence and version**, after a check of every file, and links the original copyright and licence notice of every pattern file, which now ships with Sonata (`licenses/hyphenation-NOTICES.txt`).
- **Romanian and Indonesian lyrics no longer get estimated syllables.** Their hyphenation pattern files carry no licence Sonata can ship them under, so they were removed; words in those languages light up whole, as in other languages without patterns. We'll ask the authors and bring them back if they agree.
- **About looks like the DS5 app's About.** It opens on the 42 Pixel Studios card: Sonata's icon, "A 42 Pixel Studios production", who made it, the version and update channel, and buttons for 42pixelstudios.com, github.com/MarcelineVPQ, the source code (GPL-3.0) and reporting an issue. Below it: App changes (the release notes, with a link to all releases), Coming soon (the plans as cards, grouped by status) and Credits ("Built on", then one What | Credit table with every third-party part and licence). The separate Links section is gone; its links are on the card.
- **"Reduce motion" on your desktop is respected.** With it on, the sung word still lights up but doesn't pop, syllables don't bounce, held notes don't lift, the countdown dots only fill, the lines don't slide or scroll smoothly, the cover doesn't flip, and the visualizer's lyrics fade in without rising. The visualizer's moving scenes (aurora, nebula and the flying toasters) go at a third of their speed and the nebula no longer blooms on the beat; the bars stay as they are. The spinning record stays, since you turn it on yourself.
- **Shuffle, repeat and the lyrics button show a small dot when on**, as well as the colour, so their state never depends on telling colours apart.
- **Precise timing says which lines it didn't trust.** Its log now names each line it left estimated and how sure it was, for example `rejected: line 12 (0.14) "(Hey-hey-ay-ay-ay)"`. Keeping such lines anyway was measured and left out: on the 79-song benchmark they were placed further off than the estimate.

### Fixed

- **A failed Favorite or Add to Library now says so.** When Apple Music didn't take a Favorite, Undo Favorite or Add to Library from the mini player's ⋯ menu, nothing told you: the song just wasn't in your favorites or library. Sonata now shows a desktop notification ("Favorite didn't go through"), or a notice at the top of the side panel when the main window is open.
- **Scrobbles are no longer lost when Last.fm can't be reached.** A scrobble that failed (offline, Last.fm down or busy) used to be dropped. It now waits and is sent again later, also after a restart, until Last.fm has it. Last.fm takes scrobbles up to 14 days old, so one waiting longer than that is let go. Nothing is scrobbled twice.
- **Lyrics that didn't load are no longer shown as "no lyrics".** When Apple Music's lyrics lookup failed (for example while the page was loading), the song read as having no lyrics until the next track. Sonata now asks Apple again a few times. With LRCLIB lyrics on, LRCLIB stands in, and the note says Apple Music's didn't load; otherwise the window says they didn't load and asks again later, instead of claiming there are none.
- **The visualizer no longer freezes when its sound capture stops.** When Sonata can't find its own audio stream, the visualizer listens to the whole system's sound instead. If that capture (parec) ended, the bars stopped where they were until you reopened the visualizer. It now restarts by itself (after 1, 2, 4, 8 and 16 seconds), and the bars fall to silence meanwhile. If it keeps stopping, or parec isn't installed, the visualizer says so in the top corner instead of showing a still spectrum.
- **"Hey-hey-ay-ay-ay" is sung as words.** A run of words joined by hyphens counted as one word, so its estimated timing was too short and precise timing placed it as one block. Each part is now its own word for the estimate and for precise timing, and it is still written as one ("(Hey-hey-ay-ay-ay)", no spaces). Songs with such a run that were aligned before are aligned again the next time they play with the lyrics window or the visualizer open; the others keep their saved timing.
- **Live recordings no longer take a studio version's timed lyrics from LRCLIB.** When LRCLIB has synced lyrics only for another recording of the song, Sonata now shows its words without the wrong timing, and it picks a live record for a live cut (and a studio record for a studio cut) when both are there.
- **Precise timing fills in lines it missed.** When part of a line wasn't heard (a jump inside a verse), that verse is aligned again on a later play, at most twice, recording only that verse.

Measured on the 79-song benchmark and the songs in the library cache: nothing got worse (details in docs/LYRIC-TIMING.md "Lyrics fine-tuning"). Held notes in the middle of a line were measured too; guessing them from the words alone cost more than it gained, so they stay with precise timing, which already holds them.

## [0.15.38-dev.1] — Leaner lyrics, precise timing pauses while you game

### Added

- **Pause word timing while gaming** (Settings → Precise timing, on by default). While a game runs (Feral GameMode, a Steam game, or another program keeping the graphics card busy), precise word timing starts no new work, and its helper quits after its current song part to free graphics memory. Songs keep their estimated timing, the lyrics note says "Precise timing paused while you play", and what was missed is aligned on a later play. It goes on 30 seconds after the game ends.

### Changed

- **Lyrics are lighter on your computer.** The lyrics window and the visualizer's lyrics now animate the way graphics cards like it. The line colour, the sung word, the syllable glow and the countdown dots all move without redrawing the window on every frame. While a song is sung, the lyrics window's drawing work dropped by about 60 %. The one look change is on purpose: the lines not being sung are no longer softly blurred, they are sharp. After a break in the singing, the list now settles exactly centred on the countdown dots.
- **The visualizer rests while the music is paused.** When you pause, the scene settles for half a second and then stays still, using no drawing at all, until you press play again. It picks up right where it stopped. Before, it kept animating at full speed while paused.
- **Precise word timing is lighter on your PC.** While the graphics card does the work, the helper now uses 4 processor threads instead of one per core, which halves its processor time (66–71 to 31 CPU seconds for six songs) at the same speed. After each song it gives back the graphics memory it no longer needs: about 1.7 GB stays in use between songs instead of 3.5 GB. Before each job it checks that enough graphics memory is free (what the job needs plus 1 GB), and waits for a later play if not.
- **Each song is separated only once.** The last pass over the whole song used to separate the vocals again; it now reuses the vocals of the sections it has already done. That is 41 % less graphics card time per song (5.7 to 3.4 seconds) with the same word timing.

Measured on an isolated copy (software rendering, so compare before and after, not absolute numbers): style work in the lyrics window while singing went from 60 to 6 times a second, layouts from 3.7 to 1, and animations the graphics card couldn't run from 4 to 0. The paused visualizer went from 60 frames a second to none. Details in docs/PERFORMANCE.md.

### Fixed

- **Precise word timing no longer depends on the app you installed it from.** Installed from a code editor's terminal (a snap such as Codium), its helper used that editor's private copy of Python, and an update of the editor would have broken it. `align/install.sh` now always uses your system's Python and never puts the helper inside another app's folder, and Sonata tells you at start when an install needs a rebuild (`align/install.sh --rebuild`, which keeps the downloaded models), instead of failing quietly.

## [0.15.37-dev.1] — Track length in your media controls, readable lyrics ahead

### Fixed

- **Your desktop's media controls show the song's length and progress, under the name Sonata.** The media widget (KDE's, GNOME's and others that use MPRIS) listed Sonata as "apple-music-for-linux" with no track length and no progress bar, because Apple's player doesn't give the length to the browser engine. Sonata now tells it the song's length and position from Apple Music itself, when a song starts, plays, pauses or is moved to another point, so the widget shows the progress bar and follows a seek. Your settings, login and lyrics cache stay where they are.
- **The words still to come in the sung line are readable in light mode.** They were faded so far that on the light lyrics card they looked nearly white (as low as 1.7:1). They now fade only as far as the theme allows them to stay readable (at least 4.5:1) in light and dark, with or without album colours and Glass; the words already sung keep the singer's colour.

### Changed

- **Built and checked the 42 Pixel Studios way.** Every push is now tested on GitHub. The version is set in one step for every file that carries it, and a release whose tag doesn't match it stops. Every loop, timer, listener and error path in the app carries a written verdict, checked automatically. Nothing changes in use.

## [0.15.36-dev.1] — Sonata comes back after Restart now

### Fixed

- **Sonata comes back after "Restart now".** After an update, the restarted Sonata could keep running without a window or a tray icon, and opening it from the menu did nothing (seen going from 0.15.34 to 0.15.35-dev.1). The restart handed on a path into the previous version's AppImage, which is gone once that version quits; looking up a helper program through it failed, and that failure stopped Sonata's startup before the window. The restart now hands on only your desktop session's settings, Sonata ignores such leftover paths when it starts (so updating from an affected version works too), a failing helper only costs the light/dark detection, and opening Sonata again always brings up its window.

## [0.15.35-dev.1] — Hyphenated syllables bounce, and estimated lines wait for the singer

### Fixed

- **"Hey-hey-ay-ay-ay" bounces syllable by syllable.** A word made of hyphenated parts was one block to the syllable pop, so it lit up without any bounce. Each hyphen is now a syllable boundary ("(Hey-", "hey-", "ay-", "ay-", "ay)"), and the brackets stay on the outer parts. It is still one word, so the word highlight, saved precise timing and repeated lines work as before.
- **Estimated lines no longer start early on songs whose singer comes in late.** On some songs, live recordings especially, the lyrics' line times come up to about a second before the voice. With precise word timing or Refine timing by listening on, Sonata now learns how far behind the line times the singer comes in (from at least three lines it has heard), and the lines it still has to estimate start their words that much later. The line itself still lights at its usual time.

Measured on a first listen with precise word timing: on "So Alive (Live)" (The Goo Goo Dolls) the estimated words went from 0.66 s early on average to 0.38 s, and words within 0.3 s from 19 % to 39 %. Across the seven live songs in the library cache the median error went from 0.58 s to 0.37 s (words within 0.3 s from 26 % to 43 %), on the 26 studio songs it stayed at 0.17 s (69 % within 0.3 s, was 67 %), and the 79-song benchmark is unchanged. Details in docs/LYRIC-TIMING.md.

## [0.15.34-dev.1] — Held notes stay lit

### Fixed

- **A held note stays lit for the whole hold.** When a singer holds a word (the "home" in "Come take me home"), its highlight now lasts until the voice stops, even after the next line has begun: the next line becomes current and the held word keeps glowing beside it, then lets go. It works from every kind of timing:
  - **Precise word timing:** the aligner now follows the voice on the separated vocals past where a word's letters end, so a held vowel isn't cut off after a fraction of a second. Songs aligned before are aligned again the next time they play with the lyrics window or the visualizer open.
  - **Estimated timing:** the last word of a line may hold for up to 3 seconds (it was 1), until just before the next line, to Apple's line end when it has one, and over the next line when Apple's line runs past it.
  - **Refine timing by listening:** the held notes it already finds now stay held through everything else.
- **The bounce stays on the held syllable.** The held note's last syllable carries the hold, and after the first pop it settles into a gentle lift for as long as the note lasts, instead of popping again. In the lyrics window and the visualizer.

Measured on 79 songs with hand-marked word ends: held notes whose highlight ended early went from 58 % to 35 % (lyrics with line starts only), from 78 % to 26 % (with line ends), and from 50 % to 20 % with precise word timing. Details in docs/LYRIC-TIMING.md.

## [0.15.33] — Each duet voice in its own colour

### Added

- **Duets in two colours.** In songs with two singers, the second singer's line and words light up in a second colour from the album art (its next strongest colour, kept well apart from the first on the colour wheel; for art with only one colour, or black and white, a clearly different partner colour). Lines sung together take the colour halfway between the two. Background vocals keep their dimmer style, in their singer's colour. The singers still sit on their own sides, so colour is never the only cue, and every colour keeps at least 4.5:1 contrast in light and dark. In the lyrics window and the visualizer.

### Changed

- **The side panel has no hide button any more.** The rail's Settings or About item is the one way to show or hide it (press it again to hide), plus Esc for the drawer in a narrow window, as in the DS5 app.
- **No greyed-out update controls when running from source.** Settings → Updates then says in one line that only the AppImage updates itself. *Back to stable* shows only where it can do something: on the Development channel or a development build.

### Fixed

- **The mini player's ⋯ and favourite star can be clicked again.** Pointing at the middle of the pill swapped the whole title row, buttons included, for the scrubber, so the ⋯ and the star vanished under the pointer. They now sit beside the song and always stay put; only the title and artist turn into the scrubber, after the pointer has rested on them for a moment (passing over on the way to the buttons doesn't flicker). With nothing playing there's no scrubber at all, the star steps aside, and the ⋯ menu still opens (Lyrics, Visualizer, Always on Top, Open Full Player). From the keyboard, Tab reaches the bar (the scrubber opens), then the star and the ⋯.

## [0.15.32] — Settings beside the page, Glass and updates you can see

### Added

- **Settings and About in the main window.** The rail's Settings and new About items open a panel beside Apple's page instead of a separate window; Apple's page makes room for it, like the pinned rail. Pressing the item again hides it. In a narrow window it slides in as a drawer over the page (Esc closes it). Its sections fold and unfold one at a time; pin the ones you want to keep open. A small ⋮ menu collapses all of them or clears the pins. Sonata remembers which sections were open. The tray's *Settings…* and the new *About Sonata* open the panel (and bring the window back if it was hidden).
- **Every setting found its section:** Playback & lyrics, Precise timing, Appearance, Mini player & windows, Integrations (Last.fm, Discord), Updates and Startup. Each header says the current state in a few words. New: a Theme choice (same as the desktop, light or dark).
- **About:** what's new in this version (older releases one click away), what's coming soon, credits and licences (castlabs Electron, LRCLIB, the hyphenation patterns language by language, the sonata-align models, the toaster's lighting from Poly Haven), the "not affiliated with Apple" note, and links to the source, bug reports and 42 Pixel Studios.
- **Glass look** (Settings → Appearance, on by default): the rail, the panel, the lyrics window and the mini player share one material made from the album artwork, blurred and tinted, like Apple's own now-playing screens. It changes with the track (a short crossfade) and is otherwise still. Words keep at least 4.5:1 contrast over the busiest artwork. On KDE (X11) the mini player blurs your desktop behind it instead.
- **Mini player, Apple-style:** one pill with a hairline outline. Point at the song to get a scrubber with bigger times and a longer, thicker bar: click or drag to seek, or use ← / → (5 s) when it has the focus. The lyrics button lights up while the lyrics window is open.
- **Mouse wheel on the volume:** over the mini player's volume slider or speaker, and over the volume in Apple's player bar: 5 % per notch, up is louder. A trackpad's small movements add up to notches.
- **Updates you can see:** "Sonata X is available" with *Update* and *Details* (the release notes), a progress bar while it downloads, "Sonata X is installed" with *Restart now* (only while nothing plays; otherwise it starts next time), and "Updated to X" with *See what's new* after the restart. *Install updates automatically* is asked once and can be changed any time; *Check for updates automatically* off means Sonata goes online for updates only when you press *Check now*.
- **Back to stable:** on the Development channel, Settings → Updates → *Back to stable* installs the newest stable release, even if it's older (it asks first). Switching the channel alone never installs an older version.
- **Repaired, not reset:** if Sonata's settings file or lyrics cache gets damaged (a crash in the middle of a save), Sonata keeps everything that still reads, puts only the damaged parts back to their defaults, keeps a copy of the damaged file beside it, and says so once.

### Changed

- **Less drift in estimated word timing on a song's first play.** When a song only has line timing (most Apple lyrics and LRCLIB), Sonata now times the words at the pace the line is sung instead of stretching them across the pause that follows. The words no longer lag further and further behind toward the end of a line or verse: on Marcy's songs the average error of a word's start went from 353 ms to 307 ms, and on 79 test songs with hand-annotated words from 341 ms to 282 ms. Measured with a new drift check, details in docs/LYRIC-TIMING.md.
- **Precise word timing helps during the first play.** With Precise word timing on, each part of the song (the lines between two breaks) is lined up with the singing as soon as it has been sung, while the song plays on, instead of only after the song ends. The parts still to come take the pace the singer actually sang at, and a chorus that comes back takes the timing of its first, aligned appearance. First-play error with it: 223 ms on Marcy's songs (243 ms on the test songs).
- **One colour system for every Sonata window.** The rail, the panel, notices, the lyrics window, the mini player and the visualizer's text all take their colours from one set, light or dark and tinted by the album, with contrast checked.
- **Notices instead of pop-ups.** Connecting Last.fm or Discord, update results and similar messages appear in the panel (with their buttons and a ×) or as short notifications at the bottom right, not as separate dialog windows.
- Settings are saved safely (a new file is written, then swapped in), so a crash can't leave a half-written settings file.

### Removed

- The separate Settings window (everything is in the panel now).

## [0.15.31] — The rail never covers Apple's page

### Fixed

- **A pinned rail no longer covers Apple's lyrics or queue panel.** The rail now has a space of its own beside Apple's page instead of sitting inside it. Apple's page is simply narrower by the rail's width, so everything Apple shows (its lyrics and queue panels, the full-screen player, sheets, menus and notices) ends where the rail begins, signed in or not. Unpinned, the rail keeps its slim icon column and opens over the page when you point at it, then gives the space back.

### Changed

- **Keyboard between the page and the rail.** Tab past the last item of Apple's page, or Shift+Tab before its first, moves into the rail. Tab or Shift+Tab leaves the rail again. **F6** jumps between the page and the rail. Ctrl+B and the other shortcuts work wherever the keyboard is.
- **The rail's surface is a tint without blur.** A blur can't reach across to Apple's page any more, so the open rail is a nearly solid (90 %) album-coloured tint over the page, and fully solid where it has its own space. Labels keep at least 4.5:1 contrast.
- The rail runs in its own small process (about 34 MB). Sign-in, cookies and settings are unchanged; you stay signed in.

## [0.15.30] — Rail lock and centred countdown

### Added

- **Lock the rail small.** A small lock sits in the rail's bottom corner, under the icons (as in the DS5 app). Locked, the rail stays icons only: pointing at it or tabbing to it no longer opens it, so its icons are quick to use without the rail sliding open each time. Click it again to unlock. Sonata remembers it. Keeping the rail open and locking it small exclude each other: pinning (Ctrl+B) unlocks it, locking unpins it. The lock works from the keyboard too (arrows reach it, Enter or Space toggles it), and the tooltip says what it does.

### Fixed

- **The visualizer's countdown dots are centred.** Before a line comes in, the three dots now sit in the middle of the screen with the lyrics, instead of at the far left. That includes duets. The lyrics window keeps its dots at the singer's side.
- **The rail's status lines keep a clear gap** between the dot and the words ("Discord / Connected", "Precise word timing / Helper ready"). The dot's column never shrinks and its symbol stays inside the dot.

## [0.15.29] — Navigation rail and After Dark flight

### Added

- **Navigation rail in the main window.** A slim glass bar on the right edge with Lyrics, Visualizer, Mini Player and Settings. It shows icons only and opens over the page when you point at it or Tab to it, then closes after you pick something. **Ctrl+B** (or its pin button) keeps it open: Apple's page makes room for it and the choice is remembered. If the window is too narrow (under about 1,000 px), the pinned rail opens over the page until the window is wider. An item is marked while its window is open, and tooltips name the shortcuts. Last.fm, Discord and precise word timing show their state at the bottom with a symbol and words, not colour alone. On the Development channel the rail shows a *Development* badge with the version. It is tinted by the album colour and follows light/dark mode. Keyboard: Tab, ↑ / ↓, Home / End, Enter / Space, Esc. Reduced-motion settings are respected. The rail sits in its own sealed-off layer, so Apple's styles can't change it and it can't change Apple's page. Apple's page still gets no access to your system. The tray, menus and shortcuts are unchanged.

### Changed

- **The flying toasters fly like After Dark's.** The toast scene now starts with an empty sky. Toasters and slices of toast launch one by one from just off the top and right edges, swoop in fast and ease down to their own cruising speed, so they drift past each other and the gaps open and close. When one leaves at the bottom left it comes back a moment later with a new swoop and a new speed. Faster ones are nearer: they fly in front and look a little bigger. Wings beat faster during the swoop, then settle to the music's tempo. Once the sky is full it holds as many as before.

## [0.15.28] — Syllable bounce

- The sung syllable no longer grows into its neighbours: it bounces up (a small overshoot), grows only slightly (1.12×) and glows, so letters never overlap.

## [0.15.27] — Bigger syllable pop

- The syllable being sung now lifts, grows to 1.3× (1.25× in background vocals) and brightens, so the karaoke pop reads at a glance.

## [0.15.26] — Karaoke syllables for every song

### Changed

- **The syllable pop now works on almost every song.** Apple rarely times syllables, so Sonata now works out the syllables of each timed word itself (with the same hyphenation rules TeX uses, in the lyrics' language; English by default) and moves the pop through the word as it's sung. That covers Apple's word-timed lyrics as well as estimated, refined and aligned timing. Short words like "called" stay one syllable; "critics" becomes crit·ics, "Euphoria" Eu·pho·ria. Apple's own syllable timing still wins when a song has it. Words in non-Latin scripts, or in languages without hyphenation rules here, pop as a whole as before. Apple lyrics saved by 0.15.25 are fetched once more to learn their language.

## [0.15.25] — Karaoke syllables

### Changed

- **Real karaoke highlighting.** For Apple lyrics timed by syllable, the whole word lights up while it's sung, and only the syllable being sung right now grows, then settles back (still lit) as the next one takes over. Works in the lyrics window and the visualizer, background vocals and duets included. Lyrics without syllable timing (LRCLIB, estimated, refined or aligned timing) pop the whole word as before. Songs whose Apple lyrics were saved by an older version are fetched from Apple once more to pick up their syllables.

## [0.15.24] — Precise word timing meets the visualizer

### Added

- **Precise word timing (GPU, experimental, off by default)** from 0.15.21 and the **visualizer lyrics and flying toasters** from 0.15.22–0.15.23 now come in one build.
- **Aligned words in the visualizer too.** When precise word timing lines a song's words up with the singing, the visualizer's lyrics use the aligned timing as well, not only the lyrics window. Recording for the alignment now also runs while only the visualizer is open, just like refine by listening.

### Changed

- **Lyrics and visualizer from either player.** The tray menu and the mini player's ⋯ menu now have both *Lyrics* and *Visualizer*, and the shortcuts work in the full-size and the mini player: Ctrl+Shift+L for lyrics, Ctrl+Shift+V for the visualizer.
- **One audio capture for everything.** The visualizer's spectrum, refine by listening and precise word timing now share a single recording of Sonata's own stream instead of each starting its own.

## [0.15.23] — Flying toasters from a real 3D model

### Changed

- **New flying toasters.** The *toast* scene's toasters and toast slices are now rendered from a 3D model: shiny chrome two-slot toasters with feathered wings, flying nose-first from the top right to the bottom left, with an 8-frame wing flap that keeps time with the music. Slices of toast tumble gently along with them. Smooth at any screen size, 4K included.

## [0.15.22] — Visualizer lyrics and flying toasters

### Changed

- **The visualizer shows lyrics like the lyrics window does.** Its overlay now runs the same lyrics engine: words light up as they are sung, the smooth clock, estimated word timing (and refine by listening), interlude dots, duets and background vocals. The line being sung is big and centred with the next line under it, and the sung word glows in the album colour.
- **The visualizer listens to Sonata only.** Its spectrum now comes from Sonata's own audio stream instead of everything your computer plays (other apps' sounds no longer move it). If Sonata's stream can't be found, it falls back to the whole system mix as before.
- **Flying toasters, done properly.** The *toast* scene now fills the whole screen with a staggered formation of chrome 1950s toasters (and the odd slice of toast) flying from the top right to the bottom left and wrapping around, so the sky never empties. Their feathered wings flap to the music's tempo, each toaster in its own rhythm. All-new original pixel art, sized for the screen (4K included).

## [0.15.21] — Precise word timing (experimental)

### Added

- **Precise word timing (GPU, experimental, off by default):** Settings → *Precise word timing*. For songs whose lyrics only have line timing, Sonata records its own playback in memory while the lyrics window is open and, once the song has been heard, hands it to the sonata-align helper on this computer, which separates the vocals and lines each word up with the singing (about 4 s per song on an NVIDIA GPU). The word times are saved per song, so from the next play the words light up when they're actually sung; the lyrics window says "Word timing aligned on this PC". The audio never touches the disk and is dropped right after the alignment; nothing is sent anywhere. Apple's own word timing is never changed. The setting appears once the helper is installed (`align/install.sh` from the source, about 10 GB); the helper starts only when needed and quits after two idle minutes.

## [0.15.20] — Refine timing by listening (experimental)

### Added

- **Refine timing by listening (experimental, off by default):** Settings → *Refine timing by listening*. For songs with estimated word timing, Sonata listens to its own audio while the lyrics window is open and moves words to where they're actually sung: syncopated words land on the beat they're sung on, and held notes keep their word lit. What it learns is saved per song, so replays get tighter. Audio is analysed in memory only, never saved or sent; it uses about half a percent of one CPU core. On mixes where guitars drown the vocals it leaves the timing alone rather than guess.

## [0.15.19] — Tighter lyrics timing

### Changed

- **Lyrics follow the music more closely.** The lyrics clock now reads the exact playback position of the audio (to the millisecond) instead of a value that could be up to a second coarse, and eases smoothly onto it.
- **Better estimated word timing:** words are timed by syllables, with a short breath after commas and full stops, which fits fast vocals much better than counting letters.

## [0.15.18] — Lyrics load faster

### Added

- **Lyrics remembered on disk:** songs you've played before show their lyrics instantly, even offline (up to about 2,000 songs / 20 MB, oldest dropped first).
- **Next song prefetched:** while a song plays with the lyrics window open, Sonata quietly looks up the next song's lyrics, so they're ready when it starts.

## [0.15.17] — Clearer lyrics header, lyrics retry

### Changed

- When the lyrics service is busy or offline, the lyrics window says so ("Lyrics service busy, trying again…") instead of "No lyrics available", and retries on its own while open: after 30 s, 1 min, then every 2 min.
- The lyrics window header shows the song title larger and bolder, with the artist underneath, sized to sit next to the record.

## [0.15.15] — Signed updates, Development channel, bigger album art

### Added

- **Update channel** (Settings → Updates): **Stable** (the default) gets tested releases; **Development** also gets newer development builds (`X.Y.Z-dev.N`) as soon as they're out. Stable never sees development builds.
- **Estimated word timing:** songs that only have line timing now follow the words too, with each line spread across its words. Marked "Word timing estimated"; Settings → *Estimated word timing* turns it off.

### Changed

- **Signed updates.** Sonata now only installs an update whose feed is signed with the project's Ed25519 key and whose download matches the feed's size and SHA-512. Anything else is refused and the reason is shown.
- **The album art is now a little vinyl record** in the lyrics window: bigger, your cover fills the middle with a grooved vinyl rim and a spindle hole, inside the progress ring.
- **Record speed** for *Spin album art like a record*: **Relaxed** (default, a calm turn) or **True** (33⅓ rpm for albums, 45 for singles and EPs, like the vinyl).
- Releases are published by the release workflow (development builds as prereleases), and the update feeds are generated and signed in CI, never by hand.

