"""Unit tests for the pure parts (no models): run with the venv python -m unittest test_align."""
import json
import os
import subprocess
import sys
import unittest

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import sonata_align as SA  # noqa: E402


def emissions(seq, C=5, frames_per=3, gap=2):
    """Synthetic log-probs: blank for `gap` frames, then each token for `frames_per` frames."""
    rows = []
    for tok in seq:
        rows += [0] * gap + [tok] * frames_per
    rows += [0] * gap
    em = np.full((len(rows), C), np.log(0.01), dtype=np.float32)
    for t, c in enumerate(rows):
        em[t, c] = np.log(0.96)
    return em


class CtcAlign(unittest.TestCase):
    def test_finds_tokens(self):
        em = emissions([1, 2, 3])
        path = SA.ctc_align(em, [1, 2, 3])
        firsts = {}
        for ti, fr in path:
            firsts.setdefault(ti, fr)
        self.assertEqual(firsts, {0: 2, 1: 7, 2: 12})

    def test_repeated_tokens_need_a_blank(self):
        em = emissions([1, 1])
        path = SA.ctc_align(em, [1, 1])
        self.assertEqual(sorted({ti for ti, _ in path}), [0, 1])

    def test_too_short(self):
        self.assertIsNone(SA.ctc_align(np.zeros((2, 4), dtype=np.float32), [1, 1, 1]))

    def test_window_bounds(self):
        em = emissions([1, 2, 1, 2])          # the pair occurs twice
        path = SA.ctc_align(em, [1, 2], lo=np.array([10, 10]), hi=np.array([20, 20]))
        self.assertTrue(all(10 <= fr < 20 for _, fr in path))


class Text(unittest.TestCase):
    def test_normalise(self):
        labels = set("abcdefghijklmnopqrstuvwxyz'")
        self.assertEqual(SA.normalise_word('Größe,', labels), 'grosse')
        self.assertEqual(SA.normalise_word('Don’t', labels), "don't")
        self.assertEqual(SA.normalise_word('¿Qué?', labels), 'que')
        self.assertEqual(SA.normalise_word('123', labels), '')

    def test_fill_gaps(self):
        w = [{'t': 1.0, 'end': 1.5}, {'t': None, 'end': None}, {'t': None, 'end': None}, {'t': 2.5, 'end': 3.0}]
        SA.fill_gaps(w)
        self.assertEqual([x['t'] for x in w], [1.0, 1.5, 2.0, 2.5])
        self.assertTrue(w[1]['interpolated'])


class Language(unittest.TestCase):
    def test_detect(self):
        self.assertEqual(SA.detect_language(["I don't know what you want from me", 'and all the night']), 'en')
        self.assertEqual(SA.detect_language(['Ich weiß nicht, was du willst', 'und die Nacht ist kalt']), 'de')
        self.assertEqual(SA.detect_language(["je ne sais pas ce que tu veux", "c'est la vie"]), 'fr')
        self.assertEqual(SA.detect_language(['no sé lo que quieres de mí', 'y la noche es fría']), 'es')
        self.assertEqual(SA.detect_language(['звезда по имени солнце']), 'ru')

    def test_permissive_choice(self):
        self.assertEqual(SA.aligner_for('en'), 'en')
        self.assertEqual(SA.aligner_for('de'), 'xlsr-de')
        self.assertIsNone(SA.aligner_for('ko'))
        for name in ('en', 'xlsr-de'):
            self.assertIn(SA.MODELS[name]['licence'], ('MIT', 'Apache-2.0'))


class Audio(unittest.TestCase):
    def test_s16le_bytes(self):
        pcm = np.array([[0, 16384], [-16384, 0]], dtype='<i2').tobytes()
        wav, sr = SA.read_audio({'bytes': pcm, 'rate': 22050, 'channels': 2})
        self.assertEqual(sr, 22050)
        self.assertEqual(tuple(wav.shape), (2, 2))
        self.assertAlmostEqual(float(wav[1, 0]), 0.5)


class Protocol(unittest.TestCase):
    def test_ping_and_unknown(self):
        here = os.path.dirname(os.path.abspath(__file__))
        p = subprocess.run([sys.executable, os.path.join(here, 'server.py')],
                           input='{"cmd":"ping"}\n{"cmd":"nope","id":"x"}\n{"cmd":"quit"}\n',
                           capture_output=True, text=True, timeout=120)
        out = [json.loads(l) for l in p.stdout.splitlines()]
        self.assertEqual(out[0]['type'], 'pong')
        self.assertIn('htdemucs', out[0]['models'])
        self.assertEqual(out[1], {'type': 'error', 'id': 'x', 'message': "unknown cmd 'nope'"})


if __name__ == '__main__':
    unittest.main()
