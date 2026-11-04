#!/usr/bin/env node
"use strict";
/**
 * The living canvas in the browser (headless Chromium): a scratch server.js over a fake supervisor
 * (canvas-fake-supervisor.cjs: the story fixture's world, usage figures, and JOYA AI's ui_widget
 * played as the supervisor emits it).
 *
 *     NODE_PATH=/opt/joya-dashboard/node_modules PLAYWRIGHT=/root/e2e/pw/node_modules/playwright \
 *       node dashboard/tools/test-living-canvas.cjs [--shots DIR]
 *
 * Calm (the core and three quiet tiles); an answer with a widget beside the reply, pinned, resized,
 * kept after a reload, dismissed and counted; every block type drawn as text (no markup from a widget
 * ever becomes an element); an approval widget opening the existing decision card; a failure making
 * that session's card the hero with "Fix it" (which sends JOYA AI an ordinary request); a long wait;
 * the morning brief in the centre; the lock; a phone (16 px gutter, no horizontal scroll); dark and
 * light; reduced motion; the desktop app's render mode (the widget a hit region and, settled, a glass
 * surface; Floating). --shots DIR writes the screenshots and GIFs (mockups/living-canvas/).
 */
const scratch = require("./scratch-server.cjs"); // first: sets JOYA_DATA_DIR
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const ROOT = path.join(__dirname, "..");
const SHOTS = (() => { const i = process.argv.indexOf("--shots"); return i > 0 ? path.resolve(process.argv[i + 1]) : null; })();
const APP_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36 Edg/129.0.0.0 JoyaDesktop/0.1.11";

let passed = 0, failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log("  ok   " + name); }
  else { failed++; console.log("  FAIL " + name + (detail !== undefined ? "\n       " + String(detail).slice(0, 900) : "")); }
}
const section = (t) => console.log("\n" + t);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pw = null;
try { pw = require(process.env.PLAYWRIGHT || "playwright"); } catch (e) { pw = null; }
if (!pw) { console.log("(skipped: set PLAYWRIGHT=/path/to/node_modules/playwright)\n\n0 passed, 0 failed"); process.exit(0); }

const { buildWorld, IDS } = require("./story-fixture.cjs");
const { startCanvasFake } = require("./canvas-fake-supervisor.cjs");

const SPEND = { v: 1, kind: "chart", title: "Spend, last 14 days", note: "JOYA AI from its ledger; other sessions estimated at list prices.", source: { name: "usage.spend" }, blocks: [{ type: "chart", view: "days" }, { type: "metric", view: "today" }] };
const XSS = { v: 1, kind: "table", title: "Folders by size", blocks: [{ type: "table", columns: [{ key: "dir", label: "Folder" }, { key: "gb", label: "GB", align: "right", format: "number" }], rows: [{ dir: "/var/lib/odoo", gb: 41.2 }, { dir: "/root/backups", gb: 27.9 }, { dir: "/opt/joya-dashboard", gb: 0.4 }] }, { type: "text", text: "Backups grew 3.1 GB this week." }] };

