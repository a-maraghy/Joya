#!/usr/bin/env node
"use strict";
/**
 * ask_chatgpt wiring for JOYA AI, hired sessions and the console:
 * lib/chatgpt.js, joya-session's argv and joya-helper's console_chatgpt_args.
 *
 *   node joya-ai/tools/test-chatgpt.cjs
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const { chatgptServer, ALLOW } = require("../lib/chatgpt");

let failures = 0;
let passes = 0;
function check(name, ok, detail) {
  if (ok) {
    passes++;
    console.log("  ok   " + name);
  } else {
    failures++;
    console.log("  FAIL " + name + (detail ? "\n       " + String(detail).slice(0, 400) : ""));
  }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "chatgpt-wiring-"));
const script = path.join(tmp, "chatgpt_mcp.py");
fs.writeFileSync(script, "# fake\n");

const g = chatgptServer({ chatgpt_mcp: script }, "joya-ai", path.join(tmp, "out"));
check("server config when installed", g && g.name === "chatgpt" && g.allow === "mcp__chatgpt" && ALLOW === "mcp__chatgpt", JSON.stringify(g));
check("stdio, isolated python, the script", g && g.server.type === "stdio" && g.server.args[0] === "-I" && g.server.args[1] === script);
check("caller and output folder passed", g && g.server.env.JOYA_CHATGPT_CALLER === "joya-ai" && g.server.env.JOYA_CHATGPT_OUT === path.join(tmp, "out"));
check("off when switched off", chatgptServer({ chatgpt_mcp: "" }, "x") === null);
check("off when not installed", chatgptServer({ chatgpt_mcp: path.join(tmp, "missing.py") }, "x") === null);

// joya-session builds its argv with chatgptArgs(): the source must use the shared lib and keep files out of the project.
const ms = fs.readFileSync(path.join(__dirname, "..", "bin", "joya-session"), "utf8");
check("hired sessions get ask_chatgpt", /chatgptServer\(cfg, "hired:" \+ slug, path\.join\(cfg\.state_dir, "chatgpt", slug\)\)/.test(ms) && /\.\.\.chatgptArgs\(\)/.test(ms));

// joya-helper: console_chatgpt_args for both console profiles.
const helper = path.join(__dirname, "..", "..", "dashboard", "deploy", "joya-helper");
const py = `
import importlib.machinery, importlib.util, json, sys
loader = importlib.machinery.SourceFileLoader("joya_helper", sys.argv[1])
spec = importlib.util.spec_from_loader("joya_helper", loader)
m = importlib.util.module_from_spec(spec); loader.exec_module(m)
m.CHATGPT_MCP = sys.argv[2]
out = {a: m.console_chatgpt_args(a) for a in ("full", "workspace")}
m.CHATGPT_MCP = sys.argv[2] + ".missing"
out["missing"] = m.console_chatgpt_args("full")
print(json.dumps(out))
`;
let res = null;
try {
  res = JSON.parse(execFileSync("python3", ["-c", py, helper, script], { encoding: "utf8" }));
} catch (e) {
  check("joya-helper loads", false, e.message);
}
if (res) {
  const full = res.full;
  const conf = JSON.parse(full[full.indexOf("--mcp-config") + 1]).mcpServers.chatgpt;
  check("console (full) gets ask_chatgpt, allowed", full.includes("mcp__chatgpt") && conf.args[1] === script && conf.env.JOYA_CHATGPT_CALLER === "console:full" && !conf.env.JOYA_CHATGPT_FILES_ROOT, JSON.stringify(full));
  const ws = JSON.parse(res.workspace[res.workspace.indexOf("--mcp-config") + 1]).mcpServers.chatgpt;
  check("console (workspace) may give files from the agents' tree only", ws.env.JOYA_CHATGPT_FILES_ROOT === "/opt/joya-agents/agents" && ws.env.JOYA_CHATGPT_CALLER === "console:workspace", JSON.stringify(ws));
  check("console: nothing when the broker is not installed", Array.isArray(res.missing) && res.missing.length === 0);
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
