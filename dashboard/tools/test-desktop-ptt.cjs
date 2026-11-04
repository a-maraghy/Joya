#!/usr/bin/env node
"use strict";
/**
 * The desktop app's hold-to-talk, end to end: the app's hotkey arrives as a
 * Tauri event (joya://ptt {down}) -- not a click, so the page has no user
 * activation -- and must reach the live relay as audio.
 *
 *     NODE_PATH=/opt/joya-dashboard/node_modules PLAYWRIGHT=/path/to/node_modules/playwright \
 *       node dashboard/tools/test-desktop-ptt.cjs
 *
 * A scratch copy of the real server.js (tools/scratch-server.cjs) whose live
 * relay talks to a mock OpenAI realtime server here (JOYA_OPENAI_WS), headless
 * Chromium with a fake microphone (a tone), and Tauri's bridge stood in for
 * (window.__TAURI__ with an event bus the test fires; the page is driven over
 * CDP with userGesture false, as the app's events reach it). Checked:
 *   - the 0.1.1 failure, reproduced and fixed: the first press opens the call,
 *     which takes a second or two; a key released before it was ready gave a
 *     call that showed "listening" and heard nothing (the press was only made
 *     at "ready" if the key was still down). Now the press is made at once and
 *     what is said while the call opens is sent when it is ready, then committed;
 *   - held: audio while held, the key-up commits and never hangs up, nothing
 *     between presses, a second press in the same call;
 *   - tapped (up at once): it latches until the next press, which sends it;
 *   - Esc ends it as "esc"; the server log names the hold-to-talk mode.
 */
const scratch = require("./scratch-server.cjs"); // first: sets JOYA_DATA_DIR
const path = require("path");
const http = require("http");
const { WebSocketServer } = require("ws");

const ROOT = path.join(__dirname, "..");
const APP_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36 Edg/129.0.0.0 JoyaDesktop/0.1.2";

let passed = 0;
let failed = 0;
function check(name, cond, detail) {
  if (cond) {
    passed++;
    console.log("  ok   " + name);
  } else {
    failed++;
    console.log("  FAIL " + name + (detail !== undefined ? "\n       " + String(detail).slice(0, 800) : ""));
  }
}
const section = (t) => console.log("\n" + t);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms) {
  const end = Date.now() + (ms || 5000);
  while (Date.now() < end) {
    if (await fn()) return true;
    await sleep(25);
  }
  return false;
}

/* A mock realtime server: counts the audio appended and records the rest. */
const mock = { sessions: [], delay: 0 };
function mockServer() {
  const server = http.createServer((q, s) => (s.writeHead(404), s.end()));
  const wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", (req, sock, head) => {
    if (String(req.headers.authorization || "") !== "Bearer " + scratch.FAKE_KEY) {
      sock.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      return sock.destroy();
    }
    wss.handleUpgrade(req, sock, head, (ws) => {
      const s = { ws, events: [], audioBytes: 0, appends: 0, closed: false, update: null };
      s.push = (o) => ws.readyState === 1 && ws.send(JSON.stringify({ event_id: "ev" + Math.random().toString(36).slice(2), ...o }));
      ws.on("close", () => (s.closed = true));
      ws.on("message", (d) => {
        const ev = JSON.parse(String(d));
        if (ev.type === "input_audio_buffer.append") {
          s.appends++;
          s.audioBytes += Buffer.from(String(ev.audio || ""), "base64").length;
          return;
        }
        s.events.push(ev);
        if (ev.type === "session.update" && !s.update) {
          s.update = ev.session;
          setTimeout(() => s.push({ type: "session.updated", session: ev.session }), mock.delay || 0);
        }
        ev.at = Date.now();
        if (ev.type === "input_audio_buffer.commit") s.push({ type: "input_audio_buffer.committed", item_id: "item_" + s.events.length, previous_item_id: null });
        // A response: created, a little audio with its transcript, done (enough for the server's timing line).
        if (ev.type === "response.create") {
          const id = "resp_" + s.events.length;
          setTimeout(() => s.push({ type: "response.created", response: { id } }), 120);
          setTimeout(() => s.push({ type: "response.output_item.added", item: { id: "out_" + id, type: "message" } }), 160);
          setTimeout(() => s.push({ type: "response.output_audio.delta", item_id: "out_" + id, delta: Buffer.alloc(4800).toString("base64") }), 220);
          setTimeout(() => s.push({ type: "response.output_audio_transcript.done", item_id: "out_" + id, transcript: "Okay." }), 260);
          setTimeout(() => s.push({ type: "response.done", response: { id, output: [{ type: "message", content: [{ transcript: "Okay." }] }] } }), 300);
        }
      });
      mock.sessions.push(s);
    });
  });
  return server;
}

