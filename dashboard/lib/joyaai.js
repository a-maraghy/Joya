"use strict";
/**
 * Client for the JOYA AI supervisor's unix socket.
 *
 * The supervisor (joya-ai.service, root) owns JOYA AI's Claude Code process.
 * This panel talks to it over /run/joya-ai/joya-ai.sock, which only root and
 * the joyaai group can open -- joyaadmin is in that group, nobody else is. No
 * sudo, no helper: the socket is the privilege boundary, and the supervisor
 * validates every request again (joya-ai/lib/protocol.js).
 *
 * Each call carries the signed-in panel user as `actor`, so the supervisor's
 * audit trail names a person rather than "joyaadmin".
 *
 * The request checks here mirror the supervisor's. They exist so a bad request
 * is refused with a useful message before it reaches a root process, not
 * because the supervisor would accept it.
 */

const net = require("net");
const { redactDeep } = require("./priv");

const SOCKET = process.env.JOYA_AI_SOCKET || "/run/joya-ai/joya-ai.sock";
const MAX_TEXT = 20000;
const TABLES = ["delegations", "inbound", "approvals", "turns", "audit"];
const ACTOR_RE = /^[A-Za-z0-9._@-]{1,64}$/;

let counter = 0;

class JoyaAiError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code || "error";
  }
}

/** Normalise a panel username into something the protocol accepts. */
function actorOf(username) {
  const a = String(username || "").replace(/[^A-Za-z0-9._@-]/g, "_").slice(0, 64);
  return ACTOR_RE.test(a) ? a : "unknown";
}

/**
 * One request, one reply.
 * Rejects with code "offline" when the supervisor is not listening.
 */
function call(op, params, actor, { timeout = 20000, socket = SOCKET } = {}) {
  return new Promise((resolve, reject) => {
    const id = "d" + ++counter;
    const s = net.createConnection(socket);
    let buf = "";
    let done = false;
    const finish = (err, data) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      s.destroy();
      if (err) reject(err);
      else resolve(data);
    };
    const timer = setTimeout(() => finish(new JoyaAiError("JOYA AI did not answer in time", "timeout")), timeout);
    s.setEncoding("utf8");
    s.on("error", (e) =>
      finish(
        new JoyaAiError(
          e.code === "ENOENT" || e.code === "ECONNREFUSED" ? "JOYA AI's supervisor is not running" : e.code === "EACCES" ? "The panel is not allowed to reach JOYA AI (group joyaai)" : e.message,
          e.code === "ENOENT" || e.code === "ECONNREFUSED" ? "offline" : "error"
        )
      )
    );
    s.on("connect", () => s.write(JSON.stringify({ id, op, actor: actorOf(actor), ...(params || {}) }) + "\n"));
    s.on("data", (chunk) => {
      buf += chunk;
      if (buf.length > 16 * 1024 * 1024) return finish(new JoyaAiError("reply too large"));
      const nl = buf.indexOf("\n");
      if (nl === -1) return;
      let msg;
      try {
        msg = JSON.parse(buf.slice(0, nl));
      } catch (_) {
        return finish(new JoyaAiError("unreadable reply from JOYA AI"));
      }
      if (msg.ok) finish(null, redactDeep(msg.data));
      else finish(new JoyaAiError(msg.error || "JOYA AI refused", "refused"));
    });
    s.on("close", () => finish(new JoyaAiError("JOYA AI closed the connection", "offline")));
  });
}

/**
 * Subscribe to the event stream. `onEvent(ev)` per event; `onEnd(err)` once.
 * Returns a function that closes the subscription.
 */
function subscribe(since, actor, onEvent, onEnd, { socket = SOCKET } = {}) {
  const s = net.createConnection(socket);
  let buf = "";
  let ended = false;
  const end = (err) => {
    if (ended) return;
    ended = true;
    s.destroy();
    onEnd && onEnd(err || null);
  };
  s.setEncoding("utf8");
  s.on("error", (e) => end(new JoyaAiError(e.code === "ENOENT" || e.code === "ECONNREFUSED" ? "JOYA AI's supervisor is not running" : e.message, "offline")));
  s.on("close", () => end(null));
  s.on("connect", () => {
    const req = { id: "sub" + ++counter, op: "events", actor: actorOf(actor) };
    if (Number.isInteger(since) && since > 0) req.since = since;
    s.write(JSON.stringify(req) + "\n");
  });
  s.on("data", (chunk) => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      let msg;
      try {
        msg = JSON.parse(line);
      } catch (_) {
        continue;
      }
      if (msg.event) onEvent(redactDeep(msg.event));
      else if (msg.ok === false) end(new JoyaAiError(msg.error || "refused", "refused"));
    }
  });
  return () => end(null);
}

