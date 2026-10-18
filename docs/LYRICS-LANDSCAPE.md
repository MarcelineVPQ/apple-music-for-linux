# Lyrics landscape: is Sonata's lyrics feature set unique?

> Research note, dated 2026-10-16: research against Sonata 0.15.18, kept as written. File names and features are as they were then (the floating Settings window became the side panel in 0.15.32).

Research of 2026-10-16, against Sonata 0.15.18 (working tree). Purpose: find out which claims
about Sonata's lyrics are true and checkable before they go on the 42 Pixel Studios site.

Sonata's column was checked in the code: `lyrics-sources.js` (Apple TTML parser, LRCLIB lookup,
resolver + cache), `lyrics-timing.js` (`estimateWords`, `findInterludes`, `lineSides`),
`lyrics.html` (source notes "Lyrics from LRCLIB" / "Word timing estimated", vinyl art, ring,
spin), `lyrics-store.js` (on-disk cache), `main.js` (`/syllable-lyrics` then `/lyrics`,
retry at 30 s / 60 s / 120 s, `prefetchNextLyrics`, `lyricsAlwaysOnTop`), `settings.html`
("Estimated word timing" toggle). Other columns come from the sources at the end.

**Legend:** ✓ yes · ✗ no · partial · **?** not confirmed by a source (best knowledge only).
"✗" for a third-party app means "not in its docs, changelog or source as far as checked", not a
proof of absence.

## The features

1. **Apple word timing**: Apple's own syllable/word-timed lyrics (TTML from `/syllable-lyrics`),
   karaoke word pop.
2. **Estimated word timing**: for line-timed-only lyrics, each line spread over its words by
   length, and the UI says so ("Word timing estimated"; Settings toggle).
3. **LRCLIB fallback**: when Apple has no lyrics (synced or plain), with word pop via the
   estimate, a "Lyrics service busy, trying again…" state and capped retry (30 s, 60 s, then 120 s).
4. **Interlude countdown dots** (Apple-style) on Apple and on LRCLIB lyrics.
5. **Duet sides** (`ttm:agent`) and **background vocals** (`x-bg`) with their own timing.
6. **Floating always-on-top lyrics window** with vinyl-style cover, progress ring, record-speed spin
   (33⅓ / 45 rpm).
7. **On-disk lyrics cache** + next-song prefetch.
8. **Free, open source (GPL-3.0), Linux.**

## Matrix

