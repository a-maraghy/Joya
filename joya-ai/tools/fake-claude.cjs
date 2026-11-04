#!/usr/bin/env node
/**
 * A stand-in for the claude CLI, for tools/test-supervisor.cjs.
 *
 * Speaks just enough of the stream-json protocol to exercise the supervisor
 * without a model, a network or a bill: initialize, remote_control, interrupt,
 * user turns with command_lifecycle events and replays, a can_use_tool
 * permission request, and `agents --json` / `--version`.
 *
 * Magic words in a user message:
 *   DESTROY   asks permission for `rm /tmp/joya-fake-victim`, then reports
 *             whether it was allowed or denied (and with what message)
 *   LISTAGENTS posts a ListAgents PostToolUse whose result is HOME/fake-listagents.txt
 *   DELEGATE  "sends" a message to fake-target (DELEGATE "<name>": to that name; QUIET: no reply): posts the PostToolUse event to
 *             the hook socket the way hooks/ledger.js would, then a reply and
 *             an idle notice as UserPromptSubmit events
 *   SLOW <ms> takes that long (up to 30 s) before answering "slow done"; an interrupt ends it ("cancelled")
 *   SAYESCALATE answers the single word ESCALATE (a voice call's quick lane handing the question on)
 *   PEERTURN <name>  after the answer, a turn of its own: <name>'s reply arriving as a peer message
 *   (each turn also logs "turn <-n name> <first 200 chars>" to HOME/fake-turns.log)
 *   RUN <cmd> asks permission to run <cmd> with Bash (rules may answer it)
 *   MISSION2  creates a two-step mission over the control socket (as the MCP
 *             server would) and delegates both steps, tagged, to fake-target
 *   a turn starting "[Watcher: … decision #N]" proposes a fix for decision N;
 *   "[Decision #N approved" asks to run the fix, then reports it done;
 *   "[Standing order: …" answers with a short briefing
 *   anything else is echoed back
 *
 * Each result carries total_cost_usd as the process's running total (+0.01 a
 * turn), the way the real CLI reports it.
 */
"use strict";
const fs = require("fs");
const net = require("net");
const path = require("path");
const crypto = require("crypto");
const readline = require("readline");

const args = process.argv.slice(2);
const home = process.env.HOME || "/tmp";