(async () => {
  const W = buildWorld(fs.mkdtempSync(path.join(os.tmpdir(), "cv-world-")), Date.now());
  const SOCK = path.join(scratch.DATA, "fake-canvas-ui.sock");
  const sup = await startCanvasFake(SOCK, W);
  const PORT = 3760 + Math.floor(Math.random() * 40);
  const ORIGIN = `http://a.localhost:${PORT}`;
  const db = require(path.join(ROOT, "lib", "db.js"));
  let s = null, browser = null;
  const problems = [];
  const report = { shots: [], gifs: [] };
  const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "cv-frames-"));
  // The world starts calm: nobody waiting, no approval pending, no failure.
  const audit = W.sessions.find((x) => x.session_id === IDS.audit);
  const calm = () => { audit.status = "idle"; delete audit.waiting_for; delete audit.status_since; W.ledger.db.prepare("UPDATE approvals SET status = 'denied', decided_at = ? WHERE status = 'pending'").run(new Date().toISOString()); W.ledger.db.prepare("DELETE FROM delegations WHERE status IN ('failed','held')").run(); };
  calm();
  try {
    s = await scratch.startScratch({ port: PORT, env: { JOYA_AI_SOCKET: SOCK, JOYA_PROACTIVE_TICK_MS: "3600000" } });
    await s.makeUser("alice", "administrator");
    db.setUserJoyaCore(db.getUserByName("alice").id, "E");
    const ALICE = db.getUserByName("alice").id;
    const { cookie } = await s.signIn("alice");
    browser = await pw.chromium.launch({ args: ["--host-resolver-rules=MAP *.localhost 127.0.0.1", "--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
    async function open(w, h, q, o) {
      o = o || {};
      const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: o.dpr || 1, colorScheme: o.theme || "dark", reducedMotion: o.reduced ? "reduce" : "no-preference", userAgent: o.desk ? APP_UA : undefined, extraHTTPHeaders: { "X-Forwarded-Proto": "https" } });
      await ctx.addCookies(String(cookie).split("; ").filter(Boolean).map((kv) => ({ name: kv.split("=")[0], value: kv.slice(kv.indexOf("=") + 1), url: ORIGIN })));
      const page = await ctx.newPage();
      await page.addInitScript((theme) => {
        window.__csp = [];
        document.addEventListener("securitypolicyviolation", (e) => window.__csp.push(e.violatedDirective + " " + e.blockedURI));
        try { localStorage.setItem("theme", theme); } catch (e) { /* none */ }
        window.__xss = 0;
      }, o.theme || "dark");
      const tag = w + "x" + h + " " + (q || "");
      page.on("pageerror", (e) => problems.push(tag + ": pageerror " + e.message));
      page.on("console", (m) => { if (m.type() === "error" && !/status of (404|503|409)|Failed to load resource|EventSource/.test(m.text())) problems.push(tag + ": console " + m.text()); });
      await page.goto(ORIGIN + (o.path || "/joya-ai") + (q ? "?" + q : ""), { waitUntil: "load" });
      if (!o.path) {
        await page.evaluate((t) => { document.documentElement.setAttribute("data-theme", t); document.dispatchEvent(new Event("joya-theme")); }, o.theme || "dark");
        await page.waitForFunction(() => window.__joyaCC && window.__joyaCC.S && window.__joyaCC.S.online && window.JoyaCanvas && window.JoyaCanvas.plan(), null, { timeout: 15000 }).catch(() => {});
        await sleep(600);
      }
      return { ctx, page, close: async () => { const c = await page.evaluate(() => window.__csp || []).catch(() => []); c.forEach((x) => problems.push(tag + ": CSP " + x)); await ctx.close(); } };
    }
    const shot = async (page, name, o) => { if (!SHOTS) return; fs.mkdirSync(SHOTS, { recursive: true }); await sleep((o && o.wait) || 1200); await page.screenshot({ path: path.join(SHOTS, name + ".png"), clip: o && o.clip }); report.shots.push(name); };
    const plan = (page) => page.evaluate(() => window.JoyaCanvas.plan());
    const info = (page) => page.evaluate(() => {
      const r = (sel) => [...document.querySelectorAll(sel)].map((n) => ({ id: n.getAttribute("data-cv"), size: n.getAttribute("data-size"), rect: n.getBoundingClientRect().toJSON(), text: n.textContent.replace(/\s+/g, " ").trim().slice(0, 300), hidden: n.hidden }));
      return { left: r("#cv-left > .cv-w"), right: r("#cv-right > .cv-w"), centre: r("#cv-centre .cv-w"), sw: document.documentElement.scrollWidth, w: innerWidth, mode: document.getElementById("cc").getAttribute("data-cv-mode") };
    });
    async function answer(page, widget, text) {
      const before = sup.lastUt();
      await page.evaluate((t) => window.__joyaCC.send(t), text || "show me");
      for (let i = 0; i < 40 && sup.lastUt() === before; i++) await sleep(50);
      const nonce = "n" + Math.random().toString(36).slice(2, 12) + "x1";
      sup.push({ type: "ui", actor: "alice", ut_tag: sup.tagOf(sup.lastUt()), nonce, action: "widget.show", args: {}, turn_id: sup.lastTurn(), widget });
      await page.waitForFunction((n) => window.JoyaCanvas.state.offered.some((o) => o.id.indexOf(n.slice(0, 20)) >= 0), nonce, { timeout: 5000 }).catch(() => {});
      await sleep(500);
      return nonce;
    }
    const api = async (p) => JSON.parse((await s.req("GET", p, { cookie })).body);

    section("calm: the core and a few quiet tiles");
    for (const theme of ["dark", "light"]) {
      const v = await open(1440, 900, "", { theme });
      const p = await plan(v.page), i = await info(v.page);
      check(theme + ": mode calm, three quiet tiles on the right, nothing in the centre", p.mode === "calm" && i.right.length === 3 && i.centre.length === 0 && i.left.length === 0, JSON.stringify([p.mode, i.right.map((x) => x.id)]));
      check("  the quiet tiles read the real sources (spend today $15.60 from /api/cost; sessions; approvals)", /\$15\.60/.test(i.right[0].text) && /Working/.test(i.right[1].text) && /Waiting on you/.test(i.right[2].text), i.right.map((x) => x.text).join(" | "));
      check("  no horizontal scroll", i.sw <= i.w);
      await shot(v.page, "calm-" + theme);
      await v.close();
    }

    section("an answer with a widget, pinned");
    {
      const v = await open(1440, 900, "");
      const frames = path.join(TMP, "pin");
      fs.mkdirSync(frames, { recursive: true });
      let k = 0;
      const frame = async (n) => { if (!SHOTS) return; for (let j = 0; j < (n || 1); j++) { await v.page.screenshot({ path: path.join(frames, "f" + String(k++).padStart(3, "0") + ".png") }); await sleep(90); } };
      await frame(4);
      await answer(v.page, SPEND, "what did we spend this fortnight?");
      for (let j = 0; j < 8; j++) await frame();
      let i = await info(v.page);
      check("the widget is beside the reply: the centre slot under the core, marked as JOYA AI's answer and live", i.centre.length === 1 && /From JOYA AI's answer/.test(i.centre[0].text) && /live/.test(i.centre[0].text) && i.mode === "board", JSON.stringify(i.centre));
      check("  drawn from usage.spend: a 14-day chart of stacked bars, today's metric", await v.page.evaluate(() => document.querySelectorAll("#cv-centre .cv-chart rect").length === 28 && /\$15\.60/.test(document.querySelector("#cv-centre .cv-metric").textContent)));
      check("  the core made room for it: the centre slot sits above the caption, below the core's middle", await v.page.evaluate(() => { const c = document.getElementById("cv-centre").getBoundingClientRect(), cap = document.getElementById("cc-caption").getBoundingClientRect(); const L = window.__joyaCC.orbit; return c.bottom <= cap.top + 1 && c.height > 100; }));
      check("  counted as offered on the server", (await api("/joya-ai/api/canvas")).learned.rows.some((r) => r.key === "chart:usage.spend" && r.offered === 1));
      await shot(v.page, "answer-widget-dark", { wait: 400 });
      // Pin it (a real click, recorded)
      await v.page.hover('#cv-centre [data-cv-act="pin"]');
      await frame(3);
      await v.page.click('#cv-centre [data-cv-act="pin"]');
      for (let j = 0; j < 10; j++) await frame();
      await v.page.waitForFunction(() => window.JoyaCanvas.state.pins.length === 1, null, { timeout: 4000 }).catch(() => {});
      i = await info(v.page);
      check("Pin: it moves to the board's left column, kept on the server", i.left.length === 1 && i.centre.length === 0 && (await api("/joya-ai/api/canvas")).pins.length === 1, JSON.stringify(i.left));
      await v.page.click('#cv-left [data-cv-act="size"]');
      await sleep(400);
      i = await info(v.page);
      check("the size button cycles M -> L; stored", i.left[0].size === "l" && (await api("/joya-ai/api/canvas")).pins[0].size === "l");
      for (let j = 0; j < 6; j++) await frame();
      await shot(v.page, "pinned-board-dark", { wait: 500 });
      if (SHOTS && k > 5) {
        try {
          execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-framerate", "7", "-i", path.join(frames, "f%03d.png"), "-vf", "scale=900:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=128[p];[b][p]paletteuse=dither=bayer", path.join(SHOTS, "widget-pinned.gif")]);
          report.gifs.push("widget-pinned");
        } catch (e) { problems.push("gif: " + e.message); }
      }
      await v.close();
      const v2 = await open(1440, 900, "");
      i = await info(v2.page);
      check("after a reload the pinned widget is still on the board (from the server), at its size", i.left.length === 1 && i.left[0].size === "l" && /Spend, last 14 days/.test(i.left[0].text));
      await answer(v2.page, XSS);
      await v2.page.click('#cv-centre [data-cv-act="x"]');
      await sleep(400);
      i = await info(v2.page);
      check("× dismisses an answer's widget, and it is counted", i.centre.length === 0 && (await api("/joya-ai/api/canvas")).learned.rows.find((r) => r.key === "table:payload").dismissals === 1);
      await v2.close();
    }

    section("every block, drawn as text only");
    {
      const v = await open(1440, 900, "");
      await answer(v.page, { v: 1, kind: "story", title: "Planning engine", blocks: [{ type: "story", session: IDS.planning }] });
      await answer(v.page, { v: 1, kind: "compare", title: "Planning engine vs Customs docs", blocks: [{ type: "compare", sessions: [IDS.planning, IDS.customs] }] });
      await sleep(1200);
      let i = await info(v.page);
      const story = i.centre.concat(i.right).find((x) => /Planning engine/.test(x.text) && /Open the story/.test(x.text));
      check("a story card from the real story data: state, its plan step, files, tokens, Open the story", story && /working/.test(story.text) && /Now: |Last: /.test(story.text) && /files/.test(story.text) && /tokens/.test(story.text), JSON.stringify(i.centre.concat(i.right).map((x) => x.text)));
      const cmp = i.centre.concat(i.right).find((x) => /vs Customs docs/.test(x.text));
      check("a comparison of two sessions: tokens, active, files, lines, turns", cmp && /Tokens/.test(cmp.text) && /Active/.test(cmp.text) && /Turns/.test(cmp.text), cmp && cmp.text);
      await v.page.evaluate(() => { const b = [...document.querySelectorAll(".cv-w .cv-b")].find((x) => /Open the story/.test(x.textContent)); b.click(); });
      await sleep(900);
      check("Open the story opens the session story (JoyaStory) and counts an open", await v.page.evaluate(() => { const r = document.getElementById("cc-story"); return !!r && !r.hidden; }) && (await api("/joya-ai/api/canvas")).learned.rows.find((r) => r.key === "story:story").opens >= 1);
      await v.page.keyboard.press("Escape");
      await sleep(300);
      // pin these two so the gallery shows them; then files / table / list / approval.
      await v.page.evaluate(() => Promise.all(window.JoyaCanvas.state.offered.slice().map((o) => window.JoyaCanvas.pin(o.id))));
      W.ledger.db.prepare("UPDATE approvals SET status = 'pending', expires_at = ? WHERE request_id = 'r2'").run(new Date(Date.now() + 4 * 60000).toISOString());
      const ap = W.ledger.db.prepare("SELECT id FROM approvals WHERE request_id = 'r2'").get();
      await v.close();
      const v2 = await open(1440, 900, "");
      await v2.page.evaluate(async () => { for (const p of window.JoyaCanvas.state.pins.slice()) if (p.spec.kind === "chart") await window.JoyaCanvas.dismiss("p" + p.id); await window.JoyaCanvas.reload(); });
      await v2.page.evaluate(() => { const n = document.getElementById("cc-need"); if (n) n.hidden = true; });
      await answer(v2.page, { v: 1, kind: "files", title: "Planning engine: files touched", source: { name: "story", params: { session: IDS.planning } }, blocks: [{ type: "files", view: "files" }] });
      await answer(v2.page, { v: 1, kind: "approval", title: "Waiting on you", blocks: [{ type: "approval", approval: ap.id }] });
      await sleep(1500);
      i = await info(v2.page);
      const all = i.left.concat(i.right, i.centre);
      const files = all.find((x) => /files touched/.test(x.text));
      check("a files block: paths with +added −removed from the story", files && /\.py/.test(files.text) && /\+\d+/.test(files.text) && /−\d+/.test(files.text), files && files.text);
      const apw = all.find((x) => /Waiting on you/.test(x.text) && /Review/.test(x.text));
      check("an approval widget shows the real approval (from its own data, not the payload) with Review / Approve / Deny", apw && /dupes\.py|git push|systemctl|rm -rf/.test(apw.text) && /Approve/.test(apw.text) && /Deny/.test(apw.text), apw && apw.text);
      await shot(v2.page, "widgets-gallery-dark", { wait: 600 });
      await v2.page.evaluate(() => { const b = [...document.querySelectorAll(".cv-ap-w .cv-b")].find((x) => x.textContent === "Review"); b.click(); });
      await sleep(600);
      check("Review opens the existing decision card (no new approval path)", await v2.page.evaluate(() => !document.getElementById("cc-need").hidden));
      // A widget whose strings look like markup never becomes markup (the server and the page refuse it; a
      // string that passes is drawn with textContent).
      await answer(v2.page, { v: 1, kind: "list", title: "Tricky but fine", blocks: [{ type: "list", items: [{ text: "a < b && c > d" }, { text: "Data: x ' \" `" }] }] });
      check("text that looks like code stays text (no element is made from it)", await v2.page.evaluate(() => { const w = [...document.querySelectorAll(".cv-w")].find((x) => /Tricky/.test(x.textContent)); return !!w && /a < b && c > d/.test(w.textContent) && w.querySelectorAll("script, img, a, iframe").length === 0; }));
      const before = sup.seen.length;
      const nonce = await answer(v2.page, { v: 1, kind: "list", title: "<img src=x onerror=window.__xss=1>", blocks: [{ type: "list", items: [{ text: "x" }] }] });
      await sleep(400);
      check("a widget with markup is refused before the page (JOYA AI told why); nothing ran", (await v2.page.evaluate(() => window.__xss)) === 0 && sup.seen.slice(before).some((m) => m.op === "ui-ack" && m.ok === false && /markup/.test(m.why || "")) && !(await v2.page.evaluate((n) => window.JoyaCanvas.state.offered.some((o) => o.id.indexOf(n.slice(0, 20)) >= 0), nonce)));
      const direct = await v2.page.evaluate(() => window.JoyaCanvas.offer({ nonce: "zzzzzzzzzz", widget: { v: 1, kind: "list", title: "x", blocks: [{ type: "list", items: [{ text: "x", href: "https://e.example" }] }] } }));
      check("  and the page's own check refuses it too (JoyaCanvas.offer)", direct.ok === false && /unknown field/.test(direct.why), JSON.stringify(direct));
      W.ledger.db.prepare("UPDATE approvals SET status = 'denied' WHERE status = 'pending'").run();
      await v2.close();
    }

    // Clear the pins for the moments below (a clean board).
    for (const p of (await api("/joya-ai/api/canvas")).pins) await s.req("POST", "/joya-ai/api/canvas/pins/" + p.id + "/unpin", { cookie, headers: { "X-CSRF-Token": s.csrfOf((await s.req("GET", "/joya-ai", { cookie })).body) }, body: {} });

    section("a session fails: its card grows, with its error and Fix it");
    {
      const iso = (min) => new Date(Date.now() - min * 60000).toISOString();
      const v = await open(1440, 900, "");
      const frames = path.join(TMP, "moment");
      fs.mkdirSync(frames, { recursive: true });
      let k = 0;
      const frame = async (n) => { if (!SHOTS) return; for (let j = 0; j < (n || 1); j++) { await v.page.screenshot({ path: path.join(frames, "f" + String(k++).padStart(3, "0") + ".png") }); await sleep(80); } };
      await frame(5);
      W.ledger.db.prepare("INSERT INTO delegations (msg_id, target, target_name, target_session, text, summary, status, note, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)").run("mfail", "Planning engine", "Planning engine", IDS.planning, "M-3 step 3: count the stale MOs on the copy.", "Count the stale MOs on the copy", "failed", "psycopg2.OperationalError: could not connect to server (gizaseeds_test)", iso(9), iso(6));
      const row = W.ledger.db.prepare("SELECT * FROM delegations WHERE msg_id = 'mfail'").get();
      sup.push({ type: "delegation", delegation: row });
      await v.page.waitForFunction(() => window.JoyaCanvas.plan().mode === "incident", null, { timeout: 6000 }).catch(() => {});
      for (let j = 0; j < 9; j++) await frame();
      let p = await plan(v.page), i = await info(v.page);
      check("mode incident: Planning engine is the hero, in the centre, large, with its error", p.mode === "incident" && p.hero.reason === "failed" && i.centre.length >= 1 && i.centre[0].size === "l" && /Planning engine/.test(i.centre[0].text) && /could not connect to server/.test(i.centre[0].text) && /Fix it/.test(i.centre[0].text), JSON.stringify([p.mode, i.centre]));
      check("  the quiet tiles stay small and dim", i.right.every((x) => x.size === "s"));
      await shot(v.page, "failure-dark", { wait: 500 });
      await v.page.click('#cv-centre [data-cv-act="fix"]');
      await v.page.waitForFunction(() => !!document.querySelector(".cv-fix-t"), null, { timeout: 4000 }).catch(() => {});
      for (let j = 0; j < 6; j++) await frame();
      const fixText = await v.page.evaluate(() => document.querySelector(".cv-fix-t") && document.querySelector(".cv-fix-t").textContent);
      check("Fix it shows the request it will send to JOYA AI (an ordinary turn: delegation, approvals as ever)", /^Fix it: the work sent to Planning engine failed/.test(fixText || "") && /delegate the fix/.test(fixText) && /ask me before anything destructive/.test(fixText), fixText);
      await shot(v.page, "failure-fixit-dark", { wait: 300 });
      const n0 = sup.seen.length;
      await v.page.click('#cv-centre [data-cv-act="fix-send"]');
      await sleep(800);
      for (let j = 0; j < 8; j++) await frame();
      const sent = sup.seen.slice(n0).find((m) => m.op === "send");
      check("Send goes through the composer's own send (POST /api/send -> the supervisor's send op, with a ui token), nothing else", sent && /^Fix it: the work sent to Planning engine failed/.test(sent.text) && !!sent.ut && !sup.seen.slice(n0).some((m) => /^(approve|session-|machine-|interrupt)/.test(m.op)), JSON.stringify(sup.seen.slice(n0).map((m) => m.op)));
      p = await plan(v.page);
      check("  and the incident is put away (the board goes back)", p.mode !== "incident");
      if (SHOTS && k > 5) {
        try {
          execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-framerate", "7", "-i", path.join(frames, "f%03d.png"), "-vf", "scale=900:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=128[p];[b][p]paletteuse=dither=bayer", path.join(SHOTS, "failure-fixit.gif")]);
          report.gifs.push("failure-fixit");
        } catch (e) { problems.push("gif: " + e.message); }
      }
      await v.close();
      // light, with the failure still fresh (another one)
      W.ledger.db.prepare("UPDATE delegations SET msg_id = 'mfail2', status = 'failed', updated_at = ? WHERE msg_id = 'mfail'").run(iso(3));
      const v2 = await open(1440, 900, "", { theme: "light" });
      await v2.page.evaluate(() => { try { localStorage.removeItem("joya-canvas-acked"); } catch (e) { /* none */ } window.JoyaCanvas.state.acked = {}; window.JoyaCanvas.refresh(); });
      await sleep(800);
      check("light theme: the failure is the hero too", (await plan(v2.page)).mode === "incident");
      await shot(v2.page, "failure-light");
      // Lock: nothing grows, a badge says it
      await v2.page.click('#cv-ctl [data-cv-act="lock"]');
      await sleep(700);
      p = await plan(v2.page);
      i = await info(v2.page);
      check("Lock: no hero, a badge \"1 needs you\", saved on the server", p.locked && !p.hero && i.centre.length === 0 && (await v2.page.evaluate(() => (document.querySelector(".cv-att") || {}).textContent)) === "1 needs you" && (await api("/joya-ai/api/canvas")).prefs.locked === true);
      await shot(v2.page, "locked-light", { wait: 500 });
      await v2.page.click('#cv-ctl [data-cv-act="lock"]');
      await sleep(500);
      check("  unlocked: the hero is back", (await plan(v2.page)).mode === "incident");
      await v2.close();
      W.ledger.db.prepare("DELETE FROM delegations WHERE status = 'failed'").run();
    }

    section("a session waits long");
    {
      audit.status = "waiting"; audit.waiting_for = "your approval"; audit.status_since = new Date(Date.now() - 26 * 60000).toISOString();
      const v = await open(1440, 900, "");
      const p = await plan(v.page), i = await info(v.page);
      check("waiting 26 min: Invoice audit is the hero, how long it has waited, Fix it and its story", p.mode === "incident" && p.hero.reason === "waiting" && /Invoice audit/.test(i.centre[0].text) && /waiting for your approval/.test(i.centre[0].text) && /Fix it/.test(i.centre[0].text) && /Its story/.test(i.centre[0].text), JSON.stringify(i.centre));
      await shot(v.page, "waiting-dark");
      await v.close();
      calm();
    }

    section("the morning brief takes the centre");
    {
      const zones = ["Pacific/Honolulu", "America/Anchorage", "America/Los_Angeles", "America/Denver", "America/Chicago", "America/New_York", "America/Sao_Paulo", "Atlantic/Azores", "Europe/London", "Europe/Berlin", "Africa/Cairo", "Asia/Dubai", "Asia/Karachi", "Asia/Dhaka", "Asia/Bangkok", "Asia/Shanghai", "Asia/Tokyo", "Australia/Sydney", "Pacific/Auckland"];
      const hourIn = (z) => Number(new Intl.DateTimeFormat("en-GB", { hour: "2-digit", hourCycle: "h23", timeZone: z }).format(new Date())) % 24;
      const tz = zones.find((z) => hourIn(z) >= 7 && hourIn(z) <= 10);
      if (!tz) check("(no zone is in its morning now: the brief part is skipped)", true);
      else {
        const store = require(path.join(ROOT, "lib", "proactive-store.js")).create(db.db);
        store.setPrefs(ALICE, { tz }, "test");
        store.addInbox(ALICE, "brief", "Morning brief · " + new Date().toDateString().slice(0, 10), {
          lines: [{ k: "Planning engine", text: "counted 236 stale MOs on the copy; waiting for the team's review", tone: "info", sid: IDS.planning }, { k: "Customs docs", text: "filed the October declarations", tone: "ok", sid: IDS.customs }, { k: "Spend", text: "$12.80 yesterday, under every cap", tone: "ok" }, { k: "Invoice audit", text: "needs your approval for the duplicate bills", tone: "warn", sid: IDS.audit }],
          speech: "Good morning.", source: "template",
        });
        for (const theme of ["light", "dark"]) {
          const v = await open(1440, 900, "", { theme });
          await v.page.waitForFunction(() => window.JoyaCanvas.plan().mode === "brief", null, { timeout: 8000 }).catch(() => {});
          const p = await plan(v.page);
          const where = await v.page.evaluate(() => { const c = document.getElementById("pa-card"); return c ? { inCentre: c.parentNode.id === "cv-centre", w: c.getBoundingClientRect().width } : null; });
          check(theme + ": " + tz + " (" + hourIn(tz) + ":00): mode brief, the brief card moved into the centre under the core", p.mode === "brief" && p.hero.type === "brief" && where && where.inCentre && where.w > 400, JSON.stringify([p.mode, where]));
          await shot(v.page, "morning-" + theme);
          if (theme === "dark") {
            await v.page.click("#pa-card [data-pa=dismiss]");
            await sleep(800);
            check("  dismissed: the brief leaves and the board is calm again", (await plan(v.page)).mode === "calm" && !(await v.page.evaluate(() => document.getElementById("pa-card"))));
          }
          await v.close();
        }
        store.setPrefs(ALICE, { tz: "" }, "test");
      }
    }

    section("learning: what you keep");
    {
      const v = await open(1440, 900, "");
      for (let n = 0; n < 2; n++) { await answer(v.page, XSS); await v.page.click('#cv-centre [data-cv-act="x"]'); await sleep(300); }
      const before = sup.seen.length;
      const nonce = await answer(v.page, XSS);
      const ack = sup.seen.slice(before).find((m) => m.op === "ui-ack" && m.nonce === nonce);
      check("dismissed three times, never pinned: that kind is no longer offered (JOYA AI told to answer in words)", ack && ack.ok === false && /keeps dismissing/.test(ack.why) && !(await v.page.evaluate(() => window.JoyaCanvas.state.offered.length)), JSON.stringify(ack));
      for (let n = 0; n < 3; n++) {
        await answer(v.page, Object.assign({}, SPEND, { title: "Spend " + (n + 1) }));
        await v.page.click('#cv-centre [data-cv-act="pin"]');
        await sleep(400);
        const id = await v.page.evaluate(() => window.JoyaCanvas.state.pins[0].id);
        await s.req("POST", "/joya-ai/api/canvas/pins/" + id + "/unpin", { cookie, headers: { "X-CSRF-Token": s.csrfOf((await s.req("GET", "/joya-ai", { cookie })).body) }, body: {} });
        await v.page.evaluate(() => window.JoyaCanvas.reload());
        await sleep(300);
      }
      await v.page.evaluate(() => window.JoyaCanvas.reload());
      await sleep(600);
      const p = await plan(v.page);
      check("pinned three times: it became a standing tile (from the last one pinned), though nothing is pinned now", p.tiles.some((t) => t.type === "standing" && t.key === "chart:usage.spend") && (await api("/joya-ai/api/canvas")).pins.length === 0, JSON.stringify(p.tiles));
      await shot(v.page, "learned-standing-dark");
      await v.close();
      const set = await open(1280, 900, "", { theme: "light", path: "/joya-ai/settings/appearance" });
      // The counts and Reset sit under Board ▸ More since the 2026-10-25 cleanup.
      await set.page.click("#a-board-more > summary");
      await set.page.evaluate(() => document.getElementById("board").scrollIntoView());
      await sleep(400);
      const t = await set.page.evaluate(() => document.querySelector(".cv-learn") && document.querySelector(".cv-learn").textContent.replace(/\s+/g, " "));
      check("Settings ▸ Appearance ▸ Board shows the counts with their verdicts (standing tile, not offered)", /standing tile/.test(t || "") && /not offered/.test(t || ""), t);
      await shot(set.page, "settings-board-light", { wait: 300 });
      await set.page.click('#a-board-reset button[type="submit"]');
      await sleep(400);
      await set.page.getByRole("button", { name: "Reset", exact: true }).click({ timeout: 4000 }).catch((e) => problems.push("reset confirm: " + e.message.split("\n")[0]));
      await sleep(1500);
      check("Reset (with its confirm): the counts are forgotten", (await api("/joya-ai/api/canvas")).learned.rows.length === 0);
      await set.close();
    }

    section("the conversation keeps the widgets (after a reload, on another device)");
    {
      const csrf = s.csrfOf((await s.req("GET", "/joya-ai", { cookie })).body);
      const v = await open(1440, 900, "");
      await answer(v.page, Object.assign({}, SPEND, { title: "Spend for the history" }), "what did we spend? (history)");
      await sleep(600);
      const histOf = (page) => page.evaluate(() => {
        window.__joyaCC.openSheet("conv");
        return [...document.querySelectorAll("#cc-chat .cv-hist .cv-w")].map((w) => ({ text: w.textContent.replace(/\s+/g, " ").trim().slice(0, 200), rects: w.querySelectorAll(".cv-chart rect").length, turn: w.closest(".cc-turn") && w.closest(".cc-turn").getAttribute("data-turn") }));
      });
      await sleep(400);
      let h = await histOf(v.page);
      const mine = h.find((x) => /Spend for the history/.test(x.text));
      check("shown with its reply in the conversation too (live: the 14-day chart), marked as shown with this reply", mine && mine.rects === 28 && /Shown with this reply/.test(mine.text), JSON.stringify(h));
      await v.close();
      // A reload: nothing is offered on the board any more, but the conversation still has it.
      const v2 = await open(1440, 900, "");
      await sleep(500);
      h = await histOf(v2.page);
      check("after a reload: the conversation shows it again (from the ledger, re-validated), the board offers nothing", h.some((x) => /Spend for the history/.test(x.text) && x.rects === 28) && (await v2.page.evaluate(() => window.JoyaCanvas.state.offered.length)) === 0, JSON.stringify(h.map((x) => x.text.slice(0, 40))));
      // Learning: a kind no longer offered is still shown in old history.
      for (let n = 0; n < 3; n++) await s.req("POST", "/joya-ai/api/canvas/event", { cookie, headers: { "X-CSRF-Token": csrf }, body: { key: "table:payload", what: "dismiss" } });
      check("  (table widgets are no longer offered now)", (await api("/joya-ai/api/canvas")).learned.suppressed.includes("table:payload"));
      await v2.close();
      const v3 = await open(1280, 860, "", { theme: "light" });
      await sleep(500);
      h = await histOf(v3.page);
      check("another tab or device (light): the same widgets, including a kind no longer offered (old history keeps it)", h.some((x) => /Spend for the history/.test(x.text)) && h.some((x) => /Folders by size/.test(x.text)), JSON.stringify(h.map((x) => x.text.slice(0, 40))));
      await v3.page.evaluate(() => { const w = [...document.querySelectorAll("#cc-chat .cv-hist .cv-w")].find((x) => /Spend for the history/.test(x.textContent)); w.scrollIntoView({ block: "center" }); });
      await shot(v3.page, "conversation-history-light", { wait: 700 });
      const pinsBefore = (await api("/joya-ai/api/canvas")).pins.length;
      await v3.page.evaluate(() => { const w = [...document.querySelectorAll("#cc-chat .cv-hist .cv-w")].find((x) => /Spend for the history/.test(x.textContent)); w.querySelector('[data-cv-act="pin"]').click(); });
      await sleep(800);
      check("Pin from the conversation puts it on the board", (await api("/joya-ai/api/canvas")).pins.length === pinsBefore + 1);
      const bad = await v3.page.evaluate(() => {
        const d = document.createElement("div");
        d.innerHTML = '<div class="cc-msg ai"><div class="cc-bubble"></div></div>';
        window.JoyaCanvas.history(d, { id: 99999, widgets: [{ id: "x", widget: { v: 1, kind: "list", title: "<img src=x onerror=window.__xss=1>", blocks: [{ type: "list", items: [{ text: "x" }] }] } }, { id: "y", widget: { v: 1, kind: "metric", title: "ok", blocks: [{ type: "metric", label: "n", value: 1 }] } }] });
        return { n: d.querySelectorAll(".cv-w").length, img: d.querySelectorAll("img").length, xss: window.__xss };
      });
      check("a stored widget that does not pass is left out on load; the rest is drawn", bad.n === 1 && bad.img === 0 && bad.xss === 0, JSON.stringify(bad));
      await s.req("POST", "/joya-ai/api/canvas/reset", { cookie, headers: { "X-CSRF-Token": csrf }, body: {} });
      await v3.close();
    }

    section("a phone");
    for (const theme of ["dark", "light"]) {
      const v = await open(390, 844, "", { theme, dpr: 2 });
      await answer(v.page, SPEND);
      const i = await info(v.page);
      const box = await v.page.evaluate(() => document.getElementById("cv-centre").getBoundingClientRect().toJSON());
      check(theme + ": the widget under the core, 16 px gutters, no horizontal scroll", i.centre.length >= 1 && Math.round(box.left) === 16 && Math.round(390 - box.right) === 16 && i.sw <= 390, JSON.stringify([box, i.sw]));
      check("  no side columns", i.left.length === 0 && i.right.length === 0 && (await v.page.evaluate(() => getComputedStyle(document.getElementById("cv-right")).display)) === "none");
      await shot(v.page, "phone-" + theme);
      await v.close();
    }

    section("reduced motion");
    {
      const v = await open(1280, 800, "", { reduced: true });
      await answer(v.page, SPEND);
      const anims = await v.page.evaluate(() => document.getAnimations().filter((a) => a.effect && a.effect.target && a.effect.target.closest && a.effect.target.closest(".cv-w")).length);
      check("nothing moves: no animation on the board's cards", anims === 0, anims);
      await v.close();
    }

    section("the desktop app's render mode");
    for (const theme of ["dark", "light"]) {
      const v = await open(1280, 800, "shell=desktop&mode=desktop&glance=1&glass=1&ink=" + (theme === "dark" ? "light" : "dark"), { theme, desk: true });
      await answer(v.page, SPEND);
      await sleep(900);
      const d = await v.page.evaluate(() => {
        const w = document.querySelector("#cv-board .cv-w");
        const r = w ? w.getBoundingClientRect().toJSON() : null;
        const regs = window.JoyaDesktop.regions(), glass = window.JoyaDesktop.glass();
        const inside = (a, b) => a && b.x <= a.left + 1 && b.y <= a.top + 1 && b.x + b.w >= a.right - 1 && b.y + b.h >= a.bottom - 1;
        const gl = window.JoyaDesktop.glance();
        return { r, hit: regs.some((g) => inside(r, g)), glass: glass.some((g) => Math.abs(g.x - r.left) < 1 && Math.abs(g.y - r.top) < 1 && Math.abs(g.w - r.width) < 1), glassAttr: w && w.getAttribute("data-dk-glass"), glance: gl.on && gl.layout, sw: document.documentElement.scrollWidth, W: innerWidth };
      });
      check(theme + ": the widget sits in a column beside the core, opposite the glance cards", d.r && d.glance && (d.glance.side === "left" ? d.r.left > d.glance.x + d.glance.w : d.r.right < d.glance.x) && d.r.right <= d.W, JSON.stringify(d));
      check("  it catches the mouse (a hit region); the rest of the window still lets clicks through", d.hit);
      check("  settled, it is a glass surface (a blur rect, the lighter tint)", d.glass && d.glassAttr === "card", JSON.stringify(d));
      check("  no quiet tiles here (the glance cards already show sessions, tokens, approvals)", !(await plan(v.page)).tiles.some((t) => t.type === "standing"));
      await shot(v.page, "desktop-shell-" + theme);
      await v.close();
    }
    {
      const v = await open(760, 860, "shell=desktop&mode=floating&glass=1", { desk: true });
      await answer(v.page, { v: 1, kind: "metric", title: "Tokens today", source: { name: "usage.caps" }, blocks: [{ type: "metric", view: "tokens" }, { type: "metric", view: "tightest" }] });
      await sleep(600);
      const d = await v.page.evaluate(() => { const w = document.querySelector("#cv-board .cv-w"); const L = window.JoyaDesktop.layout(); return { r: w && w.getBoundingClientRect().toJSON(), box: L.box, card: L.card }; });
      check("Floating: the widget goes in the headroom above the box (where the decision card would), never over the core", d.r && d.r.bottom <= d.box.y + 1 && d.r.left >= d.card.x - 1, JSON.stringify(d));
      await shot(v.page, "desktop-floating-dark");
      await v.close();
    }

    check("no page errors, console errors or CSP violations", problems.length === 0, problems.join("\n"));
    if (SHOTS) fs.writeFileSync(path.join(SHOTS, "report.json"), JSON.stringify(report, null, 1));
  } catch (e) {
    check("no exception", false, e.stack);
  } finally {
    if (browser) await browser.close();
    if (s) s.stop();
    sup.close();
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) { /* left */ }
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
