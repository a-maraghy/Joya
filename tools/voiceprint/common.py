"""
Shared pieces of the voiceprint trial harness (see evaluate.py).

Everything here is local: audio files on this box, models on this box. Nothing
is sent anywhere.

Paths (override with JOYA_VOICEPRINT_HOME): the venv, the model files, the
public data and the embedding cache live under /root/.local/joya-voiceprint,
never in the repository.
"""
import hashlib
import json
import os
import subprocess

import numpy as np
import soundfile as sf
from scipy.signal import resample_poly, fftconvolve, butter, sosfiltfilt

HOME = os.environ.get("JOYA_VOICEPRINT_HOME", "/root/.local/joya-voiceprint")
MODELS_DIR = os.path.join(HOME, "models")
DATA_DIR = os.path.join(HOME, "data")
CACHE_DIR = os.path.join(HOME, "cache")
RATE = 16000


def read_audio(path, rate=RATE):
    """Any WAV/FLAC (soundfile) or anything ffmpeg reads -> float32 mono at `rate`."""
    try:
        x, sr = sf.read(path, dtype="float32", always_2d=True)
        x = x.mean(axis=1)
    except Exception:
        out = subprocess.run(["ffmpeg", "-v", "error", "-i", path, "-f", "s16le", "-ac", "1", "-ar", str(rate), "-"], check=True, capture_output=True).stdout
        return np.frombuffer(out, dtype=np.int16).astype(np.float32) / 32768.0
    return resample(x, sr, rate)


def decode_bytes(data, rate=RATE):
    """Compressed audio bytes (e.g. Common Voice mp3) -> float32 mono at `rate`, through ffmpeg."""
    out = subprocess.run(["ffmpeg", "-v", "error", "-i", "pipe:0", "-f", "s16le", "-ac", "1", "-ar", str(rate), "-"], input=data, check=True, capture_output=True).stdout
    return np.frombuffer(out, dtype=np.int16).astype(np.float32) / 32768.0


def resample(x, sr, rate=RATE):
    if sr == rate:
        return x.astype(np.float32)
    g = np.gcd(int(sr), int(rate))
    return resample_poly(x, rate // g, sr // g).astype(np.float32)


def write_wav(path, x, rate=RATE):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    sf.write(path, np.clip(x, -1, 1), rate, subtype="PCM_16")


def speech_mask(x, rate=RATE, frame_ms=20):
    """A plain energy VAD: frames within 30 dB of the loudest (and above an absolute floor)."""
    n = int(rate * frame_ms / 1000)
    if len(x) < n:
        return np.zeros(0, dtype=bool), n
    frames = x[: len(x) // n * n].reshape(-1, n)
    db = 10 * np.log10(np.mean(frames ** 2, axis=1) + 1e-10)
    top = np.percentile(db, 95)
    floor = max(top - 30.0, np.percentile(db, 10) + 6.0, -60.0)
    return db > floor, n


def speech_seconds(x, rate=RATE):
    m, n = speech_mask(x, rate)
    return float(m.sum() * n) / rate


def trim(x, rate=RATE, pad_ms=100):
    """Leading and trailing silence cut (what a VAD segment would give the verifier)."""
    m, n = speech_mask(x, rate)
    if not m.any():
        return x
    idx = np.flatnonzero(m)
    pad = int(rate * pad_ms / 1000)
    return x[max(0, idx[0] * n - pad): min(len(x), (idx[-1] + 1) * n + pad)]


def rms(x):
    return float(np.sqrt(np.mean(x ** 2) + 1e-12))


def mix(signal, noise, snr_db, rng):
    """signal + noise at `snr_db` (noise looped/cut to length)."""
    if len(noise) < len(signal):
        noise = np.tile(noise, int(np.ceil(len(signal) / max(1, len(noise)))))
    start = rng.integers(0, len(noise) - len(signal) + 1)
    nz = noise[start: start + len(signal)]
    gain = rms(signal) / (rms(nz) * 10 ** (snr_db / 20))
    y = signal + gain * nz
    peak = np.max(np.abs(y)) + 1e-9
    return (y / peak * 0.9).astype(np.float32) if peak > 0.99 else y.astype(np.float32)


def synthetic_rir(rng, rate=RATE, rt60=0.35):
    """An exponentially decaying noise tail: a crude small-room impulse response."""
    n = int(rate * rt60)
    t = np.arange(n) / rate
    h = rng.standard_normal(n) * np.exp(-6.9 * t / rt60)
    h[0] = 1.0 / 0.3
    return (h / np.sqrt(np.sum(h ** 2))).astype(np.float32)


def laptop_speaker(x, rng, rate=RATE):
    """Playback through a small loudspeaker into a room, picked up by a mic:
    band-limited (250 Hz - 6 kHz), reverberant, a little noise. The 'echo' case."""
    sos = butter(4, [250, 6000], btype="band", fs=rate, output="sos")
    y = sosfiltfilt(sos, x)
    y = fftconvolve(y, synthetic_rir(rng, rate, rt60=float(rng.uniform(0.25, 0.5))))[: len(x)]
    y = mix(y.astype(np.float32), rng.standard_normal(len(y)).astype(np.float32), 30, rng)
    return y


def other_channel(x, rng, rate=RATE):
    """A different microphone and room: telephone-ish band, light reverb, 20 dB noise.
    Stands in for 'cross-mic' when the public speakers were recorded on one device."""
    sos = butter(4, [200, 4000], btype="band", fs=rate, output="sos")
    y = sosfiltfilt(sos, x)
    y = fftconvolve(y, synthetic_rir(rng, rate, rt60=0.2))[: len(x)]
    return mix(y.astype(np.float32), rng.standard_normal(len(y)).astype(np.float32), 20, rng)


def file_key(path, extra=""):
    st = os.stat(path)
    return hashlib.sha1(f"{os.path.abspath(path)}|{st.st_size}|{st.st_mtime_ns}|{extra}".encode()).hexdigest()


def load_json(path, default=None):
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return default
