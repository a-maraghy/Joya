#!/usr/bin/env node
"use strict";
/**
 * A live call end to end on the REAL OpenAI API, in headless Chromium: the real Command Center page (its
 * audio worklet, player and detector), the real server.js on a scratch copy, the real live call class
 * (GPT-Live or the realtime one, as Settings ▸ Voice would choose), real speech (synthesized clips played
 * into the page's microphone) -- with only two stand-ins: a local relay that forwards the scratch copy's
 * OpenAI traffic with the panel's real key (the copy only holds a fake one), and a fake JOYA AI that answers
 * each hand-off with a canned reply after REPLY_MS.
 *
 *     NODE_PATH=/opt/joya-dashboard/node_modules PLAYWRIGHT=/path/to/node_modules/playwright \
 *       node dashboard/tools/e2e-live-browser.cjs [gpt-live-1|gpt-realtime-2.1-mini] [--json out.json]
 *
 * Costs real money (~$0.05-0.10 a run). Never prints the key. Clips: CLIPS (default the scratchpad set) as
 * 24 kHz PCM16 files <id>.pcm. Measured, in the page (Date.now()): end of speech -> first loud audio the page
 * received; the hand-off's reply -> its first loud audio; a barge-in: start of speech -> the page's flush,
 * and -> the last loud audio of the interrupted utterance. Checks: the call is ready, small talk is answered,
 * the request reaches JOYA AI (as GPT-Live's own transcript on GPT-Live, this server's on the realtime model),
 * the reply is heard, the long answer is spoken as a detailed summary, a barge-in flushes the page,
 * no page errors, and the key never appears in the server's output.
 */
const scratch = require("./scratch-server.cjs"); // first: sets JOYA_DATA_DIR
const path = require("path");
const fs = require("fs");
const net = require("net");
const http = require("http");
const https = require("https");
const WebSocket = require("ws");
const { WebSocketServer } = WebSocket;

const ROOT = path.join(__dirname, "..");
const MODEL = process.argv[2] && !process.argv[2].startsWith("--") ? process.argv[2] : "gpt-live-1";
const JSON_OUT = (() => { const i = process.argv.indexOf("--json"); return i > 0 ? process.argv[i + 1] : null; })();
const CLIPS = process.env.CLIPS || "/tmp/claude-0/-root-joya/adde23b9-58bb-44da-9db3-e78c9b1f8f8e/scratchpad/gl/clips";
const REPLY_MS = 2500;
let passed = 0, failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log("  ok   " + name); }
  else { failed++; console.log("  FAIL " + name + (detail !== undefined ? "\n       " + String(detail).slice(0, 700) : "")); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms) { const end = Date.now() + (ms || 5000); while (Date.now() < end) { if (await fn()) return true; await sleep(50); } return false; }

let KEY = null;
function key() {
  if (!KEY) KEY = JSON.parse(require("child_process").execFileSync("/usr/local/sbin/joya-helper", ["voice-key-read"], { stdio: ["ignore", "pipe", "ignore"] }).toString()).data.key;
  return KEY;
}

