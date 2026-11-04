#!/usr/bin/env node
"use strict";
/**
 * The default landing: `/` and sign-in go to JOYA AI, the OS overview lives at
 * /os, and a role without JOYA AI lands on the first page it may open.
 *
 *     NODE_PATH=/opt/joya-dashboard/node_modules node dashboard/tools/test-landing.cjs
 *
 * Boots the real server.js on a scratch port with a scratch data dir (no
 * supervisor socket) and signs in as five roles over HTTP.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const { spawn } = require("child_process");

const ROOT = path.join(__dirname, "..");
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), "landing-"));
const LOGS = path.join(DATA, "log");
fs.mkdirSync(LOGS);
process.env.JOYA_DATA_DIR = DATA;
process.env.JOYA_LOG_DIR = LOGS;
const PORT = 3800 + Math.floor(Math.random() * 90);

let failures = 0;
let passes = 0;
function check(name, ok, detail) {
  if (ok) {
    passes++;
    return console.log("ok   " + name);
  }
  failures++;
  console.log("FAIL " + name + (detail !== undefined ? "  (" + String(detail).slice(0, 300) + ")" : ""));
}

/* ------------------------------------------------------- static checks --- */

const rbac = require(path.join(ROOT, "lib", "rbac.js"));
const ui = require(path.join(ROOT, "lib", "ui.js"));
const A = (perms) => rbac.actor({ permissions: perms, agent_scope: "*", channel_scope: "*" });
check("landing: administrator -> /joya-ai", rbac.landing(A(["*"])) === "/joya-ai");
check("landing: joyaai.use alone -> /joya-ai", rbac.landing(A(["joyaai.use"])) === "/joya-ai");
check("landing: os.view without joyaai.use -> /os", rbac.landing(A(["os.view", "agents.view"])) === "/os");
check("landing: agents.view only -> /agents/dashboard", rbac.landing(A(["agents.view"])) === "/agents/dashboard");
check("landing: nothing -> /account", rbac.landing(A([])) === "/account");
check("landing: no actor at all -> /account", rbac.landing(null) === "/account");
check("sidebar group order: JOYA AI, Agents & sessions, Machine, Access & security (the Guide is in the avatar menu)", ui.NAV.map((g) => g.key).join(" ") === "joya-ai agents machine access", ui.NAV.map((g) => g.key).join(" "));
check("the Command Center is the first item, at /joya-ai", ui.NAV[0].items[0].href === "/joya-ai");
check("Machine ▸ Overview is /os", ui.NAV.find((g) => g.key === "machine").items[0].href === "/os");
check("Agents & sessions ▸ Overview is /agents/dashboard", ui.NAV.find((g) => g.key === "agents").items[0].href === "/agents/dashboard");
{
  const hits = [];
  for (const f of fs.readdirSync(path.join(ROOT, "lib")).filter((f) => f.endsWith(".js"))) {
    fs.readFileSync(path.join(ROOT, "lib", f), "utf8").split("\n").forEach((line, i) => {
      if (/\["OS Dashboard", "\/"\]/.test(line)) hits.push(f + ":" + (i + 1));
    });
  }
  check("no breadcrumb names / as the OS Dashboard", hits.length === 0, hits.join(" "));
}

/* ------------------------------------------------------------- over HTTP --- */

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
    const r = http.request({ host: "127.0.0.1", port: PORT, method, path: p, headers: h }, (res) => {
      let buf = "";
      res.setEncoding("utf8");
      res.on("data", (c) => {
        buf += c;
        // SSE never ends: the headers are the answer.
        if (/text\/event-stream/.test(res.headers["content-type"] || "")) {
          r.destroy();
          resolve({ status: res.statusCode, headers: res.headers, body: buf });
        }
      });
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: buf }));
      res.on("error", () => resolve({ status: res.statusCode, headers: res.headers, body: buf }));
    });
    r.on("error", reject);
    r.setTimeout(8000, () => r.destroy(new Error("timeout " + method + " " + p)));
    if (data) r.write(data);
    r.end();
  });
}

function cookieOf(res, prev) {
  const set = res.headers["set-cookie"];
  if (!set) return prev;
  return set.map((c) => c.split(";")[0]).join("; ");
}

