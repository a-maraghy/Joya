#!/usr/bin/env node
"use strict";
/**
 * Preview of "Eye contact: a bot that knows you're there" (2026-10-20; mockups/eye-contact/DESIGN.md) for review,
 * from SYNTHETIC input -- no camera, no face: a scripted person (where they sit, where they turn) goes through the
 * real state machine (public/joya-presence-logic.js, in the page), and what it says drives the real Command
 * Center (a scratch copy of the server and a stand-in supervisor) through the real binding
 * (joya-presence-bind.js). A small panel draws what the camera module would report.
 *
 *   1-meet-your-gaze.gif         the bot's eyes meet yours and follow you as you lean and move
 *   2-doze-when-you-leave.gif    you walk away: it dozes; you sit down again: it wakes and looks up
 *   3-glance-cards.gif           the desktop app: the glance cards forward while you look, stepped back otherwise
 *   4-settings-opt-in.png        Settings > Appearance > Eye contact (the browser), 5-app-settings.png (the app)
 *   plus stills (gaze-*.png, dozing.png, glance-*.png)
 *
 *     NODE_PATH=/opt/joya-dashboard/node_modules PLAYWRIGHT=/path/to/node_modules/playwright \
 *       node dashboard/tools/shots-eye-contact.cjs OUT_DIR
 */
const scratch = require("./scratch-server.cjs");
const path = require("path");
const fs = require("fs");
const net = require("net");
const { execFileSync } = require("child_process");
const OUT = process.argv[2];
const APP_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36 Edg/129.0.0.0 JoyaDesktop/0.1.12";

/* ------------------------------------------------------------------ a stand-in supervisor (status, sessions, caps) */
const iso = (ms) => new Date(Date.now() + ms).toISOString();
const W = {
  approvals: [{ id: 41, status: "pending", tool: "Bash", input: { command: "systemctl restart odoo" }, summary: "systemctl restart odoo", category: "service", label: "Restarts a service", reason: "", created_at: iso(-60000), expires_at: iso(9 * 60000), origin: "session:planning", origin_name: "Planning engine" }],
  sessions: [
    { self: true, name: "JOYA AI", pid: 100, session_id: "aaaaaaaa-0000-4000-8000-000000000000", status: "idle" },
    { name: "Planning engine", pid: 201, session_id: "bbbbbbbb-0000-4000-8000-000000000001", status: "busy", where: "~/joya", tokens_today: { total: 2.1e6 } },
    { name: "Customs docs", pid: 202, session_id: "bbbbbbbb-0000-4000-8000-000000000002", status: "idle", where: "~/customs" },
    { name: "Invoice audit", pid: 203, session_id: "bbbbbbbb-0000-4000-8000-000000000003", status: "waiting", waiting_for: "your approval", where: "~/audit" },
  ],
  caps: { day: "2026-10-20", warn_pct: 80, held: 0, sessions: [{ key: "<self>", name: "JOYA AI", kind: "self", cap: 5e6, at: "pause", today: { total: 2.4e6 }, state: "ok" }] },
};
const SOCK = path.join(scratch.DATA, "fake-joya-ai-eyes.sock");
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
      if (m.op === "events") continue;
      let data = {};
      if (m.op === "status") data = { name: "JOYA AI", seq: 1, process: { state: "ready", pid: 100 }, session_id: W.sessions[0].session_id, approvals: W.calm ? [] : W.approvals, tokens_today: { total: 2.4e6 }, cost_today: { total_usd: 8.2, budget_usd: null, warn_pct: 80 }, counts: {} };
      else if (m.op === "sessions") data = { sessions: W.calm ? W.sessions.map((x) => Object.assign({}, x, { status: x.status === "waiting" ? "idle" : x.status })) : W.sessions };
      else if (m.op === "token-caps") data = W.caps;
      else if (m.op === "ledger") data = { rows: m.table === "approvals" && !W.calm ? W.approvals : [] };
      c.write(JSON.stringify({ id: m.id, ok: true, data }) + "\n");
    }
  });
  c.on("error", () => {});
});

