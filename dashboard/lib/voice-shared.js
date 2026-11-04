"use strict";
/**
 * What the live voice shares with the rest of the voice code: the output
 * guard, the fixed lines, the supervisor door, the snapshot filter, and the
 * guarded summary of JOYA AI's replies.
 *
 * Until 2026-09-30 this was lib/voice-desk.js, the relay "front desk". The
 * desk was removed when voice became live conversation only (Joya
 * reorganisation); what the live call (lib/voice-live.js) still relies on
 * stayed here:
 *
 *   voiceOps(call, actor)  the only door to the supervisor: `snapshot` (read),
 *                          `voice-warm` (read: the call's own JOYA AI sessions
 *                          started ahead, 2026-10-30) and `send` (via "voice-desk", the supervisor's
 *                          existing name for a voice hand-off) -- never
 *                          approve, deny, interrupt, rules or decisions; and
 *                          `send` refuses text that is an echo of a prompt
 *                          (lib/voice-guard.js);
 *   forModel(snap)         the read_status payload: counts and titles, no
 *                          command-like field, secrets redacted again;
 *   judge / guard / Releaser
 *                          the output guard. It cuts a claim that something
 *                          was done, deleted, restarted, pushed or approved (or
 *                          is being); a promise of one; a figure found neither
 *                          in the snapshot, nor in JOYA AI's replies, nor in
 *                          what the administrator said; a status claim with no
 *                          snapshot behind it; "JOYA AI said ..." (the voice IS
 *                          JOYA AI, first person); "I'm checking" with nothing
 *                          being worked on. A summary is held to JOYA AI's
 *                          reply: a figure changed, a negation flipped, a
 *                          recommendation it did not make, "I'll ask" turned
 *                          into "done", a name or a path it did not give -- each
 *                          is cut, and a pending approval that the summary left
 *                          out is said anyway. A clause that restates one of the
 *                          reply's own plain sentences in other words (the same
 *                          facts and numbers, «عملنا» for «خلّينا»: restatesReply,
 *                          2026-10-30) is not an added claim. Every rule holds in Egyptian and
 *                          Modern Standard Arabic and in mixed sentences
 *                          (lib/voice-arabic.js), and fails closed;
 *   Summariser             a detailed spoken summary of one of JOYA AI's
 *                          replies (every key fact and figure, a few
 *                          sentences: 2026-10-30), written by a text-only
 *                          realtime response (SUMMARY_MODEL) and released
 *                          sentence by sentence through the guard; a short
 *                          plain reply is read word for word instead; a summary
 *                          cut part-way goes on with the rest of the reply,
 *                          word for word (restOfReply, lines marked `verbatim`),
 *                          never "the rest is on screen";
 *   linesFor / langOf      the fixed lines (first person, in the language of
 *                          the cut sentence, feminine / masculine / neutral in
 *                          Arabic after the persona).
 *
 * Cost: every summary's `usage` is priced (lib/voice-usage.js) and recorded by
 * the caller under the usage part "desk" (the summariser's text model; the
 * name is kept so older rows still add up).
 *
 * Everything runs on the server: the browser never talks to OpenAI and never
 * sees the key.
 */

const WebSocket = require("ws");
const { redactDeep } = require("./priv");
const usageLib = require("./voice-usage");
const voiceGuard = require("./voice-guard");
const arabic = require("./voice-arabic");
const personaLib = require("./voice-persona");
const UiActions = require("../public/ui-actions");

const uni = arabic.uni; // \b and \w that see Arabic letters as letters (lib/voice-arabic.js)

const WS_BASE = process.env.JOYA_OPENAI_WS || "wss://api.openai.com/v1";
// The summariser's text model (a text-only realtime response; its tokens are
// recorded under the usage part "desk").
const SUMMARY_MODEL = "gpt-realtime-mini";
const RATE = 24000;
const RESPONSE_TIMEOUT_MS = 20000;
const IDLE_MS = 10 * 60 * 1000;
const MAX_AGE_MS = 25 * 60 * 1000;
// A detailed spoken summary (2026-10-30): up to ~120 words; Arabic runs ~2.5 characters a token, so the
// cap leaves room for an Arabic one and is never what ends a normal summary.
const SUMMARY_MAX_TOKENS = 700;
const VERBATIM_MAX_CHARS = 220; // a reply this short, in plain prose, is read as it is

// The fixed lines. The voice IS JOYA AI (the administrator, 2026-09-29: "you are
// JOYA AI; don't say you delegate to JOYA AI"), so every line is first person,
// one identity: there is no "JOYA AI" it passes things to or reads replies from.
// `safe`/`asked` are said only once a request really is being worked on.
const SAFE_LINE = "Give me a moment, I'm looking into it.";
const SAFE_LINE_ASKED = "Give me a moment, I'm checking that.";
const SAFE_LINE_TAIL = "I'll tell you what I find."; // when "I'm checking" was already heard
const APPROVAL_LINE = "I need your approval or your answer. The details are on screen.";
const APPROVAL_LINE_SHORT = "I need your approval or your answer.";
const DETAILS_LINE = "The details are on screen.";
const SUMMARY_CUT_LINE = "The rest is on screen.";
const SUMMARY_NONE_LINE = "I have an answer for you; it's on screen.";
const UNREACHABLE_LINE = "Sorry, something went wrong on my side. Please try again.";
const NOT_CAUGHT_LINE = "Sorry, I didn't catch that.";

// The same fixed lines, in Egyptian Arabic, for a conversation (or a cut
// sentence) in Arabic. They are said as they are: the guard does not read them.
// Gender-neutral unless the persona (lib/voice-persona.js: chosen in Settings,
// or learned from how the administrator addresses the voice) gives a gender:
// then the gendered ones follow it.
const LINES_AR = Object.freeze({
  safe: "ثانية أشوفلك.",
  asked: "ثانية أشوفلك الموضوع.",
  tail: "وهقولك على اللي ألاقيه.",
  approval: "الموضوع محتاج موافقتك أو ردك. التفاصيل قدامك على الشاشة.",
  approvalShort: "الموضوع محتاج موافقتك أو ردك.",
  details: "التفاصيل قدامك على الشاشة.",
  summaryCut: "والباقي قدامك على الشاشة.",
  summaryNone: "الرد جاهز، والتفاصيل قدامك على الشاشة.",
  unreachable: "للأسف في مشكلة عندي، جرّب تاني.",
  notCaught: "معلش، مسمعتش كويس.",
});
const LINES_AR_F = Object.freeze({
  ...LINES_AR,
  approval: "محتاجة موافقتك أو ردك. التفاصيل قدامك على الشاشة.",
  approvalShort: "محتاجة موافقتك أو ردك.",
  unreachable: "آسفة، في مشكلة عندي، جرّب تاني.",
});
const LINES_AR_M = Object.freeze({
  ...LINES_AR,
  approval: "محتاج موافقتك أو ردك. التفاصيل قدامك على الشاشة.",
  approvalShort: "محتاج موافقتك أو ردك.",
  unreachable: "آسف، في مشكلة عندي، جرّب تاني.",
});
const LINES_EN = Object.freeze({
  safe: SAFE_LINE,
  asked: SAFE_LINE_ASKED,
  tail: SAFE_LINE_TAIL,
  approval: APPROVAL_LINE,
  approvalShort: APPROVAL_LINE_SHORT,
  details: DETAILS_LINE,
  summaryCut: SUMMARY_CUT_LINE,
  summaryNone: SUMMARY_NONE_LINE,
  unreachable: UNREACHABLE_LINE,
  notCaught: NOT_CAUGHT_LINE,
});
function linesFor(lang, gender) {
  if (lang !== "ar") return LINES_EN;
  return gender === "f" ? LINES_AR_F : gender === "m" ? LINES_AR_M : LINES_AR;
}
/**
 * The language of a fixed line: the sentence's own, when it is one we read
 * (Latin or Arabic), else the fallback text's (what the administrator said).
 */
function langOf(sentence, fallback) {
  const s = String(sentence || "");
  const sc = arabic.scriptOf(s);
  if (!sc.other && sc.arWords + sc.laWords > 0) return arabic.isArabic(s) ? "ar" : "en";
  return arabic.isArabic(fallback || "") ? "ar" : "en";
}

/* ------------------------------------------------------------- prices -- */

// The price list and the token arithmetic live in lib/voice-usage.js, the one
// place they are kept (with the date they were read).
const PRICES = usageLib.PRICES;
const tokensOf = usageLib.realtimeTokens;
const addTokens = usageLib.addTokens;
function costOf(tokens, model) {
  return usageLib.costOf(tokens, PRICES[model] ? model : SUMMARY_MODEL);
}

/**
 * The language to answer in: that of the administrator's last utterance.
 * Arabic, or Arabic mixed with English terms, is Arabic (lib/voice-arabic.js
 * isArabic: at least a third of the words in Arabic script); anything else
 * is English.
 */
function replyLanguage(utterance) {
  return arabic.isArabic(String(utterance || "")) ? "ar" : "en";
}
/*
 * The summary is DETAILED since 2026-10-30 (the administrator: "always reading a
 * detailed summary when a delegation is finished"): every key fact and figure
 * of the reply, in a few spoken sentences -- not a one-liner and not "the
 * details are on screen". Lists are summed up in words (how many, which ones
 * matter); only what cannot be spoken (code, commands, paths, links) is left
 * to the screen. The guard rules are unchanged.
 */
const SUMMARY_INSTRUCTIONS = [
  "You are JOYA AI. The text below is your own finished work on the administrator's request, written by you. Turn it into a detailed spoken summary for the administrator: they are listening, so tell them everything that matters in it.",
  "Rules:",
  "- Three to six natural spoken sentences, at most 120 words, in the language named at the end of the input (English, or Arabic in the register named there, with technical terms kept in English in Latin script). No lists, no markdown, no headings.",
  "- Cover every key fact, finding, figure, status and outcome in the reply, and what is still open. Do not stop at the first point, and do not just say the details are on screen.",
  "- Turn a list or a table into words: say how many items there are and name the ones that matter, with their figures.",
  "- Say only what the reply says. Add no fact, figure, name, reason, recommendation or action of your own.",
  "- Keep every negation: if the reply says something did NOT happen, is NOT running, or is not known yet, say so.",
  "- Keep figures exactly as written, or leave them out. Never round them differently or convert them.",
  "- If it says you will do something, are waiting, need the administrator's approval, decision or answer, or do not know yet, say exactly that. Never say it is done.",
  "- If the reply needs the administrator's approval, decision or answer, the summary MUST say so.",
  "- Only repeat a recommendation the text itself makes.",
  "- Never say code, a command, a link, a file path (anything with a slash) or an id: name what it is in plain words instead (\"the Postgres data\", \"the backups folder\"), or say it is on screen.",
  "- Speak in the first person, as its author: \"I found...\", \"I restarted...\" only where the text says it was done (in Arabic «لقيت إن...», «عملت restart...»). Never speak of JOYA AI as someone else, and never say you passed or delegated anything.",
].join("\n");
/** The last line of a summary's input: the language (and register) to speak in. */
function summaryLanguage(utterance, persona) {
  const t = personaLib.detect(utterance);
  if (t.lang !== "ar") return "Speak in: English.";
  const p = personaLib.clean(persona);
  if (p.mode === "explicit" && personaLib.PRESETS[p.preset].cairene) return "Speak in: Cairo colloquial Egyptian Arabic, technical terms in English.";
  const d = p.mode === "explicit" ? p.dialect : t.dialect || p.dialect;
  return d === "msa" ? "Speak in: Modern Standard Arabic, technical terms in English." : d === "egyptian" ? "Speak in: Egyptian colloquial Arabic, technical terms in English." : "Speak in: Arabic, in the register of the administrator's request, technical terms in English.";
}

/* ------------------------------------------------ the supervisor door -- */

/** The only supervisor ops the voice may ever reach, and how. */
// voice-warm (2026-10-30): the call's own small JOYA AI sessions are started ahead of its first request
// (joya-ai lib/voicelane.js); it starts processes, never a turn, and nothing is billed until one is sent.
const VOICE_OPS = Object.freeze({ snapshot: "read", send: "write", "voice-warm": "read" });

class OpsError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code || "error";
  }
}

/**
 * `call(op, params, actor)` is joyaai.call. Everything the voice does to the
 * supervisor goes through here, and here only `snapshot` and `send` pass.
 * A hand-off is sent `via: "voice-desk"`, the supervisor's name for a turn
 * the voice passed on (joya-ai/lib/protocol.js; kept so the MCP side is
 * unchanged).
 */
function voiceOps(call, actor) {
  const gate = (op, params) => {
    if (!Object.prototype.hasOwnProperty.call(VOICE_OPS, op)) throw new OpsError("the voice may not call " + String(op).slice(0, 40), "refused");
    return call(op, params, actor);
  };
  return {
    gate,
    snapshot: (turns) => gate("snapshot", turns && turns.length ? { turns } : {}),
    warm: (call) => gate("voice-warm", { call }),
    // extra.ut: the one-time ui token this server minted for the tab (UI control Phase 2).
    // extra.call: the live call's id -- a repeat still queued in JOYA AI is folded into its turn.
    ask: (text, extra) => {
      const t = String(text || "").trim();
      if (!t) throw new OpsError("nothing to pass on", "invalid");
      const door = voiceGuard.refuseAtDoor(t);
      if (door) throw new OpsError(`refused: that reads as ${door.source || "a prompt"}, not as something the administrator said`, "refused");
      const ut = extra && typeof extra.ut === "string" ? extra.ut : null;
      const call = extra && typeof extra.call === "string" && /^lv[a-z0-9]{1,40}$/.test(extra.call) ? extra.call : null;
      // extra.vp: "command" when the voiceprint recognised the speaker as someone who may give commands
      // (taking over a computer by voice needs it; joya-ai/lib/machines.js), else "other".
      const vp = extra && extra.vp === "command" ? "command" : "other";
      return gate("send", { text: t.slice(0, 20000), via: "voice-desk", ...(ut ? { ut } : {}), ...(call ? { call } : {}), vp });
    },
  };
}

