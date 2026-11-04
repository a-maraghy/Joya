#!/usr/bin/env node
"use strict";
/**
 * Tests for Claude Code > Memory / Sessions / Running.
 *
 *   node dashboard/tools/test-claude.cjs
 *
 * Builds a throwaway Claude home under a temp directory -- a transcript, a
 * subagent with its .meta.json, a sessions/<pid>.json -- and drives the real
 * cc_* functions of deploy/joya-helper against it by loading the helper as a
 * Python module with its home table pointed at the fixture. Nothing on the
 * machine is read or changed: no real session, no memory database, no signal
 * to a real Claude process.
 *
 * Then renders the views with what came back and checks the HTML.
 * Needs python3; does not need root.
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const HELPER = path.join(ROOT, "deploy", "joya-helper");

let failed = 0;
let passed = 0;
function check(name, cond, detail) {
  if (cond) {
    passed++;
    console.log("  ok   " + name);
  } else {
    failed++;
    console.log("  FAIL " + name + (detail ? "\n       " + detail : ""));
  }
}

/* ------------------------------------------------------------- fixture --- */

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "cc-test-"));
const HOME = path.join(TMP, "home", ".claude");
const PROJ = path.join(HOME, "projects", "-root-proj");
fs.mkdirSync(PROJ, { recursive: true });
fs.mkdirSync(path.join(HOME, "sessions"), { recursive: true });

const S1 = "11111111-2222-4333-8444-555555555555"; // titled, with a subagent
const S2 = "66666666-7777-4888-8999-aaaaaaaaaaaa"; // untitled: title from the first message
const SECRET_KEY = "sk-ant-api03-" + "A".repeat(40);
const SECRET_PW = "hunter2hunter2";
const SECRET_BEARER = "abcdefghijklmnopqrstuvwxyz0123456789";
const HUGE = "X".repeat(100 * 1024);
const ts = (n) => new Date(Date.UTC(2026, 8, 20, 10, n)).toISOString();

const jl = (records) => records.map((r) => JSON.stringify(r)).join("\n") + "\n";
const user = (content, extra = {}) => ({
  type: "user",
  message: { role: "user", content },
  uuid: "u" + Math.random(),
  timestamp: ts(extra.t || 0),
  cwd: "/root/proj",
  sessionId: S1,
  ...extra,
});
const asst = (content, extra = {}) => ({
  type: "assistant",
  message: { model: "claude-opus-5-5", role: "assistant", content, stop_reason: extra.stop || "tool_use" },
  timestamp: ts(extra.t || 1),
  cwd: "/root/proj",
  sessionId: S1,
});

fs.writeFileSync(
  path.join(PROJ, S1 + ".jsonl"),
  jl([
    { type: "queue-operation", operation: "enqueue", content: "ignored" },
    { type: "custom-title", customTitle: "Old title", sessionId: S1 },
    user(
      "Deploy it. My key is " + SECRET_KEY + " and password=" + SECRET_PW +
        "\n<system-reminder>hidden reminder text</system-reminder>",
      { origin: { kind: "human" }, t: 0 }
    ),
    asst([{ type: "thinking", thinking: "", signature: "sig" }]),
    asst([{ type: "text", text: "Checking the server first." }]),
    asst([
      {
        type: "tool_use",
        id: "toolu_1",
        name: "Bash",
        input: { command: "curl -H 'Authorization: Bearer " + SECRET_BEARER + "' https://example.test" },
      },
    ]),
    user([{ type: "tool_result", tool_use_id: "toolu_1", content: HUGE, is_error: false }], { t: 2 }),
    asst([{ type: "tool_use", id: "toolu_2", name: "Read", input: { file_path: "/etc/hosts" } }]),
    user([{ type: "tool_result", tool_use_id: "toolu_2", content: "boom", is_error: true }], { t: 3 }),
    asst([{ type: "text", text: "Done <b>bold</b>." }], { stop: "end_turn", t: 4 }),
    user([{ type: "text", text: "meta noise" }], { isMeta: true, t: 5 }),
    user([{ type: "text", text: "Second question" }, { type: "image", source: { type: "base64", data: "AAAA" } }], { t: 6 }),
    asst([{ type: "text", text: "Second answer." }], { stop: "end_turn", t: 7 }),
    user("Summary of earlier work", { isCompactSummary: true, t: 8 }),
    { type: "system", subtype: "compact_boundary", content: "Conversation compacted", timestamp: ts(8) },
    { type: "custom-title", customTitle: "Fixture <script>alert(1)</script> title", sessionId: S1 },
    { type: "permission-mode", permissionMode: "auto", sessionId: S1 },
  ])
);

