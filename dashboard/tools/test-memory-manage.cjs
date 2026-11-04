#!/usr/bin/env node
"use strict";
/**
 * Memory > Sessions: hide, unhide and delete Claude Code memory by session.
 *
 *   node dashboard/tools/test-memory-manage.cjs
 *
 *   rbac      claude.memory.manage exists, implies write and read, and only the
 *             administrator holds it out of the box
 *   views     the Sessions view, one session's page, the two delete confirmations:
 *             controls only for claude.memory.manage, live and not-installed
 *             warnings, escaping, the page map's new Memory tabs
 *   helper    deploy/joya-helper loaded as a module with its database bridge
 *             replaced by a recorder: validation, the live-session rule, typed
 *             name, the installed-ingest rule, confirmed counts, transcript
 *             deletion in throwaway Claude homes (read-only copies kept),
 *             naming (JOYA AI, hired, titles), audit with counts only
 *   routes    a scratch copy of the server (helper cut off, answers canned and
 *             recorded): permissions, CSRF, what each route sends, delete never
 *             on the first POST
 *
 * The database side (every read path against a scratch copy of claude_memory)
 * is dashboard/tools/test-memory-manage-db.py. This file touches nothing live.
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
    console.log("  FAIL " + name + (detail ? "\n       " + String(detail).slice(0, 400) : ""));
  }
}

const S1 = "11111111-2222-4333-8444-555555555555";
const S2 = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

/* ---------------------------------------------------------------- rbac --- */

console.log("rbac");
const rbac = require(path.join(ROOT, "lib", "rbac"));
check("claude.memory.manage is a permission", rbac.PERMISSION_SET.has("claude.memory.manage"));
const clo = rbac.closure(["claude.memory.manage"]);
check("it implies write and read", clo.includes("claude.memory.write") && clo.includes("claude.memory.read"), clo);
const adminAct = rbac.actor({ permissions: ["*"] });
check("the administrator holds it", adminAct.can("claude.memory.manage"));
for (const r of rbac.SYSTEM_ROLES.filter((x) => x.name !== "administrator")) {
  check(r.name + " does not", !rbac.actor(r).can("claude.memory.manage"));
}

/* --------------------------------------------------------------- views --- */

console.log("views");
const views = require(path.join(ROOT, "lib", "views-claude"));
const admin = { name: "admin", roleLabel: "Administrator", perm: adminAct };
const reader = { name: "r", roleLabel: "Reader", perm: rbac.actor({ permissions: rbac.closure(["claude.memory.write"]) }) };
const bad = (html) => {
  const m = html.match(/undefined|NaN|\[object Object\]|<script>alert/);
  return m ? m[0] : null;
};

const row = (o) =>
  Object.assign(
    {
      session_id: S1, name: "Giza Odoo Automation", origin: "Desktop / CLI (root)", project: "joya", machine: "vps",
      machine_label: "This server", first: "2026-09-27T10:00:00+00:00", last: "2026-10-04T10:00:00+00:00",
      chunks: 428, chunks_hidden: 2, facts: 156, facts_hidden: 1, facts_superseded: 35, live: false, live_reason: null,
      excluded: null, transcripts: 1, transcripts_writable: 1, title: "x",
    },
    o || {}
  );
const LIST = {
  ready: true,
  caps: { hidden: true, excluded: true, tombstones: true },
  sessions: [
    row(),
    row({ session_id: S2, name: "<script>alert(1)</script> JOYA AI", origin: "JOYA AI", live: true, live_reason: "JOYA AI's current session", last: "2026-10-04T11:00:00+00:00", chunks: 27, facts: 6 }),
    row({ session_id: "cccccccc-bbbb-4ccc-8ddd-eeeeeeeeeeee", name: "Contabo VPS setup", origin: "Old Windows session", machine_label: "Windows laptop", project: "scratch", last: "2026-09-21T10:00:00+00:00", chunks: 76, facts: 30, chunks_hidden: 0, facts_hidden: 0, excluded: { excluded_at: "2026-10-04T10:00:00+00:00" } }),
  ],
};

let s = views.mmSortSessions(LIST.sessions, {});
check("sessions sort by last activity, newest first, by default", s.rows[0].session_id === S2 && s.sort === "last" && s.dir === "desc");
s = views.mmSortSessions(LIST.sessions, { sort: "name" });
check("by name ascending", s.rows[0].name.startsWith("<script>") && s.rows[1].name === "Contabo VPS setup" && s.dir === "asc", s.rows.map((r) => r.name));
s = views.mmSortSessions(LIST.sessions, { sort: "chunks", dir: "asc" });
check("by chunks, ascending on request", s.rows.map((r) => r.chunks).join() === "27,76,428");
s = views.mmSortSessions(LIST.sessions, { q: "windows" });
check("search matches the origin or machine", s.rows.length === 1 && s.rows[0].project === "scratch");
s = views.mmSortSessions(LIST.sessions, { q: "aaaaaaaa" });
check("search matches the session id", s.rows.length === 1 && s.rows[0].session_id === S2);
s = views.mmSortSessions(LIST.sessions, { sort: "evil" });
check("an unknown sort falls back to last activity", s.sort === "last");

