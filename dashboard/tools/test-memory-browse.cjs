#!/usr/bin/env node
"use strict";
/**
 * Tests for the organised memory pages (lib/views-memory.js, lib/markdown.js and the helper's
 * agent-vault-index), 2026-10-25.
 *
 *   node dashboard/tools/test-memory-browse.cjs
 *
 *   markdown   escaping first: no HTML, no javascript: links, no loaded images; wikilinks
 *              resolved or marked "not written yet"; frontmatter read, headings shifted
 *   helper     agent-vault-index over a throwaway vault: notes with links and properties,
 *              other files by name and size only, hidden folders and symlinks left out
 *   views      the agent's notes by kind and files by folder, recent changes, one note read
 *              with its links in and out, edit only for writers; Claude Code's Browse panel
 *
 * Needs python3; does not need root.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
let passed = 0;
let failed = 0;
function check(name, cond, detail) {
  if (cond) {
    passed++;
    console.log("  ok   " + name);
  } else {
    failed++;
    console.log("  FAIL " + name + (detail ? "\n       " + String(detail).slice(0, 400) : ""));
  }
}

/* ------------------------------------------------------------ markdown --- */

console.log("markdown");
const md = require(path.join(ROOT, "lib", "markdown.js"));
const resolve = (t) => (t.toLowerCase() === "nour-hassan" ? { href: "/n?p=memory/people/nour-hassan.md", label: "Nour Hassan" } : null);
let r = md.render("---\ntitle: T\ntype: decision\ntags: [a, b]\n---\n# T\n\nHi <script>alert(1)</script> and <img src=x onerror=1>\n", { resolve });
check("frontmatter is read and not shown", r.props.title === "T" && r.props.type === "decision" && r.props.tags.join() === "a,b" && !r.html.includes("type: decision"));
check("raw HTML is escaped, never live", !/<script|<img/i.test(r.html) && r.html.includes("&lt;script&gt;"));
check("headings move down one level", r.html.includes("<h2>T</h2>"));
r = md.render("[x](javascript:alert(1)) [y](https://e.com/a?b=1&c=2) [z](data:text/html,1) ![pic](https://e.com/p.png)", {});
check("javascript: and data: links are not links", !/href="javascript|href="data/i.test(r.html) && r.html.includes("md-link-off"));
check("http links open safely", r.html.includes('href="https://e.com/a?b=1&amp;c=2" rel="noopener noreferrer" target="_blank"'));
check("images are named, not loaded", !/<img/i.test(r.html) && r.html.includes("Image: pic"));
r = md.render("See [[nour-hassan]], [[nour-hassan|Nour]] and [[ghost note]].", { resolve });
check("a resolved wikilink links to the note, by title", r.html.includes('<a class="md-wiki" href="/n?p=memory/people/nour-hassan.md">Nour Hassan</a>'));
check("an alias wins over the title", r.html.includes(">Nour</a>"));
check("an unresolved wikilink says it is not written yet", /md-wiki missing" title="No note called “ghost note” yet">ghost note</.test(r.html));
r = md.render("- [ ] todo\n- [x] done\n  - nested\n\n1. one\n2. two\n\n```js\n<b>code</b>\n```\n\n| a | b |\n|---|--:|\n| `x` | 2 |\n\n> quoted **bold**\n", {});
check("task lists say their state in words", r.html.includes("To do: </span>todo") && r.html.includes("Done: </span>done"));
check("nested and ordered lists", /<ul>[\s\S]*<ul><li>nested/.test(r.html) && r.html.includes("<ol><li>one"));
check("code blocks are escaped", r.html.includes("&lt;b&gt;code&lt;/b&gt;") && r.html.includes('data-lang="js"'));
check("tables, with alignment", r.html.includes("<table>") && r.html.includes('<td class="right">2</td>'));
check("blockquotes keep inline formatting", r.html.includes("<blockquote><p>quoted <strong>bold</strong></p></blockquote>"));
check("snake_case and paths stay plain", md.render("memory/mavix_final_ok.md and a_b_c").html === "<p>memory/mavix_final_ok.md and a_b_c</p>");
check("a relative .md link goes through the caller", md.render("[n](other.md)", { link: (u) => "/x?" + u }).html.includes('href="/x?other.md"'));

/* -------------------------------------------------------------- helper --- */

console.log("helper: agent-vault-index");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "mb-test-"));
const V = path.join(TMP, "agents", "scout", "vault");
for (const d of ["memory/people", "memory/decisions", "outbox/archive", ".obsidian", ".trash", "drawings"]) fs.mkdirSync(path.join(V, d), { recursive: true });
fs.writeFileSync(path.join(V, "MEMORY.md"), "# MEMORY\n\n## Memory index\n\n### People\n\n- [[nour-hassan]] — runs the lab\n");
fs.writeFileSync(path.join(V, "memory/people/nour-hassan.md"), "---\ntitle: Nour Hassan\ntype: person\ncreated: 2026-10-01\ntags: [lab]\n---\n# Nour Hassan\nRuns the lab. See [[short-lot-rule]].\n");
fs.writeFileSync(path.join(V, "memory/decisions/short-lot-rule.md"), "# Short lot rule\nWith [[nour-hassan|Nour]].\n");
fs.writeFileSync(path.join(V, "outbox/logo-v2.svg"), "<svg>SECRET-CONTENT</svg>");
fs.writeFileSync(path.join(V, "outbox/archive/logo-v1.svg"), "<svg/>");
fs.writeFileSync(path.join(V, ".trash/old.png"), "x");
fs.writeFileSync(path.join(V, ".obsidian/app.json"), "{}");
fs.symlinkSync("/etc", path.join(V, "project"));
const driver = String.raw`
import importlib.machinery, importlib.util, json, os, sys
spec = importlib.util.spec_from_loader("joya_helper", importlib.machinery.SourceFileLoader("joya_helper", sys.argv[1]))
H = importlib.util.module_from_spec(spec); spec.loader.exec_module(H)
H.AGENTS_DIR = os.path.join(sys.argv[2], "agents")
print(json.dumps(H.cc_redact_deep(H.agent_vault_index("scout"))))
`;
const run = spawnSync("python3", ["-c", driver, path.join(ROOT, "deploy", "joya-helper"), TMP], { encoding: "utf8" });
let idx = null;
try {
  idx = JSON.parse(run.stdout.trim().split("\n").pop());
} catch (e) {
  console.log(run.stderr);
}
check("the helper answers", !!idx, run.stderr);
if (idx) {
  const paths = idx.notes.map((n) => n.path).sort();
  check("notes: every .md outside hidden folders", paths.join() === "MEMORY.md,memory/decisions/short-lot-rule.md,memory/people/nour-hassan.md", paths.join());
  const nour = idx.notes.find((n) => n.path.endsWith("nour-hassan.md"));
  check("a note carries title, type, links, tags and properties", nour.title === "Nour Hassan" && nour.type === "people" && nour.links.join() === "short-lot-rule" && nour.tags.includes("lab") && nour.props.created === "2026-10-01");
  const fpaths = idx.files.map((f) => f.path).sort();
  check("files: names and sizes, hidden folders and symlinks left out", fpaths.join() === "outbox/archive/logo-v1.svg,outbox/logo-v2.svg", fpaths.join());
  check("a file's content is never sent", !JSON.stringify(idx.files).includes("SECRET-CONTENT") && idx.files.every((f) => Object.keys(f).sort().join() === "bytes,modified,path"));
}

