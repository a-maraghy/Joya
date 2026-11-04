#!/usr/bin/env node
"use strict";
/**
 * Tests for the memory graphs.
 *
 *   node dashboard/tools/test-memgraph.cjs
 *
 * Three layers, none of which touches the machine's own memory:
 *
 *   helper    loads deploy/joya-helper as a Python module and drives its new
 *             read-only subcommands against fixtures: cc-memory-graph with a
 *             stand-in for the database bridge (validation, caps, the
 *             semantic-link cache, redaction), and agent-memory-graph over a
 *             throwaway vault (types from folders and frontmatter, wikilinks,
 *             tags, Arabic, secrets, the note cap, a missing index)
 *   builders  lib/memgraph.js: what the page is sent -- ids, types, hubs, the
 *             topic hierarchy, link kinds, forgotten facts, wikilink
 *             resolution -- and that priv.redactDeep still masks what it must
 *   views     the graph panel and the two memory pages: controls present,
 *             everything escaped, the three views switchable
 *
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

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "mg-test-"));
const VAULT = path.join(TMP, "agents", "scout", "vault");
fs.mkdirSync(path.join(VAULT, "memory", "people"), { recursive: true });
fs.mkdirSync(path.join(VAULT, "memory", "decisions"), { recursive: true });
fs.mkdirSync(path.join(VAULT, ".obsidian"), { recursive: true });
const SECRET = "sk-ant-api03-" + "Z".repeat(40);
fs.writeFileSync(path.join(VAULT, "CLAUDE.md"), "# Scout\nYou are the scout. See [[Nour Hassan]] and [[Ghost Topic]].\n");
fs.writeFileSync(
  path.join(VAULT, "memory", "people", "nour-hassan.md"),
  "---\ntitle: Nour Hassan\ntags: [quality, lab]\n---\n# Nour Hassan\nRuns the lab. مساء الخير. Key was " + SECRET + "\n#planning\n"
);
fs.writeFileSync(
  path.join(VAULT, "memory", "decisions", "short-lot-rule.md"),
  "# Short lot rule\nDecided with [[nour-hassan|Nour]] on 3 Oct.\n```\n#not-a-tag inside code\n```\n"
);
fs.writeFileSync(path.join(VAULT, "memory", "typed.md"), "---\ntype: figures\n---\nQ4 buy plan: 91,402 kg.\n");
fs.writeFileSync(path.join(VAULT, ".obsidian", "workspace.md"), "# ignored\n");
fs.writeFileSync(path.join(VAULT, "notes.txt"), "not markdown");

/* ------------------------------------------------- drive the real helper --- */

