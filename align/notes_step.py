"""The sung notes step of the whole-song job: Settings -> "Sung notes (developer log)", Development
channel only, off by default (docs/LEVEL2-ALIGN.md "Sung notes").

After a song's whole-song alignment has been delivered, server.py keeps that job's vocal stem (CPU,
16 kHz mono, the stem the alignment already separated: no second separation), the aligned lines and
each character's first frame. A `notes` request then runs:

  vocal stem -> RMVPE f0 (rmvpe.py, MIT weights, GPU when there is room) -> the aligned syllables
  -> notes.notes_from (the note model's one interface; the model is sung_notes.py, vendored from
  the research branch) -> the note JSON's helper part; Sonata (main) adds the song's identity and
  Sonata's version and writes the file.

RMVPE is loaded for the job and freed after it (about 0.2 GB of weights, 0.6 GB working set).
Nothing here downloads unless asked: download_rmvpe() runs only for `prepare` mode "notes", which
Sonata sends when the switch is turned on.
"""

import json
import os
import time

import numpy as np

import sonata_align as SA
import notes as N

# RVC's rmvpe.pt (lj1995/VoiceConversionWebUI on Hugging Face, MIT): checked by size and SHA-256
RMVPE = {
    'url': 'https://huggingface.co/lj1995/VoiceConversionWebUI/resolve/main/rmvpe.pt',
    'file': 'rmvpe.pt', 'bytes': 181184272,
    'sha256': '6d62215f4306e3ca278246188607209f09af3dc77ed4232efdd069798c4ec193', 'licence': 'MIT',
}
F0_MODEL = 'rmvpe'
GATE_DB = 35.0          # a frame counts as sung within this of the stem's loud singing (95th percentile)
# free graphics memory the step needs: weights + working set (32 s chunks) + the alignment's margin
WORK_BYTES = int(0.9e9)


def rmvpe_path():
    return os.path.join(SA.MODEL_DIR, RMVPE['file'])


def have_rmvpe():
    p = rmvpe_path()
    return os.path.exists(p) and os.path.getsize(p) == RMVPE['bytes']


def download_rmvpe(progress=None):
    """Once, into the helper's models dir; a wrong size or checksum raises SA.ChecksumError."""
    if have_rmvpe():
        return rmvpe_path()
    return SA.fetch(RMVPE['url'], rmvpe_path(), RMVPE['bytes'], sha256=RMVPE['sha256'], progress=progress, label='rmvpe')


def vram_need():
    return WORK_BYTES + SA.VRAM_MARGIN_BYTES


def syllable_table(results, char_first, syl_spec, frame=SA.FRAME, frame_offset=SA.FRAME_OFFSET, normalise=None):
    """Syllable starts of the aligned lines: each word split as Sonata split it (syl_spec[line]: per
    word the syllable texts, or null = one syllable), each part starting at the first aligned frame of
    its characters. char_first: {(line, word, char index in the normalised word): frame}.
    -> time-ordered [{t, end, text, line, word, syl, nsyl, word_text}]"""
    norm = normalise or (lambda s: s)
    rows = []
    # loop: NOT-WORTH — the song's lines and words (hundreds), once per song
    for r in results:
        if not r.get('aligned'):
            continue
        i = r['line']
        spec = (syl_spec[i] if isinstance(syl_spec, list) and i < len(syl_spec) else None) or []
        for k, w in enumerate(r['words']):
            if w.get('t') is None:
                continue
            parts = spec[k] if k < len(spec) and isinstance(spec[k], list) and spec[k] else [w['text']]
            syl, at = [], 0
            for part in parts:
                n = len(norm(str(part)))
                frs = [char_first[(i, k, c)] for c in range(at, at + n) if (i, k, c) in char_first]
                if frs:
                    syl.append({'text': str(part), 't': round(min(frs) * frame + frame_offset, 3)})
                at += n
            syl.sort(key=lambda s: s['t'])
            if not syl:
                syl = [{'text': w['text'], 't': w['t']}]
            syl[0]['t'] = w['t']
            for j, s in enumerate(syl):
                end = syl[j + 1]['t'] if j + 1 < len(syl) else w['end']
                rows.append({'t': s['t'], 'end': round(max(end, s['t'] + 0.02), 3), 'text': s['text'], 'line': i, 'word': k,
                             'syl': j, 'nsyl': len(syl), 'word_text': w['text']})
    rows.sort(key=lambda s: s['t'])
    return rows


