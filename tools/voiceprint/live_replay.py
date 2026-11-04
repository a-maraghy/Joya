#!/usr/bin/env python3
"""
Replay the voiceprint trial's recordings through the LIVE check's own code
(voiceprint/server.py + fbank.py: 24 kHz in, resampled, VAD, embedded) and the
relay's decision rules (dashboard/lib/voiceprint.js check()), to compare:

  bug    the window the relay scored before 2026-10-07's fix: the turn's
         window shifted EARLIER by the audio the page sent before the upstream
         session opened (OpenAI times turns on its own session's audio), then
         the first 1.2 s of speech in it -- so the tail of the previous pause
         and only the start of the phrase (D = 0.5, 1.0, 1.5 s);
  fixed  the whole turn, up to 3 s of speech;
  short  only 0.5-0.7 s of speech (a real short turn).

For each: the administrator's 30 test phrases (genuine), other people
(Common Voice EN + AR, 200 clips), JOYA AI's TTS voice (20 lines). Decisions as
the relay makes them: accept >= 0.31, reject < 0.20, under 0.8 s of speech
"unverified" (let through unless below reject), and with a recognised turn
earlier in the call ("sticky") doubtful turns let through.

    /root/.local/joya-voiceprint/venv/bin/python tools/voiceprint/live_replay.py /var/lib/joya-dashboard/voiceprint-trial/<user>
Scores and counts only; nothing is written.
"""
import glob
import json
import os
import sys

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "..", "voiceprint"))
import fbank as fb  # noqa: E402
import server  # noqa: E402

MODEL = "/root/.local/joya-voiceprint/models/wespeaker-voxceleb-resnet34-LM/voxceleb_resnet34_LM.onnx"
DATA = "/root/.local/joya-voiceprint/data"
ACCEPT, REJECT, MIN_S = 0.31, 0.20, 0.8


def read16(p):
    import soundfile as sf

    x, sr = sf.read(p, dtype="float32", always_2d=True)
    x = x.mean(axis=1)
    if sr != 16000:
        from scipy.signal import resample_poly

        x = resample_poly(x, 16000, sr).astype(np.float32)
    return x


def to24(x):
    from scipy.signal import resample_poly

    return resample_poly(x, 3, 2).astype(np.float32)


def live_score(m, vec, x24, first):
    """What the service does with what the relay sends: 24 kHz -> 16 kHz -> speech -> embedding."""
    x = fb.resample_24_to_16(x24)
    e, used, total = server.embed_turn(m, x, first)
    if e is None:
        return None, total
    return float(vec @ e), min(total, first)


def decide(score, speech_s, sticky):
    if score is None:
        return "unverified"
    if score >= ACCEPT:
        return "accept"
    if score < REJECT:
        return "reject"
    if speech_s < MIN_S:
        return "sticky" if sticky else "unverified"
    return "sticky" if sticky else "uncertain"


def windows(x16, mode, rng, d=1.0):
    """The audio the relay would score for a turn whose phrase is x16 (VAD-trimmed), at 24 kHz."""
    m, n = fb.speech_mask(x16)
    if not m.any():
        return None, None
    idx = np.flatnonzero(m)
    phrase = x16[max(0, idx[0] * n - 3200): (idx[-1] + 1) * n + 3200]
    pause = (0.002 * rng.standard_normal(int(16000 * 2.0))).astype(np.float32)  # noise-suppressed room
    stream = np.concatenate([pause, phrase, pause[:8000]])
    s0 = len(pause) - 3200  # the relay takes the turn from 200 ms before VAD's start
    s1 = len(pause) + len(phrase) + 2400
    if mode == "fixed":
        return to24(stream[s0:s1]), 3.0
    if mode == "bug":
        sh = int(d * 16000)
        return to24(stream[max(0, s0 - sh): max(0, s1 - sh)]), 1.2
    if mode == "short":
        k = int(rng.uniform(0.5, 0.7) * 16000)
        return to24(np.concatenate([pause[:3200], phrase[3200: 3200 + k], pause[:2400]])), 3.0
    raise ValueError(mode)


def main():
    udir = sys.argv[1] if len(sys.argv) > 1 else sorted(glob.glob("/var/lib/joya-dashboard/voiceprint-trial/*"))[0]
    rng = np.random.default_rng(3)
    m = server.Embedder(MODEL, 4)
    enrol = [read16(os.path.join(udir, "laptop", "e%d.wav" % i)) for i in range(1, 5)]
    tot = np.sum([server.enrol(m, x)[0] for x in enrol], axis=0)
    vec = tot / np.linalg.norm(tot)
    tests = [read16(p) for p in sorted(glob.glob(os.path.join(udir, "laptop", "t*.wav")))]
    others = [read16(p) for p in sorted(glob.glob(os.path.join(DATA, "public", "cv-en", "*.wav")))[:100] + sorted(glob.glob(os.path.join(DATA, "public", "cv-ar", "*.wav")))[:100]]
    tts = [read16(p) for p in sorted(glob.glob(os.path.join(DATA, "echo", "*.wav")))]
    out = {}
    for label, mode, d in [("bug D=0.5 s", "bug", 0.5), ("bug D=1.0 s", "bug", 1.0), ("bug D=1.5 s", "bug", 1.5), ("fixed (whole turn <= 3 s)", "fixed", 0), ("short turns (0.5-0.7 s of speech)", "short", 0)]:
        row = {}
        for who, clips in (("you", tests), ("others", others), ("JOYA AI's voice", tts)):
            sc, sp = [], []
            for x in clips:
                w, first = windows(x, mode, rng, d)
                if w is None:
                    continue
                s, speech = live_score(m, vec, w, first)
                sc.append(s)
                sp.append(speech)
            res = {}
            for sticky in (False, True):
                v = [decide(s, p, sticky) for s, p in zip(sc, sp)]
                res["sticky" if sticky else "first turn"] = {k: v.count(k) for k in ("accept", "sticky", "unverified", "uncertain", "reject")}
            valid = [s for s in sc if s is not None]
            row[who] = {"n": len(sc), "median": round(float(np.median(valid)), 3) if valid else None, "min": round(float(min(valid)), 3) if valid else None, "max": round(float(max(valid)), 3) if valid else None, "speech_s": round(float(np.median(sp)), 2), **res}
        out[label] = row
    print(json.dumps(out, indent=1))


if __name__ == "__main__":
    main()
