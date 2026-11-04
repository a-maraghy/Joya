"use strict";
/**
 * What the Claude sessions on this box cost.
 *
 * JOYA AI's own cost comes from its ledger. The CLI's `total_cost_usd` on each
 * result is the running total of the PROCESS, not the cost of that turn: summing
 * it overstates badly (fact: 9.12 at 08:52 on 28 Sep after 6.08 the evening
 * before). A turn's cost is the difference from the previous turn.
 *
 * A new process (another process start stamp) usually RESUMES the same
 * session, and the CLI then carries the session's running total on: the first
 * turn after a supervisor restart reported $51.75 of which $0.23 was its own
 * (fact, 2026-09-30). So a new process whose total is at or above the
 * previous one is a resumed session and gets the difference too. A process
 * that started a NEW session (its stamp ends "#new": the supervisor's fresh
 * start, or a first start) starts again from zero, and so does a running
 * total that went down (rows written before either stamp existed).
 *
 * Every other session is estimated from its transcript: the token usage the
 * API reported on each assistant message, priced at API list prices. Those
 * figures are "estimated API-equivalent" -- a subscription does not bill them.
 * Streamed messages repeat one usage record per content block, so usage is
 * counted once per message id.
 */

const fs = require("fs");
const path = require("path");

/* ----------------------------------------------------- JOYA AI's own turns --- */

/**
 * Per-turn cost from running totals.
 * rows: turns ordered by id, each { id, cost_usd, proc_start? }.
 * Returns Map(id -> delta USD) for rows with a cost.
 */
