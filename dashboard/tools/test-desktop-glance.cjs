#!/usr/bin/env node
"use strict";
/**
 * The JOYA AI desktop app's glance cards (0.1.9): approvals, sessions, today's tokens and live alerts
 * beside the core (public/joya-desktop-glance.js, joya-desktop-layout.js, joya-desktop.js), and the
 * app's half (layout.rs, settings.rs, lib.rs, the tray item, capabilities/remote.json, Settings).
 *
 *     NODE_PATH=/opt/joya-dashboard/node_modules PLAYWRIGHT=/path/to/node_modules/playwright \
 *       node dashboard/tools/test-desktop-glance.cjs [--shots DIR]
 *
 * Pure parts first; then a scratch copy of the real server.js talking to a fake supervisor that
 * answers status / sessions / token caps / the ledger and keeps the event stream open, so a live
 * update goes through the page's real channel (the supervisor's events -> SSE -> the page). In
 * headless Chromium with the app's user agent: render, live update, Approve -> the Windows Hello
 * dialog -> approved (a virtual platform authenticator), Deny, Open, a session click, hide / show,
 * focus mode, pin / unpin with a mocked app bridge, the hit regions (cards yes, gaps no), keyboard,
 * hold-still, 100 / 125 / 150 %, zero CSP violations and page errors. --shots DIR also writes the
 * preview (over a dark and a bright wallpaper; see mockups/desktop-panel/).
 */
const scratch = require("./scratch-server.cjs"); // first: sets JOYA_DATA_DIR
const crypto = require("crypto");
const net = require("net");
const path = require("path");
const fs = require("fs");
const { execFileSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const D = path.join(ROOT, "..", "desktop");
const LAY = require(path.join(ROOT, "public", "joya-desktop-layout.js"));
const G = require(path.join(ROOT, "public", "joya-desktop-glance.js"));
const SHOTS = (() => { const i = process.argv.indexOf("--shots"); return i > 0 ? path.resolve(process.argv[i + 1]) : null; })();
const APP_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36 Edg/129.0.0.0 JoyaDesktop/0.1.9";

let passed = 0, failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log("  ok   " + name); }
  else { failed++; console.log("  FAIL " + name + (detail !== undefined ? "\n       " + String(detail).slice(0, 700) : "")); }
}
const section = (t) => console.log("\n" + t);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const inside = (r, x, y) => x >= r.x && y >= r.y && x < r.x + r.w && y < r.y + r.h;

/* ------------------------------------------------------------------ the fake supervisor */
const iso = (ms) => new Date(Date.now() + ms).toISOString();
function approval(id, summary, origin, name, mins) {
  return { id, status: "pending", tool: "Bash", input: { command: summary }, summary, category: "delete", label: "Deletes files", reason: "The gate treats this as destructive.",
    created_at: iso(-60000), expires_at: iso((mins || 5) * 60000), origin: origin || "joya-ai", origin_name: name || "JOYA AI" };
}
const W = {
  approvals: [approval(41, "rm -rf /srv/old-builds/2026-09", "joya-ai", "JOYA AI", 4), approval(42, "systemctl restart odoo", "session:planning", "Planning engine", 9)],
  sessions: [
    { self: true, name: "JOYA AI", pid: 100, session_id: "aaaaaaaa-0000-4000-8000-000000000000", status: "idle" },
    { name: "Planning engine", pid: 201, session_id: "bbbbbbbb-0000-4000-8000-000000000001", status: "busy", where: "~/joya", tokens_today: { total: 2.1e6 } },
    { name: "Customs docs", pid: 202, session_id: "bbbbbbbb-0000-4000-8000-000000000002", status: "idle", where: "~/customs" },
    { name: "Invoice audit", pid: 203, session_id: "bbbbbbbb-0000-4000-8000-000000000003", status: "busy", where: "~/audit", tokens_today: { total: 0.4e6 } },
    { name: "Freight quotes", pid: 204, session_id: "bbbbbbbb-0000-4000-8000-000000000004", status: "idle", where: "~/freight" },
  ],
  caps: { day: "2026-10-20", warn_pct: 80, held: 0, sessions: [
    { key: "<self>", name: "JOYA AI", kind: "self", cap: 5e6, at: "pause", today: { total: 4.1e6 }, state: "near" },
    { key: "planning", name: "Planning engine", kind: "hired", cap: 8e6, at: "warn", today: { total: 2.1e6 }, state: "ok" },
    { key: "bbbbbbbb-0000-4000-8000-000000000003", name: "Invoice audit", kind: "yours", cap: null, today: { total: 0.4e6 }, state: "none" },
  ] },
  inbound: [{ id: 7, kind: "idle", from_name: "Customs docs", text: "Filed the October declarations.", received_at: iso(-11 * 60000) }],
};
const SOCK = path.join(scratch.DATA, "fake-joya-ai-glance.sock");
const seen = [], streams = new Set();
let seq = 1;
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
      try { m = JSON.parse(line); } catch (_) { continue; }
      if (m.op === "events") { streams.add(c); c.on("close", () => streams.delete(c)); continue; }
      seen.push(m);
      let data = {};
      const find = (id) => W.approvals.find((a) => a.id === id);
      if (m.op === "status") data = { name: "JOYA AI", seq, process: { state: "ready", pid: 100 }, session_id: W.sessions[0].session_id, approvals: W.approvals.filter((a) => a.status === "pending"), tokens_today: { total: 4.1e6 }, cost_today: { total_usd: 14.2, budget_usd: null, warn_pct: 80 }, counts: {} };
      else if (m.op === "sessions") data = { sessions: W.sessions };
      else if (m.op === "token-caps") data = W.caps;
      else if (m.op === "ledger") data = { rows: m.table === "approvals" ? W.approvals : m.table === "inbound" ? W.inbound : [] };
      else if (m.op === "approve" || m.op === "deny") {
        const a = find(m.approval_id);
        if (a) Object.assign(a, { status: m.op === "approve" ? "approved" : "denied", decided_by: m.actor, decided_at: new Date().toISOString() });
        data = { approval: a ? { ...a, verified: m.verified } : null };
      } else if (m.op === "approval-hold") data = { expires_at: iso(90000), held: true };
      c.write(JSON.stringify({ id: m.id, ok: true, data }) + "\n");
    }
  });
  c.on("error", () => {});
});
/** An event on the supervisor's stream, to every open page. */
function push(type, payload) {
  const ev = Object.assign({ type, seq: ++seq, ts: new Date().toISOString() }, payload);
  for (const c of streams) c.write(JSON.stringify({ event: ev }) + "\n");
}

/* ------------------------------------------------------------------ wallpapers for the preview */
function paintWallpaper(kind, w, h) {
  const c = document.createElement("canvas"); c.width = w; c.height = h;
  const g = c.getContext("2d");
  let seed = 7;
  const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  if (kind === "bright") {
    const sky = g.createLinearGradient(0, 0, 0, h); sky.addColorStop(0, "#cfe3f5"); sky.addColorStop(0.6, "#f6f9fc"); sky.addColorStop(1, "#e9eef2");
    g.fillStyle = sky; g.fillRect(0, 0, w, h);
    g.fillStyle = "#e1eaf3"; g.beginPath(); g.moveTo(0, h * 0.55);
    for (let x = 0; x <= w; x += 50) g.lineTo(x, h * (0.42 + 0.08 * Math.sin(x / 230) + 0.04 * Math.sin(x / 61)));
    g.lineTo(w, h); g.lineTo(0, h); g.fill();
    for (let i = 0; i < 60; i++) { const x = rnd() * w, y = h * (0.6 + rnd() * 0.35), s = 18 + rnd() * 50; g.fillStyle = "#3d5a48"; g.beginPath(); g.moveTo(x, y - s * 2); g.lineTo(x - s * 0.5, y); g.lineTo(x + s * 0.5, y); g.fill(); }
  } else {
    // Windows 11's dark bloom, roughly: a deep blue field with soft folds.
    g.fillStyle = "#06081a"; g.fillRect(0, 0, w, h);
    for (let i = 0; i < 7; i++) {
      const gr = g.createRadialGradient(w * (0.3 + 0.07 * i), h * 0.62, 10, w * (0.3 + 0.07 * i), h * 0.62, h * (0.45 + 0.05 * i));
      gr.addColorStop(0, "rgba(" + (40 + i * 18) + "," + (80 + i * 10) + ",255,0.35)"); gr.addColorStop(1, "rgba(0,0,30,0)");
      g.fillStyle = gr; g.fillRect(0, 0, w, h);
    }
    for (let i = 0; i < 300; i++) { g.fillStyle = "rgba(255,255,255," + rnd() * 0.5 + ")"; g.fillRect(rnd() * w, rnd() * h * 0.5, 1.5, 1.5); }
  }
  return c.toDataURL("image/png");
}

