#!/usr/bin/env node
"use strict";
/**
 * Screenshots of the desktop render mode (/joya-ai?shell=desktop) for review:
 * Desktop layer at 1920 x 1032 and the Floating box (M and S), light and dark
 * ink, with a few exchanges in the conversation; with the chat panel open too
 * where the page has one. Counts console errors and CSP violations.
 *
 *     NODE_PATH=/opt/joya-dashboard/node_modules PLAYWRIGHT=/path/to/node_modules/playwright \
 *       node dashboard/tools/shots-desktop-shell.cjs OUT_DIR [prefix]
 */
const scratch = require("./scratch-server.cjs");
const path = require("path");
const fs = require("fs");
const OUT = process.argv[2];
const PREFIX = process.argv[3] || "";
const APP_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36 Edg/129.0.0.0 JoyaDesktop/0.1.2";
(async () => {
  if (!OUT) throw new Error("usage: shots-desktop-shell.cjs OUT_DIR [prefix]");
  fs.mkdirSync(OUT, { recursive: true });
  const { chromium } = require(process.env.PLAYWRIGHT || "playwright");
  const s = await scratch.startScratch({});
  const errs = [];
  try {
    require(path.join(__dirname, "..", "lib", "db.js")).setSetting("voice_desk", "on", "test"); // the scratch database: the mic button shows
    await s.makeUser("shots", "administrator");
    const { cookie } = await s.signIn("shots");
    const browser = await chromium.launch();
    const views = [
      ["desktop-1920-dark", 1920, 1032, "mode=desktop"],
      ["desktop-1920-light", 1920, 1032, "mode=desktop&ink=dark"],
      ["floating-M-dark", 480, 860, "mode=floating"],
      ["floating-M-light", 480, 860, "mode=floating&ink=dark"],
      ["floating-S-dark", 384, 744, "mode=floating&size=S"],
    ];
    for (const [name, W, H, q] of views) {
      for (const open of [false, true, "unread", "listening"]) {
        const ctx = await browser.newContext({ viewport: { width: W, height: H }, userAgent: APP_UA, extraHTTPHeaders: { "X-Forwarded-Proto": "https" } });
        await ctx.addCookies(String(cookie).split("; ").filter(Boolean).map((kv) => ({ name: kv.split("=")[0], value: kv.slice(kv.indexOf("=") + 1), url: "http://127.0.0.1:" + s.port })));
        const page = await ctx.newPage();
        page.on("pageerror", (e) => errs.push(name + ": " + e.message));
        page.on("console", (m) => { const t = m.text(); if ((m.type() === "error" && !/Failed to load resource|net::ERR|503|502|EventSource/.test(t)) || /Content Security Policy|Refused to/.test(t)) errs.push(name + ": " + t); });
        await page.goto("http://127.0.0.1:" + s.port + "/joya-ai?shell=desktop&" + q, { waitUntil: "load" });
        await page.waitForTimeout(700);
        const has = await page.evaluate(() => {
          const S = window.__joyaCC.S;
          document.getElementById("cc-offline").hidden = true; // the scratch copy has no supervisor
          [[1, "What's waiting for me today?", "Two things: the invoice audit and the freight quotes."], [2, "Hire someone for the customs papers", "I hired Customs docs. They are reading the shipment file now and will come back with the missing certificates."], [3, "Thanks", "You're welcome."]].forEach(function (x) {
            S.turns.set(x[0], { id: x[0], source: "dashboard", text: x[1], blocks: [x[2]], partial: "", status: "done", created_at: new Date().toISOString() });
            S.turnOrder.push(x[0]);
          });
          document.dispatchEvent(new CustomEvent("joya-turns"));
          return !!document.getElementById("dk-chatbtn");
        });
        if (open && !has) { await ctx.close(); continue; }
        if ((open === "unread" || open === "listening") && !/dark/.test(name)) { await ctx.close(); continue; }
        if (open === true) { await page.click("#dk-chatbtn"); }
        if (open === "unread") {
          await page.waitForTimeout(4200);
          await page.evaluate(() => { const S = window.__joyaCC.S; S.turns.set(4, { id: 4, source: "dashboard", text: "And the label check?", blocks: ["It is running."], partial: "", status: "done", created_at: new Date().toISOString() }); S.turnOrder.push(4); document.dispatchEvent(new CustomEvent("joya-turns")); });
        }
        if (open === "listening") await page.evaluate(() => { const S = window.__joyaCC.S; S.online = true; const c = document.getElementById("cc-cap-state"); c.setAttribute("data-s", "listening"); document.getElementById("cc-cap-label").textContent = "Listening"; window.__joyaLive.level = () => 0.18; });
        await page.waitForTimeout(500);
        await page.screenshot({ path: path.join(OUT, PREFIX + name + (open === true ? "-chat-open" : open ? "-" + open : "") + ".png"), omitBackground: false });
        await ctx.close();
      }
    }
    await browser.close();
  } finally {
    s.stop();
  }
  console.log("console/CSP errors: " + errs.length + (errs.length ? "\n" + errs.join("\n") : ""));
  process.exit(errs.length ? 1 : 0);
})().catch((e) => { console.log(e.stack); process.exit(1); });
