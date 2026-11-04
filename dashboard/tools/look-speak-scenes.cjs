"use strict";
/**
 * Look and speak, "is the person speaking?" (2026-10-22): synthetic but realistic scenes for the speech gate,
 * shared by tools/bench-look-speak.cjs (the before / after report) and tools/test-presence.cjs (the unit checks).
 *
 * A scene is a timeline of what the microphone hears (24 kHz mono) and what the camera sees (the person's head
 * and mouth, as MediaPipe's Face Landmarker would report them: 478 landmarks + blendshapes + the head's matrix):
 *   - the person's own speech: recorded clips (EN + AR TTS narration from LOOK_FIXTURES, default
 *     /var/lib/planning_engine_voice/cache) or a synthetic voice; their lips follow the clip's syllable envelope
 *     ~100 ms ahead of the sound (lips move before the voice), with a chosen articulation (small / normal / big:
 *     some people barely open their mouth), and the model's frame-to-frame jitter;
 *   - not speaking: chewing (jaw moves, lips closed), chewing with the mouth open, a smile, a still open mouth,
 *     a head turn; and sounds that are not the person: typing, music, a TV / someone else's voice, a fan.
 * simulate() then runs one implementation of the gate (the logic module, how it meters the microphone, its
 * frame rate) over the scene the way joya-presence.js does: the camera's frames at its fps, each result a few ms
 * later (the worker), the microphone's meter every 50 ms over the last ~43 ms; it returns when it started.
 */
const fs = require("fs");
const path = require("path");

const RATE = 24000;
const FIXDIR = process.env.LOOK_FIXTURES || "/var/lib/planning_engine_voice/cache";

