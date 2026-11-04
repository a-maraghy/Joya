#!/usr/bin/env node
"use strict";
/**
 * The living canvas's learning store and its routes:
 *   1. lib/canvas-store.js over a scratch database: pins (checked, at most 12, one person's only),
 *      sizes, the counts per widget key, what they decide (standing / not offered), learning off, reset;
 *   2. the real server.js (a scratch copy) over a fake supervisor: the API with CSRF, another person's
 *      board out of reach, Settings ▸ Appearance ▸ Board (lock, learning, the counts, reset), and a
 *      widget JOYA AI sends reaching the tab that asked -- checked again, counted as offered, and not
 *      offered any more once that kind is always dismissed (JOYA AI is told why).
 *
 *     NODE_PATH=/opt/joya-dashboard/node_modules node dashboard/tools/test-canvas-store.cjs
 */
const scratch = require("./scratch-server.cjs"); // first: sets JOYA_DATA_DIR
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const ROOT = path.join(__dirname, "..");
const Store = require(path.join(ROOT, "lib", "canvas-store.js"));

let passed = 0, failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log("  ok   " + name); }
  else { failed++; console.log("  FAIL " + name + (detail !== undefined ? "\n       " + String(detail).slice(0, 700) : "")); }
}
const section = (t) => console.log("\n" + t);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SPEND = { v: 1, kind: "chart", title: "Spend, last 14 days", source: { name: "usage.spend" }, blocks: [{ type: "chart", view: "days" }] };
const TABLE = { v: 1, kind: "table", title: "Disk", blocks: [{ type: "table", columns: [{ key: "d", label: "Dir" }], rows: [{ d: "/var" }] }] };