if (args[0] === "--version") {
  console.log((process.env.FAKE_VERSION || "2.1.283") + " (Claude Code)");
  process.exit(0);
}
if (args[0] === "agents") {
  const file = path.join(home, "fake-agents.json");
  let list = [{ pid: process.ppid, sessionId: "fake-target-session", name: "fake-target", cwd: "/tmp", kind: "interactive", status: "idle", startedAt: Date.now() }];
  try {
    list = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (_) {
    /* default */
  }
  console.log(JSON.stringify(list));
  process.exit(0);
}

const flag = (name) => {
  const i = args.indexOf(name);
  return i === -1 ? null : args[i + 1];
};
const sessionId = flag("--session-id") || flag("--resume") || crypto.randomUUID();
fs.appendFileSync(path.join(home, "fake-argv.log"), JSON.stringify(args) + "\n");
// A real CLI writes its transcript under projects/; the supervisor checks for
// it to decide between --session-id and --resume.
fs.mkdirSync(path.join(home, ".claude", "projects", "-fake"), { recursive: true });
fs.writeFileSync(path.join(home, ".claude", "projects", "-fake", sessionId + ".jsonl"), "{}\n");

// A hired session's fake (FAKE_AGENTS_REGISTER, passed on by bin/joya-session in the tests): it shows up in
// `agents --json` (HOME/fake-agents.json) under its -n name while it runs, like a real session in root's registry.
if (process.env.FAKE_AGENTS_REGISTER && flag("-n")) {
  const file = path.join(home, "fake-agents.json");
  const edit = (fn) => {
    let list = [];
    try {
      list = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch (_) {
      list = [];
    }
    list = fn(list);
    fs.writeFileSync(file + "." + process.pid, JSON.stringify(list));
    fs.renameSync(file + "." + process.pid, file);
  };
  edit((l) => l.filter((a) => a.sessionId !== sessionId).concat([{ pid: process.pid, sessionId, name: flag("-n"), cwd: process.cwd(), kind: "interactive", status: "idle", startedAt: Date.now() }]));
  const leave = () => {
    try {
      edit((l) => l.filter((a) => a.pid !== process.pid));
    } catch (_) {
      /* gone */
    }
  };
  process.on("exit", leave);
  process.stdin.on("end", () => setTimeout(() => process.exit(0), 50));
}

const out = (o) => process.stdout.write(JSON.stringify(o) + "\n");
const waiting = new Map(); // request_id -> resolve
let busy = Promise.resolve();

function hookPost(msg) {
  return new Promise((resolve) => {
    const s = net.createConnection(process.env.JOYA_AI_HOOK_SOCKET, () => s.end(JSON.stringify({ session_id: sessionId, ...msg }) + "\n"));
    s.on("close", resolve);
    s.on("error", resolve);
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let runningCost = 0;
let runningUsage = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };

/** One call to the supervisor's control socket, as JOYA AI's MCP server makes it. */
function ctl(op, params) {
  return new Promise((resolve) => {
    const s = net.createConnection(process.env.JOYA_AI_SOCKET);
    let buf = "";
    s.setEncoding("utf8");
    s.on("error", (e) => resolve({ ok: false, error: e.message }));
    s.on("connect", () => s.write(JSON.stringify({ id: "fake", op, actor: "joya-ai", ...params }) + "\n"));
    s.on("data", (c) => {
      buf += c;
      const nl = buf.indexOf("\n");
      if (nl !== -1) {
        s.destroy();
        resolve(JSON.parse(buf.slice(0, nl)));
      }
    });
  });
}

async function askTool(name, input) {
  const toolUseId = "toolu_" + crypto.randomBytes(6).toString("hex");
  out({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: toolUseId, name, input }] }, session_id: sessionId });
  const rid = crypto.randomUUID();
  const answer = new Promise((resolve) => waiting.set(rid, resolve));
  out({ type: "control_request", request_id: rid, request: { subtype: "can_use_tool", tool_name: name, input, decision_reason: "fake ask", decision_reason_type: "hook", tool_use_id: toolUseId } });
  const resp = await answer;
  const allowed = resp.behavior === "allow";
  out({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: toolUseId, content: allowed ? "ok" : resp.message, is_error: !allowed }] }, session_id: sessionId });
  return { allowed, resp };
}

async function delegate(message) {
  const toolUseId = "toolu_" + crypto.randomBytes(6).toString("hex");
  const input = { to: "fake-target [abc123]", message, notify_when_idle: true };
  out({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: toolUseId, name: "SendMessage", input }] }, session_id: sessionId });
  const msgId = crypto.randomUUID();
  await hookPost({ event: "PostToolUse", tool_name: "SendMessage", tool_input: input, tool_use_id: toolUseId, tool_response: { success: true, message: "queued", msg_id: msgId } });
  out({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: toolUseId, content: JSON.stringify({ success: true, msg_id: msgId }) }] }, session_id: sessionId });
  return msgId;
}

