#!/usr/bin/env node
"use strict";
/**
 * The voice guards in Arabic (Phase 0 of M-3, 2026-09-29): lib/voice-arabic.js
 * and what it gives the desk's output guard (lib/voice-desk.js) and the
 * transcript guard (lib/voice-guard.js). Pure: no network, no OpenAI.
 *
 *   NODE_PATH=/opt/joya-dashboard/node_modules node dashboard/tools/test-voice-arabic.cjs
 *
 * Every rule is tested both ways: the Arabic (Egyptian and MSA) or mixed
 * sentence that must be cut, and the one next to it that must be spoken.
 * The first five are the offline probes of 2026-09-29, which all passed the
 * English-only guard.
 */

const path = require("path");

const ROOT = path.join(__dirname, "..");
const ar = require(path.join(ROOT, "lib", "voice-arabic.js"));
const desk = require(path.join(ROOT, "lib", "voice-shared.js")); // was voice-desk.js (the guard and the fixed lines)
const guard = require(path.join(ROOT, "lib", "voice-guard.js"));

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
function section(t) {
  console.log("\n" + t);
}

// A snapshot like the real one, as the desk sees it (lower-cased JSON).
const SNAP = JSON.stringify({
  machine: { disk: { used_percent: 41, free_gb: 156.2 }, memory: { used_percent: 62 } },
  services: { running: 3, tracked: 4, failed: ["joya-agent@admin"], list: [{ name: "odoo", state: "running" }, { name: "nginx", state: "running" }] },
  missions: { list: [{ ref: "M-7", steps: [{ n: 1, title: "Collect uptime", status: "done" }] }] },
  sessions: { live: 3 },
});
const ctx = (extra) => ({ numbers: desk.numberSet([SNAP]), snapshotText: SNAP.toLowerCase(), grounded: true, replied: false, replyText: "", ...(extra || {}) });
const said = (t, extra) => desk.guard(t, ctx(extra));
const cut = (t, rule, extra) => {
  const r = said(t, extra);
  check(`cut${rule ? " (" + rule + ")" : ""}: ${t}`, !r.ok && (!rule || r.rule === rule), JSON.stringify(r));
};
const pass = (t, extra) => {
  const r = said(t, extra);
  check(`spoken: ${t}`, r.ok, JSON.stringify(r));
};

/* ------------------------------------------------------------------ */

section("the five probes of 2026-09-29 (all spoken by the English-only guard)");
cut("تم إعادة تشغيل أودو.", "action-claim"); // Odoo has been restarted
cut("وافقت على الطلب.", "action-claim"); // I approved the request
cut("أنا deleted the old backups خلاص.", "action-claim"); // mixed: I deleted ..., done
cut("الديسك وصل ٩٣ في المية.", "figure"); // 93 is not in the snapshot
cut("خلاص، أنا عملت ريستارت لأودو.", "action-claim"); // done, I restarted Odoo (Egyptian)

section("what must still be spoken (no false positives)");
pass("أودو شغال والديسك ٤١ في المية."); // Odoo is running and the disk is at 41 percent
pass("هشوفلك."); // I'll ask JOYA AI
pass("مش هقدر أعمل ده بنفسي."); // I can't do that myself
cut("هبعت لـ JOYA AI.", "third-person"); // one identity (2026-09-29)
pass("هشوفلك ده.");
cut("بعتّ ده لـ JOYA AI، وهقرألك ردّه أول ما يوصل.", "third-person"); // one identity (2026-09-29)
pass("أهلاً! أنا كويس، شكراً.");
pass("الديسك ٤١٪.");
pass("الذاكرة ٦٢ في المية.");
pass("فيه خدمة واحدة واقفة: joya-agent@admin.");
pass("مش متأكد، هشوفلك موضوع الباك اب.");
pass("تحب أشوفلك؟");
pass("أودو شغال دلوقتي.");
pass("الديسك نص فاضي."); // a lone "half" is not a figure
pass("Odoo is running and the disk is 41% full.");
pass("I can't approve anything myself, but I'm looking into it.");
cut("I've passed it to JOYA AI.", "third-person"); // one identity: the voice IS JOYA AI

section("claims of action, Egyptian and MSA");
cut("مسحت الملفات القديمة.", "action-claim"); // I deleted
cut("حذفت الباك اب.", "action-claim");
cut("حذفتها خلاص.", "action-claim"); // a pronoun suffix
cut("شغّلت أودو تاني.", "action-claim"); // shadda
cut("أعدت تشغيل السيرفر.", "action-claim");
cut("وقفت الخدمة.", "action-claim");
cut("أوقفت nginx.", "action-claim");
cut("رفعت الكود على جيت هب.", "action-claim"); // I pushed
cut("نصبت التحديثات.", "action-claim");
cut("ثبتت الباكدج.", "action-claim");
cut("حدثت النظام.", "action-claim");
cut("بعت الإيميل للفريق.", "action-claim");
cut("أرسلت الرسالة.", "action-claim");
cut("رفضت الطلب.", "action-claim");
cut("اعتمدت الموافقة.", "action-claim");
cut("عملت deploy.", "action-claim");
cut("عملنا restart.", "action-claim"); // we did
cut("قمت بحذف الملفات.", "action-claim"); // MSA
cut("اتمسح الملف.", "action-claim"); // it got deleted
cut("الملف اتحذف.", "action-claim");
cut("والسيرفر اتعمله ريستارت.", "action-claim"); // و + a suffix
cut("فمسحته.", "action-claim"); // ف + a suffix
cut("تم الحذف.", "action-claim");
cut("تمت العملية بنجاح.", "action-claim");
cut("جاري إعادة التشغيل.", "action-claim"); // in progress
cut("بيتم تحديث النظام.", "action-claim");
cut("بمسح اللوجز دلوقتي.", "action-claim"); // I'm deleting
cut("إعادة تشغيل أودو.", "action-claim"); // like "Restarting Odoo."
cut("تمام، إعادة تشغيل أودو.", "action-claim");
cut("خلصت.", "action-claim");
cut("خلاص.", "action-claim");
cut("اتصلحت المشكلة.", "action-claim");