/* ------------------------------------------------------------------ in the page: the scripted person and the panel */
function harness() {
  // A stand-in camera module (the real one needs a real face): the binding subscribes to it as to the real one.
  const subs = [];
  window.JoyaPresence = { configure: () => {}, on: (f) => subs.push(f), snapshot: () => ({}), hooks: () => {}, release: () => {}, turnEnded: () => {}, diag: () => ({}) };
  window.__eyes = {
    emit: (s) => subs.forEach((f) => f(s)),
    panel: null,
    /** Run a script: [{ ms, face: {cx, cy, w, yaw, pitch} | null, fast: 1, note }] through the real state machine. */
    play(script, bot) {
      const L = window.JoyaPresenceLogic, tr = L.createTracker({ bot });
      let t = 0;
      const steps = [];
      script.forEach((s) => { const n = Math.round(s.ms / 200); for (let i = 0; i < n; i++) steps.push(s); });
      return new Promise((done) => {
        let i = 0;
        const tick = () => {
          if (i >= steps.length) { done(); return; }
          const s = steps[i++];
          t += 200 * (s.fast || 1);
          const snap = tr.push(s.face ? [Object.assign({ jaw: 0.03 }, s.face)] : [], t);
          window.__eyes.emit({ state: snap.state, gaze: snap.gaze, camera: true });
          window.__eyes.draw(s, snap);
          setTimeout(tick, 200);
        };
        tick();
      });
    },
    draw(s, snap) {
      let p = window.__eyes.panel;
      if (!p) {
        p = document.createElement("div");
        Object.assign(p.style, window.__eyes.right ? { right: "16px", left: "auto" } : { left: "16px" }, { position: "fixed", bottom: "16px", zIndex: 9999, width: "220px", padding: "10px 12px", borderRadius: "12px", background: "rgba(10,12,30,.82)", color: "#e9ecff", font: "12px/1.35 system-ui,sans-serif", border: "1px solid rgba(255,255,255,.18)" });
        // (the page's CSP refuses style attributes: everything through element.style)
        const mk = (tag, st, attr) => { const e = document.createElement(tag); Object.assign(e.style, st); if (attr) e.setAttribute(attr, ""); p.appendChild(e); return e; };
        mk("div", { opacity: ".7", fontSize: "10.5px", letterSpacing: ".08em", textTransform: "uppercase" }).textContent = "Camera module says · synthetic input";
        const cv = mk("canvas", { display: "block", margin: "6px 0", borderRadius: "8px", background: "#141833" }); cv.width = 196; cv.height = 110;
        mk("div", { fontWeight: "650", fontSize: "14px" }, "data-s");
        mk("div", { opacity: ".75", minHeight: "16px" }, "data-n");
        document.body.appendChild(p);
        window.__eyes.panel = p;
      }
      const g = p.querySelector("canvas").getContext("2d");
      g.clearRect(0, 0, 196, 110);
      g.strokeStyle = "rgba(255,255,255,.25)"; g.strokeRect(0.5, 0.5, 195, 109);
      g.fillStyle = "rgba(255,255,255,.35)"; g.font = "9px system-ui"; g.fillText("the camera's view (mirrored)", 6, 12);
      if (s.face) {
        const f = s.face, x = (1 - f.cx) * 196, y = f.cy * 110, r = f.w * 196 * 0.5;
        g.strokeStyle = "#5ad1ff"; g.lineWidth = 2; g.beginPath(); g.ellipse(x, y, r, r * 1.25, 0, 0, Math.PI * 2); g.stroke();
        const nx = x + Math.sin((f.yaw || 0) / 57.3) * r * 0.8, ny = y - Math.sin((f.pitch || 0) / 57.3) * r * 0.8;
        g.fillStyle = "#5ad1ff"; g.beginPath(); g.arc(nx, ny, 3, 0, Math.PI * 2); g.fill();
      } else { g.fillStyle = "rgba(255,255,255,.4)"; g.font = "12px system-ui"; g.fillText("nobody", 76, 60); }
      p.querySelector("[data-s]").textContent = (snap.state || "—") + (snap.gaze ? "  ·  eyes " + snap.gaze.x.toFixed(2) + ", " + snap.gaze.y.toFixed(2) : "");
      p.querySelector("[data-n]").textContent = s.note || "";
    },
  };
}

