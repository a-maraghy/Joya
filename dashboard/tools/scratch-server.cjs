"use strict";
/**
 * A scratch copy of the dashboard for tests that need the real server.js over
 * HTTP (and WebSocket), with NOTHING reaching the privileged helper.
 *
 * Trap (2026-09-29): a scratch copy calls the REAL /usr/local/sbin/joya-helper
 * through sudo, and submitting the voice-options form in one rewrote the live
 * voice settings. So the copy's lib/priv.js is patched before it starts:
 * callHelper() refuses every subcommand, and the voice status and key reads are
 * answered with fakes. The data dir is a temp dir, so no live setting
 * (voice_desk, the voice mode, a persona) can be written either.
 *
 *   const s = await startScratch({ env: {...}, fakeReads: { "service-list": [...] } });
 *   await s.makeUser("admin1", "administrator");
 *   const who = await s.signIn("admin1");
 *   const r = await s.req("GET", "/joya-ai", { cookie: who.cookie });
 *   s.stop();
 *
 * Set process.env.JOYA_DATA_DIR before requiring lib/db.js in the test: this
 * sets it to the scratch data dir on load, so require this file first.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const { spawn } = require("child_process");

const SRC = path.join(__dirname, "..");
const BASE = fs.mkdtempSync(path.join(os.tmpdir(), "joya-scratch-"));
const DATA = path.join(BASE, "data");
const LOGS = path.join(BASE, "log");
const APP = path.join(BASE, "dashboard");
fs.mkdirSync(DATA);
fs.mkdirSync(LOGS);
process.env.JOYA_DATA_DIR = DATA;
process.env.JOYA_LOG_DIR = LOGS;

const FAKE_KEY = "sk-proj-SCRATCHFAKEKEY-not-real-0000000000000000";

/**
 * Copy the dashboard and cut it off from the helper. With fakeKeys
 * ({ ubuntu: [...], root: [...] }) the SSH key list answers with those, so
 * /keys renders. With fakeVoiceOptions,
 * saving the voice settings writes a file in the scratch data dir (and the key
 * read answers from it) -- never the helper -- so a test can change the voice.
 * With recordCalls, each canned (fakeReads) answer is logged to
 * <data>/helper-calls.jsonl with the stdin the route sent.
 */
