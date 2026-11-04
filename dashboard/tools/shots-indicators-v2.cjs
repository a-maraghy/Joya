#!/usr/bin/env node
"use strict";
/**
 * Look and speak indications v2 -- three options for the user to pick (2026-10-21; NOT shipped). The real desktop
 * page (?shell=desktop, a scratch server) with core E's renderer swapped for the prototype built from it
 * (mockups/eye-contact/indicators-v2/build-proto.cjs: core.indicate({ mode, phase, arm })), the headphones head,
 * each option in each phase (arming at 50 %, ready, listening, paused), dark and light, Floating L and Companion;
 * a GIF per option and theme (idle -> arming -> ready -> listening -> paused); a contact sheet.
 *
 *     NODE_PATH=/opt/joya-dashboard/node_modules PLAYWRIGHT=/path/to/node_modules/playwright \
 *       node dashboard/tools/shots-indicators-v2.cjs
 */
const scratch = require("./scratch-server.cjs");
const path = require("path");
const fs = require("fs");
const { spawnSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const OUT = path.join(ROOT, "..", "mockups", "eye-contact", "indicators-v2");
const PROTO = path.join(OUT, "proto-core-bot.js");
const APP_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36 Edg/129.0.0.0 JoyaDesktop/0.1.12";
const OPTS = { a: "A · The bot itself", b: "B · A dotted orbit", c: "C · The headphones light" };
const PHASES = ["arming", "ready", "listening", "paused"];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  spawnSync(process.execPath, [path.join(OUT, "build-proto.cjs")], { stdio: "inherit" });
  const proto = fs.readFileSync(PROTO, "utf8");
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
    async function open(scheme, lay) {
      const ctx = await browser.newContext({ viewport: { width: lay.size.w, height: lay.size.h }, deviceScaleFactor: 2, colorScheme: scheme, userAgent: APP_UA, extraHTTPHeaders: { "X-Forwarded-Proto": "https" }, screen: { width: 1920, height: 1080 } });
      await ctx.addCookies(String(cookie).split("; ").filter(Boolean).map((kv) => ({ name: kv.split("=")[0], value: kv.slice(kv.indexOf("=") + 1), url: ORIGIN })));
      await ctx.route(/\/joya-core-bot\.js/, (r) => r.fulfill({ status: 200, contentType: "application/javascript; charset=utf-8", body: proto }));
      await ctx.addInitScript((st) => {
        const Lz = {};
        window.__TAURI__ = { core: { invoke: (cmd) => Promise.resolve(cmd === "get_state" ? st : null) }, event: { listen: (n, f) => { (Lz[n] = Lz[n] || []).push(f); return Promise.resolve(() => {}); } } };
        window.__emit = (n, p) => (Lz[n] || []).forEach((f) => f({ payload: p }));
      }, lay.state);
      const page = await ctx.newPage();
      page.on("pageerror", (e) => errs.push(e.message));
      await page.goto(ORIGIN + "/joya-ai?shell=desktop", { waitUntil: "load" });
      await page.waitForTimeout(1800);
      await page.evaluate((sc) => {
        window.__joyaCC.orbit.setConcept("E");
        document.documentElement.setAttribute("data-theme", sc);
        // the scratch copy has no supervisor: online, as on a real machine
        setInterval(() => { const S = window.__joyaCC.S; if (S) S.online = true; const o = document.getElementById("cc-offline"); if (o) o.hidden = true; if (window.__core) window.__core().setOffline(false); label(); }, 100);
        // the state label under the bot: what the page would say in that phase; option a drops it (the face says
        // it), b and c keep it small and quiet (no pill)
        window.__lab = { text: "Ready", mode: "a" };
        function label() {
          const el = document.getElementById("cc-cap-label"), box = el && el.closest(".cc-cap-state");
          if (!el || !box) return;
          if (el.textContent !== window.__lab.text) el.textContent = window.__lab.text;
          const st = box.style, q = window.__lab.mode !== "a";
          st.visibility = window.__lab.mode === "a" ? "hidden" : "";
          st.opacity = q ? "0.55" : ""; st.transform = q ? "scale(0.8)" : ""; st.background = q ? "transparent" : ""; st.borderColor = q ? "transparent" : ""; st.boxShadow = q ? "none" : "";
        }
      }, scheme);
      await page.waitForTimeout(900);
      await page.evaluate(() => {
        const comp = document.documentElement.classList.contains("dk-comp-out");
        window.__core = () => (comp ? window.JoyaDesktop.companion().debug.core() : window.__joyaCC.core);
        const k = window.__core(); k.setHead("headphones"); if (k.look) k.look(null);
        window.__box = () => {
          const k2 = window.__core(), cv = comp ? document.getElementById("dk-comp-cv") : k2.canvas, cb = cv.getBoundingClientRect(), S = k2.S, dpr = S.dpr || 1;
          const hx = cb.left + S.c[0] / dpr, hy = cb.top + S.cssH - S.c[1] / dpr + S.R / dpr * 0.12, r = S.R / dpr * 0.57;
          return { x: hx, y: hy, r };
        };
      });
      return { ctx, page };
    }
    // a phase: the core's own state + the prototype's indication
    const set = (page, mode, phase, arm) => page.evaluate((a) => {
      const k = window.__core();
      k.setOffline(false);
      window.__lab = { mode: a.mode, text: a.phase === "listening" ? "Listening" : a.phase === "paused" ? "Paused" : a.phase === "ready" ? "Ready to talk" : "Ready" };
      k.setState(a.phase === "listening" ? "listening" : a.phase === "paused" ? "speaking" : "idle");
      k.indicate(a.phase ? { mode: a.mode, phase: a.phase, arm: a.arm, noNod: a.noNod } : null);
    }, { mode, phase, arm: arm == null ? 0 : arm, noNod: true });
    const clipOf = async (page, lay) => {
      if (lay === "companion") return { x: 0, y: 0, width: LAYOUTS.companion.size.w, height: LAYOUTS.companion.size.h };
      const b = await page.evaluate(() => window.__box());
      const half = Math.round(b.r * 2.25);
      return { x: Math.max(0, Math.round(b.x - half)), y: Math.max(0, Math.round(b.y - half)), width: half * 2, height: half * 2 };
    };
    const made = [];
    const QUICK = !!process.env.SHOTS_QUICK; // a quick look while tuning: dark, Floating L, stills only
    for (const scheme of QUICK ? ["dark"] : ["dark", "light"]) {
      for (const lay of QUICK ? ["floating"] : ["floating", "companion"]) {
        const { ctx, page } = await open(scheme, LAYOUTS[lay]);
        for (const mode of Object.keys(OPTS)) {
          for (const phase of PHASES) {
            await set(page, mode, phase, 0.5);
            await page.waitForTimeout(phase === "listening" ? 900 : 650);
            if (process.env.SHOTS_DEBUG) console.log(mode, phase, JSON.stringify(await page.evaluate(() => { const k = window.__core(); return { st: k.S.state, off: k.S.offline, light: k.S.light, ind: k.S.ind }; })));
            const f = path.join(OUT, `${mode}-${phase}-${lay}-${scheme}.png`);
            await page.screenshot({ path: f, clip: await clipOf(page, lay) });
            made.push(f);
          }
          if (lay === "floating" && !QUICK) {
            // the whole window once (ready), for context
            await set(page, mode, "ready", 1);
            await page.waitForTimeout(600);
            await page.screenshot({ path: path.join(OUT, `${mode}-window-${scheme}.png`) });
            // the GIF: idle -> arming (0.6 s) -> ready -> listening -> paused
            const dir = path.join(OUT, ".frames");
            fs.rmSync(dir, { recursive: true, force: true }); fs.mkdirSync(dir, { recursive: true });
            await set(page, mode, null);
            await page.waitForTimeout(400);
            const clip = await clipOf(page, lay);
            let n = 0;
            const grab = async () => page.screenshot({ path: path.join(dir, String(n++).padStart(3, "0") + ".png"), clip });
            for (let i = 0; i < 4; i++) await grab();
            for (let i = 1; i <= 8; i++) { await set(page, mode, "arming", i / 8); await grab(); }
            await page.evaluate((m) => { window.__lab = { mode: m, text: "Ready to talk" }; window.__core().indicate({ mode: m, phase: "ready" }); }, mode); // (with its nod, for a)
            for (let i = 0; i < 12; i++) await grab();
            await set(page, mode, "listening");
            for (let i = 0; i < 16; i++) await grab();
            await set(page, mode, "paused");
            for (let i = 0; i < 12; i++) await grab();
            const gif = path.join(OUT, `${mode}-${scheme}.gif`);
            const ff = spawnSync("ffmpeg", ["-y", "-loglevel", "error", "-framerate", "10", "-i", path.join(dir, "%03d.png"), "-vf", "scale=280:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=64:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle", "-loop", "0", gif]);
            if (ff.status !== 0) console.log("no GIF for " + mode + " " + scheme + ": ffmpeg " + (ff.error ? "missing" : String(ff.stderr)));
            fs.rmSync(dir, { recursive: true, force: true });
          }
          await set(page, mode, null);
        }
        await ctx.close();
      }
    }
    // the contact sheet: one row per option, the four phases, dark and light (Floating L), Companion ready
    const rel = (f) => path.basename(f);
    const row = (mode, scheme) => PHASES.map((p) => `<figure><img src="${mode}-${p}-floating-${scheme}.png" alt=""><figcaption>${p === "arming" ? "arming · 50 %" : p}</figcaption></figure>`).join("") +
      `<figure><img src="${mode}-ready-companion-${scheme}.png" alt="" class="comp"><figcaption>companion · ready</figcaption></figure><figure><img src="${mode}-${scheme}.gif" alt=""><figcaption>the sequence</figcaption></figure>`;
    const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Look and speak · indications v2</title>
<style>
:root{--bg:#f6f7f9;--fg:#18202c;--mut:#5b6573;--card:#fff;--line:#e3e6eb}
@media (prefers-color-scheme:dark){:root{--bg:#0e1116;--fg:#e8ecf2;--mut:#98a2b3;--card:#161b22;--line:#252c36}}
body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.45 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:1500px;margin:0 auto;padding:24px 16px 48px}
h1{font-size:22px;margin:0 0 4px}h2{font-size:17px;margin:28px 0 4px}p{color:var(--mut);margin:0 0 10px;max-width:900px}
.row{display:grid;grid-template-columns:repeat(6,minmax(0,1fr));gap:10px;margin:8px 0}
figure{margin:0;background:var(--card);border:1px solid var(--line);border-radius:10px;padding:6px}
figure img{width:100%;display:block;border-radius:6px}figure img.comp{object-fit:contain;aspect-ratio:1}
figcaption{font-size:12px;color:var(--mut);padding:4px 2px 0}
h3{font-size:13px;color:var(--mut);margin:12px 0 0;font-weight:600}
@media (max-width:900px){.row{grid-template-columns:repeat(2,minmax(0,1fr))}}
</style></head><body><main>
<h1>Look and speak · three ways to show it</h1>
<p>Rendered by core E's own renderer (a prototype built from it), on the desktop page, headphones head. Pick one; nothing is shipped yet. The thick flat ring and the caption are gone in all three.</p>
<h2>${OPTS.a}</h2><p>No added shape. The head's own grid nodes along its edge light up clockwise as you hold your look; all lit when it is ready, the eyes go wide and it nods once; while it listens they pulse with your voice; while a reply is paused, the eyes look at you and the edge blinks slowly.</p>
<h3>Dark</h3><div class="row">${row("a", "dark")}</div><h3>Light</h3><div class="row">${row("a", "light")}</div>
<h2>${OPTS.b}</h2><p>A thin ring of dots round the head, in the wireframe's dot style: it fills clockwise while arming, breathes when ready, ripples with your voice while listening, and turns slowly, sparse, while a reply is paused.</p>
<h3>Dark</h3><div class="row">${row("b", "dark")}</div><h3>Light</h3><div class="row">${row("b", "light")}</div>
<h2>${OPTS.c}</h2><p>The most minimal: the headphones' pads light, rising while arming, steady when ready, pulsing with your voice while listening, a slow blink while a reply is paused. The face only brightens a little.</p>
<h3>Dark</h3><div class="row">${row("c", "dark")}</div><h3>Light</h3><div class="row">${row("c", "light")}</div>
</main></body></html>`;
    fs.writeFileSync(path.join(OUT, "index.html"), html);
    console.log("wrote " + made.length + " stills, 6 GIFs and index.html to " + OUT + (errs.length ? "\npage errors: " + errs.join(" | ") : ""));
  } finally {
    await browser.close();
    s.stop();
  }
})().catch((e) => { console.error(e); process.exit(1); });
