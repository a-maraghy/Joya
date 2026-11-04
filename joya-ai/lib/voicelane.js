"use strict";
/**
 * A live call's own small sessions ("voice lanes", 2026-10-30).
 *
 * Until then every request said in a live call was a turn of JOYA AI's main
 * conversation: on call lv1jz4g (2026-10-30) that meant 370-485k tokens read
 * from cache per turn, 31-39 s per answer (15 s for "what's on my screen"), the
 * first one $1.00 (the cache rebuilt after an idle hour), and a follow-up
 * ("I live in 6th of October") waiting 16 s behind the request it refined.
 *
 * Now a call gets its own CLI processes, each a FRESH session (--session-id, a
 * new uuid; ~40k tokens of charter and tools instead of the main context):
 *
 *   quick  claude-haiku-5-5 (voice_quick_model), tools: the weather (Open-Meteo,
 *          lib/weather.js via the MCP's quick set), WebSearch and WebFetch, and
 *          the long-term memory (search only). Its own short system prompt; no
 *          charter, no machine access. It answers in one to three sentences, or
 *          "ESCALATE" when the question turns out to need the machine.
 *   work   claude-sonnet-5 at medium effort (voice_lane_model / _effort) in
 *          JOYA AI's own directory: the same charter (CLAUDE.md), hooks (the
 *          gate, the ledger), MCP tools (missions, status, ui_do through the
 *          call's ui ticket, hiring, machines, ChatGPT) and memory, and the same
 *          --permission-prompt-tool stdio, so its approvals are the same cards.
 *          Up to voice_lane_max_work of them per call, for requests that run in
 *          parallel.
 *
 * Both are started when the call starts (op voice-warm), so the first request
 * does not wait for a CLI to come up, and kept for the call: follow-ups in the
 * same call go to the same session, and a request a lane did not see is told
 * in a short preface what this call asked and answered so far. A lane is closed
 * after voice_lane_idle_s without a turn -- unless a delegation it made is
 * still open (an agent's reply comes back to the session that asked).
 *
 * This file is the process and its stream: spawn, initialize, write a turn,
 * interrupt, parse every stdout line and hand it to the supervisor
 * (`onEvent(lane, ev)`). The bookkeeping -- the ledger rows, the events the
 * Command Center and the call follow, approvals, routing (lib/voiceroute.js),
 * folding a follow-up into the running request -- is the supervisor's
 * (supervisor.js "voice lanes"), where the main session's is.
 *
 * The lanes are named joya-internal-voice-<call>-<kind><n>, so the session
 * list never shows them (lib/targets.js isInternal), and their session ids
 * are JOYA AI's own for the cost scanner (state lane_sessions).
 */

const path = require("path");
const crypto = require("crypto");
const readline = require("readline");

const NAME_PREFIX = "joya-internal-voice-";

/** What every work lane is told on top of JOYA AI's charter. */
const WORK_PROMPT = [
  "You are JOYA AI, answering the administrator during a LIVE VOICE CALL, in a small fresh session of your own for this call (your main conversation runs separately; your long-term memory, tools, charter, gate and approval cards are the same).",
  "Be quick: answer what was asked, with the fewest tool calls that make it right. Lead with the answer in plain spoken sentences; a short list only when it truly helps. Your reply is read aloud as a detailed summary and shown in full on their screen.",
  "Messages may start with a note of what this call asked and answered before, and of the Joya page on their screen: use them as context, not as new requests.",
  "When another agent you sent something to replies, relay its answer to the administrator plainly and briefly, saying it is from that agent.",
].join("\n");

/** The quick lane's whole system prompt (it has no charter). */
const QUICK_PROMPT = [
  "You are JOYA AI, the assistant of this server's administrator, answering a QUICK spoken question during a live voice call. Speak in the first person.",
  "Answer in one to three short, plain spoken sentences, in the language of the question (Egyptian Arabic if they spoke Arabic). No lists, no markdown, no links.",
  "The current date and time come with each question. Use them for time and date questions.",
  "Weather: always call the weather tool, never guess. When no place is named, use the administrator's home area: the memory notes you are given say where they live (if they do not, use the memory search tool once; if it is still unknown, use Cairo and say so).",
  "Facts that change (news, prices, scores, schedules): use WebSearch. Stable general knowledge, conversions and arithmetic: answer directly and exactly.",
  "You cannot see or change this server, its services, files, logs, Odoo, sessions, agents, missions, approvals or the administrator's screen, and you know nothing about their work.",
  "If answering needs any of that, or you are unsure, reply with exactly the one word ESCALATE and nothing else.",
].join("\n");

const ESCALATE_RE = /^\s*\**ESCALATE\b/;

/** The memory MCP server as the administrator's own Claude config has it (~/.claude.json), or null. */
function memoryServer(home, fs) {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(home, ".claude.json"), "utf8"));
    const m = j && j.mcpServers && j.mcpServers.memory;
    if (m && m.command) return { type: "stdio", command: m.command, args: m.args || [], env: m.env || {} };
  } catch (_) {
    /* not there */
  }
  return null;
}