let interruptNow = null;
async function turn(msg) {
  const uuid = msg.uuid || crypto.randomUUID();
  const raw = typeof msg.message.content === "string" ? msg.message.content : "";
  fs.appendFileSync(path.join(home, "fake-turns.log"), JSON.stringify({ n: flag("-n"), text: raw.slice(0, 8000) }) + "\n");
  // A voice lane's preface quotes earlier requests: their magic words are not this turn's.
  const text = raw.replace(/^\[Earlier in this voice call:\][\s\S]*?\n\n/, "");
  out({ type: "command_lifecycle", command_uuid: uuid, state: "queued", session_id: sessionId });
  out({ type: "command_lifecycle", command_uuid: uuid, state: "started", session_id: sessionId });
  out({ type: "user", message: { role: "user", content: text }, uuid, isReplay: true, session_id: sessionId });

  let reply = "echo: " + text;
  const watcher = /^\[Watcher: [^\n]*decision #(\d+)\]/.exec(text);
  const approvedFix = /^\[Decision #(\d+) approved/.exec(text);
  if (watcher) {
    const r = await ctl("decision-propose", { decision_id: Number(watcher[1]), summary: "The unit crashed on a transient network timeout; restarting it should clear it.", evidence: "fake: Main process exited, status=1/FAILURE", fix_command: "systemctl restart joya-e2e-fake.service" });
    reply = r.ok ? "Proposed a fix for decision #" + watcher[1] : "propose failed: " + r.error;
  } else if (approvedFix) {
    const cmd = (/```\n([\s\S]*?)\n```/.exec(text) || [])[1] || "true";
    const { allowed, resp } = await askTool("Bash", { command: cmd, description: "run the approved fix" });
    await ctl("decision-update", { decision_id: Number(approvedFix[1]), status: allowed ? "done" : "failed", result: allowed ? "fix ran" : "the gate denied it: " + resp.message });
    reply = allowed ? "Fix ran." : "denied: " + resp.message;
  } else if (text.startsWith("[Standing order:")) {
    reply = "**Services** all 12 up\n**Disk** 6%\n**Needs you** nothing";
  } else if (/^SLOW (\d+)/.test(text)) {
    const cut = await Promise.race([sleep(Math.min(Number(/^SLOW (\d+)/.exec(text)[1]), 30000)).then(() => false), new Promise((r) => (interruptNow = () => r(true)))]);
    interruptNow = null;
    if (cut) {
      out({ type: "result", subtype: "error_during_execution", is_error: true, result: "", duration_ms: 5, total_cost_usd: runningCost, usage: { ...runningUsage }, session_id: sessionId });
      out({ type: "command_lifecycle", command_uuid: uuid, state: "cancelled", session_id: sessionId });
      return;
    }
    reply = /^SLOW \d+\s*$/.test(text.split("\n")[0]) ? "slow done" : "slow done: " + text;
  } else if (text.includes("SAYESCALATE") && text.startsWith("[Now:")) {
    reply = "ESCALATE";
  } else if (/^RUN /.test(text)) {
    const { allowed, resp } = await askTool("Bash", { command: text.slice(4).split("\n")[0], description: "test" });
    reply = allowed ? "allowed" : "denied: " + resp.message;
  } else if (text.includes("MISSION2")) {
    const r = await ctl("mission-create", { title: "Two-step test mission", goal: "Prove missions work end to end", steps: [{ title: "Run the tests", target: "fake-target" }, { title: "Report the count", target: "fake-target" }] });
    if (!r.ok) reply = "mission-create failed: " + r.error;
    else {
      const ref = r.data.mission.ref;
      for (const n of [1, 2]) {
        await delegate(`${ref} step ${n}: please do step ${n}.`);
        await sleep(200);
        await hookPost({ event: "UserPromptSubmit", prompt: `<cross-session-message from="uds:/run/user/0/cc-socks/${process.ppid}.sock" from-name="fake-target" from-mode="prompting">\nstep ${n} done\n</cross-session-message>` });
        await sleep(200);
        await hookPost({ event: "UserPromptSubmit", prompt: `[Cross-session idle notice] "fake-target", which you asked to be notified about, is idle now — it finished a turn at 14:05. Its harness reports: «Done.». This is an automated notice.` });
        await sleep(200);
      }
      reply = "mission " + ref + " delegated";
    }
  } else if (text.includes("DESTROY")) {
    const toolUseId = "toolu_" + crypto.randomBytes(6).toString("hex");
    const input = { command: "rm /tmp/joya-fake-victim", description: "delete the victim" };
    out({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: toolUseId, name: "Bash", input }] }, session_id: sessionId });
    const rid = crypto.randomUUID();
    const answer = new Promise((resolve) => waiting.set(rid, resolve));
    out({ type: "control_request", request_id: rid, request: { subtype: "can_use_tool", tool_name: "Bash", input, decision_reason: "JOYA AI gate · Deletes files or records: rm /tmp/joya-fake-victim", decision_reason_type: "hook", tool_use_id: toolUseId } });
    const resp = await answer;
    const allowed = resp.behavior === "allow";
    out({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: toolUseId, content: allowed ? "removed" : resp.message, is_error: !allowed }] }, session_id: sessionId });
    reply = allowed ? "allowed" : "denied: " + resp.message;
  } else if (text.includes("LISTAGENTS")) {
    // JOYA AI's ListAgents, as the ledger hook sees it: the text in HOME/fake-listagents.txt.
    let body = "";
    try { body = fs.readFileSync(path.join(home, "fake-listagents.txt"), "utf8"); } catch (_) { body = ""; }
    await hookPost({ event: "PostToolUse", tool_name: "ListAgents", tool_input: {}, tool_use_id: "toolu_" + crypto.randomBytes(6).toString("hex"), tool_response: [{ type: "text", text: body }] });
    reply = "listed";
  } else if (text.includes("DELEGATE")) {
    // DELEGATE "<name>" sends to that session instead (the dashboard's dot-stream tests); the reply comes from it.
    const whoTo = (/DELEGATE\s+"([^"]{1,60})"/.exec(text) || [])[1] || "fake-target";
    const who = whoTo.replace(/\s*\[[0-9a-f]{4,12}\]\s*$/i, "");
    const quiet = /\bQUIET\b/.test(text); // no reply, no idle notice (a target that has not answered yet)
    const toolUseId = "toolu_" + crypto.randomBytes(6).toString("hex");
    // "<name> [ref]" as given; a sub-agent id has no ref; anything else gets a made-up one.
    const to = /\[[0-9a-f]{4,12}\]\s*$/i.test(whoTo) || /^a[0-9a-f]{12,24}$/.test(whoTo) ? whoTo : whoTo + " [abc123]";
    const input = { to, message: "Please run the tests and report.", notify_when_idle: true };
    out({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: toolUseId, name: "SendMessage", input }] }, session_id: sessionId });
    const msgId = crypto.randomUUID();
    await hookPost({ event: "PostToolUse", tool_name: "SendMessage", tool_input: input, tool_use_id: toolUseId, tool_response: { success: true, message: "queued", msg_id: msgId } });
    out({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: toolUseId, content: JSON.stringify({ success: true, msg_id: msgId }) }] }, session_id: sessionId });
    reply = "sent " + msgId;
    if (!quiet) setTimeout(async () => {
      await hookPost({ event: "UserPromptSubmit", prompt: `<cross-session-message from="uds:/run/user/0/cc-socks/${process.ppid}.sock" from-name="${who}" from-mode="prompting">\n42 passed\n</cross-session-message>` });
      await sleep(300);
      await hookPost({ event: "UserPromptSubmit", prompt: `[Cross-session idle notice] "${who}", which you asked to be notified about, is idle now — it finished a turn at 14:05. Its harness reports: «Done. 42 passed.». This is an automated notice.` });
    }, 400);
  }
  out({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: reply }] }, session_id: sessionId });
  runningCost = Math.round((runningCost + 0.01) * 100) / 100;
  // usage, like total_cost_usd, is the PROCESS's running total (Claude Code sums its per-model usage): +1,500 / +200 / +5,000 / +300 a turn.
  runningUsage.input_tokens += 1500; runningUsage.output_tokens += 200; runningUsage.cache_read_input_tokens += 5000; runningUsage.cache_creation_input_tokens += 300;
  out({ type: "result", subtype: "success", is_error: false, result: reply, duration_ms: 5, total_cost_usd: runningCost, usage: { ...runningUsage }, session_id: sessionId });
  out({ type: "command_lifecycle", command_uuid: uuid, state: "completed", session_id: sessionId });
  const peer = /PEERTURN ([A-Za-z-]{1,40})/.exec(text);
  if (peer) {
    await sleep(300);
    const pu = crypto.randomUUID();
    const body = "All 42 tests passed.";
    out({ type: "command_lifecycle", command_uuid: pu, state: "queued", session_id: sessionId });
    out({ type: "command_lifecycle", command_uuid: pu, state: "started", session_id: sessionId });
    out({ type: "user", message: { role: "user", content: `<cross-session-message from-name="${peer[1]}">${body}</cross-session-message>` }, uuid: pu, isReplay: true, origin: { kind: "peer", name: peer[1], body }, session_id: sessionId });
    const relay = `${peer[1]} says: ${body}`;
    out({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: relay }] }, session_id: sessionId });
    runningCost = Math.round((runningCost + 0.01) * 100) / 100;
    out({ type: "result", subtype: "success", is_error: false, result: relay, duration_ms: 5, total_cost_usd: runningCost, usage: { ...runningUsage }, session_id: sessionId });
    out({ type: "command_lifecycle", command_uuid: pu, state: "completed", session_id: sessionId });
  }
}

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch (_) {
    return;
  }
  if (msg.type === "control_request") {
    const r = msg.request || {};
    if (r.subtype === "initialize") {
      out({ type: "control_response", response: { subtype: "success", request_id: msg.request_id, response: { commands: [] } } });
      out({ type: "system", subtype: "init", session_id: sessionId, model: flag("--model"), permissionMode: flag("--permission-mode"), claude_code_version: "2.1.283", tools: ["Bash", "mcp__joya-ai__status_snapshot", "mcp__memory__memory_search"], mcp_servers: [{ name: "joya-ai", status: "connected" }, { name: "memory", status: "connected" }] });
    } else if (r.subtype === "remote_control") {
      out({ type: "control_response", response: { subtype: "success", request_id: msg.request_id, response: r.enabled ? { session_url: "https://claude.ai/code/session_FAKE", bridge_session_id: "session_FAKE" } : {} } });
    } else if (r.subtype === "interrupt") {
      out({ type: "control_response", response: { subtype: "success", request_id: msg.request_id } });
      if (interruptNow) interruptNow();
    } else if (r.subtype === "get_usage") {
      // The shape 2.1.283 answers with (trimmed), plus a secret-looking field that must never be passed on.
      out({ type: "control_response", response: { subtype: "success", request_id: msg.request_id, response: {
        session: { total_cost_usd: 1.23 }, subscription_type: "max", rate_limits_available: true, behaviors: null,
        rate_limits: {
          five_hour: { utilization: 18, resets_at: "2026-09-30T09:30:00.411748+00:00" },
          seven_day: { utilization: 39.6, resets_at: "2026-10-05T13:00:00.411767+00:00" },
          seven_day_sonnet: null, seven_day_opus: null,
          model_scoped: [{ display_name: "Fable", utilization: 0, resets_at: "2026-10-05T13:00:00+00:00" }],
          extra_usage: { is_enabled: false, used_credits: null },
          internal_token: "sk-ant-oat01-FAKE-MUST-NOT-LEAK",
        },
      } } });
    } else {
      out({ type: "control_response", response: { subtype: "error", request_id: msg.request_id, error: "unknown" } });
    }
    return;
  }
  if (msg.type === "control_response") {
    const resp = msg.response || {};
    const w = waiting.get(resp.request_id);
    if (w) {
      waiting.delete(resp.request_id);
      w(resp.response || {});
    }
    return;
  }
  if (msg.type === "user") busy = busy.then(() => turn(msg));
});
rl.on("close", () => busy.then(() => process.exit(0)));