function makeCopy(o) {
  o = o || {};
  fs.cpSync(SRC, APP, { recursive: true, filter: (p) => !/node_modules|\.git$/.test(p) });
  const p = path.join(APP, "lib", "priv.js");
  let s = fs.readFileSync(p, "utf8");
  const head = "function callHelper(subcommand, args = [], opts = {}) {\n";
  if (!s.includes(head)) throw new Error("scratch: priv.js callHelper not found; refusing to start an unguarded copy");
  // fakeReads: canned answers for read-only subcommands (e.g. "service-list"), so a
  // page that lists things can be rendered; everything else is still refused.
  const reads = o.fakeReads && typeof o.fakeReads === "object" ? o.fakeReads : null;
  // recordCalls: every canned answer also appends {subcommand, args, stdin} to
  // helper-calls.jsonl in the scratch data dir, so a test can see what a route asked for.
  const record = o.recordCalls
    ? "require('fs').appendFileSync(" + JSON.stringify(path.join(DATA, "helper-calls.jsonl")) + ", JSON.stringify({ subcommand, args, stdin: opts && opts.stdin != null ? String(opts.stdin) : null }) + '\\n'); "
    : "";
  const canned = reads ? "  { const F = " + JSON.stringify(reads) + "; if (Object.prototype.hasOwnProperty.call(F, subcommand) && /^(list|status|agent-list|agent-get|agent-logs|agent-vault-list|agent-vault-index|agent-memory-graph|agent-memory-stats|agent-read-file|firewall-status|audit-tail|channel-list|channel-get|channel-topics-folders|service-list|credential-list|system-probe|cc-)/.test(subcommand)) { " + record + "return Promise.resolve(JSON.parse(JSON.stringify(F[subcommand]))); } }\n" : "";
  s = s.replace(head, head + canned + '  return Promise.reject(new Error("scratch copy: the helper is not called (" + subcommand + ")"));\n');
  const status = 'voiceStatus: () => callHelper("voice-status"),';
  const key = 'voiceKeyRead: () => callHelper("voice-key-read"),';
  if (!s.includes(status) || !s.includes(key)) throw new Error("scratch: priv.js voice reads not found");
  if (o.fakeVoiceOptions) {
    const setter = s.match(/voiceOptionsSet: \(model, voice, transcribeModel\) =>[\s\S]*?\),\n/);
    if (!setter) throw new Error("scratch: priv.js voiceOptionsSet not found");
    const file = JSON.stringify(path.join(DATA, "fake-voice-options.json"));
    s = s.replace(setter[0], `voiceOptionsSet: async (model, voice, transcribeModel) => { require("fs").writeFileSync(${file}, JSON.stringify({ model, voice, transcribe_model: transcribeModel })); return { ok: true }; },\n`);
    s = s.replace(key, `voiceKeyRead: async () => { let o = {}; try { o = JSON.parse(require("fs").readFileSync(${file}, "utf8")); } catch (_) { o = {}; } return { key: "${FAKE_KEY}", model: o.model || "gpt-realtime-mini", voice: o.voice || "marin", transcribe_model: o.transcribe_model || "gpt-4o-mini-transcribe" }; },`); // (a helper file from before 2026-10-30)
  }
  if (o.fakeVoiceprint) {
    // The voiceprint's seal / open / forget (helper voiceprint-*): AES-256-GCM here with a key file in the
    // scratch data dir, the same shape the helper answers; forget records its argument in fake-vp-forget.json.
    const seal = 'voiceprintSeal: (plainB64) => callHelper("voiceprint-seal", [], { stdin: JSON.stringify({ plain: plainB64 }) }),';
    const open = 'voiceprintOpen: (sealedB64) => callHelper("voiceprint-open", [], { stdin: JSON.stringify({ sealed: sealedB64 }) }),';
    const forget = 'voiceprintForget: (keepKey) => callHelper("voiceprint-forget", keepKey ? ["keep-key"] : []),';
    if (!s.includes(seal) || !s.includes(open) || !s.includes(forget)) throw new Error("scratch: priv.js voiceprint* not found");
    const kf = JSON.stringify(path.join(DATA, "fake-vp.key"));
    const ff = JSON.stringify(path.join(DATA, "fake-vp-forget.json"));
    const key = `const C = require("crypto"), F = require("fs"); let K; try { K = F.readFileSync(${kf}); } catch (_) { K = C.randomBytes(32); F.writeFileSync(${kf}, K, { mode: 0o600 }); }`;
    s = s.replace(seal, `voiceprintSeal: async (plainB64) => { ${key} const n = C.randomBytes(12); const c = C.createCipheriv("aes-256-gcm", K, n); c.setAAD(Buffer.from("joya-voiceprint-v1")); const ct = Buffer.concat([c.update(Buffer.from(plainB64, "base64")), c.final()]); return { sealed: Buffer.concat([n, ct, c.getAuthTag()]).toString("base64") }; },`);
    s = s.replace(open, `voiceprintOpen: async (sealedB64) => { const C = require("crypto"), F = require("fs"); const K = F.readFileSync(${kf}); const b = Buffer.from(sealedB64, "base64"); const d = C.createDecipheriv("aes-256-gcm", K, b.subarray(0, 12)); d.setAAD(Buffer.from("joya-voiceprint-v1")); d.setAuthTag(b.subarray(b.length - 16)); return { plain: Buffer.concat([d.update(b.subarray(12, b.length - 16)), d.final()]).toString("base64") }; },`);
    s = s.replace(forget, `voiceprintForget: async (keepKey) => { const F = require("fs"); F.writeFileSync(${ff}, JSON.stringify({ keepKey: !!keepKey })); let had = false; if (!keepKey) { try { F.unlinkSync(${kf}); had = true; } catch (_) {} } return { key_deleted: had, results_deleted: 0 }; },`);
  }
  if (o.fakeChatgpt) {
    // JOYA AI Settings > ChatGPT (lib/routes-chatgpt.js): the helper's chatgpt-* and agent-chatgpt
    // answered from fake-chatgpt.json in the scratch data dir -- {status, calls, login, agents: {slug: bool},
    // log: [...]}. login-start hands out a fixed code; a test flips login.state to "done" to finish it.
    const names = ["chatgptStatus", "chatgptCalls", "chatgptLoginStart", "chatgptLoginPoll", "chatgptLoginCancel", "agentChatgpt", "agentRestartIdle"];
    for (const n of names) if (!new RegExp("\\n  " + n + ": ").test(s)) throw new Error("scratch: priv.js " + n + " not found");
    const cf = JSON.stringify(path.join(DATA, "fake-chatgpt.json"));
    const st = Object.assign({ status: { service: "active", answering: true, login: "signed_in", account: "ChatGPT account", detail: "Logged in using ChatGPT", running: 0, queued: 0, max_running: 2, max_queued: 8, timeout_s: 600, login_in_progress: false }, calls: [], agents: {}, login: null, log: [] }, o.fakeChatgpt);
    fs.writeFileSync(path.join(DATA, "fake-chatgpt.json"), JSON.stringify(st));
    const R = `const F = require("fs"); const C = JSON.parse(F.readFileSync(${cf}, "utf8")); const W = () => F.writeFileSync(${cf}, JSON.stringify(C));`;
    const fakes = {
      chatgptStatus: `async () => { ${R} return Object.assign({}, C.status, { login_in_progress: !!(C.login && C.login.state === "pending") }); }`,
      chatgptCalls: `async (n) => { ${R} return { calls: C.calls.slice(0, Number(n) || 100) }; }`,
      chatgptLoginStart: `async () => { ${R} C.log.push("login-start"); if (!C.login || C.login.state !== "pending") C.login = { id: "0123456789abcdef", url: "https://auth.openai.com/codex/device", code: "ABCD-12345", expires_at: Math.floor(Date.now() / 1000) + 900, state: "pending" }; W(); return { id: C.login.id, url: C.login.url, code: C.login.code, expires_at: C.login.expires_at }; }`,
      chatgptLoginPoll: `async (id) => { ${R} C.log.push("login-poll " + id); if (!C.login || C.login.id !== id) throw new Error("no such sign-in"); if (C.login.state === "done") { C.status.login = "signed_in"; W(); return { state: "done", login: "signed_in", account: "ChatGPT account", message: "Signed in." }; } W(); return { state: C.login.state, url: C.login.url, code: C.login.code, expires_at: C.login.expires_at, message: C.login.message || "" }; }`,
      chatgptLoginCancel: `async (id) => { ${R} C.log.push("login-cancel " + id); if (C.login && C.login.id === id) C.login.state = "cancelled"; W(); return { cancelled: true, stopped: true }; }`,
      agentChatgpt: `async (slug, on) => { ${R} C.log.push("agent-chatgpt " + slug + " " + (on ? "on" : "off")); C.agents[slug] = !!on; W(); const act = !(C.inactive || []).includes(slug); return { slug, chatgpt: !!on, state: { active: act ? "active" : "inactive" }, restart_needed: act, busy: act && !!(C.busy || {})[slug] }; }`,
      agentRestartIdle: `async (slug) => { ${R} C.log.push("agent-restart-idle " + slug); W(); if ((C.busy || {})[slug]) throw new Error("busy: it is answering a message right now"); return { slug, restarted: true, state: { active: "active" } }; }`,
    };
    for (const n of names) s = s.replace(new RegExp("\\n  " + n + ": [^\\n]*\\n"), "\n  " + n + ": " + fakes[n] + ",\n");
  }
  if (o.fakeKeys) {
    // /keys lists keys through the helper; a test that renders it gets these.
    const list = 'listAllKeys: () => callHelper("list-all-keys"),';
    if (!s.includes(list)) throw new Error("scratch: priv.js listAllKeys not found");
    s = s.replace(list, "listAllKeys: async () => (" + JSON.stringify(o.fakeKeys) + "),");
  }
  s = s
    .replace(status, 'voiceStatus: async () => ({ configured: true, last4: "fake", length: 52, path: "(scratch)", mode: "0o600", modified: null, model: "gpt-realtime-mini", voice: "marin", transcribe_model: "gpt-4o-mini-transcribe" }),')
    .replace(key, `voiceKeyRead: async () => ({ key: "${FAKE_KEY}", model: "gpt-realtime-mini", voice: "marin", transcribe_model: "gpt-4o-mini-transcribe" }),`);
  fs.writeFileSync(p, s);
  // Belt and braces: the copy must not be able to name the real helper at all.
  if (!/scratch copy: the helper is not called/.test(fs.readFileSync(p, "utf8"))) throw new Error("scratch: guard not applied");
  patchBriefClock(o);
}

