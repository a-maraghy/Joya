#!/usr/bin/env node
"use strict";
/**
 * The real agent runtime with the per-agent options added for mavix-bot:
 * General topic -> a project, respond only when asked, new topics get their
 * own folder, and a deleted topic's folder goes to the trash.
 *
 *   node dashboard/tools/test-topics-respond.cjs
 *   JOYA_RUNTIME_SRC=/root/joya/.worktrees/agents-general-topic node dashboard/tools/test-topics-respond.cjs
 *
 * A scratch COPY of the runtime's src/ (JOYA_RUNTIME_SRC, default the installed
 * /opt/joya-agents/runtime) is run by the installed venv's interpreter against
 * a fake Telegram Bot API on 127.0.0.1 with a fake token and a fake Claude
 * (topics-respond-check.py). The agent.env is the one joya-helper renders for
 * a channel with these options, when the helper knows them; otherwise an
 * equivalent hand-written one.
 *
 * A runtime that does not have the options yet (the installed one, before the
 * update) is reported as SKIPPED, exit 0: this suite is about the new code.
 * Nothing outside the temp directory is touched.
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const HELPER = path.join(ROOT, "deploy", "joya-helper");
const VENV_PY = path.join(process.env.JOYA_RUNTIME_DIR || "/opt/joya-agents/runtime", "venv", "bin", "python");
const SRC_ROOT = process.env.JOYA_RUNTIME_SRC || process.env.JOYA_RUNTIME_DIR || "/opt/joya-agents/runtime";
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "topics-respond-"));

let failed = 0;
let passed = 0;
function check(name, cond, detail) {
  if (cond) {
    passed++;
    console.log("  ok   " + name);
  } else {
    failed++;
    console.log("  FAIL " + name + (detail !== undefined ? "\n       " + String(detail).slice(0, 800) : ""));
  }
}

if (!fs.existsSync(VENV_PY) || !fs.existsSync(path.join(SRC_ROOT, "src", "main.py"))) {
  console.log("SKIPPED: no runtime at " + SRC_ROOT);
  process.exit(0);
}
if (!fs.existsSync(path.join(SRC_ROOT, "src", "bot", "addressing.py"))) {
  console.log("SKIPPED: the runtime at " + SRC_ROOT + " does not have the respond/auto-topic options yet " +
    "(set JOYA_RUNTIME_SRC to the agents/ folder that has them)");
  process.exit(0);
}

const copy = path.join(TMP, "src-copy");
fs.mkdirSync(copy);
fs.cpSync(path.join(SRC_ROOT, "src"), path.join(copy, "src"), {
  recursive: true,
  filter: (p) => !p.includes("__pycache__"),
});

const agent = path.join(TMP, "agent");
const vault = path.join(agent, "vault");
fs.mkdirSync(vault, { recursive: true });
fs.mkdirSync(path.join(agent, "data"));
fs.writeFileSync(
  path.join(agent, "projects.yaml"),
  'projects:\n  - slug: "scratch"\n    name: "SCRATCH"\n    path: "."\n    enabled: true\n'
);

/** The env joya-helper writes for such a channel, when it knows the options. */
function helperEnv() {
  const script = `
import importlib.machinery, importlib.util, json, sys
loader = importlib.machinery.SourceFileLoader("joya_helper", ${JSON.stringify(HELPER)})
spec = importlib.util.spec_from_loader("joya_helper", loader)
h = importlib.util.module_from_spec(spec)
loader.exec_module(h)
if "GROUP_RESPOND_MODE" not in getattr(h, "PROTECTED_ENV_KEYS", ()):
    print(json.dumps({"ok": False})); sys.exit(0)
cfg = {"slug": "scratch", "name": "Mavix", "model": "m", "effort": "low", "max_turns": 10,
       "timeout_seconds": 60, "verbose_level": 0, "addon_env": {}, "project_dir": "", "role": ""}
channel = {"type": "telegram", "_token": "x", "telegram_bot_username": "scratch_topics_bot",
           "allowed_users": "111", "topics_enabled": True, "topics_mode": "group",
           "topics_chat_id": "-1001234567890", "topics_general": "scratch", "topics_auto": True,
           "topics_auto_announce": True, "topics_deleted": "trash", "topics_trash_days": 30,
           "respond_mode": "mention", "name_aliases": ["MAVIX", "مافيكس"]}
plan = {"enabled": True, "mode": "group", "chat_id": "-1001234567890",
        "projects": [{"slug": "scratch", "name": "SCRATCH", "path": ".", "enabled": True}], "path": "PROJECTS"}
try:
    env = h.render_env(cfg, channel, plan)
except Exception as e:
    print(json.dumps({"ok": False, "error": str(e)})); sys.exit(0)
print(json.dumps({"ok": True, "env": env}))
`;
  const r = spawnSync("python3", ["-c", script], { encoding: "utf8", env: Object.assign({}, process.env, { JOYA_DATA_DIR: TMP }) });
  try {
    return JSON.parse((r.stdout || "").trim().split("\n").pop());
  } catch (e) {
    return { ok: false, error: r.stderr };
  }
}

