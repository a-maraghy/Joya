#!/usr/bin/env node
"use strict";
/**
 * JOYA AI ▸ Settings (/joya-ai/settings/<section>, lib/routes-settings.js,
 * lib/views-settings.js) and the redirects of the reorganisation, over HTTP
 * on a scratch copy of the dashboard (tools/scratch-server.cjs: no helper)
 * with a small fake JOYA AI supervisor on a unix socket that records every op
 * the panel sends.
 *
 *     NODE_PATH=/opt/joya-dashboard/node_modules node dashboard/tools/test-settings.cjs
 */
const { startScratch, DATA } = require("./scratch-server.cjs"); // first: sets JOYA_DATA_DIR
const net = require("net");
const fs = require("fs");
const path = require("path");

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

/* ------------------------------------------------- the fake supervisor --- */

const SOCK = path.join(DATA, "fake-sup.sock");
const seen = []; // every op the panel sent: { op, actor, ...params }
const S = {
  hire: { max_live: 7, per_hour: 3, perm_mode: "auto", defaults: { max_live: 7, per_hour: 3, perm_mode: "auto" }, bounds: { max_live: [1, 12], per_hour: [0, 10] }, modes: ["auto", "default", "plan"], live: 2, hired: 1 },
  timeout: { seconds: 300, default: 300, bounds: [30, 3600] },
  warn: 80,
  def: { cap: 5e6, at: "pause" },
  caps: { "<self>": { cap: 20e6, at: "warn" }, "planning-audit": { cap: 5e6, at: "pause" } },
};
const sessions = [
  { pid: 100, session_id: "00000000-0000-0000-0000-000000000000", name: "JOYA AI", self: true, status: "idle", tokens_today: { total: 6.2e6 } },
  { pid: 103, session_id: "33333333-3333-3333-3333-333333333333", name: "Planning audit", self: false, hired: true, status: "busy", hire: { slug: "planning-audit", name: "Planning audit", kept: false }, tokens_today: { total: 5.4e6 } },
];
const keyOf = (x) => (x.self ? "<self>" : x.hire ? x.hire.slug : x.session_id);
function capsView() {
  return {
    day: new Date().toISOString().slice(0, 10),
    warn_pct: S.warn,
    default: S.def,
    sessions: sessions.map((x) => {
      const c = S.caps[keyOf(x)] || { cap: null, at: "warn" };
      const kind = x.self ? "self" : x.hire ? "hired" : "yours";
      return { key: keyOf(x), name: x.name, kind, session_id: x.session_id, cap: c.cap, at: c.at, today: { total: x.tokens_today.total }, state: "ok", paused: kind === "hired", resumed: false, warned: false, can_pause: kind !== "yours" };
    }),
  };
}
const OPS = {
  ping: () => ({ pong: true }),
  status: () => ({ name: "JOYA AI", process: { state: "ready", model: "claude-opus-5-5", effort: "high", permission_mode: "auto", cli_version: "2.1", cwd: "/root/joya-ai", tz: "Africa/Cairo" }, busy: false, remote_control: { enabled: false }, approvals: [], queued: [], counts: {} }),
  sessions: () => ({ at: new Date().toISOString(), error: null, sessions }),
  "hire-limits": () => S.hire,
  "hire-limits-set": (p) => (["max_live", "per_hour", "perm_mode"].forEach((k) => p[k] !== undefined && (S.hire[k] = p[k])), S.hire),
  "approval-timeout": () => S.timeout,
  "approval-timeout-set": (p) => ((S.timeout.seconds = p.seconds), S.timeout),
  "token-caps": capsView,
  "token-caps-set": (p) => {
    if (p.warn_pct) S.warn = p.warn_pct;
    if (p.key === "default") S.def = { cap: p.cap, at: p.at };
    else if (p.key) S.caps[p.key] = { cap: p.cap, at: p.at };
    return capsView();
  },
  "budget-resume": (p) => ({ resumed: p.key || p.decision_id }),
  watchers: () => ({ watchers: [{ key: "disk", name: "Disk over threshold", enabled: true }] }),
  orders: () => ({ orders: [{ id: 1, name: "Morning briefing", seed_key: "morning-briefing", paused: false }] }),
  charter: () => ({ path: "/root/joya-ai/CLAUDE.md", text: "# JOYA AI\n", truncated: false }),
  "ui-pages": (p) => ({ count: (p.pages || []).length, applied: true }),
  decisions: () => ({ decisions: [] }),
};
const server = net.createServer((c) => {
  let buf = "";
  c.setEncoding("utf8");
  c.on("data", (d) => {
    buf += d;
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      let m;
      try {
        m = JSON.parse(line);
      } catch (_) {
        continue;
      }
      if (m.op !== "events") seen.push(m);
      const f = OPS[m.op];
      c.write(JSON.stringify({ id: m.id, ok: true, data: m.op === "events" ? { seq: 1 } : f ? f(m) : {} }) + "\n");
    }
  });
  c.on("error", () => {});
});

