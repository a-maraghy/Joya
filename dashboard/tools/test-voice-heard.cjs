#!/usr/bin/env node
"use strict";
/**
 * lib/voice-heard.js: which of a live turn's transcripts goes to JOYA AI, and
 * the note beside it. Pure; no network. The texts are what the transcription
 * models really wrote on 2026-10-21/22 (JOYA AI's requests 377-382) and when
 * the administrator's voiceprint-trial clips were replayed through them.
 *
 *     node dashboard/tools/test-voice-heard.cjs
 */
const path = require("path");
const heard = require(path.join(__dirname, "..", "lib", "voice-heard.js"));

let passed = 0;
let failed = 0;
function check(name, cond, detail) {
  if (cond) {
    passed++;
    console.log("  ok   " + name);
  } else {
    failed++;
    console.log("  FAIL " + name + (detail !== undefined ? "\n       " + String(detail).slice(0, 500) : ""));
  }
}
const section = (t) => console.log("\n" + t);

section("assess: the administrator speaks Egyptian Arabic and English");
for (const dict of [undefined, null]) {
  const tag = dict === null ? " (no system word list)" : "";
  const q = (t, ms) => heard.assess(t, { speechMs: ms, dict });
  // wrong language: another script, or Latin text that is not English
  for (const t of ["სათნომრობა.", "Έλα φίλε μου, κάλμα.", "Привет, как дела"]) check(`«${t}» is the wrong language (another script)${tag}`, q(t).quality === "wrong-language" && q(t).lang === "other");
  for (const t of ["La parte más vital es difícil", "Hämmer restart li dashboard.", "Hämmer restart li dashboard.".normalize("NFD"), "Não.", "la", "Naam.", "Didskemelian ad", "Qiddiska kameleenaaddi."]) {
    check(`«${t}» is the wrong language (not English)${tag}`, q(t).quality === "wrong-language" && q(t).lang === "foreign", JSON.stringify(q(t)));
  }
  // right
  for (const t of ["Is Odoo running?", "Restart the dashboard.", "Send me the report on Telegram.", "Claude, you don't trust everything, so please check what's happening", "41%", "Yes.", "Stop listening."]) {
    check(`«${t}» is English${tag}`, q(t, 1200).quality === "good" && q(t).lang === "en", JSON.stringify(q(t, 1200)));
  }
  for (const t of ["الـ memory usage عامل إيه؟", "عايزك تراجع خطة الشراء وتقولي في إيه جديد النهارده", "لا", "خلاص"]) check(`«${t}» is Arabic${tag}`, q(t, 1500).quality === "good" && q(t).lang === "ar");
  check(`a mixed «اعمل restart للـ dashboard» reads right${tag}`, q("اعمل restart للـ dashboard", 1500).quality === "good");
}
{
  // too short for the speech measured in the turn
  const a = heard.assess("أريد أن أعود.", { speechMs: 4400 });
  check("«أريد أن أعود.» for 4.4 s of speech is cut short (request 377)", a.quality === "short" && a.lang === "ar", JSON.stringify(a));
  check("«إلا إحنا نناقص» for 5.2 s of speech is cut short (request 378)", heard.assess("إلا إحنا نناقص", { speechMs: 5160 }).quality === "short");
  check("a one-word answer in a short turn is not", heard.assess("لأ", { speechMs: 900 }).quality === "good" && heard.assess("Yes.", { speechMs: 1500 }).quality === "good");
  check("without a measured speech length nothing is called short", heard.assess("أريد أن أعود.", {}).quality === "good");
  check("an empty transcript is empty", heard.assess("  ", {}).quality === "empty" && heard.assess("...", {}).quality === "empty");
}

