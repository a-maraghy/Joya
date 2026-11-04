"use strict";
/**
 * The Machine core's live web: the dependency graph of what runs on the host,
 * and the feed of real events that pulse across it.
 *
 * The graph is the one verified from the unit files, nginx sites, ufw and
 * fail2ban (memory fact #774): no edge here is a guess, and each carries the
 * evidence it was derived from. The feed merges five sources, each read as
 * cheaply as its source allows and each optional:
 *
 *   - the helper's `pulse-feed`: SSH sign-ins and failures, unit starts (the
 *     journal), fail2ban bans and unbans, memory ingests (the hook log), nginx
 *     request counts, agent replies (each agent's own database);
 *   - this panel's login_log: sign-ins, failed sign-ins, panel actions;
 *   - the helper's audit log, which this process may read: audit actions;
 *   - JOYA AI's ledger over its socket: turns and delegations.
 *
 * Every event is a type, a time and at most a unit, jail, agent or action
 * name. No address, user name or text is kept. One poller serves every
 * viewer: it runs at most every MIN_INTERVAL_MS and only while someone asks.
 * A source that fails is left out quietly and logged once.
 */

const fs = require("fs");

const MIN_INTERVAL_MS = 3000;
const RING = 400;
const TOTALS_MS = 10 * 60 * 1000;
const LOOKBACK_MS = 15 * 60 * 1000;
const DAY_MS = 24 * 3600 * 1000;
const ACTION_RE = /^[a-z0-9][a-z0-9-]{0,40}$/;
const SLUG_RE = /^[a-z][a-z0-9-]{1,30}$/;

// from needs to. See public/mycelium-graph.js for what each kind means.
const EDGE_RULES = [
  ["nginx", "ufw", "guard", "ufw ALLOW 80, 8443, 8444"],
  ["ssh", "ufw", "guard", "ufw ALLOW 22"],
  ["fail2ban", "ufw", "soft", "fail2ban writes its bans as ufw REJECT rules"],
  ["ssh", "fail2ban", "guard", "fail2ban jail sshd"],
  ["joya-dashboard", "fail2ban", "guard", "fail2ban jail joya-dashboard (auth.log)"],
  ["joya-dashboard", "nginx", "reach", "nginx :8443 → 127.0.0.1:3000"],
  ["odoo", "nginx", "reach", "nginx :8444 → 127.0.0.1:8069"],
  ["odoo", "postgresql@16-main", "hard", "Requires=postgresql.service"],
  ["claude-memory", "postgresql@16-main", "hard", "Wants=/After=postgresql.service; its database is claude_memory"],
  ["joya-ai", "claude-memory", "soft", "memory MCP server + hooks in /root/.claude/settings.json"],
  ["joya-dashboard", "joya-ai", "soft", "Command Center talks to /run/joya-ai/joya-ai.sock"],
  ["joya-dashboard", "claude-memory", "soft", "Memory browser queries 127.0.0.1:8765 through joya-helper"],
  ["xrdp", "ssh", "reach", "xrdp listens on 127.0.0.1:3389 only: SSH tunnel"],
  ["xrdp", "xrdp-sesman", "hard", "Requires=xrdp-sesman.service"],
  ["xrdp-sesman", "xrdp", "hard", "BindsTo=xrdp.service"],
];

