# Changelog

Release notes for Sonata. A tag's GitHub release takes its notes from the
section named after its version (`## [X.Y.Z] — Short title`; the title after
the dash becomes the release title), or from `[Unreleased]` when there is none.
See docs/RELEASING.md.

## [Unreleased]

## [0.15.59-dev.1] — Smooth on laptops: Precise timing stays out of playback's way on processor-only PCs

### Fixed
- **The words no longer jump back and forth.** On a PC without a graphics card for the helper (a laptop with Intel graphics: "Processor only"), timing a new song took longer than the song itself. The lyric clock then stepped backwards whenever a late update arrived, and words timed 20–50 s late re-timed the very line being sung, so a lit word went dark again. Now the clock never moves backwards (it eases small differences in, and takes the update's delay into account), and a line being sung keeps its timing until it ends; the new timing applies from the next line.
- **Sonata no longer gets slower and bigger the longer an album repeats.** On a processor-only PC the helper fell behind the music and kept every waiting song's audio and work in a queue (Marcy's laptop: 53 % CPU and 3.5 GiB after a long stretch, 3 % and 600 MiB after a restart). The helper now only works on the song playing and the one before it; anything older is dropped (it is timed on a later play).
- **A song whose last line comes right at its end is timed completely.** Its last section was never counted as heard, so the song was recorded again on every play without ever finishing.

### Changed
- **Processor only: songs are timed after they play.** Instead of section by section during the song, a new song is timed once, as a whole, when it ends, about half the work. The lyrics say "Precise timing after this song, to keep playback smooth" meanwhile; the next play has the precise words.
- **The helper runs below the music.** It runs at a lower priority than playback on every PC; on a processor-only PC it also leaves two cores free and quits after 2 minutes idle (its models hold about 3 GB of memory) instead of 10.

## [0.15.58-dev.1] — Settings, reorganised: Precise timing first, everything in one place

### Changed
- **Settings has a new order.** Precise timing comes first, then Lyrics & Studio, Appearance, Windows & startup, Global shortcuts, Integrations, Updates and Experimental graphics.
- **Precise timing holds everything about word timing:** the helper and how it's built, Update the helper automatically, Precise word timing with First play and Pause while gaming under it, then Estimated word timing and Refine timing by listening under "Without the helper". Remove the helper is now the last row.
- **Lyrics & Studio:** LRCLIB lyrics, Expressive words (and its vocalise ghosts) and Sheet notes in the Studio, which moved here from Experimental. Without the helper they no longer show greyed out: one line says "Needs Precise timing", with a Set up Precise timing button that takes you there. Sheet notes' Placement shows only while Sheet notes is on.
- **Spin album art like a record** and **Record speed** moved to Appearance; **Track notifications** and the old Startup switches joined the window switches in **Windows & startup**.
- **Shorter text:** every setting's line is one short sentence; the longer explanation is behind its ⓘ. The media-keys note in Global shortcuts is now behind the switch's ⓘ.
- **Updates:** the button is now called Check for updates (it was Check now).
- **Development builds:** the developer-only rows (Sung notes log, Wordless vocalise ghosts, First play) all show on a Development build, whatever the update channel.

## [0.15.57-dev.1] — Expressive words: works on your songs, and says what it's waiting for

### Fixed

- **Expressive words works on a fresh helper.** It needs a small pitch model (173 MiB), and Sonata only downloaded it when you turned on Sheet notes or the developer log yourself, so with Expressive words on by its own default nothing was ever measured. Sonata now fetches it once, the first time a song shows while Expressive words is on (Precise word timing on).
- **Every held word stretches, not just one per line.** In a line like "But I don't mind, I don't mind, yeah", only one "mind," stretched (a different one each chorus). With Apple's own word timing the word's time often ends before the singer's held note does: the note then wasn't given to the word, the word's expression wasn't matched when its vowel started after the word's own end, and a stretch stopped when the word's time ended. Now a word keeps its note up to the next word, and the stretch lasts as long as the vowel is sung.
- **A song's notes never go backwards.** If measuring a song again (for Expressive words) failed, the failure replaced the notes Sonata already had, so the Studio's band fell back to the first play's pitch line and the song was recorded again on every play ("it's like it stopped learning"). The notes from the earlier play now stay, and after two failed tries the song isn't recorded again for it. The log says per song what it uses ("cached notes (351) + expr (46 held, 35 ghosts) — no re-run") or why this play records it.
- **No song is left out for good.** A song measured while the pitch model was missing was marked as failed and never tried again; those songs (also ones marked by earlier builds) are measured on their next play. A failed song is tried again for Expressive words too, not only for Sheet notes.
- **The first song after a start is measured too.** Songs with Apple's own word timing, and songs Sonata had already timed, were skipped on the first play after Sonata started, until the helper had answered once.
- **"The helper install was interrupted" → Show, and starting Sonata again during an install, go to Settings → Precise timing** (they opened Settings without going to the section).

