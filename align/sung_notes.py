"""Sung notes from a vocal f0 contour: Sonata's note model, one self-contained module.

Needs numpy only (numba, when installed, compiles the Viterbi; scipy only for the optional vibrato
low-pass, which no profile uses). No research-only imports, nothing read or written on disk, so
Sonata's align helper can vendor this file as it is.

Entry point:

    notes_from(f0, times, conf, syllables, opts=None) -> dict

    f0         Hz per frame (0 or NaN = no pitch), e.g. RMVPE on the separated vocal stem
    times      frame times in seconds (any steady hop; resampled to the model's 10 ms grid)
    conf       the f0 model's voicing confidence per frame (RMVPE salience 0..1)
    syllables  time-ordered dicts with at least 't' (start, s); optional 'end', 'text', 'line',
               'word', 'syl', 'word_text', 'nsyl' are passed through to the notes
    opts       {'profile': 'stem' (default) | 'solo', 'vthr': 0.7 (RMVPE), 'loud': bool per frame
               (optional gate: frames within ~35 dB of the stem's loud singing), 'params': {...}
               overrides, 'key': (tonic pc, 'major'|'minor') when a key model ran}

Returns {'format': 1, 'model': MODEL, 'profile', 'params', 'tuning', 'key', 'notes', 'confidence'};
every note: t, end, midi, cents, name (spelled in the key), conf, syl_index, line, word, syl,
melisma (+ cents_tuning with the sliding tuning, octave_fixed when the octave check moved it).

Our own code (GPL-3.0 with Sonata). The model follows Tony (Mauch et al., ISMIR 2015) in idea
only; Tony's pYIN/Vamp code is GPL-2.0 and none of it is used.

1. Tuning. The song's reference offset is the circular mean of (MIDI mod 1) over stable voiced
   frames: offset = arg(sum w e^{2 pi i m}) / 2 pi. Everything after works in tuned semitones.
2. Vibrato. A zero-phase low-pass (default 3 Hz) on each voiced run removes 5-7 Hz vibrato from
   the contour the HMM sees. The note's pitch is still the median of the raw frames.
3. Note HMM. For every semitone p in the song's range, three states: attack A_p, stable S_p,
   silence-after-note Z_p (Z remembers the last pitch, so the next note's interval has a prior).
     emissions: A/S: log v + log N(m; p, sigma_A or sigma_S);  Z: log(1 - v) + log(1/P)
                (v = voicing probability, m = smoothed tuned MIDI; unvoiced frames carry no pitch)
     transitions: A->A, A->S, S->S, S->Z, Z->Z; S_p->A_q (legato) and Z_p->A_q with an interval
                prior J(q - p) that favours small steps; a same-pitch re-attack is unlikely
                unless a syllable starts there.
   Forced onsets (syllable starts from the forced alignment): at that frame no note may continue;
   every path enters A_q or Z_q, and a repeated pitch is as likely as a step. This is the ROSVOT
   rule ("word boundary => note boundary") inside an HMM.
   Viterbi in numba: ~1 ms per second of audio.
4. Clean-up: merge same-pitch neighbours with a short gap (no syllable start between), drop notes
   under 60 ms unless they start a syllable.
5. Syllables: each note goes to the syllable it starts in; several notes on one syllable = melisma.

Fixes after the first scoring (2026-10-17, all off in PARAMS so the first run stays reproducible;
switched on by PROFILES['solo'] for clean singing and PROFILES['stem'] for separated stems):
 e. Spelling (keys.spell_notes consistent=True): one name per pitch class inside a key region.
 a. Sliding tuning (`tuning_win_s`): a windowed circular mean of the fractional MIDI (box window,
    shrunk toward the global offset where the window has little stable singing), unwrapped over
    time, so a drifting singer keeps the same notes. Each note reports its local offset.
 b. Repeated notes (`split_repeats`): a held note is split where an aligned syllable starts inside
    it, when the note is at least `split_min_s` long and the start is `split_margin_s` away from
    both ends (a soft prior: the HMM itself still decides every pitch change). The cut moves to
    the deepest voicing-confidence dip within `split_win_s` (the consonant).
 c. Glides (`glide_max_s`): a short piece touching a longer note at most `glide_st` semitones away
    is a scoop into it (before) or a fall out of it (after) and becomes part of it; the note keeps
    the pitch of its stable part. A scoop may start a syllable, a fall may not.
 d. Octave check (`octave_check`): a note 9+ semitones from the duration-weighted median of its
    neighbours (within `octave_ctx_s`), 7+ from the notes right before and after it (an isolated
    excursion, not a leap into a new phrase), that lands within 5 of it one octave over is an octave
    error (folded) when the f0 model was sure of it, else bleed (dropped).

Key and spelling (from keys.py, the parts without models): Krumhansl-Schmuckler on the notes'
duration-weighted pitch classes when no key is given, key signatures, and line-of-fifths spelling.
Note: K-S on the melody alone can't tell relative keys apart (12 of 20 JamendoLyrics songs agreed
with S-KEY on the instrumental; most others were relatives or neighbours).
"""


import numpy as np