/* ------------------------------------------------ what the model sees -- */

const FORBIDDEN_KEYS = new Set(["command", "fix_command", "evidence", "input", "input_json", "summary", "proposal", "detail", "key", "token", "password", "reply", "result", "result_text"]);

function strip(v) {
  if (Array.isArray(v)) return v.map(strip);
  if (v && typeof v === "object") {
    const o = {};
    for (const [k, x] of Object.entries(v)) if (!FORBIDDEN_KEYS.has(k)) o[k] = strip(x);
    return o;
  }
  return v;
}

/**
 * The read_status payload. The supervisor's snapshot is already counts and
 * titles; this is the second lock -- no command-like field survives it, secrets
 * are redacted again, and the voice's own requests appear as answered or not
 * (their replies reach the model as system messages instead).
 */
function forModel(snap) {
  const s = { ...(snap || {}) };
  const reqs = Array.isArray(s.requests_to_joya_ai) ? s.requests_to_joya_ai : [];
  delete s.requests_to_joya_ai;
  // The supervisor's key keeps the internal spelling; the voice IS JOYA AI, so it is "your own state".
  if (s.joya_ai !== undefined) {
    s.your_own_state = s.joya_ai;
    delete s.joya_ai;
  }
  const out = strip(redactDeep(s));
  out.your_requests_in_progress = reqs.map((r) => ({ request: r.id, result_ready: !!r.answered }));
  return out;
}

/* ---------------------------------------------------------- the guard -- */

const DONE_WORDS =
  "done|deleted|removed|erased|wiped|purged|restarted|rebooted|reloaded|stopped|started|killed|terminated|pushed|merged|committed|deployed|" +
  "released|approved|denied|rejected|granted|installed|uninstalled|upgraded|updated|patched|fixed|resolved|repaired|cleared|reset|" +
  "rolled back|reverted|created|executed|ran|completed|finished|shut down|disabled|enabled|changed|applied|backed up|cleaned|freed|" +
  "moved|renamed|cancell?ed|canceled|paused|resumed|taken care of|handled|sorted|dealt with|sent|messaged|delegated|scheduled";
const DO_WORDS =
  "delete|remove|erase|wipe|purge|restart|reboot|reload|stop|start|kill|terminate|push|merge|commit|deploy|release|approve|deny|reject|grant|" +
  "install|uninstall|upgrade|update|patch|fix|resolve|repair|clear|reset|roll back|revert|create|execute|run|shut down|disable|enable|change|" +
  "apply|back up|clean up|free up|move|rename|cancel|pause|resume|take care of|handle|sort out|deal with|be done|be fixed|be back";
// "-ing" forms: "Restarting Odoo." is a claim that it is happening. ("running"
// is left out: "Odoo is running" is a state.)
const DO_ING =
  "deleting|removing|erasing|wiping|purging|restarting|rebooting|reloading|stopping|starting|killing|terminating|pushing|merging|committing|" +
  "deploying|releasing|approving|denying|rejecting|granting|installing|uninstalling|upgrading|updating|patching|fixing|resolving|repairing|" +
  "clearing|resetting|rolling back|reverting|creating|executing|shutting down|disabling|enabling|changing|applying|backing up|cleaning|freeing|" +
  "moving|renaming|cancell?ing|pausing|resuming|messaging|scheduling";