| App | 1 Apple word timing | 2 Estimated words | 3 LRCLIB fallback | 4 Interlude dots | 5 Duet + BG vocals | 6 Floating lyrics window | 7 Cache + prefetch | 8 Free + OSS + Linux |
|---|---|---|---|---|---|---|---|---|
| **Sonata** | ✓ | ✓ marked "estimated", toggle | ✓ busy msg + capped retry; word pop via #2 | ✓ Apple + LRCLIB | ✓ | ✓ always-on-top, vinyl art, ring, rpm spin | ✓ disk + next-song prefetch | ✓ GPL-3.0, Linux |
| **Cider 4.x** (Cider Collective) | ✓ "Sing"/word-by-word lyrics, also in mini player, drawer, queue (4.0.25) | ✗ none found | ✗ no LRCLIB found; third-party sources are Musixmatch / NetEase (+ user-made "Lyrics Studio" lyrics, 4.0.0) | ✓ "gap countdown" (4.0.25), "interlude" (4.0.24) | ✓ duets + BG vocals (4.0.24, issues #1967, #1552) | partial: lyrics open inside the mini player window (4.0.27); mini player can be on top (issue #742); no vinyl/rpm found | partial: prefetches next and previous track's lyrics (4.0.25); disk cache **?** | ✗ proprietary, paid (itch.io / Taproom); Linux build exists |
| **Apple Music, macOS/iOS** | ✓ (Apple Music Sing, word timing) | ✗ line-only songs stay line-highlighted | ✗ Apple lyrics only (or user-typed, unsynced) | ✓ (Apple's own dots; Sonata copies the style) | ✓ | partial: macOS MiniPlayer has a Lyrics button (Apple guide); vinyl/ring ✗ | **?** | ✗ not on Linux, not OSS |
| **Apple Music, Windows app** | **?** Apple's guide only says synced lyrics; word timing unconfirmed | ✗ | ✗ | **?** | **?** | ✗ **?** | **?** | ✗ |
| **music.apple.com (web)** | partial **?** Apple serves `/syllable-lyrics` to the web player; YouLy+ calls the web rendering "laggy" | ✗ | ✗ | **?** | **?** | ✗ | ✗ | ✗ (web; free only to browse) |
| **Spotify desktop** | ✗ Spotify lyrics are line-synced (Musixmatch); one outlet (IBTimes AU, Feb 2026) reports a syllable "Karaoke View", not confirmed by TechCrunch or Spotify **?** | ✗ | ✗ | ✗ **?** | ✗ **?** | ✗ (mini player has no lyrics **?**) | partial: offline lyrics for Premium (2026) | ✗ |
| **Spicetify lyrics-plus** | ✗ (Spotify, not Apple); karaoke only from NetEase / Musixmatch | ✗ | ✓ LRCLIB provider (synced or plain) | ✗ (LRCLIB "instrumental" shows "♪ Instrumental ♪") | ✗ | ✗ | **?** | ✓ OSS, runs on Linux Spotify (needs Spotify) |
| **Spicetify Beautiful Lyrics** | partial: karaoke/syllable lyrics from its own service (source not documented) | ✗ none found | ✗ none found | ✓ (`Interlude` component in source) | ✓ "Background Vocals and Side Vocals" | ✗ (Page/Cinema/Fullscreen views) | **?** | partial: no licence file stated; needs Spotify; last push 2025-11 |
| **YouLy+** (browser extension) | partial: word/syllable lyrics on music.apple.com (experimental), YTM, Tidal; sources lrc.red, Unison, Lyrics+ backend | ✗ (line-synced shown line by line) | ✓ "primary fallback for synchronized lyrics" | ✓ gap lines (`lyrics-gap` in renderer) | ✓ singer sides + background vocals | ✗ (in-page) | ✓ local lyrics database **?** prefetch ✗ | ✓ MIT, any desktop browser incl. Linux; not an app |
| **Better Lyrics** (YTM extension) | ✗ (YouTube Music); word/syllable from Better Lyrics, Unison, Musixmatch… | ✗ | ✓ LRCLib is a provider | ✗ not documented | ✗ not documented | ✗ | ✓ storage (`storage.ts`) **?** | ✓ GPL-3.0, browser |
| **th-ch/youtube-music** (synced-lyrics plugin) | ✗ | ✗ cosmetic only: words fade in with a fixed 0.05 s stagger, not timed | ✓ LRCLib provider (+ Musixmatch, Megalobiz, YTM, Genius) | partial: empty LRC lines can show "•", "••", "•••" filling over the gap (opt-in; default "♪") | ✗ | ✗ | **?** | ✓ MIT, Linux |
| **Feishin** (Navidrome/Jellyfin) | ✗ (no Apple); karaoke from OpenSubsonic word cues | ✗ none found | ✓ lrclib.net provider (+ NetEase, Genius, SimpMusic) | ✗ none found | ✓ agents + background vocals (from server cues) | ✗ | partial: lyrics cached per source | ✓ GPL-3.0, Linux |
| **Strawberry** | ✗ | ✗ | ✓ LRCLIB provider (+ Musixmatch, Genius, …) | ✗ | ✗ | ✗ | partial (parsed synced lyrics cached) | ✓ GPL, Linux (local library) |
| **Elisa** (KDE) | ✗ | ✗ | ✗ (embedded/LRC only) | ✗ | ✗ | ✗ | ✗ | ✓ Linux, line highlight for LRC |
| **Amberol** (GNOME) | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✓ but no lyrics view found |
| **Lollypop** | ✗ | ✗ | **?** | ✗ | ✗ | ✗ | **?** | ✓ Linux, lyrics view (sources not re-checked) |
| **tidal-hifi** | ✗ (Tidal's own line lyrics) | ✗ | ✗ | ✗ **?** | ✗ **?** | ✗ | ✗ | ✓ Linux, OSS wrapper (needs Tidal) |
| **AMLL / SPlayer** (Apple-Music-like Lyrics ecosystem) | partial: Apple-style TTML word lyrics from the community AMLL TTML DB, not Apple's own | ✗ none found | **?** | ✓ (`amll:empty-beat` interlude marks) **?** for each host | ✓ (TTML agents, `x-bg`) | ✗ **?** | **?** | ✓ AGPL-3.0; SPlayer has Linux builds |
| **terminal-lyrics** (mgtaco, MPRIS) | partial: word lyrics from AMLL TTML DB / LyricsPlus | ✓ **interpolated from character counts, labelled as estimated** | ✓ LRCLIB (last source) | ✗ | ✗ | ✗ (terminal) | **?** | ✓ MIT, Linux; works with any MPRIS player |
| **squiggly-music** (OpenSubsonic) | ✗ | ✓ "each line's time is spread across its words by length" (PR #10, merged 2026-09-27) | ✗ | ✗ | ✗ | ✗ | ✗ | ✓ browser/desktop |
| **applemusic-tui** (amtui) | ✗ (lines only) | ✗ | ✓ LRCLIB is its only source | ✗ | ✗ | ✗ | ✗ | ✓ MIT, Linux (terminal) |
| **Sidra** (Apple Music wrapper) | Apple web only | ✗ | ✗ | – | – | ✗ "ships no mini player" | ✗ | ✓ BlueOak, Linux |

## What is genuinely unique to Sonata

Nothing on the list is unique **feature by feature**. Every single feature exists somewhere else.
What holds up is the **combination**, and a few specific details:

1. **The only free, open-source Apple Music app for Linux with Apple's word-timed lyrics, duets,
   background vocals and interlude dots.** Cider has all of that but is proprietary and paid. The
   other open-source Apple Music wrappers checked (Sidra, applemusic-tui, upstream
   apple-music-for-linux, Tabinol, Alex313031) show Apple's web lyrics or LRCLIB lines only.
   YouLy+ gets close on music.apple.com, but it is a browser extension (experimental on Apple
   Music) and does not use a desktop app.
2. **Estimated word timing for Apple's own line-timed lyrics, labelled as estimated.** No Apple
   Music client found does this (Apple, Cider, YouLy+ all fall back to line highlighting).
   Estimation itself is **not** new: terminal-lyrics (also labelled) and squiggly-music do it for
   their own sources.
3. **Apple lyrics first, LRCLIB second, in one Apple Music app.** Cider's third-party sources are
   Musixmatch / NetEase / user uploads; no LRCLIB found. YouLy+ (extension) does have LRCLIB as a
   fallback.
4. **Interlude dots on LRCLIB lyrics** (computed from the line gaps). Not found elsewhere as a
   timed countdown; th-ch's plugin has a dot-filling placeholder for *empty* LRC lines only.
5. **The vinyl lyrics window**: album art as a record label in a progress ring, spinning at 33⅓ rpm
   for albums and 45 rpm for singles/EPs. No other app found has that. (Small, but true and
   checkable.)
6. **Busy-service handling**: "Lyrics service busy, trying again…" plus capped retry. Not
   documented anywhere else, but it is too small to lead a website claim.

## What others also do (don't present as unique)

- Apple word/syllable lyrics with karaoke pop: Apple (macOS/iOS), **Cider**, YouLy+ (on Apple Music
  web), Beautiful Lyrics (Spotify, similar data).
- Interlude dots: Apple, **Cider** ("gap countdown"), Beautiful Lyrics, YouLy+, AMLL.
- Duet sides + background vocals: Apple, **Cider**, Beautiful Lyrics, YouLy+, Feishin, AMLL.
- LRCLIB fallback: lyrics-plus, th-ch youtube-music, Feishin, Strawberry, Better Lyrics, YouLy+,
  terminal-lyrics, applemusic-tui.
- Estimated word timing: terminal-lyrics (labelled), squiggly-music.
- Lyrics in a small floating window: Apple macOS MiniPlayer, **Cider** mini player (4.0.27).
- Next-song lyrics prefetch: **Cider** 4.0.25 (next *and* previous track).
- Free + open source + Linux: Feishin, Strawberry, th-ch youtube-music, Elisa, SPlayer…

## Claims to avoid

- "The only player with word-by-word / karaoke lyrics on Linux": false (Cider, Feishin, SPlayer,
  YouLy+/Better Lyrics in a browser).
- "The first / only app with estimated word timing": false (terminal-lyrics, squiggly-music).
- "The only Apple Music app with LRCLIB fallback": risky. True for desktop apps found, but YouLy+
  does it on music.apple.com in the browser. Say "app", never "way".
- "The only Apple Music app with Apple-style interlude dots, duets, background vocals": false
  (Cider; Apple itself).
- "The only Apple Music app with lyrics prefetch / a floating lyrics window": false (Cider).
- "Better than Cider" / "Cider doesn't have X" in general: Cider ships fast (4.0.24 → 4.0.27 in
  three weeks of Sept 2026) and its changelog keeps adding lyrics features. Anything
  Cider-negative should be dated and limited to what's checkable: proprietary licence, paid.
- "Unique lyrics" with no qualifier: the feature-by-feature answer is no.
- Anything about Apple's Windows app or the web player's lyrics: Apple doesn't document the timing
  level; we couldn't confirm.

## Suggested one-liners for the website

All three hold as of 2026-10-16 (re-check Cider's changelog before publishing):

1. **"The only free, open-source Apple Music player for Linux with Apple's word-by-word lyrics:
   duets, background vocals and interlude dots included."**
2. **"When Apple only has line timing, Sonata estimates the words and says so; when Apple has no
   lyrics, it falls back to LRCLIB."**
3. **"A floating lyrics window with your album as a spinning record: 33⅓ rpm for albums, 45 for
   singles."**

Safer alternative to #1 if you want zero comparative wording: "Apple's word-by-word lyrics on Linux,
free and open source, with duets, background vocals and interlude dots."

## Sources

Sonata (code, this repo): `lyrics-sources.js`, `lyrics-timing.js`, `lyrics.html`, `lyrics-store.js`,
`main.js`, `settings.html`; see also `docs/FEATURE-COMPARISON.md`.

Cider
- Changelog index and releases: https://cider.sh/changelogs (4.0.27 2026-09-22, 4.0.25 2026-09-10,
  4.0.24 2026-09-01, 4.0.0 2026-06-16), https://cider.sh/changelogs/4.0.25 (word-by-word in mini
  player, gap countdown, next/previous prefetch), https://cider.sh/changelogs/4.0.24 (interlude,
  duet background vocals), https://cider.sh/changelogs/4.0.27 (mini player: lyrics open in the same
  window), https://cider.sh/changelogs/4.0.0 (User Generated Lyrics), https://cider.sh/changelogs/2.1.0
  (third-party lyrics sources tweak), https://cider.sh/changelogs/x-beta17 (syllable lyrics, backing
  vocals, duets)
