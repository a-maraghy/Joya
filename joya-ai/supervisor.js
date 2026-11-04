"use strict";
/**
 * joya-ai: the supervisor that owns JOYA AI's Claude Code process.
 *
 * JOYA AI is one long-lived headless `claude -p` in stream-json mode, run as
 * root with HOME=/root so it shares root's session registry and can reach every
 * other Claude Code session on the box through peer messaging (ListAgents /
 * SendMessage). This process:
 *
 *   - spawns it, resumes its fixed session id only after the previous process
 *     has exited, and restarts it with backoff;
 *   - refuses to start while anything else holds that session id (a second
 *     process resuming a live session forks its transcript silently);
 *   - switches Remote Control on so the conversation is reachable from Claude
 *     Desktop and claude.ai;
 *   - answers the CLI's permission requests (can_use_tool) by raising Approve /
 *     Deny cards, and denies anything nobody answers in time;
 *   - keeps a ring buffer of events and a SQLite ledger of turns, delegations,
 *     replies, approvals and audit;
 *   - serves a narrow, validated JSON protocol on a unix socket that only root
 *     and the joyaai group can open (see lib/protocol.js);
 *   - takes ledger events from its hooks on a second, root-only socket;
 *   - runs a live call's requests in the call's own small, fresh CLI sessions
 *     ("voice lanes": lib/voicelane.js, routed by lib/voiceroute.js), with the
 *     same ledger rows, events, approvals and hooks as this one's turns.
 *
 * Runs as root under systemd (joya-ai.service). Never run two.
 */

const fs = require("fs");
const net = require("net");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const readline = require("readline");
const { spawn, execFile } = require("child_process");

const { Ledger, now } = require("./lib/ledger");
const protocol = require("./lib/protocol");
const classifier = require("./lib/classifier");
const rulesLib = require("./lib/rules");
const peers = require("./lib/peers");
const targets = require("./lib/targets");
const hireLib = require("./lib/hire");
const { redact, redactDeep, clip } = require("./lib/redact");
const { createFeatures } = require("./lib/features");
const { buildSnapshot } = require("./lib/snapshot");
const turnQueue = require("./lib/turnqueue");
const names = require("./lib/names");
const UiActions = require("./lib/ui-actions");
const JoyaWidgets = require("./lib/joya-widgets");
const planUsageLib = require("./lib/usage");
const settingsLib = require("./lib/settings");
const machinesLib = require("./lib/machines");
const { chatgptServer } = require("./lib/chatgpt");
const voiceRoute = require("./lib/voiceroute");
const voiceLane = require("./lib/voicelane");

/* ----------------------------------------------------------------- config --- */

const CONFIG_FILE = process.env.JOYA_AI_CONFIG || "/etc/joya-ai/config.json";

const DEFAULTS = {
  name: names.DISPLAY_NAME,
  cli: "/opt/joya-ai/cli/claude",
  cli_version: "2.1.283",
  model: "claude-opus-5-5",
  effort: "high",
  permission_mode: "auto",
  cwd: "/root/joya-ai",
  home: "/root",
  runtime_dir: "/run/user/0",
  state_dir: "/var/lib/joya-ai",
  log_dir: "/var/log/joya-ai",
  run_dir: "/run/joya-ai",
  socket_group: "joyaai",
  remote_control: true,
  approval_timeout_s: 300,
  delegation_allow: [],
  sessions_poll_s: 5,
  ring_size: 2000,
  backoff_min_s: 2,
  backoff_max_s: 120,
  // Compact the conversation once it reaches this many tokens (30% of the
  // 1M window). A long context made every turn slower and the first turn
  // after an idle hour cost ~$4; 0 leaves the CLI's own threshold.
  auto_compact_window: 300000,
  // Command Center v3, phase 1
  tz: "Africa/Cairo",
  helper: "/usr/local/sbin/joya-helper",
  odoo_log: "/var/log/odoo/odoo.log",
  watcher_poll_s: 30,
  watcher_cooldown_s: 1800,
  watcher_max_investigations_per_hour: 4,
  watcher_inject: false,
  orders_tick_s: 15,
  cost_scan_s: 60,
  mcp: true,
  // The turn queue (lib/turnqueue.js): user turns first, background after.
  queue_background_max_wait_s: 600, // a background turn waiting this long ranks with user turns
  queue_requeue_max_age_s: 21600, // after a supervisor restart, re-queue unsent turns younger than this
  queue_start_timeout_s: 120, // a handed-over turn that has not started by then, with nothing running, frees the queue
  voice_merge_s: 20, // a live call's request said again within this, while the first still waits in the queue: one turn
  // Voice lanes (lib/voicelane.js, 2026-10-30): a live call's requests run in small fresh sessions of its own.
  voice_lanes: true,
  voice_lane_model: "claude-sonnet-5",
  voice_lane_effort: "medium",
  voice_quick_model: "claude-haiku-5-5",
  voice_lane_max_work: 3, // work lanes per call (requests that run in parallel)
  voice_lane_idle_s: 900, // a lane with no turn for this long is closed (unless a delegation it made is still open)
  voice_lanes_max: 12, // lanes on the box at once; the oldest idle one goes first
  voice_fold_s: 45, // a follow-up while the call's request is this young (and has done nothing yet): asked once with both parts
  // The administrator's own names for agents, beside their session names (lib/voiceroute.js agentNames).
  voice_agent_aliases: {
    "[GSH] Planning Automation": ["planning automation", "giza odoo automation", "odoo automation", "gsh planning automation", "giza planning automation"],
    "JOYA Pace": ["joya pace", "جويا بيس"],
  },
  cli_extra_args: [], // tests only, e.g. ["--setting-sources", "project"]
  // Hired sessions (M-6): each runs as joya-session@<slug>.service (deploy/joya-session@.service).
  systemctl: "/usr/bin/systemctl",
  retire_consent_s: 3600, // how long JOYA AI's retire question waits for the administrator
};

function loadConfig() {
  let file = {};
  try {
    file = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
  } catch (e) {
    if (e.code !== "ENOENT") throw new Error(`cannot read ${CONFIG_FILE}: ${e.message}`);
  }
  const merged = { ...DEFAULTS, ...file };
  // The rename (JOYA AI -> JOYA AI, 2026-09-29): a config that still carries
  // an old name gets the new one, so the session is shown as JOYA AI even
  // before /etc/joya-ai/config.json is edited. Any other name is kept.
  if (names.OLD_NAMES.includes(merged.name)) merged.name = names.DISPLAY_NAME;
  return merged;
}

const cfg = loadConfig();
const CONTROL_SOCKET = path.join(cfg.run_dir, "joya-ai.sock");
const HOOK_SOCKET = path.join(cfg.run_dir, "hook.sock");
const LOCK_FILE = path.join(cfg.run_dir, "supervisor.pid");
const STATE_FILE = path.join(cfg.state_dir, "state.json");
const AUDIT_LOG = path.join(cfg.log_dir, "audit.log");
const SESSIONS_DIR = path.join(cfg.home, ".claude", "sessions");
const PROJECTS_DIR = path.join(cfg.home, ".claude", "projects");

const log = (...a) => console.log(new Date().toISOString(), ...a);
const warn = (...a) => console.error(new Date().toISOString(), "WARN", ...a);

/* ------------------------------------------------------------------ state --- */

function readState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  } catch (_) {
    return {};
  }
}
function writeState(patch) {
  const s = { ...readState(), ...patch };
  const tmp = STATE_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(s, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, STATE_FILE);
  return s;
}

/* ------------------------------------------------------------------- lock --- */

/**
 * One supervisor at a time. systemd already guarantees that for the unit; this
 * catches someone starting a second copy by hand, which would put two
 * processes on one session id -- the transcript fork this whole design avoids.
 */
function takeLock() {
  fs.mkdirSync(cfg.run_dir, { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(LOCK_FILE, "wx", 0o644);
      fs.writeSync(fd, String(process.pid));
      fs.closeSync(fd);
      return;
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
      const pid = Number(fs.readFileSync(LOCK_FILE, "utf8").trim());
      if (pid && pid !== process.pid && alive(pid) && /supervisor\.js/.test(cmdline(pid))) {
        throw new Error(`another supervisor is running (pid ${pid})`);
      }
      fs.unlinkSync(LOCK_FILE);
    }
  }
  throw new Error("could not take the lock");
}
function releaseLock() {
  try {
    if (Number(fs.readFileSync(LOCK_FILE, "utf8").trim()) === process.pid) fs.unlinkSync(LOCK_FILE);
  } catch (_) {
    /* gone already */
  }
}
function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM";
  }
}
function cmdline(pid) {
  try {
    return fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").replace(/\0/g, " ");
  } catch (_) {
    return "";
  }
}

/* ----------------------------------------------------------------- ledger --- */

fs.mkdirSync(cfg.state_dir, { recursive: true, mode: 0o700 });
fs.mkdirSync(cfg.log_dir, { recursive: true, mode: 0o750 });
const ledger = new Ledger(path.join(cfg.state_dir, "ledger.db"));

function auditLine(actor, op, detail, ok, error) {
  ledger.audit(actor, op, detail, ok, error);
  const line = `${now()} actor=${actor} op=${op} ok=${ok ? 1 : 0}${error ? " error=" + JSON.stringify(String(error).slice(0, 200)) : ""} ${detail ? JSON.stringify(detail).slice(0, 600) : ""}\n`;
  fs.appendFile(AUDIT_LOG, line, { mode: 0o640 }, () => {});
}

/* ----------------------------------------------------------------- events --- */

let seq = 0;
const ring = [];
const viewers = new Set();

/**
 * Publish one event to the connected viewers only: never into the ring, so a
 * reconnecting viewer can never replay it (UI control: "ui" events).
 */
function emitLive(type, data) {
  const line = JSON.stringify({ event: redactDeep({ seq: 0, ts: now(), type, ...data }) }) + "\n";
  for (const v of viewers) {
    if (v.destroyed) {
      viewers.delete(v);
      continue;
    }
    v.write(line);
  }
}

/** Publish one event to the ring buffer and every connected viewer. */
function emit(type, data) {
  const ev = redactDeep({ seq: ++seq, ts: now(), type, ...data });
  ring.push(ev);
  if (ring.length > cfg.ring_size) ring.splice(0, ring.length - cfg.ring_size);
  const line = JSON.stringify({ event: ev }) + "\n";
  for (const v of viewers) {
    if (v.destroyed) {
      viewers.delete(v);
      continue;
    }
    // A viewer that stops reading must not make the supervisor buffer forever.
    if (v.writableLength > 4 * 1024 * 1024) {
      v.destroy();
      viewers.delete(v);
      continue;
    }
    v.write(line);
  }
  return ev;
}

/* ----------------------------------------------------------- the process --- */

const proc = {
  child: null,
  state: "stopped", // starting | ready | stopping | backoff | stopped | blocked | error
  pid: null,
  startedAt: null,
  readyAt: null,
  restarts: 0,
  lastExit: null,
  lastStderr: "",
  backoff: cfg.backoff_min_s,
  timer: null,
  wantRunning: true,
  error: null,
  cliVersion: null,
  initSessionId: null,
  generation: 0,
};

/* UI control (see uiAction below): in memory only, never in the ledger or the ring. */
const UI_REFUSED_ACTORS = new Set(["joya-ai", "watcher", "supervisor", "flag-file", "scheduler", "order"]);
const UI_ACK_MS = 5000;
const UI_WIDGETS_PER_TURN = 3; // JOYA AI's ui_widget: widgets a turn (shown, and kept with its reply)
const uiTokens = new Map(); // turn id -> { ut, actor, source }
// A voice-desk turn's speaker as the voiceprint judged it ("command" | "other"): taking over a computer by voice needs "command".
const turnVp = new Map(); // turn id -> "command" | "other"
const uiWaiting = new Map(); // nonce -> { actor, resolve }
const uiLimit = UiActions.limiter();
const uiTag = (ut) => crypto.createHash("sha256").update(String(ut)).digest("hex").slice(0, 16);

const turns = {
  pending: [], // turns waiting their go: { row, message }. Handed to the CLI one at a time by pump().
  inflight: null, // { id, uuid, at }: handed to the CLI, not started yet
  byUuid: new Map(), // uuid -> turn row id
  running: null, // { id, uuid, source, text, started_at, steps: [] }
  toolSteps: new Map(), // tool_use_id -> step
};

const approvals = new Map(); // approval id -> { requestId, input, generation, timer, toolUseId, tool }
const requestToApproval = new Map(); // CLI request_id -> approval id

const rc = { enabled: false, url: null, bridgeSessionId: null, state: null, error: null };

let sessionsCache = { at: null, list: [], error: null };
let subagentsCache = new Map(); // session_id -> running sub-agents (see refreshSubagents)

function sessionId() {
  let s = readState();
  if (!s.session_id) s = writeState({ session_id: crypto.randomUUID(), created_at: now() });
  return s.session_id;
}

/**
 * Every session id JOYA AI has ever used: the current one, the ones retired by
 * a fresh start (session_history) and one the CLI made us adopt. Their
 * transcripts stay on disk; they are JOYA AI's own, so the cost scanner must
 * not count them as some other session's spend.
 */
function selfSessionIds() {
  const s = readState();
  const ids = new Set();
  if (s.session_id) ids.add(s.session_id);
  if (s.previous_session_id) ids.add(s.previous_session_id);
  for (const h of Array.isArray(s.session_history) ? s.session_history : []) if (h && h.session_id) ids.add(h.session_id);
  for (const id of Array.isArray(s.lane_sessions) ? s.lane_sessions : []) if (id) ids.add(id); // voice lanes (lib/voicelane.js)
  return ids;
}

/** The one-shot flag file: `touch` it and the next start is a fresh session. */
const FRESH_FLAG = path.join(cfg.state_dir, "fresh-start");

/**
 * Retire the current session id and pick a new one, so the next start runs
 * `--session-id <new>`. The old transcript is left where it is; the old id is
 * kept in session_history so it can be traced and is never resumed.
 */
function rotateSession(actor, reason) {
  const s = readState();
  const old = s.session_id || null;
  let id = crypto.randomUUID();
  while (id === old) id = crypto.randomUUID();
  const at = now();
  const history = Array.isArray(s.session_history) ? s.session_history.slice(-49) : [];
  if (old) history.push({ session_id: old, created_at: s.created_at || null, retired_at: at, retired_by: actor, reason: reason || null, next_session_id: id });
  writeState({ session_id: id, created_at: at, created_by: actor, previous_session_id: old, session_history: history, rc: null, last_init: null });
  auditLine(actor, "session-rotate", { old_session_id: old, new_session_id: id, reason: reason || null }, true);
  log(`fresh session: ${old || "(none)"} -> ${id} (${actor}${reason ? ": " + reason : ""})`);
  emit("notice", { level: "warn", text: `Fresh session started by ${actor}` });
  return { old_session_id: old, new_session_id: id, at };
}

/** Honour the flag file, once. */
function takeFreshFlag() {
  let text;
  try {
    text = fs.readFileSync(FRESH_FLAG, "utf8");
  } catch (_) {
    return null;
  }
  try {
    fs.unlinkSync(FRESH_FLAG);
  } catch (e) {
    // A flag we cannot remove would rotate on every start: refuse it instead.
    warn(`cannot remove ${FRESH_FLAG}: ${e.message}; ignoring it`);
    return null;
  }
  return rotateSession("flag-file", clip(String(text).trim(), 300) || "fresh-start flag file");
}

function transcriptExists(id) {
  try {
    for (const dir of fs.readdirSync(PROJECTS_DIR)) {
      if (fs.existsSync(path.join(PROJECTS_DIR, dir, id + ".jsonl"))) return true;
    }
  } catch (_) {
    /* no projects dir yet */
  }
  return false;
}

/**
 * Who else holds this session id right now? A live registry entry, or any
 * process whose command line names it. Resuming while either exists would fork
 * the transcript.
 */
function holdersOf(id) {
  const holders = [];
  try {
    for (const f of fs.readdirSync(SESSIONS_DIR)) {
      if (!f.endsWith(".json")) continue;
      try {
        const r = JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR, f), "utf8"));
        if (r.sessionId === id && r.pid && alive(r.pid) && r.pid !== (proc.child && proc.child.pid)) holders.push(r.pid);
      } catch (_) {
        /* half-written registry file */
      }
    }
  } catch (_) {
    /* no registry */
  }
  try {
    for (const p of fs.readdirSync("/proc")) {
      if (!/^\d+$/.test(p)) continue;
      const pid = Number(p);
      if (pid === process.pid || (proc.child && pid === proc.child.pid)) continue;
      const cl = cmdline(pid);
      if (cl.includes(id) && /claude/.test(cl) && !holders.includes(pid)) holders.push(pid);
    }
  } catch (_) {
    /* no /proc? */
  }
  return holders;
}

function childEnv() {
  const env = {
    PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
    HOME: cfg.home,
    USER: "root",
    LOGNAME: "root",
    SHELL: "/bin/bash",
    LANG: process.env.LANG || "C.UTF-8",
    TERM: "dumb",
    TZ: process.env.TZ || "Africa/Cairo",
    DISABLE_AUTOUPDATER: "1",
    JOYA_AI_SUPERVISED: "1",
    JOYA_AI_HOOK_SOCKET: HOOK_SOCKET,
    JOYA_AI_CONFIG: CONFIG_FILE,
    JOYA_AI_SOCKET: CONTROL_SOCKET,
  };
  if (Number(cfg.auto_compact_window) > 0) env.CLAUDE_CODE_AUTO_COMPACT_WINDOW = String(Math.round(cfg.auto_compact_window));
  if (cfg.runtime_dir && fs.existsSync(cfg.runtime_dir)) env.XDG_RUNTIME_DIR = cfg.runtime_dir;
  // Deliberately built from nothing: an inherited CLAUDE_CODE_MESSAGING_SOCKET
  // or session variable would make the child think it is someone else's
  // subprocess, and CLAUDE_CONFIG_DIR would move it out of root's registry
  // where no other session can see it.
  return env;
}

function checkCli() {
  return new Promise((resolve) => {
    execFile(cfg.cli, ["--version"], { timeout: 20000, env: childEnv() }, (err, stdout) => {
      if (err) return resolve({ ok: false, error: `cannot run ${cfg.cli}: ${err.message}` });
      const v = String(stdout).trim().split(/\s+/)[0];
      if (cfg.cli_version && v !== cfg.cli_version)
        return resolve({ ok: false, version: v, error: `CLI is ${v}, pinned ${cfg.cli_version}. Re-verify peer messaging, Remote Control and can_use_tool on ${v}, then update cli_version in ${CONFIG_FILE}.` });
      resolve({ ok: true, version: v });
    });
  });
}

/**
 * JOYA AI's own tools (missions, decisions, status_snapshot, ui_actions_list, ui_do) as a
 * stdio MCP server, bin/joya-ai-mcp, registered as "joya-ai" (its tools are
 * mcp__joya-ai__*; "joya-ai" until 2026-09-30 -- renamed so a resumed session
 * discovers the tools fresh instead of reusing a schema it recorded earlier).
 * It talks to this supervisor's control socket as actor "joya-ai" (unchanged).
 * Its tools are allowed outright: they record JOYA AI's own plans and
 * proposals, read the snapshot, or ask for a checked screen action.
 */
const MCP_NAME = "joya-ai";
function mcpArgs(laneId) {
  const servers = {};
  const allow = [];
  const server = path.join(__dirname, "bin", "joya-ai-mcp");
  if (cfg.mcp && fs.existsSync(server)) {
    // A voice lane's server names its lane on every call (bin/joya-ai-mcp JOYA_AI_LANE).
    servers[MCP_NAME] = { type: "stdio", command: process.execPath, args: [server], env: { JOYA_AI_SOCKET: CONTROL_SOCKET, ...(laneId ? { JOYA_AI_LANE: laneId } : {}) } };
    allow.push("mcp__" + MCP_NAME);
  }
  // ask_chatgpt (lib/chatgpt.js): ChatGPT through the Joya broker, only when the administrator asks.
  const gpt = chatgptServer(cfg, "joya-ai", path.join(cfg.cwd, "chatgpt"));
  if (gpt) {
    servers[gpt.name] = gpt.server;
    allow.push(gpt.allow);
  }
  if (!allow.length) return [];
  return ["--mcp-config", JSON.stringify({ mcpServers: servers }), "--allowedTools", ...allow];
}

