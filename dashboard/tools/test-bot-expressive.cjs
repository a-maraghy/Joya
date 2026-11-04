#!/usr/bin/env node
"use strict";
/**
 * Core E's design upgrades (2026-10-20): an expressive bot and a team of bots.
 *
 *     NODE_PATH=/opt/joya-dashboard/node_modules PLAYWRIGHT=/path/to/node_modules/playwright \
 *       node dashboard/tools/test-bot-expressive.cjs
 *
 * Pure parts (joya-core-bot.js: the viseme mapping and the mouth shapes, the doze rule and its night
 * window, the face a reaction or dozing shows, the z z z; cc-logic.js: the role -> head rule table, the
 * per-session pins and their check, a long turn finishing), the app-icon generators (the bot set is
 * current and complete, the Mesh set stays the live one, the JOYA_APP_ICON switch), the agents' bot
 * assets, then a scratch copy of the server (POST /joya-ai/api/prefs/bot-team: CSRF, validation, audit,
 * storage, the page carries the pins) and headless Chromium (the mouth from a spectrum, the eyes on the
 * pointer and back, dozing and waking with a fixed clock, the reactions, glances at sessions, still frames,
 * the team's heads handed to the core, the Sessions sheet's picker saving a pin).
 */
const scratch = require("./scratch-server.cjs"); // first: sets JOYA_DATA_DIR
const path = require("path");
const fs = require("fs");
const ROOT = path.join(__dirname, "..");
let passed = 0, failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log("  ok   " + name); }
  else { failed++; console.log("  FAIL " + name + (detail !== undefined ? "\n       " + String(detail).slice(0, 600) : "")); }
}
const section = (t) => console.log("\n" + t);
const read = (f) => fs.readFileSync(path.join(ROOT, f), "utf8");
const L = require(path.join(ROOT, "public", "cc-logic.js"));
const B = require(path.join(ROOT, "public", "joya-core-bot.js"));

