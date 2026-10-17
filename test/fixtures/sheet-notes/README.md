# Sheet-notes fixtures

Saved helper output for `test/sheet-notes.test.js`: each file is a cached entry
(`sheet-notes-model.js` `compact()`) for a window of a song, the first-play pitch pieces cut to the
same window, and the song's lyric lines there. Made on 2026-10-17 by running Sonata's own
align-session + sonata-align helper (Demucs, alignment, RMVPE, `align/sung_notes.py`) on the
JamendoLyrics test songs, which are Creative Commons:

| File | Song | Licence | What it covers |
|---|---|---|---|
| `cortez-feel-stripped.json` | Cortez – Feel (Stripped) | CC BY | sung, bass clef, 0:25–0:50 |
| `rxbyn-bad-side.json` | Rxbyn – Bad Side | CC BY | sung, off-key accidentals, 0:34–1:00 |
| `wilson-way-te-recuerdo.json` | Wilson Way – Te Recuerdo | CC BY-SA | rapped verses, then the sung chorus, 0:12–1:06 |
| `synthetic-rap.json` | (synthetic, seeded) | – | a rapped stretch: notes off the pitch grid |

The note data are transcriptions of those recordings, kept under the same licences as the songs
(attribution above; the BY-SA file under BY-SA). No audio is stored here.