async function signIn(username, password, secret) {
  const { authenticator } = require("otplib");
  const g = await req("GET", "/login");
  let cookie = cookieOf(g);
  const csrf = (g.body.match(/name="_csrf" value="([^"]+)"/) || [])[1];
  const form = new URLSearchParams({ _csrf: csrf, username, password, token: authenticator.generate(secret) }).toString();
  const p = await req("POST", "/login", { cookie, body: form });
  cookie = cookieOf(p, cookie);
  if (p.status !== 302 || /\/login/.test(p.headers.location || "")) throw new Error("sign-in failed: " + p.status + " " + p.headers.location);
  return { cookie, landed: p.headers.location };
}

async function makeUser(username, roleName, permissions) {
  const db = require(path.join(ROOT, "lib", "db.js"));
  if (permissions && !db.getRoleByName(roleName))
    db.createRole({ name: roleName, label: roleName, permissions, agentScope: "*", channelScope: "*" });
  const argon2 = require("argon2");
  const { authenticator } = require("otplib");
  const pw = "pw-" + Math.random().toString(36).slice(2);
  const secret = authenticator.generateSecret();
  const role = db.getRoleByName(roleName);
  db.createUser({ username, displayName: username, email: username + "@example.invalid", passwordHash: await argon2.hash(pw, { type: argon2.argon2id }), totpSecret: secret, roleId: role.id, createdBy: "test" });
  db.confirmUserTotp(db.getUserByName(username).id);
  return { pw, secret };
}

// The sidebar's items (the top-bar tabs are gone): href, "*" on the current one.
const sideHrefs = (body) => [...body.matchAll(/<a href="([^"]+)" class="side-item( on)?"/g)].map((m) => m[1] + (m[2] ? "*" : ""));
const noTabs = (body) => !/class="top-tab/.test(body);
const brand = (body) => (body.match(/<a class="brand" href="([^"]+)"/) || [])[1];