### Added

- **Expressive words says what it's waiting for.** While it's on but can't draw yet, one line over the lyrics says why, with the full story behind the ⓘ: "Expressive words needs the Precise timing helper" (with Install, which opens Settings → Precise timing), "…: Precise word timing is off", "…: downloading the pitch model…", "…: measured once this song has played through", "…: measuring this song…", or "…: nothing held long enough in this song". When the measuring finishes while the song is still on screen, it starts drawing right away, in the same play.

## [0.15.56-dev.1] — The helper install survives a restart

### Fixed

- **Quitting no longer throws away a helper install.** While Settings → Precise timing installs, updates, repairs or removes the helper, Quit (in the tray), closing the window and Restart now ask first: "The Precise timing helper is still installing (step N of M). Quit anyway? It will continue the next time Sonata starts." Keep installing is the default. An update that is ready waits for the helper before it offers Restart now, and opening Sonata again while it installs shows the progress.
- **An interrupted install picks up where it stopped.** If Sonata was closed, crashed or the power went while the helper was being set up, the next start says "The helper install was interrupted — continuing…" and carries on by itself (Cancel stops it). If it can't be finished, Settings says why and offers Install or Repair.
- **Downloads continue instead of starting over.** The helper and its models (the English aligner is 1.26 GB) continue from the last byte that arrived, and every file is checked whole afterwards (size and checksum). Files that are already complete are never downloaded again.
- **A stopped update leaves the working helper in place.** An update or repair that is cut off midway, even by a crash, keeps the helper that was installed before; the next run tidies up what was left.

## [0.15.55-dev.1] — Look-ahead play: first plays precise from the start (Linux, experimental)

### Added

- **First play: precise from the start** (Settings → Playback & lyrics; experimental, Linux, Development builds only, off by default). Until now, the first time a song played, its words lit up on time only a section at a time, as Sonata worked them out. With this switch on, Sonata plays a song it hasn't learned yet a few seconds behind Apple's player (Precise: 3 seconds, Quick: 2 seconds), so the timing helper hears every word before you do and the words light up in time from the very first line. Songs Sonata has already learned, songs with nothing to learn and music videos play with no delay, and moving between them is clean. The lyrics, the Studio, the mini player and the liner notes follow what you hear.
- **What to expect.** On a song Sonata hasn't learned, playback starts 2–3 seconds after you press play, and after a seek you hear the new place after the same wait; pause stops at once, and nothing plays after it. Apple's own progress bar runs that far ahead of what you hear. A volume change is heard after the delay too. It needs Precise word timing, a graphics card that isn't busy (when it is, or without one, a song plays with no delay and its timing comes in sections, as before) and helper 0.2.5 or newer (it has the streaming this needs; Settings → Precise timing offers the update). While it runs, your sound settings show a "Sonata look-ahead" device; it goes away when Sonata closes or the switch goes off, and if the delay ever stops, your music goes straight back to your speakers. Not on macOS or Windows yet.

## [0.15.54-dev.1] — Expressive words now appear on your songs

### Fixed

- **Expressive words now appear on your songs.** In 0.15.52 they drew nothing on real songs: a play that filled in a few missed lyric lines skipped the step that measures the singing, and songs Sonata had learned before Expressive words existed were never measured again. Now every song is measured: a new song on its first full play, and a song learned earlier the next time it plays to the end (the whole song is listened to once more). Held notes then show as soon as the song has been measured, during that play when it's still on screen, otherwise from its next play. How it looks: while a singer holds a note, its vowel letter repeats in place ("take me hoooome tonight") and the rest of the line slides over to make room, then glides back; the letters waver with the singer's vibrato and a belted word gets bolder. A long held note also floats as large, faint letters behind the lyrics, growing with the note and fading when the voice lets go. On Development builds, *Wordless vocalise ghosts* adds a faint "ooo" where someone holds a note with no lyric word, like an intro's "ooh". Only what was measured with confidence is shown, and the word light and syllable pop stay exactly as they are. Settings → Playback & lyrics → Expressive words (on by default on Development builds, needs Precise word timing).

## [0.15.53-dev.1] — Experimental graphics switches stay on when you restart

### Fixed

- **Settings → Experimental's graphics switches no longer turn themselves off when you restart Sonata.** Quitting or restarting Sonata (Restart now, an update's restart, the tray's Quit) within the first seconds of a start was taken for a start that went wrong, so HDR output, Hardware video decoding and True video colours were switched off on the next start without a word in Settings. A quit or a restart never counts now. Sonata turns a switch off only after a real failure, twice: two starts in a row that ended on their own before Sonata was running, or two graphics-process crashes in one run. When it does, Settings → Experimental says which switch and why, with **Turn back on**. Opening Sonata again while it runs no longer counts either. Switches that were turned off before this update stay off until you turn them back on.
- **True video colours says when it can't work.** With Hardware video decoding on, it read "Turns on at the next start" although it isn't used then; it now says "Not used while Hardware video decoding is on: this fix covers software-decoded video only."

