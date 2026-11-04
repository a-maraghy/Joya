#!/usr/bin/env node
"use strict";
/**
 * The Joya frame after the reorganisation (lib/ui.js shell, lib/chrome.js):
 * one sidebar in four groups (the Guide sits in the avatar menu), a top bar that says where you are with the
 * avatar menu, quiet count badges and tinted state badges, the dock band, and
 * the Command Center's sidebar drawer. Pure rendering: no server, no helper.
 *
 *     node dashboard/tools/test-frame.cjs
 */
const fs = require("fs");
const os = require("os");
const path = require("path");

process.env.JOYA_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "frame-test-"));
const ROOT = path.join(__dirname, "..");
const lib = (m) => require(path.join(ROOT, "lib", m));

let passed = 0;
let failed = 0;
function check(name, cond, detail) {
  if (cond) {
    passed++;
    console.log("  ok   " + name);
  } else {
    failed++;
    console.log("  FAIL " + name + (detail !== undefined ? "\n       " + String(detail).slice(0, 400) : ""));
  }
}

const ui = lib("ui");
const rbac = lib("rbac");
const chrome = lib("chrome");
const A = (perms) => rbac.actor({ permissions: perms, agent_scope: "*", channel_scope: "*" });
const admin = A(["*"]);
const viewer = rbac.actor(rbac.SYSTEM_ROLES.find((r) => r.name === "viewer"));
const render = (perm, extra) => ui.shell("T", "<p>x</p>", Object.assign({ user: { name: "Ann", roleLabel: "Role", perm }, csrf: "tok", active: "services" }, extra || {}));
const sideKeys = (html) => [...html.matchAll(/<div class="side-group" data-g="([a-z-]+)"/g)].map((m) => m[1]);
const sideHrefs = (html) => [...html.matchAll(/<a href="([^"]+)" class="side-item/g)].map((m) => m[1]);

/* ------------------------------------------------------------ navigation --- */