const driver = String.raw`
import importlib.machinery, importlib.util, json, os, sys
spec = importlib.util.spec_from_loader("joya_helper", importlib.machinery.SourceFileLoader("joya_helper", sys.argv[1]))
H = importlib.util.module_from_spec(spec); spec.loader.exec_module(H)
tmp = sys.argv[2]
H.AGENTS_DIR = os.path.join(tmp, "agents")
H.RUNTIME_DIR = os.path.join(tmp, "no-runtime")
H.CC_CACHE = os.path.join(tmp, "cache")
H.CC_GRAPH_SEM = os.path.join(H.CC_CACHE, "graph-sem.json")
out = {}
def attempt(name, fn):
    try:
        out[name] = {"ok": True, "data": H.cc_redact_deep(fn())}
    except H.CCError as e:
        out[name] = {"ok": False, "error": str(e)}

# --- cc-memory-graph, with the database bridge replaced by a recorder
CALLS = []
STATE = {"sig": [10, 99, 0]}
def bridge(op, **p):
    CALLS.append(dict(p, op=op))
    assert op == "graph"
    data = {"facts": [{"id": 1, "content": "token " + "sk-ant-oat01-" + "q" * 30, "topic": "a.b", "superseded_by": None}],
            "chunks": [], "sessions": [], "supers": [], "alive": [1, 2], "signature": STATE["sig"],
            "cursor": {"f": 2, "c": 5}, "cur_ids": [1, 2], "incremental": "after_f" in p or "after_c" in p}
    data["sem"] = [[1, 2, 0.8], [1, 3, 0.9]] if p.get("want_sem") else None
    return data
H.cc_bridge = bridge
attempt("full1", lambda: H.cc_memory_graph({}))
out["calls_full1"] = len(CALLS)
attempt("full2", lambda: H.cc_memory_graph({}))
out["calls_full2"] = len(CALLS)
STATE["sig"] = [11, 100, 0]
attempt("full3", lambda: H.cc_memory_graph({}))
out["calls_full3"] = len(CALLS)
attempt("inc", lambda: H.cc_memory_graph({"after_f": 1, "after_c": "4"}))
out["inc_call"] = CALLS[-1]
attempt("bad_cursor", lambda: H.cc_memory_graph({"after_f": "1; drop table facts"}))
attempt("bad_cursor_neg", lambda: H.cc_memory_graph({"after_c": -3}))
attempt("bad_cursor_bool", lambda: H.cc_memory_graph({"after_f": True}))
attempt("caps", lambda: H.cc_graph_params({"limit_f": 999999, "limit_c": 999999}))
attempt("caps_low", lambda: H.cc_graph_params({"limit_f": 0, "limit_c": -5}))
out["cache_mode"] = oct(os.stat(H.CC_GRAPH_SEM).st_mode & 0o777) if os.path.exists(H.CC_GRAPH_SEM) else None

# --- agent-memory-graph over the fixture vault
attempt("vault", lambda: H.agent_memory_graph("scout"))
H.AGENT_GRAPH_MAX_NOTES = 2
attempt("vault_capped", lambda: H.agent_memory_graph("scout"))
H.AGENT_GRAPH_MAX_NOTES = 1500
def sem_ok(slug):
    return [["CLAUDE.md", "memory/people/nour-hassan.md", 0.71], ["gone.md", "CLAUDE.md", 0.9]], None
H.agent_semantic_links = sem_ok
attempt("vault_sem", lambda: H.agent_memory_graph("scout"))
out["types"] = {p: H.note_type(p, m) for p, m in [("memory/people/x.md", {}), ("memory/decisions/x.md", {}),
    ("memory/x.md", {"type": "trap"}), ("WORKLOG.md", {}), ("MEMORY.md", {}), ("memory/runs/r.md", {}), ("memory/odd.md", {"type": "weird"})]}
print(json.dumps(out))
`;

