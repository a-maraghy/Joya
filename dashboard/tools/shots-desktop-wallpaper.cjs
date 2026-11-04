#!/usr/bin/env node
"use strict";
/**
 * The desktop app's Desktop layer (/joya-ai?shell=desktop&mode=desktop) with core E over real-looking
 * wallpapers: the page is transparent in the app, so it is captured with no background and laid over
 * a wallpaper here (a bright snowy scene, a dark night, a busy mid-tone photo-like one), with the ink
 * the app would pick for it (dark ink on the snow, light ink on the others), in the Mono and Default
 * colours, with four sessions. Reports, per shot, the ink, the page's data-theme and the core's light
 * flag (the ink must reach the bot renderer), and console / CSP errors.
 *
 *     NODE_PATH=/opt/joya-dashboard/node_modules PLAYWRIGHT=/path/to/node_modules/playwright \
 *       node dashboard/tools/shots-desktop-wallpaper.cjs OUT_DIR [prefix]
 */
const scratch = require("./scratch-server.cjs");
const path = require("path");
const fs = require("fs");
const OUT = process.argv[2];
const PREFIX = process.argv[3] || "";
const APP_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36 Edg/129.0.0.0 JoyaDesktop/0.1.8";
const SESS = [
  { id: "s1", label: "Planning engine", st: "working", subs: [{}, {}], act: 9, task: "Re-running the October allocation" },
  { id: "s2", label: "Customs docs", st: "idle", act: 3, hired: true, slug: "customs" },
  { id: "s3", label: "Invoice audit", st: "waiting", act: 5, task: "Waiting for your approval" },
  { id: "s4", label: "Freight quotes", st: "working", act: 6 },
];
const W = 1920, H = 1032;

/** The wallpapers, drawn on a canvas (no files to ship): returns a PNG data URL. */
function paintWallpaper(kind, w, h) {
  const c = document.createElement("canvas"); c.width = w; c.height = h;
  const g = c.getContext("2d");
  let seed = 11;
  const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  if (kind === "snow") {
    let sky = g.createLinearGradient(0, 0, 0, h * 0.55); sky.addColorStop(0, "#cfe3f5"); sky.addColorStop(1, "#f4f8fc");
    g.fillStyle = sky; g.fillRect(0, 0, w, h);
    // far mountains, bright snow fields, a few dark pines
    g.fillStyle = "#e3ecf5"; g.beginPath(); g.moveTo(0, h * 0.5);
    for (let x = 0; x <= w; x += 60) g.lineTo(x, h * (0.38 + 0.1 * Math.sin(x / 210) + 0.05 * Math.sin(x / 67)));
    g.lineTo(w, h); g.lineTo(0, h); g.fill();
    g.fillStyle = "#ffffff"; g.beginPath(); g.moveTo(0, h * 0.62);
    for (let x = 0; x <= w; x += 40) g.lineTo(x, h * (0.58 + 0.05 * Math.sin(x / 300 + 1)));
    g.lineTo(w, h); g.lineTo(0, h); g.fill();
    for (let i = 0; i < 70; i++) {
      const x = rnd() * w, y = h * (0.55 + rnd() * 0.4), s = 20 + rnd() * 60;
      g.fillStyle = rnd() < 0.5 ? "#2f4a3a" : "#3d5a48";
      g.beginPath(); g.moveTo(x, y - s * 2); g.lineTo(x - s * 0.55, y); g.lineTo(x + s * 0.55, y); g.fill();
      g.fillStyle = "rgba(255,255,255,0.85)"; g.beginPath(); g.moveTo(x, y - s * 2); g.lineTo(x - s * 0.25, y - s * 1.1); g.lineTo(x + s * 0.25, y - s * 1.1); g.fill();
    }
    for (let i = 0; i < 900; i++) { g.fillStyle = "rgba(255,255,255," + (0.5 + rnd() * 0.5) + ")"; g.fillRect(rnd() * w, rnd() * h, 2, 2); }
  } else if (kind === "night") {
    let sky = g.createLinearGradient(0, 0, 0, h); sky.addColorStop(0, "#070b18"); sky.addColorStop(1, "#1b2440");
    g.fillStyle = sky; g.fillRect(0, 0, w, h);
    for (let i = 0; i < 500; i++) { g.fillStyle = "rgba(255,255,255," + rnd() * 0.8 + ")"; g.fillRect(rnd() * w, rnd() * h * 0.7, 1.5, 1.5); }
    g.fillStyle = "#0b1020"; g.beginPath(); g.moveTo(0, h * 0.8);
    for (let x = 0; x <= w; x += 50) g.lineTo(x, h * (0.72 + 0.06 * Math.sin(x / 180)));
    g.lineTo(w, h); g.lineTo(0, h); g.fill();
  } else {
    // busy: a mid-tone scene with bright patches (light ink is chosen for it: mean below the threshold)
    let bg = g.createLinearGradient(0, 0, w, h); bg.addColorStop(0, "#8aa6c4"); bg.addColorStop(0.5, "#c9b28a"); bg.addColorStop(1, "#5d6f52");
    g.fillStyle = bg; g.fillRect(0, 0, w, h);
    for (let i = 0; i < 160; i++) {
      const x = rnd() * w, y = rnd() * h, r = 20 + rnd() * 140, l = rnd();
      g.fillStyle = l < 0.4 ? "rgba(255,255,255," + (0.35 + rnd() * 0.5) + ")" : l < 0.7 ? "rgba(40,50,40," + (0.25 + rnd() * 0.4) + ")" : "rgba(230,190,120," + (0.3 + rnd() * 0.4) + ")";
      g.beginPath(); g.ellipse(x, y, r, r * (0.4 + rnd()), rnd() * 3, 0, 7); g.fill();
    }
  }
  return c.toDataURL("image/png");
}

