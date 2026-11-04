#!/usr/bin/env python3
"""
joya-voiceprint's own tests (python unittest):

    /opt/joya-voiceprint/venv/bin/python voiceprint/test_voiceprint.py
    # or the trial venv, which also has torch for the fbank comparison:
    /root/.local/joya-voiceprint/venv/bin/python voiceprint/test_voiceprint.py

  - fbank.py against torchaudio.compliance.kaldi.fbank (skipped without torch);
  - the 24 -> 16 kHz resampler: length, level, a 10 kHz tone removed;
  - first_speech: the crop from the first speech frame, too-short audio;
  - the service on a temporary Unix socket with the real model (skipped when
    the model file is missing): /health, /embed at 16 and 24 kHz (the same
    voice scores high, a different one low), /enrol, refusals (bad rate, odd
    or oversized bodies, unknown paths), the socket's mode 0660, and timing.
"""
import glob
import http.client
import json
import os
import socket
import sys
import tempfile
import threading
import time
import unittest

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import fbank  # noqa: E402

MODEL = os.environ.get("JOYA_VOICEPRINT_MODEL") or next(
    (p for p in ["/var/lib/joya-voiceprint/models/voxceleb_resnet34_LM.onnx", "/root/.local/joya-voiceprint/models/wespeaker-voxceleb-resnet34-LM/voxceleb_resnet34_LM.onnx"] if os.path.exists(p)), None
)
LIBRI = "/root/.local/joya-voiceprint/data/LibriSpeech/test-clean"


def voice(seconds=3.0, f0=140.0, seed=0, rate=16000):
    """A crude voiced sound: a harmonic series with a little vibrato and noise, in bursts like syllables."""
    rng = np.random.default_rng(seed)
    t = np.arange(int(seconds * rate)) / rate
    f = f0 * (1 + 0.03 * np.sin(2 * np.pi * 5 * t))
    ph = 2 * np.pi * np.cumsum(f) / rate
    x = sum((0.6 / k) * np.sin(k * ph) for k in range(1, 12))
    env = (np.sin(2 * np.pi * 3 * t) > -0.3).astype(float)
    return (0.3 * x * env / 3 + 0.003 * rng.standard_normal(len(t))).astype(np.float32)


def read_flac(path):
    import soundfile as sf

    x, sr = sf.read(path, dtype="float32")
    return x


class FbankTest(unittest.TestCase):
    def test_matches_torchaudio(self):
        try:
            import torch
            import torchaudio.compliance.kaldi as kaldi
        except ImportError:
            self.skipTest("no torch here")
        x = voice(2.0) * 32768
        a = fbank.fbank(x)
        b = kaldi.fbank(torch.from_numpy(x).unsqueeze(0), num_mel_bins=80, frame_length=25, frame_shift=10, dither=0.0, sample_frequency=16000, window_type="hamming", use_energy=False).numpy()
        self.assertEqual(a.shape, b.shape)
        self.assertLess(float(np.abs(a - b).max()), 1e-2)

    def test_short_input(self):
        self.assertEqual(fbank.fbank(np.zeros(100)).shape, (0, 80))

    def test_resampler(self):
        t = np.arange(24000) / 24000
        y = fbank.resample_24_to_16(0.5 * np.sin(2 * np.pi * 1000 * t))
        self.assertEqual(len(y), 16000)
        self.assertAlmostEqual(float(np.sqrt(np.mean(y[200:-200] ** 2))), 0.5 / np.sqrt(2), places=3)
        y2 = fbank.resample_24_to_16(0.5 * np.sin(2 * np.pi * 10000 * t))
        self.assertLess(20 * np.log10(np.sqrt(np.mean(y2[200:-200] ** 2)) / 0.3536), -40)
        self.assertEqual(len(fbank.resample_24_to_16(np.zeros(1))), 0)

    def test_first_speech(self):
        x = np.concatenate([np.zeros(8000, np.float32), voice(3.0), np.zeros(8000, np.float32)])
        seg, used, total = fbank.first_speech(x, 1.2)
        self.assertAlmostEqual(used, 1.2)
        self.assertGreater(total, 1.5)
        self.assertLess(len(seg), len(x) - 8000)
        seg0, used0, total0 = fbank.first_speech(np.zeros(16000, np.float32), 1.2)
        self.assertEqual((len(seg0), used0, total0), (0, 0.0, 0.0))
        segall, u, tt = fbank.first_speech(x, 0)
        self.assertEqual(u, tt)


