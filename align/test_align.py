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


class Holds(unittest.TestCase):
    """Held notes (0.15.34): the word end follows the voice, never past the next word."""

    def db(self, spans, n=600, loud=-10.0, quiet=-70.0):
        import numpy as np
        d = np.full(n, quiet, dtype=np.float32)
        for a, b in spans:
            d[int(a / SA.FRAME):int(b / SA.FRAME)] = loud
        return d

    def test_held_vowel_extends_to_where_the_voice_stops(self):
        res = [{'words': [{'t': 1.0, 'end': 1.3, 'text': 'home'}, {'t': 6.0, 'end': 6.3, 'text': 'now'}]}]
        n = SA.extend_holds(None, res, SA.DEFAULTS, db=self.db([(1.0, 4.5), (6.0, 6.3)]))
        self.assertEqual(n, 1)
        self.assertAlmostEqual(res[0]['words'][0]['end'], 4.5, delta=0.03)
        self.assertTrue(res[0]['words'][0]['held'])
        self.assertNotIn('held', res[0]['words'][1])

    def test_never_past_the_next_word(self):
        res = [{'words': [{'t': 1.0, 'end': 1.3, 'text': 'come'}]}, {'words': [{'t': 2.0, 'end': 2.4, 'text': 'home'}]}]
        SA.extend_holds(None, res, SA.DEFAULTS, db=self.db([(1.0, 5.0)]))
        self.assertLessEqual(res[0]['words'][0]['end'], 2.0 - 0.04 + 1e-6)

    def test_short_dips_kept_long_silence_ends_it(self):
        res = [{'words': [{'t': 1.0, 'end': 1.2, 'text': 'oh'}]}]
        SA.extend_holds(None, res, SA.DEFAULTS, db=self.db([(1.0, 2.0), (2.06, 3.0), (3.5, 4.0)]))
        self.assertAlmostEqual(res[0]['words'][0]['end'], 3.0, delta=0.03)

    def test_off_and_quiet(self):
        res = [{'words': [{'t': 1.0, 'end': 1.3, 'text': 'x'}]}]
        self.assertEqual(SA.extend_holds(None, res, SA.DEFAULTS, db=self.db([(1.0, 1.3)])), 0)
        self.assertEqual(res[0]['words'][0]['end'], 1.3)



class Paths(unittest.TestCase):
    """Where sonata-align lives: never inside another app's sandbox (the Codium snap incident)."""

    def test_snap_and_flatpak_dirs(self):
        h = '/home/u'
        self.assertTrue(SA.in_app_sandbox('/home/u/snap/codium/495/.local/share', h))
        self.assertTrue(SA.in_app_sandbox('/snap/codium/495/usr/bin/python3', h))
        self.assertTrue(SA.in_app_sandbox('/home/u/.var/app/com.vscodium.codium/data', h))
        self.assertTrue(SA.in_app_sandbox('/tmp/.mount_SonataX/usr/bin', h))
        self.assertFalse(SA.in_app_sandbox('/home/u/.local/share', h))
        self.assertFalse(SA.in_app_sandbox('/home/u/snapshots', h))
        self.assertFalse(SA.in_app_sandbox('/usr/bin/python3.13', h))

    def test_data_dir(self):
        h = '/home/u'
        self.assertEqual(SA.data_dir({'SONATA_ALIGN_HOME': '/x/sa'}, h), '/x/sa')
        self.assertEqual(SA.data_dir({'XDG_DATA_HOME': '/data/me'}, h), '/data/me/sonata-align')
        self.assertEqual(SA.data_dir({'XDG_DATA_HOME': '/home/u/snap/codium/495/.local/share'}, h), '/home/u/.local/share/sonata-align')
        self.assertEqual(SA.data_dir({'XDG_DATA_HOME': 'relative'}, h), '/home/u/.local/share/sonata-align')
        self.assertEqual(SA.data_dir({}, h), '/home/u/.local/share/sonata-align')


class GpuBudget(unittest.TestCase):
    def test_threads(self):
        self.assertEqual(SA.gpu_threads({}, 32), 4)
        self.assertEqual(SA.gpu_threads({}, 8), 2)
        self.assertEqual(SA.gpu_threads({}, 2), 1)
        self.assertEqual(SA.gpu_threads({'SONATA_ALIGN_THREADS': '6'}, 32), 6)
        self.assertIsNone(SA.gpu_threads({'SONATA_ALIGN_THREADS': '0'}, 32))     # torch's default
        self.assertEqual(SA.gpu_threads({'SONATA_ALIGN_THREADS': 'x'}, 32), 4)

    def test_vram_need(self):
        self.assertEqual(SA.vram_need(True, 0), SA.WORK_BYTES + SA.VRAM_MARGIN_BYTES)
        self.assertEqual(SA.vram_need(False, 10), SA.WORK_BYTES + 10 + SA.VRAM_MARGIN_BYTES)
        self.assertGreaterEqual(SA.VRAM_MARGIN_BYTES, int(1e9))


