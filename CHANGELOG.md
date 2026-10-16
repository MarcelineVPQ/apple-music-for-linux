# Changelog

Release notes for Sonata. A tag's GitHub release takes its notes from the
section named after its version (`## [X.Y.Z] — Short title`; the title after
the dash becomes the release title), or from `[Unreleased]` when there is none.
See docs/RELEASING.md.

## [Unreleased]

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

