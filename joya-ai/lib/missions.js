"use strict";
/**
 * Missions: a multi-step goal JOYA AI is carrying out, and its steps.
 *
 * JOYA AI creates a mission, records its steps, and delegates each step to the
 * session that owns the work. The delegation carries the step: JOYA AI puts
 * "M-<id> step <n>" in the first line of the message, or marks the step
 * "delegated" to a target just before sending. From then on the delegation's
 * own lifecycle moves the step along:
 *
 *   delegation  sent -> delegated   working / ack -> working   held -> waiting_approval
 *               done -> done        failed / denied -> failed
 *   approval    a pending card for that SendMessage -> waiting_approval
 *
 * JOYA AI can always set a step's status itself (it knows when a step it did
 * alone is finished). A mission is active once any step has moved, and done
 * when every step is done or skipped -- unless JOYA AI closed it otherwise.
 */

const { now } = require("./ledger");
const names = require("./names");

/** A step the assistant does itself is stored as "joya-ai", whichever of its names it was given. */
const stepTarget = (t) => (t && names.isSelfName(t) ? "joya-ai" : t);

const STEP_STATUSES = ["planned", "delegated", "working", "waiting_approval", "done", "failed", "skipped"];
const MISSION_STATUSES = ["planned", "active", "done", "failed", "cancelled"];
const FINAL_STEP = new Set(["done", "failed", "skipped"]);
const TAG_RE = /\bM-(\d{1,9})\b[^\n]{0,24}?\bstep\s*#?(\d{1,4})\b/i;
const MAX_STEPS = 50;

const DELEGATION_TO_STEP = {
  sent: "delegated",
  working: "working",
  ack: "working",
  held: "waiting_approval",
  done: "done",
  failed: "failed",
  denied: "failed",
};

function ref(id) {
  return "M-" + id;
}

/** "M-12" | 12 | "12" -> 12 */
function parseId(v) {
  const m = /^(?:M-)?(\d{1,9})$/i.exec(String(v == null ? "" : v).trim());
  if (!m) throw new Error("mission id must look like M-12");
  return Number(m[1]);
}

function bare(name) {
  return String(name || "").replace(/\s*\[[0-9a-f]+\]\s*$/i, "").trim().toLowerCase();
}

class Missions {
  constructor(ledger) {
    this.ledger = ledger;
    this.db = ledger.db;
  }

  get(id) {
    const m = this.db.prepare("SELECT * FROM missions WHERE id = ?").get(parseId(id));
    return m ? this.view(m) : null;
  }

  must(id) {
    const m = this.db.prepare("SELECT * FROM missions WHERE id = ?").get(parseId(id));
    if (!m) throw new Error(`no mission ${typeof id === "number" ? ref(id) : id}`);
    return m;
  }

  list({ status, limit = 50 } = {}) {
    const rows =
      status === "active"
        ? this.db.prepare("SELECT * FROM missions WHERE status IN ('planned','active') ORDER BY id DESC LIMIT ?").all(limit)
        : this.db.prepare("SELECT * FROM missions ORDER BY id DESC LIMIT ?").all(limit);
    return rows.map((m) => this.view(m));
  }

  steps(missionId) {
    return this.db.prepare("SELECT * FROM steps WHERE mission_id = ? ORDER BY n").all(missionId);
  }

  view(m, costOf) {
    const steps = this.steps(m.id);
    const done = steps.filter((s) => s.status === "done" || s.status === "skipped").length;
    const sessions = [...new Set(steps.map((s) => s.target).filter(Boolean))];
    const end = m.done_at ? Date.parse(m.done_at) : Date.now();
    const cost = this.cost(m.id);
    const tokens = this.tokens(m.id);
    return {
      ...m,
      ref: ref(m.id),
      steps,
      metrics: { steps_done: done, steps_total: steps.length, sessions, elapsed_s: Math.max(0, Math.round((end - Date.parse(m.created_at)) / 1000)), cost_usd: cost, tokens },
    };
  }

  /** Sum of JOYA AI's per-turn cost over the turns that worked on this mission. */
  cost(missionId) {
    const r = this.db
      .prepare("SELECT SUM(t.cost_delta_usd) AS usd, COUNT(t.cost_delta_usd) AS n FROM turns t JOIN mission_turns mt ON mt.turn_id = t.id WHERE mt.mission_id = ?")
      .get(missionId);
    return r && r.n ? Math.round(r.usd * 10000) / 10000 : null;
  }

