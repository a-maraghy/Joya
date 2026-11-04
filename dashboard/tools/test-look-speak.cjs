#!/usr/bin/env node
"use strict";
/**
 * Look and speak, end to end, with real speech (2026-10-21: "the face is identified but it does not handle
 * identifying the speech well, slow, inaccurate").
 *
 *     NODE_PATH=/opt/joya-dashboard/node_modules PLAYWRIGHT=/path/to/node_modules/playwright \
 *       node dashboard/tools/test-look-speak.cjs [--report] [--n 6] [--transcribe] [--json out.json]
 *
 * The real camera module (joya-presence.js) on a stand-in face model (a face looking at the bot, its jaw
 * moving), the real voice path (joya-ai.js lookTalk -> voice-live.js -> this server's live relay) to a mock
 * OpenAI realtime server, and a "room": every microphone the page opens (getUserMedia, audio) hears the same
 * live sound -- low noise, and a speech clip played at a chosen moment. What was said before a microphone was
 * open is lost, as in a real room; opening one takes GUM_MS (a real device: ~0.1-0.4 s).
 *
 * Measured per clip (Date.now() everywhere):
 *   start of speech -> listening    the turn opened (lookTalk)
 *   end of speech   -> turn sent    the page's {type:"ptt", on:false} (the server commits the turn on it)
 *   clipped start / end             the audio the realtime session got, aligned on the clip (envelope
 *                                   cross-correlation): how much of the speech's start / end is missing
 * --transcribe (needs the real OpenAI key, via joya-helper voice-key-read): that audio, and the clip itself,
 * through gpt-4o-mini-transcribe (the server's transcription model): WER (English) / CER (Arabic).
 *
 * Checks (without --report): speech from a synthetic speaker and, when present, real recorded clips (EN + AR)
 * from LOOK_FIXTURES (default /var/lib/planning_engine_voice/cache: TTS narration, 24 kHz PCM16 + its text):
 * the turn holds the speech's start (the pre-roll) and its end, it is sent within ~1 s of the end of speech,
 * nothing else leaves the page (no face data in any request or WebSocket message).
 */
const scratch = require("./scratch-server.cjs"); // first: sets JOYA_DATA_DIR
const path = require("path");
const fs = require("fs");
const http = require("http");
const { WebSocketServer } = require("ws");

const ROOT = path.join(__dirname, "..");
const APP_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36 Edg/129.0.0.0 JoyaDesktop/0.1.12";
const args = process.argv.slice(2);
const flag = (k) => args.includes(k);
const arg = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const REPORT = flag("--report"), TRANSCRIBE = flag("--transcribe");
const N = +arg("--n", REPORT ? 6 : 1);
const FIXDIR = process.env.LOOK_FIXTURES || "/var/lib/planning_engine_voice/cache";
const GUM_MS = +(process.env.LOOK_GUM_MS || 150); // opening a microphone
const READY_MS = +(process.env.LOOK_READY_MS || 1000); // the realtime session's answer (a real call is ready ~1.2-2.4 s after it starts)
const SAY_AFTER_MS = +(process.env.LOOK_SAY_AFTER || 1800); // the person looks at the bot, then starts talking this much later (armed by then)

let passed = 0, failed = 0;
function check(name, cond, detail) {
  if (cond) { passed++; console.log("  ok   " + name); }
  else { failed++; console.log("  FAIL " + name + (detail !== undefined ? "\n       " + String(detail).slice(0, 900) : "")); }
}
const section = (t) => console.log("\n" + t);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms) { const end = Date.now() + (ms || 5000); while (Date.now() < end) { if (await fn()) return true; await sleep(25); } return false; }