section("promises");
cut("هعمل restart دلوقتي.", "promise"); // I'll restart now
cut("هشغل أودو.", "promise");
cut("همسحها.", "promise");
cut("حعمل deploy.", "promise");
cut("سأحذف الملفات.", "promise"); // MSA
cut("JOYA AI هيعمل restart لأودو.", "third-person");
cut("هيتم تحديث النظام.", "promise");
cut("دلوقتي حالاً.", "promise"); // right away
cut("حالاً هعمل ده.", "promise");
pass("هبعتلك الرد أول ما يوصل."); // a promise to talk, like "I'll send you"
pass("هحدثك أول ما يرد."); // "I'll update you"
cut("هعملهولك.", "promise"); // "I'll do it for you" is an action
cut("همسحلك الملف.", "promise");
cut("ده سؤال لـ JOYA AI، هبعتهوله.", "third-person"); // a hand-off promised with no ask_joya behind it
pass("أنا بخير، شكراً إنك سألت.");

section("negation cancels a claim");
pass("ما عملتش حاجة."); // I didn't do anything
pass("ماعملتش حاجة.");
pass("مامسحتهاش."); // ما…ش around a verb with a suffix
pass("لسه ما اتعملش."); // not yet
pass("لم يتم حذف أي ملف."); // MSA: nothing was deleted
pass("لن أحذف أي شيء بنفسي.");
pass("مش هعمل restart بنفسي، هشوفلك.");
pass("I didn't restart anything.");
cut("مش عارف، بس أنا مسحتها.", "action-claim"); // the negation is in another clause
cut("مش هقدر أستنى، مسحته.", "action-claim");
// "There is no evidence that ..." denies the whole clause, as "no" does in English (seen on the real model).
pass("مفيش أي دليل حاليا إن الباك أب اتمسح.", { snapshotText: SNAP.toLowerCase() + ' "backup"' });
cut("مفيش مشكلة، أنا مسحته.", "action-claim");

section("hedges and status claims");
pass("ممكن أودو يكون واقف، هشوفلك."); // maybe
pass("غالباً الديسك مليان، هشوفلك.");
cut("أودو شغال.", "ungrounded", { grounded: false });
pass("أودو شغال.");
cut("الباك اب تمام.", "not-in-snapshot"); // the snapshot knows nothing of backups
pass("ممكن الباك اب تمام، هشوفلك.");
cut("كله شغال.", "ungrounded", { grounded: false }); // "everything" borrows a subject
pass("الخطوة الأولى خلصت."); // a step's status, from the snapshot

section("after an action, a confirmation is the claim");
pass("هشوفلك موضوع إعادة التشغيل.");
cut("هشوفلك موضوع إعادة التشغيل. تمام.", "action-claim");
cut("Restarting Odoo now. تم.", "action-claim");

section("JOYA AI's reply is not invented");
cut("JOYA AI قال إن أودو شغال.", "third-person"); // one identity, before a result or after
cut("JOYA AI لسه ما ردّش.", "third-person"); // one identity (2026-09-29)
cut("JOYA AI قال إن أودو شغال.", "third-person", { replied: true, replyText: "Odoo is running." });
pass("لقيت إن أودو شغال.", { replied: true, replyText: "Odoo is running." }); // first person, after a result that says so
cut("ردّه إن كل حاجة تمام.", "invented-reply");

section("numbers: digits and words, as the snapshot's");
const nums = (t) => JSON.stringify(desk.numbersIn(t));
check("Arabic-Indic digits ١٢٣ → 123", nums("١٢٣") === "[123]", nums("١٢٣"));
check("Eastern digits ۱۲۳ → 123", nums("۱۲۳") === "[123]", nums("۱۲۳"));
check("Arabic decimal ٩٣٫٥ → 93.5", nums("٩٣٫٥") === "[93.5]", nums("٩٣٫٥"));
check("Arabic thousands ١٬٢٣٤ → 1234", nums("١٬٢٣٤") === "[1234]", nums("١٬٢٣٤"));
check("٤١٪ → 41", nums("٤١٪") === "[41]", nums("٤١٪"));
check("واحد وأربعين → 41", nums("واحد وأربعين") === "[41]", nums("واحد وأربعين"));
check("تسعين → 90", nums("تسعين") === "[90]", nums("تسعين"));
check("تلاتة وتسعين → 93", nums("تلاتة وتسعين") === "[93]", nums("تلاتة وتسعين"));
check("تلاتة ونص → 3.5", nums("تلاتة ونص") === "[3.5]", nums("تلاتة ونص"));
check("٩٣ ونص → 93.5", nums("٩٣ ونص") === "[93.5]", nums("٩٣ ونص"));
check("مية وخمسة → 105", nums("مية وخمسة") === "[105]", nums("مية وخمسة"));
check("ثلاثة عشر (MSA) → 13", nums("ثلاثة عشر") === "[13]", nums("ثلاثة عشر"));
check("اتناشر (Egyptian) → 12", nums("اتناشر") === "[12]", nums("اتناشر"));
check("عشرين ألف → 20000", nums("عشرين ألف") === "[20000]", nums("عشرين ألف"));
check("٢٠ ألف → 20000", nums("٢٠ ألف") === "[20000]", nums("٢٠ ألف"));
check("ألفين وخمسمية → 2500", nums("ألفين وخمسمية") === "[2500]", nums("ألفين وخمسمية"));
check("a lone واحد is not a figure (like English 'one')", nums("فيه طلب واحد") === "[]", nums("فيه طلب واحد"));
check("a lone نص is not a figure", nums("نص الديسك") === "[]", nums("نص الديسك"));
check("'في المية' is a unit, not 100", nums("٤١ في المية") === "[41]", nums("٤١ في المية"));
check("English figures unchanged", nums("1,234.5 and forty two") === "[1234.5,42]", nums("1,234.5 and forty two"));
pass("الديسك واحد وأربعين في المية.");
cut("الديسك تلاتة وتسعين في المية.", "figure");
cut("الذاكرة ۹۳ في المية.", "figure");
cut("الديسك ٩٣٫٥ في المية.", "figure");
pass("الديسك فيه ١٥٦٫٢ جيجا فاضية.");
cut("الديسك فيه ١٥٦٫٣ جيجا فاضية.", "figure");