function setState(state, extra = {}) {
  proc.state = state;
  emit("proc", { state, pid: proc.pid, restarts: proc.restarts, ...extra });
}

async function start() {
  clearTimeout(proc.timer);
  proc.timer = null;
  if (!proc.wantRunning || proc.child) return;

  const cli = await checkCli();
  proc.cliVersion = cli.version || null;
  if (!cli.ok) {
    proc.error = cli.error;
    warn(cli.error);
    setState("error", { error: cli.error });
    return scheduleRestart(true);
  }

  takeFreshFlag();
  const id = sessionId();
  const holders = holdersOf(id);
  if (holders.length) {
    proc.error = `session ${id} is held by pid ${holders.join(", ")}; not starting a second copy`;
    warn(proc.error);
    setState("blocked", { error: proc.error, holders });
    return scheduleRestart(true);
  }

  const retired = (readState().session_history || []).some((h) => h && h.session_id === id);
  if (retired) {
    proc.error = `session ${id} was retired by a fresh start; refusing to resume it`;
    warn(proc.error);
    setState("error", { error: proc.error });
    return scheduleRestart(true);
  }
  const resume = transcriptExists(id);
  proc.newSession = !resume; // a resumed session carries its running cost on; a new one starts from zero (lib/cost.js)
  const argv = [
    "-p",
    "--input-format", "stream-json",
    "--output-format", "stream-json",
    "--verbose",
    "--replay-user-messages",
    "--include-partial-messages",
    "-n", cfg.name,
    "--model", cfg.model,
    "--effort", cfg.effort,
    "--permission-mode", cfg.permission_mode,
    "--permission-prompt-tool", "stdio",
    ...mcpArgs(),
    ...(Array.isArray(cfg.cli_extra_args) ? cfg.cli_extra_args.map(String) : []),
    ...(resume ? ["--resume", id] : ["--session-id", id]),
  ];

  proc.error = null;
  proc.generation++;
  const gen = proc.generation;
  log(`starting ${cfg.cli} (${proc.cliVersion}) ${resume ? "resuming" : "new session"} ${id}`);
  let child;
  try {
    child = spawn(cfg.cli, argv, { cwd: cfg.cwd, env: childEnv(), stdio: ["pipe", "pipe", "pipe"] });
  } catch (e) {
    proc.error = e.message;
    setState("error", { error: e.message });
    return scheduleRestart(true);
  }
  proc.child = child;
  proc.pid = child.pid;
  proc.startedAt = now();
  proc.readyAt = null;
  proc.lastStderr = "";
  proc.initSessionId = null;
  setState("starting", { resume });

  child.stdin.on("error", () => {});
  child.stderr.on("data", (d) => {
    proc.lastStderr = (proc.lastStderr + d.toString()).slice(-4000);
  });
  const rl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
  rl.on("line", (line) => {
    if (gen !== proc.generation) return;
    let ev;
    try {
      ev = JSON.parse(line);
    } catch (_) {
      return;
    }
    try {
      onEvent(ev);
    } catch (e) {
      warn("event handler failed:", e.stack || e.message);
    }
  });

  child.on("exit", (code, signal) => onExit(gen, code, signal));
  child.on("error", (e) => {
    proc.error = e.message;
    warn("child error:", e.message);
  });

  writeChild({ type: "control_request", request_id: "init-" + gen, request: { subtype: "initialize" } });
}

function onExit(gen, code, signal) {
  if (gen !== proc.generation) return;
  const ranFor = proc.startedAt ? Date.now() - Date.parse(proc.startedAt) : 0;
  proc.lastExit = { code, signal, at: now(), stderr: proc.lastStderr.slice(-1500) };
  log(`claude exited code=${code} signal=${signal} after ${Math.round(ranFor / 1000)}s`);
  if (code && proc.lastStderr) warn("stderr:", proc.lastStderr.slice(-1500));
  proc.child = null;
  proc.pid = null;
  rc.enabled = false;
  rc.state = null;
  emit("rc", { enabled: false });

  // Whatever was waiting on this process is over (a hired session's questions and retire questions are not its).
  for (const [aid, a] of approvals) {
    if (a.kind || a.lane) continue; // a hired session's or a voice lane's question is not this process's
    clearTimeout(a.timer);
    const row = ledger.updateApproval(aid, { status: "cancelled", decided_at: now(), note: "JOYA AI's process ended before an answer" });
    approvals.delete(aid);
    emit("approval", { approval: publicApproval(row) });
  }
  requestToApproval.clear();
  if (turns.running) {
    const row = ledger.updateTurn(turns.running.id, { status: "lost", ended_at: now(), error: "process exited mid-turn" });
    emit("turn", { phase: "end", turn: publicTurn(row) });
    uiTokens.delete(turns.running.id);
    turns.running = null;
    features.hooks.onTurnEnd(row);
  }
  // Turns written to the old process but not yet started would be lost with
  // it; they were never answered, so re-queue them for the next process.
  clearInflight();
  for (const [uuid, tid] of turns.byUuid) {
    const row = ledger.get("turns", tid);
    if (row && row.status === "queued" && OUR_SOURCES.has(row.source)) {
      turns.pending.push({ row: ledger.updateTurn(row.id, { sent_at: null }), message: userMessage(row) });
    }
    turns.byUuid.delete(uuid);
  }

  if (ranFor > 5 * 60 * 1000) proc.backoff = cfg.backoff_min_s;
  if (!proc.wantRunning) return setState("stopped", { code, signal });
  proc.restarts++;
  setState("backoff", { code, signal, retry_in_s: proc.backoff });
  scheduleRestart(false);
}

function scheduleRestart(isError) {
  clearTimeout(proc.timer);
  if (!proc.wantRunning) return;
  const wait = proc.backoff;
  proc.backoff = Math.min(cfg.backoff_max_s, proc.backoff * 2);
  proc.timer = setTimeout(() => start().catch((e) => warn("start failed:", e.message)), wait * 1000);
  if (isError) emit("proc", { state: proc.state, retry_in_s: wait, error: proc.error });
}

/** Close stdin and let the CLI exit on its own, so it finishes its transcript. */
function stopChild(timeoutMs = 15000) {
  return new Promise((resolve) => {
    const child = proc.child;
    if (!child) return resolve();
    setState("stopping");
    const done = () => resolve();
    child.once("exit", done);
    try {
      child.stdin.end();
    } catch (_) {
      /* already closed */
    }
    setTimeout(() => {
      if (proc.child === child) {
        try {
          child.kill("SIGTERM");
        } catch (_) {
          /* gone */
        }
      }
    }, timeoutMs).unref();
    setTimeout(() => {
      if (proc.child === child) {
        try {
          child.kill("SIGKILL");
        } catch (_) {
          /* gone */
        }
      }
    }, timeoutMs + 5000).unref();
  });
}

function writeChild(obj) {
  const child = proc.child;
  if (!child || !child.stdin.writable) return false;
  child.stdin.write(JSON.stringify(obj) + "\n");
  return true;
}

function userMessage(row) {
  let content = row.text;
  if (row.source === "voice-desk") {
    content =
      `${content}\n\n` +
      `[Dashboard: the administrator said this aloud and the voice front desk passed it on. ` +
      `The desk will read them a short spoken summary of your reply, held to what you wrote; the full text stays on their screen. ` +
      `So say plainly what happened, what did not, and anything that needs their approval or answer.]`;
  }
  if (row.target) {
    content =
      `${content}\n\n` +
      `[Dashboard: the administrator addressed this to the session named "${row.target}". ` +
      `Delegate it there unless it is plainly something you should answer yourself.]`;
  }
  return { type: "user", message: { role: "user", content }, parent_tool_use_id: null, session_id: "", uuid: row.uuid };
}

/** Turns this supervisor wrote itself: their replayed text is already recorded. */
const OUR_SOURCES = new Set(["dashboard", "voice-desk", "order", "watcher", "mission-request", "decision", "cap-held", "machine"]);

/**
 * Queue a turn for JOYA AI. The supervisor holds the queue and hands the CLI
 * one turn at a time, user turns before background ones (lib/turnqueue.js).
 * Nothing here ever interrupts a running turn.
 */
function queueTurn({ source, actor, text, target, order_id, mission_id, decision_id, ut, call, vp }) {
  // A live call's request runs in the call's own small session (voice lanes, below), not in this queue.
  if (source === "voice-desk" && call && !target) {
    const t = voiceLaneTurn({ actor, text, ut, call, vp });
    if (t) return t;
  }
  const merged = call ? mergeVoiceTurn({ actor, text, target, ut, call, vp }) : null;
  if (merged) return merged;
  const row = ledger.addTurn({ uuid: crypto.randomUUID(), source, actor, text, target: target || null, status: "queued", order_id, mission_id, decision_id });
  // The ui token lives here only (memory): never in the ledger, the events or the audit.
  if (ut && (source === "dashboard" || source === "voice-desk") && !UI_REFUSED_ACTORS.has(actor)) {
    uiTokens.set(row.id, { ut, actor, source });
    if (uiTokens.size > 200) uiTokens.delete(uiTokens.keys().next().value);
  }
  if (source === "voice-desk") {
    turnVp.set(row.id, vp === "command" ? "command" : "other");
    if (turnVp.size > 200) turnVp.delete(turnVp.keys().next().value);
  }
  turns.pending.push({ row, message: userMessage(row), call: call || null, lastAt: Date.now() });
  emit("turn", { phase: "queued", turn: publicTurn(row) });
  pump();
  return publicTurn(row);
}

/**
 * A live call's request said again (or added to) while its first one is still
 * waiting in the queue -- not yet handed to the CLI -- within voice_merge_s of
 * the last: folded into that turn, so JOYA AI answers once and the voice does
 * not read two answers back to back. Returns the turn (merged: true), or null.
 */
function mergeVoiceTurn({ actor, text, target, ut, call, vp }) {
  const within = (cfg.voice_merge_s || 0) * 1000;
  if (!within) return null;
  const p = turns.pending.find((q) => q.call === call && q.row.source === "voice-desk" && q.row.actor === actor && (q.row.target || null) === (target || null) && Date.now() - q.lastAt <= within);
  if (!p) return null;
  const joined = clip(p.row.text + "\n\n[Said again while this was waiting:] " + text, 20000);
  p.row = ledger.updateTurn(p.row.id, { text: joined });
  p.message = userMessage(p.row);
  p.lastAt = Date.now();
  p.merges = (p.merges || 0) + 1;
  if (ut && !uiTokens.has(p.row.id) && !UI_REFUSED_ACTORS.has(actor)) uiTokens.set(p.row.id, { ut, actor, source: "voice-desk" });
  // A merged turn may command only if every part of it came from someone who may give commands.
  if (vp !== "command") turnVp.set(p.row.id, "other");
  log(`queue: a repeat from live call ${call} folded into queued turn #${p.row.id} (${p.merges} so far)`);
  emit("turn", { phase: "merged", turn: publicTurn(p.row) });
  return { ...publicTurn(p.row), merged: true };
}

/* ------------------------------------------------------------ voice lanes --- */
/*
 * A live call's requests run in small, fresh sessions of the call's own (lib/voicelane.js has the why
 * and the processes; lib/voiceroute.js decides where each request goes). Here is their bookkeeping, the
 * same as the main session's: a ledger row per request (source voice-desk, call_id, lane), the events the
 * Command Center and the call follow (turn / text / assistant / tool / steps / result, with the row's id),
 * approvals as cards (answered on the lane's own stdin), the hooks' delegation records attributed to the
 * lane's running turn, screen actions through the request's ui ticket (the lane's MCP names its lane), and
 * each lane's cost as a chain of its own (proc_start "lane:<session>#new").
 *
 *   - quick  -> the call's quick lane; "ESCALATE" -> the same row goes to a work lane.
 *   - work   -> an idle work lane of the call (up to voice_lane_max_work, then the oldest queues it).
 *   - agent  -> a work lane told to hand the request straight to that session (SendMessage) and relay the
 *              reply; the reply arrives as the lane's own turn (source peer, `follows` the request), which
 *              the call reads out (dashboard) or the Command Center shows when the call is over.
 *   - a follow-up while the call's request is young and has done nothing yet (lib/voiceroute.js foldable):
 *     the running turn is stopped and asked once with both parts, under the same row -- one answer, no
 *     wait in line (call lv1jz4g: "I live in 6th of October" waited 16 s behind "the weather today").
 *     Otherwise it runs in parallel in another lane, told what this call asked so far.
 * Off (voice_lanes false), paused at the token cap, or a lane that cannot start: the request goes to the
 * main queue exactly as before.
 */
const lanes = new Map(); // lane id -> LaneProc
const callLanes = new Map(); // call id -> { lanes: [LaneProc], history: [{ id, text, reply, running }], actor, lastAt }
const laneBySession = new Map(); // session id -> LaneProc
let laneSeq = 0;
let ctxLane = undefined; // the lane a control-socket request or a hook event comes from, while it is handled

function lanesOn() {
  return !!cfg.voice_lanes;
}
/** Run fn with `lane` as the context (its running turn is "the" running turn for it); returns fn's result. */
function withLane(lane, fn) {
  const prev = ctxLane;
  ctxLane = lane;
  try {
    return fn();
  } finally {
    ctxLane = prev;
  }
}
/** The running turn a request or hook belongs to: its lane's (null when that lane runs none), else the main one. */
function runningTurn() {
  if (ctxLane !== undefined) return ctxLane ? ctxLane.running && !ctxLane.running.ignored ? ctxLane.running : null : null;
  return turns.running;
}
function callFor(call) {
  let C = callLanes.get(call);
  if (!C) {
    C = { lanes: [], history: [], actor: null, lastAt: Date.now() };
    callLanes.set(call, C);
  }
  return C;
}
function agentList() {
  let hired = [];
  try {
    hired = ledger.hiredList(false);
  } catch (_) {
    hired = [];
  }
  return voiceRoute.agentNames(sessionsCache.list || [], hired, cfg.voice_agent_aliases || {});
}
function quickDir() {
  const d = path.join(cfg.state_dir, "voice-quick");
  fs.mkdirSync(d, { recursive: true, mode: 0o700 });
  return d;
}
function quickMcp(laneId) {
  const servers = {};
  const server = path.join(__dirname, "bin", "joya-ai-mcp");
  if (cfg.mcp && fs.existsSync(server)) servers["joya-quick"] = { type: "stdio", command: process.execPath, args: [server], env: { JOYA_AI_SOCKET: CONTROL_SOCKET, JOYA_AI_MCP_SET: "quick", JOYA_AI_LANE: laneId } };
  const mem = voiceLane.memoryServer(cfg.home, fs);
  if (mem) servers.memory = mem;
  return servers;
}
/** Lane session ids are JOYA AI's own (the cost scanner must not count them as another session's spend). */
function rememberLaneSession(id) {
  const s = readState();
  const list = (Array.isArray(s.lane_sessions) ? s.lane_sessions : []).concat([id]).slice(-300);
  writeState({ lane_sessions: list });
}

function spawnLane(call, kind) {
  const C = callFor(call);
  // Too many on the box: the oldest idle lane of any call goes first.
  const live = [...lanes.values()].filter((l) => l.state !== "closed");
  if (live.length >= cfg.voice_lanes_max) {
    const idle = live.filter((l) => !l.busy() && !laneHoldsDelegation(l)).sort((a, b) => a.lastAt - b.lastAt)[0];
    if (!idle) return null;
    closeLane(idle, "the box's lane limit");
  }
  const n = C.lanes.filter((l) => l.kind === kind).length + 1;
  const id = "v" + (++laneSeq).toString(36) + "-" + String(call).slice(2, 20);
  const lane = new voiceLane.LaneProc({
    id,
    call,
    kind,
    n,
    cfg,
    spawn,
    env: { ...childEnv(), JOYA_INTERNAL: "1" },
    cwd: kind === "quick" ? quickDir() : cfg.cwd,
    mcp: kind === "quick" ? null : mcpArgs(id),
    quickMcp: kind === "quick" ? quickMcp(id) : null,
    onEvent: onLaneEvent,
    onExit: onLaneExit,
    log: warn,
  });
  lane.delegs = new Set();
  lanes.set(id, lane);
  C.lanes.push(lane);
  laneBySession.set(lane.sessionId, lane);
  rememberLaneSession(lane.sessionId);
  lane.start();
  log(`voice lane ${id} started for call ${call}: ${kind}, ${lane.model}, session ${lane.sessionId}`);
  emit("lane", { lane: lane.view(), phase: "start" });
  return lane;
}

function closeLane(lane, why) {
  if (lane.state === "closed" && !lane.child) return;
  log(`voice lane ${lane.id} closed (${why})`);
  lane.close();
}

/** An idle lane of the call for this kind, else a new one, else (all busy, at the limit) the one idle longest. */
function laneFor(call, kind) {
  const C = callFor(call);
  const mine = C.lanes.filter((l) => l.kind === kind && l.state !== "closed");
  const idle = mine.find((l) => !l.busy() && !l.pendingDispatch);
  if (idle) return idle;
  const max = kind === "quick" ? 2 : Math.max(1, cfg.voice_lane_max_work);
  if (mine.length < max) {
    const l = spawnLane(call, kind);
    if (l) return l;
  }
  return mine.sort((a, b) => a.lastAt - b.lastAt)[0] || null;
}

/** Was a delegation this lane made answered or closed? Open ones keep the lane (the reply comes back to it). */
function laneHoldsDelegation(lane) {
  for (const id of lane.delegs || []) {
    const d = ledger.get("delegations", id);
    if (d && ["sent", "working", "held"].includes(d.status) && Date.now() - Date.parse(d.created_at) < 30 * 60 * 1000) return true;
  }
  return false;
}

/** The op voice-warm: the call's quick lane and one work lane, started ahead of its first request. */
function voiceWarm(actor, p) {
  if (!lanesOn() || features.caps.selfPaused()) return { warmed: false, lanes: [] };
  const C = callFor(p.call);
  C.actor = C.actor || actor;
  C.lastAt = Date.now();
  for (const kind of ["quick", "work"]) if (!C.lanes.some((l) => l.kind === kind && l.state !== "closed")) spawnLane(p.call, kind);
  return { warmed: true, lanes: C.lanes.filter((l) => l.state !== "closed").map((l) => l.view()) };
}

/**
 * A live call's request (queueTurn, voice-desk with a call id). Returns the public turn, { merged: true }
 * when it was folded into the call's running request, or null to leave it to the main queue.
 */
function voiceLaneTurn({ actor, text, ut, call, vp }) {
  if (!lanesOn() || !call || features.caps.selfPaused()) return null;
  const C = callFor(call);
  C.actor = C.actor || actor;
  C.lastAt = Date.now();
  // D: a follow-up while this call's request is just starting.
  const fold = foldTarget(call, actor);
  if (fold) return foldInto(fold, { actor, text, ut, vp });
  const route = voiceRoute.classify(text, { agents: agentList() });
  const row = ledger.addTurn({ uuid: crypto.randomUUID(), source: "voice-desk", actor, text, target: route.agent ? route.agent.name : null, status: "queued" });
  ledger.updateTurn(row.id, { call_id: call, lane: route.lane, voice_actor: actor });
  if (ut && !UI_REFUSED_ACTORS.has(actor)) {
    uiTokens.set(row.id, { ut, actor, source: "voice-desk" });
    if (uiTokens.size > 200) uiTokens.delete(uiTokens.keys().next().value);
  }
  turnVp.set(row.id, vp === "command" ? "command" : "other");
  if (turnVp.size > 200) turnVp.delete(turnVp.keys().next().value);
  C.history.push({ id: row.id, text, reply: null, running: true });
  if (C.history.length > 20) C.history.shift();
  log(`voice: call ${call} request #${row.id} -> ${route.lane}${route.agent ? " (" + route.agent.name + ")" : ""} (${route.why})`);
  const fresh = ledger.get("turns", row.id);
  emit("turn", { phase: "queued", turn: publicTurn(fresh) });
  dispatchLane(fresh, route);
  return publicTurn(fresh);
}