/* --------------------------------------------------------------- views --- */

console.log("views");
const rbac = require(path.join(ROOT, "lib", "rbac.js"));
const admin = rbac.actor({ permissions: ["*"], agent_scope: "*", channel_scope: "*" });
const reader = rbac.actor({ permissions: ["agents.view", "agents.memory.read"], agent_scope: "*", channel_scope: "*" });
const agentViews = require(path.join(ROOT, "lib", "views-agents.js"));
const agent = { slug: "scout", name: "Scout", state: { active: "active" }, memory: { chunks: 3 }, dir: "/opt/joya-agents/agents/scout" };
const index = idx || { notes: [], files: [] };
const page = agentViews.memory({ csrf: "t", user: { name: "a", perm: admin }, agent, agents: [agent, { slug: "other", name: "Other <b>", notes: 2 }], index, query: "", hits: null });
check("notes are grouped under plain headings", page.includes(">People <span") && page.includes(">Decisions <span"));
check("Home is the start of the vault", page.includes(">Home<") && page.includes("memory%2F") === true);
check("files are grouped by folder, archive folded away", page.includes("Sent and made files") && page.includes("Archive: 1 older version"));
check("links in and out are counted", /1 link out · 1 in/.test(page));
check("recent changes list notes and files", page.includes("Recent changes") && page.includes("logo-v2.svg"));
check("the agent switch names other agents, escaped", page.includes("Other &lt;b&gt;") && page.includes('href="/agents/other/memory"'));
check("a writer can reindex", page.includes("/agents/scout/memory/reindex"));
check("the search box is reachable by keyboard shortcut", page.includes("data-mem-search") && /memory\.js\?v=/.test(page));
const pReader = agentViews.memory({ csrf: "t", user: { name: "r", perm: reader }, agent, agents: [agent], index, query: "", hits: null });
check("a reader cannot reindex", !pReader.includes("/memory/reindex"));
const pHits = agentViews.memory({ csrf: "t", user: { name: "r", perm: reader }, agent, agents: [agent], index, query: "lab <x>", hits: [{ path: "memory/people/nour-hassan.md", heading: "Nour", score: 0.9, text: "Runs <the> lab" }] });
check("search results come first, escaped, by note title", pHits.includes("Results for “lab &lt;x&gt;”") && pHits.includes("Runs &lt;the&gt; lab") && pHits.includes(">Nour Hassan</a>"));
const pFlat = agentViews.memory({ csrf: "t", user: { name: "r", perm: reader }, agent, agents: [agent], index: null, notes: [{ path: "memory/a.md", bytes: 1, modified: "2026-10-01T00:00:00Z" }], query: "", hits: null });
check("without the index the flat list still shows", pFlat.includes("memory/a.md"));