const memBase = {
  csrf: "tok", user: admin, query: "", searchProject: "",
  filters: { topic: "", project: "", superseded: false, q: "", page: 1 },
  stats: null, facts: null, files: [], hooks: [], services: null, search: null, errors: {},
};
const memSessions = views.memory(Object.assign({}, memBase, { view: "sessions", mm: LIST, mmQuery: {} }));
check("Memory renders the Sessions view", /data-view-panel="sessions"(?! hidden)/.test(memSessions) && !bad(memSessions), bad(memSessions));
check("the view switch has Graph, List, Sessions, Overview", ["graph", "list", "sessions", "overview"].every((v) => memSessions.includes('data-view="' + v + '"')));
check("session names are escaped", memSessions.includes("&lt;script&gt;alert(1)&lt;/script&gt; JOYA AI") && !memSessions.includes("<script>alert(1)"));
check("each session links to its page", memSessions.includes('href="/claude/memory/session/' + S1 + '"'));
check("a live session is marked", /JOYA AI<\/a> <span class="pill warn"[^>]*>live</.test(memSessions));
check("an excluded session is marked", memSessions.includes(">excluded</span>"));
check("hidden counts are shown", memSessions.includes("(2 hidden)") && memSessions.includes("1 hidden"));
check("the backup note is there", memSessions.includes("/root/backups/claude_memory_*.dump"));
check("column headers sort", memSessions.includes("sort=facts") && memSessions.includes('aria-sort="descending"'));
const memGraph = views.memory(Object.assign({}, memBase, { view: "graph", mm: LIST, mmQuery: {} }));
check("on another view the Sessions panel is present but hidden", memGraph.includes('data-view-panel="sessions" hidden'));
const notReady = views.memory(Object.assign({}, memBase, { view: "sessions", mm: Object.assign({}, LIST, { ready: false }), mmQuery: {} }));
check("before the claude-memory update the list says it is read-only", notReady.includes("deploy/claude-memory-manage/install.sh"));
const mmErr = views.memory(Object.assign({}, memBase, { view: "sessions", mm: null, mmErr: "db down", mmQuery: {} }));
check("a helper error is shown, not thrown", mmErr.includes("db down"));

