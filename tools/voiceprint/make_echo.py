#!/usr/bin/env python3
"""
The "voice's own playback" impostors: 20 short JOYA AI-style replies (English,
Egyptian Arabic, mixed) synthesised once with OpenAI's gpt-4o-mini-tts in the
live voices (marin = the panel's voice, cedar = the other one offered).
These stand in for JOYA AI's reply leaking back into the microphone; the
harness also scores them after a simulated loudspeaker + room (laptop_speaker).

The key is read through the dashboard's helper (`joya-helper voice-key-read`,
the same way dashboard/tools/voice-live-eval.cjs does), kept in memory only and
never printed or written. Costs about $0.02. Writes $HOME/data/echo/*.wav and
manifest.json; skips lines already made.

    sudo /root/.local/joya-voiceprint/venv/bin/python tools/voiceprint/make_echo.py
"""
import json
import os
import subprocess
import sys
import urllib.request

import numpy as np

sys.path.insert(0, os.path.dirname(__file__))
from common import DATA_DIR, resample, write_wav  # noqa: E402

OUT = os.path.join(DATA_DIR, "echo")
LINES = [
    ("en", "Odoo is running, and the disk is forty one percent full."),
    ("en", "Done. I opened Agents and sessions for you."),
    ("en", "There is one approval waiting: it deletes files."),
    ("en", "Okay, I will ask JOYA AI to restart the dashboard."),
    ("en", "Yes."),
    ("en", "Stop."),
    ("en", "The backup finished at two fifteen this morning."),
    ("eg", "تمام، أودو شغال والديسك مليان واحد وأربعين في المية."),
    ("eg", "حاضر، فتحتلك صفحة الإيجنتس."),
    ("eg", "فيه موافقة واحدة مستنياك."),
    ("eg", "نعم."),
    ("eg", "اقفل المكالمة."),
    ("eg", "خلاص، هقول لـ JOYA AI يعمل restart للداشبورد."),
    ("eg", "الباك اب خلص الساعة اتنين وربع الصبح."),
    ("mixed", "الـ memory usage حوالي اتنين وستين في المية."),
    ("mixed", "Sure, هبعتلك الـ report على تيليجرام."),
    ("mixed", "الـ service دي واقفة من ساعة، تحب أعملها restart؟"),
    ("en", "Three sessions are live right now."),
    ("eg", "مفيش أي خدمة واقعة دلوقتي."),
    ("mixed", "Okay، الـ mission خلصت step خمسة."),
]
VOICES = ["marin"] * 14 + ["cedar"] * 6


def key():
    raw = subprocess.run(["/usr/local/sbin/joya-helper", "voice-key-read"], check=True, capture_output=True).stdout
    k = json.loads(raw)["data"]["key"]
    if not k:
        raise SystemExit("no OpenAI key is set")
    return k


def tts(k, text, voice, lang):
    body = {"model": "gpt-4o-mini-tts", "voice": voice, "input": text, "response_format": "pcm"}
    if lang != "en":
        body["instructions"] = "Speak natural Egyptian Arabic (Cairene); say the English words in English."
    req = urllib.request.Request("https://api.openai.com/v1/audio/speech", data=json.dumps(body).encode(), headers={"Authorization": "Bearer " + k, "Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=60) as r:
        pcm = np.frombuffer(r.read(), dtype=np.int16).astype(np.float32) / 32768.0
    return resample(pcm, 24000, 16000)


def main():
    os.makedirs(OUT, exist_ok=True)
    k = None
    items = []
    for i, ((lang, text), voice) in enumerate(zip(LINES, VOICES)):
        p = os.path.join(OUT, "echo-%02d-%s.wav" % (i + 1, voice))
        if not os.path.exists(p):
            k = k or key()
            write_wav(p, tts(k, text, voice, lang))
            print("made", os.path.basename(p))
        items.append({"path": p, "set": "echo", "role": "test", "lang": "en" if lang == "en" else ("mixed" if lang == "mixed" else "ar"), "speaker": "tts-" + voice, "source": "gpt-4o-mini-tts", "text": text})
    with open(os.path.join(OUT, "manifest.json"), "w") as f:
        json.dump({"items": items}, f, ensure_ascii=False, indent=0)
    print(len(items), "echo clips")


if __name__ == "__main__":
    main()