PARAMS = {
    'lowpass_hz': 3.0,      # vibrato smoothing (0 = off)
    'sigma_s': 0.45,        # semitones, stable state
    'sigma_a': 1.2,         # semitones, attack state (scoops)
    'p_aa': 0.6,            # attack self-transition (mean ~25 ms)
    'p_s_end': 0.02,        # stable -> silence
    'p_s_leg': 0.01,        # stable -> next note's attack (legato)
    'p_z_on': 0.02,         # silence -> next note's attack
    'interval_scale': 3.0,  # semitones; J(d) ~ exp(-|d| / scale), |d| <= 12
    'reattack_free': 0.05,  # weight of a same-pitch re-attack without a syllable start (vs 1 step = e^-1/3)
    'v_hi': 0.97,           # voicing probability of a voiced frame
    'min_note_s': 0.06,     # shorter notes are dropped unless they start a syllable
    'merge_gap_s': 0.05,    # same-pitch notes closer than this merge (no syllable start between)
    'onset_snap_s': 0.03,   # a note "starts a syllable" within this distance
    'attack_skip_s': 0.03,  # the note pitch ignores this much of the onset (scoop)
    'onset_mode': 'snap',   # syllable starts: 'hard' (no note continues across), 'snap' (hard, after
                            # moving it to the nearest voicing dip or pitch step), 'soft' (a window
                            # where a new note is likely), 'off'
    'onset_win_s': 0.04,
    'snap_win_s': 0.06,     # snap: move each syllable start to the clearest boundary within +- this    # soft window: +- this around each syllable start
    'p_on_leg': 0.3,        # soft: chance of a legato note change somewhere in the window
    'p_on_z': 0.5,          # soft: chance of silence -> attack somewhere in the window
    # fixes a-d (see the module doc); these defaults reproduce the first run
    'tuning_win_s': 0.0,    # sliding tuning window (0 = one global offset)
    'tuning_min_s': 1.5,
    'tuning_max_dev': 0.4,
    'tuning_conc': True,    # weight windows by their concentration too (not only by stable frames)
    'tuning_unwrap': False, # follow the local offset across semitone boundaries  # semitones the local offset may move from the global one    # seconds of stable singing at which the local estimate gets half weight
    'split_repeats': False,
    'split_min_s': 0.2,     # only notes at least this long are split
    'split_margin_s': 0.08, # the syllable start must lie this far inside the note
    'split_win_s': 0.05,    # move the cut to the deepest voicing dip within +- this
    'split_dip': 0.9,       # a dip: model confidence below this share of the note's median
    'split_need_dip': False,  # split only where such a dip (a consonant) is found
    'glide_max_s': 0.0,     # pieces shorter than this can be glides (0 = off)
    'glide_st': 2,          # semitones between a glide and its note
    'glide_ratio': 2.0,     # the note must be this many times longer than the glide
    'keep_syl_s': 0.0,      # a short note within this of a syllable start is kept (the start is
                            # only good to ~50 ms, so a short syllable's note can sit off it)
    'octave_check': False,
    'octave_ctx_s': 4.0,
    'octave_conf': 0.8,     # model confidence below this = bleed (drop), else octave error (fold)
}

# The first run's choices, swept on vocadito's dev tracks (eval_vocadito.py --sweep, 2026-10-16)
FIRST_RUN = {'lowpass_hz': 0, 'sigma_s': 0.8, 'p_s_leg': 0.001, 'min_note_s': 0.04, 'onset_mode': 'soft'}
VTHR = {'rmvpe': 0.7, 'swiftf0': 0.7}      # voicing thresholds for notes (same sweep)

# Picked on vocadito's dev tracks (odd ids) only; see eval_fixes.py. 'stem' adds the minimum note
# length for separated stems (vocadito annotators mark very short notes; stems carry scoops,
# falls and bleed that a solo recording doesn't).
PROFILES = {
    # adopted on vocadito dev (eval_fixes.py --sweep: gain >= 0.005 on dev); glides and the
    # octave check gained nothing on solo voices there, so they stay off for 'solo'
    'solo': {'tuning_win_s': 20, 'tuning_min_s': 0.25, 'tuning_max_dev': 0.25,
             'split_repeats': True, 'split_min_s': 0.2, 'split_margin_s': 0.08, 'split_win_s': 0.08,
             'split_dip': 0.9, 'split_need_dip': True},
    # stems: not tunable on vocadito (no stems with note truth); values from the first run's
    # failure list (80-100 ms minimum, scoops and falls of 1-2 semitones, bleed octaves), checked
    # for harm on vocadito and for plausibility on JamendoLyrics
    'stem': {'min_note_s': 0.09, 'keep_syl_s': 0.08, 'glide_max_s': 0.12, 'glide_st': 2, 'glide_ratio': 1.5,
             'octave_check': True, 'octave_conf': 0.8},
}
PROFILES['stem'] = dict(PROFILES['solo'], **PROFILES['stem'])

NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']


def hz_to_midi(f0):
    f0 = np.asarray(f0, dtype=np.float64)
    m = np.full(f0.shape, np.nan)
    ok = f0 > 0
    m[ok] = 69.0 + 12.0 * np.log2(f0[ok] / 440.0)
    return m


def midi_to_hz(m):
    return 440.0 * 2.0 ** ((np.asarray(m, dtype=np.float64) - 69.0) / 12.0)


def tuning_offset(midi, voiced):
    """Circular mean of the fractional MIDI over stable voiced frames.
    Returns (offset in semitones in [-0.5, 0.5), concentration 0..1)."""
    m = np.asarray(midi)
    ok = voiced & np.isfinite(m)
    ok[1:-1] &= np.abs(np.nan_to_num(m[2:] - m[:-2], nan=9.0)) < 0.15     # stable: < 15 cents per 20 ms
    ok[[0, -1]] = False
    if ok.sum() < 20:
        return 0.0, 0.0
    z = np.exp(2j * np.pi * m[ok]).mean()
    off = float(np.angle(z) / (2 * np.pi))
    return (off + 0.5) % 1.0 - 0.5, float(abs(z))


