#!/usr/bin/env node
"use strict";
/**
 * Screenshots of Companion mode, simplified (the JOYA AI desktop app 0.1.13; the user, 2026-10-21: "I just want
 * the core showing at the centre top of the screen, on top of all apps, always").
 *
 * A drawn desk -- the laptop (1920 x 1200 at 150 %) and the Samsung (1920 x 1080 at 100 %) to its right, with
 * app windows -- and the REAL companion page (/joya-ai?shell=desktop&mode=companion, a scratch copy of the
 * server, core E with a head) in the companion window, placed where companion.rs puts it (the top centre of the
 * active monitor's work area, its size scaled by the monitor's DPI). Writes PNGs and a GIF of the move across
 * monitors (fade out, fade in) into OUT_DIR.
 *
 *     NODE_PATH=/opt/joya-dashboard/node_modules PLAYWRIGHT=/path/to/node_modules/playwright \
 *       node dashboard/tools/shots-companion-simple.cjs OUT_DIR
 */
const scratch = require("./scratch-server.cjs");
const path = require("path");
const fs = require("fs");
const { execFileSync } = require("child_process");
const C = require(path.join(__dirname, "..", "public", "joya-desktop-companion.js"));
const OUT = process.argv[2];
const APP_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36 Edg/129.0.0.0 JoyaDesktop/0.1.13";

// The desk (physical px), as in companion.rs's tests.
const MONS = [
  { id: 1, name: "Laptop · 150 %", rect: { x: 0, y: 0, w: 1920, h: 1200 }, work: { x: 0, y: 0, w: 1920, h: 1128 }, scale: 1.5, tb: 72 },
  { id: 2, name: "Samsung · 100 %", rect: { x: 1920, y: 0, w: 1920, h: 1080 }, work: { x: 1920, y: 0, w: 1920, h: 1032 }, scale: 1.0, tb: 48 },
];
// companion.rs window_rect().
function winRect(m) {
  const w = Math.round(C.WIN_W * m.scale), h = Math.round(C.WIN_H * m.scale);
  return { x: m.work.x + Math.trunc((m.work.w - w) / 2), y: m.work.y, w, h };
}
const WINS = [
  { mon: 1, title: "Chrome — Odoo · Inventory", x: 0, y: 0, w: 1920, h: 1128, tabs: true },
  { mon: 2, title: "Outlook — Inbox", x: 2060, y: 120, w: 1500, h: 820 },
];

const HARNESS = (VW, VH) => `<!doctype html><html><head><meta charset="utf-8"><style>
html{color-scheme:dark}html,body{margin:0;width:${VW}px;height:${VH}px;overflow:hidden;background:#05060c;font:12px/1.2 "Segoe UI",system-ui,sans-serif}
#world{position:absolute;left:0;top:0;transform-origin:0 0}
.mon{position:absolute;overflow:hidden;background:radial-gradient(1200px 700px at 30% 30%,#2b2f6b 0%,#14183a 45%,#0a0c1e 100%)}
.mon.b{background:radial-gradient(1200px 700px at 70% 40%,#3a2557 0%,#181333 50%,#0b0a1a 100%)}
.lab{position:absolute;right:24px;bottom:84px;color:rgba(255,255,255,.4);font-size:28px;z-index:2}
.tb{position:absolute;left:0;right:0;bottom:0;background:rgba(22,24,38,.96);border-top:1px solid rgba(255,255,255,.08)}
.tb i{position:absolute;top:22%;width:2.4%;height:56%;border-radius:8px;background:rgba(255,255,255,.14)}
.win{position:absolute;background:#f4f5f8;overflow:hidden;box-shadow:0 18px 60px rgba(0,0,0,.45)}
.win .tt{height:58px;background:#e6e8ef;color:#333;padding:0 22px;display:flex;align-items:center;font-size:24px}
.win .tt b{margin-left:auto;letter-spacing:26px;color:#888}
.win .tabs{height:54px;background:#dfe2ea;display:flex;gap:6px;padding:8px 10px 0}
.win .tabs span{flex:0 0 300px;background:#f4f5f8;border-radius:12px 12px 0 0;color:#444;font-size:21px;padding:12px 18px;white-space:nowrap;overflow:hidden}
.win .tabs span.o{background:#cfd3de}
.win .ln{margin:26px 34px;height:20px;border-radius:10px;background:#dde0e8}
.win.front{outline:4px solid rgba(95,240,200,.6);outline-offset:-4px}
.full{position:absolute;background:#000;display:none;align-items:center;justify-content:center;z-index:5}
.full:after{content:"";border-left:120px solid rgba(255,255,255,.75);border-top:74px solid transparent;border-bottom:74px solid transparent}
iframe.comp{color-scheme:dark;position:absolute;border:0;background:transparent;transform-origin:0 0;z-index:8;transition:none}
#cap{position:absolute;left:14px;bottom:12px;color:#e9ebff;background:rgba(0,0,0,.6);padding:7px 13px;border-radius:10px;font-size:15px;z-index:10}
</style></head><body><div id="world"></div><div id="cap"></div></body></html>`;

