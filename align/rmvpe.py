"""RMVPE (Wei et al., Interspeech 2023): the vocal pitch (f0) model behind Settings -> "Sung notes
(developer log)" (sung_notes.py, docs/LEVEL2-ALIGN.md "Sung notes").

The network classes are copied from RVC (Retrieval-based-Voice-Conversion-WebUI, infer/rmvpe.py,
MIT licence, Copyright (c) 2023 liujing04) with the same module names, so RVC's rmvpe.pt
(huggingface.co/lj1995/VoiceConversionWebUI, MIT) loads as is. Changes: no CUDA-graph helper, no
DirectML/ONNX path, the mel filters come from torchaudio (same HTK/Slaney filters as librosa's, max
difference 3e-7), and the song is processed in chunks with context so a 4-minute song fits in a
small VRAM budget (the U-Net's activations grow with the frame count). Same code as the research
prototype (research/notes-proto/rmvpe_model.py on the research-gpu-pipeline branch).
"""

import numpy as np
import torch
import torch.nn as nn
import torch.nn.functional as F

N_CLASS = 360
HOP = 160          # 10 ms at 16 kHz


class BiGRU(nn.Module):
    def __init__(self, input_features, hidden_features, num_layers):
        super().__init__()
        self.gru = nn.GRU(input_features, hidden_features, num_layers=num_layers,
                          batch_first=True, bidirectional=True)

    def forward(self, x):
        return self.gru(x)[0]


class ConvBlockRes(nn.Module):
    def __init__(self, in_channels, out_channels, momentum=0.01):
        super().__init__()
        self.conv = nn.Sequential(
            nn.Conv2d(in_channels, out_channels, (3, 3), (1, 1), (1, 1), bias=False),
            nn.BatchNorm2d(out_channels, momentum=momentum), nn.ReLU(),
            nn.Conv2d(out_channels, out_channels, (3, 3), (1, 1), (1, 1), bias=False),
            nn.BatchNorm2d(out_channels, momentum=momentum), nn.ReLU())
        if in_channels != out_channels:
            self.shortcut = nn.Conv2d(in_channels, out_channels, (1, 1))

    def forward(self, x):
        if not hasattr(self, 'shortcut'):
            return self.conv(x) + x
        return self.conv(x) + self.shortcut(x)


class ResEncoderBlock(nn.Module):
    def __init__(self, in_channels, out_channels, kernel_size, n_blocks=1, momentum=0.01):
        super().__init__()
        self.conv = nn.ModuleList([ConvBlockRes(in_channels, out_channels, momentum)])
        for _ in range(n_blocks - 1):
            self.conv.append(ConvBlockRes(out_channels, out_channels, momentum))
        self.kernel_size = kernel_size
        if kernel_size is not None:
            self.pool = nn.AvgPool2d(kernel_size=kernel_size)

    def forward(self, x):
        for conv in self.conv:
            x = conv(x)
        if self.kernel_size is not None:
            return x, self.pool(x)
        return x


class Encoder(nn.Module):
    def __init__(self, in_channels, in_size, n_encoders, kernel_size, n_blocks, out_channels=16, momentum=0.01):
        super().__init__()
        self.bn = nn.BatchNorm2d(in_channels, momentum=momentum)
        self.layers = nn.ModuleList()
        for _ in range(n_encoders):
            self.layers.append(ResEncoderBlock(in_channels, out_channels, kernel_size, n_blocks, momentum=momentum))
            in_channels = out_channels
            out_channels *= 2
            in_size //= 2
        self.out_channel = out_channels

    def forward(self, x):
        concat = []
        x = self.bn(x)
        for layer in self.layers:
            t, x = layer(x)
            concat.append(t)
        return x, concat


class Intermediate(nn.Module):
    def __init__(self, in_channels, out_channels, n_inters, n_blocks, momentum=0.01):
        super().__init__()
        self.layers = nn.ModuleList([ResEncoderBlock(in_channels, out_channels, None, n_blocks, momentum)])
        for _ in range(n_inters - 1):
            self.layers.append(ResEncoderBlock(out_channels, out_channels, None, n_blocks, momentum))

    def forward(self, x):
        for layer in self.layers:
            x = layer(x)
        return x


class ResDecoderBlock(nn.Module):
    def __init__(self, in_channels, out_channels, stride, n_blocks=1, momentum=0.01):
        super().__init__()
        out_padding = (0, 1) if stride == (1, 2) else (1, 1)
        self.conv1 = nn.Sequential(
            nn.ConvTranspose2d(in_channels, out_channels, (3, 3), stride, (1, 1), output_padding=out_padding, bias=False),
            nn.BatchNorm2d(out_channels, momentum=momentum), nn.ReLU())
        self.conv2 = nn.ModuleList([ConvBlockRes(out_channels * 2, out_channels, momentum)])
        for _ in range(n_blocks - 1):
            self.conv2.append(ConvBlockRes(out_channels, out_channels, momentum))

    def forward(self, x, concat_tensor):
        x = torch.cat((self.conv1(x), concat_tensor), dim=1)
        for conv2 in self.conv2:
            x = conv2(x)
        return x


