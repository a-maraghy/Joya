/**
 * "Stop listening", said aloud: the spoken command that closes the mic.
 *
 *     node dashboard/tools/test-voice-stop.cjs
 *
 * The matcher (public/voice-stop.js) is required as it ships -- the same file
 * the browser loads and the server requires for the front desk -- and run on
 * English, Egyptian Arabic and mixed utterances, and on sentences that merely
 * contain the words, which must still be sent. Then the wiring: every page
 * loads it before console.js and joya-ai.js, the Command Center and the chat's
 * live mode check it before sending, and the desk ends the turn on it. The
 * flow itself (listening stops, nothing is sent) is run in
 * test-voice-stream.cjs, against the Voice module.
 */
"use strict";
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const VoiceStop = require(path.join(ROOT, "public", "voice-stop.js"));

let passes = 0;
let failures = 0;
function check(name, ok, detail) {
  if (ok) {
    passes++;
    return console.log("ok   " + name);
  }
  failures++;
  console.log("FAIL " + name + (detail ? "  (" + String(detail).slice(0, 300) + ")" : ""));
}
const misses = (list) => list.filter((s) => !VoiceStop.heard(s));
const hits = (list) => list.filter((s) => VoiceStop.heard(s));

/* ---- normalising ---- */
check("case and punctuation go", VoiceStop.norm("  Stop, LISTENING!!  ") === "stop listening");
check("hyphens join words with a space", VoiceStop.norm("Hands-free off.") === "hands free off");
check("Arabic: alef forms become ا", VoiceStop.norm("أقفل الإستماع آ ٱ") === "اقفل الاستماع ا ا");
check("Arabic: ى becomes ي and ة becomes ه", VoiceStop.norm("الجلسة المباشرة على") === "الجلسه المباشره علي");
check("Arabic: diacritics and tatweel go", VoiceStop.norm("وَقِّفْ الاسـتماع") === "وقف الاستماع");
check("Arabic punctuation goes (، ؟ ؛)", VoiceStop.norm("خلاص، اقفل الاستماع؟") === "خلاص اقفل الاستماع");
check("the article written onto an English word is split off", VoiceStop.norm("اقفل الـlive session") === "اقفل ال live session");
check("nothing in, nothing out", VoiceStop.norm(null) === "" && VoiceStop.norm(undefined) === "" && VoiceStop.norm("...") === "");

/* ---- English ---- */
const EN = [
  "stop listening", "Stop listening.", "STOP LISTENING!", "Stop live.", "stop live", "Close listening.",
  "Close the live session.", "close live session", "End the live session", "Stop the live session.",
  "Exit live mode.", "Turn off the mic.", "Switch off the microphone", "Mic off.", "Hands-free off.",
  "Stop hands-free.", "Pause listening.", "Stop listen.",
  "Okay, stop listening.", "Stop listening, please.", "Please stop listening now.", "Joya, stop listening.",
  "Hey Joya, close the live session.", "Stop listening for now, thanks.", "You can stop listening.",
];
check("English: every form of the command matches", misses(EN).length === 0, misses(EN).join(" | "));

/* ---- Egyptian Arabic, and Arabic with English words in it ---- */
const AR = [
  "وقف الاستماع", "وقّف الاستماع", "اوقف الاستماع", "اقفل الاستماع", "أقفل الإستماع", "قفل الاستماع",
  "اقفل ال live session", "اقفل الـlive session", "اقفل الـ live session.", "اقفل اللايف", "اقفل اللايف سيشن",
  "اقفل ال لايف سيشن", "وقف اللايف", "اقفل المايك", "اطفي المايك", "بطّل تسمع", "بطل الاستماع",
  "خلاص، اقفل الاستماع", "اقفل الاستماع من فضلك", "وقف الاستماع لو سمحت", "يا جويا وقف الاستماع",
  "وقف الاستماع يا جويا.", "اقفل الاستماع دلوقتي", "اقفل الجلسة المباشرة",
];
check("Arabic: every form of the command matches", misses(AR).length === 0, misses(AR).join(" | "));

