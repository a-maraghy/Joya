#!/usr/bin/env node
"use strict";
/**
 * Pictures drawn in code: the agent writes SVG, the runtime renders it (resvg)
 * and shows Claude the PNG, makes contact sheets, and sends the SVG with a PNG
 * preview into the chat and topic that asked. The helper's ALLOW_DRAWING
 * switch (riding on file sending), the panel's "Images (drawn in code)" switch
 * and the protection of the drawing keys from add-ons.
 *
 *   JOYA_RUNTIME_SRC=/root/joya/.worktrees/agents-image-gen JOYA_TEST_PY=/path/to/venv/bin/python \
 *     node dashboard/tools/test-drawing.cjs
 *
 * Same harness as test-file-send.cjs: a scratch COPY of the runtime's src/ under
 * JOYA_TEST_PY against a fake Telegram Bot API on 127.0.0.1 and a fake Claude
 * Code CLI (fake-claude-files.py) that speaks the SDK's control protocol, so the
 * images the render tools return travel the real wire (runtime -> SDK -> CLI).
 *
 * A runtime without drawing yet, or a python without resvg-py, is reported as
 * SKIPPED, exit 0. Nothing outside the temp directory is touched.
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const HELPER = path.join(ROOT, "deploy", "joya-helper");
const RUNTIME_DIR = process.env.JOYA_RUNTIME_DIR || "/opt/joya-agents/runtime";
const PY = process.env.JOYA_TEST_PY || path.join(RUNTIME_DIR, "venv", "bin", "python");
const SRC_ROOT = process.env.JOYA_RUNTIME_SRC || RUNTIME_DIR;
const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "drawing-")));
const CHAT = "-1001234567890";

let failed = 0;
let passed = 0;
function check(name, cond, detail) {
  if (cond) {
    passed++;
    console.log("  ok   " + name);
  } else {
    failed++;
    console.log("  FAIL " + name + (detail !== undefined ? "\n       " + String(detail).slice(0, 900) : ""));
  }
}
function finish() {
  fs.rmSync(TMP, { recursive: true, force: true });
  console.log("\n" + passed + " passed, " + failed + " failed");
  process.exit(failed ? 1 : 0);
}
const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
function pngSize(file) {
  const b = fs.readFileSync(file);
  if (b.length < 24 || !b.subarray(0, 8).equals(PNG_SIG)) return null;
  return [b.readUInt32BE(16), b.readUInt32BE(20)];
}

/* ---------------------------------------------------------------- helper -- */
console.log("helper: ALLOW_DRAWING");
{
  const script = `
import importlib.machinery, importlib.util, json, sys
loader = importlib.machinery.SourceFileLoader("joya_helper", ${JSON.stringify(HELPER)})
spec = importlib.util.spec_from_loader("joya_helper", loader)
h = importlib.util.module_from_spec(spec)
loader.exec_module(h)
R = {}
base = {"slug": "scratch", "name": "Scratch", "model": "claude-opus-5", "effort": "low", "max_turns": 10,
        "timeout_seconds": 60, "verbose_level": 0, "addons": [], "addon_env": {}, "project_dir": "", "role": ""}
def env_of(cfg):
    out = {}
    for line in h.render_env(cfg, None, {"enabled": False}).splitlines():
        if "=" in line and not line.startswith("#"):
            k, _, v = line.partition("="); out[k] = v
    return out
R["old_json"] = h.validate_config(dict(base), creating=False)["drawing"]
R["env_default"] = env_of(h.validate_config(dict(base), creating=False)).get("ALLOW_DRAWING")
R["env_off"] = env_of(h.validate_config(dict(base, drawing=False), creating=False)).get("ALLOW_DRAWING")
R["env_off_str"] = env_of(h.validate_config(dict(base, drawing="0"), creating=False)).get("ALLOW_DRAWING")
R["env_files_off"] = env_of(h.validate_config(dict(base, file_send=False, drawing=True), creating=False)).get("ALLOW_DRAWING")
R["files_still_on"] = env_of(h.validate_config(dict(base, drawing=False), creating=False)).get("ALLOW_FILE_SEND")
for key in ("ALLOW_DRAWING", "DRAW_MAX_RENDER_PX", "DRAW_MAX_RENDERS_PER_REPLY", "SVG_MAX_KB"):
    try:
        h.validate_env_map({key: "true"}); R["addon_" + key] = "accepted"
    except SystemExit:
        R["addon_" + key] = "refused"
    except Exception as e:
        R["addon_" + key] = "refused:" + type(e).__name__
print(json.dumps(R))
`;
  const r = spawnSync("python3", ["-c", script], {
    encoding: "utf8",
    env: Object.assign({}, process.env, { JOYA_DATA_DIR: TMP }),
  });
  let R = {};
  try {
    R = JSON.parse((r.stdout || "").trim().split("\n").pop());
  } catch (e) {
    check("helper loads", false, (r.stdout || "") + (r.stderr || ""));
  }
  check("an agent.json from before the option: drawing on", R.old_json === true, JSON.stringify(R));
  check("agent.env says ALLOW_DRAWING=true by default", R.env_default === "true", R.env_default);
  check("switched off: ALLOW_DRAWING=false", R.env_off === "false" && R.env_off_str === "false", JSON.stringify(R));
  check("file sending off: ALLOW_DRAWING=false whatever is stored", R.env_files_off === "false", R.env_files_off);
  check("drawing off leaves file sending on", R.files_still_on === "true", R.files_still_on);
  for (const k of ["ALLOW_DRAWING", "DRAW_MAX_RENDER_PX", "DRAW_MAX_RENDERS_PER_REPLY", "SVG_MAX_KB"]) {
    check("an add-on cannot set " + k, String(R["addon_" + k] || "").startsWith("refused"), R["addon_" + k]);
  }
}

