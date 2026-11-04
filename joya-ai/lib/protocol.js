"use strict";
/**
 * The supervisor's socket protocol, and the one place it is validated.
 *
 * Newline-delimited JSON over a unix socket. Each request is one line:
 *
 *   {"id": "r1", "op": "status", "actor": "amaraghy"}
 *
 * and gets one reply line:
 *
 *   {"id": "r1", "ok": true, "data": {...}}
 *   {"id": "r1", "ok": false, "error": "..."}
 *
 * `events` is the exception: after its reply the connection carries
 * {"event": {...}} lines until the client hangs up.
 *
 * `actor` is the signed-in panel user the dashboard is acting for. The socket
 * is reachable only by root and the joyaai group, so the actor is taken on the
 * dashboard's word -- but it is always required and always recorded, so the
 * audit trail says who asked rather than "joyaadmin".
 *
 * Everything is re-validated here even though the dashboard validates first:
 * this is the boundary between a web-facing process and a root one.
 */

const MAX_LINE = 64 * 1024;
const MAX_TEXT = 20000;
const ACTOR_RE = /^[A-Za-z0-9._@-]{1,64}$/;
const ID_RE = /^[A-Za-z0-9._:-]{1,64}$/;
const LANE_RE = /^v[a-z0-9-]{1,60}$/; // a voice lane's id (supervisor lib/voicelane.js)
// A token-cap key: "<self>" (JOYA AI), "default" (new hires), a hire slug or a session id.
const CAP_KEY_RE = /^(<self>|default|[a-z0-9][a-z0-9-]{0,39}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;

const TABLES = ["delegations", "inbound", "approvals", "turns", "audit", "hired_sessions"];
const WATCHERS = ["service_failed", "ban_burst", "disk", "agent_failing", "odoo_errors"];
const STATUSES = {
  delegations: ["sent", "working", "ack", "held", "done", "failed", "denied"],
  approvals: ["pending", "approved", "denied", "expired", "cancelled"],
  turns: ["queued", "running", "done", "error", "interrupted", "lost"],
  inbound: ["message", "idle", "delivery"],
  audit: [],
  hired_sessions: ["hired", "retiring", "retired"],
};

// op -> { mutating, params: { name: validator } }
const OPS = {
  ping: { mutating: false, params: {} },
  status: { mutating: false, params: {} },
  sessions: { mutating: false, params: {} },
  "rc-url": { mutating: false, params: {} },
  events: { mutating: false, params: { since: optInt(0, Number.MAX_SAFE_INTEGER) } },
  ledger: {
    mutating: false,
    params: {
      table: enumOf(TABLES),
      limit: optInt(1, 500),
      before_id: optInt(1, Number.MAX_SAFE_INTEGER),
      status: optString(32, /^[a-z_]+$/),
    },
  },
  send: {
    mutating: true,
    params: {
      text: text(1, MAX_TEXT),
      target: optString(300, /^[^\n\r\u0000]*$/),
      // "voice-desk": passed on by the voice front desk (trial). Recorded as the
      // turn's source; it changes nothing else about the turn.
      via: optEnum(["voice-desk"]),
      // The one-time ui token the Command Center minted for this send (UI
      // control Phase 2): lets JOYA AI's ui_action reach the tab that asked,
      // during this turn only. Kept in memory, never in the ledger or events.
      ut: optString(40, /^[A-Za-z0-9_-]{16,40}$/),
      // The live call a voice-desk send comes from (the dashboard's call id): a repeat of a
      // request still waiting in the queue is folded into that turn (supervisor mergeVoiceTurn).
      call: optString(42, /^lv[a-z0-9]{1,40}$/),
      // A voice-desk send's speaker, as the voiceprint judged it: "command" = recognised AND may give
      // commands; anything else is "other". Taking over a computer by voice needs "command" (lib/machines.js).
      vp: optEnum(["command", "other"]),
    },
  },
  // A live call is starting (the dashboard, at call start): its voice lanes are started ahead, so its first
  // request does not wait for a CLI to come up (lib/voicelane.js). No turn, nothing billed until one is sent.
  "voice-warm": { mutating: false, params: { call: str(42, /^lv[a-z0-9]{1,40}$/) } },
  // The dashboard (re)started: what it runs now, for JOYA AI's next turn and the snapshot.
  "deploy-event": {
    mutating: true,
    params: {
      component: enumOf(["dashboard"]),
      started_at: optString(30, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/),
      deployed_at: optString(30, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/),
      commit: optString(40, /^[0-9a-f]{7,40}$/),
    },
  },
  // JOYA AI's ui_action (its MCP tool): change what the administrator sees in
  // the tab that asked. Accepted only from actor "joya-ai", only while a turn
  // the administrator started (dashboard / voice-desk) with a ui token runs.
  "ui-action": { mutating: true, params: { action: str(40, /^[a-z]+(\.[a-z_]+)?$/), args: uiArgs() } },
  // JOYA AI's ui_widget (its MCP tool, the living canvas): a widget for the tab that asked, built only
  // from the fixed, versioned building blocks (lib/joya-widgets.js -- the dashboard's copy is checked
  // to be the same file). Accepted on the same terms as ui-action.
  "ui-widget": { mutating: true, params: { widget: widgetSpec() } },
  // The Command Center's answer to one ui event (the page did it, or refused).
  // pending: a Tier-2 preference shown for the administrator's confirm (nothing changed yet).
  "ui-ack": { mutating: true, params: { nonce: str(40, /^[A-Za-z0-9]{8,40}$/), ok: bool(), why: optText(200), pending: optBool() } },
  interrupt: { mutating: true, params: {} },
  // Hired sessions (M-6). Hire: JOYA AI or the administrator. Retire: from JOYA AI only a consent card;
  // from the administrator (the Command Center's Keep / Retire dialog) it ends the session. Keep: the administrator.
  "session-hire": { mutating: true, params: { name: text(1, 48), cwd: str(300, /^\/[^\u0000\n\r]*$/), purpose: text(10, 4000), model: optString(64, /^claude-[a-z0-9][a-z0-9.-]{2,60}$/) } },
  "session-retire": { mutating: true, params: { slug: optString(40, /^[a-z0-9][a-z0-9-]{0,39}$/), name: optString(64, /^[^\n\r\u0000]{1,64}$/), ref: optString(12, /^[0-9a-f]{4,12}$/i), session_id: optString(36, /^[0-9a-f-]{36}$/), note: optText(500), ...stepped() } },
  "session-keep": { mutating: true, params: { slug: optString(40, /^[a-z0-9][a-z0-9-]{0,39}$/), session_id: optString(36, /^[0-9a-f-]{36}$/), kept: bool() } },
  hired: { mutating: false, params: { all: optBool() } },
  // A hired session's own permission question (bin/joya-session, actor "session.<slug>"): answered on this connection.
  "session-approval": {
    mutating: false,
    params: { slug: str(40, /^[a-z0-9][a-z0-9-]{0,39}$/), request_id: str(64, /^[^\n\r\u0000]{1,64}$/), tool: str(80, /^[A-Za-z0-9_.:-]{1,80}$/), input: text(2, 16000), reason: optText(2000), tool_use_id: optString(64, /^[A-Za-z0-9_-]{1,64}$/) },
  },
  "session-approval-cancel": { mutating: false, params: { slug: str(40, /^[a-z0-9][a-z0-9-]{0,39}$/), request_id: str(64, /^[^\n\r\u0000]{1,64}$/) } },
  approve: {
    mutating: true,
    params: { approval_id: int(1, Number.MAX_SAFE_INTEGER), note: optText(500), rule_pattern: optText(2000), rule_tool: optEnum(["Bash", "SendMessage"]), ...stepped() },
  },
  deny: { mutating: true, params: { approval_id: int(1, Number.MAX_SAFE_INTEGER), note: optText(500) } },
  // Keep a waiting card alive while the administrator answers Windows Hello (the panel asks when it
  // issues the challenge): its expiry moves to at least `seconds` from now, bounded (supervisor holdApproval).
  "approval-hold": { mutating: false, params: { approval_id: int(1, Number.MAX_SAFE_INTEGER), seconds: int(10, 120) } },
  rc: { mutating: true, params: { enabled: bool() } },
  restart: { mutating: true, params: {} },
  // Start JOYA AI in a new conversation (new session id; the old transcript stays on disk).
  fresh: { mutating: true, params: { reason: optText(300), force: optBool() } },

  /* ---- phase 1 of Command Center v3: reads ---- */
  machine: { mutating: false, params: {} },
  missions: { mutating: false, params: { status: optEnum(["active", "all"]), limit: optInt(1, 200) } },
  mission: { mutating: false, params: { mission_id: missionId() } },
  decisions: { mutating: false, params: { status: optEnum(["open", "all"]), limit: optInt(1, 200) } },
  watchers: { mutating: false, params: {} },
  orders: { mutating: false, params: {} },
  "order-runs": { mutating: false, params: { order_id: int(1, Number.MAX_SAFE_INTEGER), limit: optInt(1, 100) } },
  rules: { mutating: false, params: {} },
  "rule-test": { mutating: false, params: { command: text(1, 8000), tool: optEnum(["Bash", "SendMessage"]) } },
  "rule-suggest": { mutating: false, params: { approval_id: int(1, Number.MAX_SAFE_INTEGER) } },
  cost: { mutating: false, params: {} },
  // Claude plan usage as /usage shows it, plus this box's token counts.
  // plan_only: skip the token counts; cached: do not ask the CLI, answer from the cache.
  usage: { mutating: false, params: { plan_only: optBool(), cached: optBool() } },
  // The voice front desk's read-only view: counts, titles and figures, never a
  // command. `turns`: the desk's own earlier requests, to learn their replies.
  snapshot: { mutating: false, params: { turns: optIntList(1, Number.MAX_SAFE_INTEGER, 20) } },
  "session-mirror": { mutating: false, params: { session_id: str(36, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/) } },
  // The session story and the day timeline (lib/story.js).
  "session-story": { mutating: false, params: { session_id: str(36, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/) } },
  "story-day": { mutating: false, params: { day: optString(10, /^\d{4}-\d{2}-\d{2}$/) } },

  /* ---- writes ---- */
  "mission-create": { mutating: true, params: { title: text(1, 200), goal: optText(4000), steps: optArray(stepSpec(), 50) } },
  "mission-step-add": { mutating: true, params: { mission_id: missionId(), title: text(1, 300), detail: optText(4000), target: optString(300, /^[^\n\r\u0000]*$/) } },
  "mission-step-update": {
    mutating: true,
    params: {
      mission_id: missionId(),
      step: int(1, 1000),
      status: optEnum(["planned", "delegated", "working", "waiting_approval", "done", "failed", "skipped"]),
      target: optString(300, /^[^\n\r\u0000]*$/),
      result: optText(4000),
      note: optText(1000),
      title: optText(300),
      detail: optText(4000),
    },
  },
  "mission-update": { mutating: true, params: { mission_id: missionId(), status: optEnum(["planned", "active", "done", "failed", "cancelled"]), title: optText(200), goal: optText(4000) } },
  "mission-request": { mutating: true, params: { goal: text(1, 4000) } },
  "decision-propose": { mutating: true, params: { decision_id: int(1, Number.MAX_SAFE_INTEGER), summary: text(1, 4000), evidence: optText(8000), fix_command: optText(4000) } },
  "decision-update": { mutating: true, params: { decision_id: int(1, Number.MAX_SAFE_INTEGER), status: enumOf(["done", "failed"]), result: optText(4000) } },
  "decision-approve": { mutating: true, params: { decision_id: int(1, Number.MAX_SAFE_INTEGER), note: optText(500), ...stepped() } },
  "decision-dismiss": { mutating: true, params: { decision_id: int(1, Number.MAX_SAFE_INTEGER), note: optText(500) } },
  "decision-ask": { mutating: true, params: { decision_id: int(1, Number.MAX_SAFE_INTEGER), text: text(1, 4000) } },
  "watcher-set": { mutating: true, params: { key: enumOf(WATCHERS), enabled: bool() } },
  "watcher-inject": { mutating: true, params: { watcher: enumOf(WATCHERS), subject: str(120, /^[A-Za-z0-9@._\/-]{1,120}$/), detail: optText(2000), evidence: optText(4000) } },
  "order-create": { mutating: true, params: orderParams(false) },
  "order-update": { mutating: true, params: { order_id: int(1, Number.MAX_SAFE_INTEGER), ...orderParams(true) } },
  "order-delete": { mutating: true, params: { order_id: int(1, Number.MAX_SAFE_INTEGER) } },
  "order-run": { mutating: true, params: { order_id: int(1, Number.MAX_SAFE_INTEGER) } },
  "order-pause": { mutating: true, params: { order_id: int(1, Number.MAX_SAFE_INTEGER), paused: bool() } },
  "rule-create": { mutating: true, params: { effect: enumOf(["allow", "ask", "deny"]), tool: enumOf(["Bash", "SendMessage", "any"]), pattern: text(1, 2000), note: optText(500), ...stepped() } },
  "rule-update": {
    mutating: true,
    params: { rule_id: int(1, Number.MAX_SAFE_INTEGER), effect: optEnum(["allow", "ask", "deny"]), tool: optEnum(["Bash", "SendMessage", "any"]), pattern: optText(2000), note: optText(500), ...stepped() },
  },
  "rule-delete": { mutating: true, params: { rule_id: int(1, Number.MAX_SAFE_INTEGER), ...stepped() } },
  "cost-budget": { mutating: true, params: { daily_usd: nullableNumber(0, 100000), warn_pct: int(50, 100) } },

  /* ---- editable settings (Joya reorganisation, 2026-09-30); every write is the administrator's only ---- */
  // Hire limits (lib/hire.js defaults; ledger hire_max_live / hire_per_hour / hire_perm_mode). null: back to the default.
  "hire-limits": { mutating: false, params: {} },
  "hire-limits-set": { mutating: true, params: { max_live: optNullable(int(1, 12)), per_hour: optNullable(int(0, 10)), perm_mode: optNullable(str(20, /^[A-Za-z]{1,20}$/)) } },
  // The approval timeout (ledger approval_timeout_s over the config's). null: back to the config's.
  "approval-timeout": { mutating: false, params: {} },
  "approval-timeout-set": { mutating: true, params: { seconds: nullable(int(30, 3600)) } },
  // Token caps per session (build spec §6). key: "<self>", "default", a hire slug or a session id; cap null removes it.
  "token-caps": { mutating: false, params: {} },
  "token-caps-set": { mutating: true, params: { key: optString(64, CAP_KEY_RE), cap: optNullable(int(1, 1e12)), at: optEnum(["warn", "pause"]), warn_pct: optInt(50, 100) } },
  "budget-resume": { mutating: true, params: { key: optString(64, CAP_KEY_RE), decision_id: optInt(1, Number.MAX_SAFE_INTEGER), ...stepped() } },
  // A hired session's standing link (bin/joya-session, actor "session.<slug>"): budget-pause / budget-resume come down it.
  "session-link": { mutating: false, params: { slug: str(40, /^[a-z0-9][a-z0-9-]{0,39}$/) } },
  // JOYA AI's page map (build spec §5): no params reads it; pages stores and applies it; reset returns to the built-in list.
  "ui-pages": { mutating: true, params: { pages: optArray(pageSpec(), 500), reset: optBool() } },
  // JOYA AI's charter (the CLAUDE.md in its working directory), read-only, at most 64 KB.
  charter: { mutating: false, params: {} },

  /* ---- the user's own computers (Path A laptop control, lib/machines.js) ---- */
  // The dashboard's machine relay (actor "machines"): the linked computers and whether each is online now.
  // claude: what the computer's app says about Claude Code there (left out: not said yet).
  "machines-sync": {
    mutating: false,
    params: { machines: optArray(objOf({ id: int(1, 9999999999), name: text(1, 64), online: bool(), platform: optString(20, /^[a-z0-9_-]{1,20}$/), home: optText(260), claude: optObjOf({ found: bool(), version: optText(60), git_bash: optBool() }), chrome: optObjOf({ extension: bool(), allowed: optBool(), last: optObjOf({ connected: bool() }) }), folders: optArray(text(3, 260), 20), office: optArray(enumOf(["Word", "Excel", "PowerPoint"]), 3) }), 200) },
  },
  machines: { mutating: false, params: {} },
  // JOYA AI (during a turn the administrator started) or the administrator: hire a session on a computer, under a lease.
  "machine-take-over": { mutating: true, params: { machine: optString(64, /^[^\n\r\u0000]{1,64}$/), purpose: text(10, 4000), minutes: optInt(1, 60), model: optString(64, /^claude-[a-z0-9][a-z0-9.-]{2,60}$/) } },
  "machine-tell": { mutating: true, params: { machine: optString(64, /^[^\n\r\u0000]{1,64}$/), message: text(1, 8000) } },
  "machine-release": { mutating: true, params: { machine: optString(64, /^[^\n\r\u0000]{1,64}$/), note: optText(300) } },
  // The dashboard, for one linked computer (actor "machine.<id>", after it checked that computer's token).
  "machine-ask": {
    mutating: false,
    params: { slug: str(40, /^[a-z0-9][a-z0-9-]{0,39}$/), request_id: str(64, /^[^\n\r\u0000]{1,64}$/), tool: str(80, /^[A-Za-z0-9_.:-]{1,80}$/), input: text(2, 16000), reason: optText(2000), tool_use_id: optString(64, /^[A-Za-z0-9_-]{1,64}$/), origin: optEnum(["cli", "hands"]), hint: optText(8000) },
  },
  "machine-ask-cancel": { mutating: false, params: { slug: str(40, /^[a-z0-9][a-z0-9-]{0,39}$/), request_id: str(64, /^[^\n\r\u0000]{1,64}$/) } },
  "machine-report": { mutating: true, params: { slug: str(40, /^[a-z0-9][a-z0-9-]{0,39}$/), text: text(1, MAX_TEXT) } },
  "machine-state": { mutating: true, params: { slug: str(40, /^[a-z0-9][a-z0-9-]{0,39}$/), state: enumOf(["starting", "running", "exited", "failed", "ended"]), reason: optText(300) } },
};

/* ------------------------------------------------------------ validators --- */

function optNullable(check) {
  const f = (v, name) => check(v, name);
  f.optional = true;
  f.nullable = true;
  return f;
}
function nullable(check) {
  const f = (v, name) => check(v, name);
  f.nullable = true;
  return f;
}
/** One page-map entry: { key, parent?, kind, label, url, perm? } -- short strings, a site-relative url. */
function pageSpec() {
  const key = str(64, /^[a-z0-9][a-z0-9._-]{0,63}$/);
  const opt = (c) => {
    const f = (v, n) => c(v, n);
    f.optional = true;
    return f;
  };
  const spec = objOf({
    key,
    parent: opt(key),
    kind: str(16, /^[a-z]{1,16}$/),
    label: str(120, /^[^\u0000-\u001f\u007f<>]{1,120}$/),
    url: str(300, /^\/(?![\/\\])[^\s\u0000-\u001f\u007f<>"'`\\]{0,299}$/),
    perm: opt(str(64, /^[A-Za-z0-9._:-]{1,64}$/)),
  });
  return (v, name) => {
    const e = spec(v, name);
    return { key: e.key, parent: e.parent || null, kind: e.kind, label: e.label, url: e.url, perm: e.perm || null };
  };
}

/** A widget: checked and made canonical by the building blocks' own validator (lib/joya-widgets.js). */
function widgetSpec() {
  const Widgets = require("./joya-widgets");
  return (v, name) => {
    const r = Widgets.validate(v);
    if (!r.ok) throw new Error(`${name}: ${r.why}`);
    return r.value;
  };
}

/** A screen action's flat arguments: at most six known keys, short strings or booleans. */
function uiArgs() {
  const KEYS = ["key", "mode", "name", "core", "page", "on", "theme", "preset", "voice"]; // = UiActions.ARG_KEYS (tested)
  const f = (v, name) => {
    if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error(`${name} must be an object`);
    const out = {};
    for (const [k, x] of Object.entries(v)) {
      if (!KEYS.includes(k)) throw new Error(`${name} has an unexpected field: ${k.slice(0, 40)}`);
      if (typeof x === "boolean") out[k] = x;
      else if (typeof x === "string" && x.length <= 40 && /^[A-Za-z0-9._-]*$/.test(x)) out[k] = x;
      else throw new Error(`${name}.${k} is not valid`);
    }
    return out;
  };
  f.optional = true;
  return f;
}

function optIntList(min, max, maxLen) {
  const f = (v, name) => {
    if (!Array.isArray(v) || v.length > maxLen || v.some((x) => typeof x !== "number" || !Number.isInteger(x) || x < min || x > max))
      throw new Error(`${name} must be a list of at most ${maxLen} integers`);
    return [...new Set(v)];
  };
  f.optional = true;
  return f;
}
/**
 * How the administrator confirmed an approval in the panel (dashboard
 * lib/stepup.js, 2026-10-08): "hello" (Windows Hello / a passkey) or "totp"
 * (the authenticator code), and with which passkey. Optional on the ops that
 * let something run; recorded on the approval row and in the audit.
 */
function stepped() {
  return { verified: optEnum(["hello", "totp"]), verified_with: optText(80) };
}

function optEnum(values) {
  const f = enumOf(values);
  f.optional = true;
  return f;
}
function str(max, re) {
  return (v, name) => {
    if (typeof v !== "string" || v.length > max || !re.test(v)) throw new Error(`${name} is not valid`);
    return v.trim();
  };
}
function missionId() {
  return (v, name) => {
    const s = typeof v === "number" ? String(v) : v;
    if (typeof s !== "string" || !/^(M-)?[1-9][0-9]{0,8}$/i.test(s.trim())) throw new Error(`${name} must look like M-12`);
    return Number(s.trim().replace(/^M-/i, ""));
  };
}
function nullableNumber(min, max) {
  const f = (v, name) => {
    if (v === false) return null;
    if (typeof v !== "number" || !isFinite(v) || v < min || v > max) throw new Error(`${name} must be a number ${min}..${max} or null`);
    return Math.round(v * 100) / 100;
  };
  f.nullable = true;
  return f;
}
/** An array of objects, each checked by `item`. */
function optArray(item, max) {
  const f = (v, name) => {
    if (!Array.isArray(v)) throw new Error(`${name} must be a list`);
    if (v.length > max) throw new Error(`${name} has more than ${max} items`);
    return v.map((x, i) => item(x, `${name}[${i}]`));
  };
  f.optional = true;
  return f;
}
/** An object with exactly these fields. */
function objOf(spec) {
  return (v, name) => {
    if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error(`${name} must be an object`);
    for (const k of Object.keys(v)) if (!Object.prototype.hasOwnProperty.call(spec, k)) throw new Error(`${name} has an unexpected field: ${k.slice(0, 40)}`);
    const out = {};
    for (const [k, check] of Object.entries(spec)) {
      if (v[k] === undefined || v[k] === null) {
        if (check.optional) continue;
        throw new Error(`${name}.${k} is required`);
      }
      out[k] = check(v[k], `${name}.${k}`);
    }
    return out;
  };
}
function optObjOf(spec) {
  const f = objOf(spec);
  f.optional = true;
  return f;
}
function stepSpec() {
  return objOf({ title: text(1, 300), detail: optText(4000), target: optString(300, /^[^\n\r\u0000]*$/) });
}
function orderParams(partial) {
  const o = (f) => {
    if (!partial) return f;
    const g = (v, n) => f(v, n);
    g.optional = true;
    return g;
  };
  const schedule = objOf({
    kind: enumOf(["daily", "weekdays", "weekly", "hours", "cron"]),
    at: optString(5, /^([01][0-9]|2[0-3]):[0-5][0-9]$/),
    dow: optInt(0, 6),
    every_h: optInt(1, 24),
    cron: optString(100, /^[0-9*,\/ -]{9,100}$/),
  });
  const delivery = (v, name) => {
    if (!Array.isArray(v) || !v.length || v.length > 2 || v.some((x) => !["cc", "telegram"].includes(x))) throw new Error(`${name} must be a list of cc / telegram`);
    return [...new Set(v)];
  };
  return {
    name: o(text(1, 120)),
    schedule: o(schedule),
    target: o(str(300, /^[^\n\r\u0000]{1,300}$/)),
    prompt: o(text(1, 8000)),
    delivery: o(delivery),
    paused: optBool(),
  };
}
function optBool() {
  const f = bool();
  f.optional = true;
  return f;
}

function int(min, max) {
  return (v, name) => {
    if (typeof v !== "number" || !Number.isInteger(v) || v < min || v > max) throw new Error(`${name} must be an integer ${min}..${max}`);
    return v;
  };
}
function optInt(min, max) {
  const f = int(min, max);
  f.optional = true;
  return f;
}
function bool() {
  return (v, name) => {
    if (typeof v !== "boolean") throw new Error(`${name} must be true or false`);
    return v;
  };
}
function enumOf(values) {
  return (v, name) => {
    if (typeof v !== "string" || !values.includes(v)) throw new Error(`${name} must be one of ${values.join(", ")}`);
    return v;
  };
}
function text(min, max) {
  return (v, name) => {
    if (typeof v !== "string") throw new Error(`${name} must be a string`);
    if (v.includes("\u0000")) throw new Error(`${name} contains a NUL byte`);
    const t = v.trim();
    if (t.length < min) throw new Error(`${name} is empty`);
    if (v.length > max) throw new Error(`${name} is longer than ${max} characters`);
    return t;
  };
}
function optText(max) {
  const f = (v, name) => {
    if (typeof v !== "string") throw new Error(`${name} must be a string`);
    if (v.includes("\u0000")) throw new Error(`${name} contains a NUL byte`);
    if (v.length > max) throw new Error(`${name} is longer than ${max} characters`);
    return v.trim();
  };
  f.optional = true;
  return f;
}
function optString(max, re) {
  const f = (v, name) => {
    if (typeof v !== "string" || v.length > max || !re.test(v)) throw new Error(`${name} is not valid`);
    return v.trim();
  };
  f.optional = true;
  return f;
}

/**
 * Parse and validate one request line.
 * Returns { ok: true, req: { id, op, actor, params, mutating } } or
 *         { ok: false, id, error }.
 */
function parseRequest(line) {
  if (typeof line !== "string") return { ok: false, id: null, error: "request must be text" };
  if (Buffer.byteLength(line, "utf8") > MAX_LINE) return { ok: false, id: null, error: "request too large" };
  let msg;
  try {
    msg = JSON.parse(line);
  } catch (_) {
    return { ok: false, id: null, error: "request is not valid JSON" };
  }
  if (!msg || typeof msg !== "object" || Array.isArray(msg)) return { ok: false, id: null, error: "request must be a JSON object" };

  const id = typeof msg.id === "number" && Number.isInteger(msg.id) ? String(msg.id) : msg.id;
  if (typeof id !== "string" || !ID_RE.test(id)) return { ok: false, id: null, error: "id is missing or malformed" };

  const spec = Object.prototype.hasOwnProperty.call(OPS, msg.op) ? OPS[msg.op] : null;
  if (!spec) return { ok: false, id, error: "unknown op" };

  if (typeof msg.actor !== "string" || !ACTOR_RE.test(msg.actor)) return { ok: false, id, error: "actor is missing or malformed" };

  // A voice lane's MCP server (bin/joya-ai-mcp, JOYA_AI_LANE) names its session on every call: which
  // lane's running turn a screen action, widget or mission belongs to. JOYA AI's own actor only.
  let lane = null;
  if (msg.lane !== undefined) {
    if (msg.actor !== "joya-ai" || typeof msg.lane !== "string" || !LANE_RE.test(msg.lane)) return { ok: false, id, error: "lane is malformed or not allowed for this actor" };
    lane = msg.lane;
  }
  const params = {};
  for (const key of Object.keys(msg)) {
    if (key === "id" || key === "op" || key === "actor" || key === "lane") continue;
    if (!Object.prototype.hasOwnProperty.call(spec.params, key)) return { ok: false, id, error: `unexpected field: ${key.slice(0, 40)}` };
  }
  for (const [name, check] of Object.entries(spec.params)) {
    const v = msg[name];
    if (v === null && check.nullable) {
      params[name] = null;
      continue;
    }
    if (v === undefined || v === null) {
      if (check.optional) continue;
      return { ok: false, id, error: `${name} is required` };
    }
    try {
      params[name] = check(v, name);
    } catch (e) {
      return { ok: false, id, error: e.message };
    }
  }

  if (msg.op === "ledger" && params.status !== undefined) {
    const allowed = STATUSES[params.table] || [];
    if (!allowed.includes(params.status)) return { ok: false, id, error: "status is not valid for that table" };
  }

  // ui-pages without pages or reset only reads the map: not a write, not audited.
  const mutating = msg.op === "ui-pages" ? params.pages !== undefined || !!params.reset : spec.mutating;
  return { ok: true, req: { id, op: msg.op, actor: msg.actor, params, mutating, ...(lane ? { lane } : {}) } };
}

/** Serialise a reply line. */
function reply(id, data) {
  return JSON.stringify({ id, ok: true, data }) + "\n";
}
function replyError(id, error) {
  return JSON.stringify({ id, ok: false, error: String(error).slice(0, 500) }) + "\n";
}

module.exports = { OPS, TABLES, WATCHERS, STATUSES, MAX_LINE, MAX_TEXT, ACTOR_RE, LANE_RE, parseRequest, reply, replyError };
