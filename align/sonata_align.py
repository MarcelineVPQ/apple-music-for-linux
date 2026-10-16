"""sonata-align core: vocal separation + CTC forced alignment of KNOWN lyrics.

Pipeline (one song):
  audio (stereo PCM) -> Demucs htdemucs vocals stem -> 16 kHz mono -> wav2vec2 CTC emissions
  -> per line: Viterbi forced alignment of that line's characters inside a window around its
     LRC line start (the anchor), with a "garbage" token on both ends that absorbs neighbouring
     singing -> word start/end + confidence.

Lines whose alignment is weak (low confidence) or whose text has no alignable characters are
returned unaligned (aligned: false); Sonata keeps its estimate for them.

Everything heavy is lazy: torch / demucs / torchaudio are imported on first use so `ping` is fast.
"""

import json
import math
import os
import sys
import time
import unicodedata
import urllib.request

VERSION = '0.1.0'

DATA_DIR = os.environ.get('SONATA_ALIGN_HOME') or os.path.join(
    os.environ.get('XDG_DATA_HOME') or os.path.expanduser('~/.local/share'), 'sonata-align')
MODEL_DIR = os.path.join(DATA_DIR, 'models')

FRAME = 0.02            # wav2vec2 frame hop (320 samples at 16 kHz)
FRAME_OFFSET = 0.01     # centre of a frame's receptive field vs its start

# Models. Sizes are the download sizes. Licences matter for a free app, see docs/LEVEL2-ALIGN.md.
MODELS = {
    'htdemucs': {
        'url': 'https://dl.fbaipublicfiles.com/demucs/hybrid_transformer/955717e8-8726e21a.th',
        'file': 'htdemucs-955717e8.th', 'bytes': 84141911, 'licence': 'MIT',
    },
    # multilingual (1100+ languages, romanised a-z), the best aligner, but CC-BY-NC 4.0 weights
    'mms': {
        'url': 'https://dl.fbaipublicfiles.com/mms/torchaudio/ctc_alignment_mling_uroman/model.pt',
        'file': 'mms-fa.pt', 'bytes': 1262047414, 'licence': 'CC-BY-NC-4.0',
    },
    # English-only wav2vec 2.0 large (LibriSpeech 960 h fine-tune), MIT weights
    'en': {
        'url': 'https://download.pytorch.org/torchaudio/models/wav2vec2_fairseq_large_lv60k_asr_ls960.pth',
        'file': 'w2v2-large-lv60k-960h.pth', 'bytes': 1262046195, 'licence': 'MIT',
    },
    # English-only wav2vec 2.0 base, MIT weights, small and fast
    'en-base': {
        'url': 'https://download.pytorch.org/torchaudio/models/wav2vec2_fairseq_base_ls960_asr_ls960.pth',
        'file': 'w2v2-base-960h.pth', 'bytes': 377664473, 'licence': 'MIT',
    },
}
# Per-language XLSR-53 fine-tunes (Common Voice, CC0 data), Apache-2.0 weights: the permissive
# multilingual option (one 1.26 GB model per language). Loaded with transformers.
XLSR_LANGS = {'en': 'english', 'de': 'german', 'fr': 'french', 'es': 'spanish', 'it': 'italian',
              'pt': 'portuguese', 'nl': 'dutch', 'pl': 'polish', 'ru': 'russian', 'ja': 'japanese',
              'zh': 'chinese-zh-cn', 'fi': 'finnish', 'hu': 'hungarian', 'el': 'greek', 'fa': 'persian', 'ar': 'arabic'}
for _code, _name in XLSR_LANGS.items():
    MODELS['xlsr-' + _code] = {'hf': 'jonatasgrosman/wav2vec2-large-xlsr-53-' + _name,
                               'bytes': 1262089623, 'licence': 'Apache-2.0'}
ALIGNERS = ('mms', 'en', 'en-base') + tuple('xlsr-' + c for c in XLSR_LANGS)

