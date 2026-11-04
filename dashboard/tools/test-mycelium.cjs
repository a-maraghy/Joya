#!/usr/bin/env node
"use strict";
/**
 * Tests for the Machine core's mycelium: the helper's pulse-feed and
 * service-list, the dependency and failure-propagation logic, the server's
 * feed, and the views.
 *
 *   node dashboard/tools/test-mycelium.cjs
 *
 * The helper is loaded as a Python module with its log paths, agent and
 * channel directories and journal reader pointed at fixtures under a temp
 * directory, so nothing on the machine is read. The fixtures are full of
 * addresses, user names and message text; the tests check none of it comes
 * out. Needs python3 (and better-sqlite3 via NODE_PATH for the views); does
 * not need root.
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const HELPER = path.join(ROOT, "deploy", "joya-helper");
process.env.JOYA_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "myc-test-"));
const lib = (m) => require(path.join(ROOT, "lib", m));

let failed = 0;
let passed = 0;
function check(name, cond, detail) {
  if (cond) {
    passed++;
    console.log("  ok   " + name);
  } else {
    failed++;
    console.log("  FAIL " + name + (detail !== undefined ? "\n       " + JSON.stringify(detail).slice(0, 600) : ""));
  }
}

/* ------------------------------------------------------ helper fixtures --- */

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "myc-helper-"));
const SECRET_IP = "203.0.113.77";
const SECRET_USER = "mallory";
const SECRET_TEXT = "the launch code is swordfish";

const nowSec = Math.floor(Date.now() / 1000);
const pad = (n) => String(n).padStart(2, "0");
const localStamp = (sec) => {
  const d = new Date(sec * 1000);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
};
const nginxStamp = (sec) => {
  const d = new Date(sec * 1000);
  const mon = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][d.getUTCMonth()];
  return `${pad(d.getUTCDate())}/${mon}/${d.getUTCFullYear()}:${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())} +0000`;
};

fs.writeFileSync(path.join(TMP, "f2b.log"), [
  `${localStamp(nowSec - 60)},123 fail2ban.filter         [99]: INFO    [sshd] Found ${SECRET_IP} - ${localStamp(nowSec - 60)}`,
  `${localStamp(nowSec - 50)},456 fail2ban.actions        [99]: NOTICE  [sshd] Ban ${SECRET_IP}`,
  `${localStamp(nowSec - 40)},789 fail2ban.actions        [99]: NOTICE  [joya-dashboard] Unban ${SECRET_IP}`,
  `${localStamp(nowSec - 5 * 86400)},000 fail2ban.actions        [99]: NOTICE  [sshd] Ban 198.51.100.1`,
  "",
].join("\n"));
fs.writeFileSync(path.join(TMP, "hooks.log"), [
  `2026-09-28T10:52:44 Stop {"ingest": true, "agent": null, "ms": 1.1}`,
  `2026-09-28T10:52:59 UserPromptSubmit {"hits": 14, "chars": 3842}`,
  "",
].join("\n"));
for (const k of ["panel", "odoo", "other"]) {
  fs.writeFileSync(path.join(TMP, `web_${k}.log`),
    `${SECRET_IP} - ${SECRET_USER} [${nginxStamp(nowSec - 30)}] "GET /secret?token=abc HTTP/1.1" 200 1 "-" "curl"\n`);
}
fs.mkdirSync(path.join(TMP, "agents", "scout", "data"), { recursive: true });
fs.mkdirSync(path.join(TMP, "agents", "Bad..Slug"), { recursive: true });
fs.mkdirSync(path.join(TMP, "channels", "scout-tg"), { recursive: true });
fs.writeFileSync(path.join(TMP, "channels", "scout-tg", "channel.json"), JSON.stringify({ slug: "scout-tg", type: "telegram", agent: "scout", name: "@scout_bot" }));
fs.mkdirSync(path.join(TMP, "channels", "wa-one"), { recursive: true });
fs.writeFileSync(path.join(TMP, "channels", "wa-one", "channel.json"), JSON.stringify({ slug: "wa-one", type: "whatsapp", agent: "scout" }));

const J = (sec, fields) => JSON.stringify(Object.assign({ __REALTIME_TIMESTAMP: String(sec * 1e6), __CURSOR: "s=abc;i=" + sec.toString(16) + ";b=def;m=1;t=2;x=3" }, fields));
const journal = [
  J(nowSec - 100, { _SYSTEMD_UNIT: "ssh.service", MESSAGE: `Accepted publickey for ${SECRET_USER} from ${SECRET_IP} port 5555 ssh2: ED25519 SHA256:xyz` }),
  J(nowSec - 90, { _SYSTEMD_UNIT: "ssh.service", MESSAGE: `Connection closed by authenticating user root ${SECRET_IP} port 1 [preauth]` }),
  J(nowSec - 80, { _SYSTEMD_UNIT: "ssh.service", MESSAGE: `Received disconnect from ${SECRET_IP} port 1:11: Bye` }),
  J(nowSec - 70, { _PID: "1", JOB_TYPE: "start", JOB_RESULT: "done", UNIT: "odoo.service", MESSAGE: "Started odoo.service - Odoo." }),
  J(nowSec - 60, { _PID: "1", JOB_TYPE: "start", JOB_RESULT: "done", UNIT: "systemd-timedated.service", MESSAGE: "Started timedated." }),
  J(nowSec - 55, { _PID: "1", JOB_TYPE: "start", JOB_RESULT: "done", UNIT: "joya-agent@scout.service", MESSAGE: "Started agent." }),
  J(nowSec - 50, { _PID: "1", JOB_TYPE: "stop", JOB_RESULT: "done", UNIT: "nginx.service", MESSAGE: "Stopped nginx." }),
].join("\n");
fs.writeFileSync(path.join(TMP, "journal.jsonl"), journal + "\n");