(async () => {
  if (!OUT) throw new Error("usage: shots-companion-simple.cjs OUT_DIR");
  fs.mkdirSync(OUT, { recursive: true });
  const { chromium } = require(process.env.PLAYWRIGHT || "playwright");
  const s = await scratch.startScratch({});
  const db = require(path.join(__dirname, "..", "lib", "db.js"));
  const errs = [];
  let browser = null;
  try {
    await s.makeUser("desk", "administrator");
    const { cookie } = await s.signIn("desk");
    const id = db.getUserByName("desk").id;
    db.setUserJoyaCore(id, "E");
    db.setUserBotHead(id, "headphones");
    browser = await chromium.launch({ args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
    const base = "http://127.0.0.1:" + s.port;
    const PAGE = base + "/joya-ai?shell=desktop&mode=companion&open=0";

    async function deskPage(VW, VH, video) {
      const ctx = await browser.newContext(Object.assign({ viewport: { width: VW, height: VH }, userAgent: APP_UA, extraHTTPHeaders: { "X-Forwarded-Proto": "https" } }, video ? { recordVideo: { dir: video, size: { width: VW, height: VH } } } : {}));
      await ctx.addCookies(String(cookie).split("; ").filter(Boolean).map((kv) => ({ name: kv.split("=")[0], value: kv.slice(kv.indexOf("=") + 1), url: base })));
      const page = await ctx.newPage();
      page.on("pageerror", (e) => errs.push("harness: " + e.message));
      page.on("console", (m) => { const t = m.text(); if ((m.type() === "error" && !/Failed to load resource|net::ERR|503|502|EventSource/.test(t)) || /Content Security Policy|Refused to/.test(t)) errs.push(t); });
      await page.route(base + "/__desk", (r) => r.fulfill({ status: 200, contentType: "text/html", body: HARNESS(VW, VH) }));
      await page.goto(base + "/__desk", { waitUntil: "load" });
      return { ctx, page };
    }
    /** The desk drawn into #world (physical px), one companion iframe per monitor (shown on the active one). */
    async function drawDesk(page) {
      await page.evaluate(({ MONS, WINS, rects, PAGE, W0, H0 }) => {
        const W = document.getElementById("world");
        const el = (cls, r, html) => { const e = document.createElement("div"); e.className = cls; Object.assign(e.style, { left: r.x + "px", top: r.y + "px", width: r.w + "px", height: r.h + "px" }); if (html) e.innerHTML = html; W.appendChild(e); return e; };
        MONS.forEach((m, i) => {
          const mon = el("mon" + (i ? " b" : ""), m.rect, '<div class="lab">' + m.name + "</div>");
          const tb = document.createElement("div"); tb.className = "tb"; tb.style.height = m.tb + "px";
          for (let k = 0; k < 8; k++) { const d = document.createElement("i"); d.style.left = 38 + k * 3 + "%"; tb.appendChild(d); }
          mon.appendChild(tb);
        });
        window.__wins = WINS.map((w) => el("win", w, '<div class="tt">' + w.title + "<b>– ▢ ✕</b></div>" + (w.tabs ? '<div class="tabs"><span class="o">Inventory · Odoo</span><span>Sales orders</span><span>JOYA AI · Command Center</span><span>Gmail</span><span>Planning engine</span></div>' : "") + '<div class="ln"></div>'.repeat(Math.max(2, Math.floor(w.h / 80)))));
        window.__full = el("full", MONS[1].rect);
        window.__frames = MONS.map((m, i) => {
          const f = document.createElement("iframe");
          f.className = "comp"; f.id = "comp" + i; f.setAttribute("allowtransparency", "true");
          Object.assign(f.style, { width: W0 + "px", height: H0 + "px", left: rects[i].x + "px", top: rects[i].y + "px", transform: "scale(" + m.scale + ")" });
          f.src = PAGE;
          W.appendChild(f);
          return f;
        });
      }, { MONS, WINS, rects: MONS.map(winRect), PAGE, W0: C.WIN_W, H0: C.WIN_H });
      const frames = [];
      for (let i = 0; i < MONS.length; i++) {
        const fr = await (await page.$("#comp" + i)).contentFrame();
        await fr.waitForFunction(() => window.JoyaDesktop && window.JoyaDesktop.companion && window.JoyaDesktop.companion() && window.JoyaDesktop.companion().debug.core(), null, { timeout: 30000 });
        fr.page().on("pageerror", (e) => errs.push("companion: " + e.message));
        await fr.evaluate(() => setInterval(() => { const o = document.getElementById("cc-offline"); if (o) o.hidden = true; }, 100));
        frames.push(fr);
      }
      return frames;
    }
    async function view(page, z, x, y, caption) {
      await page.evaluate(({ z, x, y, caption }) => {
        document.getElementById("world").style.transform = "scale(" + z + ") translate(" + -x + "px," + -y + "px)";
        document.getElementById("cap").textContent = caption || "";
        document.getElementById("cap").style.display = caption ? "block" : "none";
      }, { z, x, y, caption });
    }
    async function active(page, i, fullscreen) {
      await page.evaluate(({ i, fullscreen }) => {
        window.__frames.forEach((f, k) => { f.style.visibility = k === i && !fullscreen ? "visible" : "hidden"; });
        window.__wins.forEach((w, k) => w.classList.toggle("front", k === i));
        window.__full.style.display = fullscreen ? "flex" : "none";
      }, { i, fullscreen: !!fullscreen });
    }

    /* 1-4: the desk, the bot following the active monitor; close-ups at each DPI; a full-screen video. */
    {
      const { ctx, page } = await deskPage(1536, 480);
      const frames = await drawDesk(page);
      await page.waitForTimeout(1500);
      await active(page, 0);
      await view(page, 0.4, 0, 0, "Working on the laptop: the core at the top centre of its screen, over every app");
      await page.waitForTimeout(600);
      await page.screenshot({ path: path.join(OUT, "1-desk-laptop.png") });
      await active(page, 1);
      await view(page, 0.4, 0, 0, "A window on the Samsung in front: the core moves there (a quick fade, no walking)");
      await page.waitForTimeout(600);
      await page.screenshot({ path: path.join(OUT, "2-desk-samsung.png") });
      await active(page, 1, true);
      await view(page, 0.4, 0, 0, "A full-screen video on its monitor: it steps out of the way, and comes back after");
      await page.waitForTimeout(400);
      await page.screenshot({ path: path.join(OUT, "5-fullscreen-ducked.png") });
      await ctx.close();
      const c2 = await deskPage(1200, 420);
      await drawDesk(c2.page);
      await c2.page.waitForTimeout(1500);
      await active(c2.page, 0);
      await view(c2.page, 1, 360, 0, "Laptop, 150 %: 264 × 240 physical px, centred over Chrome's tab strip");
      await c2.page.waitForTimeout(500);
      await c2.page.screenshot({ path: path.join(OUT, "3-closeup-laptop-150.png") });
      await active(c2.page, 1);
      await view(c2.page, 1.5, 1920 + 560, 0, "Samsung, 100 %: 176 × 160 physical px (shown here zoomed 1.5× to compare: the same size to the eye)");
      await c2.page.waitForTimeout(500);
      await c2.page.screenshot({ path: path.join(OUT, "4-closeup-samsung-100.png") });
      await c2.ctx.close();
      void frames;
    }

    /* 6: its states, eye contact's pill under it, the hover hint (at 150 %). */
    {
      const STATES = [["idle", "Ready"], ["listening", "Listening"], ["thinking", "Thinking"], ["speaking", "Speaking"], ["needs", "Needs you"], ["cam", "Camera on (eye contact)"], ["hover", "Hover: click to open"]];
      const ctx = await browser.newContext({ viewport: { width: C.WIN_W, height: C.WIN_H }, deviceScaleFactor: 1.5, userAgent: APP_UA, extraHTTPHeaders: { "X-Forwarded-Proto": "https" } });
      await ctx.addCookies(String(cookie).split("; ").filter(Boolean).map((kv) => ({ name: kv.split("=")[0], value: kv.slice(kv.indexOf("=") + 1), url: base })));
      const tiles = [];
      for (const [st, label] of STATES) {
        const p = await ctx.newPage();
        p.on("pageerror", (e) => errs.push("state " + st + ": " + e.message));
        await p.goto(PAGE, { waitUntil: "load" });
        await p.waitForFunction(() => window.JoyaDesktop && window.JoyaDesktop.companion && window.JoyaDesktop.companion() && window.JoyaDesktop.companion().debug.core(), null, { timeout: 30000 });
        await p.evaluate((st) => {
          setInterval(() => { const o = document.getElementById("cc-offline"); if (o) o.hidden = true; }, 100);
          const cc = document.getElementById("cc");
          const set = () => { cc.setAttribute("data-state", st === "cam" || st === "hover" ? "idle" : st); window.JoyaDesktop.companion().debug.tick(); };
          set(); setInterval(set, 200);
          if (st === "cam") {
            const pill = document.createElement("div");
            pill.className = "mp-cam"; pill.id = "mp-cam";
            pill.innerHTML = '<span class="mp-dot"></span><span class="mp-t">Camera on · Integrated camera</span><button type="button" class="mp-off">Off</button>';
            document.body.appendChild(pill);
          }
        }, st);
        if (st === "hover") await p.hover("#dk-comp-hit");
        await p.waitForTimeout(st === "speaking" || st === "listening" ? 1600 : 1100);
        const file = path.join(OUT, "state-" + st + ".png");
        await p.screenshot({ path: file, omitBackground: true });
        tiles.push([file, label]);
        await p.close();
      }
      await ctx.close();
      const sheet = await browser.newContext({ viewport: { width: 7 * 200 + 20, height: 250 } });
      const sp = await sheet.newPage();
      const html = '<!doctype html><html style="background:#14183a"><body style="margin:0;height:100%;min-height:250px;background:linear-gradient(160deg,#2b2f6b,#0a0c1e);font:14px Segoe UI,system-ui,sans-serif;color:#e9ebff">' +
        tiles.map(([f, l], i) => '<figure style="position:absolute;left:' + (10 + i * 200) + 'px;top:6px;margin:0;width:190px;text-align:center"><img style="width:176px;height:160px" src="data:image/png;base64,' + fs.readFileSync(f).toString("base64") + '"><figcaption style="margin-top:8px">' + l + "</figcaption></figure>").join("") +
        '<div style="position:absolute;left:12px;bottom:10px;opacity:.7">The companion window at 150 % (each tile is the whole window; everything around the core lets clicks through)</div></body></html>';
      await sp.setContent(html);
      await sp.waitForTimeout(300);
      await sp.screenshot({ path: path.join(OUT, "6-states.png") });
      await sheet.close();
      tiles.forEach(([f]) => { if (!process.env.KEEP_TILES) fs.rmSync(f); });
    }

    /* 7: the move across monitors as a GIF: laptop -> fade out -> fade in on the Samsung -> back. */
    {
      const vdir = path.join(OUT, "video-tmp");
      const { ctx, page } = await deskPage(960, 300, vdir);
      const t0 = Date.now();
      const frames = await drawDesk(page);
      await page.waitForTimeout(1500);
      await view(page, 0.25, 0, 0, "Click a window on the other monitor: the core fades across");
      await active(page, 0);
      // The companion page's own fade (CSS, FADE_MS) driven by the app's events, as companion_host.rs sends them.
      const hop = async (from, to) => {
        await page.evaluate((to) => { window.__wins.forEach((w, k) => w.classList.toggle("front", k === to)); }, to);
        await page.waitForTimeout(250); // SETTLE_MS
        await frames[from].evaluate(() => window.JoyaDesktop.companion().debug.event({ kind: "fade-out" }));
        await page.waitForTimeout(C.FADE_MS + 20);
        await frames[to].evaluate(() => window.JoyaDesktop.companion().debug.event({ kind: "fade-out" }));
        await page.evaluate(({ from, to }) => { window.__frames[from].style.visibility = "hidden"; window.__frames[to].style.visibility = "visible"; }, { from, to });
        await page.waitForTimeout(30);
        await frames[to].evaluate(() => window.JoyaDesktop.companion().debug.event({ kind: "fade-in" }));
        await frames[from].evaluate(() => window.JoyaDesktop.companion().debug.event({ kind: "fade-in" }));
      };
      const start = Date.now();
      await page.waitForTimeout(1200);
      await hop(0, 1);
      await page.waitForTimeout(1500);
      await hop(1, 0);
      await page.waitForTimeout(1300);
      const dur = (Date.now() - start) / 1000;
      const v = page.video();
      await ctx.close();
      const webm = await v.path();
      const vf = "fps=20,scale=960:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=128:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle";
      execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-ss", String((start - t0) / 1000), "-t", String(dur), "-i", webm, "-vf", vf, path.join(OUT, "7-switch-monitors.gif")]);
      fs.rmSync(vdir, { recursive: true, force: true });
    }
    console.log(JSON.stringify({ out: fs.readdirSync(OUT), errors: errs }, null, 1));
    if (errs.length) process.exitCode = 1;
  } finally {
    if (browser) await browser.close();
    s.stop();
  }
})().catch((e) => { console.error(e); process.exit(1); });
