#!/usr/bin/env python3
"""
The voiceprint trial's offline evaluation: which speaker-embedding model, how
accurate on the enrolled user's voice, how fast on this CPU, what threshold.

    PY=/root/.local/joya-voiceprint/venv/bin/python
    # 1. prove the harness on public speakers standing in for the user
    $PY tools/voiceprint/evaluate.py --standin
    # 2. the administrator's own recordings (from /joya-ai/voiceprint-trial)
    sudo $PY tools/voiceprint/evaluate.py --user /var/lib/joya-dashboard/voiceprint-trial/<username>

Options: --models ecapa,wsp-r34,... (default all four)  --out DIR  --jobs N
         --no-bench (skip the latency/RAM benchmark)
Writes DIR/report.md and DIR/results.json (default $HOME/results/<mode>-<time>,
mode 0700). Scores and summaries only: no audio is copied out.

The trials
  enrol     the user's enrolment clips, cut into ~4 s windows; the voiceprint
            is the mean of the windows' embeddings. User mode: one voiceprint
            per microphone and one pooled from all microphones.
  genuine   the user's test phrases, VAD-trimmed ("full"), plus variants:
            first 0.8 / 1.2 / 2.0 s of speech (what a streaming check on the
            start of a press would see), and babble noise at 10 and 5 dB SNR
            (people talking / a TV in the room). Stand-in mode adds a
            simulated other microphone and room ("sim-other") as cross-mic.
  impostor  public speakers, EN + AR (Common Voice 17, LibriSpeech), full and
            cropped; "tv": public speech played through a simulated loudspeaker
            into the room; "echo": JOYA AI's own TTS voice (marin, cedar), raw
            and through the simulated loudspeaker. Stand-in mode adds the
            other stand-ins' clips.
  cohort    400 more public clips, never scored: AS-norm (top 100) and babble.

Scores: cosine ("raw") and adaptive symmetric score normalisation ("asnorm").
Metrics: EER; FAR at FRR 2 % and 5 %; FRR at FAR 1 %; broken down by
language, microphone (same / cross / pooled), length and impostor type.
"""
import argparse
import collections
import datetime
import hashlib
import json
import os
import pickle
import subprocess
import sys
import time
from concurrent.futures import ProcessPoolExecutor

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import common  # noqa: E402
from common import CACHE_DIR, DATA_DIR, HOME, load_json, read_audio, speech_seconds, trim  # noqa: E402

CROPS = (0.8, 1.2, 2.0)
OPS_VARIANTS = ("full", "first1.2", "first2.0", "babble10", "sim-other")
ENROL_WIN = 4.0
COHORT_TOP = 100


# ----------------------------------------------------------------- items ----

def item(path, group, lang, speaker, **kw):
    d = {"path": path, "group": group, "lang": lang, "speaker": speaker}
    d.update(kw)
    return d


def public_items():
    man = load_json(os.path.join(DATA_DIR, "public", "manifest.json"), {"items": []})["items"]
    echo = load_json(os.path.join(DATA_DIR, "echo", "manifest.json"), {"items": []})["items"]
    if not man:
        raise SystemExit("no public set: run tools/voiceprint/prep_public.py first")
    return man, echo


def user_items(udir):
    """The page's recordings: <udir>/<mic>/<id>.wav, described by <udir>/manifest.json."""
    man = load_json(os.path.join(udir, "manifest.json"), {}) or {}
    clips = []
    for c in man.get("clips", []):
        p = os.path.join(udir, c["mic"], c["id"] + ".wav")
        if os.path.exists(p):
            clips.append(dict(c, path=p))
    if not clips:  # no manifest: guess from the file names (e*.wav enrolment, t*.wav tests)
        for mic in sorted(os.listdir(udir)):
            d = os.path.join(udir, mic)
            if os.path.isdir(d):
                for f in sorted(os.listdir(d)):
                    if f.endswith(".wav"):
                        clips.append({"mic": mic, "id": f[:-4], "part": "enrol" if f.startswith("e") else "test", "lang": "?", "path": os.path.join(d, f)})
    return clips


# ------------------------------------------------------------- variants ----

def rng_for(path, variant):
    return np.random.default_rng(int(hashlib.sha1((path + "|" + variant).encode()).hexdigest()[:12], 16))