section("choose: the transcript JOYA AI gets");
{
  const c = heard.choose([{ source: "turn", text: "La parte más vital es difícil" }, { source: "session", text: "عايزك تراجع الجزء ده تاني وتقولي إيه أهم حاجة فيه" }], { speechMs: 4000 });
  check("request 380: the session's Arabic over the full-turn Spanish", c.pick.source === "session");
  check("  the Spanish is not offered as another reading (wrong language)", c.also === null);
  check("  no second try needed", heard.retryLanguage(c, "anything") === null);
  check("  and no note", heard.noteFor(c, "Review this part again") === "");
}
{
  const c = heard.choose([{ source: "turn", text: "أريد أن أعود." }, { source: "session", text: "طب ارجع للموضوع اللي كنا بنتكلم فيه الصبح عن خطة الشرا" }], { speechMs: 4400 });
  check("request 377: the complete one over the one cut short", c.pick.source === "session");
  check("  the short one is offered as another reading", c.also && c.also.source === "turn");
  const n = heard.noteFor(c, "Go back to the purchase plan");
  check("  the note names it, and leaves the voice's wording out (a transcript read right)", /Another transcription of the same audio: «أريد أن أعود\.»/.test(n) && !/live voice/.test(n), n);
}
{
  const c = heard.choose([{ source: "turn", text: "please check the disk and tell me if anything failed" }, { source: "session", text: "Please check the disk, and tell me if anything failed." }], { speechMs: 2500 });
  check("two that agree: the full-turn one, no note", c.pick.source === "turn" && c.also === null && heard.noteFor(c, "x") === "");
}
{
  const c = heard.choose([{ source: "turn", text: "12,000 kilos by the 1st of September." }, { source: "session", text: "Twelve thousand kilos by the first of September." }], { speechMs: 2500 });
  check("digits against number words is not worth a note", heard.noteFor(c, "") === "", JSON.stringify(c.also));
}
{
  const c = heard.choose([{ source: "turn", text: "عايزك تعمل ريستارت للداشبورد" }, { source: "session", text: "عايزك تعمل ريستارت للداش" }], {});
  check("a session transcript cut at the end is not 'another reading'", c.pick.source === "turn" && c.also === null);
}
{
  const c = heard.choose([{ source: "turn", text: "Joya" }, { source: "session", text: "Stop listening." }], { speechMs: 1500 });
  check("a much longer one at the same quality is the more complete one", c.pick.source === "session");
}
{
  const c = heard.choose([{ source: "turn", text: "Έλα φίλε μου, κάλμα." }, { source: "session", text: "Naam." }], { speechMs: 1500 });
  check("neither reads right: the language to try again in follows the live voice's understanding (Arabic)", heard.retryLanguage(c, "اقفل المكالمة") === "ar");
  check("  (English when the voice understood English)", heard.retryLanguage(c, "Close the call.") === "en");
  check("  (Arabic when the voice said nothing: the language these models mislabel)", heard.retryLanguage(c, "") === "ar");
  const c2 = heard.choose([{ source: "turn", text: "Έλα φίλε μου, κάλμα." }, { source: "session", text: "Naam." }, { source: "retry-ar", text: "اقفل المكالمة دلوقتي" }], { speechMs: 1500 });
  check("  the pinned transcript wins when it reads right", c2.pick.source === "retry-ar" && heard.noteFor(c2, "اقفل المكالمة") === "");
}
{
  const c = heard.choose([{ source: "turn", text: "Didskemelian ad" }, { source: "session", text: "Qiddiska kameleenaaddi." }], { speechMs: 2000 });
  const n = heard.noteFor(c, "How full is the disk?");
  check("nothing reads right: the note says so and carries what the voice understood, marked as its wording", /may have misheard this turn.*like the wrong language/.test(n) && /The live voice understood it as: «How full is the disk\?» \(its own wording, not theirs\)/.test(n) && /if it is still unclear, ask them/.test(n), n);
  check("  the note is bounded", heard.noteFor(c, "x".repeat(5000)).length < 1000);
}
check("no candidate with words: nothing to choose", heard.choose([{ source: "turn", text: "" }, { source: "session", text: null }], {}) === null);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
