#!/usr/bin/env node
"use strict";
/**
 * Agents send the files they make (Word, PDF, Excel ...) into the chat and
 * topic that asked: the runtime's send_file tool, the helper's ALLOW_FILE_SEND
 * switch, and the panel's protection of that key from add-ons.
 *
 *   node dashboard/tools/test-file-send.cjs
 *   JOYA_RUNTIME_SRC=/root/joya/.worktrees/agents-file-send JOYA_TEST_PY=/path/to/venv/bin/python \
 *     node dashboard/tools/test-file-send.cjs
 *
 * A scratch COPY of the runtime's src/ (JOYA_RUNTIME_SRC, default the installed
 * /opt/joya-agents/runtime) runs under JOYA_TEST_PY (default the installed
 * runtime venv's python, which must have python-docx, openpyxl, reportlab,
 * arabic-reshaper, python-bidi and pypdf) against a fake Telegram Bot API on
 * 127.0.0.1 with a fake token and a fake Claude Code CLI (fake-claude-files.py)
 * that writes real documents and calls send_file over the SDK's own protocol
 * (file-send-check.py). Then every received document is opened again with the
 * libraries.
 *
 * A runtime without send_file yet, or a python without the document libraries,
 * is reported as SKIPPED, exit 0. Nothing outside the temp directory is touched.
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
const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "file-send-")));
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

/* ---------------------------------------------------------------- helper -- */
console.log("helper: ALLOW_FILE_SEND");
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
R["old_json"] = h.validate_config(dict(base), creating=False)["file_send"]
R["env_default"] = env_of(h.validate_config(dict(base), creating=False)).get("ALLOW_FILE_SEND")
R["env_off"] = env_of(h.validate_config(dict(base, file_send=False), creating=False)).get("ALLOW_FILE_SEND")
R["env_off_str"] = env_of(h.validate_config(dict(base, file_send="0"), creating=False)).get("ALLOW_FILE_SEND")
for key in ("ALLOW_FILE_SEND", "FILE_SEND_MAX_MB", "FILE_SEND_MAX_PER_REPLY"):
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
  check("an agent.json from before the option: file sending on", R.old_json === true, JSON.stringify(R));
  check("agent.env says ALLOW_FILE_SEND=true by default", R.env_default === "true", R.env_default);
  check("switched off: ALLOW_FILE_SEND=false", R.env_off === "false" && R.env_off_str === "false", JSON.stringify(R));
  for (const k of ["ALLOW_FILE_SEND", "FILE_SEND_MAX_MB", "FILE_SEND_MAX_PER_REPLY"]) {
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
  const agent = (fs_) => ({ slug: "scout", name: "Scout", state: { active: "active" }, notes: 0, memory: {}, channel: null,
    model: "claude-opus-5", effort: "medium", verbose_level: 1, addons: [], file_send: fs_ });
  const box = (html) => (/<input type="checkbox" name="file_send" value="1"( checked)?>/.exec(html) || [])[0];
  let ok = true;
  let html = {};
  try {
    html.on = agentViews.settings({ csrf: "c", user, agent: agent(true), probe: null });
    html.off = agentViews.settings({ csrf: "c", user, agent: agent(false), probe: null });
    html.old = agentViews.settings({ csrf: "c", user, agent: agent(undefined), probe: null });
    html.create = agentViews.create({ csrf: "c", user, form: {}, probe: null });
    html.detailOff = agentViews.detail({ csrf: "c", user, agent: agent(false), notes: [] });
    html.detailOld = agentViews.detail({ csrf: "c", user, agent: agent(undefined), notes: [] });
  } catch (e) {
    ok = false;
    check("agent views render", false, e.stack);
  }
  if (ok) {
    check("settings: the switch is there, ticked when on", /checked/.test(box(html.on) || "") && /name="file_send_shown" value="1"/.test(html.on), box(html.on));
    check("settings: unticked when off", box(html.off) && !/checked/.test(box(html.off)), box(html.off));
    check("settings: an agent saved before the option shows it on", /checked/.test(box(html.old) || ""), box(html.old));
    check("new agent: on by default", /checked/.test(box(html.create) || ""), box(html.create));
    check("overview: says Off / On", /Send files to chat<\/td><td>Off/.test(html.detailOff) && /Send files to chat<\/td><td>On/.test(html.detailOld));
  }
  // The server's reading of the form: unticked = off, no switch on the form = unchanged.
  const src = fs.readFileSync(path.join(ROOT, "server.js"), "utf8");
  const fn = /function fileSendField\(body, missing\) \{[\s\S]*?\n\}/.exec(src);
  const field = (body, name) => String((body && body[name]) || "").trim();
  const fileSendField = fn ? new Function("field", fn[0] + "\nreturn fileSendField;")(field) : null;
  check("server: ticked -> true, unticked -> false, absent -> left alone",
    fileSendField && fileSendField({ file_send_shown: "1", file_send: "1" }, undefined) === true &&
    fileSendField({ file_send_shown: "1" }, undefined) === false &&
    fileSendField({}, undefined) === undefined && fileSendField({}, true) === true);
  check("server: both the create and the settings routes pass file_send",
    (src.match(/file_send: (form\.file_send|fileSendField\(req\.body, undefined\))/g) || []).length === 2);
}