const SUB = path.join(PROJ, S1, "subagents");
fs.mkdirSync(SUB, { recursive: true });
fs.writeFileSync(
  path.join(SUB, "agent-a1b2c3d4e5f6.meta.json"),
  JSON.stringify({ agentType: "general-purpose", description: "Check the fixture", toolUseId: "toolu_x", spawnDepth: 1 })
);
fs.writeFileSync(
  path.join(SUB, "agent-a1b2c3d4e5f6.jsonl"),
  jl([
    user("You are a subagent. Look at things.", { isSidechain: true }),
    asst([{ type: "tool_use", id: "toolu_s", name: "Grep", input: { pattern: "TODO", path: "/root/proj" } }]),
    user([{ type: "tool_result", tool_use_id: "toolu_s", content: "a\nb" }]),
    asst([{ type: "text", text: "Found two." }], { stop: "end_turn" }),
  ])
);

fs.writeFileSync(
  path.join(PROJ, S2 + ".jsonl"),
  jl([
    user("   How do I   rotate the\nnginx logs?  ", { t: 0, sessionId: S2 }),
    asst([{ type: "text", text: "Use logrotate." }], { stop: "end_turn" }),
  ])
);
fs.writeFileSync(path.join(PROJ, S2 + ".desktop-released.json"), JSON.stringify({ v: 1, reason: "delete" }));
// Old enough that the "written in the last 30 seconds" guard does not fire.
const past = Date.now() / 1000 - 3600;
fs.utimesSync(path.join(PROJ, S1 + ".jsonl"), past, past);
fs.utimesSync(path.join(PROJ, S2 + ".jsonl"), past, past);

/* ------------------------------------------------- drive the real helper --- */

