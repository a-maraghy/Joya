#!/usr/bin/env node
"use strict";
/**
 * Joya > Computers with laptop control 2 (0.1.11): two linked computers -- one with Claude in Chrome
 * connected and a take-over running (its live action log growing), one where Chrome is not set up (the
 * steps) -- and a take-over's full log. A scratch dashboard (no helper, temp data) with a fake supervisor
 * socket and fake apps over the real WebSocket link; the pages render as served, then new actions arrive
 * and the live log is captured again. Reports console / CSP errors.
 *
 *     NODE_PATH=/opt/joya-dashboard/node_modules PLAYWRIGHT=/path/to/node_modules/playwright \
 *       node dashboard/tools/shots-laptop-control.cjs OUT_DIR
 */
const scratch = require("./scratch-server.cjs");
const fs = require("fs");
const net = require("net");
const os = require("os");
const path = require("path");
const WebSocket = require("ws");
const OUT = process.argv[2];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  if (!OUT) throw new Error("usage: shots-laptop-control.cjs OUT_DIR");
  fs.mkdirSync(OUT, { recursive: true });
  const { chromium } = require(process.env.PLAYWRIGHT || "playwright");
  // A fake supervisor: answers every op, keeps the event viewers.
  const sockDir = fs.mkdtempSync(path.join(os.tmpdir(), "fake-sup-"));
  const SOCK = path.join(sockDir, "sup.sock");
  const viewers = [];
  const fake = net.createServer((s) => {
    let buf = "";
    s.setEncoding("utf8");
    s.on("data", (c) => {
      buf += c;
      let nl;
      while ((nl = buf.indexOf("\n")) !== -1) {
        const req = JSON.parse(buf.slice(0, nl));
        buf = buf.slice(nl + 1);
        if (req.op === "events") {
          viewers.push(s);
          s.write(JSON.stringify({ id: req.id, ok: true, data: { subscribed: true } }) + "\n");
          continue;
        }
        s.write(JSON.stringify({ id: req.id, ok: true, data: req.op === "machine-ask" ? { behavior: "allow", auto: true } : { ok: true } }) + "\n");
      }
    });
    s.on("error", () => {});
  });
  await new Promise((r) => fake.listen(SOCK, r));
  const srv = await scratch.startScratch({ env: { JOYA_AI_SOCKET: SOCK } });
  const errs = [];
  const apps = [];
  try {
    await srv.makeUser("shots", "administrator");
    const { cookie } = await srv.signIn("shots");
    const page0 = await srv.req("GET", "/machines", { cookie });
    let csrf = (/name="_csrf" value="([^"]+)"/.exec(page0.body) || [])[1];
    async function pair(name, hello) {
      await srv.req("POST", "/machines/pair", { cookie, body: new URLSearchParams({ _csrf: csrf }).toString() });
      const p = await srv.req("GET", "/machines", { cookie });
      const code = (/class="mc-code-value mono">([0-9A-Z]{4}-[0-9A-Z]{4})</.exec(p.body) || [])[1];
      const cl = JSON.parse((await srv.req("POST", "/machines/api/claim", { body: { code, name, platform: "windows", app_version: "0.1.11" } })).body);
      const ws = new WebSocket(`ws://127.0.0.1:${srv.port}/machines/api/link`, { headers: { Authorization: "Bearer " + cl.token } });
      const msgs = [];
      ws.on("message", (d) => msgs.push(JSON.parse(String(d))));
      await new Promise((r, j) => {
        ws.on("open", r);
        ws.on("error", j);
      });
      ws.send(JSON.stringify({ t: "hello", app_version: "0.1.11", platform: "windows", ...hello }));
      apps.push(ws);
      return { id: cl.machine_id, ws, msgs };
    }
    const claude = { found: true, path: "C:\\Users\\Ahmed\\.local\\bin\\claude.exe", version: "2.1.283", git_bash: true };
    const a = await pair("GSHN1124", { host: "GSHN1124", user: "Ahmed", home: "C:\\Users\\Ahmed", claude, chrome: { extension: true, browser: "Chrome", profile: "Default" }, office: ["Word", "Excel", "PowerPoint"] });
    const b = await pair("Office PC", { host: "OFFICE-PC", user: "Ahmed", home: "C:\\Users\\Ahmed", claude, chrome: { extension: false }, office: ["Word", "Excel"] });
    await sleep(400);
    csrf = (/name="_csrf" value="([^"]+)"/.exec((await srv.req("GET", "/machines", { cookie })).body) || [])[1];
    await srv.req("POST", `/machines/${a.id}/folders`, { cookie, body: new URLSearchParams({ _csrf: csrf, path: "D:\\Giza\\Planning" }).toString() });
    // A take-over of the first: the supervisor's start event.
    for (const v of viewers) v.write(JSON.stringify({ event: { seq: 9, type: "machine", what: "start", machine_id: a.id, slug: "pc-gshn1124", name: "GSHN1124 control", purpose: "Update the October totals in Budget.xlsx, make a PDF of the Q3 deck, and look up tomorrow's train times to Alexandria.", minutes: 30, first_prompt: "[From JOYA AI] …", by: "joya-ai" } }) + "\n");
    await sleep(500);
    const start = a.msgs.find((m) => m.t === "start");
    if (!start) throw new Error("no start reached the fake app");
    const lid = start.lease.id;
    a.ws.send(JSON.stringify({ t: "lease", lease_id: lid, state: "active", expires_at: start.lease.expires_at }));
    a.ws.send(JSON.stringify({ t: "session", slug: "pc-gshn1124", state: "running" }));
    const t0 = Date.now() - 6 * 60 * 1000;
    const act = (i, o) => a.ws.send(JSON.stringify({ t: "action", lease_id: lid, slug: "pc-gshn1124", at: new Date(t0 + i * 37000).toISOString(), summary: o.target, ...o }));
    const first = [
      { tool: "mcp__joya-hands__office_read", target: "C:\\Users\\Ahmed\\Documents\\Finance\\Budget.xlsx", decision: "auto", result: "ok", detail: "read", kind: "hands" },
      { tool: "mcp__joya-hands__office_edit", target: "C:\\Users\\Ahmed\\Documents\\Finance\\Budget.xlsx -> C:\\Users\\Ahmed\\Documents\\Finance\\Budget (edited).xlsx", decision: "auto", result: "ok", detail: "saved (Excel): 12 cell(s) set on \"October\" from B2; sheet \"Notes\" added", kind: "hands" },
      { tool: "mcp__joya-hands__pdf_export", target: "C:\\Users\\Ahmed\\Documents\\Q3 deck.pptx -> C:\\Users\\Ahmed\\Documents\\Q3 deck.pdf", decision: "auto", result: "ok", detail: "saved (PowerPoint)", kind: "hands" },
      { tool: "PowerShell", target: "PowerShell: Get-ChildItem \"$env:USERPROFILE\\Documents\\Finance\"", decision: "auto", result: "ok", kind: "cli" },
      { tool: "mcp__claude-in-chrome__tabs_create_mcp", target: "Chrome: open a new tab", decision: "auto", result: "ok", kind: "browser" },
      { tool: "mcp__claude-in-chrome__navigate", target: "Chrome: open https://www.enr.gov.eg", decision: "auto", result: "ok", kind: "browser" },
    ];
    first.forEach((o, i) => act(i, o));
    a.ws.send(JSON.stringify({ t: "browser", slug: "pc-gshn1124", connected: true, detail: "", at: new Date().toISOString() }));
    await sleep(500);
    const browser = await chromium.launch();
    async function shot(name, url, W, H, after) {
      const ctx = await browser.newContext({ viewport: { width: W, height: H }, colorScheme: /dark/.test(name) ? "dark" : "light" });
      await ctx.addCookies(String(cookie).split("; ").filter(Boolean).map((kv) => ({ name: kv.split("=")[0], value: kv.slice(kv.indexOf("=") + 1), url: "http://127.0.0.1:" + srv.port })));
      const page = await ctx.newPage();
      page.on("pageerror", (e) => errs.push(name + ": " + e.message));
      page.on("console", (m) => { const t = m.text(); if ((m.type() === "error" && !/Failed to load resource|net::ERR|503|502|EventSource/.test(t)) || /Content Security Policy|Refused to/.test(t)) errs.push(name + ": " + t); });
      await page.goto("http://127.0.0.1:" + srv.port + url, { waitUntil: "load" });
      await page.evaluate(() => {
        if (/dark/.test(location.hash)) document.documentElement.setAttribute("data-theme", "dark");
      });
      await page.waitForTimeout(600);
      await page.screenshot({ path: path.join(OUT, name + ".png"), fullPage: true });
      if (after) {
        await after();
        await page.waitForTimeout(3200); // the page polls every 2.5 s
        await page.screenshot({ path: path.join(OUT, name + "-live.png"), fullPage: true });
      }
      await ctx.close();
    }
    let more = 6;
    const pushMore = async () => {
      act(more++, { tool: "mcp__claude-in-chrome__find", target: "Chrome: find \"departure times table\"", decision: "auto", result: "ok", kind: "browser" });
      act(more++, { tool: "mcp__claude-in-chrome__computer", target: "Chrome: left click button \"Search\" — Searches trains from Cairo to Alexandria for tomorrow", decision: "auto", result: "ok", kind: "browser" });
      act(more++, { tool: "mcp__claude-in-chrome__form_input", target: "Chrome: fill textbox \"Password\" (typed 9 characters)", decision: "refused", result: "error", detail: "That is a password, PIN, code or payment field; JOYA AI never types those. The user must fill it in.", kind: "browser" });
      act(more++, { tool: "mcp__claude-in-chrome__computer", target: "Chrome: left click button \"Book now\" — Books the 08:00 train", decision: "denied", result: "error", detail: "", kind: "browser" });
    };
    await shot("computers-light", "/machines", 1280, 2100, pushMore);
    await shot("computers-mobile", "/machines", 390, 2600);
    // The full log: one approved step too.
    act(more++, { tool: "mcp__joya-hands__office_edit", target: "C:\\Users\\Ahmed\\Documents\\Finance\\Budget.xlsx -> C:\\Users\\Ahmed\\Documents\\Finance\\Budget.xlsx", decision: "approved", result: "ok", detail: "saved (Excel): replaced the original", kind: "hands" });
    await sleep(400);
    await shot("take-over-log-light", `/machines/${a.id}/lease/${lid}`, 1280, 1400);
    await shot("take-over-log-dark", `/machines/${a.id}/lease/${lid}#dark`, 1280, 1400);
    await shot("computers-dark", "/machines#dark", 1280, 2100);
    await browser.close();
    void b;
  } finally {
    for (const ws of apps) ws.close();
    srv.stop();
    fake.close();
  }
  console.log(errs.length ? "console / CSP errors:\n" + errs.join("\n") : "no console or CSP errors");
  console.log("shots in " + OUT);
})().catch((e) => {
  console.error(e.stack || e);
  process.exit(1);
});