/* ----------------------------------------------------------------- panel -- */
console.log("panel: the agent's settings");
{
  const agentViews = require(path.join(ROOT, "lib", "views-agents.js"));
  const rbac = require(path.join(ROOT, "lib", "rbac.js"));
  const user = { name: "admin", roleLabel: "Administrator",
    perm: rbac.actor({ permissions: ["*"], agent_scope: "*", channel_scope: "*" }) };
  const agent = (dr, fs_) => ({ slug: "scout", name: "Scout", state: { active: "active" }, notes: 0, memory: {}, channel: null,
    model: "claude-opus-5", effort: "medium", verbose_level: 1, addons: [], file_send: fs_, drawing: dr });
  const box = (html) => (/<input type="checkbox" name="drawing" value="1"( checked)?>/.exec(html) || [])[0];
  let ok = true;
  const html = {};
  try {
    html.on = agentViews.settings({ csrf: "c", user, agent: agent(true), probe: null });
    html.off = agentViews.settings({ csrf: "c", user, agent: agent(false), probe: null });
    html.old = agentViews.settings({ csrf: "c", user, agent: agent(undefined), probe: null });
    html.create = agentViews.create({ csrf: "c", user, form: {}, probe: null });
    html.dOff = agentViews.detail({ csrf: "c", user, agent: agent(false), notes: [] });
    html.dOld = agentViews.detail({ csrf: "c", user, agent: agent(undefined), notes: [] });
    html.dNoFiles = agentViews.detail({ csrf: "c", user, agent: agent(true, false), notes: [] });
  } catch (e) {
    ok = false;
    check("agent views render", false, e.stack);
  }
  if (ok) {
    check("settings: the switch is there, ticked when on", /checked/.test(box(html.on) || "") && /name="drawing_shown" value="1"/.test(html.on), box(html.on));
    check("settings: unticked when off", box(html.off) && !/checked/.test(box(html.off)), box(html.off));
    check("settings: an agent saved before the option shows it on", /checked/.test(box(html.old) || ""));
    check("new agent: on by default", /checked/.test(box(html.create) || ""), box(html.create));
    check("settings: the switch sits right after Send files to chat",
      html.on.indexOf('name="file_send"') > 0 && html.on.indexOf('name="drawing"') > html.on.indexOf('name="file_send"'));
    check("overview: Off / On / needs file sending",
      /Images \(drawn in code\)<\/td><td>Off</.test(html.dOff) && /Images \(drawn in code\)<\/td><td>On</.test(html.dOld) &&
      /Images \(drawn in code\)<\/td><td>Off \(needs Send files to chat\)/.test(html.dNoFiles));
  }
  const src = fs.readFileSync(path.join(ROOT, "server.js"), "utf8");
  const fn = /function drawingField\(body, missing\) \{[\s\S]*?\n\}/.exec(src);
  const field = (body, name) => String((body && body[name]) || "").trim();
  const drawingField = fn ? new Function("field", fn[0] + "\nreturn drawingField;")(field) : null;
  check("server: ticked -> true, unticked -> false, absent -> left alone",
    drawingField && drawingField({ drawing_shown: "1", drawing: "1" }, undefined) === true &&
    drawingField({ drawing_shown: "1" }, undefined) === false &&
    drawingField({}, undefined) === undefined && drawingField({}, true) === true);
  check("server: both the create and the settings routes pass drawing",
    (src.match(/drawing: (form\.drawing|drawingField\(req\.body, undefined\))/g) || []).length === 2);
}

