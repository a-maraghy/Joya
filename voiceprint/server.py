#!/usr/bin/env python3
"""
joya-voiceprint: local speaker embeddings for JOYA AI's voice (the voiceprint).

A small HTTP server on a Unix socket (never a TCP port), run by systemd as its
own account (joya-voiceprint.service). The dashboard's live relay sends the
first ~1.2 s of speech of each turn and gets back an embedding; the dashboard
compares it with the enrolled voiceprint. This process keeps NOTHING: no
audio, no embedding, no voiceprint, no log line about what was heard (only
counts and timings). It needs numpy and onnxruntime, no torch.

Model: WeSpeaker ResNet34-LM (VoxCeleb2), ONNX, from
https://huggingface.co/Wespeaker/wespeaker-voxceleb-resnet34-LM -- licensed
CC-BY-4.0 (attribution in the repository README). Chosen in the voiceprint
trial of 2026-10-07 (tools/voiceprint/): on the administrator's own recordings,
0 of 30 phrases missed and no echo or TV impostor passed at the FAR 1 %
threshold, ~15-20 ms per 1.5 s of speech on 2-4 threads.

  GET  /health                         {ok, model, sha256, dim, threads, version}
  POST /embed?rate=24000&first=1.2     body: PCM16 LE mono (16 or 24 kHz), at most 30 s
       -> {ok, embedding|null, speech_ms, used_ms, ms, too_short}
          the first `first` seconds of speech (pauses kept), VAD-trimmed;
          less than 0.3 s of speech -> embedding null, too_short true
  POST /enrol?rate=16000               body: PCM16 LE mono, at most 60 s
       -> {ok, embedding, windows, speech_ms, ms}: the speech cut into ~4 s
          windows, the embedding the sum of the windows' (the caller adds
          clips up and normalises)

Environment: JOYA_VOICEPRINT_SOCKET (/run/joya-voiceprint/voiceprint.sock),
JOYA_VOICEPRINT_MODEL (/var/lib/joya-voiceprint/models/voxceleb_resnet34_LM.onnx),
JOYA_VOICEPRINT_THREADS (2).
"""
import hashlib
import json
import os
import socket
import socketserver
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler
from urllib.parse import parse_qs, urlparse

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import fbank as fb  # noqa: E402

VERSION = "1"
SOCKET = os.environ.get("JOYA_VOICEPRINT_SOCKET", "/run/joya-voiceprint/voiceprint.sock")
MODEL = os.environ.get("JOYA_VOICEPRINT_MODEL", "/var/lib/joya-voiceprint/models/voxceleb_resnet34_LM.onnx")
THREADS = int(os.environ.get("JOYA_VOICEPRINT_THREADS", "2"))
MAX_EMBED_S = 30
MAX_ENROL_S = 60
MIN_SPEECH_S = 0.3
ENROL_WIN_S = 4.0


class Embedder:
    def __init__(self, path, threads):
        import onnxruntime as ort

        so = ort.SessionOptions()
        so.intra_op_num_threads = threads
        so.inter_op_num_threads = 1
        so.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
        self.session = ort.InferenceSession(path, sess_options=so, providers=["CPUExecutionProvider"])
        self.input = self.session.get_inputs()[0].name
        self.dim = int(self.session.get_outputs()[0].shape[-1])
        with open(path, "rb") as f:
            self.sha256 = hashlib.sha256(f.read()).hexdigest()
        self.path = path
        self.lock = threading.Lock()

    def embed(self, x):
        """x: float32 16 kHz in [-1, 1] -> L2-normalised embedding (numpy)."""
        if len(x) < 3200:
            x = np.pad(x, (0, 3200 - len(x)))
        f = fb.fbank(x * 32768.0)
        f = f - f.mean(axis=0, keepdims=True)
        with self.lock:
            e = self.session.run(None, {self.input: f[None, :, :]})[0].reshape(-1)
        return e / (np.linalg.norm(e) + 1e-9)


def to16k(pcm, rate):
    """PCM16 bytes at 16 or 24 kHz -> float32 at 16 kHz."""
    x = np.frombuffer(pcm, dtype="<i2").astype(np.float32) / 32768.0
    if rate == 16000:
        return x
    return fb.resample_24_to_16(x)


def embed_turn(model, x, first):
    seg, used, total = fb.first_speech(x, first)
    if total < MIN_SPEECH_S or len(seg) < 1600:
        return None, used, total
    return model.embed(seg), used, total