/* ---- the phrases the administrator named ---- */
const NAMED = ["وقف الاستماع", "اقفل الاستماع", "اقفل ال live session", "stop listening", "stop live", "close listening"];
check("the administrator's own phrases are in the list, word for word", NAMED.every((p) => VoiceStop.phrases().indexOf(VoiceStop.norm(p)) >= 0));
check("the list is already normalised (what norm() makes of a phrase is itself)", VoiceStop.phrases().every((p) => VoiceStop.norm(p) === p), VoiceStop.phrases().filter((p) => VoiceStop.norm(p) !== p).join(" | "));

/* ---- not the command: sent as said ---- */
const NOT = [
  "why did the service stop listening on port 80",
  "Why did the service stop listening on port 80?",
  "the service stopped listening",
  "stop listening to port 80",
  "nginx should stop listening on port 8080 after the change",
  "don't stop listening",
  "can you check why it keeps stopping to listen",
  "stop", "Stop.", "close", "end", "listening", "live session",
  "stop the dashboard", "close the session", "end the session", "stop the service", "close the terminal",
  "stop the turn", "stop talking", "cancel that",
  "okay", "please", "joya", "thanks", "okay please", "يا جويا", "خلاص", "",
  "وقف", "اقفل", "وقف السيرفس", "اقفل البورت", "اقفل الجلسه",
  "ليه السيرفس وقف الاستماع على بورت 80", "هو ليه الخدمة بطلت تسمع على البورت",
  "stop listening stop listening stop listening stop listening stop listening",
];
check("sentences that merely contain the words are not the command", hits(NOT).length === 0, hits(NOT).join(" | "));
check("null and non-strings are not the command", !VoiceStop.heard(null) && !VoiceStop.heard(undefined) && !VoiceStop.heard(80));

/* ---- asked politely: "can you stop listening", "ممكن تقفل الاستماع" ---- */
const ASKED_EN = [
  "Okay, so, can you stop listening now?", // said to the live page, 2026-09-29, and missed
  "okay so can you stop listening now", "Can you stop listening?", "Could you stop listening, please?",
  "Would you close the live session?", "Will you stop live?", "Can you please stop listening.",
  "Could you please close the live session?", "I want you to stop listening.", "I need you to turn off the mic.",
  "Joya, can you stop listening, please?", "Hey Joya, could you stop listening for now, thanks.", "Can you mic off?",
];
check("English requests before the command match, with the usual polite words around them", misses(ASKED_EN).length === 0, misses(ASKED_EN).join(" | "));
const ASKED_AR = [
  "ممكن تقفل الاستماع دلوقتي", "ممكن تقفل الاستماع؟", "ممكن توقف الاستماع", "ممكن تـقفل الاستماع", "ممكن تـ قفل الاستماع",
  "ممكن اقفل الاستماع", "عايزك تقفل اللايف", "عاوزك تقفل المايك", "محتاجك تبطل تسمع", "يا ريت توقف الاستماع",
  "ياريت تقفل ال live session", "خلاص، ممكن تقفل الاستماع يا جويا", "طيب عايزك توقف اللايف سيشن دلوقتي",
];
check("Egyptian Arabic requests (ممكن / عايزك / يا ريت, the second-person verb) match", misses(ASKED_AR).length === 0, misses(ASKED_AR).join(" | "));
const NOT_ASKED = [
  "can you tell me why nginx stopped listening", "can you stop the dashboard", "can you close the session",
  "can you not stop listening", "can you", "could you please", "i want you to", "ممكن", "عايزك", "يا ريت",
  "can you can you stop listening", "can you stop listening on port 80", "could you check whether nginx will stop listening",
  "ممكن تقفل البورت", "عايزك تقولي ليه nginx وقف الاستماع", "ممكن تقفل الجلسه",
  "can you please please please stop listening to port 80 on the old box now",
];
check("a request for anything else, or with more in it, is not the command", hits(NOT_ASKED).length === 0, hits(NOT_ASKED).join(" | "));
check("the second-person verbs need a request in front of them", !VoiceStop.heard("تقفل الاستماع") && !VoiceStop.heard("توقف الاستماع") && VoiceStop.heard("ممكن تقفل الاستماع"));
check("the 9-word cap still holds with a request", !VoiceStop.heard("okay so joya can you please stop listening for now thanks") && VoiceStop.heard("okay so can you please stop listening now"));
check("the request list is the one asked for", ["can you", "could you", "would you", "will you", "can you please", "could you please", "i want you to", "i need you to", "ممكن", "ممكن ت", "عايزك", "عاوزك", "محتاجك", "يا ريت"].every((w) => VoiceStop.requests().indexOf(w) >= 0));
check("  and every request and second-person phrase is already normalised", VoiceStop.requests().concat(VoiceStop.asked()).every((p) => VoiceStop.norm(p) === p));

