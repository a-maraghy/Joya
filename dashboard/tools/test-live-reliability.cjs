#!/usr/bin/env node
"use strict";
/**
 * Live-call reliability (2026-09-30: calls ended on their own): lib/voice-live.js
 * against a mock OpenAI realtime server that can drop, refuse and stop
 * answering pings, with a fake page, a fake supervisor and a fake reader. No
 * network beyond 127.0.0.1, no OpenAI, nothing to JOYA AI.
 *
 *     NODE_PATH=/opt/joya-dashboard/node_modules node dashboard/tools/test-live-reliability.cjs
 *
 * Covers: close codes and reasons logged; an unexpected upstream close
 * reconnected with a recap and a spoken line (Arabic in an Arabic call), at
 * most twice a minute; a connect failure retried once; the keepalive; IPv4;
 * the page's end reasons; the stop phrase logged; the guard's grounded screen
 * confirmations and cut hand-offs; repeats folded into one request; a late
 * answer introduced; restarts; and page.open over every key of the page map
 * never ending a call.
 */
const scratch = require("./scratch-server.cjs"); // first: sets JOYA_DATA_DIR
const fs = require("fs");
const net = require("net");
const os = require("os");
const path = require("path");
const vm = require("vm");
const http = require("http");
const WebSocket = require("ws");
const { WebSocketServer } = WebSocket;

const ROOT = path.join(__dirname, "..");
const live = require(path.join(ROOT, "lib", "voice-live.js"));
const desk = require(path.join(ROOT, "lib", "voice-shared.js"));
const usage = require(path.join(ROOT, "lib", "voice-usage.js"));
const VoiceStop = require(path.join(ROOT, "public", "voice-stop.js"));
const UiActions = require(path.join(ROOT, "public", "ui-actions.js"));
const registry = require(path.join(ROOT, "lib", "page-registry.js"));

let passed = 0;
let failed = 0;
function check(name, cond, detail) {
  if (cond) {
    passed++;
    console.log("  ok   " + name);
  } else {
    failed++;
    console.log("  FAIL " + name + (detail !== undefined ? "\n       " + String(detail).slice(0, 600) : ""));
  }
}
const section = (t) => console.log("\n" + t);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms) {
  const end = Date.now() + (ms || 2000);
  while (Date.now() < end) {
    if (fn()) return true;
    await sleep(5);
  }
  return false;
}

/* ------------------------------------------------------ mock realtime --- */

const KEY = "sk-proj-" + "R".repeat(40) + "rel";
const mock = { sessions: [], refuse: 0, upgrades: 0 };
function mockServer(opts) {
  const server = http.createServer((q, s) => (s.writeHead(404), s.end()));
  const wss = new WebSocketServer({ noServer: true, autoPong: !(opts && opts.noPong) });
  server.on("upgrade", (req, sock, head) => {
    mock.upgrades++;
    if (mock.refuse > 0) {
      mock.refuse--;
      sock.write("HTTP/1.1 503 Service Unavailable\r\nContent-Length: 0\r\n\r\n");
      return sock.destroy();
    }
    if (String(req.headers.authorization || "") !== "Bearer " + KEY && String(req.headers.authorization || "") !== "Bearer " + scratch.FAKE_KEY) {
      sock.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      return sock.destroy();
    }
    wss.handleUpgrade(req, sock, head, (ws) => {
      const s = { ws, events: [], pings: 0, closed: false, silent: !!(opts && opts.silentAfterOpen) };
      s.push = (o) => ws.readyState === 1 && ws.send(JSON.stringify({ event_id: "ev" + Math.random().toString(36).slice(2), ...o }));
      s.of = (type) => s.events.filter((e) => e.type === type);
      ws.on("ping", () => s.pings++);
      ws.on("close", () => (s.closed = true));
      ws.on("message", (d) => {
        const ev = JSON.parse(String(d));
        if (ev.type === "input_audio_buffer.append") return;
        s.events.push(ev);
        if (ev.type === "session.update" && !s.updated) {
          s.updated = true;
          s.push({ type: "session.updated", session: ev.session });
        }
      });
      mock.sessions.push(s);
    });
  });
  return server;
}
const lastSession = () => mock.sessions[mock.sessions.length - 1];

/* ------------------------------------------------ the fakes around it --- */

function pcm(ms) {
  const b = Buffer.alloc(Math.round(ms * 48));
  for (let i = 0; i < b.length; i += 2) b.writeInt16LE(i % 8 < 4 ? 3000 : -3000, i);
  return b;
}