# Transcription fallback (songs with no lyrics anywhere): faster-whisper / CTranslate2 (MIT),
# Whisper large-v3-turbo weights (MIT, OpenAI) converted to CTranslate2 (dropbox-dash, formerly mobiuslabsgmbh; MIT).
WHISPER = {
    'turbo': {'repo': 'dropbox-dash/faster-whisper-large-v3-turbo', 'bytes': 1.62e9, 'licence': 'MIT'},
    'small': {'repo': 'Systran/faster-whisper-small', 'bytes': 0.48e9, 'licence': 'MIT'},
}

# Language guess from the lyrics text (picks the aligner for 'auto'): stopword hits for Latin
# languages, Unicode script for the others. Good enough for whole songs (dozens of words).
STOPWORDS = {
    'en': "the and you i to a of in it is my me that on your we for be all don't i'm it's love what this with so no just",
    'de': "ich und die der das nicht du ist ein zu es mich mir sie wir in den dich auf was mit ist eine sich dein noch",
    'fr': "je et le la les de tu que pas un une est des il ne en moi qui on pour dans mon toi c'est j'ai suis plus mais",
    'es': "que de y la el no me en mi te lo tu un una es por se los con las yo para como más pero si amor",
    'it': "che di e il la non mi un una per ti è in sono io con ma lo le del tu come se ho anche",
    'pt': "que de e o a não eu um uma é em me com você do da te meu minha para se mais por os",
    'nl': "ik de het een en je niet van is dat in mij me op wat ze we maar zijn met voor jij nog",
    'pl': "nie i w się że na to ja jest z do mnie mi co ty jak ale tak już",
    'fi': "ja on en se ei minä sinä että kun mutta niin tämä olen olet jos vain",
    'hu': "a az és nem hogy is egy én te meg de van már csak ha mint",
}
STOPWORDS = {k: set(v.split()) for k, v in STOPWORDS.items()}


def detect_language(texts):
    text = ' '.join(texts)
    counts = {}
    for ch in text:
        o = ord(ch)
        script = ('ru' if 0x400 <= o < 0x500 else 'el' if 0x370 <= o < 0x400 else
                  'ar' if 0x600 <= o < 0x700 else 'ja' if 0x3040 <= o < 0x3100 else
                  'zh' if 0x4E00 <= o < 0xA000 else 'ko' if 0xAC00 <= o < 0xD7B0 else None)
        if script:
            counts[script] = counts.get(script, 0) + 1
    letters = sum(1 for c in text if c.isalpha())
    if counts and max(counts.values()) > 0.3 * max(1, letters):
        best = max(counts, key=counts.get)
        if best == 'zh' and counts.get('ja'):
            best = 'ja'
        return best
    words = [w.strip('.,!?¿¡;:"()').lower().replace('’', "'") for w in text.split()]
    score = {L: sum(1 for w in words if w in sw) for L, sw in STOPWORDS.items()}
    best = max(score, key=score.get)
    return best if score[best] > 0 else 'en'


def aligner_for(lang):
    """Default aligner per language: permissive models only (MIT / Apache-2.0).
    None = no permissive model (the caller may opt into 'mms', CC-BY-NC)."""
    if lang == 'en':
        return 'en'
    if lang in XLSR_LANGS:
        return 'xlsr-' + lang
    return None


# Alignment parameters (tuned on the JamendoLyrics bench, see docs/LEVEL2-ALIGN.md)
DEFAULTS = {
    'pre': 1.5,          # s before the anchor the window starts
    'post': 1.5,         # s after the next line's anchor the window ends
    'star': -2.0,        # log score per frame of the garbage token at both window ends
    'min_conf': 0.2,     # lines below this mean token probability stay unaligned
}


def log(*a):
    print(*a, file=sys.stderr, flush=True)


# ---------------------------------------------------------------------------------------------
# Model files

def model_path(name):
    if 'hf' in MODELS[name]:
        return os.path.join(MODEL_DIR, name)
    return os.path.join(MODEL_DIR, MODELS[name]['file'])