/* --------------------------------------------------------- request checks --- */

function bad(msg) {
  return new JoyaAiError(msg, "invalid");
}

function cleanSend(body) {
  const text = typeof body.text === "string" ? body.text : "";
  if (text.includes("\u0000")) throw bad("The message contains a NUL byte.");
  if (!text.trim()) throw bad("Say something first.");
  if (text.length > MAX_TEXT) throw bad(`Keep it under ${MAX_TEXT} characters.`);
  const out = { text: text.trim() };
  if (body.target !== undefined && body.target !== null && body.target !== "") {
    if (typeof body.target !== "string" || body.target.length > 300 || /[\r\n\u0000]/.test(body.target)) throw bad("That target is not a session name.");
    out.target = body.target.trim();
  }
  return out;
}

function cleanApprovalId(raw) {
  const s = String(raw == null ? "" : raw);
  if (!/^[1-9][0-9]{0,15}$/.test(s)) throw bad("No such approval.");
  return Number(s);
}

function cleanNote(raw) {
  if (raw === undefined || raw === null || raw === "") return undefined;
  if (typeof raw !== "string" || raw.length > 500 || raw.includes("\u0000")) throw bad("Keep the note under 500 characters.");
  return raw.trim() || undefined;
}

function cleanLedger(table, query) {
  if (!TABLES.includes(table)) throw bad("No such ledger.");
  const out = { table };
  const int = (v, name, max) => {
    if (v === undefined || v === "") return undefined;
    if (!/^[0-9]{1,16}$/.test(String(v)) || Number(v) < 1 || Number(v) > max) throw bad(`${name} is not valid.`);
    return Number(v);
  };
  const limit = int(query.limit, "limit", 500);
  const before = int(query.before_id, "before_id", Number.MAX_SAFE_INTEGER);
  if (limit) out.limit = limit;
  if (before) out.before_id = before;
  if (query.status !== undefined && query.status !== "") {
    if (!/^[a-z_]{1,32}$/.test(String(query.status))) throw bad("status is not valid.");
    out.status = String(query.status);
  }
  return out;
}

function cleanSince(raw) {
  const s = String(raw == null ? "" : raw).trim();
  if (!s) return 0;
  if (!/^[0-9]{1,16}$/.test(s)) return 0;
  return Number(s);
}

/* ------------------------------------------ Command Center v3, phase 1 --- */
/*
 * The same shapes the supervisor checks again (joya-ai/lib/protocol.js). These
 * turn a browser's JSON into exactly the fields the supervisor accepts, and
 * refuse anything else with a message a person can act on.
 */

function str(v, name, { max = 4000, min = 1, optional = false, re = null } = {}) {
  if (v === undefined || v === null || v === "") {
    if (optional) return undefined;
    throw bad(`${name} is required.`);
  }
  if (typeof v !== "string" || v.includes("\u0000")) throw bad(`${name} must be text.`);
  const t = v.trim();
  if (t.length < min) throw bad(`${name} is required.`);
  if (v.length > max) throw bad(`${name} must be at most ${max} characters.`);
  if (re && !re.test(t)) throw bad(`${name} is not valid.`);
  return t;
}
function oneOf(v, name, values, optional) {
  if (v === undefined || v === null || v === "") {
    if (optional) return undefined;
    throw bad(`${name} is required.`);
  }
  if (!values.includes(v)) throw bad(`${name} must be one of ${values.join(", ")}.`);
  return v;
}
function intOf(v, name, min, max, optional) {
  if (v === undefined || v === null || v === "") {
    if (optional) return undefined;
    throw bad(`${name} is required.`);
  }
  const n = typeof v === "number" ? v : /^-?[0-9]{1,16}$/.test(String(v)) ? Number(v) : NaN;
  if (!Number.isInteger(n) || n < min || n > max) throw bad(`${name} must be a whole number ${min}–${max}.`);
  return n;
}
function idOf(raw, what) {
  const s = String(raw == null ? "" : raw);
  if (!/^[1-9][0-9]{0,15}$/.test(s)) throw bad(`No such ${what}.`);
  return Number(s);
}
function missionIdOf(raw) {
  const s = String(raw == null ? "" : raw);
  if (!/^(M-)?[1-9][0-9]{0,8}$/i.test(s)) throw bad("No such mission.");
  return s.toUpperCase().startsWith("M-") ? s.toUpperCase() : "M-" + s;
}
function strip(o) {
  const out = {};
  for (const [k, v] of Object.entries(o)) if (v !== undefined) out[k] = v;
  return out;
}