/** The running request of this call a follow-up may fold into (foldable), with its lane; else null. */
function foldTarget(call, actor) {
  if (!(cfg.voice_fold_s > 0)) return null;
  const C = callLanes.get(call);
  if (!C) return null;
  for (const lane of C.lanes) {
    const r = lane.running;
    if (!r || r.ignored || r.actor !== actor) continue;
    const f = voiceRoute.foldable(r, { call, now: Date.now(), maxMs: cfg.voice_fold_s * 1000 });
    if (f.ok) return { lane, r };
  }
  return null;
}

/**
 * Fold a follow-up into the call's running request: that turn is stopped (its partial work is dropped:
 * it has written nothing and changed nothing) and the request is asked again with both parts, under the
 * same ledger row -- re-routed as a whole (the weather plus "I live in 6th of October" is still quick).
 */
function foldInto({ lane, r }, { actor, text, ut, vp }) {
  const row = ledger.get("turns", r.id);
  const joined = clip(voiceRoute.foldedText(row.text, text), 20000);
  const upd = ledger.updateTurn(row.id, { text: joined });
  r.folding = true;
  if (ut && !uiTokens.has(row.id) && !UI_REFUSED_ACTORS.has(actor)) uiTokens.set(row.id, { ut, actor, source: "voice-desk" });
  if (vp !== "command") turnVp.set(row.id, "other");
  const C = callFor(lane.call);
  const h = C.history.find((x) => x.id === row.id);
  if (h) h.text = joined;
  const entry = lane.byUuid.get(r.uuid);
  if (entry) entry.ignore = true;
  r.ignored = true;
  const route = voiceRoute.classify(joined, { agents: agentList() });
  ledger.updateTurn(row.id, { lane: route.lane, target: route.agent ? route.agent.name : null });
  log(`voice: call ${lane.call} folded a follow-up into request #${row.id} (it had run ${Math.round((Date.now() - r.startedMs) / 100) / 10} s, nothing written); asked again as one -> ${route.lane}`);
  let sent = false;
  const go = () => {
    if (sent) return;
    sent = true;
    dispatchLane(ledger.get("turns", row.id), route);
  };
  lane.afterIdle = go;
  lane.interrupt().catch((e) => warn(`voice lane ${lane.id}: interrupt for a fold failed: ${e.message}`));
  // Should the interrupted turn not end promptly, the merged request goes on anyway (another lane).
  setTimeout(() => {
    if (!sent) {
      if (lane.afterIdle === go) lane.afterIdle = null;
      go();
    }
  }, 6000).unref();
  emit("turn", { phase: "merged", turn: publicTurn(upd) });
  return { ...publicTurn(ledger.get("turns", row.id)), merged: true };
}

/** What a lane is handed for this row: what this call asked before (if it did not see it), the request, its notes. */
function laneMessage(lane, row, route) {
  const C = callFor(lane.call);
  const preface = voiceLane.prefaceFor(C.history.filter((h) => h.id !== row.id), lane.seen, 4);
  for (const h of C.history) lane.seen.add(h.id);
  // The language they spoke (the quick model answered an English question in Arabic on 2026-10-30, taking
  // the administrator's Egyptian Arabic from memory): said with every message.
  const lang = voiceLane.langNote(row.text);
  if (lane.kind === "quick") return `${voiceLane.nowNote(Date.now(), cfg.tz)}\n${preface}${row.text}\n\n${lang}`;
  let content = preface + row.text;
  content +=
    `\n\n[Dashboard: the administrator said this aloud in a live call. Your reply is read to them as a detailed spoken summary, held to what you wrote, and shown in full on their screen. ` +
    `So say plainly what happened, what did not, and anything that needs their approval or answer.]`;
  if (route && route.lane === "agent" && route.agent) {
    const nm = route.agent.name;
    lane.lastAgent = { turn: row.id, name: nm };
    content +=
      `\n\n[Voice routing: the administrator is asking the agent "${nm}" for this. Hand it straight to that session: ListAgents if you need its address, then SendMessage to it with notify_when_idle: true -- ` +
      `their request in their words, plus only what it needs to act. Do not do the work yourself and do not pass it to anyone else. Then reply in one or two sentences: that it went to ${nm} and what you asked. ` +
      `When ${nm} replies, relay its answer plainly, saying it is from ${nm}.]`;
  }
  return content + "\n\n" + lang; // last, so it outweighs the language of earlier turns in this session
}

/** Hand a row to a lane of its kind (when the lane is up); a lane that cannot start leaves it to the main queue. */
function dispatchLane(row, route) {
  const kind = route.lane === "quick" ? "quick" : "work";
  const lane = laneFor(row.call_id, kind);
  if (!lane) return toMainQueue(row, "no lane could start");
  lane.pendingDispatch = (lane.pendingDispatch || 0) + 1;
  lane.ready().then((ok) => {
    lane.pendingDispatch--;
    if (!ok || lane.state !== "ready") return toMainQueue(row, `lane ${lane.id} did not start`);
    const uuid = crypto.randomUUID();
    const content = laneMessage(lane, row, route);
    if (!lane.sendTurn(uuid, row.id, content)) return toMainQueue(row, `lane ${lane.id} would not take it`);
    ledger.updateTurn(row.id, { sent_at: now() });
  });
}

/** The fallback: the row goes to JOYA AI's main queue, as every voice request did before the lanes. */
function toMainQueue(row, why) {
  warn(`voice: request #${row.id} goes to the main queue: ${why}`);
  const r = ledger.updateTurn(row.id, { lane: "main", status: "queued", sent_at: null });
  turns.pending.push({ row: r, message: userMessage(r), call: r.call_id || null, lastAt: Date.now() });
  pump();
}

/* ---- a lane's stream: the same events as the main session's, with its own running turn ---- */

function onLaneEvent(lane, ev) {
  switch (ev.type) {
    case "control_request":
      return withLane(lane, () => onControlRequest(ev, lane));
    case "control_cancel_request":
      return onControlCancel(ev);
    case "command_lifecycle":
      return laneLifecycle(lane, ev);
    case "user":
      return laneUser(lane, ev);
    case "assistant":
      return laneAssistant(lane, ev);
    case "stream_event":
      return laneStream(lane, ev);
    case "result":
      return laneResult(lane, ev);
    case "system":
      if (ev.subtype === "init" && ev.session_id && ev.session_id !== lane.sessionId) {
        laneBySession.set(ev.session_id, lane);
        rememberLaneSession(ev.session_id);
      }
      return;
    default:
      return;
  }
}

function laneLifecycle(lane, ev) {
  const uuid = ev.command_uuid;
  if (!uuid) return;
  let entry = lane.byUuid.get(uuid);
  if (ev.state === "started") {
    if (lane.inflight && lane.inflight.uuid === uuid) lane.inflight = null;
    if (!entry) {
      // A turn the CLI started on its own: an agent's reply to a request this lane passed on, an idle notice.
      const C = callFor(lane.call);
      const row0 = ledger.addTurn({ uuid, source: "unknown", text: "", status: "running" });
      ledger.updateTurn(row0.id, { call_id: lane.call, lane: lane.kind, voice_actor: C.actor, follows: lane.lastAgent ? lane.lastAgent.turn : null });
      entry = { rowId: row0.id, own: true };
      lane.byUuid.set(uuid, entry);
    }
    if (entry.ignore) {
      lane.running = { ignored: true, uuid };
      return;
    }
    const row = ledger.updateTurn(entry.rowId, { status: "running", started_at: now() });
    lane.running = { id: row.id, uuid, source: row.source, actor: row.actor, text: row.text, call: lane.call, started_at: row.started_at, startedMs: Date.now(), steps: [], tools: [], wrote: false, approvals: 0, lane };
    lane.toolSteps.clear();
    emit("turn", { phase: "start", turn: publicTurn(row) });
    return;
  }
  if (ev.state === "completed" || ev.state === "cancelled" || ev.state === "failed") {
    const r = lane.running;
    lane.running = null;
    if (lane.inflight && lane.inflight.uuid === uuid) lane.inflight = null;
    lane.byUuid.delete(uuid);
    if (entry && !entry.ignore && entry.escalate) {
      // The quick lane found it needs the machine: the same row, to a work lane.
      const row = ledger.updateTurn(entry.rowId, { status: "queued", lane: "work" });
      log(`voice: request #${row.id} escalated from the quick lane to a work lane`);
      dispatchLane(row, { lane: "work" });
    } else if (entry && !entry.ignore) {
      let row = ledger.get("turns", entry.rowId);
      if (row && (row.status === "running" || row.status === "queued")) {
        row = ledger.updateTurn(row.id, { status: ev.state === "completed" ? "done" : ev.state === "cancelled" ? "interrupted" : "error", ended_at: now() });
        emit("turn", { phase: "end", turn: publicTurn(row) });
        features.hooks.onTurnEnd(row);
      }
      const h = row && callFor(lane.call).history.find((x) => x.id === row.id);
      if (h) {
        h.running = false;
        h.reply = row.result_text || h.reply;
      }
      if (row) uiTokens.delete(row.id);
    }
    if (r && r.id) lane.toolSteps.clear();
    lane.lastAt = Date.now();
    const next = lane.afterIdle;
    lane.afterIdle = null;
    if (next) next();
    emit("lane", { lane: lane.view(), phase: "idle" });
  }
}

function laneUser(lane, ev) {
  const content = ev.message && ev.message.content;
  if (Array.isArray(content) && content.some((b) => b && b.type === "tool_result")) {
    for (const b of content) if (b && b.type === "tool_result") onToolResult(b, ev, lane);
    return;
  }
  if (!ev.isReplay) return;
  const entry = lane.byUuid.get(ev.uuid);
  if (!entry || !entry.own) return; // our own message: recorded already
  const text = contentText(content);
  let source = "remote";
  let fromName = null;
  if (ev.origin && ev.origin.kind === "peer") {
    source = "peer";
    fromName = ev.origin.name || null;
  } else if (text.includes("[Cross-session idle notice]")) source = "idle";
  else if (text.includes("[Cross-session delivery notice]")) source = "delivery";
  else if (ev.isSynthetic || ev.isMeta) source = "system";
  const shown = source === "peer" && ev.origin && ev.origin.body ? ev.origin.body : text;
  const row = ledger.updateTurn(entry.rowId, { source, actor: fromName, text: clip(shown, 20000) });
  if (lane.running && lane.running.id === row.id) lane.running.source = source;
  emit("turn", { phase: "source", turn: publicTurn(row), from_pid: ev.origin && ev.origin.verifiedPeerPid });
}

function laneEmitSteps(lane) {
  if (!lane.running || lane.running.ignored) return;
  emit("steps", { turn_id: lane.running.id, steps: lane.running.steps });
}

function laneAssistant(lane, ev) {
  const r = lane.running;
  if (!r || r.ignored) return;
  const blocks = (ev.message && ev.message.content) || [];
  for (const b of blocks) {
    if (!b) continue;
    if (b.type === "text" && b.text) {
      if (!ev.parent_tool_use_id) r.wrote = r.wrote || /\S/.test(b.text);
      // The quick lane's text is held until its result (it may be the single word ESCALATE).
      if (lane.kind === "quick") continue;
      emit("assistant", { turn_id: r.id, text: clip(b.text, 20000), parent_tool_use_id: ev.parent_tool_use_id || null });
    } else if (b.type === "tool_use") {
      const step = { t: now(), tool: b.name, txt: describeTool(b.name, b.input), st: "run", tool_use_id: b.id, sub: !!ev.parent_tool_use_id };
      r.steps.push(step);
      if (r.steps.length > 200) r.steps.splice(0, r.steps.length - 200);
      r.tools.push({ name: b.name, harmless: b.name === "Bash" ? !classifier.gateDecision("Bash", b.input || {}, cfg) && /^\s*(?:curl|cat|ls|df|free|uptime|date|systemctl (?:status|is-active)|journalctl|grep|head|tail|ps|du|wc|find)\b/.test(String((b.input || {}).command || "")) : false });
      lane.toolSteps.set(b.id, { step, name: b.name, input: b.input });
      emit("tool", { turn_id: r.id, tool_use_id: b.id, name: b.name, summary: step.txt, input: clipInput(b.input) });
      laneEmitSteps(lane);
    }
  }
}

function laneStream(lane, ev) {
  const r = lane.running;
  if (!r || r.ignored || lane.kind === "quick") return;
  const e = ev.event || {};
  if (e.type === "content_block_delta" && e.delta && e.delta.type === "text_delta" && !ev.parent_tool_use_id) {
    if (/\S/.test(e.delta.text)) r.wrote = true;
    const line = JSON.stringify({ event: { seq: 0, ts: now(), type: "text", turn_id: r.id, delta: redact(e.delta.text) } }) + "\n";
    for (const v of viewers) if (!v.destroyed && v.writableLength < 1024 * 1024) v.write(line);
  }
}

function laneResult(lane, ev) {
  const r = lane.running;
  if (!r || r.ignored) return;
  const text = String(ev.result || "");
  if (lane.kind === "quick" && !ev.is_error && voiceLane.ESCALATE_RE.test(text)) {
    const entry = lane.byUuid.get(r.uuid);
    if (entry) entry.escalate = true;
    r.ignored = true;
    // Its cost is still its own (the chain of this lane).
    features.hooks.onResult(ledger.get("turns", r.id), { ...ev, result: "" }, lane.procStamp);
    return;
  }
  if (lane.kind === "quick" && text) emit("assistant", { turn_id: r.id, text: clip(text, 20000), parent_tool_use_id: null });
  const row = ledger.updateTurn(r.id, {
    duration_ms: ev.duration_ms || null,
    cost_usd: ev.total_cost_usd || null,
    result_text: clip(text, 20000),
    error: ev.is_error ? clip(text || ev.subtype || "error", 2000) : null,
  });
  features.hooks.onResult(row, ev, lane.procStamp);
  const h = callFor(lane.call).history.find((x) => x.id === row.id);
  if (h) h.reply = row.result_text;
  emit("result", { turn: publicTurn(ledger.get("turns", row.id)), is_error: !!ev.is_error, subtype: ev.subtype });
}

function onLaneExit(lane, code, signal) {
  log(`voice lane ${lane.id} exited code=${code} signal=${signal} after ${lane.turns} turn(s)${code && lane.stderr ? ": " + clip(lane.stderr.trim(), 300) : ""}`);
  for (const [aid, a] of approvals) {
    if (a.lane !== lane) continue;
    clearTimeout(a.timer);
    const row = ledger.updateApproval(aid, { status: "cancelled", decided_at: now(), note: "the voice lane's process ended before an answer" });
    approvals.delete(aid);
    requestToApproval.delete(a.requestId);
    emit("approval", { approval: publicApproval(row) });
  }
  const retry = [];
  for (const [uuid, entry] of lane.byUuid) {
    if (entry.ignore) continue;
    const row = ledger.get("turns", entry.rowId);
    if (!row) continue;
    if (row.status === "running") {
      const upd = ledger.updateTurn(row.id, { status: "lost", ended_at: now(), error: "the voice lane's process exited mid-turn" });
      emit("turn", { phase: "end", turn: publicTurn(upd) });
      features.hooks.onTurnEnd(upd);
    } else if (row.status === "queued" && !entry.retried) retry.push(row);
    lane.byUuid.delete(uuid);
  }
  lane.running = null;
  lane.inflight = null;
  lanes.delete(lane.id);
  laneBySession.delete(lane.sessionId);
  const C = callLanes.get(lane.call);
  if (C) {
    C.lanes = C.lanes.filter((l) => l !== lane);
    if (!C.lanes.length && Date.now() - C.lastAt > cfg.voice_lane_idle_s * 1000) callLanes.delete(lane.call);
  }
  emit("lane", { lane: lane.view(), phase: "end" });
  // A request written to it but never started goes once more, to another lane (or the main queue).
  for (const row of retry) dispatchLane(row, { lane: row.lane === "quick" ? "quick" : "work" });
}

/** At shutdown: every lane's stdin closed (its transcript finished), then waited for; SIGTERM after `ms`. */
function closeAllLanes(ms) {
  const live = [...lanes.values()].filter((l) => l.child);
  if (!live.length) return Promise.resolve();
  return Promise.all(
    live.map(
      (l) =>
        new Promise((res) => {
          const c = l.child;
          c.once("exit", res);
          closeLane(l, "the supervisor is stopping");
          setTimeout(() => {
            try {
              c.kill("SIGTERM");
            } catch (_) {
              /* gone */
            }
            setTimeout(res, 1000).unref();
          }, ms).unref();
        })
    )
  );
}

/** Every 30 s: lanes idle past voice_lane_idle_s close (not one whose delegation is still open). */
function sweepLanes() {
  const idleMs = cfg.voice_lane_idle_s * 1000;
  for (const lane of lanes.values()) {
    if (lane.state === "closed" || lane.busy() || lane.pendingDispatch) continue;
    if (Date.now() - lane.lastAt < idleMs) continue;
    if (laneHoldsDelegation(lane)) continue;
    closeLane(lane, "idle");
  }
  for (const [call, C] of callLanes) if (!C.lanes.length && Date.now() - C.lastAt > idleMs) callLanes.delete(call);
}

/* ---- deploy events: JOYA AI hears about restarts with its next turn ---- */

const deploys = []; // [{component, started_at, commit, deployed_at}] (the last few, for the snapshot)
// This server's own time zone (the journal's), for the snapshot's clock; the CLI's TZ is cfg.tz.
const SERVER_TZ = (() => {
  try {
    const m = /zoneinfo\/(.+)$/.exec(fs.readlinkSync("/etc/localtime"));
    if (m) return m[1];
  } catch (_) {
    /* not a link */
  }
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
})();
let deployNotes = []; // not yet told to JOYA AI

/** The DEPLOYED stamp a deploy script wrote next to the code (commit=..., deployed_at=...). */
function deployedStamp(file) {
  const out = {};
  try {
    for (const line of fs.readFileSync(file, "utf8").split("\n")) {
      const m = /^([a-z_]+)=([^\s]{1,80})$/.exec(line.trim());
      if (m) out[m[1]] = m[2];
    }
  } catch (_) {
    /* no stamp: a start from the repo */
  }
  return out;
}
function noteDeploy(e, actor) {
  const d = { component: e.component, started_at: e.started_at || now(), commit: e.commit || null, deployed_at: e.deployed_at || null };
  deploys.push(d);
  while (deploys.length > 8) deploys.shift();
  deployNotes.push(d);
  while (deployNotes.length > 4) deployNotes.shift();
  log(`deploy event: ${d.component} started ${d.started_at}${d.commit ? `, commit ${d.commit}` : ""}${d.deployed_at ? `, deployed ${d.deployed_at}` : ""} (${actor})`);
  emit("deploy", d);
  return d;
}
/** The note JOYA AI gets with its next turn, once. */
function deployNoteText(list) {
  const what = list
    .map((d) => `${d.component === "joya-ai" ? "your supervisor (joya-ai)" : "the Joya dashboard (joya-dashboard)"} (re)started at ${d.started_at} UTC${d.commit ? `, running commit ${d.commit}` : ""}${d.deployed_at ? ` deployed at ${d.deployed_at}` : ""}`)
    .join("; ");
  return `[System note from the supervisor, not the administrator: ${what}. Check the journal (journalctl -u joya-dashboard / -u joya-ai, server time) before you say what changed or why; cite what you find.]`;
}

/**
 * Hand the CLI the next turn, if it is free: nothing running and nothing
 * handed over that has not started. The CLI would queue a second message
 * behind the first in arrival order, so holding the rest here is what lets a
 * user turn overtake a waiting background one.
 */
function pump() {
  if (proc.state !== "ready" || turns.running || turns.inflight || !turns.pending.length) return;
  // Paused at its daily token cap (build spec §6): every queued turn waits for Resume or the day turning.
  if (features.caps.selfPaused()) return;
  const i = turnQueue.pickNext(turns.pending, Date.now(), cfg.queue_background_max_wait_s * 1000);
  if (i < 0) return;
  const { row, message } = turns.pending[i];
  const notes = deployNotes;
  // (After the turn's own words: what was asked stays first.)
  const msg = notes.length && typeof message.message.content === "string" ? { ...message, message: { ...message.message, content: message.message.content + "\n\n" + deployNoteText(notes) } } : message;
  if (!writeChild(msg)) return;
  if (msg !== message) deployNotes = [];
  turns.pending.splice(i, 1);
  turns.byUuid.set(row.uuid, row.id);
  ledger.updateTurn(row.id, { sent_at: now() });
  turns.inflight = { id: row.id, uuid: row.uuid, at: Date.now() };
  clearTimeout(turns.inflightTimer);
  turns.inflightTimer = setTimeout(inflightWatchdog, cfg.queue_start_timeout_s * 1000);
  if (turns.inflightTimer.unref) turns.inflightTimer.unref();
}