- Licence: https://github.com/ciderapp/Cider-2 ("not open-source … proprietary license")
- Issues: #1981 (Musixmatch → NetEase provider order), #2047/#2132 (Musixmatch), #1747 (NetEase),
  #1967 (duet lyrics), #1552/#1707 (BG vocals, Lyrics Studio), #742 (MiniPlayer not always on top),
  #1282 (floating lyrics panel, Linux 3.1.8), #2053 (word-synced lyrics timing)
  at https://github.com/ciderapp/Cider-2/issues

Apple
- Music for Mac, MiniPlayer + lyrics: https://support.apple.com/guide/music/mus71d7dcfce/mac
- Music for Mac, lyrics: https://support.apple.com/guide/music/musf438ffc97/mac
- Music for Windows, lyrics: https://support.apple.com/guide/music-windows/view-and-enter-lyrics-musf438ffc97/windows
- TTML duet/BG conventions (ttm:agent, x-bg): https://composer.betterlyrics.org/apple-music-synced-lyrics

Spotify / Spicetify
- TechCrunch 2026-02-04: https://techcrunch.com/2026/02/04/spotify-upgrades-its-lyrics-feature-with-offline-access-more-translations
- IBTimes AU (unconfirmed karaoke view): https://www.ibtimes.com.au/spotify-unveils-major-lyrics-update-karaoke-mode-translations-ai-features-now-live-1861359
- lyrics-plus README + `ProviderLRCLIB.js`: https://github.com/spicetify/cli/tree/main/CustomApps/lyrics-plus
- Beautiful Lyrics (README, `Extension/Source/Modules/LyricsRenderer/Components/Interlude.ts`):
  https://github.com/surfbryce/beautiful-lyrics

