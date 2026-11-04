#!/usr/bin/env node
"use strict";
/**
 * The bot, for the Telegram agents (2026-10-20): a profile picture per role and three animated stickers
 * (ready, thinking, done) per role, drawn by the Command Center's own renderer (public/joya-core-bot.js,
 * WebGL2 in headless Chromium, frame by frame through core.tick) so the agents wear the same bot as the
 * core and the sessions. Nothing is sent anywhere: the files are written, and docs/agent-bots/README.md
 * says how to apply them (that is the administrator's decision).
 *
 *     PLAYWRIGHT=/path/to/node_modules/playwright node dashboard/tools/make-agent-bots.cjs [OUT_DIR] [--gif DIR] [--quick]
 *
 * For each role of the team (cc-logic.js BOT_ROLE_RULES: erp headset, planning mortar, hired cap, builder
 * antennas, other headphones) plus "core" (cap, the default core head):
 *
 *   avatar-<role>.png          640 x 640, opaque (Telegram crops it to a circle; the head sits in the safe circle)
 *   sticker-<role>-ready.webm  512 x 512 VP9 with alpha, 3 s, 30 fps (a Telegram video sticker: <= 256 KB)
 *   sticker-<role>-thinking.webm
 *   sticker-<role>-done.webm   (a grin and a little hop)
 *   sticker-<role>-ready.png   512 x 512 still (a static sticker)
 *
 * --gif DIR also writes each sticker as a GIF over the dark page colour (for review, and for send_animation).
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const PUB = path.join(__dirname, "..", "public");
const L = require(path.join(PUB, "cc-logic.js"));
const args = process.argv.slice(2);
const OUT = args[0] && !args[0].startsWith("--") ? args[0] : path.join(__dirname, "..", "..", "docs", "agent-bots");
const gi = args.indexOf("--gif"), GIFDIR = gi >= 0 ? args[gi + 1] : null;
const QUICK = args.includes("--quick");

const ROLES = L.BOT_ROLE_RULES.map((r) => ({ role: r.role, head: r.head, label: r.label })).concat([{ role: L.BOT_ROLE_DEFAULT.role, head: L.BOT_ROLE_DEFAULT.head, label: L.BOT_ROLE_DEFAULT.label }, { role: "core", head: "cap", label: "JOYA AI (the core's default head)" }]);
const STICKERS = { ready: { state: "idle" }, thinking: { state: "thinking" }, done: { state: "idle", react: "grin" } };
const FPS = 30, SECS = 3;

(async () => {
  const { chromium } = require(process.env.PLAYWRIGHT || process.env.PW || "playwright");
  fs.mkdirSync(OUT, { recursive: true });
  if (GIFDIR) fs.mkdirSync(GIFDIR, { recursive: true });
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agent-bots-"));
  const browser = await chromium.launch({ args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
  const report = [];
  try {
    const page = await browser.newPage({ viewport: { width: 700, height: 700 }, deviceScaleFactor: 1 });
    const errs = [];
    page.on("pageerror", (e) => errs.push(e.message));
    await page.setContent("<!doctype html><html><body style='margin:0;background:transparent'><canvas id='c' style='position:fixed;left:0;top:0'></canvas><canvas id='o' style='display:none'></canvas></body></html>");
    await page.addScriptTag({ content: fs.readFileSync(path.join(PUB, "cc-logic.js"), "utf8") });
    await page.addScriptTag({ content: fs.readFileSync(path.join(PUB, "joya-core-bot.js"), "utf8") });
    await page.evaluate(() => {
      /** A fresh core on a fresh canvas of size s; the head's centre at (s/2, cy), its radius r (CSS px). */
      window.__make = (head, s, r, cy, desk) => {
        const old = document.getElementById("c"), cv = old.cloneNode(false);
        old.parentNode.replaceChild(cv, old);
        cv.style.width = s + "px"; cv.style.height = s + "px";
        if (window.__core) window.__core.destroy();
        const R = r / 0.57;
        const k = window.JoyaCoreBot(cv, { head, noGuard: true, preserve: true, desk: !!desk, hour: () => 12 });
        k.setLight(false, true);
        k.resize(s / 2, cy - R * 0.12, R, s, s);
        window.__core = k; window.__cv = k.canvas;
        return k.isGL;
      };
      /** The canvas as a PNG data URL, over a background (bg: null = transparent; "avatar" = the navy field). */
      window.__png = (bg) => {
        const cv = window.__cv, o = document.getElementById("o");
        o.width = cv.width; o.height = cv.height;
        const g = o.getContext("2d");
        g.clearRect(0, 0, o.width, o.height);
        if (bg === "avatar") {
          const gr = g.createLinearGradient(0, 0, o.width, o.height);
          gr.addColorStop(0, "#0B1238"); gr.addColorStop(0.55, "#101A33"); gr.addColorStop(1, "#0B2A2A");
          g.fillStyle = gr; g.fillRect(0, 0, o.width, o.height);
        } else if (bg) { g.fillStyle = bg; g.fillRect(0, 0, o.width, o.height); }
        g.drawImage(cv, 0, 0);
        return o.toDataURL("image/png");
      };
    });
    const save = (url, file) => fs.writeFileSync(file, Buffer.from(url.split(",")[1], "base64"));
    const roles = QUICK ? ROLES.slice(0, 2) : ROLES;
    for (const R of roles) {
      // the avatar: a still, ready, on the field
      const gl = await page.evaluate((h) => window.__make(h, 640, 150, 350, false), R.head);
      await page.evaluate(() => { const k = window.__core; for (let i = 0; i < 40; i++) k.tick(1 / 30); k.still(); });
      save(await page.evaluate(() => window.__png("avatar")), path.join(OUT, `avatar-${R.role}.png`));
      const row = { role: R.role, head: R.head, gl, files: [`avatar-${R.role}.png`] };
      for (const [name, sk] of Object.entries(STICKERS)) {
        await page.evaluate((h) => window.__make(h, 512, 112, 292, true), R.head);
        const dir = path.join(tmp, R.role + "-" + name);
        fs.mkdirSync(dir, { recursive: true });
        await page.evaluate((x) => { const k = window.__core; k.setState(x.state); for (let i = 0; i < 45; i++) k.tick(1 / 30); const a = k._anim(); a.blinkAt = a.t + 1.4; a.glanceAt = a.t + 99; }, sk);
        for (let i = 0; i < FPS * SECS; i++) {
          const url = await page.evaluate((x) => { const k = window.__core; if (x.react && (x.i === 6 || x.i === 54)) k.react(x.react); k.tick(1 / 30); return window.__png(null); }, { react: sk.react, i });
          save(url, path.join(dir, `f${String(i).padStart(3, "0")}.png`));
        }
        if (name === "ready") fs.copyFileSync(path.join(dir, "f010.png"), path.join(OUT, `sticker-${R.role}-ready.png`));
        const webm = path.join(OUT, `sticker-${R.role}-${name}.webm`);
        // VP9 with alpha; raise the CRF until it fits Telegram's 256 KB
        for (const crf of [34, 40, 46, 52]) {
          execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-framerate", String(FPS), "-i", path.join(dir, "f%03d.png"), "-c:v", "libvpx-vp9", "-pix_fmt", "yuva420p", "-b:v", "0", "-crf", String(crf), "-an", webm]);
          if (fs.statSync(webm).size <= 250 * 1024) break;
        }
        row.files.push(path.basename(webm) + " (" + (fs.statSync(webm).size / 1024).toFixed(0) + " KB)");
        if (GIFDIR) {
          execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-framerate", String(FPS), "-i", path.join(dir, "f%03d.png"), "-filter_complex", "color=c=0x0D1117:s=512x512[bg];[bg][0]overlay=shortest=1,fps=15,scale=256:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=96[p];[b][p]paletteuse=dither=bayer", path.join(GIFDIR, `sticker-${R.role}-${name}.gif`)]);
        }
        fs.rmSync(dir, { recursive: true, force: true });
      }
      report.push(row);
      console.log(R.role, R.head, row.files.join(", "));
    }
    if (errs.length) throw new Error("page errors: " + errs.join("; "));
  } finally {
    await browser.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  fs.writeFileSync(path.join(OUT, "manifest.json"), JSON.stringify({ made: "dashboard/tools/make-agent-bots.cjs", roles: report.map((r) => ({ role: r.role, head: r.head, files: r.files.map((f) => f.replace(/ \(.*\)$/, "")) })) }, null, 2) + "\n");
})().catch((e) => { console.error(e); process.exit(1); });