def have_model(name):
    if 'hf' in MODELS[name]:
        return os.path.exists(os.path.join(MODEL_DIR, name, 'pytorch_model.bin'))
    p = model_path(name)
    return os.path.exists(p) and os.path.getsize(p) == MODELS[name]['bytes']


def download(name, progress=None):
    """Download a model file once (atomic: .part + rename). progress(done, total)."""
    if have_model(name):
        return model_path(name) if 'hf' not in MODELS[name] else os.path.join(MODEL_DIR, name)
    m = MODELS[name]
    if 'hf' in m:
        from huggingface_hub import snapshot_download
        d = os.path.join(MODEL_DIR, name)
        if progress:
            progress(0, m['bytes'])
        snapshot_download(m['hf'], local_dir=d, allow_patterns=[
            'config.json', 'preprocessor_config.json', 'vocab.json', 'pytorch_model.bin'])
        if progress:
            progress(m['bytes'], m['bytes'])
        return d
    os.makedirs(MODEL_DIR, exist_ok=True)
    dst = model_path(name)
    part = dst + '.part'
    req = urllib.request.Request(m['url'], headers={'User-Agent': 'sonata-align/' + VERSION})
    # loop: one read per 1 MiB until the response ends · lifetime: one HTTP response per model
    with urllib.request.urlopen(req, timeout=60) as r, open(part, 'wb') as f:
        total = int(r.headers.get('Content-Length') or m['bytes'])
        done = 0
        last = 0
        while True:
            buf = r.read(1 << 20)
            if not buf:
                break
            f.write(buf)
            done += len(buf)
            if progress and (done - last >= (8 << 20) or done == total):
                last = done
                progress(done, total)
    if os.path.getsize(part) != m['bytes']:
        os.remove(part)
        raise RuntimeError('download of %s incomplete' % name)
    os.replace(part, dst)
    return dst


# ---------------------------------------------------------------------------------------------
# Text -> tokens

def normalise_word(word, labels):
    """Lower-case; keep characters the model knows (é for the French model); otherwise strip
    accents (é -> e, ß -> ss); drop the rest (digits, punctuation)."""
    out = []
    for c in word.lower().replace('’', "'").replace('‘', "'"):
        if c in labels:
            out.append(c)
            continue
        c = {'ß': 'ss', 'æ': 'ae', 'œ': 'oe', 'ø': 'o', 'đ': 'd', 'ł': 'l'}.get(c, c)
        c = ''.join(x for x in unicodedata.normalize('NFKD', c) if not unicodedata.combining(x))
        out.extend(x for x in c if x in labels)
    return ''.join(out)


def split_words(text):
    return [w for w in str(text or '').split() if w]


# ---------------------------------------------------------------------------------------------
# CTC forced alignment (Viterbi), numpy, no torchaudio dependency

