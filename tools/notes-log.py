#!/usr/bin/env python3
"""Turns a Sung notes log file (Settings -> "Sung notes (developer log)", one JSON per song in
~/.local/share/apple-music-for-linux/notes-log/) into a note listing per lyric line and a staff PNG,
so a live track can be judged against the recording.

  python3 tools/notes-log.py LOG.json                     the listing (stdout)
  python3 tools/notes-log.py LOG.json --png out.png [--t0 34 --dur 25 --play 41.3]

Listing: per line "time  line text:  E4 F#4–G4 …" (– joins the notes of one syllable, a melisma),
then the same word by word (· = no note of its own). The PNG is the research prototype's view
(research/notes-proto/render.py on the research-gpu-pipeline branch, same drawing): two systems of
dur/2 s, clef by the median note, key signature, each note at its sung pitch with a bar as long as
it was held, accidentals, ledger lines, syllables under their notes, a playhead. The log has no
pitch frames, so there is no contour line. Needs numpy and matplotlib (the system Python has them;
the align helper's venv doesn't, and needn't). The schema check is notes-log.js validateDoc.
"""

import argparse
import json
import os
import sys

import numpy as np

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'align'))
import sung_notes as K  # noqa: E402  (key spelling: SHARP, FLAT, Speller)

INK, INK2, MUTED, GRID = '#0b0b0b', '#52514e', '#8a8984', '#c9c8c2'
SURFACE, NOTE, PLAY = '#fcfcfb', '#2a78d6', '#eb6834'
LETTER_IDX = {'C': 0, 'D': 1, 'E': 2, 'F': 3, 'G': 4, 'A': 5, 'B': 6}
SHARP_STEPS_T = [38, 35, 39, 36, 33, 37, 34]       # F5 C5 G5 D5 A4 E5 B4 (treble)
FLAT_STEPS_T = [34, 37, 33, 36, 32, 35, 31]        # B4 E5 A4 D5 G4 C5 F4



def step_of(name):
    """'F♯3' -> diatonic step (C0 = 0)."""
    letter = name[0]
    octave = int(''.join(c for c in name if c.isdigit() or c == '-'))
    return octave * 7 + LETTER_IDX[letter]


def accidental_of(name):
    return name.count(K.SHARP) - name.count(K.FLAT)


def key_accidentals(fifths):
    """letter -> +1/-1 for the key signature."""
    order = 'FCGDAEB' if fifths > 0 else 'BEADGCF'
    return {l: (1 if fifths > 0 else -1) for l in order[:abs(fifths)]}

def _plt():
    import matplotlib
    matplotlib.use('Agg')
    import matplotlib.pyplot as plt
    from matplotlib import font_manager
    from matplotlib.patches import FancyBboxPatch
    font = None
    # loop: the system's font files, once per run
    for f in font_manager.findSystemFonts():
        if 'NotoMusic' in os.path.basename(f):
            font = font_manager.FontProperties(fname=f)
            break
    return plt, FancyBboxPatch, font


MUSIC_FONT = None
FancyBboxPatch = None

class Clef:
    def __init__(self, median_midi):
        if median_midi < 55:
            self.kind, self.bottom, self.shift, self.glyph = 'bass', 18, 0, '\U0001D122'
        elif median_midi < 62:
            self.kind, self.bottom, self.shift, self.glyph = 'treble-8vb', 30, 7, '\U0001D120'
        else:
            self.kind, self.bottom, self.shift, self.glyph = 'treble', 30, 0, '\U0001D11E'

    def y(self, step):
        return step + self.shift - self.bottom          # staff lines at 0, 2, 4, 6, 8

    def keysig_steps(self, fifths):
        base = SHARP_STEPS_T if fifths > 0 else FLAT_STEPS_T
        off = -14 if self.kind == 'bass' else 0
        return [s + off for s in base[:abs(fifths)]]