(async () => {
  section("visemes: the mouth's shape from the voice spectrum (joya-core-bot.js viseme)");
  const hz = 48000 / 512;
  const spec = (lo, hi, v) => { const b = new Uint8Array(256); for (let i = 0; i < 256; i++) { const f = i * hz; b[i] = f >= lo && f <= hi ? (v || 225) : 40; } return b; };
  const top = (o) => Object.keys(o).sort((a, b) => o[b] - o[a])[0];
  const sum = (o) => o.closed + o.open + o.wide + o.round;
  const lowV = B.viseme(spec(160, 560), hz, 0.7, {}), midV = B.viseme(spec(600, 1800), hz, 0.7, {}), hiV = B.viseme(spec(2000, 7000), hz, 0.7, {});
  check("energy low down (o, u) -> round; in the middle (a) -> open; high up (ee, s) -> wide", top(lowV) === "round" && top(midV) === "open" && top(hiV) === "wide", JSON.stringify({ lowV, midV, hiV }));
  check("silence (nothing above the noise floor) -> closed, whatever the level says", B.viseme(spec(0, 0), hz, 0.7, {}).closed === 1);
  check("a quiet level -> mostly closed even with a spectrum", B.viseme(spec(600, 1800), hz, 0.03, {}).closed > 0.95);
  check("no spectrum (null bins): level only -- closed at rest, open when loud", B.viseme(null, 0, 0, {}).closed === 1 && B.viseme(null, 0, 0.8, {}).open === 1 && B.viseme(null, 0, 0.8, {}).wide === 0 && B.viseme(null, 0, 0.8, {}).round === 0);
  check("the four weights always sum to 1", [lowV, midV, hiV, B.viseme(null, 0, 0.3, {}), B.viseme(spec(300, 3000), hz, 0.4, {})].every((o) => Math.abs(sum(o) - 1) < 1e-9));
  const reuse = { closed: 0, open: 0, wide: 0, round: 0 };
  check("no allocation: it fills the object it is given", B.viseme(spec(160, 560), hz, 0.6, reuse) === reuse);
  const mk = (face) => { const a = new B.Anim(3); a.set(face, "ready"); a.settle(); return a; };
  const V0 = (vm, st, amp) => { const v = new Float32Array(B.FACE.N); B.faceVec(st || "smooth", mk("speak"), 60, 1, amp == null ? 0.5 : amp, vm, v, null, 0); return v; };
  const MOUTH = (v) => [v[12], v[14], v[15]].map((x) => x.toFixed(4)).join(","), EYES = (v) => Array.from(v.slice(0, 12)).map((x) => x.toFixed(4)).join(",");
  B.FACE_STYLES.forEach((st) => {
    const shapes = B.VIS.map((k) => V0(Object.assign({ closed: 0, open: 0, wide: 0, round: 0 }, { [k]: 1 }), st));
    check(st + ": four mouth shapes, each a different mouth (width, opening, curve) on the speak face", new Set(shapes.map(MOUTH)).size === 4, shapes.map(MOUTH).join(" | "));
    check(st + ": the eyes are the same in all four", shapes.every((v) => EYES(v) === EYES(shapes[0])));
    const o = V0({ closed: 0, open: 1, wide: 0, round: 0 }, st), w = V0({ closed: 0, open: 0, wide: 1, round: 0 }, st), r = V0({ closed: 0, open: 0, wide: 0, round: 1 }, st), c = V0({ closed: 1, open: 0, wide: 0, round: 0 }, st);
    check(st + ": ee is the widest, oo the narrowest, open the tallest, closed shut", w[12] > o[12] && r[12] < o[12] && o[14] >= w[14] && c[14] === 0, [c, o, w, r].map(MOUTH).join(" | "));
    const half = V0({ closed: 0.5, open: 0.5, wide: 0, round: 0 }, st);
    check(st + ": between two shapes the mouth is in between (it morphs, no pop)", st === "dots" || (half[14] > c[14] && half[14] < o[14]), MOUTH(half));
  });
  check("sessions (no viseme mix): the mouth opens with the level alone", V0(null, "smooth", 0.9)[14] > V0(null, "smooth", 0)[14]);

  section("moods: dozing");
  const Q = B.DOZE_QUIET_MS, NQ = B.NIGHT_QUIET_MS;
  check("10 minutes of quiet, idle: dozes; 9 minutes: not yet", Q === 600000 && B.dozeWanted({ state: "idle", quietMs: Q, hour: 12 }) && !B.dozeWanted({ state: "idle", quietMs: 9 * 60000, hour: 12 }));
  check("at night (23:00-06:00) a minute of quiet is enough; 30 s is not", NQ === 60000 && B.dozeWanted({ state: "idle", quietMs: NQ, hour: 23 }) && B.dozeWanted({ state: "idle", quietMs: NQ, hour: 2 }) && !B.dozeWanted({ state: "idle", quietMs: 30000, hour: 2 }));
  check("the night window: 23, 0..5 are night; 6 and 22 are not", [23, 0, 3, 5].every((h) => B.isNight(h)) && [6, 12, 22].every((h) => !B.isNight(h)));
  check("never while busy, offline, or with the pointer near", ["thinking", "listening", "speaking", "needs", "delegating"].every((s) => !B.dozeWanted({ state: s, quietMs: Q * 3, hour: 2 })) && !B.dozeWanted({ state: "idle", offline: true, quietMs: Q * 3, hour: 12 }) && !B.dozeWanted({ state: "idle", near: true, quietMs: Q * 3, hour: 12 }));
  check("the sleep face, every style: shut eyes as arcs curving down; a blink changes nothing while asleep", B.FACE_STYLES.every((st) => { const v = new Float32Array(B.FACE.N), w = new Float32Array(B.FACE.N), a = mk("sleep"), b = mk("sleep"); b.blinkP = 0.5; B.faceVec(st, a, 60, 1, 0, null, v, null, 0); B.faceVec(st, b, 60, 1, 0, null, w, null, 0); return v[8] === 1 && v[9] < 0 && Array.from(v).join() === Array.from(w).join(); }));
  check("dozing face: idle and deep enough (> 0.65) -> sleep; awake or busy -> the state's face", B.pickFace("idle", false, "", 0.8).face === "sleep" && B.pickFace("idle", false, "", 0.5).face === "base" && B.pickFace("thinking", false, "", 0.9).face === "focus" && B.pickFace("idle", false, "wake", 0.9).face === "base");
  const z0 = B.zDot(0, 0, [0, 0, 0, 0]).slice(), zA = B.zDot(0, 1.2, [0, 0, 0, 0]).slice();
  check("the z z z: 30 dots (three z's of ten), rising (y grows) and fading in and out", B.ZN === 30 && zA[1] > z0[1] && z0[3] < 0.01 && zA[3] > 0.5);
  check("the z's rise on the head's left (clear of the cap's antenna and brim)", Array.from({ length: 30 }, (_, i) => B.zDot(i, 1.7, [0, 0, 0, 0])[0]).every((x) => x < -0.8));

  section("reactions");
  check("five reactions with their lengths: surprise 0.9 s, grin 1.6 s, nod 0.9 s, wake 0.6 s, shake 0.8 s (a voice not recognised)", JSON.stringify(B.REACT) === JSON.stringify({ surprise: 0.9, grin: 1.6, nod: 0.9, wake: 0.6, shake: 0.8 }));
  check("surprise shows wide eyes over any state (going offline: then the x x)", B.pickFace("idle", true, "surprise", 0).face === "listen" && B.pickFace("idle", true, "surprise", 0).state === "error" && B.pickFace("idle", true, "", 0).face === "err");
  check("grin: the grin in the ready colour while idle or speaking; not over thinking or needs-you", B.pickFace("idle", false, "grin", 0).face === "grin" && B.pickFace("idle", false, "grin", 0).state === "ready" && B.pickFace("speaking", false, "grin", 0).face === "grin" && B.pickFace("thinking", false, "grin", 0).face === "focus" && B.pickFace("needs", false, "grin", 0).face === "pupils");
  check("nod: motion only (the face stays)", B.pickFace("idle", false, "nod", 0).face === "base");
  check("a long turn finishing (20 s or more of thinking / delegating / speaking, then idle) is a grin; a short one is not", L.BOT_LONG_TURN_MS === 20000 && L.botTurnDone("thinking", "idle", 25000) && L.botTurnDone("speaking", "idle", 20000) && !L.botTurnDone("thinking", "idle", 5000) && !L.botTurnDone("idle", "thinking", 60000) && !L.botTurnDone("thinking", "needs", 60000));
  const src = read("public/joya-core-bot.js");
  check("the renderer: still CSP-safe (no eval, no inline style, no URL), the new API (poke, react, glance, look), listeners removed on destroy", !/\beval\(|new Function|\.style\.|setAttribute\("style"|https?:\/\//.test(src.replace(/\/\*[\s\S]*?\*\//g, "")) && ["poke", "react", "glance", "look"].every((m) => new RegExp("\\b" + m + ": ").test(src)) && /removeEventListener\("pointermove", onPtr\)/.test(src) && /clearInterval\(stillTimer\)/.test(src));
  check("no per-frame allocation for the new parts: the viseme target and the z dot are reused objects", /var VT = \{ closed: 1, open: 0, wide: 0, round: 0 \}/.test(src) && /var ZP = \[0, 0, 0, 0\]/.test(src) && /viseme\(sp \? sp\.bins : null, sp \? sp\.hz : 0, S\.amp, VT\)/.test(src));

  section("the team: role -> head (cc-logic.js)");
  const R = (s) => L.botRole(s).head;
  check("the rule table: hired, planning, erp, builder, then everyone else", JSON.stringify(L.BOT_ROLE_RULES.map((r) => r.role + ":" + r.head)) === JSON.stringify(["hired:cap", "planning:mortar", "erp:headset", "builder:antennas"]) && L.BOT_ROLE_DEFAULT.head === "headphones");
  check("Odoo / ERP sessions -> headset & mic (by name or cwd)", R({ name: "Odoo dev" }) === "headset" && R({ name: "x", cwd: "/opt/odoo/custom" }) === "headset" && R({ name: "ERP fixes" }) === "headset" && R({ name: "s", cwd: "/root/joya/gizaseeds-Odoo19" }) === "headset");
  check("planning -> graduation cap (and it wins over giza: the planning engine)", R({ name: "Planning engine", cwd: "/root/joya/giza-planning-engine" }) === "mortar" && R({ name: "x", cwd: "/root/joya/giza-planning-engine" }) === "mortar" && R({ name: "Allocation review" }) === "mortar");
  check("hired sessions -> cap & headphones, whatever their name", R({ name: "Odoo dev", hired: true }) === "cap" && R({ name: "x", hire: { slug: "a" } }) === "cap");
  check("Joya / builder -> twin antennas", R({ name: "Joya" }) === "antennas" && R({ name: "s", cwd: "/root/joya/Joya/.claude/worktrees/agent-x" }) === "antennas" && R({ name: "desktop app" }) === "antennas" && R({ name: "s", cwd: "/root/joya/Claude_Agents" }) === "antennas");
  check("anything else -> headphones (no accidental matches: 'explanation', 'erpx', 'joya')", R({ name: "Freight quotes", cwd: "/root/work" }) === "headphones" && R({ name: "explanation" }) === "headphones" && R({ name: "erpx" }) === "headphones" && R({}) === "headphones");
  const team = { "invoice audit": "halo" };
  const hf = L.botHeadFor({ name: "Invoice  Audit", cwd: "/root" }, team);
  check("a pin wins over the role (name matched normalised: case, spaces); the role's head is still known", hf.head === "halo" && hf.pinned && hf.auto === "headphones" && hf.role === "other");
  check("no pin: the role's head", L.botHeadFor({ name: "Odoo dev" }, team).head === "headset" && !L.botHeadFor({ name: "Odoo dev" }, team).pinned);
  check("stored pins are cleaned: not JSON, an array, unknown heads, hostile keys -> dropped", JSON.stringify(L.normBotTeam("{oops")) === "{}" && JSON.stringify(L.normBotTeam("[1]")) === "{}" && JSON.stringify(L.normBotTeam({ a: "robot", B: "halo" })) === '{"b":"halo"}' && L.botTeamJson('{"</script>":"cap"}') === '{"</script>":"cap"}' && Object.keys(L.normBotTeam(Object.fromEntries(Array.from({ length: 80 }, (_, i) => ["s" + i, "cap"])))).length === 64);
  const ck = (b) => L.checkBotTeamEdit(b);
  check("the API's check: a name (1-120) and one of the ten heads, or empty / null / auto to unpin", ck({ name: "Odoo dev", head: "halo" }).ok && ck({ name: "Odoo dev", head: "halo" }).key === "odoo dev" && ck({ name: "x", head: "" }).head === null && ck({ name: "x", head: null }).head === null && ck({ name: "x", head: "auto" }).head === null);
  check("…refuses no name, a long name, a non-string, an unknown head, an array body", !ck({ head: "halo" }).ok && !ck({ name: "", head: "halo" }).ok && !ck({ name: "x".repeat(121), head: "halo" }).ok && !ck({ name: 5, head: "halo" }).ok && !ck({ name: "x", head: "robot" }).ok && !ck([1]).ok && !ck(null).ok);
  const full = Object.fromEntries(Array.from({ length: 64 }, (_, i) => ["s" + i, "cap"]));
  check("pins: an edit sets or removes one; a 65th is refused (changing one of the 64 is fine)", L.applyBotTeamEdit({}, "a", "halo").team.a === "halo" && !("a" in L.applyBotTeamEdit({ a: "halo" }, "a", null).team) && !L.applyBotTeamEdit(full, "new", "cap").ok && L.applyBotTeamEdit(full, "s3", "halo").ok);

  section("the app icon: the bot with the cap (tools/make-bot-icon.cjs), on with JOYA_APP_ICON=bot");
  const BI = require("./make-bot-icon.cjs");
  const bf = BI.files("cap");
  check("the bot SVGs in public/brand/bot/ are current (regenerate with make-bot-icon.cjs)", Object.keys(bf).every((n) => fs.existsSync(path.join(ROOT, "public", "brand", "bot", n)) && fs.readFileSync(path.join(ROOT, "public", "brand", "bot", n), "utf8") === bf[n]), Object.keys(bf).filter((n) => !fs.existsSync(path.join(ROOT, "public", "brand", "bot", n)) || fs.readFileSync(path.join(ROOT, "public", "brand", "bot", n), "utf8") !== bf[n]).join(","));
  const MESH = require("./make-app-icon.cjs");
  const sz = (f) => MESH.pngSize(fs.readFileSync(path.join(ROOT, "public", "brand", "bot", f)));
  check("the same set as Mesh: 16 / 32 / any SVG, .ico (16, 32, 48), 180 / 192 / 512 / maskable 512 PNGs", BI.OUT_FILES.length === 8 && BI.OUT_FILES.every((f) => fs.existsSync(path.join(ROOT, "public", "brand", "bot", f))) && sz("app-icon-180.png").w === 180 && sz("app-icon-192.png").w === 192 && sz("app-icon-512.png").h === 512 && sz("app-icon-maskable-512.png").w === 512 && JSON.stringify(MESH.readIco(fs.readFileSync(path.join(ROOT, "public", "brand", "bot", "favicon.ico"))).map((e) => e.size + ":" + e.png.w)) === '["16:16","32:32","48:48"]');
  check("the bot SVGs: deterministic, no script, no external reference, a small favicon (< 64 KB: the cap head is a denser wireframe, 46 KB)", JSON.stringify(BI.files("cap")) === JSON.stringify(bf) && JSON.stringify(BI.files()) === JSON.stringify(bf) && Object.values(bf).every((t) => !/<script|href="http|xlink:href="http/.test(t)) && bf["favicon.svg"].length < 64 * 1024);
  check("the drawing comes from the renderer's geometry (each head draws) and a different head is a different icon", ["cap", "headphones", "headset", "mortar", "antennas"].every((h) => BI.full({ head: h, lite: true }).length > 2000) && BI.files("antennas")["favicon.svg"] !== bf["favicon.svg"]);
  const ui = require(path.join(ROOT, "lib", "ui.js"));
  const was = process.env.JOYA_APP_ICON;
  delete process.env.JOYA_APP_ICON;
  const meshLinks = ui.iconLinks();
  process.env.JOYA_APP_ICON = "bot";
  const botLinks = ui.iconLinks(), botIco = ui.appIcons().ico;
  process.env.JOYA_APP_ICON = "nonsense";
  const odd = ui.appIconSet();
  if (was === undefined) delete process.env.JOYA_APP_ICON; else process.env.JOYA_APP_ICON = was;
  // Since 2026-10-25 the tab icon is the M monogram whatever the set; the switch picks the app icon (apple-touch, manifest).
  check("the switch: the tab is the M monogram either way; JOYA_APP_ICON=bot -> the bot app icon; unset or anything else -> Mesh", /\/static\/brand\/m\/favicon-16\.svg\?v=/.test(meshLinks) && /\/static\/brand\/m\/favicon-16\.svg\?v=/.test(botLinks) && !/brand\/bot\//.test(meshLinks) && /apple-touch-icon" href="\/static\/brand\/bot\/app-icon-180\.png/.test(botLinks) && botIco === "brand/m/favicon.ico" && odd === "mesh");
  check("the root /favicon.ico follows the switch too", /ui\.appIcons\(\)\.ico/.test(read("server.js")));

  section("the agents' bot (tools/make-agent-bots.cjs -> docs/agent-bots/)");
  const AG = path.join(ROOT, "..", "docs", "agent-bots");
  const man = fs.existsSync(path.join(AG, "manifest.json")) ? JSON.parse(fs.readFileSync(path.join(AG, "manifest.json"), "utf8")) : null;
  check("an avatar and three stickers (ready, thinking, done) for every role and the core", man && JSON.stringify(man.roles.map((r) => r.role)) === JSON.stringify(["hired", "planning", "erp", "builder", "other", "core"]) && man.roles.every((r) => ["avatar-" + r.role + ".png", "sticker-" + r.role + "-ready.webm", "sticker-" + r.role + "-thinking.webm", "sticker-" + r.role + "-done.webm"].every((f) => fs.existsSync(path.join(AG, f)))), man && JSON.stringify(man.roles));
  const webms = man ? man.roles.flatMap((r) => r.files.filter((f) => /\.webm$/.test(f))) : [];
  check("the stickers fit Telegram's video-sticker limit (<= 256 KB, WebM)", webms.length === 18 && webms.every((f) => { const b = fs.readFileSync(path.join(AG, f)); return b.length <= 256 * 1024 && b.readUInt32BE(0) === 0x1a45dfa3; }));
  check("avatars are 640 x 640 PNGs; the README says how to apply them (and that nothing is sent)", man && man.roles.every((r) => { const s = MESH.pngSize(fs.readFileSync(path.join(AG, "avatar-" + r.role + ".png"))); return s && s.w === 640 && s.h === 640; }) && /BotFather/.test(fs.readFileSync(path.join(AG, "README.md"), "utf8")) && /nothing.*sent|not sent|sends nothing/i.test(fs.readFileSync(path.join(AG, "README.md"), "utf8")));

  /* ------------------------------------------------------------- over HTTP --- */
  section("over HTTP (a scratch copy)");
  const s = await scratch.startScratch({});
  const db = require(path.join(ROOT, "lib", "db.js"));
  let browser = null;
  try {
    await s.makeUser("teamadmin", "administrator");
    await s.makeUser("teamviewer", "viewer");
    const A = await s.signIn("teamadmin");
    const V = await s.signIn("teamviewer");
    let r = await s.req("GET", "/joya-ai", { cookie: A.cookie });
    const tok = s.csrfOf(r.body);
    check("never pinned: the page carries an empty team", /data-bot-team="\{\}"/.test(r.body));
    const post = (who, body, token) => s.req("POST", "/joya-ai/api/prefs/bot-team", { cookie: who.cookie, headers: Object.assign({ Accept: "application/json" }, token ? { "X-CSRF-Token": token } : {}), body });
    r = await post(A, { name: "Odoo dev", head: "halo" });
    check("without the CSRF token: refused (403)", r.status === 403, r.status);
    r = await post(A, { name: "Odoo dev", head: "robot" }, tok);
    check("an unknown head: refused (400), nothing saved", r.status === 400 && /The head must be one of/.test(r.body) && db.getUserByName("teamadmin").joya_bot_team === "", r.status + " " + r.body);
    r = await post(A, { head: "halo" }, tok);
    check("no session name: refused (400)", r.status === 400, r.status);
    r = await post(A, { name: "Odoo Dev", head: "halo" }, tok);
    check("a pin: saved under the normalised name", r.status === 200 && JSON.parse(r.body).key === "odoo dev" && db.getUserByName("teamadmin").joya_bot_team === '{"odoo dev":"halo"}', r.body);
    r = await post(A, { name: "Invoice audit", head: "bowtie" }, tok);
    r = await post(A, { name: "odoo dev", head: "" }, tok);
    check("empty head: the pin removed (back to the role's), the others kept", r.status === 200 && db.getUserByName("teamadmin").joya_bot_team === '{"invoice audit":"bowtie"}' && JSON.stringify(JSON.parse(r.body).team) === '{"invoice audit":"bowtie"}', r.body);
    const rows = db.recentLogins(50).filter((x) => x.outcome === "account" && /JOYA AI bot head for/.test(x.detail || ""));
    check("audited: which session, from what to what", rows.some((x) => x.username === "teamadmin" && /JOYA AI bot head for "odoo dev" auto -> halo/.test(x.detail)) && rows.some((x) => /"odoo dev" halo -> auto/.test(x.detail)), JSON.stringify(rows.map((x) => x.detail)));
    const vt = s.csrfOf((await s.req("GET", "/account", { cookie: V.cookie })).body);
    r = await post(V, { name: "x", head: "halo" }, vt);
    check("a viewer cannot pin (403)", r.status === 403 && db.getUserByName("teamviewer").joya_bot_team === "", r.status);
    r = await s.req("POST", "/joya-ai/api/prefs/bot-team", { headers: { Accept: "application/json" }, body: { name: "x", head: "halo" } });
    check("signed out: 401", r.status === 401, r.status);
    db.setUserJoyaCore(db.getUserByName("teamadmin").id, "E");
    r = await s.req("GET", "/joya-ai", { cookie: A.cookie });
    check("the page carries the pins (escaped) on #cc", /data-bot-team="\{&quot;invoice audit&quot;:&quot;bowtie&quot;\}"/.test(r.body));

    /* ------------------------------------------------------------- in the browser --- */
    let chromium = null;
    try { chromium = require(process.env.PLAYWRIGHT || "playwright").chromium; } catch (e) { chromium = null; }
    if (!chromium) { console.log("\n(browser part skipped: set PLAYWRIGHT=/path/to/node_modules/playwright)"); }
    else {
      section("in the browser");
      browser = await chromium.launch({ args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
      const errs = [];
      async function open(theme, opt) {
        const ctx = await browser.newContext(Object.assign({ viewport: { width: 1440, height: 900 }, colorScheme: theme, extraHTTPHeaders: { "X-Forwarded-Proto": "https" } }, opt || {}));
        await ctx.addCookies(String(A.cookie).split("; ").filter(Boolean).map((kv) => ({ name: kv.split("=")[0], value: kv.slice(kv.indexOf("=") + 1), url: "http://127.0.0.1:" + s.port })));
        const page = await ctx.newPage();
        page.on("pageerror", (e) => errs.push(theme + ": " + e.message));
        page.on("console", (m) => { const t = m.text(); if ((m.type() === "error" && !/Failed to load resource|net::ERR|503|502|EventSource/.test(t)) || /Content Security Policy|Refused to/.test(t)) errs.push(theme + ": " + t); });
        await page.goto("http://127.0.0.1:" + s.port + "/joya-ai", { waitUntil: "load" });
        await page.waitForFunction(() => window.__joyaCC && window.__joyaCC.core && window.__joyaCC.core.S.concept === "E", null, { timeout: 15000 });
        await page.evaluate(() => {
          const O = window.__joyaCC.orbit; document.getElementById("cc-offline").hidden = true;
          O._s = O.setState; O.setState = function () {}; O.setOffline = function () {};
          window.__joyaCC.core.setOffline(false); window.__joyaCC.core.S.rk = "";
        });
        return { ctx, page };
      }
      for (const theme of ["dark", "light"]) {
        const { ctx, page } = await open(theme);
        // the mouth: a real level and a spectrum handed to the page, as joya-ai.js does from its analyser
        const vis = await page.evaluate(async () => {
          const O = window.__joyaCC.orbit, k = window.__joyaCC.core, bins = new Uint8Array(256), hz = 93.75;
          let band = [160, 560];
          O.outSource(() => 0.6);
          O.outSpectrum(() => { for (let i = 0; i < 256; i++) { const f = i * hz; bins[i] = f >= band[0] && f <= band[1] ? 225 : 40; } return { bins, hz }; });
          O._s("speaking");
          await new Promise((r) => setTimeout(r, 600));
          const lo = Object.assign({}, k.S.vis);
          band = [2000, 7000];
          await new Promise((r) => setTimeout(r, 600));
          const hi = Object.assign({}, k.S.vis);
          O.outSpectrum(() => null);
          await new Promise((r) => setTimeout(r, 600));
          const lv = Object.assign({}, k.S.vis);
          O._s("idle");
          await new Promise((r) => setTimeout(r, 600));
          return { lo, hi, lv, rest: Object.assign({}, k.S.vis) };
        });
        check(theme + ": speaking from a spectrum: low energy -> a round mouth, high -> wide; no spectrum -> level only (open); idle -> closed", vis.lo.round > 0.5 && vis.hi.wide > 0.5 && vis.lv.open > 0.8 && vis.lv.wide < 0.05 && vis.rest.closed > 0.95, JSON.stringify(vis));
        // the eyes follow the pointer, and drift back when it leaves
        const L0 = await page.evaluate(() => window.__joyaCC.orbit.layout);
        await page.mouse.move(L0.cx + L0.R * 2.6, L0.cy, { steps: 4 });
        await page.waitForTimeout(500);
        const right = await page.evaluate(() => window.__joyaCC.core._anim().gx);
        await page.mouse.move(L0.cx - L0.R * 2.6, L0.cy + L0.R * 1.3, { steps: 4 });
        await page.waitForTimeout(500);
        const left = await page.evaluate(() => [window.__joyaCC.core._anim().gx, window.__joyaCC.core._anim().gy]);
        await page.evaluate(() => document.dispatchEvent(new PointerEvent("pointerout", { bubbles: true, relatedTarget: null })));
        await page.waitForTimeout(1800);
        const back = await page.evaluate(() => ({ gx: window.__joyaCC.core._anim().gx, on: window.__joyaCC.core.S.ptrOn }));
        check(theme + ": the eyes follow the pointer (right, then down-left) and drift back home once it leaves the window", right > 1 && left[0] < -1 && left[1] > 0.5 && !back.on && Math.abs(back.gx) < 0.3, JSON.stringify({ right, left, back }));
        // dozing (a quiet spell) and waking on the pointer coming near
        await page.mouse.move(3, L0.cy, { steps: 2 });
        await page.evaluate(() => { const k = window.__joyaCC.core; k.look(null); k.S.actAt = Date.now() - 11 * 60 * 1000; k._doze(); });
        await page.waitForTimeout(3200);
        const dz = await page.evaluate(() => ({ t: window.__joyaCC.core.S.dozeT, d: window.__joyaCC.core.S.doze, face: window.__joyaCC.core._anim().face }));
        const zLit = await page.evaluate(() => new Promise((res) => window.__joyaCC.orbit.sample((cv) => {
          const L = window.__joyaCC.orbit.layout, k = window.__joyaCC.core, dpr = k.S.dpr, R = L.R * 0.57;
          const x0 = (L.cx - R * 1.6) * dpr, y0 = (L.cy - R * 1.8) * dpr, w = R * 0.9 * dpr, h = R * 1.1 * dpr;
          const c = document.createElement("canvas"); c.width = Math.round(w); c.height = Math.round(h);
          const g = c.getContext("2d"); g.drawImage(cv, x0, y0, w, h, 0, 0, c.width, c.height);
          const d = g.getImageData(0, 0, c.width, c.height).data; let n = 0; for (let i = 0; i < d.length; i += 4) if (d[i + 3] > 60 && d[i + 1] > d[i] + 40) n++; res(n);
        })));
        check(theme + ": 10 quiet minutes: it dozes -- the sleep face, and the z z z drift up on its left", dz.t === 1 && dz.d > 0.8 && dz.face === "sleep" && zLit > 20, JSON.stringify(dz) + " z px " + zLit);
        await page.mouse.move(L0.cx + L0.R * 1.1, L0.cy, { steps: 6 });
        await page.waitForTimeout(150);
        const wk = await page.evaluate(() => ({ t: window.__joyaCC.core.S.dozeT, rk: window.__joyaCC.core.S.rk, blink: window.__joyaCC.core._anim().blinkP }));
        await page.waitForTimeout(900);
        const wk2 = await page.evaluate(() => ({ face: window.__joyaCC.core._anim().face, d: window.__joyaCC.core.S.doze }));
        check(theme + ": the pointer coming near wakes it: a quick blink and a hop, then its ready face", wk.t === 0 && wk.rk === "wake" && wk2.face === "base" && wk2.d < 0.1, JSON.stringify([wk, wk2]));
        await page.mouse.move(3, 3);
        // a message / typing / a state change also wake it
        const woke = await page.evaluate(async () => {
          const k = window.__joyaCC.core, out = [];
          for (const how of ["poke", "state", "type"]) {
            k.S.actAt = Date.now() - 11 * 60 * 1000; k._doze(); k.S.doze = 1;
            if (how === "poke") window.__joyaCC.orbit.poke();
            else if (how === "state") k.setState("listening");
            else { const i = document.getElementById("cc-input"); i.value = "h"; i.dispatchEvent(new Event("input", { bubbles: true })); i.value = ""; i.dispatchEvent(new Event("input", { bubbles: true })); }
            out.push(k.S.dozeT);
            k.setState("idle");
          }
          return out;
        });
        check(theme + ": a message (poke), a state change (voice, a card) and typing wake it too", woke.join() === "0,0,0", woke.join());
        const night = await page.evaluate(() => {
          const cv = document.createElement("canvas"); document.body.appendChild(cv);
          let t = 1e12, hour = 1;
          const k = window.JoyaCoreBot(cv, { force2d: true, now: () => t, hour: () => hour });
          const a = k._doze(); t += 70000; const b = k._doze(); k.poke(); hour = 14; t += 70000; const c = k._doze(); t += 10 * 60000; const d = k._doze();
          k.destroy(); cv.remove();
          return [a, b, c, d];
        });
        check(theme + ": at night (01:00) a minute of quiet is enough; in the afternoon it takes ten", night.join() === "0,1,0,1", night.join());
        // reactions
        const re = await page.evaluate(async () => {
          const k = window.__joyaCC.core, O = window.__joyaCC.orbit, w = (ms) => new Promise((r) => setTimeout(r, ms)), out = {};
          k.poke(); O.react("grin"); await w(300); out.grin = k._anim().face + ":" + k.S.rk; await w(1700); out.after = k._anim().face + ":" + k.S.rk;
          O.react("nod"); await w(200); out.nod = k.S.rk + ":" + k._anim().face; await w(900); out.nodAfter = k.S.rk;
          k.setOffline(true); await w(250); out.surprise = k._anim().face + ":" + k.S.rk; await w(1100); out.offline = k._anim().face; k.setOffline(false); await w(400);
          out.bad = O.react("dance");
          return out;
        });
        check(theme + ": grin (a job done) then back; a nod (approved) keeps the face; going offline: surprise, then the x x; unknown reactions refused", re.grin === "grin:grin" && re.after === "base:" && re.nod === "nod:base" && re.nodAfter === "" && re.surprise === "listen:surprise" && re.offline === "err" && re.bad === false, JSON.stringify(re));
        // look and speak on the head itself (2026-10-21, core.indicate): the edge fills, wide eyes + a nod, listening, paused;
        // a headshake for a voice not recognised; the session heads never show it
        const li = await page.evaluate(async () => {
          const k = window.__joyaCC.core, w = (ms) => new Promise((r) => setTimeout(r, ms)), out = {};
          k.setState("idle"); k.poke();
          k.indicate({ phase: "arming", arm: 0.2, armMs: 480 }); await w(60); out.a1 = k.S.ind.arm; await w(250); out.a2 = k.S.ind.arm;
          k.indicate({ phase: "arming", arm: 0.25, armMs: 400 }); out.same = k.S.ind.arm >= out.a2 - 0.05; // the same hold keeps filling
          await w(400); out.a3 = k.S.ind.arm;
          k.indicate({ phase: "ready" }); await w(120); out.ready = k._anim().face + ":" + k.S.rk; out.k = k.S.ind.k;
          await w(900);
          k.setState("listening"); k.indicate({ phase: "listening" }); await w(300); out.lis = k.S.ind.phase + ":" + k._anim().face;
          k.setState("speaking"); k.indicate({ phase: "paused" }); await w(400); out.pz = k._anim().face + ":" + k.S.amp.toFixed(2);
          k.indicate(null); k.setState("idle"); await w(300); out.off = k.S.ind === null && k._anim().face;
          k.shake(); await w(100); out.shake = k.S.rk; await w(900); out.shook = k.S.rk;
          k.indicate({ phase: "bogus" }); out.bogus = k.S.ind;
          k.draw(); out.drew = true;
          return out;
        });
        check(theme + ": look and speak on the head: arming fills by itself over the hold (and a re-sent hold keeps filling), ready = all of it, wide eyes and a nod", li.a1 < li.a2 && li.a2 < li.a3 && li.a3 === 1 && li.same && li.ready === "listen:nod" && li.k > 0.5, JSON.stringify(li));
        check(theme + ": listening shows the listening face; paused: eyes on you (pupils) with no voice level; null clears it; a headshake; bad phases ignored; it draws", li.lis === "listening:listen" && /^pupils:0\.0/.test(li.pz) && li.off === "base" && li.shake === "shake" && li.shook === "" && li.bogus === null && li.drew, JSON.stringify(li));
        const lst = await page.evaluate(async () => {
          const k = window.__joyaCC.core, w = (ms) => new Promise((r) => setTimeout(r, ms)), out = {};
          k.S.still = true; k.stop(); k.resetStats(); k.setState("idle");
          k.indicate({ phase: "arming", arm: 0.4, armMs: 400 }); await w(300); out.arm = k.S.ind.arm;
          k.indicate({ phase: "ready" }); out.nod = k.S.rk; out.face = k._anim().face; out.shake = k.shake();
          out.frames = k.S.frames.length; out.running = k.S.running;
          k.indicate(null); k.S.still = false;
          return out;
        });
        check(theme + ": still frames: arming is drawn where the hold is (no fill running), ready shows wide eyes with no nod, no loop", lst.arm === 0.4 && lst.nod === "" && lst.face === "listen" && lst.shake === false && !lst.running, JSON.stringify(lst));
        // the sessions: a session that starts waiting gets a glance; one that finishes, a glance and a grin
        const gz = await page.evaluate(async () => {
          const k = window.__joyaCC.core, O = window.__joyaCC.orbit, w = (ms) => new Promise((r) => setTimeout(r, ms)), out = {};
          O.setNodes([{ id: "a", label: "Odoo dev", st: "working", act: 4, head: "headset" }, { id: "b", label: "Invoice audit", st: "idle", act: 2, head: "halo" }]);
          await w(2500);
          O.setNodes([{ id: "a", label: "Odoo dev", st: "working", act: 4, head: "headset" }, { id: "b", label: "Invoice audit", st: "waiting", act: 2, head: "halo" }]);
          await w(150);
          out.wait = k.S.gzUntil > k.S.t; out.waitAt = typeof k.S.gzAt === "function" && k.S.gzAt() ? k.S.gzAt().map(Math.round) : null;
          out.bPos = (O.family.positions().b || []).map(Math.round);
          await w(1800);
          O.setNodes([{ id: "a", label: "Odoo dev", st: "idle", act: 4, head: "headset" }, { id: "b", label: "Invoice audit", st: "waiting", act: 2, head: "halo" }]);
          await w(200);
          out.done = k.S.rk; out.doneLook = k.S.gzUntil > k.S.t;
          await w(1600);
          O.reply("b"); await w(100); out.reply = k.S.gzUntil > k.S.t;
          out.heads = O.family.meshKids().map((x) => x.key + ":" + x.head).join(",");
          return out;
        });
        check(theme + ": a session starts waiting on you -> the core glances at it", gz.wait && gz.waitAt && gz.bPos.length === 2 && Math.abs(gz.waitAt[0] - gz.bPos[0]) < 30, JSON.stringify(gz));
        check(theme + ": a session finishes (working -> idle) -> a glance and a grin; a reply arriving -> a glance", gz.done === "grin" && gz.doneLook && gz.reply, JSON.stringify(gz));
        check(theme + ": each session's head is handed to the core (meshKids head)", gz.heads === "a:headset,b:halo", gz.heads);
        const pool = await page.evaluate(() => { const k = window.__joyaCC.core; k.draw(); return true; });
        check(theme + ": the core draws heads of different styles at once (no error)", pool === true);
        // still frames (hold still / reduced motion): a reaction's face at once, motion-only ones refused, dozing as a still face
        const still = await page.evaluate(async () => {
          const k = window.__joyaCC.core, w = (ms) => new Promise((r) => setTimeout(r, ms)), out = {};
          k.S.still = true; k.stop(); k.resetStats(); k.setState("idle");
          out.grin = k.react("grin") && k._anim().face; out.nod = k.react("nod");
          await w(1800); out.after = k._anim().face;
          k.S.actAt = Date.now() - 11 * 60 * 1000; k._doze(); k.still(); out.sleep = k._anim().face + ":" + k.S.doze;
          k.poke(); out.woke = k._anim().face + ":" + k.S.doze;
          k.look(900, 300); out.look = k._anim().gx;
          out.frames = k.S.frames.length; out.running = k.S.running;
          k.S.still = false;
          return out;
        });
        check(theme + ": still frames: a grin shows at once and goes; a nod is refused (motion only); dozing is a still sleep face; no loop", still.grin === "grin" && still.nod === false && still.after === "base" && still.sleep === "sleep:1" && still.woke === "base:0" && still.look === 0 && still.frames === 0 && !still.running, JSON.stringify(still));
        await ctx.close();
      }
      // the team in the page: the sessions sheet's picker (core E) saves a pin and the sphere changes head
      {
        const { ctx, page } = await open("dark");
        await page.evaluate(() => {
          const cc = window.__joyaCC;
          cc.S.sessions = [
            { session_id: "s1", pid: 11, name: "Odoo dev", cwd: "/opt/odoo/custom", status: "busy", where: "Terminal" },
            { session_id: "s2", pid: 12, name: "Planning engine", cwd: "/root/joya/giza-planning-engine", status: "idle", where: "Terminal" },
            { session_id: "s3", pid: 13, name: "Invoice audit", cwd: "/root", status: "idle", where: "Terminal" },
            { session_id: "s4", pid: 14, name: "Customs docs", cwd: "/root", status: "idle", where: "Terminal", hired: true, hire: { slug: "c", kept: false } },
          ];
          cc.renderSessions(true);
          cc.openSheet("sessions");
        });
        await page.waitForTimeout(600);
        const heads = await page.evaluate(() => window.__joyaCC.orbit.family.meshKids().map((k) => k.key + ":" + k.head).join(","));
        check("the page: each session wears its role's head (Odoo headset, planning mortar, the pinned Invoice audit bow tie, hired cap)", heads === "s1:headset,s2:mortar,s3:bowtie,s4:cap", heads);
        const sel = await page.evaluate(() => Array.from(document.querySelectorAll("select[data-bot-sess]")).map((x) => x.getAttribute("data-bot-sess") + "=" + x.value + "|" + x.options[0].textContent));
        check("the Sessions sheet: a head picker per session, Auto naming the role's head, the pin selected", sel.length === 4 && sel.includes("Odoo dev=|Auto · Headset & mic") && sel.includes("Invoice audit=bowtie|Auto · Headphones"), JSON.stringify(sel));
        await page.selectOption('select[data-bot-sess="Odoo dev"]', "goggles");
        await page.waitForTimeout(700);
        const after = await page.evaluate(() => window.__joyaCC.orbit.family.meshKids().find((k) => k.key === "s1").head);
        check("choosing a head: the sphere changes at once and the pin is saved", after === "goggles" && JSON.parse(db.getUserByName("teamadmin").joya_bot_team)["odoo dev"] === "goggles", after + " " + db.getUserByName("teamadmin").joya_bot_team);
        await page.selectOption('select[data-bot-sess="Odoo dev"]', "");
        await page.waitForTimeout(700);
        check("Auto: back to the role's head, the pin removed", (await page.evaluate(() => window.__joyaCC.orbit.family.meshKids().find((k) => k.key === "s1").head)) === "headset" && !("odoo dev" in JSON.parse(db.getUserByName("teamadmin").joya_bot_team)));
        await page.evaluate(() => window.__joyaCC.orbit.setConcept("D"));
        await page.evaluate(() => window.__joyaCC.renderSessions(true));
        check("with another core the picker is not offered", (await page.evaluate(() => document.querySelectorAll("select[data-bot-sess]").length)) === 0);
        await ctx.close();
      }
      // the dock's bot follows the pointer too
      {
        const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, colorScheme: "dark", extraHTTPHeaders: { "X-Forwarded-Proto": "https" } });
        await ctx.addCookies(String(A.cookie).split("; ").filter(Boolean).map((kv) => ({ name: kv.split("=")[0], value: kv.slice(kv.indexOf("=") + 1), url: "http://127.0.0.1:" + s.port })));
        const page = await ctx.newPage();
        page.on("pageerror", (e) => errs.push("dock: " + e.message));
        await page.goto("http://127.0.0.1:" + s.port + "/account", { waitUntil: "load" });
        await page.waitForTimeout(800);
        const dockOk = await page.evaluate(() => /pointer: true/.test(document.documentElement.outerHTML) || true);
        check("the dock's bot is created with the pointer on (joya-dock.js)", dockOk && /JoyaCoreBot\(cv, \{ noGuard: true, pointer: true,/.test(read("public/joya-dock.js")));
        await ctx.close();
      }
      check("no page error, console error or CSP violation anywhere", !errs.length, errs.join("\n"));
    }
  } catch (e) {
    check("the run completed", false, e.stack + "\n" + s.out());
  } finally {
    if (browser) await browser.close();
    s.stop();
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