/**
 * The scheduled morning brief (lib/routes-proactive.js briefDue): by default 08:00 in the person's zone
 * (Africa/Cairo) and written up to 6 h late, so a scratch server started between 08:00 and 14:00 Cairo
 * wrote a real brief for every test user on its first look -- an extra glance card, an extra token-caps
 * read, and a brief whose window starts then (trap, 2026-10-21: test-desktop-glance and test-proactive
 * failed every morning on unchanged code). A test is deterministic at any hour only if the copy's clock
 * does not decide: scheduledBriefs "off" (the default; also env JOYA_SCRATCH_BRIEFS) never writes one;
 * "due" writes it on the first look whatever the hour (the morning, on demand); "real" keeps the clock.
 * Tests that want a brief write it themselves ("brief now", or the store); briefDue's own rule is
 * tested in-process with a fixed clock (test-proactive.cjs).
 */
function patchBriefClock(o) {
  const mode = o.scheduledBriefs || process.env.JOYA_SCRATCH_BRIEFS || "off";
  if (mode === "real") return;
  if (mode !== "off" && mode !== "due") throw new Error("scratch: scheduledBriefs is off, due or real");
  const p = path.join(APP, "lib", "routes-proactive.js");
  let s = fs.readFileSync(p, "utf8");
  const head = "  function briefDue(pr, t) {\n    if (!pr.brief_on) return false;\n";
  if (!s.includes(head)) throw new Error("scratch: routes-proactive.js briefDue not found");
  const rule = mode === "off" ? "    return false; // scratch copy: no scheduled brief\n" : "    if (pr.last_brief_day === P.localNow(t, pr.tz).date) return false;\n    return true; // scratch copy: the brief is due now, whatever the hour\n";
  s = s.replace(head, head + rule);
  fs.writeFileSync(p, s);
}