const ROLES = {
  ufw: "Host firewall. Open: 22 SSH, 80 ACME, 8443 panel, 8444 Odoo. fail2ban's bans land here as REJECT rules.",
  fail2ban: "Jails sshd and joya-dashboard. Bans land as ufw REJECT rules.",
  nginx: "TLS on :8443 (panel) and :8444 (Odoo), :80 for ACME.",
  ssh: "Remote shell on :22, and the only way to reach the remote desktop.",
  xrdp: "Listens on 127.0.0.1:3389 only: reached through an SSH tunnel.",
  "xrdp-sesman": "Session broker for xrdp.",
  "joya-dashboard": "This panel, on 127.0.0.1:3000 behind nginx :8443.",
  odoo: "Trial Odoo on 127.0.0.1:8069 behind nginx :8444.",
  "postgresql@16-main": "127.0.0.1:5432. Holds the Odoo database and claude_memory.",
  "claude-memory": "Embeddings and hybrid search on 127.0.0.1:8765 over the claude_memory database.",
  "joya-ai": "Supervisor of the CEO Claude Code session; socket /run/joya-ai/joya-ai.sock.",
};

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "Sat 2026-09-26 06:22:45 CEST" -> "Sat 26 Sep 06:22" (systemd's own zone). */
function shortSince(s) {
  const m = /^(\w{3}) (\d{4})-(\d\d)-(\d\d) (\d\d:\d\d)/.exec(String(s || ""));
  if (!m) return "";
  return `${m[1]} ${Number(m[4])} ${MONTHS[Number(m[3]) - 1] || ""} ${m[5]}`;
}

function mb(bytes) {
  if (bytes == null || !isFinite(bytes)) return null;
  if (bytes >= 1024 ** 3) return (bytes / 1024 ** 3).toFixed(1) + " GB";
  return Math.max(1, Math.round(bytes / 1024 ** 2)) + " MB";
}

/**
 * The nodes and edges the page draws, for what this viewer may see.
 * services: the helper's service-list rows (already filtered for the viewer);
 * agents, channels: helper rows (filtered too); detail: unit -> {name}.
 */
function buildGraph({ services, agents, channels, detail }) {
  const agentName = new Map((agents || []).map((a) => [a.slug, a.name || a.slug]));
  const nodes = (services || []).map((s) => {
    const d = (detail && detail.get && detail.get(s.unit)) || {};
    let name = d.name || s.unit;
    let role = ROLES[s.unit] || d.detail || "";
    if (s.kind === "agent") {
      const slug = s.unit.slice("joya-agent@".length);
      name = "Agent · " + slug;
      role = `Telegram agent "${agentName.get(slug) || slug}". Its own memory (vault + vectors, sqlite), not the memory service.`;
    } else if (s.kind === "whatsapp") {
      name = "WhatsApp · " + s.unit.slice("joya-whatsapp@".length);
      role = "WhatsApp bridge for a channel.";
    }
    const st = s.active === "active" ? "ok" : s.active === "failed" ? "failed" : "inactive";
    return {
      id: s.unit,
      unit: s.unit + ".service",
      name,
      kind: s.kind || "system",
      active: s.active,
      state: st,
      since: shortSince(s.since),
      mem: mb(s.memory),
      role,
    };
  });
  const ids = new Set(nodes.map((n) => n.id));
  const edges = EDGE_RULES.filter(([a, b]) => ids.has(a) && ids.has(b)).map(([from, to, kind, why]) => ({ from, to, kind, why }));
  for (const c of channels || []) {
    if (!c || c.type !== "telegram" || !SLUG_RE.test(String(c.slug)) || !c.agent) continue;
    const agent = "joya-agent@" + c.agent;
    if (!ids.has(agent)) continue;
    nodes.push({
      id: "ch:" + c.slug,
      unit: "channel " + c.slug,
      name: String(c.name || c.slug),
      kind: "channel",
      channel: true,
      state: "ok",
      active: null,
      since: "",
      mem: null,
      role: `Telegram channel. Runs inside ${agent}, not as its own unit.`,
    });
    edges.push({ from: "ch:" + c.slug, to: agent, kind: "hard", why: "the channel runs inside the agent process" });
  }
  return { nodes, edges };
}

/* ------------------------------------------------------------------- feed -- */

function readNew(file, state, fsImpl) {
  const st = fsImpl.statSync(file);
  let start;
  if (!state) start = st.size;
  else if (state.ino !== st.ino || state.off > st.size) start = 0;
  else start = state.off;
  if (st.size - start > 512 * 1024) start = st.size - 512 * 1024;
  if (start >= st.size) return { lines: [], state: { ino: st.ino, off: st.size } };
  const fd = fsImpl.openSync(file, "r");
  try {
    const buf = Buffer.alloc(st.size - start);
    fsImpl.readSync(fd, buf, 0, buf.length, start);
    const end = buf.lastIndexOf(10);
    if (end < 0) return { lines: [], state: { ino: st.ino, off: start } };
    return { lines: buf.slice(0, end).toString("utf8").split("\n"), state: { ino: st.ino, off: start + end + 1 } };
  } finally {
    fsImpl.closeSync(fd);
  }
}

function loginEvent(row) {
  const at = row.ts;
  if (row.outcome === "success") return { type: "panel-login", at };
  if (row.outcome === "fail" || row.outcome === "failed") return { type: "panel-fail", at };
  if (row.outcome === "joya-ai") return null; // JOYA AI's ledger reports these as turns
  if (ACTION_RE.test(String(row.outcome || ""))) return { type: "panel-action", action: row.outcome, at };
  return null;
}

function createFeed(deps) {
  const now = deps.now || (() => Date.now());
  const fsImpl = deps.fs || fs;
  const log = deps.log || ((m) => console.warn(m));
  const warned = new Set();
  let seq = 0;
  let ring = [];
  let lastPoll = 0;
  let inflight = null;
  let helperCursor = null;
  let loginId = null;
  let auditState = null;
  let turnId = null;
  let delegId = null;
  let totals = null;
  let totalsAt = 0;
  let totalsInflight = null;

  function quietly(source, err) {
    if (warned.has(source)) return;
    warned.add(source);
    log(`machine core: event source "${source}" is unavailable, leaving it out (${err && err.message ? err.message : err})`);
  }

  function push(ev) {
    ev.seq = ++seq;
    ring.push(ev);
    if (ring.length > RING) ring = ring.slice(-RING);
  }

  async function fromHelper() {
    const out = await deps.priv.pulseFeed(helperCursor);
    helperCursor = out.cursor;
    for (const u of out.unavailable || []) quietly(u, "not readable");
    const evs = [];
    for (const e of out.events || []) {
      const ev = { type: e.type, at: e.at };
      if (e.unit) ev.unit = e.unit;
      if (e.jail) ev.jail = e.jail;
      if (e.agent) ev.agent = e.agent;
      evs.push(ev);
    }
    const c = out.counts || {};
    for (const k of ["web_panel", "web_odoo", "web_other"]) if (c[k] > 0) evs.push({ type: k, n: c[k], at: out.now });
    return evs;
  }

  function fromLogins() {
    const t = now();
    if (loginId == null) {
      const rows = deps.db.loginsAfter(0, 5000, new Date(t - LOOKBACK_MS).toISOString());
      loginId = deps.db.lastLoginId();
      return rows.map(loginEvent).filter(Boolean);
    }
    const rows = deps.db.loginsAfter(loginId, 200);
    if (rows.length) loginId = rows[rows.length - 1].id;
    return rows.map(loginEvent).filter(Boolean);
  }

  function fromAudit() {
    if (!deps.auditLog) return [];
    const first = auditState == null;
    const r = first ? { lines: [], state: readNew(deps.auditLog, null, fsImpl).state } : readNew(deps.auditLog, auditState, fsImpl);
    auditState = r.state;
    const out = [];
    for (const line of r.lines) {
      try {
        const j = JSON.parse(line);
        if (ACTION_RE.test(String(j.action)) && typeof j.ts === "string") out.push({ type: "audit", action: j.action, at: j.ts });
      } catch (_) {
        /* not a record */
      }
    }
    return out;
  }

  async function fromJoyaAi() {
    if (!deps.joyaai) return [];
    const t = now();
    const [turns, delegs] = await Promise.all([
      deps.joyaai.call("ledger", { table: "turns", limit: 20 }, "machine-core", { timeout: 3000 }),
      deps.joyaai.call("ledger", { table: "delegations", limit: 20 }, "machine-core", { timeout: 3000 }),
    ]);
    const out = [];
    const tr = (turns.rows || []).slice().sort((a, b) => a.id - b.id);
    const dr = (delegs.rows || []).slice().sort((a, b) => a.id - b.id);
    const fresh = (r, last) => (last == null ? Date.parse(r.created_at) >= t - LOOKBACK_MS : r.id > last);
    for (const r of tr) if (fresh(r, turnId)) out.push({ type: "turn", source: r.source === "dashboard" ? "dashboard" : "other", at: r.created_at });
    for (const r of dr) if (fresh(r, delegId)) out.push({ type: "delegation", at: r.created_at });
    turnId = Math.max(turnId || 0, ...tr.map((r) => r.id));
    delegId = Math.max(delegId || 0, ...dr.map((r) => r.id));
    return out;
  }

  /** Ask every source for what is new. Shared by concurrent callers. */
  function poll() {
    if (inflight) return inflight;
    if (now() - lastPoll < MIN_INTERVAL_MS) return Promise.resolve();
    lastPoll = now();
    const sources = { helper: fromHelper, logins: async () => fromLogins(), audit: async () => fromAudit(), "joya-ai": fromJoyaAi };
    inflight = Promise.allSettled(Object.values(sources).map((f) => f()))
      .then((results) => {
        const names = Object.keys(sources);
        const all = [];
        results.forEach((r, i) => {
          if (r.status === "fulfilled") all.push(...r.value);
          else quietly(names[i], r.reason);
        });
        all.sort((a, b) => String(a.at).localeCompare(String(b.at)));
        all.forEach(push);
      })
      .finally(() => {
        inflight = null;
      });
    return inflight;
  }

  /** Events after `since`, for a viewer. `allow(ev)` decides visibility. */
  function since(n, allow) {
    const s = Number(n) || 0;
    return ring.filter((e) => e.seq > s && (!allow || allow(e))).slice(-120);
  }

  async function computeTotals() {
    const t = now();
    const from = new Date(t - DAY_MS).toISOString();
    const out = {};
    try {
      const h = await deps.priv.pulseTotals();
      Object.assign(out, h.totals || {});
      delete out.reply;
      out.starts = h.starts || {};
      for (const u of h.unavailable || []) quietly(u, "not readable");
    } catch (e) {
      quietly("helper totals", e);
    }
    try {
      for (const row of deps.db.loginsAfter(0, 100000, from)) {
        const ev = loginEvent(row);
        if (ev) out[ev.type] = (out[ev.type] || 0) + 1;
      }
    } catch (e) {
      quietly("logins", e);
    }
    if (deps.auditLog) {
      try {
        let n = 0;
        for (const line of fsImpl.readFileSync(deps.auditLog, "utf8").split("\n").slice(-20000)) {
          if (!line) continue;
          try {
            const j = JSON.parse(line);
            if (ACTION_RE.test(String(j.action)) && typeof j.ts === "string" && Date.parse(j.ts) >= t - DAY_MS) n++;
          } catch (_) {
            /* not a record */
          }
        }
        out.audit = n;
      } catch (e) {
        quietly("audit", e);
      }
    }
    if (deps.joyaai) {
      try {
        const [turns, delegs] = await Promise.all([
          deps.joyaai.call("ledger", { table: "turns", limit: 500 }, "machine-core", { timeout: 5000 }),
          deps.joyaai.call("ledger", { table: "delegations", limit: 500 }, "machine-core", { timeout: 5000 }),
        ]);
        const recent = (rows) => (rows || []).filter((r) => String(r.created_at) >= from);
        const tr = recent(turns.rows);
        out.turn_dashboard = tr.filter((r) => r.source === "dashboard").length;
        out.turn = tr.length - out.turn_dashboard;
        out.delegation = recent(delegs.rows).length;
      } catch (e) {
        quietly("joya-ai", e);
      }
    }
    totals = out;
    totalsAt = now();
    return totals;
  }

  /** The 24 h counts, at most TOTALS_MS old; null until the first are in. */
  function getTotals({ wait = false } = {}) {
    if ((!totals || now() - totalsAt > TOTALS_MS) && !totalsInflight) {
      totalsInflight = computeTotals().finally(() => {
        totalsInflight = null;
      });
    }
    if (wait && totalsInflight) return totalsInflight;
    return Promise.resolve(totals);
  }

  return { poll, since, getTotals, get seq() { return seq; } };
}

module.exports = { EDGE_RULES, ROLES, buildGraph, createFeed, shortSince, loginEvent, readNew, MIN_INTERVAL_MS };