(async () => {
  section("1. the store");
  {
    const Database = require("better-sqlite3");
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cv-store-"));
    const db = new Database(path.join(tmp, "t.db"));
    let t = Date.parse("2026-10-20T10:00:00Z");
    const S = Store.create(db, { now: () => t });
    check("fresh: not locked, learning on, nothing pinned", JSON.stringify(S.prefs(1)) === '{"locked":false,"learn":true}' && S.pins(1).length === 0);
    const p = S.pin(1, SPEND, "l");
    check("a pin is checked and stored canonical, with its key and size", p.pin && p.pin.key === "chart:usage.spend" && p.pin.size === "l" && p.pin.spec.blocks[0].style === "bar", JSON.stringify(p));
    check("  pinning counts a pin and keeps the widget for a standing tile", S.stats(1)[0].pins === 1);
    check("a bad widget is not pinned (why given)", /markup/.test(S.pin(1, Object.assign({}, SPEND, { title: "<b>x</b>" })).error || ""));
    check("another person sees none of it", S.pins(2).length === 0 && S.stats(2).length === 0);
    check("resize: s/m/l only, one's own only", S.resize(1, p.pin.id, "s").size === "s" && S.resize(1, p.pin.id, "xl") === null && S.resize(2, p.pin.id, "m") === null);
    for (let i = 0; i < 11; i++) S.pin(1, TABLE);
    const full = S.pin(1, TABLE);
    check("at most 12 pins", full.full && /12 pinned/.test(full.error) && S.pins(1).length === 12);
    check("unpin: one's own only; tidying, not counted as a dismissal", !S.unpin(2, p.pin.id) && S.unpin(1, p.pin.id) && S.stats(1).find((r) => r.key === "chart:usage.spend").dismissals === 0);
    check("counts: offered / dismiss / open by key; an unknown key or event is refused", S.count(1, "list:sessions", "offered") && S.count(1, "list:sessions", "open") && !S.count(1, "list:evil", "offered") && !S.count(1, "list:sessions", "approve") && !S.count(1, "<b>:x", "open"));
    // learning: table pinned 12x -> standing; a story kind dismissed 3x -> not offered
    for (let i = 0; i < 3; i++) { S.count(1, "story:story", "offered"); S.count(1, "story:story", "dismiss"); }
    const L = S.learned(1);
    check("pinned often: a standing tile, drawn from the last one pinned", L.standing.length === 1 && L.standing[0].key === "table:payload" && L.standing[0].spec.title === "Disk", JSON.stringify(L.standing));
    check("always dismissed: not offered", L.suppressed.join() === "story:story" && S.suppressed(1, "story:story") && !S.suppressed(1, "table:payload") && !S.suppressed(2, "story:story"));
    check("rows carry their verdicts", L.rows.find((r) => r.key === "story:story").verdict === "not offered");
    S.setPrefs(1, { learn: false });
    check("learning off: nothing is counted, nothing is suppressed or standing (the counts stay)", !S.count(1, "story:story", "dismiss") && !S.suppressed(1, "story:story") && S.learned(1).standing.length === 0 && S.stats(1).length > 0);
    S.setPrefs(1, { learn: true, locked: true });
    check("lock is kept per person", S.prefs(1).locked && !S.prefs(2).locked);
    check("reset forgets the counts, keeps the pins", S.resetLearning(1) > 0 && S.stats(1).length === 0 && S.pins(1).length === 11 && !S.suppressed(1, "story:story"));
    check("the store makes only its own tables", db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map((r) => r.name).join() === "canvas_pins,canvas_prefs,canvas_stats");
    const raw = db.prepare("SELECT spec FROM canvas_pins LIMIT 1").get().spec;
    db.prepare("UPDATE canvas_pins SET spec = ? WHERE spec = ?").run(raw.replace('"Disk"', '"<b>Disk</b>"'), raw);
    check("a stored widget that no longer passes is not served", S.pins(1).length === 0 || S.pins(1).every((x) => !/</.test(x.spec.title)));
    t += 1;
  }

  section("2. the routes, Settings, and a widget from JOYA AI reaching its tab");
  const { buildWorld } = require("./story-fixture.cjs");
  const { startCanvasFake } = require("./canvas-fake-supervisor.cjs");
  const W = buildWorld(fs.mkdtempSync(path.join(os.tmpdir(), "cv-w-")), Date.now());
  const SOCK = path.join(scratch.DATA, "fake-canvas.sock");
  const sup = await startCanvasFake(SOCK, W);
  let s = null;
  try {
    s = await scratch.startScratch({ env: { JOYA_AI_SOCKET: SOCK } });
    await s.makeUser("alice", "administrator");
    await s.makeUser("bob", "administrator");
    const A = await s.signIn("alice"), B = await s.signIn("bob");
    const csrfA = s.csrfOf((await s.req("GET", "/joya-ai", { cookie: A.cookie })).body);
    const csrfB = s.csrfOf((await s.req("GET", "/joya-ai", { cookie: B.cookie })).body);
    const post = (who, csrf, p, body) => s.req("POST", "/joya-ai/api/canvas" + p, { cookie: who.cookie, headers: { "X-CSRF-Token": csrf }, body: body || {} });
    const get = async (who) => JSON.parse((await s.req("GET", "/joya-ai/api/canvas", { cookie: who.cookie })).body);
    let r = await get(A);
    check("GET: prefs, pins, learned, the catalog's version", r.prefs && r.pins.length === 0 && r.learned && r.version === 1 && r.max_pins === 12, JSON.stringify(r));
    check("a write without the CSRF token is refused", (await s.req("POST", "/joya-ai/api/canvas/pin", { cookie: A.cookie, body: { widget: SPEND } })).status === 403);
    check("signed out: refused", (await s.req("GET", "/joya-ai/api/canvas")).status !== 200);
    r = await post(A, csrfA, "/pin", { widget: SPEND, size: "m" });
    const pin = JSON.parse(r.body).pin;
    check("pin: stored, checked", r.status === 200 && pin && pin.key === "chart:usage.spend");
    check("pin of a widget with a URL: 400 with why", (await post(A, csrfA, "/pin", { widget: Object.assign({}, TABLE, { note: "see http://x.example" }) })).status === 400);
    check("bob cannot resize or unpin alice's (404), and sees none", (await post(B, csrfB, "/pins/" + pin.id + "/size", { size: "l" })).status === 404 && (await post(B, csrfB, "/pins/" + pin.id + "/unpin")).status === 404 && (await get(B)).pins.length === 0);
    check("resize", JSON.parse((await post(A, csrfA, "/pins/" + pin.id + "/size", { size: "l" })).body).pin.size === "l");
    check("event: dismiss / open only, a known key only", (await post(A, csrfA, "/event", { key: "chart:usage.spend", what: "approve" })).status === 400 && (await post(A, csrfA, "/event", { key: "x:y", what: "open" })).status === 400 && JSON.parse((await post(A, csrfA, "/event", { key: "chart:usage.spend", what: "open" })).body).counted === true);
    check("prefs: booleans only", (await post(A, csrfA, "/prefs", { locked: "yes" })).status === 400 && JSON.parse((await post(A, csrfA, "/prefs", { locked: true })).body).prefs.locked === true);
    await post(A, csrfA, "/prefs", { locked: false });
    // Settings ▸ Appearance ▸ Board
    let set = await s.req("GET", "/joya-ai/settings/appearance", { cookie: A.cookie });
    check("Settings ▸ Appearance shows the Board group: lock, learning, the counts, reset", set.status === 200 && /id="a-board"/.test(set.body) && /Lock the layout/.test(set.body) && /Learn from what I keep/.test(set.body) && /class="cv-learn"/.test(set.body) && /chart · usage\.spend/.test(set.body) && /Reset what the board learned/.test(set.body));
    check("  and the rest of Appearance is still there (core, sounds)", /joya-core-opts/.test(set.body) && /data-snd-try|Sounds/.test(set.body));
    const csrfS = s.csrfOf(set.body);
    const form = (p, body) => s.req("POST", "/joya-ai/settings/canvas/" + p, { cookie: A.cookie, headers: { Accept: "application/json" }, body: new URLSearchParams(Object.assign({ _csrf: csrfS }, body)).toString() });
    r = await form("lock", { on: "1" });
    check("Settings: lock (JSON reply, the board's message)", r.status === 200 && /locked/.test(r.body) && (await get(A)).prefs.locked === true, r.body);
    await form("lock", {});
    check("  unlock", (await get(A)).prefs.locked === false);
    check("Settings: reset forgets the counts, keeps the pin", (await form("reset", {})).status === 200 && (await get(A)).learned.rows.length === 0 && (await get(A)).pins.length === 1);
    check("Settings forms need the CSRF token", (await s.req("POST", "/joya-ai/settings/canvas/reset", { cookie: A.cookie, headers: { Accept: "application/json" }, body: "" })).status === 403);

    // A widget from JOYA AI: the event stream of alice's tab.
    const TAB = "tabCANVAS0001";
    const port = Number((/:(\d+)$/.exec(s.base || "") || [])[1]) || null;
    const events = [];
    const stream = await new Promise((resolve) => {
      const h = { Cookie: A.cookie, "X-Forwarded-Proto": "https", Accept: "text/event-stream" };
      const rq = http.request({ host: "127.0.0.1", port: s.port || port, path: "/joya-ai/api/events?tab=" + TAB, headers: h }, (res) => {
        res.setEncoding("utf8");
        let buf = "";
        res.on("data", (c) => { buf += c; let i; while ((i = buf.indexOf("\n\n")) >= 0) { const blk = buf.slice(0, i); buf = buf.slice(i + 2); const ev = /event: (\S+)/.exec(blk), d = /data: (.*)/.exec(blk); if (ev && d) events.push({ type: ev[1], data: JSON.parse(d[1]) }); } });
        resolve({ close: () => rq.destroy() });
      });
      rq.on("error", () => {});
      rq.end();
    });
    await sleep(500);
    const send = await s.req("POST", "/joya-ai/api/send", { cookie: A.cookie, headers: { "X-CSRF-Token": csrfA }, body: { text: "what did we spend?", tab: TAB } });
    const ut = sup.lastUt();
    check("a send from the tab mints a ui token for its turn", send.status === 200 && !!ut, send.body);
    const push = (nonce, widget) => sup.push({ type: "ui", actor: "alice", ut_tag: sup.tagOf(ut), nonce, action: "widget.show", args: {}, turn_id: sup.lastTurn(), widget });
    push("aaaaaaaaaaaa01", SPEND);
    await sleep(600);
    const got = events.find((e) => e.type === "ui" && e.data.action === "widget.show");
    check("the widget reaches alice's tab, canonical, with its key; no token, no tag in it", got && got.data.widget.title === SPEND.title && got.data.key === "chart:usage.spend" && got.data.widget.blocks[0].style === "bar" && !JSON.stringify(got.data).includes(ut) && !("ut_tag" in got.data), JSON.stringify(events.slice(-2)));
    check("  counted as offered", (await get(A)).learned.rows.find((x) => x.key === "chart:usage.spend").offered === 1);
    // A forged widget (bad HTML) on the right token: refused by the server, JOYA AI told why.
    const before = sup.seen.length;
    push("aaaaaaaaaaaa02", { v: 1, kind: "list", title: "<img src=x onerror=alert(1)>", blocks: [{ type: "list", items: [{ text: "x" }] }] });
    await sleep(600);
    const ackBad = sup.seen.slice(before).find((m) => m.op === "ui-ack" && m.nonce === "aaaaaaaaaaaa02");
    check("a widget that fails the building blocks never reaches the tab; ui-ack refused with why", !events.some((e) => e.data && e.data.nonce === "aaaaaaaaaaaa02") && ackBad && ackBad.ok === false && /markup/.test(ackBad.why), JSON.stringify(ackBad));
    // Always dismissed: no longer offered.
    for (let i = 0; i < 3; i++) await post(A, csrfA, "/event", { key: "table:payload", what: "dismiss" });
    const b2 = sup.seen.length;
    push("aaaaaaaaaaaa03", TABLE);
    await sleep(600);
    const ackSup = sup.seen.slice(b2).find((m) => m.op === "ui-ack" && m.nonce === "aaaaaaaaaaaa03");
    check("a kind always dismissed is not offered: refused, JOYA AI told to answer in words", !events.some((e) => e.data && e.data.nonce === "aaaaaaaaaaaa03") && ackSup && ackSup.ok === false && /keeps dismissing/.test(ackSup.why) && /answer in words/.test(ackSup.why), JSON.stringify(ackSup));
    stream.close();
  } finally {
    if (s) s.stop();
    sup.close();
  }

  section("3. board learning switched off once (the 2026-10-25 cleanup)");
  {
    const Database = require("better-sqlite3");
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cv-mig-"));
    const raw = new Database(path.join(tmp, "m.db"));
    const settings = new Map();
    const log = [];
    const users = [{ id: 1, username: "amaraghy" }, { id: 2, username: "other" }, { id: 3, username: "off-already" }];
    const fakeDb = {
      db: raw,
      getSetting: (k, d) => (settings.has(k) ? settings.get(k) : d),
      setSetting: (k, v) => settings.set(k, v),
      listUsers: () => users,
      logLogin: (ip, u, outcome, detail) => log.push([u, outcome, detail]),
    };
    const pre = Store.create(raw, {});
    pre.setPrefs(1, { locked: true });
    pre.setPrefs(3, { learn: false });
    const app = { get() {}, post() {} };
    const R = require(path.join(ROOT, "lib", "routes-canvas.js"));
    const m1 = R.mount(app, { db: fakeDb, apiGuard: [], apiWrite: [], requireAuth: () => {}, requireCsrf: () => {} });
    check("every account that was learning is switched off; the lock and the rest kept", m1.store.prefs(1).learn === false && m1.store.prefs(1).locked === true && m1.store.prefs(2).learn === false && m1.store.prefs(3).learn === false);
    check("  audited per account changed (2), recorded in settings with the count", log.filter((l) => /board learning off \(cleanup, migration\)/.test(l[2])).length === 2 && JSON.parse(settings.get("migration.canvas_learn_off")).switched_off === 2, JSON.stringify(log));
    m1.store.setPrefs(2, { learn: true });
    const m2 = R.mount(app, { db: fakeDb, apiGuard: [], apiWrite: [], requireAuth: () => {}, requireCsrf: () => {} });
    check("  runs once: switching it back on afterwards sticks across a restart", m2.store.prefs(2).learn === true && log.length === 2);
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
