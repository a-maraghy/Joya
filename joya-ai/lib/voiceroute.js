"use strict";
/**
 * Where a live call's request goes (2026-10-30). Pure: no I/O, no clock.
 *
 * A request said in a live call (a voice-desk send carrying the call's id) no
 * longer waits in JOYA AI's main conversation (a ~450k-token context: 31-39 s
 * and up to $1.00 a turn on call lv1jz4g). It runs in a small, fresh session
 * of the call's own (lib/voicelane.js), one of three ways:
 *
 *   quick  a fact that needs no machine: the weather, the time or date, a
 *          conversion, arithmetic, general knowledge, small talk with a fact
 *          in it. A fast model with a weather tool and web search only; it
 *          answers "ESCALATE" when it finds the question needs more, and the
 *          request goes to a work lane instead.
 *   agent  the administrator addresses one of the other agents by name ("ask
 *          JOYA Pace ...", «اسأل Planning Automation ...»): a work lane hands
 *          it straight to that session with SendMessage -- the same gate,
 *          approvals and delegation ledger as JOYA AI's own delegations -- and
 *          relays the answer when it comes.
 *   work   everything else: JOYA AI's full abilities (its charter, tools,
 *          MCP, memory, the gate and the approval cards, the call's ui ticket).
 *
 * Quick is decided conservatively: it needs a quick-topic pattern AND no word
 * about the machine, its work or this screen. A wrong "work" costs a few
 * seconds; a wrong "quick" is caught by ESCALATE.
 *
 *   classify(text, { agents })  -> { lane: "quick"|"agent"|"work", agent?, why }
 *   agentNames(sessions, hired, aliases) -> [{ name, words: [aliases] }]
 *   findAgent(text, agents)     -> the agent the text ADDRESSES, or null
 */

const names = require("./names");

