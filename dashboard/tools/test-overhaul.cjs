#!/usr/bin/env node
"use strict";
/**
 * Tests for the overhauled frame and pages.
 *
 *   node dashboard/tools/test-overhaul.cjs
 *
 * Renders the views with fixed data and checks what matters about them: the
 * frame's badges and health chip respect the actor's permissions and scope,
 * every page declares its pattern (A one screen, B fixed frame, C document),
 * nothing a user or an agent wrote reaches the page unescaped, and the
 * controls the old pages had are still there. No network, no helper.
 */

const path = require("path");
const fs = require("fs");
const os = require("os");

process.env.JOYA_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "ov-test-"));
const ROOT = path.join(__dirname, "..");
const lib = (m) => require(path.join(ROOT, "lib", m));

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

const rbac = lib("rbac");
const ui = lib("ui");
const chrome = lib("chrome");
const admin = rbac.actor({ permissions: ["*"], agent_scope: "*", channel_scope: "*" });
const scoped = rbac.actor({ permissions: ["agents.view", "agents.logs", "channels.view", "os.view", "services.view"], agent_scope: "scout", channel_scope: "*" });

const FACTS = {
  services: [{ unit: "nginx", active: "active" }, { unit: "xrdp-sesman", active: "inactive" }],
  agents: [
    { slug: "scout", name: "Scout", state: { active: "failed" } },
    { slug: "other", name: "Other", state: { active: "active" } },
  ],
  channels: [{ slug: "c1" }],
  status: { jails: { sshd: { banned: 3 }, "joya-dashboard": { banned: 1 } } },
  credentials: [{ name: "claude", configured: true }],
  keys: { root: [{}, {}], ubuntu: [{}] },
  memory: { db: { facts: { current: 607 } } },
  running: { sessions: [{ alive: true }, { alive: true }, { alive: false }] },
};

/* ----------------------------------------------------------------- frame --- */

console.log("frame: badges and health");
chrome.configure({ priv: {}, db: { listUsers: () => [{ totp_confirmed: 0, disabled: 0 }, { totp_confirmed: 1 }], listRoles: () => [1, 2, 3], listDevices: () => [] }, catalog: { ADDONS: [1, 2] } });
const ca = chrome.forActor(admin, FACTS);
check("services badge counts up of total, warns when one is down", JSON.stringify(ca.badges.services) === JSON.stringify(["1/2", "warn", "1 service down"]));
check("firewall badge sums the jails (a state: tinted)", JSON.stringify(ca.badges.firewall) === JSON.stringify(["4", "warn", "4 banned"]));
check("users badge shows pending enrolment", ca.badges.users[0] === "1" && ca.badges.users[1] === "warn" && /awaiting enrolment/.test(ca.badges.users[2]));
check("keys badge counts every account's keys, quietly", ca.badges.keys[0] === "3" && ca.badges.keys[1] === "plain");
check("memory badge is the current fact count", ca.badges["claude-memory"][0] === "607" && ca.badges["claude-memory"][1] === "plain");
check("the Sessions badge counts live sessions (a state: ok)", JSON.stringify(ca.badges["claude-sessions"]) === JSON.stringify(["2", "ok", "2 live"]));
check("agents badge names failures", ca.badges.agents[0] === "1" && ca.badges.agents[1] === "bad" && /1 agent failed/.test(ca.badges.agents[2]));
check("the credentials badge is gone", !("credentials" in ca.badges));
check("health chip says what needs attention", ca.health.cls === "bad" && /1 service needs attention/.test(ca.health.text) && /1 agent failed/.test(ca.health.text));
const cs = chrome.forActor(scoped, FACTS);
check("a role without users.view gets no users badge", !cs.badges.users && !cs.badges.roles && !cs.badges["claude-memory"]);
check("a scoped role counts only its own agents", cs.badges.agents[0] === "1" && cs.badges.agents[1] === "bad" && cs.ids.agents.sub.startsWith("0 of 1"));
const healthyScout = chrome.forActor(scoped, Object.assign({}, FACTS, { services: [{ unit: "nginx", active: "active" }], agents: [{ slug: "scout", state: { active: "active" } }, { slug: "other", state: { active: "failed" } }] }));
check("an agent out of scope never raises the chip", healthyScout.health.cls === "ok");
check("with no facts yet the frame still renders", chrome.forActor(admin, null).badges && chrome.forActor(admin, null).ids.os.name === os.hostname());