/**
 * The CLI arguments for a lane. o: { kind, name, sessionId, cfg, mcp: [argv for --mcp-config/--allowedTools], quickMcp }.
 * Pure (tested): what runs is decided here.
 */
function argvFor(o) {
  const c = o.cfg;
  const base = ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--replay-user-messages", "--include-partial-messages", "-n", o.name];
  if (o.kind === "quick") {
    return [
      ...base,
      "--model", c.voice_quick_model,
      "--permission-mode", "default",
      "--permission-prompt-tool", "stdio",
      // The memory hook (relevant memory with each question) comes from the user settings; nothing else is loaded.
      "--setting-sources", "user",
      "--tools", "WebSearch,WebFetch",
      "--strict-mcp-config",
      "--mcp-config", JSON.stringify({ mcpServers: o.quickMcp || {} }),
      "--allowedTools", "WebSearch", "WebFetch", ...Object.keys(o.quickMcp || {}).map((k) => (k === "memory" ? "mcp__memory__memory_search" : "mcp__" + k)),
      "--disallowedTools", "mcp__memory__memory_store", "mcp__memory__memory_forget", "mcp__memory__memory_session",
      "--system-prompt", QUICK_PROMPT,
      ...(Array.isArray(c.cli_extra_args) ? c.cli_extra_args.map(String) : []),
      "--session-id", o.sessionId,
    ];
  }
  return [
    ...base,
    "--model", c.voice_lane_model,
    "--effort", c.voice_lane_effort,
    "--permission-mode", c.permission_mode,
    "--permission-prompt-tool", "stdio",
    ...(o.mcp || []),
    "--append-system-prompt", WORK_PROMPT,
    ...(Array.isArray(c.cli_extra_args) ? c.cli_extra_args.map(String) : []),
    "--session-id", o.sessionId,
  ];
}

