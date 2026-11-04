#!/usr/bin/env node
"use strict";
/**
 * Eye contact's camera worker: milliseconds a frame with the real face model (2026-10-22, for look and speak's
 * faster frame rate while you face the bot).
 *
 *     PLAYWRIGHT=/path/to/node_modules/playwright node dashboard/tools/bench-presence-worker.cjs FACE.png [--n 120]
 *
 * Serves public/ on a loopback port, opens headless Chromium, starts public/joya-presence-worker.js (the vendored
 * MediaPipe Face Landmarker, CPU delegate) and hands it FACE.png scaled to 320 x 240 (the module's frame) --
 * moved a little each frame, as a person is -- back to back at 5, 8, 12 fps and flat out. Prints the worker's own
 * ms per frame (median, 90th percentile), whether it found the face, and the page's CPU time per second of
 * camera. FACE.png: any photo of one face (not committed: bring your own).
 */
const path = require("path");
const fs = require("fs");
const http = require("http");
const { chromium } = require(process.env.PLAYWRIGHT || "playwright");

const PUB = path.join(__dirname, "..", "public");
const img = process.argv[2];
const N = +((process.argv.indexOf("--n") > 0 && process.argv[process.argv.indexOf("--n") + 1]) || 120);
if (!img || !fs.existsSync(img)) { console.error("usage: bench-presence-worker.cjs FACE.png [--n 120]"); process.exit(2); }
const TYPES = { ".js": "text/javascript", ".wasm": "application/wasm", ".task": "application/octet-stream", ".html": "text/html", ".png": "image/png" };

const server = http.createServer((req, res) => {
  const u = decodeURIComponent(req.url.split("?")[0]);
  if (u === "/") { res.writeHead(200, { "content-type": "text/html" }); return res.end("<!doctype html><title>bench</title>"); }
  const f = u === "/face.png" ? img : path.join(PUB, u.replace(/^\/+/, ""));
  if (!f.startsWith(PUB) && f !== img) { res.writeHead(403); return res.end(); }
  fs.readFile(f, (e, b) => { if (e) { res.writeHead(404); return res.end(); } res.writeHead(200, { "content-type": TYPES[path.extname(f)] || "application/octet-stream" }); res.end(b); });
});
server.listen(0, "127.0.0.1", async () => {
  const port = server.address().port;
  const browser = await chromium.launch();
  try {
    const page = await (await browser.newContext()).newPage();
    await page.goto("http://127.0.0.1:" + port + "/");
    const out = await page.evaluate(async ({ N }) => {
      const w = new Worker("/joya-presence-worker.js");
      const msg = (type) => new Promise((ok) => { const h = (e) => { if (e.data && e.data.type === type || (e.data && e.data.type === "error")) { w.removeEventListener("message", h); ok(e.data); } }; w.addEventListener("message", h); });
      w.postMessage({ type: "init" });
      const r = await msg("ready");
      if (r.type === "error") return { error: r.message };
      const im = new Image(); im.src = "/face.png"; await im.decode();
      const cv = new OffscreenCanvas(320, 240), cx = cv.getContext("2d");
      async function frame(i) {
        // the face filling ~40 % of the frame's width, drifting a little
        const s = 240 / im.height * 1.1, dx = Math.sin(i / 7) * 6, dy = Math.cos(i / 9) * 4;
        cx.fillStyle = "#555"; cx.fillRect(0, 0, 320, 240);
        cx.drawImage(im, 160 - (im.width * s) / 2 + dx, 120 - (im.height * s) / 2 + dy, im.width * s, im.height * s);
        const bmp = await createImageBitmap(cv);
        const p = msg("faces");
        w.postMessage({ type: "frame", bmp, t: performance.now() }, [bmp]);
        return p;
      }
      for (let i = 0; i < 10; i++) await frame(i); // warm up
      const res = {};
      for (const fps of [5, 8, 12, 0]) {
        const ms = [], t0 = performance.now(); let found = 0;
        for (let i = 0; i < N; i++) {
          const ts = performance.now();
          const m = await frame(i);
          ms.push(m.ms); if (m.faces && m.faces.length) found++;
          if (fps) { const wait = 1000 / fps - (performance.now() - ts); if (wait > 0) await new Promise((ok) => setTimeout(ok, wait)); }
        }
        ms.sort((a, b) => a - b);
        const wall = (performance.now() - t0) / 1000;
        res[fps || "max"] = { median: ms[ms.length >> 1], p90: ms[Math.floor(ms.length * 0.9)], found: found + "/" + N, fpsReached: Math.round((N / wall) * 10) / 10, busyShare: Math.round((ms.reduce((a, b) => a + b, 0) / 1000 / wall) * 1000) / 10 };
      }
      w.postMessage({ type: "close" });
      return res;
    }, { N });
    console.log(JSON.stringify(out, null, 1));
    console.log("busyShare: % of one CPU core the face model takes at that frame rate (its ms x frames a second)");
  } finally {
    await browser.close();
    server.close();
  }
});