def enrol(model, x):
    seg, _, total = fb.first_speech(x, 0)
    w = int(ENROL_WIN_S * 16000)
    wins = [seg] if len(seg) < w * 1.5 else [seg[i: i + w] for i in range(0, len(seg) - w // 2, w)]
    wins = [s for s in wins if len(s) >= 8000]
    if not wins:
        return None, 0, total
    return np.sum([model.embed(s) for s in wins], axis=0), len(wins), total


def make_handler(model):
    class Handler(BaseHTTPRequestHandler):
        server_version = "joya-voiceprint/" + VERSION
        protocol_version = "HTTP/1.1"

        def address_string(self):
            return "unix"

        def log_message(self, fmt, *args):  # no request logging: nothing about what was heard
            pass

        def reply(self, code, obj):
            if code >= 400:
                self.close_connection = True  # the body may not have been read
            body = json.dumps(obj).encode()
            self.send_response(code)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self):
            if urlparse(self.path).path != "/health":
                return self.reply(404, {"ok": False, "error": "not found"})
            self.reply(200, {"ok": True, "model": os.path.basename(model.path), "sha256": model.sha256, "dim": model.dim, "threads": THREADS, "version": VERSION, "pid": os.getpid()})

        def do_POST(self):
            u = urlparse(self.path)
            q = parse_qs(u.query)
            try:
                rate = int(q.get("rate", ["16000"])[0])
                first = float(q.get("first", ["1.2"])[0])
            except ValueError:
                return self.reply(400, {"ok": False, "error": "bad parameters"})
            if rate not in (16000, 24000) or not (0 <= first <= 10):
                return self.reply(400, {"ok": False, "error": "rate must be 16000 or 24000"})
            limit = (MAX_ENROL_S if u.path == "/enrol" else MAX_EMBED_S) * rate * 2
            try:
                n = int(self.headers.get("Content-Length") or "0")
            except ValueError:
                n = -1
            if 0 < n <= 16 * 1024 * 1024 and (n % 2 or n > limit):
                left = n  # drain it, so the client reads the refusal instead of a broken pipe
                while left > 0:
                    chunk = self.rfile.read(min(65536, left))
                    if not chunk:
                        break
                    left -= len(chunk)
            if n <= 0 or n % 2 or n > limit:
                return self.reply(413 if n > limit else 400, {"ok": False, "error": "the body must be PCM16 audio, at most %d s" % (limit // (rate * 2))})
            pcm = self.rfile.read(n)
            t0 = time.perf_counter()
            x = to16k(pcm, rate)
            if u.path == "/embed":
                e, used, total = embed_turn(model, x, first)
                return self.reply(200, {"ok": True, "embedding": None if e is None else [round(float(v), 6) for v in e], "too_short": e is None, "speech_ms": int(total * 1000), "used_ms": int(used * 1000), "ms": round((time.perf_counter() - t0) * 1000, 1)})
            if u.path == "/enrol":
                e, wins, total = enrol(model, x)
                if e is None:
                    return self.reply(422, {"ok": False, "error": "not enough speech in this recording"})
                return self.reply(200, {"ok": True, "embedding": [round(float(v), 6) for v in e], "windows": wins, "speech_ms": int(total * 1000), "ms": round((time.perf_counter() - t0) * 1000, 1)})
            self.reply(404, {"ok": False, "error": "not found"})

    return Handler


class Server(socketserver.ThreadingMixIn, socketserver.UnixStreamServer):
    daemon_threads = True
    allow_reuse_address = True

    def handle_error(self, request, client_address):  # a client gone mid-request: counted, not dumped
        self.errors = getattr(self, "errors", 0) + 1


def serve(sock_path=SOCKET, model_path=MODEL, threads=THREADS, ready=None):
    model = Embedder(model_path, threads)
    model.embed(np.zeros(16000, dtype=np.float32) + 1e-3 * np.random.default_rng(0).standard_normal(16000).astype(np.float32))  # warm up
    if os.path.exists(sock_path):
        os.unlink(sock_path)
    srv = Server(sock_path, make_handler(model))
    os.chmod(sock_path, 0o660)  # the service's group (the dashboard's account is in it)
    print("joya-voiceprint: %s (%d-d, sha256 %s...) on %s, %d threads" % (os.path.basename(model_path), model.dim, model.sha256[:12], sock_path, threads), flush=True)
    if ready:
        ready(srv)
    try:
        srv.serve_forever()
    finally:
        srv.server_close()
        try:
            os.unlink(sock_path)
        except OSError:
            pass


if __name__ == "__main__":
    socket.setdefaulttimeout(30)
    serve()