/* ------------------------------------------------ the relay to OpenAI (the real key, never logged) --- */
function relay() {
  const server = http.createServer((q, s) => {
    if (String(q.headers.authorization || "") !== "Bearer " + scratch.FAKE_KEY) return s.writeHead(401), s.end();
    const headers = { ...q.headers, authorization: "Bearer " + key(), host: "api.openai.com" };
    delete headers["content-length"];
    const chunks = [];
    q.on("data", (c) => chunks.push(c));
    q.on("end", () => {
      const body = Buffer.concat(chunks);
      if (body.length) headers["content-length"] = body.length;
      const up = https.request({ host: "api.openai.com", path: q.url, method: q.method, headers, family: 4 }, (r) => {
        s.writeHead(r.statusCode, r.headers);
        r.pipe(s);
      });
      up.on("error", () => (s.writeHead(502), s.end()));
      up.end(body);
    });
  });
  const wss = new WebSocketServer({ noServer: true });
  const log = [];
  server.on("upgrade", (req, sock, head) => {
    if (String(req.headers.authorization || "") !== "Bearer " + scratch.FAKE_KEY) return sock.destroy();
    wss.handleUpgrade(req, sock, head, (down) => {
      const up = new WebSocket("wss://api.openai.com" + req.url, { headers: { Authorization: "Bearer " + key() }, perMessageDeflate: false, family: 4 });
      const q = [];
      up.on("open", () => { for (const m of q.splice(0)) up.send(m); });
      down.on("message", (d, bin) => { const m = bin ? d : String(d); if (up.readyState === 1) up.send(m); else q.push(m); });
      up.on("message", (d) => {
        const s = String(d);
        try { const ev = JSON.parse(s); if (/delegation\.created|transcript\.delta|commentary|usage/.test(ev.type)) log.push({ at: Date.now(), type: ev.type, delta: ev.delta }); } catch (_) { /* audio */ }
        if (down.readyState === 1) down.send(s);
      });
      up.on("close", () => { try { down.close(); } catch (_) { /* gone */ } });
      down.on("close", () => { try { up.close(); } catch (_) { /* gone */ } });
      up.on("error", () => { try { down.close(); } catch (_) { /* gone */ } });
    });
  });
  return { server, log };
}

/* ------------------------------------------------ a fake JOYA AI: canned replies ---------------------- */
function fakeSupervisor(sock, replies) {
  const turns = new Map();
  let next = 900;
  const asks = [];
  const warms = [];
  // The event stream (2026-10-30): the turn and its result, as the real supervisor sends them, so the
  // Command Center has the reply to put on screen while the call says it (public/joya-ai.js callReply).
  const subs = new Set();
  let seq = 10;
  const push = (type, data) => { const line = JSON.stringify({ event: { seq: ++seq, ts: new Date().toISOString(), type, ...data } }) + "\n"; for (const c of subs) if (!c.destroyed) c.write(line); };
  const server = net.createServer((c) => {
    let buf = "";
    c.setEncoding("utf8");
    c.on("data", (d) => {
      buf += d;
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        let m;
        try { m = JSON.parse(line); } catch (_) { continue; }
        if (m.op === "events") { subs.add(c); c.on("close", () => subs.delete(c)); continue; } // kept open: turn events pushed
        let data = {};
        if (m.op === "status") data = { name: "JOYA AI", seq: 1, process: { state: "ready", pid: 100 }, approvals: [], counts: {} };
        else if (m.op === "send") {
          const id = ++next;
          const r = replies.find((x) => x.match.test(m.text)) || { reply: "I couldn't find anything about that." };
          turns.set(id, { at: Date.now(), reply: r.reply });
          asks.push({ at: Date.now(), text: m.text, call: m.call });
          const row = { id, source: "voice-desk", actor: m.actor, text: m.text, status: "queued", created_at: new Date().toISOString(), call_id: m.call || null, lane: "work" };
          data = { turn: { id, status: "queued" } };
          setTimeout(() => push("turn", { phase: "queued", turn: row }), 20);
          setTimeout(() => push("turn", { phase: "start", turn: { ...row, status: "running", started_at: new Date().toISOString() } }), 60);
          setTimeout(() => {
            const done = { ...row, status: "done", started_at: row.created_at, ended_at: new Date().toISOString(), result_text: r.reply, duration_ms: REPLY_MS };
            push("result", { turn: done });
            push("turn", { phase: "end", turn: done });
          }, Math.max(100, REPLY_MS - 50));
        } else if (m.op === "snapshot") {
          data = { machine: {}, services: {}, requests_to_joya_ai: (m.turns || []).map((id) => { const t = turns.get(id); return { id, answered: !!t && Date.now() - t.at >= REPLY_MS, reply: t ? t.reply : "" }; }) };
        } else if (m.op === "voice-warm") { warms.push(m.call); data = { warmed: true, lanes: [] }; }
        else if (m.op === "sessions") data = { sessions: [] };
        else if (m.op === "missions") data = { missions: [] };
        else if (m.op === "decisions") data = { decisions: [] };
        else if (m.op === "ledger") data = { rows: [] };
        if (!c.destroyed) c.write(JSON.stringify({ id: m.id, ok: true, data }) + "\n");
      }
    });
    c.on("error", () => {});
  });
  return new Promise((res) => server.listen(sock, () => res({ close: () => server.close(), asks, warms })));
}