/* --------------------------------------------------------------- runtime -- */
if (!fs.existsSync(PY) || !fs.existsSync(path.join(SRC_ROOT, "src", "main.py"))) {
  console.log("SKIPPED (runtime part): no runtime at " + SRC_ROOT + " or no python at " + PY);
  finish();
}
if (!fs.existsSync(path.join(SRC_ROOT, "src", "claude", "drawing.py"))) {
  console.log("SKIPPED (runtime part): the runtime at " + SRC_ROOT + " cannot draw yet " +
    "(set JOYA_RUNTIME_SRC to the agents/ folder that has src/claude/drawing.py)");
  finish();
}
const libs = spawnSync(PY, ["-c", "import resvg_py"], { encoding: "utf8" });
if (libs.status !== 0) {
  console.log("SKIPPED (runtime part): " + PY + " lacks resvg-py (set JOYA_TEST_PY to a python that has the runtime and resvg-py)");
  finish();
}

const copy = path.join(TMP, "src-copy");
fs.mkdirSync(copy);
fs.cpSync(path.join(SRC_ROOT, "src"), path.join(copy, "src"), {
  recursive: true,
  filter: (p) => !p.includes("__pycache__"),
});
const outside = path.join(TMP, "not-the-agents", "secret.pdf");
fs.mkdirSync(path.dirname(outside));
fs.writeFileSync(outside, "%PDF-1.4 secret");  // unused here; the harness expects it
const cli = path.join(TMP, "fake-claude");
fs.writeFileSync(cli, "#!/bin/sh\nexec " + JSON.stringify(PY) + " -B " + JSON.stringify(path.join(__dirname, "fake-claude-files.py")) + ' "$@"\n');
fs.chmodSync(cli, 0o755);

function agentEnv(name, allow, drawing) {
  const agent = path.join(TMP, name);
  const vault = path.join(agent, "vault");
  fs.mkdirSync(vault, { recursive: true });
  fs.mkdirSync(path.join(agent, "data"));
  fs.writeFileSync(path.join(agent, "projects.yaml"),
    'projects:\n  - slug: "scratch"\n    name: "SCRATCH"\n    path: "."\n    enabled: true\n');
  // A configured (stdio) server, so the check sees send_file added beside it.
  fs.writeFileSync(path.join(agent, "mcp.json"), JSON.stringify({ mcpServers: { memory: { command: "/bin/false", args: [] } } }));
  const env = {
    USE_SDK: "true",
    AGENTIC_MODE: "true",
    ENABLE_TOKEN_AUTH: "false",
    TELEGRAM_BOT_TOKEN: "123456789:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    TELEGRAM_BOT_USERNAME: "scratch_files_bot",
    APPROVED_DIRECTORY: vault,
    ALLOWED_USERS: "111",
    DATABASE_URL: "sqlite:///" + path.join(agent, "data", "bot.db"),
    ENABLE_PROJECT_THREADS: "true",
    PROJECT_THREADS_MODE: "group",
    PROJECT_THREADS_CHAT_ID: CHAT,
    PROJECTS_CONFIG_PATH: path.join(agent, "projects.yaml"),
    PROJECT_THREADS_GENERAL_PROJECT: "scratch",
    PROJECT_THREADS_AUTO_MAP: "true",
    PROJECT_THREADS_AUTO_ANNOUNCE: "true",
    PROJECT_THREADS_SYNC_ACTION_INTERVAL_SECONDS: "0",
    PROJECT_THREADS_PROBE_INTERVAL_SECONDS: "3600",
    GROUP_RESPOND_MODE: "mention",
    BOT_NAME_ALIASES: "MAVIX",
    ENABLE_MCP: "true",
    MCP_CONFIG_PATH: path.join(agent, "mcp.json"),
    ENABLE_STREAM_DRAFTS: "false",
    VERBOSE_LEVEL: "0",
    CLAUDE_CLI_PATH: cli,
    CLAUDE_TIMEOUT_SECONDS: "60",
    ALLOW_FILE_SEND: allow ? "true" : "false",
    ALLOW_DRAWING: drawing ? "true" : "false",
  };
  const envFile = path.join(TMP, name + ".env");
  fs.writeFileSync(envFile, Object.entries(env).map(([k, v]) => k + "=" + v).join("\n") + "\n");
  return { agent, vault, envFile };
}