async function startScratch(opts) {
  const o = opts || {};
  makeCopy(o);
  let port = o.port || 3600 + Math.floor(Math.random() * 300);
  if (!o.port && port === 3659) port = 3660; // 3659 is on Chromium's unsafe-port list (ERR_UNSAFE_PORT)
  const env = Object.assign({}, process.env, {
    JOYA_PORT: String(port),
    JOYA_BIND: "127.0.0.1",
    JOYA_DATA_DIR: DATA,
    JOYA_LOG_DIR: LOGS,
    JOYA_AI_SOCKET: path.join(DATA, "no-such.sock"),
    JOYA_OPENAI_HTTP: "http://127.0.0.1:1/v1",
    JOYA_OPENAI_WS: "ws://127.0.0.1:1/v1",
    NODE_ENV: "production",
  }, o.env || {});
  const child = spawn(process.execPath, [path.join(APP, "server.js")], { env, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  child.stdout.on("data", (d) => (out += d));
  child.stderr.on("data", (d) => (out += d));
  for (let i = 0; i < 60 && !/listening/.test(out); i++) await new Promise((r) => setTimeout(r, 200));
  if (!/listening/.test(out)) {
    child.kill();
    throw new Error("scratch server did not start: " + out);
  }

  function req(method, p, { cookie, headers, body } = {}) {
    return new Promise((resolve, reject) => {
      const h = Object.assign({ "X-Forwarded-Proto": "https" }, headers || {});
      if (cookie) h.Cookie = cookie;
      let data = null;
      if (body !== undefined) {
        data = typeof body === "string" ? body : JSON.stringify(body);
        if (!h["Content-Type"]) h["Content-Type"] = typeof body === "string" ? "application/x-www-form-urlencoded" : "application/json";
        h["Content-Length"] = Buffer.byteLength(data);
      }
      const r = http.request({ host: "127.0.0.1", port, method, path: p, headers: h }, (res) => {
        let buf = "";
        res.setEncoding("utf8");
        res.on("data", (c) => (buf += c));
        res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: buf }));
        res.on("error", () => resolve({ status: res.statusCode, headers: res.headers, body: buf }));
      });
      r.on("error", reject);
      r.setTimeout(15000, () => r.destroy(new Error("timeout " + method + " " + p)));
      if (data) r.write(data);
      r.end();
    });
  }
  const cookieOf = (res, prev) => {
    const set = res.headers["set-cookie"];
    return set ? set.map((c) => c.split(";")[0]).join("; ") : prev;
  };
  const users = {};
  async function makeUser(username, roleName, permissions) {
    const db = require(path.join(SRC, "lib", "db.js"));
    if (permissions && !db.getRoleByName(roleName)) db.createRole({ name: roleName, label: roleName, permissions, agentScope: "*", channelScope: "*" });
    const argon2 = require("argon2");
    const { authenticator } = require("otplib");
    const pw = "pw-" + Math.random().toString(36).slice(2);
    const secret = authenticator.generateSecret();
    const role = db.getRoleByName(roleName);
    db.createUser({ username, displayName: username, email: username + "@example.invalid", passwordHash: await argon2.hash(pw, { type: argon2.argon2id }), totpSecret: secret, roleId: role.id, createdBy: "test" });
    db.confirmUserTotp(db.getUserByName(username).id);
    users[username] = { pw, secret };
    return users[username];
  }
  async function signIn(username) {
    const { authenticator } = require("otplib");
    const u = users[username];
    const g = await req("GET", "/login");
    let cookie = cookieOf(g);
    const csrf = (g.body.match(/name="_csrf" value="([^"]+)"/) || [])[1];
    const form = new URLSearchParams({ _csrf: csrf, username, password: u.pw, token: authenticator.generate(u.secret) }).toString();
    const p = await req("POST", "/login", { cookie, body: form });
    cookie = cookieOf(p, cookie);
    if (p.status !== 302 || /\/login/.test(p.headers.location || "")) throw new Error("sign-in failed: " + p.status);
    return { cookie };
  }
  const csrfOf = (html) => (/data-csrf="([^"]+)"/.exec(html) || /name="_csrf" value="([^"]+)"/.exec(html) || [])[1];
  return {
    port,
    base: BASE,
    data: DATA,
    app: APP,
    out: () => out,
    req,
    makeUser,
    signIn,
    csrfOf,
    stop() {
      child.kill();
      fs.rmSync(BASE, { recursive: true, force: true });
    },
  };
}

module.exports = { startScratch, DATA, FAKE_KEY };
