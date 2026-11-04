"use strict";
/**
 * The voiceprint's recording material: the enrolment paragraphs and the
 * microphone slots the guided enrolment (/joya-ai/voiceprint/enrol,
 * lib/voiceprint-routes.js) records with, and the WAV helpers it uses
 * (parse, resample to 16 kHz, peak level).
 *
 * This file began as the voiceprint trial, Phase 1 (/joya-ai/voiceprint-trial):
 * the administrator recorded a trial set once (7 Oct 2026) and the enrolment
 * was made from it. The trial page, its routes and its store were removed on
 * 2026-10-25 (the recordings were archived under /root/backups); the test
 * phrases (TESTS) stay for the offline harness in tools/voiceprint/.
 */
const SLOTS = Object.freeze([
  { id: "laptop", label: "Laptop microphone" },
  { id: "headset", label: "Headset" },
  { id: "other", label: "Other microphone" },
]);

/* About 60 s of natural reading to enrol on: English, Egyptian, mixed, numbers. */
const ENROL = Object.freeze([
  { id: "e1", part: "enrol", lang: "en", kind: "reading", text: "I'm checking in on the server this morning. Tell me whether Odoo is running, how full the disk is, and if any service failed overnight. After that, open the agents page and read me the last thing JOYA AI did on the planning mission, slowly, so I can follow." },
  { id: "e2", part: "enrol", lang: "ar", kind: "reading", text: "صباح الخير يا JOYA. عايز أعرف الدنيا ماشية إزاي النهارده. شوفلي أودو شغال ولا لأ، والديسك مليان قد إيه، وفيه أي خدمة وقعت بالليل. وبعد كده افتحلي صفحة الإيجنتس وقولي آخر حاجة اتعملت في المهمة، بالراحة عشان أفهم." },
  { id: "e3", part: "enrol", lang: "mixed", kind: "reading", text: "إمبارح كنت بشتغل على الـ allocation engine لحد بالليل. الـ run الأخير طلع واحد وأربعين order، وفيه شوية proposals محتاجة review. لو سمحت ابعتلي summary بالأرقام على تيليجرام، وفكرني الصبح أراجع الـ purchase plan مع الفريق." },
  { id: "e4", part: "enrol", lang: "en", kind: "reading", text: "The numbers I care about are simple: twelve cores, forty-seven gigabytes of memory, and about four hundred and seventy gigabytes free on the disk. If any of those change much, tell me before you do anything else, and keep the answer short." },
]);

/* The test phrases: what a press of the talk key really carries, shortest first. */
const TESTS = Object.freeze(
  [
    ["en", "short", "Yes."],
    ["en", "short", "No."],
    ["en", "short", "Stop."],
    ["ar", "short", "نعم."],
    ["ar", "short", "لأ."],
    ["ar", "short", "خلاص."],
    ["mixed", "short", "Okay يا JOYA."],
    ["en", "command", "Open the agents page."],
    ["en", "command", "Restart the dashboard."],
    ["en", "command", "Stop listening."],
    ["en", "command", "Send me the report on Telegram."],
    ["ar", "command", "اقفل المكالمة."],
    ["ar", "command", "افتح صفحة الخدمات."],
    ["ar", "command", "امسح الباك اب القديم لو سمحت."],
    ["mixed", "command", "اعمل restart للـ dashboard."],
    ["en", "number", "Forty-one percent."],
    ["en", "number", "The order is P M O nine zero seven seven."],
    ["en", "number", "Twelve thousand kilos, by the first of September."],
    ["ar", "number", "واحد وأربعين في المية."],
    ["ar", "number", "الساعة اتنين وربع."],
    ["en", "question", "Is Odoo running?"],
    ["en", "question", "What did JOYA AI do last?"],
    ["ar", "question", "الديسك مليان قد إيه؟"],
    ["ar", "question", "فيه موافقات مستنياني؟"],
    ["mixed", "question", "الـ memory usage عامل إيه؟"],
    ["mixed", "question", "شوفلي الـ status بتاع الـ server."],
    ["mixed", "sentence", "Okay JOYA، كمل اللي كنت بتعمله."],
    ["en", "sentence", "Please check the disk and tell me if anything failed overnight."],
    ["ar", "sentence", "عايزك تراجع خطة الشرا وتقولي فيه إيه جديد النهارده."],
    ["mixed", "sentence", "ابعتلي الـ summary بتاع الـ run الأخير قبل الـ meeting."],
  ].map(([lang, kind, text], i) => Object.freeze({ id: "t" + String(i + 1).padStart(2, "0"), part: "test", lang, kind, text }))
);

