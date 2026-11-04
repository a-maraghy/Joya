#!/usr/bin/env node
"use strict";
/**
 * Look and speak: "does it catch me speaking?" -- before / after (2026-10-22, "improve lip movement reading to know
 * when I'm speaking, because it does not always catch it right").
 *
 *     node dashboard/tools/bench-look-speak.cjs [--old <git ref>] [--n 6] [--json out.json] [--proc 30]
 *
 * Runs the speech gate of two versions of public/joya-presence-logic.js -- this checkout ("new") and the one at
 * --old (default main's 42fff63, the 0.1.13 page: jawOpen range, a plain level, 5 / 2 fps) -- over the same
 * synthetic scenes (tools/look-speak-scenes.cjs): the person looks at the bot and
 *   speaks: recorded EN + AR clips (LOOK_FIXTURES) and a synthetic voice, soft / normal / loud, with a small /
 *           normal / big mouth, on mains and on battery, alone, over typing, over a TV;
 *   does not: typing (normal, fast), music, a TV voice with their mouth still / smiling / hanging open / chewing,
 *           chewing with the mouth open while typing, turning to the TV, a fan.
 * Reported: detection (a turn started while they spoke, and within 1 s), onset latency (median, 90th percentile),
 * false starts (turns nobody asked for) per scene and per minute, frames a second.
 * --proc: the worker's ms per frame (measured in Chromium with the real model: see the report).
 */
const path = require("path");
const fs = require("fs");
const os = require("os");
const { execFileSync } = require("child_process");
const S = require("./look-speak-scenes.cjs");

const args = process.argv.slice(2);
const arg = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const ROOT = path.join(__dirname, "..");
const OLD = arg("--old", "42fff63"), N = +arg("--n", 6), PROC = +arg("--proc", 30);

function oldLogic() {
  const src = execFileSync("git", ["show", OLD + ":dashboard/public/joya-presence-logic.js"], { cwd: ROOT }).toString();
  const f = path.join(os.tmpdir(), "joya-presence-logic-" + OLD.replace(/\W/g, "") + ".cjs");
  fs.writeFileSync(f, src);
  return require(f);
}
const NEW = require(path.join(ROOT, "public", "joya-presence-logic.js"));
const IMPL = {
  before: (battery) => { const L = oldLogic(); return { L, fps: () => (battery ? 2 : 5), meter: S.levelMeter, procMs: PROC }; },
  after: (battery) => ({ L: NEW, fps: (s) => NEW.rate({ on: true, battery, state: s ? s.state : null, facing: !!(s && (s.facingNow || s.atBot)) }).fps, meter: (x, sr) => NEW.vadFrame(x, sr), procMs: PROC }),
};

const C = S.clips(N);
const voices = [].concat(C.en.map((c) => ({ ...c })), C.ar.map((c) => ({ ...c })), [{ id: "synth1", lang: "synthetic", pcm: S.synthVoice(21, 3.5) }, { id: "synth2", lang: "synthetic", pcm: S.synthVoice(22, 3.5) }]);
const LEVELS = { soft: 0.012, normal: 0.04, loud: 0.1 };
const ARTICS = ["tiny", "small", "normal", "big"];
const SPEAK = ["speak", "speak-over-typing", "speak-over-tv", "speak-over-loud-tv"];
const MODELS = { clean: { jit: 1, outliers: 0 }, noisy: { jit: 2, outliers: 0.05 } };
const NON = ["typing", "typing-fast", "music", "tv", "tv-smile", "tv-open", "tv-chew", "tv-chew-open", "chew-open-typing", "tv-nod", "tv-headturn", "cough", "fan"];