const driver = String.raw`
import importlib.machinery, importlib.util, json, os, sqlite3, sys, time
spec = importlib.util.spec_from_loader("joya_helper", importlib.machinery.SourceFileLoader("joya_helper", sys.argv[1]))
H = importlib.util.module_from_spec(spec); spec.loader.exec_module(H)
tmp = sys.argv[2]
H.AGENTS_DIR = os.path.join(tmp, "agents")
H.CHANNELS_DIR = os.path.join(tmp, "channels")
H.PULSE_FILES = {"f2b": os.path.join(tmp, "f2b.log"), "hooks": os.path.join(tmp, "hooks.log"),
                 "web_panel": os.path.join(tmp, "web_panel.log"), "web_odoo": os.path.join(tmp, "web_odoo.log"),
                 "web_other": os.path.join(tmp, "web_other.log")}
db = os.path.join(tmp, "agents", "scout", "data", "bot.db")
con = sqlite3.connect(db)
con.execute("CREATE TABLE messages (message_id INTEGER PRIMARY KEY, session_id TEXT, user_id INTEGER, timestamp TIMESTAMP, prompt TEXT, response TEXT)")
now = time.time()
iso = lambda t: time.strftime("%Y-%m-%dT%H:%M:%S+00:00", time.gmtime(t))
con.execute("INSERT INTO messages VALUES (1, 's', 42, ?, ?, ?)", (iso(now - 3 * 86400), "old", "old reply"))
con.execute("INSERT INTO messages VALUES (2, 's', 42, ?, ?, ?)", (iso(now - 120), sys.argv[3], sys.argv[3]))
con.execute("INSERT INTO messages VALUES (3, 's', 42, ?, ?, NULL)", (iso(now - 110), "no answer"))
con.commit(); con.close()
entries = [json.loads(l) for l in open(os.path.join(tmp, "journal.jsonl")) if l.strip()]
CALLS = []
def fake_journal(argv):
    CALLS.append(argv)
    if "--after-cursor" in argv:
        c = argv[argv.index("--after-cursor") + 1]
        idx = [e["__CURSOR"] for e in entries].index(c)
        return entries[idx + 1:]
    return entries
H.pulse_journal = fake_journal
out = {}
def attempt(name, fn):
    try:
        out[name] = {"ok": True, "data": fn()}
    except SystemExit:
        out[name] = {"ok": False}
    except Exception as e:
        out[name] = {"ok": False, "error": type(e).__name__ + ": " + str(e)}
H.fail = lambda msg, code=2: (_ for _ in ()).throw(SystemExit(msg))
attempt("tracked", lambda: H.tracked_units())
attempt("first", lambda: H.pulse_feed(None))
cur = out["first"]["data"]["cursor"] if out["first"]["ok"] else None
# new lines arrive after the first call
with open(H.PULSE_FILES["f2b"], "a") as fh:
    fh.write(time.strftime("%Y-%m-%d %H:%M:%S") + ",001 fail2ban.actions        [99]: NOTICE  [sshd] Ban 192.0.2.9\n")
with open(H.PULSE_FILES["hooks"], "a") as fh:
    fh.write('2026-09-28T11:00:00 SessionEnd {"ingest": true}\n2026-09-28T11:00:01 Stop {"ingest": false}\n')
for k in ("web_panel", "web_odoo"):
    with open(H.PULSE_FILES[k], "a") as fh:
        fh.write("192.0.2.1 - - [x] \"GET / HTTP/1.1\" 200\n192.0.2.2 - - [x] \"GET / HTTP/1.1\" 200\n")
con = sqlite3.connect(db)
con.execute("INSERT INTO messages VALUES (4, 's', 42, ?, 'p', 'r')", (iso(now - 1),))
con.commit(); con.close()
attempt("next", lambda: H.pulse_feed(json.loads(json.dumps(cur))))
cur2 = out["next"]["data"]["cursor"] if out["next"]["ok"] else None
attempt("again", lambda: H.pulse_feed(cur2))
# log rotation: the file is replaced by a new, shorter one
os.rename(H.PULSE_FILES["web_panel"], H.PULSE_FILES["web_panel"] + ".1")
with open(H.PULSE_FILES["web_panel"], "w") as fh:
    fh.write("192.0.2.3 - - [x] \"GET / HTTP/1.1\" 200\n")
attempt("rotated", lambda: H.pulse_feed(out["again"]["data"]["cursor"]))
# an unreadable source is left out and named
H.PULSE_FILES["hooks"] = os.path.join(tmp, "missing.log")
attempt("missing", lambda: H.pulse_feed(out["rotated"]["data"]["cursor"]))
attempt("totals", lambda: H.pulse_totals())
bad = {
  "not_obj": "x", "extra_key": {"j": None, "z": 1}, "bad_journal": {"j": "s=1; rm -rf /"},
  "bad_file_key": {"f": {"passwd": [1, 2]}}, "bad_offset": {"f": {"f2b": [1, -5]}}, "offset_str": {"f": {"f2b": [1, "9"]}},
  "bad_slug": {"r": {"../x": 1}}, "bad_reply_id": {"r": {"scout": "1"}},
}
for k, v in bad.items():
    attempt("cursor_" + k, lambda v=v: H.pulse_check_cursor(v))
attempt("cursor_ok", lambda: H.pulse_check_cursor(cur))
# service-list: one systemctl call for all units, parsed per unit
SHOW = "\n".join([
  "MemoryCurrent=4550656", "Id=ssh.service", "LoadState=loaded", "ActiveState=active", "UnitFileState=disabled", "ActiveEnterTimestamp=Fri 2026-09-11 07:02:07 CEST", "",
  "Id=odoo.service", "LoadState=loaded", "ActiveState=failed", "UnitFileState=enabled", "ActiveEnterTimestamp=", "MemoryCurrent=[not set]", "",
  "Id=postgresql@16-main.service", "LoadState=loaded", "ActiveState=active", "UnitFileState=enabled-runtime", "ActiveEnterTimestamp=Wed 2026-09-23 06:51:45 CEST", "MemoryCurrent=18446744073709551615", "",
  "Id=joya-whatsapp@gone.service", "LoadState=not-found", "ActiveState=inactive", "UnitFileState=", "ActiveEnterTimestamp=", "MemoryCurrent=[not set]", "",
])
RUNS = []
class R:
    def __init__(s, out, rc=0): s.stdout, s.returncode, s.stderr = out, rc, ""
def fake_run(argv, **kw):
    RUNS.append(argv)
    if argv[:2] == ["systemctl", "show"]: return R(SHOW)
    if argv[:2] == ["systemctl", "is-enabled"]: return R("enabled\n" if argv[2] == "ssh.socket" else "disabled\n")
    return R("")
H.run = fake_run
attempt("states", lambda: H.service_states(["ssh", "odoo", "postgresql@16-main", "joya-whatsapp@gone"], {"joya-whatsapp@gone": "whatsapp"}))
out["runs"] = RUNS
out["journal_calls"] = CALLS
print(json.dumps(out))
`;