function speech(pcm) {
  let s = null, e = 0;
  for (let i = 0; i + 960 <= pcm.length; i += 960) { let m = 0; for (let j = i; j < i + 960; j += 2) m = Math.max(m, Math.abs(pcm.readInt16LE(j))); if (m > 1500) { if (s == null) s = i / 48; e = (i + 960) / 48; } }
  return { start: s || 0, end: e };
}

(async () => {
  const { chromium } = require(process.env.PLAYWRIGHT || "playwright");
  const R = relay();
  await new Promise((r) => R.server.listen(0, "127.0.0.1", r));
  const port = R.server.address().port;
  const sock = path.join(require("os").tmpdir(), "e2e-live-sup-" + process.pid + ".sock");
  const sup = await fakeSupervisor(sock, [
    { match: /restart/i, reply: "The dashboard restarted at 02:14 last night because a deploy ran. It has been up since then and nothing is wrong." },
    { match: /disk|ديسك|مساحة/i, reply: "There are 41 GB free on the main disk, out of 200 GB. The biggest folder is the Odoo filestore at 62 GB, then the backups at 38 GB, then the Postgres data at 31 GB. The logs take about 4 GB. Nothing needs to be done today." },
  ]);
  const db = require(path.join(ROOT, "lib", "db.js"));
  db.setSetting("voice_desk", "on", "test");
  db.setSetting("voice_model", MODEL, "test");
  const s = await scratch.startScratch({ env: { JOYA_OPENAI_WS: "ws://127.0.0.1:" + port + "/v1", JOYA_OPENAI_HTTP: "http://127.0.0.1:" + port + "/v1", JOYA_AI_SOCKET: sock, JOYA_OPENAI_IPV4: "0" }, fakeVoiceOptions: true });
  const out = { model: MODEL, turns: [], results: [], barge: null };
  let browser = null;
  const errs = [];
  try {
    await s.makeUser("e2eadmin", "administrator");
    const { cookie } = await s.signIn("e2eadmin");
    const SITE = "http://127.0.0.1:" + s.port;
    browser = await chromium.launch({ args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", "--autoplay-policy=no-user-gesture-required"] });
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 }, extraHTTPHeaders: { "X-Forwarded-Proto": "https" }, permissions: ["microphone"] });
    await ctx.addCookies(String(cookie).split("; ").filter(Boolean).map((kv) => ({ name: kv.split("=")[0], value: kv.slice(kv.indexOf("=") + 1), url: SITE })));
    await ctx.addInitScript(() => {
      try { localStorage.setItem("joya-live-duplex", "full"); } catch (e) { /* none */ }
      // The room: the page's microphone hears low noise and the clips (headphones: never the voice itself).
      const md = navigator.mediaDevices, orig = md.getUserMedia.bind(md);
      const Rm = (window.__room = { ctx: null, bus: null });
      function room() {
        if (Rm.ctx) return Rm;
        Rm.ctx = new AudioContext({ sampleRate: 48000 });
        Rm.bus = Rm.ctx.createGain();
        const nb = Rm.ctx.createBuffer(1, 96000, 48000), d = nb.getChannelData(0);
        for (let i = 0; i < d.length; i++) d[i] = (Math.random() - 0.5) * 0.004;
        const ns = Rm.ctx.createBufferSource(); ns.buffer = nb; ns.loop = true; ns.connect(Rm.bus); ns.start();
        return Rm;
      }
      md.getUserMedia = (c) => {
        if (!c || !c.audio || c.video) return orig(c);
        room();
        const dst = Rm.ctx.createMediaStreamDestination();
        Rm.bus.connect(dst);
        return Promise.resolve(dst.stream);
      };
      window.__say = (b64) => {
        room();
        const bin = atob(b64), n = bin.length / 2, buf = Rm.ctx.createBuffer(1, n, 24000), ch = buf.getChannelData(0);
        for (let i = 0; i < n; i++) { let v = bin.charCodeAt(2 * i) | (bin.charCodeAt(2 * i + 1) << 8); if (v >= 32768) v -= 65536; ch[i] = v / 32768; }
        const src = Rm.ctx.createBufferSource(); src.buffer = buf; src.connect(Rm.bus); src.start();
        return Date.now();
      };
      // What the page receives on the live socket: audio frames (time, loudness) and messages.
      window.__in = [];
      const WSo = window.WebSocket;
      window.WebSocket = function (u, p) {
        const w = new WSo(u, p);
        if (/\/api\/live/.test(String(u))) {
          w.addEventListener("message", (ev) => {
            if (typeof ev.data === "string") { try { const m = JSON.parse(ev.data); window.__in.push({ at: Date.now(), m: { type: m.type, who: m.who, text: m.text, state: m.state } }); } catch (e) { /* not json */ } return; }
            const handle = (ab) => { const v = new DataView(ab); let ss = 0, n = 0; for (let i = 4; i + 1 < ab.byteLength; i += 2) { const x = v.getInt16(i, true); ss += x * x; n++; } window.__in.push({ at: Date.now(), bytes: ab.byteLength - 4, rms: n ? Math.sqrt(ss / n) : 0 }); };
            if (ev.data instanceof ArrayBuffer) handle(ev.data); else if (ev.data && ev.data.arrayBuffer) ev.data.arrayBuffer().then(handle);
          });
        }
        return w;
      };
      window.__out = [];
      const sendO = WSo.prototype.send;
      window.__mic = [];
      WSo.prototype.send = function (d) {
        if (/\/api\/live/.test(this.url)) {
          if (typeof d === "string") window.__out.push({ at: Date.now(), m: d.slice(0, 120) });
          else { try { const ab = d.buffer ? d.buffer.slice(d.byteOffset, d.byteOffset + d.byteLength) : d; const v = new DataView(ab); let ss = 0, n = 0; for (let i = 0; i + 1 < ab.byteLength; i += 2) { const x = v.getInt16(i, true); ss += x * x; n++; } window.__mic.push({ at: Date.now(), n: ab.byteLength, rms: Math.round(n ? Math.sqrt(ss / n) : 0) }); if (window.__mic.length > 4000) window.__mic.shift(); } catch (e) { /* not audio */ } }
        }
        return sendO.call(this, d);
      };
      window.WebSocket.prototype = WSo.prototype; window.WebSocket.OPEN = 1; window.WebSocket.CONNECTING = 0; window.WebSocket.CLOSING = 2; window.WebSocket.CLOSED = 3;
    });
    const page = await ctx.newPage();
    page.on("pageerror", (e) => errs.push(e.message));
    page.on("console", (m) => { const t = m.text(); if ((m.type() === "error" && !/Failed to load resource|net::ERR|503|502|EventSource/.test(t)) || /Content Security Policy|Refused to/.test(t)) errs.push(t); });
    await page.goto(SITE + "/joya-ai", { waitUntil: "load" });
    await page.waitForTimeout(1500);
    await page.evaluate(() => setInterval(() => { const S = window.__joyaCC && window.__joyaCC.S; if (S) S.online = true; }, 200));
    const okLive = await page.evaluate(() => window.__joyaLive && window.__joyaLive.ok && window.__joyaLive.ok());
    check(`[${MODEL}] the page offers the live call`, !!okLive);
    await page.evaluate(() => window.__joyaLive.toggle());
    const ready = await until(() => page.evaluate(() => window.__in.some((x) => x.m && x.m.type === "ready")), 15000);
    check(`[${MODEL}] the call is ready`, ready, JSON.stringify(await page.evaluate(() => window.__in.filter((x) => x.m).slice(-5))));
    await sleep(1500);
    const say = async (id) => {
      const pcm = fs.readFileSync(path.join(CLIPS, id + ".pcm"));
      const sp = speech(pcm);
      const at = await page.evaluate((b) => window.__say(b), pcm.toString("base64"));
      const r = { id, at, startAt: at + sp.start, endAt: at + sp.end, ms: pcm.length / 48 };
      (out.clips = out.clips || []).push(r);
      return r;
    };
    // Quiet: no loud audio for `ms` (the answer has been said).
    const quietFor = async (ms, max) => until(async () => { const last = await page.evaluate(() => { const l = window.__in.filter((x) => x.rms > 300).pop(); return l ? l.at : 0; }); return Date.now() - last > ms; }, max || 20000);
    const firstLoud = async (from) => {
      const xs = await page.evaluate((f) => window.__in.filter((x) => x.at >= f && x.rms > 300).map((x) => x.at), from);
      return xs.length ? xs[0] - from : null;
    };
    // 1. small talk
    let c = await say("en_hi");
    await sleep(c.ms + 6000);
    out.turns.push({ clip: "en_hi", ms: await firstLoud(c.endAt) });
    const caps = () => page.evaluate(() => window.__in.filter((x) => x.m && x.m.type === "caption").map((x) => x.m.who + ": " + x.m.text));
    check(`[${MODEL}] small talk is answered (audio within 5 s of the end of speech)`, out.turns[0].ms != null && out.turns[0].ms < 5000, JSON.stringify(out.turns[0]) + " " + JSON.stringify(await caps()));
    // 2. a request: to JOYA AI, then its answer
    c = await say("en_why");
    const asked0 = sup.asks.length;
    await until(() => sup.asks.length > asked0, c.ms + 12000);
    out.turns.push({ clip: "en_why", ms: await firstLoud(c.endAt) });
    const ask = sup.asks[asked0];
    // GPT-Live: its own input transcript is the request (2026-10-30); the realtime model: this server's (gpt-4o-transcribe).
    check(`[${MODEL}] the request reaches JOYA AI as ${MODEL === "gpt-live-1" ? "GPT-Live's own transcript (no transcription model)" : "this server's transcript"}`, ask && /check why the dashboard service restarted last night/i.test(ask.text) && !/\[Voice:/.test(ask.text), ask && ask.text);
    if (ask) {
      // the reply, then its first sound, then quiet (the whole answer said)
      await until(() => page.evaluate((f) => window.__in.some((x) => x.m && x.m.type === "replied" && x.at >= f), ask.at), REPLY_MS + 8000);
      const repAt0 = await page.evaluate((f) => (window.__in.find((x) => x.m && x.m.type === "replied" && x.at >= f) || {}).at || 0, ask.at);
      await until(async () => (await firstLoud(repAt0)) != null, 10000);
      await quietFor(2000, 25000);
      const rep = await page.evaluate((f) => (window.__in.find((x) => x.m && x.m.type === "replied" && x.at >= f) || {}).at || null, ask.at);
      out.results.push({ clip: "en_why", ms: rep ? await firstLoud(rep) : null });
      const cs = await caps();
      check(`[${MODEL}] JOYA AI's answer is heard (02:14, a deploy)`, rep && out.results[0].ms != null && cs.some((t) => /02:14|2:14/.test(t)), JSON.stringify(out.results[0]) + " " + JSON.stringify(cs.slice(-6)));
      // 2026-10-30: the call's own JOYA AI sessions are started at call start, the hand-off says what is on screen,
      // and the reply the voice is saying is ON the screen (the reply panel), and the page tells the server so.
      check(`[${MODEL}] the call asked the supervisor to start its own JOYA AI sessions (voice-warm with the call id)`, sup.warms.length >= 1 && /^lv[a-z0-9]+$/.test(sup.warms[0]) && ask && ask.call === sup.warms[0], JSON.stringify({ warms: sup.warms, call: ask && ask.call }));
      check(`[${MODEL}] the hand-off carries the Joya page in view (the Command Center), after the words`, ask && /\n\n\[Screen: the administrator is looking at the Joya page "Command Center" \(\/joya-ai\)/.test(ask.text), ask && ask.text);
      const shown = await page.evaluate(() => { const r = document.getElementById("cc-reply"); return { visible: !!r && !r.hidden && r.getBoundingClientRect().height > 20, text: r ? r.textContent : "" }; });
      check(`[${MODEL}] the reply the voice is saying is on screen in full (the reply panel opened by the call)`, shown.visible && /02:14/.test(shown.text) && /nothing is wrong/.test(shown.text), JSON.stringify(shown).slice(0, 300));
      const told = await page.evaluate(() => window.__out.some((x) => /"type":"reply-shown"/.test(x.m)));
      check(`[${MODEL}] and the page told the call it is shown ({type: "reply-shown"})`, told);
    }
    // 3. a barge-in: a long answer, talked over
    await quietFor(1500, 10000);
    c = await say("en_disk");
    const asked1 = sup.asks.length;
    await until(() => sup.asks.length > asked1, c.ms + 12000);
    const rep2 = await until(() => page.evaluate(() => window.__in.filter((x) => x.m && x.m.type === "replied").length >= 2), REPLY_MS + 6000);
    if (rep2) {
      // wait for the answer to be audible, then talk over it
      const repAt = await page.evaluate(() => window.__in.filter((x) => x.m && x.m.type === "replied")[1].at);
      await until(async () => (await firstLoud(repAt)) != null, 6000);
      // The long answer (five sentences) is a detailed summary: let its first sentences be said before talking over it.
      await until(async () => (await caps()).some((t) => /^joya: /.test(t) && /41/.test(t)), 9000);
      out.results.push({ clip: "en_disk", ms: await firstLoud(repAt), summaryMs: (s.out().match(/first summary line (\d+) ms after the reply/g) || []).pop() || null });
      const cs2 = await caps();
      check(`[${MODEL}] the long answer is spoken as a detailed summary with its figures (41 GB free), never just "the details are on screen"`, cs2.some((t) => /^joya: /.test(t) && /41/.test(t)) && !cs2.some((t) => /^joya: The details are on screen\.?$/.test(t)), JSON.stringify(cs2.slice(-6)));
      const b = await say("en_stop");
      await sleep(4000);
      const r = await page.evaluate((f) => ({ flush: (window.__in.find((x) => x.m && x.m.type === "flush" && x.at >= f) || {}).at || null, loud: window.__in.filter((x) => x.at >= f && x.rms > 300).map((x) => x.at) }), b.startAt);
      out.barge = { flushMs: r.flush ? r.flush - b.startAt : null };
      check(`[${MODEL}] talking over the answer flushes the page`, r.flush != null && r.flush - b.startAt < 2500, JSON.stringify(out.barge));
    } else check(`[${MODEL}] the second answer arrived`, false);
    out.sent = await page.evaluate(() => window.__out.filter((x) => !/played/.test(x.m)));
    out.mic = await page.evaluate(() => window.__mic);
    out.played = await page.evaluate(() => window.__out.filter((x) => /played/.test(x.m)).map((x) => ({ at: x.at, m: x.m })));
    // Underruns: the player stopped ("playing" false) and started again within one utterance (its segment).
    out.voiceDiag = await page.evaluate(() => (window.VoiceLive && window.VoiceLive.diag ? window.VoiceLive.diag() : null));
    out.inbox = await page.evaluate(() => window.__in.filter((x) => x.m));
    await page.evaluate(() => window.__joyaLive.end("button"));
    await sleep(1500);
    check(`[${MODEL}] no page errors`, errs.length === 0, errs.join("\n"));
    check(`[${MODEL}] the key never appears in the server's output`, !s.out().includes(key()));
    const lines = s.out().split("\n").filter((l) => /live: call|gpt-live|guard cut|barge|asked→reply|result handed/.test(l));
    out.serverLog = lines.slice(-40);
  } catch (e) {
    check("the run finished", false, e.stack);
  } finally {
    if (browser) await browser.close();
    s.stop();
    sup.close();
    R.server.close();
    console.log(JSON.stringify({ turns: out.turns, results: out.results, barge: out.barge }));
    if (process.env.E2E_LOG) for (const l of out.serverLog || []) console.log("    " + l.slice(0, 220));
    if (JSON_OUT) fs.writeFileSync(JSON_OUT, JSON.stringify(out, null, 1));
    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
  }
})();