def tuning_track(midi, voiced, glob, win_s, fps=100, min_s=1.5, max_dev=0.4, hop_s=0.5, unwrap=False, conc=True):
    """Per-frame tuning offset (semitones): circular mean of (MIDI mod 1) over the stable voiced
    frames in a centred box of win_s, on a hop_s grid, at most max_dev from the global offset and
    shrunk toward it by nR^2 / (nR^2 + min_s * fps) (n = stable frames in the window, R = their
    resultant length). Not unwrapped: following the estimate across a semitone walked studio
    stems up to 1.6 semitones away (first try, 2026-10-17)."""
    m = np.asarray(midi)
    T = len(m)
    ok = voiced & np.isfinite(m)
    ok[1:-1] &= np.abs(np.nan_to_num(m[2:] - m[:-2], nan=9.0)) < 0.15
    if T:
        ok[[0, -1]] = False
    z = np.where(ok, np.exp(2j * np.pi * np.nan_to_num(m)), 0)
    cz = np.concatenate([[0], np.cumsum(z)])
    cn = np.concatenate([[0], np.cumsum(ok)])
    hop = max(1, int(round(hop_s * fps)))
    grid = np.arange(0, T, hop)
    half = int(round(win_s * fps / 2))
    a = np.clip(grid - half, 0, T)
    b = np.clip(grid + half + 1, 0, T)
    zs, ns = cz[b] - cz[a], cn[b] - cn[a]
    loc = np.where(ns > 0, np.angle(zs) / (2 * np.pi), glob)
    d = (loc - glob + 0.5) % 1.0 - 0.5                         # nearest to the global offset
    if unwrap:                                                 # follow it over time
        d = np.unwrap(d * 2 * np.pi) / (2 * np.pi)
        d -= np.round(np.median(d))
    d = np.clip(d, -max_dev, max_dev)
    # weight: stable frames times the concentration (resultant length) of the window, so a
    # window of scattered pitches (glides, speech, bleed) stays at the global offset
    R = np.abs(zs) / np.maximum(ns, 1)
    nr = ns * R * R if conc else ns.astype(np.float64)
    w = nr / (nr + min_s * fps)
    off = glob + w * d
    return np.interp(np.arange(T), grid, off) if T else np.zeros(0)


def runs(mask):
    """[(a, b)] index ranges of True runs."""
    d = np.diff(np.concatenate([[0], mask.astype(np.int8), [0]]))
    return list(zip(np.flatnonzero(d == 1), np.flatnonzero(d == -1)))


def lowpass(m, voiced, hz, fps=100):
    if not hz:
        return m.copy()
    from scipy.signal import butter, filtfilt
    b, a = butter(2, hz / (fps / 2))
    out = m.copy()
    # loop: one filter per voiced run
    for s, e in runs(voiced & np.isfinite(m)):
        if e - s > 12:
            out[s:e] = filtfilt(b, a, m[s:e], padlen=min(9, e - s - 1))
    return out


def _viterbi_loop(obsA, obsS, obsZ, hard, use_on, ljf, ljo, l_aa, l_as, l_ss, l_sz, l_sl, l_zz, l_za):
    """hard[t]: no note may continue into t. use_on[t]: a syllable may start here (soft): the
    legato / silence -> attack transitions l_sl[t], l_za[t] are raised and a same-pitch
    re-attack is as likely as a step (interval prior ljo instead of ljf)."""
    T, P = obsA.shape
    NEG = -1e18
    dA = np.empty(P); dS = np.empty(P); dZ = np.empty(P)
    for p in range(P):
        dA[p] = obsA[0, p] - np.log(P)
        dS[p] = NEG
        dZ[p] = obsZ[0] - np.log(P)
    back = np.zeros((T, 3 * P), dtype=np.int32)      # previous state index
    nA = np.empty(P); nS = np.empty(P); nZ = np.empty(P)
    for t in range(1, T):
        if hard[t]:
            for q in range(P):
                best, arg = NEG, 0
                for p in range(P):
                    j = ljo[q - p + P - 1]
                    v = dA[p] + j
                    if v > best:
                        best, arg = v, p
                    v = dS[p] + j
                    if v > best:
                        best, arg = v, P + p
                    v = dZ[p] + j
                    if v > best:
                        best, arg = v, 2 * P + p
                nA[q] = best + obsA[t, q] - 0.6931
                back[t, q] = arg
                nS[q] = NEG
                back[t, P + q] = P + q
                best, arg = dA[q], q
                if dS[q] > best:
                    best, arg = dS[q], P + q
                if dZ[q] > best:
                    best, arg = dZ[q], 2 * P + q
                nZ[q] = best + obsZ[t] - 0.6931
                back[t, 2 * P + q] = arg
        else:
            lj = ljo if use_on[t] else ljf
            for q in range(P):
                best, arg = dA[q] + l_aa, q
                for p in range(P):
                    j = lj[q - p + P - 1]
                    v = dS[p] + l_sl[t] + j
                    if v > best:
                        best, arg = v, P + p
                    v = dZ[p] + l_za[t] + j
                    if v > best:
                        best, arg = v, 2 * P + p
                nA[q] = best + obsA[t, q]
                back[t, q] = arg
                if dA[q] + l_as >= dS[q] + l_ss[t]:
                    nS[q] = dA[q] + l_as + obsS[t, q]
                    back[t, P + q] = q
                else:
                    nS[q] = dS[q] + l_ss[t] + obsS[t, q]
                    back[t, P + q] = P + q
                best, arg = dZ[q] + l_zz[t], 2 * P + q
                if dS[q] + l_sz > best:
                    best, arg = dS[q] + l_sz, P + q
                if dA[q] + l_sz > best:
                    best, arg = dA[q] + l_sz, q
                nZ[q] = best + obsZ[t]
                back[t, 2 * P + q] = arg
        for q in range(P):
            dA[q] = nA[q]; dS[q] = nS[q]; dZ[q] = nZ[q]
    best, s = NEG, 0
    for q in range(P):
        if dA[q] > best:
            best, s = dA[q], q
        if dS[q] > best:
            best, s = dS[q], P + q
        if dZ[q] > best:
            best, s = dZ[q], 2 * P + q
    path = np.empty(T, dtype=np.int32)
    for t in range(T - 1, -1, -1):
        path[t] = s
        s = back[t, s]
    return path