function clearInflight() {
  turns.inflight = null;
  clearTimeout(turns.inflightTimer);
  turns.inflightTimer = null;
}

/**
 * A turn handed over and never started. If another turn is running (a peer
 * message the CLI took first) it is simply waiting behind it; otherwise the
 * CLI has lost track of it, so stop holding the queue for it.
 */
function inflightWatchdog() {
  if (!turns.inflight) return;
  if (turns.running) {
    turns.inflightTimer = setTimeout(inflightWatchdog, cfg.queue_start_timeout_s * 1000);
    if (turns.inflightTimer.unref) turns.inflightTimer.unref();
    return;
  }
  warn(`turn #${turns.inflight.id} was handed to the CLI ${Math.round((Date.now() - turns.inflight.at) / 1000)}s ago and never started; freeing the queue`);
  clearInflight();
  pump();
}

/* --------------------------------------------------------- stream events --- */

function onEvent(ev) {
  switch (ev.type) {
    case "control_response":
      return onControlResponse(ev);
    case "control_request":
      return onControlRequest(ev);
    case "control_cancel_request":
      return onControlCancel(ev);
    case "system":
      return onSystem(ev);
    case "command_lifecycle":
      return onLifecycle(ev);
    case "user":
      return onUser(ev);
    case "assistant":
      return onAssistant(ev);
    case "stream_event":
      return onStreamEvent(ev);
    case "result":
      return onResult(ev);
    default:
      return;
  }
}

const pendingControl = new Map(); // request_id -> callback

function sendControl(request, timeoutMs = 30000) {
  const id = "sup-" + crypto.randomUUID();
  return new Promise((resolve, reject) => {
    if (!writeChild({ type: "control_request", request_id: id, request })) return reject(new Error("JOYA AI is not running"));
    const t = setTimeout(() => {
      pendingControl.delete(id);
      reject(new Error("no answer from the CLI"));
    }, timeoutMs);
    pendingControl.set(id, (resp) => {
      clearTimeout(t);
      pendingControl.delete(id);
      if (resp.subtype === "success") resolve(resp.response || {});
      else reject(new Error(resp.error || "the CLI refused"));
    });
  });
}

function onControlResponse(ev) {
  const resp = ev.response || {};
  if (resp.request_id && String(resp.request_id).startsWith("init-")) {
    if (resp.subtype !== "success") {
      proc.error = "initialize failed: " + (resp.error || "unknown");
      warn(proc.error);
      return;
    }
    proc.readyAt = now();
    setState("ready");
    pump();
    if (cfg.remote_control) enableRemoteControl(true, "supervisor").catch((e) => warn("remote control:", e.message));
    return;
  }
  const cb = pendingControl.get(resp.request_id);
  if (cb) cb(resp);
}

async function enableRemoteControl(enabled, actor) {
  const r = await sendControl({ subtype: "remote_control", enabled: !!enabled }, 45000);
  rc.enabled = !!enabled;
  rc.error = null;
  if (enabled) {
    rc.url = r.session_url || r.sessionUrl || rc.url;
    rc.bridgeSessionId = r.bridge_session_id || r.bridgeSessionId || rc.bridgeSessionId;
    writeState({ rc: { url: rc.url, bridge_session_id: rc.bridgeSessionId, enabled_at: now() } });
  }
  log(`remote control ${enabled ? "on" : "off"} (${actor})`);
  emit("rc", { enabled: rc.enabled, url: rc.enabled ? rc.url : null, bridge_session_id: rc.bridgeSessionId });
  return { enabled: rc.enabled, url: rc.enabled ? rc.url : null, bridge_session_id: rc.bridgeSessionId };
}

function onSystem(ev) {
  if (ev.subtype === "init") {
    proc.initSessionId = ev.session_id;
    const want = readState().session_id;
    if (ev.session_id && want && ev.session_id !== want) {
      // The CLI chose its own id. Adopt it, so the next start resumes what
      // this process is actually writing.
      warn(`CLI started session ${ev.session_id}, not ${want}; adopting it`);
      writeState({ session_id: ev.session_id, previous_session_id: want });
    }
    const tools = Array.isArray(ev.tools) ? ev.tools.map(String) : [];
    writeState({
      last_init: {
        session_id: ev.session_id || null,
        at: now(),
        model: ev.model || null,
        cli_version: ev.claude_code_version || null,
        permission_mode: ev.permissionMode || null,
        tools: tools.length,
        mcp_tools: tools.filter((t) => t.startsWith("mcp__")),
        mcp_servers: Array.isArray(ev.mcp_servers) ? ev.mcp_servers.map((m) => ({ name: m && m.name, status: m && m.status })) : null,
      },
    });
    emit("init", {
      session_id: ev.session_id,
      model: ev.model,
      permission_mode: ev.permissionMode,
      cli_version: ev.claude_code_version,
      tools: Array.isArray(ev.tools) ? ev.tools.length : null,
    });
    return;
  }
  if (ev.subtype === "bridge_state") {
    rc.state = ev.state;
    emit("rc", { enabled: rc.enabled, state: ev.state });
    return;
  }
  if (ev.subtype === "status" && ev.status) {
    emit("status", { status: ev.status });
  }
}

function onLifecycle(ev) {
  const uuid = ev.command_uuid;
  if (!uuid) return;
  let row = turns.byUuid.has(uuid) ? ledger.get("turns", turns.byUuid.get(uuid)) : ledger.turnByUuid(uuid);
  if (ev.state === "queued") {
    if (row) {
      row = ledger.updateTurn(row.id, { status: "queued" });
      emit("turn", { phase: "queued", turn: publicTurn(row) });
    }
    return;
  }
  if (ev.state === "started") {
    if (!row) {
      // A turn the CLI started on its own -- a peer message, an idle notice,
      // or someone typing through Remote Control. The replayed user message
      // that follows fills in where it came from.
      row = ledger.addTurn({ uuid, source: "unknown", text: "", status: "running" });
      turns.byUuid.set(uuid, row.id);
    }
    row = ledger.updateTurn(row.id, { status: "running", started_at: now() });
    if (turns.inflight && turns.inflight.uuid === uuid) clearInflight();
    turns.running = { id: row.id, uuid, source: row.source, text: row.text, started_at: row.started_at, steps: [] };
    turns.toolSteps.clear();
    emit("turn", { phase: "start", turn: publicTurn(row) });
    emitSteps();
    return;
  }
  if (ev.state === "completed" || ev.state === "cancelled" || ev.state === "failed") {
    if (row && (row.status === "running" || row.status === "queued")) {
      row = ledger.updateTurn(row.id, {
        status: ev.state === "completed" ? "done" : ev.state === "cancelled" ? "interrupted" : "error",
        ended_at: now(),
      });
      emit("turn", { phase: "end", turn: publicTurn(row) });
      features.hooks.onTurnEnd(row);
    }
    if (turns.running && turns.running.uuid === uuid) {
      uiTokens.delete(turns.running.id); // a turn's ui token dies with it
      turns.running = null;
    }
    if (turns.inflight && turns.inflight.uuid === uuid) clearInflight();
    turns.byUuid.delete(uuid);
    pump();
  }
}

function contentText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.filter((b) => b && b.type === "text").map((b) => b.text).join("\n");
  return "";
}

function onUser(ev) {
  const content = ev.message && ev.message.content;
  // Tool results come back as user events carrying tool_result blocks.
  if (Array.isArray(content) && content.some((b) => b && b.type === "tool_result")) {
    for (const b of content) if (b && b.type === "tool_result") onToolResult(b, ev);
    return;
  }
  if (!ev.isReplay) return;
  const text = contentText(content);
  const uuid = ev.uuid;
  let source = "remote";
  let fromName = null;
  if (ev.origin && ev.origin.kind === "peer") {
    source = "peer";
    fromName = ev.origin.name || null;
  } else if (text.includes("[Cross-session idle notice]")) source = "idle";
  else if (text.includes("[Cross-session delivery notice]")) source = "delivery";
  else if (ev.isSynthetic || ev.isMeta) source = "system";

  let row = uuid && (turns.byUuid.has(uuid) ? ledger.get("turns", turns.byUuid.get(uuid)) : ledger.turnByUuid(uuid));
  if (row && OUR_SOURCES.has(row.source)) return; // our own message, already recorded
  const shown = source === "peer" && ev.origin && ev.origin.body ? ev.origin.body : text;
  if (row) {
    row = ledger.updateTurn(row.id, { source, text: clip(shown, 20000), actor: fromName });
  } else {
    row = ledger.addTurn({ uuid, source, actor: fromName, text: clip(shown, 20000), status: "queued" });
    if (uuid) turns.byUuid.set(uuid, row.id);
  }
  if (turns.running && turns.running.uuid === uuid) {
    turns.running.source = source;
    turns.running.text = row.text;
  }
  emit("turn", { phase: "source", turn: publicTurn(row), from_pid: ev.origin && ev.origin.verifiedPeerPid });
  if (turns.running && turns.running.uuid === uuid) holdIfPaused(row, source, fromName, shown);
}

/**
 * Paused at the daily token cap: a turn the CLI started on its own (a peer's
 * message, Remote Control, a cross-session notice) is interrupted. A message
 * someone sent (peer, Remote Control) is kept and put back in the queue when
 * JOYA AI is resumed or the day turns; a notice is only interrupted.
 */
function holdIfPaused(row, source, fromName, text) {
  if (!features.caps.selfPaused() || !proc.child) return;
  if (source === "peer" || source === "remote") features.caps.holdForSelf({ source, from: fromName, text });
  log(`token cap: interrupting a ${source} turn (#${row.id}) while JOYA AI is paused at its daily cap${source === "peer" || source === "remote" ? "; its message is kept for later" : ""}`);
  sendControl({ subtype: "interrupt" }, 15000).catch((e) => warn("cap interrupt: " + e.message));
}

function describeTool(name, input) {
  const i = input || {};
  switch (name) {
    case "ListAgents":
      return "Listed the live sessions";
    case "SendMessage":
      return `Sent to ${peers.bareName(i.to)}: ${clip(i.message || "", 80)}${i.notify_when_idle ? " (notify when idle)" : ""}`;
    case "Bash":
      return "Ran: " + clip(i.command || "", 100);
    case "Monitor":
      return "Watching: " + clip(i.command || i.description || "", 100);
    case "Read":
      return "Read " + (i.file_path || "");
    case "Write":
      return "Wrote " + (i.file_path || "");
    case "Edit":
      return "Edited " + (i.file_path || "");
    case "Grep":
      return "Searched files for " + clip(i.pattern || "", 60);
    case "Glob":
      return "Listed files matching " + clip(i.pattern || "", 60);
    case "Task":
    case "Agent":
      return "Started a subagent: " + clip(i.description || i.prompt || "", 80);
    case "WebSearch":
      return "Searched the web: " + clip(i.query || "", 80);
    case "WebFetch":
      return "Fetched " + clip(i.url || "", 80);
    case "mcp__memory__memory_search":
      return `Searched memory: "${clip(i.query || "", 80)}"`;
    case "mcp__memory__memory_store":
      return "Saved a fact to memory";
    case "mcp__memory__memory_session":
      return "Read a past session";
    case "mcp__memory__memory_forget":
      return "Retracted a memory fact";
    default:
      return name;
  }
}

function emitSteps() {
  if (!turns.running) return;
  emit("steps", { turn_id: turns.running.id, steps: turns.running.steps });
}

function onAssistant(ev) {
  const blocks = (ev.message && ev.message.content) || [];
  for (const b of blocks) {
    if (!b) continue;
    if (b.type === "text" && b.text) {
      emit("assistant", { turn_id: turns.running && turns.running.id, text: clip(b.text, 20000), parent_tool_use_id: ev.parent_tool_use_id || null });
    } else if (b.type === "tool_use") {
      const step = { t: now(), tool: b.name, txt: describeTool(b.name, b.input), st: "run", tool_use_id: b.id, sub: !!ev.parent_tool_use_id };
      if (turns.running) {
        turns.running.steps.push(step);
        if (turns.running.steps.length > 200) turns.running.steps.splice(0, turns.running.steps.length - 200);
      }
      turns.toolSteps.set(b.id, { step, name: b.name, input: b.input });
      emit("tool", { turn_id: turns.running && turns.running.id, tool_use_id: b.id, name: b.name, summary: step.txt, input: clipInput(b.input) });
      emitSteps();
    }
  }
}

function clipInput(input) {
  const s = JSON.stringify(input || {});
  if (s.length <= 4000) return input;
  return { _truncated: clip(s, 4000) };
}

function onToolResult(b, ev, lane) {
  const t = (lane ? lane.toolSteps : turns.toolSteps).get(b.tool_use_id);
  const text = contentText(b.content);
  if (t) {
    t.step.st = b.is_error ? "error" : "done";
    t.step.done_at = now();
    if (b.is_error) t.step.error = clip(text, 300);
  }
  emit("tool_result", { tool_use_id: b.tool_use_id, ok: !b.is_error, name: t ? t.name : null, summary: clip(text, 600) });
  if (lane) laneEmitSteps(lane);
  else emitSteps();
}

function onStreamEvent(ev) {
  const e = ev.event || {};
  if (e.type === "content_block_delta" && e.delta && e.delta.type === "text_delta" && !ev.parent_tool_use_id) {
    // Deltas skip the ring buffer: a reconnecting viewer gets the finished
    // assistant text instead of ten thousand fragments.
    const line = JSON.stringify({ event: { seq: 0, ts: now(), type: "text", turn_id: turns.running && turns.running.id, delta: redact(e.delta.text) } }) + "\n";
    for (const v of viewers) if (!v.destroyed && v.writableLength < 1024 * 1024) v.write(line);
  }
}

function onResult(ev) {
  const running = turns.running;
  if (running) {
    const row = ledger.updateTurn(running.id, {
      duration_ms: ev.duration_ms || null,
      cost_usd: ev.total_cost_usd || null,
      result_text: clip(ev.result || "", 20000),
      error: ev.is_error ? clip(ev.result || ev.subtype || "error", 2000) : null,
    });
    // The process stamp; "#new" marks a process that started a new session (its running total starts from zero).
    features.hooks.onResult(row, ev, proc.startedAt + (proc.newSession ? "#new" : ""));
    emit("result", { turn: publicTurn(ledger.get("turns", row.id)), is_error: !!ev.is_error, subtype: ev.subtype });
  } else {
    emit("result", { is_error: !!ev.is_error, subtype: ev.subtype, cost_usd: ev.total_cost_usd, text: clip(ev.result || "", 4000) });
  }
}

/* --------------------------------------------------------------- approvals --- */

function onControlRequest(ev, lane) {
  const req = ev.request || {};
  // A voice lane's question is answered on its own stdin, and belongs to its running turn.
  const write = lane ? (o) => lane.write(o) : writeChild;
  const running = lane ? (lane.running && !lane.running.ignored ? lane.running : null) : turns.running;
  const steps = lane ? lane.toolSteps : turns.toolSteps;
  if (req.subtype !== "can_use_tool") {
    // Nothing else is registered, so nothing else should arrive; answering
    // stops the CLI waiting on a reply that would never come.
    write({ type: "control_response", response: { subtype: "error", request_id: ev.request_id, error: "not supported by the JOYA AI supervisor" } });
    return;
  }
  const tool = req.tool_name || "unknown";
  const input = req.input || {};
  const auto = features.autoDecision(tool, input);
  if (auto) return autoAnswer(ev, req, tool, input, auto, lane);
  const gate = classifier.gateDecision(tool, input, cfg) || {};
  const summary =
    tool === "SendMessage"
      ? `SendMessage to ${peers.bareName(input.to)}: ${input.message || ""}`
      : typeof input.command === "string"
      ? input.command
      : req.description || JSON.stringify(input);
  const expires = new Date(Date.now() + approvalTimeoutS() * 1000).toISOString();
  const row = ledger.addApproval({
    request_id: ev.request_id,
    tool_use_id: req.tool_use_id,
    turn_id: running && running.id,
    tool,
    input_json: clip(JSON.stringify(redactDeep(input)), 16000),
    summary: clip(redact(summary), 4000),
    category: gate.category || null,
    label: gate.label || (req.decision_reason_type === "hook" ? null : "Needs permission"),
    reason: req.decision_reason || gate.reason || req.description || null,
    expires_at: expires,
  });
  const expire = () => expireApproval(row.id);
  const timer = setTimeout(expire, approvalTimeoutS() * 1000);
  approvals.set(row.id, { requestId: ev.request_id, input, generation: proc.generation, timer, expire, tool, toolUseId: req.tool_use_id, ...(lane ? { lane } : {}) });
  requestToApproval.set(ev.request_id, row.id);
  if (running && lane) running.approvals++;
  const t = steps.get(req.tool_use_id);
  if (t) {
    t.step.st = "wait";
    t.step.approval_id = row.id;
    if (lane) laneEmitSteps(lane);
    else emitSteps();
  }
  log(`approval #${row.id} raised${lane ? " (voice lane " + lane.id + ")" : ""}: ${tool} ${clip(summary, 120)}`);
  features.hooks.onApproval(row, input, running ? ledger.get("turns", running.id) : null);
  emit("approval", { approval: publicApproval(ledger.get("approvals", row.id)) });
}

/**
 * A rule answered this can_use_tool before anyone had to: an "Always allow
 * this" rule, or a deny. Recorded as an approval row like any other, decided
 * by "rule:<id>", so the audit trail shows it.
 */
function autoAnswer(ev, req, tool, input, auto, lane) {
  const running = lane ? (lane.running && !lane.running.ignored ? lane.running : null) : turns.running;
  const summary = tool === "SendMessage" ? `SendMessage to ${peers.bareName(input.to)}: ${input.message || ""}` : typeof input.command === "string" ? input.command : JSON.stringify(input);
  const t = now();
  const row = ledger.addApproval({
    request_id: ev.request_id,
    tool_use_id: req.tool_use_id,
    turn_id: running && running.id,
    tool,
    input_json: clip(JSON.stringify(redactDeep(input)), 16000),
    summary: clip(redact(summary), 4000),
    category: auto.allow ? "rule" : "rule-deny",
    label: auto.allow ? "Allowed by a rule" : "Denied by a rule",
    reason: auto.explain,
    expires_at: t,
  });
  const who = auto.rule ? "rule:" + auto.rule.id : "rule";
  const response = auto.allow
    ? { behavior: "allow", updatedInput: input }
    : { behavior: "deny", message: `JOYA AI rules: ${auto.explain} Do not retry it or route it through another session; tell the user it is not allowed.` };
  (lane ? (o) => lane.write(o) : writeChild)({ type: "control_response", response: { subtype: "success", request_id: ev.request_id, response } });
  const upd = ledger.updateApproval(row.id, { status: auto.allow ? "approved" : "denied", decided_at: t, decided_by: who, rule_id: auto.rule ? auto.rule.id : null, note: auto.explain });
  log(`approval #${row.id} ${auto.allow ? "allowed" : "denied"} by ${who}: ${tool} ${clip(summary, 120)}`);
  if (!auto.allow) recordDeniedDelegation({ tool, input, toolUseId: req.tool_use_id }, upd, `denied by ${who}`);
  emit("approval", { approval: publicApproval(upd) });
}