function rng(seed) { // mulberry32
  let a = seed >>> 0;
  return function () { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
function gauss(r) { let u = 0, v = 0; while (!u) u = r(); while (!v) v = r(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); }
function rms(x, a, b) { let s = 0; a = Math.max(0, a | 0); b = Math.min(x.length, b | 0); for (let i = a; i < b; i++) s += x[i] * x[i]; return b > a ? Math.sqrt(s / (b - a)) : 0; }
function scaleTo(x, level) { const r = rms(x, 0, x.length) || 1; const y = new Float32Array(x.length); for (let i = 0; i < x.length; i++) y[i] = (x[i] / r) * level; return y; }

/* ------------------------------------------------------------------ sounds (24 kHz) */
function readWav(f) {
  const b = fs.readFileSync(f);
  let o = 12, fmt = null, data = null;
  while (o + 8 <= b.length) {
    const id = b.toString("ascii", o, o + 4), n = b.readUInt32LE(o + 4);
    if (id === "fmt ") fmt = { ch: b.readUInt16LE(o + 10), rate: b.readUInt32LE(o + 12), bits: b.readUInt16LE(o + 22) };
    if (id === "data") data = b.subarray(o + 8, o + 8 + n);
    o += 8 + n + (n % 2);
  }
  if (!fmt || !data || fmt.ch !== 1 || fmt.bits !== 16 || fmt.rate !== RATE) return null;
  const s = new Float32Array(data.length / 2);
  for (let i = 0; i < s.length; i++) s[i] = data.readInt16LE(i * 2) / 32768;
  return s;
}
/** Recorded clips: up to n per language (EN, AR), 2-6 s, the speech's own level kept for scaling later. */
function clips(n) {
  const out = { en: [], ar: [] };
  let files = [];
  try { files = fs.readdirSync(FIXDIR).filter((f) => f.endsWith(".json")).sort(); } catch (e) { return out; }
  for (const f of files) {
    if (out.en.length >= n && out.ar.length >= n) break;
    let j = null; try { j = JSON.parse(fs.readFileSync(path.join(FIXDIR, f), "utf8")); } catch (e) { continue; }
    if (!j || !j.ok || !out[j.lang] || out[j.lang].length >= n || !(j.seconds >= 2 && j.seconds <= 6)) continue;
    const pcm = readWav(path.join(FIXDIR, f.replace(/\.json$/, ".wav")));
    if (pcm) out[j.lang].push({ id: (j.hash || f).slice(0, 8), lang: j.lang, pcm });
  }
  return out;
}
/** A synthetic voice: syllables (a glottal pulse train 100-220 Hz through two formants) with pauses. */
function synthVoice(seed, sec) {
  const r = rng(seed), n = Math.round(sec * RATE), x = new Float32Array(n);
  let i = 0;
  while (i < n) {
    const syl = Math.round((0.12 + r() * 0.16) * RATE), gap = Math.round((0.03 + r() * (r() < 0.15 ? 0.3 : 0.08)) * RATE);
    const f0 = 110 + r() * 100, F1 = 400 + r() * 500, F2 = 1000 + r() * 1400;
    let ph = 0;
    for (let k = 0; k < syl && i + k < n; k++) {
      const env = Math.sin((Math.PI * k) / syl);
      ph += f0 / RATE;
      const g = (ph % 1) < 0.08 ? 1 : 0;
      const t = k / RATE;
      x[i + k] = env * (g * 0.4 + 0.5 * Math.sin(2 * Math.PI * F1 * t) * Math.sin(2 * Math.PI * f0 * t) + 0.3 * Math.sin(2 * Math.PI * F2 * t) * Math.sin(2 * Math.PI * f0 * t));
    }
    i += syl + gap;
  }
  return x;
}
/** Typing on the laptop's keyboard: a press and a release click per key (damped resonances + a noise tick). */
function typing(seed, sec, o) {
  o = o || {};
  const r = rng(seed), n = Math.round(sec * RATE), x = new Float32Array(n);
  const gapMs = o.fast ? [70, 140] : [110, 230];
  let t = 0.05;
  const click = (at, amp) => {
    const i0 = Math.round(at * RATE), fr = [1200 + r() * 1800, 2500 + r() * 2500, 4000 + r() * 2000], tau = 0.002 + r() * 0.003;
    for (let k = 0; k < 0.03 * RATE && i0 + k < n; k++) {
      const tt = k / RATE, e = Math.exp(-tt / tau);
      let v = (r() * 2 - 1) * Math.exp(-tt / 0.0015);
      fr.forEach((f, j) => { v += Math.sin(2 * Math.PI * f * tt + j) * e * (0.6 / (j + 1)); });
      x[i0 + k] += v * amp;
    }
  };
  while (t < sec) {
    const amp = 0.25 + r() * 0.35;
    click(t, amp);
    click(t + 0.05 + r() * 0.06, amp * 0.6);
    t += (gapMs[0] + r() * (gapMs[1] - gapMs[0])) / 1000;
  }
  return x;
}
/** Music: a melody of harmonic notes, a bass line, a hi-hat. */
function music(seed, sec) {
  const r = rng(seed), n = Math.round(sec * RATE), x = new Float32Array(n);
  const scale = [261.6, 293.7, 329.6, 392, 440, 523.3];
  let t = 0;
  while (t < sec) {
    const dur = 0.2 + r() * 0.3, f = scale[Math.floor(r() * scale.length)], b = scale[Math.floor(r() * 3)] / 4;
    const i0 = Math.round(t * RATE);
    for (let k = 0; k < dur * RATE && i0 + k < n; k++) {
      const tt = k / RATE, e = Math.exp(-tt / 0.25) * Math.min(1, tt / 0.01);
      let v = 0;
      for (let h = 1; h <= 6; h++) v += Math.sin(2 * Math.PI * f * h * tt) / h;
      v = v * 0.5 * e + 0.5 * Math.sin(2 * Math.PI * b * tt) * Math.exp(-tt / 0.4);
      if (k < 0.04 * RATE) v += (r() * 2 - 1) * 0.3 * Math.exp(-tt / 0.01);
      x[i0 + k] += v;
    }
    t += dur;
  }
  return x;
}
/** A room: low, slightly coloured noise (what is left after the browser's noise suppression). */
function roomNoise(seed, sec, level) {
  const r = rng(seed), n = Math.round(sec * RATE), x = new Float32Array(n);
  let y = 0;
  for (let i = 0; i < n; i++) { y = y * 0.6 + (r() * 2 - 1) * 0.4; x[i] = y; }
  return scaleTo(x, level);
}
function mixInto(dst, src, atSec, gain) { const i0 = Math.round(atSec * RATE); for (let i = 0; i < src.length && i0 + i < dst.length; i++) if (i0 + i >= 0) dst[i0 + i] += src[i] * (gain == null ? 1 : gain); }
/** The clip's syllable envelope (0..1, every 10 ms) and where its speech starts / ends (ms, from the clip's start). */
function envelope(x) {
  const hop = RATE / 100, n = Math.floor(x.length / hop), e = new Float32Array(n);
  let y = 0;
  for (let i = 0; i < n; i++) { const v = rms(x, i * hop, (i + 1) * hop); y = y + (v - y) * 0.45; e[i] = y; } // ~10 Hz low-pass: syllables
  const sorted = Array.from(e).sort((a, b) => a - b), p95 = sorted[Math.floor(sorted.length * 0.95)] || 1;
  for (let i = 0; i < n; i++) e[i] = Math.min(1, e[i] / p95);
  let on = 0; while (on < n && e[on] < 0.12) on++;
  let off = n - 1; while (off > on && e[off] < 0.12) off--;
  return { e, onMs: on * 10, offMs: off * 10 };
}

/* ------------------------------------------------------------------ the face, as the model reports it */
const ARTIC = { tiny: { lip: 0.05, jaw: 0.035, pk: 0.06 }, small: { lip: 0.09, jaw: 0.07, pk: 0.12 }, normal: { lip: 0.22, jaw: 0.17, pk: 0.2 }, big: { lip: 0.4, jaw: 0.32, pk: 0.25 } };
const REST = { lip: 0.012, jaw: 0.04, mc: 0.05, sm: 0.04, pk: 0.06 };
/**
 * 478 landmarks filling the face's box, with the ones the logic reads placed where they are on a face: the inner
 * lips (13, 14), between the eyes (168), under the nose (2), the eyes' outer corners (33, 263), the mouth's
 * corners (61, 291). lip = the inner lips' gap in nose lengths (168 -> 2).
 */
function faceResult(faces) {
  const L = [], M = [], B = [];
  faces.forEach((o) => {
    const w = o.w || 0.24, h = w * 1.3, pts = [];
    for (let i = 0; i < 478; i++) { const a = (i * 2.399) % (2 * Math.PI), r = Math.sqrt((i + 0.5) / 478) * 0.8; pts.push({ x: o.cx + Math.cos(a) * r * w / 2, y: o.cy + Math.sin(a) * r * h / 2, z: 0 }); }
    pts.push({ x: o.cx - w / 2, y: o.cy, z: 0 }, { x: o.cx + w / 2, y: o.cy, z: 0 }, { x: o.cx, y: o.cy - h / 2, z: 0 }, { x: o.cx, y: o.cy + h / 2, z: 0 });
    const nose = 0.2 * h, cosP = Math.cos(((o.pitch || 0) * Math.PI) / 180);
    const set = (i, x, y) => { pts[i] = { x, y, z: 0 }; };
    set(168, o.cx, o.cy - 0.12 * h * cosP); set(2, o.cx, o.cy - 0.12 * h * cosP + nose * cosP);
    set(33, o.cx - 0.2 * w, o.cy - 0.12 * h); set(263, o.cx + 0.2 * w, o.cy - 0.12 * h);
    const ly = o.cy + 0.15 * h * cosP, gap = Math.max(0, o.lip || 0) * nose * cosP;
    set(13, o.cx, ly); set(14, o.cx, ly + gap);
    set(61, o.cx - 0.12 * w * (1 + (o.sm || 0) * 0.25), ly); set(291, o.cx + 0.12 * w * (1 + (o.sm || 0) * 0.25), ly);
    L.push(pts);
    M.push({ rows: 4, columns: 4, data: o.m });
    const cat = (name, score) => ({ categoryName: name, score: Math.max(0, Math.min(1, score)) });
    B.push({ categories: [
      cat("jawOpen", o.jaw), cat("mouthClose", o.mc || 0), cat("mouthSmileLeft", o.sm || 0), cat("mouthSmileRight", o.sm || 0),
      cat("mouthFunnel", (o.pk || 0) * 0.6), cat("mouthPucker", o.pk || 0),
      cat("eyeLookDownLeft", o.eyeDown || 0), cat("eyeLookDownRight", o.eyeDown || 0), cat("eyeLookUpLeft", 0), cat("eyeLookUpRight", 0),
    ] });
  });
  return { faceLandmarks: L, facialTransformationMatrixes: M, faceBlendshapes: B };
}

/* ------------------------------------------------------------------ scenes */
/**
 * scene(kind, o) -> { name, sec, audio (Float32Array), face(tMs, r) -> face opts, speech: [{ onMs, offMs }] }.
 * The person sits ~55 cm from a laptop camera and looks at the bot (head 4 deg aside, eyes down) from the start.
 *   o: { clip, lang, artic, level (their voice's RMS), noise, seed, at (s: when they talk) }
 */
const LOOK = { cx: 0.5, cy: 0.5, w: 0.24, yaw: 4, pitch: -8, eyeDown: 0.4 };
function scene(kind, o, L) {
  o = o || {};
  const seed = o.seed || 1, r = rng(seed * 7919 + 13);
  const sec = o.sec || 8, noise = o.noise == null ? 0.0025 : o.noise;
  const audio = roomNoise(seed, sec, noise);
  const speech = [];
  let mouth = () => REST; // the person's mouth, by time (ms)
  let head = () => LOOK;
  const ar = ARTIC[o.artic || "normal"];
  function talk(clip, atSec, level) {
    const x = scaleTo(clip, level), env = envelope(x);
    mixInto(audio, x, atSec);
    const rs = rng(seed * 31 + 7), t0 = atSec * 1000, lead = 50 + rs() * 200; // lips lead the voice by 50-250 ms
    const shape = Array.from({ length: env.e.length }, () => 0.6 + rs() * 0.5); // vowels differ
    speech.push({ onMs: t0 + env.onMs, offMs: t0 + env.offMs });
    const prev = mouth;
    mouth = (t) => {
      const i = Math.floor((t - t0 + lead) / 10);
      if (i < 0 || i >= env.e.length) return prev(t);
      const v = env.e[i] * shape[Math.floor(i / 15)] ;
      return { lip: REST.lip + ar.lip * v, jaw: REST.jaw + ar.jaw * v, mc: REST.mc * (1 - v), sm: REST.sm, pk: REST.pk + ar.pk * Math.max(0, Math.sin(i / 7)) * v };
    };
  }
  const voiceOf = () => o.clip || synthVoice(seed, 3.5);
  switch (kind) {
    case "speak": talk(voiceOf(), o.at == null ? 2 : o.at, o.level || 0.05); break;
    case "speak-over-typing": mixInto(audio, typing(seed, sec), 0); talk(voiceOf(), 2.5, o.level || 0.05); break;
    case "speak-over-tv": mixInto(audio, scaleTo(o.other || synthVoice(seed + 99, sec), o.otherLevel || 0.025), 0); talk(voiceOf(), 3, o.level || 0.05); break;
    case "typing": mixInto(audio, typing(seed, sec), 0); break;
    case "typing-fast": mixInto(audio, typing(seed, sec, { fast: true }), 0); break;
    case "music": mixInto(audio, scaleTo(music(seed, sec), o.otherLevel || 0.04), 0); break;
    case "tv": mixInto(audio, scaleTo(o.other || synthVoice(seed + 99, sec), o.otherLevel || 0.04), 0.5); break;
    case "tv-smile": // a TV voice; the person smiles at it (and smiles again)
      mixInto(audio, scaleTo(o.other || synthVoice(seed + 99, sec), o.otherLevel || 0.04), 0.5);
      mouth = (t) => { const s = Math.min(1, Math.max(0, (t - 2500) / 300)) - Math.min(1, Math.max(0, (t - 4500) / 400)) + Math.min(1, Math.max(0, (t - 5500) / 300)); return { lip: REST.lip + 0.06 * s, jaw: REST.jaw + 0.05 * s, mc: REST.mc, sm: REST.sm + 0.65 * s, pk: REST.pk }; };
      break;
    case "tv-open": // a TV voice; the person's mouth hangs open, still
      mixInto(audio, scaleTo(o.other || synthVoice(seed + 99, sec), o.otherLevel || 0.04), 0.5);
      mouth = () => ({ lip: 0.2, jaw: 0.3, mc: 0, sm: REST.sm, pk: REST.pk });
      break;
    case "tv-chew": // a TV voice; the person chews (jaw moves, lips closed)
      mixInto(audio, scaleTo(o.other || synthVoice(seed + 99, sec), o.otherLevel || 0.04), 0.5);
      mouth = (t) => { const c = 0.5 + 0.5 * Math.sin((2 * Math.PI * 1.5 * t) / 1000); return { lip: REST.lip + 0.01 * c, jaw: REST.jaw + 0.22 * c, mc: 0.05 + 0.35 * c, sm: REST.sm, pk: REST.pk + 0.05 * c }; };
      break;
    case "chew-open-typing": // chewing with the mouth open while typing
      mixInto(audio, typing(seed, sec), 0);
      mouth = (t) => { const c = 0.5 + 0.5 * Math.sin((2 * Math.PI * 1.6 * t) / 1000); return { lip: REST.lip + 0.12 * c, jaw: REST.jaw + 0.22 * c, mc: 0.05, sm: REST.sm, pk: REST.pk }; };
      break;
    case "tv-headturn": // a TV voice; the person turns to it and back (their mouth still)
      mixInto(audio, scaleTo(o.other || synthVoice(seed + 99, sec), o.otherLevel || 0.04), 0.5);
      head = (t) => { const k = Math.max(0, Math.sin(Math.PI * Math.min(1, Math.max(0, (t - 2500) / 3000)))); return { ...LOOK, yaw: LOOK.yaw + 45 * k }; };
      break;
    case "fan": mixInto(audio, roomNoise(seed + 5, sec, 0.03), 0); break;
    case "speak-over-loud-tv": mixInto(audio, scaleTo(o.other || synthVoice(seed + 99, sec), 0.05), 0); talk(voiceOf(), 3, o.level || 0.05); break;
    case "tv-chew-open": // a TV voice; the person chews with the mouth open
      mixInto(audio, scaleTo(o.other || synthVoice(seed + 99, sec), o.otherLevel || 0.04), 0.5);
      mouth = (t) => { const c = 0.5 + 0.5 * Math.sin((2 * Math.PI * 1.6 * t) / 1000); return { lip: REST.lip + 0.12 * c, jaw: REST.jaw + 0.22 * c, mc: 0.05, sm: REST.sm, pk: REST.pk }; };
      break;
    case "tv-nod": // a TV voice; the person nods along (head pitch +-8 deg at 1.2 Hz), mouth still
      mixInto(audio, scaleTo(o.other || synthVoice(seed + 99, sec), o.otherLevel || 0.04), 0.5);
      head = (t) => ({ ...LOOK, pitch: LOOK.pitch + 8 * Math.sin((2 * Math.PI * 1.2 * t) / 1000) });
      break;
    case "cough": { // two coughs (bursts of breath noise) with the mouth jerking open
      const r2 = rng(seed + 3);
      [2.5, 5.5].forEach((at) => { const n = Math.round(0.25 * RATE), x = new Float32Array(n); for (let i = 0; i < n; i++) x[i] = (r2() * 2 - 1) * Math.exp(-i / (0.08 * RATE)); mixInto(audio, scaleTo(x, 0.12), at); });
      mouth = (t) => { const k = [2500, 5500].reduce((a, c) => a + Math.max(0, 1 - Math.abs(t - c - 80) / 200), 0); return { lip: REST.lip + 0.3 * k, jaw: REST.jaw + 0.3 * k, mc: REST.mc, sm: REST.sm, pk: REST.pk }; };
      break;
    }
    default: throw new Error("scene " + kind);
  }
  // the model's frame-to-frame noise (o.jit: x it; o.outliers: the share of frames read badly -- the lips misplaced)
  const jm = o.jit || 1, jit = { lip: 0.008 * jm, jaw: 0.012 * jm, mc: 0.01 * jm, sm: 0.01 * jm, pk: 0.01 * jm }, outl = o.outliers || 0;
  function face(t, rr) {
    const m = Object.assign({}, mouth(t)), h = head(t);
    if (outl && rr() < outl) { m.lip += 0.12 * rr(); m.jaw += 0.1 * rr(); }
    const yaw = h.yaw + gauss(rr) * 2.2 * jm, pitch = h.pitch + gauss(rr) * 1.6 * jm;
    return { ...h, yaw, pitch, m: L.matrixOf(yaw, pitch),
      lip: Math.max(0, m.lip + gauss(rr) * jit.lip), jaw: Math.max(0, m.jaw + gauss(rr) * jit.jaw), mc: Math.max(0, m.mc + gauss(rr) * jit.mc), sm: Math.max(0, m.sm + gauss(rr) * jit.sm), pk: Math.max(0, m.pk + gauss(rr) * jit.pk) };
  }
  return { name: kind, sec, audio, face, speech, isSpeech: speech.length > 0 };
}

/* ------------------------------------------------------------------ running one implementation of the gate */
/**
 * simulate(sc, impl) -> { starts: [ms], frames, fpsSeen }
 *   impl: { L (the logic module), fps(snapshot, armed) -> frames a second, meter(frame Float32Array, sampleRate) -> what
 *           gate.audio takes, procMs (the worker's time a frame), seed }
 * The camera captures a frame every 1000/fps ms (skipped while the worker is still busy, as joya-presence.js does);
 * its result reaches the tracker procMs later. The microphone's meter runs every 50 ms over the last 1024 samples
 * (24 kHz: the 2048 of a 48 kHz analyser). A started turn holds the gate (busy) for 2 s, then ends (cool-down).
 */
function simulate(sc, impl) {
  const L = impl.L, tr = L.createTracker({ bot: { x: 0.85, y: 0.85 } }), gate = L.createSpeakGate();
  const rr = rng((impl.seed || 1) * 104729 + sc.sec);
  const durMs = sc.sec * 1000, starts = [];
  let nextCap = rr() * 50, pending = null, nextMeter = 20 + rr() * 30, frames = 0, snap = null, busyUntil = -1, fpsSum = 0, fpsN = 0;
  const proc = impl.procMs || 30;
  for (let t = 0; t <= durMs; t++) {
    if (pending && t >= pending.at) {
      snap = tr.push(L.summarize(faceResult([pending.face])), t);
      gate.vision(snap, t);
      pending = null;
    }
    if (t >= nextCap) {
      const fps = impl.fps(snap, gate.armed ? gate.armed() : false);
      fpsSum += fps; fpsN++;
      if (!pending) { pending = { at: t + proc * (0.8 + rr() * 0.4), face: sc.face(t, rr) }; frames++; }
      nextCap = t + 1000 / fps;
    }
    if (t >= nextMeter) {
      nextMeter += 50;
      const end = Math.round((t / 1000) * RATE), a = Math.max(0, end - 1024);
      if (end - a >= 256) {
        const busy = t < busyUntil;
        if (busyUntil > 0 && t >= busyUntil) { gate.ended(t); busyUntil = 0; }
        const r = gate.audio(impl.meter(sc.audio.subarray(a, end), RATE), t, busy);
        if (r === "start") { starts.push(t); busyUntil = t + 2000; }
      }
    }
  }
  return { starts, frames, fps: fpsN ? fpsSum / fpsN : 0, onset: gate.onset ? gate.onset() : null };
}
function levelMeter(x) { let s = 0; for (let i = 0; i < x.length; i++) s += x[i] * x[i]; return Math.sqrt(s / x.length); }

module.exports = { RATE, rng, clips, synthVoice, typing, music, roomNoise, envelope, faceResult, scene, simulate, levelMeter, scaleTo, rms, ARTIC, LOOK };
