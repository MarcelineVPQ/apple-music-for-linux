"""Benchmark sonata-align on JamendoLyrics MultiLang (79 CC-licensed songs with hand-annotated
word timings: https://github.com/f90/jamendolyrics, songs CC BY/BY-SA/BY-NC/BY-ND...).

The songs stay in ~/.local/share/sonata-align/bench/ (never in the repo). The annotated line
starts become the LRC anchors (optionally jittered, like real LRCLIB lines), the annotated word
starts are the ground truth. Compared: Sonata's current estimate (lyrics-timing.js
estimateWords, run through node) vs the aligned words.

  python bench.py [--aligner auto|en|xlsr-de|mms|...] [--device cuda|cpu] [--no-sep] [--jitter 0.3]
                  [--lang English] [--limit N] [--out results.json]
"""

import argparse
import csv
import json
import os
import random
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import sonata_align as SA  # noqa: E402

BENCH = os.path.join(SA.DATA_DIR, 'bench', 'src', 'jamendolyrics')
REPO = os.path.dirname(HERE)


def load_song(name):
    base = os.path.splitext(name)[0]
    words = []
    with open(os.path.join(BENCH, 'annotations', 'words', base + '.csv')) as f:
        for row in csv.DictReader(f):
            words.append((float(row['word_start']), float(row['word_end']), row['line_end'] != 'nan'))
    lines = []
    with open(os.path.join(BENCH, 'annotations', 'lines', base + '.csv')) as f:
        for row in csv.DictReader(f):
            lines.append({'t': float(row['start_time']), 'end': float(row['end_time']), 'text': row['lyrics_line']})
    # ground-truth word starts per line (line text words == annotation words, in order)
    gt = []
    k = 0
    for line in lines:
        n = len(line['text'].split())
        gt.append([w[0] for w in words[k:k + n]])
        k += n
    if k != len(words):
        return None
    return lines, gt


def estimate(lines):
    """Sonata's Level-0 estimate, straight from lyrics-timing.js."""
    js = "const T=require(process.argv[1]);let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{process.stdout.write(JSON.stringify(T.estimateWords(JSON.parse(d))))})"
    out = subprocess.run(['node', '-e', js, os.path.join(REPO, 'lyrics-timing.js')],
                         input=json.dumps(lines), capture_output=True, text=True, check=True).stdout
    return json.loads(out)


def errors(pred_lines, gt):
    """abs word-start errors (s) for all words, per line pairs."""
    out = []
    for words, g in zip(pred_lines, gt):
        for w, t in zip(words, g):
            if w is not None:
                out.append(abs(w - t))
    return out


