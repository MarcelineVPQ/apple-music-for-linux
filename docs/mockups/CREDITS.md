# Credits for the wave-2 mock-ups

Design mock-ups only; nothing here ships in Sonata. Every outside item below keeps its own licence.

## Photos (Wikimedia Commons)

Downloaded 2026-10-17 and resized to 1600 px wide; otherwise unmodified.

- `img/gorge-amphitheatre.jpg`: "Gorge Amphitheatre.jpg" by Daniel from Calgary, Canada, CC BY 2.0 (https://creativecommons.org/licenses/by/2.0). Source: https://commons.wikimedia.org/wiki/File:Gorge_Amphitheatre.jpg
- `img/gorge-windy.jpg`: "Windy in the gorge (2542777024).jpg" by ArtBrom from Seattle, CC BY-SA 2.0 (https://creativecommons.org/licenses/by-sa/2.0). Source: https://commons.wikimedia.org/wiki/File:Windy_in_the_gorge_(2542777024).jpg
- `img/gorge-lilith-2010.jpg`: "Lilith Fair at Gorge at George in 2010.jpg" by Thayne Tuason, CC BY-SA 4.0 (https://creativecommons.org/licenses/by-sa/4.0). Source: https://commons.wikimedia.org/wiki/File:Lilith_Fair_at_Gorge_at_George_in_2010.jpg
- `img/gorge-doors-open.jpg`: "6pm - doors just opened (2542776190).jpg" by ArtBrom from Seattle, CC BY-SA 2.0 (https://creativecommons.org/licenses/by-sa/2.0). Source: https://commons.wikimedia.org/wiki/File:6pm_-_doors_just_opened_(2542776190).jpg
- `img/gorge-early.jpg`: "Early Amphitheater The Gorge, Near George, Washington.jpg" by Ken Kinnear, CC0 (https://creativecommons.org/publicdomain/zero/1.0/deed.en). Source: https://commons.wikimedia.org/wiki/File:Early_Amphitheater_The_Gorge,_Near_George,_Washington.jpg

Cover crops (square crops, 640 px) made from the photos above, same licence and author as their source:

- `img/cover-gorge.jpg` from `img/gorge-amphitheatre.jpg` (Daniel from Calgary, Canada, CC BY 2.0)
- `img/cover-windy.jpg` from `img/gorge-windy.jpg` (ArtBrom from Seattle, CC BY-SA 2.0)
- `img/cover-lilith.jpg` from `img/gorge-lilith-2010.jpg` (Thayne Tuason, CC BY-SA 4.0)

The album colours and Glass backdrops in `data/albums.js` are computed from these crops by Sonata's own palette.js and theme.js.

## Voice recording and note data

- `data/clementine.ogg` (Opus re-encode) and the analysis in `data/clementine.js`: vocadito track 11, from "vocadito: A dataset of solo vocals with f0, note, and lyric annotations" by Rachel Bittner, Katherine Pasalo, Juan José Bosch, Gabriel Meseguer Brocal and David Rubinstein (2021), CC BY 4.0, https://zenodo.org/records/5578807. The notes, syllables and pitch line are Sonata's own prototype output on it (docs/research/notes-proto on the research-gpu-pipeline branch).
- `img/proto-clementine.png`: that prototype's render of the same excerpt.

## Text

- Wikipedia excerpts (liner-notes.html): "The Gorge Amphitheatre" (https://en.wikipedia.org/wiki/The_Gorge_Amphitheatre) and "Oh My Darling, Clementine" (https://en.wikipedia.org/wiki/Oh_My_Darling,_Clementine), CC BY-SA 4.0, trimmed, fetched 2026-10-17.
- Lyrics: "Oh My Darling, Clementine", words by Percy Montrose (1884), public domain. Track titles are traditional public-domain songs.
- The band, album, people, hosts, dialogue and editorial text are fictional placeholders written for the mock-ups.

## Fonts

System fonts only (Ubuntu / Cantarell stack as in Sonata, Noto Serif for the booklet, Noto Music for the clef and accidentals).
