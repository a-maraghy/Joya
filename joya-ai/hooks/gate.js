#!/usr/bin/env node
"use strict";
/**
 * PreToolUse hook: JOYA AI's destructive-action gate.
 *
 * Reads the tool call on stdin and decides it with lib/rules.js: the built-in
 * safety rules, the administrator's approval rules from the ledger (read-only)
 * and lib/classifier.js. Deny wins; built-in asks cannot be overridden; then
 * the most specific of the administrator's rules; then the classifier asks
 * about anything destructive.
 *
 *   ask   Claude Code sends the supervisor a can_use_tool request (JOYA AI runs
 *         with --permission-prompt-tool stdio): an Approve / Deny card, and
 *         nobody answering means deny.
 *   allow an "Always allow this" rule matched: no card.
 *   deny  the model is told why.
 *
 * Fails closed: if the classifier throws, the call is asked about; if the
 * rules store exists but cannot be read, no allow rule applies and anything
 * the gate would have let through is asked about instead.
 * Prints nothing for a harmless call, so the normal permission flow applies.
 * A rule that matched is reported to the supervisor (its use count).
 *
 * Token caps (build spec §6): in a hired session (JOYA_GATE_SESSION=hired.<slug>)
 * every tool call is denied while the supervisor records that session paused at
 * its daily cap today (ledger settings token_caps_state; read-only). With
 * --cap-only (bin/joya-session's catch-all hook) that is all it checks.
 */
const fs = require("fs");
const net = require("net");
const path = require("path");
const rules = require(path.join(__dirname, "..", "lib", "rules.js"));

function out(decision, reason) {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: decision,
        permissionDecisionReason: reason,
      },
    })
  );
}

function readRules(cfg) {
  const file = path.join(cfg.state_dir || "/var/lib/joya-ai", "ledger.db");
  if (!fs.existsSync(file)) return { rows: [], error: null };
  try {
    const { DatabaseSync } = require("node:sqlite");
    const db = new DatabaseSync(file, { readOnly: true, timeout: 2000 });
    try {
      return { rows: db.prepare("SELECT * FROM rules").all(), error: null };
    } finally {
      db.close();
    }
  } catch (e) {
    if (/no such table/.test(e.message)) return { rows: [], error: null };
    return { rows: [], error: e };
  }
}

/** Paused at its daily token cap today (Cairo day), per the supervisor's record? Unreadable: not paused (the runner pauses too). */
function capPaused(cfg, session) {
  if (!/^hired\./.test(session)) return false;
  const file = path.join(cfg.state_dir || "/var/lib/joya-ai", "ledger.db");
  if (!fs.existsSync(file)) return false;
  try {
    const { DatabaseSync } = require("node:sqlite");
    const db = new DatabaseSync(file, { readOnly: true, timeout: 2000 });
    let st;
    try {
      const r = db.prepare("SELECT value FROM settings WHERE key = 'token_caps_state'").get();
      st = r ? JSON.parse(r.value) : null;
    } finally {
      db.close();
    }
    const schedule = require(path.join(__dirname, "..", "lib", "schedule.js"));
    const rec = st && st.sessions && st.sessions[session.slice("hired.".length)];
    return !!(st && st.day === schedule.dayOf(Date.now(), cfg.tz || "Africa/Cairo") && rec && rec.paused_at && !rec.resumed_at);
  } catch (_) {
    return false;
  }
}

function report(sessionId, r) {
  return new Promise((resolve) => {
    const sock = process.env.JOYA_AI_HOOK_SOCKET;
    // the classifier's asks count against its built-in row ("asked 12x")
    const builtin = r.builtin || (r.source === "classifier" && r.decision === "ask" ? "classifier" : null);
    if (!sock || !(r.rule || builtin)) return resolve();
    const msg = { event: "RuleHit", session_id: sessionId, rule_id: r.rule ? r.rule.id : null, builtin, at: new Date().toISOString() };
    const timer = setTimeout(resolve, 1000);
    const s = net.createConnection(sock, () => s.end(JSON.stringify(msg) + "\n"));
    s.on("close", () => {
      clearTimeout(timer);
      resolve();
    });
    s.on("error", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

let raw = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => (raw += c));
process.stdin.on("end", async () => {
  try {
    const ev = JSON.parse(raw || "{}");
    let cfg = {};
    try {
      cfg = JSON.parse(fs.readFileSync(process.env.JOYA_AI_CONFIG || "/etc/joya-ai/config.json", "utf8"));
    } catch (_) {
      /* defaults */
    }
    // A hired session's gate (M-6, bin/joya-session) says whose it is: never JOYA AI's always-allow rules.
    const session = /^hired\.[a-z0-9-]{1,40}$/.test(process.env.JOYA_GATE_SESSION || "") ? process.env.JOYA_GATE_SESSION : "joya-ai";
    if (capPaused(cfg, session)) {
      out("deny", "JOYA AI gate: daily token cap reached. This session is paused until the administrator resumes it or the day turns. Stop here and do not retry.");
      return process.exit(0);
    }
    if (process.argv.includes("--cap-only")) return process.exit(0);
    const stored = readRules(cfg);
    const r = rules.evaluate(ev.tool_name, ev.tool_input, stored.rows, cfg, { session });
    let decision = r.decision;
    let reason;
    if (stored.error && decision !== "deny" && decision !== "ask") {
      decision = "ask";
      reason = `JOYA AI gate: the approval rules could not be read (${String(stored.error.message).slice(0, 100)}); asking to be safe.`;
    } else if (decision === "deny") reason = `JOYA AI gate: ${r.explain} Do not retry it or route it through another session.`;
    else if (decision === "ask")
      reason = r.source === "classifier" && r.classifier ? `JOYA AI gate · ${r.classifier.label}: ${r.classifier.reason}. Waiting for the administrator's approval.` : `JOYA AI gate: ${r.explain} Waiting for the administrator's approval.`;
    else if (decision === "allow") reason = `JOYA AI gate: ${r.explain}`;
    if (session === "joya-ai") await report(ev.session_id, r);
    if (decision === "none") return process.exit(0);
    out(decision, reason);
    process.exit(0);
  } catch (e) {
    out("ask", "JOYA AI gate could not classify this call (" + String(e.message).slice(0, 120) + "); asking to be safe.");
    process.exit(0);
  }
});
