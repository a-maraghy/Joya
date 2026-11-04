#!/usr/bin/env node
"use strict";
/**
 * The Command Center's composer (2026-10-25 redesign) and files attached to a message to JOYA AI.
 *
 *     NODE_PATH=/opt/joya-dashboard/node_modules PLAYWRIGHT=/root/e2e/pw/node_modules/playwright \
 *       node dashboard/tools/test-composer.cjs [--shots DIR]
 *
 * A scratch server.js (tools/scratch-server.cjs: no helper, a temp data dir) over a fake supervisor
 * (tools/canvas-fake-supervisor.cjs: it records every send), so nothing reaches the live JOYA AI.
 *
 *   - the upload route: the size limit, the allow-list, a program renamed .png, text with NUL bytes,
 *     CSRF, the joyaai.use permission, path traversal (in the id, the batch header and the file name),
 *     another person's folder, the file served back with nosniff and a sandbox;
 *   - send: the turn carries one "[Attached file: <path> | name | type | size]" line per file, the path
 *     a real file under the upload root; someone else's file, a missing one and eleven are refused;
 *   - the page in headless Chromium: paste (a synthetic ClipboardEvent with a PNG), drop (a synthetic
 *     DataTransfer) and the drag-over state, chips with a preview and a size, remove by keyboard, the
 *     message carrying the files to the (fake) supervisor, the Conversation showing them, a failed
 *     upload keeping the typed message; Shift+Enter a new line, Enter sends, Enter while composing
 *     (IME) does not, Enter in the @ picker picks a session; the field grows and shrinks back;
 *   - the mic in both themes: ready (full-contrast glyph), in a call (filled), off (says why);
 *   - a phone (390 px): no horizontal scroll, every control 44 px.
 * --shots DIR: idle, two attachments, drag-over, listening, voice off -- at 1440 and 390, light and dark.
 */
const scratch = require("./scratch-server.cjs"); // first: sets JOYA_DATA_DIR
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const zlib = require("zlib");
const ROOT = path.join(__dirname, "..");
const SHOTS = (() => { const i = process.argv.indexOf("--shots"); return i > 0 ? path.resolve(process.argv[i + 1]) : null; })();

let passed = 0, failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log("  ok   " + name); }
  else { failed++; console.log("  FAIL " + name + (detail !== undefined ? "\n       " + String(detail).slice(0, 900) : "")); }
}
const section = (t) => console.log("\n" + t);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pw = null;
try { pw = require(process.env.PLAYWRIGHT || "playwright"); } catch (e) { pw = null; }

const { buildWorld } = require("./story-fixture.cjs");
const { startCanvasFake } = require("./canvas-fake-supervisor.cjs");

