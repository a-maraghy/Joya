#!/usr/bin/env node
"use strict";
/**
 * Preview of the two core E design upgrades (2026-10-20) for review:
 *
 *   1. an expressive bot -- the mouth's shapes from the voice spectrum (closed / open / wide / round),
 *      the eyes following the pointer, dozing (quiet spell or night) and waking, the small reactions
 *      (surprise, grin, nod);
 *   2. a team of bots -- the sessions' accessories by role, the per-session override picker in the
 *      Sessions sheet.
 *
 * Screenshots (dark and light) and short GIFs of the Command Center with core E, on a scratch copy of the
 * server (tools/scratch-server.cjs: no helper, a temp data dir). The voice is a synthetic spectrum handed
 * to the page (orbit.outSource / outSpectrum); the sessions are handed to the page's own sessions list
 * (there is no supervisor here), so the role rule table and the picker run for real.
 *
 *     NODE_PATH=/opt/joya-dashboard/node_modules PLAYWRIGHT=/path/to/node_modules/playwright \
 *       node dashboard/tools/shots-bot-upgrades.cjs OUT_DIR [--no-gif]
 */
const scratch = require("./scratch-server.cjs");
const path = require("path");
const fs = require("fs");
const { execFileSync } = require("child_process");
const OUT = process.argv[2];
const GIF = !process.argv.includes("--no-gif");

// The sessions, as the supervisor would list them: the role table (cc-logic botRole) picks each head.
const SESSIONS = [
  { session_id: "s1", pid: 101, name: "Odoo dev", cwd: "/opt/odoo/custom", status: "busy", where: "Terminal" },
  { session_id: "s2", pid: 102, name: "Planning engine", cwd: "/root/joya/giza-planning-engine", status: "busy", where: "Terminal" },
  { session_id: "s3", pid: 103, name: "Customs docs", cwd: "/root/joya", status: "idle", where: "Terminal", hired: true, hire: { slug: "customs", kept: false } },
  { session_id: "s4", pid: 104, name: "Joya desktop", cwd: "/root/joya/Joya", status: "idle", where: "Desktop" },
  { session_id: "s5", pid: 105, name: "Invoice audit", cwd: "/root/joya", status: "waiting", waiting_for: "your approval", where: "Terminal" },
  { session_id: "s6", pid: 106, name: "Freight quotes", cwd: "/root/joya", status: "idle", where: "Terminal" },
];