function makeCall(x) {
  x = x || {};
  const client = { json: [], audio: [], closed: null };
  const sup = { calls: [], replies: new Map(), nextTurn: 700, sameTurn: x.sameTurn };
  const call = (op, params, actor) => {
    sup.calls.push([op, params, actor]);
    if (op === "snapshot") {
      const snap = { machine: { disk: { used_percent: 41 } }, services: { running: 4, tracked: 4, failed: [], list: [] } };
      if (params && params.turns) snap.requests_to_joya_ai = params.turns.map((id) => ({ id, answered: sup.replies.has(id), reply: sup.replies.get(id) }));
      return Promise.resolve(snap);
    }
    if (op === "send") {
      // sameTurn: the supervisor folds a repeat into the queued turn (mergeVoiceTurn).
      if (sup.sameTurn && sup.last) return Promise.resolve({ turn: { id: sup.last, status: "queued" }, merged: true });
      sup.last = ++sup.nextTurn;
      return Promise.resolve({ turn: { id: sup.last, status: "queued" } });
    }
    return Promise.reject(new Error("refused " + op));
  };
  const spoke = [];
  const logs = [];
  const c = new live.LiveCall({
    cfg: { key: KEY, voice: "marin", model: "gpt-realtime-mini", transcribe_model: "gpt-4o-mini-transcribe", wsBase: x.wsBase || WS_BASE, ...(x.cfg || {}) },
    actor: "amaraghy",
    ops: desk.voiceOps(call, "amaraghy"),
    client: {
      json: (o) => client.json.push(o),
      audio: (seg, buf) => client.audio.push({ seg, bytes: buf.length }),
      close: (code, why) => (client.closed = { code, why }),
    },
    persona: () => ({}),
    hearPersona: () => ({}),
    speak: async (text, cfg, sink) => {
      spoke.push(text);
      sink.start({ engine: "fake" });
      sink.audio(pcm(100));
      return { billing: [], lateBilling: Promise.resolve([]) };
    },
    transcribe: async () => ({ text: x.turnText || "", model: "gpt-4o-mini-transcribe", tokens: { audio_in: 30, text_in: 5, text_out: 10 } }),
    summarise: async (id, o) => {
      o.onLine({ text: "I found that the dashboard is back up.", safe: false });
      return { tokens: { text_in: 300, text_out: 30 }, fallback: null };
    },
    record: (row) => usage.costOf(row.tokens, row.model),
    isStop: (t) => VoiceStop.heard(t),
    isUndo: (t) => VoiceStop.undo(t),
    audit: () => {},
    log: (m) => logs.push(m),
    opts: { pollMs: 20, uiAckMs: 300, openRetryMs: 30, ...(x.opts || {}) },
  });
  return { c, client, sup, spoke, logs };
}

async function userTurn(s, c, text, o) {
  o = o || {};
  const item = "item_u" + Math.random().toString(36).slice(2, 8);
  c.audioIn(pcm(1500));
  s.push({ type: "input_audio_buffer.speech_started", audio_start_ms: Math.max(0, c.inputMs - 1500), item_id: item });
  s.push({ type: "input_audio_buffer.speech_stopped", audio_end_ms: c.inputMs, item_id: item });
  if (text != null) s.push({ type: "conversation.item.input_audio_transcription.completed", item_id: item, content_index: 0, transcript: text });
  await sleep(o.wait || 15);
  return item;
}
async function respond(s, say, o) {
  o = o || {};
  const rid = "resp_" + Math.random().toString(36).slice(2, 8);
  const item = "item_a" + Math.random().toString(36).slice(2, 8);
  s.push({ type: "response.created", response: { id: rid, status: "in_progress", output: [] } });
  const output = [];
  if (say) {
    s.push({ type: "response.output_item.added", response_id: rid, item: { id: item, type: "message", role: "assistant", content: [] } });
    const words = say.match(/\S+\s*/g) || [];
    for (let i = 0; i < words.length; i++) {
      s.push({ type: "response.output_audio_transcript.delta", response_id: rid, item_id: item, delta: words[i] });
      s.push({ type: "response.output_audio.delta", response_id: rid, item_id: item, delta: pcm(60).toString("base64") });
      await sleep(2);
    }
    s.push({ type: "response.output_audio_transcript.done", response_id: rid, item_id: item, transcript: say });
    output.push({ id: item, type: "message", role: "assistant", status: "completed", content: [{ type: "output_audio", transcript: say }] });
  }
  for (const f of o.calls || []) output.push({ id: "fc" + Math.random().toString(36).slice(2, 6), type: "function_call", name: f.name, call_id: "call_" + Math.random().toString(36).slice(2, 8), arguments: JSON.stringify(f.args || {}) });
  await sleep(2);
  s.push({ type: "response.done", response: { id: rid, status: o.status || "completed", output, usage: { total_tokens: 90, input_tokens: 70, output_tokens: 20, input_token_details: { text_tokens: 50, audio_tokens: 20 }, output_token_details: { text_tokens: 4, audio_tokens: 16 } } } });
  await sleep(15);
  return { rid, item };
}
const acker = (c, client) =>
  setInterval(() => {
    for (const m of client.json) if (m.type === "ui" && m.nonce && !m.acked) (m.acked = true), c.message({ type: "ui-ack", nonce: m.nonce, ok: true });
  }, 5);

let WS_BASE;
let WS_NOPONG;