const keys = {
  ENABLE_PROJECT_THREADS: "true",
  PROJECT_THREADS_MODE: "group",
  PROJECT_THREADS_CHAT_ID: "-1001234567890",
  PROJECT_THREADS_GENERAL_PROJECT: "scratch",
  GROUP_RESPOND_MODE: "mention",
  BOT_NAME_ALIASES: "MAVIX,مافيكس",
  PROJECT_THREADS_AUTO_MAP: "true",
  PROJECT_THREADS_AUTO_ANNOUNCE: "true",
  PROJECT_THREADS_DELETED_TOPICS: "trash",
  PROJECT_THREADS_TRASH_DAYS: "30",
};
const h = helperEnv();
const fromHelper = {};
if (h.ok) {
  for (const line of h.env.split("\n")) {
    const i = line.indexOf("=");
    if (i > 0 && !line.startsWith("#")) fromHelper[line.slice(0, i)] = line.slice(i + 1);
  }
  console.log("agent.env: rendered by joya-helper");
  for (const k of Object.keys(keys)) {
    check("helper writes " + k + "=" + keys[k], fromHelper[k] === keys[k], k + "=" + fromHelper[k]);
  }
} else {
  console.log("agent.env: hand-written (this helper does not render the options)");
}

const env = Object.assign({}, keys, {
  USE_SDK: "true",
  AGENTIC_MODE: "true",
  ENABLE_TOKEN_AUTH: "false",
  TELEGRAM_BOT_TOKEN: "123456789:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  TELEGRAM_BOT_USERNAME: "scratch_topics_bot",
  APPROVED_DIRECTORY: vault,
  ALLOWED_USERS: "111",
  DATABASE_URL: "sqlite:///" + path.join(agent, "data", "bot.db"),
  PROJECTS_CONFIG_PATH: path.join(agent, "projects.yaml"),
  PROJECT_THREADS_SYNC_ACTION_INTERVAL_SECONDS: "0",
  PROJECT_THREADS_PROBE_INTERVAL_SECONDS: "1",
  ENABLE_MCP: "false",
  ENABLE_STREAM_DRAFTS: "false",
  VERBOSE_LEVEL: "0",
});
if (h.ok) {
  for (const k of Object.keys(keys)) env[k] = fromHelper[k];
}
const envFile = path.join(TMP, "agent.env");
fs.writeFileSync(envFile, Object.entries(env).map(([k, v]) => k + "=" + v).join("\n") + "\n");
const caseFile = path.join(TMP, "case.json");
const autoFile = path.join(agent, "projects.auto.json");
fs.writeFileSync(caseFile, JSON.stringify({ env: envFile, vault, auto_file: autoFile, seconds: 45 }));