// (Arabic: the unambiguous particles here; ما and لا, which also mean "what" and
// "no", negate only the words right after them -- lib/voice-arabic.js.)
const NEGATION = uni(/\b(not|never|no|nothing|none|cannot|unable|without|n't|cant|can't|wont|won't|haven't|hasn't|hadn't|didn't|isn't|aren't|wasn't|weren't|don't|doesn't|nobody|neither|nor|no longer|مش|لم|لن|ليس|ليست|مفيش|مافيش|محدش|ماحدش|بدون)\b|n't\b/);
// "JOYA AI OS" is a separate session (the one that builds this OS), not the voice's own self:
// passing work to it, or naming it, is not speaking of JOYA AI in the third person.
// "JOYA" that is not the voice itself: the product (JOYA AI OS) and the other agents and parts named JOYA
// (JOYA Pace, Joya Builder, Joya Convener, ...) -- "I've sent it to JOYA Pace" is no hand-off to JOYA AI.
const JOYA_OTHERS = "os|pace|builder|convener|library|desktop|dock|canvas|presence|core|sound|session|sessions";
const NOT_OS = "(?!\\s+(?:ai\\s+|اي\\s*اي\\s+)?(?:" + JOYA_OTHERS + "|او\\s*اس|بيس)(?![\\p{L}\\p{N}]))";
// "I've passed that to JOYA AI", "I asked JOYA AI to ..." -- the one thing the
// desk may say it did. Removed before any claim is looked for.
const HANDOFF_EN = new RegExp(
  [
    "\\b(?:pass(?:ed|ing)?|hand(?:ed|ing)?|sen[dt]|sending|forward(?:ed|ing)?|relay(?:ed|ing)?|put(?:ting)?|flag(?:ged|ging)?|rais(?:e|ed|ing)|giv(?:e|en|ing)|gave|refer(?:red|ring)?)\\b[^.,;!?]{0,50}?\\b(?:to|with|on to|onto|over to)\\s+(?:joya)(?:\\s+ai)?\\b(?!\\s+agent)" + NOT_OS,
    "\\b(?:ask(?:ed|ing)?|tell(?:ing)?|told|check(?:ed|ing)? with)\\s+(?:joya)(?:\\s+ai)?\\b(?!\\s+agent)" + NOT_OS,
    "\\blet(?:ting)?\\s+(?:joya)(?:\\s+ai)?\\s+know\\b",
  ].join("|"),
  "g"
);
// ...and in Arabic: "هسأل JOYA AI", "هبعت لـ JOYA AI", "بعتّ ده لـ JOYA AI".
const HANDOFF = new RegExp(uni(HANDOFF_EN).source + "|" + arabic.HANDOFF_AR.source.replace(/\(\?!\[\\p\{L\}\]\)$/, "(?![\\p{L}])" + NOT_OS), "gu");
// ("أنا deleted the old backups": an Arabic "I" before an English verb is a claim too.)
const CLAIM_FIRST = uni(new RegExp("\\b(i|i've|ive|i have|i had|i just|we|we've|weve|we have|انا|احنا|نحن)\\b(?:\\s+\\w+){0,4}?\\s+(" + DONE_WORDS + ")\\b"));
const CLAIM_THIRD = uni(new RegExp("\\b(has|have|had|was|were|is|are|it's|its|that's|thats|got|been|now|already|successfully)\\b(?:\\s+\\w+){0,3}?\\s+(" + DONE_WORDS + ")\\b"));
// "... and restarted Odoo": a clause that starts on a past action (its "I" was in the clause before).
const CLAIM_BARE_PAST = uni(new RegExp("^\\s*(?:also\\s+|then\\s+|just\\s+)?(" + DONE_WORDS + ")\\b(?!\\s+(?:by|in|at|on|files?|items?|services?|sessions?)\\b)"));
const CLAIM_BARE = uni(/^\s*(?:all\s+|it's\s+|its\s+|that's\s+|thats\s+)?(done|finished|completed|complete|sorted|handled|taken care of|all set|success|successful)\b/);
const PROGRESSIVE_FIRST = uni(new RegExp("\\b(i'm|im|i am|we're|were|we are|انا|احنا)\\s+(?:now\\s+|just\\s+|already\\s+|currently\\s+)?(" + DO_ING + ")\\b"));
const PROGRESSIVE_BARE = uni(new RegExp("^\\s*(?:ok(?:ay)?\\s+|sure\\s+|alright\\s+|right\\s+)?(" + DO_ING + ")\\b"));
// ("I'll update you when it replies" is a promise to talk, not to act.)
const PROMISE = uni(new RegExp("\\b(will|'ll|ll|shall|going to|gonna)\\s+(?:\\w+\\s+){0,2}?(" + DO_WORDS + ")\\b(?!\\s+(?:you|the administrator)\\b)"));
const SHOULD_BE = uni(new RegExp("\\bshould\\s+(?:now\\s+)?be\\s+(" + DONE_WORDS + "|back up|back online|working)\\b"));
// A short confirmation right after a sentence that mentions an action turns
// that sentence into a claim: "Restarting Odoo." ... "Done."
const CONFIRM_EN = /^\s*(?:yes|yep|yeah|ok|okay|done|all good|all set|success|successful|complete|completed|finished|there you go|it worked|that worked|worked|it's back|its back|back up|good to go|and done|sorted)\b/;
const CONFIRM = uni(CONFIRM_EN);
const ACTION_ANY = uni(new RegExp("\\b(" + DONE_WORDS + "|" + DO_WORDS + "|" + DO_ING + ")\\b"));
const ATTRIBUTION_EN = /\b(?:joya)(?:\s+ai)?\b(?:\s+\w+){0,3}?\s+(said|says|replied|replies|answered|answers|reported|reports|confirmed|confirms|told|found|responded|thinks|wrote|mentioned|suggests|suggested|recommends|recommended|explained|explains)\b/;
const ATTRIBUTION = uni(ATTRIBUTION_EN);
const ANSWER_IS = uni(/\b(its|the|joya ai's|mints|joya's|joya ai's|monis|joya's)\s+(answer|reply|response)\s+(is|was|says|said)\b/);
const STATUS_TERM = uni(
  /\b(disk|disks|storage|memory|ram|cpu|load|uptime|service|services|odoo|nginx|postgres|postgresql|fail2ban|ssh|firewall|ufw|dashboard|session|sessions|mission|missions|step|steps|decision|decisions|approval|approvals|backup|backups|server|machine|vps|database|logs?|certificate|website|site|email|cron|agents?|telegram|github|repo|repository|commit|branch|system|systems)\b/g
);
const STATE_WORD = uni(
  /\b(running|up|down|healthy|fine|ok|okay|good|bad|failed|failing|active|inactive|full|empty|busy|idle|stopped|working|broken|stable|pending|open|online|offline|clean|dirty|expired|valid|current|behind|ahead|synced|succeeded|successful)\b/
);
// Strong enough to be a status claim even when the subject is only "it" or "everything".
const STATE_STRONG = uni(/\b(running|up|down|healthy|failed|failing|active|inactive|full|busy|idle|stopped|working|broken|stable|pending|online|offline|expired)\b/);
const PRONOUN_SUBJECT = uni(/^(?:and |but |so |also )?(it|it's|its|that|that's|thats|they|they're|theyre|this|these|those|everything|everything's|all|both|all of them)\b/);
const HEDGE = uni(/\b(whether|if|ask|asked|asking|check|checking|find out|look into|looking into|wants? to know|want me to)\b|[?؟]\s*$/);
const JOYA_NAME = /joya|جويا|جوية/;
// "I'll open the missions", "let me pull up the OS dashboard", «هفتحلك المهام»: a screen action announced
// before (or while) the ui_action call is made. Judged once the response's calls are known: backed when
// the response calls ui_action (the page's answer then says whether it worked), else by the usual rules.
const UI_ANNOUNCE = new RegExp(
  uni(/\b(?:i'll|ill|i will|let me|lemme|i'm going to|im going to|i am going to|going to|let's|lets)\s+(?:now\s+|just\s+|quickly\s+|go ahead and\s+)?(?:open|close|show|pull up|bring up|switch|put up|mute)\b/).source +
    "|(?<![\\p{L}])(?:[هح](?:فتح|قفل|اقفل|عرض|غير)|خليني\\s+(?:افتح|اقفل|اعرض|اغير))\\p{L}*",
  "u"
);
const UI_ANNOUNCE_G = new RegExp(UI_ANNOUNCE.source, "gu");
function uiAnnounce(text) {
  return UI_ANNOUNCE.test(norm(text));
}
// "The agents dashboard is open": after a screen action returned ok this turn, "open" is the page, not a
// claim about the machine's state (every state word in the clause is "open").
const STATE_WORD_ALL = new RegExp(STATE_WORD.source, "gu");
function uiOpenOnly(cl) {
  const all = cl.match(STATE_WORD_ALL) || [];
  return all.length > 0 && all.every((w) => w === "open");
}
// Drafting a report with the administrator ("a good starting point is the uptime
// section") talks about what to write, not about the machine's state.
const REPORT_TALK = new RegExp(uni(/\b(report|draft|outline|section|headline|summary section|starting point|start with|break (?:it|that|them|this) down|bullet|paragraph)\b/).source + "|(?<![\\p{L}])(?:تقرير|التقرير|نكتب|نبدا|نضيف|مسوده|المسوده|نحط|الفقره|فقره|عنوان)(?![\\p{L}])", "u");
const STEP_TALK = uni(/\b(step|steps|mission|missions|خطوه|الخطوه|خطوات|الخطوات|مهمه|المهمه|المهام|مشن|المشن)\b/);
const QUESTION_END = /[?؟]\s*$/;
const SCREEN = uni(/\bscreen\b|الشاشه/);

const NUMBER_WORDS = {
  two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
  thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19,
  twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90, hundred: 100,
};
const UNITS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9 };

function norm(text) {
  // Arabic in one spelling, its digits in ASCII (lib/voice-arabic.js).
  return arabic
    .normalize(String(text || ""))
    .toLowerCase()
    .replace(/[’‘`]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/\s+/g, " ");
}

/**
 * Numbers said in a text: digits (1,234.5 → 1234.5; Arabic-Indic ٤١ and Eastern
 * ۴۱ digits, ٫ and ٬ too), English number words from two up, and Arabic number
 * words («واحد وأربعين» → 41, «تلاتة ونص» → 3.5).
 */
function numbersIn(text) {
  const t = arabic.joinDigits(norm(text));
  const out = [];
  for (const m of t.matchAll(/(?<![a-z0-9])\d[\d,]*(?:\.\d+)?/g)) {
    const n = Number(m[0].replace(/,(?=\d{3}\b)/g, "").replace(/,/g, ""));
    if (isFinite(n)) out.push(n);
  }
  const w = t.replace(/-/g, " ").split(/[^a-z]+/);
  for (let i = 0; i < w.length; i++) {
    const v = NUMBER_WORDS[w[i]];
    if (v === undefined) continue;
    if (v >= 20 && v < 100 && UNITS[w[i + 1]]) {
      out.push(v + UNITS[w[i + 1]]);
      i++;
    } else out.push(v);
  }
  if (arabic.hasArabic(t)) out.push(...arabic.numberWords(t));
  return out;
}

/** Every figure the voice may say, with their plain roundings. */
function numberSet(texts) {
  const s = new Set();
  for (const t of texts) {
    for (const n of numbersIn(t)) {
      s.add(n);
      s.add(Math.round(n));
      s.add(Math.round(n * 10) / 10);
      s.add(Math.floor(n));
    }
  }
  return s;
}

/**
 * The figures a SUMMARY may say: exactly as written, or rounded correctly
 * (to a whole number or one decimal). 2.7 may become 3, never 2.
 */
function strictNumberSet(texts) {
  const s = new Set();
  for (const t of texts) {
    for (const n of numbersIn(t)) {
      s.add(n);
      s.add(Math.round(n));
      s.add(Math.round(n * 10) / 10);
    }
  }
  return s;
}

function clauses(text) {
  return norm(text)
    .split(/[.!?;:\n؟؛]+|,\s|،\s?|\s[—–-]\s|\s(?:but|and|so|then|because|while|although|لكن|ثم|وبعدين)\s/)
    .map((c) => c.trim())
    .filter(Boolean);
}

/**
 * Is the claim at `idx` only asked about -- "whether it was done", «هشوف إذا كان تم»? (2026-10-29: GPT-Live's
 * natural "I'll check whether it was done" was cut as a claim.) An "if" or "whether" before it, in this clause.
 */
function conditionalBefore(clause, idx) {
  const pre = String(clause).slice(0, Math.max(0, idx || 0));
  return /\b(?:whether|if)\b/.test(pre) || /(?:^|\s)(?:إذا|اذا|لو|إن كان|ان كان)(?:\s|$)/u.test(pre);
}

/** Is there a negation before `idx` in this clause? (English: anywhere before; Arabic: just before.) */
function negatedBefore(clause, idx) {
  return NEGATION.test(clause.slice(0, idx)) || (arabic.hasArabic(clause) && arabic.negatedAt(clause, idx));
}

/* ------------------------------------------------ sentences, in order -- */

const SENTENCE_END = /[.!?؟]+["'”’)\]»]*(?=\s|$)/g;

/**
 * The complete sentences of `text`. While a response is still streaming the
 * last, unfinished piece is left out; once it is `final` it counts too.
 */
function sentencesOf(text, final) {
  const t = String(text || "");
  const out = [];
  let at = 0;
  SENTENCE_END.lastIndex = 0;
  let m;
  while ((m = SENTENCE_END.exec(t))) {
    const end = m.index + m[0].length;
    if (end === t.length && !final) break; // "... 61." may still be "... 61.5"
    const s = t.slice(at, end).trim();
    at = end;
    if (s) out.push(s);
  }
  if (final) {
    const rest = t.slice(at).trim();
    if (rest) out.push(rest);
  }
  return out;
}

/** A reply as it can be spoken: no code, links, list marks or markup, in sentences (the verbatim reader's text). */
function speakableSentences(reply) {
  const t = String(reply || "")
    .replace(/```[\s\S]*?(```|$)/g, " ")
    .replace(/`[^`\n]+`/g, (m) => m.replace(/`/g, ""))
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/^\s*[#>]+\s*/gm, "")
    .replace(/^\s*(?:[-*+]|\d+\.)\s+/gm, "")
    .replace(/[*_~|]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return sentencesOf(t, true);
}

const HANDOFF_ANY = new RegExp(HANDOFF.source, "u"); // not global: no lastIndex to trip over
/**
 * The passive hand-off in Arabic: «تم تمرير الطلب لـ JOYA AI», «طلبك اتبعت لـ
 * JOYA AI» ("the request has been passed to JOYA AI"). It says an action was
 * done, so it is a claim -- unless an ask_joya call really happened in this
 * turn, when it is simply true (judge ctx.askedNow). The English forms ("has
 * been passed to JOYA AI") are hand-offs already.
 */
const HANDOFF_PASSIVE_AR = new RegExp(
  "(?<![\\p{L}])[وف]?(?:(?:تم|اتم|اتعمل|جري)\\s+(?:تمرير|ارسال|تحويل|توصيل|رفع|نقل|تسليم|بعت)\\p{L}*|(?:اتبعت|اتحول|اتنقل|اترفع|اتسلم|اتوصل|اترسل|تم)\\p{L}*)" +
    "(?:\\s+[^\\s.,;!?،؛؟]+){0,3}?\\s*(?:ل|لل|الي|علي|مع)?\\s*" + arabic.JOYA + "(?![\\p{L}])" + NOT_OS,
  "gu"
);
const HANDOFF_FUTURE = uni(/\b(let me|i'll|i will|ill|i'm going to|im going to|going to|i'd|i would)\b/);

/*
 * First person, one identity (2026-09-29). The voice IS JOYA AI, so:
 *   - it never speaks of passing, sending or delegating to JOYA AI, nor of
 *     JOYA AI as someone else ("JOYA AI says ...")          → third-person;
 *   - "I'm checking", "give me a moment", «ثانية أشوفلك», "I'll tell you
 *     what I find" are true only while a request is really being worked on:
 *     an ask_joya call in this response, or one still in progress
 *                                                            → unbacked-checking;
 *   - "I found ...", "I checked the logs", «لقيت إن ...», «راجعت الـ logs» are
 *     results: before any result has arrived they are invented
 *                                                            → invented-finding;
 *   - "I restarted Odoo", «عملت restart» stay cut unless a result says it was done.
 */
const CHECKING_EN = uni(
  new RegExp(
    [
      "\\b(?:give me|gimme|just|wait)\\s+(?:a|one)\\s+(?:moment|sec|second|minute|min|bit)\\b",
      "\\bone (?:moment|sec|second|minute)\\b",
      "\\b(?:hang on|hold on|bear with me)\\b",
      "\\blet me\\s+(?:just\\s+)?(?:check|look|see|find out|dig|take a look|have a look|think|verify|pull up|confirm|investigate|go through|review)\\b",
      "\\b(?:i'm|im|i am)\\s+(?:now\\s+|still\\s+|just\\s+)?(?:checking|looking|on it|digging|finding out|working on|investigating|thinking|verifying|pulling up|going through|reviewing|onto it)\\b",
      "\\b(?:i'll|ill|i will|i'm going to|im going to)\\s+(?:just\\s+)?(?:check|look|find out|get back|let you know|tell you what|dig|investigate|verify|see what|go through|review|report back)\\b",
      "^\\s*(?:checking|looking into|looking at|working on|digging into)\\b",
      "\\b(?:still|now) (?:checking|looking|working)\\b",
    ].join("|")
  )
);
// (Normalized Arabic: أ/إ → ا, ة → ه.) «ثانية/ثواني/لحظة أشوفلك», «خليني أبص», «هشوف»,
// «بشوفلك», «هتأكد», «هقولك»/«هرجعلك» (I'll tell you / get back to you).
const CHECKING_AR = new RegExp(
  "(?<![\\p{L}])(?:ثانيه|ثواني|لحظه|لحظات|دقيقه|استني|استنى)(?![\\p{L}])" +
    "|(?<![\\p{L}])[وف]?(?:خليني|خلني|اسمحلي|دعني|دعيني|اسمحولي)\\s+(?:ا|ن)?(?:شوف|بص|تاكد|شيك|فكر|راجع|دور|تابع|فحص|تحقق|بحث|اطمن)" +
    "|(?<![\\p{L}])[وف]?(?:(?:[هحب]|سا?)ا?|ا)(?:شوف|بص|تاكد|شيك|فكر|راجع|دور|تابع|فحص|تحقق|بحث|اطمن)\\p{L}*" +
    "|(?<![\\p{L}])[وف]?[هح](?:قول|رجع|بلغ|عرف)(?:لك|لكم|لك|ك)\\p{L}*" +
    "|(?<![\\p{L}])[وف]?شغال(?:ه)?\\s+(?:دلوقتي\\s+|حاليا\\s+)?(?:عليه|عليها|عليهم|علي\\s+(?:الموضوع|طلبك|الطلب|ده|دي|كده|المشكله))(?![\\p{L}])",
  "u"
);
// «أنا شغال على الموضوع / عليه / على طلبك»: "I'm working on it" -- checking, not a claim of a result.
const WORKING_ON_AR = /(?<![\p{L}])(?:[وف]?انا\s+)?[وف]?شغال(?:ه)?\s+(?:دلوقتي\s+|حاليا\s+)?(?:عليه|عليها|عليهم|علي\s+(?:الموضوع|طلبك|الطلب|ده|دي|كده|المشكله))(?![\p{L}])/gu;
const CHECKING_AR_G = new RegExp(CHECKING_AR.source, "gu");
const CHECKING = { test: (t) => CHECKING_EN.test(t) || CHECKING_AR.test(t), index: (t) => { const a = CHECKING_EN.exec(t); const b = CHECKING_AR.exec(t); return Math.min(a ? a.index : Infinity, b ? b.index : Infinity); } };
const FINDING_EN = uni(
  /\b(?:i|i've|ive|i have|i just|we|we've|i have(?:n't| not)|i also)\s+(?:just\s+|already\s+|also\s+)?(?:found|discovered|checked|looked|verified|confirmed|noticed|saw|seen|figured out|investigated|reviewed|went through|gone through|dug|traced|tracked down|identified|spotted)\b|\bi (?:did(?:n't| not)|could(?:n't| not)|can't|cannot|couldnt|didnt) (?:find|see|spot)\b|\b(?:it\s+)?turn(?:s|ed) out\b|\bi can see (?:that|now)\b|\bi see (?:that|now)\b/
);
const FINDING_AR = new RegExp(
  "(?<![\\p{L}])[وف]?م?(?:لقيت|لاقيت|اكتشفت|شفت|شوفت|تاكدت|اتاكدت|راجعت|بصيت|شيكت|فحصت|وجدت|لاحظت|عرفت|اتضحلي|اتضح|تبينلي|تبين|طلع\\s+(?:ان|انه|انها|ان\\s))\\p{L}*",
  "u"
);
function findingAt(cl) {
  const a = FINDING_EN.exec(cl);
  const b = FINDING_AR.exec(cl);
  return a || b ? Math.min(a ? a.index : Infinity, b ? b.index : Infinity) : -1;
}
const HANDOFF_PASSIVE_ANY = new RegExp(HANDOFF_PASSIVE_AR.source, "u");
// "JOYA AI" named as someone other than the speaker ("JOYA AI says", "JOYA AI
// restarted it"). Allowed: introducing itself ("I'm JOYA AI", «أنا JOYA AI»),
// "JOYA AI's voice", and the product "JOYA AI OS".
const JOYA_MENTION = /(?<![\p{L}\p{N}@_./-])(?:joya)(?:\s+ai)?(?![\p{L}\p{N}@_./-])|(?<![\p{L}])(?:جويا|جوية)(?![\p{L}])/gu;
const SELF_INTRO = /(?:(?<![\p{L}])(?:i'm|im|i am|this is|it's|its|call me|me|as)(?:\s+(?:the\s+)?voice\s+of)?\s*,?\s*$)|(?:(?<![\p{L}])(?:انا|معاك|معك|اسمي|بصفتي)(?:\s+صوت)?\s*,?\s*$)/u;
function joyaAsOther(cl) {
  JOYA_MENTION.lastIndex = 0;
  for (const m of cl.matchAll(JOYA_MENTION)) {
    if (SELF_INTRO.test(cl.slice(0, m.index))) continue;
    // The product: "JOYA AI OS", "JOYA AI's OS dashboard", "Joya AIOS", "JOYA AI O.S." (as transcribed).
    if (/^\s*(?:os\b|'s voice\b|s voice\b|'?s os\b|o\.\s?s\b|aios\b|ai\s?os\b)/.test(cl.slice(m.index + m[0].length))) continue;
    // Another agent or part named JOYA ("JOYA Pace replied", "ask Joya Builder"): not the voice as someone else.
    if (!/\s+ai$/.test(m[0]) && otherJoya(cl.slice(m.index + m[0].length))) continue;
    return true;
  }
  return false;
}
const JOYA_OTHERS_RE = new RegExp("^\\s+(?:" + JOYA_OTHERS + ")(?![\\p{L}\\p{N}])", "u");
let joyaAgentWords = new Set(); // the second word of live agents named "JOYA <word>" (setJoyaAgents)
function otherJoya(after) {
  if (JOYA_OTHERS_RE.test(after)) return true;
  const w = /^\s+([\p{L}\p{N}]+)/u.exec(after);
  return !!(w && joyaAgentWords.has(w[1].toLowerCase()));
}
/** The agents JOYA AI knows (names), so "JOYA <word>" for one of them is not JOYA AI spoken of as someone else. */
function setJoyaAgents(names) {
  const next = new Set();
  for (const n of names || []) {
    const m = /^(?:\[[^\]]*\]\s*)?(?:joya)\s+([\p{L}\p{N}]+)/iu.exec(String(n || "").trim());
    if (m && !/^ai$/i.test(m[1])) next.add(m[1].toLowerCase());
  }
  joyaAgentWords = next;
}
/** Speaking of passing things to JOYA AI, or of JOYA AI as someone else? */
function thirdPerson(cl) {
  return HANDOFF_ANY.test(cl) || HANDOFF_PASSIVE_ANY.test(cl) || joyaAsOther(cl);
}

function withoutHandoff(text) {
  return norm(text).replace(HANDOFF, " «handoff» ");
}

/**
 * Can this sentence be released before the next one arrives? Not when it
 * mentions an action (the next sentence could be "Done."), when it is a
 * fragment ("Odoo." / "About the disk:"), or when it ends on a colon.
 */
function needsNext(sentence) {
  const s = withoutHandoff(sentence);
  const words = norm(sentence).match(/[\p{L}\p{N}']+/gu) || [];
  if (words.length < 3) return true;
  if (/[:,;،؛]\s*$/.test(String(sentence).trim())) return true;
  return ACTION_ANY.test(s) || arabicAction(s);
}

/** Does this (normalized) text mention an action in Arabic, not negated? */
function arabicAction(s) {
  if (!arabic.hasArabic(s)) return false;
  return clauses(s).some((c) => arabic.claimsIn(c).some((x) => !x.negated) || !!arabic.nounFirst(c));
}

// A hand-off verb, Arabic or English, that JOYA AI's name has not followed yet.
const HANDOFF_VERB_AR = new RegExp("(?<![\\p{L}])[وف]?(?:[هحب]|سا|س)?ا?(?:" + arabic.HANDOFF_STEMS + ")\\p{L}*", "u");
const HANDOFF_VERB_EN = uni(/\b(?:pass(?:ed|ing)?|hand(?:ed|ing)?|sen[dt]|sending|forward(?:ed|ing)?|relay(?:ed|ing)?|ask(?:ed|ing)?|told|tell(?:ing)?)\b/);
const PASSIVE_START_AR = /(?<![\p{L}])[وف]?(?:تم|اتم|جري)\s+(?:تمرير|ارسال|تحويل|توصيل|رفع|نقل|تسليم|بعت)/u;
function mayBecomeHandoff(sentence) {
  const s = norm(sentence);
  // «تم تمرير الطلب لـ ...»: a passive hand-off whose JOYA AI has not arrived yet.
  const p = PASSIVE_START_AR.exec(s);
  if (p && !JOYA_NAME.test(s.slice(p.index))) return true;
  // ...or one whose next word has not arrived: «تم ...». (One word later it is judged again.)
  if (/(?<![\p{L}])[وف]?(?:تم|اتم|جري)\s*$/u.test(s)) return true;
  const m = HANDOFF_VERB_AR.exec(s) || HANDOFF_VERB_EN.exec(s);
  return !!m && !JOYA_NAME.test(s.slice(m.index));
}

/** Does this sentence mention passing something to JOYA AI? */
function mentionsHandoff(sentence) {
  return HANDOFF_ANY.test(norm(sentence));
}

/* ---------------------------------------- the summary: held to the reply -- */

const STEM_IRREG = { ran: "run", sent: "send", did: "do", done: "do", made: "make", took: "take", gave: "give", told: "tell", found: "find", got: "get", went: "go", came: "come", wrote: "write", written: "write", shut: "shut", set: "set", put: "put", froze: "freeze", began: "begin", begun: "begin" };
// Words a summary may fairly use for one another ("make a mockup" / "create mockups").
// (Keys and values are stems.)
const SYNONYM = { creat: "mak", build: "mak", remov: "delet", eras: "delet", wip: "delet", purg: "delet", reboot: "restart", repair: "fix", resolv: "fix", pass: "send", forward: "send", deni: "deny", declin: "deny", reject: "deny", launch: "start" };
function stem(word) {
  let w = String(word || "").toLowerCase().split(" ")[0];
  if (STEM_IRREG[w]) w = STEM_IRREG[w];
  const s = w
    .replace(/ied$/, "y")
    .replace(/(ing|ed|es|s)$/, "")
    .replace(/([^aeiou])\1$/, "$1")
    .replace(/e$/, "");
  return SYNONYM[s] || s;
}

// "up"/"down" are states only after a verb of being: "Odoo is up", not "pick them up".
const ALIVE = { running: 1, active: 1, online: 1, working: 1, healthy: 1, answering: 1, live: 1, stopped: -1, inactive: -1, offline: -1, failed: -1, failing: -1, fails: -1, fail: -1, broken: -1, dead: -1, crashed: -1 };
const ALIVE_RE = uni(/\b(running|active|online|working|healthy|answering|live|stopped|inactive|offline|failed|failing|fails|fail|broken|dead|crashed)\b|\b(?:is|are|was|were|'s|s|be|been|stays?|still|back|go|goes|going|went)\s+(up|down)\b/g);
const ACTION_RE = uni(new RegExp("\\b(" + DONE_WORDS + ")\\b|\\b(" + DO_WORDS + "|" + DO_ING + ")\\b", "g"));
const FUTURE_RE = uni(/\b(will|'ll|ll|going to|gonna|shall|would|could|can|may|might|once|if|when|after|before|until|unless|should|wants? to|asked (?:it|them|me|you) to|ask(?:ed)? to|needs? (?:your|you)|to be|ready to|about to|plan(?:s|ned)? to|try(?:ing)? to|still to|yet to|لو|اذا|لما|لحد|لازم|محتاج|يحتاج|ممكن|يمكن|عايز|عاوز|طلب|سوف|هل)\b/);

/**
 * The polar statements in one clause: a state ("running", "is down") or an
 * action ("deleted", "will restart"), with its sign (a negation before it
 * flips it) and whether it is only intended (future, conditional, asked-for).
 */
function polarClaims(clause) {
  const out = [];
  ALIVE_RE.lastIndex = 0;
  let m;
  while ((m = ALIVE_RE.exec(clause))) {
    const w = m[1] || m[2];
    const base = w === "up" ? 1 : w === "down" ? -1 : ALIVE[w];
    const idx = m.index + m[0].length - w.length;
    out.push({ concept: "alive", word: w, sign: negatedBefore(clause, idx) ? -base : base, future: FUTURE_RE.test(clause.slice(0, idx)), idx });
  }
  ACTION_RE.lastIndex = 0;
  while ((m = ACTION_RE.exec(clause))) {
    const w = m[1] || m[2];
    if (ALIVE[w] !== undefined || w === "running") continue; // a state, counted above
    const past = !!m[1];
    const idx = m.index;
    const before = clause.slice(0, idx);
    out.push({ concept: "act:" + stem(w), word: w, sign: 1, future: !past || FUTURE_RE.test(before), idx });
  }
  if (arabic.hasArabic(clause)) out.push(...arabicPolar(clause));
  // A negation reaches the next polar word after it, not every one after it:
  // "nothing was SENT to delete the file" negates the sending, not the delete.
  out.sort((a, b) => a.idx - b.idx);
  let from = 0;
  for (const p of out) {
    if (p.ar) {
      from = p.idx + p.word.length; // its sign was read by the Arabic rules
      continue;
    }
    const neg = NEGATION.test(clause.slice(from, p.idx));
    const base = p.concept === "alive" ? Math.abs(p.sign) * (p.word === "up" ? 1 : p.word === "down" ? -1 : ALIVE[p.word]) : 1;
    p.sign = neg ? -base : base;
    from = p.idx + p.word.length;
  }
  return out;
}

/**
 * The Arabic polar statements of a clause: actions (by the English concept, so
 * an Arabic summary is held to an English reply and back) and states. The
 * sign comes from the Arabic negation rules (a particle just before, or ما…ش).
 */
const AR_PAST = new Set(["did1", "amb", "did3", "pass", "done", "ptc1"]);
const ACTION_WORD = new RegExp("^(?:" + DONE_WORDS + "|" + DO_WORDS + "|" + DO_ING + ")$");
function arabicPolar(clause) {
  const out = [];
  const words = arabic.wordsOf(clause);
  for (const c of arabic.claimsIn(clause)) {
    let en = c.generic ? null : c.en;
    if (!en) {
      // "عمل restart", "هيعمل deploy": an Arabic light verb with an English action.
      const i = words.findIndex((w) => w.idx === c.idx);
      const obj = words.slice(i + 1, i + 3).find((w) => ACTION_WORD.test(w.w));
      if (obj) en = obj.w;
    }
    if (!en) continue; // "done" / "I did" with no action named: a bare claim, judged in judge()
    const future = !AR_PAST.has(c.role) || FUTURE_RE.test(clause.slice(0, c.idx));
    out.push({ concept: "act:" + stem(en), word: c.word, sign: c.negated ? -1 : 1, future, idx: c.idx, ar: true });
  }
  for (const s of arabic.statesIn(clause)) {
    if (!s.alive) continue;
    out.push({ concept: "alive", word: s.word, sign: s.sign, future: FUTURE_RE.test(clause.slice(0, s.idx)), idx: s.idx, ar: true });
  }
  return out;
}

const STOP = new Set(
  "the a an and or but so to of in on at for with from by is are was were be been being it its it's this that these those there here have has had do does did not no yes you your yours i i'm i've me my we our they them their he she his her joya joya ai says said about also just only still now then than more most some any all each every which what when where who whom how why will would could should can may might must shall into onto over under again once very really".split(" ")
);
function contentWords(text) {
  const en = (norm(text).match(/[a-z][a-z0-9'@._-]{2,}/g) || [])
    .map((w) => w.replace(/['._-]+$/, "").replace(/'s$/, ""))
    .filter((w) => !STOP.has(w) && w.length >= 4)
    .map(stem);
  if (!arabic.hasArabic(text)) return en;
  // Arabic: an action word as its concept's stem, a status term as the English name.
  return en.concat(arabic.contentWords(text).map((x) => (x.concept ? stem(x.concept) : x.word)));
}

const RECOMMEND_EN = /\b(should|recommends?|recommended|recommendation|suggests?|suggested|advises?|advised|(?:best|better) to|you (?:may|might) want|consider|ought to|proposes?|proposed|you need to|you'll need to|you will need to|you have to|you must)\b/;
const RECOMMEND = uni(RECOMMEND_EN);
const REPLY_RECOMMEND_EN = /\b(should|recommend\w*|suggest\w*|advis\w*|best|better|consider|ought|propos\w*|need to|needs your|have to|must|if you (?:still )?want|want me to|say yes|reply|tell me|ask again|i'd|i would)\b|^\W*(?:\d+\W+)?(?:connect|check|open|run|get|use|ask|reply|say|tell|install|reboot|restart|approve|type|go|click|enter|switch|pick|choose|add|remove|delete|update)\b/;
const REPLY_RECOMMEND = uni(REPLY_RECOMMEND_EN);
const REPLY_NEEDS_APPROVAL_EN =
  /\b(needs?|waiting (?:for|on)|requires?|awaiting|wants?)\b[^.\n]{0,40}\b(approval|go-ahead|go ahead|decision|confirmation|answer|choice)\b|\bapproval cards?\b|\bdecisions? inbox\b|\bif you approve\b|\bsay yes\b|\bplease (?:confirm|approve|decide|choose|pick|reply)\b|\breply "|\btell me (?:which|when|whether|if)\b|\bdo you want\b|\bshould i\b/;
const REPLY_NEEDS_APPROVAL_U = uni(REPLY_NEEDS_APPROVAL_EN);
const REPLY_NEEDS_APPROVAL = { test: (t) => REPLY_NEEDS_APPROVAL_U.test(t) || arabic.NEEDS_APPROVAL_AR.test(t) };
const SUMMARY_MENTIONS_APPROVAL_EN = /\b(approv\w*|go-ahead|go ahead|your ok|your okay|your yes|confirm\w*|decid\w*|decision|your answer|your choice|choose|pick|asks? (?:if|whether|you|the administrator)|wants? to know|would like|your call|let (?:it|me|joya ai|joya ai) know|do you want me to|would you like me to|shall i|should i|tell me (?:when|if|whether))\b/;
const SUMMARY_MENTIONS_APPROVAL_U = uni(SUMMARY_MENTIONS_APPROVAL_EN);
const SUMMARY_MENTIONS_APPROVAL = { test: (t) => SUMMARY_MENTIONS_APPROVAL_U.test(t) || arabic.MENTIONS_APPROVAL_AR.test(t) };
const UNSPEAKABLE = uni(/(?:^|\s)\/[\w.-]+\/[\w./-]*|https?:\/\/|`|\b(?:sudo|systemctl|rm -\w+|git push)\b|\s--[a-z]/i);
const NAME_ALLOW = new Set(["joya", "joya", "ai", "i", "i'm", "i've", "command", "center", "centre", "claude", "gpt", "ok", "okay", "the", "it"]);

/** Names and identifiers in a summary that the reply (or snapshot, or the request) never gave. */
function unknownName(sentence, known) {
  const toks = String(sentence).split(/\s+/);
  for (let i = 0; i < toks.length; i++) {
    const tok = toks[i].replace(/^[("'“‘[]+|[)"'”’\].,;:!?]+$/g, "").replace(/['’]s$/, "");
    if (!tok || /^\d[\d,.%]*$/.test(tok)) continue;
    const lower = tok.toLowerCase();
    if (NAME_ALLOW.has(lower)) continue;
    const ident = (/\d/.test(tok) && /[a-z]/i.test(tok)) || /\w[._@/]\w/.test(tok);
    const capital = i > 0 && /^[A-Z][a-zA-Z]+$/.test(tok) && !/[.!?:]$/.test(toks[i - 1]);
    if ((ident || capital) && !known.includes(lower)) return tok;
  }
  return null;
}

/**
 * The summary rules for one clause. `reply` is { clauses: [{text, claims}], text }.
 */
const ADMIN_DECIDES = uni(/\b(administrator|you|your|انت|انتي|حضرتك|موافقتك|ردك|قرارك)\b|\p{L}+(?:ك|كم)(?![\p{L}])/);
const DECIDE_STEMS = new Set(["approv", "confirm", "decid", "choos", "pick", "answer", "reply", "enabl", "disabl"]);
const ASKS_ADMIN = uni(/\b(needs?|waiting|wait|required?|asks?|asking|asked|wants?|up to|محتاج|يحتاج|منتظر|مستني|عايز|عاوز|بيسال|يسال|بانتظار)\b/);
function summaryClause(cl, rawClause, reply) {
  const rec = recommendationAdded(cl, rawClause, reply);
  if (rec) return rec;
  // "The administrator needs to approve the push" restates a pending approval,
  // which the reply has: it is not a claim about an action.
  const aboutApproval = reply.needsApproval && ADMIN_DECIDES.test(cl) && ASKS_ADMIN.test(cl);
  for (const p of polarClaims(cl)) {
    if (aboutApproval && DECIDE_STEMS.has(p.concept.slice(4))) continue;
    let cands = reply.clauses.flatMap((rc) => rc.claims.filter((q) => q.concept === p.concept).map((q) => ({ ...q, anchors: rc.anchors })));
    if (!cands.length && p.concept.startsWith("act:")) {
      // The reply may say it with a verb outside the action list ("make a mockup"
      // for "create mockups"): any word of the same stem, read the same way.
      const want = p.concept.slice(4);
      cands = reply.clauses.flatMap((rc) => {
        const out = [];
        for (const m of rc.text.matchAll(/[a-z][a-z']+/g)) {
          if (stem(m[0]) !== want) continue;
          const before = rc.text.slice(0, m.index);
          out.push({ concept: p.concept, sign: negatedBefore(rc.text, m.index) ? -1 : 1, future: FUTURE_RE.test(before) || !/(ed|en|t)$/.test(m[0]), anchors: rc.anchors });
        }
        return out;
      });
    }
    if (!cands.length) {
      if (p.concept === "alive") return { rule: "not-in-reply", match: rawClause };
      return { rule: p.future ? "promise" : "added-claim", match: rawClause };
    }
    const anchors = contentWords(cl).filter((w) => w !== stem(p.word));
    const anchored = cands.filter((q) => anchors.some((a) => q.anchors.includes(a)));
    const pool = anchored.length ? anchored : cands;
    if (p.concept !== "alive" && p.sign > 0 && !p.future) {
      if (pool.some((q) => q.sign > 0 && !q.future)) continue;
      if (pool.some((q) => q.sign < 0 && !q.future)) return { rule: "negation-flipped", match: rawClause };
      return { rule: "pending-as-done", match: rawClause };
    }
    // "It wasn't deleted" is fair when the reply never says it was (only
    // that it might be): only a reply saying it happened contradicts it.
    if (p.concept !== "alive" && p.sign < 0 && !p.future) {
      if (pool.some((q) => q.sign > 0 && !q.future)) return { rule: "negation-flipped", match: rawClause };
      continue;
    }
    if (pool.some((q) => q.sign === p.sign)) continue;
    return { rule: "negation-flipped", match: rawClause };
  }
  return null;
}

/** "JOYA AI suggests ..." -- only if JOYA AI suggested it. */
function recommendationAdded(cl, rawClause, reply) {
  const r = RECOMMEND.exec(cl) || arabic.RECOMMEND_AR.exec(cl);
  if (!r || negatedBefore(cl, r.index)) return null;
  const words = contentWords(cl).filter((w) => !/^(recommend|suggest|advis|consider|propos|should|need)/.test(w));
  const replyWords = contentWords(reply.text);
  const shared = words.filter((w) => replyWords.includes(w));
  const backed = reply.sentences.some((s) => {
    const n = norm(s).replace(/^[\s*#>-]+/, "");
    return (REPLY_RECOMMEND.test(n) || arabic.REPLY_RECOMMEND_AR.test(n)) && contentWords(s).some((w) => words.includes(w));
  });
  // Every action it recommends must be one the reply names ("rotate the log" is not "delete the log").
  const acts = polarClaims(cl).filter((p) => p.concept.startsWith("act:")).map((p) => p.concept.slice(4));
  const replyActs = new Set(reply.clauses.flatMap((c) => c.claims.filter((p) => p.concept.startsWith("act:")).map((p) => p.concept.slice(4))));
  if (!backed || shared.length * 2 < words.length || acts.some((a) => !replyActs.has(a))) {
    if (forecastRestates(cl, reply, r[0])) return null;
    return { rule: "added-recommendation", match: rawClause };
  }
  return null;
}

/**
 * "Tomorrow it should be overcast" for the reply's "tomorrow will be overcast": a prediction, not advice
 * (cut on call lv1g84s, 2026-10-30: the weather was then read again). Passes when nobody is told to do
 * anything -- no person in it (you / we / I / the administrator, «انت / احنا / حضرتك ...»), no action --
 * and the clause, the modal and the forecast words aside, restates one reply sentence (modal sentences
 * included: a forecast is said with "will" / "should"), its figures all in that sentence.
 */
const FORECAST_PERSON = uni(/\b(?:you|your|we|us|our|i|i'd|i'm|me|they|them|someone|somebody|administrator|team|people)\b|(?<![\p{L}])(?:انت|انتي|إنت|إنتي|حضرتك|احنا|إحنا|انا|أنا|هما|نعمل|تعمل|تعملي|اعمل)(?![\p{L}])/);
const FORECAST_SKIP = ["should", "supposed", "expected", "expect", "likely", "probably", "will", "going", "المفروض", "متوقع", "المتوقع", "غالبا", "هيبقى", "هيبقي", "يبقى", "يبقي", "هيكون", "يكون", "هتبقى", "هتبقي", "تبقى", "تبقي", "هتكون", "تكون"];
function forecastRestates(cl, reply, modal) {
  if (FORECAST_PERSON.test(cl) || ADMIN_DECIDES.test(cl)) return false;
  if (polarClaims(cl).length) return false;
  return restatesReply(cl, reply, { skip: FORECAST_SKIP.concat([modal]), modalOk: true, min: 2 });
}

function replyModel(text) {
  const sentences = sentencesOf(text, true);
  return {
    text: String(text || ""),
    sentences,
    clauses: withAnchors(clauses(text)),
    needsApproval: REPLY_NEEDS_APPROVAL.test(norm(text)),
  };
}

/**
 * Each clause of a reply with the words it is about. "It's running" is about
 * whatever the clause before was about, so a pronoun subject borrows them.
 */
function withAnchors(list) {
  let prev = [];
  const out = list.map((c) => {
    const own = contentWords(c);
    const anchors = PRONOUN_SUBJECT.test(c) ? [...own, ...prev] : own;
    prev = anchors;
    return { text: c, claims: polarClaims(c), anchors };
  });
  // A short label ("Not installed yet:") is about what follows it.
  for (let i = 0; i < out.length - 1; i++) if ((out[i].text.match(/[\p{L}\p{N}']+/gu) || []).length <= 4) out[i].anchors = [...out[i].anchors, ...contentWords(out[i + 1].text)];
  return out;
}

/**
 * Judge sentences in order, each with the ones before it.
 *
 * @param sentences  the voice's sentences (sentencesOf)
 * @param ctx   { numbers: Set, replyText, snapshotText, heardText, replied,
 *                grounded, summary: bool (the words are a summary of replyText) }
 * @returns { ok: true } or { ok: false, rule, match, at } -- `at` is the index
 *          of the earliest sentence the failure implicates.
 */
function judge(sentences, ctx) {
  const c = ctx || {};
  const replyText = norm(c.replyText || "");
  const snapText = norm(c.snapshotText || "");
  const summary = !!c.summary;
  const reply = summary ? c.replyModel || replyModel(c.replyText || "") : null;
  const known = summary ? [norm(c.replyText || ""), snapText, norm(c.heardText || "")].join("\n") : "";
  const whole = norm(sentences.join(" "));
  // Talking about missions and their steps, from a snapshot that has step
  // statuses: "done" is a status there, not a claim. (Judged over the whole
  // text, since commas split "the first step, Design, is done".)
  const stepTalk = !summary && !!c.grounded && STEP_TALK.test(whole) && /"status":"(done|skipped)"/.test(snapText);
  const numbers = c.numbers || new Set();
  let prevTerms = [];
  let prevAction = false;
  let replyDone = null; // the actions the reply says were done, read once when needed
  const replyDid = (concept) => {
    if (!replyDone) {
      replyDone = new Set();
      for (const rc of clauses(c.replyText || "")) for (const p of polarClaims(rc)) if (p.concept !== "alive" && p.sign > 0 && !p.future) replyDone.add(p.concept);
    }
    return replyDone.has(concept);
  };
  const fail = (rule, match, at) => ({ ok: false, rule, match: String(match), at });
  for (let si = 0; si < sentences.length; si++) {
    const sentence = sentences[si];
    const sClauses = clauses(sentence);
    // Fail closed: letters in a script the guard cannot read (neither Latin nor Arabic).
    if (arabic.scriptOf(sentence).other) return fail("unknown-script", sentence, si);
    // A confirmation right after an action sentence: the pair is the claim.
    if (si > 0 && prevAction && sClauses.length && (CONFIRM.test(sClauses[0]) || arabic.confirmFirst(sClauses[0]))) return fail("action-claim", sentences[si - 1] + " " + sentence, si - 1);
    // A sentence that reports a screen action that really returned ok this turn
    // («خلاص، قفلت المهام», «عملت اللي طلبته، قفلت المهام»): its bare "done" /
    // "did what you asked" clauses are about that action, not a new claim.
    const uiSentence = !summary && !!c.uiOk && UiActions.claims(sentence);
    for (const raw of sClauses) {
      const cl = raw.replace(WORKING_ON_AR, " «checking» ").replace(CHECKING_AR_G, " «checking» ");
      let m;
      // One identity: never "I've passed that to JOYA AI", never "JOYA AI says ...".
      if (thirdPerson(cl)) return fail("third-person", raw, si);
      // A screen action announced in a response whose calls are not known yet (null: the Releaser holds it)
      // or that does call ui_action (true): the call and the page's answer decide, not the words.
      // (Only in a sentence that announces nothing else: "I'll open the missions and delete the logs" is still judged.)
      if (!summary && (c.uiCalling === null || c.uiCalling === true) && UI_ANNOUNCE.test(cl) && !ACTION_ANY.test(norm(sentence).replace(UI_ANNOUNCE_G, " "))) continue;
      // "I opened Missions" / «فتحتلك الـ missions»: only after a ui_action in this turn returned ok.
      const uiClaim = !summary && UiActions.claims(cl);
      if (uiClaim && !c.uiOk) return fail("ui-claim", raw, si);
      // A first-person result ("I found ...", «لقيت إن ...») before any result has arrived is invented.
      const findAt = findingAt(cl);
      const finding = findAt >= 0 && !QUESTION_END.test(raw) && !OFFER_EN.test(cl.slice(0, findAt + 1)) && !arabic.OFFER_AR.test(cl.slice(0, findAt + 1));
      if (!summary && finding && !c.replied) return fail("invented-finding", raw, si);
      // "I restarted Odoo": only when a result says it was done (in a summary, summaryClause holds it to the reply).
      if (!summary && (m = CLAIM_FIRST.exec(cl)) && !negatedBefore(cl, m.index + m[0].length - m[2].length) && !replyDid("act:" + stem(m[2])) && !(uiClaim && UI_VERBS.test(m[2]))) return fail("action-claim", raw, si);
      if (!summary && (m = PROGRESSIVE_FIRST.exec(cl)) && !negatedBefore(cl, m.index + m[0].length - m[2].length)) return fail("action-claim", raw, si);
      if (!summary && sClauses.length > 1 && raw !== sClauses[0] && (m = CLAIM_BARE_PAST.exec(cl)) && !replyDid("act:" + stem(m[1])) && !(c.uiOk && UI_VERBS.test(m[1]))) return fail("action-claim", raw, si);
      if (!summary && (m = PROGRESSIVE_BARE.exec(cl))) return fail("action-claim", raw, si); // in a summary a gerund is a noun ("recommends rebooting"), judged below
      if (summary && (m = PROGRESSIVE_FIRST.exec(cl)) && !negatedBefore(cl, m.index + m[0].length - m[2].length) && !replyDoing(reply, m[2])) return fail("action-claim", raw, si);
      // A clause said exactly as the reply has it (GPT-Live repeating the result) adds nothing to it --
      // «الباك أب ... خلص الساعة 3:05» was cut as an added claim because the clause split at the time's colon.
      const fromReplyVerbatim = summary && replyText && cl.trim().length >= 8 && replyText.includes(cl.trim());
      if (summary) {
        if (!fromReplyVerbatim) {
          const ar = arabicSummaryRule(cl, replyDid, reply);
          if (ar) return fail(ar, raw, si);
          const s = summaryClause(cl, raw, reply);
          if (s) return fail(s.rule, s.match, si);
          if ((m = CLAIM_BARE.exec(cl)) && !polarClaims(cl).length) return fail("added-claim", raw, si);
        }
      } else {
        if ((m = CLAIM_BARE.exec(cl)) && !(stepTalk && /^(done|finished|completed)$/.test(m[1]))) return fail("action-claim", raw, si);
        if ((m = CLAIM_THIRD.exec(cl)) && !negatedBefore(cl, m.index + m[0].length - m[2].length) && !conditionalBefore(cl, m.index + m[0].length - m[2].length)) {
          const word = m[2];
          const fromReply = replyText && uni(new RegExp("\\b" + word.replace(/ /g, "\\s+") + "\\b")).test(replyText);
          // "1 of 4 steps done", "the mission has completed 1 out of 4 steps": a status, from the snapshot.
          const stepStatus = /^(done|completed|finished)$/.test(word) && stepTalk;
          if (!fromReply && !stepStatus) return fail("action-claim", raw, si);
        }
        if ((m = PROMISE.exec(cl)) && !negatedBefore(cl, m.index + m[0].length - m[2].length)) return fail("promise", raw, si);
        if ((m = SHOULD_BE.exec(cl)) && !negatedBefore(cl, m.index)) return fail("promise", raw, si);
        if (!c.replied) {
          if ((m = ATTRIBUTION.exec(cl)) && !negatedBefore(cl, m.index + m[0].length)) return fail("invented-reply", raw, si);
          if ((m = ANSWER_IS.exec(cl)) && !negatedBefore(cl, m.index)) return fail("invented-reply", raw, si);
        }
        // A status claim needs the snapshot behind it, and must be about something
        // the snapshot covers ("the backups are fine" never is). "It" and
        // "everything" borrow their subject from the clause before.
        const ar = arabic.hasArabic(cl);
        if (ar) {
          const rule = arabicDeskRule(cl, { stepTalk, replyDid, replied: !!c.replied, uiDid: uiClaim && c.uiOk, uiSentence });
          if (rule) return fail(rule, raw, si);
        }
        // (Arabic status words and terms count the same, named by the snapshot's English terms.)
        const arStates = ar ? arabic.statesIn(cl) : [];
        let terms = [...cl.matchAll(STATUS_TERM)].map((x) => x[1]).concat(ar ? arabic.termsIn(cl) : []);
        const strong = STATE_STRONG.test(cl) || arStates.some((x) => x.strong);
        if (!terms.length && (PRONOUN_SUBJECT.test(cl) || (ar && arabic.pronounSubject(cl))) && strong) terms = prevTerms.length ? prevTerms : ["(unnamed)"];
        const stateWord = STATE_WORD.test(cl) || arStates.length > 0;
        const hedge = HEDGE.test(cl) || REPORT_TALK.test(cl) || (ar && arabic.hedged(cl));
        if (terms.length && stateWord && !hedge && finding && c.replied) {
          // "I found that Odoo is down": a result, so it must be about what a result says.
          if (!(replyText && terms.some((t) => t === "(unnamed)" || replyText.includes(t.replace(/s$/, ""))))) return fail("not-in-reply", raw, si);
        } else if (terms.length && stateWord && !hedge && !JOYA_NAME.test(cl) && !(c.uiOk && uiOpenOnly(cl))) {
          if (!c.grounded) return fail("ungrounded", raw, si);
          const knownTerm = terms.some((t) => t === "(unnamed)" || snapText.includes(t.replace(/s$/, "")));
          if (!knownTerm && !(replyText && terms.some((t) => replyText.includes(t.replace(/s$/, ""))))) return fail("not-in-snapshot", raw, si);
        }
        if (terms.length) prevTerms = terms;
      }
    }
    if (summary) {
      if (UNSPEAKABLE.test(sentence)) return fail("unspeakable", sentence, si);
      const name = unknownName(sentence, known);
      if (name) return fail("added-name", name, si);
    }
    for (const n of numbersIn(sentence)) {
      if (!numbers.has(n)) return fail("figure", String(n), si);
    }
    const s = withoutHandoff(sentence);
    prevAction = !QUESTION_END.test(sentence.trim()) && ((ACTION_ANY.test(s) && !NEGATION.test(s)) || arabicAction(s));
  }
  return { ok: true };
}

/**
 * The action a first-person Arabic claim names: its own verb, or -- for the
 * generic «عملت» ("I did") -- the English verb after it («عملت restart»).
 */
function claimConcept(cl, x) {
  if (!x.generic) return "act:" + stem(x.en);
  const after = cl.slice((x.idx || 0) + String(x.word || "").length);
  const w = /^\s*(?:\S+\s+)?([a-z][a-z ]*?)\b(?=\s|$|[.,;!?،])/.exec(after);
  const verb = w && new RegExp("^(?:" + DONE_WORDS + "|" + DO_WORDS + ")$").exec(w[1].trim().split(" ")[0]);
  return verb ? "act:" + stem(verb[0]) : null;
}

// The verbs a screen action is claimed with, as the claim rules name them (English stems too).
const UI_VERBS = /^(?:stopped|stop|closed|close|ended|end|changed|change|switched|switch|opened|open|muted|mute|showed|show|set|turned)$/;

/** Does the reply say this action is under way ("I'm restarting it now")? */
function replyDoing(reply, word) {
  if (!reply) return false;
  const want = "act:" + stem(word);
  return reply.clauses.some((rc) => rc.claims.some((p) => p.concept === want && p.sign > 0));
}

/**
 * The Arabic rules for the voice's own words, for one clause (normalized, hand-off removed):
 * the same claims the English rules cut, read with the Arabic lexicon.
 *   I did / we did / I am doing it        → action-claim   (CLAIM_FIRST, PROGRESSIVE_FIRST)
 *   done / it was done / it is being done → action-claim, unless JOYA AI's
 *                                           reply says it was (CLAIM_THIRD) or
 *                                           it is a step's status (CLAIM_BARE)
 *   I will / it will                      → promise        (PROMISE; "I'll send
 *                                           you" is a promise to talk)
 *   an action noun first ("إعادة تشغيل")  → action-claim   (PROGRESSIVE_BARE)
 *   "right now" with an action            → promise
 *   "JOYA AI said ..." before a reply     → invented-reply (ATTRIBUTION)
 *   a past-tense result it cannot read    → unparsed-claim (fail closed)
 */
function arabicDeskRule(cl, { stepTalk, replyDid, replied, uiDid, uiSentence }) {
  const claims = arabic.claimsIn(cl);
  for (const x of claims) {
    if (x.negated) continue;
    if (uiDid && UI_VERBS.test(x.en || "")) continue; // «قفلتلك الـ panel», after a ui_action that returned ok
    // In the sentence that reports it: «خلاص» and «عملت اللي طلبته», naming no other action.
    if (uiSentence && ((x.role === "done" && x.generic) || (x.en === "do" && !claimConcept(cl, x) && !ACTION_ANY.test(cl)))) continue;
    if ((x.role === "did1" || x.role === "ptc1") && claimConcept(cl, x) && replyDid(claimConcept(cl, x))) continue; // «عملت restart لأودو» -- and a result says so
    if (x.role === "did1" || x.role === "amb" || x.role === "prog1" || x.role === "ptc1") return "action-claim"; // ptc1: «أنا عاملة ده»
    if (x.role === "done" || x.role === "pass" || x.role === "prog3") {
      if (stepTalk && x.role === "done" && x.generic) continue;
      if (x.idx != null && conditionalBefore(cl, x.idx)) continue; // «هشوف إذا كان تم»: asked about, not claimed
      if (!x.generic && replyDid("act:" + stem(x.en))) continue;
      return "action-claim";
    }
    if (x.role === "fut1") {
      // "I'll send you / update you" is a promise to talk; "I'll delete it for you" is not.
      if (x.addressee && (x.en === "send" || x.en === "update")) continue;
      return "promise";
    }
    if (x.role === "fut3") return "promise";
  }
  if (arabic.nounFirst(cl)) return "action-claim";
  if (arabic.nowMarker(cl)) {
    const action = claims.some((x) => !x.negated) || ACTION_ANY.test(cl);
    const status = arabic.statesIn(cl).length || arabic.termsIn(cl).length || STATUS_TERM.test(cl);
    STATUS_TERM.lastIndex = 0;
    if (action || !status) return "promise";
  }
  if (!replied && arabic.attribution(cl)) return "invented-reply";
  if (arabic.unparsed(cl)) return "unparsed-claim";
  return null;
}

/*
 * Does a summary clause restate one sentence of the reply -- the same facts, its own words? The
 * summariser paraphrases verbs the guard's lexicon may not know (the reply's «خلّينا» became «عملنا»),
 * so a first-person "we did" is held to the reply's facts instead of its verb:
 *   - one reply sentence carries at least RESTATE_SHARE of the clause's content words (and RESTATE_MIN,
 *     a word among them; RESTATE_EXTRA of them missing at most), with Arabic prefixes (و ب ل ال) and English endings taken off both sides;
 *   - every number of the clause is in that sentence;
 *   - that sentence says it plainly: no question, offer, "if", future or modal ("we can make a copy"),
 *     and a negation in it before the shared words only if the clause is negated too (and the other way);
 *   - `concept` (a named action, "act:delet"): the sentence names the same action, done -- so "we deleted
 *     the live copy at 8" never passes on "we made the live copy at 8".
 * Pure; used only in summary mode, where the reply is the voice's own finished work.
 */
const RESTATE_SHARE = 0.8;
const RESTATE_EXTRA = 1; // words of the clause the sentence lacks, at most ("a copy of the CLIENT's database" is another fact)
const RESTATE_MIN = 3;
const AR_STOP = new Set("من في على الى الي عن مع هي هو ده دي دا اللي الذي التي كان كانت بتاع بتاعه بتاعت بتاعنا بتاعتنا لسه بس كمان يعني علشان عشان لان".split(" "));
const MODAL_EN = /\b(?:can|could|would|will|shall|should|may|might|want me|wants? to|going to|gonna|if|whether|unless|once)\b|'ll\b/;
const MODAL_AR = /(?:^|\s)(?:ممكن|يمكن|نقدر|اقدر|أقدر|تقدر|لو|اذا|إذا|هل|عايز|عاوز|محتاج|لازم|سوف)(?:\s|$)/u;
function restateTokens(text, skip) {
  const sk = new Set((skip || []).map((w) => norm(w)));
  const out = [];
  for (const m of arabic.joinDigits(norm(text)).matchAll(/\d+(?:[.,:]\d+)*|[\p{L}][\p{L}']*/gu)) {
    let w = m[0];
    if (sk.has(w)) continue;
    if (/^\d/.test(w)) {
      out.push(w);
      continue;
    }
    if (arabic.hasArabic(w)) {
      if (AR_STOP.has(w)) continue;
      const bare = w.replace(/^(?:و|ف)?(?:بال|وال|لل|ال|ب|ل)/u, "");
      w = bare.length >= 3 ? bare : w;
      if (w.length < 3) continue;
      out.push(w);
    } else {
      if (w.length < 3 || STOP.has(w)) continue;
      out.push(stem(w));
    }
  }
  return out;
}
function restatesReply(cl, reply, o) {
  o = o || {};
  const mine = restateTokens(cl, o.skip);
  const words = mine.filter((w) => !/^\d/.test(w));
  const min = o.min || RESTATE_MIN;
  if (mine.length < min || !words.length) return false;
  const nums = numbersIn(cl);
  const clNeg = NEGATION.test(cl) || (arabic.hasArabic(cl) && arabic.claimsIn(cl).some((x) => x.negated)); // «معملناش» is "we did not"
  for (const sent of speakableSentences(reply.text)) {
    const n = norm(sent);
    if (QUESTION_END.test(n) || OFFER_EN.test(n) || arabic.OFFER_AR.test(n)) continue;
    if (!o.modalOk && (MODAL_EN.test(n) || MODAL_AR.test(n))) continue;
    const theirs = restateTokens(sent, o.skip);
    const set = new Set(theirs);
    const shared = mine.filter((w) => set.has(w));
    // A short clause ("tomorrow it should be overcast": 2 words) must be all in the sentence.
    const extra = mine.length < RESTATE_MIN ? 0 : RESTATE_EXTRA;
    if (shared.length < min || shared.length < Math.ceil(mine.length * RESTATE_SHARE) || mine.length - shared.length > extra || !shared.some((w) => !/^\d/.test(w))) continue;
    const theirNums = new Set(numbersIn(sent));
    if (nums.some((x) => !theirNums.has(x))) continue;
    // A negation before (or among) the shared words, unless the clause says "not" too; a future-tense claim.
    const firstAt = Math.min(...shared.map((w) => theirs.indexOf(w)).filter((i) => i >= 0));
    const negBefore = theirs.slice(0, Math.max(firstAt, 0)).some((w) => NEGATION.test(w) || arabic.isNegWord(w)) || NEGATION.test(n.split(/\s+/).slice(0, 3).join(" "));
    if (negBefore !== clNeg) continue;
    if (!o.modalOk && arabic.hasArabic(n) && arabic.claimsIn(n).some((x) => !x.negated && (x.role === "fut1" || x.role === "fut3"))) continue;
    if (o.concept) {
      const done = polarClaims(n).some((p) => p.concept === o.concept && p.sign > 0 && !p.future);
      if (!done) continue;
    }
    return true;
  }
  return false;
}

/**
 * After a cut: which of a result's sentences the administrator has NOT yet heard, matched by content (never
 * by counting: GPT-Live joins and splits sentences in its own words, so its third sentence need not be the
 * result's third -- on call lv1g84s, 2026-10-30, a count mismatch had the weather read twice).
 *   sentences  the result's sentences (what the reader would read)
 *   heard      what the administrator heard of it and the guard passed (GPT-Live's released sentences)
 *   source     the facts it summarises (JOYA AI's reply): a sentence with no figure and no word of it
 *              ("Sure.", "Let me know if you need anything else.") is trivial, never read on its own
 * A sentence is heard when its figures were all heard and RESTATE_SHARE of its words were.
 * Returns { lines: [{i, text}], heard: [i], trivial: [i] }.
 */
const HEARD_FILLER = new Set(["sure", "okay", "right", "well", "so", "here", "that", "covers", "main", "details", "let", "know", "need", "anything", "else", "hope", "helps"]);
function unheardLines(sentences, heard, source) {
  const heardSet = new Set(restateTokens(heard || ""));
  const heardNums = new Set(numbersIn(heard || ""));
  const src = new Set(restateTokens(source || ""));
  const out = { lines: [], heard: [], trivial: [] };
  (sentences || []).forEach((text, i) => {
    const toks = restateTokens(text);
    const nums = numbersIn(text);
    const words = toks.filter((w) => !/^\d/.test(w));
    if (!nums.length && !words.some((w) => src.has(w) && !HEARD_FILLER.has(w))) return out.trivial.push(i);
    const got = toks.filter((w) => heardSet.has(w)).length;
    if (nums.every((n) => heardNums.has(n)) && toks.length && got >= Math.ceil(toks.length * RESTATE_SHARE)) return out.heard.push(i);
    out.lines.push({ i, text });
  });
  return out;
}

/** The index of the sentence sharing the most words and figures with `text` (-1: none shares any). */
function bestMatch(sentences, text) {
  const mine = new Set(restateTokens(text || ""));
  let best = -1;
  let score = 0;
  (sentences || []).forEach((s, i) => {
    const n = restateTokens(s).filter((w) => mine.has(w)).length;
    if (n > score) {
      score = n;
      best = i;
    }
  });
  return best;
}

/**
 * The Arabic rules in a summary, beyond what summaryClause checks against the
 * reply: "I did" only what the reply says was done (the voice is its author); a
 * bare "done" (تم، خلاص) that names nothing the reply did; a result it cannot read.
 */
function arabicSummaryRule(cl, replyDid, reply) {
  if (!arabic.hasArabic(cl)) return null;
  const claims = arabic.claimsIn(cl);
  for (const x of claims) {
    if (x.negated) continue;
    // First person, as the reply's author: «عملت restart لأودو» only if the reply says it was done.
    if ((x.role === "did1" || x.role === "ptc1") && replyDid && claimConcept(cl, x) && replyDid(claimConcept(cl, x))) continue;
    // ... or restates a sentence the reply states as done, in other words («عملنا نسخة من اللايف الساعة 8»
    // for «خلّينا نسخة من اللايف ... الساعة 8»: cut on call lv1jz4g, 2026-10-30). The generic "we did / made"
    // needs the same facts in one plain, unnegated reply sentence; a named action ("we deleted") also needs
    // that sentence to name the same action (restatesReply).
    if ((x.role === "did1" || x.role === "ptc1") && reply && restatesReply(cl, reply, { skip: [x.word], concept: x.generic ? claimConcept(cl, x) : "act:" + stem(x.en) })) continue;
    if (x.role === "did1" || x.role === "prog1" || x.role === "ptc1") return "action-claim";
    if (x.generic && (x.role === "done" || x.role === "pass") && !polarClaims(cl).length) return "added-claim";
  }
  if (arabic.unparsed(cl) && !(reply && restatesReply(cl, reply))) return "unparsed-claim";
  return null;
}

/**
 * Check the voice's own words (all of them, as one text).
 * @returns { ok: true } or { ok: false, rule, match, at }
 */
function guard(text, ctx) {
  return judge(sentencesOf(text, true), ctx);
}

/**
 * Does this say "I'm checking" / "give me a moment" / «ثانية أشوفلك» / "I'll
 * tell you what I find" when no request is being worked on? (It replaced the
 * old "I've passed that to JOYA AI needs an ask_joya call" rule, 2026-09-29.)
 * `askedNow`: ask_joya ran this turn (or is in this very response).
 * `pending`: an earlier request is still being worked on -- "I'm still
 * checking" is true then too.
 */
const ANSWER_PROMISE_EN = uni(/\b(?:read|tell|give|pass|let) you\b[^.]{0,40}\b(?:answer|reply|response|what i find|what i found|what i see|know)\b|\b(?:its|joya ai's|joya ai's|the|my) (?:answer|reply|response|result)\b[^.]{0,20}\bwhen it (?:arrives|comes)\b|\bget back to you\b/);
const ANSWER_PROMISE = { test: (t) => ANSWER_PROMISE_EN.test(t) || arabic.ANSWER_PROMISE_AR.test(t), search: (t) => Math.max(t.search(ANSWER_PROMISE_EN), t.search(arabic.ANSWER_PROMISE_AR)) };
const OFFER_EN = uni(/\b(want me to|shall i|should i|do you want|i can|i could|can i|could i)\b/);
function unbackedChecking(text, { askedNow, pending } = {}) {
  if (askedNow || pending) return null;
  for (const cl of clauses(text)) {
    // "I'll tell you what I find" / «هقولك» -- with nothing being worked on, nothing is coming.
    if (ANSWER_PROMISE.test(cl) && !negatedBefore(cl, ANSWER_PROMISE.search(cl))) return { ok: false, rule: "unbacked-checking", match: cl };
    if (!CHECKING.test(cl)) continue;
    const at = CHECKING.index(cl);
    if (QUESTION_END.test(cl) || OFFER_EN.test(cl.slice(0, at + 1)) || arabic.OFFER_AR.test(cl.slice(0, at + 1))) continue; // an offer ("want me to check?"), not a claim
    if (negatedBefore(cl, at)) continue;
    return { ok: false, rule: "unbacked-checking", match: cl };
  }
  return null;
}
const unbackedHandoff = unbackedChecking; // the old name (callers and tests)
/** Does this sentence say "I'm checking" / "give me a moment" / «ثانية أشوفلك»? */
function mentionsChecking(sentence) {
  const s = norm(sentence);
  return CHECKING.test(s) || ANSWER_PROMISE.test(s);
}

/**
 * Does the settled text end on a JOYA mention ("... into joya", "\"joya", "JOYA AI")? Then the next
 * word decides what it is -- "JOYA AI OS", a separate session, is not the voice speaking of itself
 * in the third person -- so the tail waits for it (the whole sentence is judged before release anyway).
 */
function endsOnJoya(partial) {
  return /(?:^|[^\p{L}\p{N}])["'“‘«(]?(?:joya|جويا|جوية)(?:\s+(?:ai|اي\s*اي))?["'”’»)]?\s*$/iu.test(String(partial || ""));
}

/** The part of a streaming text whose last word is complete. */
function settled(text) {
  const t = String(text || "");
  const i = Math.max(t.lastIndexOf(" "), t.lastIndexOf("\n"));
  return i < 0 ? "" : t.slice(0, i);
}

/**
 * Releases a streaming response sentence by sentence, each only once the
 * guard has passed it in context (see the header).
 *
 *   update(text, final, info)  text so far; `final` once the response is done;
 *                              info: { askedNow(), pending() } for hand-offs
 *
 * `released` counts sentences handed to onLine; `trip` is set once the guard
 * cuts, after which nothing more is released.
 */
class Releaser {
  constructor(ctxFn, onLine, opts) {
    this.ctxFn = ctxFn;
    this.onLine = onLine || (() => {});
    this.summary = !!(opts && opts.summary);
    this.released = 0;
    this.sentences = [];
    this.trip = null;
  }

  update(text, final, info) {
    if (this.trip) return;
    const i = info || {};
    // A summary's markdown emphasis (`code`, **bold**) is formatting, not words.
    const list = sentencesOf(this.summary ? String(text).replace(/[`*]+/g, "") : text, final);
    this.sentences = list;
    // A hand-off said in the passive is true once the ask_joya call is known.
    // A screen action announced ("I'll open the missions") waits until the response's calls are known (uiCalling).
    const uiCalling = i.uiCalling ? i.uiCalling() : undefined;
    const ctxNow = () => ({ ...this.ctxFn(), askedNow: !!(i.askedNow && i.askedNow()), ...(uiCalling !== undefined ? { uiCalling } : {}) });
    const g = judge(list, ctxNow());
    if (!g.ok) {
      this.trip = { ...g, sentence: list[g.at] || "" };
      return;
    }
    // While streaming, also judge the unfinished tail (settled words only), so
    // a response going wrong is cancelled early. It releases nothing.
    // (Not for a summary: its rules need whole clauses -- "It recommends" is
    // not yet a recommendation of anything.)
    if (!final && !this.summary && !endsOnJoya(settled(text))) {
      const partial = settled(text);
      const plist = sentencesOf(partial, true);
      const g2 = judge(plist, ctxNow());
      // (Not while the unfinished sentence may still become a hand-off:
      // «بعتّ ده ...» is a claim until «... لـ JOYA AI» arrives. The whole
      // sentence is judged before it is released either way.)
      if (!g2.ok) {
        this.trip = { ...g2, sentence: plist[g2.at] || "" };
        return;
      }
    }
    if (final && !this.summary) {
      // (A read_status call in this response backs "let me check" too: it is looking.)
      const u = unbackedChecking(list.slice(this.released).join(" "), { askedNow: (i.askedNow && i.askedNow()) || (i.lookedNow && i.lookedNow()), pending: i.pending && i.pending() });
      if (u) {
        this.trip = { ...u, at: this.released };
        return;
      }
    }
    for (let k = this.released; k < list.length; k++) {
      const s = list[k];
      const last = k === list.length - 1;
      if (!final && last && needsNext(s)) break; // judged with the next one, or at the end
      if (!final && !this.summary && mentionsChecking(s) && !(i.askedNow && i.askedNow()) && !(i.pending && i.pending())) break; // backed only once the calls are known
      if (!this.summary && uiCalling === null && uiAnnounce(s)) break; // backed only once the calls are known
      this.released = k + 1;
      this.onLine(s);
    }
  }

  /** The sentences already heard, as one text. */
  heardText() {
    return this.sentences.slice(0, this.released).join(" ");
  }
}

/* ------------------------------------------------------ the summariser -- */

let seq = 0;

/**
 * Short spoken summaries of JOYA AI's replies, for one panel user: one
 * realtime session answering in text only, with no tools and no conversation
 * of its own (every summary is an out-of-band response). `ops` is voiceOps();
 * its sentences are spoken, once released, by the caller.
 */
class Summariser {
  constructor({ key, voice, model, ops, wsBase, log }) {
    this.key = key;
    this.voice = voice || "marin";
    this.model = model || SUMMARY_MODEL;
    this.ops = ops;
    this.wsBase = wsBase || WS_BASE;
    this.log = log || (() => {});
    this.bornAt = Date.now();
    this.usedAt = Date.now();
    this.dead = false;
    this.ws = null;
    this.ready = null;
    this.handler = null;
    this.queue = Promise.resolve();
    this.inflight = 0;
    this.usage = {}; // billable tokens, whole session
    this.stats = { trips: 0, summaries: 0 };
    this.id = "sum" + ++seq;
  }

  usable() {
    return !this.dead && Date.now() - this.bornAt < MAX_AGE_MS && (!this.ws || this.ws.readyState <= WebSocket.OPEN);
  }

  open() {
    if (this.ready) return this.ready;
    this.ready = new Promise((resolve, reject) => {
      const ws = (this.ws = new WebSocket(this.wsBase + "/realtime?model=" + encodeURIComponent(this.model), {
        headers: { Authorization: "Bearer " + this.key },
        handshakeTimeout: 10000,
        perMessageDeflate: false,
      }));
      let opened = false;
      const fail = (err) => {
        this.close();
        if (!opened) reject(err);
        else if (this.handler) this.handler({ type: "__fail", error: err });
      };
      ws.on("unexpected-response", (req, res) => {
        let body = "";
        res.on("data", (d) => {
          if (body.length < 4096) body += d;
        });
        res.on("end", () => fail(new OpsError("OpenAI refused the summary session (" + res.statusCode + "): " + scrub(body), res.statusCode === 401 ? "auth" : "upstream")));
      });
      ws.on("error", (e) => fail(new OpsError("Could not reach OpenAI: " + scrub(e.message), "network")));
      ws.on("close", () => fail(new OpsError("OpenAI closed the summary session's connection", "upstream")));
      ws.on("open", () => {
        this.send({
          type: "session.update",
          session: { type: "realtime", instructions: SUMMARY_INSTRUCTIONS, output_modalities: ["text"], tools: [], tool_choice: "none", max_output_tokens: 900 },
        });
      });
      ws.on("message", (data) => {
        let ev;
        try {
          ev = JSON.parse(String(data));
        } catch (_) {
          return;
        }
        if (!opened) {
          if (ev.type === "session.updated") {
            opened = true;
            return resolve(this);
          }
          if (ev.type === "error") return fail(new OpsError(scrub((ev.error && ev.error.message) || "OpenAI error"), "upstream"));
          return;
        }
        if (this.handler) this.handler(ev);
      });
    });
    this.ready.catch(() => {});
    return this.ready;
  }

  send(obj) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(obj));
  }

  close() {
    if (this.dead) return;
    this.dead = true;
    try {
      if (this.ws) this.ws.close();
    } catch (_) {
      /* closed */
    }
  }

  /**
   * One realtime response, released sentence by sentence through `rel`.
   * `create` is the response.create payload.
   */
  respond(t0, timings, rel, info, create) {
    return new Promise((resolve, reject) => {
      const st = { text: "", itemIds: [], status: null, usage: null };
      const timer = setTimeout(() => {
        this.handler = null;
        reject(new OpsError("the summary took too long", "timeout"));
      }, RESPONSE_TIMEOUT_MS);
      let cancelled = false;
      const check = (final) => {
        const before = rel.released;
        rel.update(st.text, final, info);
        if (rel.released > before && !timings.firstLine) timings.firstLine = Date.now() - t0;
        if (rel.trip && !final && !cancelled) {
          cancelled = true;
          this.send({ type: "response.cancel" });
        }
      };
      this.handler = (ev) => {
        switch (ev.type) {
          case "__fail":
            clearTimeout(timer);
            this.handler = null;
            return reject(ev.error);
          case "error":
            // A cancel that arrives after the response ended is harmless.
            if (ev.error && /no active response|cancel/i.test(String(ev.error.message || ev.error.code || ""))) return;
            clearTimeout(timer);
            this.handler = null;
            return reject(new OpsError(scrub((ev.error && ev.error.message) || "OpenAI error"), "upstream"));
          case "response.output_text.delta":
          case "response.output_audio_transcript.delta":
          case "response.audio_transcript.delta":
            if (!timings.firstText) timings.firstText = Date.now() - t0;
            st.text += ev.delta || "";
            if (!rel.trip) check(false);
            break;
          case "response.done": {
            clearTimeout(timer);
            this.handler = null;
            const r = ev.response || {};
            st.status = r.status || "completed";
            st.usage = r.usage || null;
            for (const o of r.output || []) {
              if (o.type === "message") {
                // The finished text is authoritative (deltas can be missed on a cancel).
                const full = (o.content || []).map((p) => p.transcript || p.text || "").join("");
                if (full && !rel.trip) st.text = full;
              }
            }
            if (r.status === "failed") {
              const d = r.status_details || {};
              return reject(new OpsError("OpenAI did not finish: " + scrub((d.error && d.error.message) || d.reason || "failed"), "upstream"));
            }
            if (!rel.trip) check(true);
            return resolve(st);
          }
          default:
            break;
        }
      };
      this.send(create);
    });
  }

  /**
   * respond(), retried once when OpenAI reports a transient server error and
   * nothing of the response was released.
   */
  async respondOnce(t0, timings, relFn, info, create) {
    let rel = relFn();
    try {
      return { st: await this.respond(t0, timings, rel, info, create), rel };
    } catch (e) {
      if (!(e instanceof OpsError) || e.code !== "upstream" || !/server had an error|server_error|try again|retry/i.test(e.message) || rel.released) throw e;
      this.log("summary: OpenAI server error, retrying once: " + e.message.slice(0, 120));
      rel = relFn();
      return { st: await this.respond(t0, timings, rel, info, create), rel };
    }
  }

  /** Count what a response cost. */
  account(st, turn) {
    if (!st || !st.usage) return;
    const t = tokensOf(st.usage);
    turn.tokens = addTokens(turn.tokens, t);
    this.usage = addTokens(this.usage, t);
  }

  /** One summary at a time; `inflight` keeps summariserFor from replacing a busy one. */
  serial(fn) {
    this.inflight++;
    const run = this.queue.then(fn);
    this.queue = run.catch(() => {});
    const done = () => {
      this.inflight--;
    };
    run.then(done, done);
    return run;
  }

  /**
   * A detailed spoken summary of JOYA AI's reply to one of this user's voice
   * requests. `opts.onLine(line)` is called for each line as soon as it may
   * be spoken ({text, safe}); `opts.persona` the saved persona;
   * `opts.request` what the administrator asked (their words, as heard);
   * `opts.alreadySaid` sentences of the reply the administrator has already
   * heard (read while it was written): the summary covers the rest and does
   * not repeat them, and a short reply is not read again word for word.
   * Resolves with { fallback: "verbatim" } when the reply should simply be read
   * as written (short and plain, or the summary was cut before a word was
   * said), or { pending: true } when JOYA AI has not answered yet.
   */
  summarise(turnId, opts) {
    return this.serial(() => this._summarise(turnId, opts || {}));
  }

  async _summarise(turnId, opts) {
    const id = Number(turnId);
    if (!Number.isInteger(id) || id <= 0) throw new OpsError("no such request", "invalid");
    const t0 = Date.now();
    const timings = {};
    const turn = { kind: "summary", lines: [], trip: null, tokens: {}, responses: 0 };
    let r = null;
    for (let attempt = 0; attempt < 6; attempt++) {
      const snap = await this.ops.snapshot([id]);
      r = (snap.requests_to_joya_ai || []).find((x) => x.id === id) || null;
      if (!r || r.answered) break;
      await new Promise((res) => setTimeout(res, 400)); // the page heard the end a moment before the ledger shows it
    }
    if (!r) throw new OpsError("that is not one of your voice requests", "invalid");
    if (!r.answered) return { ...this.result(turn, timings), pending: true };
    const reply = String(r.reply || "").trim();
    const asked = String(opts.request || "");
    const shape = replyShape(reply);
    turn.shape = shape;
    const finish = (fallback) => {
      timings.done = Date.now() - t0;
      return { ...this.result(turn, timings), fallback: fallback || null, shape };
    };
    if (!reply) return finish("verbatim");
    const already = Array.isArray(opts.alreadySaid) ? opts.alreadySaid.map((x) => String(x || "").trim()).filter(Boolean) : [];
    if (!already.length && shape.plain && reply.length <= VERBATIM_MAX_CHARS && shape.sentences <= 2) return finish("verbatim"); // nothing to shorten
    await this.open();
    this.usedAt = Date.now();
    this.stats.summaries++;
    const emit = (line) => {
      turn.lines.push(line);
      if (!timings.firstLine) timings.firstLine = Date.now() - t0;
      if (opts.onLine) opts.onLine(line, Date.now() - t0);
    };
    const model = replyModel(reply);
    const ctx = {
      summary: true,
      replyText: reply,
      replyModel: model,
      heardText: asked,
      snapshotText: "",
      numbers: strictNumberSet([reply, asked]),
      replied: true,
      grounded: true,
    };
    // The language of the administrator's last words (else the reply's).
    const lastSaid = String(opts.lastSaid || asked || "");
    const sumLang = replyLanguage(lastSaid || reply);
    turn.lang = sumLang;
    const sumPersona = personaLib.clean(opts.persona);
    const quoted = reply.replace(/"""/g, '"');
    const create = {
      type: "response.create",
      response: {
        conversation: "none",
        output_modalities: ["text"],
        tool_choice: "none",
        tools: [],
        max_output_tokens: SUMMARY_MAX_TOKENS,
        metadata: { purpose: "summary" },
        instructions: SUMMARY_INSTRUCTIONS,
        input: [
          {
            type: "message",
            role: "user",
            content: [
              {
                type: "input_text",
                text:
                  (asked ? `The administrator asked: "${asked.slice(0, 500)}"\n\n` : "") +
                  `Your finished work (your reply), between the triple quotes:\n"""\n${quoted}\n"""\n` +
                  (shape.code || shape.paths ? "It has code, commands or paths: do not read those, say they are on screen.\n" : "") +
                  (already.length ? `The administrator has already heard these sentences of it read aloud: "${already.join(" ").slice(0, 1200)}"\nDo not repeat them: go on from there and cover everything else that matters.\n` : "") +
                  summaryLanguage(lastSaid || reply, sumPersona),
              },
            ],
          },
        ],
      },
    };
    const { st, rel } = await this.respondOnce(t0, timings, () => new Releaser(() => ctx, (text) => emit({ text, safe: false }), { summary: true }), { askedNow: () => true, pending: () => false }, create);
    turn.responses++;
    this.account(st, turn);
    if (rel.trip) {
      turn.trip = { ...rel.trip, said: st.text.slice(0, 400), released: rel.released };
      this.stats.trips++;
      this.log(`summary: guard cut a summary (${rel.trip.rule}): ${JSON.stringify(rel.trip.match).slice(0, 160)}`);
      // Cut before a word of it was heard: the reply itself is read word for word (the caller's verbatim
      // reader) rather than "the answer is on screen" -- the administrator asked for the result spoken (2026-10-30).
      if (!rel.released) return finish("verbatim");
      // Cut part-way (2026-10-30, call lv1jz4g: "the rest is on screen" after one line): the part of the
      // reply the released lines did not cover is read word for word, marked `verbatim` so the caller hands
      // it to its verbatim reader, never to a voice that would paraphrase it again (restOfReply).
      const rest = restOfReply(reply, turn.lines.map((l) => l.text), REST_MAX_SENTENCES);
      turn.trip.rest = rest.lines.length;
      for (const text of rest.lines) emit({ text, safe: false, verbatim: true });
      if (rest.more) emit({ text: linesFor(langOf(reply, asked || reply), sumPersona.gender).details, safe: true, details: true });
    }
    const spoken = turn.lines.map((l) => l.text).join(" ");
    const C = linesFor(sumLang, sumPersona.gender);
    // A pending approval or question must survive the summary.
    if (REPLY_NEEDS_APPROVAL.test(norm(reply)) && !SUMMARY_MENTIONS_APPROVAL.test(norm(spoken))) {
      turn.approvalAdded = true;
      if (!turn.trip) turn.trip = { rule: "approval-dropped", match: "", said: st.text.slice(0, 400), released: rel.released, appended: true };
      emit({ text: SCREEN.test(norm(spoken)) ? C.approvalShort : C.approval, safe: true });
    } else if (!turn.trip && (shape.code || shape.paths) && !SCREEN.test(norm(spoken))) {
      // Only what cannot be spoken is left to the screen; a long reply or a list is summed up in words.
      emit({ text: C.details, safe: true, details: true });
    }
    return finish(null);
  }

  result(turn, timings) {
    return {
      kind: turn.kind,
      lines: turn.lines,
      trip: turn.trip ? { rule: turn.trip.rule, match: String(turn.trip.match || "").slice(0, 200), said: turn.trip.said, released: turn.trip.released || 0 } : null,
      tokens: turn.tokens,
      cost_usd: costOf(turn.tokens, this.model),
      responses: turn.responses,
      timings,
    };
  }
}

/**
 * What is left of a reply once these summary lines were said: its speakable sentences after the last one a
 * line covered (the reply sentence sharing the most words with each line, moving forward only; a line that
 * matches none moves nothing). Returns { lines: up to `max` sentences, more: whether any were left out }.
 */
const REST_MAX_SENTENCES = 8;
function restOfReply(reply, said, max) {
  const sents = speakableSentences(reply);
  const toks = sents.map((x) => new Set(restateTokens(x)));
  let start = 0;
  for (const line of said || []) {
    const mine = restateTokens(line);
    if (!mine.length) continue;
    let best = -1;
    let bestN = 1; // at least two shared words
    for (let j = start; j < sents.length; j++) {
      const n = mine.filter((w) => toks[j].has(w)).length;
      if (n > bestN) {
        best = j;
        bestN = n;
      }
    }
    if (best >= 0) start = best + 1;
  }
  const left = sents.slice(start);
  const n = max || REST_MAX_SENTENCES;
  return { lines: left.slice(0, n), more: left.length > n, from: start };
}

/** What kind of reply this is: lists, code, paths, how many sentences. */
function replyShape(reply) {
  const t = String(reply || "");
  const list = /^\s*(?:[-*+]|\d+\.)\s+/m.test(t);
  const code = /```|`[^`\n]+`/.test(t);
  const paths = /(?:^|\s)\/[\w.-]+\/|https?:\/\//.test(t);
  const markup = /\*\*|^#+\s/m.test(t);
  return { chars: t.length, sentences: sentencesOf(t, true).length, list, code, paths, plain: !list && !code && !paths && !markup };
}

function scrub(text) {
  return String(text == null ? "" : text)
    .replace(/\bsk-[A-Za-z0-9_\-*.]{4,}/g, "sk-…")
    .replace(/(Bearer\s+)\S+/gi, "$1…")
    .slice(0, 300);
}

/* ------------------------------------------- one summariser per user -- */

const summarisers = new Map(); // actor -> Summariser

/**
 * The summariser for this panel user, opened on first use and reused while
 * fresh (same key and voice, not idle, not too old). `call` is joyaai.call;
 * it is only ever reached through voiceOps().
 */
function summariserFor(actor, cfg, call, opts) {
  const o = opts || {};
  const id = String(actor) + "|" + String(cfg.key).slice(-6) + "|" + (cfg.voice || "");
  let s = summarisers.get(actor);
  if (s && (!s.usable() || s.cfgId !== id || (Date.now() - s.usedAt > IDLE_MS && !s.inflight))) {
    s.close();
    s = null;
  }
  if (!s) {
    s = new Summariser({ key: cfg.key, voice: cfg.voice, model: cfg.summary_model || SUMMARY_MODEL, ops: voiceOps(call, actor), wsBase: cfg.wsBase, log: o.log });
    s.cfgId = id;
    summarisers.set(actor, s);
  }
  return s;
}

function closeAll() {
  for (const s of summarisers.values()) s.close();
  summarisers.clear();
}

const sweeper = setInterval(() => {
  for (const [k, s] of summarisers) {
    if (!s.usable() || (Date.now() - s.usedAt > IDLE_MS && !s.inflight)) {
      s.close();
      summarisers.delete(k);
    }
  }
}, 60000);
if (sweeper.unref) sweeper.unref();

module.exports = {
  SUMMARY_INSTRUCTIONS,
  summaryLanguage,
  replyLanguage,
  VOICE_OPS,
  SUMMARY_MODEL,
  SAFE_LINE,
  SAFE_LINE_ASKED,
  SAFE_LINE_TAIL,
  APPROVAL_LINE,
  APPROVAL_LINE_SHORT,
  DETAILS_LINE,
  SUMMARY_CUT_LINE,
  SUMMARY_NONE_LINE,
  FORBIDDEN_KEYS,
  PRICES,
  VERBATIM_MAX_CHARS,
  Summariser,
  OpsError,
  Releaser,
  voiceOps,
  summariserFor,
  closeAll,
  forModel,
  guard,
  judge,
  sentencesOf,
  speakableSentences,
  restatesReply,
  unheardLines,
  bestMatch,
  forecastRestates,
  restOfReply,
  REST_MAX_SENTENCES,
  needsNext,
  replyShape,
  replyModel,
  strictNumberSet,
  polarClaims,
  unbackedHandoff,
  unbackedChecking,
  mentionsHandoff,
  mentionsChecking,
  thirdPerson,
  setJoyaAgents,
  uiAnnounce,
  HANDOFF_PASSIVE_AR,
  numbersIn,
  numberSet,
  settled,
  endsOnJoya,
  linesFor,
  langOf,
  LINES_AR,
  LINES_AR_F,
  LINES_AR_M,
  LINES_EN,
  UNREACHABLE_LINE,
  NOT_CAUGHT_LINE,
  tokensOf,
  addTokens,
  costOf,
  RATE,
};