const last = (op) => seen.filter((m) => m.op === op).pop();
const count = (op) => seen.filter((m) => m.op === op).length;
const navOf = (html) => [...((/<nav class="set-nav"[^>]*>([\s\S]*?)<\/nav>/.exec(html) || [])[1] || "").matchAll(/href="\/joya-ai\/settings\/([a-z]+)"/g)].map((m) => m[1]);
const ALL = ["general", "voice", "chatgpt", "appearance", "sessions", "screen", "approvals", "proactive", "usage"];

(async () => {
  await new Promise((r) => server.listen(SOCK, r));
  let s;
  try {
    s = await startScratch({ env: { JOYA_AI_SOCKET: SOCK } });
    const adminU = await s.makeUser("setadmin", "administrator");
    await s.makeUser("setuse", "joya-user", ["joyaai.use"]);
    await s.makeUser("setvoice", "joya-voice", ["joyaai.use", "voice.manage"]);
    await s.makeUser("setview", "viewer");
    const A = await s.signIn("setadmin");
    // Resume asks for Windows Hello or the authenticator code (lib/stepup.js); here the code. Each code is burned.
    const { authenticator } = require("otplib");
    let codeStep = Math.floor(Date.now() / 30000);
    const freshCode = async () => {
      while (Math.floor(Date.now() / 30000) === codeStep) await new Promise((r) => setTimeout(r, 500));
      codeStep = Math.floor(Date.now() / 30000);
      return authenticator.generate(adminU.secret);
    };
    const U = await s.signIn("setuse");
    const Vo = await s.signIn("setvoice");
    const Vw = await s.signIn("setview");
    const db = require(path.join(__dirname, "..", "lib", "db.js")); // the scratch data dir (JOYA_DATA_DIR), as makeUser uses

    console.log("section access");
    let r = await s.req("GET", "/joya-ai/settings", { cookie: A.cookie });
    check("/joya-ai/settings -> the first section the viewer may open (admin: General)", r.status === 302 && r.headers.location === "/joya-ai/settings/general", r.status + " " + r.headers.location);
    r = await s.req("GET", "/joya-ai/settings/general", { cookie: A.cookie });
    check("an administrator sees all nine sections (Advanced joined General)", JSON.stringify(navOf(r.body)) === JSON.stringify(ALL), navOf(r.body).join());
    const aTok = s.csrfOf(r.body);
    for (const k of ALL) {
      const x = await s.req("GET", "/joya-ai/settings/" + k, { cookie: A.cookie });
      check(`  ${k} renders (200), marked current in the sub-nav`, x.status === 200 && new RegExp(`href="/joya-ai/settings/${k}" class="on" aria-current="page"`).test(x.body) && /id="set-sec"/.test(x.body), x.status);
    }
    r = await s.req("GET", "/joya-ai/settings/general", { cookie: A.cookie });
    check("the frame marks JOYA AI ▸ Settings (crumbs and sidebar)", /<a href="\/joya-ai\/settings" class="side-item on"/.test(r.body) && /<nav class="crumbs"[^>]*><a href="\/joya-ai">JOYA AI<\/a>/.test(r.body));
    check("General reads the supervisor's status and charter", count("status") > 0 && count("charter") > 0 && /claude-opus-5-5/.test(r.body));
    check("General carries Restart JOYA AI (Advanced merged in) and the read-only facts under one Details disclosure", /action="\/joya-ai\/settings\/general\/restart"/.test(r.body) && /<details class="set-more" id="g-details"><summary>Details: model, folder, version, time zone<\/summary>/.test(r.body) && !/>Name</.test(r.body));
    r = await s.req("GET", "/joya-ai/settings/advanced", { cookie: A.cookie });
    check("the old Advanced URL lands on General's Restart row", r.status === 302 && r.headers.location === "/joya-ai/settings/general#x-restart", r.status + " " + r.headers.location);

    r = await s.req("GET", "/joya-ai/settings", { cookie: U.cookie });
    check("joyaai.use only -> /joya-ai/settings/appearance", r.status === 302 && r.headers.location === "/joya-ai/settings/appearance", r.headers.location);
    r = await s.req("GET", "/joya-ai/settings/appearance", { cookie: U.cookie });
    check("  sees Appearance and Briefs & watchers only (both their own)", r.status === 200 && navOf(r.body).join() === "appearance,proactive", navOf(r.body).join());
    const uTok = s.csrfOf(r.body);
    for (const k of ["general", "voice", "sessions", "screen", "approvals", "usage"]) {
      const x = await s.req("GET", "/joya-ai/settings/" + k, { cookie: U.cookie });
      check(`  ${k} is refused (403)`, x.status === 403, x.status);
    }
    r = await s.req("GET", "/joya-ai/settings/voice", { cookie: Vo.cookie });
    check("joyaai.use + voice.manage sees Voice, Appearance and Briefs & watchers", r.status === 200 && navOf(r.body).join() === "voice,appearance,proactive", r.status + " " + navOf(r.body).join());
    r = await s.req("GET", "/joya-ai/settings/usage", { cookie: Vo.cookie });
    check("  but not the administrator's sections", r.status === 403, r.status);
    r = await s.req("GET", "/joya-ai/settings", { cookie: Vw.cookie });
    check("a role without joyaai.use gets no Settings at all", r.status === 403, r.status);
    r = await s.req("GET", "/joya-ai/settings/appearance", { cookie: Vw.cookie });
    check("  not even Appearance", r.status === 403, r.status);
    r = await s.req("GET", "/joya-ai/settings/nope", { cookie: A.cookie });
    check("an unknown section is not a page", r.status === 404, r.status);

    console.log("\nlive forms: JSON for os.js, a redirect without it");
    const fetchH = { "X-Requested-With": "fetch" };
    const form = (o) => new URLSearchParams(o).toString();
    let before = count("hire-limits-set");
    r = await s.req("POST", "/joya-ai/settings/sessions/limits", { cookie: A.cookie, headers: fetchH, body: form({ _csrf: aTok, max_live: "13" }) });
    let j = JSON.parse(r.body || "{}");
    check("hire limits out of bounds (13 live) -> 400 with the flash, nothing sent", r.status === 400 && j.ok === false && /1 to 12/.test(j.flash) && /alert bad/.test(j.flash) && count("hire-limits-set") === before, r.status + " " + r.body);
    r = await s.req("POST", "/joya-ai/settings/sessions/limits", { cookie: A.cookie, headers: fetchH, body: form({ _csrf: aTok, per_hour: "11" }) });
    check("  hires per hour 11 -> 400", r.status === 400 && /0 to 10/.test(JSON.parse(r.body).flash) && count("hire-limits-set") === before);
    r = await s.req("POST", "/joya-ai/settings/sessions/limits", { cookie: A.cookie, headers: fetchH, body: form({ _csrf: aTok, perm_mode: "bypassPermissions" }) });
    check("  bypassPermissions is refused", r.status === 400 && count("hire-limits-set") === before);
    r = await s.req("POST", "/joya-ai/settings/sessions/limits", { cookie: A.cookie, headers: fetchH, body: form({ _csrf: aTok, max_live: "5", per_hour: "2" }) });
    j = JSON.parse(r.body || "{}");
    let q = last("hire-limits-set");
    check("in bounds -> 200 JSON, and hire-limits-set with exactly those values, as the signed-in user", r.status === 200 && j.ok === true && /alert good/.test(j.flash) && q && q.max_live === 5 && q.per_hour === 2 && q.perm_mode === undefined && /setadmin/.test(JSON.stringify(q.actor)), JSON.stringify(q));
    r = await s.req("POST", "/joya-ai/settings/sessions/limits", { cookie: A.cookie, body: form({ _csrf: aTok, max_live: "0" }) });
    check("without JavaScript: a 303 back to the row, with the error", r.status === 303 && /^\/joya-ai\/settings\/sessions\?err=.*#s-max-live$/.test(r.headers.location), r.status + " " + r.headers.location);
    r = await s.req("POST", "/joya-ai/settings/sessions/limits", { cookie: A.cookie, headers: fetchH, body: form({ _csrf: "wrong", max_live: "4" }) });
    check("a form without its CSRF token is refused", r.status === 403 && last("hire-limits-set").max_live === 5);
    r = await s.req("POST", "/joya-ai/settings/sessions/limits", { cookie: U.cookie, headers: fetchH, body: form({ _csrf: uTok, max_live: "4" }) });
    check("a role that may not open the section cannot post to it (403 JSON)", r.status === 403 && JSON.parse(r.body).ok === false && last("hire-limits-set").max_live === 5, r.status);

    before = count("approval-timeout-set");
    r = await s.req("POST", "/joya-ai/settings/approvals/timeout", { cookie: A.cookie, headers: fetchH, body: form({ _csrf: aTok, seconds: "10" }) });
    check("approval timeout under 30 s -> 400, nothing sent", r.status === 400 && count("approval-timeout-set") === before);
    r = await s.req("POST", "/joya-ai/settings/approvals/timeout", { cookie: A.cookie, headers: fetchH, body: form({ _csrf: aTok, seconds: "600" }) });
    check("  600 s -> approval-timeout-set {seconds: 600}", r.status === 200 && last("approval-timeout-set").seconds === 600);

    console.log("\ntoken caps");
    before = count("token-caps-set");
    r = await s.req("POST", "/joya-ai/settings/usage/cap", { cookie: A.cookie, headers: fetchH, body: form({ _csrf: aTok, key: "planning-audit", cap_m: "0.05", at: "pause" }) });
    check("a cap under 0.1 M tokens is refused", r.status === 400 && count("token-caps-set") === before);
    r = await s.req("POST", "/joya-ai/settings/usage/cap", { cookie: A.cookie, headers: fetchH, body: form({ _csrf: aTok, key: "bad key!", cap_m: "5" }) });
    check("a malformed session key is refused", r.status === 400 && count("token-caps-set") === before);
    r = await s.req("POST", "/joya-ai/settings/usage/cap", { cookie: A.cookie, headers: fetchH, body: form({ _csrf: aTok, key: "planning-audit", cap_m: "7.5", at: "pause" }) });
    q = last("token-caps-set");
    check("cap set -> token-caps-set {key, cap in tokens, at}", r.status === 200 && q.key === "planning-audit" && q.cap === 7.5e6 && q.at === "pause", JSON.stringify(q));
    r = await s.req("POST", "/joya-ai/settings/usage/cap", { cookie: A.cookie, headers: fetchH, body: form({ _csrf: aTok, key: "<self>", cap_m: "", at: "warn" }) });
    q = last("token-caps-set");
    check("  an empty cap is no cap (null), any other at is warn", r.status === 200 && q.key === "<self>" && q.cap === null && q.at === "warn", JSON.stringify(q));
    r = await s.req("POST", "/joya-ai/settings/usage/cap", { cookie: A.cookie, headers: fetchH, body: form({ _csrf: aTok, key: "default", cap_m: "4", at: "pause" }) });
    check("  the default for new hires", r.status === 200 && last("token-caps-set").key === "default" && last("token-caps-set").cap === 4e6);
    r = await s.req("POST", "/joya-ai/settings/usage/warn", { cookie: A.cookie, headers: fetchH, body: form({ _csrf: aTok, warn_pct: "40" }) });
    check("the warning line under 50 % is refused", r.status === 400);
    r = await s.req("POST", "/joya-ai/settings/usage/warn", { cookie: A.cookie, headers: fetchH, body: form({ _csrf: aTok, warn_pct: "85" }) });
    check("  85 % -> token-caps-set {warn_pct: 85}", r.status === 200 && last("token-caps-set").warn_pct === 85);
    r = await s.req("GET", "/joya-ai/settings/usage", { cookie: A.cookie });
    check("Usage lists the sessions' caps from token-caps (a paused hire has Resume)", r.status === 200 && /id="u-caps"/.test(r.body) && /Planning audit/.test(r.body) && /action="\/joya-ai\/settings\/usage\/resume"/.test(r.body));
    r = await s.req("POST", "/joya-ai/settings/usage/resume", { cookie: A.cookie, headers: fetchH, body: form({ _csrf: aTok, key: "planning-audit" }) });
    check("Resume without Windows Hello or the code -> 428, nothing resumed", r.status === 428 && count("budget-resume") === 0, r.status);
    r = await s.req("POST", "/joya-ai/settings/usage/resume", { cookie: A.cookie, headers: fetchH, body: form({ _csrf: aTok, key: "planning-audit", step_up: JSON.stringify({ totp: await freshCode() }) }) });
    check("Resume (with the code) -> budget-resume {key}", r.status === 200 && last("budget-resume").key === "planning-audit", JSON.stringify(last("budget-resume")));
    r = await s.req("POST", "/joya-ai/api/decisions/21/resume", { cookie: A.cookie, headers: { "X-CSRF-Token": aTok }, body: { step_up: { totp: await freshCode() } } });
    check("a cap card's Resume (decisions/:id/resume) -> budget-resume {decision_id}", r.status === 200 && last("budget-resume").decision_id === 21, r.status + " " + r.body);
    r = await s.req("POST", "/joya-ai/api/decisions/21/resume", { cookie: Vw.cookie, headers: { "X-CSRF-Token": "x" }, body: {} });
    check("  not for a role without joyaai.use", r.status === 403 || r.status === 401, r.status);

    console.log("\nscreen control");
    const me = db.getUserByName("setadmin");
    check("screen actions are on by default", db.getSetting("ui_actions_enabled:" + me.id, null) === null);
    r = await s.req("POST", "/joya-ai/settings/screen/actions", { cookie: A.cookie, headers: fetchH, body: form({ _csrf: aTok }) });
    check("Allow screen actions off -> the per-user setting ui_actions_enabled:<id> = 0", r.status === 200 && db.getSetting("ui_actions_enabled:" + me.id, null) === "0" && /keeps to words/.test(JSON.parse(r.body).flash));
    const routes = require(path.join(__dirname, "..", "lib", "routes-settings.js"));
    check("  which the relay reads (uiActionsEnabled) as off, for that user only", routes.uiActionsEnabled(db, me.id) === false && routes.uiActionsEnabled(db, db.getUserByName("setvoice").id) === true);
    r = await s.req("POST", "/joya-ai/settings/screen/actions", { cookie: A.cookie, headers: fetchH, body: form({ _csrf: aTok, on: "1" }) });
    check("  and back on", db.getSetting("ui_actions_enabled:" + me.id, null) === "1" && routes.uiActionsEnabled(db, me.id) === true);
    const pushes = count("ui-pages");
    r = await s.req("POST", "/joya-ai/settings/screen/rescan", { cookie: A.cookie, headers: fetchH, body: form({ _csrf: aTok }) });
    j = JSON.parse(r.body || "{}");
    check("Rescan pages -> JSON with the scan's steps", r.status === 200 && j.ok === true && Array.isArray(j.steps) && j.steps.length >= 5 && /pages/.test(j.steps[0]) && /Page map rebuilt/.test(j.flash), r.body.slice(0, 300));
    for (let i = 0; i < 20 && count("ui-pages") <= pushes; i++) await new Promise((res) => setTimeout(res, 50));
    check("  and the map is pushed to the supervisor again (op ui-pages, every allowed entry)", count("ui-pages") > pushes && last("ui-pages").pages.length > 50 && last("ui-pages").pages.every((p) => p.key && /^\//.test(p.url)), count("ui-pages") + " " + pushes);
    const n0 = count("ui-pages");
    r = await s.req("POST", "/joya-ai/settings/screen/allow", { cookie: A.cookie, headers: fetchH, body: form({ _csrf: aTok, key: "audit" }) });
    for (let i = 0; i < 20 && count("ui-pages") <= n0; i++) await new Promise((res) => setTimeout(res, 50));
    const pushed = last("ui-pages");
    check("switching an entry off drops it from what the supervisor is told", r.status === 200 && pushed && !pushed.pages.some((p) => p.key === "audit") && pushed.pages.some((p) => p.key === "os"));
    r = await s.req("GET", "/os", { cookie: A.cookie });
    const dp = (/data-pages="([^"]*)"/.exec(r.body) || [])[1] || "";
    check("  and from every page's data-pages", r.status === 200 && dp.length > 0 && !dp.split(" ").includes("audit") && dp.split(" ").includes("os"));
    r = await s.req("POST", "/joya-ai/settings/screen/allow", { cookie: A.cookie, headers: fetchH, body: form({ _csrf: aTok, key: "no.such.entry", on: "1" }) });
    check("an entry that is not in the map is refused", r.status === 400);
    const n1 = count("ui-pages");
    r = await s.req("POST", "/joya-ai/settings/screen/allow-all", { cookie: A.cookie, headers: fetchH, body: form({ _csrf: aTok }) });
    for (let i = 0; i < 20 && count("ui-pages") <= n1; i++) await new Promise((res) => setTimeout(res, 50));
    check("Allow all brings it back", r.status === 200 && last("ui-pages").pages.some((p) => p.key === "audit"));

    console.log("\nredirects of the reorganisation");
    r = await s.req("GET", "/console", { cookie: A.cookie });
    check("/console -> 302 /joya-ai", r.status === 302 && r.headers.location === "/joya-ai", r.status + " " + r.headers.location);
    r = await s.req("GET", "/claude/running", { cookie: A.cookie });
    check("/claude/running -> 302 the Sessions page's Live tab", r.status === 302 && r.headers.location === "/claude/sessions?tab=live", r.status + " " + r.headers.location);
    r = await s.req("GET", "/claude/running?msg=Stopped", { cookie: A.cookie });
    check("  keeping its note", r.status === 302 && r.headers.location === "/claude/sessions?tab=live&msg=Stopped", r.headers.location);
    r = await s.req("GET", "/services/agents", { cookie: A.cookie });
    check("/services/agents -> 302 /services?kind=agents", r.status === 302 && r.headers.location === "/services?kind=agents", r.status + " " + r.headers.location);
    r = await s.req("POST", "/account/appearance", { cookie: A.cookie, body: form({ _csrf: aTok, core: "E" }) });
    check("POST /account/appearance -> back to Settings ▸ Appearance with a note", r.status === 302 && /^\/joya-ai\/settings\/appearance\?msg=.*#a-core$/.test(r.headers.location), r.headers.location);
  } catch (e) {
    check("the run completed", false, e.stack + "\n" + (s ? s.out().slice(-2000) : ""));
  } finally {
    if (s) s.stop();
    server.close();
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