def _viterbi_np(obsA, obsS, obsZ, hard, use_on, ljf, ljo, l_aa, l_as, l_ss, l_sz, l_sl, l_zz, l_za):
    """The same Viterbi as _viterbi_loop, vectorised over the P x P pitch transitions (numpy only).
    Same back-pointer encoding (A = q, S = P + q, Z = 2P + q)."""
    T, P = obsA.shape
    NEG = -1e18
    idx = np.arange(P)
    Mf = ljf[idx[:, None] - idx[None, :] + P - 1]          # [q, p] interval prior, free
    Mo = ljo[idx[:, None] - idx[None, :] + P - 1]          # [q, p] at a syllable start
    dA = obsA[0] - np.log(P)
    dS = np.full(P, NEG)
    dZ = np.full(P, obsZ[0] - np.log(P))
    back = np.zeros((T, 3 * P), dtype=np.int32)
    # loop: one step per 10 ms frame (T ~ 24 000 for a 4-minute song), P x P numpy work each;
    # SERIAL-REQUIRED (each frame needs the previous one)
    for t in range(1, T):
        if hard[t]:
            cand = np.stack([dA[None, :] + Mo, dS[None, :] + Mo, dZ[None, :] + Mo], axis=2).reshape(P, 3 * P)
            # order per p: A, S, Z (as the loop); flat index p*3 + kind -> state kind*P + p
            j = np.argmax(cand, axis=1)
            nA = cand[idx, j] + obsA[t] - 0.6931
            back[t, :P] = (j % 3) * P + j // 3
            nS = np.full(P, NEG)
            back[t, P:2 * P] = P + idx
            st = np.stack([dA, dS, dZ], axis=1)
            k = np.argmax(st, axis=1)
            nZ = st[idx, k] + obsZ[t] - 0.6931
            back[t, 2 * P:] = k * P + idx
        else:
            M = Mo if use_on[t] else Mf
            cS = dS[None, :] + l_sl[t] + M
            cZ = dZ[None, :] + l_za[t] + M
            cand = np.stack([cS, cZ], axis=2).reshape(P, 2 * P)
            j = np.argmax(cand, axis=1)
            best = cand[idx, j]
            stay = dA + l_aa
            use_stay = stay >= best
            nA = np.where(use_stay, stay, best) + obsA[t]
            back[t, :P] = np.where(use_stay, idx, (j % 2 + 1) * P + j // 2)
            fa, fs = dA + l_as, dS + l_ss[t]
            fromA = fa >= fs
            nS = np.where(fromA, fa, fs) + obsS[t]
            back[t, P:2 * P] = np.where(fromA, idx, P + idx)
            zz, zs, za = dZ + l_zz[t], dS + l_sz, dA + l_sz
            nZ = zz.copy()
            arg = 2 * P + idx
            m1 = zs > nZ
            nZ = np.where(m1, zs, nZ); arg = np.where(m1, P + idx, arg)
            m2 = za > nZ
            nZ = np.where(m2, za, nZ); arg = np.where(m2, idx, arg)
            nZ = nZ + obsZ[t]
            back[t, 2 * P:] = arg
        dA, dS, dZ = nA, nS, nZ
    allv = np.concatenate([dA, dS, dZ])
    order = np.concatenate([np.stack([idx, P + idx, 2 * P + idx], axis=1).ravel()])
    s = int(order[np.argmax(allv[order])])
    path = np.empty(T, dtype=np.int32)
    # loop: back-trace, one step per frame; SERIAL-REQUIRED
    for t in range(T - 1, -1, -1):
        path[t] = s
        s = back[t, s]
    return path


try:                                       # the research venv has numba; Sonata's helper doesn't
    from numba import njit as _njit
    _viterbi = _njit(cache=True)(_viterbi_loop)
    VITERBI = 'numba'
except ImportError:
    _viterbi = _viterbi_np
    VITERBI = 'numpy'


def snap_onsets(frames, conf, sm, voiced, w):
    """Forced-alignment syllable starts are good to ~30-50 ms. Move each one to the clearest
    acoustic boundary nearby: the deepest voicing-confidence dip (a consonant between two vowels),
    else the steepest pitch step, else leave it."""
    out = []
    T = len(conf)
    dm = np.zeros(T)
    dm[2:-2] = np.abs(np.nan_to_num(sm[4:] - sm[:-4], nan=0.0))
    for f in frames:
        a, b = max(1, f - w), min(T - 1, f + w + 1)
        if b <= a:
            out.append(f)
            continue
        c = conf[a:b]
        k = int(np.argmin(c))
        if c[k] < 0.7 * np.median(c) or not voiced[a + k]:
            out.append(a + k)
            continue
        k = int(np.argmax(dm[a:b]))
        out.append(a + k if dm[a + k] > 0.5 else f)
    return sorted(set(out))


def _interval_prior(P, scale, same):
    d = np.arange(-(P - 1), P)
    w = np.where(np.abs(d) <= 12, np.exp(-np.abs(d) / scale), 1e-4)
    w[P - 1] = same
    return np.log(w / w.sum())


def transcribe(f0, voiced, onsets=(), params=None, fps=100, conf=None):
    """f0 (Hz, 0 = none) and voiced (bool) on the 10 ms grid; onsets: forced note-onset times (s).
    Returns (notes, info). Each note: t, end, midi (tuned ET note), cents, pitch (float, tuned),
    conf, starts_syllable."""
    p = dict(PARAMS, **(params or {}))
    raw = hz_to_midi(f0)
    voiced = np.asarray(voiced, bool) & np.isfinite(raw)
    T = len(raw)
    info = {'frames': T}
    if voiced.sum() < 10:
        return [], dict(info, tuning_st=0.0, tuning_strength=0.0)
    off, strength = tuning_offset(raw, voiced)
    info.update(tuning_st=round(off, 3), tuning_strength=round(strength, 3))
    if p['tuning_win_s']:
        off_t = tuning_track(raw, voiced, off, p['tuning_win_s'], fps, p['tuning_min_s'], p['tuning_max_dev'],
                             unwrap=p['tuning_unwrap'], conc=p['tuning_conc'])
    else:
        off_t = np.full(T, off)
    info['tuning_track'] = off_t
    tuned = raw - off_t
    sm = lowpass(tuned, voiced, p['lowpass_hz'], fps)
    lo_p = int(np.floor(np.nanpercentile(sm[voiced], 0.5))) - 2
    hi_p = int(np.ceil(np.nanpercentile(sm[voiced], 99.5))) + 2
    lo_p, hi_p = max(24, lo_p), min(100, max(hi_p, lo_p + 4))
    pitches = np.arange(lo_p, hi_p + 1)
    P = len(pitches)
    v = np.where(voiced, p['v_hi'], 1 - p['v_hi'])
    if conf is not None:
        v = np.clip(v, 1e-3, 1 - 1e-3)
    m = np.where(voiced, sm, np.nan)

    def ln(sig):
        z = (m[:, None] - pitches[None, :]) / sig
        e = -0.5 * z * z - np.log(sig * np.sqrt(2 * np.pi))
        return np.where(np.isfinite(e), e, -np.log(P))
    obsS = np.log(v)[:, None] + ln(p['sigma_s'])
    obsA = np.log(v)[:, None] + ln(p['sigma_a'])
    obsZ = np.log(1 - v) - np.log(P)
    on_frames = sorted({int(round(t * fps)) for t in onsets if 0 < t * fps < T})
    hard = np.zeros(T, dtype=np.bool_)
    use_on = np.zeros(T, dtype=np.bool_)
    if p['onset_mode'] == 'snap' and conf is not None:
        on_frames = snap_onsets(on_frames, np.asarray(conf, dtype=np.float64), sm, voiced, int(round(p['snap_win_s'] * fps)))
    if p['onset_mode'] in ('hard', 'snap'):
        hard[on_frames] = True
    elif p['onset_mode'] == 'soft':
        w = int(round(p['onset_win_s'] * fps))
        for f in on_frames:
            use_on[max(0, f - w):f + w + 1] = True
    nwin = 2 * int(round(p['onset_win_s'] * fps)) + 1
    p_leg = np.where(use_on, p['p_on_leg'] / nwin, p['p_s_leg'])
    p_za = np.where(use_on, p['p_on_z'] / nwin, p['p_z_on'])
    lj_free = _interval_prior(P, p['interval_scale'], p['reattack_free'] * np.exp(-1 / p['interval_scale']))
    lj_on = _interval_prior(P, p['interval_scale'], 1.0)
    L = np.log
    path = _viterbi(obsA.astype(np.float64), obsS.astype(np.float64), obsZ.astype(np.float64), hard, use_on,
                    lj_free, lj_on, L(p['p_aa']), L(1 - p['p_aa']), L(1 - p['p_s_end'] - p_leg),
                    L(p['p_s_end']), L(p_leg), L(1 - p_za), L(p_za))
    forced = hard | use_on

    # path -> notes: a note starts at every entry into an attack state
    kind = path // P            # 0 attack, 1 stable, 2 silence
    pidx = path % P
    notes = []
    cur = None
    # loop: one pass over the frames
    for t in range(T):
        if kind[t] == 0 and (t == 0 or kind[t - 1] != 0 or pidx[t - 1] != pidx[t] or hard[t]):
            if cur:
                notes.append(cur)
            cur = [t, t + 1, pidx[t]]
        elif kind[t] in (0, 1) and cur is not None and pidx[t] == cur[2]:
            cur[1] = t + 1
        else:
            if cur:
                notes.append(cur)
            cur = None
    if cur:
        notes.append(cur)

    on_arr = np.array(on_frames, dtype=np.int64)
    snap = int(round(p['onset_snap_s'] * fps))

    def starts_syl(a):
        if not len(on_arr):
            return False
        k = np.searchsorted(on_arr, a)
        return any(0 <= j < len(on_arr) and abs(on_arr[j] - a) <= snap for j in (k - 1, k))

    def syl_between(a, b):
        if not len(on_arr):
            return False
        k = np.searchsorted(on_arr, a + 1)
        return k < len(on_arr) and on_arr[k] <= b

    skip = int(round(p['attack_skip_s'] * fps))

    def pitch_of(a, b):
        aa = a + skip if b - a > 3 * skip else a
        seg = tuned[aa:b][voiced[aa:b]]
        if len(seg) == 0:
            seg = tuned[a:b][voiced[a:b]]
        return float(np.median(seg)) if len(seg) else None

    # a segment: [start, end, pitch, cut at a syllable (b), stable part start, stable part end]
    segs = []
    for a, b, q in notes:
        med = pitch_of(a, b)
        if med is not None:
            segs.append([a, b, int(round(med)), False, a, b])

    # fix b: split a held note where a syllable starts well inside it
    if p['split_repeats'] and len(on_arr):
        mg = int(round(p['split_margin_s'] * fps))
        sw = int(round(p['split_win_s'] * fps))
        cv = np.asarray(conf, dtype=np.float64) if conf is not None else None
        out_s = []
        # loop: one pass over the notes, a few syllable starts each (CPU, offline)
        for sg in segs:
            a, b = sg[0], sg[1]
            cuts = []
            if b - a >= p['split_min_s'] * fps:
                for f in on_arr[(on_arr >= a + mg) & (on_arr <= b - mg)]:
                    c = int(f)
                    dip = False
                    if cv is not None and sw:
                        lo_, hi_ = max(a + mg, c - sw), min(b - mg, c + sw) + 1
                        if hi_ > lo_:
                            k = int(np.argmin(cv[lo_:hi_]))
                            if cv[lo_ + k] < p['split_dip'] * np.median(cv[a:b]):
                                c, dip = lo_ + k, True
                    if dip or not p['split_need_dip']:
                        cuts.append(c)
            prev = a
            first = sg[3]
            for c in sorted(set(cuts)):
                if c - prev >= mg and b - c >= mg:
                    out_s.append([prev, c, sg[2], first, prev, c])
                    prev, first = c, True
            out_s.append([prev, b, sg[2], first, prev, b])
        segs = out_s

    def gap_syl(e, a):
        """A syllable starts within split_win_s of the gap [e, a] (the alignment is only good to
        ~50 ms, so the consonant's gap need not contain the start itself)."""
        if not len(on_arr):
            return False
        w = int(round(p['split_win_s'] * fps))
        k = np.searchsorted(on_arr, e - w)
        return k < len(on_arr) and on_arr[k] <= a + w

    # merge same-pitch neighbours across short gaps (no syllable start between)
    merged = []
    for sg in segs:
        a, b, q = sg[0], sg[1], sg[2]
        if merged and merged[-1][2] == q and not sg[3] and a - merged[-1][1] <= p['merge_gap_s'] * fps \
                and not syl_between(merged[-1][1] - 1, a) and not (p['split_repeats'] and gap_syl(merged[-1][1], a)):
            merged[-1][1] = b
            merged[-1][5] = b
        else:
            merged.append(list(sg))

    def starts(sg):
        return sg[3] or starts_syl(sg[0])

    # fix c: scoops into and falls out of a stable note become part of it
    if p['glide_max_s']:
        gmax = p['glide_max_s'] * fps
        changed = True
        # loop: repeated passes until nothing merges; each pass removes one piece (offline, n notes)
        while changed:
            changed = False
            i = 0
            while i < len(merged):
                sg = merged[i]
                L = sg[1] - sg[0]
                if L < gmax:
                    nx = merged[i + 1] if i + 1 < len(merged) else None
                    pv = merged[i - 1] if i > 0 else None
                    if nx is not None and nx[0] - sg[1] <= 2 and abs(nx[2] - sg[2]) <= p['glide_st'] \
                            and nx[1] - nx[0] >= p['glide_ratio'] * L and not starts(nx):
                        nx[3] = starts(sg)
                        nx[0] = sg[0]
                        del merged[i]
                        changed = True
                        continue
                    if pv is not None and sg[0] - pv[1] <= 2 and abs(pv[2] - sg[2]) <= p['glide_st'] \
                            and pv[1] - pv[0] >= p['glide_ratio'] * L and not starts(sg):
                        pv[1] = sg[1]
                        del merged[i]
                        changed = True
                        continue
                i += 1

    # short pieces that don't start a syllable are glides or scoops: they extend the note before
    # them when they touch it, otherwise they are dropped
    keep = int(round(p['keep_syl_s'] * fps))

    def near_syl(a):
        if not len(on_arr) or not keep:
            return False
        k = np.searchsorted(on_arr, a)
        return any(0 <= j < len(on_arr) and abs(on_arr[j] - a) <= keep for j in (k - 1, k))

    kept = []
    for sg in merged:
        a, b = sg[0], sg[1]
        if (b - a) < p['min_note_s'] * fps and not starts(sg) and not near_syl(a):
            if kept and a - kept[-1][1] <= 2:
                kept[-1][1] = b
            continue
        kept.append(sg)
    out = []
    cv = np.asarray(conf, dtype=np.float64) if conf is not None else None
    for sg in kept:
        a, b = sg[0], sg[1]
        ca, cb = sg[4], sg[5]
        med = pitch_of(ca, cb) if (ca, cb) != (a, b) else pitch_of(a, b)
        if med is None:
            med = pitch_of(a, b)
        if med is None:
            continue
        mi = int(round(med))
        stable = float(np.mean(np.abs(sm[a:b][voiced[a:b]] - med) < 0.5)) if voiced[a:b].any() else 0.0
        n = {'t': round(a / fps, 3), 'end': round(b / fps, 3), 'midi': mi, 'cents': int(round((med - mi) * 100)),
             'pitch': round(med, 3), 'conf': round(float(np.mean(voiced[a:b])) * stable, 3),
             'starts_syllable': bool(starts(sg))}
        if p['tuning_win_s']:
            n['tune_st'] = round(float(np.median(off_t[a:b])), 3)
        if cv is not None:
            vv = voiced[a:b]
            n['vconf'] = round(float(np.mean(cv[a:b][vv])) if vv.any() else 0.0, 3)
        out.append(n)

    # fix d: octave check against the neighbouring melody
    if p['octave_check'] and len(out) > 2:
        mids = np.array([n['midi'] for n in out], dtype=np.float64)
        ts = np.array([n['t'] for n in out])
        durs = np.array([n['end'] - n['t'] for n in out])
        act = []
        # loop: one window per note (offline)
        for i, n in enumerate(out):
            sel = np.flatnonzero(np.abs(ts - n['t']) <= p['octave_ctx_s'])
            sel = sel[sel != i]
            if len(sel) < 2:
                act.append(None)
                continue
            o = np.argsort(mids[sel])
            cw = np.cumsum(durs[sel][o])
            ref = mids[sel][o][int(np.searchsorted(cw, cw[-1] / 2))]
            d = n['midi'] - ref
            if abs(d) < 9:
                act.append(None)
                continue
            # an isolated excursion only: the notes right before and after (within 1.5 s) are
            # both far away on the same side, so a real leap into a new phrase is left alone
            side = []
            for j in (i - 1, i + 1):
                if 0 <= j < len(out) and (out[j]['t'] - n['end'] if j > i else n['t'] - out[j]['end']) <= 1.5:
                    side.append(np.sign(d) * (n['midi'] - out[j]['midi']) >= 7)
            if not side or not all(side):
                act.append(None)
                continue
            k = int(np.round(d / 12.0)) or (1 if d > 0 else -1)
            if abs(n['midi'] - 12 * k - ref) > 5:
                act.append(None)
                continue
            act.append('drop' if n.get('vconf', 1.0) < p['octave_conf'] else 12 * k)
        kept_n = []
        for n, ac in zip(out, act):
            if ac == 'drop':
                info['octave_dropped'] = info.get('octave_dropped', 0) + 1
                continue
            if ac is not None:
                n['midi'] -= ac
                n['pitch'] = round(n['pitch'] - ac, 3)
                n['octave_fixed'] = True
                info['octave_folded'] = info.get('octave_folded', 0) + 1
            kept_n.append(n)
        out = kept_n
    info.update(range=[lo_p, hi_p], notes=len(out))
    return out, info


def attach_syllables(notes, syl_rows, tol=0.04, after=0.15):
    """Give each note the syllable it starts in; mark melisma (several notes on one syllable)."""
    starts = np.array([s['t'] for s in syl_rows]) if syl_rows else np.zeros(0)
    count = {}
    for n in notes:
        k = int(np.searchsorted(starts, n['t'] + tol, side='right')) - 1
        if k >= 0 and n['t'] < syl_rows[k]['end'] + after:
            n['syl_index'] = k
            count[k] = count.get(k, 0) + 1
        else:
            n['syl_index'] = None
    seen = {}
    for n in notes:
        k = n['syl_index']
        if k is None:
            n['melisma'] = False
            continue
        s = syl_rows[k]
        n.update(line=s['line'], word=s['word'], syl=s['syl'], text=s['text'], word_text=s['word_text'])
        n['melisma'] = count[k] > 1
        n['melisma_pos'] = seen.get(k, 0)
        seen[k] = n['melisma_pos'] + 1
    return notes


# ---- key, key signature, spelling (pure parts of keys.py) ----

KK_MAJ = np.array([6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88])
KK_MIN = np.array([6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17])
LETTERS = 'FCGDAEB'           # line of fifths, F = -1
SHARP, FLAT = '♯', '♭'
PC_OF_LETTER = {'C': 0, 'D': 2, 'E': 4, 'F': 5, 'G': 7, 'A': 9, 'B': 11}


def lof_name(q):
    """Line-of-fifths position -> name (C = 0, G = 1, F = -1, F# = 6, Bb = -2)."""
    letter = LETTERS[(q + 1) % 7]
    acc = (q + 1) // 7          # 0 natural, 1 sharp, -1 flat, 2 double sharp
    return letter + (SHARP * acc if acc > 0 else FLAT * (-acc))


def lof_pc(q):
    return (7 * q) % 12


def lof_candidates(pc):
    q0 = (7 * pc) % 12                      # 7 is its own inverse mod 12
    return [q for q in (q0 - 24, q0 - 12, q0, q0 + 12) if -15 <= q <= 19]


def parse_key(name):
    """'D# Major' / 'Bb minor' / 'F# minor' -> (tonic pc, 'major'|'minor')."""
    t, mode = name.split()
    pc = PC_OF_LETTER[t[0]] + t[1:].count('#') - t[1:].count('b')
    return pc % 12, mode.lower()


def key_signature(pc, mode):
    """-> (fifths -6..6, tonic name, mode). Minor keys use their relative major's signature."""
    best = None
    for q in lof_candidates(pc):
        fifths = q if mode == 'major' else q - 3
        cand = (abs(fifths) > 6, abs(fifths), -fifths, fifths, q)     # fewest accidentals; F# over Gb
        if best is None or cand < best:
            best = cand
    fifths, q = best[3], best[4]
    return fifths, lof_name(q), mode


def key_name(pc, mode):
    fifths, tonic, mode = key_signature(pc, mode)
    return '%s %s' % (tonic, mode)


def ks_key(hist):
    """Krumhansl-Schmuckler. hist: 12 pitch-class weights (C = 0). -> (pc, mode, r, margin)."""
    h = np.asarray(hist, dtype=np.float64)
    if h.sum() <= 0:
        return 0, 'major', 0.0, 0.0
    scores = []
    for mode, prof in (('major', KK_MAJ), ('minor', KK_MIN)):
        for k in range(12):
            scores.append((float(np.corrcoef(np.roll(prof, k), h)[0, 1]), k, mode))
    scores.sort(reverse=True)
    r, k, mode = scores[0]
    return k, mode, r, r - scores[1][0]


def note_histogram(notes):
    h = np.zeros(12)
    for n in notes:
        h[n['midi'] % 12] += n['end'] - n['t']
    return h


class Speller:
    """Running line-of-fifths speller."""

    def __init__(self, pc, mode, memory=8):
        fifths, _t, _m = key_signature(pc, mode)
        self.centre = fifths + 2.0            # the middle of the key's 7 diatonic positions
        self.key_centre = self.centre
        self.recent = []
        self.memory = memory
        self.prev = None

    def name(self, midi):
        pc = midi % 12
        c = 0.5 * self.key_centre + 0.5 * (np.mean(self.recent) if self.recent else self.key_centre)
        cands = sorted(lof_candidates(pc), key=lambda q: abs(q - c))
        q = cands[0]
        if len(cands) > 1 and abs(abs(cands[1] - c) - abs(q - c)) < 0.5:
            rising = self.prev is None or midi >= self.prev
            q = max(cands[:2]) if rising else min(cands[:2])
        self.recent = (self.recent + [q])[-self.memory:]
        self.prev = midi
        octave = midi // 12 - 1
        # Cb / B# cross the octave boundary
        letter = lof_name(q)[0]
        if letter == 'B' and pc == 0:
            octave -= 1
        if letter == 'C' and pc == 11:
            octave += 1
        return lof_name(q) + str(octave), q


def _name_at(q, midi):
    pc = midi % 12
    octave = midi // 12 - 1
    letter = lof_name(q)[0]
    if letter == 'B' and pc == 0:
        octave -= 1
    if letter == 'C' and pc == 11:
        octave += 1
    return lof_name(q) + str(octave)


def spell_notes(notes, pc, mode, consistent=False, regions=None):
    """Running line-of-fifths spelling. consistent: inside each key region (default: the whole
    song in this key) a pitch class keeps one name: the key's own letter for its seven scale
    tones, else the name the running speller gave it for most of the time (a tie goes to the
    key signature's side: sharps for sharp keys, flats for flat keys).
    regions: [(t0, t1, pc, mode)] key regions; a note belongs to the one its start falls in."""
    if not consistent:
        sp = Speller(pc, mode)
        for n in notes:
            n['name'], n['lof'] = sp.name(n['midi'])
        return notes
    regions = regions or [(-1e9, 1e9, pc, mode)]
    # loop: one pass per key region (a handful), notes once each
    for t0, t1, rpc, rmode in regions:
        sel = [n for n in notes if t0 <= n['t'] < t1]
        sp = Speller(rpc, rmode)
        fifths, _t, _m = key_signature(rpc, rmode)
        diatonic = {lof_pc(q): q for q in range(fifths - 1, fifths + 6)}
        votes = {}
        for n in sel:
            _nm, q = sp.name(n['midi'])
            n['lof'] = q
            w = votes.setdefault(n['midi'] % 12, {})
            w[q] = w.get(q, 0.0) + (n['end'] - n['t'])
        choice = {}
        for p_, w in votes.items():
            if p_ in diatonic:
                choice[p_] = diatonic[p_]
            else:
                choice[p_] = max(w, key=lambda q: (round(w[q], 6), q if fifths >= 0 else -q))
        for n in sel:
            q = choice[n['midi'] % 12]
            n['lof'] = q
            n['name'] = _name_at(q, n['midi'])
    return notes


def parse_key_name(name):
    """'E♭ major' / 'F♯ minor' (key_name output) -> (tonic pc, mode)."""
    return parse_key(name.replace(SHARP, '#').replace(FLAT, 'b'))


# ---- the entry point ----

MODEL = 'sonata-notes 2026-10-17'
FPS = 100


def _to_grid(times, x, T, kind):
    """Resample a per-frame series onto the model's 10 ms grid (nearest frame for flags)."""
    g = np.arange(T) / FPS
    x = np.asarray(x, dtype=np.float64)
    if kind == 'nearest':
        k = np.clip(np.searchsorted(times, g), 0, len(times) - 1)
        k0 = np.clip(k - 1, 0, len(times) - 1)
        k = np.where(np.abs(times[k0] - g) <= np.abs(times[k] - g), k0, k)
        return x[k]
    return np.interp(g, times, x)


def notes_from(f0, times, conf, syllables, opts=None):
    """Sung notes for one song (see the module doc). Pure computation: no I/O, no globals changed."""
    o = dict(opts or {})
    profile = o.get('profile', 'stem')
    params = dict(FIRST_RUN, **PROFILES[profile], **(o.get('params') or {}))
    times = np.asarray(times, dtype=np.float64)
    f0 = np.nan_to_num(np.asarray(f0, dtype=np.float64), nan=0.0)
    conf = np.asarray(conf, dtype=np.float64)
    if len(times) < 2:
        raise ValueError('notes_from: need at least two frames')
    T = int(round(times[-1] * FPS)) + 1
    if abs((times[1] - times[0]) - 1.0 / FPS) > 1e-6 or abs(times[0]) > 1e-6:
        f0 = _to_grid(times, f0, T, 'nearest')
        conf = _to_grid(times, conf, T, 'linear')
        loud = _to_grid(times, o['loud'], T, 'nearest') > 0.5 if o.get('loud') is not None else None
    else:
        loud = np.asarray(o['loud'], bool) if o.get('loud') is not None else None
    voiced = (conf >= o.get('vthr', VTHR['rmvpe'])) & (f0 > 0)
    if loud is not None:
        voiced &= loud[:len(voiced)] if len(loud) >= len(voiced) else np.pad(loud, (0, len(voiced) - len(loud)))
    syl = sorted((dict(s_) for s_ in (syllables or []) if s_.get('t') is not None), key=lambda s_: s_['t'])
    # loop: syllables once (a few hundred)
    for i, s_ in enumerate(syl):
        s_.setdefault('end', syl[i + 1]['t'] if i + 1 < len(syl) else s_['t'] + 0.3)
        for k_ in ('line', 'word', 'syl', 'text', 'word_text'):
            s_.setdefault(k_, None)
    nts, info = transcribe(f0, voiced, onsets=[s_['t'] for s_ in syl], params=params, conf=conf)
    attach_syllables(nts, syl)
    if o.get('key'):
        pc, mode = o['key']
        key_source = o.get('key_source', 'given')
    else:
        pc, mode, _r, _m = ks_key(note_histogram(nts))
        key_source = 'ks-notes'
    fifths, tonic, mode = key_signature(pc, mode)
    spell_notes(nts, pc, mode, consistent=True)
    tune_c = info.get('tuning_st', 0.0) * 100
    tuning = {'cents': round(tune_c, 1), 'a4_hz': round(440 * 2 ** (tune_c / 1200), 2),
              'strength': info.get('tuning_strength')}
    tr = info.get('tuning_track')
    if tr is not None and params.get('tuning_win_s'):
        tuning['track_hop_s'] = 1.0
        tuning['track_cents'] = [round(float(x) * 100, 1) for x in tr[::FPS]]
    with_notes = len({n['syl_index'] for n in nts if n['syl_index'] is not None})
    dur = np.array([n['end'] - n['t'] for n in nts]) if nts else np.zeros(0)
    note_conf = float(np.sum(dur * np.array([n['conf'] for n in nts])) / max(dur.sum(), 1e-9)) if nts else 0.0
    coverage = with_notes / max(1, len(syl))
    attached = float(np.mean([n['syl_index'] is not None for n in nts])) if nts else 0.0
    out_notes = []
    # loop: notes once (a few hundred)
    for n in nts:
        d = {'t': n['t'], 'end': n['end'], 'midi': n['midi'], 'cents': n['cents'], 'name': n['name'],
             'conf': n['conf'], 'syl_index': n['syl_index'], 'line': n.get('line'), 'word': n.get('word'),
             'syl': n.get('syl'), 'melisma': n['melisma']}
        if 'tune_st' in n:
            d['cents_tuning'] = round(n['tune_st'] * 100, 1)
        if n.get('octave_fixed'):
            d['octave_fixed'] = True
        out_notes.append(d)
    return {
        'format': 1, 'model': MODEL, 'profile': profile, 'viterbi': VITERBI,
        'params': {k_: v for k_, v in params.items() if v != PARAMS.get(k_)},
        'duration_s': round(T / FPS, 2), 'tuning': tuning,
        'key': {'name': '%s %s' % (tonic, mode), 'tonic_pc': pc, 'mode': mode, 'fifths': fifths, 'source': key_source},
        'notes': out_notes,
        'confidence': {'overall': round(float(np.cbrt(note_conf * coverage * attached)), 3),
                       'note_stability': round(note_conf, 3), 'syllables_with_notes': round(coverage, 3),
                       'notes_on_syllables': round(attached, 3)},
        'counts': {'octave_folded': info.get('octave_folded', 0), 'octave_dropped': info.get('octave_dropped', 0)},
    }