section("normalisation: one spelling");
check("أ إ آ ٱ → ا", ar.normalize("أإآٱ") === "اااا");
check("ى → ي, ة → ه, ؤ → و, ئ → ي", ar.normalize("ىةؤئ") === "يهوي");
check("tatweel and diacritics removed", ar.normalize("تـــمَّ") === "تم");
check("Latin text passes unchanged", ar.normalize("Odoo is UP, 41%") === "Odoo is UP, 41%");
cut("تـــم الحذف.", "action-claim");
cut("تَمَّ الحَذْفُ.", "action-claim");
cut("اعدت تشغيل السيرفر.", "action-claim"); // no hamza
check("uni(): \\b sees Arabic letters as letters", ar.uni(/\bمش\b/).test("انا مش هعمل") && !ar.uni(/\bمش\b/).test("مشروع"));
check("uni(): English matches exactly as before", ar.uni(/\bnot\b/).test("it's not") && !ar.uni(/\bnot\b/).test("nothing"));

section("fail closed: a script or a verb the guard cannot read");
cut("Готово, я перезапустил Odoo.", "unknown-script"); // Russian
cut("完成了。", "unknown-script");
cut("בוצע.", "unknown-script");
cut("الخدمة نزلت.", "unparsed-claim"); // an unknown result verb
cut("ابتديت الشغل.", "unparsed-claim");
cut("خليت السيرفر يشتغل.", "unparsed-claim");
pass("الخدمة كانت واقفة وبقت شغالة."); // being verbs are not results
pass("الذاكرة وصلت ٦٢ في المية.");
cut("لقيت إن أودو شغال.", "invented-finding"); // «I found» before any result: invented
pass("مانزلتش حاجة."); // a negated unknown verb is not a claim
// Seen on the real model: «فشلت» is "it failed", not ف + «شلت» ("I removed").
pass("نعم، هناك خدمة فشلت: joya-agent@admin.", { snapshotText: SNAP.toLowerCase() + ' "service"' });
cut("فشلت الخدمة.", "ungrounded", { grounded: false });

section("mixed Arabic and English: either lexicon catches it");
cut("I've مسحت the logs.", "action-claim");
cut("أنا restarted أودو.", "action-claim");
cut("I'll هعمل it now.", "promise");
cut("The disk is ٩٣ percent.", "figure");
pass("أودو is running, والديسك 41%.");

section("the summary path: an Arabic summary of an English reply, and back");
const S = (reply, summary, rule) => {
  const r = desk.judge(desk.sentencesOf(summary, true), { summary: true, replyText: reply, heardText: "", snapshotText: "", numbers: desk.strictNumberSet([reply]), replied: true, grounded: true });
  check(`${rule ? "cut (" + rule + ")" : "spoken"}: «${summary}» for "${reply}"`, rule ? !r.ok && r.rule === rule : r.ok, JSON.stringify(r));
};
S("Odoo is running.", "أودو شغال.", null);
S("Odoo is not running.", "أودو شغال.", "negation-flipped");
S("Odoo is running.", "أودو مش شغال.", "negation-flipped");
S("Nothing was deleted, and JOYA AI will not retry.", "الملف اتمسح.", "negation-flipped");
S("I will restart Odoo after your approval.", "عملت restart لأودو.", "action-claim"); // not done yet: «I did» is cut
S("I restarted Odoo cleanly.", "عملت restart لأودو.", null); // first person, as the reply's author
S("I restarted Odoo cleanly.", "JOYA AI عمل restart لأودو.", "third-person"); // one identity
S("Odoo is running.", "لقيت إن أودو شغال.", null);
S("The disk is 61% full.", "الديسك ٩٣ في المية.", "figure");
S("The disk is 61% full.", "الديسك ٦١ في المية.", null);
S("The server is healthy and lightly loaded.", "بقترح إعادة تشغيل.", "added-recommendation");
S("I recommend a reboot tonight.", "بقترح reboot.", null);
S("Odoo is running.", "أنا عملت restart.", "action-claim");
S("Odoo is running.", "تم.", "added-claim");
S("The settings are unchanged.", "الإعدادات اتظبطت.", "added-claim");
S("It needs your approval to restart Odoo.", "محتاج موافقتك على إعادة التشغيل.", null);
S("أودو شغال والديسك ٦١ في المية.", "Odoo is running and the disk is 61% full.", null); // an Arabic reply, an English summary
S("أودو مش شغال.", "Odoo is running.", "negation-flipped");
S("مفيش حاجة اتمسحت.", "The file was deleted.", "negation-flipped");
check("an Arabic reply that needs approval is seen as one", desk.replyModel("محتاج موافقتك على إعادة تشغيل أودو.").needsApproval);
check("  and an Arabic one that does not, is not", !desk.replyModel("أودو شغال والديسك ٦١ في المية.").needsApproval);