function pct(a, p) { if (!a.length) return null; const s = a.slice().sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(s.length * p))]; }
function runAll(which) {
  const out = { speech: [], non: [] };
  [false, true].forEach((battery) => Object.keys(MODELS).forEach((model) => {
    const impl = IMPL[which](battery), mo = MODELS[model];
    let seed = 1;
    voices.forEach((v, vi) => {
      Object.keys(LEVELS).forEach((lv) => ARTICS.forEach((ar) => SPEAK.forEach((kind) => {
        if (kind !== "speak" && lv !== "normal") return; // the noisy rooms at a normal voice
        const other = voices[(vi + 3) % voices.length].pcm;
        const sc = S.scene(kind, { clip: v.pcm, artic: ar, level: LEVELS[lv], seed: seed++, sec: 8, other, jit: mo.jit, outliers: mo.outliers }, NEW);
        const r = S.simulate(sc, { ...impl, seed });
        const sp = sc.speech[0];
        const early = r.starts.filter((t) => t < sp.onMs - 300);
        const hit = r.starts.find((t) => t >= sp.onMs - 300 && t <= sp.offMs);
        out.speech.push({ battery, model, kind, lang: v.lang, level: lv, artic: ar, detected: hit != null, latency: hit != null ? hit - sp.onMs : null, early: early.length, fps: r.fps });
      })));
    });
    NON.forEach((kind) => {
      for (let k = 0; k < 6; k++) {
        const sc = S.scene(kind, { seed: 100 + k, sec: 10, other: voices[k % voices.length].pcm, jit: mo.jit, outliers: mo.outliers }, NEW);
        const r = S.simulate(sc, { ...impl, seed: 100 + k });
        out.non.push({ battery, model, kind, starts: r.starts.length, sec: sc.sec, fps: r.fps });
      }
    });
  }));
  return out;
}
function summary(res) {
  const sp = res.speech, det = sp.filter((x) => x.detected), lat = det.map((x) => x.latency);
  const within1 = sp.filter((x) => x.detected && x.latency <= 1000).length;
  const by = (k) => { const g = {}; sp.forEach((x) => { const key = x[k]; g[key] = g[key] || { n: 0, d: 0, lat: [] }; g[key].n++; if (x.detected) { g[key].d++; g[key].lat.push(x.latency); } }); return g; };
  const fsN = {}; let fsTot = 0, secTot = 0;
  res.non.forEach((x) => { fsN[x.kind] = (fsN[x.kind] || 0) + x.starts; fsTot += x.starts; secTot += x.sec; });
  const earlyTot = sp.reduce((a, x) => a + x.early, 0);
  return {
    speech: { n: sp.length, detected: det.length, within1s: within1, latMedian: pct(lat, 0.5), latP90: pct(lat, 0.9), early: earlyTot },
    byLevel: by("level"), byArtic: by("artic"), byKind: by("kind"), byPower: by("battery"), byModel: by("model"),
    falseStarts: { total: fsTot + earlyTot, nonSpeech: fsTot, perMin: Math.round((fsTot / (secTot / 60)) * 100) / 100, byScene: fsN },
    fps: { speaking: Math.round((sp.reduce((a, x) => a + x.fps, 0) / sp.length) * 10) / 10 },
  };
}
const before = summary(runAll("before")), after = summary(runAll("after"));
const pc = (a, b) => (b ? Math.round((a / b) * 1000) / 10 + " %" : "-");
console.log("Look and speak: is the person speaking? (synthetic scenes; " + voices.length + " voices: " + C.en.length + " EN, " + C.ar.length + " AR, 2 synthetic; worker " + PROC + " ms a frame)\n");
console.log("                                  before (" + OLD + ")      after");
const row = (name, a, b) => console.log("  " + name.padEnd(32) + String(a).padEnd(22) + b);
row("speech turns detected", before.speech.detected + "/" + before.speech.n + " (" + pc(before.speech.detected, before.speech.n) + ")", after.speech.detected + "/" + after.speech.n + " (" + pc(after.speech.detected, after.speech.n) + ")");
row("  ...within 1 s of the voice", pc(before.speech.within1s, before.speech.n), pc(after.speech.within1s, after.speech.n));
row("onset latency median / p90 (ms)", before.speech.latMedian + " / " + before.speech.latP90, after.speech.latMedian + " / " + after.speech.latP90);
["soft", "normal", "loud"].forEach((k) => row("  voice " + k, pc(before.byLevel[k].d, before.byLevel[k].n), pc(after.byLevel[k].d, after.byLevel[k].n)));
ARTICS.forEach((k) => row("  mouth " + k, pc(before.byArtic[k].d, before.byArtic[k].n), pc(after.byArtic[k].d, after.byArtic[k].n)));
SPEAK.forEach((k) => row("  " + k, pc(before.byKind[k].d, before.byKind[k].n) + " med " + pct(before.byKind[k].lat, 0.5), pc(after.byKind[k].d, after.byKind[k].n) + " med " + pct(after.byKind[k].lat, 0.5)));
row("  on mains / on battery", pc(before.byPower.false.d, before.byPower.false.n) + " / " + pc(before.byPower.true.d, before.byPower.true.n), pc(after.byPower.false.d, after.byPower.false.n) + " / " + pc(after.byPower.true.d, after.byPower.true.n));
row("  face model clean / noisy", pc(before.byModel.clean.d, before.byModel.clean.n) + " / " + pc(before.byModel.noisy.d, before.byModel.noisy.n), pc(after.byModel.clean.d, after.byModel.clean.n) + " / " + pc(after.byModel.noisy.d, after.byModel.noisy.n));
row("false starts (all)", before.falseStarts.total, after.falseStarts.total);
row("  per minute of not speaking", before.falseStarts.perMin, after.falseStarts.perMin);
row("  before they spoke (TV first)", before.speech.early, after.speech.early);
NON.forEach((k) => row("  " + k, before.falseStarts.byScene[k], after.falseStarts.byScene[k]));
row("camera fps while they face it", before.fps.speaking, after.fps.speaking);
const jf = arg("--json");
if (jf) fs.writeFileSync(jf, JSON.stringify({ before, after, proc: PROC, voices: voices.map((v) => v.id + ":" + v.lang) }, null, 1));