console.log("the real runtime, fake Telegram, fake Claude");
const r = spawnSync(VENV_PY, ["-B", path.join(__dirname, "topics-respond-check.py"), copy, caseFile], {
  encoding: "utf8",
  cwd: copy,
  timeout: 120000,
  env: Object.assign({}, process.env, { HOME: TMP, PYTHONDONTWRITEBYTECODE: "1" }),
});
let res = {};
try {
  res = JSON.parse((r.stdout || "").trim().split("\n").pop());
} catch (e) {
  check("the check printed its result", false, (r.stdout || "").slice(-600) + (r.stderr || "").slice(-600));
}
if (res.sent) {
  const by = (step) => res.sent.filter((s) => s.step === step);
  const asked = (step) => res.asked.filter((a) => a.step === step);
  check("all five updates were delivered", res.steps_delivered === 5, res.steps_delivered);
  check("General, not addressed: nothing sent, no Claude call", by("general-unaddressed").length === 0 && asked("general-unaddressed").length === 0, JSON.stringify(by("general-unaddressed")));
  check("General, @mentioned: answered", by("general-mention").some((s) => /FAKE-ANSWER hello general/.test(s.text)), JSON.stringify(by("general-mention")));
  const g = asked("general-mention")[0] || {};
  check("General: Claude ran in the General project's folder (the vault)", g.cwd === fs.realpathSync(vault), g.cwd);
  check("General: the @mention was stripped from the prompt", g.prompt === "hello general", g.prompt);
  check("General: a session of its own (fresh, not another topic's)", g.force_new === true, JSON.stringify(g));
  check("new topic: one line naming its folder", by("topic-created").length === 1 && by("topic-created")[0].text === "Linked to folder topics/client-x" && by("topic-created")[0].thread === "300", JSON.stringify(by("topic-created")));
  check("new topic: no Claude call for the creation", asked("topic-created").length === 0);
  const t = asked("topic-name")[0] || {};
  check("new topic, named: answered in the topic", by("topic-name").some((s) => /FAKE-ANSWER list the files/.test(s.text) && s.thread === "300"), JSON.stringify(by("topic-name")));
  check("new topic: Claude ran in topics/client-x", t.cwd === path.join(fs.realpathSync(vault), "topics", "client-x"), t.cwd);
  check("new topic: the name was stripped from the prompt", t.prompt === "list the files", t.prompt);
  check("new topic, not addressed: nothing sent, no Claude call", by("topic-unaddressed").length === 0 && asked("topic-unaddressed").length === 0, JSON.stringify(by("topic-unaddressed")));
  check("deleted topic: probed with editForumTopic", (res.probes || []).includes(300));
  const trash = (res.auto && res.auto.trash) || [];
  check("deleted topic: folder moved to .trash/topics", trash.length === 1 && trash[0].trash_path.startsWith(".trash/topics/client-x-") && fs.existsSync(path.join(vault, trash[0].trash_path)), JSON.stringify(res.auto));
  check("deleted topic: gone from the auto projects and from topics/", res.auto && res.auto.projects.length === 0 && !fs.existsSync(path.join(vault, "topics", "client-x")));
  check("deleted topic: not before the second check (probe every 1 s)", res.trash_after_s >= 0.9, res.trash_after_s);
  check("bot exited cleanly", res.code === 0, res.code + "\n" + (res.log_tail || []).join("\n"));
}

/* Defaults: the same runtime with none of the options behaves as before. */
console.log("defaults: no options");
const plain = Object.assign({}, env);
for (const k of Object.keys(keys)) if (!["ENABLE_PROJECT_THREADS", "PROJECT_THREADS_MODE", "PROJECT_THREADS_CHAT_ID"].includes(k)) delete plain[k];
const plainFile = path.join(TMP, "plain.env");
fs.writeFileSync(plainFile, Object.entries(plain).map(([k, v]) => k + "=" + v).join("\n") + "\n");
const cfg = spawnSync(VENV_PY, ["-B", "-c", `
import os, sys, json
sys.path.insert(0, ${JSON.stringify(copy)})
for line in open(${JSON.stringify(plainFile)}, encoding="utf-8"):
    k, _, v = line.rstrip("\\n").partition("=")
    if k: os.environ[k] = v
from src.config import load_config
s = load_config()
print(json.dumps({"respond": s.group_respond_mode, "general": s.project_threads_general_project,
                  "auto": s.project_threads_auto_map, "aliases": s.bot_name_alias_list}))
`], { encoding: "utf8", cwd: TMP, env: Object.assign({}, process.env, { HOME: TMP, PYTHONDONTWRITEBYTECODE: "1" }) });
let d = {};
try {
  d = JSON.parse((cfg.stdout || "").trim().split("\n").pop());
} catch (e) {
  d = { error: cfg.stderr };
}
check("no keys: respond to every message, General refused, no auto folders", d.respond === "all" && d.general === null && d.auto === false && Array.isArray(d.aliases) && d.aliases.length === 0, JSON.stringify(d));

fs.rmSync(TMP, { recursive: true, force: true });
console.log("\n" + passed + " passed, " + failed + " failed");
process.exit(failed ? 1 : 0);