const PHRASES = Object.freeze([...ENROL, ...TESTS]);
const LIMITS = Object.freeze({ enrol: { min: 3, max: 40 }, test: { min: 0.3, max: 12 } });
const MAX_BYTES = 44 + 40 * 24000 * 2 + 1024; // 40 s at 24 kHz PCM16, with room for a header

/** A user's folder name: the username when it is plain, else u<id>. */
function userDirName(user) {
  const u = String((user && user.username) || "");
  return /^[A-Za-z0-9._-]{1,64}$/.test(u) && !/^\.+$/.test(u) ? u : "u" + Number(user && user.id);
}

/** A WAV -> {rate, samples: Int16Array} (PCM16 mono, 16 or 24 kHz), or throws a plain reason. */
function parseWav(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 44 || buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WAVE") throw new Error("That is not a WAV recording.");
  let at = 12;
  let fmt = null;
  while (at + 8 <= buf.length) {
    const id = buf.toString("ascii", at, at + 4);
    const size = buf.readUInt32LE(at + 4);
    if (id === "fmt " && at + 24 <= buf.length) fmt = { format: buf.readUInt16LE(at + 8), channels: buf.readUInt16LE(at + 10), rate: buf.readUInt32LE(at + 12), bits: buf.readUInt16LE(at + 22) };
    if (id === "data") {
      if (!fmt || fmt.format !== 1 || fmt.channels !== 1 || fmt.bits !== 16 || (fmt.rate !== 24000 && fmt.rate !== 16000)) throw new Error("The recording must be PCM16 mono at 16 or 24 kHz.");
      const end = Math.min(buf.length, at + 8 + size);
      const n = Math.floor((end - at - 8) / 2);
      const copy = Buffer.from(buf.subarray(at + 8, at + 8 + n * 2)); // aligned
      return { rate: fmt.rate, samples: new Int16Array(copy.buffer, copy.byteOffset, n) };
    }
    at += 8 + size + (size % 2);
  }
  throw new Error("There is no audio in that recording.");
}

/* 24 kHz -> 16 kHz: a 2:3 polyphase windowed-sinc low-pass (cut-off 7.2 kHz, 48 taps a phase). */
const HALF = 24;
const PHASES = [0, 0.5].map((frac) => {
  const fc = 7200 / 24000; // cycles per input sample
  const h = [];
  for (let k = -HALF + 1; k <= HALF; k++) {
    const t = k - frac;
    const sinc = t === 0 ? 2 * fc : Math.sin(2 * Math.PI * fc * t) / (Math.PI * t);
    const w = 0.42 + 0.5 * Math.cos((Math.PI * t) / HALF) + 0.08 * Math.cos((2 * Math.PI * t) / HALF); // Blackman
    h.push(Math.abs(t) < HALF ? sinc * w : 0);
  }
  const s = h.reduce((a, b) => a + b, 0);
  return h.map((v) => v / s);
});

function to16k(samples, rate) {
  if (rate === 16000) return Int16Array.from(samples);
  const n = Math.floor((samples.length * 2) / 3);
  const out = new Int16Array(n);
  for (let i = 0; i < n; i++) {
    const pos = i * 1.5;
    const base = Math.floor(pos);
    const h = PHASES[pos - base === 0 ? 0 : 1];
    let acc = 0;
    for (let k = -HALF + 1, j = 0; k <= HALF; k++, j++) {
      const idx = base + k;
      if (idx >= 0 && idx < samples.length) acc += samples[idx] * h[j];
    }
    out[i] = acc > 32767 ? 32767 : acc < -32768 ? -32768 : Math.round(acc);
  }
  return out;
}

function wav16(samples) {
  const b = Buffer.alloc(44 + samples.length * 2);
  b.write("RIFF", 0, "ascii");
  b.writeUInt32LE(36 + samples.length * 2, 4);
  b.write("WAVEfmt ", 8, "ascii");
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(1, 22);
  b.writeUInt32LE(16000, 24);
  b.writeUInt32LE(32000, 28);
  b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34);
  b.write("data", 36, "ascii");
  b.writeUInt32LE(samples.length * 2, 40);
  Buffer.from(samples.buffer, samples.byteOffset, samples.length * 2).copy(b, 44);
  return b;
}

/** Peak level of a clip in dBFS (a silent or clipped recording is refused). */
function peakDb(samples) {
  let p = 0;
  for (let i = 0; i < samples.length; i++) {
    const v = Math.abs(samples[i]);
    if (v > p) p = v;
  }
  return p ? 20 * Math.log10(p / 32768) : -Infinity;
}

module.exports = { SLOTS, ENROL, TESTS, PHRASES, LIMITS, MAX_BYTES, userDirName, parseWav, to16k, wav16, peakDb };