/* --------------------------------------------------------------- runtime -- */
if (!fs.existsSync(PY) || !fs.existsSync(path.join(SRC_ROOT, "src", "main.py"))) {
  console.log("SKIPPED (runtime part): no runtime at " + SRC_ROOT + " or no python at " + PY);
  finish();
}
if (!fs.existsSync(path.join(SRC_ROOT, "src", "claude", "file_send.py"))) {
  console.log("SKIPPED (runtime part): the runtime at " + SRC_ROOT + " has no send_file yet " +
    "(set JOYA_RUNTIME_SRC to the agents/ folder that has it)");
  finish();
}
const libs = spawnSync(PY, ["-c", "import docx, openpyxl, reportlab, arabic_reshaper, bidi, pypdf"], { encoding: "utf8" });
if (libs.status !== 0) {
  console.log("SKIPPED (runtime part): " + PY + " lacks the document libraries " +
    "(set JOYA_TEST_PY to a python that has the runtime and python-docx, openpyxl, reportlab, arabic-reshaper, python-bidi, pypdf)");
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
fs.writeFileSync(outside, "%PDF-1.4 secret");
const cli = path.join(TMP, "fake-claude");
fs.writeFileSync(cli, "#!/bin/sh\nexec " + JSON.stringify(PY) + " -B " + JSON.stringify(path.join(__dirname, "fake-claude-files.py")) + ' "$@"\n');
fs.chmodSync(cli, 0o755);

function agentEnv(name, allow) {
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
    // drawing (render_svg, contact_sheet) has its own test, test-drawing.cjs
    ALLOW_DRAWING: "false",
  };
  const envFile = path.join(TMP, name + ".env");
  fs.writeFileSync(envFile, Object.entries(env).map(([k, v]) => k + "=" + v).join("\n") + "\n");
  return { agent, vault, envFile };
}