def contour_y(midi_float, clef, pc, mode):
    """Continuous staff position for a fractional (tuned) MIDI value: interpolate between the
    positions of the two neighbouring semitones, each spelled in the key."""
    sp = K.Speller(pc, mode)
    cache = {}

    def y_int(m):
        if m not in cache:
            sp.recent, sp.prev = [], None
            name, _ = sp.name(int(m))
            cache[m] = clef.y(step_of(name))
        return cache[m]
    out = np.full(len(midi_float), np.nan)
    for i, m in enumerate(midi_float):
        if np.isfinite(m):
            lo = int(np.floor(m))
            fr = m - lo
            out[i] = y_int(lo) * (1 - fr) + y_int(lo + 1) * fr
    return out


def draw_system(ax, doc, t0, t1, clef, play, contour, first):
    fifths = doc['key']['fifths']
    u = (t1 - t0) / 12.5                                 # layout unit: glyph room scales with the system length
    pad = (1.9 + 0.22 * abs(fifths)) * u                 # seconds of room for clef + key signature
    ax.set_xlim(t0 - pad, t1 + 0.1)
    ax.set_ylim(-11.5, 14)
    ax.axis('off')
    for y in (0, 2, 4, 6, 8):
        ax.plot([t0 - pad + 0.05, t1 + 0.1], [y, y], color=INK2, lw=0.8, zorder=1)
    if MUSIC_FONT is not None:
        ax.text(t0 - pad + 0.25 * u, {'bass': 6, 'treble': 2, 'treble-8vb': 2}[clef.kind], clef.glyph, fontproperties=MUSIC_FONT,
                fontsize=34, va='center' if clef.kind == 'bass' else 'baseline', color=INK, zorder=3)
    else:
        ax.text(t0 - pad + 0.25, 4, 'F' if clef.kind == 'bass' else 'G', fontsize=20, va='center', color=INK)
    for i, s in enumerate(clef.keysig_steps(fifths)):
        # the flat's bowl, not its box, sits on the line or space
        ax.text(t0 - pad + (1.3 + 0.22 * i) * u, s - clef.bottom + (0.6 if fifths > 0 else 0.9), K.SHARP if fifths > 0 else K.FLAT,
                fontproperties=MUSIC_FONT, fontsize=21, va='center', ha='center', color=INK, zorder=3)
    # bar lines from the downbeats
    bars = doc.get('bars') or []
    for bi, b in enumerate(bars):
        if t0 <= b <= t1:
            ax.plot([b, b], [0, 8], color=INK2, lw=0.9, zorder=1)
            ax.text(b + 0.04, 9.0, str(bi + 1), fontsize=7, color=MUTED, va='bottom')
    if contour is not None:
        ct, cy = contour
        sel = (ct >= t0) & (ct <= t1)
        ax.plot(ct[sel], cy[sel], color=MUTED, lw=0.7, alpha=0.8, zorder=2)
    keyacc = key_accidentals(fifths)
    sylls = doc['syllables']
    shown_syl = set()
    # seconds per character of lyric text at 9.5 pt (for collision-free rows)
    bbox = ax.get_window_extent()
    sec_per_px = (ax.get_xlim()[1] - ax.get_xlim()[0]) / max(1.0, bbox.width)
    char_s = 9.5 * 0.55 * ax.figure.dpi / 72 * sec_per_px
    row_end = [-1e9, -1e9]
    for n in doc['notes']:
        if n['end'] < t0 or n['t'] > t1:
            continue
        st = step_of(n['name'])
        y = clef.y(st)
        current = n['t'] <= play < n['end']
        col = PLAY if current else NOTE
        alpha = 1.0 if n['t'] <= play else 0.55
        a, b = max(n['t'], t0), min(n['end'], t1)
        ax.add_patch(FancyBboxPatch((a, y - 0.32), max(0.02, b - a), 0.64, boxstyle='round,pad=0,rounding_size=0.12',
                                    lw=0, fc=col, alpha=0.35 * alpha + 0.1, zorder=3))
        if n['t'] >= t0:
            ax.scatter([n['t'] + 0.05], [y], s=58, marker='o', color=col, alpha=alpha, zorder=5, linewidths=0)
            acc = accidental_of(n['name'])
            if acc != keyacc.get(n['name'][0], 0):
                g = K.SHARP if acc > 0 else K.FLAT if acc < 0 else '♮'
                ax.text(n['t'] - 0.13, y, g, fontproperties=MUSIC_FONT, fontsize=13, ha='center', va='center',
                        color=INK, alpha=alpha, zorder=5)
            # ledger lines
            for ly in list(range(-2, int(np.floor(y)) - 1, -2)) + list(range(10, int(np.ceil(y)) + 1 + 1, 2)):
                if (ly < 0 and ly >= y - 0.01) or (ly > 8 and ly <= y + 0.01):
                    ax.plot([n['t'] - 0.08, n['t'] + 0.18], [ly, ly], color=INK2, lw=0.8, zorder=4)
        # syllable under its first note
        k = n.get('syl_index')
        if k is not None and k not in shown_syl and sylls[k]['t'] >= t0 - 0.05:
            shown_syl.add(k)
            s = sylls[k]
            txt = s['text'] + ('-' if s['syl'] < s['nsyl'] - 1 else '')
            now = s['t'] <= play < (sylls[k + 1]['t'] if k + 1 < len(sylls) else s['end'])
            x = n['t']
            r = 0 if x > row_end[0] else 1 if x > row_end[1] else 0
            if r == 0 and x <= row_end[0]:
                x = row_end[0] + 0.5 * char_s
            w = (len(txt) + 1) * char_s
            row_end[r] = x + w
            ly = -7.4 - 2.2 * r
            ax.text(x, ly, txt, fontsize=9.5, color=PLAY if now else INK, fontweight='bold' if now else 'normal',
                    ha='left', va='center', zorder=5)
            group = [m for m in doc['notes'] if m.get('syl_index') == k]
            if len(group) > 1 and min(group[-1]['end'], t1) > x + w:     # melisma: extender line
                ax.plot([x + w, min(group[-1]['end'], t1)], [ly - 0.7, ly - 0.7], color=MUTED, lw=0.8, zorder=4)
    if t0 <= play <= t1:
        ax.plot([play, play], [-10.2, 12.3], color=PLAY, lw=1.6, zorder=6)
        mm, ss = divmod(play, 60)
        ax.text(play, 12.6, '%d:%04.1f' % (mm, ss), fontsize=8, color=PLAY, ha='center', va='bottom')
    ax.text(t0 - pad + 0.05, -10.8, '%d:%02d' % divmod(int(t0), 60), fontsize=7, color=MUTED)