function answer(approvalId, allow, message, actor) {
  const a = approvals.get(approvalId);
  if (!a) return false;
  // A hired session's question, or JOYA AI's retire question (M-6), is answered through its own callback.
  if (a.kind === "session" || a.kind === "retire") {
    clearTimeout(a.timer);
    approvals.delete(approvalId);
    requestToApproval.delete(a.requestId);
    try {
      a.reply(allow ? { behavior: "allow" } : { behavior: "deny", message }, actor);
    } catch (e) {
      warn("approval callback failed:", e.message);
    }
    return a;
  }
  if (!a.lane && a.generation !== proc.generation) return false;
  clearTimeout(a.timer);
  approvals.delete(approvalId);
  requestToApproval.delete(a.requestId);
  const response = allow ? { behavior: "allow", updatedInput: a.input } : { behavior: "deny", message };
  // A voice lane's question goes back on the lane's own stdin.
  (a.lane ? (o) => a.lane.write(o) : writeChild)({ type: "control_response", response: { subtype: "success", request_id: a.requestId, response } });
  if (a.lane && a.lane.running && a.lane.running.approvals) a.lane.running.approvals--;
  const t = (a.lane ? a.lane.toolSteps : turns.toolSteps).get(a.toolUseId);
  if (t) {
    t.step.st = allow ? "run" : "error";
    if (a.lane) laneEmitSteps(a.lane);
    else emitSteps();
  }
  return a;
}

function recordDeniedDelegation(a, row, why) {
  if (a.tool !== "SendMessage" || a.kind) return; // JOYA AI's own delegations only
  const to = String(a.input.to || "");
  const d = ledger.addDelegation({
    tool_use_id: a.toolUseId,
    turn_id: row.turn_id,
    target: to,
    target_name: peers.bareName(to),
    text: String(a.input.message || ""),
    summary: a.input.summary,
    notify_idle: !!a.input.notify_when_idle,
    status: "denied",
    note: why,
  });
  emitDelegation(d);
}

/**
 * Keep a waiting card alive while the administrator answers Windows Hello
 * (the panel asks when it hands out the challenge, dashboard lib/stepup.js):
 * the expiry moves to at least `seconds` from now, never further than
 * HOLD_MAX_S past the card's own window (a hired session's runner gives up 150 s
 * after it, bin/joya-session). Returns {expires_at, held}.
 */
const HOLD_MAX_S = 120;
function holdApproval(approvalId, seconds) {
  const row = ledger.get("approvals", approvalId);
  if (!row) throw new Error("no such approval");
  if (row.status !== "pending") throw new Error(`that approval is already ${row.status}`);
  const a = approvals.get(approvalId);
  if (!a || !a.expire) throw new Error("that request is no longer waiting (the process restarted)");
  if (!a.window_end) a.window_end = Date.parse(row.expires_at) + HOLD_MAX_S * 1000;
  const cur = Date.parse(row.expires_at);
  const want = Math.min(Date.now() + seconds * 1000, a.window_end);
  if (!(want > cur)) return { expires_at: row.expires_at, held: false };
  clearTimeout(a.timer);
  a.timer = setTimeout(a.expire, Math.max(0, want - Date.now()));
  const upd = ledger.updateApproval(approvalId, { expires_at: new Date(want).toISOString() });
  log(`approval #${approvalId} held to ${upd.expires_at} while Windows Hello runs`);
  emit("approval", { approval: publicApproval(upd) });
  return { expires_at: upd.expires_at, held: true };
}

function decide(approvalId, allow, actor, note, alwaysRule, verified) {
  const row = ledger.get("approvals", approvalId);
  if (!row) throw new Error("no such approval");
  if (row.status !== "pending") throw new Error(`that approval is already ${row.status}`);
  const a = approvals.get(approvalId);
  if (!a) throw new Error("that request is no longer waiting (the process restarted)");
  let rule = null;
  if (alwaysRule && a.kind) throw new Error("an always-allow rule is only for JOYA AI's own requests (a hired session inherits none)");
  if (allow && alwaysRule) {
    // "Always allow this": the rule must at least cover this very call, and
    // is saved before the call runs so the next identical one needs no card.
    const probe = rulesLib.evaluate(a.tool, a.input, [{ id: 0, effect: "allow", tool: alwaysRule.tool, pattern: alwaysRule.pattern, scope_session: "joya-ai", scope_machine: "this" }], {});
    if (!(probe.decision === "allow" && probe.source === "rule")) throw new Error("that rule would not match this request; narrow it to this command");
    rule = features.publicRule(features.createRule({ effect: "allow", tool: alwaysRule.tool, pattern: alwaysRule.pattern, note: `Always allow, from approval #${approvalId}` }, actor, approvalId));
  }
  const msg = allow
    ? null
    : `Denied by ${actor} in the JOYA AI dashboard${note ? ": " + note : ""}. Do not retry it, do not route it through another session, and tell the user it was denied.`;
  answer(approvalId, allow, msg, actor);
  const updated = ledger.updateApproval(approvalId, {
    status: allow ? "approved" : "denied",
    decided_at: now(),
    decided_by: actor,
    note: note || null,
    ...(allow && verified && verified.verified ? { verified: verified.verified, verified_with: verified.verified_with || null } : {}),
  });
  if (!allow) recordDeniedDelegation(a, updated, `denied by ${actor}`);
  const how = allow && verified && verified.verified ? (verified.verified === "hello" ? " with Windows Hello" : " with the authenticator code") : "";
  log(`approval #${approvalId} ${allow ? "approved" : "denied"} by ${actor}${how}${rule ? " and rule #" + rule.id + " saved" : ""}`);
  emit("approval", { approval: publicApproval(updated) });
  return rule ? { approval: publicApproval(updated), rule } : publicApproval(updated);
}

function expireApproval(approvalId) {
  const a = approvals.get(approvalId);
  if (!a) return;
  const mins = Math.round(approvalTimeoutS() / 60);
  answer(approvalId, false, `Nobody answered the approval request within ${mins} minute${mins === 1 ? "" : "s"}, so it was denied by default. Do not retry it; tell the user it is waiting for their approval.`);
  const row = ledger.updateApproval(approvalId, { status: "expired", decided_at: now(), decided_by: "timeout" });
  recordDeniedDelegation(a, row, "approval timed out");
  log(`approval #${approvalId} expired`);
  emit("approval", { approval: publicApproval(row) });
}

function onControlCancel(ev) {
  const aid = requestToApproval.get(ev.request_id);
  if (!aid) return;
  const a = approvals.get(aid);
  if (a) clearTimeout(a.timer);
  approvals.delete(aid);
  requestToApproval.delete(ev.request_id);
  // The CLI withdrew the question -- answered elsewhere (Remote Control) or
  // the turn was interrupted.
  const row = ledger.updateApproval(aid, { status: "cancelled", decided_at: now(), note: "withdrawn by the CLI (answered elsewhere or interrupted)" });
  emit("approval", { approval: publicApproval(row) });
}

/* ----------------------------------------------------- hired sessions (M-6) --- */
/*
 * JOYA AI may HIRE worker sessions on its own; it may RETIRE one only with the
 * administrator's consent (an Approve / Deny card), and never a kept session or
 * one not hired through this feature (fact #779). Each hired session runs as
 * joya-session@<slug>.service (bin/joya-session): outside this process, so it
 * outlives JOYA AI's and the dashboard's restarts; its permission questions
 * come back here as op session-approval and become cards attributed to it.
 */
