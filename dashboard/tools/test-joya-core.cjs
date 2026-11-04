#!/usr/bin/env node
"use strict";
/**
 * The JOYA AI core setting: which of the two cores (D mesh, E bot) the Command
 * Center draws, per person, default D (since 2026-10-06; everyone was moved to D
 * once, by a recorded migration). A, B and C were retired on 2026-10-25: anyone
 * still on one of them is moved to E at start (a second recorded migration).
 *
 *     NODE_PATH=/opt/joya-dashboard/node_modules node dashboard/tools/test-joya-core.cjs
 *
 * Static checks on the pieces (cc-logic.js, db.js, server.js, the page
 * scripts), then the real server.js on a scratch port with a scratch data dir,
 * signed in over HTTP as an administrator, a second administrator and a
 * viewer:
 *
 *  - stored per user (users.joya_core), default D for anyone who never chose;
 *  - the one-time migration moves every existing account to D, is recorded,
 *    audited per account, and never runs again (a later switch back sticks);
 *  - the saved core is in the served HTML as data-core, before any script runs;
 *  - the quick switch (POST /joya-ai/api/prefs/core) needs joyaai.use and CSRF,
 *    refuses anything but A/B/C/D, saves, and leaves an audit line;
 *  - JOYA AI ▸ Settings ▸ Appearance shows the three cores to those who can open the
 *    Command Center (Account only points there), and its no-JavaScript form saves the same way;
 *  - the page swaps the running core in place (no reload).
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const { spawn } = require("child_process");

const ROOT = path.join(__dirname, "..");
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), "joya-core-"));
const LOGS = path.join(DATA, "log");
fs.mkdirSync(LOGS);
process.env.JOYA_DATA_DIR = DATA;
process.env.JOYA_LOG_DIR = LOGS;
const PORT = 3700 + Math.floor(Math.random() * 90);

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
const read = (f) => fs.readFileSync(path.join(ROOT, f), "utf8");

/* ------------------------------------------------------- static checks --- */

const logic = require(path.join(ROOT, "public", "cc-logic.js"));
check("two cores: D mesh, E bot (A, B and C retired 2026-10-25)", JSON.stringify(logic.CORES) === JSON.stringify({ D: "Mesh", E: "Bot" }));
check("the default is D", logic.CORE_DEFAULT === "D" && logic.normCore("") === "D" && logic.normCore(null) === "D" && logic.normCore(undefined) === "D");
check("a saved choice is kept, in any case; a retired A, B or C reads as E", logic.normCore("a") === "E" && logic.normCore(" B ") === "E" && logic.normCore("C") === "E" && logic.normCore("d") === "D" && logic.normCore("e") === "E");
check("anything else reads as the default", logic.normCore("F") === "D" && logic.normCore('"><x') === "D" && logic.normCore(7) === "D");
check("the API accepts exactly D or E", !logic.isCore("A") && !logic.isCore("B") && !logic.isCore("C") && logic.isCore("D") && logic.isCore("E") && !logic.isCore("a") && !logic.isCore("d") && !logic.isCore("F") && !logic.isCore("") && !logic.isCore(null) && !logic.isCore(["A"]));
const uia = require(path.join(ROOT, "public", "ui-actions.js"));
check("the voice / agent action core.set accepts D and E only (both copies of ui-actions.js agree)", JSON.stringify(uia.CORES) === '{"D":"D","E":"E"}' && read("public/ui-actions.js") === fs.readFileSync(path.join(ROOT, "..", "joya-ai", "lib", "ui-actions.js"), "utf8"));

const dbSrc = read("lib/db.js");
check("db: users.joya_core is added the migration way, empty by default", /addColumn\("users", "joya_core", "TEXT NOT NULL DEFAULT ''"\)/.test(dbSrc));
check("db: the one-time move to D is recorded in settings and runs before anyone signs in", /const CORE_D_MIGRATION = "migration\.joya_core_d";/.test(dbSrc) && /^migrateCoreDefaultD\(\);$/m.test(dbSrc) && /if \(db\.prepare\("SELECT 1 FROM settings WHERE key = \?"\)\.get\(CORE_D_MIGRATION\)\) return null;/.test(dbSrc));
check("db: the retired cores move to E at every start, audited and recorded", /const CORE_ABC_MIGRATION = "migration\.joya_core_abc_e";/.test(dbSrc) && /^migrateRetiredCores\(\);$/m.test(dbSrc) && /WHERE joya_core IN \('A', 'B', 'C'\)/.test(dbSrc));
check("db: setUserJoyaCore writes only that column, by id", /setUserJoyaCore: \(id, core\) =>\s*db\.prepare\("UPDATE users SET joya_core = \? WHERE id = \?"\)/.test(dbSrc));

