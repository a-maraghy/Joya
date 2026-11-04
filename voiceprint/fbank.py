"""
Kaldi-compatible log-mel filterbank features in numpy -- what WeSpeaker's
models were trained on (torchaudio.compliance.kaldi.fbank with 80 bins, 25 ms
frames every 10 ms, a Hamming window, no dither), without torch.

test_voiceprint.py checks it against torchaudio's own implementation when
torch is available (the trial venv has it); the service itself needs only numpy.
"""
import numpy as np

EPS = np.finfo(np.float32).eps  # torchaudio floors the mel energies at float eps


def _mel(f):
    return 1127.0 * np.log(1.0 + f / 700.0)


def mel_banks(num_bins=80, padded=512, rate=16000, low=20.0, high=0.0):
    """Kaldi's triangular mel filters on the FFT bins (torchaudio get_mel_banks, no VTLN) -> (num_bins, padded/2 + 1)."""
    nyquist = 0.5 * rate
    if high <= 0.0:
        high += nyquist
    n_fft = padded // 2
    width = rate / padded
    mlo, mhi = _mel(low), _mel(high)
    delta = (mhi - mlo) / (num_bins + 1)
    b = np.arange(num_bins, dtype=np.float64)[:, None]
    left = mlo + b * delta
    center = mlo + (b + 1.0) * delta
    right = mlo + (b + 2.0) * delta
    mel = _mel(width * np.arange(n_fft, dtype=np.float64))[None, :]
    up = (mel - left) / (center - left)
    down = (right - mel) / (right - center)
    banks = np.maximum(0.0, np.minimum(up, down))
    return np.pad(banks, ((0, 0), (0, 1))).astype(np.float32)


_BANKS = {}
_WINDOWS = {}


def fbank(wave, rate=16000, num_bins=80, frame_ms=25, shift_ms=10, preemph=0.97):
    """wave: float samples scaled like int16 (x * 32768). -> (frames, num_bins) float32 log-mel energies."""
    x = np.asarray(wave, dtype=np.float64)
    size = int(rate * frame_ms / 1000)
    shift = int(rate * shift_ms / 1000)
    if len(x) < size:
        return np.zeros((0, num_bins), dtype=np.float32)
    n = 1 + (len(x) - size) // shift
    idx = np.arange(size)[None, :] + shift * np.arange(n)[:, None]
    frames = x[idx]
    frames = frames - frames.mean(axis=1, keepdims=True)  # remove_dc_offset
    prev = np.concatenate([frames[:, :1], frames[:, :-1]], axis=1)  # the first sample is its own predecessor
    frames = frames - preemph * prev
    if size not in _WINDOWS:
        _WINDOWS[size] = 0.54 - 0.46 * np.cos(2 * np.pi * np.arange(size) / (size - 1))  # torch.hamming_window(periodic=False)
    frames = frames * _WINDOWS[size]
    padded = 1 << (size - 1).bit_length()  # round_to_power_of_two
    spec = np.abs(np.fft.rfft(frames, n=padded, axis=1)) ** 2
    key = (num_bins, padded, rate)
    if key not in _BANKS:
        _BANKS[key] = mel_banks(num_bins, padded, rate)
    mel = spec.astype(np.float32) @ _BANKS[key].T
    return np.log(np.maximum(mel, EPS)).astype(np.float32)


# Frames quieter than this are never speech. The browser's noise suppression + auto gain put the
# administrator's speech at about -20..-27 dBFS (95th percentile) and the room at -67..-70 (the
# trial's recordings). Without it, a window with no speech in it -- the misaligned turns of
# 2026-10-07 -- had its noise floor called "speech" (within 30 dB of its own loudest frame) and
# scored as a voice (0.05-0.25). The trial harness used -60.
ABS_FLOOR_DB = -50.0


def speech_mask(x, rate=16000, frame_ms=20, abs_floor=ABS_FLOOR_DB):
    """A plain energy VAD: frames within 30 dB of the loudest, above a relative and an absolute floor."""
    n = int(rate * frame_ms / 1000)
    if len(x) < n:
        return np.zeros(0, dtype=bool), n
    frames = x[: len(x) // n * n].reshape(-1, n)
    db = 10 * np.log10(np.mean(frames.astype(np.float64) ** 2, axis=1) + 1e-10)
    top = np.percentile(db, 95)
    floor = max(top - 30.0, np.percentile(db, 10) + 6.0, abs_floor)
    return db > floor, n


def first_speech(x, seconds, rate=16000, pad_ms=100):
    """From the first speech frame, `seconds` of speech frames (pauses kept), padded a little.
    -> (audio, speech seconds in it, total speech seconds in x). seconds <= 0: all of it, trimmed."""
    m, n = speech_mask(x, rate)
    if not len(m) or not m.any():
        return x[:0], 0.0, 0.0
    idx = np.flatnonzero(m)
    total = float(m.sum() * n) / rate
    pad = int(rate * pad_ms / 1000)
    start = max(0, idx[0] * n - pad)
    if seconds and seconds > 0:
        cum = np.cumsum(m[idx[0]:])
        k = int(np.searchsorted(cum, int(round(seconds * rate / n))))
        if k < len(cum):
            end = min(len(x), (idx[0] + k + 1) * n + pad)
            return x[start:end], min(total, seconds), total
    end = min(len(x), (idx[-1] + 1) * n + pad)
    return x[start:end], total, total


def _phases(half=24, cutoff=7200.0, rate=24000.0):
    """The two polyphase filters of a 2:3 windowed-sinc low-pass (the dashboard's lib/voiceprint-trial.js to16k)."""
    fc = cutoff / rate
    out = []
    for frac in (0.0, 0.5):
        t = np.arange(-half + 1, half + 1, dtype=np.float64) - frac
        sinc = np.where(t == 0, 2 * fc, np.sin(2 * np.pi * fc * t) / (np.pi * np.where(t == 0, 1, t)))
        w = 0.42 + 0.5 * np.cos(np.pi * t / half) + 0.08 * np.cos(2 * np.pi * t / half)
        h = np.where(np.abs(t) < half, sinc * w, 0.0)
        out.append(h / h.sum())
    return out


_PH = _phases()


def resample_24_to_16(x):
    """float samples at 24 kHz -> 16 kHz (output i sits at input 1.5 i)."""
    x = np.asarray(x, dtype=np.float64)
    n = (len(x) * 2) // 3
    if n <= 0:
        return np.zeros(0, dtype=np.float32)
    half = 24
    xp = np.pad(x, (half, half + 2))
    out = np.empty(n, dtype=np.float64)
    i = np.arange(n)
    base = (i * 3) // 2
    odd = (i % 2) == 1
    taps = np.arange(-half + 1, half + 1)
    for ph, sel in ((0, ~odd), (1, odd)):
        b = base[sel]
        idx = b[:, None] + taps[None, :] + half
        out[sel] = xp[idx] @ _PH[ph]
    return out.astype(np.float32)
