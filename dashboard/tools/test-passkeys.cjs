#!/usr/bin/env node
"use strict";
/**
 * Passkeys (Windows Hello) as the sign-in's second step, end to end.
 *
 *     NODE_PATH=/opt/joya-dashboard/node_modules PLAYWRIGHT=/path/to/node_modules/playwright \
 *       node dashboard/tools/test-passkeys.cjs
 *
 * Boots a scratch copy (tools/scratch-server.cjs: the helper is blocked, the
 * data dir is a temp dir) and drives it with headless Chromium and its
 * WebAuthn virtual authenticator (CDP), which stands in for Windows Hello: a
 * platform ("internal") authenticator with user verification and resident keys.
 *
 * The panel's real addresses are replaced by three names under .localhost,
 * which Chromium resolves to loopback and treats as secure contexts:
 * a.localhost and b.localhost are on the allow-list (JOYA_PASSKEY_ORIGINS),
 * c.localhost is not. nginx's X-Forwarded-Proto is supplied by the test so the
 * session cookie is set, and each phase uses its own X-Forwarded-For so the
 * sign-in rate limit (10 per 15 min per address) counts phases separately.
 *
 * Covers: a user without a passkey sees the old one-step form; register;
 * sign in with the passkey; fall back to the code; wrong host / RP mismatch
 * refused; a replayed or doubly-spent challenge refused; a sign-counter
 * regression refused; rename and removal; an admin's 2FA reset clears
 * passkeys; a wrong password gets the same second step and "Invalid
 * credentials"; the audit log; zero CSP violations and page errors.
 */
const scratch = require("./scratch-server.cjs"); // first: sets JOYA_DATA_DIR
const path = require("path");

const PW = process.env.PLAYWRIGHT || "playwright";
let chromium;
try {
  ({ chromium } = require(PW));
} catch (e) {
  console.log("FAIL playwright not found (set PLAYWRIGHT=/path/to/node_modules/playwright): " + e.message);
  process.exit(1);
}
const { authenticator } = require("otplib");

const PORT = 3700 + Math.floor(Math.random() * 250);
const A = `http://a.localhost:${PORT}`;
const B = `http://b.localhost:${PORT}`;
const C = `http://c.localhost:${PORT}`;
const REAUTH_MS = 8000;

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

/* A TOTP step is spent by every accepted code, so a second code for the same
 * user must come from a later step. */
const lastStep = {};
async function code(user, secret) {
  const step = () => Math.floor(Date.now() / 30000);
  while (lastStep[user] === step()) await sleep(500);
  lastStep[user] = step();
  return authenticator.generate(secret);
}

