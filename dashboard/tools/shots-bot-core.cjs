#!/usr/bin/env node
"use strict";
/**
 * Preview of core E ("Bot") for review: screenshots and short recordings of
 * the Command Center with the bot core -- every state in dark and light, head
 * styles, the colour options (Default, Joya only, Mono, Ocean, Sunset, a custom
 * set), the sessions as bot heads (working / idle / waiting / hired forming),
 * a delegation, the page flight into the dock, the desktop app's render mode
 * (?shell=desktop) -- plus Settings ▸ Appearance with the head and colour
 * pickers, and frame times. A scratch copy of the server (tools/scratch-server.cjs:
 * no helper, a temp data dir); the sessions are handed to the page directly
 * (there is no supervisor here).
 *
 *     NODE_PATH=/opt/joya-dashboard/node_modules PLAYWRIGHT=/path/to/node_modules/playwright \
 *       node dashboard/tools/shots-bot-core.cjs OUT_DIR [--quick]
 */
const scratch = require("./scratch-server.cjs");
const path = require("path");
const fs = require("fs");
const { execFileSync } = require("child_process");
const OUT = process.argv[2];
const QUICK = process.argv.includes("--quick");
const APP_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36 Edg/129.0.0.0 JoyaDesktop/0.1.7";
const SESS = [
  { id: "s1", label: "Planning engine", st: "working", subs: [{}, {}], act: 9, task: "Re-running the October allocation" },
  { id: "s2", label: "Customs docs", st: "idle", act: 3, hired: true, slug: "customs" },
  { id: "s3", label: "Invoice audit", st: "waiting", act: 5, task: "Waiting for your approval" },
  { id: "s4", label: "Freight quotes", st: "working", act: 6 },
  { id: "s5", label: "Joya", st: "idle", act: 2 },
  { id: "s6", label: "Odoo sync", st: "idle", act: 4 },
];