(async () => {
  if (!OUT) throw new Error("usage: shots-desktop-wallpaper.cjs OUT_DIR [prefix]");
  fs.mkdirSync(OUT, { recursive: true });
  const { chromium } = require(process.env.PLAYWRIGHT || "playwright");
  const s = await scratch.startScratch({});
  const db = require(path.join(__dirname, "..", "lib", "db.js"));
  const errs = [], report = [];
  try {
    await s.makeUser("desk", "administrator");
    const { cookie } = await s.signIn("desk");
    const id = db.getUserByName("desk").id;
    const browser = await chromium.launch({ args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
    const blank = await browser.newPage({ viewport: { width: W, height: H } });
    const walls = {};
    for (const k of ["snow", "night", "busy"]) walls[k] = await blank.evaluate(paintWallpaper.toString().replace(/^function paintWallpaper/, "(function") + ")(" + JSON.stringify(k) + "," + W + "," + H + ")");
    // the ink the app picks: dark only on a clearly light wallpaper (platform::ink_for_luminance, CIE L* > 0.62)
    const INK = { snow: "dark", night: "light", busy: "light" };
    for (const preset of ["mono", "default"]) {
      db.setUserJoyaCore(id, "E"); db.setUserBotHead(id, "headphones"); db.setUserBotColors(id, JSON.stringify({ p: preset }));
      for (const wall of ["snow", "night", "busy"]) {
        const name = PREFIX + preset + "-" + wall;
        const ctx = await browser.newContext({ viewport: { width: W, height: H }, userAgent: APP_UA, extraHTTPHeaders: { "X-Forwarded-Proto": "https" } });
        await ctx.addCookies(String(cookie).split("; ").filter(Boolean).map((kv) => ({ name: kv.split("=")[0], value: kv.slice(kv.indexOf("=") + 1), url: "http://127.0.0.1:" + s.port })));
        const page = await ctx.newPage();
        page.on("pageerror", (e) => errs.push(name + ": " + e.message));
        page.on("console", (m) => { const t = m.text(); if ((m.type() === "error" && !/Failed to load resource|net::ERR|503|502|EventSource/.test(t)) || /Content Security Policy|Refused to/.test(t)) errs.push(name + ": " + t); });
        await page.goto("http://127.0.0.1:" + s.port + "/joya-ai?shell=desktop&mode=desktop&ink=" + INK[wall], { waitUntil: "load" });
        await page.waitForFunction(() => window.__joyaCC && window.__joyaCC.core && window.__joyaCC.core.S.concept === "E", null, { timeout: 15000 });
        await page.evaluate((list) => {
          const cc = window.__joyaCC, O = cc.orbit;
          ["cc-offline", "cc-caption"].forEach((i) => { const el = document.getElementById(i); if (el) { el.hidden = true; el.style.setProperty("display", "none", "important"); } }); // the scratch copy has no supervisor: not "offline"
          O._setState = O.setState; O.setState = function () {}; O.setOffline = function () {};
          cc.core.setOffline(false);
          O.setNodes(list);
        }, SESS);
        await page.waitForFunction(() => window.__joyaCC.orbit.family.kids().every((k) => k.form >= 1), null, { timeout: 20000 }).catch(() => {});
        await page.waitForTimeout(900);
        const info = await page.evaluate(() => ({ theme: document.documentElement.getAttribute("data-theme"), light: window.__joyaCC.core.S.lightT, desk: !!window.__joyaCC.core.S.desk, core: window.JoyaDesktop && window.JoyaDesktop.coreLayout(), kids: window.__joyaCC.orbit.family.kids().map((k) => [k.key, +(k.form || 0).toFixed(2), +(k.alpha == null ? 1 : k.alpha).toFixed(2), +(k.dis || 0).toFixed(2), Math.round(k.r)]) }));
        // the core's canvas at the head's centre, half way out, its edge and beyond (r,g,b,a: the backplate shows in a)
        info.probe = await page.evaluate(() => new Promise((res) => window.__joyaCC.orbit.sample((cv) => {
          const L = window.JoyaDesktop.coreLayout(), k = cv.width / window.innerWidth, hr = L.R * 0.57;
          const c = document.createElement("canvas"); c.width = cv.width; c.height = cv.height; const g = c.getContext("2d"); g.drawImage(cv, 0, 0);
          res([[0, 0], [0.6, 0], [1.0, 0], [1.4, 0]].map(([dx, dy]) => Array.from(g.getImageData(Math.round((L.cx + dx * hr) * k), Math.round((L.cy + 0.07 * L.R + dy * hr) * k), 1, 1).data).join(",")));
        })));
        report.push(Object.assign({ shot: name, ink: INK[wall] }, info));
        // the ink must reach the bot: dark ink -> light theme -> the light palette (Mono black), light ink -> dark (Mono white)
        if (info.theme !== (INK[wall] === "dark" ? "light" : "dark") || info.light !== (INK[wall] === "dark" ? 1 : 0)) errs.push(name + ": ink " + INK[wall] + " did not reach the bot (theme " + info.theme + ", light " + info.light + ")");
        // the scratch copy has no supervisor and keeps finding itself offline; its grey "offline" filter on the core is not the app's look (CSSOM rule: the CSP allows it)
        await page.evaluate(() => { const sh = [...document.styleSheets].find((x) => { try { return !!x.cssRules; } catch (e) { return false; } }); sh.insertRule("html.cc-desk #cc-core { filter: none !important; }", sh.cssRules.length); });
        await page.waitForTimeout(100);
        report[report.length - 1].coreFilter = await page.evaluate(() => { const c = document.getElementById("cc-core"); return c ? getComputedStyle(c).filter + " / " + [...document.querySelectorAll("#cc-core, #cc-core *")].map((e) => getComputedStyle(e).filter).filter((f) => f !== "none").join(",") : "no #cc-core"; });
        const shot = await page.screenshot({ omitBackground: true });
        await ctx.close();
        // lay the transparent page over the wallpaper
        const comp = await browser.newPage({ viewport: { width: W, height: H } });
        await comp.setContent('<html><body style="margin:0"><img id="a" style="position:absolute;left:0;top:0;width:' + W + 'px;height:' + H + 'px"><img id="b" style="position:absolute;left:0;top:0;width:' + W + 'px;height:' + H + 'px"></body></html>');
        await comp.evaluate(([a, b]) => Promise.all([["a", a], ["b", b]].map(([i, src]) => new Promise((res) => { const el = document.getElementById(i); el.onload = res; el.src = src; }))), [walls[wall], "data:image/png;base64," + shot.toString("base64")]);
        await comp.screenshot({ path: path.join(OUT, name + ".png") });
        // and a close-up of the core
        await comp.screenshot({ path: path.join(OUT, name + "-core.png"), clip: { x: Math.max(0, Math.min(W - 900, Math.round((info.core ? info.core.cx : W / 2) - 450))), y: Math.max(0, Math.min(H - 700, Math.round((info.core ? info.core.cy : 400) - 330))), width: 900, height: 700 } });
        await comp.close();
      }
    }
    await browser.close();
  } finally {
    s.stop();
  }
  console.log(JSON.stringify(report, null, 1));
  console.log("console/CSP errors: " + errs.length + (errs.length ? "\n" + errs.join("\n") : ""));
  process.exit(errs.length ? 1 : 0);
})().catch((e) => { console.log(e.stack); process.exit(1); });