_BABBLE = None


def babble():
    """~40 s of 5 overlapping talkers from the cohort: the 'room / TV' noise."""
    global _BABBLE
    if _BABBLE is None:
        man = load_json(os.path.join(DATA_DIR, "public", "manifest.json"))["items"]
        coh = [i["path"] for i in man if i["set"] == "cohort"]
        streams = []
        for s in range(5):
            x = np.concatenate([trim(read_audio(p)) for p in coh[s::5][:12]])
            streams.append(x[: 16000 * 40])
        n = min(len(s) for s in streams)
        _BABBLE = np.sum([s[:n] / (common.rms(s[:n]) + 1e-9) for s in streams], axis=0).astype(np.float32)
    return _BABBLE


def variant_audio(path, variant):
    x = trim(read_audio(path))
    if variant == "full":
        return x
    if variant.startswith("first"):
        sec = float(variant[5:])
        m, n = common.speech_mask(x)
        idx = np.flatnonzero(m)
        if not len(idx):
            return None
        # from the first speech frame, `sec` seconds of SPEECH frames (pauses kept)
        cum = np.cumsum(m[idx[0]:])
        k = np.searchsorted(cum, int(sec * 16000 / n))
        if k >= len(cum):
            return None
        return x[idx[0] * n: (idx[0] + k + 1) * n]
    if variant.startswith("babble"):
        return common.mix(x, babble(), float(variant[6:]), rng_for(path, variant))
    if variant == "speaker":
        return common.laptop_speaker(x, rng_for(path, variant))
    if variant == "sim-other":
        return common.other_channel(x, rng_for(path, variant))
    raise ValueError(variant)


