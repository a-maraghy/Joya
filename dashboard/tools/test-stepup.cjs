#!/usr/bin/env node
"use strict";
/**
 * Windows Hello for every approval (lib/stepup.js), enforced by the server.
 *
 *     NODE_PATH=/opt/joya-dashboard/node_modules node dashboard/tools/test-stepup.cjs
 *
 * A scratch copy of the panel (tools/scratch-server.cjs) talks to a fake JOYA
 * AI supervisor on a socket in the scratch dir, which records every op. The
 * passkey is a software authenticator in this file (P-256, user verified),
 * stored straight into the scratch database, so every assertion is real
 * WebAuthn the server checks with @simplewebauthn/server.
 *
 * Covers: no proof -> 428 and nothing reaches the supervisor; Deny never asks;
 * a valid assertion -> applied, with verified=hello in the supervisor op and
 * the panel's audit; replay, another approval id, Approve once used for
 * Always allow, another browser session, a forged signature, a counter that
 * went backwards -> refused; the authenticator code as the fallback (wrong,
 * reused and too many codes refused); an address off the passkey allow-list
 * gets the code only; the card is held while Hello runs; decisions, rules,
 * retire, resume (JSON and the plain forms); the classic chat's Allow is gone; an older
 * supervisor that does not know `verified` still gets the approve.
 */
const scratch = require("./scratch-server.cjs"); // first: sets JOYA_DATA_DIR
const crypto = require("crypto");
const net = require("net");
const path = require("path");
const fs = require("fs");
const { authenticator } = require("otplib");

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
const b64u = (buf) => Buffer.from(buf).toString("base64url");

/* ------------------------------------------------------------ fake supervisor --- */
const SOCK = path.join(scratch.DATA, "fake-joya-ai.sock");
const seen = [];
const S = { strict: true, refuseVerified: false };
const OPS = {
  approve: (p) => ({ approval: { id: p.approval_id, status: "approved", verified: p.verified || null } }),
  deny: (p) => ({ approval: { id: p.approval_id, status: "denied" } }),
  "approval-hold": () => ({ expires_at: new Date(Date.now() + 90000).toISOString(), held: true }),
  "decision-approve": (p) => ({ decision: { id: p.decision_id, status: "running" } }),
  "decision-dismiss": (p) => ({ decision: { id: p.decision_id, status: "dismissed" } }),
  "budget-resume": (p) => ({ resumed: p.key || p.decision_id }),
  "rule-create": (p) => ({ rule: { id: 50, effect: p.effect } }),
  "rule-update": (p) => ({ rule: { id: p.rule_id } }),
  "rule-delete": (p) => ({ deleted: p.rule_id }),
  "session-retire": (p) => ({ retired: { slug: p.slug } }),
  "session-keep": (p) => ({ hired: { slug: p.slug, kept: p.kept } }),
  status: () => ({ name: "JOYA AI", process: { state: "ready" } }),
  sessions: () => ({ sessions: [] }),
  "token-caps": () => ({ sessions: [], default: { cap: null, at: "warn" }, warn_pct: 80 }),
};
const STEPPED = new Set(["approve", "decision-approve", "budget-resume", "rule-create", "rule-update", "rule-delete", "session-retire"]);
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
      // An older supervisor (lib/protocol.js before 2026-10-08) refuses the new fields.
      if (S.refuseVerified && STEPPED.has(m.op) && ("verified" in m || "verified_with" in m)) {
        c.write(JSON.stringify({ id: m.id, ok: false, error: "unexpected field: verified" }) + "\n");
        continue;
      }
      const f = OPS[m.op];
      c.write(JSON.stringify({ id: m.id, ok: true, data: m.op === "events" ? { seq: 1 } : f ? f(m) : {} }) + "\n");
    }
  });
  c.on("error", () => {});
});
const ops = (op) => seen.filter((m) => m.op === op);
const last = (op) => ops(op).pop();

