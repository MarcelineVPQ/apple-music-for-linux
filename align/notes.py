"""The note model's one interface for Settings -> "Sung notes (developer log)" (docs/LEVEL2-ALIGN.md
"Sung notes"):

    notes_from(f0, times, conf, syllables, opts=None) -> dict

The model itself is align/sung_notes.py, vendored unchanged from the research branch
(research-gpu-pipeline cfb48c7, research/notes-proto/sung_notes.py: numpy only, no file I/O). A newer
model replaces that file; this one and its callers (notes_step.py) stay as they are.

  f0         Hz per frame (0 or NaN = no pitch): RMVPE on the song's vocal stem
  times      frame times in s (10 ms frames from 0 here; other hops are resampled by the model)
  conf       RMVPE salience per frame (0..1)
  syllables  time-ordered [{t, end, text, line, word, syl, nsyl, word_text}] (notes_step.syllable_table)
  opts       {'profile': 'stem' (separated stems, the default), 'vthr': 0.7, 'loud': bool per frame
              (frames within 35 dB of the stem's loud singing, notes_step.loud_mask), 'params': {...},
              'key': (tonic pc, 'major'|'minor') when a key model ran (none in the helper)}
  -> {'format': 1, 'model', 'profile', 'viterbi', 'params' (the ones changed from the defaults),
      'duration_s', 'tuning': {cents, a4_hz, strength, track_hop_s?, track_cents?},
      'key': {name, tonic_pc, mode, fifths, source},
      'notes': [{t, end, midi, cents, name, conf, syl_index, line, word, syl, melisma,
                 cents_tuning?, octave_fixed?}],
      'confidence': {overall, note_stability, syllables_with_notes, notes_on_syllables},
      'counts': {octave_folded, octave_dropped}}
"""

from sung_notes import MODEL, FPS, notes_from  # noqa: F401
