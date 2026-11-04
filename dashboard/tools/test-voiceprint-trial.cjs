#!/usr/bin/env node
"use strict";
/**
 * The voiceprint's recording material (lib/voiceprint-trial.js): the phrases and
 * the resampler the guided enrolment uses, and that the trial page itself is gone
 * (removed 2026-10-25).
 *
 *     NODE_PATH=/opt/joya-dashboard/node_modules PLAYWRIGHT=/path/to/node_modules/playwright \
 *       node dashboard/tools/test-voiceprint-trial.cjs
 *
 *   - the phrase list: 4 enrolment paragraphs + 30 test phrases, unique ids,
 *     very short words and both languages present;
 *   - 24 -> 16 kHz: length 2/3, a 1 kHz tone keeps its pitch and level, a
 *     10 kHz tone (above the new Nyquist) is cut by > 40 dB;
 *   - the trial page and its API answer 404, and Settings ▸ Voice no longer links to them.
 */
const scratch = require("./scratch-server.cjs"); // first: sets JOYA_DATA_DIR
const fs = require("fs");
const os = require("os");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const vp = require(path.join(ROOT, "lib", "voiceprint-trial.js"));

let passed = 0;
let failed = 0;
function check(name, cond, detail) {
  if (cond) {
    passed++;
    console.log("  ok   " + name);
  } else {
    failed++;
    console.log("  FAIL " + name + (detail !== undefined ? "\n       " + String(detail).slice(0, 800) : ""));
  }
}
const section = (t) => console.log("\n" + t);

function tone(freq, seconds, rate, amp) {
  const n = Math.round(seconds * rate);
  const a = new Int16Array(n);
  for (let i = 0; i < n; i++) a[i] = Math.round((amp || 0.5) * 32767 * Math.sin((2 * Math.PI * freq * i) / rate));
  return a;
}
function wavOf(samples, rate) {
  const b = Buffer.alloc(44 + samples.length * 2);
  b.write("RIFF", 0, "ascii");
  b.writeUInt32LE(36 + samples.length * 2, 4);
  b.write("WAVEfmt ", 8, "ascii");
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(1, 22);
  b.writeUInt32LE(rate, 24);
  b.writeUInt32LE(rate * 2, 28);
  b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34);
  b.write("data", 36, "ascii");
  b.writeUInt32LE(samples.length * 2, 40);
  Buffer.from(samples.buffer, samples.byteOffset, samples.length * 2).copy(b, 44);
  return b;
}
const rms = (a, from, to) => {
  let s = 0;
  for (let i = from; i < to; i++) s += a[i] * a[i];
  return Math.sqrt(s / (to - from));
};

function unit() {
  section("phrases");
  check("4 enrolment paragraphs, 30 test phrases", vp.ENROL.length === 4 && vp.TESTS.length === 30);
  const ids = vp.PHRASES.map((p) => p.id);
  check("ids are unique", new Set(ids).size === ids.length);
  check("very short words in both languages", ["Yes.", "Stop.", "نعم.", "اقفل المكالمة."].every((t) => vp.TESTS.some((p) => p.text === t)));
  check("English, Egyptian and mixed tests", ["en", "ar", "mixed"].every((l) => vp.TESTS.filter((p) => p.lang === l).length >= 6));
  check("username folder: plain kept, odd ones by id", vp.userDirName({ id: 3, username: "amaraghy" }) === "amaraghy" && vp.userDirName({ id: 3, username: "../x" }) === "u3" && vp.userDirName({ id: 4, username: ".." }) === "u4");

  section("24 -> 16 kHz");
  const t1 = tone(1000, 1, 24000, 0.5);
  const o1 = vp.to16k(t1, 24000);
  check("length is two thirds", o1.length === 16000, o1.length);
  let zc = 0;
  for (let i = 1; i < o1.length; i++) if (o1[i - 1] < 0 && o1[i] >= 0) zc++;
  check("a 1 kHz tone stays 1 kHz", Math.abs(zc - 1000) <= 2, zc);
  const lvl = rms(o1, 200, 15800) / rms(t1, 200, 23800);
  check("and keeps its level (within 0.5 dB)", Math.abs(20 * Math.log10(lvl)) < 0.5, lvl);
  const o2 = vp.to16k(tone(10000, 1, 24000, 0.5), 24000);
  const att = 20 * Math.log10(rms(o2, 200, 15800) / (0.5 * 32767 / Math.SQRT2));
  check("a 10 kHz tone is cut by more than 40 dB", att < -40, att.toFixed(1));
  const w = vp.parseWav(vp.wav16(o1));
  check("wav16 round-trips", w.rate === 16000 && w.samples.length === 16000 && w.samples[100] === o1[100]);

}

/* The trial page, its routes and its store were removed on 2026-10-25 (the recordings were archived
   under /root/backups); the guided enrolment keeps the paragraphs, the slots and the WAV helpers. */
async function server() {
  section("the trial page is gone (scratch copy of server.js)");
  check("the store and the routes left the module", vp.createStore === undefined && vp.mount === undefined);
  const s = await scratch.startScratch({});
  try {
    await s.makeUser("vpadmin", "administrator");
    const ad = await s.signIn("vpadmin");
    check("the trial page answers 404", (await s.req("GET", "/joya-ai/voiceprint-trial", { cookie: ad.cookie })).status === 404);
    check("  and so does its API", (await s.req("GET", "/joya-ai/api/voiceprint-trial/status", { cookie: ad.cookie })).status === 404);
    const vs = await s.req("GET", "/joya-ai/settings/voice", { cookie: ad.cookie });
    check("Settings ▸ Voice no longer links to it, nor offers My trial recordings", vs.status === 200 && !/voiceprint-trial|from-trial|trial recordings \(/.test(vs.body), vs.status);
  } finally {
    s.stop();
  }
}

(async () => {
  try {
    unit();
    await server();
  } catch (e) {
    failed++;
    console.log("  FAIL no exception\n" + e.stack);
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