const server = read("server.js");
check("server: the quick switch needs joyaai.use and CSRF", /app\.post\("\/joya-ai\/api\/prefs\/core", \.\.\.joyaAiWrite,/.test(server));
check("server: the Appearance form needs a session, joyaai.use and CSRF", /app\.post\("\/account\/appearance", requireAuth, requirePerm\("joyaai\.use"\), requireCsrf,/.test(server));
check("server: both validate with isCore and save through one function", (server.match(/joyaLogic\.isCore\(core\)/g) || []).length === 2 && (server.match(/  setJoyaCore\(req, core\);/g) || []).length === 2);
check("server: the change is audited", /db\.logLogin\(req\.ip, req\.me\.username, "account", `JOYA AI core \$\{was\} -> \$\{core\}/.test(server));
check("server: the page is given the saved core", /joyaAiViews\.page\(\{[\s\S]{0,200}core: req\.me\.joya_core/.test(server));
check("server: /account points to Settings ▸ Appearance only with joyaai.use", /appearance: req\.perm\.can\("joyaai\.use"\),/.test(server));

const main = read("public/joya-ai.js"), map = read("public/cc-map.js"), settings = read("public/joya-settings.js");
check("joya-core.js (A, B and C) is gone", !fs.existsSync(path.join(ROOT, "public", "joya-core.js")));
check("page: the saved core comes from data-core, localStorage only as the fallback", /var c = root\.getAttribute\("data-core"\);\s*if \(!c\) \{ try \{ c = window\.localStorage\.getItem\(CORE_KEY\); \} catch/.test(main));
check("page: every localStorage use for the core is inside try/catch", main.split("\n").filter((l) => /localStorage/.test(l) && /CORE_KEY/.test(l)).every((l) => /try \{[^}]*localStorage[^}]*\} catch/.test(l)));
check("page: the quick switch swaps the core in place, then saves it", /function setCoreChoice\(c\) \{[\s\S]{0,160}Orb\.setConcept\(c\);[\s\S]{0,400}api\("prefs\/core", \{ body: \{ core: c \} \}\)/.test(main));
check("page: nothing reloads the page to switch", !/location\.reload|location\.href\s*=/.test(main + map + settings));
const coreD = read("public/joya-core-d.js");
check("core D: its own file, WebGL2 with a 2D fallback, the same instance API, no eval", /window\.JoyaCoreD = function \(canvas, opts\)/.test(coreD) && /getContext\("webgl2"/.test(coreD) && /getContext\("2d"\)/.test(coreD) && ["setState", "setLight", "resize", "start", "stop", "still", "stats", "draw", "destroy", "setConcept"].every((m) => new RegExp(m + ": ").test(coreD)) && !/\beval\(|new Function/.test(coreD));
check("core D: stops while hidden, still frame under reduced motion, a resolution guard", /visibilitychange/.test(coreD) && /prefers-reduced-motion: reduce/.test(coreD) && /S\.lowRes = true/.test(coreD));
check("map: D <-> E swaps the renderer on a fresh canvas, releasing the old context", /function swapCore\(c\)/.test(map) && /cloneNode\(false\)/.test(map) && /destroy\(\)/.test(map) && /WEBGL_lose_context/.test(map) && /get core\(\) \{ return core; \}/.test(map));
check("page: window.__joyaCC.core follows the swap (a getter)", /get core\(\) \{ return Orb\.core; \}/.test(main));
check("map: no renderer for the retired cores (window.JoyaCore) is called", !/window\.JoyaCore\(/.test(map + settings));
check("map: the concept is written back to data-core", /root\.setAttribute\("data-core", core\.S\.concept\)/.test(map));
check("settings: the Account previews save through the same route, CSRF in a header", /fetch\("\/joya-ai\/api\/prefs\/core"/.test(settings) && /"X-CSRF-Token": CSRF/.test(settings));
check("settings: its localStorage write is guarded", settings.split("\n").filter((l) => /localStorage/.test(l)).every((l) => /try \{[^}]*localStorage[^}]*\} catch/.test(l)));

/* the views */
const views = require(path.join(ROOT, "lib", "views-joyaai.js"));
const rbac = require(path.join(ROOT, "lib", "rbac.js"));
const admin = rbac.actor({ permissions: ["*"] });
const pageFor = (core) => views.page({ csrf: "t", user: { name: "a", perm: admin }, core, voice: { configured: true, voice: "marin", manage: true } });
check("view: the saved core is on #cc before first paint", /<div class="cc-shell" id="cc"\s+data-core="E"/.test(pageFor("E")) && /<div class="cc-shell" id="cc"\s+data-core="E"/.test(pageFor("B")));
check("view: never chosen renders D", /id="cc"\s+data-core="D"/.test(pageFor(undefined)) && /id="cc"\s+data-core="D"/.test(pageFor("")));
check("view: a bad stored value cannot reach the markup", /id="cc"\s+data-core="D"/.test(pageFor('"><script>')) && !/"><script>/.test(pageFor('"><script>')));
check("view: the page loads joya-core-d.js and joya-core-bot.js before cc-map.js", (read("lib/views-joyaai.js").match(/"joya-core-d\.js", "joya-core-bot\.js", "cc-family\.js", "cc-map\.js"/g) || []).length === 2);
check("view: no brand spark (it was concept C's)", !/id="cc-spark"/.test(pageFor("E")) && !/data-core="C"/.test(read("public/joya-ai.css")));
check("view: the Everything sheet no longer carries a core switch (Settings and the voice menu do)", !/data-core-set=/.test(pageFor("E")) && /data-core-set=/.test(main));
check("appearance: the old Account card (views.appearance) is gone", views.appearance === undefined);
check("appearance: the assets list the two renderers", views.APPEARANCE_ASSETS.join(" ") === "joya-settings.css cc-logic.js joya-core-d.js joya-core-bot.js joya-settings.js");

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
const coreOn = (html) => (/<div class="cc-shell" id="cc"\s+data-core="([^"]*)"/.exec(html) || [])[1];
const csrfOf = (html) => (/data-csrf="([^"]+)"/.exec(html) || /name="_csrf" value="([^"]+)"/.exec(html) || [])[1];

(async () => {
  const a1 = await makeUser("coreadmin", "administrator");
  const a2 = await makeUser("coreadmin2", "administrator");
  const vw = await makeUser("coreviewer", "viewer");
  // A database from before core D: choices already made (A, never chosen, B) and no migration record yet.
  {
    const db0 = require(path.join(ROOT, "lib", "db.js"));
    const raw = new (require("better-sqlite3"))(path.join(DATA, "joya.db"));
    raw.prepare("UPDATE users SET joya_core = 'A' WHERE username = 'coreadmin'").run();
    raw.prepare("UPDATE users SET joya_core = 'B' WHERE username = 'coreviewer'").run();
    raw.prepare("DELETE FROM settings WHERE key = 'migration.joya_core_d'").run();
    raw.close();
    void db0;
  }
  const child = spawn(process.execPath, [path.join(ROOT, "server.js")], {
    env: Object.assign({}, process.env, { JOYA_PORT: String(PORT), JOYA_BIND: "127.0.0.1", JOYA_AI_SOCKET: path.join(DATA, "no-such.sock"), NODE_ENV: "production" }),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  child.stdout.on("data", (d) => (out += d));
  child.stderr.on("data", (d) => (out += d));
  const done = () => { child.kill(); fs.rmSync(DATA, { recursive: true, force: true }); };
  try {
    for (let i = 0; i < 60 && !/listening/.test(out); i++) await new Promise((r) => setTimeout(r, 200));
    if (!/listening/.test(out)) throw new Error("server did not start: " + out);
    const A1 = await signIn("coreadmin", a1.pw, a1.secret);
    const A2 = await signIn("coreadmin2", a2.pw, a2.secret);
    const V = await signIn("coreviewer", vw.pw, vw.secret);

    const dbm = require(path.join(ROOT, "lib", "db.js"));
    const mig = dbm.recentLogins(50).filter((x) => x.outcome === "account" && /\(new default, migration\)/.test(x.detail || ""));
    check("migration: every existing account moved to D at start (A, never chosen, B)", ["coreadmin", "coreadmin2", "coreviewer"].every((u) => dbm.getUserByName(u).joya_core === "D"), ["coreadmin", "coreadmin2", "coreviewer"].map((u) => dbm.getUserByName(u).joya_core).join(","));
    check("migration: one audit line per account, naming what it was", mig.length === 3 && mig.some((x) => x.username === "coreadmin" && /JOYA AI core A -> D \(Mesh\)/.test(x.detail)) && mig.some((x) => x.username === "coreadmin2" && /JOYA AI core C -> D/.test(x.detail)) && mig.some((x) => x.username === "coreviewer" && /JOYA AI core B -> D/.test(x.detail)), JSON.stringify(mig));
    const rec = dbm.getSetting("migration.joya_core_d", null);
    check("migration: recorded in settings (how many, when)", !!rec && JSON.parse(rec).moved === 3, rec);
    let r = await req("GET", "/joya-ai", { cookie: A1.cookie });
    check("after it: the page is served with core D (pre-paint data-core)", r.status === 200 && coreOn(r.body) === "D", r.status + " " + coreOn(r.body));
    check("…and loads the mesh renderer", /joya-core-d\.js\?v=/.test(r.body));
    const tok = csrfOf(r.body);
    const post = (who, body, token) => req("POST", "/joya-ai/api/prefs/core", { cookie: who.cookie, headers: Object.assign({ Accept: "application/json" }, token ? { "X-CSRF-Token": token } : {}), body });

    r = await post(A1, { core: "E" });
    check("quick switch without the CSRF token: refused (403)", r.status === 403, r.status);
    r = await post(A1, { core: "F" }, tok);
    check("quick switch to an unknown core: refused (400)", r.status === 400 && /D \(Mesh\) or E \(Bot\)/.test(r.body), r.status + " " + r.body);
    r = await post(A1, { core: "A" }, tok);
    check("quick switch to a retired core (A): refused (400)", r.status === 400, r.status);
    r = await post(A1, { core: "e" }, tok);
    check("only the capital letter is a core", r.status === 400, r.status);
    r = await post(A1, { core: "E" }, tok);
    check("quick switch to E: saved", r.status === 200 && JSON.parse(r.body).core === "E" && JSON.parse(r.body).name === "Bot", r.status + " " + r.body);
    r = await req("GET", "/joya-ai", { cookie: A1.cookie });
    check("the next page load is drawn as E from its first paint (data-core in the HTML)", coreOn(r.body) === "E", coreOn(r.body));
    r = await req("GET", "/joya-ai", { cookie: A2.cookie });
    check("per person: another administrator still has D", coreOn(r.body) === "D", coreOn(r.body));

    const db = require(path.join(ROOT, "lib", "db.js"));
    const rows = db.recentLogins(50).filter((x) => x.outcome === "account" && /JOYA AI core/.test(x.detail || "") && !/migration/.test(x.detail));
    check("audited: one line per change, who and what", rows.length === 1 && rows[0].username === "coreadmin" && /JOYA AI core D -> E \(Bot\)/.test(rows[0].detail), JSON.stringify(rows));
    check("stored on the user row", db.getUserByName("coreadmin").joya_core === "E" && db.getUserByName("coreadmin2").joya_core === "D");
    // The D migration never runs again: a fresh start (db.js loaded in a new process) leaves the switch to E alone.
    require("child_process").execFileSync(process.execPath, ["-e", "require(" + JSON.stringify(path.join(ROOT, "lib", "db.js")) + ")"], { env: process.env });
    check("migration to D: never re-runs (a restart keeps the switch to E)", db.getUserByName("coreadmin").joya_core === "E" && db.recentLogins(80).filter((x) => /\(new default, migration\)/.test(x.detail || "")).length === 3);
    // The retired cores: an account still on A, B or C (stored before 2026-10-25) is moved to E at the next start.
    {
      const raw = new (require("better-sqlite3"))(path.join(DATA, "joya.db"));
      raw.prepare("UPDATE users SET joya_core = 'C' WHERE username = 'coreadmin2'").run();
      raw.prepare("UPDATE users SET joya_core = 'A' WHERE username = 'coreviewer'").run();
      raw.close();
    }
    require("child_process").execFileSync(process.execPath, ["-e", "require(" + JSON.stringify(path.join(ROOT, "lib", "db.js")) + ")"], { env: process.env });
    const abc = db.recentLogins(80).filter((x) => x.outcome === "account" && /retired, migration\)/.test(x.detail || ""));
    check("migration A/B/C -> E: both accounts moved to E at start", db.getUserByName("coreadmin2").joya_core === "E" && db.getUserByName("coreviewer").joya_core === "E" && db.getUserByName("coreadmin").joya_core === "E");
    check("  one audit line per account, naming what it was", abc.length === 2 && abc.some((x) => x.username === "coreadmin2" && /JOYA AI core C -> E \(Bot\) \(core C retired, migration\)/.test(x.detail)) && abc.some((x) => x.username === "coreviewer" && /core A -> E/.test(x.detail)), JSON.stringify(abc));
    const rec2 = dbm.getSetting("migration.joya_core_abc_e", null);
    check("  recorded in settings (how many, when)", !!rec2 && JSON.parse(rec2).moved === 2, rec2);
    require("child_process").execFileSync(process.execPath, ["-e", "require(" + JSON.stringify(path.join(ROOT, "lib", "db.js")) + ")"], { env: process.env });
    check("  a further start finds nobody (idempotent)", db.recentLogins(120).filter((x) => /retired, migration\)/.test(x.detail || "")).length === 2 && JSON.parse(dbm.getSetting("migration.joya_core_abc_e", null)).moved === 2);
    {
      const raw = new (require("better-sqlite3"))(path.join(DATA, "joya.db"));
      raw.prepare("UPDATE users SET joya_core = 'D' WHERE username IN ('coreadmin2', 'coreviewer')").run();
      raw.close();
    }
    r = await post(A1, { core: "D" }, tok);
    check("switch back to D: saved, named Mesh", r.status === 200 && JSON.parse(r.body).core === "D" && JSON.parse(r.body).name === "Mesh", r.body);
    r = await post(A1, { core: "E" }, tok);

    r = await req("GET", "/account", { cookie: A1.cookie });
    check("Account points to JOYA AI ▸ Settings ▸ Appearance (the cores moved there)", r.status === 200 && /id="appearance"/.test(r.body) && /href="\/joya-ai\/settings\/appearance"/.test(r.body) && !/name="core"/.test(r.body), r.status);
    r = await req("GET", "/joya-ai/settings/appearance", { cookie: A1.cookie });
    check("Settings ▸ Appearance shows two cores, the saved one checked", r.status === 200 && /id="a-core"/.test(r.body) && /value="E" checked/.test(r.body) && (r.body.match(/name="core" value="[A-Z]"/g) || []).join() === 'name="core" value="D",name="core" value="E"', r.status);
    check("…and loads the previews' scripts", /joya-core-d\.js\?v=/.test(r.body) && /joya-core-bot\.js\?v=/.test(r.body) && !/joya-core\.js\?v=/.test(r.body) && /joya-settings\.js\?v=/.test(r.body) && /joya-settings\.css\?v=/.test(r.body));
    check("…its no-JavaScript form still posts to /account/appearance", /<form method="post" action="\/account\/appearance"/.test(r.body));
    const accTok = csrfOf(r.body);
    r = await req("POST", "/account/appearance", { cookie: A1.cookie, body: new URLSearchParams({ _csrf: accTok, core: "D" }).toString() });
    check("the no-JavaScript form saves too, and returns to Appearance", r.status === 302 && /^\/joya-ai\/settings\/appearance\?msg=.*#a-core$/.test(r.headers.location), r.status + " " + r.headers.location);
    r = await req("GET", "/joya-ai", { cookie: A1.cookie });
    check("…the page then draws D", coreOn(r.body) === "D", coreOn(r.body));
    r = await req("POST", "/account/appearance", { cookie: A1.cookie, body: new URLSearchParams({ _csrf: accTok, core: "Z" }).toString() });
    check("the form refuses anything but D/E", r.status === 302 && /err=/.test(r.headers.location) && db.getUserByName("coreadmin").joya_core === "D", r.headers.location);
    r = await req("POST", "/account/appearance", { cookie: A1.cookie, body: new URLSearchParams({ _csrf: "wrong", core: "E" }).toString() });
    check("the form needs its CSRF token", r.status === 403 && db.getUserByName("coreadmin").joya_core === "D", r.status);

    r = await req("GET", "/account", { cookie: V.cookie });
    check("a viewer's Account has no Appearance card", r.status === 200 && !/id="appearance"/.test(r.body) && !/joya-settings\.js/.test(r.body), r.status);
    r = await req("GET", "/joya-ai/settings/appearance", { cookie: V.cookie });
    check("a viewer cannot open Settings ▸ Appearance", r.status === 403 || (r.status === 302 && !/settings/.test(r.headers.location || "")), r.status + " " + r.headers.location);
    r = await req("GET", "/joya-ai", { cookie: V.cookie });
    check("a viewer does not get the Command Center", !coreOn(r.body), r.status);
    const vtok = csrfOf((await req("GET", "/account", { cookie: V.cookie })).body);
    r = await post(V, { core: "E" }, vtok);
    check("a viewer cannot set a core (403)", r.status === 403, r.status);
    r = await req("POST", "/account/appearance", { cookie: V.cookie, body: new URLSearchParams({ _csrf: vtok, core: "E" }).toString() });
    check("…through the form either", r.status === 403 && db.getUserByName("coreviewer").joya_core === "D", r.status);
    r = await req("POST", "/joya-ai/api/prefs/core", { headers: { Accept: "application/json" }, body: { core: "E" } });
    check("signed out: 401", r.status === 401, r.status);
  } catch (e) {
    check("the HTTP run completed", false, e.stack + "\n" + out);
  } finally {
    done();
  }
  console.log(`\n${passes} passed, ${failures} failed`);
  process.exit(failures ? 1 : 0);
})();