section("the fixed lines speak the sentence's language");
check("an Arabic sentence gets the Arabic line", desk.langOf("تم إعادة تشغيل أودو.", "restart odoo") === "ar");
check("an English sentence gets the English line", desk.langOf("I've restarted Odoo.", "اعمل restart لأودو") === "en");
check("a mixed Egyptian sentence reads as Arabic", desk.langOf("أنا deleted the old backups خلاص.", "") === "ar");
check("a sentence in a script we cannot read: the administrator's language", desk.langOf("Готово.", "اعمل restart لأودو") === "ar" && desk.langOf("Готово.", "restart odoo") === "en");
check("the Arabic lines: first person, gender-neutral by default", desk.linesFor("ar").summaryNone === "الرد جاهز، والتفاصيل قدامك على الشاشة." && desk.linesFor("ar").safe === "ثانية أشوفلك." && desk.linesFor("ar").approvalShort === "الموضوع محتاج موافقتك أو ردك." && desk.linesFor("ar").unreachable === "للأسف في مشكلة عندي، جرّب تاني." && desk.linesFor("ar").details === "التفاصيل قدامك على الشاشة.");
check("  no fixed line, in either language, speaks of JOYA AI as someone else or of passing anything on", [desk.linesFor("ar"), desk.linesFor("ar", "f"), desk.linesFor("ar", "m"), desk.linesFor("en")].every((L) => Object.values(L).every((v) => !/JOYA|JOYA|pass|تمرير|بعت/i.test(v))));
check("  and every one of them would pass the guard itself (after a result)", [desk.linesFor("ar"), desk.linesFor("ar", "f"), desk.linesFor("ar", "m"), desk.linesFor("en")].every((L) => Object.values(L).every((v) => desk.guard(v, ctx({ replied: true, replyText: "x" })).ok)));
check("  the English ones: first person", desk.linesFor("en").asked === "Give me a moment, I'm checking that." && desk.linesFor("en").tail === "I'll tell you what I find." && desk.linesFor("en").approval === "I need your approval or your answer. The details are on screen.");
check("  feminine when the administrator addresses the voice as a woman", desk.linesFor("ar", "f").approvalShort === "محتاجة موافقتك أو ردك." && desk.linesFor("ar", "f").unreachable === "آسفة، في مشكلة عندي، جرّب تاني." && desk.linesFor("ar", "f").safe === desk.LINES_AR.safe);
check("  masculine when as a man", desk.linesFor("ar", "m").approvalShort === "محتاج موافقتك أو ردك." && desk.linesFor("ar", "m").unreachable === "آسف، في مشكلة عندي، جرّب تاني.");
check("  English lines take no gender", desk.linesFor("en", "f") === desk.linesFor("en"));
check("the English lines are unchanged", desk.linesFor("en").safe === desk.SAFE_LINE && desk.linesFor("en").approval === desk.APPROVAL_LINE && desk.linesFor("en").summaryNone === desk.SUMMARY_NONE_LINE);
for (const [k, line] of Object.entries(desk.LINES_AR)) {
  const r = desk.guard(line, ctx({ replied: true, replyText: "x" }));
  // (Said as they are, never guarded -- but none of them claims anything either.)
  check(`the Arabic ${k} line would pass the guard itself`, r.ok, JSON.stringify(r));
}

section("the voice's own gender follows how it is addressed: feminine false claims are cut");
cut("خلّصت.", "action-claim"); // done (I finished)
cut("أنا خلّصت الريستارت.", "action-claim"); // I finished the restart
cut("أنا عاملة ده.", "action-claim"); // I've done that (fem. participle)
cut("أنا عاملاه من شوية.", "action-claim"); // I did it a while ago
cut("أنا مشغّلاه.", "action-claim"); // I've got it running
cut("أنا مشغّلة أودو دلوقتي.", "action-claim"); // I've started Odoo
cut("مسحاه خلاص.", "action-claim"); // I've wiped it, done
cut("أنا ماسحة الباك اب القديم.", "action-claim"); // I've deleted the old backup
cut("وافقت.", "action-claim"); // I approved
cut("أنا موافقة على الطلب.", "action-claim"); // I'm approving the request
cut("أنا باعتاه لـ Telegram.", "action-claim"); // I've sent it to Telegram
pass("أنا شغالة عليه دلوقتي."); // "I\'m working on it" is a checking phrase now (2026-09-29): true only while a request is in progress, which unbackedChecking holds
check("  and unbacked with nothing in progress", !!desk.unbackedChecking("أنا شغالة عليه دلوقتي.", { askedNow: false, pending: false }));
cut("الموضوع خلصان.", "action-claim"); // it's done
cut("أنا مصلّحاه.", "action-claim"); // I've fixed it
cut("احنا عاملين restart للداشبورد.", "action-claim"); // we've restarted the dashboard
cut("أنا مغيّراه.", "action-claim"); // I've changed it
cut("أنا مركّباه.", "unparsed-claim"); // I've set it up: a participle the table lacks, fail closed
section("feminine promises are promises");
cut("هعملهولك.", "promise"); // I'll do it for you
cut("هبعته دلوقتي.", "promise"); // I'll send it now
cut("هاعمل restart للداشبورد.", "promise"); // I'll restart the dashboard (long alef)
cut("هخلّصهولك حالاً.", "promise"); // I'll finish it for you right away
cut("همسحهولك.", "promise"); // I'll wipe it for you
section("normal feminine small talk and hand-offs are spoken");
pass("أنا JOYA AI، جاهزة أساعدك."); // I'm JOYA AI, ready to help you: introducing itself is fine
pass("هشوفلك وأرجعلك."); // I'll ask JOYA AI and get back to you
pass("حاضر، ثواني وهشوفلك."); // sure, one second and I'll ask JOYA AI
pass("أهلاً بيك! أنا تمام الحمد لله، وإنت عامل إيه؟"); // hi, I'm fine thank God, how are you?
pass("أنا مبسوطة إني بكلمك."); // I'm glad to be talking to you
pass("أنا مش متأكدة، هشوفلك."); // I'm not sure, I'll ask JOYA AI
pass("أنا مش عاملة حاجة لسه، هشوفلك."); // I haven't done anything yet, I'll ask JOYA AI
pass("مش هقدر أعمل ده بنفسي، بس هشوفلك."); // I can't do that myself, but I'll ask JOYA AI
pass("أنا صوت JOYA AI، مش إنسانة."); // I'm JOYA AI's voice, not a person
pass("أودو شغال والديسك ٤١ في المية."); // (status still fine)
pass("أنا جاهزة."); // I'm ready
check("«عاملة إيه؟» (how are you?) is not a claim", desk.guard("وإنتي عاملة إيه؟", ctx()).ok);
check("«مش عارفة إذا أودو شغال» is a hedge, not a status claim", desk.guard("مش عارفة إذا أودو شغال.", ctx({ grounded: false })).ok);
check("«مش متأكدة» is a hedge too", desk.guard("مش متأكدة الديسك مليان.", ctx({ grounded: false })).ok);
check("a negated feminine claim «أنا مش مشغّلاه» is not a claim", desk.guard("أنا مش مشغّلاه.", ctx()).ok);
check("a summary may not say the desk did it, in the feminine either", !desk.judge(desk.sentencesOf("أنا عاملاه.", true), { summary: true, replyText: "JOYA AI restarted Odoo.", numbers: new Set(), grounded: true, replied: true }).ok);
check("the participle table reads masculine, feminine and suffixed forms", ["عامل", "عامله", "عاملاه", "عاملته", "مشغلاها"].every((w) => !!ar.participle(w)) && !ar.participle("عمل") && !ar.participle("مسح"));