/* ------------------------------------------------------------------ audio helpers (24 kHz PCM16 mono) */
const RATE = 24000;
function readWav(f) {
  const b = fs.readFileSync(f);
  let o = 12, fmt = null, data = null;
  while (o + 8 <= b.length) {
    const id = b.toString("ascii", o, o + 4), n = b.readUInt32LE(o + 4);
    if (id === "fmt ") fmt = { ch: b.readUInt16LE(o + 10), rate: b.readUInt32LE(o + 12), bits: b.readUInt16LE(o + 22) };
    if (id === "data") data = b.subarray(o + 8, o + 8 + n);
    o += 8 + n + (n % 2);
  }
  if (!fmt || !data || fmt.ch !== 1 || fmt.bits !== 16 || fmt.rate !== RATE) return null;
  const s = new Float32Array(data.length / 2);
  for (let i = 0; i < s.length; i++) s[i] = data.readInt16LE(i * 2) / 32768;
  return s;
}
function wav(f32) {
  const pcm = Buffer.alloc(f32.length * 2);
  for (let i = 0; i < f32.length; i++) pcm.writeInt16LE(Math.max(-32767, Math.min(32767, Math.round(f32[i] * 32767))), i * 2);
  const h = Buffer.alloc(44);
  h.write("RIFF", 0); h.writeUInt32LE(36 + pcm.length, 4); h.write("WAVE", 8); h.write("fmt ", 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(RATE, 24); h.writeUInt32LE(RATE * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write("data", 36); h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}
function pcmToF32(buf) { const s = new Float32Array(buf.length / 2); for (let i = 0; i < s.length; i++) s[i] = buf.readInt16LE(i * 2) / 32768; return s; }
const HOP = 240; // 10 ms
function env(x) { const n = Math.floor(x.length / HOP), e = new Float32Array(n); for (let i = 0; i < n; i++) { let s = 0; for (let j = 0; j < HOP; j++) { const v = x[i * HOP + j]; s += v * v; } e[i] = Math.sqrt(s / HOP); } return e; }
/** Where the speech is in a clip: [first, last] 10 ms hop over 6% of the loudest 10 ms. */
function speechSpan(x) {
  const e = env(x); let mx = 0; for (const v of e) mx = Math.max(mx, v);
  const th = mx * 0.06; let a = -1, b = -1;
  for (let i = 0; i < e.length; i++) if (e[i] > th) { if (a < 0) a = i; b = i; }
  return { startMs: a * 10, endMs: (b + 1) * 10 };
}
/** Where `got` starts in `clip` (ms; negative: before it): log-envelope cross-correlation over the speech. */
function align(clip, got) {
  const L = (e) => Array.from(e, (v) => Math.log(v + 3e-4));
  const ec = L(env(clip)), eg = L(env(got));
  let best = -Infinity, bk = 0;
  for (let k = -400; k <= 400; k++) {
    let sxy = 0, sx = 0, sy = 0, sxx = 0, syy = 0, n = 0;
    for (let j = 0; j < eg.length; j++) {
      const i = j + k;
      if (i < 0 || i >= ec.length) continue;
      const x = ec[i], y = eg[j];
      sxy += x * y; sx += x; sy += y; sxx += x * x; syy += y * y; n++;
    }
    if (n < 60) continue;
    const c = (sxy - (sx * sy) / n) / Math.sqrt(Math.max(1e-9, (sxx - (sx * sx) / n) * (syy - (sy * sy) / n)));
    if (c > best) { best = c; bk = k; }
  }
  return { startMs: bk * 10, corr: best };
}
/** A synthetic speaker: words of voiced sound (pitch gliding, syllables as loudness swells), a soft first onset, pauses between words (one longer, mid-sentence). */
function synthSpeech(seed) {
  let r = seed || 7; const rnd = () => ((r = (r * 1103515245 + 12345) % 2147483648) / 2147483648);
  const out = [];
  for (let w = 0; w < 7; w++) {
    const n = Math.floor(RATE * (0.25 + rnd() * 0.35)), f0 = 110 + rnd() * 80, f1 = f0 * (0.8 + rnd() * 0.4), syl = 1 + Math.floor(rnd() * 3);
    let ph = 0;
    for (let i = 0; i < n; i++) {
      const u = i / n, f = f0 + (f1 - f0) * u;
      ph += 2 * Math.PI * f / RATE;
      const edge = Math.min(1, i / (RATE * (w === 0 ? 0.15 : 0.02)), (n - i) / (RATE * 0.02));
      const a = 0.3 * edge * (0.6 + 0.4 * Math.abs(Math.sin(Math.PI * syl * u)));
      out.push(a * (Math.sin(ph) + 0.5 * Math.sin(2 * ph) + 0.25 * Math.sin(3 * ph)) / 1.75);
    }
    const gap = Math.floor(RATE * (w === 3 ? 0.5 : 0.1 + rnd() * 0.12));
    for (let i = 0; i < gap; i++) out.push(0);
  }
  return Float32Array.from(out);
}

/* ------------------------------------------------------------------ fixtures */
function fixtures() {
  // the synthetic speaker twice: after the look has armed look and speak, and talking as they look (900 ms in)
  const out = [{ id: "synthetic", lang: "en", text: null, pcm: synthSpeech(11) }].concat(REPORT ? [] : [{ id: "synthetic-at-once", lang: "en", text: null, pcm: synthSpeech(5), sayAfter: 900 }]);
  let files = [];
  try { files = fs.readdirSync(FIXDIR).filter((f) => f.endsWith(".json")).sort(); } catch (e) { return out; }
  const pick = { en: [], ar: [] };
  for (const f of files) {
    let j = null; try { j = JSON.parse(fs.readFileSync(path.join(FIXDIR, f), "utf8")); } catch (e) { continue; }
    if (!j || !j.ok || !pick[j.lang] || pick[j.lang].length >= N || !(j.seconds >= 2.5 && j.seconds <= 6)) continue;
    const pcm = readWav(path.join(FIXDIR, f.replace(/\.json$/, ".wav")));
    if (pcm) pick[j.lang].push({ id: j.hash || f.slice(0, 20), lang: j.lang, text: j.text, pcm });
  }
  return out.concat(pick.en, pick.ar);
}

/* ------------------------------------------------------------------ accuracy */
function normEn(s) { return String(s || "").toLowerCase().replace(/[^a-z0-9' ]+/g, " ").replace(/\s+/g, " ").trim(); }
function normAr(s) {
  return String(s || "").replace(/[ً-ْٰـ]/g, "").replace(/[إأآا]/g, "ا").replace(/ى/g, "ي").replace(/ة/g, "ه").replace(/ؤ/g, "و").replace(/ئ/g, "ي")
    .replace(/[^ء-يa-zA-Z0-9 ]+/g, " ").replace(/\s+/g, " ").trim().toLowerCase();
}
function lev(a, b) { const m = a.length, n = b.length; let p = Array.from({ length: n + 1 }, (_, j) => j); for (let i = 1; i <= m; i++) { const c = [i]; for (let j = 1; j <= n; j++) c[j] = Math.min(p[j] + 1, c[j - 1] + 1, p[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)); p = c; } return p[n]; }
function errRate(lang, ref, hyp) {
  if (lang === "ar") { const r = normAr(ref).replace(/ /g, ""), h = normAr(hyp).replace(/ /g, ""); return r.length ? lev([...r], [...h]) / r.length : 0; }
  const r = normEn(ref).split(" ").filter(Boolean), h = normEn(hyp).split(" ").filter(Boolean);
  return r.length ? lev(r, h) / r.length : 0;
}
let KEY = null;
function key() {
  if (KEY) return KEY;
  const raw = require("child_process").execFileSync("/usr/local/sbin/joya-helper", ["voice-key-read"], { stdio: ["ignore", "pipe", "ignore"] }).toString();
  KEY = JSON.parse(raw).data.key;
  return KEY;
}
async function transcribe(f32) {
  for (let i = 0; ; i++) { try { return await transcribe1(f32); } catch (e) { if (i >= 3) throw e; await sleep(1500); } }
}
async function transcribe1(f32) {
  const fd = new FormData();
  fd.append("model", "gpt-4o-mini-transcribe");
  fd.append("file", new Blob([wav(f32)], { type: "audio/wav" }), "turn.wav");
  const r = await fetch("https://api.openai.com/v1/audio/transcriptions", { method: "POST", headers: { Authorization: "Bearer " + key() }, body: fd });
  if (!r.ok) throw new Error("transcribe " + r.status);
  return (await r.json()).text || "";
}

/* ------------------------------------------------------------------ the mock realtime server */
const mock = { sessions: [] };
function mockServer() {
  const server = http.createServer((q, s) => (s.writeHead(404), s.end()));
  const wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", (req, sock, head) => {
    if (String(req.headers.authorization || "") !== "Bearer " + scratch.FAKE_KEY) { sock.write("HTTP/1.1 401 Unauthorized\r\n\r\n"); return sock.destroy(); }
    wss.handleUpgrade(req, sock, head, (ws) => {
      const s = { ws, events: [], chunks: [], closed: false, update: null, opened: Date.now() };
      s.push = (o) => ws.readyState === 1 && ws.send(JSON.stringify({ event_id: "ev" + Math.random().toString(36).slice(2), ...o }));
      ws.on("close", () => (s.closed = true));
      ws.on("message", (d) => {
        const ev = JSON.parse(String(d));
        ev.at = Date.now();
        if (ev.type === "input_audio_buffer.append") { s.chunks.push({ at: ev.at, buf: Buffer.from(String(ev.audio || ""), "base64") }); return; }
        if (ev.type === "input_audio_buffer.clear") ev.mark = s.chunks.length;
        if (ev.type === "input_audio_buffer.commit") ev.mark = s.chunks.length;
        s.events.push(ev);
        if (ev.type === "session.update" && !s.update) { s.update = ev.session; setTimeout(() => s.push({ type: "session.updated", session: ev.session }), READY_MS); }
        if (ev.type === "input_audio_buffer.commit") s.push({ type: "input_audio_buffer.committed", item_id: "item_" + s.events.length, previous_item_id: null });
        if (ev.type === "response.create") {
          const id = "resp_" + s.events.length;
          setTimeout(() => s.push({ type: "response.created", response: { id } }), 60);
          setTimeout(() => s.push({ type: "response.output_item.added", item: { id: "out_" + id, type: "message" } }), 80);
          setTimeout(() => s.push({ type: "response.output_audio.delta", item_id: "out_" + id, delta: Buffer.alloc(4800).toString("base64") }), 100);
          setTimeout(() => s.push({ type: "response.output_audio_transcript.done", item_id: "out_" + id, transcript: "Okay." }), 120);
          setTimeout(() => s.push({ type: "response.done", response: { id, output: [{ type: "message", content: [{ transcript: "Okay." }] }] } }), 140);
        }
      });
      mock.sessions.push(s);
    });
  });
  return server;
}
/** The turn the realtime session got: the audio appended between its clear (the press) and its commit. */
function turnAudio(s) {
  const c = s.events.filter((e) => e.type === "input_audio_buffer.commit")[0];
  if (!c) return null;
  const cl = s.events.filter((e) => e.type === "input_audio_buffer.clear" && e.at <= c.at).pop();
  const from = cl ? cl.mark : 0;
  return { pcm: pcmToF32(Buffer.concat(s.chunks.slice(from, c.mark).map((x) => x.buf))), commitAt: c.at };
}

(async () => {
  const PW = process.env.PLAYWRIGHT || "playwright";
  const { chromium } = require(PW);
  const ms = mockServer();
  await new Promise((r) => ms.listen(0, "127.0.0.1", r));
  const s = await scratch.startScratch({ env: { JOYA_OPENAI_WS: "ws://127.0.0.1:" + ms.address().port + "/v1", JOYA_OPENAI_IPV4: "0" } });
  const db = require(path.join(ROOT, "lib", "db.js"));
  const errs = [], results = [];
  let browser = null;
  try {
    db.setSetting("voice_desk", "on", "test"); // the scratch database, never the live one
    await s.makeUser("lookadmin", "administrator");
    const { cookie } = await s.signIn("lookadmin");
    const SITE = "http://127.0.0.1:" + s.port;
    browser = await chromium.launch({ args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", "--autoplay-policy=no-user-gesture-required"] });
    const ctx = await browser.newContext({ viewport: { width: 480, height: 860 }, userAgent: APP_UA, extraHTTPHeaders: { "X-Forwarded-Proto": "https" }, permissions: ["camera", "microphone"] });
    await ctx.addCookies(String(cookie).split("; ").filter(Boolean).map((kv) => ({ name: kv.split("=")[0], value: kv.slice(kv.indexOf("=") + 1), url: SITE })));
    const reqs = [];
    ctx.on("request", (r) => { const b = r.postDataBuffer(); reqs.push({ url: r.url(), body: b ? b.toString("latin1") : "" }); });
    const HOST = { mode: "floating", size: "M", peekOpen: true, glance: false, presence: { camera: true, speak: true, releaseOnSaver: true, onBattery: false, energySaver: false, locked: false, meeting: false, inUse: false } };
    await ctx.addInitScript((a) => {
      // Tauri's bridge (the desktop app): its state turns camera presence + look and speak on.
      const Lz = {};
      window.__TAURI__ = { core: { invoke: (cmd) => Promise.resolve(cmd === "get_state" ? a.host : null) }, event: { listen: (n, f) => { (Lz[n] = Lz[n] || []).push(f); return Promise.resolve(() => {}); } } };
      // A stand-in face model: each camera frame answers window.__faces() (the worker's own summary records).
      const RW = window.Worker;
      window.__faces = () => [];
      window.Worker = function (url, opts) {
        if (!/joya-presence-worker/.test(String(url))) return new RW(url, opts);
        const w = { onmessage: null, dead: false, terminate() { w.dead = true; }, postMessage(m) {
          if (w.dead || !m) return;
          if (m.type === "init") setTimeout(() => { if (!w.dead && w.onmessage) w.onmessage({ data: { type: "ready" } }); }, 10);
          else if (m.type === "frame") { if (m.bmp && m.bmp.close) m.bmp.close(); const f = window.__faces(); setTimeout(() => { if (!w.dead && w.onmessage) w.onmessage({ data: { type: "faces", faces: f, ms: 3 } }); }, 5); }
        } };
        return w;
      };
      // The room: every microphone opened hears the same live sound (noise, and a clip played at a set time).
      const md = navigator.mediaDevices, orig = md.getUserMedia.bind(md);
      const R = (window.__room = { ctx: null, bus: null, mics: [] });
      function room() {
        if (R.ctx) return R;
        R.ctx = new AudioContext({ sampleRate: 48000 });
        R.bus = R.ctx.createGain();
        const nb = R.ctx.createBuffer(1, 48000 * 2, 48000), d = nb.getChannelData(0);
        for (let i = 0; i < d.length; i++) d[i] = (Math.random() - 0.5) * 0.004;
        const ns = R.ctx.createBufferSource(); ns.buffer = nb; ns.loop = true; ns.connect(R.bus); ns.start();
        // the speaker's own mouth follows what they say (2026-10-22: the gate checks the lips move with the voice)
        R.an = R.ctx.createAnalyser(); R.an.fftSize = 1024; R.bus.connect(R.an); R.buf = new Float32Array(1024);
        return R;
      }
      md.getUserMedia = (c) => {
        if (!c || !c.audio || c.video) return orig(c);
        return new Promise((res) => setTimeout(res, a.gum)).then(() => {
          room();
          const dst = R.ctx.createMediaStreamDestination();
          R.bus.connect(dst);
          R.mics.push({ at: Date.now() });
          return dst.stream;
        });
      };
      window.__say = (b64, at) => {
        room();
        const bin = atob(b64), n = bin.length / 2, buf = R.ctx.createBuffer(1, n, 24000), ch = buf.getChannelData(0);
        for (let i = 0; i < n; i++) { let v = bin.charCodeAt(2 * i) | (bin.charCodeAt(2 * i + 1) << 8); if (v >= 32768) v -= 65536; ch[i] = v / 32768; }
        const src = R.ctx.createBufferSource(); src.buffer = buf; src.connect(R.bus);
        src.start(R.ctx.currentTime + Math.max(0, (at - Date.now()) / 1000));
      };
      // the page's WebSockets (a test can hand one a server message)
      window.__sockets = [];
      const WSo = window.WebSocket;
      window.WebSocket = function (u, p) { const w = new WSo(u, p); window.__sockets.push(w); return w; };
      window.WebSocket.prototype = WSo.prototype; window.WebSocket.OPEN = 1; window.WebSocket.CONNECTING = 0; window.WebSocket.CLOSING = 2; window.WebSocket.CLOSED = 3;
      // What the page sends on its WebSockets (JSON only; binary counted), with the time.
      window.__wsOut = [];
      const send = WebSocket.prototype.send;
      WebSocket.prototype.send = function (d) { window.__wsOut.push(typeof d === "string" ? { at: Date.now(), m: d } : { at: Date.now(), bin: d.byteLength || 0 }); return send.call(this, d); };
    }, { host: HOST, gum: GUM_MS });
    const page = await ctx.newPage();
    page.on("pageerror", (e) => errs.push(e.message));
    page.on("console", (m) => { const t = m.text(); if ((m.type() === "error" && !/Failed to load resource|net::ERR|503|502|EventSource/.test(t)) || /Content Security Policy|Refused to/.test(t)) errs.push(t); });
    await page.goto(SITE + "/joya-ai?shell=desktop", { waitUntil: "load" });
    await page.waitForTimeout(1500);
    // Online (the scratch copy has no supervisor), the bot's place, a face looking at it (or none), the marks.
    await page.evaluate(() => {
      if (window.__joyaCC.orbit && window.__joyaCC.orbit.setConcept) window.__joyaCC.orbit.setConcept("E"); // core E: the bot
      setInterval(() => { const S = window.__joyaCC && window.__joyaCC.S; if (S) S.online = true; const o = document.getElementById("cc-offline"); if (o) o.hidden = true; }, 200);
      const Lg = window.JoyaPresenceLogic;
      // the jaw opens with the room's loudness (the clip being said; the room's noise leaves it at rest)
      const mouthNow = () => { const R = window.__room; if (!R || !R.an) return 0.04; R.an.getFloatTimeDomainData(R.buf); let e = 0; for (let i = 0; i < R.buf.length; i++) e += R.buf[i] * R.buf[i]; return 0.04 + Math.min(0.4, Math.sqrt(e / R.buf.length) * 5); };
      window.__look = (where) => {
        window.__faces = () => {
          if (where === "none") return [];
          const b = window.JoyaPresenceBind.botAt(), f = { cx: 0.5, cy: 0.5, w: 0.24, jaw: mouthNow(), ey: null };
          const a = Lg.aim(f, b); f.yaw = a.bot.yaw; f.pitch = a.bot.pitch;
          return [f];
        };
      };
      window.__marks = { listen: [], warm: [] };
      const lv = window.__joyaLive;
      const lt = lv.lookTalk; lv.lookTalk = function () { window.__marks.listen.push(Date.now()); return lt.apply(this, arguments); };
      if (lv.lookWarm) { const lw = lv.lookWarm; lv.lookWarm = function () { const r = lw.apply(this, arguments); window.__marks.warm.push([Date.now(), r, !!(window.VoiceLive && window.VoiceLive.active())]); return r; }; }
    });
    await sleep(800);
    const st0 = await page.evaluate(() => ({ ok: window.__joyaLive.ok(), cam: window.JoyaPresence.snapshot(), speak: window.JoyaPresenceBind.prefs() }));
    check("the page is ready: voice on, the camera module on with look and speak", st0.ok && st0.speak.cam && st0.speak.speak, JSON.stringify(st0));

    // a first look and away (the camera's first frames, the room's floor), as anyone sits down first
    await page.evaluate(() => window.__look("bot")); await sleep(2500); await page.evaluate(() => window.__look("none")); await sleep(1500);
    const FIX = fixtures();
    section("look and speak with speech: " + FIX.length + " clip(s) (" + FIX.map((f) => f.lang).join(" ") + "), mic open " + GUM_MS + " ms, session ready " + READY_MS + " ms");
    for (const fx of FIX) {
      const span = speechSpan(fx.pcm);
      const n0 = mock.sessions.length;
      await page.evaluate(() => { window.__marks.listen = []; window.__marks.warm = []; window.__wsOut = []; });
      const lookAt = Date.now();
      await page.evaluate(() => window.__look("bot"));
      const sayAt = lookAt + (fx.sayAfter || SAY_AFTER_MS);
      const b64 = Buffer.from(Int16Array.from(fx.pcm, (v) => Math.max(-32767, Math.min(32767, Math.round(v * 32767)))).buffer).toString("base64");
      await page.evaluate((a) => window.__say(a.b64, a.at), { b64, at: sayAt });
      const speechStart = sayAt + span.startMs, speechEnd = sayAt + span.endMs;
      // the turn: a session opened (or the warm one), committed
      let ses = null;
      const got = await until(() => { ses = mock.sessions.slice(n0 > 0 ? n0 - 1 : 0).reverse().find((x) => x.events.some((e) => e.type === "input_audio_buffer.commit" && e.at > lookAt)); return !!ses; }, 9000 + fx.pcm.length / 24);
      if (process.env.LOOK_DEBUG) console.log("  look: " + JSON.stringify(await page.evaluate((t0) => ({ last: window.JoyaPresence.look().turns.last, mics: window.__room.mics.map((m) => m.at - t0), listen: window.__marks.listen.map((x) => x - t0), say: 0 }), lookAt)) + " speech+" + span.startMs);
      const pg = await page.evaluate(() => ({ marks: window.__marks, out: window.__wsOut.filter((x) => x.m), mics: window.__room.mics.length }));
      const offMsg = pg.out.find((x) => /"type":"ptt"/.test(x.m) && /"on":false/.test(x.m));
      // warm: the look opened the call before the turn started (lookWarm); sessionBeforeSpeech: its upstream was asked for before the speech began
      const r = { id: fx.id, sayAfter: fx.sayAfter || SAY_AFTER_MS, lang: fx.lang, text: fx.text, durMs: Math.round(fx.pcm.length / 24), speechMs: span.endMs - span.startMs, warm: !!(ses && ses.opened < speechStart) || pg.marks.warm.some((w) => w[1] && pg.marks.listen.length && w[0] <= pg.marks.listen[0]), sessionBeforeSpeech: !!(ses && ses.opened < speechStart) };
      if (got && ses) {
        const ta = turnAudio(ses);
        const al = align(fx.pcm, ta.pcm);
        const gotStart = al.startMs, gotEnd = al.startMs + Math.round(ta.pcm.length / 24);
        Object.assign(r, {
          startToListen: pg.marks.listen.length ? pg.marks.listen[0] - speechStart : null,
          endToSent: offMsg ? offMsg.at - speechEnd : null,
          endToCommit: ta.commitAt - speechEnd,
          clippedStart: Math.max(0, gotStart - span.startMs), clippedEnd: Math.max(0, span.endMs - gotEnd),
          lead: span.startMs - gotStart, turnMs: Math.round(ta.pcm.length / 24), corr: Math.round(al.corr * 100) / 100,
        });
        r.audio = ta.pcm;
      } else r.failed = true;
      results.push(r);
      console.log("  " + JSON.stringify(Object.assign({}, r, { audio: undefined, text: r.text ? r.text.slice(0, 40) : null })));
      // look away, end the call, the cool-down
      await page.evaluate(() => window.__look("none"));
      await page.evaluate(() => { try { window.__joyaLive.end("esc"); } catch (e) { /* none */ } });
      await until(() => mock.sessions.every((x) => x.closed), 4000);
      await sleep(3600);
    }

    if (!REPORT) {
      section("the voice check said on screen (2026-10-21)");
      // a call (warm), then the server's verdict on a turn: an unknown voice, the gate on
      await page.evaluate(() => window.__joyaLive.lookWarm());
      await until(() => page.evaluate(() => window.VoiceLive.state() !== "connecting" && window.VoiceLive.active()), 6000);
      await page.evaluate(() => { const w = window.__sockets.filter((x) => /\/api\/live/.test(x.url)).pop(); w.onmessage({ data: JSON.stringify({ type: "voiceprint", verdict: "reject", kind: "other", gated: true, name: null, turn: 1 }) }); });
      await sleep(120);
      const vp = await page.evaluate(() => ({ label: (document.getElementById("cc-cap-label") || {}).textContent, live: (document.getElementById("cc-vp-live") || {}).textContent, liveAttr: (document.getElementById("cc-vp-live") || { getAttribute() { return null; } }).getAttribute("aria-live"),
        pill: (document.querySelector("#mp-cam .mp-s") || {}).textContent, rk: window.__joyaCC.core.S ? window.__joyaCC.core.S.rk : null, concept: window.__joyaCC.core.S ? window.__joyaCC.core.S.concept : null }));
      check("an unknown voice with the gate on: the state pill says 'Didn't recognise your voice, try again' (aria-live polite), and so does the camera's pill", vp.label === "Didn't recognise your voice, try again" && /^Didn't recognise your voice, try again\.?$/.test(vp.live) && vp.liveAttr === "polite" && vp.pill === "Didn't recognise your voice, try again", JSON.stringify(vp));
      check("  core E shakes its head", vp.concept === "E" && vp.rk === "shake", JSON.stringify(vp));
      await page.evaluate(() => window.__joyaLive.end("esc"));
      await sleep(400);
    }

    if (TRANSCRIBE) {
      section("transcripts (gpt-4o-mini-transcribe)");
      for (const r of results) {
        if (!r.text || !r.audio) continue;
        const fx = FIX.find((f) => f.id === r.id);
        r.heardClip = await transcribe(fx.pcm);
        r.heardTurn = await transcribe(r.audio);
        r.errClip = Math.round(errRate(r.lang, r.text, r.heardClip) * 1000) / 1000;
        r.errTurn = Math.round(errRate(r.lang, r.text, r.heardTurn) * 1000) / 1000;
        console.log("  " + r.lang + " " + (r.lang === "ar" ? "CER" : "WER") + " clip " + r.errClip + " / turn " + r.errTurn + " | " + r.heardTurn.slice(0, 80));
      }
    }

    const ok = results.filter((r) => !r.failed);
    const avg = (k, rs) => { const v = (rs || ok).map((r) => r[k]).filter((x) => typeof x === "number"); return v.length ? Math.round(v.reduce((a, b) => a + b, 0) / v.length) : null; };
    const mx = (k, rs) => { const v = (rs || ok).map((r) => r[k]).filter((x) => typeof x === "number"); return v.length ? Math.max.apply(null, v) : null; };
    section("summary");
    console.log("  turns " + ok.length + "/" + results.length + "; start of speech -> listening avg " + avg("startToListen") + " ms; end of speech -> turn sent avg " + avg("endToSent") + " ms (max " + mx("endToSent") + "), -> committed avg " + avg("endToCommit") + " ms");
    console.log("  clipped start avg " + avg("clippedStart") + " ms (max " + mx("clippedStart") + "), clipped end avg " + avg("clippedEnd") + " ms (max " + mx("clippedEnd") + ")");
    if (TRANSCRIBE) ["en", "ar"].forEach((l) => { const rs = ok.filter((r) => r.lang === l && r.errTurn != null); if (rs.length) console.log("  " + l + ": " + (l === "ar" ? "CER" : "WER") + " clip " + (rs.reduce((a, r) => a + r.errClip, 0) / rs.length).toFixed(3) + " / turn " + (rs.reduce((a, r) => a + r.errTurn, 0) / rs.length).toFixed(3) + " (" + rs.length + " clips)"); });
    const jf = arg("--json");
    if (jf) fs.writeFileSync(jf, JSON.stringify(results.map((r) => Object.assign({}, r, { audio: undefined })), null, 1));

    if (!REPORT) {
      section("checks");
      const langs = new Set(ok.map((r) => r.lang));
      check("every clip opened a turn and the turn was committed", ok.length === results.length && results.length >= 1, JSON.stringify(results.map((r) => r.id + (r.failed ? " failed" : ""))));
      check("  the turn holds the start of the speech (the pre-roll): nothing of it clipped (<= 30 ms)", ok.every((r) => r.clippedStart <= 30 && r.corr > 0.5), JSON.stringify(ok.map((r) => [r.id, r.clippedStart, r.corr])));
      check("  ...and some audio from before it (>= 150 ms of lead-in)", ok.every((r) => r.lead >= 150), JSON.stringify(ok.map((r) => [r.id, r.lead])));
      check("  and its end: nothing clipped (<= 30 ms), a mid-sentence pause did not end the turn early", ok.every((r) => r.clippedEnd <= 30), JSON.stringify(ok.map((r) => [r.id, r.clippedEnd])));
      check("  the turn is sent within 1.1 s of the end of speech (700 ms of quiet + the tail)", ok.every((r) => r.endToSent != null && r.endToSent <= 1100), JSON.stringify(ok.map((r) => [r.id, r.endToSent])));
      check("  armed first (the look held), it starts listening within 0.4 s of the start of speech; talking as they look, once armed", ok.every((r) => r.startToListen != null && r.startToListen <= (r.sayAfter >= 1500 ? 400 : 1200)), JSON.stringify(ok.map((r) => [r.id, r.startToListen])));
      check("  a look that arms look and speak opens the call ahead (warm), so the turn does not wait for it", ok.filter((r) => r.sayAfter >= 1500).every((r) => r.warm), JSON.stringify(ok.map((r) => [r.id, r.warm])));
      check("  English and Arabic clips both (when the recorded clips are on this machine)", langs.has("en") && (langs.has("ar") || !fs.existsSync(FIXDIR)), [...langs].join(","));
      const out = await page.evaluate(() => window.__wsOut.filter((x) => x.m).map((x) => x.m));
      const faceWords = /"(?:yaw|pitch|jaw|cx|cy|faces?|landmarks?|gaze|ey|lip|lips|mouth|mc|sm|pk|open|vad|voiced|speechy|sync|fused)"\s*:/;
      check("no face data leaves the page: no WebSocket message and no request carries a face record", !out.some((m) => faceWords.test(m)) && !reqs.some((q) => faceWords.test(q.body)) && reqs.every((q) => new URL(q.url).origin === SITE), out.filter((m) => faceWords.test(m)).concat(reqs.filter((q) => new URL(q.url).origin !== SITE).map((q) => q.url)).join(" | ").slice(0, 600));
      check("zero page errors and CSP violations", errs.length === 0, errs.join("\n"));
    }
  } catch (e) {
    check("the run completed", false, e.stack + "\n" + s.out().slice(-3000));
  } finally {
    if (browser) await browser.close();
    s.stop();
    ms.close();
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.log("  FAIL no exception\n" + e.stack); process.exit(1); });