(async () => {
  /* ================================================================ pure */
  section("the layout: where the glance column goes (joya-desktop-layout.js)");
  {
    const ws = LAY.windowSize({ glance: true });
    check("Floating M with the cards: the window is 256 + 12 px wider (748 x 860); never in focus mode", ws.w === 748 && ws.h === 860 && LAY.windowSize({ glance: true, focus: true }).w === 168 && LAY.windowSize({}).w === 480);
    const br = LAY.layout({ mode: "floating", W: 748, H: 860, glance: true });
    check("  a right corner (br, the default): the box at the window's right end, the column on its left (away from the edge), stacked up from the bottom", br.box.x === 268 && br.cx === 268 + 240 && br.glance.x === 0 && br.glance.w === 256 && br.glance.align === "end" && br.glance.side === "left" && br.glance.h === 860 - 16, JSON.stringify(br.glance));
    check("  everything of the box moved with it: chat panel, card, tools, gate", br.panel.x === 268 + 14 && br.card.x >= 268 && br.tools.x === 268 + 480 - 136 && br.gate.x === 268 + 240);
    const bl = LAY.layout({ mode: "floating", pos: "bl", W: 748, H: 860, glance: true });
    check("  a left corner (bl): the box at the left, the column on its right", bl.box.x === 0 && bl.glance.x === 492 && bl.glance.side === "right");
    const tl = LAY.layout({ mode: "floating", pos: "tl", W: 748, H: 860, glance: true });
    check("  a top corner: stacked down from the top", tl.glance.align === "start" && tl.box.y === 0);
    const narrow = LAY.layout({ mode: "floating", W: 480, H: 860, glance: true });
    check("  the window not widened (yet): no column, the box as before", narrow.glance === null && narrow.box.x === 0);
    check("  off or focus mode: no column; focus mode: no rim button either", LAY.layout({ mode: "floating", W: 748, H: 860 }).glance === null && LAY.layout({ mode: "floating", focus: true, W: 168, H: 168, glance: true }).glance === null && LAY.layout({ mode: "floating", focus: true, W: 168, H: 168 }).glanceBtn === null);
    const rim = br.glanceBtn;
    check("  the show / hide button on the core's rim (about 2 o'clock), clear of the chat and live-call buttons and the tools", rim.d === 34 && rim.x > br.cx && rim.y < br.cy && Math.hypot(rim.x - br.chatBtn.x, rim.y - br.chatBtn.y) > 40 && rim.y - 17 > br.tools.y + 32);
    const clear = (L) => L.glance.x + L.glance.w <= L.cx - L.R || L.glance.x >= L.cx + L.R;
    const onScreen = (L) => L.glance.x >= 8 && L.glance.x + L.glance.w <= L.W - 8 && L.glance.y >= 8 && L.glance.y + L.glance.h <= L.H - 8;
    const noPanel = (L) => L.panel.y < L.cy + L.R /* beside the core: the cards step aside while it is open */ || L.glance.x + L.glance.w <= L.panel.x || L.glance.x >= L.panel.x + L.panel.w || L.panel.y >= L.glance.y + L.glance.h;
    const noCard = (L) => L.glance.x + L.glance.w <= L.card.x || L.glance.y >= L.card.y + 300;
    for (const [w, h, nm] of [[1920, 1032, "1920x1080 at 100 %"], [1536, 824, "125 %"], [1280, 688, "150 %"], [1389, 820, "the laptop at 150 %"], [2560, 1380, "the second monitor, 2560x1440"]]) {
      const d = LAY.layout({ mode: "desktop", W: w, H: h, glance: true });
      check(`Desktop layer, ${nm}: beside the core (${d.glance.side}), on screen, clear of the core, the chat panel and the decision card`, d.glance && onScreen(d) && clear(d) && noPanel(d) && noCard(d), JSON.stringify({ g: d.glance, cx: d.cx, R: d.R, p: d.panel }));
    }
    const left = LAY.layout({ mode: "desktop", pos: "left", W: 1920, H: 1032, glance: true });
    check("  the core on the left: the column on its right", left.glance.side === "right" && clear(left));
    const pk = LAY.layout({ mode: "peek", W: 1440, H: 900, glance: true });
    check("Peek: beside the core too", pk.glance && clear(pk) && onScreen(pk) && noPanel(pk));
    const pin = LAY.layout({ mode: "desktop", W: 1920, H: 1032, glance: true, pin: { x: 0.05, y: 0.1 } });
    check("pinned: where it was dropped (fractions of the work area: the same place at any scaling)", pin.glance.pinned && pin.glance.x === 96 && Math.abs(pin.glance.y - 103.2) < 0.01 && Math.abs(LAY.layout({ mode: "desktop", W: 1280, H: 688, glance: true, pin: { x: 0.05, y: 0.1 } }).glance.x - 64) < 0.01);
    const off = LAY.layout({ mode: "desktop", W: 1920, H: 1032, glance: true, pin: { x: 0.99, y: 0.99 } });
    check("  a pin past the edge (another monitor's, a smaller screen): kept on screen", onScreen(off) || (off.glance.x + off.glance.w <= 1920 - 8 && off.glance.y <= 1032 - 140));
    const rs = fs.readFileSync(path.join(D, "src-tauri", "src", "layout.rs"), "utf8");
    check("the app sizes the Floating window with the same numbers (layout.rs GLANCE_W 256, GLANCE_GAP 12)", /GLANCE_W: f64 = 256\.0/.test(rs) && /GLANCE_GAP: f64 = 12\.0/.test(rs) && LAY.GL_W === 256 && LAY.GL_GAP === 12);
  }

  section("what the cards say (joya-desktop-glance.js)");
  {
    const now = Date.now();
    const A = G.approvals([approval(5, "b", "joya-ai", "", 9), approval(3, "a", "session:x", "Worker", 2), { id: 9, status: "approved" }, approval(7, "c", "joya-ai", "", 20)], now);
    check("approvals: pending only, the one that runs out first on top, two shown and the rest as '+N more'; a hired session's by its name", A.total === 3 && A.list.length === 2 && A.list[0].id === 3 && A.list[0].who === "Worker" && A.list[1].who === "JOYA AI" && A.more === 1 && /^1:5\d$|^2:00$/.test(A.list[0].leftText), JSON.stringify(A));
    const Se = G.sessions(W.sessions.concat([{ name: "Joya AI", status: "busy" }, { name: "Late", status: "waiting", waiting_for: "a reply about the invoices" }]));
    check("sessions: JOYA AI never counted (by any name); working / waiting / idle; waiting first, then the busiest at work", Se.working === 2 && Se.waiting === 1 && Se.idle === 2 && Se.top.length === 3 && Se.top[0].name === "Late" && /waiting for a reply/.test(Se.top[0].note) && Se.top[1].name === "Planning engine", JSON.stringify(Se));
    check("  all idle: the first two names, so the card is never empty when sessions run", G.sessions([{ name: "A", status: "idle" }, { name: "B", status: "idle" }, { name: "C", status: "idle" }]).top.length === 2 && G.sessions([]).total === 0);
    const C = G.cost(W.caps, { tokens_today: { total: 4.1e6 }, cost_today: { total_usd: 14.2 } });
    check("today: all sessions' tokens; the bar is the session nearest its cap (JOYA AI 82 %: near); the $ estimate beside it", C.totalText === "6.6M" && Math.abs(C.pct - 0.82) < 1e-9 && C.tone === "near" && /^JOYA AI 4\.1M of 5\.0M · 82%$/.test(C.capText) && C.usdText === "≈ $14" && C.stateText === "near its cap", JSON.stringify(C));
    const over = G.cost({ warn_pct: 80, sessions: [{ key: "x", name: "Busy", cap: 1e6, today: { total: 1.2e6 }, state: "paused" }] }, {});
    check("  past a pause cap: full bar, red, 'paused at its cap'; no caps: 'No daily cap set'; before the caps came: JOYA AI's own figure", over.pct === 1 && over.tone === "over" && over.stateText === "paused at its cap" && G.cost({ sessions: [{ key: "a", today: { total: 5 } }] }, {}).capText === "No daily cap set" && G.cost(null, { tokens_today: { total: 1234567 } }).totalText === "1.2M");
    const feed = [
      { key: "n1", ts: iso(-1000), kind: "info", html: "a notice" },
      { key: "ap1", ts: iso(-2000), kind: "approval", html: "<b>Approval needed</b> · rm -rf x" },
      { key: "in1", ts: iso(-3000), kind: "idle", html: '<b>Planning engine</b> → idle <span class="q">Run finished &amp; saved</span>' },
      { key: "s+1", ts: iso(-4000), kind: "session", html: "<b>New</b> started · x" },
      { key: "s-1", ts: iso(-5000), kind: "session", html: "<b>Old</b> ended" },
      { key: "e1", ts: iso(-6000), kind: "error", html: "<b>joya-dashboard.service</b> failed" },
      { key: "w1", ts: iso(-7000), kind: "warn", html: "<b>Audit</b> is waiting" },
      { key: "old", ts: iso(-13 * 3600e3), kind: "error", html: "old" },
    ];
    const al = G.alerts(feed, Date.now());
    check("alerts: needs you, a session done (its idle message, unescaped), ended, errors -- not notices or starts; four at most, newest first", al.length === 4 && al[0].text === "Needs you: rm -rf x" && al[0].tone === "warn" && al[1].text === "Planning engine is done: Run finished & saved" && al[1].tone === "ok" && al[2].text === "Old ended" && al[3].tone === "err", JSON.stringify(al));
    check("  nothing older than 12 hours; 'now' / 'N min' times", G.alerts([feed[7]], Date.now()).length === 0 && G.ago(10e3) === "now" && G.ago(4 * 60e3) === "4 min" && G.ago(3 * 3600e3) === "3 h");
  }

  section("the app's half (desktop/src-tauri): setting, tray, command, permissions, Settings window");
  {
    const lib = fs.readFileSync(path.join(D, "src-tauri", "src", "lib.rs"), "utf8");
    const st = fs.readFileSync(path.join(D, "src-tauri", "src", "settings.rs"), "utf8");
    const remote = JSON.parse(fs.readFileSync(path.join(D, "src-tauri", "capabilities", "remote.json"), "utf8"));
    const build = fs.readFileSync(path.join(D, "src-tauri", "build.rs"), "utf8");
    const sh = fs.readFileSync(path.join(D, "dist", "settings.html"), "utf8");
    const sj = fs.readFileSync(path.join(D, "dist", "settings.js"), "utf8");
    check("the setting: glance on by default; a pin per monitor, cleaned (finite, inside the work area)", /glance: true,/.test(st) && /pub glance_pin: Option<Pin>/.test(st) && /fn clean\(x: f64, y: f64\) -> Option<Pin>/.test(st));
    check("the tray: 'Glance cards beside JOYA AI', a check item that toggles it", /CheckMenuItem::with_id\(app, "glance", "Glance cards beside JOYA AI"/.test(lib) && /"glance" => \{/.test(lib));
    check("the page's command set_glance: show / pin / unpin only, granted to the site, listed in build.rs and the handler", /fn set_glance\(app: AppHandle, show: Option<bool>, pin: Option<Pin>, unpin: Option<bool>/.test(lib) && remote.permissions.includes("allow-set-glance") && /"set_glance"/.test(build) && /\n\s+set_glance,\n/.test(lib));
    check("  a pin is taken only in the Desktop layer, and cleaned again in the app", /if a\.settings\.mode != Mode::Desktop \{\s*return;\s*\}/.test(lib) && /Pin::clean\(p\.x, p\.y\)/.test(lib));
    check("the page's state carries glance and the monitor's pin (Desktop layer only); the Floating window is widened only while signed in", /glance: a\.settings\.glance,/.test(lib) && /glance_pin: if a\.settings\.mode == Mode::Desktop/.test(lib) && /a\.settings\.glance && a\.signed_in/.test(lib) && /window_rect\([^)]*glance_room\(&a\)\)/.test(lib));
    check("the Settings window has the switch, read and saved", /id="glance"/.test(sh) && /S\.glance = \$\("glance"\)\.checked/.test(sj) && /\$\("glance"\)\.checked = S\.glance !== false/.test(sj));
    check("still nothing that runs a program or reads a file in what the site may call", !remote.permissions.some((p) => /machine|settings-set|go-site|shell|fs:/.test(p)));
  }

  /* ================================================================ the browser */
  const PW = process.env.PLAYWRIGHT || "playwright";
  let chromium = null;
  try { ({ chromium } = require(PW)); } catch (e) { check("playwright is there (set PLAYWRIGHT)", false, e.message); }
  if (!chromium) return finish();

  await new Promise((r) => server.listen(SOCK, r));
  const PORT = 3650 + Math.floor(Math.random() * 60);
  const ORIGIN = `http://a.localhost:${PORT}`;
  let s, browser;
  const problems = [];
  try {
    s = await scratch.startScratch({ port: PORT, env: { JOYA_AI_SOCKET: SOCK, JOYA_PASSKEY_ORIGINS: ORIGIN } });
    const sqlite = require("better-sqlite3");
    const db = new sqlite(path.join(s.data, "joya.db"));
    await s.makeUser("alice", "administrator");
    const aliceId = db.prepare("SELECT id FROM users WHERE username = 'alice'").get().id;
    const { privateKey, publicKey } = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
    const jwk = publicKey.export({ format: "jwk" });
    const cose = Buffer.concat([Buffer.from([0xa5, 0x01, 0x02, 0x03, 0x26, 0x20, 0x01, 0x21, 0x58, 0x20]), Buffer.from(jwk.x, "base64url"), Buffer.from([0x22, 0x58, 0x20]), Buffer.from(jwk.y, "base64url")]);
    const credId = crypto.randomBytes(32);
    db.prepare("INSERT INTO passkeys (user_id, credential_id, public_key, counter, transports, rp_id, name, aaguid, device_type, backed_up, created_at) VALUES (?, ?, ?, 0, '[\"internal\"]', 'a.localhost', 'Laptop Windows Hello', '', 'singleDevice', 0, ?)")
      .run(aliceId, credId.toString("base64url"), cose, new Date().toISOString());
    const { cookie } = await s.signIn("alice");
    browser = await chromium.launch({ args: ["--host-resolver-rules=MAP *.localhost 127.0.0.1", "--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });

    /** A page in the app's render mode. host: a mocked app bridge (records invoke calls; get_state answers `host`). */
    async function open(w, h, q, o) {
      o = o || {};
      const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: o.dpr || 1, userAgent: APP_UA, extraHTTPHeaders: { "X-Forwarded-Proto": "https" } });
      await ctx.addCookies(String(cookie).split("; ").filter(Boolean).map((kv) => ({ name: kv.split("=")[0], value: kv.slice(kv.indexOf("=") + 1), url: ORIGIN })));
      const page = await ctx.newPage();
      await page.addInitScript((host) => {
        window.__csp = [];
        document.addEventListener("securitypolicyviolation", (e) => window.__csp.push(e.violatedDirective + " " + e.blockedURI));
        if (!host) return;
        window.__calls = [];
        const L = (window.__listeners = {});
        window.__TAURI__ = {
          core: { invoke: (cmd, args) => { window.__calls.push([cmd, args || {}]); return Promise.resolve(cmd === "get_state" ? host : null); } },
          event: { listen: (n, f) => { (L[n] = L[n] || []).push(f); return Promise.resolve(() => {}); } },
        };
        window.__emit = (n, p) => (L[n] || []).forEach((f) => f({ payload: p }));
      }, o.host || null);
      const tag = q + (o.host ? " (host)" : "");
      page.on("pageerror", (e) => problems.push(tag + ": pageerror " + e.message));
      page.on("console", (m) => { if (m.type() === "error" && !/status of (428|404|503)|Failed to load resource|EventSource/.test(m.text())) problems.push(tag + ": console " + m.text()); });
      let cdp = null, auth = null;
      if (o.hello) {
        cdp = await ctx.newCDPSession(page);
        await cdp.send("WebAuthn.enable");
        auth = (await cdp.send("WebAuthn.addVirtualAuthenticator", { options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } })).authenticatorId;
        await cdp.send("WebAuthn.addCredential", { authenticatorId: auth, credential: { credentialId: credId.toString("base64"), isResidentCredential: false, rpId: "a.localhost", privateKey: privateKey.export({ type: "pkcs8", format: "der" }).toString("base64"), signCount: 0 } });
      }
      await page.goto(ORIGIN + "/joya-ai?shell=desktop&" + q, { waitUntil: "load" });
      await page.waitForFunction(() => window.__joyaCC && window.__joyaCC.S && window.__joyaCC.S.online && window.__joyaCC.S.sessions.length > 1, null, { timeout: 15000 });
      await page.waitForFunction(() => !document.getElementById("dk-glance") || document.getElementById("dk-glance").hidden || document.querySelectorAll("#dk-gl-cards > *").length >= 4, null, { timeout: 8000 }).catch(() => {});
      await page.waitForFunction(() => { const g = window.JoyaDesktop.glance(); return !g.on || !!g.caps; }, null, { timeout: 8000 }).catch(() => {});
      // Approvals already waiting open the big decision card at once, and the glance approval cards step back
      // while it is open; most checks below want them, so the card is put away ("Later") unless asked to stay.
      if (!o.keepCard) await later(page);
      await page.waitForTimeout(400);
      return { ctx, page, cdp, auth, close: async () => { const c = await page.evaluate(() => window.__csp).catch(() => []); c.forEach((x) => problems.push(tag + ": CSP " + x)); await ctx.close(); } };
    }
    async function later(page) {
      await page.waitForFunction(() => !document.getElementById("cc-need").hidden, null, { timeout: 3000 }).catch(() => {});
      await page.evaluate(() => { const n = document.getElementById("cc-need"); if (n.hidden) return; const b = Array.from(n.querySelectorAll("[data-need-act]")).find((x) => /^\s*later\s*$/i.test(x.textContent)); if (b) b.click(); });
      await page.waitForFunction(() => document.getElementById("cc-need").hidden, null, { timeout: 3000 }).catch(() => {});
      await sleep(150);
    }
    const info = (page) => page.evaluate(() => {
      const g = document.getElementById("dk-glance"), cards = [...document.querySelectorAll("#dk-glance .dk-gl-hit")];
      return {
        on: !!g && !g.hidden, rect: g && !g.hidden ? g.getBoundingClientRect().toJSON() : null,
        cards: cards.map((c) => { const w = document.createTreeWalker(c, NodeFilter.SHOW_TEXT), t = []; while (w.nextNode()) t.push(w.currentNode.nodeValue); return { cls: c.className, r: c.getBoundingClientRect().toJSON(), text: t.join(" ").replace(/\s+/g, " ").trim() }; }),
        regions: window.JoyaDesktop.regions(), btn: !document.getElementById("dk-glbtn").hidden, pressed: document.getElementById("dk-glbtn").getAttribute("aria-pressed"),
        L: window.JoyaDesktop.layout(), calls: window.__calls || [],
      };
    });

    section("Floating, the cards beside the box (748 x 860, ?glance=1)");
    {
      const v = await open(748, 860, "mode=floating&glance=1");
      let i = await info(v.page);
      const txt = i.cards.map((c) => c.text).join(" | ");
      check("the column is on the left of the box, in the layout's place", i.on && Math.round(i.rect.x) === 0 && Math.round(i.rect.width) === 256 && i.L.box.x === 268, JSON.stringify(i.rect));
      check("  the cards: header, two approvals (soonest first), sessions, today, live", /At a glance/.test(i.cards[0].text) && /Needs you · JOYA AI.*rm -rf \/srv\/old-builds/.test(i.cards[1].text) && /Needs you · Planning engine.*systemctl restart odoo/.test(i.cards[2].text) && /Sessions/.test(i.cards[3].text) && /Today/.test(i.cards[4].text) && /Live/.test(i.cards[5].text), txt);
      check("  approvals carry Approve / Deny / Open and the countdown", (await v.page.locator("#dk-glance [data-gl-approve]").count()) === 2 && (await v.page.locator("#dk-glance [data-gl-deny]").count()) === 2 && /\d:\d\d/.test(i.cards[1].text));
      check("  sessions: 2 working, 0 waiting, 2 idle; the names at work", /2\s*working/.test(i.cards[3].text) && /0\s*waiting on you/.test(i.cards[3].text) && /2\s*idle/.test(i.cards[3].text) && /Planning engine/.test(i.cards[3].text) && /Invoice audit/.test(i.cards[3].text), i.cards[3].text);
      check("  today: 6.6M tokens, JOYA AI near its 5M cap, the $ estimate", /6\.6M/.test(i.cards[4].text) && /JOYA AI 4\.1M of 5\.0M · 82%/.test(i.cards[4].text) && /near its cap/.test(i.cards[4].text) && /≈ \$14/.test(i.cards[4].text), i.cards[4].text);
      const bar = await v.page.evaluate(() => getComputedStyle(document.querySelector(".dk-gl-bar i")).transform);
      check("  the bar drawn at 82 % (through the CSSOM: no inline style in the markup)", /matrix\(0\.82/.test(bar), bar);
      check("  live: the session that finished while you were away", /Customs docs is done: Filed the October declarations/.test(i.cards[5].text), i.cards[5].text);
      // Hit regions: every card is one; the gaps between them and the empty column above are not.
      const inAny = (x, y) => i.regions.some((r) => inside(r, x, y));
      const dbg = await v.page.evaluate(() => [...document.querySelectorAll("#dk-glance .dk-gl-hit")].map((e) => [e.className, getComputedStyle(e).opacity, e.getAnimations().length, getComputedStyle(e).visibility]));
      const allCards = i.cards.every((c) => inAny(c.r.x + c.r.width / 2, c.r.y + c.r.height / 2) && inAny(c.r.x + 3, c.r.y + 3));
      const gaps = i.cards.slice(1).map((c, k) => [i.cards[k].r.x + 128, (i.cards[k].r.bottom + c.r.top) / 2]);
      check("hit regions: each card catches the mouse", allCards, JSON.stringify(i.regions) + JSON.stringify(dbg));
      check("  the 8 px gaps between cards and the empty column above them let clicks through", gaps.every((p) => !inAny(p[0], p[1])) && !inAny(128, Math.max(4, i.cards[0].r.top - 30)), JSON.stringify(gaps));
      check("  the rim button is there, pressed (the cards are on)", i.btn && i.pressed === "true");
      // Keyboard: Tab reaches the cards' buttons in reading order; Esc leaves them.
      await v.page.focus("#dk-glbtn");
      const order = [];
      for (let k = 0; k < 9; k++) { await v.page.keyboard.press("Tab"); order.push(await v.page.evaluate(() => { const a = document.activeElement; return a ? (a.getAttribute("data-gl-fid") || a.getAttribute("data-gl") || a.id || a.tagName) : ""; })); }
      check("keyboard: Tab from the rim button goes through the header (hide) and then each card's buttons, top to bottom", order.indexOf("hide") >= 0 && order.indexOf("ap41a") > order.indexOf("hide") && order.indexOf("ap41d") === order.indexOf("ap41a") + 1 && order.indexOf("ap42a") > order.indexOf("ap41o"), order.join(","));
      await v.page.focus('[data-gl-fid="ap41d"]');
      await v.page.keyboard.press("Escape");
      check("  Esc in the cards leaves them", await v.page.evaluate(() => !document.getElementById("dk-glance").contains(document.activeElement)));
      const labels = await v.page.evaluate(() => [document.getElementById("dk-glance").getAttribute("aria-label"), [...document.querySelectorAll("#dk-glance [role=group]")].map((g) => g.getAttribute("aria-label"))]);
      check("screen readers: the column and every card are labelled", /At a glance/.test(labels[0]) && labels[1].length === 5 && labels[1].every(Boolean) && /Sessions: 2 working, 0 waiting on you, 2 idle/.test(labels[1].join("|")), JSON.stringify(labels));

      // Live: the supervisor's events reach the cards through the page's own stream.
      W.sessions[3] = { ...W.sessions[3], status: "waiting", waiting_for: "your approval" };
      push("sessions", { sessions: W.sessions });
      push("inbound", { inbound: { id: 8, kind: "idle", from_name: "Planning engine", text: "October allocation run finished: 41 orders, 198,952 kg.", received_at: new Date().toISOString() } });
      const a43 = approval(43, "Remove-Item C:\\Users\\amr\\Downloads\\old.zip", "session:laptop", "Laptop session", 6);
      W.approvals.push(a43);
      push("approval", { approval: a43 });
      await later(v.page); // a new approval opens the big card; put it away to see the glance cards
      await v.page.waitForFunction(() => /1\s*waiting on you/.test(document.querySelector("#dk-glance .dk-gl-se").innerText), null, { timeout: 5000 }).catch(() => {});
      await sleep(400);
      i = await info(v.page);
      const all = i.cards.map((c) => c.text).join(" | ");
      check("live update: a session now waiting on you -- counted, named first", /1\s*waiting on you/.test(all) && /Invoice audit waiting for your approval/.test(all), all);
      check("  the planning engine's run finishing shows as an alert (its 'idle' message)", /Planning engine is done: October allocation run finished/.test(all), all);
      check("  the new approval joins (still two cards: '+1 more waiting')", /\+1 more waiting/.test(all) && (await v.page.locator("#dk-glance [data-gl-approve]").count()) === 2, all);
      check("  the screen reader hears the newest line once", /needs your approval|is done|waiting/.test(await v.page.evaluate(() => document.getElementById("dk-gl-live").textContent)));
      const capCalls = seen.filter((m) => m.op === "token-caps").length;
      check("  the caps are read once on open, not on every event (no polling faster than today's)", capCalls >= 1 && capCalls <= 2, capCalls);
      await v.close();
    }

    section("Step-back: while the big decision card is open, the glance approval cards step back");
    {
      const v = await open(748, 860, "mode=floating&glance=1", { keepCard: true });
      const st = (page) => page.evaluate(() => ({
        need: !document.getElementById("cc-need").hidden, ap: document.querySelectorAll("#dk-glance .dk-gl-ap").length,
        none: document.querySelectorAll('#dk-glance [data-gl-key="ap-none"]').length, text: document.getElementById("dk-glance").innerText,
        hits: window.JoyaDesktop.regions(), apRects: Array.from(document.querySelectorAll("#dk-glance .dk-gl-ap")).map((e) => e.getBoundingClientRect().toJSON()),
      }));
      let s1 = await st(v.page);
      check("approvals waiting at load: the decision card is open and the glance has no approval card", s1.need && s1.ap === 0 && s1.none === 0, JSON.stringify({ need: s1.need, ap: s1.ap }));
      check("  the other cards stay: sessions, today, live", /Sessions/i.test(s1.text) && /Today/i.test(s1.text) && /Live/i.test(s1.text), s1.text);
      if (SHOTS) { fs.mkdirSync(SHOTS, { recursive: true }); fs.writeFileSync(path.join(SHOTS, "stepback-card-open.png"), await v.page.screenshot({ omitBackground: true })); }
      await later(v.page);
      s1 = await st(v.page);
      check("the card put away (Later): the two approval cards come back", !s1.need && s1.ap === 2, JSON.stringify({ need: s1.need, ap: s1.ap }));
      check("  each a hit region again", s1.apRects.length === 2 && s1.apRects.every((r) => s1.hits.some((g) => inside(g, r.x + r.width / 2, r.y + r.height / 2))));
      if (SHOTS) fs.writeFileSync(path.join(SHOTS, "stepback-card-closed.png"), await v.page.screenshot({ omitBackground: true }));
      const a44 = approval(44, "git push --force origin main", "session:planning", "Planning engine", 7);
      W.approvals.push(a44);
      push("approval", { approval: a44 });
      await v.page.waitForFunction(() => !document.getElementById("cc-need").hidden, null, { timeout: 5000 }).catch(() => {});
      await sleep(300);
      s1 = await st(v.page);
      check("a new approval arrives: the decision card opens on it and the glance approval cards step back again", s1.need && s1.ap === 0 && /Sessions/i.test(s1.text), JSON.stringify({ need: s1.need, ap: s1.ap }));
      await later(v.page);
      s1 = await st(v.page);
      check("  closed again: back, with the new one counted", !s1.need && s1.ap === 2 && /\+\d+ more waiting/i.test(s1.text), JSON.stringify({ need: s1.need, ap: s1.ap, t: s1.text.replace(/\s+/g, " ") }));
      W.approvals = W.approvals.filter((a) => a.id !== 44);
      await v.close();
    }

    section("Approve -> Windows Hello (step-up) -> approved; Deny; Open; a session");
    {
      const v = await open(748, 860, "mode=floating&glance=1", { hello: true });
      // The server still enforces: an approve with no proof is refused.
      const raw = await v.page.evaluate(() => fetch("/joya-ai/api/approvals/41/approve", { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json", "X-CSRF-Token": document.getElementById("cc").getAttribute("data-csrf") }, body: "{}" }).then((r) => r.status));
      check("the server refuses an approve that carries no proof (428 or 403), whatever the page does", raw === 428 || raw === 403, raw);
      check("  and nothing reached the supervisor", !seen.some((m) => m.op === "approve"));
      await v.page.click('#dk-glance [data-gl-approve="41"]');
      for (let k = 0; k < 40 && !seen.some((m) => m.op === "approve"); k++) await sleep(150);
      const ap = seen.filter((m) => m.op === "approve");
      check("Approve on the glance card -> the Windows Hello dialog -> the supervisor gets approve #41 with verified=hello", ap.length === 1 && ap[0].approval_id === 41 && ap[0].verified === "hello", JSON.stringify(ap));
      await sleep(600);
      check("  the card leaves the column; the dialog closed", !(await v.page.locator('#dk-glance [data-gl-approve="41"]').count()) && (await v.page.locator(".joya-su").count()) === 0);
      // Hello cannot answer (no passkey on the device): the dialog stays, with the code fallback.
      await v.cdp.send("WebAuthn.clearCredentials", { authenticatorId: v.auth });
      await v.page.click('#dk-glance [data-gl-approve="42"]');
      await v.page.waitForSelector(".joya-su", { timeout: 5000 });
      const busy = await v.page.locator('#dk-glance [data-gl-approve="42"]').isDisabled();
      check("Hello failing: the dialog is up over the window (it catches the mouse) and the card waits, its buttons off", busy && (await v.page.evaluate(() => window.JoyaDesktop.regions().length === 1 && window.JoyaDesktop.regions()[0].w === innerWidth)), busy);
      await v.page.waitForFunction(() => /cancelled or timed out|no passkey/.test((document.querySelector(".joya-su-st") || {}).textContent || ""), null, { timeout: 70000 }).catch(() => {});
      if (SHOTS) { fs.mkdirSync(SHOTS, { recursive: true }); fs.writeFileSync(path.join(SHOTS, "_hello.png"), await v.page.screenshot({ omitBackground: true })); }
      check("  nothing approved", seen.filter((m) => m.op === "approve").length === 1);
      await v.page.keyboard.press("Escape");
      await v.page.waitForFunction(() => !document.querySelector(".joya-su"), null, { timeout: 4000 }).catch(() => {});
      await sleep(300);
      check("  Esc closes the dialog; the card says it was not approved and can be tried again", /Not approved/.test(await v.page.locator('#dk-glance [data-gl-key="ap42"]').innerText()) && !(await v.page.locator('#dk-glance [data-gl-approve="42"]').isDisabled()));
      await v.page.click('#dk-glance [data-gl-deny="42"]');
      for (let k = 0; k < 30 && !seen.some((m) => m.op === "deny"); k++) await sleep(150);
      check("Deny: straight through, no Windows Hello (the supervisor gets deny #42)", seen.some((m) => m.op === "deny" && m.approval_id === 42));
      await sleep(500);
      await v.page.click('#dk-glance [data-gl-open="43"]');
      await sleep(400);
      check("Open: the decision card, on that approval", await v.page.evaluate(() => !document.getElementById("cc-need").hidden && /Remove-Item/.test(document.getElementById("cc-need").innerText)));
      {
        const step = await v.page.evaluate(() => ({
          ap: document.querySelectorAll("#dk-glance .dk-gl-ap").length, none: document.querySelectorAll('#dk-glance [data-gl-key="ap-none"]').length,
          keys: Array.from(document.querySelectorAll("#dk-glance [data-gl-key]")).map((e) => e.getAttribute("data-gl-key")),
          text: document.getElementById("dk-glance").innerText,
          hit: window.JoyaDesktop.regions().length,
        }));
        check("step-back: while the decision card is open, the glance approval cards are gone (no 'No approvals' card either)", step.ap === 0 && step.none === 0, JSON.stringify(step.keys));
        check("  the other cards stay: sessions, today, live", /Sessions/i.test(step.text) && /Today/i.test(step.text) && /Live/i.test(step.text), step.text);
        await v.page.evaluate(() => { const b = Array.from(document.querySelectorAll("#cc-need [data-need-act]")).find((x) => /later/i.test(x.textContent)); if (b) b.click(); });
        await sleep(400);
        const back = await v.page.evaluate(() => ({ need: document.getElementById("cc-need").hidden, ap: document.querySelectorAll("#dk-glance .dk-gl-ap").length, open43: !!document.querySelector('#dk-glance [data-gl-open="43"]') }));
        check("  the decision card closed (Later): the approval cards are back", back.need && back.ap >= 1 && back.open43, JSON.stringify(back));
        const rg = await v.page.evaluate(() => { const r = document.querySelector('#dk-glance [data-gl-key="ap43"]').getBoundingClientRect(); return window.JoyaDesktop.regions().some((g) => r.x + r.width / 2 >= g.x && r.x + r.width / 2 < g.x + g.w && r.y + r.height / 2 >= g.y && r.y + r.height / 2 < g.y + g.h); });
        check("  and the returned card is a hit region again", rg);
        await v.page.click('#dk-glance [data-gl-open="43"]');
        await sleep(400);
      }
      await v.page.click("#dk-glance [data-gl-sess]");
      await sleep(500);
      // since 2026-10-20 opening a session shows its story (cc-story.js), whose Live mirror is the deep view
      check("a session's name opens it (its story, or the deep view)", await v.page.evaluate(() => !!document.querySelector(".cc-deep") || !!document.querySelector("#cc-story:not([hidden])")));
      await v.close();
    }

    section("hide / show, focus mode, hold still, the app's bridge, pin / unpin");
    {
      // With the app: its state turns the cards on; the X hides them and tells the app.
      const host = { mode: "floating", glance: true, pos: "br", liveKey: "Ctrl+Alt+L", talkKey: "Ctrl+Space" };
      let v = await open(748, 860, "", { host });
      let i = await info(v.page);
      check("in the app: on from its state (no ?glance), the column beside the box", i.on && i.L.glance && i.L.box.x === 268);
      await v.page.click('#dk-glance [data-gl="hide"]');
      await sleep(200);
      i = await info(v.page);
      check("  the X: hidden, the app told (set_glance show:false: it saves and narrows the window), focus on the rim button", !i.on && i.calls.some((c) => c[0] === "set_glance" && c[1].show === false) && i.pressed === "false" && (await v.page.evaluate(() => document.activeElement && document.activeElement.id)) === "dk-glbtn");
      check("  no card is a hit region any more", !i.regions.some((r) => r.x < 256 && r.w === 256));
      await v.page.click("#dk-glbtn");
      await sleep(200);
      i = await info(v.page);
      check("  the rim button brings them back (set_glance show:true)", i.on && i.calls.some((c) => c[0] === "set_glance" && c[1].show === true));
      await v.page.evaluate(() => window.__emit("joya://state", { focus: true }));
      await sleep(250);
      i = await info(v.page);
      check("focus mode (the app's state): no cards, no rim button", !i.on && !i.btn);
      await v.page.evaluate(() => window.__emit("joya://state", { focus: false, glance: false }));
      await sleep(200);
      check("  the tray's switch (state glance:false): hidden", !(await info(v.page)).on);
      await v.close();

      // Hold still: nothing animates when a card comes or an alert arrives.
      v = await open(748, 860, "mode=floating&glance=1&still=1");
      push("inbound", { inbound: { id: 9, kind: "idle", from_name: "Freight quotes", text: "Three quotes in.", received_at: new Date().toISOString() } });
      await sleep(700);
      const anims = await v.page.evaluate(() => [...document.querySelectorAll("#dk-glance *")].reduce((n, e) => n + e.getAnimations().length, 0));
      check("hold still (battery saver): a live update arrives with no animation", anims === 0 && /Freight quotes is done/.test(await v.page.locator("#dk-glance .dk-gl-al").innerText()), anims);
      await v.close();

      // The Desktop layer with the app: drag the header -> pinned there (fractions, per monitor); unpin.
      const dh = { mode: "desktop", glance: true, pos: "right", liveKey: "Ctrl+Alt+L", talkKey: "Ctrl+Space" };
      v = await open(1920, 1032, "", { host: dh });
      i = await info(v.page);
      const before = i.rect;
      check("Desktop layer: beside the core, left of it; Pin shown", i.on && i.L.glance.side === "left" && !i.L.glance.pinned && (await v.page.locator("#dk-gl-pin").isVisible()), JSON.stringify(i.L.glance));
      const hd = await v.page.locator("#dk-gl-hd").boundingBox();
      await v.page.mouse.move(hd.x + 60, hd.y + 15);
      await v.page.mouse.down();
      const mid = await v.page.evaluate(() => window.JoyaDesktop.regions());
      await v.page.mouse.move(hd.x + 60 - 400, hd.y + 15 - 150, { steps: 8 });
      const during = await v.page.evaluate(() => window.JoyaDesktop.regions());
      await v.page.mouse.up();
      await sleep(250);
      i = await info(v.page);
      const pinCall = i.calls.filter((c) => c[0] === "set_glance" && c[1].pin).pop();
      check("dragging the header: the whole window catches the mouse while it moves (the drag never falls through)", during.length === 1 && during[0].w === 1920 && mid.length === 1);
      check("  dropped: pinned there, the app told the place as fractions of the work area", pinCall && Math.abs(pinCall[1].pin.x * 1920 - (before.x - 400)) < 2 && Math.abs(pinCall[1].pin.y * 1032 - (before.y - 150)) < 2 && i.L.glance.pinned && Math.abs(i.rect.x - (before.x - 400)) < 2, JSON.stringify({ pinCall, before, now: i.rect }));
      check("  back to only the cards as hit regions after the drop", i.regions.length > 1);
      await v.page.focus("#dk-gl-grip");
      await v.page.keyboard.press("ArrowRight");
      await sleep(150);
      const kb = (await info(v.page)).calls.filter((c) => c[0] === "set_glance" && c[1].pin).pop();
      check("  the arrow keys on the header move it too (16 px), pinned", kb && Math.abs(kb[1].pin.x * 1920 - (before.x - 400 + 16)) < 2);
      if (SHOTS) fs.writeFileSync(path.join(SHOTS, "_pinned-host.png"), await v.page.screenshot({ omitBackground: true }));
      await v.page.click("#dk-gl-pin");
      await sleep(250);
      i = await info(v.page);
      check("Unpin: back beside the core, the app told (unpin)", !i.L.glance.pinned && Math.abs(i.rect.x - before.x) < 1 && i.calls.some((c) => c[0] === "set_glance" && c[1].unpin === true));
      await v.close();
      // The app remembers the pin per monitor: its state brings it back on the next start, on that monitor.
      v = await open(1920, 1032, "", { host: Object.assign({}, dh, { glancePin: { x: 0.04, y: 0.08 } }) });
      i = await info(v.page);
      check("  a pin from the app's state (this monitor's): the cards start there", i.L.glance.pinned && Math.abs(i.rect.x - 0.04 * 1920) < 1 && Math.abs(i.rect.y - 0.08 * 1032) < 1, JSON.stringify(i.rect));
      await v.close();
      v = await open(748, 860, "", { host: Object.assign({}, host, { glancePin: { x: 0.04, y: 0.08 } }) });
      check("  Floating ignores a pin (the cards stay beside the box) and has no Pin button", !(await info(v.page)).L.glance.pinned && !(await v.page.locator("#dk-gl-pin").isVisible()));
      await v.close();
    }

    section("scaling (the window in CSS px at 100 / 125 / 150 %) and the second monitor");
    for (const [w, h, dpr, nm] of [[1920, 1032, 1, "100 %"], [1536, 824, 1.25, "125 %"], [1280, 688, 1.5, "150 %"], [2560, 1380, 1, "2560x1440"]]) {
      const v = await open(w, h, "mode=desktop&glance=1", { dpr });
      const i = await info(v.page);
      const last = i.cards[i.cards.length - 1].r;
      const coreClear = i.cards.every((c) => c.r.right <= i.L.cx - i.L.R + 1 || c.r.left >= i.L.cx + i.L.R - 1);
      check(`Desktop layer at ${nm}: all four cards on screen, clear of the core, each a hit region`, i.on && i.cards.length >= 5 && last.bottom <= h && i.cards.every((c) => c.r.left >= 0 && c.r.right <= w) && coreClear && i.cards.every((c) => i.regions.some((r) => inside(r, c.r.x + c.r.width / 2, c.r.y + c.r.height / 2))), JSON.stringify({ rect: i.rect, last }));
      await v.close();
    }
    section("the morning: the brief joins the column first; a column it overflows scrolls, and catches the mouse only where it shows");
    {
      // The scratch server writes no scheduled brief (scratch-server.cjs patchBriefClock): this one is written
      // here, so the morning is tested at any hour. 2026-10-21: a cut card's region ran past the column's end.
      const store = require(path.join(ROOT, "lib", "proactive-store.js")).create(db);
      const brief = store.addInbox(aliceId, "brief", "Morning brief", {
        lines: [{ k: "Needs you", text: "Customs docs is waiting on you 25 min", tone: "warn" }, { k: "Planning engine", text: "working 1 h 35 min", tone: "info", sid: W.sessions[1].session_id }, { k: "Spend", text: "≈ $14.20 today", tone: "ok" }, { k: "Check", text: "Invoice audit idle 3 h", tone: "info" }, { k: "Finished", text: "Freight quotes sent three quotes", tone: "ok" }],
        speech: "Good morning.", source: "template",
      });
      for (const [w, h, dpr, nm] of [[1536, 824, 1.25, "125 %"], [1280, 688, 1.5, "150 %"]]) {
        const v = await open(w, h, "mode=desktop&glance=1", { dpr });
        await v.page.waitForFunction(() => document.querySelector("#dk-gl-cards .dk-gl-pa"), null, { timeout: 6000 }).catch(() => {});
        await sleep(300);
        const i = await info(v.page);
        const col = i.rect;
        const scrolls = await v.page.evaluate(() => { const g = document.getElementById("dk-glance"); return g.scrollHeight > g.clientHeight + 1; });
        const first = await v.page.evaluate(() => { const c = document.querySelector("#dk-gl-cards > *"); return !!c && c.classList.contains("dk-gl-pa"); });
        const coreClear = i.cards.every((c) => c.r.right <= i.L.cx - i.L.R + 1 || c.r.left >= i.L.cx + i.L.R - 1);
        // The regions at the column's x: none may reach above or below the column (nothing is drawn there).
        const colRegs = i.regions.filter((r) => r.x < col.right && r.x + r.w > col.left && !(r.x >= i.L.cx - i.L.R - 1 && r.x + r.w <= i.L.cx + i.L.R + 1));
        const outside = colRegs.filter((r) => r.y < Math.floor(col.top) || r.y + r.h > Math.ceil(col.bottom));
        // Probed in the middle of the part that shows (2026-10-25: at 16 px a card can peek a few px over the column's end).
        const shownCards = i.cards.filter((c) => c.r.bottom > col.top + 1 && c.r.top < col.bottom - 1);
        check(`${nm}: the brief is the first card; the column (taller than the window allows) scrolls; clear of the core`, i.on && first && scrolls && coreClear, JSON.stringify({ first, scrolls, col }));
        check(`  ${nm}: every card that shows catches the mouse where it shows; no region outside the column`, shownCards.every((c) => i.regions.some((r) => inside(r, c.r.x + c.r.width / 2, (Math.max(c.r.top, col.top) + Math.min(c.r.bottom, col.bottom)) / 2))) && outside.length === 0, JSON.stringify({ col, outside }));
        await v.close();
      }
      db.prepare("UPDATE proactive_inbox SET dismissed_at = ? WHERE id = ?").run(new Date().toISOString(), brief.id);
      const v = await open(1280, 688, "mode=desktop&glance=1", { dpr: 1.5 });
      check("  dismissed: the column is back to the day's cards", !(await v.page.evaluate(() => !!document.querySelector("#dk-gl-cards .dk-gl-pa"))));
      await v.close();
    }
    {
      const v = await open(1122 / 1.5, 1290 / 1.5, "mode=floating&glance=1", { dpr: 1.5 });
      const i = await info(v.page);
      check("Floating at 150 % (the app's 1122 x 1290 px window = 748 x 860 CSS px): the same layout", i.on && Math.round(i.rect.width) === 256 && i.L.box.x === 268);
      await v.close();
    }

    section("real blur under the glance cards (0.1.10: the grey corners and strips of 0.1.9)");
    {
      // The laptop's case: Desktop layer at 150 %, the cards pinned, real blur on. The page's reports
      // (set_blur_rects) are recorded while the cards change -- a session's state, a new alert, an
      // approval arriving and being put away -- and replayed through the app's two pool rules:
      //   0.1.9:  slot i takes placement i, its shown window moved / resized there (SetWindowPos);
      //   0.1.10: a shown window keeps its exact place or is destroyed; a new place gets a fresh window
      //           (blur::plan, tested in Rust: the_glance_cards_settling_never_move_a_shown_window).
      // Windows draws the acrylic of a window moved or resized while shown late or not at all (the
      // window-vibrancy crate's documented acrylic lag on Windows 10 1903+ / 11, and why acrylic.rs already
      // hides the blur while the box is dragged). Modelled at its worst: such a window keeps drawing
      // where it was shown. Then no blur may be drawn outside the cards.
      const dh = { mode: "desktop", glance: true, glass: true, pos: "right", liveKey: "Ctrl+Alt+L", talkKey: "Ctrl+Space", glancePin: { x: 0.04, y: 0.08 } };
      const v = await open(1280, 688, "", { host: dh, dpr: 1.5 });
      await sleep(600);
      const reports = async () => (await v.page.evaluate(() => window.__calls.filter((c) => c[0] === "set_blur_rects").map((c) => c[1])));
      // The cards wholly in the column (at 150 % on a 1080p screen the last one may scroll past its end).
      const surfaces = () => v.page.evaluate(() => { const col = document.getElementById("dk-glance").getBoundingClientRect(); return [...document.querySelectorAll("#dk-glance .dk-gl-hit")].map((e) => { const r = e.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height, r: parseFloat(getComputedStyle(e).borderTopLeftRadius) || 0, whole: r.top >= col.top - 0.5 && r.bottom <= col.bottom + 0.5 }; }); });
      const settle = async () => { await sleep(700); };
      // The changes the laptop sees in a day.
      W.sessions[2] = { ...W.sessions[2], status: "busy" };
      push("sessions", { sessions: W.sessions });
      await settle();
      push("inbound", { inbound: { id: 21, kind: "idle", from_name: "Customs docs", text: "Filed the November declarations and the certificate of origin.", received_at: new Date().toISOString() } });
      await settle();
      W.sessions[2] = { ...W.sessions[2], status: "idle" };
      push("sessions", { sessions: W.sessions });
      await settle();
      const a51 = approval(51, "rm -rf /srv/old-builds/2026-08", "joya-ai", "JOYA AI", 6);
      W.approvals.push(a51);
      push("approval", { approval: a51 });
      await settle();
      await later(v.page); // the big card put away: the approval card comes into the column, the others move down
      await settle();
      const reps = await reports();
      const cards = await surfaces();
      const last = reps[reps.length - 1];
      const view = await v.page.evaluate(() => [window.innerWidth, window.innerHeight]);
      check("every report carries the viewport it was measured in", reps.length > 3 && reps.every((r) => Array.isArray(r.view) && r.view.length === 2) && JSON.stringify(last.view) === JSON.stringify(view), JSON.stringify(reps.map((r) => r.view)));
      const near = (a, b) => Math.abs(a.x - b.x) <= 0.5 && Math.abs(a.y - b.y) <= 0.5 && Math.abs(a.w - b.w) <= 0.5 && Math.abs(a.h - b.h) <= 0.5;
      const whole = cards.filter((c) => c.whole), cutOff = cards.filter((c) => !c.whole);
      check("  settled: the last report has every whole glance card exactly (none left out, none stale); a card the column cuts has none", whole.length >= 5 && whole.every((c) => last.rects.some((g) => near(g, c))) && cutOff.every((c) => !last.rects.some((g) => Math.abs(g.x - c.x) <= 0.5 && Math.abs(g.y - c.y) <= 0.5)), JSON.stringify({ cards, last: last.rects }));
      // The two pool rules, replayed (CSS px; blur.rs's 1 px inset left out -- it only makes them smaller).
      const same = (a, b) => a && b && a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h && a.r === b.r;
      function replay(fresh) {
        let pool = []; // { at, drawn }
        let moved = 0;
        for (const rep of reps) {
          const next = rep.rects;
          if (!fresh) {
            next.forEach((at, i) => {
              const w = pool[i];
              if (!w) pool[i] = { at, drawn: at };
              else { if (!same(w.at, at)) moved++; pool[i] = { at, drawn: w.drawn }; } // moved while shown: the acrylic stays
            });
            pool = pool.slice(0, next.length);
          } else {
            const left = pool.slice();
            pool = next.map((at) => { const k = left.findIndex((w) => w && same(w.at, at)); if (k >= 0) { const w = left[k]; left[k] = null; return w; } return { at, drawn: at }; });
          }
        }
        // off: a window drawing somewhere other than the card it now belongs to (its own card, not "any card":
        // the step-back and return of the approval cards can put another card where a stale window draws).
        return { moved, drawn: pool.map((w) => w.drawn), off: pool.filter((w) => !same(w.at, w.drawn)).map((w) => w.drawn) };
      }
      const stray = (drawn) => drawn.filter((d) => !last.rects.some((g) => same(g, d)));
      const old = replay(false), now = replay(true);
      console.log("  replayed " + reps.length + " reports: 0.1.9 moved shown windows " + old.moved + " times; windows drawing off their card: " + old.off.length + "; blur where no card is: " + JSON.stringify(stray(old.drawn)));
      check("reproduced with 0.1.9's rule: shown blur windows were moved while the cards changed, and blur is left off the card it belongs to", old.moved > 0 && old.off.length > 0, JSON.stringify({ moved: old.moved, off: old.off, stray: stray(old.drawn) }));
      check("  with 0.1.10's rule: no shown window is ever moved; every blur drawn is exactly under a card", stray(now.drawn).length === 0 && now.off.length === 0 && now.drawn.length === last.rects.length, JSON.stringify(stray(now.drawn)));
      if (SHOTS) {
        const dir = path.join(SHOTS, "blur-fix");
        fs.mkdirSync(dir, { recursive: true });
        const png = await v.page.screenshot({ omitBackground: true });
        const wallPage = await browser.newPage({ viewport: { width: 1280, height: 688 } });
        const wall = await wallPage.evaluate(paintWallpaper.toString().replace(/^function paintWallpaper/, "(function") + ")(\"dark\",1280,688)");
        for (const [name, drawn] of [["before-0.1.9-stale-blur", old.drawn], ["after-0.1.10", now.drawn]]) {
          await wallPage.setContent("<html><body style=\"margin:0;background:#000\"><canvas id=c width=1920 height=1032></canvas></body></html>");
          await wallPage.setViewportSize({ width: 1920, height: 1032 });
          await wallPage.evaluate(async ([wallSrc, shotSrc, drawn]) => {
            const load = (src) => new Promise((res) => { const i = new Image(); i.onload = () => res(i); i.src = src; });
            const wi = await load(wallSrc), si = await load(shotSrc), k = 1.5;
            const g = document.getElementById("c").getContext("2d");
            g.drawImage(wi, 0, 0, 1920, 1032);
            // the acrylic, as Windows draws it: blurred, a little light (DWM's luminosity), each where its window is drawn
            drawn.forEach((r) => { g.save(); g.beginPath(); g.roundRect(r.x * k, r.y * k, r.w * k, r.h * k, r.r * k); g.clip(); g.filter = "blur(26px) saturate(1.25)"; g.drawImage(wi, 0, 0, 1920, 1032); g.filter = "none"; g.fillStyle = "rgba(200, 206, 220, .30)"; g.fillRect(0, 0, 1920, 1032); g.restore(); });
            g.drawImage(si, 0, 0, 1920, 1032);
          }, [wall, "data:image/png;base64," + png.toString("base64"), drawn]);
          const box = cards.reduce((b, c) => ({ x0: Math.min(b.x0, c.x), y0: Math.min(b.y0, c.y), x1: Math.max(b.x1, c.x + c.w), y1: Math.max(b.y1, c.y + c.h) }), { x0: 1e9, y0: 1e9, x1: 0, y1: 0 });
          const clip = { x: Math.max(0, box.x0 * 1.5 - 60), y: Math.max(0, box.y0 * 1.5 - 60), width: Math.min(1920, (box.x1 - box.x0) * 1.5 + 120), height: Math.min(1032 - Math.max(0, box.y0 * 1.5 - 60), (box.y1 - box.y0) * 1.5 + 200) };
          await wallPage.screenshot({ path: path.join(dir, name + ".png"), clip });
        }
        await wallPage.close();
        console.log("  before / after written to " + dir);
      }
      // The app resizes or moves the window before the page measures again: a new viewport is a new report.
      const n0 = (await reports()).length;
      await v.page.setViewportSize({ width: 1240, height: 660 });
      await sleep(500);
      const r2 = await reports();
      check("the window resized: the page reports again with the new viewport (the app shows no blur until then)", r2.length > n0 && JSON.stringify(r2[r2.length - 1].view) === JSON.stringify([1240, 660]), JSON.stringify(r2.slice(n0).map((r) => r.view)));
      await v.close();
      // Pinned low: the column is short and scrolls; a card cut by it gets no blur (none hangs past the column).
      const lowPin = Object.assign({}, dh, { glancePin: { x: 0.04, y: 0.72 } });
      const v2 = await open(1280, 688, "", { host: lowPin, dpr: 1.5 });
      await sleep(600);
      const cut = await v2.page.evaluate(() => {
        const col = document.getElementById("dk-glance").getBoundingClientRect();
        const rep = window.__calls.filter((c) => c[0] === "set_blur_rects").pop()[1].rects;
        const cards = [...document.querySelectorAll("#dk-glance .dk-gl-hit")].map((e) => e.getBoundingClientRect());
        const inCol = (g) => g.x >= col.left - 0.5 && g.y >= col.top - 0.5 && g.x + g.w <= col.right + 0.5 && g.y + g.h <= col.bottom + 0.5;
        const isCard = (g) => cards.some((c) => Math.abs(c.left - g.x) <= 0.5 && Math.abs(c.top - g.y) <= 0.5);
        return { overflow: cards.some((c) => c.bottom > col.bottom + 0.5), glance: rep.filter(isCard).length, out: rep.filter((g) => isCard(g) && !inCol(g)).length };
      });
      check("  a column too short for its cards: the cut cards get no blur, the whole ones do", cut.overflow && cut.glance > 0 && cut.out === 0, JSON.stringify(cut));
      await v2.close();
    }

    /* ================================================================ the preview */
    if (SHOTS) await preview(open, info);
    check("zero CSP violations and page errors", problems.length === 0, problems.join(" | "));
  } catch (e) {
    failed++;
    console.log("  FAIL threw: " + (e && e.stack));
  } finally {
    if (browser) await browser.close();
    if (s) s.stop();
    server.close();
    try { fs.unlinkSync(SOCK); } catch (_) { /* gone */ }
  }
  finish();

  /**
   * The preview for mockups/desktop-panel/: the transparent page laid over a wallpaper, with the real
   * blur imitated (the wallpaper blurred under each glass surface the page reports: JoyaDesktop.glass(),
   * which is what the app hands its acrylic windows), Floating in its corner and the Desktop layer
   * pinned, dark and light ink, 100 / 150 %, the Windows Hello dialog, and a gif of a live update.
   */
  async function preview(openPage) {
    const FW = 1920, FH = 1032;
    const blank = await browser.newPage({ viewport: { width: FW, height: FH } });
    const walls = {};
    for (const k of ["dark", "bright"]) walls[k] = await blank.evaluate(paintWallpaper.toString().replace(/^function paintWallpaper/, "(function") + ")(" + JSON.stringify(k) + "," + FW + "," + FH + ")");
    await blank.close();
    // A screen: wallpaper, frosted patches under the page's glass, the page; at (x, y) of the screen.
    async function compose(name, wall, shot, x, y, glass, scale, w, h) {
      const comp = await browser.newPage({ viewport: { width: FW, height: FH }, deviceScaleFactor: 1 });
      await comp.setContent("<html><body style=\"margin:0;background:#000\"><canvas id=c width=" + FW + " height=" + FH + "></canvas></body></html>");
      await comp.evaluate(async ([wallSrc, shotSrc, x, y, glass, k, w, h]) => {
        const load = (src) => new Promise((res) => { const i = new Image(); i.onload = () => res(i); i.src = src; });
        const wi = await load(wallSrc), si = await load(shotSrc);
        const c = document.getElementById("c"), g = c.getContext("2d");
        g.drawImage(wi, 0, 0);
        // the acrylic: blur + a little saturation and noise, clipped to each rounded rectangle (screen px = CSS px x k)
        glass.forEach((r) => {
          g.save();
          g.beginPath();
          g.roundRect(x + r.x, y + r.y, r.w, r.h, r.r);
          g.clip();
          g.filter = "blur(26px) saturate(1.25)";
          g.drawImage(wi, 0, 0);
          g.restore();
        });
        g.drawImage(si, x, y, w, h);
      }, [walls[wall], "data:image/png;base64," + shot.toString("base64"), x, y, glass, scale, w, h]);
      await comp.screenshot({ path: path.join(SHOTS, name + ".png") });
      await comp.close();
    }
    const grab = async (v) => ({ png: await v.page.screenshot({ omitBackground: true }), glass: await v.page.evaluate(() => (window.JoyaDesktop.glass() || [])) });
    // Real blur on the page side: ?glass=1 gives the surfaces their lighter acrylic tint once settled.
    const shots = [];
    // 1-2. Floating, bottom right, over each wallpaper (dark: light ink; bright: dark ink).
    for (const [wall, ink] of [["dark", "light"], ["bright", "dark"]]) {
      const v = await openPage(748, 860, "mode=floating&glance=1&glass=1&ink=" + ink);
      await sleep(1800);
      const g = await grab(v);
      await compose("floating-" + wall + "-wallpaper-" + ink + "-ink", wall, g.png, FW - 16 - 748, FH - 16 - 860, g.glass, 1, 748, 860);
      shots.push("floating-" + wall + "-wallpaper-" + ink + "-ink");
      await v.close();
    }
    // 3-4. Desktop layer, pinned at the top left, over each wallpaper.
    for (const [wall, ink] of [["dark", "light"], ["bright", "dark"]]) {
      const v = await openPage(FW, FH, "mode=desktop&glance=1&glass=1&pin=0.035,0.07&ink=" + ink);
      await sleep(1800);
      const g = await grab(v);
      await compose("desktop-pinned-" + wall + "-wallpaper-" + ink + "-ink", wall, g.png, 0, 0, g.glass, 1, FW, FH);
      shots.push("desktop-pinned-" + wall + "-wallpaper-" + ink + "-ink");
      await v.close();
    }
    // 5. Desktop layer beside the core (not pinned), dark wallpaper.
    {
      const v = await openPage(FW, FH, "mode=desktop&glance=1&glass=1");
      await sleep(1800);
      const g = await grab(v);
      await compose("desktop-beside-core-dark-wallpaper", "dark", g.png, 0, 0, g.glass, 1, FW, FH);
      shots.push("desktop-beside-core-dark-wallpaper");
      await v.close();
    }
    // 6. 150 %: the Desktop layer of a 1920x1080 screen is 1280 x 688 CSS px, drawn at 1.5x.
    {
      const v = await openPage(1280, 688, "mode=desktop&glance=1&glass=1&ink=dark", { dpr: 1.5 });
      await sleep(400);
      const png = await v.page.screenshot({ omitBackground: true });
      const glass = (await v.page.evaluate(() => window.JoyaDesktop.glass())).map((r) => ({ x: r.x * 1.5, y: r.y * 1.5, w: r.w * 1.5, h: r.h * 1.5, r: r.r * 1.5 }));
      await compose("desktop-150-percent-bright-wallpaper-dark-ink", "bright", png, 0, 0, glass, 1, FW, FH);
      shots.push("desktop-150-percent-bright-wallpaper-dark-ink");
      await v.close();
    }
    // 7. The Windows Hello dialog over the approval card (captured in the approve test above).
    if (fs.existsSync(path.join(SHOTS, "_hello.png"))) {
      await compose("approval-windows-hello-dialog", "dark", fs.readFileSync(path.join(SHOTS, "_hello.png")), FW - 16 - 748, FH - 16 - 860, [], 1, 748, 860);
      fs.unlinkSync(path.join(SHOTS, "_hello.png"));
      shots.push("approval-windows-hello-dialog");
    }
    if (fs.existsSync(path.join(SHOTS, "_pinned-host.png"))) fs.unlinkSync(path.join(SHOTS, "_pinned-host.png"));
    // 8. A gif: a live update arriving (a session starts waiting on you, the engine run finishes, an approval comes).
    {
      W.sessions[4] = { ...W.sessions[4], status: "idle" };
      const v = await openPage(748, 860, "mode=floating&glance=1&glass=1");
      await sleep(500);
      const dir = path.join(SHOTS, "_frames");
      fs.mkdirSync(dir, { recursive: true });
      let n = 0;
      const frame = async () => {
        const g = await grab(v);
        const comp = await browser.newPage({ viewport: { width: 748 + 32, height: 860 + 32 } });
        await comp.setContent("<html><body style=\"margin:0\"><canvas id=c width=780 height=892></canvas></body></html>");
        await comp.evaluate(async ([wallSrc, shotSrc, glass]) => {
          const load = (src) => new Promise((res) => { const i = new Image(); i.onload = () => res(i); i.src = src; });
          const wi = await load(wallSrc), si = await load(shotSrc);
          const g = document.getElementById("c").getContext("2d");
          const ox = -(1920 - 780), oy = -(1032 - 892);
          g.drawImage(wi, ox, oy);
          glass.forEach((r) => { g.save(); g.beginPath(); g.roundRect(16 + r.x, 16 + r.y, r.w, r.h, r.r); g.clip(); g.filter = "blur(26px) saturate(1.25)"; g.drawImage(wi, ox, oy); g.restore(); });
          g.drawImage(si, 16, 16);
        }, [walls.dark, "data:image/png;base64," + g.png.toString("base64"), g.glass]);
        await comp.screenshot({ path: path.join(dir, "f" + String(n++).padStart(3, "0") + ".png") });
        await comp.close();
      };
      for (let k = 0; k < 4; k++) { await frame(); await sleep(120); }
      W.sessions[4] = { ...W.sessions[4], status: "waiting", waiting_for: "a carrier choice" };
      push("sessions", { sessions: W.sessions });
      for (let k = 0; k < 5; k++) { await frame(); await sleep(90); }
      push("inbound", { inbound: { id: 11, kind: "idle", from_name: "Planning engine", text: "Allocation run RUN/2026/0312 finished.", received_at: new Date().toISOString() } });
      for (let k = 0; k < 6; k++) { await frame(); await sleep(90); }
      const a44 = approval(44, "git push origin main", "session:planning", "Planning engine", 5);
      W.approvals.push(a44);
      push("approval", { approval: a44 });
      for (let k = 0; k < 10; k++) { await frame(); await sleep(90); }
      await v.close();
      try {
        execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-framerate", "6", "-i", path.join(dir, "f%03d.png"), "-vf", "fps=6,scale=520:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=160[p];[b][p]paletteuse=dither=bayer", path.join(SHOTS, "live-update.gif")]);
        shots.push("live-update (gif)");
      } catch (e) { console.log("  (no gif: " + e.message + ")"); }
      fs.rmSync(dir, { recursive: true, force: true });
    }
    console.log("  preview written to " + SHOTS + ": " + shots.join(", "));
  }
})();

function finish() {
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