const driver = String.raw`
import importlib.machinery, importlib.util, json, os, subprocess, sys, time
spec = importlib.util.spec_from_loader("joya_helper", importlib.machinery.SourceFileLoader("joya_helper", sys.argv[1]))
H = importlib.util.module_from_spec(spec); spec.loader.exec_module(H)
tmp, s1, s2 = sys.argv[2], sys.argv[3], sys.argv[4]
base = os.path.join(tmp, "home", ".claude")
H.CC_HOMES = {"root": {"label": "Fixture home", "base": base, "projects": os.path.join(base, "projects"), "writable": True},
              "winarchive": {"label": "Fixture archive", "base": None, "projects": os.path.join(tmp, "winarch"), "writable": False}}
os.makedirs(os.path.join(tmp, "winarch"), exist_ok=True)
H.CC_CACHE = os.path.join(tmp, "cache"); H.CC_STOP_STATE = os.path.join(H.CC_CACHE, "stops.json")
AUDIT = []
H.audit = lambda action, detail: AUDIT.append([action, detail])
def no_db(*a, **k): raise H.CCError("no database in tests")
H.cc_bridge = no_db
out = {}
def attempt(name, fn):
    try:
        out[name] = {"ok": True, "data": H.cc_redact_deep(fn())}
    except H.CCError as e:
        out[name] = {"ok": False, "error": str(e)}

attempt("list", lambda: H.cc_sessions_list({}))
attempt("get", lambda: H.cc_session_get("root", s1, {"per_page": 40}))
attempt("get_p1", lambda: H.cc_session_get("root", s1, {"per_page": 5, "page": 1}))
attempt("agent", lambda: H.cc_session_get("root", s1, {"agent": "a1b2c3d4e5f6"}))
attempt("bad_uuid", lambda: H.cc_session_get("root", "../../etc/passwd", {}))
attempt("bad_home", lambda: H.cc_session_get("../x", s1, {}))
attempt("bad_agent", lambda: H.cc_session_get("root", s1, {"agent": "../../../etc/passwd"}))
attempt("bad_memfile", lambda: H.cc_memfile_path("..", "passwd.md"))
attempt("bad_memfile2", lambda: H.cc_memfile_path("-root-proj", "../../x.md"))
attempt("readonly_home", lambda: H.cc_session_rename("winarchive", s1, {"title": "x", "actor": "t"}))
attempt("no_actor", lambda: H.cc_session_rename("root", s2, {"title": "x"}))
attempt("bad_title", lambda: H.cc_session_rename("root", s2, {"title": "a\nb", "actor": "t"}))

# A live sessions/<pid>.json for S2, backed by a harmless sleep: rename and
# archive must refuse, and Stop must refuse because sleep is not claude.
sleeper = subprocess.Popen(["sleep", "30"])
with open(os.path.join(base, "sessions", "%d.json" % sleeper.pid), "w") as fh:
    json.dump({"pid": sleeper.pid, "sessionId": s2, "cwd": "/root/proj", "status": "idle",
               "entrypoint": "cli", "procStart": str(H.cc_proc(sleeper.pid)["start_ticks"])}, fh)
attempt("rename_running", lambda: H.cc_session_rename("root", s2, {"title": "x", "actor": "t"}))
attempt("archive_running", lambda: H.cc_session_move("root", s2, {"actor": "t"}, restore=False))
attempt("stop_not_claude", lambda: H.cc_stop({"pid": sleeper.pid, "actor": "t"}))
attempt("stop_unknown_pid", lambda: H.cc_stop({"pid": os.getpid(), "actor": "t"}))
attempt("stop_bad_pid", lambda: H.cc_stop({"pid": "1; rm -rf /", "actor": "t"}))
attempt("force_without_stop", lambda: H.cc_stop({"pid": sleeper.pid, "actor": "t", "force": True}))
attempt("running", lambda: H.cc_running())
sleeper.kill(); sleeper.wait()
os.unlink(os.path.join(base, "sessions", "%d.json" % sleeper.pid))
attempt("sleeper_alive", lambda: H.cc_proc(sleeper.pid) is not None and H.cc_proc(sleeper.pid)["state"] != "Z")

attempt("rename", lambda: H.cc_session_rename("root", s2, {"title": "Log rotation", "actor": "tester"}))
side = os.path.join(base, "projects", "-root-proj", s2, "custom-title.json")
out["sidecar"] = json.load(open(side)) if os.path.exists(side) else None
with open(os.path.join(base, "projects", "-root-proj", s2 + ".jsonl"), "rb") as fh:
    out["tail_records"] = [json.loads(l) for l in fh.read().splitlines()[-2:]]
for p in (os.path.join(base, "projects", "-root-proj", s2 + ".jsonl"),):
    os.utime(p, (time.time() - 3600, time.time() - 3600))
attempt("list_after_rename", lambda: H.cc_sessions_list({"q": "rotation"}))
attempt("archive", lambda: H.cc_session_move("root", s2, {"actor": "tester"}, restore=False))
arch = os.path.join(base, "archive", "dashboard-archived", "-root-proj")
out["archived_files"] = sorted(os.listdir(arch)) if os.path.isdir(arch) else []
attempt("list_archived", lambda: H.cc_sessions_list({"archived": True}))
attempt("restore", lambda: H.cc_session_move("root", s2, {"actor": "tester"}, restore=True))
out["restored_files"] = sorted(n for n in os.listdir(os.path.join(base, "projects", "-root-proj")) if n.startswith(s2))
out["redact"] = H.cc_redact("token sk-ant-oat01-" + "b" * 30 + " Bearer " + "c" * 30 +
    " CLAUDE_CODE_OAUTH_TOKEN=zzzzzzzzzzzzzzzz ghp_" + "d" * 36 +
    " password: s3cretvalue -----BEGIN RSA PRIVATE KEY-----\nMIIE\n-----END RSA PRIVATE KEY----- counts password: 132")
out["audit"] = AUDIT
print(json.dumps(out))
`;