(async () => {
  const admin = await makeUser("landadmin", "administrator");
  const viewer = await makeUser("landviewer", "viewer");
  const operator = await makeUser("landoperator", "operator");
  const agentsOnly = await makeUser("landagents", "agents-only", ["agents.view"]);
  const nothing = await makeUser("landnothing", "nothing-at-all", []);

  const child = spawn(process.execPath, [path.join(ROOT, "server.js")], {
    env: Object.assign({}, process.env, {
      JOYA_PORT: String(PORT),
      JOYA_BIND: "127.0.0.1",
      JOYA_AI_SOCKET: path.join(DATA, "no-such.sock"),
      NODE_ENV: "production",
    }),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  child.stdout.on("data", (d) => (out += d));
  child.stderr.on("data", (d) => (out += d));
  const done = () => {
    child.kill();
    fs.rmSync(DATA, { recursive: true, force: true });
  };
  try {
    for (let i = 0; i < 60 && !/listening/.test(out); i++) await new Promise((r) => setTimeout(r, 200));
    if (!/listening/.test(out)) throw new Error("server did not start: " + out);

    /* signed out */
    let r = await req("GET", "/");
    check("GET / signed out -> 302 /login", r.status === 302 && r.headers.location === "/login", r.status + " " + r.headers.location);
    r = await req("GET", "/os");
    check("GET /os signed out -> 302 /login", r.status === 302 && r.headers.location === "/login", r.status + " " + r.headers.location);

    /* administrator */
    const a = await signIn("landadmin", admin.pw, admin.secret);
    check("admin: sign-in lands on /joya-ai", a.landed === "/joya-ai", a.landed);
    r = await req("GET", "/", { cookie: a.cookie });
    check("admin: GET / -> 302 (not 301) /joya-ai", r.status === 302 && r.headers.location === "/joya-ai", r.status + " " + r.headers.location);
    check("admin: GET / does not render the overview", !/<h1>Machine health<\/h1>/.test(r.body));
    r = await req("GET", "/login", { cookie: a.cookie });
    check("admin: /login while signed in -> /joya-ai", r.status === 302 && r.headers.location === "/joya-ai", r.status + " " + r.headers.location);
    r = await req("GET", "/os", { cookie: a.cookie });
    check("admin: /os renders Machine health", r.status === 200 && /<h1>Machine health<\/h1>/.test(r.body) && /id="mc-hero"/.test(r.body) && /mycelium\.js/.test(r.body), r.status);
    check("admin: no top-bar tabs; the sidebar starts at the Command Center and marks /os current", noTabs(r.body) && sideHrefs(r.body)[0] === "/joya-ai" && sideHrefs(r.body).includes("/os*"), sideHrefs(r.body).join(" "));
    check("admin: the sidebar's Dashboard item on /os is /os and is current", /<a href="\/os" class="side-item on" aria-current="page"/.test(r.body));
    check("admin: the brand link goes to /joya-ai", brand(r.body) === "/joya-ai", brand(r.body));
    r = await req("GET", "/agents/dashboard", { cookie: a.cookie });
    check("admin: /agents/dashboard opens, its sidebar item current", r.status === 200 && sideHrefs(r.body).includes("/agents/dashboard*") && sideHrefs(r.body).filter((h) => h.endsWith("*")).length === 1, r.status + " " + sideHrefs(r.body).join(" "));
    r = await req("GET", "/joya-ai", { cookie: a.cookie });
    check("admin: /joya-ai is the Command Center, its sidebar item first and current", r.status === 200 && /id="cc"/.test(r.body) && sideHrefs(r.body)[0] === "/joya-ai*", sideHrefs(r.body).join(" "));
    r = await req("GET", "/services", { cookie: a.cookie });
    check("admin: a Machine page's crumb links the Machine group at /os", r.status === 200 && /<nav class="crumbs"[^>]*><a href="\/os">Machine<\/a>/.test(r.body), r.status);
    r = await req("GET", "/api/os/pulse?since=0", { cookie: a.cookie, headers: { Accept: "application/json" } });
    check("admin: the Mycelium feed still answers", r.status === 200 && /^\{/.test(r.body), r.status);

    /* viewer: os.view, no joyaai.use */
    const v = await signIn("landviewer", viewer.pw, viewer.secret);
    check("viewer: sign-in lands on /os", v.landed === "/os", v.landed);
    r = await req("GET", "/", { cookie: v.cookie });
    check("viewer: GET / -> 302 /os", r.status === 302 && r.headers.location === "/os", r.status + " " + r.headers.location);
    r = await req("GET", "/os", { cookie: v.cookie });
    check("viewer: /os renders Machine health", r.status === 200 && /<h1>Machine health<\/h1>/.test(r.body), r.status);
    check("viewer: no JOYA AI group, no tabs, /os current", noTabs(r.body) && !/data-g="joya-ai"/.test(r.body) && !sideHrefs(r.body).some((h) => h.startsWith("/joya-ai")) && sideHrefs(r.body).includes("/os*"), sideHrefs(r.body).join(" "));
    check("viewer: the brand link goes to /os", brand(r.body) === "/os", brand(r.body));

    /* operator: os.view, no joyaai.use */
    const o = await signIn("landoperator", operator.pw, operator.secret);
    check("operator: sign-in lands on /os", o.landed === "/os", o.landed);

    /* agents.view only */
    const g = await signIn("landagents", agentsOnly.pw, agentsOnly.secret);
    check("agents-only: sign-in lands on /agents/dashboard", g.landed === "/agents/dashboard", g.landed);
    r = await req("GET", "/", { cookie: g.cookie });
    check("agents-only: GET / -> 302 /agents/dashboard", r.status === 302 && r.headers.location === "/agents/dashboard", r.status + " " + r.headers.location);
    r = await req("GET", "/agents/dashboard", { cookie: g.cookie });
    check("agents-only: the landing opens (200)", r.status === 200, r.status);
    r = await req("GET", "/os", { cookie: g.cookie });
    check("agents-only: /os is refused (403)", r.status === 403, r.status);

    /* no permissions at all */
    const n = await signIn("landnothing", nothing.pw, nothing.secret);
    check("no permissions: sign-in lands on /account", n.landed === "/account", n.landed);
    r = await req("GET", "/", { cookie: n.cookie });
    check("no permissions: GET / -> 302 /account", r.status === 302 && r.headers.location === "/account", r.status + " " + r.headers.location);
    r = await req("GET", "/account", { cookie: n.cookie });
    check("no permissions: the landing opens (200)", r.status === 200, r.status);
  } catch (e) {
    check("the HTTP run completed", false, e.stack + "\n" + out);
  } finally {
    done();
  }
  console.log(`\n${passes} passed, ${failures} failed`);
  process.exit(failures ? 1 : 0);
})();