/* A real, small PNG (a 24 x 16 gradient), so the chip and the Conversation can show it. */
function png(w, h) {
  const crcT = []; for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crcT[n] = c >>> 0; }
  const crc = (b) => { let c = 0xffffffff; for (const x of b) c = crcT[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (t, d) => { const len = Buffer.alloc(4); len.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const o = y * (w * 3 + 1) + 1 + x * 3; raw[o] = 20 + x * 9; raw[o + 1] = 120 + y * 6; raw[o + 2] = 200 - x * 5; }
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}
const PNG = png(24, 16);
const PDF = Buffer.from("%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n");

(async () => {
  const W = buildWorld(fs.mkdtempSync(path.join(os.tmpdir(), "cmp-world-")), Date.now());
  const SOCK = path.join(scratch.DATA, "fake-composer.sock");
  const sup = await startCanvasFake(SOCK, W);
  const PORT = 3720 + Math.floor(Math.random() * 30);
  const ORIGIN = `http://a.localhost:${PORT}`;
  const UPLOADS = path.join(scratch.DATA, "uploads");
  const db = require(path.join(ROOT, "lib", "db.js"));
  let s = null, browser = null;
  const problems = [];
  try {
    s = await scratch.startScratch({ port: PORT, fakeVoiceOptions: true, env: { JOYA_AI_SOCKET: SOCK, JOYA_PROACTIVE_TICK_MS: "3600000" } });
    db.setSetting("voice_desk", "on", "test");
    await s.makeUser("alice", "administrator");
    await s.makeUser("carol", "administrator");
    await s.makeUser("bob", "viewer-only", ["os.view"]);
    const A = await s.signIn("alice"), C = await s.signIn("carol"), B = await s.signIn("bob");
    const csrfFor = async (who) => s.csrfOf((await s.req("GET", "/joya-ai", { cookie: who.cookie })).body) || s.csrfOf((await s.req("GET", "/account", { cookie: who.cookie })).body);
    const aCsrf = await csrfFor(A), cCsrf = await csrfFor(C), bCsrf = await csrfFor(B);
    function raw(method, p, { cookie, headers, body } = {}) {
      return new Promise((resolve, reject) => {
        const h = Object.assign({ "X-Forwarded-Proto": "https" }, headers || {});
        if (cookie) h.Cookie = cookie;
        if (body) h["Content-Length"] = body.length;
        const r = http.request({ host: "127.0.0.1", port: s.port, method, path: p, headers: h }, (res) => {
          const parts = [];
          res.on("data", (c) => parts.push(c));
          res.on("end", () => { const b = Buffer.concat(parts); let j = null; try { j = JSON.parse(b.toString("utf8")); } catch (_) { j = null; } resolve({ status: res.statusCode, headers: res.headers, body: b, json: j }); });
        });
        r.on("error", reject);
        if (body) r.write(body);
        r.end();
      });
    }
    const up = (who, csrf, name, buf, extra) => raw("POST", "/joya-ai/api/uploads", { cookie: who.cookie, headers: Object.assign({ "Content-Type": "application/octet-stream", "X-CSRF-Token": csrf, "X-File-Name": encodeURIComponent(name) }, extra || {}), body: buf });

    section("the upload route");
    let r = await up(A, aCsrf, "screen shot.png", PNG);
    check("a PNG is taken: an id under <day>/<message folder>/, its name, type, size, a URL", r.status === 200 && /^\d{4}-\d{2}-\d{2}\/[a-f0-9]{16}\/[a-f0-9]{12}\.png$/.test(r.json.id) && r.json.name === "screen shot.png" && r.json.type === "image/png" && r.json.size === PNG.length && r.json.image === true && r.json.url === "/joya-ai/api/uploads/" + r.json.id, JSON.stringify(r.json));
    const png1 = r.json;
    const onDisk = path.join(UPLOADS, png1.id);
    check("  kept on disk under the upload root with a random name; the original name only in its metadata (mode 0600)", fs.existsSync(onDisk) && fs.readFileSync(onDisk).equals(PNG) && JSON.parse(fs.readFileSync(onDisk + ".json", "utf8")).name === "screen shot.png" && (fs.statSync(onDisk).mode & 0o777) === 0o600);
    r = await up(A, aCsrf, "report.pdf", PDF, { "X-Upload-Batch": png1.batch });
    check("a PDF joins the same message folder (X-Upload-Batch)", r.status === 200 && r.json.batch === png1.batch && r.json.type === "application/pdf", JSON.stringify(r.json));
    const pdf1 = r.json;
    r = await up(A, aCsrf, "big.zip", Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(20 * 1024 * 1024)]));
    check("over 20 MB: 413 with the size in words", r.status === 413 && /20 MB/.test(r.json && r.json.error), r.status + " " + (r.json && r.json.error));
    r = await up(A, aCsrf, "setup.exe", Buffer.from("MZ\x90\x00 fake"));
    check("an .exe: 415 (not on the allow-list)", r.status === 415 && /can't be attached/.test(r.json.error), JSON.stringify(r.json));
    r = await up(A, aCsrf, "photo.png", Buffer.from("MZ\x90\x00 really a program"));
    check("a program renamed .png: 415, named a program", r.status === 415 && /program/.test(r.json.error), JSON.stringify(r.json));
    r = await up(A, aCsrf, "notes.txt", Buffer.from("#!/bin/sh\nrm -rf /\n"));
    check("a shell script renamed .txt: 415", r.status === 415, JSON.stringify(r.json));
    r = await up(A, aCsrf, "image.svg", Buffer.from("<svg onload=alert(1)></svg>"));
    check("SVG (it can carry script): 415", r.status === 415, JSON.stringify(r.json));
    r = await up(A, aCsrf, "data.csv", Buffer.from("a,b\x00c"));
    check("a .csv with NUL bytes: 415 (not text)", r.status === 415, JSON.stringify(r.json));
    r = await up(A, aCsrf, "fake.pdf", Buffer.from("hello"));
    check("a .pdf that is not a PDF: 415", r.status === 415, JSON.stringify(r.json));
    r = await up(A, aCsrf, "empty.txt", Buffer.alloc(0));
    check("an empty file: 400", r.status === 400, r.status);
    r = await up(A, "wrong-token", "a.txt", Buffer.from("hi"));
    check("no or a wrong CSRF token: 403, nothing kept", r.status === 403 && /CSRF/.test(r.json.error), JSON.stringify(r.json));
    r = await raw("POST", "/joya-ai/api/uploads", { cookie: A.cookie, headers: { "Content-Type": "application/octet-stream", "X-File-Name": "a.txt" }, body: Buffer.from("hi") });
    check("  (no header at all: 403 too)", r.status === 403);
    r = await up(B, bCsrf, "a.txt", Buffer.from("hi"));
    check("someone without joyaai.use (the permission that sends JOYA AI a message): 403", r.status === 403 && /JOYA AI/.test(r.json.error), JSON.stringify(r.json));
    r = await raw("POST", "/joya-ai/api/uploads", { headers: { "Content-Type": "application/octet-stream", "X-File-Name": "a.txt" }, body: Buffer.from("hi") });
    check("signed out: refused (401, or the sign-in redirect)", r.status === 401 || r.status === 302 || r.status === 403, r.status);
    r = await up(A, aCsrf, "../../../../etc/cron.d/evil.txt", Buffer.from("hello"));
    const trav = r.json || {};
    check("traversal in the file name: kept as a plain name (slashes made _), stored under a random name inside the root", r.status === 200 && !/[\\/]/.test(trav.name) && /^\d{4}-\d{2}-\d{2}\/[a-f0-9]{16}\/[a-f0-9]{12}\.txt$/.test(trav.id) && fs.existsSync(path.join(UPLOADS, trav.id)) && !fs.existsSync("/etc/cron.d/evil.txt"), JSON.stringify(trav));
    r = await up(A, aCsrf, "a.txt", Buffer.from("hi"), { "X-Upload-Batch": "../../.." });
    check("traversal in the folder header: 400", r.status === 400, JSON.stringify(r.json));
    r = await up(A, aCsrf, "a.txt", Buffer.from("hi"), { "X-Upload-Batch": png1.batch.slice(0, 11) + "0000000000000000" });
    check("a folder that does not exist: refused", r.status === 403 || r.status === 400, r.status);
    r = await up(C, cCsrf, "a.txt", Buffer.from("hi"), { "X-Upload-Batch": png1.batch });
    check("another person's message folder: 403", r.status === 403, JSON.stringify(r.json));
    r = await raw("GET", "/joya-ai/api/uploads/" + png1.id, { cookie: A.cookie });
    check("the file comes back: its type, nosniff, a sandboxing CSP, inline for an image", r.status === 200 && r.body.equals(PNG) && r.headers["content-type"] === "image/png" && r.headers["x-content-type-options"] === "nosniff" && /sandbox/.test(r.headers["content-security-policy"]) && /^inline/.test(r.headers["content-disposition"]), JSON.stringify(r.headers));
    r = await raw("GET", "/joya-ai/api/uploads/" + trav.id, { cookie: A.cookie });
    check("  a text file comes as a download (attachment), never rendered", r.status === 200 && /^attachment/.test(r.headers["content-disposition"]), r.headers["content-disposition"]);
    for (const bad of ["../joya.db", "..%2f..%2fmoni.db", png1.id.replace(/\.png$/, ".png.json"), png1.batch + "/batch.json", "2026-01-01/0000000000000000/000000000000.png", "%2e%2e/%2e%2e/joya.db"]) {
      r = await raw("GET", "/joya-ai/api/uploads/" + bad, { cookie: A.cookie });
      check("  GET " + bad + ": not served (404)", r.status === 404 && !/SQLite format/.test(r.body.toString("latin1")), r.status);
    }
    r = await raw("GET", "/joya-ai/api/uploads/" + png1.id, { cookie: B.cookie });
    check("  without joyaai.use: 403", r.status === 403);

    section("send: the files go with the turn");
    const before = sup.turns.length;
    r = await raw("POST", "/joya-ai/api/send", { cookie: A.cookie, headers: { "Content-Type": "application/json", "X-CSRF-Token": aCsrf }, body: Buffer.from(JSON.stringify({ text: "What is on this screen?\nAnd the report?", attachments: [png1.id, pdf1.id] })) });
    const t1 = sup.turns[sup.turns.length - 1];
    const lines = t1 ? t1.text.split("\n") : [];
    check("the turn's text: what was typed (line breaks kept), then one line per file", r.status === 200 && sup.turns.length === before + 1 && /^What is on this screen\?\nAnd the report\?\n\n\[Attached file: /.test(t1.text), t1 && t1.text);
    const ML = require(path.join(ROOT, "public", "cc-logic.js"));
    const sa = ML.splitAttached(t1.text);
    check("  each line: the real path under the upload root, the name, type and size; the page reads them back", sa.files.length === 2 && sa.files[0].path === fs.realpathSync(path.join(UPLOADS, png1.id)) && fs.existsSync(sa.files[0].path) && sa.files[0].name === "screen shot.png" && sa.files[0].type === "image/png" && sa.files[1].type === "application/pdf" && sa.files[0].url === png1.url && sa.text === "What is on this screen?\nAnd the report?", JSON.stringify(sa));
    check("  the line format JOYA AI is given", /^\[Attached file: \/.+\/uploads\/\d{4}-\d{2}-\d{2}\/[a-f0-9]{16}\/[a-f0-9]{12}\.png \| screen shot\.png \| image\/png \| \d+ B\]$/.test(lines[lines.length - 2]), lines[lines.length - 2]);
    r = await raw("POST", "/joya-ai/api/send", { cookie: A.cookie, headers: { "Content-Type": "application/json", "X-CSRF-Token": aCsrf }, body: Buffer.from(JSON.stringify({ text: "", attachments: [png1.id] })) });
    const t2 = sup.turns[sup.turns.length - 1];
    check("files with no text: sent, the turn is the file lines alone", r.status === 200 && /^\[Attached file: /.test(t2.text) && ML.splitAttached(t2.text).text === "", t2 && t2.text);
    const n0 = sup.turns.length;
    r = await raw("POST", "/joya-ai/api/send", { cookie: C.cookie, headers: { "Content-Type": "application/json", "X-CSRF-Token": cCsrf }, body: Buffer.from(JSON.stringify({ text: "look", attachments: [png1.id] })) });
    check("someone else's file: 400, nothing sent", r.status === 400 && sup.turns.length === n0, JSON.stringify(r.json));
    r = await raw("POST", "/joya-ai/api/send", { cookie: A.cookie, headers: { "Content-Type": "application/json", "X-CSRF-Token": aCsrf }, body: Buffer.from(JSON.stringify({ text: "look", attachments: ["2026-01-01/0000000000000000/000000000000.png"] })) });
    check("a file that is not there: 400 in words", r.status === 400 && /no longer there/.test(r.json.error), JSON.stringify(r.json));
    r = await raw("POST", "/joya-ai/api/send", { cookie: A.cookie, headers: { "Content-Type": "application/json", "X-CSRF-Token": aCsrf }, body: Buffer.from(JSON.stringify({ text: "look", attachments: ["../../joya.db"] })) });
    check("a path instead of an id: 400", r.status === 400 && sup.turns.length === n0, JSON.stringify(r.json));
    r = await raw("POST", "/joya-ai/api/send", { cookie: A.cookie, headers: { "Content-Type": "application/json", "X-CSRF-Token": aCsrf }, body: Buffer.from(JSON.stringify({ text: "look", attachments: Array.from({ length: 11 }, (_, i) => png1.id.replace(/[a-f0-9]{12}\.png$/, String(i).padStart(12, "0") + ".png")) })) });
    check("eleven files: 400 (ten per message)", r.status === 400 && /at most 10/.test(r.json.error) && sup.turns.length === n0, JSON.stringify(r.json));
    r = await raw("POST", "/joya-ai/api/send", { cookie: A.cookie, headers: { "Content-Type": "application/json", "X-CSRF-Token": aCsrf }, body: Buffer.from(JSON.stringify({ text: "look", vt: "v1", attachments: [png1.id] })) });
    check("a voice turn can't carry files: 400", r.status === 400 && sup.turns.length === n0, JSON.stringify(r.json));

    if (!pw) { console.log("\n(browser part skipped: set PLAYWRIGHT=/path/to/node_modules/playwright)"); throw null; }

    browser = await pw.chromium.launch({ args: ["--host-resolver-rules=MAP *.localhost 127.0.0.1", "--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
    async function open(w, h, o) {
      o = o || {};
      const ctx = await browser.newContext({ viewport: { width: w, height: h }, colorScheme: o.theme || "light", extraHTTPHeaders: { "X-Forwarded-Proto": "https" }, hasTouch: w < 500, isMobile: false });
      await ctx.addCookies(String((o.who || A).cookie).split("; ").filter(Boolean).map((kv) => ({ name: kv.split("=")[0], value: kv.slice(kv.indexOf("=") + 1), url: ORIGIN })));
      const page = await ctx.newPage();
      await page.addInitScript((theme) => {
        window.__csp = [];
        document.addEventListener("securitypolicyviolation", (e) => window.__csp.push(e.violatedDirective + " " + e.blockedURI));
        try { localStorage.setItem("theme", theme); } catch (e) { /* none */ }
      }, o.theme || "light");
      const tag = w + "x" + h + " " + (o.theme || "light");
      page.on("pageerror", (e) => problems.push(tag + ": pageerror " + e.message));
      page.on("console", (m) => { if (m.type() === "error" && !/status of (400|404|409|413|415|503)|Failed to load resource|EventSource/.test(m.text())) problems.push(tag + ": console " + m.text()); });
      await page.goto(ORIGIN + "/joya-ai", { waitUntil: "load" });
      await page.evaluate((t) => { document.documentElement.setAttribute("data-theme", t); document.dispatchEvent(new Event("joya-theme")); }, o.theme || "light");
      await page.waitForFunction(() => window.__joyaCC && window.__joyaCC.S && window.__joyaCC.S.online, null, { timeout: 15000 }).catch(() => {});
      await sleep(500);
      return { ctx, page, close: async () => { const c = await page.evaluate(() => window.__csp || []).catch(() => []); c.forEach((x) => problems.push(tag + ": CSP " + x)); await ctx.close(); } };
    }
    const shot = async (page, name) => {
      if (!SHOTS) return;
      fs.mkdirSync(SHOTS, { recursive: true });
      await sleep(250);
      const box = await page.evaluate(() => { const r = document.getElementById("cc-dock").getBoundingClientRect(); const top = Math.max(0, r.top - 24); return { x: 0, y: top, width: innerWidth, height: Math.min(innerHeight - top, r.height + 48) }; });
      await page.screenshot({ path: path.join(SHOTS, name + ".png"), clip: box });
    };
    // Synthetic clipboard / drag events with real File objects (Chromium lets a page build a DataTransfer).
    const pasteFiles = (page, files, text) => page.evaluate(({ files, text }) => {
      const dt = new DataTransfer();
      files.forEach((f) => dt.items.add(new File([Uint8Array.from(atob(f.b64), (c) => c.charCodeAt(0))], f.name, { type: f.type })));
      if (text) dt.setData("text/plain", text);
      const ev = new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true });
      document.getElementById("cc-input").focus();
      document.getElementById("cc-input").dispatchEvent(ev);
      return ev.defaultPrevented;
    }, { files, text });
    const dragFiles = (page, files, drop) => page.evaluate(({ files, drop }) => {
      const dt = new DataTransfer();
      files.forEach((f) => dt.items.add(new File([Uint8Array.from(atob(f.b64), (c) => c.charCodeAt(0))], f.name, { type: f.type })));
      const target = document.getElementById("cc-core") || document.body;
      target.dispatchEvent(new DragEvent("dragenter", { dataTransfer: dt, bubbles: true, cancelable: true }));
      target.dispatchEvent(new DragEvent("dragover", { dataTransfer: dt, bubbles: true, cancelable: true }));
      const over = document.getElementById("cc-compose").classList.contains("dragging") && getComputedStyle(document.getElementById("cc-drop")).display !== "none";
      if (drop) target.dispatchEvent(new DragEvent("drop", { dataTransfer: dt, bubbles: true, cancelable: true }));
      return { over, after: document.getElementById("cc-compose").classList.contains("dragging") };
    }, { files, drop });
    const PNGF = { name: "image.png", type: "image/png", b64: PNG.toString("base64") };
    const PDFF = { name: "Q3 report.pdf", type: "application/pdf", b64: PDF.toString("base64") };
    const chips = (page) => page.evaluate(() => [...document.querySelectorAll("#cc-att .cc-chip")].map((c) => ({ cls: c.className, name: c.querySelector(".nm").textContent, st: c.querySelector(".st").textContent, img: !!c.querySelector(".th img") && c.querySelector(".th img").complete && c.querySelector(".th img").naturalWidth > 0, x: c.querySelector(".x").getAttribute("aria-label") })));
    const settle = (page) => page.waitForFunction(() => !window.__joyaCC.S.att.some((a) => a.state === "queued" || a.state === "up"), null, { timeout: 8000 }).catch(() => {});

    section("the composer in the browser: paste, drop, chips, send");
    {
      const v = await open(1440, 900);
      const p = v.page;
      const vis = () => p.evaluate(() => [...document.getElementById("cc-compose").querySelectorAll("button")].filter((b) => b.offsetParent && !b.closest(".cc-target-menu, .cc-att")).map((b) => b.id));
      const lay = await p.evaluate(() => {
        const q = (id) => document.getElementById(id);
        const r = (id) => q(id).getBoundingClientRect();
        const cs = getComputedStyle(q("cc-compose"));
        return { field: q("cc-input").tagName, ph: q("cc-input").placeholder, att: r("cc-attach").width, mic: r("cc-c-mic").width, h: r("cc-compose").height, radius: parseFloat(cs.borderTopLeftRadius), w: r("cc-compose").width,
          oneRow: Math.abs(r("cc-input").top + r("cc-input").height / 2 - (r("cc-c-mic").top + r("cc-c-mic").height / 2)) < 4,
          names: [...q("cc-compose").querySelectorAll("button")].filter((b) => b.offsetParent).every((b) => (b.getAttribute("aria-label") || b.textContent.trim()) && b.title), hint: q("cc-hint").getBoundingClientRect().height };
      });
      const order0 = await vis();
      check("one pill-shaped bar (56 px tall, radius = half, at most 768 wide), on one row: +, the message, the voice chip, the round button", lay.field === "TEXTAREA" && lay.ph === "Ask JOYA AI" && lay.h === 56 && lay.radius === 28 && lay.w <= 768 && lay.oneRow && JSON.stringify(order0) === JSON.stringify(["cc-attach", "cc-vm", "cc-c-mic"]), JSON.stringify([lay, order0]));
      check("  every control 44 px, named, with a tooltip; nothing under the bar at rest", lay.att === 44 && lay.mic === 44 && lay.names && lay.hint === 0, JSON.stringify(lay));
      const roundIs = () => p.evaluate(() => ["cc-c-mic", "cc-send", "cc-stop"].filter((id) => document.getElementById(id).offsetParent));
      check("the round button with an empty field is the live conversation (the waveform)", JSON.stringify(await roundIs()) === '["cc-c-mic"]');
      await shot(p, "idle-1440-light");
      // Shift+Enter: a new line; the field grows.
      await p.click("#cc-input");
      const h0 = await p.evaluate(() => document.getElementById("cc-input").getBoundingClientRect().height);
      await p.keyboard.type("First line");
      await p.keyboard.press("Shift+Enter");
      await p.keyboard.type("second line");
      await p.keyboard.press("Shift+Enter");
      await p.keyboard.type("third line");
      const v1 = await p.evaluate(() => ({ v: document.getElementById("cc-input").value, h: document.getElementById("cc-input").getBoundingClientRect().height }));
      check("Shift+Enter starts a new line (nothing sent); the field grows upward with it, the buttons stay at the bottom", v1.v === "First line\nsecond line\nthird line" && v1.h > h0 + 30 && sup.turns.length === n0, JSON.stringify([h0, v1]));
      check("  with text, the round button is send (the arrow)", JSON.stringify(await roundIs()) === '["cc-send"]');
      await shot(p, "typing-1440-light");
      await p.evaluate(() => { const i = document.getElementById("cc-input"); i.value += "\n4\n5\n6\n7\n8\n9\n10"; i.dispatchEvent(new Event("input", { bubbles: true })); });
      const v2 = await p.evaluate(() => { const i = document.getElementById("cc-input"); return { h: i.getBoundingClientRect().height, sc: i.scrollHeight > i.clientHeight, ov: getComputedStyle(i).overflowY }; });
      check("  up to about six lines, then it scrolls inside", v2.h <= 170 && v2.h >= 140 && v2.sc && v2.ov === "auto", JSON.stringify(v2));
      await p.evaluate(() => { const i = document.getElementById("cc-input"); i.value = "Hello"; i.dispatchEvent(new Event("input", { bubbles: true })); });
      // Enter while an input method composes: no send.
      const ime = await p.evaluate(() => { const ev = new KeyboardEvent("keydown", { key: "Enter", isComposing: true, bubbles: true, cancelable: true }); document.getElementById("cc-input").dispatchEvent(ev); return ev.defaultPrevented; });
      await sleep(300);
      check("Enter while an input method is composing (IME) does not send", !ime && sup.turns.length === n0);
      // Paste a screenshot.
      const prevented = await pasteFiles(p, [PNGF]);
      await settle(p);
      let c = await chips(p);
      check("paste of an image (the clipboard's screenshot): attached, named 'Pasted image <date>.png', a preview, its size", prevented && c.length === 1 && /^Pasted image \d{4}-\d{2}-\d{2} [\d.]+\.png$/.test(c[0].name) && c[0].img && /\bdone\b/.test(c[0].cls) && /B$/.test(c[0].st), JSON.stringify(c));
      const keptText = await pasteFiles(p, [PNGF], "some copied text");
      check("  a paste that also carries text pastes the text (an office copy), nothing attached", !keptText && (await chips(p)).length === 1);
      // Drag over, then drop.
      const d1 = await dragFiles(p, [PDFF], false);
      await shot(p, "dragover-1440-light");
      const d2 = await dragFiles(p, [PDFF], true);
      await settle(p);
      c = await chips(p);
      check("dragging files over the Command Center lights the field ('Drop files to attach them'); the drop attaches them", d1.over && !d2.after && c.length === 2 && c[1].name === "Q3 report.pdf" && /\bdone\b/.test(c[1].cls) && !c[1].img, JSON.stringify([d1, d2, c]));
      check("  each chip's remove button names its file", c[0].x === "Remove " + c[0].name && c[1].x === "Remove Q3 report.pdf");
      await sleep(120);
      const live = await p.evaluate(() => document.getElementById("cc-att-live").textContent);
      check("  progress and results are announced (aria-live)", /attached/.test(live), live);
      await shot(p, "attach2-1440-light");
      // A refused one: an .exe dropped.
      await dragFiles(p, [{ name: "tool.exe", type: "application/x-msdownload", b64: Buffer.from("MZ").toString("base64") }], true);
      const refused = await p.evaluate(() => ({ hint: document.getElementById("cc-hint").textContent, live: document.getElementById("cc-att-live").textContent, n: window.__joyaCC.S.att.length, typed: document.getElementById("cc-input").value }));
      check("a refused file is said in words (the line under the field and aria-live); the typed text stays", /Not attached: tool\.exe/.test(refused.hint) && refused.n === 2 && refused.typed === "Hello", JSON.stringify(refused));
      // A server refusal (a PNG that is a program): the chip says why; what was typed stays.
      await pasteFiles(p, [{ name: "trick.png", type: "image/png", b64: Buffer.from("MZ\x90\x00").toString("base64") }]);
      await settle(p);
      c = await chips(p);
      check("an upload the server refuses: an error chip says why; the typed message is untouched", c.length === 3 && /\berr\b/.test(c[2].cls) && /program/.test(c[2].st) && (await p.inputValue("#cc-input")) === "Hello", JSON.stringify(c));
      // Remove by keyboard: Tab to the error chip's button, Enter.
      await p.focus('#cc-att .cc-chip:nth-child(3) .x');
      await p.keyboard.press("Enter");
      const afterRm = await p.evaluate(() => ({ n: document.querySelectorAll("#cc-att .cc-chip").length, focus: document.activeElement && (document.activeElement.getAttribute("aria-label") || document.activeElement.id) }));
      check("  removed with the keyboard; focus goes to the next chip's button (never lost)", afterRm.n === 2 && /^Remove /.test(afterRm.focus), JSON.stringify(afterRm));
      // Enter sends, with the files.
      await p.focus("#cc-input");
      await p.keyboard.press("End");
      await p.keyboard.press("Shift+Enter");
      await p.keyboard.type("look at both");
      await p.keyboard.press("Enter");
      await p.waitForFunction((n) => true, n0).catch(() => {});
      for (let i = 0; i < 40 && sup.turns.length === n0; i++) await sleep(100);
      const t3 = sup.turns[sup.turns.length - 1];
      const s3 = t3 ? ML.splitAttached(t3.text) : { files: [] };
      check("Enter sends: the (fake) supervisor gets the typed lines and both files' paths", sup.turns.length === n0 + 1 && s3.text === "Hello\nlook at both" && s3.files.length === 2 && s3.files.every((f) => fs.existsSync(f.path) && f.path.startsWith(fs.realpathSync(UPLOADS))) && s3.files[0].type === "image/png", t3 && t3.text);
      await sleep(400);
      const cleared = await p.evaluate(() => ({ v: document.getElementById("cc-input").value, h: document.getElementById("cc-input").getBoundingClientRect().height, n: document.querySelectorAll("#cc-att .cc-chip").length, hidden: document.getElementById("cc-att").hidden }));
      check("  after the send: the field empty and back to one line, the chips gone", cleared.v === "" && cleared.h <= h0 + 1 && cleared.n === 0 && cleared.hidden, JSON.stringify([h0, cleared]));
      // While JOYA AI works and the field is empty: the round button is stop.
      await p.evaluate(() => { const S = window.__joyaCC.S; let st = S.status || {}; window.__busy = true; Object.defineProperty(S, "status", { configurable: true, get: () => Object.assign({}, st, window.__busy ? { busy: true } : {}), set: (v) => { st = v || {}; } }); document.dispatchEvent(new Event("joya-shell-full")); });
      await sleep(150);
      const rs = await roundIs();
      check("while a turn runs and the field is empty, the round button is stop (a square)", JSON.stringify(rs) === '["cc-stop"]', JSON.stringify([rs, await p.evaluate(() => ({ v: document.getElementById("cc-input").value, att: window.__joyaCC.S.att.map((a) => a.state), busy: window.__joyaCC.S.status && window.__joyaCC.S.status.busy, sheet: document.querySelector(".cc-sheet.open") ? 1 : 0 }))]));
      await shot(p, "running-1440-light");
      await p.keyboard.type("x");
      check("  typing while it runs brings send back (a message queues)", JSON.stringify(await roundIs()) === '["cc-send"]');
      await p.fill("#cc-input", "");
      await p.evaluate(() => { window.__busy = false; document.dispatchEvent(new Event("joya-shell-full")); });
      // The Conversation shows them.
      await p.evaluate(() => window.__joyaCC.openSheet ? window.__joyaCC.openSheet("conv") : document.querySelector('[data-sheet="conv"]').click());
      await sleep(700);
      const conv = await p.evaluate((id) => {
        const t = document.querySelector('.cc-turn[data-turn="' + id + '"]');
        if (!t) return null;
        return { bubble: (t.querySelector(".cc-msg.me .cc-bubble") || {}).textContent, ws: t.querySelector(".cc-msg.me .cc-bubble") && getComputedStyle(t.querySelector(".cc-msg.me .cc-bubble")).whiteSpace, files: [...t.querySelectorAll(".cc-sent-att li")].map((li) => ({ t: li.textContent, img: !!li.querySelector("img") && li.querySelector("img").naturalWidth > 0, href: (li.querySelector("a") || {}).getAttribute && li.querySelector("a").getAttribute("href") })), raw: /\[Attached file:/.test(t.textContent) };
      }, t3 && t3.id);
      check("the Conversation shows the sent message with its line break and its files: an image thumbnail, the PDF by name, each a link", conv && conv.bubble === "Hello\nlook at both" && conv.ws === "pre-wrap" && conv.files.length === 2 && conv.files[0].img && /Q3 report\.pdf/.test(conv.files[1].t) && conv.files.every((f) => /^\/joya-ai\/api\/uploads\//.test(f.href)) && !conv.raw, JSON.stringify(conv));
      await v.close();
    }

    section("Enter in the @ picker picks a session; a failed send keeps everything");
    {
      const v = await open(1440, 900);
      const p = v.page;
      await p.click("#cc-input");
      await p.keyboard.press("@");
      await sleep(200);
      const m = await p.evaluate(() => ({ open: !!document.querySelector(".cc-target-menu"), focus: document.activeElement && document.activeElement.getAttribute("data-t"), items: [...document.querySelectorAll(".cc-target-menu button[data-t]")].map((b) => b.getAttribute("data-t")) }));
      await p.keyboard.press("ArrowDown");
      const pick = await p.evaluate(() => document.activeElement.getAttribute("data-t"));
      const n1 = sup.turns.length;
      await p.keyboard.press("Enter");
      await sleep(300);
      const after = await p.evaluate(() => ({ target: window.__joyaCC.S.target, open: !!document.querySelector(".cc-target-menu"), focus: document.activeElement.id, label: document.getElementById("cc-target-label").textContent }));
      const chip = await p.evaluate(() => { const t = document.getElementById("cc-target"); return !!t.offsetParent && t.getBoundingClientRect().height >= 36; });
      check("typing @ opens the session picker; Enter picks the highlighted session (nothing is sent); the chosen session shows in the bar", m.open && m.items.length > 1 && pick && pick !== "auto" && after.target === pick && !after.open && after.focus === "cc-input" && sup.turns.length === n1 && /→/.test(after.label) && chip, JSON.stringify([m, pick, after, chip]));
      await p.click("#cc-attach");
      await sleep(150);
      const plus = await p.evaluate(() => [...document.querySelectorAll("#cc-pop [data-attach]")].map((b) => b.getAttribute("data-attach")));
      await p.click('#cc-pop [data-attach="session"]');
      await sleep(150);
      const viaPlus = await p.evaluate(() => !!document.querySelector(".cc-target-menu") && document.activeElement.hasAttribute("data-t"));
      check("the + menu: Upload a file, Upload a photo, Address a session (which opens the same picker)", JSON.stringify(plus) === '["file","photo","session"]' && viaPlus, JSON.stringify(plus));
      await p.keyboard.press("Escape");
      // A send that fails (JOYA AI unreachable): the text and the files stay.
      await p.route(/\/joya-ai\/api\/send$/, (route) => route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "JOYA AI is not reachable." }) }));
      await pasteFiles(p, [PNGF]);
      await settle(p);
      await p.fill("#cc-input", "keep me\nplease");
      await p.focus("#cc-input");
      await p.keyboard.press("Enter");
      await sleep(500);
      const kept = await p.evaluate(() => ({ v: document.getElementById("cc-input").value, n: document.querySelectorAll("#cc-att .cc-chip.done").length, hint: document.getElementById("cc-hint").textContent }));
      check("a send that fails keeps the typed message and the attached file; the reason is said", kept.v === "keep me\nplease" && kept.n === 1 && /Not sent: JOYA AI is not reachable/.test(kept.hint), JSON.stringify(kept));
      await v.close();
    }

    section("the mic, in both themes");
    const lum = (rgb) => { const m = String(rgb).match(/[\d.]+/g).map(Number); const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }; return 0.2126 * f(m[0]) + 0.7152 * f(m[1]) + 0.0722 * f(m[2]); };
    const ratio = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
    for (const theme of ["light", "dark"]) {
      for (const [w, h] of [[1440, 900], [390, 844]]) {
        const v = await open(w, h, { theme });
        const p = v.page;
        const mic = await p.evaluate(() => { const b = document.getElementById("cc-c-mic"), f = document.getElementById("cc-compose"); const cs = getComputedStyle(b); return { color: cs.color, bg: cs.backgroundColor, field: getComputedStyle(f).backgroundColor, off: b.classList.contains("off"), title: b.title, w: b.getBoundingClientRect().width, opacity: cs.opacity }; });
        if (w === 1440) check(theme + ": the live-conversation button: a filled ink disc on the field (>= 7:1), its waveform at full contrast on it (21:1), 'Start a live conversation'", !mic.off && ratio(mic.color, mic.bg) >= 20 && ratio(mic.bg, mic.field) >= 7 && mic.opacity === "1" && mic.title === "Start a live conversation", JSON.stringify(mic) + " " + ratio(mic.color, mic.bg).toFixed(1));
        const tag = (w === 1440 ? "1440" : "390") + "-" + theme;
        if (w === 390) {
          const ph = await p.evaluate(() => ({ sw: document.documentElement.scrollWidth, w: innerWidth, small: [...document.querySelectorAll("#cc-compose button")].filter((b) => b.offsetParent && !b.closest(".cc-target-menu")).filter((b) => { const r = b.getBoundingClientRect(); return r.width < 44 || r.height < 44; }).map((b) => b.id), comp: document.getElementById("cc-compose").getBoundingClientRect().toJSON() }));
          check(theme + " at 390 px: no horizontal scroll, every control 44 px, the field inside the screen", ph.sw <= ph.w && !ph.small.length && ph.comp.left >= 8 && ph.comp.right <= ph.w - 8, JSON.stringify(ph));
        }
        if (!(w === 1440 && theme === "light")) {
          await shot(p, "idle-" + tag);
          await p.fill("#cc-input", "Summarise what the customs session did this morning\nand what is left for today");
          await shot(p, "typing-" + tag);
          await p.fill("#cc-input", "");
          await p.evaluate(() => { const S = window.__joyaCC.S; let st = S.status || {}; window.__busy = true; Object.defineProperty(S, "status", { configurable: true, get: () => Object.assign({}, st, window.__busy ? { busy: true } : {}), set: (v) => { st = v || {}; } }); document.dispatchEvent(new Event("joya-shell-full")); });
          await shot(p, "running-" + tag);
          await p.evaluate(() => { window.__busy = false; document.dispatchEvent(new Event("joya-shell-full")); });
          await pasteFiles(p, [PNGF]);
          await dragFiles(p, [PDFF], true);
          await settle(p);
          await p.fill("#cc-input", "What does this screenshot say about the Q3 report?");
          if (w === 390) {
            const ph2 = await p.evaluate(() => ({ sw: document.documentElement.scrollWidth, w: innerWidth }));
            check(theme + " at 390 px with two attachments: still no horizontal scroll", ph2.sw <= ph2.w, JSON.stringify(ph2));
          }
          await shot(p, "attach2-" + tag);
          await dragFiles(p, [PDFF], false);
          await shot(p, "dragover-" + tag);
          await p.evaluate(() => document.dispatchEvent(new DragEvent("drop", { dataTransfer: new DataTransfer(), bubbles: true, cancelable: true })));
        }
        // In a call: the page's own live state (no microphone in a headless browser), painted as the call paints it.
        const call = await p.evaluate(() => {
          const d = document.getElementById("cc-dock"), m = document.getElementById("cc-c-mic");
          d.classList.add("live-on", "voice-on"); d.setAttribute("data-live", "listening");
          document.getElementById("cc-live-end").hidden = false; document.getElementById("cc-live-acts").hidden = false;
          document.getElementById("cc-vb-text").textContent = "Listening — just talk";
          m.classList.add("live"); m.setAttribute("aria-pressed", "true");
          const cs = getComputedStyle(m), end = getComputedStyle(document.getElementById("cc-live-end"));
          return { micBg: cs.backgroundColor, micFg: cs.color, endBg: end.backgroundColor, endFg: end.color, bar: getComputedStyle(document.getElementById("cc-voicebar")).display, text: document.getElementById("cc-vb-text").textContent };
        });
        if (w === 1440) check(theme + ": in a call: the voice bar says 'Listening' in words; the end button and a live mic are filled red with a white glyph (>= 3:1)", call.bar === "flex" && /Listening/.test(call.text) && ratio(call.endBg, call.endFg) >= 3 && ratio(call.micBg, call.micFg) >= 3, JSON.stringify(call));
        await shot(p, "listening-" + tag);
        await v.close();
      }
    }

    section("voice off: the mic says why");
    db.setSetting("voice_desk", "off", "test");
    for (const theme of ["light", "dark"]) {
      for (const [w, h] of [[1440, 900], [390, 844]]) {
        const v = await open(w, h, { theme });
        const p = v.page;
        const o = await p.evaluate(() => { const b = document.getElementById("cc-mic-off"); if (!b) return null; const cs = getComputedStyle(b); return { live: !!document.getElementById("cc-c-mic"), dis: b.getAttribute("aria-disabled"), title: b.title, label: b.getAttribute("aria-label"), why: document.getElementById(b.getAttribute("aria-describedby")).textContent, color: cs.color, bg: getComputedStyle(document.getElementById("cc-compose")).backgroundColor, border: cs.borderTopStyle, chip: document.getElementById("cc-mic-mode").textContent, w: b.getBoundingClientRect().width }; });
        if (w === 1440) check(theme + ": voice off: the struck-through waveform (dashed ring, legible >= 4.5:1), aria-disabled, its reason as tooltip and description", o && !o.live && o.dis === "true" && /Voice is off: switch it on in JOYA AI Settings ▸ Voice/.test(o.title) && o.why === o.title && o.border === "dashed" && ratio(o.color, o.bg) >= 4.5 && o.w === 44 && o.chip === "Voice off", JSON.stringify(o));
        if (w === 1440 && theme === "light") {
          await p.click("#cc-mic-off", { force: true });
          await sleep(200);
          const said = await p.evaluate(() => ({ hint: document.getElementById("cc-hint").textContent, link: (document.querySelector("#cc-hint a") || {}).getAttribute && document.querySelector("#cc-hint a").getAttribute("href"), live: document.getElementById("cc-att-live").textContent }));
          check("  a click says it in words, with the link to switch it on (and to screen readers)", /Voice is off/.test(said.hint) && said.link === "/joya-ai/settings/voice" && /Voice is off/.test(said.live), JSON.stringify(said));
        }
        await shot(p, "voiceoff-" + (w === 1440 ? "1440" : "390") + "-" + theme);
        await v.close();
      }
    }
    db.setSetting("voice_desk", "on", "test");

    section("the desktop app's render mode");
    {
      const ctx = await browser.newContext({ viewport: { width: 480, height: 860 }, userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36 Edg/129.0.0.0 JoyaDesktop/0.1.11", extraHTTPHeaders: { "X-Forwarded-Proto": "https" } });
      await ctx.addCookies(String(A.cookie).split("; ").filter(Boolean).map((kv) => ({ name: kv.split("=")[0], value: kv.slice(kv.indexOf("=") + 1), url: ORIGIN })));
      const page = await ctx.newPage();
      page.on("pageerror", (e) => problems.push("desk: pageerror " + e.message));
      await page.goto(ORIGIN + "/joya-ai?shell=desktop&mode=floating", { waitUntil: "load" });
      await sleep(800);
      await page.evaluate(() => { const b = document.getElementById("dk-chatbtn"); if (b) b.click(); });
      await sleep(300);
      const d = await page.evaluate(() => { const q = (id) => document.getElementById(id); const vis = (id) => !!q(id) && !!q(id).offsetParent; return { attach: vis("cc-attach"), target: vis("cc-target"), vm: vis("cc-vm"), field: q("cc-input").tagName, inPanel: !!q("cc-compose").closest("#dk-panel-dock") }; });
      check("the desktop app's chat keeps the composer: the field, the attach button (picker and paste work in WebView2); @ and the voice menu stay hidden there", d.field === "TEXTAREA" && d.attach && !d.target && !d.vm && d.inPanel, JSON.stringify(d));
      await page.fill("#cc-input", "from the desktop");
      await page.keyboard.press("Shift+Enter");
      const dv = await page.inputValue("#cc-input");
      check("  Shift+Enter there is a new line too", dv === "from the desktop\n", JSON.stringify(dv));
      await ctx.close();
    }
  } catch (e) {
    if (e) { failed++; console.log("  FAIL (threw) " + (e && e.stack)); }
  } finally {
    if (problems.length) { failed++; console.log("  FAIL page problems:\n       " + problems.slice(0, 20).join("\n       ")); }
    else if (browser) { passed++; console.log("  ok   no page errors, no CSP violations"); }
    if (browser) await browser.close();
    if (s) s.stop();
    sup.close();
    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
  }
})();