def title_of(doc):
    s = doc.get('song') or {}
    if isinstance(s, dict):
        return '%s – %s' % (s.get('artist') or '?', s.get('title') or '?') + (' (%s)' % s['album'] if s.get('album') else '')
    return str(s)


def listing(doc, held_s=1.0):
    """Readable note listing per lyric line (the research prototype's run_songs.listing)."""
    by_line = {}
    for n in doc['notes']:
        if n.get('line') is not None:
            by_line.setdefault(n['line'], []).append(n)
    k = doc['key']
    out = ['%s  (key %s, A4 = %.1f Hz, f0 %s, note model %s, confidence %.2f, Sonata %s)' % (
        title_of(doc), k['name'], doc['tuning']['a4_hz'], (doc.get('models') or {}).get('f0', '?'),
        (doc.get('models') or {}).get('notes', '?'), doc['confidence']['overall'], doc.get('sonata', '?')), '']
    # loop: the song's lines (tens), each with its notes
    for ln in doc['lines']:
        ns = by_line.get(ln['index'], [])
        if not ln['aligned']:
            out.append('%7s  %s:  (line not aligned)' % ('', ln['text']))
            continue
        groups = []
        for key in sorted({(n['word'], n['syl']) for n in ns}):
            g = [n for n in ns if (n['word'], n['syl']) == key]
            s = '–'.join(n['name'] for n in g)
            longest = max(n['end'] - n['t'] for n in g)
            if longest >= held_s:
                s += ' (held %.1f s)' % longest
            groups.append(s)
        words = []
        for wi, w in enumerate(ln['text'].split()):
            g = [n for n in ns if n['word'] == wi]
            words.append('%s %s' % (w, '–'.join(n['name'] for n in g) if g else '·'))
        t = '%6.2fs' % ln['t'] if ln.get('t') is not None else ''
        out.append('%7s  %s:  %s' % (t, ln['text'], ' '.join(groups) if groups else '(no notes)'))
        out.append('%7s    %s' % ('', ' | '.join(words)))
    loose = [n for n in doc['notes'] if n.get('line') is None]
    if loose:
        out.append('')
        out.append('%d notes on no aligned syllable (ad-libs, backing vocals, unaligned lines)' % len(loose))
    return '\n'.join(out) + '\n'