const run = spawnSync("python3", ["-c", driver, HELPER, TMP, SECRET_TEXT], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
if (run.status !== 0) {
  console.error(run.stderr || run.stdout);
  process.exit(1);
}
const R = JSON.parse(run.stdout.trim().split("\n").pop());

console.log("helper: tracked units");
const tracked = R.tracked.data || {};
check("managed and read-only system units are tracked", ["ufw", "fail2ban", "nginx", "ssh", "xrdp", "xrdp-sesman", "joya-dashboard", "odoo", "postgresql@16-main", "claude-memory", "joya-ai"].every((u) => tracked[u] === "system"), tracked);
check("one joya-agent@ unit per agent, bad slugs skipped", tracked["joya-agent@scout"] === "agent" && !Object.keys(tracked).some((k) => k.includes("Bad")), tracked);
check("a WhatsApp channel's bridge is tracked", tracked["joya-whatsapp@wa-one"] === "whatsapp", tracked);
check("joya-whisper is not tracked", !Object.keys(tracked).some((k) => k.includes("whisper")));

console.log("helper: pulse-feed");
const first = R.first.data || {};
const types = (d) => (d.events || []).map((e) => e.type + (e.unit ? ":" + e.unit : "") + (e.jail ? ":" + e.jail : "") + (e.agent ? ":" + e.agent : ""));
check("first call looks back: SSH, starts of tracked units, bans, replies", JSON.stringify(types(first).sort()) ===
  JSON.stringify(["ban:sshd", "reply:scout", "ssh-fail", "ssh-login", "start:joya-agent@scout", "start:odoo", "unban:joya-dashboard"].sort()), types(first));
check("untracked units and stops are not events", !types(first).some((t) => t.includes("timedated") || t.includes("nginx")));
check("an old ban outside the look-back is not replayed", types(first).filter((t) => t.startsWith("ban")).length === 1);
check("first call starts nginx and the hook log at the end", !types(first).includes("ingest") && !first.counts.web_panel);
check("the cursor has a journal cursor, file offsets and reply ids", first.cursor && /^s=/.test(first.cursor.j) && first.cursor.f.f2b.length === 2 && first.cursor.r.scout === 3, first.cursor);
const next = R.next.data || {};
check("next call: only what is new", JSON.stringify(types(next).sort()) === JSON.stringify(["ban:sshd", "ingest", "reply:scout"].sort()), types(next));
check("nginx requests are counted, not listed", next.counts.web_panel === 2 && next.counts.web_odoo === 2 && !next.counts.web_other, next.counts);
check("the journal resumes after the cursor", R.journal_calls.some((a) => a[0] === "--after-cursor"));
check("nothing new: nothing reported", (R.again.data.events || []).length === 0 && !R.again.data.counts.web_panel, R.again.data);
check("a rotated log is read from its start", R.rotated.data.counts.web_panel === 1, R.rotated.data.counts);
check("an unreadable source is named, the rest still reported", R.missing.ok && R.missing.data.unavailable.includes("memory-hooks"), R.missing);
check("every event has a type and an ISO time", [first, next].every((d) => d.events.every((e) => typeof e.type === "string" && /^\d{4}-\d\d-\d\dT/.test(e.at))));
check("event fields are limited to type, at, unit, jail, agent", [first, next].every((d) => d.events.every((e) => Object.keys(e).every((k) => ["type", "at", "unit", "jail", "agent"].includes(k)))));
const everything = JSON.stringify([R.first, R.next, R.again, R.rotated, R.missing, R.totals]);
check("no address, user name or message text leaves the helper", !everything.includes(SECRET_IP) && !everything.includes(SECRET_USER) &&
  !everything.includes("swordfish") && !everything.includes("192.0.2") && !everything.includes("token=abc") && !everything.includes("198.51.100"));

console.log("helper: 24 h totals");
const tot = (R.totals.data || {}).totals || {};
check("24 h counts per type", tot["ssh-login"] === 1 && tot["ssh-fail"] === 1 && tot.ban === 2 && tot.unban === 1 && tot.web_panel === 1 && tot.reply === 2, tot);
check("replies are counted per agent", tot.reply_by_agent && tot.reply_by_agent.scout === 2, tot);
check("unit starts are counted per unit", R.totals.data.starts.odoo === 1 && R.totals.data.starts["joya-agent@scout"] === 1, R.totals.data.starts);

console.log("helper: cursor validation");
for (const k of ["not_obj", "extra_key", "bad_journal", "bad_file_key", "bad_offset", "offset_str", "bad_slug", "bad_reply_id"]) {
  check("refuses a cursor: " + k, R["cursor_" + k] && R["cursor_" + k].ok === false, R["cursor_" + k]);
}
check("accepts the cursor it handed out", R.cursor_ok.ok === true, R.cursor_ok);

console.log("helper: service-list");
const st = R.states.data || [];
const by = Object.fromEntries(st.map((s) => [s.unit, s]));
check("one systemctl show for every unit", R.runs.filter((a) => a[1] === "show").length === 1, R.runs);
check("ssh reads as enabled via its socket", by.ssh && by.ssh.enabled === "enabled" && by.ssh.socket_activated === true && by.ssh.memory === 4550656, by.ssh);
check("a failed unit reads failed", by.odoo && by.odoo.active === "failed" && by.odoo.memory === null, by.odoo);
check("enabled-runtime reads enabled; an unset memory is null", by["postgresql@16-main"].enabled === "enabled" && by["postgresql@16-main"].memory === null, by["postgresql@16-main"]);
check("a unit that does not exist reads inactive", by["joya-whatsapp@gone"].active === "inactive" && by["joya-whatsapp@gone"].kind === "whatsapp");
check("only MANAGED_UNITS are managed", by.ssh.managed === true && by.odoo.managed === false && by.odoo.stoppable === false && by.ssh.stoppable === false);

/* ------------------------------------------------------------- the graph --- */

console.log("graph: dependencies");
const G = require(path.join(ROOT, "public", "mycelium-graph.js"));
const pulse = lib("pulse");
const catalog = lib("catalog");
const SERVICES = ["ufw", "fail2ban", "nginx", "ssh", "xrdp", "xrdp-sesman", "joya-dashboard", "odoo", "postgresql@16-main", "claude-memory", "joya-ai"]
  .map((u) => ({ unit: u, active: "active", kind: "system", since: "Sat 2026-09-26 06:22:45 CEST", memory: 22e6 }))
  .concat([{ unit: "joya-agent@admin", active: "active", kind: "agent", since: "", memory: 7e7 }]);
const CHANNELS = [{ slug: "admin-telegram", type: "telegram", agent: "admin", name: "@JOYA_OS_bot" }, { slug: "stray", type: "telegram", agent: "nobody" }];
const graph = pulse.buildGraph({ services: SERVICES, agents: [{ slug: "admin", name: "Admin <x>" }], channels: CHANNELS, detail: new Map(catalog.OS_SERVICES.map((s) => [s.unit, s])) });
const ids = graph.nodes.map((n) => n.id);
check("a node per tracked unit plus the channel inside its agent", graph.nodes.length === 13 && ids.includes("ch:admin-telegram") && !ids.includes("ch:stray"), ids);
check("no speech-to-text on the map", !ids.some((i) => /whisper/.test(i)) && !graph.nodes.some((n) => /Speech/.test(n.name)));
check("names come from the catalogue", graph.nodes.find((n) => n.id === "postgresql@16-main").name === "PostgreSQL 16" && graph.nodes.find((n) => n.id === "joya-agent@admin").name === "Agent · admin");
check("since is shortened, memory readable", graph.nodes[0].since === "Sat 26 Sep 06:22" && graph.nodes.find((n) => n.id === "fail2ban").mem === "21 MB", graph.nodes[0]);
check("every edge is one of the verified rules or a channel-in-agent", graph.edges.every((e) => pulse.EDGE_RULES.some((r) => r[0] === e.from && r[1] === e.to && r[2] === e.kind) ||
  (e.from.startsWith("ch:") && e.to.startsWith("joya-agent@") && e.kind === "hard")));
check("all 15 verified edges plus the channel's", graph.edges.length === 16, graph.edges.length);
const partial = pulse.buildGraph({ services: SERVICES.filter((s) => s.unit !== "odoo"), channels: [] });
check("edges to a unit not on the map are dropped", !partial.edges.some((e) => e.from === "odoo" || e.to === "odoo") && partial.edges.length === 13, partial.edges.length);

console.log("graph: failure propagation");
const fail = (id, state) => graph.nodes.map((n) => ({ id: n.id, channel: n.channel, state: n.id === id ? state || "failed" : "ok" }));
const eff = (id, state) => G.effects(fail(id, state), graph.edges);
const kinds = (e) => Object.fromEntries(Object.entries(e).map(([k, v]) => [k, v.k]));
check("PostgreSQL fails: Odoo and the memory service stop, JOYA AI and the panel partly down", JSON.stringify(kinds(eff("postgresql@16-main"))) === JSON.stringify({
  "postgresql@16-main": "failed", odoo: "down", "claude-memory": "down", "joya-ai": "degraded", "joya-dashboard": "degraded" }), kinds(eff("postgresql@16-main")));
check("nginx fails: the panel and Odoo are unreachable, not stopped", kinds(eff("nginx"))["joya-dashboard"] === "unreach" && kinds(eff("nginx")).odoo === "unreach" && !kinds(eff("nginx"))["postgresql@16-main"]);
check("the firewall fails: nginx and SSH run unprotected, fail2ban partly down", JSON.stringify(kinds(eff("ufw"))) === JSON.stringify({ ufw: "failed", nginx: "unguarded", ssh: "unguarded", fail2ban: "degraded" }), kinds(eff("ufw")));
check("SSH stops: the remote desktop is unreachable", kinds(eff("ssh", "inactive")).xrdp === "unreach" && kinds(eff("ssh", "inactive")).ssh === "inactive");
check("fail2ban fails: SSH and the panel run unprotected", kinds(eff("fail2ban")).ssh === "unguarded" && kinds(eff("fail2ban"))["joya-dashboard"] === "unguarded");
check("xrdp and its session manager take each other down", kinds(eff("xrdp"))["xrdp-sesman"] === "down" && kinds(eff("xrdp-sesman")).xrdp === "down");
check("an agent fails: its channel stops with it", kinds(eff("joya-agent@admin"))["ch:admin-telegram"] === "down");
check("the memory service fails: JOYA AI and the panel partly down, PostgreSQL untouched", JSON.stringify(kinds(eff("claude-memory"))) === JSON.stringify({ "claude-memory": "failed", "joya-ai": "degraded", "joya-dashboard": "degraded" }));
check("the worst effect wins", (() => { const n = fail("nginx"); n.find((x) => x.id === "fail2ban").state = "failed"; const e = G.effects(n, graph.edges); return e["joya-dashboard"].k === "unreach"; })());
const nm = (id) => (graph.nodes.find((n) => n.id === id) || {}).name;
check("effect sentences name the cause", G.effText(eff("postgresql@16-main"), "odoo", nm) === "Will stop: it requires PostgreSQL 16." &&
  /unprotected: Firewall is down/.test(G.effText(eff("ufw"), "ssh", nm)) && /unreachable/.test(G.effText(eff("nginx"), "odoo", nm)));
const ko = G.knockOn(graph.nodes, graph.edges, "postgresql@16-main");
check("'if it breaks' lists what goes down, worst first", ko[0].word === "stops" && ko.map((k) => k.id).join() === "odoo,claude-memory,joya-dashboard,joya-ai", ko);
const v = G.verdict(fail("postgresql@16-main"), eff("postgresql@16-main"));
check("the verdict counts units, not channels", v.total === 12 && v.up === 11 && v.bad.length === 1 && v.affected.length === 4, v);
check("a unit that is not active is dead, a reached-through one only cut", G.isDead(eff("nginx"), "nginx") && !G.isDead(eff("nginx"), "joya-dashboard") && G.isCut(eff("nginx"), "joya-dashboard"));
check("systemd states map to ok / failed / inactive", G.baseState("active") === "ok" && G.baseState("failed") === "failed" && G.baseState("activating") === "inactive" && G.baseState("inactive") === "inactive");

console.log("graph: event routes");
const chOf = (a) => (graph.edges.find((e) => e.to === a && e.from.startsWith("ch:")) || {}).from || null;
const EVTS = [
  { type: "ssh-login" }, { type: "ssh-fail" }, { type: "ban" }, { type: "unban" }, { type: "panel-login" }, { type: "panel-fail" },
  { type: "panel-action" }, { type: "audit" }, { type: "turn", source: "dashboard" }, { type: "turn", source: "other" }, { type: "delegation" },
  { type: "ingest" }, { type: "start", unit: "odoo" }, { type: "reply", agent: "admin" }, { type: "web_panel" }, { type: "web_odoo" }, { type: "web_other" },
];
const edgeSet = new Set(graph.edges.map((e) => G.edgeKey(e.from, e.to)));
const routes = EVTS.map((e) => G.route(e, ids, chOf));
check("every event type has a route on this map", routes.every(Boolean), routes);
check("every hop of every route is a real edge", routes.every((r) => r.every((id, i) => i === 0 || edgeSet.has(G.edgeKey(r[i - 1], id)))), routes);
check("a reply goes channel -> agent -> channel", JSON.stringify(G.route({ type: "reply", agent: "admin" }, ids, chOf)) === JSON.stringify(["ch:admin-telegram", "joya-agent@admin", "ch:admin-telegram"]));
check("a panel turn goes panel -> JOYA AI", JSON.stringify(G.route({ type: "turn", source: "dashboard" }, ids, chOf)) === JSON.stringify(["joya-dashboard", "joya-ai"]));
check("an event for a unit not on the map has no route", G.route({ type: "start", unit: "joya-whisper" }, ids, chOf) === null && G.route({ type: "reply", agent: "ghost" }, ids, chOf) === null && G.route({ type: "nope" }, ids, chOf) === null);
const tt = G.threadTraffic({ web_panel: 1000, web_odoo: 10, "ssh-login": 5, reply_by_agent: { admin: 7 }, turn_dashboard: 3 }, ids, chOf);
check("thread traffic sums the 24 h counts of every route that crosses it", tt[G.edgeKey("ufw", "nginx")] === 1010 && tt[G.edgeKey("nginx", "joya-dashboard")] === 1000 &&
  tt[G.edgeKey("ufw", "ssh")] === 5 && tt[G.edgeKey("ch:admin-telegram", "joya-agent@admin")] === 14 && tt[G.edgeKey("joya-dashboard", "joya-ai")] === 3, tt);
check("thickness is logarithmic", Math.abs(G.thickness(999) - (0.9 + 0.75 * 3)) < 1e-9 && G.thickness(0) === 0.9);

/* -------------------------------------------------------------- the feed --- */

async function feedTests() {
  console.log("server feed");
  let t = Date.parse("2026-09-28T10:00:00Z");
  const logs = [];
  const auditFile = path.join(TMP, "audit.log");
  fs.writeFileSync(auditFile, JSON.stringify({ ts: "2026-09-28T09:00:00+00:00", action: "old-action", detail: { ip: SECRET_IP } }) + "\n");
  let helperCalls = 0;
  const helperQueue = [
    { cursor: { j: "s=1" }, events: [{ type: "ssh-login", at: "2026-09-28T09:59:00+00:00", ip: SECRET_IP }], counts: { web_panel: 0 }, unavailable: ["replies:ghost"], now: "2026-09-28T10:00:00+00:00" },
    { cursor: { j: "s=2" }, events: [{ type: "start", unit: "odoo", at: "2026-09-28T10:00:03+00:00" }], counts: { web_panel: 3 }, unavailable: ["replies:ghost"], now: "2026-09-28T10:00:04+00:00" },
  ];
  const cursors = [];
  const priv = {
    pulseFeed: async (c) => { cursors.push(c); helperCalls++; return helperQueue.shift() || { cursor: c, events: [], counts: {}, unavailable: [] }; },
    pulseTotals: async () => ({ totals: { "ssh-login": 3, reply: 2, reply_by_agent: { admin: 2 } }, starts: { odoo: 1 }, unavailable: [] }),
  };
  let logins = [
    { id: 1, ts: "2026-09-28T09:58:00.000Z", outcome: "success", ip: SECRET_IP, username: SECRET_USER },
    { id: 2, ts: "2026-09-28T09:58:30.000Z", outcome: "joya-ai" },
    { id: 3, ts: "2026-09-28T09:00:00.000Z", outcome: "fail" },
  ];
  const db = {
    loginsAfter: (after, n, sinceTs) => logins.filter((r) => r.id > after && (!sinceTs || r.ts >= sinceTs)).map((r) => ({ id: r.id, ts: r.ts, outcome: r.outcome })),
    lastLoginId: () => Math.max(0, ...logins.map((r) => r.id)),
  };
  let joyaOnline = false;
  const joyaai = {
    call: async (op, p) => {
      if (!joyaOnline) throw new Error("JOYA AI is offline");
      if (p.table === "turns") return { rows: [{ id: 5, source: "dashboard", created_at: "2026-09-28T10:00:05Z", text: SECRET_TEXT }, { id: 4, source: "peer", created_at: "2026-09-28T09:00:00Z", text: "x" }] };
      return { rows: [{ id: 9, created_at: "2026-09-28T10:00:06Z", text: SECRET_TEXT, target_name: "secret-session" }] };
    },
  };
  const feed = pulse.createFeed({ priv, db, joyaai, auditLog: auditFile, now: () => t, log: (m) => logs.push(m) });
  await feed.poll();
  let evs = feed.since(0);
  check("first poll: the helper's events and recent sign-ins", evs.map((e) => e.type).join() === "panel-login,ssh-login", evs);
  check("an old failed sign-in outside the look-back is not replayed", !evs.some((e) => e.type === "panel-fail"));
  check("JOYA AI's own sign-in rows are left to its ledger", !evs.some((e) => e.type === "panel-action"));
  check("events carry no address or name", !JSON.stringify(evs).includes(SECRET_IP) && !JSON.stringify(evs).includes(SECRET_USER));
  check("an unavailable source is logged once", logs.filter((m) => /joya-ai/.test(m)).length === 1 && logs.filter((m) => /replies:ghost/.test(m)).length === 1, logs);
  await feed.poll();
  check("polls closer than the minimum interval do not reach the sources", helperCalls === 1);
  t += 5000;
  logins.push({ id: 4, ts: "2026-09-28T10:00:02.000Z", outcome: "fail" }, { id: 5, ts: "2026-09-28T10:00:02.500Z", outcome: "firewall" });
  fs.appendFileSync(auditFile, JSON.stringify({ ts: "2026-09-28T10:00:01+00:00", action: "service-restart", detail: { unit: "nginx", ip: SECRET_IP } }) + "\n" + "not json\n" +
    JSON.stringify({ ts: "2026-09-28T10:00:01+00:00", action: "<script>", detail: {} }) + "\n");
  joyaOnline = true;
  const seq1 = feed.seq;
  await feed.poll();
  evs = feed.since(seq1);
  check("the cursor is handed back to the helper", JSON.stringify(cursors[1]) === JSON.stringify({ j: "s=1" }));
  check("second poll merges every source, in time order", evs.map((e) => e.type).join() === "audit,panel-fail,panel-action,start,web_panel,turn,delegation", evs.map((e) => e.type));
  check("audit lines keep the action only; a malformed action is dropped", evs.filter((e) => e.type === "audit").length === 1 && evs.find((e) => e.type === "audit").action === "service-restart" && !("detail" in evs.find((e) => e.type === "audit")));
  check("a panel action keeps its category", evs.find((e) => e.type === "panel-action").action === "firewall");
  check("web requests arrive as a count", evs.find((e) => e.type === "web_panel").n === 3);
  check("JOYA AI: only turns and delegations new within the look-back, no text", evs.filter((e) => e.type === "turn").length === 1 && evs.find((e) => e.type === "turn").source === "dashboard" &&
    !JSON.stringify(evs).includes("swordfish") && !JSON.stringify(evs).includes("secret-session"));
  check("sequence numbers increase", evs.every((e, i) => i === 0 || e.seq > evs[i - 1].seq));
  check("since() filters by the viewer's rules", feed.since(0, (e) => e.type !== "audit").every((e) => e.type !== "audit"));
  const totals = await feed.getTotals({ wait: true });
  check("24 h totals merge the helper's with sign-ins, audit and JOYA AI's", totals["ssh-login"] === 3 && totals.reply_by_agent.admin === 2 && totals.starts.odoo === 1 && !("reply" in totals) &&
    totals["panel-login"] === 1 && totals["panel-fail"] === 2 && totals.audit === 2 && totals.turn_dashboard === 1 && totals.turn === 1 && totals.delegation === 1, totals);
}

/* ------------------------------------------------------------- the views --- */

function viewTests() {
  console.log("views");
  const rbac = lib("rbac");
  const chrome = lib("chrome");
  const views = lib("views");
  const serviceViews = lib("views-services");
  const admin = rbac.actor({ permissions: ["*"], agent_scope: "*", channel_scope: "*" });
  const user = { name: "tester", perm: admin, roleLabel: "Administrator" };
  const stats = { hostname: "vm", uptimeSec: 86400 * 3, loadavg: [0.5, 0.4, 0.3], cpus: 12, cpuModel: "EPYC", platform: "Linux", arch: "x64",
    node: "v22", panelUptimeSec: 60, panelRssBytes: 1e8, memTotal: 48e9, memUsed: 5e9, diskTotal: 5e11, diskUsed: 3e10 };
  const svc = SERVICES.map((s) => Object.assign({}, s, { managed: ["ufw", "fail2ban", "nginx", "ssh", "xrdp", "xrdp-sesman", "joya-dashboard"].includes(s.unit) }));
  svc.find((s) => s.unit === "postgresql@16-main").active = "failed";
  const g = pulse.buildGraph({ services: svc, agents: [{ slug: "admin", name: "Admin" }], channels: [{ slug: "admin-telegram", type: "telegram", agent: "admin", name: "@bot<i>" }],
    detail: new Map(catalog.OS_SERVICES.map((s) => [s.unit, s])) });
  const page = views.osDashboard({ csrf: "c", user, stats, status: { jails: {} }, statusError: null, services: svc, agents: [{ slug: "admin", state: { active: "active" } }], channels: [],
    graph: g, totals: { web_panel: 5 }, probe: null, logins: [], users: [], roles: [], devices: [], audit: [] });
  check("the overview is a scrolling document (C) since the 16 px redesign", /class="content pat-c"/.test(page));
  check("the growth rings are gone", !/Growth rings|data-machine-core|growth ring/i.test(page));
  check("the hero is the mycelium", /<h2>Mycelium<\/h2>/.test(page) && /data-myc="/.test(page) && /id="mc-hero"/.test(page));
  check("no concept switcher, no MOCKUP tag, no sample labels", !/mc-switch|MOCKUP|[Ss]ample events|sample flow/.test(page));
  check("the ticker says live events", /Live events/.test(page));
  check("its scripts are loaded as external, deferred files", /<script src="\/static\/mycelium-graph\.js[^"]*" defer><\/script>/.test(page) && /<script src="\/static\/mycelium\.js[^"]*" defer><\/script>/.test(page));
  check("no inline script or style", !/<script>(?!<\/script>)|<script(?![^>]*src=)[^>]*>|style="/.test(page));
  const json = /data-myc="([^"]*)"/.exec(page);
  const data = json && JSON.parse(json[1].replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&"));
  check("the web's data is escaped into the attribute", page.includes("@bot&lt;i&gt;") && !page.includes("@bot<i>") && data && data.nodes.length === 13 && data.totals.web_panel === 5);
  check("the pill, the footer count and the verdict agree", /11 of 12 services up/.test(page) && /data-mc-count>11 \/ 12</.test(page) && /PostgreSQL 16 is not running/.test(page));

  const sp = serviceViews.system({ csrf: "c", user, services: svc, flash: null, err: null });
  check("/services lists every tracked unit", svc.every((s) => sp.includes(`>${s.unit}<`)) && /11 of 12 active/.test(sp));
  check("managed units keep restart and logs", /name="target" value="nginx"/.test(sp) && /\/services\/logs\?unit=nginx/.test(sp) && /name="target" value="fail2ban"/.test(sp));
  check("Odoo, PostgreSQL, the memory service, JOYA AI and agents are read-only here", ["odoo", "postgresql@16-main", "claude-memory", "joya-ai", "joya-agent@admin"].every((u) =>
    !sp.includes(`name="target" value="${u}"`) && !sp.includes("/services/logs?unit=" + encodeURIComponent(u))) && (sp.match(/read-only<\/span>/g) || []).length === 5);
  check("read-only rows point to where they are managed", /href="\/services\?kind=agents"/.test(sp) && !/href="\/services\/agents"/.test(sp) && /href="\/claude\/memory"/.test(sp) && /href="\/joya-ai"/.test(sp));

  const scoped = rbac.actor({ permissions: ["os.view", "services.view", "agents.view"], agent_scope: "scout", channel_scope: "*" });
  const list = [{ unit: "nginx", active: "active" }, { unit: "joya-agent@scout", kind: "agent", active: "failed" }, { unit: "joya-agent@secret", kind: "agent", active: "active" }];
  const vis = chrome.visibleServices(list, scoped);
  check("an agent's unit is visible only within the viewer's agent scope", vis.length === 2 && !vis.some((s) => s.unit === "joya-agent@secret"));
  chrome.configure({ priv: {}, db: null, catalog: null });
  const fr = chrome.forActor(scoped, { services: list, agents: [{ slug: "scout", state: { active: "failed" } }, { slug: "secret", state: { active: "active" } }] });
  check("the sidebar badge counts the same visible units", JSON.stringify(fr.badges.services) === JSON.stringify(["1/2", "warn", "1 service down"]), fr.badges.services);
  check("a failed agent is not counted twice in the health chip", fr.health && fr.health.text === "1 agent failed", fr.health);
}

/* ------------------------------------------------------------ the script --- */

function scriptTests() {
  console.log("page script");
  const js = fs.readFileSync(path.join(ROOT, "public", "mycelium.js"), "utf8");
  check("no demo controls or global hooks in production", !/__mc|shiftKey|toggleFail|ev\.key === "[fle]"/.test(js));
  check("no sample events", !/sample/i.test(js.replace(/sample\(/g, "")));
  check("it polls the live feed", /\/api\/os\/pulse\?since=/.test(js));
  check("it pauses when hidden and honours reduced motion", /visibilitychange/.test(js) && /prefers-reduced-motion/.test(js) && /devicePixelRatio/.test(js));
  check("labels are built with textContent, the tooltip escapes", /nm\.textContent = n\.name/.test(js) && /esc\(n\.name\)/.test(js) && /esc\(n\.role\)/.test(js));
}

async function primeTests() {
  console.log("frame cache");
  const chrome = lib("chrome");
  const rbac = lib("rbac");
  const admin = rbac.actor({ permissions: ["*"], agent_scope: "*", channel_scope: "*" });
  chrome.configure({ priv: { serviceList: async () => [{ unit: "nginx", active: "active" }, { unit: "odoo", active: "active" }], agentList: async () => [], channelList: async () => [],
    status: async () => ({}), credentialList: async () => [], listAllKeys: async () => ({}), ccMemoryStats: async () => null, ccRunning: async () => null }, db: null, catalog: null });
  check("priming before the cache exists does nothing", chrome.prime({ services: [] }) === null);
  const d = await chrome.facts();
  check("the cache is filled", d && d.services.length === 2);
  const merged = chrome.prime({ services: [{ unit: "nginx", active: "active" }, { unit: "odoo", active: "failed" }] });
  const fr = chrome.forActor(admin, merged);
  check("a fresher unit list reaches the badge and the chip at once", JSON.stringify(fr.badges.services) === JSON.stringify(["1/2", "warn", "1 service down"]) && fr.health.cls === "warn", fr);
  check("the rest of the cached facts are kept", Array.isArray(merged.agents));
}

feedTests()
  .then(primeTests)
  .then(() => {
    viewTests();
    scriptTests();
  })
  .catch((e) => {
    failed++;
    console.log("  FAIL exception: " + (e && e.stack));
  })
  .finally(() => {
    fs.rmSync(TMP, { recursive: true, force: true });
    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
  });
