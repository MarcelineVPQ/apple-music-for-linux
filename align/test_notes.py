"""Tests for the sung notes step (notes.py, sung_notes.py, server.py's notes protocol): synthetic f0,
no model downloads. Run with the venv python -m unittest test_notes (CPU torch is enough).
SONATA_TEST_RMVPE=/path/rmvpe.pt also runs RMVPE itself on a synthetic voice (CPU)."""
import hashlib
import json
import os
import subprocess
import sys
import tempfile
import unittest

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
TMP_HOME = tempfile.mkdtemp(prefix='sonata-align-test-')
os.environ['SONATA_ALIGN_HOME'] = TMP_HOME          # never the user's install
import sonata_align as SA  # noqa: E402
import notes as N  # noqa: E402
import notes_step as SN  # noqa: E402
SA.MODEL_DIR = os.path.join(TMP_HOME, 'models')       # also when test_align imported sonata_align first

# a melody: (start s, length s, midi); the 64 at 2.2 s repeats the pitch of the note before it
MELODY = [(0.5, 0.4, 60), (0.9, 0.4, 62), (1.3, 0.6, 64), (2.2, 0.3, 64), (2.5, 0.5, 67), (3.3, 0.8, 65),
          (4.3, 0.4, 64), (4.7, 0.4, 62), (5.1, 1.0, 60)]


def voice(melody=MELODY, cents=0.0, vibrato=0.3, seconds=7.0, seed=1):
    rng = np.random.default_rng(seed)
    T = int(seconds * 100)
    f0, conf = np.zeros(T), np.zeros(T)
    for s, d, m in melody:
        a, b = int(round(s * 100)), int(round((s + d) * 100))
        t = np.arange(b - a) / 100
        f0[a:b] = 440 * 2 ** ((m - 69 + cents / 100 + vibrato * np.sin(2 * np.pi * 5.5 * t) + rng.normal(0, 0.05, b - a)) / 12)
        conf[a:b] = 0.9
    return f0, np.arange(T) / 100.0, conf


