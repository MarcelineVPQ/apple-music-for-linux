"""sonata-align helper: JSON lines over stdio, one request per line, one reply per line.

stdout carries ONLY protocol messages; logs and library warnings go to stderr.

Requests (stdin):
  {"cmd":"ping"}
  {"cmd":"prepare", "id":"p1", "mode":"align"|"transcribe", "language":"de"?}   download + load models now
  Optional on align/prepare: "language":"de" (else guessed from the lyrics), "aligner":"en"|"xlsr-de"|
  "mms"|... (else picked by language), "allow_nc":true (allow the CC-BY-NC MMS model for languages
  without a permissive one), "separate":false (skip Demucs: 5x faster, a little less accurate).
  {"cmd":"align", "id":"a1", "lines":[{"t":12.3,"end":15.0?,"text":"..."}],
     "audio":{"path":"/tmp/x.pcm","format":"s16le","rate":22050,"channels":2}}
  {"cmd":"align", "id":"a2", "lines":[...], "audio":{"stream":true,"format":"s16le","rate":22050,"channels":2}}
     then {"cmd":"chunk","id":"a2","data":"<base64 PCM>"} ... {"cmd":"end","id":"a2"}
  {"cmd":"transcribe", "id":"t1", "language":"en"?, "audio":{...same as align...}}
  {"cmd":"cancel", "id":"a1"}
  {"cmd":"forget", "song":"s3"}       drop that song's kept sections (queued behind its jobs, no reply)
  {"cmd":"quit"}

Separate once per song (0.15.38): an align job with "song":"<id>" and "offset":<s> (where its audio
slice starts in the song, a multiple of 0.02 s) keeps its vocal stem and emissions on the CPU
(SongCache). {"cmd":"align","id":"f1","song":"<id>","final":true,"lines":[...song times...]} without
"audio" runs the whole-song pass from those pieces (Viterbi + held notes only); if they are gone
(another song, the helper restarted, other models) it answers code "no-cache" and the caller sends
the audio as before. One song is kept at a time; the final pass and "forget" free it.

Before each GPU job the free graphics memory is checked (sonata_align.vram_need: working set +
models still to load + 1 GB margin); too little -> code "low-vram", nothing runs. After each job
the allocator's cache is handed back (torch.cuda.empty_cache). Env: SONATA_ALIGN_THREADS (CPU
threads in GPU mode, default 4), SONATA_ALIGN_VRAM_MARGIN_GB (default 1), SONATA_ALIGN_VRAM_FRACTION
(a hard cap on this process's share of the GPU memory; tests and benches use it).

Replies (stdout):
  {"type":"pong","version":"0.1.0","device":"cuda","gpu":"NVIDIA ...","models":{"htdemucs":true,...}}
  {"type":"progress","id":"a1","stage":"download|separate|emissions|align|transcribe","p":0.42,"detail":"..."}
  {"type":"result","id":"a1","source":"aligned","lines":[{"line":0,"aligned":true,"confidence":0.31,
     "words":[{"t":12.41,"end":12.7,"text":"Hello","conf":0.52}]}],"stats":{...}}
  {"type":"error","id":"a1","message":"..."}

Sung notes (Settings -> "Sung notes (developer log)", Development channel, off by default; the
step is notes_step.py, the note model sung_notes.py through notes.py): an align request that is the
song's whole-song job may carry "notes":true. After its result has been sent, the job's vocal stem, aligned lines and character frames are kept (one
song at most, CPU). Then
  {"cmd":"notes","id":"n1","song":"<id>","syl":[per request line: per word the syllable texts or null]}
runs RMVPE on that stem and the note model (notes.notes_from), queued behind any jobs already
waiting, and answers {"type":"result","id":"n1","notes":{...},"stats":{...}}; codes: "no-stem"
(nothing kept for that song), "no-model" (RMVPE not downloaded), "low-vram". Nothing is kept when
"notes" is absent. {"cmd":"prepare","id":"p2","mode":"notes"} downloads RMVPE (181 MB, MIT; size and
SHA-256 checked, code "checksum" on a mismatch) and answers {"ready":true}. The pong lists
"note_models":{"rmvpe":bool}. The notes result also carries the whole song's pitch line
("pitch":{"t0","hop","v":[MIDI x 10, 0 = no voice]}) for the Studio's sheet notes.

Sheet notes, first play (Settings -> "Sheet notes in the Studio", off by default): after a section's
result, Sonata may ask for that section's pitch line from the stem the song cache kept for it:
  {"cmd":"pitch","id":"q1","song":"<id>","offset":<the section job's offset, s>}
-> {"type":"result","id":"q1","pitch":{"t0","hop","v"},"stats":{...}}; codes "no-stem" (that
section isn't kept: another song, the final pass already took them), "no-model", "low-vram".
RMVPE is loaded for the job and freed after it, as for the notes.

One job runs at a time (a worker thread); requests queue. Cancel takes effect between stages.
"""