@unittest.skipUnless(MODEL, "no model file on this machine")
class ServiceTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        import server

        cls.server = server
        cls.dir = tempfile.mkdtemp(prefix="vp-test-")
        cls.sock = os.path.join(cls.dir, "vp.sock")
        holder = {}
        cls.thread = threading.Thread(target=server.serve, kwargs=dict(sock_path=cls.sock, model_path=MODEL, threads=2, ready=lambda s: holder.setdefault("srv", s)), daemon=True)
        cls.thread.start()
        for _ in range(200):
            if "srv" in holder:
                break
            time.sleep(0.05)
        cls.srv = holder["srv"]

    @classmethod
    def tearDownClass(cls):
        cls.srv.shutdown()

    def req(self, method, path, body=None):
        sock = self.sock

        class C(http.client.HTTPConnection):
            def connect(self):
                self.sock = socket.socket(socket.AF_UNIX)
                self.sock.connect(sock)

        c = C("x", timeout=20)
        c.request(method, path, body=body)
        r = c.getresponse()
        return r.status, json.loads(r.read())

    @staticmethod
    def pcm(x):
        return (np.clip(x, -1, 1) * 32767).astype("<i2").tobytes()

    def test_health_and_socket_mode(self):
        st, j = self.req("GET", "/health")
        self.assertEqual(st, 200)
        self.assertEqual(j["dim"], 256)
        self.assertEqual(len(j["sha256"]), 64)
        self.assertEqual(oct(os.stat(self.sock).st_mode & 0o777), "0o660")

    def test_embed_and_enrol(self):
        files = sorted(glob.glob(os.path.join(LIBRI, "1089", "*", "*.flac")))[:3] + sorted(glob.glob(os.path.join(LIBRI, "121", "*", "*.flac")))[:1]
        if len(files) < 4:
            self.skipTest("no LibriSpeech here")
        a, b, c, other = [read_flac(f) for f in files]
        st, e = self.req("POST", "/enrol?rate=16000", self.pcm(np.concatenate([a, b])))
        self.assertEqual(st, 200)
        self.assertGreaterEqual(e["windows"], 2)
        p = np.asarray(e["embedding"])
        p = p / np.linalg.norm(p)
        st, same = self.req("POST", "/embed?rate=16000&first=1.2", self.pcm(c))
        st2, diff = self.req("POST", "/embed?rate=16000&first=1.2", self.pcm(other))
        self.assertEqual((st, st2), (200, 200))
        self.assertAlmostEqual(same["used_ms"], 1200, delta=20)
        s_same = float(p @ np.asarray(same["embedding"]))
        s_diff = float(p @ np.asarray(diff["embedding"]))
        self.assertGreater(s_same, 0.45)
        self.assertLess(s_diff, 0.3)
        # 24 kHz in: the same voice still scores high
        t = np.arange(int(len(c) * 1.5))
        c24 = np.interp(t / 1.5, np.arange(len(c)), c).astype(np.float32)
        st, j24 = self.req("POST", "/embed?rate=24000&first=1.2", self.pcm(c24))
        self.assertGreater(float(p @ np.asarray(j24["embedding"])), 0.45)
        # timing: 1.2 s of speech, warm, 2 threads
        ts = []
        for _ in range(5):
            st, j = self.req("POST", "/embed?rate=24000&first=1.2", self.pcm(c24))
            ts.append(j["ms"])
        self.assertLess(sorted(ts)[2], 120)

    def test_refusals(self):
        self.assertEqual(self.req("POST", "/embed?rate=8000", b"\0\0" * 10)[0], 400)
        self.assertEqual(self.req("POST", "/embed?rate=16000", b"\0\0\0")[0], 400)
        self.assertEqual(self.req("POST", "/nope?rate=16000", b"\0\0")[0], 404)
        self.assertEqual(self.req("GET", "/nope")[0], 404)
        st, j = self.req("POST", "/embed?rate=16000", b"\0\0" * 1600)
        self.assertEqual((st, j["embedding"], j["too_short"]), (200, None, True))
        self.assertEqual(self.req("POST", "/enrol?rate=16000", b"\0\0" * 1600)[0], 422)
        st, j = self.req("POST", "/embed?rate=16000", b"\0\0" * (31 * 16000))
        self.assertEqual(st, 413)


if __name__ == "__main__":
    unittest.main(verbosity=1)
