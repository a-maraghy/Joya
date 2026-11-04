#!/usr/bin/env node
"use strict";
/**
 * PostToolUse (SendMessage|ListAgents) and UserPromptSubmit hook: feeds the
 * delegation ledger.
 *
 * Posts the event to the supervisor's root-only hook socket and exits. The
 * supervisor is the ledger's only writer; this never opens the database. If
 * the socket is not there (the supervisor restarting) the event is spooled
 * and read back when it starts. Never blocks or alters the tool call: no
 * output, exit 0, a two second ceiling.
 */
const fs = require("fs");
const net = require("net");

const SOCKET = process.env.JOYA_AI_HOOK_SOCKET || "/run/joya-ai/hook.sock";
const SPOOL = "/var/lib/joya-ai/hook-spool.jsonl";

let raw = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => (raw += c));
process.stdin.on("end", () => {
  let ev;
  try {
    ev = JSON.parse(raw || "{}");
  } catch (_) {
    return process.exit(0);
  }
  const msg = {
    event: ev.hook_event_name,
    session_id: ev.session_id,
    tool_name: ev.tool_name,
    tool_input: ev.tool_input,
    tool_response: ev.tool_response,
    tool_use_id: ev.tool_use_id,
    prompt: ev.prompt,
    at: new Date().toISOString(),
  };
  // Only prompts that carry peer traffic are worth the ledger's time.
  if (msg.event === "UserPromptSubmit" && !/cross-session-message|\[Cross-session (idle|delivery) notice\]/.test(String(msg.prompt || ""))) {
    return process.exit(0);
  }
  const line = JSON.stringify(msg) + "\n";
  const spool = () => {
    if (process.env.JOYA_AI_SUPERVISED) {
      try {
        fs.appendFileSync(SPOOL, line, { mode: 0o600 });
      } catch (_) {
        /* nowhere to put it */
      }
    }
    process.exit(0);
  };
  const timer = setTimeout(spool, 2000);
  const sock = net.createConnection(SOCKET, () => {
    sock.end(line, () => {
      clearTimeout(timer);
      process.exit(0);
    });
  });
  sock.on("error", () => {
    clearTimeout(timer);
    spool();
  });
});