/** "[Now: Thu 30 Oct 2026, 14:28 (Africa/Cairo)]" for a quick question. */
function nowNote(ms, tz) {
  let s;
  try {
    s = new Intl.DateTimeFormat("en-GB", { timeZone: tz, weekday: "short", day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(ms));
  } catch (_) {
    s = new Date(ms).toISOString();
  }
  return `[Now: ${s} (${tz})]`;
}

/** "[Reply in English ...]" / "[Reply in Egyptian Arabic ...]": the language of the request's own words (notes aside). */
function langNote(text) {
  const words = String(text || "")
    .replace(/^\s*\[speaker:[^\]]*\]\s*/i, "")
    .replace(/\n\n\[[\s\S]*$/, "");
  const ar = (words.match(/[\u0600-\u06FF]/g) || []).length;
  const la = (words.match(/[A-Za-z]/g) || []).length;
  return ar > la / 2 ? "[Reply in Egyptian Arabic: the language of THIS request, whatever earlier turns used.]" : "[Reply in English: the language of THIS request, whatever earlier turns used.]";
}

/**
 * What this call asked and answered before, for a lane that did not see it (a parallel or new lane):
 * the last few exchanges, each answer clipped. `history`: [{ id, text, reply, running }] oldest first.
 */
function prefaceFor(history, seen, max) {
  const items = (history || []).filter((h) => h && !seen.has(h.id)).slice(-(max || 4));
  if (!items.length) return "";
  const clip = (s, n) => {
    const t = String(s || "").replace(/\s+/g, " ").trim();
    return t.length > n ? t.slice(0, n - 1) + "…" : t;
  };
  const lines = items.map((h) => `- They asked: "${clip(h.text, 300)}"` + (h.running ? " (still being answered separately)" : h.reply ? ` -- you answered: "${clip(h.reply, 400)}"` : ""));
  return "[Earlier in this voice call:]\n" + lines.join("\n") + "\n\n";
}

class LaneProc {
  /**
   * o: { id, call, kind, n, cfg, spawn, env, cwd, mcp, quickMcp, onEvent(lane, ev), onExit(lane, code, signal), log }
   */
  constructor(o) {
    this.id = o.id;
    this.call = o.call;
    this.kind = o.kind;
    this.n = o.n || 1;
    this.cfg = o.cfg;
    this.name = NAME_PREFIX + String(o.call).slice(0, 40) + "-" + o.kind + this.n;
    this.sessionId = crypto.randomUUID();
    this.model = o.kind === "quick" ? o.cfg.voice_quick_model : o.cfg.voice_lane_model;
    this.o = o;
    this.child = null;
    this.pid = null;
    this.state = "new"; // new -> starting -> ready -> closed
    this.startedAt = Date.now();
    this.lastAt = Date.now();
    this.running = null; // the supervisor's record of the running turn (lane glue)
    this.inflight = null; // { uuid, rowId, at }: written, not started yet
    this.byUuid = new Map(); // uuid -> { rowId, ignore? }
    this.toolSteps = new Map();
    this.seen = new Set(); // turn row ids of this call this lane has seen (prefaceFor)
    this.turns = 0;
    this.stderr = "";
    this.pendingControl = new Map();
    this.waitReady = [];
    this.procStamp = "lane:" + this.sessionId + "#new"; // its running cost starts from zero (lib/cost.js chains)
  }

  start() {
    if (this.child) return;
    const argv = argvFor({ kind: this.kind, name: this.name, sessionId: this.sessionId, cfg: this.cfg, mcp: this.o.mcp, quickMcp: this.o.quickMcp });
    this.state = "starting";
    let child;
    try {
      child = this.o.spawn(this.cfg.cli, argv, { cwd: this.o.cwd, env: this.o.env, stdio: ["pipe", "pipe", "pipe"] });
    } catch (e) {
      this.state = "closed";
      if (this.o.log) this.o.log(`voice lane ${this.id}: could not start: ${e.message}`);
      return this.flushReady(false);
    }
    this.child = child;
    this.pid = child.pid;
    child.stdin.on("error", () => {});
    child.stderr.on("data", (d) => (this.stderr = (this.stderr + d.toString()).slice(-3000)));
    const rl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
    rl.on("line", (line) => {
      let ev;
      try {
        ev = JSON.parse(line);
      } catch (_) {
        return;
      }
      this.lastAt = Date.now();
      if (ev.type === "control_response" && ev.response && this.pendingControl.has(ev.response.request_id)) {
        const cb = this.pendingControl.get(ev.response.request_id);
        this.pendingControl.delete(ev.response.request_id);
        return cb(ev.response);
      }
      try {
        this.o.onEvent(this, ev);
      } catch (e) {
        if (this.o.log) this.o.log(`voice lane ${this.id}: event handler failed: ${e.stack || e.message}`);
      }
    });
    child.on("exit", (code, signal) => {
      this.state = "closed";
      this.child = null;
      this.flushReady(false);
      for (const cb of this.pendingControl.values()) cb({ subtype: "error", error: "the lane ended" });
      this.pendingControl.clear();
      this.o.onExit(this, code, signal);
    });
    child.on("error", (e) => {
      if (this.o.log) this.o.log(`voice lane ${this.id}: ${e.message}`);
    });
    this.control({ subtype: "initialize" }, 60000)
      .then(() => {
        this.state = "ready";
        this.flushReady(true);
      })
      .catch((e) => {
        if (this.o.log) this.o.log(`voice lane ${this.id}: initialize failed: ${e.message}`);
        this.close();
      });
  }

  flushReady(ok) {
    const w = this.waitReady;
    this.waitReady = [];
    for (const f of w) f(ok);
  }

  /** Resolves true once the CLI answered initialize (false if it ended first). */
  ready() {
    if (this.state === "ready") return Promise.resolve(true);
    if (this.state === "closed") return Promise.resolve(false);
    return new Promise((r) => this.waitReady.push(r));
  }

  write(obj) {
    const c = this.child;
    if (!c || !c.stdin.writable) return false;
    c.stdin.write(JSON.stringify(obj) + "\n");
    return true;
  }

  control(request, timeoutMs) {
    const id = "lane-" + crypto.randomUUID();
    return new Promise((resolve, reject) => {
      if (!this.write({ type: "control_request", request_id: id, request })) return reject(new Error("the lane is not running"));
      const t = setTimeout(() => {
        this.pendingControl.delete(id);
        reject(new Error("no answer from the lane's CLI"));
      }, timeoutMs || 30000);
      if (t.unref) t.unref();
      this.pendingControl.set(id, (resp) => {
        clearTimeout(t);
        if (resp.subtype === "success") resolve(resp.response || {});
        else reject(new Error(resp.error || "refused"));
      });
    });
  }

  /** Hand the CLI one user message (uuid = ours, so its lifecycle events find the row). */
  sendTurn(uuid, rowId, content) {
    this.byUuid.set(uuid, { rowId });
    this.inflight = { uuid, rowId, at: Date.now() };
    this.turns++;
    this.lastAt = Date.now();
    return this.write({ type: "user", message: { role: "user", content }, parent_tool_use_id: null, session_id: "", uuid });
  }

  interrupt() {
    return this.control({ subtype: "interrupt" }, 15000);
  }

  busy() {
    return !!(this.running || this.inflight);
  }

  /** Close stdin (the CLI finishes its transcript), then make sure it goes. */
  close() {
    const c = this.child;
    if (!c) return;
    this.state = "closed";
    try {
      c.stdin.end();
    } catch (_) {
      /* closed */
    }
    setTimeout(() => {
      if (this.child === c) try { c.kill("SIGTERM"); } catch (_) { /* gone */ }
    }, 8000).unref();
    setTimeout(() => {
      if (this.child === c) try { c.kill("SIGKILL"); } catch (_) { /* gone */ }
    }, 12000).unref();
  }

  view() {
    return { id: this.id, call: this.call, kind: this.kind, model: this.model, state: this.state, pid: this.pid, busy: this.busy(), turns: this.turns, session_id: this.sessionId, started_at: new Date(this.startedAt).toISOString(), last_at: new Date(this.lastAt).toISOString() };
  }
}

module.exports = { LaneProc, argvFor, prefaceFor, nowNote, langNote, memoryServer, WORK_PROMPT, QUICK_PROMPT, ESCALATE_RE, NAME_PREFIX };