## [0.15.52-dev.1] — Expressive words: held notes stretch and ghost behind the lyrics

### Added

- **Expressive words** (Settings → Playback & lyrics; on by default on Development builds, needs Precise word timing). Held notes show how they were sung, on top of the word light and the syllable pop, which stay exactly as they are: while a vowel is held its letter repeats in place ("take me hoooome tonight": the rest of the line slides over to make room and glides back when the note ends, never past the edge), the letters waver with the singer's vibrato and a belted word gains ink; lines look as they always did until a hold starts, and a sung word goes back to its spelling. A long held vowel also floats as large, faint letters behind the lyrics beside the sung line, growing with the hold and fading when the voice lets go. On Development builds, *Wordless vocalise ghosts* also shows a faint "ooo" where a note is held with no lyric word (an intro's "ooh"). Only what Sonata measured with confidence is shown; with reduced motion nothing drifts or waves. Off, it's today's karaoke.

## [0.15.51-dev.1] — Long words keep their gap when they pop, and high notes stay on the staff

### Fixed

- **A long word's pop no longer runs into the next word.** In the Studio at a large size, a long word being sung grew into the space beside it, so "amends, that's right" read as "amends,that's" and "predictable" crowded "it's". The pop looks and moves exactly as before; a word that would come too close to its neighbour now grows toward the side with room (the start or end of a line grows outward), and only when both sides are tight does it grow a little less, so a clear gap always stays between words. Short words pop exactly as they did. Hyphenated words ("Yeah-oh") stay joined, backing vocals follow the same rule, and with reduced motion nothing pops, as before.
- **The sheet-notes staff keeps a high or low voice readable.** In the Studio's sheet notes, a stretch of the pitch line above the staff was drawn with nothing to read it by, right under the band's buttons (Sabrina Carpenter's "House Tour" at 2:29), and anything higher was cut off without a sign. Above or below the staff the line now gets ledger lines, as a note would; past the room the staff has, it runs along the edge, dashed, with a small arrow pointing the way it went. Notes that high or low show the same way. Nothing is drawn into the label row any more.

## [0.15.50-dev.1] — Hyphenated lyrics look as written, and the sheet-notes band says when no one is singing

### Fixed

- **Hyphenated lyrics are written as they are.** A line like "Yeah-oh, oh-oh-oh-oh" showed with a gap after every hyphen ("Yeah- oh, oh- oh- oh- oh"). Each part still lights up and pops on its own beat, now written together as in the lyrics. Dashes (— and –) and a spaced " - " keep their spaces.
- **The sheet-notes label matches the staff.** In a vocal break, such as Mad Season's "Wake Up (Live At the Moore)" at 4:50, the band said "pitch line here: notes unsure" over an empty staff. When nobody sings in the part of the song the staff shows (a break, or after the lyrics end), it now says "no singing here", with the detail behind its ⓘ; "pitch line here" shows only while a pitch line is on the staff.

## [0.15.49-dev.1] — Instrumentals say "Instrumental"

### Fixed

- **Instrumentals say "Instrumental".** A song with no vocals, such as Mad Season's 13-minute "November Hotel (Live At the Moore)", showed "No lyrics available for this song" and "Sheet notes need lyrics with line timing", as if something had failed. When LRCLIB marks this recording as instrumental (same title, artist and length), or the title itself says "(Instrumental)", the lyrics window now shows a calm, large "Instrumental", with where that comes from behind its ⓘ, and the sheet-notes band says "Instrumental" too. Sonata remembers it, so the song shows it at once next time and LRCLIB isn't asked again; an instrumental is never retried or reported as a busy service. Apple Music having no lyrics is not taken as proof on its own, and lyrics from any source always win.

## [0.15.48-dev.1] — Live albums: lyrics timed for another version, "(repeat all)" lyrics, honest lyric-source messages, and a Listening and learning dot

### Changed

- **The first play's sheet-notes band shows "Listening and learning".** On a song's first play each part's pitch line comes only once Sonata has heard that part, so the staff between the line heard so far and the playhead stays empty for a while. Now a small green dot blinks softly beside "Listening and learning" in the band's top row and on the staff at the playhead while the part being sung is still being heard; when its line arrives the dot stops and the line draws in. It replaces 0.15.47's message, so there is one signal; the ⓘ explains it. The dot holds still while the song is paused and stays steady with reduced motion.

### Fixed

- **Lyrics timed for another version no longer highlight the wrong lines.** Some LRCLIB lyrics carry the line times of another recording (a live cut got the studio version's times, so the highlight ran several lines behind and later lines were never timed). When the lyrics clearly don't fit the recording (they end long before a live or alternate recording does, or run past its end), Sonata drops their times: the lines show without a highlight and a note says why ("Lyric timing is for another version: timed after this play", details behind its ⓘ), and with Precise word timing on, Sonata works out each line's time from the recording's audio once the song has played to its end. From the next play the lyrics follow the singing; a line it can't find stays un-highlighted rather than guessed. Apple's own timing is never dropped. LRCLIB lyrics that come without any line times are now timed the same way.
- **Shorthand in lyrics is written out.** LRCLIB lyrics that say "(repeat all)", "(x2)", "Chorus x2", "[Chorus]" with nothing under it or "(repeat 1st verse)" instead of the sung lines no longer show the marker as a line and stop early: Sonata first looks for another LRCLIB entry that has the whole lyric, and otherwise writes the repeats out and times them from the audio like lyrics timed for another version. Lines like "(oh yeah)" are left alone.
- **The lyrics window says what is really going on when lyrics don't load.** "Lyrics service busy, trying again…" is gone: it now says whether Apple Music has no lyrics or didn't answer, and whether LRCLIB is overloaded, rate-limited or unreachable ("No Apple lyrics; LRCLIB is overloaded, retrying"), with the source, its answer and the time of the next try behind the ⓘ. A song with no lyrics anywhere says so. LRCLIB is often only briefly overloaded, so Sonata now tries again after 1, 2, 4 and 8 seconds before backing off to 30 seconds and 2 minutes (at most 10 tries per song per session), so lyrics usually appear within seconds.

## [0.15.47-dev.1] — The favourite star fills, and the sheet-notes band says when a part's line is still coming

### Fixed

- **The Studio's ☆ Favorite star fills after you favourite a song.** Apple Music takes a moment before its own read of your ratings shows a new Favorite, and Sonata read it only once, right after the click, so the star stayed an outline even though the song was favourited. The star now shows what Apple answered to the Favorite itself and checks again a few seconds later until Apple's read agrees. Each read is written to the log, so a star that stays wrong can be explained.
- **The first play's pitch line no longer leaves an empty staff without a word.** On a song's first play each part's pitch line comes once that part has been sung, and the band shows the last few seconds, so during a long part or a solo the line heard so far had scrolled away and the staff looked broken. The band now says the part's line shows once it has been sung, and its ⓘ tells where the line heard so far ends.

## [0.15.46-dev.1] — Install the precise-timing helper from Settings, How it works in About, and the Studio group on the rail

### Added

- **About → For the Curious explains how it works.** Under the numbers, a new "How it works" group gives six short, plain explanations for the curious: how updates are built and checked before they install, where the lyrics and their word timing come from, what precise word timing and sheet notes do on your PC, what stays on your PC and what goes online, and where the Montage photos and liner notes come from, with their credits. Each topic is one line; the ⓘ beside it shows a few sentences (hover over it, Tab to it, or click it; Esc closes it).
- **Install, update and remove Precise timing's helper from Settings.** No terminal any more: Settings → Precise timing has a *Helper* line that says where things stand ("Not installed", "Installed: helper 0.2.1, Python 3.14, NVIDIA RTX 5080", "Update available: 0.2.2", "Needs an update") with the details behind its ⓘ, and the buttons that apply: **Install**, **Update**, **Repair** or **Remove…**. Install shows the helper's licence in the page first (Accept and install / Cancel); it is asked again only when the licence changes. Then it shows each step with real progress: the download, setting up Python, PyTorch (bytes as they come in), the other packages, a test start of the helper and, the first time, the models. **Cancel** stops it at any point. Nothing half-done is ever used: the new helper is built beside the old one and replaces it only once it starts, so a failed or cancelled install leaves the working one as it was, and a failure says in plain words what went wrong and what to do. **Remove…** asks in the page and keeps the downloaded models unless you untick it. It uses the same installer and the same checks as before (size, checksum and signature of every download, https only); in the AppImage it works as it is, with nothing to extract. A fresh install turns Precise word timing on.
- **Precise timing for AMD and Intel graphics, and for computers without a graphics card (new).** Settings → Precise timing → *Build for* shows the graphics Sonata found and picks the matching helper build: NVIDIA (CUDA, the tested one), **AMD (ROCm, new)** for Radeon RX 6800 and newer cards, **Intel Arc (XPU, new)**, or *Processor only* (small, about a minute per song). Auto picks for you (an integrated GPU counts as none); you can choose another, and Update and Repair keep the build you have, while changing it offers *Rebuild for …*. The installed line names the card and the build ("Installed: helper 0.2.1, AMD Radeon RX 7800 XT (ROCm)"). **Honest label: the AMD and Intel builds have not been tested on real AMD or Intel cards yet**; they install and start correctly, and a build that finds no card it can use runs on the processor and says so. They need the next helper release (the current helper 0.2.1 builds for NVIDIA or the processor only, and says so if you pick AMD or Intel).
- **Helper updates no longer wait for a Sonata release.** Sonata now reads a signed list of helper versions (the Development channel's own list on Development) and offers a newer helper as soon as it is out: Settings, its section header and the rail say "Helper update available", and **Update** installs it, keeping the models. Any helper version this Sonata can talk to is accepted, never an older one than installed, and only when its list and its download are signed with the helper's key. *Update the helper automatically* (off by default) does it by itself; a changed licence is still shown to you first. Like Sonata's own updates, it checks only while *Check for updates automatically* is on.

### Changed

- **The rail groups the Studio with Lyrics and Liner Notes, and the Mini Player moves up.** The rail now reads Studio, then under it Lyrics and Liner Notes (indented, a smaller icon on a thin guide line, so they read as the Studio's even with the rail closed to its icons, and stay one click away), then Mini Player, Visualizer, Settings and About. **Liner Notes is new on the rail:** it opens the booklet of the playing album (as the Studio's Liner notes tile and the menus' *Liner Notes…* do), is marked while the booklet is open, and a second press closes it; with nothing playing, its tooltip and a notice say so. ↑ / ↓ walk the rail in this order, the sub-items included, and screen readers hear "Lyrics, in Studio".

### Fixed

- **The sheet-notes pitch line is a line again, not a row of dashes.** On a song's first play the pitch line broke at every consonant and every short pause in the voice, so a sung phrase showed as short dashes. Now it runs on through the phrase and stops only where the singing does; stray specks are left out, a jump that doesn't belong is smoothed over, and vibrato keeps its full swing. On the songs we measured that is two to four times fewer pieces, and a typical piece lasts one to three seconds instead of a third of a second. This covers the first play's pitch line and the pitch line drawn where the notes are unsure.
- **Versions read "0.15.46 Dev" everywhere, never "0.15.46-dev.1".** The update toast ("Sonata 0.15.46 Dev is up to date (Development).") and every other place a version shows now say it the same way: update notices and desktop notifications, Settings → Updates, About's card and What's new, the rail's Development badge, For the curious and the helper's version. Settings' numbers come from what Sonata actually does: the update check interval, the sung-notes and sheet-notes limits and folders, the For the curious refresh, Discord's retry and the helper's idle time (which was wrong while a lyrics window is open: 10 minutes, not 2).
- **About → Credits names what the precise-timing helper really uses.** Parts it no longer contains are gone, and everything it does use is credited with its licence.

## [0.15.45-dev.1] — Sheet notes on Apple's word timing, booklet pages turn on a click, and a new home for releases

### Added

- **Sheet notes for songs with Apple's own word timing.** Most popular songs come with Apple's word-by-word or syllable lyrics, and until now the Studio's sheet-notes band turned them away ("it has its own word timing"), so they never got notes. Now, with Sheet notes on, such a song is treated like any other: on its first play the band draws the pitch line as each part of the song is heard, and Sonata works out the notes on Apple's own word and syllable times (the precise-timing helper separates the vocals and follows their pitch; nothing is re-timed). From the next play the notes show on the staff, in sync with Apple's words. A song left before its end gets its notes on a later play. It still needs Precise word timing and its helper, and like all of it, it pauses while a game runs.

### Changed

- **Turn the liner notes' pages by clicking the book.** A click on the right-hand page turns forward, a click on the left-hand page turns back, like a real booklet; the ‹ › arrows under it are gone (the section buttons stay). A page that can turn shows it: a folded corner at its outer bottom edge, lifted when the mouse is over the page, and the pointer; the cover and the back cover have none on their outer side. Clicking a link, a chip or a button, or selecting text, never turns a page. ← / → and Page Up / Page Down still turn pages, and each folded corner is a Next page / Previous page button for the keyboard and screen readers.
- **Precise word timing's helper is now a separate download.** Sonata no longer carries the helper itself: `align/install.sh` downloads the helper version this Sonata asks for, refuses it unless its size, checksum and signature match, shows the helper's licence and installs only after you type "yes". **Already installed? Run it once more, one time:** it keeps your downloaded models and rebuilds the helper's Python packages on Python 3.14 (about 7 GB again; the old set is kept aside in the helper's folder as `venv.old-<date>`, which you can delete once word timing works). From the folder that holds the AppImage: `./sonata-0.15.45-dev.1-x86_64.AppImage --appimage-extract 'resources/app.asar.unpacked/align/*' >/dev/null && sh squashfs-root/resources/app.asar.unpacked/align/install.sh` (then delete `squashfs-root`). Until then Settings → Word timing and the rail say "Helper needs an update"; estimated timing and Refine by listening keep working without it.
- **Updates come from a new place: [MarcelineVPQ/sonata-releases](https://github.com/MarcelineVPQ/sonata-releases).** Sonata's releases, its signed update feeds and the complete source of each release (`sonata-X.Y.Z-source.tar.gz`, GPL-3.0, with `SHA256SUMS`) now live in a repository that holds only those; each release's AppImage is built there from exactly its published source. Nothing to do: this build arrived through the old feed, and from now on Sonata reads the new one, with the same signing key and the same checks (signature, size, SHA-512). About → Releases opens the new page.

### Fixed

- **The Studio's Favorite star fills in.** After you favourite the playing song it now shows a filled star in the accent colour ("Remove from Favorites"), and an outline again after you take it out. The star and the Add to Library ✓ show what Apple Music says, read back after each click and on every new song: the Studio was ignoring those reads since songs got their recording ids, so it kept showing whatever the last action left. The song's credits on the cover's back had the same fault and are back too.
- **The sheet-notes band's message is no longer cut off, and says Experimental once.** The top row wraps onto a second line when the Studio is narrow instead of ending in "…", the messages are short, and the longer explanation is behind an ⓘ beside them (hover, Tab to it, or click). The label next to the Experimental chip no longer repeats "Experimental".
- **The note under the Studio's song actions shows all of what it says.** A longer one ("The album isn't shown in Apple Music's page right now, so it couldn't be opened from here") wraps onto a second line instead of ending in "…".
- **The visualizer's words read over every scene.** The lyrics, the song title, the hint and the scene name now sit on dark plates sized to the text, so the aurora's glows, the nebula, the bars and the flying toasters pass behind the words without washing them out (they could drop to about 1.1:1 at the brightest spot; now at least 4.5:1 everywhere). The scenes themselves are as bright as before. The hint at the bottom right is easier to read.
- **Notices read in dark mode with Glass.** A notice's detail line and its buttons were too faint over some album art (3.6:1 and 4.2:1); the notice's tint and its detail text now adjust so both reach 4.5:1 with any art and album colour.
- **About → Coming soon: the cards' text and the count badges are a touch darker in light mode**, so they reach 4.5:1 with Glass on (they were 4.47:1).
- **Install updates automatically installs again.** With it on, an update the check found was offered but never installed by itself: the install was asked for while the check was still finishing, and refused. It now starts as soon as the check finds the update.

## [0.15.44-dev.1] — The liner notes disc turns about its own centre

### Fixed

- **The disc on the liner notes' cover turns about its own centre.** A disc scan from the Cover Art Archive is often a photo of the CD lying on paper, off-centre (Radiohead's *In Rainbows*, the 2008 US CD), so it wobbled and jumped once it started spinning. Sonata now finds the disc in the scan (once per scan, remembered with the booklet) and shows exactly the disc, centred, filling the circle. A scan where no disc is found for sure is shown as before and kept still. The disc also no longer snaps back or blinks when the booklet's sources finish loading or the window is resized.

## [0.15.43-dev.1] — The Liner notes tile takes the mouse, and the sheet-notes band always shows

### Fixed

- **The Studio's Liner notes tile should take the mouse everywhere again** (to confirm on that screen). Most of it ignored the mouse on a Wayland screen at a fractional scale (1.2): the no-drag holes cut for the left column's controls didn't line up with them. The Studio's left column is no longer a window-drag area at all, so nothing there depends on those holes; the window still moves by the header, the sheet-notes band and the queue's title. The three Studio tiles also share the column's width exactly, so the third can never run past it.

### Changed

- **Development builds show as "0.15.43 Dev".** The rail, Settings → Updates and About → App changes no longer show the build number on the end ("-dev.1"); the real version, the tags and the update feeds keep it, because the updater needs it.
- **The sheet-notes band always shows while Sheet notes is on.** It no longer folds to one line when a song has nothing to draw yet: the staff stays, empty, with the reason in the band's top row, and the Band on top / Over the sung line buttons stay too.

### Tests

- The UI checker now tests the Studio the way a person uses it: every visible control must be reachable by the pointer (nothing over it, no drag area over it), the tiles must stay inside their column, and the real mouse (XTest), at the screen's scale, must light each tile at its centre and right edge, with all three tiles shown.

## [0.15.42-dev.1] — Sheet notes in the Studio, Experimental switches, For the Curious, and steadier lyrics timing

### Added

- **Sheet notes in the Studio (Experimental).** The sung melody above the Studio's lyrics, playing out live with the words. The first time a song plays, a pitch line follows the singing as Sonata hears each part; from the next play on, the notes sit on a staff in the song's key, each as long as it was held, with the syllable under it and the note being sung lit. Where the singing doesn't sit on notes (rap, speech, shouting) it shows the pitch line instead of guessing notes. Turn it on with the Studio's Sheet notes tile or Settings → Experimental; it needs Precise word timing, and is worked out on your computer with the word timing. Only the notes are kept. Off, the band folds away and the lyrics take the room. The staff can sit in its band above the lyrics or ride just above the line being sung, moving with it from line to line (the band's two buttons, or Settings → Experimental → Sheet notes placement).
- **More in the Studio: the song's actions, its credits and one list.** Under the volume, the Studio now has the song's actions: Favorite, Add to Library, Add to a Playlist (your own playlists), Copy Link, Go to Album, Go to Artist and More (View Album Cover, Liner Notes…, Share); each says what it did, or what went wrong, in a short line under them. Click the cover (or press C) and it turns over to the song's credits: who wrote it, who performs it, the musicians and the producers, from Apple Music and MusicBrainz, with More in the liner notes. The right side is one list: the songs already played (dimmed), the one playing, the next song's card (click it to skip there), then the rest, with no tabs; every row has a menu (Play Now, Play Next, Go to Album, Credits) by ⋯, right-click or the Menu key. The title and album open the album, the artist opens the artist, "Track N of M" shows the song in the list and the live chip opens the booklet at the recording. Hover the song position to see the time and the words sung there. Keys in the Studio: Space, ← →, ↑ ↓ (lines), F, C, N and Esc. Nothing runs at rest.
- **Settings → Experimental.** A new section for switches still being tested, all off until you turn them on: **HDR output** (on an HDR screen with KDE Plasma, the word being sung in the lyrics window and the visualizer glows brighter than white), **Hardware video decoding** (animated album covers are decoded by the graphics card instead of the processor, about 7 % of a CPU core less while one plays), **True video colours** (on Wayland, animated covers and music videos keep the colours of the still cover; reds and magentas no longer turn orange) and **Dithered cover glow** (the soft glow around an album's cover on Apple's page fades smoothly instead of in visible steps). Each says what it does and whether it applies at once or at the next start, with a Restart now button when one is waiting. If a start with a graphics switch on doesn't finish, or the graphics process crashes, Sonata turns that switch off again by itself and says so; starting Sonata with `--safe-gpu` uses none of them and leaves your settings as they are. Sheet notes in the Studio has its switch here too.
- **About → Graphics.** What this start of Sonata uses: hardware acceleration, the Experimental switches that are on, the video decoder, HDR screens, and Sonata's processor use over the last minute. It measures only while the section is open.
- **For the Curious.** About has a new section of honest numbers on how Sonata hears your music. Your library: how many songs have Apple's own word timing, Sonata's precise timing, timing refined by listening, estimated timing or plain lyrics, how many words this PC has aligned, the held notes found, the refinements from later plays, each cache's size and the oldest and newest alignment. Now playing: where the song's timing comes from (with the aligner's version and model), the alignment's score, the held words, how long the helper worked on it, and, when its sung notes exist, the melismas, the vocal range and the key, and whether this is its first play with the lyrics open. Under the hood: CPU, memory and frames for each window, the precise-timing helper's state and graphics memory, the audio output format and the versions. What Sonata doesn't keep or can't read says "Not yet known" and why, never a guess. The numbers are read only while the section is open and the window shown, again every 5 seconds; nothing runs when it's closed. Copy for a bug report puts them on the clipboard as plain text, without lyrics, song names or personal data.

### Changed

- **Coming soon is up to date.** About → Coming soon lists what's being built now (sheet notes in the Studio, the graphics experiments), what's planned next (karaoke mode, romanized and translated lyrics, installing precise word timing from Settings, Sonata in more languages, and more) and the ideas on the list, each with its own title. Things that have shipped are no longer in it.
- **Precise word timing starts sooner.** The word-timing helper now stays ready for 10 minutes between songs while the lyrics window, the Studio or the visualizer is open (it used to quit after 2 minutes and needed about 5 seconds to start again, so a new song's first words often came late). With no lyrics open it still quits after 2 minutes, and it still steps aside at once when a game starts or Sonata quits.
- **Precise word timing keeps a few more facts per song** for For the Curious: the helper's version, when the song was aligned, the helper's confidence in each line and how long it worked on the song. Songs aligned before this version say "Not yet known" for those until they're aligned again.

### Fixed

- **A held last word stays lit for its whole hold.** With Precise word timing, a line whose singer holds the last word ("you can make it o—n", "on my o—wn", "at a—ll") sometimes gave the long hold to the short word before it, so the highlight sat on "it" and the held word only lit up at the very end. The hold now goes to the last word. Songs aligned before are corrected when they play, with no new alignment.
- **Lyrics on a song's first play run less early, and never far behind.** Apple's line times often come before the singer, by a different amount on each song. Sonata learned that lead from the first lines it aligned, but at most 1.5 seconds and from a plain median, so one odd line could pull it late. It now ignores lines far from the rest, leans slightly early (lyrics a little early are noticed less than late ones), never shifts so far that more than a quarter of the lines come over half a second late, and allows up to 3 seconds. Later sections adjust it at most half a second at a time, so the words on screen don't jump. The learned lead is saved with the song, so the next play starts with it.
- **A live recording no longer borrows the studio version's timing.** Sonata remembered lyrics and word timing by song title and artist, so a live recording with the same name as the studio one (or two live albums that both have "Iris (Live)") could get the other recording's word times. Each recording is now known by its ISRC from Apple Music (the same recording on a compilation still shares its timing), and stored timing is used only when its length matches the song playing, to within 1.5 seconds. Timing saved before this version is kept: titles without a live or alternate mark carry on as they are; for "(Live)", "Acoustic", "Remix", "Remaster" and similar titles the stored word times are checked against the song's own lyric timing the next time it plays, and the lyrics are fetched again.
- **"A 42 Pixel Studios production" is easier to read.** The small line at the top of About's card was too faint with album colours and Glass (3.8:1 in dark, 4.3:1 in light). It now meets 4.5:1 in every theme, still in the album's colour.
- **The lyrics no longer race through the song when a new one starts.** When one song ran into the next (an album played in order), the new song's lyrics could light up and scroll through every line in a rush before starting properly, because the first moment of the new song still carried the previous song's position. Each song's lyrics now wait for its own time. A seek, a click on a line or coming back to the window after a while jumps straight to the right line instead of scrolling through all the lines between. In the lyrics window, the Studio and the visualizer.
- **Backing vocals' ↳ stays under the text.** A line of backing vocals with nothing to line up with, or under a line that wraps, started at the very edge with its ↳ hanging outside the lyrics. It now starts where the main line's words start.

## [0.15.41-dev.1] — The Studio, liner notes, the Montage, and backing vocals under their words

### Added

- **The Studio: the lyrics as the centrepiece.** The lyrics window can grow into the Studio, a full now-playing screen: the lyrics big in the middle, the cover, the song, "Track 13 of 24", the live venue for live albums and the controls (play, previous, next, shuffle, repeat, position, volume) on the left, and on the right Up Next or the whole album or playlist, with a "Next · in 1:22" countdown and the time left. Click a song in the list to play it. Open it with Studio, now the first item on the rail, the new button in the lyrics window's header or Ctrl+Shift+S; the same button or key shrinks it back to the lyrics window. Sonata remembers which one you used last, and the size of each. In the Studio, Liner notes opens the album's booklet, or says when no album was found. Everything follows your theme, album colour and Glass; the keyboard and screen readers reach every control, and nothing moves on its own while the music is paused.
- **The Montage.** In the Studio, the Montage tile puts free photos of the artist, the band live, a live album's venue and the album's years behind the lyrics, drifting slowly and fading from one to the next. The photos come from Wikimedia Commons (only freely licensed ones, never album covers or logos), and each shows its credit: who took it and its licence, linked to its page. The lyrics stay readable over every photo, in every theme. It's off until you turn it on, and nothing runs while the music is paused, the Studio is hidden or the Montage is off. With "Reduce motion" on, the photos only fade.
- **Liner notes.** The album as a CD booklet you page through: the cover and the disc, Apple Music's notes on the album, where and when it was recorded (with the set for live albums), the album's Wikipedia article, who played and who wrote each song, the lyrics of the songs you have played (the line being sung is marked), the real booklet and back-cover scans where the Cover Art Archive has them, and a Sources page. Every block says where it comes from: Apple Music, MusicBrainz, the Cover Art Archive, Wikidata, Wikipedia (CC BY-SA, linked) and, for live albums, setlist.fm with your own free key (Settings → Integrations). Open it with Liner Notes… in the lyrics window cover's menu or the mini player's menus. Turn pages with the arrows, the section buttons or ← →; Esc or ✕ closes it. A booklet you opened before also opens offline, and a source that didn't load says so on its page.

### Changed

- **Backing vocals come in under the words they answer.** The smaller line of backing vocals under a lyric line now starts right under the word where the backing voices come in, or under the words they echo, so you can see where in the line they answer. They're set in italics with a small ↳, light up word by word as before, and follow the singer's side in duets. When they come in after the line, they start where it ends.
- **Every window is checked, and Sonata's appetite has limits.** An automatic check now goes through every Sonata window and view (the rail, Settings and About with every section open, notices, toasts, the lyrics window, the mini player and every visualizer scene, in light and dark, with a song playing) for unreadable text, buttons that do nothing, colours outside the theme, and text that spills out or is cut off. Sonata's resource use now has written limits: processor use with the window shown and in the tray, frames and redraws per window, memory, and listeners that must not pile up; a 30-minute playback soak checks that memory and listeners don't grow. Each development release is measured against them before it ships. Nothing changes in use.

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