  /** JOYA AI's tokens over the turns that worked on this mission (per-turn deltas of the CLI's running usage); null if none were counted. */
  tokens(missionId) {
    const r = this.db
      .prepare("SELECT SUM(t.tok_input) AS input, SUM(t.tok_output) AS output, SUM(t.tok_cache_read) AS cache_read, SUM(t.tok_cache_write) AS cache_write, COUNT(t.tok_input) AS n FROM turns t JOIN mission_turns mt ON mt.turn_id = t.id WHERE mt.mission_id = ?")
      .get(missionId);
    if (!r || !r.n) return null;
    const t = { input: r.input || 0, output: r.output || 0, cache_read: r.cache_read || 0, cache_write: r.cache_write || 0 };
    t.total = t.input + t.output + t.cache_read + t.cache_write;
    return t;
  }

  linkTurn(missionId, turnId) {
    if (!missionId || !turnId) return;
    this.db.prepare("INSERT OR IGNORE INTO mission_turns (mission_id, turn_id) VALUES (?, ?)").run(missionId, turnId);
  }

  /* ----------------------------------------------------------- writes --- */

  create({ title, goal, steps = [], actor, turn_id }) {
    if (steps.length > MAX_STEPS) throw new Error(`at most ${MAX_STEPS} steps`);
    const t = now();
    this.db.exec("BEGIN");
    let id;
    try {
      const r = this.db
        .prepare("INSERT INTO missions (title, goal, status, created_by, turn_id, created_at, updated_at) VALUES (?, ?, 'planned', ?, ?, ?, ?)")
        .run(title, goal || null, actor || null, turn_id || null, t, t);
      id = Number(r.lastInsertRowid);
      steps.forEach((s, i) => this.insertStep(id, i + 1, s, t));
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
    this.linkTurn(id, turn_id);
    return this.get(id);
  }

  insertStep(missionId, n, s, t) {
    this.db
      .prepare("INSERT INTO steps (mission_id, n, title, detail, target, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'planned', ?, ?)")
      .run(missionId, n, s.title, s.detail || null, stepTarget(s.target) || null, t, t);
  }

  addStep(missionId, s, turnId) {
    const m = this.must(missionId);
    if (FINAL_MISSION.has(m.status)) throw new Error(`${ref(m.id)} is ${m.status}`);
    const count = this.db.prepare("SELECT count(*) AS n, COALESCE(MAX(n), 0) AS top FROM steps WHERE mission_id = ?").get(m.id);
    if (count.n >= MAX_STEPS) throw new Error(`at most ${MAX_STEPS} steps`);
    const t = now();
    this.insertStep(m.id, count.top + 1, s, t);
    this.touch(m.id);
    this.linkTurn(m.id, turnId);
    return this.get(m.id);
  }

  step(missionId, n) {
    const m = this.must(missionId);
    const s = this.db.prepare("SELECT * FROM steps WHERE mission_id = ? AND n = ?").get(m.id, n);
    if (!s) throw new Error(`${ref(m.id)} has no step ${n}`);
    return s;
  }

  /** JOYA AI (or the delegation lifecycle) moves a step. */
  updateStep(missionId, n, fields, turnId) {
    const s = this.step(missionId, n);
    const t = now();
    const upd = { updated_at: t };
    if (fields.status !== undefined) {
      if (!STEP_STATUSES.includes(fields.status)) throw new Error("status must be one of " + STEP_STATUSES.join(", "));
      upd.status = fields.status;
      if (fields.status !== "planned" && !s.started_at) upd.started_at = t;
      if (FINAL_STEP.has(fields.status)) upd.done_at = t;
      else upd.done_at = null;
    }
    for (const k of ["title", "detail", "target", "result", "note", "delegation_id", "approval_id"]) if (fields[k] !== undefined) upd[k] = fields[k];
    if (upd.target) upd.target = stepTarget(upd.target);
    this.ledger.update("steps", s.id, upd);
    this.touch(s.mission_id);
    this.linkTurn(s.mission_id, turnId);
    this.derive(s.mission_id);
    return this.get(s.mission_id);
  }

  update(missionId, fields, turnId) {
    const m = this.must(missionId);
    const upd = { updated_at: now() };
    if (fields.status !== undefined) {
      if (!MISSION_STATUSES.includes(fields.status)) throw new Error("status must be one of " + MISSION_STATUSES.join(", "));
      upd.status = fields.status;
      upd.done_at = FINAL_MISSION.has(fields.status) ? now() : null;
    }
    if (fields.title !== undefined) upd.title = fields.title;
    if (fields.goal !== undefined) upd.goal = fields.goal;
    this.ledger.update("missions", m.id, upd);
    this.linkTurn(m.id, turnId);
    return this.get(m.id);
  }

  touch(id) {
    this.db.prepare("UPDATE missions SET updated_at = ? WHERE id = ?").run(now(), id);
  }

  /** planned -> active once a step moves; -> done when every step is. */
  derive(id) {
    const m = this.db.prepare("SELECT * FROM missions WHERE id = ?").get(id);
    if (!m || FINAL_MISSION.has(m.status) && m.status !== "done") return;
    const steps = this.steps(id);
    if (!steps.length) return;
    const allDone = steps.every((s) => s.status === "done" || s.status === "skipped");
    const moved = steps.some((s) => s.status !== "planned");
    let status = m.status;
    if (allDone) status = "done";
    else if (moved) status = "active";
    if (status !== m.status) this.ledger.update("missions", id, { status, done_at: status === "done" ? now() : null, updated_at: now() });
  }

  /* ------------------------------------------------ delegation linking --- */

  /**
   * A delegation was just recorded. Find its step: the "M-<id> step <n>" tag in
   * the message, else the one step marked delegated to this target that has no
   * delegation yet. Returns { mission_id, step } or null.
   */
  findStepFor(d) {
    const tag = TAG_RE.exec(String(d.text || "").slice(0, 400));
    if (tag) {
      const s = this.db.prepare("SELECT s.* FROM steps s JOIN missions m ON m.id = s.mission_id WHERE s.mission_id = ? AND s.n = ?").get(Number(tag[1]), Number(tag[2]));
      if (s) return s;
    }
    const name = bare(d.target_name || d.target);
    const cands = this.db
      .prepare(
        `SELECT s.* FROM steps s JOIN missions m ON m.id = s.mission_id
          WHERE m.status IN ('planned','active') AND s.delegation_id IS NULL AND s.status IN ('delegated','planned') AND s.target IS NOT NULL
          ORDER BY (s.status = 'delegated') DESC, s.updated_at DESC`
      )
      .all()
      .filter((s) => bare(s.target) === name);
    const delegated = cands.filter((s) => s.status === "delegated");
    if (delegated.length === 1) return delegated[0];
    return null;
  }

  /** Link a new delegation to its step (if any) and set the step from it. Returns the mission or null. */
  onDelegation(d, turnId) {
    let s = d.step_id ? this.db.prepare("SELECT * FROM steps WHERE id = ?").get(d.step_id) : null;
    let linked = false;
    if (!s) {
      s = this.findStepFor(d);
      if (!s) return null;
      this.ledger.update("delegations", d.id, { mission_id: s.mission_id, step_id: s.id });
      linked = true;
    }
    // An older delegation for a step that has since been re-sent moves nothing.
    if (s.delegation_id && s.delegation_id !== d.id && d.id < s.delegation_id) return null;
    const want = DELEGATION_TO_STEP[d.status];
    const fields = {};
    if (linked || s.delegation_id !== d.id) {
      fields.delegation_id = d.id;
      if (!s.target) fields.target = d.target_name;
    }
    // A step JOYA AI marked done or skipped is not walked back by the lifecycle.
    if (want && want !== s.status && s.status !== "skipped" && !(s.status === "done" && want !== "done")) fields.status = want;
    if (d.status === "ack" && d.reply_text && !s.result) fields.result = String(d.reply_text).slice(0, 2000);
    if (!Object.keys(fields).length) return null;
    return this.updateStep(s.mission_id, s.n, fields, turnId);
  }

  /** A pending approval for a tagged SendMessage: the step waits. */
  onApproval(a, input) {
    if (a.tool !== "SendMessage" || a.status !== "pending") return null;
    const s = this.findStepFor({ text: input && input.message, target: input && input.to, target_name: bare(input && input.to) });
    if (!s) return null;
    this.ledger.update("approvals", a.id, { mission_id: s.mission_id, step_id: s.id });
    return this.updateStep(s.mission_id, s.n, { status: "waiting_approval", approval_id: a.id });
  }

  /** Which step (in an active mission) a session is working on, for the map tint. */
  forSession(name) {
    const n = bare(name);
    if (!n) return null;
    const rows = this.db
      .prepare(
        `SELECT s.*, m.id AS mid FROM steps s JOIN missions m ON m.id = s.mission_id
          WHERE m.status IN ('planned','active') AND s.target IS NOT NULL ORDER BY (s.status IN ('delegated','working','waiting_approval')) DESC, s.updated_at DESC`
      )
      .all()
      .filter((s) => bare(s.target) === n);
    const s = rows[0];
    return s ? { id: s.mid, ref: ref(s.mid), step_n: s.n, step_status: s.status } : null;
  }
}

const FINAL_MISSION = new Set(["done", "failed", "cancelled"]);

module.exports = { Missions, STEP_STATUSES, MISSION_STATUSES, DELEGATION_TO_STEP, TAG_RE, parseId, ref };
