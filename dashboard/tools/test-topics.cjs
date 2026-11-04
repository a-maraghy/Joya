#!/usr/bin/env node
"use strict";
/**
 * Telegram Topics for agent channels.
 *
 *   node dashboard/tools/test-topics.cjs
 *
 * 1. lib/topics.js: reading the channel form, the checks worth a sentence.
 * 2. deploy/joya-helper, loaded as a Python module with its agent and channel
 *    roots pointed at a temp fixture, systemctl/journalctl faked and Telegram
 *    faked: channel-update refuses what the runtime would refuse, writes the
 *    projects file and PROJECTS_CONFIG_PATH together, removes them together,
 *    checks the bot came up and puts the old files back when it did not.
 * 3. The REAL agent runtime (when /opt/joya-agents/runtime is installed): a
 *    scratch copy of its src/ run by its own venv loads the helper's projects
 *    file and agent.env through load_project_registry() and load_config(),
 *    then starts the bot for real against a fake Telegram Bot API on
 *    127.0.0.1 (fake token; nothing leaves the machine) -- once with a forum
 *    group, once with an ordinary group -- and the helper's start check reads
 *    the runtime's own log of both.
 * 4. The channel page's Topics card.
 *
 * Nothing on the machine is changed: no agent, unit or file outside the temp
 * directory is touched, and the installed runtime is only read.
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const HELPER = path.join(ROOT, "deploy", "joya-helper");
const RUNTIME = process.env.JOYA_RUNTIME_DIR || "/opt/joya-agents/runtime";
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "topics-test-"));
process.env.JOYA_DATA_DIR = process.env.JOYA_DATA_DIR || path.join(TMP, "data");
fs.mkdirSync(process.env.JOYA_DATA_DIR, { recursive: true });

let failed = 0;
let passed = 0;
function check(name, cond, detail) {
  if (cond) {
    passed++;
    console.log("  ok   " + name);
  } else {
    failed++;
    console.log("  FAIL " + name + (detail !== undefined ? "\n       " + String(detail).slice(0, 600) : ""));
  }
}

/* ------------------------------------------------------- 1. lib/topics --- */

