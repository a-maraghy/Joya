#!/usr/bin/env node
"use strict";
/**
 * Devices = the browsers signed in to Joya; pairing a laptop for SSH moved
 * to SSH keys ▸ Pair a device.
 *
 *     NODE_PATH=/opt/joya-dashboard/node_modules node dashboard/tools/test-devices.cjs
 *
 * Boots a scratch copy (tools/scratch-server.cjs: helper blocked, temp data
 * dir) and signs in over HTTP. Real sign-ins spend a TOTP step each, so a
 * second real sign-in of the same user waits for the next step (up to 30 s);
 * the other extra sessions are written straight into the scratch copy's own
 * sessions.db, signed with the scratch copy's own throwaway secret.
 */
const scratch = require("./scratch-server.cjs"); // first: sets JOYA_DATA_DIR
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { spawnSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
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

/* ------------------------------------------------------------ UA parser --- */

console.log("user-agent parser (no dependency)");
{
  const { parseUA } = require(path.join(ROOT, "lib", "sessions.js"));
  const cases = [
    ["Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36", "Chrome 141 on Windows", false],
    ["Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36 Edg/140.0.0.0", "Edge 140 on Windows", false],
    ["Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1", "Safari 26 on iPhone · iOS 26", true],
    ["Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36", "Chrome 141 on macOS", false],
    ["Mozilla/5.0 (X11; Linux x86_64; rv:130.0) Gecko/20100101 Firefox/130.0", "Firefox 130 on Linux", false],
    ["Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36", "Chrome 141 on Android 14", true],
    ["Mozilla/5.0 (Linux; Android 13; SM-S911B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/25.0 Chrome/121.0.0.0 Mobile Safari/537.36", "Samsung Internet 25 on Android 13", true],
    ["Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/141.0 Mobile/15E148 Safari/604.1", "Chrome 141 on iPhone · iOS 18", true],
    ["Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 OPR/125.0.0.0", "Opera 125 on Windows", false],
    ["Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.2 Safari/605.1.15", "Safari 18 on macOS", false],
    ["", "Unknown browser", false],
    ["something odd/1.0", "Unknown browser", false],
  ];
  for (const [ua, want, mobile] of cases) {
    const got = parseUA(ua);
    check(`"${want}"${mobile ? " (mobile)" : ""}`, got.label === want && got.mobile === mobile, JSON.stringify(got));
  }
}

/* ------------------------------------------------------------ migration --- */

console.log("\nrbac: devices.view / devices.manage renamed to keys.pair");
{
  const rbac = require(path.join(ROOT, "lib", "rbac.js"));
  check("keys.pair exists, devices.* do not", rbac.PERMISSION_SET.has("keys.pair") && !rbac.PERMISSION_SET.has("devices.view") && !rbac.PERMISSION_SET.has("devices.manage"));
  check("keys.pair is labelled for pairing and implies keys.view", /Pair a device/.test(rbac.PERMISSION_LABEL["keys.pair"] || "") && rbac.closure(["keys.pair"]).join() === "keys.pair,keys.view");
  check("administrator (wildcard) holds keys.pair", rbac.actor({ permissions: ["*"] }).can("keys.pair"));

  // A throwaway data dir: lib/db.js creates the schema, the test plants a role
  // that still names the old permissions, and the next start rewrites it.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "devmig-"));
  const boot = () =>
    spawnSync(process.execPath, ["-e", `require(${JSON.stringify(path.join(ROOT, "lib", "db.js"))})`], {
      env: Object.assign({}, process.env, { JOYA_DATA_DIR: dir }),
      encoding: "utf8",
    });
  const b1 = boot();
  check("first start creates the schema", b1.status === 0, b1.stderr);
  const Database = require("better-sqlite3");
  const raw = new Database(path.join(dir, "joya.db"));
  raw.prepare("INSERT INTO roles (name, label, permissions, created_at) VALUES (?, ?, ?, ?)").run("pairer", "Pairer", JSON.stringify(["agents.view", "devices.manage", "devices.view", "some.future.perm"]), new Date().toISOString());
  raw.prepare("INSERT INTO roles (name, label, permissions, created_at) VALUES (?, ?, ?, ?)").run("viewonly", "View only", JSON.stringify(["devices.view"]), new Date().toISOString());
  raw.close();
  boot();
  const read = (name) => {
    const d = new Database(path.join(dir, "joya.db"), { readonly: true });
    const r = d.prepare("SELECT permissions FROM roles WHERE name = ?").get(name);
    d.close();
    return JSON.parse(r.permissions);
  };
  const p1 = read("pairer");
  check("a custom role's devices.* become keys.pair (+ keys.view)", p1.includes("keys.pair") && p1.includes("keys.view") && !p1.some((p) => p.startsWith("devices.")), p1.join());
  check("  nothing else is dropped, not even a key this build does not know", p1.includes("agents.view") && p1.includes("some.future.perm"), p1.join());
  const v1 = read("viewonly");
  check("  devices.view alone also becomes keys.pair", v1.join() === "keys.pair,keys.view", v1.join());
  const admin = read("administrator");
  check("  administrator stays the wildcard", admin.join() === "*", admin.join());
  boot();
  check("idempotent: a second start changes nothing", JSON.stringify(read("pairer")) === JSON.stringify(p1) && JSON.stringify(read("viewonly")) === JSON.stringify(v1));
  fs.rmSync(dir, { recursive: true, force: true });
}

/* ----------------------------------------------------------- the server --- */

const UA_WIN = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";
const UA_MAC = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.2 Safari/605.1.15";
const UA_PHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1";

(async () => {
  const s = await scratch.startScratch({
    fakeKeys: {
      ubuntu: [{ comment: "home desktop", type: "ssh-ed25519", fingerprint: "SHA256:homedesktopfakefingerprint000000000000000" }],
      root: [{ comment: "laptop A", type: "ssh-ed25519", fingerprint: "SHA256:laptopafakefingerprint00000000000000000000" }],
    },
  });
  try {
    const db = require(path.join(ROOT, "lib", "db.js")); // same scratch data dir as the server
    const { authenticator } = require("otplib");
    const users = {};
    users.admin1 = await s.makeUser("admin1", "administrator");
    users.bob = await s.makeUser("bob", "viewer");
    users.carol = await s.makeUser("carol", "userman", ["users.view", "users.manage", "roles.view", "os.view"]);
    const idOf = (u) => db.getUserByName(u).id;

    const cookieOf = (res, prev) => {
      const set = res.headers["set-cookie"];
      return set ? set.map((c) => c.split(";")[0]).join("; ") : prev;
    };
    // A real sign-in with a chosen user agent. A step already spent by this
    // user is waited out (codes are single-use per step).
    const spent = {};
    async function signIn(username, ua) {
      const step = () => Math.floor(Date.now() / 30000);
      while (spent[username] === step()) await new Promise((r) => setTimeout(r, 500));
      const h = { "User-Agent": ua };
      const g = await s.req("GET", "/login", { headers: h });
      let cookie = cookieOf(g);
      const csrf = (g.body.match(/name="_csrf" value="([^"]+)"/) || [])[1];
      const form = new URLSearchParams({ _csrf: csrf, username, password: users[username].pw, token: authenticator.generate(users[username].secret) }).toString();
      spent[username] = step();
      const p = await s.req("POST", "/login", { cookie, body: form, headers: h });
      cookie = cookieOf(p, cookie);
      if (p.status !== 302 || /\/login/.test(p.headers.location || "")) throw new Error("sign-in failed for " + username + ": " + p.status);
      return { cookie, ua };
    }
    const get = (who, p) => s.req("GET", p, { cookie: who.cookie, headers: { "User-Agent": who.ua || UA_WIN } });
    const post = async (who, p, fields, csrfFrom) => {
      const page = await get(who, csrfFrom || "/devices");
      const csrf = s.csrfOf(page.body);
      return s.req("POST", p, { cookie: who.cookie, headers: { "User-Agent": who.ua || UA_WIN }, body: new URLSearchParams(Object.assign({ _csrf: csrf }, fields || {})).toString() });
    };
    const alive = async (who) => {
      const r = await get(who, "/devices");
      return r.status === 200;
    };
    const rowsOf = (html) => {
      const out = [];
      const re = /<tr( class="me")?>\s*<td class="first" data-h="Device">([\s\S]*?)<\/tr>/g;
      let m;
      while ((m = re.exec(html))) {
        const b = m[2];
        out.push({
          me: !!m[1],
          label: ((b.match(/<b class="ink">([^<]*)<\/b>/) || [])[1] || "").replace(/&amp;/g, "&"),
          action: (b.match(/action="\/devices\/([0-9a-f]+)\/signout"/) || [])[1] || null,
          body: b,
        });
      }
      return out;
    };

    // Extra sessions, written the way connect-sqlite3 writes them and signed
    // like express-session signs them -- with the scratch copy's own secret.
    const secret = fs.readFileSync(path.join(s.data, "session.secret"), "utf8").trim();
    const Database = require("better-sqlite3");
    const sdb = new Database(path.join(s.data, "sessions.db"));
    function plant(userId, username, sess, lastUseMsAgo) {
      const sid = crypto.randomBytes(24).toString("base64url");
      const maxAge = 8 * 3600 * 1000;
      const expired = Date.now() - lastUseMsAgo + maxAge;
      const full = Object.assign({ cookie: { originalMaxAge: maxAge, expires: new Date(expired).toISOString(), secure: true, httpOnly: true, path: "/", sameSite: "strict" }, csrf: crypto.randomBytes(24).toString("hex"), authed: true, userId, username }, sess);
      sdb.prepare("INSERT INTO sessions (sid, expired, sess) VALUES (?, ?, ?)").run(sid, expired, JSON.stringify(full));
      const signed = "s:" + sid + "." + crypto.createHmac("sha256", secret).update(sid).digest("base64").replace(/=+$/, "");
      return { sid, cookie: "joya.sid=" + encodeURIComponent(signed), ua: UA_WIN };
    }

    console.log("\nsign-in records the browser");
    const a1 = await signIn("admin1", UA_WIN);
    const b1 = await signIn("bob", UA_PHONE);
    const a2 = await signIn("admin1", UA_MAC); // may wait for the next TOTP step
    const stored = sdb.prepare("SELECT sess FROM sessions").all().map((r) => JSON.parse(r.sess)).filter((x) => x.userId === idOf("admin1"));
    check("two sessions of admin1 in the store", stored.length === 2, stored.length);
    check("  each carries device { ua, ip, at } and seenAt", stored.every((x) => x.device && x.device.ua && x.device.ip && x.device.at > 0 && x.seenAt > 0), JSON.stringify(stored.map((x) => x.device)));
    check("  the user agent is capped at 300 characters", stored.every((x) => x.device.ua.length <= 300));

    console.log("\n/devices lists your own browsers");
    let page = await get(a1, "/devices");
    check("GET /devices 200 for an administrator", page.status === 200, page.status);
    let rows = rowsOf(page.body);
    check("two rows for admin1", rows.length === 2, rows.map((r) => r.label).join(" | "));
    check("  Chrome on Windows is marked this device, first", rows[0] && rows[0].me && rows[0].label === "Chrome 141 on Windows" && /this device/.test(rows[0].body) && /you are here/.test(rows[0].body));
    check("  Safari on macOS has a Sign out, the current one does not", rows[1] && rows[1].label === "Safari 18 on macOS" && rows[1].action && !rows[0].action);
    check("  the IP is shown, the place is 'unknown' (no lookup)", /127\.0\.0\.1/.test(rows[1].body) && /place unknown/.test(rows[1].body));
    const sids = sdb.prepare("SELECT sid FROM sessions").all().map((r) => r.sid);
    const cookieVals = [a1.cookie, a2.cookie, b1.cookie].map((c) => decodeURIComponent(c.split("=")[1]));
    const leaks = sids.concat(cookieVals).filter((x) => page.body.includes(x) || page.body.includes(encodeURIComponent(x)));
    check("  no sid and no cookie value anywhere on the page", leaks.length === 0, leaks.length);
    check("  row ids are 12 hex, not a sid", rows[1].action && /^[0-9a-f]{12}$/.test(rows[1].action) && !sids.includes(rows[1].action));
    check("  bob's session is not listed", !/iPhone/.test(page.body));
    check("  the sign-out forms use the Command Center confirm", /data-confirm-dlg="Sign out Safari 18 on macOS\?"/.test(page.body) && /data-confirm-yes="Sign out"/.test(page.body) && /data-confirm-dlg="Sign out 1 other device\?"/.test(page.body));
    check("  the About card points to SSH keys › Pair a device", /href="\/keys#pair"/.test(page.body));
    check("  a table.stack with data-h labels (phones)", /class="rows stack aligned/.test(page.body) && /data-h="Last seen"/.test(page.body));
    const bp = await get(b1, "/devices");
    const brows = rowsOf(bp.body);
    check("a viewer (no permission) sees their own one device", bp.status === 200 && brows.length === 1 && brows[0].me && /iPhone/.test(brows[0].label), brows.map((r) => r.label).join());
    check("  and, without keys.pair, no link to pairing", !/href="\/keys#pair"/.test(bp.body));
    check("  and the sign-out-others button is disabled", /Sign out all other devices/.test(bp.body) && /type="submit" disabled>/.test(bp.body));

    console.log("\npre-change sessions");
    const old = plant(idOf("admin1"), "admin1", {}, 2 * 3600 * 1000);
    page = await get(a1, "/devices");
    rows = rowsOf(page.body);
    const unk = rows.find((r) => r.label === "Unknown browser");
    check("a session without device data is 'Unknown browser'", !!unk, rows.map((r) => r.label).join(" | "));
    check("  signed in 'before …' the time it was last used", unk && /before 20\d\d-\d\d-\d\d \d\d:\d\d/.test(unk.body));
    check("  last seen from expired - maxAge (2 h ago)", unk && /2 h ago/.test(unk.body));
    check("  and the planted session works (the signature is right)", await alive(old));

    console.log("\nsigning out one device");
    const macRow = rows.find((r) => r.label === "Safari 18 on macOS");
    check("the other device works before", await alive(a2));
    let r = await post(a1, "/devices/" + macRow.action + "/signout");
    check("POST /devices/:id/signout redirects with a message", r.status === 302 && /\/devices\?msg=Signed%20out/.test(r.headers.location), r.headers.location);
    check("  that browser's cookie no longer works", !(await alive(a2)));
    const r2 = await get(a2, "/devices");
    check("  it lands on the sign-in page", r2.status === 302 && /\/login/.test(r2.headers.location || ""), r2.headers.location);
    check("  this device still works", await alive(a1));
    const audit = db.recentLogins(50).map((x) => `${x.username} ${x.outcome} ${x.detail}`);
    check("  audited", audit.some((l) => /^admin1 devices signed out Safari 18 on macOS/.test(l)), audit.slice(0, 5).join(" / "));
    r = await post(a1, "/devices/" + macRow.action + "/signout");
    check("  a second try says it is gone", r.status === 302 && /err=/.test(r.headers.location));
    r = await post(a1, "/devices/" + rowsOf((await get(a1, "/devices")).body).find((x) => x.me).action + "/signout");
    check("the current device has no sign-out id at all", r.status === 302 && /err=/.test(r.headers.location));
    // Its real id, reached by computing it: refused as the current device.
    const sessMod = require(path.join(ROOT, "lib", "sessions.js"));
    sessMod.configure({ dataDir: s.data, secret, maxAge: 8 * 3600 * 1000 });
    const a1sid = sdb.prepare("SELECT sid, sess FROM sessions").all().find((x) => { const j = JSON.parse(x.sess); return j.userId === idOf("admin1") && j.device && /Windows/.test(j.device.ua); }).sid;
    r = await post(a1, "/devices/" + sessMod.idOf(a1sid) + "/signout");
    check("  even with its real id, the current session is refused", r.status === 302 && /err=/.test(r.headers.location) && (await alive(a1)), r.headers.location);
    const bobsid = sdb.prepare("SELECT sid, sess FROM sessions").all().find((x) => JSON.parse(x.sess).userId === idOf("bob")).sid;
    r = await post(a1, "/devices/" + sessMod.idOf(bobsid) + "/signout");
    check("someone else's session id is not yours to sign out (even an admin's, here)", r.status === 302 && /err=/.test(r.headers.location) && (await alive(b1)));
    r = await post(b1, "/devices/" + sessMod.idOf(a1sid) + "/signout");
    check("  nor for a viewer", r.status === 302 && /err=/.test(r.headers.location) && (await alive(a1)));
    r = await s.req("POST", "/devices/" + sessMod.idOf(bobsid) + "/signout", { cookie: a1.cookie, body: "_csrf=nope" });
    check("CSRF is required", r.status === 403);

    console.log("\nsign out all other devices");
    const o1 = plant(idOf("admin1"), "admin1", { device: { ua: UA_PHONE, ip: "10.0.0.9", at: Date.now() - 3600e3 }, seenAt: Date.now() - 600e3 }, 600e3);
    const o2 = plant(idOf("admin1"), "admin1", { device: { ua: UA_MAC, ip: "10.0.0.8", at: Date.now() - 7200e3 } }, 60e3);
    check("three other sessions work", (await alive(o1)) && (await alive(o2)) && (await alive(old)));
    page = await get(a1, "/devices");
    check("  listed with their IPs", /10\.0\.0\.9/.test(page.body) && /10\.0\.0\.8/.test(page.body) && /Safari 26 on iPhone · iOS 26/.test(page.body));
    check("  the confirm counts them", /data-confirm-dlg="Sign out 3 other devices\?"/.test(page.body));
    r = await post(a1, "/devices/signout-others");
    check("POST /devices/signout-others", r.status === 302 && /Signed%20out%203%20other%20devices/.test(r.headers.location), r.headers.location);
    check("  all three are signed out", !(await alive(o1)) && !(await alive(o2)) && !(await alive(old)));
    check("  this device is not", await alive(a1));
    check("  bob is not touched", await alive(b1));
    rows = rowsOf((await get(a1, "/devices")).body);
    check("  one row left, this device", rows.length === 1 && rows[0].me);

    console.log("\nan administrator signs out another user (Users ▸ Manage)");
    const b2 = plant(idOf("bob"), "bob", { device: { ua: UA_WIN, ip: "10.0.0.7", at: Date.now() } }, 0);
    const counted = require(path.join(ROOT, "lib", "sessions.js")).sessionsFor(idOf("bob"));
    check("sessionsFor(bob) counts 2, without sids", counted.count === 2 && counted.list.every((d) => /^[0-9a-f]{12}$/.test(d.id) && !JSON.stringify(d).includes(bobsid)), JSON.stringify(counted).slice(0, 200));
    r = await post(b1, "/users/" + idOf("admin1") + "/signout-all", {}, "/devices");
    check("a viewer cannot (no users.manage)", r.status === 403 && (await alive(a1)), r.status);
    const c1 = await signIn("carol", UA_WIN);
    r = await post(c1, "/users/" + idOf("carol") + "/signout-all", {}, "/devices");
    check("users.manage on yourself is refused (use Devices)", r.status === 302 && /err=/.test(r.headers.location) && (await alive(c1)));
    r = await post(c1, "/users/" + idOf("bob") + "/signout-all", {}, "/devices");
    check("users.manage signs out every browser of bob", r.status === 302 && /Signed%20bob%20out%20of%202%20browsers/.test(r.headers.location), r.headers.location);
    check("  both bob sessions are gone", !(await alive(b1)) && !(await alive(b2)));
    check("  carol and admin1 are not touched", (await alive(c1)) && (await alive(a1)));
    const audit2 = db.recentLogins(50).map((x) => `${x.username} ${x.outcome} ${x.detail}`);
    check("  audited as an admin action", audit2.some((l) => /^carol admin signed out 2 browsers of bob/.test(l)), audit2.slice(0, 3).join(" / "));
    r = await post(c1, "/users/" + idOf("bob") + "/signout-all", { back: "detail" }, "/devices");
    check("  back=detail returns to /users/:id; nothing left says so", r.status === 302 && r.headers.location.startsWith("/users/" + idOf("bob") + "?msg=") && /not%20signed%20in/.test(r.headers.location), r.headers.location);
    r = await post(c1, "/users/99999/signout-all", {}, "/devices");
    check("  an unknown user is a 404", r.status === 404);

    console.log("\npairing moved to SSH keys");
    page = await get(a1, "/keys");
    check("GET /keys 200 with the fake keys", page.status === 200 && /home desktop/.test(page.body) && /laptop A/.test(page.body), page.status);
    check("  a 'Pair a device' card with id pair", /<section class="card" id="pair">/.test(page.body) && /Pair a device/.test(page.body) && /action="\/keys\/pair"/.test(page.body));
    check("  keys in one table.stack with User / Fingerprint labels", /class="rows stack aligned"/.test(page.body) && /data-h="Fingerprint"/.test(page.body) && /data-h="User"/.test(page.body));
    check("  Remove goes through the confirm", /data-confirm-dlg="Remove the key “home desktop”\?"/.test(page.body));
    r = await post(a1, "/keys/pair", { label: "new-laptop", target_user: "ubuntu" }, "/keys");
    const code = decodeURIComponent((r.headers.location.match(/code=([^&#]+)/) || [])[1] || "");
    check("POST /keys/pair makes a code and returns to #pair", r.status === 302 && /^[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}$/.test(code) && /#pair$/.test(r.headers.location), r.headers.location);
    page = await get(a1, r.headers.location.replace(/#.*/, ""));
    check("  the code is shown with the /pair URL, and listed with a Revoke", page.body.includes(code) && /\/pair<\/span>/.test(page.body) && /action="\/keys\/pair\/revoke"/.test(page.body));
    check("  a code in the URL that is not a code is not shown", !(await get(a1, "/keys?code=%3Cb%3Ex")).body.includes("&lt;b&gt;x"));
    r = await post(a1, "/keys/pair/revoke", { code }, "/keys");
    check("POST /keys/pair/revoke", r.status === 302 && /revoked/.test(decodeURIComponent(r.headers.location)) && !db.getPairingCode(code));
    let old1 = await s.req("POST", "/devices/code", { cookie: a1.cookie, body: "_csrf=x&label=a" });
    check("old POST /devices/code → 307 /keys/pair", old1.status === 307 && old1.headers.location === "/keys/pair", old1.status + " " + old1.headers.location);
    old1 = await s.req("POST", "/devices/code/revoke", { cookie: a1.cookie, body: "_csrf=x&code=a" });
    check("old POST /devices/code/revoke → 307 /keys/pair/revoke", old1.status === 307 && old1.headers.location === "/keys/pair/revoke");
    const p = await s.req("GET", "/pair");
    check("the public /pair is unchanged (no sign-in needed)", p.status === 200 && /Pairing code/.test(p.body));
    r = await post(c1, "/keys/pair", { label: "x" }, "/devices");
    check("pairing needs keys.pair (carol has not)", r.status === 403, r.status);
    const cp = await get(c1, "/keys");
    check("  nor can she open /keys", cp.status === 403, cp.status);

    console.log("\nthe frame");
    page = await get(a1, "/devices");
    const badge = (page.body.match(/<span class="badge [^"]*" data-badge="devices"[^>]*>[^<]*(?:<span class="sr">[^<]*<\/span>)?<\/span>/) || [""])[0];
    check("the sidebar's Devices item carries the count of your browsers", /badge plain/.test(badge) && />1</.test(badge), badge || page.body.slice(0, 200));
    plant(idOf("admin1"), "admin1", { device: { ua: UA_MAC, ip: "10.0.0.6", at: Date.now() } }, 0);
    await post(a1, "/devices/signout-others"); // a sign-out forgets the cached count
    plant(idOf("admin1"), "admin1", { device: { ua: UA_PHONE, ip: "10.0.0.5", at: Date.now() } }, 0);
    await post(a1, "/keys/pair/revoke", { code: "none" }, "/keys"); // any POST: the listing refreshes on /devices
    page = await get(a1, "/devices");
    const badge2 = (page.body.match(/data-badge="devices"[^>]*>([^<]*)</) || [])[1];
    check("  and follows the listing (2 after another sign-in)", badge2 === "2", badge2);
    sdb.close();
  } catch (e) {
    check("no exception", false, e && e.stack);
    console.log(s.out().slice(-2000));
  } finally {
    s.stop();
  }
  console.log(`\n${passes} passed, ${failures} failed`);
  process.exit(failures ? 1 : 0);
})();