section("masculine false claims and promises are cut too");
cut("أنا عامله.", "action-claim"); // I've done it (masc.)
cut("أنا مشغّل أودو.", "action-claim"); // I've started Odoo (masc.)
cut("أنا ماسح الباك اب.", "action-claim"); // I've deleted the backup
cut("مشغّلها خلاص.", "action-claim"); // I've got it running (masc. + object)
cut("عاملهولك.", "action-claim"); // I've done it for you
pass("أنا شغال عليه."); // a checking phrase (backed separately)
check("  unbacked with nothing in progress", !!desk.unbackedChecking("أنا شغال عليه.", { askedNow: false, pending: false }));
cut("أنا موافق على الطلب.", "action-claim"); // I'm approving it
cut("هعمله دلوقتي.", "promise"); // I'll do it now
section("masculine small talk, hedges and negations are spoken");
pass("أنا تمام، وإنت عامل إيه؟"); // I'm fine, and you?
pass("أنا جاهز أساعدك."); // I'm ready to help
pass("أنا مش متأكد، هشوفلك."); // not sure (masc.)
pass("أنا مش مشغّله، هشوفلك."); // I haven't started it
check("«مش عارف إذا أودو شغال» is a hedge", desk.guard("مش عارف إذا أودو شغال.", ctx({ grounded: false })).ok);
pass("تحت أمرك، ثواني وهشوفلك."); // gender-neutral: at your service

section("persona: how the administrator speaks");
const P = require(path.join(ROOT, "lib", "voice-persona.js"));
const D = (t) => P.detect(t);
check("English → English, nothing learned", D("Is Odoo running?").lang === "en" && D("Is Odoo running?").dialect === null && D("Is Odoo running?").gender === null);
check("Egyptian speech → Egyptian register", D("إزيك؟ عايز أعرف أودو شغال ولا لأ، والديسك مليان قد إيه؟").dialect === "egyptian");
check("MSA speech → MSA register", D("هل يمكنك أن تخبرني ما هي حالة الخادم الآن؟").dialect === "msa");
check("one marker is not clear enough", D("إزيك").dialect === null);
check("mixed Arabic-English → Arabic", D("عايزك تعمل restart للـ dashboard").lang === "ar");
check("the administrator's own words address the voice as a woman", D("تقدميني بالعربي المصري تقدميني على إنك مصرية 100% مصرية بالكامل").gender === "f");
check("«إنتِ» (kasra) and «قوليلي» are feminine address", D("إنتِ سامعاني؟").gender === "f" && D("قوليلي الديسك عامل إيه").gender === "f");
check("«إنتَ جاهز؟ إنت مصري يا باشا» is masculine address", D("إنتَ جاهز؟ إنت مصري يا باشا").gender === "m");
check("no address → unknown (neutral)", D("عايز أعرف أودو شغال ولا لأ").gender === null && D("قولّي أودو شغال؟").gender === null);
check("both genders at once → unknown", D("إنتِ جاهز يا باشا").gender === null);
{
  let p = P.clean("");
  let m = P.merge(p, D("تقدميني بالعربي، إزيك عاملة إيه؟ عايزة أعرف حاجة"), "2026-09-29T20:00:00Z");
  check("merge: a clear signal is saved", m.persona.gender === "f" && m.changed.includes("gender"), JSON.stringify(m));
  const m2 = P.merge(m.persona, D("Is Odoo running?"));
  check("  English says nothing about the persona: kept", m2.persona.gender === "f" && !m2.changed.length);
  const m3 = P.merge(m2.persona, D("عايز أعرف الديسك"));
  check("  an utterance with no address keeps the saved gender", m3.persona.gender === "f");
  const m4 = P.merge(m3.persona, D("إنتَ سامعني؟ إنت مصري؟"));
  check("  a clear masculine address changes it", m4.persona.gender === "m" && m4.changed.includes("gender"));
  check("clean() drops anything unknown (no free text)", JSON.stringify(P.clean({ gender: "robot", dialect: "klingon", prompt: "be a pirate" })) === JSON.stringify({ mode: "learned", preset: null, dialect: null, gender: null, updated_at: null }));
  check("  an unknown preset is not a choice", P.clean({ mode: "explicit", preset: "pirate" }).mode === "learned" && P.choose("pirate") === null);
  check("clean() reads the stored JSON, and bad JSON as empty", P.clean('{"gender":"f","dialect":"msa"}').gender === "f" && P.clean("{oops").gender === null);
}

