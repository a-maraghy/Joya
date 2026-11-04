#!/usr/bin/env node
"use strict";
/**
 * JOYA AI ▸ Settings ▸ ChatGPT (lib/routes-chatgpt.js) over HTTP on a scratch
 * copy (tools/scratch-server.cjs: no helper; the chatgpt-* and agent-chatgpt
 * subcommands answered from a fake). Checks: who may open it, what it shows
 * (and never shows), the sign-in flow (Windows Hello / code first, the link and
 * code on the page, the poll), and the per-agent switch.
 *
 *     NODE_PATH=/opt/joya-dashboard/node_modules node dashboard/tools/test-chatgpt-settings.cjs
 *     SHOTS=/dir also writes screenshots (PLAYWRIGHT=/path/to/playwright)
 */
const { startScratch, DATA } = require("./scratch-server.cjs"); // first: sets JOYA_DATA_DIR
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

const ago = (h) => new Date(Date.now() - h * 3600e3).toISOString();
const AGENTS = [
  { slug: "odoo-dev", name: "Odoo Dev", chatgpt: true, state: { active: "active" }, channel: null },
  { slug: "research", name: "Research", chatgpt: false, state: { active: "inactive" }, channel: null },
];
const CALLS = [
  { ts: ago(0.2), caller: "agent:odoo-dev", ok: true, kind: null, seconds: 55, out_files: 2, in_files: 0 },
  { ts: ago(1), caller: "joya-ai", ok: true, kind: null, seconds: 5.3, out_files: 0, in_files: 0 },
  { ts: ago(3), caller: "hired:invoice-audit", ok: false, kind: "timeout", error: "ChatGPT took longer than 10 minutes", seconds: 600, out_files: 0, in_files: 1 },
  { ts: ago(5), caller: "console:full", ok: true, kind: null, seconds: 31, out_files: 1, in_files: 2 },
];
const FAKE = () => JSON.parse(fs.readFileSync(path.join(DATA, "fake-chatgpt.json"), "utf8"));
const setFake = (f) => { const c = FAKE(); f(c); fs.writeFileSync(path.join(DATA, "fake-chatgpt.json"), JSON.stringify(c)); };
const form = (o) => new URLSearchParams(o).toString();
const fetchH = { "X-Requested-With": "fetch", Accept: "application/json" };