/* ------------------------------------------------------- software authenticator --- */
/** A Windows-Hello-like passkey: P-256, user present + verified, a counting signature counter. */
function makeAuthenticator(rpId) {
  const { privateKey, publicKey } = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
  const jwk = publicKey.export({ format: "jwk" });
  const x = Buffer.from(jwk.x, "base64url");
  const y = Buffer.from(jwk.y, "base64url");
  // COSE_Key {1: 2 (EC2), 3: -7 (ES256), -1: 1 (P-256), -2: x, -3: y}
  const cose = Buffer.concat([Buffer.from([0xa5, 0x01, 0x02, 0x03, 0x26, 0x20, 0x01, 0x21, 0x58, 0x20]), x, Buffer.from([0x22, 0x58, 0x20]), y]);
  const credId = crypto.randomBytes(32);
  let counter = 0;
  return {
    id: b64u(credId),
    cose,
    /** navigator.credentials.get()'s answer, as the page sends it. */
    assert(challenge, origin, o = {}) {
      // A forced counter (a cloned key replaying an old value) does not move this authenticator's own.
      const n = o.counter !== undefined ? o.counter : ++counter;
      const flags = o.flags !== undefined ? o.flags : 0x05; // UP | UV
      const cnt = Buffer.alloc(4);
      cnt.writeUInt32BE(n);
      const authData = Buffer.concat([crypto.createHash("sha256").update(o.rpId || rpId).digest(), Buffer.from([flags]), cnt]);
      const clientData = Buffer.from(JSON.stringify({ type: "webauthn.get", challenge, origin: o.origin || origin, crossOrigin: false }));
      const signed = Buffer.concat([authData, crypto.createHash("sha256").update(clientData).digest()]);
      let sig = crypto.sign("sha256", signed, privateKey);
      if (o.forge) sig = Buffer.from(sig.map((b, i) => (i === sig.length - 3 ? b ^ 0xff : b)));
      return {
        id: b64u(credId),
        rawId: b64u(credId),
        type: "public-key",
        response: { clientDataJSON: b64u(clientData), authenticatorData: b64u(authData), signature: b64u(sig) },
        clientExtensionResults: {},
        authenticatorAttachment: "platform",
      };
    },
  };
}