def render(doc, out, t0=None, dur=25.0, play=None):
    global MUSIC_FONT, FancyBboxPatch
    plt, FancyBboxPatch, MUSIC_FONT = _plt()
    if t0 is None:
        t0 = next((l['t'] for l in doc['lines'] if l.get('aligned') and l.get('t') is not None), 0.0)
    half = dur / 2
    play = play if play is not None else t0 + 0.35 * dur
    mids = [n['midi'] for n in doc['notes'] if t0 <= n['t'] <= t0 + dur]
    clef = Clef(float(np.median(mids)) if mids else 60)
    fig, axes = plt.subplots(2, 1, figsize=(16, 7.2), dpi=130)
    fig.patch.set_facecolor(SURFACE)
    for i, ax in enumerate(axes):
        ax.set_facecolor(SURFACE)
        draw_system(ax, doc, t0 + i * half, t0 + (i + 1) * half, clef, play, None, i == 0)
    k = doc['key']
    sig = '%d%s' % (abs(k['fifths']), K.SHARP if k['fifths'] > 0 else K.FLAT) if k['fifths'] else 'no accidentals'
    meta = ['%s (%s, from the notes)' % (k['name'], sig), 'A4 = %.1f Hz' % doc['tuning']['a4_hz'], 'no bar lines (no beat model)',
            'f0 %s' % (doc.get('models') or {}).get('f0', '?').upper(), 'note model %s' % (doc.get('models') or {}).get('notes', '?'),
            'confidence %.2f' % doc['confidence']['overall'], 'clef %s' % clef.kind, 'Sonata %s' % doc.get('sonata', '?')]
    fig.text(0.02, 0.965, title_of(doc), fontsize=13, color=INK, fontweight='bold', va='top')
    fig.text(0.02, 0.925, '   ·   '.join(meta), fontsize=9.5, color=INK2, va='top')
    fig.text(0.02, 0.018, 'Sung notes developer log. Each note sits at its sung pitch in the song’s tuning; the bar is as long '
             'as the note was held. Syllables from Sonata’s forced alignment. Not engraved notation: no rhythm quantising.',
             fontsize=8, color=MUTED)
    plt.subplots_adjust(left=0.01, right=0.99, top=0.88, bottom=0.06, hspace=0.05)
    fig.savefig(out, facecolor=SURFACE)
    plt.close(fig)


def main():
    ap = argparse.ArgumentParser(description='Sung notes log -> note listing and staff PNG')
    ap.add_argument('log')
    ap.add_argument('--png', default=None)
    ap.add_argument('--t0', type=float, default=None, help='start of the PNG (s); default: the first aligned line')
    ap.add_argument('--dur', type=float, default=25.0)
    ap.add_argument('--play', type=float, default=None)
    a = ap.parse_args()
    doc = json.load(open(a.log, encoding='utf-8'))
    if doc.get('format') != 1:
        raise SystemExit('not a Sung notes log (format %r)' % doc.get('format'))
    sys.stdout.write(listing(doc))
    if a.png:
        render(doc, a.png, a.t0, a.dur, a.play)
        print('wrote', a.png)


if __name__ == '__main__':
    main()
