"""Test WAVs for the Chromium measurement: 48 kHz float32 stereo, left = a tone, right = a sample
counter ((n + off) mod 2^23 + 2^23) / 2^24 (exact in float32, never 0), so every recorded frame names
its source sample.   python3 gen_wav.py <app dir>"""
import os, struct, sys
import numpy as np
R = 48000
def wav(path, secs, freq, off):
    n = np.arange(secs * R, dtype=np.int64)
    left = (0.25 * np.sin(2 * np.pi * freq * (n % R) / R)).astype(np.float32)
    k = n + off
    right = (((k & ((1 << 23) - 1)) + (1 << 23)).astype(np.float64) / (1 << 24)).astype(np.float32)
    data = np.stack([left, right], 1).astype('<f4').tobytes()
    hdr = b'RIFF' + struct.pack('<I', 36 + len(data)) + b'WAVE' + b'fmt ' + struct.pack('<IHHIIHH', 16, 3, 2, R, R * 8, 8, 32) + b'data' + struct.pack('<I', len(data))
    open(path, 'wb').write(hdr + data)
d = sys.argv[1]
wav(os.path.join(d, 'a.wav'), 150, 440, 0)
wav(os.path.join(d, 'b.wav'), 60, 880, 6000000)