(async () => {
  if (!OUT) throw new Error("usage: shots-bot-upgrades.cjs OUT_DIR");
  fs.mkdirSync(OUT, { recursive: true });
  const { chromium } = require(process.env.PLAYWRIGHT || "playwright");
  const s = await scratch.startScratch({});
  const errs = [];
  const report = { shots: [], gifs: [], frames: {}, checks: {} };
  const db = require(path.join(__dirname, "..", "lib", "db.js"));
  let browser = null;
  try {
    await s.makeUser("bot", "administrator");
    const { cookie } = await s.signIn("bot");
    const id = db.getUserByName("bot").id;
    db.setUserJoyaCore(id, "E");
    db.setUserBotHead(id, "cap");
    browser = await chromium.launch({ args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
    const vdir = path.join(OUT, "video-tmp");
    async function open(o) {
      o = Object.assign({ W: 1280, H: 760, theme: "dark", video: false, name: "page" }, o);
      const ctx = await browser.newContext({ viewport: { width: o.W, height: o.H }, colorScheme: o.theme, extraHTTPHeaders: { "X-Forwarded-Proto": "https" }, recordVideo: o.video && GIF ? { dir: vdir, size: { width: o.W, height: o.H } } : undefined });
      await ctx.addCookies(String(cookie).split("; ").filter(Boolean).map((kv) => ({ name: kv.split("=")[0], value: kv.slice(kv.indexOf("=") + 1), url: "http://127.0.0.1:" + s.port })));
      const page = await ctx.newPage();
      page.on("pageerror", (e) => errs.push(o.name + ": " + e.message));
      page.on("console", (m) => { const t = m.text(); if ((m.type() === "error" && !/Failed to load resource|net::ERR|503|502|EventSource/.test(t)) || /Content Security Policy|Refused to/.test(t)) errs.push(o.name + ": " + t); });
      await page.goto("http://127.0.0.1:" + s.port + "/joya-ai", { waitUntil: "load" });
      await page.evaluate((th) => { try { localStorage.setItem("joya-theme", th); } catch (e) { /* fine */ } document.documentElement.setAttribute("data-theme", th); document.dispatchEvent(new CustomEvent("joya-theme")); }, o.theme);
      await page.waitForFunction(() => window.__joyaCC && window.__joyaCC.core && window.__joyaCC.core.S.concept === "E", null, { timeout: 15000 });
      await page.evaluate(() => {
        const cc = window.__joyaCC, O = cc.orbit;
        ["cc-offline", "cc-caption"].forEach((i) => { const el = document.getElementById(i); if (el) el.style.setProperty("display", "none", "important"); });
        O._setState = O.setState; O.setState = function () {}; O.setOffline = function () {};
        cc.core.setOffline(false); cc.core.S.rk = "";
        O.palette();
        // a synthetic voice: a level and a spectrum that walk through vowels (a, ee, oo, m)
        const bins = new Uint8Array(256), hz = 48000 / 512, prof = { a: [600, 1800], ee: [2000, 7000], oo: [160, 560], m: null };
        window.__voice = { seq: ["a", "ee", "oo", "m", "a", "oo", "ee", "a", "m"], ms: 230, fixed: null };
        const cur = () => { const v = window.__voice; return v.fixed || v.seq[Math.floor(performance.now() / v.ms) % v.seq.length]; };
        O.outSource(() => (cur() === "m" ? 0.02 : 0.55));
        O.outSpectrum(() => { const p = prof[cur()]; for (let i = 0; i < bins.length; i++) { const f = i * hz; bins[i] = p && f >= p[0] && f <= p[1] ? 225 : 40; } return { bins, hz }; });
      });
      return { ctx, page };
    }
    async function sessions(page, list) {
      await page.evaluate((l) => { const cc = window.__joyaCC; cc.S.sessions = l; cc.renderSessions(true); }, list);
      await page.waitForFunction(() => window.__joyaCC.orbit.family.kids().length > 0 && window.__joyaCC.orbit.family.kids().every((k) => k.form >= 1), null, { timeout: 20000 }).catch(() => {});
    }
    const shot = async (page, name, clip) => { await page.screenshot({ path: path.join(OUT, name + ".png"), clip }); report.shots.push(name); };
    const coreClip = (page, k) => page.evaluate((kk) => { const L = window.__joyaCC.orbit.layout, R = L.R * (kk || 1.35); return { x: Math.max(0, L.cx - R), y: Math.max(0, L.cy - R * 1.05), width: R * 2, height: R * 2 }; }, k);
    const st = (page, x) => page.evaluate((v) => window.__joyaCC.orbit._setState(v), x);
    async function gif(ctx, page, name, crop) {
      if (!GIF) return ctx.close();
      const v = page.video();
      await ctx.close();
      const webm = await v.path();
      try {
        const vf = (crop ? `crop=${Math.round(crop.width)}:${Math.round(crop.height)}:${Math.round(crop.x)}:${Math.round(crop.y)},` : "") + "fps=15,scale=480:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=96[p];[b][p]paletteuse=dither=bayer";
        execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-ss", "0.8", "-i", webm, "-vf", vf, path.join(OUT, name + ".gif")]);
        report.gifs.push(name);
      } catch (e) { errs.push("gif " + name + ": " + e.message); }
      try { fs.unlinkSync(webm); } catch (e) { /* gone */ }
    }

    /* 1. speaking: the four mouth shapes, then a GIF of a sentence */
    for (const theme of ["dark", "light"]) {
      const { ctx, page } = await open({ theme, name: "mouth-" + theme });
      await st(page, "speaking");
      const clip = await coreClip(page);
      for (const v of ["m", "a", "ee", "oo"]) {
        await page.evaluate((x) => { window.__voice.fixed = x; }, v);
        await page.waitForTimeout(500);
        const nm = { m: "closed", a: "open", ee: "wide", oo: "round" }[v];
        if (theme === "dark") report.checks["vis-" + nm] = await page.evaluate(() => JSON.parse(JSON.stringify(window.__joyaCC.core.S.vis)));
        await shot(page, "1-mouth-" + nm + "-" + theme, clip);
      }
      await ctx.close();
    }
    {
      const { ctx, page } = await open({ theme: "dark", name: "mouth-gif", video: true });
      await st(page, "speaking");
      const clip = await coreClip(page);
      await page.waitForTimeout(4200);
      await gif(ctx, page, "1-speaking-mouth-shapes", clip);
    }

    /* 2. the eyes follow the pointer */
    for (const theme of ["dark", "light"]) {
      const { ctx, page } = await open({ theme, name: "eyes-" + theme });
      const L = await page.evaluate(() => window.__joyaCC.orbit.layout);
      const clip = await coreClip(page);
      const spots = { left: [L.cx - L.R * 2.6, L.cy], right: [L.cx + L.R * 2.6, L.cy], up: [L.cx + L.R * 0.5, L.cy - L.R * 1.3], down: [L.cx - L.R * 0.5, L.cy + L.R * 2.2] };
      for (const k of Object.keys(spots)) {
        await page.mouse.move(spots[k][0], spots[k][1], { steps: 6 });
        await page.waitForTimeout(600);
        if (theme === "dark") report.checks["gaze-" + k] = await page.evaluate(() => { const a = window.__joyaCC.core._anim(); return [+a.gx.toFixed(2), +a.gy.toFixed(2)]; });
        await shot(page, "2-eyes-" + k + "-" + theme, clip);
      }
      await ctx.close();
    }
    {
      const { ctx, page } = await open({ theme: "dark", name: "eyes-gif", video: true });
      const L = await page.evaluate(() => window.__joyaCC.orbit.layout);
      const clip = await coreClip(page, 1.6);
      for (let i = 0; i <= 48; i++) { const a = (i / 48) * Math.PI * 2; await page.mouse.move(L.cx + Math.cos(a) * L.R * 2.4, L.cy + Math.sin(a) * L.R * 1.9); await page.waitForTimeout(70); }
      await page.mouse.move(2, 2);
      await page.evaluate(() => document.dispatchEvent(new PointerEvent("pointerout", { relatedTarget: null })));
      await page.waitForTimeout(1600);
      await gif(ctx, page, "2-eyes-follow-pointer", clip);
    }

    /* 3. dozing and waking */
    for (const theme of ["dark", "light"]) {
      const { ctx, page } = await open({ theme, name: "doze-" + theme });
      await page.mouse.move(2, 2);
      const clip = await coreClip(page, 1.6);
      await page.evaluate(() => { const k = window.__joyaCC.core; k.look(null); k.S.actAt = Date.now() - 11 * 60 * 1000; k._doze(); });
      await page.waitForTimeout(1300);
      await shot(page, "3-drowsy-" + theme, clip);
      await page.waitForTimeout(2600);
      await shot(page, "3-dozing-" + theme, clip);
      if (theme === "dark") report.checks.doze = await page.evaluate(() => ({ dozeT: window.__joyaCC.core.S.dozeT, doze: +window.__joyaCC.core.S.doze.toFixed(2), face: window.__joyaCC.core._anim().face }));
      const L = await page.evaluate(() => window.__joyaCC.orbit.layout);
      await page.mouse.move(L.cx + L.R * 1.2, L.cy, { steps: 8 });
      await page.waitForTimeout(260);
      await shot(page, "3-waking-" + theme, clip);
      if (theme === "dark") report.checks.wake = await page.evaluate(() => ({ dozeT: window.__joyaCC.core.S.dozeT, rk: window.__joyaCC.core.S.rk }));
      await ctx.close();
    }
    {
      const { ctx, page } = await open({ theme: "dark", name: "doze-gif", video: true });
      await page.mouse.move(2, 2);
      const clip = await coreClip(page, 1.6);
      await page.evaluate(() => { const k = window.__joyaCC.core; k.look(null); k.S.actAt = Date.now() - 11 * 60 * 1000; k._doze(); });
      await page.waitForTimeout(6500);
      const L = await page.evaluate(() => window.__joyaCC.orbit.layout);
      await page.mouse.move(L.cx + L.R * 1.3, L.cy + L.R * 0.3, { steps: 10 });
      await page.waitForTimeout(1800);
      await gif(ctx, page, "3-dozing-and-waking", clip);
    }
    {
      // the night: 23:00-06:00 local, a minute of quiet is enough (a core with a fixed clock, 01:00)
      const { ctx, page } = await open({ theme: "dark", name: "night" });
      report.checks.night = await page.evaluate(() => {
        const cv = document.createElement("canvas"); document.body.appendChild(cv);
        let t = Date.now(); const k = window.JoyaCoreBot(cv, { force2d: true, now: () => t, hour: () => 1 });
        const a = k._doze(); t += 90 * 1000; const b = k._doze(); k.destroy(); cv.remove();
        return { afterBoot: a, afterMinute: b };
      });
      await ctx.close();
    }

    /* 4. reactions: surprise (going offline), grin (a job done), nod (approved) */
    for (const theme of ["dark", "light"]) {
      const { ctx, page } = await open({ theme, name: "react-" + theme });
      await page.mouse.move(2, 2);
      const clip = await coreClip(page, 1.5);
      for (const [kind, at] of [["surprise", 240], ["grin", 380], ["nod", 220]]) {
        await page.evaluate((k) => { const c = window.__joyaCC.core; c.look(null); if (k === "surprise") { c.setOffline(true); } else { c.setOffline(false); window.__joyaCC.orbit.react(k); } }, kind);
        await page.waitForTimeout(at);
        await shot(page, "4-" + kind + "-" + theme, clip);
        await page.waitForTimeout(1800);
        if (kind === "surprise") { await shot(page, "4-surprise-then-offline-" + theme, clip); await page.evaluate(() => window.__joyaCC.core.setOffline(false)); await page.waitForTimeout(500); }
      }
      await ctx.close();
    }
    for (const kind of ["surprise", "grin", "nod"]) {
      const { ctx, page } = await open({ theme: "dark", name: "react-gif-" + kind, video: true });
      await page.mouse.move(2, 2);
      const clip = await coreClip(page, 1.5);
      await page.waitForTimeout(700);
      for (let i = 0; i < 2; i++) {
        await page.evaluate((k) => { const c = window.__joyaCC.core; if (k === "surprise") c.setOffline(true); else window.__joyaCC.orbit.react(k); }, kind);
        await page.waitForTimeout(kind === "surprise" ? 1500 : 1900);
        if (kind === "surprise") { await page.evaluate(() => window.__joyaCC.core.setOffline(false)); await page.waitForTimeout(700); }
      }
      await gif(ctx, page, "4-" + kind, clip);
    }

    /* 5. the team: the sessions' accessories by role, and the override picker */
    for (const theme of ["dark", "light"]) {
      const { ctx, page } = await open({ theme, name: "team-" + theme, W: 1440, H: 900 });
      await page.mouse.move(2, 2);
      await sessions(page, SESSIONS);
      await page.waitForTimeout(900);
      await shot(page, "5-team-" + theme);
      if (theme === "dark") {
        report.checks.team = await page.evaluate(() => window.__joyaCC.orbit.family.meshKids().map((k) => k.key + ":" + k.head));
        // the override: Invoice audit pinned to the halo in the Sessions sheet
        await page.evaluate(() => window.__joyaCC.openSheet("sessions"));
        await page.waitForTimeout(500);
        await page.selectOption('select[data-bot-sess="Invoice audit"]', "halo");
        await page.waitForTimeout(900);
        const sheet = await page.evaluate(() => { const r = document.getElementById("cc-sheet").getBoundingClientRect(); return { x: r.left, y: r.top, width: r.width, height: r.height }; });
        await shot(page, "5-override-picker-sheet-" + theme, sheet);
        await shot(page, "5-team-with-override-" + theme);
        report.checks.override = { saved: db.getUserByName("bot").joya_bot_team, kid: await page.evaluate(() => (window.__joyaCC.orbit.family.meshKids().find((k) => k.key === "s5") || {}).head) };
        // back to automatic
        await page.selectOption('select[data-bot-sess="Invoice audit"]', "");
        await page.waitForTimeout(600);
        report.checks.overrideCleared = db.getUserByName("bot").joya_bot_team;
      }
      await ctx.close();
    }
    {
      // a close-up of each role's head, as the sessions wear them (the Settings thumbnail renderer)
      for (const theme of ["dark", "light"]) {
        const { ctx, page } = await open({ theme, name: "roles-" + theme, W: 1100, H: 300 });
        await page.evaluate((th) => {
          const L = window.JoyaLogic, wrap = document.createElement("div");
          wrap.id = "roles"; wrap.style.cssText = "position:fixed;inset:0;z-index:99999;display:flex;gap:18px;align-items:center;justify-content:center;font:600 13px system-ui;background:" + (th === "light" ? "#F6F8FB" : "#0D1117") + ";color:" + (th === "light" ? "#262E40" : "#E1E8F8");
          [["Odoo / ERP", "headset"], ["Planning", "mortar"], ["Hired", "cap"], ["Joya / builder", "antennas"], ["Other", "headphones"]].forEach(([lab, h], i) => {
            const cell = document.createElement("div"); cell.style.cssText = "display:flex;flex-direction:column;align-items:center;gap:6px";
            const cv = document.createElement("canvas"); cv.style.cssText = "width:180px;height:180px";
            const t = document.createElement("div"); t.textContent = lab + " · " + L.BOT_HEADS[h];
            cell.appendChild(cv); cell.appendChild(t); wrap.appendChild(cell);
            window.JoyaBot.thumb(cv, h, { state: ["thinking", "thinking", "idle", "idle", "needs"][i], light: th === "light", w: 180, h: 180 });
          });
          document.body.appendChild(wrap);
        }, theme);
        await page.waitForTimeout(200);
        await shot(page, "5-roles-" + theme);
        await ctx.close();
      }
    }

    /* 6. frame times (1920 x 1080, six sessions): idle, speaking with visemes, pointer following, dozing */
    {
      const { ctx, page } = await open({ theme: "dark", name: "frames", W: 1920, H: 1080 });
      await sessions(page, SESSIONS);
      await page.waitForTimeout(1200);
      const L = await page.evaluate(() => window.__joyaCC.orbit.layout);
      for (const [nm, prep] of [["idle", "idle"], ["speaking-visemes", "speaking"], ["pointer-follow", "idle"], ["dozing", "doze"]]) {
        await page.evaluate((p) => { const c = window.__joyaCC.core; c.look(null); window.__joyaCC.orbit._setState(p === "doze" ? "idle" : p); if (p === "doze") { c.S.actAt = Date.now() - 11 * 60 * 1000; c._doze(); } }, prep);
        await page.waitForTimeout(1500);
        await page.evaluate(() => window.__joyaCC.core.resetStats());
        if (nm === "pointer-follow") { for (let i = 0; i < 40; i++) { await page.mouse.move(L.cx + Math.cos(i / 6) * L.R * 2, L.cy + Math.sin(i / 6) * L.R); await page.waitForTimeout(100); } }
        else await page.waitForTimeout(4000);
        report.frames[nm] = await page.evaluate(() => window.__joyaCC.core.stats());
        await page.mouse.move(2, 2);
        await page.evaluate(() => { const c = window.__joyaCC.core; c.poke(); c.look(null); });
      }
      await ctx.close();
    }
  } catch (e) {
    errs.push("run: " + e.stack + "\n" + s.out().slice(-2000));
  } finally {
    if (browser) await browser.close();
    s.stop();
    try { fs.rmSync(path.join(OUT, "video-tmp"), { recursive: true, force: true }); } catch (e) { /* gone */ }
  }
  report.errors = errs;
  fs.writeFileSync(path.join(OUT, "report.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ shots: report.shots.length, gifs: report.gifs, errors: errs, checks: report.checks, frames: report.frames }, null, 2));
  process.exit(errs.length ? 1 : 0);
})();