/** The words of a request, lower-case, Arabic letters in one spelling, the speaker tag gone. */
function normal(text) {
  return String(text || "")
    .replace(/^\s*\[speaker:[^\]]*\]\s*/i, "")
    .replace(/\n\n\[(?:Voice|Screen|Dashboard)[^\]]*\]\s*$/s, "")
    .toLowerCase()
    .replace(/[إأآٱ]/g, "ا")
    .replace(/ى/g, "ي")
    .replace(/ة/g, "ه")
    .replace(/[ً-ْـ]/g, "")
    .replace(/[’‘`]/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

// Quick topics. English and (Egyptian) Arabic, after normal().
const QUICK = [
  ["weather", /\b(weather|temperature|forecast|rain(?:ing|y)?|sunny|humid(?:ity)?|wind(?:y)?|hot outside|cold outside|degrees outside)\b|(?:^|\s)(?:الجو|جو|الطقس|طقس|درجه الحراره|الحراره|حر|برد|مطر|بتمطر|رطوبه|الرياح)(?:\s|$)/],
  ["time", /\b(what(?:'s| is) the time|what time is it|time is it|what(?:'s| is) the date|what(?:'s| is) today(?:'s date)?|which day is (?:it|today)|what day is (?:it|today)|today'?s date|current time|time in [a-z]+)\b|(?:^|\s)(?:الساعه كام|الساعه كم|النهارده ايه|النهارده كام|تاريخ النهارده|التاريخ|انهي يوم|اي يوم)(?:\s|$|؟)/],
  ["convert", /\b(convert|how many (?:grams|kilos?|kilograms|pounds|ounces|meters|feet|miles|km|kilometers|liters|litres|cups|inches|cm|centimeters|minutes|seconds|hours|days|weeks|dollars|euros|pounds)|in (?:dollars|euros|pounds|egyptian pounds|celsius|fahrenheit)|to (?:celsius|fahrenheit)|exchange rate)\b|(?:^|\s)(?:حول|كام جرام|كام كيلو|كام دولار|كام جنيه|سعر الدولار|سعر الصرف)(?:\s|$)/],
  ["math", /\b(what(?:'s| is) \d[\d.,]*\s*(?:plus|minus|times|divided by|x|\*|\+|-|\/)\s*\d|square root|percent of|\d+\s*%\s*of)\b|(?:^|\s)\d[\d.,]*\s*(?:زائد|ناقص|في|على|ضرب)\s*\d/],
  ["fact", /^(?:(?:hey |hi |ok |okay |so |um |uh |and )*)(?:who (?:is|was|wrote|invented|discovered|founded)|what (?:is|are|was|were) (?:a |an |the )?(?!the (?:status|state|disk|cpu|load|memory usage)|my |our |your )|when (?:is|was|did)|where (?:is|was)|how (?:tall|far|old|big|long|many people|deep|high) is|define|what does .{1,40} mean|meaning of|tell me (?:a joke|a fun fact)|how do you say|translate)\b|(?:^|\s)(?:مين اللي|مين هو|مين هي|يعني ايه|معني|ترجم|ازاي اقول|نكته)(?:\s|$)/],
  ["news", /\b(news|headlines|score of|who won|stock price|price of (?:gold|oil|bitcoin)|bitcoin price|gold price)\b|(?:^|\s)(?:اخبار|الاخبار|مين كسب|سعر الدهب|سعر البيتكوين)(?:\s|$)/],
];

/*
 * Anything about the machine, its work, its people or this screen: never quick. Kept wide on purpose (a
 * wrong quick only costs an ESCALATE round trip, but a quick lane can never see the machine anyway).
 */
const MACHINE =
  /\b(server|vps|machine|box|odoo|session|sessions|agent|agents|disk|cpu|ram|load|service|services|systemd|deploy\w*|logs?|backups?|missions?|approv\w*|decisions?|files?|folders?|git|push|commit|restart\w*|reboot\w*|joya|dashboard|screen|page|panel|dark mode|light mode|this call|mute|voice|planning|engine|pmo\w*|orders?|email|mail|inbox|telegram|whatsapp|notion|outlook|calendar|meeting|remind\w*|tasks?|ticket|database|postgres|nginx|docker|install\w*|upgrade\w*|delete|remove|fix|last time|yesterday|earlier|we did|did we|our|my (?:laptop|computer|pc|phone|files?))\b|(?:^|\s)(?:السيرفر|سيرفر|الماكينه|اودو|الجلسه|الجلسات|الوكيل|الهارد|الديسك|الخدمه|الخدمات|اللوج|الباك اب|باك اب|المهمه|المهام|موافقه|القرار|الملف|الملفات|ريستارت|اقفل|افتح|الشاشه|الصفحه|المكالمه|الصوت|التخطيط|اوردر|الاوردر|الايميل|الميل|تيليجرام|واتساب|ابعت|صلح|بتاعنا|امبارح|اخر حاجه|اشتغلنا|عملنا)(?:\s|$)/;

/**
 * The agents a request may name: live sessions (not JOYA AI itself, not internal) and hired sessions, each
 * with the words it may be called by -- its name, the name without a "[TAG]" prefix, and the
 * administrator's aliases for it (config voice_agent_aliases: { "<name>": ["alias", ...] }).
 */
function agentNames(sessions, hired, aliases) {
  const out = new Map();
  const add = (name) => {
    const n = String(name || "").trim();
    if (!n || names.isSelfName(n) || /^joya-internal-/i.test(n)) return;
    if (out.has(n)) return;
    const words = new Set([normal(n)]);
    const bare = normal(n.replace(/^\[[^\]]*\]\s*/, ""));
    if (bare.split(" ").length >= 1 && bare.length >= 3) words.add(bare);
    for (const a of (aliases && aliases[n]) || []) if (String(a || "").trim().length >= 3) words.add(normal(a));
    out.set(n, { name: n, words: [...words].filter(Boolean) });
  };
  for (const s of sessions || []) if (s && !s.self && s.name) add(s.name);
  for (const h of hired || []) if (h && h.name && (!h.status || h.status === "hired")) add(h.name);
  return [...out.values()];
}

// Addressing an agent: a verb aimed at it right before the name, or the name opening the request.
const ADDRESS_EN = /(?:^|\b)(?:ask|tell|have|get|let|check with|send (?:it |this |that )?to|forward (?:it |this |that )?to|message|ping|hand (?:it |this |that )?(?:over )?to|pass (?:it |this |that )?(?:on )?to|delegate (?:it |this |that )?to|give (?:it |this |that )?to|talk to|speak to|with)\s+(?:the\s+)?$/;
const ADDRESS_AR = /(?:^|\s)(?:اسال|اسأل|قول ل|قول|قولي ل|خلي|ابعت ل|ابعت|ابعتها ل|ابعته ل|كلم|اطلب من|شوف مع|شوف من|خلي ال|اسال ال|مع)\s*(?:ال)?$/;

/** The agent this request addresses (the longest matching name wins), or null. */
function findAgent(text, agents) {
  const t = normal(text);
  let best = null;
  for (const a of agents || []) {
    for (const w of a.words) {
      if (!w) continue;
      let at = -1;
      let from = 0;
      while ((at = t.indexOf(w, from)) !== -1) {
        from = at + 1;
        const before = t.slice(0, at);
        const afterCh = t.charAt(at + w.length);
        if (afterCh && /[\p{L}\p{N}]/u.test(afterCh)) continue; // part of a longer word
        if (at > 0 && /[\p{L}\p{N}]/u.test(t.charAt(at - 1))) continue;
        const opens = /^(?:(?:hey|hi|ok|okay|so|um|uh|يا|طيب|بص)\s+)*$/.test(before.trim() + (before.trim() ? " " : ""));
        const aimed = ADDRESS_EN.test(before) || ADDRESS_AR.test(before);
        if (!opens && !aimed) continue;
        if (!best || w.length > best.len) best = { agent: a, len: w.length };
      }
    }
  }
  return best ? best.agent : null;
}

/** Where this request goes (see the header). */
function classify(text, o) {
  o = o || {};
  const t = normal(text);
  if (!t) return { lane: "work", why: "empty" };
  const agent = findAgent(text, o.agents || []);
  if (agent) return { lane: "agent", agent: { name: agent.name }, why: "addressed " + agent.name };
  if (MACHINE.test(t)) return { lane: "work", why: "machine" };
  for (const [topic, re] of QUICK) if (re.test(t)) return { lane: "quick", why: topic };
  return { lane: "work", why: "default" };
}

/**
 * May a follow-up be folded into the running request (supervisor voice lanes, item D)? Only while that
 * request is young, has written nothing yet, holds no approval and has run nothing that changes anything:
 * then stopping it and asking once with both parts loses nothing and gives one answer.
 */
const READ_ONLY_TOOLS = new Set(["Read", "Grep", "Glob", "WebSearch", "WebFetch", "ListAgents", "ToolSearch", "TodoWrite", "mcp__memory__memory_search", "mcp__memory__memory_session", "mcp__joya-ai__status_snapshot", "mcp__joya-ai__weather", "mcp__joya-quick__weather", "mcp__joya-ai__ui_actions_list"]);
function foldable(running, o) {
  o = o || {};
  if (!running) return { ok: false, why: "nothing running" };
  if (running.folding) return { ok: false, why: "already folding" };
  if (running.source && running.source !== "voice-desk") return { ok: false, why: "not a voice request" };
  if (o.call && running.call !== o.call) return { ok: false, why: "another call" };
  const age = (o.now || 0) - (running.startedMs || 0);
  if (!(age >= 0 && age <= (o.maxMs || 45000))) return { ok: false, why: "too old" };
  if (running.wrote) return { ok: false, why: "already answering" };
  if (running.approvals) return { ok: false, why: "waiting on an approval" };
  for (const s of running.tools || []) {
    if (READ_ONLY_TOOLS.has(s.name)) continue;
    if (s.name === "Bash" && s.harmless) continue;
    return { ok: false, why: "ran " + s.name };
  }
  return { ok: true };
}

/** The request asked once with both parts (D). */
function foldedText(first, next) {
  return `${String(first || "").trim()}\n\n[Said next, before you had answered -- treat both as one request and answer once:] ${String(next || "").trim()}`;
}

module.exports = { classify, agentNames, findAgent, foldable, foldedText, normal, QUICK, MACHINE, READ_ONLY_TOOLS };
