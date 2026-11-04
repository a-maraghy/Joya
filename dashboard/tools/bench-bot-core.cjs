#!/usr/bin/env node
"use strict";
/**
 * Frame cost of core E (public/joya-core-bot.js) on its own, in headless Chromium: one 1920 x 1080
 * canvas, the core plus six session heads drifting round it, five seconds per scene (idle, thinking,
 * speaking, delegating; and with the expressive additions: speaking with a spectrum, the pointer moving,
 * dozing). Reports the median / p95 JavaScript cost per frame (prepare + draw submission) -- the same
 * figure the core's stats() gives. Pass a second renderer to compare (e.g. the previous commit's):
 *
 *     PLAYWRIGHT=/path/to/node_modules/playwright node dashboard/tools/bench-bot-core.cjs [OLD_RENDERER.js] [--2d] [--face=smooth|dots|minimal]
 *
 * --face (2026-10-22): the face style the renderer under test draws (a renderer without face styles ignores it).
 *
 * (git show <rev>:dashboard/public/joya-core-bot.js > old.js gives an older renderer.)
 */
const path = require("path");
const fs = require("fs");
const PUB = path.join(__dirname, "..", "public");
const OLD = process.argv.slice(2).find((a) => /\.js$/.test(a));
const FORCE2D = process.argv.includes("--2d");
const FACE = (process.argv.find((a) => a.startsWith("--face=")) || "").slice(7) || null;

async function bench(browser, rendererSrc, label) {
  const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 }, colorScheme: "dark" });
  const page = await ctx.newPage();
  const errs = [];
  page.on("pageerror", (e) => errs.push(e.message));
  page.on("console", (m) => { if (m.type() === "error" || m.type() === "warning") errs.push(m.text()); });
  await page.setContent("<!doctype html><html><body style='margin:0;background:#0D1117'><canvas id='c' style='position:fixed;inset:0;width:1920px;height:1080px'></canvas></body></html>");
  await page.addScriptTag({ content: fs.readFileSync(path.join(PUB, "cc-logic.js"), "utf8") });
  await page.addScriptTag({ content: rendererSrc });
  const out = await page.evaluate(async ([force2d, face]) => {
    const cv = document.getElementById("c");
    const kids = [];
    for (let i = 0; i < 6; i++) kids.push({ key: "k" + i, x: 0, y: 0, r: 34, st: ["working", "idle", "waiting", "idle", "working", "idle"][i], form: 1, dis: 0, alpha: 1, head: ["headset", "mortar", "cap", "antennas", "headphones", "headphones"][i] });
    let t0 = performance.now();
    const bins = new Uint8Array(256);
    const core = window.JoyaCoreBot(cv, {
      noGuard: true, force2d, head: "cap", face: face || undefined,
      amp: () => 0.5,
      spec: () => { const ph = Math.floor(performance.now() / 200) % 3; for (let i = 0; i < 256; i++) bins[i] = (ph === 0 ? i > 1 && i < 6 : ph === 1 ? i > 6 && i < 19 : i > 21 && i < 90) ? 220 : 40; return { bins, hz: 93.75 }; },
      dest: () => [1500, 300],
      kids: () => { const t = (performance.now() - t0) / 1000; kids.forEach((k, i) => { const a = i / 6 * 6.283 + t * 0.05; k.x = 960 + Math.cos(a) * 520; k.y = 540 + Math.sin(a) * 330; }); return kids; },
    });
    core.resize(960, 540, 260, 1920, 1080);
    core.start();
    const res = {};
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const scenes = [["idle", "idle"], ["thinking", "thinking"], ["speaking", "speaking"], ["delegating", "delegating"]];
    if (core.look) scenes.push(["pointer", "idle"], ["dozing", "idle"]);
    for (const [nm, st] of scenes) {
      core.setState(st);
      if (core.look) core.look(null);
      if (nm === "dozing") { core.S.actAt = Date.now() - 11 * 60 * 1000; core._doze(); }
      await wait(1200);
      core.resetStats();
      if (nm === "pointer") { for (let i = 0; i < 50; i++) { core.look(960 + Math.cos(i / 5) * 500, 540 + Math.sin(i / 5) * 300); await wait(100); } }
      else await wait(5000);
      res[nm] = core.stats() || { cpuMed: -1, cpuP95: -1, fps: 0, gl: core.isGL, frames: core.S.frames.length, running: core.S.running };
      if (core.poke) core.poke();
    }
    core.destroy();
    return res;
  }, [FORCE2D, FACE]);
  await ctx.close();
  const row = {};
  Object.keys(out).forEach((k) => { const s = out[k]; row[k] = s.frames != null ? s : { med: +s.cpuMed.toFixed(2), p95: +s.cpuP95.toFixed(2), fps: +s.fps.toFixed(1), gl: s.gl }; });
  return { label, row, errs };
}

(async () => {
  const { chromium } = require(process.env.PLAYWRIGHT || "playwright");
  const browser = await chromium.launch({ args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
  try {
    const runs = [];
    if (OLD) runs.push(await bench(browser, fs.readFileSync(OLD, "utf8"), "old " + path.basename(OLD)));
    runs.push(await bench(browser, fs.readFileSync(path.join(PUB, "joya-core-bot.js"), "utf8"), "now"));
    if (OLD) runs.push(await bench(browser, fs.readFileSync(OLD, "utf8"), "old again " + path.basename(OLD)));
    console.log(JSON.stringify(runs, null, 2));
  } finally { await browser.close(); }
})().catch((e) => { console.error(e); process.exit(1); });