(async () => {
  let s;
  try {
    s = await startScratch({ fakeReads: { "agent-list": AGENTS }, fakeChatgpt: { calls: CALLS, inactive: ["research"] } });
    const adminU = await s.makeUser("gptadmin", "administrator");
    await s.makeUser("gptuse", "joya-user", ["joyaai.use"]);
    const A = await s.signIn("gptadmin");
    const U = await s.signIn("gptuse");
    const { authenticator } = require("otplib");
    // Each code is burned (lib/stepup.js), and sign-in used this window's: wait for the next one.
    let codeStep = Math.floor(Date.now() / 30000);
    const freshCode = async () => {
      while (Math.floor(Date.now() / 30000) === codeStep) await new Promise((r) => setTimeout(r, 500));
      codeStep = Math.floor(Date.now() / 30000);
      return authenticator.generate(adminU.secret);
    };

    console.log("who may open it");
    let r = await s.req("GET", "/joya-ai/settings/chatgpt", { cookie: A.cookie });
    check("an administrator opens Settings ▸ ChatGPT (200), marked current", r.status === 200 && /href="\/joya-ai\/settings\/chatgpt" class="on" aria-current="page"/.test(r.body), r.status);
    const html = r.body;
    const tok = s.csrfOf(html);
    let u = await s.req("GET", "/joya-ai/settings/chatgpt", { cookie: U.cookie });
    check("a JOYA AI user who is not the administrator is refused (403), and the section is not in their nav", u.status === 403);
    u = await s.req("GET", "/joya-ai/settings/appearance", { cookie: U.cookie });
    const nav = (/<nav class="set-nav"[^>]*>([\s\S]*?)<\/nav>/.exec(u.body) || [])[1] || "";
    check("  their sub-nav has no ChatGPT", u.status === 200 && nav && !/settings\/chatgpt/.test(nav));
    u = await s.req("GET", "/joya-ai/settings/chatgpt/login/state", { cookie: U.cookie, headers: fetchH });
    check("  nor its sign-in state (403)", u.status === 403);

    console.log("what the page shows");
    check("the sign-in: Signed in, with the account type, and a Sign in again form with step-up", /Signed in/.test(html) && /\(ChatGPT account\)/.test(html) && /action="\/joya-ai\/settings\/chatgpt\/login"[^>]*data-step-up/.test(html) && />Sign in again</.test(html));
    check("the service: running, 0 running · 0 waiting, the limits", /Running/.test(html) && /0 running · 0 waiting/.test(html) && /2 at a time · 8 waiting · 10 min per task/.test(html));
    check("JOYA AI is shown always on", /id="gpt-joya-ai"/.test(html) && /Always on/.test(html));
    check("one switch per Telegram agent, in its current state", /aria-label="ChatGPT for Odoo Dev" checked/.test(html) && /aria-label="ChatGPT for Research"(?! checked)/.test(html));
    check("recent calls: one row per call, newest first, callers in words", (html.match(/<tr><td data-h="When">/g) || []).length === 4 && html.indexOf("Odoo Dev</span><span class=\"sub\">Telegram agent") < html.indexOf("the assistant") && /invoice-audit<\/span><span class="sub">hired session/.test(html) && /Console<\/span><span class="sub">full access/.test(html));
    check("  outcome and the short error, duration, files back", /Failed<\/span><span class="sub">ChatGPT took longer than 10 minutes/.test(html) && /10 min 0 s/.test(html) && /data-h="Files back" class="num">2</.test(html));
    const sec = (/<div class="set-sec[^"]*" id="set-sec">([\s\S]*)<\/div><\/div>/.exec(html) || [])[1] || "";
    check("the page never carries a task, an answer or a token", sec.length > 1000 && !/task_chars|answer_chars|"task"|auth\.json|access_token|refresh_token|id_token/i.test(sec));
    check("the page script is loaded, no inline script or style", /chatgpt-settings\.js\?v=/.test(html) && !/\sstyle=/.test(html) && !/<script>(?!<\/script>)/.test(html));

    console.log("the per-agent switch");
    r = await s.req("POST", "/joya-ai/settings/chatgpt/agent", { cookie: A.cookie, headers: fetchH, body: form({ slug: "research", on: "0" }) });
    check("no CSRF token: refused", r.status === 403, r.status);
    r = await s.req("POST", "/joya-ai/settings/chatgpt/agent", { cookie: A.cookie, headers: fetchH, body: "_csrf=" + encodeURIComponent(tok) + "&slug=research&on=0&on=1" });
    check("switching Research on goes to the helper (agent-chatgpt research on)", r.status === 200 && FAKE().log.includes("agent-chatgpt research on"), r.status + " " + JSON.stringify(FAKE().log));
    check("  not running: the note says it applies when it starts", /ChatGPT is on for research\. It applies when the agent starts/.test(JSON.parse(r.body).flash || ""), r.body);
    r = await s.req("POST", "/joya-ai/settings/chatgpt/agent", { cookie: A.cookie, headers: fetchH, body: form({ _csrf: tok, slug: "odoo-dev", on: "1" }) });
    check("running and idle (no turn running): the note offers Restart now and the page reloads", /ChatGPT is on for odoo-dev\. Restart it now to apply it, or it applies at its next restart/.test(JSON.parse(r.body).flash || "") && JSON.parse(r.body).reload === true, r.body);
    r = await s.req("GET", "/joya-ai/settings/chatgpt", { cookie: A.cookie });
    check("  its row shows Restart now (and no other row does)", /id="gpt-restart-odoo-dev"/.test(r.body) && (r.body.match(/id="gpt-restart-/g) || []).length === 1);
    r = await s.req("POST", "/joya-ai/settings/chatgpt/agent/restart", { cookie: A.cookie, headers: fetchH, body: form({ slug: "odoo-dev" }) });
    check("  Restart now without the CSRF token: refused", r.status === 403, r.status);
    r = await s.req("POST", "/joya-ai/settings/chatgpt/agent/restart", { cookie: A.cookie, headers: fetchH, body: form({ _csrf: tok, slug: "odoo-dev" }) });
    check("  Restart now goes to the helper's idle-only restart (agent-restart-idle odoo-dev)", r.status === 200 && FAKE().log.includes("agent-restart-idle odoo-dev") && /odoo-dev restarted/.test(JSON.parse(r.body).flash || ""), r.status + " " + r.body);
    r = await s.req("GET", "/joya-ai/settings/chatgpt", { cookie: A.cookie });
    check("  and the button is gone after it", !/id="gpt-restart-odoo-dev"/.test(r.body));
    setFake((c) => (c.busy = { "odoo-dev": true }));
    r = await s.req("POST", "/joya-ai/settings/chatgpt/agent", { cookie: A.cookie, headers: fetchH, body: form({ _csrf: tok, slug: "odoo-dev", on: "1" }) });
    check("busy (mid-turn): the note says it applies at the next restart, no Restart now", /answering a message right now, so this applies at its next restart/.test(JSON.parse(r.body).flash || ""), r.body);
    r = await s.req("GET", "/joya-ai/settings/chatgpt", { cookie: A.cookie });
    check("  and its row offers no restart", !/id="gpt-restart-odoo-dev"/.test(r.body));
    r = await s.req("POST", "/joya-ai/settings/chatgpt/agent/restart", { cookie: A.cookie, headers: fetchH, body: form({ _csrf: tok, slug: "odoo-dev" }) });
    check("  a forced Restart now on a busy agent is refused by the helper and says why", r.status === 400 && /answering a message right now, so it was not restarted/.test(JSON.parse(r.body).flash || ""), r.status + " " + r.body);
    setFake((c) => (c.busy = {}));
    r = await s.req("POST", "/joya-ai/settings/chatgpt/agent", { cookie: A.cookie, headers: fetchH, body: form({ _csrf: tok, slug: "odoo-dev", on: "0" }) });
    check("switching Odoo Dev off sends off", r.status === 200 && FAKE().log.includes("agent-chatgpt odoo-dev off"));
    r = await s.req("POST", "/joya-ai/settings/chatgpt/agent", { cookie: A.cookie, headers: fetchH, body: form({ _csrf: tok, slug: "../etc", on: "1" }) });
    check("a bad slug never reaches the helper", r.status === 400 && !FAKE().log.some((l) => /\.\./.test(l)));
    r = await s.req("POST", "/joya-ai/settings/chatgpt/agent", { cookie: U.cookie, headers: fetchH, body: form({ _csrf: tok, slug: "odoo-dev", on: "1" }) });
    check("a non-administrator cannot switch (403)", r.status === 403);

    console.log("sign in again");
    r = await s.req("POST", "/joya-ai/settings/chatgpt/login", { cookie: A.cookie, headers: fetchH, body: form({ _csrf: tok }) });
    let j = JSON.parse(r.body || "{}");
    check("without a proof: 428 and a step-up challenge (Windows Hello or the code)", r.status === 428 && j.step_up && j.step_up.totp === true, r.status + " " + r.body.slice(0, 200));
    check("  nothing was started", !FAKE().log.includes("login-start"));
    r = await s.req("POST", "/joya-ai/settings/chatgpt/login", { cookie: A.cookie, headers: fetchH, body: form({ _csrf: tok, step_up: JSON.stringify({ totp: await freshCode() }) }) });
    j = JSON.parse(r.body || "{}");
    check("with the authenticator code: started (helper chatgpt-login-start)", r.status === 200 && j.ok && FAKE().log.includes("login-start"), r.status + " " + r.body.slice(0, 200));
    r = await s.req("GET", "/joya-ai/settings/chatgpt", { cookie: A.cookie });
    check("the page shows the link and the one-time code, and no Sign in again button while it waits", /href="https:\/\/auth\.openai\.com\/codex\/device" target="_blank" rel="noopener noreferrer"/.test(r.body) && /<code class="gpt-code" id="gpt-code">ABCD-12345<\/code>/.test(r.body) && !/>Sign in again</.test(r.body) && /id="gpt-login-state" role="status" aria-live="polite"/.test(r.body));
    if (process.env.SHOTS) await shots(s, A.cookie, "pending");
    check("  the account row says it waits (not Signed in), and offers Cancel and Copy code", /Waiting for sign-in/.test(r.body) && !/>Signed in</.test(r.body) && /action="\/joya-ai\/settings\/chatgpt\/login\/cancel"/.test(r.body) && /id="gpt-copy" data-copy="ABCD-12345"/.test(r.body));
    r = await s.req("GET", "/joya-ai/settings/chatgpt/login/state", { cookie: A.cookie, headers: fetchH });
    check("the poll says pending while the person has not finished", JSON.parse(r.body).state === "pending");
    setFake((c) => (c.login.state = "done"));
    r = await s.req("GET", "/joya-ai/settings/chatgpt/login/state", { cookie: A.cookie, headers: fetchH });
    check("then done", JSON.parse(r.body).state === "done");
    r = await s.req("GET", "/joya-ai/settings/chatgpt/login/state", { cookie: A.cookie, headers: fetchH });
    check("  and afterwards nothing is waiting", JSON.parse(r.body).state === "none");
    r = await s.req("GET", "/joya-ai/settings/chatgpt", { cookie: A.cookie });
    check("  the page is back to Signed in with the button", /Signed in/.test(r.body) && />Sign in again</.test(r.body) && !/gpt-code/.test(r.body));

    console.log("cancel");
    r = await s.req("POST", "/joya-ai/settings/chatgpt/login", { cookie: A.cookie, headers: fetchH, body: form({ _csrf: tok, step_up: JSON.stringify({ totp: await freshCode() }) }) });
    setFake((c) => (c.login.state = "pending"));
    r = await s.req("POST", "/joya-ai/settings/chatgpt/login/cancel", { cookie: A.cookie, headers: fetchH, body: form({ _csrf: tok }) });
    check("Cancel stops the waiting sign-in through the helper (chatgpt-login-cancel)", r.status === 200 && FAKE().log.some((l) => /^login-cancel 0123456789abcdef$/.test(l)), JSON.stringify(FAKE().log));
    r = await s.req("GET", "/joya-ai/settings/chatgpt/login/state", { cookie: A.cookie, headers: fetchH });
    check("  and nothing waits afterwards", JSON.parse(r.body).state === "none");

    console.log("states");
    setFake((c) => { c.status.login = "expired"; });
    r = await s.req("GET", "/joya-ai/settings/chatgpt", { cookie: A.cookie });
    check("an expired sign-in says so, with the primary Sign in again", /Sign-in expired/.test(r.body) && /class="btn primary">[\s\S]{0,400}Sign in again/.test(r.body));
    setFake((c) => { c.status.login = "signed_out"; c.status.service = "inactive"; c.status.answering = false; c.calls = []; });
    r = await s.req("GET", "/joya-ai/settings/chatgpt", { cookie: A.cookie });
    check("not signed in, broker stopped, no calls: each said in words", /Not signed in/.test(r.body) && />Sign in</.test(r.body) && /Stopped/.test(r.body) && /No calls yet/.test(r.body));
    if (process.env.SHOTS) await shots(s, A.cookie, "signed-out");

    console.log("JOYA AI may open it");
    // The page map is built from the source (lib/page-registry.js); page.open checks keys against it.
    const reg = require(path.join(__dirname, "..", "lib", "page-registry.js"));
    const built = reg.build();
    const entries = Array.isArray(built) ? built : built.entries || [];
    check("the page registry lists it as a Settings section", entries.some((e) => e.key === "settings.chatgpt" && e.kind === "section" && e.url === "/joya-ai/settings/chatgpt"), JSON.stringify(Object.keys(built)).slice(0, 200));
    check("  with its sign-in row as an anchor (#gpt-account)", entries.some((e) => e.parent === "settings.chatgpt" && /#gpt-account$/.test(e.url)));
    const UA = require(path.join(__dirname, "..", "public", "ui-actions.js"));
    UA.setPages(entries);
    check("  and page.open accepts settings.chatgpt once the map carries it", UA.validate("page.open", { page: "settings.chatgpt" }).ok !== false && UA.pages()["settings.chatgpt"]);
  } catch (e) {
    failed++;
    console.log("  FAIL (threw) " + (e && e.stack));
  } finally {
    if (s) s.stop();
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();

async function shots(s, cookie, tag) {
  const { chromium } = require(process.env.PLAYWRIGHT || "playwright");
  const b = await chromium.launch();
  for (const [w, h] of [[1440, 900], [390, 844]]) for (const theme of ["light", "dark"]) {
    const ctx = await b.newContext({ viewport: { width: w, height: h }, colorScheme: theme, extraHTTPHeaders: { "X-Forwarded-Proto": "https" } });
    await ctx.addInitScript((t) => { try { localStorage.setItem("joya-theme", t); } catch (_) {} }, theme);
    await ctx.addCookies(String(cookie).split("; ").filter(Boolean).map((kv) => ({ name: kv.split("=")[0], value: kv.slice(kv.indexOf("=") + 1), url: "http://127.0.0.1:" + s.port })));
    const p = await ctx.newPage();
    await p.goto("http://127.0.0.1:" + s.port + "/joya-ai/settings/chatgpt#gpt-account", { waitUntil: "load" });
    await p.waitForTimeout(600);
    await p.screenshot({ path: path.join(process.env.SHOTS, `chatgpt-${tag}-${w}-${theme}.png`) });
    await ctx.close();
  }
  await b.close();
}
