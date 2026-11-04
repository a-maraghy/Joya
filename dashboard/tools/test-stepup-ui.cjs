#!/usr/bin/env node
"use strict";
/**
 * Windows Hello for approvals, in a real browser: the Command Center's
 * decision card -> Approve -> the "Confirm it is you" dialog -> Windows Hello
 * (Chromium's WebAuthn virtual authenticator, a platform authenticator with
 * user verification, holding the account's passkey) -> approved; then the
 * authenticator-code fallback when Hello cannot answer. Screenshots of the
 * dialog at 1440 and 390, light and dark; zero CSP violations and page errors.
 *
 *     NODE_PATH=/opt/joya-dashboard/node_modules PLAYWRIGHT=/path/to/node_modules/playwright \
 *       node dashboard/tools/test-stepup-ui.cjs [--shots DIR]
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
const { authenticator } = require("otplib");

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

const SOCK = path.join(scratch.DATA, "fake-joya-ai-ui.sock");
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
  const PORT = 3590 + Math.floor(Math.random() * 60);
  const ORIGIN = `http://a.localhost:${PORT}`;
  let s, browser;
  const problems = [];
  try {
    s = await scratch.startScratch({ port: PORT, env: { JOYA_AI_SOCKET: SOCK, JOYA_PASSKEY_ORIGINS: ORIGIN } });
    const sqlite = require("better-sqlite3");
    const db = new sqlite(path.join(s.data, "joya.db"));
    const alice = await s.makeUser("alice", "administrator");
    const aliceId = db.prepare("SELECT id FROM users WHERE username = 'alice'").get().id;

    // The passkey: one key pair, its public half in the panel's database, its private half in the virtual authenticator.
    const { privateKey, publicKey } = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
    const jwk = publicKey.export({ format: "jwk" });
    const cose = Buffer.concat([Buffer.from([0xa5, 0x01, 0x02, 0x03, 0x26, 0x20, 0x01, 0x21, 0x58, 0x20]), Buffer.from(jwk.x, "base64url"), Buffer.from([0x22, 0x58, 0x20]), Buffer.from(jwk.y, "base64url")]);
    const credId = crypto.randomBytes(32);
    db.prepare(
      "INSERT INTO passkeys (user_id, credential_id, public_key, counter, transports, rp_id, name, aaguid, device_type, backed_up, created_at) VALUES (?, ?, ?, 0, '[\"internal\"]', 'a.localhost', 'Laptop Windows Hello', '', 'singleDevice', 0, ?)"
    ).run(aliceId, credId.toString("base64url"), cose, created);

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
      if (/status of (428|403|503|404|500)/.test(t)) return; // the deliberate 428, and the parts of the page the fake supervisor does not answer
      problems.push("console " + t);
    });
    const cdp = await context.newCDPSession(page);
    await cdp.send("WebAuthn.enable");
    const { authenticatorId } = await cdp.send("WebAuthn.addVirtualAuthenticator", {
      options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true },
    });
    await cdp.send("WebAuthn.addCredential", {
      authenticatorId,
      credential: { credentialId: credId.toString("base64"), isResidentCredential: false, rpId: "a.localhost", privateKey: privateKey.export({ type: "pkcs8", format: "der" }).toString("base64"), signCount: 0 },
    });

    // Sign in (password + code).
    await page.goto(ORIGIN + "/login");
    await page.fill('input[name="username"]', "alice");
    await page.fill('input[name="password"]', alice.pw);
    await page.fill('input[name="token"]', authenticator.generate(alice.secret));
    await Promise.all([page.waitForNavigation(), page.click('form[action="/login"] button[type="submit"]')]);
    const signStep = Math.floor(Date.now() / 30000);

    // Two approvals wait: JOYA AI's own and a hired session's (origin session:<slug>).
    await page.route("**/joya-ai/api/overview", async (route) => {
      const resp = await route.fetch();
      let j = {};
      try {
        j = await resp.json();
      } catch (_) {
        j = {};
      }
      j.status = Object.assign({ name: "JOYA AI", seq: 1, process: { state: "ready" } }, j.status || {}, { approvals: [APPROVAL(31), APPROVAL(32)] });
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(j) });
    });
    await page.goto(ORIGIN + "/joya-ai");
    await page.waitForSelector("#cc-needpill:not([hidden]), #cc-need:not([hidden]) [data-need-act]", { timeout: 15000 });
    await sleep(500);
    if (await page.locator("#cc-needpill").isVisible()) await page.click("#cc-needpill");
    await page.waitForSelector("#cc-need:not([hidden]) [data-need-act]");
    const hint = await page.locator("#cc-need .hello").textContent();
    check("the decision card says Approve asks for Windows Hello, and the code works too", /Windows Hello/.test(hint) && /authenticator code/.test(hint), hint);

    // Approve -> dialog -> Windows Hello answers -> approved.
    await page.click('#cc-need [data-need-act="0"]');
    const dlg = page.locator(".joya-su");
    await dlg.waitFor({ state: "attached", timeout: 5000 }).catch(() => {});
    for (let i = 0; i < 40 && !seen.some((m) => m.op === "approve"); i++) await sleep(150);
    const ap = seen.filter((m) => m.op === "approve");
    check("Approve -> Windows Hello -> the supervisor gets approve #31 with verified=hello", ap.length === 1 && ap[0].approval_id === 31 && ap[0].verified === "hello" && ap[0].verified_with === "Laptop Windows Hello", JSON.stringify(ap));
    check("  the card was held while Hello ran", seen.some((m) => m.op === "approval-hold" && m.approval_id === 31));
    await sleep(400);
    check("  the dialog closed by itself", (await page.locator(".joya-su").count()) === 0);

    // The next card (the hired session's): Hello cannot answer (no passkey on this "device" any more).
    await cdp.send("WebAuthn.clearCredentials", { authenticatorId });
    await page.waitForFunction(() => document.querySelector("#cc-need:not([hidden]) [data-need-act]") && /Worker A|rm -rf/.test(document.querySelector("#cc-need").textContent), null, { timeout: 8000 });
    await page.click('#cc-need [data-need-act="0"]');
    await page.waitForSelector(".joya-su");
    await page.waitForFunction(() => /cancelled or timed out|no passkey/.test((document.querySelector(".joya-su-st") || {}).textContent || ""), null, { timeout: 70000 });
    check("Hello fails: the dialog says so and offers the code", /authenticator code/.test(await page.locator(".joya-su-st").textContent()) && (await page.locator(".joya-su .cc-btn.link").isVisible()));
    check("  nothing was approved", seen.filter((m) => m.op === "approve").length === 1);
    await page.click(".joya-su .cc-btn.link");
    await page.waitForSelector(".joya-su-code:not([hidden]) input");
    check("  the dialog shows how long the card still waits", /The card waits \d+:\d\d more/.test(await page.locator(".joya-su-timer").textContent()));

    const shot = async (name) => {
      if (!SHOTS) return;
      fs.mkdirSync(SHOTS, { recursive: true });
      await page.screenshot({ path: path.join(SHOTS, name + ".png") });
    };
    const box = async () => page.locator(".joya-su").boundingBox();
    let b = await box();
    check("at 1440: the dialog is centred and fully on screen", b && b.x > 0 && b.x + b.width < 1440 && b.y > 0 && b.y + b.height < 900, JSON.stringify(b));
    await shot("stepup-1440-light");
    await page.evaluate(() => document.documentElement.setAttribute("data-theme", "dark"));
    await shot("stepup-1440-dark");
    await page.setViewportSize({ width: 390, height: 844 });
    await sleep(200);
    b = await box();
    check("at 390: the dialog fits the phone width with its gutter", b && b.x >= 8 && b.x + b.width <= 390 - 8, JSON.stringify(b));
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
    check("  no horizontal scroll", !overflow);
    await shot("stepup-390-dark");
    await page.evaluate(() => document.documentElement.setAttribute("data-theme", "light"));
    await shot("stepup-390-light");

    // A wrong code: refused, the dialog stays and says why.
    await page.fill(".joya-su-code input", "000000");
    await page.click(".joya-su-code button[type=submit]");
    await page.waitForFunction(() => { const e = document.querySelector(".joya-su .err"); return e && !e.hidden && /wrong/.test(e.textContent); }, null, { timeout: 5000 });
    check("a wrong code: refused, the dialog stays open and says why", (await page.locator(".joya-su").count()) === 1 && seen.filter((m) => m.op === "approve").length === 1);
    while (Math.floor(Date.now() / 30000) === signStep) await sleep(500);
    await page.fill(".joya-su-code input", authenticator.generate(alice.secret));
    await page.click(".joya-su-code button[type=submit]");
    for (let i = 0; i < 40 && seen.filter((m) => m.op === "approve").length < 2; i++) await sleep(150);
    const ap2 = seen.filter((m) => m.op === "approve")[1];
    check("the right code approves the hired session's card (#32) with verified=totp", ap2 && ap2.approval_id === 32 && ap2.verified === "totp", JSON.stringify(ap2));
    await sleep(400);
    check("  and the dialog closes", (await page.locator(".joya-su").count()) === 0);

    // Deny never asks.
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
