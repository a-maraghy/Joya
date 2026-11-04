#!/usr/bin/env node
"use strict";
/**
 * The Joya icon ("Mesh") in a real browser, on every kind of page.
 *
 *     NODE_PATH=/opt/joya-dashboard/node_modules \
 *     PLAYWRIGHT=/path/to/node_modules/playwright node dashboard/tools/test-app-icon.cjs [--shots DIR]
 *
 * A scratch copy of the panel (tools/scratch-server.cjs: temp data dir, helper
 * cut off) and Chromium. For the sign-in page, the Command Center, OS pages,
 * the account page and an error page: the page links the M monogram for the tab (16,
 * 32, any, .ico), the app icon for apple-touch and the manifest and no leaf favicon; every one
 * of those URLs loads 200 with its content type; the manifest's icons load too;
 * no CSP violation and no console error about any of it. --shots writes a
 * screenshot of each icon as the browser decoded it.
 */
const scratch = require("./scratch-server.cjs"); // first: sets JOYA_DATA_DIR
const fs = require("fs");
const path = require("path");

const PW = process.env.PLAYWRIGHT || process.env.PW || "playwright";
let chromium;
try {
  ({ chromium } = require(PW));
} catch (e) {
  console.log("FAIL playwright not found (set PLAYWRIGHT=/path/to/node_modules/playwright): " + e.message);
  process.exit(1);
}

let failures = 0;
let passes = 0;
function check(name, ok, detail) {
  if (ok) {
    passes++;
    return console.log("ok   " + name);
  }
  failures++;
  console.log("FAIL " + name + (detail !== undefined ? "  (" + String(detail).slice(0, 400) + ")" : ""));
}
const shotsAt = process.argv.indexOf("--shots");
const SHOTS = shotsAt > 0 ? process.argv[shotsAt + 1] : null;

const WANT = [
  { rel: "icon", sizes: "16x16", file: /\/static\/brand\/m\/favicon-16\.svg\?v=/, type: "image/svg+xml" },
  { rel: "icon", sizes: "32x32", file: /\/static\/brand\/m\/favicon-32\.svg\?v=/, type: "image/svg+xml" },
  { rel: "icon", sizes: "any", file: /\/static\/brand\/m\/favicon\.svg\?v=/, type: "image/svg+xml" },
  { rel: "alternate icon", file: /\/static\/brand\/m\/favicon\.ico\?v=/, type: "image/x-icon" },
  { rel: "apple-touch-icon", sizes: "180x180", file: /\/static\/brand\/app-icon-180\.png\?v=/, type: "image/png" },
  { rel: "manifest", file: /\/manifest\.webmanifest\?v=/, type: "application/manifest+json" },
];