const DETAIL = {
  ready: true,
  caps: LIST.caps,
  session: row(),
  filters: { q: "", topic: "", status: "", show: "" },
  page: 1,
  per_page: 50,
  facts_total: 2,
  chunks_total: 2,
  topics: [{ topic: "odoo.planning", n: 2 }],
  facts: [
    { id: 41, topic: "odoo.planning", ts: "2026-10-01T10:00:00+00:00", superseded_by: null, kind: "decision", content: "<b>fact</b> one", chars: 15 },
    { id: 42, topic: "odoo.planning", ts: "2026-10-01T10:00:00+00:00", superseded_by: 42, kind: "fact", forgotten: "hidden from the dashboard", content: "fact two", chars: 8 },
  ],
  chunks: [
    { id: 901, role: "exchange", ts: "2026-10-01T10:00:00+00:00", turn_index: 3, hidden: false, content: "User: hello <img src=x onerror=1>", chars: 40 },
    { id: 902, role: "summary", ts: "2026-10-01T10:00:00+00:00", turn_index: 4, hidden: true, content: "summary", chars: 7, agent_type: "Explore" },
  ],
};
const det = views.sessionMemory({ csrf: "tok", user: admin, data: DETAIL, uuid: S1 });
check("a session's page renders", !bad(det), bad(det));
check("its facts and chunks are listed with their status", det.includes("#41") && det.includes(">hidden</span>") && det.includes("turn 4") && det.includes("subagent Explore"));
check("content is escaped", det.includes("&lt;b&gt;fact&lt;/b&gt;") && det.includes("&lt;img src=x onerror=1&gt;"));
check("an administrator gets a box per fact and chunk", det.includes('name="f" value="41"') && det.includes('name="c" value="902"'));
check("…and select-all boxes", det.includes('data-mm-all="f"') && det.includes('data-mm-all="c"'));
check("the bulk form posts to apply with the CSRF token", det.includes('action="/claude/memory/session/' + S1 + '/apply"') && det.includes('name="_csrf" value="tok"'));
check("hide / unhide / delete for the selection", ["hide-items", "unhide-items", "delete-items"].every((o) => det.includes('value="' + o + '"')));
check("whole-session hide, unhide and delete", det.includes('value="hide-session"') && det.includes('value="unhide-session"') && det.includes("/delete\""));
check("the filters: text, topic, status, show", ['name="q"', 'name="topic"', 'name="status"', 'name="show"'].every((x) => det.includes(x)) && det.includes("odoo.planning (2)"));
check("no filtered actions without a filter", !det.includes("hide-filtered"));
const detF = views.sessionMemory({ csrf: "tok", user: admin, data: Object.assign({}, DETAIL, { filters: { q: "walrus", topic: "", status: "", show: "" } }), uuid: S1 });
check("with a filter, act on everything it matches", detF.includes("hide-filtered") && detF.includes("delete-filtered") && detF.includes('name="f_q" value="walrus"'));
const detLive = views.sessionMemory({ csrf: "tok", user: admin, data: Object.assign({}, DETAIL, { session: row({ live: true, live_reason: "JOYA AI's current session" }) }), uuid: S1 });
check("a live session is warned about", detLive.includes("This session is live") && detLive.includes("JOYA AI&#39;s current session"));
check("…and offers no whole-session hide or delete", !detLive.includes('value="hide-session"') && !detLive.includes("/delete\""));
check("…but single items can still be selected", detLive.includes('name="f" value="41"'));
const detReader = views.sessionMemory({ csrf: "tok", user: reader, data: DETAIL, uuid: S1 });
check("without claude.memory.manage: read-only, no boxes or actions", !detReader.includes('name="f"') && !detReader.includes("/apply") && !detReader.includes("hide-session") && detReader.includes("#41"));
const detNR = views.sessionMemory({ csrf: "tok", user: admin, data: Object.assign({}, DETAIL, { ready: false }), uuid: S1 });
check("before the update: a warning and no actions", detNR.includes("install.sh") && !detNR.includes('name="f"'));
const detEx = views.sessionMemory({ csrf: "tok", user: admin, data: Object.assign({}, DETAIL, { session: row({ excluded: { excluded_at: "2026-10-04T10:00:00+00:00", excluded_by: "amr" } }) }), uuid: S1 });
check("an excluded session offers Allow re-indexing", detEx.includes("/reindex") && detEx.includes("excluded from indexing"));
const detErr = views.sessionMemory({ csrf: "tok", user: admin, data: null, uuid: S1, err: "nothing from this session is in memory" });
check("a missing session says so", detErr.includes("nothing from this session is in memory") && !bad(detErr));

const conf = views.mmConfirmDelete({
  csrf: "tok", user: admin, uuid: S1,
  preview: { session: row(), facts: 2, facts_active: 1, facts_hidden: 1, facts_superseded: 0, chunks: 3, chunks_active: 3, chunks_hidden: 0 },
  body: { op: "delete-items", f: ["41", "42"], c: "901", f_q: "x\"><script>", _csrf: "tok", confirmed: "0" },
});
check("bulk delete asks first, with the counts", conf.includes("<strong>2 facts</strong>") && conf.includes("<strong>3 chunks</strong>") && conf.includes("Delete 5 items"));
check("…re-posting the same selection and the counts", conf.includes('name="f" value="41"') && conf.includes('name="f" value="42"') && conf.includes('name="c" value="901"') && conf.includes('name="expect_facts" value="2"') && conf.includes('name="expect_chunks" value="3"') && conf.includes('name="confirmed" value="1"'));
const confCard = conf.slice(conf.indexOf('id="mm-confirm"'));
check("…escaped, and never carrying the old CSRF field twice", conf.includes("x&quot;&gt;&lt;script&gt;") && (confCard.match(/name="_csrf"/g) || []).length === 1);
const conf0 = views.mmConfirmDelete({ csrf: "tok", user: admin, uuid: S1, preview: { session: row(), facts: 0, chunks: 0 }, body: {} });
check("nothing left to delete: no delete button", !conf0.includes('class="btn danger"') && conf0.includes("Nothing is selected"));
const cs = views.mmConfirmSession({ csrf: "tok", user: admin, uuid: S1, preview: { session: row({ transcripts: 2, transcripts_writable: 1 }), facts: 191, chunks: 428 } });
check("session delete: counts, typed name, the transcript option", cs.includes("191 facts") && cs.includes('data-mm-typed="Giza Odoo Automation"') && cs.includes('name="delete_files"') && cs.includes("1 read-only archive copy is always kept"));
check("…and the exclusion is explained", cs.includes("exclusion list"));
const cs0 = views.mmConfirmSession({ csrf: "tok", user: admin, uuid: S1, preview: { session: row({ transcripts: 0, transcripts_writable: 0 }), facts: 1, chunks: 1 } });
check("no transcript on disk: the option is disabled", /name="delete_files" value="1" disabled/.test(cs0));