const SESSIONS_FILES = path.join(cfg.state_dir, "sessions");
const INTERNAL_ACTORS = new Set(["joya-ai", "watcher", "supervisor", "flag-file", "scheduler", "order"]);
/** A person at the panel or a shell (not JOYA AI, not a hired session, not the supervisor's own jobs). */
function isHuman(actor) {
  return !INTERNAL_ACTORS.has(actor) && !/^session\./.test(actor) && !/^machines?(\.|$)/.test(actor);
}
function publicHired(h) {
  if (!h) return null;
  return { slug: h.slug, name: h.name, cwd: h.cwd, purpose: h.purpose, model: h.model, session_id: h.session_id, status: h.status, kept: !!h.kept, hired_by: h.hired_by, hired_at: h.hired_at, retired_at: h.retired_at, retired_by: h.retired_by, retire_approval_id: h.retire_approval_id, machine_id: h.machine_id || null };
}
function writeHiredFile(h, extra) {
  fs.mkdirSync(SESSIONS_FILES, { recursive: true, mode: 0o700 });
  const file = path.join(SESSIONS_FILES, h.slug + ".json");
  let old = {};
  try {
    old = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (_) {
    /* new */
  }
  const rec = { ...old, slug: h.slug, name: h.name, cwd: h.cwd, purpose: h.purpose, model: h.model, session_id: h.session_id, status: h.status, ...(extra || {}) };
  fs.writeFileSync(file + ".tmp", JSON.stringify(rec, null, 2), { mode: 0o600 });
  fs.renameSync(file + ".tmp", file);
}
function systemctl(args) {
  return new Promise((resolve, reject) => {
    const env = { PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin" };
    // Tests only: a fake systemctl (tools/fake-systemctl.cjs) starts the runner itself, with the fake CLI's settings.
    if (process.env.FAKE_SYSTEMCTL_DIR) for (const k of Object.keys(process.env)) if (/^FAKE_/.test(k)) env[k] = process.env[k];
    if (process.env.FAKE_SYSTEMCTL_DIR) env.JOYA_AI_CONFIG = CONFIG_FILE;
    execFile(cfg.systemctl, args, { timeout: 60000, env }, (err, stdout, stderr) =>
      err ? reject(new Error(String(stderr || err.message).trim().slice(0, 300))) : resolve(String(stdout || ""))
    );
  });
}
function emitHired(h, what) {
  emit("hired", { hired: publicHired(h), what });
  refreshSessions();
}

async function sessionHire(actor, p) {
  if (!(actor === "joya-ai" || isHuman(actor))) throw new Error("only JOYA AI or the administrator can hire a session");
  const hourAgo = new Date(Date.now() - 3600 * 1000).toISOString();
  const lim = hireLimits();
  const all = ledger.hiredList(true);
  const c = hireLib.checkHire(p, { live: sessionsCache.list || [], hired: all.filter((h) => h.status !== "retired"), recent: ledger.hiredSince(hourAgo), limits: lim, taken: all.map((h) => h.slug) });
  if (c.error) throw new Error(c.error);
  let h;
  try {
    h = ledger.addHired({ slug: c.slug, name: c.name, cwd: c.cwd, purpose: c.purpose, model: c.model, session_id: crypto.randomUUID(), hired_by: actor });
  } catch (e) {
    // hired_sessions.slug is UNIQUE: a hire racing this one took it. Never the raw constraint text.
    if (/UNIQUE/i.test(String(e.message))) throw new Error(`the name "${c.name}" was just taken by another hire: try again`);
    throw e;
  }
  if (c.slug_note) log(`hire: ${c.slug_note}; "${h.name}" is hired as ${h.slug}`);
  // The permission mode is fixed at hire time (Settings > Sessions & hiring); bin/joya-session refuses bypass.
  writeHiredFile(h, { hired_by: actor, hired_at: h.hired_at, permission_mode: lim.perm_mode });
  features.onHired(h);
  log(`hire: "${h.name}" (${h.slug}) in ${h.cwd} by ${actor}`);
  try {
    await systemctl(["enable", "--now", `joya-session@${h.slug}.service`]);
  } catch (e) {
    const upd = ledger.updateHired(h.id, { status: "retired", retired_at: now(), retired_by: "supervisor", note: "could not start: " + e.message });
    writeHiredFile(upd);
    emitHired(upd, "failed");
    throw new Error(`could not start "${h.name}": ${e.message}`);
  }
  emit("notice", { level: "info", text: `${actor === "joya-ai" ? "JOYA AI" : actor} hired a session: ${h.name}` });
  emitHired(h, "hired");
  return { hired: publicHired(h), note: `"${h.name}" is starting (joya-session@${h.slug}); its first message is the purpose, from JOYA AI. Reach it with SendMessage once ListAgents lists it.` };
}

async function doRetire(h, by) {
  try {
    await systemctl(["disable", "--now", `joya-session@${h.slug}.service`]);
  } catch (e) {
    const back = ledger.updateHired(h.id, { status: "hired", note: "retire failed: " + e.message });
    emitHired(back, "retire-failed");
    throw new Error(`could not stop "${h.name}": ${e.message}`);
  }
  const upd = ledger.updateHired(h.id, { status: "retired", retired_at: now(), retired_by: by });
  writeHiredFile(upd, { retired_at: upd.retired_at, retired_by: by });
  auditLine(by, "session-retired", { slug: h.slug, name: h.name, session_id: h.session_id }, true);
  log(`retire: "${h.name}" (${h.slug}) by ${by}; its transcript is kept`);
  emit("notice", { level: "info", text: `${h.name} was retired (by ${by}); its transcript is kept` });
  emitHired(upd, "retired");
  return upd;
}

async function sessionRetire(actor, p) {
  const all = ledger.hiredList(false);
  const h = hireLib.findHired({ slug: p.slug, session_id: p.session_id, ref: p.ref, name: p.name }, all, agentRefs);
  // A session on one of the user's computers: ending control is always safe, so it ends at once (no consent card).
  if (h && h.machine_id && (actor === "joya-ai" || isHuman(actor))) {
    const by = actor === "joya-ai" ? "joya-ai" : actor;
    return { retired: publicHired(machines.stop(h, actor === "joya-ai" ? "released by JOYA AI" + (p.note ? ": " + p.note : "") : `stopped by ${actor}`, by)) };
  }
  if (actor === "joya-ai") {
    const why = hireLib.retireRefusal(h);
    if (why) throw new Error(why);
    // Never ends it: a consent card for the administrator.
    const secs = cfg.retire_consent_s;
    const row = ledger.addApproval({
      request_id: `retire:${h.slug}:${Date.now()}`,
      tool: "SessionRetire",
      input_json: JSON.stringify({ session: h.name, slug: h.slug, session_id: h.session_id, cwd: h.cwd, purpose: h.purpose, why: p.note || null }),
      summary: clip(`Retire the session "${h.name}" (hired ${h.hired_at.slice(0, 16).replace("T", " ")} by ${h.hired_by === "joya-ai" ? "JOYA AI" : h.hired_by}: ${h.purpose})`, 4000),
      category: "retire",
      label: "Retire a session",
      reason: clip(`JOYA AI asks to retire this hired session${p.note ? ": " + p.note : ""}. Nothing ends unless you approve; its transcript is kept.`, 2000),
      expires_at: new Date(Date.now() + secs * 1000).toISOString(),
      origin: "joya-ai",
      origin_name: "JOYA AI",
    });
    const expire = () => {
      const a = approvals.get(row.id);
      if (!a) return;
      approvals.delete(row.id);
      const cur = ledger.get("hired_sessions", h.id);
      if (cur && cur.status === "retiring") emitHired(ledger.updateHired(h.id, { status: "hired" }), "retire-expired");
      emit("approval", { approval: publicApproval(ledger.updateApproval(row.id, { status: "expired", decided_at: now(), decided_by: "timeout" })) });
    };
    const timer = setTimeout(expire, secs * 1000);
    if (timer.unref) timer.unref();
    approvals.set(row.id, {
      kind: "retire",
      requestId: row.request_id,
      input: {},
      tool: "SessionRetire",
      timer,
      expire,
      reply: (resp, by) => {
        const cur = ledger.get("hired_sessions", h.id);
        if (!cur || cur.status === "retired") return;
        if (resp.behavior === "allow") doRetire(cur, by || "administrator").catch((e) => warn("retire:", e.message));
        else emitHired(ledger.updateHired(h.id, { status: "hired" }), "retire-denied");
      },
    });
    ledger.updateHired(h.id, { status: "retiring", retire_asked_at: now(), retire_approval_id: row.id });
    emitHired(ledger.get("hired_sessions", h.id), "retire-asked");
    emit("approval", { approval: publicApproval(ledger.get("approvals", row.id)) });
    return { status: "consent", approval_id: row.id, note: `Nothing has ended: the administrator must approve retiring "${h.name}" in the Command Center. Tell them it waits for their consent.` };
  }
  if (!isHuman(actor)) throw new Error("only JOYA AI (asking for consent) or the administrator can retire a session");
  if (!h) throw new Error("that is not a session hired through JOYA AI (the administrator's own sessions are not retired from here)");
  if (h.kept) throw new Error(`"${h.name}" is kept: unkeep it first`);
  // The administrator's own consent was given in the Command Center's dialog (Keep / Retire).
  if (h.status === "retiring" && h.retire_approval_id) {
    const a = approvals.get(h.retire_approval_id);
    if (a) {
      clearTimeout(a.timer);
      approvals.delete(h.retire_approval_id);
      const how = p.verified ? { verified: p.verified, verified_with: p.verified_with || null } : {};
      emit("approval", { approval: publicApproval(ledger.updateApproval(h.retire_approval_id, { status: "approved", decided_at: now(), decided_by: actor, note: "retired from the session's menu", ...how })) });
    }
  }
  return { retired: publicHired(await doRetire(h, actor)) };
}

function sessionKeep(actor, p) {
  if (!isHuman(actor)) throw new Error("only the administrator can keep or unkeep a session");
  const h = hireLib.findHired({ slug: p.slug, session_id: p.session_id }, ledger.hiredList(false));
  if (!h) throw new Error("that is not a session hired through JOYA AI");
  if (h.machine_id && p.kept) throw new Error("a session on your computer runs only under a control lease: it cannot be kept");
  const upd = ledger.updateHired(h.id, { kept: p.kept ? 1 : 0 });
  log(`keep: "${h.name}" ${p.kept ? "kept" : "no longer kept"} by ${actor}`);
  emitHired(upd, p.kept ? "kept" : "unkept");
  return { hired: publicHired(upd) };
}

/** A hired session's permission question (bin/joya-session): a card attributed to it; answered on this connection. */
function sessionApproval(actor, p) {
  const h = ledger.hiredList(false).find((x) => x.slug === p.slug);
  if (!h || actor !== "session." + p.slug) throw new Error("not a hired session's own question");
  let input = {};
  try {
    input = JSON.parse(p.input || "{}");
  } catch (_) {
    input = { raw: String(p.input || "").slice(0, 2000) };
  }
  const tool = p.tool;
  const gate = classifier.gateDecision(tool, input, cfg) || {};
  const summary = tool === "SendMessage" ? `SendMessage to ${peers.bareName(input.to)}: ${input.message || ""}` : typeof input.command === "string" ? input.command : JSON.stringify(input);
  return sessionCard(h, { ...p, input_obj: input, summary }, gate);
}
/**
 * The approval card for a hired session's question (a VPS session's, or a laptop session's through
 * lib/machines.js): attributed to it (origin session:<slug>, origin_name its name), answered by the
 * administrator in the Command Center; resolves to the CLI's answer. No answer in time: deny.
 */
function sessionCard(h, p, gate) {
  const tool = p.tool;
  const input = p.input_obj || {};
  const summary = p.summary || JSON.stringify(input);
  const key = `${p.slug}:${p.request_id}`;
  const row = ledger.addApproval({
    request_id: key,
    tool_use_id: p.tool_use_id || null,
    tool,
    input_json: clip(JSON.stringify(redactDeep(input)), 16000),
    summary: clip(redact(summary), 4000),
    category: gate.category || null,
    label: gate.label || "Needs permission",
    reason: p.reason || gate.reason || null,
    expires_at: new Date(Date.now() + approvalTimeoutS() * 1000).toISOString(),
    origin: "session:" + p.slug,
    origin_name: h.name,
  });
  log(`approval #${row.id} raised by hired session "${h.name}": ${tool} ${clip(summary, 120)}`);
  return new Promise((resolve) => {
    const expire = () => {
      if (!approvals.has(row.id)) return;
      approvals.delete(row.id);
      requestToApproval.delete(key);
      emit("approval", { approval: publicApproval(ledger.updateApproval(row.id, { status: "expired", decided_at: now(), decided_by: "timeout" })) });
      resolve({ behavior: "deny", message: "Nobody answered the approval request in time, so it was denied." });
    };
    const timer = setTimeout(expire, approvalTimeoutS() * 1000);
    approvals.set(row.id, { kind: "session", slug: p.slug, requestId: key, input, tool, timer, expire, reply: (resp) => resolve(resp) });
    requestToApproval.set(key, row.id);
    emit("approval", { approval: publicApproval(ledger.get("approvals", row.id)) });
  });
}
function sessionApprovalCancel(actor, p) {
  const mid = machinesLib.machineIdOfActor(actor);
  const mine = actor === "session." + p.slug || (mid && ledger.hiredList(false).some((h) => h.slug === p.slug && Number(h.machine_id) === mid));
  if (!mine) throw new Error("not a hired session's own question");
  const key = `${p.slug}:${p.request_id}`;
  const aid = requestToApproval.get(key);
  if (!aid) return { cancelled: false };
  const a = approvals.get(aid);
  if (a) clearTimeout(a.timer);
  approvals.delete(aid);
  requestToApproval.delete(key);
  emit("approval", { approval: publicApproval(ledger.updateApproval(aid, { status: "cancelled", decided_at: now(), note: "withdrawn by the hired session" })) });
  return { cancelled: true };
}

/*
 * A hired session's standing link (bin/joya-session, op session-link): the
 * supervisor's way to reach a runner, for budget-pause / budget-resume. The
 * reply carries the current state, so a runner that (re)connects while its
 * session is paused pauses at once.
 */
const hiredLinks = new Map(); // slug -> Set<socket>
function sessionLink(actor, p, req, sock) {
  const h = ledger.hiredList(false).find((x) => x.slug === p.slug);
  if (!h || actor !== "session." + p.slug) throw new Error("not a hired session's own link");
  sock.write(protocol.reply(req.id, { linked: true, paused: features.caps.isPaused(h.slug), approval_timeout_s: approvalTimeoutS() }));
  if (!hiredLinks.has(h.slug)) hiredLinks.set(h.slug, new Set());
  hiredLinks.get(h.slug).add(sock);
  sock.on("close", () => {
    const set = hiredLinks.get(h.slug);
    if (set) set.delete(sock);
  });
  return undefined; // reply already written; the connection stays open
}
/** Send a control line to a hired session's runner; false when it has no live link. */
function tellHired(slug, control) {
  const set = hiredLinks.get(slug);
  let sent = false;
  for (const s of set || []) {
    if (s.destroyed) continue;
    s.write(JSON.stringify({ control }) + "\n");
    sent = true;
  }
  return sent;
}

/* ----------------------------------------------------- token caps (§6) --- */

/** features.js decided to pause a session at its cap. */
function onCapPause(e, o = {}) {
  if (e.kind === "self") {
    log("token cap: JOYA AI is paused at its daily cap; queued turns wait (a running turn finishes)");
    return;
  }
  if (e.kind !== "hired" && e.kind !== "kept") return; // the administrator's own sessions are never paused
  const sent = tellHired(e.slug || e.key, { op: "budget-pause", reason: "daily token cap reached" });
  if (!o.again) log(`token cap: budget-pause to "${e.name}" (${e.slug || e.key})${sent ? "" : ": no live link now; it pauses when it links, and its gate denies tool calls meanwhile"}`);
}
/** ...and to lift it: JOYA AI's held messages go back in the queue, a hired session gets budget-resume. */
function onCapResume(e, why, held) {
  if (e.kind === "self") {
    for (const m of held || []) {
      queueTurn({
        source: "cap-held",
        actor: m.from || m.source,
        text:
          `[Held while you were paused at your daily token cap; delivered now (${why}). ` +
          `${m.source === "peer" ? `A message from the session "${m.from || "unknown"}"` : "A message sent through Remote Control"}, received ${String(m.at || "").slice(11, 16)}:]\n\n${m.text}`,
      });
    }
    pump();
    return;
  }
  if (e.kind !== "hired" && e.kind !== "kept") return;
  tellHired(e.slug || e.key, { op: "budget-resume", reason: why });
  log(`token cap: budget-resume to "${e.name}" (${why})`);
}

/* ------------------------------------ editable settings (Joya reorganisation) --- */

const APPROVAL_TIMEOUT_BOUNDS = [30, 3600];
/** The approval timeout in force: the ledger setting (Settings > Approvals), else the config's. */
function approvalTimeoutS() {
  const v = settingsLib.get(ledger.db, "approval_timeout_s");
  const [lo, hi] = APPROVAL_TIMEOUT_BOUNDS;
  return Number.isInteger(v) && v >= lo && v <= hi ? v : cfg.approval_timeout_s;
}
function approvalTimeoutView() {
  return { seconds: approvalTimeoutS(), default: cfg.approval_timeout_s, bounds: APPROVAL_TIMEOUT_BOUNDS, ...settingsLib.meta(ledger.db, "approval_timeout_s") };
}
function approvalTimeoutSet(actor, p) {
  if (!isHuman(actor)) throw new Error("only the administrator can change the approval timeout");
  settingsLib.set(ledger.db, "approval_timeout_s", p.seconds, actor); // null: back to the config's
  log(`approval timeout: ${p.seconds === null ? "the default, " + cfg.approval_timeout_s : p.seconds} s (by ${actor})`);
  return approvalTimeoutView();
}

const HIRE_KEYS = { max_live: "hire_max_live", per_hour: "hire_per_hour", perm_mode: "hire_perm_mode" };
/** The hire limits in force, read at hire time: the ledger settings over lib/hire.js's defaults. */
function hireLimits() {
  const stored = {};
  for (const [k, key] of Object.entries(HIRE_KEYS)) stored[k] = settingsLib.get(ledger.db, key);
  return hireLib.effectiveLimits(stored, cfg);
}
function hireLimitsView() {
  const lim = hireLimits();
  const c = hireLib.liveCount(sessionsCache.list || [], ledger.hiredList(false));
  const metas = Object.values(HIRE_KEYS).map((k) => settingsLib.meta(ledger.db, k)).filter((m) => m.updated_at).sort((a, b) => (a.updated_at < b.updated_at ? 1 : -1));
  return {
    ...lim,
    defaults: hireLib.defaultLimits(cfg),
    bounds: hireLib.LIMIT_BOUNDS,
    modes: hireLib.HIRE_MODES,
    live: c.live,
    hired: c.hired,
    updated_by: metas.length ? metas[0].updated_by : null,
    updated_at: metas.length ? metas[0].updated_at : null,
  };
}
function hireLimitsSet(actor, p) {
  if (!isHuman(actor)) throw new Error("only the administrator can change the hire limits");
  const given = Object.keys(HIRE_KEYS).filter((k) => p[k] !== undefined);
  if (!given.length) throw new Error("give max_live, per_hour or perm_mode");
  const clean = hireLib.checkLimits(Object.fromEntries(given.filter((k) => p[k] !== null).map((k) => [k, p[k]])));
  if (clean.error) throw new Error(clean.error);
  for (const k of given) settingsLib.set(ledger.db, HIRE_KEYS[k], p[k] === null ? null : clean[k], actor); // null: back to the default
  log(`hire limits changed by ${actor}: ${given.map((k) => `${k}=${p[k] === null ? "default" : clean[k]}`).join(", ")}`);
  return hireLimitsView();
}

/*
 * JOYA AI's page map (build spec §5, "Feeding JOYA AI"): the dashboard pushes
 * the allowed page registry here; it is kept in the ledger (ui_pages) and
 * handed to lib/ui-actions.js's setPages, which replaces page.open's allowlist
 * -- at once, and again at every supervisor start. The ui_do / ui_actions_list
 * tool schemas do not change (page is a free string checked at call time).
 */
function applyPages(pages) {
  if (typeof UiActions.setPages !== "function") return false;
  try {
    UiActions.setPages(pages);
    return true;
  } catch (e) {
    warn("ui pages: setPages refused the list: " + e.message);
    return false;
  }
}
function uiPages(actor, p) {
  if (p.pages !== undefined || p.reset) {
    if (!isHuman(actor)) throw new Error("only the administrator's dashboard can change JOYA AI's page map");
    if (p.pages !== undefined && p.reset) throw new Error("give pages or reset, not both");
    if (p.reset) {
      settingsLib.set(ledger.db, "ui_pages", null);
      const applied = applyPages(null);
      log(`ui pages: reset to the built-in list by ${actor}`);
      return { pages: null, count: 0, applied, stored: false, updated_by: null, updated_at: null };
    }
    const seen = new Set();
    for (const e of p.pages) {
      if (seen.has(e.key)) throw new Error(`pages: the key "${e.key}" appears twice`);
      seen.add(e.key);
    }
    settingsLib.set(ledger.db, "ui_pages", p.pages, actor);
    const applied = applyPages(p.pages);
    log(`ui pages: ${p.pages.length} entries stored by ${actor}${applied ? " and applied" : " (ui-actions has no setPages yet: stored only)"}`);
    return { pages: p.pages, count: p.pages.length, applied, stored: true, ...settingsLib.meta(ledger.db, "ui_pages") };
  }
  const pages = settingsLib.get(ledger.db, "ui_pages");
  return { pages: Array.isArray(pages) ? pages : null, count: Array.isArray(pages) ? pages.length : 0, applied: typeof UiActions.setPages === "function" && Array.isArray(pages), stored: Array.isArray(pages), ...settingsLib.meta(ledger.db, "ui_pages") };
}
/** At start: the stored page map, re-applied. */
function loadPages() {
  const pages = settingsLib.get(ledger.db, "ui_pages");
  if (!Array.isArray(pages)) return;
  if (applyPages(pages)) log(`ui pages: ${pages.length} entries re-applied from the ledger`);
  else log(`ui pages: ${pages.length} entries stored, not applied (ui-actions has no setPages)`);
}

/**
 * JOYA AI's charter, read-only (Settings > General): the CLAUDE.md in its
 * working directory, which the CLI loads as project instructions (the CLI
 * starts in cfg.cwd). At most 64 KB of it.
 */
const CHARTER_MAX = 64 * 1024;
function charter() {
  const file = path.join(cfg.cwd, "CLAUDE.md");
  let buf;
  try {
    buf = fs.readFileSync(file);
  } catch (e) {
    return { path: file, text: null, bytes: 0, truncated: false, error: e.code === "ENOENT" ? "no CLAUDE.md in JOYA AI's working directory" : e.message };
  }
  const cut = buf.length > CHARTER_MAX;
  return { path: file, text: redact((cut ? buf.subarray(0, CHARTER_MAX) : buf).toString("utf8").replace(/\uFFFD$/, "")), bytes: buf.length, truncated: cut, modified_at: fs.statSync(file).mtime.toISOString() };
}

/* ------------------------------------------------------------ delegations --- */

/** Publish a delegation change, after letting its mission step follow it. */
function emitDelegation(d) {
  if (!d) return;
  features.hooks.onDelegation(d);
  emit("delegation", { delegation: publicDelegation(ledger.get("delegations", d.id) || d) });
}

function currentTurnId() {
  const r = runningTurn();
  return r ? r.id : null;
}

/** A live session by session id, then pid, then a UNIQUE normalised name (lib/targets.js); namesakes -> null. */
function findSession({ name, pid, sessionId }) {
  return targets.findTarget(sessionsCache.list || [], { sessionId, pid, name }).session;
}

// What ListAgents last showed JOYA AI: its refs ("Name [ref]" -> name, local / remote) and sub-agent ids,
// so a SendMessage target is named, and its kind known, even when it is not a process on this machine.
let agentRefs = {};
let agentSubagents = [];
function onListAgents(msg) {
  const r = msg.tool_response;
  const text = typeof r === "string" ? r : Array.isArray(r) ? contentText(r) : r && typeof r === "object" ? String(r.text || r.content || JSON.stringify(r)) : "";
  const parsed = targets.parseListAgents(text);
  if (Object.keys(parsed.refs).length || parsed.subagents.length) {
    agentRefs = { ...agentRefs, ...parsed.refs };
    agentSubagents = Array.from(new Set(agentSubagents.concat(parsed.subagents))).slice(-200);
  }
  refreshSessions();
}

function onHookEvent(msg) {
  // A voice lane's hook (it runs in /root/joya-ai with the same hooks): handled as its running turn's.
  const lane = msg && msg.session_id ? laneBySession.get(msg.session_id) : null;
  if (lane) return withLane(lane, () => onHookEventFor(msg, lane));
  const ours = readState().session_id;
  if (!msg || (msg.session_id && ours && msg.session_id !== ours)) return; // someone else working in /root/joya-ai
  return onHookEventFor(msg, null);
}
function onHookEventFor(msg, lane) {
  if (features.hooks.onHook(msg)) return;
  if (msg.event === "PostToolUse" && msg.tool_name === "SendMessage") return onSendMessageResult(msg);
  if (msg.event === "UserPromptSubmit") return onInboundPrompt(msg.prompt);
  if (msg.event === "PostToolUse" && msg.tool_name === "ListAgents") return onListAgents(msg);
}

function parseToolResponse(r) {
  if (r && typeof r === "object" && !Array.isArray(r)) return r;
  const text = Array.isArray(r) ? contentText(r) : String(r || "");
  try {
    return JSON.parse(text);
  } catch (_) {
    return { success: !/error|fail|not found|refus/i.test(text), message: text };
  }
}

function onSendMessageResult(msg) {
  const input = msg.tool_input || {};
  const resp = parseToolResponse(msg.tool_response);
  const to = String(input.to || "");
  const name = peers.bareName(to);
  // The ref ListAgents gave ("Name [ref]") names the session even after a rename; a sub-agent id or a
  // Remote Control ref is never pinned to a local process.
  const ref = targets.refOf(to);
  const known = ref ? agentRefs[ref] : null;
  const lookName = known && known.name ? known.name : name;
  const pre = targets.kindFor({ to, refs: agentRefs, subagents: agentSubagents });
  const target = pre === "subagent" || pre === "remote" ? null : findSession({ name: lookName }) || (lookName !== name ? findSession({ name }) : null);
  const kind = targets.kindFor({ to, refs: agentRefs, subagents: agentSubagents, session: target });
  const ok = resp.success !== false && !!resp.msg_id;
  const d = ledger.addDelegation({
    msg_id: resp.msg_id || null,
    tool_use_id: msg.tool_use_id,
    turn_id: currentTurnId(),
    target: to,
    target_name: name,
    target_pid: target ? target.pid : null,
    target_session: target ? target.session_id : null,
    target_kind: kind,
    target_ref: ref,
    text: String(input.message || ""),
    summary: input.summary || null,
    notify_idle: !!input.notify_when_idle,
    status: ok ? "sent" : "failed",
    note: ok ? null : clip(resp.message || resp.error || "SendMessage failed", 500),
  });
  if (d) emitDelegation(d);
  if (d && ctxLane && ctxLane.delegs) ctxLane.delegs.add(d.id); // a lane holding an open delegation is kept (its reply comes back to it)
  // Unknown or ambiguous name: look at the sessions again first, then pin it only if it is now unique.
  if (d && !target && kind !== "subagent" && kind !== "remote") {
    refreshSessions(() => {
      const t = findSession({ name: lookName }) || (lookName !== name ? findSession({ name }) : null);
      if (!t) return;
      const cur = ledger.get("delegations", d.id);
      if (!cur || cur.target_session || cur.target_pid) return;
      const upd = ledger.updateDelegation(d.id, { target_pid: t.pid, target_session: t.session_id, target_kind: "local" });
      if (upd) emitDelegation(upd);
    });
  } else refreshSessions();
}

function onInboundPrompt(prompt) {
  for (const p of peers.parsePrompt(prompt)) {
    const open = ledger.openDelegationsFor({ pid: p.from_pid, name: p.from_name });
    const d = open[0] || null;
    const row = ledger.addInbound({ kind: p.kind, from_name: p.from_name, from_pid: p.from_pid, text: clip(p.text, 20000), delegation_id: d && d.id });
    emit("inbound", { inbound: row, state: p.state || null });
    if (!d) continue;
    let upd = null;
    if (p.kind === "message") {
      upd = ledger.updateDelegation(d.id, {
        status: "ack",
        replied_at: now(),
        reply_text: clip(((d.reply_text ? d.reply_text + "\n\n" : "") + p.text), 20000),
        working_at: d.working_at || now(),
      });
    } else if (p.kind === "idle") {
      upd =
        p.state === "expired"
          ? ledger.updateDelegation(d.id, { status: "failed", failed_at: now(), note: "idle subscription expired without a signal" })
          : ledger.updateDelegation(d.id, { status: "done", done_at: now(), note: p.state === "exited" ? "session exited" : "idle notice", reply_text: d.reply_text || clip(p.text, 20000) });
    } else if (p.kind === "delivery") {
      upd =
        p.state === "refused"
          ? ledger.updateDelegation(d.id, { status: "failed", failed_at: now(), note: clip(p.text, 500) })
          : p.state === "held"
          ? ledger.updateDelegation(d.id, { status: "held", note: "held by the target for its user's approval" })
          : null;
    }
    if (upd) emitDelegation(upd);
  }
}

/* --------------------------------------------------------------- sessions --- */

let sessionsBusy = false;
let lastSessionsSig = "";

function readRegistry() {
  const out = new Map();
  try {
    for (const f of fs.readdirSync(SESSIONS_DIR)) {
      if (!f.endsWith(".json")) continue;
      try {
        const r = JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR, f), "utf8"));
        if (r.pid) out.set(r.pid, r);
      } catch (_) {
        /* half-written */
      }
    }
  } catch (_) {
    /* none */
  }
  return out;
}

function where(reg, kind) {
  if (!reg) return kind || "session";
  if (reg.entrypoint === "claude-desktop") return reg.bridgeSessionId ? "Claude Desktop · Remote Control" : "Claude Desktop";
  if (reg.entrypoint === "sdk-cli") return reg.bridgeSessionId ? "Headless · Remote Control" : "Headless";
  if (reg.entrypoint === "cli") return reg.bridgeSessionId ? "Terminal · Remote Control" : "Terminal";
  return reg.entrypoint || kind || "session";
}

/**
 * Sub-agents run inside their parent session's own CLI process (spawned via
 * the Agent/Task tool) and never register in ~/.claude/sessions, so
 * `claude agents --json` never sees them. The only outside sign of one at
 * work is its own transcript file under the parent session's `subagents/`
 * directory, growing without a final answer yet -- the same evidence the
 * dashboard's `cc-running` privileged helper reads for /claude/running
 * (joya-helper `cc_subagents`/`cc_running`). This supervisor runs as root
 * with HOME=/root already, so it can read these files directly with no
 * helper hop.
 */
const SUBAGENT_FILE_RE = /^agent-([A-Za-z0-9_-]{1,64})\.jsonl$/;
const SUBAGENT_SLUG_RE = /^[A-Za-z0-9_.-]{1,255}$/;
const SUBAGENT_RUNNING_WINDOW_S = 120; // a subagent file written this recently may still be working

function readTail(filePath, maxBytes) {
  const fd = fs.openSync(filePath, "r");
  try {
    const size = fs.fstatSync(fd).size;
    const start = Math.max(0, size - maxBytes);
    const buf = Buffer.alloc(size - start);
    if (buf.length) fs.readSync(fd, buf, 0, buf.length, start);
    return buf.toString("utf8");
  } finally {
    fs.closeSync(fd);
  }
}

/** done | running | stopped, from the last assistant record's stop reason. */
function subagentStatus(filePath, mtimeMs) {
  const recent = (Date.now() - mtimeMs) / 1000 < SUBAGENT_RUNNING_WINDOW_S;
  let tail;
  try {
    tail = readTail(filePath, 128 * 1024);
  } catch (_) {
    return recent ? "running" : "stopped";
  }
  const lines = tail.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line) continue;
    let rec;
    try {
      rec = JSON.parse(line);
    } catch (_) {
      continue;
    }
    if (rec.type === "assistant") {
      const stop = rec.message && rec.message.stop_reason;
      return stop === "end_turn" ? "done" : recent ? "running" : "stopped";
    }
  }
  return recent ? "running" : "stopped";
}

/** Every sub-agent transcript under one session directory, newest last. */
function sessionSubagents(sdir) {
  const adir = path.join(sdir, "subagents");
  let names;
  try {
    if (!fs.lstatSync(adir).isDirectory()) return [];
    names = fs.readdirSync(adir);
  } catch (_) {
    return [];
  }
  const out = [];
  for (const name of names) {
    const m = SUBAGENT_FILE_RE.exec(name);
    if (!m) continue;
    const p = path.join(adir, name);
    let st;
    try {
      st = fs.lstatSync(p);
    } catch (_) {
      continue;
    }
    if (!st.isFile()) continue;
    let meta = {};
    try {
      const mp = path.join(adir, `agent-${m[1]}.meta.json`);
      const mst = fs.lstatSync(mp);
      if (mst.isFile()) meta = JSON.parse(fs.readFileSync(mp, "utf8")) || {};
    } catch (_) {
      /* no meta yet, or unreadable -- name/description just come back null */
    }
    out.push({
      id: m[1],
      type: meta.agentType || null,
      description: meta.description || null,
      background: meta.requestShape === "background",
      bytes: st.size,
      modified: st.mtime.toISOString(),
      status: subagentStatus(p, st.mtimeMs),
    });
  }
  out.sort((a, b) => a.modified.localeCompare(b.modified));
  return out;
}