(async () => {
  const PW = process.env.PLAYWRIGHT || "playwright";
  const { chromium } = require(PW);
  const ms = mockServer();
  await new Promise((r) => ms.listen(0, "127.0.0.1", r));
  const s = await scratch.startScratch({ env: { JOYA_OPENAI_WS: "ws://127.0.0.1:" + ms.address().port + "/v1", JOYA_OPENAI_IPV4: "0" } });
  const db = require(path.join(ROOT, "lib", "db.js"));
  const errs = [];
  try {
    db.setSetting("voice_desk", "on", "test"); // the scratch database, never the live one
    await s.makeUser("pttadmin", "administrator");
    const { cookie } = await s.signIn("pttadmin");
    const SITE = "http://127.0.0.1:" + s.port;

    async function open(wavFile) {
      const browser = await chromium.launch({ args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"].concat(wavFile ? ["--use-file-for-fake-audio-capture=" + wavFile] : []) });
      const ctx = await browser.newContext({ viewport: { width: 480, height: 860 }, userAgent: APP_UA, extraHTTPHeaders: { "X-Forwarded-Proto": "https" } });
      await ctx.grantPermissions(["microphone"], { origin: SITE });
      await ctx.addCookies(String(cookie).split("; ").filter(Boolean).map((kv) => ({ name: kv.split("=")[0], value: kv.slice(kv.indexOf("=") + 1), url: SITE })));
      // Tauri's bridge: invoke answers nothing; events come from the test (as the app's hotkey handler emits them).
      await ctx.addInitScript(() => {
        const L = {};
        window.__calls = [];
        window.__wsIn = [];
        const WS = window.WebSocket;
        window.WebSocket = function (u, p) { const w = new WS(u, p); w.addEventListener("message", (e) => window.__wsIn.push(typeof e.data === "string" ? e.data : "<bin " + (e.data.byteLength || e.data.size) + ">")); return w; };
        window.WebSocket.prototype = WS.prototype; window.WebSocket.OPEN = 1;
        window.__emit = (name, payload) => (L[name] || []).forEach((f) => f({ payload }));
        // The AudioContexts the page makes (the test suspends one to see the pill tell the truth).
        const AC = window.AudioContext;
        window.__ctxs = [];
        window.AudioContext = function (o) { const c = new AC(o); window.__ctxs.push(c); return c; };
        window.AudioContext.prototype = AC.prototype;
        window.__TAURI__ = {
          core: { invoke: (cmd, args) => { window.__calls.push(cmd); return Promise.resolve(null); } },
          event: { listen: (name, f) => { (L[name] = L[name] || []).push(f); return Promise.resolve(() => {}); } },
        };
      });
      const page = await ctx.newPage();
      page.on("pageerror", (e) => errs.push(e.message));
      page.on("console", (m) => { const t = m.text(); if ((m.type() === "error" && !/Failed to load resource|net::ERR|503|502|EventSource/.test(t)) || /Content Security Policy|Refused to/.test(t)) errs.push(t); });
      await page.goto(SITE + "/joya-ai?shell=desktop&mode=floating", { waitUntil: "load" });
      await page.waitForTimeout(600);
      // Playwright's page.evaluate runs as a user gesture; the app's events are not one. So the page is
      // driven through CDP with userGesture false, as the hotkey's event reaches it.
      page.cdp = await ctx.newCDPSession(page);
      page.run = async (fn, arg) => {
        const r = await page.cdp.send("Runtime.evaluate", { expression: "(" + fn.toString() + ")(" + JSON.stringify(arg === undefined ? null : arg) + ")", userGesture: false, returnByValue: true, awaitPromise: true });
        if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails));
        return r.result.value;
      };
      // The scratch copy has no supervisor (offline); the pill would say so. Online, as on a real machine.
      await page.run(() => { const S = window.__joyaCC && window.__joyaCC.S; if (S) S.online = true; const o = document.getElementById("cc-offline"); if (o) o.hidden = true; });
      return { browser, page };
    }
    // The app's event: {down, at (its clock, ms since 1970), seq}; o.at / o.seq override (late, out of order).
    let appSeq = 0;
    const ptt = (page, down, o) => { o = o || {}; const seq = o.seq != null ? o.seq : ++appSeq; if (o.seq != null) appSeq = Math.max(appSeq, o.seq); return page.run((p) => window.__emit("joya://ptt", p), { down, at: o.at != null ? o.at : Date.now(), seq }); };
    const live = async (page) => { await page.run(() => { const S = window.__joyaCC && window.__joyaCC.S; if (S) S.online = true; }); await sleep(250); return liveNow(page); };
    const liveNow = (page) => page.run(() => ({ active: !!(window.VoiceLive && window.VoiceLive.active()), state: window.VoiceLive && window.VoiceLive.state(), latched: !!(window.__joyaLive.latched && window.__joyaLive.latched()), held: !!window.__joyaLive.held(), mic: window.VoiceLive && window.VoiceLive.micState ? window.VoiceLive.micState() : null, pill: (document.getElementById("cc-cap-label") || {}).textContent, bar: (document.getElementById("cc-vb-text") || {}).textContent, resting: !!(window.VoiceLive.resting && window.VoiceLive.resting()), note: [].map.call(document.querySelectorAll(".cc-toast"), (t) => t.textContent).join(" | ") }));

    const commits = (ses) => ses.events.filter((e) => e.type === "input_audio_buffer.commit").length;
    const pttOn = (ses) => ses.events.filter((e) => e.type === "input_audio_buffer.clear").length; // the server clears the buffer on each press (pttDown)

    section("the 0.1.1 failure: the key goes up before the call is ready (the first press is what opens it)");
    {
      // OpenAI takes 1.5 s to answer here; the key is held for 0.9 s while the call opens.
      mock.delay = 1500;
      const { browser, page } = await open();
      const n0 = mock.sessions.length;
      await ptt(page, true);
      await sleep(900);
      await ptt(page, false);
      await until(() => mock.sessions.length > n0 && mock.sessions[mock.sessions.length - 1].update, 8000);
      const ses = mock.sessions[mock.sessions.length - 1];
      const committed = await until(() => commits(ses) >= 1, 4000);
      const st = await live(page);
      check("the server honours turn=ptt: the realtime session has no voice detection", ses.update && ses.update.audio && ses.update.audio.input && ses.update.audio.input.turn_detection === null, JSON.stringify(ses.update && ses.update.audio));
      check("what was said while it opened reaches the realtime session, then the turn is committed (0.1.1: no press reached the server, nothing was heard)", committed && pttOn(ses) >= 1 && ses.audioBytes > 12000, "bytes " + ses.audioBytes + " events " + JSON.stringify(ses.events.map((e) => e.type)));
      check("  the server log shows the turn (state talking, then thinking), and the call stays open", st.active && /talking/.test(await page.run(() => (window.__wsIn || []).join(" "))), JSON.stringify(st));
      await page.run(() => window.__joyaLive.end("esc"));
      await sleep(300);
      mock.delay = 0;
      await browser.close();
    }

    section("hold Ctrl+Space (the hotkey's events only, no click in the page)");
    {
      const { browser, page } = await open();
      const n0 = mock.sessions.length;
      await ptt(page, true);
      await until(() => mock.sessions.length > n0 && mock.sessions[mock.sessions.length - 1].update, 8000);
      const ses = mock.sessions[mock.sessions.length - 1];
      const moved = await until(() => ses.audioBytes > 48000, 6000); // > 1 s of 24 kHz PCM16
      const st = await live(page);
      check("while the key is held the microphone's audio reaches the realtime session", moved, JSON.stringify(st) + " bytes " + ses.audioBytes + " appends " + ses.appends);
      check("  the state pill says Listening while the key is held", /listen/i.test(st.pill || ""), JSON.stringify(st));
      const before = ses.audioBytes;
      await ptt(page, false);
      const committed = await until(() => commits(ses) >= 1, 3000);
      check("  key-up commits the turn (input_audio_buffer.commit)", committed, JSON.stringify(ses.events.map((e) => e.type)));
      await sleep(1200);
      const after = ses.audioBytes;
      const st2 = await live(page);
      check("  key-up does not hang up: the call stays warm for the next press", st2.active && !ses.closed, JSON.stringify(st2));
      check("  and between presses nothing is relayed", after - before < 24000, after - before);
      const b2 = ses.audioBytes;
      await ptt(page, true);
      await until(() => ses.audioBytes > b2 + 24000, 4000);
      await ptt(page, false);
      const two = await until(() => commits(ses) >= 2, 3000);
      check("  a second press in the same call: audio, then a second commit", two && ses.audioBytes > b2 + 24000, ses.audioBytes - b2);

      section("a tap of the key (up at once, as a hotkey that reports its release immediately would): it latches");
      const b3 = ses.audioBytes, c3 = commits(ses);
      await ptt(page, true);
      await sleep(60);
      await ptt(page, false);
      await sleep(1500);
      const st3 = await live(page);
      check("after a tap JOYA AI keeps listening: audio moves, no commit yet, the key counts as held", ses.audioBytes > b3 + 48000 && commits(ses) === c3 && st3.latched && st3.held, JSON.stringify(st3) + " bytes " + (ses.audioBytes - b3));
      check("  and the page says how to send it", /pause to send/.test(st3.note), JSON.stringify(st3));
      await ptt(page, true);
      const sent = await until(() => commits(ses) === c3 + 1, 3000);
      await ptt(page, false); // that press's own key-up: nothing more
      await sleep(400);
      const st4 = await live(page);
      check("  the next press sends it (one commit), its key-up does nothing more, the call stays", sent && commits(ses) === c3 + 1 && !st4.latched && st4.active, JSON.stringify(st4));

      await page.run(() => window.__joyaLive.end("esc"));
      await until(() => ses.closed, 3000);
      check("Esc ends it (why esc; only the red X is 'button')", ses.closed && /ended \(hung-up: esc\)/.test(s.out()), s.out().split("\n").filter((l) => /live/.test(l)).slice(-4).join(" / "));
      check("  the server's log names the turn mode", /started: hold-to-talk,/.test(s.out()), s.out().split("\n").filter((l) => /started:/.test(l)).join(" / "));
      await browser.close();
    }
    section("the app's events late, out of order, or with an up lost (timestamps and order from the app)");
    {
      const { browser, page } = await open();
      const out0 = s.out().length;
      // Down and up handed over together, 1.5 s late: judged by the app's clock, a hold -- not a latched tap.
      const t = Date.now();
      await ptt(page, true, { at: t - 1500 });
      await ptt(page, false, { at: t });
      await sleep(300);
      let st = await liveNow(page);
      check("down and up delivered together but 1.5 s apart by the app's clock: a hold, not a tap (no latch, nothing left held)", !st.latched && !st.held, JSON.stringify(st));
      await until(() => /press \d+: held/.test(s.out().slice(out0)), 6000);
      // Out of order: an up numbered after a down that arrives later -- the late down is dropped.
      const k = 1000;
      await ptt(page, false, { seq: k + 2 });
      await ptt(page, true, { seq: k + 1 });
      await sleep(300);
      st = await liveNow(page);
      check("  an up numbered after a down that arrives later: the stale down is dropped, nothing held", !st.held && !st.latched, JSON.stringify(st));
      // An up that never arrives: the next down ends the turn instead of being ignored.
      const ses0 = mock.sessions[mock.sessions.length - 1];
      const c0 = commits(ses0);
      await ptt(page, true);
      await until(() => ses0.audioBytes > 0, 3000);
      await sleep(1200);
      await ptt(page, true);
      const ended = await until(() => commits(ses0) > c0, 3000);
      st = await liveNow(page);
      check("  a second down with no up between (the up was lost): it ends the turn (committed), nothing stuck", ended && !st.held, JSON.stringify(st) + " commits " + commits(ses0));
      await ptt(page, false); // that down's own up: nothing more

      section("response time: where a turn's time goes, logged per turn");
      const ses = mock.sessions[mock.sessions.length - 1];
      const r0 = ses.events.filter((e) => e.type === "response.create").length;
      await ptt(page, true);
      await sleep(700);
      await ptt(page, false);
      await until(() => ses.events.filter((e) => e.type === "response.create").length > r0, 5000);
      const commit = ses.events.filter((e) => e.type === "input_audio_buffer.commit").pop();
      const create = ses.events.filter((e) => e.type === "response.create").pop();
      const lag = create && commit ? create.at - commit.at : null;
      check("a held turn: response.create follows the commit at once (no wait for its transcript)", lag != null && lag < 300, "commit→create " + lag + " ms");
      const tl = await until(() => /turn \d+ \(hold-to-talk\): release→commit \d+ ms, →response \d+ ms, →first model audio \d+ ms, →first audio played \d+ ms/.test(s.out()), 4000);
      check("  the server logs one timing line per turn: release→commit, →response, →first model audio, →first audio played", tl, s.out().split("\n").filter((l) => /turn \d+/.test(l)).slice(-3).join(" / "));
      const pl = s.out().split("\n").filter((l) => /press \d+: held \d+ ms, \d+ frames/.test(l));
      check("  and one line per press: how long, how many frames and how much audio came from the page", pl.length >= 3 && pl.some((l) => /committed/.test(l)) && pl.every((l) => !/[a-z]{3,} [a-z]{3,} [a-z]{3,} said/i.test(l)), pl.slice(-3).join(" / "));
      check("  nothing is sent between presses while the call is warm (0 frames between presses, every press)", pl.length >= 3 && pl.every((l) => / 0 frames between presses/.test(l)), pl.join(" / "));

      section("states while warm: Ready to talk between presses, Listening only while held");
      let w = null;
      await until(async () => /Ready to talk/.test((w = await live(page)).pill || "") && /Hold Ctrl\+Space to talk/.test(w.bar || ""), 5000);
      check("key up, the call warm: the pill reads 'Ready to talk' (not Ready, not Listening) and the bar 'Hold Ctrl+Space to talk'", /Ready to talk/.test(w.pill || "") && /Hold Ctrl\+Space to talk/.test(w.bar || "") && !/Listening/.test(w.bar || ""), JSON.stringify(w));
      await ptt(page, true);
      await until(async () => /release to send/.test((w = await live(page)).bar || ""), 2000);
      check("  key held: the bar says 'Listening — release to send'", /Listening — release to send/.test(w.bar || ""), JSON.stringify(w));
      await ptt(page, false);
      await sleep(200);

      section("the pill tells the truth: Listening only while audio flows");
      await ptt(page, true);
      await until(async () => (await liveNow(page)).mic && (await liveNow(page)).mic.ok, 3000);
      let lv = null;
      await until(async () => /Listening/.test((lv = await live(page)).pill || ""), 3000);
      check("key held, frames flowing: the pill says Listening", /Listening/.test(lv.pill || "") && lv.mic.ok, JSON.stringify(lv));
      await page.run(() => Promise.all(window.__ctxs.map((c) => (c.state === "running" ? c.suspend() : null))));
      await sleep(700);
      // (the scratch copy keeps falling offline -- no supervisor -- so the pill is read until online)
      await until(async () => /Mic not ready/.test((lv = await live(page)).pill || ""), 3000);
      check("  audio stops (the AudioContext suspended): the pill says Mic not ready, and why", /Mic not ready/.test(lv.pill || "") && lv.mic && !lv.mic.ok, JSON.stringify(lv));
      await page.run(() => Promise.all(window.__ctxs.map((c) => (c.state === "suspended" ? c.resume() : null))));
      await sleep(700);
      await until(async () => /Listening/.test((lv = await live(page)).pill || ""), 3000);
      check("  audio back: Listening again", /Listening/.test(lv.pill || ""), JSON.stringify(lv));
      await ptt(page, false);
      await sleep(300);
      section("the microphone is closed after 10 s warm, and opened again by the next press");
      const sesR = mock.sessions[mock.sessions.length - 1];
      await sleep(10600);
      let r = await liveNow(page);
      check("10 s after the last press: the microphone is closed (resting; no track open, no frames)", r.resting && r.mic && r.mic.why === "resting", JSON.stringify(r));
      const cR = commits(sesR), bR = sesR.audioBytes;
      await ptt(page, true);
      const woke = await until(async () => (await liveNow(page)).mic.ok, 3000);
      await sleep(600);
      await ptt(page, false);
      await until(() => commits(sesR) > cR, 3000);
      check("  the next press opens it again: audio flows, the turn is committed", woke && sesR.audioBytes > bR + 12000 && commits(sesR) > cR, "bytes " + (sesR.audioBytes - bR));
      const o1 = s.out().length;
      await page.run(() => window.__joyaLive.end("esc"));
      await until(() => /page report: /.test(s.out().slice(o1)), 3000);
      const repLine = (s.out().slice(o1).split("\n").find((l) => /page report: /.test(l)) || "");
      let rep = null;
      try { rep = JSON.parse(repLine.slice(repLine.indexOf("page report: ") + 13)); } catch (e) { rep = null; }
      check("the call's end carries the page's report (counts and times only): key downs and ups with the app's clock, frames in and sent, the AudioContext", rep && rep.in > 0 && rep.sent > 0 && rep.ring.some((e) => e.k === "down" && e.app > 1e12) && rep.ring.some((e) => e.k === "up") && rep.ring.every((e) => typeof e.ctx === "string"), repLine.slice(0, 600));
      await browser.close();
    }

    section("a tap latches, then the turn sends itself after a pause (speech then quiet, from a file)");
    {
      // 1.2 s of speech-like bursts, then 2.8 s of near silence, looped by the fake microphone.
      const RATE_ = 48000, wavPath = path.join(scratch.DATA, "speech-pause.wav");
      const n = RATE_ * 4, pcm = Buffer.alloc(n * 2);
      for (let i = 0; i < n; i++) {
        const t = i / RATE_;
        let v = (Math.random() - 0.5) * 0.002;
        if (t < 1.2 && (t * 1000) % 180 < 120) v += 0.35 * (Math.sin(2 * Math.PI * 220 * t) + 0.6 * Math.sin(2 * Math.PI * 440 * t) + 0.3 * Math.sin(2 * Math.PI * 660 * t)) / 1.9;
        pcm.writeInt16LE(Math.max(-32767, Math.min(32767, Math.round(v * 32767))), i * 2);
      }
      const h = Buffer.alloc(44);
      h.write("RIFF", 0); h.writeUInt32LE(36 + pcm.length, 4); h.write("WAVE", 8); h.write("fmt ", 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
      h.writeUInt32LE(RATE_, 24); h.writeUInt32LE(RATE_ * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write("data", 36); h.writeUInt32LE(pcm.length, 40);
      require("fs").writeFileSync(wavPath, Buffer.concat([h, pcm]));
      const { browser, page } = await open(wavPath);
      const n0 = mock.sessions.length;
      await ptt(page, true);
      await sleep(80);
      await ptt(page, false);
      await until(() => mock.sessions.length > n0 && mock.sessions[mock.sessions.length - 1].update, 8000);
      const ses = mock.sessions[mock.sessions.length - 1];
      const st0 = await liveNow(page);
      const sent = await until(() => commits(ses) >= 1, 9000);
      const st1 = await liveNow(page);
      check("tapped: it latches (listening), then sends the turn by itself after the speaker pauses -- no second press", st0.latched && sent && !st1.latched && !st1.held && ses.audioBytes > 24000, JSON.stringify({ st0, st1, bytes: ses.audioBytes, commits: commits(ses) }));
      await page.run(() => window.__joyaLive.end("esc"));
      await sleep(300);
      await browser.close();
    }
    check("zero page errors and CSP violations", errs.length === 0, errs.join("\n"));
  } catch (e) {
    check("the run completed", false, e.stack + "\n" + s.out().slice(-3000));
  } finally {
    s.stop();
    ms.close();
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.log("  FAIL no exception\n" + e.stack);
  process.exit(1);
});
