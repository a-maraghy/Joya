#!/usr/bin/env node
"use strict";
/**
 * Look and speak as shipped (2026-10-21, option A: the bot itself): screenshots of the real desktop page with core E's
 * own renderer (core.indicate), the headphones head, in arming (50 %), ready, listening, paused, and a voice not
 * recognised (the state pill's note + the headshake), dark and light, Floating L and Companion, plus a GIF.
 * Phases are driven directly on the core (the camera module drives the same API on a real face); the not-recognised
 * pill is what joya-ai.js showVoiceprint() writes for a gated "unknown voice".
 *
 *     NODE_PATH=/opt/joya-dashboard/node_modules PLAYWRIGHT=/path/to/node_modules/playwright \
 *       node dashboard/tools/shots-look-speak.cjs   -> mockups/eye-contact/indicators/shipped/
 */
const scratch = require("./scratch-server.cjs");
const path = require("path");
const fs = require("fs");
const { spawnSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const OUT = path.join(ROOT, "..", "mockups", "eye-contact", "indicators", "shipped");
const APP_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36 Edg/129.0.0.0 JoyaDesktop/0.1.12";
const PHASES = ["arming", "ready", "listening", "paused", "not-recognised"];
const LABEL = { arming: "Ready", ready: "Ready to talk", listening: "Listening", paused: "Paused", "not-recognised": "Didn't recognise your voice, try again" };

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const { chromium } = require(process.env.PLAYWRIGHT || "playwright");
  const LAYM = require(path.join(ROOT, "public", "joya-desktop-layout.js"));
  const s = await scratch.startScratch({});
  const browser = await chromium.launch({ args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
  const errs = [];
  try {
    await s.makeUser("looks", "administrator");
    const { cookie } = await s.signIn("looks");
    const ORIGIN = "http://127.0.0.1:" + s.port;
    const L = LAYM.windowSize({ mode: "floating", size: "L" });
    const LAYOUTS = {
      floating: { state: { mode: "floating", size: "L", peekOpen: true }, size: L },
      companion: { state: { mode: "companion", peekOpen: false, companion: { stayOnMonitor: false, ducked: false } }, size: { w: 176, h: 160 } },
    };
    for (const scheme of ["dark", "light"]) {
      for (const lay of ["floating", "companion"]) {
        const L_ = LAYOUTS[lay];
        const ctx = await browser.newContext({ viewport: { width: L_.size.w, height: L_.size.h }, deviceScaleFactor: 2, colorScheme: scheme, userAgent: APP_UA, extraHTTPHeaders: { "X-Forwarded-Proto": "https" }, screen: { width: 1920, height: 1080 } });
        await ctx.addCookies(String(cookie).split("; ").filter(Boolean).map((kv) => ({ name: kv.split("=")[0], value: kv.slice(kv.indexOf("=") + 1), url: ORIGIN })));
        await ctx.addInitScript((st) => {
          const Lz = {};
          window.__TAURI__ = { core: { invoke: (cmd) => Promise.resolve(cmd === "get_state" ? st : null) }, event: { listen: (n, f) => { (Lz[n] = Lz[n] || []).push(f); return Promise.resolve(() => {}); } } };
        }, L_.state);
        const page = await ctx.newPage();
        page.on("pageerror", (e) => errs.push(e.message));
        await page.goto(ORIGIN + "/joya-ai?shell=desktop", { waitUntil: "load" });
        await page.waitForTimeout(1800);
        await page.evaluate((sc) => {
          window.__joyaCC.orbit.setConcept("E");
          document.documentElement.setAttribute("data-theme", sc);
          window.__lab = "Ready";
          // the scratch copy has no supervisor: online, as on a real machine; the state pill says what it would
          setInterval(() => {
            const S = window.__joyaCC.S; if (S) S.online = true; const o = document.getElementById("cc-offline"); if (o) o.hidden = true;
            if (window.__core) window.__core().setOffline(false);
            const el = document.getElementById("cc-cap-label"), box = document.getElementById("cc-cap-state");
            if (el && el.textContent !== window.__lab) el.textContent = window.__lab;
            if (box) { if (window.__vp) box.setAttribute("data-vp", "bad"); else box.removeAttribute("data-vp"); }
          }, 80);
        }, scheme);
        await page.waitForTimeout(900);
        await page.evaluate(() => {
          const comp = document.documentElement.classList.contains("dk-comp-out");
          window.__core = () => (comp ? window.JoyaDesktop.companion().debug.core() : window.__joyaCC.core);
          const k = window.__core(); k.setHead("headphones"); if (k.look) k.look(null);
          window.__box = () => { const k2 = window.__core(), cv = comp ? document.getElementById("dk-comp-cv") : k2.canvas, cb = cv.getBoundingClientRect(), S = k2.S, d = S.dpr || 1; return { x: cb.left + S.c[0] / d, y: cb.top + S.cssH - S.c[1] / d + S.R / d * 0.12, r: S.R / d * 0.57 }; };
        });
        const set = (phase, arm) => page.evaluate((a) => {
          const k = window.__core();
          k.setOffline(false);
          window.__lab = a.label; window.__vp = a.phase === "not-recognised";
          k.setState(a.phase === "listening" ? "listening" : a.phase === "paused" ? "speaking" : "idle");
          if (a.phase === "not-recognised") { k.indicate(null); k.shake(); return; }
          k.indicate(a.phase ? { phase: a.phase, arm: a.arm, armMs: 0 } : null);
        }, { phase, arm: arm == null ? 0.5 : arm, label: phase ? LABEL[phase] : "Ready" });
        const clip = async (wide) => {
          if (lay === "companion") return { x: 0, y: 0, width: L_.size.w, height: L_.size.h };
          const b = await page.evaluate(() => window.__box());
          const half = Math.round(b.r * 2.3);
          if (wide) return { x: 0, y: Math.max(0, Math.round(b.y - half)), width: L_.size.w, height: Math.round(half * 2.25) }; // the note: the whole width
          return { x: Math.max(0, Math.round(b.x - half)), y: Math.max(0, Math.round(b.y - half)), width: half * 2, height: Math.round(half * 2.25) };
        };
        for (const ph of PHASES) {
          await set(ph);
          await page.waitForTimeout(ph === "not-recognised" ? 260 : ph === "listening" ? 900 : 650);
          await page.screenshot({ path: path.join(OUT, `${ph}-${lay}-${scheme}.png`), clip: await clip(ph === "not-recognised") });
        }
        if (lay === "floating") {
          const dir = path.join(OUT, ".frames");
          fs.rmSync(dir, { recursive: true, force: true }); fs.mkdirSync(dir, { recursive: true });
          await set(null); await page.waitForTimeout(400);
          const c = await clip(); let n = 0;
          const grab = () => page.screenshot({ path: path.join(dir, String(n++).padStart(3, "0") + ".png"), clip: c });
          for (let i = 0; i < 4; i++) await grab();
          for (let i = 1; i <= 8; i++) { await set("arming", i / 8); await grab(); }
          await page.evaluate(() => { window.__lab = "Ready to talk"; window.__core().indicate({ phase: "ready" }); });
          for (let i = 0; i < 12; i++) await grab();
          await set("listening"); for (let i = 0; i < 14; i++) await grab();
          await set("paused"); for (let i = 0; i < 10; i++) await grab();
          await set("not-recognised"); for (let i = 0; i < 10; i++) await grab();
          const ff = spawnSync("ffmpeg", ["-y", "-loglevel", "error", "-framerate", "10", "-i", path.join(dir, "%03d.png"), "-vf", "scale=280:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=64:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle", "-loop", "0", path.join(OUT, `look-and-speak-${scheme}.gif`)]);
          if (ff.status !== 0) console.log("no GIF: ffmpeg " + (ff.error ? "missing" : String(ff.stderr)));
          fs.rmSync(dir, { recursive: true, force: true });
        }
        await ctx.close();
      }
    }
    console.log("wrote " + OUT + (errs.length ? "\npage errors: " + errs.join(" | ") : ""));
  } finally {
    await browser.close();
    s.stop();
  }
})().catch((e) => { console.error(e); process.exit(1); });
