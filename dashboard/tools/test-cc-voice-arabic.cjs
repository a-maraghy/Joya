#!/usr/bin/env node
"use strict";
/**
 * Arabic transcripts through the server's voice intake and guards
 * (lib/voice-intake.js, lib/voice-guard.js): what de1b247 fixed -- words were
 * split on [^a-z0-9], so an Arabic transcript had no words and was dropped as
 * empty -- held here, with the Command Center's intake exactly as the direct
 * path (/joya-ai/api/transcribe) and the desk use it.
 *
 *     NODE_PATH=/opt/joya-dashboard/node_modules node dashboard/tools/test-cc-voice-arabic.cjs
 */
const path = require("path");
const ROOT = path.join(__dirname, "..");
const intake = require(path.join(ROOT, "lib", "voice-intake.js"));
const guard = require(path.join(ROOT, "lib", "voice-guard.js"));

let passed = 0;
let failed = 0;
function check(name, ok, detail) {
  if (ok) { passed++; console.log("ok   " + name); }
  else { failed++; console.log("FAIL " + name + (detail !== undefined ? "  (" + String(detail).slice(0, 300) + ")" : "")); }
}

const AR = "ما هي حالة الخدمات على هذا الخادم؟";
const MIXED = "اعمل restart للـ nginx service من فضلك";
const audio = Buffer.alloc(8000, 1); // well past MIN_AUDIO_BYTES
const level = { ms: 2600, loud_ms: 1500, peak: 0.2 };
const usage = { input_token_details: { audio_tokens: 26 } }; // 2.6 s of audio
const fakeTranscribe = (text) => async () => ({ text, usage });

(async () => {
  check("an Arabic transcript has words", guard.checkTranscript(AR, { audioSeconds: 2.6 }).ok, JSON.stringify(guard.checkTranscript(AR, { audioSeconds: 2.6 })));
  check("…so does Arabic with English words in it", guard.checkTranscript(MIXED, { audioSeconds: 2.6 }).ok);
  check("an empty transcript is still dropped", !guard.checkTranscript("   ", {}).ok && guard.checkTranscript("   ", {}).rule === "empty");
  let got = await intake.intake({ audio, mime: "audio/webm", level, cfg: {}, transcribe: fakeTranscribe(AR) });
  check("intake: an Arabic sentence passes, word for word", !got.dropped && got.text === AR, JSON.stringify(got.dropped));
  got = await intake.intake({ audio, mime: "audio/webm", level, cfg: {}, transcribe: fakeTranscribe(MIXED) });
  check("intake: a mixed Arabic/English sentence passes", !got.dropped && got.text === MIXED, JSON.stringify(got.dropped));
  got = await intake.intake({ audio: Buffer.alloc(100), mime: "audio/webm", level, cfg: {}, transcribe: fakeTranscribe(AR) });
  check("intake: a tiny clip is still not sent to OpenAI (whatever the language)", got.dropped === "tiny" && got.text === "");
  const grounds = { m: new Map(), remember(a, vt, t) { this.m.set(a + vt, t); }, take(a, vt, t) { const ok = this.m.get(a + vt) === t; this.m.delete(a + vt); return ok; } };
  got = await intake.transcribeTurn({ audio, mime: "audio/webm", level, cfg: {}, transcribe: fakeTranscribe(AR), grounds, actor: "ann", vt: "v1abc" });
  check("the direct path remembers an Arabic transcript for its voice turn", !got.dropped && grounds.m.get("annv1abc") === AR);
  check("…and the send that follows with that text is let through", intake.sendRefusal({ grounds, actor: "ann", body: { vt: "v1abc" }, text: AR }) === null);
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.log("FAIL no exception\n" + e.stack); process.exit(1); });