function turnDeltas(rows) {
  const out = new Map();
  // Each chain has its own running total: JOYA AI's main session, and each voice lane's process (2026-10-30,
  // proc_start "lane:<session id>#new", lib/voicelane.js) -- their turns interleave by id.
  const chains = new Map(); // chain -> { prevTotal, prevProc }
  for (const r of rows) {
    if (r.cost_usd == null || !isFinite(r.cost_usd)) continue;
    const total = Number(r.cost_usd);
    const proc = r.proc_start || null;
    const key = chainOf(proc);
    const c = chains.get(key) || { prevTotal: null, prevProc: undefined };
    let delta;
    if (c.prevTotal === null) delta = total;
    else if (proc && proc !== c.prevProc && /#new$/.test(proc)) delta = total; // a new session starts from zero
    else if (total < c.prevTotal - 1e-9) delta = total; // the total went down: a fresh session starts from zero
    else delta = total - c.prevTotal; // the same process, or a new one that resumed the session (its total carried on)
    out.set(r.id, Math.max(0, delta));
    c.prevTotal = total;
    c.prevProc = proc || c.prevProc;
    chains.set(key, c);
  }
  return out;
}
/** Which running total a turn belongs to: a voice lane's own process ("lane:..."), else JOYA AI's main session. */
function chainOf(procStart) {
  return typeof procStart === "string" && procStart.startsWith("lane:") ? procStart : "main";
}

/**
 * Every turn's cost_delta_usd, recomputed from cost_usd (kept as the CLI
 * reported it) with turnDeltas(). Run at each supervisor start; it is also the
 * migration that corrects the rows written before 2026-09-30, when the first
 * turn after a supervisor restart recorded the session's whole running total
 * as its own cost. It only ever rewrites cost_delta_usd, and only where it
 * differs, so a second run changes nothing. db: node:sqlite DatabaseSync.
 * Returns { changed, before, after } (the changed rows' sums, USD).
 */
function recomputeTurnDeltas(db) {
  const rows = db.prepare("SELECT id, cost_usd, proc_start, cost_delta_usd FROM turns WHERE cost_usd IS NOT NULL ORDER BY id").all();
  const d = turnDeltas(rows);
  const was = new Map(rows.map((r) => [r.id, r.cost_delta_usd]));
  const up = db.prepare("UPDATE turns SET cost_delta_usd = ? WHERE id = ?");
  let changed = 0;
  let before = 0;
  let after = 0;
  db.exec("BEGIN");
  try {
    for (const [id, v] of d) {
      const old = was.get(id);
      if (old != null && Math.abs(old - v) < 1e-9) continue;
      up.run(v, id);
      changed++;
      before += Number(old) || 0;
      after += v;
    }
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
  return { changed, before, after };
}

/* --------------------------------------------------------------- prices --- */

// USD per million tokens: [input, output, cache read]. Cache writes are 1.25x
// input for the 5-minute cache and 2x for the 1-hour cache. API list prices.
const PRICES = [
  [/^claude-fable-5/, [10, 50, 0.25]],
  [/^claude-mythos/, [10, 50, 1.0]],
  [/^claude-opus-5-5/, [4, 20, 0.2]],
  [/^claude-opus-5/, [5, 25, 0.5]],
  [/^claude-opus-4-[5-9]/, [5, 25, 0.5]],
  [/^claude-opus-4/, [15, 75, 1.5]],
  [/^claude-sonnet-5/, [2, 10, 0.2]],
  [/^claude-sonnet/, [3, 15, 0.3]],
  [/^claude-haiku-5/, [0.1, 0.5, 0.01]],
  [/^claude-haiku-4/, [1, 5, 0.1]],
  [/^claude-haiku/, [0.8, 4, 0.08]],
];
const DEFAULT_PRICE = [5, 25, 0.5];

function priceOf(model) {
  for (const [re, p] of PRICES) if (re.test(String(model || ""))) return p;
  return DEFAULT_PRICE;
}

/** USD for one message's usage record. */
function usageCost(model, u) {
  const [pin, pout, pread] = priceOf(model);
  const cc = u.cache_creation || {};
  const w1h = Number(cc.ephemeral_1h_input_tokens) || 0;
  const w5m = cc.ephemeral_5m_input_tokens != null ? Number(cc.ephemeral_5m_input_tokens) || 0 : Math.max(0, (Number(u.cache_creation_input_tokens) || 0) - w1h);
  const input = Number(u.input_tokens) || 0;
  const output = Number(u.output_tokens) || 0;
  const read = Number(u.cache_read_input_tokens) || 0;
  return (input * pin + output * pout + read * pread + w5m * pin * 1.25 + w1h * pin * 2) / 1e6;
}

/* ------------------------------------------------------ transcript scanner --- */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Parse transcript lines into per-(day, model) usage.
 * lines: complete JSONL lines. seen: Set of message ids already counted.
 * dayOf(ms) -> "YYYY-MM-DD". minMs: ignore older records.
 */
function parseUsage(lines, seen, dayOf, minMs) {
  const agg = new Map();
  let last = null;
  for (const line of lines) {
    if (!line || line.indexOf('"usage"') === -1 || line.indexOf('"assistant"') === -1) continue;
    let rec;
    try {
      rec = JSON.parse(line);
    } catch (_) {
      continue;
    }
    if (rec.type !== "assistant" || !rec.message || !rec.message.usage) continue;
    const id = rec.message.id || rec.requestId || rec.uuid;
    if (!id || seen.has(id)) continue;
    seen.add(id);
    last = id;
    const ms = Date.parse(rec.timestamp);
    if (!isFinite(ms) || ms < minMs) continue;
    const model = String(rec.message.model || "unknown").replace(/-\d{8}$/, "");
    if (model === "<synthetic>") continue;
    const u = rec.message.usage;
    const key = dayOf(ms) + "|" + model;
    const a = agg.get(key) || { day: dayOf(ms), model, input: 0, output: 0, cache_write: 0, cache_read: 0, usd: 0 };
    a.input += Number(u.input_tokens) || 0;
    a.output += Number(u.output_tokens) || 0;
    a.cache_write += Number(u.cache_creation_input_tokens) || 0;
    a.cache_read += Number(u.cache_read_input_tokens) || 0;
    a.usd += usageCost(model, u);
    agg.set(key, a);
  }
  return { agg: [...agg.values()], last };
}

/**
 * Incremental scanner over ~/.claude/projects. Keeps a byte offset per file in
 * the ledger (cost_files) and adds usage into cost_daily, so a restart carries
 * on where it stopped instead of counting everything twice. Yields to the
 * event loop between chunks: the first scan reads a couple of hundred MB.
 */
class Scanner {
  constructor({ ledger, projectsDir, dayOf, days = 15, chunk = 4 * 1024 * 1024, exclude = () => false }) {
    this.ledger = ledger;
    this.dir = projectsDir;
    this.dayOf = dayOf;
    this.days = days;
    this.chunk = chunk;
    this.exclude = exclude;
    this.busy = false;
    this.lastScan = null;
    this.seen = new Map(); // file -> Set of recent message ids (bounded)
  }

  files() {
    const out = [];
    const minMs = Date.now() - this.days * 86400000;
    let slugs = [];
    try {
      slugs = fs.readdirSync(this.dir);
    } catch (_) {
      return out;
    }
    for (const slug of slugs) {
      const pdir = path.join(this.dir, slug);
      let names;
      try {
        if (!fs.lstatSync(pdir).isDirectory()) continue;
        names = fs.readdirSync(pdir);
      } catch (_) {
        continue;
      }
      for (const n of names) {
        const full = path.join(pdir, n);
        if (n.endsWith(".jsonl") && UUID_RE.test(n.slice(0, -6))) {
          out.push({ file: full, session: n.slice(0, -6), minMs });
        } else if (UUID_RE.test(n)) {
          const sub = path.join(full, "subagents");
          try {
            for (const a of fs.readdirSync(sub)) if (/^agent-[A-Za-z0-9_-]+\.jsonl$/.test(a)) out.push({ file: path.join(sub, a), session: n, minMs });
          } catch (_) {
            /* no sub-agents */
          }
        }
      }
    }
    return out.filter((f) => {
      try {
        return fs.statSync(f.file).mtimeMs >= f.minMs;
      } catch (_) {
        return false;
      }
    });
  }

  async scan() {
    if (this.busy) return false;
    this.busy = true;
    try {
      for (const f of this.files()) {
        if (this.exclude(f.session)) continue;
        await this.scanFile(f);
        await new Promise((r) => setImmediate(r));
      }
      this.lastScan = new Date().toISOString();
      return true;
    } finally {
      this.busy = false;
    }
  }

  async scanFile({ file, session, minMs }) {
    const db = this.ledger.db;
    let st;
    try {
      st = fs.statSync(file);
    } catch (_) {
      return;
    }
    const row = db.prepare("SELECT * FROM cost_files WHERE path = ?").get(file);
    let off = row && row.ino === st.ino && row.off <= st.size ? row.off : 0;
    if (off >= st.size) return;
    let seen = this.seen.get(file);
    if (!seen) {
      seen = new Set(row && row.last_msg ? [row.last_msg] : []);
      this.seen.set(file, seen);
    }
    const fd = fs.openSync(file, "r");
    try {
      while (off < st.size) {
        const len = Math.min(this.chunk, st.size - off);
        const buf = Buffer.alloc(len);
        fs.readSync(fd, buf, 0, len, off);
        let end = buf.lastIndexOf(10);
        if (end < 0) {
          if (len < this.chunk) break; // a line still being written
          end = len - 1; // one enormous line: skip it
        }
        const lines = buf.slice(0, end).toString("utf8").split("\n");
        const { agg, last } = parseUsage(lines, seen, this.dayOf, minMs);
        off += end + 1;
        db.exec("BEGIN");
        try {
          const up = db.prepare(
            `INSERT INTO cost_daily (session_id, day, model, input, output, cache_write, cache_read, usd) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(session_id, day, model) DO UPDATE SET input = input + excluded.input, output = output + excluded.output,
               cache_write = cache_write + excluded.cache_write, cache_read = cache_read + excluded.cache_read, usd = usd + excluded.usd`
          );
          for (const a of agg) up.run(session, a.day, a.model, a.input, a.output, a.cache_write, a.cache_read, a.usd);
          db.prepare(
            `INSERT INTO cost_files (path, ino, off, last_msg, updated_at) VALUES (?, ?, ?, ?, ?)
             ON CONFLICT(path) DO UPDATE SET ino = excluded.ino, off = excluded.off, last_msg = COALESCE(excluded.last_msg, last_msg), updated_at = excluded.updated_at`
          ).run(file, st.ino, off, last, new Date().toISOString());
          db.exec("COMMIT");
        } catch (e) {
          db.exec("ROLLBACK");
          throw e;
        }
        if (seen.size > 5000) {
          const keep = [...seen].slice(-1000);
          seen.clear();
          keep.forEach((k) => seen.add(k));
        }
        await new Promise((r) => setImmediate(r));
      }
    } finally {
      fs.closeSync(fd);
    }
  }
}

/* ------------------------------------------------------- token counts --- */

const TOKEN_KEYS = ["input", "output", "cache_read", "cache_write"];

function zeroTokens() {
  return { input: 0, output: 0, cache_read: 0, cache_write: 0, total: 0 };
}
function addTokens(a, r) {
  for (const k of TOKEN_KEYS) a[k] += Number(r[k]) || 0;
  a.total = a.input + a.output + a.cache_read + a.cache_write;
  return a;
}

/**
 * Token consumption from the transcripts, per day and per session.
 * rows: cost_daily rows { session_id, day, input, output, cache_read, cache_write }.
 * days: the day keys to report, oldest first (the last is today).
 * selfIds: JOYA AI's own session ids, all reported as one row `selfName`.
 * nameOf(sid): a session's display name; sessions sharing a name are one row.
 * top: rows kept per period; the rest are folded into one "Other sessions" row.
 * These are this box's own counts from the transcripts, not plan figures.
 */
function tokenReport(rows, { days, selfIds = new Set(), selfName = "JOYA AI", nameOf = (s) => "session " + String(s).slice(0, 8), top = 12 }) {
  const today = days[days.length - 1];
  const week = days.slice(-7);
  const inWeek = new Set(week);
  const perDay = new Map(days.map((d) => [d, zeroTokens()]));
  const periods = { today: new Map(), week: new Map() };
  const names = new Map();
  const nm = (sid) => {
    if (!names.has(sid)) names.set(sid, selfIds.has(sid) ? selfName : String(nameOf(sid) || "session " + String(sid).slice(0, 8)));
    return names.get(sid);
  };
  const bump = (map, sid, r) => {
    const name = nm(sid);
    let e = map.get(name);
    if (!e) map.set(name, (e = { name, self: selfIds.has(sid), sessions: new Set(), ...zeroTokens() }));
    e.sessions.add(sid);
    addTokens(e, r);
  };
  for (const r of rows) {
    if (perDay.has(r.day)) addTokens(perDay.get(r.day), r);
    if (inWeek.has(r.day)) bump(periods.week, r.session_id, r);
    if (r.day === today) bump(periods.today, r.session_id, r);
  }
  const period = (map) => {
    const list = [...map.values()].filter((e) => e.total > 0).sort((a, b) => b.self - a.self || b.total - a.total || a.name.localeCompare(b.name));
    const totals = list.reduce((a, e) => addTokens(a, e), zeroTokens());
    const kept = list.slice(0, top).map((e) => ({ name: e.name, self: e.self, session_count: e.sessions.size, ...pick(e) }));
    const rest = list.slice(top);
    if (rest.length) {
      const o = rest.reduce((a, e) => addTokens(a, e), zeroTokens());
      kept.push({ name: "Other sessions (" + rest.length + ")", self: false, other: true, session_count: rest.reduce((n, e) => n + e.sessions.size, 0), ...o });
    }
    return { totals, sessions: kept };
  };
  return {
    today,
    days: days.map((d) => ({ day: d, ...perDay.get(d) })),
    periods: { today: period(periods.today), week: { from: week[0], to: today, ...period(periods.week) } },
  };
}
function pick(e) {
  return { input: e.input, output: e.output, cache_read: e.cache_read, cache_write: e.cache_write, total: e.total };
}

/**
 * A turn's own tokens from the CLI's result `usage`, which -- like
 * total_cost_usd -- is the running total of the PROCESS (Claude Code sums its
 * per-model usage for the session). The turn's share is the difference from the
 * previous turn of the same process; a new process (another proc_start, or any
 * count going down) starts from zero.
 * usage: the result's usage object; prev: { cum, proc_start } of the previous turn or null.
 * Returns { cum, delta } with keys input / output / cache_read / cache_write.
 */
function usageTokens(u) {
  u = u || {};
  return { input: Number(u.input_tokens) || 0, output: Number(u.output_tokens) || 0, cache_read: Number(u.cache_read_input_tokens) || 0, cache_write: Number(u.cache_creation_input_tokens) || 0 };
}
function turnTokenDelta(usage, procStart, prev) {
  const cum = usageTokens(usage);
  const p = prev && prev.cum;
  const sameProc = p && prev.proc_start && procStart && prev.proc_start === procStart && TOKEN_KEYS.every((k) => cum[k] >= (Number(p[k]) || 0));
  const delta = {};
  for (const k of TOKEN_KEYS) delta[k] = sameProc ? cum[k] - (Number(p[k]) || 0) : cum[k];
  return { cum, delta };
}

module.exports = { turnDeltas, chainOf, recomputeTurnDeltas, priceOf, usageCost, parseUsage, Scanner, PRICES, tokenReport, turnTokenDelta, TOKEN_KEYS };
