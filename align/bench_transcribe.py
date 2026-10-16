"""Benchmark the transcription fallback (Whisper on the vocal stem) on JamendoLyrics:
word error rate vs the known lyrics, word-start error on the correctly heard words, speed.

  python bench_transcribe.py [--size turbo|small] [--device cuda|cpu] [--no-sep] [--lang English]
                             [--limit N] [--out results.json]
"""

import argparse
import csv
import json
import os
import re
import sys
import time
import unicodedata

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import sonata_align as SA  # noqa: E402
import bench  # noqa: E402

LANG = {'English': 'en', 'French': 'fr', 'German': 'de', 'Spanish': 'es'}


def norm(w):
    w = unicodedata.normalize('NFKD', w.lower().replace('’', "'"))
    w = ''.join(c for c in w if not unicodedata.combining(c))
    return re.sub(r"[^\w']", '', w)


def edit_align(ref, hyp):
    """Word-level Levenshtein -> (errors, [(ref_i, hyp_j)] for exact matches)."""
    n, m = len(ref), len(hyp)
    d = [[0] * (m + 1) for _ in range(n + 1)]
    for i in range(n + 1):
        d[i][0] = i
    for j in range(m + 1):
        d[0][j] = j
    # loop: n × m cells (a few hundred words each way)
    for i in range(1, n + 1):
        for j in range(1, m + 1):
            d[i][j] = min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (ref[i - 1] != hyp[j - 1]))
    i, j = n, m
    pairs = []
    while i > 0 and j > 0:
        if ref[i - 1] == hyp[j - 1] and d[i][j] == d[i - 1][j - 1]:
            pairs.append((i - 1, j - 1)); i -= 1; j -= 1
        elif d[i][j] == d[i - 1][j - 1] + 1:
            i -= 1; j -= 1
        elif d[i][j] == d[i - 1][j] + 1:
            i -= 1
        else:
            j -= 1
    return d[n][m], pairs[::-1]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--size', default='turbo')
    ap.add_argument('--device', default='auto')
    ap.add_argument('--no-sep', action='store_true')
    ap.add_argument('--lang', default=None)
    ap.add_argument('--no-refine', action='store_true', help="keep Whisper's own word times")
    ap.add_argument('--hint', action='store_true', help='pass the known language to Whisper')
    ap.add_argument('--limit', type=int, default=0)
    ap.add_argument('--out', default=None)
    a = ap.parse_args()
    songs = []
    with open(os.path.join(bench.BENCH, 'JamendoLyrics.csv')) as f:
        for row in csv.DictReader(f):
            if not a.lang or row['Language'] == a.lang:
                songs.append(row)
    if a.limit:
        songs = songs[:a.limit]
    al = SA.Aligner('en', device=a.device, separate=not a.no_sep)
    tot_err = tot_ref = 0
    terr = []
    per = []
    lang_ok = 0
    for row in songs:
        loaded = bench.load_song(row['Filepath'])
        if not loaded:
            continue
        lines, gt = loaded
        ref = [norm(w) for l in lines for w in l['text'].split()]
        ref_t = [t for g in gt for t in g]
        wav, sr = SA.read_audio({'path': os.path.join(bench.BENCH, 'mp3', row['Filepath'])})
        t = time.time()
        out, st = al.transcribe(wav, sr, language=LANG[row['Language']] if a.hint else None, size=a.size, refine=not a.no_refine)
        wall = time.time() - t
        hw = [w for l in out for w in l['words']]
        hyp = [norm(w['text']) for w in hw]
        keep = [k for k, h in enumerate(hyp) if h]
        hyp = [hyp[k] for k in keep]
        hw = [hw[k] for k in keep]
        errs, pairs = edit_align(ref, hyp)
        te = [abs(hw[j]['t'] - ref_t[i]) for i, j in pairs]
        tot_err += errs
        tot_ref += len(ref)
        terr += te
        ok = st['language'] == LANG[row['Language']]
        lang_ok += ok
        s = {'song': row['Filepath'], 'lang': row['Language'], 'detected': st['language'], 'wer': round(errs / max(1, len(ref)), 3),
             'matched': len(pairs), 'ref_words': len(ref), 'timing': bench.summary(te), 'wall_s': round(wall, 2), **st}
        per.append(s)
        print('%-55s %5.1fs  %s->%s  WER %.2f  matched-word start med %.3f' % (
            row['Filepath'][:55], wall, row['Language'][:2], st['language'], s['wer'], s['timing'].get('median', -1)), flush=True)
    total = {'model': 'whisper-' + a.size, 'refine': not a.no_refine, 'device': al.device, 'separation': not a.no_sep, 'hint': a.hint,
             'songs': len(per), 'wer': round(tot_err / max(1, tot_ref), 3),
             'wer_by_lang': {L: round(sum(p['wer'] * p['ref_words'] for p in per if p['lang'] == L) /
                                      max(1, sum(p['ref_words'] for p in per if p['lang'] == L)), 3)
                             for L in sorted({p['lang'] for p in per})},
             'language_detected_ok': '%d/%d' % (lang_ok, len(per)),
             'timing_matched_words': bench.summary(terr),
             'mean_wall_per_song_s': round(sum(p['wall_s'] for p in per) / max(1, len(per)), 2),
             'mean_separate_s': round(sum(p['separate_s'] for p in per) / max(1, len(per)), 2),
             'mean_transcribe_s': round(sum(p['transcribe_s'] for p in per) / max(1, len(per)), 2),
             'mean_refine_s': round(sum(p.get('refine_s', 0) for p in per) / max(1, len(per)), 2)}
    print(json.dumps(total, indent=1))
    if a.out:
        with open(a.out, 'w') as f:
            json.dump({'total': total, 'songs': per}, f, indent=1)


if __name__ == '__main__':
    main()