console.log("lib/topics: the form");
const topics = require(path.join(ROOT, "lib", "topics"));
{
  const t = topics.parseTopicsForm({
    topics_enabled: "1",
    topics_mode: "group",
    topics_chat_id: " -1001234567890 ",
    tp_table: "1",
    tp_name: ["Client work (EU)", "", "Notes"],
    tp_slug: ["", "", "notes"],
    tp_path: ["clients/eu", "", ""],
  });
  check("blank rows are dropped", t.topics_projects.length === 2, JSON.stringify(t.topics_projects));
  check("a blank short name is made from the name", t.topics_projects[0].slug === "client-work-eu", t.topics_projects[0].slug);
  check("a blank folder is the agent's own folder", t.topics_projects[1].path === ".");
  check("chat id trimmed", t.topics_chat_id === "-1001234567890");
  check("no complaint about a good form", topics.checkTopics(t).length === 0, topics.checkTopics(t).join(" | "));
  check("payload carries the list when the table was on the form", Array.isArray(topics.topicsPayload(t).topics_projects));
  const single = topics.parseTopicsForm({ tp_table: "1", tp_name: "Only", tp_slug: "", tp_path: "." });
  check("a single row arrives as a string, not an array", single.topics_projects.length === 1 && single.topics_projects[0].slug === "only");
  const noTable = topics.parseTopicsForm({ topics_enabled: "1", topics_chat_id: "-1001234567890" });
  check("no table on the form (create page): the list is left to the helper", !("topics_projects" in topics.topicsPayload(noTable)));
  check("unknown mode falls back to group", topics.parseTopicsForm({ topics_mode: "x" }).topics_mode === "group");
}
{
  const bad = (body) => topics.checkTopics(topics.parseTopicsForm(Object.assign({ tp_table: "1" }, body)));
  const e1 = bad({ topics_enabled: "1", topics_mode: "group", topics_chat_id: "-5597160241" });
  check("an ordinary group id is refused, with the -100 explanation", e1.length === 1 && /starts with -100/.test(e1[0]), e1.join(" | "));
  check("group mode with no chat id is refused", bad({ topics_enabled: "1", topics_mode: "group" }).length === 1);
  check("private mode needs no chat id", bad({ topics_enabled: "1", topics_mode: "private" }).length === 0);
  check("topics off: the chat id is not checked", bad({ topics_chat_id: "-5597160241" }).length === 0);
  check("absolute folder refused", /inside the agent's folder/.test(bad({ tp_name: "A", tp_path: "/etc" }).join(" ")));
  check("'..' refused", /climb out/.test(bad({ tp_name: "A", tp_path: "a/../../x" }).join(" ")));
  check("a row with no name refused", /needs a name/.test(bad({ tp_name: "", tp_slug: "x", tp_path: "x" }).join(" ")));
  check("bad short name refused", /short name/.test(bad({ tp_name: "A", tp_slug: "Bad Slug", tp_path: "." }).join(" ")));
  check("duplicate folders refused", /same|share the folder/.test(bad({ tp_name: ["A", "B"], tp_slug: ["a", "b"], tp_path: ["x", "x"] }).join(" ")));
  check("21 projects refused", /At most 20/.test(bad({ tp_name: Array.from({ length: 21 }, (_, i) => "P" + i), tp_path: Array.from({ length: 21 }, (_, i) => "p" + i) }).join(" ")));
  check("describe: off", topics.describe({}) === "off");
  check("describe: group", topics.describe({ topics_enabled: true, topics_chat_id: "-1001", topics_projects: [{}, {}] }) === "on · group -1001 · 2 projects");
  check("describe: private, default list", topics.describe({ topics_enabled: true, topics_mode: "private" }) === "on · private chat · 1 project");
}
console.log("lib/topics: General, new-topic folders, trash, respond in groups");
{
  const t = topics.parseTopicsForm({
    topics_enabled: "1", topics_mode: "group", topics_chat_id: "-1001234567890", tp_table: "1",
    tp_name: ["Main", "Client X", "Old"], tp_slug: ["main", "client-x", "old"], tp_path: [".", "topics/client-x", "notes"],
    tp_on: ["1", "1", "0"], tp_auto: ["0", "1", "0"],
    topics_general: "main", topics_auto: "1", topics_deleted: "keep", topics_trash_days: "7",
  });
  check("rows carry on/off and the auto flag", t.topics_projects[1].auto === true && !("auto" in t.topics_projects[0]) && t.topics_projects[2].enabled === false && t.topics_projects[0].enabled === true, JSON.stringify(t.topics_projects));
  check("the new options are read", t.topics_general === "main" && t.topics_auto === true && t.topics_auto_announce === false && t.topics_deleted === "keep" && t.topics_trash_days === 7);
  check("a good form has no complaint", topics.checkTopics(t).length === 0, topics.checkTopics(t).join(" | "));
  const pl = topics.topicsPayload(t);
  check("payload carries the new options with the table", pl.topics_general === "main" && pl.topics_auto === true && pl.topics_deleted === "keep" && pl.topics_trash_days === 7 && pl.topics_auto_announce === false);
  check("no table (create page): no new options in the payload", !("topics_general" in topics.topicsPayload(topics.parseTopicsForm({ topics_enabled: "1" }))));
  const d = topics.parseTopicsForm({ tp_table: "1", tp_name: "A", tp_path: "." });
  check("defaults: General off, auto off, trash 30 days, rows on", d.topics_general === "" && d.topics_auto === false && d.topics_deleted === "trash" && d.topics_trash_days === 30 && d.topics_projects[0].enabled === true);
  check("General 'off' is off", topics.parseTopicsForm({ topics_general: "off" }).topics_general === "");
  const bad = (body) => topics.checkTopics(topics.parseTopicsForm(Object.assign({ tp_table: "1", topics_enabled: "1", topics_chat_id: "-1001234567890" }, body)));
  const rows = { tp_name: ["Main", "Client X", "Old"], tp_slug: ["main", "client-x", "old"], tp_path: [".", "topics/client-x", "notes"], tp_on: ["1", "1", "0"], tp_auto: ["0", "1", "0"] };
  check("General to a project not in the list refused", /not one of the projects/.test(bad(Object.assign({ topics_general: "nope" }, rows)).join(" ")));
  check("General to a folder made for a new topic refused", /not to a folder made for a new topic/.test(bad(Object.assign({ topics_general: "client-x" }, rows)).join(" ")));
  check("General to a project switched off refused", /switched off/.test(bad(Object.assign({ topics_general: "old" }, rows)).join(" ")));
  check("General is not checked in private mode", bad(Object.assign({ topics_general: "nope", topics_mode: "private" }, rows)).length === 0);
  check("trash days out of range refused", /0 to 3650 days/.test(bad({ topics_trash_days: "3651" }).join(" ")) && /0 to 3650/.test(bad({ topics_trash_days: "-1" }).join(" ")) && /0 to 3650/.test(bad({ topics_trash_days: "x" }).join(" ")));
  check("trash days 0 and 3650 accepted", bad({ topics_trash_days: "0" }).length === 0 && bad({ topics_trash_days: "3650" }).length === 0);
  const many = Array.from({ length: 20 }, (_, i) => "p" + i);
  check("the 20-project cap counts the list's own rows, not auto rows",
    bad({ tp_name: many.concat(["A1", "A2"]), tp_slug: many.concat(["a1", "a2"]), tp_path: many.concat(["topics/a1", "topics/a2"]), tp_auto: many.map(() => "0").concat(["1", "1"]) }).length === 0 &&
    /At most 20/.test(bad({ tp_name: many.concat(["x"]), tp_path: many.concat(["x"]) }).join(" ")));
  check("describe: new topics get folders", topics.describe({ topics_enabled: true, topics_chat_id: "-1001", topics_auto: true }) === "on · group -1001 · 1 project · new topics get folders");

  const r = topics.parseRespondForm({ respond_form: "1", respond_mode: "mention", name_aliases: " Mavix \r\nmavix\n\nMax " });
  check("respond: mode and names (one per line, trimmed, de-duplicated ignoring case)", r.respond_mode === "mention" && JSON.stringify(r.name_aliases) === JSON.stringify(["Mavix", "Max"]), JSON.stringify(r));
  check("respond: payload", JSON.stringify(topics.respondPayload(r)) === JSON.stringify({ respond_mode: "mention", name_aliases: ["Mavix", "Max"] }));
  check("respond: no respond fields on the form, no payload", JSON.stringify(topics.respondPayload(topics.parseRespondForm({}))) === "{}");
  check("respond: a good form has no complaint", topics.checkRespond(r).length === 0);
  const rb = (body) => topics.checkRespond(topics.parseRespondForm(Object.assign({ respond_form: "1" }, body)));
  check("respond: unknown mode refused", rb({ respond_mode: "sometimes" }).length === 1);
  check("respond: a name with a comma refused", /contains a comma/.test(rb({ name_aliases: "Mavix, Max" }).join(" ")));
  check("respond: a name over 40 characters refused", /longer than 40/.test(rb({ name_aliases: "x".repeat(41) }).join(" ")));
  check("respond: 11 names refused", /At most 10 names/.test(rb({ name_aliases: Array.from({ length: 11 }, (_, i) => "n" + i).join("\n") }).join(" ")));
  check("describeRespond", topics.describeRespond({}) === "every message" && topics.describeRespond({ respond_mode: "mention" }) === "only when asked");
}

/* ------------------------------------------------------------ 2. helper --- */

const AGENT = "scratch-bot";
const CHANNEL = "scratch-tg";
const OUTSIDE = path.join(TMP, "outside");
fs.mkdirSync(OUTSIDE, { recursive: true });

const driver = String.raw`
import contextlib, importlib.machinery, importlib.util, io, json, os, shutil, stat, subprocess, sys
spec = importlib.util.spec_from_loader("joya_helper", importlib.machinery.SourceFileLoader("joya_helper", sys.argv[1]))
H = importlib.util.module_from_spec(spec); spec.loader.exec_module(H)
tmp, AGENT, CHANNEL, OUTSIDE = sys.argv[2], sys.argv[3], sys.argv[4], sys.argv[5]
H.AGENTS_DIR = os.path.join(tmp, "agents"); H.CHANNELS_DIR = os.path.join(tmp, "channels")
H.ARCHIVE_DIR = os.path.join(tmp, "archived"); H.TEMPLATE_DIR = os.path.join(tmp, "template")
H.agent_ids = lambda: (os.getuid(), os.getgid())
H._obsidian_vaults = lambda *a, **k: False
ROOT_USER = os.getuid() == 0
if not ROOT_USER:
    _chown = os.chown
    H.os.chown = lambda p, u, g: None if u == 0 else _chown(p, u, g)
AUDIT = []
H.audit = lambda action, detail: AUDIT.append([action, detail])

# --- fakes: systemctl / journalctl, and Telegram ---------------------------
STATE = {"journal": [], "calls": [], "props": {"ActiveState": "active", "SubState": "running"}}
def fake_run(argv, **kw):
    STATE["calls"].append(list(argv))
    out = ""
    if argv[0] == "journalctl":
        seq = STATE["journal"]
        out = seq.pop(0) if len(seq) > 1 else (seq[0] if seq else "")
    elif argv[:2] == ["systemctl", "show"]:
        out = "\n".join(k + "=" + v for k, v in STATE["props"].items())
    elif argv[:2] == ["systemctl", "is-active"]:
        out = "active"
    elif argv[:2] == ["systemctl", "is-enabled"]:
        out = "enabled"
    return subprocess.CompletedProcess(argv, 0, out, "")
H.run = fake_run
H.time.sleep = lambda s: None
TG = {"mode": "forum", "calls": 0}
def fake_tg(token, method, params=None):
    TG["calls"] += 1
    if TG["mode"] == "down":
        raise H.TelegramUnreachable("URLError")
    if method == "getMe":
        return {"id": 4242, "is_bot": True, "username": "scratch_bot"}
    if method == "getChat":
        if TG["mode"] == "missing":
            raise H.TelegramRefused("Bad Request: chat not found")
        return {"id": int(params["chat_id"]), "type": "supergroup", "is_forum": TG["mode"] != "noforum"}
    if method == "getChatMember":
        return {"status": "member" if TG["mode"] == "notadmin" else "administrator", "can_manage_topics": True}
    return True
H.telegram_call = fake_tg

UNIT = H.unit_name(AGENT)
STARTED = "Started " + UNIT + " - JOYA agent " + AGENT + " (Telegram bridge to Claude Code).\n"
OLD_STOP = ('{"error": "Old process noise", "event": "Error running bot", "level": "error"}\n')
def ev(event, level="info", **kw):
    d = dict(kw); d.update({"event": event, "logger": "src.main", "level": level})
    return json.dumps(d) + "\n"
J_OK = OLD_STOP + STARTED + ev("Configuration loaded successfully") + ev("Project thread startup sync complete", created=1, reused=0, renamed=0, failed=0, deactivated=0) + ev("Starting bot", mode="polling")
J_OK_PLAIN = STARTED + ev("Starting bot", mode="polling")
J_CRASH = STARTED + ev("Configuration error", "error", error="Configuration loading failed: 1 validation error for Settings\n  Value error, projects_config_path required when enable_project_threads is True [type=value_error, input_value={'telegram_bot_token': '123456789:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'}, input_type=dict]") + UNIT + ": Main process exited, code=exited, status=1/FAILURE\n"
J_NOTOPICS = STARTED + ev("Failed to sync project topic", "error", error="Not enough rights to create a topic") + ev("Project thread startup sync complete", created=0, reused=0, renamed=0, failed=1, deactivated=0) + ev("Starting bot", mode="polling")

# --- fixture: one agent with a vault, one Telegram channel ------------------
os.makedirs(H.TEMPLATE_DIR, exist_ok=True)
open(os.path.join(H.TEMPLATE_DIR, "CLAUDE.md"), "w").write("{{AGENT_NAME}}\n")
d = H.agent_dir(AGENT); vault = os.path.join(d, "vault")
for sub in ("notes", "clients/eu/deep/deeper", ".obsidian"):
    os.makedirs(os.path.join(vault, sub), exist_ok=True)
os.symlink(OUTSIDE, os.path.join(vault, "project"))
json.dump({"slug": AGENT, "name": "Scratch Bot", "model": "claude-opus-5", "effort": "medium", "max_turns": 10,
           "timeout_seconds": 600, "verbose_level": 1, "role": "", "project_dir": "", "addons": [], "addon_env": {}},
          open(os.path.join(d, "agent.json"), "w"))
os.makedirs(os.path.join(H.CHANNELS_DIR, CHANNEL), exist_ok=True)
json.dump({"slug": CHANNEL, "name": "Scratch", "type": "telegram", "agent": AGENT, "allowed_users": "12345678",
           "telegram_bot_username": "scratch_bot", "topics_enabled": False, "topics_chat_id": "", "addons": [], "addon_env": {}},
          open(os.path.join(H.CHANNELS_DIR, CHANNEL, "channel.json"), "w"))
open(os.path.join(H.CHANNELS_DIR, CHANNEL, "channel.env"), "w").write("CHANNEL_TOKEN=123456789:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA\n")
H.reconfigure_agent(AGENT)   # the agent as it runs today: Topics off

def call(fn, payload=None, args=None):
    sys.stdin = io.TextIOWrapper(io.BytesIO(json.dumps(payload or {}).encode()))
    buf = io.StringIO()
    try:
        with contextlib.redirect_stdout(buf):
            fn(args or [])
    except SystemExit:
        pass
    lines = buf.getvalue().strip().splitlines()
    return json.loads(lines[-1]) if lines else {"ok": False, "error": "no output"}

ENV = os.path.join(d, "agent.env"); PROJ = os.path.join(d, "projects.yaml")
def env_keys():
    out = {}
    for l in open(ENV):
        k, _, v = l.rstrip("\n").partition("=")
        if k in ("ENABLE_PROJECT_THREADS", "PROJECT_THREADS_MODE", "PROJECT_THREADS_CHAT_ID", "PROJECTS_CONFIG_PATH"):
            out[k] = v
    return out
def proj():
    if not os.path.exists(PROJ): return None
    st = os.stat(PROJ)
    return {"text": open(PROJ).read(), "mode": oct(st.st_mode & 0o777), "uid": st.st_uid}
def chan():
    return json.load(open(os.path.join(H.CHANNELS_DIR, CHANNEL, "channel.json")))
def restarts():
    return sum(1 for c in STATE["calls"] if c[:2] == ["systemctl", "restart"])

R = {"root": ROOT_USER, "vault": os.path.realpath(vault), "agent_dir": d}
R["start_env"] = env_keys(); R["start_proj"] = proj()
before_env = open(ENV, "rb").read()

def upd(**kw):
    p = {"slug": CHANNEL}; p.update(kw); return call(H.cmd_channel_update, p)

# Refusals: nothing written, nothing restarted.
STATE["calls"].clear()
R["bad_group_id"] = upd(topics_enabled=True, topics_chat_id="-5597160241")
R["no_chat_id"] = upd(topics_enabled=True, topics_chat_id="")
R["link_out"] = upd(topics_enabled=True, topics_chat_id="-1001234567890", topics_projects=[{"slug": "p", "name": "P", "path": "project"}])
R["missing_dir"] = upd(topics_enabled=True, topics_chat_id="-1001234567890", topics_projects=[{"slug": "p", "name": "P", "path": "nope"}])
R["abs_path"] = upd(topics_enabled=True, topics_chat_id="-1001234567890", topics_projects=[{"slug": "p", "name": "P", "path": "/etc"}])
R["dotdot"] = upd(topics_enabled=True, topics_chat_id="-1001234567890", topics_projects=[{"slug": "p", "name": "P", "path": "notes/../../x"}])
R["dup_slug"] = upd(topics_enabled=True, topics_chat_id="-1001234567890", topics_projects=[{"slug": "p", "name": "P", "path": "notes"}, {"slug": "p", "name": "Q", "path": "clients"}])
R["dup_name"] = upd(topics_enabled=True, topics_chat_id="-1001234567890", topics_projects=[{"slug": "p", "name": "P", "path": "notes"}, {"slug": "q", "name": "P", "path": "clients"}])
R["dup_path"] = upd(topics_enabled=True, topics_chat_id="-1001234567890", topics_projects=[{"slug": "p", "name": "P", "path": "notes"}, {"slug": "q", "name": "Q", "path": "./notes"}])
R["all_off"] = upd(topics_enabled=True, topics_chat_id="-1001234567890", topics_projects=[{"slug": "p", "name": "P", "path": "notes", "enabled": False}])
R["bad_slug"] = upd(topics_enabled=True, topics_chat_id="-1001234567890", topics_projects=[{"slug": "Bad Slug", "name": "P", "path": "notes"}])
R["bad_name"] = upd(topics_enabled=True, topics_chat_id="-1001234567890", topics_projects=[{"slug": "p", "name": "say \"hi\"", "path": "notes"}])
R["bad_mode"] = upd(topics_enabled=True, topics_mode="forum", topics_chat_id="-1001234567890")
R["too_many"] = upd(topics_enabled=True, topics_chat_id="-1001234567890", topics_projects=[{"slug": "p%d" % i, "name": "P%d" % i, "path": "."} for i in range(21)])
TG["mode"] = "noforum"; R["tg_noforum"] = upd(topics_enabled=True, topics_chat_id="-1001234567890")
TG["mode"] = "notadmin"; R["tg_notadmin"] = upd(topics_enabled=True, topics_chat_id="-1001234567890")
TG["mode"] = "missing"; R["tg_missing"] = upd(topics_enabled=True, topics_chat_id="-1001234567890")
R["refusals_untouched"] = open(ENV, "rb").read() == before_env and proj() is None and not chan().get("topics_enabled")
R["refusals_no_restart"] = restarts() == 0

# Turn Topics on, default projects list, Telegram says yes, the bot comes up.
TG["mode"] = "forum"; STATE["journal"] = [J_OK]; STATE["calls"].clear()
R["on_default"] = upd(topics_enabled=True, topics_chat_id="-1001234567890")
R["on_default_env"] = env_keys(); R["on_default_proj"] = proj(); R["on_default_chan"] = chan()
R["on_default_tg_calls"] = TG["calls"]

# Saving again without touching Topics does not ask Telegram again.
TG["calls"] = 0; STATE["journal"] = [J_OK]
R["resave"] = upd(name="Scratch renamed")
R["resave_tg_calls"] = TG["calls"]

# Telegram unreachable: the save goes ahead (the start check still guards it).
TG["mode"] = "down"; STATE["journal"] = [J_OK]
R["tg_down"] = upd(topics_chat_id="-1009876543210")
TG["mode"] = "forum"

# Custom list, mode private.
STATE["journal"] = [J_OK_PLAIN]
R["custom"] = upd(topics_mode="private", topics_projects=[
    {"slug": "scratch-bot", "name": "Scratch Bot \u00e9", "path": "."},
    {"slug": "client-eu", "name": "Client EU", "path": "clients/eu/"},
    {"slug": "notes", "name": "Notes", "path": "notes", "enabled": False}])
R["custom_env"] = env_keys(); R["custom_proj"] = proj(); R["custom_chan"] = chan()
shutil.copy(PROJ, os.path.join(tmp, "custom-projects.yaml")); shutil.copy(ENV, os.path.join(tmp, "custom-agent.env"))

# Back to group mode with the default list, for the runtime to start on.
STATE["journal"] = [J_OK]
R["group2"] = upd(topics_mode="group", topics_chat_id="-1001234567890", topics_projects=[
    {"slug": "scratch-bot", "name": "Scratch Bot", "path": "."}, {"slug": "notes", "name": "Notes", "path": "notes"}])
shutil.copy(PROJ, os.path.join(tmp, "group-projects.yaml")); shutil.copy(ENV, os.path.join(tmp, "group-agent.env"))

# The safety net: the bot crashes with the new settings -> everything back.
good_env, good_proj, good_chan = open(ENV, "rb").read(), open(PROJ, "rb").read(), chan()
STATE["journal"] = [J_CRASH, J_OK]; STATE["calls"].clear()
R["crash"] = upd(topics_chat_id="-1005555555555")
R["crash_env_restored"] = open(ENV, "rb").read() == good_env
R["crash_proj_restored"] = open(PROJ, "rb").read() == good_proj
R["crash_chan_restored"] = chan().get("topics_chat_id") == good_chan.get("topics_chat_id")
R["crash_restarts"] = restarts()
R["crash_audit"] = AUDIT[-1]

# Starts, but no topic could be made: also reverted.
STATE["journal"] = [J_NOTOPICS, J_OK]
R["notopics"] = upd(topics_chat_id="-1006666666666")
R["notopics_chan"] = chan().get("topics_chat_id")

# The previous settings fail too (and had Topics on): Topics are forced off.
STATE["journal"] = [J_CRASH, J_CRASH, J_OK_PLAIN]
R["double"] = upd(topics_chat_id="-1007777777777")
R["double_chan"] = chan(); R["double_env"] = env_keys(); R["double_proj"] = proj()

# On again, then off: both keys and the file go together.
STATE["journal"] = [J_OK]
R["on_again"] = upd(topics_enabled=True, topics_chat_id="-1001234567890")
R["on_again_env"] = env_keys()
STATE["journal"] = [J_OK_PLAIN]
R["off"] = upd(topics_enabled=False)
R["off_env"] = env_keys(); R["off_proj"] = proj(); R["off_chan"] = chan()

# Topics on, then the folder disappears and the agent is saved: Topics are left
# off for the agent (the bot would refuse to start), and the save says why.
STATE["journal"] = [J_OK]
upd(topics_enabled=True, topics_chat_id="-1001234567890", topics_projects=[{"slug": "deep", "name": "Deep", "path": "clients/eu/deep"}])
shutil.rmtree(os.path.join(vault, "clients", "eu", "deep"))
R["agent_update"] = call(H.cmd_agent_update, {"slug": AGENT, "name": "Scratch Bot"})
R["agent_update_env"] = env_keys(); R["agent_update_proj"] = proj()
os.makedirs(os.path.join(vault, "clients", "eu", "deep"))

# Add-ons may not set the topic keys.
R["addon_key"] = upd(addon_env={"PROJECTS_CONFIG_PATH": "/etc/passwd"})

# The folder list for the panel.
R["folders"] = call(H.cmd_channel_topics_folders, None, [CHANNEL])

# The start check on its own.
STATE["journal"] = [STARTED]; STATE["props"] = {"ActiveState": "failed", "SubState": "failed"}
R["chk_failed_unit"] = H.agent_start_check(AGENT, 0, timeout=5)
STATE["journal"] = [STARTED]; STATE["props"] = {"ActiveState": "active", "SubState": "running"}
clock = iter(range(0, 1000, 10))
R["chk_slow"] = H.agent_start_check(AGENT, 0, timeout=25, clock=lambda: next(clock))
STATE["journal"] = [OLD_STOP]
clock = iter(range(0, 1000, 10))
R["chk_old_only"] = H.agent_start_check(AGENT, 0, timeout=25, clock=lambda: next(clock))
R["plain_private"] = H.plain_bot_error("Private chat topics are not enabled for this bot chat.")
R["redact"] = H.redact_tokens("x 123456789:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA y")
# ===================== General topic, respond-when-asked, auto folders ========
OLD_HELPER = sys.argv[6] if len(sys.argv) > 6 else ""
def env_all():
    out = {}
    for l in open(ENV):
        if l.startswith("#") or "=" not in l: continue
        k, _, v = l.rstrip("\n").partition("="); out[k] = v
    return out
NEW_KEYS = ("GROUP_RESPOND_MODE", "BOT_NAME_ALIASES", "PROJECT_THREADS_GENERAL_PROJECT", "PROJECT_THREADS_AUTO_MAP",
            "PROJECT_THREADS_AUTO_ANNOUNCE", "PROJECT_THREADS_DELETED_TOPICS", "PROJECT_THREADS_TRASH_DAYS")
def new_keys():
    e = env_all(); return {k: e[k] for k in NEW_KEYS if k in e}

# Defaults unchanged: an existing channel.json (no new fields) renders what the
# eb5e457 helper rendered, plus only the new lines.
if OLD_HELPER:
    ospec = importlib.util.spec_from_loader("joya_helper_old", importlib.machinery.SourceFileLoader("joya_helper_old", OLD_HELPER))
    O = importlib.util.module_from_spec(ospec); ospec.loader.exec_module(O)
    O.AGENTS_DIR, O.CHANNELS_DIR, O.TEMPLATE_DIR = H.AGENTS_DIR, H.CHANNELS_DIR, H.TEMPLATE_DIR
    acfg = H.validate_config(H.read_agent_json(AGENT), creating=False)
    legacy = {"slug": CHANNEL, "name": "Scratch", "type": "telegram", "agent": AGENT, "allowed_users": "12345678",
              "telegram_bot_username": "scratch_bot", "topics_enabled": False, "topics_chat_id": "", "addons": [],
              "addon_env": {}, "_token": "123456789:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"}
    def diff(ch):
        old = O.render_env(acfg, ch, O.topic_plan(acfg, ch)).splitlines()
        new = H.render_env(acfg, ch, H.topic_plan(acfg, ch)).splitlines()
        return {"added": sorted(set(new) - set(old)), "removed": sorted(set(old) - set(new))}
    R["legacy_off"] = diff(legacy)
    on = dict(legacy); on.update(topics_enabled=True, topics_chat_id="-1001234567890",
                                 topics_projects=[{"slug": AGENT, "name": "Scratch Bot", "path": ".", "enabled": True}])
    R["legacy_on"] = diff(on)
else:
    R["legacy_off"] = R["legacy_on"] = None

# Respond only when asked: names default to the agent's name.
STATE["journal"] = [J_OK]; STATE["calls"].clear()
R["mention"] = upd(respond_mode="mention")
R["mention_keys"] = new_keys(); R["mention_chan"] = chan()
STATE["journal"] = [J_OK]
R["aliases"] = upd(name_aliases=["Mavix", "mavix", " Max "])
R["aliases_keys"] = new_keys(); R["aliases_chan"] = chan()

# The topic options, rendered.
STATE["journal"] = [J_OK]
R["opts"] = upd(topics_general="deep", topics_auto=True, topics_auto_announce=False, topics_deleted="keep", topics_trash_days=7)
R["opts_keys"] = new_keys()
STATE["journal"] = [J_OK_PLAIN]
R["opts_private"] = upd(topics_mode="private"); R["opts_private_keys"] = new_keys()
STATE["journal"] = [J_OK]
upd(topics_mode="group", topics_chat_id="-1001234567890")

# Refusals: nothing written, nothing restarted.
before = (open(ENV, "rb").read(), open(PROJ, "rb").read(), json.dumps(chan(), sort_keys=True))
STATE["calls"].clear()
os.makedirs(os.path.join(vault, "notes2"), exist_ok=True)
two = [{"slug": "deep", "name": "Deep", "path": "clients/eu/deep"}, {"slug": "off1", "name": "Off one", "path": "notes2", "enabled": False}]
R["r_general_missing"] = upd(topics_general="nope")
R["r_general_off"] = upd(topics_general="off1", topics_projects=two)
R["r_general_badslug"] = upd(topics_general="Bad Slug")
R["r_respond"] = upd(respond_mode="sometimes")
R["r_alias_comma"] = upd(name_aliases=["Mavix, Max"])
R["r_alias_long"] = upd(name_aliases=["x" * 41])
R["r_alias_many"] = upd(name_aliases=["n%d" % i for i in range(11)])
R["r_days_neg"] = upd(topics_trash_days=-1)
R["r_days_big"] = upd(topics_trash_days=3651)
R["r_days_text"] = upd(topics_trash_days="soon")
R["r_deleted"] = upd(topics_deleted="burn")
R["r_addon"] = {k: upd(addon_env={k: "x"}) for k in NEW_KEYS}
R["r_untouched"] = (open(ENV, "rb").read(), open(PROJ, "rb").read(), json.dumps(chan(), sort_keys=True)) == before
R["r_no_restart"] = restarts() == 0

# The safety net for "only when asked" without Topics.
STATE["journal"] = [J_OK_PLAIN]
upd(topics_enabled=False, respond_mode="all", topics_general="")
STATE["calls"].clear()
R["plain_save"] = upd(name="Scratch plain")
R["plain_save_journal"] = sum(1 for c in STATE["calls"] if c[0] == "journalctl")
good_env = open(ENV, "rb").read()
STATE["journal"] = [J_CRASH, J_OK_PLAIN]; STATE["calls"].clear()
R["m_crash"] = upd(respond_mode="mention")
R["m_crash_env_restored"] = open(ENV, "rb").read() == good_env
R["m_crash_chan"] = chan().get("respond_mode"); R["m_crash_restarts"] = restarts()
R["m_crash_audit"] = AUDIT[-1]
STATE["journal"] = [J_OK_PLAIN]
R["m_ok"] = upd(respond_mode="mention"); R["m_ok_keys"] = new_keys()
STATE["journal"] = [J_OK]
upd(topics_enabled=True, topics_chat_id="-1001234567890", respond_mode="all",
    topics_projects=[{"slug": "deep", "name": "Deep", "path": "clients/eu/deep"}])

# --- the auto file ------------------------------------------------------------
AUTOF = os.path.join(d, "projects.auto.json"); LOCKF = os.path.join(d, "projects.auto.json.lock")
for sub in ("topics/client-x", "topics/old", ".trash/topics/gone-20261002T190000Z", ".trash/topics/cx-20261002T190100Z",
            ".trash/topics/dele-20261002T190200Z", ".trash/other/x"):
    os.makedirs(os.path.join(vault, sub), exist_ok=True)
open(os.path.join(vault, ".trash/topics/gone-20261002T190000Z/note.md"), "w").write("kept\n")
open(os.path.join(vault, ".trash/topics/dele-20261002T190200Z/note.md"), "w").write("bye\n")
os.symlink(OUTSIDE, os.path.join(vault, "topics", "linky"))
os.symlink(OUTSIDE, os.path.join(vault, ".trash", "topics", "lnk-20261002T190300Z"))
open(os.path.join(OUTSIDE, "precious.txt"), "w").write("do not delete\n")
def tr(slug, path, **kw):
    e = {"slug": slug, "name": slug.title(), "original_path": "topics/" + slug, "trash_path": path, "thread_id": 90, "trashed_at": "2026-10-02T19:00:00Z"}
    e.update(kw); return e
FIXTURE = {
    "version": 1, "chat_id": -1001234567890, "keep_me": {"x": 1},
    "projects": [
        {"slug": "client-x", "name": "Client X", "path": "topics/client-x", "thread_id": 81, "created_at": "2026-10-02T19:00:00Z", "created_by": 123, "closed": False},
        {"slug": "evil", "name": "Evil", "path": "../outside", "thread_id": 82},
        {"slug": "linky", "name": "Linky", "path": "topics/linky", "thread_id": 83},
        {"slug": "Bad Slug", "name": "Bad", "path": "topics/old", "thread_id": 84},
        {"slug": "deeper", "name": "Deeper", "path": "topics/client-x/sub", "thread_id": 85},
        5,
    ],
    "unlinked": [{"slug": "old", "name": "Old", "path": "topics/old", "since": "2026-10-01T10:00:00Z", "reason": "topic deleted"}],
    "trash": [
        tr("gone", ".trash/topics/gone-20261002T190000Z"),
        tr("client-x", ".trash/topics/cx-20261002T190100Z", name="Client X old"),
        tr("dele", ".trash/topics/dele-20261002T190200Z"),
        tr("lnk", ".trash/topics/lnk-20261002T190300Z"),
        tr("other", ".trash/other/x"),
    ],
}
def put_auto(obj):
    with open(AUTOF, "w") as fh:
        fh.write(obj if isinstance(obj, str) else json.dumps(obj))
put_auto(FIXTURE)
R["auto_folders"] = call(H.cmd_channel_topics_folders, None, [CHANNEL])
put_auto("{not json")
R["auto_malformed"] = call(H.cmd_channel_topics_folders, None, [CHANNEL])
put_auto('{"projects": {"a": 1}}')
R["auto_wrong_shape"] = call(H.cmd_channel_topics_folders, None, [CHANNEL])
os.unlink(AUTOF); os.symlink(os.path.join(OUTSIDE, "precious.txt"), AUTOF)
R["auto_link"] = call(H.cmd_channel_topics_folders, None, [CHANNEL])
os.unlink(AUTOF)
R["auto_none"] = call(H.cmd_channel_topics_folders, None, [CHANNEL])
put_auto(FIXTURE)

# Saving the list: unchanged auto rows stay out of projects.yaml, edited ones go in.
deep = {"slug": "deep", "name": "Deep", "path": "clients/eu/deep"}
cx = {"slug": "client-x", "name": "Client X", "path": "topics/client-x", "auto": True}
STATE["journal"] = [J_OK]
R["fold_same"] = upd(topics_projects=[deep, cx]); R["fold_same_proj"] = proj()["text"]; R["fold_same_chan"] = chan()["topics_projects"]
STATE["journal"] = [J_OK]
R["fold_edit"] = upd(topics_projects=[deep, dict(cx, name="Client X renamed")]); R["fold_edit_proj"] = proj()["text"]; R["fold_edit_chan"] = chan()["topics_projects"]
R["fold_general_auto"] = upd(topics_general="client-x", topics_projects=[deep, dict(cx, name="Client X renamed")])
STATE["journal"] = [J_OK]
R["fold_off"] = upd(topics_projects=[deep, dict(cx, enabled=False)]); R["fold_off_proj"] = proj()["text"]
STATE["journal"] = [J_OK]
R["fold_back"] = upd(topics_projects=[deep, cx, {"slug": "ghost", "name": "Ghost", "path": "topics/ghost", "auto": True}])
R["fold_back_proj"] = proj()["text"]; R["fold_back_chan"] = chan()["topics_projects"]
many = [{"slug": "p%d" % i, "name": "P%d" % i, "path": "p%d" % i} for i in range(20)]
autos = [{"slug": "a%d" % i, "name": "A%d" % i, "path": "topics/a%d" % i, "auto": True} for i in range(5)]
try:
    R["cap_20_plus_auto"] = len(H.parse_topic_projects(many + autos))
except H.TopicError as e:
    R["cap_20_plus_auto"] = str(e)
try:
    H.parse_topic_projects(many + [{"slug": "p20", "name": "P20", "path": "p20"}] + autos); R["cap_21"] = "accepted"
except H.TopicError as e:
    R["cap_21"] = str(e)

# --- the trash: restore and delete, under the lock ---------------------------------
FLOCKS = []
_real_flock = H.fcntl.flock
def spy_flock(fd, op):
    FLOCKS.append(op); return _real_flock(fd, op)
H.fcntl.flock = spy_flock
def trash(*a):
    return call(H.cmd_channel_topics_trash, None, [CHANNEL] + list(a))
def auto_now():
    return json.load(open(AUTOF))
R["t_restore"] = trash("restore", ".trash/topics/gone-20261002T190000Z")
R["t_restore_file"] = open(os.path.join(vault, "topics/gone/note.md")).read() if os.path.exists(os.path.join(vault, "topics/gone/note.md")) else None
R["t_restore_gone_from_trash"] = not os.path.lexists(os.path.join(vault, ".trash/topics/gone-20261002T190000Z"))
R["t_restore_auto"] = auto_now()
st = os.stat(AUTOF); R["t_auto_mode"] = oct(st.st_mode & 0o777)
R["t_flock"] = [op & (H.fcntl.LOCK_EX | H.fcntl.LOCK_UN) for op in FLOCKS]
R["t_taken"] = trash("restore", ".trash/topics/cx-20261002T190100Z")
R["t_taken_exists"] = os.path.isdir(os.path.join(vault, "topics/client-x-2"))
R["t_delete"] = trash("delete", ".trash/topics/dele-20261002T190200Z")
R["t_delete_gone"] = not os.path.lexists(os.path.join(vault, ".trash/topics/dele-20261002T190200Z"))
R["t_delete_auto"] = auto_now()
R["t_link_delete"] = trash("delete", ".trash/topics/lnk-20261002T190300Z")
R["t_link_restore"] = trash("restore", ".trash/topics/lnk-20261002T190300Z")
R["t_outside"] = trash("delete", ".trash/other/x")
R["t_dotdot"] = trash("delete", ".trash/topics/../../../outside")
R["t_topics"] = trash("delete", "topics/client-x")
R["t_unknown"] = trash("delete", ".trash/topics/never-there")
R["t_bad_action"] = trash("burn", ".trash/topics/x")
R["t_outside_safe"] = os.path.exists(os.path.join(OUTSIDE, "precious.txt")) and os.path.isdir(os.path.join(vault, ".trash/other/x"))
put_auto("{broken")
os.makedirs(os.path.join(vault, ".trash/topics/mal-1"), exist_ok=True)
R["t_malformed"] = trash("delete", ".trash/topics/mal-1")
R["t_malformed_kept"] = os.path.isdir(os.path.join(vault, ".trash/topics/mal-1"))
# The lock held by someone else (the runtime): the helper waits, then gives up, changing nothing.
put_auto(FIXTURE)
os.makedirs(os.path.join(vault, ".trash/topics/gone-20261002T190000Z"), exist_ok=True)
holder = subprocess.Popen([sys.executable, "-c", "import fcntl,sys,time; f=open(sys.argv[1],'a'); fcntl.flock(f, fcntl.LOCK_EX); print('held', flush=True); time.sleep(30)", LOCKF], stdout=subprocess.PIPE, text=True)
holder.stdout.readline()
H.AUTO_LOCK_TIMEOUT = 0.6
R["t_busy"] = trash("delete", ".trash/topics/gone-20261002T190000Z")
R["t_busy_untouched"] = os.path.isdir(os.path.join(vault, ".trash/topics/gone-20261002T190000Z")) and auto_now() == FIXTURE
holder.kill(); holder.wait()
H.fcntl.flock = _real_flock
R["t_audit"] = [a for a in AUDIT if a[0] == "channel-topics-trash"]
R["audit"] = AUDIT
print(json.dumps(R))
`;

console.log("helper: channel-update with Topics (fixture under " + TMP + ")");
// The helper as it was before the group options (eb5e457), to prove an existing
// channel renders the same agent.env plus only the new lines.
let OLD_HELPER = "";
{
  const g = spawnSync("git", ["-C", ROOT, "show", "eb5e457:dashboard/deploy/joya-helper"], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  if (g.status === 0 && g.stdout.length > 1000) {
    OLD_HELPER = path.join(TMP, "joya-helper-eb5e457");
    fs.writeFileSync(OLD_HELPER, g.stdout);
  }
}
const run = spawnSync("python3", ["-B", "-c", driver, HELPER, TMP, AGENT, CHANNEL, OUTSIDE, OLD_HELPER], {
  encoding: "utf8",
  maxBuffer: 64 * 1024 * 1024,
});
if (run.status !== 0) {
  console.error(run.stderr || run.stdout);
  process.exit(1);
}
const R = JSON.parse(run.stdout.trim().split("\n").pop());
const err = (r) => (r && !r.ok ? String(r.error) : "");

check("start: Topics off, no projects file", R.start_env.ENABLE_PROJECT_THREADS === "false" && !R.start_env.PROJECTS_CONFIG_PATH && R.start_proj === null);
check("ordinary group id refused, in plain words", /Topics not saved: .*-5597160241.*starts with -100/.test(err(R.bad_group_id)), err(R.bad_group_id));
check("group mode without a chat id refused", /needs the group's chat id/.test(err(R.no_chat_id)), err(R.no_chat_id));
check("a link leading outside the agent's folder refused", /leads outside the agent's folder/.test(err(R.link_out)), err(R.link_out));
check("a missing folder refused", /there is no folder 'nope'/.test(err(R.missing_dir)), err(R.missing_dir));
check("an absolute path refused", /relative to the agent's folder/.test(err(R.abs_path)), err(R.abs_path));
check("'..' out of the folder refused", /outside the agent's folder/.test(err(R.dotdot)), err(R.dotdot));
check("duplicate short names refused", /share the short name 'p'/.test(err(R.dup_slug)), err(R.dup_slug));
check("duplicate names refused", /share the name 'P'/.test(err(R.dup_name)), err(R.dup_name));
check("duplicate folders refused (./notes = notes)", /same folder 'notes'/.test(err(R.dup_path)), err(R.dup_path));
check("every project off refused", /every project is switched off/.test(err(R.all_off)), err(R.all_off));
check("bad short name refused", /short name 'Bad Slug'/.test(err(R.bad_slug)), err(R.bad_slug));
check("a name with quotes refused", /name of project 'p'/.test(err(R.bad_name)), err(R.bad_name));
check("unknown mode refused", /mode must be/.test(err(R.bad_mode)), err(R.bad_mode));
check("more than 20 projects refused", /at most 20/.test(err(R.too_many)), err(R.too_many));
check("Telegram: a group without Topics refused", /Topics are switched off in that group/.test(err(R.tg_noforum)), err(R.tg_noforum));
check("Telegram: bot not an admin refused", /not an administrator/.test(err(R.tg_notadmin)), err(R.tg_notadmin));
check("Telegram: chat not found refused", /cannot open chat .*chat not found/.test(err(R.tg_missing)), err(R.tg_missing));
check("refusals leave env, projects file and channel untouched", R.refusals_untouched === true);
check("refusals restart nothing", R.refusals_no_restart === true);

check("Topics on: saved", R.on_default.ok === true, JSON.stringify(R.on_default));
check("Topics on: the four keys, together", JSON.stringify(R.on_default_env) === JSON.stringify({
  ENABLE_PROJECT_THREADS: "true",
  PROJECTS_CONFIG_PATH: path.join(R.agent_dir, "projects.yaml"),
  PROJECT_THREADS_CHAT_ID: "-1001234567890",
  PROJECT_THREADS_MODE: "group",
}), JSON.stringify(R.on_default_env));
check("Topics on: default list = the agent's own folder, named after the agent",
  R.on_default_chan.topics_projects.length === 1 &&
    ["slug", "name", "path", "enabled"].every((k) => R.on_default_chan.topics_projects[0][k] === { slug: AGENT, name: "Scratch Bot", path: ".", enabled: true }[k]),
  JSON.stringify(R.on_default_chan.topics_projects));
check("projects file written, 0640", R.on_default_proj && R.on_default_proj.mode === "0o640", JSON.stringify(R.on_default_proj));
check("projects file root-owned (when run as root)", !R.root || (R.on_default_proj && R.on_default_proj.uid === 0), R.on_default_proj && R.on_default_proj.uid);
check("projects file has the projects list", /projects:\n  - slug: "scratch-bot"\n    name: "Scratch Bot"\n    path: "\."\n    enabled: true/.test(R.on_default_proj && R.on_default_proj.text));
check("Telegram asked before turning Topics on", R.on_default_tg_calls >= 3, R.on_default_tg_calls);
check("the start check is reported", R.on_default.data.topics_check && R.on_default.data.topics_check.ok && R.on_default.data.topics_check.sync.created === 1, JSON.stringify(R.on_default.data.topics_check));
check("a save that does not change Topics does not ask Telegram again", R.resave.ok && R.resave_tg_calls === 0, R.resave_tg_calls);
check("Telegram unreachable: the save goes ahead", R.tg_down.ok === true, err(R.tg_down));
check("private mode: no chat id key", R.custom.ok && R.custom_env.PROJECT_THREADS_MODE === "private" && !("PROJECT_THREADS_CHAT_ID" in R.custom_env), JSON.stringify(R.custom_env));
check("custom list stored normalised (clients/eu/ -> clients/eu)", R.custom_chan.topics_projects[1].path === "clients/eu", JSON.stringify(R.custom_chan.topics_projects));
check("non-ASCII names escaped, disabled project kept as enabled: false",
  /name: "Scratch Bot \\u00e9"/.test(R.custom_proj.text) && /slug: "notes"\n    name: "Notes"\n    path: "notes"\n    enabled: false/.test(R.custom_proj.text), R.custom_proj.text);

check("crash: refused with the bot's own error, in plain words",
  /Topics were not turned on: .*projects_config_path required when enable_project_threads is True\)\. The previous settings are back\. The agent is running again\./.test(err(R.crash)), err(R.crash));
check("crash: no token in the message", !/AAAAAAAAAAAAAAAAAAAA/.test(err(R.crash)));
check("crash: agent.env restored byte for byte", R.crash_env_restored === true);
check("crash: projects file restored byte for byte", R.crash_proj_restored === true);
check("crash: channel settings restored", R.crash_chan_restored === true);
check("crash: the agent restarted on the old settings", R.crash_restarts >= 2, R.crash_restarts);
check("crash: audited as a revert", R.crash_audit[0] === "channel-update" && R.crash_audit[1].topics_reverted && R.crash_audit[1].topics_reverted.after === "running", JSON.stringify(R.crash_audit));
check("no topic made: reverted too", /no topic could be made in the group: Not enough rights/.test(err(R.notopics)) && R.notopics_chan === "-1001234567890", err(R.notopics));
check("old settings fail too: Topics forced off, said so",
  /did not start either, so Topics are now off/.test(err(R.double)) && R.double_chan.topics_enabled === false &&
  R.double_env.ENABLE_PROJECT_THREADS === "false" && !R.double_env.PROJECTS_CONFIG_PATH && R.double_proj === null, err(R.double));

check("on again", R.on_again.ok && R.on_again_env.PROJECTS_CONFIG_PATH, JSON.stringify(R.on_again_env));
check("off: ENABLE false, no path, no chat id, no file", R.off.ok && JSON.stringify(R.off_env) === JSON.stringify({ ENABLE_PROJECT_THREADS: "false" }) && R.off_proj === null, JSON.stringify(R.off_env));
check("off: the projects list is kept for next time", R.off_chan.topics_projects.length === 2 && R.off_chan.topics_enabled === false, JSON.stringify(R.off_chan.topics_projects));
check("agent saved after its topic folder vanished: Topics left off, and said why",
  R.agent_update.ok && /no folder 'clients\/eu\/deep'/.test(R.agent_update.data.topics_skipped) && R.agent_update_env.ENABLE_PROJECT_THREADS === "false" && R.agent_update_proj === null,
  JSON.stringify(R.agent_update));
check("an add-on may not set PROJECTS_CONFIG_PATH", /PROJECTS_CONFIG_PATH is set by the panel/.test(err(R.addon_key)), err(R.addon_key));

const F = R.folders.data || {};
check("folders: the agent's folder, real path", F.approved_directory === R.vault, F.approved_directory);
check("folders: '.', subfolders three levels deep", JSON.stringify(F.folders) === JSON.stringify([".", "clients", "clients/eu", "clients/eu/deep", "notes"]), JSON.stringify(F.folders));
check("folders: no hidden folders, no links", !F.folders.includes(".obsidian") && !F.folders.includes("project"));
check("folders: carries the proposed default", F.default_projects && F.default_projects[0].path === "." && F.default_projects[0].name === "Scratch Bot");

check("start check: failed unit = crashed", R.chk_failed_unit.state === "crashed" && !R.chk_failed_unit.ok);
check("start check: still starting at the deadline but active = ok, 'slow'", R.chk_slow.ok && R.chk_slow.state === "slow", JSON.stringify(R.chk_slow));
check("start check: the old process's last words are not this start's", R.chk_old_only.state === "slow" && !R.chk_old_only.error, JSON.stringify(R.chk_old_only));
check("plain error: 'private chat topics' explained for group mode", /group needs Topics turned on/.test(R.plain_private));
check("tokens redacted", R.redact === "x [token] y");
const kinds = R.audit.map((a) => a[0]);
check("every save audited as channel-update, with the topics config", kinds.filter((k) => k === "channel-update").length >= 10 &&
  R.audit.some((a) => a[1].topics && a[1].topics.enabled && a[1].topics.chat_id === "-1001234567890"));

console.log("helper: General topic, respond in groups, new-topic folders, trash");
if (R.legacy_off) {
  check("defaults unchanged: an existing channel (Topics off) renders the same agent.env plus only GROUP_RESPOND_MODE=all and BOT_NAME_ALIASES= (and ALLOW_FILE_SEND=true, ALLOW_DRAWING=true, ALLOW_CHATGPT=true, added later)",
    JSON.stringify(R.legacy_off) === JSON.stringify({ added: ["ALLOW_CHATGPT=true", "ALLOW_DRAWING=true", "ALLOW_FILE_SEND=true", "BOT_NAME_ALIASES=", "GROUP_RESPOND_MODE=all"], removed: [] }), JSON.stringify(R.legacy_off));
  check("defaults unchanged: Topics on adds only the two plus the five topic options at their defaults",
    JSON.stringify(R.legacy_on) === JSON.stringify({ added: ["ALLOW_CHATGPT=true", "ALLOW_DRAWING=true", "ALLOW_FILE_SEND=true", "BOT_NAME_ALIASES=", "GROUP_RESPOND_MODE=all", "PROJECT_THREADS_AUTO_ANNOUNCE=true",
      "PROJECT_THREADS_AUTO_MAP=false", "PROJECT_THREADS_DELETED_TOPICS=trash", "PROJECT_THREADS_GENERAL_PROJECT=off", "PROJECT_THREADS_TRASH_DAYS=30"], removed: [] }),
    JSON.stringify(R.legacy_on));
} else {
  console.log("  (eb5e457 not reachable through git: the byte comparison with the old helper is skipped)");
}
check("only when asked: saved, names default to the agent's name", R.mention.ok && R.mention_keys.GROUP_RESPOND_MODE === "mention" &&
  R.mention_keys.BOT_NAME_ALIASES === "Scratch Bot" && JSON.stringify(R.mention_chan.name_aliases) === JSON.stringify(["Scratch Bot"]), JSON.stringify([R.mention, R.mention_keys]));
check("names: trimmed, de-duplicated ignoring case, comma-joined", R.aliases.ok && R.aliases_keys.BOT_NAME_ALIASES === "Mavix,Max", JSON.stringify(R.aliases_keys));
check("topic options rendered: General, auto map, announce, deleted, trash days", R.opts.ok && JSON.stringify(R.opts_keys) === JSON.stringify({
  GROUP_RESPOND_MODE: "mention", BOT_NAME_ALIASES: "Mavix,Max", PROJECT_THREADS_GENERAL_PROJECT: "deep", PROJECT_THREADS_AUTO_MAP: "true",
  PROJECT_THREADS_AUTO_ANNOUNCE: "false", PROJECT_THREADS_DELETED_TOPICS: "keep", PROJECT_THREADS_TRASH_DAYS: "7" }), JSON.stringify([R.opts, R.opts_keys]));
check("private mode: General is off (it exists only in a group)", R.opts_private.ok && R.opts_private_keys.PROJECT_THREADS_GENERAL_PROJECT === "off", JSON.stringify(R.opts_private_keys));
check("refused: General to a project not in the list", /General topic goes to 'nope', which is not one of the projects/.test(err(R.r_general_missing)), err(R.r_general_missing));
check("refused: General to a project switched off", /goes to 'Off one', which is switched off/.test(err(R.r_general_off)), err(R.r_general_off));
check("refused: General with a bad short name", /General topic must go to one of the projects/.test(err(R.r_general_badslug)), err(R.r_general_badslug));
check("refused: unknown respond mode", /Respond in groups: answer every message/.test(err(R.r_respond)), err(R.r_respond));
check("refused: a name with a comma", /contains a comma/.test(err(R.r_alias_comma)), err(R.r_alias_comma));
check("refused: a name over 40 characters", /longer than 40/.test(err(R.r_alias_long)), err(R.r_alias_long));
check("refused: 11 names", /at most 10 names/.test(err(R.r_alias_many)), err(R.r_alias_many));
check("refused: trash days -1, 3651, 'soon'", /0 to 3650 days/.test(err(R.r_days_neg)) && /not 3651/.test(err(R.r_days_big)) && /whole number/.test(err(R.r_days_text)),
  [err(R.r_days_neg), err(R.r_days_big), err(R.r_days_text)].join(" | "));
check("refused: unknown deleted-topic choice", /moved to the trash or kept/.test(err(R.r_deleted)), err(R.r_deleted));
check("add-ons may not set any of the new keys", Object.entries(R.r_addon).every(([k, r]) => new RegExp(k + " is set by the panel").test(err(r))),
  JSON.stringify(Object.values(R.r_addon).map(err)));
check("refusals leave env, projects file and channel untouched, restart nothing", R.r_untouched === true && R.r_no_restart === true);
check("a plain save (Topics off, every message) does not wait for the bot", R.plain_save.ok && R.plain_save_journal === 0 && !R.plain_save.data.topics_check, R.plain_save_journal);
check("safety net runs for 'only when asked' without Topics: crash -> reverted, said so",
  /^The settings were not saved: the bot did not start with them \(it said: .*\)\. The previous settings are back\. The agent is running again\.$/.test(err(R.m_crash)), err(R.m_crash));
check("... agent.env back byte for byte, channel back to every message, restarted", R.m_crash_env_restored === true && R.m_crash_chan === "all" && R.m_crash_restarts >= 2, JSON.stringify([R.m_crash_chan, R.m_crash_restarts]));
check("... audited with the respond setting", R.m_crash_audit[1].respond && R.m_crash_audit[1].respond.mode === "mention" && R.m_crash_audit[1].topics_reverted, JSON.stringify(R.m_crash_audit));
check("'only when asked' that starts: saved, start check reported", R.m_ok.ok && R.m_ok.data.topics_check && R.m_ok_keys.GROUP_RESPOND_MODE === "mention");

const AF = (R.auto_folders.data || {}).auto || {};
check("auto block: the valid entries", JSON.stringify(AF.projects.map((p) => p.slug)) === JSON.stringify(["client-x"]) &&
  JSON.stringify(AF.unlinked.map((p) => p.slug)) === JSON.stringify(["old"]) && JSON.stringify(AF.trash.map((p) => p.slug)) === JSON.stringify(["gone", "client-x", "dele"]), JSON.stringify(AF));
check("auto block: count and max", AF.count === 1 && AF.max === 100);
check("auto block: entries outside topics/, through a link, nested, badly named or not objects are left out, and said so",
  /7 entries of projects\.auto\.json left out/.test(AF.error) && !JSON.stringify([AF.projects, AF.unlinked, AF.trash]).match(/linky|outside|lnk-|other\/x|deeper|Bad Slug/), AF.error);
check("auto block: a project entry keeps thread id and created_at", AF.projects[0].thread_id === 81 && AF.projects[0].created_at === "2026-10-02T19:00:00Z" && AF.projects[0].closed === false && AF.projects[0].exists === true);
const AM = (R.auto_malformed.data || {}).auto || {};
check("auto block: a malformed file is an error, not a crash", R.auto_malformed.ok && /not valid JSON/.test(AM.error) && AM.projects.length === 0, JSON.stringify(R.auto_malformed));
check("auto block: wrong shape is an error", R.auto_wrong_shape.ok && /'projects' in projects\.auto\.json is not a list/.test(R.auto_wrong_shape.data.auto.error), JSON.stringify(R.auto_wrong_shape.data.auto));
check("auto block: the file as a link is refused (not followed)", R.auto_link.ok && /is a link/.test(R.auto_link.data.auto.error) && !/do not delete/.test(JSON.stringify(R.auto_link)), JSON.stringify(R.auto_link.data.auto));
check("auto block: no file = empty, no error", R.auto_none.ok && R.auto_none.data.auto.error === "" && R.auto_none.data.auto.projects.length === 0);

check("an unchanged auto row is not written to projects.yaml or the channel", R.fold_same.ok && !/client-x/.test(R.fold_same_proj) &&
  JSON.stringify(R.fold_same_chan.map((p) => p.slug)) === JSON.stringify(["deep"]), R.fold_same_proj);
check("an edited auto row is written, as an override flagged auto", R.fold_edit.ok && /slug: "client-x"\n    name: "Client X renamed"\n    path: "topics\/client-x"\n    enabled: true\n    auto: true/.test(R.fold_edit_proj) &&
  R.fold_edit_chan.some((p) => p.slug === "client-x" && p.auto === true), R.fold_edit_proj);
check("General cannot go to a folder made for a new topic", /not to a folder made for a new topic/.test(err(R.fold_general_auto)), err(R.fold_general_auto));
check("an auto row switched off is kept as an override", R.fold_off.ok && /slug: "client-x"\n    name: "Client X"\n    path: "topics\/client-x"\n    enabled: false\n    auto: true/.test(R.fold_off_proj), R.fold_off_proj);
check("back to the bot's values: the override goes; a vanished auto row is dropped", R.fold_back.ok && !/client-x|ghost/.test(R.fold_back_proj) &&
  JSON.stringify(R.fold_back_chan.map((p) => p.slug)) === JSON.stringify(["deep"]), R.fold_back_proj);
check("the 20-project cap counts the list's own rows only", R.cap_20_plus_auto === 25 && /at most 20/.test(R.cap_21), JSON.stringify([R.cap_20_plus_auto, R.cap_21]));

check("trash restore: folder back in topics/<slug>, with its contents", R.t_restore.ok && R.t_restore.data.path === "topics/gone" && R.t_restore_file === "kept\n" && R.t_restore_gone_from_trash, JSON.stringify(R.t_restore));
check("trash restore: trash entry removed, unlinked entry added (reason restored), other keys kept",
  !R.t_restore_auto.trash.some((t) => t.slug === "gone") && R.t_restore_auto.unlinked.some((u) => u.slug === "gone" && u.path === "topics/gone" && u.reason === "restored") &&
  JSON.stringify(R.t_restore_auto.keep_me) === JSON.stringify({ x: 1 }) && R.t_restore_auto.projects.length === 6, JSON.stringify(R.t_restore_auto));
check("trash restore: the auto file stays 0660", R.t_auto_mode === "0o660", R.t_auto_mode);
check("the lock is taken (exclusive) and released", R.t_flock.length >= 2 && R.t_flock[0] === 2 && R.t_flock.includes(8), JSON.stringify(R.t_flock));
check("trash restore: taken name -> <slug>-2", R.t_taken.ok && R.t_taken.data.path === "topics/client-x-2" && R.t_taken_exists, JSON.stringify(R.t_taken));
check("trash delete: folder removed, entry removed", R.t_delete.ok && R.t_delete.data.deleted === true && R.t_delete_gone && !R.t_delete_auto.trash.some((t) => t.slug === "dele"), JSON.stringify(R.t_delete));
check("trash delete/restore: a symlinked trash_path is refused", /is a link/.test(err(R.t_link_delete)) && /is a link/.test(err(R.t_link_restore)), err(R.t_link_delete) + " | " + err(R.t_link_restore));
check("trash: paths outside .trash/topics refused", /not inside \.trash\/topics/.test(err(R.t_outside)) && /not inside|outside/.test(err(R.t_dotdot)) && /not inside \.trash\/topics/.test(err(R.t_topics)),
  [err(R.t_outside), err(R.t_dotdot), err(R.t_topics)].join(" | "));
check("trash: a path not in the trash list refused", /is not in the trash list/.test(err(R.t_unknown)), err(R.t_unknown));
check("trash: unknown action refused", /usage: channel-topics-trash/.test(err(R.t_bad_action)));
check("trash: nothing outside was touched", R.t_outside_safe === true);
check("trash: a malformed auto file refuses cleanly", /Nothing changed: .*not valid JSON/.test(err(R.t_malformed)) && R.t_malformed_kept === true, err(R.t_malformed));
check("trash: the runtime holding the lock -> busy, nothing changed", /busy with its topics file/.test(err(R.t_busy)) && R.t_busy_untouched === true, err(R.t_busy));
check("trash actions audited", R.t_audit.length === 3 && R.t_audit[0][1].restored_to === "topics/gone" && R.t_audit[2][1].action === "delete", JSON.stringify(R.t_audit));

/* -------------------------------------------------- 3. the real runtime --- */

const PY = path.join(RUNTIME, "venv", "bin", "python");
if (!fs.existsSync(PY) || !fs.existsSync(path.join(RUNTIME, "src", "projects", "registry.py"))) {
  console.log("runtime: not installed at " + RUNTIME + "; skipped");
} else {
  console.log("runtime: the real loader, registry and start-up, on a scratch copy");
  const COPY = path.join(TMP, "runtime-copy");
  fs.cpSync(path.join(RUNTIME, "src"), path.join(COPY, "src"), {
    recursive: true,
    filter: (p) => !/__pycache__/.test(p),
  });
  const CHECK = path.join(__dirname, "topics-runtime-check.py");
  const rt = (c, name) => {
    const f = path.join(TMP, "case-" + name + ".json");
    fs.writeFileSync(f, JSON.stringify(c));
    const r = spawnSync(PY, ["-B", CHECK, COPY, f], {
      encoding: "utf8",
      timeout: 90000,
      maxBuffer: 64 * 1024 * 1024,
      env: Object.assign({}, process.env, { PYTHONDONTWRITEBYTECODE: "1", HOME: TMP }),
    });
    try {
      return JSON.parse(r.stdout.trim().split("\n").pop());
    } catch (e) {
      return { ok: false, error: "no result: " + (r.stderr || r.stdout).slice(-800) };
    }
  };
  const vault = R.vault;
  // The env files were copied aside while their projects file existed; point
  // each at its own copy (the fixture has moved on since).
  for (const [env, proj] of [["group-agent.env", "group-projects.yaml"], ["custom-agent.env", "custom-projects.yaml"]]) {
    const f = path.join(TMP, env);
    fs.writeFileSync(f, fs.readFileSync(f, "utf8").replace(/^PROJECTS_CONFIG_PATH=.*$/m, "PROJECTS_CONFIG_PATH=" + path.join(TMP, proj)));
  }
  const reg = rt({ op: "registry", projects: path.join(TMP, "custom-projects.yaml"), approved: vault }, "reg");
  check("registry accepts the helper's file (escaped name, trailing slash normalised)", reg.ok && JSON.stringify(reg.slugs) === JSON.stringify(["scratch-bot", "client-eu"]), JSON.stringify(reg));
  // The refusals above, proven against the real registry: what the helper
  // refuses, the runtime refuses too.
  const yaml = (rows) => "projects:\n" + rows.map((r) => `  - slug: "${r[0]}"\n    name: "${r[1]}"\n    path: "${r[2]}"\n`).join("");
  const refused = (name, rows, re) => {
    const f = path.join(TMP, "bad-" + name + ".yaml");
    fs.writeFileSync(f, rows === null ? "projects: []\n" : yaml(rows));
    const r = rt({ op: "registry", projects: f, approved: vault }, "bad-" + name);
    check("runtime refuses it too: " + name, r.ok === false && re.test(r.error), JSON.stringify(r));
  };
  refused("link outside", [["p", "P", "project"]], /outside approved directory/);
  refused("missing folder", [["p", "P", "nope"]], /does not exist/);
  refused("absolute path", [["p", "P", "/etc"]], /must be relative/);
  refused("duplicate path", [["p", "P", "notes"], ["q", "Q", "notes"]], /Duplicate project path/);
  refused("empty list", null, /non-empty 'projects' list/);
  const cfgGroup = rt({ op: "config", env: path.join(TMP, "group-agent.env") }, "cfg");
  check("load_config accepts the helper's group env: topic mode, chat id, projects file", cfgGroup.ok && cfgGroup.enable_project_threads === true &&
    cfgGroup.mode === "group" && cfgGroup.chat_id === -1001234567890 && /projects\.yaml$/.test(cfgGroup.projects_config_path), JSON.stringify(cfgGroup));
  const cfgPriv = rt({ op: "config", env: path.join(TMP, "custom-agent.env") }, "cfgp");
  check("load_config accepts the helper's private env", cfgPriv.ok && cfgPriv.mode === "private" && cfgPriv.chat_id === null, JSON.stringify(cfgPriv));
  // The env as it was before this fix: Topics keys without PROJECTS_CONFIG_PATH.
  const brokenEnv = path.join(TMP, "broken-agent.env");
  fs.writeFileSync(brokenEnv, fs.readFileSync(path.join(TMP, "group-agent.env"), "utf8").replace(/^PROJECTS_CONFIG_PATH=.*\n/m, ""));
  const cfgBroken = rt({ op: "config", env: brokenEnv }, "cfgb");
  check("the old env (no PROJECTS_CONFIG_PATH) is what the runtime refused", cfgBroken.ok === false && /projects_config_path required/.test(cfgBroken.error), JSON.stringify(cfgBroken));

  // A fake token and a fake Bot API: the bot starts for real, offline.
  const fakeToken = "123456789:" + "A".repeat(35);
  const startEnv = (name) => {
    const f = path.join(TMP, name + ".env");
    const db = path.join(TMP, name + ".db");
    fs.writeFileSync(f, fs.readFileSync(path.join(TMP, "group-agent.env"), "utf8")
      .replace(/^TELEGRAM_BOT_TOKEN=.*$/m, "TELEGRAM_BOT_TOKEN=" + fakeToken)
      .replace(/^DATABASE_URL=.*$/m, "DATABASE_URL=sqlite:///" + db));
    return f;
  };
  const up = rt({ op: "start", env: startEnv("start-forum"), forum: true, seconds: 40 }, "start-forum");
  const upLines = up.lines || [];
  check("the real bot starts in topic mode: topics made for both projects", upLines.some((l) => /"Project thread startup sync complete"/.test(l) && /"created": 2/.test(l) && /"failed": 0/.test(l)), (up.error || upLines.slice(-5).join("\n")));
  check("... then polls Telegram (Starting bot, getUpdates)", upLines.some((l) => /"event": "Starting bot"/.test(l)) && (up.calls || []).includes("getUpdates") && (up.calls || []).filter((c) => c === "createForumTopic").length === 2, JSON.stringify(up.calls));
  const down = rt({ op: "start", env: startEnv("start-plain"), forum: false, seconds: 40 }, "start-plain");
  check("an ordinary group (no Topics) makes the real bot exit at start", down.code === 1 && (down.lines || []).some((l) => /Private chat topics are not enabled/.test(l)), JSON.stringify({ code: down.code, calls: down.calls }));

  // The helper's start check reading the runtime's own log of both starts.
  const feed = String.raw`
import importlib.machinery, importlib.util, json, subprocess, sys
spec = importlib.util.spec_from_loader("joya_helper", importlib.machinery.SourceFileLoader("joya_helper", sys.argv[1]))
H = importlib.util.module_from_spec(spec); spec.loader.exec_module(H)
logs = json.loads(sys.stdin.read())
out = {}
for name, lines in logs.items():
    text = "Started " + H.unit_name("scratch-bot") + " - x\n" + "\n".join(lines) + "\n"
    H.run = lambda argv, **kw: subprocess.CompletedProcess(argv, 0, text if argv[0] == "journalctl" else "ActiveState=active\nSubState=running", "")
    out[name] = H.agent_start_check("scratch-bot", 0, timeout=1, sleep=lambda s: None)
print(json.dumps(out))
`;
  const fr = spawnSync("python3", ["-B", "-c", feed, HELPER], { input: JSON.stringify({ up: upLines, down: down.lines || [] }), encoding: "utf8" });
  let FR = {};
  try {
    FR = JSON.parse(fr.stdout.trim().split("\n").pop());
  } catch (e) {
    FR = { error: fr.stderr };
  }
  check("start check on the real log: topic-mode start = ok, sync recorded", FR.up && FR.up.ok && FR.up.state === "running" && FR.up.sync && FR.up.sync.created === 2, JSON.stringify(FR.up || FR));
  check("start check on the real log: the no-Topics exit = crashed, explained", FR.down && !FR.down.ok && FR.down.state === "crashed" && /group needs Topics turned on/.test(FR.down.error), JSON.stringify(FR.down || FR));
}

/* --------------------------------------------------------- 4. the page --- */

console.log("view: the channel page's Topics card");
{
  const rbac = require(path.join(ROOT, "lib", "rbac"));
  const admin = rbac.actor({ permissions: ["*"], agent_scope: "*", channel_scope: "*" });
  const user = { name: "Ann", roleLabel: "Administrator", perm: admin, chrome: require(path.join(ROOT, "lib", "chrome")).forActor(admin, null) };
  const views = require(path.join(ROOT, "lib", "views-channels"));
  const base = { slug: "tg", name: "TG", type: "telegram", agent: "scratch-bot", agent_name: "Scratch Bot", token_set: true, allowed_users: "1234567" };
  const folders = { approved_directory: "/opt/joya-agents/agents/scratch-bot/vault", folders: [".", "notes"], default_projects: [{ slug: "scratch-bot", name: "Scratch Bot", path: ".", enabled: true }] };
  const fresh = views.detail({ csrf: "c", user, channel: base, agents: [], wa: null, topicFolders: folders });
  check("Topics card present on a Telegram channel", /id="topics"/.test(fresh) && /Telegram Topics/.test(fresh));
  check("no list stored: the proposed default row is shown and labelled", /Proposed default:/.test(fresh) && /name="tp_name" value="Scratch Bot"/.test(fresh) && /name="tp_path" value="\."/.test(fresh));
  check("folder picker lists the agent's folders", /<datalist id="tp-folders"><option value="\.">the agent's own folder<\/option><option value="notes">/.test(fresh));
  check("the agent's folder is named", /\/opt\/joya-agents\/agents\/scratch-bot\/vault/.test(fresh));
  check("the table marker and the row template are there", /name="tp_table" value="1"/.test(fresh) && /<template data-topics-template>/.test(fresh) && /data-topics-add/.test(fresh));
  check("group chat id validated in the browser too", /pattern="-100\[0-9\]\{7,13\}"/.test(fresh));
  const stored = views.detail({
    csrf: "c", user, wa: null, agents: [], topicFolders: folders,
    channel: Object.assign({}, base, { topics_enabled: true, topics_mode: "private", topics_chat_id: "", topics_projects: [{ slug: "a", name: "A <b>", path: "x" }, { slug: "b", name: "B", path: "y" }] }),
  });
  check("stored list shown, escaped, no 'proposed'", /value="A &lt;b&gt;"/.test(stored) && !/Proposed default:/.test(stored) && (stored.match(/data-topics-row/g) || []).length === 3);
  check("private mode: chat id field hidden", /<label data-topics-chat hidden>/.test(stored) && /<option value="private" selected>/.test(stored));
  check("summary line", /on · private chat · 2 projects/.test(stored));
  const unbound = views.detail({ csrf: "c", user, wa: null, agents: [], topicFolders: null, channel: Object.assign({}, base, { agent: "" }) });
  check("no agent: says to connect one first", /Connect an agent first/.test(unbound));
  const wa = views.detail({ csrf: "c", user, wa: null, agents: [], channel: { slug: "w", name: "W", type: "whatsapp", agent: "" } });
  check("no Topics card on a WhatsApp channel", !/id="topics"/.test(wa));

  const autoFolders = Object.assign({}, folders, {
    auto: {
      projects: [
        { slug: "client-x", name: "Client X", path: "topics/client-x", exists: true, thread_id: 81, closed: false },
        { slug: "ideas", name: "Ideas", path: "topics/ideas", exists: true, thread_id: 82, closed: true },
      ],
      unlinked: [{ slug: "old", name: "Old", path: "topics/old", since: "2026-10-01T10:00:00Z", reason: "restored" }],
      trash: [{ slug: "gone", name: "Gone <x>", trash_path: ".trash/topics/gone-20261002T190000Z", original_path: "topics/gone", exists: true, trashed_at: "2026-10-02T19:00:00Z" }],
      count: 1, max: 100, error: "",
    },
  });
  const ch = Object.assign({}, base, {
    topics_enabled: true, topics_mode: "group", topics_chat_id: "-1001234567890", topics_general: "main", topics_auto: true,
    topics_auto_announce: false, topics_deleted: "trash", topics_trash_days: 7,
    topics_projects: [{ slug: "main", name: "Main", path: ".", enabled: true }, { slug: "off1", name: "Off one", path: "notes", enabled: false },
      { slug: "ideas", name: "Ideas edited", path: "topics/ideas", enabled: true, auto: true }],
  });
  const html = views.detail({ csrf: "tok", user, wa: null, agents: [], topicFolders: autoFolders, channel: ch });
  const rowsOf = (h) => (h.match(/<tr data-topics-row[^>]*>[\s\S]*?<\/tr>/g) || []).filter((r) => !/value="" maxlength="64"/.test(r));
  const rr = rowsOf(html);
  check("card: the list's rows, the edited auto row, then the bot's auto rows", rr.length === 4 && /value="Main"/.test(rr[0]) && /value="Ideas edited"/.test(rr[2]) && /value="Client X"/.test(rr[3]), rr.length);
  check("card: auto rows marked, edited/closed said", /auto · edited · closed/.test(rr[2]) && /data-topics-auto/.test(rr[3]) && />auto<\/span>/.test(rr[3]));
  check("card: auto rows have no remove button, say 'switch off only', short name read-only, hidden auto flag",
    !/data-topics-remove/.test(rr[3]) && /switch off only/.test(rr[3]) && /name="tp_slug" value="client-x"[^>]*readonly/.test(rr[3]) && /name="tp_auto" value="1"/.test(rr[3]) && /name="tp_auto" value="0"/.test(rr[0]));
  check("card: a switched-off row shows Off", /<option value="0" selected>Off<\/option>/.test(rr[1]));
  check("card: 'General goes to' offers Off and the list's own projects that are on (no auto, no off)",
    /<select name="topics_general" data-topics-general><option value="" >Off[^<]*<\/option><option value="main" selected>Main<\/option><\/select>/.test(html), (html.match(/<select name="topics_general"[\s\S]*?<\/select>/) || [""])[0]);
  check("card: new topics / announce / deleted / days", /name="topics_auto" value="1" checked/.test(html) && /name="topics_auto_announce" value="1" >/.test(html) &&
    /name="topics_deleted" value="trash" checked/.test(html) && /name="topics_trash_days" value="7"/.test(html) && /1 of 100 in use/.test(html));
  check("card: folders without a topic listed", /Folders without a topic/.test(html) && /restored from the trash/.test(html) && /topics\/old/.test(html));
  check("card: the trash list, escaped, with its dates", /Gone &lt;x&gt;/.test(html) && /2026-10-02/.test(html) && /2026-10-09/.test(html));
  check("card: Restore and Delete now submit the outside forms with the trash path",
    /form="topics-trash-restore" name="trash_path" value="\.trash\/topics\/gone-20261002T190000Z"/.test(html) && /form="topics-trash-delete" name="trash_path" value="\.trash\/topics\/gone-20261002T190000Z"/.test(html));
  check("card: Delete now asks first; both forms carry the CSRF token and post to the trash route",
    /<form id="topics-trash-delete" method="post" action="\/channels\/tg\/topics\/trash" hidden\s+data-confirm-dlg="Delete this folder now\?"/.test(html) &&
      (html.match(/name="_csrf" value="tok"><input type="hidden" name="op" value="(restore|delete)"/g) || []).length === 2);
  check("card: the trash forms are outside the settings form", html.indexOf('id="topics-trash-delete"') > html.lastIndexOf("</form>", html.indexOf('id="topics-trash-restore"')) && !/<form[^>]*action="\/channels\/tg" [\s\S]*id="topics-trash-restore"[\s\S]*Save channel/.test(html));
  check("card: summary says new topics get folders", /new topics get folders/.test(html));
  const priv = views.detail({ csrf: "c", user, wa: null, agents: [], topicFolders: autoFolders, channel: Object.assign({}, ch, { topics_mode: "private" }) });
  check("card: private mode hides the group-only part", /<div class="topics-group" data-topics-group hidden>/.test(priv));
  const bad = views.detail({ csrf: "c", user, wa: null, agents: [], topicFolders: Object.assign({}, folders, { auto: { projects: [], unlinked: [], trash: [], count: 0, max: 100, error: "the file projects.auto.json is not valid JSON" } }), channel: ch });
  check("card: an auto-file problem is shown, the page still renders", /The bot's list of topic folders: the file projects\.auto\.json is not valid JSON/.test(bad));
  check("card: an unknown General target stays selected and is marked", /<option value="main" selected>main \(not in the list\)<\/option>/.test(views.detail({ csrf: "c", user, wa: null, agents: [], topicFolders: folders, channel: Object.assign({}, ch, { topics_projects: [] }) })));

  check("respond: in the settings, every message by default, names prefilled with the agent's name",
    /name="respond_form" value="1"/.test(fresh) && /name="respond_mode" value="all" checked/.test(fresh) && /<textarea name="name_aliases"[^>]*>Scratch Bot<\/textarea>/.test(fresh) && /<td>In groups<\/td><td>every message<\/td>/.test(fresh));
  const asked = views.detail({ csrf: "c", user, wa: null, agents: [], topicFolders: folders, channel: Object.assign({}, base, { respond_mode: "mention", name_aliases: ["Mavix", "Max <b>"] }) });
  check("respond: only when asked, stored names one per line, escaped", /name="respond_mode" value="mention" checked/.test(asked) && /<textarea name="name_aliases"[^>]*>Mavix\nMax &lt;b&gt;<\/textarea>/.test(asked) && /only when asked/.test(asked));
  check("respond: not on a WhatsApp channel", !/name="respond_mode"/.test(wa));
}

fs.rmSync(TMP, { recursive: true, force: true });
console.log("\n" + passed + " passed, " + failed + " failed");
process.exit(failed ? 1 : 0);
