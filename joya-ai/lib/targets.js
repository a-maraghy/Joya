"use strict";
/**
 * Who a delegation went to (SendMessage "to"), resolved by stable ids -- pure,
 * for the supervisor and its tests.
 *
 * The page's dot stream, the sessions' "last delegation" and the delegation's
 * own status all depend on this. It used to pin a session by the first name
 * match, which went wrong for namesakes, renamed sessions, restarts (a new
 * pid) and targets that are not local processes at all (a Remote Control
 * session on another machine, a sub-agent id).
 *
 *   parseListAgents(text)            the ListAgents tool result -> {refs, subagents, self}
 *   refOf(to)                        "Name [ref]" -> "ref" (or null)
 *   findTarget(list, {sessionId, pid, name})
 *                                    -> {session, why}: session id, then pid, then a UNIQUE
 *                                       normalised name; namesakes -> no session ("ambiguous")
 *   kindFor({to, refs, subagents, session})
 *                                    -> "local" | "remote" | "subagent" | "unknown"
 *   openTarget(d, list)              the live session an open delegation is with (same order)
 *   mayFail(d)                       only a LOCAL target that stopped running fails; a remote,
 *                                    sub-agent or unknown one waits for its ack or idle notice
 */
const names = require("./names");

/** A session name as compared everywhere: no [ref], lower case, spaces / dashes / underscores folded. */
function norm(name) {
  return String(name == null ? "" : name)
    .replace(/\s*\[[0-9a-f]{4,12}\]\s*$/i, "")
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, " ");
}

function refOf(to) {
  const m = /\[([0-9a-f]{4,12})\]\s*$/i.exec(String(to || ""));
  return m ? m[1].toLowerCase() : null;
}

/**
 * The ListAgents tool's text (Claude Code 2.1.28x), e.g.
 *   This session is JOYA AI OS [2e985f] — the name other sessions use ...
 *   Subagents (2):
 *     a75d0be7bd2df9a7f  ·  general-purpose  ·  completed  ·  started 4h ago
 *   Peer sessions (3):
 *     Giza Odoo Automation [8668d1]  ·  interactive  ·  idle  ·  Claude Desktop session  ·  started 7h ago
 *     JOYA Agent OS [7931d9]  ·  Remote Control  ·  idle
 * A peer row that says "interactive" is a process on this machine (local); one
 * that only says "Remote Control" is reached through a bridge (remote).
 */
function parseListAgents(text) {
  const out = { refs: {}, subagents: [], self: null };
  const lines = String(text || "").split(/\r?\n/);
  let section = null;
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    const me = /^This session is (.+?) \[([0-9a-f]{4,12})\]/i.exec(line);
    if (me) { out.self = { name: me[1], ref: me[2].toLowerCase() }; continue; }
    if (/^Subagents\s*\(/i.test(line)) { section = "sub"; continue; }
    if (/^Peer sessions\s*\(/i.test(line)) { section = "peer"; continue; }
    const cells = line.split(/\s+·\s+/);
    if (section === "sub") {
      if (/^[0-9a-z]{8,40}$/i.test(cells[0])) out.subagents.push(cells[0]);
      continue;
    }
    if (section === "peer") {
      const m = /^(.+?) \[([0-9a-f]{4,12})\]$/i.exec(cells[0]);
      if (!m) continue;
      const rest = cells.slice(1).map((c) => c.toLowerCase());
      const kind = rest.includes("interactive") ? "local" : rest.some((c) => /remote control/.test(c)) ? "remote" : "unknown";
      const state = rest.find((c) => /^(idle|busy|working|waiting|offline|running)$/.test(c)) || null;
      out.refs[m[2].toLowerCase()] = { name: m[1], kind, state };
    }
  }
  return out;
}

function live(list) {
  return (list || []).filter((s) => s && !s.self);
}

function findTarget(list, { sessionId, pid, name } = {}) {
  const l = live(list);
  if (sessionId) {
    const a = l.filter((s) => s.session_id === sessionId);
    if (a.length === 1) return { session: a[0], why: "session" };
  }
  if (pid) {
    const b = l.filter((s) => s.pid === pid);
    if (b.length === 1) return { session: b[0], why: "pid" };
  }
  const n = norm(name);
  if (n && !names.isSelfName(name)) {
    const c = l.filter((s) => norm(s.name) === n);
    if (c.length === 1) return { session: c[0], why: "name" };
    if (c.length > 1) return { session: null, why: "ambiguous" };
  }
  return { session: null, why: "none" };
}

/** A sub-agent's id as SendMessage takes it ("a75d0be7bd2df9a7f"): no [ref], hex-ish, no spaces. */
function looksLikeSubagent(name) {
  return /^a[0-9a-f]{12,24}$/.test(String(name || ""));
}

function kindFor({ to, refs, subagents, session } = {}) {
  const ref = refOf(to);
  const bare = String(to || "").replace(/\s*\[[0-9a-f]{4,12}\]\s*$/i, "").trim();
  if ((subagents || []).includes(bare) || looksLikeSubagent(bare)) return "subagent";
  const r = ref && refs && refs[ref];
  if (r && r.kind === "remote") return "remote";
  if (session) return "local";
  if (r && r.kind === "local") return "local";
  return "unknown";
}

/** The live session an open delegation is with: session id, then pid, then a unique normalised name. */
function openTarget(d, list) {
  return findTarget(list, { sessionId: d.target_session, pid: d.target_pid, name: d.target_name }).session;
}

/**
 * May an open delegation be marked failed because its target is not running?
 * Only when it went to a LOCAL session we had pinned (by session id or pid).
 * Remote, sub-agent and unknown targets stay "sent" until an ack or idle notice.
 */
function mayFail(d) {
  if (!d) return false;
  if (d.target_kind === "local") return !!(d.target_session || d.target_pid);
  if (d.target_kind) return false;
  return !!(d.target_session || d.target_pid); // rows from before target_kind: pinned ones only
}

/*
 * Joya's own throwaway CLIs (today: the Usage sheet's get_usage probe, run
 * when JOYA AI is not up) register in root's session registry like any Claude
 * Code process; left alone they get a name derived from their cwd ("tmp-9c")
 * and flash up as a session for a few seconds. They are started with
 * CLAUDE_CODE_SESSION_NAME=joya-internal-<what>, and this is the one rule that
 * hides them: that exact prefix, nothing else -- a real session, whatever its
 * name or cwd, is never hidden.
 */
const INTERNAL_PREFIX = "joya-internal-";
function isInternal(s) {
  return !!s && typeof s.name === "string" && s.name.startsWith(INTERNAL_PREFIX);
}

module.exports = { norm, refOf, parseListAgents, findTarget, kindFor, openTarget, mayFail, looksLikeSubagent, INTERNAL_PREFIX, isInternal };
