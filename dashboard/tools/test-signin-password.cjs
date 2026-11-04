#!/usr/bin/env node
"use strict";
/**
 * Password-only sign-in (JOYA_PASSWORD_ONLY=1, lib/signin.js -- what Joya installs), in a real
 * browser: the sign-in page asks for a username and a password and nothing else; the
 * Command Center's decision card says approving asks for the password; Approve -> the
 * "Confirm it is you" dialog asks for the password -> a wrong one is refused, the right one
 * approves (verified=password). No authenticator or passkey wording anywhere it was shown;
 * zero CSP violations and page errors.
 *
 *     NODE_PATH=/opt/joya-dashboard/node_modules PLAYWRIGHT=/path/to/node_modules/playwright \
 *       node dashboard/tools/test-signin-password.cjs [--shots DIR]
 *
 * The scratch copy talks to a fake supervisor (approve / deny / approval-hold
 * recorded); the pending approvals are added to the page's overview by the
 * test (route interception), everything after that is the real page and the
 * real server.
 */
const scratch = require("./scratch-server.cjs"); // first: sets JOYA_DATA_DIR
const crypto = require("crypto");
const net = require("net");
const path = require("path");
const fs = require("fs");

const PW = process.env.PLAYWRIGHT || "playwright";
let chromium;
try {
  ({ chromium } = require(PW));
} catch (e) {
  console.log("FAIL playwright not found (set PLAYWRIGHT=/path/to/node_modules/playwright): " + e.message);
  process.exit(1);
}
const SHOTS = (() => {
  const i = process.argv.indexOf("--shots");
  return i > 0 ? process.argv[i + 1] : null;
})();

let failures = 0;
let passes = 0;
function check(name, ok, detail) {
  if (ok) {
    passes++;
    return console.log("ok   " + name);
  }
  failures++;
  console.log("FAIL " + name + (detail !== undefined ? "  (" + String(detail).slice(0, 400) + ")" : ""));
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const SOCK = path.join(scratch.DATA, "fake-joya-ai-pw.sock");
const seen = [];
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
      let data = {};
      if (m.op === "events") data = { seq: 1 };
      if (m.op === "approve") data = { approval: { ...APPROVAL(m.approval_id), status: "approved", decided_by: m.actor, decided_at: new Date().toISOString(), verified: m.verified } };
      if (m.op === "deny") data = { approval: { ...APPROVAL(m.approval_id), status: "denied", decided_by: m.actor, decided_at: new Date().toISOString() } };
      if (m.op === "approval-hold") data = { expires_at: new Date(Date.now() + 90000).toISOString(), held: true };
      if (m.op === "status") data = { name: "JOYA AI", seq: 1, process: { state: "ready" }, approvals: [] };
      c.write(JSON.stringify({ id: m.id, ok: true, data }) + "\n");
    }
  });
  c.on("error", () => {});
});
const created = new Date().toISOString();
const expires = new Date(Date.now() + 300000).toISOString();
function APPROVAL(id) {
  return {
    id,
    status: "pending",
    tool: "Bash",
    input: { command: id === 31 ? "systemctl restart odoo" : "rm -rf /srv/old-builds" },
    summary: id === 31 ? "systemctl restart odoo" : "rm -rf /srv/old-builds",
    category: id === 31 ? "service_restart" : "delete",
    label: id === 31 ? "Restarts a service" : "Deletes files",
    reason: "The gate treats this as destructive.",
    created_at: created,
    expires_at: expires,
    origin: id === 32 ? "session:worker-a" : "joya-ai",
    origin_name: id === 32 ? "Worker A" : "JOYA AI",
  };
}