def piece(offset_s, seconds, value):
    """A section piece as the helper keeps it: (offset in 20 ms frames, stem at 16 kHz)."""
    return (int(round(offset_s / SA.FRAME)), np.full(int(seconds * 16000), float(value), dtype=np.float32))


class Stitch(unittest.TestCase):
    """Separate once per song: the final pass is built from the sections' kept stems."""

    def test_one_piece_is_itself(self):
        p = piece(0, 10, 1)
        stem, cov = SA.stitch([p])
        self.assertTrue(np.array_equal(stem, p[1]))
        self.assertEqual(len(cov), 500)
        self.assertTrue(cov.all())

    def test_overlap_cut_in_the_middle_and_gap_is_silent(self):
        a = piece(0, 10, 1)            # frames 0..500
        b = piece(7, 10, 2)            # frames 350..850: overlap 350..500, cut at 425
        c = piece(30, 5, 3)            # frames 1500..1750, a gap before it
        stem, cov = SA.stitch([c, a, b])          # any order
        frame = stem.reshape(-1, 320)[:, 0]
        self.assertTrue((frame[:425] == 1).all())
        self.assertTrue((frame[425:850] == 2).all())
        self.assertTrue((frame[850:1500] == 0).all())         # silent where nothing was heard
        self.assertFalse(cov[850:1500].any())
        self.assertTrue(cov[:850].all() and cov[1500:].all())
        self.assertTrue((frame[1500:] == 3).all())
        self.assertEqual(len(stem), 1750 * 320)

    def test_song_cache(self):
        c = SA.SongCache()
        self.assertTrue(c.add('s1', ('en', True), 0.0, np.zeros(16000, np.float32)))
        self.assertTrue(c.add('s1', ('en', True), 0.98, np.zeros(16000, np.float32)))
        self.assertEqual([p[0] for p in c.take('s1', ('en', True))], [0, 49])
        self.assertIsNone(c.take('s1', ('xlsr-de', True)))      # other models: no reuse
        self.assertIsNone(c.take('s2', ('en', True)))
        c.add('s2', ('en', True), 0.0, np.zeros(160, np.float32))
        self.assertIsNone(c.take('s1', ('en', True)))            # one song at a time
        c.MAX_SECONDS = 1.5
        c.clear()
        self.assertTrue(c.add('s3', ('en', True), 0.0, np.zeros(16000, np.float32)))
        self.assertFalse(c.add('s3', ('en', True), 1.0, np.zeros(16000, np.float32)))   # bounded

    def test_holds_ignore_unheard_frames(self):
        d = np.full(600, -70.0, dtype=np.float32)
        d[50:225] = -10.0
        d[300:] = np.nan                        # not heard
        res = [{'words': [{'t': 1.0, 'end': 1.3, 'text': 'home'}]}]
        self.assertEqual(SA.extend_holds(None, res, SA.DEFAULTS, db=d), 1)
        self.assertAlmostEqual(res[0]['words'][0]['end'], 4.5, delta=0.03)


class ProtocolCache(unittest.TestCase):
    def test_final_without_pieces_asks_for_audio_and_forget_is_silent(self):
        here = os.path.dirname(os.path.abspath(__file__))
        env = dict(os.environ, SONATA_ALIGN_DEVICE='cpu')
        p = subprocess.Popen([sys.executable, os.path.join(here, 'server.py')], stdin=subprocess.PIPE,
                             stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True, env=env)
        try:
            p.stdin.write('{"cmd":"forget","song":"s1"}\n'
                          '{"cmd":"align","id":"f1","song":"s1","final":true,"lines":[{"t":1,"text":"hello there"}]}\n')
            p.stdin.flush()
            first = json.loads(p.stdout.readline())       # forget has no reply: the first line is f1's
            p.stdin.write('{"cmd":"ping"}\n')
            p.stdin.flush()
            pong = json.loads(p.stdout.readline())
            p.stdin.write('{"cmd":"quit"}\n')
            p.stdin.flush()
            p.wait(timeout=60)
        finally:
            if p.poll() is None:
                p.kill()
        self.assertEqual((first['id'], first['type'], first['code']), ('f1', 'error', 'no-cache'))
        self.assertIn('song-cache', pong['features'])