(async () => {
  const s = await scratch.startScratch({
    port: PORT,
    env: { JOYA_PASSKEY_ORIGINS: `${A},${B}`, JOYA_PASSKEY_REAUTH_MS: String(REAUTH_MS) },
  });
  const db = require(path.join(__dirname, "..", "lib", "db.js"));
  const sqlite = require("better-sqlite3");
  const raw = new sqlite(path.join(s.data, "joya.db"), { readonly: true });
  const pkRows = (u) => raw.prepare("SELECT p.* FROM passkeys p JOIN users u ON u.id = p.user_id WHERE u.username = ?").all(u);
  const logRows = (u) => raw.prepare("SELECT * FROM login_log WHERE username = ? ORDER BY id").all(u);

  const browser = await chromium.launch({ args: ["--host-resolver-rules=MAP *.localhost 127.0.0.1"] });
  const problems = []; // CSP violations, page errors, console errors that are not a deliberate 4xx

  async function newPage(ip) {
    const context = await browser.newContext({ extraHTTPHeaders: { "X-Forwarded-Proto": "https", "X-Forwarded-For": ip } });
    const page = await context.newPage();
    page.on("pageerror", (e) => problems.push("pageerror " + e.message));
    page.on("console", (m) => {
      if (m.type() !== "error") return;
      // Only the pages this feature draws: the landing pages behind them talk to a
      // supervisor the scratch copy does not have, and say so (503).
      if (!/^\/(login|account|users)/.test(new URL(page.url()).pathname)) return;
      const t = m.text();
      const where = (m.location() && m.location().url) || "";
      if (/Failed to load resource: the server responded with a status of (401|403|409|400)/.test(t)) return; // deliberate refusals
      if (/net::ERR_FAILED/.test(t) && /\/login\/passkey/.test(where)) return; // routes this test aborts on purpose
      if (/status of 503/.test(t) && /\/joya-ai\/api\//.test(where)) return; // the dock asks a supervisor the scratch copy lacks
      problems.push("console " + t + " @ " + where);
    });
    const cdp = await context.newCDPSession(page);
    await cdp.send("WebAuthn.enable");
    const { authenticatorId } = await cdp.send("WebAuthn.addVirtualAuthenticator", {
      options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true },
    });
    return { context, page, cdp, authenticatorId };
  }
  const cspCount = async (page) => page.evaluate(() => window.__csp || 0);
  const watchCsp = (page) =>
    page.addInitScript(() => {
      window.__csp = 0;
      document.addEventListener("securitypolicyviolation", () => (window.__csp = (window.__csp || 0) + 1));
    });

  async function passwordStep(page, origin, user, pw, mode) {
    await page.goto(origin + "/login");
    if (mode === "passkey" && !(await page.locator('input[name="second"]').inputValue())) await page.click('[data-pk-mode="passkey"]');
    await page.fill('input[name="username"]', user);
    await page.fill('input[name="password"]', pw);
    await Promise.all([page.waitForNavigation(), page.click('form[action="/login"] button[type="submit"]')]);
  }
  const signedIn = (page) => !/\/login/.test(new URL(page.url()).pathname);

  async function logout(page) {
    const csrf = await page.evaluate(() => {
      const i = document.querySelector('form[action="/logout"] input[name="_csrf"]');
      return i ? i.value : null;
    });
    if (csrf) await page.request.post(new URL(page.url()).origin + "/logout", { form: { _csrf: csrf }, maxRedirects: 0 }).catch(() => {});
    await page.context().clearCookies();
  }

  try {
    /* ------------------------------------------- the allow-list itself --- */
    console.log("relying-party allow-list (lib/passkeys.js)");
    {
      const pk = require(path.join(__dirname, "..", "lib", "passkeys.js"));
      const R = (host, extra) => ({ headers: Object.assign({ host }, extra || {}) });
      pk.configure("");
      check("defaults: joya.example.com and the old :8443 address", pk.allowedHosts().join(" ") === "joya.example.com joya.example.com");
      check("joya.example.com -> its https origin", JSON.stringify(pk.rpFor(R("joya.example.com"))) === JSON.stringify({ rpID: "joya.example.com", origin: "https://joya.example.com" }));
      check("the old address keeps its port in the origin", pk.rpFor(R("joya.example.com")).origin === "https://joya.example.com:8443");
      check("Host is matched without case or port", !!pk.rpFor(R("OS.Joya-Stack.com:443")));
      check("a host off the list gets nothing", pk.rpFor(R("evil.example")) === null && pk.rpFor(R("example.com")) === null && pk.rpFor(R("")) === null);
      check("X-Forwarded-Host is ignored", pk.rpFor(R("evil.example", { "x-forwarded-host": "joya.example.com" })) === null);
      pk.configure("not a url, ftp://x.example, https://ok.example");
      check("malformed and non-http entries are dropped", pk.allowedHosts().join(" ") === "ok.example");
      check("names are cleaned (control characters, length)", pk.cleanName("  a\u0000b\n c  ") === "a b c" && pk.cleanName("x".repeat(99)).length === pk.NAME_MAX && pk.cleanName("", "Fallback") === "Fallback");
    }

    const alice = await s.makeUser("alice", "administrator");
    const bob = await s.makeUser("bob", "viewer");
    const carol = await s.makeUser("carol", "viewer");
    const dave = await s.makeUser("dave", "administrator");

    /* ---------------------------------------- a user without a passkey --- */
    console.log("\nuser without a passkey: the old form");
    {
      const { page } = await newPage("10.0.0.1");
      await watchCsp(page);
      await page.goto(A + "/login");
      check("the code field shows and is required", (await page.locator('input[name="token"]').isVisible()) && (await page.locator('input[name="token"]').evaluate((e) => e.required)));
      check("the passkey switch is offered on an allowed address", await page.locator('[data-pk-mode="passkey"]').isVisible());
      await page.fill('input[name="username"]', "carol");
      await page.fill('input[name="password"]', carol.pw);
      await page.fill('input[name="token"]', await code("carol", carol.secret));
      await Promise.all([page.waitForNavigation(), page.click('form[action="/login"] button[type="submit"]')]);
      check("username + password + code signs in in one step, as before", signedIn(page), page.url());
      check("no CSP violations on the sign-in page", (await cspCount(page)) === 0);
      await page.goto(A + "/account");
      check("account page: no passkey for this address yet", /No passkey is registered for/.test(await page.content()));
      const c = await s.req("GET", "/login", { headers: { Host: "c.localhost:" + PORT } });
      check("a host off the allow-list gets the old form exactly (no switch, no passkey script)", !/data-passkeys|passkey\.js|second/.test(c.body));
      await page.context().close();
    }

    /* --------------------------------------------------------- register --- */
    console.log("\nregister a passkey (alice, on a.localhost)");
    const al = await newPage("10.0.0.2");
    await watchCsp(al.page);
    {
      const { page } = al;
      await page.goto(A + "/login");
      await page.fill('input[name="username"]', "alice");
      await page.fill('input[name="password"]', alice.pw);
      await page.fill('input[name="token"]', await code("alice", alice.secret));
      await Promise.all([page.waitForNavigation(), page.click('form[action="/login"] button[type="submit"]')]);
      check("alice signs in with the code", signedIn(page));
      await page.goto(A + "/account#passkeys");
      check("fresh sign-in: no code asked to add a passkey", (await page.locator("#pk-add").isVisible()) && (await page.locator('#pk-add input[name="code"]').count()) === 0);
      await page.fill('#pk-add input[name="name"]', "Alice laptop");
      await Promise.all([page.waitForNavigation(), page.click("#pk-add button[type=submit]")]);
      const html = await page.content();
      check("the page says it was added", /Passkey &quot;Alice laptop&quot; added|Passkey "Alice laptop" added/.test(html), html.slice(0, 200));
      const rows = pkRows("alice");
      check("one passkey stored, for a.localhost, with a public key", rows.length === 1 && rows[0].rp_id === "a.localhost" && rows[0].public_key.length > 30 && rows[0].name === "Alice laptop", JSON.stringify(rows.map((r) => [r.rp_id, r.name])));
      check("it is listed as this address", /this address/.test(html) && /Alice laptop/.test(html));
      check("registration is in the audit log", logRows("alice").some((r) => r.outcome === "account" && /added passkey "Alice laptop" for a\.localhost/.test(r.detail)));
      const creds = await al.cdp.send("WebAuthn.getCredentials", { authenticatorId: al.authenticatorId });
      check("the authenticator holds one resident credential for a.localhost", creds.credentials.length === 1 && creds.credentials[0].rpId === "a.localhost" && creds.credentials[0].isResidentCredential);
      // Registering the same device twice is refused by the browser (excludeCredentials).
      await page.fill('#pk-add input[name="name"]', "Again");
      await page.click("#pk-add button[type=submit]");
      await page.waitForFunction(() => /already has a passkey/.test(document.querySelector(".pk-msg").textContent), null, { timeout: 15000 }).catch(() => {});
      check("adding the same device again is refused (already has a passkey)", /already has a passkey/.test(await page.locator(".pk-msg").textContent()), await page.locator(".pk-msg").textContent());
      check("still one passkey", pkRows("alice").length === 1);
      check("no CSP violations on the account page", (await cspCount(page)) === 0);
      await logout(page);
    }

    /* ----------------------------------------------- sign in with it --- */
    console.log("\nsign in with the passkey");
    {
      const { page } = al;
      await page.goto(A + "/login");
      check("this browser starts in passkey mode (code field hidden)", (await page.locator('input[name="second"]').inputValue()) === "passkey" && !(await page.locator('input[name="token"]').isVisible()));
      await page.fill('input[name="username"]', "alice");
      await page.fill('input[name="password"]', alice.pw);
      await Promise.all([page.waitForURL((u) => !/\/login/.test(u.pathname), { timeout: 20000 }).catch(() => {}), page.click('form[action="/login"] button[type="submit"]')]);
      check("password, then Windows Hello (virtual) signs in with no code", signedIn(page), page.url());
      const row = pkRows("alice")[0];
      check("last used and the sign counter are recorded", !!row.last_used_at && row.counter >= 1, JSON.stringify([row.last_used_at, row.counter]));
      check("the sign-in is logged as a passkey sign-in", logRows("alice").some((r) => r.outcome === "success" && /passkey "Alice laptop" \(a\.localhost\)/.test(r.detail || "")));
      await logout(page);
    }

    /* ------------------------------------------------ fall back to code --- */
    console.log("\nfallback to the authenticator code");
    {
      const { page, cdp, authenticatorId } = al;
      // Windows Hello declines (no user verification): the code is one click away.
      await cdp.send("WebAuthn.setUserVerified", { authenticatorId, isUserVerified: false });
      await passwordStep(page, A, "alice", alice.pw, "passkey");
      check("the second step is /login/verify", /\/login\/verify$/.test(page.url()));
      await page.waitForSelector(".lg-err:not([hidden])", { timeout: 20000 }).catch(() => {});
      check("a declined Windows Hello says so and stays on the step", /cancelled or timed out|Invalid credentials/.test(await page.locator(".lg-err").textContent()) && /\/login\/verify/.test(page.url()));
      await page.click("#lg-code-show");
      check("'Use authenticator code instead' shows the code form", await page.locator('.lg-code-form input[name="token"]').isVisible());
      await page.fill('.lg-code-form input[name="token"]', await code("alice", alice.secret));
      await Promise.all([page.waitForNavigation(), page.click(".lg-code-form button[type=submit]")]);
      check("the code finishes the same sign-in", signedIn(page), page.url());
      await cdp.send("WebAuthn.setUserVerified", { authenticatorId, isUserVerified: true });
      await logout(page);

      // The switch on step one goes back to the one-step form too.
      await page.goto(A + "/login");
      await page.click('[data-pk-mode="code"]');
      check("step one: 'Use authenticator code instead' brings the code field back, required", (await page.locator('input[name="token"]').isVisible()) && (await page.locator('input[name="second"]').inputValue()) === "");
    }

    /* ---------------------------------- wrong host / RP mismatch --------- */
    console.log("\nwrong host and RP mismatch");
    {
      const { page } = al;
      // b.localhost is allowed, but alice's passkey belongs to a.localhost.
      await passwordStep(page, B, "alice", alice.pw, "passkey");
      await page.waitForSelector(".lg-err:not([hidden])", { timeout: 20000 }).catch(() => {});
      check("on b.localhost the a.localhost passkey is not offered: no sign-in", /\/login\/verify/.test(page.url()) && (await page.locator(".lg-err").isVisible()));
      // A host off the allow-list: passkey mode is refused as a missing code.
      const g = await s.req("GET", "/login", { headers: { Host: "c.localhost:" + PORT, "X-Forwarded-For": "10.0.0.9" } });
      const ck = (g.headers["set-cookie"] || []).map((c) => c.split(";")[0]).join("; ");
      const post = await s.req("POST", "/login", {
        cookie: ck,
        headers: { Host: "c.localhost:" + PORT, "X-Forwarded-For": "10.0.0.9" },
        body: new URLSearchParams({ _csrf: s.csrfOf(g.body), username: "alice", password: alice.pw, token: "", second: "passkey" }).toString(),
      });
      check("c.localhost: second=passkey without a code is refused (401), no second step", post.status === 401);
      const opt = await s.req("POST", "/login/passkey/options", { cookie: ck, headers: { Host: "c.localhost:" + PORT, "X-Forwarded-For": "10.0.0.9" }, body: { _csrf: s.csrfOf(g.body) } });
      check("c.localhost: no passkey options are issued", opt.status === 409 || opt.status === 400, opt.status);

      // An assertion made for a.localhost, presented on b.localhost: refused.
      await page.context().clearCookies();
      let captured = null;
      await page.route("**/login/passkey", async (route) => {
        captured = route.request().postDataJSON();
        await route.abort();
      });
      await passwordStep(page, A, "alice", alice.pw, "passkey");
      for (let i = 0; i < 40 && !captured; i++) await sleep(250);
      await page.unroute("**/login/passkey");
      check("captured a real assertion for a.localhost", !!(captured && captured.response && captured.response.id));
      // Fresh pending sign-in on b, with its own challenge, then a's assertion.
      const ctxB = await browser.newContext({ extraHTTPHeaders: { "X-Forwarded-Proto": "https", "X-Forwarded-For": "10.0.0.3" } });
      const pb = await ctxB.newPage();
      await pb.goto(B + "/login");
      await pb.evaluate(() => {
        const f = document.getElementById("login-form");
        f.querySelector('input[name="second"]').value = "passkey";
        f.querySelector('input[name="token"]').required = false;
      });
      await pb.route("**/login/passkey/options", (r) => r.continue()); // options are fine; the page's own get() has no credential here
      await pb.fill('input[name="username"]', "alice");
      await pb.fill('input[name="password"]', alice.pw);
      await Promise.all([pb.waitForNavigation(), pb.click('form[action="/login"] button[type="submit"]')]);
      const csrfB = await pb.locator("#lg-pk").getAttribute("data-csrf");
      await pb.waitForSelector(".lg-err:not([hidden])", { timeout: 20000 }).catch(() => {});
      const ob = await pb.request.post(B + "/login/passkey/options", { data: { _csrf: csrfB } });
      check("b.localhost issues options for its own RP", ob.ok() && (await ob.json()).options.rpId === "b.localhost");
      const rb = await pb.request.post(B + "/login/passkey", { data: { _csrf: csrfB, response: captured.response } });
      check("a.localhost's assertion on b.localhost is refused", rb.status() === 401 && (await rb.json()).error === "Invalid credentials.");
      check("the refusal is logged without secrets", logRows("alice").some((r) => r.outcome === "fail" && /^bad passkey: /.test(r.detail || "") && !/challenge":|signature/.test(r.detail)));
      await ctxB.close();

      /* --------------------------------------------- replayed challenge --- */
      console.log("\nreplay and double spend");
      // The captured assertion belongs to a pending sign-in whose challenge was
      // never spent. Present it twice at once: exactly one may succeed.
      const csrfA = await page.locator("#lg-pk").getAttribute("data-csrf");
      const [r1, r2] = await Promise.all([
        page.request.post(A + "/login/passkey", { data: { _csrf: csrfA, response: captured.response } }),
        page.request.post(A + "/login/passkey", { data: { _csrf: csrfA, response: captured.response } }),
      ]);
      const oks = [r1, r2].filter((r) => r.status() === 200).length;
      check("the same challenge answered twice at once: one sign-in, one refusal", oks === 1, [r1.status(), r2.status()].join(","));
      await page.goto(A + "/account");
      check("that sign-in is a real session", signedIn(page));
      await logout(page);
      // A new pending sign-in has a new challenge: the old assertion is refused.
      let fresh = null;
      await page.route("**/login/passkey", async (route) => {
        fresh = true;
        await route.abort();
      });
      await passwordStep(page, A, "alice", alice.pw, "passkey");
      for (let i = 0; i < 40 && !fresh; i++) await sleep(250);
      await page.unroute("**/login/passkey");
      const csrfA2 = await page.locator("#lg-pk").getAttribute("data-csrf");
      const rr = await page.request.post(A + "/login/passkey", { data: { _csrf: csrfA2, response: captured.response } });
      check("an old assertion replayed against a new challenge is refused", rr.status() === 401);
      const rr2 = await page.request.post(A + "/login/passkey", { data: { _csrf: csrfA2, response: captured.response } });
      check("and with the challenge spent, a second try has nothing to answer", rr2.status() === 401);
      await page.context().clearCookies();
    }

    /* ---------------------------------------------- counter regression --- */
    console.log("\nsign counter regression");
    {
      const { page, cdp, authenticatorId } = al;
      const before = pkRows("alice")[0].counter;
      const { credentials } = await cdp.send("WebAuthn.getCredentials", { authenticatorId });
      const cred = credentials[0];
      // A clone: same key, counter rewound to zero.
      await cdp.send("WebAuthn.removeCredential", { authenticatorId, credentialId: cred.credentialId });
      await cdp.send("WebAuthn.addCredential", { authenticatorId, credential: Object.assign({}, cred, { signCount: 0 }) });
      await passwordStep(page, A, "alice", alice.pw, "passkey");
      await page.waitForSelector(".lg-err:not([hidden])", { timeout: 20000 }).catch(() => {});
      check("a counter that went backwards is refused", /\/login\/verify/.test(page.url()) && (await page.locator(".lg-err").isVisible()));
      check("logged as a possible clone", logRows("alice").some((r) => /sign counter|counter value/.test(r.detail || "")));
      check("the stored counter did not move", pkRows("alice")[0].counter === before);
      await cdp.send("WebAuthn.removeCredential", { authenticatorId, credentialId: cred.credentialId });
      await cdp.send("WebAuthn.addCredential", { authenticatorId, credential: Object.assign({}, cred, { signCount: before + 10 }) });
      await page.goto(A + "/login");
      await page.fill('input[name="username"]', "alice");
      await page.fill('input[name="password"]', alice.pw);
      await Promise.all([page.waitForURL((u) => !/\/login/.test(u.pathname), { timeout: 20000 }).catch(() => {}), page.click('form[action="/login"] button[type="submit"]')]);
      check("the real authenticator (counter ahead) still signs in", signedIn(page), page.url());
    }

    /* ------------------------------------------------- rename / remove --- */
    console.log("\nrename and remove");
    {
      const { page } = al;
      await page.goto(A + "/account#passkeys");
      await page.fill(".pk-rename input[name=name]", "Work laptop");
      await Promise.all([page.waitForNavigation(), page.click(".pk-rename button[type=submit]")]);
      check("renamed", pkRows("alice")[0].name === "Work laptop" && /Renamed to/.test(await page.content()));
      await page.click(".pk-table button.danger");
      await page.waitForSelector(".cc-sdlg", { timeout: 5000 });
      check("removal asks first", /Remove the passkey/.test(await page.locator(".cc-sdlg").textContent()));
      await Promise.all([page.waitForNavigation(), page.click('.cc-sdlg [data-a="yes"]')]);
      check("removed", pkRows("alice").length === 0 && /removed/.test(await page.content()));
      check("removal is in the audit log", logRows("alice").some((r) => r.outcome === "account" && /removed passkey "Work laptop" \(a\.localhost\)/.test(r.detail)));
      await logout(page);
      // With it gone, the passkey step cannot sign in, and the code still does.
      await passwordStep(page, A, "alice", alice.pw, "passkey");
      await page.waitForSelector(".lg-err:not([hidden])", { timeout: 20000 }).catch(() => {});
      check("a removed passkey no longer signs in", /\/login\/verify/.test(page.url()));
      await page.context().clearCookies();
    }

    /* -------------------------------------------- re-auth before adding --- */
    console.log("\nre-authentication before adding a passkey");
    const dv = await newPage("10.0.0.4");
    {
      const { page } = dv;
      await page.goto(A + "/login");
      await page.click('[data-pk-mode="code"]').catch(() => {});
      await page.fill('input[name="username"]', "dave");
      await page.fill('input[name="password"]', dave.pw);
      await page.fill('input[name="token"]', await code("dave", dave.secret));
      await Promise.all([page.waitForNavigation(), page.click('form[action="/login"] button[type="submit"]')]);
      await sleep(REAUTH_MS + 500);
      await page.goto(A + "/account#passkeys");
      check("after the fresh-sign-in window a code is asked", (await page.locator('#pk-add input[name="code"]').count()) === 1);
      const csrf = await page.locator("#pk-add").getAttribute("data-csrf");
      const none = await page.request.post(A + "/account/passkeys/options", { data: { _csrf: csrf, code: "" } });
      check("options without a code are refused", none.status() === 403);
      const bad = await page.request.post(A + "/account/passkeys/options", { data: { _csrf: csrf, code: "000000" } });
      check("options with a wrong code are refused", bad.status() === 403);
      await page.fill('#pk-add input[name="name"]', "Dave desk");
      await page.fill('#pk-add input[name="code"]', await code("dave", dave.secret));
      await Promise.all([page.waitForNavigation({ timeout: 20000 }), page.click("#pk-add button[type=submit]")]);
      check("with a current code the passkey is added", pkRows("dave").length === 1);
      const fake = await page.request.post(A + "/account/passkeys", { data: { _csrf: csrf, name: "x", response: { id: "AAAA", rawId: "AAAA", type: "public-key", response: {} } } });
      check("a registration without an issued challenge is refused", fake.status() === 400);
      await logout(page);
    }

    /* ----------------------------------------- admin reset clears them --- */
    console.log("\nadmin 2FA reset clears passkeys");
    {
      const bb = await newPage("10.0.0.5");
      await bb.page.goto(A + "/login");
      await bb.page.click('[data-pk-mode="code"]').catch(() => {});
      await bb.page.fill('input[name="username"]', "bob");
      await bb.page.fill('input[name="password"]', bob.pw);
      await bb.page.fill('input[name="token"]', await code("bob", bob.secret));
      await Promise.all([bb.page.waitForNavigation(), bb.page.click('form[action="/login"] button[type="submit"]')]);
      await bb.page.goto(A + "/account#passkeys");
      await bb.page.fill('#pk-add input[name="name"]', "Bob PC");
      await Promise.all([bb.page.waitForNavigation({ timeout: 20000 }), bb.page.click("#pk-add button[type=submit]")]);
      check("bob (viewer) registers a passkey", pkRows("bob").length === 1);
      await logout(bb.page);

      const admin = await s.signIn("dave").catch(async () => {
        await sleep(31000);
        return s.signIn("dave");
      });
      const bobId = db.getUserByName("bob").id;
      const detail = await s.req("GET", "/users/" + bobId, { cookie: admin.cookie, headers: { Host: "a.localhost:" + PORT } });
      check("the user page shows bob's passkeys and warns the reset removes them", /1 registered/.test(detail.body) && /removes their passkeys/.test(detail.body));
      const reset = await s.req("POST", "/users/" + bobId + "/totp", {
        cookie: admin.cookie,
        headers: { Host: "a.localhost:" + PORT },
        body: new URLSearchParams({ _csrf: s.csrfOf(detail.body) }).toString(),
      });
      check("the reset page says the passkey was removed", reset.status === 200 && /1 passkey was removed/.test(reset.body));
      check("bob has no passkeys left", pkRows("bob").length === 0);
      check("the reset is logged with the count", logRows("dave").some((r) => r.outcome === "admin" && /reset 2FA for bob and removed 1 passkey/.test(r.detail)));
      // bob's browser still holds the key; it no longer signs him in.
      await passwordStep(bb.page, A, "bob", bob.pw, "passkey");
      await bb.page.waitForSelector(".lg-err:not([hidden])", { timeout: 20000 }).catch(() => {});
      check("bob's old Windows Hello key no longer signs in", /\/login\/verify/.test(bb.page.url()));
      await bb.context.close();
    }

    /* ---------------------------------- wrong password: same second step --- */
    console.log("\nwrong password and unknown user look the same");
    {
      // dave's browser holds a real passkey for him: Windows Hello succeeds, the password did not.
      const { page } = dv;
      await page.setExtraHTTPHeaders({ "X-Forwarded-Proto": "https", "X-Forwarded-For": "10.0.0.6" });
      await passwordStep(page, A, "dave", "not-the-password", "passkey");
      check("a wrong password still reaches the second step", /\/login\/verify$/.test(page.url()));
      await page.waitForSelector(".lg-err:not([hidden])", { timeout: 20000 }).catch(() => {});
      check("Windows Hello then ends in 'Invalid credentials.'", /Invalid credentials/.test(await page.locator(".lg-err").textContent()));
      check("a wrong password is in the log as a bad password", logRows("dave").some((r) => r.outcome === "fail" && r.detail === "bad password"));
      // The code fallback after a wrong password: back to the start, same message.
      await page.click("#lg-code-show");
      await page.fill('.lg-code-form input[name="token"]', authenticator.generate(dave.secret));
      await Promise.all([page.waitForNavigation(), page.click(".lg-code-form button[type=submit]")]);
      check("a right code after a wrong password does not sign in ('Invalid credentials.')", /\/login\?again=1$/.test(page.url()) && /Invalid credentials/.test(await page.content()));
      const optsFor = async (u, pw) => {
        await page.route("**/login/passkey/options", (r) => r.abort());
        await passwordStep(page, A, u, pw, "passkey");
        await page.unroute("**/login/passkey/options");
        const csrf = await page.locator("#lg-pk").getAttribute("data-csrf");
        const o = await (await page.request.post(A + "/login/passkey/options", { data: { _csrf: csrf } })).json();
        const html = (await page.content()).replace(/value="[0-9a-f]{48}"|data-csrf="[0-9a-f]{48}"/g, "").replace(/<strong class="mono">[^<]*<\/strong>/, "");
        return { keys: Object.keys(o.options).sort().join(","), allow: (o.options.allowCredentials || []).length, html };
      };
      const right = await optsFor("dave", dave.pw);
      const wrong = await optsFor("dave", "nope-nope-nope");
      const ghost = await optsFor("nobody-here", "whatever");
      check("options look the same for right password, wrong password, unknown user", right.keys === wrong.keys && wrong.keys === ghost.keys && right.allow === 0 && wrong.allow === 0 && ghost.allow === 0);
      check("and so does the page", right.html.length === wrong.html.length && wrong.html.length === ghost.html.length);
      await page.context().close();
      check("dave's passkey was never used by those attempts", !pkRows("dave")[0].last_used_at);
    }

    /* -------------------------------------------- attempts are capped --- */
    console.log("\nattempt cap");
    {
      const { page } = await newPage("10.0.0.7");
      await page.route("**/login/passkey/options", (r) => r.abort());
      await passwordStep(page, A, "dave", dave.pw, "passkey");
      const csrf = await page.locator("#lg-pk").getAttribute("data-csrf");
      let last = null;
      for (let i = 0; i < 5; i++) {
        await page.request.post(A + "/login/passkey/options", { data: { _csrf: csrf } });
        last = await page.request.post(A + "/login/passkey", { data: { _csrf: csrf, response: { id: "AAAA", rawId: "AAAA", type: "public-key", response: {} } } });
      }
      const j = await last.json();
      check("after five failures the sign-in must start again", last.status() === 401 && j.restart === true);
      const after = await page.request.post(A + "/login/passkey/options", { data: { _csrf: csrf } });
      check("and no more challenges are issued for it", after.status() === 409);
      check("the passkey endpoints are rate-limited", !!(last.headers()["ratelimit-limit"] || last.headers()["ratelimit"] || last.headers()["ratelimit-policy"]));
      await page.context().close();
    }

    check("no CSP violations, page errors or unexpected console errors", problems.length === 0, problems.join(" | "));
  } catch (e) {
    failures++;
    console.log("FAIL crashed: " + (e && e.stack));
  } finally {
    await browser.close().catch(() => {});
    raw.close();
    if (failures) console.log(s.out().slice(-1500));
    s.stop();
  }
  console.log(failures ? `\nFAILURES: ${failures} (${passes} passed)` : `\nALL PASSKEY TESTS PASSED (${passes} checks)`);
  process.exit(failures ? 1 : 0);
})();