const run = spawnSync("python3", ["-c", driver, HELPER, TMP], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
if (run.status !== 0) {
  console.error(run.stderr || run.stdout);
  process.exit(1);
}
const R = JSON.parse(run.stdout.trim().split("\n").pop());

console.log("helper: cc-memory-graph");
check("a full request computes the semantic links once and caches them", R.full1.ok && R.calls_full1 === 2 && R.full1.data.sem_cached === false);
check("the second full request is served from the cache", R.full2.ok && R.calls_full2 === 3 && R.full2.data.sem_cached === true);
check("a changed facts table recomputes the links", R.calls_full3 === 5 && R.full3.data.sem_cached === false);
check("cached links are kept only between current facts", JSON.stringify(R.full1.data.sem) === JSON.stringify([[1, 2, 0.8]]), JSON.stringify(R.full1.data.sem));
check("the cache file is root-only", R.cache_mode === "0o600", R.cache_mode);
check("an incremental request passes both cursors as integers", R.inc_call.after_f === 1 && R.inc_call.after_c === 4 && R.inc_call.want_sem === true, JSON.stringify(R.inc_call));
check("an incremental request asks for links for the new facts only", R.inc.ok && R.inc.data.sem.length === 2);
check("a cursor that is not a number is refused", !R.bad_cursor.ok && /cursor/.test(R.bad_cursor.error));
check("a negative cursor is refused", !R.bad_cursor_neg.ok);
check("a boolean cursor is refused", !R.bad_cursor_bool.ok);
check("caps are clamped to 1500 facts and 1000 chunks", R.caps.data.limit_f === 1500 && R.caps.data.limit_c === 1000, JSON.stringify(R.caps.data));
check("caps have a floor", R.caps_low.data.limit_f === 1 && R.caps_low.data.limit_c === 0, JSON.stringify(R.caps_low.data));
check("the output passes the helper's redaction", !JSON.stringify(R.full1).includes("q".repeat(30)) && JSON.stringify(R.full1).includes("REDACTED"));
check("limits are reported", R.full1.data.limits && R.full1.data.limits.k === 3 && R.full1.data.limits.min_sim === 0.75);

console.log("helper: agent-memory-graph");
const V = R.vault.data;
const byPath = Object.fromEntries(V.notes.map((n) => [n.path, n]));
check("every note is found, hidden folders and non-markdown skipped", Object.keys(byPath).sort().join(",") ===
  "CLAUDE.md,memory/decisions/short-lot-rule.md,memory/people/nour-hassan.md,memory/typed.md", Object.keys(byPath).join(","));
check("a note in memory/people is a person", byPath["memory/people/nour-hassan.md"].type === "people");
check("a note in memory/decisions is a decision", byPath["memory/decisions/short-lot-rule.md"].type === "decision");
check("frontmatter type wins over the folder", byPath["memory/typed.md"].type === "figure");
check("CLAUDE.md is a document", byPath["CLAUDE.md"].type === "document");
check("titles come from frontmatter or the first heading", byPath["memory/people/nour-hassan.md"].title === "Nour Hassan" && byPath["memory/decisions/short-lot-rule.md"].title === "Short lot rule");
check("wikilinks are read, aliases and anchors dropped", JSON.stringify(byPath["CLAUDE.md"].links) === JSON.stringify(["Ghost Topic", "Nour Hassan"]) &&
  JSON.stringify(byPath["memory/decisions/short-lot-rule.md"].links) === JSON.stringify(["nour-hassan"]));
check("tags from frontmatter and text, not from code blocks", JSON.stringify(byPath["memory/people/nour-hassan.md"].tags) === JSON.stringify(["lab", "planning", "quality"]) &&
  byPath["memory/decisions/short-lot-rule.md"].tags.length === 0, JSON.stringify(byPath["memory/people/nour-hassan.md"].tags));
check("Arabic survives in the snippet", byPath["memory/people/nour-hassan.md"].snippet.includes("مساء الخير"));
check("a secret in a note is redacted", !JSON.stringify(V).includes(SECRET) && JSON.stringify(V).includes("REDACTED"));
check("a missing runtime is reported, not fatal", V.sem.length === 0 && /venv|index/.test(V.sem_error || ""), V.sem_error);
check("the note cap truncates and says so", R.vault_capped.data.notes.length === 2 && R.vault_capped.data.truncated === true);
check("semantic links to notes that do not exist are dropped", JSON.stringify(R.vault_sem.data.sem) === JSON.stringify([["CLAUDE.md", "memory/people/nour-hassan.md", 0.71]]));
check("types map from folders and frontmatter", R.types["memory/people/x.md"] === "people" && R.types["memory/x.md"] === "trap" &&
  R.types["WORKLOG.md"] === "pattern" && R.types["memory/runs/r.md"] === "run" && R.types["memory/odd.md"] === "note", JSON.stringify(R.types));

/* ------------------------------------------------------------- builders --- */

const mg = require(path.join(ROOT, "lib", "memgraph.js"));
const priv = require(path.join(ROOT, "lib", "priv.js"));

console.log("builders: Claude Code");
const raw = {
  facts: [
    { id: 10, topic: "odoo.planning.purchase", ts: "2026-09-20T10:00:00Z", source_session: "s-1", superseded_by: null, kind: "decision", project: "joya", content: "Buy plan nets open procurement. More detail follows here." },
    { id: 11, topic: "odoo.planning", ts: "2026-09-21T10:00:00Z", source_session: null, superseded_by: 12, kind: "trap", project: "joya", content: "Old wording" },
    { id: 12, topic: "odoo.planning", ts: "2026-09-22T10:00:00Z", source_session: null, superseded_by: null, kind: "weird", project: null, content: "New wording <b>bold</b>" },
  ],
  chunks: [
    { id: 500, source: "transcript", session_id: "s-1", project: "joya", ts: "2026-09-20T09:00:00Z", role: "exchange", content: "User: hello", label: "hello" },
    { id: 501, source: "doc", session_id: null, project: "joya", ts: "2026-09-20T09:00:00Z", content: "doc body", label: "Step 4", rel: "PLANNING.md" },
  ],
  sessions: [{ session_id: "s-1", first: "2026-09-20T09:00:00Z", last: "2026-09-20T11:00:00Z", n: 12, project: "joya", title: "Planning session" }],
  supers: [[11, 12]],
  sem: [[10, 12, 0.81]],
  alive: [10, 11, 12],
  cursor: { f: 12, c: 501 },
};
const G = mg.buildClaude(raw);
const node = (id) => G.nodes.find((n) => n.id === id);
const edge = (a, b, k) => G.edges.some((e) => ((e[0] === a && e[1] === b) || (e[0] === b && e[1] === a)) && e[2] === k);
check("facts become typed nodes", node("f:10").t === "decision" && node("f:11").t === "trap");
check("an unknown kind falls back to fact", node("f:12").t === "fact");
check("a fact's label is its first clause", node("f:10").l === "Buy plan nets open procurement", node("f:10").l);
check("topics become a hierarchy of hubs", node("t:odoo").h === 1 && node("t:odoo.planning").h === 1 && node("t:odoo.planning.purchase").l === "purchase");
check("fact links to its topic, topics link to their parents", edge("f:10", "t:odoo.planning.purchase", "s") && edge("t:odoo.planning.purchase", "t:odoo.planning", "s") && edge("t:odoo.planning", "t:odoo", "s"));
check("a session is a hub, linked to its project", node("s:s-1").h === 1 && node("s:s-1").l === "Planning session" && edge("s:s-1", "p:joya", "s"));
check("facts and chunks hang from their session", edge("f:10", "s:s-1", "s") && edge("c:500", "s:s-1", "s"));
check("a fact with no session hangs from its project", edge("f:11", "p:joya", "s"));
check("chunks are typed by source", node("c:500").t === "conversation" && node("c:501").t === "document");
check("supersession is a link of its own kind", edge("f:11", "f:12", "v"));
check("related by meaning is a link of its own kind, with its similarity", G.edges.some((e) => e[2] === "m" && e[3] === 0.81));
check("the ids still remembered are passed on", JSON.stringify(G.alive) === JSON.stringify(["f:10", "f:11", "f:12"]));
check("groups follow the project", node("f:10").g === "joya" && node("t:odoo").g === null);
check("no link points at a node that is not there", G.edges.every((e) => node(e[0]) && node(e[1])));
check("text is carried as data, not escaped or stripped (the page draws it with textContent)", node("f:12").s.includes("<b>bold</b>"));
const inc = mg.buildClaude({ facts: [{ id: 13, topic: "odoo.planning", source_session: "s-1", content: "x", kind: "fact" }], sessions: raw.sessions, alive: [10, 12, 13] },
  { known: new Set(G.nodes.map((n) => n.id)) });
check("an incremental build does not resend hubs the page has", !inc.nodes.some((n) => n.id === "t:odoo.planning" || n.id === "s:s-1") && inc.nodes.length === 1);
check("an incremental build still links to hubs the page has", inc.edges.some((e) => e[0] === "f:13" && e[1] === "t:odoo.planning"));
const leaky = priv.redactDeep(mg.buildClaude({ facts: [{ id: 1, topic: "t", content: "key sk-ant-oat01-" + "k".repeat(40), kind: "fact" }] }));
check("priv.redactDeep masks a secret in labels and snippets", !JSON.stringify(leaky).includes("k".repeat(30)));
check("search hits map to node ids", JSON.stringify(mg.claudeHits([{ kind: "fact", id: 7 }, { kind: "chunk", id: 9 }, { kind: "fact", id: "x" }]).map((h) => h.id)) === JSON.stringify(["f:7", "c:9"]));

console.log("builders: agents");
const A = mg.buildAgents([
  { slug: "scout", name: "Scout", graph: R.vault_sem.data },
  { slug: "broken", name: "Broken", error: "no such agent" },
]);
const an = (id) => A.nodes.find((n) => n.id === id);
const ae = (a, b, k) => A.edges.some((e) => ((e[0] === a && e[1] === b) || (e[0] === b && e[1] === a)) && e[2] === k);
check("each agent is a hub", an("a:scout").h === 1 && an("a:scout").t === "agent" && an("a:broken"));
check("notes hang from their agent", ae("n:scout:CLAUDE.md", "a:scout", "s"));
check("a wikilink resolves by title", ae("n:scout:CLAUDE.md", "n:scout:memory/people/nour-hassan.md", "s"));
check("a wikilink resolves by file name, alias ignored", ae("n:scout:memory/decisions/short-lot-rule.md", "n:scout:memory/people/nour-hassan.md", "s"));
check("an unresolved wikilink is a topic of its own", an("u:scout:ghost topic") && an("u:scout:ghost topic").t === "topic");
check("tags are topic hubs", an("tag:scout:planning") && ae("n:scout:memory/people/nour-hassan.md", "tag:scout:planning", "s"));
check("related-by-meaning links carry over", ae("n:scout:CLAUDE.md", "n:scout:memory/people/nour-hassan.md", "m"));
check("an agent that failed is reported, not fatal", A.errors.some((e) => e.agent === "broken"));
check("agent search hits map to note ids", mg.agentHits("scout", [{ path: "CLAUDE.md", score: 0.1 }])[0].id === "n:scout:CLAUDE.md");

/* ---------------------------------------------------------------- views --- */

console.log("views");
const rbac = require(path.join(ROOT, "lib", "rbac.js"));
const admin = rbac.actor({ permissions: ["*"], agent_scope: "*", channel_scope: "*" });
const viewer = rbac.actor({ permissions: ["claude.memory.read", "agents.view", "agents.memory.read"], agent_scope: "*", channel_scope: "*" });
const { graphPanel, viewSwitch } = require(path.join(ROOT, "lib", "views-memgraph.js"));
const panel = graphPanel({ kind: "claude", src: "/api/x", search: "/api/s", groups: [{ key: "", label: "All" }, { key: 'p"<x>', label: "<img src=x>" }], csrf: "tok", writable: true });
check("the panel carries its data sources", panel.includes('data-src="/api/x"') && panel.includes('data-search="/api/s"'));
check("chip labels and keys are escaped", !panel.includes("<img src=x>") && panel.includes("&lt;img src=x&gt;") && panel.includes('data-group-chip="p&quot;&lt;x&gt;"'));
check("zoom +, − and fit are buttons", /data-zoom="in"/.test(panel) && /data-zoom="out"/.test(panel) && /data-zoom="fit"/.test(panel));
check("the search box says Enter searches by meaning", /Enter = by meaning/.test(panel));
check("the related-by-meaning toggle is a real checkbox", /class="mg-related"><input type="checkbox" checked>/.test(panel));
check("no inline script or style in the panel", !/<script|style=/.test(panel));
check("the view switch marks the active view", /data-view="list"[^>]*aria-selected="true"/.test(viewSwitch("list", [["graph", "Graph", "network", "/g"], ["list", "List", "logs", "/l"]])));

const claudeViews = require(path.join(ROOT, "lib", "views-claude.js"));
const base = {
  csrf: "tok", query: "", searchProject: "", filters: { topic: "", project: "", q: "", superseded: false, page: 1 },
  stats: { db: { facts: { current: 3, superseded: 1, forgotten: 0 }, chunks: { transcript: 5 }, sessions_indexed: 1, db_bytes: 1, projects: ["joya", "o<b>"] }, health: { ok: true, model: "m", dims: 768 } },
  facts: { rows: [], total: 0, page: 1, per_page: 25 }, files: [], hooks: [], services: null, search: null, errors: {},
};
const pg = claudeViews.memory(Object.assign({ user: { name: "a", perm: admin } }, base));
check("the memory page opens on Browse; the graph is the optional view", /data-view-panel="browse"(?! hidden)/.test(pg) && /class="mg"[^>]*data-view-panel="graph" hidden/.test(pg) && /data-view-panel="list" hidden/.test(pg) && /data-view-panel="overview" hidden/.test(pg));
const pgGraph = claudeViews.memory(Object.assign({ user: { name: "a", perm: admin }, view: "graph" }, base));
check("?view=graph opens on the graph", /class="mg"[^>]*data-view-panel="graph"(?![^>]*hidden)/.test(pgGraph) && /data-view-panel="browse" hidden/.test(pgGraph));
check("its project chips come from the database, escaped", pg.includes('data-group-chip="joya"') && pg.includes("o&lt;b&gt;"));
check("the list view keeps the facts form and the search form", pg.includes('action="/claude/memory" class="searchbar"') && pg.includes('class="cc-filters"'));
check("the overview keeps stats, files, hooks and services", pg.includes("current facts") && pg.includes("Auto-memory files") && pg.includes("Hook activity") && pg.includes("Memory services"));
check("a writer's graph may edit and forget", /data-writable="1"/.test(pg) && /data-csrf="tok"/.test(pg));
check("the page loads the graph's own files", /memgraph\.js\?v=/.test(pg) && /memgraph\.css\?v=/.test(pg));
const pgList = claudeViews.memory(Object.assign({ user: { name: "a", perm: viewer }, view: "list" }, base));
check("?view=list opens on the list", /data-view-panel="list"(?! hidden)/.test(pgList) && /data-view-panel="graph" hidden/.test(pgList));
check("a reader without write permission gets no edit forms", /data-writable="0"/.test(pgList) && !pgList.includes('action="/claude/memory/facts" '));

const agentViews = require(path.join(ROOT, "lib", "views-agents.js"));
const agent = { slug: "scout", name: "Scout <x>", state: { active: "active" }, memory: { chunks: 3 }, notes: 4, dir: "/opt/joya-agents/agents/scout" };
const ap = agentViews.memory({ csrf: "t", user: { name: "a", perm: viewer }, agent, agents: [agent, { slug: "other", name: "Other" }], notes: [], query: "", hits: null });
check("the agent memory page is a graph of every agent the reader may see", ap.includes('data-src="/api/agents/memory/graph?agent=all"') && ap.includes('data-group-chip="other"') && ap.includes('data-group="scout"'));
check("names are escaped in the chips", ap.includes("Scout &lt;x&gt;") && !ap.includes("Scout <x>"));
check("the organised notes are the default view, the graph the other", /data-view-panel="notes"(?! hidden)/.test(ap) && /data-view-panel="graph" hidden/.test(ap) && ap.includes("Search this agent"));
const apGraph = agentViews.memory({ csrf: "t", user: { name: "a", perm: viewer }, agent, agents: [agent], notes: [], query: "", hits: null, view: "graph" });
check("?view=graph opens the agent's graph", /data-view-panel="notes" hidden/.test(apGraph) && /class="mg"[^>]*data-view-panel="graph"(?![^>]*hidden)/.test(apGraph));
const scoped = rbac.actor({ permissions: ["agents.view", "agents.memory.read"], agent_scope: "scout", channel_scope: "*" });
const ap2 = agentViews.memory({ csrf: "t", user: { name: "a", perm: scoped }, agent, agents: [agent], notes: [], query: "", hits: null });
check("a scoped reader's chips name only agents in scope", !ap2.includes('data-group-chip="other"'));

/* ------------------------------------------------------------ the rules --- */

console.log("stylesheets");
for (const f of ["os.css", "memgraph.css", "memory.css"]) {
  const css = fs.readFileSync(path.join(ROOT, "public", f), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  const lits = (css.match(/#[0-9a-fA-F]{3,8}\b/g) || []);
  check(f + " uses tokens, not literal colours", lits.length === 0, lits.join(" "));
}
const js = fs.readFileSync(path.join(ROOT, "public", "memgraph.js"), "utf8");
check("memgraph.js never assigns innerHTML", !/innerHTML/.test(js));
check("memgraph.js sets canvas direction per label (RTL)", /ctx\.direction = dirOf\(/.test(js));
check("memgraph.js pauses when hidden or off screen", /document\.hidden \|\| !this\.onScreen\(\)/.test(js));
check("memgraph.js honours reduced motion", /prefers-reduced-motion/.test(js) && /settleSync/.test(js));

fs.rmSync(TMP, { recursive: true, force: true });
console.log("\n" + passed + " passed, " + failed + " failed");
process.exit(failed ? 1 : 0);
