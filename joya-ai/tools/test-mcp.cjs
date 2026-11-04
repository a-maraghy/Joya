/**
 * JOYA AI's MCP server (bin/joya-ai-mcp): the status_snapshot tool.
 *
 *     node joya-ai/tools/test-mcp.cjs
 *
 * Runs the server's message handler against a stand-in control socket, so no
 * supervisor is needed: the tool is listed, takes no arguments, asks for the
 * read-only `snapshot` op as actor joya-ai with nothing else, and hands back
 * the snapshot without forbidden keys or the voice desk's own requests. Then
 * the real buildSnapshot is fed secrets and commands to prove none come out.
 */
"use strict";
const UiActions = require("../lib/ui-actions.js");
const fs = require("fs");
const net = require("net");
const os = require("os");
const path = require("path");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "joya-ai-mcp-"));
const SOCK = path.join(tmp, "ctl.sock");
process.env.JOYA_AI_SOCKET = SOCK;

const mcp = require(path.join(__dirname, "..", "bin", "joya-ai-mcp"));
const { buildSnapshot, FORBIDDEN_KEYS } = require(path.join(__dirname, "..", "lib", "snapshot.js"));

let passes = 0;
let failures = 0;
function check(name, ok, detail) {
  if (ok) {
    passes++;
    return console.log("ok   " + name);
  }
  failures++;
  console.log("FAIL " + name + (detail ? "  (" + String(detail).slice(0, 400) + ")" : ""));
}

/** Run one JSON-RPC message through the server, capturing what it writes. */
async function rpc(msg) {
  const lines = [];
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = (s) => {
    lines.push(String(s));
    return true;
  };
  try {
    await mcp.onMessage(msg);
  } finally {
    process.stdout.write = orig;
  }
  return lines.length ? JSON.parse(lines[0]) : null;
}

function hasKeyDeep(v, keys) {
  if (Array.isArray(v)) return v.some((x) => hasKeyDeep(x, keys));
  if (!v || typeof v !== "object") return false;
  return Object.entries(v).some(([k, x]) => keys.includes(k) || hasKeyDeep(x, keys));
}