import base64
import json
import os
import queue
import sys
import threading
import traceback
import warnings

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

# stdout is the protocol channel: keep a private handle and point sys.stdout at stderr so
# nothing else (library prints, tqdm) can corrupt it.
_proto = sys.stdout
sys.stdout = sys.stderr
warnings.filterwarnings('ignore')

import sonata_align as SA  # noqa: E402
import notes_step  # noqa: E402  (the sung notes step; the note model is sung_notes.py, through notes.py)

_lock = threading.Lock()


def send(msg):
    with _lock:
        _proto.write(json.dumps(msg, ensure_ascii=False) + '\n')
        _proto.flush()


class NoModel(Exception):
    pass


class Server:
    def __init__(self):
        self.jobs = queue.Queue()
        self.streams = {}          # id -> (request, [bytes])
        self.cancelled = set()
        self.al = None             # SA.Aligner (models stay loaded between songs)
        self.current = None
        self.songs = SA.SongCache()  # the current song's section stems + emissions (CPU)
        self.kept = None             # notes_step.Kept: the last whole-song job's stem for its notes step

    def pick(self, req):
        """Aligner for a request: explicit 'aligner', else by language (req 'language' or guessed
        from the lyrics): English -> 'en' (MIT), de/fr/es/... -> 'xlsr-<lang>' (Apache-2.0).
        Other languages need the multilingual MMS model (CC-BY-NC 4.0): only with allow_nc."""
        name = req.get('aligner') or os.environ.get('SONATA_ALIGN_MODEL') or 'auto'
        lang = req.get('language')
        if name == 'auto':
            lang = lang or SA.detect_language([l.get('text') or '' for l in req.get('lines') or []])
            name = SA.aligner_for(lang)
            if name is None:
                if not req.get('allow_nc'):
                    raise NoModel('no permissively licensed aligner for language %r (allow_nc enables MMS, CC-BY-NC 4.0)' % lang)
                name = 'mms'
        if name not in SA.MODELS or name == 'htdemucs':
            raise NoModel('unknown aligner %r' % name)
        return name, lang

    def aligner(self, req, job_id, name='en'):
        # one Aligner: the separator stays loaded, the alignment model is swapped per language
        if self.al is None or self.al.use_separation != req.get('separate', True):
            self.al = SA.Aligner(name, separate=req.get('separate', True))
            frac = os.environ.get('SONATA_ALIGN_VRAM_FRACTION')
            if frac and self.al.device.startswith('cuda'):
                self.al.torch.cuda.set_per_process_memory_fraction(float(frac))
        al = self.al.use(name)
        al.progress = lambda stage, p, detail=None: send(
            {'type': 'progress', 'id': job_id, 'stage': stage, 'p': round(p, 3), **({'detail': detail} if detail else {})})
        return al

    # lifetime: one daemon worker thread for the process; it exits with the process
    # loop: blocks on the job queue, one job at a time
    def worker(self):
        while True:
            req, audio = self.jobs.get()
            jid = req.get('id')
            if jid in self.cancelled:
                self.cancelled.discard(jid)
                send({'type': 'error', 'id': jid, 'message': 'cancelled'})
                continue
            if req.get('cmd') == 'forget':
                if self.songs.song == req.get('song'):
                    self.songs.clear()
                if self.kept is not None and self.kept.song == req.get('song'):
                    self.kept = None
                continue
            if req.get('cmd') == 'notes':
                self.notes_job(req)
                continue
            if req.get('cmd') == 'pitch':
                self.pitch_job(req)
                continue
            if req.get('cmd') == 'prepare' and req.get('mode') == 'notes':
                self.prepare_notes(req)
                continue
            self.current = jid
            try:
                name, lang = (self.pick(req) if req['cmd'] == 'align' or (req['cmd'] == 'prepare' and req.get('mode', 'align') == 'align')
                              else ('en', None))
                al = self.aligner(req, jid, name)
                if req['cmd'] == 'prepare':
                    if req.get('mode') == 'transcribe':
                        al.ensure_models_sep()
                        al.load_whisper(req.get('size', 'turbo'))
                    else:
                        al.load()
                    send({'type': 'result', 'id': jid, 'ready': True, 'device': al.device})
                    continue
                key = (al.aligner_name, al.use_separation)
                ok, free, need = al.vram_ok()
                if not ok:
                    send({'type': 'error', 'id': jid, 'code': 'low-vram',
                          'message': 'not enough free graphics memory (%.1f GB free, %.1f GB needed)' % (free / 1e9, need / 1e9)})
                    continue
                cancelled = (lambda j=jid: j in self.cancelled)
                if req['cmd'] == 'align' and req.get('final') and audio is None and not req.get('audio'):
                    pieces = self.songs.take(req.get('song'), key)
                    self.songs.clear()
                    if pieces is None:
                        send({'type': 'error', 'id': jid, 'code': 'no-cache', 'message': 'the song\'s sections are not kept here (send the audio)'})
                        continue
                    lines, st = al.run_stitched(pieces, req.get('lines') or [], cancelled=cancelled)
                    st['language'] = lang
                    send({'type': 'result', 'id': jid, 'source': 'aligned', 'lines': lines, 'stats': st})
                    if req.get('notes'):
                        stem, covered = al.last_stitched
                        self.keep(req, al, stem, covered, lines, lang)
                    continue
                spec = dict(req.get('audio') or {})
                if audio is not None:
                    spec['bytes'] = audio
                wav, sr = SA.read_audio(spec)
                if req['cmd'] == 'transcribe':
                    lines, st = al.transcribe(wav, sr, language=req.get('language'),
                                              size=req.get('size', 'turbo'), allow_nc=bool(req.get('allow_nc')),
                                              cancelled=cancelled)
                    send({'type': 'result', 'id': jid, 'source': 'transcribed', 'lines': lines, 'stats': st})
                else:
                    lines, st = al.run(wav, sr, req.get('lines') or [], cancelled=cancelled)
                    st['language'] = lang
                    stem = None
                    if req.get('final'):
                        self.songs.clear()
                    elif req.get('song') is not None:
                        stem = al.last_stem.float().cpu().numpy()
                        st['kept'] = self.songs.add(req['song'], key, float(req.get('offset') or 0), stem)
                    send({'type': 'result', 'id': jid, 'source': 'aligned', 'lines': lines, 'stats': st})
                    # sung notes: only a whole-song job from the song's start (final, or the one section)
                    if req.get('notes') and not float(req.get('offset') or 0):
                        self.keep(req, al, stem if stem is not None else al.last_stem.float().cpu().numpy(), None, lines, lang)
            except NoModel as e:
                send({'type': 'error', 'id': jid, 'code': 'no-model', 'message': str(e)})
            except SA.Cancelled:
                send({'type': 'error', 'id': jid, 'message': 'cancelled'})
            except Exception as e:  # error: reported to Sonata, the helper keeps running
                traceback.print_exc()
                send({'type': 'error', 'id': jid, 'message': '%s: %s' % (type(e).__name__, e)})
            finally:
                self.cancelled.discard(jid)
                self.current = None
                if self.al is not None:
                    self.al.last_stem = None          # the GPU copy of the stem: free before the cache goes back
                    self.al.last_emissions = None
                    self.al.last_stitched = None
                    self.al.last_char_first = None
                    try:
                        self.al.release_cache()
                    except Exception:  # error: NOT-WORTH — a failed empty_cache only keeps memory reserved
                        pass

    # --- sung notes (notes_step.py) ----------------------------------------------------------------
    def keep(self, req, al, stem, covered, lines, lang):
        """After a whole-song job's result was sent: keep what its notes step needs (replaces any older one)."""
        self.kept = notes_step.Kept(req.get('song'), stem, covered, lines, dict(al.last_char_first or {}),
                                    req.get('lines') or [], lang, getattr(al, 'label_index', None))

    def note_device(self, jid):
        """-> (torch, device) for a notes or pitch job, or None after sending low-vram."""
        import torch
        if torch.cuda.is_available() and os.environ.get('SONATA_ALIGN_DEVICE') != 'cpu':
            free, _total = torch.cuda.mem_get_info()
            need = notes_step.vram_need()
            if free < need:
                send({'type': 'error', 'id': jid, 'code': 'low-vram',
                      'message': 'not enough free graphics memory for the sung notes (%.1f GB free, %.1f GB needed)' % (free / 1e9, need / 1e9)})
                return None
            frac = os.environ.get('SONATA_ALIGN_VRAM_FRACTION')
            if frac:
                torch.cuda.set_per_process_memory_fraction(float(frac))
            return torch, 'cuda'
        return torch, 'cpu'

    def notes_job(self, req):
        jid = req.get('id')
        kept = self.kept
        if kept is None or kept.song is None or kept.song != req.get('song'):
            send({'type': 'error', 'id': jid, 'code': 'no-stem', 'message': 'this song\'s vocal stem is not kept here any more'})
            return
        self.kept = None              # one notes step per kept job; the stem goes with it
        if not notes_step.have_rmvpe():
            send({'type': 'error', 'id': jid, 'code': 'no-model', 'message': 'the RMVPE pitch model is not downloaded'})
            return
        torch = None
        device = 'cpu'
        self.current = jid
        try:
            got = self.note_device(jid)
            if got is None:
                return
            torch, device = got
            part, st = notes_step.run(kept, req.get('syl') or [], device=device, torch=torch,
                                      progress=lambda stage, p: send({'type': 'progress', 'id': jid, 'stage': stage, 'p': round(p, 3)}),
                                      cancelled=lambda: jid in self.cancelled)
            send({'type': 'result', 'id': jid, 'notes': part, 'stats': st})
        except SA.Cancelled:
            send({'type': 'error', 'id': jid, 'message': 'cancelled'})
        except Exception as e:  # error: SHOWN — reported to Sonata (one line in Settings), the helper keeps running
            traceback.print_exc()
            send({'type': 'error', 'id': jid, 'message': '%s: %s' % (type(e).__name__, e)})
        finally:
            kept = None
            self.cancelled.discard(jid)
            self.current = None
            if device == 'cuda' and torch is not None:
                try:
                    torch.cuda.empty_cache()
                except Exception:  # error: NOT-WORTH — a failed empty_cache only keeps memory reserved
                    pass

    def pitch_job(self, req):
        """The first play's pitch line of one kept section (Sheet notes in the Studio)."""
        jid = req.get('id')
        stem = self.songs.piece(req.get('song'), float(req.get('offset') or 0))
        if stem is None:
            send({'type': 'error', 'id': jid, 'code': 'no-stem', 'message': 'this section\'s vocal stem is not kept here'})
            return
        if not notes_step.have_rmvpe():
            send({'type': 'error', 'id': jid, 'code': 'no-model', 'message': 'the RMVPE pitch model is not downloaded'})
            return
        torch = None
        device = 'cpu'
        self.current = jid
        try:
            got = self.note_device(jid)
            if got is None:
                return
            torch, device = got
            line, st = notes_step.pitch_section(stem, float(req.get('offset') or 0), device=device, torch=torch,
                                                cancelled=lambda: jid in self.cancelled)
            send({'type': 'result', 'id': jid, 'pitch': line, 'stats': st})
        except SA.Cancelled:
            send({'type': 'error', 'id': jid, 'message': 'cancelled'})
        except Exception as e:  # error: SHOWN — Sonata's band says the line isn't there; the helper keeps running
            traceback.print_exc()
            send({'type': 'error', 'id': jid, 'message': '%s: %s' % (type(e).__name__, e)})
        finally:
            stem = None
            self.cancelled.discard(jid)
            self.current = None
            if device == 'cuda' and torch is not None:
                try:
                    torch.cuda.empty_cache()
                except Exception:  # error: NOT-WORTH — a failed empty_cache only keeps memory reserved
                    pass

    def prepare_notes(self, req):
        jid = req.get('id')
        try:
            notes_step.download_rmvpe(lambda d, t: send({'type': 'progress', 'id': jid, 'stage': 'download', 'p': round(d / max(t, 1), 3),
                                                          'detail': 'rmvpe %.0f/%.0f MB' % (d / 1e6, t / 1e6)}))
            send({'type': 'result', 'id': jid, 'ready': True, 'model': 'rmvpe', 'bytes': notes_step.RMVPE['bytes']})
        except SA.ChecksumError as e:  # error: SHOWN — Settings shows it; the part file is removed, nothing is kept
            send({'type': 'error', 'id': jid, 'code': 'checksum', 'message': str(e)})
        except Exception as e:  # error: SHOWN — offline, disk full: Settings shows it
            send({'type': 'error', 'id': jid, 'message': '%s: %s' % (type(e).__name__, e)})

    def handle(self, req):
        cmd = req.get('cmd')
        jid = req.get('id')
        if cmd == 'ping':
            send(self.pong())
        elif cmd == 'forget':
            self.jobs.put((req, None))     # in order: after the song's queued jobs
        elif cmd in ('align', 'transcribe', 'prepare', 'notes', 'pitch'):
            if (req.get('audio') or {}).get('stream'):
                self.streams[jid] = (req, [])
            else:
                self.jobs.put((req, None))
        elif cmd == 'chunk':
            if jid in self.streams:
                self.streams[jid][1].append(base64.b64decode(req.get('data', '')))
        elif cmd == 'end':
            if jid in self.streams:
                r, parts = self.streams.pop(jid)
                self.jobs.put((r, b''.join(parts)))
        elif cmd == 'cancel':
            self.streams.pop(jid, None)
            self.cancelled.add(jid)
        elif cmd == 'quit':
            return False
        else:
            send({'type': 'error', 'id': jid, 'message': 'unknown cmd %r' % cmd})
        return True

    def pong(self):
        info = {'type': 'pong', 'version': SA.VERSION, 'features': ['song-cache', 'vram-check', 'notes', 'pitch'],
                'note_models': {'rmvpe': notes_step.have_rmvpe()},
                'models': {k: SA.have_model(k) for k in SA.MODELS},
                'whisper': {k: os.path.exists(os.path.join(SA.MODEL_DIR, 'whisper-' + k, 'model.bin')) for k in SA.WHISPER}}
        try:
            import torch
            info['device'] = 'cuda' if torch.cuda.is_available() and os.environ.get('SONATA_ALIGN_DEVICE') != 'cpu' else 'cpu'
            if torch.cuda.is_available():
                info['gpu'] = torch.cuda.get_device_name(0)
        except Exception as e:
            info['device'] = 'unavailable'
            info['message'] = str(e)
        return info


def main():
    srv = Server()
    threading.Thread(target=srv.worker, daemon=True).start()
    # loop: one stdin line per request · ends on quit or when Sonata closes the pipe
    for raw in sys.stdin:
        raw = raw.strip()
        if not raw:
            continue
        try:
            req = json.loads(raw)
        except ValueError:
            send({'type': 'error', 'message': 'bad json'})
            continue
        if not srv.handle(req):
            break


if __name__ == '__main__':
    main()