const WATCHERS = ["service_failed", "ban_burst", "disk", "agent_failing", "odoo_errors"];
const SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function cleanAlwaysRule(body) {
  const r = body && body.rule;
  if (r === undefined || r === null) return null;
  if (typeof r !== "object" || Array.isArray(r)) throw bad("The rule is not valid.");
  return { rule_pattern: str(r.pattern, "The rule's pattern", { max: 2000 }), rule_tool: oneOf(r.tool, "The rule's tool", ["Bash", "SendMessage"]) };
}

function cleanSchedule(s) {
  if (!s || typeof s !== "object" || Array.isArray(s)) throw bad("Pick a schedule.");
  return strip({
    kind: oneOf(s.kind, "Schedule", ["daily", "weekdays", "weekly", "hours", "cron"]),
    at: str(s.at, "Time", { max: 5, optional: true, re: /^([01][0-9]|2[0-3]):[0-5][0-9]$/ }),
    dow: intOf(s.dow, "Weekday", 0, 6, true),
    every_h: intOf(s.every_h, "Every N hours", 1, 24, true),
    cron: str(s.cron, "Cron", { max: 100, optional: true, re: /^[0-9*,\/ -]{9,100}$/ }),
  });
}

function cleanOrder(body, partial) {
  const b = body || {};
  const out = strip({
    name: str(b.name, "Name", { max: 120, optional: partial }),
    schedule: b.schedule === undefined && partial ? undefined : cleanSchedule(b.schedule),
    target: str(b.target, "Runs as", { max: 300, optional: partial, re: /^[^\r\n\u0000]+$/ }),
    prompt: str(b.prompt, "What to do", { max: 8000, optional: partial }),
    delivery:
      b.delivery === undefined
        ? partial
          ? undefined
          : ["cc"]
        : Array.isArray(b.delivery) && b.delivery.length && b.delivery.length <= 2 && b.delivery.every((x) => x === "cc" || x === "telegram")
        ? [...new Set(b.delivery)]
        : (() => {
            throw bad("Deliver to the Command Center.");
          })(),
    paused: b.paused === undefined ? undefined : typeof b.paused === "boolean" ? b.paused : (() => {
      throw bad("paused must be true or false.");
    })(),
  });
  return out;
}

function cleanRule(body, partial) {
  const b = body || {};
  return strip({
    effect: oneOf(b.effect, "Effect", ["allow", "ask", "deny"], partial),
    tool: oneOf(b.tool, "Tool", ["Bash", "SendMessage", "any"], partial),
    pattern: str(b.pattern, "Pattern", { max: 2000, optional: partial }),
    note: str(b.note, "Note", { max: 500, optional: true }),
  });
}

function cleanBudget(body) {
  const b = body || {};
  let daily = b.daily_usd;
  if (daily === "" || daily === undefined) daily = null;
  if (daily !== null) {
    daily = typeof daily === "number" ? daily : Number(daily);
    if (!isFinite(daily) || daily < 0 || daily > 100000) throw bad("The daily budget must be a number of dollars, or empty for none.");
  }
  return { daily_usd: daily, warn_pct: intOf(b.warn_pct === undefined ? 80 : b.warn_pct, "Warn at", 50, 100) };
}

module.exports = {
  WATCHERS,
  SESSION_ID_RE,
  str,
  oneOf,
  intOf,
  idOf,
  missionIdOf,
  cleanAlwaysRule,
  cleanOrder,
  cleanRule,
  cleanBudget,
  SOCKET,
  MAX_TEXT,
  TABLES,
  JoyaAiError,
  actorOf,
  call,
  subscribe,
  cleanSend,
  cleanApprovalId,
  cleanNote,
  cleanLedger,
  cleanSince,
};
