#!/usr/bin/env node
"use strict";
/**
 * JOYA AI's sound identity, rendered to files so they can be listened to (2026-10-20).
 *
 *     node dashboard/tools/make-sound-identity.cjs OUT_DIR [--no-mp3]
 *
 * Renders every sound of public/joya-sound.js offline, from the same recipes the page plays through
 * WebAudio: the five bot chirps for each of the six roles (core, hired, planning, erp, builder, other)
 * and the two key sounds, as 48 kHz mono 16-bit WAV (and MP3 through ffmpeg when it is there), plus a
 * tour (every sound in a row), an index.html to play them and a manifest.json. Files are rendered at
 * 100 % volume so they can be heard; the app plays them at the person's volume (30 % by default).
 *
 * The synthesis mirrors the WebAudio graph: an oscillator with an exponential pitch glide (band-limited
 * for triangle / square), a linear attack then an exponential decay to -62 dB, an optional vibrato LFO,
 * FM (the modulator added to the frequency, its depth decaying for the bell), a second partial, and an
 * RBJ low-pass (the BiquadFilterNode's). Pure; renderPCM is also used by the tests.
 */
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const SND = require(path.join(__dirname, "..", "public", "joya-sound.js"));

const RATE = 48000;
const TWO_PI = Math.PI * 2;

function waveSample(wave, ph, f) {
  if (wave === "sine") return Math.sin(ph);
  const nyq = RATE / 2, kmax = Math.max(1, Math.min(31, Math.floor(nyq / Math.max(1, f))));
  let s = 0;
  for (let k = 1; k <= kmax; k++) {
    if (wave === "square") { if (k % 2) s += (4 / (Math.PI * k)) * Math.sin(k * ph); }
    else if (wave === "triangle") { if (k % 2) s += (8 / (Math.PI * Math.PI)) * ((k - 1) / 2 % 2 ? -1 : 1) / (k * k) * Math.sin(k * ph); }
    else s += (2 / (Math.PI * k)) * (k % 2 ? 1 : -1) * Math.sin(k * ph); // sawtooth
  }
  return s;
}
/** The gain envelope at tau seconds into a note of length d (attack a, peak g). */
function env(tau, a, d, g) {
  if (tau < 0 || tau > d) return 0;
  if (tau < a) return g * (tau / a);
  return g * Math.pow(0.0008 / g, (tau - a) / Math.max(1e-6, d - a));
}
function lowpass(buf, fc) {
  const w0 = TWO_PI * fc / RATE, q = Math.SQRT1_2, al = Math.sin(w0) / (2 * q), c = Math.cos(w0);
  const b0 = (1 - c) / 2, b1 = 1 - c, b2 = (1 - c) / 2, a0 = 1 + al, a1 = -2 * c, a2 = 1 - al;
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < buf.length; i++) {
    const x = buf[i], y = (b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2) / a0;
    x2 = x1; x1 = x; y2 = y1; y1 = y; buf[i] = y;
  }
}
/** One note into its own buffer (so the low-pass applies to it alone), then mixed in. */
function renderNote(n, len) {
  const out = new Float64Array(len), i0 = Math.round(n.t * RATE), i1 = Math.min(len, Math.round((n.t + n.d + 0.02) * RATE));
  let ph = 0, hph = 0, mph = 0, lph = 0;
  const ratio = n.f1 / n.f0;
  for (let i = i0; i < i1; i++) {
    const tau = (i - i0) / RATE, x = Math.min(1, tau / n.d);
    let f = n.f0 * Math.pow(ratio, x);
    if (n.vib) { lph += TWO_PI * n.vib.rate / RATE; f += n.vib.depth * n.f0 * Math.sin(lph); }
    if (n.fm) {
      const dev0 = n.fm.index * n.f0;
      const dev = n.fm.decay ? (tau < n.fm.decay ? dev0 * Math.pow(Math.max(1, dev0 * 0.02) / dev0, tau / n.fm.decay) : Math.max(1, dev0 * 0.02)) : dev0;
      mph += TWO_PI * n.f0 * n.fm.ratio / RATE;
      f += dev * Math.sin(mph);
    }
    ph += TWO_PI * f / RATE;
    out[i] = waveSample(n.wave, ph, f) * env(tau, n.a, n.d, n.g);
  }
  if (n.lp) lowpass(out, n.lp);
  if (n.harm) {
    for (let i = i0; i < i1; i++) {
      const tau = (i - i0) / RATE, x = Math.min(1, tau / n.d);
      hph += TWO_PI * n.f0 * Math.pow(ratio, x) * n.harmRatio / RATE;
      out[i] += Math.sin(hph) * env(tau, n.a, n.d * 0.6, n.g * n.harm);
    }
  }
  return out;
}
/** A sound for a role -> Float32Array of samples at RATE (master gain from the volume, 0-100). */
function renderPCM(name, role, vol) {
  const notes = SND.recipe(name, role);
  if (!notes) throw new Error("no such sound: " + name);
  const len = Math.ceil((SND.recipeLength(notes) + 0.06) * RATE), mix = new Float64Array(len), g = SND.gainFor(vol == null ? 100 : vol);
  notes.forEach((n) => { const b = renderNote(n, len); for (let i = 0; i < len; i++) mix[i] += b[i]; });
  const out = new Float32Array(len);
  for (let i = 0; i < len; i++) out[i] = Math.max(-1, Math.min(1, mix[i] * g));
  return out;
}
function wav(pcm) {
  const n = pcm.length, b = Buffer.alloc(44 + n * 2);
  b.write("RIFF", 0); b.writeUInt32LE(36 + n * 2, 4); b.write("WAVE", 8); b.write("fmt ", 12);
  b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(RATE, 24); b.writeUInt32LE(RATE * 2, 28);
  b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write("data", 36); b.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(pcm[i] * 32767), 44 + i * 2);
  return b;
}
function stats(pcm) {
  let pk = 0, ss = 0;
  for (let i = 0; i < pcm.length; i++) { const v = Math.abs(pcm[i]); if (v > pk) pk = v; ss += pcm[i] * pcm[i]; }
  return { seconds: +(pcm.length / RATE).toFixed(3), peakDb: +(20 * Math.log10(pk || 1e-9)).toFixed(1), rmsDb: +(10 * Math.log10(ss / pcm.length || 1e-12)).toFixed(1) };
}
/** The pitch the sound centres on (zero crossings of its loudest 40 ms), for the manifest and the tests. */
function pitchOf(pcm) {
  const w = Math.round(RATE * 0.04);
  let best = 0, at = 0;
  for (let i = 0; i + w < pcm.length; i += w) { let e = 0; for (let j = i; j < i + w; j++) e += pcm[j] * pcm[j]; if (e > best) { best = e; at = i; } }
  let z = 0;
  for (let j = at + 1; j < at + w; j++) if (pcm[j - 1] <= 0 && pcm[j] > 0) z++;
  return Math.round(z / 0.04);
}

