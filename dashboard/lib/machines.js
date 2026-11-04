"use strict";
/**
 * The user's own computers in Joya (Path A laptop control, 2026-10-08):
 * the dashboard's half. The supervisor's half is joya-ai/lib/machines.js.
 *
 * Pairing. Joya > Machines > "Pair a computer" shows a one-time code
 * (8 characters, Crockford base32, shown ABCD-EFGH, 10 minutes, one at a time
 * per person). The JOYA AI desktop app on that computer sends it to
 * POST /machines/api/claim with the computer's name and gets a per-machine
 * token back, once. Only the token's SHA-256 is kept here; the app keeps the
 * token in Windows Credential Manager. Revoke in Joya ends it (and any
 * control lease) at once.
 *
 * The link. The app keeps one outbound WebSocket to /machines/api/link
 * (Authorization: Bearer <token>); no port is ever opened on the computer.
 * JSON messages, see desktop/README.md "Laptop control" for the wire contract:
 *   app -> here   hello, lease (active|extended|ended), ask, cancel, action, report, session
 *   here -> app   welcome, renamed, revoked, start, extend, tell, stop, answer
 * This server relays to the supervisor as actor "machine.<id>" -- only for a
 * link that presented that computer's token -- and keeps the registry in step
 * (machines-sync, actor "machines"). The supervisor's "machine" events (start,
 * tell, stop) come back through one standing subscription.
 *
 * The control lease. JOYA AI's take-over (or the panel's) starts a lease of N
 * minutes (default 15, at most 60 from now; the user extends it from the app's
 * pill or here). It is enforced on the computer (the app) AND here: past its
 * end (plus a few seconds' grace) the lease is ended and the app told to stop.
 *
 * The action log (0.1.11: table machine_action_log, LOG_RETENTION_DAYS = 90).
 * Every action of a take-over -- the hands' file tools, the browser steps
 * (Claude in Chrome), the CLI's commands -- arrives as `action` with its time,
 * tool, a one-line target, who let it run (auto / approved / denied /
 * refused), whether it worked and its result in a few words. Targets and
 * results are redacted again here. The Computers page shows a take-over's log
 * live (GET /machines/api/lease/:lid?after=<id>). The older table
 * machine_actions (with a screenshot per row, from apps before 0.1.11 that
 * planned screen capture) is still read for old take-overs and pruned after
 * SHOT_RETENTION_DAYS (7) with its screenshots; nothing new is written there.
 *
 * The browser and the folders (0.1.11). The app's hello says whether the
 * Claude in Chrome extension is installed on that computer (chrome_json) and
 * which Office apps it has; a browser step's result says whether the
 * extension answered (`browser`). The user may switch the browser off for a
 * computer (browser_allowed) and add folders JOYA AI may use there besides
 * Documents, Desktop, Downloads and OneDrive (folders_json, at most 20): both
 * go to the app in `start` and to the supervisor's gate in machines-sync.
 *
 * Pure apart from what it is given: the panel's database handle, a directory,
 * the supervisor client (call, subscribe) and a clock.
 */

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const CODE_MS = 10 * 60 * 1000;
const MAX_CODES = 20;
const TOKEN_RE = /^mmt_[A-Za-z0-9_-]{43}$/;
const NAME_RE = /^[\p{L}\p{N}][\p{L}\p{N} ._'()&-]{0,47}$/u;
const DEFAULT_MINUTES = 15;
const MAX_LEASE_MS = 60 * 60 * 1000;
const EXTEND_MS = 15 * 60 * 1000;
const GRACE_MS = 15 * 1000;
const RETENTION_DAYS = 90; // the action log (machine_action_log)
const SHOT_RETENTION_DAYS = 7; // the old screenshot log (machine_actions)
const MAX_FOLDERS = 20;
const KINDS = ["hands", "browser", "cli"];
const MAX_SHOT = 1536 * 1024;
const ASK_TIMEOUT_MS = 3700 * 1000; // the supervisor's approval timeout is at most 3600 s
// A start the app has not acknowledged (lease active / session starting) in this long is ended:
// "the computer did not start the session" (2026-10-08: a start the app could not read sat as a
// live lease and a hired session until the user released it by hand).
const START_TIMEOUT_MS = 60 * 1000;
const NOT_INSTALLED = "Claude Code is not installed on that computer — install it there and sign in once by running `claude` in a terminal, then press Look again in the JOYA AI app (Settings ▸ This computer)";
const NO_START = "the computer did not start the session (no answer from the JOYA AI app within 60 seconds)";

/** The app's Claude Code report (its hello) -> { found, path, version, git_bash }, or null when unknown. */
function claudeOf(m) {
  if (!m || !m.claude_json) return null;
  try {
    const c = JSON.parse(m.claude_json);
    if (!c || typeof c !== "object") return null;
    return { found: c.found === true || (c.found !== false && !!c.path), path: c.path || null, version: c.version || null, git_bash: !!c.git_bash };
  } catch (_) {
    return null;
  }
}
/** True only when the computer said Claude Code is missing (unknown is not missing). */
function claudeMissing(m) {
  const c = claudeOf(m);
  return !!c && !c.found;
}
const END_REASONS = ["stop-hotkey", "pill-stop", "timeout", "locked", "signout", "app-exit", "link-lost", "runner-exited", "server", "unlinked", "revoked", "failed"];
const DECISIONS = ["auto", "approved", "denied", "refused", "error"];

/**
 * A folder the user adds for a computer: a full local Windows path (no network or device paths), not a
 * whole drive, not Windows' or the programs' folders, not app data or a hidden folder, not a whole
 * profile. -> { path } normalised (C:\Work), or { error }. The app checks the same again.
 */
function cleanFolder(raw) {
  let s = String(raw || "").trim().replace(/^["']|["']$/g, "").replace(/\//g, "\\");
  if (!s || s.length > 240 || /[\u0000-\u001f<>"|?*]/.test(s)) return { error: "Give a full folder path on that computer, like D:\\Work." };
  if (s.startsWith("\\\\")) return { error: "Network and device paths are not allowed: pick a folder on the computer's own drives." };
  const m = /^([a-zA-Z]):(\\.*)?$/.exec(s);
  if (!m) return { error: "Give a full folder path on that computer, like D:\\Work." };
  const parts = [];
  for (const p of (m[2] || "").split("\\")) {
    if (!p || p === ".") continue;
    if (p === "..") {
      parts.pop();
      continue;
    }
    if (p.includes(":") || /[. ]$/.test(p)) return { error: "That folder name is not a plain Windows folder name." };
    parts.push(p);
  }
  if (!parts.length) return { error: "A whole drive is too wide: pick a folder on it." };
  const low = parts.map((p) => p.toLowerCase());
  if (["windows", "program files", "program files (x86)", "programdata", "$recycle.bin", "system volume information", "recovery", "boot", "perflogs"].includes(low[0])) return { error: "That is a Windows or programs folder: JOYA AI never works there." };
  if (low.includes("appdata") || low.some((p) => p.startsWith("."))) return { error: "That is a hidden or app-data folder: pick one of your own folders." };
  if (low[0] === "users" && parts.length <= 2) return { error: "A whole user profile is too wide: pick a folder inside it." };
  return { path: m[1].toUpperCase() + ":\\" + parts.join("\\") };
}

const sha = (s) => crypto.createHash("sha256").update(String(s)).digest("hex");
const clip = (s, n) => (String(s == null ? "" : s).length > n ? String(s).slice(0, n - 1) + "…" : String(s == null ? "" : s));

/** 8 random Crockford characters. */
function newCode() {
  const b = crypto.randomBytes(8);
  let s = "";
  for (let i = 0; i < 8; i++) s += CROCKFORD[b[i] & 31];
  return s;
}
/** "abcd-efgh", "ABCD EFGH", O->0, I/L->1: the 8 characters, or null. */
function normCode(raw) {
  const s = String(raw || "").toUpperCase().replace(/[\s-]/g, "").replace(/O/g, "0").replace(/[IL]/g, "1");
  return /^[0-9A-HJKMNP-TV-Z]{8}$/.test(s) ? s : null;
}
const showCode = (c) => c.slice(0, 4) + "-" + c.slice(4);
function newToken() {
  return "mmt_" + crypto.randomBytes(32).toString("base64url");
}
/** A computer's display name, as the hire rules accept it (letters, digits, a few marks). */
function cleanName(raw) {
  const n = String(raw || "").normalize("NFKC").replace(/[^\p{L}\p{N} ._'()&-]+/gu, " ").replace(/\s+/g, " ").trim().slice(0, 48);
  return NAME_RE.test(n) ? n : null;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS machines (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  name          TEXT NOT NULL,
  platform      TEXT,
  token_hash    TEXT NOT NULL UNIQUE,
  created_at    TEXT NOT NULL,
  created_by    TEXT,
  last_seen_at  TEXT,
  app_version   TEXT,
  host          TEXT,
  win_user      TEXT,
  home          TEXT,
  claude_json   TEXT,
  revoked_at    TEXT,
  revoked_by    TEXT
);
CREATE TABLE IF NOT EXISTS machine_leases (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  machine_id    INTEGER NOT NULL,
  slug          TEXT NOT NULL,
  name          TEXT,
  purpose       TEXT,
  started_by    TEXT,
  started_at    TEXT NOT NULL,
  expires_at    TEXT NOT NULL,
  ended_at      TEXT,
  end_reason    TEXT
);
CREATE TABLE IF NOT EXISTS machine_actions (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  machine_id    INTEGER NOT NULL,
  lease_id      INTEGER,
  at            TEXT NOT NULL,
  tool          TEXT NOT NULL,
  summary       TEXT,
  decision      TEXT,
  shot          TEXT
);
CREATE INDEX IF NOT EXISTS machine_actions_lease ON machine_actions(lease_id, id);
CREATE INDEX IF NOT EXISTS machine_leases_machine ON machine_leases(machine_id, id);
CREATE TABLE IF NOT EXISTS machine_action_log (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  machine_id    INTEGER NOT NULL,
  lease_id      INTEGER NOT NULL,
  slug          TEXT,
  at            TEXT NOT NULL,
  received_at   TEXT NOT NULL,
  kind          TEXT NOT NULL,
  tool          TEXT NOT NULL,
  target        TEXT,
  decision      TEXT NOT NULL,
  approved      INTEGER NOT NULL DEFAULT 0,
  result        TEXT NOT NULL,
  detail        TEXT
);
CREATE INDEX IF NOT EXISTS machine_action_log_lease ON machine_action_log(lease_id, id);
CREATE INDEX IF NOT EXISTS machine_action_log_at ON machine_action_log(at);
`;
/** Columns added to machines since 0.1.11 (added when missing; nothing else changes). */
const MACHINE_COLUMNS = [
  ["chrome_json", "TEXT"],
  ["office_json", "TEXT"],
  ["folders_json", "TEXT"],
  ["browser_allowed", "INTEGER NOT NULL DEFAULT 1"],
];

function create(o) {
  const db = o.db;
  const dir = o.dir;
  const call = o.call; // (op, params, actor, opts) -> Promise
  const subscribe = o.subscribe; // (since, actor, onEvent, onEnd) -> { close() } | socket
  const now = o.now || Date.now;
  const log = o.log || ((m) => console.log(m));
  const redact = o.redact || ((s) => s);
  const iso = (ms) => new Date(ms == null ? now() : ms).toISOString();
  db.exec(SCHEMA);
  {
    const have = new Set(db.prepare("PRAGMA table_info(machines)").all().map((c) => c.name));
    for (const [col, type] of MACHINE_COLUMNS) if (!have.has(col)) db.exec(`ALTER TABLE machines ADD COLUMN ${col} ${type}`);
  }

  const codes = new Map(); // code -> { userId, by, exp }
  const links = new Map(); // machine id -> { ws, hello, at }
  const pendingAsks = new Map(); // `${id}:${rid}` -> { slug }
  const starting = new Map(); // lease id -> ms the start was sent (until the app acknowledges it)
  let sub = null;
  let subTimer = null;
  let stopped = false;
  const timers = [];

  /* ------------------------------------------------------------ store --- */
  const q = {
    byHash: db.prepare("SELECT * FROM machines WHERE token_hash = ? AND revoked_at IS NULL"),
    byId: db.prepare("SELECT * FROM machines WHERE id = ?"),
    list: db.prepare("SELECT * FROM machines WHERE revoked_at IS NULL ORDER BY id"),
    insert: db.prepare("INSERT INTO machines (name, platform, token_hash, created_at, created_by, app_version) VALUES (?, ?, ?, ?, ?, ?)"),
    rename: db.prepare("UPDATE machines SET name = ? WHERE id = ? AND revoked_at IS NULL"),
    revoke: db.prepare("UPDATE machines SET revoked_at = ?, revoked_by = ? WHERE id = ? AND revoked_at IS NULL"),
    seen: db.prepare("UPDATE machines SET last_seen_at = ?, app_version = COALESCE(?, app_version), host = COALESCE(?, host), win_user = COALESCE(?, win_user), home = COALESCE(?, home), claude_json = COALESCE(?, claude_json) WHERE id = ?"),
    leaseIns: db.prepare("INSERT INTO machine_leases (machine_id, slug, name, purpose, started_by, started_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)"),
    leaseActive: db.prepare("SELECT * FROM machine_leases WHERE machine_id = ? AND ended_at IS NULL ORDER BY id DESC LIMIT 1"),
    leaseOpen: db.prepare("SELECT * FROM machine_leases WHERE ended_at IS NULL"),
    leaseGet: db.prepare("SELECT * FROM machine_leases WHERE id = ?"),
    leaseEnd: db.prepare("UPDATE machine_leases SET ended_at = ?, end_reason = ? WHERE id = ? AND ended_at IS NULL"),
    leaseExpiry: db.prepare("UPDATE machine_leases SET expires_at = ? WHERE id = ? AND ended_at IS NULL"),
    leases: db.prepare("SELECT l.*, (SELECT count(*) FROM machine_actions a WHERE a.lease_id = l.id) AS actions FROM machine_leases l WHERE machine_id = ? ORDER BY id DESC LIMIT ?"),
    actIns: db.prepare("INSERT INTO machine_actions (machine_id, lease_id, at, tool, summary, decision) VALUES (?, ?, ?, ?, ?, ?)"),
    actShot: db.prepare("UPDATE machine_actions SET shot = ? WHERE id = ?"),
    actions: db.prepare("SELECT * FROM machine_actions WHERE lease_id = ? ORDER BY id LIMIT 2000"),
    action: db.prepare("SELECT * FROM machine_actions WHERE id = ?"),
    oldActions: db.prepare("SELECT id, shot FROM machine_actions WHERE at < ?"),
    delAction: db.prepare("DELETE FROM machine_actions WHERE id = ?"),
    chrome: db.prepare("UPDATE machines SET chrome_json = ? WHERE id = ?"),
    office: db.prepare("UPDATE machines SET office_json = ? WHERE id = ?"),
    folders: db.prepare("UPDATE machines SET folders_json = ? WHERE id = ? AND revoked_at IS NULL"),
    browserAllowed: db.prepare("UPDATE machines SET browser_allowed = ? WHERE id = ? AND revoked_at IS NULL"),
    logIns: db.prepare("INSERT INTO machine_action_log (machine_id, lease_id, slug, at, received_at, kind, tool, target, decision, approved, result, detail) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"),
    logOf: db.prepare("SELECT * FROM machine_action_log WHERE lease_id = ? AND id > ? ORDER BY id LIMIT 2000"),
    logLast: db.prepare("SELECT * FROM machine_action_log WHERE lease_id = ? ORDER BY id DESC LIMIT ?"),
    logCount: db.prepare("SELECT count(*) AS n FROM machine_action_log WHERE lease_id = ?"),
    logOld: db.prepare("DELETE FROM machine_action_log WHERE at < ?"),
  };

  const parse = (s, d) => {
    try {
      const v = JSON.parse(s);
      return v == null ? d : v;
    } catch (_) {
      return d;
    }
  };
  const foldersOf = (m) => (m && m.folders_json ? parse(m.folders_json, []).filter((f) => typeof f === "string") : []);
  const officeOf = (m) => (m && m.office_json ? parse(m.office_json, []).filter((x) => ["Word", "Excel", "PowerPoint"].includes(x)) : []);
  /** The computer's Chrome: { extension, browser, profile, allowed, last: { connected, at, detail } | null }, or null when its app never said. */
  function chromeOf(m) {
    if (!m || !m.chrome_json) return m && m.browser_allowed === 0 ? { extension: false, allowed: false, last: null } : null;
    const c = parse(m.chrome_json, {});
    return {
      extension: c.extension === true,
      browser: typeof c.browser === "string" ? c.browser : null,
      profile: typeof c.profile === "string" ? c.profile : null,
      allowed: m.browser_allowed !== 0,
      last: c.last && typeof c.last === "object" ? { connected: c.last.connected === true, at: typeof c.last.at === "string" ? c.last.at : null, detail: typeof c.last.detail === "string" ? c.last.detail : "" } : null,
    };
  }

  function publicMachine(m) {
    const l = links.get(m.id);
    const lease = q.leaseActive.get(m.id) || null;
    const claude = claudeOf(m);
    return {
      id: m.id,
      name: m.name,
      platform: m.platform,
      online: !!l,
      last_seen_at: l ? iso() : m.last_seen_at,
      app_version: m.app_version,
      host: m.host,
      claude,
      chrome: chromeOf(m),
      office: officeOf(m),
      folders: foldersOf(m),
      created_at: m.created_at,
      created_by: m.created_by,
      lease: lease ? publicLease(lease) : null,
    };
  }
  function publicLease(l) {
    return { id: l.id, machine_id: l.machine_id, slug: l.slug, name: l.name, purpose: l.purpose, started_by: l.started_by, started_at: l.started_at, expires_at: l.expires_at, ended_at: l.ended_at, end_reason: l.end_reason, actions: l.actions };
  }

  /* ---------------------------------------------------------- pairing --- */

  /** A new code for this person (their earlier one is withdrawn). */
  function issueCode(userId, by) {
    const t = now();
    for (const [c, v] of codes) if (v.exp <= t || v.userId === userId) codes.delete(c);
    if (codes.size >= MAX_CODES) return null;
    let c;
    do c = newCode();
    while (codes.has(c));
    codes.set(c, { userId, by, exp: t + CODE_MS });
    return { code: showCode(c), expires_at: iso(t + CODE_MS), minutes: CODE_MS / 60000 };
  }
  function withdrawCode(userId) {
    for (const [c, v] of codes) if (v.userId === userId) codes.delete(c);
  }

  /** The app's claim: the code once, within its 10 minutes -> a new machine and its token (returned once). */
  function claim(body) {
    const b = body && typeof body === "object" ? body : {};
    const c = normCode(b.code);
    if (!c) return { status: 400, error: "That is not a pairing code (8 letters and digits, like ABCD-EFGH)." };
    const v = codes.get(c);
    if (!v) return { status: 404, error: "That code is not known. Make a new one in Joya > Machines." };
    codes.delete(c); // single use, even when the rest is refused
    if (v.exp <= now()) return { status: 410, error: "That code has expired. Make a new one in Joya > Machines." };
    const name = cleanName(b.name) || "Computer";
    const platform = /^[a-z0-9_-]{1,20}$/.test(String(b.platform || "")) ? String(b.platform) : "windows";
    const ver = /^\d+\.\d+\.\d+$/.test(String(b.app_version || "")) ? String(b.app_version) : null;
    const token = newToken();
    const r = q.insert.run(name, platform, sha(token), iso(), v.by || null, ver);
    const id = Number(r.lastInsertRowid);
    log(`machines: computer #${id} "${name}" paired by ${v.by}`);
    syncSoon();
    return { status: 200, machine_id: id, name, token };
  }

  function list() {
    return q.list.all().map(publicMachine);
  }
  function get(id) {
    const m = q.byId.get(Number(id));
    return m && !m.revoked_at ? m : null;
  }

  function rename(id, raw, by) {
    const name = cleanName(raw);
    if (!name) return { error: "A name of 1-48 letters, digits, spaces and . _ ' ( ) & -" };
    if (!q.rename.run(name, Number(id)).changes) return { error: "No such computer." };
    send(Number(id), { t: "renamed", name });
    log(`machines: computer #${id} renamed "${name}" by ${by}`);
    syncSoon();
    return { ok: true, name };
  }

  function revoke(id, by) {
    const m = get(id);
    if (!m) return { error: "No such computer." };
    q.revoke.run(iso(), by || null, m.id);
    const l = q.leaseActive.get(m.id);
    if (l) endLease(m.id, l, "revoked", { tellApp: true, tellSupervisor: true });
    send(m.id, { t: "revoked" });
    const link = links.get(m.id);
    if (link) {
      try {
        link.ws.close(4401, "revoked");
      } catch (_) {
        /* gone */
      }
      links.delete(m.id);
    }
    log(`machines: computer #${m.id} "${m.name}" revoked by ${by}`);
    syncSoon();
    return { ok: true };
  }

  /* ------------------------------------------- the browser and the folders --- */

  /** The user switches JOYA AI's use of Chrome on that computer on or off (from the next take-over). */
  function setBrowser(id, on, by) {
    if (!q.browserAllowed.run(on ? 1 : 0, Number(id)).changes) return { error: "No such computer." };
    log(`machines: computer #${id} browser ${on ? "allowed" : "switched off"} by ${by}`);
    syncSoon();
    return { ok: true, on: !!on };
  }

  /** A folder the user adds for JOYA AI on that computer (besides Documents, Desktop, Downloads, OneDrive). */
  function addFolder(id, raw, by) {
    const m = get(id);
    if (!m) return { error: "No such computer." };
    const f = cleanFolder(raw);
    if (f.error) return f;
    const list = foldersOf(m);
    if (list.some((x) => x.toLowerCase() === f.path.toLowerCase())) return { ok: true, path: f.path, folders: list };
    if (list.length >= MAX_FOLDERS) return { error: `At most ${MAX_FOLDERS} folders.` };
    list.push(f.path);
    q.folders.run(JSON.stringify(list), m.id);
    log(`machines: computer #${m.id} folder added by ${by}: ${f.path}`);
    syncSoon();
    return { ok: true, path: f.path, folders: list };
  }

  function removeFolder(id, raw, by) {
    const m = get(id);
    if (!m) return { error: "No such computer." };
    const list = foldersOf(m);
    const want = String(raw || "").trim().toLowerCase();
    const next = list.filter((x) => x.toLowerCase() !== want);
    if (next.length === list.length) return { error: "That folder is not on the list." };
    q.folders.run(JSON.stringify(next), m.id);
    log(`machines: computer #${m.id} folder removed by ${by}: ${raw}`);
    syncSoon();
    return { ok: true, folders: next };
  }

  /* ------------------------------------------------------------ leases --- */

  function endLease(id, l, reason, { tellApp, tellSupervisor } = {}) {
    if (!l || l.ended_at) return;
    starting.delete(l.id);
    q.leaseEnd.run(iso(), String(reason || "ended").slice(0, 300), l.id);
    log(`machines: lease #${l.id} on computer #${id} (${l.slug}) ended: ${reason}`);
    // Lease ids go to the app as strings (the 0.1.5 app reads only a string).
    if (tellApp) send(id, { t: "stop", lease_id: String(l.id), reason: String(reason || "ended").slice(0, 300) });
    if (tellSupervisor) {
      call("machine-state", { slug: l.slug, state: "ended", reason: String(reason || "ended").slice(0, 300) }, "machine." + id).catch(() => {});
    }
  }

  /** The user extends the lease from Joya: +15 minutes, never more than an hour from now. */
  function extend(id, by) {
    const l = q.leaseActive.get(Number(id));
    if (!l) return { error: "JOYA AI does not control that computer now." };
    const t = now();
    const next = Math.min(Math.max(Date.parse(l.expires_at), t) + EXTEND_MS, t + MAX_LEASE_MS);
    q.leaseExpiry.run(iso(next), l.id);
    send(Number(id), { t: "extend", lease_id: String(l.id), expires_at: iso(next) });
    log(`machines: lease #${l.id} extended to ${iso(next)} by ${by}`);
    return { ok: true, expires_at: iso(next) };
  }

  /** Stop from Joya: the supervisor releases the session (its stop event reaches the app). */
  async function stopControl(id, by) {
    const m = get(id);
    if (!m) return { error: "No such computer." };
    const l = q.leaseActive.get(m.id);
    if (!l) return { error: "JOYA AI does not control that computer now." };
    endLease(m.id, l, "server", { tellApp: true });
    try {
      await call("machine-release", { machine: String(m.id), note: `stopped by ${by} in Joya` }, by);
    } catch (e) {
      // Already ended there (or the supervisor is down): the app was told to stop either way.
    }
    return { ok: true };
  }

  async function takeOver(id, purpose, minutes, by) {
    const m = get(id);
    if (!m) return { error: "No such computer." };
    if (claudeMissing(m)) return { error: NOT_INSTALLED.replace("that computer", `"${m.name}"`) + "." };
    try {
      const r = await call("machine-take-over", { machine: String(m.id), purpose: String(purpose || ""), ...(minutes ? { minutes } : {}) }, by);
      return { ok: true, status: r.status, minutes: r.minutes };
    } catch (e) {
      return { error: e.message };
    }
  }

  /* ---------------------------------------------------------- the link --- */

  function send(id, obj) {
    const l = links.get(id);
    if (!l || l.ws.readyState !== 1) return false;
    try {
      l.ws.send(JSON.stringify(obj));
      return true;
    } catch (_) {
      return false;
    }
  }

  /** The token from the upgrade's Authorization header -> the machine, or null. */
  function authenticate(req) {
    const h = String((req.headers && req.headers.authorization) || "");
    const m = /^Bearer\s+(\S+)$/.exec(h);
    if (!m || !TOKEN_RE.test(m[1])) return null;
    return q.byHash.get(sha(m[1])) || null;
  }

  /** One WebSocket from a computer's app (already authenticated). */
  function connected(ws, machine) {
    const id = machine.id;
    const old = links.get(id);
    if (old) {
      try {
        old.ws.close(4409, "replaced by a newer link");
      } catch (_) {
        /* gone */
      }
    }
    const link = { ws, hello: null, at: now() };
    links.set(id, link);
    q.seen.run(iso(), null, null, null, null, null, id);
    log(`machines: computer #${id} "${machine.name}" linked`);
    const json = (o2) => ws.readyState === 1 && ws.send(JSON.stringify(o2));
    json({ t: "welcome", machine_id: id, name: machine.name });
    ws.isAlive = true;
    ws.on("pong", () => {
      ws.isAlive = true;
    });
    ws.on("message", (data, binary) => {
      if (binary) return;
      let m;
      try {
        m = JSON.parse(String(data));
      } catch (_) {
        return;
      }
      if (!m || typeof m !== "object") return;
      onMessage(id, m).catch((e) => log(`machines: computer #${id} ${m.t}: ${e.message}`));
    });
    ws.on("close", () => {
      if (links.get(id) === link) {
        links.delete(id);
        q.seen.run(iso(), null, null, null, null, null, id);
        log(`machines: computer #${id} unlinked (connection closed)`);
        // Questions in flight are withdrawn (their cards cancelled); the lease ends on the app's side
        // after 30 s without the link, and here at its time.
        for (const [k, v] of pendingAsks) {
          if (!k.startsWith(id + ":")) continue;
          pendingAsks.delete(k);
          call("machine-ask-cancel", { slug: v.slug, request_id: k.slice(String(id).length + 1) }, "machine." + id).catch(() => {});
        }
        syncSoon();
      }
    });
    syncSoon();
  }

  async function onMessage(id, m) {
    const actor = "machine." + id;
    const lease = () => q.leaseActive.get(id) || null;
    switch (m.t) {
      case "hello": {
        const home = typeof m.home === "string" && m.home.length < 260 ? m.home : null;
        const claude =
          m.claude && typeof m.claude === "object"
            ? JSON.stringify({ found: typeof m.claude.found === "boolean" ? m.claude.found : !!m.claude.path, path: m.claude.path ? clip(m.claude.path, 260) : null, version: m.claude.version ? clip(m.claude.version, 60) : null, git_bash: !!m.claude.git_bash })
            : null;
        const before = q.byId.get(id);
        if (before && claude && before.claude_json !== claude) log(`machines: computer #${id} Claude Code: ${JSON.parse(claude).found ? "found" : "not found"}`);
        q.seen.run(iso(), /^\d+\.\d+\.\d+$/.test(String(m.app_version || "")) ? m.app_version : null, m.host ? clip(m.host, 64) : null, m.user ? clip(m.user, 64) : null, home, claude, id);
        // 0.1.11: the Claude in Chrome extension and Office (older apps say neither: left as they were).
        if (m.chrome && typeof m.chrome === "object") {
          const prev = chromeOf(before) || {};
          const last = m.chrome.last && typeof m.chrome.last === "object" ? { connected: m.chrome.last.connected === true, at: typeof m.chrome.last.at === "string" ? clip(m.chrome.last.at, 40) : iso(), detail: clip(redact(String(m.chrome.last.detail || "")), 200) } : prev.last || null;
          q.chrome.run(JSON.stringify({ extension: m.chrome.extension === true, browser: m.chrome.browser ? clip(String(m.chrome.browser), 20) : null, profile: m.chrome.profile ? clip(String(m.chrome.profile), 60) : null, last }), id);
        }
        if (Array.isArray(m.office)) q.office.run(JSON.stringify(m.office.filter((x) => ["Word", "Excel", "PowerPoint"].includes(x))), id);
        const l = links.get(id);
        if (l) l.hello = { at: now() };
        syncSoon();
        return;
      }
      case "ping":
        return send(id, { t: "pong" });
      case "lease": {
        const l = lease();
        if (!l || (m.lease_id != null && Number(m.lease_id) !== l.id)) return;
        if (m.state === "active") {
          starting.delete(l.id); // the app took the start
          return;
        }
        if (m.state === "extended" && typeof m.expires_at === "string") {
          const t = now();
          const want = Date.parse(m.expires_at);
          if (Number.isFinite(want)) q.leaseExpiry.run(iso(Math.min(Math.max(want, t), t + MAX_LEASE_MS)), l.id);
          return;
        }
        if (m.state === "ended") {
          const why = END_REASONS.includes(m.reason) ? m.reason : "ended";
          endLease(id, l, why, { tellSupervisor: true });
        }
        return;
      }
      case "ask": {
        const rid = String(m.rid || "").slice(0, 64);
        const l = lease();
        const deny = (why) => send(id, { t: "answer", rid, behavior: "deny", message: why });
        if (!rid) return;
        if (!l || l.slug !== m.slug) return deny("No active control lease on this computer.");
        if (Date.parse(l.expires_at) + GRACE_MS < now()) return deny("The control lease has ended.");
        let input;
        try {
          input = JSON.stringify(m.input && typeof m.input === "object" ? m.input : {});
        } catch (_) {
          input = "{}";
        }
        if (input.length > 16000) input = JSON.stringify({ truncated: input.slice(0, 15000) });
        if (input.length < 2) input = "{}";
        const tool = /^[A-Za-z0-9_.:-]{1,80}$/.test(String(m.tool || "")) ? String(m.tool) : "unknown";
        const key = id + ":" + rid;
        pendingAsks.set(key, { slug: l.slug });
        try {
          const r = await call(
            "machine-ask",
            {
              slug: l.slug,
              request_id: rid,
              tool,
              input,
              ...(m.reason ? { reason: clip(m.reason, 2000) } : {}),
              ...(m.tool_use_id && /^[A-Za-z0-9_-]{1,64}$/.test(m.tool_use_id) ? { tool_use_id: m.tool_use_id } : {}),
              origin: m.origin === "hands" ? "hands" : "cli",
              // A browser step's hint from the app (element labels, tab addresses): data for the gate's rules.
              ...(m.hint && typeof m.hint === "object" ? { hint: clip(JSON.stringify(m.hint), 8000) } : {}),
            },
            actor,
            { timeout: ASK_TIMEOUT_MS }
          );
          if (!pendingAsks.has(key)) return; // withdrawn meanwhile
          pendingAsks.delete(key);
          // auto: Joya's rules let it run (no card) -- the app's action log tells that from "approved".
          send(id, { t: "answer", rid, behavior: r && r.behavior === "allow" ? "allow" : "deny", ...(r && r.behavior === "allow" && r.auto ? { auto: true } : {}), ...(r && r.message ? { message: clip(r.message, 1000) } : {}) });
        } catch (e) {
          pendingAsks.delete(key);
          deny(`Joya could not be asked (${clip(e.message, 200)}), so it was denied.`);
        }
        return;
      }
      case "cancel": {
        const rid = String(m.rid || "").slice(0, 64);
        const v = pendingAsks.get(id + ":" + rid);
        if (!v) return;
        pendingAsks.delete(id + ":" + rid);
        await call("machine-ask-cancel", { slug: v.slug, request_id: rid }, actor).catch(() => {});
        return;
      }
      case "action":
        return recordAction(id, m);
      case "browser": {
        // What a browser step showed: the extension answered, or it is not connected.
        const cur = q.byId.get(id);
        const c = chromeOf(cur) || { extension: true };
        const last = { connected: m.connected === true, at: typeof m.at === "string" && Number.isFinite(Date.parse(m.at)) ? new Date(Date.parse(m.at)).toISOString() : iso(), detail: clip(redact(String(m.detail || "")), 200) };
        q.chrome.run(JSON.stringify({ extension: c.extension !== false, browser: c.browser || null, profile: c.profile || null, last }), id);
        log(`machines: computer #${id} Claude in Chrome ${last.connected ? "answered" : "not connected"}`);
        syncSoon();
        return;
      }
      case "report": {
        const l = lease();
        const text = String(m.text || "").trim();
        if (!l || l.slug !== m.slug || !text) return;
        await call("machine-report", { slug: l.slug, text: clip(text, 20000) }, actor).catch((e) => log(`machines: report from #${id}: ${e.message}`));
        return;
      }
      case "session": {
        const l = lease();
        if (!l || l.slug !== m.slug) return;
        if (m.state === "starting" || m.state === "running") {
          starting.delete(l.id);
          await call("machine-state", { slug: l.slug, state: m.state }, actor).catch(() => {});
          return;
        }
        if (m.state === "failed" || m.state === "exited") {
          // A start failure keeps its reason on the lease (the Computers page shows it).
          const detail = clip(String(m.detail || "").replace(/[\u0000-\u001f]+/g, " ").trim(), 280);
          endLease(id, l, m.state === "failed" ? (detail ? "failed: " + detail : "failed") : "runner-exited", { tellApp: true });
          await call("machine-state", { slug: l.slug, state: m.state, reason: clip(detail || m.state, 300) }, actor).catch(() => {});
        }
        return;
      }
      default:
        return;
    }
  }

  /**
   * One action of the laptop session, into the action log: its time, kind (hands / browser / cli),
   * tool, target, who let it run, whether it worked and the result. An older app (before 0.1.11)
   * sends summary + decision only: decision "error" then means it failed. A screenshot is never kept.
   */
  function recordAction(id, m) {
    const l = q.leaseActive.get(id) || (m.lease_id ? q.leaseGet.get(Number(m.lease_id)) : null);
    if (!l || Number(l.machine_id) !== id) return;
    if (m.lease_id != null && Number(m.lease_id) !== l.id) return; // another (older) lease's late entry
    const tool = clip(String(m.tool || "action").replace(/[^\w.:-]/g, ""), 80) || "action";
    const target = clip(redact(String(m.target != null ? m.target : m.summary || "")), 500);
    let decision = DECISIONS.includes(m.decision) ? m.decision : "auto";
    let result = m.result === "ok" || m.result === "error" ? m.result : decision === "error" || decision === "denied" || decision === "refused" ? "error" : "ok";
    if (decision === "error") decision = "auto"; // an older app's failure: it ran by the rules and failed
    const kind = KINDS.includes(m.kind) ? m.kind : tool.startsWith("mcp__joya-hands__") ? "hands" : tool.startsWith("mcp__claude-in-chrome__") ? "browser" : "cli";
    const detail = clip(redact(String(m.detail || "")), 300);
    const at = typeof m.at === "string" && Number.isFinite(Date.parse(m.at)) ? new Date(Date.parse(m.at)).toISOString() : iso();
    const r = q.logIns.run(id, l.id, l.slug, at, iso(), kind, tool, target, decision, decision === "approved" ? 1 : 0, result, detail);
    return Number(r.lastInsertRowid);
  }

  function publicAction(a) {
    return { id: a.id, at: a.at, kind: a.kind, tool: a.tool, target: a.target, decision: a.decision, approved: !!a.approved, result: a.result, detail: a.detail || "" };
  }
  /** A take-over's action log after `afterId` (0 = from the start), oldest first. */
  function log2(leaseId, afterId) {
    return q.logOf.all(Number(leaseId), Math.max(0, Number(afterId) || 0)).map(publicAction);
  }
  /** Its last `n` actions, oldest first (for the Computers page's live strip). */
  function lastActions(leaseId, n) {
    return q.logLast.all(Number(leaseId), Math.min(Math.max(Number(n) || 8, 1), 50)).reverse().map(publicAction);
  }

  function leases(id, limit) {
    return q.leases.all(Number(id), Math.min(Number(limit) || 30, 200)).map((l) => ({ ...publicLease(l), actions: (l.actions || 0) + q.logCount.get(l.id).n }));
  }
  function lease(leaseId) {
    const l = q.leaseGet.get(Number(leaseId));
    return l ? publicLease(l) : null;
  }
  function actions(leaseId) {
    return q.actions.all(Number(leaseId)).map((a) => ({ id: a.id, at: a.at, tool: a.tool, summary: a.summary, decision: a.decision, shot: !!a.shot }));
  }
  /** The screenshot's file for an action, or null (inside dir, always). */
  function shotFile(actionId) {
    const a = q.action.get(Number(actionId));
    if (!a || !a.shot) return null;
    const p = path.resolve(dir, a.shot);
    if (!p.startsWith(path.resolve(dir) + path.sep)) return null;
    return fs.existsSync(p) ? p : null;
  }

  /** The action log after RETENTION_DAYS (90); the old screenshot rows (and their files) after SHOT_RETENTION_DAYS (7). */
  function prune() {
    const n2 = q.logOld.run(iso(now() - RETENTION_DAYS * 24 * 3600 * 1000)).changes;
    if (n2) log(`machines: ${n2} action-log row(s) older than ${RETENTION_DAYS} days deleted`);
    const before = iso(now() - SHOT_RETENTION_DAYS * 24 * 3600 * 1000);
    let n = n2;
    for (const a of q.oldActions.all(before)) {
      if (a.shot) {
        try {
          fs.unlinkSync(path.resolve(dir, a.shot));
        } catch (_) {
          /* gone already */
        }
      }
      q.delAction.run(a.id);
      n++;
    }
    if (n > n2) log(`machines: ${n - n2} screenshot action(s) older than ${SHOT_RETENTION_DAYS} days deleted with their screenshots`);
    return n;
  }

  /** Leases past their end (plus grace): ended here, the app told to stop, the supervisor told. */
  function sweep() {
    const t = now();
    for (const l of q.leaseOpen.all()) {
      const sent = starting.get(l.id);
      if (sent != null && sent + START_TIMEOUT_MS < t) {
        // The app never took the start: end it, and tell the supervisor it FAILED (JOYA AI hears why).
        log(`machines: lease #${l.id} on computer #${l.machine_id} (${l.slug}): no start from the app in ${START_TIMEOUT_MS / 1000} s`);
        endLease(l.machine_id, l, "failed: " + NO_START, { tellApp: true });
        call("machine-state", { slug: l.slug, state: "failed", reason: NO_START }, "machine." + l.machine_id).catch(() => {});
        continue;
      }
      if (Date.parse(l.expires_at) + GRACE_MS < t) endLease(l.machine_id, l, "timeout", { tellApp: true, tellSupervisor: true });
    }
    for (const [, l] of links) {
      if (l.ws.isAlive === false) {
        try {
          l.ws.terminate();
        } catch (_) {
          /* gone */
        }
        continue;
      }
      l.ws.isAlive = false;
      try {
        l.ws.ping();
      } catch (_) {
        /* closing */
      }
    }
  }

  /* ---------------------------------------------- the supervisor's side --- */

  let syncTimer = null;
  function syncSoon() {
    if (syncTimer || stopped) return;
    syncTimer = setTimeout(() => {
      syncTimer = null;
      sync().catch(() => {});
    }, 50);
    if (syncTimer.unref) syncTimer.unref();
  }
  function sync() {
    const machines = q.list.all().map((m) => {
      const c = claudeOf(m);
      const ch = chromeOf(m);
      const folders = foldersOf(m);
      const office = officeOf(m);
      return {
        id: m.id,
        name: m.name,
        online: links.has(m.id),
        ...(m.platform ? { platform: m.platform } : {}),
        ...(m.home ? { home: m.home } : {}),
        ...(c ? { claude: { found: c.found, version: c.version, git_bash: c.git_bash } } : {}),
        ...(ch ? { chrome: { extension: ch.extension, allowed: ch.allowed, ...(ch.last ? { last: { connected: ch.last.connected } } : {}) } } : {}),
        ...(folders.length ? { folders } : {}),
        ...(office.length ? { office } : {}),
      };
    });
    return call("machines-sync", { machines }, "machines");
  }

  /** The supervisor's "machine" events: start (a take-over), tell, stop. */
  function onSupervisorEvent(ev) {
    if (!ev || ev.type !== "machine") return;
    const id = Number(ev.machine_id);
    const m = get(id);
    const actor = "machine." + id;
    if (ev.what === "start") {
      const fail = (why) => call("machine-state", { slug: ev.slug, state: "failed", reason: why }, actor).catch(() => {});
      if (!m) return fail("the computer is not linked");
      if (!links.has(id)) return fail("the computer is offline");
      const cur = q.leaseActive.get(id);
      if (cur) return fail("the computer is already under control");
      if (claudeMissing(m)) return fail(NOT_INSTALLED);
      const minutes = Number.isInteger(ev.minutes) && ev.minutes >= 1 && ev.minutes <= 60 ? ev.minutes : DEFAULT_MINUTES;
      const t = now();
      const r = q.leaseIns.run(id, ev.slug, clip(ev.name, 64), clip(ev.purpose, 4000), ev.by ? clip(ev.by, 64) : null, iso(t), iso(t + minutes * 60000));
      const leaseId = Number(r.lastInsertRowid);
      log(`machines: lease #${leaseId} on computer #${id} for ${ev.slug}, ${minutes} min`);
      starting.set(leaseId, t);
      const ok = send(id, { t: "start", slug: ev.slug, name: ev.name, purpose: ev.purpose, model: ev.model || null, first_prompt: ev.first_prompt, lease: { id: String(leaseId), minutes, expires_at: iso(t + minutes * 60000) }, folders: foldersOf(m), browser: m.browser_allowed !== 0 });
      if (!ok) {
        endLease(id, q.leaseGet.get(leaseId), "failed");
        fail("the computer could not be reached");
      }
      return;
    }
    if (ev.what === "tell") {
      const l = q.leaseActive.get(id);
      if (l && l.slug === ev.slug) send(id, { t: "tell", slug: ev.slug, text: String(ev.text || "") });
      return;
    }
    if (ev.what === "stop") {
      const l = q.leaseActive.get(id);
      if (l && l.slug === ev.slug) endLease(id, l, "server", { tellApp: true });
    }
  }

  function connectSupervisor() {
    if (stopped || !subscribe) return;
    try {
      sub = subscribe(Number.MAX_SAFE_INTEGER, "machines", onSupervisorEvent, () => {
        sub = null;
        if (stopped) return;
        subTimer = setTimeout(connectSupervisor, 3000);
        if (subTimer.unref) subTimer.unref();
      });
      syncSoon();
    } catch (e) {
      subTimer = setTimeout(connectSupervisor, 3000);
      if (subTimer.unref) subTimer.unref();
    }
  }

  function start() {
    connectSupervisor();
    const a = setInterval(sweep, 10000);
    const b = setInterval(prune, 3600 * 1000);
    for (const t of [a, b]) if (t.unref) t.unref();
    timers.push(a, b);
    setTimeout(prune, 5000).unref();
  }
  function stop() {
    stopped = true;
    for (const t of timers) clearInterval(t);
    clearTimeout(subTimer);
    if (typeof sub === "function") sub();
    for (const [, l] of links) {
      try {
        l.ws.close(1001, "server stopping");
      } catch (_) {
        /* gone */
      }
    }
  }

  return { issueCode, withdrawCode, claim, list, get, rename, revoke, extend, stopControl, takeOver, authenticate, connected, onMessage, onSupervisorEvent, leases, lease, actions, actionLog: log2, lastActions, shotFile, prune, sweep, sync, send, start, stop, publicMachine, setBrowser, addFolder, removeFolder };
}

module.exports = { create, newCode, normCode, showCode, cleanName, cleanFolder, newToken, claudeOf, claudeMissing, TOKEN_RE, CODE_MS, RETENTION_DAYS, SHOT_RETENTION_DAYS, DEFAULT_MINUTES, END_REASONS, START_TIMEOUT_MS, NOT_INSTALLED, NO_START };