(async () => {
  // A stand-in supervisor: records each request and answers with `reply`.
  const seen = [];
  let reply = null;
  const server = net.createServer((s) => {
    let buf = "";
    s.setEncoding("utf8");
    s.on("data", (c) => {
      buf += c;
      const nl = buf.indexOf("\n");
      if (nl === -1) return;
      const req = JSON.parse(buf.slice(0, nl));
      seen.push(req);
      s.end(JSON.stringify({ id: req.id, ok: true, data: reply }) + "\n");
    });
  });
  await new Promise((r) => server.listen(SOCK, r));

  try {
    const list = await rpc({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    const tool = list.result.tools.find((t) => t.name === "status_snapshot");
    check("status_snapshot is listed", !!tool);
    check("it takes no arguments (empty schema, no extras)", tool && Object.keys(tool.inputSchema.properties).length === 0 && tool.inputSchema.additionalProperties === false);
    check("its description says to use it first for status", tool && /FIRST for any status question/.test(tool.description));
    check("the old tools are still there", ["mission_create", "decision_propose", "decision_update"].every((n) => list.result.tools.some((t) => t.name === n)));

    // An argument is refused before anything reaches the supervisor.
    const refused = await rpc({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "status_snapshot", arguments: { turns: [1, 2] } } });
    check("an argument is refused", refused.result.isError && /takes no arguments/.test(refused.result.content[0].text), JSON.stringify(refused));
    check("and nothing was sent to the supervisor", seen.length === 0);

    // The call itself: exactly the read-only op, as joya-ai, with no params.
    reply = {
      taken_at: "2026-09-29T12:00:00Z",
      machine: { host: "vmi", disk: { used_percent: 6, free_gb: 300.1 } },
      services: { tracked: 2, running: 1, failed: ["x.service"], list: [] },
      approvals: { pending: 1, titles: ["Deletes files (Bash)"], command: "rm -rf /secret" },
      decisions: { open: 1, titles: [{ title: "Disk", status: "open", evidence: "LEAK", fix_command: "rm LEAK" }] },
      requests_to_joya_ai: [{ id: 9, reply: "the desk's own" }],
      token: "sk-should-never-show",
    };
    const ok = await rpc({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "status_snapshot", arguments: {} } });
    check("the call succeeds", ok && !ok.result.isError, JSON.stringify(ok));
    const req = seen[0] || {};
    const extra = Object.keys(req).filter((k) => !["id", "op", "actor"].includes(k));
    check("it asks for the snapshot op as joya-ai with no parameters", req.op === "snapshot" && req.actor === "joya-ai" && extra.length === 0, JSON.stringify(req));
    const data = JSON.parse(ok.result.content[0].text);
    check("the snapshot comes back", data.machine && data.machine.disk.free_gb === 300.1 && data.services.failed[0] === "x.service");
    check("forbidden keys are dropped at any depth", !hasKeyDeep(data, FORBIDDEN_KEYS), ok.result.content[0].text);
    check("the voice desk's own requests are dropped", !("requests_to_joya_ai" in data));
    check("no command or secret text survives", !/rm -rf|LEAK|sk-should/.test(ok.result.content[0].text));

    // Missing arguments object is fine too (some clients omit it).
    const bare = await rpc({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "status_snapshot" } });
    check("a call with no arguments object works", bare && !bare.result.isError);

    // ui_actions_list + ui_do (UI control; stable since M-5): a resumed CLI keeps the schema it first loaded, so
    // ui_do's schema must never change -- no enums; what exists is read at run time from ui_actions_list.
    {
      const names = list.result.tools.map((t) => t.name);
      const ui = list.result.tools.find((t) => t.name === "ui_do");
      const ls = list.result.tools.find((t) => t.name === "ui_actions_list");
      check("ui_do and ui_actions_list are listed; the old ui_action is gone", ui && ls && !names.includes("ui_action"), names.join());
      const FROZEN = {
        type: "object",
        properties: {
          action: { type: "string", description: "An action name from ui_actions_list." },
          key: { type: "string", description: "As ui_actions_list gives for the action." },
          mode: { type: "string", description: "As ui_actions_list gives for the action." },
          name: { type: "string", description: "As ui_actions_list gives for the action." },
          core: { type: "string", description: "As ui_actions_list gives for the action." },
          page: { type: "string", description: "As ui_actions_list gives for the action." },
          on: { type: "boolean", description: "call.mute only: true (muting; never unmuting)" },
          theme: { type: "string", description: "As ui_actions_list gives for the action." },
          preset: { type: "string", description: "As ui_actions_list gives for the action." },
          voice: { type: "string", description: "As ui_actions_list gives for the action." },
        },
        required: ["action"],
        additionalProperties: false,
      };
      check("ui_do's input schema is exactly the frozen one (no enum anywhere): adding an action never changes it", ui && JSON.stringify(ui.inputSchema) === JSON.stringify(FROZEN) && !/enum/.test(JSON.stringify(ui.inputSchema)), ui && JSON.stringify(ui.inputSchema));
      check("  its description names no action list: it says to call ui_actions_list", ui && /ui_actions_list: call it first/.test(ui.description) && !/sheet\.open|theme\.set|os-audit/.test(ui.description));
      check("  it says it cannot approve and works only in the administrator's own request", ui && /cannot approve, deny or confirm/.test(ui.description) && /only while you answer a request the administrator sent/.test(ui.description));
      check("  and that needs_confirm actions only ask (confirm; never confirm for them)", ui && /only ASK: their result is confirm/.test(ui.description) && /never confirm for them/.test(ui.description));
      check("ui_actions_list takes nothing", ls && JSON.stringify(ls.inputSchema) === JSON.stringify({ type: "object", properties: {}, additionalProperties: false }));
      seen.length = 0;
      const cat = await rpc({ jsonrpc: "2.0", id: 8, method: "tools/call", params: { name: "ui_actions_list", arguments: {} } });
      const c = cat && !cat.result.isError && JSON.parse(cat.result.content[0].text);
      check("  it answers from the live allowlist, without the supervisor", c && seen.length === 0 && c.actions.map((a) => a.action).join() === UiActions.names().join(), cat && cat.result.content[0].text.slice(0, 200));
      const po = c && c.actions.find((a) => a.action === "page.open");
      check("  with tiers, confirms, once, arguments and values (page.open's page map -- the built-in pages until the panel pushes one -- each with its permission)", po && po.tier === 1 && po.needs_confirm === false && po.once_per_request === true && Object.keys(po.args.page.values).join() === Object.keys(UiActions.BUILTIN_PAGES).join() && Object.keys(po.args.page.values).length === 22 && /needs audit\.view/.test(po.args.page.values["audit"]) && /\[tab\]/.test(po.args.page.values["sessions.live"]) && c.actions.filter((a) => a.needs_confirm).map((a) => a.action).sort().join() === "persona.set,theme.set,voice.set");
      check("  and the rules (own request only, never approve, confirm means nothing changed yet)", c && c.rules.some((r) => /never approves/.test(r)) && c.rules.some((r) => /nothing has changed yet/.test(r)));
      seen.length = 0;
      reply = { status: "ok", done: "Joya opened the audit log" };
      const r = await rpc({ jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "ui_do", arguments: { action: "page.open", page: "os-audit" } } });
      const q = seen[0] || {};
      check("ui_do is the ui-action op as joya-ai, with {action, args} only", q.op === "ui-action" && q.actor === "joya-ai" && q.action === "page.open" && JSON.stringify(q.args) === '{"page":"os-audit"}' && Object.keys(q).sort().join() === "action,actor,args,id,op", JSON.stringify(q));
      check("  and returns the supervisor's answer as is", r && !r.result.isError && JSON.parse(r.result.content[0].text).status === "ok");
      seen.length = 0;
      const bad = await rpc({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "ui_do", arguments: { action: "sheet.open", key: "missions", url: "https://x" } } });
      check("  an unknown argument is refused before the socket", bad.result.isError && /does not take: url/.test(bad.result.content[0].text) && seen.length === 0);
      seen.length = 0;
      await rpc({ jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "ui_do", arguments: { action: "approve.everything" } } });
      check("  an unknown action still goes to the supervisor, which validates it (validation stays server-side)", seen[0] && seen[0].action === "approve.everything");
      const old = await rpc({ jsonrpc: "2.0", id: 10, method: "tools/call", params: { name: "ui_action", arguments: { action: "sheet.open", key: "missions" } } });
      check("  a stale call to ui_action is an unknown tool", old && old.error && /unknown tool/.test(old.error.message));
    }

    // session_hire + session_retire (M-6): new names, schemas frozen from day one (no enums).
    {
      const hire = list.result.tools.find((t) => t.name === "session_hire");
      const ret = list.result.tools.find((t) => t.name === "session_retire");
      const FROZEN_HIRE = JSON.stringify({ type: "object", properties: {
        name: { type: "string", description: "The session's display name, e.g. \"Session Birth\" (1-48 characters, unique)." },
        cwd: { type: "string", description: "Its working directory: an existing directory under /root/joya or /root, e.g. \"/root/joya\"." },
        purpose: { type: "string", description: "What it is for, in a few sentences: this is its first message." },
        model: { type: "string", description: "Optional: a claude-* model id (default: yours)." },
      }, required: ["name", "cwd", "purpose"], additionalProperties: false });
      const FROZEN_RETIRE = JSON.stringify({ type: "object", properties: {
        name: { type: "string", description: "The session's name." },
        ref: { type: "string", description: "Or its ListAgents ref (the hex in [ ])." },
        session_id: { type: "string", description: "Or its session id." },
        note: { type: "string", description: "Optional: why, in one line, shown to the administrator." },
      }, additionalProperties: false });
      check("session_hire's schema is the frozen one {name, cwd, purpose, model?}", hire && JSON.stringify(hire.inputSchema) === FROZEN_HIRE, hire && JSON.stringify(hire.inputSchema));
      check("session_retire's schema is the frozen one {name | ref | session_id, note?}", ret && JSON.stringify(ret.inputSchema) === FROZEN_RETIRE, ret && JSON.stringify(ret.inputSchema));
      check("  its description says it only ASKS (a consent card)", ret && /never ends a session by itself/.test(ret.description) && /consent card/.test(ret.description));
      // Laptop control (0.1.11): files, commands, Start-Process, Office edits, PDFs, the user's Chrome through Claude in Chrome -- no other screen/input control.
      const tko = list.result.tools.find((t) => t.name === "machine_take_over");
      const tkd = tko ? tko.description : "";
      const claims = tkd
        .replace(/When machine_list says its browser is set up, it can also use the user's own Chrome through their Claude in Chrome extension \(open and read pages, fill in fields, click\)\./, "")
        .replace(/Outside Chrome it has NO screen, mouse or keyboard control: it cannot see the screen or click or type into other apps, so do not offer those\./, "");
      check("machine_take_over says what the laptop session can do (files, PowerShell, Start-Process, create_document, Office edits, PDFs, Chrome through Claude in Chrome) and plainly that outside Chrome it has no screen / mouse / keyboard control",
        /PowerShell/.test(tkd) && /Start-Process/.test(tkd) && /create_document/.test(tkd) && /edit existing Word, Excel and PowerPoint/.test(tkd) && /PDFs/.test(tkd) && /Claude in Chrome extension/.test(tkd) && /Outside Chrome it has NO screen, mouse or keyboard control/.test(tkd) && /sending, submitting, buying, posting, deleting/.test(tkd) && !/signing in/.test(tkd) && /never types passwords or payment details/.test(tkd), tkd);
      check("  and claims no other screen, mouse, keyboard, click or screenshot control anywhere else", tko && !/screen|mouse|keyboard|click|screenshot/i.test(claims.replace(/sees a glowing frame/, "")), claims);
      const mlo = list.result.tools.find((t) => t.name === "machine_list");
      check("machine_list says whether the browser can be used there and its Office apps", mlo && /browser: connected/.test(mlo.description) && /office/.test(mlo.description), mlo && mlo.description);
      seen.length = 0;
      await rpc({ jsonrpc: "2.0", id: 11, method: "tools/call", params: { name: "session_hire", arguments: { name: "Demo Worker", cwd: "/root/joya", purpose: "A demo purpose text." } } });
      check("session_hire is op session-hire as joya-ai with exactly its arguments", seen[0] && seen[0].op === "session-hire" && seen[0].actor === "joya-ai" && seen[0].name === "Demo Worker" && seen[0].cwd === "/root/joya", JSON.stringify(seen[0]));
      seen.length = 0;
      const none = await rpc({ jsonrpc: "2.0", id: 12, method: "tools/call", params: { name: "session_retire", arguments: {} } });
      check("session_retire with no name, ref or session id: a tool error, nothing sent", none.result.isError && seen.length === 0);
      await rpc({ jsonrpc: "2.0", id: 13, method: "tools/call", params: { name: "session_retire", arguments: { name: "Demo Worker" } } });
      check("session_retire is op session-retire as joya-ai", seen[0] && seen[0].op === "session-retire" && seen[0].actor === "joya-ai" && seen[0].name === "Demo Worker");
    }

    // The supervisor down: a clean tool error, not a crash.
    server.close();
    fs.rmSync(SOCK, { force: true });
    const down = await rpc({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "status_snapshot", arguments: {} } });
    check("supervisor unreachable is a tool error", down.result.isError && /cannot reach/.test(down.result.content[0].text));

    // The real snapshot builder, fed secrets and commands.
    const snap = buildSnapshot({
      now: "2026-09-29T12:00:00Z",
      host: "vmi3567127",
      vitals: { cpu_pct: 12, cpus: 8, load: [0.5, 0.4, 0.3], mem: { pct: 40, total: 16 * 2 ** 30, available: 9 * 2 ** 30 }, disk: { pct: 6, total: 400 * 2 ** 30, free: 370 * 2 ** 30 } },
      services: [{ unit: "odoo.service", active: "active" }, { unit: "bad.service", active: "failed" }],
      sessions: [{ name: "Odoo 19 VPS setup", status: "idle" }, { name: "JOYA AI", self: true }],
      process: { state: "ready", busy: true, queued: 2 },
      missions: [],
      decisions: [{ title: "Disk filling", status: "open", evidence: "df says 95%", fix_command: "rm -rf /var/log/big" }],
      approvals: [{ tool: "Bash", label: "Deletes files", summary: "rm -rf /root/x", input_json: '{"command":"rm -rf /root/x"}' }],
    });
    const view = mcp.snapshotView(snap);
    const txt = JSON.stringify(view);
    check("real snapshot: figures in human units", view.machine.disk.free_gb === 370 && view.machine.memory.used_percent === 40);
    check("real snapshot: failed service named, self session left out", view.services.failed[0] === "bad.service" && view.sessions.live === 1);
    check("real snapshot: no command, fix or evidence text", !/rm -rf|df says/.test(txt), txt);
    check("real snapshot: no forbidden key", !hasKeyDeep(view, FORBIDDEN_KEYS));
    check("real snapshot: the queue is visible", view.joya_ai.busy === true && view.joya_ai.requests_queued === 2);
  } catch (e) {
    check("no exception", false, e.stack);
  } finally {
    server.close();
    fs.rmSync(tmp, { recursive: true, force: true });
    console.log(`\n${passes} passed, ${failures} failed`);
    process.exit(failures ? 1 : 0);
  }
})();
