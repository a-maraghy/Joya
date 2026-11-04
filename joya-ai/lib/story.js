"use strict";
/**
 * The session story (2026-10-20): what a session did, read from what is on
 * disk and in the ledger -- never invented.
 *
 *   - a session's story (op "session-story"): its plan as steps (a mission's
 *     steps, else its todo list, else the turns it was given), the files it
 *     changed with the +/- lines Claude Code recorded (structuredPatch), the
 *     approvals it asked for (the transcript's permissionDecision, and the
 *     ledger's cards for JOYA AI and hired sessions), the tokens on its
 *     assistant messages (once per message id), the time it was active, the
 *     sub-agents it started and the hand-offs in and out;
 *   - the day (op "story-day"): every session's activity in 5-minute bins,
 *     the hand-offs between sessions (JOYA AI's delegations and replies from
 *     the ledger, SendMessage between sessions from the transcripts) and the
 *     approvals, for the Command Center's day timeline.
 *
 * Transcripts are parsed incrementally (a byte offset per file, like the cost
 * scanner) and yield to the event loop between chunks, so a 20 MB transcript
 * does not stall the supervisor. The parsed state is kept per file (bounded);
 * the day's answer is cached for a few seconds. Everything is read-only.
 *
 * What the data does not have is left out: a session with no plan shows its
 * turns (each one a real prompt), not made-up steps; an interactive session's
 * approvals exist only where Claude Code wrote a permissionDecision.
 */

const fs = require("fs");
const path = require("path");
const schedule = require("./schedule");
const { redact, redactDeep, clip } = require("./redact");

const BIN_MS = 5 * 60 * 1000;
const IDLE_GAP_MS = 5 * 60 * 1000; // a quiet spell longer than this is not counted as active time
const CHUNK = 4 * 1024 * 1024;
const MAX_FILE = 256 * 1024 * 1024;
const MAX_STATES = 64;
const KEEP = { turns: 3000, fileEvents: 3000, approvals: 1000, questions: 300, agents: 500, sends: 1000, inbound: 1000, todoSnaps: 400 };
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const AGENT_ID_RE = /^a?[0-9a-f]{15,20}$/;

/* ================================================================ parsing === */

function newState(sid) {
  return {
    sid,
    off: 0,
    ino: null,
    title: null,
    cwd: null,
    first: null,
    last: null,
    activeMs: 0,
    msgIds: new Set(),
    toolsById: new Map(), // tool_use_id -> { name, t, summary } (bounded)
    tools: {},
    turns: [],
    files: new Map(),
    fileEvents: [],
    approvals: [],
    questions: [],
    agents: [],
    sends: [],
    inbound: [],
    tokens: { input: 0, output: 0, cache_read: 0, cache_write: 0 },
    bins: new Map(), // bin index (ms / BIN_MS) -> [records, tokens]
    todos: new Map(), // todo key -> { title, status, t0, t1, order }
    todoOrder: 0,
    todoSnaps: [],
    tasks: new Map(), // TaskCreate ids -> todo key
    taskSeq: 0,
    subMsgs: 0,
  };
}

function push(arr, v, max) {
  arr.push(v);
  if (arr.length > max * 1.25) arr.splice(0, arr.length - max);
}

function iso(ms) {
  return ms == null || !isFinite(ms) ? null : new Date(ms).toISOString();
}

/** The text of a user record (string or text blocks), or "" for tool results and meta lines. */
function promptText(rec) {
  const c = rec.message && rec.message.content;
  if (typeof c === "string") return c;
  if (!Array.isArray(c)) return "";
  if (c.some((b) => b && b.type === "tool_result")) return "";
  return c
    .filter((b) => b && b.type === "text" && typeof b.text === "string")
    .map((b) => b.text)
    .join("\n");
}