/**
 * A cheap snapshot poll (not a tail of every transcript continuously): walk
 * every session directory under ~/.claude/projects once, keep only sub-agents
 * still "running", keyed by their parent session's id. Cost is one readdir
 * per project + per session + per subagents dir, which on this box is a few
 * hundred entries -- fine on the same 5s cadence as refreshSessions.
 */
function refreshSubagents() {
  const bySession = new Map();
  let slugs;
  try {
    slugs = fs.readdirSync(PROJECTS_DIR);
  } catch (_) {
    subagentsCache = bySession;
    return;
  }
  for (const slug of slugs) {
    if (!SUBAGENT_SLUG_RE.test(slug)) continue;
    const pdir = path.join(PROJECTS_DIR, slug);
    let sessDirs;
    try {
      if (!fs.lstatSync(pdir).isDirectory()) continue;
      sessDirs = fs.readdirSync(pdir);
    } catch (_) {
      continue;
    }
    for (const sess of sessDirs) {
      if (!SUBAGENT_SLUG_RE.test(sess)) continue; // real session ids are UUIDs; the same charset guard is enough
      const agents = sessionSubagents(path.join(pdir, sess)).filter((a) => a.status === "running");
      if (agents.length) bySession.set(sess, agents);
    }
  }
  subagentsCache = bySession;
}

const sessionsWaiters = [];
/** Re-read the sessions; `then` (optional) runs once the cache has the new list (or the read failed). */
function refreshSessions(then) {
  if (typeof then === "function") sessionsWaiters.push(then);
  if (sessionsBusy) return;
  sessionsBusy = true;
  const done = () => {
    for (const fn of sessionsWaiters.splice(0)) {
      try {
        fn();
      } catch (e) {
        log("sessions waiter: " + e.message);
      }
    }
  };
  refreshSubagents();
  execFile(cfg.cli, ["agents", "--json"], { timeout: 20000, env: childEnv(), maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
    sessionsBusy = false;
    if (err) {
      sessionsCache = { ...sessionsCache, error: err.message };
      return done();
    }
    let list;
    try {
      list = JSON.parse(stdout);
    } catch (e) {
      sessionsCache = { ...sessionsCache, error: "could not parse claude agents --json" };
      return done();
    }
    const reg = readRegistry();
    const ours = readState().session_id;
    // Joya's own throwaway CLIs (the usage probe) are not sessions: never listed, never a sphere.
    list = list.filter((a) => !targets.isInternal(a));
    const merged = list.map((a) => {
      const r = reg.get(a.pid);
      return {
        pid: a.pid,
        session_id: a.sessionId,
        name: a.name || null,
        cwd: a.cwd || null,
        kind: a.kind || null,
        status: a.status || null,
        waiting_for: a.waitingFor || null,
        started_at: a.startedAt ? new Date(a.startedAt).toISOString() : null,
        status_since: r && r.statusUpdatedAt ? new Date(r.statusUpdatedAt).toISOString() : null,
        where: where(r, a.kind),
        cli_version: r ? r.version : null,
        remote_control: !!(r && r.bridgeSessionId),
        self: a.sessionId === ours || a.pid === proc.pid,
      };
    });
    // Our own session is found by id / pid. Failing that (a state file not yet
    // written after a fresh start), the session in our home directory carrying
    // one of our names -- JOYA AI, or JOYA AI before the rename -- is us.
    if (!merged.some((s) => s.self)) {
      const byName = merged.find((s) => names.isSelfName(s.name) && s.cwd === cfg.cwd);
      if (byName) byName.self = true;
    }
    sessionsCache = { at: now(), list: merged, error: null };
    features.hooks.onSessions(merged);
    advanceDelegations(merged);
    const sig = JSON.stringify(
      merged.map((s) => [
        s.pid,
        s.status,
        s.name,
        s.waiting_for,
        (subagentsCache.get(s.session_id) || []).map((a) => [a.id, a.status]),
        // the mission tint and cost change without the session changing
        JSON.stringify(features.sessionExtras(s)),
      ])
    ) + JSON.stringify(ledger.hiredList(false).map((h) => [h.session_id, h.status, h.kept])); // a keep / retire changes the view
    if (sig !== lastSessionsSig) {
      lastSessionsSig = sig;
      emit("sessions", { sessions: sessionsWithLedger() });
    }
    done();
  });
}

/**
 * Move open delegations along from what the sessions list shows: a target seen
 * busy is working; one that has gone idle since we sent is done; one that has
 * vanished failed.
 */
function advanceDelegations(list) {
  for (const d of ledger.openDelegations()) {
    // Session id, then pid, then a unique normalised name (lib/targets.js).
    const s = targets.openTarget(d, list);
    let upd = null;
    if (!s) {
      // Only a local session we had pinned can be "no longer running"; a remote, sub-agent or unknown
      // target is not in this machine's list at all -- it stays sent until its ack or idle notice.
      if (targets.mayFail(d)) upd = ledger.updateDelegation(d.id, { status: "failed", failed_at: now(), note: "the target session is no longer running" });
    } else if (s.status === "busy" || s.status === "waiting") {
      // (Never pins target_pid from a name match: a namesake could be the wrong one.)
      if (d.status === "sent") upd = ledger.updateDelegation(d.id, { status: "working", working_at: now() });
    } else if (s.status === "idle") {
      const since = s.status_since ? Date.parse(s.status_since) : 0;
      const sent = Date.parse(d.created_at);
      if ((d.status === "working" || d.status === "ack") || (d.status === "sent" && since > sent + 500)) {
        upd = ledger.updateDelegation(d.id, { status: "done", done_at: now(), note: d.note || "target went idle" });
      }
    }
    if (upd) emitDelegation(upd);
  }
}

function sessionsWithLedger() {
  const hiredBySession = new Map(ledger.hiredList(false).map((h) => [h.session_id, h]));
  return (sessionsCache.list || []).map((s) => {
    // By session id first (a restart -- a new pid -- keeps them), then pid, then the name for rows that pinned neither.
    const MATCH = "(target_session = @sid OR (target_session IS NULL AND (target_pid = @pid OR (target_pid IS NULL AND target_name = @name))))";
    const args = { sid: s.session_id || "", pid: s.pid || -1, name: s.name || "" };
    const last = ledger.prep(`SELECT * FROM delegations WHERE ${MATCH} ORDER BY id DESC LIMIT 1`).get(args);
    const open = ledger.prep(`SELECT count(*) AS n FROM delegations WHERE status IN ('sent','working','ack','held') AND ${MATCH}`).get(args).n;
    const today = ledger.prep(`SELECT count(*) AS n FROM delegations WHERE created_at >= @since AND ${MATCH}`).get({ ...args, since: new Date(Date.now() - 24 * 3600 * 1000).toISOString() }).n;
    const hd = s.session_id ? hiredBySession.get(s.session_id) : null;
    return {
      ...s,
      // Hired through JOYA AI (M-6): no ring and a "hired" tag unless the administrator keeps it.
      hired: !!(hd && !hd.kept),
      hire: hd ? publicHired(hd) : null,
      open_delegations: open,
      delegations_today: today,
      last_delegation: last ? publicDelegation(last) : null,
      subagents: (s.session_id && subagentsCache.get(s.session_id)) || [],
      ...features.sessionExtras(s),
    };
  });
}

/* ----------------------------------------------------------------- vitals --- */

let cpuPrev = null;
function vitals() {
  const cpus = os.cpus();
  const tot = cpus.reduce(
    (a, c) => {
      const t = Object.values(c.times).reduce((x, y) => x + y, 0);
      return { idle: a.idle + c.times.idle, total: a.total + t };
    },
    { idle: 0, total: 0 }
  );
  let cpu = null;
  if (cpuPrev) {
    const dt = tot.total - cpuPrev.total;
    cpu = dt > 0 ? Math.round(100 * (1 - (tot.idle - cpuPrev.idle) / dt)) : null;
  }
  cpuPrev = tot;
  let memTotal = os.totalmem();
  let memAvail = os.freemem();
  try {
    const mi = fs.readFileSync("/proc/meminfo", "utf8");
    const m = /MemAvailable:\s+(\d+)/.exec(mi);
    if (m) memAvail = Number(m[1]) * 1024;
  } catch (_) {
    /* fall back to freemem */
  }
  let disk = null;
  try {
    const s = fs.statfsSync("/");
    disk = { total: s.blocks * s.bsize, free: s.bavail * s.bsize, pct: Math.round(100 * (1 - s.bavail / s.blocks)) };
  } catch (_) {
    /* no statfs */
  }
  return {
    cpu_pct: cpu,
    cpus: cpus.length,
    load: os.loadavg().map((x) => Math.round(x * 100) / 100),
    mem: { total: memTotal, available: memAvail, pct: Math.round(100 * (1 - memAvail / memTotal)) },
    disk,
    uptime_s: Math.round(os.uptime()),
    host: os.hostname(),
  };
}
let vitalsCache = vitals();

/**
 * Claude plan usage, as Claude Code's /usage shows it (lib/usage.js): asked of
 * JOYA AI's own CLI with the get_usage control request, or of a throwaway CLI
 * when JOYA AI is not running. No credential is read or passed here.
 */
const planUsage = planUsageLib.createPlanUsage({
  live: () => (proc.child && proc.state === "ready" ? sendControl({ subtype: "get_usage", skip_behaviors: true }, 20000) : null),
  fallback: () => {
    const env = childEnv();
    for (const k of Object.keys(env)) if (k.startsWith("JOYA_AI_")) delete env[k];
    return planUsageLib.probe(cfg.cli, { env, cwd: os.tmpdir() });
  },
});

const features = createFeatures({
  ledger,
  cfg,
  emit,
  queueTurn: (t) => queueTurn(t),
  log,
  warn,
  vitals: () => vitalsCache,
  sessions: () => sessionsCache.list || [],
  sessionsWithLedger: () => sessionsWithLedger(),
  selfSessionId: () => readState().session_id || null,
  selfSessionIds: () => selfSessionIds(),
  currentTurnId: () => currentTurnId(),
  projectsDir: PROJECTS_DIR,
  describeTool: (n, i) => describeTool(n, i),
  planUsage: (o) => planUsage.get(o),
  isHuman: (a) => isHuman(a),
  onCapPause: (e, o) => onCapPause(e, o),
  onCapResume: (e, why, held) => onCapResume(e, why, held),
});

/*
 * The user's own computers (Path A laptop control, lib/machines.js): sessions JOYA AI runs on a linked
 * computer under a control lease. The dashboard relays; the cards are the hired sessions' own.
 */
const machines = machinesLib.create({
  ledger,
  emit,
  log,
  queueTurn: (t) => queueTurn(t),
  raiseCard: (h, p, gate) => sessionCard(h, p, gate),
  isPaused: (slug) => !!(features.caps && features.caps.isPaused(slug)),
  limits: () => hireLimits(),
  liveSessions: () => sessionsCache.list || [],
  publicHired: (h) => publicHired(h),
});
/** Who may take over a computer: the administrator, or JOYA AI answering the administrator's own request. */
function takeOverPolicy(actor) {
  if (isHuman(actor)) return { ok: true };
  if (actor !== "joya-ai") return { ok: false, why: "only JOYA AI or the administrator can take over a computer" };
  const r = runningTurn();
  if (!r) return { ok: false, why: "no turn is running: taking over a computer answers the administrator's own request, during it" };
  if (r.source === "dashboard") return { ok: true };
  if (r.source === "voice-desk") {
    if (turnVp.get(r.id) === "command") return { ok: true };
    return { ok: false, why: "by voice only when the voiceprint recognises someone who may give commands (it did not, or voiceprint is off): ask them to type it in the Command Center or press Take over in Joya > Machines" };
  }
  return { ok: false, why: "this turn was not started by the administrator (typed in the Command Center, or said aloud and recognised), so it cannot take over a computer" };
}
function machineTellPolicy(actor) {
  if (!(actor === "joya-ai" || isHuman(actor))) throw new Error("only JOYA AI or the administrator can do that");
}

/* ------------------------------------------------------------ public views --- */

/**
 * A turn's widgets (the living canvas), as stored with its reply: each one checked again by the
 * building blocks on the way out -- a stored widget that no longer passes is left out, never sent.
 */
function turnWidgets(row) {
  if (!row || !row.widgets) return [];
  let list;
  try {
    list = JSON.parse(row.widgets);
  } catch (_) {
    return [];
  }
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const w of list.slice(0, UI_WIDGETS_PER_TURN)) {
    const v = w && JoyaWidgets.validate(w.widget);
    if (v && v.ok) out.push({ id: String(w.id || "").slice(0, 40), at: typeof w.at === "string" ? w.at.slice(0, 30) : null, key: v.key, widget: v.value });
  }
  return out;
}
function publicTurn(row) {
  if (!row) return null;
  return { widgets: turnWidgets(row), id: row.id, source: row.source, actor: row.actor, text: row.text, target: row.target, status: row.status, created_at: row.created_at, started_at: row.started_at, ended_at: row.ended_at, duration_ms: row.duration_ms, cost_usd: row.cost_usd, cost_delta_usd: row.cost_delta_usd == null ? null : row.cost_delta_usd, result_text: row.result_text, error: row.error, order_id: row.order_id || null, mission_id: row.mission_id || null, decision_id: row.decision_id || null, call_id: row.call_id || null, lane: row.lane || null, follows: row.follows || null };
}
function publicDelegation(d) {
  if (!d) return null;
  const { tool_use_id, ...rest } = d;
  return rest;
}
function publicApproval(a) {
  if (!a) return null;
  let input = null;
  try {
    input = JSON.parse(a.input_json);
  } catch (_) {
    input = a.input_json;
  }
  const { input_json, ...rest } = a;
  return { ...rest, input, ...features.approvalExtras({ ...a, input }) };
}

function status() {
  const st = readState();
  return {
    name: cfg.name,
    process: {
      state: proc.state,
      pid: proc.pid,
      started_at: proc.startedAt,
      ready_at: proc.readyAt,
      restarts: proc.restarts,
      last_exit: proc.lastExit,
      error: proc.error,
      cli: cfg.cli,
      cli_version: proc.cliVersion,
      cli_pinned: cfg.cli_version,
      model: cfg.model,
      effort: cfg.effort,
      permission_mode: cfg.permission_mode,
      cwd: cfg.cwd,
      tz: cfg.tz,
    },
    session_id: st.session_id || null,
    session_created_at: st.created_at || null,
    previous_session_id: st.previous_session_id || null,
    init: st.last_init || null,
    busy: !!turns.running,
    current_turn: turns.running ? { ...publicTurn(ledger.get("turns", turns.running.id)), steps: turns.running.steps } : null,
    queued: turnQueue.order(turns.pending, Date.now(), cfg.queue_background_max_wait_s * 1000).map((p) => ({ ...publicTurn(p.row), priority: turnQueue.classOf(p.row) })),
    remote_control: { enabled: rc.enabled, state: rc.state, url: rc.enabled ? rc.url : null, error: rc.error },
    approvals: ledger.pendingApprovals().map(publicApproval),
    counts: { ...ledger.counts(), ...features.counts() },
    machine: features.machine(),
    cost_today: features.costToday(),
    tokens_today: (() => {
      try {
        return features.tokensToday(null); // JOYA AI's own, from its transcripts
      } catch (_) {
        return null;
      }
    })(),
    vitals: vitalsCache,
    sessions_at: sessionsCache.at,
    approval_timeout_s: approvalTimeoutS(),
    // Paused at its daily token cap (build spec §6): the Command Center says "Paused at its daily cap -- Resume".
    paused_at_cap: features.caps.selfPaused(),
    // A live call's small sessions (lib/voicelane.js).
    voice_lanes: [...lanes.values()].map((l) => l.view()),
    delegation_allow: cfg.delegation_allow,
    seq,
  };
}

/**
 * The voice front desk's read-only snapshot (lib/snapshot.js). `turns` are the
 * desk's own earlier requests: only voice-desk turns by this same actor are
 * returned, so one panel user cannot read another's.
 */
function snapshotFor(actor, turnIds) {
  const m = features.machine();
  let requests;
  if (turnIds && turnIds.length) {
    requests = turnIds
      .map((id) => ledger.get("turns", id))
      .filter((r) => r && ((r.source === "voice-desk" && r.actor === actor) || (r.call_id && r.voice_actor === actor))); // a call's agent replies too
  }
  return buildSnapshot({
    now: now(),
    tz: cfg.tz,
    serverTz: SERVER_TZ,
    deploys,
    host: m.host,
    vitals: vitalsCache,
    services: features.serviceList(),
    servicesAt: m.services.at,
    servicesError: m.services.error,
    sessions: sessionsCache.list || [],
    process: { state: proc.state, busy: !!turns.running, queued: turns.pending.length },
    missions: features.missions.list({ status: "active", limit: 10 }),
    decisions: features.ops.decisions({ status: "open", limit: 50 }).decisions,
    approvals: ledger.pendingApprovals(),
    requests,
  });
}

/* ------------------------------------------------------------------ socket --- */