const content = fs.readFileSync(path.join(V, "memory/people/nour-hassan.md"), "utf8");
const note = agentViews.note({ csrf: "t", user: { name: "a", perm: admin }, agent, path: "memory/people/nour-hassan.md", content, index, mode: "" });
check("a note opens rendered, not as raw text", note.includes('class="md-body"') && !note.includes("<textarea") && !note.includes("type: person"));
check("its title is shown once", (note.match(/>Nour Hassan</g) || []).length >= 1 && !note.includes("<h2>Nour Hassan</h2>"));
check("its properties are listed", note.includes("<dt>Kind</dt><dd>Person</dd>") && note.includes("<dt>Created</dt><dd>2026-10-01</dd>"));
check("links out and links in are both listed", note.includes("Links from this note") && note.includes(">Short lot rule</a>") && note.includes("Linked from"));
check("a writer gets an Edit button", note.includes("mode=edit"));
const edit = agentViews.note({ csrf: "t", user: { name: "a", perm: admin }, agent, path: "memory/people/nour-hassan.md", content, index, mode: "edit" });
check("edit mode is the old form, same action", edit.includes("<textarea") && edit.includes('action="/agents/scout/memory/note"') && edit.includes('name="_csrf" value="t"'));
const rEdit = agentViews.note({ csrf: "t", user: { name: "r", perm: reader }, agent, path: "memory/people/nour-hassan.md", content, index, mode: "edit" });
check("a reader asking for edit still only reads", !rEdit.includes("<textarea") && !rEdit.includes("mode=edit"));
const evil = agentViews.note({ csrf: "t", user: { name: "r", perm: reader }, agent, path: "memory/x.md", content: "# x\n<script>bad()</script> [[nour-hassan]]", index, mode: "" });
check("a note's HTML never runs", !evil.includes("<script>bad") && evil.includes("&lt;script&gt;"));

const VM = require(path.join(ROOT, "lib", "views-memory.js"));
const browse = VM.claudeBrowse({
  outline: { kinds: { decision: 2, trap: 1 }, topics: [{ name: "odoo<x>", count: 3, last: "2026-10-01T00:00:00Z", children: [{ name: "planning", count: 3 }] }], projects: [{ name: "joya", count: 3 }], topics_total: 1 },
  recent: [{ id: 7, content: "We <decided> X", topic: "odoo.planning", ts: "2026-10-01T00:00:00Z", meta: { kind: "decision" } }],
  agents: [{ slug: "scout", name: "Scout", notes: 4 }],
  errors: {},
});
check("Browse counts memory by kind, linking to the filtered facts", browse.includes('href="/claude/memory?view=list&amp;kind=decision"') && /Decisions<\/b><span class="mem-kind-n">2</.test(browse));
check("topics open into their parts", browse.includes("odoo&lt;x&gt;") && browse.includes("topic=odoo%3Cx%3E.planning"));
check("recent changes are escaped and linked", browse.includes("We &lt;decided&gt; X") && browse.includes('href="/claude/memory/facts/7"'));
check("the Telegram agents' memories are listed", browse.includes('href="/agents/scout/memory"') && browse.includes("4 notes"));
const side = VM.factSide({ related: [{ id: 9, content: "Close <one>", topic: "t", sim: "0.81" }], same_topic: [] });
check("a fact lists what is related by meaning", side.includes("Close &lt;one&gt;") && side.includes("similarity 0.81") && side.includes("No other current fact"));

fs.rmSync(TMP, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