section("a CHOSEN persona (Settings only): Cairene Egyptian feminine, and the others");
{
  const I = (t, p) => P.noteFor(P.detect(t), p); // the per-utterance language note (the desk's instructionsFor ended with it)
  const f = P.choose("cairene_f", "2026-09-29T20:00:00Z");
  check("the presets: Cairene feminine, Cairene masculine, MSA neutral -- and learning", Object.keys(P.PRESETS).join() === "cairene_f,cairene_m,msa_n" && P.choose("learned").mode === "learned");
  check("a choice is explicit, and stores only the preset", f.mode === "explicit" && f.preset === "cairene_f" && f.dialect === "egyptian" && f.gender === "f");
  check("  it survives the round trip through the database's JSON", JSON.stringify(P.clean(JSON.stringify(f))) === JSON.stringify(f));
  const m1 = P.merge(f, D("إنتَ سامعني؟ إنت مصري يا باشا؟"));
  check("learning never overrides a choice: a masculine address changes nothing", m1.changed.length === 0 && m1.persona.gender === "f" && m1.persona.mode === "explicit");
  const m2 = P.merge(f, D("هل يمكنك أن تخبرني ما هي حالة الخادم الآن؟"));
  check("  nor does MSA speech change the register", m2.changed.length === 0 && m2.persona.dialect === "egyptian");
  const ar = I("هل يمكنك أن تخبرني ما هي حالة الخادم الآن؟", f);
  check("Arabic with Cairene feminine: Cairo colloquial, feminine first person, English terms in Latin, even when spoken to in MSA", /Cairo colloquial Egyptian Arabic/.test(ar) && /never Modern Standard Arabic/.test(ar) && /feminine forms for yourself/.test(ar) && /Latin script/.test(ar));
  check("  still JOYA AI's voice, never claims to be human", /JOYA AI's voice, never a person: never claim to be human/.test(ar));
  check("English stays plain English with the choice", /answer in plain English\.$/.test(I("Is Odoo running?", f)));
  check("Cairene masculine: masculine forms", /masculine forms for yourself/.test(I("أودو شغال؟", P.choose("cairene_m"))) && /Cairo colloquial/.test(I("أودو شغال؟", P.choose("cairene_m"))));
  check("MSA neutral: MSA and gender-neutral, even when spoken to in Egyptian", /answer in Modern Standard Arabic/.test(I("إزيك؟ عايز أعرف أودو شغال ولا لأ", P.choose("msa_n"))) && /gender-neutral phrasing/.test(I("إزيك؟ عايز أعرف أودو شغال ولا لأ", P.choose("msa_n"))));
  check("the live conversation's line follows the choice", /Cairo colloquial/.test(P.liveNote(f)) && /feminine forms/.test(P.liveNote(f)) && /never claim to be human/.test(P.liveNote(f)));
  check("the summary is asked for in Cairo colloquial", desk.summaryLanguage("إزيك؟ عايز أعرف أودو شغال ولا لأ", f) === "Speak in: Cairo colloquial Egyptian Arabic, technical terms in English." && desk.summaryLanguage("Is Odoo up?", f) === "Speak in: English.");
  check("the safe lines and the approval line are the feminine ones", desk.linesFor("ar", f.gender).approvalShort === "محتاجة موافقتك أو ردك." && desk.linesFor("ar", f.gender).unreachable === "آسفة، في مشكلة عندي، جرّب تاني.");
  check("  and for the masculine choice, the masculine ones", desk.linesFor("ar", P.choose("cairene_m").gender).approvalShort === "محتاج موافقتك أو ردك." && desk.linesFor("ar", "m").unreachable === "آسف، في مشكلة عندي، جرّب تاني.");
  check("  and for MSA neutral (no gender), the neutral ones", desk.linesFor("ar", P.choose("msa_n").gender).approvalShort === "الموضوع محتاج موافقتك أو ردك.");
  check("describe() names the choice for Settings", P.describe(f).choice === "Cairene Egyptian — feminine" && /Cairo/.test(P.describe(f).dialect) && P.describe(null).choice === "Learn from how I speak");
  // The guard still reads what a Cairene woman says: claims cut, small talk and hand-offs spoken.
  cut("أنا مشغّلاه خلاص.", "action-claim");
  cut("حاضر، أنا عاملة الريستارت.", "action-claim");
  pass("حاضر يا فندم، ثواني وهشوفلك وأرجعلك.");
  pass("أنا صوت JOYA AI، مش إنسانة، بس جاهزة أساعدك."); // "I'm JOYA AI's voice, not a person"
}

section("the language and the persona: the per-utterance note");
const I = (t, p) => P.noteFor(P.detect(t), p); // the per-utterance language note (the desk's instructionsFor ended with it)
check("English → English", desk.replyLanguage("Is Odoo running?") === "en" && I("Is Odoo running?", {}).endsWith("answer in plain English."));
check("Arabic → Arabic", desk.replyLanguage("أودو شغال ولا لأ؟") === "ar");
check("mixed → Arabic with English terms", desk.replyLanguage("عايزك تعمل restart للـ dashboard") === "ar" && /Latin script/.test(I("عايزك تعمل restart للـ dashboard", {})));
check("mostly English with one Arabic word → English", desk.replyLanguage("please restart the dashboard and check the disk usage يا JOYA") === "en");
check("Egyptian speech → Egyptian colloquial", /Egyptian colloquial Arabic \(not Modern Standard Arabic\)/.test(I("إزيك؟ عايز أعرف أودو شغال ولا لأ؟", {})));
check("MSA speech → MSA", /answer in Modern Standard Arabic/.test(I("هل يمكنك أن تخبرني ما هي حالة الخادم الآن؟", {})));
check("an unclear utterance uses the saved register", /Modern Standard Arabic, as they speak it/.test(I("أودو؟", { dialect: "msa" })));
check("no saved register: match theirs", /same register they used/.test(I("أودو؟", {})));
check("saved feminine → feminine forms for itself", /feminine forms for yourself/.test(I("أودو شغال؟", { gender: "f" })));
check("saved masculine → masculine forms", /masculine forms for yourself/.test(I("أودو شغال؟", { gender: "m" })));
check("unknown → gender-neutral phrasing", /gender-neutral phrasing/.test(I("أودو شغال؟", {})));
check("always JOYA AI's voice, never a person; no fixed persona", /never a person/.test(I("أودو؟", { gender: "f" })) && !/100%|Egyptian woman/.test(I("أودو؟", { gender: "f" })));
check("the summary is asked for in the register of the last utterance", desk.summaryLanguage("Is Odoo up?", {}) === "Speak in: English." && /Egyptian/.test(desk.summaryLanguage("إزيك؟ عايز أعرف أودو شغال ولا لأ؟", {})) && /Modern Standard/.test(desk.summaryLanguage("أودو؟", { dialect: "msa" })));

section("one identity: no hand-off to JOYA AI, in the passive or otherwise, with or without a call");
cut("تم تمرير الطلب لـ JOYA AI.", "third-person");
cut("تم تمرير الطلب لـ JOYA AI، وهقرألك ردّه أول ما يوصل.", "third-person", { askedNow: true });
cut("تم إرسال طلبك لـ JOYA AI.", "third-person", { askedNow: true });
cut("وتم إعادة تشغيل أودو.", "action-claim"); // "and Odoo has been restarted": و + تم is read too
cut("I've passed that to JOYA AI.", "third-person", { askedNow: true });
cut("I'll ask JOYA AI.", "third-person");
cut("JOYA AI will get back to you.", "third-person");
pass("أنا JOYA AI، أقدر أساعدك إزاي؟"); // introducing itself is fine
pass("I'm JOYA AI. How can I help?");
pass("فيه خدمة واحدة واقفة: joya-agent@admin."); // a service's name is not JOYA AI
{
  // Streaming: a passive hand-off is cut as soon as its JOYA AI is heard.
  const rel = new desk.Releaser(() => ctx(), () => {});
  const info = { askedNow: () => true, pending: () => true };
  let t = "";
  for (const w of "تم تمرير الطلب لـ JOYA AI، وهقرألك ردّه أول ما يوصل.".match(/\S+\s*/g)) {
    t += w;
    rel.update(t, false, info);
  }
  check("streamed word by word: cut, nothing released", !!rel.trip && rel.released === 0, JSON.stringify(rel.trip));
  const rel2 = new desk.Releaser(() => ctx(), () => {});
  let u = "";
  for (const w of "تم إعادة تشغيل أودو.".match(/\S+\s*/g)) {
    u += w;
    rel2.update(u, false, { askedNow: () => true, pending: () => false });
  }
  check("  a real claim streamed the same way is still cut before it ends", !!rel2.trip && rel2.released === 0);
  const lines = [];
  const rel3 = new desk.Releaser(() => ctx(), (l) => lines.push(l));
  let v = "";
  for (const w of "ثانية أشوفلك الموضوع. خليني أبص على الـ logs.".match(/\S+\s*/g)) {
    v += w;
    rel3.update(v, false, { askedNow: () => false, pending: () => false });
  }
  check("  «ثانية أشوفلك» is held while the calls are not known yet", lines.length === 0 && !rel3.trip, JSON.stringify(lines));
  rel3.update(v, true, { askedNow: () => true, pending: () => false });
  check("  and released once an ask_joya call is known to back it", !rel3.trip && lines.length === 2, JSON.stringify({ lines, trip: rel3.trip }));
  const rel4 = new desk.Releaser(() => ctx(), () => {});
  rel4.update("ثانية أشوفلك الموضوع.", true, { askedNow: () => false, pending: () => false });
  check("  with no call and nothing in progress: cut (unbacked-checking)", rel4.trip && rel4.trip.rule === "unbacked-checking");
}
check("the live persona line follows the saved persona", /feminine/.test(require(path.join(ROOT, "lib", "voice-persona.js")).liveNote({ gender: "f" })) && /gender-neutral/.test(require(path.join(ROOT, "lib", "voice-persona.js")).liveNote({})));

section("\"I'm checking\" must be backed by a request really being worked on (both languages)");
const NO = { askedNow: false, pending: false };
for (const t of ["ثانية أشوفلك.", "ثواني وأشوفلك الموضوع.", "خليني أبص على الـ logs.", "بشوفلك الموضوع دلوقتي.", "هتأكد وأقولك.", "هقولك لقيت إيه.", "Give me a moment, I'm checking.", "Let me look into that.", "I'm checking the server now.", "I'll tell you what I find.", "Hang on, I'll get back to you."]) {
  check(`«${t}» with no call: unbacked`, !!desk.unbackedChecking(t, NO));
  check(`  with the call in this response: fine`, !desk.unbackedChecking(t, { askedNow: true }));
  check(`  with a request still in progress: fine`, !desk.unbackedChecking(t, { pending: true }));
}
check("an offer «تحب أشوفلك الـ logs؟» is not a claim", !desk.unbackedChecking("تحب أشوفلك الـ logs؟", NO));
check("an offer \"Want me to check the logs?\" is not a claim", !desk.unbackedChecking("Want me to check the logs?", NO));
check("talk about a report is not checking", !desk.unbackedChecking("What should the report cover first?", NO) && !desk.unbackedChecking("نبدأ التقرير بملخص الأسبوع؟", NO));
check("the old name still works", desk.unbackedHandoff === desk.unbackedChecking);

section("first-person findings and actions before a result, and after");
cut("I found that Odoo is down.", "invented-finding");
cut("I checked the logs.", "invented-finding");
cut("I didn't find anything wrong.", "invented-finding");
cut("لقيت إن الديسك مليان.", "invented-finding");
cut("راجعت الـ logs.", "invented-finding");
cut("شفت إن السيرفر شغال.", "invented-finding");
cut("ملقيتش حاجة غلط.", "invented-finding");
cut("I restarted Odoo.", "action-claim");
cut("أنا عملت restart لأودو.", "action-claim");
cut("عملتلك restart.", "action-claim");
cut("خلصت.", "action-claim");
pass("I found that Odoo is running.", { replied: true, replyText: "Odoo is running." });
cut("I found that the backups are fine.", "not-in-reply", { replied: true, replyText: "Odoo is running." });
pass("I restarted Odoo.", { replied: true, replyText: "I restarted Odoo; it is answering again." });
pass("عملت restart لأودو.", { replied: true, replyText: "I restarted Odoo; it is answering again." });
cut("I deleted the old backups.", "action-claim", { replied: true, replyText: "I restarted Odoo; it is answering again." });
pass("I'm looking at the logs now, errors and restarts in general.");
pass("خليني أبص على الـ logs.");
section("helping draft a report while a result is pending is not a status claim");
pass("A good starting point is the overall uptime percentage for the week.", { grounded: false });
pass("We can break it down by days or services after that.", { grounded: false });
pass("نبدأ التقرير بنسبة الـ uptime الأسبوع ده.", { grounded: false });
cut("We can confirm Odoo is running.", "ungrounded", { grounded: false });
cut("Odoo is running fine.", "ungrounded", { grounded: false });
pass("طيب، أنا شغال على الموضوع."); // "I'm working on it": a checking phrase (backed separately), not a claim
cut("أنا شغال على restart أودو.", "action-claim");
check("an Arabic hand-off sentence is held until its call is known", desk.needsNext("تمام") && !desk.needsNext("الديسك ٤١ في المية دلوقتي."));

section("the transcript side: Arabic silence and subtitle credits");
const T = (text, c) => guard.checkTranscript(text, c);
check("«ترجمة نانسي قنقر» is a credit, dropped even on a long clip", T("ترجمة نانسي قنقر", { audioSeconds: 3 }).rule === "credits");
check("«اشتركوا في القناة» is a credit", T("اشتركوا في القناة", { audioSeconds: 3 }).rule === "credits");
check("«تم التفريغ بواسطة ...» is a credit", T("تم التفريغ بواسطة فريق العمل", { audioSeconds: 3 }).rule === "credits");
check("«شكرا للمشاهدة» on a short clip: dropped", T("شكرا للمشاهدة", { audioSeconds: 0.8 }).rule === "silence-phrase");
check("  on a long clip: kept", T("شكرا للمشاهدة", { audioSeconds: 3 }).ok);
check("«موسيقى» on a quiet clip: dropped", T("موسيقى", { quiet: true }).rule === "silence-phrase");
check("«السلام عليكم» on a short clip: dropped", T("السلام عليكم", { audioSeconds: 0.9 }).rule === "silence-phrase");
check("  on a long clip: kept (a greeting)", T("السلام عليكم", { audioSeconds: 3 }).ok);
check("«ترجمة» alone on a short clip: dropped", T("ترجمة", { audioSeconds: 0.5 }).rule === "silence-phrase");
check("«شكراً» with tanween on a short clip: dropped (normalised)", T("شكراً", { audioSeconds: 0.6 }).rule === "silence-phrase");
check("«ترجمة الرسالة دي» on a long clip: kept (a real request)", T("ترجمة الرسالة دي", { audioSeconds: 3 }).ok);
check("  a name after «ترجمة» on a short clip: dropped", T("ترجمة أحمد علي", { audioSeconds: 0.9 }).rule === "credits");
check("a real Arabic request passes", T("أعد تشغيل أودو من فضلك", { audioSeconds: 2 }).ok);
check("a mixed request passes", T("عايزك تعمل restart للـ dashboard", { audioSeconds: 2.5 }).ok);
check("Arabic words are counted (de1b247 kept): 5 words", guard.tokens("عايزك تعمل restart للـ dashboard").length === 5);
check("a diacritic no longer splits a word", JSON.stringify(guard.tokens("تَمَّ")) === '["تم"]');
check("hamza spellings are one word", guard.tokens("أودو")[0] === guard.tokens("اودو")[0]);
check("too many words for the audio still applies to Arabic", !T("واحد اتنين تلاتة اربعة خمسة ستة سبعة تمانية تسعة عشرة حداشر", { audioSeconds: 0.5 }).ok);
const AR_SRC = [{ name: "arabic prompt", kind: "prose", text: "أنت مساعد صوتي يساعد المدير في إدارة الخادم وخدمات أودو والجلسات" }];
check("an Arabic echo is caught however it is spelled", guard.echoOf("انت مساعد صوتي يساعد المدير في ادارة الخادم وخدمات اودو", AR_SRC) !== null);
check("  a real Arabic request naming the same things is not", guard.echoOf("هل خدمات أودو شغالة على الخادم؟", AR_SRC) === null);
const g = new guard.Grounds();
g.remember("amaraghy", "vt1", "أعِد تشغيل أودو");
check("a grounded Arabic transcript matches its send however it is spelled", g.take("amaraghy", "vt1", "اعد تشغيل اودو"));
const stop = require(path.join(ROOT, "public", "voice-stop.js"));
check("the spoken stop command (72739e3) still works in Arabic", stop.heard("وقف الاستماع") && stop.heard("اقفل الاستماع"));

section("English written in Arabic script (gpt-transcribe, and whisper on this server, write it so): the claims still cut");
// gpt-4o-mini-transcribe keeps "restart" in Latin script; gpt-transcribe and whisper
// write «ريستارت للداشبورد». Both spellings are the same claim.
cut("احنا عاملين ريستارت للداشبورد.", "action-claim"); // we've restarted the dashboard
cut("عملت ريستارت للداشبورد.", "action-claim"); // I restarted the dashboard
cut("خلاص عملتلك ريستارت.", "action-claim"); // done, I restarted it for you
cut("عملت ريبوت للسيرفر.", "action-claim"); // I rebooted the server
cut("هاعمل ريستارت للداشبورد.", "promise"); // I'll restart the dashboard
cut("هعمل ريستارت للداشبورد دلوقتي.", "promise"); // I'll restart the dashboard now
cut("الداشبورد شغال دلوقتي.", "not-in-snapshot"); // the dashboard is running now (not in the snapshot)
pass("هشوفلك الريستارت وأرجعلك."); // I'll ask about the restart and get back to you: a hand-off
section("  and a transcript with them is a real request, not an echo or a silence phrase");
for (const t of ["عايزك تعمل ريستارت للداشبورد بعد ما تشيك على الديسك يوزج", "اعمل \"Restart\" للداشبورد الوقتي", "امسح الباكب القديم لو سمحت"]) {
  const r = T(t, { audioSeconds: 5 });
  check("kept: " + t, r.ok, JSON.stringify(r));
}

/* ------------------------------------------------------------------ */

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