console.log("the sidebar: four groups");
{
  check("NAV is four groups: JOYA AI, Agents & sessions, Machine, Access & security", ui.NAV.map((g) => g.label).join(" | ") === "JOYA AI | Agents & sessions | Machine | Access & security");
  const items = (k) => ui.NAV.find((g) => g.key === k).items.map((i) => i.key).join(" ");
  check("  JOYA AI: Command Center, Settings, Computers", items("joya-ai") === "joya-ai joya-settings machines");
  check("  Agents & sessions: Overview, Sessions, Telegram agents, Channels, Add-ons, Memory", items("agents") === "agents-dashboard claude-sessions agents channels addons claude-memory");
  check("  Machine: Overview, Services, Audit log", items("machine") === "os services audit");
  check("  Access & security: Users, Roles, Devices, SSH keys, Firewall, Credentials", items("access") === "users roles devices keys firewall credentials");
  check("  no Help group: the Guide is not in the sidebar", !ui.NAV.some((g) => g.key === "help") && !ui.NAV.flatMap((g) => g.items).some((i) => i.key === "guide"));
  const all = ui.NAV.flatMap((g) => g.items);
  check("every item has key, href, label, icon; keys and hrefs are unique", all.every((i) => i.key && /^\//.test(i.href) && i.label && i.icon) && new Set(all.map((i) => i.key)).size === all.length && new Set(all.map((i) => i.href)).size === all.length);
  check("the classic chat is gone from the navigation", !all.some((i) => /console/.test(i.key + i.href)));
  check("the old dashboards model is gone (no DASHBOARDS, no dashboardFor)", ui.DASHBOARDS === undefined && ui.dashboardFor === undefined);
  check("old active keys map onto the item that lights up (ALIASES)", ui.ALIASES["claude-running"] === "claude-sessions" && ui.ALIASES.running === "claude-sessions" && ui.ALIASES.sessions === "claude-sessions" && ui.ALIASES.memory === "claude-memory" && ui.ALIASES["agent-services"] === "services" && ui.ALIASES.console === "joya-ai" && ui.ALIASES["voice-settings"] === "joya-settings");
  check("  and every alias names a real item", Object.values(ui.ALIASES).every((k) => all.some((i) => i.key === k)));
  const r = render(admin, { active: "claude-running" });
  check("  a page passing an old key lights the new item", /<a href="\/claude\/sessions" class="side-item on" aria-current="page"/.test(r));

  const a = render(admin);
  check("an administrator's sidebar shows all four groups", sideKeys(a).join() === "joya-ai,agents,machine,access", sideKeys(a).join());
  check("  each group label is a button that collapses it", (a.match(/<button type="button" class="side-label" aria-expanded="true" data-side-group="/g) || []).length === 4);
  const v = render(viewer);
  check("a viewer sees no JOYA AI group (a group with nothing visible collapses away)", !sideKeys(v).includes("joya-ai") && sideKeys(v).includes("machine") && !sideKeys(v).includes("help"));
  check("  and no item it cannot open", !sideHrefs(v).includes("/users") && !sideHrefs(v).includes("/joya-ai") && !sideHrefs(v).includes("/credentials"));
  const nothing = render(A([]));
  check("a role with nothing still has its own devices; the Guide is in its avatar menu", sideHrefs(nothing).join() === "/devices" && /<a href="\/guide" role="menuitem">[\s\S]*Guide &amp; help<\/a>/.test(nothing), sideHrefs(nothing).join());
  check("Sessions shows for claude.running.view alone (the Live tab)", sideHrefs(render(A(["claude.running.view"]))).includes("/claude/sessions"));
  check("Services shows for agents.view alone (the Agents tab)", sideHrefs(render(A(["agents.view"]))).includes("/services"));
  check("the header card wraps the machine's facts", /<div class="side-id">/.test(render(admin, { user: { name: "Ann", perm: admin, chrome: chrome.forActor(admin, null) } })));
}

console.log("\ncrumbs and where you are");
{
  const a = render(admin, { active: "keys" });
  check("crumbs are group / page, the group linking its first item", /<nav class="crumbs"[^>]*><a href="\/users">Access &amp; security<\/a><span aria-hidden="true">\/<\/span><span>SSH keys<\/span><\/nav>/.test(a));
  check("  the group's link is the first item this role may open (Devices, before SSH keys)", /<a href="\/devices">Access &amp; security<\/a>/.test(render(A(["keys.view"]), { active: "keys" })));
  check("the top bar says the same in #tb-where", /<div class="tb-where" id="tb-where"><span class="g">Access &amp; security<\/span><span class="sep">\/<\/span><b>SSH keys<\/b><\/div>/.test(a));
  check("a page outside the navigation names itself there (opts.where / its last crumb)", /id="tb-where"><b>Account<\/b>/.test(render(admin, { active: "account", where: "Account" })) && /id="tb-where"><b>scout<\/b>/.test(render(admin, { active: "x", crumbs: [["Agents", "/agents"], ["scout", null]] })));
  check("a page's own crumbs win", /<a href="\/agents">Agents<\/a><span aria-hidden="true">\/<\/span><span>scout<\/span>/.test(render(admin, { crumbs: [["Agents", "/agents"], ["scout", null]] })));
}

/* ---------------------------------------------------------------- badges --- */

console.log("\nbadges: counts are quiet, states are tinted");
{
  chrome.configure({
    priv: {},
    db: { listUsers: () => [{ totp_confirmed: 1 }, { totp_confirmed: 1 }], listRoles: () => [1, 2] },
    catalog: { ADDONS: [] },
    devicesFor: () => 2,
  });
  const facts = {
    services: [{ unit: "nginx", active: "active" }, { unit: "odoo", active: "active" }],
    agents: [{ slug: "a", state: { active: "active" } }],
    channels: [],
    status: { jails: { sshd: { banned: 0 } } },
    credentials: [{ name: "claude", configured: false }],
    keys: { root: [] },
    memory: { db: { facts: { current: 1234 } } },
    running: { sessions: [{ alive: true }] },
  };
  const b = chrome.forActor(admin, facts, { id: 1 }).badges;
  check("services: all up is a state (ok), up/total", JSON.stringify(b.services) === JSON.stringify(["2/2", "ok", "all 2 up"]));
  check("firewall: no badge with nothing banned", !("firewall" in b));
  check("users: none pending is a plain count", JSON.stringify(b.users) === JSON.stringify(["2", "plain"]));
  check("sessions live: a state (ok) with its sentence", JSON.stringify(b["claude-sessions"]) === JSON.stringify(["1", "ok", "1 live"]));
  check("agents: a plain count when none failed", JSON.stringify(b.agents) === JSON.stringify(["1", "plain"]));
  check("memory: a plain count, thousands separated", JSON.stringify(b["claude-memory"]) === JSON.stringify(["1,234", "plain", "memory facts"]));
  check("devices: your own browsers, plain", b.devices[0] === "2" && b.devices[1] === "plain");
  check("credentials: no badge at all", !("credentials" in b));
  check("zero counts arrive as plain zeros (the view hides them)", b.keys[0] === "0" && b.keys[1] === "plain" && b.channels[0] === "0" && b.addons[0] === "0");
  const html = render(admin, { user: { name: "Ann", perm: admin, chrome: { badges: b } } });
  check("the sidebar hides a plain zero", !/data-badge="keys"/.test(html) && !/data-badge="channels"/.test(html) && !/data-badge="addons"/.test(html));
  check("  shows a plain count without tint", /<span class="badge plain" data-badge="users">2<\/span>/.test(html));
  check("  and tints a state, with its sentence as the title", /<span class="badge ok" data-badge="services" title="all 2 up">2\/2<span class="sr">: all 2 up<\/span><\/span>/.test(html) && /<span class="badge ok" data-badge="claude-sessions" title="1 live">1<span class="sr">: 1 live<\/span><\/span>/.test(html));
  check("badgeHtml: a tinted zero still shows (a state is never hidden)", /badge warn/.test(ui.badgeHtml("x", ["0", "warn"])) && ui.badgeHtml("x", ["0", "plain"]) === "" && ui.badgeHtml("x", ["", "plain"]) === "" && ui.badgeHtml("x", null) === "");

  const bad = chrome.forActor(admin, Object.assign({}, facts, {
    services: [{ unit: "nginx", active: "active" }, { unit: "odoo", active: "failed" }],
    agents: [{ slug: "a", state: { active: "failed" } }],
    status: { jails: { sshd: { banned: 2 }, x: { banned: 1 } } },
  })).badges;
  check("services with one down: warn, and the sentence says so", JSON.stringify(bad.services) === JSON.stringify(["1/2", "warn", "1 service down"]));
  check("firewall bans: a warn state, only when > 0", JSON.stringify(bad.firewall) === JSON.stringify(["3", "warn", "3 banned"]));
  check("a failed agent: a bad state", bad.agents[1] === "bad" && /1 agent failed/.test(bad.agents[2]));
  chrome.configure({ priv: {}, db: { listUsers: () => [{ totp_confirmed: 0, disabled: 0 }, { totp_confirmed: 1 }], listRoles: () => [] }, catalog: null });
  const pend = chrome.forActor(admin, {}).badges;
  check("users awaiting enrolment: a warn state", pend.users[0] === "1" && pend.users[1] === "warn" && /awaiting enrolment/.test(pend.users[2]));
  const ids = chrome.forActor(admin, null).ids;
  check("the header card's facts are a list (vCPU, GB, uptime)", Array.isArray(ids.os.facts) && ids.os.facts.length === 3 && /vCPU$/.test(ids.os.facts[0]) && /^up /.test(ids.os.facts[2]) && ids.os.name === os.hostname());
}

/* --------------------------------------------------------------- top bar --- */

console.log("\nthe top bar and the avatar menu");
{
  const a = render(admin);
  const top = a.slice(a.indexOf('<header class="topbar">'), a.indexOf("</header>"));
  check("no dashboard tabs in the top bar", !/top-tab|role="tablist"/.test(top));
  check("no clock on an OS page", !/data-clock|cc-clock/.test(top));
  check("no theme switch in the bar itself: it is inside the avatar menu", (top.match(/data-theme-switch/g) || []).length === 1 && top.indexOf("data-theme-switch") > top.indexOf('id="me-menu"'));
  check("the lockup is the bar's direct child (.topbar > .brand)", /<header class="topbar">\s*<button class="nav-toggle"[^>]*>[\s\S]*?<\/button>\s*<a class="brand"/.test(a));
  check("the needs-you pill (hidden until the dock knows the count) opens Decisions", /<a class="tb-need" id="tb-need" href="\/joya-ai#dec"[^>]*hidden>/.test(top));
  const menu = (/<div class="me-menu" id="me-menu" role="menu" hidden>([\s\S]*?)<\/form>\s*<\/div>/.exec(a) || [])[1] || "";
  check("the avatar button opens #me-menu", /<button class="avatar-btn" type="button" id="avatar-btn" aria-haspopup="menu" aria-expanded="false" aria-controls="me-menu"/.test(a) && menu.length > 0);
  check("  it holds Account & sign-in and Signed-in devices", /<a href="\/account" role="menuitem">[\s\S]*Account &amp; sign-in<\/a>/.test(menu) && /<a href="\/devices" role="menuitem">[\s\S]*Signed-in devices<\/a>/.test(menu));
  check("  JOYA AI appearance for joyaai.use", /<a href="\/joya-ai\/settings\/appearance" role="menuitem">/.test(menu));
  check("  the theme switch (System / Dark / Light)", /data-theme-switch/.test(menu) && ["system", "dark", "light"].every((t) => menu.includes(`data-theme-opt="${t}"`)));
  check("  and Sign out: a POST form with its CSRF token that asks first", /<form method="post" action="\/logout" class="me-logout" data-confirm-dlg="Sign out of Joya\?"[^>]*data-confirm-yes="Sign out">\s*<input type="hidden" name="_csrf" value="tok">\s*<button class="mi" type="submit" role="menuitem">/.test(a));
  check("  no separate power button or name text outside the menu", (a.match(/action="\/logout"/g) || []).length === 1);
  const v = render(viewer);
  check("without joyaai.use: no JOYA AI appearance entry, the rest stays", !/\/joya-ai\/settings\/appearance/.test(v) && /href="\/account" role="menuitem"/.test(v) && /data-theme-switch/.test(v) && /action="\/logout"/.test(v));
  check("an administrator's menu says all permissions", /· all permissions<\/small>/.test(a) && !/all permissions/.test(v));
  check("the name in the avatar is escaped", /title="&lt;b&gt;"/.test(render(admin, { user: { name: "<b>", perm: admin } })));
}

/* ------------------------------------------------------------------ dock --- */

console.log("\nthe dock band");
{
  const a = render(admin);
  check("with joyaai.use: with-dock on <html>, a .dock-band, then the dock", /<html lang="en" class="framed with-dock">/.test(a) && /<div class="dock-band" aria-hidden="true"><\/div>\s*<div class="md-root"/.test(a));
  const v = render(viewer);
  check("without joyaai.use: no with-dock, no band, no dock", /<html lang="en" class="framed">/.test(v) && !/dock-band|joya-dock-root/.test(v));
  const cc = render(admin, { bare: true, active: "joya-ai", brand: "ai" });
  check("never on the Command Center (bare)", !/with-dock|dock-band|joya-dock-root/.test(cc));
  check("a page that opts out (dock: false) has no band", !/with-dock|dock-band/.test(render(admin, { dock: false })));
  const css = fs.readFileSync(path.join(ROOT, "public", "joya-os.css"), "utf8");
  check("joya-os.css: the band's height is a token (96 px, 84 px on phones) the content column ends above", /--dock-band: 96px/.test(css) && /--dock-band: 84px/.test(css) && /:root\.framed\.with-dock \.content\.pat-c[^{]*\{ height: calc\(100% - var\(--dock-band\)\)/.test(css) && /\.dock-band \{[^}]*height: var\(--dock-band\)/.test(css));
}

/* ------------------------------------------------------- Command Center --- */

console.log("\nthe Command Center's drawer");
{
  const cc = render(admin, { bare: true, active: "joya-ai", brand: "ai" });
  check("the CC renders the sidebar too (hidden until #cc-os-btn opens it)", /<aside class="sidebar" id="sidebar"/.test(cc) && /<div class="layout bare">/.test(cc) && /<a href="\/joya-ai" class="side-item on" aria-current="page"/.test(cc));
  check("  its ☰ toggles that drawer (data-os-toggle), over its own scrim (data-os-close)", /<button class="nav-toggle"[^>]*data-os-toggle>/.test(cc) && /<div class="os-scrim" id="os-scrim" data-os-close hidden><\/div>/.test(cc));
  check("  no page head (the CC lays out its own screen), no frame marker", !/class="page-head/.test(cc) && /<html lang="en">/.test(cc) && /<main class="content flush"[^>]*>/.test(cc));
  check("an ordinary page's ☰ is the phone nav, with no OS scrim", /data-nav-toggle>/.test(render(admin)) && !/os-scrim/.test(render(admin)));
  const views = lib("views-joyaai");
  const page = views.page({ csrf: "t", user: { name: "Ann", roleLabel: "Administrator", perm: admin }, voice: { configured: false } });
  check("the Command Center page: #cc-os-btn with data-os-toggle in its rail", /<button type="button" class="cc-os-btn" id="cc-os-btn" data-os-toggle aria-controls="sidebar"/.test(page));
  check("  and the sidebar markup it opens", /<aside class="sidebar" id="sidebar"/.test(page));
  const app = fs.readFileSync(path.join(ROOT, "public", "app.js"), "utf8");
  check("app.js wires the drawer (os-drawer on <html>, data-os-toggle / data-os-close)", /open: "os-drawer", toggle: "data-os-toggle", close: "data-os-close"/.test(app));
  const mcss = fs.readFileSync(path.join(ROOT, "public", "joya-os.css"), "utf8");
  check("joya-os.css shows the drawer only when open on the CC", /:root\.cc-page\.os-drawer \.sidebar \{ transform: none; \}/.test(mcss) && /:root\.cc-page\.os-drawer \.os-scrim \{ display: block; \}/.test(mcss));
}

/* -------------------------------------------------------------- styles --- */

console.log("\nstyles: the logo rules reach the logo only");
{
  const style = fs.readFileSync(path.join(ROOT, "public", "style.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  const selectors = style.split("}").map((r) => r.split("{")[0]).join(",").split(",").map((s) => s.trim());
  const bare = selectors.filter((s) => /(^|[\s>+~])\.brand(?![\w-])/.test(s) && !/\.topbar > \.brand/.test(s) && !/\.pill\.brand/.test(s));
  check("no bare .brand rule in style.css (it matched <span class=\"pill brand\">)", !/(^|\n)\s*\.brand\s*\{/.test(style) && bare.length === 0, bare.join(" | "));
  check("the logo rules are scoped .topbar > .brand", /\.topbar > \.brand \{/.test(style));
  const access = lib("views-access");
  const src = fs.readFileSync(path.join(ROOT, "lib", "views-access.js"), "utf8");
  check("the administrator role badge is .pill.solid", /"solid" : "neutral"/.test(src) && /\.pill\.brand, \.pill\.solid(, \.pill\.ai)? \{/.test(style + fs.readFileSync(path.join(ROOT, "public", "joya-ds.css"), "utf8")));
  check("  Users and Roles tables are rows stack aligned", /class="rows stack aligned"/.test(src) && typeof access.users === "function");
}

fs.rmSync(process.env.JOYA_DATA_DIR, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