module.exports = { RATE, renderPCM, wav, stats, pitchOf };

if (require.main === module) {
  const OUT = process.argv[2];
  if (!OUT) { console.error("usage: make-sound-identity.cjs OUT_DIR [--no-mp3]"); process.exit(2); }
  const MP3 = !process.argv.includes("--no-mp3") && (() => { try { execFileSync("ffmpeg", ["-version"], { stdio: "ignore" }); return true; } catch (e) { return false; } })();
  fs.mkdirSync(path.join(OUT, "wav"), { recursive: true });
  if (MP3) fs.mkdirSync(path.join(OUT, "mp3"), { recursive: true });
  const items = [];
  const put = (file, pcm, meta) => {
    fs.writeFileSync(path.join(OUT, "wav", file + ".wav"), wav(pcm));
    if (MP3) execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-i", path.join(OUT, "wav", file + ".wav"), "-codec:a", "libmp3lame", "-b:a", "128k", path.join(OUT, "mp3", file + ".mp3")]);
    items.push(Object.assign({ file }, meta, stats(pcm), { hz: pitchOf(pcm) }));
  };
  const tour = [];
  const gap = new Float32Array(Math.round(RATE * 0.55));
  for (const name of SND.CHIRPS) for (const role of Object.keys(SND.ROLES)) {
    const pcm = renderPCM(name, role, 100);
    put(name + "-" + role, pcm, { name, role, label: SND.ROLES[role].label, kind: "chirp" });
    tour.push(pcm, gap);
  }
  for (const name of SND.KEYS) {
    const pcm = renderPCM(name, "", 100);
    put(name, pcm, { name, role: "", label: name === "approval" ? "An approval is waiting" : "A job finished", kind: "key" });
    tour.push(pcm, gap, gap);
  }
  // The default volume (30 %), for comparison: what the app plays.
  put("approval-at-30", renderPCM("approval", "", 30), { name: "approval", role: "", label: "Approval chime at the default volume (30 %)", kind: "level" });
  put("done-core-at-30", renderPCM("done", "core", 30), { name: "done", role: "core", label: "Done chirp at the default volume (30 %)", kind: "level" });
  const tlen = tour.reduce((s, b) => s + b.length, 0), all = new Float32Array(tlen);
  let o = 0;
  for (const b of tour) { all.set(b, o); o += b.length; }
  put("tour", all, { name: "tour", role: "", label: "Every chirp for every role, then the two chimes", kind: "tour" });
  fs.writeFileSync(path.join(OUT, "manifest.json"), JSON.stringify({ rate: RATE, made: new Date().toISOString(), items }, null, 2));
  // A page to listen (local file; no script needed).
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const src = (f) => (MP3 ? "mp3/" + f + ".mp3" : "wav/" + f + ".wav");
  const roles = Object.keys(SND.ROLES);
  let h = '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Sound identity</title>' +
    "<style>body{font:15px system-ui,sans-serif;max-width:1100px;margin:24px auto;padding:0 16px;background:#0e1116;color:#e8edf2}table{border-collapse:collapse;width:100%}td,th{border-bottom:1px solid #263040;padding:6px;text-align:left;vertical-align:middle}audio{width:180px;height:32px}small{color:#8a97a8}h1{font-size:22px}</style>" +
    "<h1>JOYA AI · sound identity</h1><p>Rendered at 100 % volume so they can be heard; the app plays them at your volume (30 % by default). See README.md.</p>" +
    "<h2>Bot chirps · one voice per role</h2><table><tr><th>Sound</th>" + roles.map((r) => "<th>" + esc(SND.ROLES[r].label) + "<br><small>" + r + "</small></th>").join("") + "</tr>";
  for (const n of SND.CHIRPS) h += "<tr><td><b>" + n + "</b></td>" + roles.map((r) => '<td><audio controls preload="none" src="' + src(n + "-" + r) + '"></audio></td>').join("") + "</tr>";
  h += "</table><h2>Key sounds</h2><table>";
  for (const it of items.filter((x) => x.kind !== "chirp")) h += "<tr><td><b>" + esc(it.file) + "</b><br><small>" + esc(it.label) + " · " + it.seconds + " s · peak " + it.peakDb + " dBFS</small></td><td><audio controls preload=\"none\" src=\"" + src(it.file) + '"></audio></td></tr>';
  h += "</table>";
  fs.writeFileSync(path.join(OUT, "index.html"), h);
  console.log("wrote " + items.length + " sounds to " + OUT + (MP3 ? " (wav + mp3)" : " (wav)"));
}