async function handle(req, sock) {
  const p = req.params;
  switch (req.op) {
    case "ping":
      return { pong: true, at: now() };
    case "status":
      return status();
    case "sessions":
      if (!sessionsCache.at) await new Promise((r) => setTimeout(r, 400));
      return { at: sessionsCache.at, error: sessionsCache.error, sessions: sessionsWithLedger() };
    case "snapshot":
      return snapshotFor(req.actor, p.turns);
    case "rc-url":
      return { enabled: rc.enabled, state: rc.state, url: rc.enabled ? rc.url : null, bridge_session_id: rc.enabled ? rc.bridgeSessionId : null };
    case "ledger":
      return {
        table: p.table,
        rows: ledger
          .list(p.table, p)
          .map((r) => (p.table === "approvals" ? publicApproval(r) : p.table === "delegations" ? publicDelegation(r) : p.table === "turns" ? { ...r, widgets: turnWidgets(r) } : r))
          .map(redactDeep),
      };
    case "events": {
      const since = p.since || 0;
      sock.write(protocol.reply(req.id, { subscribed: true, seq }));
      for (const ev of ring) if (ev.seq > since) sock.write(JSON.stringify({ event: ev }) + "\n");
      viewers.add(sock);
      sock.on("close", () => viewers.delete(sock));
      return undefined; // reply already written
    }
    case "send": {
      // Addressed to the assistant itself by any of its names (JOYA AI, or the
      // old JOYA AI during the transition): that is no delegation, just a turn.
      const target = p.target && !names.isSelfName(p.target) ? p.target : "auto";
      if (target !== "auto") {
        const live = (sessionsCache.list || []).some((s) => s.name === target && !s.self);
        if (!live) throw new Error(`no live session is named "${target}"`);
      }
      const turn = queueTurn({ source: p.via === "voice-desk" ? "voice-desk" : "dashboard", actor: req.actor, text: p.text, target: target !== "auto" ? target : null, ut: p.ut, call: p.via === "voice-desk" ? p.call : null, vp: p.via === "voice-desk" ? p.vp : undefined });
      if (turn.merged) {
        delete turn.merged;
        return { turn, merged: true, process: proc.state, queued_behind: 0 };
      }
      // How many turns go before this one: whatever is running or handed
      // over, plus the user turns queued ahead of it (background ones wait).
      const ahead = turnQueue.order(turns.pending, Date.now(), cfg.queue_background_max_wait_s * 1000).findIndex((q) => q.row.id === turn.id);
      const current = turns.inflight && turns.inflight.id !== turn.id ? 1 : turns.running ? 1 : 0;
      return { turn, process: proc.state, queued_behind: (ahead > 0 ? ahead : 0) + current };
    }
    case "interrupt": {
      if (!proc.child) throw new Error("JOYA AI is not running");
      await sendControl({ subtype: "interrupt" }, 15000);
      emit("notice", { level: "info", text: `Interrupted by ${req.actor}` });
      return { interrupted: true };
    }
    case "approve": {
      const verified = p.verified ? { verified: p.verified, verified_with: p.verified_with } : null;
      if (p.rule_pattern !== undefined || p.rule_tool !== undefined) {
        if (!p.rule_pattern || !p.rule_tool) throw new Error("an always-allow rule needs rule_pattern and rule_tool");
        return decide(p.approval_id, true, req.actor, p.note, { pattern: p.rule_pattern, tool: p.rule_tool }, verified);
      }
      return { approval: decide(p.approval_id, true, req.actor, p.note, null, verified) };
    }
    case "approval-hold":
      if (!isHuman(req.actor)) throw new Error("only the administrator's panel holds a card");
      return holdApproval(p.approval_id, p.seconds);
    case "deny":
      return { approval: decide(p.approval_id, false, req.actor, p.note) };
    case "rc":
      if (!proc.child || proc.state !== "ready") throw new Error("JOYA AI is not running");
      return await enableRemoteControl(p.enabled, req.actor);
    case "restart": {
      emit("notice", { level: "warn", text: `Restart requested by ${req.actor}` });
      proc.backoff = cfg.backoff_min_s;
      await stopChild();
      // Resume only now that the old process is gone.
      proc.wantRunning = true;
      clearTimeout(proc.timer);
      await start();
      return { restarted: true, state: proc.state };
    }
    case "fresh":
      return await freshStart(req.actor, p);
    case "ui-action":
      return await uiAction(req.actor, p);
    case "ui-widget":
      return await uiWidget(req.actor, p);
    case "session-hire":
      return await sessionHire(req.actor, p);
    case "session-retire":
      return await sessionRetire(req.actor, p);
    case "session-keep":
      return sessionKeep(req.actor, p);
    case "hired":
      return { hired: ledger.hiredList(!!p.all).map(publicHired) };
    case "session-approval":
      return await sessionApproval(req.actor, p);
    case "session-approval-cancel":
      return sessionApprovalCancel(req.actor, p);
    case "session-link":
      return sessionLink(req.actor, p, req, sock);
    case "hire-limits":
      return hireLimitsView();
    case "hire-limits-set":
      return hireLimitsSet(req.actor, p);
    case "approval-timeout":
      return approvalTimeoutView();
    case "approval-timeout-set":
      return approvalTimeoutSet(req.actor, p);
    case "ui-pages":
      return uiPages(req.actor, p);
    case "charter":
      return charter();
    case "machines-sync":
      return machines.sync(req.actor, p);
    case "machines":
      return machines.list();
    case "machine-take-over":
      return machines.takeOver(req.actor, p, takeOverPolicy(req.actor));
    case "machine-tell":
      machineTellPolicy(req.actor);
      return machines.tell(req.actor, p);
    case "machine-release":
      machineTellPolicy(req.actor);
      return machines.release(req.actor, p);
    case "machine-ask":
      return await machines.ask(req.actor, p);
    case "machine-ask-cancel":
      return sessionApprovalCancel(req.actor, p);
    case "machine-report":
      return machines.report(req.actor, p);
    case "machine-state":
      return machines.state(req.actor, p);
    case "voice-warm":
      return voiceWarm(req.actor, p);
    case "deploy-event":
      // The dashboard (re)started (server.js announceStart): remembered for the snapshot, told to JOYA AI once.
      return { noted: noteDeploy(p, req.actor) };
    case "ui-ack": {
      const w = uiWaiting.get(p.nonce);
      if (!w) throw new Error("no such screen action is waiting (or it was answered already)");
      if (w.actor !== req.actor) throw new Error("that screen action is not yours to answer");
      uiWaiting.delete(p.nonce);
      w.resolve({ ok: p.ok, why: p.why || "", pending: !!p.pending });
      return { acked: true };
    }
    default:
      if (Object.prototype.hasOwnProperty.call(features.ops, req.op)) return await features.ops[req.op](p, req);
      throw new Error("unknown op");
  }
}

/* ---------------------------------------------------------- UI control --- */

/*
 * JOYA AI's ui_do (its MCP tool; ui_action until M-5) (UI control, Phase 2). The Command Center mints a
 * one-time ui token for each send the administrator makes and the supervisor
 * keeps it with that turn, in memory. JOYA AI's MCP tool asks for a screen
 * action; the supervisor accepts it only
 *   - from actor "joya-ai" (its own MCP tool),
 *   - while a turn the administrator started (source dashboard / voice-desk)
 *     is running and carries a token -- no watcher, order, scheduler, peer or
 *     Remote Control turn has one,
 *   - for an action on the shared allowlist (lib/ui-actions.js, the same file
 *     as the dashboard's public/ui-actions.js), within its rate limits;
 * then emits it live to the viewers (never into the ring: no replay). The
 * dashboard forwards it only to the tab that holds that token, the page does
 * it and answers (ui-ack). No answer in 5 s: "no Command Center open".
 */
async function uiAction(actor, p) {
  if (actor !== "joya-ai") throw new Error("ui-action is JOYA AI's own tool (actor joya-ai)");
  const running = runningTurn(); // a voice lane's own running turn when the call comes from its MCP
  if (!running) throw new Error("no turn is running: a screen action answers the administrator's own request, during it");
  const tok = uiTokens.get(running.id);
  if (!tok || (running.source !== "dashboard" && running.source !== "voice-desk")) throw new Error("this turn was not started by the administrator from the Command Center, so it cannot change their screen");
  const v = UiActions.validate(p.action, p.args || {});
  if (!v.ok) throw new Error(v.why);
  const lim = uiLimit.take(running.id, v.action, Date.now());
  if (lim) throw new Error(lim);
  const nonce = crypto.randomBytes(12).toString("hex");
  const toast = UiActions.toast(v.action, v.args);
  const answer = new Promise((resolve) => {
    uiWaiting.set(nonce, { actor: tok.actor, resolve });
    setTimeout(() => {
      if (uiWaiting.delete(nonce)) resolve(null);
    }, UI_ACK_MS).unref();
  });
  // The token itself never leaves this process again: viewers get a tag of it
  // (sha256, 16 hex), enough for the dashboard that minted it to match it.
  emitLive("ui", { actor: tok.actor, ut_tag: uiTag(tok.ut), nonce, action: v.action, args: v.args, toast, turn_id: running.id, expires: new Date(Date.now() + UI_ACK_MS).toISOString() });
  const a = await answer;
  if (!a) return { status: "no-screen", note: "No Command Center answered: the administrator's screen is not open. Tell them plainly; do not say it was done." };
  if (!a.ok) return { status: "refused", why: a.why || "the screen refused it", note: "Tell the administrator plainly that it was not done, and why." };
  if (a.pending) return { status: "confirm", note: "Nothing has changed yet: their screen asks them to confirm. Say so, and ask them to say yes or click Confirm; never say it is done." };
  return { status: "ok", done: toast };
}

/*
 * JOYA AI's ui_widget (its MCP tool; the living canvas, 2026-10-20): a widget alongside its answer, for
 * the tab that asked. Exactly the terms of ui_do -- actor joya-ai, during a turn the administrator
 * started from the Command Center with a ui token, live-only, a tag of the token, answered by that
 * administrator's tab -- and the widget is built only from the fixed building blocks (lib/joya-widgets.js,
 * checked by the protocol; never HTML, script, style or a URL). At most 3 a turn, and they count toward
 * the screen actions' per-minute limit. The page may refuse it (a kind they always dismiss): refused.
 */
const uiWidgetCount = new Map(); // turn id -> widgets sent
async function uiWidget(actor, p) {
  if (actor !== "joya-ai") throw new Error("ui-widget is JOYA AI's own tool (actor joya-ai)");
  const running = runningTurn();
  if (!running) throw new Error("no turn is running: a widget goes with your answer to the administrator's own request, during it");
  const tok = uiTokens.get(running.id);
  if (!tok || (running.source !== "dashboard" && running.source !== "voice-desk")) throw new Error("this turn was not started by the administrator from the Command Center, so it cannot put a widget on their screen");
  const n = uiWidgetCount.get(running.id) || 0;
  if (n >= UI_WIDGETS_PER_TURN) throw new Error(`at most ${UI_WIDGETS_PER_TURN} widgets in one turn`);
  const lim = uiLimit.take(running.id + ":w" + n, "widget.show", Date.now());
  if (lim) throw new Error(lim);
  uiWidgetCount.set(running.id, n + 1);
  if (uiWidgetCount.size > 200) uiWidgetCount.delete(uiWidgetCount.keys().next().value);
  const w = p.widget; // checked by lib/protocol.js (widgetSpec)
  const nonce = crypto.randomBytes(12).toString("hex");
  const toast = "JOYA AI added a widget: " + w.title;
  const answer = new Promise((resolve) => {
    uiWaiting.set(nonce, { actor: tok.actor, resolve });
    setTimeout(() => {
      if (uiWaiting.delete(nonce)) resolve(null);
    }, UI_ACK_MS).unref();
  });
  emitLive("ui", { actor: tok.actor, ut_tag: uiTag(tok.ut), nonce, action: "widget.show", args: {}, widget: w, toast, turn_id: running.id, expires: new Date(Date.now() + UI_ACK_MS).toISOString() });
  const a = await answer;
  if (!a) return { status: "no-screen", note: "No Command Center answered: the administrator's screen is not open. Answer in words." };
  if (!a.ok) return { status: "refused", why: a.why || "the screen refused it", note: "The widget was not shown. Answer in words; do not say it is on their screen." };
  // Shown: kept with the reply in the ledger (the conversation's own store), so the conversation shows it
  // again after a reload and in the administrator's other tabs and devices; told to them now.
  try {
    const row = ledger.get("turns", running.id);
    if (row) {
      const list = turnWidgets(row).map((x) => ({ id: x.id, at: x.at, widget: x.widget }));
      if (list.length < UI_WIDGETS_PER_TURN) {
        list.push({ id: nonce, at: new Date().toISOString(), widget: w });
        ledger.update("turns", running.id, { widgets: JSON.stringify(list) });
        emit("turn", { phase: "widget", turn: publicTurn(ledger.get("turns", running.id)) });
      }
    }
  } catch (e) {
    warn("widget not kept with its turn:", e.message);
  }
  return { status: "ok", shown: w.title, note: "It is on their board beside your answer; they may pin, resize or dismiss it. Still say the answer in words." };
}

/**
 * Start JOYA AI in a new conversation: stop the CLI, retire its session id,
 * start with `--session-id <new>`. Never resumes the old id. Only a person may
 * ask for it -- not JOYA AI itself (actor "joya-ai", its own MCP tools) nor
 * the supervisor's internal actors -- and not while it is working, has turns
 * waiting or approvals open, unless `force` says so.
 */
const FRESH_REFUSED_ACTORS = new Set(["joya-ai", "watcher", "supervisor", "flag-file", "scheduler", "order"]);
let freshBusy = false;
async function freshStart(actor, p) {
  if (FRESH_REFUSED_ACTORS.has(actor)) throw new Error(`a fresh start is for the administrator; actor "${actor}" may not ask for one`);
  if (freshBusy) throw new Error("a fresh start is already under way");
  if (!p.force) {
    const why = [];
    if (turns.running) why.push("a turn is running");
    if (turns.inflight) why.push("a turn is being handed over");
    if (turns.pending.length) why.push(`${turns.pending.length} turn(s) queued`);
    const open = ledger.pendingApprovals().length;
    if (open) why.push(`${open} approval(s) pending`);
    if (why.length) throw new Error(`JOYA AI is not idle (${why.join(", ")}); wait, or pass force`);
  }
  freshBusy = true;
  try {
    emit("notice", { level: "warn", text: `Fresh start requested by ${actor}` });
    proc.backoff = cfg.backoff_min_s;
    // Nothing may restart the old session while it is being retired.
    proc.wantRunning = false;
    clearTimeout(proc.timer);
    await stopChild();
    const r = rotateSession(actor, p.reason);
    proc.wantRunning = true;
    clearTimeout(proc.timer);
    await start();
    return { fresh: true, ...r, state: proc.state };
  } finally {
    proc.wantRunning = true;
    freshBusy = false;
  }
}

function serveControl() {
  try {
    fs.unlinkSync(CONTROL_SOCKET);
  } catch (_) {
    /* not there */
  }
  let gid = null;
  try {
    const line = fs.readFileSync("/etc/group", "utf8").split("\n").find((l) => l.startsWith(cfg.socket_group + ":"));
    gid = line ? Number(line.split(":")[2]) : null;
  } catch (_) {
    /* no group file? */
  }
  let conns = 0;
  const server = net.createServer((sock) => {
    if (conns >= 32) return sock.destroy();
    conns++;
    sock.on("close", () => conns--);
    sock.on("error", () => {});
    sock.setEncoding("utf8");
    let buf = "";
    let inflight = 0;
    sock.on("data", (chunk) => {
      buf += chunk;
      if (buf.length > protocol.MAX_LINE * 2) {
        sock.end(protocol.replyError(null, "request too large"));
        return;
      }
      let nl;
      while ((nl = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (!line.trim()) continue;
        if (++inflight > 16) {
          sock.end(protocol.replyError(null, "too many requests in flight"));
          return;
        }
        const parsed = protocol.parseRequest(line);
        if (!parsed.ok) {
          inflight--;
          sock.write(protocol.replyError(parsed.id, parsed.error));
          continue;
        }
        const req = parsed.req;
        Promise.resolve()
          .then(() => (req.lane ? withLane(lanes.get(req.lane) || null, () => handle(req, sock)) : handle(req, sock)))
          .then(
            (data) => {
              if (req.mutating) auditLine(req.actor, req.op, auditDetail(req), true);
              if (data !== undefined && !sock.destroyed) sock.write(protocol.reply(req.id, data));
            },
            (e) => {
              if (req.mutating) auditLine(req.actor, req.op, auditDetail(req), false, e.message);
              if (!sock.destroyed) sock.write(protocol.replyError(req.id, e.message));
            }
          )
          .finally(() => inflight--);
      }
    });
  });
  server.listen(CONTROL_SOCKET, () => {
    fs.chmodSync(CONTROL_SOCKET, 0o660);
    if (gid !== null) fs.chownSync(CONTROL_SOCKET, 0, gid);
    else warn(`group ${cfg.socket_group} does not exist; the socket is root-only`);
    log(`control socket ${CONTROL_SOCKET}`);
  });
  return server;
}

function auditDetail(req) {
  const p = { ...req.params };
  if (p.ut) p.ut = "(set)"; // the ui token is never written down
  if (typeof p.text === "string") p.text = clip(p.text, 300);
  if (Array.isArray(p.pages)) p.pages = `(${p.pages.length} pages)`;
  if (p.widget && typeof p.widget === "object") p.widget = `(widget ${p.widget.kind} "${clip(String(p.widget.title || ""), 80)}", ${(p.widget.blocks || []).length} blocks)`;
  return p;
}

function serveHooks() {
  try {
    fs.unlinkSync(HOOK_SOCKET);
  } catch (_) {
    /* not there */
  }
  const server = net.createServer((sock) => {
    sock.setEncoding("utf8");
    sock.on("error", () => {});
    let buf = "";
    sock.on("data", (c) => {
      buf += c;
      if (buf.length > 2 * 1024 * 1024) sock.destroy();
    });
    sock.on("end", () => {
      for (const line of buf.split("\n")) {
        if (!line.trim()) continue;
        try {
          onHookEvent(JSON.parse(line));
        } catch (e) {
          warn("hook event rejected:", e.message);
        }
      }
      sock.end();
    });
  });
  server.listen(HOOK_SOCKET, () => {
    fs.chmodSync(HOOK_SOCKET, 0o600);
  });
  return server;
}

/** Hook events that arrived while the supervisor was down. */
function drainSpool() {
  const spool = path.join(cfg.state_dir, "hook-spool.jsonl");
  let text = "";
  try {
    text = fs.readFileSync(spool, "utf8");
    fs.unlinkSync(spool);
  } catch (_) {
    return;
  }
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      onHookEvent(JSON.parse(line));
    } catch (_) {
      /* skip */
    }
  }
}

/* -------------------------------------------------------------------- main --- */

/**
 * The queue survives a supervisor restart: a turn of ours that was still
 * queued and never handed to the CLI (no sent_at) cannot have been answered,
 * so it goes back in the queue, in its old place. One that was handed over,
 * or was running, may or may not be in the resumed transcript -- replaying it
 * could run it twice -- so it is marked lost, as before. So is anything older
 * than queue_requeue_max_age_s.
 */
function requeueAfterRestart() {
  const t = now();
  const cutoff = Date.now() - cfg.queue_requeue_max_age_s * 1000;
  const rows = ledger.db.prepare("SELECT * FROM turns WHERE status IN ('queued','running') ORDER BY id").all();
  let kept = 0;
  for (const row of rows) {
    const fresh = Date.parse(row.created_at) >= cutoff;
    if (row.status === "queued" && !row.sent_at && OUR_SOURCES.has(row.source) && row.uuid && fresh) {
      turns.pending.push({ row, message: userMessage(row) });
      kept++;
    } else {
      ledger.updateTurn(row.id, { status: "lost", ended_at: t, error: row.status === "queued" && !fresh ? "too old to replay after a supervisor restart" : "supervisor restarted" });
    }
  }
  if (kept) log(`re-queued ${kept} turn(s) the previous supervisor had not handed over`);
}

async function main() {
  if (process.getuid && process.getuid() !== 0 && !process.env.JOYA_AI_ALLOW_NONROOT) {
    throw new Error("joya-ai must run as root: JOYA AI shares root's Claude session registry");
  }
  takeLock();
  fs.mkdirSync(cfg.run_dir, { recursive: true });
  try {
    const line = fs.readFileSync("/etc/group", "utf8").split("\n").find((l) => l.startsWith(cfg.socket_group + ":"));
    if (line) {
      fs.chownSync(cfg.run_dir, 0, Number(line.split(":")[2]));
      fs.chmodSync(cfg.run_dir, 0o750);
    }
  } catch (e) {
    warn("could not set run dir ownership:", e.message);
  }

  // Anything the previous supervisor left pending can no longer be answered.
  for (const a of ledger.pendingApprovals()) ledger.updateApproval(a.id, { status: "cancelled", decided_at: now(), note: "supervisor restarted" });
  requeueAfterRestart();

  const control = serveControl();
  const hooks = serveHooks();
  drainSpool();

  refreshSessions();
  const pollSessions = setInterval(refreshSessions, cfg.sessions_poll_s * 1000);
  const pollLanes = setInterval(sweepLanes, 30000);
  const pollVitals = setInterval(() => {
    vitalsCache = vitals();
    emit("vitals", { vitals: vitalsCache });
  }, 5000);

  features.start();
  loadPages();
  // JOYA AI hears of this start (and what was deployed) with its next turn.
  const own = deployedStamp(path.join(__dirname, "DEPLOYED"));
  noteDeploy({ component: "joya-ai", started_at: now(), commit: /^[0-9a-f]{7,40}$/.test(own.commit || "") ? own.commit : null, deployed_at: own.deployed_at || null }, "supervisor");
  await start();

  let stopping = false;
  const shutdown = async (sig) => {
    if (stopping) return;
    stopping = true;
    log(`${sig}: stopping`);
    proc.wantRunning = false;
    clearTimeout(proc.timer);
    clearInterval(pollSessions);
    clearInterval(pollVitals);
    clearInterval(pollLanes);
    await closeAllLanes(6000);
    features.stop();
    control.close();
    hooks.close();
    for (const v of viewers) v.destroy();
    await stopChild(15000);
    for (const f of [CONTROL_SOCKET, HOOK_SOCKET]) {
      try {
        fs.unlinkSync(f);
      } catch (_) {
        /* gone */
      }
    }
    ledger.close();
    releaseLock();
    process.exit(0);
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

if (require.main === module) {
  main().catch((e) => {
    console.error(new Date().toISOString(), "FATAL", e.message);
    releaseLock();
    process.exit(1);
  });
}