const run = spawnSync("python3", ["-c", driver, HELPER, TMP, S1, S2], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
if (run.status !== 0) {
  console.error(run.stderr || run.stdout);
  process.exit(1);
}
const R = JSON.parse(run.stdout.trim().split("\n").pop());
const blob = JSON.stringify(R);

console.log("helper: listing and titles");
const list = R.list.data;
const row1 = list.rows.find((r) => r.uuid === S1);
const row2 = list.rows.find((r) => r.uuid === S2);
check("both fixture sessions listed", list.total === 2, JSON.stringify(list.rows.map((r) => r.uuid)));
check("newest custom-title record wins", row1 && row1.title === "Fixture <script>alert(1)</script> title", row1 && row1.title);
check("untitled session takes its first message, whitespace collapsed", row2 && row2.title === "How do I rotate the nginx logs?", row2 && row2.title);
check("turns count human prompts only (not tool results, meta, summaries)", row1 && row1.turns === 2, row1 && row1.turns);
check("subagent counted", row1 && row1.subagents === 1);
check("desktop-released session is flagged", row2 && row2.released === true);
check("indexed is unknown without a database", row1 && row1.indexed === null);

console.log("helper: transcript parsing and redaction");
const g = R.get.data;
check("three exchanges: prompt, prompt, summary", g.exchanges.length === 3 && g.exchanges.map((e) => e.kind).join() === "prompt,prompt,summary", g.exchanges.map((e) => e.kind).join());
const ex1 = g.exchanges[0];
const tools = ex1.items.filter((i) => i.t === "tool");
check("tool calls folded to name + key arg", tools.length === 2 && tools[0].name === "Bash" && tools[1].arg === "/etc/hosts");
check("tool output reduced to its size", tools[0].size === HUGE.length && !blob.includes("XXXXXXXXXXXXXXXXXXXX"));
check("tool error flagged", tools[1].error === true);
check("thinking counted, not shown", ex1.thinking === 1);
check("system-reminder stripped from the prompt", !ex1.user.includes("hidden reminder") && ex1.user.startsWith("Deploy it."));
check("attachments noted in text", g.exchanges[1].user.includes("[1 attachment]"));
check("compaction note carried", g.exchanges[2].items.some((i) => i.t === "note" && /compacted/.test(i.text)));
check("model and cwd read from the transcript", g.model === "claude-opus-5-5" && g.cwd === "/root/proj");
check("resume command offered for a root session", g.resume === "cd /root/proj && claude --resume " + S1, g.resume);
check("no Anthropic key survives", !blob.includes(SECRET_KEY) && !blob.includes("sk-ant-api03"));
check("no password survives", !blob.includes(SECRET_PW));
check("no bearer token survives", !blob.includes(SECRET_BEARER));
check("paging: page size 5 still 1 page", R.get_p1.data.pages === 1 && R.get_p1.data.page === 1);

const a = R.agent.data;
check("subagent read with its meta", a.agent === "a1b2c3d4e5f6" && a.agent_meta && a.agent_meta.type === "general-purpose");
check("finished subagent reports done", a.agent_meta && a.agent_meta.status === "done");
check("subagent tool line", a.exchanges[0].items.some((i) => i.t === "tool" && i.arg === "TODO in /root/proj"));

console.log("helper: refusals");
const refused = (k, re) => check(k + " refused", R[k] && R[k].ok === false && re.test(R[k].error), JSON.stringify(R[k]));
refused("bad_uuid", /session id/);
refused("bad_home", /unknown Claude home/);
refused("bad_agent", /subagent id/);
refused("bad_memfile", /project folder/);
refused("bad_memfile2", /memory file name/);
refused("readonly_home", /read-only/);
refused("no_actor", /actor/);
refused("bad_title", /not allowed/);
refused("rename_running", /running/);
refused("archive_running", /running/);
refused("stop_not_claude", /not a Claude Code CLI/);
refused("stop_unknown_pid", /not a Claude Code session/);
refused("stop_bad_pid", /integer/);
refused("force_without_stop", /not a Claude Code CLI|ordinary stop/);
check("refused stops are audited", R.audit.filter((x) => x[0] === "cc-stop-refused").length >= 3);
check("no signal was ever sent", !R.audit.some((x) => x[0] === "cc-stop"));
const run1 = R.running.data;
const fake = run1.sessions.find((s) => s.session_id === S2);
check("running view sees the fixture session as alive but not claude", fake && fake.alive === true && fake.claude === false);
check("running view never carries argv or environment", !/"(cmdline|argv|environ)"/.test(JSON.stringify(run1)));

console.log("helper: rename, archive, restore");
check("rename ok", R.rename.ok, JSON.stringify(R.rename));
check("rename appends custom-title and agent-name records", R.tail_records[0].type === "custom-title" && R.tail_records[0].customTitle === "Log rotation" && R.tail_records[1].type === "agent-name");
check("rename writes custom-title.json", R.sidecar && R.sidecar.customTitle === "Log rotation");
check("renamed title is what the list shows", R.list_after_rename.data.rows[0].title === "Log rotation");
check("archive moves jsonl, folder and desktop-released marker", R.archive.ok && R.archived_files.join() === [S2, S2 + ".desktop-released.json", S2 + ".jsonl"].sort().join(), R.archived_files.join());
check("archived filter lists it", R.list_archived.data.total === 1 && R.list_archived.data.rows[0].archived === true);
check("restore brings all three back", R.restore.ok && R.restored_files.length === 3, R.restored_files.join());
check("writes are audited with the actor", ["cc-session-rename", "cc-session-archive", "cc-session-restore"].every((act) => R.audit.some((x) => x[0] === act && x[1].by === "tester")));

console.log("helper: redaction patterns");
const red = R.redact;
check("sk-ant, Bearer, OAuth env, ghp_, password, PEM all masked",
  !/sk-ant-oat01-b|ccccccccccccccc|zzzzzzzzzzzzzzzz|ghp_d|s3cretvalue|MIIE/.test(red), red);
check("a counter named password is left alone", /password: 132/.test(red), red);

/* --------------------------------------------------------------- views --- */

console.log("views: rendering");
const priv = require(path.join(ROOT, "lib", "priv"));
const rbac = require(path.join(ROOT, "lib", "rbac"));
const views = require(path.join(ROOT, "lib", "views-claude"));
const admin = { name: "admin", roleLabel: "Administrator", perm: rbac.actor({ permissions: ["*"] }) };
const viewer = { name: "v", roleLabel: "Viewer", perm: rbac.actor(rbac.SYSTEM_ROLES.find((r) => r.name === "viewer")) };
const operator = rbac.actor(rbac.SYSTEM_ROLES.find((r) => r.name === "operator"));

const bad = (html) => {
  const m = html.match(/undefined|NaN|\[object Object\]|<script>alert/);
  return m ? m[0] : null;
};
const pages = {
  session: views.session({ csrf: "tok", user: admin, s: priv.redactDeep(g) }),
  subagent: views.session({ csrf: "tok", user: admin, s: a }),
  sessions: views.sessions({ csrf: "tok", user: admin, data: list, filters: { home: "", project: "", q: "", archived: false } }),
  running: views.live({ csrf: "tok", user: admin, r: run1, team: null, counts: {} }), // Sessions ▸ Live (was Running)
  memory: views.memory({
    csrf: "tok",
    user: admin,
    query: "x",
    searchProject: "",
    filters: { topic: "", project: "", superseded: false, q: "", page: 1 },
    stats: { db: { facts: { current: 3, superseded: 1, forgotten: 1 }, chunks: { transcript: 5 }, sessions_indexed: 1, db_bytes: 1024, last_ingest: null, last_facts: null, topics: ["a"], projects: ["joya"] }, health: { ok: true, model: "m", dims: 768 } },
    facts: { total: 1, page: 1, per_page: 25, rows: [{ id: 7, content: "<img src=x onerror=1>", topic: "t.x", ts: ts(1), superseded_by: null, meta: { kind: "fact" } }] },
    files: [{ project: "-root-joya", name: "MEMORY.md", bytes: 10, modified: ts(1) }],
    hooks: [{ ts: "2026-09-27T12:00:00", event: "Stop", detail: { ingest: true, ms: 1.1 } }],
    services: null,
    search: { results: [{ kind: "chunk", id: 1, score: 0.1, content: "hello", ts: ts(1), session_id: S1, source: "transcript" }], timing_ms: 12 },
    errors: { services: "unavailable" },
  }),
};
for (const [name, html] of Object.entries(pages)) {
  check(name + " renders without undefined/NaN/raw script", !bad(html), bad(html));
}
check("session title is escaped", pages.session.includes("Fixture &lt;script&gt;alert(1)&lt;/script&gt; title"));
check("fact content is escaped", pages.memory.includes("&lt;img src=x onerror=1&gt;"));
check("assistant markup is escaped", pages.session.includes("Done &lt;b&gt;bold&lt;/b&gt;."));
check("running page is marked for live refresh", pages.running.includes("data-cc-running") && pages.running.includes('data-cc-section="sessions"'));
check("no Stop button for a non-claude pid", !pages.running.includes('name="pid" value="' + (fake && fake.pid) + '"'));
const readOnly = views.session({ csrf: "tok", user: viewer, s: g });
check("a role without manage sees no rename form", !readOnly.includes("/rename"));
check("stock roles do not carry any claude.* permission", !operator.permissions.some((p) => p.startsWith("claude.")) && !viewer.perm.permissions.some((p) => p.startsWith("claude.")));
check("write implies read", rbac.closure(["claude.memory.write", "claude.running.stop", "claude.sessions.manage"]).join() ===
  ["claude.memory.read", "claude.memory.write", "claude.running.stop", "claude.running.view", "claude.sessions.manage", "claude.sessions.view"].join());
check("claude permissions open the OS dashboard", rbac.actor({ permissions: ["claude.running.view"] }).canDash("os"));

console.log("priv: second redaction pass");
const p2 = priv.redact("Authorization: Bearer " + SECRET_BEARER + " CLAUDE_CODE_OAUTH_TOKEN=abc123def -----BEGIN OPENSSH PRIVATE KEY-----\nxx\n-----END OPENSSH PRIVATE KEY----- " + SECRET_KEY);
check("priv.redact masks bearer, oauth env, PEM, sk-ant", !p2.includes(SECRET_BEARER) && !p2.includes("abc123def") && !p2.includes("xx\n") && !p2.includes("sk-ant-api03"), p2);

fs.rmSync(TMP, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