/** A prompt's title: its first line that is not markup, clipped. Null for lines that are not a task. */
function promptTitle(text) {
  const s = String(text || "");
  if (!s.trim()) return null;
  if (/^\s*<(command-name|command-message|local-command-stdout|local-command-caveat|bash-input|bash-stdout|bash-stderr)\b/.test(s)) return null;
  if (/^\s*Caveat: The messages below were generated/.test(s)) return null;
  if (/\[Cross-session (idle|delivery) notice\]/.test(s)) return null;
  const body = s
    .replace(/<cross-session-message\b[^>]*>/g, "")
    .replace(/<\/cross-session-message>/g, "")
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "")
    .replace(/<[a-z-]+>[\s\S]*?<\/[a-z-]+>/g, (m) => (/^<(task-notification|tool-use-error)/.test(m) ? "" : m));
  const line = body
    .split("\n")
    .map((l) => l.replace(/^[#>*\-\s]+/, "").trim())
    .find((l) => l && !/^\[(Request interrupted|Image #\d)/.test(l));
  return line ? clip(redact(line), 110) : null;
}

/** <cross-session-message from-name="X" ...>: who handed this over. */
function peerFrom(text) {
  const m = /<cross-session-message\b[^>]*\bfrom-name="([^"]{1,120})"/.exec(String(text || ""));
  return m ? m[1] : null;
}

function bump(st, ms, tok) {
  const k = Math.floor(ms / BIN_MS);
  const b = st.bins.get(k);
  if (b) {
    b[0] += 1;
    b[1] += tok;
  } else st.bins.set(k, [1, tok]);
}

function countPatch(hunks) {
  let add = 0;
  let del = 0;
  for (const h of Array.isArray(hunks) ? hunks : []) {
    for (const l of (h && Array.isArray(h.lines) && h.lines) || []) {
      if (typeof l !== "string") continue;
      if (l.charAt(0) === "+" && !l.startsWith("+++")) add++;
      else if (l.charAt(0) === "-" && !l.startsWith("---")) del++;
    }
  }
  return { add, del };
}

function addFile(st, filePath, t, add, del, created, tool) {
  if (!filePath || typeof filePath !== "string") return;
  const p = filePath.slice(0, 500);
  const f = st.files.get(p) || { path: p, add: 0, del: 0, edits: 0, first: t, last: t, created: false };
  f.add += add;
  f.del += del;
  f.edits += 1;
  if (created) f.created = true;
  if (t != null) {
    if (f.first == null || t < f.first) f.first = t;
    if (f.last == null || t > f.last) f.last = t;
  }
  st.files.set(p, f);
  push(st.fileEvents, { t, path: p, add, del, tool: tool || null }, KEEP.fileEvents);
}

/** What a tool result changed on disk, as Claude Code recorded it (toolUseResult). */
function fileChanges(st, tur, t, tool) {
  if (!tur || typeof tur !== "object") return;
  if (typeof tur.filePath === "string" && (Array.isArray(tur.structuredPatch) || tur.type === "create")) {
    const c = countPatch(tur.structuredPatch);
    const created = tur.type === "create";
    if (created && !c.add && typeof tur.content === "string") c.add = tur.content ? tur.content.split("\n").length : 0;
    addFile(st, tur.filePath, t, c.add, c.del, created, tool);
  }
  const bd = tur.bashEditDiff;
  if (bd && Array.isArray(bd.files)) {
    for (const f of bd.files) {
      if (!f || typeof f.filePath !== "string") continue;
      const c = countPatch(f.hunks);
      addFile(st, f.filePath, t, c.add, c.del, false, tool || "Bash");
    }
  }
}

/** A todo list (TodoWrite) or tasks (TaskCreate / TaskUpdate): the step's times follow its status changes. */
function todoSet(st, key, title, status, t) {
  let d = st.todos.get(key);
  if (!d) {
    d = { title: clip(redact(title || key), 140), status: "pending", t0: null, t1: null, order: st.todoOrder++ };
    st.todos.set(key, d);
  }
  if (title) d.title = clip(redact(title), 140);
  if (status === "in_progress" && d.t0 == null) d.t0 = t;
  if (status === "completed") {
    if (d.t0 == null) d.t0 = t;
    if (d.t1 == null) d.t1 = t;
  }
  if (status === "pending") d.t1 = null;
  if (status === "deleted") {
    st.todos.delete(key);
    return;
  }
  d.status = status || d.status;
}
function todoSnap(st, t) {
  push(st.todoSnaps, { t, steps: [...st.todos.values()].sort((a, b) => a.order - b.order).map((d) => ({ title: d.title, status: d.status })) }, KEEP.todoSnaps);
}

function onToolUse(st, b, t, describe) {
  const name = String(b.name || "?");
  const input = b.input || {};
  st.tools[name] = (st.tools[name] || 0) + 1;
  let summary = "";
  try {
    summary = clip(redact(describe ? describe(name, input) : name), 160);
  } catch (_) {
    summary = name;
  }
  if (b.id) {
    st.toolsById.set(b.id, { name, t, summary });
    if (st.toolsById.size > 4000) {
      const drop = [...st.toolsById.keys()].slice(0, 1000);
      for (const k of drop) st.toolsById.delete(k);
    }
  }
  const cur = st.turns[st.turns.length - 1];
  if (cur) cur.tools++;
  if (name === "TodoWrite" && Array.isArray(input.todos)) {
    const seen = new Set();
    for (const it of input.todos) {
      if (!it) continue;
      const title = String(it.content || it.subject || it.activeForm || "").trim();
      if (!title) continue;
      const key = "todo:" + title.toLowerCase();
      seen.add(key);
      todoSet(st, key, title, String(it.status || "pending"), t);
    }
    // TodoWrite sends the whole list: what is no longer in it was dropped.
    for (const k of [...st.todos.keys()]) if (k.startsWith("todo:") && !seen.has(k)) st.todos.delete(k);
    todoSnap(st, t);
  } else if (name === "TaskCreate") {
    const title = String(input.subject || input.description || "").trim();
    if (title) {
      const key = "task:" + ++st.taskSeq;
      st.tasks.set(String(st.taskSeq), key);
      if (b.id) st.tasks.set("use:" + b.id, key);
      todoSet(st, key, title, "pending", t);
      todoSnap(st, t);
    }
  } else if (name === "TaskUpdate") {
    const key = st.tasks.get(String(input.taskId || input.id || ""));
    if (key) {
      todoSet(st, key, input.subject ? String(input.subject) : null, input.status ? String(input.status) : null, t);
      todoSnap(st, t);
    }
  } else if (name === "AskUserQuestion") {
    const q = Array.isArray(input.questions) && input.questions[0] ? input.questions[0].question : input.question;
    push(st.questions, { t, text: clip(redact(String(q || "a question")), 200), n: Array.isArray(input.questions) ? input.questions.length : 1 }, KEEP.questions);
  } else if (name === "Agent" || name === "Task") {
    push(st.agents, { t, description: clip(redact(String(input.description || input.subagent_type || "sub-agent")), 120), type: input.subagent_type ? String(input.subagent_type).slice(0, 60) : null }, KEEP.agents);
  } else if (name === "SendMessage" && input.to) {
    const to = String(input.to).replace(/\s*\[[0-9a-f]{4,12}\]\s*$/i, "").trim();
    // A message to one of its own sub-agents (an agent id) is not a hand-off between sessions.
    if (AGENT_ID_RE.test(to)) st.subMsgs++;
    else push(st.sends, { t, to: clip(to, 120), text: clip(redact(String(input.message || "").split("\n")[0]), 160) }, KEEP.sends);
  }
}

/** One transcript record into the state. */
function parseRecord(st, rec, describe) {
  if (!rec || typeof rec !== "object") return;
  if (rec.type === "custom-title" && rec.customTitle) st.title = clip(String(rec.customTitle), 120);
  else if (rec.type === "agent-name" && rec.agentName && !st.title) st.title = clip(String(rec.agentName), 120);
  if (rec.isSidechain) return;
  if (rec.type !== "user" && rec.type !== "assistant") return;
  if (rec.cwd && typeof rec.cwd === "string") st.cwd = rec.cwd.slice(0, 300);
  const t = Date.parse(rec.timestamp);
  if (!isFinite(t)) return;
  if (st.first == null || t < st.first) st.first = t;
  if (st.last != null && t >= st.last && t - st.last <= IDLE_GAP_MS) st.activeMs += t - st.last;
  if (st.last == null || t > st.last) st.last = t;
  let tok = 0;
  const content = rec.message && rec.message.content;
  if (rec.type === "assistant") {
    const m = rec.message || {};
    const id = m.id || rec.requestId || rec.uuid;
    if (m.usage && id && !st.msgIds.has(id) && m.model !== "<synthetic>") {
      st.msgIds.add(id);
      if (st.msgIds.size > 20000) {
        const keep = [...st.msgIds].slice(-5000);
        st.msgIds = new Set(keep);
      }
      const u = m.usage;
      const i = Number(u.input_tokens) || 0;
      const o = Number(u.output_tokens) || 0;
      const r = Number(u.cache_read_input_tokens) || 0;
      const w = Number(u.cache_creation_input_tokens) || 0;
      st.tokens.input += i;
      st.tokens.output += o;
      st.tokens.cache_read += r;
      st.tokens.cache_write += w;
      tok = i + o + r + w;
    }
    if (Array.isArray(content)) for (const b of content) if (b && b.type === "tool_use") onToolUse(st, b, t, describe);
    const cur = st.turns[st.turns.length - 1];
    if (cur && t > cur.t1) cur.t1 = t;
    bump(st, t, tok);
    return;
  }
  // user
  if (Array.isArray(content) && content.some((b) => b && b.type === "tool_result")) {
    for (const b of content) {
      if (!b || b.type !== "tool_result") continue;
      const tu = st.toolsById.get(b.tool_use_id) || null;
      const errText = b.is_error ? (typeof b.content === "string" ? b.content : Array.isArray(b.content) ? b.content.map((x) => (x && x.text) || "").join(" ") : "") : "";
      const pd = rec.permissionDecision;
      const rejected = /doesn't want to proceed|user rejected|was rejected by the user/i.test(errText);
      if ((pd && typeof pd === "object") || rejected) {
        const src = pd && typeof pd.source === "string" ? pd.source : rejected ? "user" : "";
        const asked = /^user/.test(src) && !(pd && pd.reasonType === "rule");
        const decision = pd && pd.decision ? String(pd.decision) : rejected ? "reject" : "accept";
        // AskUserQuestion's "permission" is the answer to a question (counted under questions), not an approval.
        if ((asked || decision !== "accept") && !(tu && tu.name === "AskUserQuestion"))
          push(st.approvals, { t, tool: tu ? tu.name : null, summary: tu ? tu.summary : "", decision: decision === "accept" ? "approved" : "denied", how: src === "user_permanent" ? "always" : "once", from: "transcript" }, KEEP.approvals);
      }
      if (!b.is_error) fileChanges(st, rec.toolUseResult, t, tu ? tu.name : null);
    }
    const cur = st.turns[st.turns.length - 1];
    if (cur && t > cur.t1) cur.t1 = t;
    bump(st, t, 0);
    return;
  }
  if (rec.isMeta) return;
  const text = promptText(rec);
  const title = promptTitle(text);
  bump(st, t, 0);
  if (!title) {
    const cur = st.turns[st.turns.length - 1];
    if (cur && t > cur.t1) cur.t1 = t;
    return;
  }
  const from = peerFrom(text);
  if (from) push(st.inbound, { t, from: clip(from, 120), text: title }, KEEP.inbound);
  push(st.turns, { t0: t, t1: t, title, from: from ? "peer" : "user", peer: from ? clip(from, 120) : null, tools: 0 }, KEEP.turns);
}

/** Complete JSONL lines into the state. */
function parseLines(st, lines, describe) {
  for (const line of lines) {
    if (!line || line.charCodeAt(0) !== 123) continue; // "{"
    let rec;
    try {
      rec = JSON.parse(line);
    } catch (_) {
      continue;
    }
    parseRecord(st, rec, describe);
  }
  return st;
}

/** Read what was appended to a transcript since the last call (yields between chunks). */
async function readFile(st, file, describe) {
  let s;
  try {
    s = fs.statSync(file);
  } catch (_) {
    return st;
  }
  if (st.ino !== null && (s.ino !== st.ino || s.size < st.off)) {
    const fresh = newState(st.sid);
    Object.keys(fresh).forEach((k) => (st[k] = fresh[k]));
  }
  st.ino = s.ino;
  const size = Math.min(s.size, MAX_FILE);
  if (st.off >= size) return st;
  const fd = fs.openSync(file, "r");
  try {
    while (st.off < size) {
      const len = Math.min(CHUNK, size - st.off);
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, st.off);
      let end = buf.lastIndexOf(10);
      if (end < 0) {
        if (len < CHUNK) break; // a line still being written
        end = len - 1;
      }
      parseLines(st, buf.slice(0, end).toString("utf8").split("\n"), describe);
      st.off += end + 1;
      if (st.off < size) await new Promise((r) => setImmediate(r));
    }
  } finally {
    fs.closeSync(fd);
  }
  return st;
}

/* =============================================================== the plan === */

const STEP_OF_MISSION = { planned: "next", delegated: "now", working: "now", waiting_approval: "now", done: "done", failed: "failed", skipped: "skipped" };

/**
 * The session's plan as rail steps: [{ title, status, t0, t1, ... }], status one of
 * done / now / next / failed / skipped, as of now.
 *   - a mission it works on (the ledger's steps; this session's own marked `mine`);
 *   - else its todo list (TodoWrite or TaskCreate / TaskUpdate), if it kept one;
 *   - else its turns: each a real prompt it was given (the last one is "now" while it works).
 */
function planOf(st, { mission = null, working = false } = {}) {
  if (mission && Array.isArray(mission.steps) && mission.steps.length) {
    return {
      source: "mission",
      mission: { id: mission.id, ref: mission.ref || "M-" + mission.id, title: mission.title, status: mission.status },
      steps: mission.steps.map((s) => ({
        n: s.n,
        title: clip(redact(s.title || "step " + s.n), 140),
        status: STEP_OF_MISSION[s.status] || "next",
        raw: s.status,
        t0: s.started_at || null,
        t1: s.done_at || null,
        target: s.target || null,
        mine: !!s.mine,
      })),
    };
  }
  if (st && st.todos.size) {
    const map = { pending: "next", in_progress: "now", completed: "done" };
    return {
      source: "todos",
      steps: [...st.todos.values()].sort((a, b) => a.order - b.order).map((d) => ({ title: d.title, status: map[d.status] || "next", raw: d.status, t0: iso(d.t0), t1: iso(d.t1) })),
    };
  }
  const turns = st ? st.turns : [];
  return {
    source: "turns",
    steps: turns.map((u, i) => {
      const last = i === turns.length - 1;
      const next = turns[i + 1];
      return {
        title: u.title,
        status: last && working ? "now" : "done",
        t0: iso(u.t0),
        // A turn ends where its last record is (or where the next prompt came, if it ran on).
        t1: last && working ? null : iso(next ? Math.min(Math.max(u.t1, u.t0), next.t0) : Math.max(u.t1, u.t0)),
        from: u.from,
        peer: u.peer,
        tools: u.tools,
      };
    }),
  };
}

/* ================================================================ the day === */

function dayBounds(day, tz) {
  if (!DAY_RE.test(String(day || ""))) throw new Error("day must be YYYY-MM-DD");
  const [y, m, d] = day.split("-").map(Number);
  const from = schedule.zonedToUtc(y, m, d, 0, 0, tz);
  const n = new Date(Date.UTC(y, m - 1, d + 1));
  const to = schedule.zonedToUtc(n.getUTCFullYear(), n.getUTCMonth() + 1, n.getUTCDate(), 0, 0, tz);
  return { from, to };
}

/** A session's bins between two instants: [[index from the start, records, tokens], ...] (sparse). */
function binsBetween(st, from, to) {
  const out = [];
  const k0 = Math.floor(from / BIN_MS);
  const k1 = Math.ceil(to / BIN_MS);
  for (const [k, v] of st.bins) if (k >= k0 && k < k1) out.push([k - k0, v[0], v[1]]);
  out.sort((a, b) => a[0] - b[0]);
  return out;
}

function normName(n) {
  return String(n || "")
    .replace(/\s*\[[0-9a-f]{4,12}\]\s*$/i, "")
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, " ");
}

/**
 * A SendMessage to a raw socket address ("uds:/run/...sock") is how a session answers whoever messaged
 * it; when the ledger has that session's reply to JOYA AI within two minutes, it is the same hand-off.
 * In place.
 */
function dropSocketEchoes(handoffs) {
  const replies = handoffs.filter((h) => h.kind === "reply");
  for (let i = handoffs.length - 1; i >= 0; i--) {
    const h = handoffs[i];
    if (h.kind !== "message" || !/^uds:/.test(String(h.to || ""))) continue;
    const t = Date.parse(h.t);
    if (replies.some((r) => (r.from_sid === h.from_sid || r.from === h.from) && Math.abs(Date.parse(r.t) - t) < 120000)) handoffs.splice(i, 1);
    else h.to = "a session (by its socket)";
  }
  return handoffs;
}

/* ============================================================== the module === */

/**
 * deps: { projectsDir, db (node:sqlite), tz, sessions() (live, with ledger), selfIds() -> Set,
 *         selfBusy() -> bool, describeTool(name, input), sessionCost(sid), isSelfName(name), now() }
 */
function createStory(deps) {
  const tz = deps.tz || "Africa/Cairo";
  const db = deps.db;
  const now = deps.now || (() => Date.now());
  const states = new Map(); // file -> state (LRU by insertion)
  const dayCache = new Map(); // day -> { at, data }
  const DAY_TTL = 15000;
  let filesCache = { at: 0, list: [] };

  function selfIds() {
    try {
      return deps.selfIds ? deps.selfIds() : new Set();
    } catch (_) {
      return new Set();
    }
  }

  /** Top-level transcripts (sub-agents are their parent's moons): [{ file, sid, mtime }]. Cached 5 s. */
  function transcripts() {
    if (now() - filesCache.at < 5000) return filesCache.list;
    const out = [];
    let dirs = [];
    try {
      dirs = fs.readdirSync(deps.projectsDir);
    } catch (_) {
      dirs = [];
    }
    for (const d of dirs) {
      const p = path.join(deps.projectsDir, d);
      let names;
      try {
        if (!fs.lstatSync(p).isDirectory()) continue;
        names = fs.readdirSync(p);
      } catch (_) {
        continue;
      }
      for (const n of names) {
        if (!n.endsWith(".jsonl") || !UUID_RE.test(n.slice(0, -6))) continue;
        const f = path.join(p, n);
        try {
          out.push({ file: f, sid: n.slice(0, -6), mtime: fs.statSync(f).mtimeMs });
        } catch (_) {
          /* gone */
        }
      }
    }
    filesCache = { at: now(), list: out };
    return out;
  }

  async function stateOf(file, sid) {
    let st = states.get(file);
    if (st) states.delete(file);
    else st = newState(sid);
    states.set(file, st);
    while (states.size > MAX_STATES) states.delete(states.keys().next().value);
    await readFile(st, file, deps.describeTool);
    return st;
  }

  function liveSessions() {
    try {
      return deps.sessions() || [];
    } catch (_) {
      return [];
    }
  }

  function hiredBySid() {
    const m = new Map();
    try {
      for (const h of db.prepare("SELECT slug, name, session_id, status FROM hired_sessions").all()) m.set(h.session_id, h);
    } catch (_) {
      /* no table */
    }
    return m;
  }

  /** The mission this session works on (most recent): the mission with all its steps, this session's marked. */
  function missionFor(sid, name) {
    let rows = [];
    try {
      const bare = normName(name);
      const dels = new Set(db.prepare("SELECT id FROM delegations WHERE target_session = ?").all(sid).map((r) => r.id));
      rows = db
        .prepare("SELECT s.*, m.title AS m_title, m.status AS m_status, m.updated_at AS m_updated FROM steps s JOIN missions m ON m.id = s.mission_id ORDER BY m.updated_at DESC, s.n LIMIT 2000")
        .all()
        .filter((s) => (s.delegation_id && dels.has(s.delegation_id)) || (bare && s.target && normName(s.target) === bare));
    } catch (_) {
      return null;
    }
    if (!rows.length) return null;
    const mid = rows[0].mission_id;
    const mine = new Set(rows.filter((r) => r.mission_id === mid).map((r) => r.n));
    const all = db.prepare("SELECT * FROM steps WHERE mission_id = ? ORDER BY n").all(mid);
    return { id: mid, ref: "M-" + mid, title: rows[0].m_title, status: rows[0].m_status, steps: all.map((s) => ({ ...s, mine: mine.has(s.n) })) };
  }

  function findTranscript(sid) {
    const hit = transcripts().find((f) => f.sid === sid);
    if (hit) return hit.file;
    filesCache.at = 0;
    const again = transcripts().find((f) => f.sid === sid);
    return again ? again.file : null;
  }

  /** The story of one session. */
  async function sessionStory(sid) {
    if (!UUID_RE.test(String(sid || ""))) throw new Error("no such session");
    const live = liveSessions().find((s) => s.session_id === sid) || null;
    const self = selfIds().has(sid) || !!(live && live.self);
    const file = findTranscript(sid);
    if (!file && !live) throw new Error("no such session");
    const st = file ? await stateOf(file, sid) : newState(sid);
    const hired = hiredBySid().get(sid) || null;
    const name = self ? "JOYA AI" : (live && live.name) || (hired && hired.name) || st.title || "session " + sid.slice(0, 8);
    const selfBusy = self && deps.selfBusy ? !!deps.selfBusy() : false;
    const working = self ? selfBusy : live ? live.status === "busy" || live.status === "working" : false;
    const waiting = !self && !!live && (live.status === "waiting" || !!live.waiting_for);
    const mission = self ? null : missionFor(sid, name);
    const plan = planOf(st, { mission, working });

    // Approvals: the transcript's, plus the ledger's cards (JOYA AI's own, or a hired session's).
    const approvals = st.approvals.map((a) => ({ ...a, t: iso(a.t) }));
    try {
      let rows = [];
      if (self) rows = db.prepare("SELECT * FROM approvals WHERE origin IS NULL OR origin = 'joya-ai' ORDER BY id DESC LIMIT 300").all();
      else if (hired) rows = db.prepare("SELECT * FROM approvals WHERE origin = ? ORDER BY id DESC LIMIT 300").all("session:" + hired.slug);
      const since = st.first != null ? st.first - 60000 : 0;
      for (const r of rows) {
        const t = Date.parse(r.created_at);
        if (since && t < since) continue;
        approvals.push({ t: r.created_at, tool: r.tool, summary: clip(redact(r.summary || ""), 160), decision: r.status === "approved" ? "approved" : r.status === "pending" ? "pending" : r.status === "expired" ? "expired" : "denied", decided_at: r.decided_at || null, by: r.decided_by || null, label: r.label || null, from: "ledger", id: r.id });
      }
    } catch (_) {
      /* no ledger table */
    }
    approvals.sort((a, b) => String(a.t).localeCompare(String(b.t)));

    // Hand-offs: JOYA AI's delegations to it (ledger) and the messages it sent or got (transcript).
    const handoffs = [];
    try {
      const rows = self
        ? db.prepare("SELECT id, target_name, target_session, summary, text, status, created_at, replied_at FROM delegations ORDER BY id DESC LIMIT 200").all()
        : db.prepare("SELECT id, target_name, target_session, summary, text, status, created_at, replied_at FROM delegations WHERE target_session = ? OR (target_session IS NULL AND target_name = ?) ORDER BY id DESC LIMIT 200").all(sid, name);
      for (const d of rows) {
        const what = clip(redact(d.summary || String(d.text || "").split("\n")[0]), 160);
        handoffs.push({ t: d.created_at, kind: "delegation", from: "JOYA AI", to: d.target_name, to_sid: d.target_session || null, text: what, status: d.status, id: d.id });
        if (d.replied_at) handoffs.push({ t: d.replied_at, kind: "reply", from: d.target_name, from_sid: d.target_session || null, to: "JOYA AI", text: what, id: d.id });
      }
    } catch (_) {
      /* no ledger table */
    }
    if (!self) {
      for (const s of st.sends) handoffs.push({ t: iso(s.t), kind: "message", from: name, from_sid: sid, to: s.to, text: s.text });
      for (const s of st.inbound) if (!(deps.isSelfName && deps.isSelfName(s.from))) handoffs.push({ t: iso(s.t), kind: "message", from: s.from, to: name, to_sid: sid, text: s.text });
    }
    handoffs.sort((a, b) => String(a.t).localeCompare(String(b.t)));
    dropSocketEchoes(handoffs);

    const files = [...st.files.values()].sort((a, b) => b.last - a.last).map((f) => ({ path: f.path, add: f.add, del: f.del, edits: f.edits, created: f.created, first: iso(f.first), last: iso(f.last) }));
    const totals = files.reduce((a, f) => ((a.add += f.add), (a.del += f.del), a), { add: 0, del: 0 });
    let cost = null;
    try {
      cost = deps.sessionCost ? deps.sessionCost(sid) : null;
    } catch (_) {
      cost = null;
    }
    const tokTotal = st.tokens.input + st.tokens.output + st.tokens.cache_read + st.tokens.cache_write;
    const from = st.first != null ? st.first : null;
    return redactDeep({
      session: {
        session_id: sid,
        name,
        self,
        live: !!live,
        state: self ? (working ? "working" : "idle") : live ? (waiting ? "waiting" : working ? "working" : "idle") : "offline",
        waiting_for: live && live.waiting_for ? live.waiting_for : null,
        where: live ? live.where || live.kind || null : null,
        cwd: st.cwd || (live && live.cwd) || null,
        hired: hired ? { slug: hired.slug, status: hired.status } : null,
        transcript: !!file,
      },
      plan,
      turns: st.turns.length,
      files,
      file_totals: totals,
      file_events: st.fileEvents.map((e) => ({ t: iso(e.t), path: e.path, add: e.add, del: e.del })),
      approvals,
      questions: st.questions.map((q) => ({ ...q, t: iso(q.t) })),
      agents: st.agents.map((a) => ({ ...a, t: iso(a.t) })),
      agent_messages: st.subMsgs,
      handoffs,
      tools: st.tools,
      tokens: { ...st.tokens, total: tokTotal },
      // tokens per bin from the first record: [[bin index, records, tokens]] -- the story's own scrubber
      bins: from != null ? binsBetween(st, from - (from % BIN_MS), (st.last || from) + BIN_MS) : [],
      bin_ms: BIN_MS,
      bin_from: from != null ? iso(from - (from % BIN_MS)) : null,
      cost,
      time: { first: iso(st.first), last: iso(st.last), active_ms: st.activeMs, span_ms: st.first != null ? st.last - st.first : 0 },
      at: iso(now()),
    });
  }

  /** The day: every session's activity in bins, the hand-offs and the approvals. Cached for 15 s. */
  async function day(dayStr) {
    const d = dayStr || schedule.dayOf(now(), tz);
    const { from, to } = dayBounds(d, tz);
    if (from > now()) throw new Error("that day has not started");
    if (now() - from > 15 * 86400000) throw new Error("only the last two weeks are kept");
    const c = dayCache.get(d);
    if (c && now() - c.at < DAY_TTL) return c.data;
    const self = selfIds();
    const live = liveSessions();
    const liveBySid = new Map(live.filter((s) => s.session_id).map((s) => [s.session_id, s]));
    const hired = hiredBySid();
    const sessions = [];
    const byName = new Map();
    const files = transcripts().filter((f) => f.mtime >= from);
    const k0 = Math.floor(from / BIN_MS);
    for (const f of files) {
      const st = await stateOf(f.file, f.sid);
      const bins = binsBetween(st, from, to);
      if (!bins.length) continue;
      const isSelf = self.has(f.sid);
      const l = liveBySid.get(f.sid);
      const h = hired.get(f.sid);
      const name = isSelf ? "JOYA AI" : (l && l.name) || (h && h.name) || st.title || "session " + f.sid.slice(0, 8);
      const tok = bins.reduce((a, b) => a + b[2], 0);
      const recs = bins.reduce((a, b) => a + b[1], 0);
      const sp = {
        session_id: f.sid,
        name,
        self: isSelf,
        live: !!l,
        cwd: st.cwd || (l && l.cwd) || null,
        where: l ? l.where || l.kind || null : null,
        hired: !!h,
        first: iso(Math.max(from, (k0 + bins[0][0]) * BIN_MS)),
        last: iso(Math.min(to, (k0 + bins[bins.length - 1][0] + 1) * BIN_MS)),
        bins,
        records: recs,
        tokens: tok,
        files: st.fileEvents.filter((e) => e.t >= from && e.t < to).length,
        sends: st.sends.filter((s) => s.t >= from && s.t < to),
      };
      sessions.push(sp);
      if (!isSelf) byName.set(normName(name), sp);
    }
    // JOYA AI's ids are one lane.
    const selves = sessions.filter((s) => s.self);
    let out = sessions.filter((s) => !s.self);
    if (selves.length) {
      const merged = new Map();
      for (const s of selves) for (const b of s.bins) {
        const m = merged.get(b[0]) || [b[0], 0, 0];
        m[1] += b[1];
        m[2] += b[2];
        merged.set(b[0], m);
      }
      const bins = [...merged.values()].sort((a, b) => a[0] - b[0]);
      out.unshift({ session_id: selves.sort((a, b) => (b.last > a.last ? 1 : -1))[0].session_id, ids: selves.map((s) => s.session_id), name: "JOYA AI", self: true, live: true, bins, records: bins.reduce((a, b) => a + b[1], 0), tokens: bins.reduce((a, b) => a + b[2], 0), first: selves.map((s) => s.first).sort()[0], last: selves.map((s) => s.last).sort().slice(-1)[0], files: selves.reduce((a, s) => a + s.files, 0), sends: [] });
    }
    const sidByName = (n) => {
      if (deps.isSelfName && deps.isSelfName(n)) return "self";
      const s = byName.get(normName(n));
      return s ? s.session_id : null;
    };

    const handoffs = [];
    try {
      for (const r of db.prepare("SELECT id, target_name, target_session, summary, text, status, created_at, replied_at FROM delegations WHERE created_at >= ? AND created_at < ? ORDER BY id").all(iso(from), iso(to))) {
        const text = clip(redact(r.summary || String(r.text || "").split("\n")[0]), 140);
        const toSid = r.target_session || sidByName(r.target_name);
        handoffs.push({ t: r.created_at, kind: "delegation", from_sid: "self", from: "JOYA AI", to_sid: toSid, to: r.target_name, text, id: r.id });
        if (r.replied_at && r.replied_at < iso(to)) handoffs.push({ t: r.replied_at, kind: "reply", from_sid: toSid, from: r.target_name, to_sid: "self", to: "JOYA AI", text, id: r.id });
      }
    } catch (_) {
      /* no ledger */
    }
    for (const s of out) {
      if (s.self) continue;
      for (const m of s.sends) {
        const toSid = sidByName(m.to);
        if (toSid === "self") continue; // JOYA AI's side is the ledger's (replies)
        handoffs.push({ t: iso(m.t), kind: "message", from_sid: s.session_id, from: s.name, to_sid: toSid, to: m.to, text: m.text });
      }
    }
    handoffs.sort((a, b) => String(a.t).localeCompare(String(b.t)));
    dropSocketEchoes(handoffs);

    const approvals = [];
    try {
      const slugToSid = new Map([...hired.values()].map((h) => [h.slug, h.session_id]));
      for (const r of db.prepare("SELECT id, tool, summary, status, origin, origin_name, created_at, decided_at FROM approvals WHERE created_at >= ? AND created_at < ? ORDER BY id").all(iso(from), iso(to))) {
        const slug = r.origin && r.origin.startsWith("session:") ? r.origin.slice(8) : null;
        // origin: null or "joya-ai" = JOYA AI's own card; "session:<slug>" = a hired session's.
        const sid = slug ? slugToSid.get(slug) || null : "self";
        approvals.push({ t: r.created_at, decided_at: r.decided_at || null, status: r.status, tool: r.tool, summary: clip(redact(r.summary || ""), 120), sid, who: r.origin_name || (slug ? slug : "JOYA AI"), id: r.id });
      }
    } catch (_) {
      /* no ledger */
    }
    // Asked in a transcript (interactive sessions): only where Claude Code recorded a permission decision.
    for (const f of files) {
      const st = states.get(f.file);
      if (!st || self.has(f.sid)) continue;
      for (const a of st.approvals) if (a.t >= from && a.t < to) approvals.push({ t: iso(a.t), status: a.decision, tool: a.tool, summary: a.summary, sid: f.sid, who: (out.find((s) => s.session_id === f.sid) || {}).name || null, from: "transcript" });
    }
    approvals.sort((a, b) => String(a.t).localeCompare(String(b.t)));

    out.forEach((s) => delete s.sends);
    out = out.sort((a, b) => (a.self !== b.self ? (a.self ? -1 : 1) : b.records - a.records));
    const data = redactDeep({ day: d, tz, from: iso(from), to: iso(to), now: iso(now()), bin_ms: BIN_MS, bins: Math.round((to - from) / BIN_MS), sessions: out, handoffs, approvals });
    dayCache.set(d, { at: now(), data });
    if (dayCache.size > 4) dayCache.delete(dayCache.keys().next().value);
    return data;
  }

  return { sessionStory, day, transcripts, _states: states };
}

module.exports = { createStory, dropSocketEchoes, newState, parseLines, parseRecord, planOf, promptTitle, peerFrom, countPatch, dayBounds, binsBetween, readFile, BIN_MS, IDLE_GAP_MS };