(async () => {
  await new Promise((r) => server.listen(SOCK, r));
  const PORT = 3400 + Math.floor(Math.random() * 180);
  const A = `a.localhost:${PORT}`;
  const ORIGIN = `http://${A}`;
  const OFF = `c.localhost:${PORT}`;
  let s;
  try {
    s = await scratch.startScratch({ port: PORT, env: { JOYA_AI_SOCKET: SOCK, JOYA_PASSKEY_ORIGINS: ORIGIN } });
    const sqlite = require("better-sqlite3");
    const db = new sqlite(path.join(s.data, "joya.db"));
    const alice = await s.makeUser("alice", "administrator");
    const aliceId = db.prepare("SELECT id FROM users WHERE username = 'alice'").get().id;

    // Codes: each accepted one is burned, so a second one must come from a later step.
    let lastStep = 0;
    async function freshCode() {
      while (Math.floor(Date.now() / 30000) === lastStep) await sleep(500);
      lastStep = Math.floor(Date.now() / 30000);
      return authenticator.generate(alice.secret);
    }

    const auth = makeAuthenticator("a.localhost");
    db.prepare(
      "INSERT INTO passkeys (user_id, credential_id, public_key, counter, transports, rp_id, name, aaguid, device_type, backed_up, created_at) VALUES (?, ?, ?, 0, '[\"internal\"]', 'a.localhost', 'Test Hello', '', 'singleDevice', 0, ?)"
    ).run(aliceId, auth.id, auth.cose, new Date().toISOString());

    const who = await s.signIn("alice");
    lastStep = Math.floor(Date.now() / 30000); // the sign-in spent this step's code
    const H = { Host: A, Accept: "application/json" };
    let r = await s.req("GET", "/joya-ai", { cookie: who.cookie, headers: { Host: A } });
    const csrf = s.csrfOf(r.body);
    check("the Command Center renders and loads step-up.js", r.status === 200 && /\/static\/step-up\.js/.test(r.body) && !!csrf, r.status);
    const post = (p, body, o = {}) => s.req("POST", p, { cookie: o.cookie || who.cookie, headers: Object.assign({}, H, { "X-CSRF-Token": o.csrf || csrf }, o.headers || {}), body: body || {} });
    const J = (x) => {
      try {
        return JSON.parse(x.body);
      } catch (_) {
        return {};
      }
    };
    const logged = (re) => db.prepare("SELECT detail FROM login_log WHERE username = 'alice' ORDER BY id").all().some((x) => re.test(x.detail || ""));

    /* ---------------------------------------------------------------- approvals --- */
    console.log("approvals: Approve once");
    r = await post("/joya-ai/api/approvals/12/approve");
    let j = J(r);
    check("no proof -> 428 step-up", r.status === 428 && j.code === "step-up", r.status + " " + r.body.slice(0, 200));
    check("  nothing reached the supervisor", ops("approve").length === 0);
    check("  the challenge names alice's passkey, user verification required", j.step_up && j.step_up.passkey && j.step_up.passkey.userVerification === "required" && j.step_up.passkey.allowCredentials.some((c) => c.id === auth.id) && j.step_up.passkey.rpId === "a.localhost", JSON.stringify(j.step_up).slice(0, 300));
    check("  the code is offered as the fallback", j.step_up.totp === true && j.step_up.no_passkey === null);
    check("  the card was held while Hello runs (approval-hold 12, 90 s), and the page is told until when", last("approval-hold") && last("approval-hold").approval_id === 12 && last("approval-hold").seconds === 90 && !!j.step_up.expires_at);
    check("  the refusal is in the audit log", logged(/Approve request #12: refused/));

    r = await post("/joya-ai/api/approvals/12/deny");
    check("Deny needs no Windows Hello", r.status === 200 && last("deny") && last("deny").approval_id === 12, r.status + " " + r.body.slice(0, 120));

    const ch1 = j.step_up.token;
    const goodProof = { token: ch1, response: auth.assert(ch1, ORIGIN) };
    r = await post("/joya-ai/api/approvals/12/approve", { step_up: goodProof });
    check("a valid Windows Hello assertion -> approved", r.status === 200 && ops("approve").length === 1, r.status + " " + r.body.slice(0, 200));
    const ap = last("approve");
    check("  the supervisor is told how: verified=hello, with the passkey's name", ap && ap.verified === "hello" && ap.verified_with === "Test Hello" && ap.approval_id === 12 && !("step_up" in ap), JSON.stringify(ap));
    check("  the panel's audit line says Windows Hello", logged(/approved request 12 with Windows Hello \(Test Hello\)/));
    check("  the passkey's counter and last use were updated", db.prepare("SELECT counter, last_used_at FROM passkeys WHERE credential_id = ?").get(auth.id).counter === 1);

    r = await post("/joya-ai/api/approvals/12/approve", { step_up: goodProof });
    j = J(r);
    check("replaying the same assertion -> refused (403), nothing applied", r.status === 403 && j.code === "step-up-failed" && ops("approve").length === 1, r.status + " " + r.body.slice(0, 160));
    check("  the refusal carries a fresh challenge to try again", j.step_up && j.step_up.token && j.step_up.token !== ch1);

    // A challenge for #12 used on #13.
    r = await post("/joya-ai/api/approvals/12/approve");
    let t = J(r).step_up.token;
    r = await post("/joya-ai/api/approvals/13/approve", { step_up: { token: t, response: auth.assert(t, ORIGIN) } });
    check("an assertion for approval 12 does not approve 13", r.status === 403 && ops("approve").length === 1 && /something else/.test(J(r).error), r.status + " " + r.body.slice(0, 160));

    // Approve once's challenge used for Always allow.
    r = await post("/joya-ai/api/approvals/14/approve");
    t = J(r).step_up.token;
    r = await post("/joya-ai/api/approvals/14/approve", { rule: { pattern: "systemctl restart odoo", tool: "Bash" }, step_up: { token: t, response: auth.assert(t, ORIGIN) } });
    check("Approve once's challenge cannot save an Always allow rule", r.status === 403 && ops("approve").length === 1, r.status);
    // Always allow, its own challenge.
    r = await post("/joya-ai/api/approvals/14/approve", { rule: { pattern: "systemctl restart odoo", tool: "Bash" } });
    j = J(r);
    check("Always allow this -> 428 too, with its own challenge", r.status === 428 && /Always allow request #14/.test(j.step_up.what));
    t = j.step_up.token;
    r = await post("/joya-ai/api/approvals/14/approve", { rule: { pattern: "systemctl restart odoo*", tool: "Bash" }, step_up: { token: t, response: auth.assert(t, ORIGIN) } });
    check("  a challenge for one rule pattern cannot save another", r.status === 403 && ops("approve").length === 1, r.status);
    r = await post("/joya-ai/api/approvals/14/approve", { rule: { pattern: "systemctl restart odoo", tool: "Bash" } });
    t = J(r).step_up.token;
    r = await post("/joya-ai/api/approvals/14/approve", { rule: { pattern: "systemctl restart odoo", tool: "Bash" }, step_up: { token: t, response: auth.assert(t, ORIGIN) } });
    check("  the right challenge -> approved with the rule", r.status === 200 && last("approve").rule_pattern === "systemctl restart odoo" && last("approve").verified === "hello", r.status + " " + r.body.slice(0, 160));

    // Forged signature, wrong origin, no user verification, counter going backwards.
    for (const [name, o] of [
      ["a forged signature", { forge: true }],
      ["an assertion made for another origin", { origin: "https://evil.example" }],
      ["an assertion without user verification (presence only)", { flags: 0x01 }],
      ["a signature counter that went backwards (a cloned key)", { counter: 1 }],
    ]) {
      const before = ops("approve").length;
      r = await post("/joya-ai/api/approvals/15/approve");
      t = J(r).step_up.token;
      r = await post("/joya-ai/api/approvals/15/approve", { step_up: { token: t, response: auth.assert(t, ORIGIN, o) } });
      check(name + " -> refused", r.status === 403 && ops("approve").length === before, r.status + " " + r.body.slice(0, 160));
    }

    // Another browser session of the same user cannot spend this session's challenge.
    await freshCode(); // the sign-in needs an unspent step
    const who2 = await s.signIn("alice");
    lastStep = Math.floor(Date.now() / 30000);
    const r2 = await s.req("GET", "/joya-ai", { cookie: who2.cookie, headers: { Host: A } });
    const csrf2 = s.csrfOf(r2.body);
    r = await post("/joya-ai/api/approvals/16/approve");
    t = J(r).step_up.token;
    r = await post("/joya-ai/api/approvals/16/approve", { step_up: { token: t, response: auth.assert(t, ORIGIN) } }, { cookie: who2.cookie, csrf: csrf2 });
    check("a challenge issued to one browser session is refused in another", r.status === 403 && /another browser session/.test(J(r).error), r.status + " " + r.body.slice(0, 160));

    // A step_up that is junk.
    r = await post("/joya-ai/api/approvals/16/approve", { step_up: { token: "x" } });
    check("a malformed proof is no proof (428)", r.status === 428);
    r = await post("/joya-ai/api/approvals/16/approve", { step_up: { token: "nope", response: { id: auth.id } } });
    check("an unknown challenge -> refused", r.status === 403);

    /* ------------------------------------------------------- the code fallback --- */
    console.log("\nthe authenticator code as the fallback");
    let before = ops("approve").length;
    r = await post("/joya-ai/api/approvals/17/approve", { step_up: { totp: await freshCode() } });
    check("a fresh code approves", r.status === 200 && ops("approve").length === before + 1 && last("approve").verified === "totp" && last("approve").approval_id === 17, r.status + " " + r.body.slice(0, 160));
    check("  audited as the authenticator code", logged(/approved request 17 with authenticator code/));
    const used = authenticator.generate(alice.secret);
    r = await post("/joya-ai/api/approvals/18/approve", { step_up: { totp: used } });
    check("the same code again -> refused (codes are burned)", r.status === 403 && ops("approve").length === before + 1, r.status);
    r = await post("/joya-ai/api/approvals/18/approve", { step_up: { totp: "000000" === used ? "111111" : "000000" } });
    j = J(r);
    check("a wrong code -> refused, with a fresh challenge", r.status === 403 && j.code === "step-up-failed" && j.step_up && j.step_up.totp, r.status);
    // (Too many wrong codes: at the end, since it locks the code for ten minutes.)

    console.log("\nan address off the passkey allow-list");
    await freshCode();
    const who3 = await s.signIn("alice");
    lastStep = Math.floor(Date.now() / 30000);
    const r3 = await s.req("GET", "/joya-ai", { cookie: who3.cookie, headers: { Host: OFF } });
    const csrf3 = s.csrfOf(r3.body);
    r = await s.req("POST", "/joya-ai/api/approvals/19/approve", { cookie: who3.cookie, headers: { Host: OFF, Accept: "application/json", "X-CSRF-Token": csrf3 }, body: {} });
    j = J(r);
    check("428 with no passkey challenge and why, the code offered", r.status === 428 && j.step_up.passkey === null && j.step_up.token === null && /cannot use Windows Hello/.test(j.step_up.no_passkey) && j.step_up.totp === true, r.body.slice(0, 200));

    /* ------------------------------------------------------------- decisions --- */
    console.log("\ndecisions, rules, retire, resume");
    r = await post("/joya-ai/api/decisions/7/approve");
    check("Apply fix -> 428", r.status === 428 && ops("decision-approve").length === 0);
    t = J(r).step_up.token;
    r = await post("/joya-ai/api/decisions/7/approve", { step_up: { token: t, response: auth.assert(t, ORIGIN) } });
    check("  with Windows Hello -> decision-approve, verified=hello", r.status === 200 && last("decision-approve").decision_id === 7 && last("decision-approve").verified === "hello", r.status + " " + r.body.slice(0, 160));
    r = await post("/joya-ai/api/decisions/7/dismiss");
    check("Dismiss needs no Windows Hello", r.status === 200 && last("decision-dismiss").decision_id === 7);
    r = await post("/joya-ai/api/decisions/8/resume");
    check("Resume for today -> 428", r.status === 428 && ops("budget-resume").length === 0);
    t = J(r).step_up.token;
    r = await post("/joya-ai/api/decisions/7/resume", { step_up: { token: t, response: auth.assert(t, ORIGIN) } });
    check("  a challenge for decision 8 does not resume decision 7", r.status === 403 && ops("budget-resume").length === 0);

    r = await post("/joya-ai/api/rules", { effect: "deny", tool: "Bash", pattern: "rm -rf /srv/*" });
    check("a new deny rule only tightens: no Windows Hello", r.status === 200 && last("rule-create").effect === "deny", r.status);
    r = await post("/joya-ai/api/rules", { effect: "allow", tool: "Bash", pattern: "systemctl restart odoo" });
    check("a new allow rule -> 428", r.status === 428 && ops("rule-create").length === 1);
    t = J(r).step_up.token;
    r = await post("/joya-ai/api/rules", { effect: "allow", tool: "Bash", pattern: "systemctl restart *", step_up: { token: t, response: auth.assert(t, ORIGIN) } });
    check("  its challenge does not cover a broader pattern", r.status === 403 && ops("rule-create").length === 1);
    r = await post("/joya-ai/api/rules/3", { pattern: "x*" });
    check("changing a rule -> 428", r.status === 428 && ops("rule-update").length === 0);
    r = await post("/joya-ai/api/rules/3/delete", {});
    check("deleting a rule -> 428", r.status === 428 && ops("rule-delete").length === 0);
    t = J(r).step_up.token;
    r = await post("/joya-ai/api/rules/3/delete", { step_up: { token: t, response: auth.assert(t, ORIGIN) } });
    check("  with Windows Hello -> deleted", r.status === 200 && last("rule-delete").rule_id === 3 && last("rule-delete").verified === "hello");

    r = await post("/joya-ai/api/sessions/worker-a/keep", { kept: true });
    check("Keep needs no Windows Hello", r.status === 200 && last("session-keep").slug === "worker-a");
    r = await post("/joya-ai/api/sessions/worker-a/retire", {});
    check("Retire -> 428", r.status === 428 && ops("session-retire").length === 0);
    r = await post("/joya-ai/api/sessions/worker-a/retire", { step_up: { totp: await freshCode() } });
    check("  with the code -> retired, verified=totp", r.status === 200 && last("session-retire").slug === "worker-a" && last("session-retire").verified === "totp", r.status + " " + r.body.slice(0, 120));

    // The plain forms (Sessions ▸ Live, Settings ▸ Usage).
    const formCsrf = csrf;
    const form = (o) => new URLSearchParams(o).toString();
    r = await s.req("POST", "/claude/sessions/live/resume", { cookie: who.cookie, headers: { Host: A }, body: form({ _csrf: formCsrf, key: "planning-audit" }) });
    check("Sessions ▸ Live Resume without JavaScript -> back with an error, nothing resumed", r.status === 303 && /err=.*Windows%20Hello/.test(r.headers.location || "") && ops("budget-resume").length === 0, r.status + " " + r.headers.location);
    r = await s.req("POST", "/claude/sessions/live/resume", { cookie: who.cookie, headers: { Host: A, Accept: "application/json", "X-Requested-With": "fetch" }, body: form({ _csrf: formCsrf, key: "planning-audit" }) });
    check("  from step-up.js (fetch) -> 428 with a challenge", r.status === 428 && J(r).step_up && J(r).step_up.token);
    t = J(r).step_up.token;
    r = await s.req("POST", "/claude/sessions/live/resume", { cookie: who.cookie, headers: { Host: A, Accept: "application/json", "X-Requested-With": "fetch" }, body: form({ _csrf: formCsrf, key: "planning-audit", step_up: JSON.stringify({ token: t, response: auth.assert(t, ORIGIN) }) }) });
    check("  with the proof in the form -> resumed (verified=hello), back to the page", r.status === 303 && last("budget-resume") && last("budget-resume").key === "planning-audit" && last("budget-resume").verified === "hello", r.status + " " + r.headers.location);
    r = await s.req("POST", "/claude/sessions/live/worker-b/retire", { cookie: who.cookie, headers: { Host: A }, body: form({ _csrf: formCsrf }) });
    check("Sessions ▸ Live Retire without proof -> refused", r.status === 303 && /err=/.test(r.headers.location || "") && !ops("session-retire").some((m) => m.slug === "worker-b"));
    r = await s.req("POST", "/joya-ai/settings/usage/resume", { cookie: who.cookie, headers: { Host: A, "X-Requested-With": "fetch", Accept: "application/json" }, body: form({ _csrf: formCsrf, key: "worker-c" }) });
    check("Settings ▸ Usage Resume -> 428", r.status === 428 && !ops("budget-resume").some((m) => m.key === "worker-c"), r.status);
    r = await s.req("POST", "/joya-ai/settings/usage/resume", { cookie: who.cookie, headers: { Host: A, "X-Requested-With": "fetch", Accept: "application/json" }, body: form({ _csrf: formCsrf, key: "worker-c", step_up: JSON.stringify({ totp: await freshCode() }) }) });
    check("  with the code -> resumed", r.status === 200 && last("budget-resume").key === "worker-c" && last("budget-resume").verified === "totp", r.status + " " + r.body.slice(0, 120));

    // The classic chat is retired (2026-10-25): every /console URL goes to the Command Center
    // and its permission handler is removed with the rest of its code.
    r = await s.req("POST", "/console/1/permission", { cookie: who.cookie, headers: { Host: A, Accept: "application/json" }, body: form({ _csrf: formCsrf, request_id: "r1", decision: "allow" }) });
    check("the classic chat's Allow is gone (302 to /joya-ai) and no handler is left behind", r.status === 302 && r.headers.location === "/joya-ai" && !/\/console\/:id\/permission/.test(fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8")), r.status + " " + r.headers.location);

    console.log("\ntoo many wrong codes");
    before = ops("approve").length;
    for (let i = 0; i < 5; i++) await post("/joya-ai/api/approvals/18/approve", { step_up: { totp: "000001" } });
    r = await post("/joya-ai/api/approvals/18/approve", { step_up: { totp: await freshCode() } });
    check("after five wrong codes even a right one is refused for a while (429)", r.status === 429 && J(r).code === "step-up-locked" && ops("approve").length === before, r.status);
    r = await post("/joya-ai/api/approvals/18/approve");
    t = J(r).step_up.token;
    check("  ...and the challenge says the code is locked", J(r).step_up.code_locked === true);
    r = await post("/joya-ai/api/approvals/18/approve", { step_up: { token: t, response: auth.assert(t, ORIGIN) } });
    check("  Windows Hello still works meanwhile", r.status === 200 && last("approve").approval_id === 18, r.status + " " + r.body.slice(0, 160));

    /* ---------------------------------------------------- an older supervisor --- */
    console.log("\nan older supervisor");
    S.refuseVerified = true;
    before = ops("approve").length;
    r = await post("/joya-ai/api/approvals/20/approve");
    t = J(r).step_up.token;
    r = await post("/joya-ai/api/approvals/20/approve", { step_up: { token: t, response: auth.assert(t, ORIGIN) } });
    const tail = ops("approve").slice(before);
    check("one that refuses `verified` still gets the approve (sent again without it)", r.status === 200 && tail.length === 2 && tail[1].verified === undefined && tail[1].approval_id === 20, r.status + " " + JSON.stringify(tail));
    check("  and the panel's audit still says Windows Hello", logged(/approved request 20 with Windows Hello/));
    S.refuseVerified = false;

    /* ----------------------------------------------------------- the page side --- */
    console.log("\nthe page");
    const src = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
    check("every Approve-type route is wrapped", ["approvalStepUp", "decisionStepUp", "ruleStepUp(\"create\")", "ruleStepUp(\"update\")", "ruleStepUp(\"delete\")", "retireStepUp()", "retireStepUp(liveStepRefuse)", "liveResumeStepUp"].every((k) => src.includes(", " + k + ",") || src.includes(" " + k + ", async") || src.includes(", " + k + ", (")));
    check("no setting can turn it off", !/STEPUP_OFF|stepup_disabled|skipStepUp/i.test(src + fs.readFileSync(path.join(__dirname, "..", "lib", "stepup.js"), "utf8")));
    const cc = fs.readFileSync(path.join(__dirname, "..", "public", "joya-ai.js"), "utf8");
    check("the Command Center's api() asks on a 428 and sends again with the proof", /r\.status === 428 && j\.step_up && !opts\.stepped && window\.JoyaStepUp/.test(cc));
    const ui = fs.readFileSync(path.join(__dirname, "..", "lib", "ui.js"), "utf8");
    check("step-up.js is on every page", /<script src="\$\{asset\("step-up\.js"\)\}" defer><\/script>/.test(ui));
    r = await s.req("GET", "/static/step-up.js", { cookie: who.cookie, headers: { Host: A } });
    check("  and is served", r.status === 200 && /JoyaStepUp/.test(r.body));
    r = await s.req("GET", "/joya-ai?shell=desktop", { cookie: who.cookie, headers: { Host: A } });
    check("the desktop app's page wraps navigator.credentials (joya-desktop-webauthn.js) for Windows Hello", r.status === 200 && /joya-desktop-webauthn\.js/.test(r.body) && /step-up\.js/.test(r.body));
  } catch (e) {
    failures++;
    console.log("FAIL threw: " + (e && e.stack));
  } finally {
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
