#!/usr/bin/env python3
"""
Build the public part of the trial set: stand-in "users" (to prove the harness
before the administrator records), the impostor pool ("other people") and the
score-normalisation cohort. Writes $HOME/data/public/manifest.json.

Sources (downloaded once by setup.sh, kept under $JOYA_VOICEPRINT_HOME/data):
  LibriSpeech test-clean (openslr.org/12, CC-BY-4.0): 40 English speakers,
      read audiobooks, ~65 utterances each.
  Mozilla Common Voice 17.0 test split, Arabic shards 0-1 and English shard 0
      (CC0-1.0; the Hugging Face parquet mirror fixie-ai/common_voice_17_0 of
      Mozilla's release). Arabic: 641 speakers (72 with >= 10 clips); English:
      863 speakers, one clip each. Common Voice's terms ask users not to try to
      identify its speakers: here they are only anonymous "other voices".

Speakers are split so no one is in two roles:
  standin   EN: 20 LibriSpeech speakers; AR: up to 20 Common Voice speakers
            with >= 14 clips. Enrolment = their first clips up to ~45 s;
            test = up to 15 other clips.
  impostor  EN: the other 20 LibriSpeech speakers (6 clips each) + 200 Common
            Voice EN speakers; AR: 250 Common Voice AR clips from speakers not
            used elsewhere.
  cohort    200 EN + 200 AR Common Voice clips from yet other speakers (for
            AS-norm and as babble noise; never scored).
"""
import collections
import glob
import json
import os
import sys

import numpy as np
import pyarrow.parquet as pq

sys.path.insert(0, os.path.dirname(__file__))
from common import DATA_DIR, decode_bytes, read_audio, speech_seconds, write_wav  # noqa: E402

OUT = os.path.join(DATA_DIR, "public")
LS = os.path.join(DATA_DIR, "LibriSpeech", "test-clean")
CV = os.path.join(DATA_DIR, "cv17")
ENROL_S = 45.0


def libri():
    items = []
    spk = sorted(os.listdir(LS), key=int)
    for i, s in enumerate(spk):
        files = sorted(glob.glob(os.path.join(LS, s, "*", "*.flac")))
        if i % 2 == 0:  # stand-in
            chapters = sorted({os.path.basename(os.path.dirname(f)) for f in files})
            first = [f for f in files if os.path.basename(os.path.dirname(f)) == chapters[0]]
            rest = [f for f in files if f not in first] or first[len(first) // 2:]
            got = 0.0
            enrol = []
            for f in first:
                if got >= ENROL_S:
                    break
                enrol.append(f)
                got += speech_seconds(read_audio(f))
            test = [f for f in rest if f not in enrol][:15]
            items += [{"path": f, "set": "standin", "role": "enrol", "lang": "en", "speaker": "ls-" + s, "source": "librispeech"} for f in enrol]
            items += [{"path": f, "set": "standin", "role": "test", "lang": "en", "speaker": "ls-" + s, "source": "librispeech"} for f in test]
        else:
            items += [{"path": f, "set": "impostor", "role": "test", "lang": "en", "speaker": "ls-" + s, "source": "librispeech"} for f in files[::max(1, len(files) // 6)][:6]]
    return items


def cv_rows(lang):
    rows = []
    for f in sorted(glob.glob(os.path.join(CV, lang, "*.parquet"))):
        t = pq.read_table(f, columns=["client_id", "path", "audio", "sentence"])
        for r in t.to_pylist():
            rows.append(r)
    return rows


def cv_save(r, lang):
    name = os.path.splitext(os.path.basename(r["path"]))[0] + ".wav"
    p = os.path.join(OUT, "cv-" + lang, name)
    if not os.path.exists(p):
        write_wav(p, decode_bytes(r["audio"]["bytes"]))
    return p


def common_voice(lang, rng):
    rows = cv_rows(lang)
    by = collections.defaultdict(list)
    for r in rows:
        by[r["client_id"]].append(r)
    spk = sorted(by, key=lambda s: (-len(by[s]), s))
    items = []
    used = set()
    if lang == "ar":
        stand = [s for s in spk if len(by[s]) >= 14][:20]
        for k, s in enumerate(stand):
            used.add(s)
            clips = by[s]
            got = 0.0
            enrol, test = [], []
            for r in clips:
                p = cv_save(r, lang)
                if got < ENROL_S and len(test) == 0:
                    enrol.append(p)
                    got += speech_seconds(read_audio(p))
                elif len(test) < 15:
                    test.append(p)
            sid = "cv-ar-%02d" % k
            items += [{"path": p, "set": "standin", "role": "enrol", "lang": "ar", "speaker": sid, "source": "commonvoice17"} for p in enrol]
            items += [{"path": p, "set": "standin", "role": "test", "lang": "ar", "speaker": sid, "source": "commonvoice17"} for p in test]
    rest = [s for s in spk if s not in used]
    rng.shuffle(rest)
    n_imp = 250 if lang == "ar" else 200
    imp, coh = rest[:n_imp], rest[n_imp: n_imp + 200]
    for role, group in (("impostor", imp), ("cohort", coh)):
        for k, s in enumerate(group):
            r = by[s][0]
            items.append({"path": cv_save(r, lang), "set": role, "role": "test", "lang": lang, "speaker": "cv-%s-%s-%03d" % (lang, role[:3], k), "source": "commonvoice17"})
    return items


def main():
    rng = np.random.default_rng(7)
    os.makedirs(OUT, exist_ok=True)
    items = libri() + common_voice("ar", rng) + common_voice("en", rng)
    for it in items:
        x = read_audio(it["path"])
        it["seconds"] = round(len(x) / 16000, 2)
        it["speech_seconds"] = round(speech_seconds(x), 2)
    with open(os.path.join(OUT, "manifest.json"), "w") as f:
        json.dump({"items": items}, f, indent=0)
    c = collections.Counter((i["set"], i["lang"], i["role"]) for i in items)
    for k in sorted(c):
        print(k, c[k])
    print("speakers:", len({i["speaker"] for i in items}))


if __name__ == "__main__":
    main()