class Decoder(nn.Module):
    def __init__(self, in_channels, n_decoders, stride, n_blocks, momentum=0.01):
        super().__init__()
        self.layers = nn.ModuleList()
        for _ in range(n_decoders):
            out_channels = in_channels // 2
            self.layers.append(ResDecoderBlock(in_channels, out_channels, stride, n_blocks, momentum))
            in_channels = out_channels

    def forward(self, x, concat):
        for i, layer in enumerate(self.layers):
            x = layer(x, concat[-1 - i])
        return x


class DeepUnet(nn.Module):
    def __init__(self, kernel_size, n_blocks, en_de_layers=5, inter_layers=4, in_channels=1, en_out_channels=16):
        super().__init__()
        self.encoder = Encoder(in_channels, 128, en_de_layers, kernel_size, n_blocks, en_out_channels)
        self.intermediate = Intermediate(self.encoder.out_channel // 2, self.encoder.out_channel, inter_layers, n_blocks)
        self.decoder = Decoder(self.encoder.out_channel, en_de_layers, kernel_size, n_blocks)

    def forward(self, x):
        x, concat = self.encoder(x)
        return self.decoder(self.intermediate(x), concat)


class E2E(nn.Module):
    def __init__(self, n_blocks, n_gru, kernel_size, en_de_layers=5, inter_layers=4, in_channels=1, en_out_channels=16):
        super().__init__()
        self.unet = DeepUnet(kernel_size, n_blocks, en_de_layers, inter_layers, in_channels, en_out_channels)
        self.cnn = nn.Conv2d(en_out_channels, 3, (3, 3), padding=(1, 1))
        self.fc = nn.Sequential(BiGRU(3 * 128, 256, n_gru), nn.Linear(512, N_CLASS), nn.Dropout(0.25), nn.Sigmoid())

    def forward(self, mel):
        mel = mel.transpose(-1, -2).unsqueeze(1)
        x = self.cnn(self.unet(mel)).transpose(1, 2).flatten(-2)
        return self.fc(x)


class RMVPE:
    """f0 from 16 kHz mono audio: 10 ms frames, 360 bins of 20 cents from C1."""

    def __init__(self, path, device='cuda'):
        import torchaudio.functional as AF
        self.device = device
        self.model = E2E(4, 1, (2, 2))
        self.model.load_state_dict(torch.load(path, map_location='cpu', weights_only=True))
        self.model = self.model.eval().to(device)
        mel = AF.melscale_fbanks(513, 30.0, 8000.0, 128, 16000, norm='slaney', mel_scale='htk').T
        self.mel_basis = mel.float().to(device)
        self.window = torch.hann_window(1024).to(device)
        self.cents_map = np.pad(20 * np.arange(N_CLASS) + 1997.3794084376191, (4, 4))

    def mel(self, audio):
        spec = torch.stft(audio, n_fft=1024, hop_length=HOP, win_length=1024, window=self.window,
                          center=True, return_complex=True).abs()
        return torch.log(torch.clamp(self.mel_basis @ spec, min=1e-5))

    def salience(self, audio, chunk_frames=3200, ctx_frames=160):
        """audio: 1-D float tensor at 16 kHz. Returns salience [T, 360] (numpy).
        Chunks of 32 s with 1.6 s of context on both sides (the BiGRU sees past and future)."""
        audio = audio.float().to(self.device)
        mel = self.mel(audio[None])                    # [1, 128, T]
        T = mel.shape[-1]
        out = np.zeros((T, N_CLASS), dtype=np.float32)
        pos = 0
        # loop: one network pass per 32 s chunk · ends at the song's end
        while pos < T:
            a, b = max(0, pos - ctx_frames), min(T, pos + chunk_frames + ctx_frames)
            m = mel[..., a:b]
            n = m.shape[-1]
            pad = 32 * ((n - 1) // 32 + 1) - n
            if pad:
                m = F.pad(m, (0, pad))
            with torch.inference_mode():
                h = self.model(m)[0, :n].float().cpu().numpy()
            take = min(chunk_frames, T - pos)
            out[pos:pos + take] = h[pos - a: pos - a + take]
            pos += chunk_frames
        return out

    def decode(self, sal):
        """Local weighted average around the argmax (9 bins): f0 in Hz and the peak salience."""
        center = np.argmax(sal, axis=1) + 4
        s = np.pad(sal, ((0, 0), (4, 4)))
        idx = center[:, None] + np.arange(-4, 5)[None]
        w = np.take_along_axis(s, idx, axis=1)
        c = self.cents_map[idx]
        cents = (w * c).sum(1) / np.maximum(w.sum(1), 1e-9)
        f0 = 10 * 2 ** (cents / 1200)
        return f0, sal.max(axis=1)