(async () => {
  if (!OUT) throw new Error("usage: shots-bot-core.cjs OUT_DIR");
  fs.mkdirSync(OUT, { recursive: true });
  const { chromium } = require(process.env.PLAYWRIGHT || "playwright");
  const s = await scratch.startScratch({});
  const errs = [];
  const report = { frames: {}, shots: [] };
  const db = require(path.join(__dirname, "..", "lib", "db.js"));
  try {
    await s.makeUser("bot", "administrator");
    const { cookie } = await s.signIn("bot");
    const id = db.getUserByName("bot").id;
    const setPrefs = (head, colors) => { db.setUserJoyaCore(id, "E"); if (head) db.setUserBotHead(id, head); db.setUserBotColors(id, colors ? JSON.stringify(colors) : ""); };
    const browser = await chromium.launch({ args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
    async function open(opts) {
      const o = Object.assign({ W: 1440, H: 900, theme: "dark", q: "", video: null, ua: null }, opts);
      const ctx = await browser.newContext({
        viewport: { width: o.W, height: o.H }, colorScheme: o.theme, extraHTTPHeaders: { "X-Forwarded-Proto": "https" },
        userAgent: o.ua || undefined, recordVideo: o.video ? { dir: o.video, size: { width: o.W, height: o.H } } : undefined,
      });
      await ctx.addCookies(String(cookie).split("; ").filter(Boolean).map((kv) => ({ name: kv.split("=")[0], value: kv.slice(kv.indexOf("=") + 1), url: "http://127.0.0.1:" + s.port })));
      const page = await ctx.newPage();
      const tag = o.name || "page";
      page.on("pageerror", (e) => errs.push(tag + ": " + e.message));
      page.on("console", (m) => { const t = m.text(); if ((m.type() === "error" && !/Failed to load resource|net::ERR|503|502|EventSource/.test(t)) || /Content Security Policy|Refused to/.test(t)) errs.push(tag + ": " + t); });
      await page.goto("http://127.0.0.1:" + s.port + (o.path || "/joya-ai") + o.q, { waitUntil: "load" });
      await page.evaluate((th) => { try { localStorage.setItem("joya-theme", th); } catch (e) { /* fine */ } document.documentElement.setAttribute("data-theme", th); document.dispatchEvent(new CustomEvent("joya-theme")); }, o.theme);
      return { ctx, page };
    }
    /** The page has no supervisor here: hide the offline note, keep the state ours, hand it the sessions. */
    async function stage(page, sess) {
      await page.waitForFunction(() => window.__joyaCC && window.__joyaCC.core && window.__joyaCC.core.S.concept === "E", null, { timeout: 15000 });
      await page.evaluate((list) => {
        const cc = window.__joyaCC, O = cc.orbit;
        // (CSSOM, not a style attribute: the CSP allows it) the offline note and the offline caption are this scratch copy's, not the core's
        ["cc-offline", "cc-caption"].forEach((id) => { const el = document.getElementById(id); if (el) el.style.setProperty("display", "none", "important"); });
        O._setState = O.setState; O.setState = function () {}; O.setOffline = function () {};
        cc.core.setOffline(false);
        O.palette();
        if (list) O.setNodes(list);
      }, sess || null);
      // the page's first list was empty (no supervisor): these are born, forming out of the core's dots -- wait until they have
      if (sess) await page.waitForFunction(() => window.__joyaCC.orbit.family.kids().every((k) => k.form >= 1), null, { timeout: 20000 }).catch(() => {});
    }
    const setState = (page, st) => page.evaluate((x) => { const O = window.__joyaCC.orbit; if (x === "offline") { O._setState("idle"); window.__joyaCC.core.setOffline(true); } else { window.__joyaCC.core.setOffline(false); O._setState(x); } }, st);
    const shot = async (page, name) => { const f = path.join(OUT, name + ".png"); await page.screenshot({ path: f }); report.shots.push(name); };
    const canvasLit = (page) => page.evaluate(() => new Promise((res) => window.__joyaCC.orbit.sample((cv) => {
      const c = document.createElement("canvas"); c.width = 200; c.height = 200; const g = c.getContext("2d"); g.drawImage(cv, 0, 0, 200, 200);
      const d = g.getImageData(0, 0, 200, 200).data; let n = 0; for (let i = 3; i < d.length; i += 4) if (d[i] > 8) n++; res(n);
    })));

    /* 1. every state, dark and light (head: cap, Default colours) */
    setPrefs("cap", null);
    const STATES = ["idle", "listening", "thinking", "speaking", "needs", "delegating", "offline"];
    for (const theme of ["dark", "light"]) {
      const { ctx, page } = await open({ theme, name: "states-" + theme });
      await stage(page, SESS.slice(0, 4));
      for (const st of STATES) {
        if (st === "delegating") await page.evaluate(() => window.__joyaCC.orbit.send("s1", 6000));
        await setState(page, st);
        await page.waitForTimeout(st === "delegating" ? 900 : 650);
        await shot(page, `state-${st}-${theme}`);
      }
      report.lit = report.lit || {}; report.lit[theme] = await canvasLit(page);
      await ctx.close();
    }

    /* 2. head styles (a few large, plus all ten in one sheet each theme) */
    for (const head of QUICK ? ["goggles"] : ["goggles", "antennas", "headset", "halo", "mortar", "bowtie", "beanie", "ears", "headphones"]) {
      setPrefs(head, null);
      const { ctx, page } = await open({ theme: "dark", name: "head-" + head });
      await stage(page, SESS.slice(0, 3));
      await setState(page, head === "headset" ? "speaking" : head === "antennas" ? "listening" : "idle");
      await page.waitForTimeout(700);
      await shot(page, `head-${head}-dark`);
      await ctx.close();
    }
    {
      const { ctx, page } = await open({ theme: "dark", W: 1500, H: 760, path: "/joya-ai/settings/appearance", name: "sheet" });
      const html = await page.evaluate(() => {
        const heads = Object.keys(window.JoyaLogic.BOT_HEADS), states = ["idle", "listening", "thinking", "speaking", "needs", "error"];
        document.body.innerHTML = ""; document.body.className = "";
        const wrap = document.createElement("div"); wrap.className = "bot-sheet"; document.body.appendChild(wrap);
        ["dark", "light"].forEach((th) => heads.forEach((h) => {
          const row = document.createElement("div"); row.style.display = "flex"; row.style.background = th === "dark" ? "#0D1117" : "#F8FAFC";
          states.forEach((st) => { const c = document.createElement("canvas"); c.style.width = "120px"; c.style.height = "120px"; row.appendChild(c); window.JoyaBot.thumb(c, h, { state: st, light: th === "light", w: 120, h: 120 }); });
          wrap.appendChild(row);
        }));
        return wrap.scrollHeight;
      });
      await page.setViewportSize({ width: 720, height: html });
      await shot(page, "all-heads-all-states");
      await ctx.close();
    }

    /* 3. colour options on the Command Center (dark + light) */
    const COLORS = [
      ["default", { p: "default" }], ["joya", { p: "joya" }], ["mono", { p: "mono" }], ["ocean", { p: "ocean" }], ["sunset", { p: "sunset" }],
      ["custom", { p: "custom", c: { ready: "#7CFC00", listening: "#00BFFF", thinking: "#FF00FF", speaking: "#FFD700", needs: "#FF8C00", error: "#DC143C", wire: "#9AD0FF" } }],
    ];
    for (const [nm, col] of COLORS) {
      setPrefs("cap", col);
      for (const theme of QUICK ? ["dark"] : ["dark", "light"]) {
        const { ctx, page } = await open({ theme, name: "colors-" + nm });
        await stage(page, SESS.slice(0, 4));
        await setState(page, "thinking");
        await page.waitForTimeout(650);
        await shot(page, `colors-${nm}-${theme}`);
        await ctx.close();
      }
    }
    setPrefs("cap", null);

    /* 4. the sessions as bots: a hire forming, a retire dissolving, a delegation and a reply */
    {
      const { ctx, page } = await open({ theme: "dark", name: "sessions", W: 1920, H: 1080 });
      await stage(page, SESS);
      await page.waitForTimeout(900);
      await shot(page, "sessions-1920-dark");
      await page.evaluate((list) => window.__joyaCC.orbit.setNodes(list.concat([{ id: "s7", label: "Label check", st: "working", act: 3, hired: true, slug: "label" }])), SESS);
      await page.waitForTimeout(1100);
      await shot(page, "sessions-hire-forming");
      await page.waitForTimeout(2200);
      await page.evaluate((list) => window.__joyaCC.orbit.setNodes(list.filter((x) => x.id !== "s5").concat([{ id: "s7", label: "Label check", st: "working", act: 3, hired: true, slug: "label" }])), SESS);
      await page.waitForTimeout(1200);
      await shot(page, "sessions-retire-dissolving");
      await page.waitForTimeout(2500);
      await page.evaluate(() => { window.__joyaCC.orbit.send("s4", 6000); window.__joyaCC.orbit._setState("delegating"); });
      await page.waitForTimeout(1100);
      await shot(page, "delegation-1920-dark");
      await page.evaluate(() => { window.__joyaCC.orbit._setState("idle"); window.__joyaCC.orbit.reply("s1"); });
      await page.waitForTimeout(700);
      await shot(page, "session-reply-speaking");
      // hover card still there
      const k = await page.evaluate(() => window.__joyaCC.orbit.family.kids().find((x) => x.id === "s3"));
      await page.mouse.move(k.x, k.y);
      await page.waitForTimeout(500);
      report.hover = await page.evaluate(() => document.getElementById("cc-kcard").classList.contains("on"));
      await shot(page, "session-hover-card");
      // frame times: 1920 x 1080, six sessions, idle and speaking
      for (const st of ["idle", "speaking", "thinking"]) {
        await page.mouse.move(5, 5);
        await page.evaluate((x) => { window.__joyaCC.orbit._setState(x); window.__joyaCC.core.resetStats(); }, st);
        await page.waitForTimeout(4000);
        report.frames["1920x1080-6sessions-" + st] = await page.evaluate(() => window.__joyaCC.core.stats());
      }
      report.audit = await page.evaluate(() => window.__joyaCC.orbit.family.audit());
      // the same scene with core D (the default), for comparison on this machine
      await page.evaluate(() => { window.__joyaCC.orbit.setConcept("D"); window.__joyaCC.orbit._setState("idle"); });
      await page.waitForTimeout(1500);
      await page.evaluate(() => window.__joyaCC.core.resetStats());
      await page.waitForTimeout(4000);
      report.frames["coreD-1920x1080-6sessions-idle"] = await page.evaluate(() => window.__joyaCC.core.stats());
      await ctx.close();
    }
    {
      const { ctx, page } = await open({ theme: "light", name: "sessions-light", W: 1440, H: 900 });
      await stage(page, SESS);
      await page.waitForTimeout(900);
      await shot(page, "sessions-1440-light");
      await ctx.close();
    }

    /* 5. the page flight into the dock and back (joya-shell.js) */
    {
      const { ctx, page } = await open({ theme: "dark", name: "flight" });
      await stage(page, SESS.slice(0, 4));
      await page.waitForTimeout(500);
      await page.evaluate(() => window.JoyaShell.open("/account"));
      await page.waitForTimeout(450);
      await shot(page, "flight-down-mid");
      await page.waitForTimeout(1400);
      await shot(page, "dock-on-page");
      await page.evaluate(() => window.JoyaShell.expand());
      await page.waitForTimeout(500);
      await shot(page, "flight-up-mid");
      await page.waitForTimeout(1200);
      await ctx.close();
    }
    {
      // the dock on a page loaded directly (not through the shell)
      const { ctx, page } = await open({ theme: "light", name: "dock-direct", path: "/account" });
      await page.waitForTimeout(900);
      report.dockE = await page.evaluate(() => document.getElementById("joya-dock-root").getAttribute("data-core"));
      await shot(page, "dock-direct-light");
      await ctx.close();
    }

    /* 6. the desktop app's render mode */
    for (const [nm, W, H, q] of [["desktop-layer-1920-dark", 1920, 1032, "mode=desktop"], ["desktop-layer-1920-light", 1920, 1032, "mode=desktop&ink=dark"], ["desktop-floating-M", 480, 860, "mode=floating"], ["desktop-focus", 168, 168, "mode=floating&focus=1"]]) {
      const { ctx, page } = await open({ theme: /light/.test(nm) ? "light" : "dark", W, H, q: "?shell=desktop&" + q, ua: APP_UA, name: nm });
      await stage(page, SESS.slice(0, 4));
      await setState(page, "idle");
      await page.waitForTimeout(800);
      if (nm === "desktop-layer-1920-dark") report.regions = await page.evaluate(() => (window.JoyaDesktop && window.JoyaDesktop.regions && window.JoyaDesktop.regions()) || null);
      await shot(page, nm);
      await ctx.close();
    }

    /* 7. Settings ▸ Appearance: the pickers */
    for (const [nm, col, theme] of [["default", null, "dark"], ["custom", COLORS[5][1], "dark"], ["custom", { p: "custom", c: { ready: "#00E6A5", listening: "#10D0A0", thinking: "#966EFF", speaking: "#FF5AC8", needs: "#FFBE3C", error: "#FF5050", wire: "#E1E8F8" } }, "light"]]) {
      setPrefs("cap", col);
      const { ctx, page } = await open({ theme, W: 1440, H: 1500, path: "/joya-ai/settings/appearance", name: "settings-" + nm });
      await page.waitForTimeout(1200);
      const tag = `${nm}-${theme}${col && col.c && col.c.listening === "#10D0A0" ? "-warning" : ""}`;
      if (nm === "default") await page.locator("#a-core").screenshot({ path: path.join(OUT, "settings-core-picker-" + theme + ".png") });
      await page.locator("#a-bot").screenshot({ path: path.join(OUT, "settings-bot-" + tag + ".png") });
      report.shots.push("settings-bot-" + tag);
      await ctx.close();
    }
    {
      const { ctx, page } = await open({ theme: "dark", W: 390, H: 1600, path: "/joya-ai/settings/appearance", name: "settings-phone" });
      await page.waitForTimeout(1000);
      await page.locator("#a-bot").screenshot({ path: path.join(OUT, "settings-bot-phone-390.png") });
      report.hscroll = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
      await ctx.close();
    }

    /* 8. recordings (webm; a gif each) */
    if (!QUICK) {
      const vdir = path.join(OUT, "video-tmp");
      const clips = [
        ["rec-states-dark", "dark", async (page) => { for (const st of ["idle", "listening", "thinking", "speaking", "needs", "delegating", "idle"]) { if (st === "delegating") await page.evaluate(() => window.__joyaCC.orbit.send("s1", 5000)); await setState(page, st); await page.waitForTimeout(st === "idle" ? 2600 : 1700); } }],
        ["rec-states-light", "light", async (page) => { for (const st of ["idle", "listening", "thinking", "speaking", "needs", "offline", "idle"]) { await setState(page, st); await page.waitForTimeout(1600); } }],
        ["rec-sessions-hire-retire", "dark", async (page) => {
          await page.waitForTimeout(1200);
          await page.evaluate((list) => window.__joyaCC.orbit.setNodes(list.concat([{ id: "s7", label: "Label check", st: "working", act: 3, hired: true, slug: "label" }])), SESS);
          await page.waitForTimeout(3200);
          await page.evaluate(() => { window.__joyaCC.orbit.send("s7", 5000); window.__joyaCC.orbit._setState("delegating"); });
          await page.waitForTimeout(2600);
          await page.evaluate((list) => { window.__joyaCC.orbit._setState("idle"); window.__joyaCC.orbit.setNodes(list.filter((x) => x.id !== "s2").concat([{ id: "s7", label: "Label check", st: "idle", act: 3, hired: true, slug: "label" }])); }, SESS);
          await page.waitForTimeout(3600);
        }],
        ["rec-flight", "dark", async (page) => { await page.waitForTimeout(800); await page.evaluate(() => window.JoyaShell.open("/account")); await page.waitForTimeout(2600); await page.evaluate(() => window.JoyaShell.expand()); await page.waitForTimeout(2400); }],
      ];
      for (const [nm, theme, run] of clips) {
        fs.rmSync(vdir, { recursive: true, force: true });
        const { ctx, page } = await open({ theme, W: 1280, H: 720, video: vdir, name: nm });
        await stage(page, nm === "rec-sessions-hire-retire" ? SESS : SESS.slice(0, 4));
        await run(page);
        const v = page.video();
        await ctx.close();
        const src = await v.path();
        const webm = path.join(OUT, nm + ".webm");
        fs.copyFileSync(src, webm);
        try {
          execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-i", webm, "-vf", "fps=15,scale=640:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=128[p];[b][p]paletteuse=dither=bayer", path.join(OUT, nm + ".gif")]);
        } catch (e) { errs.push("gif " + nm + ": " + e.message); }
      }
      fs.rmSync(vdir, { recursive: true, force: true });
    }
    await browser.close();
  } finally {
    s.stop();
  }
  report.errors = errs;
  fs.writeFileSync(path.join(OUT, "report.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ shots: report.shots.length, errors: errs, lit: report.lit, frames: report.frames, hover: report.hover, audit: report.audit, dockE: report.dockE, hscroll: report.hscroll }, null, 2));
  process.exit(errs.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