(async () => {
  if (!OUT) throw new Error("usage: shots-eye-contact.cjs OUT_DIR");
  fs.mkdirSync(OUT, { recursive: true });
  const { chromium } = require(process.env.PLAYWRIGHT || "playwright");
  await new Promise((r) => server.listen(SOCK, r));
  const s = await scratch.startScratch({ env: { JOYA_AI_SOCKET: SOCK } });
  const db = require(path.join(__dirname, "..", "lib", "db.js"));
  const errs = [];
  let browser = null;
  try {
    await s.makeUser("eyes", "administrator");
    const { cookie } = await s.signIn("eyes");
    const id = db.getUserByName("eyes").id;
    db.setUserJoyaCore(id, "E");
    db.setUserBotHead(id, "cap");
    const ORIGIN = "http://127.0.0.1:" + s.port;
    browser = await chromium.launch({ args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
    const vdir = path.join(OUT, "video-tmp");
    async function open(o) {
      o = Object.assign({ W: 1280, H: 760, video: false, path: "/joya-ai" }, o);
      const ctx = await browser.newContext({ viewport: { width: o.W, height: o.H }, colorScheme: "dark", userAgent: o.ua, extraHTTPHeaders: { "X-Forwarded-Proto": "https" }, recordVideo: o.video ? { dir: vdir, size: { width: o.W, height: o.H } } : undefined });
      await ctx.addCookies(String(cookie).split("; ").filter(Boolean).map((kv) => ({ name: kv.split("=")[0], value: kv.slice(kv.indexOf("=") + 1), url: ORIGIN })));
      const page = await ctx.newPage();
      page.on("pageerror", (e) => errs.push(e.message));
      await page.addInitScript(harness);
      if (o.tauri) await page.addInitScript((h) => { window.__TAURI__ = { core: { invoke: (c) => Promise.resolve(c === "get_state" ? h : null) }, event: { listen: () => Promise.resolve(() => {}) } }; }, o.tauri);
      await page.goto(ORIGIN + o.path, { waitUntil: "load" });
      if (o.path === "/joya-ai" || o.path.indexOf("/joya-ai?") === 0) {
        await page.waitForFunction(() => window.__joyaCC && window.__joyaCC.core && window.__joyaCC.core.S.concept === "E", null, { timeout: 15000 });
        await page.evaluate(() => { const c = window.__joyaCC.core; c.setOffline(false); c.setOffline = () => {}; ["cc-offline", "cc-caption"].forEach((i) => { const el = document.getElementById(i); if (el) el.style.setProperty("display", "none", "important"); }); });
      }
      await page.waitForTimeout(1200);
      return { ctx, page };
    }
    async function gif(ctx, page, name, crop, width) {
      const v = page.video();
      await ctx.close();
      const webm = await v.path();
      const vf = (crop ? `crop=${Math.round(crop.width)}:${Math.round(crop.height)}:${Math.round(crop.x)}:${Math.round(crop.y)},` : "") + `fps=12,scale=${width || 560}:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=96[p];[b][p]paletteuse=dither=bayer`;
      execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-ss", "1.4", "-i", webm, "-vf", vf, path.join(OUT, name + ".gif")]);
      fs.unlinkSync(webm);
    }
    const botAt = (page) => page.evaluate(() => { const b = window.JoyaPresenceBind.botAt(); return { x: Math.min(1, Math.max(0, b.x)), y: Math.min(1, Math.max(0, b.y)) }; });
    const clipAround = (page) => page.evaluate(() => { const L = window.__joyaCC.orbit.layout, R = L.R * 1.5; return { x: 0, y: Math.max(0, L.cy - R * 1.25), width: Math.min(innerWidth, L.cx + R * 1.6), height: Math.min(innerHeight - Math.max(0, L.cy - R * 1.25), R * 2.6 + 140) }; });

    const mid = { cx: 0.5, cy: 0.5, w: 0.24, yaw: 0, pitch: -10 };
    /* 1. meet your gaze (a calm desk: nothing waits on you, so the bot is ready -- and may doze) */
    W.calm = true;
    {
      const { ctx, page } = await open({ video: true });
      const bot = await botAt(page);
      await page.evaluate(() => window.__eyes.emit({ state: "away", gaze: null, camera: true }));
      await page.waitForTimeout(300);
      const script = [
        { ms: 1200, face: mid, note: "you sit down" },
        { ms: 1600, face: mid, note: "it meets your eyes" },
        { ms: 1600, face: { ...mid, cx: 0.22 }, note: "you move to your right" },
        { ms: 1600, face: { ...mid, cx: 0.8 }, note: "…and to your left" },
        { ms: 1600, face: { ...mid, cy: 0.72, w: 0.3 }, note: "you lean in, lower" },
        { ms: 1400, face: { ...mid, cy: 0.3, w: 0.2 }, note: "you sit up, further back" },
        { ms: 1000, face: mid, note: "" },
      ];
      const shots = page.evaluate((a) => window.__eyes.play(a.script, a.bot), { script, bot });
      const t0 = Date.now();
      for (const [at, n] of [[2600, "gaze-centre"], [4300, "gaze-right"], [5900, "gaze-left"], [7500, "gaze-lean-in"]]) {
        await page.waitForTimeout(Math.max(0, t0 + at - Date.now()));
        await page.screenshot({ path: path.join(OUT, n + ".png") });
      }
      await shots;
      await gif(ctx, page, "1-meet-your-gaze", null, 640);
    }
    /* 2. doze when you leave, wake when you are back */
    {
      const { ctx, page } = await open({ video: true });
      const bot = await botAt(page);
      const script = [
        { ms: 1600, face: mid, note: "looking at it" },
        { ms: 1200, face: { ...mid, yaw: 60 }, note: "you turn away…" },
        { ms: 1000, face: null, note: "…and leave the desk" },
        { ms: 1800, face: null, fast: 4, note: "8 s later: away" },
        { ms: 3600, face: null, note: "it dozes" },
        { ms: 2200, face: mid, note: "you sit down again: it wakes and looks up" },
        { ms: 1600, face: mid, note: "" },
      ];
      const run = page.evaluate((a) => window.__eyes.play(a.script, a.bot), { script, bot });
      await page.waitForTimeout(9000);
      await page.screenshot({ path: path.join(OUT, "dozing.png") });
      await run;
      await gif(ctx, page, "2-doze-when-you-leave", null, 640);
    }
    /* 3. the desktop app: the glance cards follow your attention (an approval waiting, sessions at work) */
    W.calm = false;
    {
      const HOST = { mode: "floating", peekOpen: true, glance: true, size: "M", ink: "light", presence: { camera: true, speak: false, releaseOnSaver: true, onBattery: false, energySaver: false, locked: false, meeting: false, inUse: true } };
      const { ctx, page } = await open({ video: true, path: "/joya-ai?shell=desktop&mode=floating&glance=1", ua: APP_UA, tauri: HOST, W: 760, H: 820 });
      await page.evaluate(() => { window.__eyes.right = true; document.documentElement.classList.add("mp-cam-on"); const b = document.body; b.style.background = "linear-gradient(135deg,#1d3b5c,#3a2a5c 55%,#14262f)"; });
      const bot = await botAt(page);
      const script = [
        { ms: 1800, face: mid, note: "you look at this screen: the cards come forward" },
        { ms: 2600, face: { ...mid, yaw: 48 }, note: "you look at your other monitor: they step back" },
        { ms: 1800, face: mid, note: "back: forward again" },
        { ms: 1200, face: null, note: "" },
      ];
      const run = page.evaluate((a) => window.__eyes.play(a.script, a.bot), { script, bot });
      const t0 = Date.now();
      await page.waitForTimeout(1500);
      await page.screenshot({ path: path.join(OUT, "glance-forward.png") });
      await page.waitForTimeout(Math.max(0, t0 + 3700 - Date.now()));
      await page.screenshot({ path: path.join(OUT, "glance-stepped-back.png") });
      await run;
      await gif(ctx, page, "3-glance-cards", null, 480);
    }
    /* 4. Settings: the opt-in screen (browser), and the app's Settings window */
    {
      const { ctx, page } = await open({ path: "/joya-ai/settings/appearance", W: 1100, H: 900 });
      await page.evaluate(() => document.getElementById("mp-set").scrollIntoView({ block: "start" }));
      await page.waitForTimeout(300);
      await (await page.$("#mp-set")).screenshot({ path: path.join(OUT, "4-settings-opt-in.png") });
      await ctx.close();
      const c2 = await browser.newContext({ viewport: { width: 560, height: 760 }, colorScheme: "light" });
      const p2 = await c2.newPage();
      await p2.addInitScript(() => {
        const S = { mode: "floating", focus: false, hotkeys: { talk: "Ctrl+Space", show: "Ctrl+Alt+M", focus: "Ctrl+Alt+F", live: "Ctrl+Alt+L", stop: "Ctrl+Alt+Esc" }, glance: true, companion: { stay_on_monitor: false }, per_monitor: {}, presence: { camera: false, look_and_speak: false, release_on_saver: true, consented: false }, battery_saver: true, real_blur: true, autostart: true, check_updates: true };
        window.__TAURI__ = { core: { invoke: (c) => Promise.resolve(c === "settings_get" ? { settings: S, version: "0.1.12", talkKey: "Ctrl+Space", liveKey: "Ctrl+Alt+L", monitors: [], monitorKey: "default" } : c === "machine_status" ? { linked: false } : null) }, event: { listen: () => Promise.resolve(() => {}) } };
      });
      await p2.goto("file://" + path.join(__dirname, "..", "..", "desktop", "dist", "settings.html") + "#eye-contact");
      await p2.waitForTimeout(800);
      await p2.evaluate(() => document.getElementById("eye-contact").scrollIntoView({ block: "start" }));
      await p2.waitForTimeout(200);
      await p2.screenshot({ path: path.join(OUT, "5-app-settings.png") });
      await c2.close();
    }
  } finally {
    if (browser) await browser.close();
    s.stop();
    server.close();
    try { fs.rmSync(path.join(OUT, "video-tmp"), { recursive: true, force: true }); } catch (e) { /* fine */ }
  }
  console.log(errs.length ? "page errors:\n" + errs.join("\n") : "no page errors");
  console.log("wrote " + fs.readdirSync(OUT).join(", "));
})().catch((e) => { console.error(e); process.exit(1); });
