"use strict";
/**
 * Proactive JOYA AI, the pure part: the watchers' grammar and their checks,
 * and the words of the morning brief and the "while you were away" catch-up.
 * No I/O here -- lib/routes-proactive.js reads the supervisor, keeps the rows
 * (lib/proactive-store.js) and runs the clock; the tests drive this directly
 * (tools/test-proactive.cjs).
 *
 * Watchers (per person, at most MAX_WATCHERS): a structured condition over
 * state the box already has, never an action. A watcher only ever produces a
 * line of text for the person who set it: the Live feed, a desktop toast, a
 * glance alert. There is no field for a command, a URL or a target, and
 * validate() refuses any field it does not know.
 *
 *   session_done     a session goes from working to idle         {session}
 *   session_ends     a session disappears from the list          {session}
 *   session_waiting  a session (or its approval) waits on you    {session, minutes}
 *                    for N minutes or more
 *   spend_over       today's spend passes a line                 {metric: usd|tokens, threshold, session}
 *   reply_contains   a session's message to JOYA AI contains     {session, text}
 *   fails            a delegation to a session fails or is held  {session}
 *   at_time          a time of day, on chosen days               {time: "HH:MM", days: [0..6], text}
 *
 * session is a name as the person said it, or "*" (any session). It is
 * matched by sessionMatches(): the same name, or every word of it in the
 * session's name ("planning" matches "[GSH] Planning Automation").
 *
 * Brief and catch-up: gather() turns what the supervisor reports (sessions,
 * approvals, the ledger's delegations / inbound / turns, the token caps) and
 * what the engine saw happen (session state changes) into facts for a time
 * window; compose() writes them as a few plain lines (the template, always
 * there); grounded() checks a model's rewording against them -- every number
 * in it must be one the facts hold, or the template is used.
 */

const MAX_WATCHERS = 50;
const KINDS = ["session_done", "session_ends", "session_waiting", "spend_over", "reply_contains", "fails", "at_time"];
const KIND_LABEL = {
  session_done: "Session finishes",
  session_ends: "Session ends",
  session_waiting: "Waiting on you",
  spend_over: "Spend passes",
  reply_contains: "Reply contains",
  fails: "Something fails",
  at_time: "At a time",
};
const PARAM_KEYS = {
  session_done: ["session"],
  session_ends: ["session"],
  session_waiting: ["session", "minutes"],
  spend_over: ["metric", "threshold", "session"],
  reply_contains: ["session", "text"],
  fails: ["session"],
  at_time: ["time", "days", "text"],
};
const TOP_KEYS = ["kind", "params", "repeat", "cooldown_min", "label"];
const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const DAY_WORDS = { sunday: 0, sun: 0, monday: 1, mon: 1, tuesday: 2, tue: 2, tues: 2, wednesday: 3, wed: 3, thursday: 4, thu: 4, thurs: 4, friday: 5, fri: 5, saturday: 6, sat: 6 };
const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6];
const DEFAULT_WAIT_MIN = 10;
const DEFAULT_COOLDOWN_MIN = 10;

/* ------------------------------------------------------------- helpers -- */

function str(s) {
  return s == null ? "" : String(s);
}
function clip(s, n) {
  s = str(s).replace(/\s+/g, " ").trim();
  return s.length > n ? s.slice(0, n - 1).trimEnd() + "…" : s;
}
// eslint-disable-next-line no-control-regex
const CTRL = /[\u0000-\u001f\u007f]/;
function plainText(v, min, max) {
  if (typeof v !== "string") return null;
  const s = v.replace(/\s+/g, " ").trim();
  if (s.length < min || s.length > max || CTRL.test(s)) return null;
  return s;
}