def level_db(stem16, covered=None, n_frames=None):
    """The stem's level per 10 ms frame (sonata_align.vocal_db at 20 ms, each value twice); NaN
    where no section was heard (covered: the stitched song's 20 ms mask)."""
    db = SA.vocal_db(stem16).astype(np.float64)
    if covered is not None:
        m = np.asarray(covered, bool)[:len(db)]
        db[:len(m)][~m] = np.nan
    db = np.repeat(db, 2)
    if n_frames is not None:
        db = np.pad(db, (0, max(0, n_frames - len(db))), constant_values=np.nan)[:n_frames]
    return db


def loud_mask(db, gate_db=GATE_DB):
    """The model's 'loud' gate: frames within gate_db of the stem's loud singing; never a frame
    nobody heard (the separated stem is never silent: bleed and reverb tails get a pitch too)."""
    heard = np.isfinite(db)
    if not heard.any():
        return np.zeros(len(db), dtype=bool)
    ref = np.percentile(db[heard], 95)
    return heard & (np.nan_to_num(db, nan=-1e9) > ref - gate_db)


def plain(x):
    """numpy scalars and arrays -> plain JSON values (the reply is json.dumps'd)."""
    return json.loads(json.dumps(x, default=lambda v: v.item() if hasattr(v, 'item') and np.ndim(v) == 0 else
                                 (v.tolist() if hasattr(v, 'tolist') else str(v))))


def line_table(results, req_lines):
    out = []
    # loop: NOT-WORTH — the song's lines (tens), once per song
    for r in results:
        i = r['line']
        ws = [w for w in r.get('words') or [] if w.get('t') is not None]
        text = (req_lines[i].get('text') if i < len(req_lines) and isinstance(req_lines[i], dict) else None) or ' '.join(w['text'] for w in r.get('words') or [])
        out.append({'index': i, 'text': text, 'aligned': bool(r.get('aligned')),
                    't': ws[0]['t'] if ws else None, 'end': max((w['end'] for w in ws), default=None)})
    return out


class Kept:
    """What a whole-song job leaves for its notes step: the song id, the vocal stem (CPU float32 at
    16 kHz, ~15 MB for 4 min), the covered mask (stitched songs), the aligned lines, the character
    frames, the request lines. lifetime: until the notes request, a 'forget' of the song, the next
    whole-song job with notes, or the helper's exit (server.py holds at most one)."""

    def __init__(self, song, stem, covered, results, char_first, req_lines, language, label_index=None):
        self.song, self.stem, self.covered = song, stem, covered
        self.results, self.char_first, self.req_lines, self.language = results, char_first, req_lines, language
        self.label_index = label_index    # the aligner's characters (normalise_word), for the syllable split


def _f0(stem, device, torch, st, cancelled):
    """RMVPE over a CPU stem (16 kHz float32) -> (f0 Hz, voicing confidence) at 10 ms. The weights
    live for this call only (freed before returning, also on an error)."""
    from rmvpe import RMVPE as Net
    t = time.time()
    net = None
    try:
        net = Net(rmvpe_path(), device)
        st['load_s'] = round(time.time() - t, 2)
        if cancelled():
            raise SA.Cancelled()
        t = time.time()
        if device.startswith('cuda'):
            torch.cuda.reset_peak_memory_stats()
        sal = net.salience(torch.from_numpy(np.ascontiguousarray(stem, dtype=np.float32)))
        f0, conf = net.decode(sal)
        del sal
        if device.startswith('cuda'):
            torch.cuda.synchronize()
            st['vram_peak_mb'] = round(torch.cuda.max_memory_allocated() / 2 ** 20)
        st['f0_s'] = round(time.time() - t, 2)
        return f0, conf
    finally:
        del net                       # lifetime: the RMVPE weights live for this step only
        if device.startswith('cuda'):
            torch.cuda.empty_cache()


# The Studio's pitch line (Settings -> "Sheet notes in the Studio"): the sung pitch as one value per
# PITCH_HOP_S, in tenths of a semitone (MIDI x 10, an int), 0 where nobody sings. About 20 values a
# second: a 4-minute song is ~4,800 small ints (~15 kB of JSON). It is a drawing of the melody, not
# audio: nothing of the voice can be rebuilt from it.
PITCH_HOP_S = 0.05