def enrol_windows(path):
    x = trim(read_audio(path))
    w = int(ENROL_WIN * 16000)
    if len(x) < w * 1.5:
        return [x]
    return [x[i: i + w] for i in range(0, len(x) - w // 2, w)]


# ------------------------------------------------------------ embedding ----

def _embed_worker(args):
    name, threads, jobs = args
    import models

    cache_path = os.path.join(CACHE_DIR, name + ".pkl")
    try:
        with open(cache_path, "rb") as f:
            cache = pickle.load(f)
    except (OSError, EOFError, pickle.UnpicklingError):
        cache = {}
    m = None
    out = {}
    new = 0
    for key, path, variant in jobs:
        ck = common.file_key(path, variant)
        if ck in cache:
            out[key] = cache[ck]
            continue
        if m is None:
            m = models.get(name, threads).load()
        if variant.startswith("enrol"):
            wins = enrol_windows(path)
            v = np.mean([m.embed(w) for w in wins], axis=0) * len(wins)  # summed; normalised by the caller
            val = (v.astype(np.float32), len(wins))
        else:
            x = variant_audio(path, variant)
            val = None if x is None or len(x) < 1600 else m.embed(x)
        out[key] = val
        if path.startswith(DATA_DIR + os.sep):  # public data only: the user's voice is never cached on disk
            cache[ck] = val
            new += 1
        if new % 500 == 0:
            _save(cache_path, cache)
    if new:
        _save(cache_path, cache)
    return name, out


def _save(p, cache):
    os.makedirs(os.path.dirname(p), mode=0o700, exist_ok=True)
    tmp = p + ".tmp"
    with open(os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600), "wb") as f:
        pickle.dump(cache, f)
    os.replace(tmp, p)


def embed_all(model_names, jobs, workers):
    """jobs: [(key, path, variant)] -> {model: {key: vec}} -- one process per model."""
    threads = max(1, (os.cpu_count() or 4) // max(1, min(workers, len(model_names))))
    res = {}
    with ProcessPoolExecutor(max_workers=min(workers, len(model_names))) as ex:
        for name, out in ex.map(_embed_worker, [(n, threads, jobs) for n in model_names]):
            res[name] = out
    return res


# -------------------------------------------------------------- metrics ----

def metrics(gen, imp):
    g = np.sort(np.asarray(gen, dtype=np.float64))
    i = np.sort(np.asarray(imp, dtype=np.float64))
    if len(g) == 0 or len(i) == 0:
        return None
    thr = np.unique(np.concatenate([g, i]))
    frr = np.searchsorted(g, thr, side="left") / len(g)  # genuine below thr
    far = 1 - np.searchsorted(i, thr, side="left") / len(i)  # impostor >= thr
    k = int(np.argmin(np.abs(frr - far)))
    eer = float((frr[k] + far[k]) / 2)

    def far_at_frr(p):
        t = np.quantile(g, p)
        return float(np.mean(i >= t)), float(t)

    t1 = float(np.quantile(i, 0.99))
    return {
        "n_gen": int(len(g)), "n_imp": int(len(i)),
        "eer": eer, "eer_thr": float(thr[k]),
        "far_at_frr2": far_at_frr(0.02)[0], "thr_frr2": far_at_frr(0.02)[1],
        "far_at_frr5": far_at_frr(0.05)[0], "thr_frr5": far_at_frr(0.05)[1],
        "frr_at_far1": float(np.mean(g < t1)), "thr_far1": t1,
        "gen_mean": float(g.mean()), "imp_mean": float(i.mean()), "imp_max": float(i.max()), "gen_min": float(g.min()),
    }


def asnorm(score, e_coh, t_coh):
    """Adaptive symmetric normalisation with the top-k cohort scores of each side."""
    return 0.5 * ((score - e_coh[0]) / e_coh[1] + (score - t_coh[0]) / t_coh[1])


def coh_stats(v, C):
    s = np.sort(C @ v)[-COHORT_TOP:]
    return float(s.mean()), float(s.std() + 1e-6)


# ------------------------------------------------------------- the plan ----

def plan(mode, udir):
    """-> enrolments {eid: {speaker, mic, clips:[paths]}}, tests [dict], cohort [paths]."""
    man, echo = public_items()
    cohort = [i["path"] for i in man if i["set"] == "cohort"]
    tests = []
    enrols = {}

    def add_test(path, group, lang, speaker, mic, variants, **kw):
        for v in variants:
            tests.append(dict(item(path, group, lang, speaker, mic=mic, variant=v, **kw)))

    imp_variants = ["full"] + ["first%.1f" % c for c in CROPS]
    for it in man:
        if it["set"] == "impostor":
            add_test(it["path"], "public-" + it["lang"], it["lang"], it["speaker"], "public", imp_variants)
    # far-field: public speech played into the room by a loudspeaker (a TV)
    for it in [i for i in man if i["set"] == "impostor"][::4]:
        add_test(it["path"], "tv", it["lang"], it["speaker"], "public", ["speaker"])
    for it in echo:
        add_test(it["path"], "echo", it["lang"], it["speaker"], "tts", ["full", "speaker"], text=it.get("text"))

    gen_variants = ["full"] + ["first%.1f" % c for c in CROPS] + ["babble10", "babble5"]
    if mode == "standin":
        by = collections.defaultdict(list)
        for it in man:
            if it["set"] == "standin":
                by[it["speaker"]].append(it)
        for spk, its in sorted(by.items()):
            enrols[spk] = {"speaker": spk, "mic": "clean", "clips": [i["path"] for i in its if i["role"] == "enrol"], "lang": its[0]["lang"]}
            for i in its:
                if i["role"] == "test":
                    add_test(i["path"], "standin", i["lang"], spk, "clean", gen_variants)
                    add_test(i["path"], "standin", i["lang"], spk, "sim-other", ["sim-other"])
    else:
        clips = user_items(udir)
        mics = sorted({c["mic"] for c in clips})
        for mic in mics:
            e = [c["path"] for c in clips if c["mic"] == mic and c.get("part") == "enrol"]
            if e:
                enrols["user@" + mic] = {"speaker": "user", "mic": mic, "clips": e}
        allen = [c["path"] for c in clips if c.get("part") == "enrol"]
        if len([m for m in mics if "user@" + m in enrols]) > 1:
            enrols["user@pooled"] = {"speaker": "user", "mic": "pooled", "clips": allen}
        for c in clips:
            if c.get("part") == "test":
                add_test(c["path"], "user", c.get("lang", "?"), "user", c["mic"], gen_variants, phrase=c["id"], text=c.get("text"), kind=c.get("kind"))
        # the public stand-ins are just more "other people" here
        for it in man:
            if it["set"] == "standin" and it["role"] == "test":
                add_test(it["path"], "public-" + it["lang"], it["lang"], it["speaker"], "public", imp_variants)
    return enrols, tests, cohort


def speech_len(path, variant, cache):
    k = (path, variant)
    if k not in cache:
        x = variant_audio(path, variant) if variant != "full" else trim(read_audio(path))
        cache[k] = None if x is None else speech_seconds(x)
    return cache[k]


def bucket(sec):
    if sec is None:
        return None
    return "<1 s" if sec < 1 else "1-2 s" if sec <= 2 else ">2 s"


# ------------------------------------------------------------- scoring -----

def score_model(name, emb, enrols, tests, cohort):
    C = np.stack([emb[("coh", p)] for p in cohort if emb.get(("coh", p)) is not None])
    E = {}
    for eid, e in enrols.items():
        vs = [emb[("enr", p)] for p in e["clips"] if emb.get(("enr", p)) is not None]
        tot = np.sum([v for v, n in vs], axis=0) / sum(n for v, n in vs)
        tot = tot / np.linalg.norm(tot)
        E[eid] = (tot, coh_stats(tot, C))
    rows = []
    tstats = {}
    for t in tests:
        v = emb.get(("tst", t["path"], t["variant"]))
        if v is None:
            continue
        tk = (t["path"], t["variant"])
        if tk not in tstats:
            tstats[tk] = coh_stats(v, C)
        for eid, (ev, es) in E.items():
            e = enrols[eid]
            genuine = t["speaker"] == e["speaker"]
            if t["group"] == "standin" and not genuine:
                group = "other-standin"
                if t["variant"] not in ("full",):
                    continue
            else:
                group = t["group"]
            s = float(ev @ v)
            rows.append({"enrol": eid, "enrol_mic": e["mic"], "genuine": genuine, "group": group, "lang": t["lang"], "mic": t["mic"], "variant": t["variant"], "path": t["path"], "phrase": t.get("phrase"), "kind": t.get("kind"), "raw": s, "asnorm": asnorm(s, es, tstats[tk])})
    return rows


def mic_rel(r):
    if r["enrol_mic"] == "pooled":
        return "pooled"
    if r["mic"] in ("public", "tts"):
        return None
    if r["enrol_mic"] == "clean":
        return "same" if r["mic"] == "clean" else "cross (simulated)"
    return "same" if r["mic"] == r["enrol_mic"] else "cross"


def breakdown(rows, lens, mode):
    """The tables, for one model and one score kind (rows carry r['s'])."""
    out = {}
    base_enrol = "pooled" if any(r["enrol_mic"] == "pooled" for r in rows) else None

    def sel(f):
        return [r for r in rows if f(r)]

    def m(gen, imp):
        return metrics([r["s"] for r in gen], [r["s"] for r in imp])

    def enrol_ok(r):
        return base_enrol is None or r["enrol_mic"] == base_enrol

    imp_full = sel(lambda r: not r["genuine"] and r["variant"] == "full" and r["group"] != "echo" and enrol_ok(r))
    gen_full_same = sel(lambda r: r["genuine"] and r["variant"] == "full" and enrol_ok(r) and mic_rel(r) in ("same", "pooled"))
    out["overall"] = m(gen_full_same, imp_full)

    # language (genuine side; all impostors)
    out["by_language"] = {lg: m(sel(lambda r, lg=lg: r is not None and r["genuine"] and r["variant"] == "full" and enrol_ok(r) and mic_rel(r) in ("same", "pooled") and r["lang"] == lg), imp_full) for lg in sorted({r["lang"] for r in gen_full_same})}
    # impostor language
    out["by_impostor_language"] = {lg: m(gen_full_same, [r for r in imp_full if r["lang"] == lg]) for lg in sorted({r["lang"] for r in imp_full})}
    # microphone
    mics = {}
    for rel in ("same", "cross", "cross (simulated)", "pooled"):
        g = sel(lambda r, rel=rel: r["genuine"] and r["variant"] in ("full", "sim-other") and mic_rel(r) == rel)
        if g:
            enr = {r["enrol"] for r in g}
            mics[rel] = m(g, [r for r in rows if not r["genuine"] and r["variant"] == "full" and r["group"] != "echo" and r["enrol"] in enr])
    out["by_mic"] = mics
    if mode == "user":
        out["by_enrolment"] = {e: m(sel(lambda r, e=e: r["genuine"] and r["variant"] == "full" and r["enrol"] == e), sel(lambda r, e=e: not r["genuine"] and r["variant"] == "full" and r["group"] != "echo" and r["enrol"] == e)) for e in sorted({r["enrol"] for r in rows})}
    # natural length (speech seconds of the full clip, both sides)
    nat = {}
    for b in ("<1 s", "1-2 s", ">2 s"):
        g = [r for r in gen_full_same if bucket(lens.get((r["path"], "full"))) == b]
        i = [r for r in imp_full if bucket(lens.get((r["path"], "full"))) == b]
        nat[b] = m(g, i)
    out["by_length"] = nat
    # streaming: the first N s of speech, both sides cropped alike
    crops = {}
    for c in CROPS:
        v = "first%.1f" % c
        crops["first %.1f s" % c] = m(sel(lambda r, v=v: r["genuine"] and r["variant"] == v and enrol_ok(r) and mic_rel(r) in ("same", "pooled")), sel(lambda r, v=v: not r["genuine"] and r["variant"] == v and enrol_ok(r) and r["group"].startswith("public")))
    out["by_crop"] = crops
    out["_thr"] = out["overall"]["thr_far1"] if out["overall"] else None
    # the operating point: every impostor trial (public full + crops, TV, echo) against the
    # realistic genuine mix (full, first 1.2 / 2.0 s, babble at 10 dB, same and cross mic)
    imp_all = np.array([r["s"] for r in rows if not r["genuine"] and enrol_ok(r)])
    gen_ops = np.array([r["s"] for r in rows if r["genuine"] and enrol_ok(r) and r["variant"] in OPS_VARIANTS and mic_rel(r) is not None])
    if len(imp_all) and len(gen_ops):
        t_acc = float(np.quantile(imp_all, 0.99))
        t_rej = float(np.quantile(gen_ops, 0.02))
        lo, hi = min(t_rej, t_acc), t_acc
        out["operating"] = {
            "n_gen": int(len(gen_ops)), "n_imp": int(len(imp_all)),
            "accept_at": t_acc, "reject_below": lo, "band": t_rej < t_acc,
            "frr": float(np.mean(gen_ops < t_acc)),
            "gen_in_band": float(np.mean((gen_ops >= lo) & (gen_ops < hi))),
            "gen_rejected": float(np.mean(gen_ops < lo)),
            "imp_in_band": float(np.mean((imp_all >= lo) & (imp_all < hi))),
            "far": float(np.mean(imp_all >= t_acc)),
            "eer": metrics(gen_ops, imp_all)["eer"],
        }
    else:
        out["operating"] = None
    return out


def at_threshold(rows, thr, base_enrol):
    """FAR per impostor type and FRR per noise condition at one threshold."""
    def ok(r):
        return base_enrol is None or r["enrol_mic"] == base_enrol
    res = {"far": {}, "frr": {}}
    groups = collections.defaultdict(list)
    for r in rows:
        if not r["genuine"] and ok(r):
            groups[(r["group"], r["variant"])].append(r["s"])
    for (g, v), s in sorted(groups.items()):
        res["far"]["%s / %s" % (g, v)] = (float(np.mean(np.asarray(s) >= thr)), len(s), float(np.max(s)))
    gv = collections.defaultdict(list)
    for r in rows:
        if r["genuine"] and ok(r):
            gv[(r["variant"], mic_rel(r))].append(r["s"])
    for (v, rel), s in sorted(gv.items(), key=lambda kv: (str(kv[0][1]), kv[0][0])):
        res["frr"]["%s / %s" % (v, rel)] = (float(np.mean(np.asarray(s) < thr)), len(s), float(np.min(s)))
    return res


# ------------------------------------------------------------ benchmark ----

BENCH = r"""
import json, os, sys, time, resource
sys.path.insert(0, %(dir)r)
import numpy as np, psutil
p = psutil.Process()
rss0 = p.memory_info().rss
import models
from common import read_audio, trim
t0 = time.perf_counter(); m = models.get(%(name)r, %(threads)d).load(); load = time.perf_counter() - t0
rss1 = p.memory_info().rss
x = trim(read_audio(%(wav)r))
while len(x) < 16000 * 6: x = np.concatenate([x, x])
out = {"load_s": load, "rss_model_mb": (rss1 - rss0) / 1e6, "size_mb": m.size_mb(), "ms": {}}
m.embed(x[:16000]); m.embed(x[:16000 * 3])
for sec in (1.0, 1.5, 3.0, 6.0):
    seg = x[: int(16000 * sec)]
    ts = []
    for _ in range(7):
        t = time.perf_counter(); m.embed(seg); ts.append(time.perf_counter() - t)
    out["ms"][str(sec)] = 1000 * float(np.median(ts))
out["rss_peak_mb"] = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1e3
print(json.dumps(out))
"""


def bench(name, threads, wav):
    code = BENCH % {"dir": os.path.dirname(os.path.abspath(__file__)), "name": name, "threads": threads, "wav": wav}
    r = subprocess.run([sys.executable, "-c", code], capture_output=True, text=True, timeout=600)
    try:
        return json.loads(r.stdout.strip().splitlines()[-1])
    except (IndexError, ValueError):
        return {"error": (r.stderr or "")[-400:]}


# --------------------------------------------------------------- report ----

def pct(x):
    return "—" if x is None else "%.1f %%" % (100 * x)


def mrow(label, mm, sk):
    if not mm:
        return "| %s | — | — | — | — | — | — |" % label
    return "| %s | %d / %d | %s | %s | %s | %s | %.3f |" % (label, mm["n_gen"], mm["n_imp"], pct(mm["eer"]), pct(mm["far_at_frr2"]), pct(mm["far_at_frr5"]), pct(mm["frr_at_far1"]), mm["thr_far1"])


HEAD = "| | genuine / impostor trials | EER | FAR @ FRR 2 % | FAR @ FRR 5 % | FRR @ FAR 1 % | threshold @ FAR 1 % |\n|---|---|---|---|---|---|---|"


def recommend(summary):
    """The model and score kind with the lowest FRR at the operating point (FAR 1 % over every
    impostor type; half a point counts as a tie), then the fastest, then the lowest EER;
    with its ask-to-repeat band."""
    best = None
    for name, kinds in summary["models"].items():
        for sk, b in kinds.items():
            o = b["tables"].get("operating")
            if not o:
                continue
            # within half a point of FRR counts as a tie: then the faster model wins
            key = (round(o["frr"] / 0.005), summary["bench"].get(name, {}).get("ms", {}).get("1.5", 1e9), round(o["eer"], 3))
            if best is None or key < best[0]:
                best = (key, name, sk)
    if not best:
        return None
    _, name, sk = best
    b = summary["models"][name][sk]
    o = b["tables"]["operating"]
    minlen = None
    for c in CROPS:  # the shortest crop with FRR <= 10 % at its own FAR 1 % threshold
        mm = b["tables"]["by_crop"].get("first %.1f s" % c)
        if mm and mm["frr_at_far1"] <= 0.10:
            minlen = c
            break
    return dict(o, model=name, score=sk, min_seconds=minlen)


def write_report(summary, out):
    L = []
    L.append("# Voiceprint trial — %s" % ("public stand-ins (harness validation)" if summary["mode"] == "standin" else "the enrolled user's own recordings"))
    L.append("")
    L.append("Run %s on this VPS (%d CPU cores, no GPU). Everything local; no audio left the box." % (summary["at"], os.cpu_count() or 0))
    L.append("")
    L.append("Trials: %s" % summary["counts"])
    L.append("")
    rec = summary.get("recommendation")
    if rec:
        L.append("## Recommendation")
        L.append("")
        L.append("- Model: **%s**, score **%s**." % (rec["model"], rec["score"]))
        L.append("- Accept when score ≥ **%.3f**: FAR %s over all %d impostor trials (other people EN/AR full and cropped, TV, JOYA AI's own voice); the user's realistic phrases (full, first 1.2 / 2.0 s, babble 10 dB, other mic; %d trials) fall below it %s of the time." % (rec["accept_at"], pct(rec["far"]), rec["n_imp"], rec["n_gen"], pct(rec["frr"])))
        if rec["band"]:
            L.append("- Ask to repeat between **%.3f** and %.3f (%s of the user's phrases, %s of impostor trials land there); ignore below %.3f (%s of the user's phrases)." % (rec["reject_below"], rec["accept_at"], pct(rec["gen_in_band"]), pct(rec["imp_in_band"]), rec["reject_below"], pct(rec["gen_rejected"])))
        else:
            L.append("- No ask-to-repeat band is needed: the user's 2nd-percentile score is above the accept threshold.")
        L.append("- EER at that operating mix: %s." % pct(rec["eer"]))
        L.append("- Minimum speech to verify on (streaming crops, FRR ≤ 10 %% at FAR 1 %%): %s." % ("%.1f s" % rec["min_seconds"] if rec["min_seconds"] else "none of 0.8 / 1.2 / 2.0 s met it — verify on the whole press"))
        L.append("")
    L.append("## Speed and memory (CPU)")
    L.append("")
    L.append("| model | licence | size | load | RAM (process) | 1 s audio | 1.5 s | 3 s | 6 s | 1.5 s on 1 thread |")
    L.append("|---|---|---|---|---|---|---|---|---|---|")
    import models
    for name, bm in summary["bench"].items():
        if "error" in bm:
            L.append("| %s | %s | — | error | | | | | | |" % (name, models.MODELS[name]["licence"]))
            continue
        one = bm.get("ms_1thread", {}).get("1.5")
        L.append("| %s | %s | %.0f MB | %.2f s | %.0f MB | %.0f ms | %.0f ms | %.0f ms | %.0f ms | %s |" % (name, models.MODELS[name]["licence"], bm["size_mb"], bm["load_s"], bm["rss_model_mb"], bm["ms"]["1.0"], bm["ms"]["1.5"], bm["ms"]["3.0"], bm["ms"]["6.0"], "%.0f ms" % one if one else "—"))
    L.append("")
    L.append("Latency: median of 7, 4 threads unless stated, VAD-trimmed speech. RAM: the process after loading (Python + the runtime + the model).")
    L.append("")
    for name, kinds in summary["models"].items():
        for sk, b in kinds.items():
            t = b["tables"]
            L.append("## %s — %s scores" % (name, sk))
            L.append("")
            L.append(HEAD)
            L.append(mrow("**overall** (full phrases, same mic / pooled)", t["overall"], sk))
            o = t.get("operating")
            if o:
                L.append("| operating mix (all impostors; full, crops, babble 10, cross mic) | %d / %d | %s | | | %s | %.3f |" % (o["n_gen"], o["n_imp"], pct(o["eer"]), pct(o["frr"]), o["accept_at"]))
            for k, mm in t["by_language"].items():
                L.append(mrow("user language: %s" % k, mm, sk))
            for k, mm in t["by_impostor_language"].items():
                L.append(mrow("impostor language: %s" % k, mm, sk))
            for k, mm in t["by_mic"].items():
                L.append(mrow("mic: %s" % k, mm, sk))
            for k, mm in t.get("by_enrolment", {}).items():
                L.append(mrow("enrolled on: %s" % k, mm, sk))
            for k, mm in t["by_length"].items():
                L.append(mrow("length %s (natural)" % k, mm, sk))
            for k, mm in t["by_crop"].items():
                L.append(mrow("streaming: %s" % k, mm, sk))
            L.append("")
            at = b["at_threshold"]
            L.append("At the FAR 1 %% threshold (%.3f):" % b["tables"]["_thr"] if b["tables"]["_thr"] is not None else "")
            L.append("")
            L.append("| condition | rate | trials | worst score |")
            L.append("|---|---|---|---|")
            for k, (r, n, w) in at["far"].items():
                L.append("| FAR %s | %s | %d | %.3f |" % (k, pct(r), n, w))
            for k, (r, n, w) in at["frr"].items():
                L.append("| FRR %s | %s | %d | %.3f |" % (k, pct(r), n, w))
            L.append("")
    if summary.get("worst"):
        L.append("## The user's lowest-scoring phrases (best model)")
        L.append("")
        for w in summary["worst"]:
            L.append("- %s (said on %s, %s, %s) against the %s voiceprint: %.3f" % (w["phrase"], w["mic"], w["lang"], w["variant"], w["enrol"].split("@")[-1], w["s"]))
        L.append("")
    with open(os.path.join(out, "report.md"), "w") as f:
        f.write("\n".join(L) + "\n")


# ----------------------------------------------------------------- main ----

def main():
    ap = argparse.ArgumentParser()
    g = ap.add_mutually_exclusive_group(required=True)
    g.add_argument("--standin", action="store_true")
    g.add_argument("--user")
    ap.add_argument("--models", default=",".join(__import__("models").DEFAULT_MODELS))
    ap.add_argument("--out")
    ap.add_argument("--jobs", type=int, default=4)
    ap.add_argument("--no-bench", action="store_true")
    a = ap.parse_args()
    mode = "standin" if a.standin else "user"
    names = [n for n in a.models.split(",") if n]
    stamp = datetime.datetime.now().strftime("%Y%m%d-%H%M%S")
    out = a.out or os.path.join(HOME, "results", "%s-%s" % (mode, stamp))
    os.makedirs(out, mode=0o700, exist_ok=True)

    t0 = time.time()
    enrols, tests, cohort = plan(mode, a.user)
    if mode == "user" and not enrols:
        raise SystemExit("no enrolment recordings in %s" % a.user)
    jobs = [(("coh", p), p, "full") for p in cohort]
    jobs += [(("enr", p), p, "enrol%.0f" % ENROL_WIN) for e in enrols.values() for p in e["clips"]]
    seen = set()
    for t in tests:
        k = ("tst", t["path"], t["variant"])
        if k not in seen:
            seen.add(k)
            jobs.append((k, t["path"], t["variant"]))
    jobs = list({j[0]: j for j in jobs}.values())
    print("%d enrolments, %d test items, %d embeddings per model" % (len(enrols), len(tests), len(jobs)), flush=True)
    emb = embed_all(names, jobs, a.jobs)
    print("embedded in %.0f s" % (time.time() - t0), flush=True)

    lens = {}
    for t in tests:
        if t["variant"] == "full":
            speech_len(t["path"], "full", lens)

    summary = {"mode": mode, "at": stamp, "models": {}, "bench": {}, "counts": "%d voiceprints, %d test items (%d genuine), %d cohort" % (len(enrols), len(tests), sum(1 for t in tests if t["group"] in ("standin", "user")), len(cohort))}
    best_rows = None
    for name in names:
        rows = score_model(name, emb[name], enrols, tests, cohort)
        summary["models"][name] = {}
        for sk in ("raw", "asnorm"):
            for r in rows:
                r["s"] = r[sk]
            tables = breakdown(rows, lens, mode)
            base = "pooled" if any(r["enrol_mic"] == "pooled" for r in rows) else None
            at = at_threshold(rows, tables["_thr"], base) if tables["_thr"] is not None else {"far": {}, "frr": {}}
            summary["models"][name][sk] = {"tables": tables, "at_threshold": at}
        rows_by = rows
        if best_rows is None:
            best_rows = {}
        best_rows[name] = rows_by

    if not a.no_bench:
        wav = next(t["path"] for t in tests if t["group"] in ("standin", "user"))
        for name in names:
            bm = bench(name, 4, wav)
            bm["threads"] = 4
            b1 = bench(name, 1, wav)
            if "ms" in b1:
                bm["ms_1thread"] = b1["ms"]
            summary["bench"][name] = bm
            print("bench", name, json.dumps(bm)[:200], flush=True)

    rec = recommend(summary)
    summary["recommendation"] = rec
    if rec and mode == "user":
        rows = best_rows[rec["model"]]
        for r in rows:
            r["s"] = r[rec["score"]]
        g = sorted([r for r in rows if r["genuine"] and r["variant"] == "full"], key=lambda r: r["s"])[:10]
        summary["worst"] = [{k: r[k] for k in ("phrase", "mic", "lang", "variant", "s", "enrol")} for r in g]
    with open(os.path.join(out, "results.json"), "w") as f:
        json.dump(summary, f, indent=1, default=float)
    write_report(summary, out)
    print("report:", os.path.join(out, "report.md"))
    print("took %.0f s" % (time.time() - t0))


if __name__ == "__main__":
    main()