/** A name in one spelling: lower case, a "[TAG]" prefix and punctuation gone. */
function normName(s) {
  return str(s)
    .toLowerCase()
    .replace(/\[[^\]]*\]/g, " ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}
const NAME_STOP = new Set(["the", "a", "an", "my", "session", "sessions", "one", "agent", "bot"]);
function nameWords(s) {
  return normName(s)
    .split(" ")
    .filter((w) => w && !NAME_STOP.has(w));
}
/** Does a watcher's session (as said, or "*") match a session's name? */
function sessionMatches(pattern, name) {
  if (pattern === "*") return true;
  const p = normName(pattern), n = normName(name);
  if (!p || !n) return false;
  if (p === n) return true;
  const pw = nameWords(pattern), nw = new Set(nameWords(name));
  return pw.length > 0 && pw.every((w) => nw.has(w));
}
/**
 * The live session a spoken name means: the same name; or the one whose words
 * hold most of the spoken words (half or more, and no tie). Returns
 * { name, live, ambiguous: [names] }.
 */
function resolveSession(said, names) {
  if (said === "*") return { name: "*", live: true, ambiguous: [] };
  const list = (names || []).filter(Boolean);
  const exact = list.find((n) => normName(n) === normName(said));
  if (exact) return { name: exact, live: true, ambiguous: [] };
  const sw = nameWords(said);
  if (!sw.length) return { name: said, live: false, ambiguous: [] };
  let best = 0, hits = [];
  for (const n of list) {
    const nw = new Set(nameWords(n));
    const score = sw.filter((w) => nw.has(w) || [...nw].some((x) => x.length >= 4 && w.length >= 4 && (x.startsWith(w) || w.startsWith(x)))).length / sw.length;
    if (score > best) {
      best = score;
      hits = [n];
    } else if (score === best && score > 0) hits.push(n);
  }
  if (best >= 0.5 && hits.length === 1) return { name: hits[0], live: true, ambiguous: [] };
  return { name: said, live: false, ambiguous: best >= 0.5 ? hits : [] };
}

function money(n) {
  n = Number(n) || 0;
  return "$" + (n >= 100 ? Math.round(n).toLocaleString("en-US") : n.toFixed(2));
}
/** "1.2M", "840k", "312" -- the same short form as the glance cards. */
function tok(n) {
  n = Number(n) || 0;
  if (n >= 1e9) return (n / 1e9).toFixed(n >= 1e10 ? 0 : 1) + "B";
  if (n >= 1e6) return (n / 1e6).toFixed(n >= 1e7 ? 0 : 1) + "M";
  if (n >= 1e3) return Math.round(n / 1e3) + "k";
  return String(Math.round(n));
}
/** "45 min", "2 h 10 min", "3 days". */
function span(ms) {
  const m = Math.max(0, Math.round((Number(ms) || 0) / 60000));
  if (m < 60) return m + " min";
  if (m < 48 * 60) {
    const h = Math.floor(m / 60), r = m % 60;
    return h + " h" + (r ? " " + r + " min" : "");
  }
  return Math.round(m / 1440) + " days";
}
function plural(n, one, many) {
  return n + " " + (n === 1 ? one : many || one + "s");
}

/* ------------------------------------------------------- time of day -- */

/** The local date, time and weekday in a time zone: { date: "2026-10-20", hm: "08:05", dow: 2, min: 485 }. */
function localNow(ms, tz) {
  const f = new Intl.DateTimeFormat("en-GB", { timeZone: tz || "UTC", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", weekday: "short", hourCycle: "h23" });
  const p = {};
  for (const x of f.formatToParts(new Date(ms))) p[x.type] = x.value;
  const hm = (p.hour === "24" ? "00" : p.hour) + ":" + p.minute;
  return { date: `${p.year}-${p.month}-${p.day}`, hm, dow: DAY_NAMES.indexOf(p.weekday), min: Number(hm.slice(0, 2)) * 60 + Number(hm.slice(3)) };
}
function validTz(tz) {
  if (typeof tz !== "string" || !tz || tz.length > 64 || !/^[A-Za-z_+\-/0-9]+$/.test(tz)) return false;
  try {
    new Intl.DateTimeFormat("en-GB", { timeZone: tz }).format(0);
    return true;
  } catch (_) {
    return false;
  }
}
function validHm(s) {
  return typeof s === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(s);
}
/** "HH:MM" on a 12-hour clock for people: "08:00" -> "8:00". */
function hmLabel(hm) {
  return validHm(hm) ? String(Number(hm.slice(0, 2))) + ":" + hm.slice(3) : str(hm);
}
function daysLabel(days) {
  const d = (days || ALL_DAYS).slice().sort();
  if (d.length === 7) return "every day";
  if (d.join() === "1,2,3,4,5") return "weekdays";
  if (d.join() === "0,6") return "weekends";
  return d.map((x) => DAY_NAMES[x]).join(", ");
}

/* --------------------------------------------------------- validation -- */

/**
 * A watcher as stored: { kind, params, repeat, cooldown_min, label }.
 * Returns { ok: true, value } or { ok: false, error } -- the error is a
 * sentence for the person.
 */
function validate(input) {
  const bad = (error) => ({ ok: false, error });
  if (!input || typeof input !== "object" || Array.isArray(input)) return bad("A watcher is a condition with its settings.");
  for (const k of Object.keys(input)) if (!TOP_KEYS.includes(k)) return bad(`A watcher has no field "${clip(k, 30)}": it can only notify you.`);
  const kind = input.kind;
  if (!KINDS.includes(kind)) return bad("That is not something a watcher can watch.");
  const p = input.params && typeof input.params === "object" && !Array.isArray(input.params) ? input.params : {};
  for (const k of Object.keys(p)) if (!PARAM_KEYS[kind].includes(k)) return bad(`"${clip(k, 30)}" is not a setting of this watcher.`);
  const out = {};
  if (PARAM_KEYS[kind].includes("session")) {
    const s = p.session === undefined ? "*" : p.session;
    if (s === "*") out.session = "*";
    else {
      const t = plainText(s, 1, 80);
      if (!t) return bad("The session's name: 1 to 80 characters.");
      out.session = t;
    }
  }
  if (kind === "session_waiting") {
    const m = p.minutes === undefined ? DEFAULT_WAIT_MIN : p.minutes;
    if (!Number.isInteger(m) || m < 1 || m > 1440) return bad("Waiting time: 1 to 1440 minutes.");
    out.minutes = m;
  }
  if (kind === "spend_over") {
    if (p.metric !== "usd" && p.metric !== "tokens") return bad("Spend is counted in dollars (usd) or tokens.");
    out.metric = p.metric;
    const t = p.threshold;
    if (typeof t !== "number" || !isFinite(t)) return bad("The line to pass is a number.");
    if (p.metric === "usd") {
      if (t < 0.01 || t > 100000) return bad("A dollar line from $0.01 to $100,000.");
      out.threshold = Math.round(t * 100) / 100;
    } else {
      if (t < 1000 || t > 1e12) return bad("A token line from 1k to 1,000B tokens.");
      out.threshold = Math.round(t);
    }
  }
  if (kind === "reply_contains") {
    const t = plainText(p.text, 2, 80);
    if (!t) return bad("The words to look for: 2 to 80 characters.");
    out.text = t;
  }
  if (kind === "at_time") {
    if (!validHm(p.time)) return bad('The time is "HH:MM", 00:00 to 23:59.');
    out.time = p.time;
    const d = p.days === undefined ? ALL_DAYS : p.days;
    if (!Array.isArray(d) || !d.length || d.length > 7 || !d.every((x) => Number.isInteger(x) && x >= 0 && x <= 6) || new Set(d).size !== d.length) return bad("Days: one or more of Sunday (0) to Saturday (6).");
    out.days = d.slice().sort();
    const t = p.text === undefined || p.text === "" ? "" : plainText(p.text, 1, 120);
    if (t === null) return bad("The reminder: at most 120 characters.");
    out.text = t;
  }
  const repeat = input.repeat === undefined ? "once" : input.repeat;
  if (repeat !== "once" && repeat !== "every") return bad("A watcher fires once or every time.");
  const cd = input.cooldown_min === undefined ? DEFAULT_COOLDOWN_MIN : input.cooldown_min;
  if (!Number.isInteger(cd) || cd < 1 || cd > 1440) return bad("Quiet time between alerts: 1 to 1440 minutes.");
  let label = "";
  if (input.label !== undefined && input.label !== "") {
    label = plainText(input.label, 1, 200);
    if (label === null) return bad("Your words: at most 200 characters.");
  }
  return { ok: true, value: { kind, params: out, repeat, cooldown_min: cd, label } };
}

/** One line saying what a watcher waits for. */
function describe(w) {
  const p = w.params || {};
  const who = p.session === "*" || p.session === undefined ? "any session" : p.session;
  const Who = who.charAt(0).toUpperCase() + who.slice(1);
  let s;
  switch (w.kind) {
    case "session_done":
      s = `When ${who} finishes`;
      break;
    case "session_ends":
      s = `When ${who} ends`;
      break;
    case "session_waiting":
      s = `When ${who} waits on you ${span(p.minutes * 60000)} or more`;
      break;
    case "spend_over":
      s = (p.session && p.session !== "*" ? `When ${Who}'s spend` : "When today's spend") + ` passes ${p.metric === "usd" ? money(p.threshold) : tok(p.threshold) + " tokens"}`;
      break;
    case "reply_contains":
      s = `When ${who} writes “${p.text}”`;
      break;
    case "fails":
      s = `When work sent to ${who} fails`;
      break;
    case "at_time":
      s = `At ${hmLabel(p.time)}, ${daysLabel(p.days)}` + (p.text ? `: ${p.text}` : "");
      break;
    default:
      s = "A watcher";
  }
  return s + (w.repeat === "every" ? (w.kind === "at_time" ? "" : " · every time") : w.kind === "at_time" ? " · once" : " · once");
}

/* ------------------------------------------------------------ parsing -- */

const ANY_RE = /^(?:a|any|some|every|each|all|one of(?: the| my)?)?\s*(?:sessions?|of them|one|thing|anything|something|anyone|someone|any|session of mine)$/;
const LEAD_RE = /^(?:(?:please|hey|ok|okay)[, ]+)?(?:joya ai[, ]+)?(?:can you |could you |would you )?(?:let me know|(?:tell|let|ping|notify|alert|warn|show|message|remind)\s+me|watch(?: out)?(?: for)?|keep an eye on|i want to know|i'd like to know)\b\s*/;
const TRIGGER_RE = /^(?:(?:please|hey|ok|okay)[, ]+)?(?:joya ai[, ]+)?(?:can you |could you |would you )?(?:(?:tell|let|ping|notify|alert|warn|message|remind)\s+me\b|let me know\b|watch\b|keep an eye\b|i want to know\b|i'd like to know\b)/i;

/** Does this read like a request for a watcher? (The composer asks before sending it to JOYA AI.) */
function looksLikeWatcher(text) {
  return TRIGGER_RE.test(str(text).trim());
}

function cleanSession(s) {
  const pre = str(s).replace(/^(?:when|if|once|as soon as|whenever|every time|each time|the moment)\s+/i, "").trim().toLowerCase();
  if (!pre || ANY_RE.test(pre) || /^(?:a|any|some)$/.test(pre)) return "*";
  let t = str(s)
    .replace(/^(?:when|if|once|as soon as|whenever|every time|each time|the moment)\s+/i, "")
    .replace(/^(?:the|my|our)\s+/i, "")
    .replace(/['’]s$/i, "")
    .replace(/\s+(?:is|are|has|have|gets|get)$/i, "")
    .replace(/\s+session$/i, "")
    .replace(/^session\s+/i, "")
    .replace(/^["“'](.*)["”']$/, "$1")
    .trim();
  if (!t || ANY_RE.test(t.toLowerCase()) || /^(?:a|any|some)$/i.test(t)) return "*";
  return t;
}

function numberWithUnit(n, unit) {
  const v = Number(String(n).replace(/,/g, ""));
  const u = str(unit).toLowerCase();
  if (/^(k|thousand)$/.test(u)) return v * 1e3;
  if (/^(m|mn|million)$/.test(u)) return v * 1e6;
  if (/^(b|bn|billion)$/.test(u)) return v * 1e9;
  return v;
}

/**
 * Plain words to a watcher: "tell me when the Planning engine session
 * finishes", "alert me if spend passes $50 today", "watch for a session
 * waiting on me more than 10 minutes", "remind me at 17:30 to call Ahmed".
 * names: the live sessions' names (a spoken name is matched to one).
 * Returns { ok, value, note } or { ok: false, error }.
 */
function parse(text, names) {
  const raw = str(text).replace(/\s+/g, " ").trim();
  if (!raw) return { ok: false, error: "Say what to watch for." };
  if (raw.length > 300) return { ok: false, error: "Keep it to one short sentence." };
  const t = raw.replace(/[.!?]+$/, "");
  const low = t.toLowerCase();
  const every = /\b(every time|each time|whenever|always|every day|each day|daily|weekdays|every weekday|weekends|repeatedly|keep telling me|each morning|every morning)\b/.test(low);
  const body = low.replace(LEAD_RE, "");
  const bodyRaw = t.slice(t.length - body.length); // the same span, with its capitals
  let spec = null, note = "";

  // A time of day: "remind me at 17:30 to ...", "at 9am every weekday tell me ...".
  const tm = /\b(?:at|@)\s*(\d{1,2})(?:[:.](\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)?(?=\s|$|,)/i.exec(t);
  if (tm && (/\bremind\b/.test(low) || /^(?:(?:every|each)\s+(?:day|morning|weekday)\s+|daily\s+|on weekdays\s+)?at\b/.test(body) || !/\b(finish|done|complete|idle|end|clos|exit|wait|spend|cost|token|fail|error|says|writes|mentions|repl)/.test(low))) {
    let h = Number(tm[1]);
    const m = tm[2] ? Number(tm[2]) : 0;
    const ap = str(tm[3]).toLowerCase().replace(/\./g, "");
    if (ap === "pm" && h < 12) h += 12;
    if (ap === "am" && h === 12) h = 0;
    if (h > 23 || m > 59) return { ok: false, error: "That time is not on the clock." };
    let days = ALL_DAYS;
    if (/\bweekdays?\b|\bevery weekday\b/.test(low)) days = [1, 2, 3, 4, 5];
    else if (/\bweekends?\b/.test(low)) days = [0, 6];
    else {
      const named = Object.keys(DAY_WORDS).filter((d) => new RegExp("\\b" + d + "s?\\b").test(low)).map((d) => DAY_WORDS[d]);
      if (named.length) days = [...new Set(named)].sort();
    }
    let what = t
      .slice(0, tm.index)
      .concat(" ", t.slice(tm.index + tm[0].length))
      .replace(/\b(?:every|each)\s+(?:day|morning|evening|weekday)\b|\bdaily\b|\bon weekdays\b|\bweekdays\b|\bon weekends\b|\bweekends\b|\btoday\b|\btomorrow\b/gi, "")
      .replace(new RegExp("\\bon\\s+(?:" + Object.keys(DAY_WORDS).join("|") + ")s?\\b", "gi"), "")
      .replace(/\s+/g, " ")
      .trim()
      .replace(/^(?:(?:please|hey|ok|okay)[, ]+)?(?:remind me|tell me|ping me|notify me|alert me|let me know)\b/i, "")
      .replace(/^\s*(?:to|that|about|:|,)\s*/i, "")
      .replace(/\s+/g, " ")
      .trim();
    what = what.replace(/^(?:to|that|about)\s+/i, "");
    spec = { kind: "at_time", params: { time: String(h).padStart(2, "0") + ":" + String(m).padStart(2, "0"), days, text: clip(what, 120) }, repeat: every || days.length < 7 ? "every" : "once" };
    if (days.length < 7 && !every) note = "It repeats on " + daysLabel(days) + ".";
  }

  // Spend: "if spend passes $50 today", "if Planning spends more than $20", "if tokens pass 50M".
  if (!spec && /\b(spend|spends|spending|spent|cost|costs|bill|usage|tokens?|budget|\$)/.test(low)) {
    const usd = /\$\s?(\d[\d,]*(?:\.\d+)?)\s*(k|thousand)?|(\d[\d,]*(?:\.\d+)?)\s*(k|thousand)?\s*(?:dollars?|usd|bucks)\b/i.exec(t);
    const tokm = /(\d[\d,]*(?:\.\d+)?)\s*(k|m|mn|b|bn|thousand|million|billion)?\s*tokens?\b/i.exec(t) || (/\btokens?\b/i.test(t) ? /(\d[\d,]*(?:\.\d+)?)\s*(k|m|mn|b|bn|thousand|million|billion)\b/i.exec(t) : null);
    let metric = null, threshold = null;
    if (usd) {
      metric = "usd";
      threshold = numberWithUnit(usd[1] || usd[3], usd[2] || usd[4]);
    } else if (tokm) {
      metric = "tokens";
      threshold = numberWithUnit(tokm[1], tokm[2]);
    }
    if (metric) {
      let session = "*";
      const who = /^(?:if|when|once|as soon as|whenever)?\s*(.+?)\s+(?:spends|spent|costs|uses|burns|goes over|passes|is over)\b/i.exec(bodyRaw);
      const whoName = who ? who[1].trim().replace(/^(?:the\s+)?(?:spend|spending|cost|costs|usage|tokens?|bill)\s+(?:of|for|by|on)\s+/i, "") : "";
      if (whoName && !/^(?:the |my |our |today'?s? |total |daily )*(?:spend|spending|cost|costs|bill|usage|tokens?|budget)(?: today)?$/i.test(whoName) && !/^(?:it|we|i)$/i.test(whoName)) session = cleanSession(whoName);
      const of = /\b(?:spend|cost|usage|tokens?)\s+(?:of|for|by|on)\s+(?:the\s+)?(.+?)\s+(?:passes|goes|is|exceeds|hits|reaches|tops|crosses)\b/i.exec(bodyRaw);
      if (session === "*" && of) session = cleanSession(of[1]);
      spec = { kind: "spend_over", params: { metric, threshold, session }, repeat: every ? "every" : "once" };
      if (every) note = "At most once a day.";
    } else return { ok: false, error: "Say the line to pass, like $50 or 20M tokens." };
  }

  // Waiting on you: "a session waiting on me more than 10 minutes", "when Customs waits for me 5 min".
  if (!spec && /\bwait(?:s|ing|ed)?\b|\bstuck waiting\b|\bneeds? me\b|\bneeds? my\b/.test(low)) {
    const nm = /(?:more than|over|longer than|for|at least|past|>)?\s*(\d+)\s*(min(?:ute)?s?|m|h|hrs?|hours?)\b/i.exec(t);
    let minutes = DEFAULT_WAIT_MIN;
    if (nm) minutes = /^h/i.test(nm[2]) ? Number(nm[1]) * 60 : Number(nm[1]);
    else note = "Waiting " + DEFAULT_WAIT_MIN + " minutes or more (say another time to change it).";
    if (minutes < 1 || minutes > 1440) return { ok: false, error: "Waiting time: 1 minute to 24 hours." };
    const who = /^(?:for\s+|if\s+|when\s+|whenever\s+)?(.+?)\s+(?:is |are |has been |keeps |sits |that'?s |that is |gets stuck |stuck )?(?:waiting|waits|waited|needs)\b/i.exec(bodyRaw);
    spec = { kind: "session_waiting", params: { session: who ? cleanSession(who[1]) : "*", minutes }, repeat: every ? "every" : "once" };
  }

  // A reply that says something: 'when Planning says "done"', "if any session mentions invoice".
  if (!spec) {
    const rc = /^(?:if|when|once|as soon as|whenever)?\s*(.*?)\s*\b(?:says|said|replies|replied|writes|wrote|mentions|mentioned|reports|reported|answers|answered|messages|sends)\b(?:\s+(?:me|you|back|joya ai))?\s*(?:with|about|that|containing|anything about|something about)?\s*(.*)$/i.exec(bodyRaw);
    if (rc) {
      const q = /["“'‘]([^"”'’]{2,80})["”'’]/.exec(rc[2]);
      const words = (q ? q[1] : rc[2].replace(/^(?:the word|the words|a|an)\s+/i, "")).trim();
      if (words.length < 2) return { ok: false, error: 'Say the words to look for, in quotes: when Planning says "done".' };
      spec = { kind: "reply_contains", params: { session: cleanSession(rc[1]), text: clip(words, 80) }, repeat: every ? "every" : "once" };
    }
  }

  // Failures, endings, finishing.
  const verbAt = (re) => {
    const m = re.exec(bodyRaw);
    return m ? { who: cleanSession(bodyRaw.slice(0, m.index)), m } : null;
  };
  if (!spec) {
    const f = verbAt(/\s*\b(?:fails|failed|fail|errors?|errored|breaks|broke|crashes|crashed|goes wrong|went wrong|gets held|is held)\b/i);
    if (f) spec = { kind: "fails", params: { session: f.who }, repeat: every ? "every" : "once" };
  }
  if (!spec) {
    const e = verbAt(/\s*\b(?:ends|ended|closes|closed|exits|exited|quits|is closed|shuts down|is retired|retires|goes away|disappears|stops running)\b/i);
    if (e) spec = { kind: "session_ends", params: { session: e.who }, repeat: every ? "every" : "once" };
  }
  if (!spec) {
    const d = verbAt(/\s*\b(?:finishes|finished|finish|is done|are done|gets done|is finished|completes|completed|wraps up|goes idle|is idle|stops working|is ready|done)\b/i);
    if (d) spec = { kind: "session_done", params: { session: d.who }, repeat: every ? "every" : "once" };
  }
  if (!spec) return { ok: false, error: "I can watch for a session finishing, ending, failing, waiting on you, writing something, spend passing a line, or a time of day." };

  // The session: the live one it means, when there is one.
  if (spec.params.session && spec.params.session !== "*") {
    const r = resolveSession(spec.params.session, names);
    if (r.live) {
      if (normName(r.name) !== normName(spec.params.session)) note = (note ? note + " " : "") + `“${spec.params.session}” is ${r.name}.`;
      spec.params.session = r.name;
    } else if (r.ambiguous.length) {
      return { ok: false, error: `“${spec.params.session}” could be ${r.ambiguous.slice(0, 3).join(" or ")}: say which.` };
    } else note = (note ? note + " " : "") + `No session called “${spec.params.session}” is running now; it counts once one is.`;
  }
  spec.label = clip(raw, 200);
  const v = validate(spec);
  if (!v.ok) return v;
  return { ok: true, value: v.value, note, text: describe(v.value) };
}

/* ---------------------------------------------------------- the checks -- */

function sessKey(s) {
  return String(s.session_id || s.pid || s.name);
}
function others(sessions) {
  return (sessions || []).filter((s) => s && !s.self && !/^(joya ai|joya ai|joya bot)$/i.test(normName(s.name)));
}

/**
 * The changes between two looks at the sessions (each as the supervisor's
 * `sessions` op lists them): [{ kind: started|finished|working|waiting|ended,
 * key, name, at, ms }]. `ms` on finished: how long it had been working.
 */
function transitions(prev, cur, now) {
  const out = [];
  if (!prev) return out;
  const before = new Map(others(prev).map((s) => [sessKey(s), s]));
  const after = new Map(others(cur).map((s) => [sessKey(s), s]));
  for (const [k, s] of after) {
    const p = before.get(k);
    if (!p) {
      out.push({ kind: "started", key: k, name: s.name, at: now });
      continue;
    }
    if (p.status === s.status) continue;
    if (p.status === "busy" && s.status !== "busy") {
      const since = Date.parse(p.status_since);
      out.push({ kind: "finished", key: k, name: s.name, at: now, ms: isFinite(since) ? now - since : null, to: s.status });
    }
    if (s.status === "busy") out.push({ kind: "working", key: k, name: s.name, at: now });
    if (s.status === "waiting") out.push({ kind: "waiting", key: k, name: s.name, at: now, for: s.waiting_for || "" });
  }
  for (const [k, p] of before) if (!after.has(k)) out.push({ kind: "ended", key: k, name: p.name, at: now });
  return out;
}

/**
 * One watcher against one look at the box. `w` = { kind, params, repeat,
 * cooldown_min, state, created_at }; `c` = { now, tz-local {date, hm, min, dow},
 * transitions, sessions, approvals (pending), inbound (new rows), failures
 * (new failed / held delegations), spend {usd, tokens, by: name -> {usd, tokens}} }.
 * Returns { fires: [{ text, session }], state, done } -- done: a once-watcher that fired.
 */
function evaluate(w, c) {
  const p = w.params || {};
  const st = Object.assign({ eps: {}, day: null, last: {} }, w.state || {});
  const fires = [];
  const now = c.now;
  const cool = (k) => w.repeat === "every" && st.last[k] && now - st.last[k] < (w.cooldown_min || DEFAULT_COOLDOWN_MIN) * 60000;
  const fire = (text, k, session) => {
    if (cool(k)) return;
    st.last[k] = now;
    fires.push({ text, session: session || null });
  };
  switch (w.kind) {
    case "session_done":
      for (const t of c.transitions || []) if (t.kind === "finished" && sessionMatches(p.session, t.name)) fire(`${t.name} finished` + (t.ms > 60000 ? ` after ${span(t.ms)} of work` : "") + (t.to === "waiting" ? " and is waiting on you" : "") + ".", t.key, t.key);
      break;
    case "session_ends":
      for (const t of c.transitions || []) if (t.kind === "ended" && sessionMatches(p.session, t.name)) fire(`${t.name} ended.`, t.key, t.key);
      break;
    case "session_waiting": {
      const lim = (p.minutes || DEFAULT_WAIT_MIN) * 60000;
      const live = {};
      for (const s of others(c.sessions)) {
        if (s.status !== "waiting" || !sessionMatches(p.session, s.name)) continue;
        const since = Date.parse(s.status_since);
        const ep = "s:" + sessKey(s) + "@" + (s.status_since || "");
        live[ep] = 1;
        if (isFinite(since) && now - since >= lim && !st.eps[ep]) {
          st.eps[ep] = now;
          fire(`${s.name} has been waiting on you ${span(now - since)}` + (s.waiting_for ? ` (for ${clip(s.waiting_for, 60)})` : "") + ".", "s:" + sessKey(s), sessKey(s));
        }
      }
      for (const a of c.approvals || []) {
        if (a.status !== "pending") continue;
        const who = /^session:/.test(str(a.origin)) ? str(a.origin_name || a.origin.slice(8)) : "JOYA AI";
        if (p.session !== "*" && !sessionMatches(p.session, who)) continue;
        const since = Date.parse(a.created_at);
        const ep = "a:" + a.id;
        live[ep] = 1;
        if (isFinite(since) && now - since >= lim && !st.eps[ep]) {
          st.eps[ep] = now;
          fire(`${who} has waited ${span(now - since)} for your approval: ${clip(a.summary || a.tool || "a step", 80)}.`, ep, null);
        }
      }
      // Forget episodes that ended, so the next wait counts again.
      for (const k of Object.keys(st.eps)) if (!live[k]) delete st.eps[k];
      break;
    }
    case "spend_over": {
      const day = c.local && c.local.date;
      if (st.day === day) break; // once a day at most
      const sp = c.spend || {};
      let val = null, who = "Today's spend";
      if (p.session === "*" || !p.session) val = p.metric === "usd" ? sp.usd : sp.tokens;
      else {
        const hit = Object.keys(sp.by || {}).find((n) => sessionMatches(p.session, n));
        if (hit) {
          val = p.metric === "usd" ? sp.by[hit].usd : sp.by[hit].tokens;
          who = hit + "'s spend";
        }
      }
      if (val != null && isFinite(val) && val >= p.threshold) {
        st.day = day;
        fires.push({ text: `${who} passed ${p.metric === "usd" ? money(p.threshold) : tok(p.threshold) + " tokens"}: ${p.metric === "usd" ? "≈ " + money(val) : tok(val) + " tokens"} so far.`, session: null });
      }
      break;
    }
    case "reply_contains": {
      const needle = str(p.text).toLowerCase();
      for (const r of c.inbound || []) {
        if (!sessionMatches(p.session, r.from_name)) continue;
        if (!str(r.text).toLowerCase().includes(needle)) continue;
        fire(`${r.from_name || "A session"} wrote “${p.text}”: ${clip(r.text, 120)}`, "r:" + (r.from_name || ""), null);
      }
      break;
    }
    case "fails":
      for (const d of c.failures || []) if (sessionMatches(p.session, d.target_name || d.target)) fire(`Work sent to ${d.target_name || d.target} ${d.status === "held" ? "is held" : "failed"}: ${clip(d.summary || d.text || "a delegation", 90)}${d.note ? " — " + clip(d.note, 80) : ""}.`, "d:" + (d.target_name || d.target), null);
      break;
    case "at_time": {
      const l = c.local;
      if (!l || st.day === l.date || !(p.days || ALL_DAYS).includes(l.dow)) break;
      const due = Number(p.time.slice(0, 2)) * 60 + Number(p.time.slice(3));
      // Due now, or missed by up to an hour (the box restarting at that minute); never a day's backlog.
      if (l.min >= due && l.min - due <= 60) {
        st.day = l.date;
        fires.push({ text: p.text ? `Reminder: ${p.text}` : `It is ${hmLabel(p.time)}.`, session: null });
      }
      break;
    }
    default:
      break;
  }
  const done = w.repeat !== "every" && fires.length > 0;
  return { fires: done ? fires.slice(0, 1) : fires, state: st, done };
}

/* -------------------------------------------------- brief and catch-up -- */

function within(iso, from, to) {
  const t = Date.parse(iso);
  return isFinite(t) && t > from && t <= to;
}

/**
 * The facts for a window. `d` = {
 *   from, to (ms), kind: "brief" | "catchup",
 *   sessions (supervisor `sessions`), status (supervisor `status`), caps (token-caps or null),
 *   events (engine rows {ts, kind, session, session_key, detail}),
 *   inbound, delegations, turns (ledger rows), fires (watcher alerts in the window: [{text, at}]),
 *   usdAtFrom (today's spend when the window began, same day only) }.
 */
function gather(d) {
  const from = d.from, to = d.to;
  const live = others(d.sessions);
  const st = d.status || {};
  const per = new Map();
  const sess = (name, key) => {
    const k = normName(name) || key;
    if (!per.has(k)) per.set(k, { name, key, did: [], finished: 0, failed: 0, workedMs: 0, delegated: 0, state: null });
    return per.get(k);
  };
  for (const s of live) Object.assign(sess(s.name, sessKey(s)), { state: s.status, key: sessKey(s), tokens: (s.tokens_today && s.tokens_today.total) || 0 });
  // What the engine saw: working stretches and finishes.
  const evs = (d.events || []).filter((e) => within(e.ts, from, to)).sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
  const started = [], ended = [];
  for (const e of evs) {
    const s = sess(e.session, e.session_key);
    if (e.kind === "finished") {
      s.finished++;
      const det = safeJson(e.detail);
      if (det && det.ms > 0) s.workedMs += Math.min(det.ms, Date.parse(e.ts) - from);
    }
    if (e.kind === "started") started.push(e.session);
    if (e.kind === "ended") ended.push(e.session);
  }
  // Still working at the end of the window: the stretch so far.
  for (const s of live) {
    if (s.status !== "busy") continue;
    const since = Date.parse(s.status_since);
    if (isFinite(since)) sess(s.name, sessKey(s)).workedMs += Math.max(0, to - Math.max(since, from));
  }
  // What the sessions said (their messages and idle notices to JOYA AI).
  const inbound = (d.inbound || []).filter((r) => within(r.received_at, from, to)).sort((a, b) => Date.parse(b.received_at) - Date.parse(a.received_at));
  const finished = [];
  for (const r of inbound) {
    if (!r.from_name) continue;
    const s = sess(r.from_name, null);
    const text = clip(str(r.text).replace(/\[Cross-session [a-z ]+\]/i, ""), 110);
    if (text && s.did.length < 1) s.did.push(text);
    if (r.kind === "idle" && finished.length < 4 && !finished.some((f) => f.name === r.from_name)) finished.push({ name: r.from_name, text });
  }
  // Delegations: sent, done, failed in the window.
  const failed = [];
  for (const x of d.delegations || []) {
    if (within(x.created_at, from, to)) sess(x.target_name || x.target, x.target_session).delegated++;
    if ((x.status === "failed" || x.status === "held") && (within(x.failed_at, from, to) || within(x.updated_at, from, to))) {
      sess(x.target_name || x.target, x.target_session).failed++;
      failed.push({ name: x.target_name || x.target, text: clip(x.summary || x.text, 80) + (x.note ? " — " + clip(x.note, 60) : ""), held: x.status === "held" });
    }
    if (x.status === "done" && within(x.done_at, from, to) && !finished.some((f) => f.name === (x.target_name || x.target)) && finished.length < 4) finished.push({ name: x.target_name || x.target, text: clip(x.reply_text || x.summary, 110) });
  }
  // JOYA AI's own turns that failed.
  for (const t of d.turns || []) if (t.status === "failed" && within(t.ended_at || t.created_at, from, to)) failed.push({ name: "JOYA AI", text: clip(t.error || t.text, 80) });
  // Waiting on you, now.
  const approvals = (st.approvals || []).filter((a) => a.status === "pending").map((a) => ({ who: /^session:/.test(str(a.origin)) ? str(a.origin_name || a.origin.slice(8)) : "JOYA AI", what: clip(a.summary || a.tool, 70), ageMin: Math.max(0, Math.round((to - Date.parse(a.created_at)) / 60000)) || 0 }));
  const waitingSess = live.filter((s) => s.status === "waiting").map((s) => ({ name: s.name, for: clip(s.waiting_for || "", 50), min: Math.max(0, Math.round((to - Date.parse(s.status_since)) / 60000)) || 0 }));
  const decisions = (st.counts && st.counts.decisions_open) || 0;
  // Spend today, against the caps.
  const cost = st.cost_today || {};
  const usd = Number(cost.total_usd) || 0;
  let tokens = 0;
  const caps = [];
  for (const r of (d.caps && d.caps.sessions) || []) {
    const used = (r.today && Number(r.today.total)) || 0;
    tokens += used;
    if (r.cap > 0) caps.push({ name: r.kind === "self" ? "JOYA AI" : r.name || r.key, used, cap: r.cap, pct: Math.round((used / r.cap) * 100), paused: !!r.paused });
  }
  if (!d.caps) for (const s of d.sessions || []) tokens += (s.tokens_today && s.tokens_today.total) || 0;
  caps.sort((a, b) => b.pct - a.pct);
  // Stale: stuck working, waiting long, idle with work still open, hired and idle a day.
  const stale = [];
  for (const s of live) {
    const since = Date.parse(s.status_since), age = isFinite(since) ? to - since : 0;
    if (s.status === "busy" && age >= 3 * 3600e3) stale.push({ name: s.name, why: `working ${span(age)} without a pause` });
    else if (s.status === "waiting" && age >= 30 * 60e3) stale.push({ name: s.name, why: `waiting on you ${span(age)}` });
    else if (s.status === "idle" && (s.open_delegations || 0) > 0 && age >= 30 * 60e3) stale.push({ name: s.name, why: `idle ${span(age)} with ${plural(s.open_delegations, "open task")}` });
    else if (s.status === "idle" && s.hire && age >= 24 * 3600e3) stale.push({ name: s.name, why: `hired and idle ${span(age)}` });
  }
  const sessions = [...per.values()].filter((s) => s.did.length || s.finished || s.failed || s.delegated || s.workedMs >= 60000).sort((a, b) => b.workedMs - a.workedMs || b.finished - a.finished);
  const fires = (d.fires || []).filter((f) => within(f.at, from, to));
  const happened = sessions.length + finished.length + failed.length + started.length + ended.length + fires.length + (approvals.length ? 1 : 0) + (waitingSess.length ? 1 : 0);
  return {
    kind: d.kind || "brief",
    from,
    to,
    sessions,
    finished,
    failed,
    started,
    ended,
    waiting: { approvals, sessions: waitingSess, decisions },
    spend: { usd, tokens, caps, usdAtFrom: d.usdAtFrom != null ? Number(d.usdAtFrom) : null },
    stale,
    fires,
    empty: happened === 0,
    live: live.length,
  };
}
function safeJson(s) {
  try {
    return typeof s === "string" ? JSON.parse(s) : s || null;
  } catch (_) {
    return null;
  }
}

/** Names joined for a sentence: "A", "A and B", "A, B and 2 more". */
function names(list, max) {
  const n = list.length;
  max = max || 3;
  if (n <= 1) return list.join("");
  if (n <= max) return list.slice(0, -1).join(", ") + " and " + list[n - 1];
  return list.slice(0, max).join(", ") + " and " + (n - max) + " more";
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * The words: { title, lines: [{ k: label, text, tone, sid? }] } (sid: a session's line, for its story) -- at most eight
 * short lines, what needs you first. `whenText` names the window's start
 * ("since 8:00 yesterday"); the caller formats it in the person's time zone.
 */
function compose(f, o) {
  o = o || {};
  const lines = [];
  const W = f.waiting;
  const head = f.kind === "catchup" ? "While you were away" : "Morning brief";
  const title = f.kind === "catchup" ? `${head} · ${span(f.to - f.from)}` : `${head}${o.whenText ? " · since " + o.whenText : ""}`;
  // Needs you.
  const need = [];
  if (W.approvals.length) {
    const oldest = W.approvals.reduce((m, a) => Math.max(m, a.ageMin), 0);
    need.push(plural(W.approvals.length, "approval") + " waiting" + (oldest >= 1 ? ` (the oldest ${span(oldest * 60000)})` : "") + (W.approvals.length === 1 ? `: ${W.approvals[0].who} — ${W.approvals[0].what}` : ""));
  }
  for (const s of W.sessions.slice(0, 2)) need.push(`${s.name} is waiting on you` + (s.min >= 1 ? ` ${span(s.min * 60000)}` : "") + (s.for ? ` (for ${s.for})` : ""));
  if (W.decisions) need.push(plural(W.decisions, "decision") + " open");
  if (need.length) lines.push({ k: "Needs you", text: need.join(" · "), tone: "warn" });
  // Finished and failed.
  if (f.finished.length) lines.push({ k: "Finished", text: f.finished.slice(0, 3).map((x) => x.name + (x.text ? ": " + clip(x.text, 80) : "")).join(" · "), tone: "ok" });
  if (f.failed.length) lines.push({ k: "Failed", text: f.failed.slice(0, 3).map((x) => x.name + (x.held ? " (held)" : "") + (x.text ? ": " + x.text : "")).join(" · "), tone: "err" });
  // What each session did (the ones not already named as finished).
  const shown = new Set(f.finished.map((x) => normName(x.name)));
  const did = f.sessions.filter((s) => !shown.has(normName(s.name))).slice(0, 3);
  for (const s of did) {
    const bits = [];
    if (s.workedMs >= 60000) bits.push("worked " + span(s.workedMs));
    if (s.finished > 1) bits.push("finished " + s.finished + " times");
    if (s.delegated) bits.push(plural(s.delegated, "task") + " from JOYA AI");
    const line = { k: s.name, text: (bits.length ? bits.join(", ") : "active") + (s.did.length ? ": " + clip(s.did[0], 90) : "") + (s.state === "busy" ? " (still working)" : ""), tone: "info" };
    if (UUID_RE.test(str(s.key))) line.sid = s.key; // the card links the line into the session's story
    lines.push(line);
  }
  if (f.sessions.length > did.length + shown.size && f.sessions.length > 3) lines.push({ k: "Also", text: names(f.sessions.slice(did.length).map((s) => s.name).filter((n) => !shown.has(normName(n))), 4) + " were active.", tone: "info" });
  if (f.started.length || f.ended.length) lines.push({ k: "Sessions", text: [f.started.length ? names(f.started) + " started" : "", f.ended.length ? names(f.ended) + " ended" : ""].filter(Boolean).join("; "), tone: "info" });
  // Watchers that fired (the catch-up).
  if (f.fires.length) lines.push({ k: "Watchers", text: (f.fires.length === 1 ? f.fires[0].text : plural(f.fires.length, "alert") + ": " + f.fires.slice(0, 2).map((x) => clip(x.text, 70)).join(" · ")), tone: "warn" });
  // Spend.
  const sp = f.spend;
  if (f.kind === "brief" || (sp.usdAtFrom != null && sp.usd > sp.usdAtFrom)) {
    let t = f.kind === "catchup" && sp.usdAtFrom != null ? `≈ ${money(sp.usd - sp.usdAtFrom)} while away, ≈ ${money(sp.usd)} today` : `≈ ${money(sp.usd)} today (API estimate), ${tok(sp.tokens)} tokens`;
    const top = sp.caps[0];
    if (top) t += ` · ${top.name} ${tok(top.used)} of ${tok(top.cap)} tokens (${top.pct}%)` + (top.paused ? ", paused at its cap" : "");
    else if (f.kind === "brief") t += " · no daily caps set";
    const paused = sp.caps.filter((c) => c.paused).slice(1);
    if (paused.length) t += " · also paused: " + names(paused.map((c) => c.name));
    lines.push({ k: "Spend", text: t, tone: top && (top.paused || top.pct >= 100) ? "err" : top && top.pct >= 80 ? "warn" : "info" });
  }
  // Stale.
  if (f.stale.length) lines.push({ k: "Check", text: f.stale.slice(0, 3).map((s) => `${s.name} ${s.why}`).join(" · "), tone: "warn" });
  if (!lines.some((l) => l.k !== "Spend")) lines.unshift({ k: "Quiet", text: f.live ? `Nothing new from the ${plural(f.live, "session")}.` : "No sessions ran.", tone: "info" });
  return { title, lines: lines.slice(0, 8) };
}

/** The brief as one text (for the model, the toast and reading aloud). */
function asText(c, withTitle) {
  return (withTitle ? c.title + "\n" : "") + c.lines.map((l) => `${l.k}: ${l.text}`).join("\n");
}

/* ------------------------------------------------------------ grounding -- */

const NUMBER_WORDS = { zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20, thirty: 30, forty: 40, fifty: 50, hundred: 100, thousand: 1000, million: 1e6, billion: 1e9, half: 0.5, dozen: 12, twice: 2, once: 1 };
/** Every number a text states, in one spelling ("1,200" -> "1200", "two" -> "2", "4.1M" -> "4.1"). */
function numbersIn(text) {
  const out = [];
  const s = str(text);
  for (const m of s.matchAll(/\d+(?:[.,:]\d+)*/g)) {
    const v = m[0];
    // 1,200 is twelve hundred; 8:05 is a time, kept whole.
    out.push(/^\d{1,3}(,\d{3})+(\.\d+)?$/.test(v) ? v.replace(/,/g, "") : v);
  }
  for (const m of s.toLowerCase().matchAll(/\b[a-z]+\b/g)) if (Object.prototype.hasOwnProperty.call(NUMBER_WORDS, m[0])) out.push(String(NUMBER_WORDS[m[0]]));
  return out;
}
/**
 * Is a model's text held to the facts? Every number in it must be a number of
 * the template's own text (which is written from the facts), and it must not
 * drop what needs the person. Returns { ok, why }.
 */
function grounded(text, c) {
  const t = str(text).trim();
  if (!t) return { ok: false, why: "empty" };
  if (t.length > 1200) return { ok: false, why: "too long" };
  const allowed = new Set(numbersIn(asText(c, true)));
  // "1" is said by "one" and by "an": a single, never a figure.
  allowed.add("1");
  for (const n of numbersIn(t)) if (!allowed.has(n)) return { ok: false, why: `the number ${n} is not in the facts` };
  const needs = c.lines.find((l) => l.k === "Needs you");
  if (needs && !/\b(approv|waiting|needs? you|decision)/i.test(t)) return { ok: false, why: "it left out what needs you" };
  const failed = c.lines.find((l) => l.k === "Failed");
  if (failed && !/\b(fail|held|error)/i.test(t)) return { ok: false, why: "it left out a failure" };
  if (/https?:\/\/|`|\*\*|^#/m.test(t)) return { ok: false, why: "markup" };
  // The same lines, no more: a line split in two would push the last ones off the card.
  const n = linesFrom(t, c).length;
  if (n > c.lines.length) return { ok: false, why: `${n} lines for ${c.lines.length}` };
  return { ok: true, why: "" };
}
/**
 * A model's lines back into the card's shape (the label before the first colon, the tone from it);
 * lines in a row under the same label are one line again (the model splits a line at its "; ").
 */
function linesFrom(text, c) {
  const tones = {}, sids = {};
  for (const l of c.lines) { tones[l.k.toLowerCase()] = l.tone; if (l.sid) sids[l.k.toLowerCase()] = l.sid; }
  const out = [];
  str(text)
    .split(/\n+/)
    .map((x) => x.replace(/^\s*[-•*]\s*/, "").replace(/\s+$/, "").trim())
    .filter(Boolean)
    .map((x) => {
      const m = /^([^:]{2,40}):\s*(.+)$/.exec(x);
      const k = m ? m[1].trim() : "";
      return { k: k || "Note", text: m ? m[2] : x, tone: tones[k.toLowerCase()] || (/^needs you/i.test(k) ? "warn" : /^failed/i.test(k) ? "err" : "info") };
    })
    .forEach((l) => {
      const last = out[out.length - 1];
      if (last && last.k.toLowerCase() === l.k.toLowerCase()) last.text += " · " + l.text;
      else {
        if (sids[l.k.toLowerCase()]) l.sid = sids[l.k.toLowerCase()];
        out.push(l);
      }
    });
  return out;
}

const WRITER_INSTRUCTIONS = [
  "You write JOYA AI's short brief for the administrator, from the facts given. JOYA AI supervises their Claude Code sessions.",
  "Rules:",
  "- Exactly one line per input line: the same labels (the words before the first colon), in the same order, never split or added. At most one short sentence per line, plain words, no markdown.",
  "- Say only what the facts say. Add no fact, figure, name, reason, advice or action.",
  "- Keep every number exactly as written (digits, $ and %, the same rounding), or leave it out. Never compute a new number.",
  "- Keep every negation and every 'waiting' or 'failed'.",
  "- Quotes from sessions may be shortened, never changed in meaning.",
  "Answer with the lines only.",
].join("\n");

module.exports = {
  MAX_WATCHERS,
  KINDS,
  KIND_LABEL,
  ALL_DAYS,
  DAY_NAMES,
  DEFAULT_WAIT_MIN,
  validate,
  describe,
  parse,
  looksLikeWatcher,
  sessionMatches,
  resolveSession,
  normName,
  transitions,
  evaluate,
  gather,
  compose,
  asText,
  grounded,
  numbersIn,
  linesFrom,
  localNow,
  validTz,
  validHm,
  hmLabel,
  daysLabel,
  money,
  tok,
  span,
  clip,
  sessKey,
  WRITER_INSTRUCTIONS,
};