def ctc_align(em, tokens, blank=0, lo=None, hi=None):
    """CTC Viterbi forced alignment.
    em: [T, C] log-probs (numpy float32); tokens: label ids (no blanks); lo/hi: optional
    per-token frame bounds (a token may only be emitted in frames lo..hi-1; blanks anywhere).
    Returns [(token_index, frame)] for every frame that emits a token (not blank), or None
    when no path fits (window too short)."""
    import numpy as np
    T = em.shape[0]
    S = len(tokens)
    L = 2 * S + 1
    ext = np.full(L, blank, dtype=np.int64)
    ext[1::2] = tokens
    # skip transition s-2 -> s (over a blank) only between two different tokens
    skip = np.zeros(L, dtype=bool)
    skip[3::2] = ext[3::2] != ext[1:-2:2]
    if lo is not None:
        slo = np.zeros(L, dtype=np.int64)
        shi = np.full(L, T, dtype=np.int64)
        slo[1::2] = lo
        shi[1::2] = hi
    NEG = -1e30
    alpha = np.full(L, NEG, dtype=np.float64)
    alpha[0] = em[0, ext[0]]
    if L > 1:
        alpha[1] = em[0, ext[1]]
    if lo is not None:
        alpha[(slo > 0) | (shi <= 0)] = NEG
    back = np.zeros((T, L), dtype=np.int8)   # 0 stay, 1 from s-1, 2 from s-2
    idx = np.arange(L)
    a1 = np.empty(L)
    a2 = np.empty(L)
    # loop: one step per frame (~50 per second of audio) · vectorised over all states
    for t in range(1, T):
        a1[0] = NEG
        a1[1:] = alpha[:-1]
        a2[:2] = NEG
        a2[2:] = alpha[:-2]
        a2[~skip] = NEG
        stack = np.stack([alpha, a1, a2])
        arg = stack.argmax(0)
        alpha = stack[arg, idx] + em[t, ext]
        if lo is not None:
            alpha[(t < slo) | (t >= shi)] = NEG
        back[t] = arg
    end = L - 1 if L == 1 or alpha[L - 1] >= alpha[L - 2] else L - 2
    if alpha[end] <= NEG / 2:
        return None
    path = []
    s = end
    # loop: one step back per frame
    for t in range(T - 1, -1, -1):
        if s % 2 == 1:
            path.append(((s - 1) // 2, t))
        s -= int(back[t, s])
        if s < 0:
            return None
    path.reverse()
    return path


# ---------------------------------------------------------------------------------------------
# Heavy parts (torch)

class Aligner:
    def __init__(self, aligner='mms', device=None, separate=True, progress=None, params=None):
        import torch
        self.torch = torch
        if device in (None, 'auto'):
            device = os.environ.get('SONATA_ALIGN_DEVICE') or ('cuda' if torch.cuda.is_available() else 'cpu')
        self.device = device
        self.aligner_name = aligner
        self.use_separation = separate
        self.params = dict(DEFAULTS, **(params or {}))
        self.progress = progress or (lambda stage, p, detail=None: None)
        self.demucs = None
        self.w2v = None
        self.labels = None
        os.environ.setdefault('TORCH_HOME', os.path.join(DATA_DIR, 'torch'))

    def use(self, aligner):
        """Switch the alignment model (the old one is freed; the separator stays loaded)."""
        if aligner != self.aligner_name:
            self.w2v = None
            self.labels = None
            self.aligner_name = aligner
            if self.device.startswith('cuda'):
                self.torch.cuda.empty_cache()
        return self

    # -- models ---------------------------------------------------------------------------------
    def ensure_models(self):
        need = ([('htdemucs')] if self.use_separation else []) + [self.aligner_name]
        for name in need:
            if not have_model(name):
                mb = MODELS[name]['bytes'] / 1e6
                self.progress('download', 0.0, '%s (%.0f MB)' % (name, mb))
                download(name, lambda d, t, n=name: self.progress('download', d / t, '%s %.0f/%.0f MB' % (n, d / 1e6, t / 1e6)))
                self.progress('download', 1.0, name)

    def load(self):
        self.ensure_models()
        if self.use_separation:
            self.ensure_models_sep()
        if self.w2v is None and self.aligner_name.startswith('xlsr-'):
            from transformers import Wav2Vec2ForCTC
            d = model_path(self.aligner_name)
            hf = Wav2Vec2ForCTC.from_pretrained(d).eval()
            vocab = json.load(open(os.path.join(d, 'vocab.json'), encoding='utf-8'))
            labels = [None] * len(vocab)
            for k, v in vocab.items():
                labels[v] = k
            self.w2v = _HFWrap(hf).to(self.device).eval()
            self.log_softmax_done = False
            self.labels = labels
            self.label_index = {c: i for i, c in enumerate(labels) if i != 0 and len(c) == 1 and c not in ('|', '-')}
        if self.w2v is None:
            import torchaudio.pipelines as P
            bundle = {'mms': P.MMS_FA, 'en': P.WAV2VEC2_ASR_LARGE_LV60K_960H,
                      'en-base': P.WAV2VEC2_ASR_BASE_960H}[self.aligner_name]
            kw = {'dl_kwargs': {'model_dir': MODEL_DIR, 'file_name': MODELS[self.aligner_name]['file'], 'progress': False}}
            if self.aligner_name == 'mms':
                model = bundle.get_model(with_star=False, **kw)
                labels = bundle.get_labels(star=None)
                self.log_softmax_done = True
            else:
                model = bundle.get_model(**kw)
                labels = bundle.get_labels()
                self.log_softmax_done = False
            self.w2v = model.to(self.device).eval()
            # model labels: index 0 is the CTC blank; English labels are upper case
            self.labels = [l.lower() for l in labels]
            self.label_index = {c: i for i, c in enumerate(self.labels) if i != 0 and c not in ('|', '-')}
        return self

    # -- stages ---------------------------------------------------------------------------------
    def separate(self, wav, sr):
        """wav: float tensor [2, N] at sr -> vocals mono float tensor at 16 kHz (on device)."""
        torch = self.torch
        import torchaudio.functional as AF
        wav = wav.to(self.device)
        if not self.use_separation:
            return AF.resample(wav.mean(0), sr, 16000)
        from demucs.apply import apply_model
        msr = self.demucs.samplerate
        if sr != msr:
            wav = AF.resample(wav, sr, msr)
        ref = wav.mean(0)
        mean, std = ref.mean(), ref.std() + 1e-8
        with torch.inference_mode():
            out = apply_model(self.demucs, ((wav - mean) / std)[None], device=self.device,
                              shifts=0, split=True, overlap=0.25, progress=False)[0]
        vocals = out[self.demucs.sources.index('vocals')] * std + mean
        return AF.resample(vocals.mean(0), msr, 16000)

    def emissions(self, mono16, chunk_s=20.0, ctx_s=2.0):
        """Log-prob emissions [T, C] (numpy) for the whole song, computed in overlapping chunks."""
        torch = self.torch
        import numpy as np
        sr = 16000
        n = mono16.shape[-1]
        total_frames = n // 320
        out = None
        chunk = int(chunk_s * sr)
        ctx = int(ctx_s * sr)
        pos = 0
        use_amp = self.device.startswith('cuda')
        # loop: one model pass per 20 s chunk · ends at the song's end
        while pos < n:
            a = max(0, pos - ctx)
            b = min(n, pos + chunk + ctx)
            x = mono16[a:b][None]
            with torch.inference_mode(), torch.autocast('cuda', dtype=torch.float16, enabled=use_amp):
                em, _ = self.w2v(x)
            em = em[0].float()
            if not self.log_softmax_done:
                em = torch.log_softmax(em, dim=-1)
            em = em.cpu().numpy()
            if out is None:
                out = np.full((total_frames + 1, em.shape[1]), -30.0, dtype=np.float32)
                out[:, 0] = 0.0
            f0 = pos // 320
            f1 = min(total_frames + 1, (pos + chunk) // 320)
            off = f0 - a // 320
            seg = em[off: off + (f1 - f0)]
            out[f0: f0 + seg.shape[0]] = seg
            pos += chunk
            self.progress('emissions', min(1.0, pos / n))
        return out

    # -- alignment ------------------------------------------------------------------------------
    def align_lines(self, em, lines, duration):
        """One global Viterbi pass over the whole song: every line's characters in order, a
        garbage token (star) between lines, and each line's tokens confined to a window around
        its anchor [t - pre, next anchor + post]. Lines can't overlap or swap, repeated lines
        can't steal each other's audio, and a weak line can't drag its neighbours."""
        import numpy as np
        p = self.params
        T = em.shape[0]
        star_col = np.full((T, 1), p['star'], dtype=np.float32)
        emx = np.concatenate([em, star_col], axis=1)
        STAR = emx.shape[1] - 1
        anchors = [l.get('t') for l in lines]
        known = [a for a in anchors if a is not None]
        seq, lo, hi, owner = [], [], [], []      # owner: (line, word, token-in-line) or None
        words_of = []
        for i, line in enumerate(lines):
            words = split_words(line.get('text'))
            words_of.append(words)
            toks = []
            for k, w in enumerate(words):
                for c in normalise_word(w, self.label_index):
                    toks.append((self.label_index[c], k))
            if not toks:
                continue
            t0 = anchors[i]
            if t0 is None and known:
                continue      # mixed synced/unsynced: leave unsynced lines alone
            if t0 is None:
                start, stop = 0.0, duration          # plain lyrics: the whole song
            else:
                nxt = next((a for a in anchors[i + 1:] if a is not None and a > t0), None)
                if nxt is None:
                    stop = t0 + 0.6 * len(words) + 3 + p['post']
                else:
                    stop = nxt + p['post']
                if line.get('end') is not None:
                    stop = min(stop, line['end'] + p['post'])
                start = max(0.0, t0 - p['pre'])
                stop = min(duration, max(stop, start + 0.12 * len(toks) + 0.5))
            f0, f1 = int(start / FRAME), min(T, int(math.ceil(stop / FRAME)))
            seq.append(STAR); lo.append(0); hi.append(T); owner.append(None)
            for n, (tok, k) in enumerate(toks):
                seq.append(tok); lo.append(f0); hi.append(f1); owner.append((i, k))
        seq.append(STAR); lo.append(0); hi.append(T); owner.append(None)
        path = ctc_align(emx, seq, lo=np.array(lo), hi=np.array(hi)) if len(seq) > 1 else None
        if path is None and len(seq) > 1:
            # windows too tight for some line (e.g. wrong anchors): fall back to order only
            path = ctc_align(emx, seq)

        # frames per token -> per word: start = first frame, end = last frame + 1,
        # confidence = mean over the word's characters of their peak probability
        tok_frames = {}
        for ti, fr in (path or []):
            tok_frames.setdefault(ti, []).append(fr)
        per_word = {}
        for ti, frs in tok_frames.items():
            o = owner[ti]
            if o is None:
                continue
            peak = float(np.exp(max(emx[fr, seq[ti]] for fr in frs)))
            d = per_word.setdefault(o, [min(frs), max(frs), []])
            d[0] = min(d[0], min(frs)); d[1] = max(d[1], max(frs)); d[2].append(peak)
        results = []
        for i, words in enumerate(words_of):
            res = {'line': i, 'aligned': False, 'confidence': 0.0, 'words': []}
            if not any((i, k) in per_word for k in range(len(words))):
                results.append(res)
                continue
            out, confs = [], []
            for k, w in enumerate(words):
                d = per_word.get((i, k))
                if d:
                    c = float(np.mean(d[2]))
                    out.append({'t': round(d[0] * FRAME + FRAME_OFFSET, 3),
                                'end': round((d[1] + 1) * FRAME + FRAME_OFFSET, 3), 'text': w, 'conf': round(c, 3)})
                    confs.append(c)
                else:
                    out.append({'t': None, 'end': None, 'text': w, 'conf': 0.0})
            fill_gaps(out)
            conf = float(np.mean(confs))
            res['confidence'] = round(conf, 3)
            res['words'] = out
            res['aligned'] = conf >= p['min_conf']
            results.append(res)
        return results

    def run(self, wav, sr, lines, cancelled=lambda: False):
        """wav: float tensor [2, N]. Returns (results, stats)."""
        torch = self.torch
        st = {}
        t = time.time()
        self.load()
        st['load_s'] = round(time.time() - t, 2)
        duration = wav.shape[-1] / sr
        t = time.time()
        self.progress('separate', 0.0)
        mono = self.separate(wav, sr)
        if self.device.startswith('cuda'):
            torch.cuda.synchronize()
        st['separate_s'] = round(time.time() - t, 2)
        self.progress('separate', 1.0)
        if cancelled():
            raise Cancelled()
        t = time.time()
        em = self.emissions(mono)
        self.last_emissions = em
        st['emissions_s'] = round(time.time() - t, 2)
        if cancelled():
            raise Cancelled()
        t = time.time()
        self.progress('align', 0.0)
        res = self.align_lines(em, lines, duration)
        st['align_s'] = round(time.time() - t, 2)
        self.progress('align', 1.0)
        st['duration_s'] = round(duration, 2)
        st['device'] = self.device
        st['aligner'] = self.aligner_name
        st['separation'] = 'htdemucs' if self.use_separation else 'none'
        st['aligned_lines'] = sum(1 for r in res if r['aligned'])
        st['lines'] = len(res)
        return res, st


    # -- transcription fallback -----------------------------------------------------------
    def load_whisper(self, size='turbo'):
        if getattr(self, 'whisper', None) is None or self.whisper_size != size:
            from faster_whisper import WhisperModel
            from huggingface_hub import snapshot_download
            d = os.path.join(MODEL_DIR, 'whisper-' + size)
            if not os.path.exists(os.path.join(d, 'model.bin')):
                self.progress('download', 0.0, 'whisper-%s (%.0f MB)' % (size, WHISPER[size]['bytes'] / 1e6))
                snapshot_download(WHISPER[size]['repo'], local_dir=d)
                self.progress('download', 1.0, 'whisper-' + size)
            cuda = self.device.startswith('cuda')
            self.whisper = WhisperModel(d, device='cuda' if cuda else 'cpu',
                                        compute_type='float16' if cuda else 'int8')
            self.whisper_size = size
        return self.whisper

    def transcribe(self, wav, sr, language=None, size='turbo', refine=True, allow_nc=False, cancelled=lambda: False):
        """Lyrics from the audio alone (no lyrics known anywhere). Same shape as align results,
        plus text per line; source 'transcribed'. Whisper can mishear: label it in the UI."""
        torch = self.torch
        st = {}
        t = time.time()
        if self.use_separation:
            self.ensure_models_sep()
        w = self.load_whisper(size)
        st['load_s'] = round(time.time() - t, 2)
        duration = wav.shape[-1] / sr
        t = time.time()
        self.progress('separate', 0.0)
        mono = self.separate(wav, sr)
        if self.device.startswith('cuda'):
            torch.cuda.synchronize()
        st['separate_s'] = round(time.time() - t, 2)
        self.progress('separate', 1.0)
        if cancelled():
            raise Cancelled()
        t = time.time()
        audio = mono.float().cpu().numpy()
        segments, info = w.transcribe(audio, language=language, word_timestamps=True,
                                      vad_filter=True, beam_size=5, condition_on_previous_text=False)
        lines = []
        # loop: one Whisper segment at a time (generator) · ends with the audio
        for seg in segments:
            words = [{'t': round(x.start, 3), 'end': round(x.end, 3), 'text': x.word.strip(),
                      'conf': round(float(x.probability), 3)} for x in (seg.words or []) if x.word.strip()]
            if not words:
                continue
            conf = sum(x['conf'] for x in words) / len(words)
            lines.append({'line': len(lines), 't': words[0]['t'], 'end': words[-1]['end'],
                          'text': ' '.join(x['text'] for x in words), 'words': words,
                          'confidence': round(conf, 3), 'aligned': True, 'source': 'transcribed'})
            self.progress('transcribe', min(1.0, seg.end / max(1.0, duration)))
            if cancelled():
                raise Cancelled()
        st['transcribe_s'] = round(time.time() - t, 2)
        # Whisper's own word times are coarse (median ~0.13 s, long tail); re-time the heard
        # words with the CTC aligner for that language (whisperX-style). Text stays Whisper's.
        name = aligner_for(info.language) or ('mms' if allow_nc else None)
        if refine and name and lines:
            t = time.time()
            self.use(name).load()
            em = self.emissions(mono)
            res = self.align_lines(em, [{'t': l['t'], 'text': l['text']} for l in lines], duration)
            for l, r in zip(lines, res):
                if r['aligned'] and len(r['words']) == len(l['words']):
                    for w, a in zip(l['words'], r['words']):
                        w['t'], w['end'], w['align_conf'] = a['t'], a['end'], a['conf']
                    l['t'], l['end'] = l['words'][0]['t'], l['words'][-1]['end']
                    l['retimed'] = True
            st['refine_s'] = round(time.time() - t, 2)
            st['aligner'] = name
        st['language'] = info.language
        st['language_p'] = round(float(info.language_probability), 3)
        st['duration_s'] = round(duration, 2)
        st['device'] = self.device
        st['model'] = 'whisper-' + size
        return lines, st

    def ensure_models_sep(self):
        if not have_model('htdemucs'):
            self.progress('download', 0.0, 'htdemucs (84 MB)')
            download('htdemucs', lambda d, t: self.progress('download', d / t, 'htdemucs %.0f/%.0f MB' % (d / 1e6, t / 1e6)))
        if self.demucs is None:
            from demucs.states import load_model
            pkg = self.torch.load(model_path('htdemucs'), map_location='cpu', weights_only=False)
            self.demucs = load_model(pkg).eval().to(self.device)


def _HFWrap(hf):
    import torch

    class W(torch.nn.Module):
        def __init__(self):
            super().__init__()
            self.hf = hf

        def forward(self, x):
            # HF feature extractor normalises each input to zero mean / unit variance
            x = (x - x.mean(-1, keepdim=True)) / (x.std(-1, keepdim=True) + 1e-7)
            return self.hf(x).logits, None
    return W()


class Cancelled(Exception):
    pass


def fill_gaps(words):
    """Words without frames (no alignable characters, e.g. "123" or "—") get times spread
    evenly between their aligned neighbours."""
    n = len(words)
    k = 0
    # loop: one pass over the words, each run of unaligned words handled once
    while k < n:
        if words[k]['t'] is not None:
            k += 1
            continue
        j = k
        while j < n and words[j]['t'] is None:
            j += 1
        run = j - k
        a = words[k - 1]['end'] if k > 0 else None
        b = words[j]['t'] if j < n else None
        if a is None and b is None:
            return
        if a is None:
            a = b - 0.25 * run
        if b is None:
            b = a + 0.25 * run
        step = max(0.0, b - a) / run
        for m in range(run):
            words[k + m]['t'] = round(a + step * m, 3)
            words[k + m]['end'] = round(a + step * (m + 1), 3)
            words[k + m]['interpolated'] = True
        k = j


# ---------------------------------------------------------------------------------------------
# Audio input

def read_audio(spec):
    """spec: {path, format?: 's16le'|'file', rate?, channels?} or raw bytes in spec['bytes'].
    Returns (float tensor [2, N], sr)."""
    import numpy as np
    import torch
    fmt = spec.get('format') or ('s16le' if spec.get('bytes') is not None or str(spec.get('path', '')).endswith(('.pcm', '.raw', '.s16')) else 'file')
    if fmt == 's16le':
        raw = spec['bytes'] if spec.get('bytes') is not None else open(spec['path'], 'rb').read()
        ch = int(spec.get('channels') or 2)
        sr = int(spec.get('rate') or 44100)
        a = np.frombuffer(raw[: len(raw) - len(raw) % (2 * ch)], dtype='<i2').astype(np.float32) / 32768.0
        a = a.reshape(-1, ch).T
    else:
        import soundfile as sf
        a, sr = sf.read(spec['path'], dtype='float32', always_2d=True)
        a = a.T
    if a.shape[0] == 1:
        a = np.concatenate([a, a])
    elif a.shape[0] > 2:
        a = a[:2]
    return torch.from_numpy(np.ascontiguousarray(a)), sr