function runBot(name, allow, steps) {
  const a = agentEnv(name, allow);
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

console.log("the real runtime, fake Telegram, fake Claude CLI: ALLOW_FILE_SEND=true");
const on = runBot("on", true, "on");
if (on.docs) {
  const docs = (step) => on.docs.filter((d) => d.step === step);
  const sent = (step) => on.sent.filter((s) => s.step === step);
  const run = (needle) => on.runs.find((x) => x.prompt && x.prompt.includes(needle)) || {};
  check("all five updates were delivered", on.steps_delivered === 5, on.steps_delivered);
  check("three Claude runs, none crashed", on.runs.length === 3 && !on.runs.some((x) => x.crash), JSON.stringify(on.runs).slice(0, 600));
  check("every document went to the requesting chat, none elsewhere", on.docs.length > 0 && on.docs.every((d) => String(d.chat) === CHAT), JSON.stringify(on.docs.map((d) => d.chat)));

  const rep = run("make the reports");
  check("topic: Claude ran in the topic's own folder", rep.cwd === path.join(on.vault, "topics", "client-x"), rep.cwd);
  check("topic: send_file offered as an in-process server beside the configured one",
    rep.mcp && rep.mcp.joya_files === "sdk" && rep.mcp.memory === "stdio", JSON.stringify(rep.mcp));
  check("topic: the tool list is exactly send_file", JSON.stringify(rep.tools) === '["send_file"]', JSON.stringify(rep.tools));
  check("topic: send_file is in the allowed tools", /mcp__joya_files__send_file/.test(rep.allowed || ""), rep.allowed);
  check("topic: the system prompt carries the file guide", rep.guide === true);
  check("topic: the three send_file calls succeeded", (rep.calls || []).length === 3 && rep.calls.every((c) => c.ok && /^Sent /.test(c.text)), JSON.stringify(rep.calls));
  const d = docs("topic-reports");
  check("topic: three documents, all into topic 300",
    d.length === 3 && d.every((x) => String(x.thread) === "300"), JSON.stringify(d));
  check("topic: names and captions as given",
    JSON.stringify(d.map((x) => [x.filename, x.caption])) === JSON.stringify([
      ["report.docx", "Monthly report (Word)"], ["data.xlsx", "Sales figures (Excel)"], ["arabic.pdf", "التقرير بالعربي (PDF)"]]),
    JSON.stringify(d.map((x) => [x.filename, x.caption])));
  check("topic: the documents reply to the request", d.every((x) => x.reply_to && /301/.test(String(x.reply_to))), JSON.stringify(d.map((x) => x.reply_to)));
  check("topic: then the text answer, in the topic", sent("topic-reports").some((s) => /Sent the Word, Excel and PDF/.test(s.text) && String(s.thread) === "300"), JSON.stringify(sent("topic-reports")));

  // The files open, and are byte-for-byte what the agent wrote.
  if (d.length === 3) {
    const verify = spawnSync(PY, ["-c", `
import json, sys, unicodedata
import docx, openpyxl
from pypdf import PdfReader
p_docx, p_xlsx, p_pdf, folder = sys.argv[1:5]
R = {}
doc = docx.Document(p_docx)
R["docx"] = [p.text for p in doc.paragraphs]
wb = openpyxl.load_workbook(p_xlsx)
R["xlsx"] = {ws.title: [list(r) for r in ws.iter_rows(values_only=True)] for ws in wb.worksheets}
R["xlsx_rtl"] = wb.worksheets[1].sheet_view.rightToLeft
pdf = PdfReader(p_pdf)
R["pdf_pages"] = len(pdf.pages)
R["pdf_text"] = unicodedata.normalize("NFKC", "\\n".join(pg.extract_text() for pg in pdf.pages))
import os
R["same"] = all(open(a, "rb").read() == open(os.path.join(folder, b), "rb").read()
                for a, b in ((p_docx, "report.docx"), (p_xlsx, "data.xlsx"), (p_pdf, "arabic.pdf")))
print(json.dumps(R, ensure_ascii=False, default=str))
`, d[0].saved, d[1].saved, d[2].saved, path.join(on.vault, "topics", "client-x", "outbox")], { encoding: "utf8" });
    let V = {};
    try {
      V = JSON.parse((verify.stdout || "").trim().split("\n").pop());
    } catch (e) {
      check("received documents re-read", false, (verify.stdout || "") + (verify.stderr || ""));
    }
    check("received = what the agent wrote, byte for byte", V.same === true);
    check("the .docx opens: heading, figures and the Arabic line",
      Array.isArray(V.docx) && V.docx.includes("Monthly report") && V.docx.includes("Basil sold: 1,200 kg") && V.docx.includes("تقرير المبيعات الشهري"), JSON.stringify(V.docx));
    check("the .xlsx opens: numbers as numbers, the Arabic sheet right-to-left",
      V.xlsx && JSON.stringify(V.xlsx.Sales) === JSON.stringify([["Product", "Qty kg"], ["Basil", 1200], ["Thyme", 850.5]]) &&
      JSON.stringify(V.xlsx["عربي"]) === JSON.stringify([["المنتج", "الكمية"], ["ريحان", 1200]]) && V.xlsx_rtl === true, JSON.stringify(V.xlsx));
    check("the .pdf opens and has pages", V.pdf_pages >= 1, V.pdf_pages);
    check("the .pdf's Arabic text extracts (shaped, in reading order)",
      typeof V.pdf_text === "string" && V.pdf_text.includes("تقرير المبيعات الشهري لشركة الجيزة") && V.pdf_text.includes("ريحان") && V.pdf_text.includes("Monthly sales report"),
      V.pdf_text);
  }

  const csv = run("make a csv");
  const g = docs("general-csv");
  check("General: Claude ran in the General project's folder (the vault)", csv.cwd === on.vault, csv.cwd);
  check("General: the csv went to the chat with no topic id", g.length === 1 && g[0].filename === "summary.csv" && g[0].caption === "Summary" && (g[0].thread === undefined || g[0].thread === null), JSON.stringify(g));

  const esc = run("try to escape");
  const calls = esc.calls || [];
  const byCap = (c) => calls.find((x) => x.caption === c) || {};
  check("refused: a file outside the agent's folder", byCap("outside").ok === false && /outside your folder/.test(byCap("outside").text), JSON.stringify(byCap("outside")));
  check("refused: ../ out of the folder", byCap("dotdot").ok === false && /outside/.test(byCap("dotdot").text), JSON.stringify(byCap("dotdot")));
  check("refused: a symlink pointing outside", byCap("symlink").ok === false && /outside/.test(byCap("symlink").text), JSON.stringify(byCap("symlink")));
  check("refused: a .sh file", byCap("script").ok === false && /cannot be sent/.test(byCap("script").text), JSON.stringify(byCap("script")));
  const notes = calls.filter((x) => /^note /.test(x.caption));
  check("limit: five files per reply, the sixth refused",
    notes.length === 6 && notes.slice(0, 5).every((x) => x.ok) && notes[5].ok === false && /Already sent 5/.test(notes[5].text), JSON.stringify(notes));
  const e = docs("topic-escape");
  check("only the five notes reached Telegram, in topic 300",
    e.length === 5 && e.every((x) => /^n[0-4]\.txt$/.test(x.filename) && String(x.thread) === "300"), JSON.stringify(e));
  check("the secret never left", !on.docs.some((x) => /secret|link|run\.sh/.test(x.filename || "")));
  check("not addressed: nothing sent, no Claude run", docs("topic-unaddressed").length === 0 && sent("topic-unaddressed").length === 0);
  check("bot exited cleanly", on.code === 0, on.code + "\n" + (on.log_tail || []).join("\n"));
}

console.log("ALLOW_FILE_SEND=false");
const off = runBot("off", false, "off");
if (off.docs) {
  const r0 = off.runs[0] || {};
  check("off: Claude ran", off.runs.length === 1 && !r0.crash, JSON.stringify(off.runs));
  check("off: no send_file server, only the configured one", r0.mcp && !("joya_files" in r0.mcp) && r0.mcp.memory === "stdio", JSON.stringify(r0.mcp));
  check("off: no file guide in the system prompt, not in allowed tools", r0.guide === false && !/joya_files/.test(r0.allowed || ""), JSON.stringify(r0));
  check("off: no document sent", off.docs.length === 0, JSON.stringify(off.docs));
  check("off: the answer still arrives", off.sent.some((s) => /no way to send files/.test(s.text)), JSON.stringify(off.sent));
  check("off: bot exited cleanly", off.code === 0, off.code + "\n" + (off.log_tail || []).join("\n"));
}

finish();