def contour(f0, conf, loud=None, vthr=0.7, fps=100, hop_s=PITCH_HOP_S, t0=0.0, tuning_cents=0.0):
    """The pitch line from frame f0/confidence: per hop the median MIDI of the frames that are voiced
    (conf >= vthr), loud (when a gate is given) and at least half of the hop; else 0. tuning_cents is
    taken off, so the line sits on the same staff as the notes (which are spelled in the song's tuning).
    -> {'t0': s, 'hop': s, 'v': [int]}"""
    f0 = np.nan_to_num(np.asarray(f0, dtype=np.float64), nan=0.0)
    conf = np.asarray(conf, dtype=np.float64)[:len(f0)]
    ok = (f0 > 0) & (conf >= vthr)
    if loud is not None:
        g = np.asarray(loud, bool)[:len(ok)]
        ok[:len(g)] &= g
        ok[len(g):] = False
    k = max(1, int(round(hop_s * fps)))
    n = (len(f0) + k - 1) // k
    midi = np.full(n * k, np.nan)
    with np.errstate(divide='ignore', invalid='ignore'):
        midi[:len(f0)] = np.where(ok, 69.0 + 12.0 * np.log2(np.where(f0 > 0, f0, 1.0) / 440.0) - tuning_cents / 100.0, np.nan)
    m = midi.reshape(n, k)
    have = np.sum(np.isfinite(m), axis=1)
    out = np.zeros(n, dtype=np.int64)
    sel = have * 2 >= k
    if sel.any():
        out[sel] = np.round(np.nanmedian(m[sel], axis=1) * 10).astype(np.int64)
    return {'t0': round(float(t0), 3), 'hop': hop_s, 'v': [int(x) for x in np.clip(out, 0, 1270)]}


def pitch_section(stem, offset_s, device='cpu', torch=None, cancelled=lambda: False):
    """The first play's pitch line for one section the helper kept (its stem starts at offset_s in
    the song). -> ({'t0', 'hop', 'v'}, stats). No notes, no syllables: the line only."""
    import torch as _torch
    torch = torch or _torch
    if not have_rmvpe():
        raise FileNotFoundError('the RMVPE pitch model is not downloaded')
    st = {'device': device}
    f0, conf = _f0(stem, device, torch, st, cancelled)
    if cancelled():
        raise SA.Cancelled()
    loud = loud_mask(level_db(stem, None, len(f0)))
    return contour(f0, conf, loud, t0=offset_s), st


def run(kept, syl_spec, device='cpu', torch=None, progress=None, cancelled=lambda: False):
    """The notes step on a Kept job. -> (helper part of the note JSON, stats). RMVPE is freed before
    returning, also on an error. The part carries the whole song's pitch line ('pitch', contour())
    for the Studio; the developer log leaves it out (notes-log.js buildDoc)."""
    import torch as _torch
    torch = torch or _torch
    if not have_rmvpe():
        raise FileNotFoundError('the RMVPE pitch model is not downloaded')
    st = {'device': device}
    if progress:
        progress('notes', 0.1)
    f0, conf = _f0(kept.stem, device, torch, st, cancelled)
    if cancelled():
        raise SA.Cancelled()
    if progress:
        progress('notes', 0.6)
    t = time.time()
    T = len(f0)
    times = np.arange(T) / float(N.FPS)
    syl = syllable_table(kept.results, kept.char_first, syl_spec, normalise=label_norm_for(kept))
    loud = loud_mask(level_db(kept.stem, kept.covered, T))
    res = N.notes_from(f0, times, conf, syl, {'profile': 'stem', 'loud': loud})
    st['notes_s'] = round(time.time() - t, 2)
    st['frames'] = T
    # no key or beat model in the helper (S-KEY and Beat This! are not in its venv): no beats or bars
    part = dict(res, f0_model=F0_MODEL, vthr=0.7, gate_db=GATE_DB, beats=[], bars=[], meter=None, tempo_bpm=None,
                lines=line_table(kept.results, kept.req_lines), syllables=syl, language=kept.language)
    part['confidence'] = dict(part.get('confidence') or {}, loud_share=round(float(np.mean(loud)) if T else 0.0, 3))
    part['pitch'] = contour(f0, conf, loud, tuning_cents=float((res.get('tuning') or {}).get('cents') or 0.0))
    return plain(part), st


def label_norm_for(kept):
    """The aligner's own word normalisation, so syllable parts map to the aligned characters."""
    labels = getattr(kept, 'label_index', None)
    if not labels:
        return None
    return lambda s: SA.normalise_word(s, labels)