(async () => {
  await new Promise((r) => server.listen(SOCK, r));
  const PORT = 3650 + Math.floor(Math.random() * 60);
  const ORIGIN = `http://a.localhost:${PORT}`;
  let s, browser;
  const problems = [];
  try {
    s = await scratch.startScratch({ port: PORT, env: { JOYA_AI_SOCKET: SOCK, JOYA_PASSWORD_ONLY: "1" } });
    const alice = await s.makeUser("alice", "administrator");

    browser = await chromium.launch({ args: ["--host-resolver-rules=MAP *.localhost 127.0.0.1"] });
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, extraHTTPHeaders: { "X-Forwarded-Proto": "https", "X-Forwarded-For": "10.9.0.1" } });
    const page = await context.newPage();
    await page.addInitScript(() => {
      window.__csp = 0;
      document.addEventListener("securitypolicyviolation", (e) => (window.__csp = (window.__csp || 0) + 1, (window.__cspList = window.__cspList || []).push(e.violatedDirective + " " + e.blockedURI)));
    });
    page.on("pageerror", (e) => problems.push("pageerror " + e.message));
    page.on("console", (m) => {
      if (m.type() !== "error") return;
      const t = m.text();
      if (/status of (428|403|503|404|500)/.test(t)) return; // the deliberate 428/403, and the parts of the page the fake supervisor does not answer
      problems.push("console " + t);
    });
    const shot = async (name) => {
      if (!SHOTS) return;
      fs.mkdirSync(SHOTS, { recursive: true });
      await page.screenshot({ path: path.join(SHOTS, name + ".png") });
    };
    const TWO_FA = /authenticator|Windows Hello|passkey|two-factor/i;

    await page.goto(ORIGIN + "/login");
    check("sign-in page: username and password only", (await page.locator('input[name="token"]').count()) === 0 && !TWO_FA.test(await page.locator("main, body").first().innerText()));
    await shot("pw-login-1440");
    await page.fill('input[name="username"]', "alice");
    await page.fill('input[name="password"]', alice.pw);
    await Promise.all([page.waitForNavigation(), page.click('form[action="/login"] button[type="submit"]')]);
    check("the password alone signs in", !/\/login/.test(new URL(page.url()).pathname), page.url());

    await page.route("**/joya-ai/api/overview", async (route) => {
      const resp = await route.fetch();
      let j = {};
      try {
        j = await resp.json();
      } catch (_) {
        j = {};
      }
      j.status = Object.assign({ name: "JOYA AI", seq: 1, process: { state: "ready" } }, j.status || {}, { approvals: [APPROVAL(31)] });
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(j) });
    });
    await page.goto(ORIGIN + "/joya-ai");
    await page.waitForSelector("#cc-needpill:not([hidden]), #cc-need:not([hidden]) [data-need-act]", { timeout: 15000 });
    await sleep(500);
    if (await page.locator("#cc-needpill").isVisible()) await page.click("#cc-needpill");
    await page.waitForSelector("#cc-need:not([hidden]) [data-need-act]");
    const hint = await page.locator("#cc-need .hello").textContent();
    check("the decision card says approving asks for the password", /password/.test(hint) && !TWO_FA.test(hint), hint);

    await page.click('#cc-need [data-need-act="0"]');
    await page.waitForSelector(".joya-su-code:not([hidden]) input[type=password]", { timeout: 8000 });
    const dlgText = await page.locator(".joya-su").innerText();
    check("Approve -> the dialog asks for the password, nothing else", /password/i.test(dlgText) && !TWO_FA.test(dlgText) && !(await page.locator(".joya-su .cc-btn.link").isVisible()), dlgText);
    check("  nothing approved yet", seen.filter((m) => m.op === "approve").length === 0);
    await shot("pw-stepup-1440");

    await page.fill(".joya-su-code input", "not my password");
    await page.click(".joya-su-code button[type=submit]");
    await page.waitForFunction(() => { const e = document.querySelector(".joya-su .err"); return e && !e.hidden && /not right/.test(e.textContent); }, null, { timeout: 5000 });
    check("a wrong password: refused, the dialog stays open and says why", (await page.locator(".joya-su").count()) === 1 && seen.filter((m) => m.op === "approve").length === 0);

    await page.fill(".joya-su-code input", alice.pw);
    await page.click(".joya-su-code button[type=submit]");
    for (let i = 0; i < 40 && !seen.some((m) => m.op === "approve"); i++) await sleep(150);
    const ap = seen.filter((m) => m.op === "approve");
    check("the right password approves #31 with verified=password", ap.length === 1 && ap[0].approval_id === 31 && ap[0].verified === "password", JSON.stringify(ap));
    await sleep(400);
    check("  and the dialog closes", (await page.locator(".joya-su").count()) === 0);

    await page.goto(ORIGIN + "/account");
    check("account page: no authenticator or passkeys", !TWO_FA.test(await page.locator("main").innerText()));
    const r = await page.goto(ORIGIN + "/account/authenticator");
    check("  /account/authenticator does not exist", r.status() === 404, r.status());

    const csp = await page.evaluate(() => [window.__csp || 0, (window.__cspList || []).join(" | ")]);
    check("zero CSP violations", csp[0] === 0, csp[1]);
    check("zero page errors / console errors", problems.length === 0, problems.join(" | "));
  } catch (e) {
    failures++;
    console.log("FAIL threw: " + (e && e.stack));
  } finally {
    if (browser) await browser.close();
    if (s) s.stop();
    server.close();
    try {
      fs.unlinkSync(SOCK);
    } catch (_) {
      /* gone */
    }
  }
  console.log(`\n${passes} passed, ${failures} failed`);
  process.exit(failures ? 1 : 0);
})();