/* ---- ending the call (2026-09-29: "Now end the conversation, please." became a turn) ---- */
const END_EN = [
  "Perfect, thank you so much. Now end the conversation, please.", // said in live mode, 2026-09-29, and missed
  "perfect thank you so much now end the conversation please", "End the conversation.", "end the call", "End the call, please.",
  "Close the call.", "Stop the conversation.", "Finish the conversation.", "Hang up.", "Hang up, please.", "hang up now",
  "Close the live conversation.", "End the voice chat.", "Stop the voice chat.", "OK thanks, end the call.",
  "Great, thanks, hang up now.", "Thank you very much, end the call please.", "Can you end the conversation, please?",
  "Could you hang up the call?", "Thanks a lot. Now end this call.",
];
check("English: ending the call (conversation / call / live conversation / voice chat, and hang up), with pleasantries in front", misses(END_EN).length === 0, misses(END_EN).join(" | "));
const END_AR = [
  "اقفل المكالمة", "اقفل المكالمة لو سمحت", "انهي المحادثة", "وقف المكالمة", "سكر الكول", "اقفل الكلام ده",
  "ممكن تقفل المكالمة", "ممكن تقفلي المكالمة", "ممكن تنهي المحادثة", "عايزك تقفلي الكول", "يا ريت توقفي المكالمة",
  "اقفلي المكالمة", "وقفي الكلام ده", "بطلي الكلام ده", "سكري المكالمة", "انهي المحادثة من فضلك",
  "كفاية كده", "خلاص كده شكرا", "طيب، كفاية كده", "تمام شكرا، اقفل المكالمة", "شكراً جداً، كفاية كده", "ممكن تبطلي الكلام ده",
];
check("Egyptian Arabic: ending the call, masculine and feminine imperatives, «كفاية كده», «خلاص كده شكرا»", misses(END_AR).length === 0, misses(END_AR).join(" | "));
const NOT_END = [
  "end the conversation with the supplier in Odoo", "close the call log", "end the call with the supplier",
  "stop the call recording", "close the conversation window", "can you end the conversation with the supplier",
  "اقفل المكالمة مع العميل", "انهي المحادثة مع المورد", "اقفل الكول بتاع العميل", "ليه المكالمة وقفت",
  "that's all", "that is all", "we're done for now", "we are done for now", "I think we're done", "thank you", "perfect",
  "thank you so much", "perfect, thank you", "كده", "شكرا", "تمام", "خلاص", "the call", "the conversation", "hang",
  "why did the call end", "did you end the conversation", "hang up the logs", "كفاية", "كفاية كده من التقرير ده",
];
check("not ending the call: a qualifier, a question, pleasantries alone, \"that's all\"", hits(NOT_END).length === 0, hits(NOT_END).join(" | "));
check("pleasantries do not count toward the cap, the rest still does", VoiceStop.heard("Perfect, thank you so much. Now end the conversation, please.") && !VoiceStop.heard("okay so joya can you please stop listening for now thanks") && !VoiceStop.heard("perfect thank you so much now please end the conversation with the supplier in odoo today"));
check("  and every pleasantry is already normalised", VoiceStop.pleasantries().every((p) => VoiceStop.norm(p) === p));