def summary(errs):
    if not errs:
        return {}
    s = sorted(errs)
    n = len(s)
    return {
        'n': n,
        'mean': round(sum(s) / n, 3),
        'median': round(s[n // 2], 3),
        'p90': round(s[int(n * 0.9)], 3),
        'within_0.1': round(sum(1 for e in s if e <= 0.1) / n, 3),
        'within_0.3': round(sum(1 for e in s if e <= 0.3) / n, 3),
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--aligner', default='auto', help='auto (per language, permissive models) or a model name')
    ap.add_argument('--device', default='auto')
    ap.add_argument('--no-sep', action='store_true')
    ap.add_argument('--jitter', type=float, default=0.0, help='uniform ± jitter (s) on the line anchors')
    ap.add_argument('--lang', default=None)
    ap.add_argument('--limit', type=int, default=0)
    ap.add_argument('--only', default=None, help='substring of the file name')
    ap.add_argument('--param', action='append', default=[], help='name=value alignment parameter')
    ap.add_argument('--out', default=None)
    ap.add_argument('--rate', type=int, default=0, help='resample the input to this rate first (22050 = Level 1 capture)')
    ap.add_argument('--plain', action='store_true', help='unsynced lyrics: no line anchors at all')
    ap.add_argument('--cache', action='store_true', help='cache emissions per song (parameter sweeps)')
    ap.add_argument('--bias', type=float, default=0.0, help='subtract from aligned word starts')
    a = ap.parse_args()
    params = {k: float(v) for k, v in (p.split('=') for p in a.param)}

    songs = []
    with open(os.path.join(BENCH, 'JamendoLyrics.csv')) as f:
        for row in csv.DictReader(f):
            if a.lang and row['Language'] != a.lang:
                continue
            if a.only and a.only not in row['Filepath']:
                continue
            songs.append(row)
    if a.limit:
        songs = songs[:a.limit]

    auto = a.aligner == 'auto'
    al = SA.Aligner('en' if auto else a.aligner, device=a.device, separate=not a.no_sep, params=params)
    rng = random.Random(42)
    per_song = []
    line_rows = []
    all_est, all_al, all_al_only = [], [], []
    all_est_on_aligned = []
    for row in songs:
        loaded = load_song(row['Filepath'])
        if not loaded:
            print('skip (annotation mismatch):', row['Filepath'], file=sys.stderr)
            continue
        lines, gt = loaded
        anchors = [dict(l, t=max(0.0, l['t'] + rng.uniform(-a.jitter, a.jitter))) for l in lines]
        # LRCLIB-style input: line starts only, no ends
        lrc = [{'t': None if a.plain else l['t'], 'text': l['text']} for l in anchors]
        est = estimate(lrc)
        name = SA.aligner_for(SA.detect_language([l['text'] for l in lines])) if auto else a.aligner
        al.use(name).load()
        est_words = [[w['t'] for w in l.get('words', [])] for l in est]
        cache = os.path.join(SA.DATA_DIR, 'bench', 'cache', '%s-%s%s-%s.npy' % (
            name, 'sep' if not a.no_sep else 'mix', '-%d' % a.rate if a.rate else '',
            os.path.splitext(row['Filepath'])[0]))
        if a.cache and os.path.exists(cache):
            import numpy as np
            em = np.load(cache)
            t = time.time()
            res = al.align_lines(em, lrc, em.shape[0] * SA.FRAME)
            wall = time.time() - t
            st = {'duration_s': em.shape[0] * SA.FRAME, 'separate_s': 0, 'emissions_s': 0, 'align_s': wall,
                  'aligned_lines': sum(1 for r in res if r['aligned']), 'lines': len(res)}
        else:
            wav, sr = SA.read_audio({'path': os.path.join(BENCH, 'mp3', row['Filepath'])})
            if a.rate:
                # what Sonata's listener delivers: s16 PCM at a.rate (default 22050)
                import torchaudio.functional as AF
                wav = (AF.resample(wav, sr, a.rate) * 32767).round().clamp(-32768, 32767) / 32768
                sr = a.rate
            t = time.time()
            res, st = al.run(wav, sr, lrc)
            wall = time.time() - t
            if a.cache:
                import numpy as np
                os.makedirs(os.path.dirname(cache), exist_ok=True)
                np.save(cache, al.last_emissions)
        for r, g in zip(res, gt):
            if r['words']:
                line_rows.append({'song': row['Filepath'], 'line': r['line'], 'conf': r['confidence'],
                                  'err': [round(w['t'] - x, 3) for w, x in zip(r['words'], g)],
                                  # the aligner's own word ends (absolute s) and holds, for the held-note check
                                  'ends': [w.get('end') for w in r['words']],
                                  'held': [bool(w.get('held')) for w in r['words']],
                                  'est_err': None})
        # aligned where accepted, else keep the estimate (what Sonata would show)
        merged = []
        aligned_only = []
        est_on_aligned = []
        for r, e, g in zip(res, est_words, gt):
            if r['aligned']:
                ws = [w['t'] - a.bias for w in r['words']]
                merged.append(ws)
                aligned_only.append((ws, g))
                est_on_aligned.append((e, g))
            else:
                merged.append(e)
        e_est = errors(est_words, gt)
        e_al = errors(merged, gt)
        e_only = errors([x for x, _ in aligned_only], [g for _, g in aligned_only])
        e_est_only = errors([x for x, _ in est_on_aligned], [g for _, g in est_on_aligned])
        all_est += e_est
        all_al += e_al
        all_al_only += e_only
        all_est_on_aligned += e_est_only
        s = {'song': row['Filepath'], 'lang': row['Language'], 'licence': row['LicenseType'],
             'wall_s': round(wall, 2), **st,
             'estimate': summary(e_est), 'aligned': summary(e_al)}
        per_song.append(s)
        print('%-60s %5.1fs  lines %3d/%3d  est med %.3f  aligned med %.3f' % (
            row['Filepath'][:60], wall, st['aligned_lines'], st['lines'],
            s['estimate'].get('median', -1), s['aligned'].get('median', -1)), flush=True)

    total = {
        'aligner': a.aligner, 'device': al.device, 'separation': not a.no_sep, 'jitter': a.jitter,
        'params': al.params, 'songs': len(per_song),
        'lines_aligned': sum(s['aligned_lines'] for s in per_song),
        'lines': sum(s['lines'] for s in per_song),
        'estimate': summary(all_est),
        'aligned_with_fallback': summary(all_al),
        'aligned_lines_only': summary(all_al_only),
        'estimate_on_same_lines': summary(all_est_on_aligned),
        'audio_s': round(sum(s['duration_s'] for s in per_song), 1),
        'wall_s': round(sum(s['wall_s'] for s in per_song), 1),
        'mean_wall_per_song_s': round(sum(s['wall_s'] for s in per_song) / max(1, len(per_song)), 2),
        'mean_separate_s': round(sum(s['separate_s'] for s in per_song) / max(1, len(per_song)), 2),
        'mean_emissions_s': round(sum(s['emissions_s'] for s in per_song) / max(1, len(per_song)), 2),
        'mean_align_s': round(sum(s['align_s'] for s in per_song) / max(1, len(per_song)), 2),
    }
    print(json.dumps(total, indent=1))
    if a.out:
        with open(a.out, 'w') as f:
            json.dump({'total': total, 'songs': per_song, 'lines': line_rows}, f, indent=1)


if __name__ == '__main__':
    main()