(async () => {
  const main = mockServer();
  const noPong = mockServer({ noPong: true });
  await new Promise((r) => main.listen(0, "127.0.0.1", r));
  await new Promise((r) => noPong.listen(0, "127.0.0.1", r));
  WS_BASE = "ws://127.0.0.1:" + main.address().port + "/v1";
  WS_NOPONG = "ws://127.0.0.1:" + noPong.address().port + "/v1";

  section("1. why a call ended is logged: upstream close code, reason and last event; the page's end reason; the stop phrase");
  {
    const { c, logs } = makeCall({ opts: { reconnect: false } });
    await c.open();
    const s = lastSession();
    s.push({ type: "rate_limits.updated" });
    await sleep(20);
    s.ws.close(1011, "keepalive ping timeout");
    await until(() => c.closed, 1500);
    const lost = logs.find((l) => /upstream lost/.test(l)) || "";
    check("the upstream close is logged with its code, its reason and the last event it sent", /code 1011 "keepalive ping timeout"/.test(lost) && /last event rate_limits\.updated/.test(lost), lost);
    check("  and the call ends 'upstream' with that reason (reconnect off)", c.endWhy && c.endWhy.why === "upstream" && logs.some((l) => /ended \(upstream: OpenAI closed the live session \(code 1011/.test(l)), JSON.stringify(logs.slice(-2)));
  }
  {
    const { c, logs } = makeCall();
    await c.open();
    c.message({ type: "end", why: "button" });
    check("the page's end reason is logged: ended (hung-up: button)", logs.some((l) => /ended \(hung-up: button\)/.test(l)), logs.join(" | "));
    const b = makeCall();
    await b.c.open();
    b.c.message({ type: "end", why: "<script>alert(1)</script>" });
    check("  anything else the page says is 'unspecified', never echoed", b.logs.some((l) => /ended \(hung-up: unspecified\)/.test(l)) && !b.logs.some((l) => /script/.test(l)));
    const e = makeCall();
    await e.c.open();
    e.c.message({ type: "end", why: "error:the microphone was refused" });
    check("  an error reason is kept (error:<message>)", e.logs.some((l) => /ended \(hung-up: error:the microphone was refused\)/.test(l)));
  }
  {
    const { c, logs } = makeCall();
    await c.open();
    const s = lastSession();
    await userTurn(s, c, "Okay, stop listening.");
    await until(() => c.closed, 1000);
    check("a spoken stop logs the phrase it matched", logs.some((l) => /ended \(voice-command: "Okay, stop listening\."\)/.test(l)), logs.join(" | "));
  }

  section("2. an unexpected upstream close is reconnected, with a recap and a spoken line");
  {
    const { c, client, spoke, logs } = makeCall();
    await c.open();
    const s1 = lastSession();
    await userTurn(s1, c, "how are you today");
    await respond(s1, "I'm well, thank you.");
    const n = mock.sessions.length;
    s1.ws.close(1011, "server error");
    await until(() => mock.sessions.length > n && lastSession().updated, 2000);
    const s2 = lastSession();
    await until(() => spoke.some((x) => /I'm back/.test(x)), 2000);
    await until(() => s2.of("conversation.item.create").length >= 2, 1000); // (the mock reads them a moment later)
    check("a new upstream session is opened, and the call goes on", mock.sessions.length === n + 1 && !c.closed && c.ws && c.ws.readyState === WebSocket.OPEN);
    const note = s2.of("conversation.item.create").map((e) => JSON.stringify(e.item)).find((t) => /System note/.test(t)) || "";
    check("  the new session gets a note that the line dropped, with a recap of the last lines heard and said", /connection dropped for a moment and was restored/.test(note) && /Administrator: \\"how are you today\\"/.test(note) && /You: \\"I'm well, thank you\.\\"/.test(note), note || JSON.stringify(s2.events.map((e) => e.type)));
    check("  the voice says it is back (English call)", spoke.includes("The line dropped for a second — I'm back."), JSON.stringify(spoke));
    check("  the page is told: reconnecting, then reconnected", client.json.some((m) => m.type === "reconnecting") && client.json.some((m) => m.type === "reconnected"));
    check("  logged: lost (code, reason) and reconnected in N ms", logs.some((l) => /upstream lost: code 1011 "server error"/.test(l)) && logs.some((l) => /upstream reconnected in \d+ ms/.test(l)), logs.join(" | "));
    check("  and the call counts the drop", c.diag.drops.length === 1);
    // It still works: a turn on the new session gets an answer.
    await userTurn(s2, c, "what time is it");
    await until(() => s2.of("response.create").length >= 1, 1000);
    check("  a turn after it is answered on the new session", s2.of("response.create").length >= 1);
    c.close("test");
  }
  {
    const { c, spoke } = makeCall();
    await c.open();
    const s1 = lastSession();
    await userTurn(s1, c, "إزيك عامل إيه النهارده");
    const n = mock.sessions.length;
    s1.ws.terminate();
    await until(() => mock.sessions.length > n && spoke.length > 0, 2000);
    check("an Arabic call hears the line in Arabic", spoke.includes("الخط قطع لثانية، وأنا معاك تاني."), JSON.stringify(spoke));
    c.close("test");
  }
  {
    const { c, client, logs } = makeCall();
    await c.open();
    for (let i = 0; i < 2; i++) {
      const n = mock.sessions.length;
      lastSession().ws.close(1011, "drop " + i);
      await until(() => mock.sessions.length > n && lastSession().updated && c.ws && c.ws.readyState === 1, 2000);
    }
    check("two drops within a minute are both reconnected", !c.closed && c.diag.drops.length === 2);
    lastSession().ws.close(1011, "drop 3");
    await until(() => c.closed, 1500);
    const ended = client.json.find((m) => m.type === "ended");
    check("  a third within the minute ends the call, with the reason shown", c.closed && ended && ended.why === "upstream" && /dropped 3 times within a minute/.test(ended.text || ""), JSON.stringify(ended));
    check("  and logged", logs.some((l) => /upstream dropped 3 times within a minute; ending the call/.test(l)));
  }

  section("3. a connect failure is retried once");
  {
    mock.refuse = 1;
    const { c, logs } = makeCall();
    const u0 = mock.upgrades;
    await c.connect().catch(() => {});
    check("refused once (503), then connected on the retry", c.ws && c.ws.readyState === WebSocket.OPEN && mock.upgrades === u0 + 2, `upgrades ${mock.upgrades - u0}`);
    check("  the failure and the retry are logged", logs.some((l) => /upstream failed: HTTP 503/.test(l)) && logs.some((l) => /retrying the upstream connection/.test(l)), logs.join(" | "));
    c.close("test");
  }
  {
    mock.refuse = 2;
    const { c } = makeCall();
    let err = null;
    await c.connect().catch((e) => (err = e));
    check("refused twice: the start fails with the reason (the page shows it)", err && /OpenAI refused the live session \(503\)/.test(err.message), err && err.message);
    c.close("test");
    mock.refuse = 0;
  }
  {
    // A reconnect whose first try fails still recovers.
    const { c } = makeCall();
    await c.open();
    mock.refuse = 1;
    const n = mock.sessions.length;
    lastSession().ws.close(1011, "drop");
    await until(() => mock.sessions.length > n && c.ws && c.ws.readyState === 1, 2500);
    check("a reconnect that is refused once succeeds on its retry", !c.closed && c.diag.drops.length === 1);
    c.close("test");
    mock.refuse = 0;
  }

  section("4. the keepalive and IPv4");
  {
    const { c } = makeCall({ opts: { keepaliveMs: 40, keepaliveDeadMs: 1000 } });
    await c.open();
    const s = lastSession();
    await sleep(200);
    check("the upstream leg is pinged while the call is quiet", s.pings >= 3, s.pings);
    c.close("test");
    await sleep(100);
    const p = s.pings;
    await sleep(150);
    check("  and the pings stop when the call ends", s.pings === p);
  }
  {
    const { c, logs } = makeCall({ wsBase: WS_NOPONG, opts: { keepaliveMs: 30, keepaliveDeadMs: 150, reconnect: false } });
    await c.open();
    await until(() => c.closed, 1500);
    check("a leg that answers no ping (and sends nothing) is dropped as dead", c.closed && logs.some((l) => /upstream silent for \d+ s \(no pong, no event\); dropping it/.test(l)), logs.join(" | "));
  }
  {
    const a = makeCall();
    const b = makeCall({ cfg: { ipv4: false } });
    check("IPv4 only for the OpenAI WebSocket by default; cfg.ipv4 = false goes back to the resolver", a.c.ipv4() === true && b.c.ipv4() === false);
    const src = fs.readFileSync(path.join(ROOT, "lib", "voice-live.js"), "utf8");
    check("  it is passed to the socket as family: 4, and JOYA_OPENAI_IPV4=0 turns it off", /\.\.\.\(this\.ipv4\(\) \? \{ family: 4 \} : \{\}\)/.test(src) && /const FORCE_IPV4 = process\.env\.JOYA_OPENAI_IPV4 !== "0";/.test(src));
  }

  section("5. screen actions: the confirmation is this server's, grounded in the page's ui-ack");
  {
    const { c, client, spoke } = makeCall();
    await c.open();
    const s = lastSession();
    const t = acker(c, client);
    await userTurn(s, c, "open the agents dashboard");
    const cr = s.of("response.create").length;
    await respond(s, "I'll open the agents dashboard.", { calls: [{ name: "ui_action", args: { action: "page.open", page: "agents" } }] });
    await until(() => spoke.includes("Opened Agents overview."), 1500);
    check("\"I'll open the agents dashboard\" in the same response as the ui_action call is not cut", c.diag.trips.length === 0, JSON.stringify(c.diag.trips));
    check("  after the page's ok, the server says \"Opened Agents overview.\" and asks the model for nothing more", spoke.includes("Opened Agents overview.") && s.of("response.create").length === cr, JSON.stringify(spoke));
    clearInterval(t);
    c.close("test");
  }
  {
    const { c, client, spoke } = makeCall();
    await c.open();
    const s = lastSession();
    const t = setInterval(() => {
      for (const m of client.json) if (m.type === "ui" && m.nonce && !m.acked) (m.acked = true), c.message({ type: "ui-ack", nonce: m.nonce, ok: false, why: "their role cannot open it" });
    }, 5);
    await userTurn(s, c, "open the audit log");
    await respond(s, null, { calls: [{ name: "ui_action", args: { action: "page.open", page: "audit" } }] });
    await until(() => s.of("response.create").length >= 2, 1500);
    check("a refused screen action: no confirmation is said, the model is asked to say it could not", !spoke.some((x) => /^Opened/.test(x)) && s.of("response.create").length >= 2);
    clearInterval(t);
    c.close("test");
  }
  {
    const { c, client, spoke } = makeCall();
    await c.open();
    const s = lastSession();
    const t = acker(c, client);
    await userTurn(s, c, "افتحلي المهام");
    await respond(s, null, { calls: [{ name: "ui_action", args: { action: "sheet.open", key: "missions" } }] });
    await until(() => spoke.length > 0, 1500);
    check("in an Arabic call the confirmation is Arabic", spoke.includes("فتحت Missions."), JSON.stringify(spoke));
    clearInterval(t);
    c.close("test");
  }
  {
    const { c, sup } = makeCall();
    await c.open();
    const s = lastSession();
    await userTurn(s, c, "open the missions");
    const sends = () => sup.calls.filter((x) => x[0] === "send").length;
    await respond(s, "Let me pull up the conversations for you now.");
    await sleep(200);
    check("\"I'll open / let me pull up\" with no ui_action call is still cut (and handed on: no tool call)", c.diag.trips.length === 1 && sends() === 1, JSON.stringify(c.diag.trips) + " sends " + sends());
    c.close("test");
  }
  {
    const { c, sup } = makeCall({ turnText: "what is running" });
    await c.open();
    const s = lastSession();
    await userTurn(s, c, "what is running");
    await respond(s, "I restarted Odoo.", { calls: [{ name: "read_status" }] });
    await sleep(250);
    const sends = sup.calls.filter((x) => x[0] === "send").length;
    check("a cut response that called a tool: the call runs, and nothing is handed to JOYA AI", c.diag.trips.length === 1 && sends === 0 && sup.calls.some((x) => x[0] === "snapshot") && s.of("conversation.item.create").some((e) => e.item.type === "function_call_output"), `sends ${sends}`);
    c.close("test");
  }
  {
    const j = (x, ctx) => desk.judge(desk.sentencesOf(x, true), ctx);
    check("a screen action announced in a response that calls ui_action passes; one that announces anything else too does not", j("Sure, let me pull up the missions for you.", { uiCalling: true }).ok && !j("I'll open the missions and delete the logs.", { uiCalling: true }).ok && !j("I'll open the missions.", { uiCalling: false }).ok);
    const rel = new desk.Releaser(() => ({ numbers: new Set() }), () => {});
    rel.update("I'll open the missions. ", false, { askedNow: () => false, pending: () => false, uiCalling: () => null });
    check("  while the calls are not known yet it is held, not cut", !rel.trip && rel.released === 0, JSON.stringify(rel.trip));
    check("\"The agents dashboard is open.\" passes after an ok screen action this turn", j("The agents dashboard is open.", { uiOk: true }).ok);
    check("  and not without one (a status claim)", !j("The agents dashboard is open.", {}).ok);
    check("  \"Odoo is up\" is still a status claim, even after a screen action", !j("Odoo is up.", { uiOk: true }).ok);
    check("\"JOYA AI OS\" (and JOYA AI's OS, Joya AIOS) is the product, not JOYA AI in the third person", j("JOYA AI OS is ready.", {}).ok && j("JOYA AI's OS dashboard is open.", { uiOk: true }).ok && j("Welcome to Joya AIOS.", {}).ok);
    check("  \"JOYA AI says\" still is", !j("JOYA AI says hi.", {}).ok);
  }

  section("6. the fixed lines this server says pass its own guard");
  {
    const lines = [];
    for (const a of UiActions.names()) {
      const v = UiActions.validate(a, a === "page.open" ? { page: "agents" } : a === "sheet.open" ? { key: "missions" } : a === "view" ? { name: "map" } : a === "core.set" ? { core: "A" } : {});
      if (!v.ok || v.where !== "page" || v.tier !== 1) continue;
      const l = live.uiConfirmLine(v.action, v.args);
      if (l) lines.push([v.action, l]);
    }
    const bad = lines.filter(([, l]) => !desk.judge(desk.sentencesOf(l.en, true), { uiOk: true }).ok || !desk.judge(desk.sentencesOf(l.ar, true), { uiOk: true }).ok);
    check("every page action's confirmation (English and Arabic) passes the guard", lines.length >= 6 && !bad.length, JSON.stringify(bad));
    const map = registry.build();
    const pages = map.map((e) => live.uiConfirmLine("page.open", { page: e.key })).filter(Boolean);
    UiActions.setPages(map);
    // Labels that name JOYA AI ("JOYA AI Settings") are said as they are (sayFixed trusts the confirmation).
    const badP = map.filter((e) => { const l = live.uiConfirmLine("page.open", { page: e.key }); return !l || l.en !== "Opened " + e.label + "." || l.ar !== "فتحت " + e.label + "." || (!/JOYA AI/.test(e.label) && !desk.judge(desk.sentencesOf(l.en, true), { uiOk: true }).ok); });
    check("  and page.open's for every key of the page map (" + map.length + "): \"Opened <label>.\", passing the guard unless the label names JOYA AI", pages.length === map.length && !badP.length, JSON.stringify(badP.slice(0, 5)));
    UiActions.setPages(null);
    const fixed = ["The line dropped for a second — I'm back.", "الخط قطع لثانية، وأنا معاك تاني.", "Reconnected.", "الاتصال رجع، وأنا معاك.", "About your earlier question:", "بخصوص سؤالك اللي فات:"];
    check("  the back, reconnected and earlier-question lines too", fixed.every((x) => desk.judge(desk.sentencesOf(x, true), { uiOk: true }).ok));
  }

  section("7. repeats and late answers");
  {
    const { c, sup, logs } = makeCall({ sameTurn: true, turnText: "restart the odoo service please" });
    await c.open();
    const s = lastSession();
    await userTurn(s, c, "restart the odoo service please");
    await respond(s, null, { calls: [{ name: "look_into", args: { text: "restart the odoo service" } }] });
    await until(() => c.requests.size === 1, 1000);
    await respond(s, "Give me a moment, I'm checking.");
    await userTurn(s, c, "restart the odoo service please");
    await respond(s, null, { calls: [{ name: "look_into", args: { text: "restart the odoo service" } }] });
    await until(() => c.diag.merged === 1, 1500);
    const sends = sup.calls.filter((x) => x[0] === "send");
    check("the call id goes with every hand-off (the supervisor folds a repeat still queued)", sends.length === 2 && sends.every((x) => x[1].call === c.id), JSON.stringify(sends.map((x) => x[1])));
    check("  a folded repeat is one request, watched once", c.requests.size === 1 && c.diag.merged === 1 && logs.some((l) => /folded into the queued request/.test(l)));
    c.close("test");
  }
  {
    const { c, sup, spoke } = makeCall({ turnText: "check the backups" });
    await c.open();
    const s = lastSession();
    await userTurn(s, c, "check the backups");
    await respond(s, null, { calls: [{ name: "look_into", args: { text: "check the backups" } }] });
    await until(() => c.requests.size === 1, 1000);
    const id = [...c.requests.keys()][0];
    await respond(s, "Give me a moment, I'm checking.");
    await userTurn(s, c, "and how is the weather there");
    await respond(s, "I can only tell you about this machine.");
    sup.replies.set(id, "The dashboard is back up.");
    await until(() => spoke.some((x) => /earlier question/.test(x)), 2000);
    const i = spoke.indexOf("About your earlier question:");
    check("a result that arrives after newer words is introduced (\"About your earlier question:\") before it is read", i >= 0 && spoke.slice(i + 1).some((x) => /dashboard is back up/.test(x)), JSON.stringify(spoke));
    c.close("test");
  }
  {
    const { c, sup, spoke } = makeCall({ turnText: "check the backups" });
    await c.open();
    const s = lastSession();
    await userTurn(s, c, "check the backups");
    await respond(s, null, { calls: [{ name: "look_into", args: { text: "check the backups" } }] });
    await until(() => c.requests.size === 1, 1000);
    sup.replies.set([...c.requests.keys()][0], "The dashboard is back up.");
    await until(() => spoke.some((x) => /back up/.test(x)), 2000);
    check("  one that arrives right after its question is not", !spoke.some((x) => /earlier question/.test(x)), JSON.stringify(spoke));
    c.close("test");
  }

  section("8. restarts");
  {
    const { c, client } = makeCall();
    await c.open();
    live.register("amaraghy", c);
    let seen = null;
    live.setOnChange((n) => (seen = n));
    const n = live.restartAll();
    check("restartAll(): the page is told 'restarting' first, then the call ends 'restarting'", n === 1 && client.json.findIndex((m) => m.type === "restarting") >= 0 && client.json.findIndex((m) => m.type === "restarting") < client.json.findIndex((m) => m.type === "ended" && m.why === "restarting"), JSON.stringify(client.json.slice(-3)));
    check("  the open-call count goes to 0 (the status file the deploy scripts read)", seen === 0 && live.activeCount() === 0);
    live.setOnChange(null);
  }
  {
    const { c, spoke } = makeCall();
    await c.open();
    c.sayReconnected("ar");
    await until(() => spoke.length > 0, 1000);
    check("a call resumed after a restart says it is back (in the call's language)", spoke[0] === "الاتصال رجع، وأنا معاك.", JSON.stringify(spoke));
    c.close("test");
  }

  section("9. page.open over every key of the page map never ends a call or moves the tab");
  {
    const cc = fs.readFileSync(path.join(ROOT, "public", "joya-ai.js"), "utf8");
    const sh = fs.readFileSync(path.join(ROOT, "public", "joya-shell.js"), "utf8");
    const grab = (src, name) => {
      const i = src.indexOf("function " + name + "(");
      let depth = 0;
      for (let j = src.indexOf("{", i); j < src.length; j++) {
        if (src[j] === "{") depth++;
        else if (src[j] === "}" && --depth === 0) return src.slice(i, j + 1);
      }
      return "";
    };
    const ctx = { ORIGIN: "https://joya.example", URL };
    vm.createContext(ctx);
    vm.runInContext(grab(cc, "ccTarget") + "\n" + grab(sh, "isCC") + "\n" + grab(sh, "safePath"), ctx);
    const map = registry.build();
    UiActions.setPages(map);
    const bad = [];
    for (const e of map) {
      const v = UiActions.validate("page.open", { page: e.key });
      const np = v.ok ? UiActions.navPage(v.args.page) : null;
      if (!np) { bad.push(e.key + ": not valid"); continue; }
      const here = vm.runInContext("ccTarget(" + JSON.stringify(np.url) + ")", ctx);
      const framed = vm.runInContext("safePath(" + JSON.stringify(np.url) + ")", ctx);
      if (!here && !framed) bad.push(e.key + " -> " + np.url);
    }
    for (const old of Object.keys(UiActions.LEGACY_PAGES)) {
      const v = UiActions.validate("page.open", { page: old });
      const np = v.ok ? UiActions.navPage(v.args.page) : null;
      if (np && !vm.runInContext("ccTarget(" + JSON.stringify(np.url) + ")", ctx) && !vm.runInContext("safePath(" + JSON.stringify(np.url) + ")", ctx)) bad.push("legacy " + old);
    }
    check("every page-map key (and every old key) is either the Command Center here (cc, cc.<sheet>) or a page the shell's frame takes", map.length > 20 && !bad.length, bad.join(", "));
    const v = UiActions.validate("page.open", { page: "command-center" });
    check("  the old \"command-center\" is \"cc\", the Command Center here (the reorg regression, call lv172yc)", v.ok && v.args.page === "cc" && !!vm.runInContext("ccTarget(" + JSON.stringify(UiActions.navPage("cc").url) + ")", ctx));
    const sheet = map.find((e) => /^cc\./.test(e.key));
    check("  a Command Center sheet (" + (sheet && sheet.key) + ") opens here as that sheet", sheet && vm.runInContext("ccTarget(" + JSON.stringify(sheet.url) + ").sheet", ctx) === sheet.key.slice(3));
    UiActions.setPages(null);
    check("  the page.open case never calls VoiceLive.stop, and pageOpenSoon never moves the tab during a call or with the shell here",
      !/VoiceLive\.stop\(\)/.test(grab(cc, "pageOpenSoon")) && /if \(liveActive\(\) \|\| window\.JoyaShell\) \{/.test(grab(cc, "pageOpenSoon")));
    check("  the shell toast's Open refuses a whole-tab move during a live call", /if \(open\(link\)\) return; if \(liveOn\(\)\) return d\.toast\(/.test(sh));
    check("ui-actions.js is byte-identical in the dashboard and in joya-ai", fs.readFileSync(path.join(ROOT, "public", "ui-actions.js"), "utf8") === fs.readFileSync(path.join(ROOT, "..", "joya-ai", "lib", "ui-actions.js"), "utf8"));
  }

  section("10. the page side: controls, end reasons, reconnects (source)");
  {
    const vl = fs.readFileSync(path.join(ROOT, "public", "voice-live.js"), "utf8");
    const cc = fs.readFileSync(path.join(ROOT, "public", "joya-ai.js"), "utf8");
    const dock = fs.readFileSync(path.join(ROOT, "public", "joya-dock.js"), "utf8");
    check("stop(why) sends {type: 'end', why} (with the page's report since 0.1.3), and a beacon when leaving the page", /JSON\.stringify\(\{ type: "end", why: w, diag: rep \}\)/.test(vl) && /navigator\.sendBeacon\("\/joya-ai\/api\/live\/end"/.test(vl));
    check("a failure before 'ready' (error or ended) rejects start() with the reason: never silent", /if \(\(m\.type === "error" \|\| m\.type === "ended"\) && !ready\) settle\(new Error/.test(vl) && /liveEnded\(\{ type: "error", why: "start", error:/.test(cc));
    check("the microphone's track ending and devicechange are caught (reopened once, else the call ends with that reason)", /t\.onended = function \(\) \{ if \(me === S\) micLost\(me, "track-ended"\); \}/.test(vl) && /addEventListener\("devicechange", me\.onDev\)/.test(vl) && /if \(me === S\) stop\(why\);/.test(vl));
    check("only the red X ends a call, and not within 1.5 s of its start", /var LIVE_END_GUARD_MS = 1500;/.test(cc) && /if \(why === "button" && LiveUI\.active && Date\.now\(\) - \(LiveUI\.startedAt \|\| 0\) < LIVE_END_GUARD_MS\) return false;/.test(cc) && /e\.target\.closest\("#cc-live-end"\)\) \{ e\.stopPropagation\(\); return liveStop\("button"\); \}/.test(cc));
    check("the mic mutes during a call (the Command Center's and the dock's), it never ends it", /LiveUI\.active \? liveMuteToggle\(\) : liveStart\(\)/.test(cc) && /if \(LiveUI\.active\) liveMuteToggle\(\); else liveStart\(\);/.test(cc) && /L\.active\(\) && window\.VoiceLive && window\.VoiceLive\.mute\) return window\.VoiceLive\.mute/.test(dock));
    check("muted is shown on the dock (MUTED on the tag, the mic amber with a slash)", /\(ext\.muted \? "MUTED " : "LIVE "\)/.test(dock) && /dock\.classList\.toggle\("muted", !!ext\.muted\)/.test(dock));
    check("a call that ends on its own says why, with Reconnect (Command Center and dock)", /function liveEndedToast\(text, bad\)/.test(cc) && /label: "Reconnect"/.test(cc) && /b\.textContent = "Reconnect";/.test(cc));
    check("'restarting' brings the call back by itself with backoff and ?resume=restart", /var LIVE_RETRY_MS = \[1000, 2000, 4000, 8000, 15000\];/.test(cc) && /liveStart\(\{ resume: "restart" \}\)/.test(cc) && /&resume=restart&lang=/.test(vl));
  }

  section("11. the route (real server.js, scratch copy): end reasons, page closes, resume, restarting, the status file, JOYA AI told of the start");
  {
    // A stand-in for JOYA AI's supervisor socket: it only records what the dashboard sends.
    const supDir = fs.mkdtempSync(path.join(os.tmpdir(), "rel-sup-"));
    const SOCK = path.join(supDir, "joya-ai.sock");
    const got = [];
    const supSrv = net.createServer((c) => {
      let buf = "";
      c.setEncoding("utf8");
      c.on("data", (d) => {
        buf += d;
        let nl;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const m = JSON.parse(buf.slice(0, nl));
          buf = buf.slice(nl + 1);
          got.push(m);
          c.write(JSON.stringify({ id: m.id, ok: true, data: m.op === "snapshot" ? { services: { list: [] } } : { noted: true } }) + "\n");
        }
      });
    });
    await new Promise((r) => supSrv.listen(SOCK, r));
    const sc = await scratch.startScratch({ env: { JOYA_OPENAI_WS: WS_BASE, JOYA_AI_SOCKET: SOCK } });
    fs.writeFileSync(path.join(sc.app, "DEPLOYED"), "commit=abcdef1234567\ndeployed_at=2026-09-30T13:59:40Z\n");
    const db = require(path.join(ROOT, "lib", "db.js"));
    const origin = "http://127.0.0.1:" + sc.port;
    const statusFile = path.join(sc.data, "live-calls.json");
    const readStatus = () => {
      try {
        return JSON.parse(fs.readFileSync(statusFile, "utf8"));
      } catch (_) {
        return null;
      }
    };
    const openLive = (cookie, q) =>
      new Promise((resolve) => {
        const ws = new WebSocket("ws://127.0.0.1:" + sc.port + "/joya-ai/api/live" + q, { headers: { Cookie: cookie, Origin: origin } });
        const out = { ws, got: [], closed: null };
        ws.on("message", (d, bin) => !bin && out.got.push(JSON.parse(String(d))));
        ws.on("close", (code) => (out.closed = code));
        ws.on("open", () => resolve(out));
        ws.on("unexpected-response", (r, res) => resolve({ ...out, status: res.statusCode }));
        ws.on("error", () => resolve(out));
      });
    try {
      await until(() => got.some((m) => m.op === "deploy-event"), 6000);
      const de = got.find((m) => m.op === "deploy-event");
      check("at start the dashboard tells JOYA AI's supervisor it (re)started, with the deployed commit", de && de.component === "dashboard" && de.commit === "abcdef1234567" && de.deployed_at === "2026-09-30T13:59:40Z" && /^\d{4}-\d\d-\d\dT/.test(de.started_at), JSON.stringify(de));
      check("the open-call status file exists from the start, with count 0", (readStatus() || {}).count === 0, JSON.stringify(readStatus()));
      await sc.makeUser("reladmin", "administrator");
      const A = await sc.signIn("reladmin");
      const set = await sc.req("GET", "/joya-ai/settings/voice", { cookie: A.cookie });
      await sc.req("POST", "/joya-ai/settings/voice/enabled", { cookie: A.cookie, body: new URLSearchParams({ _csrf: sc.csrfOf(set.body), enabled: "1" }).toString() });
      const page = await sc.req("GET", "/joya-ai", { cookie: A.cookie });
      const tok = sc.csrfOf(page.body);
      check("voice on in the scratch database", db.getSetting("voice_desk") === "on");

      let L = await openLive(A.cookie, "?csrf=" + tok);
      await until(() => L.got.some((m) => m.type === "ready"), 4000);
      const id = (L.got.find((m) => m.type === "ready") || {}).call;
      check("a call is ready", !!id, JSON.stringify(L.got.slice(0, 3)));
      await until(() => (readStatus() || {}).count === 1, 2000);
      check("  the status file counts it (the deploy scripts warn about it)", (readStatus() || {}).count === 1 && readStatus().calls[0].call === id && readStatus().calls[0].actor === "reladmin", JSON.stringify(readStatus()));
      L.ws.send(JSON.stringify({ type: "end", why: "button" }));
      await until(() => L.closed != null, 2000);
      await until(() => /ended \(hung-up: button\)/.test(sc.out()), 2000);
      check("  the page's end reason is in the log: ended (hung-up: button)", new RegExp("call " + id + " ended \\(hung-up: button\\)").test(sc.out()), sc.out().split("\n").filter((l) => /live:/.test(l)).slice(-4).join(" | "));
      await until(() => (readStatus() || {}).count === 0, 2000);
      check("  and the status file is back to 0", (readStatus() || {}).count === 0);
      check("  the audit line says why", db.recentLogins(20).some((x) => /live conversation ended \(hung-up: button\)/.test(x.detail || "")));

      L = await openLive(A.cookie, "?csrf=" + tok);
      await until(() => L.got.some((m) => m.type === "ready"), 4000);
      const id2 = (L.got.find((m) => m.type === "ready") || {}).call;
      L.ws.terminate();
      await until(() => new RegExp("call " + id2 + " ended").test(sc.out()), 3000);
      check("a page socket that just goes away is 'page-closed' with its close code, never 'hung-up'", new RegExp("call " + id2 + " ended \\(page-closed: code 1006\\)").test(sc.out()), sc.out().split("\n").filter((l) => /live:/.test(l)).slice(-3).join(" | "));

      L = await openLive(A.cookie, "?csrf=" + tok);
      await until(() => L.got.some((m) => m.type === "ready"), 4000);
      const id3 = (L.got.find((m) => m.type === "ready") || {}).call;
      const beacon = await sc.req("POST", "/joya-ai/api/live/end", { cookie: A.cookie, body: { _csrf: tok, call: id3, why: "unload" } });
      await until(() => L.closed != null, 2000);
      check("the unload beacon (POST /joya-ai/api/live/end) ends the call with its reason", beacon.status === 204 && new RegExp("call " + id3 + " ended \\(hung-up: unload\\)").test(sc.out()), beacon.status + " " + sc.out().split("\n").filter((l) => /live:/.test(l)).slice(-3).join(" | "));
      const noTok = await sc.req("POST", "/joya-ai/api/live/end", { cookie: A.cookie, body: { call: id3, why: "unload" } });
      check("  it needs the CSRF token", noTok.status === 403);

      L = await openLive(A.cookie, "?csrf=" + tok + "&resume=restart&lang=en");
      await until(() => L.got.some((m) => m.type === "ready"), 4000);
      check("?resume=restart: the call is ready, marked resumed (the voice says it is back)", L.got.some((m) => m.type === "ready" && m.resumed === true) && /resumed after a restart/.test(sc.out()));
      await until(() => (readStatus() || {}).count === 1, 2000);
      sc.stop(); // SIGTERM to the scratch server
      await until(() => L.closed != null, 3000);
      const ri = L.got.findIndex((m) => m.type === "restarting");
      const ei = L.got.findIndex((m) => m.type === "ended" && m.why === "restarting");
      check("SIGTERM: the page is told 'restarting' before its call ends (it reconnects by itself)", ri >= 0 && ei > ri && L.closed === 1000, JSON.stringify(L.got.slice(-3)) + " closed " + L.closed);
    } finally {
      try {
        sc.stop();
      } catch (_) {
        /* stopped */
      }
      supSrv.close();
    }
  }

  main.close();
  noPong.close();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
