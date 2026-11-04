"use strict";
/**
 * The delegation ledger: SQLite at /var/lib/joya-ai/ledger.db.
 *
 * The supervisor is its only writer. Hooks do not open it; they post to the
 * supervisor's hook socket, so there is one process deciding what a delegation's
 * state is and no two writers racing over the same row.
 *
 * Tables
 *   delegations  one per SendMessage: sent -> working -> ack (replied) -> done,
 *                or held / failed / denied
 *   inbound      every cross-session message, idle notice and delivery notice
 *   approvals    every Approve / Deny card, with who answered and when
 *   turns        every turn JOYA AI ran, and where it came from
 *   audit        every action taken through the socket, with the panel user
 *   hired_sessions  the worker sessions JOYA AI (or the administrator) hired
 *                (M-6): hired -> retired; kept by the administrator or not
 */

const { DatabaseSync } = require("node:sqlite");
const fs = require("fs");
const path = require("path");

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS delegations (
  id              INTEGER PRIMARY KEY,
  msg_id          TEXT UNIQUE,
  tool_use_id     TEXT,
  turn_id         INTEGER,
  target          TEXT NOT NULL,
  target_name     TEXT NOT NULL,
  target_pid      INTEGER,
  target_session  TEXT,
  text            TEXT NOT NULL,
  summary         TEXT,
  notify_idle     INTEGER NOT NULL DEFAULT 0,
  status          TEXT NOT NULL,
  note            TEXT,
  reply_text      TEXT,
  created_at      TEXT NOT NULL,
  working_at      TEXT,
  replied_at      TEXT,
  done_at         TEXT,
  failed_at       TEXT,
  updated_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS delegations_open ON delegations(status, target_pid, target_name);

CREATE TABLE IF NOT EXISTS inbound (
  id              INTEGER PRIMARY KEY,
  kind            TEXT NOT NULL,
  from_name       TEXT,
  from_pid        INTEGER,
  text            TEXT NOT NULL,
  delegation_id   INTEGER REFERENCES delegations(id),
  received_at     TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS approvals (
  id              INTEGER PRIMARY KEY,
  request_id      TEXT NOT NULL,
  tool_use_id     TEXT,
  turn_id         INTEGER,
  tool            TEXT NOT NULL,
  input_json      TEXT NOT NULL,
  summary         TEXT NOT NULL,
  category        TEXT,
  label           TEXT,
  reason          TEXT,
  status          TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  expires_at      TEXT NOT NULL,
  decided_at      TEXT,
  decided_by      TEXT,
  note            TEXT
);

CREATE TABLE IF NOT EXISTS turns (
  id              INTEGER PRIMARY KEY,
  uuid            TEXT UNIQUE,
  source          TEXT NOT NULL,
  actor           TEXT,
  text            TEXT NOT NULL,
  target          TEXT,
  status          TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  started_at      TEXT,
  ended_at        TEXT,
  duration_ms     INTEGER,
  cost_usd        REAL,
  result_text     TEXT,
  error           TEXT
);

CREATE TABLE IF NOT EXISTS missions (
  id              INTEGER PRIMARY KEY,
  title           TEXT NOT NULL,
  goal            TEXT,
  status          TEXT NOT NULL,
  created_by      TEXT,
  turn_id         INTEGER,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  done_at         TEXT
);

CREATE TABLE IF NOT EXISTS steps (
  id              INTEGER PRIMARY KEY,
  mission_id      INTEGER NOT NULL REFERENCES missions(id),
  n               INTEGER NOT NULL,
  title           TEXT NOT NULL,
  detail          TEXT,
  target          TEXT,
  status          TEXT NOT NULL,
  delegation_id   INTEGER,
  approval_id     INTEGER,
  result          TEXT,
  note            TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  started_at      TEXT,
  done_at         TEXT,
  UNIQUE (mission_id, n)
);

CREATE TABLE IF NOT EXISTS mission_turns (
  mission_id      INTEGER NOT NULL,
  turn_id         INTEGER NOT NULL,
  PRIMARY KEY (mission_id, turn_id)
);

CREATE TABLE IF NOT EXISTS decisions (
  id              INTEGER PRIMARY KEY,
  kind            TEXT NOT NULL,
  watcher         TEXT,
  subject         TEXT,
  title           TEXT NOT NULL,
  detail          TEXT,
  evidence        TEXT,
  proposal        TEXT,
  fix_command     TEXT,
  status          TEXT NOT NULL,
  count           INTEGER NOT NULL DEFAULT 1,
  first_seen      TEXT NOT NULL,
  last_seen       TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  decided_by      TEXT,
  decided_at      TEXT,
  turn_id         INTEGER,
  fix_turn_id     INTEGER,
  result          TEXT,
  rate_limited    INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS decisions_key ON decisions(watcher, subject, status);

CREATE TABLE IF NOT EXISTS watchers (
  key             TEXT PRIMARY KEY,
  enabled         INTEGER NOT NULL,
  updated_by      TEXT,
  updated_at      TEXT NOT NULL,
  last_fired_at   TEXT,
  state_text      TEXT
);

CREATE TABLE IF NOT EXISTS orders (
  id              INTEGER PRIMARY KEY,
  name            TEXT NOT NULL,
  kind            TEXT NOT NULL,
  at              TEXT,
  dow             INTEGER,
  every_h         INTEGER,
  cron            TEXT NOT NULL,
  tz              TEXT NOT NULL,
  target          TEXT NOT NULL,
  prompt          TEXT NOT NULL,
  delivery        TEXT NOT NULL,
  paused          INTEGER NOT NULL DEFAULT 0,
  seed_key        TEXT UNIQUE,
  last_run_at     TEXT,
  last_status     TEXT,
  last_result     TEXT,
  next_run_at     TEXT,
  created_by      TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS order_runs (
  id              INTEGER PRIMARY KEY,
  order_id        INTEGER NOT NULL,
  scheduled_for   TEXT,
  started_at      TEXT NOT NULL,
  ended_at        TEXT,
  turn_id         INTEGER,
  status          TEXT NOT NULL,
  result          TEXT,
  manual          INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS rules (
  id              INTEGER PRIMARY KEY,
  effect          TEXT NOT NULL,
  tool            TEXT NOT NULL,
  pattern         TEXT NOT NULL,
  note            TEXT,
  builtin         INTEGER NOT NULL DEFAULT 0,
  builtin_key     TEXT UNIQUE,
  scope_session   TEXT,
  scope_machine   TEXT,
  created_by      TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  uses            INTEGER NOT NULL DEFAULT 0,
  last_used_at    TEXT,
  source_approval_id INTEGER
);

CREATE TABLE IF NOT EXISTS settings (
  key             TEXT PRIMARY KEY,
  value           TEXT,
  updated_by      TEXT,
  updated_at      TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS cost_daily (
  session_id      TEXT NOT NULL,
  day             TEXT NOT NULL,
  model           TEXT NOT NULL,
  input           INTEGER NOT NULL DEFAULT 0,
  output          INTEGER NOT NULL DEFAULT 0,
  cache_write     INTEGER NOT NULL DEFAULT 0,
  cache_read      INTEGER NOT NULL DEFAULT 0,
  usd             REAL NOT NULL DEFAULT 0,
  PRIMARY KEY (session_id, day, model)
);

CREATE TABLE IF NOT EXISTS cost_files (
  path            TEXT PRIMARY KEY,
  ino             INTEGER,
  off             INTEGER NOT NULL,
  last_msg        TEXT,
  updated_at      TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS cost_names (
  session_id      TEXT PRIMARY KEY,
  name            TEXT,
  cwd             TEXT,
  updated_at      TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS hired_sessions (
  id              INTEGER PRIMARY KEY,
  slug            TEXT NOT NULL UNIQUE,
  name            TEXT NOT NULL,
  cwd             TEXT NOT NULL,
  purpose         TEXT NOT NULL,
  model           TEXT,
  session_id      TEXT NOT NULL,
  status          TEXT NOT NULL,
  kept            INTEGER NOT NULL DEFAULT 0,
  hired_by        TEXT NOT NULL,
  hired_at        TEXT NOT NULL,
  retire_asked_at TEXT,
  retire_approval_id INTEGER,
  retired_at      TEXT,
  retired_by      TEXT,
  note            TEXT,
  updated_at      TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS audit (
  id              INTEGER PRIMARY KEY,
  at              TEXT NOT NULL,
  actor           TEXT NOT NULL,
  op              TEXT NOT NULL,
  detail          TEXT,
  ok              INTEGER NOT NULL,
  error           TEXT
);
`;

const now = () => new Date().toISOString();

class Ledger {
  constructor(file) {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(file);
    this.db.exec(SCHEMA);
    this.migrate();
    try {
      fs.chmodSync(file, 0o600);
    } catch (_) {
      /* not ours to fix if it fails */
    }
    this.q = {};
  }

  /** Columns added after the first release; ALTER is idempotent by probing. */
  migrate() {
    const add = {
      turns: ["order_id INTEGER", "mission_id INTEGER", "decision_id INTEGER", "proc_start TEXT", "cost_delta_usd REAL", "sent_at TEXT", "tokens_cum TEXT", "tok_input INTEGER", "tok_output INTEGER", "tok_cache_read INTEGER", "tok_cache_write INTEGER",
        // The living canvas (2026-10-20): the widgets shown with the reply, a JSON list [{ id, at, widget }] (lib/joya-widgets.js).
        "widgets TEXT",
        // Voice lanes (lib/voicelane.js, 2026-10-30): the live call a request came from, the lane that ran it
        // (quick, work, agent, main), the request an agent's reply follows, and whose call it was (the snapshot reads it).
        "call_id TEXT", "lane TEXT", "follows INTEGER", "voice_actor TEXT"],
      delegations: ["mission_id INTEGER", "step_id INTEGER", "target_kind TEXT", "target_ref TEXT"],
      // verified / verified_with: how the administrator confirmed an approve in the panel (Windows Hello or the code, 2026-10-08).
      approvals: ["mission_id INTEGER", "step_id INTEGER", "decision_id INTEGER", "rule_id INTEGER", "origin TEXT", "origin_name TEXT", "verified TEXT", "verified_with TEXT"],
      // Token-cap cards (kind "cap", subject = the session's cap key): warn or pause, and the Cairo day.
      decisions: ["cap_at TEXT", "cap_day TEXT"],
      // A session JOYA AI runs on one of the user's own computers (lib/machines.js): the dashboard's machine id.
      hired_sessions: ["machine_id INTEGER"],
    };
    for (const [table, cols] of Object.entries(add)) {
      const have = new Set(this.db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name));
      for (const c of cols) if (!have.has(c.split(" ")[0])) this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${c}`);
    }
  }

  prep(sql) {
    if (!this.q[sql]) this.q[sql] = this.db.prepare(sql);
    return this.q[sql];
  }

  get(table, id) {
    return this.prep(`SELECT * FROM ${table} WHERE id = ?`).get(id) || null;
  }

  /* ------------------------------------------------------------- turns --- */

  addTurn({ uuid, source, actor, text, target, status, order_id, mission_id, decision_id }) {
    const r = this.prep(
      "INSERT INTO turns (uuid, source, actor, text, target, status, created_at, order_id, mission_id, decision_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
    ).run(uuid || null, source, actor || null, text, target || null, status || "queued", now(), order_id || null, mission_id || null, decision_id || null);
    return this.get("turns", Number(r.lastInsertRowid));
  }
  turnByUuid(uuid) {
    return this.prep("SELECT * FROM turns WHERE uuid = ?").get(uuid) || null;
  }
  updateTurn(id, fields) {
    return this.update("turns", id, fields);
  }

  /* ------------------------------------------------------- delegations --- */

  addDelegation(d) {
    const t = now();
    const r = this.prep(
      `INSERT INTO delegations (msg_id, tool_use_id, turn_id, target, target_name, target_pid, target_session,
         text, summary, notify_idle, status, note, created_at, updated_at, failed_at, target_kind, target_ref)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(msg_id) DO NOTHING`
    ).run(
      d.msg_id || null,
      d.tool_use_id || null,
      d.turn_id || null,
      d.target,
      d.target_name,
      d.target_pid || null,
      d.target_session || null,
      d.text,
      d.summary || null,
      d.notify_idle ? 1 : 0,
      d.status,
      d.note || null,
      t,
      t,
      d.status === "failed" || d.status === "denied" ? t : null,
      d.target_kind || null,
      d.target_ref || null
    );
    if (!r.changes) return this.prep("SELECT * FROM delegations WHERE msg_id = ?").get(d.msg_id) || null;
    return this.get("delegations", Number(r.lastInsertRowid));
  }

  /** Open delegations to a session, newest first. */
  openDelegationsFor({ pid, name }) {
    return this.prep(
      `SELECT * FROM delegations
        WHERE status IN ('sent', 'working', 'ack', 'held')
          AND ((? IS NOT NULL AND target_pid = ?) OR (target_name = ?))
        ORDER BY id DESC`
    ).all(pid || null, pid || null, name || "");
  }
  openDelegations() {
    return this.prep("SELECT * FROM delegations WHERE status IN ('sent', 'working', 'ack', 'held') ORDER BY id").all();
  }
  updateDelegation(id, fields) {
    return this.update("delegations", id, { ...fields, updated_at: now() });
  }

  /* ----------------------------------------------------------- inbound --- */

  addInbound({ kind, from_name, from_pid, text, delegation_id }) {
    const r = this.prep(
      "INSERT INTO inbound (kind, from_name, from_pid, text, delegation_id, received_at) VALUES (?, ?, ?, ?, ?, ?)"
    ).run(kind, from_name || null, from_pid || null, text, delegation_id || null, now());
    return this.get("inbound", Number(r.lastInsertRowid));
  }

  /* --------------------------------------------------------- approvals --- */

  addApproval(a) {
    const r = this.prep(
      `INSERT INTO approvals (request_id, tool_use_id, turn_id, tool, input_json, summary, category, label, reason,
         status, created_at, expires_at, origin, origin_name) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?)`
    ).run(
      a.request_id,
      a.tool_use_id || null,
      a.turn_id || null,
      a.tool,
      a.input_json,
      a.summary,
      a.category || null,
      a.label || null,
      a.reason || null,
      now(),
      a.expires_at,
      a.origin || null,
      a.origin_name || null
    );
    return this.get("approvals", Number(r.lastInsertRowid));
  }
  /* ---------------------------------------------------- hired sessions --- */

  addHired(h) {
    const t = now();
    const r = this.prep(
      `INSERT INTO hired_sessions (slug, name, cwd, purpose, model, session_id, status, kept, hired_by, hired_at, updated_at, machine_id)
       VALUES (?, ?, ?, ?, ?, ?, 'hired', 0, ?, ?, ?, ?)`
    ).run(h.slug, h.name, h.cwd, h.purpose, h.model || null, h.session_id, h.hired_by, t, t, h.machine_id || null);
    return this.get("hired_sessions", Number(r.lastInsertRowid));
  }
  hiredList(all) {
    return this.prep(all ? "SELECT * FROM hired_sessions ORDER BY id" : "SELECT * FROM hired_sessions WHERE status != 'retired' ORDER BY id").all();
  }
  hiredSince(iso) {
    return this.prep("SELECT count(*) AS n FROM hired_sessions WHERE hired_at >= ?").get(iso).n;
  }
  updateHired(id, fields) {
    return this.update("hired_sessions", id, { ...fields, updated_at: now() });
  }

  pendingApprovals() {
    return this.prep("SELECT * FROM approvals WHERE status = 'pending' ORDER BY id").all();
  }
  updateApproval(id, fields) {
    return this.update("approvals", id, fields);
  }

  /* ------------------------------------------------------------- audit --- */

  audit(actor, op, detail, ok, error) {
    this.prep("INSERT INTO audit (at, actor, op, detail, ok, error) VALUES (?, ?, ?, ?, ?, ?)").run(
      now(),
      actor,
      op,
      detail == null ? null : JSON.stringify(detail).slice(0, 4000),
      ok ? 1 : 0,
      error ? String(error).slice(0, 500) : null
    );
  }

  /* ------------------------------------------------------------- query --- */

  list(table, { limit = 50, before_id, status } = {}) {
    const col = table === "inbound" ? "kind" : "status";
    const where = [];
    const args = [];
    if (before_id) {
      where.push("id < ?");
      args.push(before_id);
    }
    if (status && table !== "audit") {
      where.push(`${col} = ?`);
      args.push(status);
    }
    const sql = `SELECT * FROM ${table} ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY id DESC LIMIT ?`;
    return this.db.prepare(sql).all(...args, limit);
  }

  counts() {
    const one = (sql) => (this.prep(sql).get() || {}).n || 0;
    const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
    return {
      delegations_open: one("SELECT count(*) AS n FROM delegations WHERE status IN ('sent','working','ack','held')"),
      delegations_24h: this.prep("SELECT count(*) AS n FROM delegations WHERE created_at >= ?").get(since).n,
      approvals_pending: one("SELECT count(*) AS n FROM approvals WHERE status = 'pending'"),
      turns_24h: this.prep("SELECT count(*) AS n FROM turns WHERE created_at >= ?").get(since).n,
    };
  }

  /* ----------------------------------------------------------- helpers --- */

  update(table, id, fields) {
    const keys = Object.keys(fields);
    if (!keys.length) return this.get(table, id);
    for (const k of keys) if (!/^[a-z_]+$/.test(k)) throw new Error("bad column " + k);
    const sql = `UPDATE ${table} SET ${keys.map((k) => k + " = ?").join(", ")} WHERE id = ?`;
    this.db.prepare(sql).run(...keys.map((k) => (fields[k] === undefined ? null : fields[k])), id);
    return this.get(table, id);
  }

  close() {
    try {
      this.db.close();
    } catch (_) {
      /* already closed */
    }
  }
}

module.exports = { Ledger, now };