const reg = require(path.join(ROOT, "lib", "page-registry")).build();
const memTabs = reg.filter((e) => e.parent === "memory").map((e) => e.key);
check("the page map lists Memory's four views", ["memory.graph", "memory.list", "memory.sessions", "memory.overview"].every((k) => memTabs.includes(k)), memTabs);

/* -------------------------------------------------------------- helper --- */

console.log("helper");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "mm-test-"));
const driver = String.raw`
import importlib.machinery, importlib.util, json, os, sqlite3, sys, time
spec = importlib.util.spec_from_loader("joya_helper", importlib.machinery.SourceFileLoader("joya_helper", sys.argv[1]))
H = importlib.util.module_from_spec(spec); spec.loader.exec_module(H)
tmp, S1, S2 = sys.argv[2], sys.argv[3], sys.argv[4]
H.AUDIT_LOG = os.path.join(tmp, "audit.log")
H.CC_CACHE = os.path.join(tmp, "cache")
H.CC_JOYA_STATE = os.path.join(tmp, "state.json")
H.CC_JOYA_LEDGER = os.path.join(tmp, "ledger.db")
H.CC_INGEST_PY = os.path.join(tmp, "ingest.py")
homes = os.path.join(tmp, "homes")
H.CC_HOMES = {
    "root": {"label": "Desktop / CLI (root)", "base": os.path.join(homes, "root"), "projects": os.path.join(homes, "root", "projects"), "writable": True},
    "winarchive": {"label": "Windows archive", "base": None, "projects": os.path.join(homes, "win"), "writable": False},
}
for p in (os.path.join(homes, "root", "projects", "-root-joya", S1, "subagents"), os.path.join(homes, "root", "sessions"), os.path.join(homes, "win", "C--x")):
    os.makedirs(p, exist_ok=True)
tp = os.path.join(homes, "root", "projects", "-root-joya", S1 + ".jsonl")
open(tp, "w").write(json.dumps({"type": "custom-title", "customTitle": "Fixture Title", "sessionId": S1}) + "\n")
open(os.path.join(homes, "win", "C--x", S1 + ".jsonl"), "w").write("{}\n")
old = time.time() - 3600
os.utime(tp, (old, old))
os.utime(os.path.join(homes, "win", "C--x", S1 + ".jsonl"), (old, old))
# a symlinked transcript elsewhere must never be followed or deleted
outside = os.path.join(tmp, "outside.jsonl"); open(outside, "w").write("keep\n")
os.symlink(outside, os.path.join(homes, "root", "projects", "-root-joya", S2 + ".jsonl"))
json.dump({"session_id": S2, "session_history": [{"session_id": "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", "retired_at": "2026-09-30T20:12:53Z"}]}, open(H.CC_JOYA_STATE, "w"))
con = sqlite3.connect(H.CC_JOYA_LEDGER); con.execute("CREATE TABLE hired_sessions (name TEXT, session_id TEXT, status TEXT)")
con.execute("INSERT INTO hired_sessions VALUES ('Baby Session', 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', 'retired')"); con.commit(); con.close()
open(H.CC_INGEST_PY, "w").write("# excluded_sessions memory_tombstones\n")

calls = []
def row(sid, **kw):
    r = {"session_id": sid, "first": "2026-10-01T00:00:00+00:00", "last": "2026-10-02T00:00:00+00:00", "chunks": 3, "chunks_hidden": 0,
         "summaries": 0, "project": "joya", "machine": "vps", "title": None, "subagents": 0, "facts": 2, "facts_hidden": 0,
         "facts_superseded": 0, "excluded": None}
    r.update(kw); return r
def fake_bridge(op, **kw):
    calls.append([op, kw])
    if op == "mm_sessions":
        rows = [row(S1), row(S2, title="old title"), row("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"), row("cccccccc-cccc-4ccc-8ccc-cccccccccccc"),
                row("dddddddd-dddd-4ddd-8ddd-dddddddddddd", machine="windows-laptop", title="<command-name>/login</command-name> hi")]
        if kw.get("session"):
            rows = [r for r in rows if r["session_id"] == kw["session"]]
        return {"sessions": rows, "caps": {"hidden": True, "excluded": True, "tombstones": True}}
    if op == "mm_apply":
        return {"action": kw["action"], "facts": len(kw.get("facts") or []), "chunks": len(kw.get("chunks") or [])}
    if op == "mm_delete_session":
        return {"facts": 2, "chunks": 3, "ingest_state": 2, "repointed": 0, "hidden_older": 1}
    if op == "mm_preview":
        return {"facts": 2, "chunks": 3}
    if op == "mm_reindex":
        return {"lifted": 1}
    return {}
H.cc_bridge = fake_bridge

out = {}
def attempt(name, fn, payload):
    try:
        out[name] = {"ok": True, "data": fn(payload)}
    except SystemExit:
        out[name] = {"ok": False, "error": "exit"}
    except H.CCError as e:
        out[name] = {"ok": False, "error": str(e)}

attempt("list", H.cc_mm_sessions, {})
attempt("bad_action", H.cc_mm_apply, {"actor": "amr", "session": S1, "action": "drop", "scope": "items", "facts": [1]})
attempt("bad_scope", H.cc_mm_apply, {"actor": "amr", "session": S1, "action": "hide", "scope": "all"})
attempt("bad_session", H.cc_mm_apply, {"actor": "amr", "session": "../etc", "action": "hide", "scope": "session"})
attempt("bad_actor", H.cc_mm_apply, {"actor": "a b;", "session": S1, "action": "hide", "scope": "session"})
attempt("empty_items", H.cc_mm_apply, {"actor": "amr", "session": S1, "action": "hide", "scope": "items", "facts": ["x", -1]})
attempt("bad_topic", H.cc_mm_apply, {"actor": "amr", "session": S1, "action": "hide", "scope": "filtered", "topic": "a b"})
attempt("hide_items", H.cc_mm_apply, {"actor": "amr", "session": S1, "action": "hide", "scope": "items", "facts": [1, "2", "x"], "chunks": [3]})
attempt("live_session_hide", H.cc_mm_apply, {"actor": "amr", "session": S2, "action": "hide", "scope": "session"})
attempt("live_session_delete_scope", H.cc_mm_apply, {"actor": "amr", "session": S2, "action": "delete", "scope": "session", "expect": {"facts": 2, "chunks": 3}})
attempt("live_session_unhide", H.cc_mm_apply, {"actor": "amr", "session": S2, "action": "unhide", "scope": "session"})
attempt("live_items_hide", H.cc_mm_apply, {"actor": "amr", "session": S2, "action": "hide", "scope": "items", "chunks": [5]})
attempt("delete_no_expect", H.cc_mm_apply, {"actor": "amr", "session": S1, "action": "delete", "scope": "items", "facts": [1]})
attempt("delete_bool_expect", H.cc_mm_apply, {"actor": "amr", "session": S1, "action": "delete", "scope": "items", "facts": [1], "expect": {"facts": True, "chunks": 0}})
attempt("delete_neg_expect", H.cc_mm_apply, {"actor": "amr", "session": S1, "action": "delete", "scope": "items", "facts": [1], "expect": {"facts": -1, "chunks": 0}})
attempt("delete_items", H.cc_mm_apply, {"actor": "amr", "session": S1, "action": "delete", "scope": "items", "facts": [1], "expect": {"facts": 1, "chunks": 0}})
attempt("del_live", H.cc_mm_delete_session, {"actor": "amr", "session": S2, "confirm": "JOYA AI"})
attempt("del_name", H.cc_mm_delete_session, {"actor": "amr", "session": S1, "confirm": "fixture title"})
open(H.CC_INGEST_PY, "w").write("# old ingest\n")
attempt("del_not_ready", H.cc_mm_delete_session, {"actor": "amr", "session": S1, "confirm": "Fixture Title"})
open(H.CC_INGEST_PY, "w").write("# excluded_sessions memory_tombstones\n")
attempt("del_ok", H.cc_mm_delete_session, {"actor": "amr", "session": S1, "confirm": "  Fixture Title ", "delete_files": True})
attempt("del_symlink_session", H.cc_mm_delete_session, {"actor": "amr", "session": "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", "confirm": "JOYA AI (retired 2026-09-30)", "delete_files": True})
attempt("reindex", H.cc_mm_reindex, {"actor": "amr", "session": S1})
out["files"] = {"transcript": os.path.exists(tp), "folder": os.path.exists(tp[:-6]), "win": os.path.exists(os.path.join(homes, "win", "C--x", S1 + ".jsonl")),
                "outside": os.path.exists(outside)}
out["calls"] = calls
out["audit"] = open(H.AUDIT_LOG).read() if os.path.exists(H.AUDIT_LOG) else ""
out["commands"] = sorted(k for k in H.COMMANDS if k.startswith("cc-mm-"))
print(json.dumps(out))
`;
const run = spawnSync("python3", ["-c", driver, HELPER, TMP, S1, S2], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
let R = null;
try {
  R = JSON.parse(run.stdout.trim().split("\n").pop());
} catch (e) {
  console.log(run.stdout.slice(-2000), run.stderr.slice(-2000));
}
check("the helper driver ran", !!R, run.stderr.slice(-500));
if (R) {
  const names = Object.fromEntries((R.list.data.sessions || []).map((x) => [x.session_id, x]));
  check("a transcript's custom title names the session", names[S1] && names[S1].name === "Fixture Title" && names[S1].origin === "Desktop / CLI (root)", JSON.stringify(names[S1]));
  check("JOYA AI's current session is named and live", names[S2] && names[S2].name === "JOYA AI" && names[S2].live && /current/.test(names[S2].live_reason));
  check("a retired JOYA AI session is named with its date", names["bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"].name === "JOYA AI (retired 2026-09-30)" && !names["bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"].live);
  check("a hired session is named from the ledger", names["cccccccc-cccc-4ccc-8ccc-cccccccccccc"].name === "Baby Session" && /Hired session/.test(names["cccccccc-cccc-4ccc-8ccc-cccccccccccc"].origin));
  check("an old Windows session says so, its title stripped of tags", names["dddddddd-dddd-4ddd-8ddd-dddddddddddd"].origin === "Old Windows session" && !/<command/.test(names["dddddddd-dddd-4ddd-8ddd-dddddddddddd"].name));
  check("both transcript copies are found; one is writable", names[S1].transcripts === 2 && names[S1].transcripts_writable === 1);
  check("the list reports the ingest update", R.list.data.ready === true);
  check("an unknown action is refused", !R.bad_action.ok && /unknown action/.test(R.bad_action.error));
  check("an unknown scope is refused", !R.bad_scope.ok && /unknown scope/.test(R.bad_scope.error));
  check("a malformed session id is refused", !R.bad_session.ok && /not a session id/.test(R.bad_session.error));
  check("a malformed actor is refused", !R.bad_actor.ok && /actor/.test(R.bad_actor.error));
  check("an empty selection is refused", !R.empty_items.ok && /nothing is selected/.test(R.empty_items.error));
  check("a malformed topic is refused", !R.bad_topic.ok && /topic/.test(R.bad_topic.error));
  const applied = R.calls.filter((c) => c[0] === "mm_apply");
  check("hide sends only well-formed ids, inside the one session", R.hide_items.ok && JSON.stringify(applied[0][1].facts) === "[1,2]" && JSON.stringify(applied[0][1].chunks) === "[3]" && applied[0][1].session === S1 && applied[0][1].actor === "amr");
  check("whole-session hide of a live session is refused", !R.live_session_hide.ok && /live/.test(R.live_session_hide.error) && /current/.test(R.live_session_hide.error));
  check("whole-session delete of a live session is refused", !R.live_session_delete_scope.ok && /live/.test(R.live_session_delete_scope.error));
  check("whole-session unhide of a live session is allowed", R.live_session_unhide.ok);
  check("single items in a live session can be hidden, flagged live", R.live_items_hide.ok && R.live_items_hide.data.live === true);
  check("a delete without confirmed counts is refused", !R.delete_no_expect.ok && /counts/.test(R.delete_no_expect.error));
  check("counts must be whole numbers (not true, not negative)", !R.delete_bool_expect.ok && !R.delete_neg_expect.ok);
  check("a confirmed delete passes the counts to the bridge", R.delete_items.ok && JSON.stringify(applied[applied.length - 1][1].expect) === '{"facts":1,"chunks":0}');
  check("deleting a live session is refused", !R.del_live.ok && /live/.test(R.del_live.error));
  check("deleting needs the exact name", !R.del_name.ok && /name/.test(R.del_name.error));
  check("deleting is refused until ingest.py honours exclusions", !R.del_not_ready.ok && /ingest\.py/.test(R.del_not_ready.error));
  check("deleting with the name (surrounding spaces ignored) works", R.del_ok.ok && R.del_ok.data.chunks === 3);
  check("…the writable transcript and its folder are deleted", R.del_ok.ok && R.del_ok.data.files_removed === 2 && !R.files.transcript && !R.files.folder);
  check("…the read-only archive copy is kept and counted", R.files.win && (R.del_ok.data || {}).files_kept_readonly === 1);
  check("a symlinked transcript is never followed or deleted", R.files.outside && R.del_symlink_session.ok && R.del_symlink_session.data.files_removed === 0);
  check("the bridge is told whether files were deleted", R.calls.some((c) => c[0] === "mm_delete_session" && c[1].files_deleted === true));
  check("Allow re-indexing reaches the bridge", R.reindex.ok && R.calls.some((c) => c[0] === "mm_reindex" && c[1].session === S1));
  const lines = R.audit.trim().split("\n").map((l) => JSON.parse(l));
  check("every write is audited", ["cc-memory-hide", "cc-memory-delete", "cc-memory-delete-session", "cc-memory-reindex", "cc-memory-unhide"].every((a) => lines.some((l) => l.action === a)), lines.map((l) => l.action));
  check("the audit holds who, which session and counts -- no content", lines.every((l) => l.detail.by === "amr" && !/Fixture Title|keep/.test(JSON.stringify(l))) && lines.some((l) => l.detail.facts === 2 && l.detail.chunks === 3));
  check("the six subcommands are registered", R.commands.join() === "cc-mm-apply,cc-mm-delete-session,cc-mm-preview,cc-mm-reindex,cc-mm-session,cc-mm-sessions", R.commands);
}
fs.rmSync(TMP, { recursive: true, force: true });

/* -------------------------------------------------------------- routes --- */

async function routes() {
  console.log("routes");
  const { startScratch, DATA } = require("./scratch-server.cjs");
  const preview = { session: row(), facts: 2, facts_active: 2, facts_hidden: 0, facts_superseded: 0, chunks: 1, chunks_active: 1, chunks_hidden: 0, request: {} };
  const srv = await startScratch({
    recordCalls: true,
    fakeReads: {
      "cc-mm-sessions": LIST,
      "cc-mm-session": DETAIL,
      "cc-mm-preview": preview,
      "cc-mm-apply": { action: "hide", facts: 2, chunks: 1 },
      "cc-mm-delete-session": { facts: 191, chunks: 428, ingest_state: 3, files_removed: 2, files_kept_readonly: 1 },
      "cc-mm-reindex": { lifted: 1 },
    },
  });
  const calls = () => {
    try {
      return fs.readFileSync(path.join(DATA, "helper-calls.jsonl"), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
    } catch (_) {
      return [];
    }
  };
  const last = (sub) => {
    const c = calls().filter((x) => x.subcommand === sub);
    return c.length ? JSON.parse(c[c.length - 1].stdin || "{}") : null;
  };
  try {
    await srv.makeUser("admin1", "administrator");
    await srv.makeUser("reader1", "memreader", rbac.closure(["claude.memory.write"]));
    const a = await srv.signIn("admin1");
    const r = await srv.signIn("reader1");
    const base = "/claude/memory/session/" + S1;

    let res = await srv.req("GET", "/claude/memory?view=sessions&sq=giza&sort=facts", { cookie: a.cookie });
    check("GET Memory ▸ Sessions renders", res.status === 200 && res.body.includes("Giza Odoo Automation") && !res.body.includes("Contabo VPS setup"), res.status);
    res = await srv.req("GET", base + "?status=evil&show=chunks&topic=a%20b&q=walrus", { cookie: a.cookie });
    check("GET a session's page renders with controls", res.status === 200 && res.body.includes('name="f" value="41"'));
    const sent = last("cc-mm-session");
    check("…and sends only valid filters", sent && sent.session === S1 && sent.status === "" && sent.show === "chunks" && sent.topic === "" && sent.q === "walrus", JSON.stringify(sent));
    const csrf = srv.csrfOf(res.body);
    res = await srv.req("GET", "/claude/memory/session/not-a-uuid", { cookie: a.cookie });
    check("a malformed session id is a 404", res.status === 404);

    res = await srv.req("GET", base, { cookie: r.cookie });
    check("a reader sees the page without controls", res.status === 200 && !res.body.includes('name="f"'));
    const rcsrf = srv.csrfOf(res.body);
    res = await srv.req("POST", base + "/apply", { cookie: r.cookie, body: new URLSearchParams({ _csrf: rcsrf, op: "hide-items", f: "41" }).toString() });
    check("a reader cannot hide (403)", res.status === 403);
    res = await srv.req("POST", base + "/delete", { cookie: r.cookie, body: new URLSearchParams({ _csrf: rcsrf }).toString() });
    check("a reader cannot delete a session (403)", res.status === 403);

    const n0 = calls().length;
    res = await srv.req("POST", base + "/apply", { cookie: a.cookie, body: new URLSearchParams({ op: "hide-items", f: "41" }).toString() });
    check("no CSRF token: refused, nothing sent", res.status === 403 && calls().length === n0);

    let body = new URLSearchParams({ _csrf: csrf, op: "hide-items", f_q: "walrus" });
    body.append("f", "41");
    body.append("f", "42");
    body.append("c", "901");
    body.append("c", "x9");
    res = await srv.req("POST", base + "/apply", { cookie: a.cookie, body: body.toString() });
    let ap = last("cc-mm-apply");
    check("hide selected: redirects back with a message", res.status === 302 && /msg=Hidden/.test(res.headers.location || "") && /q=walrus/.test(res.headers.location || ""), res.headers.location);
    check("…sending the ids, the actor and the scope", ap && ap.action === "hide" && ap.scope === "items" && JSON.stringify(ap.facts) === "[41,42]" && JSON.stringify(ap.chunks) === "[901]" && ap.actor === "admin1", JSON.stringify(ap));

    res = await srv.req("POST", base + "/apply", { cookie: a.cookie, body: new URLSearchParams({ _csrf: csrf, op: "hide-items" }).toString() });
    check("nothing selected: an error, nothing sent", res.status === 302 && /err=Nothing/.test(res.headers.location || ""));
    res = await srv.req("POST", base + "/apply", { cookie: a.cookie, body: new URLSearchParams({ _csrf: csrf, op: "drop-table", f: "41" }).toString() });
    check("an unknown op is refused", res.status === 302 && /err=/.test(res.headers.location || ""));

    res = await srv.req("POST", base + "/apply", { cookie: a.cookie, body: new URLSearchParams({ _csrf: csrf, op: "hide-filtered", f_q: "walrus", f_status: "hidden", f_show: "bogus" }).toString() });
    ap = last("cc-mm-apply");
    check("hide all filtered sends the filters (cleaned)", ap.scope === "filtered" && ap.q === "walrus" && ap.status === "hidden" && ap.show === "", JSON.stringify(ap));

    const before = calls().filter((c) => c.subcommand === "cc-mm-apply").length;
    body = new URLSearchParams({ _csrf: csrf, op: "delete-items", f: "41" });
    body.append("c", "901");
    res = await srv.req("POST", base + "/apply", { cookie: a.cookie, body: body.toString() });
    check("delete selected: the first POST only asks, with counts", res.status === 200 && res.body.includes("Delete memory permanently?") && res.body.includes("<strong>2 facts</strong>"));
    check("…and deletes nothing", calls().filter((c) => c.subcommand === "cc-mm-apply").length === before);
    const c2 = srv.csrfOf(res.body);
    const confirmBody = new URLSearchParams({ _csrf: c2, op: "delete-items", f: "41", c: "901", confirmed: "1", expect_facts: "0", expect_chunks: "1" });
    res = await srv.req("POST", base + "/apply", { cookie: a.cookie, body: confirmBody.toString() });
    ap = last("cc-mm-apply");
    check("the confirming POST deletes, with the confirmed counts (zero included)", res.status === 302 && ap.action === "delete" && JSON.stringify(ap.expect) === '{"facts":0,"chunks":1}', JSON.stringify(ap));
    res = await srv.req("POST", base + "/apply", { cookie: a.cookie, body: new URLSearchParams({ _csrf: csrf, op: "delete-session" }).toString() });
    check("there is no whole-session delete without the typed name", res.status === 302 && /err=/.test(res.headers.location || ""));

    res = await srv.req("POST", base + "/delete", { cookie: a.cookie, body: new URLSearchParams({ _csrf: csrf }).toString() });
    check("delete session: the first POST asks for the name", res.status === 200 && res.body.includes('name="confirm"') && res.body.includes("Giza Odoo Automation") && !calls().some((c) => c.subcommand === "cc-mm-delete-session"));
    res = await srv.req("POST", base + "/delete", { cookie: a.cookie, body: new URLSearchParams({ _csrf: csrf, step: "confirm", confirm: "Giza Odoo Automation", delete_files: "1" }).toString() });
    const del = last("cc-mm-delete-session");
    check("…the second sends the typed name and the file choice", res.status === 302 && del && del.confirm === "Giza Odoo Automation" && del.delete_files === true && del.actor === "admin1", JSON.stringify(del));
    check("…and lands on the session list with what happened", /view=sessions/.test(res.headers.location || "") && /428%20chunks/.test(res.headers.location || "") && /read-only/.test(decodeURIComponent(res.headers.location || "")));
    res = await srv.req("POST", base + "/reindex", { cookie: a.cookie, body: new URLSearchParams({ _csrf: csrf }).toString() });
    check("Allow re-indexing", res.status === 302 && last("cc-mm-reindex").session === S1);
  } finally {
    srv.stop();
  }
}

routes()
  .catch((e) => {
    failed++;
    console.log("  FAIL routes threw: " + (e && e.stack));
  })
  .finally(() => {
    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
  });