def syllables(melody=MELODY):
    out = []
    for i, (s, d, _m) in enumerate(melody):
        out.append({'t': s, 'end': s + d, 'text': 'la', 'line': i // 3, 'word': i % 3, 'syl': 0, 'nsyl': 1, 'word_text': 'la'})
    return out


class NoteModel(unittest.TestCase):
    def test_melody_and_shape(self):
        f0, times, conf = voice()
        r = N.notes_from(f0, times, conf, syllables(), {})
        self.assertEqual([n['midi'] for n in r['notes']], [m for _s, _d, m in MELODY])
        for n, (s, d, _m) in zip(r['notes'], MELODY):
            self.assertAlmostEqual(n['t'], s, delta=0.05)
            self.assertAlmostEqual(n['end'], s + d, delta=0.1)
        keys = {'t', 'end', 'midi', 'cents', 'name', 'syl_index', 'line', 'word', 'syl', 'melisma', 'conf'}
        self.assertTrue(all(keys <= set(n) <= keys | {'cents_tuning', 'octave_fixed'} for n in r['notes']))
        self.assertEqual((r['format'], r['profile']), (1, 'stem'))
        self.assertEqual([n['syl_index'] for n in r['notes']], list(range(len(MELODY))))
        self.assertFalse(any(n['melisma'] for n in r['notes']))
        self.assertEqual(r['notes'][0]['name'], 'C4')
        self.assertEqual(r['key']['name'], 'C major')
        self.assertEqual(r['key']['source'], 'ks-notes')
        self.assertEqual(set(r['confidence']), {'overall', 'note_stability', 'syllables_with_notes', 'notes_on_syllables'})
        self.assertEqual(r['model'], N.MODEL)
        json.dumps(SN.plain(r))        # plain JSON types once notes_step has passed it through

    def test_tuning_follows_the_singer(self):
        f0, times, conf = voice(cents=30.0, vibrato=0.0)
        r = N.notes_from(f0, times, conf, syllables(), {})
        self.assertAlmostEqual(r['tuning']['cents'], 30.0, delta=4)
        self.assertGreater(r['tuning']['a4_hz'], 447)
        self.assertEqual([n['midi'] for n in r['notes']], [m for _s, _d, m in MELODY])
        self.assertTrue(all(abs(n['cents']) <= 10 for n in r['notes']))

    def test_melisma_two_notes_on_one_syllable(self):
        mel = [(0.5, 0.4, 60), (0.9, 0.4, 64), (1.6, 0.5, 62)]
        f0, times, conf = voice(mel, seconds=2.5)
        syl = [{'t': 0.5, 'end': 1.3, 'text': 'oh', 'line': 0, 'word': 0, 'syl': 0, 'nsyl': 1, 'word_text': 'oh'},
               {'t': 1.6, 'end': 2.1, 'text': 'yeah', 'line': 0, 'word': 1, 'syl': 0, 'nsyl': 1, 'word_text': 'yeah'}]
        r = N.notes_from(f0, times, conf, syl, {})
        self.assertEqual([(n['midi'], n['syl_index'], n['melisma']) for n in r['notes']], [(60, 0, True), (64, 0, True), (62, 1, False)])

    def test_quiet_frames_and_low_confidence_are_not_notes(self):
        f0, times, conf = voice()
        level = np.full(len(f0), -20.0)
        level[int(3.3 * 100):int(4.1 * 100)] = -80.0          # the 65 is bleed: 60 dB under the singing
        r = N.notes_from(f0, times, conf, syllables(), {'loud': SN.loud_mask(level)})
        self.assertNotIn(65, [n['midi'] for n in r['notes']])
        r = N.notes_from(f0, times, np.full(len(f0), 0.2), syllables(), {})
        self.assertEqual(r['notes'], [])

    def test_times_offset_and_frame_check(self):
        f0, times, conf = voice()
        r = N.notes_from(f0, times + 10.0, conf, [dict(s, t=s['t'] + 10, end=s['end'] + 10) for s in syllables()], {})
        self.assertAlmostEqual(r['notes'][0]['t'], 10.5, delta=0.05)
        with self.assertRaises(ValueError):
            N.notes_from(f0[:1], times[:1], conf[:1], [], {})

    def test_silence(self):
        r = N.notes_from(np.zeros(300), np.arange(300) / 100.0, np.zeros(300), [], {})
        self.assertEqual(r['notes'], [])
        self.assertEqual(r['confidence']['overall'], 0.0)


class Syllables(unittest.TestCase):
    def test_parts_start_at_their_first_character(self):
        results = [{'line': 0, 'aligned': True, 'words': [
            {'t': 1.01, 'end': 1.81, 'text': 'Tonight'}, {'t': 2.01, 'end': 2.41, 'text': 'we'}]},
            {'line': 1, 'aligned': False, 'words': [{'t': None, 'end': None, 'text': 'skip'}]}]
        # 'tonight': t o n i g h t at frames 50.. ; 'night' starts at char 2, frame 70
        cf = {(0, 0, c): f for c, f in enumerate([50, 52, 70, 72, 75, 78, 80])}
        cf.update({(0, 1, 0): 100, (0, 1, 1): 104})
        rows = SN.syllable_table(results, cf, [[['To', 'night'], None]])
        self.assertEqual([(r['text'], r['t'], r['syl'], r['nsyl']) for r in rows],
                         [('To', 1.01, 0, 2), ('night', 1.41, 1, 2), ('we', 2.01, 0, 1)])
        self.assertEqual(rows[1]['end'], 1.81)
        self.assertEqual(rows[0]['end'], 1.41)

    def test_lines(self):
        results = [{'line': 0, 'aligned': True, 'words': [{'t': 1.0, 'end': 1.5, 'text': 'a'}, {'t': 1.6, 'end': 2.0, 'text': 'b'}]}]
        self.assertEqual(SN.line_table(results, [{'t': 1, 'text': 'a b'}]), [{'index': 0, 'text': 'a b', 'aligned': True, 't': 1.0, 'end': 2.0}])

    def test_loud_gate(self):
        db = np.array([-20.0] * 50 + [-70.0] * 50 + [np.nan] * 10)
        m = SN.loud_mask(db)
        self.assertTrue(m[:50].all())
        self.assertFalse(m[50:].any())
        self.assertFalse(SN.loud_mask(np.full(5, np.nan)).any())

    def test_level_marks_unheard_frames(self):
        stem = np.zeros(16000, dtype=np.float32)
        stem[:8000] = 0.1
        covered = np.zeros(50, dtype=bool)
        covered[:25] = True
        db = SN.level_db(stem, covered, 100)
        self.assertEqual(len(db), 100)
        self.assertTrue(np.isfinite(db[:50]).all())
        self.assertTrue(np.isnan(db[50:]).all())


class PitchLine(unittest.TestCase):
    """The Studio's pitch line (notes_step.contour): 50 ms values, MIDI x 10, 0 = no voice."""
    def test_values_on_the_hop(self):
        f0, times, conf = voice(vibrato=0.0)
        line = SN.contour(f0, conf)
        self.assertEqual((line['t0'], line['hop']), (0.0, 0.05))
        self.assertEqual(len(line['v']), 140)                     # 7 s / 50 ms
        self.assertEqual(line['v'][0], 0)                         # silence before the first note
        self.assertAlmostEqual(line['v'][12] / 10, 60, delta=0.2)   # 0.6 s: the first note, C4
        self.assertAlmostEqual(line['v'][28] / 10, 64, delta=0.2)   # 1.4 s: E4
        self.assertTrue(all(isinstance(v, int) for v in line['v']))

    def test_tuning_and_gates(self):
        f0, times, conf = voice(cents=30, vibrato=0.0)
        tuned = SN.contour(f0, conf, tuning_cents=30)
        self.assertAlmostEqual(tuned['v'][12] / 10, 60, delta=0.2)  # the song's tuning taken off
        quiet = np.zeros(len(f0), bool)
        self.assertEqual(set(SN.contour(f0, conf, loud=quiet)['v']), {0})
        self.assertEqual(set(SN.contour(f0, conf * 0.5)['v']), {0})    # under the voicing threshold
        half = SN.contour(f0, conf, loud=quiet[:300], t0=12.34)          # a gate shorter than the song
        self.assertEqual(half['t0'], 12.34)
        self.assertEqual(set(half['v']), {0})

    def test_section_line_needs_the_model(self):
        with self.assertRaises(FileNotFoundError):
            SN.pitch_section(np.zeros(16000, np.float32), 10.0)


class Download(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp(prefix='rmvpe-src-')
        self.src = os.path.join(self.dir, 'rmvpe.pt')
        with open(self.src, 'wb') as f:
            f.write(b'x' * 4096)
        self.saved = dict(SN.RMVPE)
        SN.RMVPE.update(url='file://' + self.src, bytes=4096)

    def tearDown(self):
        SN.RMVPE.clear()
        SN.RMVPE.update(self.saved)
        for p in (SN.rmvpe_path(), SN.rmvpe_path() + '.part'):
            if os.path.exists(p):
                os.remove(p)

    def test_checksum_mismatch_keeps_nothing(self):
        SN.RMVPE['sha256'] = '0' * 64
        with self.assertRaises(SA.ChecksumError):
            SN.download_rmvpe()
        self.assertFalse(os.path.exists(SN.rmvpe_path()))
        self.assertFalse(os.path.exists(SN.rmvpe_path() + '.part'))
        self.assertFalse(SN.have_rmvpe())

    def test_good_download(self):
        SN.RMVPE['sha256'] = hashlib.sha256(b'x' * 4096).hexdigest()
        SN.download_rmvpe()
        self.assertTrue(SN.have_rmvpe())
        self.assertTrue(SN.rmvpe_path().startswith(TMP_HOME))

    def test_real_entry(self):
        self.assertEqual(self.saved['bytes'], 181184272)
        self.assertEqual(self.saved['sha256'], '6d62215f4306e3ca278246188607209f09af3dc77ed4232efdd069798c4ec193')
        self.assertEqual(self.saved['licence'], 'MIT')


def talk(lines, env_extra=None, replies=None):
    env = dict(os.environ, SONATA_ALIGN_DEVICE='cpu', SONATA_ALIGN_HOME=TMP_HOME, **(env_extra or {}))
    p = subprocess.Popen([sys.executable, os.path.join(HERE, 'server.py')], stdin=subprocess.PIPE,
                         stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True, env=env)
    out = []
    try:
        for ln in lines:
            p.stdin.write(json.dumps(ln) + '\n')
        p.stdin.flush()
        # loop: one reply per expected line
        for _ in range(replies if replies is not None else len(lines)):
            out.append(json.loads(p.stdout.readline()))
        p.stdin.write('{"cmd":"quit"}\n')
        p.stdin.flush()
        p.wait(timeout=60)
    finally:
        if p.poll() is None:
            p.kill()
        p.stdin.close()
        p.stdout.close()
    return out


class Protocol(unittest.TestCase):
    def test_notes_without_a_kept_stem(self):
        r = talk([{'cmd': 'notes', 'id': 'n1', 'song': 's1', 'syl': []}, {'cmd': 'ping'}])
        self.assertEqual((r[0]['id'], r[0]['type'], r[0]['code']), ('n1', 'error', 'no-stem'))
        self.assertIn('notes', r[1]['features'])
        self.assertEqual(r[1]['note_models'], {'rmvpe': False})

    def test_kept_job_then_no_model(self):
        srv = server()
        sends = capture(srv)
        srv.kept = SN.Kept('s1', np.zeros(16000, np.float32), None, [], {}, [], 'en')
        srv.notes_job({'cmd': 'notes', 'id': 'n2', 'song': 's2'})
        self.assertEqual(sends[-1]['code'], 'no-stem')
        self.assertIsNotNone(srv.kept)                # another song's request leaves it
        srv.notes_job({'cmd': 'notes', 'id': 'n3', 'song': 's1'})
        self.assertEqual(sends[-1]['code'], 'no-model')
        self.assertIsNone(srv.kept)                   # one try per kept job

    def test_result_and_rmvpe_freed(self):
        srv = server()
        sends = capture(srv)
        srv.kept = SN.Kept('s1', np.zeros(16000, np.float32), None, [], {}, [], 'en')
        calls = []
        saved = (SN.have_rmvpe, SN.run)
        SN.have_rmvpe = lambda: True
        SN.run = lambda kept, syl, **kw: (calls.append((kept.song, syl, kw['device'])) or ({'format': 1, 'notes': []}, {'f0_s': 0.1}))
        try:
            srv.notes_job({'cmd': 'notes', 'id': 'n4', 'song': 's1', 'syl': [[None]]})
        finally:
            SN.have_rmvpe, SN.run = saved
        self.assertEqual(calls, [('s1', [[None]], 'cpu')])
        self.assertEqual((sends[-1]['type'], sends[-1]['id'], sends[-1]['notes']['format']), ('result', 'n4', 1))
        self.assertIsNone(srv.kept)

    def test_prepare_notes_checksum_error(self):
        d = tempfile.mkdtemp(prefix='rmvpe-src-')
        src = os.path.join(d, 'bad.pt')
        with open(src, 'wb') as f:
            f.write(b'y' * 100)
        srv = server()
        sends = capture(srv)
        saved = dict(SN.RMVPE)
        SN.RMVPE.update(url='file://' + src, bytes=100, sha256='1' * 64)
        try:
            srv.prepare_notes({'cmd': 'prepare', 'id': 'p1', 'mode': 'notes'})
        finally:
            SN.RMVPE.clear()
            SN.RMVPE.update(saved)
        self.assertEqual((sends[-1]['type'], sends[-1]['code']), ('error', 'checksum'))
        self.assertFalse(SN.have_rmvpe())

    def test_pitch_of_a_kept_section(self):
        srv = server()
        sends = capture(srv)
        srv.pitch_job({'cmd': 'pitch', 'id': 'q1', 'song': 's1', 'offset': 20})
        self.assertEqual(sends[-1]['code'], 'no-stem')
        srv.songs.add('s1', ('en', True), 20.0, np.zeros(16000, np.float32))
        srv.pitch_job({'cmd': 'pitch', 'id': 'q2', 'song': 's1', 'offset': 21})
        self.assertEqual(sends[-1]['code'], 'no-stem')              # no section starts there
        srv.pitch_job({'cmd': 'pitch', 'id': 'q3', 'song': 's1', 'offset': 20})
        self.assertEqual(sends[-1]['code'], 'no-model')
        calls = []
        saved = (SN.have_rmvpe, SN.pitch_section)
        SN.have_rmvpe = lambda: True
        SN.pitch_section = lambda stem, off, **kw: (calls.append((len(stem), off, kw['device'])) or ({'t0': off, 'hop': 0.05, 'v': [0, 600]}, {'f0_s': 0.01}))
        try:
            srv.pitch_job({'cmd': 'pitch', 'id': 'q4', 'song': 's1', 'offset': 20})
        finally:
            SN.have_rmvpe, SN.pitch_section = saved
        self.assertEqual(calls, [(16000, 20.0, 'cpu')])
        self.assertEqual((sends[-1]['type'], sends[-1]['id'], sends[-1]['pitch']['v']), ('result', 'q4', [0, 600]))
        self.assertIsNotNone(srv.songs.piece('s1', 20))            # the section stays for the final pass

    def test_forget_drops_the_kept_stem(self):
        r = talk([{'cmd': 'forget', 'song': 's1'}, {'cmd': 'notes', 'id': 'n1', 'song': 's1'}], replies=1)
        self.assertEqual(r[0]['code'], 'no-stem')


def server():
    import server as S
    return S.Server()


def capture(srv):
    import server as S
    sends = []
    S.send = sends.append
    return sends


@unittest.skipUnless(os.environ.get('SONATA_TEST_RMVPE'), 'SONATA_TEST_RMVPE=/path/to/rmvpe.pt runs the real network')
class RealRmvpe(unittest.TestCase):
    def test_sung_vowel_pitch(self):
        import torch
        import rmvpe
        net = rmvpe.RMVPE(os.environ['SONATA_TEST_RMVPE'], 'cpu')
        sr = 16000
        t = np.arange(2 * sr) / sr
        hz = 220.0
        x = sum(np.sin(2 * np.pi * hz * k * t) / k for k in range(1, 12)).astype(np.float32) * 0.1
        f0, conf = net.decode(net.salience(torch.from_numpy(x)))
        mid = slice(20, 180)
        self.assertGreater(float(np.median(conf[mid])), 0.5)
        self.assertAlmostEqual(float(np.median(f0[mid])), hz, delta=5)


if __name__ == '__main__':
    unittest.main()