function runBot(name, allow, drawing, steps) {
  const a = agentEnv(name, allow, drawing);
  const caseFile = path.join(TMP, name + "-case.json");
  const outDir = path.join(TMP, name + "-received");
  const claudeLog = path.join(TMP, name + "-claude.jsonl");
  fs.writeFileSync(caseFile, JSON.stringify({ env: a.envFile, steps, out: outDir, claude_log: claudeLog, seconds: 90 }));
  const r = spawnSync(PY, ["-B", path.join(__dirname, "file-send-check.py"), copy, caseFile], {
    encoding: "utf8",
    cwd: copy,
    timeout: 180000,
    env: Object.assign({}, process.env, {
      HOME: TMP,
      PYTHONDONTWRITEBYTECODE: "1",
      FAKE_OUTSIDE_FILE: outside,
    }),
  });
  let res = {};
  try {
    res = JSON.parse((r.stdout || "").trim().split("\n").pop());
  } catch (e) {
    check(name + ": the check printed its result", false, (r.stdout || "").slice(-900) + (r.stderr || "").slice(-900));
  }
  return Object.assign(res, a);
}


console.log("the real runtime, fake Telegram, fake Claude CLI: ALLOW_DRAWING=true");
const on = runBot("draw", true, true, "draw");
if (on.docs) {
  const docs = (step) => on.docs.filter((d) => d.step === step);
  const run = (needle) => on.runs.find((x) => x.prompt && x.prompt.includes(needle)) || {};
  check("all four updates were delivered", on.steps_delivered === 4, on.steps_delivered);
  check("two Claude runs, none crashed", on.runs.length === 2 && !on.runs.some((x) => x.crash), JSON.stringify(on.runs).slice(0, 600));
  check("everything went to the requesting chat, nowhere else",
    on.docs.length > 0 && on.docs.every((d) => String(d.chat) === CHAT), JSON.stringify(on.docs.map((d) => d.chat)));

  const d = run("draw the logo");
  const byCap = (c) => (d.calls || []).find((x) => x.caption === c) || {};
  check("the tools offered: send_file, render_svg, contact_sheet",
    JSON.stringify(d.tools) === '["send_file","render_svg","contact_sheet"]', JSON.stringify(d.tools));
  check("all three are in the allowed tools",
    ["send_file", "render_svg", "contact_sheet"].every((t) => (d.allowed || "").includes("mcp__joya_files__" + t)), d.allowed);
  check("the system prompt carries the drawing playbook", d.draw_guide === true && d.guide === true);
  check("Claude ran in the topic's own folder", d.cwd === path.join(on.vault, "topics", "client-x"), d.cwd);

  const r1 = byCap("render");
  check("render_svg returned the drawing to Claude as PNG images (view + 32/64 px strip)",
    r1.ok && r1.images.length === 2 && r1.images.every((i) => i.png && i.mime === "image/png") &&
    r1.images[0].w === 512 && r1.images[0].h === 512 && r1.images[1].w > 600, JSON.stringify(r1));
  const r2 = byCap("render dark");
  check("render_svg on dark, no strip: one image, wordmark proportions",
    r2.ok && r2.images.length === 1 && r2.images[0].w === 1024 && Math.abs(r2.images[0].h - 353) <= 1, JSON.stringify(r2));
  const folder = path.join(on.vault, "topics", "client-x", "drawings");
  check("the renders were saved next to the SVGs",
    JSON.stringify(pngSize(path.join(folder, "mavix-geometric-v1.png"))) === "[512,512]" &&
    (pngSize(path.join(folder, "mavix-wordmark-v1.png")) || [])[0] === 1024);
  const sh = byCap("sheet");
  check("contact_sheet: saved where asked, shown to Claude", sh.ok && sh.images.length === 1 && sh.images[0].png &&
    fs.existsSync(path.join(folder, "mavix-sheet.png")), JSON.stringify(sh));
  check("nothing reached Telegram from rendering alone (renders are private)",
    !on.docs.some((x) => /mavix-wordmark/.test(x.filename || "")));

  const t = docs("topic-draw");
  check("Telegram got: the sheet as a photo, the SVG as a document, its PNG preview as a photo",
    JSON.stringify(t.map((x) => [x.kind, x.filename])) === JSON.stringify([
      ["photo", "mavix-sheet.png"], ["document", "mavix-geometric-v1.svg"], ["photo", "mavix-geometric-v1.png"]]),
    JSON.stringify(t.map((x) => [x.kind, x.filename, x.caption])));
  check("all three in topic 300, replying to the request",
    t.length === 3 && t.every((x) => String(x.thread) === "300" && /311/.test(String(x.reply_to))), JSON.stringify(t));
  check("captions as given", t[0] && t[0].caption === "Two directions" && t[1].caption === "MAVIX logo (SVG)" &&
    /Preview of mavix-geometric-v1\.svg/.test(t[2].caption || ""), JSON.stringify(t.map((x) => x.caption)));
  if (t.length === 3) {
    check("the SVG arrived byte for byte",
      fs.readFileSync(t[1].saved).equals(fs.readFileSync(path.join(folder, "mavix-geometric-v1.svg"))));
    check("the preview is a real 1024 px PNG", JSON.stringify(pngSize(t[2].saved)) === "[1024,1024]", JSON.stringify(pngSize(t[2].saved)));
    check("the sheet is a real PNG with two tiles side by side", (pngSize(t[0].saved) || [0])[0] > (pngSize(t[0].saved) || [0, 0])[1], JSON.stringify(pngSize(t[0].saved)));
  }

  const e = run("draw something evil");
  const eCap = (c) => (e.calls || []).find((x) => x.caption === c) || {};
  check("unsafe SVG: render refused", eCap("render ext").ok === false && /outside the drawing/.test(eCap("render ext").text), JSON.stringify(eCap("render ext")));
  check("unsafe SVG: sending refused (external reference)", eCap("send ext").ok === false && /Not a safe SVG/.test(eCap("send ext").text), JSON.stringify(eCap("send ext")));
  check("unsafe SVG: sending refused (script / handler)", eCap("send script").ok === false && /Not a safe SVG/.test(eCap("send script").text), JSON.stringify(eCap("send script")));
  check("General: nothing was sent for the evil drawings", docs("general-evil").length === 0, JSON.stringify(docs("general-evil")));
  check("not addressed: nothing", docs("topic-unaddressed").length === 0);
  check("bot exited cleanly", on.code === 0, on.code + "\n" + (on.log_tail || []).join("\n"));
}

console.log("ALLOW_DRAWING=false (file sending on)");
const off = runBot("drawoff", true, false, "drawoff");
if (off.docs) {
  const r0 = off.runs[0] || {};
  const c = (cap) => (r0.calls || []).find((x) => x.caption === cap) || {};
  check("off: Claude ran", off.runs.length === 1 && !r0.crash, JSON.stringify(off.runs));
  check("off: only send_file is offered", JSON.stringify(r0.tools) === '["send_file"]', JSON.stringify(r0.tools));
  check("off: no drawing playbook, no render tools allowed", r0.draw_guide === false && !/render_svg|contact_sheet/.test(r0.allowed || ""), JSON.stringify(r0));
  check("off: render_svg does not exist", c("render").ok === false && /Unknown tool/.test(c("render").text), JSON.stringify(c("render")));
  check("off: preview refused", c("send svg").ok === false && /drawing switched on/.test(c("send svg").text), JSON.stringify(c("send svg")));
  check("off: nothing sent", off.docs.length === 0, JSON.stringify(off.docs));
  check("off: bot exited cleanly", off.code === 0, off.code + "\n" + (off.log_tail || []).join("\n"));
}

finish();