Browser extensions
- YouLy+ (README, `src/modules/lyrics/lyricsRenderer.js` gap lines, singer sides, BG vocals):
  https://github.com/ibratabian17/YouLyPlus, https://addons.mozilla.org/firefox/addon/youly/
- Better Lyrics: https://github.com/better-lyrics/better-lyrics

Linux players
- th-ch/youtube-music synced-lyrics plugin (`providers/LRCLib.ts`, `menu.ts`,
  `renderer/components/SyncedLine.tsx`): https://github.com/th-ch/youtube-music/tree/master/src/plugins/synced-lyrics
- Feishin (`src/main/features/core/lyrics/`, `src/renderer/features/lyrics/karaoke-lyric-line.tsx`):
  https://github.com/jeffvli/feishin
- Strawberry (`src/lyrics/lrcliblyricsprovider.cpp`, `src/context/contextview.h`):
  https://github.com/strawberrymusicplayer/strawberry
- Elisa (`src/models/lyricsmodel.h`): https://invent.kde.org/multimedia/elisa (GitHub mirror KDE/elisa)
- Amberol: https://gitlab.gnome.org/World/amberol (no lyrics code found in the GitHub mirror)
- tidal-hifi: https://github.com/Mastermindzh/tidal-hifi
- AMLL: https://github.com/amll-dev/applemusic-like-lyrics; AMLL editor TTML notes:
  https://deepwiki.com/amll-dev/amll-editor/3.2-ttml-format; SPlayer: https://snapcraft.io/splayer

Estimated word timing elsewhere
- terminal-lyrics: https://github.com/mgtaco/terminal-lyrics
- squiggly-music PR #10: https://github.com/parth-thakre/squiggly-music/pull/10

Other Apple Music Linux clients
- applemusic-tui: https://github.com/michael-slop/applemusic-tui
- Sidra: https://github.com/wimpysworld/sidra
- Linux Apple Music roundup (2026): https://www.linuxfordevices.com/tutorials/apple-music-linux

## Open questions (not checked)

- Cider: whether it caches lyrics on disk, and whether its mini player lyrics window can stay on top
  on Linux/Wayland today.
- Apple Windows app and music.apple.com: exact timing level shown (line vs word).
- Lollypop: current lyrics providers.
- AMLL hosts (SPlayer etc.): which of the AMLL features each host actually exposes on Linux.
