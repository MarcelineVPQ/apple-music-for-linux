# Changelog

Release notes for Sonata. A tag's GitHub release takes its notes from the
section named after its version (`## [X.Y.Z] — Short title`; the title after
the dash becomes the release title), or from `[Unreleased]` when there is none.
See docs/RELEASING.md.

## [Unreleased]

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