(async () => {
  const s = await scratch.startScratch({});
  const BASE = `http://127.0.0.1:${s.port}`;
  const browser = await chromium.launch();
  try {
    await s.makeUser("admin1", "administrator");
    const who = await s.signIn("admin1");

    async function visit(label, url, cookie, expectStatus) {
      const context = await browser.newContext({ extraHTTPHeaders: { "X-Forwarded-Proto": "https" } });
      if (cookie) {
        await context.addCookies(cookie.split("; ").map((kv) => {
          const i = kv.indexOf("=");
          return { name: kv.slice(0, i), value: kv.slice(i + 1), url: BASE };
        }));
      }
      const page = await context.newPage();
      const problems = [];
      page.on("pageerror", (e) => problems.push("pageerror " + e.message));
      page.on("console", (m) => {
        if (m.type() !== "error") return;
        const t = m.text(), where = (m.location() && m.location().url) || "";
        if (expectStatus && new RegExp(`status of ${expectStatus} `).test(t) && where === BASE + url) return; // the page's own deliberate status
        // The scratch copy has no supervisor: the dock and the Command Center say so (503).
        if (/status of 50[23]/.test(t) && /\/joya-ai\/api\/|\/api\//.test(where)) return;
        if (/WebSocket/.test(t)) return; // the live socket has no JOYA AI behind it here
        problems.push("console " + t + " @ " + where);
      });
      await page.addInitScript(() => {
        window.__csp = [];
        document.addEventListener("securitypolicyviolation", (e) => window.__csp.push(e.violatedDirective + " " + e.blockedURI));
      });
      const resp = await page.goto(BASE + url, { waitUntil: "load" });
      await page.waitForTimeout(400);
      const links = await page.$$eval("link[rel~=icon], link[rel=apple-touch-icon], link[rel=manifest]", (ls) =>
        ls.map((l) => ({ rel: l.getAttribute("rel"), sizes: l.getAttribute("sizes"), href: l.getAttribute("href") })));
      const bad = WANT.filter((w) => !links.some((l) => l.rel === w.rel && w.file.test(l.href) && (!w.sizes || l.sizes === w.sizes)));
      check(`${label}: links the Joya icon set (${links.length} links)`, bad.length === 0 && links.length === WANT.length, JSON.stringify(bad.map((b) => b.rel + " " + (b.sizes || ""))) + " " + JSON.stringify(links));
      check(`${label}: no leaf favicon`, !links.some((l) => /favicon-(os|ai)|favicon-ai/.test(l.href)));
      // Load each linked file from inside the page (same origin, same CSP).
      const loads = await page.evaluate(async (hrefs) => {
        const out = [];
        for (const h of hrefs) {
          const r = await fetch(h, { credentials: "omit" });
          out.push({ href: h, status: r.status, type: r.headers.get("content-type") || "", cc: r.headers.get("cache-control") || "" });
        }
        return out;
      }, links.map((l) => l.href));
      for (const w of WANT) {
        const l = loads.find((x) => w.file.test(x.href));
        check(`${label}: ${w.rel}${w.sizes ? " " + w.sizes : ""} loads 200 ${w.type}, cached long`, !!l && l.status === 200 && l.type.startsWith(w.type) && /max-age=2592000/.test(l.cc), JSON.stringify(l));
      }
      // The browser can actually draw every icon image.
      const drawn = await page.evaluate(async (hrefs) => {
        const res = [];
        for (const h of hrefs) {
          res.push(await new Promise((ok) => { const i = new Image(); i.onload = () => ok([h, i.naturalWidth]); i.onerror = () => ok([h, 0]); i.src = h; }));
        }
        return res;
      }, links.filter((l) => l.rel !== "manifest").map((l) => l.href));
      check(`${label}: every icon decodes in the browser`, drawn.every(([, w]) => w > 0), JSON.stringify(drawn));
      const csp = await page.evaluate(() => window.__csp);
      check(`${label}: no CSP violation, no console error`, csp.length === 0 && problems.length === 0, JSON.stringify(csp.concat(problems)));
      await context.close();
      return { status: resp && resp.status(), url: page.url() };
    }

    const lg = await visit("sign-in page", "/login");
    check("the sign-in page is the sign-in page", /\/login$/.test(lg.url) && lg.status === 200, lg.url + " " + lg.status);
    const cc = await visit("Command Center", "/joya-ai", who.cookie);
    check("the Command Center rendered", cc.status === 200 && /\/joya-ai/.test(cc.url), cc.url + " " + cc.status);
    // OS pages that render without the privileged helper (the scratch copy has none).
    for (const p of ["/os", "/users", "/roles", "/audit", "/guide"]) {
      const r = await visit("OS page " + p, p, who.cookie);
      check(`OS page ${p} rendered`, r.status === 200, r.url + " " + r.status);
    }
    const acc = await visit("account page", "/account", who.cookie);
    check("the account page rendered", acc.status === 200, acc.url + " " + acc.status);
    const nf = await visit("error page (404)", "/no-such-page-" + Date.now(), who.cookie, 404);
    check("the error page is a 404", nf.status === 404, nf.status);

    // The manifest's own icons, and the root /favicon.ico for bookmark managers.
    const m = JSON.parse((await s.req("GET", "/manifest.webmanifest")).body);
    for (const i of m.icons) {
      const r = await s.req("GET", i.src);
      check(`manifest icon ${i.src.split("?")[0]} (${i.purpose}) loads ${i.type}`, r.status === 200 && String(r.headers["content-type"]).startsWith(i.type), r.status + " " + r.headers["content-type"]);
    }
    const root = await s.req("GET", "/favicon.ico");
    check("/favicon.ico loads image/x-icon, cached a day", root.status === 200 && /image\/x-icon/.test(root.headers["content-type"]) && /max-age=86400/.test(root.headers["cache-control"] || ""), root.headers["cache-control"]);

    if (SHOTS) {
      fs.mkdirSync(SHOTS, { recursive: true });
      const ctx = await browser.newContext();
      const page = await ctx.newPage();
      const imgs = ["/static/brand/m/favicon-16.svg", "/static/brand/m/favicon-32.svg", "/static/brand/m/favicon.svg", "/static/brand/m/favicon.ico", "/static/brand/app-icon-180.png", "/static/brand/app-icon-192.png", "/static/brand/app-icon-maskable-512.png"];
      await page.goto(BASE + "/login"); // same origin: the panel's CORP header is same-origin
      await page.setContent(`<body style="margin:0;background:#dee1e6;display:flex;gap:12px;padding:12px;align-items:flex-end">${imgs.map((i) => `<img src="${BASE}${i}" style="max-width:128px">`).join("")}</body>`);
      await page.waitForTimeout(500);
      await page.screenshot({ path: path.join(SHOTS, "served-icons.png") });
      await ctx.close();
    }
  } catch (e) {
    check("run", false, e.stack || e.message);
  } finally {
    await browser.close();
    s.stop();
  }
  console.log(`\n${passes} passed, ${failures} failed`);
  process.exit(failures ? 1 : 0);
})();