/* ---- the wiring ---- */
const views = require(path.join(ROOT, "lib", "views-joyaai.js"));
const rbac = require(path.join(ROOT, "lib", "rbac.js"));
const html = views.page({ csrf: "t", user: { name: "a", perm: rbac.actor({ permissions: ["*"] }) }, voice: { configured: true, voice: "marin", model: "gpt-realtime-mini", manage: true } });
const at = (f) => html.search(new RegExp('<script src="/static/' + f.replace(".", "\\.") + '\\?v=[^"]+" defer></script>'));
check("every page loads voice-stop.js, before console.js and joya-ai.js", at("voice-stop.js") > 0 && at("voice-stop.js") < at("console.js") && at("console.js") < at("joya-ai.js"));
check("the file is a browser global and a CommonJS module, and pure", /^var VoiceStop = \(function \(\) \{/m.test(fs.readFileSync(path.join(ROOT, "public", "voice-stop.js"), "utf8")) &&
  !/document|window|localStorage|fetch\(/.test(fs.readFileSync(path.join(ROOT, "public", "voice-stop.js"), "utf8").replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "")));

const client = fs.readFileSync(path.join(ROOT, "public", "joya-ai.js"), "utf8");
check("Command Center: no push to talk or front desk left to check; the live call ends on it on the server and the page follows", !/function transcribeAndSend\(|function deskSend\(|isStopCommand/.test(client) && /"voice-command": "Stopped listening\. The live conversation has ended\.",/.test(client) && /if \(m\.type === "ended" \|\| m\.type === "error"\) liveEnded\(m\);/.test(client));

const chat = fs.readFileSync(path.join(ROOT, "public", "console.js"), "utf8");
const liveSend = chat.slice(chat.indexOf("function transcribeAndSend(blob)"), chat.indexOf("function recording(want)"));
check("the chat's live mode checks it too, before sending", /window\.VoiceStop && window\.VoiceStop\.heard\(said\)\) return stoppedByVoice\(\);/.test(liveSend) && liveSend.indexOf("VoiceStop") < liveSend.indexOf("send(said)"));
check("  and stops live mode as its button does, with a note", /function stoppedByVoice\(\) \{\s*stop\(\);\s*status\.textContent = "stopped listening";/.test(chat));

const server = fs.readFileSync(path.join(ROOT, "server.js"), "utf8");
check("the server requires the same file", /const voiceStop = require\("\.\/public\/voice-stop\.js"\);/.test(server));
check("the live call ends on it (isStop), and the front desk's route is gone", /isStop: \(t\) => voiceStop\.heard\(t\),/.test(server) && !/app\.post\("\/joya-ai\/api\/desk\/turn"/.test(server));


// ------------------------------------------------------------- spoken undo
const UNDO_YES = ["undo", "Undo.", "undo that", "Go back.", "never mind", "Nevermind!", "cancel that", "take that back", "Okay, undo that, please.", "Joya, go back", "can you undo that",
  "رجّعها", "رجعها", "رجع", "رجعي", "ارجعي", "ارجع", "الغي", "ألغي", "ألغي ده", "الغيها", "لأ خلاص", "لا خلاص", "رجعيها زي ما كانت", "ممكن ترجعها", "لو سمحت رجعيها", "يا جويا الغيها", "كانسل"];
const UNDO_NO = ["undo the last git commit", "go back to the Odoo question", "رجع للموضوع اللي فات", "never mind the report, what is the disk usage", "cancel the order for the supplier",
  "اقفلي المهام", "اقفل الميشنز", "close the missions", "stop listening", "ok", "خلاص", "لا", "go", "back"];
check("undo(): the whole-utterance undo command, English and Egyptian (both genders), polite forms", UNDO_YES.every((x) => VoiceStop.undo(x)), UNDO_YES.filter((x) => !VoiceStop.undo(x)).join(" | "));
check("undo(): never a request that mentions undoing, never a panel close, never a lone word", UNDO_NO.every((x) => !VoiceStop.undo(x)), UNDO_NO.filter((x) => VoiceStop.undo(x)).join(" | "));
check("undo and stop never overlap", UNDO_YES.every((x) => !VoiceStop.heard(x)) && VoiceStop.undoPhrases().every((x) => !VoiceStop.heard(x)));
check("«اقفلي المهام» / «اقفل الميشنز» / «اقفل المهام» (close the missions panel) are not the end-the-call command", !VoiceStop.heard("اقفلي المهام") && !VoiceStop.heard("اقفل الميشنز") && !VoiceStop.heard("اقفل المهام") && !VoiceStop.heard("close the missions"));
check("undo(): too long after pleasantries is a sentence", !VoiceStop.undo("thank you so much, but I really think we should go back and undo that one now please"));
{
  const client2 = fs.readFileSync(path.join(ROOT, "public", "joya-ai.js"), "utf8");
  check("Command Center, live: ui-undo from the server runs the same undo", /if \(m\.type === "ui-undo"\) uiUndoNow\("voice"\);/.test(client2));
  check("the toast's Undo button and the voice share one path (uiUndoNow), and a newer screen action replaces the undo", /uiUndoNow\("click"\)/.test(client2) && /uiUndoState = undo \? \{ fn: undo, el: el, until: Date\.now\(\) \+ UI_UNDO_MS \} : null;/.test(client2) && /uiUndoSignal\(undo \? UI_UNDO_MS : 0\);/.test(client2));
  const server2 = fs.readFileSync(path.join(ROOT, "server.js"), "utf8");
  check("the live call gets isUndo", /isUndo: \(t\) => voiceStop\.undo\(t\),/.test(server2));
}


// ------------------------------------------------ yes / no (Tier-2 confirm)
{
  const Y = ["yes", "Yes.", "Yes, please.", "yeah do it", "go ahead", "confirm", "Okay, go ahead.", "Joya, yes", "sure", "أيوه", "ايوه اعملها", "اه", "اعمليها", "ماشي", "موافق", "تمام أيوه"];
  const N = ["no", "No.", "no thanks", "cancel", "never mind", "لأ", "لا خلاص", "بلاش", "سيبها", "مش عايز"];
  const NEITHER = ["yes and restart odoo", "yes but first tell me the disk usage", "ok", "تمام", "what", "أيوه بس الأول قولي حالة أودو", "no idea what the disk says", "stop listening"];
  check("yes(): a whole yes, English and Egyptian, polite forms", Y.every((x) => VoiceStop.yes(x) && !VoiceStop.no(x)), Y.filter((x) => !VoiceStop.yes(x)).join(" | "));
  check("no(): a whole no", N.every((x) => VoiceStop.no(x) && !VoiceStop.yes(x)), N.filter((x) => !VoiceStop.no(x)).join(" | "));
  check("neither: a yes with a request after it, a bare ok/تمام, other sentences", NEITHER.every((x) => !VoiceStop.yes(x) && !VoiceStop.no(x)), NEITHER.filter((x) => VoiceStop.yes(x) || VoiceStop.no(x)).join(" | "));
}

// ------------------------------------ English written in Arabic script (2026-09-30)
// gpt-transcribe and whisper on this server write spoken English in Arabic script
// («ستوب الليسنينج», «يس», «اندو»); gpt-4o-mini-transcribe kept it Latin.
{
  const STOP = ["ستوب الليسنينج", "ستوب ليسنينج", "اند الكول", "كلوز الكول", "ستوب اللايف", "stop المايك", "اوكي ستوب الليسنينج", "ستوب ليسنينج بليز", "ممكن تقفل الكول", "عايزك تقفل الكول"];
  const NOT = ["ستوب", "اند", "ليه الريستارت وقف", "هل الريستارت خلص", "ستوب الريستارت بتاع اودو", "اعمل ريستارت للداشبورد"];
  check("stop: English verbs and objects in Arabic script", misses(STOP).length === 0, misses(STOP).join(" | "));
  check("  not: a bare verb, or a sentence about a restart", hits(NOT).length === 0, hits(NOT).join(" | "));
  const Y = ["يس", "يس بليز", "شور", "اوكي اعملها", "جو اهيد"];
  const N = ["نو", "نو ثانكس", "نوب"];
  check("yes / no in Arabic script", Y.every((x) => VoiceStop.yes(x) && !VoiceStop.no(x)) && N.every((x) => VoiceStop.no(x) && !VoiceStop.yes(x)), Y.concat(N).filter((x) => !VoiceStop.yes(x) && !VoiceStop.no(x)).join(" | "));
  check("  a bare «اوكي» is not a yes (as a bare ok is not), and «يس ريستارت الداشبورد» is a request", !VoiceStop.yes("اوكي") && !VoiceStop.yes("يس ريستارت الداشبورد"));
  check("undo in Arabic script", ["اندو", "اندو ده", "اندو بليز"].every((x) => VoiceStop.undo(x)) && !VoiceStop.undo("اندو الريستارت بتاع امبارح لو ينفع"));
}

console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