console.log("frame: shell");
const user = { name: "Ann <b>", roleLabel: "Administrator", perm: admin, chrome: ca };
const page = ui.shell("T", "<p>x</p>", { user, csrf: "c", active: "services", pattern: "b" });
check("pattern B is declared on the content column", /<main class="content pat-b"[^>]*>/.test(page));
check("pages default to the document pattern", /class="content pat-c"/.test(ui.shell("T", "", { user, csrf: "c", active: "keys" })));
check("the frame marker is on <html> for framed pages", /<html lang="en" class="framed( [^"]*)?">/.test(page));
check("sidebar badges render with their tone", /class="badge warn" data-badge="services" title="1 service down">1\/2</.test(page));
check("the current item is marked for assistive tech", /class="side-item on" aria-current="page"/.test(page));
check("the health chip is on every page", /class="sys-chip bad"[^>]*data-health/.test(page) && page.includes('href="/services"'));
check("the sidebar can collapse to icons", /data-side-collapse/.test(page));
check("no clock in the top bar of an OS page", !/data-clock/.test(page));
check("crumbs trace group / page", /<nav class="crumbs"[^>]*><a href="\/os">Machine<\/a><span aria-hidden="true">\/<\/span><span>Services<\/span><\/nav>/.test(page));
check("the top bar says where you are", /id="tb-where"><span class="g">Machine<\/span><span class="sep">\/<\/span><b>Services<\/b>/.test(page));
check("the user's name is escaped", page.includes("Ann &lt;b&gt;") && !page.includes("Ann <b>"));
check("os.css and os.js load on every page", /os\.css\?v=/.test(page) && /os\.js\?v=/.test(page));
check("no inline script or style", !/<script>(?!<\/script>)|style="/.test(page.replace(/<script src[^>]*><\/script>/g, "")));
const bare = ui.shell("C", "<p/>", { user, csrf: "c", active: "joya-ai", bare: true, brand: "ai" });
check("the Command Center (bare) has no frame marker, but the sidebar as a drawer", /<html lang="en">/.test(bare) && bare.includes('class="sidebar"') && /data-os-toggle/.test(bare) && /id="os-scrim"/.test(bare));
check("signed-out pages have no chrome", !ui.shell("Sign in", "<p/>", { csrf: "c" }).includes("topbar"));

const theme = fs.readFileSync(path.join(ROOT, "public", "theme-init.js"), "utf8");
check("the collapsed sidebar is applied before paint, guarded", /joya-side/.test(theme) && /try \{[\s\S]*joya-side[\s\S]*\} catch/.test(theme));

/* ----------------------------------------------------------------- pages --- */

console.log("pages");
const views = lib("views");
const stats = { hostname: "vm<1>", uptimeSec: 86400 * 80, loadavg: [0.5, 0.4, 0.3], cpus: 12, cpuModel: "EPYC", platform: "Linux", arch: "x64",
  node: "v22", panelUptimeSec: 60, panelRssBytes: 1e8, memTotal: 48e9, memUsed: 5e9, diskTotal: 5e11, diskUsed: 3e10 };
const osPage = views.osDashboard({
  csrf: "c", user, stats, status: { jails: { sshd: { banned: 2, total_failed: 9 } } }, statusError: null,
  services: [{ unit: "nginx", active: "active" }, { unit: "xrdp-sesman", active: "inactive" }],
  agents: [{ slug: "scout", state: { active: "active" } }], channels: [], probe: { claude_credential: true, files: {}, binaries: {} },
  logins: [{ ts: "2026-09-27T10:00:00Z", ip: "1.2.3.4", username: "<u>", outcome: "success" }],
  users: [], roles: [], devices: [], audit: [{ ts: "2026-09-27T10:00:00Z", action: "a<x>", detail: { k: "<v>" } }],
});
check("the OS overview is a scrolling document (C) since the 16 px redesign", /class="content pat-c"/.test(osPage));
check("it is headed Machine health", /<h1>Machine health<\/h1>/.test(osPage));
const mycJson = /data-myc="([^"]*)"/.exec(osPage);
const myc = mycJson && JSON.parse(mycJson[1].replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&"));
check("the Machine core hero is the mycelium (growth rings gone)", myc && Array.isArray(myc.nodes) && /<h2>Mycelium<\/h2>/.test(osPage) && !/data-machine-core/.test(osPage));
check("its pill counts every service", /1 of 2 services up/.test(osPage));
check("vitals rings are live-refreshable", /data-vitals/.test(osPage) && /data-ring="cpu"/.test(osPage) && /data-load/.test(osPage));
check("what users and the audit log wrote is escaped", osPage.includes("&lt;u&gt;") && osPage.includes("a&lt;x&gt;") && !osPage.includes("<u>"));
check("the hostname is escaped", osPage.includes("vm&lt;1&gt;"));

const agentViews = lib("views-agents");
const fleet = [
  { slug: "scout", name: "Scout <x>", state: { active: "active" }, notes: 40, memory: { chunks: 120 }, model: "claude-opus-5", effort: "high",
    channel: { slug: "c1", name: "@bot", type: "telegram", telegram_bot_username: "bot" } },
  { slug: "odd", name: "Odd", state: { active: "failed" }, notes: 0, memory: {}, channel: null },
];
const nursery = agentViews.dashboard({ csrf: "c", user, agents: fleet, channels: [{}], probe: null });
check("Agents overview is a document holding the Telegram agents table", /<h1>Agents overview<\/h1>/.test(nursery) && /class="content pat-c"/.test(nursery) && />Telegram agents<\/h2>/.test(nursery) && /class="ds-table agents-table"/.test(nursery));
check("every agent is a table row with its state as a word and a shape (no seedling)", (nursery.match(/<th scope="row" data-h="Agent">/g) || []).length === 2 && /class="state ok"[^>]*><svg[^>]*>.*?<\/svg>Running/.test(nursery) && /class="state bad"[^>]*><svg[^>]*>.*?<\/svg>Failed/.test(nursery) && !/seedling|class="card seed/.test(nursery));
check("an agent with no channel gets an add link", /href="\/channels\/new"/.test(nursery) && /No channel — add one/.test(nursery));
check("effort shows as a word", /High effort/.test(nursery));
check("card controls are the existing forms", /action="\/agents\/scout\/action"/.test(nursery) && /name="action" value="restart"/.test(nursery));
check("agent names are escaped", nursery.includes("Scout &lt;x&gt;") && !nursery.includes("Scout <x>"));
const noControl = rbac.actor({ permissions: ["agents.view"], agent_scope: "*", channel_scope: "*" });
check("a viewer sees no start/stop and no New agent", !/\/action"/.test(agentViews.dashboard({ csrf: "c", user: { name: "v", perm: noControl }, agents: fleet, channels: [], probe: null })) &&
  !/href="\/agents\/new"/.test(agentViews.list({ csrf: "c", user: { name: "v", perm: noControl }, agents: fleet })));

const detail = agentViews.detail({ csrf: "c", user, agent: fleet[0], notes: [{ path: "memory/<a>.md", bytes: 10, modified: "2026-09-27T10:00:00Z" }],
  journal: ["2026-09-27T18:36:35+02:00 vmi joya-agent-scout[12]: <script>x</script> Traceback error", "plain"], journalErr: null });
check("agent detail is one screen with a journal tail", /class="content pat-a"/.test(detail) && /data-journal="\/api\/agents\/scout\/logs"/.test(detail));
check("journal lines are escaped and tinted", detail.includes("&lt;script&gt;x&lt;/script&gt;") && /class="ln e"/.test(detail) && /<span class="t">09-27 18:36:35<\/span>/.test(detail));
check("the vault is a seed head with the note count", /data-vault="40"/.test(detail));
check("note paths are escaped", detail.includes("memory/&lt;a&gt;.md"));
const noLogs = agentViews.detail({ csrf: "c", user: { name: "v", perm: noControl }, agent: fleet[0], notes: [], journal: null });
check("without agents.logs there is no tail, and it says why", !/data-journal=/.test(noLogs) && /does not include reading this agent's logs/.test(noLogs));
check("journalHtml escapes", agentViews.journalHtml(["<b>"]) === '<span class="ln">&lt;b&gt;</span>');

const svc = lib("views-services").system({ csrf: "c", user, services: [{ unit: "nginx", active: "active", stoppable: false, memory: 3e7 }, { unit: "fail2ban", active: "active", stoppable: true }] });
check("services: critical units are restart only", /restart only/.test(svc) && (svc.match(/value="stop"/g) || []).length === 1);
check("services: every row keeps Logs", (svc.match(/href="\/services\/logs\?unit=/g) || []).length === 2);
check("services is a fixed frame (B)", /class="content pat-b"/.test(svc));
const audit = views.audit({ csrf: "c", user, entries: [{ ts: "2026-09-27T10:00:00Z", action: "key.remove", detail: { x: "<y>" } }], logins: [], err: null });
check("audit: two panels that scroll on their own", /class="split"/.test(audit) && (audit.match(/class="tbl"/g) || []).length === 2 && audit.includes("&lt;y&gt;"));

const creds = lib("views-credentials").detail({ csrf: "c", user, credential: { name: "claude", label: "Claude", path: "/x/claude-auth.env", keys: ["A", "B"], present: { A: { preview: "sk…", length: 9 } }, exists: true },
  credentials: [{ name: "claude", label: "Claude", configured: true, path: "/x/claude-auth.env" }] });
check("credentials: master list and contents beside the document", /class="card hud cred-list"/.test(creds) && /data-toc/.test(creds) && /href="#c-state"/.test(creds) && /id="c-state"/.test(creds));
check("credentials: the forms are unchanged", /action="\/credentials\/claude"/.test(creds) && /action="\/credentials\/claude\/clear"/.test(creds));
const guide = lib("views-guide").guide({ csrf: "c", user, publicHost: "h", publicPort: 8443 });
check("guide: sticky contents beside the document", /class="doc-side"/.test(guide) && /data-toc/.test(guide) && /href="#trouble"/.test(guide));

const running = lib("views-claude").live({ csrf: "c", user, r: { ts: "2026-09-27T10:00:00Z", sessions: [], subagents: [], others: [], jobs: {}, units: [], services: [], subagent_hooks: [] }, team: null, counts: {} });
check("what was Running is the Sessions page's Live tab, a board under the tabs", /<h1>Sessions<\/h1>/.test(running) && /cc-board three/.test(running) && /id="s-live"/.test(running));
check("the Live tab keeps every live-refresh section", ["stats", "sessions", "subagents", "others", "jobs", "units", "services", "hooks"].every((k) => running.includes('data-cc-section="' + k + '"')));

/* -------------------------------------------------------------- styles --- */

console.log("styles");
const osCss = fs.readFileSync(path.join(ROOT, "public", "os.css"), "utf8");
check("the three patterns are defined", /\.content\.pat-a/.test(osCss) && /\.content\.pat-b/.test(osCss) && /\.content\.pat-c/.test(osCss));
check("pattern A and B clip, C scrolls", /\.content\.pat-a, \.content\.pat-b \{[^}]*overflow: hidden/.test(osCss) && /\.content\.pat-c \{[^}]*overflow: hidden auto/.test(osCss));
const style = fs.readFileSync(path.join(ROOT, "public", "style.css"), "utf8");
check("the collapsed rail is a token, remembered on <html>", /:root\[data-side="collapsed"\] \{ --side-w: 64px; \}/.test(style));
check("the memory graph's colours exist in both themes", /--g-decision: #/.test(style) && /:root\[data-theme="dark"\][\s\S]*--g-decision: #/.test(style));

fs.rmSync(process.env.JOYA_DATA_DIR, { recursive: true, force: true });
console.log("\n" + passed + " passed, " + failed + " failed");
process.exit(failed ? 1 : 0);
